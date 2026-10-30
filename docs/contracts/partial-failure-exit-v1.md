# 部分失败的合法出口：`supersedes` 与 `parent_decision`（v1，冻结）

> 语义由 #309 冻结。实现期发现矛盾 → 停下报告，不得重新解释本契约。
> **本文件是 #309 唯一的 D 编号命名空间**：实现代码与测试注释里的 `#309 Dn` 只解析到这里的
> D1–D4。`#309` 之外的 `Dn`（例如 `docs/legion-v2-contract.md` 的 D11 = 可视化三层、
> D12 = SQLite 账本）与本契约无关；本契约没有 D5 及以后的条款。

## 背景：一个没有任何合法出口的状态

默认机器（`src/legion/phase-machine.ts` 的 `DEFAULT_PHASE_MACHINE`）在 `implementing`
留了三扇门，而「1 个 child failed + N 个 child settled」这种**最常见**的收队形态
一扇都推不开：

| 出口 | 关卡 | 为什么过不去 |
|---|---|---|
| `implementing → reviewing` | `children_present` + `children_none_failed` | `children_none_failed` 只容忍出现在 `handledIds` 里的失败节点 |
| `implementing → failed` | `children_all_failed` | 部分失败不是「全部失败」 |
| `implementing → aborted` | 无 | 走得到，但 `aborted` 是「放弃」不是「判负」，语义错位 |

`handledIds` 的**唯一**生产点在 `requestLegionPhase` 的 `failedHandledIds`，硬前提是
`self.reworkCount > 0`；而 `reworkCount` 只在两条 `rework: true` 的边上自增
（`reviewing → implementing`、`verifying → implementing`）。`implementing` 没有任何
rework 边 → **自锁**。与此同时 `to: "failed"` 在 `requestLegionPhase` 里被一句
`${to} is controlled by the parent or supervisor` 硬拦，状态机根本跑不到。

而状态机一侧其实**早就留好了口子**：`terminalReason: "parent_decision"` 在
`evaluateDeclaredFailure` 里无条件放行。`src/` 里零生产者——口子造好了，没人走过。

## 冻结决定

### D1 — 让 `parent_decision` 有真实生产者：centurion 可显式判负

`legion_phase` 新增可选入参 `reason?: string`。终态守卫从「三个都硬拦」改成：

| `to` | 条件 | 结果 |
|---|---|---|
| `done` | — | 仍然硬拦（supervisor / 父级产物，centurion 不得自行宣告成功） |
| `aborted` | — | 仍然硬拦（`aborted` 是父级 retire 的紧急停止，不是 centurion 的按钮） |
| `failed` | `reason` trim 后非空 | 放行，`terminalReason: "parent_decision"` 传给状态机 |
| `failed` | `reason` 缺失/空白 | 拒绝，文案点名缺 `reason` |

落库走**既有**接受路径（`updateNode` + `appendEvent`），没有新通道。`phase_change`
事件的 `data` 带上 `terminalReason: "parent_decision"` 与 `reason`，于是「谁、为什么判负」
是账本里的一条可查事实，而不是模型的一句话。成功回执逐字为
`Team failed by centurion decision: <reason>`。

**判负不是聚变**：它只提交 `implementing → failed` 这一条机器本来就声明的边。非法边
（例如从终态再判负）照旧由状态机拒绝——工具面不为它开特例。

### D2 — 让 `handled` 有第二个诚实生产者：显式 `supersedes`

`legion_phase` 新增可选入参 `supersedes?: string[]`，每项是本团队的**直接子节点**
`name` 或 `id`。校验三条，任一不满足即拒绝（文案点名是哪一项）：

1. 每项都能解析成本团队的直接子节点；
2. 该子节点 `status === "failed"`；
3. 团队里**至少有一个 `status === "settled"` 的直接子节点**。

通过后把这些 id **并集**进 `failedHandledIds`，并在接受路径上写一条
`node_handled` 持久事件（`data = { handledId, byNodeId, reason? }`）。空数组等价于
没传：不校验、不写事件、不改并集。节点表不加列，`reworkCount` 语义与
`updatedAt < phaseSince` 的时间比较规则一个字都不改。

#### 为什么 `supersedes` 必须要求一个 settled 兄弟

`handled` 这个状态的**语义**是「这个失败已经被处理掉了」，不是「这个失败被一笔勾销」。
`settled` 兄弟是这句话唯一可验证的证据：有人接着把活干了。少了这一条，`supersedes`
就退化成一句「我说它没事」，`children_none_failed` 变成可以随口清空的关卡——那正是
`children_all_failed` 那条边试图防的事，只是换了个方向。

同一理由决定了 `children_all_failed` 不能被 `supersedes` 绕开：全部失败时没有
settled 兄弟，第 3 条校验直接不成立，机器照旧强制判负（`all_children_failed`）。
两条路互不侵占。

#### 为什么 `handled` 不持久化

现有 `handledIds` 是**每次请求时现算**的（`reworkCount > 0` + `updatedAt < phaseSince`），
不是账本里的一个布尔位。保持这个形状有三个具体好处：

- **没有第二个真相**：入列/出列不需要在两处同步，也就不存在「表里说 handled、条件里
  说没 handled」的漂移；
- **rework 后自动失效**：`updatedAt < phaseSince` 让上一轮的「已处理」在新一轮里自动
  作废——失败的 child 一旦被 retry 成功，它就不再是失败，也就无需谁去撤销标记；
- **schema 冻结**：`nodes` 表 19 列由 `test/unit/legion-schema-sentinel.test.ts` 守着
  （`docs/legion-v2-contract.md` D12）。加一列 = 动账本合约，代价远大于收益。

