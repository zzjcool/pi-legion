# 会话中断与恢复契约 v1（同 session 才提示、恢复必须显式）

- 状态：生效，随实现 PR 落地。
- 上游：`docs/legion-v2-contract.md`（FROZEN-1，按 §15 修订）、
  `docs/contracts/declarative-phase-machine-v5.md`、`docs/contracts/centurion-declared-phases-v1.md`。
- 冲突时停下报告，不得自行解释。

## §0 一句话

root 退出时，子树**停手但保留可续的状态**；下次启动**同一个 session** 才把这份状态接回来、并告诉 agent
「上次有 N 个 subagent 被打断」；**恢复必须是显式动作**（用户说 或 命令）；**换 session 一律零动作**。

## §1 会话身份

- 判据只有一种：**session 文件的绝对路径相等**（`path.resolve`）。仓内没有 session id 概念
  （`ChildRecord.sessionId` 是死字段），不要新造。
- `RunRecord` 增 `sessionFile?: string`（走 `src/runs/store.ts:32-43` 的 `declare module` 增强，与 `nodeId` 同模式）。
  `writeRun`/`readRun` 原样保留未知字段（已核实），所以只改 `createRootLegion` 的构造即可。
- 取不到 session 文件（`SessionManager.inMemory()`）⇒ 视为**没有会话身份**：不记录、不查找、不提示。

## §2 同 session 重开（reopen）

`createRootLegion` 之前新增一步查找：`store.listRuns()` 里 `sessionFile` 与当前 session 绝对路径相等的
**最近一条** run（`createdAt` 最大）。

| 情况 | 行为 |
|---|---|
| 找到 | **复用它**：用它的 `runId` / run 目录 / `legion.db`；root 行已存在则**update**（status→running、updatedAt），**不 insert**（`insertNode` 会按名字冲突抛 `NodeNameConflictError`）；**不**新建 run、**不**新写 `run.json`（只更新 `updatedAt`）。 |
| 没找到 | 与今天完全一致：`createRun` 新 run、新账本。 |
| 找到但账本损坏/root 行缺失 | 退回「没找到」，不抛。 |

理由：账本按 run 开、`legion.db` 在 run 目录里。要"接回上次的树"，最省的是复用同一份 run，
而不是在新账本里重建一棵影子树（那会让 `legion_tree`、相位、邮件全部断链）。

## §3 退出 = 暂停，不是判负（关键改动）

今天 `session_shutdown` → `retire({cause:"session-shutdown"})` → `abortLegionPhase` 会把相位推到
`aborted`（终态），而 `childFromNode` 对终态相位直接抛 `CHILD_TERMINAL` ⇒ **被打断的队永远不可恢复**。
这与本契约冲突，必须改：

- `cause === "session-shutdown"` 时**跳过相位迁移**，只做：杀进程、`status → retired`、
  写 `node_retired` 事件并带 `{ reason: "session-shutdown" }`（**不新增事件类型**：闭集仍 16 条）。
- 其它 cause（`stop`、`abort`、超预算、显式 retire）**行为不变**：仍走 `abortLegionPhase`。
- 相位、`phase_since`、`rework_count` **一律不动**（暂停是暂停，不是新 stint，不写 `phase_change{reason:"revived"}`）。
- 结果：`isTerminalNode` 仍为 false（`retired` 且相位非终态）⇒ 可被 resume；`hasEnded` 为 true ⇒ 暂停期间
  邮件不会被投给它（保持 §8.3 现状，不新增投递语义）。

## §4 恢复必须显式

- **不自动 resume**。root 启动时**只统计和提示**，绝不 spawn。
- 恢复动作是 `subagent({ action: "resume", name })`（既有工具）：`reviveChild` 从 run.json 定位、
  `orchestrator.launch` 复用 `previous.sessionFile`。
- 前提：新会话必须已经 reopen 同一账本（§2），否则 `input.legion.nodeId` 在账本里不存在，`launch` 会抛
  `legion parent node not found`（拒绝而非静默降级，保持现状）。
- **声明过的 `phases` 必须跨进程存活**：`ChildRecord` 增 `phases?: PhaseMachine`（launch 时快照），
  `reviveChild` / `resumeLegionChild` 传回 `Orchestrator.launch`，由既有 `LEGION_PHASES_ENV` 通道下发给子进程。
  没有它，复活的内联声明队会退化到角色卡机器（自定义相位名 → `invalid_phase`）。

