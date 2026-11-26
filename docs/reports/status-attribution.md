# status 的归属行 + 时间事实（6.2.5, D1 / D4 / D5-rendering）

- 基线：`origin/master` `a330da9`（= 6.2.4），分支 `pi-subagent/hw-nj/legion-status-host-82dd3fe7`。
- 范围（用户明确冻结）：**只做这三项**。其余已拆成 issue：
  #407（72h sweep 把跨机遗留从 status 里抹掉）、#408（14 天 retention 删掉归属证据）、
  #409（跨机终端 anchor / where 归属）、#410（全新 checkout 上 spawn cwd 不存在被误报成程序不存在）、
  #411（跨机 transcript 实时镜像）。
- 本轮**未**改 `src/runs/hygiene.ts`、`src/extension/legion-doctor.ts`、
  `src/supervisor/terminal-supervisor.ts`、`src/runs/orchestrator.ts`、`src/legion/*`
  （见 §6「还原了哪些文件」）。

---

## §1 现象（真实输出，修之前）

`/legion status` 的遗留块（本分支 base `a330da9` 渲染，fixture 与 §2 同一份）：

```
Recoverable cross-machine children (this session never launched them):
- psid-rev-a · centurion · host hw-nj · running · terminal hw-nj/t5g · 2m old
  collect: subagent({ action: "recover", name: "psid-rev-a" })
```

两处坏：

1. **`2m old` 是假的。** 这一行搁置了 7 天（launch = `2026-01-01`，now = `2026-01-08`），
   但 age 取的是 `node.updatedAt`；hygiene 的 `markAbandoned` 每次 sweep 都把它改写成
   「刚才」。读者据此判断「它刚动过，再等等」——而它其实已经一周没人碰了。
2. **没有任何归属。** 打印了 6 个字段、0 个「这是谁的遗留」：没有 `node.id`（同名两棵子树
   时无法定位）、没有 run、没有 cwd、没有 owning session、没有 owner pid。
   `cwd` / `sessionFile` **本来就在 run.json 里**，只是 `runsNewestFirst` 没带出来。

`subagent status` 的 live 跨机块（D5，同一份真机输出）：

```
psid-rev-a — state=working agent=centurion kind=pi
alive · quiet 176s (living)
supervisor=terminal
session=/Users/…/.pi-subagents/runs/r-1bb33dde/psid-rev-a.jsonl
```

它跑在 `hw-nj/t5g`，但块里没有 `host` / `terminal`，和本地 child 一字不差 —— 所以
在 Herdr UI 里找不到它，也没有任何一行告诉人「去 `hc read` 看」。

---

## §2 改法

### D1：age 取 `createdAt`，`updatedAt` 降级成心跳

`src/runs/remote-recover.ts`：

- `recoverCrossMachineChild` 的 `ageMs` 改为 `now - node.createdAt`（launch 时刻，不可变）。
- 归属块里 `launched <ISO> (<age>)` 用 `createdAt`；`heartbeat <ISO> (<age>)` 用 `updatedAt`。
- **为什么这能根治**：`created_at` 没有任何代码路径会改写（`markAbandoned` 只动
  `status` + `updated_at`），所以 age 从此不再依赖 sweep 的行为。`updatedAt` 仍然是
  一条好事实，只是它的正确名字是「最后心跳」。

### D4：一套归属行，三处共用

`src/runs/remote-recover.ts` 新增**唯一**渲染器 `renderRemoteOwnershipBlock(facts)`，
输出（行首两空格为续行）：

```
- <name> · <node.id> · host <h> · <orphaned|unfetched|running|abandoned> · terminal <h>/<addr>
  launched <ISO> (<human age>)  · run <runId> · cwd <cwd> · session <basename of sessionFile>
  owner pid <pid> (<alive|gone since <ISO>>)
  heartbeat <ISO> (<human age>)
  collect: subagent({ action: "recover", name: "<name>" })
```

- 数据：`node.createdAt/updatedAt/status/remoteTerminal`（ledger，v5 已有）；
  `runId`/`cwd`/`sessionFile`（run.json，**已经存在**，`runsNewestFirst` 现在带上）；
  `ownerPid`/`ownerAlive`（run dir 的 `owner.json` + `isPidAlive`）。
  **零迁移、零新字段。**
- `gone since <ISO>` 取**最后心跳**（`updatedAt`）：它是「此人最后一次被证明还活着」的
  时刻，是一个有证据的**下界**，不是测量出的死亡时间（报告里明说，避免再编一个事实）。
- 三个消费点：`renderRecoverableSection`（`/legion status`）、`recoveryHeadline`
  （`recover` 首行，块在句前）、`unknownRecoveryMessage`（`recover` miss，把「能用的名字」
  升级成同样的块）。`state` 词由 `recoveryStateWord()` 统一：fate 优先
  （`orphaned` / `unfetched`），否则 node status。
