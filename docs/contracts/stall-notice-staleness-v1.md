# Stall 通知的时效性 v1：投递前判活 + 自带检测时刻（FROZEN）

> 状态：**FROZEN**（2026-11-06，用户裁决「继续优化」）。
> 冲突时**停下报告**，不得重新解释本契约。
> 上位关联：`notice-delivery-v2.md`（同类根因 T0≠T2 在完成通知侧的解）、`display-liveness-v1.md` R5
> （"Stamp the detection time so a late delivery is self-evident"）。
> 修订：`stall-notice-v1.md` D4 的「三条投递路径零改动」中新增"投递前作废"一步；
> `mailbox-delivery-v1.md` 的「只有 `Phase timeout:` 可被自动作废」扩为两类。

---

## §1 现象（2026-11-06，本会话实测）

`subagent status all` 返回 `No live children` 的同时，root 收到：

```
[legion mail #1]
From: root
Subject: Stall notice: rev-correct
...
L2 long-running (past the role's notice budget):
- rev-correct: running for 10m 1s (threshold 10m 0s), with no tool in flight. …
```

- `rev-correct` 在检测时刻确实在跑（10m 阈值刚过），但**送达时它早已返回完整报告**；
- 信封与正文**没有任何检测时刻**，读信的人无法判断这条事实有多旧；
- 这不是 `notice-delivery-v2` 修的完成通知：stall 通知走 **自投递 mail → postman → `notice()`**，
  完全不经过 runtime outbox，也没有 claim 过滤。

三条可观测缺陷：

- **S1 无时效自证**：正文只有 `elapsedMs` 快照，没有 `Detected at`；`formatMail` 信封也没有时刻。
- **S2 已失效仍投递**：通知涉及的所有 child 都已终态/退役，通知仍是 `PENDING`，postman 照投。
- **S3 抢占路径同样过期**：阻塞中的 `wait`/`collect` 会通过 `takePendingMail` 直接取走它，
  （这条路径比 postman 更早，250ms 轮询）。

---

## §2 根因

**R1 — 文本在检测 tick 定格，投递延后。**
`formatStallNotice` 不带时刻（`src/legion/stall-notice.ts:253`），`writeStallNotice` 只把 tick 的
`timestamp` 写进 `created_at`（`legion-tools.ts:1212-1227`），而投递只发 `formatMail(message)`
（`legion-tools.ts:331`）。于是"10m 1s、no tool in flight"这类**相对事实**在送达时已经不可复核。

**R2 — 只有 `Phase timeout:` 有投递前作废规则。**
`isStalePhaseTimeoutNotice` 硬编码 `kind === "notice"` + 前缀 `Phase timeout:`
（`mail.ts:661-664`）；`Stall notice: ` 永不匹配，因此永远不会被作废，只会在
`PENDING` 里等到被投递（`legion-tools.ts:325`）。

**R3 — 抢占路径与 postman 各有一套谓词。**
`takePendingMail` 只丢弃 stale `Phase timeout:`（`mail-release.ts:154-157`），
`pendingMailCount` 却对**所有** pending 行计数（`mail-release.ts:122-132`）——两套谓词不共享。
新增任何"投递前过滤"若只改一边，就会让阻塞的 `wait`/`collect` 在 250ms 内空返并误报
`interrupted (parent turn ended; children still running)`。

---

## §3 冻结决定

### D1 — stall 通知正文自带检测时刻

`formatStallNotice(announcements, detectedAt)` 在首行之后固定输出一行：

```
Detected at 2026-11-06T15:52:10.123Z.
```

- `detectedAt` 由调用方传入（`checkStallNotices` 的 tick `timestamp`），**不得**在
  `stall-notice.ts` 内读时钟（该模块的纯净性测试会抓 `Date.now`）。
- 非有限数**或**超出 `Date` 可表示范围（`|detectedAt| > 8.64e15`）时省略该行：`toISOString()`
  在超范围值上会抛 `RangeError`，而一个离谱的时钟不该带走这一 tick 的全部事实。
- 该行以 `Detected at ` 开头（**不是** `- `），所以既有 `- <child>: …` 行解析不受影响。
- 时间戳非有限数时**省略该行**（绝不打印 `Invalid Date`）。

### D2 — 投递前判活：全部 child 已结束 ⇒ 作废

新增纯谓词 `isStaleStallNotice(db, message)`：

