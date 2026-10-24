# 子 agent 续约契约 v1（FROZEN）

> 状态：**FROZEN**（2026-10-24 用户提出"能不能加个续约的能力"）。
> 冲突时**停下报告**，不得重新解释本契约。
> 关联：#270（本契约跟踪号）。

---

## §1 问题陈述

用户原话：

> 能不能加个续约的能力，比如上层 agent 看到超时了，可以看看他实际有没有推进，
> 如果实际推进了，他可以选择续约，让任务继续，而不是丢弃，
> 不然 worker 的工作浪费了

### 实际发生的事（已确证）

一天之内两次：

| 事件 | 结果 |
|---|---|
| `W2`（`runtime.ts` 的 D3 投影改造） | 30 分钟耗尽，**零产出落盘** |
| `W4`（TUI 五文件） | 代码写完，卡在验证/报告；**已找到的编译错误被它自己 revert 掉了**（为了守文件归属纪律） |

两者都不是"做错了"，而是**在正确的路径上被切断**。

### 关键事实（侦察确证，带证据）

1. **session 文件完整保留。** `.pi-subagents/runs/r-491ceace/worker-3.jsonl`
   有 271 行 / 1.4MB，最后一条是 `thinking` —— 说明它是**在思考或工具执行中途**被切断的。
2. **续接机制已经存在。** `index.ts:1844-1861` 的 `reviveChild`：
   ```ts
   if (supervisor.isAlive(name)) {
       await orchestrator.steer(name, params.message);   // 活着：追加消息
   }
   const handle = await orchestrator.launch({ agent, task, name, ... });  // 死了：复用 session
   // → "Context preserved from <sessionFile>"
   ```
3. **两种超时必须区分**（这是 §3 D1 的基础）：
   - `wait { timeoutMs }` / `collect { timeoutMs }`（`index.ts:1768`, `:2616`）
     → **父侧放弃等待，不杀 child**。`inprocess-supervisor.ts:1084` 只 `resolve({settled:false, reason:"timeout"})`。
   - 角色 `timeoutMs`（`agents/worker.md:9` 等）
     → 由 **pi 宿主**执行，child 被终止。pi-legion 源码里**没有** `terminated` 这个字面量
     （全仓 grep 只命中 `src/shared/session.ts:912` 的 "terminated during tool call" 文案）。

**结论：pi-legion 无法阻止宿主终止 child，但能在终止后识别、评估、续约。** 契约按此边界设计。

---

## §2 根因（为什么现在做不到）

### R1 — 超时终止被当成"失败"，没有分类

`execution: failed (terminated)` 在展示层与其他失败混在一起。
父会话看到的是一条"失败通知"，没有"这个 child 被超时切断、其 session 可续"的语义。

### R2 — 没有"推进度"概念

要判断"该不该续约"，必须回答"这 30 分钟他是在干活还是卡死"。现有信号分散：

| 信号 | 位置 | 能回答 |
|---|---|---|
| `lastJsonlEventAgeMs` | `runtime.ts` | 最近一次活动距今多久 |
| `progressFromSessionFile` | `src/shared/progress.ts` | 解析出的进度摘要 |
| `NodeActivity{turn,tools,turnStartedAt}` | `runtime.ts` | 第几轮、用过什么工具 |
| `COLLECT_DEADLINE_REASON` | `orchestrator.ts:280` | 父侧放弃等待（≠ child 死） |

但**没有任何一个**被用来回答"该不该续约"。

### R3 — `wait`/`collect` 超时与 child 终止被混为一谈

`inprocess-supervisor.ts:1084` 的超时只表示"我没等到"，child 可能还在跑。
把它当成 child 失败会导致**错误地重派**（浪费）或**错误地放弃**（丢失）。

---

## §3 决策

### D1 — 只对"真终止 + 有推进"提议续约

续约提议的**必要且充分条件**：

```
1. child 确实被终止（不是父侧 wait/collect 超时）
2. 自上次续约点以来有可观测推进
3. 该角色允许续约（见 D5）
```

任一条不满足 → **不提议**，退回现有行为。

**理由**：无推进的续约只是把卡死延长一个预算周期，还占着并发槽。
这正是角色 `timeoutMs` 存在的意义。

### D2 — 推进度用"产出信号"，不用"存活时间"

**判据（按可靠度）**：

