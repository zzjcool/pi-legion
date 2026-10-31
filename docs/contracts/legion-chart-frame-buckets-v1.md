# /legion 图表分桶契约 v1（一帧一次分桶）

> 状态：**生效**，随 #346 落地。这是一条**记录性**契约：把「一帧只分桶一次」「分桶只算本帧
> 需要画的 series」这两条写死，防止以后有人在 `computeStats`/`drawChart` 里各算一遍，或者把
> 已经停止产出的 series 的账重新摊到每帧上。
> 冲突时**停下报告**，不得自行重新解释本契约。
> 关联：#346（每帧两遍分桶 + 历史税）、#308（页面底色，不受本契约影响）。
> **修订 r2（review 返工）**：R2 的复杂度声明按实现重写（r1 说「结束的 child 不再每帧收税」，
> 那是**错的**，见 R2 的「残余成本」）；R4 的「逐字节相同」改成「每桶数值相同 + 整列 role 可能
> 从 `byRole` 消失，画面不变」；§3 补「未达标」两行与本轮复测；§4 补 `Canvas.set` 的隔离数字。
> **修订 r3（#362 落地）**：§4 第 1 项（`Canvas.set` 每次写分配一个 `Cell`）已修掉，§3.4 记录前后数字；§4 第 3 项（滚动 `chartWindow`）本轮**评估后不采纳**，理由与数字见 §4。本契约的 R1–R6 语义**没有变化**（cell 复用不涉及分桶、采样、可见输出）。

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

**R2 — 分桶只算「本帧看得到且窗口内真的变过」的 series，复杂度如实声明。**

`buckets(from, to, count, { onlyNodeIds })` 的两层过滤：

1. **可见性**：`onlyNodeIds` 来自 `visibleRateNodeIds(data.nodes)`——**保留** settled/retired 行
   （图表仍要画它们窗口内的历史），**排除** root 与不在这帧里的节点。不可见 series 的
   **原始采样一个字节都不删**（`prune` 语义、`DEFAULT_RETENTION_MS` / `MAX_SAMPLES_PER_NODE` 都不变）。
2. **可证明为零**（见 R4）：`series.changedAt <= times[0] − w` 的 series 直接跳过。
   `changedAt` 是 `record()` 里**采样值真的变化**的时刻更新、**flat-run collapse 不更新**的时间戳。

**复杂度（如实）**：一次 pass 是 **O(k × plotW)**，其中 `k` = 可见 series 中
**`changedAt` 落在窗口内（含一个桶窗口的余量）的那些**。不是 O(历史 series 数)，也**不是** 0。

**残余成本（r1 的错话，这里改正）**：`chartWindow()` 的 `from = min(最早 agent 的 startedAt, to−60s)`，
长跑时 `from` 就是**整轮 run 的起点**，因此「窗口内真的变过」对**每个曾经产出过的 series** 都成立——
它在窗口内的历史是要画的，跳过就会把那几列清零。所以：

| 窗口形状 | walked（200 series / 190 settled） |
|---|---|
| 整轮 run（`chartWindow` 当前形状，`from` = run 起点） | **200**（一个也跳不掉，且**必须**如此） |
| 尾部 60s（`from = to − 60s`，reviewer 的测量形状） | **10**（跳过 190） |

结论：**「结束的 child 不再每帧收税」这句话不成立，本契约撤回它。** 本契约保证的是：
「`changedAt` 早于窗口起点一个桶窗口以上的 series 零成本」，以及「一次 pass、无 per-series 临时数组」。
要让「结束的 child 真的不再进 pass」，得改 `chartWindow` 的 x-domain（滚动窗口），那是**另一个决定**
（可见输出的语义变化），不在本契约授权范围内。

