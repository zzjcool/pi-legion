# hold-spike — legion 能否借鉴 pi-async 的 settle hold（issue #417）

**结论先行：能借鉴，但不能照抄。** 宿主给 `agent_before_settle` 的是「一条串行 handler 链 + 每次 settle 只允许一次续跑」，
不是「一次各挂各的并行等待」。三个可直接落地的判定见 §4。

| 项 | 值 |
|---|---|
| 被测宿主 | `pi 1.5.2`（`/root/.pi/agent/npm/node_modules/@earendil-works/pi-coding-agent`） |
| 参照实现 | `pi-async@0.5.0` `src/guard/hold.ts`（`/root/code/pi-async`） |
| 仓库基线 | `pi-legion` @ `b720fdf`（本报告基于此提交） |
| 实验产物 | `/tmp/hold-spike/<case>/`（`spike.jsonl` / `mock.jsonl` / `session.jsonl` / `summary.json`） |
| 实验脚本 | `scripts/spike/`（**可整目录删除**，见 §6） |
| 产品代码改动 | **零行**。全文只读宿主 dist + 新增 `scripts/spike/` 与本报告 |

**先说一个术语纠正**：任务书里写的 `before_settle` 在宿主里不存在。真实钩子名是 **`agent_before_settle`**
（`pi-coding-agent/dist/core/extensions/types.d.ts:1101` 的 `ExtensionEvent` 联合）。
下文一律用真名。

---

## 0. 方法：怎么把「两个扩展同时挂起」搬到一个可复现的现场

三个实验共用一个 rig：

```
真实 pi 子进程 (--print --mode text)
  ├── --extension scripts/spike/ext-a.ts     ← registrant A（env 配置行为）
  ├── --extension scripts/spike/ext-b.ts     ← registrant B（独立扩展，不是同文件两次加载）
  └── --model mock/flash  →  scripts/spike/logged-mock.ts
                              （复用 test/mock-llm 的 SSE 编码，但逐请求记录 messages 全文，
                                这样才能测出「注入的消息第几个 provider 请求才到达」）
```

`ext-a/b` 的行为全部由环境变量驱动（`SPIKE_<ID>_ITERS/_HOLD_MS/_MODE/_WATCH/_SEND_AT_MS/_ABORT_AT_MS`），
一个文件覆盖全部 case，避免多次改代码引入偏差。每个 handler 回调都把
`{fires, runStarts, entriesIn, continueIn, canContinue, pendingMessages, hasPendingMessages, hasSignal, runMode, outcome}`
写进 JSONL，实验结束后与 mock 请求日志、session transcript 按毫秒时间戳对齐。

复跑：`node --experimental-strip-types scripts/spike/run.ts --list` 看用例，`... run.ts 1a-a-only` 跑单条。

### 0.1 宿主语义基线（读 dist + 实测，二者一致）

