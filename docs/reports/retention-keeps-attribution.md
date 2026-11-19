# 14 天 retention 不再删掉唯一的跨机归属记录（6.2.5 / #408）

- Issue：`#408`（retention 整目录删 run dir，而那是本机唯一记得「远端那个目录/终端是谁的」的记录）。
- 基线：`origin/master` `75ca4cd`（= 6.2.4 + #407，PR #420 合入）。
- 分支：`pi-subagent/hw-nj/legion-408-7ab6e481`。
- 范围：只修本条。**#407 的谓词一行未动**（`markAbandoned` 的
  `AND (host IS NULL OR host = '')` 原样）；没有新列、没有迁移、没有改 `recover`/`status`。

---

## §1 现象（真实输出）

一个 idle 20 天、owner 已死的 run dir，`legion.db` 里有一条
`host=hw-nj`、`status=running` 的跨机行，带 `remote_dir` / `remote_terminal`。
跑**生产** `runStartupHygiene`（默认 `retentionDays=14`）：

修之前（= 把跳过条件删掉的变异版本，输出逐字如下）：

```
prunedRuns       = ["r-d8b8464b"]
keptRemoteRuns   = []
run dir on disk  = false
doctor holds     = []
sweep notice     = pi-legion storage sweep: pruned 1 idle run dir(s) (freed 0.1 MB)
```

修之后（同一份脚本、同一个死 owner、同一条 20 天旧行）：

```
prunedRuns       = []
keptRemoteRuns   = [{"run":"r-d6ede4d9","rows":["root.o624-a@hw-nj running remote_dir=/home/xm/.pi-subagents/runs/r-7ab6e481-xm remote_terminal=hw-nj/lgl-o624-a"]}]
run dir on disk  = true
doctor holds     = ["r-d6ede4d9"]
sweep notice     = pi-legion storage sweep: kept 1 run dir(s) holding an unsettled cross-machine row (freed 0.0 MB)
```

删掉之后的事实：远端 `/home/xm/.pi-subagents/runs/r-…-xm` 目录与
`hw-nj/lgl-o624-a` 终端都还在，但本机再没有任何东西能回答它们属于谁 ——
`remote_dir` / `remote_terminal` 是 schema v5 专门为此加的（`src/legion/db.ts:190-209`
的注释：它们**无法从任何别的东西推导**，新进程对上一个进程 spawn 的 child 没有任何句柄，
core 还可能改短过终端名）。

---

## §2 根因

`src/runs/hygiene.ts` 的 prune 只问了四个问题：够旧、owner 已死、没有 `worktrees/`、
有 `run.json`。**没有问「这份 ledger 里还有没有别处仍活着的账」**，于是
`fs.rmSync(runDir, { recursive: true })` 把一个仍然成立的归属事实当垃圾删了。

三条路径对「这条跨机行还没结束」的定义早就在代码里：

| 路径 | 位置 | 判定 |
|---|---|---|
| `/legion status` 遗留块 | `listUnsettledRemoteNodes`（`src/legion/nodes.ts:529`） | `host IS NOT NULL AND host <> ''` 且 status ∈ live 三态 |
| `recover` | `listRemoteNodesNamed` + `hasEnded` | 同上（#407 之后 sweep 不再把它改判 `failed`） |
| retention prune | `src/runs/hygiene.ts` | **没有谓词** |

#407 保住了「sweep 不提前改判」，但 14 天一到，整个目录连带那份证据一起没了 ——
同一个真相的最后一环。

---

## §3 改法：prune 之前读一次 ledger，命中就跳过

`src/runs/hygiene.ts`：

```ts
// #408: an idle run dir is NOT automatically garbage. …
const hold = readRemoteHold(runDir);
if (hold.rows.length > 0) {
    report.keptRemoteRuns.push(hold);          // 跳过 prune，继续走后面的 stale/WAL/events 步骤
} else if (hold.error !== undefined) {
    report.errors.push(`${runDir}: retention kept the dir (${hold.error})`);
} else {
    … fs.rmSync(runDir, { recursive: true, force: true }); …
}
```

- **谓词复用 `listUnsettledRemoteNodes`**（`readRemoteHold` 里调它），不另写一份 SQL：
  retention / `/legion status` / `recover` 从此不可能对「这行还算不算活」各说一套。
  #407 的 `markAbandoned` 与这个函数**都没有改动**。
- **只保护这一类行**：没有跨机行、或跨机行已结算（`settled`/`failed`/`retired`）的 idle
  run dir 照旧删 —— 不是「永不删除」，单测逐个钉住（§4）。
