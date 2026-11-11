# 子 agent 浮窗 ↔ 主 TUI 渲染对齐契约 v1（viewer transcript parity）

> 状态：**生效**，冻结于本次改动。多 worker 并行改同一 checkout，本文件是唯一接口。
> 冲突时**停下上报父会话**，不得自行重新解释本契约。
> 关联：#261（浮窗）、D10（detail-stream 只在浮窗打开时订阅）、
> `docs/tui-viewer-contract.md` REV-4（finalize-then-disk 双渲染事故）、
> `docs/contracts/legion-main-screen-mount-v1.md`（`/legion` 主屏挂载，不得改回 overlay）。

---

## §1 问题陈述（侦察结论，已确认，禁止重新侦察）

浮窗（`openLiveOverlay`）已经是复用宿主组件的渲染器，但四件事让它与主 TUI 不一致：

1. **工具耗时永远不显示**：`src/tui/chat-items.ts:116` 把 `ToolExecutionComponent` 的第 5 参
   （`toolDefinition`）传成 `undefined` → 宿主走 `createCallFallback/createResultFallback`，
   fallback 不读 `getRenderContext().durationMs` 与 `toolTimerText()`
   （`pi-coding-agent/dist/modes/interactive/components/tool-execution.js:93`、
   `dist/core/tools/render-utils.js:121-140`）。
   而 `durationMs` **数据本来就在**：`toolResult` 消息自带（实测 27348/27443 条），
   `chat-items.ts:201-215` 也已经把它塞进 `updateResult` —— 只差渲染器。
2. **工具没有执行态**：`markExecutionStarted()` / `setArgsComplete()` 从未调用
   （对照宿主 `interactive-mode.js:3037` / `:3008`），`isPartial` 恒 true，没有 `Elapsed` 跳秒。
3. **thinking 不流式**：thinking 整块只在 `message_end` 落盘（宿主
   `docs/message-types.md:141-143`，实测 0 条 `*_delta` entry）。
   而宿主的 `thinking_delta` 事件其实一直发得出来（`pi-agent-core/dist/agent-loop.js:297-310`），
   是**本仓库**把它丢了：`src/supervisor/inprocess-supervisor.ts:1923`
   `if (!isTextDelta && !toolName) return;`，并被 `test/unit/supervisor.test.ts:1744-1754` 钉死。
4. **工具参数不流式**：`toolcall_delta`/`tool_execution_update` 同样被上面那行丢掉。

另有一处入口缺口：viz 页（`/legion` 默认页）没有 `handleMouse`，只能 `o`/Enter 打开浮窗；
经典树与状态条可以点击（`legion-commands.ts:800-806`）。

---

## §2 决策（D）

**D1 — 工具渲染器来源。** 新增 `src/tui/tool-renderers.ts`，导出
`createToolRendererLookup(cwd: string): (toolName: string) => ToolRenderers | undefined`。
惰性构造、进程内缓存一份 `Map<name, ToolRenderers>`，成员来自宿主**公开导出**的
`createReadToolDefinition / createBashToolDefinition / createEditToolDefinition /
createWriteToolDefinition / createGrepToolDefinition / createFindToolDefinition /
createLsToolDefinition`（win32 另加 `createPowerShellToolDefinition`）。定义对象本身满足
`ToolRenderers`（`Pick<AnyToolDefinition, "renderShell" | "renderCall" | "renderResult">`，
宿主 `dist/core/extensions/types.d.ts:541`），直接当第 5 参传。
**未知名工具返回 `undefined`** → 保持今天的 fallback JSON 渲染。
禁止 import 宿主深路径（`exports` map 封死；扩展 loader 只把 `@earendil-works/pi-tui` /
`@earendil-works/pi-coding-agent` 别名到宿主 `dist/index.js`）；
禁止使用 `createAllToolRenderers`（未从 `dist/index.d.ts` 导出）。

