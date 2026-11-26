# 通知投递：活通道 + 一行摘要 + 同检测一次（#442）

- 基线：`origin/master` `e385aea`（6.2.6 之后合入的 #438/#439/#440 已在上面；6.2.6 发版点
  `298c235` 上为 2844 条用例）。分支 `pi-subagent/hw-nj/pi-legion-442-notice-cb9351d3`，
  PR base `master`（仓库的 trunk；远端没有 `main` 分支）。
- 范围（任务冻结）：**只修 #442**（A 根因 / B 刷屏 / C 重复触发）。#441（stall 候选集与
  「该不该报」）**不在本 PR**，见 §6。
- 不动：版本号、tag、publish。没有 remote 侧发布动作，只有 PR。

---

## §1 现象（issue 原文）

session 被替换/重载之后，TUI 里每一封通知都变成一行红字，而且**正文全打印**：

```
[pi-legion] notice not delivered (This extension ctx is stale after session replacement or
reload. Do not use a captured pi or command ctx after ctx.newSession()):
From: root
Subject: Stall notice: anotify-e2e-timeout
…（整条 stall notice 正文）
```

同一条检测在 `04:49:13.348 / .361 / .377Z`——**30ms 内 3 次**——每次都再挂一条红字。

## §2 A：投递走「活通道」，`pi` 只作最后兜底

### 2.1 为什么捕获的 `pi` 必然失效（宿主事实，不是猜测）

- `index.ts` 的扩展工厂拿到的 `pi` 是**加载期**对象：`pi.sendMessage` 先
  `assertActive()` 再转发给那次加载创建的 `ExtensionRuntime`。
- `ctx.newSession()` / `fork` / `switchSession` / `reload()` 走
  `AgentSessionRuntime.teardownCurrent()`：`session_shutdown` → `session.dispose()` →
  `ExtensionRunner.invalidate(msg)` → `createExtensionRuntime().invalidate(msg)`，把
  `state.staleMessage` **单向**写死（`if (state.staleMessage) return;`，永不恢复）。
- 之后每次 `pi.sendMessage` 都抛 "This extension ctx is stale after session replacement or
  reload"；替换 session 由 `createRuntime()` 重新加载扩展（新 `pi`）。
- 而 `notice()` 的调用方全都比 session 活得久：postman 的 tick、stall 检测、加载期排队的
  resume。⇒ 旧实现里「替换之后所有通知」100% 静默丢失，用户只看到红字。

### 2.2 改法

`src/extension/notice-delivery.ts`（新文件）维护**按 scope 的活通道注册表**：

| 事实 | 落点 |
|---|---|
| 每次扩展加载把自己登记为所在 scope 的活通道 | `index.ts:1702-1709`（`noticeScopeKey` → `rememberNoticeScope` → `installNoticeChannel`） |
| `notice()` 调用**时**解析活通道 | `index.ts:680-689`（`live: liveNoticeChannel(scope)`，`fallback: sendNoticeMessage(pi, …)`） |
| 先活通道、失败才用捕获的 `pi` | `notice-delivery.ts:287-366` 的 `deliverNotice`（`attempts` 顺序，305-338 行） |
| session 结束就退出投递目标 | `index.ts:1711-1718`（`session_shutdown` → uninstall，带 owner 身份校验，**不会**删掉替换会话刚装上的那条） |

**scope 是必须的**，不是洁癖：一个进程里既有 root session，也有所有 in-process child。单个
进程级槽位会让「root 的通知」投进最后加载的那个 child 的 transcript。所以：

- root → 常量 `"root"`（一个进程一个根 session）；
- child → `node:<dbPath>␀<nodeId>`——和 `legionIdentities` 用的是同一对字段，因此**同一节点的
  替换会话解析到同一条**（resume/重载能接上），兄弟节点之间永不串台；
- 通道的身份取自**和 `resolveLegionIdentity` 同一条信道**：有 ALS 上下文的 in-process child
  用它，**不读 `PI_LEGION_*`**（那是父进程的 env，rpc 父级下指向祖先）；
- 没有 nodeId 的 utility child 拿一个没人能解析的匿名 scope——「没有后继」就说没有。

**为什么注册表挂在 `globalThis[Symbol.for(...)]` 而不是模块级变量**：宿主加载扩展用
`createJiti(…, { moduleCache: false })`，重载会**重新求值**整个模块图。模块级 `Map` 会被下一次
加载重建，老闭包读的是老模块副本里的空表——「解析到最新通道」在生产里恒为空，而在只 import
一次的测试里却永远是绿的。这条差异写进 `notice-delivery.ts` 头部注释（§模块文档）。

`ExtensionContext` **没有** `sendMessage`（只有 `withSession` 的 `ReplacedSessionContext` 有），
所以「活的 runtime/ctx」在本扩展里就是「最新加载的那个 `pi`」；注册表只是让只有旧 `pi` 的闭包
能摸到它。

