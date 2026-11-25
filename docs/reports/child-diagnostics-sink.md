# in-process child 的诊断不该出现在用户输入框上方（#468）

状态：**已修复**（2026-11-25；PR #469，分支 `pi-subagent/pi-legion-468-sink2-62762cd6`，基线 `origin/master` `4eb74b5` = 6.2.13）
门禁：`npm run typecheck` exit 0；`npm test` 3019 tests / 2984 pass / **14 fail（与基线逐条同名，全是本机 mac 既存红）**；
`npm run test:integration` 221 / 209 pass / **12 fail（与基线逐条同名同因，见 §7）**。

---

## 0. 一句话结论

**通道用错，不是等级判断错。** 宿主 TUI 与 in-process child **共用同一个进程、同一个 TTY**，所以 child 自己的
`console.warn` 就是宿主进程往自己终端上写 —— 而编辑器（用户输入框）是屏幕最后一块区域，于是那行字落在它正上方。
`ui.notify` / `UIProxy` 不是这条链路（那只属于 **rpc** child），#415 的降级也没用（它改变的是措辞与归属，
不改变「往宿主终端写」这个动作）。

修法：child 的诊断一律走 **child 作用域 sink** —— 落盘 `<runDir>/diagnostics.log`，**默认零宿主输出**；
`PI_LEGION_CHILD_DIAGNOSTICS=1` 才逐条回显（我们自己的排查开关）；**真扩展错误**在 run 结束时**一行**汇总。

---

## 1. 先确认链路：这行字是怎么到输入框上方的

前一轮排查留下一个假设：「宿主把这条文字转成了 extension UI notify」。**实测否掉了**，链路不是那条。

| 假设 | 证据 | 结论 |
|---|---|---|
| 宿主把它变成了 `ui.notify`（`UIProxy` 的 `notify` / `notifyType`） | `src/supervisor/ui-proxy.ts` 的 `notify` 是 **`extension_ui_request` 事件**的载荷；宿主侧唯一的消费者是 `index.ts:3167` `else if (request.method === "notify") ui.notify(...)`，喂给它的是 **rpc child 的 RPC 客户端** | in-process child **没有 RpcClient**（`InProcessSupervisor` 明确不用），永远到不了这条路径 |
| 宿主交互模式劫持了 console/stream | `pi-coding-agent@1.6.0` 里 `console.log/warn/error =`、`process.stdout.write =` 的全部赋值点：只有 `dist/core/output-guard.js` 的 `takeOverStdout()`，而它的调用点是 **`main.js`（单发/print）与 `rpc-mode.js`**，**interactive 模式没有接管** | 交互模式里 `console.warn` 原样走 `process.stderr` → 直接落到 TTY |
| 所以它到底怎么上屏的 | 编辑器是 TUI 重绘的**最后若干行**；同一 TTY 上的一次 `process.stderr.write` 会插在光标所在处，也就是编辑器正上方 | 与用户描述「显示在用户输入框」完全吻合 |

**实测（比推理更硬）**：把宿主的 `process.stdout.write` / `process.stderr.write` / `console.*` 全部接管后跑
#466 的 V1 驱动（`dispose()` 落在一轮进行中），宿主的**字节流**里：

- 修前：`217` 字节 `[pi-legion] in-process child u2-automation turn_end hook skipped: …`（1 行）
- 修后：`0` 字节

字节是从宿主自己的 stdout/stderr 出来的 —— 这就排除了「UI 队列」这条通道。

---

## 2. sink 落点

| 文件 | 是什么 |
|---|---|
| **`src/supervisor/child-diagnostics.ts`（新）** | `createChildDiagnosticSink()` 唯一构造点；`CHILD_DIAGNOSTICS_ENV`、`CHILD_DIAGNOSTICS_FILE`、`childDiagnosticsLogFile()`、`flushOnFailure()`（spawn 中途死掉时也把欠宿主的那行写出来） |
| `src/supervisor/child-session.ts` | `bindChildSessionExtensions(session, name?, sink?)` / `releaseChildSessionExtensions` / `attachChildSessionRelease(session, timeoutMs?, sink?)`；四个 `console.warn` 全部改走 sink；**sink 按 session 存 WeakMap，取用时才解析**（armed dispose 在 bind 之前，提前解析会丢掉 child 名） |
| `src/supervisor/inprocess-supervisor.ts`（`defaultSessionFactory`） | **一次 child run 一个 sink**，由 `input.sessionFile` 推导 `<runDir>`；扩展**注册**失败记 `real`，与运行期失败汇总到同一行 |

