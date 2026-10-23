# 冻结契约：launch admission queue（超限排队而非拒绝，issue #266）

状态：**FROZEN** — 实施中禁止偏离。发现矛盾立刻停下报告，不要自圆其说。
范围：planning only。本文件冻结接口、闸门分类、状态机、文件归属与验收；不含实现。

## 0. 目标与不做的事

**目标**：把「超过并发/扇出上限 → 抛 `BUDGET_EXCEEDED` 让调用方自己重试」改成
「超过**可排队**上限 → 入队等待，槽位释放后自动准入」，对 inprocess 与 rpc/legion
**同一套调度器**；用户不再看到 `inprocess maxChildrenPerNode reached for '<root>' (8/8)`
把一次 12 步 fanout 打成 8 成功 + 4 报错。

**non-goals（v1 明确不做）**：跨 parent 公平性 / 优先级 / 队列持久化 / 排队期间改
agent-model / `queued` 进账本状态闭集 / 队列指标进 `/legion doctor` 深度报表。
详见 §10。

## 1. 已确认事实（父会话已核对，**禁止重新侦察**）

| # | 事实 | 证据 |
|---|---|---|
| F1 | 默认后端 inprocess | `src/supervisor/spawn-mode.ts:17` |
| F2 | 用户可见的 `maxChildrenPerNode reached` 唯一生成点 | `src/supervisor/inprocess-supervisor.ts:1163-1168`（throw `:1168`，`onSpawnRefused` `:1167`） |
| F3 | in-process 子节点在**账本门**被故意放宽到无限 | `src/runs/orchestrator.ts:385-396` |
| F4 | 账本门文案另一套，抛错点 | `src/legion/budget.ts:89-92`（`max_children_per_node`）、`src/runs/orchestrator.ts:420-423` |
| F5 | 两套计数不同源：inprocess 数内存 `this.children`（`assertWithinLimits` `:1132-1170`，active 过滤 `:1135-1137` **只排除 exited/retired**）；legion 数 SQLite（`LIVE_CHILD_STATUSES` = starting/running/blocked，`src/legion/nodes.ts:24-29`） |
| F6 | **一个错误码覆盖全部闸门**：`BUDGET_EXCEEDED` | `inprocess-supervisor.ts:1138-1170`（4 闸门）、`orchestrator.ts:355/423/868+`、`budget.ts:24-28` |
| F7 | 两条派发入口都是裸 `Promise.all` 全量并发；单步失败降级成一行文本 | `index.ts:1864`、`index.ts:2394`、`index.ts:2090-2096` |
| F8 | `agent_settled → state="idle"`；retire → `"retired"`；spawn 失败 → `"exited"` | `inprocess-supervisor.ts:1312-1319`、`:1408-1432`、`:1231-1252` |
| F9 | **idle 仍占槽**（见 F5 的过滤）：真正释放槽位只有 `retired` / `exited` 两个边沿 | 同上 |
| F10 | `reserveNode` 先插 `status:"starting"` 账本行 → 排队项会自锁 | `orchestrator.ts:397-419` |
| F11 | `maxChildrenPerNode: 0` 合法且语义=禁止 | `src/agents/settings.ts:76-88`；`siblings(0) >= 0` 恒真 |
| F12 | 契约哨兵锁 §11.1 默认值字面 | `test/unit/legion-schema-sentinel.test.ts:226` |
| F13 | 两个事件闭集：持久化 `src/legion/events.ts:3-26`、纯进程 `src/extension/event-bus.ts:10-21`；漏加会冻结 DB 游标（#233） | 同上 |
| F14 | 既有可复用形态：verify 槽位排队（**轮询式**，本任务要事件驱动） | `src/runs/verify-queue.ts:55/95/141`、`index.ts:578` |
| F15 | `Handle` / `ChildRecord` / `TaskState` | `src/shared/types.ts:473-500` / `:298-360` / `:211-217` |
| F16 | `NODE_STATUSES` 6 值 + `padStatuses`/`validateStatuses` 硬编码 6 占位 | `src/legion/nodes.ts:7-14/403-427`；另一份副本 `src/extension/legion-status.ts:43` |
| F17 | 5 处 `new Orchestrator(` | `index.ts:556, 1445, 1517, 1801, 2396` |
| F18 | `rebuild.ts` 按 `child.state` 反推节点状态（`launching→starting` …），闭集里没有 `queued` 的落点 | `src/legion/rebuild.ts:342-347` |
| F19 | `recycle.ts` 列举「不可回收」状态 | `src/extension/recycle.ts:18-19` |
| F20 | 脚本：`npm run typecheck` / `npm test` / `npm run test:integration` | `package.json:52-54` |

## 2. 决策（D 编号，reviewer 必读）

### D1 — 可排队闸门白名单（四闸门）
**判定**：只有 `maxChildrenPerNode`、`maxActive`、账本 `max_children_per_node`、账本
`max_active_nodes` 入队。其余全部**同步硬拒**，**错误码与文案逐字不变**。
**不变量**：入队/拒绝的判定必须来自**结构化 verdict**（§4.1 `AdmissionVerdict`），
不得来自捕获 `BUDGET_EXCEEDED`（理由见 D1-b）。
**失败模式**：把 `maxDepth` 当可排队 → 无限队列，每个排队项必然超时。
**验收**：A6、A7、A9。

#### D1-a — 闸门来自「一个纯函数」，不是两份逻辑
`InProcessSupervisor.assertWithinLimits` 的四个 gate 判定与四条文案必须**抽成一个纯函数**
`evaluateInProcessAdmission(...)`（§4.1），supervisor 与 Orchestrator 的探测共用它。
理由：文案是用户可见契约（`test/unit/inprocess-supervisor.test.ts` 与 #197 用户反馈都锁它们），
两份实现必然漂移。
**验收**：A6（逐字比对四条文案）、A8。

#### D1-b — 为什么**不能**用 try/catch 包 `BUDGET_EXCEEDED`
一个码覆盖至少 8 种条件（F6）：`maxSpawnsPerSession` / `maxActive` / `maxDepth` /
`maxChildrenPerNode`（`:1143/:1150/:1159/:1166`）、`assertWithinBudgets` 的 depth 与
spawns、`childFromNode` 的「legion child is terminal and cannot be resumed」
（`orchestrator.ts:355`）、`reserveNode` 的 `parent_not_found` 与 `legion launch refused(...)`。
catch 它会同时造成三重破坏：
1. **把永久失败排进队列**（终态子节点、parent 不存在、深度超限）→ 每个都退化成 15 分钟静默等待；
2. **丢失文案同一性**（D1 要求硬拒文案逐字不变），因为 catch 到的是 `Error` 而非闸门身份；
3. **改变 model fallback 语义**：`canFallbackStart`（`orchestrator.ts:235-240`）**依赖**该 code 不做降级，
   catch-then-requeue 会让 fallback 链在排队语义下失效或误触发。
补充：账本侧 `budget_refused` 是**存储域事件**，由 `reserveNode` 的拒绝分支发出
（`orchestrator.ts:419-423`）；探测路径**不得**替它发事件（否则硬拒会出现两条事件）。

### D2 — 实现落点：Orchestrator 级准入（single choke point）
**判定**：排队逻辑只放在 `Orchestrator.launch`；`InProcessSupervisor` **只加**
「槽位释放回调 + 只读计数/探测」，**不**在 supervisor 内排队。
**为什么不是 supervisor 内排队**：in-process 子节点在账本门被放宽到无限（F3），账本看不到它们，
排队若放 supervisor 就必然与 rpc 路径分裂成两套调度器（不同队列、不同超时、不同文案），
而 issue #266 的诉求正是「一套」。Orchestrator 是唯一同时看见两后端、且唯一能保证
「入队时不做任何 reservation」的层（F10）。
**不变量（D2-a，需父会话追认）**：supervisor 新增的两个成员必须是 **read-only**
（`admissionCounts()` / `preflightAdmission()`）与**一个回调**（`onSlotReleased`）；
它们不改任何状态、不持有队列。契约原文「只加槽位释放回调」在字面上不含只读探测，
但缺少只读计数就必须在 Orchestrator 里复制 `assertWithinLimits` 的过滤与文案 —— 那与 D1-a 冲突。
本契约按「只读探测 + 回调」实施（仍无 supervisor 内排队），列为 §12 待追认项 O1。
**验收**：A7、A19。

