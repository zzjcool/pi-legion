# #460 — 监督读失败被当成 child 死亡：`unreachable` 状态

> 状态：已实现 + 已验证（单测 13 条 + 1 条远端用例 / 变异 4 条）。
> 基线 `origin/master` @ `2a6acb3`（6.2.11），分支 `fix/460-supervision-unreachable`。
> 门禁：`npm run typecheck` ✅ ｜ `npm test` **2983 tests / 2951 pass / 14 fail**
> —— 14 个 fail 与该 checkout 的 trunk **逐条同名同数**（环境依赖，§5），本 diff 未新增任何失败。

## 0. 一句话

`terminal.get` / 心跳的 **transport 失败**不再被压成 `START_FAILED`：终端后端进入 `unreachable`
（地址、run 记录、worktree 全留，`isAlive` 仍为真），首轮最快 ~3s 就把「我看不见它」告诉调用方，
之后按调用方自己的预算慢轮询（不再每次 3s 重挂）；期间 `collect`/`wait` 回
**`running` + 「supervision unreachable … child may STILL be running」**，而不是 `failed`。
只有**确证死亡**（`terminal.get` 回 `not_found`，或终端自己 `finished`）才结算为死亡。

## 1. 事故链（2026-11-23）

```
03:0x  launch → host-workspace（worktree=true）
       宿主侧：execution: failed
       (terminal.get failed for terminal 'lgl-r-3a9b71-…': hc connect exited (code 0))
07:06  orphan detected：同一条记录 status=running，no active supervisor / no heartbeat 94151ms
之后    远端 child 还活着，把整颗 #548 实现完并自己开了 PR（= 重复实现，两份 PR）
```

| 环 | 位置 | 事实 |
|---|---|---|
| ① transport 错误被当生命周期事实 | `terminal-supervisor.ts` `failure()`：`"<op> failed for terminal '<addr>': <detail>"` + `ErrorCodes.START_FAILED` | `waitSettled` 的 `terminal.get` catch 直接 `throw this.failure(...)`；`hc connect exited (code 0)` 与「child 结束」共用同一条出口 |
| ② 抛错 → `failed` | `src/extension/notify.ts` `collectFailureInput()` | **任何**从 `collect` 抛出的东西都变成 `execution: {status:"failed"}` 的完成通知 |
| ③ 地址与记录随判定一起失去意义 | `isAlive()` 只认 `state === "live"` | 一旦被判死，`stop`/`status` 都不再指向那颗终端，孤儿只能靠 7 小时后的人工发现 |
| ④ 上层重派 | 宿主侧 `execution: failed` ⇒ 换 worktree 重派 | 两份实现 |

## 2. 修法落点

