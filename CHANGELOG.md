# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Published GitHub Release notes remain available at
https://github.com/zzjcool/pi-legion/releases — this file is the in-repo
summary so you can see **2.x vs 0.16** without leaving the tree.

## [Unreleased] — 6.2.5（patch）

**`#413`：L2 stall notice 的重复投递。** 去重键从「上一封的发出时刻」改成**越过的阈值线**
（`(child, kind, windowBase, thresholdMs, tier)`，`tier = floor(elapsed / thresholdMs)`）：
同一条阈值线无论检查多少次都只 1 封，越过下一条线才再发一封；`extend` 把基准前移到
`now` 并清空 L2 的已通知阶梯，下一封在 `now + loopRadiusMs`（整条阈值重新起算）。
报告：`docs/reports/stall-notice-dedupe.md`。本轮**只做第 1 层**，第 2/3 层（跨机
child 的 quiet 判据、#411 镜像）不在本 PR。

`status` 的归属事实：遗留行不再猜 age，也不再只说「有个叫 X 的东西在远端」。
报告：`docs/reports/status-attribution.md`。本轮范围**只含 D1/D4/D5-rendering**，
其余项已拆分为 issue #407（72h sweep 抹掉跨机遗留）、#408（14 天 retention
删归属证据）、#409（anchor / where 归属）、#410（spawn cwd 误报成程序不存在）、
#411（跨机 transcript 实时镜像）。

- **D1：`<N> old` 改用 `createdAt`。** `updatedAt` 会被 hygiene 的 `markAbandoned`
  每次 sweep 改写，于是搁置一周的遗留显示「2m old」—— age 是假的。现在 age 取
  不可变的 launch 时刻（`nodes.created_at`），`updatedAt` 作为「最后心跳」单独打印。
- **D4：一套归属行，三处共用。** `/legion status` 的遗留块、`recover` 的首行、
  `recover` 的 miss 现在都打印同一个 `renderRemoteOwnershipBlock()`：
  `- <name> · <node.id> · host <h> · <orphaned|unfetched|running|abandoned> · terminal <h>/<addr>`
  + `launched <ISO> (<human>)  · run <runId> · cwd <cwd> · session <basename>`
  + `owner pid <pid> (<alive|gone since <ISO>>)` + `heartbeat <ISO> (<human>)` +
  `collect: …`。`cwd`/`sessionFile` 本来就在 run.json 里，是 `runsNewestFirst`
  把它们丢了 —— 现在带出来，零迁移。owner pid 读 run dir 的 `owner.json`。
- **D5（只做渲染）：live 跨机 child 一定打印 `host=` / `terminal=`。** 之前只有
  记录里恰好有值才有这两行，「本地」与「字段没送到渲染器」在输出里长得一模一样。
  现在每个 live child 都写 `host=<机器>` / `terminal=<machine>/<addr>`，拿不到时
  显式写 `host=local` / `terminal=-`；跨机行再加一行
  `see: hc read <machine>/<terminal>   (cross-machine children have no Herdr pane)`。
  数据来源：run store 的 `child.host`/`child.remoteTerminal` 优先，缺了读 ledger 的
  `nodes.host`/`nodes.remote_terminal`；`/legion status` 与 `subagent status` 同源。

## [6.2.4] — 2026-11-19

6.2.3 真机验证（`docs/reports/release-6.2.3-verification.md` §3.2 / §3.3）暴露的两个遗留。
报告：`docs/reports/orphan-on-natural-exit.md`。

- **D2：父进程「自然退出」不再把仍在远端跑的 child 记成 `aborted`。** 6.2.3 的 shutdown 给
  **每一个** live child 写 `retired` + `node_retired{reason:"session-shutdown"}`，跨机 child 也被
  盖上 `aborted (session-shutdown)`。它既没有杀掉远端进程（实测：父进程退出后远端 `pi` 又跑了
  75s 并写出了真实结果），也没有取回那个结果 —— `recover` 把 terminal 行当「already settled」，
  零 fetch、只回 launch 时的 5 行快照，真实结果**永久不可取**。现在退出按三态判定（判定函数
  `shutdownFate`，`src/legion/orphan.ts`）：
  - 本地 child → **`aborted`**（进程随父退出而死，6.2.3 的行为逐字保留）；
  - 跨机 child 仍在跑 / 状态未知 → **`orphaned`**；
  - 跨机 child 的轮次已经结束（已有判词，或本机已有完整 mirror）而结果没取回 → **`unfetched`**；
  - 收到 abort 且**确认**停止 → 仍记 `aborted`（`stop`/`abort` 路径不变）。
  `orphaned`/`unfetched` 是 `TaskState` 与 run.json 的 `child.orphaned`（含 host / remoteDir /
  remoteTerminal / **remoteSessionPath**），ledger 里是 `orphan_detected{reason:"session-shutdown",
  fate}`（事件类型本来就在闭集 16 条内，契约不动），**节点行故意保持 open**：`hasEnded` 为假，
  `listUnsettledRemoteNodes`（`/legion status` 的 recoverable 块）照旧列得出来。
- **D2：退出不再杀、不再等跨机 child。** 一个还要在远端跑 30–60s 的 child，原来的 shutdown 会
  `terminal.kill` 它，并且在 `--print` 的 `drainBeforeShutdown` 里**等它**（ref 住的轮询定时器
  ⇒ `pi --print` 迟迟不退出）。现在 `releaseCrossMachineChildren()`（`src/extension/runtime.ts`）
  在 drain 之前做三件事，顺序承重：先落定 fate（此时事实还在）、再 abort 这条 in-flight collect
  （`job.collectAbort` 的 signal 合进 `ensureCollect`，因此定时器被清掉）、最后把 job 从表里摘掉
  （drain 与 retire 循环都看不见它）。实测：父进程 **7.96s / 11.81s 自然退出（EXIT=0）**，远端
  `sleep 30` 仍在跑。
- **D2：`recover` 对 `orphaned`/`unfetched` 允许 fetch。** 判定阶梯里「already settled」收紧为
  **`hasEnded` 且没有更新过的 orphan 标记、且 ledger 真的记过判词（`execution`）**。于是：
  6.2.3 留下的 `aborted (session-shutdown)` 行（有 reason、无 execution）、被 hygiene 收敛成
  `failed` 的遗留行、`orphan_detected` 标记行都会**真的去读远端转录**；读回并 settle 之后，
  第二次调用仍是原来的 `already settled` + **零 fetch**（实测镜像 mtime 不变）。
  `recover` 成功时还会 best-effort 把 run.json 记录同步成 `retired`（两本账不再互相打脸）。
- **D3：`subagent({action:"status"})` 的 dead 块补上 host / 远端终端。** 之前只有 `recover` 的首行
  才有这两个事实；现在 `host=remote` / `terminal=remote/lgl-<name>` 与 `supervisor=` / `session=`
  并列（本地 child 不产生这两行）。
- **回归**：SIGKILL 路径（ledger 留 `working` → 新进程 recover 16/16 → 二次 `already settled`）
  未改；本地 child 的 shutdown 仍是 `retired` + `aborted (session-shutdown)`；有 assistant 回复
  即不得 `aborted` 的规则（`attributeParentSessionShutdown`）未动。

## [6.2.3] — 2026-11-19

6.2.2 真机复跑暴露的 D / E 两个缺陷，外加自测台 `make xm` 钉住的两条真 bug（d0 / d1）。
报告：`docs/reports/recover-and-false-failed.md`。

- **D：新会话真的能恢复上一个进程的跨机 child**。`recover` 之前只认**本进程内存里的** ledger
  identity（`ownLegionIdentity()`），而 identity 只在「本进程 launch 过一次」时存在 —— 于是
  「上一个进程已经退出」这个 action 唯一的用途恰好不可用，一律回
  `No legion ledger in this session`，`/legion status` 的 recoverable 块也永远空。
  现在没有内存 identity 时**从磁盘**找（`<cwd>/.pi-subagents` 的 run store）：
  `run.json` 的 `sessionFile` 命中本会话优先，否则 store 内最新、含该 node 名的 run；找到的句柄由
  这次调用自己开关。`/legion status` 与 `recover` 用同一个发现函数，两个界面不会各说一套。
- **D：settle 真的写回，第二次调用零 fetch**。判定阶梯重排为「已 terminal 的行第一，且不碰网络」——
  只读**本机已存在的 mirror**，没有 mirror 就如实说「没有 fetch」+ 远端路径 + 取回命令。
  之前 `already-settled` 排在 liveness 之后，而 `hc` 的终端在程序退出后仍保留
  （`state` 恒为 `live`），所以第二次 `recover` 永远答「still live」、行永远不 settle。
  同时把「终端还活着」与「程序已结束」拆开（`terminalProgramEnd`：`exit_code` /
  `finished_ms` / `reason` / `state === "finished"` / program `done|error`），不再让保留终端冒充活进程。
- **E：成功的跨机 child 不再被判 `failed`**。`assertLocalWorktree(child)` 站在 collect 的验收路径上，
  而跨机 child 拥有自己的树（`worktreeHost`）—— 于是在任何 verdict 被评出之前整条记录就被拒，
  2/2 复现。D13 守卫按它真正保护的东西收窄：远端树上的**本机** fs/git（删除、复用）仍拒，
  远端 verify 走 `machine.exec{on}`，没有 remote-verify 时一条命令都不跑（attestation 照旧）。
- **E：清理失败只做补充，绝不顶替真因**。launch 的 rollback 之前裸调 `removeChildWorktree`，
  它自己再抛就把原始原因覆盖掉；现在逐步 try/catch 聚合成 `secondary: …`（原错误在前，
  `code`/`details`/`stack` 保留）。collect 侧同一原则：有 assistant 回复的一轮就**是**交付，
  管道抛错降级成 `<verdict> (delivered with cleanup warning: <原因>)`，输出 / artifact / ledger
  的二次写入全部 best-effort。
- **E：`pi -p` 自己退出**。终端后端持有一个会话级 `hc connect` 子进程，但没有任何地方关闭它；
  `pi --print` 是「turn 结束让事件循环排空」（从不 `process.exit`），一个 ref 住的子进程就是一次
  永不返回的 headless run（6.2.2 真机是手动 kill 的）。新增 `LegionSupervisor.shutdown?()`，
  `session_shutdown` 在 retire 之后无条件关闭它（幂等、不抛），retire 等待本身也加了 5s 上限。
  真机实测：父进程 `natural_exit=true, killed=false`，13s / 6s。
- **d0：零配置 `collect` 真的会拉 transcript**。read-back 用的是 **launch** 解析器
  （`resolveHostTarget` 要求 `hosts.<h>.cwd`），而零配置启动按调用发现目录、`hosts` 本来就空 ——
  于是在第一次 fetch 之前就失败，还被上层吞掉，调用者只看到随后 D13 那句。新增
  `resolveReadTarget`：读只需要 host，`mirrorRoot` 仅作 fallback；read-back 与终端探针都改用它。
- **d1：远端 child 的 `collect` 能出 verdict**（同 E 的收窄）。另外
  `verificationSummary` 之前用同一守卫读**本机**文件系统，而它的调用者正是 collect head，
  跨机 child 因此丢一整行 `verification:`；现在远端树报记录值并标 `staleUnknown`
  （`staleness not checked here (the tree is on another machine)`）。
- **自测台**：`test/docker/xm/assert.mjs` 的 d0 / d1 从「钉住现状」翻成**正向断言**（mirror 行数、
  远端最后一条 assistant 文本、read-back 行、verdict，且不得出现任何 ownership 句子）；
  新增 `x0`：父 `pi --print` 必须**自己退出**（`killed` 即失败）——harness 之前把这个缺陷写成注释
  并绕过了它。`xm-up.sh` 修一个只在「宿主 HOME 恰好是 `/root`」时才工作的挂载假设。

## [6.2.2] — 2026-11-19

6.2.1 真机复跑暴露的三个问题 + 两个产品要求，都是「第一次就能跑通」这一目标的收尾。

- **预检真的认 `cwd` 了**：之前 `Orchestrator.launch` 把父机 checkout 写死成会话目录，于是
  `cwd: "../my-repo"`（相对，本机 checkout）+ `hostCwd` 仍报「这个会话目录不是 git 仓库」——
  文案许诺的能力并不存在。现在相对 `cwd` 解析成父机 checkout（git 就在**那个**目录里问 origin，
  worktree 也从它建），绝对 `cwd` 与 `hostCwd` 仍是那台机器上的目录；拒绝时点名**实际交付目录**
  （`the directory it delivers from (<dir>)`），不再是会话目录。`resume` / revive 不传这个字段，
  行为逐字节不变。
- **模型三级回退，缺模型不再硬失败**：新键 `subagents.crossMachine.hosts.<h>.model`。解析顺序：
  本次调用显式 `model` → 该键 → 那台机器 `--list-models` 的第一个（**优先同 provider**）→ 仍然
  没有才失败。回退时 launch 继续，handle 上一条 `⚠` 说明「已从 X 换成 Y」以及怎么钉住；失败时
  才打印该机可用模型清单（最多 20 条，超出 `and N more`；空清单给出 `piExtensions` 的修法）。
  `/legion doctor crossmachine` 用同一顺序选模型，所以 doctor 的预判就是要发生的事。
- **父会话退出后，遗留的跨机 child 可以恢复**：`nodes` schema v5 记录 `remote_dir` /
  `remote_terminal`；`/legion status` 多一块「上一次会话启动、本会话没接手的跨机 child」（名字、
  角色、host、状态、远端终端、年龄 + 一条可粘贴的恢复调用）；新 action
  `subagent({ action: "recover", name })` 从旧会话的 ledger 行直接读回那台机器上的
  `<remote_dir>/session.jsonl`（**transcript 补取**），用 collect 的同一套规则判分（截断/读不到
  仍是 `unknown` + 取回命令，不是 `aborted`），落定 ledger 行并返回 collect 文本；仍在远端活着的
  只说「还活着」，不落定；第二次调用是 `already settled` + 已记录结果。
- **拒绝文案与 `allowRoles` 策略一致**：六条交付拒绝（本机不是仓库/没有 origin/没有 git，目标机
  checkout/origin/git）以前都写「改派 worker —— `subagent({ agent: "worker", host, task })`」，
  而 `allowRoles` 默认只允许 `centurion`，照着做必然再撞一次。现在统一成「改派 centurion，让它在那台
  机器上创建 worker/scout」，并点明 `allowRoles` 的默认值，不再打印一个必然被拒的调用。

### 已知限制

- 同一台机器上两个 run 派生**同名** child 会共用 `…/.pi-subagents-mirror/no-run/<handle>/session.jsonl`：
  上一轮残留的转录可能让新的启动确认提前通过、也可能被读成这一轮的转录。换一个 child 名字可立刻绕开；
  根治需要 per-launch 镜像目录（runbook 第 7 节给了排查命令）。

## [6.2.1] — 2026-11-18

跨机派发从「反复失败」变成「第一次就能跑通」。两块：**跨机派发实际可用**（转录回传、入口目录声明、
缺失扩展不再拦路、判词不再把跑完的 child 报成 aborted）与**首次即可成功**（一条体检命令、缺目录变成
提问、默认只允许 centurion、skill 覆盖）。判据冻结在 `docs/contracts/xm-dispatch-fixes-v1.md` 与
`docs/contracts/first-run-success-v1.md`，实跑记录见 `docs/reports/xm-dispatch-fixes.md` 与
`docs/reports/first-run-success.md`。

### 跨机派发实际可用

- **转录回传不再「0 字节 / 半截」**：写入统一落到 `<runDir>/remote/<name>.jsonl`，读取优先用内存里的
  read-back、其次磁盘上已存在的 mirror，最后才回落到本地占位文件；wait 落定后**重新读回一次**，判词
  只建立在最后一次读回上，`read-back … N of M` 的 N/M 也来自同一次。
- **`pi.extensions` 声明成目录时按子树匹配**：`["./extensions"]` 的包接受
  `extensions/<name>/index.ts`（以 `/` 为界，文件声明不会因此放宽）；只有「文件声明 + 请求不在其下」
  仍是 `entry-missing`。
- **缺失/入口不符的继承扩展：跳过 + 一条汇总 warning**，不再一个包一条错误、也不再拦住整次派发；
  只有角色卡显式写进 `requiredExtensions` 才硬失败，且同样聚合成一条。读不到包索引时不跳过
  （那是配置错误，不是目标机的事实）。
- **判词不再把跑完的 child 报成 `aborted`**：读不到转录是 `unknown (transcript not retrieved from
  host '<h>')` 并附远端路径 + `hc exec` 取回命令，而不是「child 没回话」；`wait` 超时仍是
  `running (collect deadline …)`，不是 abort。

### 首次即可成功

- **`/legion doctor crossmachine` 一次性体检**：一次 `hc` 连接、只读；本机 checkout 与 origin、
  `hc machine ls`、目标机的目录/仓库 origin/`node`/`pi`/继承包/模型逐项 `PASS`/`FAIL`/`SKIP`，
  每个 `FAIL` 带真值的 `fix:` 行，最后一行是可整行粘贴的 `subagent(...)`。`/legion doctor` 其余小节
  仍零探测；未选中这一节时旧的静态块逐字节不变。`inherited extensions` 项与 launch 共用
  `requiredExtensionMatches`，不再出现「doctor 全绿、launch 却拒」。
- **缺 cwd 变成一句提问，且在任何 `machine.exec` 之前**：问「那台机器上哪个目录」、附可粘贴的
  `subagent({ …, cwd })`、说明这个路径是在那台机器上读的、本对话没提过就**问用户**、**不要**用
  `ssh`/`hc exec` 去翻目录。旧的 `set a default in subagents.crossMachine.hosts.<h>.cwd` 不再出现。
- **`{"subagents":{"crossMachine":{"enabled":true}}}` + 按次 `cwd` 就是完整配置**（不写 `hosts`），
  `resume` 会重放调用方的 `cwd`/`hostCwd`，所以这条路径可恢复。
- **默认只允许 `centurion` 跨机**：新键 `subagents.crossMachine.allowRoles`（默认 `["centurion"]`）；
  别的角色要显式放行，拒绝文案给出可直接粘贴的放行片段 —— 跨机是交付单元的能力，scout/worker 应当由
  远端 centurion 在其本机派生。
- **SKILL.md 覆盖跨机**（agent 每轮先读的地方）：description 增加
  `Cross-machine dispatch adds host + cwd to the same call`，正文新增 `## Cross-machine dispatch`
  ——最小调用、唯一必填是目标机上的目录、来源优先级、**不知道就问用户**、**不要** `ssh`/`hc exec`
  试探远端、doctor 与 runbook 的指路、远端 child 起不来时读退出码 + screen 原文 + 可复现命令。
  `npm pack` 的清单里有 `skills/pi-legion/SKILL.md`，`test/unit/skill-cross-machine.test.ts` 钉住
  「删掉即红」与打包可见。
- **父机目录不是 git 仓库有它自己的答案**：「不是仓库 / 是仓库但没 origin / 两侧 origin 不同 /
  本机没有 git」是四句不同的文案；「不是仓库」给的是「在 checkout 里重开 pi（或传相对 `cwd` +
  `hostCwd`）」与「改派 worker」，不再教在一个非仓库里执行 `git remote add origin`。

### 已知限制

- 同一台机器上两个 run 派生**同名** child 会共用 `…/.pi-subagents-mirror/no-run/<handle>/session.jsonl`：
  上一轮残留的转录可能让新的启动确认提前通过、也可能被读成这一轮的转录。换一个 child 名字可立刻绕开；
  根治需要 per-launch 镜像目录。runbook 第 6 节给了排查命令。


## [6.2.0] — 2026-11-18

跨机器派发从「能跑」变成「能配、能排查、能演示」：配置只写覆盖，失败带证据与下一步，
演示照着文档能把一台 Mac 父机 + 一台远端机器走完。minor 是刻意的——下面是能力新增，
不是修修补补。

### 跨机配置：hosts 默认来自 `hc machine ls`，扩展按包名在远端解析，`cwd` 可按次覆盖

跨机器配置不再要求父机替远端手写一堆路径，也不再「一台机器只能一个工作目录」：

- **hc 就是机器清单**：`subagents.crossMachine.hosts` 可以完全不写；机器只要在
  `hc machine ls` 里就能派发。准入（是否允许去那台机器）与配置（路径在哪）分开：
  不在注册表里的机器**按名字拒绝**并列出这个 core 认识的机器 + `hc machine add` 命令，
  不会再报一句 `machine_unknown` 了事。resume / 读回不查注册表（注册是按 `HC_SESSION`
  的），仍走原来的四步 gate。
- **自动发现**：`hosts.<h>` 最少可以是 `{}`（或只写 `cwd`）。缺的 `node` / `piCli` /
  `piLegionRoot` / provider 扩展由**一次** `machine.exec` 探测填充：node 解析到
  **真实二进制**（不是 mise/asdf shim），`pi` 解析到 launcher 背后的 **JS 入口**
  （`dist/bundle/cli.js`，用 `--version` 验证）。显式配置永远优先，写全了的旧配置
  **零探测**、解析结果逐字段不变。
- **cwd 允许多个**：`hosts.<h>.cwd` 降级为默认值；每次调用可用
  `subagent({ host, cwd })`（或 `hostCwd`）覆盖，路径必须是那台机器上的绝对路径，
  不存在在启动前报错；既没默认也没覆盖时明确拒绝（不猜 HOME）。
- **扩展按包名重锚（v1.2）**：父机 argv 里的 `-e <父机绝对路径>` 不再"映射不了就丢"。
  探测会报告远端每个已安装包的 `name + dir` 和它声明的 `pi.extensions` 相对入口，
  于是 `…/pi-any-endpoint/extensions/index.ts` 自动变成远端同名包下的同一相对路径
  （Mac 父机 → Linux 目标机的实测场景）。包在远端不存在 ⇒ **启动前报错**，点名包名、
  父机路径与三种修法（远端安装 / pathMap / 关继承）；包在但入口不同 ⇒ 同样报错并列出
  它实际声明的入口。探测只在 argv 真的需要时才发（`needsPackageIndex`），全显式旧配置
  仍然零额外往返。
- **缓存与自愈**：发现结果内存 + 磁盘缓存（TTL 默认 900s，`discoveryTtlSeconds` 可调，
  `refresh: true` 强制重探）。探测失败不缓存；远端升级 `pi` 后 preflight 会触发一次
  重新探测并重试。
- 新增 `crossMachine.discover` / `hosts.<h>.discover` 开关；`hc` 客户端 allowlist 增加
  只读的 `machine.list`（写侧 `machine.add` / `machine.rm` 仍禁止）。

契约增补：`docs/contracts/cross-machine-spawn-v1.md` Addendum v1.1；
报告：`docs/reports/cross-machine-host-discovery.md`。

### 失败可解释：启动 8 秒门给出退出码 / 屏幕原文 / 可复现命令，read-back 分四类，doctor 给下一步

远端 child 的 stdout/stderr/退出码从来不会被读回，唯一的结果载体是那台机器上的
`<remoteDir>/session.jsonl`。于是「child 死在第一个 turn 之前」在父会话里只剩一个观测：
`execution: unknown (no messages in session)` + 一句 `read-back … FAILED — not_found`，
既没有原因也没有下一步。实测（pi 1.5.2）：`-e <不存在的路径>` 与不可用的模型都会让 `pi`
**exit 1 且不创建会话文件**——所以「没有转录」就是「启动期死了」，不是「跑完了没说话」。
契约 `docs/contracts/remote-child-fate-v1.md`；运维版 `docs/runbooks/cross-machine-live-e2e.md` §3.6。
本机 launch 逐字节不变。

- **启动期死亡在 launch 阶段被证明，而不是 collect 时猜**：remote launch 在 `terminal.run`
  之后过一道启动确认门（`REMOTE_STARTUP_CONFIRM_MS = 8_000`，500ms 一轮，
  `TerminalSupervisorOptions.remoteStartupConfirmMs` 可调/可关）。每轮读一次
  `<remoteDir>/session.jsonl`，而 `terminal.get` 报 `finished` 或数字 `exit_code` 即**证明已死**
  → `START_FAILED`，报错里带退出码（或 `the core reported none`）、镜像目录现状、child 自己
  渲染出的最后几行屏幕（它自己的 stderr/stdout）以及一行可复制的
  `Command (run on '<host>' to reproduce):`。到点仍活着只是没写 ⇒ 只 warn 并照常 launch
  （慢机器不是 bug），记录 `startupUnconfirmed: true`。`remoteStartupConfirmMs: 0` 保持旧行为。
- **read-back 失败带上是哪一种「没有」**：`RemoteReadbackFailure` 增加
  `fate`（`no-child` / `no-session` / `path` / `unreachable`）、`evidence`（1..5 行短证据，
  如 `terminal finished`、`exit 1`、`dir holds: system-prompt.md`）与 `nextStep`，`reason`
  保留 core 原文、渲染前缀不变。`no-child` = 终端已结束且没写转录；`no-session` = 还活着
  但还没写（不是判决，附 `no pid` 那条证据）；`path` = 记录与当前配置的镜像目录不一致；
  `unreachable` = target 解析失败 / core 起不来 / 探测的 `machine.exec` 被拒。
  `CollectResult.remoteReadback` 带上三者，于是 `execution:` 不再把 `unknown` 留在那里：
  追加 ` · read-back: <fate>`（例如
  `execution: unknown (no messages in session) · read-back: no-child`）。`started` 永远不会
  是失败：文件在而读失败一律归 `path`。**「死亡」是关于地址的断言**——没有
  `remoteTerminal` 的旧记录只能推断终端地址，推断出的名字 core 不认识时**不判死**
  （归 `no-session` 并在 evidence 里明说名字是推断的）。`ChildRecord` 因此新增
  `remoteTerminal`（core 实际持有的 `host/mappedName`），供后续进程直接发问。
- **`hosts.<host>.piExtensions` 在终端存在之前就按那台机器校验**：`remotePreflightScript`
  对每个条目 `test -e`，第一个不存在就 **exit 17**：
  `host '<host>': piExtensions entry '<entry>' does not exist on that machine (subagents.crossMachine.hosts.<host>.piExtensions is read ON <host>; …)`，
  映射为 `INVALID_PARAMS` + details `{ host, missingExtension }`，且 `terminal.run` 一次都不发。
  这类路径是 argv 里的 `--extension`，pi 对不存在的扩展 **exit 1**（pi 1.5.2 实测：
  `Error: Failed to load extension "/missing/x/index.ts": Extension path does not exist`），
  修复前只会表现为「转录一直没出现」。它与 v1.2 的按包名重锚互补：重锚管「同一个包在远端
  换了个根」，这一条管「显式写下的路径在那台机器上根本不存在」。**v1.2 起不再有「映射不了
  就丢弃 + 打一行 stderr」这条路**，所以本版也不再需要把被丢弃的扩展搬到结果里：映射不了
  的启动前就拒绝了。
- **`/legion doctor` 新增 `crossmachine` 一节**（`legion-doctor`，契约 D8）：标题
  `## Cross-machine (host targets)`，逐 host 列 `cwd` / `node` / `piCli` / `legionRoot` /
  extensions / `worktreeRoot` 的解析结果（解析不了的打 `INVALID` 并给
  `CROSSMACHINE_UNRESOLVED` issue）、最近一次交付预检（`ok (…)` / `failed (…): <message>` /
  `never`），以及一条按当前配置拼好、可直接粘贴的最小 `subagent` launch（terminal 阶段
  省略 `next`）。这一节是只读的：不跑 `--list-models`，不发任何远端探测。