**D2 — 组件驱动顺序（历史重放与实时一致）：**
创建 `ToolExecutionComponent` → `setExpanded(false)` → `markExecutionStarted()` →
`setArgsComplete()` → 有 result 时 `updateResult({ content, details, isError, durationMs })`。
宿主 `toolTimerText()` 对 final 结果**优先用 `context.durationMs`**（`render-utils.js:130-134`），
所以历史消息重放显示的是真实耗时（`Took 4.2s`），不是「自打开浮窗起算」。
in-flight 工具（result 未到）显示 `Elapsed Xs` 并每秒自增（宿主 interval 在 final 时自清）。
计时文案属于宿主 renderer 的实现细节：测试只断言 `Took` + 数值，不写死格式。

**D3 — 关闭时释放计时器。** `ChatItemFactory` 新增 `releaseToolTimers(): void`：
对每个「已 `markExecutionStarted` 且尚未 final」的工具补一次终态
`updateResult({ content: [], isError: false, durationMs: 0 })`（只为触发宿主
`clearInterval`，组件随即被丢弃；不参与渲染断言）。浮窗 `dispose`/`close` 时必须调用，
避免每次关闭浮窗漏一个 1s interval。

**D4 — thinking 增量。** supervisor 放行 `thinking_delta`（与 `text_delta` 同一个 opt-in 门），
process bus 新增事件 `thinking_delta`，`data: { delta: string }`。
`ChatItemFactory` 新增 `appendStreamingThinking(delta: string, model?: string): AssistantMessageComponent`：
把 thinking 累加进**同一个** streaming assistant 组件，内容顺序 = `[thinking, ..., text]`。

**D5 — thinking/text 去重（REV-4 的扩展）。** 落盘 assistant 消息到达时：
若其 text 覆盖流式 text **且**其 thinking 覆盖流式 thinking ⇒ 整条 streaming item 整体撤回
（`retractStreamingItem`）；否则只有未覆盖的尾部继续留在 streaming item。
`ChatItemFactory` 新增 `streamingParts(): { text: string; thinking: string }` 供浮窗比较。
**不允许**出现同一段思考渲染两次。

**D6 — 工具参数流。** supervisor 对 `toolcall_start / toolcall_delta / toolcall_end` 的
detailed 事件带 `toolCallId`（`assistantMessageEvent.partial.id`）与 `args`
（`assistantMessageEvent.partial.arguments`，非对象则不转成字符串以外的形状）；
process bus 新增事件 `tool_delta`，`data: { toolCallId: string, toolName?: string, args: unknown }`。
`ChatItemFactory` 新增 `updateToolArgs(toolCallId: string, args: unknown): void`（未知 id 静默 no-op）。

**D7 — `includeTextDelta` 语义扩展。** 该 opt-in 现在同时放行 `text_delta` 与 `thinking_delta`
（并新增等价别名 `includeDetail?: boolean`；两处调用点不改名）。
`textDeltaOnly` 选项的语义扩为「只放行流式 detail（text/thinking/tool args）」，coarse 事件仍被排除。
`test/unit/supervisor.test.ts:1744-1754` 必须改写为「`thinking_delta` 在 detailed 订阅下**会**到达；
在未 opt-in 的订阅下**不会**」——这是**有意的契约变更**，不是回归。

**D8 — 运行中工具的边界事件。** coarse `tool_execution_start / tool_execution_end`
经 `publishSupervisorEvent` 转发时补上 `toolCallId`（`COARSE_EVENT_TYPES` 的白名单里已有该键，
`inprocess-supervisor.ts:1940`）。浮窗用 `toolCallId` 调 `markToolStarted` / 终态兜底。

**D9 — usage/timestamp 对齐。** assistant / user 组件补宿主的 `messageId`、`timestamp`
两参（宿主 `assistant-message.d.ts:31`、`user-message.d.ts:22`）：从 session entry 的
`id`/`timestamp` 取（`chat-items.ts` 的 `parseSessionMessages` 现在只返回 message，
需要并行返回 entry 元数据；**不得**改变 `parseSessionMessages` 既有导出签名，
新增 `parseSessionMessagesWithMeta` 或等价物）。
流式消息的 `usage` 仍用零值（宿主流式期同样没有 usage）。

