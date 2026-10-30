# abort（软中断）：`subagent({ action: "abort" })`（v1，冻结）

> 语义由 #314 冻结。实现期发现矛盾 → 停下报告，不得重新解释本契约。
> **本文件是 #314 唯一的 D 编号命名空间**：实现代码与测试注释里的 `#314 Dn` 只解析到这里的
> D1–D8。`#314` 之外的 `Dn`（例如 `docs/legion-v2-contract.md` 的 D11 = 可视化三层、
> D12 = SQLite 账本）与本契约无关；本契约没有 D9 及以后的条款。

## 背景

"让这个 child 别跑了"原本只有两条路，都不对味：

- **`stop`**：`SIGTERM` → `SIGKILL` + 后代清扫，**进程没了，上下文也一起没了**。
- **`steer`**：只是排队（#313），文本在 child 本轮工具批结束后的 turn 边界才被消费——一个卡在长命令里的 child **永远收不到**。

supervisor 一侧其实早就实现了 `abort`（`LegionSupervisor.abort` / `RpcSupervisor` / `InProcessSupervisor` / `Orchestrator.abort`），`docs/legion-v2-contract.md` §8.1 的命令通道也早把 `abort` 与 `prompt` / `steer` 并列，但这条路**零调用点**、工具面没有对应 action。本契约把这条缝接到工具面，并把结果冻结成三态回执。

## 冻结决定

### D1 — 三态，没有第四种

| `status` | 含义 | 副作用 |
|---|---|---|
| `interrupted` | 有一轮在跑，请求**已经送达** | 当前 turn 被打断；**可能有部分编辑残留**（已落盘的东西不会被回滚）；child 仍活着、可 `continue` / `resume` |
| `no-turn` | 原先没有任何一轮在跑，也就什么都没做 | **队列不清**（`clearQueue` 一次都不调）；`cleared` 恒为 `{0,0}` |
| `timeout` | 请求发出去了，但 child 没有在时限内 settle | 不杀、不 retire、不改 `turnActive` / `state` / `blocked` |

三者都是诚实收场，工具面一律返回 `ok(...)`。**`fail` 只留给抛错路径**：child 不存在 / 已 retired / 不可用时 `requireChild` / `assertCanSend` 抛出，工具面翻成 `abort failed: …` + `NOT_FOUND`。注意 `assertCanSend` 跑在 `turnActive` 判定**之前**，所以 retired 的 child 照旧抛错，不会被读成 `no-turn`——两者不能互相顶替（查不到人 ≠ 人闲着）。

回执文本必须让父 agent 一眼看出是哪一态，`timeout` 文案必须指向 `stop`（逐字文本见 D7）。

### D2 — 默认值

| 项 | 默认 | 说明 |
|---|---|---|
| `clearQueued` | **`true`** | abort 前先清 child 的 steering / follow-up 队列；工具面只暴露这一个开关（`clearQueued: false` 保留队列） |
| abort 上限 | **`DEFAULT_ABORT_TIMEOUT_MS = 5000`**（`src/supervisor/types.ts`） | 两个后端与工具面回执共用的常量，不是各写一份字面量；后端把非有限 / ≤0 的 `timeoutMs` 归一成它（否则一个坏值会把两步都压成 ~0 ms，让每次 abort 都变成假 `timeout`），合法的值再以 `MAX_ABORT_TIMER_DELAY_MS = 2_147_483_647` 封顶（Node 把超出 32 位有符号上限的延时限**钳成 1 ms**，不封顶等于让一个 `1e12` 这样的值凭空造出假 `timeout`） |
| 工具面 `timeoutMs` | **只对 `wait` 生效** | `abort` 不接受工具面传入的上限，一律用上面那个常量；`timeoutMs` 参数的说明也只看 `wait` |
| `cleared: { steering, followUp }` | 清队列那次调用的**返回值**计数 | 结构缺失 / 不可读（含抛错）→ 计 **0**，不猜 |

计数由 `countClearedQueue`（`src/supervisor/types.ts`）统一做，两个后端不会对同一份返回值给出两个数字。`cleared` 是"真的清掉了多少"的机器事实，不是估计值；`no-turn` 下两个计数恒为 0。

