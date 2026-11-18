# 首跑成功 v1：跨机 centurion 与本地「无差别」

> 分支 `feat/first-run-success`，基线 `master` = `962992f`（6.2.0）。
> MR：<https://github.com/zzjcool/pi-legion/pull/397>（该分支已有开着的 PR，本提交（文档）追加在它上面）。
> 契约：`docs/contracts/first-run-success-v1.md`（D1–D12，冻结；本报告不重复契约条文，只给证据）。
> 改动面：W1 目录即提问 + 零配置 + 缺包带 role JSON（`src/runs/remote.ts`、`src/supervisor/terminal-supervisor.ts`）；
> W2 交付事实三分（`src/runs/remote-worktree.ts`、`src/runs/cross-machine-preflight.ts`）；
> W3 `doctor crossmachine` 一次体检（`src/runs/cross-machine-checkup.ts`、`src/extension/legion-doctor.ts`、`src/extension/legion-commands.ts`、`index.ts`）；
> W4 文档（`docs/runbooks/cross-machine-centurion-demo.md`、本报告、`CHANGELOG.md`）。
> 红/绿证据见第 6 节。

## 1. 背景

一次真实会话（6.2.0）：用户让 pi「演示跨机 centurion」，pi 用了 **103 行**、五次失败，最后被用户打断。
五次都不是「机器坏了」，而是**工具早就知道（或一次探测就能知道）的事实，被写成了一段要读者自己去研究的话**：

1. 父机 cwd 不是 git checkout → 报「这个 checkout 没有 origin」并让读者 `git remote add origin`，
   而那个目录**根本不是仓库**，没有地方可以 add —— 唯一不可能奏效的建议；
2. 继承来的扩展在目标机没装 → 报错点了包名，却没点**能修它的那个键**
   （`subagents.agentOverrides.<role>.excludeExtensions`），读者只能去翻 `src/runs/extension-inheritance.ts`；
3. 读者于是绕开工具（`hc run … pi -p …`），把 turn 烧在 workaround 上；
4. 每次调用的远端目录成了猜测（`hostCwd` 还是 `cwd`），而 `--help` 恰好截断了区分两者的那一句；
5. 没有任何**一条命令**回答「现在到底是什么不通，我下一句该敲什么」。

产品的目标比「更好的报错」更强（合同里记下的用户要求原文）：

> "**a cross-machine centurion must take the same inputs as a local one**, the only new input being
> the directory ON the target machine. When that directory is unknown the tool must **ask**, not hand
> out a configuration lesson."

翻成一句：跨机 centurion 与本地 centurion 的输入应当逐项相同，只多一项 —— **目标机上那个目录**；
这一项不知道时，工具**问**，不发配置讲义。下文第 5 节用一张表把「逐项相同」兑现成可核对的格子。

## 2. 五坑 before / after

每一格都是**真字符串**：before 取自 `962992f`（`git show 962992f:src/runs/…`），after 取自当前分支。

### 坑 1：父机目录不是仓库时，给出唯一不可能奏效的建议（D5）

会话撞到的原文（旧）：

```text
cross-machine delivery needs one shared remote: this checkout (/Users/me/agents) has no origin. Two ways out: 1) add one and retry — git -C /Users/me/agents remote add origin <url> (the machine 'vps' must be able to reach the same url); 2) drop the worktree delivery — dispatch a worker instead: subagent({ agent: "worker", host: "vps", task: "..." }) needs no origin.
```

为什么不可执行：`/Users/me/agents` 不是 git 仓库，`git remote add` 在那里必然失败；
而「加一个 origin」只对「是仓库、但没有 origin」这一种状态成立。两种状态被塌缩成了一句。

现在（`notALocalCheckoutMessage`）：

```text
cross-machine delivery needs a git checkout on this machine too, and this session's directory (/Users/me/agents) is not one. Two ways out: 1) run the launch from a checkout — start pi inside yours, or pass a relative cwd that points at one, plus hostCwd for the directory ON that machine: subagent({ agent: "centurion", host: "vps", cwd: "../my-repo", hostCwd: "/abs/path/on/vps", task: "..." }); 2) dispatch a worker instead — subagent({ agent: "worker", host: "vps", task: "..." }) needs no checkout and no origin.
```

「是仓库但没有 origin」「两侧 origin 不同」两句**一字未改**（它们原来就是对的，且各有 4 条测试钉着）。

落在哪：

- 句子：`src/runs/remote-worktree.ts:552`（`notALocalCheckoutMessage`）
- 抛出：`src/runs/cross-machine-preflight.ts:339`（交付预检第 2 步）、`src/runs/remote-worktree.ts:640`（`assertSharedOrigin`，建树前的守卫）
- doctor 的 `parent checkout` 行复用同一句：`src/runs/cross-machine-checkup.ts:401`

### 坑 2：缺扩展包的错误不带「能修它的那个键」（D4）

会话撞到的原文（旧，`packagePathError`，无 role）：

```text
host 'vps': the extension '/Users/me/pi-sysmon/extensions/index.ts' belongs to package 'pi-sysmon', which is not installed on that machine (the launch would have silently dropped it). Install 'pi-sysmon' on 'vps' (same entry names are then mapped automatically), or add an explicit prefix to subagents.crossMachine.hosts.vps.pathMap, or stop inheriting the parent's extensions (PI_LEGION_CHILD_INHERIT_EXTENSIONS=0 / inheritExtensions: false on the card).
```

为什么不可执行：三个建议里没有一个是「只让这个角色不继承」的那个键（`excludeExtensions`），
于是读者去翻源码才能把「我不想装这个包」表达出来。