| # | 事实 | 出处 | 是否实测 |
|---|---|---|---|
| H1 | 钩子名 `agent_before_settle`，返回 `BoundaryResult { entries?, continue? }` | `types.d.ts:806-824` | 是 |
| H2 | 多 handler **串行 await**，顺序 = 扩展加载顺序 × 注册顺序 | `runner.js:773-782` | 是（1j） |
| H3 | 每个 handler 收到 `{...base, entries, continue, context}` —— **前面 handler 的产出** | `runner.js:775-780` | 是（1b、1d、1e） |
| H4 | 返回的 `entries` 是**整体替换**，宿主不合并；`continue` 是**最后一次定义生效** | `runner.js:783-786` | 是（1d/1e/1i） |
| H5 | `continue:true` → `agent.continue()` → **重新开一次 agent run**，该 boundary 会被**再次派发** | `agent-session.js:1514-1526` | 是（全用例） |
| H6 | 一次 boundary 只产生**一次**续跑，与多少个 handler 要求续跑无关 | `agent-session.js:1636-1648` | 是（1a vs 1b） |
| H7 | `continue:true` 但**没有** draft → 被拒：`agent_before_settle requested continuation without runnable model context`，直接 settle | `agent-session.js:1642-1647` | 是（1g） |
| H8 | 任意 handler 的 draft 让 context 构建失败 → **整份**结果丢弃（`{entries:[], continue:false, valid:false}`） | `runner.js:796-813` | 否（未构造出坏 draft） |
| H9 | 全程**无超时、无 watchdog**；`abort()` 只置标志，要等 handler 自己返回 | `agent-session.js:2073-2084` | 是（3a/3b） |
| H10 | boundary 执行期间 `ctx.signal === undefined` | `agent-session.js:2914` + 实测 | 是（全部用例 `hasSignal:false`） |
| H11 | run 被 abort 时，**已返回的 entries 仍会落盘**，续跑被抑制 | `agent-session.js:1637-1641` | 是（3a/3b） |
| H12 | `ctx.hasPendingMessages()` 读的是 **session 队列**（用户消息），不是 `agent.peekQueuedMessages()`（custom_message） | `agent-session.js:2922` + `:2056` | 是（2b vs 2c） |

---

## 1. 两个扩展同时注册 `agent_before_settle`

### 1.1 方法

同时加载 `ext-a` + `ext-b`，两者各自在 boundary 里等待若干毫秒后返回
`{ entries: [...event.entries, draft], continue: true }`（与 pi-async `hold.ts:573-575` 完全同款），
通过改变各自的预算 / 返回形状制造各组合。观测量：provider 请求数（每次续跑 = +1 请求）、
每个 handler 被调用次数、transcript 里 `custom_message` 条数与顺序。

### 1.2 原始输出

```
── 1f-no-hold  (exit=0 wall=432ms requests=1)          ← 两个 registrant，都不 hold
   boundary handler calls: 2  first 2: A#1(run1)[in=[] c=false] B#1(run1)[in=[] c=false]
   transcript custom entries (0): (none)

── 1a-a-only  (exit=0 wall=1078ms requests=3)          ← 只有 A，hold 2 次
   boundary handler calls: 3  first 3: A#1(run1)[in=[] c=false] A#2(run2)[in=[] c=false] A#3(run3)[in=[] c=false]
   holds: 2 → A#1 hold-ms 201ms | A#2 hold-ms 200ms
   transcript custom entries (2): spike-a-hold, spike-a-hold

── 1b-both-hold  (exit=0 wall=1298ms requests=3)       ← A、B 各 hold 2 次（双挂起）
   boundary handler calls: 6  first 6: A#1(run1)[in=[] c=false] B#1(run1)[in=["spike-a-hold"] c=true]
                                      A#2(run2)[in=[] c=false] B#2(run2)[in=["spike-a-hold"] c=true]
                                      A#3(run3)[in=[] c=false] B#3(run3)[in=[] c=false]
   holds: 4 → A#1 199ms | B#1 200ms | A#2 200ms | B#2 201ms
   transcript custom entries (4): spike-a-hold, spike-b-hold, spike-a-hold, spike-b-hold
```

**1a 与 1b 的 requests 都是 3。** 这就是「pi 会不会继续两次」的直接答案：**不会**。

```
── 1c-a-long-b-short  (exit=0 wall=1412ms requests=5)  ← A 预算 4，B 预算 2（不等长）
   boundary handler calls: 10
   transcript custom entries (6): spike-a-hold, spike-b-hold, spike-a-hold,
                                  spike-b-hold, spike-a-hold, spike-a-hold

── 1h-unequal-order  (exit=0 wall=633ms requests=2)    ← A 立即放行，B hold 1 次
   transcript custom entries (1): spike-b-hold

── 1i-veto  (exit=0 wall=778ms requests=1)             ← A hold，B 返回 continue:false
   boundary handler calls: 2  first 2: A#1[in=[] c=false] B#1[in=["spike-a-hold"] c=true]
   transcript custom entries (1): spike-a-hold          ← draft 落盘了，但请求数=1，续跑被取消
```

