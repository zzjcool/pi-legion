# 幽灵 `working` 行：`status` 说活着、`stop` 说不是本会话（#463）

- issue：https://github.com/zzjcool/pi-legion/issues/463
- 基线：`origin/master` = `cfc7ce4`（6.2.12，含 #460/#461）；分支
  `pi-subagent/pi-legion-463-ghost-bedbf500`，PR base = `master`，正文 `Fixes #463`。
- PR：https://github.com/zzjcool/pi-legion/pull/464（base `master`）。
- 契约：`docs/contracts/ghost-working-row-v1.md`（冻结后实现）。
- 范围：issue 的四条期望 + 三条验收（含两个变异）。**不动** #445 的接回决策、#456 的
  orphan 回收路径、#460 的 `unreachable` 语义、#209-3 的 dead/unknown 显示词。
- 门禁：`npm run typecheck` ✔；`npm test` **3004 tests / 2972 pass / 14 fail**，14 条
  与 `origin/master` 逐条同名（基线 **2983 / 2951 / 14 / 18 skipped**），新增 21 条测试全绿。

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
| 账本行 `hasEnded` | 记录跟随账本：`state=retired` + `retiredAt` + `unsupervised{ledger:"ended"}`；**不写账本**（账本是权威，#456） |
| 账本行 running / missing 且 `convergeVerdict` 说没人持有 | 记录状态不动，只打 `unsupervised{ledger:"running"|"missing"}` 标记 ⇒ `status` 显示 `unreachable (no supervisor)`，`stop` 可结算 |
| 被收养 / 活着 / 别的活会话持有 / 别的 host 的标记 / #456 orphan / 账本读不出 / 上一轮已标记 / 终态 | 与 6.2.12 **逐字节相同** |
| store 没有 `updateChild` | 什么都不收敛（只在内存里的标记比没有更糟） |

- 收养会 **清掉** 旧标记（有人持有 ⇒ 幽灵判决失效）。
- 有界：`REATTACH_CONVERGE_MAX_ROWS = 20` + 扫描自身 deadline，超出的计入
  `report.deferredConverge`（下一次启动再来），绝不静默丢弃。
- 一行话不变：收敛只在既有 summary 行尾加 ` (N converged)`，且**只有 N>0 时**；只有收敛、没有别的
  事发生 ⇒ 仍然不出声（记账不是新闻）。每次收敛写 `<storeRoot>/reattach-live-children.log`。

## §5 验收

### 5.1 单测（新增 21 条，全绿）

`test/unit/ghost-working-row.test.ts`（11）：

| 组 | 断言 |
|---|---|
| A 判据 | 持有/终态/#456 形态/别的活 pid/别的 host ⇒ 无判决；owner 死/无标记只有 `convergeVerdict` 收敛、`unsupervisedVerdict` 不（保住 #209-3 两个词）；已有标记即使 pid 随后死掉仍然有效 |
| B 渲染 | `state=unreachable (no supervisor)` + 紧跟其后的 `unreachable:` 证据行；去掉该后缀即逐字节还原旧块；概览不计 live + 表头 `(1 unreachable)`；被持有的同名 child 保持 `state=working` |
| C 端到端（真 `index.ts` + 真 `RunStore` + 真 SQLite + 真 `subagent` 工具） | **C1** 账本 `working` + 内存无此 child + `owner.json` pid = 本进程 ⇒ `status` 不再出现 `working`、`stop` 输出 `Settled …`、记录 `retired` + `reclaimed.verdict="no-supervisor"`、标记清空、再查 `status` 已不列；**C2** 本地 transcript 可评级 ⇒ 账本 `settled` + `node_settled{reclaimed:true}` + 记录带 `execution.status=success`；**C3（issue 的确切形状）** 记录在另一个 store ⇒ `status` 列出（带 `store=`）且 `stop`（不带 `runId`）跨 store 结算；**C4** 记录被别的活会话持有 ⇒ 仍显示 `working`、零写入 |

`test/unit/reattach-converge.test.ts`（10）：running 账本打标记不动状态 / ended 账本收敛成 retired
且账本零写入 / 别的活 pid 不动 / #456 orphan 不动 / 活体收养清标记 / 终态不动 / 无 `updateChild`
不抛不写 / 上限 + deferred / summary 一行与后缀 / 日志行。

### 5.2 真机（真 `pi` 进程，mock LLM，两次"重启"）

`test/mock-llm` + `writeMockPiHome({packages:[<本 worktree>]})` 起一个隔离 `PI_CODING_AGENT_DIR`，
每条命令都是一个**真的 `pi --print` 进程**（新进程 = 对 store 而言就是一次重启）：

1. **交付**：`MOCK_TOOL: subagent | {"action":"launch","agent":"scout","task":"MOCK_SAY: work done","async":false}`
   ⇒ `▶ scout-0 (scout) supervisor=inprocess` / `execution: success`，`run.json` 落
   `scout-0 state=retired … execution.status=success`（真 in-process child 交付）。
