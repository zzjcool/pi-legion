# #441 — stall 告警：已退休的行不再进候选集，跨机不再恒真

> 状态：已实现 + 已验证（单测 / 变异 / **真机 21 分钟**）。基线 `origin/master` @ `298c235`（6.2.6）。
> 合同：`docs/contracts/stall-candidate-filters-v1.md`（新，FROZEN）；`docs/contracts/stall-notice-v1.md`
> 顶部加一条修订指针（L2 判据被改写，L1/去重/上限/投递路径全部不动）。
> 门禁：`npm run typecheck` ✅ ｜ `npm test` **2860 pass**（trunk 2844，+16）｜ `npm run test:integration` **193 pass**（trunk 193）。

## 0. 一句话

stall 告警现在只对**还活着的 run** 生效（ledger 终态 **或** `run.json` 终态任一成立即出局，`extend` 直接拒绝），
并且 L2 从「只看时钟」改成组合判据：**越过阈值 ∧ 没有工具在飞 ∧（跨机/终端后端）transcript 在窗口内无增长**。
拿不到增长证据 ⇒ `unknown ≠ stalled`，不告警；`working` 的容器（编译 20 分钟、`gh pr checks --watch` 16 分钟）
一律算 working。**反向仍会报**（静默 + 停在提示符 + 无增长 ⇒ 恰好 1 封）。

## 1. 两个缺陷的根因链

### A：候选集只看 ledger 行，而 `run.json` 早已终态

| 事实（今天实测） | 代码位置 | 为什么漏 |
|---|---|---|
| `anotify-doc-purge` 16:45:12 最后一次写 session，`state=retired execution=success acceptance=accepted`，远端 terminal 已撤 | `LegionPostman.runStallNoticeCheck` 只判 `hasEnded(child)`（`nodes.status` / `phase`） | `run.json` 由**跑这个 child 的进程**写，retire 当刻就落 `retired`；`nodes.status` 要等父 **collect** 才动。两者之间的整段时间（本例 1h23m）里，行看起来还活着 |
| 18:08:07 仍收到「running for 1h 45m (threshold 45m 0s)」 | 同上 | 候选集里没有第二来源，`loopBaseAt`（16:23）也还在内存里，于是每一档阈值继续报 |
| 主 agent 会去 `extend` | `extendStallWindow` 用同一个 `hasEnded` | 回执承诺一封永远不会到来的提醒，且不复活任何东西 |

`#423/#430` 补的是「空壳（launch 从未启动）不进候选集」，同一个类别的另一半——**已终态**——没补。

### B：跨机 child 的「no tool in flight」恒真

| 事实 | 代码位置 | 为什么恒真 |
|---|---|---|
| `anotify-vars-ui` 通知 17:38:06、`session.jsonl` mtime 17:38:29（2.1 MB 正在写） | `routing-supervisor.ts`（D12）：`terminal` 后端**不折任何工具事件**；`TerminalSupervisor` 连 `inFlightTool` 都没实现 | 跨机 child 一律 terminal 后端 ⇒ `inFlightTool` 永远 `undefined` ⇒ L2 的 `with no tool in flight` 永远成立 |
| `audit-bulk` CPU 27% / 80 °C 编译；`479-rebase` CPU 49% / 95 °C rebase | `stall-notice.ts` 旧 L2：`now - loopBaseAt >= loopRadiusMs` 即告警 | 「异常」被降格成「跑得久」，而跑得久在大任务上**必然**成立 |
| `flake-478` 阻塞 `gh pr checks --watch` 16 分钟 | 同 D1：栈非空只被当**文案证据**（`inside bash for 38m`），不阻止告警 | 一个在动的 child 每一档阈值都被告知「可能在死循环」 |

## 2. 修法落点