防回归用例：「a frame walks the series that CHANGED inside its window, not every settled row」——
190 个 settled 行 + 10 个活跃行，尾部 60s 窗口下 `sampler.lastPass.walked === 10` /
`skipped === 190`，且**同一帧的列值与逐个 series 的参照值（`nodeBuckets`，从不跳过）完全相等**；
同时钉住残余：整轮窗口下 `walked === 200`（把「窗口内的历史必须画」变成断言，防止有人用清零换速度）。

**R3 — 图表的 `avg` 跟同一份可见集走。**
`ChartStats.avg = sampler.totalRate(to, to−from, visibleRateNodeIds(data.nodes))`。
理由不是省时间，而是正确性：不可见的 series 会把 avg 抬起来（实测 40 个已结束的 ghost
把 300 tok/s 抬到 1.5k tok/s），而它们在图上一个像素都没有。
防回归用例：「dropping a node from the frame does not repaint the chart」——
同一帧 + 46 个 ghost series 必须与 6 个 series 渲染出**逐字节相同**的 canvas。

**R4 — 可证明为零的 series 直接跳过（不是近似）。**
一个 series 若 `changedAt <= 首桶边界 − 窗口`，则它在此之后所有采样值都等于 `changedAt` 处的值
（flat-run collapse 只挪时间戳、不改值），`interpolate` 在每桶两端都夹到同一个值，每桶 Δ 恒为 0。
跳过它 **每个桶的数值都与算完再加 0 相同**（用例把快路径与 `nodeBuckets` 参照值逐桶比对）。

唯一允许的差异是**结构**而非数值：某个 role 的所有 series 都被跳过时，该 role 的整列不会出现在
返回的 `RateSeries.byRole` 里（`undefined` 视作 0）。图体的 role 列表来自 `computeStats().byRole`
（即 `data.nodes`），且值为 0 的列本来就不画，所以**画面逐字节不变**。

**R5 — `buckets()` 不再分配 per-series 临时数组。**
直接累加进 role 行；`nodeBuckets()`（选中 agent 的亮线）保留，因为它是单 series 的公开入口。

**R6 — 不动的边界。**
`RateSampler` 的采样语义与保留策略（`RATE_WINDOW_MS`、`MIN_RATE_GENERATION_MS`、
`DEFAULT_RETENTION_MS`、`MAX_SAMPLES_PER_NODE`）、图表外观/布局/`plotW`/`plotH`、
`paintPageFloor`（#308）、`drawGalaxy` 的呈现，全部不变；`/legion` 的可见输出除 R3 的
avg 归属外逐字节不变（既有快照用例守）。

新增的可观测面只有一处：`RateSampler.lastPass = { walked, skipped }`（上一次 `buckets()` 的
计数，纯诊断/测试探针，采样逻辑不读它）。

---

## §3 实测（120×40 / 200 节点，真 `Theme(dark)`）

### 3.1 上一轮（r1）记录：master vs 分支

基准机与 issue 不同，**比值**是可迁移的（同机、同脚本、同 flag 前后各跑两遍）。
分配用「3 次 gc + 落定后取单次调用 heapUsed 差值」，轮转取中位；两遍复现误差 <0.1%。

| 指标 | 改前（master） | 改后（分支） | 变化 |
|---|---|---|---|
| 帧 median | 6.68 / 6.32 / 6.51 ms | 4.37 / 4.61 / 4.28 ms | ≈−32% |
| 帧 p95 | 9.12 / 9.08 / 6.65 ms | 5.04 / 4.76 / 4.62 ms | ≈−40% |
| `drawChart` | 2.62 / 2.70 ms | 0.59 / 0.59 ms | ≈−77% |
| `buckets()` | 1.24 ms | 0.47 ms | ≈−62% |
| 帧分配 | 4214 KB | 3306 KB | ≈−22% |
| `drawChart` 分配 | 1432 KB | 530 KB | ≈−63% |
| `buckets()` 分配 | 600 KB | 226 KB | ≈−62% |
| `computeStats()` 分配 | 644 KB | 282 KB | ≈−56% |

