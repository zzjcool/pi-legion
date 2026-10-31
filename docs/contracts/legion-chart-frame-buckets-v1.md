# /legion 图表分桶契约 v1（一帧一次分桶）

> 状态：**生效**，随 #346 落地。这是一条**记录性**契约：把「一帧只分桶一次」「分桶只算本帧看得见的
> series」这两条写死，防止以后有人在 `computeStats`/`drawChart` 里各算一遍，或者把历史 series 的账
> 重新摊到每帧上。
> 冲突时**停下报告**，不得自行重新解释本契约。
> 关联：#346（每帧两遍分桶 + 历史税）、#308（页面底色，不受本契约影响）。

---

## §1 问题陈述

`/legion` 的 tok/s 图表每帧把**同一份** buckets 算两遍，且成本随「记录过的 series 数」线性增长：

1. `drawChart` 先 `sampler.buckets(from, to, plotW)`（`src/tui/viz/panels.ts`）给图体上色，
   紧接着 `computeStats(data, plotW)` 内部又 `chartWindow(data)` + `sampler.buckets(from, to, plotW)`——
   参数与结果**完全相同**，没有任何记忆化。200 节点下这是 ≈1.2ms + ≈0.6MB 垃圾 / 帧。
2. `RateSampler.buckets()` 对 `this.series` 里**每一个曾经记录过**的 series 分桶
   （`src/tui/viz/rate.ts`），而 `series` 全文件没有任何删除点：结束的 child、离开子树的节点
   每帧照样被白算。
3. 每个 series 还各自新建一条长度 `plotW` 的临时数组再累加进 role 行——纯垃圾。

---

## §2 约定

**R1 — 一帧只能有一次分桶。**
唯一入口是 `panels.ts` 的 `chartBuckets(data, count, window?)`；`drawChart` 调一次，
把结果作为第三个参数传给 `computeStats(data, buckets, series?)`。
`computeStats` **不得**在收到 `series` 时重新分桶；不传时（老签名，测试/一次性消费者）
退回 `chartBuckets` 自己算一次，语义与三参数版逐字节一致。
防回归用例：`test/unit/legion-viz.test.ts` 的「a rendered frame buckets the sampler exactly once」
（包一层计数 `sampler.buckets`，断言整帧 == 1）与「computeStats reuses the frame's buckets」。

**R2 — 分桶只算本帧画得到的 series。**
`buckets(from, to, count, { onlyNodeIds })` 的 `onlyNodeIds` 来自
`visibleRateNodeIds(data.nodes)`：**保留** settled/retired 行（图表仍要画它们窗口内的历史），
**排除** root 与不在这帧里的节点。不可见 series 的**原始采样一个字节都不删**
（`prune` 语义、`DEFAULT_RETENTION_MS` / `MAX_SAMPLES_PER_NODE` 都不变），只是不参与本帧计算。
所以 `buckets()` 的复杂度是 O(可见 series × plotW)，不是 O(历史 series 数 × plotW)。

**R3 — 图表的 `avg` 跟同一份可见集走。**
`ChartStats.avg = sampler.totalRate(to, to−from, visibleRateNodeIds(data.nodes))`。
理由不是省时间，而是正确性：不可见的 series 会把 avg 抬起来（实测 40 个已结束的 ghost
把 300 tok/s 抬到 1.5k tok/s），而它们在图上一个像素都没有。
防回归用例：「dropping a node from the frame does not repaint the chart」——
同一帧 + 46 个 ghost series 必须与 6 个 series 渲染出**逐字节相同**的 canvas。

**R4 — 可证明为零的 series 直接跳过（不是近似）。**
一个 series 若最后一个采样点 ≤ `首桶边界 − 窗口`，则 `interpolate` 在每桶两端都夹到同一个值、
每桶 Δ 恒为 0。跳过它与算完再加 0 逐字节相同（用例：「a series that stopped before the window edge
is skipped without changing a bucket」把快路径与 `nodeBuckets` 参照值逐桶比对）。

**R5 — `buckets()` 不再分配 per-series 临时数组。**
直接累加进 role 行；`nodeBuckets()`（选中 agent 的亮线）保留，因为它是单 series 的公开入口。

**R6 — 不动的边界。**
`RateSampler` 的采样语义与保留策略（`RATE_WINDOW_MS`、`MIN_RATE_GENERATION_MS`、
`DEFAULT_RETENTION_MS`、`MAX_SAMPLES_PER_NODE`）、图表外观/布局/`plotW`/`plotH`、
`paintPageFloor`（#308）、`drawGalaxy` 的呈现，全部不变；`/legion` 的可见输出除 R3 的
avg 归属外逐字节不变（既有快照用例守）。

---

## §3 实测（120×40 / 200 节点，真 `Theme(dark)`，50 帧 × 3 轮）

基准机与 issue 不同，**比值**是可迁移的（同机、同脚本、同 flag 前后各跑两遍）。
分配用「3 次 gc + 20ms 落定后取单次调用 heapUsed 差值」，轮转取中位；两遍复现误差 <0.1%。

| 指标 | 改前 | 改后 | 变化 |
|---|---|---|---|
| 帧 median | 6.68 / 6.32 / 6.51 ms | 4.37 / 4.61 / 4.28 ms | ≈−32% |
| 帧 p95 | 9.12 / 9.08 / 6.65 ms | 5.04 / 4.76 / 4.62 ms | ≈−40% |
| `drawChart` | 2.62 / 2.70 ms | 0.59 / 0.59 ms | ≈−77% |
| `buckets()` | 1.24 ms | 0.47 ms | ≈−62% |
| 帧分配 | 4214 KB | 3306 KB | ≈−22% |
| `drawChart` 分配 | 1432 KB | 530 KB | ≈−63% |
| `buckets()` 分配 | 600 KB | 226 KB | ≈−62% |
| `computeStats()` 分配 | 644 KB | 282 KB | ≈−56% |

**未达标的部分（如实记录）**：任务卡的「分配减半（≤2MB）」在本契约的改动范围内**做不到**——
帧分配里 `drawGalaxy` 的 `Canvas.set` 每次写入都新建 `Cell` 对象（`src/tui/viz/canvas.ts`），
是剩下的最大一块，而 `canvas.ts` 不在本契约授权的文件里。见 §4。

---

## §4 后续（不在本契约内）

- `Canvas.set()` 复用已有 `Cell` 而不新建：输出逐字节不变，预期砍掉渲染层大部分对象 churn
  （`drawGalaxy` 每帧对 4800 格的 buffer 写入约 5 万次）。属于 `canvas.ts` 的改动，需单独授权。
- `drawGalaxy` 的布局/连线本身（时间占比第二名），见 issue #346 的「明确不做」。