| # | 改动 | 位置 | 钉住它的测试 |
|---|---|---|---|
| A | 候选集二源硬闸：`candidate = !hasEnded(row) && !runEnded(run.json)`；终态集合含 `retired/exited/settled/success/done/failed/aborted/error/truncated`，**不含** `orphaned`/`orphaned_turn_over`（6.2.4 D2 要留给 `recover`） | `src/legion/stall-candidates.ts`（新，纯函数 `stallCandidateVerdict`）、`legion-tools.ts` 候选循环、`extendStallWindow` 同一谓词 | `test/unit/stall-candidates.test.ts`（含 `extend` 拒绝 + 纯谓词表） |
| A（接线） | `run.json` 读取器：按 `nodeId`（回落 name）映射，一次 tick 读一次；`index.ts` 用 `storeRootDir`+本节点 run dir 构造 | `src/runs/child-run-facts.ts`（新）、`index.ts createLegionRuntime` | 同上「wiring」例（真 `RunStore` + 端到端 postman） |
| B | L2 组合判据：`toolBlind` 时只认「容器判定不在 working」∧「增长证据存在且已停 ≥ 半径」；无增长证据 ⇒ 不告警 | `src/legion/stall-notice.ts` `longRunningAnnouncement` | `stall-candidates`（growing / mirror off / never grew / no session / stale+idle 正反各一） |
| B（事实源） | 跨机取镜像泵的 `lastGrowthAt`（`mode === "on"` 且 > 0）；本地 terminal child 取自身 transcript mtime；`readMirrorFacts` 从 `extension/runtime.ts` 移到 `runs/live-mirror.ts` 让「状态行」与「探测器」共用同一个解析器 | `src/runs/live-mirror.ts`、`legion-tools.ts lastSessionGrowthAt` | `test/unit/live-mirror-status.test.ts` 原样通过（`runtime.ts` re-export） |
| B/C（能力与状态词） | 新增 supervisor 只读：`observesToolEvents(name)`（routing：terminal→false，inprocess/rpc→true）、`programState(name)`（terminal 后端一次 `terminal.get` 的 7501 状态词，按需、只在半径已越过时问） | `src/supervisor/types.ts`、`routing-supervisor.ts`、`terminal-supervisor.ts`、`inprocess-supervisor.ts`、`rpc-supervisor.ts` | `stall-candidates` （`programStateReads` 计数：栈已解释 ⇒ 0 次 `terminal.get`） |
| C | `inFlightTool !== undefined` ⇒ **working**，任何年龄都不告警；容器 `working` 同理 | `stall-notice.ts` | `stall-notice.test.ts`（C 例）+ `stall-candidates`（`gh pr checks --watch` / `audit-bulk` / `rebase-479`） |
| 文案 | L2 行改说**真正量到的事实**：`nothing in flight` / `nothing in flight, container status \`idle\`` + `its transcript has not grown for Nm`（旧文案 `with no tool in flight` 对看不见工具的机器是凭空断言）；行语法 `- <name>: ` 不变，`stall-notice-staleness` D2 的解析器不受影响 | `stall-notice.ts longRunningLine` | `stall-notice.test.ts`（L2 文案例）、`stall-notice-obsolete`（未改） |

## 3. 五条验收（机检）

### 3.1 正向（三条 + 反向一条）

| 验收 | 场景 | 结果 |
|---|---|---|
| 1 已退休 | ledger 行 `running`（滞后），`run.json` `state=retired execution=success`，时钟 46m > 45m | **0 通知**；对照：同一行 `state=working` ⇒ **1 通知**（证明是过滤而不是瞎）；`execution.status=success` 单独也够；`extend` → `{reason:"child-ended"}`；对照 live ⇒ receipt |
| 2 跨机 | `host=hw-nj` + 镜像 `lastGrowthAt = now-30s` + 容器 `idle` | **0 通知**；对照（无增长证据：mirror off / never grew / no session / 无镜像行）⇒ 0；反面对照（`lastGrowthAt = now-50m`）⇒ **1 通知**，正文带 `container status \`idle\`` + `transcript has not grown for 50m 0s` |
| 3 长命令在飞 | 本地 child，栈里 `bash` 已 16m（`gh pr checks --watch`），阈值 45m | **0 通知**；同一 child 空栈 ⇒ 1 通知 |
| 4 反向 | 本地 child，空栈，transcript mtime 46m 前，停在提示符 | **恰好 1 通知**（`running for 46m 0s`，带 `steer reaches a child at a turn boundary`） |

### 3.2 变异（逐一确认会红）

```
M0 baseline (no mutation)                        : exit=0  failing=0
M1 delete #441-A run-record filter               : exit=1  failing=2
   ✖ #441-A: a RETIRED child whose ledger row still says `running` is never a candidate
   ✖ #441-A: `execution` alone is enough — a graded turn is over ...
M2 delete #441-B growth gate                     : exit=1  failing=3
   ✖ #441-B: a cross-machine child whose session is GROWING is never announced
   ✖ #441-B: no growth EVIDENCE is `unknown`, never `stalled`
   ✖ #441-B: a tool-blind child is judged by GROWTH (纯判定例)
M3 delete #441-C in-flight suppression           : exit=1  failing=4
   ✖ #441-C: a local child inside a known long command (`gh pr checks --watch`)
   ✖ #441-C: a child the container can SEE inside a command is WORKING
   ✖ postman L2: the role-derived radius fires ... (worker-a 不再出现在告警里)
M4 mute L2 entirely (anti-regression arm)        : exit=1  failing=22
   ✖ #441 reverse: session stalled past the radius ... ⇒ exactly ONE notice
   ✖ #441-B: an idle container with a STALE transcript IS announced
   ✖ #441-C: a LOCAL terminal-hosted child (rebase-479) ... (含其反面半例)
   ✖ L2/D6/#413 全部既有阈值断言
```

M4 是**防「修成永远不报警」**那一条：把 L2 关掉会让 22 个断言变红，其中就包括反向例。

