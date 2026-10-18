# 冻结契约 — issue #214 worktree 收权（2026-10-19，基线 master@dee3378）

本文件是两个并行 worker 的唯一接口约定。**不得自行解释或扩展**；与本文冲突视为任务卡错误，停下向父会话报告，不要就地改造。

## 目标（来自 issue #214 决策评论 D1-D4，已由用户拍板，不再讨论）

`worktree` 隔离**仅 centurion 可用**，其余角色一律禁；违规时 **warn 一次 + 强制降级**，**不抛错**。隔离边界由「每棵子树」承载，不由「每个 writer」承载（对齐 `docs/legion-v2-contract.md:323` §9 已冻结的「组员一律 `worktree:false` 原地干活」）。

## 事实基线（侦察已确认，禁止重新侦察）

| 事实 | 位置 |
|---|---|
| 三重硬编码判 centurion | `src/runs/orchestrator.ts:564-573` |
| **writer 角色自动补 `worktree: true`（关键，必须删）** | `src/agents/agents.ts:563-566` |
| 三个 writer 角色 | `agents/centurion.md:12`、`agents/worker.md:13`、`agents/prototype.md:12` 都是 `acceptance.role: writer` |
| `worker.md` 钉了 `worktree: true` | `agents/worker.md:22` |
| `prototype.md` 显式 `worktree: false` | `agents/prototype.md:25`（保持不动） |
| 仲裁：省略 mode + worktree:true → rpc | `src/runs/orchestrator.ts:582-586` |
| worktree 归一化进 agent 克隆 | `src/runs/orchestrator.ts:602-604` |
| `warnDepthCap` 形态（模仿对象） | `src/runs/orchestrator.ts:512-525`（`depthWarningEmitted` 布尔 + `console.warn` + 可选 `onBudgetRefused`） |
| `onBudgetRefused` 事件**零订阅者** | `index.ts:567-569` 只 `pi.events.emit`，全仓无 `pi.events.on` |
| 三处待改文案 | `inprocess-supervisor.ts:583-588`、`routing-supervisor.ts:79-84`、`orchestrator.ts:615-620` |
| 唯一硬断言 orchestrator 文案的测试 | `test/unit/spawn-mode-arbitration.test.ts:169` `/cannot use worktree isolation/` |
| 契约 §9 冻结句 | `docs/legion-v2-contract.md:323` |
| 契约 §15-4「权限变更必须走修订」 | `docs/legion-v2-contract.md:430` |
| 修订日志止于 REV-16 | `docs/legion-v2-contract.md:461` |

## 冻结决策

### D1 — 删除 writer 自动补 worktree（**核心，不做则整个方案失效**）

`src/agents/agents.ts:563-566` 整段删除（含那两行注释）。理由：它把**任意**用户的 writer 角色自动钉上 worktree，与「仅 centurion」直接冲突，且会让 `worker.md` 删掉字段后仍为 true。

删除后 `config.worktree` 保持 `undefined` → `resolveLaunchWorktree` 的 `roleDefault === true` 判据（`src/runs/worktree.ts:42`）落 false。**不改** `resolveLaunchWorktree` 本身（前一版契约 `docs/contracts/spawn-default-inprocess-v3.md:241-242` 把它列为共享不可改文件，优先级链是不变式 I5）。

### D2 — 角色卡

- `agents/worker.md`：`worktree: true` → **`worktree: false`**（显式写，不留 `undefined`，让意图可见并防止将来有人重新引入自动默认）
- `agents/centurion.md`：`worktree: true` **保持不变**
- `agents/prototype.md`：`worktree: false` **保持不变**
- 其余角色（advisor/designer/planner/reviewer/scout）：**不改**

### D3 — 收权闸门（`Orchestrator.launch`）

把 `src/runs/orchestrator.ts:565-573` 的三重硬编码改为：

```ts
// #214: worktree isolation is centurion-only. A centurion card always gets a
// subtree worktree (nested centurions get nested worktrees, §9); a centurion
// parent's members never do; everything else falls to the role/launch default
// and is then gated below.
const isCenturionCard = input.agent.name === "centurion";
let worktree = isCenturionCard
    ? true
    : this.legion && parentRole === "centurion"
        ? false
        : resolveLaunchWorktree({
            roleDefault: input.agent.worktree,
            launch: input.worktree,
            parentInWorktree: isInsideChildWorktree(this.cwd),
        });
// #214 D4: only a centurion may hold a worktree. Everyone else — including an
// explicit `subagent({ worktree: true })` — is warned once and downgraded.
// Downgrading (not throwing) is deliberate: it must never fail a launch.
if (worktree && !isCenturionCard) {
    this.warnWorktreeNotCenturion(input.agent.name);
    worktree = false;
}
```

