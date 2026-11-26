# 自动接回 / recover 的扫描面：从 per-cwd 扩到本机所有已知 store（#450）

- 基线：本 worktree 从 `33d8eb2`（6.2.9 发版点，含 #445/#447）切出；分支
  `pi-subagent/hw-nj/pi-legion-450-scope-989cef05`。PR base = `master`。
- 范围：#450 的四条设计要点 + 五组验收。**只扩扫描面**：`#445` 的七条硬约束
  （活性判据 / owner 闸 / 终态闸 / 有界 / 可关 / 一行摘要 / 闩锁）原样继承，一条没放松。
- **不碰** `src/legion/stall-notice.ts`、stall 候选过滤（#441 的地盘）；不动版本号 / 不打 tag / 不 publish。
- 门禁：`npm run typecheck` ✔，`npm test` **2942 pass**（HEAD 基线实测 2907），
  `npm run test:integration` **208 pass**（基线 201）。

---

## §1 现象与根因（实测复现）

issue 原文：今天的任务 `anotify-uishift-budget` 是从 `cwd=~/code/anotify` 派出去的，
账本落在 `~/code/anotify/.pi-subagents/runs/r-*/`；新会话在 `~/agents` 启动后

```
subagent status --all      →  No live children.
subagent recover <name>    →  No cross-machine child named "…" (searched ../code/pi-legion/.pi-subagents/runs)
```

两条答案其实是同一个事实：`#445` 的 session-start 自动接回与 `recover` 的账本发现都只读
**当前 cwd 的那一个 store**（`runStoreFor(cwd)` / `findRecoveryLedgerForName(store, …)`）。
本机实测：`~/code/anotify/.pi-subagents/runs` 里有 **207** 条 run，而当前会话的 store 是空的
—— 记录一直在，只是扫描面没伸过去。

**这不是 #445 实现错了，是它的扫描面只够"同 cwd 换会话"。** 本条只扩面，不改判定。

## §2 四条落地

### 2.1 账本记 launch-cwd（复用 `run.json.cwd`，不新增字段）

`run.json` 本来就有 `cwd`（`RunStore.createRun({cwd})`，即该 store 的启动目录），所以**没有新增
任何持久字段**：每个候选行自带 `storeRoot` + `storeCwd`，`storeCwd` 取 `run.json.cwd`，老记录没有
该字段时回落到 `dirname(storeRoot)`（`src/runs/reattach.ts:418` `launchCwdOf`，候选字段
`:196/:201`）。`store=` 标签由 `formatStoreLabel` 把 `$HOME` 折成 `~`
（`src/runs/store-scan.ts:198`）。`nodes` 表没有、也不需要 cwd 列。

### 2.2 扫描面 = 本机所有已知 store（有界）

新模块 `src/runs/store-scan.ts`（347 行，纯读、无 RunStore、无 ledger）：

| 规则 | 落点 |
|---|---|
| ① 当前 cwd 的 store（条件返回，允许尚未创建） | `store-scan.ts:211` `discoverLocalStores` 的 `push(cwd,"cwd",false)` |
| ② 调用方显式 `cwd` 的 store（#270） | 同上 `caller-cwd` |
| ③ `$HOME` 树：cwd 的祖先（含 `$HOME` 本身）各下探 2 层 ⇒ 同级 repo、`~/<group>/<repo>`；`~/agents` 因此能找到 `~/code/anotify` | `:245-273`（`home`/`sibling`/`*-nested`） |
| ④ 隐藏目录 / `node_modules` / `.pi-subagents` 自身不进入 | `:167` `skipEntry` |
| ⑤ 去重按 realpath（同一 store 的两种拼写只算一次） | `:229` `canonical` |
| ⑥ 上界：32 个 store / 240 个目录 / 每层 400 条目 / 深度 2 | `:58-66` 常量 + `:275-300` `walk` |
| ⑦ 超界如实上报（`truncated` + 一句 `skipped.reason`），不静默缩小 | `:243-257` / `:283-288` |

**`$HOME` 闸（为什么不是全盘扫）**：cwd 不在 `$HOME` 里时**完全不扫 `$HOME`**
（`store-scan.ts:245`，`insideHome` `:135`）。理由有两层，都写进了模块注释：语义上，
临时 cwd 不构成"用户在这个家目录里工作"的证据；工程上，否则每个测试/一次性会话都会继承
家目录下某个 checkout 的活 row（本机 `~/code/anotify` 就有 207 条），把逐字断言的输出污染掉。
扫描面是"这个会话所属的那棵树"，`$HOME` 是我们愿意称为这棵树的最大范围。

### 2.3 `status` / `list` / `recover` 跨 store 可见

