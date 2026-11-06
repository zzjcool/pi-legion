# 子会话 MCP v1（MR2，含原 MR3）

Status: **frozen**（实施中，改动需修订本文件并注明原因）
Owner: root session
Supersedes: `docs/contracts/child-builtin-extensions-v1.md` 的 D4（不启用 MCP）与 D5（不调 `bindExtensions`）；
其余条款不变。

---

## 1. 为什么 MR2 与 MR3 合并

侦察结论（`dist/extensions/mcp/index.js:971`、`dist/core/agent-session.js:2698`）：

- MCP 服务器的 `loadConfig` + `startConnection` **全部**发生在 `session_start` handler 里；
- `session_start` 只由 `AgentSession.bindExtensions()` emit，三个调用点分别在
  `interactive-mode.js:1563` / `print-mode.js:53` / `rpc-mode.js:230`；
- `createAgentSession()` **不调** `bindExtensions`。

所以：

| 路径 | 加 `builtin:mcp` 路径 | 结果 |
|---|---|---|
| rpc（worktree centurion） | 需要 | **能连**（rpc-mode 已经 bind） |
| in-process（scout/worker，默认） | 需要 | **仍然连不上**，必须补 `bindExtensions` |

只做路径 = 只修少数派、且对默认路径零效果。因此合并成一次交付，但内部按 D1→D3→D4 顺序实施，
风险最高的 D3 单独可回滚。

---

## 2. 决策

### D1 — 路径注入（两条路共用 `collectChildExtensions`）

`src/runs/args.ts` 的 builtin 注入区（当前只有 `builtin:codemode`）追加：

```
builtin:mcp
builtin:tool-search
```

顺序固定：`builtin:codemode` → `builtin:mcp` → `builtin:tool-search`，去重沿用现有
`extensionDedupeKey`（first-wins，`args.ts:261-269`）。`tool-search` 不是可选项：非 `direct`
的 MCP 工具只有在 `tool_search` 已注册时才可声明（`agent-session.js:1164-1171`）。

### D2 — 开关：`PI_LEGION_CHILD_MCP`，默认 all

新增纯函数 `childEnablesMcp(env)`，放在 `src/runs/extension-inheritance.ts`（与
`childInheritsExtensions:51-60` 同址，保持一个地方回答「继承什么」），并从 `args.ts` 复用/转出：

```
未设置 / ""        → true（默认 all）
0 / false / off / no / none → false
其它任何值          → true（含 "all"、"1"；不做名字白名单）
```

不做 role card 的 `mcp:` 字段（会牵动 6 处名册：frontmatter 白名单、`applyCapabilityFields`、
`types.ts`、`overrides.ts`、`settings.ts`、`legion-doctor.ts`）。名单过滤留 MR2b。

**默认 all 的已知代价**（实测：5 个并发子会话 × 1 个 server = 18 进程 / 1121 MB）：契约不引入
连接预算，只提供开关。文档必须写清代价。

### D3 — in-process 补 `bindExtensions`（原 MR3）

新增 `src/supervisor/child-session.ts`：

```ts
export interface ChildSessionBinding {
  bindExtensions(bindings: {
    mode?: "print";
    onError?: (error: unknown) => void;
  }): Promise<void>;
}

/** Emit `session_start` exactly once for an in-process child session. */
export async function bindChildSessionExtensions(session: ChildSessionBinding): Promise<void>;
```

bindings 固定为 `{ mode: "print", onError }`，逐条理由：

1. **`mode: "print"`** — runner 默认就是 `"print"`（`runner.js:169`），显式写是意图声明；
   不传 `uiContext` ⇒ `ctx.hasUI === false`，`ctx.ui` 是 `noOpUIContext`（`runner.js:132-164`，
   永远不会是 `undefined`、不会抛错）。MCP 扩展自己有无 UI 降级分支
   （`mcp/index.js:941-944`），不需要我们伪造 UI。
2. **`onError`** — 必须传。`bindExtensions({})` 时 `emitError` 没有 listener，
   扩展异常被**静默吞掉**（`runner.js:497-501`）；print-mode 至少 `console.error`。
   这里用 `console.warn("[pi-legion] in-process child <name> extension error: ...")` 保持可观测。
3. **不传 `commandContextActions` / `shutdownHandler` / `abortHandler`** — in-process 子会话没有
   SessionRuntimeHost 来实现它们，传空实现等于伪造能力；runner 的默认桩已经足够
   （`runner.js:340-353`）。
