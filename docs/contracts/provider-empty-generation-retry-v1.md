# Provider 空生成单次重试契约 v1（FROZEN）

> 状态：**FROZEN**（#316 设计裁决）。
> 冲突时**停下报告**，不得重新解释本契约。
> 关联：#316（provider `finish_reason: error` 空生成）、#309（失败节点成为永久 phase 门）、
> #232（`waitOutTransientConnection` 的轮询退避）、`docs/contracts/subagent-renewal-v1.md`（renewal 预算）。

---

## §1 问题陈述

provider 可以在 **HTTP 200** 之后在流内终止生成：pi 的 `mapStopReason` 把未知
`finish_reason` 落到 `{ stopReason: "error", errorMessage: "Provider finish_reason: " + reason }`。
该 message 同时撞不上上游 `isRetryableAssistantError` 的 `NON_RETRYABLE` 与 `RETRYABLE`
两套正则，provider 层的 `maxRetries` 也只包住抛出的 HTTP 错误，于是**全链路一次都不重试**。

实测签名（#316 报告，两例，分属两个 team 子树、两种角色）：

| 字段 | 值 |
|---|---|
| `stopReason` / `rawStopReason` | `error` / `error` |
| `content` | 空（无 `text`、无 `toolCall`） |
| `usage.input` | **0** |
| `usage.output` | 2 / 42（极小） |
| `durationMs` | 92–175 s（正常轮次 6–41 s） |

本仓原有唯一的瞬时兜底是 `isTransientConnectionFailure`（只匹配 `/connection error/i`）+
`waitOutTransientConnection`，而后者**只轮询 session 文件、从不重发 prompt**：对空生成这一类，
等待永远不会产生新消息——child 活着且空闲，只有**新的一轮 prompt** 才能把它救回来。

---

## §2 D1 — 判据：按 transcript 形状，不猜 provider 字符串

`src/shared/session.ts` 导出：

```ts
export function isEmptyGeneration(parsed: Pick<ParsedSession, "turns">): boolean;
```

**四条件全部满足**才算空生成：

1. 最后一轮存在 assistant 记录（硬杀死的轮次没有）；
2. 该记录的 `stopReason === "error"`；
3. `text.trim() === ""`；
4. `tools.length === 0`。

**刻意不看的东西**（写死在这里，避免下次有人"顺手加一条"）：

- **不看 `usage`**。`usage.input === 0` 只是显示层素材（`src/extension/summary.ts`），
  用它做判定等于把展示层语义升格成控制面契约；报告里它也只是签名的一部分，不是判据。
- **不匹配 `errorMessage` 文本**。`isTransientConnectionFailure` 那种"撞字符串"的做法正是
  #316 漏网的原因：上游换一句文案就失效。形状判据不受文案影响。

`deriveOutcome` 在该形状落到 `failed` 时置 `Execution.errorKind = "provider-empty-generation"`
（`outcomeFromFinalMessage` 的 `case "error"` 非 abort 分支）。这是它**唯一**的置位点：

- `aborted` 永不置位——父子 abort 不是 provider 故障，重发 prompt 会被当成新任务；
- `success` / `truncated` 永不置位——有产出的失败是"任务失败"，不是"这一轮丢了"。

---

## §3 D2 — collect 内有界重试一次

位置：`src/runs/orchestrator.ts` 的 `Orchestrator.collect()`，`deriveOutcome` 之后、
`finishCollect` 之前。

前置条件（**全部**满足才重试）：

| 条件 | 理由 |
|---|---|
| `execution.status === "failed"` 且 `errorKind === "provider-empty-generation"` | 只治这一种故障 |
| `supervisor.isAlive(name)` | 死掉的 child 收不了 prompt |
| `!signal?.aborted` | abort 不得变成新一轮 |
| `(child.providerRetriesUsed ?? 0) < 1` | 上限 1 次 |

动作：

