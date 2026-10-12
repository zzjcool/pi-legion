# pi-legion 3.0 冻结契约：TUI-first 上下文查看器（渲染对齐主上下文 + pi 1.x 升级）

> 状态：**FROZEN**（2026-10-13 冻结；修订必须走 §10 流程）
> 依据：`r-e2d7e116` 三路 scout 侦察（pi 1.1.0 渲染面 / pi-legion 数据流 / session 官方 API），110+ 带行号事实；关键 API 签名由主会话实测冻结于 §2a。
> 背景：Pi CLI 1.0.0+ 以 TUI 为默认运行模式。本次决策：pi-legion 查看器**只支持 TUI 模式**，宿主依赖升到 **pi 1.x**，查看器渲染复用 pi 主上下文的消息组件。

---

## 1. 目标与非目标

### 目标

1. `/legion` 树视图点开 agent（或 `/legion <name>`）打开的实时浮窗，从「纯文本 activity 行」升级为**渲染真实会话消息**，视觉与 pi 主上下文一致（用户消息块、assistant markdown、工具调用块、thinking、颜色主题）。
2. 渲染组件与主题直接复用 pi 主程序公开导出：`UserMessageComponent` / `AssistantMessageComponent` / `ToolExecutionComponent` / `getMarkdownTheme()`（pi `dist/index.js:41-44`，注释原文 "UI components for extensions"——官方公开 API，非私有依赖）。
3. 行为配置复用主配置：`pi.getSettings()` 读 `outputPad` / `hideThinkingBlock` / `codeBlockIndent` / `showImages` / `imageWidthCells`；主题经 `globalThis[Symbol.for("@earendil-works/pi-coding-agent:theme")]` 单例自动与宿主一致（扩展虚拟模块与宿主同实例，scout 实测确认）。
4. 查看器数据源改用 pi 官方 session API：`parseSessionEntries` + `sessionEntryToContextMessages`（均导出于 pi 主入口）；turn 计数与验收判定链仍走 `src/shared/session.ts`（见 §7 明确不做）。
5. 快捷键对齐 pi 的 TUI 惯例（`app.tools.expand`=ctrl+o / pgup/pgdn / esc / j/k），`app.*` 键位经 `KeybindingsManager.matches(data, id)` 判定，尊重用户自定义键位。
6. 依赖升级：devDeps `@earendil-works/{pi-coding-agent,pi-tui,pi-agent-core}` `^0.85.1` → `^1.0.0`；补上直接 import 所需的 `@earendil-works/pi-ai` devDep（`AgentMessage` 等类型来自该包）。

### 非目标

- 不改 RPC supervisor / orchestrator / child 启动链的**运行时行为**（RPC 数据通道维持现状；仅允许 §7 定义的机械 type-compat 修复）。
- 不改 `src/shared/session.ts` 的 TurnRecord 判定链（Orchestrator/acceptance/usage 依赖）。
- 不做「历史全局搜索 / 会话导出 / 复制消息」等浮窗不需要的能力。
- 不动 legacy herdr 归档代码（`src/backends/legacy/`）。
- 不新增 DB schema 字段（nodes 表结构不变）。

---

## 2. 决策记录（ADR）

