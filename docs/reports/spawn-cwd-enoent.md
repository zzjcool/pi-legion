# spawn 的 cwd 不存在被误报成「程序不存在」— 修复报告（#410）

- 仓库 / 分支：`pi-legion` `pi-subagent/hw-nj/legion-410-r2-6b44d177`
- 基线：`origin/master a330da9`（release 6.2.4）
- 性质：bugfix（spawn 的 cwd 准备 + `terminal.run` 错误映射），无接口变更
- Issue：[#410](https://github.com/zzjcool/pi-legion/issues/410)，PR 写 `Fixes #410`
- 改动文件：`src/supervisor/terminal-supervisor.ts`、`test/unit/terminal-supervisor.test.ts`、本报告。
  **anchor（#409）、runId 透传（#414）、空壳启动（#423）的代码一行未碰**（见 §6）。

一句话结论：

> 起终端前先把**本地 worktree 的父目录**建出来（对端 `createRemoteChildWorktree` 早就在做同一件事），
> 且 `terminal.run` 因目录不存在而失败时把话说成**目录**：`spawn_failed: cwd does not exist: <path>`，
> 程序路径只作附注。真核心（`hc 0.1.21`）逐字复现了原报错；修复后同一现场目录被建出来、
> 报错指名该目录；全新 clone（无 `.pi-worktrees`）上本地 centurion 真进程起得来（回执 + `hc ls`
> + `git worktree list` 见 §3.3）。

---

## 1. 现象与根因

用户可见形态（issue 原文）：

```
✗ START_FAILED: terminal.run failed for terminal 'lgl-spawn-probe':
  spawn_failed: cannot start "<node 路径>": No such file or directory (os error 2)
```

核心把「我进不去那个目录」说成「那个程序不存在」。在本机 `hc 0.1.21` 上逐字复现
（node 是 `node -v` 正常打印的同一个二进制）：

```
$ node -v
v26.8.1
$ hc run --cwd /tmp/l410-r2-nocwd/does-not-exist -- \
    /home/zzjcool/.local/share/mise/installs/node/26.8.1/bin/node -v
{"error":{"hint":"check the program name and cwd","kind":"spawn_failed",
 "message":"cannot start \"/home/zzjcool/…/node\": No such file or directory (os error 2)"}}
```

`terminal.run` 的 cwd 是**启动目录**，legion 在两种情况下会把它指向一个父目录还不存在的路径：

1. worktree 的**根**在全新 checkout 上还没建出来（默认布局 `<storeRoot>/runs/<runId>/worktrees/<name>`，
   或记录里的 `<checkout>/.pi-worktrees/<name>`）；
2. 复用一棵**记录里的树**：`worktreePath` 来自 ledger（resume / 上一轮），此时
   `createChildWorktree` 按设计不再执行（D17：不自动重建），父目录可能已被清掉。

`createChildWorktree` 自己会 `mkdirSync(path.dirname(dest))`，但它**只覆盖“创建树”这一条路**；
终端启动器不能假设另一层一定先跑过。终端这一侧原先没有任何准备，于是核心的 chdir 失败被
原样抛成「程序不存在」。

## 2. 修法（两件事，都在 `TerminalSupervisor.spawnChild`）

### 2.1 `terminal.run` 之前：建出 worktree 的父目录

```ts
const launchCwd = target !== undefined ? remoteWorktree?.path ?? target.cwd : input.cwd;
if (target === undefined && input.worktree === true) {
	try {
		fs.mkdirSync(path.dirname(launchCwd), { recursive: true });
	} catch {
		/* best effort — `cwdDoesNotExistMessage` says what the parent looks like */
	}
}
```

边界刻意收窄：

- **只建父目录，不建树本身**。树属于 `git worktree add`；提前建出来会让 git 面对一个
  “已存在的目录”而拒绝。单测 ① 在 `terminal.run` 的 handler 内部断言了这两件事。
- **只对本地 launch（`target === undefined`）且 `worktree === true`** 动手。远端目录是**另一台机器**
  上的路径（D13），在这台机器上 `mkdir` 只会建出一个同名的假东西；远端那一半已有
  `ensureRemoteDir` + `createRemoteChildWorktree`。
- 建失败不算致命：`terminal.run` 照旧发出（目录也许因为别的原因存在），失败时由 §2.2 报全貌。

### 2.2 错误映射：`spawn_failed` + cwd 不存在 → 指名 cwd

`this.failure()` 多了一个**只有 `terminal.run` 本地调用点**才传的 `cwdContext`。命中条件三条同时成立：

1. 核心给的 `kind` ∈ `{spawn_failed, bad_cwd}`（前者是 `hc` 实测的词，后者是
   `test/helpers/fake-hc-core.mjs` 的用词；`src/hc/client.ts` 明确要求调用方按 `kind` 分支，不匹配散文）；
2. 该 cwd 在本机确实不是目录（`fs.statSync().isDirectory()`；文件/无法 stat 都算「不是目录」）；
3. 这是一次**本地** launch —— 远端不传 `cwdContext`：问本机文件系统关于另一个机器的路径会答错问题。

命中后的原文（首行是 #410 要求的形状）：

```
terminal.run failed for terminal 'lgl-l410-aft-probe-after': spawn_failed: cwd does not exist: /tmp/l410-probe-aASqli/.pi-worktrees/lgl-cwd-probe
  the program is not the problem: /home/zzjcool/…/node (the core said: spawn_failed: cannot start "/home/zzjcool/…/node": No such file or directory (os error 2))
```

父目录本身也缺失/不是目录时再补一行（错误时刻**实测**父目录状态，而不是复述本进程 mkdir 的成败）：

```
  its parent directory is missing or is not a directory: /tmp/l410-probe-aASqli/blocked
```

`details` 带结构化事实 `{ cwd, program, kind }`，`error.code = START_FAILED`，调用方不必匹配散文。

## 3. 真机验证

### 3.1 同一现场 before/after（直接驱动 `TerminalSupervisor`，真 `hc` core）

探针（`/tmp` 临时件，未入库）：对两个必然起不来的 cwd 各调一次
`TerminalSupervisor.spawnChild({worktree: true, cwd})`，打印回执/错误与目录状态。
master（`a330da9`）与本分支各跑一次：

**before（`origin/master a330da9`）**

```
== before / missing-parent ==
cwd asked for : /tmp/l410-probe-j33EVm/.pi-worktrees/lgl-cwd-probe
parent exists : false (before the launch attempt)
outcome       : LAUNCH FAILED
                terminal.run failed for terminal 'lgl-l410-bef-probe-before': spawn_failed: cannot start "/home/zzjcool/…/node": No such file or directory (os error 2)
code          : START_FAILED
parent exists : false (after the launch attempt)
tree exists   : false (the tree belongs to git, not the launcher)
```

**after（本分支）**

```
== after / missing-parent ==
cwd asked for : /tmp/l410-probe-aASqli/.pi-worktrees/lgl-cwd-probe
parent exists : false (before the launch attempt)
outcome       : LAUNCH FAILED
                terminal.run failed for terminal 'lgl-l410-aft-probe-after': spawn_failed: cwd does not exist: /tmp/l410-probe-aASqli/.pi-worktrees/lgl-cwd-probe
                  the program is not the problem: /home/zzjcool/…/node (the core said: spawn_failed: cannot start "/home/zzjcool/…/node": No such file or directory (os error 2))
code          : START_FAILED
parent exists : true (after the launch attempt)
tree exists   : false (the tree belongs to git, not the launcher)
```

即：同一现场、同一核心，**父目录确实被建出来了**，报错从「程序不存在」变成「cwd 不存在：<该目录>」。
「父目录是普通文件」的第二种现场（`ENOTDIR` / `Not a directory (os error 20)`）同样被映射，
并带出 `its parent directory is missing or is not a directory: …`。

### 3.2 全新 clone 上的正常路径（master 也起得来 —— 说明它是回归检查，不是复现）

在同一台机器上，全新 clone + 本地 centurion + `worktree: true` 在 **master 上也能起来**：
`createChildWorktree` 会先 `mkdirSync` 父目录再 `git worktree add`。所以「全新 checkout」本身不是
充分条件；会踩到 §1 的是**终端 cwd 的父目录没人建**的那些 launch（复用记录的树 / 根被清掉）。
因此 §3.3 的全新 clone 验证同时是「修复不改变正常路径」的回归证据。

### 3.3 全新 clone 上派发本地 centurion（`worktree: true`）— 起得来

`/tmp/l410-r2-e2e` 是从本仓库 clone 出来的临时 checkout（检出本分支 `6574c3e`），
派发前它**既没有 `.pi-worktrees` 也没有 `.pi-subagents`**：

```
$ git log --oneline -1
6574c3e fix(spawn): spawn 前建好 worktree 父目录，cwd 不存在时指名目录（Fixes #410）
$ ls -a | grep -E 'pi-worktrees|pi-subagents' || echo '(neither .pi-worktrees nor .pi-subagents)'
(neither .pi-worktrees nor .pi-subagents)
```

派发方式：一个真实的根 `pi` 进程加载本分支的插件（`-e <clone>/index.ts`），
模型走本机 mock LLM（`test/mock-llm`，与 legion 自己的 e2e 同一套），让它调用一次
`subagent({agent:"centurion", worktree:true, name:"l410-r2-probe"})`：

```
$ cd /tmp/l410-r2-e2e && pi --print --mode json --provider mock --model flash --thinking off \
    -e /tmp/l410-r2-e2e/index.ts -- \
    'MOCK_TOOL: subagent | {"agent":"centurion","name":"l410-r2-probe","worktree":true,"model":"flash","task":"MOCK_SAY: CENTURION_UP"}'
```

启动回执（父进程工具结果原文）：

```
▶ l410-r2-probe (centurion) supervisor=terminal
↳ async: a completion message is queued when each child finishes. It wakes this session when idle;
otherwise it is delivered after the current turn. Use wait or collect for results. Do not tell children
to message the parent.
```

核心侧（子终端存活期间轮询 `hc ls --all`，同一个终端从 `working` 走到 `done`）：

```json
{"address": "t6m", "agent": "pi", "cwd": "/tmp/l410-r2-e2e/.pi-subagents/runs/r-16b52281/worktrees/l410-r2-probe",
 "name": "lgl-l410-r2-probe", "parent": "t6b", "state": "live", "status": "done", "turn": 1}
```

```
$ cd /tmp/l410-r2-e2e && git worktree list
/tmp/l410-r2-e2e                                                       6574c3e [pi-subagent/hw-nj/legion-410-r2-6b44d177]
/tmp/l410-r2-e2e/.pi-subagents/runs/r-16b52281/worktrees/l410-r2-probe 6574c3e [pi-subagent/l410-r2-probe-98528e35]
```

子 centurion 自己的转录（第一行是会话 cwd，最后一条 assistant 是它的回答）：

```
{"type":"session","version":3,…,"cwd":"/tmp/l410-r2-e2e/.pi-subagents/runs/r-16b52281/worktrees/l410-r2-probe"}
CENTURION_UP
```

`run.json` 里那一行（`spawnMode` 是仲裁后的 backend，`worktreePath` 就是上面那棵树）：

```json
{"name":"l410-r2-probe","state":"retired","model":"flash","modelProvider":"mock",
 "spawnMode":"terminal",
 "worktreePath":"/tmp/l410-r2-e2e/.pi-subagents/runs/r-16b52281/worktrees/l410-r2-probe",
 "worktreeBranch":"pi-subagent/l410-r2-probe-98528e35"}
```

收尾：父进程退出时子树已 retire，`hc ls --all` 里再无该 clone 的终端；临时 clone、mock home、
mock server（`127.0.0.1:8767`）与探针脚本全部删除（`ls -d /tmp/l410-r2*` 无输出）。

## 4. 单测（`test/unit/terminal-supervisor.test.ts`，+2 条）

fake `hc` 客户端驱动，不碰真核心：

1. **「父目录缺失 → 自动创建并成功」**：cwd = `<root>/.pi-worktrees/lgl-spawn-probe`，先断言父目录
   不存在；在 `terminal.run` 的 handler **内部**（不是 launch 返回后）断言父目录已经存在，并断言
   叶子目录**没有**被建出来（它属于 `git worktree add`），cwd 原样过线。
   ```
   ✔ #410: a worktree launch creates the missing parent directory before terminal.run
   ```
2. **「无法创建时错误含 cwd」**：父路径位置上放一个**普通文件**（`ENOTDIR`，mkdir 永远建不出来），
   客户端按真核心的措辞抛 `spawn_failed`：
   ```
   ✔ #410: spawn_failed on a missing cwd names the cwd, and the program only as a note
   ```
   断言：`error.code === START_FAILED`、报文含 `spawn_failed: cwd does not exist: `、**逐字**含该 cwd、
   程序路径出现且被写明「不是问题」、并带出父目录的实测状态。

### 变异矩阵（各红一条）

| 变异 | 改法 | 结果 |
|---|---|---|
| A. 去掉 §2.1 的建父目录 | 删掉 `fs.mkdirSync(path.dirname(launchCwd))` 整块 | `✖ #410: a worktree launch creates…`，`ℹ pass 25 / fail 1` |
| B. 去掉 §2.2 的映射 | 命中条件前加 `false &&` | `✖ #410: spawn_failed on a missing cwd names…`，`ℹ pass 25 / fail 1` |

（A、B 互不牵连：A 只打红 ①，B 只打红 ②；父目录状态那一行在**错误时刻**实测，所以不依赖 A 的
mkdir 是否执行过。）

## 5. 门禁

```
$ flock /tmp/pi-legion-ci.lock -c "npm run typecheck && npm test"
ℹ tests 2682   ℹ pass 2682   ℹ fail 0        (exit 0)

$ flock /tmp/pi-legion-ci.lock -c "npm run test:integration"
ℹ tests 191    ℹ pass 191    ℹ fail 0        (exit 0)
```

均在 `origin/master a330da9` 之上（本分支）跑。

## 6. 边界

- 只动 spawn 的 cwd 与错误映射：`src/supervisor/terminal-supervisor.ts` 三处
  （`launchCwd` + mkdir、`terminal.run` 的 catch、`failure()` 与其两个新 helper），外加单测与本报告。
- **#409（anchor / parent 传递）与 #414（runId 透传）一行未碰**：`hc/client.ts` 未改（没有新增
  `parent` 字段）；终端命名、`spawnChild` 的 remote worktree / preflight / labels / `terminal.run`
  参数形状、`terminal.kill` 路径全部原样；#423 的空壳判定同样未动。
- 远端行为不变：`cwdContext` 只在 `target === undefined` 时传入，跨机失败文本与之前逐字一致
  （`test/integration` 的 fake-core 断言全绿）。
