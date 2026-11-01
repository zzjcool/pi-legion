# centurion 声明式启用契约 v1（root 声明才走状态机）

- 状态：**生效**，随本契约的实现 PR 落地。
- 上游：`docs/legion-v2-contract.md`（FROZEN-1，本契约按 §15 修订）、
  `docs/contracts/declarative-phase-machine-v5.md`（现行相位机行为依据）、
  `docs/contracts/viz-frame-alloc-v1.md`（无关，仅作行文参照）。
- 冲突时停下报告，不得自行解释。

## §0 一句话

**状态机不再是"角色叫 centurion"的自动后果，而是 root 在自己那次派发里显式声明的东西。**
声明了 = 今天的行为，一字不改；没声明 = 一个有权派活的普通 agent（该干完就干完）。
「不能派 centurion」不变，并首次以 REV 形式记录。

## §1 为什么

1. 今天 `nodes.phase` 的写入键是角色名字面量（`src/runs/orchestrator.ts:669`），
   于是**每一次** centurion 派发都被强制五阶段：写契约 → 派 worker → 派 reviewer →
   跑 verify → squash MR。写一行文件的活实测 7m55s。
2. 零派遣的团队在实现上**无合法收尾路径**：`done` 的唯一入边要 `verifying`，
   `verifying` 的唯一入边要 `children_present`（`phase-machine.ts:97/111/123`），
   所以 solo 只能走 `failed`（需自认失败）或父级 `aborted`（外部动作）。
   实测：`legion_phase` 返回 `no child has been dispatched yet`，父会话只能人工背书
   （acceptance 落到 `attested`）。
3. 卡上的 `acceptance.level: verified` 是**死字段**（全仓无读取），而
   `legion-team-delivery` 的 evidence 不含 `verification-output`、也没有 `command`
   ⇒ 该条永远不被机器验证。
4. 「非 root 不得派 centurion」与冻结契约 §9（F13「孙代 centurion 递归成立」）、
   §6.1（`maxSubagentDepth: 2` 注释「孙代 centurion 可再派一层」）、README `:53/:62/:558`
   **直接冲突**，且没有任何 REV 记录（违反 §15-4「权限变更必须走修订」）。

## §2 声明形状

在 `subagent` 工具参数上新增 `phases`（仅 `action: "launch"` 有效），接受
`declarative-phase-machine-v5` 的同一份机器形状（也接受等效的缩进文本，复用现有解析器）：

```jsonc
{ "agent": "centurion", "task": "...",
  "phases": [ { "id": "planning", "next": [{ "to": "implementing", "require": ["contract_file"] }] },
              { "id": "implementing", "next": [{ "to": "done" }] },
              { "id": "done", "terminal": true, "next": [] } ],
  "start": "planning" }
```

解析优先级（与卡片一致，新增内联层在最前）：

1. launch 参数 `phases`
2. 角色卡 `phases:`（`agents/centurion.md` 当前没有）
3. 都没有 ⇒ **不挂机器**

## §3 代码级守卫（全部在 `Orchestrator.launch`，创建 worktree/run 目录**之前**抛出）

| 编号 | 规则 | 拒绝文案要点 | 与既有实现的关系 |
|---|---|---|---|
| **G1** | 非 root 派 `centurion` → 拒 | `centurion is dispatchable only from the root shell; '<parent>' at '<node>' cannot` | 已有（`orchestrator.ts:945-961`，文案改掉 "only the root session may dispatch a centurion" 的措辞以匹配 §4 的 REV） |
| **G2** | 任何**非 root** 传 `phases` → 拒 | `phases are declared by the root shell only; '<node>' cannot` | 新增；**拒绝而非忽略**（静默忽略会让调用方以为开了机器） |
| **G3** | root 给**非 centurion** 传 `phases` → 拒 | `phases belong to a centurion team; dispatch a worker for solo work` | 新增；挡住"给 worker 声明状态机"这种无意义组合 |
| **G4** | 内联 `phases` 必须通过现有校验器 **且** 从 `start` 可达某个终态 | 逐条转贴 `validatePhaseMachine` 的 path+message；可达性缺失时 `phase machine cannot reach a terminal phase from '<start>'` | 新增（校验器 `phase-machine.ts:228` 现在**不检查可达终态**，卡片里 `planning→implementing→done` 能过校验但永不收尾） |
| **G5** | 声明的机器里若有 `→ done` 边，节点可以自己走；否则仍拒 | `done is controlled by the parent or supervisor`（保留给没声明的机器） | 改 `legion-tools.ts:923-925` 的硬拦 + `:1014` 的 `mayDeclareFailure` 同族判断 |
| **G6** | `legion-verify` 在**机器的验证相位**跑，不再靠字面量 `"verifying"` | — | 改 `legion-tools.ts:1091` 与 `:557-600` 的 `successPhase` / `verificationPassed` 耦合 |

