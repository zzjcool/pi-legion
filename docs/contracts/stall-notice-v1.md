# 「很久没有动静」的主动上报（stall notice，v1，冻结）

> 实现期发现矛盾 → 停下报告，不得重新解释本契约。
> **本文件是该特性的唯一 D 编号命名空间**：实现代码与测试注释里的 `stall-notice Dn`
> 只解析到这里的 D1–D9。
>
> **修订（2026-11-06）**：`docs/contracts/stall-notice-staleness-v1.md`（FROZEN）在 D4 的
> 「三条投递路径零改动」上追加一步**投递前作废**：正文首行下新增一行 `Detected at <ISO>.`
> （检测时刻自证），且 `Stall notice:` 通知在其点名的 child **全部结束**后于发送/确认前转
> `OBSOLETE`（`reason: obsolete_after_child_end`）。三条路径的**文本时序与投递节奏**仍按本
> D4（postman 仍 2s tick、`isMailHeld` 与 `formatMail` 不动），D9 写入侧仍零事件。

## 1. 背景与目标

`docs/contracts/stall-visibility-v1.md` 解决了「看不看得见」，但**只有人去拉才看得见**：
`status` 里的 `working · bash 00:07:31 (long-running tool — no progress for 7m)` 是一行字符串，
父模型不主动调用就永远不知道。实测盲区是 `collect` 的 900s × 3 ≈ 45 分钟。

本契约补的是**推**：当子节点满足下列任一条件时，主动把事实送到父节点的会话里，
让父**自己去检查**。**不自动处置**——这是 v1 的核心约束（D3）。

两种失败模式，两个探测器，互不替代：

| | L1 静默 | L2 长跑 |
|---|---|---|
| 现象 | 不在任何工具里，却没有任何事件 | 一直在动，但总时长超过预算 |
| 含义 | 进程活着但僵住（流卡死、事件循环堵死） | 可能陷入循环，也可能只是任务大 |
| 判据 | 栈空 + 无事件 | 总时长 |
| 阈值 | `silenceNoticeMs`，默认 120s | 角色预算，默认跟随 `timeoutMs` |

## 2. 冻结决定

### D1 — 三层判据；L1 只管「栈空」

```
L1 (silence)  : inFlightTools 为空  AND  now - lastEventAt        >= silenceNoticeMs
L1 栈非空      : 一律不报（见下）
L2 (long)     : now - loopBaseAt                                  >= loopRadiusMs
```

**栈非空时 L1 绝不报「卡死」。** 理由是可区分性，不是偷懒：一个 10 分钟的 `npm run build`
在父侧的全部事件是 `tool_execution_start` → 静默 10 分钟 → `tool_execution_end`，
与真 hang 住的 bash **完全同形**。三条可能的区分手段都不成立：

- 子进程 CPU：默认后端是 in-process，子 agent 跑在宿主进程内，无法归因；
- bash 的 stdout：pi 的 bash 不向父事件流吐输出；
- 角色的 `toolTimeoutMs`：只有 `scout` 声明（600s），`worker`/`centurion` 是有意留空的
  （`stall-visibility-v1.md` D6 / `test/unit/stall-visibility.test.ts` 钉住「慢≠坏」）。

因此栈非空时只允许把事实**作为 L2 文案里的证据**出现（「正在跑 `bash`，已 38 分钟」），
不得单独成句、不得断言卡死。

**已知代价（明确接受）**：一个真 hang 住的 `bash` 要等到角色预算（默认 worker 45 分钟）
才被告知；L1 抓不到它。

### D2 — `lastEventAt` 是 host clock，只用来量一段年龄

两个后端（`InProcessSupervisor` / `RpcSupervisor`）各自在自己的 `ChildRecord` 上记录
一个字段，写入点是**已有**的事件折叠点（与 `inFlightTools` 同一个函数）：

```ts
interface ChildRecord {
  // ... 既有字段
  lastEventAt?: number;   // 任一粗粒度子事件到达时的 host Date.now()
}
```

数据来源是子会话已有的粗粒度事件流（`agent_start` / `turn_start` / `turn_end` /
`tool_execution_start` / `tool_execution_end` / `agent_settled` / `agent_end`），
**不新增 IPC、不新增轮询、不改子侧任何行为**。

- 只做 `now - lastEventAt`，两个量都来自 host 时钟（同 `stall-visibility-v1.md` D2）。
- **禁止**改用 session JSONL 的 mtime：那是另一条链路，且长生成期间也会静默
  （usage 只在每条 assistant 消息完成时落盘）。
- **禁止**改用 `nodes.updated_at`：那是父进程每 2s 替子写的心跳，与「子有没有产出」
  无关；把它当活动时钟正是 `stall-visibility-v1.md` 背景表第 2 行点名的那个坑。
