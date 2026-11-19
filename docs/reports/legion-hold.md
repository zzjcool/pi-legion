# legion-hold — settle hold 落地报告（issue #417）

**结论：七条冻结清单全部落地，5 条指定单测 + 3 条指定变异全绿/全红对照齐备，真机两条（正常 settle 与 Esc abort）都拿到了机器证据。**
hold 期间宿主把「子任务完成」交给**同一个 settle 边界**（`entries` + 一次续跑），而不是等下一个 `agent_settled` 的 followUp；
预算到点**不续跑**、Esc 后**hold 不发通知**、用户消息**不阻塞**。

| 项 | 值 |
|---|---|
| issue | #417（设计冻结，本报告不重新设计） |
| 基线 | `origin/master` @ `0f1e944`（fetch 后确认 ref 前进，工作树先 ff 到它） |
| 新增 | `src/extension/hold.ts`（策略）、`test/unit/settle-hold.test.ts`、本报告 |
| 改动 | `src/extension/runtime.ts`（outbox seam，见 §2.3）、`src/extension/join.ts`（+15 行 `flushBuffered`）、`index.ts`（+27 行：建 hold + 唯一注册 + 关停） |
| 未触碰 | `src/runs/live-mirror.ts`/`live-*`（#429）、`runs/launch-evidence.ts`、`legion/stall-notice.ts` |
| 单测 | **2807 → 2830**（+23），`fail 0` |
| 集成 | 193 → 193，`fail 0` |
| 真机 | 正常 settle `heldMs 7619` + 同轮吃到通知；Esc `13 ms` 释放 + abort 时刻 0 条通知 |

---

## 0. 术语与既有实测（本报告的事实底座）

| # | 事实 | 出处 |
|---|---|---|
| F1 | 钩子真名 **`agent_before_settle`**（任务书早期写作 `before_settle`，宿主里没有这个名字） | `@earendil-works/pi-coding-agent@1.5.2` `dist/core/extensions/types.d.ts:817`（事件）、`:1252`（`on` 重载） |
| F2 | 返回契约 `BoundaryResult { entries?: SessionBoundaryDraft[]; continue?: boolean }`；`entries` **整体替换**、`continue` **最后一次定义生效**、多 handler **串行 await 且无超时**、handler 抛错被宿主吞掉（`emitError`）不影响该轮 | `types.d.ts:798-816`、`runner.js:767-812` |
| F3 | `custom_message` 在 hold 里的中位延迟 **5787 ms**；**用户**消息 **32 ms**；无 hold 的 followUp **1284 ms** | `docs/reports/hold-spike.md` §2（本仓库，PR #419 的实测） |
| F4 | Esc abort → 退出 **5689 ms**（盲等 hold、`ctx.signal` **恒 undefined**），且 **abort 后通知 0 次 + 留一条孤儿 draft** | `hold-spike.md` §3（3a/3b 原始输出） |
| F5 | boundary 期间 `ctx.signal === undefined`、`_abortDuringBeforeSettle` 对 handler 不可见；Esc 唯一可用通道是 `ui.onTerminalInput` | `hold-spike.md` H10 / `agent-session.js:2079-2084` |
| F6 | 运行被 abort 时**已返回的 entries 仍会落盘**，续跑被抑制 | `hold-spike.md` H11 / `agent-session.js:1637-1641` |
| F7 | `agent_settled` 在 `finally` 里**总会发**（含 aborted），所以非投递出口把通知交回正常路径不会「从此没人发」 | `agent-session.js` `_emitAgentSettled` |

F3/F4 是**代价的真实刻度**：hold 开着的时候，排队的东西最长等满剩余预算；所以「hold 的出口必须快」不是风格问题。

---

## 1. 七条冻结清单逐条

### 1.1 legion 是 `agent_before_settle` 的唯一 owner；不注册自己的 `turn_end`

**实现**：`index.ts` 里全仓库**只有一处** `pi.on("agent_before_settle", …)`（`index.ts:2945`），注册的就是
`settleHold.beforeSettle`；`agent_start/turn_start/agent_end/agent_settled` 等生命周期注册原样未动，
`index.ts:2919` 的「Deliberately NOT `pi.on("turn_end")`」注释保持原样。

