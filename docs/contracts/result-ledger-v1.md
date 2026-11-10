# 结果账本：artifact + ledger + 通知投影（v1，FROZEN）

> 状态：**FROZEN（已裁决，可开工）** —— 三项关键决策已于 2026-11-10 由用户裁定，见 §12。
> 冲突时停下来报告，不得重新解释本契约。
> 基线：`d2d0a07`（5.6.0）。本契约本身**未跑**门禁（`npm run typecheck` / `npm test`）；P1 开工前由 worker 先跑一次基线并记录结果。

取代关系（生效时执行，见 §9）：

- 取代 `notice-claim-v1.md` **全文**（D1-D10 的 claim 模型、`unclaim` 两套语义、验收清单 1-14）。
- 保留 `notice-delivery-v2.md` 的 D1/D2/D3/D4/D5/D6（交付时刻、每边界一条、交付时生成文本、`stillRunning` 口径、首行标记、上限只计数）。
- 保留 `finished-cache-eviction-v1.md` 的回收目标；本契约删掉它的「4000 字符 strip + 回读」实现（D8）。

---

## 0. 为什么要重构，不是补一个工具

同一个 child 结果今天有两条独立通道（`wait`/`collect` 的工具返回；watch → join → outbox 的主动通知），
而「父已经看过」这件事是**内存里的布尔位**（`reported: Set<string>`，`runtime.ts:838-846`），
由 4 个散布的调用点置位，外加 2 套语义相反的回滚 API。

后果不是「少了一条路径」，而是**任何未被枚举的消费路径都必然漏通知**：

| # | 已知窗口 | 状态 |
| --- | --- | --- |
| W1-W4 | buffered-after-wait / outbox-after-wait / release 孤儿 / flags 随 job 消失 | 5.3.0 已修（`CHANGELOG.md:1078-1108`） |
| W5 | 父对 `<runDir>/<name>.output.md` 用通用 `read` | **现存**，且通知正文自己在推荐这条路（`notify.ts:246,361`） |
| W6 | `outputFileFor` 只按 name（`orchestrator.ts:2946`），同名第二轮**覆盖**第一轮，未读内容物理消失 | **现存** |
| W7 | `snapshot.outputTruncated`（`runtime.ts:87,1057`）**从不渲染**，模型无法知道拿到的是 4000 字符摘要 | **现存** |

W6/W7 证明：缺的不是「一个读工具」，是**结果本身没有身份、消费本身没有记录**。

---

## 1. 四个概念，替换今天的六套状态

| 概念 | 定义 |
| --- | --- |
| **Artifact** | 不可变输出，身份 = `(runId, name, round)` → `id = "<runId>/<name>/r<round>"`，落盘 `<runDir>/artifacts/<name>/r<round>.md` |
| **Ledger** | 持久表：`artifacts` + `consumptions`（D2） |
| **Consumer** | `parent_id`（root 或持有该 child 的 centurion 节点 id）。同名多轮天然分开，因为 round 在 artifact id 里 |
| **Notice** | ledger 的**投影**：flush 时查询「该 consumer 尚无任何消费记录」的 artifact（D4） |

---

## 2. 不可违反的既有约束

| 约束 | 锚点 |
| --- | --- |
| 运行时零外部依赖（Node stdlib only） | `CONTRIBUTING.md:215` |
| 完成通知首行固定标记 `▣ legion · automatic completion notice — not a user message` | `notice-delivery-v2.md` D5 |
| 完成通知只在父 run 边界交付，一次边界一条唤醒通知 | `notice-delivery-v2.md` D1/D2 |
| outbox 只存结构，文本在交付时刻生成 | `notice-delivery-v2.md` D3 |
| `Still running` 只列「确定会另发通知」的兄弟（宁可少报，不可假报） | `notice-delivery-v2.md` D4 |
| DB schema 变更必须同步 sentinel + 契约（本次是**允许**的，但必须显式） | `test/unit/legion-schema-sentinel.test.ts`、`docs/legion-v2-contract.md §4.2/§4.3/§11.1` |
| 工具结果永不被抑制（`wait`/`collect` 永远返回全文） | `notice-claim-v1.md` D6（本契约保留） |
| 不允许按比例摊派、不允许编造数值 | `status-panel-v1.md` D2、`panels.ts:1140` |

**新增不可违反**：

