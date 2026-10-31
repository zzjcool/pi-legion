# `finished` 完成结果缓存淘汰契约 v1

> 状态：**生效**，随 #349 落地。这条契约把「`finished` 能留多少 output 文本、淘汰时丢什么、
> 哪些条目**不许**淘汰、淘汰后 `collect`/`wait` 还欠调用方什么」写死。
> 冲突时**停下报告**，不得自行重新解释本契约。
> 关联：#349（`finished` 驻留全文且永不淘汰）、#320/#322/#327/#333（claim 语义，**不动**）、
> `notice-claim-v1.md`（D2/D7/D9/D10 的 claim 与 one-round 语义，**不动**）。

---

## §1 问题陈述

`src/extension/runtime.ts` 的 `finished` 是 **one-round 缓存**（D7b，按 name 键），存
`{ runId, round, snapshot: CollectSnapshot }`，其中 `snapshot.output` 是 child 的**输出全文**。
它只在 5 处被删（重新 `track` / `rewatch` / `unclaim` / `unclaimUndelivered` / `dispose`），
**没有任何上限**：实测 50 个 child × 204,800 B 输出 ⇒ 堆上驻留 **10.0 MB**（≈210 KB/child），
把 50 个名字重新 `track` 后立刻回落 ≈9.6 MB（反向证明持有者就是它）。

关键事实：**调用方真正需要的是「结果」而不是「全文」**——
`runId`/`round`（claim 键，D9/D10）、`execution`、`acceptance`、`outputFile`；
而全文早已由 orchestrator 落盘（`writeOutputFile` → `<runDir>/<name>.output.md`，
`CollectSnapshot.outputFile` 就是它的路径）。

---

## §2 约定

### R1 — 上限只作用于「驻留的 output 文本」

| 常量 | 值 | 语义 |
|---|---|---|
| `FINISHED_CACHE_MAX_ENTRIES` | 16 | 最多 16 个条目保留全文 |
| `FINISHED_CACHE_MAX_OUTPUT_BYTES` | 4 MB | 保留全文的条目合计 ≤ 4 MB |
| `FINISHED_OUTPUT_HEAD_CHARS` | 4000 | 被淘汰条目保留的预览前缀（≤ 8 KB 内存） |

两个上限**同时**生效（谁先到谁触发），LRU 顺序 = `Map` 插入顺序：新写入的、以及**命中过的**
（`wait`/`collect` 走 `cachedFinished()`）都是「最新」，超出上限的最旧条目被淘汰。

### R2 — 淘汰**只丢 output 文本**，永远不丢条目、不丢元数据

淘汰后条目仍在 `finished` 里，`runId` / `round` / `snapshot.execution` /
`snapshot.acceptance` / `snapshot.outputFile` / `snapshot.blocked` 全部原样。
`snapshot.output` 变成**前 4000 字符的预览**（`stripped = true`）。

**为什么不能删条目**：`finished` 的命中同时承担 claim（`(runId, name, round)`，D9/D10）。
删掉条目会让之后的 `collect`/`wait` 变成 `missing` —— 那是「结果丢失」，
而且会让本轮的 claim 键消失（重复投递 / 该投递的失败被吞掉）。

### R3 — 淘汰必须可重建：先落盘，后淘汰

淘汰的前提是 `snapshot.outputFile` 存在。命中被淘汰的条目时，`cachedFinished()` 会
**从磁盘重新读回全文**（`fs.readFileSync(outputFile)`，丢掉 orchestrator 写盘时补的那一个
`\n`），然后才交给调用方。于是：

- `wait(name)` / `collect` 在淘汰之后**仍能拿到和淘汰前一模一样的结果**（全文 + 元数据）；
- 重新读回后该条目变回「最新」，重新占用配额（配额再挤掉别的旧条目，循环有界）。

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

### R5 — 可观测性

`noticeQueueStats()` 新增 `finished` 块（纯读，不加淘汰语义）：

```ts
finished: {
  entries: number;        // 缓存里的结果条数（淘汰不改变它）
  residentBytes: number;  // 驻留 output 文本的 UTF-8 字节数（含淘汰后的预览头）
  stripped: number;       // 已淘汰文本、待命中时从磁盘重建的条数
  pinnedBytes: number;    // 因「不可重建」而无法回收的字节数（R4）
}
```

### R6 — 不动的边界

- **不改 claim（`reported`）的淘汰语义**（#320 那一族的正确性依赖它），只加计数；
- 不改 one-round 失效点（`track` / `rewatch` / `unclaim` / `unclaimUndelivered` / `dispose`）；
- 不改 `CollectSnapshot` 的字段形状（不新增 wire 字段），不改 ledger schema；
- 不改 `RateSampler` 的样本保留（那是 #346 的地盘，见 `legion-chart-frame-buckets-v1.md`）。

---

## §3 已知取舍（写在这里，免得被当成 bug）

1. **单条输出大于字节上限**（> 4 MB）：`collect` 拿到的是预览头，全文靠 `outputFile`。
   上限就是上限——缓存不能为了一个巨无霸把整帧预算吃掉。
2. **`outputFile` 指向的文件被删了**（run dir 被清理）：`collect` 拿到预览头 + 完整元数据，
   **不会**变成 `missing`。降级读，不是丢结果。
3. **重新读回的是落盘文本**：orchestrator 写的是 `output.trim() + "\n"`，所以重建后的
   `snapshot.output` 与原始 `output` 的差异最多是首尾空白。正文逐字节相同。
4. **淘汰发生在写入时**（不是定时器）：任何时刻 `finished` 的驻留文本都不超过 R1 的上限。

---

## §4 实测

环境：Node v24.13.1，`createSessionRuntime` + 真 orchestrator 形状的 `outputFile`，
50 个 child × 204,800 B 输出，`--expose-gc`，GC 后取 `heapUsed`。

| 场景 | 改前 | 改后 |
|---|---|---|
| 50 child 完成后驻留 | **10.02 MB**（210,199 B/child） | **3.53 MB**（74,104 B/child） |
| `finished.residentBytes`（内部计数） | — | 3.25 MB（= 16 条全文 3.2 MB + 34 个预览头 0.14 MB） |
| `stripped` / `pinned` | — | 34 / 0 |
| 重新 `track` 全部 50 个后 | 回落到 +0.38 MB | 回落到 +0.40 MB |
| `dispose()` 之后 | +0.30 MB | +0.32 MB |

issue #349 的验收写的是「≤ 1.0 MB」，需要把上限压到 1 MB 左右才满足；本契约按任务卡冻结的
「16 个 child / 或 4 MB」落地，于是长会话从「几十 MB」封顶到 ≈3.3 MB。
两个常量是 `runtime.ts` 的具名导出，调它们是**改契约**，不是改实现。