- **禁止**跨 writer 仲裁时间戳（`liveness.ts` 的 D3 约束同样适用）。

`lastEventAt` 在 `LegionSupervisor` 上是**可选成员**（与 `inFlightToolStack` 同族）：
答不上来的 supervisor（测试替身、旧后端）= 没有事实 = 不出 L1 通知。L2 不依赖它。

### D3 — 只通知，绝不处置

本契约**只产出字符串 + 一条 mail**。任何自动 `abort` / `stop` / `retire` / kill 都在禁止之列
（继承 `stall-visibility-v1.md` D5）。误报的代价必须落在人身上，不能落在子进程身上。

**两类通知的可用手段不同，文案必须说清楚**——说错会让父做出无效动作：

| | 父能做什么 | 文案必须带的限定 |
|---|---|---|
| L1 | `abort`（`steer` 打不进去：子的 turn 没有边界，steer 只排队） | `steer cannot land here; abort can` |
| L2 | `steer`（子正常到达 turn 边界）、`extend`、`abort` | 不得说 `steer` 无效 |

### D4 — 出口：写**自己**的 inbox，单路

探测器跑在**父节点的 postman** 里（postman 拥有 tick、拥有 `supervisor`、拥有 `db`），
所以「通知收件人 = 探测器自己所在的节点」。落地方式是往 `messages` 写一行：

```
from_node = 探测者所在节点 id
to_node   = 同一个 id            ← 自投递
kind      = "notice"
urgency   = "action-needed"
```

投递走三条已有路径，全部零改动：

1. **父节点正阻塞在 `wait` / `collect`** → `pollInbox` 250ms 抢占，工具立即带邮件返回
   （`mail-release.ts`，`wait-mail-preempt-v1.md`）。这条对 **root 与 centurion 同样成立**：
   `mailSeamOf` 取的是调用者自己的 `nodeId`（`index.ts` 的 `mailSeamOf`）。
2. **root 节点** → 自己的 postman 的 `deliverRootInbox` 每 2s 读自己的 inbox。
3. **非 root 父节点** → 由**它自己的父**的 postman `deliverChildren` → `deliverToChild`
   （`steer` / `followUp` / `prompt`）。

**不使用 `sendSelfMessage` 作为主路径**：它与路径 2/3 会形成双投（同一条事实两次到达父模型），
而去重要跨两条通道对齐状态，成本高于收益。**v1 不使用 `sendSelfMessage`。**

**范围**：探测器活在 `LegionPostman` 里，因此本特性**只在 legion 树内生效**。没有 legion 身份的
父（plain subagent、`subagents.enabled=false`）没有 postman，也就没有探测器——不存在
「有探测器但没出口」的组合，所以不需要降级分支。root 在正常会话下必定持有身份
（`session_start` 无条件 `initializeLegionRuntime`），交互场景不受影响。

**已知依赖**：路径 3 要求父节点自己活着。父死 = 整棵树的投递都断了，这是整个 mail 系统的既有
前提（`legion-v2-contract.md` §8.3 的邮差表），不在本契约里改。

**去重**：`(toNode, childName, kind, sinceBucket)` 在 postman 内存里去重，**不写 events 表**。
理由见 D9：新增事件类型会动 `test/unit/legion-schema-sentinel.test.ts` 与契约 §15-4，
而这条通知没有任何需要审计的历史价值（一次性的、可再生的、父收到即消费）。

**精确口径**：本契约禁止的是**写通知这一动作**产生事件。这条 `messages` 行被投递后，
既有的投递确认链会补 `mail_delivered` / `mail_bounced`（与所有 mail 一致），不在禁止之列。

**不得占用发送方的邮件配额**：该行 `from_node == to_node`，是系统自述而非人际邮件，
所以 `mailRatePer5Min` 的窗口统计必须排除自投递行（`from_node <> to_node`）。
否则一个节点自己的提醒会把自己的 `legion_mail` 打成限流。

### D5 — `extend`：新增的真实动作

`subagent({ action: "extend", name, ms? })`。

语义**只有一条**：把该子的 L2 基准前移到 `now`。

```ts
loopBaseAt   = now                    // 下一次到期 = now + loopRadiusMs
loopRadiusMs = ms ?? loopRadiusMs     // 不给就沿用当前半径
```

明确**不做**的三件事（文档与工具描述都必须写死，否则一定被读错）：

- **不延长父的 `collect` / `wait` 预算**（那是角色 `timeoutMs`，与本动作无关）；
- **不重启、不复活、不给子发消息**（那是 `continue` / `steer`）；
- **不延后 L1**（L1 的基线是 `lastEventAt`，由事件自然重置；客观事实不该被续期抹掉）。

**状态存内存**，放在探测者（父）的 postman 实例上：`Map<childName, { loopBaseAt, loopRadiusMs }>`。

