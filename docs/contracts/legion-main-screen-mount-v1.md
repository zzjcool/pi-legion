# /legion 主屏挂载契约 v1（page mount）

> 状态：**生效**，随 #347 落地。这是一条**记录性 + 约束性**契约：把 `/legion` 的挂载方式
> 与它带来的三条不变量写死，避免以后有人「顺手」把它改回全屏 overlay。
> 冲突时**停下报告**，不得自行重新解释本契约。
> 关联：#347（逐行合成占整帧 57–70%）、#308（详情浮层右侧黑带 → `paintPageFloor`）、
> #193（浮层不画遮罩）、#157（详情浮层 75% 尺寸）。

---

## §1 问题陈述

`/legion` 曾以**全屏 overlay** 打开：

```ts
// 改动前 src/extension/legion-commands.ts
await ctx.ui.custom(createLegionViewFactory({ ... }), {
	overlay: true,
	overlayOptions: { width: "100%", maxHeight: "100%", anchor: "top-left", row: 0, col: 0 },
});
```

pi-tui 对**每个可见 overlay 的每一行**都跑 `compositeTuiLine`
（`extractSegments` + `sliceWithWidth` + `visibleWidth`，三次 `Intl.Segmenter` 字素扫描），
且行宽缓存按**整行字符串**做 key —— 每秒都在变的帧永远命中不了。`/legion` 恰恰是这条路径的
最坏输入：非空格里 56%–68% 是 braille `⣿`、box `┏│┄`、块 `█▁▂`，没有任何一行是纯 ASCII。
issue #347 实测：整帧 5.05 / 8.59 / 17.06 ms（80×24 / 120×40 / 200×60），
其中合成+行重置占 **65% / 57% / 70%**，非 ASCII 行单价是 ASCII 的 **3.67×**。

根因不是页面画得慢（`component.render(cols)` 只要 1.79 / 3.70 / 5.09 ms），而是**挂载方式**：
overlay 意味着整屏行都要被宿主再合成一遍。

---

## §2 约定

**R1 — `/legion` 页面必须挂主屏（`overlay: false`），不得以 overlay 挂载。**
唯一出口：`src/extension/legion-commands.ts` 里 paged viz 视图的
`ctx.ui.custom(createLegionViewFactory(...), { overlay: false })`。

- 主屏挂载 = 宿主把组件**替换**进 base 布局（editor 容器），而不是叠在 base 之上 ⇒
  pi-tui 的 overlay 合成层完全不参与，页面只付自己那一次 `render()`。
- 因此**不得**给该视图传 `overlayOptions`：没有 overlay rect，就没有需要合成的矩形。
- 经典 `--tree` 视图（`legion-commands.ts` 里 `createTreeViewFactory` 那条）本来就是这个挂载
  方式，两者现在一致。