| # | 决策 | 理由 |
|---|---|---|
| T1 | 查看器只支持 TUI 模式（`ctx.mode === "tui"` guard） | pi 1.0+ TUI 为默认模式；RPC/json/print 模式下 `ctx.ui.custom()` 返回 undefined，现有 `!ctx.hasUI` guard 在 RPC 下会漏（pi docs `rpc-extension-ui.md` Limitations：RPC 下 `hasUI` 为 true 但 `custom()` 返回 undefined）。非 TUI 模式退化行为：提示一次 warning。 |
| T2 | 渲染组件直接 import pi-coding-agent 导出 | 官方为扩展准备的公开 API；`notice-renderer.ts:18` 已有先例（import `MessageRenderer`/`Theme`）。 |
| T3 | 主题经 `getMarkdownTheme()` 获取；禁止在扩展运行期代码调 `initTheme()` | 宿主已初始化全局单例；扩展调用会覆盖宿主状态。单元测试进程无宿主，测试文件内允许（且需要）`initTheme("dark")` 兜底。 |
| T4 | 数据源 = session jsonl 官方解析 + fileSize cursor 增量机制 | 打开时全量 parse 建组件；活跃期间沿用 cursor 机制（`legion-commands.ts:215-241` 的 `readSessionDelta` 语义），250ms 轮询增量。 |
| T5 | toolResult 按 toolCallId 回填进 `ToolExecutionComponent`，不单独建组件 | 对齐主程序行为（pi `interactive-mode.js:3286-3294`）。 |
| T6 | `system` 消息跳过；thinking 块按主程序规则折叠/展开 | pi `interactive-mode.js:3179-3180`。 |
| T7 | 流式 assistant 文本由 RPC `text_delta` 驱动 `AssistantMessageComponent.updateContent()`；每 250ms tick 磁盘增量并入 | 中途 kill 留下的 torn line 靠 cursor 回退（计数回退不推进游标）兜住。 |
| T8 | 查看器数据结构用结构化 `ChatItem[]`，非 `string[]` | 组件方案前置。`getState()` 需保留可测试的状态视图（见 §3.4）。 |
| T9 | 浮窗内 `app.tools.expand`（ctrl+o）经 keybindingsManager 判定；其余滚动/关闭键用 pi-tui 原生键硬编码 | `app.*` 是 pi 应用级键位可被用户自定义；j/k/pgup/esc 是 pi-tui 原生键。树视图键位维持现状不动。 |
| T10 | 依赖 caret 升级 `^1.0.0` + 重新生成 lockfile + `npm install` | worktree 无 node_modules 是历史遗留；typecheck/test 需要真实 .d.ts。npm registry pi-coding-agent 与 pi-tui 最新均为 1.1.0（主会话实测）。 |
| T11 | `ToolExecutionComponent` 的 `ui` 传 `ctx.ui.custom` 工厂第一参数（真实 TUI 实例）；`cwd` 传 `node.worktreePath ?? ctx.cwd`；`toolDefinition` 传 undefined | 查看器无工具注册表上下文；undefined 走 fallback 渲染（scout 实测确认可渲染）。 |
| T12 | **[REV-2] 活跃节点（有 active job）打开浮窗时同样轮询磁盘增量；RPC text_delta 流与磁盘轮询并行**。去重机制：磁盘增量中的 assistant 消息落地时收回（retract）流式组件，避免同一条消息双重渲染；若流式文本领先已落盘消息（属于未落盘后续内容），在增量 append 后重建流式组件显示余量 | REV-1 时代的互斥（"RPC 流缺位时才轮询"）导致活跃节点的结构化消息（user / assistant+toolCall / toolResult）无任何路径进入 viewer——正是用户需求"支持动态渲染"要修复的缺口。旧行为的回归断言（`legion-integration.test.ts` "active text-delta sessions do not duplicate session-file activity"）随之改写为：磁盘增量动态出现 + 不与流式文本重复。 |

---

## 2a. 冻结的 API 签名（实测自 pi 1.1.0 dist；worker 不得偏离）

所有符号来自 `@earendil-works/pi-coding-agent`（主入口）与 `@earendil-works/pi-tui`。扩展运行期由 pi 的 jiti 虚拟模块映射到宿主 dist（同一模块实例），无需安装即可 import；typecheck/test 需要 devDeps 存在（T10）。

