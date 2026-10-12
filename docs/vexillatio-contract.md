# 冻结契约：vexillatio 工具人派发（REV-17）

日期：2026-10-12 ｜ 状态：frozen（唯一接口；worker 不得自行解释矛盾，发现矛盾上报修订）
依据：`docs/retire-hardening-contract.md` 的流程规范；HEAD `ec65b69`；pi 内核 1.1.0

## 0. 侦察已定事实（worker 直接引用，勿重查）

- 嵌套派生条件链：`tools:` 白名单含 `subagent` + `allowNestedSubagents: true` + 深度预算 `assertWithinBudgets`（`orchestrator.ts:647`）三环缺一不可。
- `maxSubagentDepth`（R）= 子树总代数；`C_child = min(C, d+R, 4)`（`orchestrator.ts:669`），`MAX_NESTED_PATH_ENTRIES=4`（`src/shared/types.ts:279`）。
- `RpcClient` env 合并语义 `{...process.env, ...options.env}`（pi `dist/modes/rpc/rpc-client.js:44`）——**父 env 全量继承**，须显式剥离 legion 身份（`index.ts:321-330` 幽灵节点防线）。
- 扩展工具受 `--tools` 白名单过滤，点名即激活（pi `agent-session.js:2821,2865-2873`）。
- 每个子进程无条件带 `--extension <pi-legion>/index.ts`（`args.ts:138` childGuardExtensionPath 自注入）。
- `legion.db` 表结构 v1（4 表）见 `src/legion/db.ts:41-97`；D18 铁律：库只存机器事实。

## 1. 问题与决策

**问题**：scout 等「工具人」的复用目前只能靠给角色解锁嵌套（`allowNestedSubagents`）——这会顺带解锁全量 `subagent` 派发权（含 worker 等重角色，只有提示层软约束），且深度/lineage/legion 树语义全要跟着动。

**决策**：不扩展嵌套语义。新增一种**正交的轻量派发通道**：角色 frontmatter 标记 `utility: true`（工具人），配合专用工具 `vexillatio`，任何 pi 进程（含子 agent、工具人自己）天然可派、**只能**派 utility 角色、被派的工具人永远是叶子。

## 2. 冻结接口

### 2.1 角色标记（frontmatter）

```yaml
# scout.md / 其他任何想成为工具人的角色
utility: true        # 布尔；缺省 false。utility 与 allowNestedSubagents 互斥（同时为 true = 配置错误，见 2.5）
```

- 解析点：`src/agents/agents.ts` `applyBehaviorFields` 附近新增 `utility` 布尔解析（与 `allowNestedSubagents` 同层）。
- `AgentConfig` 新增字段 `utility?: boolean`（`src/shared/types.ts` 的 AgentConfig）。

### 2.2 工具 `vexillatio`（index.ts）

注册条件（REV-17.4 重写，取代 17.3 的环境门）：**`env.PI_SUBAGENT_UTILITY_CHILD !== "1"`**（root 与非 utility 角色进程都注册；child-guard 的 `isChild && !allowNested` 早退之前注册）。`PI_SUBAGENT_UTILITY_CHILD`（下称 UTILITY_CHILD）**不是**由工具人在派发时传播，而是在 `orchestrator.lineageEnv` 里统一初始化：目标角色 `utility === true` → 设为 `"1"`，两个派发通道（vexillatio / subagent）同规则。因此：

- 工具人进程**不持有 vexillatio**（也没 subagent：§2.3 剥除其 ALLOW_NESTED）——它是硬叶子，自复制/再派任何东西都必须改角色 .md 显式配置，机制默认不可递归。
- 判定依据是**角色身份**（agent.utility），不是出生方式（哪个通道生的）——兼容通道（subagent 派 utility 角色）与专用通道行为一致，不再存在「subagent 兼容派 scout 绕开叶子约束」的路径。

与 `test/unit/child-mode.test.ts:21-27` 的兼容：无嵌套权子进程仍注册 1 个工具（vexillatio），测试断言 0 → 1；REV-17.4 维持 17.3 的授权（见 §3）。参数：

