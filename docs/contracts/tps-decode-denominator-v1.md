# tok/s 分母修正：decodeMs（v1，冻结）

状态：**frozen**。实施者不得自行改动 D 编号决策；遇到矛盾回父会话裁决，不许自行解释。

## 0. 问题（实测证据）

当前 `tok/s` 的分母是 `generationMs`，其来源是 `message.durationMs` =
**请求发出 → 响应结束**的整段墙钟（`pi-ai/dist/types.d.ts:405-412`），包含 prompt 预填充/TTFT。
对 215 个真实 session / 22306 条 assistant 调用做回归：

```
durationMs ≈ 4.3s + output / 137      # 固定开销 ≈ 4.3s/次调用，真实解码 ≈ 137 tok/s
```

| output tok | 调用占比 | 显示 tps | 真实 | 低估 |
|---|---|---|---|---|
| 31–80 | 8% | 11.2 | ~137 | 12x |
| 81–200 | 27% | 22.0 | ~137 | 6.2x |
| 201–400 | 21% | 39.4 | ~137 | 3.5x |
| 401–800 | 19% | 59.2 | ~137 | 2.3x |
| 1601+ | 11% | 124.6 | ~137 | 1.1x |

agentic 场景 75% 的调用落在 output 31–800 → 长期显示 10–60 tok/s。

次要问题：`rate.ts:325` 在窗口内 `Δgen < 1000ms` 时把分母换成 60000ms（回退墙钟），
把速率打到 1/60。真实数据里该分支触发 0 帧，但它是同一函数内的静默悬崖，一并修掉。

## 1. 冻结决策

### D1 — decodeMs 是**实测**的首 delta → 末 delta 墙钟

不引入模型常数、不做预填充回归拟合。测量点：

- **in-process**：`InProcessSupervisor.handleSessionEvent`（`src/supervisor/inprocess-supervisor.ts:1610`）
  已在 `:1616` 取 `const at = Date.now()`，`child.session.subscribe` 在 `:905` 同步回调，
  父进程与子会话同进程，**不需要 IPC**。
- **rpc**：`RpcSupervisor.handleRpcEvent`（`src/supervisor/rpc-supervisor.ts:834`），同样已有 `const at = Date.now()`。
  子进程逐 delta 写一行 stdout（`rpc-mode.js:265-267`，无合并），父进程按到达时刻打戳。
  精度上限 = 父侧到达时刻（含管道/背压抖动），仍远优于 `durationMs`。

两个后端的折叠入口必须**对称**，共用同一个纯函数模块（D2）。

### D2 — 新建 `src/supervisor/decode-clock.ts`，纯函数、总函数

```ts
export interface DecodeClock { openSince?: number; openLast?: number; measuredMs: number }
export const MIN_MEASURED_DECODE_MS = 50;
export function foldDecode(clock: DecodeClock, record: Record<string, unknown>, at: number): DecodeClock;
export function seedDecode(seedMs: number): DecodeClock;
```

规则：

1. `record.type === "message_update"` 且 `record.assistantMessageEvent.type` 以 `_delta` 结尾
   （`text_delta` / `thinking_delta` / `toolcall_delta` 等）→ 视为流活动：
   `openSince ??= at`；`openLast = at`。
   `_start` / `_end` / `done` / `error` 等边界事件**不**计为活动。
   注意：钩子必须挂在 `publishEvent`/`publishEventAtRoot` 的**过滤之前**
   （`inprocess-supervisor.ts:1706` / `rpc-supervisor.ts:933` 的 `if (!isTextDelta && !toolName) return`
   会丢弃 thinking_delta 和多数 delta），否则 thinking-only 轮次测不到。
2. `record.type === "message_end"` → 结账一条 assistant 消息：
   ```
   span = openLast - openSince            // 两端都存在时
   add  = span >= MIN_MEASURED_DECODE_MS ? span : durationMs(message) ?? 0
   measuredMs += add
   openSince = openLast = undefined
   ```
   `durationMs` 从 `record.message.durationMs` 读（in-process 是活对象；rpc 由
   `toJsonEvent` 原样透传非 `message_update` 事件，`json-event.js:16-21`）。
   **这条 fallback 是必须的**：不流式的 provider / 单 chunk 响应 / 测试替身测不到 span，
   此时退回今天的行为，而不是让分母塌成 0。
3. 未闭合的 message（进程被杀、`message_end` 丢）在下一个 `_delta` 到达时
   **先按规则 2 结账再开新的一条**（用 `openLast - openSince`，`durationMs` 不可得则计 span）。
   这保证 `measuredMs` 是单调不减的累计值。
