# 幽灵 `working` 行：`status` 说活着、`stop` 说不是本会话（#463）

- issue：https://github.com/zzjcool/pi-legion/issues/463
- 基线：`origin/master` = `cfc7ce4`（6.2.12，含 #460/#461）；分支
  `pi-subagent/pi-legion-463-ghost-bedbf500`，PR base = `master`，正文 `Fixes #463`。
- PR：https://github.com/zzjcool/pi-legion/pull/464（base `master`）。
- 契约：`docs/contracts/ghost-working-row-v1.md`（冻结后实现）。
- 范围：issue 的四条期望 + 三条验收（含两个变异）。**不动** #445 的接回决策、#456 的
  orphan 回收路径、#460 的 `unreachable` 语义、#209-3 的 dead/unknown 显示词。
- 门禁（第二轮，修完 CI 红）：`npm run typecheck` ✔；`npm test` **3006 tests / 2974 pass /
  14 fail**，14 条与 `origin/master` 逐条同名（基线 **2983 / 2951 / 14 / 18 skipped**），
  新增 23 条测试全绿；`npm run test:integration` **221 / 211 pass / 10 fail**，10 条与基线
  逐条同名（macOS 既存红，见 §6）。CI（ubuntu）在该提交上四个步骤全绿。两轮修的边界见 §8。

---

## §1 现象与两个根因

重启（或同进程换会话）后，一条**早已交付并退休**的 in-process child 仍被 `status` 当作
live child 列着，而 `stop` 到不了它：

```
status → state=working owner: live supervisor=inprocess execution: running (…)
stop   → unknown child: legion-460-unreachable (not tracked by this session)
```

两个独立缺陷，缺一不可：

| # | 根因 | 代码位置（改前） |
|---|---|---|
| C1 | `status` 用 `owner.json` 的 pid 判活，而 **`owner.json` 的 pid 不是这个孩子**：它是"最后写这个 run dir 的进程"，任何一次写入都会把它刷成当前进程。于是一条陈旧的 `working` 记录因为"pid 就是正在问的进程"而读出 `owner: live`，被计入 live child。 | `index.ts` `classifyChildrenForStatus`（`live = orphaned !== true && !(owner === "dead" && !alive)`）、`ownerVerdictFor` → `src/runs/owner.ts:ownerState` |
| C2 | `status` 扫**整个有界 store 面**（`scanSurfaceFor`），`stop` 只读本会话的 store（`stopAction` → `input.store.listRuns()`）：记录在 worktree 的 store 里（issue 里的 `store=~/code/pi-legion-wt-460`），于是"列得出来、停不掉"。 | `index.ts` `scanSurfaceFor` / `stopAction` |

真机复现也证实了 C1 的机制：`RunStore.updateChild` 写记录时会顺带把 `owner.json` 刷成当前
进程的 pid —— 收敛步骤写完标记后，同一行的 owner 立刻变成"活着的本进程"（§5 第二幕）。

## §2 一个判据，两个视图

新模块 `src/runs/unsupervised-row.ts`（~250 行）只回答一个问题：**这个孩子现在有人持有吗？**

```ts
unsupervisedVerdict(child, facts)  // status 显示 + stop 手工结算（能当场证明的两种）
convergeVerdict(child, facts)     // 会话启动扫描收敛（更宽：owner 死/缺标记也算"没人持有"）
```

两者共用同一段 `unheld()` 判据，因此不可能给出不同答案：

| 事实 | 答案 |
|---|---|
| 本进程 supervisor 有条目 / 会话 job 表里有它（`alive`/`tracked`） | 有人持有 —— 不是幽灵 |
| 本会话收养过它（`reattached.sessionFile` = 本会话的 transcript） | 有人持有（`ReattachWatcher`）—— 不是幽灵（§8.2） |
| `owner.json` 是**另一个活着的** pid | 别的会话持有 —— 不动（#445 §3） |
| `owner.json` 写在**别的 host** | 这里无法核实 —— 不动（#456 F8） |
| #456 的 orphaned leftover（host + orphan 标记） | 归 #456 —— 本模块不碰 |
| 记录已是终态（`retired`/`exited`/`failed`/`settled`） | 历史 —— 绝不复活 |
| 其余（`working`/`launching`/`awaiting`，无 supervisor，无别的活会话） | **`no supervisor`** |