- **解析不了的 host 不再以 `No blocking fixes` 收尾**：`crossmachine` 一节每个解析失败的
  host 都会产出一条 error issue，于是 `report.ok` 已经是 false，而 actionable 列表仍打印
  通用的「没有阻塞性修复」——报告自己跟自己矛盾。现在补一条点名 settings 键与
  `/legion doctor crossmachine` 的下一步（`CROSSMACHINE_UNRESOLVED` 触发）。

报告：[`docs/reports/remote-child-startup.md`](docs/reports/remote-child-startup.md)。

### 演示可用性：phases 校验放宽并点名、共享 origin 预检前置、新增演示 runbook

- **phases 的终态阶段可以省略 `next`**（`phase-machine`，契约 D2）：`{ id: "done", terminal: true }` 与 `next: []` 现在完全等价，`parsePhaseMachine` / `normalizePhaseMachine` / `validatePhaseMachine` / `isTerminalIn` 任何路径都不再抛 TypeError（此前这份最小机器会报 `phases[2].next: next must be an array`）。
- **phases 校验一次报出全部问题，并按分类点名到具体阶段与边**（`phase-machine` / `agents`，契约 D1/D3）：每条错误带 `category`（固定顺序 `structure` → `terminal` → `successor` → `unreachable` → `rework`）和一行 `fix:`（缩进 4 空格；terminal / successor / unreachable 三类必带最小合法示例）；首行仍是 `Agent '<file>' has an invalid phase machine: N problems in M categories.`，错误条目行仍是 `  - <path>: <message>`。
- **跨机交付预检提前到 phases 校验之前**（`orchestrator`，契约 D7）：`host` + `worktree` 时先问「那台机器能不能交付」，再问 phases。此前 phases 写错会先报 phases，改完才发现真正挡路的是一个没有 origin 的 checkout。预检顺序固定：`local-git` → `local-origin` → `remote-checkout` → `remote-git` → 「是 git 仓库」→ `remote-origin` → 「两侧同一个 origin」；硬失败一律 `INVALID_PARAMS` + `noModelFallback`（机器事实不去试下一个模型候选），最后一步 `git ls-remote origin` 是软的：只记 `fetch: "unreachable"` + detail，不 throw。
- **跨机交付的拒绝文案给出两条出路**（`remote-worktree` / `cross-machine-preflight`，契约 D6）：本机无 origin、目标机无 origin、两侧 origin 不同、目标机 checkout 缺失或不是仓库，全部以 `Two ways out:` 收尾 —— ①修好这个前提（加 remote / `set-url` / 装 git / 换 `cwd`）②改派 `worker`（不需要 worktree、origin 或 git，文案里给了可粘贴的 `subagent` 形状）。开头那句 `cross-machine delivery needs one shared remote` 原地保留，仍然可 grep。
- **目标机没有 `git` 现在是一类自己的拒绝**（`cross-machine-preflight` / `remote-worktree`，契约 D5/D6）：`host '<h>': git is not available on that machine (git --version exited <n>: <detail>).`，不再把它说成「不是 git 仓库」；建树路径里 `rev-parse --git-dir` 的 exit 127 同样判成 `remote-git`。
- **新 runbook [`docs/runbooks/cross-machine-centurion-demo.md`](docs/runbooks/cross-machine-centurion-demo.md)**：照着演示的三步（同一个 origin → `subagents.crossMachine` → 一条 `subagent` 调用），含每个配置键「不填会怎样」与失败文案对照表。真机 e2e 断言仍在 [`docs/runbooks/cross-machine-live-e2e.md`](docs/runbooks/cross-machine-live-e2e.md)（要 `HC_SESSION=test-*`），两份不混用环境变量。
- **三个演示坑的前后对照**写在 [`docs/reports/cross-machine-demo-ux.md`](docs/reports/cross-machine-demo-ux.md)：phases 报错、origin 预检顺序、doctor 的下一步，各自贴了改动前后的真实输出。

## [6.1.1] — 2026-11-17

修跨机器派发不可用：`hosts.<h>.piExtensions` 曾被 settings 白名单静默丢弃，导致 provider 扩展
进不了 child argv（远端 child 报 `No API key`）。启动探测改为 `--list-models` 式（不依赖凭据），
四类拒绝都附可复制命令行与目标机实际模型；`/legion doctor` 共用同一解析。

**这不是行为变更，是让 6.1.0 宣称的跨机能力真正可用。** 不设 `host` 的本地路径与协议形状
逐字节不变；变化只发生在跨机启动前的配置解析与探测。

### Fixed

- `parseCrossMachine` 现在解析 `piExtensions` / `worktreeRoot`：此前两者被白名单静默丢弃，按报错或
  runbook 配好 provider 扩展也不会进 child argv。绝对路径校验仍在 `resolvePiExtensions` /
  `resolveWorktreeRoot`（load 判 shape，use 判远端路径）。
- 启动探测从 `-p ping` 改为 `--list-models`：期望的 model 可见即放行，不再因为另一个 provider 的
  `No API key` 误判；列表非空但没有该 model 时新增 `model-missing` 分类；pi 明确
  `Using custom model id` 时放行。
- no-model / conflict / model-missing / exit-code 四类拒绝都附可复制的原命令行
  （`Command (run on '<host>' to reproduce):`），model-missing 还会列出目标机实际可用的前 5 个 model。
- runbook 修正 provider 扩展示例路径为 `.../pi-any-endpoint/extensions/index.ts`。

## [6.1.0] — 2026-11-17

一次**跨机器**的发布：子 agent 可以跑在另一台机器上（`hc` 的 ssh 远端），而这台机器只负责
调度、判定和收结果。新增的维度只有一个 —— `host`：本机（缺省）或某个 `hc` machine 的名字。
选它作为 6.1.0 而不是 7.0.0 的理由很简单：**不设 `host` 时，行为与 6.0.x 逐字节相同** ——
同一份 params（恰好 5 个本机键、没有 `on`）、同一套 argv、同一个本地 worktree 语义、同样
的 collect/verify 路径；新增能力全部挂在「名字了另一个机器」这一条分支上。

跨机时，交付通道只有一个：**git remote**。远端那棵树自己 commit、自己
`git push -u origin pi-subagent/<host>/<name>-<sha8>`，父机再从同一个 remote fetch 那个 sha；
远端路径永远不被翻译成本地路径（翻译不了的 argv 路径就拒绝，不静默降级）。

同版还有两件**只有真机器才能教**的事：远端 child 的 env 不能被本机 env 覆盖（`hc` 的 env 是
merge-only overlay，父机的每一条都会盖掉远端正确的那条 —— 实测表现是远端 `pi` 报
`No models available` 与 `spawn npx ENOENT`）；以及远端 `piCli` 必须是 node 能执行的 JS 入口，
`/root/.pi/agent/bin/pi` 那种 shell 启动器会让 node 去解析 `case "$0" in`。

### Added

- **`host` 维度贯通**（`cross-machine-spawn-v1`）：`AgentConfig.host`、frontmatter/overrides、`subagent` 工具参数、`ChildRecord.host`/`worktreeHost`、run.json 与 `legion.db`（schema v3 → v4，`PRAGMA table_info` 预检后 ALTER）。legion 侧一律叫 `host`，`hc` 线上叫 `on`，两者**只在一处**映射（`grep -rn 'on: host' src/` 恰好 1 条）；缺省时 params 保持恰好 5 个本机键。
- **远端 worktree + git remote 交付**：`src/runs/remote-worktree.ts`（建树/删树/provision/origin 归一化等 12 个函数），分支名 `pi-subagent/<host>/<name>-<hex8>`；树是 checkout 的**兄弟目录**（`<dirname(cwd)>/.pi-worktrees/<name>`），镜像目录同样是兄弟（`.pi-subagents-mirror`），都不进交付分支。`assertLocalWorktree()` 单点兜底：远端路径上的本机 `fs`/`git` 操作一律拒绝（D13）。
- **远端 verify 四分类**（`src/runs/remote-verify.ts`）：`code`（真跑完、退出码非 0）/ `timeout`（`hc` 在 `machine.exec` 截止点杀进程）/ `unreachable`（机器连不上）/ `unknown-host`（core 不认识这个名字）。**只有 `code` 会变成 `rejected`**；其余三类一律 `unknown` —— 没测过的活儿不判不合格。预算超过 `hc` 的 600s 上限会被 clamp，并在判词与 stderr 里各说一次。
- **产物回收与截断标记**（`src/runs/remote-artifact.ts`）：先问 `file.read` 的**总行数**（`lines` 就是文件总行数），再读尾部窗口，`truncated` / `byteCapped` 由本进程自己判定（`hc` 的字节截断是静默的，不能靠"调用成功"推断完整）。镜像落在 `<runDir>/remote/<name>.jsonl`，绝不进 `sessions/`。collect 的正文会写 `4000 of 250000 lines (truncated — tail only…)` 或 `read-back … FAILED (… rests on no transcript at all)`。
- **跨机 resume 四步校验**：记录有 host → 该 host 可达 → 远端终端存在（报**地址**与出路）→ 远端 worktree 存在。四步各自失败文案带 `(step N/4)`；终端仍 `live` 时 resume **接管而不重启**（不在远端 fork 出同名第二个终端）。
- **`subagents.crossMachine` 配置**：`hosts.<host>.{cwd,node,piCli,piLegionRoot,pathMap,piExtensions,worktreeRoot}`，以及 `enabled`（缺省关闭；关了还点名 host 会**拒绝**而不是悄悄在本机跑，D1）。
- **`piExtensions`**（S5.6 真跑结论）：远端 child 的模型可能**由扩展提供**，而 child 的 argv 带 `--no-extensions`（不能继承本机插件集）。该键列出「那台机器上要加载的扩展」，按 `--extension <p>` 追加在开关之后；模型来自扩展时不填，launch 前的探测会在 10 秒内拒绝并点名这个键。

### Changed

- **远端 child 不再继承本机 env**：`hc` 的 `env` 是 merge-only overlay，父机每一条都会**盖掉**远端正确的那条。现在远端 launch 完全不发 `env` 键（远端进程保留它自己的环境与凭据），本机分支保持不变。这是实测修复：同一台机器上 `pi` 手动可跑，作为 child 却报 `No models available` / `spawn npx ENOENT`。
- **launch 前多一次可跑性探测**（远端）：用 child 的**完整 argv**（去掉 task、加 `-p ping`）在目标机跑一次，10 秒级。`No models available` / `No API key` → 指向 `piExtensions`；`conflicts with` → 指向"别把已装扩展再加一次"；其它非 0 退出 → 带回 stderr 前 5 行。目的是**10 秒内失败并说清原因**，而不是等 5 分钟到 collect 截止。
- **preflight 加两项**：`piCli` 必须能被 `node` 执行（绝对路径的 shell 启动器 → `INVALID_PARAMS`，文案给出 `…/dist/bundle/cli.js` 形态）；远端 core 若已携带 legion identity 则拒绝 launch（D7）。
- **collect 依赖注入 `remoteVerify` / `remoteReadback`**：两者都在 `index.ts` 的两处 `verifyRunner` 位点装配；未装配时远端 child 仍**显式拒绝**而不是拿本机文件冒充结果。

### Fixed

- **远端 worktree 不再把镜像写进交付分支**：镜像目录从 checkout 内移到其兄弟位置（否则一次 `git add -A` 会把 system prompt 与会话转录提交进交付分支）。
- **`resume` 的 project 级 `crossMachine` 不再被 settings 白名单丢弃**（此前只有 user 级生效）。
- **`npm-install` 的锁文件探测发往属主机**：`INSTALL_LOCKFILES` 一张表两消费者；远端无锁文件时拒绝，且不写 marker。
- **失败残留清理**：launch 失败后远端空的镜像目录会被 `rm -rf` 掉；同一远端目录里两个文件同名不同源会被**拒绝**（否则后一个静默覆盖前一个）。
- **`NAME_TAKEN` 报地址而非裸名**，回滚 retire 失败也不再吞掉（否则那个名字永久被占且无线索）。
- **`collect` 一个跑在别处的 child**：不再返回"空结果"，而是说明转录在那边、并给出 `status`/`resume` 的出路。

### Compatibility

- **不设 `host` 时，行为与 6.0.x 逐字节相同**：本机 launch 的 params（恰好 5 个键、无 `on`）、argv、`--session` 路径、worktree 语义、acceptance/verify 判词格式全部未变；`collect` 结果里不会多出 `remoteReadback` 键。
- `legion.db` 从 v3 **单向**升到 v4（新增 `host` / `worktree_host` 两列，`PRAGMA table_info` 预检、幂等）；v4 库不能被 6.0.x 打开。
- 远端 launch 需要目标机上有 `node`、可被 `node` 执行的 `pi` CLI、以及本包（`piLegionRoot`）；缺任一项会在 preflight 的 10 秒内拒绝并点名该配的键。

## [6.0.3] — 2026-11-17

### Fixed

- **可用内存估算把 page cache 当成已占用，导致 spawn 准入闸误拒**。
  `availableMemoryMb()`（`src/supervisor/child-memory.ts`）在 cgroup v2 下把
  `memory.max - memory.current` 当作候选值，再与 `/proc/meminfo` 的 `MemAvailable` 取 `min`。
  但 cgroup 的 `memory.current` **包含可回收的 page cache**：一台实际有 11.4 GB 可用的机器，
  缓存热起来后 `max - current` 只剩 ~479 MB，闸门据此拒绝所有 spawn
  （报错 `insufficient memory … 479 MB available, 1184 MB required`），而同一时刻
  `free -m` 显示 11.4 GiB 可用。表现是「一台空闲机器莫名其妙起不了子 agent」，
  而且随缓存变热而恶化：本机在早期跑的两次全量门禁是 2379/0，同一份代码到后来变成 35 条 supervisor
  用例失败，唯一变量就是 page cache。
  现在 cgroup 候选值改为 `min(limit, limit - current + inactive_file)`（`inactive_file` 从
  `/sys/fs/cgroup/memory.stat` 读），即把可回收部分加回来，与内核 `MemAvailable` / `free -m` 对齐；
  clamp 到 `[0, limit]`，`current` 超过 limit 时得到 0 而不是负数；读不到 `memory.stat` 时
  **退回原来的 `limit - current`**（保守值，且不会抛）。
  闸门本身与门槛语义（`PI_LEGION_MIN_FREE_MEM_MB` + 每 child 预留）完全未变，既有断言
  （含「1280 MB 档位」那条准入算式用例）一条也没有放宽。
  实测：本机 `availableMemoryMb()` 从 ~900 MB 变为 ~5150 MB，`npm test` 从 35 条失败变为
  2386/0，`npm run test:integration` 从 1 条失败变为 123/123 —— 没有改任何测试、没有设环境变量。

## [6.0.2] — 2026-11-17

四条都是「通知该到的时候没到」的同一族问题：scout-guard 提醒迟到一轮，完成通知在父 run
不再 settle 时沉底，单 child 被攒批窗口白等，已经 `wait` 取过的结果又被播报一遍。

### Fixed

- **完成通知不再沉底（`agent_end` 兜底放行）**。D1 把 `agent_settled` 当作唯一投递时刻，
  但被 abort/ESC 打断、或会话半路消失的 run 可能永远走不到 settle，`parentRunActive` 就卡在
  `true`，排在它后面的通知再没有边界可落（实测：子 agent 于 03:25:30.447 retire，父会话从未收到
  push，用户靠 `subagent status` 轮询才捞到）。现在 `agent_end` 按一次 `SETTLE_FALLBACK_MS`（2s）
  兜底定时器：正常路径上 `agent_settled` 紧接 `agent_end` 到达并取消它，所以**常规场景仍只在
  settle 边界投递一次**；只有 settle 真的没来时才由兜底接管边界。兜底走的是同一个 `flushOutbox`，
  `if (item.triggerTurn) break` 的「一个边界只叫醒一次」语义原样保留（新 run 开始、
  runtime dispose 都会取消它）。
- **单 child 完成不再白等攒批窗口**。`track()` 会把每个 job 都 `addPending` 进 run 的分组，
  包括 `watching: false` 的 utility child；后者永远不会走到 `onTerminal`，却一直占着 `pending`，
  于是兄弟的 batch 永远无法「全员到齐」，一律等满 `flushMs`（默认 10s）。现在协调器多一个
  `stillReachable` 判定（runtime 按 `watching === true` 回答），不可达成员不再推迟 flush，也不影响
  `allSettled`/`partial` 的分组形状。这就是实测 +32.2s（retire 03:26:39.801 → 通知 03:27:12.050）
  里的结构性那一段；窗口本身是硬上限、永不续期，算术上不可能单独造成 32s。
- **已 `wait` 取过的结果不再重复播报**。「终态只告诉一个消费者」：带 `artifactId` 的结果早就由台账
  `markRead` → `undeliveredIds` 保证，但降级路径（无台账句柄 / 无 artifact 行）只认 `deliveredOnce`
  —— 它记的是「发过什么」，没有「取过什么」。于是父会话 `wait` 拿到正文之后，仍可能被同一条结果的
  完成通知叫醒（实测噪音 +138s / +85s）。新增 `consumedByControl` latch，只由 `wait` 通道写入
  （因为它确实把正文交给了调用方）；`collect` 走自己的台账声明读，`status` 根本不读正文，
  对它们加 latch 会删掉父会话唯一一次拿到内容的时机，故刻意不纳入。
- **scout-guard 的提醒不再「等干完才到」**：投递方式从 `deliverAs: "followUp"` 改为
  `"steer"`。宿主在**每个 turn 边界**抽空 steering 队列——当前 assistant 消息的 tool 批跑完、
  下一次 LLM 调用之前（`agent-loop.js:191`）——而 followUp 队列要等到模型**不再发起 tool call**
  才抽（`agent-loop.js:197`）。只要 agent 还在连续读文件，旧实现的提醒就永远排在「本来要停」之后：
  这正是「干完了才插一句、还多烧一轮」的成因，不是概率问题，是模式选错。改成 steer 后，第 N 次读
  之后的那个边界就能看到提醒，模型还来得及当场改派 scout。`triggerTurn: true` 保留——宿主在
  `triggerTurn: false` 时根本不走 steer，而是把消息压到 turn 结束再 append。
  `#182` 的「subagent 已禁用」暂停通知**刻意不改**：它是说明性提示、不是行动请求，`triggerTurn: false`
  保证它不会为此烧掉一轮。
  streak / 冷却语义未变：提醒触发时 streak 同时归零并写入 `cooldownMs`，冷却期内的读调用既不计数
  也不会二次提醒，所以一段连续 streak 仍然只提醒一次。回归用例
  `test/integration/mock-llm-scout-guard-delivery.test.ts` 用真宿主断言提醒落在第 8 次读之后的
  turn 边界（第 9 次读仍待发起），改回 `followUp` 立刻变红（观察到 turn 13）。
- **取证：19/19 条历史提醒全部落在「回合结束之后」**。扫 `/root/.pi/agent/sessions/` 全量 236 个会话
  （39 034 条 entry），共 19 条 `scout-guard-notify`、分布于 17 个 session：
  19/19 的前一条 entry 都是 `role:"assistant"` 且 content 里**没有任何 toolCall**（`stopReason:"stop"` 18/19，
  余一条是 `error` 空内容），提醒与其上一条的落盘时间差 **min 8ms / median 12ms / max 28ms**——
  即提醒是在工具批已经结束、模型已经收尾之后才落盘的；19/19 的 `parentId` 都等于提醒自身的 `id`，
  说明提醒**自己开启了新回合**（没有一条落在 toolResult 边界上，0/19）。其中 **9/19** 的下一轮
  纯 text/thinking、一个工具都没调，是纯浪费；剩下 10 条里只有 5 条真的补派了
  `subagent`/`vexillatio`，其余是 bash/async_status/write 之类的收尾调用。
  提醒到下一轮 assistant 的间隔 min 6.0s / median 20.3s / max 92.4s。

## [6.0.1] — 2026-11-13

### Changed

- **`scout` 取消默认 `toolBudget`（回退 6.0.0 的 D12）**：`agents/scout.md` 不再声明
  `maxToolCalls: 60`。计数上限不是侦察的边界——`toolTimeoutMs` 已经把单条命令的挂起挡住，
  `timeoutMs` 已经把整轮定在 10 分钟，加一个调用数只是把「10 分钟」改写成「60 次」：一个范围合适但
  读得多的侦察（没走 `codemode` 批量、纯 grep + read 配对）会在 60 次上停在一半的事实清单，父会话要么
  重派要么自己补读，代价通常大于上限省下的那点时间。而且它失败的形态很脏：越限之后每次调用都被拒但
  照样计数，子 agent 把剩下的轮次花在被拒的调用上，而不是把已经读到的东西写出来。回到 4.0.0 的既定原则
  ——时间与深度才是边界，`toolBudget` 是给某个顽固角色留的手术刀，不是默认配置（`worker` / `centurion`
  本来就不带计数上限）。字面量删除，其余卡片无变化；`parseBudgets` 的「省略 = 无限制」语义未动。

## [6.0.0] — 2026-11-11

一次以**记账**为中心的发布。子 agent 的结果不再靠「谁认领过」传递，而是落成一个不可变的
台账（`artifacts` + `consumptions`，schema v3）：投递判据从进程内 claim 集合改成账本投影，
结果正文存成按轮次寻址的文件，agent 拿到的是预览加 `legion_output` 指针，那条路径不再交给它。
验证也从「徽章」变成「对某一棵树的事实」：pass 记下 `cwd`、契约文本与树指纹，换树或换检出即
失效，`to: "done"` 先判边后付费，`collect` 的头把契约究竟跑了什么说清楚。同版另有 floating
viewer 的 transcript 对齐、`tok/s` 换成实测 decode 分母、TUI 文件缓存的自适应上限（#391）、
以及模型选择链的三处修复。

Major 只因为两件对程序化使用者的破坏：`consumeCollect*` 回到裸 `CollectSnapshot`，
`ClaimedCollect` 从 `pi-legion/api` 消失，没有兼容层；`legion.db` 单向升到 v3。日常使用
（`subagent` / `wait` / `collect` 工具、`/legion` UI、SQLite 账本）不需要任何动作。

### Breaking

- **`consumeCollect*` 重新返回裸 `CollectSnapshot`，`ClaimedCollect` 已从 `pi-legion/api` 移除**
  （`result-ledger-v1` D12）：`const { snapshot, claimedNow } = await rt.consumeCollect(…)` 与随之
  而来的 `unclaimUndelivered(…)` 一并删除——投递由账本投影判定，没有回滚 API，也就没有需要
  交还的 claim。
- **`legion.db` 是单向升级**：v2 → v3 自动、幂等、旧四表零列变更；但 v3 库不能被 5.x 打开
  （`src/legion/db.ts:381` 的版本守卫会以 `schema version 3 is newer than supported version 2`
  拒绝），要回退只能删掉 `legion.db` 让它重建（`rebuild` 可从磁盘恢复 `artifacts`，
  `consumptions` 重置——只会多推，不会少推）。
- **「读过就不再提」的判据换了**：进程内 claim 集合 → 账本投影（`owesDelivery`）。账本不认识的
  artifact id **fail-open** 投递，宁可多推一次也不静默丢结果。

### Added

- `legion.db` schema **v3**（`LEGION_DB_USER_VERSION` 2 → 3，迁移幂等、旧四表零列变更）：`artifacts`（不可变结果的台账）+ `consumptions`（每个 consumer 的两维事实：`read_bytes` 高水位 / `notified_at` 只写一次）。`rebuild` 可从磁盘恢复 `artifacts`，`consumptions` 一律重置（只会多推、不会少推）。
- 子 agent 输出改存 `<runDir>/artifacts/<name>/r<round>.md`（原子写、按轮次寻址，同名多轮不再互相覆盖），由 `src/runs/artifacts.ts` 统一负责路径/轮次/内容幂等。
- `legion_db` 的 statement cache 上限 64 → 128（v3 把 distinct SQL 文本推到 69，旧上限已无 headroom）。
- **`legion_output({ name, round?, offset?, limit? })` 工具**（`result-ledger-v1` D7 / P5b）：在插件层注册（root 与 child 都有，utility child 除外），按 `(name, round)` 解析 artifact id，header 带 `round · bytes · settled · phase`；分页读显式写 `partial i/N lines · notifications not suppressed — read to EOF to settle`（D6：读到 EOF 才抑制通知），文件与 ledger 的 `bytes` 不符时打 `changed-on-disk` 且不推进 full。
- **通用 `read` 命中 artifact 全文也计消费**（D5 / P5a）：`tool_result` 把 `<runDir>/artifacts/**/r*.md` 的路径反查成 artifact——无 `offset`/`limit`、未被工具截断、磁盘大小等于 ledger 的 `bytes` 时记 `read_bytes = bytes`；分页读不落账。root 因此不需要任何工具注册例外。

### Changed

- **“读过就不再提”从进程内 claim 集合改成账本投影**（`docs/contracts/result-ledger-v1.md`）：投递判据统一为 `owesDelivery`（投影 + 最小兜底集），账本不认识的 artifact id **fail-open** 投递（宁多推，不静默丢）。`collect`/`wait` 在 abort net **之后**才落 read 账（结果被 `interrupted …` 替换时一笔不记）。
- **“你看到的是摘要”说出口**（D8 v1.12 改判 / D9，P5c）：finished 缓存的 strip 保留（内存护栏），改为**如实标注**——`collect`/`wait`/内联 collect 对被 strip 的快照追加 `this is the cached head (4.0 KB of 24.5 KB); full text: legion_output({ name: "…" })`（无 ledger 行时写 `at least`，绝不编造总数），不再带那句无条件的「输出被截断时读这个文件」；通知正文与 TUI 折叠行以 `preview 4.0 KB of 24.5 KB` 标注预览（不再让预览字节数冒充结果大小），`details` 增 `artifactIds`。
- **artifact 的路径不再交给 agent**（P6）：`collect`/`wait`/vexillatio 批量/两种通知形状一律改印 `full text: legion_output({ name, round })`；`tool_call` 对 `read`/`write`/`edit` 落在 `<runDir>/artifacts/` 下的调用直接 `block` 并指路（`path.resolve` + `path.relative` 判包含，非字符串前缀；任何无法判定的形状 fail-open，普通文件不受影响）。写 artifact 被拒的理由与不可变性同源（A1）。文件和 `rebuild` 都不受影响；P5a 的通用 `read` hook 退居兜底（`bash cat` 这类路子仍然记账）。

- **`wait` 交回的是预览，不再把全文再塞一遍**（D4）：当 ledger 能给出该 artifact 的完整字节数时，正文按 4 KB（UTF-8 安全切分，不劈码点）预览，并复用
  collect 的 `cached head (4.0 KB of X)` + `legion_output({ name, round })`
  指针；拿不到总数时保持全文——截断却编不出总数才是不可接受的。`still running` 行从 `(elapsed 190108ms)` 改成 `(spawned 190.1s
  ago)`：那个数字一直是「启动至今」，不是本次等待时长（D3），`elapsedMs` 本身未改。
- **collect/wait 的头写明契约验证的事实**（#5）：正常是 `verification: N command(s) · log …`，两种「空绿灯」单独成句——
  `0 commands — by contract, nothing ran` 与 `STALE — the checkout changed after the pass`；legion 子节点没有记录时写
  有相位的子节点没有记录时写 `never ran (no contract)`；worker 这类没有相位的子节点、以及非 legion 调用，都不出现这一行。事实来自子节点的 verification 行，用与门禁同一套判据
  （checkout + 树指纹，不看相位 stint），所以父级在决定合并时不需要相信子节点的措辞。
