# #423 — 跨机 launch 不再静默变成本地空壳

> 状态：已实现 + 已验证（单测 / 变异 / 真机）。基线 `origin/master` @ `0e212ff`。
> 合同变更：`docs/contracts/remote-child-fate-v1.md` §2、§4（§4 拆出新的 §4.2）。

## 0. 一句话

跨机 launch 现在**必须拿到启动证据**才返回成功：拿不到远端 terminal 地址、或在窗口内看不到远端
`session.jsonl`，就是 `START_FAILED`，回执里带机器名 / cwd / 终端地址 / `hc` 错误原文 / **该终端最后 6 行
原文**；失败的 launch 不留下任何 `working` 记录，且会把自己创建的空终端 kill + rm，所以同名重派不再撞
`NAME_TAKEN`。

## 1. 根因链（今天实测的四条，各自修过触发条件，本 issue 修「静默」本身）

| 触发条件 | 谁修 | 表现 |
|---|---|---|
| pi 的 `Trust project folder?` 交互提示 | #424（`--approve`） | 终端活着、无 session、父机报 `working` |
| spawn 的 cwd 父目录不存在 | #426（`mkdir -p`） | 同上，或报成「程序不存在」 |
| 任何未来失败（新机器、新提示、网络） | **本 issue** | 同上 —— 一律不许静默 |
| 屏幕证据读的是 `terminal.get.screen` | **本 issue**（真机才暴露） | 该字段在 hc 0.1.21 返回的是模式词 `"exact"`，不是屏幕 |

最后一条是本次真机复现才发现的：`probeRemoteChild` 一直从 `terminal.get` 的 `screen` 字段取「child 自己的
话」，而真实 core 在这个字段里回的是 `"exact"`（模式词）。于是回执里的 `screen:` 永远只有 `| exact`。
真正的屏幕文本只在 `terminal.read`（`{terminal, lines?}` → `{text, how, complete}`）。修法是把它加进
`HC_METHODS` 白名单（纯读，写侧/`attach` 仍然排除）并在探测里读它、失败才回落到 `terminal.get.screen`。
**这条不修，要求 2 的「终端最后几行」只在假 core 上成立。**

## 2. 六条要求的落点

| # | 要求 | 实现 | 钉住它的测试 |
|---|---|---|---|
| 1 | launch 后 ≤30s 校验，失败回执 `START_FAILED: <原因>` | `TerminalSupervisor.confirmRemoteStartup` 超时即抛 `START_FAILED`；窗口 `REMOTE_STARTUP_CONFIRM_MS = 20_000`（≤30s 上限），`0` 仍可关（只有假 core harness 用）；`run.address` 为空同样是 `START_FAILED` | `test/unit/remote-launch-refusal.test.ts`（8 例）、`test/unit/remote-child-fate.test.ts` §4、`test/integration/remote-child-fate.test.ts` T3b |
| 2 | 回执带机器名 / cwd / terminal / hc 原始错误 / 终端最后若干行 | `remoteStartupFailureMessage` + `probeRemoteStartupFailure`（`src/runs/remote.ts`）；屏幕取 `terminal.read` | 同上（每条一行断言）+ 真机回执见 §5 |
| 3 | `run.json` 落 `host` 与 `remoteTerminal` | `Orchestrator.persistChildRemoteFacts`（spawn 成功后立刻写 host / remoteDir / remoteTerminal；此前只有内存记录和 ledger 行有，`run.json` 靠事后整体回写） | `test/unit/launch-verification-record.test.ts` req 3 |
| 4 | status 不得对「无 terminal 且无 session」报 `working`；无证据的退役不是 `success` | `renderLiveChildStatus` 打 `state=unknown` + `liveness=unknown (no terminal and no session on <host>: the launch never proved it started)`；`Orchestrator.retire` 把无证据的 `success` 改写成 `unknown(never started: …)`；`stop` 回执（`retiredRecordNote`）同样不再印 `execution: success` | `test/unit/status-launch-evidence.test.ts`、`test/unit/launch-verification-record.test.ts` req 4（4 例） |
| 5 | 空壳不得进入 stall 候选集（判据：有远端 terminal 或远端 session） | `LegionPostman.runStallNoticeCheck` 在 `isAlive` 之后加一道 `isUnstartedShell` 门（`legion-tools.ts`，**没有动** `stall-notice.ts` 的去重逻辑） | `test/unit/stall-notice.test.ts` 两例（空壳不告警 / 有字节就恢复候选） |
| 6 | 重派同名 handle 不得因空壳占名 `NAME_TAKEN` | 失败路径 `discardRemoteTerminal`（kill + rm 这个 launch 建的终端，失败则回执写 `KEPT: <err>` 并说明名字仍被占）；同时回滚远端 worktree / mirror 目录（否则下一次 `git worktree add` 会顶住）；失败 launch 不留 `launching` 记录 | `test/unit/remote-launch-refusal.test.ts` req 6（2 例）、`test/unit/launch-verification-record.test.ts` req 6 |

