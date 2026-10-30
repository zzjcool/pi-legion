# 「活着但不再推进」的可见性（stall visibility，v1，冻结）

> 语义由 #315 冻结。实现期发现矛盾 → 停下报告，不得重新解释本契约。
> **本文件是 #315 唯一的 D 编号命名空间**：实现代码与测试注释里的 `#315 Dn` 只解析到这里
> 的 D1–D7。`#315` 之外的 `Dn` 与本契约无关。

## 背景：为什么这件事在系统里完全隐形

`docs/contracts/display-liveness-v1.md` 的八条规则把「谁活着」判准了，但它们的**最强规则**
恰好把这个问题盖住了：

| 层 | 事实 | 后果 |
|---|---|---|
| `src/extension/liveness.ts` 规则 1 | `inMemory` 持有一个**非终态** handle → `live` | 只要本进程还攥着 handle，child 恒判 `live` |
| `src/extension/legion-tools.ts` `refreshHeartbeats` | 心跳只给 `supervisor.isAlive()` 为真的子节点刷 | 卡住的 child 心跳照刷，`updatedAt` 一直是新的 |
| 同文件 `scanOrphans` | 首个 root child 仍 `isAlive` 时整棵子树豁免 | 卡住的 child 永远不会被判成 orphan |
| `collect` deadline | 默认 900s | 父要等满这个上限才知道「没动静」 |

于是「进程活着但一个工具卡在那里十分钟」与「正在高效工作」在**所有展示面上完全一样**。
这不是 liveness 判错了——判「活/死」它是对的；缺的是第三个事实：**它在干什么、干了多久**。

## 冻结决定

### D1 — 只加事实，不改判定

两个后端（`InProcessSupervisor` / `RpcSupervisor`）各自在自己的 `ChildRecord` 上记录
**一个字段**（#331 起它的形状是栈，不再是单槽）：

```ts
interface ChildActivity {
  readonly tool: string;              // 子会话事件流原样报来的工具名
  readonly startedAt: number;         // 事件到达时的 **host** clock
  readonly toolCallId?: string;       // 仅用于把 end 事件匹配回它的 start
  readonly parentToolCallId?: string; // 嵌套归属（codemode → bash），事件流原样带的字段
}
// ChildRecord.inFlightTools: ChildActivity[]   —— LIFO 栈，栈顶（最后一项）= 最内层
```

**D1 修订（#331）：字段从「单槽」改成「栈」。** 原 D1 把记录冻结成**一个** `ChildActivity`，
由此产生两处**少报**（内层 end 擦掉外层、并行兄弟先结束就整行消失，见 D2 的修订记录）。
现在记录的是 `ChildActivity[]`，先进先出序、**栈顶 = 最后启动 = 最内层**；`parentToolCallId`
是事件流自己带的字段（`ToolExecutionStartEvent.parentToolCallId`，"Set when another tool (for
example a codemode script) made this call"），只用于把嵌套调用归属到它的外层调用。

数据来源是**子会话已经存在的事件流**（`tool_execution_start` / `tool_execution_end`，
两个后端的订阅点早已存在）。**不新增 IPC、不新增轮询、不新增 state machine**。

- `liveness()` 的 live/dead 判定**一个字都不改**。`live` 的 child 仍然 `live`。
- **不自动 kill / abort / retire**。本契约只产出字符串。
- 心跳与孤儿扫描的判据**一个字都不改**（约束见 D7）。

### D2 — `startedAt` 是 host clock，只做「年龄」

`startedAt` 由 host 在事件到达时读一次 `Date.now()`；耗时永远是 `now - startedAt`，中间只用
**同一个时钟族**测量一段年龄。绝不把子会话 transcript 里的时间戳拿来和 host 时间戳比大小
（这正是 display-liveness D3 禁止的「跨 writer 时间戳仲裁」）。

`inFlightTool(name)` 在 child **不是 live** 时一律返回 `undefined`：没有活 handle 的进程不可能
正卡在一个工具里，记录里残留的字段不能当事实用（display-liveness §6 的同类推论）。

**D2 修订（#331）：折叠与展示都按栈来。**