## §3 B：失败只打一行，正文进日志

`notice-delivery.ts:339-366`（`deliverNotice` 的 B 段）+ `401-425`（日志写入/裁剪）：

- 正文写 `notice-delivery.log`（在 run store 根下，紧邻 `session-errors.jsonl`），
  每条失败一行 `… notice undelivered scope=… kind=… bytes=… reason=… deduped=N` + `body:` 缩进块；
- transcript 只出一行（**同类失败**每 `NOTICE_FAILURE_WINDOW_MS`=1s 最多一行）：
  `[pi-legion] notice not delivered: <reason>; kind=<Subject>; bytes=<n>; body → <日志路径|没地方写>`
- 合并掉的失败**计数不丢**：日志里 `deduped=N` 递增，`noticeDeliveryStats()` 里
  `undelivered / reported` 可对账；
- 正文永不进 transcript（源码级断言也钉住了：见 §5.4 的 `assert.doesNotMatch(...${text})`）；
- 日志 256KB 自动裁到后半段，投递路径永远不会因为日志失败而更响（diagnostic 不是 verdict）。

## §4 C：同一检测只投一次

`notice-delivery.ts:234-276`（`noticeKind` / `stallNoticeDeliveryKey`）。

要求是「同一 `(child, kind, tier, windowBase)` 在 N 秒内只允许一次投递尝试」。这四个事实只存在
于**检测器内部**，而检测器不是一个对象（每个 postman 实例各有自己的窗口状态，这正是同一事实
能在 30ms 内被戳三次的原因）。三层之间**唯一共享的东西是它们冻结出来的正文**，所以投递键从正文
读：

| 键成分 | 正文里的载体 |
|---|---|
| child | `Subject: Stall notice: <child>` |
| kind | `L1 silence` / `L2 long-running` 段落 |
| tier + windowBase | `running for <elapsed> (threshold <radius>)`——**跨过新的边界，这句话就变了** |
| （丢弃）行 id | `[legion mail #N]` 归一成 `#<id>`（三个写者 ⇒ 三条 row 一个事实） |
| （丢弃）tick 戳 | `Detected at …` 归一成 `<stamp>`（stall-notice-staleness D1：那是快照时间，不是事实） |

- 只对 **stall notice** 生效（`stallNoticeDeliveryKey` 对其它 subject 返回 `undefined`）：
  「同一检测一次」是检测域的概念，别的 mail 不该被静默吞掉（§5 有专门用例）。
- 窗口 `NOTICE_DEDUPE_WINDOW_MS` = 60s：远大于毫秒级 stampede，远小于任何阈值（分钟级）；而且
  新边界必然改变正文 ⇒ 不会被这道闸挡住。
- 这道闸对**失败的尝试**也算一次（"只允许一次投递尝试"照字面执行）：投递失败的 stall 邮件行
  仍是 `PENDING`，postman 下一 tick 会再判一次，但重投被限到 60s 一次——否则一个 stale session
  的 2s tick 会变成 30 次/分钟的同一封重试（B 的同行限流已经会把它压成 30 行/分钟）。
- 每个合并计数写进日志：`notice deduplicated … deduped=N`（验收 #3 要的 `deduped=2`）。

## §5 自证（五组，都是真跑，不是「改了代码」）

### 5.1 验收 #1：模拟 session 替换后，通知**投递成功**

`test/unit/notice-delivery.test.ts` 的两条 wiring 用例**启动真扩展两次**（= 宿主替换 session 的
形状：旧 `AgentSession` dispose ⇒ 旧 `pi` 失效；替换 session 重新加载扩展拿到新 `pi`），然后用
**旧 `pi`** 调真实的 `notice()`：

```
✔ #442 A (wiring): after a session replacement the OLD pi delivers through the NEW load
✔ #442 A (wiring): the notice flow stays silent-and-delivered for a stall mail after replacement
```

断言：正文出现在**新** `pi` 的 transcript 里；旧 `pi` 的 `sendMessage` **一次都没被调用**；
`console.error` **零行**。

### 5.2 验收 #2：总抛错的 sender，10 次失败 = 1 行 + 计数

```
✔ #442 B: ten failures produce ONE transcript line, one log record each, and the count
✔ #442 B (wiring): a host that always refuses produces ONE line and a log entry per failure
```

真实输出（`node --experimental-strip-types` 跑的独立小脚本，注入 `throw STALE` 的 sender）：

