# 「活着但不再推进」的可见性（stall visibility，v1，冻结）

> 语义由 #315 冻结。实现期发现矛盾 → 停下报告，不得重新解释本契约。
> **本文件是 #315 唯一的 D 编号命名空间**：实现代码与测试注释里的 `#315 Dn` 只解析到这里
> 的 D1–D7。`#315` 之外的 `Dn` 与本契约无关。

## 背景：为什么这件事在系统里完全隐形

`docs/contracts/display-liveness-v1.md` 的八条规则把「谁活着」判准了，但它们的**最强规则**
恰好把这个问题盖住了：

| 层 | 事实 | 后果 |
|---|---|---|
| `src/extension/liveness.ts` 规则 1 | `inMemory` 持有一个**非终态** handle → `live` | 只要本进程还攥着 handle，child 恒判 `live` |
| `src/extension/legion-tools.ts` `refreshHeartbeats` | 心跳只给 `supervisor.isAlive()` 为真的子节点刷 | 卡住的 child 心跳照刷，`updatedAt` 一直是新的 |
| 同文件 `scanOrphans` | 首个 root child 仍 `isAlive` 时整棵子树豁免 | 卡住的 child 永远不会被判成 orphan |
| `collect` deadline | 默认 900s | 父要等满这个上限才知道「没动静」 |

于是「进程活着但一个工具卡在那里十分钟」与「正在高效工作」在**所有展示面上完全一样**。
这不是 liveness 判错了——判「活/死」它是对的；缺的是第三个事实：**它在干什么、干了多久**。

## 冻结决定

### D1 — 只加事实，不改判定

两个后端（`InProcessSupervisor` / `RpcSupervisor`）各自在自己的 `ChildRecord` 上记录
**一个**字段：

```ts
interface ChildActivity {
  readonly tool: string;        // 子会话事件流原样报来的工具名
  readonly startedAt: number;   // 事件到达时的 **host** clock
  readonly toolCallId?: string; // 仅用于把 end 事件匹配回它的 start
}
```

数据来源是**子会话已经存在的事件流**（`tool_execution_start` / `tool_execution_end`，
两个后端的订阅点早已存在）。**不新增 IPC、不新增轮询、不新增 state machine**。

- `liveness()` 的 live/dead 判定**一个字都不改**。`live` 的 child 仍然 `live`。
- **不自动 kill / abort / retire**。本契约只产出字符串。
- 心跳与孤儿扫描的判据**一个字都不改**（约束见 D7）。

### D2 — `startedAt` 是 host clock，只做「年龄」

`startedAt` 由 host 在事件到达时读一次 `Date.now()`；耗时永远是 `now - startedAt`，中间只用
**同一个时钟族**测量一段年龄。绝不把子会话 transcript 里的时间戳拿来和 host 时间戳比大小
（这正是 display-liveness D3 禁止的「跨 writer 时间戳仲裁」）。

`inFlightTool(name)` 在 child **不是 live** 时一律返回 `undefined`：没有活 handle 的进程不可能
正卡在一个工具里，记录里残留的字段不能当事实用（display-liveness §6 的同类推论）。

`tool_execution_end` 只清掉它**点名**的那一次调用（两边都有 `toolCallId` 且不相等 → 保留），
因为并行工具批里先结束的兄弟不能把还在跑的那个擦掉。`agent_settled` 也会清空：一轮结束
就不会再有工具在飞（abort 打断工具时 `end` 事件可能永远不来）。

### D3 — `STALL_NOTICE_MS = 300_000`

单条工具持续到或超过 5 分钟，追加**展示用**标记。常量在 `src/supervisor/types.ts`，
两个后端与工具面共用同一个值，不各写一份字面量。

选 5 分钟的理由是对照**可观测的替代方案**：现在父等到 900s 的 `collect` deadline 才知道
没动静。5 分钟落在这个 deadline 之前很久，且它只花一个字符串。

### D4 — `status` 的行格式

child 有在飞工具时，状态块**顶部**多一行（lead line，与 `alive · quiet Ns` 同级）：

```
working · bash 00:07:31
worker-0 — state=working agent=worker kind=pi
alive · quiet 12s
supervisor=inprocess
session=/…/worker-0.jsonl
```

- 前缀 **`working`** 来自在飞工具这个事实本身，不是持久化的 `state`：start 事件没有配对的
  end，就是「这个 child 正在一个工具里」，而记录里的 `state` 只在 turn 边界被重写，可能滞后。
- 耗时为 `hh:mm:ss`，小时字段**不封顶**（30 小时读 `30:00:00`，绝不回绕成 `06:00:00`——
  回绕会把卡死的 child 报成刚开工）。
- 到/过 `STALL_NOTICE_MS` 追加：

```
working · bash 00:12:00 (long-running tool — no progress for 12m; `steer` cannot interrupt it, `abort` can)
```

  `N` 是越过边界的整分钟数。文案点名 `abort` 而不是 `steer`：`steer` 只是排队（#313），
  一个卡在工具里的 child **永远收不到**；`abort`（#314）才是能打断当前 turn 的杠杆，而且它
  同样不杀进程。