4. **只调一次** — 无幂等保护，且 MCP 扩展每次 `session_start` 直接覆盖 `AbortController`
   而不 abort 旧的（`mcp/index.js:980`）；重复 bind 会留下悬挂连接。实施点：
   `defaultSessionFactory` 里 `createAgentSession` 之后、`return session` 之前，紧邻一处。

已知缺口（写进 §6）：`defaultSessionFactory` 不导出，这条调用本身无法被机械测试覆盖。

### D4 — legion 自己的 `session_start` 身份守卫

`index.ts:1651-1653` 的 handler 改为：**持有注入身份的 in-process 子会话跳过
`initializeLegionRuntime`**。

```ts
const hasInjectedChildIdentity = Boolean(childContext?.nodeId && childContext.dbPath);
pi.on("session_start", (_event, ctx) => {
  if (!hasInjectedChildIdentity) { /* 原实现 */ }
  /* hygiene 分支不变（它本来就 !isChild） */
});
```

理由（全部有行号）：

1. 正常情况（父是 root）：`process.env` 无 `PI_LEGION_*`，`initializeLegionRuntime` 在
   `resolveLegionIdentity:1074-1077` 返回 `undefined`，只是白跑一次 RunStore + settings。
   跳过它没有行为损失。
2. 危险情况（父本身是 rpc child，env 带祖先 `PI_LEGION_*`）：in-process 子会话共享父 env，
   session_start 会**用祖先身份** init，然后被 `before_agent_start` 的懒挂（`index.ts:1609-1625`）
   翻成本身身份；缓存 miss 时还会开祖先 db、起第二个 postman
   （`createLegionRuntime:986-987`），而 **`session_shutdown` 在 in-process 子会话里也不会触发**
   （只有 `AgentSessionRuntime` 发它，`InProcessSupervisor` 直接 `session.dispose()`），
   于是没有回收点。
3. 子会话的真实身份通道是 `childContext`（ALS），不是 env
   （`index.ts:1402-1410` 的「healthy ghost nodes」注释明确禁止用 env 注入替代）。

同时必须修掉两处**已经失真**的陈述：

- `index.ts:1599-1605` 的注释「an in-process child never sees `session_start` … the handler
  further down is dead for this transport」
- `docs/inprocess-supervisor.md:183-190` 同义段

### D5 — 只读角色：不设 MCP 防火墙

已裁决：真实 server 的 `annotations` 实测全是 `null`（`web_search` / `web_fetch` /
`search_status` / `search_login`），按 `readOnlyHint` 做的白名单会连 `web_search` 都拦掉，
而按 `destructiveHint` 做的黑名单对未声明 server 是 no-op。因此**不做 annotation 级控制**。

后果必须**显式披露**：`acceptance.role: read-only` 的 scout 从此可以调用 MCP server 暴露的
写能力（bash 的只读分类不受影响，`child-guard.ts:392` 只拦 bash）。写进 CHANGELOG 与 README，
不要留「只读」的名实不符。

### D6 — 明确不做

- 不做连接预算 / 并发上限（留 MR2b）：只给 `PI_LEGION_CHILD_MCP=0` 掩码开关。
- 不做 role card `mcp:` 名单。
- 不改 `exposure`（默认 `codemode` ⇒ 映射 deferred，不进工具列表，只在 system prompt 的
  `mcp_servers` 段出现，整段上限 4096 字符）。
- 不改只读分类、不改 `toolBudget`、不改 `noExtensions`。
- 不碰 worktree 的项目级 `.pi/mcp.json` 信任问题（已知：worktree cwd 未信任 ⇒ 项目级配置不加载；
  用户级 `~/.pi/agent/mcp.json` 正常）。

---

## 3. 文件所有权

