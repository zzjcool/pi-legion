# 跨机器 e2e 执行手册（S5）

> 配套测试：`test/live/remote-e2e.test.ts`　契约：`docs/contracts/cross-machine-spawn-v1.md`
> 这份手册的命令可以逐行照抄。每一步都写了**期望输出**和**失败时怎么读**。

这不是「再跑一遍单测」。仓库里其他所有跨机测试都跑在 `test/helpers/fake-hc-core.mjs` 上
（同一个进程、同一台机器，只是被脚本说成两台）；它们能证明协议形状，不能证明真 `hc` 会把
`on` 送到另一台机器、远端 shell 真的在正确的目录里起来、从那台机器 push 的东西这边真的能
fetch 到。这一份只问真机器。

---

## 0. 它到底需要什么

### 父机（你敲命令的这一台）

| 前置 | 检查命令 | 期望 |
|---|---|---|
| `hc` core 在跑，且已注册目标机 | `hc machine ls` | 列表里有 `<HOST>`（下面用 `vps` 举例） |
| 本仓库在同一分支/同一提交 | `git -C <repo> rev-parse HEAD` | 一个 40 位 sha |
| 本仓库有 origin | `git -C <repo> remote get-url origin` | 一个双方都能访问的 URL |
| `hc` 可执行文件在 PATH（或给了 `HC_BIN`） | `hc --version` | 版本号 |

### 目标机（真跑的那台）

| 前置 | 怎么确认 | 不满足时的症状 |
|---|---|---|
| 同一仓库的 checkout，**同一提交** | `hc exec --on vps -- git -C /srv/app rev-parse HEAD` | S5.1 的 HEAD 断言不过；S5.5 的 worktree 会从旧提交起 |
| 同一个 origin URL | `hc exec --on vps -- git -C /srv/app remote get-url origin` | 启动前就会拒绝（`its checkout ... has origin 'x' but this checkout's is 'y'`） |
| `git` 可用 | `hc exec --on vps -- git --version` | S5.1 的 `--is-inside-work-tree` 拿不到 true |
| `node` 在 PATH（或给绝对路径） | `hc exec --on vps -- sh -c 'command -v node'` | preflight exit 12（10 秒内） |
| **`piCli` 必须是 node 能执行的 JS 入口**，不是 shell 启动器 | `hc exec --on vps -- /root/.nvm/.../node /root/.pi/.../dist/bundle/cli.js --version` | 给 `/root/.pi/agent/bin/pi` 这种启动器 → preflight exit 16（10 秒内）。正确形态：`…/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js` |
| 本包已装在目标机（`piLegionRoot`） | `hc exec --on vps -- test -f /srv/app/index.ts && echo ok` | preflight exit 14（10 秒内），文案点名 `piLegionRoot` |
| **两侧 checkout 路径不同**（几乎总是如此） | 父机 `pwd` vs `PI_LEGION_REMOTE_CWD` | 若不同：**必须**设 `PI_LEGION_REMOTE_PI_LEGION_ROOT` = 目标机上本包的绝对路径。不设就会被 exit 14 拦住（实测：父机 Mac `/Users/zheng/code/pi-legion`，目标机 `/root/code/pi-legion`） |
| **push 凭据**（S5.5 需要） | `hc exec --on vps -- git -C /srv/app ls-remote origin` | S5.5 在 `git push` 那步失败，stderr 是认证错 |
| **模型凭据**（S5.6 需要） | `hc exec --on vps -- pi -p 'say ok'` 之类 | S5.6 起得来但永远不写 session，最终超时 |
| 该 core **不带** legion identity | `hc exec --on vps -- sh -c 'echo ${PI_LEGION_DB-}'` | 启动被拒（D7，exit 15）——这是刻意的 |

> `PI_LEGION_REMOTE_ORIGIN` 指**目标机上那个 bare 仓库的绝对路径**（或双方都可访问的 URL）。
> S5.5 会在父机一侧 clone 它，再从那台机器 push 回它，避免污染你正在用的 checkout。

---

