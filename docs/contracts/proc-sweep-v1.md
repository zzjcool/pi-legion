# 进程树清扫 `sweepProcessTree`（v1，冻结）

> 语义由 #310 冻结（`Closes #310`，PR #334）。实现期发现矛盾 → 停下报告，不得重新解释本契约。
> **本文件是 #310 的 D 编号命名空间**：代码与测试注释里的 `#310 review Fn` 指的是本 PR
> 第一轮对抗式 review 的 finding 编号（F1–F8），与本文件的 D1–D7 无关。

## 背景

两条命令执行点（`src/runs/acceptance.ts` 的 `runVerifyCommand`、`src/extension/legion-tools.ts`
的 `runLegionCommandNow`）都 spawn 一个 shell：`bash -lc ...`，或 `timeout ... bash -lc ...`。
杀掉这个直接子进程只回收 shell 本身——它 fork 出去的东西（`cmd &`、`node --test`、dev server）
会被 reparent 到 init 继续跑：一次真实的 `node --test` 在它的 run 结束后 44 分钟仍然活着
（`ppid=1`）。

`src/shared/proc-sweep.ts` 是唯一的清扫原语：两个执行点都 `detached: true`（自己的进程组），
在**我们自己结束命令**的路径上清扫整棵树，然后再 settle 结果。

## 冻结决定

### D1 — 监视集包含 root 自己

`sweepProcessTree(rootPid)` 的监视集是 `{rootPid} ∪ 从 procfs 枚举到的后代`。

root 必须在内：它是调用方**真正 spawn 的那个进程**，而且在 shell `exec` 进一个应用之后，
它**就是唯一的进程**。只监视后代会退化成一个具体的假阳性——root 装了 `SIGTERM` handler
（每个长驻服务的形状）、忽略第一次信号、此刻又没有活着的子进程时：不升级、`survivors` 返回
`[]`、调用方 `.catch(() => null)` 连结果都不看，于是「超时 → 等 sweep 完成 → resolve」这条契约
在最要紧的场景里 **resolve 了而进程还活着**（PR #334 review F1）。

### D2 — 升级条件：组内仍有活口就发 `SIGKILL`

grace 到期后，`SIGKILL` 的判据是「**组内仍有活口**」，不是「有枚举到的 pid 存活」：

- 组信号 `kill(-pgid, SIGKILL)` 只要组内还有一个**活着的**成员就发；
- 判活走 procfs，**僵尸算已死**（和 `isAlive` 同一套定义）。刚被 `SIGTERM` 杀掉、还没被 reap
  的 leader 会让 `kill(-pgid, 0)` 成功，把它当活口会让每次干净的 sweep 都虚报一次 `SIGKILL`；
- 被 `SIGKILL` 的目标（含只按 pgid 可达、不在枚举里的组员——grace 期间被 reparent 到 init 的
  孙进程）全部纳入**等待死亡**的集合，最多等 `killAfterMs`。否则 promise 会在某个刚挨了
  `SIGKILL`、还在退场途中的进程身上提前 settle，`survivors: []` 就成了猜测。

`killed` 的计数口径不变：进程组算一次，之后每个 pid 各算一次。

### D3 — 什么算「正常退出」：不杀，只 warn

- 直接子进程**自己退出**了（含 `code === 0`）→ 正常退出，`survivingDescendants()` 收集残留，
  只 warn 一行（`[legion] verify command exited leaving N process(es) running: <命令摘要> (pids …)`），
  一个都不杀。`cmd &` 在验证命令里是合法用法。
- `close` 要等 stdio 全关，所以**未重定向**的 `bash -lc 'sleep 600 &'` 会把 `close` 挂住到
  后台进程结束。此时若直接子进程已经退出（`child.exitCode !== null`），命令就是结束了：按正常
  退出处理（报告残留、用自己的退出码），**不许**因为「管道被占」判超时并杀掉合法后台进程
  （review F3）。warning **只发一次**，后续 `close` 不再重复。