现在（带具体 role 与可粘贴的 settings JSON）：

```text
host 'vps': the extension '/Users/me/pi-sysmon/extensions/index.ts' belongs to package 'pi-sysmon', which is not installed on that machine (the launch would have silently dropped it). Two ways out: 1) install it there — hc exec --on vps -- pi install npm:pi-sysmon (same entry names are then mapped automatically); 2) keep it on this machine only, for role 'centurion': subagents.agentOverrides.centurion.excludeExtensions — {"subagents":{"agentOverrides":{"centurion":{"excludeExtensions":["pi-sysmon"]}}}}
```

`which is not installed on that machine` 逐字保留（测试与本文都靠它 grep）；不知道角色时（resume / 读回）
第二句退回 `for the role you launch: subagents.agentOverrides.<role>.excludeExtensions`，且不带 JSON。

> 分工（合并 master 后）：`-e/--extension` 上的缺包/入口不符现在由 master 的 `xm-dispatch` D2 接管
> （跳过 + 一条汇总 warning，只有卡片写了 `requiredExtensions` 才硬拒）；下面这段 D4 文案留在
> **其它包内参数**（`--skill` 等）上，`which is not installed on that machine` 逐字未变（严格映射器
> `mapRemoteArgv` 现在没有生产调用者）。

落在哪：

- 函数：`src/runs/remote.ts:160`（`packagePathError`），role 子句在 `src/runs/remote.ts:175`
- 调用点：`src/runs/remote.ts:578`
- role 的来源：`src/supervisor/terminal-supervisor.ts:671`（`role: input.agent.name`）

### 坑 3：读者绕开工具（`hc run … pi -p …`）烧 turn（D2 的「不要绕过」那句）

会话撞到的原文（旧，缺目录时的配置讲义）：

```text
host 'vps' has no cwd: set a default in subagents.crossMachine.hosts.vps.cwd, or pass one per call with subagent({ host: "vps", cwd: "/abs/path/on/vps" })
```

为什么不可执行（这一坑）：它把人送去**改 settings 文件**，而这次对话本来可以一句话问清楚；
工具既没有说「这是提问、找用户要」，也没有说「不要绕过我」—— 于是读者去跑 `hc run --on vps -- pi -p …`，
自己拼一个远端 pi，turn 全花在工作区之外。

现在（同一句提问的第 3、4 句）：

```text
… If this conversation has not named a directory on vps, ask the user which one to use. Do not ssh or run `hc exec` to browse that machine — a guess here becomes a child in the wrong tree.
```

并且 D2/D4/D5 三类文案的结尾都是可粘贴的 `subagent(...)` 形状 —— 「下一步」永远是回到工具，而不是离开它。

落在哪：`src/runs/remote.ts:957`（`missingRemoteCwdQuestion`）；抛出点 `src/runs/remote.ts:1020`（纯 resolver，
读回 / resume 也走这里）与 `src/runs/remote.ts:2067`（异步 resolver，**在任何发现探测之前**）。

### 坑 4：每次调用的远端目录靠猜（`hostCwd` vs `cwd`，`--help` 截断）

会话撞到的原文（旧的同一句 —— 坑 3 与坑 4 是**同一个旧句子的两种伤害**，这也是 D2 只冻结「一句」的原因）：

```text
host 'vps' has no cwd: set a default in subagents.crossMachine.hosts.vps.cwd, or pass one per call with subagent({ host: "vps", cwd: "/abs/path/on/vps" })
```

为什么不可执行（这一坑）：`subagent({ host, cwd })` 里的 `cwd` 在带 `host` 时**含义会切换**成远端目录
（`hostCwd` 是它的显式别名）；旧句子既没说这一点，也没说「这个路径是在那台机器上读的、永远不会被翻译」。
读者只能猜，而 `--help` 又把唯一区分它们的那句截掉了。

现在（提问的第 2 句，把参数、值、语义一次说全）：

```text
… Pass it with the call: subagent({ agent: "centurion", host: "vps", cwd: "/abs/path/on/vps", task: "..." }) (that path is read ON vps; it is never translated from here).
```

落在哪：`src/runs/remote.ts:957`（提问）。同一坑的另一半也补在了 **schema 描述**上：`index.ts` 的 step / call / batch 三处
`cwd` / `hostCwd` 描述改成「带 `host` 时，这就是**那台机器上**的目录，在那里读、从不翻译」（提交 `254c788`）。
但**唯一权威的说明**仍然随报错一起到达读者 —— schema 描述要等读者去查，报错不用。

### 坑 5：没有哪条命令能回答「现在缺什么，下一句敲什么」（D6–D8）

会话撞到的原文（旧 `doctor crossmachine` 的静态块，`962992f:src/extension/legion-doctor.ts`）：

```text
## Cross-machine (host targets)
- enabled: true
- hosts: vps
- vps: resolved
    cwd: /srv/app
    node: node
    piCli: pi
    legionRoot: /Users/me/code/app
    extensions: 0
    worktreeRoot: /srv/.pi-worktrees
- last preflight: never
- minimal launch (copy-paste, built from this configuration):
    subagent({ agent: "centurion", host: "vps", … })
```

为什么不可执行：它只把**配置回显**一遍 —— 不回答「`/srv/app` 在那台机器上到底在不在」「那边的 `node` 跑得起来吗」
「我用这个模型，那台机器的 `pi` 认不认」。更糟的是它按 `settings.hosts` 迭代：`{ "enabled": true }` 这种
**推荐的零配置**会打出 `- hosts: none configured`，看起来像"没配"。于是读者去读源码（真机会话：约 50 轮）。