- **`status` 总览**：每个 store 各按原规则分类（`classifyChildrenForStatus`，owner 判定读**那个**
  store 的 run 目录），store 内按名字去重、**跨 store 从不去重**；非会话 store 的行多一行
  `store=<label>`（`index.ts:7107` `scanSurfaceFor`、`:7167` `renderScanOverview`、
  `src/extension/runtime.ts:636` + `:898` 渲染）。单 store 会话的输出逐字不变。
- **`status <name>`**：走同一个扫描面（`index.ts:8447` `findChildrenAcrossStores`），外来记录带
  `store=`、owner 判定用**解析到的那个 store**（`:4028`）；同名同时存在于两个 store ⇒ 拒绝歧义并逐条
  列 `store=<label> run=<id>`（`:4345` `crossStoreAmbiguityMessage`），绝不静默挑一个。
- **`list all:true`**：roster 原样 + 空行 + 同一份跨 store **活动行**总览（`index.ts:2916-2936`）；
  不带 `all` 时与旧版逐字相同。
- **`recover`**：账本发现扩成"先找本 session 的 run（任意 store），再按 store 顺序找第一条同名账本"
  （`src/runs/remote-recover.ts:274` `findRecoveryLedgerAcrossStores`，`index.ts:7688` 调用）；
  找到的账本在**哪个 store 就写哪个 store**（记录镜像 `index.ts:7777-7788`、ownership 块读那个 store 的
  run）。miss 文案把所有搜索过的 store 按 `~` 标签列出来，`Waiting for recovery:` 提示保留。
- `#270` 的跨 store 查找顺带扩到同一扫描面（`src/runs/store-lookup.ts:176`，`MAX_SEARCHED_STORES`
  24 → 40，见 `:56`），所以 worktree child 的既有行为不变、可见面更大。

### 2.4 摘要仍一行

`formatReattachSummary(report, {home})`（`src/runs/reattach.ts:945`）：

- 全部来自会话自己的 store ⇒ **与 #445 逐字相同**：`legion: reattached 2 live children (a, b)`
  —— `#445` 的既有断言一个字都不用改；
- 有任何一条来自别的 store ⇒ 追加 ` — store ~/code/anotify` / ` — stores ~/code/anotify, ~/agents`
  （adoption 顺序、去重，位置在 `; ` 的 mirrorOnly/deferred 后缀之前），例如
  `legion: reattached 1 live child (anotify-uishift-budget) — store ~/code/anotify`。
  子名保留，因为"哪个孩子"比"哪个 store"更需要被看见；两者在同一行、仍是一行。

## §3 五组验收

### A1 端到端（`test/integration/reattach-cross-store.test.ts` + **真 pi 进程**）

`test/integration/reattach-cross-store-pi.test.ts`（2 条，**真 `pi --print` 进程** + mock provider，
本 worktree 作为 package 载入；`$HOME` 是临时树，两个项目目录是**真 store**）：
`~/code/anotify` 留下 `orphaned` 记录 + running 账本行 + 假 `njbox` 上真 terminal；新会话在
`~/agents`（**不同 cwd**）启动：

- `subagent status` 的真实输出里出现 `anotify-uishift-budget — state=working`、`host=njbox`、
  **`store=~/code/anotify`**；
- 采纳真的落盘：`~/code/anotify` 的 run.json 变 `working`、`orphaned` 消失、`reattached.host=njbox`；
- 会话自己 store 下的 `reattach-live-children.log` 有 `reattach stores=… withRuns=1 candidates=1`
  与 `adopted … store=~/code/anotify`；
- 第二条：让该 child 在 4s 后结束、会话活过 watcher 的首个 15s tick ⇒ 记录 `retired` +
  `execution=success`、账本行 `settled`、**`reattached.notifiedAt` 被写入**（闩锁只在送达后写，
  这证明完成通知真的到了新会话）。耗时 4.2s / 23.2s。

同文件（`reattach-cross-store.test.ts`，真 `hc` client + fake core 真 JSON-RPC + 真
`recoverCrossMachineChild` 评级/结算 + 真 run/ledger 文件）里的 A1 还断言：**discovery 本身**
（不是注入清单）把 `~/code/anotify` 带进扫描面；摘要 `— store ~/code/anotify`；通知 1 条、
账本 `settled`、闩锁写入、`pendingReattachNotices` 清空；**第二次启动**不再采纳、不再通知。

### A2 三个 store 一次看到，总耗时 ≤5s

`reattach-cross-store.test.ts` A2：`~/code/anotify` / `~/code/pi-legion` / `~/code/pi-async` 三个
store 各一条活 row ⇒ 一次 pass 全部采纳（`adopted=3`），实测 **429ms**（断言 `elapsed <= 5000`），
`report.stores.scanned=4 / withRuns=3 / deferred=0`，摘要一行含三个 store 标签。
本机真实数据另测（只读）：`cwd=~/code/pi-sop` ⇒ 5 个 store / 49 个目录、discovery **66ms**（冷）/
18ms（热）+ 读 runs 33ms；`~/code/anotify` ⇒ 4 个 store / 14ms + 14ms；`~` ⇒ 3 个 store / 8.5ms + 7ms。
远在 5s 预算内。