```ts
const VexillatioParams = Type.Object({
    task: Type.String({ description: "Recon task; one clear question list" }),
    agent: Type.Optional(Type.String({ description: "Utility agent name (default: scout)" })),
    tasks: Type.Optional(Type.Array(TaskItem, { description: "Parallel recon launches" })),
    cwd: Type.Optional(Type.String()),
    model: Type.Optional(Type.String()),
    timeoutMs: Type.Optional(Type.Number({ description: "Per-child wait, default 600000" })),
});
```

**只有 launch 语义**（无 status/collect/wait/steer/retire——用 `subagent` 工具的既有控制动作管理同名子节点；见 2.6）。执行流程（同步）：

1. 解析 agent：默认 `scout`；目标必须在 catalog 里且 `utility === true`，否则报错 `not a utility agent: <name> (mark it with 'utility: true')`。
2. 走**既有 `orchestrator.launch`**（复用 budget/session 管线），但 `SpawnInput.env` 显式剔除 legion 身份四变量：`PI_LEGION_DB`、`PI_LEGION_NODE_ID`、`PI_SUBAGENT_PARENT_PATH`、`PI_SUBAGENT_MAX_DEPTH`（防幽灵节点 + 防工具人继承指挥链身份）。**不剔除** `PI_SUBAGENT_CHILD`、`PI_SUBAGENT_CHILD_ROLE`、`PI_SUBAGENT_MAX_TOOL_CALLS` 等预算变量（child-guard 仍要工作）。vexillatio 通道对目标 utility 角色**剥除 `PI_SUBAGENT_ALLOW_NESTED`**（§2.5 叶子）；`lineageEnv` 统一设置 `PI_SUBAGENT_UTILITY_CHILD`（§2.2）。
3. launch 后 `awaitSupervisor` + 静默宽限（复用 `collect` 的 grace 逻辑），产出直接以文本返回（`renderCollect` 简化版：`── <name> ──\nexecution: …\n<output>`），同 `collect` 的 `outputFile` 惯例写 `<name>.output.md`。
4. 返回值含 `outputFile`/`sessionFile` 路径，父可后续用 `subagent({action:'collect'|'steer'|'retire', name})` 控制——**节点进 legion 树**，parent = 派发进程自己的 nodeId（若派发者无 legion 身份，则该 run 走无 legion 的普通 run 目录管线，同现有非 legion 子进程行为）。

### 2.3 env 语义（冻结表）

| 变量 | vexillatio spawn 时 | 理由 |
|---|---|---|
| `PI_LEGION_DB` / `PI_LEGION_NODE_ID` | **剔除** | 工具人不进 legion 树（见 2.2 步骤 4 的例外说明） |
| `PI_SUBAGENT_PARENT_PATH` | **剔除** | 不继承指挥链 lineage |
| `PI_SUBAGENT_MAX_DEPTH` | **剔除** | 工具人不做深度预算参与者；它自身作为叶子由 2.5 保证 |
| `PI_SUBAGENT_CHILD` | 保留 =1 | child-guard 必须激活 |
| `PI_SUBAGENT_ALLOW_NESTED` | **剔除**（vexillatio 通道对 utility 目标强制叶子；subagent 兼容通道照旧由目标自己的 frontmatter 决定） | 工具人默认叶子；想显式再派（罕见）需角色 .md 同时声明，此时受 catalog warning 提示 |
| `PI_SUBAGENT_UTILITY_CHILD` | **lineageEnv 统一设置**：目标 utility → "1"；否则 unset | 工具人身份标记，vexillatio 注册门的判定输入（§2.2） |
| `PI_SUBAGENT_CHILD_ROLE` / 预算变量（MAX_TOOL_CALLS / MAX_TURNS / TOOL_TIMEOUT_MS） | 保留 | child-guard 行为不变 |
| `PI_SUBAGENT_TEAM` | 保留 | team 过滤照旧 |

### 2.4 playbook / roster

- `PARENT_PLAYBOOK`（`src/extension/playbook.ts`）追加一段：
  `Utility agents (utility: true, e.g. scout) can be dispatched by ANY role via the separate 'vexillatio' tool — read-only helpers, always leaf, no depth budget. The 'subagent' tool stays for the command chain (worker/centurion).`
- `before_agent_start` 的 `selectedTools` 门（`index.ts:706`）对 `vexillatio` 同样生效：工具没进白名单就不注入 playbook。

### 2.5 互斥与约束（实现必须校验）

