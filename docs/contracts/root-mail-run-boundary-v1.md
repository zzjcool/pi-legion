# root 收件箱的 run 边界门（v1，冻结）

> 状态：FROZEN（2026-11-09）。本契约关闭 `docs/contracts/stall-notice-staleness-v1.md` §5 第 1 条
> 登记的那道「`notice()` 的 run 边界门」，并把它的作用面从「只挡 stall notice」扩大到「root 收件箱」。
> 落地后 stall-notice-staleness §5 第 1 条从「不在本版」降级为「已由本契约接管」。

## 0. 一句话

**root 的邮件不得在 root 自身的 run 活跃期间被 push 进宿主的 followUp 队列；它留在 `PENDING`，
由既有谓词在真正注入前的那一 tick 重新判活。**

## 1. 根因（R）

| # | 事实 |
|---|---|
| R1 | `LegionPostman.deliverRootInbox` 唯一的门是 `isMailHeld(this.nodeId)`（`src/extension/legion-tools.ts:340`），它对「邮件进了宿主队列之后就没有撤回手段」这件事不设防。 |
| R2 | `followUp` 语义上只能在 turn 结束后被消费；turn 期间 push **买不到任何延迟收益**，只赚队列深度风险。`src/extension/legion-tools.ts:334-339` 的既有注释已经写过同一结论（"the mail would still arrive only at the turn boundary"）。 |
| R3 | 完成通知早已为同一问题设门（`src/extension/runtime.ts:1433` 的 `while (outbox.length > 0 && !parentRunActive)`，`parentRunActive` 由 `agent_start`/`agent_settled` 驱动）。stall notice 走自投递 mail → postman → `notice()`，绕开了那条门（`stall-notice-staleness-v1.md:28-29`）。 |
| R4 | 实测事故（2026-11-09）：scout-2 的 L2 通知于 12:06:55 检测并被 hold 挡住；hold 于 12:06:57 释放后 2s tick 立即注入 `ACCEPTED`；父于 12:07:11 `stop` 该子节点——文本已入队，`ACCEPTED→OBSOLETE` 只改标签不回滚，通知仍送达。 |

## 2. 决策（D）

### D1 — 门的位置与作用面

唯一落点：`LegionPostman.deliverRootInbox`（`src/extension/legion-tools.ts:333-363`），
位置在 `isMailHeld` 判据**之后**、遍历 `pendingInbox` **之前**，语义是「整轮跳过」（`return`，
与 `isMailHeld` 的 `return` 一致；**不是** `deliverChildren` 那种 `continue`）。

作用面是**整个 root 收件箱的全部 kind**，不是只挡 `Stall notice:`。理由：按 kind 白名单会把
「哪类通知算事实」变成需要长期维护的分类表，而 push 进无人读取的队列对任何 kind 都无收益。
`question` / `report` / `handoff` 同样只在 turn 边界被消费，延后不损失时效。

### D2 — 判据来源：单一权威，不新增第二份状态

新增 `src/legion/run-active.ts`：按 `nodeId` 持有**读取函数**的进程内注册表
（`publishLegionRunActivity` / `withdrawLegionRunActivity` / `isLegionRunActive`）。
真值仍由 `SessionRuntime` 的闭包变量 `parentRunActive`（`createSessionRuntime`，
`src/extension/runtime.ts:1187`）拥有，注册表只存 `() => parentRunActive` 这一个读取器——**不允许**
在别处再存一个布尔副本（`docs/contracts/display-liveness-v1.md` R1 的教训）。

写入侧接线（**唯一落点**，落地时被对抗式 review 修正过一次）：`SessionRuntime` 新增
`publishRunActivity(nodeId)`，实现是 `publishLegionRunActivity(nodeId, () => parentRunActive)`；
`dispose()` **最先**释放它拿到的 disposer（dispose 之后到达的 publish 为 no-op）。生产侧的 publish
挂在 `adoptLegionIdentity`（`index.ts:1582`）末尾——**不是** `initializeLegionRuntime`：true root 的
identity 是首次 launch 时由 `createRootLegion` 懒创建再交给 adoption 的，`initializeLegionRuntime`
在那之前就 `return` 了，而同一会话不会再触发第二次 `session_start`。disposer 带归属校验（只删
「仍是自己发布的那个 reader」），因此晚到的 teardown 撤不掉别人的注册。

### D3 — fail 方向：未接线 / 抛错 ⇒ 视为不活跃（fail-open）

