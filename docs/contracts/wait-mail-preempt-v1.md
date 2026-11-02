# wait / collect 邮件抢占契约 v1

- 状态：生效，随实现 PR 落地。
- 上游：`docs/legion-v2-contract.md`（冻结契约）、`docs/contracts/notice-claim-v1.md`（#352 的 claim 语义）。
- 本契约只改**阻塞工具的返回时机**，不改邮件本身的内容、路由与记账规则。

## §0 问题（实测）

`legion_mail → root` 走 `notice()` → `pi.sendMessage({triggerTurn:true, deliverAs:"followUp"})`。
宿主的 followUp 只在**当前轮"本来要停"时**被取走（`agent-loop.js:197`），且一封一轮。
所以根会话只要在一个长工具调用里，邮件就进队列干等：

```
10:21:27  根会话进入 subagent({action:"wait", timeoutMs:900000})
10:24:00  cent-1 写入 mail #1（契约冻结）
10:40:59  这一轮才结束 → mail #1 才被投递（延迟 17.3 分钟）
```

## §1 触发条件

- 调用者是 legion 节点（工具入口的 `input.legion` 存在），且该节点的 inbox 里存在
  `delivery = PENDING` 的邮件。
- 进入 `wait` / `collect` 时**先查一次**；之后每 **250ms** 查一次，直到这次调用结束。
- 与 `signal`（调用方中断）互不覆盖：谁先到谁赢。

### §1.1 阻塞期间该节点的 postman 必须停手

`PENDING` 是触发条件的全部前提，而**生产里这一前提曾经不成立**：实测问题会话的账本
（`r-f4ef2868/legion.db`）显示，root 的 postman 在写入后 **~200ms** 就把邮件
`PENDING → ACCEPTED` 并推进 host 的 followUp 队列 —— 比任何一次 250ms 轮询都早。
于是 `pendingMailCount(root)` 在整个 15 分钟的 `wait` 里恒为 0，功能形同虚设。

因此：

- **阻塞调用持有节点期间，该节点自己的 postman 不得投递**：`deliverRootInbox` 在看到 hold
  时直接返回，邮件留在 `PENDING` 供抢占取走（`beginMailHold` / `endMailHold` /
  `isMailHeld`，`src/legion/mail-release.ts`，进程级、按 nodeId 计数）。
- hold 覆盖**所有**退出路径：超时、调用方 abort、抛错、正常返回，都在 `finally` 里释放 ——
  一次超时的 `wait` 不允许把 inbox 永久占住。
- 只约束**同进程**的投递者：root 的 postman 与 root 的工具同进程。子节点的投递发生在父进程，
  hold 跨不过进程边界 —— 那里由 §3.1 的租约保证「不重复投递」，本条的「抢占优先」不承诺给子节点。

## §2 行为

命中即**立即返回**（不再等 timeout、不再等 settle）：

- 正文 = 被抢占的邮件（`formatMail` 原文，按 id 升序，最多 100 封）+ 一行状态说明：
  - `wait`：`Children are still running: <name (state)>, …`
  - `collect`：`The collect was interrupted by this mail; call collect again after handling it.`
- `details.state = "mail"`、`details.mailIds = number[]`、`details.targets = string[]`。
- 返回是**正常工具结果**（不是错误、不是 `interrupted`）——模型可以读完邮件继续工作。

## §3 投递记账（恰好一次）

- 被抢占的邮件必须 `transitionDelivery(…, ACCEPTED)`（与 postman 的 `deliverRootInbox` 同一语义）。
- 不新增事件：`mail_sent` 已在 `sendMail` 落账（`src/legion/mail.ts:311`），这里只动 delivery 列。
- postman 只读 PENDING（`pendingInbox`），因此**不会重复投递**；这是本契约唯一的防重复机制，
  测试必须钉住「抢占之后 postman tick 一次，不再产生 followUp」。

### §3.1 在途认领（租约）

同一条消息可能被两条路同时拿：postman 的 `followUp/steer/prompt`（`deliverToChild`）与收件人自己
被阻塞的 `wait`/`collect`（本契约 §1）。谁先投递必须是**数据库层互斥**，而不是两个 async 调用点的先后。