- **A1** artifact 路径永不复用；写入必须原子（`writeFileSync(tmp)` + `fs.renameSync`），半截文件不允许被读；`bytes >= 1`（空输出不产生 artifact，D1）。
- **A1b** artifact 行**不可变**：`recordArtifact` 必须 `ON CONFLICT(id) DO NOTHING`（重放幂等但**不更新**）。`INSERT OR REPLACE` 属违规：它能把 `bytes` 写小，使 `read_bytes >= bytes` 提前成立，把「读了一半」翻成「读完」而静默丢通知。
- **A2** ledger 不丢事实：同一 `(artifact_id, consumer_id)` 只有一行；`read_bytes` 是**只增不减**的高水位；`notified_at` 一旦写入不清空。禁止把「读了多少」与「通知过没有」合并成一个等级。
- **A3** ledger 是**唯一**的消费事实源；不允许再引入第二处「读过」的内存标记。

---

## 3. 设计决策

### D1 — Artifact 身份三元组，路径含 round

- `id = "<runId>/<name>/r<round>"`；路径 `<runDir>/artifacts/<name>/r<round>.md`。
- 修掉 `outputFileFor`（`orchestrator.ts:2946`）只按 name 的覆盖行为（W6）。
- 保留今天「无大小上限」的事实，但把 `bytes` 记进 ledger —— 读工具与通知都能诚实说「4.0 KB of 24.5 KB」。

### D1a — artifact round 的来源：ledger 的 `MAX(round)+1`，**不是** runtime 的 report round

P2 侦察结论（2026-11-10）：orchestrator **看不到** `TrackedJob.round`（`collect()` 只收 `timeoutMs/signal`；
`ChildRecord` / `Handle` / `CollectResult` / `CollectSnapshot` 全都无 round 字段）。而 runtime 的
`roundOfName` 是**进程内 Map**，`dispose()` 会 `clear()`、**不落盘** —— 用它做路径会让 `r1.md` 在重启/reload 后被复用，
直接违反 A1。

冻结：

- `nextArtifactRound` = **`max(ledger 的最大 round, 磁盘的最大 round) + 1`**；1-based。
  **不能只看 ledger**（P2 交付后纠正）：`legion.db` 被删/被替换且未跑 rebuild 时，磁盘上已有 `r1.md` 而 ledger 为空，
  只看 ledger 会算出 round 1 而**覆盖已有 artifact** —— A1「路径永不复用」优先于「单一来源」。两个来源都是自描述的：
  ledger 只要查行，磁盘只需 `readdir` + `r<digits>.md` 匹配。
- 无 DB 上下文时（`this.legion` 可选，且**所有 orchestrator 集成测试都不传**）自然退化为「只看磁盘」。
- **两种 round 语义不合并**：runtime 的 round 是「reporting round」，artifact 的 round 是「输出轮次」。
  一次 resume 没有任何新输出 → runtime round +1、artifact round 不动。这是有意的不等价。

### D1b — 内容幂等：相同字节不新增 round

写之前先比对 **本 `(runId,name)` 最新 artifact 的磁盘内容**与本次要写的字节：完全相同 → 直接复用那份
artifact（不建新文件、不写新行）。目的：

- 同 child 的并发 collect（仓库自己承认会并发，`orchestrator.ts:2677-2680`）不会产出 r1+r2 两份；
- 「读了但内容没变」的 resume 不会把一个纯冗余的 artifact 推成新通知。

### D1c — 空输出：不产生 artifact，也**不删**历史 artifact（取代 D1 里那句「沿用 fs.rmSync 语义」）

今天 `writeOutputFile` 在空输出时 `fs.rmSync(<name>.output.md)`，而那个路径**指向上一轮的文件**；
一旦 round 进路径，这句话就失去了对应物（本轮 `rN.md` 从不存在）。冻结：

- 本轮空输出 ⇒ 不写文件、不落 ledger 行，`CollectResult.outputFile` 为 `undefined`。
- **不得**删除任何历史 artifact（它们是不可变的审计与通知素材）。
- `test/integration/regressions.test.ts:97-115`「later turn has no output」用例改写为断言「本轮 `outputFile === undefined` 且上一轮 artifact 文件仍在」，
  不再是「文件被删」。

### D1d — name 是路径段，必须 sanitize

今天 `${name}.output.md` 里 name 只是个文件名的一部分；改成目录后它是一个路径段（`..`/`/` 的逃逸面不同）。
写路径时必须用既有 `sanitizeNameForFs`（`src/runs/worktree.ts:16-19` 的惯例）。