事件折叠（`nextInFlightTool`，纯函数，两个后端在各自已有的事件订阅点上调用）：

- `tool_execution_start` → **push** 一帧（记 `tool` / `startedAt` / 可选的 `toolCallId`、
  `parentToolCallId`）。没有工具名的 start 不 push，也不动已有帧（不造事实）。
- `tool_execution_end` → **只移除它点名的那一帧**（按 `toolCallId` 匹配），**绝不清空整栈**。
  内层 `bash` 结束时外层 `codemode` 仍然在跑；并行批里先结束的兄弟不能把还在跑的那个擦掉。
  点名不到任何帧时，只允许落到「没有 id 的那一帧」（两边 id 都可缺），全都有 id 就原样返回——
  陌生 id 的 end 不能擦掉一个确实还在跑的调用。end 自己不带 id 时按栈语义弹出栈顶。
- `agent_settled` → **清空整栈**：一轮结束就不会再有工具在飞（abort 打断工具时 `end` 事件
  可能永远不来）。

展示取值（`formatInFlightToolLine` / `withInFlightToolLine`）：

- 显示的是**栈顶**（最内层）那一帧：`working · <栈顶 tool> hh:mm:ss`；耗时仍按**栈顶的**
  `startedAt` 计。
- **嵌套**（栈顶帧的 `parentToolCallId` 链能一路走到栈里的帧，如 `codemode` → `bash`）：追加
  ` (inside <最外层 tool> ×N)`，`N` = 这条嵌套链的层数（`codemode → bash` 读 `×2`）。
- **并行兄弟**（栈里不在该嵌套链上的帧）：追加 ` (+N more)`，`N` = 这些帧的数量。显示的是
  最近启动的那个（栈顶），兄弟只是被计数。
- 两个提示可同时出现：`working · bash 00:05:00 (inside codemode ×2) (+1 more)`。5 分钟标记永远
  在最后。
- **没有 `parentToolCallId` 时，深度 > 1 不能区分「嵌套」与「并行」**，此时按**并行**报
  ` (+N more)`：这是更弱、但永远为真的说法。把并行硬说成 `inside` 会是假报——本契约要防的
  恰好是相反的错误（把卡住说成在工作）；两个方向都只允许**少报**。
- **事件里带了 `parentToolCallId`、但那个父帧已经不在栈里**（父调用先结束、或 `agent_settled`
  清过栈）时按同一规则降级为 ` (+N more)`：归属只承认**栈里**能一路走通的链，不拿一个已经
  失效的 id 去猜 `inside`。
- 栈空（`[]`）→ **不出这一行**，与「没有事实」逐字节相同。

`inFlightTool(name)` 返回栈顶（对只实现它的旧后端 / 测试替身保持一帧读取的兼容），
`inFlightToolStack(name)` 返回整个栈（展示层读它）；两者都在 child **不是 live** 时一律 `undefined`：没有活 handle 的
进程不可能正卡在一个工具里，记录里残留的字段不能当事实用（display-liveness §6 的同类推论）。

**为什么这是展示精度修正，不是行为变更**：事件折叠只会 push/移除，不会置位；`inFlightTool*`
以 `isAlive` 为闸，所以不会把没在跑的工具报成在跑，也不会把已结束的调用继续说成在飞。
`liveness()`、心跳、孤儿扫描、任何 kill/abort/retire 都不受影响（D5、D7 不变）。

### D3 — `STALL_NOTICE_MS = 300_000`

单条工具持续到或超过 5 分钟，追加**展示用**标记。常量在 `src/supervisor/types.ts`，
展示层（`formatInFlightToolLine`）与测试共用同一个值，不各写一份字面量。
（两个后端不读这个常量，只记录事实；边界判定全部发生在展示层。）

选 5 分钟的理由是对照**可观测的替代方案**：现在父等到 900s 的 `collect` deadline 才知道
没动静。5 分钟落在这个 deadline 之前很久，且它只花一个字符串。

