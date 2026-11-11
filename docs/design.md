# pi-legion 设计文档（5.5.0）

> 基线：`pi-legion 5.5.0`（`package.json`）。**代码是唯一事实源**：本文每条结论都落在一个具体源文件/符号上，写不出锚点的内容不写。
> 历史文档：herdr / pane 时代的设计推演与 F1–F46 实验记录已整体移入 [`docs/archive/design-herdr-era.md`](archive/design-herdr-era.md)，本文不复述。旧文档中的 `src/backends/legacy/` 在 v4 已删除。

---

## 0. 核心命题

5.x 的三条承重假设与 herdr 时代完全相反。理解这三条，其余章节都是推论。

| 维度 | 5.5.0 的答案 | 代码锚点 |
| --- | --- | --- |
| 子 agent 跑在哪 | **默认同进程 `AgentSession`**；只有需要 git worktree 的 centurion 才升级为子进程 | `Orchestrator.launch` 的仲裁三元式（`src/runs/orchestrator.ts`）；`DEFAULT_SPAWN_MODE`（`src/supervisor/spawn-mode.ts`） |
| 状态存在哪 | **SQLite（WAL）`legion.db` 四表是权威树**；run 目录降级为会话寻址副本 | `SCHEMA_V1` / `legionDbPath` / `openLegionDb`（`src/legion/db.ts`） |
| 阶段从哪来 | **root 在派发时声明的相位机**；未声明 = 根本没有状态机 | `DEFAULT_PHASE_MACHINE`（`src/legion/phase-machine.ts`）；`Orchestrator.reserveNode` 的条件写入（`src/runs/orchestrator.ts`） |

### 0.1 被推翻的旧假设

| 旧假设（herdr 时代） | 现行事实 |
| --- | --- |
| 执行层 = `tab create` → `pane split` → `agent start` | 执行层 = `RpcSupervisor` / `InProcessSupervisor` / `TerminalSupervisor` 三后端 + `RoutingSupervisor` 仲裁（`src/supervisor/routing-supervisor.ts`） |
| 进程归 herdr server，「父死子活」 | 默认子 agent 就是父进程里的一个 `AgentSession`（`src/supervisor/inprocess-supervisor.ts`），父进程死则会话随之结束；不存在「父死子活」的设计前提 |
| 状态机 = pane 生命周期；阶段固定四步 | 阶段是**可声明机器**（`PhaseMachine`），`nodes.phase` 可为 `NULL`（`#371`） |
| 隔离边界 = tab；原子回收 = `tab close` | 隔离 = git worktree（centurion-only）+ 进程组；回收 = stdin EOF → SIGTERM → SIGKILL → 后代 pgid sweep（`RpcSupervisor.retireChild`） |
| 持久化 = `run.json` + `*.jsonl` | 权威状态 = `legion.db`（nodes/events/usage/messages）；`run.json` 是恢复源与会话寻址副本 |
| `kind` 多后端（cursor/claude/codex/gemini） | `AGENT_KINDS = ["pi"]`（`src/shared/types.ts`），非 `pi` 值解析期被忽略并告警一次 |
| 通知 = 展示层事件 | mail / notice 有独立投递状态机（`messages.delivered` 五值域、`claimForDelivery`、`mail-release`） |

### 0.2 五条不变式

1. **未声明 `phases` ⇒ 无状态机**：`nodes.phase` 保持 `NULL`，`legion_phase` 工具不注册（`Orchestrator.reserveNode`；`legion-tools.ts` 中 `governed` 判定）。
2. **执行结果只从 session jsonl 推导**：`deriveOutcome`（`src/shared/session.ts`）读最后一个 turn 的 `stopReason` 与 `lastTurnOutput`；backend 只提供 settle 信号。
3. **backend 由 launch 推导，不是卡片字段**：`spawnMode` 不在 `AGENT_FRONTMATTER_FIELDS`（`src/agents/agents.ts`），卡片写了会在加载期抛错（`#290`）。
4. **回收是显式、分级、可审计的**：`retire` = 优雅；`stop` = 优雅 retire；`stop --force` = 直接硬化回收（`RetireOptions.graceful = false`）。
5. **ESC 不回收子 agent**：中断父 turn 只返回 `interrupted (parent turn ended; children still running)`（`index.ts`，`esc-no-retire-v3`），回收只走 `/legion stop`、`subagent({action:"stop"|"retire"})` 或进程退出。

---

## 1. 概念

| 概念 | 定义 | 出现位置 |
| --- | --- | --- |
| **root** | 拥有账本的会话。账本里固定一行 `id = "root"` 的节点 | `index.ts` 建 root run 时 `insertNode({ id: "root", parentId: null, … })` |
| **run** | 一次 root 会话的运行单元，对应 `<cwd>/.pi-subagents/runs/<runId>/` | `RunStore`（`src/runs/store.ts`） |
| **node** | 账本里的树节点（root 或任意后代），有 `parent_id` / `depth` / `team` | `nodes` 表；`LegionNode`（`src/legion/nodes.ts`） |
| **child** | `subagent` / `vexillatio` 派发出来的子会话；在 run 里是一条 `ChildRecord`，在账本里是一个 node | `ChildRecord`（`src/shared/types.ts`） |
| **team** | 一次派发携带的 roster（角色 → 成员）；`DEFAULT_TEAM` 不写进 `nodes.team` | `Orchestrator.reserveNode` 的 `team && team !== DEFAULT_TEAM` |
| **centurion** | 唯一可以持有 worktree、唯一可以领一支有相位机的团队的根级角色 | `worktree.ts`；`Orchestrator.launch` 的 G1/G3 守卫 |
| **phase** | 声明式相位机里的一个阶段 id；`nodes.phase` 可以为 `NULL` | `src/legion/phase-machine.ts`、`src/legion/state-machine.ts` |
| **backend** | 子会话的执行后端：`rpc` / `inprocess` / `terminal` | `SPAWN_MODES`（`src/shared/types.ts`） |
| **mail** | 节点之间的异步消息（`legion_mail`），落在 `messages` 表 | `src/legion/mail.ts`、`src/legion/mail-release.ts` |
| **notice** | 平台自动生成的提示：完成通知、stall notice、phase timeout | `src/extension/notify.ts`、`src/legion/stall-notice.ts` |

---

## 2. 架构五层

```text
┌─ 定义层 ─────────────────────────────────────────────────────────────┐
│ agents/*.md frontmatter（严格字段表）+ .pi/settings.json 的 subagents 段 │
│ 解析/校验/模型解析/team 合成：src/agents/*.ts                          │
└──────────────────────────────────────────────────────────────────────┘
                 ↓ AgentConfig
┌─ 编排层 ─────────────────────────────────────────────────────────────┐
│ Orchestrator：launch / collect / retire / 预算 / 血缘 / acceptance      │
│ RunStore：run.json + session 文件；worktree：git 分支交付               │
└──────────────────────────────────────────────────────────────────────┘
                 ↓ SpawnInput
┌─ 执行层 ─────────────────────────────────────────────────────────────┐
│ RoutingSupervisor ─┬─ RpcSupervisor      （pi --mode rpc 子进程）      │
│                    ├─ InProcessSupervisor（同进程 AgentSession，默认）  │
│                    └─ TerminalSupervisor （hc 终端里的真 pi TUI）       │
└──────────────────────────────────────────────────────────────────────┘
                 ↓ 事件 / 状态变更
┌─ 共享状态层 ─────────────────────────────────────────────────────────┐
│ legion.db（nodes/events/usage/messages）+ 相位机 + stall notice        │
│ src/legion/*：db / nodes / events / usage / mail / mail-release / …    │
│ src/shared/*：types / session 解析 / proc-sweep                        │
└──────────────────────────────────────────────────────────────────────┘
                 ↓ 读模型
┌─ 呈现层 ─────────────────────────────────────────────────────────────┐
│ 工具（subagent / vexillatio / legion_mail / legion_tree / legion_phase）│
│ /legion 命令族 + TUI viewer + aboveEditor 状态面板                      │
└──────────────────────────────────────────────────────────────────────┘
```

### 2.1 每层的职责与落点

