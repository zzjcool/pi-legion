# 跨机器 centurion 演示手册（三步）

> 配套契约：`docs/contracts/cross-machine-spawn-v1.md`（D5 交付预检 / D6 文案 / D7 顺序 / D8 doctor）
> 配置键：`subagents.crossMachine`　前置：父机与目标机都能被同一个 `hc` core 看见

这份是**给人照着演示**的三步：把一个 centurion 派到另一台机器上跑，活儿在那里干、交付仍走 git。
它不是测试手册 —— 真机 e2e 的断言在 `docs/runbooks/cross-machine-live-e2e.md`，两者别混用（见最后一节）。

每一步都写了**期望输出**与**失败怎么读**。命令可以逐行照抄，`<host>` 换成 `hc machine ls`
里那个名字（下面统一用 `vps` 举例），`<cwd>` 换成**目标机**上那个 checkout 的绝对路径
（下面统一用 `/srv/app` 举例）。

---

## 0. 准备：一个有 `origin` 的仓库（两侧同一个 url）

### 为什么这是硬约束，不是建议

centurion 的交付单位是 **git worktree**：它在目标机上建一棵树、在那棵树上提交、把分支
`push` 到 `origin`，父机再从**同一个** `origin` `fetch` 回那个 sha。跨机交付只有这一条通道 ——
git remote，远端路径永远不会被翻译成本地路径。所以「父机 checkout 的 origin」与「目标机
checkout 的 origin」必须是**同一个 url**：少了这个共同点，父机拿不到目标机交付的东西，
跨机 centurion 就交付不了。

### 检查（三步，都很快）

| 检查命令 | 期望输出 |
|---|---|
| `git remote get-url origin`（在父机的 checkout 里） | 一个**双方都能访问**的 url，例如 `git@github.com:you/your-repo.git` |
| `hc machine ls` | 列表里有你要用的 `<host>` |
| `hc exec --on <host> -- git -C <cwd> remote get-url origin` | 与上一行**逐字相同**的 url |

### 失败怎么读

| 你看到的字 | 它意味着什么 / 改哪里 |
|---|---|
| 第一行退出 2、stderr 是 `error: No such remote 'origin'` | 父机这个 checkout 没有 origin → 走下面第 1 条出路 |
| 第三行退出 128、stderr 是 `fatal: not a git repository (or any of the parent directories): .git` | 目标机上那个 `<cwd>` 不是 git checkout（或路径不对）→ 先修正 `subagents.crossMachine.hosts.<host>.cwd` |
| 两行的 url 不一样 | 两侧指向了两个 remote → `git remote set-url origin <url>` 改其中一侧 |

### 没有 origin 时的两种出路

1. **加一个，然后重试**：父机 `git remote add origin <url>`；目标机那侧同理，
   `hc exec --on <host> -- git -C <cwd> remote add origin <url>`。
   url 必须是两边都能访问的那一个（同一台机器上加、另一台访问不到，等于没加）。
2. **改派 `worker`**：worker 不建 worktree、不交付分支，**不需要 origin** ——
   `subagent({ agent: "worker", host: "<host>", task: "..." })`。

---

## 1. 配置：`subagents.crossMachine`

最小的一份（`.pi/settings.json` 放在项目里，或 `~/.pi/settings.json` 用户级；
`piLegionRoot` 的取法见下表）：

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

可选：`worktreeRoot` 缺省是 `<dirname(cwd)>/.pi-worktrees` —— 步骤 2 要找的那棵树就在这个位置。

| 键 | 填什么 | **不填会怎样** |
|---|---|---|
| `enabled` | `true`。缺省关闭 | 关了还点名 `host` 会被**拒绝**（不是悄悄在本机跑） |
| `cwd` | 目标机上那个 checkout 的绝对路径 | 缺省会拿**父机**的 cwd 当远端路径 → 那台机器上通常没有这个目录（`host '<h>' has no checkout at <cwd> …`） |
| `node` | 目标机上 node 的**绝对路径** | 远端非交互 shell 没有 nvm、PATH 没初始化 → `host 'vps': node 'node' is not on PATH on vps (set subagents.crossMachine.hosts.vps.node to a path on that machine)`，在 preflight 的 10 秒内就失败 |
| `piCli` | node 能执行的**JS 入口**，形如 `…/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js` | 指到 `/root/.pi/agent/bin/pi` 这种 shell 启动器 → preflight `exit 16`，真机原文是 `SyntaxError: Unexpected token case`（子进程 argv 是 `[node, piCli, …]`，node 把 shell 当 JS 解析） |
| `piLegionRoot` | 本包在**目标机**上的绝对路径 | 两侧 checkout 路径不同（几乎总是）时 → `host 'vps': this package is not installed at /Users/you/code/app on that machine (every child's argv loads /Users/you/code/app/index.ts; set subagents.crossMachine.hosts.vps.piLegionRoot to where it really is, or install it there)` |
| `piExtensions` | **那台机器上**要加载的扩展（数组，绝对路径） | 模型由扩展提供时必填：child 的 argv 带 `--no-extensions`，会把模型提供者一起关掉 → child 报 `No API key found` / `No models available`（当前版本会在 launch 前的探测里就拒绝并点名这个键） |