```ts
// @earendil-works/pi-coding-agent —— 消息组件（主上下文同款）
import {
  UserMessageComponent,        // new (text: string, markdownTheme?, outputPad?, markdownTransformers?)
  AssistantMessageComponent,  // new (message?: AssistantMessage, hideThinkingBlock?, markdownTheme?,
                              //      hiddenThinkingLabel?, outputPad?, markdownTransformers?)
                              //   .updateContent(message, isStreaming?)
  ToolExecutionComponent,     // new (toolName, toolCallId, args, options?{showImages,imageWidthCells,outputPad},
                              //      toolDefinition?(undefined), ui: TUI, cwd: string)
                              //   .updateResult({content:[{type,text?,data?,mimeType?}], details?, isError,
                              //      durationMs?}, isPartial?)
                              //   .markExecutionStarted(), .setArgsComplete(), .setExpanded(bool)
  getMarkdownTheme,           // () => MarkdownTheme —— 宿主已 initTheme，运行期直接调用
  parseSessionEntries,        // (content: string) => FileEntry[]（v1/v2 旧版本行需先过 migrateSessionEntries）
  migrateSessionEntries,      // (entries: FileEntry[]) => void（原地迁移到当前版本）
  sessionEntryToContextMessages, // (entry: SessionEntry) => AgentMessage[]
} from "@earendil-works/pi-coding-agent";

// 消息类型 —— REV-1 修正（2026-10-13，worker-0 上报：pi-ai@1.1.0 不导出 AgentMessage）：
// AgentMessage 定义在 @earendil-works/pi-agent-core/dist/types.d.ts:322
//   （= Message | CustomAgentMessages[...]，Message 及 AssistantMessage 等成员类型来自 pi-ai）
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
  AssistantMessage, ThinkingContent,
} from "@earendil-works/pi-ai";

// @earendil-works/pi-tui
import {
  Container,                  // addChild/removeChild/clear/invalidate/render
  Spacer, Key, matchesKey, visibleWidth, truncateToWidth,
  stripTerminalSequences, truncateToVisualLines,
  type Component, type TUI, type TuiMouseEvent, type OverlayHandle,
} from "@earendil-works/pi-tui";
```

注意：`pi.getSettings()` 是 `ExtensionAPI` 的方法（pi `dist/core/extensions/types.d.ts:1262`），不是独立导出函数。`markdownTransformers` 参数：主程序的 `registerMarkdownTransformer` 注册的 transformer **不会**自动作用于自建组件实例，查看器传 `undefined` 即主程序无 transformer 时的默认行为。

### 组件配方（照抄 pi `interactive-mode.js:3145-3300` 的 dispatch）

| role / entry | 组件与调用 |
|---|---|
| user | `Spacer(1)` → `new UserMessageComponent(text, mdTheme, outputPad)`。text = 文本 content part 拼接（`UserMessage.content` 可为 string 或 parts）。skill-invocation 块不解析，文本原样渲染。 |
| assistant | `new AssistantMessageComponent(msg, hideThinkingBlock, mdTheme, "Thinking...", outputPad)`。**msg 需克隆：content 只留 text/thinking part**（toolCall part 会另建工具组件；实测 content 含 toolCall 时该组件 render 返回空数组）。 |
| assistant.content 中 `type === "toolCall"` | `new ToolExecutionComponent(name, id, args, {showImages, imageWidthCells, outputPad}, undefined, tui, cwd)` |
| toolResult | 不建组件；按 `toolCallId` 找到对应 ToolExecutionComponent 回填 `updateResult({content, isError, durationMs?})` |
| system / thinking_level_change / model_change / usage / label / session_info / custom（条目）/ context_edit / compaction / branch_summary / custom_message | 不渲染；遇到这些类型跳过不炸 |

### 数据流（全量 + 增量）

```text
打开浮窗:
  sessionFile → fs.readFileSync → parseSessionEntries(text)
    → [migrateSessionEntries 若含旧版本行] → 过滤 type === "message"
    → sessionEntryToContextMessages(entry) → AgentMessage[]
    → dispatch 建 ChatItem[] → 渲染
增量 (250ms poll, 仅 RPC 流缺位时):
  statSync().size > cursor.fileSize 时 re-read 全文件 → parse
    → 与已渲染 message 数比对 → 只把新增 AgentMessage 追加为 ChatItem
    → 计数回退（并发半写）时不推进游标，本 tick 丢弃，下 tick 重试
```

