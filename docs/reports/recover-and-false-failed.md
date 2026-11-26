# 6.2.2 真机复跑的 D / E + 自测台 d0 / d1

分支：`fix/recover-and-false-failed`（基线 `origin/master` 4611ce3 = 6.2.2）
版本收口：**6.2.3（patch）**，写在 CHANGELOG 的 `## [Unreleased] — 6.2.3（patch）` 下；**未发版、未打 tag**。

一句话结论：

> **D 已可恢复**（新进程不再需要内存里的 identity，settle 真写回，第二次 `already settled` 且**零 fetch**）；
> **E 不再误判 `failed`**（有 assistant 回复就交付，清理失败降级成 `delivered with cleanup warning` / `secondary:` 且原因在前）；
> **`pi -p` 自己退出**（真机 `make xm` 两次父进程 `natural_exit=true, killed=false`，13s / 6s）；
> 门禁 **2667 单测 + 186 集成全绿**、`make xm` **XM_ALL_PASS**（d0/d1 已从「钉住 bug」翻成正向断言）。

---

## 0. 范围与证据来源

| 项 | 值 |
| --- | --- |
| 分支 / worktree | `fix/recover-and-false-failed` @ `~/code/pi-legion-wt/recover-fix`（独立 worktree） |
| 基线 | `origin/master` `4611ce3`（6.2.2） |
| 验证报告 | `docs/reports/release-6.2.2-verification.md`（PR #400，仅存在于 `chore/verify-622`，不在 master） |
| 真机自测台 | `test/docker/xm/`（来自 `feat/xm-harness`，本分支 merge 进来 —— 断言改动必须同一分支） |
| 真机形态 | 两个容器 `xm-parent` / `xm-remote`、真 ssh 传输、真 `hc` 0.1.21、真 `git` bare origin；`docs/contracts/xm-harness-v1.md` |

本节所有「行号」都是**改动前**（4611ce3）的行号，便于对照 6.2.2 发布包。

---

## 1. 根因（逐条，带行号）

### D — 新会话 recover 不了上一个进程的跨机 child

真机现象两条，其实是三个独立缺陷叠在一起：

1. **identity 只在内存里**。`ownLegionIdentity()`（`index.ts:1709-1710`）只回答
   `ownLegionKey === undefined ? undefined : legionIdentities.get(...)` —— 而 `ownLegionKey`
   只由「本进程 launch 过一次」赋值（`createRootLegion` / `reopenSessionRun` / `attach`）。
   于是「上一个进程已经退出」= `identity === undefined` = 这个 action 存在的**唯一**场景恰好不可用。
   `recoverAction` 因此直接返回 `No legion ledger in this session`（`index.ts:6982`），
   `/legion status` 的 recoverable 块也只是 `identity ? listUnsettledRemoteNodes(identity.db) : []`
   （`index.ts:2440`）→ 什么都不显示。
2. **已经 settle 的行被「远端还活着」抢先判定**。判定阶梯里 live-check 在 already-settled 之前
   （`src/runs/remote-recover.ts:335-420` 的旧顺序）。而 `hc` 的 `terminal.get` 返回的 `state`
   是**终端**的生命周期：程序退出后终端被保留，`state` 永远是 `"live"`
   （`src/runs/remote-artifact.ts:217` 旧 `live = state ∈ {live,running,idle}`）。
   所以第二次 `recover` 永远答 `still live`，行永远不 settle —— 与真机报告一致。
3. **「不重复 fetch」不成立**。read-back 与 terminal probe 在判定之前无条件执行
   （`remote-recover.ts:337-349`），already-settled 分支只是「读了再说」。语义正确，代价是每次重复
   调用都打一轮远端。

### E — 成功的跨机 centurion 被判 `failed`

两个独立缺陷：

