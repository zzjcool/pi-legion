# 冻结契约：非阻塞 spawn / 中断不丢结果 / 死子不空等（#227）

日期：2026-10-19 ｜ 状态：frozen（唯一接口；worker 不得自行解释矛盾，发现矛盾上报修订）
依据：issue #227；HEAD `c97cd27`；spawnMode 缺省 inprocess；`docs/contracts/esc-no-retire-v3.md`（仍在生效）

## 0. 已确认事实（worker 直接引用，禁止重新侦察）

| # | 事实 | 证据 |
|---|---|---|
| F1 | `InProcessSupervisor.spawnChild` 在 `await session.prompt(...)` 上阻塞到**整轮** agent run 结束 | `src/supervisor/inprocess-supervisor.ts:649`；SDK `agent-session.js:1380-1413`（`_runAgentPrompt` 才 resolve） |
| F2 | `RpcSupervisor.spawnChild` 只等到 prompt **被受理**（`preflightResult` → disposition），不跑完 | `rpc-client.js:135-138`、`rpc-mode.js:299-316` |
| F3 | `Orchestrator.launch` 在 `spawnChild` 返回**之后**才写 `node_launched` / `recordChild` | `src/runs/orchestrator.ts:765`、`:799`、`:904` |
| F4 | vexillatio 的 abort 早退丢掉了已收集结果，且 details 是 `{}` | `index.ts:2416`、`index.ts:3206-3208`（`ok()` 的 details 恒为 `{}`） |
| F5 | `interruptedCollect` 恒返回 `status:"running"` + `reason:"aborted by parent"` | `src/runs/orchestrator.ts:1064-1071` |
| F6 | `collect()` 的 deadline 从**本次调用**起算 | `src/runs/orchestrator.ts:980` |
| F7 | 会话文件里 user 行先于 `agent_start` 落盘 | `agent-session.js:1601`(appendMessage) → `:1630`(preflight) → `:1631`(`_runAgentPrompt`) |
| F8 | `event.type === "error"`（`pi-ai` `lazyStream` 写入的 `stopReason:"error"` 记录）**今天被 inprocess supervisor 直接丢弃** | `inprocess-supervisor.ts:1005`（`turn_end|agent_end` 只吃 `event.message`）、`:1038`（`COARSE_EVENT_TYPES` 无 `error`） |
| F9 | `FakeSupervisor.spawnChild` 是同步返回的（无 `await prompt`） | `test/helpers/fake-supervisor.ts:139-190` |
| F10 | `test/unit/inprocess-supervisor.test.ts` 的 `FakeSession.prompt` 也是非阻塞语义 | 同文件 `:42-47` |
| F11 | 门禁基线：`npm run typecheck` / `npm test`(1113) / `npm run test:integration`(81) 在 HEAD 全绿，各约 33s | 实测 |
| F12 | `spawnedAt` 在 spawn 前后共写 2 次（`persistParentReservation` 与 `recordChild`/`previous`） | `orchestrator.ts:429/444`、`:777`、`:904` |

## 1. 决策（D 编号，reviewer 必读）

**D1 — inprocess `spawnChild` 改为「受理即返回 + 后台 drain」。**
`session.prompt(...)` 不再 `await` 到整轮结束。`spawnChild` 在下面两个条件**任一**成立时返回 `ChildHandle`：
- (a) 会话文件已出现属于**本轮**的 user 行（`F7`：prompt 已被受理并落盘）；或
- (b) 时钟推进到 `spawnStartTimeoutMs`（默认 `DEFAULT_INPROCESS_SPAWN_START_TIMEOUT_MS = 15_000`）兜底。