简单方案定案：增量即「全量 re-parse + 计数 diff」，与现有 `readSessionDelta` 的 fileSize cursor 语义一致；子会话文件通常在数十 KB～几 MB 量级，re-parse 成本可接受，规避半行 JSON 边界处理。

### theme / 设置传递链（冻结）

```text
ctx.ui.custom((tui, theme, keybindings, done) => ...)
  → mdTheme   = getMarkdownTheme()      // 借宿主单例；单测进程内 initTheme("dark") 兜底
  → settings  = pi.getSettings()        // outputPad / hideThinkingBlock / codeBlockIndent / showImages / imageWidthCells
  → hideThinkingBlock = settings.hideThinkingBlock ?? false
  → outputPad        = settings.outputPad ?? 1
  → keybindings      // 工厂第三参数，KeybindingsManager.matches(data, "app.tools.expand")
```

worker 实现时如发现签名与实际不符（例如 `getSettings()` 返回形状不同），按 §10 契约矛盾流程上报，不得自行更换方案。

---

## 3. 查看器架构（V3 context viewer）

### 3.1 组件树

```text
LegionContextViewer (Component)            ← ctx.ui.custom(factory, { overlay: true })
 ├─ header: `● name (role) · model · turn N · elapsed · status`（主题化标签行，语义沿用现有 header）
 └─ 滚动视口（自管分页，参照 tree-view.ts:66-68 的 layout-leaf 约束）
     └─ Container
         ├─ Spacer(1) + UserMessageComponent(...)
         ├─ AssistantMessageComponent(...)
         ├─ ToolExecutionComponent(...)
         └─ …（ChatItem 流）
```

### 3.2 ChatItem 数据模型（新增 `src/tui/chat-items.ts`）

```ts
import type { AssistantMessage, AgentMessage } from "@earendil-works/pi-ai";
import type { UserMessageComponent } from "@earendil-works/pi-coding-agent";
// （组件类是值导入；上面仅示意类型关系，实际 import 形式由 worker定，保持类型正确即可）

export type ChatItem =
  | { kind: "user"; component: UserMessageComponent }
  | { kind: "assistant"; component: AssistantMessageComponent }
  | { kind: "tool"; component: ToolExecutionComponent; toolCallId: string };
```

### 3.3 快捷键规范（TUI-first，冻结）

浮窗（context viewer）消费以下输入；树视图键位**维持现状不动**（o/enter/click 打开浮窗、j/k 移动、`/` 搜索等，用户肌肉记忆）：

| 键 | 判定方式 | 浮窗行为 |
|---|---|---|
| esc | `matchesKey(data, Key.escape)` | 关闭浮窗 |
| ctrl+o | `keybindingsManager.matches(data, "app.tools.expand")` | 切换全部工具块展开状态（`ToolExecutionComponent.setExpanded()`） |
| j / down | `matchesKey` | 向下滚动一行 |
| k / up | `matchesKey` | 向上滚动一行 |
| pgdn / pgup | `matchesKey(data, Key.pageDown/pageUp)` | 页滚（页大小 = 视口高度） |
| g / G | `matchesKey` | 滚到底部 / 顶部（vim 惯例） |
| 流式期间 | — | follow-end：新内容到达自动滚到底（用户手动上滚后暂停 follow，滚到底恢复） |

### 3.4 状态与可测试性

- `getState()` 至少暴露：`nodeId` / `open` / `turn` / `status` / 结构化 items 计数或派生的纯文本行视图（供既有测试断言改造使用）。具体形状 worker 定，测试随之适配，但**订阅/退订/backfill 游标/互斥**的既有测试意图必须保留（§4.2 U2/U7）。
- 生命周期语义不变：`createLiveOverlay.open(nodeId)` 每次新建组件、close/dispose 精确退订一次（现有 `live-overlay.ts` 行为，测试覆盖）。

### 3.5 Fast path（不炸约束）

