# 会话启动自动接回遗留的跨机 child（#445）

- 基线：`origin/master` = `298c235`（6.2.6 发版点）；本 worktree 从 `6c1a37c`
  （6.2.7 的 release 分支，含 #442/#443 与 master 的 #437）切出，PR base = `master`。
  分支 `pi-subagent/hw-nj/pi-legion-445-reattach-5cc8b26e`。
- 范围：#445 全部七条设计要点 + 五组验收。**不碰** `src/legion/stall-notice.ts` 与 stall
  候选过滤（#441 的地盘）；本 issue 只新增 run store 读取、session start 钩子、账本心跳、
  通知闩锁。
- 不动版本号 / 不打 tag / 不 publish。
- 用例：unit **2866 → 2889**（+23），integration **193 → 201**（+8），trunk 用例数不减。

---

## §1 现象与根因

issue 原文：重启 pi 之后 `hw-nj` 上两个 child 还在写（16 秒 / 1 分半前），新会话 `status`
看不到、完成通知不会来，只能人工 `recover` 一个个捡。实测代码路径给出三条独立原因：

1. **记录被退出改写了**。`session_shutdown` 对跨机 child 走
   `Orchestrator.orphanOnShutdown`（`src/runs/orchestrator.ts:4603-4655`）：记录写成
   `state: "orphaned"` / `"unfetched"`（取决于对端是否已经结束），账本行**故意**保持
   `running`（这是 `recover` 还能取结果的前提）。于是 `status` 显示的是
   `state=orphaned` + `owner: dead`——"我的任务没了"的字面来源。
2. **没有人看着它**。完成通知来自 `SessionRuntime` 的 job watch → collect → deliverBatch
   （`src/extension/runtime.ts:3090` 起）。新会话没有 job，`recover` 又只是"取一次结果"，
   所以通知链路整条不存在。
3. **`recover` 是个动作，不是自动行为**。`remote-recover.ts` 的设计注释明确写着"adoption
   是 S5 的事，这里不做"——#445 就是补上这一层，但**只到"看住 + 报告"**，不做第二个
   supervisor writer（见 §8 的取舍）。

## §2 七条设计要点，逐条落地

### 2.1 候选来源（`src/runs/reattach.ts:290` `discoverReattachCandidates`）

| 来源 | 落点 |
|---|---|
| run store 里的 `state ∈ {launching, working}` 行 | `reattach.ts:133` `REATTACH_CANDIDATE_STATES` + `:290` |
| 干净退出打的 `orphaned` / `unfetched` | 同上（**增补**，理由见下） |
| `<mirrorRoot>/no-run/<name>/session.jsonl` 孤儿目录 | `reattach.ts:1129` `createMirrorOrphanLister` + `:686-708`（pass 内的 scan 段） |
| 本会话自己的 run | `:299` `path.resolve(run.sessionFile) === 我们自己的 sessionFile ⇒ 整 run 跳过` |
| 本地 child / 终态记录 | `:303-305`（`isCrossMachineHost` 与 state 集合两道 gate） |

`orphaned`/`unfetched` 为什么必须补：issue 写的是 `{launching, working}`，但**"重启 pi" 是一次
干净退出**，退出恰恰把同一个遗留写成 `orphaned`/`unfetched`（上面 §1.1）。只认
`launching`/`working` 会让"重启"这个主场景永远接不回来——那是把 issue 的意图读反了。
`retired`/`exited`/`failed`/`settled`/`queued`/`blocked` 一律不收：前四个是"已经结束"的答案，
`queued` 对端根本没有进程，`blocked` 等的是本机的人。

孤儿目录**只报不接**：它没有 run 记录、没有账本行，而本模块的 settle 全靠账本行（§2.7）。
它进日志 + 一行摘要后缀（`reattach.ts:739`），不进账本——这是"看得见"和"编一行假账"的区别。

### 2.2 活性判据：证据，不是"行存在"（`reattach.ts:430` `probeLiveness`）