**显示与结算只认能当场证明的两种**（`unsupervisedVerdict`）：记录上已有收敛标记，或
`owner.json` 的 pid **就是本进程**（`owner: live` 是标记在说谎，不是有会话在跑）。这是为了
不覆盖 #209-3 冻结的两个词：owner 死 ⇒ `state=failed`、无 owner 标记 ⇒ 保持 `state=working`
（`test/unit/status-action.test.ts` 五条钉住）。更宽的那种（owner 死/无标记）由**启动扫描**收敛，
证据在那边才拿得到。

渲染（`src/extension/runtime.ts`，与 #456 的 `orphanWord` 同形：只加后缀，不动既有行）：

```
ghost-rc — state=unreachable (no supervisor) agent=scout kind=pi
unreachable: run.json says working but this process holds no supervisor for it, …
owner: live
```

- `status` 概览不把它计入 live：表头变成 `Status · 0 live children (1 unreachable)`（只有真的
  有幽灵时才出现该后缀，无幽灵时输出与 6.2.12 逐字节相同）。
- 具名 `status` 用同一套 facts（它本来就跨 store 解析）。

## §3 `stop`：列得出来就结算得了

`index.ts` 在 #456 的 `reclaimOrphanOnStop` 之后再走一步 `settleUnsupervisedOnStop`，**解析规则
与 `stopAction` 完全一致**（`scopeRunIdFor` → `foundInScope` → `scopeHitFor` → 单候选
`foundElsewhere`；显式 `runId` 永不外扩），因此不会出现"报告的是本会话的节点、退休的却是别的
run 的同名记录"（#312，`test/unit/child-scope-actions.test.ts` 钉住）。本 store 里彻底没有这个
名字时，才走 `orphanSurfaceStores` 的有界跨 store 面（与 #456 同一条路，>1 命中 ⇒ 歧义拒绝）。

结算复用 #456 的**唯一写路径** `reclaimOrphan`，新增 verdict `no-supervisor`：

1. 无 kill、无终端探测（本地行没有终端）；
2. 账本按 `collect`/`recover` 同一把梯子结束：孩子**自己的 transcript**（`ChildRecord.sessionFile`，
   本地文件、零 wire）能评级 ⇒ `settledStatusFor` + `node_settled`/`node_failed` + usage；
   评不出 ⇒ `node_retired{execution:"unknown"}` —— **绝不 `failed`**（#460：没人回答不等于判决死亡）；
3. `run.json`：`state=retired`、`retiredAt`、删 `orphaned` / `unsupervised`、写
   `reclaimed{at,verdict:"no-supervisor",evidence,ledgerStatus,sessionFile}`。

拒绝面保留：记录在窗口内被别的会话**收养**（`reattached`）或被别人结算 ⇒ 零写入拒绝（#456 F8 的
竞态守卫沿用，只是对幽灵不再把 `state === "working"` 当作"被收养"的信号 —— 那正是要修的谎）。

## §4 重启收敛：`src/runs/reattach.ts`

#445 的启动扫描过去只会 **adopt**；adopt 不了的 row 只写日志、原样留着。现在同一次扫描（同一组
store、同一个 5s 预算、一次 `listRuns()` 读两用）多走一步 `convergeLeftovers`：

| leftover | 处理 |
|---|---|
| 账本行 running / missing 且 `convergeVerdict` 说没人持有 | 记录状态不动，只打 `unsupervised{ledger:"running"|"missing"}` 标记 ⇒ `status` 显示 `unreachable (no supervisor)`，`stop` 可结算 |
| 账本行 `hasEnded` | **零写入**，只写一行日志：#445 A3 冻结了这个形状（"a settled/retired child is not adopted and not announced"），记录**原样保留**（`state=working` 仍是 #209-3 的词）。见 §8 |
| 被收养 / 活着 / 别的活会话持有 / 本会话自己的收养 / 别的 host 的标记 / #456 orphan / 账本读不出 / 上一轮已标记 / 终态 | 与 6.2.12 **逐字节相同** |
| store 没有 `updateChild` | 什么都不收敛（只在内存里的标记比没有更糟） |