**计时基准（#331）**：这里的「单条工具持续」指**栈顶那一帧**的 `startedAt`，不是最外层调用的
起跑时间。栈顶换人（内层工具 start）就等于把标记的时钟重置，所以 `codemode` 里套一串 `bash`
的 child 可能很久看不到 5 分钟标记——这是已知的**少报**（宁可不报，也不把最外层的年龄算到
一个刚启动的内层调用头上）。反方向不会发生：它绝不会把新启动的调用报成卡住。

### D4 — `status` 的行格式

child 有在飞工具时，状态块**顶部**多一行（lead line，与 `alive · quiet Ns` 同级）：

```
working · bash 00:07:31
worker-0 — state=working agent=worker kind=pi
alive · quiet 12s
supervisor=inprocess
session=/…/worker-0.jsonl
```

栈里有多帧时（#331），行内带上下文提示（语义见 D2）：

```
working · bash 00:07:31 (inside codemode ×2)      # 嵌套：外层仍在跑
working · bash 00:07:31 (+1 more)                 # 并行兄弟：栈顶是最近启动的那个
```

- 前缀 **`working`** 来自在飞工具这个事实本身，不是持久化的 `state`：start 事件没有配对的
  end，就是「这个 child 正在一个工具里」，而记录里的 `state` 只在 turn 边界被重写，可能滞后。
- 耗时为 `hh:mm:ss`，小时字段**不封顶**（30 小时读 `30:00:00`，绝不回绕成 `06:00:00`——
  回绕会把卡死的 child 报成刚开工）。
- 到/过 `STALL_NOTICE_MS` 追加：

```
working · bash 00:12:00 (long-running tool — no progress for 12m; `steer` cannot interrupt it, `abort` can)
```

  `N` 是越过边界的整分钟数。文案点名 `abort` 而不是 `steer`：`steer` 只是排队（#313），
  一个卡在工具里的 child **永远收不到**；`abort`（#314）才是能打断当前 turn 的杠杆，而且它
  同样不杀进程。
- 同一个渲染器服务 `subagent({ action: "status" })` 的单 child 分支、
  `subagent({ action: "status", all: true })` 的每个块、以及 `/legion status <name>`：
  三处走 `withInFlightToolLine`，不会漂移。
- **没有在飞工具就不出这一行**：无事实即无声明，`#315` 之前的输出逐字节不变。

### D5 — 为什么不做 fleet watchdog

`docs/contracts/esc-abort-v1.md` 的非目标写明「不做主机级 watchdog」。`#315` 不推翻它，理由是
这一条现在**更**成立而不是更松：

1. **watchdog 要判「该杀」，而这里没有可信的「该杀」判据。** 5 分钟一个工具可以是 `npm test`
   跑在慢机器上，也可以是 `rg` 扫在 NFS 上，也可以是模型在长思考。判据缺位时，watchdog
   唯一能做的「动作」就是把误杀变成默认行为。
2. **杀掉最贵的东西换最小的收益。** `retire` 会带走进程与上下文（`stop` 的语义），而卡住的
   child 恰恰是「上下文最贵」的那一类。
3. **父本来就有一个明确的杠杆。** 看到这一行之后，父可以选择 `abort`（软中断，保留上下文）
   或 `stop`（硬停）。把决定权留在父手里，比在 host 里加一个猜的启发式更诚实。
4. **主机级 watchdog 需要有权限的 supervisor，而展示层没有。** `status` 是一个纯读的投影；
   给它杀人的手，等于把 display-liveness 「渲染是投影，不是事件回放」的边界拆掉。

一句话：**`#315` 把「看不见」修成「看得见」，不把「看得见」升级成「自动处置」。**

### D6 — 唯一的行为改动：`scout` 的默认单次 bash 超时

`agents/scout.md` 新增 `toolTimeoutMs: 600000`。这是本契约里**唯一**改变运行行为的一项，理由
是 scout 的失败模式和别的角色不同：

- `toolTimeoutMs` 原本**没有默认值**，SDK 的 bash 工具也没有默认超时：一条卡住的探针命令
  （`wait-output`、socket、网络挂载上的全仓 `rg`）能把一个只读侦察 child 钉满它 600s 的
  turn 预算，并且**什么都不产出**。只读角色没有正当的长命令。
