# legion-hold-gaps — hold 的两条真实缺口（#438 / #439）

**结论先行：**

- **#438（fallback 未重新武装）已修，行为改动真实**：hold 的每一条"拥有过边界"的出口都按原语义重新武装 `SETTLE_FALLBACK_MS`；
  一条真计时器端到端 + 一条真 TUI 会话把它钉住；6 条变异全红。
- **#439（`continue:true` 覆盖前置 handler 的 `continue:false`）在 pi 1.5.2 上不可修**：宿主把链的初始值写成 `false`
  并让最后写入者生效，前一个 handler 的否决与"还没人说话"是**同一个字节**。本报告给出代码证据 + 两次真机运行
  （`1f-no-hold` vs `1i2-veto-first`）作为证明。已落地的部分：**可表达就让路**（宿主一旦把"没人说话"表达成"字段缺席"，
  `false` 只可能是否决 → hold 放弃并记录 `hold skipped: peer continue:false`）、**不可表达就逐字不变**（有 `deepEqual` 钉住）、
  **不再静默覆盖**（每条 hold 记录带 `chainVote`）。上游诉求写在 §2.5。

| 项 | 值 |
|---|---|
| issue | #438（fallback 重新武装）、#439（前置 veto） |
| 基线 | `origin/master` @ `298c235`（`git fetch` 后确认 ref 前进：`0f1e944..298c235`，工作树先 `merge --ff-only` 到它） |
| 改动 | `src/extension/hold.ts`、`src/extension/runtime.ts`、`index.ts`、`test/unit/settle-hold.test.ts`、`test/unit/runtime.test.ts`、`scripts/spike/run.ts`（+1 个测量用例） |
| 未触碰 | `src/runs/live-mirror.ts`、`runs/launch-evidence.ts`、`legion/stall-notice.ts`（硬要求） |
| 单测 | **2844 → 2855**（+11），`pass 2854 / fail 0 / skipped 1` |
| 集成 | 193 → 193，`pass 193 / fail 0` |
| typecheck | exit 0 |
| 真机 | TUI+pty：`heldMs 5613`、通知**同轮**到达、`NOTICE_SEEN_IN_TURN`；print：`chainVote: "sentinel"` |
| 变异 | 9 条（#438 六条 / #439 三条），**全红**，恢复后 32/32 + 2/2 绿 |

> 基线数字与本任务书写的 `2830 / 193` 不同：master 在 #417 之后又落了 6.2.6 的若干合并，本工作树实测
> **2844 单测 / 193 集成**。以实测为准，未下调、未跳过任何既有用例。

---

## 0. 事实底座（全部带出处）

| # | 事实 | 出处 |
|---|---|---|
| F1 | `emitBoundary` 以 `let shouldContinue = false` 起步，把 `continue: shouldContinue` 放进每个 handler 的 event，`handlerResult.continue` 非 `undefined` 时直接赋值（最后一次生效） | `@earendil-works/pi-coding-agent@1.5.2` `dist/core/extensions/runner.js:767-813`（`:770`/`:775-780`/`:785-786`） |
| F2 | 被 abort 的 run 仍会落盘已返回的 `entries`，续跑被抑制；`agent_settled` 在 `finally` 里总会发 | `agent-session.js:1637-1651`、`hold-spike.md` H11/F7 |
| F3 | 每次 `emitBoundary` 只建一个 `ctx`，全链共享；`event` 每个 handler 新建；`event.context` 每个 handler 后重建 | `runner.js:768`、`:775-780`、`:790` |
| F4 | `pi.on(event, handler)` 无 priority/order 选项，顺序 = 扩展加载顺序 × 注册顺序 | `loader.js:219-235`、`runner.js:87-89` |
| F5 | `ExtensionContext` 不暴露扩展列表 / handler 位置 / 前序返回值 | `types.d.ts:233-273` |
| F6 | 本仓库 spike 实测：两个都不返回值的 handler 都看到 `c=false` | `docs/reports/hold-spike.md:72-73`（1f-no-hold） |

F1 + F4 + F5 一起决定了 #439 的天花板：**否决只在"最后一次写入"时才有意义，而扩展侧没有任何传感器能看见前一次写入。**

---

## 1. #438 —— `SETTLE_FALLBACK_MS` 在 hold 之后没有重新武装

### 1.1 症状（改动前）