**`id` 与路径段一律用 sanitize 后的段，`artifacts.name` 列存原始 name**（P2 交付后纠正）：`rebuild` 只能从**目录名**
反推 name（`rebuild.ts:562-570`），若写侧的 id 用原始 name，两侧对同一份 body 会产出不同 id，导致重建后 `consumptions`
成孤儿、`maxRoundFor` 前缀也查不到重建行。raw name 仍完整保留在列里，展示与按名查找不受影响。

### D1e — ledger 写入是 best-effort，永不改变 `collect` 的返回契约

`this.legion` 可选（`:107`，集成测试全不传）、`child.nodeId` 可选、写盘失败今天也已是「吞成 `undefined`」
（`orchestrator.ts:2958`）。冻结：写 ledger 行包在守卫里（照 `recordSettled` 的 `if (!this.legion || !child.nodeId) return` 先例），
失败只吞、不抛、不影响 `CollectResult`。

### D2 — Ledger 落 `legion.db`，不落内存（用户裁决：**允许**升版本，2026-11-10）

```sql
CREATE TABLE artifacts (
  id          TEXT PRIMARY KEY,          -- "<runId>/<name>/r<round>"
  parent_id   TEXT NOT NULL,             -- consumer 节点 id（root 或 centurion）
  node_id     TEXT NOT NULL,
  name        TEXT NOT NULL,
  round       INTEGER NOT NULL,
  path        TEXT NOT NULL,             -- 绝对路径
  bytes       INTEGER NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX idx_artifacts_parent ON artifacts(parent_id, created_at);

CREATE TABLE consumptions (
  artifact_id  TEXT NOT NULL,
  consumer_id  TEXT NOT NULL,
  read_bytes   INTEGER NOT NULL DEFAULT 0,   -- 已读字节的**高水位**，只增不减
  read_at      INTEGER,                      -- 最后一次读的时刻
  notified_at  INTEGER,                      -- 通知首次成功交付的时刻（只写一次）
  PRIMARY KEY (artifact_id, consumer_id)
);
```

- **两个正交事实，两个维度**：`read_bytes` 回答「父读了多少」，`notified_at` 回答「通知发过没有」。
  **禁止**把它们压成一个 `kind` 等级 —— 这样做会把「通知后再分页读几行」误判成「没通知过」而重发，
  或把「先分页读一半」误判成「读完了」而漏发。
- 抑制谓词（**唯一一处**，`ledger.undelivered` 内）。两个合取项，缺一不可：
  ```
  a.parent_id = :consumerId
  AND c.notified_at IS NULL
  AND COALESCE(c.read_bytes, 0) < a.bytes
  ```
  **`parent_id` 作用域不是可选项**：`consumptions` 是 `(artifact_id, consumer_id)` 两维表，不带 `parent_id` 限定就会把兄弟子树的 artifact 当成「本 consumer 未读」交出去，直接让通知发错人（P1 审查 critical #1）。
- `LEGION_DB_USER_VERSION` 2 → **3**；sentinel 与 `docs/legion-v2-contract.md` 同批更新。
- 为什么进 DB 而不是 keepsake 文件：宿主 `sendMessage` **无 ack、无消息 id、无队列撤回**（`docs/extensions.md:1627-1645`），幂等只能靠自己；且今天 claim 是 memory-only（`runtime.ts:838-846`），重启即失忆，而 `src/shared/types.ts:423-427` 另有一句「每次工具调用是新进程」的矛盾注释 —— 唯一能同时满足两者的位置是 DB。
- 被否决：单表 `outputs` 带 `consumed INTEGER`（无法记 `partial`/`notified` 的区别，也无法审计「谁在什么时候读了什么」）。

### D3 — 消费只由「真实交付」推进，且由**工具层**推进

- runtime 返回 `{ snapshot, artifactId }`，**不**置位；`collectChild` / `waitAction` 在 `return ok(...)` 的**前一行**调 `ledger.markRead({artifactId, consumerId, bytesRead: bytes, at})`（全文读完 ⇒ 高水位持平 `bytes`）。
- 依据：父 turn 不可能在工具 handler 中途结束，所以「交付完成 ⇒ 已经落账」在本进程内是同步成立的；顺带**整类删除** bail 回滚（`unclaimUndelivered` + `claimedNow`「证据不是借条」，`notice-claim-v1.md` #320/#352）。
- 被否决：在 runtime 缝里 claim（今天形状）—— 那是 #320/#352 两个 patch 的成因。

### D4 — 通知是投影，没有 filter / claim / bail