判定实现细则（冻结）：
- 拉起点 = `spawnChild` 调用时刻的 `statSync(sessionFile).size`（文件不存在记为 0）。
- 出现 user 行 = `parseSessionFile(file).turns.length > 0 && fileSize > baseline`。**不得**用 `isLastTurnComplete`（`F7` 已经证明 prompt resolve 时末轮为「有 user、无 assistant」，用它是自相矛盾的门）。
- 轮询间隔复用 `POLL_INTERVAL_MS = 500` 的既有 cadence。**勘误（见 §7 v1.1）**：该常量实际是 `src/runs/orchestrator.ts:143` 的 module-private 常量，从未存在于 `src/shared/types.ts`；Worker A 在 `src/supervisor/spawn-mode.ts` 导出同名同值常量（与 `DEFAULT_INPROCESS_*` 并列），inprocess-supervisor 从那里 import，**不要**去改 `orchestrator.ts`。
- 兜底超时**不是错误**：到点照常返回 handle（会话已创建即持久化了 transcript），只是记录 `onSpawnDelayed` 一次（`InProcessSupervisorOptions` 新增可选回调，用于诊断；无默认实现）。

**D2 — 后台 drain 必须保住 ALS 身份/深度与错误可见性（最大风险点）。**
- 复用现有的 `runAtInProcessChildDepthAsync(...)` + `runInChildContext(registration.context, ...)` 作用域，把「settle 之后的收尾」放进去；`beginTurn` 保持在 prompt 之前（现状即是）。
- **事件会脱出 ALS 作用域**：`agent_start` 在 `await session.prompt()` 之前同步 emit（`agent-session.js:1601→1631`），但 `agent_settled` 在 `_runAgentPrompt` 的 `finally` 里 emit，那时已在 drain 的后续微任务链上。因此 `updateTurnState` 里做 settle 状态流转时**不得依赖** `currentChildContext()`；`publishEvent` 已有 `runOutsideChildContext`（REV2-7），不要动。
- drain 的 `catch`：**不得**调用 `rollbackSpawn`（会 `children.delete` 把已返回的 handle 抹掉）。必须：`turnActive=false`、`state="idle"`、`lastTurnResult={settled:false,abnormal:false,reason:"child turn failed: <msg>"}`、`resolveWaiters(...)`，并把 `<msg>` 交给 `onSpawnRefused`（该回调语义扩为「child 运行期失败诊断」，文档同步）。
- drain 的 `finally` 必须落一件机器事实：把 prompt reject 的**异常**写成一条 `event.type === "error"` 的事件送进 `handleSessionEvent`，好让 D3/D3b 的映射生效（见 D3b）。

**D3 — `error` 事件要能进 settle 判定（缺陷 3 的 inprocess 半边）。**
`updateTurnState` 增加分支：`event.type === "error"` → 记 `child.pendingFailure = <error.message 或 error 的字符串化>`。当随后的 `agent_settled` 到达时，若 `lastTurnResult` 会判成 `aborted:false` 而 `pendingFailure` 非空，则用 `F8` 已存在的事件把它变成可见事实（不得凭空造 stopReason）。

**D3b — 中断被写成 `stopReason:"error"` 的读法修正（本仓半边）。**
`src/shared/session.ts` 的 `deriveOutcome`：当 `stopReason === "error"` 且 `errorMessage` 同时匹配「abort 语义」与「**无 reason 的 AbortController**」时，`reason` 必须给出可判别文案，禁止再与真正的 provider 失败同形。冻结文案：
- 现有 `/abort/i` 分支保持（`"This operation was aborted"` 已命中，`test/unit/session.test.ts:59-63` 锁死，**不得改动该断言**）。
- 新增：当 `errorMessage` 匹配 `/^(this operation was aborted|the operation was aborted|operation aborted)$/i` 且**不含** `timeout` 时，`reason` 置为 `ABORT_WITHOUT_REASON`（新增导出常量，值 `"parent turn ended (abort signal without a reason)"`）。`status` 仍为 `aborted`（不变），只改 `reason` 的可读性。
- 目的：让 issue #227 里「`stopReason:"error"` 被读成 provider 失败」的分析不再成立，同时不改任何 `status` 语义（避免回归 `deriveOutcome` 的既有 511 处断言面）。上游 `pi-ai` 的 `createSetupErrorMessage` 不在本仓，**不在本契约范围**（见 §5）。