`runtime.ts` 只有一个"武装"点（`agent_end` 的 `notifyParentRunEnd`）。hold 接管边界时 `holdOwnsBoundary()` 把它**取消**
（必须取消：不取消就会在 10 分钟的 hold 中途把 hold 正等着的通知发掉并写闩锁）。问题在回头：

```
agent_end ──arm──▶ [timer]  ──hold 接管──▶ cancel
                                              ↓
                            hold 退出（timeout/cancelled/released）
                                              ↓
                            宿主 settle 没来 ✗  ──▶ 通知停在 outbox，直到别的边界顺手推它
```

`releaseHeldNotice()` 只重挂 80 s 的 horizon 计时器，而那个**只计数、从不发送**（`runtime.ts` 的 `MAX_PENDING_AGE_MS` 注释）。
所以窗口内唯一的网是 `agent_settled` 必定到达 —— `docs/reports/legion-hold.md` §7.1 已把它记为已知边界。

### 1.2 修法（两处，都是对称的最小插入）

| 侧 | 改动 |
|---|---|
| `runtime.ts` | 把 `agent_end` 那段武装逻辑抽成 **`armSettleFallback()`**（延迟、守卫、payload 一字不改），`notifyParentRunEnd()` 改为调用它；新增 seam **`holdReturnsBoundary()`**，body **只有** `armSettleFallback();` |
| `hold.ts` | `SettleHoldDeps` 新增可选 **`returnsBoundary?()`**；在"拥有过边界"的那段 `try/finally` 的 `finally` 里调用（`detach()` 之后，且自身 try/catch：救援计时器是礼节，不能让边界失败） |
| `index.ts` | 装配一行：`returnsBoundary: () => runtime.holdReturnsBoundary?.()` |

三个设计点，都在注释里写死了理由：

1. **"原语义"= 同一个函数**。不是复制一段 `schedule(SETTLE_FALLBACK_MS, …)`，而是同一个 `armSettleFallback()`：
   守卫（`disposed` / `parentRunActive` / 空 outbox / 已有计时器）与 payload 不可能漂移。
2. **放在 `finally`**，因为出口有五个（`completed`、`completed-empty`、`timeout`、`cancelled`、`user-waiting`）外加抛错；
   逐个手写调用漏一个是静默的，`finally` 不会漏。它**不是** release 顺序的一部分：release 仍然在
   `exitWithoutDelivery` 里**先 release 再 return**（`legion-hold.md` §1.5 的顺序承载未动），重新武装排在
   `hold:end` 记录之后 —— 它是给**下一个**边界的网，不可能造成本次边界双播。
3. **投递出口也武装**。它通常无事可做（通知已被 `take` 走、outbox 空 → 守卫直接返回），但 outbox 里还有第二条通知时，
   重新武装是对的；而它要来的续跑会由 `notifyParentRunStart` 取消这把计时器，所以不会提前开火。

### 1.3 与上一版相比，谁会在什么场景下看到不同结果

| 场景 | 上一版 | 本版 |
|---|---|---|
| hold 正常投递后宿主正常 settle | 无差别（计时器被 settle 取消） | 无差别 |
| hold 以 `timeout`/`cancelled`/`user-waiting`/`completed-empty` 退出，宿主 settle **正常到达** | 无差别 | 无差别（`notifyParentSettled` 取消新计时器） |
| **hold 退出后宿主 settle 丢了**（abort/ESC、会话被拆、settle emission 没跑完） | 通知停在 outbox **直到下一个无关边界** | **2 s 后由兜底发出去**（followUp，措辞与正常路径同一 formatter） |
| 空 outbox / hold 从未接管边界 / runtime 已 dispose | 不武装 | 不武装（三个守卫原样） |

### 1.4 测试（假时钟 + 真计时器 + 真 TUI）

