# `finished` 完成结果缓存淘汰契约 v1

> 状态：**生效**，随 #349 落地。这条契约把「`finished` 能留多少 output 文本、淘汰时丢什么、
> 哪些条目**不许**淘汰、淘汰后 `collect`/`wait` 还欠调用方什么」写死。
> 冲突时**停下报告**，不得自行重新解释本契约。
> 关联：#349（`finished` 驻留全文且永不淘汰）、#320/#322/#327/#333（claim 语义，**不动**）、
> `notice-claim-v1.md`（D2/D7/D9/D10 的 claim 与 one-round 语义，**不动**）。
> **修订 r2（review 返工）**：上限压到 issue #349 的验收（**8KB/条、1MB/总**）；
> 明写「调用方拿到的是缓存条目的**副本**」（改造 1）；`CollectSnapshot.outputTruncated` 成为
> 「已降级读取」的显式标记（改造 3）；R3 的文本等价性指向 §3.3（改造 minor 1）。

---

## §1 问题陈述

`src/extension/runtime.ts` 的 `finished` 是 **one-round 缓存**（D7b，按 name 键），存
`{ runId, round, snapshot: CollectSnapshot }`，其中 `snapshot.output` 是 child 的**输出全文**。
它只在 5 处被删（重新 `track` / `rewatch` / `unclaim` / `unclaimUndelivered` / `dispose`），
**没有任何上限**：实测 50 个 child × 204,800 B 输出 ⇒ 堆上驻留 **10.07 MB**（≈206 KB/child），
把 50 个名字重新 `track` 后立刻回落（反向证明持有者就是它）。

关键事实：**调用方真正需要的是「结果」而不是「全文」**——
`runId`/`round`（claim 键，D9/D10）、`execution`、`acceptance`、`outputFile`；
而全文早已由 orchestrator 落盘（`writeOutputFile` → `<runDir>/<name>.output.md`，
`CollectSnapshot.outputFile` 就是它的路径）。

---

## §2 约定

### R1 — 上限只作用于「驻留的 output 文本」，且满足 #349 的验收（≤ 1.0 MB）

| 常量（`runtime.ts` 具名导出） | 值 | 语义 |
|---|---|---|
| `FINISHED_CACHE_MAX_ENTRY_BYTES` | **8 KB** | **单条**驻留文本上限。超过它的输出**一个字节都不留在内存**（存预览头，命中时从 `outputFile` 重建） |
| `FINISHED_CACHE_MAX_OUTPUT_BYTES` | **1 MB** | 整个缓存的驻留文本合计上限 |
| `FINISHED_CACHE_MAX_ENTRIES` | **128** | 条目数上限，按 `1MB / 8KB` 推导（因此字节上限才是实际约束） |
| `FINISHED_OUTPUT_HEAD_CHARS` | 4000 字符 | 被淘汰条目保留的预览前缀（≤ 8 KB UTF-8，与 `notify.ts` 的 `PREVIEW_CHARS` 一致） |

上限**任何时刻**都成立（`residentBytes` 不超 1 MB），包括「刚刚命中、刚从磁盘读回全文」的那一刻
（见 R3 的第 3 条）。LRU 顺序 = `Map` 插入顺序：新写入的、以及**命中过的**（`wait`/`collect` 走
`cachedFinished()`）都是「最新」，超出上限的最旧条目的文本被淘汰。

> 为什么单条也要封顶：只封总量时，一条 200 KB 的输出仍可以长期驻留（占掉 1/5 预算），
> 缓存占用就跟着「最大的那个 child」走；封单条后，驻留量与单个输出大小**无关**。

### R2 — 淘汰**只丢 output 文本**，永远不丢条目、不丢元数据

淘汰后条目仍在 `finished` 里，`runId` / `round` / `snapshot.execution` /
`snapshot.acceptance` / `snapshot.outputFile` / `snapshot.blocked` 全部原样。
`snapshot.output` 变成**前 4000 字符的预览**（`stripped = true`）。