**判据（单测 `rule 1: exactly ONE agent_before_settle registration…`）**：剔除注释行后扫描 `index.ts`，
断言 `pi.on("agent_before_settle"` **恰好 1 次**、且形态是 `(event, ctx) => settleHold.beforeSettle(event, ctx)`；
`pi.on("turn_end"` **0 次**。这条是**行为性**的：**变异 M7（删掉注册）与 M8（加一个 `turn_end` handler）都红**（§4.5）。
（纯文本 grep 会数错——注释里也写着钩子名，所以断言走的是「剔注释后的代码」。）

**为什么必须唯一**（spike 实测，不是约定）：一个 settle 只有**一次**续跑机会，handler 是**串行链**——
后来者 `continue:false` 会静默取消前者的 hold（spike 1i），返回裸 `entries` 会静默删除前者的 draft（1d）。

### 1.2 永不 `continue:false`

**实现**：`hold.ts` 里 `continue` 只出现 4 处代码：2 处返回类型标注、1 处 `continue;`（轮询循环的「继续等」）、
1 处取值 `continue: true`（`hold.ts:406`，唯一的投递出口）。所有不投递的出口返回 `undefined`
（宿主当作弃权，字段保持前一个 handler 的提案）。

**判据**：单测 `rule 2`——行为上枚举 9 个可达出口（含 `completed`/`completed-empty`/`timeout`/`user-waiting`/
`cancelled`/`degraded`/`idle`/`mode`/`disposed`），断言没有一个返回 `continue:false`；结构上扫描代码断言
`continue:\s*false` 不出现、出现过的取值集合只有 `{"true"}`。**变异 M3（改成 `false`）→ 行为断言先红，
结构断言是第二道网**（§4.3）。

### 1.3 必须 spread `event.entries`

**实现**：唯一的 `entries` 返回是 `entries: [...(entriesIn as HoldDraft[]), ...taken.drafts]`（`hold.ts:404`），
`entriesIn` 就是 `event.entries`（非数组时退化为 `[]`）。

**判据**：单测 `rule 3` 用**对象同一性**断言 `result.entries[0] === EXISTING`（宿主自己排的那条原样带出去，
长度 2 = 1 + 1）；另有一条结构断言：代码里只有一个 `entries:` 返回形状且必须是 spread。
**变异 M2（裸列表）→ 两条都红**（§4.2）。

### 1.4 预算 `legionHoldMaxMs = 600000`；到期**不 continue**

**实现**：`export const legionHoldMaxMs = 600_000`（`hold.ts:60`，模块常量；生产不可配，测试用 `holdMaxMs` 注入）。
轮询是 `for (;;)`（`hold.ts:358`）而非 `while`，两处 `elapsed >= holdMaxMs` 判定（循环顶 363、poll 后 374），
每次 `sleep(Math.min(pollMs, holdMaxMs - elapsed))` —— **不会睡过界**。到点走
`exitWithoutDelivery("timeout")`：`release` → 返回 `undefined`，并如实记 `outcome:"timeout"` / `heldMs` / `entriesOut:0`。

**判据**：单测 `rule 4`（假时钟，`holdMaxMs=1050, pollMs=100`——**故意不是 poll 的整数倍**，否则「不睡过界」
在数学上无法失败）——总睡眠 **恰好 1050 ms**、最后一个 sleep 是 **50**、`commit 0`、`outcome === "timeout"`。
`rule 4 (R3)` 另钉「同一批还活着的 child 不会烧掉第二个预算」。

> 与 spike §4 D2 的分歧：spike 建议 3000 ms（理由：hold 预算 = 用户可见最坏延迟）。**冻结清单写的是 600000，
> 我按冻结清单实现**，没有偷偷改数；代价与缓解见 §6。

### 1.5 退出顺序：**先 release 再 return**；持久 `notified` 闩锁

**实现**：三层（`take` / `commit` / `release`），落在 `runtime.ts` 的 outbox 上：