- 无 sessionFile 的节点：显示 header + "No session yet."，不炸不白屏。
- 孤儿 toolResult（toolCall 组件尚不存在）：存 pending map，组件创建时回填。
- torn line / 计数回退：cursor 不推进，本 tick 丢弃（T7）。
- 旧版本 session 行（v1/v2）：`migrateSessionEntries` 迁移后照常渲染。

---

## 4. 文件归属与验收

### 4.1 文件所有权（本次交付为单 worker 两阶段，见 §5）

| 阶段 | 文件 | 语义 |
|---|---|---|
| A | `package.json`（devDeps 升级 + pi-ai devDep）、`package-lock.json` | 依赖基线 |
| A | 任意文件（**仅机械 type-compat**，逐条报告） | 1.x 类型表面所需的非行为修复 |
| B | `src/tui/live-overlay.ts`（重写为查看器）、`src/tui/chat-items.ts`（新）、`src/tui/message-factory.ts`（新，可选合并入 chat-items） | 查看器核心 |
| B | `src/extension/legion-commands.ts` | 接线：`treeForLiveSource.backfill` 改造 + `openLiveOverlay` 换新查看器 + TUI guard（T1） |
| B | `test/unit/legion-live-overlay.test.ts`、`test/unit/legion-integration.test.ts`（仅 §4.2 U7 授权的断言适配） | 测试适配 |
| B | `docs/tui-viewer-contract.md` | 本契约（若有 REV 修订） |

**禁改**：`src/supervisor/**`、`src/legion/**`、`src/runs/**`（阶段 A 的机械 type-compat 除外，逐条报告且不得改行为）、`src/extension/runtime.ts`、`src/extension/notice-renderer.ts`、`docs/legion-v2-contract.md`、`README.md`、`agents/`、`skills/`、`test/unit/legion-tree-view.test.ts`、`test/unit/legion-schema-sentinel.test.ts`。

### 4.2 验收清单（可机器判定）

- **U1** `npm run typecheck` 通过（pi 1.x .d.ts 下）。
- **U2** `npm test`（unit）全绿；live-overlay 既有 5 测试的**意图**保留（订阅/退订/换节点/游标/关闭停轮询），断言可适配新结构。
- **U3** `npm run test:integration` 全绿。
- **U4** cursor 回退保护：模拟文件计数回退（并发半写），游标不推进、不重放旧消息（新增测试）。
- **U5** 全量渲染冒烟：假 session（user/assistant/toolCall/toolResult 混合）→ render 输出含用户消息底色 ANSI、markdown 代码高亮 ANSI、工具块标题行（新增测试）。
- **U6** 快捷键冒烟：ctrl+o 切换工具块展开（render 输出变化）、pgdn 滚动、esc 关闭（新增测试）。
- **U6a** `test/unit/legion-tree-view.test.ts` 全绿且其覆盖的源文件零改动。
- **U7** `legion-integration.test.ts:717-725` 的 backfill 行断言允许适配为全量渲染语义（打开时渲染全部 turn，契约 T4）；除此之外该文件仅允许为组件流改造所必需的断言修改。
- **U7a** [REV-2 改写] 激活节点打开浮窗时磁盘轮询照常工作：RPC text_delta 流活跃期间，session 文件新落盘的结构化消息必须动态出现在 viewer，且不与流式文本重复渲染（收回/重建去重）。原 "active text-delta sessions do not duplicate session-file activity" 断言改写为 "动态出现 + 无重复"（`legion-integration.test.ts` 对应用例）。
- **U7c** [REV-2 新增] 流式收回去重：磁盘增量落地某 assistant 消息后，流式组件被收回；若 streamingText 领先该消息（未落盘余量），流式组件重建显示余量（`legion-live-overlay.test.ts` 新用例）。
- **U7b** `legion-schema-sentinel.test.ts` 不受影响（预期全绿）。
- **U8** `npm run test:all`（typecheck + unit + integration）全绿。
- **U9**（人工，主会话收官）真实宿主打开 `/legion` 点开 agent，浮窗视觉对齐主上下文。

---

## 5. 里程碑划分

