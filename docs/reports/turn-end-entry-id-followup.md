# `turn_end hook skipped` 后续（#466）：触发条件、丢了什么、能不能避免

状态：**已实测（真宿主 1.6.0 + 真 `pi-async` 0.5.4 + 真产品路径）** — 2026-11-25
基线：`origin/master` `88df4cc`（6.2.13）
上游：#415（`docs/reports/turn-end-entry-id.md`，只做了归属与降级；本文不重复其结论）

门禁：本分支**只新增本文件**（`git show --stat` = 1 file, docs only）。`npm run typecheck` exit 0；
`npm test` = 3006 tests / 2971 pass / **14 fail** / 21 skipped —— 同样 14 个失败在**未改动的 `origin/master`
`88df4cc` 上逐条复现**（全部落在 cross-machine-discovery / worktree npm / `npm pack` / retire-sweep
这类依赖本机环境的用例上，与本文无关）；`test/unit/child-session.test.ts`（#415 的降级用例）15/15 绿。

---

## 0. 一句话结论（三问三答）

| 问题 | 结论 |
|---|---|
| **Q1 触发条件 / 命中率** | 触发条件只有一个：**`AgentSession.dispose()` 落在一轮 assistant 响应进行中**（发起 abort 之后、这条消息落盘之前）。SDK 夹具 10/10（三种落点：流式中 / 工具批次中 / 轮刚开始）；真实产品路径（真 `pi` 进程 + in-process child + `subagent stop`）**9/9**。abort 但**不** dispose = 0/10，空闲时 dispose = 0/10，没有扩展注册 `turn_end` = 0/10。**每次中断恰好 1 行。** |
| **Q2 丢了什么** | 丢两件，都是「这一轮被砍断」的直接后果：①`pi-async` 的 `flushPendingNotifications()` 在这一轮没跑（实测该任务 `notified=false`）；②这一轮最后的 assistant 消息本身**从未落盘**（child 转录 5 条 vs 对照 7 条）。**对用户没有可观察后果**：收件人就是正在被销毁的那个 child 自己的会话，实测既没漏掉父会话的任何唤醒，也没有重复通知（`notifyMessages` 0 vs 1）。唯一真瑕疵是一句空头支票（见 §3.4）。 |
| **Q3 能否避免** | 三个方向都可行，但**只有一个对**：**上游窄补丁 2 行**（`dispose()` 置标志 + 仅静音那条注定找不到 entry 的 `emitError`）——实测 V1/V2/V3 从 10/10 → 0/10，且 V4/V5 的 `turn_end` 派发逐项不变。**天真的上游写法（`_dispatchTurnEndBoundary` 开头直接 `return false`）是错的**：它会把一次本来合法的 `turn_end` 也关掉（V3 的 handler 触达 10/10 → 0/10）。pi-async 侧去掉 `turn_end` 注册也能彻底消掉这行，代价是每条完成通知多烧一个唤醒轮（转录 7 → 8 条）。legion 侧「先 `await abort()` 再 `dispose()`」能消除（0/10）且只要 ~1.7ms，但会把被中断的半条消息写进转录（7 → 9 条），**改变 `deriveOutcome` 的输入**，不推荐。 |

### 用户要不要担心这行字？

**不用。** 它出现在「一个后台子 agent 还在干活时被停掉」的那一刻，意思是「这一轮被砍断了，
宿主没来得及给这一轮的发消息钩子」，不是磁盘、模型或扩展坏了；子 agent 的收尾结论照样按
「被中断」记账，你的会话不会因此少一条通知（实测见 §3）。

---

## 1. 方法与夹具（可复现）

三套夹具，互补：