| 步 | 函数 | 语义 |
|---|---|---|
| claim | `runtime.takeHeldNotice()` | 从 outbox **shift 最老一条**，用与 followUp 完全相同的 formatter（`deliverBatch` 的 `asDraft` 出口）出文本，返回 `custom_message` draft |
| commit | `runtime.commitHeldNotice()` | 写 `consumptions.notified_at`（`COALESCE` 写一次）+ 内存 `deliveredOnce`；**只在真的要返回 draft 时调** |
| release | `runtime.releaseHeldNotice()` | **unshift 回队头**，条目原样、不写任何闩锁；非投递出口在 return **之前**调 |

非投递出口的代码形状（`hold.ts` `exitWithoutDelivery`）：`deps.releaseNotice()` → 记 `hold:release` → 记 `hold:end` → `return undefined`。
单测断言 `release` 记录**排在** `hold:end` 之前，并且四条「顺序坏了」的变异都红（§4.5 M9 及
`release` 挪进 `finally`/挪到记录之后）。

> **诚实标注**：今天 `take` 与 `commit` 之间没有 await（`hold.ts:388-389`），所以**正常路径上 release 实际是 no-op**
> ——它是「claim 之后任何一步失败都要把通知还回去」的防御 seam，而不是每天都会走的分支。
> 顺序之所以仍然写死，是因为宿主在 handler **返回时**落盘 entries：把 release 放在返回之后（例如放进 `finally`）
> 就会同时得到「已播报 + 通知又被塞回队列」的双播，这一点有变异证据（`release` 挪进 `finally` → 2 条红）。

**持久闩锁的证据（跨「重启」）**：真 `legion.db` + 真 runtime——会话 1 由 hold 交付并 `commit`，`undelivered()` 立刻为空；
随后**新建一个 runtime**（等价重启：`deliveredOnce` 全空）对**同一个 artifact** 走同一条 watch→outbox 路径，
`noticeQueueStats().pending === 0`、`takeHeldNotice() === undefined`、`agent_settled` 后 `sendMessage` 0 次。
**变异 M1（`commitHeldNotice` 不写 `notified`）→ 这条直接红**（§4.1）。

### 1.6 两种出口分开；abort 后**不发**通知

**实现**：`HoldOutcome` 是分词表：正常 `completed` / `completed-empty`，取消 `cancelled`，
另有 `timeout` / `user-waiting` / `idle` / `nested` / `mode` / `degraded` / `already-gave-up` / `disposed` / `error`。
取消有两个入口，都**不取通知、不 commit、不返回 draft**：

1. **进入边界时** `event.outcome !== "completed"`（宿主已判 abort/error）→ 直接 `cancelled`，零等待；
2. **hold 期间** `ui.onTerminalInput` 收到单独的 `\x1b`（TUI 的 Esc）→ 立刻 `cancelled`（不消费按键，宿主自己 abort）；
   同一个 poll 里「最后一个 child 落定 + Esc」也判 cancel（sleep 之后第一件事就是看 `interrupted`）。

**判据**：单测 `rule 6` ×3（Esc 中途 / 进入即 abort / **同 poll 竞态**）：`result === undefined`、`take 0`、`commit 0`、
`release 1`、`outcome "cancelled"`、`entriesOut === 0`、`heldMs < 1000`。去掉 sleep 后那次 `interrupted` 检查
（变异 M5）→ 同 poll 竞态那条红（§4.4）。

**为什么是「不发」而不是「补发」**：F6 说 abort 时 entries 仍会落盘，所以「照常返回 draft」= 孤儿 draft；
spike 3a/3b 实测的另一半是「通知 0 次」= 彻底丢一次。我们的选择是：**hold 什么都不发**，把通知 `release`
回正常路径——child 真完成时它还会到，且只到一次（真机 §3.2 就是这条）。

### 1.7 用户消息路径**不阻塞**

**实现**：`ctx.hasPendingMessages()` 在两处读——**进入边界时**（一次都不等）和**每次 poll 之后**（最多一个 poll，200 ms）。
F3 说明它读的是 session 队列（用户消息），正好是我们必须让路的那一类。

**判据**：单测 `rule 7`——(a) 进入即有排队消息：`sleeps.length === 0`；(b) hold 期间用户消息入队：
`sleeps.length === 1`，`outcome === "user-waiting"`，`commit 0`。
（宿主侧机制：boundary 执行期间 `_isAgentRunActive` 仍为 true，TUI 消息入 session 队列 → `hasPendingMessages` 翻转，
见 `agent-session.js:1127/1488/2056/2922`。）