1. `utility: true` + `allowNestedSubagents: true` 同角色 → **catalog 加载时报 warning**（不硬拒），提示「utility 角色不应开嵌套」；此时该角色进程持有 subagent 但无 vexillatio（§2.2 门），行为仍可预测。
2. vexillatio 通道派发的 utility 目标强制叶子：剥除其 ALLOW_NESTED（§2.3）；其深度预算亦已剥离（MAX_DEPTH env 剔除）。
3. `subagent` 工具派发 utility 角色 → 允许（向下兼容）；其 env 中 `PI_SUBAGENT_UTILITY_CHILD` 仍由 lineageEnv 统一设置（角色身份优先），即兼容通道出生的 utility 同样是硬叶子，无递归路径。vexillatio 派非 utility 角色 → 硬拒（INVALID_PARAMS）。
4. depth：vexillatio 派发**不校验 assertWithinBudgets**（它不是嵌套）；工具人进程自身已无 vexillatio/subagent（§2.2/§2.3），天然无递归上界问题。

### 2.6 命名与树

- 工具名 `vexillatio`；子节点命名同现有规则（`scout-0` 等，避免与 subagent 派发的同名冲突：vexillatio 的默认名前缀 = 目标角色名，序号接续该父节点既有 children）。
- legion.db：**不改 schema**（不加表不加列）。工具人节点照常记 `nodes` 表（role 列存角色名），树渲染 `legion_tree` 自然可见。区别只在身份 env（2.3）。

## 3. 文件所有权（单 worker，无并行冲突）

| 文件 | 动作 |
|---|---|
| `src/shared/types.ts` | AgentConfig + `utility?: boolean` |
| `src/agents/agents.ts` | frontmatter 解析 `utility`（applyBehaviorFields 层） |
| `src/agents/settings.ts` | agentOverrides 白名单字段加 `utility` |
| `src/agents/overrides.ts` | `OVERRIDE_FIELDS`（:20-54）加 `"utility"`——settings 层 override 的实际复制通道，不加则 override 被丢弃 || `src/runs/orchestrator.ts` | launch 支持 `stripLegionIdentity?: boolean`（SpawnInput 选项，控制 env 剔除） |
| `src/supervisor/rpc-supervisor.ts` | SpawnInput.env 透传（已有；无需改动，除非类型收紧） |
| `index.ts` | 注册 `vexillatio` 工具（早退之前）+ PLAYBOOK 文本 |
| `src/extension/playbook.ts` | PARENT_PLAYBOOK 追加段 |
| `src/extension/child-guard.ts` | 无改动（预算变量照旧）；如需在 child 附录说明 vexillatio，最小追加 |
| `~/.pi/agent/agents/scout.md` | 加 `utility: true`（**用户层文件，部署时应用；worker 不改它**，写进部署清单） |
| `agents/scout.md`（内置层） | 同上（包内默认） |
| `test/unit/utility-agents.test.ts` | **新建**。§4 场景 1（frontmatter `utility` 解析）+ 场景 5（utility+allowNested 同开 warning） |
| `test/integration/vexillatio.test.ts` | **新建**。§4 场景 2/3/4（mock supervisor：env 剔除断言 / 非 utility 硬拒 / subagent 兼容派发） |
| `test/unit/child-mode.test.ts` | **唯一允许修改的既有测试**：两个用例的断言数字修订——第一用例 0→1（仅 vexillatio），第二用例 1→2（vexillatio+subagent），各加注释引用本契约 §2.2（REV-17.5 授权；已全量扫描既有测试，其余断言均为按名取工具不数总数，不受影响） |

**共享文件**：`index.ts` / `orchestrator.ts` / `types.ts` 本契约全部分配给唯一 worker，无并发写。

**既有测试文件除 §3 明确授权的 `test/unit/child-mode.test.ts` 两处断言数字修订外一律不修改**；§4 要求的新增测试全部落在两个新文件里。

**断言影响总则（REV-17.5）**：契约导致的注册行为变化若使某既有断言失效，属于本契约的影响面；授权范围以本 §3 该行所列为准，本行已全量扫描（grep `pi.tools\|tools.length\|tools.find\|tools.get\|herdrSubagents(` 全测试目录）并一次列尽。后续若再发现同类冲突，上报照旧。

## 4. 验收清单（可机器检查）