### 3.2 本轮复测（同一脚本跑三侧，各 3 次 run 取中位）

同一台机器上三次交叉跑（master / 上一轮提交 b80a9ab / 本轮 HEAD），`live` = 200 series 全部
持续产出（最坏情况），`settled` = 190 个在 120s 停下 + 10 个跑到 400s（`data.nodes` 里 200 行全在，
即生产的子树形状）。跨 run 范围见括号——本机负载高，绝对值与 3.1 有偏差，**只有同一次 run 内的
前后比值可比**。

| 指标（120×40/200） | master | b80a9ab（上一轮） | 本轮 HEAD |
|---|---|---|---|
| 帧 median，live | 9.95（8.56–13.19）ms | 4.33（4.30–10.10）ms | 4.56（4.37–6.30）ms |
| 帧 median，settled | 5.03（4.76–8.71）ms | 3.15（2.78–5.33）ms | 3.19（3.16–4.71）ms |
| `drawChart`，live | 11.00 ms | 2.98 ms | 2.95 ms |
| `buckets()` 整轮窗口，settled | 2.29 ms | 1.17 ms | 1.16 ms |
| `buckets()` 尾部 60s，settled | 1.61 ms | 0.89 ms | **0.10 ms** |
| 帧分配，live | 8116 KB | 7135 KB | 7259 KB |
| `buckets()` 分配，live | 1115 KB | 347 KB | 347 KB |

| 指标（200×60/200） | master | b80a9ab | 本轮 HEAD |
|---|---|---|---|
| 帧 median，live | 10.05 ms | 9.36 ms | 6.42 ms |
| 帧 median，settled | 7.36 ms | 5.38 ms | 7.62 ms（范围 4.58–8.36） |
| 帧分配，settled | 5539 KB | 4218 KB | 4244 KB |
| `buckets()` 尾部 60s，settled | 2.77 ms | 1.05 ms | **0.22 ms** |

本轮相对上一轮**不改**整轮窗口的每帧成本（walked 都是 200）——本轮改的是
「可证明为零时才跳」这一条的**正确性**，以及 #349 的驻留/交付。尾部 60s 形状下
walked 200 → 10（跳过 190），`buckets()` 0.89 → 0.10ms / 1.05 → 0.22ms，即 R2 的那条快路径确实成立。

### 3.3 未达标项（如实记录）

1. **`200×60` / 200 节点 median 实测 7.30–7.34 ms**（上一轮，issue #346 的目标是 ≤7.0 ms）；
   上一轮**没有测 p95**。本轮补测 p95：live 9.17 ms / settled 14.72 ms（本轮 HEAD，本机负载高，
   范围 7.52–31.38 ms）——**p95 也未达标**，且本机噪声大，这两个数只能当量级看。
2. **帧中位 4.28–4.61 ms**（120×40/200；任务卡目标是 ≤4 ms——**未达标**；issue #346 写的是
   ≤5.0 ms——达标）。
3. **分配的「减半（≤2MB）」在本契约改动范围内做不到**：`200×60/200` 帧分配 4.2MB（本契约改前
   5.5MB），`120×40/200` 7.1–7.3MB（改前 8.1MB）。剩下的大块不在 `panels.ts`/`rate.ts`，
   见 §4。

---

### 3.4 #362 之后复测（120×40 / 200×60，200 节点，真 `Theme(dark)`）

同一脚本（`/tmp` 一次性基准，不进仓）、单进程、`--expose-gc`、GC 落定后取「单帧 heapUsed 差值」
的中位（20 次）；时间取 5 轮 × 50 帧、前后交替各 1250 样本。**只有同一次 run 内的前后比值可比。**

