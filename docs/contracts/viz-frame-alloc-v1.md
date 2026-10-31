# viz 帧分配契约 v1（#364）

- 状态：**生效**，随 #364 落地。
- 上游：`docs/contracts/legion-chart-frame-buckets-v1.md`（R1–R6 仍然有效）、
  `docs/contracts/legion-page-floor-v1.md`、`docs/contracts/legion-main-screen-mount-v1.md`。
- 冲突时停下报告，不得自行重新解释。

## §0 现状与目标

`#362` 修掉了 `Canvas.set()` 的每写分配（52.4/128.0 B → 0.03/0.002 B per write），
整帧分配降到 120×40/live **2551.8 KB**、200×60/live **4018.2 KB**（chart 契约 §3.4）。
耗时目标已达成（3.87 / 5.73 ms median，5.47 / 7.44 ms p95）。

本契约只做**分配**，目标：

| 形状（200 节点，真 `Theme(dark)`） | 现状 | 目标 |
|---|---|---|
| 120×40 / live 整帧分配 | 2551.8 KB | ≤ **2048 KB** |
| 200×60 / live 整帧分配 | 4018.2 KB | ≤ **2048 KB** |
| 120×40 / live median / p95 | 3.87 / 5.47 ms | 不回归（≤4.0 / ≤7.0 ms） |
| 200×60 / live median / p95 | 5.73 / 7.44 ms | 不回归（≤7.0 / ≤10.0 ms） |

若某形状实测无法达标，**如实记录差额与残余分量**（照 #346 的做法），不得改测量方法凑数。

## §1 不变量（必须全绿，逐条有守卫）

| 编号 | 不变量 | 守卫 |
|---|---|---|
| **I1** | `/legion` 可见输出**逐字节不变**：对 120×40 / 200×60 / 80×24 / 46×60 四个形状，`toPlain()` 与 `toLines(ansiTheme)` 的 sha256 与本契约落地前一致 | 新增内联 golden 用例（见 §4.2） |
| **I2** | 图表外观 / 布局 / `plotW` / `plotH` 一律不动 | chart 契约 R6 |
| **I3** | `paintPageFloor` 函数体不动（`view.ts:96`） | page-floor v1 R1/R3/R4；main-screen-mount R5 |
| **I4** | `drawGalaxy` 的**呈现**不变：同一 `data`/`selectedId`/几何下，画布逐格 `(ch, color, bold, inverse)` 相同 | I1 + 新增逐格比对用例 |
| **I5** | `Canvas` 活视图语义不变：`get()`/`cells` 返回的对象仍是下一次 `set` 就地改写的同一对象；构造后恰好 `W×H` 个 cell | `test/unit/legion-viz.test.ts:2462-2536` **不改** |
| **I6** | 滚动 `chartWindow`（尾部 60s）**不在本契约范围内**（需单独授权） | chart 契约 §4 |
| **I7** | 任何跨帧可变状态必须：**(a)** 有可判定的失效键；**(b)** 有一条用例证明「输入变了，结果跟着变」。无失效证明的缓存一律不许进 | 见 §4.3 |

## §2 允许的手段

- **A1 每帧 reset 代替每帧 allocate**：`px` 网格、`Canvas` cells、`Map`/`Set` 复用（`clear()` 而非 `new`）。
- **A2 模块级 memo，键必须是稳定标量**：role 名、node status、`roleColor`/`nodeToken` 的拼好字符串、
  braille 码位 `0..255`、`for (const dy of [0,-1,1,-2,2])` 这类字面量数组。
- **A3 已解析的 role 色传进 `renderRow`**，不再为每个 role 色格 `{...cell, color}` 复制
  （`canvas.ts:79`；实测 1123/1865 个 role 格 ×72/70 B）。
- **A4 帧内共享中间结果**：`childrenMap` 每帧只建一次并传给 `dfsOrder`（现在是 `panels.ts:102` 与
  `:250`→`:56` 两份，每帧 2 份 Map + 数组）。
- **A5 `Canvas` 复用**：可新增 `reset()`，但只允许 `view.ts` 的生产 render 路径使用；
  `new Canvas(W,H)` 的语义与成本不变。

## §3 禁止与陷阱（逐条来自侦察，违反即视为方案错误）