---

## 2. 形状（谁负责什么）

### 2.1 文件

```
src/extension/hold.ts        策略：何时等、等多久、什么出口返回什么、顺序、trace
src/extension/runtime.ts     seam：谁是 live child / outbox 的 take-commit-release / 取消兜底计时器
src/extension/join.ts        +15 行 flushBuffered()：join 窗口不能把通知藏起来（§2.4）
index.ts                     装配 + 唯一注册 + 关停（+27 行）
```

### 2.2 边界状态机

```
agent_before_settle
  ├─ disposed / PI_LEGION_NODE_ID 存在 / mode≠"tui" / outcome≠completed
  │     → abstain（零等待、零 seam 调用）
  ├─ liveChildren() === undefined → abstain("degraded")
  ├─ liveChildren().length === 0 → abstain("idle")            ← 常态，零成本
  ├─ hasPendingMessages()         → abstain("user-waiting")   ← 规则 7
  ├─ 同签名已烧过预算              → abstain("already-gave-up") ← R3
  └─ hold: ownsBoundary() → [poll]
        ├─ Esc（含与最后一个 child 同 poll）→ release → cancelled      → undefined
        ├─ 用户消息                        → release → user-waiting    → undefined
        ├─ 预算到点                        → release → timeout（记已放弃）→ undefined
        ├─ 全部 child 落定 + takeNotice() === undefined
        │                                  → release → completed-empty → undefined
        └─ 全部 child 落定 + takeNotice() 有货
                                           → commit（持久闩锁）→
                                             { entries: [...event.entries, ...drafts], continue: true }
```

`liveChildren()` 的判据（`runtime.ts` `holdableChildren`）：`watching === true && state === "working"`，
并排除 `isAlive()` 已判死的 job——**只有「还能产生通知」的 child 才值得等**。`awaiting`（终态已缓冲、正 park 在 retire）、
`blocked`、`retired`、未 watch 的 utility job 都不等。

### 2.3 runtime 侧 seam（最小插入，不搬家）

- `deliverBatch` 增加一个**可选** `asDraft?: (notice: CompletionNotice) => void` 参数：hold 用它让**同一条 formatter**
  产出通知文本（不发送、不入 outbox、不记账），保证两条路径的措辞不会漂移；`deliverBatch` 的原有代码**原地未动**，
  只在 outbox 分支加 `&& !asDraft`、在发送前加一个 `if (asDraft) return 1`。
- 抽出一个 `recordDelivered(surviving, projection)`（原来内联在 `deliverBatch` 里）：outbox 投递与 hold 的 `commit`
  共用同一条「写什么闩锁」的代码。这是本次唯一移动的代码块，约 20 行，**不涉及通知文案/元数据**。
- 新增 `holdableChildren` / `takeHeldNotice` / `commitHeldNotice` / `releaseHeldNotice` / `holdOwnsBoundary`。
  接口上都是 **optional**（`SessionRuntime` 在测试里被大量字面量 double 构造，必需成员会无意义地打断它们），
  拿不到 seam 的宿主 → `degraded` → 不 hold。
- `holdOwnsBoundary()` = `cancelSettleFallback()`：hold 接管边界后，`SETTLE_FALLBACK_MS`（2 s 兜底）不许在
  hold 中途开火，否则它会把 hold 正等着的通知发掉并写闩锁。单测对这条做了语句级断言（只允许这一个调用）。
  **注意它不会在 hold 结束后重新武装**——之后的投递依赖 `agent_settled`（F7 证明它总会发），见 §7.1。

### 2.4 两个 gate 不一致的地方（review 发现，已修）

hold 的「没有 live child」判据（`state === "working"`）比 join 的（`watching !== false`）**窄**：一个
**blocked 且仍在等审批**的 sibling 会被 join 当作「可能还会贡献 entry」，于是刚完成的 child 的通知被
**park 在 join 缓冲里**（最多 `flushMs` = 10 s），此时 outbox 是空的 → hold 会误判 `completed-empty`，
**功能在这个可达状态下静默失效**（不丢不重，但也没兑现）。