**D4 — vexillatio 中断不丢结果。**
`index.ts:2416` 与 execute 层 `index.ts:743-745` 都不得丢弃已算出的结果。冻结返回形状：

```ts
// 文本：interrupted 头行 + 已收集的每一段（顺序 = handles 顺序）
`interrupted (parent turn ended; children still running)\n\n${results.join("\n\n")}`
// details
{ runId, handles: [...{name, agent, sessionFile}], async: false, interrupted: true,
  ...(stillRunning.length ? { stillRunning: string[] } : {}) }
```

- 头行**必须**保持冻结文案 `interrupted (parent turn ended; children still running)`（`esc-no-retire-v3.md:22`），因为 `test/unit/teams.test.ts:1298` 用 `/interrupted \(parent turn ended; children still running\)/` 匹配——把结果段追加在头行之后不破坏该正则。
- `ok()` 新增可选 `details` 参数（`ok(text, details?)`，缺省仍是 `{}`），**不要**引入 `isError`（`pi-agent-core` 的 `AgentToolResult` 虽有该字段，但本仓 511 处断言与 TUI 渲染均按「无 isError」编写，改它属于越界）。
- launch 失败行（`✗ <agent>: <error>`，`index.ts:2364`）**也**必须在中断时返回（现在是先早退、后 push，一并丢）。
- 真机上 `collect` 内的 `interruptedCollect` 会给 `status:"running"`：渲染时照旧打印 `execution: running (aborted by parent)`，**不要**把它改写成 success（`F5` + `orchestrator.test.ts:153-168` 锁死）。

**D5 — 死子 / 早退子不得空等到 collect deadline（缺陷 1 的收尾）。**
`Orchestrator.collect`：当 `initial` 里**本轮**已有终态 assistant（`isLastTurnComplete(initial) === true`）却因 `liveConnectionBlip` 走进 `awaitSupervisor` 的路径之外——**新增**：若 `wait === "timeout"` 且 `!this.supervisor.isAlive(name)` 且 `isLastTurnComplete(parsed)`，直接按已完成的 turn 收尾（走现有 `deriveOutcome` + `finishCollect`），不得再套 `COLLECT_DEADLINE_REASON`。现有 `collectArtifactGrowing` 的 grace 循环保持不动。

**D6 — `collect` 的 deadline 不因本轮非阻塞 launch 而变（显式不做）。**
`F6` 标明 deadline 从 collect 调用起算；issue 建议「timeoutMs 覆盖 launch」是**另一件事**，本契约**不改** deadline 起点，只删掉 `COLLECT_DEADLINE_REASON` 注释里那句与实现不符的「budget from launch」（`orchestrator.ts:1007`）。理由：改起点会让 `runtime` 的 re-arm watch 预算翻倍（`runtime.ts:1017-1032`），属于 #227 之外的语义变更。

**D7 — notify 的 `batch N` 文案（显式不做）。**
`notify.ts:351` 的 `batch ${entries.length}` 只是 TUI 折叠行的可读摘要（`notice-renderer.ts:69`），不是机器事实，且没有测试断言它。issue 把它列为「顺带观察」，本契约**不修改**，只在 §6 记为已知表述。

## 2. 文件所有权（两 worker 并行，零共享文件）

### Worker A（`spawn` 非阻塞 + drain + error 事件）

