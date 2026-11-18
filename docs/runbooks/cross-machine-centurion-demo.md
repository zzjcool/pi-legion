# 跨机器 centurion 演示手册（先体检，再三步）

> 交付通道与共享 origin 的冻结语义见 `docs/contracts/cross-machine-spawn-v1.md`（D10 一致 origin、D11 远端建树）；
> 本次修复（缺目录变成提问 / 父机不是仓库有独立答案 / 缺扩展包的错误自带 role JSON / `doctor` 一次体检）见
> `docs/contracts/first-run-success-v1.md`（D1–D12）与 `CHANGELOG.md` 的 `## [Unreleased]`。
> 配置键：`subagents.crossMachine`　前置：①父机与目标机都能被同一个 `hc` core 看见
> ②**pi 本身跑在 hc 终端里**（`HC_TERMINAL_SOCKET` + `HC_TERMINAL_ID`，见第 2 节的「前置自检」）
>
> agent 侧的先验知识在 `skills/pi-legion/SKILL.md` 的 `## Cross-machine dispatch`：同一套 `subagent` 调用只多一个
> `host` 和那台机器上的绝对 `cwd`，目录不知道就问用户（禁止 `ssh`/`hc exec` 试探远端文件系统）。

这份是**给人照着演示**的：第 0 步一条命令体检，过了就只剩三步 —— 一个有 origin 的仓库、
一份（几乎为零的）配置、一条 `subagent` 调用。
它不是测试手册 —— 真机 e2e 的断言在 `docs/runbooks/cross-machine-live-e2e.md`，两者别混用（见最后一节）。

每一步都写了**期望输出**与**失败怎么读**。命令可以逐行照抄，`<host>` 换成 `hc machine ls`
里那个名字（下面统一用 `vps` 举例），`<cwd>` 换成**目标机**上那个 checkout 的绝对路径
（下面统一用 `/srv/app` 举例）。

---

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
  如果连目录都还不知道，它打出的就是那句**提问**（D2），而不是一条带 `<占位符>` 的 launch。

### 期望输出（本机一切正常，只有目标机缺一个包）

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

（这一段取自真机渲染的样例；路径与主机名换成了本文的 `/Users/me/app`、`/srv/app`、`vps`，
`PASS`/`FAIL`/`SKIP` 的措辞与 `fix:` 行原样。）

### 一个 FAIL 长什么样（模型不在这台机器上）

```text
    - FAIL target models: acme/missing-model is not in vps's listing: workbuddy/deepseek-v4.1-flash (the child runs with --no-extensions, so a provider installed there must also be named in hosts.vps.piExtensions)
          fix: use a model that machine serves, e.g. model: "workbuddy/deepseek-v4.1-flash" on the role card
```

`fix:` 行是可以直接粘的**命令**或**配置 JSON**，带的都是这一台机器的真值（唯一例外：本机 checkout
没有 origin 时，那个 url 没人知道，用 `<url>` 明示）。多行通常意味着「二选一或按顺序做」：缺包时的
`pi install` 与 `excludeExtensions` JSON 就是二选一（JSON 会合并成一条，多个角色不会互相覆盖），
后面的 `# where:` 说明那份 JSON 写进哪个文件。

### 连目录都没有时：它提问，不猜

没写 `hosts.<host>.cwd`、调用里也没给 `cwd` 时，`target checkout` 那一行就是 D2 的那句提问，
后面四项变成 `SKIP`（先修上面那条 FAIL，再跑同一条命令）：

```text
  - vps:
    - FAIL target checkout: host 'vps' needs a directory on that machine, and this call did not name one — which directory should the child work in? Pass it with the call: subagent({ agent: "centurion", host: "vps", cwd: "/abs/path/on/vps", task: "..." }) (that path is read ON vps; it is never translated from here). If this conversation has not named a directory on vps, ask the user which one to use. Do not ssh or run `hc exec` to browse that machine — a guess here becomes a child in the wrong tree.
    - SKIP target origin: target origin not checked: no directory on vps yet — the FAIL above says how to pass it
    - SKIP target runtime: target runtime not checked: no directory on vps yet — the FAIL above says how to pass it
```

这条 FAIL 的下一步就是**问一句**：那台机器上哪个目录（或者粘 `fix:` 里那条带 `cwd` 的调用）。
不要用 `ssh` / `hc exec` 去那台机器上翻目录 —— 猜出来的目录会让孩子在错误的树里干活。