```
flushOutbox() → ledger.undelivered(consumerId)
              → 空则 0；否则格式化 → 发送成功 → ledger.markNotified(ids, now)
```

- `undelivered` = `a.parent_id = consumerId AND c.notified_at IS NULL AND COALESCE(c.read_bytes,0) < a.bytes`（D2 的单一谓词，三个合取项）。
- 已读全文（`read_bytes >= bytes`）→ 投影变空，不补发；已发过通知（`notified_at`）→ 不重发。
- 发送失败 → 不写 `notified_at` → 下次边界重试（沿用 `notice-claim-v1` D5 的 `false → 不 claim`）；**没有回滚 API**。
- `join.dropBuffered*` 整类删除：成员由投影决定，缓冲里没有「需要撤销的副本」。

### D5 — 通用 `read` 也算消费（path → artifact 索引）

- `index.ts` 的 `tool_result` handler（今天只做 `bindUi + refreshUi`，`index.ts:2555`）增加：
  工具名为 `read`，且路径命中 `<runDir>/artifacts/**/r*.md` → 反查 artifact →
  - 无 `offset`/`limit` 参数 ⇒ `full`
  - 有 `offset` ⇒ `partial`
- 这条让 **root 不需要任何豁免**：`registerLegionTools` 的 `nodeId !== "root"` 排除（`index.ts:992`）与 `registerTools:false`（`:1130`/`:1208`）保持不动，#372 的语义不被触碰。
- 与 D7 不冲突：D7 的工具注册在插件层（与 `subagent` 同层），因此 root 天然可见 —— 那只是「更好的路径」，不是「唯一路径」；hook 保证模型选了通用 `read` 也不会漏账。
- 被否决：给 root 开一个 `registerLegionTools` 例外（无先例，全仓 6 处 `nodeId === "root"` 全是内部逻辑），且它只覆盖「模型选了新工具」那一半。

### D6 — 只有 `full` 抑制通知（用户裁决，2026-11-10）

- 用户原文：「读完才算，读了一半岂不是白读」。
- 闸门：`read_bytes >= artifacts.bytes`（读完全部字节）才让投影变空；`read_bytes < bytes` 的分页读**不抑制**。
- `notified_at` 与读取无关：一份 artifact 最多被通知**一次**，与父读了多少字节无关。
- 读工具 header 必须把这件事说出口：`partial 120/1200 lines · notifications not suppressed — read to EOF to settle`，避免模型以为分页扫完就算交差。
- 完整序列范例（必须有测试）：分页读一半 → 通知仍然送达一次 → 读完全文 → 不再有通知；反之先通知再分页读完，也不重发。

### D7 — `legion_output` 工具（唯一读入口，root 与 child 都注册）

```
legion_output({ name, round?, offset?, limit? })
→ "scout-data · round 1 · settled 2m ago · 24.5 KB · phase=implementing\n"
  + 内容
→ 读到 EOF 且覆盖全文件 ⇒ markRead(bytesRead = bytes)；否则 markRead(bytesRead = 本次实际返回的末字节偏移)
```

- 注册位置：插件入口（与 `subagent` 同层，`index.ts:2251` 旁），**不**走 `registerLegionTools`（那是 child-only）。
- header 必含：`round`（否则同名多轮的歧义仍在）、`bytes`、`settled-at`、`phase`。
- 文件被人工截短/篡改：`bytes` 与 ledger 不符时 header 打 `changed-on-disk`，**不**推进 `full`。
- 被否决：复用 `collect` 加 `offset/limit` —— `collect` 的语义是「交付结果」，分页会让它同时承担两种职责。

### D8 — 删除 finished 缓存的 strip/rehydrate

- 今天：>8KB 只留 4000 字符头（`runtime.ts:948-953`），读缓存时回读文件（`:957-980`），失败打 `outputTruncated`（`:1057`），而该标记**从不渲染**（W7）。
- 新：缓存只存 `artifactId` + 元数据，正文一律从 artifact 读（按 `offset/limit` 流式），不再有「摘要被当成全文」这一状态。

### D9 — 通知正文保留预览，但如实标注

- 保留 4000 字符预览（`notify.ts:201`），不变更产品语义（`notice-delivery-v2` §5.1 的「载荷改指针」仍未做）。
- 变的是**标注**：`preview 4.0 KB of 24.5 KB · read via legion_output`，替代今天把预览字节数当 `outputBytes` 呈现（`notify.ts:398,530`）。
- 通知的 `details` 增 `artifactIds: string[]`，供渲染层与诊断定位。