现在：`/legion doctor crossmachine` 一条命令，逐项 PASS/FAIL/SKIP，最后一行是可粘贴的 launch。
三个真机渲染样例见第 3 节。

落在哪：

- 探测与结构化结果：`src/runs/cross-machine-checkup.ts:159`（`runCrossMachineCheckup`）
- 渲染：`src/extension/legion-doctor.ts:1199`–`1230`（快照存在时走这条；不存在时**逐字节**保留旧静态块，`auto-doctor` 也仍走它）
- 两个异步调用方，且**只在选中 `crossmachine` 这一节时**才探测：`src/extension/legion-commands.ts:632`、`index.ts:2532`

## 3. `/legion doctor crossmachine`：一条命令给全

样例取自一次真机渲染（经 fake hc core + 临时远端机器产出：`/tmp/doctor-sample-final.txt`），
**只把临时路径与主机名换成现实值**（`/Users/me/app`、`/srv/app`、`vps`）；`PASS`/`FAIL`/`SKIP` 的措辞与 `fix:` 行原样。

### A. 只配了 `cwd`（推荐形态）：除缺一个包，全绿

```text
## Cross-machine (host targets)
- enabled: true
- hosts: vps
- last preflight: never
  - PASS parent checkout: /Users/me/app is a git checkout; origin https://github.com/acme/app.git
  - PASS hc machines: vps
  - vps:
    - PASS target checkout: /srv/app exists
    - PASS target origin: /srv/app origin git@github.com:acme/app.git matches this checkout
    - PASS target runtime: /opt/node/bin/node v24.13.1 and /root/.pi/agent/install/releases/1.5.2/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js 1.5.2 — the paths the child will use there
    - FAIL inherited extensions: 1 package(s) missing on vps: pi-sysmon (role 'centurion')
          fix: hc exec --on vps -- pi install npm:pi-sysmon
          fix: {"subagents":{"agentOverrides":{"centurion":{"excludeExtensions":["pi-sysmon"]}}}}
          fix: # where: ~/.pi/agent/settings.json (user) or /Users/me/app/.pi/settings.json (project)
    - PASS target models: workbuddy/deepseek-v4.1-flash is in vps's listing (1 model(s))
    - launch (copy-paste once the FAILs above are fixed):
        subagent({ agent: "centurion", host: "vps", cwd: "/srv/app", model: "workbuddy/deepseek-v4.1-flash", worktree: true, task: "demo: report pwd and stop", phases: [{ id: "planning", next: [{ to: "implementing" }] }, { id: "implementing", next: [{ to: "done" }] }, { id: "done", terminal: true }] })
```

### B. 零配置、还不知道目录：它提问，四项 SKIP

```text
  - vps:
    - FAIL target checkout: host 'vps' needs a directory on that machine, and this call did not name one — which directory should the child work in? Pass it with the call: subagent({ agent: "centurion", host: "vps", cwd: "/abs/path/on/vps", task: "..." }) (that path is read ON vps; it is never translated from here). If this conversation has not named a directory on vps, ask the user which one to use. Do not ssh or run `hc exec` to browse that machine — a guess here becomes a child in the wrong tree.
    - SKIP target origin: target origin not checked: no directory on vps yet — the FAIL above says how to pass it
    - SKIP target runtime: target runtime not checked: no directory on vps yet — the FAIL above says how to pass it
    - SKIP inherited extensions: inherited extensions not checked: no directory on vps yet — the FAIL above says how to pass it
    - SKIP target models: target models not checked: no directory on vps yet — the FAIL above says how to pass it
```

（这一块本身不产生任何 `machine.exec`：`machine.list` 在整次体检里只问一次，缺目录在探测之前就变成了提问。）

### C. 模型那台机器没有：行尾说明 `--no-extensions`，可粘的 `fix:` 一条

```text
    - FAIL target models: acme/missing-model is not in vps's listing: workbuddy/deepseek-v4.1-flash (the child runs with --no-extensions, so a provider installed there must also be named in hosts.vps.piExtensions)
          fix: use a model that machine serves, e.g. model: "workbuddy/deepseek-v4.1-flash" on the role card
```

### 每一项 ↔ 探的是什么 ↔ FAIL 的下一步

| 检查项（固定顺序 D7） | 探测（只读） | FAIL 的 `fix:` |
|---|---|---|
| `parent checkout` | 本机 git：`git -C <cwd> rev-parse --git-dir`，再 `git -C <cwd> remote get-url origin`（不碰 `hc`） | 不是仓库（D5 原话）→ 在 checkout 里重开 pi / 相对 `cwd`；是仓库没 origin → `git -C <dir> remote add origin <url>`；没有 git → 装 git |
| `hc machines` | 同一条 `hc` 连接上的 `machine.list` | `hc machine add --name <h> ssh://user@<h>`（settings 里有、hc 不认识的每个 host 一行） |
| `target checkout` | `machine.exec` → `test -d <cwd>` 那台机器 | `hc exec --on <h> -- ls -d <cwd>`，或把 `cwd` 指到存在的绝对路径；**没有 `cwd` 时这一行就是 D2 的提问** |
| `target origin` | 目标机：`git -C <cwd> rev-parse --git-dir`，再 `git -C <cwd> remote get-url origin`，与本机 origin 归一化比较 | `hc exec --on <h> -- git -C <cwd> remote add origin <url>` / `… set-url origin <url>`（本机 origin 已知时直接填真值） |
| `target runtime` | `machine.exec` → `<node> --version`、`<node> <piCli> --version`（**child 会用的那两个路径**） | `hc exec --on <h> -- <node> --version` + 装 node；或把 `piCli` 指到 `…/dist/bundle/cli.js` |
| `inherited extensions` | 本机 `pi list`（`ensureHostExtensions`）+ 目标机的包索引（发现探测，或 `packageLoaderFor` 按需一次）+ 逐包 `resolvePackagePathOnHost` | `hc exec --on <h> -- pi install npm:<pkg>`，与 `excludeExtensions` 的 settings JSON（具体 role） |
| `target models` | `machine.exec` → `<node> <piCli> <child argv 去掉 task>` + `--list-models` | 用那台机器真的有的模型（原话把清单列出来，≤10 个，其余给计数）；或把 provider 扩展写进 `piExtensions` |