- 顺带：`orphan-on-shutdown.test.ts` 里三处断言从旧格式（`· worker ·` / `· running (unfetched) ·`）
  更新到冻结的新格式（`· root.worker-0 ·` / `· unfetched ·`）。这是**格式变更**，不是放宽。

### D5（只做渲染）：live child 一定说清在哪台机器、怎么找

- `renderLiveChildStatus`（`src/extension/runtime.ts`）：`alive` 的 child **总是**打印
  `host=` / `terminal=`，缺值写 `host=local` / `terminal=-`；跨机行再加
  `see: hc read <machine>/<terminal>   (cross-machine children have no Herdr pane)`。
  死掉的记录保持 6.2.4 的形状（跨机两行、本地零行），一行不改。
- 数据源（`childRemoteFacts()`，`src/extension/legion-status.ts`）：run store 的
  `child.host`/`child.remoteTerminal` 优先，缺失时读 ledger 的
  `nodes.host`/`nodes.remote_terminal`（schema v5，6.2.2 起就有）。`/legion status`
  的 named 路径、node-only 兜底、job-only 兜底、以及 `childStatus` 全部走这一个函数，
  于是两条命令不会各说一套。
- **D5 数据落盘结论见 §5。**

---

## §3 before / after（真实渲染，同一 fixture）

fixture：`root.psid-rev-a`，`host=hw-nj`，`remoteTerminal=hw-nj/t5g`，
`createdAt=2026-01-01T00:00:00Z`，`updatedAt=2026-01-07T23:58:00Z`，`now=2026-01-08T00:00:00Z`，
run `r-1bb33dde`，cwd `/Users/…/code/pi-legion`，owner pid 4242（已死）。

**before**（`git checkout --` 回 `a330da9` 的 `legion-status.ts` + `remote-recover.ts` 后渲染）：

```
Recoverable cross-machine children (this session never launched them):
- psid-rev-a · centurion · host hw-nj · running · terminal hw-nj/t5g · 2m old
  collect: subagent({ action: "recover", name: "psid-rev-a" })
```

**after**（本分支）：

```
Recoverable cross-machine children (this session never launched them):
- psid-rev-a · root.psid-rev-a · host hw-nj · running · terminal hw-nj/t5g
  launched 2026-01-01T00:00:00.000Z (168h00m old)  · run r-1bb33dde · cwd /Users/…/code/pi-legion · session 2026-01-01T00-00-00_abc.jsonl
  owner pid 4242 (gone since 2026-01-07T23:58:00.000Z)
  heartbeat 2026-01-07T23:58:00.000Z (2m old)
  collect: subagent({ action: "recover", name: "psid-rev-a" })
```

`168h00m old` vs `2m old` 就是 D1 的全部：同一个 `updatedAt` 现在叫心跳，age 回到 launch。

D5 的 before/after（live 块，`renderLiveChildStatus` 的真实输出；before 是 6.2.4 的形状）：

before（6.2.4，同一份 facts —— 没有 host/terminal，和本地一字不差）：

```
psid-rev-a — state=working agent=centurion kind=pi
alive · quiet 176s (living)
supervisor=terminal
session=/Users/…/.pi/subagents/runs/r-1bb33dde/psid-rev-a.jsonl
```

after（本分支，跨机 → 双行 + `see:`）：

```
psid-rev-a — state=working agent=centurion kind=pi
alive · quiet unknown
host=hw-nj
terminal=hw-nj/t5g
see: hc read hw-nj/t5g   (cross-machine children have no Herdr pane)
supervisor=terminal
session=/Users/…/.pi/subagents/runs/r-1bb33dde/psid-rev-a.jsonl
```

after（本地 → 显式 fallback，不沉默、不长 `see:`）：

```
psid-rev-a — state=working agent=centurion kind=pi
alive · quiet unknown
host=local
terminal=-
supervisor=terminal
session=/Users/…/.pi/subagents/runs/r-1bb33dde/psid-rev-a.jsonl
```

---

## §4 单测与变异

新文件 `test/unit/status-attribution.test.ts`（5 条）、`test/unit/status-host-terminal.test.ts`（8 条）。

变异证据（每条都是「删掉修复 → 红，恢复 → 绿」）：

| 变异 | 结果 |
|---|---|
| `renderRemoteOwnershipBlock` 的 `launched` 改用 `heartbeatAt`（= 回到 D1 的旧行为） | ✖ `D1: the age comes from createdAt; updatedAt is the heartbeat`（及 3 条 D4 断言） |
| 从归属行删掉 `· cwd … · session …` | ✖ `D4: the block names the node, run, cwd, session and owner` + `/legion status` 与 `recover` 两条 |
| 从 live 块删掉 `host=` / `terminal=` / `see:`（D5） | ✖ `D5: a live cross-machine child prints host, terminal and how to look at it`、`local child`、`ledger fallback` 等 5 条（7 条里红 5） |