### D3 — 顺序：先清队列，再 abort

**清队列必须先于 abort 发出。** 理由：如果 abort 先落地，child 立刻就会开始执行队列里最老的那条指令——这正是"让它停下"的反面。先清后 abort，这次中断才算名副其实。

计数取自清队列调用的返回值，所以"先清"同时给出真实的 `cleared`；反过来顺序则无从计数。

两个后端都是 `requireChild` → `assertCanSend` → `turnActive` 判定**通过之后**才进清队列，所以"清 + 中断"这对调用是这条顺序的可观测证据：用例断言的是有序日志 `["clearQueue", "abort"]`，不是两个独立事实。

### D4 — 有界超时（**包含清队列**）

两个后端都**不可能等到"abort 完成"就一定返回**：

- `AgentSession.abort()` 的收尾是 `await waitForIdle()`，而一个**忽略取消**的工具调用永远不会 idle；
- RPC 一侧本身有自己的响应超时。

所以两个后端都把"干活"和计时器赛跑（`Promise.race`），到点返回 `timeout`，而不是挂死或抛错。

**清队列这一步同样受这个上限约束。** 走到 abort 这条路的前提就是 child 不响应；一个无界的前置步骤会让"打断"恰好在这个功能唯一的使用场景里迟到。RPC 后端尤其明显：清队列走 `RpcClient.send()`，唯一的界是客户端**硬编码的 30 s 请求超时**（`node_modules/@earendil-works/pi-coding-agent/dist/modes/rpc/rpc-client.js:465-466`），不 race 的话，回执与 CHANGELOG 里那句"5 s 上限"就是假话。

由此冻结三点：

1. **计时器赢在清队列上时，`cleared` 保持 `{0,0}`**（D2 的"拿不到就记 0"），但**中断照样发出**——清队列是 best effort，永远不许它挡住 abort。
2. **最坏总时长 ≈ 2× 上限**（清队列一次 + 中断一次）。这是刻意写明的上界，不是超时叠加的 bug。
3. **timeout 是一份"请求已发出、但对方没在时限内收场"的报告，不是失败**：不抛、不杀、不 retire，也不改 `turnActive` / `state` / `blocked`——状态收敛仍由 `agent_settled` / `updateTurnState` 自然完成。

**`turnActive` 快照只取一次，且取在清队列之前**（因此最多落后一个上限）。落在这段窗口里自己走完的 turn 照样会收到这次中断，回执照样是 `interrupted`——这是刻意的：那时队列已经清过了，对一个已经空闲的 child 发一次中断无害；改成"清完再验一次状态"就得如实回 `no-turn`，而那份回执恰好会瞒下它刚刚丢掉的那批消息。

**杀进程不是 abort 的职责**，是 `stop` 的。

### D5 — abort 与 stop 的边界

| | `abort` | `stop` |
|---|---|---|
| 作用 | 停掉**当前这个动作** | 拆掉**进程** |
| 手段 | 让 child 的 session 结束当前 turn | `SIGTERM` → `SIGKILL` + 后代清扫 |
| 上下文 | **保留**：context / transcript / session 文件都在，之后还能 `continue` / `resume` | **丢弃** |
| 结局 | child 仍活着、可续 | child 没了 |

"child 没被回收、仍可续"这条边界不是本契约新立的：`docs/contracts/esc-no-retire-v3.md` 已经冻结了"打断当前等待 ≠ 回收 child"（Esc 只结束父 turn，不 retire children）；abort 站在同一侧——它停的是 turn，不是进程。

就"能碰到一个正卡在长命令里的 child"而言，abort 是**唯一的那一个 action**：`steer` 只能在 turn 边界排队（见 #313 与 `docs/legion-v2-contract.md` §8.3 的负语义），进不去正在执行的工具调用内部；abort 至少能把这次中断送进那个调用里。但它**不保证对方一定听**——一个忽略取消的工具永远不会 settle，这次调用照样可以答 `timeout`（D4）；让进程死掉始终是 `stop` 的活。