### PASS / FAIL 怎么读 → 下一步

| 你看到的那一行 | 它意味着什么 | 下一步 |
|---|---|---|
| `PASS parent checkout: <dir> is a git checkout; origin <url>` | 本会话目录是 checkout，origin 已打印 | 不用动；目标机那侧归一化后必须是同一个 url（第 1 节） |
| `FAIL parent checkout: cross-machine delivery needs a git checkout on this machine too, and this session's directory (<dir>) is not one. …` | 本会话目录**根本不是 git 仓库**（D5） | 粘它下面的 `fix:` 行（在 checkout 里重开 pi，或传相对 `cwd`），或照原话第 2 条改派 `worker` —— **不要**在这里 `git remote add` |
| `FAIL parent checkout: <dir> is a git checkout but has no origin` | 是仓库但没有 origin | 粘 `fix: git -C <dir> remote add origin <url>` |
| `PASS hc machines: <names>` / `FAIL hc machines: … unknown to hc: <h>` | `hc machine ls` 的答案 | FAIL 粘 `fix: hc machine add --name <h> ssh://user@<h>`；注意清单按 `HC_SESSION` 走（见第 5 节） |
| `FAIL target checkout: host '<h>' needs a directory on that machine …` | 没给目标机目录（D2 提问） | 粘它的 `fix:` 行（带 `cwd` 的调用），或问用户那台机器上是哪个目录 |
| `FAIL target checkout: <cwd> does not exist on <h>` | 目录在那台机器上不存在 | 粘 `fix:` 的 `hc exec --on <h> -- ls -d <cwd>`，或把那两行里的 `cwd` 改成真实路径 |
| `FAIL target origin: …` | 那侧不是仓库 / 没有 origin / url 与这侧不同（原话把两个 url 都点名） | 粘 `fix:` 里的 `hc exec --on <h> -- git …` 那一行 |
| `PASS target runtime: <node> vX and <cli.js> Y — the paths the child will use there` | 远端 `node` 与 `pi` 的真实路径与版本（就是 child 会用的那两个） | 不用动 |
| `FAIL target runtime: …` | 目标机缺 node / 缺 pi / 这个包不在那儿 / `piCli` 是 shell 启动器 | 粘 `fix:`：装 node、`pi install npm:pi-legion`、或把 `piCli` 指到 `…/dist/bundle/cli.js` |
| `FAIL inherited extensions: N package(s) missing on <h>: <pkg> (role '<role>')` | 继承来的包在那台机器上没装（D4） | `fix:` 任选一条：`hc exec --on <h> -- pi install npm:<pkg>`，或那条 `excludeExtensions` 的 settings JSON（`# where:` 说了写进哪个文件） |
| `FAIL target models: <model> is not in <h>'s listing: …` | 那台机器的 `pi --list-models` 里没有这个模型（行尾同时说明 `--no-extensions` 与 `piExtensions` 的关系） | 粘 `fix:`：换成它列出来的模型；如果模型本来就该由 provider 扩展提供，把它写进 `subagents.crossMachine.hosts.<h>.piExtensions` |
| `FAIL hc machines: no machines are registered …` | 这个 hc core 一台机器都不认识，配置里也没有 host | 粘 `fix: hc machine add --name my-vps ssh://user@my-vps`，再 `hc machine ls` |
| `FAIL hc machines: cross-machine launch is disabled (enabled = false), so nothing here was probed` | `subagents.crossMachine.enabled` 是 `false`（真 launch 会被拒） | 按 `fix:` 把它改成 `true`（同一个 settings 文件），再跑同一条命令 |
| `SKIP hc machines: … cross-machine is not configured, so no target was probed` | `enabled` 没写、也没有 `hosts` 条目：注册表照打，但不去探目标机 | 想体检某一台就配 `{ "enabled": true }` 再跑 `/legion doctor crossmachine` |
| `SKIP <项>: … not checked: <一句原因>` | 前面那条 FAIL 让这一项没法问（例如还没有目录） | 先修上面那条 FAIL，再跑同一条命令 |

### 手工兜底：三条命令（doctor 不方便跑时）

| 检查命令 | 期望输出 |
|---|---|
| `git remote get-url origin`（在父机的 checkout 里） | 一个**双方都能访问**的 url，例如 `git@github.com:you/your-repo.git` |
| `hc machine ls` | 列表里有你要用的 `<host>` |
| `hc exec --on <host> -- git -C <cwd> remote get-url origin` | 与上一行**归一化后相同**的 url（`git@host:path` 与 `ssh://git@host/path` 视为同一个） |