边界（合同 D7，代码照做）：一台机器最多 5 个 host、8 个缺包、10 个模型列出来，其余只给计数；
每个远端调用沿用 10 秒预算；传输层失败让**该项 FAIL、其后各项 SKIP 并带同一句原因**；
`runCrossMachineCheckup` 自己**从不抛**。

## 4. runbook 第 0 步（读者现在第一眼看到的东西）

`docs/runbooks/cross-machine-centurion-demo.md` 的开头（节选前 22 行，原样；下面的缩进是为了在本文里保留它内部的代码块）：

    ## 0. 体检：一条命令

    ```text
    /legion doctor crossmachine
    ```

    这一条就是「现在缺什么、下一句该敲什么」的完整回答：**一次 `hc` 连接**，把跨机 launch 依赖的
    每个事实打一行 `PASS` / `FAIL` / `SKIP` —— 本机是不是 checkout、`hc machine ls` 有没有这台机器、
    目标机上的目录/仓库/origin/`node`/`pi`/继承来的扩展包/模型，逐项给结论。它是**只读**的：
    不建树、不 launch、不改配置（`git` 只读、`pi --list-models` 一次）。

    - **推荐的第一条命令**：比直接 launch 便宜，也比自己敲四五条 `hc exec` 快。
    - 探测只发生在**这一节被选中时**：`/legion doctor models` 之类仍然是零探测的静态报告。
    - 它的**最后一行是可以整行粘贴的 launch**（真 host、真 cwd、真 phase machine，没有 `<占位符>`）；
      如果连目录都还不知道，它打出的就是那句**提问**（D2），而不是一条带空格的 launch。

第 0 步之后是：`PASS/FAIL 怎么读 → 下一步` 表（每条 FAIL 的下一步就是它打印的 `fix:` 行，读者不需要自己发明文案）、
A/B/C 三个真样例、以及「手工兜底：三条命令」（旧的 `git remote get-url origin` / `hc machine ls` /
`hc exec … git -C <cwd> remote get-url origin` 表，原样保留在它下面）。原来的第 0 步「准备一个有 origin 的仓库」
成了第 1 步，配置第 2 步，一条调用第 3 步，失败怎么读第 4 步，与 live-e2e 的关系第 5 步。

## 5. 与本地无差别

| 本地 centurion 需要的输入 | 本地 centurion | 跨机 centurion | 这一行怎么回答 |
|---|---|---|---|
| role / task / phases / verify | 调用参数（`role`、`task` 必填；`phases`/`verify` 可选） | **同本地，一字不差** | 与本地同一项：必填/可选的规则不变 |
| 工作目录 | 本机 cwd | **那台机器上的绝对路径** | **仍是必填**；不给就**提问**（D2），不猜 HOME、不回落到父机 cwd |
| 父机记录目录 + checkout | `legion.db` 所在目录，无需 git | 还需要**父机 checkout** 以及与目标机共享的 origin | 自动发现（`localCheckoutState` 一次判定）；不是仓库 → D5 的独立答案，是仓库没 origin → 另一句 |
| host 名 | 没有这一项 | `host: "<h>"` | 仍是必填，但**不用配置**：只要 `hc machine ls` 认识它。默认只允许 `centurion` 跨机（`allowRoles`），别的角色要显式放行 —— 这是「远端 centurion 在本机派生团队」的设计意图 |
| node / pi / legion root | 就是本进程的那几个 | 一次发现探测填好（真实二进制、launcher 背后的 JS 入口、包根） | 自动发现；探测答不出来 → 错误先给**动作**（install / 指到 `cli.js`），settings 键只作 trailing aside |
| 继承的扩展 | 直接用父机路径 | 按**包名**在那台机器的索引里重锚；缺包 → 报错带 role 与 JSON | 自动发现；缺了就是「装 / 只这个角色不继承」二选一，**不是**提问 |
| model | role 卡或默认，可省 | 同本地，但那台机器的 `pi` 必须真的提供 | 与本地同一个字段（可省）+ 目标机校验（一个都没命名时，校验「那台机器看得到模型」） |
| git origin（交付通道） | 不需要 | 两侧归一化后必须相同（D10） | 自动发现；缺失/不同 → 原话点名两个 url 与 `set-url` / `add origin` |
| pi 必须跑在 hc 终端里 | 不需要 | 需要（`HC_TERMINAL_SOCKET` + `HC_TERMINAL_ID`） | 仍是必填的**环境前提**（工具无法替你创造），错误原话说清怎么补 |
| agent 怎么知道有这个能力 | 本来就是默认行为 | skill 的 description + 「跨机器派发」一节 | 自动（见第 6 节）：`host` + `cwd` 与「不知道就问用户」都写在 agent 每轮先读的地方 |

**一句话结论：只有「目标机上的那个目录」是新增的必填输入**；其余要么是自动发现（host 准入、`node`/`pi`/包根、
继承的扩展、两侧 origin），要么与本地**同一项**（role/task/phases/verify、model），要么是环境前提（pi 在 hc 终端里）——
而唯一新增的那一项，不知道时工具**问**，不发配置讲义。