## 4. 真机 21 分钟（`scripts/spike/stall-441-real.ts`）

> 场景：本机真 `hc` core（0.1.21）+ 真 `pi` 1.5.2 child 在真终端里跑 21 分钟（每轮 `bash sleep 60`，
> 不写 session 的编译形状）；真 `LegionPostman` 每 2s tick 写真 `messages` 行；半径压到 5 分钟，
> 同一 child 同一时钟再喂一份**旧规则**（`floor(elapsed/radius)`）当反事实。

| 项 | 结果 |
|---|---|
| 墙钟 | **21 分钟**（tick 2s，22 个分钟采样） |
| 真机通知条数（新规则） | **0 封** |
| 同一 child 同一时钟，旧规则会发的条数 | **3 封**（tier 1/2/3，即 5m / 10m / 15m 各一封，第 3 封后触顶） |
| 容器状态词（真 `terminal.get`） | 21 分钟 **全程 `working`**（`{app:"long-task", state:"working"}`） |
| transcript 增长 | `sessionBytes` 恒为 74、`sessionAgeSec` 1 → 1263（**21 分钟零增长**） |
| 通知里点到的 child 当时是否在增长 | 无通知 ⇒ 空集；时间线逐分钟记 `programState` + `sessionBytes` + `sessionAgeSec`（`docs/reports/stall-441-real-timeline.json`） |
| 阶段 0：真 `pi` child 的状态词 | **`working`**（真 TUI 的 7501，证明读的是真事实而不是我脚本自说自话） |
| 反向相（真终端 `idle` + 50 分钟前的 transcript + 时钟前移 50m） | **恰好 1 封** |
| `working` 词控制（同事实换成 `working`） | 不告警（`workingWordSuppresses: true`） |

反向相那封的原正文（新文案，两个事实都写在行里）：

```
- idle-child: running for 1h 36m (threshold 5m 0s), nothing in flight,
  container status `idle` and its transcript has not grown for 50m 3s.
  It may be looping — check its actual execution context; steer reaches a child at a turn boundary.
```

时间线节选（完整 22 条在 JSON 里）：

```
elapsedMin  terminal  programState  sessionBytes  sessionAgeSec  oldRuleTier  notices
0           live      working       74            1              0            0
5           live      working       74            301            1            0     ← 旧规则第 1 封在这里
10          live      working       74            602            2            0     ← 第 2 封
15          live      working       74            902            3            0     ← 第 3 封（触顶）
21          live      working       74            1263           3            0
```

复跑：`node --experimental-strip-types scripts/spike/stall-441-real.ts --minutes 21`（需 `HC_TERMINAL_SOCKET`）。

## 5. 边界与已知代价（明确接受）

1. **跨机 child 在没有增长证据时不再有 L2 告警**：镜像泵被 `PI_LEGION_LIVE_MIRROR=off` 关掉、泵从未拿到字节、
   或没有 session 文件 ⇒ `unknown ≠ stalled`，静默。这是 issue 的明确要求，代价是「真卡死且没有 transcript」
   只能靠 collect 超时发现。
2. **本地 terminal 后端的 centurion 依赖 `hc` 的 7501 状态词**：`hc` 不可达 / 老 core 不回 `status` ⇒
   `programState` 为 `undefined` ⇒ 不告警（同样按 `unknown ≠ stalled`）。
3. **L2 不再把「栈里有工具」当证据**：一个真挂在工具里的 child 现在要等到它回到提示符才可能被报。这是
   `#441-C` 的直接取舍（16 分钟的 `gh pr checks --watch` 必须不报）。
4. **`run.json` 读取是每 tick 一次小文件读**（不是每个 child 一次）；文件缺失/损坏 ⇒ 该 tick 退回只看 ledger，
   不猜。
5. `extend` 对已终态 child 的拒绝复用既有 `child-ended` reason（不新增 API 面）。

## 6. 门禁

```
$ npm run typecheck       → ok
$ npm test                → tests 2860  pass 2860  fail 0     # trunk 2844 → +16
$ npm run test:integration→ tests 193   pass 193   fail 0     # trunk 193，未下调
```

（trunk 计数取自同一 worktree 在 `master @ 298c235` 的基线运行：`ℹ tests 2844 / pass 2844`。）

## 7. 交付

- 分支 `pi-subagent/hw-nj/pi-legion-441-stall-8c4eaf4f`，PR base `master`，标题带 `Fixes #441`。
- 新增：`src/legion/stall-candidates.ts`、`src/runs/child-run-facts.ts`、`test/unit/stall-candidates.test.ts`（15 例）、
  `scripts/spike/stall-441-real.ts`、`docs/contracts/stall-candidate-filters-v1.md`、本报告 + 时间线 JSON。
- 未做（用户未要求）：不动版本号 / 不打 tag / 不 publish。
