# 信箱投递五态（v1，冻结）

> 语义由 #322 / #333 冻结。实现期发现矛盾 → 停下报告，不得重新解释本契约。
> **本文件是 mailbox-delivery 的 D 编号命名空间**：实现代码与测试注释里的
> `#322 Dn` 只解析到这里的 D1–D5。`docs/legion-v2-contract.md` 的 D 编号（D11 可视化、
> D12 账本…#322 无关）不在本契约内。

## 背景

`messages.delivered` 原本只有三值（`PENDING(0)` / `INJECTED(1)` / `BOUNCED(2)`），而
`LegionPostman.deliverToChild` 在 send 调用**返回**后就写 `INJECTED`。#313 之后我们知道那个返回是三态的：

| disposition | 真实含义 | 旧落库值 |
|---|---|---|
| `queued` | 已入队，等子节点下个 turn 边界（工具批结束之后） | `INJECTED` |
| `accepted` | 为空闲子节点起了一轮 | `INJECTED` |
| `intercepted` | 被 input handler 拦下，子节点**从未看到**，且不会被重投 | `INJECTED` |

于是同一个 `1` 同时表示「排队中」「已起轮」「根本没送到」，父节点没有任何可查询的信号能区分。
#333 是它的一个具体后果：一条 `Phase timeout:` 的 `action-needed` 通知在团队已经收敛（推进相位 /
失败 / 被 retire）之后才被投递，读起来像一条待办，却没有撤销路径。

## 冻结决定

### D1 — 五值状态域，schema v1 → v2

```ts
export const MAIL_DELIVERY = {
	PENDING: 0,
	ACCEPTED: 1,  // send 返回了：queued（等 turn 边界）或 accepted（起了新轮）
	BOUNCED: 2,   // 收件人终态 / 被 input handler 拦下（永不送达）
	DELIVERED: 3, // 子节点真的消费了（判据见 D3）
	OBSOLETE: 4,  // 曾经有效，但送达前已失去意义（#333 的 phase_timeout）
} as const;
```

- `LEGION_DB_USER_VERSION` 升到 **2**，`migrate()` 增加 v1→v2 分支：**只写版本升级与注释，不改列**。
  `messages.delivered` 一直是 `INTEGER NOT NULL DEFAULT 0`，取值域是写入方与读取方之间的语义约定，
  SQLite 无法约束。旧行的 `1` 直接按 `ACCEPTED` 解释，**无需回填**。
- `MAIL_DELIVERY.INJECTED` 保留为**弃用别名**（指向 `ACCEPTED`，同值 1）并标 `@deprecated`，
  避免仓库外 import 断裂；仓库内调用点全部改用新名字。
- 既有 v1 账本不会因为版本升级得到 `idx_messages_rate`（见 legion-v2-contract `REV-19`），本契约不改这一点。

合法迁移（其余一律 `InvalidDeliveryTransitionError`；同值重复是幂等空操作）：

| 从 | 到 | 谁写 |
|---|---|---|
| `0 PENDING` | `1 ACCEPTED` / `2 BOUNCED` / `4 OBSOLETE` | 邮差 |
| `1 ACCEPTED` | `3 DELIVERED` / `4 OBSOLETE` | 邮差 tick 确认 |
| `2` / `3` / `4` | —（终值） | — |

写 `1` 时若收件人已是终态，按 `0→2` 落 `BOUNCED`（既有语义的保留）。
`1→2` **刻意不合法**：一条已经交给收件人的信再退回来，就是把历史改写成没发生过的样子。

### D2 — 发送侧按 disposition 落值

- `queued` / `accepted` → `ACCEPTED`，事件 `mail_sent`（保持既有语义：send 已完成）。
  `ACCEPTED` 本身**不写新事件行**——`sendMail` 落库时写的 `mail_sent` 已经就是这个事实，
  再写一条只是重复；邮差把那条既有事件重新 emit 到总线供 UI 用。
- `intercepted` → `BOUNCED`，`reason: "intercepted_by_input_handler"`，发送方收到 `mail_bounced` 事件
  （并沿用既有退信邮件路径），并**删除** #313 引入的那条 `console.warn`：状态本身现在会说真话。
- 收件人终态（`isTerminalNode`）→ 保持 `BOUNCED`（既有行为，事件不带 `reason`）。
- `supervisor.prompt` 分支（`void`，无 disposition）→ `ACCEPTED`，但这是**后端能力上限**：
  in-process 的 `prompt` 无法区分 `queued`/`accepted`，所以这个值不声称任何观测结论。
  同理 `resumeChild` 的首条消息若被包装成任务卡文本，D3 的精确匹配会落空而停在 `ACCEPTED`。

### D3 — `DELIVERED`：精确文本匹配，不做启发式