### D10 — `rebuild` 从 artifact 重建

- artifact 在磁盘上自描述（`<runId>/<name>/r<round>.md` + 文件 mtime/bytes），`rebuild.ts` 可重建 `artifacts` 行；`consumptions` 不可重建（消费是父进程的事实），重建后一律视为未读 —— 与今天 `phase`/`phase_since` 回落 null 同一取向，且**只会多推、不会少推**。
- `rebuild.ts` 现有的有损说明（`docs/legion-v2-contract.md:258-262`）追加本条款。
- **已裁决的不对称**：rebuild 只能从**目录名**（sanitize 段）反推 name，所以重建后 `artifacts.name` 列会是 `"A-B"` 而不是原始的 `"A B"`；写侧存原始 name。
  这不影响任何判定（抑制谓词与 round 查询全走 `id`），但 **P5 的 `legion_output({name})` 必须用 `artifactNameSegment(name)` 拼 id，不得按 `name` 列过滤**。
  真实 agent 名是 `[a-z][a-z0-9_-]{0,31}` slug，sanitize 为恒等，这个不对称只在病态名字上可见。

### D11 — shadow 期双写，分歧即 log

- `PI_LEGION_LEDGER_SHADOW=1`：老 claim 与新 ledger 并行计算，**只**在分歧时写 **stderr**（不新增 `events` 类型，避开 `events.ts` 的 16 类型闭集与 sentinel）。
- 新侧判定用 **`ledger.undelivered(consumerId)` 是否包含该 artifactId**，不用 `hasRead`：`reported`
  = 「两条路由任一已交付」（工具读 OR 通知已发），只有 `undelivered`（读完 + 已通知都排除）与它等价；
  `hasRead` 只覆盖读取侧，会在「已通知」侧假报分歧。
- **分歧方向必须分开看**（P3 交付后修正，否则退出条件不可达）：
  - `old=deliver ledger=suppress`（line 里 `reason=claim-open-but-ledger-counts-this-artifact-as-delivered`）
    = **静默漏发**，这是唯一真正的危险方向。
  - `old=suppress ledger=deliver`（`reason=claim-closed-but-ledger-still-owes-this-artifact`）
    = 在 P3 阶段**必然出现且预期**：`notified_at` / `read_bytes` 的写侧要到 P4/P5 才接，
    ledger 结构上少两类事实。「已交付但 ledger 不知道」只会多推一条，不会丢。
- **退出条件**（修正后）：P3 验收 = 「`old=deliver ledger=suppress` 为 **0**」+ mock-llm 全绿；
  **零分歧的全局目标属于 P4 之后**（那时两侧写侧都齐了）。
- 真机启用前提：`index.ts` 必须把 `getLedgerShadowFacts`（→ `{db, consumerId}`）传进 runtime deps；
  不接线时 shadow 是 inert 的（静默无输出，不报错、不影响投递）。
- 真跑规模：P3 的可重复验收载体是 `test/integration/mock-llm-ledger-shadow.test.ts`（同一 runId 两个 child、一个走 collect、一个纯通知）
  + 变异测试（删掉 read 侧写入必须变红）；真机会话作为补充而非门禁。
- 寿命：**只在 P3 存在**，P4 与老机制同一个 commit 删除。

### D12 — 旧模型直接删除，不做兼容层（用户裁决，2026-11-10）

- 用户原文：「我们现在只有我自己在用，旧的都清掉」。
- `src/api.ts` 的 `ClaimedCollect` / `claimedNow` **直接删**：不留重载、不留 `snapshotOnly` 开关、不写迁移指南、不做 deprecation 期。P4 一个 commit 删干净。
- 发布号仍是 **major**（npm 版本是外部事实，`package.json` 里没有「私人」标记）；但**没有迁移负担**，因为唯一消费者就是本会话的 root。
- 旧契约 `notice-claim-v1.md` 连同 14 条验收清单：`git mv` 进 `docs/contracts/archive/` + 头部加 `STATUS: HISTORICAL`，**正文不改**（仓库规则 `docs/contracts/archive/README.md`）。不 `rm` —— 审计证据的成本是一次 move，维护成本为零。
- 旧 claim 测试（`runtime.test.ts` 10 处 + `join.test.ts` 5 处）**删除不移植**；但它们覆盖的**场景**必须在 §7 新套里逐条重建 —— 删的是实现，不是行为。

---

## 4. 与既有契约的关系

