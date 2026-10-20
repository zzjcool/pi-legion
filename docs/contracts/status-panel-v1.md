# Status panel v1 — `/legion` 大盘的 status 面板 + status 字段缺口补齐

> 冻结契约。合并权人裁定，worker 不得自行解释矛盾，遇矛盾向父会话报告。
> 基线：`3071dee` (3.1.0)，`npm run typecheck` = 0、`npm test` = 0。

## 0. 目标

1. 在 `/legion` 全屏大盘（`src/tui/viz/`）新增 `status` 面板，把目前只存在于聊天文本里的 `/legion status` 数据搬到大盘上。
2. 补齐 `/legion status` 的已知缺口：`supervisor=unknown`、`owner` 缺失、无内存、无 context tokens、`usage` 未格式化。

## 1. 不可违反的既有约束

| 约束 | 锚点 |
| --- | --- |
| **禁止给 `legion.db` 加列、禁止升 `LEGION_DB_USER_VERSION`** | `docs/spawn-mode-visibility-v1.md:143`、`test/unit/legion-schema-sentinel.test.ts` |
| 运行时零外部依赖（Node stdlib only） | `CONTRIBUTING.md:215` |
| 每行 `visibleWidth === w`（严格相等，非 ≤） | `test/unit/legion-viz.test.ts:417-434,628,911,1464,1630` |
| 平台降级不得抛错：非 Linux 返回空值 | 先例 `src/supervisor/proc-tree.ts:44` |
| `spawnMode` 缺失必须渲染 `unknown`，**绝不猜 `rpc`** | `src/extension/runtime.ts:84-89`、`test/unit/runtime.test.ts:1490-1501` |

## 2. 设计决策

### D1 — 新增第 5 个 pane，但 portrait 不渲染

- `wide` / `stacked` 新增 `status` rect；`portrait` 的 `layout.status` 返回**零面积 rect** `{x,y,w:0,h:0}`。
- 理由：portrait `46×24` 实测 `galaxy=5 chart=10 timing=3 log=3`，`bodyH=21`，4 个 pane 最小高之和 `3+10+3+3=19`，仅剩 2 行 —— 物理上装不下第 5 个 pane（最小 3 行）。`timing`/`log` 在 `h=3` 时内框 `h=1`，`drawTiming`/`drawLog` 本就提前 return，**portrait 极矮时这两个 pane 已是空壳**。
- `frame()` 在 `h<3` 已早退且不画任何东西，所以零面积 rect 天然安全，无需特判绘制。
- **Tab 必须跳过零面积 pane**：新增 `availablePanes(layout)`，返回 `h>0` 的 pane 列表；`handleViewKey` 增加可选第 4 参 `panes`，**缺省 = 全部 pane**（保证既有测试不变）。
- 被否决：(a) 全布局都加 → portrait 溢出 footer；(b) status 复用 timing 做可切换视图 → 隐藏态发现性差，且 `drawTiming` 宽度算术已很紧；(c) 把 status 塞进 log → 语义冲突。

### D2 — inprocess 内存口径：只显示 host rss，禁止按子 agent 摊派

- `rpc` 子 agent：有独立 pid → 显示 per-child `rss`。
- `inprocess` 子 agent：**没有独立进程**（`inprocess-supervisor.ts:751-754` 只返回 name+sessionFile）。面板与 status 文本中 **inprocess 行的 rss 列留空/`—`**，另起一行显示 `host rss <N> MB · shared by N inprocess`。
- **严禁**按 token 比例把 host rss 摊到子 agent 头上 —— 那是编造数据，用户会拿它做决策。
- 理由：诚实性优先于信息密度。

### D3 — pid 穿透（不加 DB 列）

链路：`ChildHandle.pid` → `Handle.pid` → `TrackedJobInput.pid` → `StatusEntry.pid` → `VizNode.pid`。

