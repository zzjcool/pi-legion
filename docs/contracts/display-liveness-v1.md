# 展示层活性判定统一契约 v1（FROZEN）

> 状态：**FROZEN**（2026-10-24 用户裁决"直接第二步"）。
> 冲突时**停下报告**，不得重新解释本契约。
> 关联：#209-3（owner 判定）、#238（burst 合并 / KNOWN LIMITATION）、#266（queued 状态）。

---

## §1 问题陈述

用户报告（原话）：

> 轨道图上有还在处理的，就是还在处理，他没了就没了，不要说什么延迟什么的，
> 我看起来就是时间没有对齐啊。

现象（均已复现）：

1. `subagent({action:"status"})` 显示 `Status · 1 live child`，同一个 child 又显示
   `owner: dead (pid gone)` + `state=failed` —— **死掉的 child 被计入 live**。
2. 后台通知说某 child `still running`，同时 `status all` 返回 `No live children`。
3. `collect` 还能读出该 child 的完整报告（从 JSONL 历史重放）。
4. 轨道图上某节点停在 `running`，而该子进程早已死亡。

用户不接受"延迟投递"作为解释。**判定：用户的判断正确——这是时间语义错误，不是延迟。**

---

## §2 根因（已确证，带证据）

### R1 — "活着"没有单一权威定义，散落在 3 类地方

| 位置 | 判定方式 | 证据 |
|---|---|---|
| 列表筛选 | 只看 `child.state ∉ {retired, exited}` | `index.ts:3230` |
| 文本渲染 | **额外**算 owner dead | `src/extension/runtime.ts:399-404` |
| 轨道图 | `eventOverrides` + 账本行按时间戳竞选 | `src/extension/runtime.ts:702, 837-848` |

后果：同一个 child 可以同时是 `live`（列表）和 `failed`（文本）和 `running`（轨道图）。

### R2 — 跨写入方时钟被当作单调可比

```ts
// src/extension/runtime.ts:837
if (node && event.ts >= node.updatedAt) {        // 第 1 道
// src/extension/runtime.ts:839
if (!previous || event.ts >= previous.ts) {      // 第 2 道
// src/extension/runtime.ts:702
if (override && override.ts >= node.updatedAt) { // 第 3 道
  ...
} else {
  if (override) eventOverrides.delete(node.id);  // ← 永久删除 override
  tree.set(node.id, { ...node });                // ← 采信账本行
}
```ts

- `event.ts` 由**父进程**事件总线打时间戳。
- `node.updatedAt` 由**子进程**写账本时打时间戳（`src/legion/nodes.ts:184`），
  且**只在心跳时推进**：`src/extension/legion-tools.ts:145`
  ```ts
  const alive = children.filter((child) => this.supervisor.isAlive(child.name));
  if (alive.length === 0) return;   // ← 死了就不写心跳
```ts
  **子进程一死，`updatedAt` 永久冻结。**

**判定**：两个不同写入方的时钟**不构成全序**，用 `>=` 比较它们本身就不成立。
第 3 道在 override 比账本行旧时**把 override 永久删除**，于是：

> 一个已 `settled` 的节点，若账本行停在 `starting`（子进程死了），
> 下一轮 `snapshotNodes()` 会删掉 settled override 并采信 `starting`
> → **轨道图把已结束的节点拉回"还在跑"。**

这正是用户看到的"没有对齐"。

### R3 — 七个状态集合互不相同，且都不含 `queued`

| 集合 | 定义位置 | 内容 |
|---|---|---|
| `RUNNING` | `src/tui/viz/model.ts:59` | starting, working, running, blocked |
| `RUNNING_STATES` | `src/tui/status.ts:361` | starting, working, running |
| `ACTIVE_STATES` | `src/tui/status.ts:362` | RUNNING_STATES + blocked |
| `TERMINAL_STATES` | `src/tui/status.ts:363` | settled, success, completed, failed, aborted, retired, awaiting, unknown |
| `ACTIVE_STATUSES` | `src/tui/tree-view.ts:20` | starting, running, blocked |
| `TERMINAL_STATUSES` | `src/tui/tree-view.ts:21` | settled, failed, retired |
| `LIVE_NODE_STATUSES` | `src/extension/legion-status.ts:43` | starting, running, blocked |
| `LIVE_CHILD_STATUSES` | `src/legion/nodes.ts:25` | starting, running, blocked |

