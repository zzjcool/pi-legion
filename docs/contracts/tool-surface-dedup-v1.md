# tool-surface-dedup v1 — 工具面收水契约

- 状态：**FROZEN**（2026-11-26）
- 范围：`subagent` 工具面**形状不变**（仍是单工具 + 14 个 action）。本契约只做三件收水，
  不改任何工具名、不改 action 名、不改 `--tools` 白名单、不动 `tools:` 卡片。
- 前置侦察：`action` 清单目前存在 4 份互不同步的副本，模型真正读到的那份最短：

| 面 | 位置 | 动作数 |
| --- | --- | --- |
| schema（真源） | `index.ts:319-338` | 14 |
| README 表 | `README.md:219-231` | 13（缺 `recover`） |
| `docs/design.md` §9.3 | `docs/design.md:545` | 13（缺 `recover`） |
| 模型可见的 `TOOL_DESCRIPTION` | `src/extension/playbook.ts:28` | 12（缺 `extend`/`recover` 于 Actions 行） |

另有 `PARENT_PLAYBOOK` 4,760 字符以 **md5 完全相同**的形态同时出现在 tool description
（`index.ts:2479`）与 systemPrompt（`index.ts:2110`）两处，每请求重复约 1,360 tokens。

---

## D1 — 动作面单一真源 + 漂移探测

**决定**：新建 `src/extension/action-surface.ts` 作为动作面的唯一真源；代码侧**派生**，
Markdown 侧**断言**（不做 codegen，文档必须保持人可读）。

必需导出：

```ts
export const ACTION_NAMES = [
  "launch", "continue", "steer", "abort", "resume", "retire", "status",
  "collect", "list", "wait", "stop", "diagnose", "extend", "recover",
] as const;

export type ActionName = (typeof ACTION_NAMES)[number];

export interface ActionSpec {
  /** README / design.md 表里的 "What it does" 一句话（英文，与 README 现有措辞同风格） */
  readonly summary: string;
  /** 该 action 真实读取的参数字段 */
  readonly params: readonly string[];
  /** 其中必须提供的 */
  readonly required: readonly string[];
  /** 是否属于模型面（本契约全部 true；Step 2 会用它把运维动词标 false） */
  readonly modelFacing: boolean;
}

export const ACTION_SPECS: Readonly<Record<ActionName, ActionSpec>>;
```

**消费者（必须真的接上，不是并列新副本）**：

1. `index.ts` 的 `SubagentParams.action` 的 `Type.Union` 由 `ACTION_NAMES` 构造
   （如 `ACTION_NAMES.map((a) => Type.Literal(a))`）。禁止再手写字面量列表。
2. `TOOL_DESCRIPTION` 里的 `Actions: …` 那一行由 `ACTION_NAMES` 拼接产生。
3. 新增 `test/unit/action-surface-drift.test.ts`：解析 README 表格首列、`docs/design.md`
   §9.3 表、`TOOL_DESCRIPTION` 的 Actions 行、schema 的 union，四者**集合相等**；
   且每个 `ACTION_NAMES` 都有非空 `summary`。

**验收**：把 `recover` 从 schema 里删掉而不同步文档 → 该测试必须红。（手工试一次再还原，或
在测试里断言"缺一即失败"的逻辑本身。）

**不做**：不把 README 表格生成成产物；不为 14 个动作写中文文档。

---

## D2 — `TOOL_DESCRIPTION` 不再内嵌 `PARENT_PLAYBOOK`

**决定**：playbook 只从 `before_agent_start` 注入一次。`TOOL_DESCRIPTION` 保留"怎么调"
（动作清单 + 参数契约 + abort/stop 边界），不再重复"何时/是否该调"（playbook 负责）。

新不变量（写进测试）：

- `TOOL_DESCRIPTION` **不含** `PARENT_PLAYBOOK`（`assert.equal(TOOL_DESCRIPTION.includes(PARENT_PLAYBOOK), false)`）。
- `TOOL_DESCRIPTION` 仍然包含 Actions 行（D1 派生）与 abort/stop 边界句。
- `before_agent_start` 在 `selectedTools` 含 `subagent` 时仍然注入 `PARENT_PLAYBOOK`
  （现有 `test/unit/legion-session-continuity.test.ts:207` 已覆盖；若删描述后该门失守，
  必须在本契约里补一条回归测试）。