- 收养会 **清掉** 旧标记（有人持有 ⇒ 幽灵判决失效），并写下 `reattached.sessionFile` —— 这条
  时间戳既是 #445 的"谁收养的"，也是判据里"谁持有"的证据（§8 的 #450 A1 半边）。
- 有界：`REATTACH_CONVERGE_MAX_ROWS = 20` + 扫描自身 deadline，超出的计入
  `report.deferredConverge`（下一次启动再来），绝不静默丢弃。
- 一行话不变：收敛只在既有 summary 行尾加 ` (N converged)`，且**只有 N>0 时**；只有收敛、没有别的
  事发生 ⇒ 仍然不出声（记账不是新闻）。每次收敛写 `<storeRoot>/reattach-live-children.log`。

## §5 验收

### 5.1 单测（新增 23 条，全绿）

`test/unit/ghost-working-row.test.ts`（13）：

| 组 | 断言 |
|---|---|
| A 判据 | 持有/终态/#456 形态/别的活 pid/别的 host ⇒ 无判决；owner 死/无标记只有 `convergeVerdict` 收敛、`unsupervisedVerdict` 不（保住 #209-3 两个词）；已有标记即使 pid 随后死掉仍然有效 |
| B 渲染 | `state=unreachable (no supervisor)` + 紧跟其后的 `unreachable:` 证据行；去掉该后缀即逐字节还原旧块；概览不计 live + 表头 `(1 unreachable)`；被持有的同名 child 保持 `state=working` |
| C 端到端（真 `index.ts` + 真 `RunStore` + 真 SQLite + 真 `subagent` 工具） | **C1** 账本 `working` + 内存无此 child + `owner.json` pid = 本进程 ⇒ `status` 不再出现 `working`、`stop` 输出 `Settled …`、记录 `retired` + `reclaimed.verdict="no-supervisor"`、标记清空、再查 `status` 已不列；**C2** 本地 transcript 可评级 ⇒ 账本 `settled` + `node_settled{reclaimed:true}` + 记录带 `execution.status=success`；**C3（issue 的确切形状）** 记录在另一个 store ⇒ `status` 列出（带 `store=`）且 `stop`（不带 `runId`）跨 store 结算；**C4** 记录被别的活会话持有 ⇒ 仍显示 `working`、零写入；**C5** 记录被**已消失**的会话收养过 ⇒ `status` 说 `unreachable` 且 `stop` 能结算（§8.3） |

`test/unit/reattach-converge.test.ts`（10）：running 账本打标记不动状态 / **ended 账本零写入、
记录原样、不出声**（`#463 ✕ #445 A3`，§8）/ 别的活 pid 不动 / #456 orphan 不动 / 活体收养清标记 /
终态不动 / 无 `updateChild` 不抛不写 / 上限 + deferred / summary 一行与后缀 / 日志行。

`test/unit/ghost-working-row.test.ts` 的 A 组另有一条边界断言（`#463 A ✕ #450 A1`）：本会话
**收养**的行不算幽灵（`reattached.sessionFile` = 本会话），上一个会话的收养标记则算。

### 5.2 真机（真 `pi` 进程，mock LLM，两次"重启"）

`test/mock-llm` + `writeMockPiHome({packages:[<本 worktree>]})` 起一个隔离 `PI_CODING_AGENT_DIR`，
每条命令都是一个**真的 `pi --print` 进程**（新进程 = 对 store 而言就是一次重启）：