| 优先级 | 信号 | 判读 |
|---|---|---|
| 1 | session JSONL 中**新增**的 `toolResult` 行数 | 真做事的最强证据（工具有返回） |
| 2 | session JSONL 中**新增**的 `assistant` 消息数 | 有产出（写了代码/报告） |
| 3 | 文件系统副作用（工作树内改动数） | 直接证据，但读盘贵 |
| 4 | `lastJsonlEventAgeMs` 变小 | **不采用**：只说明有 token 流动 |

**明确排除**：进程存活、CPU 时间、token 消耗 —— 这些在"卡在一个失败循环里"时同样增长。

**阈值**（D2-a，2026-10-24 父会话裁决，修订本节初稿）：
- 自上次续约点起，新增 **`toolResult` 行数 ≥ 3** → 视为有推进
- 或工作树内新增/修改文件 ≥ **1** → 视为有推进
- `assistant` 消息**只统计展示，不参与判定**

**为什么只有 toolResult 计数、assistant 不计数**：初稿写的是「`toolResult` + `assistant`
合计 ≥ 3」，但 `assistant` 在死循环里会无限增长 —— 模型反复说同一句话也算 "推进"，
而那恰恰是最需要**不**续约的情形。`toolResult` 意味着**一个工具真的返回了**，是
"世界被操作过"的证据。因此 assistant 计数保留（给用户看"他产出了多少"），但
`progressed` 只由 toolResult 与文件改动决定。

**为什么是 3**：一次工具调用往返（call + result）+ 一次重试，才够说明"在推进而不是
卡在第一次失败上"。1 或 2 会把"刚开工就超时"与"稳步推进"混为一谈。

### D3 — 续约是**显式选择**，不是自动行为

**禁止**自动续约。理由：
- 自动续约会让"卡死"变成"无限占槽"，失去预算的约束力
- 用户/父会话必须能看见"这个 child 卡了 30 分钟，但确实在推进"这个事实再决定

**形式**：超时通知里附带**结构化续约提议**：

```
✗ W2 (worker) failed: terminated — turn budget exhausted (30m)
  progressed: 47 tool results, 12 assistant messages, 6 files changed since spawn
  resume: subagent({ action: "continue", name: "W2", message: "<what to continue>" })
```

即：**给出判断依据 + 现成的命令**，让父会话/用户一条命令就能续。

### D4 — 续约就是 `continue`，不新造机制

**禁止**新增 `renew`/`extend` action。续约 = `subagent({action:"continue", name, message})`。

理由：
- `reviveChild`（`index.ts:1844`）已经实现"复用 session 继续"，语义完全匹配
- 新增 action 会分裂两条等价路径，违反单一事实来源

**契约要求的是**：让父会话知道**什么时候值得**发这条命令，并把命令**准备好**。

### D5 — 角色可声明是否允许续约

新增 frontmatter 字段 `renewable`（可选，默认 `true`）：

```yaml
# agents/worker.md
renewable: true     # 默认；超时且有推进时提议续约
renewable: false    # 例如 scout：侦察任务超时说明范围没切好，续约是浪费
```

**理由**：侦察类角色超时通常意味着任务本身定义有误（范围太大），
续约只是把错误延后；而实现类角色超时往往是工程量估计不足，续约是对的。

### D5-a — 如何区分「超时终止」与「正常结束后的 continue」（2026-10-24 父会话裁决）

`continue`/`resume` 对所有已终态的 child 都可用，但**只有被预算切断的**才该消耗续约额度。
否则「正常失败了、我重试一次」也会吃掉额度，额度就失去意义。

**判据（依可靠度排序，取第一个可用者）**：

| 优先级 | 判据 | 位置 | 说明 |
|---|---|---|---|
| 1 | `execution.stopReason === "toolUse"` | `src/shared/session.ts:912` | **在工具调用中被切断** — 预算耗尽的典型形状 |
| 2 | 缺 assistant message（"missing reply"） | `session.ts:12-13`（F29） | hard kill 不写任何 assistant 行 |
| 3 | `execution.reason` 含 `terminated` | `session.ts:912` | 宿主标注 |

**依据**：`src/shared/session.ts:1-14` 的文件头已经把这套语义测过并写死：

```text
F29 — "aborted" is never actually written. A graceful interrupt (esc) writes
      error + an errorMessage containing "aborted". A hard kill writes NO
      assistant message at all, so "missing reply" IS the abort signal.
```