4. 折叠是总函数：任何未知/缺失字段都返回原状态，不抛。

### D3 — 跨 resume 的连续性：以 session 的 `generationMs` 做种子

`measuredMs` 必须是**与 session 同轴、单调、连续**的累计值，否则采样器会在
"历史用 generationMs / 新消息用 measuredMs"之间跳轴，产生虚假尖峰。

- 首次观测到某 child（in-process: `spawnChild` 里 registration 建立时；rpc: 进程 spawn 后首次事件）
  用 `progressFromSessionFile(child.sessionFile).generationMs ?? 0` 作为 `seedDecode` 的入参。
- 新 spawn 的 child 此时文件为空 → 种子 0，天然连续。
- resume/continue 复用旧 sessionFile（`orchestrator.ts:1096`）→ 种子 = 历史 `generationMs`，
  历史部分沿用旧口径、新消息用实测值，曲线连续、不比新旧混轴更差。
- 种子之后**只增不减**。

### D4 — 暴露方式：`decodeMs?(name)` 同步读，不加 DB 列、不改 wire

`LegionSupervisor`（`src/supervisor/types.ts`）新增**可选**同步方法，与既有
`inFlightTool?(name)` / `lastEventAt?(name)` 同族：

```ts
decodeMs?(name: string): number | undefined;
```

- 两个后端都实现，读 `ChildRecord.decode`（in-process）与 rpc 的同等字段。
- `RoutingSupervisor` 按 `lastEventAt` 的同一模式委派（`routing-supervisor.ts:287-293`）。
- 未观测到该 child → `undefined`（不是 0）。

**禁止**：往 `legion.db` 的 `usage` 表加列。理由：契约 §15-4 冻结 schema，`ALTER` 需 REV，
且 `legion-schema-sentinel.test.ts:12-46`、`legion-db.test.ts:18-21`、`legion-usage.test.ts:110-115`
三处硬编码列清单。decodeMs 是**会话派生的实时字段**，不进账本。

**禁止**：向子会话 JSONL 追加 custom entry。理由：in-process child 的 `pi.appendEntry`
受 `PI_LEGION_CHILD_MCP` 门控（`inprocess-supervisor.ts:735-745`），关 MCP 时抛
`notInitialized`；裸 fs append 会断 `parentId` 链（`session-manager.js:737-760`）。

### D5 — 展示层：单一分母选择，缺失即回退

`StatusEntry`（`src/tui/status.ts:63` 附近）与 `VizNode`（`src/tui/viz/model.ts:39` 附近）新增：

- `StatusEntry.decodeMs?: number` — 可选（缺失 = 没测到，回退 generationMs）
- `VizNode.decodeMs: number` — **必填**（`Math.max(0, entry.decodeMs ?? 0)`），
  让 `tsc` 抓出所有漏改的 fixture 与接线点。

`runtime.ts` 两处构造器（`statusEntryFromJob`、`statusEntryFromNode`）注入：

```ts
...(liveDecode !== undefined ? { decodeMs: liveDecode } : {})
```

其中 `liveDecode = deps.getLiveDecode?.(name)`，新 dep 由 `index.ts` 注入
`(name) => supervisor.decodeMs?.(name)`（`SessionRuntimeDeps`，`runtime.ts:172`）。

### D6 — 速率公式：换分母 + 去掉墙钟悬崖

`src/tui/viz/rate.ts`：

1. `Series` 增加 `decode: number[]`（与 `ts`/`value`/`gen` 平行），`record()` 同步采样并
   参与 `Math.max` 单调化与 flat-run 折叠、`changedAt` 判定（D8）。
2. `rateOf`：
   ```ts
   const dOut = max(0, Δvalue);
   if (dOut <= 0) return 0;
   const dDecode = max(0, Δdecode);
   const dGen    = max(0, Δgen);
   const denomMs = dDecode > 0 ? dDecode : dGen;      // 同一序列内不混轴：decode 一经出现即优先
   const seconds = Math.max(denomMs, MIN_RATE_DECODE_MS) / 1000;
   return dOut / seconds;
   ```
3. `MIN_RATE_GENERATION_MS = 1000` → 重命名为 `MIN_RATE_DECODE_MS = 200`，
   语义从"低于 1s 就改用 60s 墙钟"改为"**下限钳制**"（`Math.max`），
   **删除** `windowMs / 1000` 的回退分支。理由：墙钟回退对短窗口是 60x 级低估，
   钳制只限制尖峰、不惩罚合法的短 decode。200ms 的理由是低于一个采样间隔（500ms）。