**为什么不能删条目**：`finished` 的命中同时承担 claim（`(runId, name, round)`，D9/D10）。
删掉条目会让之后的 `collect`/`wait` 变成 `missing` —— 那是「结果丢失」，
而且会让本轮的 claim 键消失（重复投递 / 该投递的失败被吞掉）。

### R3 — 淘汰必须可重建：先落盘，后淘汰；命中一律从盘上取全文

淘汰的前提是 `snapshot.outputFile` 存在。命中（`cachedFinished()`）的顺序是：

1. 条目移到「最新」；
2. `trimFinished()` —— 先把本次命中的条目按 R1 重新收口；
3. `rehydrateFinished(entry)` —— 从 `fs.readFileSync(outputFile)` 读回全文（去掉 orchestrator 写盘时
   补的那一个 `\n`）；
4. **把 `snapshot` 的副本交给调用方**，随后再 `trimFinished()` 把条目重新收回配额内。

于是：

- `wait(name)` / `collect` 在淘汰之后**仍能拿到和淘汰前一模一样的结果**（全文 + 元数据）；
  文本等价性见 §3.3（最多首尾空白差异），**不是**逐字节相同；
- 「刚命中又把条目收回配额」不会影响调用方：它拿的是副本，字符串不可变；
- 条目重新变回「最新」，重新占用配额（配额再挤掉别的旧条目，循环有界）。

### R4 — 不可淘汰路径（pinned）：没有 `outputFile` 的条目一律不动

以下条目**不得淘汰**，其文本保留到被 `track`/`rewatch`/`dispose` 删掉为止：

| 不可重建的路径 | 为什么 |
|---|---|
| `collect` 实现从不落盘的快照（宿主自备的 collect、测试 fake） | 没有 `outputFile`，丢了就真丢了 |
| `writeOutputFile` 失败（`fs` 报错）或输出为空 | `outputFile` 为 `undefined`；空输出本来也占 0 字节 |
| orchestrator 之外的 `TrackedJobInput.collect` 来源 | 同上，契约不假设它们有磁盘副本 |

生产路径不受影响：`index.ts` 只把 `orchestrator.collect(...)` 交给 `runtime.track()`，而它对
每个**终态、非空**输出都写 `<runDir>/<name>.output.md`（inprocess 与 rpc 共用同一 orchestrator）。
pinned 的字节数**不是隐形的**：`noticeQueueStats().finished.pinnedBytes` 会如实报出来（R5）。

### R5 — 可观测性（含「已降级读取」的显式标记）

`noticeQueueStats()` 的 `finished` 块（纯读，不加淘汰语义）：

```ts
finished: {
  entries: number;        // 缓存里的结果条数（淘汰不改变它）
  residentBytes: number;  // 驻留 output 文本的 UTF-8 字节数（含淘汰后的预览头）
  stripped: number;       // 已淘汰文本、待命中时从磁盘重建的条数
  pinnedBytes: number;    // 因「不可重建」而无法回收的字节数（R4）
}
```

`CollectSnapshot` 新增 **`outputTruncated?: true`**（issue #349 建议 A 的「明确的已落盘标记」）：

- 只有当这一份 `output` **不是** child 的全文、并且**重建失败**时才出现
  （`outputFile` 被删 / 从未记录 / 读盘抛错）；
- 第一次 `collect`/`wait`、pinned 条目、落盘正常时的任何命中，**都不会**带这个字段；
- 它是纯快照字段，不进 wire、不进 ledger（R6）。

### R6 — 不动的边界

- **不改 claim（`reported`）的淘汰语义**（#320 那一族的正确性依赖它），只加计数；
- 不改 one-round 失效点（`track` / `rewatch` / `unclaim` / `unclaimUndelivered` / `dispose`）；
- **不改 claim 键**：淘汰后的条目仍然带 `runId`/`round`，缓存命中的 claim 与淘汰前完全相同；
  命中时交出的副本会重新登记 `(runId, round)` origin，`unclaimUndelivered`（#320 的回滚）
  因此对缓存命中也照旧生效；