| 契约 | 关系 |
| --- | --- |
| `notice-claim-v1.md` | **整体取代**（claim Set、4 个置位点、D7 复活、D7b 缓存单轮、D8 dropBuffered、D10 round 键）。round 键问题由 artifact id 天然解决，不再需要「键里必须有 round」这条规则。 |
| `notice-delivery-v2.md` | 保留 D1-D6。D6 的 `heldOverCap` 计数口径需改投影来源（`pending` 由 ledger 查）。 |
| `finished-cache-eviction-v1.md` | 保留回收预算与 pinned 语义；`strip`/rehydrate 实现被 D8 删除，其「不可回收 = 丢了就真丢了」理由由 artifact 落盘承接。 |
| `legion-v2-contract.md` | §4.2 表清单 + §4.3 索引 + §11.1 加两张表；§5 重建损失清单加 D10 条款。 |
| `subagent-renewal-v1.md` | 无冲突（`progress-signal.ts` 的「有产出」判据不动）。 |

---

## 5. 删除清单（代码）

| 删除 | 位置 |
| --- | --- |
| `reported` Set、`reportKey`、`claimReported`、`claimCachedResult`、`claimIfTerminal`、`unclaimReported`、`unclaimUndelivered` | `runtime.ts:838-917, 1088-1153` |
| `ClaimedCollect.claimedNow`、`snapshotOrigins` WeakMap（round 不再需要 cross-check） | `runtime.ts:732-735, 1075-1086` |
| `TrackedJob.consumedByTool` / `notified`（及 watch 闸门） | `runtime.ts:2388, 2450` |
| `join.dropBuffered` / `dropBufferedRound` / `buffered` 容器 | `join.ts` |
| finished 缓存 strip + rehydrate + `outputTruncated` | `runtime.ts:87, 948-1061` |
| `outputFileFor` 的 name-only 路径 | `orchestrator.ts:2946-2960` |
| `renderCollect` 的无条件「read this file when the output above is truncated」文案 | `index.ts:6441-6444` |

---

## 6. 文件所有权与阶段（串行，禁止并行 worker）

同一批文件高频冲突，**一个 phase 一个 worker，前一个合入后下一个开工**。

| Phase | 内容 | 文件 | 门禁 |
| --- | --- | --- | --- |
| P0 | 本契约冻结 + 裁决记录（§12） | `docs/contracts/result-ledger-v1.md` | 人工 ✓ |
| P1 | schema v3 + ledger store（纯函数 + 读写 API，无消费者） | `src/legion/db.ts`、`src/legion/ledger.ts`（新）、`src/legion/rebuild.ts`、sentinel 测试、`docs/legion-v2-contract.md` | typecheck + test |
| P2 | artifact store + 写入路径（含原子写、路径含 round） | `src/runs/artifacts.ts`（新）、`src/runs/orchestrator.ts` | typecheck + test + integration |
| P3 | 瘦身 shadow：老 claim 与新 ledger 双算，分歧只写 stderr（`PI_LEGION_LEDGER_SHADOW=1`），P4 连同老机制一起删 | `src/extension/runtime.ts`、`src/runs/orchestrator.ts` | 同上 + 真跑 5 会话 |
| P4 | 通知投影化 + **一次性删除** claim 三件套 / `join` 缓冲 / finished strip | `src/extension/runtime.ts`、`src/extension/join.ts`、`src/extension/notify.ts`、`src/api.ts` | 同上 + mock-llm |
| P5 | `legion_output` + path 索引 hook + collect 走 artifact | `index.ts`、`src/extension/ledger-hook.ts`（新）、`src/extension/notify.ts` | 同上 + 全量 |

---

## 7. 验收清单

既有 `test/unit/runtime.test.ts` 的 claim 系列（`:4177, :4231, :4433, :4484, :4654, :4722, :4817, :5367, :5418, :5735`）与 `test/unit/join.test.ts`（`:264-339`）**全部重写**，不得删断言而改写成空转。

新用例（每条「断言 0 条」必须配正向控制：同批一个未读兄弟必须送达）：