实现用**租约**，不新增状态、不新增合法边：

- `messages.delivered_at`（本就存在且可空）在 `delivered = PENDING` 期间复用为**认领时间**；
- 认领 = 条件更新
  `UPDATE messages SET delivered_at = ? WHERE id = ? AND delivered = 0 AND (delivered_at IS NULL OR delivered_at < ?)`
  （`?` 为 `now - leaseMs`），`changes === 0` ⇒ 别人持有，**跳过发送**；
- 租约 **60s**（`MAIL_DELIVERY_CLAIM_LEASE_MS`，`src/legion/mail-release.ts`）：只用于**崩溃兜底**，
  正常路径由状态机收尾——发送返回 ⇒ `transitionDelivery(…, ACCEPTED)`（顺带把 `delivered_at` 写成真正的接受时间）；
  发送抛错 ⇒ `UPDATE … SET delivered_at = NULL WHERE delivered = 0`（放回 PENDING，下一 tick 重试，**不判 BOUNCED**）；
- 认领者异常退出（进程消失、没机会释放）：租约过期后（`now > delivered_at + leaseMs`）即可被重新认领；
- `delivered = PENDING` 的含义因此**不变**（仍是"还没交付"），`ACCEPTED` 之后 `delivered_at` 回归"接受时间"，
  §3 的"恰好一次"依旧由 `PENDING → ACCEPTED` 单独保证。

由此 `ACCEPTED` 不承担"在途"语义，#322 的五值域与四类合法边一条不改。

## §4 取消

- `wait`：内部 `AbortController` 与调用方 `signal` 合并（`AbortSignal.any`），abort 原因可区分
  「mail 抢占」与「调用方中断」；后者仍返回原来的 `interrupted (parent turn ended; children still running)`。
- `collect`：走既有的 interruptible 路径，**claim 回滚照旧**（`unclaimUndelivered`）；
  抢占分支在回滚之后返回邮件正文，不允许留下「被抑制但没有交付」的通知（#352 的不变量）。

## §5 不变量

| 编号 | 不变量 | 守卫 |
|---|---|---|
| I1 | 无邮件时行为逐字节不变（结果文本、`details`、timeout 语义） | 现有 wait/collect 用例**一行不改** |
| I2 | 邮件恰好交付一次：PENDING→ACCEPTED + 不再被 postman 投递 | 新用例 #2 |
| I3 | 不新增事件类型、不改 SQLite schema | `legion-schema-sentinel` / `legion-events` 不改 |
| I4 | 子节点状态与进程不被触碰（只返回，不 retire/abort） | 新用例断言 `status` 不变 |
| I5 | 调用方中断（Esc/父轮结束）语义不变 | 现有 interrupted 用例不改 |
| I6 | 抢占延迟 ≤ 500ms（250ms 轮询） | 新用例用假时钟或实测墙钟上界 |

## §6 验收

1. `wait`：活子节点 + 100ms 后写入一封 mail → 1s 内返回，正文含 mail 标题与正文；
   `details.state === "mail"`；账本里该邮件 `delivery = ACCEPTED`；随后 postman tick → 不投递（I2）。
2. `collect`：同上，且 `details.state === "mail"`、子节点 `status` 不变（I4）。
3. 无邮件：`wait` 照旧等超时、`collect` 照旧拿结果（I1，现有用例不改）。
4. 调用方 `signal` 先触发：仍返回 `interrupted …`（I5）。
5. 变异：去掉轮询 → 用例 1/2 失败（超时或拿不到 mail）；把 `transitionDelivery` 去掉 → 用例 2 的
   「不再重复投递」变红。
6. `npm run typecheck` / `npm test` / `npm run test:integration` 全绿。

## §7 非目标

- 不改 postman 的投递节奏、不改 `notice()` 的 `followUp` 语义。
- 不做跨进程/跨节点的邮件合并。
- 不把邮件内容塞进 `wait` 的 `timeoutDetails`（那条详情属于 #352 的 claim 语义）。
