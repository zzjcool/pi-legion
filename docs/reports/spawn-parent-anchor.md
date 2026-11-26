# #409 跨机终端必须有归属：spawn 请求带 parent（target-local），拿不到就明说

- 仓库 / 分支：`pi-legion` `pi-subagent/hw-nj/legion-409-47fa6b47`，基线 `origin/master bfedf68`
- 性质：**bugfix**（patch，6.2.6 候选），无破坏性接口变更；`run.json` 只增字段
- 范围：spawn 请求的 `parent` + `run.json` 追溯字段 + status/receipt 渲染 + 测试
- 未触碰：`src/runs/launch-evidence.ts`（#423 判据）、镜像泵 `src/runs/live-*`（#411/PR #429）、
  `stall-notice.ts`（去重）、`src/hc/client.ts`（协议层不需要改）

## 1｜现象与根因

跨机 child 在 `hc` 侧是孤根：`hc get` 里 `parent: null`，`hc ls --all` 里连 `where` 都没有，
Herdr app 无法把它放进任何 pane/tab，也无法回答「这个终端/目录是谁的」（与 #411/#414 同族）。

根因不是显示层，而是 **wire 形状**：`TerminalSupervisor` 构造的 `terminal.run` 参数里从来没有
`parent`。本地 launch 靠 `caller` 让 core 走默认父推导（`caller` 在同一个 core 命名空间里有效），
跨机 launch 按契约约束 5 **刻意不发 `caller`**，于是父归属一路为空。

### 1.1 实测：`parent` 只有一种写法能过（hc 0.1.21）

用真实 core 的 `hc connect` 逐条打（`loopback409` = 本机另一 core 的机器，见 §5）：

| 请求 | 目标 core 的回答 |
|---|---|
| `parent: "t5f"`（目标 core 里存在的终端） | ✅ 记成 `parent: "t5f"` |
| `parent: "t1t"`（调用方 core 的 id） | ❌ `not_found: no terminal "t1t"` |
| `parent: "hw-nj/t5j"`（机器名限定） | ❌ `machine_unknown: unknown machine "hw-nj"` |
| `parent: "<core-id>/t77"`（core id 限定） | ❌ `machine_unknown: unknown machine "<core-id>"` |
| `caller: "t77"`（默认父推导） | ✅ 目标记录里 `parent: "<发起方 core-id>/t77"` |
| `caller: "tNOPE"` | ✅ 通过，但 `parent: null`（解析不出来就不编） |

两条结论决定了实现：

1. **限定形式由「发送方 core」解析**：机器名/core id 不是本 core 注册过的机器 → `machine_unknown`。
   所以跨机 child 的 `parent` 只能是**目标 core 命名空间里的本地地址**（issue 里 `--parent t5j` 的形态）。
2. **`caller` 是默认父路径**：接收方记录里是 `<发起方 core-id>/<终端 id>`，全局唯一，
   不会被目标机同名终端顶替（名字不可能是 `t7` 这种 id 形状：`bad name "t77"` 已被 core 拒绝）。

## 2｜修法

`resolveLaunchParent()`（`src/supervisor/terminal-supervisor.ts`）在 **preflight 通过之后**、
`terminal.run` 之前解析：

| 情形 | `parent` 取值 | 依据 |
|---|---|---|
| 本地 launch | `HC_TERMINAL_ID`（本进程所在终端） | 这个地址就在本 core 命名空间里；显式写进请求，不再只依赖 `caller` 的默认推导 |
| 跨机 launch | 目标机的 **`lgl-anchor` 终端**的 target-local 地址（首次创建后复用） | 目标 core 里唯一「替我们站着」的终端 |
| 进程不在 hc 终端里（headless） | **不发 `parent`**，改写 `parentAbsent` | 不许静默：见 §3 |

锚点（anchor）按 issue 验收的形状实现，全部落在 `src/runs/parent-anchor.ts` 的常量里：