记录格式（一行一条，永不丢信息）：

```
<ISO 时间戳> child=<name> event=<event> real=<true|false> reason=<单行原因>
```

三种出口，就是 issue 的三条要求：

| 记录 | `real` | 磁盘 | 宿主（默认） | 宿主（`PI_LEGION_CHILD_DIAGNOSTICS=1`） |
|---|---|---|---|---|
| `turn_end.skipped`（宿主的 boundary 跳过，#415） | `false` | ✅ | **0 字节** | 逐条回显（文案与修前逐字符相同） |
| `extension.error` / `extension.registration.error` / `session_shutdown.failed` / `dispose.failed` | `true` | ✅ | **run 结束一行汇总** | 逐条回显 + 结束汇总 |
| 扩展注册失败（spawn 期） | `true` | ✅ | 同上（并进 run 结束那行） | 逐条回显 |

`session.shutdown` / `dispose` 的失败记 `real=true`：它们是**真的**扩展处理函数出事，用户该知道 —— 但通过
「一行汇总」，不是每次 dispose 弹一条。

---

## 3. 修前 / 修后 / 开关 / 真错误：四次实测（真实宿主 1.6.0 + 真 pi-async + legion 真 sink）

驱动 = #466 的 V1（`dispose()` @ `message_start`，那条 assistant 消息永不落盘 → 宿主 `_dispatchTurnEndBoundary`
走「找不到 entry」分支 → 经 `onError` 交给 legion）。夹具在 `/tmp/i468/`（`base.mjs` 复用 #466 的：真
`createAgentSession` + 真 `pi-async` + 真 legion 代码，模型用仓库自带 mock LLM），驱动 `accept.mjs`。

| 场景 | 宿主 `[pi-legion]` 行数 / 字节 | `diagnostics.log` | 结果 |
|---|---|---|---|
| **修前**（`origin/master` `4eb74b5` 干净 detached worktree） | **1 / 217 B** | ❌ 不存在 | —— |
| **修后**（默认，跑 3 次） | **0 / 0 B**（3/3） | ✅ 1 条 | PASS |
| **修后 + `PI_LEGION_CHILD_DIAGNOSTICS=1`**（对照组） | 1 / 217 B（与修前逐字符相同） | ✅ 1 条 | PASS |
| **修后 + 真扩展错误**（`session_start` 里抛异常的探针扩展） | **1 / 285 B（一条汇总）** | ✅ 1 条 | PASS |

**修前（红）**，宿主字节：

```
[pi-legion] in-process child u2-automation turn_end hook skipped: turn_end could not resolve the persisted assistant entry ID (this turn's assistant message has no persisted entry, so the host ran no turn_end handler)
```

`diagnostics.log`：不存在（这条诊断当时**只存在于**宿主终端上，磁盘上没有）。

**修后（绿）**，宿主字节：**0**。同一次运行的 `<runDir>/diagnostics.log`：

```
2026-11-25T07:41:06.898Z child=u2-automation event=turn_end.skipped real=false reason=turn_end could not resolve the persisted assistant entry ID (this turn's assistant message has no persisted entry, so the host ran no turn_end handler)
```

**对照组（开关打开）**：宿主重新拿到那 **217 字节**、逐字符与修前相同 —— 开关只决定「上不上屏」，不改变文案，
也不改变落盘。**这条同时证明**：修后默认的 0 字节不是把诊断丢了，而是换了信道。