`displayStatus()`（`src/tui/viz/model.ts:72-78`）的兜底是 `return "retired"`，所以：

```ts
displayStatus("idle")    === "retired"   ← idle 在轨道图上显示成"已退休"
displayStatus("queued")  === "retired"   ← queued 显示成"已退休"
displayStatus(undefined) === "retired"
```ts

### R4 — 孤儿检测只报告，不收敛

```ts
// src/extension/legion-tools.ts:251
const event = appendEvent(this.db, node.id, "orphan_detected", {...});
this.eventBus?.emit(event);
this.sendRootMessage(`Legion orphan detected at ...`);
// ← 没有 updateNode()：node.status 仍是 running
```ts

`orphanStaleMs` 默认 90s（`src/shared/types.ts:571`），但**只发消息不改状态**。
启动期 `hygiene` 有 `node_abandoned` 路径（`src/runs/hygiene.ts`），但阈值是
`staleNodeHours` 默认 **72 小时**，且只在启动时跑。

### R5 — 已有代码承认过这个病，但选择了"让用户自己判断"

`src/extension/legion-tools.ts:258-264` 的注释：

> The notice can be delivered long after detection: it is queued through
> `subagent-notify` and the outbox flushes at `MAX_PENDING_AGE_MS` or at
> `agent_settled`. A stale `staleMs` alone therefore reads as "detected just
> now" when the value can be tens of minutes old, which makes a replayed
> notice look like a fresh detection. **Stamp the detection time so a late
> delivery is self-evident.**

**判定**：这是把时序缺陷转嫁给读者。v1 改为从根上消除，不再靠时间戳自证。

### R6 — `#238` 的 KNOWN LIMITATION 与本契约的关系

`test/unit/runtime.test.ts:3349` 明确钉住：

> a mid-burst ledger write can make the painted status differ from a per-event re-read
> ...
> reproducing a SEQUENCE of reads is not possible with a constant number of reads,
> which is why this is bounded and documented rather than fixed.

**判定：该结论对本契约不构成障碍，因为本契约不试图"复现读取序列"。**
它改变问题：**渲染不再是从事件序列累积出的状态，而是对"渲染时刻的事实"做一次纯投影。**
同一时刻的事实只对应一个答案，故不存在序列依赖。
该用例将改为断言"同一 facts 的任意读取次数得出一致结果"（见 A6）。

---

## §3 决策

### D1 — 单一权威：`liveness()` 是唯一的"活着"判定

新增纯函数模块 `src/extension/liveness.ts`（**无 fs / 无 db / 无 timer / 无 clock 读取**，
所有输入由调用方传入）：

```ts
export type Liveness = "live" | "dead" | "unknown";

export interface LivenessFacts {
  /** 进程内注册表里是否存在且状态未终态。 */
  readonly inMemory?: { readonly state: string } | undefined;
  /** 账本行的状态与心跳时刻（可能来自已死进程）。 */
  readonly ledger?: { readonly status: NodeStatus; readonly updatedAt: number } | undefined;
  /** run.json 的 child 记录状态（调度层）。 */
  readonly record?: { readonly state: string } | undefined;
  /** pid marker 的存活判定结果；undefined = 没有 marker。 */
  readonly pidAlive?: boolean | undefined;
  readonly now: number;
  readonly staleMs: number;
}

export function liveness(facts: LivenessFacts): Liveness;
```ts

**判定顺序（全序，不是"任一为真"）**：

```text
1. inMemory 存在且非终态            → live    （最强：本进程正在持有它）
2. inMemory 存在且是终态            → dead
3. pidAlive === true               → live    （有进程真在跑）
4. pidAlive === false              → dead    （进程确认已亡，D4 接受窗口）
5. ledger 非终态 且 now - updatedAt < staleMs → live   （心跳未过期）
6. ledger 非终态 且心跳已过期        → dead    （孤儿：D7 收敛）
7. record 是终态                    → dead
8. 其余（含全部 undefined）          → unknown （绝不猜）
```ts

**为什么是顺序而非并集**：并集会让"某处残留一条 running 账本行"永久压过
"本进程已确认它死了"。顺序保证**更强的证据胜出**，且 `unknown` 是一个明确的
第三态而非"当活处理"。

### D2 — 三态而非二态