1. **交付**：`MOCK_TOOL: subagent | {"action":"launch","agent":"scout","task":"MOCK_SAY: work done","async":false}`
   ⇒ `▶ scout-0 (scout) supervisor=inprocess` / `execution: success`，`run.json` 落
   `scout-0 state=retired … execution.status=success`（真 in-process child 交付）。
2. **重启（账本已终态 ⇒ 原样不动，#445 A3）**：把一条记录按 issue 的现场摆成
   `state=working` + `execution.running` + `owner.json` 指向已消失的 pid，账本行 `retired`，
   再起一个真 `pi`：
   - `reattach-live-children.log`：`left ended-rc run=r-ended store=~/agents record=working: ledger
     row root.ended-rc already ended (retired), and a settled/retired child is not adopted and not
     announced`
   - 记录：`state=working`、无 `retiredAt`、**无 `unsupervised` 标记**（一个字节都没写）
   - `subagent status`：它按 #209-3 的老词出现（owner 死 ⇒ `state=failed`），计入 `(1 dead)`，
     不进 live 数；summary 行**不出现** ` (N converged)` —— 记账不是公告。
3. **重启（无账本的幽灵 ⇒ unreachable 且可 stop）**：另建一条无账本、owner 已死的幽灵行
   （`state=working`），同一个真 `pi` 里：

   ```
   Status · 0 live children (1 unreachable)
   (1 dead)

   ended-rc — state=failed …
   owner: dead (pid gone)

   ghost-rc — state=unreachable (no supervisor) agent=worker kind=pi
   unreachable: run.json says working but this process holds no supervisor for it, and the run dir's owner (pid 2147483000) is gone: no session can collect it
   owner: live
   ```

   再一次真 `pi` 执行 `stop`：

   ```
   Settled ghost-rc. verdict: no-supervisor (run.json says working but this process holds no supervisor for it, …) · ledger missing (execution: unknown) (the ledger row was not found; run.json is the half that was written).
   run record: retired; log: ~/agents/orphan-reclaim.log
   ```

   记录：`state=retired`、`reclaimed{verdict:"no-supervisor", ledgerStatus:"missing"}`、标记已清；
   `reattach-live-children.log` 里是 `converged ghost-rc … how=no-supervisor ledger=missing`。

> 说明：本机没有可用 provider，真 in-process child 由仓库自带的 mock LLM 驱动；这不影响被验证的
> 路径 —— launch/交付/退休、`session_start` 的 reattach+收敛、`subagent status`/`stop` 都是真的。
> `ghost-rc` 那行的 `owner: live` 与 `ended-rc` 那行的 `owner: dead` 同出**一个**规则：
> `owner.json` 的 pid 是"最后写这个 run dir 的进程"，收敛写记录时 `updateChild` 会把它刷成本进程。

### 5.3 变异（两条，均红）

| 变异 | 结果 |
|---|---|
| M1：`unsupervisedVerdict` 恒返回 `undefined`（去掉显示/结算判决） | `ghost-working-row.test.ts` **5 红**，含验收 C1/C2/C3（`state=working` 又回来了、`stop` 又 `unknown child`） |
| M2：整段 `convergeLeftovers` 不再被调用（去掉启动收敛） | `reattach-converge.test.ts` **4 红**：本地幽灵不打标记（#1）、`#463 ✕ #445 A3` 那条的 `left …` 日志消失（#2）、deferred 不报（#8）、收敛日志行缺失（#10） |
| M3：删掉"M 是本会话收养"这条豁免（`reattached.sessionFile` 判据） | `ghost-working-row.test.ts` 的 `#463 A ✕ #450 A1` 红 —— 这条钉住的正是本次 CI 的 #450 A1 |

## §6 不回归