1. **`assertLocalWorktree(child)` 站在 collect 的验收路径上**（`src/runs/orchestrator.ts:3515`）。
   跨机 child **拥有**自己的树（`worktreeHost` = 那台机器），于是这个 D13 守卫在**任何 verdict 被
   评出之前**就把整条记录拒了：`worktree '…' belongs to host 'remote': local filesystem and git
   operations on it are refused`。2/2 复现。
2. **清理失败覆盖真因**。launch 失败后的 rollback 里 `removeChildWorktree(...)`
   （`orchestrator.ts:2029`）是**裸调用**：它自己再抛（同一句 D13 守卫）就顶替了 `throw error`
   的原始原因，verdict 只看得见守卫那句话。
3. **`pi -p` 不退出**。终端后端持有一个**会话级** `hc connect` 子进程（`terminal-supervisor.ts`
   的 `client`，`ensureClient()` 惰性创建），而**没有任何地方关闭它**：`retire` 结束的是某个
   child 的终端，不是传输层。`pi --print` 是「turn 结束 → 让事件循环自己排空」
   （宿主 `runPrintMode` 等 `disposeRuntime()` 后 return，从不 `process.exit`），一个 ref 住的
   子进程就是一次永不返回的 headless run。6.2.2 真机里是被手动 kill 掉的。
   自测台其实早就把它当既成事实写在注释里：`drive.mjs:379-385`
   「a parent pi that launched a child can keep its event loop alive … the terminal is ended only if
   the process did not exit by itself」——它**绕过了**缺陷而没有断言它（本次补了 `x0`）。

### d0 — 零配置 `collect` 连 fetch 都没有

`createRemoteSessionReadback` 用 **launch 解析器**解析 host（`src/runs/remote-artifact.ts:320` →
`resolveHostTarget`），而 `resolveHostTarget` 要求 `hosts.<name>.cwd` 是**那台机器上的绝对路径**
（`src/runs/remote.ts:1181-1188`）—— 那是**启动**的问题。零配置启动是「按调用发现目录」，所以
`hosts.<name>` 本来就空 → read-back 在**发动第一次 fetch 之前**就失败，且这个失败被上层吞掉，
调用者只看到随后 D13 守卫那句。`test/docker/xm/assert.mjs` 的 d0 当时把这段现状**钉成断言**
（known-gap），本分支把它翻成正向。

### d1 — `collect` 任何远端 child 必被 `assertLocalWorktree` 拒

与 E-1 同一处（`orchestrator.ts:3515`），只是从自测台看的入口不同：`hosts.<name>` 存在时
pre-wait refresh 确实把 transcript 拉回来了（mirror 非空），随后 `finishCollect` 才拒。修法见 E-1。
另外 `verificationSummary`（`src/extension/legion-tools.ts:2728`）也用同一守卫读**本机文件系统**，
而它的调用者正是 collect head —— 跨机 child 因此丢一整行 `verification:`。按「参数校验按 host 分流」
改成：远端树不再重算 staleness，改为如实报告并标注 `staleUnknown`。

---

## 2. 修法

### D（identity 从磁盘来 + settle 真写回 + 幂等零 fetch）

| 改动 | 位置 |
| --- | --- |
| 新增 `findRecoveryLedgerForName(store, name, {sessionFile})`：**优先级 1** = 本会话 `run.json` 的 `sessionFile` 命中；**2** = store 内最新的、含该 node name 的 run；**3** = undefined（并说明查了哪个目录、谁在等恢复） | `src/runs/remote-recover.ts`（新） |
| 新增 `listRecoverableLeftovers(store, opts)`：`/legion status` 的磁盘扫描版，按 `runId+nodeId` 去重并关闭句柄 | 同上 |
| `recoverAction` 接受 `{store?, sessionFile?}`：没有内存 identity 时用上面的发现结果，**自己 open 自己 close**（`finally`），只有真的找不到才给「哪里查过 + 谁在等」 | `index.ts:7023-7100` |
| `/legion status` 的 `recoverable()` 回落用同一个发现函数 —— 两个界面必须给同一个答案 | `index.ts:2484` |
| 判定阶梯重排：**already-settled 第一且不碰线**（读本地 mirror 的文本；无 mirror 就如实说 `not fetched` + 远端路径 + 取回命令），然后才是 live / unreadable / settle | `src/runs/remote-recover.ts:335-410` |
| 终端「程序是否结束」与「终端是否还活着」拆开：`terminalProgramEnd()`（exit_code / finished_ms / reason / `state==="finished"` / program `done|error` ⇒ 结束），`terminalProgramWord()` | `src/runs/remote.ts`（新） |
| 终端探针改用它：`live = terminalProgramEnd(facts) === undefined`，并带上 `program` / `exitCode` | `src/runs/remote-artifact.ts` |
| supervisor 启动闸门同步用它（`terminalInferred: true`：core 丢注册表不得把启动闸门变成拒绝） | `src/supervisor/terminal-supervisor.ts` |

