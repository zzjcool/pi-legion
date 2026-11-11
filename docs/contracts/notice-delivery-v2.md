# 完成通知投递 v2：交付时刻 = 可见时刻（FROZEN）

> 状态：**FROZEN**（2026-11-06，用户裁决「出个契约然后动代码」）。
> 冲突时**停下报告**，不得重新解释本契约。
> 取代：`notice-claim-v1.md` 的 D-B（`MAX_PENDING_AGE_MS` 到点强制发送）与 outbox 投递时机。
> 保留：`notice-claim-v1.md` 的 D1-D10（claim 键 `(runId,name,round)`、回滚、`release` 只丢当轮）。
> 关联：`display-liveness-v1.md`（活性单一权威）、#238（burst）、#384（mail 抢占）。

---

## §1 现象（2026-11-06 15:12–15:18，容器 `pi-legion-real`，会话 `01a1b16b`）

> 文中的 `文件名:行号` 是 v2 实施**前**的快照，用于指认当时的代码位置；实施后行号已漂移。

| 时刻 | 事实 | 证据 |
|---|---|---|
| 15:13:42 | 同一条 assistant 消息并行发出 `vexillatio(scout×2)` + `subagent(worker, name=demo-worker, async)` | session line 9 |
| 15:13:43 | 三个 child 均 `runtime.track()`，共用父 run `r-bc0550ff`；scout 为 `watching:false` | `runs/r-bc0550ff/run.json`、`index.ts:4603` |
| 15:14:50 | demo-worker 终态；join 窗口在 10s 后到期 | `runs/r-c3de1f5c/demo-worker.jsonl` 末条 |
| 15:15:00 | 窗口 flush → 父 run 活跃 → 入 outbox（只存结构） | `runtime.ts:1278-1281` |
| ≤15:16:20 | 80s 上限强制 flush → 此刻定稿 `(1 of 2)` + `Still running: scout-0` → 宿主 followUp 队列 | `runtime.ts:1147-1187` |
| 15:16:57 | scout-0 结束，vexillatio 返回；`release()` 后 jobs 清空 | `run.json` `retiredAt` |
| 15:17:12 | 父 `collect(demo-worker)` → 同一份 2440 字正文 | session line 16 |
| 15:17:35.106 | 宿主 settle 边界 drain followUp → 追加 `custom_message` 并起新一轮 | `agent-session.js:1596` |
| 15:17:53 | root 把通知当用户输入，重跑状态核实 | session line 23 |

三条可观测缺陷：

- **N1 重复**：同一次完成经 `collect` 与通知各到达一次，正文相同。
- **N2 假事实**：`Still running: scout-0 (notifies separately when it finishes)` 在生成时就不成立
  （scout 是 `watching:false` 的 utility job，不存在"另发"这条路径），交付时又已过期 38s。
- **N3 误判来源**：通知以 `role:user` 进入模型上下文并触发新一轮，root 判断为"用户贴了一条系统通知"。

---

## §2 根因

**R1 — 去重判定点选在 T0，而模型可见在 T2。**
claim 过滤在发送前（`runtime.ts:1243-1246`），发送成功后立即 claim（`runtime.ts:1283-1293`）；
而消息真正进入上下文是在宿主 settle 边界（`hasQueuedMessages → continue`，`agent-session.js:1596`）。
宿主**没有撤回能力**（`sendMessage` 无 id、扩展拿不到 `clearQueue`），所以 T0 之后发生的一切 claim 都无效。
这是 TOCTOU，不是参数没调好。

**R2 — 80s 上限主动制造 T0≠T2。**
上限存在的依据是 `docs/design.md:243-247`「父 run 活跃时发出去的 followUp 会躺在队列里，直到用户再发一条消息」。
该前提在当前宿主（pi 1.5.0）**不成立**：settle 边界就会 drain。因此强制发送**不让模型早一秒看到**，
只让通知提前脱离 claim 过滤。

