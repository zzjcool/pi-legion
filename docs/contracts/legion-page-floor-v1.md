# /legion 页面底色契约 v1（README for the page floor）

> 状态：**生效**，随 #308 落地。这是一条**记录性**契约：把一个已经可验证的渲染不变量写死，
> 避免以后有人把 `/legion` 行尾的底色改回去。
> 冲突时**停下报告**，不得自行重新解释本契约。
> 关联：#308（浮层右侧黑竖带）、#193（浮层黑边：浮层本身不画遮罩）、#157（浮层 75% 尺寸）。

---

## §1 问题陈述

`/legion` 轨道图里选中节点按 `o`/`⏎` 打开详情浮层后，**浮层右缘到终端右缘**是一条纯黑竖带，
左侧正常。根因不是浮层越界（`paintModalFrame` 每行宽度恒等于 rect 宽，见
`src/tui/live-overlay.ts`），而是 **base 的行尾空格不带任何 SGR**：

1. `Canvas` 构造即预填 `W×H` 空格（`src/tui/viz/canvas.ts`），`renderRow` 只在
   `start.color && text.trim().length > 0` 时才套 `theme.fg` —— 于是行尾一大段空格是裸空格。
2. pi-tui 的合成器（`@earendil-works/pi-tui@1.1.0`，`dist/utils.js` 的 `extractSegments`；
   本 check-out 里快照发生在 `:1242` `after += pooledStyleTracker.getActiveCodes()`）对矩形
   **右侧段**的样式继承是「after 段的**第一个字素**出现时，打一次当时激活 SGR 的快照」。
3. 行尾是空格且此前无激活 bg ⇒ 快照为空 ⇒ 右侧留白段落到终端默认背景 ⇒ 黑竖带。

**注意**：`test/helpers/modal-composite.ts` 里 #193 的 `wipedRows` 判据对此**不敏感**
（它 strip 掉所有 escape，只比文本，而文本一直是 base 的）。所以 #308 的验收用例必须保留 ANSI，
比较的是「**样式**」而不是「文本」。

---

## §2 约定

**R1 — `/legion` 每一行外层必须带底色。**
唯一出口：`src/tui/viz/view.ts` 的 `createLegionViewFactory().render()` →
`paintPageFloor(theme, canvas.toLines(theme))`。所有 row 都要包，包括整行空白的 row
（正是这些行构成了浮层右缘到终端右缘的留白段）。
状态栏小部件的轨道图（`src/tui/viz/railway.ts` → 宿主 chat 内的 widget）**不走**这个出口：
它躺在宿主聊天区里，必须跟聊天底色一致。

**R2 — 底色 key 只能取 `ThemeBg` 的 7 个之一，当前 = `toolPendingBg`。**
`ThemeBg = selectedBg | searchMatchBg | userMessageBg | customMessageBg | toolPendingBg |
toolSuccessBg | toolErrorBg`（`@earendil-works/pi-coding-agent` 的 `theme.d.ts`）。

选 `toolPendingBg` 的理由：7 个里只有它是**中性面**而不是带色号的面板 ——
dark 主题 `okhsl(229 5% 24%)`、light 主题 `okhsl(248 3% 91%)`、`system` 主题里属于
`neutral` family，没有色相身份，这正是「页面底」该有的样子。其余 6 个都带明确的颜色叙事，
铺满整页会串色：`selectedBg` / `userMessageBg` 是两个内置主题里的 `blueBg`（蓝），
`customMessageBg` 紫，`searchMatchBg` 黄（高亮语义），`toolSuccessBg` / `toolErrorBg` 绿 / 红。
取舍是**亮度**而不是色相：`toolPendingBg` 比主题里仅用于导出（`export`，非可渲染色）的
`pageBg`（dark `okhsl(262 14% 16%)`）亮约 8 个点。上游没有把 `pageBg` 暴露成可渲染 token，
所以只能在 `ThemeBg` 里选一个最接近的中性面。