- `src/shared/types.ts:482` `Handle` **当前无 pid**，必须加 `pid?: number`。
- `src/runs/orchestrator.ts:800` 附近（`spawnMode: mode` 同处）写入 `...(result.pid ? { pid: result.pid } : {})`。
- `TrackedJobInput`（`src/extension/runtime.ts:73-107`）加 `pid?: number`；`index.ts:2675` 的 `runtime.track({...})` 补传。
- pid 不落盘是既有事实，**不新增持久化**——viz 只在当前宿主进程可见，跨进程显示为未知。

### D4 — context tokens：扩 `ParsedSession`，不做百分比

- `accumulateUsage`（`src/shared/session.ts:124-136`）在累加的同时，把**最后一条 assistant message** 的 `input + cacheRead + cacheWrite` 记到 `ParsedSession.lastContextTokens`。
- `LiveProgress`（`src/shared/progress.ts:9-28`）加 `contextTokens?: number`；`progressFromSession` 投影；`mergeProgress` 用「later wins」语义。
- **不显示百分比**：`contextWindow` 在 JSONL 中不存在，全仓零命中。要百分比就得引模型注册表，超出本契约范围。显示绝对值 `ctx 24.3K tok`。
- 被否决：直读 session JSONL 最后一条 assistant usage → 与既有 `parseSessionFile` 重复解析，且绕过 `accumulateUsage` 单一事实源。

### D5 — 修 `childStatus` 漏传（现存 bug）

`index.ts:926-946` 的 `childStatus` 回调补 `spawnMode` 与 `owner`：

- `spawnMode: child.spawnMode`（run.json 已有值，`src/shared/types.ts:365-373`）
- `owner:` 用既有 `runOwnerStatus(runDir)`（`src/runs/owner.ts:60` 返回 `live|dead|unknown`）
- 正确范例：`index.ts:1417-1428`、`index.ts:2887-2899`（这两处**已传** spawnMode）。
- 这是纯 bug fix，与新增面板解耦，可独立验收。

### D6 — 所有新字段一律 optional

`VizNode` 新增字段必须 optional，否则 3 处字面量构造编译失败：`test/unit/legion-viz.test.ts:18-20`、`test/unit/legion-stop.test.ts:92`、`src/tui/viz/panels.ts:103-105`。

投影沿用仓库惯例 `...(cond ? {k:v} : {})`（`model.ts:72-79`），**不写 `undefined` 字面量**。

### D7 — status 面板字段集与宽度降级档位

表头 1 行 + 可选页脚 1 行；列按**绝对列数**分层（沿用 `drawTiming` 惯例）：

| 内框宽 | 列 |
| --- | --- |
| `w >= 72` | `name · role · state · supervisor · ctx · rss · turns` |
| `w >= 52` | `name · state · supervisor · ctx` |
| `w >= 36` | `name · state · ctx` |
| `w >= 20` | `name · state` |
| `w < 20` | 不画（return） |

- 守卫：`if (r.w < 20 || r.h < 2) return;`（`drawTiming` 用 `w<8,h<2`；本面板列多，下限提到 20）
- `footerH = rows.length > 0 && r.h >= 4 ? 1 : 0`；`rowsAvail = max(0, r.h - 1 - footerH)`
- **所有 `cv.text` 必须带 `maxX` 或先 `ellipsize`** —— 禁止复制 `drawLog`（`panels.ts:530-532`）的越界 bug。
- `rss` 列：rpc → `152M`；inprocess → `—`；未知 → `—`。**不得写大写单位**（`legion-viz.test.ts:927` 的字符类只含小写 a-z），用 `M` 会红 → 改用 `m`；或把该断言一并更新（见 §5）。

### D8 — Tab 顺序：status 追加到末尾

`PANES = ["galaxy","chart","timing","log","status"]`（`src/tui/viz/view.ts:36`）。