`isLegionRunActive` 在「无注册者」「读取器抛错」「返回非 true」三种情况下一律返回 `false`，
即保持本契约之前的行为（立即投递）。这与 `notice-delivery-v2` D-H 的 fail-open 口径一致：
未知宿主不许把 root 的邮件永久扣住。**本契约不新增任何 fail-closed 分支。**

### D4 — 不新增作废判据，不碰五态与事件闭集

注入前的判活继续走既有链路：`discardIfStaleNotice` → `staleNoticeReason` → `isStaleStallNotice`
（`LegionPostman.discardIfStaleNotice`，`src/extension/legion-tools.ts:408`；`staleNoticeReason`，`src/legion/mail-release.ts:162`；`isStaleStallNotice`，`src/legion/mail.ts:732`）。
`MAIL_DELIVERY` 五态、`MAIL_BOUNCE_REASON` 闭集、`messages` 表结构、`mail_sent`/`mail_bounced`
/`mail_delivered` 事件集合**全部不变**。本契约只是让那个已有的谓词有机会在正确的时刻跑。

### D5 — 不改投递节奏，不动 pull 通道

`POSTMAN_INTERVAL_MS = 2_000`（`src/extension/legion-tools.ts:83`）、`isMailHeld` 语义、
`beginMailHold`/`endMailHold` 计数、`wait`/`collect` 的 250ms `pollInbox` 抢占
（`pollInbox`，`src/legion/mail-release.ts:341`）全部零改动。阻塞中的父节点仍然**更早**拿到通知，
这条路径不经过本门。

### D6 — 不改任何公共签名

不新增 `createLegionRuntime` 入参、不改 `resolveLegionIdentity` / `createRootLegion` /
`reopenSessionRun` 的签名。`LegionPostmanOptions` 只允许追加**可选**字段
（`isRunActive?: () => boolean`），保证 57 处测试构造与 4 处 `SessionRuntime` 字面量 double
（`test/unit/wait-action-index.test.ts:125,152,176,306`）不需要改动；`SessionRuntime` 的新方法
必须是可选成员。

### D7 — 明确的范围外（登记，不假装消灭）

1. **child→parent 的 `steer` 通道**：centurion 作为收件人且 `running` 时，父的 postman 走
   `supervisor.steer`（`LegionPostman.deliveryFor`，`src/extension/legion-tools.ts:616`），仍是 mid-turn 注入。窗口由
   steer 的 turn 边界决定，本契约不覆盖。
2. **`parentRunActive` 卡死**（宿主漏 `agent_settled`）：root 邮件在标志落下之前一直滞留 `PENDING`。
   **没有**「`dispose()` 丢弃」这种兜底——`dispose()` 只清内存里的 outbox，`messages` 表里的 `PENDING`
   行留在账本里，重开会话后同一 postman 会把它补投出去；且既有年龄判据只覆盖 `kind === "notice"`
   （`staleNoticeReason`），`question` / `report` / `handoff` 没有任何年龄门槛。继承
   `notice-delivery-v2` D6 的既有降级指的就是那个 outbox，不是这张表。
3. **`agent_start`/`agent_settled` 未注册的会话**（`index.ts` 的 `isChild && !allowNested` 早退）：
   该会话没有注册者 ⇒ D3 的 fail-open ⇒ 行为与改造前一致。
4. **持续忙碌的会话把 root 邮件推迟任意多个 turn**：门只保证「本轮不推」，投递仍要求某个 2s tick
   恰好落在 `agent_settled` 之后的空闲窗口里。一个几乎不空闲的会话（连续 turn、长 `wait`/`collect`）
   可以让 root 邮件在 `PENDING` 里等很多轮。stall notice 晚到时靠 D8 的 `Detected at` 自证年龄；
   `question` / `report` / `handoff` 没有自证行，晚到的代价由读者承担。

**不变量**：一个进程只允许一个 `"root"` 发布者。注册表按 `nodeId` 键、后发布者覆盖，`dispose()` 用
归属校验的 disposer 只撤自己那一个；若同一进程里真的并存两个 root runtime，后 publish 的读者说了算，
先退出的那个撤不掉它——但「两个同时 publish」是配置错误，本契约不提供仲裁，也不检测。

### D8 — 正文与自证不变

`formatStallNotice` 的文案、`Detected at <ISO>.` 自证行、`extend` 文案全部不变。晚到的通知
仍然自证年龄；本契约只减少晚到通知的**无效**比例。