### 三条前置自检

配好之后先自己问三句，比让 launch 去猜便宜得多：

| 自检命令 | 期望输出 |
|---|---|
| `git remote get-url origin` | 一个 url（与步骤 0 那条**逐字相同**） |
| `hc exec --on <host> -- git --version` | `git version 2.x.y`（有版本号就够；**没有 git = 走不下去**，见失败表） |
| `hc exec --on <host> -- test -f <piLegionRoot>/index.ts` | **无输出、exit 0**（`… && echo ok` 时才会看到 `ok`） |

| 你看到的字 | 它意味着什么 / 改哪个键 |
|---|---|
| 第三条 `exit 1`、无输出 | `piLegionRoot` 指错了（那台机器上没有这个文件）→ 改成目标机上的真实路径 |
| 第二条 `exit 127` / `command not found` | 目标机没有 git → 装上再演示，或改派 `worker` |
| `.pi/settings.json` 里改名后再跑仍是旧的错 | 配置是按 host 名查的：确认 `hc machine ls` 里的名字与 `hosts.<host>` 的键**逐字相同**（大小写也算） |

---

## 2. 一条 `subagent` 调用

在**根会话**里发这一条（`phases` 是 root + centurion 专属参数，在子会话里发会被拒绝）：

```ts
subagent({
  agent: "centurion",
  host: "<host>",
  task: "<one-line goal>",
  phases: [
    { id: "planning", next: [{ to: "implementing" }] },
    { id: "implementing", next: [{ to: "done" }] },
    { id: "done", terminal: true }
  ]
})
```

**关于最后一个阶段**：`{ id: "done", terminal: true }` **省略 `next` 是合法的** ——
这是本次修掉的坑。它和写 `next: []` 完全等价，两种写法都不报错；反过来，写了
`terminal: true` 又给 `next` 声明边才是错（见下面的失败表）。所以上面这份最小机器可以原样粘贴。

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

## 3. 失败了怎么读

跨机链路的每个拒绝都点了名，`grep` 下面这些句子就行。**顺序也重要**：交付预检现在跑在
phases 校验**之前**，所以 host + 坏 phases 同时存在时，你**先**看到的是交付那句 ——
它说的才是真正挡路的机器事实（此前是先报 phases，改完才发现还差一个 origin）。

### 交付：一条共享的 origin

