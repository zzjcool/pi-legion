# 本地 terminal spawn 的 cwd 预检与错误归因 — 修复报告（#432）

- 仓库 / 分支：`pi-legion` `pi-subagent/legion-432-62f8e40c`
- 基线：`origin/master aa9c8f4`（release 6.2.5；#426/#428/#430 与 #410 均已在基线里）
- 性质：bugfix（**本地** spawn 的 cwd 预检 + 错误归因），无接口变更、无设置键新增
- Issue：[#432](https://github.com/zzjcool/pi-legion/issues/432)，PR 写 `Fixes #432`
- 改动文件：`src/supervisor/terminal-supervisor.ts`、`test/unit/terminal-supervisor.test.ts`、本报告

一句话结论：

> 起终端**之前**，本地这条路径先把 cwd 变成绝对路径、再确认它是本机的一个目录，并在需要时
> `mkdir -p` 出 worktree 树的**父链**（叶子留给 `git worktree add`）；不满足就在 `terminal.run`
> 之前以 `cwd does not exist: <path>` 拒绝。cwd 确实存在时保留核心自己的 `cannot start <program>`——
> 两种归因从此不混用。

---

## 1. 现象与根因

issue 原文（本机 macOS，6.2.4）：

```
✗ centurion: START_FAILED: terminal.run failed for terminal 'lgl-pi-async-100c':
  spawn_failed: cannot start "/Users/zheng/.nvm/versions/node/v22.22.3/bin/node":
  No such file or directory (os error 2)
```

排查结论（issue 表格）：node 存在且可执行、`hc run -- <同一 node> -v` 成功、in-process child 成功，
**只有「terminal supervisor + 本地 spawn」这一条路径坏**。跨机侧 #426 已修，本地分支没人管。

### 1.1 在 `origin/master aa9c8f4` 上逐条复现（本机，`hc 0.1.21`）

用真 `TerminalSupervisor` 直接驱动真 `hc` core（探针脚本 `/tmp` 临时件，未入库）：

**(a) 相对 cwd（issue 表格里「相对 cwd 也失败」那条）**

```
$ cd /tmp/l432-rel-target && ls -d real
real                                     # 在本进程的 cwd 下确实存在
$ node --experimental-strip-types probe.ts real l432-before-rel      # 走 spawnChild
{
  "outcome": "LAUNCH FAILED",
  "code": "START_FAILED",
  "message": "terminal.run failed for terminal 'lgl-l432-before-rel': spawn_failed: cannot start
              \"/Users/zheng/.nvm/versions/node/v22.22.3/bin/node\": No such file or directory (os error 2)"
}
```

**这正是 #432 说的错误归因**：核心拿到的 `cwd` 是相对字符串，它按**自己**的目录去解析（核心的 cwd 不是
调用方的 cwd），落到一个不存在的路径，于是 exec/chdir 报 `ENOENT`，而核心把这条 `ENOENT` 说成
**程序**不存在（`cannot start "<node>"`）。#410 的事后映射也救不了这一条：`isDirectoryOnDisk("real")`
在**本进程**里是真，于是映射判定「cwd 没问题，那就是程序的问题」——把罪行栽给了 node。

**(b) 绝对 cwd 不存在**

```
terminal.run failed for terminal 'lgl-l432-before-nocwd': spawn_failed: cwd does not exist: /tmp/l432-does-not-exist-432
  the program is not the problem: …/.nvm/versions/node/v22.22.3/bin/node (the core said: spawn_failed: cannot start "…/node": …)
```

这一条 **#410 的事后映射已经能说对**——但它是**问过核心、核心失败之后**才说的：`terminal.run` 真的
发出去了，temp dir 已经建了，判定是事后重述，不是事前预检。

### 1.2 缺的是什么

| 缺口 | 基线（aa9c8f4） | 本分支 |
|---|---|---|
| 本地 cwd 在 `terminal.run` **之前**被验证 | ✗（没有任何预检；#410 只在失败后改写措辞） | ✓ `preflightLocalLaunch` |
| 相对 cwd 在本机解析成绝对路径 | ✗（核心按自己的目录解析 → 归因错） | ✓ `path.resolve` |
| 需要建的目录（worktree 树的父链）按需建出 | △（#410 建，但只对 `worktree: true`，且失败后仍把判定交给核心） | ✓ 预检里 `mkdir -p`，仍只建父链 |
| `cwd 不存在` 与 `cannot start <program>` 两种归因分开 | △（依赖事后 stat，相对路径下判错） | ✓ 事前判定 + 事后兜底，各说各的 |
| 被拒的 launch 不留痕 | ✗（temp dir 留下 prompt/owner 文件） | ✓ 拒绝时清掉 |

---

## 2. 修法

### 2.1 `preflightLocalLaunch`：本地版的 D6/D9

`spawnChild` 里，`target === undefined`（本地）时，把「launch 目录」交给
`preflightLocalLaunch(...)`，它的返回值就是发给 `terminal.run` 的 `cwd`。三件事，按顺序：

1. **绝对化**：`path.resolve(input.cwd)`。核心解析相对路径用的是**核心自己的目录**，不是本进程的
   （§1.1(a) 实测）；一次解析，线上走的永远是绝对路径。
2. **是目录**：`statSync().isDirectory()`——文件（`ENOTDIR`）、不存在、断链 symlink 全算「不是目录」。
3. **归属**：只有 `worktree: true` 的本地 launch 才动 `mkdir -p path.dirname(cwd)`（**树的父链**，
   这跟远端 `ensureRemoteDir` / `createRemoteChildWorktree` 的分工逐字一致）；**叶子永不创建**——
   它属于 `git worktree add`，递给 git 一个已存在的目录是拒绝（#410 的冻结决定，本分支不回退）。
   其它任何缺失的 launch 目录也不创建：空目录不是 checkout，child 放进去每条命令都会错，
   响亮是最好情况，静默是最坏情况。

三步之后仍不是目录 → **抛错，且这一步发生在 `terminal.run` 之前**（`target === undefined` 的分支里
连 `terminal.run` 都不会发出），并顺手 `removeTempDir(tempDir)`：拒绝的 launch 不留 prompt/owner 文件。

### 2.2 归因分开（两条句子，各说各的事实）

```
# 预检拒绝（本分支新增，事前判定；这里没有 spawn，所以不用核心的词）
terminal.run failed for terminal 'lgl-x': cwd does not exist: /abs/path
  refused before the core was asked to spawn: /path/to/node is not the problem, and was never tried
  its parent directory is missing or is not a directory: /abs        # 仅当实测父目录确实不对时追加

# 事后兜底（#410 的冻结形状，只在「预检通过后目录又被抹掉」时出现）
terminal.run failed for terminal 'lgl-x': spawn_failed: cwd does not exist: /abs/path
  the program is not the problem: /path/to/node (the core said: spawn_failed: cannot start "/path/to/node": …)

# 程序真的起不来（cwd 存在 → 核心的句子就是事实，原文保留，不改写）
terminal.run failed for terminal 'lgl-x': spawn_failed: cannot start "/path/to/node": No such file or directory
```

`details` 也分开：预检拒绝带 `{ cwd, program, preflight: "local-cwd" }`，事后兜底带
`{ cwd, program, kind }`；两者都是 `START_FAILED`，调用方不必匹配散文。

### 2.3 不动的东西

远端分支一行未改：`remotePreflight`（D6/D9）、`createRemoteChildWorktree`、`ensureRemoteDir`、
`pickTarget`/`planRemoteModelFallback`、远端 startup probe 全在原位；本分支只给
`target === undefined` 加了一条自己的预检。

---

## 3. 真机验证（本机 macOS，`hc 0.1.21`）

### 3.1 派一个真的 terminal child（成功路径）

用真 `TerminalSupervisor.spawnChild` 起一个真的 `pi` 终端 child（`cwd` = 本 worktree，task
「Reply with the single word READY」），settle 后从核心侧读事实：

**① `hc ls --all --json` 里的这个终端**

```json
{"address":"t39","agent":"pi","cwd":"/Users/zheng/code/pi-legion/.pi-subagents/runs/r-2ed20ff1/worktrees/legion-432","name":"lgl-l432final","state":"live","status":"done","turn":1}
```

`hc get lgl-l432final`（同一时刻）确认 argv 是 `[node, …/pi-coding-agent/dist/bundle/cli.js, --session, …
--approve, Task: Reply with the single word READY…]`、`cwd` 就是 worktree、`turn: 1`。

**② session 文件非空**

```
/var/folders/…/T/l432-l432final-lcXHZl/session.jsonl   44936 bytes, 6 行, 1 条 usage 记录
```

**③ 终端 token 计数非零**（`hc read` 的 status line，以及 session 里的 usage）

```
↑156 ↓26 R12k CH98.8% 1.3%/1.0M (auto)            (magpie) workbuddy/deepseek-v4.1-flash • low
```

```json
{"session": {"bytes": 44936, "lines": 6, "usage": 1, "in": 156, "out": 26}}
{"lastAssistant": "READY"}
```

（`spawnChild` 回执：`{"name":"l432final","pid":4539,"parentAbsent":"no caller terminal (HC_TERMINAL_ID is unset)"}`
——探针进程不在 hc 终端里，所以 child 没有 parent；真实 launch 有 `caller` 时照旧带 parent，#409 未动。
探针收尾 `retire` → `hc ls --all` 里再无 `lgl-l432*`。）

### 3.2 故意给一个不存在的 cwd（归因正确）

```
$ node --experimental-strip-types probe.ts /tmp/l432-does-not-exist-432 l432final-nocwd
{
  "outcome": "LAUNCH FAILED",
  "code": "START_FAILED",
  "message": "terminal.run failed for terminal 'lgl-l432final-nocwd': cwd does not exist: /tmp/l432-does-not-exist-432
              refused before the core was asked to spawn: /Users/zheng/.nvm/versions/node/v22.22.3/bin/node is not the problem, and was never tried",
  "details": { "cwd": "/tmp/l432-does-not-exist-432", "program": "/Users/zheng/.nvm/versions/node/v22.22.3/bin/node", "preflight": "local-cwd" }
}
```

没有 `cannot start "<node>"`，没有 `spawn_failed`（这次真的没 spawn），核心一次都没被问到
（`terminal.run` 调用数 = 0，见 §4 的单测断言）。

### 3.3 相对 cwd：修前 / 修后（同一现场、同一核心）

| | 结果 |
|---|---|
| 修前（`aa9c8f4`） | `LAUNCH FAILED`：`spawn_failed: cannot start "<node>": No such file or directory (os error 2)` |
| 修后（本分支） | `LAUNCHED`，session 44832 bytes / `usage.in=11395` / `usage.out=23`，`hc get` 的 `cwd` = `/private/tmp/l432-rel-target/real`（即 `real` 在本机解析后的绝对路径） |

即：同一条相对 cwd，修前把 node 当替罪羊，修后 child 真的在**正确目录**里起来了。

### 3.4 worktree launch：父链按需建出，叶子留给 git（真机）

```
$ L432_WORKTREE=1 probe.ts /tmp/l432-wt2/deep/nested/.pi-worktrees/lgl-tree l432wt2
{
  "outcome": "LAUNCH FAILED",
  "code": "START_FAILED",
  "message": "terminal.run failed for terminal 'lgl-l432wt2': cwd does not exist: /tmp/l432-wt2/deep/nested/.pi-worktrees/lgl-tree
              refused before the core was asked to spawn: /Users/zheng/.nvm/versions/node/v22.22.3/bin/node is not the problem, and was never tried",
  "details": { "cwd": "/tmp/l432-wt2/deep/nested/.pi-worktrees/lgl-tree", "program": "…/node", "preflight": "local-cwd" }
}
$ ls -d /tmp/l432-wt2/deep/nested/.pi-worktrees      → 存在（预检递归建出整条父链）
$ ls -d /tmp/l432-wt2/deep/nested/.pi-worktrees/lgl-tree  → No such file or directory（叶子属于 git）
```

---

## 4. 单测（`test/unit/terminal-supervisor.test.ts`：+5 条，1 条改写）

fake `hc` 客户端驱动，不碰真核心：

| # | 断言 |
|---|---|
| ① `#432: a local launch with a missing cwd is refused before terminal.run, naming the cwd` | 父路径位置上放普通文件（ENOTDIR）：`error.code === START_FAILED`；报文逐字含 `cwd does not exist: <cwd>`；含程序路径但写明 `is not the problem`；**不含** `cannot start`、**不含** `spawn_failed`；带出父目录实测状态；`details.preflight === "local-cwd"`；`terminal.run` **一次都没调用**；`terminal-child-*` temp dir 一个不留 |
| ② `#432: a worktree launch mkdir -p's the missing parent chain, and leaves the tree to git` | 缺**两级**父目录 → 预检递归建出整条父链；**叶子仍未创建**（属于 git）；拒绝报文指名 cwd；`terminal.run` 未调用 |
| ③ `#432: a relative local cwd is resolved HERE, not by the core` | 传相对 cwd → launch 正常成功，`terminal.run.params.cwd === path.resolve(cwd)`（核心永远拿到绝对路径） |
| ④ `#432: a cwd that DOES exist keeps the program's sentence` | cwd 存在 + 核心答 `spawn_failed: cannot start "<program>"` → 报文保留 `cannot start`，**不含** `cwd does not exist`（两种归因不混） |
| ⑤ `#410: a cwd removed between the preflight and the spawn still names the cwd` | 预检通过后目录被抹掉 → 事后兜底仍是 #410 的冻结形状 `spawn_failed: cwd does not exist: `，程序只作附注 |

（原 #410 的两条按新契约改写：①「建父目录」现在由预检承担且叶子缺失会被**拒绝**而不是把判定推给核心，
②「父目录是文件」现在在 `terminal.run` 之前就拒绝、报文不再有 `spawn_failed` 前缀。）

### 变异矩阵（各红一条，两种变异都跑过）

| 变异 | 改法 | 结果 |
|---|---|---|
| A. 去掉本地 cwd 预检（issue 要求的那条） | 本地分支 `launchCwd = input.cwd`，`preflightLocalLaunch` 不再调用 | `✖ ① ② ③`，`# tests 31 / # pass 28 / # fail 3` |
| B. 只去掉绝对化 | `const cwd = path.resolve(opts.cwd)` → `const cwd = opts.cwd` | `✖ ③`，`# tests 31 / # pass 30 / # fail 1` |

```
not ok 27 - \#432: a local launch with a missing cwd is refused before terminal.run, naming the cwd
not ok 28 - \#432: a worktree launch mkdir -p's the missing parent chain, and leaves the tree to git
not ok 29 - \#432: a relative local cwd is resolved HERE, not by the core
# tests 31
# pass 28
# fail 3
```

（④⑤ 不红是对的：它们钉的是「预检通过之后」的归因，与预检是否存在无关。）

---

## 5. 门禁

```
$ npm run typecheck
exit 0

$ npm test                       # 2752 tests
# tests 2752
# pass 2717
# fail 14
# skipped 21

$ npm run test:integration       # 193 tests
# tests 193
# pass 183
# fail 10
```

这 `14` / `10` 条**不是本分支引入的**：在同一台机器上对 `origin/master aa9c8f4` 跑同一套命令，
失败清单逐条相同（`diff` 为空）。它们都是本机环境类用例（`mise`/node/pi 探测类 14 条、
`npm pack`/`npm ci`/retire sweep 等），本机没有 mise、且这些用例依赖的本机布局不成立。
基线：unit `2749 tests / 2714 pass / 14 fail`，integration `193 / 183 / 10`——**没有上调基线**，
也没有新增 skip（`skipped 21` 与基线一致）。

关于 `flock`：本机是 macOS，没有 `flock(1)`。同一把锁的语义用 `mkdir /tmp/pi-legion-ci.lock.d`
实现的互斥（等到拿到为止、跑完整串再释放）来保证——锁的目的是「不要和别的队同时跑全套」，
而不是文件名本身。

---

## 6. 边界

- 只动本地 spawn 的 cwd 预检 + 错误归因 + 测试：`src/supervisor/terminal-supervisor.ts` 里
  `spawnChild` 的本地分支、新增 `preflightLocalLaunch`、新增 `cwdRefusedBeforeSpawnMessage`，
  以及 `failure()`/`cwdDoesNotExistMessage()` 的注释（逻辑未改）。
- **跨机 preflight 行为一行未改**（D6/D9 已上线，不回退）：`remotePreflight`、`ensureRemoteDir`、
  `createRemoteChildWorktree`、远端 startup probe、`applyRemoteModelFallback` 全部原样；
  `target !== undefined` 时 `launchCwd` 的取值与之前逐字相同。
- **未碰** `src/runs/launch-evidence.ts`（判据唯一实现）、`live-*`（#429 在改）、`stall-notice.ts`。
- 锚点（#409）、终端命名（D7）、labels（D6）、`terminal.run` 参数形状：本地只多了一个
  「cwd 是绝对路径」的保证（绝对路径输入时 resolve 是恒等），其余键一个没变。
- 单测基线不上调：新增 5 条、改写 2 条，失败清单与本机 master 基线逐条相同。