| 夹具 | 是什么 | 落盘位置 |
|---|---|---|
| **A. SDK 夹具** | 用宿主 **1.6.0 的真实编译产物**（`createAgentSession`，与 legion `defaultSessionFactory` 同一组参数）建会话，装**真的 `pi-async` 扩展**，再用 legion **真的** `attachChildSessionRelease` + `bindChildSessionExtensions` 装 sink；模型用仓库自带 mock LLM（`test/mock-llm`），prompt 走真 OpenAI 兼容流。 | `/tmp/issue466/base.mjs`、`q1-matrix.mjs`、`q2-loss.mjs` |
| **B. 真实产品路径** | 真 `pi` 1.6.0 进程（`dist/bundle/cli.js`）跑 `--print`，父会话用 `subagent` 工具在进程内 spawn child，再用 `subagent({action:"stop"})` 在 child 还在 `bash sleep 8` 时 retire。child 真继承 `pi-async`（`pi-async-owner` 文件为证）。 | `/tmp/issue466/w1/`（`RESULTS.md` + 19 次运行的 stderr/转录/请求流水） |
| **C. 补丁宿主** | 把 1.6.0 拷到 `/tmp` 打补丁，用 `I466_HOST_DIR` 指过去重跑 A。**原安装位零改动**（mtime 未变）。 | `/tmp/issue466/w2/`（`patch-P1.diff`/`patch-P2.diff`/`host-patched`） |

公共事实（三套夹具都成立）：

```js
// 宿主 1.6.0   agent-session.js
237: this._installAgentBoundaryHooks();                 // 构造期：把 agent.finishTurn 换成自己的钩子
584:   const extensionContinue = await this._dispatchTurnEndBoundary(turn.message, turn.toolResults);
546: async _dispatchTurnEndBoundary(message, toolResults) {
550:     if (!this._extensionRunner.hasHandlers("turn_end")) return false;   // ① 有人注册吗
552:     if (!messageEntryId) { emitError({ extensionPath: "<boundary>", event: "turn_end",
556:         error: "turn_end could not resolve the persisted assistant entry ID" }); return false; }  // ② 找不到 entry
877: _findPersistedMessageEntryId(message) { /* WeakMap → branch 反查 → 投影下标；两处 return undefined */ }
1074: dispose() {
1080:     this.agent.abort();          // 只是「请求」abort，不等它
1085:     this._extensionRunner.invalidate(...);
1086:     this._disconnectFromAgent(); // ← 从此 message_end 不再落盘
```

一条关键的时序事实（`pi-agent-core` `agent-loop.js:148-157`）：**被 abort 的 run 仍然会走
`finishTurn` → `emit(turn_end) → emit(agent_end)`**，只是那时 `_handleAgentEvent` 已经被
`dispose()` 退订，所以这一轮的 `message_end` 永远不落盘 → `_findPersistedMessageEntryId` 返回
`undefined` → 落进 ② 分支。

> 夹具纪律（踩过的坑，写下来避免后人重犯）：
> 1. `startMockLlm()` 的 `url` 是**函数**（`url(p?)`），不是字符串；写成 `` `${server.url}/v1` `` 会让所有请求
>    `Invalid URL` 失败——此时每一轮都立刻 `stopReason: "error"`，,**看起来**仍然复现了本条日志。第一版矩阵就是
>    这么错的（当时 V1/V2 也是 10/10），修好 URL 后重跑才拿到本文的数字。
> 2. 六个变体**必须逐变体隔离跑**。整跑时后面的变体可能拿不到 mock 的 tool_call（共享 mock server 状态），
>    V3 的闸门根本没触发 → 假 `0/10`。本文所有 V3 数字都来自单变体隔离跑（`iso-V3-*.log`）。

---

## 2. Q1：触发条件与命中率

### 2.1 确定性条件

> **`dispose()` 落在「一轮 assistant 响应进行中，且这条消息尚未落盘」的窗口里。**

等价说法：`dispose()` 与 `agent.abort()` 不是一回事。`abort()`（`agent-session.js:2082-2093`）会
`await waitForIdle()`，落盘订阅还活着 → 被中断的消息会落盘 → **不触发**。`dispose()` 是先
`agent.abort()`（只发请求）再 `_disconnectFromAgent()`（掐掉落盘），于是「被中断的那一轮」在
**订阅已死**之后才收尾 → 必然找不到 entry。