即：**被切断的会话在 JSONL 里是可辨识的**，不需要额外记账。
`shouldRecycleAfterCollect`（`runtime.ts:226`）只区分「终态/非终态」，**不足以**做这个判断。

**`stopReason === "stop"` 或 `"length"`** 的正常结束 → 计额度**不**消耗（用户主动重试）。

### D6 — 续约预算上限

单个 child 的累计续约次数上限 `maxRenewals`（可选，默认 **2**，`0` 表示禁用续约）。

理由：给两次重来机会足以覆盖"估计不足"，超过则说明任务切分有问题。
每次续约获得一个**完整**的角色 `timeoutMs`（不累计、不递减）。

**满额后**：通知里不再提议，改为明确说明"已达续约上限，请重新切分任务"。

### D7 — `wait`/`collect` 超时**绝不**提议续约

见 R3。父侧等待超时 ≠ child 失败。此时正确做法是继续 `wait` 或 `collect`
（child 还活着），不是续约。

**验收**：断言这两个超时路径不产生续约提议。

### D8 — 推进度基线在续约后重置

每次续约成功后，记录新的基线（时间戳 + 当时的行数）。
下次超时只统计**自基线以来**的新增。

**理由**：防止"总共做过很多事"被误判为"刚刚在推进"。

---

## §4 实施切分

| 单元 | 文件 | 内容 |
|---|---|---|
| **W1** | `src/runs/progress-signal.ts`（新） | D2 推进度测量：纯函数 + 可注入的文件读取器 |
| **W2** | `src/shared/types.ts`, `src/agents/{agents,overrides}.ts` | D5 `renewable` + D6 `maxRenewals` 字段解析与默认值 |
| **W3** | `src/extension/notify.ts`, `src/extension/runtime.ts` | D3 结构化续约提议渲染（仅超时终止路径）+ D7 排除 wait/collect 超时 |
| **W4** | `index.ts` | D8 基线记录 + 续约计数 + 满额后的文案 |
| **W5** | `docs/`, `CHANGELOG.md`, `agents/*.md` | 文档与角色默认值 |

**文件归属（禁止越界）**：每个 W 只能改自己那一行的文件。

---

## §5 验收

| 编号 | 断言 | 归属 |
|---|---|---|
| **A1** | 超时终止 + 有推进 + `renewable` → 通知含续约提议与 `continue` 命令 | W3 |
| **A2** | 超时终止 + **无**推进 → 不提议（续约只是延长卡死） | W1+W3 |
| **A3** | `wait`/`collect` 超时（child 仍活）→ **不**提议续约（D7） | W3 |
| **A4** | `renewable: false` 的角色超时 → 不提议 | W2+W3 |
| **A5** | 续约计数达 `maxRenewals` → 不再提议，文案改为"请重新切分" | W4 |
| **A6** | 续约成功后基线重置：仅统计新增，不把历史算进推进度（D8） | W4 |
| **A10** | 正常 `stopReason: "stop"` 后的 `continue` **不**消耗续约额度；`toolUse` 切断才消耗（D5-a） | W4 |
| **A7** | 推进度阈值：新增 **3 个 toolResult** 或 1 个文件改动为界；assistant 单独不越线（D2-a） | W1 |
| **A8** | `renew`/`extend` action **不存在**；续约只走 `continue`（D4） | W3 |

---

## §6 迁移影响

| 影响 | 处置 |
|---|---|
| 现有角色文件缺 `renewable` | 默认 `true`，无需改动 |
| 超时通知文案变化 | `notify.ts` 现有测试需复核；**只增不改**（保留原有行） |
| `maxRenewals` 计数存放位置 | 写入 `ChildRecord`（父 run.json），不写账本（与 #266 D3 一致） |

---

## §7 禁令

1. **禁止**自动续约（D3）。
2. **禁止**新增 `renew`/`extend` action（D4）。
3. **禁止**用"进程存活/CPU 时间/token 消耗"判断推进（D2）。
4. **禁止**在 `wait`/`collect` 超时路径提议续约（D7）。
5. **禁止**让续约累计超过 `maxRenewals`（D6）。
6. **禁止**把续约计数写进账本（§6）。
7. **禁止**因续约而改变角色 `timeoutMs` 本身的语义（每次续约是新的完整预算，不是递增）。
