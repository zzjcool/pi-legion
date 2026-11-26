# dispatch-boundary v1 — 两条管道，各管一种子节点

- 状态：**FROZEN**（2026-11-26）
- 前置：`tool-surface-dedup-v1`、`tool-surface-ops-verbs-v1`、`tool-surface-ops-verbs-v2`（均已合入，现 12 个 action）
- 目标：把 `subagent` 与 `vexillatio` 从**能力重叠**改成**互补**，并让边界从"文档约定"变成"机器契约"。

---

## 0. 现状（实测）

| 身份 | `subagent` | `vexillatio` |
| --- | --- | --- |
| root | ✅ | ✅ |
| centurion（可嵌套） | ✅ | ✅ |
| worker（不可嵌套） | ❌ | ✅ |
| scout（utility 子） | ❌ | ❌ |

而且 **`subagent` 现在能派 utility agent**：`{agent:"scout", task}` 会成功
（`test/integration/vexillatio.test.ts:388` 把它叫作 "misconfigured utility roles"），
但它**没有** vexillatio 才设的两个 flag（`utilityDispatch: true` / `stripLegionIdentity: true`，
只在 `index.ts:5644-5645` 出现）。即：同一个意图两条路径、两种语义。

---

## D1 — `subagent` 硬拒 utility 目标

**决定**：`subagent` 的 `launch` 不接受 `utility: true` 的角色，`INVALID_PARAMS` 硬拒，
且在**任何持久副作用之前**拒绝（不建 run 目录、不写 ledger、不 spawn）。

覆盖两种入参形态：

- 单发：`{agent:"scout", task:"…"}`
- 批量：`{tasks:[{agent:"scout",…}]}`；**混批**（worker + scout）整批拒绝，
  不允许"先起 worker 再报错"。

**文案必须可行动**（这是它与"工具不存在"这条原则的接口）：点名 `vexillatio`
并给出等价调用形状，例如：

```
`scout` is a utility agent (utility: true); it is read-only recon and is dispatched by
`vexillatio`, not `subagent`. Use vexillatio({ task: "…", agent: "scout" }) — or
vexillatio({ tasks: [...] }) for parallel recon. `subagent` launches the command chain
(worker / centurion) only.
```

（措辞可微调，但必须同时含：目标角色名、`vexillatio` 这个名字、一个可直接照抄的等价调用。）

**守卫只写一处**。不要同时在 `execute` 和 `buildPlan` 各写一份——那是两份副本。
放哪儿由实现决定，但必须满足：拒绝发生在 `resolveLegionIdentity` / `createRootLegion` /
`reopenSessionRun` / `orchestrator.launch` 之前，并且有测试证明"拒绝后没有 spawn、没有新 run 目录"。

## D2 — `vexillatio` 的可用性**不变**

保持现状：所有**非 utility** 会话都能用（root / worker / centurion），
**utility 子自己永远没有 `vexillatio`**（hard leaf，无深度预算，允许它派 scout 就是无限递归）。

已有护栏，**不得放宽**：`index.ts:612` `isUtilityChild()`、`index.ts:1978` 的 `!isUtilityChild()` 注册门、
`index.ts:2920-2925` 的 `utilityWarnings`（"utility identity takes precedence and nested dispatch is ignored"）、
`test/unit/teams.test.ts` 里 "utility child gets no vexillatio" 的两条测试。

## D3 — `agent` 字段文案要说清它是"命令链角色"

现在 `agent` 的描述只有 `"Agent name (single launch)"`。改成明确指出：

- 它是**命令链**角色（`worker` / `centurion`）；
- 只读侦察走 `vexillatio`；
- 给 utility 角色会被拒。

这条比加 action 更能减少误用，而且成本是一句话。

## D4 — 同步包自己的招牌示例（**必须同一次改完**）

一旦硬拒，下面两处就变成"教模型做一件必然失败的事"——正是 playbook `#303` 的形态：

| 位置 | 现状 |
| --- | --- |
| `README.md:189` | 头号示例 `subagent({ agent: "scout", task: "Map the export code path…" })` |
| `skills/pi-legion/SKILL.md:16` | `subagent({ agent: "scout", task: "<question list>" })`（随包发布、进系统提示） |

两处改成 `vexillatio(...)` 等价写法。**不要**留下"可以用 subagent 派 scout"的暗示。

---

## 归属（文件所有权）

**可改**：

- `index.ts`（守卫 + `agent` 字段文案）
- `README.md`（`:189` 示例；若邻近散文也教了该用法一并改）
- `skills/pi-legion/SKILL.md`（`:16` 及同类示例）
- `docs/design.md`（§9.3 工具表：给两个工具各一句"职责边界"）
- `test/integration/vexillatio.test.ts`（把 `:388` 那条 "compatible with misconfigured utility roles" **反转**成"必须被拒 + 文案指路 vexillatio"）
- `test/mock-llm/scenarios.ts`、`test/integration/mock-llm-legion-e2e.test.ts`、`test/integration/railway-mock-e2e.test.ts`（fixtures 里用 `subagent` 派 scout 的，改走 `vexillatio`）
- `test/unit/playbook.test.ts`（若断言了 `agent` 的描述文本）
- 新增测试可放 `test/unit/` 或上述文件

**禁止触碰**：`src/runs/**`、`src/supervisor/**`、`src/extension/legion-tools.ts`、
`src/extension/legion-output.ts`、`src/extension/slash.ts`、`src/extension/legion-commands.ts`、
`agents/**`、其它 `docs/contracts/**`、`docs/archive/**`、`docs/audits/**`。

---

## 验收门禁

- `npm run typecheck`
- `npm test`
- `npm run test:integration`

三条全绿；首个非零退出即 rejected。

## 验收断言（必须存在并被实测）

1. `subagent({agent:"scout", task})` → `INVALID_PARAMS`，文案含 `vexillatio`；`supervisor.spawns.length === 0`；
   且**没有**新建 run 目录（`<cwd>/.pi-subagents/runs/*` 数量不变）。
2. `subagent({tasks:[{agent:"worker",…},{agent:"scout",…}]})` → 整批拒绝，无 spawn、无残留 run 目录。
3. `subagent({agent:"worker", task})` 与 `subagent({agent:"centurion", task})` 行为**不变**。
4. `vexillatio({task:"…"})` 行为不变（含缺省 `agent` → `scout`）。
5. utility 子依旧拿不到 `vexillatio`（既有测试保持绿）。
6. 一条**防止文档回潮**的断言：`README.md` 与 `skills/pi-legion/SKILL.md` 里不再出现
   `subagent({ agent: "scout"` 这一形状（正则匹配，允许不同空白）。

## 非目标

1. 不改工具名、不合并工具、不动 `--tools` 白名单与角色卡。
2. 不让 scout 拥有 `vexillatio`（见 D2）。
3. 不动 `continue`/`resume` 对**已存在**的 utility 子节点的复活路径（它们不读 `params.agent`）。
4. 不改 `recover` / `diagnose` / `extend`。