判据只有一个实现：`src/runs/launch-evidence.ts`（`launchEvidence` / `isUnstartedShell` / `shellReason` /
`transcriptBytesOf`），status、stall、retire、`stop` 回执四个面共用，所以不会再出现「一个面说 working，另一个
面说 unknown」。

`Execution.status === "success"` 现在**必须**有执行证据（跨机 child：有 terminal 地址或 transcript 有字节）；
LOCAL child 不受这条规则约束（它的 liveness 是本机 pid，`sessionFile` 空是「这一轮没说话」，不是「没启动」）。

## 3. 边界（刻意不碰）

- `src/legion/stall-notice.ts`：一个字没动（#413 的去重逻辑保持原样），候选集在调用侧收窄。
- 镜像泵（#411）：没动 `src/runs/remote-artifact.ts` 的泵逻辑；只把 `probeRemoteChild` 的屏幕来源改成
  `terminal.read`（多一次只读往返，`not_found` / 老 core 时回落）。
- 不用任何外部手段绕过门禁。

## 4. 门禁

```
$ flock /tmp/pi-legion-ci.lock -c "npm run typecheck && npm test"
ℹ tests 2737   ℹ pass 2737   ℹ fail 0        # 基线 2708 → +29（其中 5 个新文件 / 29 例）

$ npm run test:integration
ℹ tests 193    ℹ pass 193    ℹ fail 0        # 无上调：两个假 core harness 显式 remoteStartupConfirmMs: 0
```

无基线上调：`test/unit/remote-child-fate.test.ts` 的唯一改动是把「静默 ⇒ warn + `startupUnconfirmed`」
翻成「静默 ⇒ 拒绝」，`test/integration/remote-child-fate.test.ts` T3 保留读回层语义（门关掉时）并新增 T3b
（门开着 ⇒ `START_FAILED`）。

## 5. 真机复现（`hc 0.1.21`，真 core、真终端、真 `node` 子进程）

本机 `hc machine ls` 为空（没有可用的第二台机器），所以用本机 core 自己的机器名 `hw` 作为「那台机器」：
`hc exec --on hw …` / `terminal.run --on hw` 都是**真的**走 machine 维度（真 core、真终端、真屏幕），
只有被 launcher 启动的「pi」是一个**替身脚本**（渲染 pi 的首次运行提示后挂住）；之所以不用真 pi：真 pi 需要
provider 凭据，而且可能真的启动成功 —— 本 issue 要的是「终端活着但没写 session」。

### 5.1 失败 1：子进程停在首次运行提示（空壳的标准形状）

```
--- hc ls --all (before) : 16 terminals, 0 matching "lgl423" ---
--- hc ls --all (after)  : 16 terminals, 0 matching "lgl423" ---    # 建了又删掉，名字被释放

--- receipt (code=START_FAILED) ---
host 'hw': the launch never proved the child started — no session file appeared at /home/zzjcool/.cache/legion-423-repro/.pi-subagents-mirror/run-423-repro/lgl423-child/session.jsonl within 3002ms
  host: hw
  cwd: /home/zzjcool/.cache/legion-423-repro/proj (the directory this launch asked for, on hw)
  terminal: hw/lgl-run-423--lgl423-child (created, then killed and removed: the name is free again)
  mirror dir: there (the child never wrote into it)
  transcript: /home/zzjcool/.cache/legion-423-repro/.pi-subagents-mirror/run-423-repro/lgl423-child/session.jsonl (does not exist)
  hc error: (the core reported no error: every call answered)
  process: pid 2873268 (a program is running there, but it has written no transcript)
  screen (last 6 lines of that terminal):
    |  Trust project folder?
    |  /home/zzjcool/.cache/legion-423-repro/proj
    |  This allows pi to load .pi settings and resources, install missing project packages, and execute project extensions.
    |  → Trust
    |    Trust parent folder (/home/zzjcool/.cache/legion-423-repro)
    |    Do not trust
  next: hw accepted the launch but the child did not start. The screen above is the child's own words — an interactive prompt, a missing provider, a rejected --extension. Fix that on hw and re-dispatch (a launch that fails later is now refused here instead of becoming a "working" shell).
  Command (run on 'hw' to reproduce):
cd -- '/home/zzjcool/.cache/legion-423-repro/proj' && '/home/zzjcool/.local/share/mise/installs/node/26.8.1/bin/node' '/home/zzjcool/.cache/legion-423-repro/standin-pi.mjs' '--session' '/home/zzjcool/.cache/legion-423-repro/.pi-subagents-mirror/run-423-repro/lgl423-child/session.jsonl' '--no-extensions' '--extension' 'builtin:mcp' '--extension' 'builtin:tool-search' '--extension' '/home/zzjcool/code/.pi-worktrees/legion-423/index.ts' '--no-skills' '--no-context-files' '--append-system-prompt' '/home/zzjcool/.cache/legion-423-repro/.pi-subagents-mirror/run-423-repro/lgl423-child/system-prompt.md' '--approve' 'Task: Do the slice.'
```