- **只给 `scout`**。`worker` / `centurion` 要跑完整构建、测试套件与集成门禁，
  它们的长命令是**正当**的：误杀一次 `npm run test:integration` 的代价高于它防住的那次挂起。
  给它们加默认超时等于把「慢」判成「坏」。
- **收益的边界（不要读多）**：600000 与本角色的父侧 `timeoutMs` 完全相等，**没有余量**。所以
  这条预算买到的是「一条卡死的 bash 不再永久钉住 child」（到点被 OS 杀掉，child 还能带着已
  读到的东西收场），**不是**「当次一定能看到侦察结果」—— 同长的命令照样跑不完，只是失败变
  成有界的。是否给 scout 留余量（提高 `toolTimeoutMs` 或缩短 `timeoutMs`）属于父会话裁决，
  不在本契约里改数值。
- 既有行为不变，并由测试钉住：以 `timeout` 开头的命令不被二次包裹（嵌套 `timeout` 会把外层
  上限压成内层的，并让失败原因报错在错误的那一层）；`toolTimeoutMs` 缺失时命令原样不动。

### D7 — 边界（实现期不得越界）

| 允许 | 禁止 |
|---|---|
| `src/supervisor/types.ts` 加 `ChildActivity` / `InFlightToolStack` / `STALL_NOTICE_MS` / `nextInFlightTool` / `formatInFlightToolLine` / `inFlightToolStackOf` / `LegionSupervisor.inFlightTool?` / `LegionSupervisor.inFlightToolStack?`（#331） | 改 `src/extension/liveness.ts` 的任何判定 |
| 两个后端在各自 `ChildRecord` 上记录/清空该字段 | 改 `src/extension/legion-tools.ts` 的心跳与孤儿扫描判据 |
| `RoutingSupervisor.inFlightTool` / `inFlightToolStack` 纯转发（不加则工具面为 0：工具面注入的就是 `RoutingSupervisor`） | —— |
| `index.ts` / `src/extension/legion-status.ts` 的展示拼接 | 改 `runtime.ts` 的 claim / notice 语义 |
| `agents/scout.md` 的 `toolTimeoutMs` | 给 `worker` / `centurion` 加默认超时 |
| 展示层字符串 | 任何自动 `abort` / `stop` / `retire` / kill |

`inFlightTool` 在 `LegionSupervisor` 上是**可选**成员：它是在接口冻结之后新增的**只读展示**，
一个答不上来的 supervisor（测试替身、早于 #315 的后端）必须仍然满足契约。答不上来 = 没有
事实 = 不出那一行。

表里的 `——` 是「这一行没带对应的禁令」：`routing-supervisor.ts` 只多一个纯转发方法
（按 `owners` 路由到具体后端，与 `isAlive` 同形状），它不记录、不判定、不清空任何事实，
所以没有需要单独禁掉的东西。

## 验收

- `test/unit/stall-visibility.test.ts`：`hh:mm:ss` 格式（含不封顶的小时）、5 分钟边界与标记文案、
  事件折叠（start / 无关事件 / 匹配的 end / 无名 start / `agent_settled` 清空 / 陌生 id 不清栈 /
  有名与无名混排时陌生 end 只折叠无名帧）、
  嵌套 `codemode → bash`（内层结束外层仍显示）、并行兄弟（显示的那次先结束 → 显示仍在跑的）、
  栈空不出行、两个上下文提示、scout 与 worker 的 `toolTimeoutMs` 取舍。
- `test/unit/supervisor.test.ts`、`test/unit/inprocess-supervisor.test.ts`：两个后端各自从
  **已有事件流**记录该事实，`agent_settled` 与 dead child 都不留残留；routing 后端按 owner 转发。
- `test/unit/status-action.test.ts`、`test/unit/legion-status.test.ts`：三个展示出口的 lead line、
  5 分钟标记、以及「没有事实就一行都不多」。
- `test/unit/child-guard.test.ts`：scout 的 600s 预算真的把 bash 包成
  `timeout --kill-after=2s 600s bash -lc …`；无预算时命令不动。