## 6. 第一入口：skill 现在会告诉 agent 跨机派发存在

这一条是「agent 不知道」的最上游原因。6.2.0 的 `skills/pi-legion/SKILL.md`（agent 每轮最先读到的清单项与正文）
grep `cross-machine` / `host` / `跨机` **零命中**：agent 既不知道有这个能力，也不知道唯一必填的是目标机上的目录，
所以只能翻源码或绕开工具。

现在（`skills/pi-legion/SKILL.md`）：

- **description** 多了一句 capability 声明：`Cross-machine dispatch adds host + cwd to the same call.`
  —— agent 从描述里就能看出这个能力存在，不必读正文。
- **正文新增 `## Cross-machine dispatch`**，六句话：同一套调用只多一个 `host`；最小例子
  （`subagent({ agent: "centurion", host: "hw-nj", cwd: "/home/you/code/x", task: "…" })`，默认只有 centurion 可跨机）；`cwd` 是唯一必填，
  来源顺序是「对话里已提到的 → 问用户」；**明确禁止** `ssh` / `hc exec` 去远端找目录（猜出来的路径会让孩子
  在错误的树里干活）；`/legion doctor crossmachine` 与 runbook 的指路；远端 child 起不来时的读法（退出码 +
  screen 原文 + `Command (run on '<host>' to reproduce):`，不再把 `execution: unknown` 当原因）。
- **打包可见**：`package.json` 的 `files` 已含 `skills/**/*`；`npm pack --dry-run` 的清单里有
  `skills/pi-legion/SKILL.md`（10.8 kB）。测试 `test/unit/skill-cross-machine.test.ts` 四条断言把这两件事钉住：
  删掉那一节或那句描述 → 立刻红（红/绿证据见下）；清单或 tarball 里没有这个文件 → 也红。

```
$ npm pack --dry-run 2>&1 | grep SKILL.md
npm notice 10.8kB skills/pi-legion/SKILL.md

$ node --experimental-strip-types --test test/unit/skill-cross-machine.test.ts
✔ skill: the description advertises cross-machine dispatch (host + cwd)
✔ skill: the body teaches the minimal call, the one required input, and the ask-don't-probe rule
✔ skill: the shipped tarball contains it (the manifest globs actually cover the file)
✔ skill: npm pack --dry-run really lists SKILL.md
ℹ pass 4  ℹ fail 0
```

**红（把那一节与那句描述删掉，恢复后重跑）：**

```text
✖ skill: the description advertises cross-machine dispatch (host + cwd)
✖ skill: the body teaches the minimal call, the one required input, and the ask-don't-probe rule
ℹ tests 4  ℹ pass 2  ℹ fail 2
# 恢复后：ℹ tests 4  ℹ pass 4  ℹ fail 0
```

## 7. 第二次真机演示：三个坑，已由 master 的 `xm-dispatch-fixes-v1` 覆盖

同一天第二次真机演示（Mac → `hw-nj`）又暴露三处。它们与本卡的 D1–D12 不同：三个都是 **master 上另一条
修复线**已经冻结并实现的问题（`feat/xm-fixes`，契约 `docs/contracts/xm-dispatch-fixes-v1.md`，实跑记录
`docs/reports/xm-dispatch-fixes.md`）。本分支也曾各自实现过一版（旧编号 D13/D14/D15），**合并 master 时全部
删除**，以 master 的实现为准（合并提交 `98f1534`）。这里只记「演示里看到什么 / 现在是什么」，以及本分支
唯一补上的那处一致性。

### 坑 6：声明的是目录，却被判成「未声明的入口」（master D1）

```text
host 'hw-nj': package 'pi-autoresearch' IS installed there at /Users/me/pi-autoresearch, but it does not expose
'./extensions/pi-autoresearch/index.ts' (declared: ./extensions -> /Users/me/pi-autoresearch/extensions);
the launch would have loaded a different entry than the one this machine asked for. …
```

不可执行：那个文件在两台机器上都真实存在，版本也相同（`pi-autoresearch@1.9.0`，`pi.extensions: ["./extensions"]`）。
父机把目录声明展开成具体文件再比对，远端只报「声明项就是这个目录」，而比较是字符串相等。

现在（master D1）：声明项以 `/` 为界覆盖子树 —— `extensions/pi-autoresearch/index.ts` 映射到那台机器的同名文件；
**请求恰好是目录本身也照旧放行**；只有「文件声明 + 请求不在其下」才是 `entry-missing`；
`extensions-other/x.ts` 不会被 `extensions` 命中。规则与 T1–T5 表冻结在 master 的契约里。

本分支的增量只有一处：doctor 的 `inherited extensions` 项与 launch 用**同一个判定**
（`requiredExtensionMatches`），缺了就是 FAIL，行尾写 `(the card requires it, so a launch REFUSES)` 或
「launch 会跳过」，不再出现 **doctor 绿 / launch 拒** 的自相矛盾。

### 坑 7：一个继承包缺失就拦住整个 launch（master D2）

```text
host 'hw-nj': the extension '/Users/me/pi-sop/extensions/index.ts' belongs to package 'pi-sop', which is not installed on
that machine (the launch would have silently dropped it). Install 'pi-sop' on 'hw-nj' (same entry names are then mapped
automatically), or add an explicit prefix to subagents.crossMachine.hosts.hw-nj.pathMap, or stop inheriting the parent's
extensions (PI_LEGION_CHILD_INHERIT_EXTENSIONS=0 / inheritExtensions: false on the card).
```

不可执行：用户原话是「我只想派个 scout，为什么得先研究 5 个扩展装没装」。一个环境性扩展缺失把整次派发拦下来，
还一个包一条错误。