绿色（恢复后）：

```
ℹ tests 5 / pass 5 / fail 0     (status-attribution)
ℹ tests 8 / pass 8 / fail 0     (status-host-terminal)
```

---

## §5 D5 数据落盘：根因结论

任务里给的证据是「`r-1bb33dde/run.json` 的 `children` 是空数组，而
`psid-rev-a.jsonl` 是 0 字节」。结论分两半：

1. **0 字节是设计，不是缺陷。** `<runDir>/<name>.jsonl` 对跨机 child 是**本地占位文件**：
   它的转录在 `remoteDir/session.jsonl`（另一台机器），本机这份永远为空，只在 collect 时把
   `remote/<name>.jsonl` 镜像写出来。把 0 字节当根因会修错地方（真正的可见性问题是
   #411「实时镜像泵」）。
2. **落盘链路本身是通的，已用测试钉住。** `Orchestrator.recordChild` 把
   `host` / `remoteDir` / `remoteTerminal` 写进 child 记录（`cross-machine-orchestrator.test.ts`
   的 `handle.child.host`、`remote-child-fate.test.ts` 的 `handle.remoteTerminal` 已经钉着），
   `persistChild` 再整条写进 run.json；本轮新增
   `D5 root cause: the fields ARE persisted …` 钉住 store 的 round-trip（`host` /
   `remoteDir` / `remoteTerminal` 逐字回读）。
3. **所以「children: []」不是渲染能解释的，也无法在本 worktree 复核**：那份 run.json 在
   报告者的机器上（本 worktree 只有它的分支）。最可能的解释是读到的是**另一个 run 的
   run.json**（被派发的 centurion 自己的子树 run 在它自己的 store 里；它的**记录**在父 run
   的 run.json 里）——但这只是假设，不作为结论。
4. **无论上述哪种，本轮修复都不依赖它**：`childRemoteFacts()` 在 run.json 缺字段时读
   ledger 行（`nodes.host` / `nodes.remote_terminal`），而 status 输出证明那次调用至少
   拿到了记录（`supervisor=terminal`、`session=` 都来自记录）。落盘本身的加固（若真缺）
   按用户要求**不在本轮修**，另开 issue。

---

## §6 门禁与范围

- `make ci` / `check-annotations` **在本仓库不存在**（`Makefile` 在 `origin/master` 与所有远端
  分支上都不存在，`grep -r check-annotations` 零命中）。所以跑的是 CI workflow
  （`.github/workflows/ci.yml`）自己的四步：
  `node --run typecheck`、`node --run test`、`node --run test:integration`、
  `node --run test:mock-llm`。数字见 §6.1。
- **还原了哪些文件**（冻结范围，D2/D3 补丁被 `git checkout --` 丢掉）：
  - `src/runs/hygiene.ts`（D2/D3 的 sweep/prune 改动，未保留）
  - `src/extension/legion-doctor.ts`（D3 的 doctor 报告，未保留）
  - `src/supervisor/terminal-supervisor.ts` + `test/unit/terminal-supervisor.test.ts`
    （D7 的 cwd 修复，含已提交的 `46f2555`，已 `git reset` + `checkout` 还原 → #410）
  - 未创建 `test/unit/hygiene-cross-machine.test.ts`（D2/D3 测试，已删除）
- 保留的只有 D1/D4 与 D5-rendering 的 diff：
  `index.ts`、`src/extension/legion-status.ts`、`src/extension/runtime.ts`、
  `src/runs/remote-recover.ts`、`test/unit/runtime.test.ts`（D5 带来的行号断言改成顺序断言）、
  `test/unit/orphan-on-shutdown.test.ts`（D4 冻结格式）、两个新测试文件、CHANGELOG、本报告。

### §6.1 门禁数字

| 步骤 | 结果 |
|---|---|
| `node --run typecheck` | exit 0 |
| `node --run test` | **2693 tests / 2693 pass / 0 fail** |
| `node --run test:integration` | **191 tests / 191 pass / 0 fail** |
| `node --run test:mock-llm` | **25 tests / 25 pass / 0 fail** |

四步都在最终工作树上跑过（最后一次改动之后）。没有上调基线、没有跳过、没有放宽既有断言；
两处既有断言被**格式变更**要求改写（`orphan-on-shutdown.test.ts` 的遗留行、`runtime.test.ts` 的
行号断言 → 顺序断言），已在本报告 §2 说明理由。