**这是一次决策反转，必须显式记录**：`test/unit/playbook.test.ts` 里现有注释
*"TOOL_DESCRIPTION embeds PARENT_PLAYBOOK, so it inherits the paragraph — asserting it here
pins the embedding (no second copy to drift)"* 所钉的正是"**同一份文本两处出现**"。
该注释要改成新理由：**文字只有一份真源，但模型可见的注入点只有 systemPrompt**。
相应断言从 `assert.match(TOOL_DESCRIPTION, <playbook-only 句子>)` 改为只对
`PARENT_PLAYBOOK` 断言，并新增"描述不内嵌 playbook"的反向断言。

**不许做的事**：不得为了让描述"看起来完整"而把 playbook 的句子改写到 `TOOL_DESCRIPTION`
里——那就是把两份副本换成两份**变体**，更糟。

---

## D3 — 无关参数不再静默忽略（收窄版）

**决定**：只对"**证明只有一个消费者**"的参数做硬拒绝，其余留作后续。

| 参数 | 唯一合法 action |
| --- | --- |
| `timeoutMs` | `wait` |
| `ms` | `extend` |
| `force` | `stop` |
| `clearQueued` | `abort` |
| `section` | `diagnose` |
| `team` | `launch` |
| `agent` `task` `tasks` `async` `preset` `worktree` `verify` `phases` `start` `host` | `launch` |

实现：`src/extension/action-surface.ts` 导出纯函数

```ts
export function inertParamsFor(action: ActionName, params: Record<string, unknown>): string[]
```

返回"显式提供（非 `undefined`）但对本 action 完全无效"的字段名。

- `execute` 在 `action` 解析之后、任何副作用之前调用它；非空则
  `fail(<列出字段> + 该字段的实际 action, INVALID_PARAMS)`。
- 错误文案必须可行动，例如：
  `force is only read by action "stop" (got action "collect"). Drop it or call action:"stop".`

**明确排除在本契约之外**（后续单独决策，不要在本次实现）：

- `runId` 在 `wait` 上被忽略（`wait` 在 `index.ts:3371` 提前返回，走不到作用域解析）。
  文档口径与实现已经不一致（`index.ts:439` 说 `extend` 不用 `runId`，但 `extend` 实际
  在 `:3643` 返回前已用它做过作用域判定）。**先不碰**。
- `timeoutMs` 没有取值校验（负值/NaN 直接进 `setTimeout`），而 `ms` 有
  `isSafeInteger && > 0`。**先不碰**。
- 不把任何互斥/必填规则搬进 root 级 `anyOf`/`if-then`。原因（硬约束，已验证）：
  `pi-ai/dist/api/anthropic-messages.js:1404-1415` 源码注释原话
  *"Other root keywords stay out: Anthropic rejects root anyOf/oneOf/allOf with a 400."*
  → root 级条件 schema 对 Anthropic 类模型不可见，写了也讲不清楚。

---

## 归属（文件所有权）

**本 worker 可改**：

- `src/extension/action-surface.ts`（新增）
- `src/extension/playbook.ts`
- `index.ts`（仅：`SubagentParams.action` union、`execute` 的 inert-param 调用点）
- `test/unit/playbook.test.ts`
- `test/unit/action-surface-drift.test.ts`（新增）
- `test/unit/inert-params.test.ts`（新增）
- `README.md`（`### …` 下的 action 表格、`The action union is closed` 那句附近）
- `docs/design.md`（仅 §9.3 那张表）

**禁止触碰**：`src/runs/**`、`src/supervisor/**`、`src/extension/legion-tools.ts`、
`src/extension/legion-output.ts`、`agents/**`、`SKILL.md`、任何 `docs/contracts/**` 其它文件。

超出清单的需求 → 回 verdict 上报，不要自行扩权。

---

## 验收门禁

- `npm run typecheck`
- `npm test`（unit，166 文件）

两条都必须绿；首个非零退出即 rejected。

## 非目标（本契约不做）

1. 不减少 action 数量（`14 → 9` 的运维动词收编属于 **Step 2**，其机制前置是
   `exposure: "deferred"` + `tool_search` 在扩展工具上的实际可用性验证）。
2. 不拆成多工具（Step 3，按生命周期家族 3-4 个，仅在需要 fine-grained `--tools`
   权限粒度时）。
3. 不改任何工具名 / action 名 / 白名单 / 角色卡。
