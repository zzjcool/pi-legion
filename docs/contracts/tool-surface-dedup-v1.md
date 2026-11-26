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

## 附录 B — 修订 A1（review 后，2026-11-26）

三路对抗 review 结果：1 ok / 2 ok:false。共 2 critical / 6 major。本附录是**契约修订**，
与正文冲突时**以本附录为准**。

### B1 契约自身的错（我的表写错了，不是实现的错）

- **`host` 不是 launch-only**。`index.ts:2528` 的 `cwdIsRemote(params)` 对**每个** action 都读
  `params.host`（同文件 `:53-55` 正是以“dispatch 前对每个 action 都读”为理由豁免了
  `cwd`/`hostCwd`/`agentScope`）。所以 `{action:"resume", host:"box"}` 是被 `index.ts:4543-4554`
  明确支持的。→ **把 `host` 从 D3 的拒绝表里移出**，与 `cwd`/`hostCwd`/`agentScope` 同类。
- **`async` 的错误文案不得反向建议**。当前对 `{action:"wait", async:false}` 回
  `… Drop it or call action:"launch".`，而描述的原文恰好叫模型在同一 turn 里 `wait`/`collect`。
  → “call action:<x>” 后缀**只对控制类 owner 输出**；owner 是 `launch` 时只说 `Drop it.`
- **`extend` 的 `params` 必须含 `runId`**。它真的读（`index.ts:3610-3616` 先按 `params.runId`
  做作用域判定）。契约正文“先不碰 `runId`”指的是**不改行为**，不是准写出假文档。

### B2 D1 缩减：删三个死字段，排序改回生命周期序

- **删 `ActionSpec.summary`**、**删 `ActionSpec.required`**、**删 `ActionSpec.modelFacing`**。
  理由：三者生产消费者为零；`summary` 是 README 第二列的逐字副本且**上线当天就漂了**
  （`recover` 与 README 不一致）；`modelFacing` 14/14 恒 `true`，对应断言是同义反复。
  散文的唯一位面是 `README.md`；`required` 的二选一也无法用扁平数组表达。
- **`PARAM_OWNER_ACTIONS` 改为从 `ACTION_SPECS.params` 求逆推导**（只保留单 owner 字段），
  不再手写 16 项。手写的契约表保留在测试里作为治理锚点（`inert-params.test.ts:44-61`）。
- **`ACTION_NAMES` 改回生命周期序**（`launch, continue, steer, abort, resume, retire, status,
  collect, list, wait, stop, diagnose, extend, recover`），使派生的 `Actions:` 行与 schema union
  都回到可读顺序。
- **新增锚点**：`ACTION_SPECS[*].params` 的每一项必须是 `SubagentParams.properties` 的真 key
  （否则就是文档里凭空多一个字段）。
- **`docs/design.md` 的“N 个动作”数字也要断言**（现只比清单，把 `14` 改 `99` 仍绿）。

### B3 D2 补上契约自己要求的回归测试（critical）

正文写了“若删描述后该门失守，必须补一条回归测试”——**没补**，实测删掉
`index.ts:2116` 的 `${PARENT_PLAYBOOK}` 后 2669 个测试全绿。必须补：直接驱动
`before_agent_start`，断言

1. `selectedTools` 含 `subagent` 或 `vexillatio` → 返回的 `systemPrompt` **包含** `PARENT_PLAYBOOK`；
2. `selectedTools` 两者都不含 → **不包含**；
3. `isUtilityChild()` → 不包含。

并修掉 `test/unit/teams.test.ts:1943` 的假绿（它 match 的 `call the matching name immediately`
来自 roster `src/agents/agents.ts:1189`，且该 harness 传 `systemPromptOptions: {}` 绕门）。

### B4 D2 的反向保证降级为它能兑现的那条

反向断言只能挡**逐字**复制。把注释改成它真正保证的东西（“没有 playbook 整段被逐字粘贴”），
**不要**声称能挡改写。允许保留描述里 **2 句**关于工具自带回执/返回值的短句
（`wait` 超时不 retire、`Esc` 不 retire）——它们是 call-shape，不是 playbook 的搬运。

**但有一句必须先删**：描述里 `diagnose prints the Legion doctor report
(host vs child extensions/providers/models/memory)` 的括号清单与 schema `action` 字段的说法
不一致，且 `providers` **不是合法 section id**（真源 `src/extension/legion-doctor.ts:100-112`）。
→ 删掉括号清单，让 schema 那份（唯一与真源一致）承担。同理删 `wait REQUIRES …` 的重复半句。

