# GalaxyScratch 契约 v1（帧内复用容器的局部可推理化）

- 状态：生效，随实现 PR 落地。
- 上游：`docs/contracts/viz-frame-alloc-v1.md`（#364，**冻结数字与不变量以它为准**）。
- 本契约只约束**结构**，不改变任何可见输出与分配目标。

## §0 目标

`src/tui/viz/panels.ts` 现有 26 个模块级可变容器、14 处分散清零。正确性有 golden 守着，但
**读者无法局部推理**：要判断「这一帧的脏状态从哪开始是干净的」，必须通读整个函数。
本契约把它收成**一个** `GalaxyScratch` 实例 + **一次** `begin()`，并给不可重入加闸门。

零行为变化：golden 逐字节不变、bench 10 的 23 条门禁不变、整帧分配不回退。

## §1 单一容器

- `panels.ts` 内新增 `class GalaxyScratch`（可以放在 `panels.ts` 或 `src/tui/viz/scratch.ts`，
  但**必须只有一处**定义、**模块级只有一个实例**）。
- 26 个可变容器全部成为它的字段：`pxWidth/pxHeight/pxGrid`、19 个 `galaxy*`、4 个 `CHART_*`。
- `begin(rect)` 是**唯一**的清零入口。它必须：
  1. 无条件完成全部重置（`Map.clear()`、数组 `length = 0`、计数 `= 0`）；
     **尺寸键不来自 panel rect**（实现期修订）：galaxy 与 chart 的 rect 每帧互不相等，拿 rect 当键会让两次
     `begin` 各重建一次网格（实测一次重建 81.8 / 266.5 KB，即每帧多分配一次）。网格重建按「已挂载网格自身的
     `w`/`h`」判定，只在 resize 时发生；`rect` 参数保留是为了调用点一致，不参与尺寸判定。
  2. **不分配新对象**（不许 `new Map()` / `[]` 代替 clear；容器身份跨帧保持——这是 #364 分配目标的前提）；
  3. 幂等（对同一 rect 连续调用两次结果相同）。
- 清零顺序不影响结果；但 `begin` 之后、任何读取之前，容器状态必须与「首次构造」等价。

## §2 顺序

`drawGalaxy` 的第一条**副作用**是 `scratch.begin(r)`，**早于**任何提前返回（今天 `if (!center) return`
出现在首次清零之前，读起来像漏清）。`drawChart` 同理。

实现期修订：**闸门检查先于 `begin`**。若先 `begin` 再判重入，一次被拒绝的嵌套调用会把外层正在画的帧清空——
拒绝必须是无副作用的。顺序因此是：查闸门 → 置位 → `begin` → body → `finally` 复位。

## §3 不可重入闸门

- `drawGalaxy` / `drawChart` 入口置 `painting` 标志，`finally` 复位；重入即抛
  `viz: drawGalaxy is not reentrant`（或对应函数名）。
- 闸门**始终启用**（一个布尔读写，不进热路径分配）。它保护的是：这些容器是模块级单例，
  嵌套渲染会互相踩脏数据，而今天这个事实只写在注释里。

## §4 Canvas 约束

- `Canvas` 的 `cells` / `get()` 注释必须写明：**改 `color` 只能走 `set()`**，否则 `roleCounts`
  会留下幽灵 role（就地改 `color` 的现有调用点是安全的，但约束要被写下来）。
- `Canvas.reset()` 仍覆盖 `ch/color/bold/inverse/m/z` 六个字段（#364 用例已钉）。

## §5 不变量

| 编号 | 不变量 | 守卫 |
|---|---|---|
| **I1** | `viz-frame-alloc-v1.md` 的 I1–I7、T1–T7、§5 S1–S4 全部继续成立 | 该契约原文 |
| **I2** | 可见输出逐字节不变：4 形状 plain/ANSI digest + 逐格 `(ch,color,bold,inverse)` sha256 | `test/unit/legion-viz.test.ts` 的 #364 用例群，**不改** |
| **I3** | 整帧分配不回退：120×40 ≤ 1042.5 KB、200×60 ≤ 1319.0 KB（+ 噪声） | `bench/perf-core/10-legion-frame-alloc.ts` 23/23 |
| **I4** | 不新增模块级可变状态（除 `GalaxyScratch` 单例与 `painting` 布尔） | 代码审查 |
| **I5** | `paintPageFloor`（`view.ts:96`）、layout / `plotW` / `plotH` / `chartWindow` 窗口长度 / `RateSampler` 保留策略一律不动 | #364 契约 §5 |

## §6 验收

1. `npm run typecheck` / `npm test` / `npm run test:integration` 全绿。
2. `node --expose-gc --experimental-strip-types bench/perf-core/10-legion-frame-alloc.ts` → `ok: true`，
   23/23 门禁，两个尺寸的 `frameAllocKB` 不高于基线。
3. 两条新用例且能红（变异自证）：
   - 删掉 `begin()` 里**输出承重**的重置（实测会红的有：逐格 `z`、`leafMemo.clear()`、`depthGuard`/`layGuard`、
     `occCount`、`roles`、`statusItems`、`all`、`running`、`candidates`、`chartRoles`）→ 既有 px 残留 / golden
     用例变红。⚠️ `posCount = 0` 不在此列：`g.pos` 每帧被 `lay()` 重写、读侧只按本帧索引取值，删掉不会红；
     但它是**内存卫生**的守卫——`posCount` 同时是 `posX/posY` 的长度，删掉会让它们跨帧无界增长，不属可删项；
   - 去掉重入闸门 → 新的重入用例变红（构造一次嵌套调用）。
4. 机械改动清单：`galaxyXxx` → `g.xxx` 的每一处引用都在 `panels.ts` 内；对外导出签名不变
   （`drawGalaxy` / `drawChart` / `chartWindow` / `computeStats` / `childrenMap` / `dfsOrder` / `hypot2`）。

## §7 非目标

- 不改渲染逻辑、不调整布局、不优化算法。
- 不动 `view.ts` / `canvas.ts` 的行为（只加注释）。
- 不引入新依赖、不做模块拆分（除允许把 `GalaxyScratch` 放进独立文件）。