| 文件 | 允许的改动 |
|---|---|
| `src/runs/extension-inheritance.ts` | 新增 `childEnablesMcp(env)` |
| `src/runs/args.ts` | builtin 注入两条路径 + 转出 `childEnablesMcp` |
| `src/supervisor/child-session.ts` | 新建：`bindChildSessionExtensions` |
| `src/supervisor/inprocess-supervisor.ts` | 调用 `bindChildSessionExtensions`（一次） |
| `src/supervisor/child-builtins.ts` | 仅注释（MCP 现已启用） |
| `index.ts` | D4 守卫 + 注释修正（**只许改这两处**） |
| `test/unit/child-session.test.ts` | 新建：D7.3、D7.4 |
| `test/unit/args.test.ts` | D7.1、D7.2 |
| `test/unit/inprocess-supervisor.test.ts` | 只更新受影响的断言 |
| `test/unit/extension-inheritance.test.ts` | 仅 A13 的「每个条目必须是真实文件」探针跳过 `builtin:` ref（r1） |
| `test/integration/child-loader-builtins.test.ts` | 更新 MR1 的「mcp 不得加载」断言 |
| `docs/contracts/child-mcp-v1.md` | 本文件 |
| `docs/contracts/child-builtin-extensions-v1.md` | 仅在 §6 加一条 superseded 说明 |
| `docs/inprocess-supervisor.md` | `:183-190`、`:213` |
| `README.md` | `:485-505` knob 表 + 代价段落 |
| `CHANGELOG.md` | `[Unreleased]` → `### Added` |

越界即拒收：role cards、`src/extension/**`（除 child-guard 的只读分类，本次不动）、
`src/agents/**`、`src/legion/**`、其它测试。

---

## 4. 验收

机械门禁（父会话 verify，失败即拒）：

```
npm run typecheck
npm test
npm run test:integration
```

行为验收（父会话执行，不要求 worker 跑）：真实 in-process 子会话出现 `mcp__*` 工具；
`PI_LEGION_CHILD_MCP=0` 时一个都没有。

### D7 — 回归门禁

1. `childEnablesMcp` 表驱动测试：未设置 / `""` / `all` / `1` → true；`0`/`false`/`off`/`no`/`none`（含大小写与空白）→ false。
2. `collectChildExtensions` 默认含 `builtin:mcp` + `builtin:tool-search`（顺序固定、各一条）；`PI_LEGION_CHILD_MCP=0` 时两条都不出现；与 in-process plan 的 parity 由既有 D6.2 覆盖。
3. `bindChildSessionExtensions`：对 fake session 只调用一次，bindings 恰为 `{ mode: "print", onError: fn }`，且 `onError` 被调用时走 `console.warn`（用 stub 断言）。
4. **变异可红**：删掉 `onError` 或把 `mode` 改成 `"tui"` → D7.3 红；删掉注入路径 → D7.2 红。
   实施完自行验证一次并贴结果。

---

## 5. 实施顺序（同一个 worker，按序提交）

1. **D1 + D2 + D7.1/7.2**（纯路径与开关，零运行时风险）
2. **D3 + D7.3/7.4**（bind 一次；这一提交是唯一有运行时风险的一步）
3. **D4**（守卫）+ 文档 + CHANGELOG

每一步都跑完三条门禁再进下一步；第 2 步若出现无法解释的测试变化，停下报障，不要顺手改测试。

---

## 6. 已知缺口（不掩盖）

1. `defaultSessionFactory` 不导出 ⇒ 「是否调用 `bindChildSessionExtensions`」这一行无机械覆盖。
   缓解：删掉后 MCP 会静默不连（表现为子会话没有 `mcp__*` 工具），行为验收能抓到。
2. 真实 server 的连接延迟与进程成本只在父会话手动实测，不进 CI（会拉起真实 `npx`）。
3. 未验证：in-process 子会话里 MCP 的 `ctx.isProjectTrusted()` 返回值与 cwd 的关系
   （项目级 `.pi/mcp.json` 是否加载）；用户级配置不受影响。

---

## 7. 修订记录

### r1（D1 实施后）— 文件所有权扩容一处

**原因**：D1 让 `collectChildExtensions` 的返回值里第一次出现非路径条目（`builtin:mcp` /
`builtin:tool-search`），而 `test/unit/extension-inheritance.test.ts` 的 A13 断言「这个列表里的
每一条都必须是磁盘上的真实文件」（`statSync(entry).isFile()`）。它在 MR1 时代是对的：那时列表里
只有继承路径、卡片路径、额外路径与 child-guard。D1 之后它与「`npm test` 全绿」互斥。

**修订**：授权该文件**仅**在 A13 的探针里跳过 `builtin:` ref（`isBuiltinExtensionRef`），
其余断言逐字不动。这**不改语义**：A13 的缺陷是「目录被当成 `--extension` 传下去」，而
`builtin:<name>` 是 loader 解析的名字、不是路径，本就不该走 `statSync`。判据与
`child-builtin-extensions-v1.md` §6 r1 相同——只改字面量/探针形状，不放宽被守的性质。