| 家族 | 现有测试 | 结论 |
|---|---|---|
| #456 orphan 回收 | `test/unit/orphan-reclaim*.test.ts`、`test/integration/orphan-reclaim.test.ts` | 绿（orphan 路径未改；新增的 `no-supervisor` verdict 只在幽灵路径使用，`orphanVerdictWord` 补了对应词以保持穷尽 Record） |
| #445 接回 / #450 跨 store 扫描 | `test/unit/reattach*.test.ts`、`test/integration/reattach*.test.ts` | 绿（adopt/gate/预算/一行 summary 未变；ledger-ended 的 foreign 行仍"不探测、不收养"，记录半边同样**零写入**——A3 的边界见 §8.1；#450 A1 的"刚收养就必须仍算 live"见 §8.2） |
| #460 unreachable 不判死 | `test/unit/supervision-unreachable.test.ts` | 绿（supervisor 的 `unreachable` 状态、地址与记录保留语义未动；结算从不写 `failed`） |
| #209-3 dead/unknown 显示词 | `test/unit/status-action.test.ts` | 绿（owner dead ⇒ `state=failed`；无 owner 标记 ⇒ `state=working` 且 `owner: unknown`，两者只有启动扫描会收敛） |
| #312 作用域 | `test/unit/child-scope-actions.test.ts` | 绿（第一版曾把同名 decoy 结算掉，被该测试抓住后改成与 `stopAction` 完全一致的解析；见 §3） |

数字（本机 macOS，CI 是 ubuntu；`origin/master` 逐条比）：

```
npm run typecheck        → clean
npm test                 → 3006 tests, 2974 pass, 14 fail, 18 skipped
origin/master 基线 (unit) → 2983 tests, 2951 pass, 14 fail, 18 skipped
逐条比对：14 条失败同名同因（provisionWorktree/npm 打包/v1.1 探测与 resolver/xm-dispatch），
均为本机既存红；新增 23 条全绿。

npm run test:integration → 221 tests, 211 pass, 10 fail
origin/master 基线 (integration) → 221 tests, 211 pass, 10 fail（同样那 10 条）
```

10 条 integration 红是**本机既存**、与 #463 无关：`fake-core-host-discovery` / `xm-dispatch`
一族在 macOS 的 `/bin/sh` 下报 `case … ;;` 语法错（CI 是 ubuntu，全绿）。另有两处**测量方式**
注意点：

- 本机 `$TMPDIR` 是 `/var/folders/…`（`/private/var/…` 的符号链接），而 `process.cwd()` 返回
  realpath ⇒ `#450` 的 `$HOME` 门（"cwd 在 `$HOME` 内才扫 home"）在 macOS 上判 false，那两条
  真 `pi` 用例（`#450 A1 (real pi)`）会扫不到跨 cwd 的 store。用 `TMPDIR=$(realpath $TMPDIR)`
  重跑即恢复正常；基线分支同样表现，与本次改动无关。
- 修前 `#450 A1 (real pi)` 在**同一** TMPDIR 下复现出 CI 的原始失败
  （`Status · 0 live children (1 unreachable)`，本报告 §8）。

## §7 已知边界

1. **显式 `runId` 不跨 run/store 外扩**（#312 的纪律）：`stop name runId=<别的 run>` 对幽灵仍然
   拒绝（与 #456 对 orphan 的处理一致）。无 `runId` 时才用有界跨 store 面。
2. **会话有自己的 legion run 时**，本 store 里"另一个 run 的同名幽灵"走 `stopAction` 的
   `notDirectChild` 拒绝，不在这里结算 —— 与 #456 同一条既有边界。
3. 显示上 owner 死/无标记的老记录要等**下一次会话启动**收敛才变成 `unreachable (no supervisor)`；
   在那之前保持 #209-3 的词（`failed` / `working`）。这是刻意的：不覆盖更老的冻结契约。
4. 收敛只写记录，不写账本；账本为 `running` 的幽灵被 `retired` 后仍可 `recover` 取结果
   （`execution: unknown` 是可取回的形状）。