**R3 — footer 的判活来源错了。**
`stillRunning` 只看进程内 `jobs` 表（`runtime.ts:1256-1271`），既不看 watch 意图
（utility 阻塞 collect 期是 `watching:false`，`index.ts:4603`；只有超时/blocked 分支才
`followUtility(handle,true)`，`index.ts:4612-4614`），也不看进程存活。

**R4 — 文本没有来源标记。**
`notify.ts:342`（单条）/ `notify.ts:457`（批量）首行直接是内容，模型无法与用户输入区分。

---

## §3 冻结决定

### D1 — **完成通知**的唯一交付时刻：父 run 边界

- 范围：本节管的是**完成通知**（`subagent-notify` 的 completion notice，见 §7 的
  `runtime.ts` / `notify.ts`）。`index.ts` 另有三条**旁路** `sendMessage`，不受本节约束，
  已在 §5 登记：`notice()`（orphan 提示）、`launchQueueNoticeSink`（launch 队列行）、
  `notifyBlocked`（blocked 提问）。
- 完成通知只允许在 `parentRunActive === false` 时调用 `pi.sendMessage`（`agent_settled` 处理器内，或父本就空闲）。
- 删除"上限即发送"：`MAX_PENDING_AGE_MS` **不再**是发送触发器。
- 依据：这是唯一能让 T0 = T2 的时刻。宿主 API 无撤回能力，任何"提前发 + 事后撤销"都不可实现。

### D2 — 边界上一轮只交付一条

`flushOutbox()` 每次边界按 FIFO 交付：

- 交付成功一条 `triggerTurn:true` 的条目后**停止**，剩余条目留在 outbox 等下一次边界；
- `triggerTurn:false` 的条目（不唤起 run）可以在同一次边界内连续交付；
- 被 claim 过滤掉的条目（返回 0）不计入停止条件，继续处理下一条；
- 重入 `agent_start`（`sendMessage` 是宿主 ACTION，宿主可在回调里把 run 重新置为活跃）⇒
  循环**立即停手**：每取一条都重读 `parentRunActive`，且交付成功的唤醒条目本身已经耗尽本轮配额；
- 混合批次（一批里既有 `triggerTurn:true` 又有 `false`）按**整批** `some(triggerTurn)` 判定：
  整批算一条唤醒通知，不会因为其中一条是 `false` 就多给一个槽位；
- **禁止**把剩余条目送进宿主队列（那会重新制造 T0≠T2）。

依据：`_isEmittingAgentSettled` 期间 `sendMessage` 是延后执行的，`parentRunActive` 不能同步反映
"这一条已经唤起 run"；因此停止条件必须是"已交付一条 `triggerTurn:true` 的条目"，而不是读标志位。
重入路径（宿主在 `sendMessage` 回调里再调 `notifyParentSettled()` / `notifyParentRunStart()`）
由 `flushOutbox` 自身的重入守卫与逐条 gate 兜住：一次边界永远只交付一条唤醒通知。

### D3 — 文本只在交付时刻生成

- outbox 只存结构（沿用 `notice-claim-v1` D4）；**禁止**任何"入队时拼文本"的改动。
- 边界交付时按当时的 claim 状态现场计算 header、footer 与正文。

### D4 — `stillRunning` 只列"确定会另发通知"的兄弟

必须**全部**满足才列出：

1. 同一 `runId`；
2. `job.state ∉ {awaiting, retired}`（沿用）；
3. `job.watching === true` —— 没有武装的 watch 就永远不会产生第二条通知；
4. 未被 claim、未被工具消费、不在本批（沿用）；
5. `!(job.isAlive && !job.isAlive())` —— 进程已被判定死亡的不算"还在跑"。

footer **删除**承诺子句，只陈述事实：`Still running: a, b`。

**已知会被列出的一种形态**：`state === "blocked"` 且仍停在 `handleBlocked` 的 await 里的兄弟。
它确实在运行（进程活着、watch 已武装），所以列它是**事实陈述**，不是承诺；`blocked` 分支
本身会同步发一条提问旁路（§5-4），footer 不再承诺"另发"正是为此。

优先级：**宁可少报，不可假报**。RPC 短暂断连窗口里少列一次可以接受；
把不会来的通知写成"会单独通知"不可接受。