现在（master D2）：继承来的、那台机器装不上/入口不符 → **跳过**，并给**一条**汇总 warning：

```text
host 'hw-nj': skipped 2 inherited extensions that machine cannot install/load: pi-sop, pi-lens.
Install them there, or exclude them permanently: {"subagents":{"agentOverrides":{"centurion":{"excludeExtensions":["pi-sop","pi-lens"]}}}}
```

只有角色卡显式写了 `requiredExtensions` 才硬拒，且同样聚合成**一条**错误；探针没答（`no-package`）不跳过
（那是配置错误，不是目标机事实）。

### 坑 8：远端写完报告，父端却判 `aborted`（master D3）

```text
execution: aborted (no assistant message for the last prompt)
acceptance: rejected (none)
read-back from host 'hw-nj': 5 of 5 lines (complete)
```

远端当时有 11 行。根因是镜像只在 `collect()` 入口读一次，判词在 wait 之后仍用那份快照。

现在（master D3）：wait 落定后**重新读回**，判词只建立在最后一次读回上；读不到转录是
`unknown (transcript not retrieved from host '…')` 并附远端路径 + `hc exec` 取回命令，而不是「child 没说」；
`wait` 超时仍是 `running (collect deadline …)`，不是 abort。本分支在这条上没有增量（同一处实现已删）。

### 已知限制（master 记录、本分支不改）

同一台机器上两个 run 派生**同名 child** 会共用 `…/.pi-subagents-mirror/no-run/<handle>/session.jsonl`：
上一轮残留的转录可能让新的启动确认门提前通过、也可能被读成这一轮的转录。master 的 `xm-dispatch` 报告（「已知遗留」）把它记为既有风险；
本分支的 doctor **不检查 mirror**，因此没有体检项会因此变绿或变红——但遇到「远端看起来没干活、transcript 又很短」时，
先怀疑这个目录，再怀疑 child。

## 8. 测试红绿证据

### 四个错误情形（D10）+ 四个体检情形

| 情形 | 钉住它的测试 |
|---|---|
| 父机目录不是 checkout（D5） | `test/unit/remote-worktree.test.ts:396`「D5: a session directory that is NOT a checkout gets its own answer, never `git remote add`」；`test/integration/remote-worktree.test.ts:387`（真 spawn 路径，wire 上无 `terminal.run`、无 `git worktree add`） |
| 是 checkout 但没有 origin（原句不变） | `test/unit/remote-worktree.test.ts:260`「D10/D11: cwd missing, cwd not a repo, no origin, different origin — four exact messages」；`test/unit/cross-machine-preflight.test.ts:276` |
| 目标机缺扩展包（D4） | `test/unit/cross-machine-discovery.test.ts:710`（带 role 的 JSON，且能 `JSON.parse` 回 settings）；`test/unit/cross-machine-params.test.ts:537`（起终端**之前**拒绝）；`test/integration/fake-core-host-discovery.test.ts:513` |
| 目标机没有这个模型 | `test/unit/cross-machine-params.test.ts:706`「S5.6: the startup probe's four failures are named before a terminal exists」（case `model-missing`，断言点名 host / 模型 / 该机真实清单 / 两个方向的 fix） |
| 体检：全绿 | `test/unit/cross-machine-checkup.test.ts:381`「D7/D8: a healthy host reports every item PASS in the frozen order, and a real launch line」 |
| 体检：没有 checkout | `test/unit/cross-machine-checkup.test.ts:465`「D5: a session directory that is not a checkout gets D5's sentence, not `git remote add origin`」 |
| 体检：缺包 | `test/unit/cross-machine-checkup.test.ts:547`「D4: a package missing on the target FAILs with the role and a pasteable excludeExtensions JSON」 |
| 体检：模型不提供 | `test/unit/cross-machine-checkup.test.ts:1018`「D7: a model the target does not serve FAILs and lists what that machine DOES see」 |

外加（同一批 D6）：`test/unit/cross-machine-checkup.test.ts:500`（`{enabled:true}` + 只有 `machine list` 认识的 host）、
`:1048`（旧 core，`machine.list` 不支持 → SKIP，指名 host 仍照检）、`:1078`（传输失败 FAIL 自己、其余 SKIP）；
`test/unit/legion-doctor.test.ts:1612` 与 `:1669` 两例（快照渲染：FAIL 进 Issues、`report.ok` 为假）。

### 红：把修好的那句退回去，测试就红（三次实跑）

**D2 红**（把 `missingRemoteCwdQuestion` 退回旧的配置讲义；`test/unit/remote-host-cwd.test.ts` + `test/integration/fake-core-minimal-config.test.ts`）：

```text
ℹ tests 15
ℹ pass 14
ℹ fail 1
test at test/unit/remote-host-cwd.test.ts:124:1
✖ D2: missingRemoteCwdQuestion is the frozen four-sentence question, with the host interpolated
  + actual   - expected
  + `host 'vps' has no cwd: set a default in subagents.crossMachine.hosts.vps.cwd, or pass one per call with subagent({ host: "vps", cwd: "/abs/path/on/vps" })`
  - 'host \'vps\' needs a directory on that machine, and this call did not name one — which directory should the child work in? … ask the user which one to use. Do not ssh or run `hc exec` to browse that machine — a guess here becomes a child in the wrong tree.'
```

**D5 红**（把 `notALocalCheckoutMessage` 退回「塌缩成 no-origin」那一句；4 个文件一起跑）：