> 字节相等只对**原本已存在的那两条**事件成立（`turn_end hook skipped: …` / `extension error: …`）。
> `session_shutdown failed` / `dispose failed` 此前是不带 child 名的另一种写法，注册失败此前是
> `inprocess child '<name>': …`；它们现在统一成 `in-process child <name> <label>: …`。另外，超过 400 字符的
> 原因会被压成单行并截断 —— 这是刻意的，不承诺字节相等。

**真扩展错误（默认，不逐条）**，宿主只收到这一行：

```
[pi-legion] in-process child u2-automation: 1 extension error this run — first: extension error: <inline:probe-throws> session_start: probe extension exploded in session_start — details: /…/run/diagnostics.log
```

落盘保留完整记录（含 extensionPath / event / 原因），宿主只拿到「1 条 + 第一条 + 去哪看」。

---

## 4. 同路径全查：in-process child 路径上的每一个 `console.*`

| 位置 | 是什么 | 处置 |
|---|---|---|
| `child-session.ts` `bindChildSessionExtensions` → `onError`（boundary 跳过） | 宿主自己跳过 `turn_end` 的诊断，#415 判定为**预期** | sink，`real=false`（只落盘） |
| `child-session.ts` 同上 → 其它记录 | **真**扩展失败 | sink，`real=true`（run 结束一行） |
| `child-session.ts` `releaseChildSessionExtensions` 的 catch | `session_shutdown` handler 抛出 | sink，`real=true` |
| `child-session.ts` `attachChildSessionRelease` 的 catch | `dispose()` 抛出 | sink，`real=true` |
| `inprocess-supervisor.ts`（`defaultSessionFactory`）扩展注册失败 | provider / virtual model 注册没生效（真扩展失败） | sink，`real=true` |
| `inprocess-supervisor.ts:566` 读不懂的 `PI_LEGION_PHASES` 声明 | **不是** child 诊断：是「父级声明的机器解析不了」的 spawn 请求问题，**每次 spawn 至多一行**，后果是团队静默丢掉阶段机 | **保留 `console.warn`**（与 `MAX_DEPTH_ENV`、worktree 拒绝同族，属于「你要求的、我们拒绝了」），在代码里写明理由 |
| `child-memory.ts:51` 内存旋钮低于下限 | legion 自己的**宿主配置校验**（一次，非 per-child） | 保留 |

`src/supervisor/` 与 `src/runs/args.ts` 里剩下的 `console.*` 只有上面两处，其余都是 sink 自身的实现。

---

## 5. 测试

- **`test/unit/child-diagnostics.test.ts`（新，10 条）**：`flushOnFailure`（成功不发声 / 失败先 flush 再原样抛 / 不重复）/ 默认零宿主字节 + 落盘格式 / 开关对照组（含开关解析表：
  `1|true|on|yes` 才算开）/ 真错误只汇总一次（3 条 → 1 行，且幂等）/ 单数措辞 / 多行原因压成一行 /
  无 logFile 的内存模式 / **写盘失败与宿主写失败的 `doesNotThrow`**（诊断绝不能把 dispose 弄挂）/
  `<runDir>` 推导（`<runDir>/<name>.jsonl` → `<runDir>/diagnostics.log`，`in-memory` 不瞎编路径）。
- **`test/unit/child-session.test.ts`**：5 条按新契约改写（原来断言 `console.warn` 的那几句正是 bug 本身），
  现在断言「宿主 0 行 + 磁盘有记录」「真错误 run 结束一行」；另加 3 条：延迟解析仍带 child 名、换 sink 时旧 sink 先 flush、
  以及「注册失败被记录、旧 warn 文案不许回来」的 format tripwire。
- **`test/unit/child-session-timer.test.ts`**：`child-session.ts` 的 tripwire 从「**零 import**」收窄为
  「**不许 import 宿主包**（只允许 `node:` 与 `./`）」。**这是被迫的、也是有意的收窄**：sink 必须在
  `child-session.ts` 里可达，而 sink 只依赖 `node:fs` / `node:path`；该 tripwire 保护的是「unit 跑起来不加载
  SDK」，不是「一条 import 都不许有」。收窄后又按 review 补强：**扫 `child-session.ts` 与 `child-diagnostics.ts`
  两个文件**（真正碰 `node:fs` 的那个就在这条路线上），并覆盖 `import … from` / `export … from` /
  `await import()` / `require()` 四种 specifier 形式，另有一条自检确保检测器本身看得见这四种。