### D5 — 通知首行标明机器来源

`formatCompletionNotice` 与 `formatGroupedNotice` 的第一行固定为：

```
▣ legion · automatic completion notice — not a user message
```

其余正文与 `details` 形状不变（TUI 折叠行仍由 `details` 决定，`notice-renderer.ts` 不受影响）。

### D6 — 上限降级为健康信号

- `NoticeQueueStats.forcedFlushes` → **`heldOverCap`**：lifetime count of
  "held notice 的年龄跨过 `MAX_PENDING_AGE_MS`"，**只计数、不发送**。
- **计数口径（按条、只数仍可交付的通知、每条约一次）**：
  - 计时与计数都跟着「最老一条**仍可交付**的通知」算——与 `pending` / `oldestAgeMs` 同一定义
    （`item.entries.some(e => !isReported(...))`）。已被 claim 的死重条目**不武装、不计数**，
    所以 `pending === 0` ⇒ 没有 timer、计数也不再长。
  - 同一条通知跨多个 80s 窗口只计**一次**（`QueuedNotice.overCapAt` 一次性标记）；计数后按
    一个整窗重新武装，且"整窗"锚在**这次计数之后**，避免 0 延迟空转。
  - 效果：`pending` / `oldestAgeMs` / timer / `heldOverCap` 四者指向**同一条**通知。
- `MAX_PENDING_AGE_MS` 与 `scheduleNoticeOverflow` 注入缝保留（测试手动触发）；`pending` / `oldestAgeMs` 语义不变。
- 兜底：`parentRunActive` 若因宿主漏事件卡死，通知会一直留在 outbox；`dispose()` 丢弃（沿用）。
  `heldOverCap` / `oldestAgeMs` 是**供诊断读取**的计数（当前无生产消费者，仅导出给诊断/测试）。
  **不允许**再引入任何强制发送。

---

## §4 与既有契约的关系

- `result-ledger-v1.md`（P4c 起）：**claim 语义已被整体取代**。交付判据不再是内存 claim 集合，而是
  账本投影 `ledger.undelivered(consumerId)`（该契约 D4：读全文或已通知即离开投影，没有回滚 API）；
  本契约 D1-D6（边界交付、一轮一条、交付时刻生成文本、`stillRunning` 只列确定会再发通知的兄弟、
  首行机器来源标记、上限只做健康计数）**仍然有效**，P4c 删掉的只是 claim 三件套与 `join` 的
  `dropBuffered*`。历史依据见 `archive/notice-claim-v1.md`。
- `notice-claim-v1.md`（已归档）：它定义 claim 键/回滚/`release` 只丢当轮；本契约曾取代其 D-B（cap 发送）
  与 outbox 投递时机，并覆盖 **D5 的「逐字节一致」条款**（首行固定为机器来源标记，其余正文形状不变）。
  该文件的 claim 部分现由 `result-ledger-v1.md` 取代。
- `display-liveness-v1.md`：本契约 D4 是其 D1「单一权威」在通知 footer 上的落地——判活不再只看 `jobs` 表。
- #238 burst：本契约不改变 join 层的分组，只改变 outbox 的交付节奏。

---

## §5 不在本版范围

1. **通知载荷改为指针**（正文只给 headline + `outputFile`，全文只由 `collect` 提供）——登记为 v2.1，
   需单独裁决（会改变"通知即可自足"的产品语义）。
2. 跨进程 claim（重启后 outbox 已丢弃，无副本可发）。
3. 宿主 `role:user` 映射（只能靠 D5 的文本标记缓解）。
4. **`index.ts` 的三条 `sendMessage` 旁路**不受 D1 约束，仍可能在父 run 活跃时直接发送：
   `notice()`（orphan 检测提示）、`launchQueueNoticeSink`（launch 队列行，`triggerTurn:false`）、
   `notifyBlocked`（blocked 提问）。它们不是完成通知、不参与 claim 过滤，本版未改其时机。
   风险是同类的 T0≠T2（含 `role:user` 误读），留待后续版本统一。