```text
ℹ tests 48
ℹ pass 44
ℹ fail 4
test at test/integration/cross-machine-preflight-order.test.ts:192:1
✖ D7 order: a failing delivery preflight is reported BEFORE the phases typo, and nothing is spawned
test at test/integration/remote-worktree.test.ts:387:1
✖ D5: a cwd that is not a checkout here is named as the SESSION's directory, and no terminal is created
test at test/unit/cross-machine-preflight.test.ts:276:1
✖ D5 step 2: the three local states get three answers, and the order stops at step 2
test at test/unit/remote-worktree.test.ts:396:1
✖ D5: a session directory that is NOT a checkout gets its own answer, never `git remote add`
  AssertionError [ERR_ASSERTION]: `git remote add` cannot work in a non-repository
```

**D4 红**（把 `packagePathError` 的 role + `excludeExtensions` JSON 退回旧的「关掉继承」建议）：

```text
test/unit/cross-machine-params.test.ts + test/unit/cross-machine-discovery.test.ts + test/unit/cross-machine-checkup.test.ts
ℹ tests 59
ℹ pass 56
ℹ fail 3
✖ v1.2 extensions: the package is ABSENT there — refuse before launch, naming package, path and the fix
✖ v1.2/D4: with a role, the missing-package refusal carries the concrete excludeExtensions JSON (and it parses as settings)
✖ D4: a package missing on the target names the ROLE and the exact excludeExtensions JSON, before any terminal
```

**W3 红**（把体检里那条具体的 `excludeExtensions` JSON 换成一句散文）：

```text
test/unit/cross-machine-checkup.test.ts + test/unit/legion-doctor.test.ts
ℹ tests 41
ℹ pass 40
ℹ fail 1
✖ D4: a package missing on the target FAILs with the role and a pasteable excludeExtensions JSON
  AssertionError: expected a settings JSON fix, got:
  ["hc exec --on fakebox -- pi install npm:pi-sysmon","set subagents.agentOverrides.centurion.excludeExtensions to keep it here only"]
```

四次红都是在**临时副本**里跑的（`/tmp/redcheck`，`src/` 只在该副本里被改回，工作树与本分支一次都没被改）：
每次跑完把文件恢复；本文引用的就是那三次的原始输出。


### 第二轮：那三条的红 / 绿在 master 的套件里

D1/D2/D3 的断言随实现一起留在 master（本分支合并时删掉了自己那版同义测试，同一行为不再有两套断言）：

- **D1 目录声明**：`test/unit/cross-machine-discovery.test.ts`（T2 `:759`、`/` 边界 `:790`、T4 `:803`；T1 `:649`、T5 `:676`；
  **T3 请求恰为目录没有专门断言**）、`test/integration/fake-core-host-discovery.test.ts`；
- **D2 跳过 + 聚合 warning / `requiredExtensions` 硬拒**：`test/unit/cross-machine-discovery.test.ts`（纯映射）、
  `test/integration/fake-core-host-discovery.test.ts:536-567`（argv 里成对消失 + handle 带 `warnings`）、
  `test/unit/xm-dispatch-remote-transcript.test.ts:464-505`（notice 行）、`test/unit/agents.test.ts:150`
  （`requiredExtensions`；`allowRoles` 的解析在 `cross-machine-params.test.ts:945` 与 `cross-machine-target.test.ts:95`）；
- **D3 读回时机与诚实 unknown**：`test/unit/xm-dispatch-remote-transcript.test.ts`、
  `test/unit/cross-machine-orchestrator.test.ts`。

本分支在这一轮唯一新增的红绿点，是 doctor 与 launch 的同口径（`test/unit/cross-machine-checkup.test.ts`）：

```text
✖ D13: a target whose declaration does NOT cover the entry FAILs …（合并前，演示里的自相矛盾）
    AssertionError: expected a FAIL, got: 1 inherited extension(s) resolve on fakebox
✖ D2: an extension the card REQUIRES (`requiredExtensions`) and the target lacks FAILs — and no JSON is offered
    整行正则含 \(the card requires it, so a launch REFUSES\)$；删掉这个后缀即红（`cross-machine-checkup.test.ts:715`）
```

**新增的两条一致性断言**（改回去即红）：
1. 卡片把包写进 `requiredExtensions` → 缺包时 FAIL 行带 `(the card requires it, so a launch REFUSES)`，
   且**不给** `excludeExtensions` JSON（那个键对必需项无效）；
2. 同样缺包、但卡片只把它放在继承里 → FAIL 行带「launch 会跳过」的尾句，且给合并 JSON。

### 绿：本卡的最终门禁（2026-11-18，本分支实跑）

`npm run typecheck`（`tsc --noEmit`）：

```text
> pi-legion@6.2.0 typecheck
> tsc --noEmit

(无输出，退出 0)
```

`npm test`（`node --experimental-strip-types --test test/unit/*.test.ts`）：

```text
ℹ tests 2636
ℹ pass 2635
ℹ fail 0
ℹ cancelled 0
ℹ skipped 1
ℹ todo 0
ℹ duration_ms 54554.088757
```

`npm run test:integration`（`… test/integration/*.test.ts`）：

```text
ℹ tests 173
ℹ pass 173
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 56186.980919
```

三条命令的退出码都是 0。`test/unit/terminal-supervisor.test.ts` 未修改（D18 of `cross-machine-spawn-v1`）。

## 9. 版本建议：`6.3.0`（minor）

- **为什么是 minor**：新增了一项**能力** —— `/legion doctor crossmachine` 从「配置回显」变成一次体检（一次 `hc` 连接、
  PASS/FAIL/SKIP、每项带真值的 `fix:`、末尾可粘贴的 launch）；同时新增了一条**零配置的 launch 路径**
  （`{ "enabled": true }` + 按次 `cwd`）。按 SemVer，向后兼容地新增能力 = minor。
