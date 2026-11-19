# runId 透传：把「发起方 run」带到 spawn 上下文、run.json 与完成通知（Fixes #414）

- Issue：[#414](https://github.com/zzjcool/pi-legion/issues/414)（`gh issue view 414`，psid 方案已被否）。
- 基线：`origin/master` `0f1e944`（fetch 已执行；`git rev-parse origin/master` = `0f1e944`，与派发声明的基线一致，无新 ref）。
- 分支：`pi-subagent/hw-nj/legion-414-7372b831`。
- PR：[#435](https://github.com/zzjcool/pi-legion/pull/435)（`Fixes #414`）。
- 范围：只做 runId 透传 + 归属事实；**没有**引入 psid / 新 session id / 新 schema 列。
- 没碰：`src/runs/live-mirror.ts` / `live-*`（#429）、`src/runs/launch-evidence.ts`（#423 判据唯一实现）、
  `stall-notice.ts` 去重逻辑。

一句话结论：

> runId 本来就在（`nodes.run_id`、`run.json` 的 `path`/`parentRunId`），缺的是**到 spawn 后端和到通知的那两跳**。
> 现在 spawn 请求体自带 `runId`，terminal 后端用它命名远端目录 / 终端 / `legion.run` 标签；
> 完成通知带上同一个 id；`run.json` 两个方向都能按 runId 反查；**缺 runId 的旧调用方/旧记录逐字保持旧形状**。

---

## §1 现象与根因

今天的现场（#408/#410 事故）：完成通知只写 handle，产出归属只能靠 handle 猜 ——
空壳 `legion-408` 收到了本该属于 `legion-410` 的 PR #422 完成通知。同一台机器上，
两个不同 run 的同名 child 还会共享 `<mirrorRoot>/no-run/<name>/` 与 `lgl-<name>` 终端名。

三处断点（全部在代码里可指认）：

| 断点 | 事实 |
|---|---|
| spawn 上下文 | `TerminalSupervisor` 在 `index.ts` 里 **进程级** 构造（`new TerminalSupervisor()`，无 `runId`），而 run 是之后才创建的。于是 `terminalName(this.runId, …)` 拿到 `undefined` → `lgl-<name>`；`remoteDirFor(target, this.runId, …)` → `no-run`。`SpawnInput` 里根本没有这个字段。 |
| 产出物归属 | `run.json` 的 `ChildRecord.parentRunId` 从 #409 起就会写（父 → 子），子自己的 `run.json` 的 `path` 末段就是父 run（子 → 父）；但 `persistParentReservation` 的**预留行**没写 `parentRunId`，launch 窗口内被杀会留下一条无法反查的记录。artifact id `<runId>/<name>/r<round>` 一直是发起方 run，但没有断言把它钉住。 |
| 完成通知 | 单条通知（`formatCompletionNotice`）只有 handle；只有 grouped 分支有 `Run:` 行。`CompletionDetails` 也没有机器可读的 runId。 |

约束（来自 #414 + 派发）：

- **不做身份层**：psid 被否（零迁移），不复用 session id，不新造字段；
- **兜底**：没有 runId 的旧数据/旧调用方 → 旧形状，不报错、不改渲染；老 `run.json` 必须还能读；
- 另一条在飞的 hold（#417）会动 `src/extension/*` 的通知面 —— 这里只做 runId 的最小插入，不重构。

---

## §2 改法：三个面，同一个事实

### 面 1 — spawn 上下文（`src/supervisor/types.ts`、`src/runs/orchestrator.ts`、`src/supervisor/terminal-supervisor.ts`）

- `SpawnInput.runId?: string`：**发起方 run 的 id**（派发这次 child 的 run）。
  为什么放在 spawn 上而不是 supervisor 构造上：生产是**一个进程一个 supervisor**，
  构造时还没有 run；per-spawn 是唯一能说清「这个 child 属于哪个 run」的通道。
- `Orchestrator` 在 `spawnInput` 字面量里送 `runId: this.artifactRunId()`
  （= `legion.runId ?? basename(runDir)`，与 `recordChild` 写的 `parentRunId`、artifact id 的
  `<runId>` 段**同一个表达式**）。
- `TerminalSupervisor` 新增 `runIdFor(input)`：**spawn 的值优先**，构造函数的值只作兜底
  （测试 / 真正整个生命周期只服务一个 run 的调用方）。三处消费：
  - 终端名：`terminalName(runId, name)` → `lgl-<runId8>-<handle>`（远端 `hc ls` 可见）；
  - 远端目录：`remoteDirFor(target, runId, name)` → `<mirrorRoot>/<runId>/<name>/`（`--session`
    与镜像文件都在里面）；
  - 标签：`terminal.run` 的 `legion.run=<runId>`（**远端可见**的启动上下文）。
- 远端 child 不继承父机 env（D7 的刻意设计），所以「远端可见」的通道就是标签 + 终端名 + 目录名；
  这三处已足够让 `hc ls`/目录列表回答「这个终端/目录是谁的」。

### 面 2 — `run.json` / ledger（`src/runs/orchestrator.ts`、`src/runs/parent-anchor.ts`）

- `persistParentReservation` 的**第一笔写入**就带 `parentRunId`（add + update 两条分支）：
  launch 过程中被杀也不会留下无法反查的预留行。最终 `recordChild` 写的是同一个值。
- 反查 helpers（不新造字段，只读已有事实）：
  - 父 → 子：`RunRecord.children[].parentRunId`（#409 已有）+ ledger `parent_id`；
  - 子 → 父：子 `run.json` 的 `path` 末段（父 orchestrator 的 `childPath` 追加的就是自己的 run id）。
    新增纯函数 `initiatorRunIdOf(record)`（`parent-anchor.ts`）：root 的 `path: []` → `undefined`，
    空白/缺失 → `undefined`（缺事实不猜）。
- ledger：子行 `nodes.run_id` 是自己的 run；`parent_id` 指回发起方行，`parent_id` 那行的 `run_id`
  就是发起方 run —— 两个方向都能走通（测试钉住）。
- 产出物归属元数据：artifact id `<发起方 runId>/<name>/r<round>`（报告/PR 的 ledger 身份）+ `run.json`
  的 `parentRunId`；测试断言 collect 出来的 `artifactId` 以发起方 runId 开头。

### 面 3 — 完成通知（`src/extension/notify.ts`、`src/extension/runtime.ts`）

- `CompletionInput.runId?` / `CompletionDetails.runId?`。
- 单条通知：**有值才加**一行 `Run: <id>`（与 grouped 的既有 header 同形）并写 `details.runId`；
  grouped 通知保留历史的 `details.sessionFile`（它一直存的是 run id）**逐字不动**，只新增 `details.runId`。
- 运行时（`deliverBatch`）把 `surviving[0].runId`（= 这个 child 的发起方 run）交给 formatter。
  这是 `src/extension/*` 里唯一的插入点，没有重排 hold/outbox/claim 的任何逻辑。

---

## §3 兜底（缺 runId 时旧形状逐字不变）

| 位置 | 有 runId | 无 runId（旧调用方/旧记录） |
|---|---|---|
| 终端名 | `lgl-<runId8>-<handle>` | `lgl-<handle>`（原样） |
| 远端目录 | `<mirrorRoot>/<runId>/<name>` | `<mirrorRoot>/no-run/<name>`（原样） |
| `legion.run` 标签 | 写入 | **键不出现**（不是空串） |
| 通知正文 | 多一行 `Run: <id>` | 正文与 #414 之前**逐字相同** |
| 通知 details | 多 `runId` 键 | **键不存在**（`"runId" in details === false`） |
| `run.json` | `parentRunId` / `path` 末段 | 老文件照常 `readRun()`；`initiatorRunIdOf` 返回 `undefined`，不发明 |
| recover 读侧 | — | 仍用记录值 `remote_dir` / `remote_terminal`；缺失时仍走旧猜测（**未改**，#414 硬约束 1/2） |

---

## §4 测试（新增 11 个用例，全部单测）

| 文件 | 用例 | 钉住的事实 |
|---|---|---|
| `test/unit/terminal-supervisor.test.ts` | `#414: SpawnInput.runId names the terminal and the legion.run label` | 终端名 + 标签来自 spawn；同名不同 run 的名字不同 |
| 同上 | `#414: the spawn's runId wins over the constructor value` | per-spawn 优先；无 spawn 值时构造函数兜底 |
| 同上 | `#414: no runId anywhere keeps the legacy shape byte for byte` | `lgl-<name>` + 无标签 |
| `test/unit/cross-machine-params.test.ts` | `#414: a spawn-carried runId names the remote dir, the terminal and the run label` | `mkdir -p <mirrorRoot>/<runId>/<name>`、`--session` 落在其中、终端名/标签、handle 回传；同名不同 run → 目录不同且都不是 `no-run` |
| `test/unit/runtime.test.ts` | `#414: the completion notice carries the run that dispatched the child` | 真实 runtime 交付的通知正文含 `Run: r-…`、details 含 `runId` |
| `test/unit/runid-propagation.test.ts` | spawn body + `run.json` 双向 + ledger | `SpawnInput.runId` → `ChildRecord.parentRunId` → 子 `path` 末段；`initiatorRunIdOf` 双向反查；ledger 两方向 |
| 同上 | artifact id | `collect().artifactId === "<发起方 runId>/worker-0/r1"`（产出物归属） |
| 同上 | 老 `run.json` | 无 `parentRunId`/空 `path` 的文件仍可 `readRun()`；反查返回 `undefined` |
| 同上 | `Run:` 行增量性 | `withRun.content.replace("Run: …\\n","") === legacy.content`；details 只多一个键 |
| 同上 | grouped 形状 | `details.sessionFile` 历史值不变，新增 `details.runId` |

## §5 变异（去掉透传 → 断言红）

每个变异都跑对应测试文件，然后完整还原（`diff` 校验 + typecheck）：

| # | 变异 | 结果（实际断言） |
|---|---|---|
| M1 | 删掉 `Orchestrator` 的 `runId: this.artifactRunId()` | 🔴 `actual: undefined, expected: 'r-2f7625bb'`（runid-propagation） |
| M2 | `runIdFor()` 直接 `return this.runId`（spawn 值不再生效） | 🔴 3 个红：目录 `actual: '…/no-run/root.centurion-0'`；终端名 `actual: 'lgl-root-centurion-0'`；标签 `actual: 'r-constructor'` |
| M3a | 运行时不再往 formatter 传 `runId` | 🔴 `did not match /^Run: r-initiator-1$/m`（runtime） |
| M3b | formatter 删掉 `Run:` 行 + `details.runId` | 🔴 同上（runid-propagation） |
| M4 | 删掉「无 runId → 旧形状」兜底（缺失即 throw） | 🔴 20+ 个旧形状用例红（D4/D2/S1/旧标签…），证明兜底被测试强制要求 |

## §6 门禁

基线：`origin/master` `0f1e944` 的 `npm test` = **2807**。

```
flock /tmp/pi-legion-ci.lock -c "npm run typecheck && npm test && npm run test:integration"
```

- `npm run typecheck`：✅
- `npm test`：✅ **2818** tests / 2818 pass / 0 fail（2807 + 11 新增）
- `npm run test:integration`：✅ **193** tests / 193 pass / 0 fail
- 未降级。

## §7 真机现场（本机 core，不是 hw-nj）

`hc machine ls` → `{"machines":[]}`：本机没有配置 hw-nj，issue 里「在 hw-nj 跑同名 child、不同 run」
无法在这台机器复现；作为替代，用**真实 hc core**（本机 `default.sock`）验证了命名形状与原语：

```
$ node --experimental-strip-types … terminalName("r-1a2b3c4d" | "r-5e6f7a8b", "root.worker-0")
lgl-r-1a2b3c-root-worker-0
lgl-r-5e6f7a-root-worker-0

$ mkdir -p /tmp/legion-414-demo/mirror/{r-1a2b3c4d,r-5e6f7a8b}/root.worker-0
$ ls -d /tmp/legion-414-demo/mirror/*/root.worker-0
/tmp/legion-414-demo/mirror/r-1a2b3c4d/root.worker-0
/tmp/legion-414-demo/mirror/r-5e6f7a8b/root.worker-0

$ hc run --name lgl-r-1a2b3c-root-worker-0 --bg --no-parent --no-notify -- /bin/sh -c 'sleep 120'
{"address":"t7s",…,"name":"lgl-r-1a2b3c-root-worker-0","state":"live"}
$ hc run --name lgl-r-5e6f7a-root-worker-0 --bg --no-parent --no-notify -- /bin/sh -c 'sleep 120'
{"address":"t7t",…,"name":"lgl-r-5e6f7a-root-worker-0","state":"live"}
$ hc ls   # 两个同名 child、不同 run：两个不同终端名并存
$ hc kill t7s && hc rm t7s ; hc kill t7t && hc rm t7t   # 清理，0 残留
```

结论：同名的两个 child 在真实 core 上得到**不同的终端名**；目录同理。远端读取侧没有改：
`recover` 仍只读行里的 `remote_dir`/`remote_terminal`（#414 硬约束 1），因此 v5 行不受影响。

## §8 明确没做

- 没有 psid / session id / 新 schema 列 / 迁移；
- 没有改 `remote-artifact.ts` 的旧猜测兜底（issue 硬约束 2：pre-v5 与 `remote_dir=null` 的行必须还能 settle）；
- 没有改 `live-mirror*`、`launch-evidence.ts`、`stall-notice.ts`；
- 没有改 recover 的读取路径（只读记录值）；
- 完成通知的 hold/outbox/claim 逻辑零改动（只加一个可选字段 + 一行条件渲染）。