这三条就是 doctor 那三行（`parent checkout` / `hc machines` / `target origin`）的手工版本。
它们的失败读法见下面第 1 节与第 4 节。

---

## 1. 准备：一个有 `origin` 的仓库（两侧同一个 url）

### 为什么这是硬约束，不是建议

centurion 的交付单位是 **git worktree**：它在目标机上建一棵树、在那棵树上提交、把分支
`push` 到 `origin`，父机再从**同一个** `origin` `fetch` 回那个 sha。跨机交付只有这一条通道 ——
git remote，远端路径永远不会被翻译成本地路径。所以「父机 checkout 的 origin」与「目标机
checkout 的 origin」必须是**同一个 url**：少了这个共同点，父机拿不到目标机交付的东西，
跨机 centurion 就交付不了。**「同一个」是归一化后相同，不是逐字相同** ——
`normalizeGitRemoteUrl` 把 `git@host:path` 与 `ssh://git@host/path` 归一成同一个，
scheme、用户名、末尾斜杠、末尾 `.git` 都不计。

### 失败怎么读

| 你看到的字 | 它意味着什么 / 改哪里 |
|---|---|
| 第一行退出 2、stderr 是 `error: No such remote 'origin'` | 父机这个 checkout 没有 origin → 走下面第 1 条出路 |
| 第三行退出 128、stderr 是 `fatal: not a git repository (or any of the parent directories): .git` | 目标机上那个 `<cwd>` 不是 git checkout（或路径不对）→ 先修正 `subagents.crossMachine.hosts.<host>.cwd`（或调用里的 `cwd`） |
| 两行的 url 归一化后仍不一样 | 两侧指向了两个不同 remote → `git remote set-url origin <url>` 改其中一侧 |

### 没有 origin 时的两种出路

1. **加一个，然后重试**：父机 `git remote add origin <url>`；目标机那侧同理，
   `hc exec --on <host> -- git -C <cwd> remote add origin <url>`。
   url 必须是两边都能访问的那一个（同一台机器上加、另一台访问不到，等于没加）。
2. **改派 `worker`**：worker 不建 worktree、不交付分支，**不需要 origin** ——
   `subagent({ agent: "worker", host: "<host>", task: "..." })`。

> 本会话目录连仓库都不是时，这两个出路都不适用（没有地方 `git remote add`）：那是另一句答案，
> 见第 4 节的「交付：一条共享的 origin」。

---

## 2. 配置：`subagents.crossMachine`

**唯一必须由你给的输入，是那台机器上的一个目录。** 其它（`node`、`pi` 的 JS 入口、本包在那台机器上的根、
继承来的扩展）都由**一次**发现探测填好；机器本身只要在 `hc machine ls` 里就算「可以用」。

### 最小配置（推荐）

```json
{ "subagents": { "crossMachine": { "enabled": true } } }
```

`hosts` 块**可以不写**。目录按次给：

```ts
subagent({ agent: "centurion", host: "vps", cwd: "/srv/app", task: "..." })
```

不想到处写 `cwd` 就把它写成一个只带 `cwd` 的 entry（同样推荐）：

```json
{
  "subagents": {
    "crossMachine": {
      "enabled": true,
      "hosts": { "vps": { "cwd": "/srv/app" } }
    }
  }
}
```

`cwd` 必须是**那台机器上的绝对路径**（远端路径不会被翻译）。既没有 entry 默认值、调用里也没给 →
工具**提问**（D2），不会猜 HOME，也不会回落到父机 cwd。

### 配置文件放哪：只有两个位置

| 位置 | 说明 |
|---|---|
| `~/.pi/agent/settings.json` | **用户级**。代码读的是 `getAgentDir()/settings.json`，注意**不是** `~/.pi/settings.json` —— 写在后者不会报错，只是**永远读不到** |
| `<项目>/.pi/settings.json` | **项目级**，**覆盖**用户级：同名块整块替换（`subagents.crossMachine` 不做深合并），项目里配了就只用项目的那一份 |

### 可选：把发现回答不了的字段写死

只有「那台机器上发现探测也答不出来」时才需要写这些。写全了的旧配置**零探测**、逐字段不变。