- **`status all` 不再是空开关**（D7）：不带 `name` 的总览仍是 live-only；`all:true` 在其后追加 retired/finished 记录（同名 live 优先，不重复列一行）。
- **launch 级 `verify` 与契约的 ```legion-verify 围栏互相点名**：`index.ts` 两处 schema 描述与 `agents/worker.md`
  各加一句「前者是 extension 在 collect 时自己跑的 attestation，后者由 supervisor 在 verifying 执行」，`wait` 的 `timeoutMs`
  文案同时改成真实默认（目标里最小的角色 `timeoutMs`，否则 900000）——vexillatio 的同名字段保持 flat 600000，注释写明两者不同（D2/D8）。

### Removed

- `reported` set、`claimReported` / `claimCachedResult` / `claimIfTerminal` / `unclaimReported` / `unclaimUndelivered`、`snapshotOrigins` 的 claim 用途、`TrackedJob.consumedByTool` / `notified` 与 watch 闸门、`join.dropBuffered*`、`P3` 的 shadow 模块（共 -2.9k 行）。`consumeCollect*` 回退成返回裸 `CollectSnapshot`（**对外 API 破坏**，无兼容层）。
- 契约 `notice-claim-v1.md` 归档到 `docs/contracts/archive/`（HISTORICAL），语义由 `result-ledger-v1.md` 取代；`notice-delivery-v2.md` 的 D1-D6 仍有效。

### Fixed

- **`legion-verify` 的四种写法各有归处，空的绿灯不再来自「没解析出来」**（#394）。`parseLegionVerifyCommands`
  只认 ` ```legion-verify ` 围栏，于是契约把验收写成 `## legion-verify` 标题、` ```legion-verify bash `（info string
  多一个词）、`~~~legion-verify` 或裸行 `legion-verify: npm test` 时都解析成 0 条命令，而 `runVerification` 的
  `let passed = true` 让这个「没解析出来」直接变成 `verification passed`。现在 `parseLegionVerifyContract` 带回
  `shape`：`fence`（反引号与波浪号都算）与 `bare-line`（`legion-verify: <cmd>`，允许 `>` / `#` / 列表符前缀）
  解析并执行；**空块 / 空裸行 / 完全没提**仍按 §7.3 直通 done（`none` / `fence`），只有「行首出现了
  `legion-verify` 但形状读不出来」才判**失败**并点名两种合法写法。行中段的散文提及不算声明，不会把 read-only
  队判红。collect 头多出第三态 `verification: FAILED — 0 commands; nothing the supervisor parses is declared`
  （`VerificationSummary` 带 `passed`，失败行不再借用「by contract, nothing ran」）。*已知保留*：裸行扫描不做
  围栏感知——在 ` ```text ` 引用块里写一行 `- legion-verify: cmd` 会被执行，因为那两行字与一条真声明在语法上无法区分。
- **child 说「不行」不等于不验证，但验证只对结果跑**（#393）。`applyVerification` 开头那道
  `status !== "accepted"` 门让诚实交 `{ok:false}` 的 child 一条命令都跑不到（`task-verify` 永久 pending、
  父级拿不到机器证据）；门已删除。取而代之的是三条边界：①机械绿灯**不翻案** child 的自述——`status` 原样保留、
  `level` 升 `verified`、reason 写成 `verified by … — the child's own verdict still stands (…)`（child 自己的
  reason 与红路径的输出同享 1 500 字符预算）；②命令报错才判 `rejected (attested)`（`verify` 的 schema 描述不再
  宣称一个全仓不存在的 `rejected (verified-path)` 标签）；③**只有终态 collect 才验证**——`collect` 超时返回的
  `running` 是快照不是结果，`finishCollect` 对它不调 `applyVerification`。③是删门之后第一次修复翻的车：快照会在
  child 仍在写的 worktree 里跑命令，deadline 已过、`Math.max(5_000, …)` 几乎必超，实测产出伪 `rejected`。另外
  `carried` 改为只丢弃真正会被执行的 criteria——带 `command` 但没有 `verification-output` 证据的 pending 不再
  静默从父级清单里消失。
- **settle 之后的 steer 不再把 child 判成 aborted、也不再烧掉 resume**（#392）。`TerminalSupervisor.sendText`
  会 `observe()` 却不读结果：terminal 已经 `finished` 时照样 `terminal.send`，还把记录无条件改回 `"live"`。
  下一次 collect 于是把「末轮只有 user 消息」判成 `aborted`，retire 把 phase 推向 `aborted`，`childFromNode`
  从此以 `CHILD_TERMINAL` 拒绝 resume——一句迟到的 steer 让一场已结束的队永久不可恢复。现在 `sendText` 在
  `observe()` 之后、`terminal.send` 之前拦下 `finished` / `retired`，以及 core 已经不再认识这个 terminal 的
  `not_found`（复用同一个 `isNotFound` 判据）：抛 `CHILD_TERMINAL`、**一次也不发**，`state` 只在发送真的落地后
  才记 `live`；`steerChild` 不再把这个码压成 `NOT_FOUND`。`SteerDisposition` 三态与 `abortLegionPhase`
  一行未动（§I4 的「非 session-shutdown 的 retire 行为逐字不变」继续成立）。
- **`done` 先判边、后付费**（D10）。`PhaseTransitionDecision` 的拒绝形状新增 `failed`（失败的那条 `require`
  名），`legion_phase { to: "done" }` 先按 `verification_passed = true` 试判一次（问的是「就算契约绿了，这条边会过吗」，与
  `require` 的书写顺序无关）：只有这个假设下边仍会拒绝时才不付钱。于是注定被 `children_settled` 拒的请求不再先付一次全套验证；`children 全失败 ⇒
  forced failed` 立即生效，不必等 supervisor 的下一个 tick；被拒请求也不再写 `task_summary`（`updated_at` 不再被一次没发生的事抬起来）。无
  `verification_passed` 要求的边**仍然**必须先有一张本轮新 pass 才放行——原 P0-1 洞的回归用例已补（删掉「先跑再放行」即红）。
- **契约可以放在 runDir**（D1）：规范路径 `<worktree|cwd>/.pi-legion/contract.md` 缺席时回退
  `<runDir>/contract.md`（存在性判断：记录的路径只在文件仍存在时优先，否则规范路径，再否则 runDir 副本），`contract_file` 门、记录的
  `contractPath`、`done` 门与 submitting 阶段的验证走同一个答案。`docs/legion-v2-contract.md:358`
  此前是「文档允许、代码不认」，read-only 队照文档写会卡在 planning。
- **换过检出也判 stale**（D11）：pass 记了 `cwd`；节点现在的检出（`worktreePath ?? cwd`）与它不同时，即使树指纹相同也不再复用——同 commit、同
  untracked 状态的两个目录指纹本来就相等，只有路径能区分「同一个树、不同的交付目录」。
- **scout 默认带 tool budget**（D12）：`agents/scout.md` 增加 `toolBudget: {"maxToolCalls": 60}`（frontmatter
  只接受 JSON 拼写，flow map 会让整张卡解析失败，注释已写明），这是有界失败，不是结果预算。
- 删除 `index.ts` 里的死字段 `budgetMs`（只声明、无任何使用）（D9）。
- **`tok/s` 的分母换成实测 decode 时长（首 delta → 末 delta），不再用含 prefill 的
  `generationMs`。** 旧口径的分母来自 `message.durationMs` = **请求发出 → 响应结束**
  的整段墙钟；对 215 个真实 session / 22306 条 assistant 调用回归得到
  `durationMs ≈ 4.3s + output/137`，即每次调用约 4.3s 固定开销。agentic 场景里 75% 的
  调用只有 31–800 个 output token，于是长期显示 11–60 tok/s，而模型真实解码约 137 tok/s
  （低估 2.3–12x）。`InProcessSupervisor.handleSessionEvent` 与
  `RpcSupervisor.handleRpcEvent` 现在对称地把**实测**的首 delta→末 delta 墙钟折进
  `src/supervisor/decode-clock.ts`（纯函数、总函数，挂在 `publishEvent` 过滤之前，否则
  thinking-only 轮次测不到），经 `LegionSupervisor.decodeMs(name)` 供
  `StatusEntry`/`VizNode`/`RateSampler` 使用；`generationMs` 仅在「没人测过」的行上兜底。
  契约：`docs/contracts/tps-decode-denominator-v1.md`。
- **删掉 tok/s 的 60s 墙钟回退悬崖。** 旧 `MIN_RATE_GENERATION_MS=1000` 在窗口内
  ΔgenerationMs 低于 1s 时把分母换成整个 60s 墙钟窗（短窗口上等于 60x 低估）。现改为
  下限钳制 `MIN_RATE_DECODE_MS=200`（`Math.max`）；两个分母都为 0（账本-only 行，无任何
  时长测量）时直接返回 `0`，不再靠钳制编出一个速率。
- **`decodeMs` 是「这一生」的事实，不是存活查询。** retire / 进程退出后
  `children.delete()` 不再抹掉累加值：按 name 保留在有界内存归档里，因此同一行不会在
  retire 瞬间从实测均值跳回 `generationMs`（实测 136 → 69 avg t/s）。树行 `avg t/s` 的
  信任下限按轴分开（decode 200ms / generation 1s），单条短消息不再被旧门禁整条吞掉。
- 图表 x 轴冻结判定（#346）与 flat-run 折叠把 decode 采样一并纳入，避免「只有 decode
  前进」的真实进展被当成静态而被跳过。
- **声明式机器的 `→ done` 不再绕过验证。** `maySelfComplete`（#371 G5）把 `done` 交给了
  作者声明的边，但该请求随后直接进 `evaluatePhaseTransition` 落盘相位，而 `runVerification`
  只挂在「离开成功相位」那条路上——于是 `{ id: "verifying", next: [{ to: "done" }] }`
  （无 `require`）的机器可以在一份红契约上收队，一条命令都没跑：docker 演示会话
  `01a1c964` 实测到了这个形状。`requestLegionPhase` 现在在执行 `done` 边**之前**补一道门：
  存量 pass **必须是当前相位里产生的**（`checkedAt >= phaseSince`）才复用；否则立即重测
  （存量失败、陈旧 pass 都算没有证据），失败则相位不动并回报 `Verification failed: <log>`。
  这只补在作者写的边上——`state-machine.ts` 已为注入边写过同一个不变量。`to: "verifying"`
  路径不变，`done` 的重试也不付二次执行成本（新增用例见 `test/unit/legion-tools.test.ts`）。
- **只读守卫不再把 `2>/dev/null;` 判成写文件。** `child-guard` 的 `/dev/null` 放行靠
  `/^\/dev\/null(\s|$)/`——目标后面必须跟空白，于是 `git config --list 2>/dev/null; …`
  这种最普通的只读探针被拒（演示里 scout 为此废掉一回合）。改为取重定向目标 word
  （终止于 `;` `&` `|` `(` `)` 与空白/换行）后全等比较，但只接受**不会隐藏未检命令**的终止符：
  `;`（`shellChunks` 会切开）与 `)`、空白、行尾；`|` `&` `(` 保持历史拒绝，
  `2>/dev/null|tee f` 不会成为过写检查的新旁路。`=>`/`>=`/`->`/引号内 `>`/`&>file`
  的既有判定不变。
- **`0 commands` 的回执点名「围栏」这个可修的原因。** `verificationHow` 的两个变体都写明
  只有 ` ```legion-verify ` 围栏块会被解析、`## legion-verify` 标题不算；`agents/centurion.md`
  与 `skills/**/SKILL.md` 补最小示例与「`0 commands` 不是绿灯」。格式要求此前只存在于 frozen 的
  `docs/legion-v2-contract.md` §7.2，真正写契约的 agent 读的是角色卡/技能卡，于是「标题 +
  普通围栏」静默解析为 0 条并直通 done。
- **验证通过后树变了就不再算数。** `VerificationResult` 多记三样事实：`cwd`、`contractFile`、
  `tree`（HEAD + `git status --porcelain --untracked-files=normal` + 契约文本的 sha256）。契约文本
  必须进摘要，因为 `.pi-legion/` 通常是 **untracked 目录**：`git status` 只输出一行
  `?? .pi-legion/`，改里面的内容不会改变那一行。`to:"done"` 只在 pass 属于本相位**且树未变**时
  复用，否则当场重测。三种「记不了」的情形分开处理：没有 `.git` 的检出（只读队、无 worktree）记为
  `no-git-checkout` 并照旧复用；git 探测失败/超时（二进制缺失、权限）记为未知，强制重测；升级前
  落库、没有 `cwd` 的 pass 同样重测一次。supervisor 的自动收尾路径不会自己跑验证，遇到过期 pass
  改为推迟 + 每个「已记录树 / 当前树」组合一次提示（换到新 pass 后自动解除），由 agent 的
  `legion_phase { to: "done" }` 触发重测后完成。演示里
  centurion 在 verifying 之后改契约再 amend 进 squash 的那个洞就是这个。
- **收队提示改为显式 staging。** 注入的 squash 提示改成「显式 add 交付文件、只保留一份契约、排除
  `.pi-subagents/` 与运行日志、报分支名 + HEAD sha + 文件清单」；`agents/centurion.md` 与
  `skills/pi-legion/SKILL.md` 同步，卡片 verdict 要求也补上文件清单。squash 本身仍然由 LLM 执行
  （插件不跑 git），所以这是提示层能做的全部。


## [5.6.0] — 2026-11-09

### Added

- `test/unit/agents.test.ts` 新增散文守卫：`agents/**`、`examples/**`、`skills/**/SKILL.md` 里提到已删除角色（`reviewer`/`planner`/`search` 等）即失败，除非该分句显式声明“已删除”；#301 之后同一类陈旧文字不再能静默发布。
- `docs/audits/2026-11-07-docs-vs-code.md`：本次文档/代码漂移审计报告（代码为事实源，每条双侧行号证据）。

### Changed

- 文档全面对齐 5.5.0 代码（以代码为唯一事实源）：`phases` 省略即**无状态机**（#371）、三个 terminal 的前置条件、`terminal` 第三种 spawn 后端、`diagnose` 的 `section` 参数、13 个控制动作全表、`/legion` 子命令全表；`CONTRIBUTING` 的发布流程改为 npm trusted publishing（OIDC + `--provenance`，无 token 无人工审批）并补发布 checklist；`agents/*` 的 `acceptance.level` 口径（合法但非机器门禁），worker 卡改 `attested`。
- `docs/design.md` 按现行架构重写：五层结构、`RoutingSupervisor` 三后端仲裁、声明式相位机独立成节、`legion.db` 四表六索引、`stdin EOF → SIGTERM → SIGKILL → 后代 pgid sweep`、mail/notice 的 claim 与五值域。herdr 时代正文与 F1–F46 实验记录移入 `docs/archive/design-herdr-era.md`。
- `src/shared/types.ts` 中 `phases` 的注释改为 #371 语义（原文仍写「省略 = 内置四阶段」）。
- contracts 归档纪律：`esc-cascade-v2` / `esc-abort-v1` / `drop-non-pi-kinds-v4` 移入 `docs/contracts/archive/`（抬头标 HISTORICAL / LANDED）；`retire-hardening-contract.md` 改名 `docs/contracts/retire-hardening-v1.md`（仍生效）；`spawn-mode-visibility-v1` 标 `implemented` 并修正已失效的验收命令；`declarative-phase-machine-v5` 的 `draft` 改 `implemented`；stall 两类阈值的术语消歧。
- 孤儿文档归档到 `docs/archive/`：`qa-hunting-round`（依赖的角色卡不在本仓库）、`performance-2026-10-19`（v3.1.0 测量快照）、`legion-v2-delivery`（v2 交付账本）。
- `launch-admission-queue-v1` 新增 `REV — 落地校正` 小节：实测 D7（shutdown 不清队列）、D8（`collectInline` 有意重排）、D9（pill 的 slots 维度无可达发射点）、D12（两个进程事件只登记不发射）与正文不符，正文保留、实测写在 REV；D2 的论证依据（F3）已被 #279 取代。
- `legion-v2-contract`：重名错误码明确为 `NAME_TAKEN`；删除不存在的 `legion-gc` 入口（worktree 仅由 launch 失败回滚删除，hygiene 保留）；`tree_finalized` 标注“闭集已登记、无发射点”。
- viz 契约标注证据链：门槛只在本机 `bench/perf-core/10-legion-frame-alloc.ts:431-436` 与测试断言中，完整报告未入库（`reports/` 被忽略）、CI 不采集。
- `osc-busy-plugin`：把“不得 printf OSC 7501”明确为**调用方纪律、非运行时守卫**（Non-goals 就不解析子进程 stdout）。

### Fixed

- **Root mail is no longer pushed into the host's followUp queue while root's own run is live.**
  `LegionPostman.deliverRootInbox` now skips the WHOLE inbox — every mail kind, not just stall
  notices — while the recipient's agent run still holds the turn, leaving the rows `PENDING` so the
  existing staleness predicate judges them again on the tick before a real injection
  (`docs/contracts/root-mail-run-boundary-v1.md`): the incident behind it is a notice held through a
  2s hold, injected 2s after the release, and only relabelled `ACCEPTED → OBSOLETE` when the parent
  retired the child 14s later — text already queued, not recallable. The fact is read through one
  seam (`isRunActive` → `isLegionRunActive(nodeId)`) backed by the session runtime's single
  `parentRunActive` closure, never a copy; the reader is published where identities are adopted
  (`adoptLegionIdentity`, so the lazily created root ledger is covered) and withdrawn first in
  `dispose()` through an ownership-checked disposer. It fails open: an absent or throwing probe
  delivers immediately, exactly as before the gate. Known limitations: the child→parent `steer`
  channel is still a mid-turn injection; a stuck `parentRunActive` (a host that never emits
  `agent_settled`) holds root mail while the flag is up — `dispose()` clears only the in-memory
  notice outbox, so those rows stay `PENDING` in the ledger and a reopened session's postman would
  deliver them, and only `kind: "notice"` has an age predicate at all (`question`/`report`/`handoff`
  have none); a session that never registered `agent_start`/`agent_settled` has no reader at all, so
  it keeps the pre-gate behaviour; and a continuously busy session defers root mail by arbitrarily
  many turns — the gate only promises "not this turn", since delivery still needs a tick to land in
  the idle window after `agent_settled`, and only stall notices carry a `Detected at` line that makes
  a late arrival self-evident.

## [5.5.1] — 2026-11-07

### Fixed

- **A synchronous `vexillatio` batch no longer leaves an expired stall notice behind for the parent.**
  When the call runs under a legion node, the batch holds that node's mail while it collects
  (released in a `finally`), and a child that ends obsoletes the pending stall notice naming it; a
  still-actionable notice (live child, timed-out collect) is delivered unchanged, and the hold
  suppresses delivery, not detection. Known limitations: an already-**accepted** row cannot be
  recalled from the host's followUp queue, a sweep covers the first 100 pending rows only (and skips
  rows another delivery has already claimed), and bypass status writers (orphan scan, session
  interrupt, team-failure and abandonment sweeps, resume) rely on the postman's next tick.

## [5.5.0] — 2026-11-07

一次「让 centurion 从黑盒变成可看的终端」的发布。herdr-app 的 agents 侧栏只列**自己上报状态**的终端
（OSC 7501），而带 worktree 的 centurion 一直是 headless `pi --mode rpc` 子进程：它永远不会出现在窗口里，
也没人能 attach 进去。本版在 hc（herdr-core）宿主上给它换了一个 transport —— 同一个 worktree、同一个
centurion，跑成终端里的真 `pi` TUI：窗口里能看实时过程、点进去能接管、Esc 打断还保留上下文。
**worktree 归属（§9 REV-17）与创建逻辑一行未动**，变的是运输层，不是权限。

### Added

- **第三个 spawn 后端 `terminal`（`docs/contracts/centurion-terminal-backend-v1.md`）。** 仲裁只在
  「`agent.name === "centurion"` 且 `worktree === true` 且宿主带 `HC_TERMINAL_SOCKET` + `HC_TERMINAL_ID`」
  时选它；其余情况逐字节等于旧表达式。探测是两个环境变量读取，零子进程、零 git probe。
- **`hc` 终端里的 centurion 会出现在父会话所在 space。** 子终端复用父终端的 `herdr.space` 标签
  （每个 supervisor 只读一次并缓存），名字映射为 `lgl-<handle>`（≤32 字符、`[a-z0-9_-]`），
  因此 herdr-app 侧栏按 hc 的 parent 关系把它挂在派发它的会话下面。
- **能力上限如实声明，不编造事实。** 不接事件流（父 TUI 的实时/卡死视图对它保持沉默，而不是误报）、
  不实现 `inFlightTool` / `lastEventAt`、`capabilities.promptDisposition = false`。
- **`abort` 与 `retire` 的语义分开。** `abort` = `terminal.interrupt`（Esc：进程、上下文、turn 计数都在，
  之后仍可继续）；`retire` = `terminal.kill` + `terminal.rm`。

### Changed

- **`hc` 可执行文件解析链：`HC_BIN` → `PATH` → `~/.local/bin/hc` → 裸名。** 实测 hc 终端自己的 PATH
  只有 `/usr/local/bin:/usr/bin`，而安装器把 `hc` 放在 `~/.local/bin` —— 少了这一段，第一次真实运行就是
  `spawn hc ENOENT`。
- **测试脚本同时净化 `HC_TERMINAL_SOCKET` / `HC_TERMINAL_ID`**（与既有 `PI_SUBAGENT_*` 同模式）：
  测试宿主必须 hermetic，否则在 hc 终端里跑 `npm test` 会让四条冻结测试里的 7 条
  「centurion + worktree ⇒ rpc」断言因真实宿主而翻红。
- **`.github/workflows/release.yml` 改用 npm trusted publishing（OIDC）。** 不再依赖 `NPM_TOKEN`
  与手工 `npm stage approve`：`id-token: write` 让 npm CLI 用 job 的 OIDC token 换一次性发布凭证，
  `npm publish --provenance` 同时附上 provenance。

### Docs

- 新增 `docs/contracts/centurion-terminal-backend-v1.md`（D1–D13、四条不变式、Non-goals）。
- `docs/legion-v2-contract.md` 追加 **REV-31**：worktree 归属不变，改的是 transport 选择。


## [5.4.1] — 2026-11-07

一个只改口径的补丁版。5.4.0 把 MCP 默认给了所有子会话，于是 `acceptance.role: read-only` 的 scout
也能调用 server 暴露的写能力——这一条已经在 5.4.0 里披露，但「只读」这个词仍然带着它兑现不了的暗示。
本版把名实对齐：角色只保证「不通过 bash 改工作区」，`edit`/`write` 由卡片的 `tools:` 决定，
MCP 与 `codemode` 脚本的副作用不在契约内。**没有任何行为变化**，`npm` 上的 5.4.0 与 5.4.1 代码等价。

### Docs

- **「只读角色」的口径写清楚了（选项 C：只改名实，不改行为）。** 5.4.0 把 MCP 默认给了所有子会话，
  于是 `acceptance.role: read-only` 的 scout 可以调用 MCP server 暴露的写能力。三条路（角色默认不给 MCP /
  按 server 白名单 / 只改名实）里选了第三条：annotation 级防火墙做不到（真实 server 的 `annotations`
  实测全为 `null`），而按角色切掉 MCP 会废掉 scout 的检索。现在 `README.md` 有一张
  **What `read-only` actually covers** 表——它只保证「不通过 bash 改工作区」，`edit`/`write` 由卡片的
  `tools:` 决定而非角色，MCP 与 `codemode` 脚本的副作用不在契约内；`agents/scout.md` 的正文里也写了同一条，
  免得 scout 自己复述一个它兑现不了的承诺。**行为没有任何变化。**

### Changed

- **完成通知只在父 run 边界交付，80s 上限降级为健康计数**（`docs/contracts/notice-delivery-v2.md`）。
  以前父 run 活跃时通知入 outbox，超过 `MAX_PENDING_AGE_MS`（80s）就**强制发送**——但宿主
  （pi 1.5.0）在 settle 边界就会 drain followUp，强发既不让模型早一秒看到，也不解决任何问题，
  只让通知提前脱离 claim 过滤，于是同一份结果经 `collect` 与通知各到一次，还常被误读成
  用户输入。现在 `agent_settled` 是唯一投递时刻，一次边界只交付**一条会唤起 run 的通知**
  （`triggerTurn:false` 的可连着交付），其余留在 outbox 等下一次边界；`flushOutbox()` 不再
  `splice(0)` 一次发完。80s 上限只对**仍可交付**的通知计数一次 + 重新武装，**不再发送**；
  计数供诊断读取，当前无生产消费者。
  同时（D4/D5）：footer 只列**确定会另发通知**的兄弟（同 runId、未终态、
  `watching:true`、未被 claim/工具消费、未被判死），措辞退回陈述句 `Still running: a, b`，
  删掉"(notifies separately when it finishes)"这类假承诺；通知首行固定加
  `▣ legion · automatic completion notice — not a user message` 标明机器来源（正文与 `details`
  形状不变，TUI 折叠行不受影响）。`wait`/`collect` 的工具结果永不被抑制（`notice-claim-v1.md`
  D1-D10 的 claim 语义继续有效；D5 的逐字节条款由 v2 首行标记覆盖）。

- **BREAKING（导出 API）：`NoticeQueueStats.forcedFlushes` → `heldOverCap`**。字段不只改名，
  语义也反转：不再是「强制发送次数」，而是「被压超过 `MAX_PENDING_AGE_MS` 的通知条数」
  （按条计一次、只算仍可交付的，只计数不发送）。`pi-legion/api` 的 `SessionRuntime`
  消费者需要跟着改；仓内零生产消费者，只有单测读它。

- **stall 通知自带检测时刻，并在投递前判活**（`docs/contracts/stall-notice-staleness-v1.md`）。
  以前 `Stall notice:` 的正文只有 `elapsedMs` 快照、没有时刻，而它对投递路径没有任何
  「已失效」规则（只有 `Phase timeout:` 有）——于是 10m 阈值刚过时检测到的通知，可能在 child
  早已返回报告很久以后才经 postman 或 #384 抢占送达，读信的人无法判断这份事实有多旧。现在：
  (1) 正文首行之下固定一行 `Detected at <ISO>.`（`detectedAt` 由 tick 传入，模块仍不读时钟，
  非有限数则省略该行）；(2) 新增纯谓词 `isStaleStallNotice`：`Stall notice:` 通知点名的 child
  **全部**已结束（`hasEnded`，含 `settled`/`retired`）⇒ 在发送/确认前转 `OBSOLETE`，
  `mail_bounced` 的 `reason` 为新的 `obsolete_after_child_end`；(3) 该谓词由 postman 三条投递/
  确认路径、#384 `takePendingMail` 与 250ms 轮询计数**共享**（计数改「可释放」口径：take 不会
  交出东西就不唤醒阻塞的 `wait`/`collect`，否则会出现空返 + 误报 `interrupted`）；正文无可解析
  名字 / 名字非法 slug / 探测器节点不存在时一律**照常送达**（never guess）。不改投递节奏、不改
  `formatMail` 信封、不改 schema，作废只发既有的 `mail_bounced`。

## [5.4.0] — 2026-11-06

一次「把子 agent 的工具面还回去」的发布。默认后端（in-process）的子会话以前**悄悄**少了三样东西：
角色卡里声明的 `codemode` 根本解析不出来、`legion_mail` / `legion_tree` / `legion_phase` 被 `tools:`
白名单裁掉、以及任何 MCP server 都连不上。三者成因各不相同（loader 缺 `extensionFactories`、白名单对
所有已注册工具生效、`session_start` 只由 `bindExtensions` emit），本版一并补齐：MCP 默认给所有子会话，
`PI_LEGION_CHILD_MCP=0` 一键回到旧行为。三轮对抗式 review 各抓出一个会真出事儿的生命周期缺陷
（退役不回收 MCP 连接、补发的 `session_shutdown` 关掉**别人的** ledger、截断窗口里 stale ctx 跳过自身清理），
全部修掉并留下门禁。

