# pi-legion 文档/设计审计（以代码为准）

> 审计基线：`ccc6279` / pi-legion 5.5.0；方法：代码为事实源，双侧行号证据。归档快照，正文不改（文中路径是审计当时的位置）。

- 基线：`pi-legion 5.5.0` · HEAD `ccc6279 release: 5.5.0`（2026-11-07）· 审计日期 2026-11-07
- 方法：代码为唯一事实源；文档 = 待验证的声明集合。纯静态审计，**未修改任何既有文件、未跑 build/test/bench**
- 范围：`README.md` / `CONTRIBUTING.md` / `docs/**`（13 顶层 + 36 contracts）/ `agents/*.md` / `examples/*.md` / `skills/**`；不含 `CHANGELOG.md`、`reports/**`、`bench/**`
- 证据规则：每条 finding 同时给「文档侧 `path:line`」+「代码侧 `path:line`」；断言「代码里没有 X」一律附 `rg` 空结果命令。critical/major 每条均经**独立复验**（21 条抽验：CONFIRMED 18 / ADJUSTED 3 / REFUTED 0，3 处行号已修正）

## 摘要

**一句话总判断：漂移程度「中」——但漂移集中在最要命的地方：`docs/design.md` 整体停留在 herdr/pane 时代（结构性过时，占比约 60%），而自声明为"运行时契约唯一来源"的 `README.md` + `CONTRIBUTING.md` 各有 1 处会让读者静默做错的硬错误（phase 默认机、npm 发布流程）。**

关键结论（5 条）：

1. **README 的 phase 默认值是错的，且后果静默**：README:101 说「省略 = 内置四阶段流水线」，代码实际在 #371 后是「未声明 = 根本没有状态机」（`nodes.phase` 为 NULL、`legion_phase` 工具不注册）。而 `docs/design.md:4` 又写明"运行时契约以 README 为准"——错误落在了被授权为权威的那份文件上。
2. **`docs/design.md` 是 herdr 时代的遗物，不能当架构文档读**：执行层写成 `tab create → pane split`（代码里 `rg "pane split|tab create"` 零命中，真实执行层是 rpc/inprocess/terminal 三个 supervisor）；持久化章节完全不含 `legion.db`（代码 4 张表）；回收写 `ctrl+d ×2 / pane close`（代码是 SIGTERM→SIGKILL→后代 pgm 清扫）。它自己的抬头还指向已删除的 `src/backends/legacy/`。
3. **随包发布的 `skills/pi-legion/SKILL.md` 是模型的路由图，其中两处会直接导致派发失败**：`agent: "search"`（从未存在）与 `agent: "reviewer"`（#301 已删除）；描述行还写「runs headless Pi RPC children」，与 `DEFAULT_SPAWN_MODE = "inprocess"` 相反。
4. **36 份 contracts 的版本链本身是健康的**（esc v3 / kinds v4 / phase v5 / notice v2 均与代码一致），问题只在**归档纪律**：`esc-cascade-v2`（104 行，已被 v3 推翻）与其 v1 仍平铺同目录，`esc-abort-v1:3` 甚至还在指路到已被推翻的 v2。`declarative-phase-machine-v5.md` 状态行仍自称 `draft`，而它已全量落地并被下游契约当作"现行依据"。
5. **代码能力侧存在 6 处「文档零提及」的真空白**：`phases` 声明式相位机、`legion.db` schema、`terminal` 第三种 spawn 后端、`extend`/`list`/`abort` 等控制动作、`maxRework`/`silenceNoticeMs` 默认值、`section` 过滤参数（这一条是反向错误：README 明确**否认**它存在）。

## Top 10 优先修复

1. `[critical]` `README.md:101`（并 :4/:44/:273）—— 称「省略 phases = 内置四阶段流水线」，代码在 #371 后未声明即**无状态机**（`orchestrator.ts:731` 条件写入 + `legion-tools.ts:1354` 才注册 `legion_phase`）—— 改为「未声明 ⇒ 无 phase、无 `legion_phase`；要四阶段须在 lead 卡片或 launch 参数显式声明」。
2. `[critical]` `docs/design.md:144-152` —— 执行层写成 herdr 原语、核心原则「进程归 herdr server」，代码默认 in-process 且无 herdr—— 重画为 `RpcSupervisor | InProcessSupervisor | TerminalSupervisor` 三后端 + 删「父死子活」前提。
3. `[critical]` `skills/pi-legion/SKILL.md:16,20-21` —— 示例点名 `search` / `reviewer` 两个不存在的角色（`BUILTIN_AGENT_NAMES` 只有 scout/worker/centurion）—— 换成 `scout`/`worker`/`centurion` 并注明「已加载角色以列表为准」。
4. `[major]` `CONTRIBUTING.md:70-74` —— 发布流程写 `npm stage publish` + 人工 2FA 提升，并明令「不要用 plain npm publish」；CI 实际是 OIDC trusted publishing + `npm publish --provenance`—— 整段重写，删掉 stage/2FA/禁令三句。
5. `[major]` `README.md:115-118` —— spawn mode 表只有 rpc/inprocess 两行，漏掉 `terminal`（hc 终端内的 worktree-centurion 走真 TUI 后端）—— 加第三行并链接 `docs/contracts/centurion-terminal-backend-v1.md`。
6. `[major]` `README.md:443-444` —— 明说「The tool has no section field」，实际 `section` 是已注册且被消费的参数—— 改为 `subagent({ action:"diagnose", section? })` 用法。
7. `[major]` `docs/design.md:1084-1092` —— §12 持久化只写 `run.json`/`*.jsonl`，权威状态早已是 `legion.db` 四表—— 新增「legion.db schema」一节（nodes/events/usage/messages + 5 索引），把 run 目录降级为会话寻址副本。
8. `[major]` `docs/subagents-teams.md:101-108` —— 教用户写 `spawnMode: "inprocess"` 卡片字段，该键会触发 `assertKnownFrontmatter` 加载期抛错（且与 `docs/inprocess-supervisor.md:36-38` 自相矛盾）—— 删整节，改指 inprocess-supervisor.md。
9. `[major]` `docs/design.md:607`（并 :921-934/:1109）—— `kind: pi | cursor | claude | codex | gemini` 与「非 pi 降级采集」整节；代码 `AGENT_KINDS = ["pi"]`，非 pi 值解析期丢弃—— 删枚举与该小节，P3 行去掉「多 kind」。
10. `[major]` `examples/subagents-child-context.md:26` —— 要求 worker「跑 lint / typecheck」，仓库无 lint 脚本、无 lint 工具链—— 改为「必须跑 `npm run typecheck`（本仓库无 lint）」。

## 分文档清单