修法：`takeHeldNotice()` 在「已无 live child」时先 `join.flushBuffered()`（`join.ts`，+15 行，与窗口到点的
`flush` 完全同一条路径），再取 outbox。这样通知能被**当轮**交付，且批次如实降级成
`Background tasks completed (1 of 2) … Still running: worker-1`。单测
`a blocked sibling cannot hide a finished child's notice from the hold` 钉住它；
**变异 M4（删掉 flush）→ 该条红**（§4.4）。

### 2.5 R3：为什么不用 `agent_start` 复位

spike §1.3 实测：`continue:true` 会再开一次 agent run，`agent_start` 因此在每一跳重触发；用它复位「一 run 一次 hold」
的闩锁 = **60 s 内 278 跳**。本实现**没有「一 run 一次」的闩锁**：hold 的自然门是「有 live child」，
续跑后的边界没有 live child → `abstain("idle")`。唯一的记忆是「这个 child 签名已经烧过预算」的集合，
它**只记放弃**（timeout），不复位、不看 run。真机里续跑后那次边界正是 `hold:abstain idle`（§3.1 第 4 条记录）。

---

## 3. 真机两条（原始输出）

rig：`pi 1.5.2` + `test/mock-llm`（`--script`，子 agent 用 bash `sleep 8` 保证 hold 期间 child 真在跑）+ 隔离 pi home
（`writeMockPiHome({ packages: [repo] })`，加载本 checkout）+ pty 里跑真 TUI（`TERM=xterm-256color`，140×44）。
`PI_LEGION_HOLD_TRACE=<path>` 让 hold 写 JSONL；Esc 由 pty 直接送 `\x1b`。
现场留在 `/tmp/hold-rt/case-{normal3,esc3}/`（`hold-trace.jsonl` / `summary.json` / `pihome/sessions/*.jsonl`）。

### 3.1 正常 settle（hold 起止时间）

```
{"ev": "hold:begin", "at": 1795093957705, "outcome": "completed", "children": ["worker-0#1"], "entriesIn": 0}
{"ev": "hold:commit","at": 1795093965324, "outcome": "completed", "noticeChars": 439}
{"ev": "hold:end",   "at": 1795093965324, "outcome": "completed", "heldMs": 7619,
                     "entriesIn": 0, "entriesOut": 1, "noticeChars": 439}
{"ev": "hold:abstain","at": 1795093965380, "outcome": "idle"}
```

- **hold 起止**：`13:12:37.705Z → 13:12:45.324Z`，`heldMs = 7619`（child 的 `sleep 8`）。
- **同轮到达**：session transcript 里那条 `subagent-notify` 的时间戳是 `2026-11-19T13:12:45.325Z`
  = `hold:end` + **1 ms**，然后紧跟一条 assistant 消息——不是 followUp 的「下一个 turn」。
- **模型真的吃到了**：mock 只在 prompt 里出现 `automatic completion notice` 时才回 `NOTICE_SEEN_IN_TURN`。
  transcript 顺序（`type=message` 的 `message.timestamp` / `type=custom_message` 的 `timestamp`）：

```
1795093956658  assistant  toolCall subagent {agent: worker, async: true}
1795093957669  assistant  "Async child launched; I will report when its notice arrives. {ok: true, PARENT_SPAWNED}"
               ↑ 36 ms 后 hold:begin（父 turn 结束，边界打开）
13:12:45.325Z  custom_message subagent-notify   ← hold:end 的同一毫秒落盘
1795093965334  assistant  "NOTICE_SEEN_IN_TURN {ok: true, reason: NOTICE_IN_TURN}"  ← 同一续跑
```

### 3.2 Esc abort（「没有通知」的证据）

```
{"ev": "hold:begin",  "at": 1795093980218, "outcome": "completed", "children": ["worker-0#1"], "entriesIn": 0}
{"ev": "hold:release","at": 1795093981290, "outcome": "cancelled"}
{"ev": "hold:end",    "at": 1795093981290, "outcome": "cancelled", "heldMs": 1072,
                      "entriesIn": 0, "entriesOut": 0}
{"ev": "hold:abstain","at": 1795093987793, "outcome": "idle"}
esc_sent_at = 1795093981.2767   → hold 释放 @ 1795093981.290   = 13 ms
```