### 2.2 命中率（SDK 夹具，每变体 N=10，真宿主 1.6.0）

| 变体 | 触发落点 | 命中 | 后 dispose 仍被触达的 handler（run 1） |
|---|---|---|---|
| **V1** | `dispose()` @ `message_start`（流式中） | **10/10** | `session_shutdown` \| `agent_before_settle`**(ctx STALE)** \| `agent_settled`**(ctx STALE)** |
| **V2** | `dispose()` @ `turn_start`（轮刚开始、还没吐字节） | **10/10** | 同上 |
| **V3** | `dispose()` @ `tool_execution_start`（工具批次中） | **10/10**（隔离跑） | `session_shutdown` \| **`turn_end`(ctx STALE)** \| `agent_before_settle`(STALE) \| `agent_settled`(STALE) |
| **V4** | `abort()` @ `message_start`（**不** dispose） | **0/10** | `turn_end` \| `agent_settled`（ctx 正常） |
| **V5** | `dispose()` @ `agent_settled`（一轮已跑完、空闲） | **0/10** | `turn_end` \| `agent_before_settle` \| `agent_settled` \| `session_shutdown` |
| **V6** | 同 V1，但 **child 不加载 `pi-async`** | **0/10** | （无） |

原始输出（`/tmp/issue466/matrix-10.log`，V3 逐行数字见 `/tmp/issue466/w2/v3only-realhost-N10.log`）：

```text
V1 dispose at message_start (mid-stream): 10/10 runs printed the line
    sample: [pi-legion] in-process child u2-automation turn_end hook skipped: turn_end could not resolve the persisted assistant entry ID (this turn's assistant message has no persisted entry, so the host ran no turn_end handler)
    handlers reached (run 1): session_shutdown | agent_before_settle(ctx STALE) | agent_settled(ctx STALE)
    public events (run 1): agent_start -> turn_start -> message_start -> message_end -> message_start

V4 abort() at message_start (NOT dispose): 0/10 runs printed the line
    handlers reached (run 1): turn_end | agent_settled

V6 dispose at message_start, pi-async NOT loaded: 0/10 runs printed the line
    handlers reached (run 1): (none)
```

读法：
- V2 也命中 → 闸门不是「吐了多少字节」，而是「这一轮的 assistant 消息还没落盘」。
- V3 也命中，但**同一轮里 `turn_end` handler 先被正常触达了一次**（`turn_end(ctx STALE)`）——说明
  「dispose 之后的所有 turn_end 都不跑」是错的：跑不跑取决于**那条消息有没有 entry**。
- V6 = 0/10 是归属判据：同样的 abort、同样的 dispose、同样的 legion sink，只少了 `pi-async`，
  这行就不出现 → 宿主的 gate 是 `hasHandlers("turn_end")`（`agent-session.js:550`），而唯一注册者
  是 `pi-async`（`extensions/index.ts:489`），与 #415 的归属完全一致。

### 2.3 真实产品路径（真 `pi` 1.6.0 + in-process child + `subagent stop`）

| 臂 | 场景 | 命中 |
|---|---|---|
| `inflight` | child 在 `bash sleep 8` 中被子会话 `stop` | **6/6**（每次恰好 1 行） |
| `inflight-turn2` | child 第 1 轮健康跑完，**第 2 轮**在 `sleep 8` 中被 stop | **3/3**（健康那轮 0 行） |
| `settled` | child 正常收尾后再 retire | **0/5**（stderr 空文件） |
| `no-registrant` | 同 `inflight`，但 child 不继承 `pi-async` | **0/5** |

合计 in-flight retire **9/9**，两个对照 **0/10**。原始 stderr（`runs/inflight-0/parent.stderr.log` 全文）：