## 1. 一次性环境

> **先在这个 session 里注册机器。** `HC_SESSION` 隔离的不只是终端命名空间，**`hc machine`
> 的注册也是按 session 的**：父机 `hc machine ls` 里看得到的 host，在这个 `test-*` session 里
> 是**看不到**的，所有用例都会报 `machine_unknown`。必须先在同一个 session 里注册：
>
> ```bash
> export HC_SESSION=test-cross-machine-$$
> hc machine add --temp --name vps ssh://user@host-workspace
> hc machine ls                       # 必须在列表里看到 vps，再往下走
> ```
>
> `--temp` 表示随 session 结束而消失，不会污染长期注册表。

```bash
# 目标机的 hc 名字（hc machine ls 里的那个）
export PI_LEGION_REMOTE_HOST=vps
# 目标机上这个仓库的绝对路径
export PI_LEGION_REMOTE_CWD=/srv/app
# 可选：双方都可达的 bare 仓库（S5.5 用）。不设 → S5.5 跳过
export PI_LEGION_REMOTE_ORIGIN=/srv/git/pi-legion.git
# 目标机上的程序：**给绝对路径**。远端非交互 shell 没有 nvm/PATH 初始化，
# 用默认的 "node"/"pi" 会在 10 秒内报 node 'node' is not on PATH on <host>。
export PI_LEGION_REMOTE_NODE=/root/.nvm/versions/node/v24.13.1/bin/node
export PI_LEGION_REMOTE_PI=/root/.pi/agent/bin/pi
# 本包在目标机上的位置（与父机路径不同时必须给）
export PI_LEGION_REMOTE_PI_LEGION_ROOT=/root/code/pi-legion
# 远端 child 要加载的扩展（逗号分隔，允许空白）。**模型来自扩展时必填**：
# child 的 argv 带 --no-extensions，在那样的机器上会把模型提供者一起关掉；
# 不填会在 launch 前被探测拒绝（`No models available`），这是期望行为，不是 bug。
export PI_LEGION_REMOTE_PI_EXTENSIONS=/root/.pi/agent/npm/node_modules/pi-any-endpoint/extensions/index.ts
# piCli 必须是 **node 能执行的 JS 入口**，不是 /root/.pi/agent/bin/pi 那种 shell 启动器
export PI_LEGION_REMOTE_PI=/root/.pi/agent/npm/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js
# 可选：跑真 pi 子进程（要花一次真实 turn，且目标机必须有模型凭据）
export PI_LEGION_REMOTE_FULL=1

# 安全闸：必须 test- 开头。这条不是形式主义 —— 这套测试会在另一台机器上
# 创建和 kill 终端，绝不能发生在真实会话的命名空间里。
export HC_SESSION=test-cross-machine-$$
```

`npm run test:live` 会剥掉 `PI_LEGION_DB` / `PI_LEGION_NODE_ID` / `PI_LEGION_PHASES` /
`PI_SUBAGENT_*` 与 `HC_TERMINAL_*`（子进程不该继承本会话的身份），但**保留**上面这些
`PI_LEGION_REMOTE_*` 与 `HC_SESSION`。如果 `hc` 不在 PATH：`export HC_BIN=/abs/path/hc`。

---

## 2. 跑

```bash
npm run test:live -- --test-name-pattern='S5\.'
```

（只想跑跨机这组时加 `--test-name-pattern`；不加会连带 `rpc-live` 的两个真实 RPC 用例。）

### 期望输出（全绿时长这样）

```
✔ S5.1 preflight: that machine answers, the checkout is a git repo, and both sides share one origin
✔ S5.2 resume gate: an unknown terminal fails at step 3 with its address
✔ S5.3 verify: `true` passes and `false` is a code failure, both naming the machine
✔ S5.4 read-back: a file written there comes back with its exact line count
✔ S5.5 delivery: a remote worktree commits and pushes, and this machine fetches the same sha
✔ S5.6 full child: a real pi process runs on that machine and its transcript is readable here
ℹ tests 6   ℹ pass 6   ℹ fail 0   ℹ skipped 0
```