### D3 — 排队项不占账本
**判定**：入队时**不** `reserveNode`、不建 worktree、不建 child run、不 `preCreateSessionFile`；
只产出 `ChildRecord{ state:"queued", spawnMode: <预期后端>, nodeId?: <确定性 id>, sessionFile: <占位路径> }`
并写入父 run.json（见 D3-a）。准入时才执行既有 reservation 路径。
`queued` **不**并入 `NODE_STATUSES` 闭集（F16）。
**为什么不是另一种方案**：把 `queued` 加进闭集会连带改 `padStatuses`/`validateStatuses`（硬编码 6 占位）、
`LIVE_CHILD_STATUSES`、`legion-status.ts` 的副本与 §11.1 哨兵，收益仅是 TUI 可见性 —— 而 TUI 通过
LaunchQueue 状态展示即可（D9）。账本里出现 `queued` 行还会污染 `listStaleNodes`/hygiene/orphan 扫描。
**失败模式**：先 reservation 再排队 → F10 自锁（`starting` 属 LIVE，自己把自己堵死）。
**验收**：A3、A16。

#### D3-a — 澄清：`queued` 记录**会**进 run.json（D3 原文「只留内存记录」措辞不准）
`index.ts` 的 `launchStep` 在 `launch()` 返回后必然 `store.addChild(handle.child)`
（`index.ts:2036-2040`），跨进程 `status` 也依赖 run.json（D9）。所以：
- **允许**写入：父 run.json 的一个 child 记录（state=`queued`）、`launch_queued` 进程事件。
- **禁止**创建：账本 `nodes` 行、child run 目录/run.json、worktree、`<name>.jsonl` session 文件。
- `sessionFile` 是**占位路径** `path.join(parentRunDir, "<name>.jsonl")`（纯字符串拼接，不建文件），
  准入后由真实路径覆盖；消费者不得把它当 resume 凭据（§11 R9）。
**验收**：A3、A15。

### D4 — 定名与命名空间
**判定**：名字在**入队时**即分配，唯一分配者是 Orchestrator（沿用 `allocateName`/`allocateLegionName`；
名字已占用检查 `this.children.has(name)` 覆盖排队项）。返回的 `Handle` 带
`queued: true` + `queuePosition: <1-based>`，`spawnMode` 报告**预期**后端（与准入后一致）。
**不变量**：同一个 `launch` 调用在被准入时**不得**重新分配名字或改 `spawnMode`；
`Handle.name`、`Handle.child.name` 在队列驻留期间不变。
**失败模式**：准入时重新分配名字 → 父 agent 手里的 queued handle 变成别名，`stop`/`status` 对不上。
**验收**：A12、A1（准入顺序 == 入队顺序）。

### D5 — 队列策略
**判定**：
1. **顺序**：单一全局 `seq`（入队序号）；准入时取「**seq 最小且探测通过**的项」。
2. **跳过（head-of-line）**：seq 更小的项若探测不通过则被跳过，不阻塞后续项。
3. **禁止跨 parent 抢占**：`seq` 全序即唯一顺序，任何实现都不得按 `parentKey` 重排或提升。
4. v1 不做公平性/优先级/权重。
**为什么不是「严格 per-parent FIFO + 全局 FIFO 双队列」**：一个 Orchestrator 通常只有一个
`parentKey`（父节点是同一个），双队列退化成单队列；而真正的公平性诉求（跨 parent 均分）
被 v1 明确排除（§10）。全序 + 跳过是这两条要求的最小实现。
**失败模式**：按 parentKey 分桶 → 跨 launch 调用的顺序不可预测且不可测。
**验收**：A1、A7。

### D6 — 有界与超时
**判定**（设置键与默认值见 D10）：
- 队列上限 `maxPending`（默认 **32**）。溢出 → **立即硬拒**，文案
  `launch queue overflow (<size>/<max>); raise subagents.inprocess.maxQueuedLaunches to allow more`。
- 等待上限 `launchQueueTimeoutMs`（默认 **900000**）。在**出队时刻**判定超时，文案
  `launch queue timed out after <N>s ('<name>')`。
- 两者都**绝不**创建账本行/目录/session 文件；都必须留下可断言痕迹：
  溢出抛 `SubagentError(msg, BUDGET_EXCEEDED)`；超时把 queued 记录标 `retired` +
  `onLaunchQueueNotice` 一行 + `LaunchQueueEvent{phase:"expired"}`（D9）。
**不变量**：只有「本来会被**可排队**闸门拒绝」的 launch 才可能入队；槽位空闲时永远走快路径（D2-b）。
**失败模式**：溢出判定做在准入路径上 → 32 个排队项的父被自己的第 33 个 launch 打断；
或超时用 `setTimeout` 直接 reject 一个正在 admit 的项（见 R7）。
**验收**：A10、A3。

#### D6-a — 澄清（D6 与 D10 的命名冲突）
D6 倾向中性名 `launchQueue.maxPending`，D10 冻结 `inprocess.maxQueuedLaunches`。
**裁定：设置键以 D10 为准**（`subagents.inprocess.maxQueuedLaunches` /
`subagents.inprocess.launchQueueTimeoutMs`），因为 D10 是设置键决策且要与 `docs/inprocess-supervisor.md`
的 Limit keys 表、§11.1 哨兵同步登记；`maxPending` 只作为**内部字段名**（`AdmissionQueueOptions.maxPending`）。
列为 §12 O2 备案。

### D7 — abort flush
**判定**：以下三者必须把队列清空且**零 spawn**：
1. 父 turn 的 `signal` abort（`interruptedResult()` 路径，`index.ts:1853-1863`）；
2. `subagent({action:"stop", name})` 指向一个尚未准入的排队项；
3. session 退出（`shutdownRetireAll`）。
`stop` 一个排队项 = 直接出队（记录标 `retired`、`retiredAt`、无 spawn、无账本行）。
**Esc/wait 中断不清空队列**（沿用 `esc-no-retire-v3`：Esc 只结束父 turn 的等待，child 继续）。
**失败模式**：abort 后队列仍在 pump → 父 turn 已结束却冒出 `▶ x started after queued 3s`。
**验收**：A4、A5。

### D8 — 顺序与 `async:false`
**判定**：
- `async: true`（默认）语义不变：`launch()` 立刻返回 queued handle，队列自己推进。
- `wait`/`collect` 对排队名**可见**：`collect(name)` 阻塞直到「准入 + 本轮 settle」，
  受 D6 超时约束；超时/被清空/被 stop 时 `collect` 抛
  `SubagentError(<queue message>, BUDGET_EXCEEDED)`。
- `async: false`：逐个「准入→再收集」（现有 `collectInline` 顺序不变），并在该子项收集结束后
  追加一行真实等待时长 `↳ <name> waited <N>s in the launch queue`（读 `ChildRecord.queueWaitedMs`）。
**失败模式**：`collect` 在未准入时去 `parseSessionFile`/`waitSettled` → 对不存在的 session 空转、
对未注册的 child 抛 NOT_FOUND。
**验收**：A12、A20。

#### D8-a — `wait` 的边界
`wait` 的目标解析走 `runtime.activeJobs()`；排队项在 `async` 下已被 `followLaunched` 追踪，
所以 `wait` 天然可用，无需新代码 —— 但**必须**保证 `followJob` 的 `collect` 闭包走 D8 的
「等准入」路径，否则 wait 会在第一轮就拿到 `collect failed`。
**验收**：A12。

### D9 — 观测
**判定（四处，缺一不可）**：
1. 启动行：`▶ scout-7 (scout) supervisor=inprocess queued(3)`（在原行尾追加 ` queued(<pos>)`）。
2. 准入行：`▶ scout-7 started after queued 42s`（`<N>` = `Math.round(waitedMs/1000)`）。
   送达通道：`OrchestratorDeps.onLaunchQueueNotice?: (line: string) => void`，index.ts 接到
   `pi.sendMessage`（root UI 另接 status pill）；`async:false` 同时进 tool result。
3. UI pill：新函数 `setLaunchQueueListener`（**不要改** verify 的 `setVerifyQueueListener`），
   文案 `legion-queue: 3 queued · 8/8 slots busy`（`slots` = 当前被卡的闸门上限，取不到的维度省略）。
4. `subagent({action:"status"})` 必须把排队项渲染成 `state=queued`（**不是** `unknown`/NOT_FOUND），
   `supervisor=<预期后端>`，且不打印 quiet/memory 行（`alive=false` 时既有实现已跳过）。
**为什么不是另一种方案**：复用 verify 的轮询 listener 会把「事件驱动」退回「每 `POLL_MS` 唤醒一次」，
与 F14 已记录的轮询缺陷一致，且 verify 的 phase 语义（waiting/acquired/released/overflow）与准入队列不同构。
**验收**：A10（文案）、A11、A13。