### A3 不串味（`(store,cwd,name)` 定位）

- pass 层：同名 `worker-0` 在两个 store ⇒ 2 条候选、2 次采纳、各自 run 目录各自 `owner.json`
  认领、watcher `watching()` 两条（key = `(storeRoot, runId, name)`，`reattach.ts:1090` `keyOf`）；
  只结算先结束的那条，另一条的记录仍是 `working`、账本行仍 `running`、闩锁未写。
- 工具层：`status` 中同名两条各出一块（跨 store 不去重），外来那条带 `store=`；`status <name>`
  遇到跨 store 同名 ⇒ 歧义拒绝并列出两个 `store=/run=`，不静默选择。

### A4 变异（实际执行，全部 `cmp` 校验还原）

| 变异 | 改法 | 结果 |
|---|---|---|
| M1a 扫描面回退成"只扫当前 cwd" | `runReattachPass` 里 `dedupeStores([input.store])` | cross-store 集成 **4/5 红**（A1/A2/A3/A5），真 pi E2E **2/2 红** |
| M1b 装配回退 | `index.ts` `startReattach` 不再传 `stores` | 真 pi E2E **2/2 红**；同进程 5 条仍绿（证明 E2E 钉的是 session_start 装配，不是 pass 本身） |
| M2 去掉 owner 闸 | `ownerGate` 恒 `undefined` | 单测 2 红（#445 §3 + #450 外来 store 的 owner 闸），`#445 A2` 集成 **红** —— 回归 #445 |
| M3 去掉终态闸 | `ledgerGate` 恒"可采纳" | 4 红（`#445 A3` + 3 条单测：ghost row / retired / missing ledger） |

M1a/M1b 的红正是"验收 1 必红"；M2/M3 的红是 `#445` 硬约束没被放松的回归证据。

### A5 目标机不可达 / store 很多：启动仍 ≤5s，日志给 reason

`reattach-cross-store.test.ts` A5：`HC_BIN` 指向"握手后带着写端死掉"的假核心 ⇒ pass 正常返回
（`report.error === undefined`）、`adopted=0`、理由 `no liveness evidence: host 'njbox' could not be
asked …`、日志行 `skipped … store=~/code/anotify`；"整趟有界"用**注入时钟**证明（`budgetMs: 1` ⇒
`deferred ≥ 1`），不用墙钟。store 很多时：`maxStores: 3` 命中上限 ⇒ `stats.truncated=true`、
`report.stores.truncated=true`、`report.stores.skipped` 带 `over the 3-store cap …` 一句，
日志同一条事实；pass 仍然返回。

**真机只读旁证**（真 `pi --print`、真 `$HOME`、不写任何真实账本）：
`cwd=~/code/pi-sop` 执行 `recover zzz-not-a-real-child` ⇒

```
No cross-machine child named "zzz-not-a-real-child" … (searched 5 stores: ~/code/pi-sop,
~/code/anotify, ~/code/anotify-wt/feat-node-namespace-ia, ~/code/homer-cli,
~/code/pi-legion-wt/fix-orphan-exit). …
```

即本机真实的 207-run store 也在面内，且标签是人能读的 `~` 形式。

## §4 `#445` 硬约束逐条对照（未放松）

| #445 约束 | #450 之后 |
|---|---|
| 活性判据（terminal 活 / 无 terminal 时 transcript 两次采样增长；`unknown ≠ live`） | 未改一行；外来 store 的候选走同一 `probeLiveness`（单测：外来 store 不可达 ⇒ 不采纳） |
| owner 闸（另一个活会话持有的行不接管） | 未改判定，只是读**那个 store** 的 `owner.json`；M2 变异证明它仍能红 |
| 终态闸（账本 settled/retired 既不接管也不通知） | 未改；`ledgerGate` 读的是**候选所属 store** 的账本；M3 变异证明 |
| `notifiedAt` 闩锁（送达后才写、未送达下次补发） | 未改；`pendingReattachNotices` 现在支持多 store，`PendingReattachNotice.storeRoot` 保证把闩锁写回**持有记录的那个 store**（`reattach.ts:1331`、`index.ts:2118`） |
| `subagents.reattachLiveChildren: false` | 未改，仍在 pass 最前面短路整个跨 store pass（单测：0 次探测） |
| 一行摘要 | 仍是一行（§2.4）；同 store 时逐字同 #445 |
| 有界（3s/child、≤20、5s） | 未改；新增的是**扫描面**的界（32 store / 240 目录 / 深度 2），且超界如实上报 |