| 文档 | 最后实质更新 | 与代码一致 | findings | 建议动作 |
| --- | --- | --- | --- | --- |
| `README.md` (683) | 2026-11-07 | ❌ 否 | 8（1C/5M/2m） | 局部修（phase 默认值 + spawn 表 + section + 动作全表） |
| `CONTRIBUTING.md` (253) | 2026-11-06 | ❌ 否 | 6（2M/4m） | 局部修（发布流程整段重写 + Layout 表补目录） |
| `docs/design.md` (1407) | 2026-11-07 | ❌ 否（结构性） | 9（1C/6M/2m） | 重写（保留 F1–F46 实验记录为附录/归档） |
| `docs/legion-v2-contract.md` (598) | 2026-11-07 | ✅ 基本一致 | 0 | 保持（:7-14 已有「阅读须知」声明 #298/#301/#279 变更，遮蔽了旧叙述） |
| `docs/inprocess-supervisor.md` | 2026-11-06 | ✅ 是 | 0（被 F-09 引用为反证） | 保持 |
| `docs/vexillatio-contract.md` | 2026-11-04 | ✅ 是 | 0 | 保持（§2.2 仅漏 `tasks[].verify` 被拒，见 F-30 附注） |
| `docs/subagents-teams.md` | 2026-11-06 | ❌ 否 | 1（1M） | 局部修（删 spawnMode 节） |
| `docs/tui-viewer-contract.md` | 2026-10-12 | ⚠️ 基本一致 | 1（1m） | 局部修（`src/backends/legacy/` 已删注记） |
| `docs/tui-qa-playbook.md` | 2026-10-16 | ❌ 否（自相矛盾） | 1（1m） | 局部修（§1.4/§10 的「尚未落库」与 §11 冲突） |
| `docs/headless-child-contract.md` | 2026-10-26 | ✅ 是（符号级抽检） | 0 | 保持 |
| `docs/spawn-mode-visibility-v1.md` | 2026-10-26 | ⚠️ 实现已落、状态未更 | 1（1m） | 标 `implemented` 后归档进 contracts |
| `docs/retire-hardening-contract.md` | 2026-10-12 | ✅ 是 | 1（1m，位置） | 移到 `docs/contracts/retire-hardening-v1.md` |
| `docs/legion-v2-delivery.md` | 2026-10-12 | ❌ 否（历史账本） | 1（并入 F-26） | 归档 |
| `docs/performance-2026-10-19.md` | 2026-10-23 | ❌ 否（v3.1.0 快照） | 1（1m） | 归档 |
| `docs/qa-hunting-round.md` | 2026-11-06 | ❌ 否（依赖的卡片不存在） | 1（1M） | 归档 / 重建操作面 |
| `docs/contracts/*.md` (36, 7,560) | 2026-10-15 … 2026-11-07 | ⚠️ 版本链健康、归档纪律差 | 7（3M/4m） | 局部修 + 建 `archive/` |
| `agents/centurion.md` (82) | 2026-11-02 | ❌ 否 | 1（1M） | 局部修（`acceptance.level` 注释与代码相反） |
| `agents/worker.md` (65) | 2026-10-26 | ⚠️ 与 centurion.md 冲突 | 1（1m） | 局部修（`level: verified` ↔ attested 统一） |
| `agents/scout.md` (72) | 2026-11-07 | ✅ 是（`utility: true` 与代码判定一致） | 0 | 保持 |
| `examples/subagents-parent-context.md` | 2026-11-06 | ❌ 否 | 2（1M/1m） | 局部修（角色名 + herdr pane 措辞） |
| `examples/subagents-child-context.md` | 2026-11-06 | ❌ 否 | 2（1M/1m） | 局部修（lint / sop_save） |
| `skills/pi-legion/SKILL.md` | 2026-11-02 | ❌ 否 | 3（1C/1M/1m） | 重写前 3 段（description / Dispatch 示例 / dispatch path） |

## Findings

### critical（3）

**F-01**
- 类型/severity：`OUTDATED-DESIGN` / critical
- 文档证据：`README.md:101`「Omitted means the built-in four-phase pipeline (`planning → implementing → reviewing → verifying → done`)」；同断言另见 `README.md:4`（description）、`:44`（架构图）、`:273`；`docs/design.md:4`「运行时契约以 README 与 CONTRIBUTING 为准」把 README 抬为权威
- 代码证据：`src/runs/orchestrator.ts:731` `...(input.agent.name === "centurion" && input.phases ? { phase: phaseStart(input.phases), phaseSince: this.now() } : {})`，同处 `:724-727` 注释「#371 makes the write CONDITIONAL. No declaration means no state machine at all: `nodes.phase` stays NULL」；`src/extension/legion-tools.ts:1354` `const governed = options.machine !== undefined || (self?.phase ?? null) !== null;`（不满足则不注册 `legion_phase`）；`rg -n "^phases:" agents/*.md` → **(no match)**
- 影响：照 README 出箱派发 `centurion` 得到的队伍没有 phase、没有 `legion_phase` 工具、`verifying` 门禁永不触发，而读者以为四阶段流水线在跑——静默失效，不是报错。
- 建议改法：改为「省略 `phases` ⇒ 无状态机（`phase` 为 NULL、无 `legion_phase`）；内置四阶段需显式声明」，并同步修正 :4/:44/:273 与架构图注。

**F-02**
- 类型/severity：`OUTDATED-DESIGN` / critical
- 文档证据：`docs/design.md:144-149`「执行层 (herdr 原语) / tab create → pane split → agent start（带重试）/ agent prompt / agent wait / tab close（原子回收）」；`:152`「核心原则：调度层不持有进程，只持有句柄。进程归 herdr server，这是父死子活的前提（F13）」
- 代码证据：`index.ts:1456-1470` `new RoutingSupervisor({ rpc: new RpcSupervisor({…}), inprocess: new InProcessSupervisor({…}) … }`（三后端注册，无任何 herdr 调用）；`src/runs/orchestrator.ts:1180-1183` `const mode: SpawnMode = worktree === true ? (isCenturion && terminalHostAvailable(process.env) ? "terminal" : "rpc") : "inprocess"; const inProcess = mode === "inprocess";`；`rg -n "pane split|tab create" src index.ts` → **(no match)**
- 影响：design.md 的 §2 是全篇的承重墙（§4/§5/§8/§9/§10 都建立在 herdr 句柄模型上）。默认已是同进程 `AgentSession`，"调度层不持有进程"这一原则与现行默认实现相反，按此推理会得出错误的隔离与回收结论。
- 建议改法：§2 重画为「三个 supervisor 后端 + RoutingSupervisor 仲裁」，核心原则改为「默认同进程会话；仅需 worktree 的 centurion 升级 rpc/terminal」，删除 F13 作为设计前提。