1. `npm run typecheck` 全绿（既有脚本）。
2. `npm test` 全绿；**新增**测试覆盖：
   - frontmatter `utility: true` 解析（agents 单测）；
   - `vexillatio` 派 utility 角色成功（integration，可 mock supervisor）：子进程 env 不含 `PI_LEGION_DB`/`PI_SUBAGENT_PARENT_PATH`/`PI_SUBAGENT_MAX_DEPTH`/`PI_SUBAGENT_ALLOW_NESTED`，含 `PI_SUBAGENT_CHILD=1`；
   - `vexillatio` 派非 utility 角色 → INVALID_PARAMS；
   - `subagent` 派 utility 角色 → 成功（兼容）；
   - `utility + allowNestedSubagents` 同开 → catalog warning（不拒）。
3. 手工冒烟（写进 MR 描述即可）：`subagent({agent:'planner', task:'…用 vexillatio 派 scout 摸清 X…'})`，planner 会话里能看到并调用 `vexillatio` 工具，产出返回进 planner 上下文。

## 5. 风险与回滚点

- **风险 1**：root 进程派 vexillatio 时 env 合并把 root 的 legion 身份带进去 → 2.3 剔除表已防；测试 2 覆盖。
- **风险 2**：`renderParentRoster`/`selectedTools` 门未对 vexillatio 生效 → 2.4 已写；测试 4 覆盖。
- **风险 3**：vexillatio 与 subagent 同名子节点冲突 → 2.6 命名规则（序号接续）；`agent_name_taken` 语义照旧。
- 回滚点：整特性单 MR；`git revert` 即可。配置层（scout.md 的 `utility: true`）独立于代码，可单独回滚。

## 6. 部署清单（worker 不执行，主 agent 收尾时应用）

- `~/.pi/agent/agents/scout.md`：加 `utility: true`。
- `agents/scout.md`（内置层，随包发布）同上。
- 可选：其他候选工具人角色（未来）。

## 7. 修订记录

| 日期 | 版本 | 修订 | 原因 |
|---|---|---|---|
| 2026-10-12 | REV-17 初版 | — | 首次冻结 |
| 2026-10-12 | REV-17.1 | §3 增补两行测试文件所有权（新建 `test/unit/utility-agents.test.ts`、`test/integration/vexillatio.test.ts`），并明确既有测试文件不改 | worker 依 §4 验收要求提出契约矛盾（§3 未授权测试文件）——拒绝正确，修订后重派 |
| 2026-10-12 | REV-17.2 | §3 增补 `src/agents/overrides.ts` 所有权（worker-1 指出 settings 行的动作列引用了未授权文件）；自查确认无其他「动作列引用未授权文件」情况 | worker-1 依契约矛盾流程上报（§3 :91 行动作列要求同步 overrides.ts 清单但表未授权）——拒绝正确，修订后重派 |
| 2026-10-12 | REV-17.3 | §2.2 注册条件从「无条件」改为「环境门 PI_UTILITY_CHAIN」（修自复制递归无上界漏洞 + 与 child-mode.test 兼容）；授权修改该测试断言 0→1 | worker-2 指出 §2.2 无条件注册与 test/unit/child-mode.test.ts:21-27 冲突且 §3 未授权——拒绝正确；根因是契约自身设计缺陷（自复制无上界），修订后重派 |
| 2026-10-12 | REV-17.4 | §2.2 重写：判定依据从「出生方式」改为「角色身份」（agent.utility），新 env `PI_SUBAGENT_UTILITY_CHILD` 由 lineageEnv 统一设置（两通道同规则）；§2.3 表重排；§2.5 重写；场景矩阵六例闭合推演（root/planner/worker/scout 两通道/误配 warning） | worker-3 指出 17.3 的门与「链上每环节持有工具」同句自矛盾且 PI_UTILITY_CHAIN 初始化语义悬空——拒绝正确，修订后重派 |
| 2026-10-12 | REV-17.5 | §3 child-mode 授权扩为两处断言数字（第一用例 0→1，第二用例 1→2）；新增「断言影响总则」：全量扫描一次列尽受影响断言，不再逐轮挤牙膏 | worker-4 指出第二用例（嵌套权子进程）按 §2.2 应注册 subagent+vexillatio 共 2 工具但断言仍为 1 且未授权——拒绝正确，修订后重派 |
