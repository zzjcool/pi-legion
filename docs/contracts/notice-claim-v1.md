# 完成通知去重：claim-once（v1，冻结）

## 背景

同一个 child 的终态结果有两条路到达父 agent：

1. **工具结果**：`wait` / `collect` 返回 `renderCollect` 文本。
2. **主动通知**：watch 终态 → `join.onTerminal` → `deliverCompletion`（`subagent-notify`）。

现有去重只有两个内存位 `TrackedJob.consumedByTool` / `TrackedJob.notified`，并且**只在 watch 跑到终态的那一刻判断一次**（`runtime.ts` 的 `!job.consumedByTool && !job.notified` 闸门）。判完之后，通知还要穿过两层缓冲才真正落地：

- `JoinCoordinator.group.buffered`（10s 窗口 / 同组 pending 清空才 flush）
- `runtime.outbox`（父 run 活跃时入队，`agent_settled` 或 80s 上限才 flush，且**没有按 name 撤销的 API**）

于是产生四个重复窗口：

| # | 场景 | 结果 |
|---|---|---|
| W1 | 兄弟未完成 → 条目已在 `join.buffered` → 父 `wait` 拿到结果 → 窗口到期 flush | 同一份 output 再提一次 |
| W2 | 父 run 活跃 → 通知进 `outbox` → 本 turn 内 `wait` 拿到结果 → `agent_settled` flush | 再提一次 |
| W3 | `waitOne` 终态 `release(name)` → `join.remove` 只删 `pending`，**不删 `buffered`** | 孤儿缓冲条目照发 |
| W4 | 两个标记都挂在 `job` 上，`release` 删 job 即蒸发 | flush 时无从判断 |

根因：**去重状态挂在会被删除的 job 上，而待发文本在另外两层缓冲里，不知道标记存在。**

## 冻结决定

### D1 — 单一标记，key 为 `(runId, name)`，寿命长于 job

`createSessionRuntime` 闭包内维护 `reported: Set<string>`，key = `${runId}\u0000${name}`。不放在 `TrackedJob` 上（job 会被 `release` 删除）。不进 run.json / legion.db（不改 schema，不改跨进程语义）。

**修订（D10）**：key 追加轮次 → `${runId}\u0000${name}\u0000${round}`。原因：`runId` 是父 run id，同名 child 的多轮共用同一个 runId，两段键分不清旧轮与新轮（旧轮未读副本会抢在新轮前并把它过滤掉）。D10 取代本节的两段键形状，其余约束不变。

### D2 — claim 语义：谁先把结果交到父 agent，谁置位

- `claim(runId, name): boolean` —— 首次返回 `true` 并置位；已存在返回 `false`。（修订：实际实现改为 `void`，无调用方需要该返回值。）
- 置位点（**只有"真实交付"三处**）：
  1. `waitOne` 拿到终态 snapshot、确定要返回它时（在 `retire` 的 await **之前**，避免 retire 期间的 flush 抢跑）。
  2. `collectChild` 拿到终态 snapshot 并确定返回 `renderCollect` 时。
  3. 通知**发送成功**之后（`deliverCompletion` 返回 `true`）。
- **不存在 unclaim 路径**：超时 / interrupted / stillRunning 都不需要撤销，因为它们从未 claim。

### D3 — 通知路径在投递前最后一刻查 claim

通知被过滤 = 该 `(runId,name)` 已 claim。过滤必须发生在 **join flush 与 outbox flush 两条路径都经过的唯一出口**，不能停留在 `onTerminal` 时刻。

### D4 — outbox 存结构，不存格式化文本

`QueuedNotice` 改为持有 `entries`（含 `runId/name/status/input`）、`triggerTurn`、`partial`、`enqueuedAt`。flush 时重新走"过滤 → 格式化 → 投递"。这样 grouped notice 里被 `wait` 领走的成员会从文本中消失，header 的 `N of M` 与 `Still running` 自动正确。

### D5 — 单一投递出口 `deliverBatch`

`deliverBatch(entries, triggerTurn, partial)` 是唯一实现：

1. `entries.filter(e => !isClaimed(e.runId, e.name))`
2. 空 → 直接返回（**这就是"读过就不再提"**）
3. 单条 → `formatCompletionNotice`；多条 → `formatGroupedNotice`（`stillRunning` 在投递时实时重算）
4. 立即发送或入 outbox；`deliverCompletion` 返回 `false`（宿主拒绝）→ **不 claim**，允许后续补救

`join` 的 `deliver` sink 与 `flushOutbox` 都只调它。单 child、未被 claim 的通知文本必须与现状**逐字节一致**（保留 `Background task …` 旧形状；`partial` 由入队时刻的 `join.allSettled()` 决定并随条目保存，避免 flush 时语义漂移）。

### D6 — 工具结果永不被抑制

`wait` / `collect` 是父 agent 的显式请求，任何情况下都返回完整 `renderWait` / `renderCollect`。"先通知后 collect" 允许（父仍拿到完整结果），只是**不再产生第二条通知**。

### D7 — claim 的复活规则

**凡是把 `notified` 复位为 `false` 的地方，必须同时撤销该 `(runId,name)` 的 claim；撤销必须是「解 claim + 清掉所有尚未落地的副本」的原子操作**：

```ts
unclaimReported(runId, name):
  reported.delete(key)
  dropQueued(runId, name)      // outbox 条目内过滤掉该 key；条目变空则连同队伍一起删，并重臂/取消 timer
  join.dropBuffered(runId, name)
```