### D10 — 设置键
**判定**：新增两个 `subagents.inprocess.*` 键，`positiveInt` 解析（**0 非法**）：
| 键 | 默认 | 语义 |
|---|---|---|
| `inprocess.maxQueuedLaunches` | **32** | 同时驻留的排队项上限；RPC/账本路径复用同一个值（D2 单一调度器） |
| `inprocess.launchQueueTimeoutMs` | **900000** | 单项最长等待 |
必须同步登记：`docs/inprocess-supervisor.md` 的 **Limit keys (independent buckets)** 表（`:56` 起的表）
与 `docs/legion-v2-contract.md` §11.1（哨兵 `test/unit/legion-schema-sentinel.test.ts` 加一行断言）。
**不变量**：既有三行默认值（4/8/30）**逐字不变**（F12）。
**失败模式**：用 `nonNegativeInt` 解析 → 0 变成「队列禁用」而静默吞掉所有排队（0 的语义留给后续 issue）。
**验收**：A14、A8（哨兵仍绿）。

### D11 — `maxChildrenPerNode: 0` 特殊处理
**判定**：`inprocess.maxChildrenPerNode === 0` 或账本 `maxChildrenPerNode === 0` 时，
命中扇出门**直接硬拒**，**不入队**；文案沿用原 cap 文案。
**为什么**：0 = 「禁止派任何子节点」（F11），语义上永不可满足；入队只会让每个子项等 15 分钟后超时，
把用户的配置错误伪装成延迟。
**不变量**：0 判定必须在**入队决策之前**，并且在 `AdmissionVerdict` 里用独立硬拒 gate 名
（`inprocess.maxChildrenPerNode.disabled` / `ledger.maxChildrenPerNode.disabled`），便于断言与诊断。
**验收**：A9。

### D12 — 事件（只加两个进程级）
**判定**：`LEGION_PROCESS_EVENT_TYPES`（`src/extension/event-bus.ts:10-21`）新增
`launch_queued`、`launch_admitted`（**仅此两个**）；`src/legion/events.ts` 的持久化闭集**不动**。
- `launch_queued` data：`{ name, parentKey, position, queueSize, maxPending, gate, dimension, message }`
- `launch_admitted` data：`{ name, parentKey, waitedMs, position }`
**为什么**：持久化闭集漏加会永久冻结 DB 事件游标（#233，F13）；而队列状态是**本进程瞬时**事实，
跨进程无意义（重启即丢，§10）。
**失败模式**：顺手把 `launch_queue_timeout` 也加进总线 → 违反「只有两个」；超时/停止走 D9 的
notice + listener（无事件）。
**验收**：A13、A8（`test/unit/legion-events.test.ts` / `legion-event-bus.test.ts` 不红）。

## 3. 闸门 → 可排队性对照表（D1 完整枚举）

| 闸门 | 后端 | 默认 | 判定文案（逐字） | 可排队 | 维度 |
|---|---|---|---|---|---|
| `inprocess.maxChildrenPerNode` | inprocess | 8 | `inprocess maxChildrenPerNode reached for '<parent>' (n/8)` | ✅ | fanout（per parentKey） |
| `inprocess.maxActive` | inprocess | 30（有块缺省 8） | `inprocess maxActive reached (n/30); raise subagents.inprocess.maxActive to allow more` | ✅ | active（全局） |
| `legion.maxChildrenPerNode`（`max_children_per_node`） | rpc | 8 | `legion launch refused (max_children_per_node): parent already has n live children; maxChildrenPerNode is 8` | ✅ | fanout |
| `legion.maxActiveNodes`（`max_active_nodes`） | rpc | 30 | `legion launch refused (max_active_nodes): tree already has n active nodes; maxActiveNodes is 30` | ✅ | active |
| `inprocess.maxSpawnsPerSession` | inprocess | 无 | `inprocess spawn budget exhausted (n/N); raise subagents.inprocess.maxSpawnsPerSession to allow more` | ❌ 硬拒 | — |
| `inprocess.maxDepth` | inprocess | 4 | `inprocess nesting limit reached (depth d, max 4); raise subagents.inprocess.maxDepth to allow deeper nesting` | ❌ 硬拒 | — |
| `legion.maxDepth`（`max_depth`） | rpc | 4 | `legion launch refused (max_depth): …` | ❌ 硬拒 | — |
| `parent_not_found` | rpc | — | `legion launch refused (parent_not_found): …` | ❌ 硬拒（永久） | — |
| `maxSpawns`（`maxSubagentSpawnsPerSession`） | 两后端 | 无 | `subagent spawn budget exhausted (n/N); …` | ❌ 硬拒 | — |
| Orchestrator `maxDepth` | 两后端 | ≤4 硬顶 | `subagent nesting limit reached (depth d, max C); …` | ❌ 硬拒 | — |
| memory gate | rpc | — | `INSUFFICIENT_MEMORY` 原文 | ❌ 硬拒 | — |
| name collision | 两后端 | — | `NAME_TAKEN` 原文 / `child is already alive` | ❌ 硬拒 | — |
| unknown agent / disabled role / model scope | index | — | 现有 `✗ …` 行 | ❌ 硬拒（在 `launchStep`，不入 Orchestrator） | — |
| `inprocess` + `worktree:true` / `kind!==pi` | 两后端 | — | `INVALID_PARAMS` 原文 | ❌ 硬拒 | — |
| terminal child resume | legion | — | `legion child is terminal and cannot be resumed` | ❌ 硬拒（永久） | — |
| **`maxChildrenPerNode === 0`** | 两后端 | — | 同原 cap 文案 | ❌ 硬拒（D11） | — |

> 判据的唯一来源是 `checkLaunchBudget` 的 `reason` 与 `evaluateInProcessAdmission` 的
> `gate` 字段，**不是** `Error.code`（D1-b）。

## 4. 冻结接口

### 4.1 新模块 `src/supervisor/admission-queue.ts`（纯：无 fs / 无 db / 无 timer / 无 process）