**R3 — `theme.bg` 只能通过可选调用使用。**
`VizTheme.bg?`（`src/tui/viz/palette.ts`）是可选方法，测试里的假主题大多只有 `fg`。
写法固定为 `theme.bg?.(LEGION_PAGE_BG, line) ?? line`。
推论：**没有 bg 的主题，输出必须逐字节不变**（既有断言依赖这一点）。

**R4 — 三条硬红线（issue 已实测，违反会打死既有用例）。**

| 禁止 | 会打死的用例 |
|---|---|
| 用 `inverse` 冒充底色 | `test/unit/legion-viz.test.ts` 里「portrait tiny 不得出现 `\x1b[7m`」 |
| 无 bg 时无条件追加行尾 escape | `test/unit/legion-viz.test.ts` 里 `plainTheme` 的整行形状断言（`/^[─┬\s\-−0-9a-z·./]+$/`） |
| 改变行宽 | 一批 `visibleWidth(line) === width` 断言 |

底色用零宽 escape 包**已有**内容，因此 `visibleWidth` 不变；不要往里塞填充字符。

**R5 — `system` 主题下仍然是终端默认底色（本仓不可解，不是回归）。**
`system` 主题在「终端没上报配色」档（`generateSystemThemeColors` 走 `!background` 分支 →
`indexedColors()`）里，把 `PANELS` 全部 7 个 bg key 一律赋 `""`；`Theme.bg(key, text)`
于是渲染成 `\x1b[49m<text>\x1b[49m`，也就是显式要求终端默认背景。
实测（`new Theme(colors, colors, "ansi16")`）：

```
selectedBg      "\u001b[49mX\u001b[49m"
searchMatchBg   "\u001b[49mX\u001b[49m"
userMessageBg   "\u001b[49mX\u001b[49m"
customMessageBg "\u001b[49mX\u001b[49m"
toolPendingBg   "\u001b[49mX\u001b[49m"
toolSuccessBg   "\u001b[49mX\u001b[49m"
toolErrorBg     "\u001b[49mX\u001b[49m"
```

⇒ 该档位下本修法正确但**无效**（黑竖带消失不了），因为上游缺一个「页面底色」token。
要根治得等上游把 `export` 里的 `pageBg`（dark `okhsl(262 14% 16%)`、light
`okhsl(17 3% 94%)`）暴露成可渲染 token；在那之前本仓只能做到「有真实 bg token 的主题不黑」。

**R6 — `theme.bg(key)` 只认那 7 个 key。**
传别的（例如 `theme.bg("pageBg", …)`）在运行期抛 `Unknown theme color: pageBg`
（`Theme.tokenAnsi()`）。**不要**碰 `ThemeBg` 之外的名字。

---

## §3 验收

保留 ANSI 的合成用例（新增于 `test/unit/legion-live-overlay.test.ts`，harness 在
`test/helpers/modal-composite.ts` 的 `assertOverlayGutterInheritsBase`）：

> `/legion` 视图作 base（全屏 overlay，生产几何）+ 75% 居中浮层，逐帧行断言
> 「**浮层左右留白段的 strip 结果等于 base 同列文本，且第一个格子的背景 SGR 等于 base 同列背景 SGR**」。

该用例必须**在去掉修复后变红**：去掉 `paintPageFloor` 后所有段的 bg 快照都是 `""`
（`rowBg` / `baseRightBg` / `frameRightBg` 全空），而文本仍逐字符相同 ——
后者正是「不能只用 `wipedRows`」的证据。

断言里必须显式要求 **非空**（`baseRightBg === PAGE_FLOOR_ANSI`），否则
「`"" === ""`」会让修复前的代码通过；只断言两边相等是无效断言。

---

## §4 不做（边界）

- **不改宿主合成器**（`node_modules/@earendil-works/pi-tui`），不改浮层几何。
- **不给浮层自己画遮罩/底色**：浮层 rect 内的每个 cell 都被合成器替换，遮罩必然不透明
  （#193 已裁决）。
- **不改状态栏 widget 的轨道图**：见 R1。
- **不为 `system` 主题档位造假底色**（例如硬编码灰）：那会把「跟随 `/theme`」这条既有
  不变量换成一条猜出来的颜色，且浅色终端下会瞎。