```json
{
  "subagents": {
    "crossMachine": {
      "enabled": true,
      "hosts": {
        "<host>": {
          "cwd": "/<abs>/on/<host>",
          "node": "/<abs>/node",
          "piCli": "/<abs>/bundle/cli.js",
          "piLegionRoot": "/<abs>/package",
          "piExtensions": ["/<abs>/extensions/index.ts"]
        }
      }
    }
  }
}
```

可选：`worktreeRoot` 缺省是 `<dirname(cwd)>/.pi-worktrees` —— 第 3 节要找的那棵树就在这个位置。

| 键 | 填什么 | **不填会怎样** |
|---|---|---|
| `enabled` | `true`。缺省关闭 | 关了还点名 `host` 会被**拒绝**（不是悄悄在本机跑）：`host '<h>' needs subagents.crossMachine.enabled = true` |
| `cwd` | 目标机上那个 checkout 的绝对路径（entry 里是默认值，调用里可覆盖） | **不填（或为空）→ 提问**：`host '<h>' needs a directory on that machine, and this call did not name one — which directory should the child work in? …`（四句话，带可粘贴的调用与「别 ssh 去翻目录」；没有「回落到父机 cwd」这回事）；填了**相对**路径 → `host '<h>' needs an absolute cwd in subagents.crossMachine.hosts.<h>.cwd (remote paths are not translated from this machine)`（按次覆盖给相对路径是另一句：`host '<h>': the per-call cwd override must be an absolute path on that machine (got '…'); remote paths are not translated from this machine`）；路径填了但那个目录在那台机器上不存在 → 预检报 `host '<h>' has no checkout at <cwd> (the configured cwd does not exist on that machine). …` |
| `node` | 目标机上 node 的**绝对路径** | **不填 → 由发现探测填**（解析到真实二进制，不是 mise/asdf shim）；探测也答不出来（远端非交互 shell 没有 nvm、PATH 没初始化）→ `host '<h>': node 'node' is not on PATH on <h> — install node there, then retry. If it is installed but off that core's PATH, name it once in subagents.crossMachine.hosts.<h>.node.`（exit 12，10 秒内给结论） |
| `piCli` | node 能执行的**JS 入口**，形如 `…/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js` | **不填 → 由发现探测填**（launcher 背后的 JS 入口，用 `--version` 验证）；指到 `/root/.pi/agent/bin/pi` 这种 shell 启动器 → `host '<h>': point piCli at the JS entry node can execute, e.g. …/dist/bundle/cli.js. piCli '<path>' is not a JavaScript entry point node can execute …`（exit 16；子进程 argv 是 `[node, piCli, …]`，node 把 shell 当 JS 解析） |
| `piLegionRoot` | 本包在**目标机**上的绝对路径 | **不填 → 由发现探测填**；那台机器上没有这个包 → `host '<h>': this package is not installed at <path> on that machine — install this package there, then retry: hc exec --on <h> -- pi install npm:pi-legion …`（exit 14；已装在别处就把那个根写进这个键） |
| `piExtensions` | **那台机器上**要加载的扩展（数组，绝对路径）；显式写 `[]` = 这台机器不加载任何 provider 扩展 | **不填 → 用探测到的 provider 扩展**。写了的路径在那台机器上不存在 → `host '<h>': piExtensions entry '<path>' does not exist on that machine …`（exit 17）；模型由扩展提供而那台机器的 `pi` 看不到它 → child 报 `No API key found` / `No models available`（doctor 的 `target models` 那行会先告诉你，并给出这个键的 `fix:`） |

### 前置自检：三句命令 + 一个环境前提

配好之后先自己问三句，比让 launch 去猜便宜得多（doctor 已经把这三句做完了，见第 0 步）：

| 自检命令 | 期望输出 |
|---|---|
| `git remote get-url origin` | 一个 url（与第 1 节那条**归一化后相同**） |
| `hc exec --on <host> -- git --version` | `git version 2.x.y`（有版本号就够；**没有 git = 走不下去**，见失败表） |
| `hc exec --on <host> -- test -f <piLegionRoot>/index.ts` | **无输出、exit 0**（`… && echo ok` 时才会看到 `ok`）。`piLegionRoot` 由发现填，不确定就先跑 `/legion doctor crossmachine` 看它打印的那条路径 |

第四条不在远端，在**本机**：`host` 只能在 **hc 终端里**用。在你要发 launch 的那个终端里跑：