- 追加在末尾使 `legion-viz.test.ts:442`（chart）、`:444`（timing）、`:446`（log）**全部继续通过**，只需新增一条 status 断言。
- 被否决：插入 timing 与 log 之间 → 直接打红 3 条既有断言，且 `:1588-1593` 再红一条。

## 3. 文件所有权（严格边界，禁止越界）

### Worker A — 数据管道 + status 文本（先做）

| 文件 | 性质 |
| --- | --- |
| `src/supervisor/proc-memory.ts` | **新增**：`readProcRss(pid)`，读 `/proc/<pid>/status` 的 `VmRSS`/`VmHWM`，非 Linux / 读失败 / pid 已退 → `undefined`，绝不抛 |
| `src/shared/types.ts` | 改：`Handle.pid?`、`ParsedSession.lastContextTokens?` |
| `src/shared/session.ts` | 改：`accumulateUsage` 记录最后一条 assistant 的 context tokens |
| `src/shared/progress.ts` | 改：`LiveProgress.contextTokens?` + `progressFromSession` + `mergeProgress` |
| `src/runs/orchestrator.ts` | 改：`Handle` 写入 `pid` |
| `src/extension/runtime.ts` | 改：`TrackedJobInput.pid?`、`statusEntryFromJob`/`statusEntryFromNode` 写 `spawnMode/pid/contextTokens/rss`、`renderLiveChildStatus` 增 memory/ctx 行 |
| `src/tui/status.ts` | 改：`StatusEntry` 加 `spawnMode?/pid?/contextTokens?/rss?`（**不动 `formatWidgetLines`**） |
| `index.ts` | 改：`childStatus` 补 `spawnMode`/`owner`；`runtime.track` 补 `pid` |
| `test/unit/proc-memory.test.ts` | **新增** |
| `test/unit/legion-status.test.ts` | 改：新增字段断言（`:110-147`、`:192-254` 现有断言**不得放宽**，只追加） |
| `test/unit/runtime.test.ts` | 改：`renderLiveChildStatus` 新行断言 |

**Worker A 严禁触碰**：`src/tui/viz/**`、`src/tui/tree-view.ts`、`src/tui/live-overlay.ts`、`docs/**`。

### Worker B — viz 面板（等 A 合入后）

| 文件 | 性质 |
| --- | --- |
| `src/tui/viz/layout.ts` | 改：`LegionLayout.status: Rect` + 三批分支 + `availablePanes` |
| `src/tui/viz/panels.ts` | 改：`Pane` 联合加 `"status"`；**新增 `drawStatus`**；**不修改** 既有 4 个 draw* |
| `src/tui/viz/view.ts` | 改：`PANES` 末尾追加；`frame`+`drawStatus` 调用；`clampList` 支持 `"status"`；`handleViewKey` 第 4 参 `panes` |
| `src/tui/viz/model.ts` | 改：`VizNode` 加 optional 字段 + `nodesFromEntries` 投影 |
| `test/unit/legion-viz.test.ts` | 改：新增 status 面板断言（§5 清单） |

**Worker B 严禁触碰**：`src/extension/**`、`src/shared/**`、`src/runs/**`、`src/tui/status.ts`、`index.ts`。

## 4. 分阶段与验收

| 阶段 | 内容 | 验收 |
| --- | --- | --- |
| P1 | Worker A 全量 | `npm run typecheck` && `npm test` |
| P2 | Worker B 全量（依赖 P1 已合入） | `npm run typecheck` && `npm test` |

每个阶段必须 **typecheck 0 / test 0**。首个非零退出即判 rejected。

## 5. 必须同步更新的测试（逐条）