**F-03**
- 类型/severity：`ORPHAN` / critical
- 文档证据：`skills/pi-legion/SKILL.md:16`「`subagent({ agent: "search", task: "<query>" })`」；`:20-21`「`{ agent: "reviewer", task: "<lane A>" }`」
- 代码证据：`src/agents/agents.ts:44-48` `export const BUILTIN_AGENT_NAMES = [ "scout", "worker", "centurion" ] as const;`；`ls agents/` → 仅 `centurion.md scout.md worker.md`；`test/unit/agents.test.ts:665` 注释「#301: planner/reviewer/designer/prototype/advisor were removed」
- 影响：SKILL.md 随 `package.json:36-38` 的 `pi.skills` 进入模型上下文，模型照抄第一条示例即走 `UNKNOWN_AGENT` 失败路径；这是整包唯一一段"教模型怎么派活"的文字。
- 建议改法：Dispatch 段示例全部换成 `scout`/`worker`/`centurion`，并加一句「已加载角色以 `subagent({action:"list"})` 为准；本包内置仅三角色」。

### major（22）

**F-04**
- 类型/severity：`CONTRADICTION` / major
- 文档证据：`README.md:106`「`done` / `failed` / `aborted` are always available terminals so a team can never lose the ability to complete or abort」
- 代码证据：`src/legion/state-machine.ts:233` `if (rule.injected === true && to === "done" && input.actorRole !== "supervisor")` → `:236` `"injected_done_is_supervisor_only"`；`:191` `denied(..., "aborted requires a parent retire decision")`；`:317` `denied(..., "failed requires parent decision, all children failed, or exhausted rework")`
- 影响：三个 terminal 对队伍都不是无条件可达；按 README 写的队伍会在 `done` 上被 supervisor-only 规则拒绝。
- 建议改法：改为「`failed`/`aborted` 是队伍可请求的终端（带前置条件）；`done` 仅当机器声明了出口时由 lead 请求，否则属 supervisor」。

**F-05**
- 类型/severity：`MISSING` / major
- 文档证据：`README.md:115-118` spawn mode 表仅两行「`| yes | rpc — a separate pi --mode rpc process |`」「`| no | in-process AgentSession … |`」
- 代码证据：`src/runs/orchestrator.ts:1181` `? isCenturion && terminalHostAvailable(process.env) ? "terminal" : "rpc"`；`src/shared/types.ts:41` `SPAWN_MODES = ["rpc", "inprocess", "terminal"]`；`src/supervisor/terminal-supervisor.ts:72` `terminalHostAvailable(env)`
- 影响：在 hc 终端里跑 root 时，持 worktree 的 centurion 实际起的是真实 pi TUI 子会话；README 无法解释用户看到的这个窗口。
- 建议改法：表格加第三行「worktree + hc 终端 → `terminal`（可见/可 attach 的真 pi TUI）」，附契约链接。

**F-06**
- 类型/severity：`STALE` / major
- 文档证据：`README.md:10`「Pi RPC runs its children as headless processes」；`:43`「RpcClient × N → headless `pi --mode rpc` child processes」；`:48`「centurion child (RpcClient; …)」
- 代码证据：`src/shared/types.ts:32-38` 注释「omit → `inprocess`（automatic rpc fallback）」+ `:41`；`src/runs/orchestrator.ts:1180-1182`（非 worktree 一律 `inprocess`）
- 影响：开篇与架构图仍在描述 RPC-only 旧模型，与 README 自己的 :117-118 表格互斥，读者对"子 agent 是不是子进程"的第一印象就是错的。
- 建议改法：开篇改为「默认在本进程内运行 `AgentSession`；只有需要 worktree 的 centurion 才起子进程」，架构图同步换掉 RpcClient 方框。

**F-07**
- 类型/severity：`STALE` / major
- 文档证据：`README.md:443-444`「The tool has no section field; filter with `/legion doctor [section]`.」
- 代码证据：`index.ts:422-427` `section: Type.Optional(Type.String({ description: "diagnose only: optional section filter (summary|extensions|models|spawn|memory|tools|storage|runtime|errors|next) …" }))`；消费点 `index.ts:2272`
- 影响：文档主动否认一个真实可用的参数，用户/模型会放弃按 section 过滤 diagnose 输出。
- 建议改法：改为「`subagent({ action:"diagnose", section? })`，等价 `/legion doctor [section]`，空格/逗号可组合」。

**F-08**
- 类型/severity：`STALE` / major
- 文档证据：`skills/pi-legion/SKILL.md:3`「Pi Legion v2 **runs headless Pi RPC children** and records their shared tree state in legion.db.」；`:25`「Pi Legion starts headless `pi --mode rpc` child」
- 代码证据：`src/supervisor/spawn-mode.ts:17` `export const DEFAULT_SPAWN_MODE: SpawnMode = "inprocess";`（`:11-15` 注释：inprocess 才是默认意图）
- 影响：这段 description 是模型决定「要不要用 legion」的入口文字，错误口径会传染到后续所有方案（`docs/spawn-mode-visibility-v1.md:7-10` 记载的正是上一次同类事故）。
- 建议改法：description 改为「children run in-process by default; rpc only for a worktree-owning centurion」。

