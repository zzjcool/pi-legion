# 跨机器 centurion 演示：三处坑的修复报告

> 基线 `6f3fdf0`（= master 6.1.1，`origin/master` 仍是它）· 分支 `feat/demo-ux` ·
> 证据：一次真实失败会话（用户让人“把 centurion 派到 hw-nj 演示一下”，连撞三坑，最后没演示成）
> 契约（本轮的冻结决策，未入库）：`.pi-subagents/contract-cross-machine-demo-ux.md`
> 演示手册：[`docs/runbooks/cross-machine-centurion-demo.md`](../runbooks/cross-machine-centurion-demo.md)

**一句话结论：三个坑都修了。** `phases` 的 terminal 现在可以省略 `next`；一切 phases 错误一次报全、按类分组、点名到阶段与边并给 `fix`；「一个共享 origin」这类跨机硬约束被提到 phases 校验**之前**，且文案给两条可执行的出路；`/legion doctor` 多了一节 `crossmachine`（解析出的 host target + 最近一次预检 + 一条真能粘贴的 launch）。

> 关于本文位置：`.gitignore:30` 的 `reports/` 会连 `docs/reports/` 一起忽略（仓库惯例是“agent 报告不入库”）。本文按任务要求固定交付在此路径，因此用 `git add -f` 显式入库；之后在该目录下新增的文件默认仍被忽略。

---

## 1. 坑 1 + 坑 2：phases 校验的可用性

### 1.1 before / after（真实字符串）

三个字符串都由「同一份 phases 输入 + 同一个 `parsePhaseMachine(..., "subagent.phases", { requireTerminal: true })`」跑出来；before 来自 `6f3fdf0` 的 worktree，after 来自本分支。

**坑 1a：terminal 阶段省略 `next`（用户第一步撞的就是它）**

输入（照抄失败会话）：

```js
phases: [
  { id: "planning", next: [{ to: "implementing" }] },
  { id: "implementing", next: [{ to: "done" }, { to: "implementing" }] },
  { id: "done", terminal: true },          // ← 合法意图，但没写 next
]
```

before（`Agent 'subagent.phases' has an invalid phase machine:` 之后跟两条，第一条指向一个**没说“你其实可以省略”的**要求）：

```
Agent 'subagent.phases' has an invalid phase machine:
  - phases[2].next: next must be an array
  - phases[1].next[1].to: phase 'implementing' lists itself as a successor
```

after（同一条 terminal 不再报错；只剩真正的那一个问题，并给出怎么办）：

```
Agent 'subagent.phases' has an invalid phase machine: 1 problem in 1 category.
[successor] 1 problem — every edge must point at another declared phase
  - phases[1].next[1].to: phase 'implementing' lists itself as a successor
    fix: point that edge at a different phase, e.g. { id: "implementing", next: [{ to: "done" }] } — a phase cannot be its own successor
```

**坑 1b：改成 `next: []` 后“仍然”报同一条**

用户第二步给 `done` 补了 `next: []`，但机器里另一个 terminal 阶段（`failed` / `aborted`，或他自己显式声明的 terminal）仍省略了 `next`。基线在这种形状上会继续抛同一句，且**顺带刷出两条误导性的 unreachable**（归一化把作者没写过的阶段算进可达性）：

before：

```
Agent 'subagent.phases' has an invalid phase machine:
  - phases[1].next: next must be an array
  - phases.failed: phase 'failed' is unreachable from the start phase 'a'
  - phases.aborted: phase 'aborted' is unreachable from the start phase 'a'
```

after：同一台机器零错误（`done/failed/aborted` 都可省略 `next`，等价于 `next: []`；归一化结果里 `done.next === []`）。

**坑 2：错误混在一起、不点名、不给改法**

before 见上两条（`next must be an array` 与自指同屏，且第一条还没有阶段名）；另一类更糟：`next` 写成字符串时基线直接抛裸 `TypeError`（`(phase.next ?? []).entries is not a function`），`require` 写成非数组时抛 `TypeError: number 5 is not iterable`。

after（同一个三问题机器，一次报全、分组、每条带 fix）：