| 测试 | 原因 | 期望 |
| --- | --- | --- |
| `legion-viz.test.ts:417-434` | 新增 status 面板标题 | 追加 `plain.some(l => l.includes("status"))`；**不得放宽** `visibleWidth === w` |
| `legion-viz.test.ts:437-459` | Tab 顺序末尾新增 | 在 `:446` 后追加 `handleViewKey("\t")` → `assert.equal(state.focus, "status")`；既有 3 条保留 |
| `legion-viz.test.ts:160-183` | layout 新字段 | `for (const r of [galaxy,chart,timing,log,status])` 加入界内断言；**portrait 跳过 status**（零面积） |
| `legion-viz.test.ts:872-901` | 几何锁 | portrait 段保持四段相接断言不变；wide 段新增「右列三段相接」断言 |
| `legion-viz.test.ts:927` | header 字符类 | 若 header 未变则不动；**status 面板内容不写入 header** |
| `legion-viz.test.ts` 新增块 | `drawStatus` 单测 | 覆盖 D7 四档宽度 + `w<20` 退化 + inprocess `rss` 为 `—` |
| `legion-status.test.ts:110-147` | 新增 memory/ctx 行 | 既有首行/`alive`/`execution snapshot` 断言保留，追加新行断言 |
| `legion-status.test.ts:192-254` | `formatTree` 未变 | **不动**（`formatTree` 不在本契约改动范围） |

## 6. 风险与裁决

| 风险 | 裁决 |
| --- | --- |
| `drawLog` 内框 `w<=14` 写出 rect 右边界（`panels.ts:530-532`） | **顺手修**：给该 `cv.text` 补 `maxX: r.x + r.w - 1`。属 P2 范围，单独 commit，附回归断言。理由：Worker B 正在改同一文件，且新面板极易复制此模式。 |
| view 层 `layout.timing.h - 3` 与 draw 层 `innerH-1-footerH` off-by-one（`view.ts:90`） | **本契约不修**。改动会影响 `timingVisible` 语义与既有断言，独立提 issue。新面板**必须**用精确公式，不照抄 `-3`。 |
| portrait 零面积 status 被 Tab 跳过 | 由 `availablePanes` 保证；`handleViewKey` 缺省参数保证既有测试不变 |
| pid 跨进程不可见 | 接受。viz 显示 `—`，不猜。 |
| `readProcRss` 的 pid 复用 race | **实现为「不打印」**：`!alive` 时直接不读 `/proc`，返回 `undefined`。v1 无 last-known 缓存设施（`memoryLine` 无状态、`TrackedJob` 无 rss 字段），新增缓存需额外的失效规则，比不打印更易说谎。`(last)` 分支**明确不在 v1 范围**。读取必须 try/catch。 |

## 7. 契约修订点

- 本文件即新增契约，无需改动 `docs/legion-v2-contract.md` §10.1（三层 UI 定义不变，status 面板属第 2 层内部枚举新增）。
- `docs/tui-viewer-contract.md:202` 的禁改清单**不包含** `src/tui/viz/**`，Worker B 无需先修订该文档。
- `README.md` 的「Three-layer visualization」段落可在 P2 后追加一句 status 面板说明（可选，非门禁）。

## 8. 契约勘误（P1 实施中记录）

1. **§5 必改测试表漏列 `test/unit/progress.test.ts`**。D4 的 `progressFromSession` 投影让该文件两处完整对象 `deepEqual` 机械性必红。实际处理：加 `contextTokens: 10` 两行，属**加强断言**（新字段被钉死），零删除。
2. **`runtime.test.ts` 既有 D2 测试与 §6 冲突**。该测试原本用 `alive: false` + pid 断言「有 memory 行」，与 pid 复用防护直接矛盾。实际处理：把前置条件改为 `alive: true`，断言文本/正则/非 Linux 分支全部原样保留，强度不变。
3. **`(last)` 展示未实现**（见 §6 修订）。

## 9. 修订历史

| 日期 | 版本 | 说明 |
| --- | --- | --- |
| 2026-10-19 | v1 | 初版。父会话直接裁定（planner 卡死于「声称写文档但从不落盘」，已止损）。 |
| 2026-10-19 | v1.1 | P1 交付后补：pid 复用裁决改为「不打印」；记录 3 条勘误。 |