判定顺序（每条都有注释说明为什么）：

1. `terminal.get` → `terminalProgramEnd`（**同一个函数** `collect`/`recover` 用，`remote.ts:2546`）
   说程序还在跑 ⇒ live。terminal 被 keep 着但程序已退出**不算**。
2. `unreachable` ⇒ **不 live**（`unknown ≠ live`），理由里带机器与原始错误。
3. 记录的地址 + `state: "missing"` ⇒ 对端没有这个 terminal = 孩子结束（只对**记录里的地址**
   成立；推断出来的 `host/lgl-<name>` 不算证据——这是 `remote.ts` `terminalInferred` 已经冻结的规则）。
4. 记录里**没有** terminal 地址时，才退到 transcript：两次 `file.read limit: 0` 取总行数
   （`reattach.ts:1103` `createRemoteLineCount`），`growthWaitMs` 内行数增长 ⇒ live；
   不增长 ⇒ 不 live。这是唯一能给 v4 老记录提供的证据，一次采样一个 RPC。

### 2.3 绝不接管（两道 gate，`reattach.ts:343` / `:370`）

- **owner gate**（`:343` `ownerGate`）：run 目录 `owner.json` 的 pid 活着且**不是本进程** ⇒
  跳过，理由串就是 `owned by <session>`（`:324` `ownedByLine`，session 取 `run.json` 的
  `sessionFile` basename）。同进程但 sessionFile 不同 ⇒ 允许（被替换的 session 已经 dispose，
  记录才是遗留）。
- **账本 gate**（`:370` `ledgerGate`）：账本行 `hasEnded` ⇒ 跳过并说明"settled/retired 不接管
  也不通知"；缺账本 / 缺 nodeId / 行已消失 ⇒ 各一行理由。**读账本而不是读记录**是关键：
  记录会被 rebuild / 另一个进程的 `recover` 写旧，`nodes.status` 是唯一所有 settle 路径都写的行
  （也就是 #441 的"幽灵行"规则，这里通过"问行"而不是"复制一套时钟判定"来遵守）。

### 2.4 有界（`reattach.ts:100-104` + `:613` `runReattachPass`）

| 界 | 值 | 落点 |
|---|---|---|
| 每 child 探测 deadline | 3s | `REATTACH_PROBE_DEADLINE_MS`，经 `raceWithTimeout` 包在 `probeLiveness`/`step` |
| 单次 pass 候选上限 | 20 | `REATTACH_MAX_CANDIDATES` |
| session start 总预算 | 5s | `REATTACH_BUDGET_MS`；`runReattachPass` 在**每个候选前**查 `now() >= deadline`，超出的进 `deferred` |
| 超出预算的说法 | "稍后重试" | `formatReattachSummary` 的 `(${deferred} … the next start retries)` / 无采纳时的独立一行 |

`session_start` 本身**从不等待**：`index.ts:2010` 的 `startReattach` 是 `void (async () => …)()`，
钩子只登记、立刻返回。预算约束的是这次 pass 花多久，不是启动要不要等它（§3 的验收 4 测的就是
"不可达机器下 pass < 5s"）。

### 2.5 可关（`src/shared/types.ts:1228`、`src/agents/settings.ts:505` / `:1229`）

`subagents.reattachLiveChildren: false`（缺省 = 开）。settings 解析器是白名单式的（不读的键直接
丢），所以这里改了三处：类型、parser、project/user 合并。关闭时 pass 直接返回 `disabled: true`，
一次 wire 都不发（`reattach.ts:630-634`，单测 §5 断言 `probed === 0`）。

### 2.6 可见但不吵（`reattach.ts:739` / `:765`、`index.ts:2020-2027`）

- 会话里**只有一行**：`legion: reattached 2 live children (a, b)`（+ 孤儿后缀 / 延后后缀）。
  走 `ctx.ui?.notify(text, "info")`，和存储清扫（hygiene）同一个通道——**不进 transcript**
  （与 #442 的"不许刷屏"同一原则）。