**D10 — 活动日志不动。** 浮窗里的 `⚙ name` / `✓ name` 活动行是 state/test 视图契约，
与结构化工具块并存，不做去重，不改 `docs/tui-viewer-contract.md` 的既有断言。

**D11 — viz 页鼠标。** `createLegionViewFactory` 返回的组件新增 `handleMouse(event)`：
命中 galaxy 的节点格、或 status/timing/log 的某一行 ⇒ `options.onOpenNode(nodeId)`；
未命中返回 `undefined`（宿主继续分发）。不新增依赖、不改挂载方式。

**D12 — 不改宿主包。** 本契约的全部改动落在本仓库。宿主的
`ToolRenderers` 缺口（如未知工具的 fallback 不显示耗时）**不修**。

---

## §3 wire 契约（supervisor → bus → 浮窗）

`src/extension/event-bus.ts` 的 `LEGION_PROCESS_EVENT_TYPES` 末尾追加（顺序即契约）：

```
"thinking_delta",   // detail; data: { delta: string }
"tool_delta",       // detail; data: { toolCallId, toolName?, args? }
```

既有事件字段扩展（不新增事件类型）：

| 事件 | 现状 | v1 追加 |
|---|---|---|
| `text_delta` | `{ delta }` | 不变 |
| `tool_call` | `{ toolName, phase? }` | `toolCallId?` |
| `thinking_delta` | — | `{ delta }` |
| `tool_delta` | — | `{ toolCallId, toolName?, args }` |

`LEGION_EVENT_TYPES` 由既有 `new Set([...])` 自动覆盖，无需手写。

**不新增 DB 事件类型**（`src/legion/events.ts` 闭集不动，理由见 #233：加一条会冻结事件游标）。

---

## §4 ChatItemFactory 契约（W1 提供，W3 消费）

只**新增**，不改变既有方法签名/返回类型：

```ts
export interface ChatItemFactory {
  // ...既有一切保持不变...
  /** D4：把 thinking 增量累加进当前流式 assistant（不存在则创建）。 */
  appendStreamingThinking(delta: string, model?: string): AssistantMessageComponent;
  /** D5：当前流式累积快照，不终结。 */
  streamingParts(): { text: string; thinking: string };
  /** D6：实时工具参数；未知 toolCallId 静默 no-op。 */
  updateToolArgs(toolCallId: string, args: unknown): void;
  /** D8：工具开始执行（宿主 Elapsed 计时起点 + 壳态）。重复调用幂等。 */
  markToolStarted(toolCallId: string): void;
  /** D3：关闭浮窗前释放宿主计时器。 */
  releaseToolTimers(): void;
}
```

`ChatItemFactoryOptions` 追加 `rendererLookup?: (toolName: string) => ToolRenderers | undefined`；
未提供时回落到内部默认 lookup（`createToolRendererLookup(cwd)`）。

---

## §5 文件归属（越界即冲突，禁止）

| Worker | 拥有文件 |
|---|---|
| W1 chat-items | `src/tui/chat-items.ts`、`src/tui/tool-renderers.ts`（新）、`test/unit/chat-items-tool-renderers.test.ts`（新） |
| W2 bridge | `src/supervisor/inprocess-supervisor.ts`、`src/supervisor/rpc-supervisor.ts`、`src/extension/event-bus.ts`、`src/extension/legion-commands.ts`、`test/unit/supervisor.test.ts` |
| W3 overlay | `src/tui/live-overlay.ts`、`test/unit/legion-live-overlay.test.ts`、`test/unit/legion-live-overlay-refresh.test.ts` |
| W4 viz | `src/tui/viz/view.ts`、`src/tui/viz/panels.ts`（仅当命中测试需要）、`test/unit/legion-viz.test.ts`、`test/unit/legion-viz-scratch.test.ts` |

`docs/contracts/` 下本文件由父会话独占，worker 只读。
`src/shared/session.ts`、`src/tui/session-messages-file.ts`、`src/tui/tree-view.ts`、`src/tui/status.ts`
**不在本次范围**：它们已经透传原始 message（含 `durationMs`/`thinking`），不要动。

---