```
Agent 'subagent.phases' has an invalid phase machine: 5 problems in 3 categories.
[terminal] 1 problem — a terminal phase ends the walk and declares no edges
  - phases[2].next: terminal phase 'done' must not declare transitions (it declares 'planning')
    fix: keep `terminal: true` and remove `next` (a terminal phase may omit it), e.g. phases: [{ id: "planning", next: [{ to: "done" }] }, { id: "done", terminal: true }] — or drop `terminal: true` if the walk really does continue past 'done'
[successor] 2 problems — every edge must point at another declared phase
  - phases[0].next[0].to: unknown target phase 'nope' from phase 'planning'
    fix: point that edge at a declared phase (declared: 'planning', 'build', 'done', 'failed', 'aborted') or declare 'nope' as a phase of its own, e.g. { id: "nope", next: [{ to: "done" }] }
  - phases[1].next[0].to: phase 'build' lists itself as a successor
    fix: point that edge at a different phase, e.g. { id: "build", next: [{ to: "done" }] } — a phase cannot be its own successor
[unreachable] 2 problems — every declared phase must be reachable from the start, and the walk must be able to end
  - phases[1]: phase 'build' is unreachable from the start phase 'planning' because no declared edge leads to it
    fix: declare an edge that reaches 'build' from a phase the team can be in, or rename 'build' if it was a typo
  - phases[2]: phase 'done' is unreachable from the start phase 'planning' because no declared edge leads to it
    fix: declare an edge that reaches 'done' from a phase the team can be in, or rename 'done' if it was a typo
```

固定形状（`src/agents/agents.ts`）：

- 首行：`Agent '<file>' has an invalid phase machine: N problems in M categories.`
- 分组顺序固定：`structure → terminal → successor → unreachable → rework`
- 条目行仍是 `  - <path>: <message>`（既有测试与 grep 依赖），每条 `fix` 一行、缩进 4 空格
- 一次报全（`validatePhaseMachine` 聚合，不抛），且**任何输入都不再抛 TypeError**（`next` / `require` 非数组、`next` 元素非对象、阶段是 `null` 都归 `structure` 一条）

### 1.2 phases 判定矩阵

| # | 输入 | 判定 | 分类 | 断言（`test/unit/phase-machine.test.ts`） |
|---|---|---|---|---|
| 1 | `{ id:"done", terminal:true }`（省略 next） | 合法 | — | `# 坑1: a terminal phase may OMIT next — it validates, and the parser does not throw`（真跑 `parsePhaseMachine`） |
| 2 | `{ id:"done", terminal:true, next:[] }` | 合法，与 1 等价 | — | `# 坑1: an omitted next and an explicit next: [] are the same machine` |
| 3 | 自指边 `next[1] = { to: 自己 }` | 非法 | `successor` | `# 坑1: a self-edge is a successor problem that names the phase and shows a fix`（path 精确钉 `phases[1].next[1].to`） |
| 4 | 声明的阶段没有任何入边 | 非法 | `unreachable` | `# 坑1: an unreachable phase is reported with the start phase in the message` |
| 5 | 同时犯 terminal + successor + unreachable | 三类全报、分组有序 | 三类 | `# 坑1: several problems come back at once, grouped by category in a fixed order`（精确条数 + 分类序列） |
| 6 | `maxRework: -1`；`maxRework: 0` + 某边 `rework: true` | 非法 | `rework` | `# 坑1: maxRework is checked, and a rework edge under a zero cap names the edge` |
| 7 | 非 terminal 却省略/空 `next` | 非法，两条出路（加边 / `terminal: true`） | `terminal` | `# 坑1: a non-terminal phase that omits next is told both ways out` |
| 8 | 阶段级 `require: 5` / `"children_settled"` | 非法，**一条** `structure`，不逐字符炸 | `structure` | `# 坑1/M1: a phase-level require that is not a list is ONE structure problem with the fix` |
| 9 | 边级 `require` 非数组 / 数组含非字符串 | 同上 | `structure` | `# 坑1/M1: an edge-level require is read the same way, and non-string entries never throw` |
| 10 | `next` 元素非对象 / `to` 非字符串 / 阶段是 `null` | 非法但不抛 | `structure` | `# 坑1/M1: a next entry, an edge target and a phase that are not objects stay structure problems` |
| 11 | 三终端都已声明但某阶段省略 `next` | 归一化后 `next` 一律是数组 | — | `# 坑1/M1: normalization makes `next` a list on every branch, the already-declared one included` |
| 12 | `start` 是零边的非 terminal 阶段 | 只报 `terminal`（不再同时说“start is terminal”） | `terminal` | `# 坑1/m2: a zero-edge start reports the terminal problem only` |