| 层 | 目录 | 职责 | 关键符号 |
| --- | --- | --- | --- |
| 定义层 | `src/agents/` + `agents/*.md` | 读角色卡、校验 frontmatter、合并 settings/override/team、解析模型候选 | `parseAgentDocument` / `assertKnownFrontmatter` / `parsePhaseMachine`（`agents.ts`）、`loadSubagentSettings`（`settings.ts`）、`modelCandidates`（`model-resolution.ts`） |
| 编排层 | `src/runs/` | 派发、预算、血缘、worktree、collect、验收、run 记录 | `Orchestrator`（`orchestrator.ts`）、`RunStore`（`store.ts`）、`buildPiArgs`/`lineageEnv`（`args.ts`）、`resolveLaunchWorktree`/`createChildWorktree`（`worktree.ts`）、`applyVerification`（`acceptance.ts`）、`acquireVerifySlot`（`verify-queue.ts`） |
| 执行层 | `src/supervisor/` + `src/hc/` | 启动/驱动/等待/中断/回收子会话；三个后端 | `RoutingSupervisor`、`RpcSupervisor`、`InProcessSupervisor`、`TerminalSupervisor`、`HcClient` |
| 共享状态层 | `src/legion/` + `src/shared/` | 账本 schema、树查询、事件、用量、相位机、邮件、卡死检测、session 解析 | `openLegionDb`、`insertNode`/`getSubtree`、`appendEvent`、`sendMail`、`evaluatePhaseTransition`、`parseSessionFile`/`deriveOutcome`、`sweepProcessTree` |
| 呈现层 | `src/extension/` + `src/tui/` | 工具注册、slash 命令、doctor、通知、状态面板、树/overlay 视图 | `registerLegionTools`（`legion-tools.ts`）、`registerLegionCommand`（`legion-commands.ts`）、`runLegionDoctor`（`legion-doctor.ts`）、`deliverCompletion`（`notify.ts`）、`createStatusBoard`（`tui/status.ts`）、`createTreeView`（`tui/tree-view.ts`） |

### 2.2 RoutingSupervisor 的仲裁规则

**第一层（谁决定 backend）在编排层，不在 supervisor。** `Orchestrator.launch` 用一条三元式把 launch 的形状翻译成后端：

```ts
// src/runs/orchestrator.ts，Orchestrator.launch
const mode: SpawnMode = worktree === true
    ? isCenturion && terminalHostAvailable(process.env) ? "terminal" : "rpc"
    : "inprocess";
```

- 不要 worktree → `inprocess`（默认路径，绝大多数派发）。
- 要 worktree → 只有 centurion 能要（`#214`，非 centurion 的 `worktree: true` 会被降级为 `false` 并告警一次）；在 hc 终端里（两个 env 标记都在）用 `terminal`，否则 `rpc`。
- 角色卡没有 `spawnMode` 字段可写（`#290`），所以「显式指定后端」这条路在 launch 路径上不存在。
- 裁决结果会被**写回** `input.agent.spawnMode` 再交给 supervisor，否则 RoutingSupervisor 会按省略值重新解析成 `inprocess` 并撞上 `worktree` 守卫。

**第二层（路由到一个已存在的 child）在 `RoutingSupervisor`：**

| 规则 | 行为 | 锚点 |
| --- | --- | --- |
| 按 `agent.spawnMode` 选后端，并记进 `owners` map | `spawnChild` → `backendOf(mode)` | `routing-supervisor.ts` |
| 同名 child 不允许跨后端注册 | 旧后端仍存活 → `NAME_TAKEN`；已死 → 允许换后端 | `spawnChild` 的 `owners` 检查 |
| `inprocess` 只接受 `kind === "pi"` | 否则 `INVALID_PARAMS` | `spawnChild` |
| `inprocess` 不能带 `worktree: true` | 否则 `INVALID_PARAMS`（唯一非法的组合） | `spawnChild` |
| `terminal` 必须有装配好的后端 | 否则 `INVALID_PARAMS`（不静默降级） | `spawnChild`；`index.ts` 构造时传 `new TerminalSupervisor()` |
| 其余调用按 owner 路由 | `steer` / `abort` / `waitSettled` / `isAlive` / `stats` / `inFlightTool` | 各方法体 |
| 无 owner 时回退 `rpc || inprocess` | 只用于「首次 spawn 之前」的查询 | `isAlive` / `inFlightTool` |
| facade 的能力位只声明所有后端都能答的 | `capabilities.promptDisposition = false`（inprocess 答不了，`#323` D1） | `RoutingSupervisor.capabilities` |

**in-process slot 释放是进程内广播**：`RoutingSupervisor` 把 `onSlotReleased` 挂到 `notifyInProcessSlotReleased()`，每个活跃 `Orchestrator` 用 `subscribeInProcessSlotReleases()` 订阅，用来唤醒 launch-admission 队列（`#266` D2-d-2）。监听者抛错不得打断 retire。

---

## 3. 状态机三维

一个节点同时有三条正交的状态轴。把它们混成一条是 herdr 时代最贵的建模错误。

| 轴 | 存储 | 取值 | 谁写 |
| --- | --- | --- | --- |
| 生命周期 | `nodes.status` | `starting` / `running` / `blocked` / `settled` / `failed` / `retired` | `Orchestrator`（`reserveNode`、`recordSettled`、`retire`） |
| 阶段 | `nodes.phase` + `phase_since` + `rework_count` | 任意声明过的 phase id，或 `NULL` | `Orchestrator.reserveNode`（出生）、`requestLegionPhase`（迁移） |
| 执行后端 | `run.json` 的 `herdr.supervisor` | `rpc` / `inprocess` / `terminal` | `index.ts` 的 `currentProcessSpawnMode()` |

### 3.1 `nodes.status`（六值）

权威枚举是 `NODE_STATUSES`（`src/legion/nodes.ts`）。写入路径：

- 出生：`reserveNode` 写 `starting`；首次真正启动时写 `running`（并落 `sessionFile` / `worktreePath` / `model` / `team`）。
- 收尾：`Orchestrator.recordSettled` 把**执行结果**映射成节点状态——`success → settled`，`failed | truncated → failed`，`aborted | unknown → retired`，同时写 `node_settled` / `node_failed` / `node_retired` 事件并累计 usage。
- 回收：`retire` 把仍非终态的节点写 `retired`（`node_retired` 事件）。
- 安全网：某个子树的所有子节点都失败时，`failTeamIfAllChildrenFailed` 直接把团队标 `failed`；`#372` m2 规定这个 marker 不能被后续正常 turn 覆写回 `settled`。

**注意**：`TaskState`（`queued | launching | working | awaiting | blocked | retired | exited`，`src/shared/types.ts`）是 run store 里的**显示态**，不是账本状态。两者刻意不同：`queued`（admission 队列里还没起来）只存在于内存，`awaiting` 只描述 display。

### 3.2 `nodes.phase`

- 只有**声明了机器**的团队才会写：`reserveNode` 的条件写入是 `...(input.agent.name === "centurion" && input.phases ? { phase: phaseStart(input.phases), phaseSince: … } : {})`。未声明 → `phase = NULL`。
- 复活（resume）的团队保留原来的 phase，不会重新出生。
- 读侧一律把 `NULL` 当「这个节点没有阶段」：`legion_phase` 工具只在 `options.machine !== undefined || self.phase !== null` 时注册（`src/extension/legion-tools.ts`），所以「没有阶段」的节点连工具都没有。
- `rework_count` 由相位机迁移累加（见 §3.4.6）；`contract_path` 在团队**离开机器入口相位**时记录（`requestLegionPhase` 的 `leavesEntry`；终态出边不记，保持内置流水线的历史行为）。

### 3.3 `run.herdr.supervisor`（传输标记）

`RunRecord.herdr` 是历史键名，现在只表示**这个 run 自己的进程跑在哪个后端**（`#209`）：

```jsonc
// run.json（节选）
"herdr": { "supervisor": "inprocess", "node_id": "<node id>" }
```

写入值来自 `currentProcessSpawnMode()`（`index.ts`）：子进程/宿主读作 `rpc`，in-process child 从 AsyncLocalStorage 的 child context 读出真实后端。**它不是配置项**，也不影响任何派发决策——决策永远由 §2.2 的三元式给出。

### 3.4 Phase machine（声明式相位机）

`#298` 把硬编码的四阶段 switch 换成了数据：一份 `PhaseMachine` = 阶段列表 + 每条出边上的条件。`#298` 当时默认机是「省略即生效」；`#371` 把这一点改了：**未声明就是没有状态机**，默认机只有显式声明才会运行（见 §3.4.7）。

#### 3.4.1 默认机形状（`DEFAULT_PHASE_MACHINE`）

| 阶段 | 超时 | 出边（条件） |
| --- | --- | --- |
| `planning` | 15 min | `implementing`（`contract_file`）、`failed`、`aborted` |
| `implementing` | 60 min | 阶段级 `require: [children_settled]`；`reviewing`（`children_present` + `children_none_failed`）、`failed`（`children_all_failed`）、`aborted` |
| `reviewing` | 30 min | `verifying`（`children_present` + `children_settled` + `verdict_ok`）、`implementing`（`verdict_not_ok`，rework）、`planning`（仅 `actorRole: centurion`，通知父级）、`failed`、`aborted` |
| `verifying` | 15 min | `done`（`verification_passed` + `children_settled`）、`implementing`（`verification_failed`，rework）、`failed`、`aborted` |
| `done` / `failed` / `aborted` | — | terminal，无出边 |