| # | 改动 | 位置 | 钉住它的测试 |
|---|---|---|---|
| A | **`unreachable` 状态**：`TerminalChildState = "live" \| "unreachable" \| "finished" \| "retired"`；记录带 `unreachable:{detail,since,strikes,epochs}`（`since` = 本次断线的**第一次**失败时刻） | `src/supervisor/terminal-supervisor.ts` | 用例 1（mid-poll 状态序列 `live → unreachable`）、用例 3（`since` 跨 epoch 不变） |
| B | **首轮有上限**：`waitSettled` 的 transport catch 不再抛；连续失败 **`UNREACHABLE_STRIKE_LIMIT = 3`**（可注入 `unreachableStrikeLimit`）或调用方 deadline 到点 ⇒ 回 `{settled:false, abnormal:false, reason:"supervision unreachable", unreachable:{detail,strikes}}`。**`abnormal:false` 是承重墙** | 同上 | 用例 2（`strikes===3` 且 `terminal.get` **恰好 3** 次）；用例 9（`unreachableStrikeLimit:1` ⇒ 1 次）；用例 10（成功读一次后 `strikes` 归零重来） |
| C | **后续 epoch 不再快返**（否则 watch 的 `rearmLiveWatch` 会 ~3s 重挂一次 —— 那才是「无界重试」）：`epochs > 0` 时按 **`UNREACHABLE_SLOW_POLL_MS = 30s`** 轮询，到**调用方自己的 deadline** 才回答；`deadline = Infinity` 时另有 `UNREACHABLE_SLOW_MAX_POLLS = 8` 硬上限 | 同上 | 用例 3（第二次 wait 必须花掉 400ms 预算、期间读次数 ≤3） |
| D | **恢复即续跟**：读取成功 ⇒ `applyFacts` 把 `unreachable` 折回 `live` 并清标记，`strikes` 归零，**同一次 `waitSettled` 继续**跑 | 同上 | 用例 1 的 recovery 分支 + 结尾 `state === "live"`、`unreachable === undefined` |
| E | **不许复活已终止记录**：catch 里先判 `finished`/`retired` ⇒ 直接回 `{abnormal:true, reason:"terminal <state>"}`，不改状态（否则 `isAlive` 会变真、名字永久被占、死掉的 child 被画成「可能在跑」） | 同上（`markUnreachable` 也做同一道闸） | 用例 4（retire 后失联读 ⇒ 仍 `retired`、`isAlive===false`） |
| F | **地址不丢**：`isAlive` = `live \|\| unreachable`；`retire` 无条件按记录上的 `terminalAddress()` 发 `terminal.kill`（先 kill 后 rm，D11 不变）；kill 无法投递时**不改 state**、不删记录 ⇒ run 行仍带 `host/remoteTerminal`，正是 #456 孤儿回收按地址回收所读的字段 | 同上 | 用例 5（本地名字）；`remote-child-fate.test.ts` 新用例（**远端** `vps/lgl-worker-0` 在失联后仍是 kill 的目标） |
| G | **确证死亡仍判死**：`not_found` ⇒ `state=finished` + `{settled:false, abnormal:true, reason:"terminal not found"}`；终端 `finished` ⇒ `{settled:true, exitCode}`。**行为未改**，只是不再被新分支绕开 | 同上 | 用例 6、7 |
| H | **不许原地重派**：`spawnChild` 的名字守卫从 `state === "live"` 扩到 `live \|\| unreachable`，拒绝语点名「terminal is still held … may still be running」 | 同上 | 用例 8（`NAME_TAKEN`，`terminal.run` 计数仍为 1） |
| I | **collect 不再说谎**：`SettleResult.unreachable`（新可选字段）→ `settleDisposition` 返回 `"unreachable"`（`CollectWait` 新成员）→ `classifyOutcome` **第 0 条**分支把 outcome 改写成 `{status:"running", reason: SUPERVISION_UNREACHABLE_REASON}`。`running` = watch 重挂 + `shouldRecycleAfterCollect` 拒绝 retire | `src/supervisor/types.ts`、`src/runs/orchestrator.ts` | 用例 12（喂进去的是**真后端**产出的 `SettleResult`：`status==="running"`、`reason` 相等、`reason !== COLLECT_DEADLINE_REASON`、`shouldRecycleAfterCollect("running")===false` 而 `("failed")===true`）；用例 13（真死仍是 `aborted` 终态） |
| J | **判 failed 必须收尸** | — | 见 §4：两条既有路径已覆盖，本次只补缺的那一半 |

### 2.1 为什么是「快告知 + 慢轮询」而不是「一直快」或「直接 failed」

- 一直快：`runtime.ts rearmLiveWatch` 对 `running` 快照**无延迟**重挂（注释写明「下一次 collect 会阻塞到 deadline，所以不是忙循环」）。
  若失联也 3s 就返回，watch 就变成 ~3s 一次的重试循环 —— 这才是 issue「不做」里那条「无界重试」。
  所以第一个 epoch 快（调用方必须知道通道断了），第二个 epoch 起按调用方预算慢跑。
- 直接 failed：就是本次事故本身。

## 3. 验收（机检）

`test/unit/supervision-unreachable.test.ts`（13 条，fake `HcClient`，不 spawn `hc`、不碰真机）
+ `test/unit/remote-child-fate.test.ts`（+1 条远端用例，复用既有 remote fake）。

| # | 验收 | 用例 | 断言要点 | 结果 |
|---|---|---|---|---|
| 1 | transport 错误 → `unreachable` 而非 `failed`；恢复后续跟；地址不丢 | 1 | `waitSettled` **不抛**、最终 `{settled:true}`；mid-poll 状态序列 `["live","live","unreachable","unreachable"]`（第 0/1 项在读之前取）；`strikes` 递增；detail 含 `hc connect exited (code 0)`；**每次**子 `terminal.get` 的 `terminal` 参数逐个等于 `terminal.run` 的名字；恢复后 `state==="live"`、`unreachable===undefined`；全程无 `terminal.kill` | ✅ |
| 1' | 地址面（跨机） | `remote-child-fate` 新增 | 远端 child 失联后 `stop` 仍打 `vps/lgl-worker-0`（host 前缀未丢）；`isAlive===true` | ✅ |
| 2 | 同场景 `stop` 仍发 `terminal.kill`（断言调用发生） | 5 | 先制造 `unreachable`（并断言此前**没有** kill）→ `retire()` → `terminal.kill` 恰好 1 次且 `terminal === address`，`rm` 在其后，终态 `retired` | ✅ |
| 3 | 对照组：`not_found` 仍判 failed/settled | 6、7、13 | `{settled:false, abnormal:true, reason:"terminal not found"}`、`unreachable===undefined`、`state==="finished"`、`isAlive===false`；`finished` ⇒ `{settled:true, exitCode:0}` 且不 kill；orchestrator 侧真死仍给终态 `aborted` + `shouldRecycleAfterCollect===true` | ✅ |
| 4 | 不回归 #441 / #445 / #456 | 全量 `npm test` | `stall-*`、`orphan-reclaim*`、`reattach*`、`cross-store-surface` 全绿；trunk 的 14 个环境失败逐条同名同数（§5） | ✅ |
| 5 | `typecheck` + `test` | — | `tsc --noEmit` 干净；`2983 tests / 2951 pass / 14 fail(=trunk)` | ✅ |