「拒绝而不是降级」的取舍沿用 #272 的先例（在产生工件前抛，避免留在树上的空 worktree）。

## §4 修订记录（本契约同时充当 REV）

- **REV-1（本契约）**：把「非 root 不得派 centurion」从**未记录的实现约束**提升为**契约条款**，
  与 §9 F13 / §6.1 的"递归孙代"表述冲突，按 §15-4 走修订。裁决：**保持禁止**。
  理由（老板决定，2026-10-31）：centurion 的语义是"root 派出去的一支子树"，嵌套 lead 不带来
  新的交付语义，只带来深度与工件的递归；需要更多并行时由 root 直派多个 centurion。
  `agents/centurion.md` 的 description 同步改为「仅根会话可派发」，与代码一致。
- 未改动：worktree 归属（§9 REV-17 保持不变，仍为 centurion 专属、仍强制 `true`、仍绑 rpc）。

## §5 不变量（必须全绿）

| 编号 | 不变量 | 守卫 |
|---|---|---|
| **I1** | 声明了机器的 centurion 行为**完全等于今天**：planning 需契约文件、implementing 需 ≥1 settled 子节点、reviewing 需 settled reviewer 的 `ok:true`、verifying 跑 `legion-verify`、`done` 后注入 squash 提示 | 现有 `test/unit/legion-tools.test.ts:114`、`test/integration/legion-tree.test.ts:164` **不改** |
| **I2** | 未声明机器的 centurion：`nodes.phase` 为 NULL、不注册 `legion_phase`、不注入收队提示，turn 结束交 verdict 即完成 | 新增用例 |
| **I3** | worktree 规则不变（只有 centurion 拿，仍 `:true`，组员强制 `false`，非 centurion 请求降级 + 警告一次） | `test/unit/worktree-centurion-only.test.ts`、`test/unit/launch-worktree-probe.test.ts` **不改** |
| **I4** | 深度公式 `min(maxDepth, depth+roleDepth, 4)` 不变 | `test/integration/nesting.test.ts` **不改** |
| **I5** | `implementing` 的相位级 `children_settled` 仍 AND 进每一条出边（含 failed） | 现有用例 |
| **I6** | 未声明的机器上 `done`/`aborted` 仍只能由 supervisor/父级驱动 | 现有 `test/unit/legion-phase-exit.test.ts:367` |
| **I7** | 声明不可伪造：非 root 传 `phases`、root 给非 centurion 传 `phases` 都在 launch 期被拒，且**不留下任何工件** | 新增用例（断言 worktree/run 目录不存在） |

## §6 验收

1. 新增 3 条 e2e：
   - **solo 声明**：`phases: planning→implementing→done` 的 centurion 在**零子节点**下走完并 `done`，
     父级 collect 得到 `accepted`，且不再需要 `attested` 兜底；
   - **团队声明**：与 `legion-tree.test.ts:164` 同形，证明 I1；
   - **不声明**：`nodes.phase IS NULL`、工具集里没有 `legion_phase`、verdict 正常返回（I2）。
2. G2/G3/G4 各一条拒绝用例：断言抛错文案、`spawns.length` 不变、worktree 目录不存在。
3. `npm run typecheck` / `npm test` / `npm run test:integration` 全绿；
   `bench/perf-core/10-legion-frame-alloc.ts` 与本契约无关但不得回归。
4. `docs/legion-v2-contract.md` §15 追加 REV-1；`agents/centurion.md` 的 description 与正文
   补「状态机由 root 声明」与「不声明时你就是个能干活的 agent」。

## §7 非目标

- 不改 `worktree ⇔ rpc` 的结构耦合（`orchestrator.ts:1008`）。
- 不新增角色、不改 roster 粒度、不动 `teams` 裁剪。
- 不让 centurion 越过父级合并（MR 合并权仍在父节点）。
- 不修 `acceptance.level` 的死字段语义（只在本契约 PR 里删掉卡上那行 + 把
  `legion-team-delivery` 标 `optional`，避免"声明了 verified 却永不验证"）。