```
── 1d-b-replace  (exit=0 wall=681ms requests=2)        ← A spread，B 返回裸列表
   transcript custom entries (1): spike-b-hold          ← A 的 draft 被静默删除

── 1e-a-replace-b-spread  (exit=0 wall=751ms requests=2) ← A 返回裸列表，B spread
   transcript custom entries (2): spike-a-hold, spike-b-hold

── 1j-order-ba  (exit=0 wall=716ms requests=2)         ← 加载顺序反转为 B、A
   transcript custom entries (2): spike-b-hold, spike-a-hold

── 1g-bare-continue  (exit=0 wall=531ms requests=1)    ← 只返回 continue:true，不带 draft
   stderr: Extension error (<boundary>): agent_before_settle requested continuation without runnable model context
```

### 1.3 一条会让实现直接翻车的意外发现

第一版 `ext-*` 把预算计数器在 `agent_start` 里归零（**这正是 pi-async `hold.ts:543/609-611`
`heldThisGeneration` 的写法**）。结果是无限循环：

```
── 1a-a-only  (exit=143 wall=61507ms requests=189)     ← 60s 被我 SIGTERM 掉
   ('A','agent_start') 278   ('A','boundary:in') 278   ('A','agent_settled') 1
   transcript custom entries: spike-a-hold × ~278
```

原因：`continue:true` 会**重新开一次 agent run**（H5），于是 `agent_start` 在每一跳都再触发一次，
「每 run 一次」的闩锁被自己的续跑不断重置。**pi-async 能活下来，是因为它的退出条件是「任务终态」
而不是次数**；任何「按次数/按 run 计数」的闩锁在这个钩子上都是失效的（实测 278 跳 / 60s）。

### 1.4 结论（一句话可执行）

> 把 `agent_before_settle` 当成**一条链**而不是广播：一次 settle 只有**一次**续跑机会，
> 所有 holder 在同一跳里**串行排队**（延迟相加，实测 1b：200+200 而非 max(200,200)），
> 所以 legion 必须做**唯一 owner**——`continue:false` 会静默取消别人的 hold（1i），
> 返回裸 `entries` 会静默删除别人的 draft（1d），而 `undefined` 是安全弃权（1h）。

---

## 2. hold 期间的消息投递延迟

### 2.1 方法

rig 同上。`ext-a` 在 `agent_start` 后 `+300ms` 发一条带 `SPIKE_FOLLOWUP` 标记的消息
（`pi.sendMessage(..., { triggerTurn: true, deliverAs: "followUp" })`，即 legion 现状的
`src/extension/notify.ts:732` 同款参数），mock 端记录**第一个含该标记的 provider 请求**的时刻，
延迟 = 该时刻 − 发送时刻。四组各 3 次：

| 组 | 现场 | 消息类型 | hold 是否可被抢占 |
|---|---|---|---|
| 2d | **对照组**：无 hold，provider 故意慢 1.5s（turn 天然变长），+300ms 投递 | custom | — |
| 2a | 6s hold，hold **不**看任何 pending 信号 | custom | — |
| 2b | 6s hold，hold 每 50ms 轮询 `ctx.hasPendingMessages()` | custom | 想抢，但探针是瞎的 |
| 2c | 6s hold，同上轮询 | **用户消息**（`sendUserMessage`） | 抢到了 |

### 2.2 原始输出