- 逐 child 细节进 `<storeRoot>/reattach-live-children.log`（`reattach.ts:765`，128KB 上限、
  只留最新一半）：`skipped … : <理由>` / `adopted … evidence=…` / `watching …` / `still working (…)`。

### 2.7 不重报（`reattach.ts:1046` `alreadyNotified` / `:1065` `pendingReattachNotices`）

#417 的闩锁语义是"通知**送达之后**写一次、之后永不再报"。跨机遗留**没有本地 artifact 行**
（`recoverCrossMachineChild` 只写 `node_settled` 事件 + usage，不写 artifact），所以
`consumptions.notified_at` 这条链在这里没有落点；闩锁改放在**承载遗留的那条记录**上：
`run.json` 的 `reattached.notifiedAt`（`reattach.ts:145-176` 的 `ReattachedMark`）。

- 只有 `notify` 返回 `true` 才写（`reattach.ts:947-975`）；投递失败 ⇒ 不写，日志写明
  "latch stays unset so a later session retries"。
- 另一半是"欠着的那条不能丢"：`pendingReattachNotices` + `pendingReattachNotice` 在下次
  session start 把"已采纳、已出终态、但没有闩锁"的记录补发一次（`index.ts:2066-2073`）。
- 变异（§4.5-C）：把 `alreadyNotified` 那行删掉 ⇒ 单测 `pendingReattachNotices` 直接红。

## §3 采纳到底改了什么（`reattach.ts:546` `adoptCandidate`）

两个读者、两处写，都是**已有**的写入路径，没有新事件类型、没有 schema 变更：

1. **run.json**（`status` 读它）：`state: "working"`、删掉 `orphaned` 标记、清 `retiredAt`、
   写 `reattached = { at, sessionFile, host, remoteTerminal, evidence, lastProbeAt }`。
   `RunStore.updateChild` 顺带把 run 目录的 `owner.json` 重写成**本进程 pid**——这不是装饰：
   它既是"这个 run 目录现在归我看"的声明（挡住同时启动的第二个会话），也让 `status` 把这条
   记成 live 而不是 `owner: dead`。
2. **账本**：行保持 `running`，只把 `updated_at` 往前推（`updateNode(..., {status: node.status})`）。
   没写新事件类型：账本欠的**唯一**事实是 settle，而那是 watcher 用
   `recoverCrossMachineChild` 写的——和 `collect`/`recover` 同一条链路。

程序结束时（`ReattachWatcher.step`，`reattach.ts:895`）：settle 账本 → 记录改
`state: "retired"` + `execution`/`acceptance`（`index.ts:2035-2044`）→ 用
`formatCompletionNotice`（**同一个格式化器**，`reattach.ts:987`）投递通知 → 投递成功才写闩锁。
所以用户看到的完成通知与一次普通 `collect` 的通知逐字一致。

## §4 五组验收（都能红）

集成测试：`test/integration/reattach-live-children.test.ts`（真 `hc` client + fake core 真
JSON-RPC + 真 `recoverCrossMachineChild` 评级/结算 + 真 run/ledger 文件）。单测：
`test/unit/reattach.test.ts`。

### 4.1 A1 端到端（`integration:279`）

会话 A 在 `njbox` 上留一个 child（`owner.json` pid 已死、记录 `orphaned`、账本行 `running`、
远端 transcript 是完整成功回合、terminal 声明 `finish_after_ms: 1200`）→ 会话 B 同 cwd 跑
**一次** pass → 断言：

- `report.adopted = 1`，evidence 是 `terminal 'njbox/t1' is live (working)`；
- `subagent status` 的真实渲染链（`classifyChildrenForStatus` + `renderStatusOverview`）输出
  `worker-0 — state=working` + `host=njbox` + `terminal=njbox/t1` + `Status · 1 live child`；