「阶段级 `require`」会 AND 进该阶段的**每一条**出边（包括失败出边），这是刻意的：`implementing` 的 `children_settled` 保证带着跑着的子节点没人能离开实现阶段；而 `aborted` 被显式豁免（急救按钮优先于整洁）。

#### 3.4.2 `phases` 的声明口径

| 途径 | 形状 | 约束 |
| --- | --- | --- |
| launch 参数 | `subagent({ phases, start? })` | **ROOT-ONLY**（G2）、**centurion-only**（G3）、**launch-only**；`start` 只对“裸阶段列表”生效，机器对象/JSON 自带 `start` 且优先 |
| 角色卡 | frontmatter `phases:` | 卡片是**回退**，不是覆盖：一次派发自己声明了机器就以派发为准（G4） |
| 三种可接受写法 | 阶段数组 / 机器对象 / 一行 JSON 字符串 / 缩进块 | `parsePhaseMachine` 全部走同一个校验器 |
| 传给子进程 | rpc：`PI_LEGION_PHASES` env；in-process：`ChildLaunchContext.phases`（ALS） | 同一份声明（仅 centurion），两条通道：`Orchestrator.lineageEnv` 写 env（`LEGION_PHASES_ENV`，`src/runs/args.ts`）给真子进程；in-process 子会话与宿主共用一个 `process.env`，于是由 `InProcessSupervisor.phasesFromSpawnEnv` 从 per-spawn env 解析进 `ChildLaunchContext.phases`，消费点 `phaseMachineForNode`（`index.ts`）ALS 优先、env 兜底、再回退角色卡；坏声明降级为“无机器”+warn，不从 provided 模板继承 |
| 重启后复原 | `ChildRecord.phases` 快照 | run.json 记录声明，复活时不丢自定义阶段名（`#374` §4） |

#### 3.4.3 条件词汇表（`PHASE_CONDITIONS`）

`always` / `contract_file` / `children_settled` / `children_present` / `children_none_failed` / `verdict_ok` / `verdict_not_ok` / `verification_passed` / `verification_failed` / `rework_available` / `children_all_failed`。

条件全部在 `src/legion/phase-conditions.ts` 里求值，输入是「子节点快照 + 契约路径 + 最新 settled 子节点的 verdict + 验证结果 + rework 计数」。求值器遇到未知条件名直接抛错（而不是静默放行）——放行会让一个没达标的团队推进。

#### 3.4.4 拒绝点

**加载期（写坏一张卡就该在加载时报错，而不是跑完一支队伍才报）：**

- `parsePhaseMachine` / `validatePhaseMachine`：空机器、非法/重复阶段 id、未知条件、`next` 不是数组、未知目标、自环、terminal 阶段声明出边、非 terminal 阶段零出边、`start` 未声明或本身是 terminal、从 start 不可达的阶段、`maxRework` 不是非负整数；launch 路径额外要求**声明图**能到达终态（`requireTerminal: true`，判的是作者写的图，不是补过 `done` 的归一化图）。
- `assertKnownFrontmatter`：卡片写了不在字段表里的键 → 硬错（含拼写近似）。

**运行期（`evaluatePhaseTransition` 的拒绝理由）：**

`invalid_phase` / `same_phase` / `terminal_phase` / `invalid_transition`（消息里会列出当前合法出边）/ `contract_path_required` / `children_not_terminal` / `all_workers_failed` / `reviewer_not_settled` / `review_verdict_not_accepted` / `review_verdict_not_rejected` / `verification_not_passed` / `verification_not_failed` / `rework_limit_exceeded` / `centurion_required` / `actor_not_permitted` / `condition_not_met` / `terminal_reason_required` / `all_children_not_failed` / `injected_done_is_supervisor_only`。

#### 3.4.5 归一化与 supervisor-only 的 `done`

`normalizePhaseMachine` 给缺失的 `done` / `failed` / `aborted` 补成 terminal 阶段，并给每个非 terminal 阶段补一条**无条件的注入边**，保证团队永远不会被卡死。代价是安全漏洞，所以注入边带 `injected: true` 标记：

- 注入的 `→ done` **只有 supervisor 能走**（`evaluatePhaseTransition` 在 `require` / `actorRole` 之前就拒绝其他 actor，理由是「你的机器没有这条出边」）。
- `aborted` 永远由父级/supervisor 决定（`terminalReason === "parent_retire"`），任何角色自己请求都会被 `requestLegionPhase` 拒绝。
- `failed` 需要给理由：`parent_decision` / `all_children_failed` / `rework_exhausted` 三者之一。
- 一个**自己声明了** `… → done` 出边的机器，把这条出边交给团队；`maySelfComplete` 只看作者声明的边，不看注入边。

#### 3.4.6 `maxRework` 语义

- 机器级 `maxRework`，缺省 `DEFAULT_MAX_REWORK_COUNT = 2`。
- 只有带 `rework: true` 的出边会累加 `rework_count`（默认机的 `reviewing → implementing` 与 `verifying → implementing`）。
- 第 `maxRework + 1` 次会得到 `rework_limit_exceeded`，并附带 `forcedTransition: { to: "failed", reason: "rework_exhausted" }`——不是「继续等」，而是判死。
- 一个**不带 `rework` 标记**的回退边不消耗预算（自定义机器可以做无限次“重看”，但要自己承担成本）。

#### 3.4.7 未声明 = 无状态机（`#371`）

- `nodes.phase = NULL`，`phase_since = NULL`。
- 没有 `legion_phase` 工具（注册即门禁，模型无法“说服”一个不存在的工具出现）。
- 没有 collection prompt / 收队提示（`index.ts` 的 `phases` 参数说明：“no phase, no `legion_phase` and no collection prompt”）；centurion 变成一个「恰好可以派活的普通 agent」：干完活交 verdict 就结束。
- 想让一支队伍走四阶段流水线，必须显式声明：`subagent({ agent: "centurion", phases: [...] })`，或在 centurion 卡片里写 `phases:`。

#### 3.4.8 phase 超时只是通知

`checkOwnPhaseTimeout`（`src/extension/legion-tools.ts`）在 postman tick 里比对 `phase_since` 与阶段超时：显式配置 `subagent.legion.phaseTimeouts` 优先，其次机器声明的 `timeoutMs`，再其次内置表；超时就发一封 `Phase timeout:` 邮件。**它不杀任何人**，也不改 phase——「超时」是给父级的一个决策输入，不是执行动作。

---

## 4. 树结构

### 4.1 `nodes` 表就是血缘树

```sql
-- src/legion/db.ts，SCHEMA_V1
CREATE TABLE nodes (
  id TEXT PRIMARY KEY,
  parent_id TEXT REFERENCES nodes(id),
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'pi',
  depth INTEGER NOT NULL,
  run_id TEXT, session_file TEXT, worktree_path TEXT, model TEXT, team TEXT,
  status TEXT NOT NULL, phase TEXT, phase_since INTEGER,
  rework_count INTEGER NOT NULL DEFAULT 0,
  contract_path TEXT, task_summary TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
```

- **root 行**：`id = "root"`、`parent_id = NULL`、`depth = 0`，在 root run 建立时插入（`index.ts`）。
- **血缘**：`parent_id` 外键 + `depth`；子树用递归 CTE `getSubtree` 查（`src/legion/nodes.ts`），带 `maxDepth` 上限（`DEFAULT_SUBTREE_MAX_DEPTH = 64`）。
- **team**：只有非 `DEFAULT_TEAM` 才落库（`Orchestrator.reserveNode` / 启动时 `team: team && team !== DEFAULT_TEAM ? team : null`），因此 `NULL` 读作「默认 roster」。
- **名字**：`[a-z][a-z0-9_-]{0,31}`（`NODE_SLUG_PATTERN`）；node id 由 child 名派生（`nodeIdForChild`），同名不同 run 是两个 node。
- **身份**：`session_file` 是会话寻址凭据，也是 resume 的唯一凭据；`PI_LEGION_NODE_ID` 加 `PI_LEGION_DB` 是子进程认领自己那一行的方式（`index.ts` 会校验 session 路径，拒绝继承来的错身份）。

### 4.2 run 目录

`<cwd>/.pi-subagents/runs/<runId>/`：

| 项 | 用途 |
| --- | --- |
| `run.json` | run 记录（children、预算、lineage、`herdr.supervisor`）；原子写（`.tmp` + rename），损坏时隔离为 `run.json.corrupt` 并返回 `null` |
| `<name>.jsonl` | 子会话 session 文件（预创建为空文件，避免 pi 惰性建文件造成的数据丢失窗口；也是 resume 凭据） |
| `out/` | 产物目录（`artifactDirFor`，按需创建） |
| `worktrees/<name>/` | centurion 的 git worktree（retire 后**保留**） |
| `rpc-child-*` | RPC 子进程临时目录，由 hygiene 按 owner pid 清扫 |