4. `genAt()` 保留；新增 `decodeAt()` 供测试使用。

### D7 — 树行 `avg t/s` 用同一分母

`src/tui/status.ts:338-341`：
```ts
const denomMs = entry.decodeMs && entry.decodeMs > 0 ? entry.decodeMs : entry.generationMs;
if (entry.tokensOut && entry.tokensOut > 0 && denomMs && denomMs >= 1_000) { ... }
```
`>= 1_000` 门禁保留（lifetime 值天然是秒级，且它与 header 的 `MIN_RATE_DECODE_MS` 是两个不同东西：
前者是"值太小不显示"，后者是"分母钳制"）。

### D8 — `changedAt` 必须把 decodeMs 纳入变更判定

`rate.ts:136-137` 的 `changed` 目前只看 `value`/`gen`。加入 `decode` 后，
每次 `record()` 的变更判定与 flat-run 折叠条件都要同步带上 `decode`，
否则 #346 的图表 x 轴冻结逻辑会静默失效（`legion-viz.test.ts:2467-2485` 会红）。

### D9 — 不改的东西（刻意不做清单）

- 不碰 `generationMs` 的类型/语义/`/legion timing` 面板（`timing-breakdown.ts`）。
- 不改 `totalRate` 的"逐节点求和"语义（并行时是各 agent 解码速率之和，可能超过单模型物理上限）。
  这是独立议题，本版不动。
- 不修"生成期间显示 0 / 滞后一条消息"：usage 只在 `message_end` 落盘，
  且 Anthropic 在 `message_delta` 才写 output（`anthropic-messages.js:640-670`），
  partial 拿不到可靠 token 增量。本版只修**量级**，`rate.ts` 头部注释要写明这一点仍成立。
- 不加 DB 列，不改 RPC wire，不改 session 文件格式。
- 不引入 mock-llm 的分片延迟原语（`sse.ts:14-25` 同步写完，无 delay 支持）；
  decodeMs 用 supervisor 单测直接喂合成事件覆盖，不用 e2e。

## 1b. 修订 REV-1（review 门禁回填，实施者必须落实）

### D4-b — `decodeMs(name)` 不得以「child 存活」为条件

**D4 原文“未观测到该 child → `undefined`”被误读成 `isAlive` 门禁。** 后果：retire 时
`children.delete()` 连累加值一起丢 → `undefined` → `runtime.ts` 省略键 → `status.ts:354`
退回 `generationMs`。实测同一行 retire 前 `136 avg t/s`、retire 后 `69 avg t/s`；
而且图表尾部（`rate.ts:160` 的单调钳制保留 decode 序列）与行标签会互相矛盾。

冻结规则：

- `decodeMs(name)` 回答的是**这个 child 的一生**，不是「它现在活着吗」。
- child 离开 live 集合（retire / 进程退出 / `children.delete()`）后，最后一次 `measuredMs`
  **必须保留**，按 name 存在一个有界归档里供后续读取。
- 只有**从未观测到**的名字才返回 `undefined`。
- 仍是内存态（D4 的禁令不变：不加 DB 列、不写子会话 JSONL、不改 wire）。
- `types.ts` 的方法注释要按此校正。

### D6-b — 两个分母都为 0 时返回 0，不许钳制出速率

`dOut > 0 且 dDecode == 0 且 dGen == 0` 意味着**这一窗没有任何时长测量**
（典型：`tokensOut` 来自账本、转录不可读的 ledger-only 行）。此时除以 `MIN_RATE_DECODE_MS`
会得到荒唐值（实测 5000 tok → 25000 tok/s；被删掉的墙钟回退给的是 83）。

冻结规则（`rateOf` 内，`dOut <= 0` 早退之后）：

```ts
if (dDecode <= 0 && dGen <= 0) return 0;      // no timing at all → no rate
const denomMs = dDecode > 0 ? dDecode : dGen;
const seconds = Math.max(denomMs, MIN_RATE_DECODE_MS) / 1000;
```

注意与既有用例的区别：`dOut=2100 / dGen=1ms` 属于**测到了但在 1ms 里**（dGen>0）→ 仍走钳制
（2100/0.2 = 10500）。只有两者都恰为 0 才返回 0。

### D7-b — 树行门禁按轴各用各的信任下限

D7 的 `>= 1_000` 直接套在 decodeMs 上会误杀：decodeMs 天然比 generationMs 少掉每次调用
≈4.3s 的 prefill，单条 60 tok 消息 decode≈438ms → 旧口径 4730ms 显示 “13 avg t/s”，
新口径反而整条不显示。