| 指标 | #362 前 | #362 后 | 变化 |
|---|---|---|---|
| `Canvas.set` 分配，120×40 | 52.4 B/次 | **0.03 B/次** | ≈−100% |
| `Canvas.set` 分配，200×60 | 128.0 B/次 | **0.002 B/次** | ≈−100% |
| `new Canvas` 预填，120×40 / 200×60 | 269.3 / 616.1 KB | **190.0 / 472.4 KB** | −30% / −23% |
| 整帧分配，120×40 live | 2839.9 KB | **2551.8 KB** | −10% |
| 整帧分配，200×60 live | 4556.8 KB | **4018.2 KB** | −12% |
| 整帧 median，120×40 live | 4.53 ms | **3.87 ms** | −15% |
| 整帧 median，200×60 live | 6.95 ms | **5.73 ms** | −18% |
| 整帧 p95，120×40 live | 6.22 ms | **5.47 ms** | −12% |
| 整帧 p95，200×60 live | 8.59 ms | **7.44 ms** | −13% |
| 可见输出（4 场景 × plain/ANSI 摘要） | — | **逐字节相同** | — |

结论：#346 的**耗时**目标（120×40 ≤5.0ms / p95 ≤7.0ms、200×60 ≤7.0ms / p95 ≤10.0ms）达成，
任务卡更严的 120×40 ≤4.0ms 也达成（3.87ms）；**整帧分配 ≤2.0MB 仍未达成**（2.55 / 4.02MB），
残项见 §4 与 follow-up #364。

## §4 后续（不在本契约内）

- **已修（#362）**：`Canvas.set()` 不再每次写新建 `Cell`。`Canvas` 构造时一次性建好 `W×H` 个可变
  cell，`set()` 原地写 `ch/color/bold/inverse`（显式字段，无 `{...style}`），默认 style 用共享常量，
  `sanitizeChar` 按字符记忆化。同一脚本前后：**52.4 → 0.03 B/次**（120×40）、**128.0 → 0.002 B/次**
  （200×60），一帧 4,583 / 9,691 次写入 ⇒ 0.24 MB / 0.91 MB 的分配消失。预填也变小
  （53–57 → 39–41 B/格）。`get()` / `cells` 的语义因此写死为**活视图**（下一次 `set` 改同一对象），
  两个既有读点（`drawChart` 的 peak 规则、`railway` 的表头守卫）都只读 `ch` 即弃。
  可见输出逐字节不变（§3.4）。上一轮契约里「drawGalaxy 每帧写约 5 万次」的说法仍以实测为准：4,583/9,691 次。
- **剩余分配（同一进程内分量，±40% 抖动，只用于排序）**：`drawGalaxy` ≈0.93–1.23 MB（整帧 36–45%，
  时间也最大 2.2 ms，其中 braille `px` 网格 80.9 KB/58×19、262.5 KB/118×31 已隔离）、
  `Canvas.toLines(theme)` ≈0.44–1.01 MB（每个 role 色格都 `{...cell, color}` 复制一遍）、
  `drawChart` ≈0.38–0.62 MB（含 `computeStats` 157 KB、`buckets` 129 KB）、`Canvas` 预填
  0.19–0.47 MB、其余（header/log/timing/status/layout/`buildLog`）≈0.35–0.5 MB 未逐项隔离。
  120×40/live 整帧 2.55 MB、200×60/live 4.02 MB，离 ≤2.0 MB 还有 0.5–2.0 MB：**follow-up #364**。
- **滚动 `chartWindow`（尾部 60s）本轮评估后不采纳，保持「整轮 run 窗口」。** 实测：
  live 形状**零收益**（窗口内每个 series 都在变，`walked 196 / skipped 0`，`buckets()` 0.61 ms vs
  0.74 ms 在噪声内），settled 形状省 0.1–0.4 ms；代价是 x 轴域从整轮 run 压成 60s，
  **4 个场景的 plain/ANSI 摘要全部改变**——这是「可见输出的语义变化」，本契约 §3.3/R2 已注明需单独授权，
  所以它要作为独立决定（带前后对比）来评审，不并入分配优化。