### Added

- **子会话默认加载 MCP（`docs/contracts/child-mcp-v1.md`）。** 以前子会话连不上任何 MCP server，卡在两层：
  `collectChildExtensions` 从不给 `builtin:mcp` 路径，而 MCP 的 `loadConfig` + `startConnection` 全部在
  `session_start` handler 里，`session_start` 又只由 `bindExtensions` emit——`createAgentSession` 不调它。
  现在两条路都补齐：所有子会话（rpc 与 in-process）的扩展列表注入
  `builtin:mcp → builtin:tool-search`（无条件，仅受掩码控制）；`builtin:codemode` 仍只在角色 `tools:`
  含 `codemode` 时才注入（#89 的既有规则，本次不变）。in-process 子会话在 `createAgentSession` 之后
  **绑定一次**扩展（`{ mode: "print", onError }`，扩展异常走 `console.warn` 而不是被静默吞掉），于是
  `session_start` 真的会触发。`tool-search` 不是可选项：非 `direct` 曝光的 MCP 工具只有在 `tool_search`
  已注册时才可声明。
  **退役回收**：`session_shutdown` 是 MCP 唯一的断开路径，而 `dispose()` 不 emit 它——in-process 子会话
  只走 `dispose()`，于是退役后 MCP server 会活到 root 退出。现在 `dispose()` 被包了一层：先补发一次
  `session_shutdown`（`reason: "quit"`，幂等、1000ms 上限），再执行真正的 dispose；`PI_LEGION_CHILD_MCP=0`
  时压根不 bind，也就不补发。
  **延迟与语义**：in-process 子会话退役现在是 `await dispose()`——含一次 `session_shutdown` emit，
  最坏多 1000ms（典型 <100ms）才 `emitSlotReleased`；而这次 emit 会让子会话跑完整的
  `shutdownRetireAll`（写 `node_retired{reason: "session-shutdown"}`、`print` 模式先 drain、并退役
  **它自己的**子节点，嵌套 centurion 时才存在）。与 rpc 子会话同形，不是新语义，但此前 in-process
  不会发生。
  **代价（实测）**：MCP 连接是每个子会话各开一份——5 个并发子会话 × 1 个 server = 18 个进程 / 1121 MB。
  本次不做连接预算 / 并发上限，只提供掩码开关 `PI_LEGION_CHILD_MCP=0`（`0`/`false`/`off`/`no`/`none`
  关闭；未设置即开启；不做 role card 名单，留 MR2b）。
  **后果显式披露**：MCP server 的 `annotations` 实测全为 `null`，所以不做 annotation 级防火墙——
  `acceptance.role: read-only` 的 scout **从此可以调用 MCP server 暴露的写能力**（bash 的只读分类不变，
  它只拦 bash）。不要把「只读」理解成对 MCP 也成立。
  另一半是身份守卫：in-process 子会话现在会收到 `session_start`，所以 legion 自己的 handler 加了守卫——
  只要持有注入的 `childContext`（含 `stripLegionIdentity` 那种有 dbPath 无 nodeId 的 utility 子会话）就跳过
  `initializeLegionRuntime`，boot 期那条 env attach 也一并跳过。否则父本身是 rpc child 时，这个 handler 会先用
  祖先的 `PI_LEGION_*` 身份 init（开祖先 db、起第二个 postman）。回收的是另一半：补发的 `session_shutdown`
  现在真的会到 legion 自己的 handler，所以三个 handler 都收紧成「只关自己的 handle」——`ownLegionKey` 为
  undefined 时（无身份的 utility 子会话、或首轮之前就退役的子会话）什么都不关，绝不碰进程共享 map 里别人
  的句柄。**净收益**：跑过至少一轮的 in-process 子会话在退役时终于会关掉**自己的** postman 与 db handle，
  这是 MR2 之前就存在的历史泄漏（以前 `dispose()` 既不 emit `session_shutdown`，也就没有任何回收点）。

### Fixed

- **in-process 子会话又能解析 `builtin:codemode`，`legion_mail` / `legion_tree` / `legion_phase` 也不再被
  `tools:` 白名单裁掉**（`docs/contracts/child-builtin-extensions-v1.md`）。子会话的 `DefaultResourceLoader`
  以前不传 `extensionFactories`，于是角色卡声明 `tools: [codemode]` 只换来一条 `Unknown built-in extension:
  builtin:codemode`——真机派一个 scout 自报，`codemode` 就这么消失了；现在 `codemode` / `tool-search` /
  `mcp` 三个宿主 replaceable builtin 只做**注册**，开关仍然是 `builtin:` 路径（MCP 路径由下一条 Added 引入）。
  另一半是同一批工具被白名单裁掉：`tools:` 对所有已注册工具生效，`legion_mail` / `legion_tree` /
  `legion_phase` 注册后被过滤，子 agent 中途只剩「收尾 verdict」一条上行通道；现在它们被无条件补进
  in-process 与 rpc 两条路的白名单（固定顺序、缺席才追加，两处逐字节一致并新增 parity 门禁）。
  未注册的名字在白名单里是惰性的，没有机器的子节点不会凭空多出 `legion_phase`。

### Docs

- **容器化验证配方落地（`test/docker/README.md`，`CONTRIBUTING.md`）**：改完插件代码不必重建镜像
  （`/plugin` 是只读挂载），顺序是 `make up && make smoke && make rpc`；`make run` 是交互 TUI。附两条
  非交互探针（子 agent 工具表 / 用 codemode 数 `ALL_TOOLS` 验证 MCP），以及今天真机基线
  （`make rpc` 11/11、scout 工具表 8 个、MCP 4 个工具、`PI_LEGION_CHILD_MCP=0` → 0 个）。
  真模型沙箱的 macOS 限制写清了（`--network=host` 与同路径挂载的两处假设）。
- 依赖 `/proc/self/fd` 的那条断言在非 Linux 上改为**显式 `t.skip`**，不再静默绿。

## [5.3.0] — 2026-11-06

一次「下游很久没动静时说一声」的发布。新增两个**只通知、不处置**的探测器：L1 抓「进程活着但僵住」，
L2 抓「跑满一整个角色预算还没结束，可能陷入循环」；父节点可以把提醒往后推（`extend`），但系统永不
自己 `abort` / `stop` / `retire` 任何子节点。另一条线是收尾：#301 删掉那批角色卡之后，仍然把用户
（和子节点）引向它们的几处模板、示例团队与 mock 脚本被清掉，并加了机械门禁。

### Added

- **子节点「很久没有动静」会主动通知父节点（`stall-notice v1`，`docs/contracts/stall-notice-v1.md`）。**
  L1 静默 = 不在任何工具里且 `120s` 没有任何事件（`subagents.legion.silenceNoticeMs`）；**栈非空时
  绝不报**——一个 10 分钟的 `npm run build` 与一个卡死的 `bash` 在父侧事件流里完全同形，所以「正在跑
  某个工具」只能作为证据出现在 L2 的文案里（「正在跑 `bash`，已 38 分钟」），不能判成卡死。
  L2 长跑 = 已运行超过角色预算（角色卡 `loopNoticeMs` → `timeoutMs` → `900s`；因此内置角色是
  scout 10 分钟 / centurion 30 分钟 / worker 45 分钟）。提醒写进父节点**自己的** inbox：父正卡在
  `wait` / `collect` 里时 250ms 内被打断，否则由它自己的父的邮差在 2s tick 里投递。
- **`subagent({ action: "extend", name, ms? })`**：把该子节点的 L2 基准前移到现在，下一次到期继续提醒。
  它**不延长 `collect` / `wait` 的预算、不重启子节点、也不延后 L1**——L1 量的是客观的静默，不该被续期
  抹掉。已终态的子节点会被拒绝（回执不会承诺一封永远不会到来的提醒）。
- **L2 阈值可以按角色卡单独声明**：新 frontmatter 字段 `loopNoticeMs`（`0` 关闭该提醒），也可用
  `subagents.agentOverrides.<name>.loopNoticeMs`。层解析先走 launch 的默认作用域（user），找不到再
  回落全部层，所以 `agentScope: "project" | "both"` 派发的项目层卡片也会被解析到——否则一个 45 分钟
  预算的项目角色会在 15 分钟处被提醒三次。
- 两个探测器都只产出字符串与一条 mail：不 `abort`、不 `stop`、不 `retire`，不新增事件类型、不改
  `nodes` schema、不改心跳与孤儿扫描判据。多子在同一 tick 到期会合并成一封，单个子节点最多 2 封（L1）/
  3 封（L2）。自投递的提醒不计入发送方的 `mailRatePer5Min` 配额。

### Changed

- 测试沙箱（`test/docker`）的 real-model 默认切到 `hy4std`，并把 `pi` 钉到 `1.5.0`。

### Fixed

- **#301 删了角色卡，却没删“会把用户带到那张卡”的几处**：
  `examples/subagents-child-context.md` / `subagents-parent-context.md` 仍在教子 agent
  用 `subagent({ agent: "advisor" })` 做失败止损（这两份模板会被复制成
  `<agentDir>/subagents-*-context.md`，再作为约定文件注入每个子节点的 prompt，所以
  删卡不等于断链）；`docs/subagents-teams.md` 的四个示例团队全部仍列着
  `advisor/planner/reviewer/designer/prototype`；`test/mock-llm/script-engine.ts` 的
  角色推断表也还留着这五个名字。三处一并清掉，坏掉的是“被推荐的止损通道本身”。
- 加机械门禁（`test/unit/agents.test.ts`「#301 guard」）：`agents/` 下多出一张卡、或
  `examples/`、`docs/subagents-teams.md`、`bench/` 里再出现指向已删角色的
  `agent: "<role>"`，测试直接红。此前同类回潮无人拦：`bench/perf-core/10-legion-frame-alloc.ts`
  在 `b02fb4a`（#364，晚于 #301）把五个已删角色又写回了 `ROLES`。
- `bench/` 只拦「派发」不拦「标签」：`ROLES` 是渲染夹具，改名会重画帧、作废
  `10-baseline.json` 的 digest（`docs/contracts/viz-frame-alloc-v1.md` §4.2 要求 digest
  变化即回退该步，不得为了改名重采基线），所以那五个名字作为标签留了下来，
  并在原处写明了理由。

## [5.2.0] — 2026-11-04

一次以「回复说真话」为中心的发布。批量派发的每个子节点可以带自己的 handle；`stop` 与超时的回复不再把
「已经跑完」「还在跑」说成相反的东西；`collect` 与 `stop` 撞车时不再丢最后一轮产物；文档里「`timeoutMs`
会终止子节点」的说法被容器实测推翻并改正。

### Added

- **`tasks[]` 的每个条目现在可以带自己的 `name`，而且这个 handle 一定生效。** 以前条目里的 `name` 被
  静默丢弃——schema 里没有这个字段、`launchStep` 也从不读它，于是调用方明明写了名字，批量出来的子节点仍被
  自动编号成 `scout-N`/`worker-N`，没有任何提示；现在条目名优先、其次顶层 `name=`、都没有才自动编号。名字不合
  语法、同一批内重名（含大小写/空格差异）、或单条目同时给了两个不同的名字，都在**任何子节点启动之前**整批拒绝，
  不会留下「一半按调用方的名字、一半按自动名」的半启动状态。`vexillatio` 自己为每一步分配唯一 handle，因此对
  条目里的 `name` 直接报错拒绝，而不是静默忽略。

### Fixed

- **`stop` 的回复现在带状态，不再把「已经跑完」说成「被停掉」。** 名字在子节点 retire 之后才到达时，回复是
  `No non-retired children to stop. worker-2 is already retired (execution: success, retired at …)`；命中
  settle→retire 那一小段窗口时，回复 `Retired 1 already-settled child: x (execution: success)` 而不是
  `Stopped 1 child`——后者等于宣称一次从未发生的打断。retire 行为本身不变，只有措辞。

- **超时不再被说成会终止子节点，`stop` 竞态也不再丢最后一轮产物。** 角色 `timeoutMs` 实际只是父侧等待预算：
  容器实测 `worker.timeoutMs=10s` 的 child 存活 56s 并正常 `success`，且 pi 1.4 的 CLI / settings 都没有 turn 级超时；
  文档与 renewal 契约据此改正，`collect deadline (cumulative since launch)` 改为 `(per collect attempt)`（原文案
  本来就是错的）。`finishCollect` 在「child 已被 retire」时仍写 `<name>.output.md`，不再因 `stop` 撞上 collect
  而丢掉那一轮文本。失败通知携带 `stopReason` / `errorMessage` / `errorKind`，当合成 reason 表达不了 provider
  错误时多打一行 `error:`；`wait` 超时回执的 `hint` 改为「只是停止等待，child 还在跑」，不再把 `stop` 摆在建议位。

## [5.1.0] — 2026-11-02

一次以**可恢复、可声明的子树**为中心的发布。三个新能力：`centurion` 的状态机改为由 root 派发时用 `phases:` 声明（不声明就是普通 agent）；同一个 session 重开能接回上次的树，退出等于暂停、恢复必须显式；长等待中的 `wait`/`collect` 会在收到子节点邮件时立刻返回。`/legion` 一侧：整帧分配降到 2.0MB 以内（120×40 −59%、200×60 −67%），overlay 改为主屏挂载，状态行能说清子节点正在做什么，且不再每写一格分配一个 `Cell`。另有三十余项稳定性修复：失败队不再静默消失、内联相位机器进树、headless 账本不再漏记、`ctx is stale` 与宿主 `turn_end` 的报错消失。

### Added