```text
[pi-legion] in-process child victim extension error: builtin:codemode prepare_loadout: This extension ctx is stale after session replacement or reload. ...
[pi-legion] in-process child victim turn_end hook skipped: turn_end could not resolve the persisted assistant entry ID (this turn's assistant message has no persisted entry, so the host ran no turn_end handler)
```

「child 当时真的在跑」不是靠时间猜的，三条独立证据：
- mock 请求流水：child 的 `sleep 8` 在 `03:55:25.46` 开始，`stop` 落在 `03:55:30.00`（早于完成 ~3.5s），
  6 次运行的「该轮开始 → stop」全在 4.52–4.59s，没有一次踩边界；
- child 转录：`… message assistant(toolUse bash sleep 8)` 之后**没有 toolResult、没有后续 assistant**；
- `run.json` 里 `"supervisor": "inprocess"`，且 child 的 pi-async 数据目录存在（`no-registrant` 臂没有）。

### 2.4 现场（用户日常会不会碰到）

在用户自己的 `~/.pi/agent/sessions` 里直接搜到这行，涉及 **3 个不同的 agent 卡片**：

| 时间 | child 名 | 出现位置 |
|---|---|---|
| 2026-11-23T19:06:00Z | `worker-fe` | 父会话的 toolResult（正在跑的子 agent 的 TUI 快照） |
| 2026-11-25T03:32:28Z | `hygiene-doctor` | 父会话的 toolResult |
| （本次任务描述） | `u2-automation` | 用户现场 |

即：**每次「你把还在干活的后台子 agent 停掉」都会出现一次**，与卡片无关。这也解释了为什么它看起来
「偶发」——它偶发于**你的操作**，而不是机器状态。

### 2.5 频率

- 一次中断 = **1 行**（SDK 夹具 10/10 每次 1 行；真实路径 9/9 每次恰好 1 行）。
- 只有当这个 run 在 dispose 之后仍然继续产出新轮时，才会每多一轮多一行：一次受控实验（`I466_MODE`
  对拍）里正常 retire 是 1 行；把 mock 写成「每轮都发工具调用」的失控脚本后才出现大量重复行——
  那种情形需要「run 在 dispose 之后还被 followUp 不断唤醒」，现实里只有扩展自己在唤醒它才会发生。

---

## 3. Q2：这一轮 `turn_end` 没跑，丢了什么

### 3.1 `turn_end` 上到底挂了什么

`pi-async` **全仓只有一处**注册（`extensions/index.ts:489`），且 `src/**` 里 `turn_end` 出现 **0 次**：

```ts
context.on("turn_end", () => { flushPendingNotifications(); return undefined; });
```

`settle-guard` / `hold` / `print-wait` / `nudges` **都不挂 `turn_end`**，它们挂的是
`agent_before_settle` / `agent_start` / `agent_settled` / `session_shutdown`
（`settle-guard.ts:206-210`、`hold.ts:610-614`、`print-wait.ts:366-372`）。

所以「这一轮丢了什么」= **丢了这一轮的 `flushPendingNotifications()`**，外加 **这一轮最后的
assistant 消息本身没落盘**。activity / rail / hold 行状态**不受影响**（它们根本不在这条路径上，
且 `ui.setActivity` 是 write-only、`decideBeforeSettle` 明确不读 activity：`bus.ts` 头注释、
`settle-guard.ts:119-121`）。

### 3.2 实测：真 `pi-async` + 真的后台任务 + 真的 dispose

场景（三臂共用）：child 第 0 轮 `async_run` 起一个 0.2s 的后台任务 → 第 1 轮 `bash sleep 3`（run 还活着）
→ 任务在 run 中途 finalize（完成通知入队）→ **900ms 时 dispose**（此刻正卡在 `sleep 3` 里）。