### D6 — 不在本契约范围

- 不做 watchdog，不做自动 abort；
- 不做"卡住可见性"（#315）；
- 不改 mailbox 枚举（#322）；
- `stop` / `retire` 的语义（含 `force: true` 硬版本、SIGTERM→SIGKILL→后代清扫）原样不动；
- 不新增除 `abort` 之外的 action。

### D7 — 工具面

- `SubagentParams.action` 的 union 增加 `"abort"`（排在 `"steer"` 之后，其余顺序不动）。
- 唯一新增参数是 `clearQueued`：`Type.Optional(Type.Boolean())`，说明以 "abort only: …" 开头，默认 `true`；`clearQueued: false` 保留队列。**工具面不暴露 `timeoutMs`**——这个参数只属于 `wait`，abort 的上限固定为 `DEFAULT_ABORT_TIMEOUT_MS`（D2）。
- dispatch：`if (action === "abort") return abortChild(ctx);`；`abortChild` 调 `ctx.orchestrator.abort(ctx.name, opts)`，且**只在 `clearQueued === false` 时构造 opts**——默认路径不传对象，`true` 这个默认值只有后端一处来源。
- 回执逐字（`abortReceipt(name, outcome, timeoutMs = DEFAULT_ABORT_TIMEOUT_MS)`，`seconds` 为 `timeoutMs/1000`：整秒写整数，否则保留一位小数）：

  | 情形 | 文本 |
  |---|---|
  | `interrupted` | `Aborted <name>'s current turn (context kept; partial edits may remain)` |
  | `interrupted` 且 `cleared.steering + cleared.followUp > 0` | 上面那句 + ` — dropped <n> queued message(s)`（追加，绝不替换前半句；没有单数写法，数字自带含义） |
  | `no-turn` | `Nothing to abort: <name> is not running a turn.` |
  | `timeout` | `Abort sent to <name>, but it had not settled within <seconds>s — the running tool may ignore cancellation; use stop (or stop with force) if it must die.` |

- 三态都返回 `ok(...)`；只有抛错路径 `fail(...)`，文本 `abort failed: <error>`，错误码 `ErrorCodes.NOT_FOUND`。
- `TOOL_DESCRIPTION` 的 action 句与 `PARENT_PLAYBOOK` 都增加 abort 的说明。既有子串断言 `/collect, wait, list, retire/`、`/collect, wait, list, retire, stop/` 必须继续匹配：`, abort` 追加在 `stop` **之后**，不许插在 `retire` 与 `stop` 中间。
- guards 不动：`signal?.aborted && action !== "stop"` **不为 abort 修改**（issue 明确"不碰 guards"）；`node_aborted` 的 payload 仍是 `{ name }`。

### D8 — 分层透传

supervisor 层只有机器三态，"人话"只出现在工具面一层：

- `RoutingSupervisor.abort(name, opts)` 就是把 `(name, opts)` 转给 `backendFor(name)` 并**原样返回**后端的三态——不转译、不展平成成功。
- `Orchestrator.abort(name, opts?)` 保留原有的两道闸门（`requireChild` / `refuseQueuedControl`）与不变的 `node_aborted {name}` 事件，返回值同样原样透出：没有第四种状态，也不把 `timeout` / `no-turn` 折成 `interrupted`。
- `node_aborted` 是在 supervisor 调用**成功返回之后无条件** emit 的，所以 `no-turn` 与 `timeout` 也各发一条（payload 仍是 `{ name }`，既有行为不变）：事件侧（可视化 / 总线）不能把 `node_aborted` 当成"确实有一轮被打断"的证据，那要看回执的三态。
- `collect` 里 `aborted by parent` 那套推理与本契约无关，不动。

## 交叉引用

- `docs/legion-v2-contract.md` §3.1（supervisor 接口的 `abort` 缝，含 `AbortOutcome` 注）/ §8.3（`steer` 排队语义，即 abort 要补的那个洞）
- `docs/contracts/esc-no-retire-v3.md`（打断当前等待 ≠ 回收 child：Esc 只结束父 turn，不 retire children；abort 同侧）