```ts
import type { ChildLaunchContext } from "./child-context.ts"; // 仅类型，payload 用

export const DEFAULT_LAUNCH_QUEUE_MAX_PENDING = 32;
export const DEFAULT_LAUNCH_QUEUE_TIMEOUT_MS = 900_000;

export type AdmissionDimension = "fanout" | "active";

export type QueueableGate =
	| "inprocess.maxChildrenPerNode"
	| "inprocess.maxActive"
	| "ledger.maxChildrenPerNode"
	| "ledger.maxActiveNodes";

export type HardGate =
	| "inprocess.maxSpawnsPerSession"
	| "inprocess.maxDepth"
	| "inprocess.maxChildrenPerNode.disabled"
	| "ledger.maxChildrenPerNode.disabled"
	| "legion.maxDepth"
	| "legion.parentNotFound"
	| "orchestrator.maxDepth"
	| "orchestrator.maxSpawns"
	| "other";

export type AdmissionVerdict =
	| { readonly admitted: true }
	| {
			readonly admitted: false;
			readonly queueable: true;
			readonly gate: QueueableGate;
			readonly dimension: AdmissionDimension;
			readonly message: string;
	  }
	| { readonly admitted: false; readonly queueable: false; readonly gate: HardGate; readonly message: string };

/** in-process 计数快照（由 InProcessSupervisor 提供，只读）。 */
export interface InProcessAdmissionCounts {
	readonly parentKey: string;
	/** 该 parentKey 下的 live 子节点数（过滤与 assertWithinLimits 完全一致）。 */
	readonly siblings: number;
	/** 全部 live 子节点数。 */
	readonly active: number;
	readonly spawnCount: number;
	/** inProcessDepth()（调用时刻）。 */
	readonly depth: number;
	readonly limits: {
		readonly maxDepth: number;
		readonly maxChildrenPerNode: number;
		readonly maxActive: number;
		readonly maxSpawnsPerSession?: number;
	};
}

/**
 * 唯一闸门判定实现（纯）。`inflight` = Orchestrator 已探测通过但尚未出现在
 * counts 里的准入（见 D2-b）；只影响 fanout/active 两个可排队维度。
 * 判定顺序必须与 assertWithinLimits 现状一致：
 * maxSpawnsPerSession → maxActive → maxDepth → maxChildrenPerNode。
 */
export function evaluateInProcessAdmission(
	counts: InProcessAdmissionCounts,
	inflight?: { readonly fanout: number; readonly active: number },
): AdmissionVerdict;

/** 冻结文案构造器（A6 逐字断言）。 */
export function inProcessSpawnsMessage(spawnCount: number, limit: number): string;
export function inProcessActiveMessage(active: number, limit: number): string;
export function inProcessDepthMessage(depth: number, limit: number): string;
export function inProcessFanoutMessage(parentKey: string, siblings: number, limit: number): string;
export function queueOverflowMessage(size: number, maxPending: number): string;
export function queueTimeoutMessage(name: string, waitedMs: number): string;

// ── 队列本体 ──────────────────────────────────────────────────────────────

export interface QueuedLaunch<T = unknown> {
	readonly name: string;
	readonly parentKey: string;
	readonly seq: number;
	readonly enqueuedAt: number;
	readonly payload: T;
}

export interface AdmissionQueueOptions {
	readonly maxPending?: number;
	readonly timeoutMs?: number;
	/** 注入时钟；默认 Date.now。纯模块唯一的时间来源。 */
	readonly now?: () => number;
}

export type EnqueueOutcome<T> =
	| { readonly ok: true; readonly item: QueuedLaunch<T>; readonly position: number }
	| { readonly ok: false; readonly kind: "overflow"; readonly message: string };

export type NextAdmission<T> =
	| { readonly kind: "none" }
	| { readonly kind: "admit"; readonly item: QueuedLaunch<T>; readonly waitedMs: number }
	| { readonly kind: "expired"; readonly item: QueuedLaunch<T>; readonly waitedMs: number; readonly message: string };

export interface AdmissionQueueEntry {
	readonly name: string;
	readonly parentKey: string;
	readonly seq: number;
	readonly position: number; // 1-based
	readonly waitedMs: number;
}

export interface AdmissionQueue<T = unknown> {
	readonly size: number;
	readonly maxPending: number;
	readonly timeoutMs: number;
	enqueue(payload: T, meta: { name: string; parentKey: string }): EnqueueOutcome<T>;
	positionOf(name: string): number | undefined;
	waitedMs(name: string): number | undefined;
	/** 出队并返回（stop / abort flush）。不存在返回 undefined。 */
	remove(name: string): QueuedLaunch<T> | undefined;
	/** 清空并返回（按 seq 升序）。 */
	flush(): QueuedLaunch<T>[];
	/** 纯决策：seq 最小且 probe 通过者；若 seq 最小项已超时则先报 expired。 */
	next(probe: (item: QueuedLaunch<T>) => AdmissionVerdict): NextAdmission<T>;
	entries(): readonly AdmissionQueueEntry[];
	/** 是否还有未到期的等待项 → 决定 Orchestrator 是否保留一个 unref 定时器。 */
	nextDeadlineAt(): number | undefined;
}

export function createAdmissionQueue<T = unknown>(options?: AdmissionQueueOptions): AdmissionQueue<T>;

/**
 * 进程级注册表：同一父 run 的所有 Orchestrator 实例共享一个队列（D5 全序 + 跨实例 stop）。
 * 存 globalThis + Symbol.for —— 与 spawn-default-inprocess-v3 D5/REV2-4 同因（jiti moduleCache:false）。
 */
export function acquireAdmissionQueue<T = unknown>(
	scope: string,
	options?: AdmissionQueueOptions,
): AdmissionQueue<T>;
export function resetAdmissionQueuesForTests(): void;

/** D9：进程内 UI 钩子（与 verify-queue 的 listener 同形态、不同函数）。 */
export interface LaunchQueueEvent {
	readonly phase: "queued" | "admitted" | "expired" | "overflow" | "stopped" | "flushed";
	readonly name?: string;
	readonly position?: number;
	readonly waitedMs?: number;
	readonly queued: number;
	readonly slotsInUse?: number;
	readonly slots?: number;
	readonly message?: string;
}
export function setLaunchQueueListener(fn: ((event: LaunchQueueEvent) => void) | undefined): void;
```

### 4.2 `InProcessSupervisor` 增量（`src/supervisor/inprocess-supervisor.ts`）

```ts
export interface InProcessSlotEvent {
	readonly name: string;
	/** 与 assertWithinLimits 的 maxChildrenPerNode 分组键完全一致。 */
	readonly parentKey: string;
	/** 只有 retired / exited 释放槽位；idle 仍占槽（F9）。 */
	readonly state: "retired" | "exited";
}

export interface InProcessSupervisorOptions {
	// …既有字段不变…
	/** D2：child 离开 live 集合时触发（retire 收尾、rollbackSpawn 收尾、disposeRecord）。 */
	onSlotReleased?: (event: InProcessSlotEvent) => void;
}

export class InProcessSupervisor {
	/** 只读探测：给定名字现在会不会被闸门拒绝。绝不抛、绝不改状态。 */
	preflightAdmission(name: string): AdmissionVerdict;
	/** 只读计数（含 limits 与当前 depth），供 Orchestrator 叠加 inflight。 */
	admissionCounts(name: string): InProcessAdmissionCounts;
	// …其余 API 不变…
}
```

**实现约束**：`assertWithinLimits` 改为
`const v = evaluateInProcessAdmission(this.admissionCounts(name)); if (!v.admitted) { this.onSpawnRefused?.(v.message); throw new SubagentError(v.message, ErrorCodes.BUDGET_EXCEEDED); }`。
`onSlotReleased` 的发射点（三处，全部幂等）：
`retireChild` 的 `finally`（`:1428-1431`）、`rollbackSpawn` 的 `finally`（`:1249-1254`）、
`disposeRecord`（`:1434-1442`）。`updateTurnState` 的 `idle` 分支（`:1318`）**不**发射。

### 4.3 Orchestrator 接入点（`src/runs/orchestrator.ts`）

**插入位置（冻结）**：`launch()` 体内，在
`if (inProcess && worktree) { throw … }`（`:664-669`）**之后**、
`let worktreePath = previous?.worktreePath;`（`:670`）与 `try {`（`:671`）**之前**。
即：名字已分配（`:585-587`）、后端已仲裁（`:630-655`）、`assertWithinBudgets` 与 `isAlive`
已通过（`:656-657`）、inprocess+worktree 已硬拒（`:664-669`）、**任何副作用之前**（worktree / run / session / reserveNode）。

```ts
export interface OrchestratorDeps {
	// …既有字段不变…
	/** D6/D10：队列边界。缺省取 admission-queue.ts 的默认值。 */
	launchQueue?: { maxPending?: number; timeoutMs?: number };
	/** D9：用户可见的一行排队/准入/超时/停止通知。 */
	onLaunchQueueNotice?: (line: string) => void;
}

/** 排队项的 payload（Orchestrator 私有类型，冻结形状）。 */
export interface LaunchQueuePayload {
	readonly name: string;
	readonly parentKey: string;
	readonly inProcess: boolean;
	/** 入队时的 ALS 深度；准入必须用 runAtAbsoluteDepth 压回。 */
	readonly parentDepth: number;
	/** 入队时的 ALS 身份；准入必须用 runInChildContext 压回。 */
	readonly parentContext?: ChildLaunchContext;
	/** 执行真正的 launch（admissionAlreadyGranted=true）。 */
	run(): Promise<Handle>;
	/** 项离开队列（准入/超时/停止/清空）时结算。 */
	readonly settled: Promise<AdmitOutcome>;
}

export type AdmitOutcome =
	| { readonly kind: "admitted"; readonly waitedMs: number }
	| { readonly kind: "rejected"; readonly reason: "timeout" | "stopped" | "flushed"; readonly message: string };

export class Orchestrator {
	/** D7：清空队列且不 spawn；返回被清掉的名字（按 seq 升序）。 */
	flushLaunchQueue(reason: string): string[];
	/** D9：只读快照（跨实例，读注册表）。 */
	launchQueueEntries(): readonly { name: string; parentKey: string; position: number; waitedMs: number }[];
	// 私有（形状冻结，不对外）
	// private probeAdmission(name, ctx): AdmissionVerdict
	// private enqueueLaunch(input, name, verdict): Promise<Handle>
	// private async pumpAdmissions(): Promise<void>
	// private readonly admitting = new Map<string, { parentKey: string; dimension: AdmissionDimension }>()
}
```

**`ChildRecord.state` 写法（冻结）**：
- 入队：`state = "queued"`；`spawnMode = mode`（预期后端）；`queuePosition = <1-based>`；
  `spawnedAt = new Date(now)`；`sessionFile = path.join(this.runDir, name + ".jsonl")`（占位）；
  legion 路径下 `nodeId = nodeIdForChild(parentNodeId, name)`（确定性 id，**不建行**）；
  **不**调用 `recordChild`（不增加 `this.spawned`）、**不**碰 `onChildUpdate` 之外的持久化。
- 准入：`pumpAdmissions` 先 `delete queued 记录`，再以
  `launchInternal(input, { admissionAlreadyGranted: true })` 重跑；新纪录
  `state = "launching"/"working"`（既有路径）、`queueWaitedMs = waitedMs`。
- 超时/停止/清空：`state = "retired"`、`retiredAt = now`、无 `execution`。