**判据（冻结）**：解析收件人 session 文件（`parseSessionFile`），其**最后 20 个 turn** 的 user 文本中
存在一条与**邮差实际注入的文本**（`formatMail(message)`，即带 `[legion mail #id] / From / Subject /
Urgency` 信封的那段）**完全相等**的字符串 → `DELIVERED`，写 `mail_delivered` 事件（保留既有 event type）。

> 冻结原文写的是「完全等于邮件 **body**」。实现同时接受两种**精确**形式：注入信封与原始 body。
> 原因：邮差真正塞进 session 的是 `formatMail(...)`，只认 body 会让生产路径永远不可能确认投递
> （本契约 D3 就成了死代码）。两种形式都是整串相等，D3 的「不做更弱的启发式」没有被放松；
> 信封形式还额外带着 message id，误判面比 body 更小。

**为什么不用 contains / 前缀 / 去空白 / 模糊匹配**：子节点在报告、review note、verdict 里会大量
引用邮件原文——「把信里那句话抄回给我」是常态。任何包含式判定都会把「提到过」误读成「看到过」，
而这个状态的唯一职责是把「子节点到底看到没有」答成事实（legion-v2-contract §10.4：viz reads facts）。
宁可停在 `ACCEPTED`，也不要给一个错的 `DELIVERED`。

扫描有界：每 tick 最多确认 **N = 20** 封 `ACCEPTED` 邮件（按 `id` 取队头），避免大收件箱把一个 2s
循环拖垮。已知代价：某个收件箱若积压超过 20 封长期无法判定的 `ACCEPTED`，队尾的信要等前面的先落值；
状态始终停在 `ACCEPTED`（不误判），只是确认来得更晚。
确认在**投递之前**跑，因此本 tick 刚发出的信至少保持一 tick 的 `ACCEPTED`，不会在同一次 tick 里
既入队又"被消费"。

### D4 — `OBSOLETE`：只对 `Phase timeout:` notice 生效（#333）

**判据（冻结）**：`kind === "notice"` 且 `subject` 以 `Phase timeout:` 开头，而发件节点（= 团队根，
`checkOwnPhaseTimeout` 报的是自己的相位）已经**离开**该 phase（`phase` 变了）或已是终态 → `OBSOLETE`，
写 `mail_bounced` 事件 + `reason: "obsolete_after_phase_change"`（**不新增 event type**）。

- "该 phase" 取自产生这条通知的 `phase_timeout` 事件（`data.phase` / `data.phaseSince`），**不解析正文**：
  `phase` 不同、或 `phase_since` 不同（之后重新进入同一相位）都算离开。读不到那条事件 → 保持 `ACCEPTED`，绝不猜。
- `kind === "instruction"` 与其它 kind **永不**自动作废：指令过不过期由人判断。
- 求值在两处：
  1. **投递前**（`PENDING → OBSOLETE`）：不再注入。这是 #333 的根因路径——一条排队中的通知在团队收敛后
     才被 root 的邮差取走；
  2. **tick 确认**（`ACCEPTED → OBSOLETE`）：只改标签，不回滚已经注入 recipient 队列的文本。
- `DELIVERED` 优先于 `OBSOLETE`：确实消费过的事实不会被改写成"失效"。

### D5 — 查询面

- `pendingInbox` 只返回 `PENDING`（既有，不改）。
- 新增只读导出 `mailboxStats(db, nodeId): { pending, accepted, delivered, bounced, obsolete }`，
  供 `/legion` 状态或 doctor 使用；本契约**不要求**接到 UI，导出 + 单测即可。

## 不做（本轮刻意出清）

- **不新增 ledger event type**：闭集仍 16 个（`DELIVERED` 复用 `mail_delivered`，`OBSOLETE` 复用
  `mail_bounced` + `reason`，`ACCEPTED` 复用 `sendMail` 的 `mail_sent`）。见 legion-v2-contract `REV-22`。
- **不改 `deliverBatch` / claim 语义**，也不动 `node_handled` 等既有事件的形状。
- **不做**相位推进时的主动撤回（#333 建议 2）：需要邮件的 revoke 能力，与 #319/#320 的 claim 语义相邻，
  另立决策。本条只做「投递前校验 + 事后标注」。
- **不把** `DELIVERED` 接到 UI 渲染，也不改 `delivered_at` 以外的列。

## 验收锚点

`test/unit/legion-tools.test.ts`（三态落值、确认升级、子串不升级、#333 两处求值、幂等）、
`test/unit/legion-mail.test.ts`（五值迁移边、`mailboxStats`、精确匹配窗口）、
`test/unit/legion-db.test.ts`（v1 旧账本打开即 v2 且数据不变）。