| 时机 | 行为 |
|---|---|
| 首次见到该子（出现在 alive 集合里） | 以 `nodes.created_at` 为 `loopBaseAt` |
| 该子从「不在 alive 集合」重新出现（resume / re-spawn） | 重置为 `now` |
| 子进入终态 / 被 retire | 保留一条 `absent` 墓碑（清空计数），**不删条目**——删掉就丢了「它曾经不在」这件事，`continue` 复活后第一次见到会拿旧的 `created_at` 当基准，立刻误报一次 L2 |
| 子从账本里彻底消失（名字不在 `getChildren` 里） | 删除该条目 |
| `extend` | 前移为 `now`，可选改半径；**已终态 / 已 retire 的子不接受 `extend`**（回执承诺一封永远不会到来的提醒比拒绝更糟） |
| 进程重启 | 全部丢失，按「首次见到」规则重建（重启本身就是合理的「很久了」起点） |

**命名警告**：`renewal` 已表示「子预算耗尽后续跑」、`continue` 已表示「给结束的子发新消息」、
`extend` 在 `wait` 回执里已表示「再调一次 wait」。本动作叫 `extend`，但语义是**只延后提醒**。
工具描述与文档必须显式区分这四者。

### D6 — 提醒节奏与上限

| | 触发 | 重复 |
|---|---|---|
| L1 | `elapsed >= silenceNoticeMs` | 在 `1×` 与 `2×` 各一封，之后**不再重复**（一个死子不能每 2 分钟刷一封） |
| L2 | `elapsed >= loopRadiusMs` | 到期一封；不理会则**每再过一个 `loopRadiusMs` 复用同一封**，同一 `(child, L2)` 连续未处理**上限 3 封**，之后静默到 `extend` 或子结束 |

**重复的时钟是「上一封的发出时刻」，不是基准点。** 第 1 封的条件是 `now - base >= radius`；
第 2 封起的条件是 `now - 上一封 >= radius`。用 `base + n × radius` 做累积判断是错的：
一个首次被观察到时就已经远超阈值的子（例如 postman 重启后接手一个跑了 3 小时的子），
会在连续几个 2s tick 里把全部额度一次性打光。

上限 3 的理由：mail 有 `mailRatePer5Min`（默认 10 封/5 分钟）的**全局**限流，
一个刷屏的子会把别人的邮件挤掉。

所有阈值都是 `> 0` 才生效：`0` 或负数 = 该探测器关闭（与 `phaseTimeouts` 的
「终态 0 = 永不告警」同语义，但这里是显式关闭，见 D8 的校验要求）。

### D7 — 多子合并

**同一个 tick 内**多个子同时满足 L1 或 L2 → **合并成一封 mail**，正文按子分行。
不得一个子一封（同样是为了不吃掉限流额度）。

不同 tick、不同 kind 不合并。

### D8 — 配置面

**L1 阈值（全局）**

```jsonc
// settings.json  →  subagents.legion.silenceNoticeMs
{ "subagents": { "legion": { "silenceNoticeMs": 120000 } } }
```

校验沿用 `positiveInt`（`src/agents/settings.ts`）：缺省合法，写了就必须是正整数。

**L2 阈值（跟角色走）**

回落链，从左到右取第一个存在的值：

```
角色卡 loopNoticeMs  →  角色卡 timeoutMs  →  DEFAULTS.turnTimeoutMs (900_000)
```

**角色卡的层解析**：先按 launch 的默认作用域（`agentScope: "user"`）找这张卡；找不到再
按全部层（`"both"`）找一次，覆盖用 `agentScope: "project" | "both"` 启动、卡片只在
`<cwd>/.pi/agents` 的角色。user 层总是优先，所以默认作用域下的答案与单遍时相同。
「卡片写了 `loopNoticeMs: 0`」算已找到（关闭），不得回落下一层。

- 新增角色卡 frontmatter 字段 `loopNoticeMs`，**必须**加进 `AGENT_FRONTMATTER_FIELDS`
  （卡里未知键是硬错）；
- 允许 `subagents.agentOverrides.<name>.loopNoticeMs`（进 `OVERRIDE_FIELDS`）；
- `subagents()` 的 launch 参数**不在 v1 范围内**（要改就靠 override 或改卡）。

默认生效值：

| 角色 | `timeoutMs` | L2 首次提醒 |
|---|---|---|
| scout | 600_000 | 10 分钟 |
| centurion | 1_800_000 | 30 分钟 |
| worker | 2_700_000 | 45 分钟 |

**解耦提醒**：`timeoutMs` 现在同时是「父的 collect 预算」「`wait` 的默认超时」「L2 提醒基准」。
有人为了 `wait` 等更久而调大 `timeoutMs` 时，会静默推后提醒——想解耦就显式写 `loopNoticeMs`。
这一点必须写进 `docs/design.md` 的字段说明。