- 记录 `state=working` / `orphaned` 消失 / `reattached.host=njbox`；
- 等对端结束 → `watcher.tick()` → 通知恰 1 条（`Background task completed: **worker-0**` /
  `execution: success`）、账本行 `settled`、记录 `retired` + `execution: success`、
  `pendingReattachNotices() === []`；
- **第二次**起一次 pass（模拟再重启）⇒ 不采纳、无摘要、无第二条通知。
- 全程**没有调用 `recoverAction`**（这个测试文件根本没 import 它）。

对照组 `integration:5xx`（"WITHOUT the pass"）证明红在哪：同样现场，不跑 pass 时 `status`
给的是 `state=orphaned` + `owner: dead`，没有 `state=working`、没有 live 计数——就是 issue 的
"任务全没了"。

### 4.2 A2 不抢别人的（`integration:3xx`）

A 还活着（真起一个 `node -e setTimeout` 进程，把它的 pid 写进 `owner.json`）→ B 的 pass：
`considered = 0`（**连探测都没有**）、`adopted = 0`、`skipped[0].reason` 以
`owned by previous.jsonl` 开头、日志里是
`skipped worker-0 run=… host=njbox record=orphaned: owned by previous.jsonl (pid N is alive, …)`，
且记录仍是 `orphaned`、`reattached` 未写。

### 4.3 A3 幽灵行（`integration:3xx` #445 A3）

记录 `state: "working"`（**没更新**）而账本行 `retired` —— #441 的幽灵形状 → 不接管、不探测
（`considered = 0`）、理由 `already ended (retired): a settled/retired child is not adopted and
not announced`、记录原样保留、`formatReattachSummary = undefined`。单测里同样有三条
（`ledgerGate` 直接红 / `retired` 行不被 probe / 关闭时零 wire）。

### 4.4 A4 不可达（`integration:3xx` #445 A4）

`HC_BIN` 指向一个立刻 `exit 3` 的"核心" → pass `elapsed < 5000ms`，`skipped` 理由
`no liveness evidence: host 'njbox' could not be asked …`，记录仍是 `orphaned`。
单测另有一条：探测永不返回时按 `probeDeadlineMs` 收口（`did not answer within 120ms`），
并断言 `elapsed <= REATTACH_BUDGET_MS`。

### 4.5 变异（实际执行，非纸面）

| 变异 | 改法 | 结果 |
|---|---|---|
| A：活性判据 = "行存在就接管" | 删掉 `ledgerGate` 调用 + 把 `if (!verdict.live)` 短路 | **A3 红**（另外 A4 也红：不可达也变成"接管"）——`tests 8 / pass 6 / fail 2` |
| B：删掉 owner 检查 | 删掉 `ownerGate` 调用 | **A2 红**，其余 7 条全绿——`tests 8 / pass 7 / fail 1` |
| C：忽略闩锁 | 删掉 `alreadyNotified(child)` 的 `continue` | **单测 `pendingReattachNotices` 红**——`tests 21 / pass 20 / fail 1` |

三次变异都从备份还原（`cmp` 校验字节一致），随后全量三件套重跑全绿。

### 4.6 额外覆盖

- 无 terminal 地址的老记录（v4）：真 `file.read` 两次采样，transcript 增长 ⇒ 采纳，
  evidence 是 `transcript … is growing (N → M lines in 400ms)`（`integration:4xx`）。
- `no-run` 孤儿目录：只进 `mirrorOnly` + 摘要后缀，永不采纳（`integration:4xx`）。
- 真 wire：断言 fake core 的请求日志里真的有 `terminal.get` 且地址是那个 terminal
  （防止"没连上也算绿"）。
- 设置解析：`reattachLiveChildren: false` 经真实 `loadSubagentSettings` 读出来，project 覆盖
  user，错误形状报错（`unit` 最后一条）。