1. **W5 消除**：child 完成 → 父 `read` artifact 全文 → 边界 flush → **0 条**；同批未读兄弟 1 条（正向控制）。
2. **W5 边界**：父 `read` 带 `offset` → `partial` → 边界 flush **仍送达**（D6）。
3. **W6 消除**：同名两轮且**内容不同** → 两个 artifact，路径不同；读 round 1 后 round 2 的通知仍送达；对照：内容完全相同的两轮 → **一个** artifact（D1b）。
4. **W7 消除**：artifact 24.5 KB → `legion_output` 无参返回全文且 header 带 `24.5 KB`；`collect` 的预览不被误标为全文。
5. **D3 顺序**：`collect` 在 `return ok(...)` 前落账 —— 用会抛错的 `persistChild` 模拟 bail → **不落账** → 通知仍送达（等价于旧 #352 用例 14 的正向面）。
6. **D4 幂等**：通知发送成功 → 立刻再 `notifyParentSettled` → 0 条；`deliverCompletion` 返回 `false` → 下次边界重试 1 条。
7. **两维事实（A2）**：分页读一半 → `undelivered` 仍返回 → 发一条通知 → 写 `notified_at` → 再分页读完 → 不重发；对照：未通知前读完全文 → 投影立即变空；`read_bytes` 高水位只增不减（重复读同一区间不变）。
8. **重建（D10）**：删 `consumptions` 后 rebuild → artifact 行可恢复、一律未读；不得把「已读」谎报为已读。
9. **投影与 v2 不变式**：D1/D2 边界一条、D3 交付时生成、D4 `stillRunning` 口径的既有用例全部保持绿色。
10. **`undelivered()` 走索引、不扫全表**：用 `EXPLAIN QUERY PLAN` 断言命中 `idx_artifacts_parent`（**不写计时断言**：毫秒门在 CI 上是 flaky 源，且原生 bench 文件`10-legion-frame-alloc` 被 `viz-frame-alloc-v1` 的 digest 闸门钉死，不得改动）。

---

## 8. 风险与裁决

| # | 风险 | 裁决 |
| --- | --- | --- |
| 1 | **静默漏发**：通知少一条不会红测试 | 每个 phase 结束真跑一次多 child 会话；P3 的 shadow 日志是唯一判定依据，缺失即不得进 P4 |
| 2 | schema 升 v3，`legion.db` 已有运行中的库 | 迁移必须幂等且向后兼容（旧库打开即加表）；`user_version=2` 的库不得被降级 |
| 3 | 新增事件类型撞 16 类型闭集（`events.ts:3-31` + sentinel） | 已消解：shadow 分歧只写 stderr（D11），不新增事件类型 |
| 4 | `parent_id` 作为 consumer 身份，同名多 consumer 场景 | 一个 child 只有一个 parent，`parent_id` 足够；跨会话恢复时 root 节点 id 稳定（`index.ts:1121`） |
| 5 | `consumeCollect` 的 API 破坏 | 明确 major；不给兼容层（D12） |
| 6 | artifact 目录增长 | 沿用 `finished-cache-eviction` 的预算思路；本版**不做** GC，登记为 v1.1 |
| 7 | 磁盘短写 / 读到半截文件 | A1 的 temp+rename；读侧比对 `bytes` 与 `stat.size`，不符打 `changed-on-disk` 且不推进 `full` |
| 8 | **sentinel 不校验索引的 UNIQUE / FK**（复审 minor）：今天 schema 里没有任何 UNIQUE 与外键，所以无现存不一致；但把 `idx_artifacts_parent` 改成 UNIQUE 不会被哨兵拦住（而它会让同毫秒两条 artifact 插不进去） | 接受，登记为已知盲区；将来加 UNIQUE/FK 时必须同时扩 sentinel（否则那个约束等于无守卫） |
| 9 | 新增 8 个 prepare 点把 `LEGION_STMT_CACHE_LIMIT` 逼到上限（实测 69 个 distinct literal text vs 旧上限 64） | P1 顺手提到 128，并把注释改成实测计数；正确性无影响（超限只是重编译） |

---

## 9. 生效时同步（随 P4 落地，不是现在）

> 先冻契约、后改代码是本仓惯例；但**归档旧契约与改 README 必须跟代码同一步**，否则会出现「文档说没有 claim 模型、代码里全是 claim」的窗口。所以下面 6 条在 P4 的同一个 PR 里做。

1. `git mv docs/contracts/notice-claim-v1.md docs/contracts/archive/`，头部加 `STATUS: HISTORICAL — superseded by ../result-ledger-v1.md`（正文不改，D12）。
2. `notice-delivery-v2.md` §4「与既有契约的关系」追加一行指向本文件。
3. `docs/contracts/archive/README.md` 加一行（HISTORICAL + 取代者）。
4. `README.md` 的 `## Legion tools and phases` 加 `legion_output` 签名；`LEGION_SLASH_HELP_LINES`（`legion-doctor.ts:77-92`）**不需要**改（不新增 slash 子命令）。
5. `docs/design.md:16` 表格与 §3.3.0 outbox 段落同步。
6. `CHANGELOG.md` `[Unreleased]` 一节。