- **跳过 prune 不等于跳过这个目录**：代码没有 `continue`，所以同一轮里 `#38` 的
  stale 本地行收敛、WAL checkpoint、events retention 仍然作用在它身上。
- **ledger 打不开时不盲删**：保留目录并把错误写进 `report.errors`（下一轮重试）。
  这不是第二个豁免类别 —— 它只在「读都读不出来」时生效，且从不出现在
  `keptRemoteRuns`（那是对「有活账」的专用报告）。
- `HygieneReport` 新增 `keptRemoteRuns: RemoteHold[]`，`formatHygieneReport` 加一句
  `kept N run dir(s) holding an unsettled cross-machine row`，`.hygiene-last.json`
  加 `keptRemoteRuns` 计数（doctor 的 `last sweep:` 行同步打印）。

`legion doctor` 的 `## Storage / hygiene`（`src/extension/legion-doctor.ts`）新增一段，
并加一条 `RETENTION_HOLDS_REMOTE` info issue（`section: "storage"`）。真实渲染：

```
- last sweep: 2026-11-19T08:15:03.116Z (removedTemps=0, prunedRuns=1, keptRemoteRuns=1, deletedEvents=0, freed=0 B, errors=0)
- runs: 1; legion.db total ≈ 76.0 KiB; largest r-7ab6e481 (76.0 KiB)
- kept by retention: 1 run dir(s) hold an unsettled cross-machine row (prune skips them)
    r-7ab6e481/root.o624-a o624-a@hw-nj running
      remote_dir=/home/xm/.pi-subagents/runs/r-7ab6e481-xm remote_terminal=hw-nj/lgl-o624-a
      inspect: hc terminal ls --on hw-nj
...
- [info] RETENTION_HOLDS_REMOTE @storage: Retention keeps 1 run dir(s) that still hold 1 unsettled cross-machine row(s) — this machine's only record of those remote dirs/terminals (hw-nj).
    fix: Check the far side with hc terminal ls --on hw-nj, then settle the row (subagent recover) or remove the run dir by hand.
```

- 报告是**现场扫**的（`findRemoteHolds(storeRoot)`），不依赖 `.hygiene-last.json`
  是否被写过：新会话第一次跑 doctor 就能看见。
- 只在 storage 段被选中时才扫（`want(selected, "storage")`）：`/legion doctor models`
  不会为此打开每个 run 的 ledger。
- 每个 host 都给出 `hc terminal ls --on <host>` 查法；最多展开 5 个 run dir，其余
  `… N more run dir(s)` 汇总。

### 边界（明确没做什么）

- **没有改成「永不删除」**：仅 unsettled 跨机行命中才跳过；已结算的行、无跨机行的
  空闲 run dir 仍被删（`#37` 语义不变，两条单测分别钉住）。
- **没动 #407 谓词**：`markAbandoned` 的 `AND (host IS NULL OR host = '')` 与
  `listUnsettledRemoteNodes` 的 SQL 都逐字未改。
- **没有自动回收远端**：不 fetch、不 kill、不 settle；只保证事实还在，动作仍由人/`recover` 决定。
- **没有新列 / 迁移**：只读 v5 已有的两个字段。
- **没有宽限期特例**：跳过是按行算的，不是把 retention 天数调大。

---

## §4 测试

### 新增单测（门禁内）

`test/unit/hygiene.test.ts`：

1. `#408 retention keeps a run dir whose ledger still owns an unsettled cross-machine row`
   - 三个 run 同处一轮 sweep：A（`host=hw-nj` 且 `running` + `remote_dir`/`remote_terminal`）、
     B（同形状但该行 `settled`）、C（从来没有跨机行）；
   - 断言 `prunedRuns` 恰好是 `[B, C]`、A 的目录**还在**；
   - 断言 `keptRemoteRuns` 只有 A，且带出 `host` / `status` / `remote_dir` / `remote_terminal`；
   - 断言 `formatHygieneReport` 有 `kept 1 run dir(s) holding an unsettled cross-machine row`；
   - 顺手断言 #407 的不变量仍在：`listUnsettledRemoteNodes` 仍列出这条行。
2. `#408 the hold is scoped to unsettled rows: a cross-machine row that ENDED blocks nothing`
   - `host=hw-nj` 但 `status=failed` 的空闲 run → 照旧删，`keptRemoteRuns == []`。

`test/unit/legion-doctor.test.ts`：