```
── 2d-control-no-hold (3 次)
   send@1795074508354 firstSeenAtProvider@1795074509649 (req#2) latency=1295ms
   send@1795074521431 firstSeenAtProvider@1795074522723 (req#2) latency=1292ms
   send@1795074525910 firstSeenAtProvider@1795074527190 (req#2) latency=1280ms

── 2a-hold-blind (3 次，hold 6000ms)
   holds: 1 → A#1 hold-ms 6001ms
   send@1795074420475 firstSeenAtProvider@1795074426258 (req#3) latency=5783ms
   send@1795074433813 firstSeenAtProvider@1795074439613 (req#3) latency=5800ms
   send@1795074447166 firstSeenAtProvider@1795074452953 (req#3) latency=5787ms

── 2b-hold-watch-pending (3 次，hold 6000ms + 轮询 ctx.hasPendingMessages())
   holds: 1 → A#1 hold-ms 6048ms              ← reason 仍是 hold-ms，探针全程没亮
   send@1795074427037 firstSeenAtProvider@1795074432865 (req#3) latency=5828ms
   send@1795074440386 firstSeenAtProvider@1795074446216 (req#3) latency=5830ms
   send@1795074453707 firstSeenAtProvider@1795074459543 (req#3) latency=5836ms
   ↑ 同一 boundary 里后一个 handler 看到的 event.context 却已经有 1 条 pending：
     {"ev":"boundary:in","ext":"B","pendingMessages":1,"hasPendingMessages":false}

── 2c-hold-user-msg (3 次，同样轮询，但发的是用户消息)
   holds: 1 → A#1 pending-message 250ms
   send@1795074520686 firstSeenAtProvider@1795074520718 (req#3) latency=32ms
   send@1795074525201 firstSeenAtProvider@1795074525225 (req#3) latency=24ms
   send@1795074529665 firstSeenAtProvider@1795074529708 (req#3) latency=43ms
```

| 组 | 样本 (ms) | **中位数** |
|---|---|---|
| 2d 对照（无 hold，turn 内 followUp） | 1295 / 1292 / 1280 | **1284 ms** |
| 2a 6s hold，通知类消息 | 5783 / 5800 / 5787 | **5787 ms** |
| 2b 6s hold + `ctx.hasPendingMessages()` 轮询，通知类消息 | 5828 / 5830 / 5836 | **5830 ms** |
| 2c 6s hold + 轮询，**用户**消息 | 32 / 24 / 43 | **32 ms** |

与 6.0.2 的 **+32.2s** 的关系（`CHANGELOG.md:314`，retire `03:26:39.801` → 通知 `03:27:12.050`）：
那个数字量的是「child retire → 父收到通知」，含攒批窗口（`flushMs`）+ 等父 turn 结束；
本图量的是「消息入队 → 到达 provider」。**两者不同层，不能相减**。可比的是**结构**：
现状等的边界是「父 turn 结束」（长度不可控，实测那段结构性等待贡献了 32.2s 里的主要部分），
hold 把边界换成「hold 预算到点」——上限第一次变成**可配置的常数**。
代价同样实测到了：hold 开着的时候，排队的东西**最长等满剩余 hold 时长**。

### 2.3 结论（一句话可执行）

> hold 期间**通知类消息**没有任何抢占通道（2b 的探针结构上是瞎的：`ctx.hasPendingMessages()`
> 读 session 队列，而 `custom_message` 落在 agent 队列），所以**`legionHoldMaxMs` 就是用户可见的最坏延迟**，
> ——附带推论：hold 的预算必须小，不能像 pi-async 那样给 TUI 用的 10 分钟。

---

## 3. Esc 释放语义

### 3.1 方法

`--print` 下没有 TUI，按 Esc 的真实路径（`interactive-mode.js:2523-2526` → `session.abort()`）不可达；
改用 `ctx.abort()`，它走**同一个** `abort()`（`agent-session.js:2919-2920` `void this.abort()`），
差别只在少一层 TUI 输入通道（这一点单列在 §5）。三个 case：

- **3a**：hold 订阅 `ctx.signal`，想做到事件驱动唤醒；`+400ms` 触发 abort。
- **3b**：盲等 6s；`+400ms` 触发 abort（最坏现场）。
- **3c**：无 hold，`+200ms` abort（对照）。

两者都在 `+200ms` 发一条通知（测 ③），并另起一个长命子进程当「活的子任务」代理（测 ②）。