| 文件 | 动作 |
|---|---|
| `src/supervisor/inprocess-supervisor.ts` | D1 / D2 / D3 |
| `src/supervisor/spawn-mode.ts` | 新增导出常量 `DEFAULT_INPROCESS_SPAWN_START_TIMEOUT_MS = 15_000` 与勘误后的 `POLL_INTERVAL_MS = 500`（均与 `DEFAULT_INPROCESS_MAX_ACTIVE` 并列） |
| `src/api.ts` | 若导出面需要（`InProcessSupervisorOptions` 已导出）；仅在新增类型被外部引用时改 |
| `docs/inprocess-supervisor.md` | 改写 `spawnChild awaits the whole first agent run` 那段（现 `:130-137`），改为新语义；同步 `runtime.ts:1478-1482` 注释所指事实变化（**只改文档**，`runtime.ts` 属 Worker B 边界外、也不改） |
| `test/unit/inprocess-supervisor.test.ts` | 新增 D1/D2/D3 用例；**必须保住**既有 `child context is active during the first prompt`(`:569`) 与 `maxDepth holds across generations driven from the root chain (REV2-1)`(`:700`) 与 `onEvent listeners run at root identity`(`:1071`) 三条 |

### Worker B（中断不丢结果 + collect 收尾）

| 文件 | 动作 |
|---|---|
| `index.ts` | D4（`ok()` 可选 details、`launchUtilityFamily` 返回、execute 两层早退） |
| `src/runs/orchestrator.ts` | D5、D6 的注释修正 |
| `src/shared/session.ts` | D3b（`ABORT_WITHOUT_REASON` + `deriveOutcome` 新分支） |
| `test/unit/session.test.ts` | D3b 新用例（**不得改动** `:59-63` 既有断言） |
| `test/unit/teams.test.ts` | D4 用例：abort 时 vexillatio 返回已收集结果 + details 带 `interrupted`/`stillRunning`/`runId`（既有 `:1254` 用例的断言不得删减） |
| `test/integration/orchestrator.test.ts` | D5 用例（死子不空等）；`:153` 既有断言不得改动 |
| `docs/vexillatio-contract.md` | §2.2 步骤 3 补一句中断返回语义（append-only 修订记录 REV-17.9） |

**共享文件：无。** 两 worker 各在自己的 worktree，冲突面为零；`test/unit/inprocess-supervisor.test.ts` 只属 A，`test/unit/teams.test.ts` 只属 B。

## 3. 验收（机器可检查，父会话在 collect 时执行）

每个 worker 的 `verify`：
```
npm run typecheck
npm test
npm run test:integration
```
首个非零退出即 rejected。另需人工核对的断言锚点（reviewer 用）：

1. 新增 inprocess 用例：用一个**故意永不 resolve** 的 `prompt()`（模拟 8~18 分钟的子轮），断言 `spawnChild` 在 `spawnStartTimeoutMs` 量级内返回（用注入的短超时，如 50ms，不真等 15s）。
2. 新增 inprocess 用例：`prompt()` 拒 + 只有 `agent_start` 时——`spawnChild` 仍返回 handle 且 `children.has(name) === true`（**不得**被 rollback 删号）；随后 `waitSettled` 能拿到 `reason` 含 `child turn failed`。
3. 新增 inprocess 用例：`onEvent` 仍收到 `agent_start` / `agent_settled`（后台 drain 不丢事件）。
4. 新增 teams 用例：abort 后 vexillatio 文本同时含冻结头行**和** `── <name> ──` / `execution:` / 子结果正文；`details.interrupted === true`；`details.handles.length > 0`；`details.runId` 非空；child 未被 retire。
5. 新增 orchestrator 用例：子进程已死且本轮已有终态 assistant → `collect` 不返回 `COLLECT_DEADLINE_REASON`。
6. 新增 session 用例：`stopReason:"error"` + `"This operation was aborted"` → `reason === ABORT_WITHOUT_REASON`；`+ "The operation was aborted due to timeout"` → 仍是 timeout 语义（不得被新分支吞掉）。
7. 既有绿线不回退：`inprocess-supervisor.test.ts` 33 例、`teams.test.ts`、`orchestrator.test.ts` 25 例、`session.test.ts` 全部。

## 4. 明确不做（reviewer 判「缺失」前先读本节）

