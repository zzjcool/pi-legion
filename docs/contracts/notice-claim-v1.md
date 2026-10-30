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

- `claim(runId, name): boolean` —— 首次返回 `true` 并置位；已存在返回 `false`。（修订：实现期一度改为 `void`，因为没有调用方要这个返回值；**#320 修订撤销该改动** —— `claimReported` 重新返回 `boolean`，`collect` 缝要用它区分「本次调用取得的 claim」与「别人已经取得的 claim」，见下方 #320 修订。）
- 置位点（**只有"真实交付"三处**）：
  1. `waitOne` 拿到终态 snapshot、确定要返回它时（在 `retire` 的 await **之前**，避免 retire 期间的 flush 抢跑）。
  2. `collectChild` 拿到终态 snapshot 并确定返回 `renderCollect` 时。
  3. 通知**发送成功**之后（`deliverCompletion` 返回 `true`）。
- **投递侧没有 unclaim 路径**：超时 / interrupted / stillRunning 都不需要撤销，因为它们从未 claim。

**修订（复审 minor 4，2026-xx）**：上面「三处都是真实交付」在 `collect` 那条上并不严格成立 —— claim 发生在运行时缝里（`consumeCollectInterruptible` 把 snapshot 交出去的那一刻），而**调用方仍可能反悔**：`collectChild` 在 `await pending` 之后还会检查 `signal?.aborted`（父 turn 被 Esc 掉），`persistChild` 抛错则走 `fail("collect failed: …")`。两条路径都没有把文本交给父 agent。裁决：保留缝内的 claim（D2(a) 的抢跑防护要靠它），在 bail 分支调用 `runtime.unclaimUndelivered(name, snapshot, claimedNow)` 回滚（第三个参数见下面的 #320 修订）。

该回滚**故意比 `unclaimReported`(D7) 更窄**：只删 claim，不清任何副本。理由相反于 D7 —— D7 处理的是「父已读过所以撤销」，此时还没有任何副本落到父手里，待发的通知是唯一剩下的送达路径。

**修订（#320，2026-xx）：回滚收窄到「本次调用取的 claim」，并同时把通知路径交还。**

上面那句「待发的通知是唯一剩下的送达路径」在实现上并不成立，回滚本身有两个缺陷：

1. **它删的可能不是自己取的 claim。** `unclaimUndelivered` 原先无条件 `reported.delete(...)`。同一 `(runId,name,round)` 若已被**真实投递**（wait / collect / 通知）claim 过，一次 bail 就把「父已拿到结果」的证据抹掉，已读通知会在下一次 flush 复活。
   - 裁决：claim 的「是否本次取得」**随缝的返回值交出**，即 `consumeCollect*` 返回 `{ snapshot, claimedNow }`（`ClaimedCollect`），`unclaimUndelivered(name, snapshot, claimedNow)` 只在 `claimedNow === true` 时回滚。
   - **不放在按快照索引的表里**：watch 与工具调用共享同一个 `job.collectPromise`，两个 collect 会拿到同一个快照对象；按快照记账时第二次调用会把第一次的 `true` 覆盖成 `false`，之后第一次 bail 直接 return，claim 留下而两份都没交付。按**调用**记账天然没有这个覆盖问题。
   - `claimedNow === false` 时回滚是完整 no-op（连 `consumedByTool` 都不复位）：claim 存在即证明结果已交付，通知本就该被过滤。
