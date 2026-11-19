# 跨机遗留不再被 72h sweep 改判（6.2.5 / #407）

- Issue：`#407`（72h sweep 把跨机遗留从 `/legion status` 里抹掉，`recover` 却还能收）。
- 基线：`origin/master` `b720fdf`（= 6.2.4 + #406）。issue 正文引用的 6.2.4 `0ed298d` 与本
  基线之间，`src/runs/hygiene.ts` / `src/legion/nodes.ts` **零改动**（`git diff 0ed298d..b720fdf
  -- src/runs/hygiene.ts src/legion/nodes.ts` 为空），所以现象在两条基线上逐字相同。
- 分支：`pi-subagent/hw-nj/legion-407-12f9f691`。
- 范围：只修本条。**未**动 retention 语义（14 天删 run dir、events retention 都原样，属 #408）。

---

## §1 现象（真实输出）

复现脚本：临时 run dir（owner pid 为死进程）+ 一条 `host=hw-nj`、`updated_at = now - 96h`
的 `running` 行，然后跑**生产** `runStartupHygiene`，再按新会话的方式渲染
`renderLegionStatus({ nodes: [], recoverable: listUnsettledRemoteNodes(db) })`。

修之前（= 把修复撤掉的变异版本，输出逐字如下）：

```
sweep.abandonedNodes = ["r-56b476e6/root.worker-0"]
node status           = failed
status block rows     = []
status block present  = false
--- /legion status ---
Legion status · 0 nodes

No legion nodes.

One node: /legion status <name>
```

**`/legion status` 说「没有遗留」，而同一行 `recover` 仍能收**（`recoverCrossMachineChild`
用 `readback` seam 跑生产路径；§3 有输出）。这就是 issue 说的状态分裂：
 说没有了、`recover` 说还能收。

修之后（同一份脚本、同一个死 owner、同一条 96h 旧行）：

```
sweep.abandonedNodes = []
node status           = running
status block rows     = ["worker-0"]
status block present  = true
--- /legion status ---
Legion status · 0 nodes

No legion nodes.

Recoverable cross-machine children (this session never launched them):
- worker-0 · root.worker-0 · host hw-nj · running · terminal hw-nj/t1
  launched 2026-11-15T07:57:48.668Z (96h00m old)  · run (run not recorded) · cwd (cwd not recorded) · session (session not recorded)
  owner pid (not recorded)
  heartbeat 2026-11-15T07:57:48.668Z (96h00m old)
  collect: subagent({ action: "recover", name: "worker-0" })
```

（"run/cwd/session 未记录" 是复现脚本没写 run.json 的产物；生产路径由
`listRecoverableLeftovers` 从 run.json/owner.json 补齐，见 `docs/reports/status-attribution.md`
的 D4。年龄 96h 是真实的：`launched` 用不可变的 `createdAt`。）

---

## §2 根因

三条路径对「遗留」的定义不一致，而 sweep 拿**本机**的死亡去判**远端**的工作：

| 路径 | 位置 | 判定 |
|---|---|---|
| 72h sweep | `src/runs/hygiene.ts` `markAbandoned` | dead-owner run dir 里 `starting/running/blocked` 且 `updated_at < now-72h` → `failed` + `node_abandoned` |
| `status` 遗留块 | `src/legion/nodes.ts` `listUnsettledRemoteNodes` → `renderRecoverableSection` | `host <> ''` **且** status ∈ live 三态 |
| `recover` | `src/legion/nodes.ts` `listRemoteNodesNamed` | `host <> ''`，**不看 status** |

owner 在本机死掉，并不等于远端那个进程结束了。这一行是 `recover` 唯一还能收的证据；
把它改成 `failed`，等于对一个本机根本看不见的进程下判决，并顺手把它从 status 里删掉。
这还和代码自己写下的不变量冲突：`src/legion/orphan.ts` 与 `listUnsettledRemoteNodes`
的注释都写明「`orphaned`/`unfetched` 故意不终态，让 status 块和 recover 都看得见」。
72h sweep 是唯一一处违反它的地方。

---

## §3 改法：选「不被改判」（两种里更小的那个）

`src/runs/hygiene.ts` 的 `markAbandoned` 加一个谓词（与 `listUnsettledRemoteNodes`
逐字相同的跨机标记）：

```sql
... AND updated_at < ? AND (host IS NULL OR host = '')
```

外加两处注释（`markAbandoned` 函数体 + `listUnsettledRemoteNodes` 的 docstring）说明为什么
跨机行必须保持 open。**没有新字段、没有迁移、没有改渲染。**

### 为什么不选「列成 `abandoned-but-recoverable` 徽标」

那是把 sweep 的错判当作事实、再让显示层去补偿，代价明显更大：

1. `listUnsettledRemoteNodes` 必须接纳 `failed` 行 —— 但它现在的 SQL 集合是与
   `hasEnded` 对齐的三态（注释明说「不能 drift」），要接纳就得按「最新 settle 事件是
   `node_abandoned` 且不带 execution」再查一遍 events 表，等于在 status 查询里长出一套
   新语义；
2. `recoverCrossMachineChild` 的 `settledAlready` 分支要为这种行再开一条「虽 failed 但仍
   fetch」的路径（现有 `node_abandoned` 无 execution 恰好能走，但语义会被 status 块重新
   定义），幂等判定 (`already-settled`) 的边界随之变宽；
3. 还要在 `legion-status.ts` / `recoveryStateWord` 增加第四个状态词，并给它补测试。

「不改判」只要一个谓词，并且把三条路径**重新变回同一个定义**（open = 可收 = 可见），
不需要任何显示层补偿。issue 明确允许二选一，取小的。

### 边界（明确没做什么）