2. **重启（已交付/已退休不复活）**：把该记录按 issue 的现场改回幽灵快照（`state=working` +
   `execution.running` + `owner.json` 指向已消失的 pid；账本行仍是 `settled`），再起一个真 `pi`：
   - `reattach-live-children.log`：`converged scout-0 … how=ledger-ended record=working: ledger row
     root.scout-0 already ended (settled), so the record is converged to retired`
   - 记录 `state=retired` + `retiredAt` + `unsupervised{ledger:"ended"}`
   - `subagent status`：`No live children.`，`status all` 里它只剩 `scout-0 — state=retired`
3. **重启（无账本的幽灵 ⇒ unreachable 且可 stop）**：另建一条无账本的幽灵行（`state=working`，
   owner 已死），起真 `pi`：

   ```
   Status · 0 live children (1 unreachable)

   ghost-rc — state=unreachable (no supervisor) agent=scout kind=pi
   unreachable: run.json says working but this process holds no supervisor for it, and the run dir's owner (pid 999999998) is gone: no session can collect it
   ```

   再一次真 `pi` 执行 `stop`：

   ```
   Settled ghost-rc. verdict: no-supervisor (run.json says working but this process holds no supervisor for it, …) · ledger missing (execution: unknown) (the ledger row was not found; run.json is the half that was written).
   run record: retired; log: …/orphan-reclaim.log
   ```

   记录：`state=retired`、`reclaimed{verdict:"no-supervisor", ledgerStatus:"missing"}`、标记已清。

> 说明：本机没有可用 provider，真 in-process child 由仓库自带的 mock LLM 驱动；这不影响被验证的
> 路径 —— launch/交付/退休、`session_start` 的 reattach+收敛、`subagent status`/`stop` 都是真的。
> 第三幕的第一条命令里 `owner: live` 是**同一机制**的现场复现：收敛写记录时 `updateChild` 把
> `owner.json` 刷成了当前 `pi` 的 pid。

### 5.3 变异（两条，均红）

| 变异 | 结果 |
|---|---|
| M1：`unsupervisedVerdict` 恒返回 `undefined`（去掉显示/结算判决） | `ghost-working-row.test.ts` **5 红**，含验收 C1/C2/C3（`state=working` 又回来了、`stop` 又 `unknown child`） |
| M2：`convergeVerdict` 恒返回 `undefined`（去掉启动收敛） | `reattach-converge.test.ts` **3 红**（本地幽灵不打标记、deferred 不报、日志行缺失）；ledger-ended 那条仍绿 —— 它不依赖该判据，符合预期 |

## §6 不回归

| 家族 | 现有测试 | 结论 |
|---|---|---|
| #456 orphan 回收 | `test/unit/orphan-reclaim*.test.ts`、`test/integration/orphan-reclaim.test.ts` | 绿（orphan 路径未改；新增的 `no-supervisor` verdict 只在幽灵路径使用，`orphanVerdictWord` 补了对应词以保持穷尽 Record） |
| #445 接回 / #450 跨 store 扫描 | `test/unit/reattach*.test.ts`、`test/integration/reattach*.test.ts` | 绿（adopt/gate/预算/一行 summary 未变；`#450 §3` 条 ledger-ended 的 foreign 行仍"不探测、不收养"——它现在只多一个记录半边的收敛，测试原样通过） |
| #460 unreachable 不判死 | `test/unit/supervision-unreachable.test.ts` | 绿（supervisor 的 `unreachable` 状态、地址与记录保留语义未动；结算从不写 `failed`） |
| #209-3 dead/unknown 显示词 | `test/unit/status-action.test.ts` | 绿（owner dead ⇒ `state=failed`；无 owner 标记 ⇒ `state=working` 且 `owner: unknown`，两者只有启动扫描会收敛） |
| #312 作用域 | `test/unit/child-scope-actions.test.ts` | 绿（第一版曾把同名 decoy 结算掉，被该测试抓住后改成与 `stopAction` 完全一致的解析；见 §3） |

数字（本机 macOS，CI 是 ubuntu）：

```
npm run typecheck   → clean
npm test            → 3004 tests, 2972 pass, 14 fail, 18 skipped
origin/master 基线  → 2983 tests, 2951 pass, 14 fail, 18 skipped
逐条比对：14 条失败同名同因（provisionWorktree/npm 打包/v1.1 探测与 resolver/xm-dispatch），
均为本机既存红；新增 21 条全绿。
```

## §7 已知边界

1. **显式 `runId` 不跨 run/store 外扩**（#312 的纪律）：`stop name runId=<别的 run>` 对幽灵仍然
   拒绝（与 #456 对 orphan 的处理一致）。无 `runId` 时才用有界跨 store 面。
2. **会话有自己的 legion run 时**，本 store 里"另一个 run 的同名幽灵"走 `stopAction` 的
   `notDirectChild` 拒绝，不在这里结算 —— 与 #456 同一条既有边界。
3. 显示上 owner 死/无标记的老记录要等**下一次会话启动**收敛才变成 `unreachable (no supervisor)`；
   在那之前保持 #209-3 的词（`failed` / `working`）。这是刻意的：不覆盖更老的冻结契约。
4. 收敛只写记录，不写账本；账本为 `running` 的幽灵被 `retired` 后仍可 `recover` 取结果
   （`execution: unknown` 是可取回的形状）。