**没有 workspace / tab / pane 三层。** 隔离只有一种：git worktree（且只有 centurion 能要）。进程级隔离只是 rpc/terminal 后端的附带效果，不是设计承诺（in-process 子会话与父共享进程、cwd 与内存）。

---

## 5. 回收策略

### 5.1 三个入口

| 入口 | 语义 | 代码 |
| --- | --- | --- |
| `subagent({ action: "retire" })` | 优雅回收；已回收的是 no-op | `retireChild`（`index.ts`）→ `Orchestrator.retire` |
| `subagent({ action: "stop" })` / `/legion stop [name|all]` | 同优雅回收；`stopAction` 按 run 作用域解析名字（`#312`） | `legion-stop.ts` / `index.ts` |
| `subagent({ action: "stop", force: true })` / `/legion stop --force` | 硬回收：跳过优雅阶段，直接硬化链 | `RetireOptions.graceful = false`（`src/shared/types.ts`） |

### 5.2 RPC 后端的回收顺序（`RpcSupervisor.retireChild`）

```text
1. 快照后代进程（enumerateDescendants）        ← 必须在杀父之前
2. graceful ? stdin.end()（EOF）→ 等 retireTimeoutMs（默认 5s）
3. 仍存活 → SIGTERM → 等 signalTimeoutMs（默认 1s）
4. 仍存活 → SIGKILL → 等 killTimeoutMs（默认 1s）
5. sweepDescendants：对每个后代 pgid 发 TERM（负号发组），再对每个 pid 发 TERM
   → 等 signalTimeoutMs → 对 pgid/pid 各发 SIGKILL
6. 仍存活 → 抛 RETIRE_FAILED（不谎报成功）
```

要点：

- **先枚举后代再杀父**：父一死，`/proc` 里的父子关系就断了，后代再也找不到。
- **stdin EOF 是优雅信号**，不是 `ctrl+d` 按键、不是 pane close；代码里没有 pane/tab 概念。
- 后代清扫同时按 **pgid** 和 **pid** 发信号，并跳过自己的 pgid，避免自杀。
- `sweepDescendants` 的等待定时器**不能 unref**：它可能是驱动 caller await 的唯一句柄。

### 5.3 另两个后端

| 后端 | 回收方式 | 说明 |
| --- | --- | --- |
| `inprocess` | `session.dispose()`，然后释放 slot | 没有子进程、没有进程树可扫；`retireChild` 忽略 `graceful`（没有 stdin 可关） |
| `terminal` | `terminal.kill` → `terminal.rm`（rm 失败是 best effort） | 终端已被 core 遗忘（`not found`）视为已回收；其他错误照常上抛 |

### 5.4 保留与级联

- **session 文件保留**：retire 只停会话，不删 transcript —— 它是 resume 的唯一凭据。
- **worktree 保留**：retire 后目录留在 `runs/<runId>/worktrees/<name>`，hygiene 也明确不删带 `worktrees/` 的 run 目录。
- **父退出**：root 会话正常关闭时 `shutdownRetire` 会回收**自己这一支**的 children（`index.ts` 的 shutdown 路径）；异常死亡留下的行由 orphan 扫描收敛为 `failed` + `node_abandoned`（`LegionPostman.scanOrphans`），并由启动卫生再扫一遍。子会话的交付语义绑定在父的 collect 上，不存在「父死子继续交付」。
- **ESC 不级联**：父 turn 被中断只返回 `interrupted`，子 agent 继续跑（`esc-no-retire-v3`）；「杀掉父 tab 子进程继续完成任务」的 herdr 结论已作废。
- **名字释放**：回收后名字可复用（注册表按 owner 判活）。

---

## 6. 配置规范

### 6.1 角色卡（`agents/*.md`）

frontmatter 走**严格字段表**：`AGENT_FRONTMATTER_FIELDS`（`src/agents/agents.ts`）之外的键在加载期直接抛错，错误信息会列出全部合法键。字段分组：

| 组 | 字段 |
| --- | --- |
| 身份 | `name`、`description`、`kind`、`model`、`thinking`、`alias`、`aliases`、`preset`、`team`、`output`、`fallbackModels` |
| 上下文 | `systemPromptMode`、`inheritProjectContext`、`inheritSkills`、`inheritExtensions`、`excludeExtensions`、`skillPath`、`skills`、`defaultReads` |
| 工具 | `tools`、`extensions`、`subagentOnlyExtensions` |
| 预算/守卫 | `defaultProgress`、`async`、`timeoutMs`、`toolTimeoutMs`、`loopNoticeMs`、`completionGuard`、`maxSubagentDepth`、`allowNestedSubagents`、`renewable`、`maxRenewals`、`utility`、`disabled`、`worktree`、`steer`、`onBlocked`、`toolBudget`、`turnBudget` |
| 阶段 | `phases` |
| 验收 | `acceptance`（`level` / `role` / `criteria`） |

口径澄清（这三条最容易被旧文档带错）：

- **`kind` 只有 `pi`**：`AGENT_KINDS = ["pi"]`。写了别的值不会报错，但解析层会忽略并告警一次，角色仍按 `pi` 启动（`parseKind`，`src/agents/agents.ts`）。旧的多 kind 降级表不存在。
- **`placement` 不是字段**：它曾是 pane 时代的布局提示，解析期被主动丢弃（`src/agents/settings.ts` 的注释与归一化逻辑）；字段表里没有它，所以现在写它等于写一个未知键。
- **`spawnMode` 不是卡片字段**（`#290`）：写了会在加载期抛错；后端由 launch 需要不需要 worktree 推导（§2.2）。
- **`worktree` 仅 centurion**：`centurion` 卡片写 `worktree: true`；非 centurion 请求 `true` 会被降级为 `false` 并告警一次（`Orchestrator.launch`）。
- **`phases`**：卡片可声明，但它是**回退**；root 在派发时显式声明的机器优先。

### 6.2 settings（`.pi/settings.json` 的 `subagents` 段）

| 键 | 默认 | 含义 |
| --- | --- | --- |
| `subagents.enabled` | `true` | 总开关；关闭后拒绝新 launch，但控制类动作（status/collect/wait/…）仍可用 |
| `subagents.legion.maxDepth` | `4` | 血缘深度上限 |
| `subagents.legion.maxChildrenPerNode` | `8` | 单节点直接子节点上限 |
| `subagents.legion.maxActiveNodes` | `30` | 全树活跃节点上限 |
| `subagents.legion.phaseTimeouts` | planning 900s / implementing 3600s / reviewing 1800s / verifying 900s | 阶段超时（仅发 notice） |
| `subagents.legion.verifyCommandTimeoutMs` | `600000` | 验收命令超时 |
| `subagents.legion.worktreeBootstrap` | `""`（关闭） | worktree 创建后的 provisioning（`npm-install` 或 shell 命令） |
| `subagents.legion.worktreeBootstrapTimeoutMs` | `600000` | 上述超时 |
| `subagents.legion.mailRatePer5Min` | `10` | 每个 sender 的 mail 限流 |
| `subagents.legion.usagePollMs` | `30000` | usage 轮询间隔 |
| `subagents.legion.orphanStaleMs` | `90000` | orphan 扫描阈值 |
| `subagents.legion.silenceNoticeMs` | `120000` | L1 stall 检测阈值（`0`/负值关闭） |
| `subagents.inprocess.*` | `maxActive` 8（显式块省略时）/ 30（无显式块）；`maxQueuedLaunches` 32、`launchQueueTimeoutMs` 900000、spawn 启动超时 15s | in-process 并发池、排队上限与启动超时（与 legion 预算取严，`InProcessLimits`） |
| `subagents.rpc.approve` | `false` | RPC 子进程是否带 `--approve`（只影响 rpc 后端） |

默认值集中在 `DEFAULT_LEGION_SETTINGS`（`src/shared/types.ts`）与 `DEFAULT_INPROCESS_*`（`src/supervisor/spawn-mode.ts`）。

### 6.3 model 优先级（Model precedence）

一个子 agent 最终用哪个 model，由一条固定顺序的候选链决定（`resolveModel`，`src/agents/model-resolution.ts`），**从强到弱**：