**`previous` 计算必须排除 queued 记录（冻结）**：
```ts
const priorRecord = this.children.get(name);
const previous = priorRecord && priorRecord.state !== "queued"
	? priorRecord
	: (ledgerPrevious ? this.childFromNode(name, ledgerPrevious) : undefined);
```
（否则 queued 的**占位 sessionFile** 会被当成 resume 凭据；D3-a 的风险点。）

#### D2-b — 快路径不许多一个 await（既有测试不红的根）
**判定**：槽位可用时，`launch()` 的行为与 master **逐字节一致**：探测是同步的
（`admissionCounts`/`checkLaunchBudget` 都是同步读），入队路径完全不被触碰，不新增微任务。
`admitting` 计数器在**探测通过的同一次同步执行内**插入（`this.admitting.set(name, …)`），
在 `spawnChild` resolve 后、`recordChild` 之后删除。
**为什么必须**：同 tick 的 12 路 fanout，前 8 个 `launch()` 的第一次 await 之前并**没有**
任何 child 注册进 `this.children`（`spawnChild` 的 `children.set` 在 `persistParentReservation`
之后才跑）。若只靠计数快照，12 路探测全部看到 0 → 全部放行 → 回到今天的 4 个报错。
`admitting`（in-flight 保留位）是同 tick 只允许 8 个进入的唯一机制。
**精确性不承担正确性**：探测只是**咨询性**的；真正权威仍是 `assertWithinLimits`/`withLaunchBudget`。
探测通过后仍被真闸门拒 → **不计报错**，把项按原 `seq` 重新入队，等下一次触发（D2-c）。
**验收**：A1、A2、A18。

#### D2-c — 探测后仍被拒的处理
**判定**：`launchInternal(…, {admissionAlreadyGranted:true})` 抛出的错误若 `code === BUDGET_EXCEEDED`
且**能归因到可排队闸门**（由同一 `probeAdmission` 复判，此时其它 launch 已落子，归因可靠）→
`pumpAdmissions` 捕获、按原 `seq` 重新入队、`this.pumping = false`、**不**立即再 pump（等下一个触发）。
其余错误（含硬拒闸门、NAME_TAKEN、START_FAILED）照原样冒泡。
**失败模式**：重入队后立刻再 pump → 忙等自旋（探测与真闸门短暂不自洽时 CPU 打满）。
**验收**：A7（rpc 路径覆盖这条）。

#### D2-d — pump 的触发源（事件优先 + 单个兜底定时器）
1. `enqueue` 成功之后（本次入队可能刚好有槽位：虽然入队意味着探测没过，但同批前面的项可能已释放）；
2. `InProcessSupervisor.onSlotReleased` → `schedulePump()`；
3. Orchestrator 自己观察到子项 `retired`/`exited`（`retire()` 与 `recordSettled` 之后）；
4. **兜底**：队列非空时挂**一个** `unref()` 定时器，到期时刻 = `min(队列最早到期时间, now + launchQueueRecheckMs)`
   （`launchQueueRecheckMs` 固定 1000，写死在 `admission-queue.ts` 并导出，不新增设置键）。
   理由：账本槽位可被**另一个进程**（sibling session / hygiene）释放，本进程收不到事件（§11 R2）。
**不变量**：队列空 → 立即清定时器；任何时刻最多一个定时器；`pumpAdmissions` 用 `pumping` 互斥。

### 4.4 `Handle` / `ChildRecord` / `TaskState` 增量（`src/shared/types.ts`）

```ts
export type TaskState =
	| "queued"        // 新增：已分配名字、无账本行、无 session 文件（D3）
	| "launching"
	| "working"
	| "awaiting"
	| "blocked"
	| "retired"
	| "exited";

export interface ChildRecord {
	// …既有字段不变…
	/** D4：入队瞬间的 1-based 队列位次；准入后清除。 */
	queuePosition?: number;
	/** D6/D8：实际排队等待毫秒（准入时写入；从未排队则缺省）。 */
	queueWaitedMs?: number;
}

export interface Handle {
	// …既有字段不变…
	/**
	 * D4：true 表示本次 launch 仍在队列里、尚未 spawn。
	 * `child.state === "queued"`、`sessionFile` 是占位路径、`pid` 必然缺省。
	 */
	queued?: boolean;
	/** D4：入队瞬间的 1-based 位次（`queued === true` 时必有）。 */
	queuePosition?: number;
}

export interface InProcessLimits {
	// …既有字段不变…
	/** D10：队列上限（positiveInt，默认 32）。 */
	maxQueuedLaunches?: number;
	/** D10：单项最长等待毫秒（positiveInt，默认 900000）。 */
	launchQueueTimeoutMs?: number;
}
```

配套改动（必须同批，否则 `queued` 是幽灵状态）：
| 文件 | 行 | 改动 |
|---|---|---|
| `src/legion/rebuild.ts` | `:343` 前 | `if (child.state === "queued") continue;`（排队项不重建进 tree，F18/D3） |
| `src/extension/recycle.ts` | `:18-19` | 把 `"queued"` 加进「不可回收」判定（排队项无 session 可回收） |
| `index.ts` | `:2963` `listLiveChildrenForStatus` | 保持不变（queued 天然被视为 live → 出现在 status 概览，D9） |
| `src/extension/runtime.ts` | `:1541-1543` | 只读确认：tree 状态映射不会把 `queued` 误映射；若需要则显式跳过 |
| `src/legion/nodes.ts` | — | **不动**（D3/F16） |

### 4.5 Settings（`src/agents/settings.ts` + 文档）

```ts
// parseInProcessLimits 内新增两段（positiveInt，0 非法）
const maxQueuedLaunches = positiveInt(value.maxQueuedLaunches, "inprocess.maxQueuedLaunches", filePath);
if (maxQueuedLaunches !== undefined) out.maxQueuedLaunches = maxQueuedLaunches;
const launchQueueTimeoutMs = positiveInt(value.launchQueueTimeoutMs, "inprocess.launchQueueTimeoutMs", filePath);
if (launchQueueTimeoutMs !== undefined) out.launchQueueTimeoutMs = launchQueueTimeoutMs;
```

默认值来源单一：`admission-queue.ts` 的 `DEFAULT_LAUNCH_QUEUE_MAX_PENDING` / `DEFAULT_LAUNCH_QUEUE_TIMEOUT_MS`，
settings 侧不另建常量。

## 5. 状态机

```
                        ┌──────────────── launch() 探测：可排队闸门命中 ───────────────┐
                        │                                                            │
   (调用方) ──launch()──►│  queued(ChildRecord.state="queued", 无账本行/无 session)     │
                        │      │                                                     │
                        │      ├── admit（pump: 探测通过 + runAtAbsoluteDepth/runInChildContext）
                        │      │        └──► launching ──► running ──► idle ──► retired
                        │      │            （既有 launch 路径；此步起才 reservation）
                        │      ├── launchQueueTimeoutMs 到期 ──► retired + notice(§D9) + listener(expired)
                        │      ├── stop(name) ───────────────► retired + listener(stopped)
                        │      ├── flush(signal abort / session exit) ──► retired + listener(flushed)
                        │      └── 探测后仍被真闸门拒 ───────► 重新入队（保持 seq），不报错
                        └────────────────────────────────────────────────────────────
   槽位可用 ──launch()──► launching ──► running ──► idle ──► retired        （master 路径，零改动）
   溢出（size == maxPending）──► 立即抛 launch queue overflow，无记录、无 listener(overflow 广播)
```

| 迁移 | 驱动者（事件来源） |
|---|---|
| `(none) → queued` | `Orchestrator.launch` 探测命中可排队闸门（同步） |
| `queued → launching` | `pumpAdmissions`（触发：enqueue / `onSlotReleased` / 自身 retire / 兜底定时器） |
| `queued → 重入队` | 同一 pump 的 catch（D2-c） |
| `queued → retired(timeout)` | `queue.next()` 判 `enqueuedAt + timeoutMs <= now()` |
| `queued → retired(stopped)` | `Orchestrator.retire()` 的 queued 分支（`subagent stop`） |
| `queued → retired(flushed)` | `Orchestrator.flushLaunchQueue()`（signal abort / session shutdown） |
| `launching → running` | 既有 `recordLegionLaunch` / `recordChild`（未改） |
| `running → idle` | `agent_settled`（F8）——**不释放槽位**（F9） |
| `idle/running → retired` | 父 collect 后的 recycle / `retire()` / `retireAll()`（F8）→ **释放槽位** |
| 任意 → `exited` | spawn 失败 `rollbackSpawn`（F8）→ **释放槽位** |

## 6. 文件所有权（并行 worker）