2. **它没有把通知路径交还。** 缝在 claim 之前就把 `consumedByTool` 置了位，而 watch 的闸门 `!consumedByTool && !notified` 在终态时读它。**默认 async 路径下每个 child 都被 watch**（`followChild` 的 `watch: true`）；`async: false` 的显式内联 collect **不被 watch**（它在同一个 turn 里直接 `collectChild`），那种形状下没有任何 watch 在闸门处抢跑。快照 resolve 后**watch 的 continuation 先跑**、闸门已看到 `true` 而跳过 `onTerminal`；等 `collectChild` bail 时 watch 正停在 `retire` 的 await 里，`job.watching` 仍为 `true`。因此：
   - **job 分支**的回滚必须复位 `job.consumedByTool = false` **并无条件** `runtime.watch(name)` 重挂 watch（不设 `!job.watching` 守卫 —— 该守卫会让整个修复变成死代码）。换句话说：旧 `!job.watching` 守卫在**默认路径**上恒为死代码（那里永远有人在 watch），只在 `async: false` 的内联形状下才有意义。
   - 安全性：`watch` 的 generation 自增让旧 watch 在 `finally` 处跳过 `release`（job 不被提前摘掉）；`notified` 保证同一轮不会二次 `onTerminal`；`deliverBatch` 的 claim 过滤是最后一张网。
   - 复位只作用于**本次 collect 所属的那一轮**（`job.runId`/`job.round` 与快照 origin 相等），不碰 collect 期间被 re-track 出来的新一轮。
   - **时序前提与 `waitOne` 的 `WAIT_INTERRUPTED` 分支不同**：wait 的 interrupt 赢在 collect promise resolve **之前**（watch 随后看到的是「标志已清 + job 还活着」），而本路径只可能发生在 resolve **之后**（闸门已过），所以只清标志不够，必须换一个 watch。

**公共面（#327）**：`consumeCollect*` 是 `src/api.ts` 的导出面的一部分（该文件自称 "safe to depend on"），返回类型已从 `Promise<CollectSnapshot>` 变成 `Promise<ClaimedCollect>` —— 这是一处**破坏性变更**。该形状尚未发布，所以**不做兼容层**（不给旧形状留重载 / 不提供 `snapshotOnly` 开关）：调用方改为 `const { snapshot } = await rt.consumeCollect(n)` 即可，只有需要回滚的那条路径才需要第二个字段。

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

复位点（**以「是否复位 `notified`」为准，不以函数命名**。下面是代码里真的复位它的地方）：

- `rewatch()`（父显式要求再报一次）—— **有用例钉住**（三处：outbox 副本、join 窗口副本、同轮再来一条）。
- `watch()` 的 `rearmLiveWatch`（终态前拿到 `running` 快照重臂）。
- `watch()` 的 blocked-resume 分支（审批后继续跑）。
- `watch()` 的 transient connection rearm（进程还活着的 `Connection error`）。
- `waitOne` 遇到非终态 / blocked 快照的分支（它也复位 `notified`，初版 D7 漏列）。
- `dispose()` —— 整体清空，`reported.clear()` + `roundOfName.clear()`，不走上面那个三步。

**修订（复审判决，收窄）**：初版 D7 把 `track()` 的**两个**分支都算成复位点，两条都不成立：

- **existing** 分支基线从不复位 `notified`，在那里 unclaim 是空操作且会抹掉「已交付」证据。
- **新 job 分支**的 `round` 刚刚由 `nextRoundFor` 取出，该 key 在 `reported` 里**必然不存在**，所以 `unclaimReported` 的 `had` 恒为 false，其 `dropQueued` / `join.dropBuffered` / `finished.delete` 从该站点**不可达**。已删除该调用（改留注释），不让它冒充第 5 个复位点。

是否解除 claim 以「`notified` 是否被复位」为准。除 `rewatch` 外，其余站点在多数序列里该轮从未 claim，因此实际是空操作；保留它们是为了让「复位 `notified` ⇒ 撤销 claim」这条不变量在代码里可逐点核对，而不是靠路径分析。

### D7b — 缓存（`finished`）的生命周期 = 一轮

`finished` 按 name 缓存终态快照，而下级 runId 是**父 run id**（同一父 run 下同名 child 的每一轮共用同一个 runId）。若 `track()` 不失效缓存：

1. 新一轮 collect 抛错时缓存里仍是上一轮的 snapshot，`wait`/`collect` 会把**过期成功**交给父 agent（既有缺陷）；
2. 这一命中还会 claim `${runId}\u0000${name}` —— 正是**本轮失败通知**的键，于是失败通知被永久吞掉（claim-once 引入的回退）。

所以：**`track()` 的两个分支都必须 `finished.delete(name)`**。W2 链路（完成 → release → 父 `wait` 命中缓存）中间没有 `track()`，不受影响。缓存快照写入时必须带上**发起时刻**的 `job.runId`（不是 resolve 时刻），否则同名换 runId 的重跟会写下错配。


### D8 — `join` 增加 `dropBuffered(runId, name)`

