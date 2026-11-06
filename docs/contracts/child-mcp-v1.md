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

### r1 — 实施中的两处偏离（worker 记录，root 追认）

1. `test/unit/extension-inheritance.test.ts` 不在 §3 清单内。D1 让 `collectChildExtensions`
   第一次产出非磁盘路径条目，该测试现有的「每条都必须是真实文件」探针必红，与
   「`npm test` 全绿」互斥。改动是**语义不变**的：探针跳过 `builtin:` ref（它原本防的是
   目录被当 `--extension`）。授权。
2. `bindChildSessionExtensions(session, name?)` 多了一个可选 `name` 参数（warn 文案要带子节点名）。
   冻结的一参数调用形状与 bindings 形状不变，取超集。授权。

### r2 — bind 必须挂在 MCP 开关上（root 追加）

**问题**：`bindExtensions` 会让 **所有** 已加载扩展收到 `session_start` —— 不只是 MCP，还包括
`inheritExtensions: true` 继承来的宿主扩展。核对了本机继承的四个宿主包：

| 包 | `session_start` 行为 | 子会话里安全？ |
|---|---|---|
| `pi-sysmon` | `if (!ctx.hasUI) return;` 在启用逻辑之前（`src/index.ts:1229`） | 是（无 UI 直接退出，不起 1Hz 采样） |
| `pi-async` | `bindTuiHost` 要求 `ctx.mode === "tui"`（`src/tui/host.ts:17`） | 是（子会话 mode 是 `"print"`） |
| `pi-any-endpoint` / `pi-diff-review` | 无 `session_start` handler | 是 |

它们都做了降级保护，但这是**别人的实现**，不是我们的不变量。任何第三方扩展都可能在
`session_start` 里起定时器/子进程，而 in-process 子会话**没有 `session_shutdown` 可回收**
（`AgentSessionRuntime` 才发它，`InProcessSupervisor` 只 `session.dispose()`）。

**决定**：`defaultSessionFactory` 里那次 bind 改为条件执行：

```ts
if (childEnablesMcp(process.env)) await bindChildSessionExtensions(session, input.name);
```

于是 `PI_LEGION_CHILD_MCP=0` 的语义收紧为「**完全回到 MR2 之前**」——没有 `builtin:mcp` 路径，
也没有 `session_start`，宿主扩展在子会话里的可见行为一字不变。这一条同时是回滚手段。

**代价**：`childEnablesMcp` 因此在 `inprocess-supervisor.ts` 里被再读一次（与 `args.ts` 的路径注入
各读一次）。接受：两次读取的是同一个 `process.env`，且 in-process 子会话共享父 env
（`docs/inprocess-supervisor.md:162-166`），不存在两侧不一致的窗口。

**测试**：D7.3 仍覆盖被调函数本身；新增一条单测断言 `childEnablesMcp` 与
「是否应 bind」是同一个判据（表驱动复用 D7.1 的用例集即可），避免两处判据分叉。

### r3 — review 后的必修项（root 追加，阻塞合并）

fresh-context review 给出 `ok: false`，1 critical + 2 major。以下全部纳入本 MR。

#### C1（critical）— MCP 连接永不回收

**事实**：MCP 唯一的断开路径是 `pi.on("session_shutdown", …)`（`dist/extensions/mcp/index.js:1114-1119`
：`session.abort()` + `connection.close()`）。`AgentSession.dispose()` **不 emit** 它
（`agent-session.js:1024-1043` 只 `invalidate` + `_disconnectFromAgent`）；能 emit 它的只有
`AgentSessionRuntime.dispose()`（`agent-session-runtime.js:298`）。而 in-process 子会话退休只走
`session.dispose()`（`inprocess-supervisor.ts` 的 1555 / 1749 / 1763）。
⇒ 每个退役子会话的 MCP server 进程与连接活到 root 进程退出，8 slot 轮转下单调增长。

**决定**：显式补一次 `session_shutdown`，且必须在 `dispose()` 之前。

SDK 提供公开出口（不需要私有字段）：

- `AgentSession.extensionRunner` 是 public getter（`agent-session.d.ts:937`）；
- `ExtensionRunner.hasHandlers(event)` 与 `emit(event)` 是 public（`runner.d.ts:181`）；
- 官方实现就是这两句（`runner.js:80-86` 的 `emitSessionShutdownEvent`），我们照抄同一逻辑，
  **不要**深引 `dist/core/extensions/runner.js`（exports map 只暴露 `.` 与 `./rpc-entry`）。