> 规则：一个文件只有一个 owner；共享文件按 §7 顺序串行合并；跨 worktree 靠本契约的签名。

| Worker | 独占文件 | 依赖 |
|---|---|---|
| **W1 队列内核** | `src/supervisor/admission-queue.ts`(新)、`src/shared/types.ts`（`TaskState`/`Handle`/`ChildRecord`/`InProcessLimits` 增量）、`src/agents/settings.ts`（仅 `parseInProcessLimits` 两键）、`test/unit/admission-queue.test.ts`(新)、`test/unit/spawn-mode-settings.test.ts`（新增解析用例） | 无（本契约） |
| **W2 监督者钩子** | `src/supervisor/inprocess-supervisor.ts`、`test/unit/inprocess-supervisor.test.ts` | W1（`AdmissionVerdict`/`evaluateInProcessAdmission`/文案构造器） |
| **W3 编排器准入** | `src/runs/orchestrator.ts`、`src/legion/rebuild.ts`（queued 跳过）、`src/extension/recycle.ts`、`test/unit/orchestrator-admission.test.ts`(新)、`test/integration/launch-queue.test.ts`(新) | W1 + W2 |
| **W4 接线与文案** | `index.ts`（5 处 Orchestrator 接线、启动行、flush、listener、`onLaunchQueueNotice`）、`test/unit/teams.test.ts`（launch 行断言扩展）、`test/unit/legion-status.test.ts`（`state=queued`）、`test/unit/runtime.test.ts`（若需要） | W3 |
| **W5 文档与哨兵** | `docs/inprocess-supervisor.md`、`docs/legion-v2-contract.md`（§11.1 加一行）、`CHANGELOG.md`、`test/unit/legion-schema-sentinel.test.ts` | 可与 W3 并行（只读 W1 的类型名） |

**禁止任何 worker 改**：`test/helpers/*`、`src/legion/budget.ts`、`src/legion/nodes.ts`、
`src/legion/events.ts`、`src/supervisor/rpc-supervisor.ts`、`src/runs/verify-queue.ts`、
`src/supervisor/spawn-mode.ts`、`docs/contracts/*`。

### 6.1 五处 `new Orchestrator` 的接线责任（F17）

| 行 | 场景 | 责任 |
|---|---|---|
| `index.ts:1801` | 命令链 launch family（bug 主路径） | 传 `launchQueue`（settings 两键）+ `onLaunchQueueNotice`；abort 时 `flushLaunchQueue("parent turn ended")` |
| `index.ts:2396` | vexillatio utility family | 传 `launchQueue`（同一套边界）+ notice；中断时 `flushLaunchQueue`；排队项进 `stillRunning` |
| `index.ts:556` | `resumeLegionChild` | 传 `launchQueue`（resume 也可能撞 fanout 上限） |
| `index.ts:1517` | 控制动作（`collect`/`stop`/`steer`…） | 不传配置；靠进程级注册表（同 runDir 共享队列）把 `stop` 落到队列上 |
| `index.ts:1445` | `stop` 的 retire 适配器 | 同上；rebuild 出的 Orchestrator 通过注册表 dequeu |

## 7. 集成顺序

`W1 → W2 → W3 → W4`，`W5` 可与 `W3`/`W4` 并行（只依赖 W1 的类型名与 §4.5 的键名）。
W2/W3 不可并行：W3 import W2 的 `admissionCounts`/`preflightAdmission`。
W3/W4 不可并行：W4 的 `index.ts` import W3 的 `flushLaunchQueue`/`launchQueueEntries`。
冲突风险点（合并时优先看）：
1. `src/shared/types.ts` —— 只有 W1 改；其他人若需要字段，向父会话要修订，不自改。
2. `src/runs/orchestrator.ts` —— 只有 W3 改；W4 只改 `index.ts`。
3. `test/unit/inprocess-supervisor.test.ts` —— 只有 W2 改（既有 33 例必须保持全绿）。
4. `test/unit/teams.test.ts` —— 只有 W4 改（launch 行断言）；W3 的新断言写进自己的新文件。

## 8. 验收清单（A1..A22，全部机器可检查；A23 见 §13.3.1）

| # | 断言 | 位置/命令 |
|---|---|---|
| **A1** | 12 步 fanout、`maxChildrenPerNode: 8` → 12 个全部跑完；4 个先 `queued` 后 `admitted`；准入顺序 == 入队顺序；结果里 **0 条** `BUDGET_EXCEEDED`/`maxChildrenPerNode reached` | `test/integration/launch-queue.test.ts`；`npm run test:integration` |
| **A2** | 9 步、`maxActive: 4` → 全部跑完；任一时刻 in-process live 子节点 ≤ 4（在 fake session factory 里采样 `admissionCounts().active`） | 同上 |
| **A3** | 超时项：推进注入时钟越过 `launchQueueTimeoutMs` → 记录 `state=retired`；`nodes` 表无该行；无 `<runId>/<name>.jsonl`；无 worktree 目录；`getChildren(db,parent)` 不含它 | `test/integration/launch-queue.test.ts` |
| **A4** | `stop` 排队项 → `queue.size` 减 1；`FakeSupervisor.spawns` 不含该名；记录 `retired`；result 含 `launch queue` 停止文案 | `test/unit/orchestrator-admission.test.ts` |
| **A5** | 5 个排队项 + `signal.abort()` → `flushLaunchQueue` 返回 5 个名字、队列空、0 spawn、`supervisor.children` 计数不变、`interrupted (parent turn ended; children still running)` 仍在结果里 | `test/unit/teams.test.ts` |
| **A6** | 非并发闸门行为**逐一不变**：`maxDepth`/`maxSpawns`/`parent_not_found`/terminal child/`NAME_TAKEN`/`INSUFFICIENT_MEMORY`/unknown agent/disabled/model scope/`inprocess+worktree` → 错误码与文案与 master 逐字相同，且 `queue.size === 0` | `test/unit/orchestrator-admission.test.ts`（文案用 `assert.equal`） |
| **A7** | inprocess 与 rpc 同一套调度：把 `probe` 参数化跑同一组队列用例；另加 rpc 集成（`spawnMode:"rpc"` + `legion.maxChildrenPerNode:1`）→ 第 2 个先 queued，第 1 个 settle 后 admitted | `test/unit/admission-queue.test.ts` + `test/integration/launch-queue.test.ts` |
| **A8** | 既有套件全绿：`npm run typecheck && npm test && npm run test:integration`；重点 `test/unit/legion-budget.test.ts`、`test/unit/inprocess-supervisor.test.ts`、`test/unit/legion-schema-sentinel.test.ts`、`test/unit/legion-events.test.ts`、`test/unit/legion-event-bus.test.ts` | 三条命令，首个非零即 rejected |
| **A9** | `inprocess.maxChildrenPerNode: 0` 与 `legion.maxChildrenPerNode: 0` → 立即硬拒（gate 名为 `*.disabled`），`queue.size === 0`，文案含原 cap 数 | `test/unit/orchestrator-admission.test.ts` |
| **A10** | 溢出：`maxQueuedLaunches: 2`、需要 3 个排队 → 第 3 个立即 `launch queue overflow (2/2)`；文档断言用 `/launch queue overflow \(\d+\/\d+\)/`；无记录、无账本行 | 同上 |
| **A11** | `subagent({action:"status", name})` 对排队名 → 文本含 `state=queued`、`supervisor=inprocess`，**不含** `unknown child` | `test/unit/legion-status.test.ts` |
| **A12** | `collect` 对排队名阻塞：注入时钟下，准入前 `collect` 未 resolve；准入+settle 后返回真实结果；`wait` 同理不报 `collect failed` | `test/unit/orchestrator-admission.test.ts` |
| **A13** | 事件闭集：`LEGION_EVENT_TYPES`（`src/legion/events.ts`）数组长度与内容**逐字不变**；`LEGION_PROCESS_EVENT_TYPES` 恰好多 `launch_queued`/`launch_admitted`；DB 事件游标不冻结（append 后 `readEventsAfterTolerant` 不抛） | `test/unit/legion-events.test.ts`（新增两向断言） |
| **A14** | 设置：`inprocess.maxQueuedLaunches: 0` → 抛「expected a positive integer」；缺省 → 32 / 900000 | `test/unit/spawn-mode-settings.test.ts` |
| **A15** | 占位 sessionFile：queued 记录的 `sessionFile === path.join(parentRunDir, name + ".jsonl")` 且该文件**不存在**；准入后记录的 `sessionFile` 等于真实 spawn 路径且文件存在 | `test/unit/orchestrator-admission.test.ts` |
| **A16** | `queued` 不进账本闭集：`NODE_STATUSES.length === 6`；`validateStatuses` 上限仍 6；tree 里无该名节点（`rebuild` 跳过）；`padStatuses` 未改 | `test/unit/legion-nodes.test.ts`、`test/unit/legion-rebuild.test.ts`（新增） |
| **A17** | 进程级注册表：同 `runDir` 的两个 Orchestrator 实例 `positionOf(name)` 一致；`resetAdmissionQueuesForTests()` 使测试互不污染 | `test/unit/admission-queue.test.ts` |
| **A18** | 深度/身份复原：在 ALS 深度 2 处入队，准入后子节点 `spawnDepth === 3`，且 spawn 期间 `currentChildContext()` 等于父上下文（用 `?reload=` 保持 D5 的判别性） | `test/unit/orchestrator-admission.test.ts` + `test/unit/inprocess-supervisor.test.ts` |
| **A19** | `onSlotReleased` 只在 `retired`/`exited` 触发，`agent_settled`(idle) 不触发；retire 与 spawn 失败各触发一次 | `test/unit/inprocess-supervisor.test.ts` |
| **A20** | `async:false`：3 步、cap 1 → 3 个结果齐全，且每个排队项输出 `↳ <name> waited <N>s in the launch queue` | `test/integration/launch-queue.test.ts` |
| **A21** | 快路径零微任务（D2-b）：单步 launch 在 `FakeSupervisor.spawns` 上的调用时序与 master 一致；`queue.size === 0`；没有新增 `await` 导致的顺序变化（用「同一 tick 内 8 步全部进入 spawn」断言） | `test/unit/orchestrator-admission.test.ts` |
| **A22** | 探测后仍被真闸门拒 → 重新入队而非报错：预置 `admitting` 满 8 后放行的第 9 个在真闸门被拒 → 结果里无 `✗`，该名仍在队列（rpc 路径用 `legion.maxChildrenPerNode:1` 构造） | `test/integration/launch-queue.test.ts` |