没设环境变量时它们应当是**跳过**而不是失败：

```
﹣ S5.1 ... # PI_LEGION_REMOTE_HOST is not set (see docs/runbooks/cross-machine-live-e2e.md)
ℹ pass 0   ℹ skipped 6
```

### 每一步在证明什么

| 用例 | 证明的东西 | 用时 |
|---|---|---|
| S5.1 | 真 core 的 `machine.exec`、目标机上的 `cd`/`git`、两侧 origin 一致、preflight 的 10 秒上界 | 1–3 s |
| S5.2 | 四步门在真机器上走到 step 3，且文案带地址 `vps/lgl-…` | 1–3 s |
| S5.3 | 真 `machine.exec` 上的三分类：通过 / 代码失败 / **超时**（1s 预算，`sleep 30`） | 2–5 s |
| S5.4 | `file.read` 的 `lines` 真是总行数、尾窗真只是尾窗 | 1–2 s |
| S5.5 | 远端建树 → 那边 commit → 那边 push → 这边 fetch 到同一个 sha | 5–20 s |
| S5.6 | 真 `pi` 子进程在**它的**树里起来，transcript 能读回父机 | 1–5 min |

---

## 3. 失败了怎么读

先看**失败的用例号**，再对下面的表。跨机链路的每个失败都在文案里点了名，`grep` 那几句就行。

### 启动前的拒绝（S5.1 / S5.5 建树）

| 文案片段 | 含义 | 怎么办 |
|---|---|---|
| `host 'vps' is not a machine this core knows (machine_unknown: …)` | 父机 core 不认识这个名字 | `hc machine ls`；改 `PI_LEGION_REMOTE_HOST` |
| `host 'vps' unreachable: <kind>: …` | core 连不上那台机器（ssh/socket） | 先手工 `hc exec --on vps -- true` |
| `cwd '/srv/app' does not exist on vps` | 目标机路径不对 | 改 `PI_LEGION_REMOTE_CWD` |
| `node 'node' is not on PATH on vps` / `pi CLI 'pi' …` | 目标机 PATH 里没有 | 设 `PI_LEGION_REMOTE_NODE` / `_PI` 为绝对路径 |
| `this package is not installed at /Users/zheng/code/pi-legion on that machine (every child argv loads /Users/zheng/code/pi-legion/index.ts; set subagents.crossMachine.hosts.host-workspace.piLegionRoot to where it really is, or install it there)` | **两侧 checkout 路径不同**，而 `piLegionRoot` 还指着父机路径——真机实测（Mac 父机 `/Users/zheng/code/pi-legion`，目标机 `/root/code/pi-legion`）就撞在这条上 | 设 `PI_LEGION_REMOTE_PI_LEGION_ROOT=/root/code/pi-legion`（目标机上的绝对路径），或在 settings 里配 `crossMachine.hosts.<host>.piLegionRoot`。**这条报错是正确行为**（M2 的 exit 14），不是 bug |
| `node 'node' is not on PATH on vps` | 远端非交互 shell 没有 nvm/PATH（真机实测第二条） | `PI_LEGION_REMOTE_NODE=/root/.nvm/versions/node/v24.13.1/bin/node` |
| `piCli '/root/.pi/agent/bin/pi' is not a JavaScript entry point node can execute …`（preflight exit 16） | `piCli` 指到了 **shell 启动器**（`case "$0"` 包一层）。子进程 argv 是 `[node, piCli, …]`，node 会把 shell 当 JS 解析，真机原文是 `SyntaxError: Unexpected token case` | 指向 JS 入口：`/root/.pi/agent/npm/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js` |
| 远端 child 输出 `Warning: No models available` / `Error: No API key found` | **父机 env 曾被转发过去**（S5 真跑已修：远端 launch 现在完全不发 `env`）。若仍出现，说明该 core 自己带了这个变量 | 远端 child 的凭据只来自**那台机器**的 pi 配置；用 `hc exec --on vps -- env | grep -i pi` 看 core 自己带了什么 |
| 所有用例都报 `machine_unknown: unknown machine: vps` | `hc machine` 注册是**按 session** 的，这个 `test-*` session 里没有那台机器 | 在同一 session 里 `hc machine add --temp --name vps ssh://user@host`，再 `hc machine ls` 确认 |
| `the hc core there already carries legion identity` | 那个 core 自己就在一个 legion 树里（D7） | 用干净环境重起那边的 core |
| `cross-machine delivery needs one shared remote` / `its checkout … has origin … but this checkout's is …` | 两侧 origin 不同 | 让两边指向同一个 URL |
| `timed_out: preflight did not finish within 10s` | **10 秒判定点 ①**：目标机 shell 起不来或极慢 | 手工 `hc exec --on vps -- true` 计时 |