```bash
env | grep HC_TERMINAL_
```

要打出两行 `HC_TERMINAL_SOCKET=…` 与 `HC_TERMINAL_ID=…`。`terminalHostAvailable` 要求两者都在；
缺任一条，任何带 `host` 的 launch 都会被拒绝（原文，见下面失败表）：

```text
host '<h>' needs an hc terminal host: start pi inside an hc terminal (HC_TERMINAL_SOCKET + HC_TERMINAL_ID), or drop host
```

改法是在 hc 终端里重开 pi；不想跨机就去掉 `host`。

| 你看到的字 | 它意味着什么 / 改哪个键 |
|---|---|
| 第三条 `exit 1`、无输出 | `piLegionRoot` 指错了（那台机器上没有这个文件）→ 删掉这个键让发现填，或写成目标机上的真实路径 |
| 第二条 `exit 127` / `command not found` | 目标机没有 git → 装上再演示，或改派 `worker` |
| `host '<h>' needs an hc terminal host: start pi inside an hc terminal (HC_TERMINAL_SOCKET + HC_TERMINAL_ID), or drop host` | 这个 pi 不在 hc 终端里 → 在 hc 终端里重开 pi（`env \| grep HC_TERMINAL_` 应有两条），或去掉调用里的 `host` |
| `host '<h>' is not a machine this hc core knows (…)` | 这个名字不在 `hc machine ls` 里 → 先 `hc machine add --name <h> ssh://user@that-machine`（原话里就带这条命令与它认识的机器名） |
| `host '<h>': register the machine, then retry — hc machine add --name <h> ssh://user@that-machine. …` | 这个名字既不在 `hc machine ls`（`machine list` 没答）、也不在 `subagents.crossMachine.hosts` 里 → 按原话注册，或给它写一个 `{ "cwd": "/abs/path/on/<h>" }` 的 entry |
| `host '<h>' needs a directory on that machine, and this call did not name one …` | 缺目标机目录（D2）→ 按次传 `cwd`，或问用户那台机器上是哪个目录；这是**提问**，不是配置课 |

---

## 3. 一条 `subagent` 调用

在**根会话**里发这一条（`phases` 是 root + centurion 专属参数，在子会话里发会被拒绝）：

```ts
subagent({
  agent: "centurion",
  host: "<host>",
  cwd: "<abs path on that host>",   // hosts.<host>.cwd 写了就可以省略
  task: "<one-line goal>",
  phases: [
    { id: "planning", next: [{ to: "implementing" }] },
    { id: "implementing", next: [{ to: "done" }] },
    { id: "done", terminal: true }
  ]
})
```

**关于最后一个阶段**：`{ id: "done", terminal: true }` **省略 `next` 是合法的** ——
它和写 `next: []` 完全等价，两种写法都不报错；反过来，写了
`terminal: true` 又给 `next` 声明边才是错（见下面的失败表）。所以上面这份最小机器可以原样粘贴。

`cwd`（或 `hostCwd`）是**目标机上的**绝对路径；`hostCwd` 是同一件事的另一个参数名，
两者给一个就够，不要指望它会被翻译成本机路径。

### 期望返回

```
▶ <name> (centurion) supervisor=terminal
```

`<name>` 是 handle 名（`centurion-0` 之类），`supervisor=terminal` 说明它真的被交给了
远端终端后端，而不是悄悄在本机起了一个。物证在下一小节 —— 树建在哪台机器上，活儿就在哪台机器上。

### 怎么确认它真的在目标机上

```bash
hc exec --on <host> -- git -C <cwd> worktree list
```

期望在那份列表里看到一棵**兄弟目录**树：

```
<cwd>            <sha> [<branch>]
<dirname(cwd)>/.pi-worktrees/<name>  <sha> [pi-subagent/<host>/<name>-<hex8>]
```

（`cwd=/srv/app` → `/srv/.pi-worktrees/<name>`。）树在目标机上，就是"活儿在那里干"的物证；
父机 `git worktree list` 里**不该**出现它。

| 你看到的字 | 它意味着什么 / 改哪个键 |
|---|---|
| 列表里只有 `<cwd>` 一行 | 树没建成（launch 失败在最前面了）→ 看此时返回的那句拒绝文案 |
| 父机 `git worktree list` 里也出现了它 | 那是本机 launch，`host` 没生效 → 确认 settings 里 `enabled: true` 且 host 名逐字对 |