| 级 | 来源 | `ModelSourceInfo.type` | 判源（`modelOrigin`） |
| --- | --- | --- | --- |
| 1 | 本次调用传入的 `model`（`model:` / `tasks[].model`） | `dispatch` | `explicit` |
| 2 | 被引用 preset 的 model（`subagents.presets.<name>.model`） | `preset` | `explicit` |
| 3 | 当前 team 的 member override `model`（`subagents.teams.<name>.members[].model`；`applyTeam` 折进 `agent.model` 并写 `modelSource.type = "team"`） | `team` | `explicit` |
| 4 | `subagents.agentOverridesByProvider.<父 provider>.<role>.model`（**此级只作用于 `model`**；`thinking` / `preset` / `disabled` 等其余字段在本级不生效，请用第 5 级 `agentOverrides` 配） | `agentOverrides` | `explicit` |
| 5 | `subagents.agentOverrides.<role>.model` | `agentOverrides` | `explicit` |
| 6 | 角色卡 frontmatter `model`（含被折叠进来的 `subagents.defaultModel`） | `frontmatter` / `subagents.defaultModel` | 前者 `explicit`，后者 `inherited` |
| 7 | `subagents.defaultModel` | `subagents.defaultModel` | `inherited` |
| 8 | 派发方（父会话）当前的 model | `dispatch` | `inherited` |

口径（与代码一一对应）：

- **per-run model 是最高级**：调用方传的 `model:` 就是本次运行的选择，任何配置都不能覆盖它。
- **preset 是原子的**：`kind` / `model` / `thinking` 出自同一个 preset 对象，不会出现"A 的 model 配 B 的 thinking"；引用不存在的 preset 是错误，不回退到派发 model（`expandPreset` / `requirePreset`）。
- **team member 的 `model` 与它的 `preset` 同级**：team member 的 `preset` 已经走第 2 级，同一个 member 的 `model` 若屈居第 6 级就变成"两个字段不同级、不自洽"；而且"本次选了哪支队伍"比"全局按角色钉死"更具体。因此 `applyTeam` 在折叠 member `model` 时给它打 `modelSource: { type: "team", model }`，候选链据此在第 3 级单独认它，**压过 `subagents.agentOverrides` 与 provider 作用域 override，输给 preset 与本次调用的 `model`**。tag 只在成员 `model` 为非空白字符串时打（纯字符串成员、只给 `preset` 的成员都不打），且 `modelSource.model !== agent.model` 的陈旧 tag 一律忽略（按 frontmatter 处理），否则脏 tag 会把普通 model 非法抬到第 3 级。
- **team 选择在 in-process 子树里同样生效**（B9）：team 的选定只有三档——`PI_SUBAGENTS_TEAM` > `subagents.team` > `default`（`resolveActiveTeamName`，`src/agents/teams.ts`）。rpc 子进程把这次选择当真实环境变量收下；**in-process 子会话与父共用一个 `process.env`**，所以父为「这一次 spawn」选的 team 到不了它手里，工具 `team:` / 卡片 `team:` / resume 的 `node.team` 在孙会话里全部静默失效——连带第 3 级（team member 的 `model`）根本不发生。通道因此改成 ALS：`ChildLaunchContext.team` 由 `InProcessSupervisor` 从 `SpawnInput.env`（`TEAM_ENV`，**按键存在判定**，所以显式 `team: "default"` 可表达且压过 settings 里的 team）抬进上下文，`loadCatalog`（唯一消费漏斗）把该值当 env 覆盖交给 `applyTeam`；root（上下文无 team）逐字走原链路。`provided` 与 `fallback` 两条 context 分支都要合，前者提前 return，漏掉就让 legion 路径失效。禁止写 `process.env`（见 `child-context.ts` 顶部：env 通道没有 ALS 的那层隔离）。
- **子会话身份 role / utility 在 in-process 子树里同源**（R6）：`PI_SUBAGENT_ROLE` / `PI_SUBAGENT_UTILITY_CHILD` 本是 rpc 通道——rpc 子进程真的拥有这些环境变量，in-process 子会话却与宿主共用一个 `process.env`，于是读到的要么是**父的角色**（孙会话从 roster 里剔错人），要么什么都没有（root 把自己的角色也列进 roster）；utility 判定同理，in-process utility 子会话拿到父的判定，给硬叶子注册了 `vexillatio` 并注入父 playbook。故 **`role` 由 ALS 承载（key-presence）**：`InProcessSupervisor.roleFromSpawnEnv` 与 `teamFromSpawnEnv` 同构（**按键存在**判定、两条 context 分支都合、`...role` 置于 `...provided` 之后），`index.ts` 的 role 读点统一 ALS 优先、env 兜底（`currentChildContext()?.role ?? process.env[PI_SUBAGENT_ROLE]`）；**`utility` 只是读点变了**：`ChildLaunchContext.utility` 的写入路径（`Orchestrator` 构造 context）早已存在、本轮未动，新增的只是 `index.ts` 里 ALS 优先、env 兜底的 `isUtilityChild()`。没有 ALS context 的 rpc 路径逐字不变。**role 不从 `provided` 模板继承**：模板可跨 spawn 复用，继承等于把 A 的角色泄漏给 B，它只能由 per-spawn 的 env 授权。budget **不是**缺陷：`d13ad87` 已把它放进 orchestrator 构造的 context，且**不得**在 `provided` 分支再合 env——消费端 `effectiveChildBudget` 是整对象替换，那样会把「context 优先」隐性翻成「env 优先」。残留的只是同一个 budget 被算两遍，现已收敛到唯一 producer `childBudgetFromAgent`（`src/extension/budget.ts`），env 键名与取值逐字不变。
- **空白字段不算选择**：`tasks[].model` / `tasks[].preset` 为空白串时让位给顶层 `model` / `preset`，传给候选链的是 trim 后的值（`resolveStepModel`，`src/agents/step-model.ts`）。
- **`inherit` 哨兵**：任一候选值等于 `inherit` 时解析为父会话的 model，判源 `inherited`。**父会话没有 model 时是拒绝，不回退**（`resolveModel` 抛 `SubagentError` + `INVALID_PARAMS`，文案里带上角色名与 `subagents.defaultModel` / 显式 `model` 两条出路）：`inherit` 的全部语义就是"用父会话的 model"，没有可继承的对象时退回"不带 `--model`"并不安全——`Orchestrator.launch` 会回读 `agent.model`（字面量 `inherit`）并拼出 `--model inherit`，子进程直接以 `Model "inherit" not found` 死。配套口径：`subagents.defaultModel: "inherit"` 在设置解析期就被拒（全局默认表达不了"继承本次会话"，而且会把上面这条变成每次 launch 都失败）；`modelCandidates` 把哨兵从候选里滤掉（只对绕过 `resolveModel` 的直接调用生效）；`/legion doctor` 不把它当成 registry 里缺的 model；`/legion agents` 对这一形态显示 `needs a parent session model — a launch would refuse this`，不再谎报 `(agent CLI default)`。
- **`thinking` 压过 model 串里的 `:level`，per-run 例外**：`thinking`（preset / team member / 卡片 / `agentOverrides`）是显式配置的专用字段，model 串自带的 level 是它的粗略版本，两者冲突时以 `thinking` 为准——`resolveStepModel`（`src/agents/step-model.ts`，两条后端共用的唯一入口）在解析出口把已知 level strip 掉，下游 `applyThinkingSuffix` 再按 `thinking` 重新拼，所以 rpc argv 与 in-process model ref 不会分叉。**例外是本次调用传的 `model`**：调用方在这一跑里写 `provider/model:high` 是更强、更具体的信号，下层的 `thinking` 不能推翻它。`thinking` 未配置（`undefined`）时不剥离——写在 model 串里的 level 是操作者唯一的 thinking 选择。`thinking: false` 同样剥离：留着 `:level` 会把 reasoning 重新打开，`false` 的效果就是"不追加 level 且去掉串里的 level"。只剥离已知 level，`provider/model:variant` 一律保留（`splitThinkingSuffix`）。
- **展示只有一种 running form**（R8 D-R8.1/D-R8.2）：凡是把 `model` 与 `thinking` 并列显示的地方，都走 `modelLabel(model, thinking)`（`src/agents/model-scope.ts`），不再各自拼串——否则同一个子会话在 status widget、`/legion summary` 与 `/legion agents` 里会显示成两个不同的 model。规则：model 串带**已知** level 时后缀赢（`applyThinkingSuffix` 保留它，`cb/x:high` + `max` 就是 `cb/x:high`）；带**未知**后缀（`provider/model:variant`）时既不剥也不拼，因为那是 model id 的一部分；否则把已知 level 拼上。`thinking: false` 不显示 level（summary 另给一个 `thinking: off` bit，否则"关掉 reasoning"不可见），`off` 本身是真实生效值、要显示（旧 widget 把它吞了）。台账（`nodes` 表）没有 `thinking` 列且不升级 schema，所以 tree/live overlay/`formatTree`/node-only status entry 只显示 model，不得凭空补 level。
- **记录写实际生效的 level**（R8 D-R8.4）：`ChildRecord.thinking` 记录的是子会话真正运行的 level——model 串自带已知 level 时记**那个** level，否则记 `input.thinking ?? agent.thinking`。resume 回放 `saved.model = "cb/x:high"` 配上卡片的 `thinking: max` 时实际跑的是 `:high`，旧记录写 `max`，于是 run.json 与 summary 一直在说谎。只改记录值：spawn 用的 `thinking`、model 串与 argv 一律不动。
- **doctor 的模型可见性判定同样只剥已知 level**（R8 D-R8.3）：`modelMatches` 用 `splitThinkingSuffix`，与上面两个口径同源；旧的"砍掉最后一个 `:` 段"会把 `provider/model:variant` 截成 `provider/model`，把 host 真实提供的 model 报成缺失。
- **判源决定 `modelScope.enforce` 的力度**（`checkModelScope`，`src/agents/model-scope.ts`）：`explicit` → `error`，拒绝启动并打一行 `✗`；`inherited` → `warn`，打一行 `⚠` 后**照常启动**。判源由 `classifyModelOrigin`（`src/agents/step-model.ts`）唯一给出，launch 与 utility（vexillatio）两条路径都传真实 origin，不再硬编码。
- **折叠后的默认模型保持 inherited 身份**：`applyDefaultModel` 把 `subagents.defaultModel` 折进 `agent.model` 并写 `agent.modelSource`；第 6 级只在 `modelSource.model === agent.model` 时把它报成 `subagents.defaultModel`，否则按 frontmatter 处理。否则"配置的默认 model"会被当成显式违规拒掉。
- **`continue` / `resume`**：本次调用显式传 `model` 用它，否则沿用 `ChildRecord.model`；`preset` 不在 revive 上展开，子会话沿用它被持久化的 model。
- **provider pin 跟着 model 一起回放**（#123）：首启为候选 0 算出的 provider 落在 `ChildRecord.modelProvider`（只进 `run.json`；`legion.db` 的 `nodes` 没有 provider 列，本版不升级 schema，所以只能从 run 记录读）。`continue` / `resume` 沿用记录 model 时成对回放它；本次调用显式传的 `model` 与记录**相同**时仍沿用记录的 pin（custom id 在 registry 里查不到，重算只会把它丢掉），不同才改用父 registry 现算。回放前用当前 registry 校验 pin：上次由扩展注册、这次没加载的 provider（#123 原场景）会被跳过而不是硬钉——`Unknown provider` 是致命错误，比不 pin 更糟；registry 拿不到时不校验。命中 fallback 候选（非候选 0）时 spawn 不带 pin，也不落 provider（候选 0 的 pin 发给 fallback = 路由到错端或 `No API key`，fallback 形同作废）——宁可下次不 pin，也不钉错；同名 relaunch 换了 model 就丢掉旧 pin（只有新 model 与旧记录相同才允许沿用）。`providerForModel` 匹配前先 strip 已知的 `:thinking` 后缀（registry 的 id 不带它），否则带后缀的 model 永远匹配不上。
- **model 解析 warning 可见但不致命**（B5）：`resolveCliModel` 对「未注册的 model id」（`Using custom model id.`，合法用法）与「非法 thinking 后缀」给出 `warning`。in-process 后端经 `onNotice` → `handle.warning` 把它透出来，launch 结果在 `▶` 行后、`continue`/`resume` 结果在 `Resumed …` 行后都追加一行 `  ⚠ <name>: <warning>`（与 `modelScope` 的 inherited 警告同样式）；排队 child 的 `▶` 行在入队时就打过了，所以它的 warning 由准入通知 `▶ … started after queued Ns` 带上。rpc 路径没有这个字段（子进程自己会报）。任何 `warning` 都**不得**升级成启动失败。
- **provider 作用域**：第 4 级的 key 是"父会话的 provider"（`providerOf(dispatchModel)`），因此同一份角色配置可以按 provider 各写一套；user/project 两层设置按 provider 深合并（`resolveSubagentSettings`），不是整张表替换。该级**只认 `model`**：其余字段在本级不生效（用 `agentOverrides` 配），`model` 不是非空字符串时在解析期就报错（`parseAgentOverridesByProvider`，报错文案带 `agentOverridesByProvider.<provider>.<role>.model` 完整点路径），不留"看着配了、实际静默失效"的配置。