### 变异（验收第 6 条：把 sink 改回原样 → 验收 1 红）

| 变异 | 做法 | 结果 |
|---|---|---|
| **A. sink 改回「总是上屏」** | `child-diagnostics.ts`：`this.hostEcho = options.host ?? childDiagnosticsEnabled()` → `true` | 验收 1 **红**：宿主 1 行 / 217 B（磁盘记录仍在 → 精确证明红的是**通道**断言） |
| **B. 直接退回 `console.warn`** | `child-session.ts` 的 boundary 分支改回 `console.warn(...)` | 验收 1 **红**：宿主 1 行 / 217 B，且 `diagnostics.log` 不存在 —— 与修前完全一致 |

---

## 6. 验收逐条

| # | 要求 | 结果 |
|---|---|---|
| 1 | `dispose()` 落在一轮中进行 → 宿主 **0 字节** `[pi-legion]`（修前有，贴出来） | ✅ 修前 217 B / 修后 0 B（3/3），见 §3 |
| 2 | 同一次运行 `<runDir>/diagnostics.log` 有记录 | ✅（`event=turn_end.skipped real=false`） |
| 3 | `PI_LEGION_CHILD_DIAGNOSTICS=1` 才有输出（对照组） | ✅ 217 B 逐字符复现修前文案 |
| 4 | 真扩展错误仍可见：一条汇总、不刷屏；测试钉住「一条」 | ✅ 宿主 1 行；`child-diagnostics.test.ts` 第 4 条 + `child-session.test.ts` 的 `session_shutdown` 用例都断言 `host.length === 1` |
| 5 | typecheck 0 / `npm test` 与基线逐条同名 / `npm run test:integration` | ✅✅ 见门禁与 §7 |
| 6 | 变异：sink 改回原样 → 验收 1 红 | ✅ 两种变异都红，见 §5 |

---

## 7. 门禁对比（本机 mac，`/bin/sh` = bash 3.2）

基线 = `origin/master` `4eb74b5` 的干净 detached worktree（同一份代码、同一个 `node_modules`）。

| | 基线 | 修后 | 差异 |
|---|---|---|---|
| `npm test` | 3006 tests / 2974 pass / **14 fail** | 3015 / 2980 / **14 fail** | 失败**名单逐条相同**（`diff` 空）；+9 条新用例 |
| `npm run test:integration` | 221 / 209 / **12 fail** | 221 / 209 / **12 fail** | 失败**名单逐条相同**（`diff` 空） |

两处既存红的成因（与本改动无关，基线跑在**同一台机器**上同样红）：

- 14 条 unit：`v1.1 probe` / `xm-dispatch` / `provisionWorktree npm` / `skill npm pack` / `retire sweeps … SIGTERM`
  等，本机环境类（工具链、`npm pack`、进程信号）。
- 12 条 integration：11 条是 `hc` 跨机探测脚本在 **bash 3.2** 下 `case … in … ;; esac`（嵌在 `$( )` 里）报
  `syntax error near unexpected token ';;'`；1 条是 `#450` 的 real-pi reattach 断言。基线逐条同因同位置。

---

## 8. 不做 / 未决

- **不静默丢弃**：所有诊断都落盘；开关关掉的只是「上屏」。
- **不伪造 UI 通道**：in-process child 没有 `ui` 上下文。issue 里「非红色、可展开」的 UI 语义，在宿主
  stderr 上退化为「一行、无颜色、带 `details:` 路径」。要变成真正的 `ui.notify(…, "info")`，得把 run 结束的
  汇总从 `child-session.ts` 一路穿到 orchestrator 的 notify 通道 —— 那是另一件事，本 issue 只修「别弹在输入框上方」。