### 3.1 变异（逐一确认会红）

四个变异体都在 `/tmp` 备份后手改、跑完即复原（`grep -c MUTANT` = 0）。

**M1（验收 1 必红）— 把新分支改回「按 failed 结算」**：在 `waitSettled` 的 transport catch 里恢复
`throw this.failure("terminal.get", child.terminalName, error)`。

```
not ok 1  #460: a transport failure mid-poll is `unreachable`, not `failed` …
  error: "terminal.get failed for terminal 'lgl-root-centurion-0': transport: hc connect exited (code 0)"
  code: 'START_FAILED'
  stack: TerminalSupervisor.failure (…/terminal-supervisor.ts:2272)
         TerminalSupervisor.waitSettled (…/terminal-supervisor.ts:1374)
not ok 2,3,5,8,9,10,11,12
# tests 13 / pass 4 / fail 9        ← 4 条绿的正是两组 control（6,7 与 13）与复活闸（4）
```

变异体把**事故原话**（`terminal.get failed for terminal '…': hc connect exited (code 0)` +
`START_FAILED`）原样复现，而对照组保持绿 —— 红的正是被修的那条分支，不是环境。

| 变异 | 改法 | 结果 |
|---|---|---|
| M2 | 删掉 `settleDisposition` 的 `unreachable` 分支（落回旧分类） | `not ok 12`，其余 12 绿 |
| M3 | `const announced = false`（每次都快返，即恢复成 ~3s 重挂） | `not ok 3`，其余 12 绿 |
| M4 | 去掉 catch 里的 `finished`/`retired` 复活闸 | `not ok 4`，其余 12 绿 |

## 4. 「判 failed 必须收尸」现状

| 判 failed 的路径 | 收尸 | 结论 |
|---|---|---|
| launch 在 `terminal.run` 之后被 `confirmRemoteStartup` 拒绝（#423 req 6） | 已经 `terminal.kill` → `terminal.rm`，`kept` 时把原因写进回执 | 已有，本次不动（加注释指明，避免重复造 second kill） |
| `terminal.run` 本身失败（终端未创建） | 无尸可收（回滚 temp dir / worktree / mirror dir） | 已有 |
| `collect` 判 `failed` 且 child 还活着 | `shouldRecycleAfterCollect("failed")` ⇒ `retire` ⇒ kill | 已有（用例 12 顺手把它钉成谓词对照） |
| **监督读失败**（本次事故） | 旧行为：抛 `START_FAILED`，终端留在远端、无人再问 —— **正是孤儿** | 改成 `unreachable`：不判死、地址留在记录上，`stop` 能到、#456 的孤儿回收能按地址收 |
| `retire` 的 `terminal.kill` 投递失败 | 不设 `retired`、不删记录 ⇒ run 行保留 `host/remoteTerminal`，下一个进程的 orphan sweep 按地址回收 | 补注释与断言方向（不新增机制，复用 #456） |

**不做**：把 transport 失败重试到无限；改 `hc` 本身。两条都照 issue 的「不做」执行。

## 5. 全量门禁与既有失败

```
$ npm run typecheck        # tsc --noEmit，无输出 = 通过
$ npm test
# tests 2983
# pass 2951
# fail 14
```

14 个 fail 与 `origin/master` **逐条同名同数**（`git stash -u` 后在同一 checkout 跑 trunk 复现：
`2969 tests / 2937 pass / 14 fail`，编号仅因新增 14 条用例整体后移）：