- 变异验证：把这一处改回 `overlay: true` + `overlayOptions`，
  `test/unit/legion-integration.test.ts` 的
  「`/legion` mounts the full page on the main screen, not as a full-screen overlay (#347)」立刻变红。

**R2 — 主屏挂载不等于「拿到布局高度」，页面继续自己按 `terminal.rows` 定高。**
`ui.custom` 的非 overlay 组件是**布局叶子**，宿主不会给它分配视口高度（`src/tui/tree-view.ts`
的注释同样如此）。所以 `createLegionViewFactory().render()` 仍旧
`Math.max(6, tui.terminal.rows ?? 24)` 自己定高，跟 `createTreeViewFactory` 注入
`terminalRows` 的做法同源。**不要**为了「看起来像主屏」把它改成固定行数或改成
`width` 推导高度。

**R3 — 详情浮层仍是 75% 浮层，几何一个像素都不动。**
`/legion` 里按 `o`/`⏎` 打开的详情（`openLiveOverlay`）仍然
`ui.custom(factory, { overlay: true, overlayOptions: resolveModalOverlayOptions() })`：
`MODAL_MAX_WIDTH_RATIO = 0.75`、`MODAL_MAX_HEIGHT_RATIO = 0.65`、
`MODAL_MIN_FRAME_ROWS = 8`（`src/tui/live-overlay.ts`）。#157/#193 的取舍不变。
`resolveModalOverlayOptions()` 用百分比而非绝对格数，所以 resize 后 rect 由 pi-tui 按当前
终端重新推导 —— 这条语义**不因页面改主屏挂载而变化**，`test/unit/legion-live-overlay.test.ts`
的 resize 用例原样绿。

**R4 — `Esc`/`q` 关闭后必须回到会话视图。**
主屏挂载的关闭路径由宿主提供：`showExtensionCustom` 的非 overlay 分支在打开时
`editorContainer.clear()` + `addChild(component)`，关闭时把 editor 重新挂回并
`setFocus(editor)`。所以页面自己只需要 `done(undefined)`（`handleViewKey` 返回 `close`），
**不要**自己缓存/重建 editor，也不要在 `dispose()` 里碰宿主容器。

**R5 — `paintPageFloor` 在主屏挂载后**仍然必需**，不是保险。**
`src/tui/viz/view.ts` 的 `paintPageFloor` 保持原样（不改、不删、不弱化）。#308 的前提是
「详情浮层是 overlay，合成器对 rect 右侧段的样式继承取 base 行尾的一次性 SGR 快照，而
`/legion` 行尾是裸空格」，这与**页面本身**怎么挂载无关：

- 页面改主屏挂载后，详情浮层依旧叠在页面行上，合成器依旧按行取快照。
- 实测（`test/helpers/modal-composite.ts` 的 `assertOverlayGutterInheritsBase({ mount: "main" })`）：
  - 有 floor：`frameRightBg = \u001b[48;5;236m`（= base 的页面底色），与 overlay 挂载时一致；
  - 去掉 floor（把 `render()` 改回直接返回 `canvas.toLines(theme)`）：**两种挂载**的
    `rowBg` / `baseRightBg` / `frameRightBg` 全部退化成 `""`（终端默认背景）⇒ 黑带重现。
- 结论：floor 的代价（issue 实测 +21 B/行、整帧 +504/840/1260 B、0.002–0.003 ms）在主屏挂载后
  依旧换来「浮层右侧无黑带」，不属于本 issue 的优化对象。
- 验收用例：`test/unit/legion-live-overlay.test.ts` 的
  「the /legion page mounted on the main screen keeps its floor under the modal's gutters (#347)」
  （`mount: "main"`）+ 原 #308 用例（`mount: "overlay"`，保留为历史几何的记录）。

**R6 — 不改宿主合成器、不 fork `compositeTuiLine`、不动 pi-tui 节流常量。**
本仓不复制/重写 `node_modules/@earendil-works/pi-tui` 的合成实现，也不改
`MIN_RENDER_INTERVAL_MS`（16ms）一类的宿主节流；`/legion` 自己的重绘节流
（`createLegionViewFactory` 的 `refreshMs`，默认 1000ms）同样不动。
主屏挂载之所以有效，正是因为它**绕开**了那条路径，而不是优化它。

**R7 — 视觉内容等价。**
挂载方式不影响画什么：同一组件、同一数据在两种挂载下写出字节相差 <4%（见 §3 表），
`filter`/宽度/行数断言全部沿用。若将来某次改动让每帧字节增长 >2%，视为回归。

---

## §3 验收

**单测**（`npm test`）：

| 用例 | 断言 |
|---|---|
| `legion-integration` → `/legion mounts the full page on the main screen…(#347)` | `overlay !== true`、`overlayOptions === undefined`、`j`+`o` 仍开 75% 浮层（`resolveModalOverlayOptions()`）、浮层 Esc 后页面仍在、`q` 回会话视图。**改回 overlay 立刻红**。 |
| `legion-live-overlay` → `the /legion page mounted on the main screen keeps its floor…(#347)` | 主屏挂载 + 75% 浮层：左右 gutter 文本 = base，`rowBg`/`baseRightBg`/`frameRightBg` 全 = `PAGE_FLOOR_ANSI`（显式要求非空）。**去掉 floor 立刻红**。 |
| `legion-live-overlay` → #308 原用例 | overlay 挂载的同一断言，保留。 |
| `legion-live-overlay` → `the modal frame survives a terminal resize…` | resize 语义原样绿（几何不变）。 |

**基准**（`bench/perf-core/09-legion-mount.ts`，同一组件/数据/主题，一个 TUI 实例内成对测
base → 浮层 → 空白对照，`written[]` 每帧清空，50 帧 × 3 轮）：

| 终端 | 页面帧 median（overlay → 主屏） | p95 | 页面帧字节 | 开浮层额外成本（主屏） | 空白 rect 对照 |
|---|---|---|---|---|---|
| 80×24 | 2.49 → **0.96 ms**（2.6×） | 5.30 → **1.25** | 7837 → 7597（−3.1%） | +1.45 ms（≤2.0 ✓） | +1.16 ms |
| 120×40 | 4.41 → **1.77 ms**（2.5×） | 17.64 → **2.85** | 16277 → 15877（−2.5%） | +2.69 ms | +2.39 ms |
| 200×60 | 8.63 → **3.35 ms**（2.6×） | 41.51 → **4.67** | 32575 → 31975（−1.8%） | +5.35 ms | +4.86 ms |

（共享机噪声大，绝对值只看同一量级：同一脚本多次运行的页面 median 是
0.93–0.97 / 1.69–1.77 / 3.26–3.39 ms，主屏侧 p95 稳定在 1.2–4.7 ms，而 overlay 侧 p95 在
共享机上是 5–42 ms 的噪声区间。脚本输出每个 cell 的分轮中位数。）

**关于「开浮层额外成本 ≤2.0 ms/帧」。**
这一条**只在 80×24 成立**（+1.35 ms），在 120×40 / 200×60 上不可达，且与 #347 的实现无关：

1. 详情浮层仍是 75% overlay（R3 锁定），120×40 / 200×60 时它有 26 / 39 行，每行都要过一次
   `compositeTuiLine`（issue 实测 183 µs/行 ⇒ 26 行 ≈ 4.76 ms）；
2. 决定性对照：把同一个 75% rect 换成**纯空格组件**（什么都不画），主屏挂载下仍然
   +2.4–2.9 / +4.9–6.1 ms —— 也就是说「只要浮层存在」这笔合成费就必须付，页面挂载方式动不了它；
3. 浮层组件自己的 `render(75% 宽)` 只要 0.09 / 0.15 ms，所以 Δ 的 95%+ 是宿主合成而非浮层绘制。

因此基准把这一条按 80×24 立门禁，另加两条对所有尺寸成立的门禁：
**页面帧 median/p95**（issue POC 1.65 / 3.84 / 6.37 ms 的 +30% / ≈2×）与
**浮层 Δ 不得超过同尺寸空白 rect 对照 + 0.5 ms**（即 Δ 完全由浮层自身行数解释）。
要真正压掉这 26/39 行的合成，只有 issue 里的 B（降字形密度）或 C（上游 ASCII 快路径），
不在本契约范围。

---

## §4 不做（边界）

- **不改浮层几何**：75% 宽 / 65% 高、`MODAL_MAX_WIDTH_RATIO`、`MODAL_MAX_HEIGHT_RATIO`、
  `MODAL_MIN_FRAME_ROWS`、`resolveModalOverlayOptions()` 全部保持。
- **不改 pi-tui**：不 fork/重写 `compositeTuiLine`，不改 `MIN_RENDER_INTERVAL_MS` 等节流常量，
  不 patch `node_modules`。
- **不动 `paintPageFloor`**：见 R5，它在主屏挂载后仍然必需。
- **不改 `/legion <node>` / 状态栏 widget 的打开路径**：前者本来就是 75% 浮层，后者躺在宿主
  聊天区（`docs/contracts/legion-page-floor-v1.md` R1）。
- **不为「主屏挂载」重写页面布局**：`renderLegionView` 的画法、分栏、footer 快捷键一律不变。