5. **D7 的 name-wide `dropQueued` 窗口变宽**：D7 撤销一份已读结果时，`dropQueued` 按
   `(runId, name)` 在**整条队列**里过滤；v2 让队列里的副本可以横跨多个 run 边界（时长任意），
   所以「还能被撤销」的窗口从「发出前」拉长到「可能很久以后」。不产生重复（过滤只会删），
   但丢失面变大：一次撤销会连带删掉后来才入队的同名副本。
6. **`parentRunActive` 是 fail-open 的**：它只由宿主 `agent_start` / `agent_settled` 驱动，
   默认 `false`。宿主若漏发 `agent_start`，通知会退回 v1 时序（立即发送，T0≠T2 重现）；
   这是刻意的降级（未知宿主保持旧行为，D-H），没有自证机制。
7. **宿主异步 `sendMessage` 失败不可见**：`deliverCompletion` 只捕获同步抛错；宿主把投递
   变成异步（`_isEmittingAgentSettled` 期间延后执行）后，失败只在宿主内的 `emitError`
   里可见，扩展侧已返回 `true` 并 claim——该条通知不会再重试。

---

## §6 验收清单

1. **上限不发**：父 run 活跃 + child 完成 → 触发 horizon arm → 0 条消息、`pending` 仍 1、`heldOverCap === 1`；
   随后 `notifyParentSettled()` → 恰好 1 条（正向控制）。
2. **本会话复现**：父 run 活跃 + child 完成 + 父在本 turn 内 `collect` → settle → **该 child 0 条**
   （同批未读兄弟仍在**同一次边界**送达，total 1 —— 这个「1」是本节末尾那条「正向控制」
   硬要求，不是重复）。
3. **utility 兄弟不假报**：两个 child（a `watching:false`、b 已 watch 并完成）→ settle → 1 条，
   header 为 `(1)`，正文不含 `Still running`。
4. **blocked/timeout 兄弟真报**：a 处于 re-armed watch 形态（`watching:true`）→ settle → 1 条含
   `Still running: a`；a 再次 settle → 第 2 条（承诺兑现）。
5. **死进程不列**：`isAlive: () => false` 且 `watching:true` → 不进 footer。
6. **burst 逐条**：outbox 3 条且均 `triggerTurn:true` → 每次 settle 只交付 1 条，`pending` 依次 2 → 1 → 0。
7. **`triggerTurn:false` 不阻塞**：同一次 settle 内 false 条目连续交付，遇到第一条 true 停下。
8. **标记与措辞**：single / grouped 两条路径首行都是 D5 标记；footer 不再出现 `notifies separately`。
9. **渲染不变**：`details` 形状不变，既有折叠行用例继续通过。折叠行**不变**；
   展开态正文的**首行就是 D5 标记**——这是有意的（标记必须在模型可见的那份正文里，
   而折叠行只由 `details` 决定）。

每条「断言 0 条」的用例必须配**正向控制**（同批一个未 claim 的兄弟必须送达），否则是空转通过。

---

## §7 实施落点（file ownership）

| 文件 | 改动 |
|---|---|
| `src/extension/runtime.ts` | `deliverBatch` 去 `force`＋`parentRunActive` 唯一 gate；`flushOutbox` 逐条＋停止条件＋重入守卫＋逐条异常安全（失败条目退回队首）；`armOutboxTimer` 只计数（按条、只算仍可交付的、每条约一次）；`NoticeQueueStats.heldOverCap`；`stillRunning` 的 D4 过滤 |
| `src/extension/notify.ts` | D5 首行标记；D4 footer 删承诺子句 |
| `test/unit/runtime.test.ts` | T1/T2/T3* 改写；新增 §6 的 1-7；D6 的按条计数口径；D2 的重入与异常安全（拒绝 / 格式化抛错） |
| `test/unit/notify.test.ts` | 标记与措辞 |
| `docs/design.md` | §3.3.0（约 220-250 行）同步 outbox 段落 |
| `docs/contracts/notice-claim-v1.md` | 顶部加一行：D-B 与投递时机被 v2 取代 |
| `CHANGELOG.md` | `[Unreleased]` 一节 |