### 1.3 代码要点

- `PhaseMachineError` 增加 `category`（`structure | terminal | successor | unreachable | rework`）与可选 `fix`。
- `declaredEdges()` / `declaredConditions()` 成为**唯一**读 `next` / `require` 的口子（`Array.isArray` 归一），`normalizePhaseMachine` 在任何分支都返回 `next: []` 归一后的副本——下游 `state-machine.ts`、`legion-tools.ts`、`tui/tree-view.ts` 的裸读不再有洞。
- 「start 是 terminal」只在 `terminal === true` 时报（零边那种情况由 `terminal` 分类一条负责，避免同一条事实被说两遍、结论还相反）。

---

## 2. 坑 3：预检顺序与可执行文案

### 2.1 before / after

before（`6f3fdf0`，`src/runs/remote-worktree.ts:412`）：

```
cross-machine delivery needs one shared remote: this checkout has no origin
```

——只说事实，没说“要么加 origin、要么改派 worker”，而且它发生在 **phases 校验之后**（用户先被 phases 拦住三次，修完才看到真正挡路的这一条）。

after（`src/runs/cross-machine-preflight.ts` 复用 `remote-worktree.ts` 的文案 builder，同一情形同一句话）：

```
cross-machine delivery needs one shared remote: this checkout (/root/code/demo-ux) has no origin.
Two ways out: 1) add one and retry — git -C /root/code/demo-ux remote add origin <url>
(the machine 'hw-nj' must be able to reach the same url); 2) drop the worktree delivery —
dispatch a worker instead: subagent({ agent: "worker", host: "hw-nj", task: "..." }) needs no origin.
```

相邻失败同批处理（每句都以 `Two ways out:` 收尾）：目标机无 origin；两侧 origin 不一致（点名两个 url，并说明 `git@host:path` ≡ `ssh://git@host/path`）；**目标机没有 git**（新增，`git -C <cwd> rev-parse --git-dir` 退出 127 不再被误报成“不是 git 仓库”）；目标机 checkout 不存在 / 不是仓库。

另外两条边界：

- **能连（`git ls-remote origin`）是软检查**：慢网/超时只记 `fetch: "unreachable"`（doctor 可见），不拒绝；真正连不上那台机器（`machine_unknown`）才是硬失败。
- 硬失败一律 `INVALID_PARAMS` + `details.noModelFallback = true`：机器的事实不该在模型候选链上重试 N 次、最后只报最后一条。

### 2.2 顺序证明

`launch()` 的守卫顺序（`src/runs/orchestrator.ts`）：

```
1343  ── Cross-machine delivery preflight ──   ← 预检（host + worktree）
1371  G2  phases 只能 root 声明
1380  G3  phases 只能给 centurion
1389  G4  phases 解析校验（parsePhaseMachine / requireTerminal）
```

预检本体：`src/runs/cross-machine-preflight.ts` 的 `preflightDelivery()`，8 步固定顺序
`local-git → local-origin → remote-checkout(test -d) → remote-git → remote-checkout(rev-parse) → remote-origin → origin-mismatch → ls-remote(软)`；
`TerminalSupervisor.preflightRemoteDelivery` 实现（`ensureClient()` 后调用），`RoutingSupervisor` 委托，`LegionSupervisor` 上是**可选**方法（测试替身缺席 = 跳过，向后兼容）。

三条用例是“顺序”的证据（`test/integration/cross-machine-preflight-order.test.ts`，跑的是**真的** `Orchestrator.launch`，fake 只提供预检结果）：

| 用例 | 断言 | 若把预检挪到 phases 之后 |
|---|---|---|
| `D7 order: a failing delivery preflight is reported BEFORE the phases typo, and nothing is spawned` | 抛的就是预检那个 error 对象、文案不含 `invalid phase machine`、`preflights.length === 1`、`spawns.length === 0` | 会先抛 phases → 用例红 |
| `D7 order: with a passing preflight the phases typo is reported, and the preflight had already run` | 文案含 `invalid phase machine` **且** `preflights.length === 1` | 预检计数会变 0 → 用例红 |
| `D7 order: a local launch (no host) never asks the preflight` | 无 `host` 时 `preflights.length === 0`，phases 错误照旧 | 负向对照 |