---

## 10. 不在本版范围

1. **通知载荷改指针**（`notice-delivery-v2` §5.1 的 v2.1）—— 本契约保留预览，只改标注。
2. **artifact GC / 保留策略**（v1.1）。
3. **跨进程 claim 的历史包袱**：本契约让 claim 天然可跨重启，但**不**承诺「另一个宿主进程正在读同一个库」的并发语义（WAL 写冲突按既有 `test:wal-stress` 口径）。
4. **ETA 估算**：artifact 的 `(node, phase, phase_since)` 为之后的估算工具提供标定数据，但本契约不实现估算。
5. `index.ts` 的三条 `sendMessage` 旁路（orphan / launch 队列 / blocked 提问）仍不受投影约束。

---

## 11. 修订历史

| 日期 | 版本 | 说明 |
| --- | --- | --- |
| 2026-11-10 | v1 DRAFT | 初版。由 root 会话基于 4 份只读侦察（phases / ledger 数据面 / 扩展接缝 / notice-claim 链路）起草。 |
| 2026-11-10 | v1.1 DRAFT | 用户裁决三项：D6 = 必须读完才抑制；D2 = 允许 `LEGION_DB_USER_VERSION` 升 3；D12 = 旧模型直接删、不做兼容。shadow 瘦身为 stderr-only，事件闭集风险消解。 |
| 2026-11-10 | v1.2 FROZEN | P1 审查后修正：① `undelivered` 必须带 `a.parent_id` 作用域（critical，跨 consumer 串台）；② artifact 不可变 ⇒ `recordArtifact` 必须 `ON CONFLICT(id) DO NOTHING`；③ §7-10 由「<1ms 计时」改为 `EXPLAIN QUERY PLAN` 命中索引；④ D11 的 API 名对齐 `hasRead`。 |
| 2026-11-10 | v1.3 FROZEN | P1 复审通过（3 条 minor 已裁定/修复）：① `LEGION_STMT_CACHE_LIMIT` 64→128（v3 把 distinct SQL 文本推到 69）；② sentinel 不校验索引 UNIQUE/FK 登记为已知盲区（§8-8）；③ `parent_id` 谓词的权威位置是 §15 REV-34。 |
| 2026-11-10 | v1.4 FROZEN | P2 侦察后补：D1a artifact round 来源 = ledger `MAX(round)+1`（不用 runtime 的 report round）；D1b 相同字节不新增 round；D1c 空输出不删历史 artifact（废除「沿用 fs.rmSync 语义」）；D1d name 作路径段必须 sanitize；D1e ledger 写入 best-effort。 |
| 2026-11-10 | v1.5 FROZEN | P2 交付后纠正两处：① D1a 改为 `max(ledger, 磁盘)+1`（只看 ledger 会在库被重置时覆盖已有 artifact，违反 A1）；② D1d 的 `id` 与路径段一律用 sanitize 后的段、`name` 列存原始值（否则与 rebuild 按目录名反推的 id 不收敛）。 |
| 2026-11-10 | v1.6 FROZEN | P2 复审前补 D10 的不对称裁决：rebuild 后 `artifacts.name` 为 sanitize 段；P5 拼 id 必须用 `artifactNameSegment`，禁止按 `name` 列过滤。 |
| 2026-11-10 | v1.7 FROZEN | P3 交付后改 D11：新侧用 `undelivered`（等价于 `reported`）而非 `hasRead`；退出条件拆方向（`old=deliver ledger=suppress` 必须为 0，反向在 P3 必现且预期）；真机需 `index.ts` 接 `getLedgerShadowFacts`。 |

## 12. 裁决记录

| # | 决策点 | 裁决 | 日期 | 影响 |
| --- | --- | --- | --- | --- |
| 1 | `partial` 是否抑制通知 | **不抑制**，只有 `full` 抑制 | 2026-11-10 用户 | D6、§7-2 用例 |
| 2 | 是否允许 DB schema 2 → 3 | **允许** | 2026-11-10 用户 | D2、§8-2 |
| 3 | 是否为 `consumeCollect` 保留兼容形状 | **不保留**，直接删 | 2026-11-10 用户 | D12、`src/api.ts`；发布仍为 major |