## §5 提示（agent 看得到、用户也看得到）

- 触发条件：本次启动 **reopen 成功** 且账本里存在被打断的**直接子节点**。判据两条（实现期修订，
  见下）：① 状态仍是 `starting/running/blocked`（进程随 session 死了，不会有人再推动它）；
  ② 或状态是 `retired` **且**它最后一条 `node_retired` 带 `reason: "session-shutdown"`
  （用户主动 `stop` 的节点不带这个 reason，不能报成"被打断"）。
- `phase` **不参与**判据：自 #371 起只有声明 `phases:` 的队才有相位，把 `phase` 当必要条件会漏掉
  最常见的场景——**被打断的 worker**。节点还必须带 `sessionFile`（没有恢复凭据就不该被宣传）。
- 实现期修订记录（2026-11-02，本 PR）：初版 §5 要求 `phase` 非空且非终态，实际上线时会把所有 worker
  排除在外；改为上述两条判据，测试同时钉住「主动 stop 不出现在清单里」。
- agent 侧：注入**system prompt 一段**（复用 `before_agent_start` 的 playbook 注入位），内容包含
  节点名、相位、以及一句硬规则：

  ```
  These subagents were interrupted when the previous session exited.
  Do NOT resume them on your own; ask the user first, then call
  subagent({action:"resume", name}) for each one they approve.
  ```

  该段**只在存在被打断节点时出现**；节点全部被恢复或被丢弃后自动消失（幂等，不累积）。
- 用户侧：一行 `ctx.ui.notify`（同一次启动只一次）。
- **跨 session 不提示、不扫描、不写任何东西**（§1 判据不成立即返回）。

## §6 不变量

| 编号 | 不变量 | 守卫 |
|---|---|---|
| I1 | 跨 session 零副作用：不读旧 run、不提示、不改状态 | 新增用例（断言旧 run.json 的 `updatedAt` 不变） |
| I2 | 事件闭集仍 16 条；`node_retired` 只多一个 `reason` 字段 | `test/unit/legion-schema-sentinel.test.ts`、`legion-events.test.ts` **不改** |
| I3 | `NodeStatus` 仍 6 个值，不加 `interrupted` | `test/unit/legion-nodes.test.ts:168-201` **不改** |
| I4 | 非 `session-shutdown` 的 retire 行为逐字不变（相位仍被 abort） | 现有 retire/abort 用例 **不改** |
| I5 | 工作树语义不变（centurion 独占、强制 true、绑 rpc） | `worktree-centurion-only.test.ts` **不改** |
| I6 | 暂停期间不自动恢复、不自动开 turn（不烧 token） | 新增用例（断言零 spawn、零模型调用） |
| I7 | reopen 后 `legion_tree` 能看到上次的节点与相位 | 新增用例 |

## §7 验收

1. **同 session**：会话 A 派 2 个 worker 后退出 → 同 session 重开 → 账本仍是同一份、2 个节点可见且相位不变、
   prompt 里出现那 2 个名字、UI 一行提示、**零 spawn**。
2. **显式恢复**：`subagent({action:"resume", name})` 后子节点重新跑起来，`nodes.status` 回 `running`，
   相位不变（不写 `revived` 事件以外的迁移），session 文件复用同一个。
3. **声明机恢复**：内联 `phases` 的 centurion 被打断后恢复，`legion_phase` 仍认它的自定义相位名
   （不给 `invalid_phase`）。
4. **跨 session**：不同 session 启动 → 不提示、不扫描、旧 run 文件 byte-identical（I1）。
5. **`kill -9`**：子进程在 `stdin` 断开后自行退出（沿用 pi 的 stdin-close-shutdown 契约；实测记录写进报告）。
6. `npm run typecheck` / `npm test` / `npm run test:integration` 全绿。

## §8 非目标

- 不做自动恢复（C 方案）。
- 不改 `NodeStatus` 闭集、不加事件类型。
- 不为暂停新增邮件/通知语义（`hasEnded` 的邮件语义保持不变）。
- 不动 worktree、MR、acceptance。
- 不处理「不同机器/不同 store root 的 session 迁移」。
