# spawn 的 pi 子进程卡在「Trust project folder?」— 修复报告（#424）

- 仓库 / 分支：`pi-legion` `pi-subagent/hw-nj/legion-424-e1691873`
- 基线：`origin/master 26647da`（#425 合并之后；本分支从它 ff 上来）
- 性质：bugfix（终端后端 spawn argv 的一个 flag），无接口变更
- Issue：[#424](https://github.com/zzjcool/pi-legion/issues/424)，PR 写 `Fixes #424`
- 改动文件：`src/supervisor/terminal-supervisor.ts`、`test/unit/terminal-supervisor.test.ts`、
  `test/unit/cross-machine-params.test.ts`、本报告。
  `src/supervisor/child-session.ts`（#425 正在改）、`src/runs/hygiene.ts`、`src/runs/remote.ts` 一行未碰；
  #423（空壳校验）没有顺手做。

一句话结论：

> 终端后端 spawn `pi` 时**自己**在 argv 上加 `--approve`（pi 的**本次运行**项目信任），本地 child 与跨机 child
> 都由**同一次** `buildPiArgs` 调用产出，所以两条路径一起修好；pi 不再停在交互提示，child 立刻写 session 并跑起来。
> 真机：在**从未出现过 worktree 的全新仓库路径**上，本地与「跨机」两个 child 都真的在跑（`hc ls` 有终端、
> session 非空、`↑9.xk` token 计数非零）；同一路径把 flag 去掉就停回原提示、**没有** session 文件。
> 变异（删掉 `approve: true`）后 4 条单测红。

---

## 1. 现象与根因

用户可见形态（issue 原文）：终端 `state=live`、进程在，但**永远没有 session 文件**，父机当它 `working`；
在终端按一下 `Enter`（默认项 = Trust）任务立刻开始跑（`↑16k ↓1.4k`）。

根因在 pi 的项目信任流程（`@earendil-works/pi-coding-agent@1.5.2`，`dist/core/project-trust.js`）：

```js
export async function resolveProjectTrusted(options) {
    if (options.trustOverride !== undefined) return options.trustOverride;   // ← --approve 走这里
    if (!hasTrustRequiringProjectResources(options.cwd)) return options.trustStore.get(options.cwd) ?? true;
    ...
    const decision = options.trustStore.get(options.cwd);
    if (decision !== null) return decision;
    switch (options.defaultProjectTrust ?? SETTINGS_DEFAULTS.defaultProjectTrust) { case "always": return true; ... }
    if (!options.projectTrustContext.hasUI) return false;                    // ← headless：不提问
    const selected = await selectProjectTrustOption(cwd, options.projectTrustContext);  // ← TUI：卡在这里
```

- `hasTrustRequiringProjectResources(cwd)` 为真（`cwd/.pi/` 下有 `settings.json`、`mcp.json`、`extensions`、
  `skills`、`prompts`、`themes`、`SYSTEM.md`、`APPEND_SYSTEM.md` 之一，或祖先目录有 `.agents/skills`）；
- trust store 里没有这个 cwd 的决定；
- `defaultProjectTrust` 不是 `always`；
- `hasUI` 为真（TUI，stdin/stdout 都是 TTY）。

四条同时成立就 `await ctx.ui.select("Trust project folder? …")`，而这一步发生在**会话建立之前**：所以进程活着、
终端活着、transcript 一个字节都不会有。legion 每次把 child 放进一个**刚刚由自己创建**的目录（本地 worktree 或
远端 worktree），那个路径天然不可能在 trust store 里，于是「新机器 / 新仓库 / 新 worktree 根」必然踩。
`--approve` 让 `projectTrustOverride = true`，`resolveProjectTrusted` 第一行直接返回，**不提问、不写 trust store**
（写盘只发生在交互选择 / 扩展返回 `remember` 的那两条路上，`--approve` 在它们之前就返回了）。

本机为什么平时踩不到：`~/.pi/agent/settings.json` 有 `"defaultProjectTrust": "always"`，而它在提问**之前**就
返回 true（`switch` 那一支）。跨机那台没有这条，所以只有那边会卡——这也是 §4 里真机验证必须用**干净 agent dir**
的原因。

## 2. 修法（`TerminalSupervisor.spawnChild`，一个 hunk）

```ts
const built = buildPiArgs({
	...buildInput,
	tempDir,
	includeTask: false,
	// #424: … forced here, not inherited from the caller …
	approve: true,
	...(rewritePath ? { pathRewrite: rewritePath } : {}),
});
```

为什么这就覆盖了两条路径：本地 argv 是 `[process.execPath, cliPath, ...built.args, task]`，跨机 argv 是
`[target.node, target.piCli, ...mappedArgs, ...hostExtensions, task]`，`mappedArgs` 来自同一份 `built.args`；
`--approve` 不是路径，D6 的远端路径映射原样带过，S5.6 的启动探针（同一份 argv 去掉 task + `--list-models`）也带它。

为什么这不是降安全边界：

- 写的是 `approve: true` **覆盖** `...buildInput`：上游传 `approve: false` 也改不掉（有单测），它不是「默认值」而是
  「必须带」；
- `--approve` 只对**这一个进程**生效（§1 的 `trustOverride` 分支不落盘），不改 `defaultProjectTrust`、不写
  `~/.pi/agent/settings.json`、不写 `trust.json`、不选「Trust parent folder」（那条才会把父目录记进 trust store）；
- 只有 legion 自己起的 child 带它；操作员自己开的 pi 不受影响；
- RPC 后端**不动**：rpc child 用 `stdio: ["pipe","pipe","pipe"]`（`pi-coding-agent/dist/modes/rpc/rpc-client.js`），
  没有 UI，pi 不会问；`subagents.rpc.approve`（#193）仍是它的 opt-in。
  in-process 后端不 spawn 进程，无关。

## 3. 单测

新增 / 加强（`test/unit/terminal-supervisor.test.ts`、`test/unit/cross-machine-params.test.ts`）：

| 用例 | 断言 |
|---|---|
| `#424: a local terminal child's argv trusts the project for THIS run only` | 本地 `terminal.run` 的 argv 恰有一个 `--approve`、没有 `--no-approve`、末位仍是 task；**反向对照**：把 flag 从 argv 里滤掉后同一个判定函数必须抛错 |
| `#424: approve is FORCED, not inherited from subagents.rpc.approve` | 传 `approve: false` 仍然带；传 `approve: true` 不会变成两个 |
| `S1: a remote spawn preflights, makes the remote dir, and sends the remote cwd/argv/env/labels` | 远端 argv 恰有一个 `--approve`，且 S5.6 启动探针的命令行里也有它 |
| `D4: argv is rpc's argv (includeTask:false) plus the task as one positional element` | 与 rpc 的 `buildPiArgs` 逐字节对齐，**唯一**的 delta 是 `--approve`（旧断言更新为显式声明这处有意差异） |

变异（把源码里的 `approve: true,` 删掉，其它不动）：

```
$ node --experimental-strip-types --test \
    test/unit/terminal-supervisor.test.ts test/unit/cross-machine-params.test.ts
✖ S1: a remote spawn preflights, makes the remote dir, and sends the remote cwd/argv/env/labels
✖ D4: argv is rpc's argv (includeTask:false) plus the task as one positional element
✖ #424: a local terminal child's argv trusts the project for THIS run only
✖ #424: approve is FORCED, not inherited from subagents.rpc.approve
ℹ tests 63   ℹ pass 59   ℹ fail 4
```

失败原文（第一条就是这次要防的形状）：

```
AssertionError [ERR_ASSERTION]: local child: argv must carry exactly one --approve (#424), got:
  …/node /fake/pi/dist/cli.js --session /tmp/terminal-supervisor-…/session.jsonl --no-extensions
  --extension … --append-system-prompt /tmp/…/system-prompt.md Task: Implement the slice. …
```

恢复后同一组用例 63/63 绿。

## 4. 真机验证（本机 `hw`，`hc 0.1.21`，`pi 1.5.2`）

测试条件（不碰任何用户级配置）：parent/child 都用临时 agent dir（`PI_CODING_AGENT_DIR=/tmp/agent42x`，只放
`auth.json` + `models.json` + `defaultProjectTrust: "ask"`），项目里放一个 `.pi/settings.json` 让「项目信任」成为
pi 的必要问题（真实用户的项目就是这样）。没有改 `~/.pi/agent/settings.json`，没有 `defaultProjectTrust: always`。

### 4.0 现场复现（同一台机、不加 flag）

```
$ hc run --bg --name trust-noapprove --cwd /home/zzjcool/code/fresh424/plain -- sh -c \
    'PI_CODING_AGENT_DIR=/tmp/agent424 exec pi --no-extensions --model … --provider magpie "Reply with OK and stop."'
$ hc read trust-noapprove
 Trust project folder?
 /home/zzjcool/code/fresh424/plain
 This allows pi to load .pi settings and resources, install missing project packages, and execute project extensions.
 → Trust
   Trust parent folder (/home/zzjcool/code/fresh424)
   Trust (this session only)
   Do not trust
   Do not trust (this session only)
 ↑↓ navigate  enter select  escape/ctrl+c cancel
$ hc get trust-noapprove --json
 state=live  status=None  turn=0        # 活着，但一个 token 都没花、session 不存在
```

这就是 issue 里的那一步（1.5.2 比 issue 的截图多两个 session-only 选项，所以这里贴的是本机原文）。
同一条命令加上 `--approve`：立刻开跑，回答 `OK`，状态行 `↑3.0k ↓2`，`state=done turn=1`。

### 4.1 同机：全新仓库路径的**第一次** worktree

- 全新路径：`/home/zzjcool/code/fresh424/checkout`（`git clone` 出来的新 checkout，`.pi-subagents/` 之前不存在），
  派 child 前 `ls` 里只有 `checkout`。
- parent：hc 终端里跑本分支源码的 pi，被要求「用 subagent 起一个 centurion，`worktree: true`」：

```
$ hc run --bg --name spawn424-parent --cwd /home/zzjcool/code/fresh424/checkout -- sh -c \
    'PI_CODING_AGENT_DIR=/tmp/agent424 exec pi --approve --no-extensions \
       --extension /home/zzjcool/code/.pi-worktrees/legion-424/index.ts --no-skills \
       --model magpie/workbuddy/deepseek-v4.1-flash --provider magpie "<派发 centurion 的 prompt>"'
```

- parent 屏幕（`hc read`）：

```
  subagent agent="centurion" task="Reply with exactly the word READY and then stop. …" worktree=true
 ▶ centurion-0 (centurion) supervisor=terminal
 Child handle: centurion-0 (launched async with worktree: true).
 ✓ centurion-0 (centurion) · success · acceptance accepted (attested) · 156 B
 centurion-0 completed successfully — verdict accepted (attested).
 Output: READY — no files touched, no branches changed, no further subagents spawned.
```

- child 的树/回执：`git worktree list` 多出
  `…/fresh424/checkout/.pi-subagents/runs/r-b99d74ca/worktrees/centurion-0  be06b57 [pi-subagent/centurion-0-360cc859]`；
  child session `…/fresh424/checkout/.pi-subagents/runs/r-acdd6810/centurion-0.jsonl` **44095 字节**，首行：

```
{"type":"session","version":3,"id":"…","cwd":"…/.pi-subagents/runs/r-b99d74ca/worktrees/centurion-0"}
```

即：不是「卡在提示后被人工 Enter 救活」，而是自己起、自己跑完、交回 verdict。

### 4.2 再跑一次，抓活体三条证据（同机）

- 全新路径 `/home/zzjcool/code/fresh424b/checkout`（再 clone 一份，worktree 根也是全新的），child 任务故意长跑
  （`sleep 300`），好在它**活着**的时候取证。

① `hc ls` 里的终端：

```
{"address":"t6z","name":"lgl-centurion-0","agent":"pi",
 "cwd":"/home/zzjcool/code/fresh424b/checkout/.pi-subagents/runs/r-9fa43e5c/worktrees/centurion-0",
 "state":"live","status":"working","turn":0,"parent":"t6y"}
```

② session 文件存在且非空：

```
$ stat -c '%s bytes  %n' /home/zzjcool/code/fresh424b/checkout/.pi-subagents/runs/r-fc01a989/centurion-0.jsonl
44122 bytes  …/fresh424b/checkout/.pi-subagents/runs/r-fc01a989/centurion-0.jsonl
```

③ 终端里的 token 计数非零（`hc read t6z`）：

```
 $ sleep 300 (timeout 310s)
 Elapsed 51.0s
── ⠧ Working ─────────────────────────────────────────────────────────
~/code/fresh424b/checkout/.pi-subagents/runs/r-9fa43e5c/worktrees/centurion-0 (pi-subagent/centurion-0-31a0d1cd)
↑9.4k ↓301 R2.4k CH20.5% 1.2%/1.0M (auto)          workbuddy/deepseek-v4.1-flash • max
```

同一次 `hc get t6z` 直接看到旗标在线上：`has --approve: True | count: 1`，`--session` 指向上面那个文件。

### 4.3 跨机路径（`host` + 远端 worktree）

本机 `hc machine ls` 是空的（没有配置外部机器），所以用 hc 自己的多机能力造一台**独立 hc core/session** 的机器：

```
$ hc machine add localhost --name loopback424 --session legion424 --temp --install --json
{"host":"hw","name":"loopback424","session":"legion424","target":"localhost","temporary":true,"version":"0.1.21"}
$ hc machine ls --json → {"state":"connected"}
```

它与本机共享文件系统，但**走的是另一条代码路径**：`terminal.run` 带 `on`、跨机 preflight、远端 `git worktree add -b`、
argv 的 D6 路径映射、S5.6 远端 `--list-models` 探针全部真的执行。parent 配置 `subagents.crossMachine.hosts.loopback424.cwd`
（只写在临时 agent dir 里），全新路径 `/home/zzjcool/code/fresh424c/checkout`，派 child 时给 `host: loopback424, worktree: true`。
parent 的启动命令与 §4.1 同形，只差 agent dir（`/tmp/agent424c`）与 prompt 里的 `host=loopback424`。

① `hc ls` 里的终端（地址带机器名，cwd 是**对端**的 `.pi-worktrees` 根）：

```
{"address":"loopback424/t1","name":"lgl-centurion-0","agent":"pi",
 "cwd":"/home/zzjcool/code/fresh424c/.pi-worktrees/centurion-0",
 "state":"live","status":"working","turn":0}
```

② 远端 session 存在且非空（就是 argv 里 `--session` 的那个远端路径）：

```
$ stat -c '%s bytes  %n' /home/zzjcool/code/fresh424c/.pi-subagents-mirror/no-run/centurion-0/session.jsonl
43685 bytes  /home/zzjcool/code/fresh424c/.pi-subagents-mirror/no-run/centurion-0/session.jsonl
$ head -c 220 …
{"type":"session","version":3,"id":"…","cwd":"/home/zzjcool/code/fresh424c/.pi-worktrees/centurion-0"}
```

（父机侧的镜像占位 `…/checkout/.pi-subagents/runs/r-acfba967/centurion-0.jsonl` 是 **0 字节**——它等 collect 才取；
这正是 #423 说的「空壳」形状，与本条正交，本条不碰。）

③ 终端 token 计数（`hc read loopback424/t1`）：

```
 $ sleep 300 (timeout 300s)
 Elapsed 27.0s
── ⠹ Working ─────────────────────────────────────────────────────────
~/code/fresh424c/.pi-worktrees/centurion-0 (pi-subagent/loopback424/centurion-0-748fba1c)
↑9.2k ↓329 R2.4k CH20.9% 1.2%/1.0M (auto)        (magpie) workbuddy/deepseek-v4.1-flash • max
```

同一次 `hc get loopback424/t1 --json`：`has --approve: True | count: 1`，argv 前 14 项为
`…/node …/dist/bundle/cli.js --session <远端 session> --model … --provider magpie --no-extensions --extension builtin:mcp …`。

用完 `hc kill`/`hc rm` 掉所有测试终端，`hc machine rm loopback424`，`hc machine ls` 回到 `{"machines":[]}`。

### 4.4 同一路径的反向对照（把 flag 去掉）
两处都做了，缺一不可：

- 同机：在 4.2 的**同一个 worktree 路径**上，用同一套 flag 但**不带** `--approve` 起一个裸 pi：
  屏幕是 `Trust project folder? /home/zzjcool/code/fresh424b/…/worktrees/centurion-0`，且 `ls /tmp/noapprove-wt.jsonl`
  → `No such file or directory`（state=live、turn=0、零 token）。
- 跨机：在 4.3 的**同一个远端 worktree 路径**上同样不带 `--approve`（跑在 `loopback424` 上）：
  屏幕是 `Trust project folder? /home/zzjcool/code/fresh424c/.pi-worktrees/centurion-0`，`ls /tmp/noapprove-remote.jsonl`
  → `No such file or directory`。

即「同一路径 + flag = 跑；同一路径 − flag = 卡且无 session」，不是环境差异。

### 4.5 `--approve` 是否足够（要求 5）
两次真机运行（本机 + 跨机）里，child 从启动到产出 `READY` / 持续 `Working` 之间**没有出现第二种交互提示**；
唯一能卡住的就是 §4.0 那段 `Trust project folder?` 原文，而它已被 `--approve` 直接短路。所以本条不需要
「贴另一种提示」的兜底。

## 5. 门禁

```
$ flock /tmp/pi-legion-ci.lock -c "npm run typecheck && npm test"
… ℹ tests 2708  ℹ pass 2708  ℹ fail 0   （typecheck 无输出）
$ npm run test:integration
… ℹ tests 192   ℹ pass 192   ℹ fail 0
```

基线没有上调：唯一一处旧断言改动（D4 的逐字节对齐）是把「与 rpc 相同」改成「与 rpc 相同 + 唯一有意差异
`--approve`」，并额外断言除了这个 flag 之外没有任何其它漂移。

## 6. 未覆盖 / 已知限制

- 外部**另一台物理机**没验：本机 `hc machine ls` 为空，用的是 `hc machine add localhost --session legion424` 起的
  独立 hc core/session（见 §4.3），路径共享文件系统。跨机的代码路径（`on`、preflight、远端 worktree、D6 argv 映射、
  远端探针）都真的跑了，但「两台机器上 node/pi 布局不同」的情形只能靠单测（`S1`）与实际部署去覆盖。
- 反向对照是「同一路径、同一 argv 去掉 flag」，不是「旧版本二进制」；等价性由 §3 的变异单测补齐。
- `--approve` 只回答项目信任这一个问题；如果以后 pi 在 TUI 里加了别的启动期交互提示，本条不覆盖（这一次没有观察到）。