| 不做 | 理由 |
|---|---|
| 改 `collect()` 的 deadline 起点为 launch 时刻 | D6：会翻倍 runtime re-arm 预算，属 #227 之外的语义变更 |
| 给 inprocess 加 `preflightResult`（SDK 有该选项） | D1 用会话文件判定，**不扩 `InProcessSession` 窄接口**：该接口是所有测试 fake 的契约面（`inprocess-supervisor.test.ts:29`），扩参数会让 20 个 fake 全部要改且没有一处需要它 |
| 改 `notify.ts` 的 `batch N` 文案 | D7：TUI 摘要，非机器事实，无断言 |
| 引入 `isError` | D4：`AgentToolResult` 有该字段，但本仓渲染链/TUI/511 处断言按「无 isError」工作，改它属越界 |
| 上游 `pi-ai` 的 `createSetupErrorMessage` | 不在本仓（issue 也建议单独 file） |
| RPC 侧 `spawnChild` 的 `await client.prompt` | `F2` 已经是非阻塞；**不改** |
| `previous.spawnedAt` 的 resume 重写 | `F12` 是既有语义（resume 重置计时），与 #227 无关 |
| `test/unit/legion-integration.test.ts:1595` 那条「因为 spawnChild 阻塞所以直读 sessionFile」的测试 | 断言本身仍成立（台账节点仍可无 job 而直读文件），**不改**；`runtime.ts` 的 `statusEntryFromNode` 注释由 Worker A 在文档层说明，代码不动 |

## 5. 风险与回滚

- **R1（最高）**：`F1` 的阻塞是 `child context is active during the first prompt` 与 REV2-1 深度测试的**隐式前提**（ALS 只在被 await 的链上存活）。改为非阻塞后，首轮 turn 的 tool 执行若脱出 ALS，这两个测试会红。D2 要求把 drain 挂在原作用域内；若测试仍红，**停下来上报**，不要改测试断言。
- **R2**：`agent_settled` 在 `_runAgentPrompt` 的 `finally` 里 emit，可能晚于 drain 的 resolve；`beginTurn` 与 `lastTurnResult` 的时序必须保持「先清后置」，否则 `waitSettled` 会立刻拿到陈旧结果。
- **R3**：`rollbackSpawn` 在新语义下不能用于「drain 失败」（会删号），见 D2。
- **R4**：vexillatio 中断返回文本变长，`display`/preview 上限（`PREVIEW_CHARS=4000`）在 notify 侧，不在 tool result 侧；tool result 不截断（`index.ts:2400` 现状即不截断）。
- 回滚点：两 PR 独立，可分别 `git revert`；D3b 是纯 reason 文案，回滚无副作用。

## 6. 已知但不在本次范围

- 上游 `pi-ai` 把 abort 写成 `stopReason:"error"`（issue 缺陷 3 的根因）——建议单独 file 给 `pi-ai`，本契约只做本仓可判别的 reason（D3b）。
- `notify` 的 `batch N` 表述（D7）。
- `subagent` 工具（非 vexillatio）的中断路径已保留 `runId`（`index.ts:1751-1754`），本次不动。

## 7. 修订记录

| 日期 | 版本 | 修订 | 原因 |
|---|---|---|---|
| 2026-10-19 | v1 | 首次冻结 | #227 三缺陷拆分：D1/D2/D3(A)、D4/D3b/D5(B)；D6/D7 显式排除 |
| 2026-10-19 | v1.1 | 勘误 §1 D1 轮询常量位置：`src/shared/types.ts` → 实为 `src/runs/orchestrator.ts:143` 私有常量，改由 `src/supervisor/spawn-mode.ts` 导出同值常量；§2 Worker A 文件表同步 | Worker A 指出契约原文事实错误；`grep` 确认 `POLL_INTERVAL_MS` 从未在 `src/shared/types.ts` 出现过。属笔误型而非设计型矛盾，advisor 裁决按勘误继续（不回退重派），父会话在此落库 |