---

## 7. 持久化：`legion.db`

### 7.1 位置与打开方式

- 路径：`<rootRunDir>/legion.db`（`legionDbPath`），即 `<cwd>/.pi-subagents/runs/<rootRunId>/legion.db`；子进程用 `PI_LEGION_DB` 继承同一个文件。
- 打开即断言前置条件：`PRAGMA journal_mode = WAL` 的**返回值**必须是 `wal`（不是就抛错，`assertLegionJournalMode`）、`busy_timeout = 5000`、`foreign_keys = ON`。
- 编译语句走每连接 LRU（上限 64，`LEGION_STMT_CACHE_LIMIT`）；`exec()` 的文本里出现 `ALTER|CREATE|DROP|REINDEX|VACUUM` 就整体失效，避免旧 schema 的编译结果被继续使用。

### 7.2 四张表

| 表 | 主键 | 关键列 | 写入方 |
| --- | --- | --- | --- |
| `nodes` | `id` | `parent_id`、`name`、`role`、`kind`、`depth`、`run_id`、`session_file`、`worktree_path`、`model`、`team`、`status`、`phase`、`phase_since`、`rework_count`、`contract_path`、`task_summary`、时间戳 | `insertNode` / `updateNode` / `heartbeatNode` |
| `events` | 自增 `id` | `node_id`、`type`、`data`(JSON)、`ts` | `appendEvent` |
| `usage` | `node_id` | `tokens_in`、`tokens_out`、`cost_usd`、`updated_at` | `upsertUsage` |
| `messages` | 自增 `id` | `from_node`、`to_node`、`subject`、`body`、`kind`、`urgency`、`delivered`、`delivered_at`、`created_at` | `sendMail` / `transitionDelivery` |

6 个索引：`idx_nodes_parent`、`idx_nodes_status`、`idx_events_node`、`idx_events_type_ts`、`idx_messages_inbox`、`idx_messages_rate`。最后一个专为 `sendMail` 的限流 COUNT 而建，否则每次发信都要全表扫。

### 7.3 事件

`LEGION_EVENT_TYPES`（`src/legion/events.ts`）是**封闭枚举**：`node_launched`、`node_settled`、`node_failed`、`node_retired`、`node_resumed`、`node_blocked`、`node_abandoned`、`node_handled`、`phase_change`、`phase_timeout`、`mail_sent`、`mail_delivered`、`mail_bounced`、`budget_refused`、`orphan_detected`、`tree_finalized`。

写读必须同时认这个集合，否则读侧 `mapEvent` 抛错、DB 事件游标冻结（历史事故 `#233`）。**进程内活动事件**（`text_delta`、`tool_call`、`launch_queued`、`launch_admitted` …）走另一份 `LEGION_PROCESS_EVENT_TYPES`（`src/extension/event-bus.ts`），永不写库。

### 7.4 迁移与卫生

- `LEGION_DB_USER_VERSION = 2`：v0 → v1 建表；v1 → v2 只 bump 版本（`messages.delivered` 从三值域扩成五值域，列类型本就是 `INTEGER`，旧值 `1` 语义上等同新 `accepted`）。比支持版本更新的库直接拒绝打开。
- 启动卫生（`src/runs/hygiene.ts`，每个 root 会话一次、best-effort、绝不抛）：清扫死 owner 的 `rpc-child-*`；把 owner 已死且长时间没更新的 `starting/running/blocked` 节点标 `failed`（`node_abandoned`）；按 `retentionDays`（默认 14 天）删空闲 run 目录（**带 `worktrees/` 的除外**）；events 按 `eventRetentionDays` / `eventMaxRows` 裁剪。每一步都同时看**年龄**与**进程所有权**，绝不碰别的活跃会话。

### 7.5 run 目录的降级定位

`run.json` 不再是权威状态，它承担两件事：

1. **会话寻址**：`sessionFile`、`worktrees/`、`out/` 都在这里，resume 靠它。
2. **恢复源**：`rebuildLegionDb`（`src/legion/rebuild.ts`）能从 run 记录 + session 文件 best-effort 重建 `nodes`/`events`/`usage`。它是模块级能力（有单测），**没有挂 slash 或工具入口**——不要把它当日常命令。

---

## 8. mail / notice 投递与 claim

### 8.1 mail 是什么

`legion_mail`（`src/extension/legion-tools.ts` 注册）→ `sendMail`（`src/legion/mail.ts`）：