- `PI_LEGION_PHASES` 解析失败仍走 `console.warn`（§4 已说明理由）。
- 夹具在 `/tmp/i468/`（与 #466 的 `/tmp/issue466/` 同惯例，未入库）：`accept.mjs` + 变异的 `/tmp/i468-mutant{,2}/`。
- spawn 在验收前就失败（例如 model 解析失败、`createAgentSession` 抛错）：注册失败**仍然**会发出 run 结束那一行 ——
  pre-session 的每一步都走 `flushOnFailure`，因为没有 `dispose()` 可以兜底（review finding #1）。

---

## 9. fresh-context 对抗式 review（只读 scout，独立会话）

0 blocker / 1 major / 5 minor / 6 nit。逐条处置：

| # | 级别 | 问题 | 处置 |
|---|---|---|---|
| 1 | major | spawn 在 `record(注册失败)` 之后、armed release 之前就死掉（`model resolve failed` / `createAgentSession` 抛错）→ 没人 `flush()`，真失败只剩磁盘 | **修**：抽出可测的 `flushOnFailure(sink, step)`（`child-diagnostics.ts`，含单测），pre-session 每一步都走它；model-resolve 的 `throw` 前直接 `flush()`（原来基线是立刻打印的，静默会是回归） |
| 2 | minor | tripwire 收窄后只认 `import … from`，且只扫 `child-session.ts`：`export … from` / `await import()` / `require()` 都能绕过；真正碰 `node:fs` 的 `child-diagnostics.ts` 反而没被扫 | **修**：扫两个文件 + 覆盖四种 specifier 形式，并自检检测器本身 |
| 3 | minor | 「文案与修前逐字符相同」只对 2/5 事件成立；超长原因会被截断 | **修**：模块注释、契约 r7、本报告 §3 全部改成限定表述 |
| 4 | minor | WeakMap 的两个分支（换 sink、延迟解析）没测试覆盖，延迟解析的理由没钉住 | **修**：加两条用例（armed-before-bind 仍带 child 名；换 sink 时旧 sink 先 flush） |
| 5 | minor | 工厂里 `record(注册失败)` 删掉整套测试仍全绿（`defaultSessionFactory` 不导出） | **修**：加同族 format tripwire（`extension.registration.error` 恰好一次 + 旧 warn 文案不许回来） |
| 6 | minor | `diagnostics.log` 建成 0644，同目录 transcript 是 0600 | **修**：`mode: 0o600` |
| 7 | nit | `label` getter 的 JSDoc 写错（写成整个前缀） | 修 |
| 8 | nit | `agent-session.d.ts:488` 的引用在 1.5.0 上是 476（`package.json` 允许 `^1.5.0`） | 修：两个版本号都写上 |
| 9 | nit | 与 `notice-delivery.ts` 的 `appendNoticeLog`/`clamp` 重复；且没有上限（`turn_end.skipped` 可以每轮一条） | 部分修：保留 6 行独立写法（跨子系统耦合不划算），但**补 1 MiB 上限**（超过就保留后半段），与 notice log 同策略 |
| 10 | nit | `attachChildSessionRelease(session, undefined, sink)` 的位置参数占位 | 修：参数改成 `(session, sink?, timeoutMs?)` —— 生产调用全都传 sink、从不传 timeout |
| 11 | nit | `records` 只有一个测试用；`oneLine` 的 `limit` 参数没人传 | 修 `limit`（改成模块常量）；`records` 保留（无 logFile 时的唯一可读面） |
| 12 | nit | `docs/inprocess-supervisor.md` 仍写旧签名；README 的 knob 表没有 `PI_LEGION_CHILD_DIAGNOSTICS` | 修：两处都补上 |

reviewer 另外独立复核过：默认零宿主字节确实被 `host.length === 0` 钉住（不只是 `hostWrite` seam）、「一行」是真的
（三条 real → `host.length === 1`、flush 两次仍 1、汇总里没有 `\n`）、每条有 session 的退休路径都会 flush、
`/tmp/i468/evidence/*.json` 的字节数与正文一致（217 字节逐字节重算过）、测试数算术 3006 → 3015 对得上。