### 3.2 原始输出

```
── 3a-abort-signal-watch (exit=0 wall=6454ms requests=1)
   {"ev":"boundary:in","hasSignal":false,"runMode":"print","canContinue":false}
   {"ev":"abort:begin","t":1795074543774}
   {"ev":"boundary:held","reason":"hold-ms-no-signal","heldMs":6001}
   {"ev":"agent_settled","aborted":true}
   abort@1795074543774 → exit@1795074549463 (abort→exit 5689ms)
   transcript custom entries (1): spike-a-hold
   transcript entries containing SPIKE_FOLLOWUP: 0
   stand-in child alive after abort: true

── 3b-abort-blind-hold (exit=0 wall=6435ms requests=1)
   {"ev":"abort:begin","t":1795074550220}
   {"ev":"boundary:held","reason":"hold-ms","heldMs":6002}
   {"ev":"agent_settled","aborted":true}
   abort@1795074550220 → exit@1795074555907 (abort→exit 5687ms)
   transcript custom entries (1): spike-a-hold
   transcript entries containing SPIKE_FOLLOWUP: 0
   stand-in child alive after abort: true

── 3c-abort-clean (exit=0 wall=436ms requests=1)
   {"ev":"agent_settled","aborted":false}      ← abort 没赶上，进程先正常收尾
```

### 3.3 三个问题的回答

**① 等待是否立刻返回？——不。** `abort()` 只置标志（`agent-session.js:2073-2084`），
handler 是裸 `await`、无超时（`runner.js:774`），所以释放时刻 = **hold 自己的预算**：

| case | hold 预算 | abort 时刻 | handler 返回 | abort→退出 |
|---|---|---|---|---|
| 3a（坚持订阅 signal 的写法） | 6000 ms | +400 ms | +6061 ms | **5689 ms** |
| 3b（盲等） | 6000 ms | +400 ms | +6062 ms | **5687 ms** |

更要紧的是 **3a 拿到了 `reason: hold-ms-no-signal`**：boundary 期间 `ctx.signal` 是 `undefined`
（H10），所以**事件驱动的 hold 写法在这个钩子上根本无法被唤醒**。想秒级释放只有两条路：
自备 registry 轮询，或 TUI 的 `ui.onTerminalInput`（pi-async `hold.ts:466-481` 走的就是后者）。

**② 子任务是否仍 live？——宿主不碰它。** `agent_settled{aborted:true}`、`requests=1`（续跑确实被抑制，
证明 abort 生效了），而作为子任务代理的长命进程 `alive after abort: true`。
宿主层面 abort 的作用域只有这个 session，没有任何子进程/子任务 teardown。
（**这是代理证据**，`hc ls` 级结论见 §5。）

**③ 未投递通知释放后是否仍到达且只到一次？——最坏，一次都不到。**
3a/3b 里 `+200ms` 发出的那条通知（早于 abort）最终 `transcript entries containing SPIKE_FOLLOWUP: 0`
——它随被 abort 的 run 一起蒸发了。同时 draft 仍然落了盘（`spike-a-hold` 1 条，H11），
于是 transcript 里留下一条**没有任何投递对应物**的孤儿 draft。
换句话说：**宿主既不保证「至少一次」，也不做去重**；已有的副本数完全由 hold 自己决定——
1a 实测 2 跳 = 2 条同文 draft，1c 里 A 4 跳 = 4 条。

---

## 4. 三个决策问题

### D1 互斥规则：谁让路，依据是什么

**规则：** 在一个 legion 节点内，**legion 的 hold 是唯一 owner；其他 hold 必须让路**。
外部 hold 的让路方式已经存在——pi-async 自己写死了：

```
// pi-async src/guard/hold.ts:529-530
// D-3 #2: legion children keep their own bounded reminder channel (CONTRACT §7); never stack.
if (process.env.PI_LEGION_NODE_ID !== undefined) return undefined;
```