| 编号 | 陷阱 | 证据 |
|---|---|---|
| **T1** | `px` 网格复用时**必须全格清零 `m` 和 `z`**。`m` 用 `\|=` 只加位；`z` 是写入门槛（`if (z >= cell.z)`），不清零时上一帧的高 `z` 会拒掉本帧低优先级写入，而 `m != 0` 时 `col` 必被读 ⇒ **颜色串帧** | `panels.ts:81`（唯一初始化点）、`:87`、`:88-91`、`:204` |
| **T2** | **禁止跨帧缓存 `childrenMap` / `pos` / `rel` / `radii` / `leafMemo`**。`data.nodes` 与每个 `VizNode` 对象**每帧都是新的**（`status.ts:925` → `model.ts:93`），缓存会保留上一帧对象；而 `node === center` / `node === virtualRoot` 的身份比较遍布绘制路径，新旧世代混用会让中心球退化成普通节点 | `panels.ts:107`、`:156`、`:171`、`:211`、`:216`、`:230`、`:239`；`status.ts:923-925`；`model.ts:93` |
| **T3** | `leafMemo` 的 key 是节点 **id 字符串**（不是对象），而结构会随 subagent 派生变化 ⇒ 只能**帧内**用，不能跨帧 | `panels.ts:110`、`:112`、`:117` |
| **T4** | `rnd()` 种子每帧重置为 `99`：任何「跳过某些 `dot()`」的优化都会让后续随机序列整体错位、星尘/闪烁图案变化 ⇒ 不许用跳过绘制省分配 | `panels.ts:93-95`、`:177-188` |
| **T5** | `roles()` + `resolveRolePalette` 的缓存键必须含**(theme, 该帧 role 集合)**；`Canvas` 复用时 role 集合必须随 `reset()` 清空（少了 role 会直接改输出） | `canvas.ts:68-74`、`:76`；`palette.ts:153-171` |
| **T6** | `renderRow` 只在 `color && text.trim().length > 0` 时套 `theme.fg` ⇒ 行尾裸空格行为必须保留（page floor 全靠它） | `canvas.ts:161`；page-floor v1 §16/§33 |
| **T7** | `Canvas.set()` 不得再引入分配 | #362 + `test/unit/legion-viz.test.ts:2485-2500` |

## §4 验收

### 4.1 可复现基准（进仓）

新增 `bench/perf-core/10-legion-frame-alloc.ts`：

```bash
node --expose-gc --experimental-strip-types bench/perf-core/10-legion-frame-alloc.ts
```

- 单进程、`--expose-gc`、GC 落定后取「单帧 `heapUsed` 差值」**20 次中位**；
  时间取 5 轮 × 50 帧 median / p95（nearest-rank）。
- 页面主题 = 真 `Theme(dark)`（按绝对路径深导入
  `node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js` 的 `getThemeByName`；
  包入口不导出它，这是既有 `/tmp/perf-tui/lib.ts:113-117` 的做法）。
- 数据 = 200 节点真 `VizNode[]` + 预热 `RateSampler`（61 采样 @2s），`live` 与 `settled` 两种形状。
- 输出每形状 `frameAllocKB` / `median` / `p95` / `plainDigest` / `ansiDigest` + 分量归因
  （`drawGalaxy` / `toLines` / `drawChart` / `new Canvas` / 其余）。
- 门禁：`120x40 <= 2048 KB`、`200x60 <= 2048 KB`、median/p95 ≤ §0 上限、两个 digest 命中 golden 文件；
  miss → `process.exitCode = 1`（照 `bench/perf-core/09-legion-mount.ts:358-406` 的 `gates` 形态）。

### 4.2 可见输出 golden（进仓，补上 recon 发现的空档）

当前仓里**没有**任何 golden 快照——`test/unit/legion-viz.test.ts:627` / `:2398` 都是
「同一份代码渲染两次再比」，两侧同时漂移抓不住。本契约要求补一条内联用例：

- 对 120×40 / 200×60 / 80×24 / 46×60 四个形状，断言 `canvas.toPlain()` 与
  `canvas.toLines(ansiTheme)` 的 sha256 等于内联 golden（fake `ansiTheme`，不依赖宿主包，稳定）；
- golden 值 = **本契约落地前**（父提交）的渲染结果，逐字节；
- 这条用例同时是 §1-I1 的守卫与 bench digest 的锚。

### 4.3 缓存失效用例

对每一个新增的跨帧缓存（A5 `Canvas` 复用、A2 的 module memo、A3 的 palette 缓存）各写一条用例，
证明「输入变了结果跟着变」：几何变化后 `px` 网格重建、`Canvas` 复用后上一帧残留的
`ch/color/bold/inverse` 不泄漏、role 集合变化后调色板更新。参照 #346 的反例形态
（`test/unit/legion-viz.test.ts:2296-2298`：「no cache, no accumulation」）。

### 4.4 不回归

`npm run typecheck` / `npm test` / `npm run test:integration` 全绿；
`node --experimental-strip-types bench/perf-core/09-legion-mount.ts` 仍 `ok: true`。

## §5 交付顺序（按契约写死的优先级，实测可微调但必须写进报告）

1. **S1 `drawGalaxy` 内部零分配化**（最大项，1.16–1.23 MB / 2.2 ms）：
   `px` reset 复用（守 T1）、`leaves()` 迭代化（现在每个调用点一个 `guard` Set：`panels.ts:111`，
   一帧约 2N−1 个）、`childrenMap` 同帧共享（A4）、`roleColor`/`nodeToken` memo（A2）、
   braille 256 项查表（替代每格 `String.fromCharCode`，`panels.ts:204`）、字面量数组提升到模块级。
2. **S2 `toLines` / `renderRow`**：palette 传入 + 去掉 `{...cell, color}` + `roles()` 不再全网格扫描 +
   palette 缓存（守 T5、T6）。
3. **S3 `Canvas` 复用**（`reset()` + `view.ts:104` 生产路径；守 I5、T7）。
4. **S4 `drawChart` 临时对象**：`bands`（`panels.ts:373-395`）、`computeStats` 的
   `byRole` 投影（`:335`）、`"─".repeat(plotW)`（`:422`）。

每步后跑同一 bench：任一步让 §4.2 的 digest 变化 → 回退该步，不得为了数字改输出。