### resume 四步（S5.2，以及任何 `resume`）

每个失败都带 `(step N/4)`，和 S4 的实现一一对应：

| 文案 | 步骤 | 含义 |
|---|---|---|
| `(step 1/4): the record does not say which machine it ran on` / 配置解析失败 | 1 | run.json 里没有 `host`，或 `crossMachine` 没配这个 host |
| `(step 2/4): host 'vps' is not reachable: …` / `did not answer \`true\` within 10s` | 2 | **10 秒判定点 ②**：机器可达性 |
| `(step 3/4): terminal 'vps/lgl-…' does not exist on that machine any more (its work is over; relaunch …)` | 3 | 终端不在了。**S5.2 就是在断言这句** |
| `(step 3/4): terminal … is 'finished' …` | 3 | 终端结束但还在（可以 relaunch，不能接管） |
| `(step 4/4): worktree /…/… does not exist on that machine (the branch may still hold the work; fetch it from origin)` | 4 | 树被删了；分支可能还在 origin |

### verify（S5.3）

| 结果 | 含义 |
|---|---|
| `failure` 缺省、`code: 0` | 真在那台机器上跑通了 |
| `failure: "code"`、`code: 1` | 命令真的失败（这是对**代码**的判定） |
| `failure: "timeout"` | 到点被杀（`sleep 30` 配 1s 预算）；**不是**代码失败 |
| `failure: "unreachable"` / `"unknown-host"` | 机器问题，绝不记成 rejected |

### 读回（S5.4）

| 断言 | 含义 |
|---|---|
| `lines` ≠ 5 | 目标机上那个探针文件不是 5 行（上一轮残留/权限问题） |
| `returned` ≠ `min(lines, tailLines)` | `hc file.read` 的窗口语义和我们在假 core 上钉的不一致（**这是最值得报告的一条**） |
| `truncated` 不符 | 同上：`lines`/`last` 的语义变了 |

### 交付（S5.5）

| 现象 | 含义 |
|---|---|
| `git push` 非 0，stderr 是 auth | 目标机没有 push 凭据（或 SSH key 不在那个用户的 `~/.ssh`） |
| 这边 `fetchRemoteBranch` 抛「unpushed branch」 | push 没到 origin；先手工 `git ls-remote origin <branch>` |
| sha 不一致 | 两侧看的不是同一个 ref（rare；记下来） |

### 真子进程（S5.6）

| 现象 | 含义 |
|---|---|
| spawn 抛 `terminal.run` 失败 | 目标机上 `pi` 起不来（版本/凭据/扩展） |
| 起得来但 transcript 一直 0 行 | 远端 `pi` 没有可用模型：多数情况是模型来自扩展、而 child 的 `--no-extensions` 把它关了（见 §3.5）。现在 launch 前的探测会在 10 秒内拒绝并点名 `piExtensions`，所以**正常情况下不该再走到这里** |
| handle 没有 `worktreePath` / `worktreeHost` | **先确认这棵树是谁建的**：跨机建树是**编排层**的一步（`createRemoteChildWorktree`），terminal 后端只复用被交给它的 `worktreePath`，或在被要求 `createWorktree` 时才自己建。S5.6 所以先建树再 spawn —— 直接 spawn 一个没给树的 child，handle 当然没有这两个字段（这是分层，不是 bug）。若树确实建过却仍缺失，看 stderr 里 `git worktree add failed` |
| 测试跑完 node 进程不退出 | `hc` 连接没关：`TerminalSupervisor` 的 client 要用 `clientFactory` 抓住，并在 `t.after()` 里 `close()`（S5.6 第一次真跑就踩了这个，等了 7 分钟只能 kill） |