## 9. 文档更新（独立步骤，W5）

| 文件 | 条目 |
|---|---|
| `docs/inprocess-supervisor.md` | ① `Limit keys (independent buckets)` 表（`:56` 起）加两行：`Queue depth | —（RPC 复用同值） | inprocess.maxQueuedLaunches (default 32)`、`Queue wait | — | inprocess.launchQueueTimeoutMs (default 900000)`；② 新小节「Launch admission queue」：可排队闸门白名单（§3 表）、事件驱动 + 单定时器兜底、`queued` 不进账本/不建 session、`maxChildrenPerNode: 0` 硬拒；③ `Refusals` 小节补 `launch queue overflow` / `launch queue timed out after Ns` 两条。 |
| `docs/legion-v2-contract.md` | §11.1 表格新增一行 `| \`maxQueuedLaunches\`（inprocess 准入队列上限） | 32 | 队列溢出立即硬拒，文案 `launch queue overflow`；默认 32 与 `inprocess.maxQueuedLaunches` 同源 |`。**不得**改 4/8/30 三行。 |
| `test/unit/legion-schema-sentinel.test.ts` | 三元组循环加 `["maxQueuedLaunches","32"]`；其余不动。 |
| `CHANGELOG.md` | `## [Unreleased]` → `### Added`：launch admission queue（超限排队而非拒绝，issue #266）+ 两个进程级事件 + 两个设置键。 |
| `README.md` | 可选：若 README 已有 inprocess 限额段落则补两键；当前无该段落则跳过（记为已知缺口）。 |

## 10. 明确不做（v1 边界，reviewer 判「缺失」前先读本节）

| 不做 | 理由 |
|---|---|
| 跨 parent 公平性 / 优先级 / 权重 / 队列抢占 | D5：v1 只保证「seq 全序 + 允许跳过」，公平性是单独的调度问题 |
| **队列持久化** | 进程崩溃即丢。**已知限制（必须写进文档）**：崩溃后 run.json 里会留下 `state:"queued"` 的**陈旧**记录；它们没有账本行、没有 session 文件，`status` 仍显示 `state=queued`（`owner: live` 指父 run 的 owner）。**恢复方式**：a) `subagent({action:"stop", name})` 把它标 `retired`；b) 重新 `launch`（新名字）；c) 重启后 `queued` 记录永远不会自己变活，也不会被 hygiene 当成 live 节点（账本里没有它）。 |
| 排队期间改 agent / model / worktree / team | D4：payload 在入队时冻结；改参数 = 出队后重新 launch |
| `queued` 进 `NODE_STATUSES` / 账本 / TUI tree | D3 + §4.4：会连带改 `padStatuses`/`validateStatuses`/哨兵/hygiene |
| 队列深度/等待时长进 `/legion doctor` 深度报表 | v1 只要 `LaunchQueueEntry[]` + listener；doctor 报表另开 issue |
| 让 `maxDepth`/`maxSpawns`/memory 排队 | D1：不可满足或资源性闸门，排队只会伪装成延迟 |
| 改 `verify-queue.ts` 或复用它的 listener | F14/D9：那里是轮询式，形态不同 |
| 改 `rpc-supervisor.ts` / `budget.ts` / `nodes.ts` / `args.ts` | 只读消费；账本语义零变化 |
| 修 `idle` 占槽的既有语义（F9） | 那是 #197 的既定计数（`active` 过滤只排除 exited/retired）；改它会让所有既有上限测试与语义变更，属另一 issue |

## 11. 风险与坑（最容易错的 1-3 处加粗）

- **R1（最高）同 tick fanout 的探测失效**：不引入 in-flight 保留位（D2-b），12 路同时探测都会
  看到 0 live → 全部放行 → 回到今天 4 个报错。A1/A21 就是守这条。
- **R2 槽位释放边沿理解错**：`agent_settled → idle` **不释放**槽位（F9），只有 `retired`/`exited` 释放。
  若把 hook 挂在 idle 上，队列会在一轮内放行超过上限（探测说空闲，真闸门说满 → 全变成退回避让，
  表现为准入抖动）。另：账本槽位可被**另一个进程**释放 → 必须有单个 unref 兜底定时器（D2-d/4）。
- **R3 `reserveNode` 自锁（F10）**：任何「先 reservation 再入队」的实现都会让排队项自己占着
  `starting` 行把 fanout 堵死，15 分钟后才超时。入队必须在 `try {` 之前、且探测阶段不 insert。
- **R4 `maxChildrenPerNode: 0`**（F11）：`siblings(0) >= 0` 恒真 → 若当成可排队，所有 launch 排队到超时。
  D11 的硬拒 gate 名必须能断言。
- **R5 两个事件闭集（F13）**：只加进程域两个类型；若误加进 `src/legion/events.ts`，DB 事件游标会因
  `mapEvent` 抛错永久冻结（#233 事故复现）。A13 双向断言。
- **R6 `NODE_STATUSES` 硬编码 6 占位**：`listNodesByStatus`/`listStaleNodes` 的 SQL 写死
  `IN (?, ?, ?, ?, ?, ?)`，`padStatuses` 用 `NODE_STATUSES.length - statuses.length` 补 null，
  `validateStatuses` 文案写死 "one to six"。**任何人后续想把 `queued` 塞进闭集**必须同批改：
  两条 SQL、`padStatuses`、`validateStatuses` 文案、`legion-status.ts:43` 的副本、
  `test/unit/legion-nodes.test.ts`、§11.1 哨兵。本契约禁止这么做（D3）。
- **R7 超时与准入的竞态**：`pumpAdmissions` 正在 `await payload.run()` 时到时 → 不许 reject 正在
  admit 的项（会把已 spawn 的子节点变成无主）。**规则**：`next()` 只对「等待中」的项报 expired；
  admit 中的项在 `run()` 结算后再判（已准入则正常，失败则重入队并受原 `enqueuedAt` 约束）。
  A3 用固定时钟覆盖「恰好到期 + 同时准入」。
- **R8 占位 sessionFile 的消费方**：`collect`/`status`/`resume`（`reviveChild`）/`persistChild`
  都会读它。`collect`/`wait` 走 D8 的等准入；`revive` 必须拒绝 `state==="queued"` 的记录（报
  NET_NOT_FOUND 之外的明确文案）；`persistChild` 在准入后会覆盖。A12/A15 覆盖。
- **R9 进程级注册表**：`globalThis[Symbol.for("pi-legion.launch-admission-queue")]`（jiti
  `moduleCache:false` 会重新求值模块，模块级 Map 会归零 —— 与 D5/REV2-4 同因）；
  测试必须 `resetAdmissionQueuesForTests()`。A17。
- **R10 队列项持有闭包**：闭包捕获 Orchestrator 与 `input`；`flush` 必须在 session shutdown 与
  abort 时执行，否则闭包泄漏到进程结束（内存泄漏 + 幽灵准入）。A5、§7。

