# collect-merge v1 — `wait` 吸收 `collect`（12 → 11）

- 状态：**FROZEN**（2026-11-26）
- 前置：`tool-surface-dedup-v1`、`tool-surface-ops-verbs-v1`、`tool-surface-ops-verbs-v2`、
  `dispatch-boundary-v1`（均已合入，现 12 个动作、`subagent` 描述 1,371 字符、`action` 字段 857）
- 范围：删除 `collect` action，其能力由 `wait` 承担。**不新增工具、不改工具名、不动白名单。**

---

## 0. 依据：`collect` 是 `wait` 的严格子集

1. **同一份结果渲染**：`renderWait` 对每个已结算的子节点直接调 `renderCollect`
   （`index.ts:6771`）。两者的输出形状、verification 行、产物大小完全相同。
2. **`wait` 是超集**：`wait` 支持 `name` **或** `all`；`collect` 只有 `name`。`collect` 没有
   `timeoutMs`（它的阻塞界是子节点自己的 turn 超时，调用方管不了）。
3. **调用量**：587 次真实调用里 `wait` 355 次（60%）、`collect` 18 次（3%）。
4. **回执去重已由 `wait` 覆盖**：`wait` 把已结算子的 artifactId 放进 `details.ledgerReads`
   （`index.ts:7599`），工具层 `markDelivered` 写 `read_bytes = bytes`，通知投影
   （`src/legion/ledger.ts:253` 的 `read_bytes < bytes`）在 **flush 时重查**
   （`src/extension/runtime.ts:1511`）→ 不再发通知。`collect` 的典型用法是"通知到了再取全文"，
   天然会产生一次内容重复。

---

## D1 — 删除 `collect` action

- `src/extension/action-surface.ts`：从 `ACTION_NAMES` 与 `ACTION_SPECS` 移除 `collect`。
  `PARAM_OWNER_ACTIONS` 由 `ACTION_SPECS.params` 求逆推导，**自动跟上**，不要手改。
- `index.ts`：移除 `action === "collect"` 的工具分支。

**保留**（不是死代码，别删）：

- `collectAction` / `renderCollect` / `CollectSnapshot` 等函数与类型：`wait` 与 `recover` 都在用
  （`recover` 走 `renderCollect`，`index.ts:7013`；`wait` 在 `:6771` 调它）。
- `/legion` 命令与 TUI 里若调用了 `collectAction`，**保持不动**（本次只删"模型可见的 action"，
  不删内部能力）。

## D2 — `wait` 必须能替代 `collect` 的每一条用法

逐条核对并实测：

| 原 `collect` 用法 | 删除后的等价调用 |
| --- | --- |
| `collect({name})` | `wait({name})` |
| `collect({name, runId})` | `wait({name, runId})` —— 见下 |
| 想拿"当前 turn"的结果但不设超时 | `wait({name, timeoutMs: <角色的 turn 预算>})` |

**已知缺陷，本契约不改但要记录**：`wait` 不读 `runId`（`ACTION_SPECS.wait.params` 里没有它，
而 `collect` 有）。所以 `collect({name, runId})` 这个用法**没有逐字等价物**——`wait({name, runId})`
里的 `runId` 会被 inert-param 闸门**拒绝**。

处理方式（二选一，实现者选并说明理由）：

- **(a)** 接受：`runId` 的作用域在 `wait` 上不存在，调用者用 `name` 即可（跨 run 同名子有歧义时
  会被明确报告）。`wait` 的描述里不要承诺 `runId`。
- **(b)** 顺手让 `wait` 也读 `runId`（与 `collect` 对齐）。这超出本契约的"删除"范围，
  **需要父会话批准**，不要自作主张做。

默认走 (a)。

---

## 附录 A — review 后的修正（FROZEN 后追加，以本附录为准）

### A1 D2 的机制描述写错了

正文说 `wait({name, runId})` 会被 inert-param 闸门**拒绝**。**错**：`runId` 是多消费者参数
（`continue/steer/abort/resume/status/stop/extend` 都读），不在拒绝表里，所以它被**静默忽略**
（既有 `test/unit/inert-params.test.ts:154` 钉的正是这个行为）。结论不变（用 `name`），但理由要说对。

### A2 「`wait` 是 `collect` 的超集」**不成立**——必须补上，否则这是能力回退

实测：`wait` **只查本会话 runtime，从不读 run store**。因此两类 `collect` 用法无等价物：

1. **`/reload`、会话重启后读自己之前的子**：子只存在 store 里，`wait` 给 `NOT_FOUND`；
2. **`vexillatio` 的 utility 子**：返回即 release，runtime 里没了；`collect` 能从 store 读，`wait` 不能。

实测证据（worker 贴的原始红灯）：vexillatio 用例把 `collect` 换 `wait` 后，输出从
`utility output for scout` 变成 `NOT_FOUND`。

**决定（D5）：`wait` 的目标解析必须与 `collect` 对齐——miss 时回退到 `resolveScopedChild`（同一个
resolver，`status`/`stop`/`collect` 都在用）。** 这是纯内部一致化：