依据是三条实测的宿主语义，而不是口头约定：

1. **一次 settle 只有一次续跑**（1a `requests=3` vs 1b `requests=3`）：两个 holder 不是并行等待，
   是在同一跳里**串行相加**（1b：200+200）。「各自 hold 各自的」在物理上不存在。
2. **`continue` 是最后一次定义生效**（1i）：后来者返回 `continue:false` 会**静默取消**前者的 hold，
   而前者的 draft 已经落盘 → 留下孤儿 draft + 被吞掉的等待。所以谁都不能靠"我返回 false 让它让路"。
3. **`entries` 是整体替换**（1d/1e）：不 spread 的 handler 会删掉别人已排好的 draft。

因此 legion 侧的硬规则（写进实现时直接当验收条件）：

- R1 永远返回 `entries: [...event.entries, draft]`，**永不**返回裸列表；
- R2 需要弃权时返回 `undefined`，**永不**返回 `continue:false`（那是在取消别人）；
- R3 同一 run 只 hold 一次，**闩锁不能用 `agent_start` 复位**（实测：会无限续跑，278 跳/60s）；
- R4 draft 必须真的注入（H7：裸 `continue:true` 会被拒），并让 `canContinue` 变 true；
- R5 注册顺序 = 决定权顺序（1j），legion 要看到全部 draft 就最后注册。

### D2 `legionHoldMaxMs` 默认值：建议 **3000 ms**（上限 10 000，`0` 关闭）

推理链全部来自实测，不来自直觉：

- **「开着的 turn 不能压缩」是本实验最关键的一条物理约束**：hold 期间 turn 不结束，
  任何排队的东西只能等 hold 返回（2a/2b：6s hold → 5787/5830 ms，≈ 剩余预算）。
  所以 **hold 预算 = 用户可见的最坏延迟**，它不是一个内部参数。
- 通知类消息**抢不动**它（2b，探针读错了队列），用户消息能（2c，32ms）——
  但 legion 投递的恰恰是通知类（`notify.ts:732` 的 `custom_message`），所以**不能指望抢占**。
- 但也不该退回到「等父 turn 结束」：现状那个边界没有上限（6.0.2 的 +32.2s 里结构性那段就是它）。
- 选 3000 的锚点是仓库里已有的两个常数：postman tick `POSTMAN_INTERVAL_MS = 2_000`
  （`src/extension/legion-tools.ts:86`）与 settle 兜底 `SETTLE_FALLBACK_MS = 2_000`
  （`src/extension/runtime.ts:419`）。3s ≈ 1.5 个 tick：足够吸收「child 刚 retire、结算马上就到」
  这个常见窗口，又不会自己变成第二道闸。
- 代价可控：**一次 hold 只花一次续跑**（1 个额外 provider 请求）。1a 的 `requests = iters + 1`
  是因为实验故意 re-arm；生产实现按 R3 闩锁后应是 2 个请求（1 次 hold 跳 + 1 次真正 settle）。
- 不要照抄 pi-async 的 600 000 ms：那是「有 TUI、有人盯着、Esc 可打断」前提下才成立的数字
  （`hold.ts:12-13`），而 legion 的父会话既没有 TUI 也没有 Esc（3a：`ctx.signal` 根本不存在）。

### D3 Esc 后回落 followUp 会不会重复播报？——会，而且宿主不会帮你挡

**会重复的确切机制（实测）：** hold 每往 boundary 交一次 draft 就落盘一次，宿主完全不去重
（1a：2 跳 2 条；1c：4 跳 4 条同文）。所以「hold 交了一份 + Esc 后回落路径再交一份」= 2 条播报。

**防重方案（三层，缺一不可）：**

1. **所有权转移而不是各播各的**：hold 真正在等待时，把快照内 task 的终态播报权**扣住**
   （pi-async 的 `HoldNotificationRelay`，`src/guard/hold-notify.ts:49-73`：`claim()` / `release()` / `commit()`，
   `commit()` 删除即拥有、二次 `commit` 返回 `[]`）。非终态出口一律 `release()`，**永不吞掉通知**。