- **Esc → 释放 13 ms**（spike 里盲等写法是 **5689 ms**，因为它只能等预算）。
- **entry 0 条**：`entriesOut: 0`，transcript 在 `hold:end`（`13:13:01.290Z`）时刻**没有任何** `subagent-notify`。
- **孤儿 draft 消失**：对照 spike 3a/3b「draft 仍落盘 1 条」，这里 abort 时刻落盘 0 条。
- **子任务仍 live**：TUI 轨道在 Esc 之后继续 `worker-0 worker · 1s … 8s` 数到 8 s，child 没被带走。
- **不丢**：child 真完成时（`13:13:07.750Z`，比 `hold:end` 晚 6.46 s）它自己的完成通知走**正常路径**到达一次
  ——这是 `release` 的语义（把扣住的通知交还 followUp），不是 hold 发的。
  换句话说：**hold 在 abort 时发 0 条；通知本身没被吞掉，也没被发两次。**

---

## 4. 测试

### 4.1 单测 5 条（任务书要求）

| # | 要求 | 用例 | 断言 |
|---|---|---|---|
| ① | 到期（假时钟）不再等且不 continue | `rule 4: at the budget …` | 恰好睡 **1050 ms**、最后一个 sleep = 50、`result === undefined`、`outcome === "timeout"`、`commit 0` |
| ② | entries 原样透传 | `rule 3: the drafts are returned AFTER event.entries …` | `entries.length === 2`、`entries[0] === EXISTING`（同一性）、`entries[1] === DRAFT`；结构断言：唯一 `entries:` 形状是 spread |
| ③ | 闩锁跨「重启」（重读状态）不重发 | `rule 5: the persistent latch — a RESTART …` | 会话 1 `commit` 后 `undelivered()` 为空；新 runtime 对同一 artifact：`pending === 0`、`takeHeldNotice() === undefined`、`sendMessage` 0 次 |
| ④ | abort 路径不发通知 | `rule 6: Esc during the hold …` + `… aborted at ENTRY …` + `… SAME poll …` | `take 0`/`commit 0`/`entriesOut 0`/`outcome "cancelled"`；进入即 abort 时 `sleeps 0` |
| ⑤ | 用户消息不被阻塞 | `rule 7: a queued USER message is never blocked …` | 进入即排队 → `sleeps 0`；中途排队 → `sleeps 1`、`outcome "user-waiting"`、`commit 0` |

其余 18 条把七条的其它面钉住：注册唯一性/无 `turn_end`（源码扫描）、`print`/`json`/`rpc`/缺失 mode 全不 hold、
nested 门、idle/degraded 零成本、`completed-empty` 不 commit、R3 不二次烧预算、`continue:false` 不存在、
seam 抛错也照样 settle 并 release、`dispose()` 后不再 hold、`holdOwnsBoundary` 只做 `cancelSettleFallback()`、
release 后通知仍由 followUp 到达、**join 缓冲被 flush（blocked sibling）**、**take 跳过已读条目**。

### 4.2 变异 1：去掉 entries spread → 红

```
=== M2: drop the event.entries spread ===
✖ rule 3: the drafts are returned AFTER event.entries, which are spread verbatim
✖ rule 3: the module has exactly ONE `entries` return shape, and it is the spread
ℹ pass 15  ℹ fail 2
  AssertionError [ERR_ASSERTION]: the host's own entry survives next to ours
  1 !== 2
```

### 4.3 变异 2：改成 `continue:false` → 红

```
=== M3: continue:false instead of continue:true ===
✖ rule 3: the drafts are returned AFTER event.entries, which are spread verbatim
✖ rule 2: no exit ever returns `continue: false`
ℹ pass 15  ℹ fail 2
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:   ← result.continue 变 false
```

（`rule 2` 里**行为枚举**先命中；结构扫描是第二道网，同一份代码改动它也会命中。）

### 4.4 变异 3：去掉持久闩锁（`commitHeldNotice` 不写 `notified`）→ 红

```
=== M1: remove the persistent notified latch (runtime.commitHeldNotice) ===
✖ rule 5: the persistent latch — a RESTART cannot announce the same result twice
ℹ pass 16  ℹ fail 1
  AssertionError [ERR_ASSERTION]: the notified latch is persisted
  + [ 'r-1/worker-0/r1' ]     ← undelivered() 仍有它
```