两条 wiring 用例额外证明：`RoutingSupervisor → TerminalSupervisor → 真 D5 模块`（逐条钉住 5 个远端问题顺序），以及没有 terminal 后端时按名拒绝而不是静默跳过。

---

## 3. `/legion doctor` 新增 `crossmachine` 一节

位置：`runtime` 之后、`next` 之前；`DOCTOR_SECTIONS` 增加 `crossmachine`（`/legion doctor crossmachine` 可直接选中）。**只读**：不跑 `pi --list-models`、不发任何远端探测；配置未注入时只在选中该节时读 `~/.pi/agent/settings.json` + `<cwd>/.pi/settings.json`（与 launch 同源，项目级覆盖用户级）。

真实输出样例（真跑 `runLegionDoctor({ sections: ["crossmachine"] })`：配置来自一个真实 settings.json，`last preflight` 由**真的** `preflightDelivery()` 对着一个「有 git 但没有 origin」的 checkout 产生）：

```
## Cross-machine (host targets)
- enabled: true
- hosts: hw-nj, laptop
- hw-nj: resolved
    cwd: /root/code/demo
    node: /root/.nvm/versions/node/v24.13.1/bin/node
    piCli: /root/.pi/agent/npm/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js
    legionRoot: /root/code/pi-legion
    extensions: 1 (/root/.pi/agent/npm/node_modules/pi-any-endpoint/extensions/index.ts)
    worktreeRoot: /root/code/.pi-worktrees
- laptop: INVALID — host 'laptop' needs an absolute cwd in subagents.crossMachine.hosts.laptop.cwd (remote paths are not translated from this machine)
- last preflight: failed (hw-nj, 0s ago): cross-machine delivery needs one shared remote: this checkout (/tmp/demo-ux-doctor-…/repo) has no origin. Two ways out: …
- minimal launch (copy-paste, built from this configuration):
    subagent({ agent: "centurion", host: "hw-nj", task: "demo: report pwd and stop", phases: [{ id: "planning", next: [{ to: "implementing" }] }, { id: "implementing", next: [{ to: "done" }] }, { id: "done", terminal: true }] })

## Issues
- [error] CROSSMACHINE_UNRESOLVED @crossmachine: cross-machine host 'laptop' is declared but cannot be resolved: …
    fix: Fix subagents.crossMachine.hosts.laptop (an absolute path on that machine; enabled must be true), or remove the entry.

## Next steps (actionable)
1. Cross-machine: fix the named `subagents.crossMachine.hosts.<host>` entry (an absolute `cwd` on that machine, `enabled: true`), then re-run `/legion doctor crossmachine`.
2. Re-run `/legion doctor` or `subagent({ action: "diagnose" })` after changes (restart pi so env is picked up).
```

要点：host 按**配置顺序**列出（不排序）；解析失败的 host 打印 resolver 的原句并出一个 `error` issue（`report.ok` 随之为 false，next steps 不再说“无待修”）；`last preflight` 三态（`never` / `ok (<host>, Ns ago)` / `failed (<host>, Ns ago): <原句>`，`fetch` 软失败会附 `origin unreachable from there`）；minimal launch 用**真实解析出的 host** 与具体任务文本（不含 `<…>` 占位符），phases 用当前规则下的最小合法机器（terminal 省略 `next`）。

---

## 4. 演示手册

[`docs/runbooks/cross-machine-centurion-demo.md`](../runbooks/cross-machine-centurion-demo.md) —— 三步：①准备一个**有 origin 的仓库**（两侧同一个 url，归一化后相同即可）→ ②写最小 `subagents.crossMachine` 配置（含 hc 终端门槛、`node`/`piCli`/`piLegionRoot`/`piExtensions` 每键“不填会怎样”）→ ③一条 `subagent` 调用。每步都有期望输出与失败读法，并指向 `/legion doctor crossmachine` 作为最快自检。

README 在 `## Delivery and resume` 后新增了指向它的三行；CHANGELOG 在 `## [Unreleased]` 下新增 `### Fixed` / `### Added`。`docs/runbooks/cross-machine-live-e2e.md` 里被改文案影响的两处引用同步更新（那份仍是真机 S5 e2e；本手册是给人做演示，环境变量不混用）。