2. **持久闩锁兜底**：`commit()` 成功的 id 立刻 `markNotified`（`hold.ts:564-572` 的做法），
   落到 legion 已有的 `notified` 语义上——注意 legion 6.0.2 已经踩过同一个坑
   （`CHANGELOG.md` 里「已 `wait` 取过的结果不再重复播报」的 `consumedByControl` latch），
   可以直接复用那条通路，而不是新造一套。
3. **接受「至多一次、可能为零」，但零必须可救**：3b 实测被 abort 的 hold 让通知**一次都没到**
   （`SPIKE_FOLLOWUP: 0`）+ 留一条孤儿 draft。所以退出路径必须是
   「**先 release 再返回**」——release 把扣住的通知交还给 followUp 正常路径，
   而 draft 只在 `commit()` 成功后才提交。**顺序反了就会同时得到「重复播报」和「彻底丢一次」两种 bug。**

---

## 5. 未实测清单与替代证明路径

| 项 | 状态 | 原因 | 替代证明路径 |
|---|---|---|---|
| 与 **pi-async 真实 hold** 同台双挂起 | **未实测（结构上不可能）** | `hold.ts:536` `if (context.mode !== "tui") return undefined;`——真 hold 在非 TUI 直接弃权；且 `hold.ts:529` 在 legion 节点里也弃权 | 已用两个自建 registrant 复现同一组合语义（§1）；并做了同场加载验证：把 `pi-async@0.5.0` 整个扩展与 `ext-a` 一起 `--extension` 载入，A 的 hold 不受影响（`requests=3`、2 条 draft，见 `/tmp/hold-spike/async/1a-a-only/`） |
| 真实 **Esc 按键** | 未实测 | `--print` 无 TUI，`ui.onTerminalInput` 不存在 | 已实测同一 `abort()` 入口（`agent-session.js:2919-2920`），并独立证明 boundary 内 `ctx.signal===undefined`（3a）→ Esc-watching hold 无法唤醒。可用 `test/docker/verify-tui-visual.sh` 的 TUI 沙箱注入 `\x1b` 复验 |
| **`hc ls` 级**子任务存活 | 代理证据 | 本 rig 无 legion 运行时 | 已用长命子进程证明宿主 abort 不做任何子进程 teardown（`alive after abort: true`）。真验证：同一 case 走 rpc supervisor，abort 后查 registry 行 |
| H8「一份坏 draft 丢弃全部分结果」 | 未实测 | 没构造出能让 `_buildBoundaryContext` 抛错的 draft | 代码路径明确（`runner.js:796-813`），建议实现时按「draft 只放标量字符串」天然规避 |
| TUI 下 6s+ hold 的用户观感 | 未测 | 需要人眼 | 与本案三个决策无关 |

---

## 6. 交付物与清理

```
docs/reports/hold-spike.md      ← 本报告（git add -f，docs/reports/ 被 .gitignore:30 的 `reports/` 命中）
scripts/spike/hold-common.ts    ← 两个 registrant 的共用实现（env 驱动）
scripts/spike/ext-a.ts          ← registrant A
scripts/spike/ext-b.ts          ← registrant B
scripts/spike/logged-mock.ts    ← 逐请求记录 messages 的 mock（复用 test/mock-llm 的 SSE 编码）
scripts/spike/run.ts            ← case 驱动 + 证据落盘（/tmp/hold-spike/<case>/）
scripts/spike/README.md         ← 复跑说明
```

**`scripts/spike/` 整个目录是一次性实验装置，实现落地后应整目录删除**；它不接 `npm test` 的 glob，
也不被任何产品代码 import。判据：跑 `node --experimental-strip-types scripts/spike/run.ts --list` 能列出全部用例即可，
删掉它 `npm run typecheck && npm test` 不会有任何变化。