---

## 4. 失败了怎么读

跨机链路的每个拒绝都点了名，`grep` 下面这些句子就行。**顺序也重要**：交付预检现在跑在
phases 校验**之前**，所以 host + 坏 phases 同时存在时，你**先**看到的是交付那句 ——
它说的才是真正挡路的机器事实（此前是先报 phases，改完才发现还差一个 origin）。

### 目录与准入

| 你看到的字 | 它意味着什么 / 下一步 |
|---|---|
| `host '<h>' needs a directory on that machine, and this call did not name one — which directory should the child work in? Pass it with the call: subagent({ agent: "centurion", host: "<h>", cwd: "/abs/path/on/<h>", task: "..." }) (that path is read ON <h>; it is never translated from here). If this conversation has not named a directory on <h>, ask the user which one to use. Do not ssh or run `hc exec` to browse that machine — a guess here becomes a child in the wrong tree.` | **缺目标机目录**（D2）。它是提问：把那句 `subagent(...)` 里的 `cwd` 换成真路径照发，或在会话里问用户。发出这句时**一次远端探测都没跑**（`machine.list` 除外），所以它比任何「先试试」都便宜 |
| `host '<h>' is not a machine this hc core knows (`hc machine ls` here lists: …). Register it first:` + `hc machine add --name <h> ssh://user@that-machine` | 这个名字不在**这个 `HC_SESSION`** 的机器清单里 → 照原话注册，或改用清单里的名字（清单是按会话的，见第 5 节） |
| `host '<h>': register the machine, then retry — hc machine add --name <h> ssh://user@that-machine. Nothing has confirmed it exists yet: …` | `machine list` 没答、settings 里也没有这台机器 → 注册它，或给它写 `{ "cwd": … }` 的 entry |
| `host '<h>' needs subagents.crossMachine.enabled = true` | 配置里 `enabled` 不是 `true`（写了 `false` 或没写）→ 打开它 |
| `host '<h>' needs an hc terminal host: start pi inside an hc terminal (HC_TERMINAL_SOCKET + HC_TERMINAL_ID), or drop host` | 这个 pi 不在 hc 终端里 → 在 hc 终端里重开 pi，或去掉 `host` |

### 交付：一条共享的 origin

| 你看到的字 | 它意味着什么 / 改哪个键 |
|---|---|
| `cross-machine delivery needs a git checkout on this machine too, and this session's directory (<dir>) is not one. Two ways out: 1) run the launch from a checkout — start pi inside yours, or pass a relative cwd that points at one (with `host` named, an ABSOLUTE cwd is the directory ON that machine): subagent({ agent: "centurion", host: "<h>", cwd: "../my-repo", task: "..." }); 2) dispatch a worker instead — subagent({ agent: "worker", host: "<h>", task: "..." }) needs no checkout and no origin.` | **本会话目录根本不是 git 仓库**（D5）。`1)` 在 checkout 里重开 pi，或用**相对** `cwd` 指向一个 checkout（带了 `host` 时，绝对 `cwd` 指的是**那台机器**上的目录，所以这里要用相对路径）；`2)` 改派 `worker`（不需要 checkout、不需要 origin）。**不要**在这个目录里 `git remote add` —— 那不是仓库，没有地方加。注意这条只说「父机这一侧」：目标机上的目录仍然要有（`hosts.<h>.cwd`，或调用里再给一个绝对 `cwd`；都没有就会收到 D2 的那句提问） |
| `cross-machine delivery needs one shared remote: this checkout (<localRepo>) has no origin. Two ways out: 1) add one and retry — git -C <localRepo> remote add origin <url> (the machine '<host>' must be able to reach the same url); 2) drop the worktree delivery — dispatch a worker instead: subagent({ agent: "worker", host: "<host>", task: "..." }) needs no origin.` | **父机这个 checkout 没有 origin**。`1)` 在本机加一个 remote 再重试（那台机器要能访问同一个 url）；`2)` 改派 `worker` |
| `host '<h>': <cwd> has no origin on that machine; cross-machine delivery needs one shared remote. Two ways out: 1) add one there — hc exec --on <h> -- git -C <cwd> remote add origin <url> (same url as this checkout's '<local>'); 2) dispatch a worker instead (workers need no origin).` | **目标机那侧的 checkout 没有 origin**。`1)` 在那台机器上加（用本机那个 url，文案里已给出）；`2)` 改派 `worker` |
| `host '<h>': its checkout at <cwd> has origin '<remote>' but this checkout's is '<local>'; cross-machine delivery needs one shared remote. Two ways out: 1) make both sides point at one url (git remote set-url origin <url> on either side); 2) dispatch a worker instead (workers need no origin).` | **两侧都配了，但不是一个 remote**（文案把两个 url 都点名了）。`1)` 任一侧 `git remote set-url origin <url>` 让两侧一致；`2)` 改派 `worker` |
| `host '<h>': git is not available on that machine (git --version exited <n>: <detail>). A cross-machine centurion delivers through git worktrees, so git must be on PATH there. Two ways out: 1) install git on '<h>' and retry; 2) dispatch a worker instead (workers need no worktree and no git).` | **目标机没有 git**。`1)` 在 `<h>` 上装 git 后重试；`2)` 改派 `worker`。本机没有 git 时是同族的另一句：`this machine has no usable git (git --version exited <n>: …)…` |
| `host '<h>' has no checkout at <cwd> (the configured cwd does not exist on that machine). Two ways out: 1) give that machine a checkout at <cwd> — git clone <url> <cwd> on '<h>' — or point subagents.crossMachine.hosts.<h>.cwd at a directory that is a git checkout; 2) dispatch a worker instead (workers need no worktree and no git).` | **`cwd` 指错**（那台机器上没有这个目录）。`1)` 给那台机器一个 checkout，或把 `cwd` 指向真的是 git checkout 的目录；`2)` 改派 `worker`。目录存在但不是仓库时是同族的 `host '<h>': <cwd> is not a git repository on that machine.`，末尾是同样的 `Two ways out:` |
| `host '<h>': the delivery preflight could not talk to that machine (…)` | 传输层问题：`hc` 连不上那台机器 → 先手工 `hc exec --on <h> -- true` |