`unknown` 必须存在且**不得**被当作 `live` 展示。
理由：把未知当活是当前 `status` 显示 `1 live child`（owner 已死）的直接原因；
把未知当死会误杀正在启动的 child。第三态是唯一诚实的选项。

### D3 — 跨写入方时钟不可比较（硬禁令）

**禁止**在任何地方用 `>=`/`<=`/`>`/`<` 比较**来自不同写入方**的时间戳。

具体：`event.ts`（父进程总线）与 `node.updatedAt`（子进程账本）之间的比较
**全部删除**。事件只用于**触发重算**，不再用于**决定谁的结论胜出**。

验收：`src/` 下不存在 `event.ts` 与 `updatedAt` 的直接比较。

### D4 — pid 窗口接受（用户裁决 1）

`pidAlive === false` 立即判 `dead`。不做心跳宽限、不加第二套时间语义。
理由：pid 探测是最接近操作系统事实的判据；加宽限等于重新引入"时间没对齐"。

已知窗口：进程刚退出、`isPidAlive` 尚未观察到的**秒级**窗口，接受。

### D5 — `idle` 与 `queued` 是一等展示态（用户裁决 2）

`displayStatus()` 的兜底 `retired` 必须拆开：

| 输入 | 输出（`VizStatus`） | 展示 |
|---|---|---|
| `idle` | `idle`（新） | **灰**：`idle · 占槽待唤起` |
| `queued` | `queued`（新） | `queued(n)` |
| `starting` / `working` / `running` / `blocked` | `running` | 不变 |
| `settled` / `success` / `completed` / `done` | `settled` | 不变 |
| `failed` / `aborted` / `error` / `truncated` | `failed` | 不变 |
| `retired` | `retired` | 不变 |
| 其余 / undefined | `unknown`（新） | `unknown`，**不显示为 retired** |

**为什么 `idle` 要显示而不是隐藏**：`idle` 的 child 仍然活着、仍占并发槽（F9），
两个事实都要传达。标灰是"活着但没在干活"的准确表达。

### D6 — 所有出口从 `liveness()` 派生

以下出口**必须**调用 `liveness()`，不得自行判定：

1. `subagent({action:"status"})` 列表筛选与头部计数（`index.ts:3223-3272`）
2. `renderLiveChildStatus` 的 `state`/`owner` 行（`src/extension/runtime.ts:399-416`）
3. `/legion` galaxy 全视图（`src/tui/viz/model.ts`）
4. `/legion --tree` 与 paged tree（`src/tui/tree-view.ts`）
5. `/legion status`（`src/extension/legion-status.ts`）
6. 状态小部件 / strip（`src/tui/status.ts` 的 `filterLiveTree` / `isActiveEntry`）
7. completion notice 投递前的终态复核（`src/extension/runtime.ts` 的 `flushOutbox`）

**不再**允许出现局部的 `state !== "retired" && state !== "exited"` 式手写判定。

### D7 — 孤儿必须收敛，不只是报告

`scanOrphans` 命中（`legion-tools.ts:241-252`）时，除现有事件与消息外，
**必须**把账本行收敛到终态：

```ts
updateNode(db, node.id, { status: "failed" }, timestamp);
appendEvent(db, node.id, "node_abandoned", { reason: "no_active_supervisor", ... });
```ts

理由：`orphan_detected` 只描述"发现了孤儿"，不改变事实；而用户要的是
"他没了就没了"。收敛后 `liveness()` 的第 5 步自然给出 `dead`，无需任何展示层特判。

**不得**复用 `hygiene` 的 72 小时阈值；孤儿判定阈值是 `orphanStaleMs`（默认 90s）。

### D8 — 渲染是纯投影，不是事件重放

`snapshotNodes()` / `refreshUi()` / `vizSnapshot()` 的语义改为：

> 在时刻 T 读取一次事实（进程内注册表 + 账本 + run.json + pid），
> 用 `liveness()` 投影出展示状态。

`eventOverrides` 降级为**纯延迟优化**（事件到达时先乐观更新，减少一次读库），
但**每次 `refreshUi()` 必须用事实校正**。校正规则：无条件以 `liveness()` 结果为准，
**不做时间戳竞选**。

### D9 — 保留 `NODE_STATUSES` 闭集