5. **会话标识 ≠ 进程标识**：§8.2 的豁免读 `reattached.sessionFile`（会话身份）。两种边缘因此
   保守地**不**收敛（保持 6.2.12 的显示，不会误判成幽灵）：`pi --continue` 续接同一个 session
   file 时，上一个进程写下的收养戳与本会话同名；收养时 `getSessionFile()` 为空（内存会话）则
   根本没写戳。反过来的风险（同一进程内换会话、扩展实例存活 ⇒ 戳不再同名 ⇒ 一条 watcher 还持有
   的行被显示/结算成幽灵）属于"持有者其实是内存里的 `ReattachWatcher`"这一层，本 PR 未改：
   要彻底解决得把 watcher 的 `watching()` 作为一条 facts 传进来（identity 与判据的
   `(storeRoot, runId, name)` 一致），留作后续。
6. `convergeLeftovers` 的 `deferred` 计数发生在读账本之前，因此"账本已终态、永远不会再收敛"的
   行也会被算进 `deferredConverge`（只影响日志里的数字，不影响 summary：summary 用的是
   `report.deferred`，跨机那半边）。

## §8 与 #450/#445 的边界（PR #464 的 CI 红，两个方向各越界一次）

第一版收敛同时做了两件"顺手"的事，被两条冻结用例各自抓住。两条红都不是 flake：修前在真机上
可稳定复现（`#450 A1` 的复现输出见下），修后两条都绿，且断言一行未改。

### 8.1 `#445 A3`：账本已 retired 的行，一个字都不该写

```ts
test("#445 A3: a retired LEDGER row is neither adopted nor announced, even though the record says `working`")
  …
  assert.equal(h.store.findChild(h.runId, NAME)!.state, "working", "a ghost row is left exactly as found");
  assert.equal(formatReattachSummary(report), undefined, "nothing to say");
```

**这条在守什么**：账本的终态是**权威**（#456），而且"已结束"这件事本身不是启动扫描的判决 ——
扫描对一条账本已 `retired`/`settled`/`failed` 的行没有任何可说的，它只能"不收养、不公告"，
把记录留在现场。这和 #209-3 冻结的两个显示词是一套纪律：owner 死 ⇒ `state=failed`、无标记 ⇒
`state=working`，都**只有**启动扫描能改写，而扫描对已结束的行不改写。换句话说：这条守的是
"**回归到更早的冻结语义**"——记录 `working` + 账本 `retired` 这个组合，是 #441 的老形状，
显示层怎么读由 #209-3 定，不是 #463 的收敛可以顺手"纠正"成 `retired` 的。

**第一版为什么越界**：`convergeLeftovers` 有一条 `ledger === "ended"` 分支，把记录"跟随账本"
写成 `state=retired` + `retiredAt` + `unsupervised{ledger:"ended"}`。它的出发点没错（#456 说
账本是权威），但**方向反了**：账本已经结束的行不需要再被收敛成一个新的判决 —— 它已经是历史，
写它只会把 #441 的老形状改成 #463 的新形状，而这正是 A3 明令禁止的那一步。

**怎么改的**：整条分支删掉，`ledger === "ended"` 变成"记一行日志、零写入"。代价（明确接受）：
这种行在重启后仍按 #209-3 的老词显示（owner 死 ⇒ `failed`），要清掉它得靠 #456 的 orphan 路径
或运维手工 —— 它在 #463 的 issue 文本里不是目标（issue 期望 4 写的是"**账本说 working** 但本会话
不认识"的行），也不是本 PR 的增量。`UnsupervisedMark.ledger` 因此收窄成 `"running" | "missing"`，
`ReattachConvergeHow` 这个"两种收敛"的联合类型一并删掉（只剩一种，留着就是死代码）。

### 8.2 `#450 A1`：本会话刚收养的 child，不能被自己的判据当成幽灵

```ts
test("#450 A1 (real pi): restarting in a DIFFERENT cwd re-attaches the leftover and `status` shows it with `store=`")
  …
  assert.match(output, new RegExp(`${NAME} — state=working`), "the leftover must be listed by name");
  assert.match(output, /store=~\/code\/anotify/, "the block must say which store the child lives in");
```

**这条在守什么**：#450 的全部意义 —— 在**另一个 cwd** 重启后，#445 的接回仍要把上一条会话留下的
child 接上，而且 `status` 必须把**刚接上的**那条当真 child 列出来（带 `store=`）。它是"接回成功"
的唯一端到端证据：跨 store、真 `pi` 进程、真 `store=` 行。