- 名字 `lgl-anchor`，label `legion.anchor=<host>`，`argv: []`（那台机器自己的 shell）、`keep: true`；
- **创建走默认父路径**：不发 `parent`，只发 `caller` → herdr 自己把它限定成
  `<发起方 core-id>/<终端 id>`，于是 `lgl-anchor` 的祖先链在跨机方向是连的，`where` 也能沿链继承；
- **复用**：先 `terminal.get { terminal: "<host>/lgl-anchor" }`（地址必须带机器前缀，名字只在单 core 唯一），
  live 就复用；已 finished 就 `terminal.rm` 后重建；并发创建撞 `name_taken` 时回读 holder，
  带同一个 `legion.anchor` label 就复用，否则把原因记成 `parent=absent(<原因>)`；
- 一个进程内按机器缓存（`anchors: Map<host, address>`），一个 core 里始终只有一个锚点。

## 3｜拿不到父地址时：不静默

`parent` 缺失时 launch **不失败**（issue 验收：headless 仍要能跑），但三处都写清楚：

- 记录（`run.json`）：`parentAbsent: "<原因>"`（与 `parentTerminal` 互斥，永不并存）；
- 回执：`  ⚠ <name>: parent=absent(<原因>)`，走的是和 model warning / 跨机扩展 skip 同一条
  `launchNoticeLines` 通道（`▶` 行与「queued 后放行」通知都渲染）；
- status：`renderLiveChildStatus` 在 `terminal=` 下一行打印 `parent=<地址>` 或
  `parent=absent(<原因>)`（跨机 child 一定打印；本地 child 不打印——父就是读者所在终端；
  死记录只有 `host`/`parentAbsent` 才长这一行，保持 6.2.4 的死记录形状）。

`parent=absent(...)` 的判词统一由 `parentLine()` 产出，receipt 与 status 共用一份实现，
和 #423 的 `launch-evidence` 同一种写法（一个规则、一个实现、三处引用）。

## 4｜`run.json` 追溯链（父 runId / 父终端 / 子终端）

`ChildRecord` 新增三个**只增**字段（无 schema 升级）：

```
parentRunId     # 发起本次派发的 run（本 run.json 的 runId；子记录自带，便于从记录直接反查）
parentTerminal  # 本次 terminal.run 实际使用的 parent（目标 core 命名空间里的地址）
parentAbsent    # 拿不到父地址时的原因（与 parentTerminal 互斥）
```

链：`remoteTerminal`（子在 core 里的地址）→ `parentTerminal` → `parentRunId`。
反查规则是 `parentChain()`（纯函数）：三者齐备才 `ok: true`；有 `parentAbsent` 的
「已解释的缺失」仍然是缺失，不许读成已连通。真机产出的原文：

```json
{"name":"worker-0","state":"launching","host":"loopback409",
 "remoteTerminal":"loopback409/lgl-r-b36e97-worker-0",
 "parentRunId":"r-b36e97f2","parentTerminal":"lgl-anchor"}
```

## 5｜真机验证

本机 `hc machine ls` 是空的（没有外部物理机），沿用 #424 报告里的做法：用 hc 自己的多机能力
造一台独立 core 的机器，**用完删干净**。

```console
$ hc machine add localhost --name loopback409 --session legion409 --temp --install --json
{"host":"hw","name":"loopback409","session":"legion409","target":"localhost","temporary":true,"version":"0.1.21"}
$ HC_TERMINAL_SOCKET=/run/user/1000/herdr-core/legion409.sock hc machine ls
{"machines":[{"name":"loopback409","state":"connected",…}]}
```

派发走的是**真实 legion 通道**：`Orchestrator.launch` → `TerminalSupervisor` → 真实 `hc connect`
（`host: loopback409`，child 是真实 `node` 终端；`/tmp/legion409-live/run-live.ts`）。
发起方是 `HC_TERMINAL_ID=t77`（本次 centurion 自己的终端）。

### 5.1 有 parent 时（链是连的）

目标 core（`loopback409` 那台机器自己的 `hc ls --all`）：