---

---

## 3.5 远端 child 的模型来自何处（S5.6 真跑题目）

这一节是整套手册里最容易被忽略、也最容易让人误判成"远端环境坏了"的一块。

**事实**：legion 给每个 child 的 argv 都带 `--no-extensions`（child 不能继承父机的插件集）。
在**模型由扩展提供**的机器上（例如 `/root/.pi/agent/npm/package.json` 的 dependencies 里是
`pi-any-endpoint`），`--no-extensions` **顺手把模型提供者也关掉了**：

```
node cli.js -p "say ok"                 → ok
node cli.js --no-extensions -p "say ok" → No API key found / No models available   ← child 的症状
```

所以远端 child 需要一组**机器本地扩展**，由配置显式给出：

```jsonc
{
  "subagents": {
    "crossMachine": {
      "enabled": true,
      "hosts": {
        "host-workspace": {
          "cwd": "/root/code/pi-legion",
          "piExtensions": ["/root/.pi/agent/npm/node_modules/pi-any-endpoint/extensions/index.ts"]
        }
      }
    }
  }
}
```

这些条目被追加为 `--extension <p>`（在 `--no-extensions` 之后），且**不经过 pathMap**
（它们本来就是那台机器上的路径）。

**别把已安装的扩展再显式加一次**：如果远端已经把 pi-legion（或任何包）当 npm 包装着，
再 `--extension` 同一个包会撞工具重名：

```
Error: Failed to load extension "…/node_modules/pi-legion/index.ts":
  Tool "legion_output" conflicts with /root/code/pi-legion/index.ts
```

**launch 前的那一次探测**：现在每次远端 launch 会先用 child 的**完整 argv**（去掉 task、加
`--list-models`）在目标机跑一次，10 秒内给出结论。它问的是**模型可见性**，与凭据无关——
同一个 registry 里另一个 provider 缺 key 不会影响判定，只要期望的 model 出现在列表里就放行。
任何拒绝都会在末尾附上**可直接复制粘贴**的那条命令行（`Command (run on '<host>' to reproduce):`）。

| 症状（探测输出） | 判定 | launch 行为 |
|---|---|---|
| `--list-models` 列表为空且写着 `No models available` / `No API key` | 远端模型提供者没加载 | 拒绝（INVALID_PARAMS），点名 `hosts.<host>.piExtensions` 并附原始两行 |
| 有模型列表，但没有期望的 `model` | 那台机器不提供这个模型 | 拒绝（INVALID_PARAMS，`probe: "model-missing"`），列出该机器实际前 5 条，并给出改 model / 补 provider 扩展两个方向 |
| `conflicts with` | 扩展重复 | 拒绝（INVALID_PARAMS），指向"别把已装扩展再加一次" |
| 其他非 0 退出 | 该 argv 在那台机器上跑不起来 | 拒绝（START_FAILED），附 stderr 前 5 行 |
| 退出 0 / 无结论（输出无法解析） | 正常 | 继续，创建终端 |

探测**不可运行**时（`machine.exec` 本身失败）只打一行 stderr 并继续：它是诊断，不是门禁。

## 4. 剩余风险（S5 之后仍然存在的）