| 用例 | 钉住什么 |
|---|---|
| `#418: every exit that claimed the boundary hands it back, and the abstains do not` | 5 条拥有过边界的出口各 `returns === 1`；`idle`/`degraded`/`mode` 各 `returns === 0` |
| `#418: the hand-back is the LAST thing the hold does …` | `order` 逐项相等：投递 `owns,hold:begin,take,commit,hold:commit,hold:end,returns`；释放 `…,release,hold:release,hold:end,returns` |
| `#418: a rescue seam that throws cannot fail the boundary` | seam 抛错 → 仍是 `hold:end timeout`，没有变成 `hold:abstain error` |
| `T1e: runtime — the hold hands the boundary back …`（真 runtime） | `notifyParentRunEnd` 武装 → `holdOwnsBoundary` 取消 → `holdReturnsBoundary` **再武装**（同 `SETTLE_FALLBACK_MS`）→ 手动触发 → `sendMessage` 一次、`pending → 0` |
| `T1f: … arms nothing when there is nothing to rescue, and never stacks` | 空 outbox 不武装；settle 之后不武装；已武装时不叠加 |
| `#418: a hold that hands the boundary back leaves the rescue armed …`（端到端） | **生产 seam 全链**：真 hold 策略 + 真 outbox + 真 `legion.db` + 真 `release`，hold 走 `timeout` 退出后计时器真的被武装并真的把通知发出去 |
| `#418 (real timer): the production rescue timer really fires …` | **不注入任何东西**：runtime 自己的 unref'd `setTimeout`，实测 `2031 ms` 后通知到达（并断言不得早于冻结延迟） |
| `rule 1: holdReturnsBoundary is the settle-rescue ARM, and nothing else` | 语句级：body 只允许 `armSettleFallback();` |
| `rule 1: exactly ONE agent_before_settle …`（扩写） | `index.ts` 必须把 `ownsBoundary` 与 `returnsBoundary` **成对**接上 |

### 1.5 真机（TUI + pty）

rig：真 `pi 1.5.2` + `test/mock-llm`（脚本三段：父 launch async → 子 `bash sleep 6` → 通知哨兵）+ 隔离 pi home
（`writeMockPiHome({ packages: [本 checkout] })`）+ pty 里跑真 TUI（`TERM=xterm-256color`，140×44）。
`PI_LEGION_HOLD_TRACE` 写 JSONL；`/exit` 收尾。原始产物留在 `/tmp/hg/tui/`。

```
notice_seen_in_pty: True
{"ev":"hold:begin","at":1795101482098,"outcome":"completed","children":["worker-0#1"],"entriesIn":0,"chainVote":"sentinel"}
{"ev":"hold:commit","at":1795101487711,"outcome":"completed","noticeChars":386}
{"ev":"hold:end","at":1795101487711,"outcome":"completed","heldMs":5613,"entriesIn":0,"entriesOut":1,"noticeChars":386,"chainVote":"sentinel"}
{"ev":"hold:abstain","at":1795101487772,"outcome":"idle","chainVote":"sentinel"}
```

同一会话的 transcript（`type=message` / `type=custom_message`，按落盘顺序）：

```
assistant   [toolCall subagent]
toolResult  ▶ worker-0 (worker) supervisor=inprocess … async: a completion message is queued …
assistant   PARENT_TURN_ENDED
CUSTOM      subagent-notify :: ▣ legion · automatic completion notice — not a user message
assistant   NOTICE_SEEN_IN_TURN
```

即：hold 期间 child 真在跑（5613 ms ≈ `sleep 6`），通知在**同一轮**由 entries 落盘、续跑后模型立刻读到
（`NOTICE_SEEN_IN_TURN`）。这条现场同时证明新的 `returnsBoundary` 装配在真会话里不炸、且续跑边界照旧 `abstain idle`。

> 真机上"fallback 重新武装"本身看不到，因为 `agent_settled` 总会到（它一取消就无从观察）。所以这条缺口的决定性证据是
> §1.4 的真计时器端到端（生产 `setTimeout` + 真 outbox + 真 ledger），TUI 现场负责证明"改动没破坏真实 hold"。

### 1.6 变异（6 条，全红；脚本 `/tmp/hg/mutate.sh`，日志 `/tmp/hg/mutations.log`）

| # | 变异 | 结果 |
|---|---|---|
| M418-1 | `hold.ts` 不做 `returnsBoundary()` | **红** ×4：every-exit / order / 端到端 / 真计时器 |
| M418-2 | `holdReturnsBoundary()` 改成 `cancelSettleFallback()` | **红**：`T1e` |
| M418-3 | 删掉 `if (settleFallbackTimer) return;`（允许叠加） | **红**：`T1f`（never stacks） |
| M418-4 | 删掉 `outbox.length === 0` 守卫 | **红**：`T1f`（空 outbox 也武装） |
| M418-5 | `index.ts` 不接 `returnsBoundary` | **红**：`rule 1: exactly ONE agent_before_settle …` |
| M418-6 | 提前到 release 之前（顺序坏） | **红**：`#418: the hand-back is the LAST thing …` |