| 臂 | 命中 | 任务行（磁盘） | child 转录 | 通知消息 |
|---|---|---|---|---|
| A. legion 真路径 retire（先 `session_shutdown` 再 dispose） | 1 行 | `completed / notified=false / attempts=0` | 5 条消息，无 `ALL_DONE` | **0 条** |
| B. 裸 `dispose()`（不先发 `session_shutdown`） | 1 行 | `completed / notified=false / attempts=1` | 5 条消息 | **0 条** |
| C. 对照：不 dispose，让这一轮跑完 | 0 行 | `completed / notified=true / attempts=1` | 7 条消息，含 `ALL_DONE` | **1 条** |

原始日志（`/tmp/issue466/q2-loss-2.log`，各臂 2 次，逐字节一致）：

```text
=== legion dispose@900ms
  skip lines: 1   other pi-legion lines: 0
  task rows: completed/notified=false/attempts=0
  transcript: messages=5 notifyMessages=0 hasALLDone=false
    log: [pi-legion] in-process child u2-automation turn_end hook skipped: turn_end could not resolve the persisted assistant entry ID ...

=== rawSessionDispose@900ms (no session_shutdown emit)
  task rows: completed/notified=false/attempts=1
    log: pi-async: completion notification failed for cc8dd4d7-…; it will be re-sent on the next session_start
    log: [pi-legion] in-process child u2-automation turn_end hook skipped: ...

=== control (no dispose)
  task rows: completed/notified=true/attempts=1
  transcript: messages=7 notifyMessages=1 hasALLDone=true
```

三件事由此钉死：

1. **通知确实没送达**（A 臂 `notified=false`）。它没被"尝试"过（`attempts=0`），因为 legion 的
   retire 会在 `dispose()` 之前先发 `session_shutdown`（`child-session.ts:242-261`），而 `pi-async`
   在 `session_shutdown` 里**按设计**清空内存队列（`extensions/index.ts:504-507`：
   `pendingNotifications.clear(); runActive = false;`）。
2. **替代触发点是真的存在、真的会被调用，但在 destroy 路径上必然失败**（B 臂）：不先发
   `session_shutdown` 时，`agent_before_settle` / `agent_settled` 仍然被触达（§2.2 的 handler 列表），
   `pi-async` 也确实尝试发送（`attempts=1`），但那时 `ctx` 已 stale（`invalidate()` 在
   `agent-session.js:1085`），于是落一句
   `pi-async: completion notification failed for …; it will be re-sent on the next session_start`。
3. **没有重复通知**：C 臂恰好 1 条通知消息、`notified` 一次置 true；A/B 臂 0 条。`claimNotification`
   只做内存去重、`notified`/`consumedAt` 落盘（`registry.ts:946-951`、`926-939`），实测没有出现
   「两条一样的通知」。

### 3.3 结论：丢了 X，后果 Y

> **丢了这一轮的 `flushPendingNotifications()`（即「本轮内以 `steer` 投递完成通知」的机会），
> 以及这一轮最后的 assistant 消息。后果：这个 child 的完成通知不会被投递给任何人——因为它的收件人
> 就是正被销毁的这个 child 自己的会话；父会话、其他 child、用户界面都不欠这一条。实测证据是
> `notified=false` 而不是「父会话少了一次唤醒」。**

两条独立佐证「没有用户可见后果」：

- **收件人不存在**：`pi-async` 的通知由 `pi.sendMessage(...)` 发给**自己所在的会话**（`notify.ts`），
  而 child 会话在这一刻正在被销毁；`resendUnnotified` 的补偿要求「同一 session 的下一次
  `session_start`」（`registry.ts:1085-1108`，上限 24h / 2 次尝试），in-process child 永远不会
  重启同一个 session —— 所以它是「永久不投递」，但**投给谁呢**。
- **判决口径不受影响**：`deriveOutcome` 在 `supervisor.retire()` **之前**跑完
  （`orchestrator.ts:4583/4604` → `4607` retire），所以 dispose 之后才可能写进转录的那点东西
  不参与判决。而且「最后一轮没有 assistant 消息」本身就是 legion 用来判 `aborted` 的信号
  （`shared/session.ts:1112-1124`，`NO_ASSISTANT_ABORT_REASON`）——**这条消息的缺席与「被中断」
  这个事实是自洽的**，不是判决依据被偷走。