1. `message.kind === "notice"` 且 subject 以 `STALL_NOTICE_SUBJECT_PREFIX`（`"Stall notice: "`）开头；
2. 从 body 解析 `^- (\S+): ` 行得到 child 名（与 `formatStallNotice` 的行文法同源）；
3. **零个可解析名字 ⇒ 不算过期**（never guess）；
4. 任一名字不满足 slug 文法（`isValidNodeSlug`）⇒ 不算过期（never guess）；
5. 探测器节点（`message.fromNode`）在 `nodes` 表里不存在 ⇒ 不算过期（never guess）；
6. 对每个名字 `getChildByName(db, message.fromNode, name)`：
   **全部**满足"不存在或 `hasEnded(node)`" ⇒ `true`；否则 `false`。

判定用 `hasEnded`，**不是** `isTerminalNode`（`retired`/`settled` 的团队必须算结束，理由同 #354）。

### D3 — 谓词必须四条投递/确认路径 + 轮询计数共享

`isStaleStallNotice` 与既有的 `isStalePhaseTimeoutNotice` 在下列位置**同一套判断**：

| 位置 | 行为 |
|---|---|
| `legion-tools.ts` `discardIfStaleNotice`（被 `deliverRootInbox` / `deliverChildren` / `confirmAcceptedMail` 共用） | 命中 ⇒ `OBSOLETE` + `mail_bounced`，跳过发送 |
| `mail-release.ts` `takePendingMail`（#384 抢占） | 命中 ⇒ `OBSOLETE`，**在 claim 之前**，不返回给工具 |
| `mail-release.ts` 轮询计数（现 `pendingMailCount`） | 只数**可释放**的行：在**最老的一页**（`MAIL_RELEASE_LIMIT = 100`）里排除 stale stall 与 stale phase-timeout，并保留原有的 lease 条件（`delivered_at` 未过期）；与 `takePendingMail` 读同一页，所以「计数说可释放」与「take 真能交出东西」不会分叉 |

轮询计数与 `takePendingMail` 必须共享同一谓词，否则会出现 R3 的空返 + 误报。

### D4 — 作废原因区分

`MAIL_BOUNCE_REASON` 新增 `OBSOLETE_AFTER_CHILD_END = "obsolete_after_child_end"`；
stall 作废用它，phase-timeout 仍用 `obsolete_after_phase_change`。

### D5 — 不改投递节奏、不改信封、不改 schema

- postman 仍是 2s tick；`isMailHeld` / 抢占语义（`wait-mail-preempt-v1`）**不变**；
- `formatMail` 信封**逐字不变**（它是 `DELIVERED` 的精确匹配判据，`mail.ts:620-627`）；
- 不新增表/列/事件类型；作废只发既有的 `mail_bounced`（与 phase-timeout 同一形状）；
- 写入侧仍零事件（`stall-notice-v1` D9 不变）。

---

## §4 与既有契约的关系

- `stall-notice-v1.md` D4：三条投递路径的**文本与时序**不变，只在每次真正发送/确认前增加
  "已失效则作废"一步。
- `mailbox-delivery-v1.md`：可自动作废的通知类别从 1 类（`Phase timeout:`）扩为 2 类
  （+ `Stall notice: `），谓词仍以 `kind === "notice"` 为前提。
- `wait-mail-preempt-v1.md`：§1.1 的 hold 语义不变；新增的只是"已经失效的信不会抢占"。
- `notice-delivery-v2.md`：本契约不触碰其 outbox/claim 路径。

---

## §5 不在本版范围（有证据的登记）

1. **`notice()` 的 run 边界门**（"父 run 活跃时把 stall 通知压到 settle"）不在本版：它需要把
   run 活性传进 postman（当前 `SessionRuntime` 无 getter），且与 `stall-notice-v1` D4 的
   "三条路径零改动"和 `wait-mail-preempt-v1` §7 的"不改投递节奏"直接冲突；本版用
   D1+D2 消掉**有害的那一半**（失效通知不再送达），仍然有效的通知晚到时有 D1 自证。
2. **"Delivered N after detection"**：不能在投递时拼接——`formatMail` 是 `DELIVERED` 的
   精确匹配判据，改文本会让账本永远停在 `ACCEPTED`。