恢复后：`settle-hold.test.ts` **32 pass / 0 fail**，`runtime.test.ts` 两个用例 **2 pass / 0 fail**。

---

## 2. #439 —— `continue: true` 覆盖前置 handler 的 `continue: false`

### 2.1 症状

`hold.ts` 的投递出口返回 `{ entries: [...event.entries, ...drafts], continue: true }`。若链上**前面**的 handler
已经把 `continue` 写成 `false`，这一次写入把它覆盖掉，宿主于是**续跑**了本回合 —— 别人的明确阻止被吞掉。

### 2.2 为什么在 1.5.2 上不可能修（证明，不是判断）

三层证据，缺一不可：

**(a) 代码**（F1）：`shouldContinue` 的初始值就是 `false`，且每次 handler 的 `false` 只是把它再赋一次 `false`。
所以"前一个 handler 否决"与"还没有人说话"在 event 上**完全同形**。

**(b) 枚举**（4 路独立侦察，结论一致）：event 字段（`type/outcome/entries/continue/context`）、`ctx`（每边界一个、全链共享、
不含扩展列表/位置/前序结果）、`event.context`（每个 handler 后重建，内容只随 entries/队列变）、`entries`（只有"有没人返回过 entries"，
与投票无关）、`pi.on` 无优先级、`getExtensionPaths()` 扩展侧拿不到、内置扩展没有一个注册这两个边界 —— 没有任何一条能区分。

**(c) 真机**（决定性）：`scripts/spike/` 的两扩展 rig（真 pi + mock provider，两次运行只差"前置 handler 是否否决"）：

```
── 1f-no-hold        （没人说话）
   boundary handler calls: 2  first 2: A#1(run1)[in=[] c=false] B#1(run1)[in=[] c=false]
── 1i2-veto-first    （A 注册在前，显式 return {continue:false}）
   boundary handler calls: 2  first 2: A#1(run1)[in=[] c=false] B#1(run1)[in=[] c=false]
```

`spike.jsonl` 里逐条 `boundary:in` 的 `continueIn` 都是 `false`（原样见附录 A）。**两行一模一样。**

两条路都被堵死：

- 把 `false` 一律当否决 → 1.5.2 上**每一次** hold 都让路 = 把 #417 整体回滚；
- 把 `false` 一律当哨兵 → 就是今天的行为。

**所以"识别"这一步在 1.5.2 上做不到。** 本报告不假装做到。

### 2.3 落地的部分（三件事，都可验证）

1. **可表达就让路。** `hold.ts` 现在读链上的投票（`BoundaryState.continue`），并学习这个宿主"能不能表达没人说话"：
   只要某次 boundary **不带** `continue` 字段，就证明宿主用"缺席"表达"还没人发言"；此后 `false` 只可能是前面某个 handler
   的真实回答 → **放弃 hold**（零等待、不取通知、不 commit），记 `outcome: "peer-continue-false"` +
   `reason: "hold skipped: peer continue:false"` + `chainVote: "veto"`。通知留在 outbox，走正常 followUp 路径。
2. **不可表达就逐字不变。** 在 1.5.2（初始值 `false`）上，这个 `false` 被记为 `chainVote: "sentinel"`，边界行为与上一版
   **逐字相同** —— 单测用 `deepEqual(order)` / `deepEqual(sleeps)` / `deepEqual(result)` 三条把"什么都没变"钉死。
3. **不再静默覆盖。** 每条 `hold:begin` / `hold:end` / `hold:abstain` 都带 `chainVote`
   （`continue` | `absent` | `sentinel` | `veto`）。1.5.2 用户今天能拿到的就是这条：事后能看出"这一轮链上是 `false`，
   legion 随后写了 `true`"。

### 2.4 与上一版相比，谁会在什么场景下看到不同结果