| 你看到的字 | 它意味着什么 / 改哪个键 |
|---|---|
| `cross-machine delivery needs one shared remote: this checkout (<localRepo>) has no origin. Two ways out: 1) add one and retry — git -C <localRepo> remote add origin <url> (the machine '<host>' must be able to reach the same url); 2) drop the worktree delivery — dispatch a worker instead: subagent({ agent: "worker", host: "<host>", task: "..." }) needs no origin.` | **父机这个 checkout 没有 origin**。`1)` 在本机加一个 remote 再重试（那台机器要能访问同一个 url）；`2)` 改派 `worker` —— 上面的 `subagent(...)` 就是可粘贴的形状，worker 不需要 origin |
| `host '<h>': <cwd> has no origin on that machine; cross-machine delivery needs one shared remote. Two ways out: 1) add one there — hc exec --on <h> -- git -C <cwd> remote add origin <url> (same url as this checkout's '<local>'); 2) dispatch a worker instead (workers need no origin).` | **目标机那侧的 checkout 没有 origin**。`1)` 在那台机器上加（用本机那个 url，文案里已给出）；`2)` 改派 `worker` |
| `host '<h>': its checkout at <cwd> has origin '<remote>' but this checkout's is '<local>'; cross-machine delivery needs one shared remote. Two ways out: 1) make both sides point at one url (git remote set-url origin <url> on either side); 2) dispatch a worker instead (workers need no origin).` | **两侧都配了，但不是一个 remote**（文案把两个 url 都点名了）。`1)` 任一侧 `git remote set-url origin <url>` 让两侧一致；`2)` 改派 `worker` |
| `host '<h>': git is not available on that machine (git --version exited <n>: <detail>). A cross-machine centurion delivers through git worktrees, so git must be on PATH there. Two ways out: 1) install git on '<h>' and retry; 2) dispatch a worker instead (workers need no worktree and no git).` | **目标机没有 git**。`1)` 在 `<h>` 上装 git 后重试；`2)` 改派 `worker`（不需要 worktree，也不需要 git）。本机没有 git 时是同族的另一句：`this machine has no usable git (git --version exited <n>: …)…` |
| `host '<h>' has no checkout at <cwd> (the configured cwd does not exist on that machine). Two ways out: 1) give that machine a checkout at <cwd> — git clone <url> <cwd> on '<h>' — or point subagents.crossMachine.hosts.<h>.cwd at a directory that is a git checkout; 2) dispatch a worker instead (workers need no worktree and no git).` | **`cwd` 指错**（那台机器上没有这个目录）。`1)` 给那台机器一个 checkout，或把 `cwd` 指向真的是 git checkout 的目录；`2)` 改派 `worker`。目录存在但不是仓库时是同族的 `host '<h>': <cwd> is not a git repository on that machine.`，末尾是同样的 `Two ways out:` |
| `host '<h>': the delivery preflight could not talk to that machine (…)` | 传输层问题：`hc` 连不上那台机器 → 先手工 `hc exec --on <h> -- true` |

`fail` 出来的都是 `INVALID_PARAMS`，且带 `noModelFallback` —— 机器事实不会去试下一个模型候选，
因为换一台机器/换一个模型重跑同一份预检只会把原因盖掉。

### 机器上的程序（preflight，10 秒内给结论）

| 你看到的字 | 它意味着什么 / 改哪个键 |
|---|---|
| `host '<h>': node 'node' is not on PATH on <h> (set subagents.crossMachine.hosts.<h>.node …)` | 远端非交互 shell 没有 nvm → 把 `node` 设成绝对路径 |
| `piCli '…' is not a JavaScript entry point node can execute.`（preflight exit 16） | `piCli` 指向 shell 启动器 → 改成 `…/dist/bundle/cli.js` |
| `host '<h>': pi CLI 'pi' is not on PATH on <h> (set … .piCli …)` | `piCli` 是裸名字，远端 PATH 里没有 → 给绝对路径 |
| `this package is not installed at … on that machine (… set … .piLegionRoot …)` | `piLegionRoot` 还是父机路径 → 改成目标机上的绝对路径 |
| `timed_out: preflight did not finish within 10s` | 目标机 shell 起不来或极慢 → 手工 `hc exec --on <h> -- true` 计时 |

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
| `[structure] … next must be a list of transition rules (got string)` | `next` 不是数组（注意：**缺省**和 `[]` 都是合法的，只有"存在但类型不对"才报结构错） |

`[structure]` 排在最前是刻意的：形状错了，后面每一条判断都不可靠。

---

## 4. 这与 `cross-machine-live-e2e.md` 的关系

| | 这一份（`cross-machine-centurion-demo.md`） | 那一份（`cross-machine-live-e2e.md`） |
|---|---|---|
| 目的 | **给人做演示**：三步把一个 centurion 派到另一台机器 | S5 真机 e2e：断言协议形状，跑 `test/live/remote-e2e.test.ts` |
| 配置来源 | `subagents.crossMachine`（settings 文件） | `PI_LEGION_REMOTE_*` 环境变量 |
| 会话 | **真实 session**（这样 `hc machine ls` 里才有你注册的机器） | **必须** `HC_SESSION=test-*`（会在那台机器上建/杀终端，绝不能发生在真实命名空间里） |
| 谁来跑 | 你，手敲 | `npm run test:live -- --test-name-pattern='S5\.'` |

**两份不要混用环境变量**：演示时别设 `PI_LEGION_REMOTE_*`，也别设 `HC_SESSION`
（设成 `test-*` 之后你看不到自己的机器注册，命令会以为 `machine_unknown`；
真跑 e2e 时则反过来，必须设，且**必须** `test-` 开头）。