只解 claim 不清副本 = 已读结果的旧通知被「复活」后重发（实测复现）。

复位点：

- `track()`（新 job 分支与 existing 分支都算新一轮）
- `watch()` 的 blocked-resume 分支
- transient connection rearm
- `rewatch()`（父显式要求再报一次）
- `dispose()`（整体清空）

**修订（实现期裁决）**：`track()` 的 **existing** 分支基线从不复位 `notified`，故不属于强制 unclaim 点；在那里 unclaim 是空操作且会抹掉「已交付」证据。是否 unclaim 以 `notified` 是否复位为准，不以 `track()` 命名为准。

### D7b — 缓存（`finished`）的生命周期 = 一轮

`finished` 按 name 缓存终态快照，而下级 runId 是**父 run id**（同一父 run 下同名 child 的每一轮共用同一个 runId）。若 `track()` 不失效缓存：

1. 新一轮 collect 抛错时缓存里仍是上一轮的 snapshot，`wait`/`collect` 会把**过期成功**交给父 agent（既有缺陷）；
2. 这一命中还会 claim `${runId}\u0000${name}` —— 正是**本轮失败通知**的键，于是失败通知被永久吞掉（claim-once 引入的回退）。

所以：**`track()` 的两个分支都必须 `finished.delete(name)`**。W2 链路（完成 → release → 父 `wait` 命中缓存）中间没有 `track()`，不受影响。缓存快照写入时必须带上**发起时刻**的 `job.runId`（不是 resolve 时刻），否则同名换 runId 的重跟会写下错配。


### D8 — `join` 增加 `dropBuffered(runId, name)`

现状 `remove(name)` 只清 `pending`（`join.ts` 的 `remove`），buffered 条目成为孤儿（W3）。新增 `dropBuffered` 清除该 name 的 buffered 条目，`remove()` 的其它语义不变。

**修订（实现期裁决，2026-xx）**：`release()` 中调用 `dropBuffered` 必须**以 claim 为前置条件**（`if (isReported(runId, name))`）。理由：正常 watch 收尾也是「终态 child 先 release、批次后 flush」，buffered 条目是那条通知的唯一载体；无条件丢弃会把每条 grouped 通知静默吞掉（实测 4 条既有用例变红）。W3 的本质是「claim 之后的 release 留下死重」，所以 gate 在 claim 上既消除孤儿、又不碰未上报路径。

### D10 — claim 键必须含「轮次」，不能只是 `(runId, name)`

`runId` 是**父 run id**，同名 child 的多轮（steer / continue / resume）共用一个 `runId`。若键只有 `(runId,name)`：

- 两轮各有未读通知排队时，FIFO 先投递旧轮 → claim 该键 → **新轮的通知被过滤**，父 agent 拿到旧结果、永远看不到新结果（观测到的反转）；
- 反之若在 `track()` 无条件丢弃旧轮未读副本，则「未读即丢」。

两种都是损失。正确模型：**一份轮次对应一份可交付结果**。

- `TrackedJob` 增加 `round: number`，由 `track()` 从一个 **per-name 单调计数器** 取值（不回绕到 1，避免新旧轮键碰撞）。
- claim 键 = `${runId}\u0000${name}\u0000${round}`。
- `finished` 缓存连同 `{runId, round, snapshot}` 一起存，缓存命中 claim 快照自己的轮次。
- 通知条目（`DeliverableEntry`）携带产生它的 `round`，join/outbox 全程透传。
- `unclaim` 仍按 `(runId, name)` 范围清理（重启该名字的所有副本），但只在该名字**当前轮**确实有 claim 时执行。

效果：同一轮重复交付仍只得一条；不同轮各自可交付（不丢新结果、不被旧结果顶掉）。

## 验收清单

新增单测（`test/unit/runtime.test.ts`，必要处补 `test/unit/join.test.ts`）：

1. **W1**：两个 child；a 完成（b pending，条目进 buffered）→ `wait(["a"])` → 窗口到期 → 只发 b 的通知，a 不出现。
2. **W2**：`notifyParentRunStart()` → child 完成（进 outbox）→ `wait` 拿到结果 → `notifyParentSettled()` → **零**消息。
3. **反向顺序**：通知先发 → 再 `collect` → 仍返回完整结果，且总消息数仍为 1。
4. **timeout 不误伤**：`wait` 超时（`stillRunning`）→ child 后续 settle 仍正常通知。
5. **复活**：通知发出后 `rewatch` → 第二轮完成 → 允许第二条通知。
6. **grouped flush 重算**：a、b 同组进 outbox → `wait(a)` → flush → 文本只含 b，header 不含 a，`N of 1` 形态正确。

补充硬要求（复审追加）：

7. 每条「断言零消息」的用例必须有**正向控制**（同批一个未 claim 的兄弟必须送达，用 `waitFor` 等它），否则成了空转通过。
8. 生产 collect 缝是 `consumeCollectInterruptible`（tool execute 必带 signal），它的 claim 点必须有对应用例。
9. 一轮内出现第二轮（同名同 runId）时：第二轮失败通知不得被上一轮的缓存命中吞掉。
10. 同名同 runId 的两轮各有未读通知 → 两条都送达（FIFO，不丢新轮）；第一轮已读 → 只发第二轮一条。

全部既有 unit 测试必须保持绿色（`npm test`），`npm run typecheck` 干净。