### 3.4 唯一真瑕疵（不是用户可见后果，但值得记一笔）

B 臂那句 `it will be re-sent on the next session_start` 在这个场景是**空头支票**：能走到
`session_start` 的只有「同一 session 的下一次启动」，而被 dispose 的 in-process child 没有下一次。
建议（不在本 issue 实现）：`pi-async` 在 ctx 已 stale 时不要把这句话当承诺写进日志。

---

## 4. Q3：三个方向的可行性

### 4.1 方向 1：`pi-async` 幂等 + 可缺失 —— **现状已经幂等**，可再往前走一步

- **现状**：错过 `turn_end` 不会立刻丢通知。三个 flush 点全是无条件注册、且 `flushPendingNotifications`
  先 `clear()` 再逐个 `send()`（`extensions/index.ts:228-236`），`deliverAs` 在 `send()` 调用时才求值
  （`:391`，`runActive ? "steer" : "followUp"`）。实测 B 臂就是这条路径：`attempts=1`。
- **更彻底的做法**（可选）：**干脆不注册 `turn_end`**。实测把 `pi-async` 副本的那一行去掉后：

  | | 注册 turn_end（现状） | 不注册（副本实测） |
  |---|---|---|
  | `hasHandlers("turn_end")` | `true` | **`false`** |
  | 这行日志 | 可能出现 | **永远不可能出现**（宿主 gate 直接早退） |
  | 完成通知是否送达 | 送达（`notified=true`, 1 条） | **照样送达**（`notified=true`, 1 条） |
  | 送达形态 | `steer`（不额外烧轮） | `followUp`（**多一个唤醒轮**：转录 7 条 → 8 条） |

  ⇒ 可行，代价 = 每条完成通知多一个 turn 的唤醒成本。是否值得，取决于「早一轮拿到通知」值不值那个 turn。
  **注意**：这只是消掉日志，不改变任何「丢不丢」的结论（§3）。

### 4.2 方向 2：legion 侧生命周期（`await abort()` 再 `dispose()`）—— 能消，但**不建议**

| | 直接 dispose（现状） | `await session.abort()` → `dispose()` |
|---|---|---|
| 命中 | 10/10（工具批次中也是 10/10） | **0/10**（工具批次中 0/5） |
| 额外耗时（中位数） | — | `abort()` **1.73ms**（[1.29, 3.43]，低负载；同机有别的 worker，噪声大） |
| child 转录 | 7 条（受控实验） | **9 条** |

代价不在毫秒，而在**语义**：`abort()` 会让这一轮**正常收尾**（`turn_end` 干净派发、`agent_settled` 先于
`session_shutdown`），而 `dispose()` 是直接掀桌（`agent_before_settle`/`agent_settled` 带 `ctx STALE`、
`turn_end` 不派发）。而且被中断的**半条 assistant 消息和一个 error toolResult 会被写进 child 的转录**——
那正是 `deriveOutcome` 的输入（`turns` +1、`toolErrors` +1、`lastTurn.stopReason` 从「无 assistant 消息」
变成 `aborted`，`reason` 字符串也换一套）。也就是「为了消一行日志，改掉子 agent 判决的取证材料」。
另有延迟风险：实测的 ~2ms 只成立于「abort 能立即打断」（mock 流很快、工具是 `sleep`）；真 child 若卡在
不可取消的等待（外部 HTTP 工具不响应 `signal`）或 settle 阶段有慢 handler，`waitForIdle()` 要等那个
handler 结束，`abort()` 就不再是 ms 级 —— retire 同步路径上用它得先给 `waitForIdle()` 加超时。**不推荐**
（若要采用，必须单独跑判决回归）。