- 本地 stale 行照旧被 sweep：单测同时断言 `root.stale` 仍变 `failed`，豁免的依据是
  `host` 标记，不是「sweep 不干了」。
- retention 未动：`retentionDays`（默认 14 天）仍会整目录删掉 idle 的 run dir —— 这是
  #408 的领域；本次只保证「在这份 ledger 还存在的期间，72h 不会提前把它藏起来」。
- `scanOrphans`（live 会话内的 D7 收敛）未动：它作用于**本会话自己的** ledger，且既有测试
  （`recover-cross-machine.test.ts` 的「hygiene converged an orphaned row to `failed` — the
  result is STILL fetched」）已锁定那条路径的行为，仍全绿。
- `recover` 的 wire/幂等语义未动。

---

## §4 测试

### 新增单测（门禁内）

`test/unit/hygiene.test.ts` — `#407 the 72h sweep never re-judges a cross-machine row, so it
stays in the status block and stays recoverable`：

- dead-owner run dir 里同时放 `root.stale`（本地）与 `root.remote`（`host=hw-nj`），都 5 天没心跳；
- 断言 `report.abandonedNodes == [<run>/root.stale]`（本地照旧被扫）；
- 断言 `root.remote` 仍 `running`、**没有** `node_abandoned` 事件；
- 断言 `listUnsettledRemoteNodes`（status 块的数据源）含它、`hasEnded(remote) === false`、
  `listRemoteNodesNamed`（recover 的数据源）含它 —— 可见性与 recover 前置条件同时成立。

### 新增集成测试（真实 ledger + fake `hc` core）

`test/integration/recover-cross-machine.test.ts` — `#407 a 4-day-old cross-machine leftover
survives the sweep: it stays in `/legion status` and `recover` still collects it`：

- 用 `RunStore.createRun` 造真 run dir，写死 owner pid，`legion.db` 里两条行都 4 天旧；
- 跑真实 `runStartupHygiene`，断言 `abandonedNodes == []`、行仍 `running`；
- 按 `/legion status` 的调用方式渲染，断言遗留块存在、行是 `· host fakebox · running ·`、
  带 `collect:` 行；
- 同一连接上调 `recoverAction`，断言 `execution: success`、孩子的原文回来、行被 settle。
  （`/legion status` 广告的那一行，`recover` 真的收得掉。）

### 变异：撤掉修复 → 断言红

删掉 `AND (host IS NULL OR host = '')`（其它不变）后：

```
# unit
✖ #407 the 72h sweep never re-judges a cross-machine row, so it stays in the status block and stays recoverable
  AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:
  + actual - expected
    actual: [ 'r-4a601bfc/root.stale', 'r-4a601bfc/root.remote' ]
    expected: [ 'r-4a601bfc/root.stale' ]

# integration
✖ #407 a 4-day-old cross-machine leftover survives the sweep: ...
  AssertionError [ERR_ASSERTION]: the only child here runs on another machine; there is no dead LOCAL owner to converge
ℹ tests 12 | pass 11 | fail 1
```

恢复修复后两个文件全绿（`8/8`、`12/12`）。

### 变异下的 recover 证据（同一枚硬币的另一面）

用 `readback` seam 直接调生产 `recoverCrossMachineChild`（4 天旧、dead owner）：

```
=== 修之前（变异） ===
status before recover = failed
leftover rows before  = []                 ← status 说没有
recover ok            = true | kind = settled-now | execution = "success"   ← recover 说能收

=== 修之后 ===
status before recover = running
leftover rows before  = ["worker-0"]       ← 一致
recover ok            = true | kind = settled-now | execution = "success"
```

### 用到的命令

```
node --experimental-strip-types --test test/unit/hygiene.test.ts
node --experimental-strip-types --test test/integration/recover-cross-machine.test.ts
flock /tmp/pi-legion-ci.lock -c "npm run typecheck && npm test"
```

---

## §5 门禁

本仓库无 `make ci`，按 issue 约定用共享锁跑 typecheck + 单测（完整输出留在
`/tmp/legion-407-gate.log`）：

```
$ flock /tmp/pi-legion-ci.lock -c "npm run typecheck && npm test"
...
ℹ tests 2694
ℹ pass 2694
ℹ fail 0
ℹ duration_ms 44334.296536
EXIT=0
```

另外跑了一遍集成套件（不在门禁里，但本次测试有一条落在其中）：

```
$ npm run test:integration
ℹ tests 192
ℹ pass 192
ℹ fail 0
EXIT=0
```

---

## §6 交付

- `src/runs/hygiene.ts`：修复（1 个 SQL 谓词 + 注释）。
- `src/legion/nodes.ts`：仅 docstring（说明 sweep 为何保持这些行 open），无行为改动。
- `test/unit/hygiene.test.ts`、`test/integration/recover-cross-machine.test.ts`：两条路径的测试。
- `CHANGELOG.md`：6.2.5 Unreleased 一条。
- 本报告。

## §7 权衡 / 留给 #408

- 未恢复的跨机行会一直 `running`，直到被 `recover` 收掉、或整个 run dir 被 14 天
  retention 删掉。可见性与 ledger 同寿，这和「遗留」的语义一致；`launched` / `heartbeat`
  两行仍如实显示它是 96h 前的东西，不会装成刚动过。
- 这类行永远不是「terminal」，所以 events retention（只删 terminal 节点的旧事件）不会回收
  它的事件。行数极少（一个遗留一行），且删事件属于 #408 的 retention 议题，本次不动。
- 不改 `markAbandoned` 的 `updated_at = now` 写入本身：本地行的时间事实由 D1（age 取
  `createdAt`）负责，已在 6.2.5 修好。