```
C statuses: undelivered(deduped=0), deduped(deduped=1), deduped(deduped=2)
transcript lines: 2                       ← 两个失败「类」各一行（stall / phase-timeout）
  | [pi-legion] notice not delivered: This extension ctx is stale after session replacement or reload. …(ctx.fork(), ctx.switchSession(…; kind=Stall notice: worker-0; bytes=449; body → /tmp/…/notice-delivery.log
  | [pi-legion] notice not delivered: This extension ctx is stale after session replacement or reload. …; kind=Phase timeout: worker-0; bytes=119; body → /tmp/…/notice-delivery.log
log（10 条 phase-timeout 失败，只有最后一条被打印，计数在日志里）：
  | … notice undelivered scope=root kind="Phase timeout: worker-0" bytes=120 reason="…" deduped=9
  |   body: [legion mail #10]
  |   From: root
  |   Subject: Phase timeout: worker-0
```

一条是 stall 类、一条是 phase-timeout 类：**同类**才合并（要求原文「同类失败计数去重」）。

### 5.3 验收 #3：30ms 内三次同档检测 → 只投递一次，日志 `deduped=2`

```
✔ #442 C: three detections 30ms apart deliver ONCE and the log says deduped=2
✔ #442 C: a CROSSED boundary is a new fact, so it is delivered (the window is not a mute button)
✔ #442 C: dedupe is scoped to stall notices — other mail is never swallowed
```

三封正文只差 `[legion mail #41/42/43]` 与 `Detected at …348/.361/.377Z`（= issue 里的三个戳），
投递 1 次，日志 `notice deduplicated … deduped=2`；把 elapsed 换成跨过下一档（`3h 0m 0s`）后
**照常投递**（窗口不是静音键）。

### 5.4 验收 #4：`npm test` 全绿，用例数不低于基线

| | 用例数 | 结果 |
|---|---|---|
| 6.2.6 发版点 `298c235` | 2844 | pass 2844 / fail 0 |
| 当前 trunk `origin/master e385aea`（#438/#439/#440） | 2855 | —（本分支 = trunk + 11） |
| **本分支（rebase 到 `e385aea`）** | **2866**（+11） | pass 2866 / fail 0 |

`npm run typecheck` 也绿；`npm run test:integration` 193 pass（CONTRIBUTING 的
“before you push”要求，本分支也跑了）。原先 `test/unit/legion-integration.test.ts:1818` 那条
`/console\.error\(`\[pi-legion\] notice not delivered/` **没有删**，而是随新形状同步：断言
`notice()` 走 `deliverNotice({ live: liveNoticeChannel(scope), fallback: … })`、**不许**直接
`pi.sendMessage`（#442 A 的源码形状），以及投递层仍有 `[pi-legion] notice not delivered:` 摘要行
且**不插值正文**（`assert.doesNotMatch(/…\$\{text\}/)`，#442 B）。

### 5.5 验收 #5：变体自证（把机制改回去 ⇒ 必红）

| 变体 | 改法 | 结果 |
|---|---|---|
| A 回退 | `notice()` 只 `try { sendNoticeMessage(pi, text) } catch {}` | **3 红**：`#442 A (wiring): after a session replacement…` 等（`actual []` / `expected [ '[legion mail #42]…' ]`） |
| B 回退 | 摘要行末尾把 `${text}` 拼回去 | **2 红**：`#442 B: ten failures… the body must never reach the transcript` |
| C 回退 | `stallNoticeDeliveryKey` 直接 `return undefined` | **3 红**：`#442 C: three detections 30ms apart… 30ms of stampede is ONE delivery attempt` |

两种输出（节选）：

```
# 变体 A（回退到 pi）
✖ #442 A (wiring): after a session replacement the OLD pi delivers through the NEW load
  AssertionError [ERR_ASSERTION]: the notice must reach the replacement session
  + actual - expected
  + []
  - [ '[legion mail #42]\n' + …
ℹ pass 8 / fail 3

# 修好的版本
ℹ tests 11 / pass 11 / fail 0
```

## §6 范围与未做

- **#441 不在本 PR**：本文件只做「不再刷屏 / 不再静默丢」，没有改「该不该报」的候选集与判据。
  C 的去重键刻意只用「检测器已经冻结的事实」，所以 #441 改判据时不会与这里打架。
- **runtime 的 completion notice 仍走 `deps.sendMessage`（= 加载期 `pi`）**：`index.ts:2275`
  一带。它不属于 `notice()`（issue 的 A 明确指 `index.ts:639-657`），而且它已经有自己的降级
  语义（`deliverCompletion` 返回 false ⇒ 不记账、下个边界重投）。把同样的活通道接过去是**下一步**
  的同族改动，牵动 `notice-delivery-v2` 的 claim/ledger 不变量，这里不顺手做。
- `launchQueueNoticeSink`（排队提示，`triggerTurn:false`，纯装饰）同样保留原状。
- 未改契约文件、未改版本号、未打 tag、未 publish。

## §7 复现

```bash
node --experimental-strip-types --test test/unit/notice-delivery.test.ts   # 11 条，#442 的五组自证
npm run typecheck && npm test                                             # 2866 条
```