- **`legion_phase` gained the two arguments a centurion actually needed: `supersedes`
  and `reason`.** `implementing` had no legal exit for the most common way a squad settles — one child
  failed, the rest settled. `implementing → reviewing` demands `children_none_failed`, which only
  tolerates failures listed in `handledIds`; that set had exactly one producer, and its hard
  precondition was `reworkCount > 0`, which increments only on the two `rework: true` edges —
  `implementing` has none. `implementing → failed` demands `children_all_failed`, and
  `to: "failed"` was refused on the tool surface before the state machine ever ran. Meanwhile
  `terminalReason: "parent_decision"` was already unconditionally accepted by the state machine
  with zero producers in `src/`. Both gaps are now closed without touching the transition graph: a
  centurion may declare `to: "failed"` **with a reason** (a missing reason is refused, and `done`/`aborted`
  stay off-limits because they belong to the parent or supervisor), and may pass
  `supersedes: [<failed child>]` to name which failures a settled sibling has taken over — an
  extra source unioned into the existing `reworkCount > 0` / `updatedAt < phaseSince` derivation,
  never a replacement for it, with a `node_handled` audit event per handled id. A declared failure
  still has to be a declared exit: the tool only hands the state machine that terminal reason when
  the team's effective (normalized) machine offers a `failed` edge out of the current phase that
  this node may take, so a card that reserves `failed` to another actor — or declares the phase but
  omits the edge — keeps its veto, and the persisted reason is capped like `note`/`evidence`. A
  declared failure is a terminal verdict, so it now mails the parent like the other two failure
  paths do instead of leaving it to poll the ledger. The
  refusal text for the deadlock now names both of those calls instead of two actions that were
  unreachable in the current code. Contract: `docs/contracts/partial-failure-exit-v1.md` (#309).

- **`status` now says what a live child is doing and for how long — `working · bash 00:07:31` —
  and marks a single tool that has run unchanged for five minutes.** "The process is alive but has
  stopped progressing" was invisible everywhere: the strongest `liveness()` rule calls any child
  holding a non-terminal handle `live`, the heartbeat refreshes for exactly those children, and the
  orphan scan exempts a node whose first root child is still alive, so a child stuck inside one
  tool call looked identical to one doing useful work and the parent learned otherwise only when
  its 900s `collect` deadline fired. Both backends now record the one tool call a child is inside —
  tool name plus the host clock reading when its own `tool_execution_start` arrived — onto the child
  record, folded from the session event stream each backend already consumes (no new IPC, no
  polling, no new state machine). `subagent({ action: "status" })`, the `all: true` overview and
  `/legion status <name>` lead each block with that fact and, at or past
  `STALL_NOTICE_MS = 300_000`, append a marker naming how many whole minutes the call has been
  stuck and which lever can move it — `steer` cannot reach a child that is inside a tool call
  (#313), `abort` can (#314).
  **This is display only**: `liveness()` is untouched, no heartbeat or orphan-scan criterion moved,
  and nothing is ever auto-killed, aborted or retired — the marker names the levers, the parent
  still pulls them. A child with no in-flight tool renders exactly the pre-#315 block, byte for
  byte. The one behaviour change is that the read-only `scout` role now declares
  `toolTimeoutMs: 600000`, because `toolTimeoutMs` had no default and the SDK bash tool has no
  default timeout, so a single hung probe could pin a recon child for its whole turn budget and
  report nothing; `worker` and `centurion` deliberately keep no default, since killing a
  slow-but-progressing build or integration run costs more than the hang it would prevent. Contract and the frozen boundary:
  `docs/contracts/stall-visibility-v1.md` (#315).

- **`subagent({ action: "abort" })` stops a child's current turn without killing it.** The
  capability was already sitting in the supervisor (`LegionSupervisor.abort`, `RpcSupervisor`,
  `InProcessSupervisor`, `Orchestrator.abort`) with zero call sites and no action on the tool
  surface, so the only ways out of a stuck child were `stop` (tear the process down and throw the
  context away) and `steer` (a queue, so it cannot reach a child that is inside a tool call). The
  action now clears the child's queued steering/follow-up messages first — `clearQueued`,
  default `true`, because an abort that lands first lets the child immediately pick up the oldest
  queued instruction, the opposite of "stop that" — and then asks the child to stop the current
  turn. Context, transcript and session file survive, so the child can be continued afterwards.
  The call is bounded: one 5s limit covers the interrupt **and** the queue clear that has to land
  before it, so the worst case is about twice that bound — and the tool surface takes no bound of
  its own (`timeoutMs` stays a `wait`-only parameter; a clear that cannot answer counts as zero
  while the interrupt is still sent). A call that hits the bound answers `timeout` instead of
  hanging, and it never kills anything: `stop` (`force: true` for the hard variant) remains the
  path that takes the process down. Three honest receipts — `interrupted` (with the count of
  queued messages it dropped), `no-turn` (nothing was running; the queue is left alone) and
  `timeout` (the request went out, the child had not settled). Contract and the frozen three-state
  table: `docs/contracts/abort-soft-interrupt-v1.md` (#314).

### Changed

- **交付物是分支，MR 只是有 remote 时的便利。** 以前角色卡、注入给子节点的任务附录、验证后的提示语都写「开 MR/PR 并把 URL 写进 verdict」，
  在**零 remote** 的仓库里等于要求一个不可能的东西（实测一次真实会话：centurion 只能交一条待推分支，如实报 `no remote`）。
  现在统一的措辞是：**分支名 + HEAD sha 就是交付**；仓库有 remote 且 `gh`/`glab` 可用时再附 MR/PR 链接，缺失不算失败，**任何情况下不许编造 URL**。
  逐级合并权不变（仍由父节点合并，认分支/提交而非平台对象）。见 `docs/legion-v2-contract.md` REV-29。

- **长等待中收到子 agent 的邮件会立刻返回，而不是等这一轮结束 (#384).** `legion_mail → root` 走宿主的
  followUp，而宿主只在一轮「本来要停」时才取走它——于是根会话只要在 `subagent({action:"wait"})` 里，邮件就跟着
  一起排队（实测一封冻结契约的邮件等了 17.3 分钟）。现在 `wait`/`collect` 在调用者是 legion 节点时每 250ms 看
  一眼自己的收件箱：出现 `PENDING` 邮件就立即返回，正文就是那封邮件（`formatMail` 原文，多封按 id 升序、最多
  100 封）加一行状态说明（`wait`：`Still running: <name>, …`；`collect`：提示处理完再 collect 一次），
  `details.state = "mail"`。返回是**普通工具结果**而不是错误/中断，模型读完邮件继续干活。
  邮件只被取走一次：**发送前先在账本上认领**（§3.1 的 `delivered_at` 租约，postman 与抢占方用同一个条件更新，
  输的一方跳过自己的发送），以及**阻塞调用期间该节点的 postman 停手**（§1.1，邮件留在 PENDING 供抢占）；
  账本仍是 postman 同一套状态（`PENDING → ACCEPTED`，不新增事件、不改 schema）。子节点状态与进程完全不受影响（只返回，不 retire/abort）；Esc/父轮结束仍是原来的
  `interrupted (parent turn ended; children still running)`，谁先到谁赢。没有邮件时 `wait`/`collect` 的结果与今天
  逐字节一致。契约：`docs/contracts/wait-mail-preempt-v1.md`。

- **`/legion` 两个画布面板的帧内容器收成了一个 `GalaxyScratch` 单例 (#369).** 对维护者：`panels.ts`
  的 26 个模块级可变容器（braille 网格及其尺寸键、19 个 `galaxy*`、4 个 chart 容器）不再散在文件里、
  也不再各自在函数中途清零——闸门之后的第一条语句就是唯一入口 `begin()`，它一次性清空全部带长度/
  计数器的容器（`clear()`/`length = 0`/计数归零，不分配、身份跨帧保持）；七个按计数器寻址的索引数组
  只归零计数器，截断它们反而会分配（契约 §1.2），于是「这一帧此刻什么是干净的」只有一个答案。同时两个面板都加了不可重入闸门（嵌套渲染抛 `viz: <fn> is not reentrant`，以前这条
  约束只写在注释里）。用户无感知：可见输出逐字节不变，整帧分配不回退（bench 10 全绿）。
  契约：`docs/contracts/galaxy-scratch-v1.md`。

- **退出/恢复会话时不再打印 `Extension error (/plugin/index.ts): … ctx is stale` (#377).** 宿主在会话销毁后
  仍会派发 `turn_end` / `agent_settled`，扩展入口这时读 ctx 会抛。现在把这种"ctx 已作废"当成「没有 UI」处理
  （与状态栏一直以来的做法一致）：缓存清空、安静返回；其它异常照旧抛出。用户感知：每次退出会话少一行红色噪音。

- **没声明状态机的队伍「全员失败」时不再静默消失 (#372).** #371 之后，没声明 `phases` 的 centurion 出生时
  `nodes.phase` 为空，而「全队都失败」的兜底逻辑开头就写着「没有相位就没什么可判的」——于是这种队伍把 N 个
  worker 全派失败后，账本里没有失败、没有事件、父级什么也收不到，只能等 lead 自己写 verdict。判据改成
  「这是一支有子节点的队伍」：有相位时行为逐字不变（队伍自己的机器判 `failed` 并记 `phase_change`）；
  没有相位时直接写 `status → failed` 并记一条 `node_failed`（既有事件类型，闭集仍是 16 条），父级收到同样的
  通知，同一节点只通知一次。**取舍**：`status = failed` 让 `isTerminalNode` 为真，全队失败的队伍因此不再能被
  恢复——pre-#371 的 `phase → failed` 本来也是不可恢复的，两种写法现在给出同一个结论。**判决是硬的**：lead 那一轮
  仍会正常结束，收队 drain 不再把 `failed` 改写成 `settled`（以前会：账本里留下「`node_failed` 事件 + `settled` 行」
  的自相矛盾，队伍还会重新变成可恢复）。只有「全队失败」这类 supervisor 判决受保护，普通子节点的 drain 行为逐字不变。
  **已经结束的队伍一律不再判定**：`retired`（会话退出时的暂停）或已经结束（`settled`）的队伍，**不管有没有声明
  相位机器**，都不会被本路径判失败——相位原样保留、不发通知、父级也不会多收一条「Team failed」，因此仍可恢复
  （`legion-session-continuity-v1.md` §3）。root 行同样不受影响（它不是队伍；把 root 判失败会让寻址到 root
  的邮件全部退回）。

- **内联声明的相位机器现在也显示在 `/legion` 树里 (#372).** 面板取机器只有「按角色查角色卡」一条路，而 #371
  允许 root 在派发时内联声明 `phases`——这种队伍根本没有卡，配置得最明确的队伍反而看不见自己的相位。
  现在面板先按**节点**问一次（来源是 launch 写下的 `ChildRecord.phases`，跨进程、重开会话后都还在），查不到
  再退回按角色查卡，优先级与契约一致（内联 > 卡片 > 无）。查询按「**派发这个节点的那本 run**」定位，不是
  「谁先命中」——同一个 checkout 里每个 run 都有个 `root.team`，否则旧 run 的声明会画到今天的节点上；实在无法
  消歧时按本仓惯例当作「没有」而不是猜。只有队伍根节点会被问（其它角色不可能带声明），且每轮渲染每个队伍只问
  一次，所以渲染一整队 worker 不会变成每节点一次注册表读取。渲染形式与卡片声明完全相同：不新增列、不改布局；
  没声明的队伍依旧什么都不显示。

- **同一个 session 重开时会接回上次的树，并且只“提示”，不自动动任何子 agent (#374).** 以前每次启动都新建一份 run
  和一本 `legion.db`，上次被打断的队伍既看不见也接不回来。现在 run 记录自己这个 session 的 transcript 路径
  （`RunRecord.sessionFile`），同 session 再启动时复用它——同一个 runId、同一本账本、节点与相位原样还在
  （`legion_tree` 看得到），root 行是更新而不是重建。**恢复必须显式**：启动时只在 system prompt 里列出
  「上次退出时被打断的子 agent」并给用户一行提示，`spawn` 零次；用户同意后再 `subagent({action:"resume", name})`。
  **换一个 session 启动则什么都不做**：不扫描、不提示、不写任何旧文件。

- **退出 = 暂停，不再判负 (#374).** `session_shutdown` 收队时不再把相位推到 `aborted`（终态会被
  `CHILD_TERMINAL` 永久拒绝恢复），只把节点标成 `retired` 并记一条带 `reason: "session-shutdown"` 的
  `node_retired`（事件类型仍是 16 条）。相位、`phase_since`、`rework_count` 一律不动。其它收队原因
  （`stop`/`abort`/超预算/显式 retire）行为逐字不变。

- **`subagent resume` 能把声明过的相位机器一起带起来 (#374).** 声明式机器现在快照进 `ChildRecord.phases`，
  跨进程恢复时重新下发给子进程的 `PI_LEGION_PHASES`——否则复活的内联队伍会退回角色卡机器，
  自定义相位名全变 `invalid_phase`。

- **空 `legion-verify` 块不再被报告成"验证通过" (#371).** 契约里没有 ```legion-verify 块时仍然直通
  （§7.3 的只读队形状，行为不变），但工具返回、收队提示与后台收尾现在都说
  `by contract (0 commands)`；若声明的机器把 `verification_passed` 当收尾门，还会明说
  「门是被空契约满足的」。以前这三种输出都写着 `Verification passed`，父级无法分辨
  "跑过了" 和 "什么都没跑"。

- **`centurion` 的状态机改成 root 派发时声明 (#371).** 以前「角色叫 centurion」就等于强制走五阶段：
  哪怕只改一行文件也要走契约 → 派 worker → 派 reviewer → 跑 verify → squash MR。现在只有
  `subagent({ agent: "centurion", phases: [...] })` 显式声明了才走状态机（声明了 = 以前的行为一字不改，
  含 `done` 后注入的收队提示）；**没声明就是一次普通派发**——`nodes.phase` 为空、工具里没有
  `legion_phase`、也没有收队提示，干完自己的活交 verdict 即结束。小活请直接派 worker。`phases` 只能由
  root 声明、只能给 centurion，且必须能从 start 走到某个终态，否则在创建 worktree 之前就被拒。
  同时把「非 root 不得派 centurion」写进契约（`docs/legion-v2-contract.md` REV-27，子契约
  `docs/contracts/centurion-declared-phases-v1.md`），`agents/centurion.md` 的验收条目从 `required` 改为
  `optional`（它从来没有可跑的验证命令）。worktree/rpc 耦合、深度公式、组员不隔离均不变。

- **`/legion` 整帧分配降到 ≤2.0MB（−59% @120×40，−67% @200×60），且可见输出逐字节不变 (#364).** #362 已经修掉「每写一格分配一个 `Cell`」，这一轮清掉的是**每帧重建的
  脚手架**：星系像素缓冲/帧内 Map、行字符缓冲、图表 band 栈、`new Canvas(W,H)`，以及 `Math.hypot`、
  `{...cell, color}` 克隆、每帧 `text.trim()` 这类每格/每 run 的临时对象。现在这些都原地复用，
  role 色表由 `set()` 增量维护、调色板按 **(theme, 该帧 role 集合)** 缓存，`renderLegionView` 接受一个
  可选 canvas 让 `createLegionViewFactory` 跨帧复用（`new Canvas` 语义与成本对所有其它调用方不变；
  `chartWindow` 的 earliest 推导也一并去掉了 `filter`/`map`/`spread`，语义等价）。
  实测（同一脚本、200 节点、真 `Theme(dark)`、`--expose-gc`、单帧 `heapUsed` 差值 20 次中位）：
  整帧分配 **2586.9 → 1036–1053 KB**（120×40/live，−59%）、**3963.9 → 1309–1342 KB**（200×60/live，−67%）；
  时间仍在契约门禁内（median/p95 ≤4.0/≤7.0ms @120×40，≤7.0/≤10.0ms @200×60）。
  **可见输出零变化**：4 形状（120×40 / 200×60 / 80×24 / 46×60）× `toPlain`/`toLines(真 dark)` 的 sha256、
  以及逐格 `(ch, color, bold, inverse)` 的 sha256，都与改动前捕获的 golden 逐字节相同；新增的**内联 golden**
  补上了仓里原先没有的快照空档（旧用例都是"同代码渲染两次再比"，两侧同时漂移抓不住）。
  基准：`bench/perf-core/10-legion-frame-alloc.ts`（+ `10-baseline.json` digest golden）；
  契约：`docs/contracts/viz-frame-alloc-v1.md`。

- **`/legion` 从全屏 overlay 改成主屏挂载，整帧合成开销消失（120×40 4.39ms → 1.69ms，200×60 9.59ms → 3.39ms）(#347).**
  页面一直以 `overlay: true` + `width:"100%"` 打开，于是 pi-tui 对**每一行**都跑 `compositeTuiLine`
  （`extractSegments` + `sliceWithWidth` + `visibleWidth` 三次 `Intl.Segmenter` 字素扫描，行宽缓存按整行
  key 而实时帧永不重复）。`/legion` 是这条路径的最坏输入：非空格里 56%–68% 是 braille/box/块字形，
  没有一行纯 ASCII，非 ASCII 行单价是 ASCII 的 3.67×，实测占整帧 57%–70%。
  现在改成 `ctx.ui.custom(factory, { overlay: false })`（与经典 `--tree` 视图同一个挂载方式）：
  页面**替换** base 组件而不是叠在它上面，宿主的 overlay 合成层完全不参与，页面只付自己那一次
  `render()`。实测（真 `TuiMainScreen` + `FakeTerminal`，`written[]` 每帧清空，50 帧 × 3 轮）：
  页面帧 median 2.49 → **0.96**（80×24）、4.41 → **1.77**（120×40）、8.63 → **3.35ms**（200×60），
  p95 5.30/17.64/41.51 → **1.25/2.85/4.67ms**，每帧字节 −3.1% / −2.5% / −1.8%（视觉内容等价）。
  **用户可见行为不变**：`Esc`/`q` 仍然回到原来的会话视图（宿主把打开时换掉的 editor 挂回来）；
  页面继续按 `terminal.rows` 自己定高（非 overlay 的自定义组件是布局叶子，宿主不分配视口高度，
  与 `createTreeViewFactory` 同源）；`/legion` 内打开的详情浮层仍是 75% 浮层
  （`MODAL_MAX_WIDTH_RATIO` / 65% 高 / `resolveModalOverlayOptions()` 一个像素没动），resize 语义原样。
  `paintPageFloor` **保留且仍然必需**：主屏挂载后详情浮层依旧是 overlay，合成器依旧按行取 base 行尾的
  SGR 快照，实测去掉 floor 后两种挂载的 gutter 都退回终端默认背景（#308 黑带重现），
  所以它不是「保险」。不改宿主 `compositeTuiLine`、不改 pi-tui 节流常量。
  基准：`bench/perf-core/09-legion-mount.ts`；契约：`docs/contracts/legion-main-screen-mount-v1.md`。

- **`/legion` 不再每写一个格子就分配一个 `Cell`：`Canvas` 预建 W×H 个可变 cell，`set()` 原地改字段 (#362).**
  `set()` 原本是 `row[x] = { ch, color, ...style }`——一帧要写 4,583 次（120×40）/ 9,691 次（200×60），
  实测 52.4 B/次 与 128.0 B/次。现在格子在构造时一次性建好，写入只做 `cell.ch / color / bold / inverse`
  的显式字段赋值（无对象展开、默认 style 用共享常量），`sanitizeChar` 也按字符记忆化
  （`String.fromCodePoint` 对 Latin-1 以外的字形每次都新建字符串，图表/星图画 `█ ⣿ ─` 上万次）。
  同一脚本前后实测：每次 `set` 分配 **52.4 → 0.03 B**（120×40）/ **128.0 → 0.002 B**（200×60）；
  整帧分配 **2839.9 → 2551.8 KB**（120×40/live，−10%）、**4556.8 → 4018.2 KB**（200×60/live，−12%）；
  帧 median **4.53 → 3.87 ms**（120×40/live，−15%）、**6.95 → 5.73 ms**（200×60/live，−18%），
  p95 −12% / −13%（5 轮 × 50 帧前后交叉，各 1250 样本）。预填本身也顺带变小
  （269.3 → 190.0 KB / 616.1 → 472.4 KB，53–57 → 39–41 B/格）。
  **`/legion` 可见输出逐字节不变**：4 个场景（120×40 / 200×60 × live / settled）的 plain 与 ANSI
  摘要前后一致，`legion-viz` 快照用例原样绿。对外语义只有一条要说清：`get()` / `cells` 是**活视图**
  （下一次 `set()` 会改同一个对象），不是快照——两个既有读点都只读 `ch` 即弃。
  另：`drawChart` 的 `(from, to)` 直接交给 `computeStats`，一帧只调一次 `chartWindow`。
  整帧分配离 #346 的 ≤2.0MB 仍差 0.5–2.0MB：残项已逐项隔离（`drawGalaxy` ≈0.93–1.23MB、
  `toLines` ≈0.44–1.01MB、`drawChart` ≈0.38–0.62MB、`Canvas` 预填 0.19–0.47MB），
  见契约 §3.4 / §4 与 follow-up #364。

- **`/legion` 的 tok/s 图表一帧只分桶一次，且只算本帧真的要画的 series (#346).** `drawChart` 先给图体
  分桶、`computeStats` 又用**完全相同的参数**再分一遍，200 节点下一帧白烧 ≈1.2ms 与 ≈0.6MB 垃圾；
  同时 `RateSampler.buckets()` 会遍历**每一个曾经记录过**的 series（`series` 永无删除点），
  结束的 child 每帧照算。现在：`chartBuckets(data, count, window?)` 是唯一入口，结果以第三个参数
  传给 `computeStats(data, buckets, series?)`（不传时退回老签名，语义逐字节一致）；
  `buckets()` 接受 `BucketOptions.onlyNodeIds`，只遍历 `visibleRateNodeIds(data.nodes)`——settled 行
  只要还在画就照旧贡献，不在帧里的 series 保留原始采样但不参与本帧计算；同时不再为每个 series
  新建 `plotW` 长度的临时数组，并对「`changedAt` 早于首桶窗口左沿一个桶窗口」的 series 直接跳过
  （`interpolate` 两端夹取 ⇒ 每桶 Δ 恒为 0，可证明为同一结果）。
  `changedAt` 是 `record()` 里值真的变化时才更新的时间戳：上一版用的是**最后一个采样点**，而
  flat-run collapse 每帧都会把 settled 行的最后一个采样点推到 `now`，所以那条跳过在生产形状下
  一次都没触发（实测 200 series / 190 settled ⇒ walked 200, skipped 0）。图表的 `avg` 也跟同一份
  可见集走：不可见 series 不再把它抬起来（实测 40 个已结束 ghost 把 300 tok/s 抬到 1.5k）。
  实测（120×40 / 200 节点，真 `Theme(dark)`，50 帧 × 3 轮）：帧 median 6.5ms → 4.4ms（−32%）、
  p95 9.1ms → 4.8ms（−40%）、`drawChart` 2.65ms → 0.6ms（−77%）、`buckets()` 1.24ms → 0.47ms；
  帧分配 4214KB → 3306KB、`drawChart` 1432KB → 530KB。尾部 60s 窗口形状下 190 个 settled series
  现在真的被跳过（walked 200 → 10，`buckets()` 0.89ms → 0.10ms）；**整轮窗口下它们仍在窗内、
  必须照画**——「结束的 child 不再每帧收税」这句上一版契约的话是错的，已在契约 R2 如实改写。
  图表外观与 `/legion` 其余输出不变。契约：`docs/contracts/legion-chart-frame-buckets-v1.md`。

- **`finished` 完成结果缓存有了有界淘汰：每条 ≤8KB、合计 ≤1MB 驻留 output 文本，淘汰只丢文本、留结果 (#349).**
  这个 one-round 缓存原本为每个完成过的 child 留一份**输出全文**且永不淘汰——实测 50 child ×
  204,800B ⇒ GC 后驻留 10.07MB，长会话按 child 数单调增长。现在按 LRU：单条驻留 ≤8KB
  （`FINISHED_CACHE_MAX_ENTRY_BYTES`）、合计 ≤1MB（`FINISHED_CACHE_MAX_OUTPUT_BYTES`）、
  条目数 ≤128（=1MB/8KB，`FINISHED_CACHE_MAX_ENTRIES`），超出的条目剥成 4000 字符预览，
  但**条目本身与 `runId`/`round`/`execution`/`acceptance`/`outputFile` 全部保留**——删条目会把
  `collect`/`wait` 变成 `missing`（结果丢失）并抹掉本轮的 claim 键。命中时从
  `snapshot.outputFile` 重新读回全文，因此 `wait`/`collect` 在淘汰前后返回**同样的结果**
  （文本等价到 `output.trim()`）。缓存条目是**快照的浅拷贝**：淘汰只动缓存自己的那份，
  已经交给调用方（以及 `join.onTerminal` 读的同一个对象）的结果永远不会被事后改写；
  上一版存的是引用，插入时就把 >4MB 的输出原地剥成了 4000 字头（首次 `wait` 拿不到全文）。
  没有 `outputFile` 的条目（宿主自备 collect、写盘失败）是 **pinned**，按契约不淘汰，字节数由
  `noticeQueueStats().finished.pinnedBytes` 报出（新增 `finished` 计数块：`entries` /
  `residentBytes` / `stripped` / `pinnedBytes`）；盘上文件被删时降级为「4000 字符头 + 元数据 +
  `CollectSnapshot.outputTruncated: true`」，永远不是 `missing`。实测：50 child × 204,800B 驻留
  10.07MB → **0.51MB**（满足 #349 的 ≤1.0MB），重新 track 全部后回落到基线。
  契约：`docs/contracts/finished-cache-eviction-v1.md`。

- **A 500ms status refresh no longer re-parses a session file that has not been written since the
  last tick (#348).** `refreshUi()` → `statusEntries()` parsed every child's session file — plus every
  historical ledger row that carries one — once per tick, changed or not: one idle child cost 119
  opens per 60s, 50 children 6000. That count grows with the *length* of a session rather than with
  the number of live agents — the reason the issue suspected the 64-entry incremental-parse cap of
  thrashing every tick. `parseSessionFileCached` now sits in front of the parser: one `statSync`
  compares `(path, size, mtimeMs)` and an unchanged file is answered from the previous parse instead
  of opening it at all. A write from another process is still seen — an append grows `size`, a
  rewrite moves `mtimeMs` even at identical length — so no fs watcher and no bus subscription is
  involved, the one exception being a same-millisecond rewrite that keeps the byte length (see the
  function's doc: the parser's own head/boundary fingerprint would catch it, but only by opening the
  file, which is the fixed cost this gate exists to remove; it resolves on the next write). The
  display readers go through the gate (`progressFromSessionFile`, which every status row calls;
  `/legion summary`; `/legion timing`), while every path that has to *decide* something about a file
  keeps calling `parseSessionFile` on the file it is judging: verdict derivation (`orchestrator`,
  `rebuild`, `legion_*` tools) and the postman's DELIVERED evidence scan — that one moves a message
  to DELIVERED and can discard a notice as obsolete, and the frozen criterion names the real parse,
  so it is **deliberately kept** off the gate (it also only parses a seam whose mailbox page is
  non-empty, so a seam with nothing pending parses nothing). None of the parsing semantics moved.
  A file that cannot be *read* (`EACCES`/`EMFILE`/`EIO`) is never cached: `parseSessionFile` answers
  that the same way it answers an empty file, and a settled session file never moves
  `(size, mtimeMs)` again — `chmod` only bumps `ctime` — so caching that empty value would have
  pinned `/legion summary` and the status rows at zero for the rest of the process. Both caches are
  bounded: the file-level cache is capped at 256 entries, LRU-ordered on every hit, so the files a
  tick actually visits are the ones that stay; the incremental cap rises 64 → 256 as headroom for a
  child that appends on every tick, **not** as the source of this change's win (that cache's own
  `misses` counter read 0 throughout the windows below, so it was never the cost being paid).
  `sessionFileCacheStats()` (`hits`/`misses`/`size`/`statCalls`) exists for tests and is never
  rendered.

  Measured with the issue's own script (`b3.ts` harness, real 60s/20s windows): 1 idle child 119 → 0
  opens, 50 children 6000 → 0, 100 session files 4000 → 0, and the only syscall left per unchanged
  file is the `stat`. Two caveats on those zeros. First, they are window figures: the window starts
  after the seed parse, so the steady-state number is **one parse per session file per process**
  (plus one per write), not zero — a window that opens on the first tick does pay for it. Second, the
  CPU side of that table (0.34% → 0.10%, 3.64% → 0.31%, 16.20% → 0.63%, `process.cpuUsage()` over the
  same windows) was sampled on runs whose loadavg differed, so it shows direction, not an isolated
  cost. The microsecond figure is the gate's own micro-benchmark — open + fstat + two 256B fingerprint
  reads + close, 36–66µs warm, timed in isolation by the issue — and must not be subtracted from the
  logged per-parse cost: that log shows a whole parse at ≈1.19ms per parse in one run and ≈0.78ms per
  parse in the other, i.e. the per-parse figure itself moved between the two runs.

- **A control call no longer scans the run registry to find a child it is already scoped to, and the
  scan now keeps a snapshot when it does run (#344).** Every `collect` / `status` / `steer` / `abort` /
  `retire` / `continue` opened with `store.listRuns()` — `readdir` plus one `readFileSync` +
  `JSON.parse` per run — *before* it even asked which run it was scoped to, so a call that already
  knew its `runId` (the explicit argument, the session's legion run, or the run the runtime tracks
  the name under) paid for every run ever written: 26ms at the 352 runs on the reporting machine,
  97% of a warm `status`, 110ms at 1000 synthetic runs, linear and unbounded apart from the 14-day
  retention prune. The scan is now a FALLBACK: the scope run is read with one `readRun` (0.05ms) and
  the registry is consulted only when the name might live in another run — which is exactly the
  #312 case that must report or refuse instead of adopting. On this repo's 365-run corpus one name
  resolution went 18.4ms → 0.04ms, and on 1000 synthetic runs 31.5ms → 0.04ms, with **zero**
  `listRuns` calls for a scoped hit. The fallback scan itself is cached per runs directory: a
  process-wide snapshot (shared by every `RunStore` instance on that root, since the tool surface
  builds one per call) invalidated by the directory's `mtimeMs`, by any write this process performs
  (`createRun` / `updateRun` / `updateChild` — all funnel through `writeRun` — plus `prune`'s explicit invalidation), and, for a
  record another process rewrote in place with no directory mtime to show for it, by a 1s TTL that
  tests drive through the store's injectable clock. Cold scans are unchanged (21.2ms at 365 real
  runs, 34ms at 1000 synthetic on both sides of this change); a repeat scan is 0.018ms / 0.012ms.
  `listRuns()` still answers exactly what it did — every readable run, oldest first, corrupt entries
  skipped — and every #312 strict-scope case (`collect`/`continue`/`resume` refusing a same-named
  node elsewhere, ambiguity never resolved by preference) is pinned by a parity test that compares
  the shortcut against the full scan shape by shape.

- **A launch that cannot use a worktree no longer runs the nested-worktree `git` probe whose answer is
  then discarded (#345).** `isInsideChildWorktree(cwd)` — one synchronous `git rev-parse
  --git-common-dir`, ~5–7ms — was an *argument* to `resolveLaunchWorktree`, so it was evaluated before
  the resolver could short-circuit, and for every non-centurion its value was then thrown
  away: the worktree guard forces `worktree: false` for those roles whatever the probe said (all 18
  combinations of `roleDefault × launch × parentInWorktree`, now a table-driven test). The probe is
  asked on the centurion branch only — the one branch it can change — so a worker launch
  drops from 1 `git` subprocess to 0 and from 11.6ms to 2.9ms median on this repo, while a
  centurion launch still spawns the same two git commands (probe not reached: legion
  forces its worktree, `worktree add` still runs). `resolveLaunchWorktree`'s result semantics are
  untouched; the one observable difference is that a role card pinning `worktree: true` while the
  parent sits in a linked worktree now also gets the existing one-time `worktree denied for
  non-centurion role` warning, because the suppression that used to silence it is the
  answer being skipped.

- **`messages.delivered` is a five-value domain now — `pending / accepted / bounced / delivered / obsolete`
  — and `LEGION_DB_USER_VERSION` moves 1 → 2 (#322).** The old `INJECTED(1)` claimed a delivery the ledger
  never observed: it was written the moment a send call returned, which covers `queued` (waiting for the
  child's next turn boundary), `accepted` (a turn started) and `intercepted` (an input handler ate the text
  and the child never saw a word of it) alike, so a parent had no queryable signal to tell them apart.
  `ACCEPTED(1)` now says only "the send call returned", `DELIVERED(3)` is written later from evidence, and
  `intercepted` bounces instead of pretending. The migration adds **no DDL** — the column was already
  `INTEGER NOT NULL DEFAULT 0`, so v2 is a semantic agreement plus a version bump, and every v1 `1` reads as
  `accepted` with no backfill. `MAIL_DELIVERY.INJECTED` survives as a `@deprecated` alias of `ACCEPTED`
  so out-of-tree imports keep compiling; the ledger's own call sites use the new names, and exactly one
  unit test keeps the alias pinned (`INJECTED === ACCEPTED`) instead of letting it rot silently. Events are
  unchanged on purpose (the closed set stays at 16): `ACCEPTED` reuses the `mail_sent` row `sendMail`
  already wrote, `DELIVERED` reuses `mail_delivered`, `OBSOLETE` reuses `mail_bounced` with
  `reason: "obsolete_after_phase_change"`. A read-only `mailboxStats(db, nodeId)` exports the five counts;
  nothing renders it yet — D5 asks for the export and its unit test, not for a caller. Contract: `docs/contracts/mailbox-delivery-v1.md`,
  `docs/legion-v2-contract.md` §8.3.1/§8.5 (REV-23).

- **`SessionRuntime.consumeCollect*` now answers with a `ClaimedCollect`, not a bare snapshot
  (#320/#327).** The claim-once seam claims a terminal result as it hands the snapshot out, and
  the caller has to be able to hand that claim back when it bails — which requires knowing
  whether *this* call took it (`src/api.ts` re-exports `SessionRuntime`, so this is a public
  surface change, and it is a breaking one):
  ```ts
  const { snapshot } = await rt.consumeCollect("worker-0")!;   // was: const snapshot = await …
  ```
  `claimedNow` is `true` only for the call that took the round's claim; a caller that delivered
  the text to nobody rolls it back with `unclaimUndelivered(name, snapshot, claimedNow)`, and a
  call that did not take the claim leaves the real delivery's claim alone. **This breaks
  `zzjcool`/api consumers**: the bare-snapshot shape *did* ship — v4.0.0 and v5.0.1 both exported
  `consumeCollect(name): Promise<CollectSnapshot> | undefined`, and `src/api.ts` calls that surface
  "safe to depend on" — so the release that carries this change must be a **major**. The migration
  is the one line above; no compatibility shim is provided (no overload, no `snapshotOnly`
  switch), because a second shape would keep the claim/copy ambiguity alive for everyone. Contract
  revision: `docs/contracts/notice-claim-v1.md` (D2).

- **`AbortOutcome` now carries the bound the abort really applied (`timeoutMs`), and the timeout
  receipt reads it instead of a default of its own (#325).** `abortReceipt` used to format a
  `timeoutMs = DEFAULT_ABORT_TIMEOUT_MS` parameter that nothing ever passed — the tool surface
  deliberately takes no bound (it is a `wait`-only parameter) — so the receipt could only ever say
  "5s", even for a caller that armed a different limit on the supervisor. Both backends now report
  the normalized, timer-capped bound in the outcome for all three statuses, and the receipt names
  that number. The receipt text on the tool surface is byte-identical (no bound is ever passed
  there); the two private `race*Timeout` helpers the backends each carried are one shared
  `raceWithTimeout` (`src/supervisor/race-timeout.ts`) with the timer cleanup, loser-rejection
  swallow and timer-delay cap unchanged, and the in-process pre-abort queue clear now runs inside
  the child's own identity scope (`runAtAbsoluteDepth` + `runInChildContext`), like the interrupt
  it precedes. Contract revision: `docs/contracts/abort-soft-interrupt-v1.md` (D2/D7).

### Fixed

- **退出会话时不再出现 `Extension error (<boundary>): turn_end could not resolve the persisted
  assistant entry ID` (#383)。** 这是 pi 宿主在 `turn_end` 边界上的既有缺陷（`dispose()` 之后仍会收尾一个
  被 abort 的 turn，message 没落盘），扩展这边唯一能做的是**不去触发那个边界**：宿主只在
  `hasHandlers("turn_end")` 为真时才走这条路径。我们注册的 `turn_end` 只做一次 `bindUi`，而 `bindUi` 已经挂在
  `turn_start`/`agent_start`/`agent_end`/`agent_settled`/`input`/`tool_result` 上，于是直接不注册——宿主连报错
  分支都进不去，UI 行为不变。

- **没有事件总线时账本不再漏记事件 (#380)。** 四处写成 `eventBus?.emit(appendEvent(...))`：可选链在没有
  订阅者时会把 `appendEvent(...)` 的参数一起短路，于是 headless 宿主（不传 eventBus 的嵌入方）里相位迁移
  只改了 `nodes.phase`、账本里一条 `phase_change` 都没有，重开账本时历史与真实状态不一致。改成「先写账本、
  再通知订阅者」；交互模式行为不变。

- **PR #363 review follow-up: an internal notice can no longer be refused into silence, and a refused
  one is retried.** #353 made `sendMail` throw for a `U+0000`, which is right where the text is the
  model's own (`legion_mail`) and wrong at the three call sites that compose a notice from ledger
  facts, because all three run after the move they describe. `requestLegionPhase` writes
  `updateNode` + `phase_change` and only then calls `notifyParent`, so a `reason`/`note` carrying a
  NUL (model text, and the only place one can exist — a ledger column would have truncated it on
  write) turned an accepted transition — including a declaring centurion's failure notice, the #309
  promise — into a tool error while the team had already moved; `checkOwnPhaseTimeout` wrote its
  `phase_timeout` row (also the de-dup key) BEFORE mailing, and `LegionPostman.start()` swallows
  whatever escapes (`.catch(() => {})`), so a refused notice was lost for the whole stint. The
  refusal now belongs to the tool boundary alone: `legion_mail` answers `toolError(…,
  "MAIL_INVALID_TEXT")` so the code is visible in `details.error` instead of only in a message, while
  internal notices degrade — the NUL characters are dropped and the send retried, and a refusal the
  ledger understands (rate limit, permission) falls back to `sendRootMessage` + a warning — and never
  throw. `checkOwnPhaseTimeout` places the notice before writing the de-dup key, so a notice it could
  not place anywhere leaves the key unwritten and the next tick tries again; 0 keeps its meaning and
  the built-in subjects/clocks are untouched.

- **PR #363 review follow-up: a failed revival gives the phase clock back, and the completion gate's
  assumption is pinned.** `Orchestrator.reserveNode` moves `phase_since` on a revive (#357) and
  records the `revived` `phase_change` before the supervisor spawns; a spawn failure rolled the
  reservation back but left the moved clock behind — a stint `checkOwnPhaseTimeout` de-dupes on, for a
  launch that does not exist. `phase_since` now travels with the rest of the rollback. Also: the
  derivation of the success phase follows the ORDER A CARD DECLARES, so "`phases:` order is pipeline
  order" is a load-bearing assumption rather than a style note — a case now pins a shuffled
  declaration moving the gate, and its control pins that a non-final phase cannot collect a team.
  Contracts: `docs/legion-v2-contract.md` REV-26 and
  `docs/contracts/declarative-phase-machine-v5.md`.

- **`legion_mail` refuses text containing `U+0000` instead of storing a truncation (#353).** SQLite's
  TEXT binding stops at the first NUL, so a `body`/`subject` carrying one was written as the part
  before it while the send still answered `ok: true` — and `bodyBytes` counted the ORIGINAL text, so a
  message that arrived cut in half looked complete to its sender. There is no lossless encoding that
  keeps "the body" meaning the same thing to every reader, so the send is refused before any byte is
  counted: `sendMail` throws `MailInvalidTextError` (code `MAIL_INVALID_TEXT`, a member of the existing
  `code` vocabulary) naming the field, the character offset of the first NUL, and that NUL is not
  supported. `subject`, `body` and every `to` token are checked; nothing is stored and no `mail_sent`
  event is written. NUL-free text is untouched, and `bodyBytes` keeps describing exactly the row that
  was stored (the invariant the truncation broke).

- **A team woken by `continue` starts a new phase stint, so its next timeout is announced again
  (#357).** The `Phase timeout:` notice was already judged `OBSOLETE` at settle time (#333/#354); what
  made the team go permanently silent is that `Orchestrator.reserveNode`'s resume branch only rewrote
  `status`, leaving `phase_since` at the value of the stint that had ALREADY timed out. Since
  `checkOwnPhaseTimeout` dedupes on exactly that value (`hasPhaseTimeoutForSince`), one `phase_timeout`
  per stint meant one for the life of the team: the second stint could run past its advisory clock
  forever and nobody would hear. A revival now advances `phase_since` to the revival clock and records
  a `phase_change` with `from === to` and `reason: "revived"` — the phase does not move (work resumes
  where it was), the event set stays closed (no new type, no new subject prefix, no change to the
  `kind: "notice"` accounting), and a revival that cannot move the clock still dedupes, because the key
  is `phase_since` and not "a revival happened". Contract note:
  `docs/contracts/mailbox-delivery-v1.md` (D4).

- **A declared machine's own phase names now reach the verifying gate and the phase clock (#358).**
  The follow-up left by #350: `finalizeVerifiedTeamIfReady` hard-coded `node.phase !== "verifying"` and
  evaluated `verifying → done` with no `machine`, so a workflow the card called `spec → impl → ship`
  could never take the supervisor's verified-completion path (`invalid_phase`, dropped by the
  `!decision.allowed` guard). The completion gate is now the phase of THIS team's machine that judges
  success — an exit to `done`, preferring one gated on `verification_passed`, otherwise the last
  declared candidate, which is `verifying` in the built-in machine — and the machine is forwarded to
  `evaluatePhaseTransition`. A team with no declared machine (or a machine with no exit to `done` at all)
  keeps the historical literal, so the built-in four-phase pipeline is unchanged. The sibling hole is
  the same mistake in the clock: `checkOwnPhaseTimeout` resolved `DEFAULT_PHASE_TIMEOUTS[phase] ?? 0`,
  which for an undeclared phase name is 0, so `PhaseDefinition.timeoutMs` (`machineTimeout`) was dead
  code and a custom phase's advisory clock never armed. The order is now operator setting
  (`legion.phaseTimeouts`) → the machine's `timeoutMs` → the built-in default → 0, and 0 keeps its
  pre-existing meaning of "never warn". **Correction (PR #363 review, major 1):** that order was only
  real for phase names the built-in table had never heard of. `index.ts` handed the postman a
  default-FILLED `legion` object, so `settings.phaseTimeouts[phase] ?? machineTimeout(...)` always had
  a value on the left and a card's `timeoutMs` on `planning`/`implementing`/… was ignored in silence
  (probe: `implementing` 3600000 in settings, 300000 on the card → 3600000 won). The explicitness the
  settings parser already records (`legionExplicitFields`) is now carried through the run-time fill
  (`legionSettingsForRun`), so "operator wins" means "the operator wrote it down". Declaring
  `timeoutMs` on a built-in phase name now really takes effect; an explicit operator setting still
  beats the card, and with neither the four built-in numbers are unchanged. Contract: REV-26.

- **A team is now born in the phase its own machine starts in, so a card declaring `phases:` no longer
  strands its team at spawn (#350).** `Orchestrator.reserveNode` wrote a hard-coded `phase: "planning"`
  into every team row, ignoring the machine the card already carried. With a machine whose first phase
  is not `planning` (e.g. `recon -> build`) the team was born in a phase its own machine had never heard
  of, and `evaluatePhaseTransition` refuses every transition out of an unknown `from` as `invalid_phase`
  *before* the target, the outgoing edge or the `failed` escape hatch is consulted — so advancing,
  declaring failure (#309) and aborting were all closed, leaving a team that was alive and spending
  budget while it could not move. The derivation now lives in one function, `phaseStart(machine)`
  (`machine.start ?? machine.phases[0]?.id`), shared by the state machine's entry rule, the birth site
  and the load-time validation (`validatePhaseMachine` no longer keeps a third copy), so the three
  cannot drift; an empty machine falls back to the built-in start (it cannot be declared — the loader
  rejects it). A card that declares no machine keeps the literal `"planning"`, so the built-in
  four-phase pipeline is unchanged. Contract:
  `docs/contracts/declarative-phase-machine-v5.md:107` (that file is `Status: draft`). **Review
  follow-up:** making a declared start reachable also made every supervisor-side net that only speaks
  the built-in vocabulary reachable-and-inert. `failTeamIfAllChildrenFailed` (`legion-tools.ts`)
  evaluated `from: "recon" -> "failed"` for "every child failed" **without the team's own machine**, so
  the transition was `invalid_phase` and the `!decision.allowed` guard dropped the verdict in silence —
  a squad whose children had all died never reached `failed` and its parent never heard; it now forwards
  the machine, and a new case pins the verdict (`phase === "failed"`, one `phase_change`, one mail).
  The abort half of the same hole is #351, which landed upstream in `abortLegionPhase` (already on
  master), so this branch only had to stop duplicating it. The other two custom-phase holes — a hard-coded
  `phase !== "verifying"` completion gate and a phase clock that resolves to 0 for undeclared names —
  are documented in place and tracked as #358 rather than fixed here; this branch closes them (see the
  #358 entry above).

- **A `wait` whose result the abort net throws away now hands the completion claim back, so the child's
  finished notice is no longer lost (#352).** Waiting on an already-settled child goes through
  `waitAction`'s finished-cache probe, which claims the round (`claimedNow === true`) — and when the
  parent turn ends inside the wait's `retire` teardown, the tool layer replaces the rendered result with
  the frozen `interrupted (parent turn ended; children still running)` line and nothing was handed back:
  `deliverBatch` filters a claimed round, so that completion notice never reached the parent, silently
  and for the whole round. `waitAction` now carries the claims IT took out as `details.waitClaims` (only
  `claimedNow === true`; `waitOne`'s own `claimReported` is a no-op `false` on this path), and the bail
  gives each one back through `unclaimUndelivered` — never `unclaimReported`, which would also drop the
  queued copy, the only remaining route — exactly as `collectChild` already does on its own bails. The
  frozen `interrupted …` text, the `(runId, name, round)` claim key and `deliverBatch`'s single exit are
  untouched. Contract: `docs/contracts/notice-claim-v1.md` (bail-gate enumeration extended). **Review
  follow-up:** the probe answers ASYNCHRONOUSLY, and the first shape (`if (claims.length > 0)`) was a
  no-op in exactly the window #352 was opened for — `waitOne` can bail while the probe's `ensureCollect`
  is still in flight, and the claim then lands on an array nobody can reach. `details.waitClaims` is now
  mounted unconditionally (one probe = at most one claim), the probe's own promise travels as
  `details.waitClaimsPending`, and `releaseWaitClaims` awaits it before rolling back — so a claim that
  landed after the bail is still handed back and the round's notice arrives exactly once.

- **A `Phase timeout:` notice no longer outlives a team that ended in the very phase it timed out in
  (#354).** `isStalePhaseTimeoutNotice` asked `isTerminalNode`, which reads `status === "failed" ||
  phase ∈ {done,failed,aborted}`. A team that only investigated never calls `legion_phase`, so it keeps
  its birth `planning` phase and ends with `status: settled` / `retired` — neither predicate fired and
  `phase_since` never moved either, so an `action-needed` asking root to extend-or-abort a team whose
  work had already merged was delivered ~30 minutes late. The "has ended" arm now asks the new narrow
  `hasEnded` predicate (terminal **or** settled/retired); `isTerminalNode` is deliberately unchanged
  because mail bounce and the orphan scan share it. The `reason` stays `obsolete_after_phase_change`
  (event set still 16) and the "no `phase_timeout` event → stay ACCEPTED, never guess" clause stands.
  Contract: `docs/legion-v2-contract.md` §8.3.1, `docs/contracts/mailbox-delivery-v1.md` D4.

- **`retire()` / `retireAll()` / `/legion stop` can no longer leave a team in its custom phase "forever"
  (#351).** `Orchestrator.abortLegionPhase` evaluated the abort without the team's own phase machine, so a
  card-declared name (`build`) fell through to `DEFAULT_PHASE_MACHINE`, was refused `invalid_phase`, and
  that refusal was silently dropped (`if (!decision.allowed) return;`) — no `aborted`, no event, no log,
  even though the child process had already been killed. The abort now forwards the machine resolved from
  the node's role card, and when no machine can resolve the phase the retire is **forced** through:
  `phase` becomes `aborted` (a parent retire must always take effect — the safety bottom line in
  `phase-machine.ts`), one `phase_change` event carries `{ forced: true, reason:
  "parent_retire_unresolved_phase", denied }` (no new event type; the set stays at 16), and one
  `console.warn` names the node, the phase and the refusal.
  Contract: `docs/contracts/declarative-phase-machine-v5.md`.

- **`/legion doctor` stopped recommending the dead extension switch (#329).** `inheritExtensions: true`
  and `PI_LEGION_CHILD_INHERIT_EXTENSIONS=1` outlived #328's clean-up in `legion-doctor.ts`: `true` has been
  the default since #280 and both yield 0 extensions when host discovery fails, so every doctor fix and
  next step now names only `models.json` / `PI_LEGION_CHILD_EXTENSIONS=<path>`, with a case that pins it.
  The `?fresh=1` half of the #317 case re-evaluated the wrong module (ESM drops the query when resolving a
  relative import), so it now re-evaluates `extension-inheritance.ts` and asserts that a second instance
  reads the shared discovery holder.

- **The `/legion` track view now paints its own page background, so the detail modal no longer sits
  on a black vertical stripe (#308).** Opening a node's context viewer put a pure-black band between
  the frame's right edge and the terminal's right edge (the left side looked fine). The frame was not
  overflowing — `paintModalFrame` emits exactly the rect width every row. The base row was: the canvas
  pre-fills `W×H` spaces and `renderRow` only styles a run when it has a color *and* non-blank text, so
  a row ends in bare spaces with no SGR at all. pi-tui's compositor inherits the styling of the area
  *beside* an overlay from a one-shot snapshot of the active SGR at the first grapheme after the rect
  (`extractSegments`), and an empty snapshot means the terminal's default background. Every `/legion`
  row is now wrapped in `theme.bg?.(LEGION_PAGE_BG, line)` at the view's single render exit
  (`paintPageFloor` in `src/tui/viz/view.ts`), so the inherited state is the page floor. `theme.bg` is
  optional in `VizTheme` and the call is optional, so a theme without background tokens (every unit-test
  fake) still renders the exact bytes it did before, and the row width is unchanged (the wrap is
  zero-width escapes only). The token is `toolPendingBg` — the only one of the seven `ThemeBg` keys that
  is a neutral surface rather than a hued panel (blue / violet / yellow / green / red for the rest).
  **Not fixed in the `system` theme:** with no terminal color report that theme assigns `""` to all
  seven `ThemeBg` keys, so each renders as `\x1b[49m` (terminal default) and the band stays black —
  upstream exposes no renderable page-background token. The new regression test keeps ANSI (the #193
  `wipedRows` criterion strips escapes, which is why it never caught this) and compares the background
  SGR of both gutters with the base's own: no fix ⇒ every gutter snapshot is `""`. Contract:
  `docs/contracts/legion-page-floor-v1.md`.

- **The five-value mailbox delivery landed against an adversarial review: four majors and six minors
  (#338, follow-up to #322/#333).** The important ones were silent: mail addressed to **root** could never
  be confirmed — `nodes.session_file` was written only on the child path (`reserveNode`), so every
  `to: "parent"` letter, including the whole #333 `Phase timeout:` path, sat at `accepted` forever.
  `createRootLegion` now records this process's `ctx.sessionManager.getSessionFile()` on the root row at
  creation (and the contract says where that stops: a ledger rebuilt from `run.json` still has no root
  session file, so those letters honestly stay `accepted`). The `DELIVERED` criterion also dropped its
  "or the user turn equals the mail **body**" branch — a body carries no message id, so a task card, a
  different letter or a quoted paragraph matched it, and "that sentence appeared somewhere" is a mention,
  not a read. And the per-tick 20-message confirmation window now **rotates per seam** (`id > cursor`,
  wrapping at the tail) instead of re-reading the oldest 20: the old shape let 20 undecidable messages hold
  the window forever, which stops the confirm *and* obsolete paths permanently — a deadlock, not the delay
  the docs claimed. The `obsolete` rule no longer names a `kind: "instruction"` that never existed (only
  `kind: "notice"` is eligible), `mailboxStats` is documented as an export with no consumer instead of a
  wired status surface, each seam's session is parsed once per tick instead of once per message, and a
  delivery event is re-emitted by `messageId` rather than by scanning the newest 100 rows of that node+type
  (which went silent on a long-lived ledger). An intercepted send is not a steer, so it emits no
  `node_steered`; the observable signal is the `mail_bounced` with `reason:
  intercepted_by_input_handler`. No ledger event type was added — the closed set stays at 16.

- **A `Phase timeout:` notice that arrives after its phase ended is no longer handed to the parent as a
  live to-do item (#333).** A team that runs two or three review rounds reliably exceeds the 30-minute
  `reviewing` limit, so an `action-needed` phase-timeout notice is not an edge case: the notice was queued,
  the team went on to converge (next phase, failure, or retire), and *then* the notice reached root, asking
  for a decision about a node that no longer existed. Nothing ever revoked it — there was no state to revoke
  it into. Mail whose `kind` is `notice` and whose subject starts with `Phase timeout:` is now checked
  against the ledger fact that produced it (the `phase_timeout` event's `phase`/`phaseSince`, never the
  notice's prose) and marked `obsolete` when the sender has left that phase or gone terminal. The check runs
  in two places: **before delivery** (a queued notice is never injected at all — the path the issue actually
  took) and in the postman's confirmation pass for mail already `accepted` (that one only relabels; it
  cannot unqueue text a recipient already holds). Mail of any other kind — `question`/`report`/`handoff`, the domain has
  no `instruction` — is never auto-obsoleted: whether a question or a handed-over task went stale is a
  human call, and a `delivered` message is never relabelled, because a
  consumption that happened is a fact about the past. No new event type: the verdict is `mail_bounced` with
  `reason: "obsolete_after_phase_change"`.

- **The five `steer`-receipt residuals (#323).** The three honest dispositions from #313 are now
  wired through the edges that still flattened them. The in-process backend can never answer
  `queued` vs `accepted` — the SDK's `AgentSession.prompt()` returns `void` — so the supervisor seam
  gained an explicit capability (`capabilities.promptDisposition`: in-process `false`, rpc `true`,
  and the routing facade reports the intersection, `false`) instead of inventing a disposition that
  backend cannot observe; the v2 contract now states that `accepted` on in-process means only "the
  call did not throw". An intercepted mailbox `action-needed` steer no longer flips the node from
  `blocked` to `running`: #338 already makes that send `bounced` and returns before the unblock, and
  the orchestrator's own `clearBlocked` path now refuses it for the same reason — nothing landed, so
  the child is still waiting. `abandonTurn` keeps the same `retiring` guard `updateTurnState` has, so
  a concurrent rollback can no longer rewrite a retiring child as `idle`. And an intercepted *launch*
  prompt now fails with the new deterministic code `PROMPT_INTERCEPTED`, which `canFallbackStart`
  refuses — a swallowed prompt used to re-spawn one process per fallback model and roll each one back
  right away. The mailbox `prompt` branch keeps no disposition by construction; its comment and the
  contract now say why. Contract: `docs/legion-v2-contract.md` §3.1.

- **The in-flight tool fact behind `status` is a stack, so nested and parallel calls stop disappearing
  (#331).** `working · bash 00:07:31` used to read a single slot: `tool_execution_start` overwrote it
  and the matching `tool_execution_end` cleared it. Two shapes therefore made the line vanish while a
  tool was demonstrably still running. A nested call (`codemode` → `bash`) pushed the inner frame into
  the slot, so the inner end wiped the outer call — `status` showed nothing while `codemode` ran on. A
  parallel batch kept only the newest call, so when that one finished first the still-running sibling
  became invisible. Each `ChildRecord` now keeps a LIFO stack (`ChildActivity[]`): a start pushes, an
  end removes **only** the frame it names (by `toolCallId`), `agent_settled` empties it, and the line
  reads the top (innermost) frame for the tool name and the clock. When the stack is deeper than one,
  the line names the context instead of hiding it — ` (inside codemode ×2)` for nesting (from the
  event stream's own `parentToolCallId`) and ` (+N more)` for parallel siblings, with the weaker
  `(+N more)` chosen when parent ids cannot tell the two apart. An empty stack renders no line, exactly
  as before. Display only: `liveness()`, heartbeats, the orphan scan and every kill/abort/retire path
  are untouched. The seam gained an optional `inFlightToolStack` next to `inFlightTool`, so a doubled
  supervisor that only answers the single frame keeps working. Contract revision:
  `docs/contracts/stall-visibility-v1.md` (D1/D2/D4/D7).

- **One name, one node: `status` / `collect` / `stop` / `continue` now resolve a child name the same way.**
  In a single root session, `status(name)` and `collect(name)` called ten seconds apart answered with two
  different nodes for the same `worker-0`: `status` went through `pickChildByName`, which walks **every**
  run in the store and prefers a live record and then the newest `createdAt`, while `collect` acted on one
  run's direct children. Neither reported the disagreement, so a parent chasing its own **failed** child
  collected another run's **successful** one and believed the work was done; `continue` would then use the
  wrong node's model and outcome, and `stop` picked the same wrong record and answered
  `No non-retired children to stop.` — masking that the name was ambiguous at all. The four actions now go
  through one resolver (`src/runs/child-scope.ts`): the current run's **direct** children win and add no
  new output; a name that only exists elsewhere is reported with `runId` / `nodeId` / `state` for every
  candidate (`collect`/`stop`/`continue` refuse it and name both levers — `runId`, or the parent node's
  scope — instead of acting on it), `status` still shows it but leads with
  `resolved: <name> is not a direct child of this session — showing the record from run <runId>`, and two
  or more same-named candidates are an ambiguity every action refuses rather than guesses. `subagent`
  gained an optional `runId` to name the run a call is scoped to. The scope now travels all the way to the
  **execution point**, which is where the old resolution leaked back in: `stop` hands the run it resolved the
  name in to the retire step, which reads THAT record instead of re-resolving the name across runs — so the
  child it reports and the child it retires are the same one, and a live job carrying the name in another
  run is refused (with the same candidate list) instead of retired. `collect` only consumes the runtime
  snapshot whose `runId` matches the resolved node, the `status` block's `owner:` line is read from the
  resolved node's own run dir (another run's dead owner marker used to render `owner: dead (pid gone)` — and
  even `state=failed` — under this session's record), and the `resolved:` annotation is emitted only for a
  genuinely foreign (`elsewhere`) record, not for a #270 cross-store hit that is this session's own child. A
  session with no run of its own keeps reaching a foreign/restarted run's persisted record (#209-3), which is
  where `pickChildByName` was still the right answer (#312).

- **A bare JSON verdict on the last line is no longer reported as `no machine-readable verdict`.**
  `child-guard` injects “End with machine-readable JSON on its own” and `docs/design.md` says
  `attested` is “解析末尾 verdict JSON”, but `extractVerdict` only knew three JSON candidates:
  fenced blocks, `text.trim()`, and the span from the **first** `{` to the **last** `}`. One brace
  anywhere in the report — an API shape, a code fragment, `{ version, entries }` — turned that span
  into prose-plus-JSON, `JSON.parse` failed, and a perfectly valid verdict on the final line was
  thrown away, so the child was recorded `acceptance: unknown` while a sibling whose verdict was
  byte-identical but wrapped in a fence came back `accepted`. Two candidates are added after the
  existing ones and before giving up: the **last line** when it is itself a JSON object (what the
  injection asks for, and it survives trailing blank lines), and a **string/escape-aware brace
  balance scan backwards from the text's last `}`**, which reaches a verdict that spans lines or is
  followed by a short trailing note. The existing `\n\s+` collapsed-span compat candidate is kept,
  moved last because it rewrites the text. Parsing never throws and a report with no JSON still
  returns `null` (#311).

- **A provider that ends a turn with no content no longer costs a child its whole turn.** Some
  upstreams answer HTTP 200 and then terminate the stream in-band; pi maps that to
  `stopReason: "error"` with an empty assistant message (`finish_reason: error`, measured with
  `usage.input === 0` and 2/42 output tokens after 90–175s). Nothing retried it: the SDK's retryable
  classifier misses the message, the provider-level retry wrapper only covers thrown HTTP errors,
  and this package's only transient predicate matches `/connection error/i` — whose hold loop polls
  the session file and never re-prompts, so waiting could not help. `collect()` now recognises the
  *shape* (`isEmptyGeneration`: last turn has an assistant record, `stopReason: "error"`, blank
  text, zero tool calls — never `usage`, never the provider's message text) and, while the child is
  still alive and the parent has not aborted, sends it one `CONTINUE_PROMPT` on the same session and
  re-derives the outcome; the failure is tagged `Execution.errorKind =
  "provider-empty-generation"` either way, the parent-visible reason gains
  `(provider returned an empty generation; retried once)` when the retry also came back empty, and
  the ledger's `node_failed` event carries that `errorKind`. The retry budget is its own counter
  (`ChildRecord.providerRetriesUsed`, limit **1**), deliberately NOT the renewal budget — renewals
  are a user-granted allowance for "no measurable progress" that a plain failure never charges, and
  renewal re-runs a child while this continues the same live one. A continue-prompt that an input
  handler swallowed is nobody's retry: it is not charged to the budget, the original failure stands,
  and a warning names what happened — the retry also never classifies its own turn by looser rules
  than a first turn (a `Connection error` on the retry keeps the child `running` instead of retiring
  it). Assistant records also pass the
  upstream `responseId` through for forensics. Contract:
  `docs/contracts/provider-empty-generation-retry-v1.md` (#316).

- **A team can no longer deadlock in `implementing` after a partial failure, and two error codes
  stopped lying.** Covered by the `supersedes` / `reason` entry above; the code-hygiene half is
  separate: resuming a terminal legion child reported `BUDGET_EXCEEDED` although nothing about a
  budget was involved, so a parent could not tell "this child is finished" from "this child ran
  out of budget" — the new `ErrorCodes.CHILD_TERMINAL` says what happened, and `reviveChild`'s
  catch no longer rewrites every failure to `START_FAILED` (a `SubagentError` keeps its own code,
  anything else still gets `START_FAILED`). Codes travel only in `details.error`, never in the
  user-visible text, so no tool output gained a `BUDGET_EXCEEDED` string (#309).

- **Host extension discovery is no longer a silent failure, and `/legion doctor` can say whether
  inheritance is wired at all.** `ensureHostExtensions` kept its never-reject / R2-b backoff
  semantics but recorded a failure only as a `failedAt` timestamp: a host whose `pi list` breaks
  looked exactly like a host that ships no package extensions, because `discoveredHostExtensions()
  ?? []` collapses "could not ask" and "nothing installed" into one empty array. A failure now logs
  one `[pi-legion]`-prefixed warning carrying a bounded `pi list` stderr summary (the `failedAt` stamp doubles as
  the already-told bit, so a permanently broken probe warns at most once per process instead of once
  per warm call; with no stderr the reason falls back to the exit code, then to pi's own message,
  and the warning itself can never throw). `/legion doctor`'s
  Extensions section answers the question with
  `discovered host extensions: N (last probe: ok | failed <n>s ago | never)`, backed by the new
  read-only `hostExtensionDiscoveryState()` — doctor never probes on its own, so `never` is honest
  and the line costs nothing. The in-process spawn hint also stopped recommending levers that no
  longer do anything (`inheritExtensions: true` is the default policy since #280,
  `PI_LEGION_CHILD_INHERIT_EXTENSIONS=1` is a no-op, and neither brings back a host extension when
  discovery failed): it names `PI_LEGION_CHILD_EXTENSIONS=<path>` and a static `models.json`
  provider, and appends "inheritance is enabled but host discovery is failed/never probed — the
  child got 0 host extensions" when that is the actual situation — on every spawn-hint branch, so
  the rpc `--no-extensions` hint lost its own `inheritExtensions` clause too (it would have
  contradicted the note right below it). Contract revision:
  `docs/contracts/extension-inheritance-wiring-v1.md` §9 (#317).

- **A `collect` that bails after claiming no longer swallows that round's completion notice.**
  The claim-once seam claims a terminal result as it hands the snapshot to the tool call, and
  `collectChild` can still bail afterwards — the parent turn aborts, or persisting the child
  throws. Two things were wrong with the rollback. It deleted the claim unconditionally, so a
  bail on a `(runId, name, round)` a real delivery had already claimed erased the evidence and
  resurrected an already-read notice into the next flush; the seam now hands out *whether this
  call took the claim* with the snapshot (`consumeCollect*` returns `{ snapshot, claimedNow }`),
  and only that one comes back — per call, not per snapshot, because the watch and the tool call
  await the same `job.collectPromise` and a shared record lets the second call overwrite the
  first's answer. And it did not hand the notification route back: the seam sets
  `consumedByTool` before the claim, the default async path watches every child, so the watch
  passed its gate first (`!consumedByTool && !notified` → skip `onTerminal`) and was already
  parked in `retire` when the bail arrived — meaning the repair had to re-arm unconditionally,
  which it now does (clear the flag, `watch` again; the generation bump keeps the old watch from
  releasing the job, `notified` keeps the round single, `deliverBatch`'s claim filter is the
  last net). The old `!job.watching` guard is therefore dead code wherever it would have
  mattered: in the default shape somebody is always watching, and an `async: false` inline
  collect registers no watch at all, so the flag is never unset on the path that needs the
  re-arm. Measured in that production shape: 0 notices before, 1 after. The one case still
  not recovered is a bail that lands only after the watch has already released the child — there
  the result stays readable through a later `collect` and a copy already held in the run outbox
  still arrives, but a copy sitting in the join window goes with the release. Contract revision:
  `docs/contracts/notice-claim-v1.md` (D2, #320).

- **A `steer` receipt now reports what the child's session actually answered.** `steer` is a
  queue, not an interrupt: the text is enqueued and only consumed at the child's next turn
  boundary — after the current batch of tool calls finishes, before the next LLM call — so a
  child stuck inside one long-running command never receives it, and no amount of steering can
  break into that tool call. The receipt read "Steered <name>." whatever happened, because the
  disposition the child's session reports back (`handled` vs `queued`) was dropped on the way up
  through the supervisor seam — and `handled` never meant delivered: it is the SDK's
  interception signal, returned *before* the message is queued, so the child never sees it. The
  receipt now has three honest shapes: `queued` (it takes effect after the current tool batch
  finishes), `accepted` (the child was idle, so this call started a turn with it) and
  `intercepted` (an input handler took it — the child never saw it). Resuming or continuing a
  live child carries the same distinction, and the parent playbook plus the v2 contract now
  state the negative semantics — a tool call in flight is unreachable by `steer`; `stop`
  (`force: true` for the hard variant) is what actually interrupts. Because `intercepted` means
  "no run started", the turn it had claimed is rolled back: `waitSettled` answers at once with
  `prompt was intercepted before any run started` instead of timing out, the child does not stay
  `running` forever, and a launch prompt swallowed that way fails the spawn rather than handing
  back a child that was born busy. Legion mail sent to a busy child with `action-needed` now logs
  a warning when its steer was intercepted — `delivered=1` still records the send (D3), so the
  warning is the only signal that the child never saw the message.

- **A child's completion notice is delivered once, whichever route won.** A terminal
  result reaches the parent two ways — the tool result (`wait` / `collect`) and the
  pushed notice (`watch` → `join` → outbox) — and each kept its own memory
  (`consumedByTool` / `notified`), judged once when the watch hit terminal. The notice
  still had to cross the 10s join window and the run-scoped outbox, neither of which
  knew those flags existed, so four duplicate windows followed: a buffered entry
  flushed after a `wait` (W1), an outbox entry flushed on `agent_settled` after a
  `wait` (W2), a buffered entry orphaned by `release()` (W3), and the flags
  evaporating with the deleted job (W4).
  - Dedupe collapses onto **one claim per `(runId, name, round)`**. `round` is a
    per-name counter because `runId` is the *parent* run id — every round of a
    same-named child shares it, so a two-part key lets an unread old round win the
    flush and filter out the new round's real result. Three claim sites — `wait`
    (before its retire await), the `collect` seam, and a notice that actually went
    out — and one rollback: when a `collect` claims and then bails (the parent turn
    aborts, or persisting the child fails), the claim is handed back, because a
    notice for a result nobody saw must not stay suppressed. Delivery itself never
    unclaims.
  - `deliverBatch` is the single exit: claimed entries are filtered, survivors
    formatted (grouped headers and the `N of M` count recomputed at delivery time),
    then sent or held. The outbox now holds structure rather than formatted text, so a
    member claimed while a notice waits drops out of the body and the count alike.
  - Each round is one deliverable result, so releasing a child only ever drops the
    copy of the round the parent just read: an earlier round's unread notice still
    arrives.
  - Tool results are **never** suppressed: `wait` / `collect` always return the full
    text, only the passive notice is deduplicated. Claim state stays in memory by
    design — after a process restart the result is still recoverable via `collect`.
  - Contract and the four implementation-time revisions:
    `docs/contracts/notice-claim-v1.md`.

- **A timed-out or aborted verify command no longer leaves its grandchildren running.** Both
  command runners (`runVerifyCommand` for acceptance, `runLegionCommandNow` for `legion-verify`)
  killed only the direct child — `bash -lc` / `timeout` — so everything the command had forked
  was reparented to init and kept running: a `node --test` was still alive 44 minutes after its
  run with `ppid=1`. Both now spawn `detached: true` (own process group) and, on the timeout,
  output-cap and abort paths, run the new shared `sweepProcessTree()`
  (`src/shared/proc-sweep.ts`): group signal first, then every descendant enumerated from
  procfs (which covers a `setsid` escapee), then — for as long as the process group still holds a
  live member, the spawned root included — `SIGKILL` to the group and to every pid the grace left
  behind, waited for before the runner resolves. That "still a live member" clause is the point:
  a root that installs a `SIGTERM` handler and never forks used to survive the whole sweep while
  the timeout result reported no survivors. The runner's promise resolves only **after** that
  sweep, so a caller that sees a timeout knows the tree is gone; the price is up to
  `graceMs + killAfterMs` (2.5s) of extra latency on those paths, documented in
  `docs/contracts/proc-sweep-v1.md`. Two exits are therefore *not* timeouts: a **normal** exit is
  never swept (`cmd &` in a verification command is a legal way to leave a background process
  behind — leftovers are reported with one `[legion]` warning naming the command and the pids),
  and neither is a command that already exited while an unredirected `cmd &` kept its pipes open.
  `legion-verify` also stops reading its inner `timeout(1)` as a clean exit: `124` (or death by
  signal) is a timeout, and it is swept too. A sweep that still ends with survivors warns instead
  of staying silent. `/proc` absent (non-Linux) degrades to the process-group signal and never
  throws; `ESRCH`/`EPERM` are normal outcomes — but there the clean-exit leftover warning is dead
  code, because both of its sources are procfs. The `signal` parameter has no production caller
  yet (abort wiring is a todo). (#310)

## [5.0.1] — 2026-10-27

Patch release. **This is the release where 5.0.0's extension-inheritance policy
starts actually taking effect** — upgrading changes what a child loads, so read
the first entry before rolling it out to a fleet.

### Fixed

- **Host extensions are inherited again (#280).** 5.0.0 declared "children inherit
  every host extension by default" and documented the narrowing knobs, but the
  policy never reached the spawn path: `discoverHostExtensions()` had no callers,
  the sync getter it fed therefore returned `undefined`, and
  `inheritedExtensions` was always handed an empty host list. Children kept
  getting exactly the card's own `extensions` plus the child-guard — the
  `--no-extensions` behaviour #280 set out to remove, under a new description.

  Discovery is now warmed once per process before a child is spawned. The cache
  lives on `globalThis` under `Symbol.for` rather than in a module-level `let`,
  because pi re-evaluates an extension module with `moduleCache: false` for a
  child's `--extension` load: a module-level variable is invisible across those
  instances, so a child spawned from a re-loaded instance would have inherited
  nothing. The same escape hatch already backs `child-context.ts`,
  `inprocess-depth.ts` and `admission-queue.ts`.

  The warm-up sits in each backend's `spawnChild` (and in `RoutingSupervisor`,
  which sees both). It is deliberately not in `Orchestrator.launch`: that fast
  path may not gain an await before the synchronous admission block
  (`launch-admission-queue-v1` §13.7).

- **`PI_LEGION_CHILD_INHERIT_EXTENSIONS=0` works on the inherited half (#280).**
  `collectChildExtensions` accepted an `env` argument and then did not forward it
  to `inheritedExtensions`, so the operator kill-switch applied everywhere except
  the set it was meant to disable. Harmless while that set was always empty;
  wrong the moment it is not.

- **A manifest that names a directory no longer breaks rpc children (#280).**
  `pi.extensions: ["./extensions"]` (what `pi-diff-review` ships) resolved to the
  directory itself, and `pi -e <dir>` exits 1 with `Failed to load extension:
  Cannot find module` — so wiring inheritance up would have failed every rpc
  child of a session with that package installed. Declared entries now resolve the
  way pi's own loader does: a file as-is, a directory through its own
  `pi.extensions`, else its `index.ts` / `index.js`, else its `*.ts` / `*.js`
  files. An entry that expands to nothing is dropped instead of leaving an
  unloadable path.

- **`extensions/<name>/index.ts` is discovered (#280).** The first sweep collected
  only files directly inside a declared directory, so pi's documented
  subdirectory layout resolved to nothing and the package silently contributed
  zero extensions. The sweep now matches pi's `collectAutoExtensionEntries`:
  `.`-prefixed names and `node_modules` are skipped, `*.ts` / `*.js` files are
  collected, and a subdirectory is resolved as a package of its own (one level,
  as pi does).

- **A failing `pi list` is retried, and costs one probe per spawn (#280).** The
  old shape cached the failure as `[]` permanently, so one transient error
  disabled inheritance until the process restarted. Failures now stamp
  `failedAt` and short-circuit for `FAILURE_TTL_MS` (5 s), which keeps a
  three-point warm-up from probing twice on the same spawn while still retrying
  once the window passes.

- **A direct `RpcSupervisor` gets the same warm-up (#280).** `api.ts` documents
  `new Orchestrator({ supervisor: new RpcSupervisor(), … })`, which never touches
  `RoutingSupervisor`; warming only there left that path inheriting nothing.

### Notes

- **Cost now matches what 5.0.0 promised.** Inheriting everything includes
  pi-lens (a ~5.7 MB bundle that starts an LSP stack) on every child. In-process
  children share the host process, so this is host memory, not a new process.
  Add `excludeExtensions: [pi-lens]` to a card (or
  `PI_LEGION_CHILD_INHERIT_EXTENSIONS=0` globally) if a fleet does not need it —
  before this release those knobs were inert.
- **This package is never inherited into its own children.** In the source-tree
  layout `pi list` and the child-guard name different files for the same code, so
  dedupe could not collapse them and a child loaded two legion factories
  (`Tool "subagent" conflicts with …`). The guard is still appended
  unconditionally at the end.
- Doctor output and the README described the intended behaviour, which is now the
  actual behaviour; they were not rewritten for this release.

## [5.0.0] — 2026-10-26

Major because upgrading **can break an existing role card**: unknown frontmatter
is now a hard error, and `spawnMode` / `placement` are gone. A card carrying
either fails to load with a message naming the offending field. That is the point
— the previous behaviour was to silently ignore them, so a setting that looked
active did nothing.

**Before upgrading**, remove `spawnMode:` and `placement:` from every card under
`~/.pi/agent/agents/` and `.pi/agents/`. Nothing else about a card needs to
change.

### Breaking

- **`spawnMode` is gone from role cards (#290).** The backend is a property of
  the launch, not of a role: a launch that needs a worktree runs over rpc, and
  everything else runs in-process. Since only a `centurion` may hold a worktree
  (#214), a centurion is the only role that can reach rpc. There is no global
  default to configure because there is no longer a choice to make per role.
- **Unknown frontmatter is refused (#290).** A card with a field the runtime does
  not honour is rejected at load, listing the bad keys and the full legal set. The
  retiral of `placement` was previously "tolerated"; fourteen bundled and local
  cards still carried it while it did nothing.
- **Five bundled roles removed (#301).** `planner`, `reviewer`, `designer`,
  `prototype`, and `advisor` are gone; `centurion`, `worker`, and `scout` remain.
  They existed because the phase machine keyed its rules on role *names* — a role
  that merely existed carried workflow meaning. See the declarative machine below.
- **Children inherit every host extension by default (#280).** The old default was
  `--no-extensions` plus whatever a card named, which meant a role silently lost
  host capabilities (a provider extension, a guard) it never knew to name. Use
  `excludeExtensions: [pi-lens]` on a card, or
  `PI_LEGION_CHILD_INHERIT_EXTENSIONS=0` globally, to get the old isolation.
  `inheritExtensions: false` loads only the card's own list.

### Added

- **Declarative phase machine (#298).** A team declares its own phases on its
  lead's card:
  ```yaml
  phases:
    - id: recon
      next:
        - to: build
          require: [contract_file]
    - id: build
      next:
        - to: done
          require: [children_settled]
  ```
  Omitted means the built-in `planning → implementing → reviewing → verifying`.
  Conditions are a closed vocabulary (`contract_file`, `children_present`,
  `children_settled`, `children_none_failed`, `verdict_ok`, `verdict_not_ok`,
  `verification_passed`, `verification_failed`, `rework_available`,
  `children_all_failed`, `always`) and **none of them names a role**, which is
  what lets a team reshape its workflow without touching source.
  - Conditions live on the **edge**, not the phase: `planning → implementing`
    needs a contract while `planning → failed` must not, or a team could not fail
    before it had one.
  - `done` / `failed` / `aborted` are injected when a card omits them. A team that
    cannot be aborted is a safety hole. Reaching them is still gated: `failed`
    needs a terminal reason, `aborted` needs a parent retire, `done` stays
    supervisor-only. `aborted` is deliberately exempt from phase-level
    requirements — an emergency stop must not wait for "everything settled".
  - An invalid machine is rejected at load, reporting every problem at once
    (unknown condition, duplicate id, unknown target, self-edge, unreachable
    phase, terminal start).
- **The tree shows a team's machine (#302).** Selecting a team root unfolds its
  phases, the current one, and every transition with its conditions.
- **`legion_phase` refusals name the legal exits (#299).** A refused transition
  reports `legal next phases from 'recon': build, done, failed, aborted`. Measured:
  without it a model invented plausible-but-nonexistent transitions and burned a
  turn being refused.

### Fixed

- **In-process children enforce `toolBudget` / `turnBudget` (#295).** The parent
  computed budgets into `SpawnInput.env`, which an rpc child receives as its real
  environment — but an in-process child shares the *host's* `process.env`, so the
  guard read the parent's (absent) values. A card with `toolBudget: {maxToolCalls:
  3}` made 12 tool calls and finished normally. Budgets now travel in the
  async-local child context, the same channel already used for lineage identity,
  with `process.env` kept as the rpc fallback.
- **A malformed budget is an error, not "no limit" (#293).** `{not json}` parsed to
  `undefined` and `{"maxToolCalls": -3}` was accepted, so the guard would have
  blocked the first call. Both now fail at load naming the file, field, and value.
- **rpc is reserved for a centurion, and in-process keeps its ledger budget
  (#279).** In-process launches had been exempted from every legion budget
  (`Number.MAX_SAFE_INTEGER`), which made "run it in-process" a way to escape
  depth/spawn/ledger caps. Admission and reservation now share one code path, so a
  launch cannot be admitted and then rejected.
- **Runtime handles are keyed by (ledger path, node id) (#283, #285, #287).** Keyed
  by path alone, a second session sharing the ledger could close the parent's
  database; the identity is now adopted per node.
- **Extension inheritance discovery (#280).** `pi list` reports package
  *directories*, resolved the way pi's own loader does (`package.json`'s
  `pi.extensions`, else `index.ts` / `index.js`). Single-file `--extension`
  arguments and builtins cannot be discovered this way — name them explicitly.
- **One spelling for "unknown child" (#288).** The old message advised "pass the
  same cwd used for launch", which stopped being actionable once cross-store
  lookup landed.
- **Prompt surfaces match the code again (#303, #304).** The parent playbook told a
  centurion to "dispatch N centurions" — an instruction the runtime refuses
  (only the root may dispatch one). The roster also listed a centurion to
  itself. `worker` kept `subagent` in its tool list while its text said not to
  spawn, and the README described every child as an rpc process.

### Notes

- `toolBudget` / `turnBudget` remain **optional and unused by the bundled cards**.
  Time, depth, per-node child counts, active-node counts, and the memory floor are
  the intended bounds; a tool budget is a scalpel for one stubborn role, not a
  default.
- Child extension inheritance includes heavy extensions. pi-lens starts an LSP
  stack (~1 GB per child, #43); add `excludeExtensions: [pi-lens]` where a fleet
  does not need it.

## [4.0.0] — 2026-10-24

- **Renewal for a budget casualty (#270).** An agent whose turn budget (`timeoutMs`)
  runs out no longer just reports `failed`. When it measurably progressed and its
  role allows renewal, the completion notice ends with a ready-to-paste
  `subagent({ action: "continue", … })` plus the evidence (`progressed: 47 tool
  results, 12 assistant messages, 6 files changed`) and the remaining budget
  (`renewals: 1/2`). Renewal reuses the existing `continue` path, so the child
  resumes from its own session file with its context intact. Two dispatches in one
  day motivated this: one worker was cut off with nothing on disk, another finished
  its code but ran out during verification.
  - **Never automatic.** An auto-renewed stuck child would hold a concurrency slot
    indefinitely; the notice hands over the decision instead.
  - "Progressed" = ≥ 3 new `toolResult` rows or ≥ 1 changed file since the last
    baseline. `assistant` messages are shown but never count — a model looping on
    the same sentence grows that number without doing work.
  - New agent frontmatter: `renewable` (default **true**; a timed-out `scout` means
    the task was mis-scoped) and `maxRenewals` (default **2**; `0` disables, each
    renewal is a fresh full budget). Both are validated in the team-override path
    like every other numeric/boolean field.
  - `wait`/`collect` timeouts never propose a renewal: those return while the child
    is still alive. Only a real termination does, judged by `stopReason: "toolUse"`
    / missing assistant row (F29) / the host's `terminated` wording — a clean
    `stop` from an ordinary retry does not spend the budget.

- **Launch admission queue (#266).** A launch that exceeds a *concurrency* gate
  (`maxChildrenPerNode`, `maxActive`, ledger `max_children_per_node` /
  `max_active_nodes`) no longer fails with `BUDGET_EXCEEDED`. It is enqueued,
  the caller gets `▶ scout-7 (scout) supervisor=inprocess queued(3)` and treats
  the work as dispatched, and the child starts automatically when a slot frees.
  Previously a 12-step fan-out against `maxChildrenPerNode: 8` ran 8 children and
  reported 4 errors — and nothing ever retried them, because the parent was
  already inside `wait` and the freed slot had no subscriber.
  - New settings: `subagents.inprocess.maxQueuedLaunches` (default **32**) and
    `subagents.inprocess.launchQueueTimeoutMs` (default **900000**). Both are
    shared by the in-process and RPC paths — one scheduler, not two.
  - Depth, spawn-per-session, memory, name-collision and config errors are still
    refused synchronously, byte-identically to before: only gates that a slot
    release can satisfy are queueable. `maxChildrenPerNode: 0` is a hard refusal
    (0 means "no children", so waiting can never satisfy it).
  - A queued launch reserves nothing: no ledger row, no child run directory, no
    worktree, no session file. `timeout`/`overflow`/`stop` are reported by name;
    `stop` dequeues without ever spawning, and a parent-turn abort flushes the
    queue and says how many launches it dropped.
  - `subagent({action:"status"})` shows `state=queued`, `collect`/`wait` block
    until admission instead of reading the placeholder session path, and
    `async: false` reports `↳ <name> waited Ns in the launch queue`.
  - Two new process-only events (`launch_queued`, `launch_admitted`) and a
    `legion-queue: N queued` status pill.

## [4.0.0] — 2026-10-19

A major line — but not only the pi-only collapse. Relative to 3.1.0 this release
removes every non-`pi` agent kind and the archived Herdr backend behind it, along
with the settings and error codes that only its transport read. It also carries
everything else that landed on `master` while that removal was held back: a
launch admission queue that queues instead of refusing, one liveness verdict
shared by every display surface, a status panel built on pid / rss /
context-token data, and ten measured performance fixes.

### Breaking

- **Kinds collapse to `pi`.** `AGENT_KINDS` is now `["pi"]`; the
  `cursor` / `claude` / `codex` / `gemini` and other third-party CLI kinds are
  gone, and with them the `cursorModel` / `nativeModelFor` / `planKindStart`
  model translation and the "model dropped, runs on its own default" notice
  (a `pi` child expresses every model, so the case no longer exists). `kind` is
  still a legal frontmatter key, but `pi` is the only accepted value: a non-`pi`
  value is ignored — one note on stderr per role (deduplicated, because the
  catalog is re-read on several UI paths) naming the role and the original
  value — and the role launches as `kind: pi`. The same applies to
  `subagents.presets.<role>.kind` and `subagents.agentOverrides.<role>.kind`,
  the three places a role's `kind` can come from. No legacy prefix aliases.
- **Herdr backend removed.** `src/backends/legacy/` and `test/legacy/` are
  deleted, together with the deprecated `pi-legion/api` re-exports that only
  served them (`createHerdrClient`, `parseHerdrResponse`, `mapHerdrErrorCode`,
  `readPaneDiagnostic`, `createCommandRunner`, `resolveHerdrBin`, `HerdrClient`
  and their types). `pi-legion@0.16.x` stays the pin for the Herdr-era
  execution model; the `spawnMode: rpc` / `inprocess` backends are unaffected —
  those are two ways of running **Pi**, not third-party transports.
- **Dead `herdr.*` settings removed.** `subagents.herdr.*` is no longer parsed
  (a leftover block is silently ignored, as it has been ignored since 2.0.0),
  the seven `herdr` constants are gone from `DEFAULTS`, and
  `ErrorCodes.HERDR_UNAVAILABLE` / `ErrorCodes.PANE_BUSY` are removed.
  `RunRecord.herdr` and `StatusEntry.herdrStatus` stay: they carry live
  `{supervisor, node_id}` state, not backend selection.

### Added

- **Launch admission queue (#266).** A launch that exceeds a *concurrency* gate
  (`maxChildrenPerNode`, `maxActive`, ledger `max_children_per_node` /
  `max_active_nodes`) no longer fails with `BUDGET_EXCEEDED`. It is enqueued,
  the caller gets `▶ scout-7 (scout) supervisor=inprocess queued(3)` and treats
  the work as dispatched, and the child starts automatically when a slot frees.
  Previously a 12-step fan-out against `maxChildrenPerNode: 8` ran 8 children and
  reported 4 errors — and nothing ever retried them, because the parent was
  already inside `wait` and the freed slot had no subscriber.
  - New settings: `subagents.inprocess.maxQueuedLaunches` (default **32**) and
    `subagents.inprocess.launchQueueTimeoutMs` (default **900000**). Both are
    shared by the in-process and RPC paths — one scheduler, not two.
  - Depth, spawn-per-session, memory, name-collision and config errors are still
    refused synchronously, byte-identically to before: only gates that a slot
    release can satisfy are queueable. `maxChildrenPerNode: 0` is a hard refusal
    (0 means "no children", so waiting can never satisfy it).
  - A queued launch reserves nothing: no ledger row, no child run directory, no
    worktree, no session file. `timeout`/`overflow`/`stop` are reported by name;
    `stop` dequeues without ever spawning, and a parent-turn abort flushes the
    queue and says how many launches it dropped.
  - `subagent({action:"status"})` shows `state=queued`, `collect`/`wait` block
    until admission instead of reading the placeholder session path, and
    `async: false` reports `↳ <name> waited Ns in the launch queue`.
  - Two new process-only events (`launch_queued`, `launch_admitted`) and a
    `legion-queue: N queued` status pill.


- **One liveness verdict for every display surface (#liveness).** The list, the
  text view and the railway chart each decided "is this agent still working?"
  their own way, and the railway one compared two clocks that no single writer
  owned: `eventOverrides` vetoed an event against `node.updatedAt`, but the
  event row is stamped by this process's event bus while `updatedAt` is stamped
  by the child's heartbeat — and only `isAlive` children are heartbeaten, so a
  dead child's `updatedAt` freezes. The comparison ranked two clocks and the
  losing side was the truthful one: a finished node was repainted `running`,
  forever, because the frozen row never moved again. `src/extension/liveness.ts`
  replaces all three with one `liveness(facts)` in TOTAL ORDER — `live` /
  `dead` / `unknown` — with no clock, no fs and no timer of its own. Unknown or
  unrecognized states now render `unknown` instead of being guessed into
  `retired`, and `queued` is a first-class display state.
  - Contract: `docs/contracts/display-liveness-v1.md` (frozen first, then
    implemented; D1-a and D5-a record two amendments found during the work).

- **A status panel on the `/legion` board (#241, #245).** A fifth pane carries
  the `/legion status` table onto the full-screen viewer — name · role · state ·
  supervisor · ctx · rss · turns — graded down by absolute column count
  (72/52/36/20) so a narrow board keeps name · state instead of a column of
  stubs. A portrait layout gets a zero-area rect and Tab skips it rather than
  painting a fifth pane that cannot fit. Only an `rpc` child owns a process, so
  only it shows rss; an `inprocess` child shows `—` rather than a share of the
  host figure it does not own, because a fabricated number would get used.
  - `pid`, `spawnMode`, `contextTokens` and `rss` are optional on `VizNode` and
    projected conditionally: a missing mode renders `unknown`, never a guessed
    `rpc`. No new `legion.db` column and no schema-version bump — pid is
    host-scoped and never persisted, so a rebuild from a `ChildRecord` invents
    none.
  - Context tokens are absolute only. Session JSONL carries no context window,
    so no percentage is computed and none is displayed.
  - `/legion status` also stopped dropping `spawnMode` and now supplies `owner`.

- **`/legion stop --force` (#179).** The TUI slash command can now hard-retire a
  child, equivalent to the tool's `force: true`; `--force` / `-f` is listed in
  the doctor help and the README. This closes the "optional follow-up" that the
  docs had been carrying.

- **`vexillatio` accepts `tasks[]` on its own.** `task` was required, so a
  `{tasks: [...]}` call was rejected by the host's typebox pre-validation before
  Legion ever saw it, and callers had to send a dummy `task` and retry. It is
  optional now; a `tasks[]`-only launch is legal.

### Changed

- **WAL is now an enforced startup precondition (#236).** `openLegionDb` used to
  discard the value returned by `PRAGMA journal_mode = WAL`. That PRAGMA is a
  *query*: the returned mode is the ground truth, and SQLite is entitled to
  answer with the mode it settled on rather than to fail — which is how a
  connection ends up on a rollback journal while every reader of the code
  believes WAL is live. The ledger's durability reasoning (single-writer
  serialisation, readers that never block the writer, the shutdown checkpoint)
  rests entirely on WAL, so the observed mode is now captured and verified: a
  file database that does not report `wal` throws at startup, with the observed
  mode in the message, instead of surfacing later as data loss. `:memory:` is
  exempt deliberately, keyed on `PRAGMA database_list` reporting an empty
  `file` — not on a database name, and not by accident.
  - The M2-(g) concurrency acceptance now runs as `npm run test:wal-stress`:
    60 supervisor processes against one ledger, 9004 attempts, 9004 commits, 0
    busy, p50 1.03 ms / p95 1.99 ms / p99 4.92 ms.

- **The worker role's turn budget is 45 minutes, not 30.** The worker does the
  heaviest per-dispatch work — several files, its own verification run, and a
  report — yet it shared centurion's budget while scout gets 10 minutes and
  reviewer 15. Two dispatches in this repository were cut off mid-work, one
  with nothing on disk and one that ran out while verifying. 45 rather than 60
  keeps a genuinely stuck child from holding a concurrency slot for an hour.
  Only `timeoutMs` changed.

### Fixed

- **A poison event row no longer freezes the cross-process event poller
  (#233).** `node_abandoned` was missing from the event-type closed set, so a
  snapshot row of that type could not be decoded; the 250 ms poller then threw
  on the same row forever, its cursor never advanced, and no later event was
  ever delivered. The closed set now contains `node_abandoned` (15 types), and
  the poller advances past a single poison row instead of freezing: the row is
  reported once through `onError`, the cursor steps over it, and the remaining
  events in that batch are still delivered.

- **A finished supervisor's pid is no longer read as its successor's (#250).**
  `rss` probes re-read `/proc/<pid>` after the child had exited, and Linux
  reuses pids; the panel could attribute a stranger's memory to a retired node.
  The probe now closes the race it was silently losing.

- **The log view stays inside its rect on narrow panes (#251).** `drawLog` wrote
  past its own `maxX` when the pane was squeezed, which corrupted the frame
  beside it.

- **The live overlay no longer scans the whole tree per token (#261).** A
  per-token `getTreeNodes()` call made a long child turn quadratic in the number
  of nodes; the scan is gone and re-opening the node that is already open is
  guarded.

- **Repository subdirectories are no longer mistaken for child worktrees
  (#237 P10).** The probe treated any git-visible path below the repo root as an
  existing worktree, so a dispatch from `src/` could reuse the wrong directory.
  All git probes are now bounded: `GIT_PROBE_TIMEOUT_MS = 5_000` and
  `GIT_WORKTREE_TIMEOUT_MS = 120_000`, so a hung `git` can no longer wedge a
  launch forever.

- **`SubagentError` is exported explicitly again.** It had reached
  `pi-legion/api` only as a side effect of the legacy client re-exporting it, so
  removing the Herdr backend silently dropped it from the public surface. It is
  a deliberate export now, pinned by a test.

### Performance

Ten fixes measured against the baseline in `docs/archive/performance-2026-10-19.md`,
plus the harness that measured them (#239). Numbers below are the before/after
from each fix's own commit.

- **`collect()` no longer waits out a fixed settle-quiet window (#232).** An
  already-settled turn cost a flat ~2.5 s of dead time; that wait is dropped when
  the turn is settled (2509 ms → 503 ms).
- **The settle polls back off instead of re-parsing every 500 ms (#232).** The
  transient-connection wait re-parsed the whole session file on every tick. It
  now keeps the last parse, re-parses only when the artifact size moved, and
  backs off 500 ms → 4 s. On an unchanged file in a 900 s window: 1800
  iterations / 1804 parses → 228 iterations / 5 parses. The blip tolerance is
  unchanged — sleeps are clamped to the remaining budget and the loop still ends
  exactly on the deadline.
- **The `/legion` log view reads the session incrementally (#234).** It seeks
  past the cached byte offset and projects only the new JSONL lines, instead of
  re-parsing from the top on every refresh.
- **`attachUsageTotals` is one batched query (#235/#248).** It accounted for
  ~72% of the cost of a UI snapshot; it is now a chunked `IN` query instead of a
  per-node round trip.
- **Heartbeats are one transaction (#236 P1).** N children meant N commits;
  eight children now cost one (3.83 ms → 0.99 ms, 3.9×).
- **Prepared statements are cached per connection (#236 P2).** `getNode` ×400
  drops 15.7 ms → 4.8 ms.
- **Session parsing projects its result instead of `structuredClone` (#237 P7).**
- **The DB event source seeds its cursor at attach instead of replaying the log
  (#238).** Attaching used to block ~1027 ms on replay.
- **Widget events are coalesced into one snapshot and one paint per tick
  (#238).** `legion-tools` emits N `mail_sent` events in one synchronous loop, so
  every burst cost 2N scans; a burst now costs a constant 2 snapshots — 2575 ms
  → 4.4 ms for 1000 events over a 120-node ledger. `applyTreeEvent` itself still
  runs synchronously, per event, in arrival order: it is an incremental state
  machine, not a render, so deferring or reordering it would change the state it
  computes.
- **The messages rate-limit `COUNT` is covered by an index (#237 P9).** 50k rows
  go from a `SCAN` to ~6.6 µs.

## [3.1.0] — 2026-10-19

### Added

- **The arbitrated launch backend is now visible (#209).** In-process has been
  the default since #197, but the backend a launch actually resolved to only
  ever appeared as a substring of one result line, so a user could not tell
  `inprocess` from `rpc`. Three surfaces now name it, always from
  `Handle.spawnMode` (the arbitration result) and never re-derived:
  - `subagent` and `vexillatio` results carry `details.spawns[]` /
    `handles[].spawnMode`, and a shared `renderResult`
    (`src/extension/spawn-render.ts`) prepends `spawn: scout-0=inprocess` to the
    tool card. The line lives in `details`, not `content`, so it stays out of
    the LLM context.
  - The `/legion` node modal footer appends `spawn <mode>` through
    `TrackedJobInput` → `TreeNodeSnapshot` → `LiveOverlayNode` → `metaPlain()`.
    No `legion.db` column and no schema-version bump; the value is threaded from
    the live job.
  - An unknown or legacy mode is **omitted**, never guessed as `rpc`.

  `pi` does not render a tool result's `details` on its own — `renderResult` is
  its only consumer — so the field alone would have been invisible. The
  renderer is hardened accordingly: a hostile `details` (throwing getter) is
  treated as a missing fact instead of throwing into the host's silent
  fallback, and `\r` / binary control bytes are normalized before the collapsed
  line cap is counted, matching the host fallback's own sanitization.

### Changed

- **Parent-facing guidance no longer calls every child an "RPC child".** The
  playbook, the collect/retire notices and the async tail now say "child" and
  describe in-process as the default, naming the rpc backend only where it is
  genuinely meant. The internal settle reasons, the auto-doctor classifier
  regex and the frozen interrupted head line are unchanged. The
  `--no-extensions` guidance is backend-neutral again: in-process children do
  not inherit host extensions either.

- **The railway lane only shows "last activity" once it is worth a word (#231).**
  A lane used to end with `· 1s ago` on every running agent — the tallest,
  least informative field in the label, and it crowded out the role/clocks
  that actually distinguish lanes. Ages under a minute are now dropped
  entirely; from 60s up the field reads `1m ago` / `2h ago` / `3d ago` as
  before, and a missing timestamp still shows `—`. `formatActivityAgo`
  returns `""` for the dropped case, so the field simply disappears from the
  detail candidates instead of leaving a dangling separator.

  Contract: `docs/spawn-mode-visibility-v1.md` (D1–D8, with the round-1 errata).

## [3.0.3] — 2026-10-19

### Changed

- **`spawnChild` returns as soon as the child accepts the prompt, not when its
  first turn finishes (#227/#228).** The in-process backend used to await the
  whole first agent run, so for 8–18 minutes the launch produced no job: the
  status board showed a single ledger row with no token rate, and the parent
  turn was blocked for the duration. Acceptance is defined in the child
  transcript (a user line past the spawn-time size, `turns.length > 0`);
  `isLastTurnComplete` is deliberately not required, because an accepted prompt
  legitimately has no assistant line yet. The prompt promise is drained in the
  background inside the same ALS child scope, so depth/identity semantics are
  unchanged. A 15 s start bound is not an error — the handle is returned anyway
  and `onSpawnDelayed` fires once. See `docs/inprocess-supervisor.md`.
- **`worktree: true` is centurion-only (#214).** Members stay in-process; only a
  centurion gets an OS worktree for the squad it leads. Roles that declared
  `worktree: true` on a leaf no longer pay the clone/bootstrap cost, and the
  isolation they still need is the centurion's. See REV-17.

### Fixed

- **A first prompt rejected before acceptance no longer produces a ghost
  child (#227 D1a / #230).** The non-blocking spawn above had a regression: when
  the SDK threw before `appendMessage` (no model, no API key, mid-compaction)
  the spawn still returned a handle, which disabled the `fallbackModels` chain —
  `Orchestrator.launch` only retries the next model when `spawnChild` throws. A
  reject **before** acceptance now throws `SubagentError(START_FAILED)` and takes
  the existing rollback path; a reject **after** acceptance keeps the handle and
  reports `SettleResult.reason = "child turn failed: …"`.
- **An interrupted `vexillatio` keeps the work it already collected (#227/#229).**
  The frozen head line stays first and verbatim, then the collected segments (in
  handle order) and any `✗ <agent>: <error>` launch failures follow, with
  `details.stillRunning` telling you what is still live. A reason-less abort is
  now named (`ABORT_WITHOUT_REASON`) instead of surfacing as bare engine text,
  and `Orchestrator.collect` no longer stamps a deadline on a child whose last
  turn already finished.
- **Foreign children are judged by their run-directory owner (#209-3 / #215).**
  `status` reported a long-dead child as `working` and `stop` could not reach it,
  because both consulted only the in-memory liveness registry, which is empty by
  construction for a run this process never spawned. Both now resolve the owner
  from the run directory.
- **The rendered `supervisor=` is the arbitrated backend (#209-2 / #216).**
  `supervisor=rpc` was a literal in three render paths, so an in-process child
  was labeled `rpc`. `RunRecord.herdr.supervisor` widens to `SpawnMode`, handles
  carry `spawnMode`, and legacy runs with no such field render `unknown`.
- **Extensions that register providers work in the default backend
  (#209-1 / #213).** The in-process session factory loaded additional extension
  paths into `DefaultResourceLoader` but resolved models through a bare
  `ModelRuntime.create()`, so non-builtin providers were unreachable. Registered
  providers are now drained into the model runtime and their catalog refresh is
  awaited before `resolveCliModel()` reads the synchronous snapshot.
- **`legion-doctor` no longer implies RPC-only remedies for in-process
  children (#212 / #222).** In-process spawns got a false-lead
  `PI_LEGION_CHILD_EXTENSIONS` recommendation and RPC CLI-probe issues
  (`CHILD_NO_MODELS` / `CHILD_FEWER_MODELS`); model gaps now point at
  `models.json`, role extensions, or `inheritExtensions`.
- **An `orphan detected` notice now carries its detection time.** The notice is
  queued through the outbox and can be delivered tens of minutes later; it used
  to look identical to a fresh scan, so the same dead node was triaged repeatedly.
  It now leads with `detected at <ISO>`. `staleMs` is intentionally unchanged —
  it is the value at scan time, matching the persisted `orphan_detected` event.
- **`tok/s` is a decode rate again, and in-process children show it while they
  run.** Two independent causes, both fixed:
  - `generationMs` (the denominator) was derived from the nested
    `message.timestamp`, which marks when generation *started*. It captured only
    prompt→first-token latency — a real 1506s session accumulated 616ms — so the
    `MIN_RATE_GENERATION_MS` floor always tripped and `tok/s` silently fell back
    to a 60s wall-clock window that counted tool wait as generation, and the tree
    row's `avg t/s` (gated on `generationMs >= 1000`) never rendered at all. It
    now sums the measured call length (`message.durationMs`) or, when absent,
    entry-to-entry write times. Nested timestamps stay a last resort for
    synthetic sessions, paired so the two clock axes are never mixed.
  - The railway header showed `0 tok/s` for an in-process child's entire
    lifetime while `rpc` looked correct: `spawnChild` awaits the whole first run,
    so no tracked job exists and the status board only had the ledger node row —
    which has no `generationMs` and, because `pollUsage` skips non-`running`
    nodes, no `tokens_out` until settle either. `statusEntryFromNode` now parses
    `node.sessionFile` directly and falls back to the ledger.
- A live agent stopped by a tool call longer than the 60s window still decays to
  `0 tok/s`. That is the honest answer for the trailing window and is now pinned
  by tests instead of being "fixed" into a stale number later.
- **Completion notices no longer wait for the user's next message.** A child
  finishing while the parent agent run was still active was sent as a
  `followUp`, and the host only drains that queue inside a live run: the notice
  sat invisible until the next prompt. Notices are now held by the extension and
  flushed as one burst on `agent_settled` (hard cap `MAX_PENDING_AGE_MS`, 80 s,
  after which they are force-sent). The join window no longer extends itself on a
  busy parent — that turn-level signal was the wrong predictor and doubled the
  delay.
- **No more phantom `working` rows.** `awaiting`/re-armed states repaint
  immediately and `agent_settled` repaints once, so the widget board never holds
  a stale row past a state change.

### Known limits (deliberately out of scope)

- **Blocked prompts and root notices are still sent as bare `followUp`.**
  `notifyBlocked` (`index.ts`, the blocked-approval prompt) and `notice()`
  (`index.ts`, the root-level advisory) bypass the run-scoped outbox, so while
  the parent run is active they sit in the host queue exactly like the
  completion notices used to. Only completions are covered by this fix; the
  same treatment for those two paths is a follow-up, not part of this change.

## [3.0.2] — 2026-10-18

### Changed

- **Reverted the pnpm migration (#162): npm is the reference path again, and
  the repository no longer enforces any package manager (#210).** Both previous
  attempts to force contributors onto pnpm broke npm consumers: 3.0.0 shipped a
  `preinstall` guard that failed every consumer install, and 3.0.1 replaced it
  with `devEngines.packageManager` (`onFail: "error"`), which npm enforces for
  *every* non-global command in the checkout. The practical effect was that
  `npm run`, `npm pack`, `npm exec`, `npx` (and therefore MCP servers launched
  with `npx`) all failed with `EBADDEVENGINES` inside the repo, and
  `pi install git:<repo>` failed too, because that path is `git clone` +
  `npm install --omit=dev --legacy-peer-deps`.
- `package.json`: dropped `devEngines` (it makes npm reject the whole checkout),
  `packageManager` (corepack then refuses to run npm at all) and `engines.pnpm`.
  `engines.node` stays `>=22`.
- `scripts.test:all` and `scripts.prepublishOnly` compose via `node --run`
  instead of `pnpm run`, so `npm run` and `pnpm run` both work and no script
  names a package manager binary. (`node --run` does not execute pre/post hooks;
  there are none in this manifest.)
- Lockfile: `pnpm-lock.yaml` is replaced by `package-lock.json`, and
  `pnpm-lock.yaml` / `yarn.lock` are gitignored so two lockfiles cannot drift
  apart again. `src/runs/provision.ts` still detects all four lockfiles, so
  contributors who prefer pnpm can keep using it locally.
- CI and release install with `npm ci` (no `pnpm/action-setup`, no `cache:
  pnpm`), and the release workflow packs with `npm pack` again — the
  `pnpm pack` → scratch-directory workaround for `devEngines` is gone.
- `test/unit/publish-manifest.test.ts` now forbids `devEngines` and
  `packageManager` in the manifest and asserts the scripts stay package-manager
  neutral. `release.yml` fails the tag build if either field comes back.

## [3.0.1] — 2026-10-18

### Fixed

- **Published manifest no longer ships a `preinstall` hook.** 3.0.0 added a
  pnpm-only `preinstall` guard meant for repository contributors, and npm always
  packs `package.json`, so the hook shipped to every consumer. Pi installs
  extensions with `npm install <spec> --prefix <agentDir>/npm --legacy-peer-deps`,
  so `pi update --extensions` failed with
  `Use pnpm to install dependencies (see CONTRIBUTING.md).` — npm exited 1 and
  rolled the previously installed version back, which left the
  "Package Updates Available" notice pointing at the same outdated version on
  every start. The pnpm-only intent now lives in `devEngines.packageManager`,
  which npm enforces for the repository root (`EBADDEVENGINES`) and ignores when
  the package is installed as a dependency. The repository keeps all of its
  contributor tooling declarations: `packageManager`, `engines.pnpm` and
  CONTRIBUTING.md are unchanged. (Note: `pnpm pack` omits `packageManager` from
  the tarball, which only affects that dev-only field in the published manifest —
  npm consumers install and load the extension normally.)
- `test/unit/publish-manifest.test.ts` guards the published manifest against
  install-phase scripts (`preinstall` / `install` / `postinstall`) and asserts the
  pnpm requirement stays declared, so this cannot ship again silently.
- `release.yml` now fails the tag build when a published install-phase script was
  reintroduced, before anything is staged.

## [3.0.0] — 2026-10-18

### Added

- In-process `AgentSession` spawn mode (#197): `spawnMode: "rpc" | "inprocess"`,
  `InProcessSupervisor` + `RoutingSupervisor`, and separate
  `subagents.inprocess.*` limit keys. See `docs/inprocess-supervisor.md`.

### Changed

- **BREAKING (#197):** `spawnMode` now defaults to `inprocess`, not `rpc`.
  When the key is omitted and the resolved spawn needs an OS worktree
  (`worktree: true` — the writer/centurion default), Legion falls back to
  `rpc` automatically. Non-`pi` roles are unaffected by this fallback: they
  are refused with `INVALID_PARAMS` before the backend is chosen, because
  only `kind: pi` children are supported at all. An explicit
  `spawnMode: "inprocess"` combined with `worktree: true` is still refused
  with `INVALID_PARAMS` — the fallback only covers the implicit default.
- **BREAKING (#197):** omitting the whole `subagents.inprocess` block no
  longer means "unlimited". The in-process supervisor now falls back to the
  `legion.*` defaults (`maxDepth: 4`, `maxChildrenPerNode: 8`,
  `maxActive: 30`); an explicit block that omits `maxActive` still gets 8.
  `maxSpawnsPerSession` / `waitTimeoutMs` keep no default.
- #197 in-process children read their identity (node id, db path, acceptance
  role, nesting budget) from an AsyncLocalStorage child context instead of
  `PI_SUBAGENT_*` / `PI_LEGION_*` env. In-process sessions share the parent's
  `process.env`, so the env channel delivered the parent's values — or none at
  all in a root parent — and mis-scoped read-only role enforcement. ALS does
  not cross `spawn()`, so `bash` subprocesses can no longer inherit a tree
  identity.
- TUI: drop the footer `N agents running` segment (#192); the aboveEditor
  widget already shows the same count. `STATUS_FOOTER_KEY` / `formatFooterStatus`
  remain exported but `@deprecated` (soft-land).
- Railway lane clock: the leading clock is now "time since the last task
  started" — it keeps ticking through the quiet gap after a turn settles
  (previously it froze at that turn's end, i.e. the *previous* task's elapsed)
  and freezes only when the agent itself ends.
- Railway lane clocks show from round 1. #159 gated them behind `turns >= 2`,
  but a child is usually dispatched with a single user message, so that gate
  hid the clocks almost always and starved the detail column.
- Round 1 prints one clock, not two: that turn starts with the agent, so
  `16s / 17s` was one fact plus the spawn gap.
- Railway column is content-driven: the right-hand name/detail block takes what
  the labels need and the time axis absorbs the rest (floor
  `RAIL_AXIS_MIN_COLS`), so a row fills the line instead of trailing blanks.

### Fixed

- Dropped the `now` / `live` wording from every tok/s surface. "now" meant two
  different things at once (the live-only header rate vs. the chart's x-axis
  right edge), which read as a bug; the stat row key is now `rate`.
- Rail lane detail drops a field for *every* lane when it fits none, instead of
  stripping the role from one long-named row only.
- `make rebuild` rebuilds the sandbox image and swaps the container.
- Real-model sandbox: children get `PI_LEGION_CHILD_EXTENSIONS` so they load
  the provider package (#43) — without it every subagent failed with
  `Unknown provider "any-endpoint"`.
- Subagent detail modal: the area around the frame is no longer black. It was
  mounted as a full-screen overlay, and pi-tui composites an overlay by
  discarding every base cell in its rectangle (there is no transparency option),
  so the viewer's own dim-mask spaces were erasing the host chat / `/legion`
  view and leaving the terminal's default background. The overlay now covers the
  frame rect only, so the host paints everything around it (#193).
  - Geometry is a percentage width with no `maxHeight`, so pi-tui re-derives the
    rect every frame; absolute cells froze at the open-time terminal size and
    clipped the frame's bottom border and Esc hint after a resize.
  - "Click the mask to dismiss" is gone — clicks outside the frame now reach the
    host, as they should. Esc and the title-bar Esc hint still close the modal.

## [2.0.4] — 2026-10-15

### Added

- `/legion timing [--json] [<name>]`: subagent wall / generation / other timing table
  (reuses session summary parsers; live wall marked `+`; footer span vs sum_wall)
  (#148 / #150).
- `/legion` independent **timing** panel (4th pane): wide right-top / stacked bottom /
  portrait between chart↔log; fields align CLI timing; Tab / ↑↓ / Enter / `o` →
  context float (#151 / #152).
- TUI context viewer is a floating modal (dim mask, title **主**/**子**); Esc / mask
  closes without retire or stop (#147 / #149).

### Fixed

- `subagent({ action: "status" })` without `name` returns a live-children overview
  (consistent with wait/stop `all` and slash `/legion status`) (#145 / #146).
- Chart `tok/s · by role` x-domain freezes while idle: `to` advances only on
  substantive `tokensOut` / `generationMs` samples (not wall-clock / flat-collapse)
  (#153 / #154).

## [2.0.3] — 2026-10-15

### Fixed

- `maxChildrenPerNode` only counts **live/running** children; `retire` (including
  Already-retired no-op) frees the budget slot so a full tree can launch again
  after retire. Session keep for resume does **not** occupy the concurrent slot
  (#142 / #143).
- Header tok/s uses `MIN_RATE_GENERATION_MS=1000` (same floor as tree rows): when
  the in-window generation delta is under 1s, fall back to wall-clock so tiny
  `dGen` cannot explode rates into the millions (#140 / #141).

## [2.0.2] — 2026-10-16

### Fixed

- Child worktree launches are suppressed when the parent checkout is itself a
  linked git worktree (`git-dir` ≠ `git-common-dir`): role defaults and unset
  launch flags collapse to `worktree: false`, matching the centurion-child
  precedent. Explicit `launch: true` / per-child `step` flags still win.
- `worktreeBootstrap: "npm-install"` no longer fires `npm install` on a stray
  `package.json` without a lockfile (observed: Java/Maven repos carrying
  package.json for docs/tooling); without a lockfile the mode records the
  marker and skips, so non-npm worktrees launch instead of failing after the
  10-minute bootstrap budget.

### Fixed in 2.0.1 (inherited from prior entries)

- Railway / `/legion` header "now" tok/s is 0 when no agent is running; only live nodes count toward now (chart buckets still use the full trailing window) (#136).
- Narrow/stacked `/legion` header truncates long run + selection badges without overwriting `⚔ /legion`; galaxy legend reserves room for failed/retired glyphs before roles (#125).
- Galaxy legend `statusBudget` counts grapheme cells (not `String.length`); selection badge min width unified for portrait + landscape (#128).
- Dispatched children now receive `--provider` pinned from the parent's model
  registry, so a bare model id (`workbuddy/…`) that also exists under a static
  auth-less provider in `models.json` can no longer hijack the child start
  (`No API key found for …`) (#123).
- Scout-guard now counts first-class `grep` / `find` / `ls` tool calls as reads (#87).
- Doctor diagnose help no longer repeats itself; storage section shows hygiene sweep state (#86).
- Bundled roles no longer advertise unloaded `lens_*` tools (#75).
- Non-interactive `pi --print` waits for async children before cascade retire (#77).
- Roles load `builtin:codemode`; doctor diagnose shows a dedicated section (#89 / #90 → #93).
- Doctor role-tool→extension gates are data-driven / extensible (#97 / #99).
- Launch honors `name=` so `/legion status <name>` matches the railway label (#101 / #104).
- Galaxy legend shows failed/retired glyphs only when those states are present (#102 / #103).
- Live child status leads with `alive · quiet Ns`; long quiet emphasizes living over a stale execution snapshot (#81 / #92 / #105).
- npm `package.json` description/keywords aligned with Legion 2.x RPC (no Herdr panes) (#106 / #111).

### Added

- `/legion status` human-readable summary; doctor slash list covers team / agents / on|off / summary (#76).
- README documents scout-guard settings and `/scout-guard` / `/no-scout-guard` (#74 / #71).
- Scout-guard mock-llm e2e: notify ×1, cooldown, and dispatch clear (#108 / #113).

### Changed

- Esc no longer retires children; only `/legion stop` or session exit retires (esc-no-retire-v3, #134).
- Status strip shows a persistent `/legion stop` hint while children are live (railway + tree; width may truncate) (#134).
- Prefer `PI_LEGION_EXTRA_AGENT_DIRS` over legacy `PI_HERDR_SUBAGENTS_*` (alias; new name wins if both set) (#109 / #114).
- CONTRIBUTING/CI docs aligned with 2.x RPC; verify-12/13 paths point at `test/legacy/docker/` (#95 / #100, #107 / #112).
- README: remove duplicate Child extensions heading (#94 / #98).
- `design.md` historical banner; landed F38–F46 marked ✅ / Historical (#80 / #83 → #91).
- CI PR job runs `test:integration` (#79 / #88).

## [2.0.0] - 2026-10-14

First **Pi Legion** line on headless Pi RPC. Relative to the final Herdr-era
**0.16.x** packages, this is a breaking transport and packaging change.

### Breaking

- **RPC-only transport:** children run as headless `pi --mode rpc` processes
  under `LegionSupervisor`. Herdr pane execution is archived under
  `src/backends/legacy/` and is **not** a v2 runtime option.
- **Kinds:** only `kind: pi` is supported. Migrate non-Pi roles or stay on
  `pi-legion@0.16.x`.
- **Shared tree ledger:** squad state lives in SQLite WAL `legion.db` (phases,
  mail, resume), not pane-centric session bookkeeping alone.
- Bundled agent playbooks aligned with local RPC practice (#66).

### Added

- Recursive centurion trees, four-phase
  planning / implementing / reviewing / verifying machine, `legion_mail`,
  three-layer `/legion` UI (resident tree, full view, live overlay), railway
  strip, tok/s / galaxy / log panels.
- Scout-guard: remind the main session after a streak of read-class tools (#64).
- Storage hygiene sweep on startup: prune idle runs, orphan temp dirs, abandoned
  nodes, event retention, WAL checkpoint (#37 / #38 / #40 → #47).
- `/legion doctor` (+ diagnose) self-check; auto-doctor snippets on gated spawn
  failures (#52).
- Child memory gate (`NODE_OPTIONS` V8 flags, pre-spawn gate) and tree-wide
  verify concurrency limit (#50).
- Children default to `--no-extensions` with explicit/role escape hatches (#43 / #48).
- User stop controls for async children (`/legion stop`, idle Esc, `x` in view) (#41).
- Mock LLM server for offline pi / legion smoke (`test/mock-llm`, #54 / #56).
- GitHub Actions CI (typecheck + unit + integration) and stage-only npm publish
  on tag (#65 / #68).
- Project workflow docs in CONTRIBUTING (#69).

### Changed

- Slash commands consolidated under `/legion` (#57).
- Status bar shows current-turn elapsed beside lifetime total (#62).
- tok/s uses output tokens / generationMs (decode throughput) (#61).

### Fixed

- Railway: pin live spawn verticals when the strip scrolls left (#67); retire /
  downward spawn connector regressions (#46).
- Live worker no longer marked retired on a transient Connection blip (#63).
- Session JSONL streamed + incrementally parsed (no full-file `readFileSync`) (#36 / #45).
- Per-stream child output byte cap; kill on overflow (#35 / #44).
- Bun SQLite `.get()` null treated as miss on root insert (#53).
- Vexillatio sibling naming scoped to the current parent (#42 / #51).

### Security / robustness (design.md F38–F46, already on master)

- Model-scope globs use non-RegExp matching (ReDoS).
- Session create uses `writeFileSync` with `wx` (no fd leak / TOCTOU).
- Session decode swallows scalar JSON lines as torn.
- `tasks[]` / blank task validated before launch.
- Per-agent `timeoutMs`, pending criteria, nested YAML acceptance parsing;
  `UNENFORCED_FIELDS` empty.

## [0.16.x] - Herdr-era (final)

Last line that runs children in Herdr panes. Not developed further on this
branch — pin `pi-legion@0.16.x` if you still need that model. See
[Herdr transition](README.md#supported-kinds) in the README.

Earlier 0.11–0.15 history (including the `pi-herdr-swarm` /
`@zzjcool/pi-herdr-subagents` renames) lives in git tags and older Releases.

[6.2.3]: https://github.com/zzjcool/pi-legion/compare/v6.2.2...v6.2.3
[6.2.4]: https://github.com/zzjcool/pi-legion/compare/v6.2.3...v6.2.4
[Unreleased]: https://github.com/zzjcool/pi-legion/compare/v6.2.4...HEAD
[6.2.2]: https://github.com/zzjcool/pi-legion/compare/v6.2.1...v6.2.2
[6.2.1]: https://github.com/zzjcool/pi-legion/compare/v6.2.0...v6.2.1
[6.0.1]: https://github.com/zzjcool/pi-legion/compare/v6.0.0...v6.0.1
[6.0.0]: https://github.com/zzjcool/pi-legion/compare/v5.6.0...v6.0.0
[5.6.0]: https://github.com/zzjcool/pi-legion/compare/v5.5.1...v5.6.0
[5.5.1]: https://github.com/zzjcool/pi-legion/compare/v5.5.0...v5.5.1
[5.5.0]: https://github.com/zzjcool/pi-legion/compare/v5.4.1...v5.5.0
[5.4.1]: https://github.com/zzjcool/pi-legion/compare/v5.4.0...v5.4.1
[5.4.0]: https://github.com/zzjcool/pi-legion/compare/v5.3.0...v5.4.0
[5.3.0]: https://github.com/zzjcool/pi-legion/compare/v5.2.0...v5.3.0
[5.2.0]: https://github.com/zzjcool/pi-legion/compare/v5.1.0...v5.2.0
[5.1.0]: https://github.com/zzjcool/pi-legion/compare/v5.0.1...v5.1.0
[5.0.1]: https://github.com/zzjcool/pi-legion/compare/v5.0.0...v5.0.1
[5.0.0]: https://github.com/zzjcool/pi-legion/compare/v4.0.0...v5.0.0
[4.0.0]: https://github.com/zzjcool/pi-legion/compare/v3.1.0...v4.0.0
[3.1.0]: https://github.com/zzjcool/pi-legion/compare/v3.0.3...v3.1.0
[3.0.3]: https://github.com/zzjcool/pi-legion/compare/v3.0.2...v3.0.3
[3.0.2]: https://github.com/zzjcool/pi-legion/compare/v3.0.1...v3.0.2
[3.0.1]: https://github.com/zzjcool/pi-legion/compare/v3.0.0...v3.0.1
[3.0.0]: https://github.com/zzjcool/pi-legion/compare/v2.0.4...v3.0.0
[2.0.4]: https://github.com/zzjcool/pi-legion/compare/v2.0.3...v2.0.4
[2.0.3]: https://github.com/zzjcool/pi-legion/compare/v2.0.2...v2.0.3
[2.0.2]: https://github.com/zzjcool/pi-legion/compare/v2.0.1...v2.0.2
[2.0.0]: https://github.com/zzjcool/pi-legion/releases/tag/v2.0.0
[0.16.x]: https://github.com/zzjcool/pi-legion/releases