### B5 D3 位置与类型

- inert 闸门移到 `signal?.aborted` 早退**之后**（仍在任何副作用之前）——否则“父 turn 已中断”
  的返回会从 `interrupted (…)` 变成 `INVALID_PARAMS`（未记录的行为变化）。
- `index.ts:334` 的 `as unknown as` 降为单跳 `as`（reviewer 已实测单跳可通过且 `Static` 仍是
  字面量联合）。
- 测试注释不得许诺过头：`inert-params.test.ts:286` 的 `supervisor.calls === []` 在 collect
  那半没有鉴别力（闸门不存在时也是 `[]`），真正立住的是 error code + 文案。

---

## 非目标（本契约不做）

1. 不减少 action 数量（`14 → 9` 的运维动词收编属于 **Step 2**，其机制前置是
   `exposure: "deferred"` + `tool_search` 在扩展工具上的实际可用性验证）。
2. 不拆成多工具（Step 3，按生命周期家族 3-4 个，仅在需要 fine-grained `--tools`
   权限粒度时）。
3. 不改任何工具名 / action 名 / 白名单 / 角色卡。

---

## 附录 A — Step 2 门禁：`exposure: "deferred"` 实跑结论（冻结后追加，不改 D1-D3）

2026-11-26 实测（宿主 1.6.1，进程内假 provider + `createAgentSession` + 内联扩展工厂，
观测真实 HTTP 请求体里的 `tools[]`；11 个场景）。**结论：机制可用，但子进程白名单形态
与它互斥。**

### A1 实测矩阵

| 配置 | 结果 |
| --- | --- |
| 无 `--tools`（root 会话的真实形态） | deferred **不声明**；`tool_search` 能捞到 → 下一轮声明 → 可调用 |
| `--tools` **精确名**含 deferred 名 | 工具被注册**并立即声明** → deferred 完全失效 |
| `--tools` **精确名**不含 deferred 名 | 工具**根本不注册**（`getAllTools()` 也没有）→ `tool_search` 永远搜不到 |
| `--tools` **通配符**命中（`legion_*`） | 注册但**不声明**，`tool_search` 可激活 → 唯一可用形态 |
| 模型直接调未激活的 deferred | `isError: true`，文案 `Tool <name> not found`（与未知工具无区别，无「该用 tool_search」提示） |
| `defaultActive: false`（不给 deferred） | 也不声明，但**永不可被 `tool_search` 搜到**，且通配符白名单会把它直接激活 → 不能替代 deferred |

### A2 由此产生的硬约束

1. **禁止**把 Step 2 的新工具加进任何**精确名**白名单——包括 `src/runs/args.ts:332-351`
   的 `LEGION_CHILD_TOOLS` 追加模式。加进去 = 首帧照旧声明 = Step 2 收益归零。
2. **禁止**用「从白名单删名字」来隐藏——那样工具根本不注册，`tool_search` 也无从救回。
3. 要用 deferred 隐藏，白名单必须**以通配符命中**该名字。
4. deferred 只在 `tool_search` 活跃时可达；且 `tool_search` **不会**因为注册了 deferred 工具
   而自动激活。

### A3 Step 2 的两个未决前置（不解决不许开工）

- **V1**：`--no-extensions` 是否连内置 `tool-search` 一起禁掉？仓库注释
  （`src/runs/args.ts:365-373`）与 `pi --help` 文案冲突。若子会话没有 `tool_search`，
  把运维动词藏到 deferred 后面等于**静默删掉 centurion 的 `extend`/`diagnose` 能力**。
- **V2**：子进程白名单策略要从「精确名逐条」改成「通配符」，这会动
  `args.ts` 与 `inprocess-supervisor.ts` 两条并行实现（parity 测试只保证两者相等，
  不保证等于你想要的集合）。

### A4 建议的分段（按机制风险从零往上）

- **2a（零机制风险）**：`diagnose` 与 `list` 对模型面是**重复能力**——`/legion doctor`
  与系统提示里的 roster 已经覆盖。直接从 action 面删掉即可，不依赖 deferred。
- **2b（低风险）**：`retire` 与 `stop` 重叠（playbook 自己就叫模型用 `stop`）。
  先统计真实调用分布再从面删。
- **2c（依赖 A3）**：`recover` / `extend` 才需要 deferred 包装——它们是真正低频但不可删的。

这样 `14 → 12 → 11 → 9` 是三级台阶，前两级不碰宿主机制。