注意两点：
1. **centurion 判定不再要求 `this.legion`**。这修复了「脱离 legion 的 centurion 拿不到 worktree」的既有缝隙（侦察 F57），且行为上是 no-op（当前非 legion centurion 走 roleDefault 也是 true）。
2. `parentRole === "centurion"` 那支仍保留 `this.legion &&`（parentRole 本身就是 legion 派生，保留可读性）。
3. **嵌套 centurion 仍拿嵌套 worktree**：`isCenturionCard` 第一支先命中，不被 `parentRole === "centurion"` 压掉。这是 §9 要求的（「孙代 centurion 在子树 worktree 内再开 nested worktree」）。

### D4 — warn 的实现（模仿 `warnDepthCap`）

新增私有字段 `private worktreeWarningEmitted = false;`（与 `depthWarningEmitted` 并列，`src/runs/orchestrator.ts:259` 附近）与私有方法：

```ts
/** One-shot: a non-centurion asked for worktree isolation; it was downgraded. */
private warnWorktreeNotCenturion(roleName: string): void {
    if (this.worktreeWarningEmitted) return;
    this.worktreeWarningEmitted = true;
    console.warn(
        `[pi-legion] worktree isolation is reserved for centurion; ` +
        `role '${roleName}' was downgraded to worktree: false (its children share the checkout). ` +
        `Set worktree: false in the role card to silence this. Dispatch a centurion when you need an isolated subtree.`,
    );
}
```

要求：
- **仅 `console.warn`**，不新增事件类型（§15-4：新增事件类型要走契约修订；本次不动事件面）。也**不**走 `onBudgetRefused`（语义不同、且它零订阅者）。
- **每 Orchestrator 实例一次**（同 `depthWarningEmitted` 语义，`restore()` 不复位）。
- **不 throw**，不改变 launch 成败。

### D5 — 三处文案（D3 的「优先建议 worktree: false」）

统一方向：**先说 worktree 仅 centurion，再说去掉 worktree**。不要再把「改用 rpc」放首位。

- `src/supervisor/inprocess-supervisor.ts:583-588`
  旧：`spawnMode "inprocess" cannot use worktree isolation for '${input.name}'; use spawnMode "rpc" or set worktree: false`
  新：`spawnMode "inprocess" cannot use worktree isolation for '${input.name}'; worktree is reserved for centurion — set worktree: false on the role card to run it in-process`
- `src/supervisor/routing-supervisor.ts:79-84`
  旧：`spawnMode "inprocess" cannot combine with worktree: true for '${input.name}'`
  新：`spawnMode "inprocess" cannot combine with worktree: true for '${input.name}'; worktree is reserved for centurion`
- `src/runs/orchestrator.ts:615-620`
  旧：`spawnMode "inprocess" cannot use worktree isolation for '${name}'`
  新：`spawnMode "inprocess" cannot use worktree isolation for '${name}'; worktree is reserved for centurion — set worktree: false to run it in-process`

必须同步：
- `test/unit/spawn-mode-arbitration.test.ts:169` 的 `/cannot use worktree isolation/` 断言仍成立（新文案保留了这串字符），**但**要新增一条断言锁「reserved for centurion」这句，防止文案再退回「优先改用 rpc」。
- `docs/contracts/spawn-default-inprocess-v3.md:214` 把 `/cannot use worktree isolation/` 写进验收要求 —— 该文档是 FROZEN 历史契约，**不要改**；新文案兼容它。

## 文件所有权（硬边界）

| Worker | 文件 |
|---|---|
| **A / 核心+测试** | `src/agents/agents.ts`, `src/runs/orchestrator.ts`, `src/supervisor/inprocess-supervisor.ts`（仅文案）, `src/supervisor/routing-supervisor.ts`（仅文案）, `agents/worker.md`, `test/unit/agents.test.ts`, `test/unit/spawn-mode-arbitration.test.ts`, `test/integration/regressions.test.ts`, `test/integration/orchestrator.test.ts`, `test/integration/legion-tree.test.ts`, **新增** `test/integration/worktree-containment.test.ts` |
| **B / 文档+playbook** | `src/extension/playbook.ts`, `index.ts`（**仅** worktree 参数的两处 description: :127 与 :179）, `README.md`, `docs/inprocess-supervisor.md`, `docs/subagents-teams.md`, `docs/legion-v2-contract.md`, `test/unit/playbook.test.ts` |

**无重叠**。A 不碰 `index.ts` / docs / playbook；B 不碰 `src/agents/`、`src/runs/`、`src/supervisor/`、`agents/*.md`、以及 A 的测试文件。

## 刻意的行为变更（reviewer 请先对照，不要当成 bug）