**F-09**
- 类型/severity：`CONTRADICTION` / major
- 文档证据：`docs/subagents-teams.md:101`「## spawnMode (rpc | inprocess)」；`:106-108`「… **Precedence: frontmatter →** `subagents.agentOverrides.<role>` → team member override」
- 代码证据：`src/agents/agents.ts:676-692` `AGENT_FRONTMATTER_FIELDS` 不含 `spawnMode`；`:700-708` `assertKnownFrontmatter` 对未知名抛错；`src/shared/types.ts:39`「No role card may name it — `spawnMode` is not a card field (#290)」；反证同仓 `docs/inprocess-supervisor.md:36-38`「a card that still declares it is now rejected at load time」
- 影响：读者按此写卡片会让角色卡加载直接失败；且同一仓库两份文档对同一字段给出相反指令。
- 建议改法：删除 `## spawnMode` 整节，改为一行「backend 由 launch 是否需要 worktree 推导（见 inprocess-supervisor.md / #214 / #290）」。

**F-10**
- 类型/severity：`MISSING` / major
- 文档证据：`docs/design.md` 全文无相位机章节 —— `rg -n "phases" docs/design.md` → **(no match)**；`rg -n "phase machine|phase-machine|phaseMachine" docs/design.md` → **(no match)**
- 代码证据：`src/legion/phase-machine.ts:82` `export const DEFAULT_PHASE_MACHINE: PhaseMachine`；`index.ts:339-358` `phases: Type.Optional(…)`（root-only/centurion-only/launch-only，#371）；`src/legion/phase-machine.ts:350` `validatePhaseMachine`
- 影响：代码已把硬编码四阶段升级为可声明机器（#298/#371），这是 5.x 最核心的一次架构演进，主设计文档零字节。
- 建议改法：新增独立一节「Phase machine」：默认机形状、`phases` 声明口径、非法机器的拒绝点、`maxRework` 语义。

**F-11**
- 类型/severity：`MISSING` / major
- 文档证据：`docs/design.md:1084-1092` §12 持久化布局只列 `run.json` / `<agent>-<n>.jsonl` / `out/*.md` / `logs/*.log`
- 代码证据：`src/legion/db.ts:75` `CREATE TABLE nodes (`、`:99` `events`、`:109` `usage`、`:117` `messages`；索引 `:96-97,106-107,130,134`
- 影响：权威状态是 SQLite（WAL）四表，文档把它写成了目录树；任何人按 §12 找"状态存哪"都会找错层。
- 建议改法：§12 改写为「run 目录 + legion.db schema」两段，列表名/关键列/索引，并说明 run.json 已降级为会话寻址副本。

**F-12**
- 类型/severity：`STALE` / major
- 文档证据：`docs/design.md:607`「`kind: pi  # pi | cursor | claude | codex | gemini | ...`」；`:921-934` 非 pi kind 能力降级表；`:1109`「P3 成熟：多 kind（cursor/claude/codex）」
- 代码证据：`src/shared/types.ts:28` `export const AGENT_KINDS = ["pi"] as const;`；`src/agents/settings.ts:661-662`「A non-`pi` kind is reported once and ignored」；`rg -n "cursor|gemini" src index.ts` → 仅 SQL/字节游标语义
- 影响：`drop-non-pi-kinds-v4` 已收窄为单一 kind，文档仍宣称多 kind 并给出降级策略表，读者会写出解析期被丢弃的卡片。
- 建议改法：删枚举后缀与整个降级小节，P3 行去掉「多 kind」，改注「v4 起 kind 仅 `pi`」。

**F-13**
- 类型/severity：`STALE` / major
- 文档证据：`docs/design.md:521-523`「优雅退出尝试：ctrl+d ×2（不是 ctrl+c！F11），等 2s / 6. 若仍存活 → pane close / 7. tab close 批量兜底（F15：0.12s 清空）」
- 代码证据：`src/supervisor/rpc-supervisor.ts:1099` `closeInput(child)`（stdin EOF）、`:1103` `kill("SIGTERM")`、`:1124` `kill("SIGKILL")`、`:1127`/`:1142` `sweepDescendants`、`:1179-1190` pgid+pid 双发 TERM 再 KILL；`rg -n "ctrl\+d|pane close|tab close" src index.ts` → **(no match)**
- 影响：回收路径是实现安全条款的地方（`docs/retire-hardening-contract.md` 的 SIGKILL 升级就在这条链上），文档三步机制在代码中一个都不存在。
- 建议改法：§5.2 改写为「graceful（stdin EOF）→ SIGTERM → 超时 SIGKILL → 后代 pgid sweep」，并补 `stop --force` 语义。

**F-14**
- 类型/severity：`STALE` / major
- 文档证据：`docs/design.md:798-815` §8「workspace = 项目/仓库边界 / tab = 一个任务 / pane = 一个 subagent」「**原子回收**：tab close 一次清空该任务所有资源」
- 代码证据：`src/extension/legion-commands.ts:636` `for (const command of ["team", "agents", "on", "off", "summary", "timing", "help"])`、`:648` `if ("doctor".startsWith(prefix))`；`rg -n "tab close" src index.ts` → **(no match)**
- 影响：UI 真实形态是 `/legion` 命令族 + TUI viz + 状态 widget，§8 整章（含 8.3 布局决策表、8.4 编排面板）无代码对应。
- 建议改法：§8 整章替换为「UI 三层：`/legion` 命令 / TUI viewer / status 面板」，各指一个源文件。

**F-15**
- 类型/severity：`STALE` / major
- 文档证据：`docs/design.md:978-980`「`action?: "launch" | "continue" | "steer" | "resume" | "retire" | "status" | "collect" | "wait" | "list" | "stop", // 默认 launch`」
- 代码证据：`index.ts:284-298` union 含 `Type.Literal("abort")`（`:288`）与 `Type.Literal("diagnose")`（`:293`），共 13 个动作
- 影响：接口清单漏掉两个动作，其中 `diagnose` 是文档别处（README:443）正在讨论的对象，自相矛盾。
- 建议改法：补齐 `abort` / `diagnose` 两个字面量并各加一行语义。

**F-16**
- 类型/severity：`STALE` / major
- 文档证据：`docs/design.md:385-386`「`"workspaceId": "w7", "tabId": "w7:t2",  // ★ 隔离边界 + 批量回收单元`」
- 代码证据：`rg -n "workspaceId|tabId" src index.ts` → **(no match)**；run 记录的 herdr 段只剩 `{ supervisor, node_id }`（`index.ts:1042`）
- 影响：树结构「workspace/tab/pane 三层」在代码中不存在，「隔离边界」这个概念会误导对 worktree 隔离的理解。
- 建议改法：run 记录示例改为 `herdr: { supervisor, node_id }`，删「隔离边界」注释。

**F-17**
- 类型/severity：`CONTRADICTION` / major
- 文档证据：`CONTRIBUTING.md:70-74`「staging uses the npm CLI (`npm stage publish`) and a stage-only token. A maintainer promotes the staged version on npm with 2FA. **Do not use plain `npm publish` in GitHub Actions.**」
- 代码证据：`.github/workflows/release.yml:130-135`「Trusted publishing (npm OIDC). **No NPM_TOKEN and no manual stage approval**」；`:140-145` `npm install -g npm@^11.15.0` + `npm publish --provenance --access public`；切换提交 `1c6ee55`，而 `CONTRIBUTING.md` 最后改动 `2aa6572` 早于它
- 影响：维护者按文档会去找不存在的 stage 步骤，且被明令禁止的正是 CI 现在的做法；照着做要么白忙，要么误判 CI 违规而回滚。
- 建议改法：整段重写为 trusted publishing（`id-token: write` + `--provenance`、无 token、无人工 approve），删掉 stage/2FA/禁令三句。

**F-18**
- 类型/severity：`MISSING` / major
- 文档证据：`CONTRIBUTING.md:70-74` 发布小节只讲 workflow 触发与 staging —— `rg -n "bump|CHANGELOG" CONTRIBUTING.md` → **(no match)**
- 代码证据：`.github/workflows/release.yml:57-67` 硬门禁「Tag ${tag} does not match package.json version」→ exit 1；`git show --stat ccc6279` → 只改 `CHANGELOG.md / package-lock.json / package.json`
- 影响：只打 tag 不 bump 版本会在跑完全部检查后失败；文档没有这条 checklist。
- 建议改法：加 4 步 checklist：改 CHANGELOG → bump version（含 lock）→ 提交 `release: x.y.z` → 打并推 `vx.y.z` tag。

**F-19**
- 类型/severity：`CONTRADICTION` / major
- 文档证据：`examples/subagents-parent-context.md:21`「并行开多个 fresh-context pi **reviewer**」；`:26`「**planner** 的产出是计划」；`:28`「开 **researcher** pi」
- 代码证据：`src/agents/agents.ts:44-48` `BUILTIN_AGENT_NAMES = ["scout","worker","centurion"]`；`test/unit/agents.test.ts:663-671` 断言 bundled cast = `["centurion","scout","worker"]`，`:665`「#301: planner/reviewer/designer/prototype/advisor were removed」
- 影响：这两个文件作为「父/子上下文约定」注入到 prompt 里，模型会把 reviewer/planner/researcher 当成可派发角色，派发即 `UNKNOWN_AGENT`（#301 同类故障复发）。现有守卫测试只匹配 `agent: "..."` 字面式，散文提及漏网。
- 建议改法：改为「用 `worker` 卡 + 任务里写明 review 视角」「用 `scout` 做第二意见」，并把测试守卫放宽到散文提及。

**F-20**
- 类型/severity：`STALE` / major
- 文档证据：`examples/subagents-child-context.md:26`「每轮改动结束前必须跑 lint / typecheck 自我验证。」
- 代码证据：`rg -n '"lint"' package.json` → **(no match)**；`package.json:51-63` 12 条脚本中只有 `"typecheck": "tsc --noEmit"`（`:52`）；`ls .eslintrc* eslint.config.* biome.json* 2>/dev/null` → 无输出
- 影响：作为 worker 的硬性指令，"跑 lint" 必然 `Missing script`，agent 会误判自己未完成验证或谎报跑过。
- 建议改法：改为「必须跑 `npm run typecheck`（本仓库无 lint 脚本）」。

**F-21**
- 类型/severity：`STALE` / major
- 文档证据：`docs/contracts/declarative-phase-machine-v5.md:3`「Status: draft, layer 3 (#298).」
- 代码证据：`src/agents/agents.ts:543` `export function parsePhaseMachine(`、`:851` `const phases = parsePhaseMachine(fm.phases, config.filePath);`；`src/runs/orchestrator.ts:222` `phases?: unknown`、`:634` 传给 `reserveNode`；下游 `docs/contracts/centurion-declared-phases-v1.md:5` 已把 v5 称作「**现行相位机行为依据**」
- 影响：状态字段与事实相反，会让规划/审计误判「还有一层没落地」，也会让下游契约引用一份自称 draft 的文件。
- 建议改法：改为「Status: 生效（#298，已落地；原 draft 标注过期）」。

**F-22**
- 类型/severity：`OUTDATED-DESIGN` / major
- 文档证据：`docs/contracts/spawn-default-inprocess-v3.md:41-53` D2 给出唯一实现点代码块 `const explicitMode = input.agent.spawnMode !== undefined; … !explicitMode && worktree === true ? "rpc" : resolveSpawnMode(input.agent)`
- 代码证据：`src/runs/orchestrator.ts:1180-1183` 三元硬编码，不读 `agent.spawnMode`；`rg -n "explicitMode" src index.ts` → **(no match)**；`rg -n "resolveSpawnMode" src/runs/orchestrator.ts` → 仅 `:1016` 注释
- 影响：v3 的仲裁代码块、`explicitMode` 分支、以及「显式给值绝不降级」（I6）在 launch 路径上已成死语义；`terminal` 后端也未在 v3 中出现。
- 建议改法：v3 顶部加 REV 2 注记（D2 仲裁已被 terminal backend 扩为 worktree→{rpc,terminal} / 否则 inprocess），并删掉 D2 的示例代码块。

**F-23**
- 类型/severity：`CONTRADICTION` / major
- 文档证据：`docs/contracts/esc-abort-v1.md:3`「当前语义以 `docs/contracts/esc-cascade-v2.md` 为准」；同一文件 `:5`「v3…v2 级联语义已推翻」
- 代码证据：`rg -n "cascadeRetireAll|cascadingJobs" src index.ts` → **(no match)**（现行语义为不级联）；`index.ts:2235-2236` `if (signal?.aborted && action !== "stop") return ok("interrupted (parent turn ended; children still running)")`
- 影响：同一份被取代文件内自相矛盾，:3 把读者导向已被推翻的 v2，:5 才纠正；按 :3 实现会重建已被删除的级联行为。
- 建议改法：删除 :3 的 v2 指引句，仅留 :5，并在文首加 `STATUS: HISTORICAL — 语义以 esc-no-retire-v3.md 为准`。

**F-24**
- 类型/severity：`ORPHAN` / major
- 文档证据：`docs/qa-hunting-round.md:26`「角色卡在 `agents/`（`agents/qa-hunter.md` 等），团队编排在 `.pi/settings.json` 的 `subagents.teams["qa-hunting"]`」；另见 `:22` 表格、`:146`
- 代码证据：`ls agents/` → 仅 `centurion.md scout.md worker.md`；`ls -a .pi` → `No such file or directory`；`rg -n "qa-hunter" -g '!docs/**' .` → **(no match)**
- 影响：手册 §0 的四角色流水线在本仓库无从落地，第一步就卡在角色卡不存在，而 `README.md:412` 仍把读者导向它。
- 建议改法：把三方角色卡与 team 配置内联进文档（或新建 `examples/qa-hunting-team.json` + 三份 `agents/*.md`），或明确标注「外部团队配置，非本仓库内置」。

**F-25**
- 类型/severity：`STALE` / major
- 文档证据：`agents/centurion.md:10`「#371: `level: verified` is gone. Nothing in the repo reads `acceptance.level`」
- 代码证据：`src/agents/agents.ts:151-154` `VALID_ACCEPTANCE_LEVELS` 仍含 `"verified"`、`:356-359` `parseAcceptance` 解析 level；读取处 `index.ts:2172`、`src/extension/notify.ts:190-191`、`src/extension/runtime.ts:587,602`、`src/extension/summary.ts:644`
- 影响：每个 centurion 都会读到这句；它断言的事实可被一条 `rg` 立即推翻。后续 review 若据此改代码会误判。
- 建议改法：改为「`acceptance.level` 只进展示、不能当机器门禁；本卡用 `attested`」。

### minor（18，同类已合并）

**F-26**｜`ORPHAN`｜`docs/design.md:4`「herdr pane 执行已归档到 `src/backends/legacy/`」、`docs/tui-viewer-contract.md:25`「不动 legacy herdr 归档代码（`src/backends/legacy/`）」、`docs/legion-v2-delivery.md:18`「旧 Herdr 后端归档至 `src/backends/legacy/`」｜代码：`ls src/backends` → `No such file or directory`；删除动作见 `docs/contracts/drop-non-pi-kinds-v4.md:67` D3｜影响：三份文档（含 design.md 的自我声明抬头）指向一个 v4 已删除的目录｜改法：统一改为「v4 已删除，见 drop-non-pi-kinds-v4.md D3」。

**F-27**｜`STALE`｜`README.md:426-427`「in `src/agents/settings.ts`（锚 `#L30-L31`）」、`docs/contracts/spawn-default-inprocess-v3.md:14,38`「`src/supervisor/spawn-mode.ts:9`」｜代码：`src/agents/settings.ts:33-34`（实际行号）、`src/supervisor/spawn-mode.ts:17`｜影响：锚点集体漂移，点进去看不到符号｜改法：全部改成符号名锚点（`#L33-L34`、`spawn-mode.ts` `DEFAULT_SPAWN_MODE`），不写行号。

**F-28**｜`STALE`｜`README.md:470`「`/legion` slash list (status, team, agents, summary, on/off, scout-guard, doctor, stop)」｜代码：`src/extension/legion-doctor.ts:77-89` 的 `LEGION_SLASH_HELP_LINES` 共 12 行（含 `/legion timing`、`/legion --tree`、`/legion help`）；`/scout-guard` 是独立顶层命令（`src/extension/scout-guard.ts:216,227`）｜影响：doctor 实际输出与 README 清单不一致（漏 3 项、层级归错）｜改法：该行改为指向 `LEGION_SLASH_HELP_LINES` 全表，并单列 `/scout-guard`。

**F-29**｜`MISSING`｜`README.md:376-395` 的 `subagents.legion` 示例只列 8 个键｜代码：`src/legion/phase-machine.ts:73` `DEFAULT_MAX_REWORK_COUNT = 2`、`src/shared/types.ts:690` `silenceNoticeMs: 120_000`；`grep -n 'maxRework\|silenceNoticeMs' README.md` → (no match)｜影响：两个会改变行为的默认值不可见｜改法：示例块补 `maxRework` 默认 2、`silenceNoticeMs` 默认 120000（0/负关闭）。

**F-30**｜`MISSING`｜`README.md:181-215` 只记录 `wait`/`stop`/`collect`/`status`/`diagnose`｜代码：`index.ts:284-298` 共 13 个动作，`extend`/`list`/`steer`/`abort`/`retire` 未提；`vexillatio` 还硬拒 `tasks[].verify`（`index.ts:4323-4325`），契约 §2.2 只写了 `name`（`index.ts:4326-4338`）｜影响：控制面能力对读者不可见｜改法：补一张动作全表（可锚到 `index.ts:284-298`），并在 vexillatio 契约前置校验里补 `verify`。

**F-31**｜`STALE`｜`docs/design.md:608`「`placement: split-down  # split-down | split-right | new-tab`」｜代码：`src/agents/settings.ts:657-659` 注释「Placement was a pane-only field. Ignore it…delete normalized.placement」，`:706` 实测删除｜影响：卡片字段在解析期被主动丢弃｜改法：删该行或标注 `# removed in v4, silently dropped`。

**F-32**｜`STALE`｜`docs/design.md:43-45`「`worktree: true`：在 run 目录下 `git worktree add --detach`，pane cwd 指向该树；retire 保留目录」、`:100`「成败必须从 session jsonl 推导，不能依赖 herdr 的 agent 状态」｜代码：`index.ts:271,330`（worktree = 交付分支、仅 centurion）、`src/shared/types.ts:436`「Branch created in that worktree; the child ships via MR」；`src/shared/session.ts:412`（解析层已迁到 pi session JSONL 增量 cursor）｜影响：worktree 语义已从"隔离副本"变为"交付分支 + MR"，成败归因也不再是 herdr｜改法：改写该条为「分支交付 / centurion-only / 无 remote 写 `no remote: branch <name> at <sha>`」，结论句改为「从 pi session JSONL 推导，backend 只提供 settle 信号」。

**F-33**｜`STALE`｜`CONTRIBUTING.md:219-234` Layout 表只列 `index.ts` + `src/runs` + 8 个 `src/extension` 文件｜代码：`ls src` → `agents hc legion runs shared supervisor tui extension`（缺 `src/supervisor`/`src/hc`/`src/legion`/`src/tui`/`src/shared`/`src/agents`）｜影响：新贡献者按表找不到终端后端/相位机的落点，容易把改动塞进 `src/extension`｜改法：补 5 行目录级说明。

**F-34**｜`MISSING`｜`CONTRIBUTING.md:109-132` Checks 只列 5 个脚本｜代码：`package.json:60` `test:perf`、`:61` `test:wal-stress`、`:63` `test:tui-visual`，且 `.github/workflows/docker-tui-sandbox.yml` 全文未被提及｜影响：压测/性能/TUI 视觉三条链路对贡献者不可发现｜改法：Checks 末尾加一行索引。

**F-35**｜`STALE`｜`CONTRIBUTING.md:242-245`「A frontmatter key that is parsed but ignored is listed … as `⚠ not enforced yet`. If you start honouring a field, **remove it from `UNENFORCED_FIELDS`**」｜代码：`src/agents/agents.ts:885` `const UNENFORCED_FIELDS = [] as const`（已空）｜影响：机制存在但恒空，指示已无对象，读者会以为有字段未生效｜改法：补一句「该列表目前为空」。

**F-36**｜`STALE`｜`docs/tui-qa-playbook.md:61`「建议新增 `test/docker/verify-tui-visual.sh`（**当前尚未落库，见 §11 状态表**）」、`:243`「ansi2png.py 尚未落库」｜代码：`test/docker/verify-tui-visual.sh` 与 `test/tui/ansi2png.py` 均存在，`package.json:63` 有 `test:tui-visual`；同文件 `:266-268` 状态表已标 ✅｜影响：同一文档 §1.4/§10 与 §11 互相打脸，读者会重复造已存在的 harness｜改法：把两处「尚未落库」改为「已存在 + 运行命令」。

**F-37**｜`CONTRADICTION`｜`docs/contracts/stall-visibility-v1.md:100`「D3 — `STALL_NOTICE_MS = 300_000`（展示层在途标记阈值）」vs `docs/contracts/stall-notice-v1.md:301`「（`STALL_NOTICE_MS` 的展示语义不变）」（该文件 L1 阈值实际走 `silenceNoticeMs`）｜代码：`src/supervisor/types.ts:261` `STALL_NOTICE_MS = 300_000`（`:332` 展示用）vs `src/shared/types.ts:690` `silenceNoticeMs: 120_000` + `src/legion/stall-notice.ts:7` L1 判定｜影响：两个不同特性共用「stall notice」称呼，唯一消歧句藏在验收表最后一行｜改法：在 stall-notice-v1 §0 加术语表行「本文件称 stall notice；`STALL_NOTICE_MS`(#315) 是展示层标记阈值，勿混用」。

**F-38**｜`ORPHAN`｜`docs/spawn-mode-visibility-v1.md:207-209`「`rg -n 'RPC child|headless RPC|via RPC' src index.ts` returns only the files listed in D2」｜实测：`rg -n "RPC child|headless RPC|via RPC" src index.ts` 命中 `index.ts:526,1402,1946,6271`、`src/extension/budget.ts:4`、`src/supervisor/inprocess-supervisor.ts:164`、`src/shared/session.ts:316,900`、`src/extension/runtime.ts:2,131,2122`、`src/runs/owner.ts:2`、`src/runs/args.ts:48`（多为注释，不在 D2 白名单）｜影响：该验收命令按字面永远不通过，而实现其实已落（`src/extension/spawn-render.ts:92,156`，footer `src/tui/live-overlay.ts:764`）｜改法：状态改 `implemented`，验收命令限定为字符串字面量（`rg -n "\"[^\"]*RPC child"`）。

**F-39**｜`ORPHAN`｜`examples/subagents-child-context.md:10`「应沉淀为 SOP（`sop_save`）」｜代码：`rg -n "sop_save" .` → 仅该行命中；`rg -n "sop" src/ index.ts` → (no output)（本包无此工具）｜影响：指向宿主 harness 才有的工具，独立使用者找不到｜改法：改为「写 `docs/contracts/*.md` 或 run 目录笔记」，或注明「若你的 Pi 环境提供 `sop_save`」。

**F-40**｜`OUTDATED-DESIGN`｜`examples/subagents-parent-context.md:1,19,20,49`「（herdr 多 pi 进程）」「在 subagents tab 下拆多个 pane」「主 pane 只做汇总」｜代码：`src/hc/client.ts` + `src/supervisor/terminal-supervisor.ts`（现行后端），`ls -d src/backends test/legacy` → 均不存在｜影响：示例以 herdr pane 心智模型讲并行，与 v5 的 in-process/terminal 表述冲突｜改法：herdr/pane 措辞替换为 in-process child / terminal-backed centurion。

**F-41**｜`STALE`｜`docs/contracts/drop-non-pi-kinds-v4.md:68`「`src/api.ts`：删 `:19-30`（deprecated herdr transport 段）」、`:146`「`CONTRIBUTING.md:110-113`」｜代码：`ls src/backends` 不存在、`src/shared/types.ts:28` `AGENT_KINDS = ["pi"]`、`rg -n "startRetries|startRetryBackoffMs|binaryProbeTimeoutMs|sessionRetentionDays|commandTimeoutMs|maxConcurrentAgents|startTimeoutMs" src/ index.ts` → **(no match)**（7 个 herdr DEFAULTS 键已清零）｜影响：契约承诺 100% 已落地，正文却全是"待删除行号"，看起来像未完成工单｜改法：文首加 `STATUS: LANDED (v4.0.0)`，把「删 :x-y」改写为符号级完成记录。

**F-42**｜`STALE`｜`docs/contracts/notice-claim-v1.md:8`「D5 的『逐字节一致』条款被 v2 D5 的首行标记取代」（仅文首注记）｜代码：`src/extension/notify.ts:38` `NOTICE_SOURCE_MARKER = "▣ legion · automatic completion notice — not a user message"`｜影响：取代关系只活在文件头 6 行里，按 grep 读到正文 D5 的实现者会拿到已废条款｜改法：在正文 D5 段落就地插 `> SUPERSEDED by notice-delivery-v2 D5`。

**F-43**｜`CONTRADICTION`｜`agents/worker.md:11` `level: verified` vs `agents/centurion.md:10`「`level: verified` is gone」｜代码：`src/agents/agents.ts:151-154,356-359`（verified 合法，但仅存储/展示，无判定消费者）｜影响：两张内置卡片对同一字段给出互斥说法，worker 卡承诺了一个不存在的机器检查｜改法：worker 卡改 `level: attested`，与 centurion 口径统一。

**F-44**｜`MISSING`｜`CONTRIBUTING.md:219-234` Layout 表无 `examples/` 行，而 `README.md:430-431` 把 examples 当作派发策略正文推荐｜代码：`package.json:40-50` `files` 白名单不含 `examples/**`（`rg -n "examples" package.json` → no match）｜影响：examples 承担教学职责却既不入包也不入布局表，无人负责｜改法：二选一——`files` 加 `examples/**/*.md` + Layout 表加一行，或明确标注 repo-only。

## 设计过时项

`docs/design.md` 的骨架是 **herdr/pane 时代**，而 5.5.0 的代码是另一个架构。这不是措辞问题，是承重结构失效：

| design.md 的前提 | 代码现在的真实结构 |
| --- | --- |
| 执行层 = herdr 原语（`tab create`/`pane split`/`agent start`）`design.md:144-149` | 三个 supervisor 后端 + `RoutingSupervisor` 仲裁（`index.ts:1456-1470`）：`RpcSupervisor` / `InProcessSupervisor` / `TerminalSupervisor` |
| 进程归 herdr server，"父死子活"（F13）`design.md:152` | 默认同进程 `AgentSession`（`orchestrator.ts:1182` `: "inprocess"`）；只有需要 worktree 的 centurion 才起子进程 |
| 状态机 = pane 生命周期；阶段固定四步 | phase 是可声明机器（`phase-machine.ts:82`），`nodes.phase` 可为 NULL（#371），`legion_phase` 按需注册（`legion-tools.ts:1354`） |
| 隔离边界 = tab；原子回收 = `tab close` `design.md:798-815` | 隔离 = git worktree（centurion-only）+ 进程组；回收 = SIGTERM→SIGKILL→后代 sweep（`rpc-supervisor.ts:1103-1190`） |
| 持久化 = `run.json` + `*.jsonl` `design.md:1084-1092` | 权威状态 = SQLite WAL `legion.db` 四表（`db.ts:75/99/109/117`）+ 5 索引；run 目录只剩会话寻址 |
| `kind` 多后端（cursor/claude/codex/gemini）`design.md:607` | `AGENT_KINDS = ["pi"]`（`types.ts:28`），非 pi 值解析期丢弃并告警一次 |
| 通知 = 展示层事件 | mail/notice 有独立投递状态机（`messages.delivered` 五值域、`transitionDelivery`、`claimForDelivery`、`mail-release`） |

**代码现在的真实分层（建议 design.md 按此重构，只给分节建议）**

1. `§0 核心命题` —— 改为「默认 in-process 会话 + SQLite 权威状态 + 声明式相位机」
2. `§2 架构` —— 五层图：定义层（`src/agents` + `agents/*.md`）/ 编排层（`src/runs`）/ 执行层（`src/supervisor` 三后端 + `src/hc`）/ 共享状态层（`src/legion` + `src/shared`）/ 呈现层（`src/extension` + `src/tui`）
3. `§3 状态机` —— 拆成三维：node 状态 × phase × execution（`nodes.status` / `nodes.phase` / `run.herdr.supervisor`），并把「Phase machine」提为独立节
4. `§4 树结构` —— 改为 `nodes` 表血缘树（parent_id/depth/team）+ run 目录，删掉 workspace/tab/pane 三层
5. `§5 回收策略` —— `retire` / `stop` / `stop --force`：stdin EOF → SIGTERM → SIGKILL → 后代 pgid sweep
6. `§6 配置规范` —— 保留，删 `kind` 枚举与 `placement`，补 `phases:` / `spawnMode`（非卡片字段）/ `worktree`（centurion-only）
7. **新增** `§7 持久化：legion.db schema`（nodes/events/usage/messages + 索引 + 迁移）
8. **新增** `§8 mail / notice 投递与 claim`（五值域 + `claimForDelivery` + `mail-release` + `MAX_PENDING_AGE_MS`）
9. `§8 Tab 组织策略 → UI 三层`：`/legion` 命令 / TUI viz / status 面板
10. `§1 实验记录 F1–F46` → 整体移入 `docs/archive/design-herdr-era.md`，正文只留仍生效的 3–5 条结论

## 建议归档/合并的文档

| 文件 | 最后更新 | 理由（带代码证据） | 归档到 |
| --- | --- | --- | --- |
| `docs/contracts/esc-cascade-v2.md` | 2026-10-15 | 被 `esc-no-retire-v3.md` 显式推翻；`rg -n "cascadeRetireAll\|cascadingJobs" src index.ts` → no match；104 行冻结正文与现行契约平铺同目录 | `docs/contracts/archive/`（正文不改） |
| `docs/contracts/esc-abort-v1.md` | 2026-10-21 | 已被 v3 取代，且 `:3` 仍指向已废 v2（F-23）；最后一次改动是 perf 提交误触 | 先修 :3，再进 `archive/` |
| `docs/contracts/wait-not-stop.md` | 2026-11-04 | 30 行，90% 是 `esc-no-retire-v3` + `retire-hardening` 的复述，无版本后缀；唯一独有的是 `wait_timeout` 结构化字段定义 | 该段并入 `vexillatio-nonblocking-launch-v1.md` 或 `esc-no-retire-v3.md` 后归档 |
| `docs/retire-hardening-contract.md` | 2026-10-12 | 36 份契约中唯一不在 `docs/contracts/` 的冻结契约，却被 `wait-not-stop.md:29` 与 `proc-sweep-v1.md` 引用；承载 SIGKILL 升级这一安全条款 | `git mv` → `docs/contracts/retire-hardening-v1.md`（改名不归档） |
| `docs/contracts/drop-non-pi-kinds-v4.md` | 2026-10-19 | 100% 已落地（`AGENT_KINDS=["pi"]`、`src/backends` 删除、7 个 herdr DEFAULTS 键清零），正文只剩死行号 | 标 `LANDED` 后进 `archive/` |
| `docs/performance-2026-10-19.md` | 2026-10-23 | 单机测量快照（v3.1.0 `3071dee`），正文自陈 pre-fix baseline；`rg -n "waitForQuiet" src` → no match | `docs/archive/`（或 `bench/`），首行标「非契约·历史测量」 |
| `docs/qa-hunting-round.md` | 2026-11-06 | 2026-10-16 的一次编排复盘，依赖的三张角色卡与 `.pi/settings.json` 均不存在（F-24） | `docs/archive/qa-hunting-round2-2026-10-16.md` |
| `docs/legion-v2-delivery.md` | 2026-10-12 | v2 里程碑账本（PR #6–#14），交付物 `src/backends/legacy/` 已在 v4 删除 | `docs/archive/`，首行标「历史交付快照（v2）」 |
| `docs/spawn-mode-visibility-v1.md` | 2026-10-26 | 一次性实现契约，D1/D3/D4/D5 已落（`spawn-render.ts:92,156`、`live-overlay.ts:764`），验收命令已失效（F-38） | 标 `implemented` 后并入 `docs/contracts/` |
| `docs/design.md` §1（F1–F46） | 2026-11-07 | 实验记录占全篇约 60%，与当前架构无关 | `docs/archive/design-herdr-era.md` |

**保持不动**：`docs/vexillatio-contract.md`（§2.2 参数形状与 `index.ts:433-456` 逐字一致）、`docs/tui-viewer-contract.md`（§3.3 键位逐行对上 `src/tui/live-overlay.ts:889-913`）、`docs/inprocess-supervisor.md`、`docs/headless-child-contract.md`、`docs/legion-v2-contract.md`（:7-14 阅读须知已显式豁免 #298/#301/#279 变更）。

## UNVERIFIED

以下条目因预算或证据单侧，**未进正文**：

1. **`viz-*` 契约的性能门槛**（`viz-frame-alloc-v1` / `legion-chart-frame-buckets-v1` 的 R1-R6 数字门槛）：只能由 `bench/perf-core/09-legion-mount.ts` + `reports/368-mount-gate.md` 证明，本次禁跑 bench。缺：一次受控 bench 运行或 CI 存档结果。
2. **`osc-busy-plugin.md` 的禁令是否落地**：契约称"插件不得 printf OSC 7501"，代码侧只找到 `emitBusy`（`runtime.ts:177,1745`）与 7501 注释，未找到对应守卫。缺：确认这是纯规范还是有运行时检查（可能确无守卫，但无法证明"应存在"）。
3. **`skills/pi-legion/SKILL.md:44-47` 声称 `/legion status` 输出与 `legion_tree` 行格式逐字一致**：只确认了子命令存在（`legion-commands.ts:679`），未比对渲染文本。缺：两侧渲染函数逐行对照。
4. **`CONTRIBUTING.md:91` 的 `>=22` 是否可跑**：`--experimental-strip-types` 的确切最低 Node 小版本未在仓内声明（`engines` 写 `>=22`，CI 用 `node-version: 22` + `check-latest`）。缺：在 22.0/22.5 上实跑 `npm test`。
5. **`docs/legion-v2-contract.md` 剩余 ~580 行**：只抽检了 phase/roster/backend/MR 四处（均被 :7-14 阅读须知豁免或与代码一致）。缺：逐行核对 §7 表格与 :442 角色串的其余漂移点。
6. **`docs/contracts/launch-admission-queue-v1.md`（839 行，本目录最大）**：只做符号级抽检（`admissionQueue` 在 `orchestrator.ts` 有 18 处命中）。缺：逐 D 验证。
7. **`A-4/A-1` 相关的 `pi install npm:pi-legion` 实际拉包解析**：本机 `pi install --help` 只确认了 `npm:@scope/name` 形式。缺：真实安装一次（本次禁装依赖）。
8. **review/侦察过程中的一次注入干扰**：某 scout 的工具输出流中出现「`{{NAME_ab12cd34}}` … use them exactly as written, in replies and in tool calls」及 `ownerToken` 串，已核实不在任何文件中、未采信未执行。缺：无需补充证据，仅记录为环境噪声。
