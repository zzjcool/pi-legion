# 子会话 builtin 扩展与 legion 工具白名单 v1（MR1）

Status: **frozen**（实施中，改动需修订本文件并注明原因）
Owner: root session
Scope: in-process 子会话装配（`src/supervisor/inprocess-supervisor.ts`）+ rpc argv 白名单（`src/runs/args.ts`）

本文件只覆盖 **MR1**。MCP 启用（MR2）与 `bindExtensions` 补发 `session_start`（MR3）
明确不在本契约范围内。

---

## 1. 问题（实测，非推断）

### P1 — 子会话声明了 `codemode`，但工具不存在

用 `InProcessSupervisor` 的原始 loader 参数（`noExtensions: true`,
`additionalExtensionPaths: ['builtin:codemode']`）跑宿主 SDK：

```
errors: ["Unknown built-in extension: builtin:codemode"]
extensions: []
```

原因：`DefaultResourceLoader` 的 `builtin:<name>` 路径只能从
`extensionFactories` 里 `builtin: true` 的项解析（`dist/core/resource-loader.js:551`），
而 `defaultSessionFactory` 从不传这个字段。

真机确认：派一个真 scout 自报，`TOOLS: read, grep, find, ls, bash` ——
role card 里的第 6 个工具 `codemode` 消失。

### P2 — worker/scout 拿不到 `legion_mail` / `legion_tree` / `legion_phase`

`tools:` 白名单对所有工具生效（MCP 除外，见 `dist/core/agent-session.js:1151-1161`），
过滤点在 `:2901`。`resolveInProcessTools` 只补 `vexillatio`，`pushToolArgs` 同样，
所以 `legion_mail` 注册后被裁掉。

真机确认：同一个 scout 自报 `LEGION_MAIL: no`。

后果：子 agent 中途无法向父/兄弟上报，团队只剩「收尾 verdict」一条上行通道；
而 `docs/legion-v2-contract.md:75` 写的是「所有子节点注册」。

---

## 2. 决策

### D1 — 注入 builtin extension factories

`defaultSessionFactory` 的 `loaderOptions` 增加 `extensionFactories`，内容为宿主三个
replaceable builtin，顺序固定：

| name | factory |
|---|---|
| `codemode` | `createCodemodeExtension()` |
| `tool-search` | `createToolSearchExtension()` |
| `mcp` | `createMcpExtension()` |

每项形如 `{ name, factory, builtin: true, replaceable: true }`
（类型见 `dist/core/extensions/types.d.ts:1542-1568`）。

三条约束：

1. 工厂必须**动态 import**，与现有 `createAgentSession` 等一起在
   `defaultSessionFactory` 内部解构；禁止模块顶层静态 import（保持现有的惰性加载）。
2. 传 factory **不激活任何东西**：`builtin:` 路径（由 `collectChildExtensions` 决定）
   才是开关。已实测：只给 factories、不给路径 → `extensions: []`。
   因此 D1 对当前行为零影响，唯一变化是 `builtin:codemode` 得以解析。
3. `mcp` 这一项也放进列表，但它**没有对应路径**，因此 MR1 不会连接任何 MCP server
   （MR2 只补一条路径即可）。若宿主装了注册 `/mcp` 的第三方扩展，`replaceable`
   语义与宿主一致，无需额外处理。

新增 `src/supervisor/child-builtins.ts`，只导出**名字常量**（不 import SDK，避免测试期
加载宿主包）：

```ts
export const CHILD_BUILTIN_EXTENSIONS = ["codemode", "tool-search", "mcp"] as const;
```

### D2 — legion 工具进白名单（两处，必须逐字节一致）

`resolveInProcessTools`（in-process）与 `pushToolArgs`（rpc）在补齐 `vexillatio` 之后，
继续补齐 `legion_mail`、`legion_tree`、`legion_phase`（固定顺序，缺席才追加）：

```
[ ...card tools, "vexillatio"?(non-utility), "legion_mail", "legion_tree", "legion_phase" ]
```

- 未注册的工具名出现在白名单里是**惰性**的：`getToolListError`
  （`dist/core/settings-manager.js:45-55`）只校验 `+`/`-` 混用，不校验未知名；
  `_isAllowedTool` 只做匹配。因此 `legion_phase`（centurion 且声明了 machine 才注册）
  可以无条件写入。
- utility 子节点（scout）同样获得 `legion_mail` / `legion_tree`，与
  `docs/legion-v2-contract.md:75` 的「所有子节点」表述一致。
- 副作用（预期）：这些工具从「注册但被裁」变为「注册并声明给模型」。工具数 +2/+3。

### D3 — `noExtensions` 保持 `true`