- 目标：`parent` / `children` / `squad`（`resolveMailTargets`）。
- 类型：`question` / `report` / `handoff` / `notice`；紧急度 `info` / `action-needed`。
- 限制：subject 硬上限 256B、body 软 4KB / 硬 32KB、每个 sender 每 5 分钟 10 封（`DEFAULT_MAIL_RATE_PER_5_MIN`）、含 U+0000 的正文直接拒绝（`MAIL_INVALID_TEXT`）。
- 写入即 `mail_sent` 事件；投递状态在 `messages.delivered` 上演进。

### 8.2 `delivered` 五值域（schema v2，`#322`）

| 值 | 名称 | 含义 |
| --- | --- | --- |
| 0 | `PENDING` | 有效、尚未投递 |
| 1 | `ACCEPTED` | **一次 send 调用返回了**（queued 或 accepted），不证明模型读过；`intercepted` 不落这里，直接 bounce |
| 2 | `BOUNCED` | 永不可投：收件人已终态，或文本被输入处理器吞掉 |
| 3 | `DELIVERED` | 收件人确实消费了（在它最近 20 个 turn 里精确匹配到文本，`MAIL_DELIVERY_TURN_WINDOW` / `mailMatchesUserText`） |
| 4 | `OBSOLETE` | 发送时有效，消费前已失去意义（phase 已过、子节点全结束，`#333`） |

状态迁移只走 `transitionDelivery`（单一写入口）；`INJECTED` 是 `ACCEPTED` 的 deprecated 别名（同值 `1`），保留只为外部 import 能编译。

### 8.3 claim（租约）与两条投递路径

```text
claimForDelivery(db, id, now, leaseMs)   → 把 PENDING 行盖上 delivered_at 作为租约
renewDeliveryClaim(...)                  → 长调用每 leaseMs/3 续租
releaseDeliveryClaim(db, id)             → 立刻归还（send 抛错 / 竞争失败）
MAIL_DELIVERY_CLAIM_LEASE_MS = 60_000    → 只用于崩溃恢复；租约过期不写任何东西
```

**路径 A：postman tick。** `LegionPostman`（`src/extension/legion-tools.ts`）每 2s（`POSTMAN_INTERVAL_MS`）跑一轮：刷新心跳 → stall 检测 → 确认已 ACCEPTED 的投递 → 给子节点投递 → 给 root 投递 → 轮询 usage → 收队/失败安全网 → orphan 扫描 → 自身 phase 超时。投递前先跑 `discardIfStaleNotice`，把过时通知转 `OBSOLETE` 并写 `mail_bounced`。

**路径 B：阻塞工具抢占（`#384`）。** 父会话卡在 `wait`/`collect` 里时，followUp 只会在 turn 边界进；所以阻塞期间由工具自己把邮箱取走：`beginMailHold(nodeId)` 冻结 postman（同进程可见），`takePendingMail` 逐条 claim + 转 `ACCEPTED`，把文本并入工具结果（`renderReleasedMail`，单次上限 100 条，250ms 轮询）。工具结果被丢弃时 `redeliverMail` 以 `Redelivered: ` 前缀重新入队（不消耗发件人配额）。hold 在阻塞调用的每条退出路径上 `endMailHold` 释放。

**两条路径靠同一个租约互斥**：先 claim 到的那条投，另一条拿不到；RPC 子进程看不到内存里的 hold 注册表，因此跨进程只能靠租约。

### 8.4 完成通知（notice）

- 子 agent 不能回头 prompt 父会话。父会话侧 `deliverCompletion`（`src/extension/notify.ts`）把完成结果作为 `subagent-notify` 消息注入，`deliverAs: "followUp"`，并在首行写 `NOTICE_SOURCE_MARKER`（`▣ legion · automatic completion notice …`）以便模型区分「这不是用户说的话」。
- **outbox**（`src/extension/runtime.ts`）：父 run 仍活跃时通知先入队，只在 run 边界（`agent_settled`）投递一次，避免同一批完成产生多次唤醒。
- `MAX_PENDING_AGE_MS = 80_000` 是**健康信号**而不是发送触发器：held 通知超过 80s 只把 `heldOverCap` 加一（每条一次）并续一个窗口，**不发消息**；唯一投递时机仍是 run 边界。

### 8.5 stall notice

`src/legion/stall-notice.ts` 是纯判定（不读时钟、不碰 SQLite、不调 supervisor），有两条检测线：

- **L1 静默**：in-flight 工具栈为空且 `now - lastEventAt >= silenceNoticeMs`（默认 120s）。栈非空**永不**报 L1（一次 10 分钟的 build 与一次卡死的 bash 事件流完全一样）。每个窗口最多 2 条（`SILENCE_NOTICE_LIMIT`）。
- **L2 长跑**：`now - loopBaseAt >= loopRadiusMs`，每半径一条、每窗口最多 3 条（`LONG_RUNNING_NOTICE_LIMIT`）；只有此时才可以把「正在 `bash` 里 38 分钟」作为**证据**写进正文。

同一 tick 每个子节点最多一条线（L1 优先）。模块只产出判定与文案，**从不决定 abort/stop/retire**——决策权在父级。

---

## 9. 呈现层三形态

| 形态 | 入口 | 源文件 |
| --- | --- | --- |
| 命令族 | `/legion …` | `src/extension/legion-commands.ts`（`LEGION_COMMAND`） |
| TUI viewer | `/legion`（打开）、`/legion --tree`、`x` 停止选中节点 | `src/tui/live-overlay.ts`、`src/tui/tree-view.ts` |
| 状态面板 | 输入框上方（`aboveEditor`）的常驻 widget | `src/tui/status.ts`（`STATUS_WIDGET_PLACEMENT`） |

### 9.1 `/legion` 命令族（权威清单 `LEGION_SLASH_HELP_LINES`）

| 命令 | 作用 |
| --- | --- |
| `/legion` | 打开 Legion 视图（TUI） |
| `/legion status [name]` | 全树摘要，或单节点（与 `subagent({action:"status"})` 同文本） |
| `/legion team [list\|use <name> [--global]\|create <name> a,b,c [--global]]` | 查看/切换/创建 team |
| `/legion agents [user\|project\|both]` | 列出角色卡 |
| `/legion on` / `/legion off` | 本会话开关 subagents |
| `/scout-guard` / `/no-scout-guard` | 本会话覆盖主会话 scout guard |
| `/legion summary [--all] [<name>]` | 会话级汇总（`src/extension/summary.ts`） |
| `/legion timing [--json] [<name>]` | 子节点 wall / generation / other 计时（`src/extension/timing.ts`） |
| `/legion doctor [section]` | 全量自检；section ∈ `summary/extensions/models/spawn/memory/tools/storage/runtime/errors/next`（`DOCTOR_SECTIONS`） |
| `/legion stop [--force\|-f] [name\|all]` | 回收（`src/extension/legion-stop.ts`） |
| `/legion --tree` / `/legion <node>` | 直接打开树视图 / 定位节点 |
| `/legion help` | 打印上述清单 |

`/legion help` 与 doctor 的 Tools 段共用同一份 `LEGION_SLASH_HELP_LINES`（`src/extension/legion-doctor.ts`），所以两处不会漂移。

### 9.2 TUI 与状态面板

- **树视图**（`tree-view.ts`）：活动/终态分区来自 `isTerminalState`（`src/extension/liveness.ts`），不是本地手写集合；键位：`j/k` 移动、`enter` 折叠、`/` 搜索、`pgup/pgdn` 滚动、`esc/q` 关闭。
- **live overlay**（`live-overlay.ts`）：单节点详情，含 backend（`spawnMode`）、turn 进度、worktree 路径；历史 transcript 从 session 文件回填（`backfill` 游标，250ms 轮询），事件增量来自事件总线（`createDbEventSource` 把账本事件喂进总线）。
- **状态面板**（`status.ts`）：`aboveEditor` 常驻组件 + `requestRender`，elapsed 自己走时钟（execute ctx 过期后仍能刷新）；数据来自 `viz/model.ts` 的节点快照与 `viz/rate.ts` 的速率采样，渲染走 `viz/railway.ts`。

### 9.3 工具面（root 与 child 不同）

| 工具 | 可用者 | 作用 |
| --- | --- | --- |
| `subagent` | 宿主会话（受 `subagents.enabled` 与预算约束） | 13 个动作：`launch` / `continue` / `steer` / `abort` / `resume` / `retire` / `status` / `collect` / `list` / `wait` / `stop` / `diagnose` / `extend` |
| `vexillatio` | 宿主会话（utility child 自身不注册） | 只派 read-only utility agent（`scout`），永远 leaf |
| `legion_mail` / `legion_tree` / `legion_phase` | **子进程**（`registerTools: true`，root 为 `false`） | 发信 / 看子树 / 请求阶段迁移 |

`subagent` 的参数里两个值得记住的点：`section` 是真实存在的 diagnose 过滤参数（等价 `/legion doctor [section]`）；`phases` / `start` 只对 root 派发 centurion 有意义（§3.4.2）。