### E（有回复就交付 + 清理失败降级 + `pi -p` 退出）

| 改动 | 位置 |
| --- | --- |
| D13 守卫从「整条记录」收窄成「**本机命令**」：远端 verify 走 `machine.exec{on}`，没有 remote-verify 就不跑命令（attestation 照旧）；远端树上的**本地 fs/git**（删除 / 复用）仍然拒 | `src/runs/orchestrator.ts:3688-3725` |
| `finishCollect` 变成薄壳：`gradeCollect` 抛错时，若「最后一轮完成且有 assistant 消息」，交付 **`<原 verdict> (delivered with cleanup warning: <原因>)`**，原始原因逐字保留；输出/artifact/ledger 的二次写入全部降级为 best-effort | `src/runs/orchestrator.ts:3598-3660` |
| 新增 `withSecondaryFailures(error, failures)`：原错误在前，清理失败变成 `\n  secondary: …`；`SubagentError` 的 `code`/`details`、`Error` 的 `stack` 都保留 | `src/shared/types.ts:1209` |
| launch 的 rollback 逐步 try/catch 聚合成 `secondary:`（ledger reservation + worktree 删除）；原因为空时才退回清理失败 | `src/runs/orchestrator.ts:2035-2070` |
| `LegionSupervisor.shutdown?()`：终端后端关闭会话级 `hc connect`（幂等、不抛）；`RoutingSupervisor` 转发；`session_shutdown` 在 retire 之后**无条件**调用，且 retire 等待本身有 5s 上限（`SHUTDOWN_RETIRE_BUDGET_MS`） | `src/supervisor/types.ts`, `terminal-supervisor.ts:1229`, `routing-supervisor.ts:359`, `index.ts:1979-2010` |
| 远端树的 `verificationSummary` 不再拒：报记录值 + `staleUnknown: true`，collect head 打印 `staleness not checked here (the tree is on another machine)` | `src/extension/legion-tools.ts:2740-2760`, `index.ts:7840` |

### d0 / d1（自测台钉住的两条）

| 改动 | 位置 |
| --- | --- |
| 新增 `resolveReadTarget(host, config)`：READ 只需要 host（`enabled` + 名字），`mirrorRoot` 只作 fallback；read-back 与 terminal probe 改用它 | `src/runs/remote.ts:1198`, `src/runs/remote-artifact.ts:336/255` |
| `remoteSessionPathFor` 在「无 `remote_dir` 且无 `mirrorRoot`」时返回空并**早于传输层**给出可执行失败（不说一个没写过的目录） | `src/runs/remote-artifact.ts` |
| d1 = E-1 的收窄 + 上面 `verificationSummary` 的 host 分流 | 见上 |

---

## 3. 测试与变异证据

新增 18 条（11 单测 + 7 集成），每条都在**被回退后变红**。变异方式是「把生产代码改回旧行为 → 只跑对应
测试 → 期望失败 → 还原」。