```json
[
 {"address":"t10","agent":"bash","cwd":"/tmp/legion409-live/checkout","name":"lgl-anchor",
  "parent":"ee92eb44aa61c2859804d864acc1f2b6/t77","state":"live","turn":0},
 {"address":"t11","agent":"node","cwd":"/tmp/legion409-live/checkout","name":"lgl-r-f9b709-worker-0",
  "parent":"t10","state":"live","turn":0}
]
```

发起方 core 的合并视图：

```json
{"address":"loopback409/t10","name":"lgl-anchor","parent":"t77","where":null,"state":"live"}
{"address":"loopback409/t11","name":"lgl-r-f9b709-worker-0","parent":"loopback409/t10","where":null,"state":"live"}
```

锚点本身（`hc get t10`）：

```json
{"address":"t10","name":"lgl-anchor","parent":"ee92eb44aa61c2859804d864acc1f2b6/t77",
 "labels":{"legion.anchor":"loopback409"},"argv":["/usr/bin/bash"]}
```

即链路 `t77 ← lgl-anchor(t10) ← lgl-r-f9b709-worker-0(t11)`：锚点的父是「默认父路径」限定出来的
发起方终端（跨机可解析），child 的父是**目标机本地地址 `t10`**——正是 #409 认可的唯一形态。
第二次、第三次派发复用同一个锚点（`parentTerminal: "lgl-anchor"`，terminal.run 只有 child 这一条）。

### 5.2 不传 parent 的对照（链断了）

把 `resolveLaunchParent` 临时变异成「永远返回 `{}`」（= 修复前的形状），同一条真机通道再派一次：

```json
[
 {"address":"t10","agent":"bash","cwd":"/tmp/legion409-live/checkout","name":"lgl-anchor",
  "parent":"ee92eb44aa61c2859804d864acc1f2b6/t77","state":"live","turn":0},
 {"address":"t12","agent":"node","cwd":"/tmp/legion409-live/checkout","name":"lgl-r-4f42ec-worker-0",
  "state":"live","turn":0}
]
```

`t12` 这行**没有 `parent` 键**（发起方视图里是 `"parent": null`），而锚点仍在——断掉的正好是
「child → 父」这一步，和 issue 里截到的现象一模一样。这次真机对照同时就是变异验证的一部分。

> `where` 一列在本机两次都是 `null`：`where` 由 herdr 沿父链解析（同一个 core 里 t5f → t78 就是继承的），
> 而本次发起方终端 `t77` 是 headless centurion（没有 Herdr space/tab 可取）。本条修的是父链本身；
> 跨机 `where` 标签是 herdr CLI 在创建时自己带的（issue 实验第四行），不属于本条的写入面。

清理（验证后不留垃圾）：

```console
$ hc kill loopback409/t10 … && hc rm loopback409/t10 …
$ hc machine rm loopback409
{"removed":"loopback409"}
$ HC_TERMINAL_SOCKET=…/legion409.sock hc machine ls
{"machines":[]}
```

## 6｜测试与门禁

### 6.1 新增单测（`test/unit/spawn-parent-anchor.test.ts`，12 例）

| 要求 | 用例 |
|---|---|
| 独①：跨机请求体带正确 parent | 锚点先建（`on`+`legion.anchor`+`caller`、**无** `parent`），child 的 `parent === "t1"`（目标本地地址），且**不是** `t1k` / `vps/t1k` 两种会被真 core 拒绝的写法；`caller` 不出现 |
| 复用一机一锚 | `terminal.get` 命中 live 锚点 → 只有一条 `terminal.run`，`parent === "lgl-anchor"` |
| 独②：父地址缺失不静默 | 锚点被目标机拒绝 → child 仍然启动、请求里**没有** `parent`、`parentAbsent` 含原因、receipt 原文 `  ⚠ name: parent=absent(...)`；headless（无 `HC_TERMINAL_ID`）同样断言 |
| 独③：链能反查 | `run.json` 真文件（真 `Orchestrator` + 真 `RunStore` + 真 ledger）里 `parentRunId`/`parentTerminal`/`remoteTerminal`，`parentChain()` 给出 `ok:true` 与三段值；`parentAbsent` 的记录 `ok:false` |
| 规则本身 | `parentChain` / `parentLine` / `parentNoticeLines` / `anchorLocalAddress` 的纯函数用例 |