**第一版为什么越界**：`owner.json` 的 pid 在收养写记录时被 `updateChild` 刷成了**本进程**，
而收养出来的行既没有 supervisor 条目、也没有 job（持有它的是 `ReattachWatcher`）——
`unsupervisedVerdict` 只看 `alive`/`tracked`/`owner`，于是刚被自己收养的行被自己判成
`unreachable (no supervisor)`：

```
Status · 0 live children (1 unreachable)        ← 修前 CI（真机同样复现）
anotify-uishift-budget — state=unreachable (no supervisor) …
store=~/code/anotify
```

判决本身"对"（确实没有 supervisor），但它回答的**不是**"有没有人持有"：watcher 就是持有人。
判据里缺一条"**本会话**收养过它"的事实。

**怎么改的**：`UnsupervisedFacts.sessionFile`（会话自己的 transcript）+ 收养写下的
`reattached.sessionFile`：

```ts
// 2b. THIS session adopted it: the re-attach watcher holds it.
if (facts.sessionFile !== undefined && child.reattached?.sessionFile !== undefined) {
    if (path.resolve(child.reattached.sessionFile) === path.resolve(facts.sessionFile)) return undefined;
}
```

作用域和规则本身一样重要：**上一个会话**的收养标记**不算**（那个会话已经没了，那才是 #463 的
幽灵），所以这条豁免是"我"，不是"任何收养"。调用侧把 `ctx.sessionManager.getSessionFile()`
（`status` 扫表 / 具名 `status` / `stop` 结算 / 启动扫描）一路传进 facts，收养与读取用的是
**同一个**来源，因此两侧不会因为路径拼写不同而漏判（比较时 `path.resolve` 归一）。

### 8.3 `stop` 的收养竞态守卫：同一条判据，否则列得出来也停不掉

```ts
test("#463 C5: a row a GONE session adopted is still settlable (a stamp is not a live claim)")
  …
  assert.match(stopped.text, /^Settled ghost-adopted\./m, "a dead session's adoption stamp is not a live claim");
```

`reclaimOrphan` 的 `no-supervisor` 路径上有一条 #456 F8 的竞态守卫："记录在窗口内被别人收养
（`reattached`）⇒ 零写入拒绝"。它原来把**任何** `reattached` 当活认领，于是 §8.2 判成幽灵的那种
行（"**上一个**会话收养、会话已死"）会出现自相矛盾的一对回答：

```
status → ghost-adopted — state=unreachable (no supervisor)
stop   → Refusing to settle ghost-adopted: another session adopted this child …
```

这正是 issue 期望 1（能列出就能 stop）禁止的形状。修法与 §8.2 同源：`heldByThisSession()` ——
**只有写下时间戳的会话就是正在问的会话**才算活认领，比较方式（`path.resolve` 两侧）与判据里的
收养条款逐字相同；读记录前的预检和 `updateChild` 里的二次预检都用它。变异验证：把
`heldByThisSession` 退回"有戳即拒" ⇒ C5 立刻红（`Refusing to settle …`）。

### 8.4 边界一句话

| 面 | #463 可以动 | #463 不许动 |
|---|---|---|
| 账本 | 只读（`hasEnded` 当作"不改写"的理由） | 任何写入；把已终态行重新判成别的词 |
| 记录 | 给"没人持有且账本仍开着"的行打 `unsupervised` 标记（状态不动） | 账本已终态的行（#445 A3）；本会话收养过的行（#450 A1）；被别处持有的行 |
| 显示 | 给打了标记 / 本进程自己就是 `owner.json` 的行一个 `unreachable (no supervisor)` | 覆盖 #209-3 的两个词；把一条 live child 从 live 数里摘掉 |
| 公告 | 只给既有 summary 行加 ` (N converged)` 后缀 | 自己造一条 summary 行；把"账本已终态"算进公告 |