1. **`worktree: true` 的非 centurion 角色不再抛错，改为 warn + 降级** —— 这是 D1 的明确要求（旧行为是静默降级或抛 INVALID_PARAMS，取决于路径）。
2. **用户自建 writer 角色失去自动隔离** —— 这是 D1 删自动默认的直接后果，也是 D4「限制死，不然容易耗尽资源」的意图。
3. **非 legion 的 centurion 现在也能拿到 worktree** —— 修复既有缝隙，行为 no-op。
4. **`test/unit/agents.test.ts:963` 那条「writer roles default to an isolated worktree」测试的断言方向要反过来**（改成断言「writer 不再自动补 worktree」+「bundled worker 是 false」）。这是**刻意的语义反转**，不是放宽断言。

## 刻意不做

- **不**引入 `worktree: allowed | forbidden` 能力位（D4 明确否决）
- **不改** `resolveLaunchWorktree` 的优先级链（共享冻结文件，不变式 I5）
- **不改** `src/supervisor/spawn-mode.ts` 的任何逻辑（`resolveSpawnMode` 必须保持纯配置读取）
- **不新增**事件类型（避免 §15-4 的修订面扩大）
- **不改** `docs/contracts/spawn-default-inprocess-v3.md`（FROZEN 历史契约）
- **不改** `agents/centurion.md` / `agents/prototype.md` / 其余 5 个角色卡
- **不动** `test/integration/nesting.test.ts`（它全部 pin `spawnMode: "rpc"`，且用 `role()` 工厂造 AgentConfig，不经过 `agents/*.md` 解析，D1 对它是 no-op）
- **不动** `test/unit/plan.test.ts:85`（`tasks[].worktree: true` 是 plan 层透传，不经过 launch 闸门）

## 验收命令

- A: `npm run typecheck` && `npm run test` && `npm run test:integration`
- B: `npm run typecheck` && `npm run test`

基线（master@dee3378）：unit **1078** pass / integration **81** pass。任何新增失败都必须修到绿。

## A 必须新增的测试（`test/integration/worktree-containment.test.ts`）

用**真实** `RoutingSupervisor`（契约 `docs/contracts/spawn-default-inprocess-v3.md:221` 硬要求：凡断言 `spawnMode × worktree` 组合必须用真实 router，FakeSupervisor 只校验 `kind !== "pi"` 是假绿）：

1. **非 centurion 显式要 worktree → warn 一次 + 降级为 inprocess + 无 worktreePath**（`subagent({ worktree: true })` 等价形态）
2. **同一 Orchestrator 上第二次违规不再 warn**（断言 `warnings.length === 1`）
3. **centurion 卡拿到 worktree + rpc**（默认后端下省略 spawnMode）
4. **centurion 父派 worker → worker 无 worktree + inprocess**（§9 的核心断言）
5. **嵌套 centurion → 拿到嵌套 worktree**（不被 parentRole 压制）
6. **端到端推荐形态**：根直派 2 个 centurion（2 个 worktree、2 个 rpc 进程）+ 每个 centurion 内派 worker（inprocess 同进程、无新 worktree）→ 断言 `spawns.length === 2` 且 worker 的 `spawnMode === "inprocess"` 且 `worktreeBranch === undefined`
7. **不抛错**：违规 launch 必须 resolve 成功（`assert.doesNotReject`）

真实 git 仓库用 `mkdtempSync` + `git init` + `git commit --allow-empty`，`finally` 里 `rmSync`（参照 `test/integration/legion-tree.test.ts:167-174` 与 `regressions.test.ts:150-158`）。

## B 的文档改动要点

- `docs/legion-v2-contract.md`：**修订 §9**（明确 worktree 仅 centurion、其余角色违规时降级而非报错），并在文末修订日志追加一条 `REV-17`（格式参照 `:461` 的既有条目：日期 + 条款号 + 原因）。§15-4 要求权限变更走修订，这一步是**强制**的。
- `src/extension/playbook.ts:16` 第 6 条必须重写。当前是「Isolation is YOUR call … Omit it for the role default」，改为：worktree 仅 centurion；要隔离就派 centurion，组员共享 checkout。**同步**改 `test/unit/playbook.test.ts:14-15`（`/Isolation is YOUR call/` 与 `/worktree: true/` 两条断言）。
- `index.ts:179` 的 worktree description 里「Omit to use the role default (bundled worker: true)」已过时（worker 不再是 true），改为指向 centurion。`index.ts:127`（`tasks[]` 版本）同步。
- `README.md`、`docs/inprocess-supervisor.md`、`docs/subagents-teams.md` 里所有「writer/centurion default to worktree: true」「worktree roles auto-fall back to rpc」的表述都要更新，并补一节「推荐形态：根直派 N 个 centurion，每个 centurion 内 inprocess 派 worker」。
- **不要**夸大：不要写「inprocess 现在是默认后端」之类已经过时的宣传语；只写 worktree 收权这一件事。