| 宿主 | 场景 | 上一版 | 本版 |
|---|---|---|---|
| **pi 1.5.2（今天所有人）** | 任意 hold | trace 无 `chainVote` | trace **多了 `chainVote: "sentinel"`**；行为逐字不变 |
| **pi 1.5.2** | 前置 handler 否决 | hold 覆盖它，回合续跑 | **仍然覆盖**（无传感器）+ 现在**可诊断**（`chainVote: "sentinel"` = "这段字节不可信"） |
| 会表达"缺席"的宿主 | 前置 handler 否决（有 live child） | hold 覆盖它 | **hold 放弃**：零等待、不取通知、`hold skipped: peer continue:false`，通知走正常路径 |
| 会表达"缺席"的宿主 | 前置 handler 请求续跑（`true`） | hold 覆盖（无害） | 照旧 hold，`chainVote: "continue"` |
| 任意宿主 | `idle`/`degraded`/`mode`/`nested` 等 abstain | 无区别 | 无区别，只是记录多了 `chainVote` |

**诚实标注**：第 2 行是硬缺口，本版**没有**修掉它，只把它从"静默"变成"可诊断"。第 3 行要等宿主改（§2.5）。

### 2.5 上游诉求（宿主侧，一行改动的形状）

任选其一即可让 §2.3 第 1 条在 1.5.2 上立刻变成真实行为：

1. `let shouldContinue: boolean | undefined`（不写就不写），即 `continue` 三态 —— 扩展因此能区分"没人发言"与"有人否决"；
2. 或给 `BoundaryState` 加 `prior: BoundaryResult[]` / `priorContinue: (boolean | undefined)[]`，把每个 handler 的票留痕。

### 2.6 测试（3 条）

| 用例 | 钉住什么 |
|---|---|
| `#421: a handler BEFORE us that refused … the hold stands down` | 先来一次"缺席"边界教实例 → 再来一次 `continue:false`：`outcome peer-continue-false`、`reason` 逐字、`chainVote veto`、**零新增 sleep**、`take 0`、`owns 1`（说明闸门在接管之前） |
| `#421: on a host whose "nobody spoke" value IS false (pi 1.5.2) … behaves exactly as before` | `order`/`sleeps`/`result` 与无字段的对照 run **deepEqual**；唯一差别是 `chainVote: sentinel` vs `absent` |
| `#421: continue: true from an earlier handler is echoed, not invented` | 前置 `true` 时照旧 hold，`chainVote: "continue"` |

### 2.7 变异（3 条，全红）

| # | 变异 | 结果 |
|---|---|---|
| M421-1 | 删掉 `vote === "veto"` 闸门（回到无条件 `continue:true`） | **红**：`#421 … the hold stands down` |
| M421-2 | 任何 `false` 都读成 veto（忽略哨兵） | **红**：`#421 … pi 1.5.2 … behaves exactly as before` |
| M421-3 | 不记录 `chainVote`（回到静默覆盖） | **红** ×2：1.5.2 对照条 + `continue:true` 回声条 |

### 2.8 状态可见性（如实记录）

`legion-hold` 目前**没有** status/doctor 通道：`noticeQueueStats()` 在 `index.ts`/`legion-doctor.ts`/`legion-status.ts`/
`legion-commands.ts` 里零引用（它自己的注释写着 "no production consumer today"），`DoctorRuntimeSnapshot` 也没有 hold 字段。
所以 `hold skipped: peer continue:false` 今天是**写进 `PI_LEGION_HOLD_TRACE` 的 JSONL**（每条记录一行，含 `outcome`/`reason`/`chainVote`），
这就是 hold 当前唯一的"状态"。加一个 doctor 区块是一次独立改动，本 PR 不做（不做也不影响本 issue 的验收：记录已经是机器可读的）。

---

## 3. 测试与门禁

```
npm run typecheck        → exit 0
npm test                 → ℹ tests 2855   ℹ pass 2854   ℹ fail 0   (1 skipped)     ← 基线 2844
npm run test:integration → ℹ tests 193    ℹ pass 193    ℹ fail 0                   ← 基线 193
```

- 新增 **11** 条（`settle-hold.test.ts` 23 → 32，`runtime.test.ts` +2），**没有**跳过、没有削弱任何既有用例；
  唯一被改写的既有断言是 harness 的 `calls` 计数对象多了 `returns` 字段（并顺手把 `idle` 的 `deepEqual` 补成含 `returns: 0`），
  以及 `rule 2` 的结构扫描先把字符串字面量抹掉再扫（理由：`reason` 字符串按需求逐字引用了宿主的字段名，
  而"reason 不是 return"）。行为枚举那一半（9 条出口逐个跑）原样保留。