### 4.5 追加变异（review 之后补的，证明新测试真的会咬）

| # | 变异 | 结果 | 红在哪 |
|---|---|---|---|
| M4 | `takeHeldNotice` 不再 `join.flushBuffered()`（blocked sibling 场景） | **红** | `a blocked sibling cannot hide a finished child's notice from the hold` |
| M5 | 删掉 sleep 之后的 `interrupted` 检查（Esc 同 poll 竞态） | **红** | `rule 6: Esc in the SAME poll …` |
| M6 | `takeHeldNotice` 去掉 `owesDelivery` 重筛 | **红** | `the hold skips an outbox item that no longer owes a notice` |
| M7 | `index.ts` 不再注册 handler | **红** | `rule 1: exactly ONE agent_before_settle registration …` |
| M8 | `index.ts` 额外注册 `turn_end` | **红** | 同上 |
| M9 | `completed-empty` 出口也 commit | **红** | `rule 5: completed-empty …` |

脚本 `/tmp/mutate.sh`（指定三条）与 `/tmp/mutate2.sh`（追加六条），输出 `/tmp/legion417-mutations{,2}.log`；
每条都「改回去 → 跑单文件 → 恢复」，恢复后 **23 pass / 0 fail**。

### 4.6 门禁数字

```
npm run typecheck        → exit 0
npm test                 → ℹ tests 2830   ℹ pass 2829   ℹ fail 0   (1 skipped)     ← 基线 2807
npm run test:integration → ℹ tests 193    ℹ pass 193    ℹ fail 0                   ← 基线 193
```

基线（`origin/master` @ `0f1e944`，同机、同一把 `flock`）：`2807 / 2806 / 0`（1 skipped）、集成 `193 / 193 / 0`。
本次 **+23 条**，没有降。

改动面：

```
 index.ts                 |  27 ++++
 src/extension/join.ts    |  15 +++
 src/extension/runtime.ts | 118 ++++++++++++++++++++++++++++++++++++++---   （含 recordDelivered 搬家 ~20 行 + seam）
 + src/extension/hold.ts (新增)
 + test/unit/settle-hold.test.ts (新增)
 + docs/reports/legion-hold.md (新增, git add -f)
```

`deliverBatch` 的**通知文案仍然是原地代码**（没有搬家），所以 #414 若往通知/产出元数据里加字段，
冲突面只有「`asDraft` 那一小段插入 + 新增的 `recordDelivered` 调用」，不是整块移位。

---

## 5. 与 #411 / #413 的关系（一句）

hold 落地后，父会话在 child 在跑时**不再落到 idle**，所以「父 idle 而 child 在跑」这个误判面消失：
#413 第 2 层（跨机 child quiet 被读成本地 0 而误报空转）与 #411 镜像的「父已 idle、镜像还在追」这类现场，
在 hold 覆盖的这段窗口里不再出现。但 hold 只覆盖**边界的等待期**（预算上限），不是常亮，所以误判面是
**缩小**而不是「消失」——具体缩小多少需要 #413 自己的指标，本报告不宣称数字。

---

## 6. 预算取值的分歧（必读）

spike §4 D2 的推理是：hold 期间通知类消息**抢不动**（F3），所以 **hold 预算 = 用户可见最坏延迟**，建议 **3000 ms**。

本实现按**冻结清单**取 `legionHoldMaxMs = 600_000`。两侧都成立，取舍如下：

| 取值 | 好处 | 代价 |
|---|---|---|
| 600000（已实现） | 长 child（跨机、长命令）也能同轮交付；不会「刚 hold 就放弃」 | 最坏情况：父会话里追加的**通知类**消息最长等 10 分钟；用户自己的消息不受影响（规则 7，实测 32 ms 量级） |
| 3000（spike 建议） | 最坏延迟 3 s | 3 s 之后完成的 child 又回到 followUp 路径，收益面变窄 |

如果裁决要改成 3000，改动是一行常量；所有测试用注入值，不会因此重写。**本节不改代码，只把代价摆明。**

---

## 7. 已知限制（如实记录）