- **为什么不是 patch**：patch 只留给「行为不变、只改错字」；这里多了新功能，读者也该被提示「可以少写配置了」。
- **为什么不是 major**：没有删任何 API / settings 键 / 退出码（11/15/17 逐字节未变，`resolveHostTarget` 的签名不变，
  静态 doctor 块逐字节保留给 `auto-doctor` 与无快照路径），没有数据迁移（settings 与磁盘缓存格式都没变）。
  唯一"行为变化"是**报错文案与它的时机**（D2 在任何 `machine.exec` 之前），而文案不是 API。

## 10. 边界 / 未做

- **D2 的提问不可能知道对话里从未提过的目录**：这是设计（它问），不是缺陷；它只保证「不猜、不翻译、不绕过」。
- **`hc machine ls` 是按 `HC_SESSION` 的**：真实会话里注册的机器，在 `HC_SESSION=test-*` 里看不见（反之亦然）。
  所以体检里 `hc machines` 那行 FAIL 时，先确认你跑在哪个会话里（runbook 第 5 节）。
- **远端镜像目录仍按 handle 共享**：`…/.pi-subagents-mirror/no-run/<handle>/session.jsonl` 跨轮次保留，上一轮残留的转录
  仍可能让新的启动确认门提前通过（仓库里 `docs/reports/remote-child-startup.md` 的 R1 记过同一件事）。彻底修需要 per-launch
  目录（或一次不会与 resume 竞争的清理），属于交付通道改动，本卡不做 —— master 的 `xm-dispatch` D3.1/D3.3 只保证「判定用的文本是 turn 结束后那次读回」。
- **体检不看 mirror**：`no-run` 目录共用是 master 记录的既有风险（见第 7 节末），doctor 不检查它，
  所以不会因此变绿或变红；遇到「远端像没干活、转录又很短」时按 runbook 的提示查那个目录。
- **体检的 host 上限是 5**：第 6 个起只给计数（`… N more host(s) not checked (cap 5)`）；缺包 8、模型 10 同理。
- **`model-missing` 仍然放行候选链**：体检把「那台机器没有这个模型」作为 FAIL 报出来，但运行期的启动探测
  仍旧允许模型候选链。`noModelFallback` 钉在「机器事实」那几条上（`cwd` 缺失 `src/runs/remote.ts:1022`/`:2069`、
  交付预检 `src/runs/cross-machine-preflight.ts:208`、目标机不可达 `src/runs/remote.ts:2848`、**D4 的缺包**
  与 D5 的四条交付拒绝 —— 它们都是确定性的，换模型重跑只会重复同样的探针）；`model-missing` 不在其列 ——
  换模型重跑是合法的。
- **D5 的「相对 `cwd`」只修父机那一侧**：`cwdIsRemote`（`index.ts:4899`）只把**绝对** `cwd` 当远端目录，所以
  `cwd: "../my-repo"` 修的是「父机 checkout」这一半；目标机上的目录仍要 `hosts.<h>.cwd` 或另一次绝对 `cwd`，
  否则就会收到 D2 的提问。D5 的文案是合同冻结的（不属本卡改动），runbook 第 4 节补了这一句说明。
- **`docs/runbooks/cross-machine-live-e2e.md` 未改**：它引用的 `PI_LEGION_REMOTE_*` 环境变量路径与本轮无关；
  其中几处旧退出码文案（exit 12/13/14/16）随 W1 的新措辞已过时，但它不在本卡的文件所有权内，留给后续一次单独的文档提交。
- **`docs/reports/cross-machine-host-discovery.md:247` 仍引用旧的 `has no cwd: set a default …` 句子**：同上，
  那是历史报告（记录当时的行为），本卡不改写历史记录。
- **坑 4 的另一半已在同一分支补上**：`index.ts` 三处 schema 描述（`cwd` / `hostCwd`）改成「带 `host` 时是那台机器上的
  目录、不从本机翻译」（提交 `254c788`，另一个 writer 的改动，不属本卡文件所有权）；本报告坑 4 只描述**报错侧**的变化。
- **resume 的两种形状不一样**：`subagent({ action: "resume", name, cwd })` 会把 `cwd`/`hostCwd` 回放给
  解析器（零配置形态因此可恢复）；而「从树里 revive 一个已存在的节点」没有调用方参数，记录里也没存远端目录
  （`ChildRecord` 没有这个字段），所以那条路仍会得到 D2 的提问 —— 这是**下一步**要补的记录字段，本卡不做。
- **两个 launch 构造器**：无快照的静态块仍打 `minimal launch (copy-paste, built from this configuration)`
  （不含 `cwd`，因为它只知道配置）；探测路径打 `launch (copy-paste …)`，带真 `cwd` 与真 `model`。两者措辞
  有意不同：前者是配置的形状，后者是这一次真跑的命令。
- **`<url>` 只在「本机 checkout 也没有 origin」时出现**（两处：父机那行 `git -C <dir> remote add origin <url>  # the url both can reach`，
  以及目标机那行 `hc exec --on <h> -- git -C <cwd> remote add origin <url>`）—— 那种情况下没有任何来源可查。
  只要本机有 origin，目标机那侧的 fix 就用真 url。
- **对抗式 review 的六条修正已落库**：契约 `docs/contracts/first-run-success-v1.md` 的「Amendments」记录了
  A1–A6（read-back 路径也提问 / D5 带 `hostCwd` / 体检的 `enabled:false` 与零机器档 / launch 标签与 model /
  合并的 role JSON 与 `# where:` / 共享 section 门禁 + scoped 包名匹配）。