| 变异（回退内容） | 命中测试 | 结果 |
| --- | --- | --- |
| M1 read-back 用回 `resolveHostTarget` | `test/unit/remote-read-target.test.ts` | **RED** (1 fail) |
| M2 `recoverAction` 忽略 store（回到「No legion ledger」） | `test/integration/recover-fresh-process.test.ts` | **RED** (1) |
| M3 already-settled 不再短路（先 fetch/probe） | `test/integration/recover-cross-machine.test.ts` | **RED** (2) |
| M4 `assertLocalWorktree(child)` 回到验收路径 | `test/unit/collect-cleanup-failures.test.ts` | **RED** (1) |
| M5 `finishCollect` 不再兜住抛错 | 同上 | **RED** (1) |
| M6 `throw error`（清理失败顶替真因） | 同上 | **RED** (1) |
| M7 `TerminalSupervisor.shutdown()` 变空操作 | `test/integration/pi-print-exits.test.ts` | **RED** (2) |
| M8 远端树的 `verificationSummary` 回到 `assertLocalWorktree` | `test/unit/collect-cleanup-failures.test.ts` | **RED** (1) |

测试清单：

- `test/integration/recover-fresh-process.test.ts`（4）—— 新进程（`legion: undefined`）**只给 store +
  sessionFile**：能发现 ledger（`findRecoveryLedgerForName` 与 `run.json.sessionFile` 优先于「最新 run」）、
  `/legion status` 出现 recoverable 块与可粘贴调用、`recover` settle 行且给 `execution: success` +
  child 原文 + `read-back from host`、第二次 `already settled` 且 **fake core 请求数不变**、
  unknown name 说清「查了哪里 + 谁在等」。
- `test/integration/recover-cross-machine.test.ts`（既有 6 条中改 1 条）—— 已 terminal 的行按**记录**
  作答：`nothing was fetched` + 记录原因 + 本地 mirror 文本 + **零请求** + 不写事件。
- `test/unit/collect-cleanup-failures.test.ts`（7）—— `withSecondaryFailures` 三种形态；E3 rollout
  失败仍以真因打头；E2「有回复 + verify 抛错 ⇒ success + cleanup warning」；E1 远端树 collect 成功；
  d1 远端树 `verificationSummary` 返回 `staleUnknown`。
- `test/unit/remote-read-target.test.ts`（4）—— 零配置可 READ（对照：launch 解析器同参数拒绝）、
  同一 `mirrorRoot`、`enabled`/host 名仍必须、零配置 read-back 真的 fetch 且路径来自 `remote_dir`。
- `test/integration/pi-print-exits.test.ts`（3）—— `shutdown()` 关且只关一次（第二次无操作）、
  facade 转发、**真 `pi --print` + 真插件**在有界时间内自行退出（本机 1.5s）。
- `test/docker/xm/assert.mjs` —— d0/d1 从 known-gap 翻成正向；新增 **x0**：
  父 `pi --print` 必须**自己退出**（`killed` 即失败）。harness 之前把这个缺陷写成了注释并绕过。

---

## 4. 真机验证（`make xm`，两容器 + 真 ssh + 真 hc）

命令：`cd test/docker && make xm`（mock 驱动，确定性；`xm-up` 重建两容器）

```
XM_ASSERT a1 PASS role-policy
XM_ASSERT a2 PASS machine-list
XM_ASSERT b  PASS launch
XM_EXIT {"id":"x0","step":"launch-a","rc":0,"natural_exit":true,"killed":false,"elapsed_s":13}
XM_ASSERT x0 PASS the parent pi --print exits on its own (no kill, no leftover hc connect)
XM_ASSERT c  PASS remote-artifact
XM_ZEROCONFIG {"id":"d0","mirror_lines":8,"carries_remote_last_assistant":true,"verdict":true,"refusal_signature":null,…}
XM_ASSERT d0 PASS zero-config collect delivers the transcript: mirror lines > 0, verdict present, remote's last assistant text carried
XM_ASSERT c2 PASS remote-artifact
XM_ASSERT d  PASS transcript-readback
XM_REMOTE_COLLECT {"id":"d1","readback_line":true,"verdict":true,"carries_remote_last_assistant":true,"refusal_signature":null,…}
XM_ASSERT d1 PASS collect on a remote child delivers: read-back line, verdict, child text — and no worktree-ownership refusal
XM_EXIT {"id":"x0","step":"launch-b","rc":0,"natural_exit":true,"killed":false,"elapsed_s":6}
XM_ASSERT x0 PASS the parent pi --print exits on its own (no kill, no leftover hc connect)
XM_ALL_PASS run=r-58976dfe,r-709cd887 child=centurion-0,centurion-b
```