`node_handled` 事件是**审计**（谁在什么时候把哪个失败认定成已处理），不是**状态**。
读 `handledIds` 的代码一行都不读这个事件——它的存在不改变任何判定。

#### 与 `updatedAt < phaseSince` 的关系

两个来源是**并集**，各自独立：

| 来源 | 归谁 | 何时进 `handledIds` |
|---|---|---|
| rework 期间已修复的失败 | 机器自动 | `reworkCount > 0` 且 `child.updatedAt < phaseSince` |
| 显式 `supersedes` | centurion 主动 | 本次请求带 `supersedes`，且三条校验通过 |

- `supersedes` **不**放宽时间规则：它不把「`updatedAt` 晚于 `phaseSince` 的失败」变成
  已处理，只是**额外**给出一个由 centurion 署名、带 settled 兄弟作证的来源。
- 反过来，`updatedAt < phaseSince` **不**因为它存在就自动关闭校验：只要本次请求带了
  `supersedes`，第 1/2/3 条校验照跑（写进账本的每一条 `node_handled` 都必须成立）。
- 并集去重：同一个 child 同时被两条路覆盖只算一次。

### D3 — 拒绝文案必须列出真实可达的动作

`children_none_failed` 失败时的文案（`describeFailedCondition`）改成同时给出两条
**今天真的可调用**的路：

```
a child failed and must be handled: pass supersedes:[<failed child>] once a replacement has settled, or declare to:"failed" with a reason to fail the team
```

旧文案（`a child failed and must be reworked or the team must fail`）建议的两个动作在
今天的代码里**都不可达**：`implementing` 没有 rework 边，`to:"failed"` 被工具面硬拦。
一句「按它做就一定会再被拒」的提示，比没有提示更贵——模型会照着它重试到预算烧完。

### D4 — 错误码卫生

- 新增 `ErrorCodes.CHILD_TERMINAL`；`orchestrator.ts` 里两处
  `legion child is terminal and cannot be resumed` 不再冒充 `BUDGET_EXCEEDED`
  （它们与预算无关，冒用会让上层把「终态」误判成「预算耗尽」）。
- `index.ts` 的 `reviveChild` catch 不再把所有错误一律改写成 `START_FAILED`：
  `SubagentError` 且已有明确 `code` 时**保留该 code**，其余维持 `START_FAILED`。
- 错误码**只走 `details.error`**，不拼进用户可见正文：`test/unit/teams.test.ts` 与
  `test/integration/launch-queue.test.ts` 都钉了「正文不得出现 `BUDGET_EXCEEDED`」。

## 为什么不用自环 `implementing → implementing`

自环是这个问题最直觉的解法，也是**唯一被机器明确禁止**的解法：

- validate 期 `validatePhaseMachine` 拒自环；
- 运行期 `evaluateDeclarative` 以 `same_phase` 拒绝（`from === to`）。

更重要的是语义：自环会把「重新派工一轮」编码成一次相位迁移，而 `reworkCount` 的自增
是挂在 `rework: true` 的**边**上的。让自环兼作 rework 边，等于把「同一相位重来」和
「预算计数」绑在一起——`updatedAt < phaseSince` 这条时间规则随即失真（`phaseSince`
被自环刷新，上一轮记下的失败会因为时间戳比较翻转而凭空变成「未处理」）。要凑出的
效果是「已处理的失败不再挡路」，那就直接、显式地说「已处理」，不要绕道去动迁移图。

因此本契约**不动** `src/legion/phase-machine.ts` 的边表：没有新边，没有新相位，
`test/unit/legion-state-machine.test.ts` 的 §7.1 矩阵与 19 条原因表原样绿。

## `node_handled` 与事件闭集

`appendEvent` 按闭集 `LEGION_EVENT_TYPES` 校验，`mapEvent` 遇到不认识的存量类型会抛错
——这正是 #233 的游标冻结事故。所以 `node_handled` 必须**加入闭集**，并同步修订两处
把该闭集内容钉死的清单断言（`test/unit/legion-events.test.ts` 的条数、
`test/unit/teams.test.ts` 的 `#266 A13` stored closed set）。**这是清单条数的机械更新，
不是为了让红灯变绿**：写入方与读取方仍在构造上一致，事故模式没有被重新引入。
`LEGION_PROCESS_EVENT_TYPES`（仅进程内、不落库）保持 11 条不变。

## 验收清单

| # | 事实 |
|---|---|
| 1 | 1 failed + 1 settled + `reworkCount === 0`，`legion_phase{to:"reviewing"}` 被拒，原因仍是 `failed_worker_unhandled` |
| 2 | 同上 + `supersedes:[<failed name>]` → 放行到 `reviewing`，且账本里多一条 `node_handled` |
| 3 | `supersedes` 指向 settled 兄弟 / 不存在的名字 → 拒绝并点名该 entry，相位不动 |
| 4 | `legion_phase{to:"failed", reason:"…"}` → `phase === "failed"`，事件带 `terminalReason: "parent_decision"` |
| 5 | 缺 `reason` 的 `to:"failed"` 被拒；`to:"done"` / `to:"aborted"` 仍被拒 |
| 6 | `children_none_failed` 的拒绝文案同时含 `supersedes` 与 `to:"failed"` |
| 7 | 终态 resume 的错误码是 `CHILD_TERMINAL`，且工具正文不含 `BUDGET_EXCEEDED` |
| 8 | `src/legion/phase-machine.ts`、`nodes` 表 19 列、§7.1 矩阵、19 条原因表**均未改动** |