## 验收清单

`test/unit/abort-supervisor.test.ts` —— 第 1–8 条在 rpc / inprocess 两个后端各跑一遍（标题只差 `rpc` / `inprocess` 前缀，逐字同句）；第 9 条一部分是共享常量的直接断言、一部分也是两个后端各一份：

1. **no-turn**：空闲 child → `no-turn`，`clearQueue` 与 `abort` 一次都没调，`cleared` 全零（`abort <backend>: an idle child is 'no-turn' and nothing is called`）。
2. **interrupted**：清队列返回 `{steering:["s1","s2"], followUp:["f1"]}` → `cleared: {steering:2, followUp:1}`，`abort` 恰好一次（`abort <backend>: clears the queue and reports what it dropped`）。
3. **顺序**：有序日志断言 `["clearQueue", "abort"]`（`abort <backend>: the queue is cleared before the turn is interrupted`）——这条是整个设计存在的理由。
4. **timeout 不 retire**：`abort` 永不 settle → 25ms 内返回 `timeout`（`cleared` 仍是真实计数），不抛、不 reject；`isAlive` 仍 true；随后 `waitSettled` 仍由 child 自己 `settle()` 的 `agent_settled` 收场（`abort <backend>: a hanging interrupt resolves as 'timeout' without retiring`）。
5. **clearQueued:false**：清队列返回值非空但**不被读**，`cleared` 全零，日志只有 `["abort"]`（`abort <backend>: clearQueued:false skips the clear and reports zeros`）。
6. **retired / 未知 child 仍抛 NOT_FOUND**：`assertCanSend` 在 `turnActive` 判定之前跑，已 retired 的 child 不许被读成 `no-turn`，且清队列与中断一次都不发（`abort <backend>: a retired child still throws NOT_FOUND and calls nothing`）。
7. **清队列抛错**：`clearQueue` 抛出 → `cleared` 计 `{0,0}`，**中断照样发出**（`interrupted`），不把整次 abort 变成失败（`abort <backend>: a throwing clear reports zeros and still interrupts`）。上限到点**之后**才 reject 的 `clearQueue` 同理：计时器已经赢了（`cleared` 保持 `{0,0}`，有序日志仍是 `["clearQueue", "abort"]`），那份迟到的拒绝只被观察、不冒泡（不得变成 `unhandledRejection`），结果仍是 `interrupted`（`abort <backend>: a clear that rejects after the bound still reports interrupted`）。
8. **清队列挂住**：`clearQueue` 永不 settle → 同一个上限到点即放手（用例用 25 ms 证明这个界是调用方的，不是传输层的），`cleared` 保持 `{0,0}`，中断仍然发出，有序日志同样是 `["clearQueue", "abort"]`（`abort <backend>: a hanging clear is bounded and still interrupts`，D4 的核心用例）。
9. **默认上限只有一个来源**：`DEFAULT_ABORT_TIMEOUT_MS === 5000`（`abort: the default bound is the shared 5s constant`），且不传 `timeoutMs` 时清队列与中断**各**用这个常量作界（`abort <backend>: an abort without timeoutMs bounds both steps with the default`，靠打补丁观察 `setTimeout` 的延时，不真等 5 s）。**坏值一律回落到它**：`0` / 负数 / `NaN` / `Infinity` 走 D2 的归一，`1e12` 这类超上限值走 `MAX_ABORT_TIMER_DELAY_MS = 2_147_483_647` 封顶（不封顶的话 Node 把延时钳成 1 ms，凭空造出假 `timeout`），用例 `abort <backend>: a junk timeoutMs falls back to the shared bound`。
10. **routing 透传**：`RoutingSupervisor` 把 `(name, opts)` 转给所属后端并原样返回三态——`abort routing: forwards (name, opts) to the owning backend and returns its outcome`（rpc）与 `abort routing: forwards opts to the inprocess backend and returns its outcome`（inprocess，用 `clearQueued:false` 证明 opts 真的送达）。

`test/unit/abort-action.test.ts` —— 工具面与回执：