`fail` 出来的都是 `INVALID_PARAMS`，且带 `noModelFallback` —— 机器事实不会去试下一个模型候选，
因为换一台机器/换一个模型重跑同一份预检只会把原因盖掉。

### 机器上的程序（preflight，10 秒内给结论）

| 你看到的字 | 它意味着什么 / 改哪个键 |
|---|---|
| `host '<h>': node 'node' is not on PATH on <h> — install node there, then retry. If it is installed but off that core's PATH, name it once in subagents.crossMachine.hosts.<h>.node.` | 远端非交互 shell 没有 nvm → **先在那台机器上装 node**；已经装了但不在那个 core 的 PATH 里，再把这个键写成绝对路径 |
| `host '<h>': point piCli at the JS entry node can execute, e.g. /root/.pi/agent/npm/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js. piCli '<path>' is not a JavaScript entry point node can execute: …`（exit 16） | `piCli` 指向 shell 启动器 → 换成 `…/dist/bundle/cli.js`（`piCli` 由发现填时不会出这一句，只有你手写过它才会） |
| `host '<h>': pi CLI 'pi' is not on PATH on <h> — install pi there, then retry (and put this package on that machine too: hc exec --on <h> -- pi install npm:pi-legion, same entry names are then mapped automatically). Only if an existing CLI is off that core's PATH, name it in subagents.crossMachine.hosts.<h>.piCli.` | 目标机没有 pi → 先装 pi；顺手把本包也装上（原话给了那条命令） |
| `host '<h>': this package is not installed at <path> on that machine — install this package there, then retry: hc exec --on <h> -- pi install npm:pi-legion (every child's argv loads <path>/index.ts). If it is already installed somewhere else on that machine, put that root in subagents.crossMachine.hosts.<h>.piLegionRoot.` | 本包不在那个路径 → 装上；已经装在别处就把那个根写进 `piLegionRoot` |
| `host '<h>': piExtensions entry '<path>' does not exist on that machine …`（exit 17） | 显式写的 `piExtensions` 里有一条在那台机器上不存在 → 删掉这个键让发现填，或写成那台机器上的真实路径 |
| `host '<h>': the hc core there already carries legion identity (PI_LEGION_DB / PI_LEGION_NODE_ID), …`（exit 15） | 那台机器上的 hc core 带着 legion 身份 → 不带这两个变量重开那个 core，或改在本机 launch |
| `host '<h>' unreachable: timed_out: preflight did not finish within 10s (…)` | 目标机 shell 起不来或极慢 → 手工 `hc exec --on <h> -- true` 计时 |