## §6 verify 门禁（父会话定死，不得自选）

- W1：`node --experimental-strip-types --test test/unit/chat-items-tool-renderers.test.ts test/unit/legion-live-overlay.test.ts test/unit/legion-live-overlay-refresh.test.ts`
- W2：`node --experimental-strip-types --test test/unit/supervisor.test.ts test/unit/inprocess-supervisor.test.ts`
- W3：`node --experimental-strip-types --test test/unit/legion-live-overlay.test.ts test/unit/legion-live-overlay-refresh.test.ts test/unit/supervisor.test.ts`
- W4：`node --experimental-strip-types --test test/unit/legion-viz.test.ts test/unit/legion-viz-scratch.test.ts`

仓库级 `node --run typecheck` 与全量单测由父会话在合并阶段跑（并行 worker 共用 checkout，
repo 级门禁会互相误判）。

---

## §7 刻意不做

1. 不改宿主包；不 import 宿主深路径。
2. 不把会话正文写进 `legion.db`（D-R8.2：`nodes` 没有 thinking 列，保持不升级 schema）。
3. 不给浮窗加 `tool_execution_update`（工具内部的 partial output 流），v1 只到「参数流」。
4. 不改 `/legion` 主屏挂载方式（`legion-main-screen-mount-v1.md` R1）。
5. 不做 thinking 折叠状态在浮窗内的记忆（沿用 settings 的 `hideThinkingBlock`）。
6. 不改 activity 日志行、不改 `docs/tui-viewer-contract.md` 的既有断言。

---

## §8 风险

- **R1 双渲染**：thinking 引入第二个双源（流式 vs 落盘）。守卫写在 D5，必须测「同一段思考不出现两次」。
- **R2 计时文案属于宿主实现细节**：`Took`/`Elapsed` 的字面量若随宿主升级变化，测试应只断言
  「final 结果块含一个 `\d+(\.\d+)?s` 且出现在 `Took` 之后」这类宽容形态。
- **R3 interval 泄漏**：只有 in-flight 工具会起 1s interval，靠 D3 关闭时释放。
- **R4 浮窗宽度**：内置 renderer 在窄宽度下换行行为与宿主一致（同一份代码），但浮窗有
  `TOOL_COLLAPSED_PREVIEW_LINES = 10` 截断（`live-overlay.ts:159`），**必须保留**。

---

## §9 review 修订 v1.1（对抗式评审后裁决，**覆盖前文冲突条款**）

评审结论：`ok: false`（2 major + 若干 minor，变异测试证据）。以下 D13–D20 为最终事实，
与 §2/§8 冲突时**以本节为准**。

**D13 — galaxy 必须可点（修订 D11）。** `paintGalaxy` 每帧已经算出每个节点的屏幕位置与半径
（`src/tui/viz/panels.ts` 的 `g.pos / posX / posY / g.radii`），因此命中 = 「点击格到节点中心距离
在半径容差内取最近者」。`CLICKABLE_PANES` 必须包含 `galaxy`；不得为了省事把 galaxy 排除。

**D14 — detail 字段解析必须单点实现。** `DETAIL_UPDATE_TYPES`、`toolCallOf`、`detailFieldsOf`
（以及 thinking 回落的取舍）在 `inprocess-supervisor.ts` 与 `rpc-supervisor.ts` 里各写一份是
**105 行必须永远一致的 wire 语义**，禁止。抽到新文件 `src/supervisor/detail-fields.ts`，两个后端
import。既有 `COARSE_EVENT_TYPES` 那类 3 行常量重复不在此列。

**D15 — `thinking_delta` 无 `delta` 时不发事件（修订 D6 的回落）。** 宿主
`AssistantMessageEvent.thinking_delta` 恒带 `delta`；用「partial 的最后一块 thinking」兜底会让
浮窗把**整块**推理当 delta 追加，与 D5 的覆盖率判定彻底失配。删除该回落，并把
`test/unit/supervisor.test.ts` 里钉住回落行为的断言改为「无 delta ⇒ 无事件」。宁可某方言不流式
（思考最终仍会随 `message_end` 落盘显示），也不允许重复渲染。