现状 `remove(name)` 只清 `pending`（`join.ts` 的 `remove`），buffered 条目成为孤儿（W3）。新增 `dropBuffered` 清除该 name 的 buffered 条目，`remove()` 的其它语义不变。

**修订（实现期裁决，2026-xx）**：`release()` 中调用 `dropBuffered` 必须**以 claim 为前置条件**（`if (isReported(runId, name, round))`）。理由：正常 watch 收尾也是「终态 child 先 release、批次后 flush」，buffered 条目是那条通知的唯一载体；无条件丢弃会把每条 grouped 通知静默吞掉（实测 4 条既有用例变红）。W3 的本质是「claim 之后的 release 留下死重」，所以 gate 在 claim 上既消除孤儿、又不碰未上报路径。

**修订（复审 major 1，2026-xx）：`release()` 用的是 `dropBufferedRound(runId, name, round)`，不是 `dropBuffered`。**

`dropBuffered` 只按 name 过滤，而 `release()` 作用在**一个 job** 上，一个 job 恰好是一轮。于是「本轮被 claim」会把**更早轮次的未读副本**一起删掉，正是 D10 说的「未读即丢」。可达序列（有单测复现）：

`track x`(round 1) → x 终态入 buffer 未读（兄弟仍 pending）→ re-track（round 2）→ round 2 也入 buffer → `wait(["x"])` claim round 2 → `release` → round 1 的未读通知被静默吞掉。

因此 join 提供两个方法，语义分开、不要合并：

- `dropBuffered(runId, name)` —— **name 全轮次**。D7 撤销专用（父要求重看 ⇒ 该名字的每份副本都过期）。
- `dropBufferedRound(runId, name, round)` —— **单轮**。`release()` 专用。

`release()` 的调用点因此是 `if (isReported(job.runId, name, job.round)) join.dropBufferedRound(job.runId, name, job.round)`。

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
2. **W2**：`notifyParentRunStart()` → child 完成（进 outbox）→ `wait` 拿到结果 → `notifyParentSettled()` → 该 child **零**消息；同批未读的兄弟仍须送达（硬要求 7，所以用例的最终断言是「恰好一条，且不含被读的那份」）。
3. **反向顺序**：通知先发 → 再 `collect` → 仍返回完整结果，且总消息数仍为 1。
4. **timeout 不误伤**：`wait` 超时（`stillRunning`）→ child 后续 settle 仍正常通知。
5. **复活**：通知发出后 `rewatch` → 第二轮完成 → 允许第二条通知。
6. **grouped flush 重算**：a、b 同组进 outbox → `wait(a)` → flush → 文本只含 b，header 不含 a，`N of 1` 形态正确。

补充硬要求（复审追加）：

7. 每条「断言零消息」的用例必须有**正向控制**（同批一个未 claim 的兄弟必须送达，用 `waitFor` 等它），否则成了空转通过。
   - 落点：W2、D10 的同名 re-track、D-B 的 cap flush、F1 的 interruptible collect。四条都补了兄弟控制；D-B 的 flush 一条的「零」是 `forcedFlushes` 的属性本身，所以控制放在同一用例的第二段（同一条 arm → flush → deliverBatch 路径必须送出一条未 claim 的通知）。
8. 生产 collect 缝是 `consumeCollectInterruptible`（tool execute 必带 signal），它的 claim 点必须有对应用例。
9. 一轮内出现第二轮（同名同 runId）时：第二轮失败通知不得被上一轮的缓存命中吞掉。
10. 同名同 runId 的两轮各有未读通知 → 两条都送达（FIFO，不丢新轮）；第一轮已读 → 只发第二轮一条。
11. **release 只丢当轮**（复审 major 1）：两轮各有一份未读副本 → 读掉后一轮（claim round 2）→ `release` → 前一轮的通知仍然送达。
12. **D7 撤销的两条副本路径各有用例，且删行即红**（复审 major 2）：outbox 副本（删 `dropQueued` 变红）、join 窗口副本（删 revoke 侧 `join.dropBuffered` 变红）。
13. **claim 回滚**（复审 minor 4）：`collectChild` 在交付前 bail（`persistChild` 抛错 / 父 turn 已 abort）→ claim 回滚 → 待发通知仍然送达。

全部既有 unit 测试必须保持绿色（`npm test`），`npm run typecheck` 干净。