1. **`SETTLE_FALLBACK_MS` 在 hold 后不会重新武装**：`holdOwnsBoundary()` 取消了它，`releaseHeldNotice()` 只重新武装
   80 s 的 horizon 计时器（那个只计数、从不发送）。所以 hold 结束后的投递依赖 `agent_settled` 必定到达（F7），
   而不是依赖 2 s 兜底。若宿主真的丢了 settle 事件，本次通知会留到下一个边界。
2. **`continue: true` 会覆盖前一个 handler 的 `continue: false`**：这是 1i 的镜像面。宿主是「最后一次定义生效」，
   而 legion 在链里被要求把 hold 交给边界，所以它只能返回 `true`。若某个扩展故意用 `false` 取消续跑，
   legion 的投递会把它顶掉——这是规则 1.1（唯一 owner）要求「链上只有一个 holder」的另一半理由。
3. **无法观测的 abort 窗口**：`ctx.signal` 恒 `undefined`（F5）、`_abortDuringBeforeSettle` 不可见。Esc（TUI 通道）与
   `event.outcome !== "completed"` 都覆盖了；但如果**别的扩展**在「最后一个 poll 之后 → return 之前」这不到 1 ms
   的窗口里调 `session.abort()`（不是 `ctx.abort`、不是 TUI 按键），宿主仍会落盘 entries 并抑制续跑（F6），
   这一次会留下「有 entry、无续跑」的孤儿 draft。亚毫秒窗口，本实现无法再收窄。
4. **一个边界只发一条通知**（沿用 notice-delivery-v2 D2「一次边界一条唤醒消息」）：hold 只 `take` outbox 的**最老一条**，
   其余留在队列里等正常路径；`triggerTurn:false` 的纯装饰行也不取（它不要求续跑，不值得花掉这次续跑）。
5. **`hasPendingMessages` 缺失时规则 7 降级**：老宿主/裸 ctx 没有这个探针时，`userWaiting()` 返回 false（fail-open），
   规则 7 退化成「只能靠预算」。生产宿主 1.5.x 有该字段。
6. **mode 白名单是严格的**：只有 `ctx.mode === "tui"` 才 hold；`print`/`json`/`rpc`/缺失 mode 一律 abstain。
7. **nested 门**：`PI_LEGION_NODE_ID` 存在即不 hold（子 agent 不为自己的子 agent 挂起父边界）。有单测覆盖；
   真机里 in-process child 不派发 settle 边界，所以现场看不到这条路径。
8. **别人不 spread 我就没了**：若某个扩展在 legion 之后注册 settle handler 并返回裸 `entries`，本 hold 的 draft 会被删掉（spike 1d）。
   属于对方违反规则 1.3，本侧无法防御；已把「顺序 = 决定权」写进 `index.ts` 注释。

---

## 8. 复现

```bash
# 单测 + 9 条变异
bash /tmp/mutate.sh && bash /tmp/mutate2.sh
node --experimental-strip-types --test test/unit/settle-hold.test.ts

# 门禁
flock /tmp/pi-legion-ci.lock -c "npm run typecheck && npm test"
flock /tmp/pi-legion-ci.lock -c "npm run test:integration"

# 真机两条（pty + mock LLM + 隔离 pi home；现场写 /tmp/hold-rt/case-*）
python3 /tmp/hold-rt/drive.py --case normal --outdir /tmp/hold-rt/case-normal3
python3 /tmp/hold-rt/drive.py --case esc    --outdir /tmp/hold-rt/case-esc3
```

---

## 9. 交付

- 分支：`pi-subagent/host-workspace/legion-417-4c460cc7`，PR 写 `Fixes #417`。
- 新增：`src/extension/hold.ts`、`test/unit/settle-hold.test.ts`、本报告。
- **本报告必须 `git add -f`**：`.gitignore:30` 的 `reports/` 会命中 `docs/reports/`，`git add -A` 会**静默丢掉**它。
  交付前用 `git ls-files docs/reports/legion-hold.md` 核对（应为 1 行），`git status --short` 看不出这件事。
- 未触碰：`src/runs/live-mirror.ts`/`live-*`、`runs/launch-evidence.ts`、`legion/stall-notice.ts`。