**D16 — 历史重放不得伪造耗时（修订 D2）。** 只在**执行真的开始**（D8 live 路径）时
`markExecutionStarted()`；`addToolCall`（落盘重放）只调 `setExpanded(false)` + `setArgsComplete()`。
原因：宿主 `toolTimerText()` 的 `Took` 回落用 `endedAt - startedAt`，重放时 `startedAt` = 打开浮窗
的时刻，会给「没有 `durationMs` 的历史结果」印出假的 `Took 0.0s`。带 `durationMs` 的结果走
`context.durationMs` 分支，**不需要** `startedAt`，所以 D2 的目标（`Took 4.2s`）不受影响。

**D17 — 「运行中跳秒 Elapsed」与 R3 计时器泄漏在 v1 不可达，记录为已知事实。** 宿主的 1s tick
只在 `renderResult` 内、且 `isPartial === true` 时创建；`isPartial` 只有 `updateResult(x, true)`
（即 `tool_execution_update`）能置真，而 §7.3 明确不给浮窗接该事件。因此：
`markToolStarted` / `releaseToolTimers` 是**为 v2 预留的防御接线**，v1 实际不触发，不得为其写
「依赖渲染」的断言，也不得在文档/交付说明里宣称浮窗有跳秒计时。

**D18 — 每个 chunk 的 detail 事件不得触发树快照（修订 D7 的覆盖面）。** 除浮窗自身
（`legion-commands.ts` 的 `detailEventTypes`）外，**状态板**（`src/extension/runtime.ts` 的
`LEGION_EVENT_TYPES.filter(...)`）与**经典树视图**（`legion-commands.ts` 的 tree 订阅）也必须把
`text_delta / thinking_delta / tool_delta` 一并排除，否则 #261 修掉的「每 token 一次同步 SQLite
子树扫描 + 一次 widget 重绘」会原样复发。三处共用一个判定，禁止各写一份 `!== "text_delta"`。

**D19 — `publishSupervisorEvent` 的 legacy 方言不得被吞（修订 D6 接线）。** `toolcall_*` 事件缺
`toolCallId` 时，必须**落回**改动前的扁平 `tool_call` 发射，而不是 `return` 丢弃。`publishSupervisorEvent`
是导出函数，语义收窄必须有测试钉住。

**D20 — R4 截断必须有正向断言。** 改写后的 5 条断言不得让
`TOOL_COLLAPSED_PREVIEW_LINES = 10` 失去守护：新增一条用**无内置渲染器**的工具名
（如 `legion_output`）+ >10 行输出，折叠态断言 `/\d+ more lines/`。现有 fixture 用的是 `read`
（折叠态只剩 call 行），走不到截断路径。

**§5 归属追认：** `src/supervisor/types.ts`（`EventSubscriptionOptions.includeDetail`）与
`test/unit/teams.test.ts`（A13 的 11→13 闭集钉死）是**父会话亲自**改的协调点，不属于任何 worker
越界；`src/extension/runtime.ts` 由 W2 按 D18 补改。`src/tui/chat-items.ts`、`src/tui/tool-renderers.ts`
在 W1 收工后由父会话直接修订（D16）。dead export（`timingVisibleRows`/`logVisibleRows`）、
冗余的 `DetailSubscriptionOptions` 别名一并清理。

**D21 — text 半同样要用未裁剪累积（终审 finding）。** 终审复审用探针证实：`finalizedAssistantText`
若取 `clampStreamingText` 的镜像（>120 行时是后缀），落盘消息永远无法被 `includes()` 覆盖，最后
120 行会画两次——与 D5 修 thinking 的是同一个缺陷类。因此 `live-overlay.ts` 保留一份未裁剪的
`streamedTextFull`（上限 `MAX_FULL_STREAM_CHARS = 1e6`），`finishStreaming()` 与 retract 路径的
覆盖率判定都用它；`streamingText` 仍只是显示镜像。守卫：
`test/unit/legion-live-overlay.test.ts` 的「settled text longer than the display clamp is not painted twice」
（已做先红后绿验证）。