- 不加新参数、不加新动作、不改 `wait` 的既有行为；
- 仅在**今天返回 `NOT_FOUND` 的那条路径**上多做一次 store 查询；
- store 里找到且已结算的子 → **立即返回缓存结果**（`wait` 对 runtime 里已结算的 job 已经这么做了）；
- store 里找到但仍在跑的子（不在本会话 runtime）→ 与 `collect` 一致：读当前 turn 的最后快照。

同时：被删掉的 3 条断言按 `c69f722^` **恢复**（它们是 `collect` 在 reload / utility 两条路径上的
真实覆盖，不是“只证明 collect 存在”）。

### A3 所有权扩充：一处用户可见文案

`src/extension/slash.ts:386` 的用户可见文案仍写 `status/collect/wait`，且 `test/unit/toggle.test.ts:126`
逐字 pin 它。现在 `collect` 不是动作了——**授权仅改这处文案**（零逻辑改动）+ 同步那条 pin。

### A4 遗留（本轮不改）

`src/shared/types.ts:1071`、`src/extension/scout-guard.ts:314` 的注释里提到 `collect`（作为内部概念存在歧义），
`test/docker/xm/scenarios/launch.json:48` 的 fixture。均为注释/测试夹具，另计。

## D3 — 文档与文案同步

| 文件 | 改什么 |
| --- | --- |
| `README.md` | 删 `collect` 表行；正文里"collect the result"一类指引改成 `wait` |
| `docs/design.md` §9.3 | 清单去 `collect`，`N 个动作` 12 → 11 |
| `skills/pi-legion/SKILL.md` | 若有 `action: "collect"` 示例，改 `wait` |
| `src/extension/playbook.ts` / `index.ts` 的 `action` 字段描述 | 删掉把 `collect` 当动作名的句子（描述里现出现 2 次）；`runId` 参数描述里的动作列表 `status/collect/stop/…` 去掉 `collect` |
| `test/mock-llm/README.md`、`test/mock-llm/scenarios.ts` | 若 fixture 发 `action:"collect"`，改 `wait` |

## D4 — 测试

`test/` 里有 **15 处** `{ action: "collect" }` 调用（`test/integration/vexillatio.test.ts`、
`test/unit/{inert-params,control-scope-scan,ledger-read-marking,teams,wait-mail-preempt,scout-guard,child-scope-actions}.test.ts` 等）。

每条都要判定并处理：

- **改成 `wait`**（大多数）：保持它原本要覆盖的东西不变（尤其是 `ledger-read-marking` 里那条
  "交付即记账"的断言——改成 `wait` 后它仍在测同一件事，且现在测的是**唯一**的读动词）；
- **删掉**（只有当它唯一的目的就是证明 `collect` 存在）；
- 不许为了让测试绿而删掉断言。

---

## 归属（文件所有权）

**可改**：`src/extension/action-surface.ts`、`index.ts`（仅 action 分支 + 描述文本）、
`src/extension/playbook.ts`、`README.md`、`docs/design.md`、`skills/pi-legion/SKILL.md`、
上述 15 处测试所在的文件、`test/mock-llm/*`。

**禁止触碰**：`src/runs/**`、`src/supervisor/**`、`src/extension/legion-tools.ts`、
`src/extension/legion-output.ts`、`src/extension/slash.ts`、`src/extension/legion-commands.ts`、
`src/legion/**`、`agents/**`、其它 `docs/contracts/**`、`docs/archive/**`、`docs/audits/**`。

---

## 验收门禁

- `npm run typecheck`
- `npm test`
- `npm run test:integration`

三条全绿；首个非零退出即 rejected。

## 验收断言（必须存在并被实测）

1. `ACTION_NAMES` 长度 **11**，且 `collect` 不在其中；schema union 与 `Actions:` 行一致。
2. `subagent({action:"collect", name})` → **不是**已注册动作（`unhandled action: collect` 或
   schema 层拒绝）。
3. `wait({name})` 对一个已结算子、对一个活子、对 `name`+`all` 互斥冲突，行为与改动前一致。
4. `recover` 仍可用且仍走 `renderCollect`（回归断言）。
5. `ACTION_SPECS` 里 `collect` 曾独占的参数（无）——确认没有参数因此变成无主或被误拒。
   特别验证 `runId`：它仍被 `status`/`stop`/`steer`/`abort`/`continue`/`resume`/`extend` 读取，
   **不会**因为删 `collect` 而变成单消费者。
6. `action` 字段描述不再出现 `collect` 作为动作名；`runId` 描述里的动作列表已去掉 `collect`。
7. 通知去重未被破坏：`test/unit/ledger-read-marking.test.ts` 改完后仍断言
   `consumption.readBytes === artifact.bytes` 且 `undelivered(db, "root")` 为空。

## 非目标

1. 不删 `wait`（它是唯一的有界等待；`timeoutMs` 514 次真实使用、超时决策清单、
   `interrupted (parent turn ended; children still running)`、`wait-mail-preempt-v1` 都挂在它上面）。
2. 不改成"纯自动回执"（push 在父会话忙时延到 turn 结束才到，模型会失去 turn 内取结果的能力）。
3. 不让 `wait` 读 `runId`（除非父会话另行批准，见 D2）。
4. 不动 `status` / `stop` / `diagnose` / `extend` / `recover` / `launch` / `continue` / `steer` /
   `abort` / `resume`。