| # | 风险 | 为什么 e2e 也挡不住 | 10 秒判定点 |
|---|---|---|---|
| R1 | **远端 `pi` 版本 / 模型凭据不一致** | 父机能跑的 `pi` 参数，目标机上可能是旧版本；模型凭据是**那台机器**的事，父机无法验证。表现是「子进程起来了但一个 token 都不出」。 | **判定点 ③**：`terminal.run` 成功后 10 秒内 transcript 仍 0 行 ⇒ 认定远端代理不可用（S5.6 用 2 秒轮询 + 5 分钟上限，但日志里第一条空轮询就该被当成信号） |
| R2 | **远端 `git` 版本** | `worktree add -b` / `rev-parse --git-dir` / `push -u` 都是老接口（S2 只用了最老子集），但 `git worktree` 要求 ≥2.5、`push -u` ≥1.7；未知的是那台机器上 git 的**行为差异**（如 `core.autocrlf`、`safe.directory`）。表现是 `git worktree add failed` 或 `detected dubious ownership`。 | 建树失败在下一次调用就返回（`createRemoteChildWorktree` 里的 `git worktree add` 120s 预算）；**但 `safe.directory` 会在 10s 内以 stderr 原文出现**，不需要等满 |
| R3 | **ssh 路径完全未实测** | 仓库里没有任何真实 ssh 传输的测试；`hc` 的 machine 注册是外部状态（`hc machine add --via`），我们只依赖 `machine.exec` 能通。spike 证明过「可以用假 via 造一个假远端」——所以**假的不算数**，S5 的验收就是真 ssh。表现：`host 'vps' unreachable: …`（传输层） | **判定点 ④**：S5.1 的 `remotePreflight` 有 10s 硬上界；超时就是不可用，不需要再等 |
| R4 | 远端 `$HOME`/`PATH` 与父机不同 | preflight 只检查 `node`/`pi`/包入口，不检查模型配置、扩展、`~/.pi` 权限 | 同 R1 |
| R5 | 远端时钟/时区 | `file.read` 没有 mtime 通道（S4 已记），所以读回不做增量；不影响正确性 | — |
| R6 | 并发两个同名远端 child | 一台机器上 NAME_TAKEN 会拒绝（M8 已改文案带地址），但**两台不同机器**同名是允许的（分支名带 host 段） | — |

**「10 秒内失败」的判定点汇总**（这是刻意设计的上界，不是巧合）：

1. **preflight**（cwd / node / pi / 包入口 / identity）—— `REMOTE_PREFLIGHT_TIMEOUT_S = 10`
2. **resume step 2**（机器可达）—— `machine.exec true` 预算 10s
3. **远端子进程无输出**（R1）—— 起来后 10s 内 transcript 仍为空即判死
4. **远端 ssh 不可用**（R3）—— 由 (1) 覆盖，不需要额外超时

---

## 5. 清理

S5.5 刻意**不删** origin 上的分支（删了就分不清"交付成功"还是"根本没推上去"）。手工清：

```bash
git ls-remote --heads origin 'pi-subagent/*'     # 看残留
git push origin --delete <branch>                # 逐个删
hc exec --on vps -- git -C "$PI_LEGION_REMOTE_CWD" worktree list   # 远端树（正常应已 remove）
```

S5.6 结束时 `supervisor.retire()` 会 kill 终端；远端 worktree 保留（与生产策略一致：
树是证据，不自动删）。

---

## 6. 一次完整的照抄示例

```bash
export PI_LEGION_REMOTE_HOST=vps
export PI_LEGION_REMOTE_CWD=/srv/app
export PI_LEGION_REMOTE_ORIGIN=/srv/git/pi-legion.git
export HC_SESSION=test-xm-$(date +%s)

# 0) 先手工确认三件事（10 秒内应当都有答案）
hc machine ls | grep vps
hc exec --on vps -- sh -c 'cd /srv/app && git rev-parse HEAD && command -v node pi'
hc exec --on vps -- sh -c 'test -f /srv/app/.pi-legion/index.ts && echo package-ok'

# 1) 跑
npm run test:live -- --test-name-pattern='S5\.'

# 2) 绿了就再跑一次真子进程那一条
PI_LEGION_REMOTE_FULL=1 npm run test:live -- --test-name-pattern='S5\.6'

# 3) 清理
git -C /srv/app push origin --delete "$(git -C /srv/app branch --list 'pi-subagent/*' --format='%(refname:short)' | head -1)" 2>/dev/null || true
```