### 4.3 方向 3：上游修复 —— **可行，且是推荐方向；但必须窄**

两种写法都实测过（补丁只改 `dispose()` + `_dispatchTurnEndBoundary` 两处，2 个 hunk）：

| 补丁 | 做法 | V1/V2 命中 | V3 命中 | V3 的 `turn_end` handler 触达 | V4/V5 |
|---|---|---|---|---|---|
| **P1（天真）** | `dispose()` 置标志；`_dispatchTurnEndBoundary` 里 `if (this._i466Disposed) return false;` | 10/10 → **0/10** | 10/10 → 0/10 | **10/10 → 0/10 ❌ 被误杀** | 不变 |
| **P2（推荐）** | `dispose()` 置标志；**只**在「找不到 entry」那条 `emitError` 外面加 `if (!this._i466Disposed)` | 10/10 → **0/10** | 10/10 → **0/10** | **10/10 → 10/10 ✅** | 不变（`turn_end` 照常触达） |

P1 的问题正是本文最有用的负面结论：**dispose 之后并非所有 `turn_end` 都不该跑**。V3 里被 abort 的
是工具批次，而带 toolCall 的那条 assistant 消息在 dispose 之前就已经落盘，所以那一轮的
`turn_end` 是**合法派发**（只是 ctx 已 stale）。一句 `return false` 把它一起关掉，等于把扩展本来
能收到的一次真实边界吞了——这正是 #415 §4 里「匹配宽度必须卡死」的同一条道理，只是这次发生在宿主侧。

推荐 P2（2 行，语义 = 「会话已经销毁了，就不要再把一条无法解析的边界当扩展错误上报」），
原始 diff：`/tmp/issue466/w2/patch-P2.diff`。两个位置是有讲究的：

- `_i466Disposed` 必须置在 `agent.abort()` **之前**（否则被 abort 的 run 回到 `finishTurn` 时读不到）；
- 静音点放在 `!messageEntryId` 分支**内部**，于是 `_lastActivityOutcome` 的赋值与
  `_findPersistedMessageEntryId` 的查询完全保持原样：只有「已销毁 + entry 丢失」这一种组合不再报错，
  **未销毁**时 entry 丢失照常报错（不掩盖真 bug）。

副作用核对：V1 的 `agent_before_settle`/`agent_settled` 仍然触达（10/10，仍带 `ctx STALE`），即补丁没有
掩盖 dispose 之后的 stale-ctx 使用权问题（那是另一件事，见 `builtin:codemode … stale ctx` 那行）。

P2 的诚实边界：它只**静音日志**，不改「被 abort 的那一轮 `turn_end` 仍然不会被派发」这个更深的语义缺口
—— 如果上游希望这种情况下 handler 也能跑，需要的是「合成 entry」或显式的 `turn_end(synthetic)` 语义，
而不是沉默。本条留作上游决策，不在本 issue 范围。

### 4.4 三方向对照

| 方向 | 消除日志 | 代价 | 谁能做 | 建议 |
|---|---|---|---|---|
| 1. `pi-async` 不注册 `turn_end` | ✅（gate 直接早退） | 每条通知多一个 turn | pi-async | 可选；先量「早一轮」的价值 |
| 2. legion `abort` 再 `dispose` | ✅ | 改判决取证（转录 +2 条、toolErrors +1） | legion | **不推荐** |
| 3. 上游窄补丁 P2 | ✅ | 2 行；无行为回归（P2 实测） | pi 宿主 | **推荐** |

---

## 5. 需要另开 issue 的事（本次不实现）

1. **pi 宿主**：`dispose()` 之后不应把「entry 解析不到」报进 `onError`（P2 那 2 行）。
2. **pi-async**（可选，小）：ctx 已 stale 时不要打印 `it will be re-sent on the next session_start`
   ——对一个正在销毁、不会再 `session_start` 的会话，这是空头支票。