3. `#408 doctor names the run dirs retention keeps and how to inspect the far side`
   - 造一个真 run dir（`root` + `host=hw-nj` 的 `worker`，带 `remote_dir`/`remote_terminal`），
     跑 `runLegionDoctor({sections:["storage"]})`；
   - 断言 `- kept by retention: 1 run dir(s) …`、`remote_dir=… remote_terminal=…`、
     `inspect: hc terminal ls --on hw-nj`、`[info] RETENTION_HOLDS_REMOTE @storage:` 与 fix 行。

### 变异：删掉跳过条件 → 单测红

把 `if (hold.rows.length > 0) { report.keptRemoteRuns.push(hold); }` 整个删掉（其它不变）：

```
✖ #408 retention keeps a run dir whose ledger still owns an unsettled cross-machine row
  AssertionError [ERR_ASSERTION]: only the runs with nothing remote to lose are pruned
  + actual - expected
    [
      '/tmp/hyg-j2wGJm/runs/r-13937d39',
  +   '/tmp/hyg-j2wGJm/runs/r-7634b8c7',
      '/tmp/hyg-j2wGJm/runs/r-ff15474d'
    ]
ℹ tests 10
ℹ pass 9
ℹ fail 1
```

（第二条 `#408 … a cross-machine row that ENDED blocks nothing` 在变异下仍绿：它断言的是
「该删的照旧删」，这正是本 issue 要求的另一半。）恢复后两个文件 `45/45` 全绿。
变异下的生产输出见 §1 左栏（`prunedRuns=["r-d8b8464b"]`、目录已消失）。

### 用到的命令

```
node --experimental-strip-types --test test/unit/hygiene.test.ts test/unit/legion-doctor.test.ts
flock /tmp/pi-legion-ci.lock -c "npm run typecheck && npm test"
npm run test:integration
```

---

## §5 门禁

```
$ flock /tmp/pi-legion-ci.lock -c "npm run typecheck && npm test"
...
ℹ tests 2697
ℹ pass 2697
ℹ fail 0
ℹ duration_ms 60843.888761
GATE_EXIT=0
```

（日志 `/tmp/legion-408-gate.log`。）基线同一份代码在 `origin/master` `75ca4cd` 上跑同一命令：

```
$ git worktree add --detach /tmp/legion-408-base origin/master && (cd $_ && npm test)
ℹ tests 2694
ℹ pass 2694
ℹ fail 0
BASE_EXIT=0
```

2697 = 2694 + 本次新增 3 条（两条 hygiene、一条 doctor）。没有上调/放宽任何基线，
`test/perf`、门禁脚本、`tsconfig.json` 均未动；临时 worktree 已 `git worktree remove`。

```
$ npm run test:integration
ℹ tests 192
ℹ pass 192
ℹ fail 0
INT_EXIT=0
```

（日志 `/tmp/legion-408-integration.log`。）

---

## §6 交付

- `src/runs/hygiene.ts`：`readRemoteHold` / `findRemoteHolds` / `RemoteHold(Row)`；
  prune 前的跳过 + 报告；`keptRemoteRuns` 进 `HygieneReport`、sweep notice、`.hygiene-last.json`。
- `src/extension/legion-doctor.ts`：storage 段的 `kept by retention:` 明细（`remote_dir` /
  `remote_terminal` / `hc terminal ls --on <host>`）、`RETENTION_HOLDS_REMOTE` issue、
  `last sweep` 的 `keptRemoteRuns=`。
- `test/unit/hygiene.test.ts`、`test/unit/legion-doctor.test.ts`：3 条新单测（含变异红）。
- `docs/design.md` §7.4、`CHANGELOG.md`（6.2.5 Unreleased）各一条。
- 本报告。

## §7 权衡 / 遗留

- 被保住的 run dir 会一直留到那条跨机行被结算（`recover`）为止 —— 这是有意的：证据与
  未结的账同寿。行极少（一个遗留一行），且 doctor 每次启动都把它摆出来，不会变成静默垃圾。
- 手动清理路径已写进 doctor 的 fix 行（`hc terminal ls --on <host>` → `subagent recover`
  → 仍要删就手删 run dir）；没有加自动回收，避免 retention 去动远端。
- 只在 run dir 层面保护；`events` 裁剪（`eventRetentionDays` / `eventMaxRows`）只删
  terminal 节点的旧事件，不碰 live 跨机行的事件，本次不动。
- #409（anchor / where 归属）、#410、#411 不在本次范围。