---

## 10. 与 pi 宿主边界

### 10.1 三种后端各自由谁承担

| 后端 | 子会话是什么 | 何时启用 | 契约 |
| --- | --- | --- | --- |
| `inprocess` | 父 Node 进程里的 `AgentSession`（`createAgentSession` + `SessionManager.open(sessionFile)`） | 默认；只要 launch 不需要 worktree | `docs/inprocess-supervisor.md` |
| `rpc` | 独立 `pi --mode rpc` 子进程（`RpcClient`） | 需要 worktree 且不在 hc 终端内 | `docs/headless-child-contract.md` |
| `terminal` | hc 终端里的真 `pi` TUI（JSON-RPC over `hc connect`） | 需要 worktree + `HC_TERMINAL_SOCKET` & `HC_TERMINAL_ID` 都在 | `docs/contracts/centurion-terminal-backend-v1.md` |

`terminalHostAvailable` 只看两个非空 env 标记：不 fork、不探 socket、不跑 git。hc 客户端的方法白名单是 `HC_METHODS`（`hello` / `terminal.run|get|send|wait|interrupt|kill|rm`），后端只被允许使用终端事实，不碰 `server.stop` 之类的控制面。

### 10.2 子会话里装了什么

- **身份**：`PI_LEGION_DB` + `PI_LEGION_NODE_ID`（账本身份与 node 行），`PI_SUBAGENT_ROLE` / `PI_SUBAGENT_ACCEPTANCE_ROLE`（只读角色判定），`PI_LEGION_PHASES`（相位机声明，仅 centurion；**rpc** 子进程走这条 env，in-process 子会话与宿主共用一个 `process.env`，改走 `ChildLaunchContext.phases`，见 §3.4.2）。
- **预算**：`PI_SUBAGENT_MAX_DEPTH`、`PI_SUBAGENT_ALLOW_NESTED`、`PI_SUBAGENT_MAX_TOOL_CALLS`、`PI_SUBAGENT_MAX_TURNS`、`PI_SUBAGENT_TOOL_TIMEOUT_MS`（`child-guard.ts` / `budget.ts`）。
- **child-guard**（`registerChildGuard`）：子会话加载的扩展，做三件事：计数并拦 `toolBudget`/`turnBudget`、拦 bash 对 `legion.db` 的直接读写、给 bash 套 `toolTimeoutMs`；它**不注册父工具**，所以「能不能再派活」由是否装父工具决定。它是**纪律层**，不是沙箱：`acceptance.role: read-only` 是**只针对 bash** 的规则（`tool_call` handler 首行就是 `if (event.toolName !== "bash") return;`），`edit`/`write` 由卡片 `tools:` 决定，MCP 与 `codemode` 脚本不在覆盖范围内——精确边界见 README 的「What `read-only` actually covers」。
- **扩展继承**：`ensureHostExtensions` 在第一次 spawn 前预热宿主扩展发现（幂等、永不 reject），子会话默认继承宿主扩展，卡片可用 `inheritExtensions` / `excludeExtensions` / `subagentOnlyExtensions` 调整。

### 10.3 失败与中断的归属

- 执行结果由 `parseSessionFile` + `deriveOutcome`（`src/shared/session.ts`）从 session jsonl 推导；backend 只负责给 settle 信号（`SettleResult`）。
- 中断（ESC / `abort`）保留子会话：`abort` 只打断当前 turn，`stop`/`retire` 才拆会话（`#313`/`#314`）。
- `wait`/`collect` 超时不是失败：返回结构化 `decisions`（`extend` / `steer_again` / `stop` / `force_stop`），由父级选。
- 验收（acceptance）：`deriveOutcome` 之外再看 `acceptance.level`。`attested` 是 agent 自评；只有 `verification-output` 证据且带显式 `command` 的 required 条件，才会由 `src/runs/acceptance.ts` 真跑并升级为 `verified` 或判 `rejected`。没有 `command` 的条件保持 `attested` 并列为 pending，交给父 agent 确认——平台不猜命令。
- 失败要能被定位：rpc 启动失败由 `enrichFailureWithAutoDoctor` 附 doctor 片段；in-process 的失败由 `appendInprocessModelHint`（`src/extension/spawn-hints.ts`，纯函数）按**根因**追加 Fix 段，顺序是：先 `hasHintSection`（已有 `Hint:` / `--- Legion auto-doctor` 的消息一律不再追加）→ 凭证词表（`No API key found for` / `Authentication failed for` / `No matching provider is authenticated`）给 `/login <provider>` 的建议 → 否则命中 `inprocess model resolve failed` 才给 `models.json` / `PI_LEGION_CHILD_EXTENSIONS`。凭证优先于标记：一个「解析失败但真因是没登录」的错误必须拿到登录建议，而不是去改声明文件。渲染点是 launch 与 utility 共用的，所以 rpc 的同类失败（自带 `Hint:` 的除外）也会拿到同一段凭证建议——文案本身对两种后端都成立，幂等闸保证不叠第二段。其余 in-process 失败码（`kind` 不是 pi、inprocess+worktree、`NAME_TAKEN`、`BUDGET_EXCEEDED`）**刻意不加 hint**：它们的文案已经自带可执行修法（`set worktree: false`、`raise subagents.inprocess.…`），再贴一段只是噪声。普通 `Error` 的文案逐字不变。

---

## 附录 A：符号锚点索引

| 主题 | 文件 |
| --- | --- |
| 账本 schema / WAL / 迁移 | `src/legion/db.ts` |
| 树查询与状态 | `src/legion/nodes.ts` |
| 事件枚举 | `src/legion/events.ts`、`src/extension/event-bus.ts` |
| 用量累计 | `src/legion/usage.ts` |
| 相位机定义 / 校验 / 归一化 | `src/legion/phase-machine.ts` |
| 相位迁移判定 | `src/legion/state-machine.ts` |
| 相位条件 | `src/legion/phase-conditions.ts` |
| mail 状态机 | `src/legion/mail.ts` |
| mail 抢占投递 | `src/legion/mail-release.ts` |
| stall 判定 | `src/legion/stall-notice.ts` |
| 从 run 目录重建账本 | `src/legion/rebuild.ts` |
| 派发/收集/回收/验收 | `src/runs/orchestrator.ts`、`src/runs/acceptance.ts` |
| run 记录与目录 | `src/runs/store.ts` |
| 子进程 argv/env | `src/runs/args.ts`、`src/extension/child-guard.ts` |
| model 优先级 / 判源 / modelScope | `src/agents/{model-resolution,step-model,model-scope}.ts` |
| worktree | `src/runs/worktree.ts` |
| 三后端 | `src/supervisor/{routing,rpc,inprocess,terminal}-supervisor.ts` |
| spawn 模式常量 | `src/supervisor/spawn-mode.ts` |
| hc 客户端 | `src/hc/client.ts` |
| 工具注册 | `index.ts`（`subagent` / `vexillatio`）、`src/extension/legion-tools.ts`（`legion_*`） |
| 命令族 / doctor / 通知 / 运行时 | `src/extension/legion-commands.ts`、`legion-doctor.ts`、`notify.ts`、`runtime.ts` |
| TUI | `src/tui/{tree-view,live-overlay,status}.ts`、`src/tui/viz/*` |

## 附录 B：相关契约（本文不复述，按需查阅）

`docs/inprocess-supervisor.md`、`docs/headless-child-contract.md`、`docs/contracts/centurion-terminal-backend-v1.md`、`docs/contracts/declarative-phase-machine-v5.md`、`docs/contracts/centurion-declared-phases-v1.md`、`docs/contracts/legion-session-continuity-v1.md`、`docs/contracts/mailbox-delivery-v1.md`、`docs/contracts/notice-delivery-v2.md`、`docs/contracts/stall-notice-v1.md`、`docs/contracts/stall-notice-staleness-v1.md`、`docs/contracts/launch-admission-queue-v1.md`、`docs/contracts/esc-no-retire-v3.md`、`docs/contracts/retire-hardening-v1.md`、`docs/contracts/wait-mail-preempt-v1.md`、`docs/tui-viewer-contract.md`。

## 附录 C：刻意留白

以下内容本文不写，因为代码里没有可落锚点的实现，或只存在于契约/历史记录：

- 旧 §1 的 F1–F46 实验结论（herdr 原语、ctrl+d、pane read、tab close、多 kind 降级）——见 [`docs/archive/design-herdr-era.md`](archive/design-herdr-era.md)。
- `rebuildLegionDb` 的运维入口：只有模块与单测，没有命令/工具。
- bench / 性能门槛数字：由 `bench/**` 与 reports 承载，本文不引用。
- 未来计划（`P1/P2/P3` 里程碑表）——代码未落地的东西不写成设计。