**创建侧文档**（「创建的文档也要说清楚」的落点）：`docs/design.md`
§6.1 角色卡全字段示例（加 `loopNoticeMs`）+ §6.3 settings 全键（加 `silenceNoticeMs`）。

### D9 — 边界（实现期不得越界）

| 允许 | 禁止 |
|---|---|
| 新增 `src/legion/stall-notice.ts`（纯判定 + 纯文案，无 IO） | 改 `src/extension/liveness.ts` 的任何判定 |
| 两个后端 `ChildRecord` 加 `lastEventAt`，在**已有**事件折叠点写入 | 改 `refreshHeartbeats` / `scanOrphans` 的判据或周期 |
| `LegionSupervisor.lastEventAt?` + `RoutingSupervisor` 纯转发 | 新增 `LEGION_EVENT_TYPES` 成员（动 schema 哨兵 + §15-4） |
| `LegionPostman.tick` 内新增一步 `checkStallNotices` | 改 `phase_timeout` / `orphan_detected` 的既有语义 |
| `index.ts` 的 action 枚举加 `extend` | 改 `collect` / `wait` 的超时语义或 `COLLECT_DEADLINE_REASON` |
| `LegionSettings.silenceNoticeMs` + 角色卡 `loopNoticeMs` | 任何自动 `abort` / `stop` / `retire` / kill |
| `src/legion/mail.ts` 的限流窗口排除自投递行（`from_node <> to_node`） | 给 `worker` / `centurion` 加默认 `toolTimeoutMs` |
| 文案与展示 | 改 `sendMail` 的收件人解析、限流额度或 5 分钟窗口长度 |

`src/extension/legion-tools.ts` 的 `checkOwnPhaseTimeout` 是本契约的**形状模板**
（`getNode` 早退 → 纯函数判定 → 去重 → 发通知 → 再记账），但两者语义独立，
不得合并、不得复用其去重键。

## 3. 验收

**纯函数**（`test/unit/stall-notice.test.ts`，新文件）

- L1：栈空 + 恰好 `silenceNoticeMs` → 报；差 1ms → 不报；`0`/负数 → 关闭。
- L1：**栈非空 + 无事件 10 分钟 → 不报**（这是 D1 的核心，必须有专门用例）。
- L2：`loopRadiusMs` 边界；`lastEventAt` 缺失时 L2 仍工作（不依赖它）。
- L2 文案在栈非空时带「正在跑 `<tool>`，已 N 分钟」作为证据。
- `extend` 后 `loopBaseAt` 前移；再次到期仍报；连续未处理计数到 3 封后停。
- **迟到首发**：首次观察时已远超阈值 → 只出 1 封，后续两封各等一个 `loopRadiusMs`
  （断言连续三个 tick 不产生 3 封）。
- **terminal → revive**：子终态后 `continue` 复活 → 第一封不得立刻发出（基准重置为复活时刻）。
- 多子同 tick 合并成一封。

**postman 集成**（扩 `test/unit/legion-postman.test.ts` 或新建）

- L1 / L2 各写出一行 `messages`（`to_node == from_node`），`kind=notice`、`urgency=action-needed`。
- 同一个 `sinceBucket` 不重复写。
- **不写 events 表**（断言 `readEventsAfter` 无新行）。

**这两个后端**

- `test/unit/supervisor.test.ts` / `test/unit/inprocess-supervisor.test.ts`：
  `lastEventAt` 由已有事件流更新；`agent_settled` 不清空它（settle 本身也是事件）；
  dead child 不产生 L1。

**工具面**

- `subagent({action:"extend"})`：改内存状态、返回回执；未知 name → `NOT_FOUND`；
  已终态 / 已 retire 的子 → 拒绝（不得返回一封永远不会到来的提醒）；
  不触发任何 `collect`/`wait` 语义变化。
- 必须驱动**真实入口**（经 `controlAction`），不能只测导出的内部函数。

**非 root 节点**

- 至少一条用例：父是 centurion 时，自投递行由它自己的父 `deliverChildren` 投递成功。

**配置**

- `silenceNoticeMs` 非正整数 → 沿用 `positiveInt` 的报错文案（含文件路径）。
- 角色卡写 `loopNoticeMs` 合法；写未知键仍是硬错。
- 回落链：卡有无 `loopNoticeMs` / 有无 `timeoutMs` 的四种组合各一条用例。

**不得破坏的既有测试**

`test/unit/legion-schema-sentinel.test.ts`（零 schema 变更）、`test/unit/stall-visibility.test.ts`
（`STALL_NOTICE_MS` 的展示语义不变）、`test/unit/runtime.test.ts` 的 `running` 不通知用例、
`test/unit/legion-phase-timeout-ended.test.ts`。