```
v1.1 probe: a mise shim resolves to the REAL node …            (无 mise 环境)
v1.1 probe: a machine with no node/pi reports that …
v1.1 probe: repeated EXT rows survive parsing …
v1.1 probe failure: the error names the missing field …
xm-dispatch D4: the ASYNC resolver carries allowRoles …
xm-model-fallback: the ASYNC resolver carries hosts.<h>.model …
v1.1 resolver: an empty entry ({}) is filled from the probe …
v1.1 resolver: an explicitly EMPTY piExtensions wins …
v1.1 cache: one probe serves many launches …
v1.1 cache: a failed probe is never cached …
v1.1 cache: the disk cache survives a process …
provisionWorktree npm-install resolves a package-lock.json to npm ci   (无网络)
skill: npm pack --dry-run really lists SKILL.md                        (打包环境)
retire sweeps enumerated descendants with SIGTERM then SIGKILL         (进程组环境)
```

## 6. 对抗式 review 的处理

两路 fresh-context reviewer（正确性/回归、测试质量）各提 1 个 major + 若干 minor，逐条处置：

| reviewer 结论 | 处置 |
|---|---|
| **major**：`waitSettled` 内有上限，但真正重试的 watch 循环无上限（`rearmLiveWatch` 对 `running` 无延迟重挂 ⇒ ~3s 一次） | **修**：`epochs` + `UNREACHABLE_SLOW_POLL_MS` 升级策略（§2.1 / 用例 3），并用 M3 证明载荷 |
| minor：`markUnreachable` 无条件写状态，会把 `finished`/`retired` 记录复活成「活着」 | **修**：catch 与 `markUnreachable` 双闸 + 用例 4 + M4 |
| minor：`supervision()` 文档声称 `status`/`legion doctor` 在读，但 `src/` 无消费者 | **修文档**：改成如实说明（用户面是 `execution.reason` + `stop` 的 `isAlive`），不假装已接线 |
| minor：只有 `kind === "not_found"` 算死亡，永久性错误会一直报「可能在跑」 | **保留**（保守方向）+ 用例 11 明确写下这条 policy：错误词表有洞时宁可让死 child 暂活，也不让活 child 判死 |
| minor：失联没有时间升级 / 逃生口（名字永久被占） | **保留为已知限制**，写进 §7；issue 明确要「child 可能在跑」，靠猜去 kill 更糟 |
| minor：`supervision()` 的 `since` 断言同义反复 | **修**：用例 3 比较两个 epoch 的 `since` 相等 |
| minor：`unreachableStrikeLimit` 选项从未被使用，边界是拿常量比自己 | **修**：用例 9 传 `unreachableStrikeLimit: 1` |
| minor：`strikes` 的「连续」语义没测（成功读会归零） | **修**：用例 10 |
| major（测试）：`collect` 用例里「断言没有 retire」不可伪证（`collect` 从不 retire） | **修**：改成断言真载体 `shouldRecycleAfterCollect(...)`，并用 `("failed")===true` 做对照 |
| major（测试）：`collect` 用例喂的是手写 `SettleResult`，等于测 fake | **修**：改成喂**真后端**产出的那份 `SettleResult`（同一条用例内先跑 `TerminalSupervisor` 拿到它） |
| major（测试）：地址保持只在「编译期已保证」的地方断言，远端 `host` 面无观测 | **修**：`remote-child-fate.test.ts` 新增远端用例，断言失联后 kill 目标仍是 `vps/lgl-…` |

## 7. 未决 / 已知限制

1. **失联没有时间升级**：`isAlive` 为真 ⇒ 名字在整个 session 内被占；`retire` 又要求 kill 被投递。通道长期不可用时，
   操作者既不能 `stop` 也不能重建同名 child，只能等 `hc` 恢复。issue 认可「child 可能在跑」，所以本 PR 不做猜测性 kill；
   若后续要收口，正确方向是「N 分钟不可达 ⇒ 标 `orphaned` 交给 #456 的回收」，而不是判 failed。
2. **`/legion status` 会整句内联** `SUPERVISION_UNREACHABLE_REASON`（约 50 词）：`isAliveProgressSignalReason`
   只吞 `still alive|rpc child alive|transient connection` 三类。刻意没有把它加入白名单 —— 失联必须被看见。
   若觉得太长，正确做法是给 `status` 一个专门的 `unreachable` 行（需要共享 `LegionSupervisor` 面加可选方法），不是隐藏原因。
3. **`programState` 不对 `unreachable` 探测**：保持 #441 的「纯读、不折事实」约定 ⇒ 失联期间 stall 探测器拿到
   `undefined`（不告警），恢复由下一次 `collect`/`wait` 的读完成。
4. **`collectFailureInput`（`src/extension/notify.ts`）仍是「抛错即 failed」**：本 PR 把这条输入口
   （`waitSettled` 抛错）堵住了，但别的抛错路径仍可能从那里变成 `failed`。值得单独一颗 issue。
5. **`package-lock.json` 的 6.2.10 → 6.2.11 改动**来自开工前的 `npm install`，与本 issue 无关，**不纳入本次提交**。