### 继承的扩展包：包不在那台机器上（D4）

| 你看到的字 | 它意味着什么 / 改哪个键 |
|---|---|
| `host '<h>': the extension '<父机路径>' belongs to package '<pkg>', which is not installed on that machine (the launch would have silently dropped it). Two ways out: 1) install it there — hc exec --on <h> -- pi install npm:<pkg> (same entry names are then mapped automatically); 2) keep it on this machine only, for role '<role>': subagents.agentOverrides.<role>.excludeExtensions — {"subagents":{"agentOverrides":{"<role>":{"excludeExtensions":["<pkg>"]}}}}` | 继承来的扩展所属的包在那台机器上没装。`1)` 在那台机器上装这个包（入口名相同就自动重锚）；`2)` 只让**这个角色**不继承它 —— 照抄原话里那条 settings JSON（`<role>` 已经是具体角色名，不是占位符）。不知道角色时（resume / 读回）这一句是 `for the role you launch: subagents.agentOverrides.<role>.excludeExtensions`，不带 JSON |
| `host '<h>': package '<pkg>' IS installed there at <dir>, but it does not expose './<相对入口>' (declared: …); …` | 包在，但声明的入口不同（版本/布局不同）→ 原话列出它实际声明的入口；要么在父机不继承这个扩展，要么在 `subagents.crossMachine.hosts.<h>.pathMap` 里加显式前缀 |

### phases：一次报全部，并按分类点名

首行永远是这句，后面按固定顺序 `structure` → `terminal` → `successor` → `unreachable` → `rework`
分组，每条问题下一行是 `    fix: …`（4 空格缩进）：

```
Agent '<file>' has an invalid phase machine: N problems in M categories.
```

| 你看到的字 | 它意味着什么 / 改哪个键 |
|---|---|
| `[terminal] … terminal phase '<id>' must not declare transitions` | 写了 `terminal: true` 又给 `next` 声明了边。`fix` 给两条：留 `terminal: true` 并删掉 `next`（terminal **可以省略** `next`），或去掉 `terminal: true` 让流程继续 |
| `[terminal] … phase '<id>' is not terminal and declares no transitions` | 既不是 terminal、又没有任何边 → 走不下去了。`fix`：加一条边，或标 `terminal: true` |
| `[successor] … phase '<id>' lists itself as a successor` | 自指边（`to` 等于自己）。`fix` 给出把那条边指向别的阶段的最小示例 |
| `[successor] … unknown target phase '<x>' from phase '<id>'` | 边指向了没声明的阶段。`fix` 会列出**已声明**的阶段，或给你一个声明它的最小写法 |
| `[unreachable] …` | 声明的阶段从 `start` 走不到，或整张图到不了任何 terminal |
| `[structure] … next must be a list of transition rules (got a string ("done"))` | `next` 不是数组（原话里的 `"done"` 就是你写的那个值，例如 `next: "done"`；注意：**缺省**和 `[]` 都是合法的，只有"存在但类型不对"才报结构错） |

`[structure]` 排在最前是刻意的：形状错了，后面每一条判断都不可靠。

---

## 5. 这与 `cross-machine-live-e2e.md` 的关系

| | 这一份（`cross-machine-centurion-demo.md`） | 那一份（`cross-machine-live-e2e.md`） |
|---|---|---|
| 目的 | **给人做演示**：先一条命令体检，再三步把一个 centurion 派到另一台机器 | S5 真机 e2e：断言协议形状，跑 `test/live/remote-e2e.test.ts` |
| 配置来源 | `subagents.crossMachine`（settings 文件），或零配置 + 按次 `cwd` | `PI_LEGION_REMOTE_*` 环境变量 |
| 会话 | **真实 session**（这样 `hc machine ls` 里才有你注册的机器） | **必须** `HC_SESSION=test-*`（会在那台机器上建/杀终端，绝不能发生在真实命名空间里） |
| 谁来跑 | 你，手敲 | `npm run test:live -- --test-name-pattern='S5\.'` |

**两份不要混用环境变量**：演示时别设 `PI_LEGION_REMOTE_*`，也别设 `HC_SESSION`
（设成 `test-*` 之后你看不到自己的机器注册，命令会以为 `machine_unknown`；
真跑 e2e 时则反过来，必须设，且**必须** `test-` 开头）。