`queued` / `idle` **仍然不得**进入 `src/legion/nodes.ts` 的 `NODE_STATUSES`
（六值闭集，两条 SQL 硬编码六个 `?` 占位符）。它们是**展示态**，不是账本态。
`test/unit/legion-nodes.test.ts` 的 A16 tripwire 保持不变。

---

## §4 实施切分

| 单元 | 文件 | 内容 |
|---|---|---|
| **W1** | `src/extension/liveness.ts`（新） | D1 `liveness()` + D2 三态 + D5 状态映射表；纯函数，无 I/O |
| **W2** | `src/extension/runtime.ts` | D3 删除三处时钟比较；D6 出口 2/5/7；D8 纯投影 |
| **W3** | `index.ts` | D6 出口 1（`listLiveChildrenForStatus` + `renderStatusOverview`） |
| **W4** | `src/tui/viz/model.ts`, `src/tui/status.ts`, `src/tui/tree-view.ts`, `src/extension/legion-status.ts` | D5 新展示态 + D6 出口 3/4/5/6，集合归一 |
| **W5** | `src/extension/legion-tools.ts` | D7 孤儿收敛 |
| **W6** | `docs/`, `CHANGELOG.md` | 文档与迁移说明 |

**文件归属（禁止越界）**：每个 W 只能改自己那一行的文件。
`src/extension/liveness.ts` 由 W1 独占创建，其余 W 只读引用。

---

## §5 验收

| 编号 | 断言 | 归属 |
|---|---|---|
| **A1** | `liveness()` 的 8 条判定顺序逐条覆盖；`unknown` 不被展示为 live | W1 |
| **A2** | 已 `settled` 的节点，账本行冻在 `starting` 且心跳过期 → 渲染为终态，**不被拉回 running**（R2 回归） | W1+W2 |
| **A3** | `owner: dead` 的 child **不计入** `Status · N live`（改正 `status-action.test.ts:301`） | W3 |
| **A4** | `displayStatus("idle") === "idle"`、`("queued") === "queued"`、`(undefined) === "unknown"` | W4 |
| **A5** | 孤儿超过 `orphanStaleMs` → 账本行变 `failed` + `node_abandoned` 事件；`liveness()` 随后给 `dead` | W5 |
| **A6** | 同一组 facts 连续投影 100 次结果恒定（替代 `#238` KNOWN LIMITATION 的收敛断言） | W1+W2 |
| **A7** | `src/` 中不存在 `event.ts` 与 `updatedAt` 的比较（D3 静态守卫） | W2 |
| **A8** | `queued`/`idle` 未进入 `NODE_STATUSES`；A16 tripwire 仍绿 | W4 |

---

## §6 迁移影响（已知会打翻的既有断言）

| 测试 | 现有断言 | 处置 |
|---|---|---|
| `test/unit/status-action.test.ts:301` | `/Status · 1 live child/`（死 child 算活） | **改为** `0 live` + 单独列出 dead |
| `test/unit/status-action.test.ts:302-304` | `state=failed` + `owner: dead` | 保留文案，但不再计入 live |
| `test/unit/runtime.test.ts:3349` | `#238` KNOWN LIMITATION「settled vs retired 分叉」 | **改为** A6 的收敛断言 |
| `test/unit/legion-viz.test.ts:64-65` | `displayStatus("idle") === "retired"` | **改为** `=== "idle"` |
| `test/unit/legion-status.test.ts`（12 条） | 逐行文本锁 | 逐条复核，`state=` 词表可能变 |
| `test/unit/status.test.ts`（36 条） | 小部件清空/折叠 | 复核 `idle` 从"消失"变"标灰" |

**要求**：每一处改动必须在 commit message 里写明"为什么旧断言是错的"，
不得只改数字。

---

## §7 禁令

1. **禁止**用时间戳比较决定展示状态（D3）。
2. **禁止**把 `unknown` 当 `live` 或当 `dead` 处理（D2）。
3. **禁止**给 pid 判定加心跳宽限或第二套时间语义（D4）。
4. **禁止**把 `idle`/`queued` 塞进 `NODE_STATUSES` 闭集（D9）。
5. **禁止**在展示层手写 `state !== "retired" && state !== "exited"` 式局部判定（D6）。
6. **禁止**让 `orphan_detected` 只发消息不改状态（D7）。
7. **禁止**在 `liveness.ts` 里读 `Date.now()` / fs / db / timer（D1 纯函数约束）。