- `legion-verify` 的真实 deadline 是它**内层**的 `timeout(1)`：它到点会杀掉够得着的组员并以
  GNU timeout 的超时码 **124**（或被转发信号打死）退出。`close` 看到 `code === 124` 或
  `child.signalCode` 非空时，按**超时**处理（清扫整棵树），不是按正常退出只 warn
  （review F2）。内层 `timeout` 保留为二重保险。
- 清扫之后如果仍有 `survivors`（`EPERM`、容器边界之类），**warn 一行**报出 pid 数与命令摘要，
  不许静默丢弃 sweep 结果（review F5）。

### D4 — 预算：超时结果最多延后 `graceMs + killAfterMs` = 2.5s

sweep 是异步的，并且 runner 的 promise 会 park 到它完成（D1/D2 的前提）。默认
`graceMs = 2000`、`killAfterMs = 500`（`DEFAULT_GRACE_MS` / `DEFAULT_KILL_AFTER_MS`），所以
**超时/中断结果最多比超时点晚 2.5s 才 resolve**，这段时间记在命令**之外**（verify queue 的等待
不计入 `timeoutMs`，这 2.5s 也不计入——但它确实占用 wall clock）。上层若有总预算门禁，需要把这
2.5s 算进去。grace 是早退的：第一次信号就把全树打死时不会付满窗口。

### D5 — 平台降级

- **非 Linux**：没有 procfs，`enumerateDescendants` 与 `groupMembers` 都返回 `[]`，sweep 退化成
  「给进程组发信号」（组仍然是对的，因为调用方 `detached: true`），`ESRCH`/`EPERM` 都是正常
  结局，永不抛错。
  **正常退出路径上的残留 warn 在非 Linux 上恒为空**（`survivingDescendants` 里两条来源都是
  procfs），也就是说 macOS 上「`cmd &` 残留」既不会被杀也不会被报告——这是已知降级，不是 bug。
- **Windows**：没有进程组可发，直接对 root 发信号（与 #310 之前的行为一致）；判活用
  `kill(pid, 0)`（僵尸的语义由平台决定）。

### D6 — `signal?: AbortSignal` 目前**没有生产调用者**

两个 runner 都接受尾参 `signal`，超时/中断/输出超限三条路径都会先 sweep 再 settle；但
`src/` 里**没有任何调用点传入它**（`defaultVerifyRunner` 不转发，`legion-verify` 只传三个参数；
Pi 的 Esc/TUI 中断不经过这两个函数）。所以「**中断**先 sweep」这半条目前是库级能力，端到端没有
触发者——**中断接线是待办**，不要把它当成已生效的行为写进任何面向用户的地方。传入的
`AbortSignal` 已经是 aborted 状态时仍然立即按中断处理。

### D7 — `rpc-supervisor.ts` 的 retire sweep 不动

`src/supervisor/rpc-supervisor.ts` 的 retire 清扫**零改动**，也不应被本原语替换：它只对每个
后代的 pgid 发 `kill(-<descendant.pgid>)`、从不发 `-rootPid`（RPC 子进程**没有** `detached`，
和宿主共享进程组，`-rootPid` 会把宿主自己带走），节奏由它自己的 `signalTimeoutMs` 决定，
并且窗口之后**无条件** `SIGKILL`。本原语是「我们 spawn 的、detached 的命令树」专用。

## 验收清单

- `npm run typecheck` / `npm test` / `npm run test:integration` 全绿；
- `test/unit/proc-sweep.test.ts` 覆盖：组内孙进程、`setsid` 逃逸、忽略 `SIGTERM` 的**后代**、
  忽略 `SIGTERM` 且**无子进程的 root**（D1，修前必红）、`ESRCH` 吞掉、正常退出不杀只 warn、
  内层 timeout 的 124 路径（D3）、未重定向 `cmd &` 不判超时（D3）、两个 runner 的超时/中断清扫。
- 残余风险（已知、本契约不覆盖）：`DescendantInfo` 不带 starttime，grace 窗口内按快照 pid
  `SIGKILL` 有 PID 复用风险（由 `fix/pid-reuse-race` 分支处理）。