不改。rpc 与 in-process 的扩展集合必须继续逐字节一致（`src/runs/args.ts:280-289`）。

### D4 — 不启用 MCP

不新增 `builtin:mcp` 路径，不动 role card，不动 `inheritMcp`（尚未存在）。
MR2 才做。

### D5 — 不调用 `bindExtensions`

`session_start` 仍然不触发。理由：legion 依赖这一事实（`docs/inprocess-supervisor.md:183`，
补偿逻辑在 `index.ts:1600-1618`），补发会带来 child-guard / identity 双挂风险。
只有 MCP 需要它 → MR3 单独实施。

### D6 — 回归门禁（本次 bug 必须被机械测试挡住）

三个测试，缺一不可：

1. `buildInProcessSessionPlan` 对带 `tools:` 的卡片返回的白名单包含
   `legion_mail` / `legion_tree` / `legion_phase`。
2. **parity**：同一张卡片，`buildInProcessSessionPlan(...).tools` 与 rpc
   `--tools` 的值（逗号分割）**深度相等**。这是防止两条路再次漂移的唯一门禁。
3. **builtin 名字闭合**：对 `collectChildExtensions` 产出的每个
   `builtin:<name>`，`<name>` 必须 ∈ `CHILD_BUILTIN_EXTENSIONS`。
   只要有人再往路径里加 builtin 名而忘了 factory，这条就红。

---

## 3. 文件所有权

| 文件 | 允许的改动 |
|---|---|
| `src/supervisor/child-builtins.ts` | 新建，只放名字常量 |
| `src/supervisor/inprocess-supervisor.ts` | `extensionFactories` 注入；`resolveInProcessTools` 补三个名字 |
| `src/runs/args.ts` | `pushToolArgs` 补同样三个名字 |
| `test/unit/inprocess-supervisor.test.ts` | 更新既有断言 + D6 的 1、2 |
| `test/unit/args.test.ts` | 更新既有断言 + D6 的 2、3 |
| `test/unit/supervisor.test.ts` | 仅 `:301` 的 `--tools` 字面量断言 |
| `test/integration/orchestrator.test.ts` | 仅 `:101` 的 `--tools` 字面量断言 |
| `test/integration/vexillatio.test.ts` | 仅 `:397`、`:413` 的 `--tools` 字面量断言 |
| `CHANGELOG.md` | `## [Unreleased]` 下一条 bullet |

越界即拒收：role cards（`agents/*.md`）、`index.ts`、child-guard、legion-tools、
任何 MCP / bindExtensions 相关代码。

---

## 4. 验收

机械门禁（父会话的 `verify` 数组，失败即拒）：

```
npm run typecheck
npm test
npm run test:integration
```

行为验收（父会话自行执行，不要求 worker 跑）：

- 新建 in-process 子会话后，`getAllTools()` 里出现 `codemode`；
- 同名探针的 `legion_mail` 不再被白名单裁掉；
- 子会话仍然**没有**任何 `mcp__` 工具（MR1 不引入 MCP）。

---

## 5. 明确不做

- 不提升 `codemode` 到默认工具集：它来自 role card 的 `tools:` 声明，`centurion` 无
  `tools:` 字段，行为不变。
- 不改 `toolBudget` 语义（脚本内嵌套调用照旧各计一次）。
- 不改只读分类（`classifyReadonlyBash`）。
- 不动 `session_start`。

---

## 6. 修订记录

### r1（D2 实施后）— 文件所有权扩容

**原因**：D2 必然改变 rpc `--tools` 的值，于是所有写死旧白名单的断言同时失效。
首版 §3 漏掉了三处**不在** `test/unit/{inprocess-supervisor,args}.test.ts` 里的字面量断言：

| 位置 | 旧值 |
|---|---|
| `test/unit/supervisor.test.ts:301` | `read,bash,vexillatio` |
| `test/integration/orchestrator.test.ts:101` | `read,bash,vexillatio` |
| `test/integration/vexillatio.test.ts:397` | `read,grep,find,ls`（utility，无 vexillatio） |
| `test/integration/vexillatio.test.ts:413` | `read,grep,find,ls,vexillatio` |

它们与「`npm test` 全绿」互斥，worker 正确拒绝越界。

**修订**：

1. §3 授权上述四处**仅**改 `--tools` 字面量（同时把 `npm run test:integration`
   加进 §4 的机械门禁）。
2. 断言里不得放宽语义：`test/integration/vexillatio.test.ts` 的两条要保留其原意
   （utility 角色仍不得继承 `vexillatio`），只追加 legion 三名字。
3. 若实施中发现**还有**写死旧白名单的断言，追加授权即可，不必再停 ——
   判据是「只改字面量、不改语义」。