| # | 内容 | 执行者 | 依赖 |
|---|---|---|---|
| M1 | 契约落库 commit | 主会话 | — |
| M2 | 阶段 A：依赖升级基线绿；阶段 B：查看器重写 + 接线 + 测试适配（单 worker，A 完成自检后才进 B） | W1（worker） | M1 |
| M3 | 主会话验证：test:all 全绿 + 真实宿主人工冒烟（U9） | 主会话 | M2 |
| M4 | reviewer 对抗式审查（正确性/回归/测试覆盖）→ findings → steer 原 worker 修复 → 复审 → 合并 | reviewer + W1 | M3 |

单 worker 两阶段的原因：阶段 B 的 typecheck 依赖阶段 A 装出的 1.x 依赖；`package.json` 与 `live-overlay.ts` 归属同一 worker 避免跨分支冲突。

---

## 6. 人工验收样例（主会话 M3 使用）

1. 打开一个活跃 scout：assistant 流式文字带 markdown 渲染（标题色、代码高亮）。
2. 工具调用块：pending/success/error 状态色；ctrl+o 展开显示 args/result，可再收起。
3. 用户消息块：底色、padding 与主上下文相同。
4. thinking 块折叠为 "Thinking..."（`hideThinkingBlock=true` 时）。
5. 生成期间浮窗 follow-end；手动上滚后暂停，滚到底恢复。
6. 无 sessionFile 的节点降级行不炸。

---

## 7. 明确不做（防蔓延）

- 不给 tree-view 新增键位/交互。
- 不做浮窗内「回复/steer」输入框（subagent 交互仍走 subagent 工具）。
- 不做浮窗搜索。
- 不改 RPC supervisor / orchestrator 的运行时行为。**例外**：阶段 A 允许 1.x 类型表面变化所需的机械 type-compat 修复（不改行为、逐条报告）；若发现 RpcClient API 语义级变化（机械修复无法满足），停下按 §10 上报。
- 不做主会话级 `system` prompt 的渲染、不做 compaction/branch_summary 视图。

---

## 8. 既有测试意图对照

| 测试文件 | 意图保留 | 断言适配 |
|---|---|---|
| `legion-live-overlay.test.ts` | 生命周期/订阅/退订/backfill 游标/关闭停轮询 | 适配新结构 |
| `legion-integration.test.ts` | 双通道互斥、stored/process 去重、树入口 | U7 授权范围内的适配 |
| `legion-tree-view.test.ts` | 树键位/OSC8 | 不动 |
| `legion-schema-sentinel.test.ts` | DB schema 契约 | 不动 |

---

## 9. 契约修订记录（REV）

- **REV-1**（2026-10-13，触发者 worker-0）：§2a 消息类型 import 修正——`AgentMessage` 来自 `@earendil-works/pi-agent-core`（`dist/types.d.ts:322`）而非 pi-ai（pi-ai@1.1.0 不导出该类型）；`AssistantMessage`/`ThinkingContent` 等成员类型仍来自 pi-ai。机械缺口，直接修订。
- **REV-2**（2026-10-20，触发者主会话，用户新需求）：T12 互斥解除——用户反馈活跃节点上下文展示不支持动态渲染；根因是 RPC feed 订阅成功时磁盘轮询被关闭，结构化消息无路径进入 viewer。改为双通道并行 + 流式组件收回去重（chat-items.ts 新增 `retractStreamingItem()`）。U7a/U7c 同步改写/新增。涉及文件：`src/extension/legion-commands.ts`（订阅时始终挂 pollBackfill）、`src/tui/live-overlay.ts`（acceptBackfill 增量收回/重建流式组件）、`src/tui/chat-items.ts`（新增收回能力）、两测试文件。

## 10. 修订规则

worker 发现契约矛盾：停下上报（不要自行解释）。主会话核事实 → ①机械缺口直接修契约落 REV-x（日期/条款/原因/触发者）+ commit；②语义歧义派 advisor 裁决，裁决落 REV 后重派。