1. `await supervisor.prompt(name, CONTINUE_PROMPT)`，`CONTINUE_PROMPT` 逐字为
   `Your previous turn ended with no output. Continue from where you left off; do not restart the task.`
   （child 仍在同一会话里持有原任务上下文，所以是 continue 不是 restart）；
2. `providerRetriesUsed += 1`（**仅在 prompt 被接受之后**计费；prompt 抛错说明 child 已死，
   原判与预算都不动）；
3. 复用 `waitSettled`（经 `awaitSupervisor`，因此仍会尊重 abort 与 UI 阻塞）等这一轮 settle；
4. 重 `parseSessionFile` + 重 `deriveOutcome`。

不变量：

- **只重试一次**：计数器在 `ChildRecord` 上，跨 collect（乃至跨进程 `restore`）保持；
- 不得 `recordSettled` 两次、不得写两份 `.output.md`：重试发生在 `finishCollect` 之前，
  终局只经过那一个出口；
- 重试轮的 settle 若是 `timeout` 且 child 仍活着、最后一轮尚未完成，则沿用既有的
  `running` + `COLLECT_DEADLINE_REASON` 快照（不把"还在生成"说成 abort 或 failed）；
- `renewalsUsed` 一行都不动（见 §5）。

---

## §4 D3 — 可观测性

- `TurnRecord.assistants[]` 新增可选 `responseId?: string`：上游 assistant 消息自带该字段，
  此前被丢弃。**纯透传**，任何判定都不读它。
- `recordSettled` 写 `node_failed` 事件时，data 在既有 `{ execution, reason }` 不变的前提下
  追加 `errorKind`（无值时不写该键）。父级与 ledger 查询因此能区分
  "provider 空生成" 与其它 `failed`，不必再读 transcript 猜字符串。

---

## §5 为什么上限是 1 次（以及为什么不复用 renewal 预算）

**上限 1 次**：故障形态是"一次上游流终止"。同一次 collect 内第二次仍然得到空生成，
说明 provider 此刻是持续故障而不是偶发——再 prompt 一次要付真实的 token 与墙钟，
换不回新信息。第二次之后的处置属于父级决策（`continue` / 改名重派 / 人工介入），
不该由运行时做成自动循环。有界是硬要求：无限重试会让一个坏 provider 变成烧钱循环，
并且与 #309 的"失败要能被看见"直接冲突——把失败重试到看不见，比一次失败更糟。

**不复用 `renewalsUsed`**：

- renewal 是**面向用户的预算**（`subagent-renewal-v1.md` §6），授予机制是
  "没有可测进展 → 提议给父级/人"，且普通 `failed` 的 collect **刻意不扣费**
  （`test/unit/renewal-wiring.test.ts`）。把自动重试记进 renewal，
  等于让一次 provider 抖动吃掉人给的续命额度。
- renewal 的语义是**重新开跑**（resume/relaunch，可能换进程、换 worktree 基线），
  而这里要的是同一个活着的 child **继续下一轮**。两者不是同一个动作，共用一个计数器只会
  让两边的账都算不清。

因此：独立计数器 `ChildRecord.providerRetriesUsed`，缺省读作 0（#266 时代的老记录同样适用）。

---

## §6 刻意不做的事

- **不改 `isTransientConnectionFailure` 的语义**：`/connection error/i` 的既有行为与
  `waitOutTransientConnection` 的轮询路径原样保留；它现在在 docstring 里写明
  "只覆盖 connection error，不覆盖 provider 空生成"。
- **不改 ledger 状态闭集**、不改 `shouldRecycleAfterCollect`
  （`failed` 仍然 `true` → 自动 retire，重试只是把这一判定推迟到重试之后）。
- **不做无限重试**，不做指数退避重试队列。
- **不解析 `finishReason`**：本仓不读该字段，判据全部落在 `stopReason` + 内容形状上。
- **不修上游**（`pi-ai` / `pi-coding-agent` 的 retry 分类）：那是另一个仓；本契约为
  legion 侧兜底，契约范围仅限本仓。