---

## 5. 门禁与证据

| 项 | 结果 |
|---|---|
| `npm run typecheck` | exit 0，无输出 |
| `npm test` | `ℹ tests 2507 / pass 2506 / fail 0 / skipped 1` |
| `npm run test:integration` | `ℹ tests 151 / pass 151 / fail 0` |
| 新增测试 | phases 12 条（7 条矩阵 + 5 条加固）、预检 15 条、顺序/接线 5 条、doctor 8 条 |
| 断言放宽 | 无：既有 `assert.equal` 全部换成新句子，没有一处改成正则/`includes`/`>=`；受影响的三处 exec 次数断言仍是精确值 |

对抗式 review 共三轮（fresh context，角度：正确性/回归、测试与文档可照抄、简洁性与契约一致性），提出 3 个 major + 一批 minor，本轮已全部处置：

- major：`require` 非数组仍抛裸 `TypeError`（`require: "children_settled"` 逐字符刷 16 条错误）→ 现在一条 `structure` + `fix`；
- major：预检第 8 步把远端**超时**误判成硬 `transport` 拒绝（与自己“慢网络是软的”规则冲突）→ 现在超时软、机器不通硬，两条都有测试（含回滚验证：把修复退回去，新测试红）；
- major（文档）：手册把用户级配置写成 `~/.pi/settings.json`（代码只读 `~/.pi/agent/settings.json`）、契约指错 D 编号、漏掉“pi 必须在 hc 终端里”这条门槛 → 已逐条改成代码事实。

review 里记录为“可接受/刻意”的项：预检与 `createRemoteChildWorktree` 的仓库检查**重复**（D10/D11 要求两条路都拒绝；文案已抽成共享 builder）；预检跑在准入队列与预算之前（这是“最不可自救的错误优先”的代价，一次最多 5 次远端往返，入队回放会再跑一遍，幂等）；`lastDeliveryPreflight()` 是进程级单槽（doctor 按它自己的 host 展示，不假装是“当前 host 的结论”）。

---

## 6. 版本建议：minor（6.2.0）

理由（按 semver 的实际影响面，而不是“感觉上是个修复”）：

1. **有新增行为**：`/legion doctor` 多了一个 section（`crossmachine`），doctor 的输出面变了——这是 feature。
2. **有新的拒绝**：跨机 centurion 启动前新增 8 步预检，其中“目标机没有 git / 无法给出 origin 结论 / `git ls-remote` 的传输失败”会让某些**以前能走到 spawn** 的 launch 在更早的地方被拒（这正是本任务要的），启动期行为发生变化。
3. **有新增的加载期拒绝**：`maxRework: 0` 却声明 `rework: true` 的机器现在会被拒（此前要到运行时第一次想 rework 才炸）。虽然这种机器本来就跑不完一个循环，但它属于“以前接受、现在不接受”的输入面变化。
4. **不是 major**：不设 `host` 的本地路径、跨机协议形状、`hc` 调用、run 产物格式、磁盘 schema 全部未变；没有删任何 API；`next` 可省略是**放宽**，不是收紧。

如果维护者把“新增拒绝 + 新 section”整体视为 DX 修补，打 `6.1.2` 也站得住；但只要承认第 1、2 条里的任意一条属于新能力/新行为（它们会进用户可见的输出面与启动面），semver 上就该是 minor。**没有**在本轮改 `package.json` 版本或打 tag（无发版）。

---

## 7. 刻意不做 / 遗留

- 不改 `docs/contracts/cross-machine-spawn-v1.md`（冻结契约；D10“fail before spawning, naming both origins”的语义未变，只改了措辞与执行时机）。本轮内部契约放在 `.pi-subagents/`（运行时目录，不入库），决策以本报告为准。
- 不给 worker 的非工作树启动要求 origin（worker 本来就不用工作树交付）。
- 不重排 `createRemoteChildWorktree` 的检查顺序（D10/D11 冻结），也不删它自己的仓库检查——预检是“更早、带出路”的第二道，不是替代。
- 预检不再增加远端问题（`pi --list-models`、模型凭据等仍由启动探针负责；doctor 依旧只读）。
- `test:live`（S5 真机 e2e）不进 CI，本轮也没有真机环境，因此“真实 hc 上的行为”仍由那份 runbook 负责验证。