冻结规则（`status.ts` detailBits）：

```ts
const usesDecode = entry.decodeMs !== undefined && entry.decodeMs > 0;
const denomMs = usesDecode ? entry.decodeMs! : entry.generationMs;
const floor   = usesDecode ? 200 : 1_000;        // 各自的信任下限（decode 对齐 MIN_RATE_DECODE_MS）
if (entry.tokensOut > 0 && denomMs && denomMs >= floor) …
```

### REV-1 要求的补测（review 变异实验证明以下三处**零覆盖**，改坏了也全绿）

1. **D8**：仅 `decodeMs` 变化时 `lastChangeAt` / flat-run 折叠必须前进（改坏 `changed`
   里的 decode 条件当前全量 2087 条仍全绿）。
2. **D3**：resume 复用旧 sessionFile 时 `decodeMs` 起于历史 `generationMs`（两个后端各一条；
   把种子改成 `seedDecode(0)` 当前全绿）。
3. **D4 委派**：routing facade 对 **rpc-owned** child 委派 `decodeMs`
   （把 `if (owner === "rpc") …` 改成 `return undefined` 当前全绿，而生产入口正是 RoutingSupervisor）。
4. **D4-b / D6-b / D7-b** 各自一条用例。
5. `decode-clock`：整条消息只有 `thinking_delta`、以及只有 `toolcall_delta` 的用例（当前只测了混合形态）。

## 2. 验收标准

必过门禁（本 worktree 已 `npm ci`，基线四步全绿）：
```
npm run typecheck && npm test && npm run test:integration && npm run test:mock-llm
```

新增测试：

- `test/unit/decode-clock.test.ts`（新）：
  - 首 delta→末 delta 的 span 被累加；`_start`/`_end` 不计入；
  - span < 50ms → 退回该消息的 `durationMs`；
  - 无 `message_end` 的悬挂消息在下一个 delta 到来时先结账；
  - 未知事件不改变状态（总函数）；`measuredMs` 单调不减。
- `test/unit/supervisor.test.ts`（扩）：**两个后端**都从 `message_update` 累积 decodeMs，
  `decodeMs(name)` 在无观测时返回 `undefined`；thinking-only delta 也计入。
- `test/unit/legion-integration.test.ts:1674` 那条（唯一端到端接线守卫）扩到
  `decodeMs` 全链路：session/supervisor → StatusEntry → VizNode → `sampler.nowRate > 0`。
- `test/unit/legion-viz.test.ts`：修正 `:267`（idle 稀释）与 `:364`（floor 边界）两条**必然变红**的用例；
  并**新增**一条显式"decode 分母 ≠ 墙钟"的断言（现有 steady fixture 会在分母改错时**假绿**，
  因为稳态下 wall rate == decode rate；不要把"测试变绿"当成分母换对的证据）。
  另加一条：`dOut > 0 且 dDecode == 0` 时走钳制而不是返回 0/爆炸。
- `test/unit/status.test.ts:312-337, 423-437`：`avg t/s` 走 decodeMs，缺 decodeMs 时回退 generationMs
  （`:330-337` 那条"无 generationMs 则不渲染"要改成"两者都没有才不渲染"）。

## 3. 文件所有权（单个 writer，禁止越界）

```
新增  src/supervisor/decode-clock.ts
改    src/supervisor/types.ts                 (LegionSupervisor.decodeMs?)
改    src/supervisor/inprocess-supervisor.ts  (foldDecode 接线 + decodeMs 访问器 + 种子)
改    src/supervisor/rpc-supervisor.ts        (同上)
改    src/supervisor/routing-supervisor.ts    (委派)
改    src/extension/runtime.ts                (deps.getLiveDecode + 两处 statusEntry)
改    src/tui/status.ts                       (StatusEntry.decodeMs + detailBits)
改    src/tui/viz/model.ts                    (VizNode.decodeMs + nodesFromEntries)
改    src/tui/viz/rate.ts                     (decode series + rateOf + 常量改名)
改    index.ts                                (注入 getLiveDecode)
新增  test/unit/decode-clock.test.ts
改    test/unit/{supervisor,legion-viz,status,legion-integration}.test.ts
可能  test/unit/{legion-viz-scratch,legion-stop}.test.ts  (VizNode 必填字段的 fixture，由 tsc 报出)
不改  docs/legion-v2-contract.md、legion.db schema、任何 *.jsonl 格式
```