## §5 门禁

```
npm run typecheck        ✔ (tsc --noEmit)
npm test                 ✔ 2942 pass / 0 fail    （本 worktree HEAD 33d8eb2 基线实测 2907）
npm run test:integration ✔ 208 pass / 0 fail     （基线 201）
```

说明：任务书写"master 2891 / 201"，而本 worktree 的 HEAD 是 6.2.9 发版点 `33d8eb2`，同机实测基线
**2907 / 201**；无论以哪个为基准都只增不减（+35 / +7）。`/tmp` 曾因历史临时目录占满导致一次
`Unknown system error -122`（EDQUOT），清理 45 分钟前的测试临时目录后复测全绿，与本改动无关。

## §6 文件清单

| 文件 | 作用 |
|---|---|
| `src/runs/store-scan.ts`（新，347 行） | 有界扫描面 + `~` 标签 + `scanLocalStoreRuns` |
| `src/runs/reattach.ts`（改，+318） | 候选带 store、`discoverReattachCandidatesAcrossStores`、pass 跨 store（一个预算）、watcher key、多 store 闩锁、摘要 store 后缀 |
| `index.ts`（改，+500） | `status` / `list all:true` / `recover` 跨 store；`status <name>` 跨 store 与歧义拒绝；session_start 装配（`stores` + `storeScan` + per-store 写回） |
| `src/extension/runtime.ts`（+13） | `renderLiveChildStatus` 的 `store=` 行（仅外来 store） |
| `src/runs/remote-recover.ts`（+86） | `findRecoveryLedgerAcrossStores`（own-run 优先 / store 顺序）、`RecoveryStore` |
| `src/runs/store-lookup.ts`（+41） | `candidateStoreRoots` 追加扫描面（`reason:"scan"`），上界 24 → 40 |
| `test/unit/store-scan.test.ts`（新，14 条） | 扫描面规则 / 界 / 去重 / 标签 / 自愈 `HOME` 闸 / `cwd=$HOME` 的情形 |
| `test/unit/reattach-cross-store.test.ts`（新，12 条） | 跨 store 候选、采纳、owner/终态闸、预算、闩锁、摘要 |
| `test/unit/cross-store-surface.test.ts`（新，9 条） | `status` / `list all:true` / `recover` / 歧义 / `store=` 行，真 temp dir + 真 sqlite |
| `test/integration/reattach-cross-store.test.ts`（新，5 条） | A1..A5（真 `hc` client + fake core + 真文件） |
| `test/integration/reattach-cross-store-pi.test.ts`（新，2 条） | **真 `pi --print` 进程**：不同 cwd 接回 + `store=` + 结算/通知闩锁 |

## §7 已知限制（如实记录）

1. **扫描面以 `$HOME` 为界**：cwd 在 `$HOME` 之外时不扫 `$HOME`（§2.2 的闸）。跨到 `$HOME` 之外
   的仓库（如 `/srv/...`）仍只能用显式 `cwd:`/`callerCwd` 或其同级目录。这是有意的取舍；
   若将来要放宽，入口只有 `store-scan.ts` 的 `insideHome` 一处。
2. **`status all:true` 的 `retired/finished` 段仍是会话自己 store 的历史**：活行跨 store 看，
   历史不跨。否则在一个 `~/agents` 里执行 `status all` 会把邻居仓库的全部历史倒出来
   （本机实测单个 store 就有 195 个终态名字），正是 #442/#445 明令避免的刷屏。
3. **`/legion status` 的 "waiting for recovery" 块仍是会话自己 store 的**：它每次渲染都会打开
   该 store 每条 run 的账本（本机 207 条约 120ms），跨 store 化会把这条常用路径拖慢一个数量级。
   `recover`（一个**动作**，不是每次渲染）已跨 store。
4. **同进程双开竞争仍在**：#445 §7.3 记录的 last-writer-wins 窗口没有变——扫描面变宽只是增加
   "两个会话同时启动"的概率，护栏仍是"活着的 owner pid"。已记录，未在本 PR 处理。
5. **真机 E2E 用假 `hc` core 顶替目标机**：本机 `hc machine ls` 为空，没有真实远端；
   `reattach-cross-store-pi.test.ts` 里"目标机"是 fake core 的 terminal 状态机（真 JSON-RPC、
   真跨进程可见性），这一点与 `#445` 的做法一致，区别是本条的**新会话是真 `pi` 进程、真
   session_start、真不同 cwd**。
6. `reattachLiveChildren: false` 只关自动接回；`status`/`list`/`recover` 的跨 store **读**仍照常
   （它们是控制动作，关掉自动接回之后仍然要能看见并处理活着的孩子）。