- 变异脚本 `/tmp/hg/mutate.sh`：每条"改 → 跑窄文件 → 恢复"，恢复后 32/32 + 2/2 绿。

改动面：

```
 index.ts                      |   5 +
 src/extension/hold.ts         | 124 +++++++++++++--
 src/extension/runtime.ts      |  82 +++++++---
 test/unit/runtime.test.ts     | 126 ++++++++++++++++
 test/unit/settle-hold.test.ts | 338 +++++++++++++++++++++++++++++++++++-
 scripts/spike/run.ts          |  12 ++   （+1 个测量用例 1i2-veto-first，供 #439 复现）
```

`deliverBatch` / 通知文案 / 闩锁写入路径**未动**：`armSettleFallback` 是原样抽出（同一段 payload、同一组守卫），
`holdReturnsBoundary` 的 body 只有一行调用。

---

## 4. 未做 / 已知残留

1. **#439 的硬缺口（1.5.2 上前置 veto 仍会被覆盖）**：见 §2.2/§2.5，需要宿主改。
2. **hold 结果没有 status/doctor 出口**：见 §2.8，本 PR 只保证 trace 可读。
3. **`SETTLE_FALLBACK_MS` 的重新武装在真机上看不到**（`agent_settled` 总会到、一到就取消）：只有注入式端到端能看到；
   真计时器用例已经用生产 `setTimeout` 覆盖这一点，但"宿主丢 settle"本身无法在真 pi 上人为制造。
4. `scripts/spike/` 仍是"可整目录删除"的实验目录（`hold-spike.md` §6），本次只往里加了 1 个用例作为 #439 的最小复现。

---

## 附录 A —— #439 的原始现场（`/tmp/hg/spike/<case>/spike.jsonl`）

```
=== 1f-no-hold ===
{"ext":"A","ev":"boundary:in","fires":1,"runStarts":1,"entriesIn":[],"continueIn":false,"canContinue":false,"pendingMessages":0,"hasPendingMessages":false,"hasSignal":false,"runMode":"print","outcome":"completed"}
{"ext":"B","ev":"boundary:in","fires":1,"runStarts":1,"entriesIn":[],"continueIn":false,"canContinue":false,"pendingMessages":0,"hasPendingMessages":false,"hasSignal":false,"runMode":"print","outcome":"completed"}
=== 1i2-veto-first ===
{"ext":"A","ev":"boundary:in","fires":1,"runStarts":1,"entriesIn":[],"continueIn":false,"canContinue":false,"pendingMessages":0,"hasPendingMessages":false,"hasSignal":false,"runMode":"print","outcome":"completed"}
{"ext":"B","ev":"boundary:in","fires":1,"runStarts":1,"entriesIn":[],"continueIn":false,"canContinue":false,"pendingMessages":0,"hasPendingMessages":false,"hasSignal":false,"runMode":"print","outcome":"completed"}
```

复跑：

```bash
SPIKE_OUT=/tmp/hg/spike node --experimental-strip-types scripts/spike/run.ts 1f-no-hold 1i2-veto-first
```

## 附录 B —— 真机 TUI 现场（`/tmp/hg/tui/`）

```bash
# 1) mock provider + 隔离 pi home（加载本 checkout）
RIG_OUT=/tmp/hg/tui node --experimental-strip-types /tmp/hg/rig/serve.ts &
# 2) pty 里跑真 TUI（脚本见 /tmp/hg/rig/drive.py）
RIG_OUT=/tmp/hg/tui python3 /tmp/hg/rig/drive.py
```

引擎脚本三段规则：`promptIncludes "automatic completion notice"` → 哨兵文本；`"run the sleep"` → `bash sleep 6`；
`"LAUNCH_ASYNC"` → `subagent({async:true})`。产物：`hold-trace.jsonl`、`pty.log`、`sessions/*.jsonl`、`summary.json`。

## 附录 C —— #438 的 print-mode 真机探针

```bash
node --experimental-strip-types /tmp/hg/real-probe.ts   # 真 pi + 真 legion 扩展，print 模式
# → {"ev":"hold:abstain","outcome":"mode","chainVote":"sentinel"}
```

这条同时说明两件事：改动能被真 pi 加载并执行（无异常退出，exit 0），以及 1.5.2 的链上投票确实是 `sentinel`（`false`）。