- watcher 的罢工预算：连续 3 次不可答 ⇒ 停止观看（不留无界 watcher）。
- 通知的最后一寸：`deliverReattachNotice`（`reattach.ts:1056`）在**替换后的新会话活通道**上投递成功
  ⇒ `true`；活通道抛错时退回捕获的 send；两边都失败 ⇒ `false`（闩锁不写，下次补发）。

## §5 门禁

```
npm run typecheck        ✔
npm test                 ✔ 2889 pass / 0 fail   (trunk 2866)
npm run test:integration ✔ 201 pass / 0 fail    (trunk 193)
```

（trunk 基线在同一 worktree、同一 `node_modules` 上实测：把本 PR 的两个测试文件拿掉后
`npm test` = 2866、`npm run test:integration` = 193。）

## §6 与 #441 的边界

- **没碰** `src/legion/stall-notice.ts`、`src/legion/orphan.ts`、stall 候选过滤；
- 幽灵行规则（"时钟已过阈值的 retired 行不是候选"）在这里是**问账本行**（`hasEnded`），
  不是复制一套判定；`orphan_detected` 标记本身不动（它记录的是"上一个会话退出时留下了它"，
  历史事实；watcher 结算后 `node_settled` 自然让它过期）。
- 本分支从 6.2.7 的 release 点切出（含已合入 master 的 #437 与 #442/#443）；如果 #441 先合，
  本分支与它没有文件交集，rebase 只需解决 `index.ts` 的 import 行。

## §7 已知限制（如实记录）

1. **不做 supervisor 级采纳**：没有 job，因此 `collect`/`wait`/`status <name>` 的**现有**语义
   不变（`status` 会显示它，`collect` 仍是"外来记录"那条既有路径）。理由写在
   `remote-recover.ts` 的模块注释里：两个 writer 写一条 child 账本行是比"看不见"更坏的 bug。
   本 issue 的验收只要 `status` + 完成通知。
2. **结算 = 一次 `recover`（核心）**：watcher 用 `recoverCrossMachineChild`，所以"恢复"和
   "平时 collect" 的评级永远一致；代价是它不复刻 `collect` 的 artifact 写入（见 §2.7 的闩锁落点）。
3. **同进程双开竞争**：`owner.json` 的认领是 last-writer-wins；真正的护栏是"活着的 owner pid"，
   并发启动的极端窗口下可能两个进程都认为自己是 owner（后写者覆盖）。已记录，未在本 PR 处理。
4. **孤儿目录只能在已配置/已探测过的主机上找**：`no-run` 扫描按 `hosts.<h>` 的前 3 台，
   discovery 出来的零配置主机不扫（宁可少报，不无界扩面）。
5. **`--print` / `--json` 会话退出时，在飞的 pass 不被取消**：`session_shutdown` 只停 watcher，
   不 abort 已在跑的 pass，所以"启动 pass 正在探测一台慢机器"的 headless 会话最坏会晚 5s 退出
   （预算上限）。没有做成可取消是为了不把 AbortSignal 再穿一层进 6 个 seam；如果将来需要，
   入口在 `index.ts:2010` 的 `startReattach`，接一条 signal 即可。

## §8 文件清单

| 文件 | 作用 |
|---|---|
| `src/runs/reattach.ts`（新，~1200 行） | 候选发现、活性判据、两道 gate、采纳、watcher、闩锁、生产 seam |
| `index.ts` | `session_start` 的 root-only 入口（1977-2123）、watcher 装配与 `session_shutdown` 停机（3201-3204）、import |
| `src/shared/types.ts` / `src/agents/settings.ts` | `subagents.reattachLiveChildren` 类型 + parser + 合并 |
| `test/helpers/fake-hc-core.mjs` | `finish_after_ms`（terminal 自己会结束）+ `FAKE_HC_TERMINAL_STATE`（跨进程看见 terminal，都是加法，不设环境变量时行为不变） |
| `test/unit/reattach.test.ts`（新，23 条） | 决策层 |
| `test/integration/reattach-live-children.test.ts`（新，8 条） | 端到端 |