## 3. 落点表

| 文件 | 改动 |
|---|---|
| `src/legion/run-active.ts`（新增） | 按 nodeId 的 run 活性读取器注册表；`publishLegionRunActivity` 返回**归属校验的 disposer**；`isLegionRunActive` fail-open |
| `src/extension/runtime.ts` | `SessionRuntime` 新增可选 `publishRunActivity(nodeId)`（dispose 之后为 no-op）；`dispose()` **最先**释放 disposer；真值仍是 `parentRunActive` |
| `src/extension/legion-tools.ts` | `LegionPostmanOptions` 追加可选 `isRunActive`；私有字段 + 构造赋值；`deliverRootInbox` 在 `isMailHeld` 之后加一道门 |
| `index.ts` | **读侧**：postman 构造处传 `isRunActive: () => isLegionRunActive(input.nodeId)`；**写侧**：`adoptLegionIdentity` 末尾 publish（唯一落点），钩子在 `isChild && !allowNested` 早退之后安装 |
| `test/unit/root-mail-run-boundary.test.ts`（新增） | 见 §4 验收清单（层内用例，seam 由用例自己注入） |
| `test/unit/root-mail-run-boundary-wiring.test.ts`（新增） | 生产接线：真实入口 `piLegion` + 真实 postman + 真实 2s tick，只观察宿主的 `pi.sendMessage`；**不注入 seam、不自建 postman**（删掉读侧 seam 或挪走写侧 publish 都必须变红） |
| `docs/legion-v2-contract.md` | §8.3 根收件箱「无条件 `pi.sendMessage` 注入」的描述改为「受 run 边界门约束」，按该文件 §15-1 追加修订日志 REV-33 |
| `docs/contracts/stall-notice-staleness-v1.md` | 追加 `## REV — 2026-11-09` 块（§5 第 1 条降级为已接管） |
| `docs/contracts/stall-notice-v1.md`、`docs/contracts/mailbox-delivery-v1.md` | 顶部修订注记补一句（staleness §7 落点表要求） |
| `CHANGELOG.md` | `[Unreleased] / ### Fixed` 一条（沿用 5.5.1 那条的 `Known limitations:` 收尾风格） |

## 4. 验收清单（每条都要有断言，负向用例必须配正向控制）

1. **run 活跃期间不注入**：root run 活跃 + 一条指向仍 `running` 的 child 的 `PENDING` stall notice
   → `tick()` 后 `rootMessages === []`、`PENDING === 1`、无 `ACCEPTED`。
2. **settle 后照常注入**（正控）：同一 fixture 标记 run 结束 → 下一次 `tick()` → `rootMessages.length === 1`、
   `ACCEPTED === 1`、`DELIVERED` 视会话文件而定不变。
3. **本契约要修的那个事故**：run 活跃 + 通知 `PENDING`；run 期间把 child 写成 `retired`；
   标记 run 结束 → 下一次 `tick()` → `rootMessages === []`、`PENDING === 0`、`OBSOLETE === 1`、
   恰一条 `mail_bounced{ reason: "obsolete_after_child_end" }`。
4. **非 stall 邮件同样被门挡住**：`kind: "report"` 在 run 活跃期间不注入，run 结束后注入。
5. **不影响子节点通道**：同一 tick 里父 postman 仍把邮件投递给 `deliverChildren` 命中的子节点
   （`deliverChildren` 不被本门短路）。
6. **fail-open**：`isRunActive` 缺席 / 抛错 ⇒ 立即注入（与改造前完全一致）。
7. **退出清理**：`dispose()` 后注册表不再有该 nodeId（`isLegionRunActive(nodeId) === false`），
   重复 `publishRunActivity` 幂等。
8. **回归**：`test/unit/legion-tools.test.ts` 的 §6.2（child 已 ended ⇒ 不注入）、§6.3（正控）、
   §6.6（ACCEPTED 侧作废与 delivered-wins）全部保持绿；`test/unit/wait-mail-preempt.test.ts` 全绿。

## 5. 明确不做

- 不做「父已 collect 过某个 child 就不再提醒」的语义（需要读父会话，判据脆弱；与 `notice-claim-v1`
  的 claim 面混同会破坏其「完成通知专用」的边界）。
- 不改 `steer` 通道的时机（见 D7-1）。
- 不引入新的 mail kind、事件类型、投递状态。
- 不改 stall notice 的检测阈值、配额与文案；`loopNoticeMs` 的配置面不动。