- 不改 `CollectSnapshot` 之外的形状（不进 wire、不改 ledger schema）；`outputTruncated` 是本轮
  唯一新增字段（R5），且是可选字段；
- 不改 `RateSampler` 的样本保留（那是 #346 的地盘，见 `legion-chart-frame-buckets-v1.md`）。

---

## §3 已知取舍（写在这里，免得被当成 bug）

1. **单条输出大于 8 KB**：不进驻留（存 4000 字符预览头）。第一次 `collect`/`wait` 拿到的仍是
   **全文**——缓存条目是**副本**，淘汰只动缓存自己的那份；之后的命中从 `outputFile` 重建全文。
   上限就是上限——缓存不能为了一个巨无霸把整帧预算吃掉。
2. **`outputFile` 指向的文件被删了**（run dir 被清理）：`collect` 拿到 4000 字符预览头 +
   完整元数据 + `outputTruncated: true`，**不会**变成 `missing`。降级读，不是丢结果。
3. **重新读回的是落盘文本**：orchestrator 写的是 `output.trim() + "\n"`，所以重建后的
   `snapshot.output` 与原始 `output` 的差异最多是首尾空白，**等于 `output.trim()`**；
   正文逐字节相同。用例：`output = "abc\n\n"` ⇒ 命中后 `=== output.trim()`。
4. **淘汰发生在写入时、以及命中时**（不是定时器）：任何时刻 `finished` 的驻留文本都不超过 R1 的上限。

---

## §4 实测

环境：Node v24.13.1，`createSessionRuntime` + 真 orchestrator 形状的 `outputFile`
（`output.trim() + "\n"`），`--expose-gc`，GC 后取 `heapUsed`。同一脚本跑三侧：
`master`（改前）、`b80a9ab`（本 PR 上一轮提交，review 打回的版本）、本轮 HEAD。

### 4.1 50 个 child × 204,800 B

| 场景 | master | b80a9ab（上一轮） | 本轮 HEAD |
|---|---|---|---|
| 完成后堆驻留 | **10.07 MB**（206 KB/child） | 3.58 MB（73 KB/child） | **0.51 MB**（10 KB/child） |
| `finished.residentBytes` | —（无此字段） | 3.41 MB（16 条全文 + 34 个预览头） | **0.20 MB**（50 个预览头） |
| `stripped` / `pinned` | — | 34 / 0 | **50 / 0** |
| 是否满足 #349 的「≤ 1.0 MB」 | ❌ 10.07 MB | ❌ 3.58 MB | ✅ **0.51 MB** |

### 4.2 单条大输出（本轮 major 1 的核心）

| 场景 | master | b80a9ab（上一轮） | 本轮 HEAD |
|---|---|---|---|
| 单条 204,800 B：首次 `wait` 字节数 | 204,818（全文） | 204,818（全文） | **204,818（全文）** |
| 单条 5,242,900 B：首次 `wait` 字节数 | 5,242,900（全文） | **4,000（头！）** | **5,242,900（全文）** |
| 单条 5,242,900 B：之后缓存命中字节数 | 5,242,900 | **4,000（头！）** | **5,242,900（全文）** |
| 单条 204,800 B：命中（从盘重建） | 全文 | 全文 | **全文** |

上一轮那两行 4,000 就是 review 的 major 1：`rememberFinished` 存的是**引用**，
插入时 `trimFinished()` 把**要交出去的那个对象**原地剥成了 4000 字头。
本轮缓存存浅拷贝，交付对象与缓存条目彻底分开。

### 4.3 `outputFile` 被删（降级读取）

| 场景 | 本轮 HEAD |
|---|---|
| `consumeCollect()` 返回值 | `output.length === 4000`（预览头，且是原文的头部） |
| 标记 | `snapshot.outputTruncated === true` |
| 元数据 | `execution` / `acceptance` / `outputFile` 全在，**不是** `missing` |