3. **stall 通知写入侧限流/长度**：沿用 `stall-notice-v1` D4（自投递绕过 `sendMail`），本版不改。
4. **`Redelivered: ` 前缀的副本绕过前缀门**：`mail-release.ts` 的 `redeliverMail` 给重投副本加
   `Redelivered: ` 前缀，于是 `Stall notice: ` 的前缀门不再命中，children 全结束后该副本仍会送达。
   `Phase timeout:` 有同样的洞（既有）。修它需要在两侧共享一个"剥掉重投前缀"的读法，本版未做，
   登记为已知残余；触发需要"先被抢占、结果又被丢弃"两个罕见事件叠加。
5. **非 writer 正文的假阳性类**：`sendMail` 允许人类/agent 写 `kind: "notice"` + 自拟
   `Stall notice: …` 主题与 `- <name>: ` 行。这类消息若恰好点名了已结束的 child，会被当作机器
   stall 通知作废。与 #333 对 `Phase timeout:` 的处境相同（前缀门是有意的类别判定），本版接受。
6. **分页截断饥饿**：若某 inbox 最老的 100 条 PENDING 全是 stale，轮询计数为 0、postman 又处于
   hold，这 100 条要等 hold 结束后的下一个 tick 才会被作废；在此期间第 101 条之后的可用邮件够不到。
   页宽是既有常量，本版不改。

---

## §6 验收清单

1. **D1 时间戳**：`formatStallNotice(…, T)` 的正文含 `Detected at <T 的 ISO>`；无时间戳时省略该行；
   `- ` 行解析结果不变。
2. **D2 root 投递作废**：child 已 `retired` → 一 tick 后 `rootMessages === []`、`PENDING === 0`、
   `OBSOLETE === 1`、恰好一条 `mail_bounced`（`reason: "obsolete_after_child_end"`）。
3. **D2 正向控制**：同一形状但 child 仍活 → 通知照常送达、`OBSOLETE === 0`。
4. **合并通知**：3 个 child 全部结束 → 作废；其中 1 个仍活 → 送达且正文仍点名该 child。
5. **never guess**：正文无可解析名字 / 名字不是 canonical slug（`sanitizeNodeSlug(name) !== name`，含大小写与首尾分隔符）/ 存在解析不出的 `- ` 行 / 探测器节点不存在 → **送达**，不作废。
5b. **名字在树里不存在 ⇒ 算结束**（与 5 的 never-guess 相反方向）：探测器节点存在、名字是 canonical slug，但该名字没有对应节点 → 作废（正文点名的节点已不在，没什么可 steer/abort）。
6. **ACCEPTED 侧**：`confirmAcceptedMail` 对已 `ACCEPTED` 的 stall 通知同样能判过期并转 `OBSOLETE`
   （沿用 "Delivered wins over obsolete"：会话里能证明读到 ⇒ `DELIVERED`）。
7. **#384 不回归**：inbox 里只有 stale stall 通知时，阻塞的 `wait` **不被抢占**（正常等到超时、
   返回 stillRunning）；同一 fixture 追加一条新鲜 stall 通知 ⇒ 仍然立即抢占（正向控制）。
8. **既有 phase-timeout 用例全绿**（`legion-phase-timeout-ended.test.ts` / `legion-tools.test.ts`
   的 OBSOLETE 与 reason 断言不变）。

---

## §7 实施落点（file ownership）

| 文件 | 改动 |
|---|---|
| `src/legion/stall-notice.ts` | `STALL_NOTICE_SUBJECT_PREFIX`、`stallNoticeChildNames(body)`、`formatStallNotice(announcements, detectedAt)` |
| `src/legion/mail.ts` | `isStaleStallNotice(db, message)`、`MAIL_BOUNCE_REASON.OBSOLETE_AFTER_CHILD_END` |
| `src/extension/legion-tools.ts` | `discardIfStaleNotice` 分派两类并带 reason；`checkStallNotices` 传 `timestamp` |
| `src/legion/mail-release.ts` | `takePendingMail` 丢弃 stale stall；轮询计数改"可释放"口径（同一谓词） |
| `test/unit/stall-notice.test.ts` | D1 时间戳；§6.4/§6.5 |
| `test/unit/legion-tools.test.ts` | §6.2/§6.3/§6.6 |
| `test/unit/wait-mail-preempt.test.ts` | §6.7（不抢占 + 正向控制） |
| `docs/contracts/stall-notice-v1.md`、`docs/contracts/mailbox-delivery-v1.md` | 顶部修订注记 |
| `CHANGELOG.md` | `[Unreleased]` 一条 |