3. **本仓库**（可选）：`retireChild` 注释里补一句「dispose 打在 turn 中会产生宿主
   `<boundary> turn_end` 记录（已降级为 skip），这是预期」——避免下次再有人把它当扩展故障排查。
4. 「dispose 之后 `agent_before_settle` / `agent_settled` / 一次合法 `turn_end` 仍被派发给已
   stale 的 ctx」是独立问题（本次现场日志的第一行 `builtin:codemode … stale ctx` 就是它），
   与 #466 同源但不同事，建议单独跟。

---

## 6. 未实测 / 诚实边界

1. **真实模型没参与**：三套夹具的 LLM 都是脚本化 mock。「9/9」回答的是「真产品路径上是否稳定复现」，
   不是「线上百分之几的 retire 会打这行」——后者取决于真实模型恰好在响应/工具期间被 stop 的比例。
   但用户自己会话里已经出现 3 次（§2.4），所以「日常会碰到」是事实，不是推算。
2. **retire 的触发形态**只实测了 `subagent({action:"stop"})` 与库级 `session.dispose()`。
   父进程被 SIGTERM（`shutdownRetireAll` 有 5s 预算）与 `disposeRecord` 的 fire-and-forget
   没有实测，理论同路径，但不写进结论。
3. **方向 2 的耗时**是在同机有别的 worker 跑着时量的（load 2.5–4.2），且 mock 流快、工具是 `sleep`
   （abort 能就地取消），只能当**理想上界**；真 child 卡在不可取消的等待时 `waitForIdle()` 会显著更慢，
   不能把 1.7ms 当作 retire 的常态成本。
4. **方向 1 的「多一个唤醒轮」**只在「任务在 run 中途 finalize」的场景量过（7 vs 8 条消息）；
   任务恰好在 settle 之后才 finalize 的情形两者等价。
5. **`consumedAt` 的交互**未单独实测：若父会话此前已经把该 child 的终态「消费」过，
   `resendUnnotified` 本来就会跳过（`registry.ts:1092`），与本日志无关。
6. 宿主 1.6.0 之上是否有更新版本已经修了「dispose 后仍收尾一轮」，未核对（本次只对比了
   1.5.0 / 1.5.2 / 1.6.0：三段相关函数逐字节相同）。
7. 本机 `npm test` 的 14 个失败与本文无关，但也没有被修（不在本次范围）：见页首门禁一行的对照。

---

## 7. 复现清单

```bash
# A. SDK 夹具（真宿主 1.6.0 + 真 pi-async + legion 真 sink）
cd /tmp/issue466
timeout 900 node --experimental-strip-types q1-matrix.mjs 10      # 六变体矩阵（逐变体隔离跑更稳）
timeout 400 node --experimental-strip-types q2-loss.mjs 2         # 丢什么：A/B/对照 三臂
I466_PI_ASYNC=/tmp/issue466/pi-async-nop node --experimental-strip-types q3-no-turnend.mjs  # 方向 1
I466_MODE=abort-dispose node --experimental-strip-types q1-amplifier.mjs                    # 方向 2 副作用

# B. 真实产品路径（真 pi 进程 + in-process child + subagent stop）
cd /tmp/issue466/w1 && for i in 0 1 2 3 4 5; do timeout 120 node --experimental-strip-types run.mjs inflight $i; done
grep -c 'turn_end hook skipped' runs/inflight-*/parent.stderr.log

# C. 补丁宿主
cd /tmp/issue466 && I466_HOST_DIR=/tmp/issue466/w2/host-patched/@earendil-works/pi-coding-agent \
  timeout 600 node --experimental-strip-types q1-matrix.mjs 10
```

所有实验产物：`/tmp/issue466/{matrix-10.log,q2-loss-2.log,w1/RESULTS.md,w1/runs/,w2/RESULTS.md,w2/*.log,w2/patch-P*.diff}`。
仓库与 `~/.pi/agent/install` **零改动**（`git status --porcelain` 空；安装位 mtime 未变）。