`src/supervisor/child-session.ts` 新增：

```ts
/** Emit `session_shutdown` once for a bound in-process child session (r3 C1). */
export async function releaseChildSessionExtensions(session: ChildSessionBinding): Promise<void>;
```

`ChildSessionBinding` 相应扩展为带 `extensionRunner?: { hasHandlers(event: string): boolean;
emit(event: { type: "session_shutdown"; reason: "quit" }): Promise<unknown> }`（结构化类型，
测试仍然不需要 SDK）。

`defaultSessionFactory` 里把 `dispose` 包一层（**幂等**）：

```ts
const rawDispose = session.dispose.bind(session);
let disposing = false;
session.dispose = () => {
  if (disposing) return;
  disposing = true;
  // Emitting first runs the shutdown handlers' synchronous prefix (MCP aborts its
  // controller and starts closing every connection) before `dispose()` invalidates
  // the extension ctx. Bounded so a wedged handler cannot keep the session alive.
  void releaseChildSessionExtensions(session).finally(() => rawDispose());
};
```

约定：

1. 只在**成功 bind 过**的会话上补发（`child-mcp-v1` 里 bind 已被 `childEnablesMcp` 门控；
   MCP 关闭时不应无故给宿主扩展发 `session_shutdown`）。用一个模块级 `WeakSet` 记录已 bind 的
   session，`release…` 对它做 once。
2. `release…` 内部对 `emit` 做 try/catch + 1000ms 上限，**无论成功失败都必须让 `rawDispose` 跑到**。
3. 不传 `reason: "quit"` 以外任何值（in-process 子会话不存在 reload/new/resume/fork）。

**测试（D7.5）**：fake session 断言 —— ①`dispose()` 触发 `session_shutdown` 恰一次且
`reason === "quit"`；②`session_shutdown` 在 `dispose` 之前（用调用顺序数组）；
③emit 抛错时 `dispose` 仍然被调用；④连续两次 `dispose()` 只发一次事件；
⑤未 bind 的 session 不发事件。

#### M2（major）— boot-time attach 的同一个洞

`index.ts:1594-1598` 在 env 带祖先 `PI_LEGION_DB/NODE_ID` 时仍会
`initializeLegionRuntime({cwd})`，且**不传 sessionFile ⇒ credential 校验被跳过**
（`resolveLegionIdentity:1027-1032` 要求 `mySession` 非空）⇒ 开祖先 db + 起 postman，同样无回收点。

**决定**：与 D4 用同一个谓词，boot attach 也跳过：

```ts
if (!hasInjectedChildContext && process.env[LEGION_DB_ENV] && process.env[LEGION_NODE_ID_ENV]) { … }
```

#### M3（major）— 守卫谓词比危害窄

`stripLegionIdentity: true` 的子会话（vexillatio）由 `orchestrator.ts:1354-1356` 省略 nodeId 但保留
dbPath，`Boolean(childContext?.nodeId && dbPath)` 因此失效，`session_start` 仍会走 env init。

**决定**：谓词改为 **`childContext !== undefined`**（任何 in-process 子会话都不在 `session_start`
里从 env 推导身份；它的身份通道是 ALS，没有就是没有）。这也覆盖 boot attach（M2）。
命名：`hasInjectedChildContext`。

#### Minor（一并修）

- `test/unit/child-session.test.ts` 的源码钉子：改为按 `bindChildSessionExtensions(` 出现次数计数
  （不再钉整行格式与 `input.name`），并在注释里声明「格式 tripwire，不是行为断言」；测试名去掉
  「exactly one bind」里的行为承诺。
- 同名测试里「不留下半启动 session」改成准确表述（`bindExtensions` 极少 reject；此测试钉的是
  「向上抛，不吞」）。
- `index.ts:1595-1596` 的「the session_start handler re-runs this with the real credential」在新守卫下
  对持注入身份的子会话不再成立 → 改掉。
- CHANGELOG 的「扩展列表固定注入 codemode → mcp → tool-search」→ 说明 `codemode` 仍只在角色
  `tools` 含 `codemode` 时注入，后两条才是无条件。

#### 复核要求

修完重新跑一次 fresh-context review（同一份契约，范围 `master...feat/child-mcp-v1`），
**C1 未修则不得合并**。