- 同一个渲染器服务 `subagent({ action: "status" })` 的单 child 分支、
  `subagent({ action: "status", all: true })` 的每个块、以及 `/legion status <name>`：
  三处走 `withInFlightToolLine`，不会漂移。
- **没有在飞工具就不出这一行**：无事实即无声明，`#315` 之前的输出逐字节不变。

### D5 — 为什么不做 fleet watchdog

`docs/contracts/esc-abort-v1.md` 的非目标写明「不做主机级 watchdog」。`#315` 不推翻它，理由是
这一条现在**更**成立而不是更松：

1. **watchdog 要判「该杀」，而这里没有可信的「该杀」判据。** 5 分钟一个工具可以是 `npm test`
   跑在慢机器上，也可以是 `rg` 扫在 NFS 上，也可以是模型在长思考。判据缺位时，watchdog
   唯一能做的「动作」就是把误杀变成默认行为。
2. **杀掉最贵的东西换最小的收益。** `retire` 会带走进程与上下文（`stop` 的语义），而卡住的
   child 恰恰是「上下文最贵」的那一类。
3. **父本来就有一个明确的杠杆。** 看到这一行之后，父可以选择 `abort`（软中断，保留上下文）
   或 `stop`（硬停）。把决定权留在父手里，比在 host 里加一个猜的启发式更诚实。
4. **主机级 watchdog 需要有权限的 supervisor，而展示层没有。** `status` 是一个纯读的投影；
   给它杀人的手，等于把 display-liveness 「渲染是投影，不是事件回放」的边界拆掉。

一句话：**`#315` 把「看不见」修成「看得见」，不把「看得见」升级成「自动处置」。**

### D6 — 唯一的行为改动：`scout` 的默认单次 bash 超时

`agents/scout.md` 新增 `toolTimeoutMs: 600000`。这是本契约里**唯一**改变运行行为的一项，理由
是 scout 的失败模式和别的角色不同：

- `toolTimeoutMs` 原本**没有默认值**，SDK 的 bash 工具也没有默认超时：一条卡住的探针命令
  （`wait-output`、socket、网络挂载上的全仓 `rg`）能把一个只读侦察 child 钉满它 600s 的
  turn 预算，并且**什么都不产出**。只读角色没有正当的长命令。
- **只给 `scout`**。`worker` / `centurion` 要跑完整构建、测试套件与集成门禁，
  它们的长命令是**正当**的：误杀一次 `npm run test:integration` 的代价高于它防住的那次挂起。
  给它们加默认超时等于把「慢」判成「坏」。
- 既有行为不变，并由测试钉住：以 `timeout` 开头的命令不被二次包裹（嵌套 `timeout` 会把外层
  上限压成内层的，并让失败原因报错在错误的那一层）；`toolTimeoutMs` 缺失时命令原样不动。

### D7 — 边界（实现期不得越界）

| 允许 | 禁止 |
|---|---|
| `src/supervisor/types.ts` 加 `ChildActivity` / `STALL_NOTICE_MS` / `nextInFlightTool` / `formatInFlightToolLine` / `LegionSupervisor.inFlightTool?` | 改 `src/extension/liveness.ts` 的任何判定 |
| 两个后端在各自 `ChildRecord` 上记录/清空该字段 | 改 `src/extension/legion-tools.ts` 的心跳与孤儿扫描判据 |
| `index.ts` / `src/extension/legion-status.ts` 的展示拼接 | 改 `runtime.ts` 的 claim / notice 语义 |
| `agents/scout.md` 的 `toolTimeoutMs` | 给 `worker` / `centurion` 加默认超时 |
| 展示层字符串 | 任何自动 `abort` / `stop` / `retire` / kill |

`inFlightTool` 在 `LegionSupervisor` 上是**可选**成员：它是在接口冻结之后新增的**只读展示**，
一个答不上来的 supervisor（测试替身、早于 #315 的后端）必须仍然满足契约。答不上来 = 没有
事实 = 不出那一行。

## 验收

- `test/unit/stall-visibility.test.ts`：`hh:mm:ss` 格式（含不封顶的小时）、5 分钟边界与标记文案、
  事件折叠（start / 无关事件 / 匹配的 end / 并行兄弟 / 无名 start）、scout 与 worker 的
  `toolTimeoutMs` 取舍。
- `test/unit/supervisor.test.ts`、`test/unit/inprocess-supervisor.test.ts`：两个后端各自从
  **已有事件流**记录该事实，`agent_settled` 与 dead child 都不留残留；routing 后端按 owner 转发。
- `test/unit/status-action.test.ts`、`test/unit/legion-status.test.ts`：三个展示出口的 lead line、
  5 分钟标记、以及「没有事实就一行都不多」。
- `test/unit/child-guard.test.ts`：scout 的 600s 预算真的把 bash 包成
  `timeout --kill-after=2s 600s bash -lc …`；无预算时命令不动。