11. **三条回执逐字**：`#314 abortReceipt: interrupted keeps the context and warns about partial edits`、`#314 abortReceipt: no-turn claims no interrupt`、`#314 abortReceipt: timeout points at stop and formats the bounded wait`。
12. **dropped 计数后缀**：`#314 abortReceipt: interrupted reports the queued messages it dropped`——`n` 是 steering + followUp 之和，后缀是追加而非替换。
13. **`use stop` 与 `seconds` 格式化**：timeout 回执含 `use stop`；`2500 → 2.5s`、`10000 → 10s`（`#314 abortReceipt: timeout points at stop and formats the bounded wait`）。
14. **默认不传 opts 与参数自描述**：`#314 abort on a live child renders the interrupted receipt and passes no clearQueued`（`clearQueued` 为 `undefined`，不是 `true`）；显式关掉的那条是 `#314 abort forwards an explicit clearQueued:false`；参数文案由 `#314 the clearQueued param documents itself as abort-only and default-true` 钉住（`abort only:` / `queued steering/follow-up` / `default true`）。
15. **no-turn / timeout 都是成功结果**：`#314 abort reports no-turn as a plain success`、`#314 abort timeout is a success whose receipt points at stop`（无 `details.error`、零 retire）。
16. **NOT_FOUND 两条**：`#314 abort of an unknown name is NOT_FOUND and never reaches the supervisor`（查名先于 supervisor）、`#314 abort reports a supervisor failure as 'abort failed:' + NOT_FOUND`（`abort failed: ` 前缀只由 `abortChild` 的 catch 产生）。

`test/unit/playbook.test.ts`：

17. **item 9**：`parent playbook 第 9 条` 在 `#314` 的两个用例里 —— `playbook draws the abort-vs-stop boundary and names abort where steer cannot land (#314)` 断言 abort 保留上下文 / `stop` 拆进程 / 卡在长命令里的 child 只有 abort 能碰到（工具忽略取消时这次调用仍可答 `timeout`，见 D5）/ `clearQueued` 默认丢队列 / timeout 不是失败；`playbook says steer queues at a turn boundary and stop is the interrupt (#313)` 里那条 contiguity 断言证明 item 9 夹在 item 8 与 "Utility agents …" 之间、且没有 item 10。`TOOL_DESCRIPTION` 的 action 串按 `…, retire, stop, abort` 追加，`/collect, wait, list, retire/` 与 `/collect, wait, list, retire, stop/` 两条旧断言继续匹配。

## 修订

- **复审轮 1（#314）**：
  - R0-major：5 s 上限原先只管中断、不管它前面的清队列；RPC 后端上清队列的唯一界是 `RpcClient.send()` 的 30 s 硬编码请求超时，于是回执与 CHANGELOG 声称的 5 s 在真实卡死场景里是假话。→ 清队列并入同一上限（写进 D4，不另立条款）。
  - R2-major：代码注释里的 `#314 Dn` 与本文件编号对不上。→ 本文件即唯一命名空间，D1–D8 覆盖整个改动，验收清单不占用编号。
  - 上面两处在契约文档里曾各有一个临时编号（D11 / D12）；它们**不是本契约的条款**，编号最终收敛为 D1–D8。
- **复审轮 2（#314，最终）**：四处边界澄清，不新增条款、不改 D1–D8 编号：D4 补 turnActive 快照只取一次（取在清队列之前）的窗口语义与“为什么不再验一次”；D2 补 `MAX_ABORT_TIMER_DELAY_MS` 封顶（Node 把过大延时限钳成 1 ms）；D5 收敛“唯一能穿透”的措辞（abort 是唯一能把中断送进工具调用内部的 action，但对方若忽略取消仍会答 `timeout`，杀进程归 `stop`）；D8 补 `node_aborted` 在 `no-turn` / `timeout` 下也照样 emit（既有行为，payload 仍是 `{ name }`）。验收清单第 7 / 9 条各补一条覆盖用例（迟到的 clear 拒绝、`0` / 负数 / `NaN` / `Infinity` 与 `1e12` 两类坏值回落），两条用例已在 rpc / inprocess 两个后端落地，标题与本文件逐字一致。