这条回执就是要求 2 的验收物：机器名、cwd、终端地址、hc 错误（这里「每个调用都答了」本身就是事实）、
以及**终端最后 6 行原文** —— 今天的 `Trust project folder?` 一眼可读。（窗口用 3002ms 是为了不占 20s；
生产默认 20s，回执里印的就是实际等的毫秒数。）

修复前同一条路径的产物（同一台机器、同一个假 pi）：

```
--- receipt (code=START_FAILED) ---   # 之前：`screen: | exact`
  screen (last 6 lines of that terminal):
    | exact
```

### 5.2 失败 2：cwd 在那台机器上不存在（无需替身脚本）

```
hc ls --all: 16 terminals before, 16 after (no terminal was created: the refusal is pre-terminal)
--- receipt (code=START_FAILED) ---
host 'hw': cwd '/home/zzjcool/.cache/legion-423-repro/does-not-exist' does not exist on hw (remote paths are absolute on that machine; local paths are not translated; list it on that machine with `hc exec --on hw -- ls -ld /home/zzjcool/.cache/legion-423-repro/does-not-exist`)
```

### 5.3 复现脚本

`/home/zzjcool/.cache/legion-423-repro/{repro.ts,repro-badcwd.ts,standin-pi.mjs}`（仓库外，避免把替身脚本
当成产品代码交付）。要点：`resolveHostTarget("hw", {enabled:true, hosts:{hw:{cwd, node: process.execPath,
piCli: <standin>, piLegionRoot: <worktree>, worktreeRoot}}})` + `new TerminalSupervisor({remoteStartupConfirmMs})`
+ `spawnChild({host:"hw", hostTarget})`。

## 6. 变异（去掉校验 ⇒ 断言红）

每个门禁都做了「删掉它 ⇒ 对应测试变红」，全部为实测输出：

1. **launch 校验**（`terminal-supervisor.ts` 的 `if (false && … this.remoteStartupConfirmMs > 0)`）：
   ```
   ✔ req 1: `terminal.run` returning no address is START_FAILED…      (另一道门，仍绿)
   ✔ req 1: a core that refuses `terminal.run` fails the launch…      (另一道门，仍绿)
   ✖ req 1+2: no transcript within the window is START_FAILED with machine, cwd, terminal, hc error and the screen
       AssertionError: expected a SubagentError, got undefined
   ✖ req 4: a shell that reports no pid says so, and a probe that cannot answer still refuses
   ✖ req 6: the refused launch kills and removes the terminal, so the SAME handle can be dispatched again
   ✖ req 6: a terminal that could NOT be removed is reported…
   ℹ tests 8  ℹ pass 4  ℹ fail 4
   ```
2. **status 规则**（`runtime.ts` 去掉 shell 分支）：`ℹ pass 3 ℹ fail 2` —
   ✖ `state=unknown` 例、✖ 缺失 transcript 例。
3. **退役判词**（`orchestrator.ts` 去掉 `success` 守卫）：`ℹ pass 7 ℹ fail 1` —
   ✖ `retire refuses success for a child with no terminal and no transcript`；
   再把 `index.ts` 的 `retiredRecordNote` 守卫去掉：✖ `stop on an already-retired shell says execution: unknown`。
4. **stall 候选集**（`legion-tools.ts` 去掉 `isUnstartedShell` 门）：`ℹ pass 55 ℹ fail 1` —
   ✖ `a SHELL is not a stall candidate`。

## 7. 已知限制 / 未改动

- `run.json` 的 `host` 由 reservation 写、`remoteTerminal` 由 spawn 成功后写；两者都在 launch 内，但**旧记录**
  （#423 之前的空壳）仍然是 `/legion status` 里靠 ledger 行兜底的形态。
- `subagent status` 与 `/legion status` 的「alive」来源仍不同（前者 `supervisor.isAlive`，后者口径含 `starting`
  的 ledger 行）——这条属于 #423 之外的既有差异，本 issue 只保证「无 terminal 且无 session ⇒ unknown」在两条
  渲染路径上都成立（两者都过 `renderLiveChildStatus`）。
- 真机复现用的是本机 core 的机器名（`hc machine ls` 为空，没有第二台机器），替身脚本已在 §5.3 说明。