`test/helpers/fake-hc-core.mjs` 同时加严：`parent` 现在按真 core 的语义**校验**——
目标请求里必须是该机器上存在的终端，跨命名空间的名字 `not_found`，带 `/` 的限定形式
`machine_unknown`。于是「把本机 caller id 当 parent 发过去」在 oracle 里直接失败，而不是靠断言字符串。

### 6.2 既有测试的适配（都是「锚点是第一条 terminal.run」）

`cross-machine-params`（3 例）、`remote-child-fate`（单测 1 例 + 集成 2 例）、
`fake-core-remote-spawn` S1、`remote-worktree` S2、`fake-core-host-discovery` D2：
改为按名字取 child 自己那条 `terminal.run`（`params.name !== "lgl-anchor"`），断言本身没有放宽
（S1 还新增了锚点形状、`parent`、`handle.parentTerminal` 三条断言）。
preflight 失败的用例**仍然**是零 `terminal.run`：锚点解析放在 preflight 之后，正是这个顺序。

### 6.3 门禁

```console
$ flock /tmp/pi-legion-ci.lock -c "npm run typecheck && npm test"
… ℹ tests 2749  ℹ pass 2749  ℹ fail 0        （typecheck 无输出）
$ npm run test:integration
… ℹ tests 193   ℹ pass 193   ℹ fail 0
```

基线没有上调：唯一被改的既有断言都是「第几条 `terminal.run`」，没有删除任何用例、没有放宽任何判据。

## 7｜变异（红）

把 `resolveLaunchParent` 改成「永远返回 `{}`」（= 修复前形状）后：

```
$ node --experimental-strip-types --test test/unit/spawn-parent-anchor.test.ts
ℹ tests 12  ℹ pass 7  ℹ fail 5
✖ #409 req 1: a cross-machine spawn sends a TARGET-LOCAL parent (the anchor), not this machine's id
✖ #409: a second launch to the same machine REUSES the live anchor (one terminal per machine)
✖ #409 req 2: an anchor the machine refuses does not hide — the launch continues and says `parent=absent`
✖ #409 req 1: a LOCAL spawn sends its own terminal as the parent, in this core's namespace
✖ #409 req 2: a headless process names no parent — and never pretends it did
```

红的是全部 wire 断言，绿的正好是纯规则与「记录已落盘」的用例——变异打在 `parent` 传递上，
没有连带打坏判词与持久化。真机侧同一变异见 §5.2（`t12` 无 `parent`）。恢复后 12/12 绿。

## 8｜未覆盖 / 已知限制

- **`where` 的最终落点仍是 herdr 的**：本条保证父链存在，`where` 由 herdr 沿父链解析。
  发起方终端若是 GUI 里的 pane（有 space/tab），`where` 会随之出现（issue 实验第一/四行）；
  本次真机的发起方是 headless centurion，所以 `where` 为空——这不是链路缺失，是链上没有 display 事实。
  跨机 `where` 标签本身由 herdr CLI 在创建时携带，本条不复制 `herdr.space`（契约 D8）。
- **锚点是一个常驻 shell 终端**：`keep: true`，属于「每台机器一个」的长期设施；
  `retire` 不清它（和 worktree/session 同一种「留下证据」的姿态），`hc kill`/`rm` 由操作者决定。
- **一次性真机验证用的是本机 loopback 机器**（独立 core，共享文件系统）：`on` 转发、目标 core
  的父解析、锚点创建/复用都是真的，但「两台机器 node/pi 布局不同」只能由单测与部署覆盖
  （与 #424 报告的同一限制）。
- 未做：`legion.detached=true` label（issue 验收提到的 headless 标记）。本次以
  `parentAbsent` + receipt + status 三处可见达成「不静默」，label 记为后续小项。