`real 0m55.480s`（镜像已在，`make xm` 全程）。

**d0 / d1 前后对比**（同一台自测台，同一断言文件）：

| | 6.2.2（`b7ff3cd` 的 known-gap 断言） | 本分支（正向断言） |
| --- | --- | --- |
| d0 | `collect failed … belongs to host 'remote' …`，mirror 0 字节 | `execution: success`，mirror **8 行**、含远端最后一条 assistant 文本、`read-back … 8 of 8 (complete)` |
| d1 | mirror 非空但 `collect` 被 `assertLocalWorktree` 拒 | `execution: success` + read-back 行 + child 原文，无 ownership 句子 |

**`pi -p` 退出测量**（E2，两个独立的量）：

| 场景 | 命令 | 结果 |
| --- | --- | --- |
| 真机跨机 launch（容器内） | `make xm`（`drive.mjs` 的 `runParentStep`） | `natural_exit=true, killed=false`，**13s / 6s**（曾需手动 kill） |
| 本机真实会话（真插件 + mock LLM） | `node --test test/integration/pi-print-exits.test.ts` | `pi --print` 自行退出 **1.5s**，`status=0` |

---

## 5. 门禁

| 门 | 结果 |
| --- | --- |
| `npm run typecheck` | 0 error |
| `npm run test`（单测） | **2667 pass / 0 fail**（改前 2656，+11） |
| `npm run test:integration` | **186 pass / 0 fail**（改前 179，+7） |
| `cd test/docker && make xm` | **XM_ALL_PASS**（a1/a2/b/x0/c/d0/c2/d/d1/x0） |
| 变异 8 项 | 全部 **RED**（见 §3） |

---

## 6. 顺手修的环境问题（不改断言强度）

`test/docker/xm-up.sh` 把凭据点挂到 `$AGENT`（= 宿主 `$HOME/.pi/agent`），但容器是
`docker run -e HOME=/root`，于是**只有当宿主 HOME 恰好是 `/root` 时**才工作；其它机器上
`/root/.pi/agent/models.json` 根本不存在，`pi --list-models` 回答 `No models available`，
自检却报「settings 的 packages 丢了」。新增 `CAGENT`（默认 `/root/.pi/agent`，可 `XM_CONTAINER_AGENT_DIR`
覆盖）只作**容器侧落点**，`AGENT` 仍是宿主来源。断言一条没放松。

---

## 7. 没做 / 边界

- **不发版、不打 tag、不 force push、不直推 master**：本分支等 review。
- 已 settle 的重复 `recover` 现在**不做任何远端调用**；若本地 mirror 也不存在，只给记录 verdict +
  远端路径 + 取回命令（不再「为了拿一句话再拉一次」）。要拿原文就再看一次 transcript，这是刻意的。
- `remoteVerify` 仍要求 `hosts.<host>`（它要在**那台机器**上跑命令，且需要工作目录语义）；零配置的
  `verify` 会如实报 `unknown-host`，不静默降级。d0 只覆盖**读取**路径。
- 终端 `state` 与程序生命周期的区分只落在 `live`/`finished` 判定上；`hc` 若将来给出更强的
  「程序已退出」字段，`terminalProgramEnd` 是唯一需要加判断的地方。