## 12. 待父会话确认（契约层面，不是实现细节）

- **O1（D2 字面 vs 需要）**：D2 只允许 supervisor 加 `onSlotReleased`；本契约还需要
  `admissionCounts()` / `preflightAdmission()` 两个**只读**成员，否则必须在 Orchestrator 复制
  `assertWithinLimits` 的过滤与四条文案（与 D1-a 冲突）。**建议追认**（仍无 supervisor 内排队）。
- **O2（命名冲突）**：D6 倾向中性名 `launchQueue.maxPending`，D10 冻结 `inprocess.maxQueuedLaunches`。
  本契约按 **D10 落设置键**、`maxPending` 仅作内部字段（D6-a）。请确认。
- **O3（D3 措辞）**：D3 说「只留内存记录」，但 `index.ts` 的 `launchStep` 必然把 handle.child 写进
  run.json，且跨进程 `status` 也要求它落盘。本契约按「**落 run.json + 不落账本/不建 session**」
  执行（D3-a），请确认这不会被视为放宽 D3。
- **O4（新增 dep）**：D9 的「准入后再补一行」需要一个通知通道；本契约新增
  `OrchestratorDeps.onLaunchQueueNotice` + `pi.sendMessage` 接线（不是新事件类型）。

> O1–O4 的裁决见 §13（FROZEN 2026-10-23）：O1/O3/O4 全部**追认**，O2 按 D10 落键。§13 与正文冲突时以 §13 为准。

---

## 13. 父会话裁决（FROZEN 2026-10-23，closed O1–O4 + 2 处精确化）

本节与正文同等效力；冲突时**以本节为准**（本节是正文的部分修订，不是补充建议）。

### 13.1 O1 — **追认**：supervisor 允许两个只读成员 + 一个回调

`InProcessSupervisor` 可以新增 `admissionCounts(name)`、`preflightAdmission(name)`（均为只读、绝不抛、绝不改状态）与 `onSlotReleased` 回调。**仍然禁止** supervisor 内排队/持有队列/持有定时器 —— D2 的 single choke point 不变。

理由：不追认则必须在 Orchestrator 里复制 `assertWithinLimits` 的 `parentKey` 过滤 + 四条用户可见文案（F5/D1-a），两份实现必然漂移，而文案已被 `test/unit/inprocess-supervisor.test.ts` 与 #197 用户反馈锁死。D2 原文的「只加槽位释放回调」是**意图描述**（不要在 supervisor 里做调度），不是对只读探测的禁令。

**新增不变量（I-O1）**：`preflightAdmission` 是**咨询性**的。它的「通过」不授权 spawn，最终权威仍是 `assertWithinLimits` / `withLaunchBudget`。任何实现若让探测取代真闸门（例如探测通过就跳过 `assertWithinLimits`）即违约 —— D2-b/D2-c 的 in-flight 保留位 + 重入队正是为此存在。

### 13.2 O2 — **裁定**：设置键用 D10 的名字，`maxPending` 只作内部字段

- 用户可见：`subagents.inprocess.maxQueuedLaunches`（默认 32）、`subagents.inprocess.launchQueueTimeoutMs`（默认 900000），必须进 `docs/inprocess-supervisor.md` 的 Limit keys 表与 §11.1 哨兵。
- 内部：`AdmissionQueueOptions.maxPending` / `AdmissionQueue.maxPending`。
- **禁止**新增 `launchQueue.*` 顶层设置命名空间（v1 只有一个桶，避免以后 inprocess/rpc 分裂配置）。

### 13.3 O3 — **追认 + 收紧**：`queued` 落 run.json，但必须「三不建」

**允许**：父 run.json 一条 `ChildRecord{state:"queued"}`、`launch_queued` 进程事件、`sessionFile` 占位字符串（不建文件）。
**禁止（A3/A15 逐条断言）**：账本 `nodes` 行、child run 目录/`run.json`、worktree 目录、`<name>.jsonl` 实体文件。

D3 原文「只留内存记录」作废，以本裁定为准。跨进程 `status` 必须能显示排队项（D9），所以必须落 run.json。

#### 13.3.1 **新增强制项（I-O3）：`restore()` 对 queued 记录的处理**

进程重启后 run.json 里的 `queued` 记录是**孤儿**（队列在内存里，已随进程消失）。`Orchestrator.restore()` 必须照旧把它们放进 `this.children`（否则 `subagent({action:"stop",name})` 的重建路径 `orchestrator.restore(found.run)` → `retire(name)` 会撞 `requireChild` 抛 `NOT_FOUND`，用户看到的是 unknown child 而不是真实原因），但 `collect` / `steer` / `continue` / `resume` 命中 `state === "queued"` 且**本进程队列里没有该名字**时必须给出专属文案：

```
child '<name>' never started: the launch queue was lost when the previous process exited; re-dispatch it (or relaunch) instead
```

`retire()` 例外：允许把这种孤儿直接标 `retired` + `retiredAt`（清理语义），不需要先 spawn。
**新增验收 A23**：构造 run.json 含 `state:"queued"` 的孤立记录 → `restore()` 后 `collect`/`steer` 返回上述文案而非 `NOT_FOUND`；`retire()` 成功且记录变 `retired`；`nodes` 表全程无该行。

### 13.4 O4 — **追认**：`OrchestratorDeps.onLaunchQueueNotice?: (line: string) => void`

不是新事件类型（D12 仍然只有两个进程级事件）。`index.ts` 接线到 `pi.sendMessage`（root UI 另接 status pill）。`async:false` 时同一行也进 tool result（D8/D20）。

### 13.5 精确化 1 — F9 确认：`idle` **占槽**，只有 `retired`/`exited` 释放

契约正文已按此写（F9 / R2 / A19）。**明确禁止**把 `onSlotReleased` 挂在 `updateTurnState` 的 `idle` 分支（`inprocess-supervisor.ts:1318`）。若挂错，表现是准入抖动（探测说空、真闸门说满、项被 D2-c 重入队），A19 就是守这条。

**已知后果（写进文档，不在本 issue 修）**：`idle` 子节点仍占 fanout 槽位，直到父 agent collect 后 recycle（`index.ts:1641` / `runtime.ts:1405-1416`）。这属 #197 的既定计数语义（F5 的 `active` 过滤只排除 `exited`/`retired`），改它会连带改所有既有上限测试 —— 单开 issue。

### 13.6 精确化 2 — **追认**：进程级注册表（同父 run 共享一个队列）

`globalThis[Symbol.for("pi-legion.launch-admission-queue")]`，键为父 run 的 `runDir`（不是 cwd，也不是 process.cwd()）。理由：`jiti` 的 `moduleCache:false` 会让模块级 Map 归零（与 `spawn-default-inprocess-v3` D5/REV2-4 同因），而 `index.ts` 有 5 处 `new Orchestrator`（F17），`stop` 的重建路径必须能定位到原来那个队列。

**新增限制（I-O6）**：注册表键必须包含 `process.pid`，避免同一 `runDir` 被子进程/多 session 误共享（in-process 子节点共享 process，但 rpc 子节点不）。测试必须 `resetAdmissionQueuesForTests()`（A17）。

### 13.7 补充禁令（正文未覆盖，合并前必查）

1. **禁止**在 `admission-queue.ts` 里 `import fs` / `import path` / 起 timer / 读 `process.env`（纯模块，A17 用 lint-by-reading 或测试断言）。
2. **禁止**为了让 `status` 好看而在 `index.ts` 里把 `queued` 映射成 `working`/`launching`（D9 要求 `state=queued` 字面出现）。
3. **禁止**改 `src/legion/budget.ts` / `src/legion/nodes.ts` / `src/legion/events.ts` / `src/supervisor/rpc-supervisor.ts` / `src/runs/verify-queue.ts`。
4. **禁止**用 `setTimeout` 直接 reject 正在 admit 的项（R7）；超时只在 `queue.next()` 这一处判定。
5. **禁止**让 `launch()` 的快路径（槽位可用）多出任何 `await`（D2-b/R1/A21）。

### 13.8 裁决后的 D/A 增量一览

| 增量 | 内容 |
|---|---|
| I-O1 | 探测是咨询性的，不得取代真闸门 |
| I-O3 | `restore()` 保留 queued 记录；`collect`/`steer`/`continue` 给"queue lost"专属文案；`retire` 允许直接标 retired |
| I-O6 | 注册表键含 `process.pid` |
| **A23** | 进程重启后孤儿 queued 记录的三种行为（文案 / retire / 无账本行） |
| §13.7 | 5 条合并前必查禁令 |
