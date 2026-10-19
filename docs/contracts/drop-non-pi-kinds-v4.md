# 冻结契约：删除 cursor / 第三方后端支持，只保留 `kind: pi`（v4.0.0）

状态：**FROZEN** — 实施中禁止偏离。发现矛盾立刻停下，报给父会话，**不要自行解释矛盾**。

## 目标

`pi-legion` 只支持 `kind: pi`。删除 (a) cursor 专属 kind 逻辑，(b) 归档 herdr 后端
`src/backends/legacy/`，(c) 死掉的 `herdr.*` 设置与常量，(d) 一个派生缺陷（#233：未知事件
类型冻结事件游标）。

**不删除**：`spawnMode` 的 `rpc` / `inprocess` 两个 supervisory backend（那是 pi 的两种运行
方式，与第三方后端无关）。任何声称「backend 也该删」的推论都是错的。

## 已实测的硬事实（禁止重新侦察）

本 worktree `npm ci` 已完成；基线在 HEAD `35edac5` 上实测：

| 命令 | 结果 |
|---|---|
| `npm run typecheck` | exit 0 |
| `npm test` | 1153 pass / 0 fail |
| `npm run test:perf` | 17 pass / 0 fail |
| `npm run test:integration` | 83 pass / 0 fail |
| `npm run test:mock-llm` | 24 pass / 0 fail |

删除规模（静态统计，非抽样）：

| 触点 | 事实 |
|---|---|
| `src/backends/legacy/**` import 点 | 生产代码仅 `src/api.ts:21-30,341`；`index.ts` 零引用 |
| `test/legacy/**` import 点 | `test/legacy/herdr-client.test.ts:12-15`、`test/legacy/cursor-chat.test.ts:13`、`test/legacy/helpers/fake-herdr.ts:16`、`test/unit/output-cap.test.ts:6` |
| `test/unit/output-cap.test.ts` | **78 行 6 个 test，只有第 6 个（`legacy runner kills an infinite stream at the cap`）用 legacy runner**，其余 5 个测 `src/shared/output-cap.ts`。**禁止整文件删。** |
| `AGENT_KINDS` 收敛后的破测面 | 15 个测试文件（见 D4 清单） |
| `assertKindModelCoherent` 链 | `src/agents/presets.ts:167-183`（定义）+ `src/agents/step-model.ts:94-102`（唯一调用点） |
| `nativeModelFor` 存活用途 | 仅 `src/runs/orchestrator.ts:844`，且**永久传 `"pi"`**；等价于 `applyThinkingSuffix`（`src/runs/args.ts`） |
| `herdrStatus` 生产写入点 | **0**。`src/tui/status.ts` 内 8 处全读，`test/unit/status.test.ts:296` 是唯一写入者（测试造数） |
| `run.herdr` 字段 | **活跃字段**：写入点 `index.ts:421,464,1701,2294`、`src/runs/orchestrator.ts:707`、`src/runs/store.ts:256,277`，承载 `{supervisor, node_id}`。**禁止删字段** |
| `DEFAULTS` 7 个 herdr 键 | `startRetries`/`startRetryBackoffMs`/`maxConcurrentAgents`/`sessionRetentionDays`/`startTimeoutMs`/`binaryProbeTimeoutMs` 全仓 **0 引用**；`commandTimeoutMs` 仅在 `src/backends/legacy/client.ts` 用 |
| 用户可见的 `herdr` 字面量 | `src/extension/playbook.ts:19`（"using herdr pane/tab/agent commands"）、`src/tui/status.ts:555`（`● Async agents · herdr`） |
| CHANGELOG 锚点 | `CHANGELOG.md:439` 指向 `README.md#herdr-transition-and-role-migration` → 改 README 章节标题必须同步改它 |

## 决策（D 编号）

**D1 — 兼容性策略：硬删，但「被忽略的角色/预设字段」要响一次。**
- `AGENT_KINDS` 收敛为 `["pi"]`。**`AgentKind` 类型保留**（值域收窄），`AgentConfig.kind` 字段保留
  （大量 plumbing 依赖它，删字段是另一场改动）。
- 用户角色卡里的 `kind: cursor` 等：`parseAgentDocument` 保持 `enumOr` 语义（fallback `"pi"`），
  **但**当 frontmatter 显式写了 `kind` 且不在合法集内时，`console.error` 一次，含角色名、原值、
  以及「v4 只支持 kind: pi，该字段被忽略（按 pi 启动）」。同样的响一次也用于
  `subagents.presets.<name>.kind` 与 `agentOverrides.<name>.kind`（这三处是用户唯一能写 kind 的入口）。
- **不做**旧前缀别名（`kimi/k2` → `cb/kimi-k2` 之类）。模型名不在本契约范围。

**D2 — 删 `cursorModel` 与整条 kind 分支，`nativeModelFor` 直接消失。**
- `src/runs/kind.ts` 整文件删除（`planKindStart` 生产调用者为 0，见上表）。
  `nativeModelFor` / `isPiShapedModel` / `cursorModel` / `planKindStart` 全部删除。
- `src/runs/orchestrator.ts:844` 改为 `applyThinkingSuffix(model, thinking)`；
  `dropped` / `modelDropped` / `ChildRecord.modelDropped`（`src/shared/types.ts:366`）与
  `index.ts:1993-1997` 的「runs on X's own default」提示全部删除 —— 现在不存在「pi 表达不了的模型」
  这类情形，只有「没设置模型」。
- `applyThinkingSuffix` 的语义差异必须验证：`nativeModelFor("pi", m, t)` ===
  `applyThinkingSuffix(m, t)`（`applyThinkingSuffix` 的 `replaceExisting` 默认 `false` 与 `nativeModelFor`
  一致）。**在删 `nativeModelFor` 之前先写一条等价断言**（D8 覆盖）。
- `assertKindModelCoherent` 与 `src/agents/step-model.ts` 的调用点一并删除（它的唯一用途是
  「模型的 kind 与 preset 的 kind 不一致时拒绝」，kind 只有 pi 之后不存在不一致）。`PresetConfig.kind`
  字段保留但只接受 `"pi"`（由 D1 的响一次覆盖非 pi 值）。

**D3 — 删 `src/backends/legacy/**` 与 `test/legacy/**`。**
- `src/api.ts`：删 `:19-30`（deprecated herdr transport 段）、`:329-341`（legacy types 段）、
  `:194-200` 里的 `cursorModel`/`nativeModelFor`/`planKindStart`/`KindStartPlan`/`isPiShapedModel`。
- `test/unit/api.test.ts:9` 的 `createHerdrClient` 断言删除（**不是**改成 false，直接删这一行），
  其余 4 条断言保留。
- `test/unit/output-cap.test.ts`：只删 `:6` 的 import 与第 6 个 test（`:57-63` 附近），其余 5 个保留。
- `tsconfig.json:18` 的 `include` 覆盖 `test/**/*.ts`，所以 `test/legacy` 的删除必须与
  `src/backends` 的删除**同一个 commit**，否则 typecheck 必红。
- `package.json:56` 的 `test:docker` echo 文案里的 legacy 措辞改为中性（只改文案，命令不变）。

**D4 — `AGENT_KINDS` 收敛会打红 15 个测试文件，必须同批修复。**
完整清单（`rg -c` 实测命中数）：
`test/unit/step-model.test.ts`、`test/unit/presets.test.ts`、`test/unit/kind.test.ts`（整文件删）、
`test/unit/agents-listing.test.ts`、`test/unit/teams.test.ts`、`test/unit/status.test.ts`、
`test/unit/summary.test.ts`、`test/unit/agents.test.ts`、`test/unit/inprocess-supervisor.test.ts`、
`test/unit/context-injection.test.ts`（`planKindStart` 相关 2 个 test 删）、
`test/unit/presets-regression.test.ts`、`test/unit/notify.test.ts`、
`test/integration/orchestrator.test.ts`、`test/unit/agents-model.test.ts`、`test/unit/provider-pin.test.ts`。
- 非 pi kind 的 test 用例**直接删除**，不要改成 `assert.throws`（拒绝逻辑本身也不存在了）。
- `test/unit/agents-listing.test.ts:377,393` 的 `cannot be used with kind 'cursor'` /
  `dropped at launch: kind 'cursor' runs on its own default` 断言删除（`src/extension/slash.ts:279-292`
  的整段提示随 D2 一起删）。

**D5 — 删死掉的 `herdr.*` 设置面（保留 `run.herdr` 字段）。**
- 删：`src/agents/settings.ts:14`（import）、`:91-92`、`parseHerdrSettings` 全函数（`:119-185`）、
  `:480-481` 调用、`:817` 注释里的 `herdr`、`:866-868` 合并；
  `src/shared/types.ts` 的 `HerdrSettings`（`:519-533`）、`SubagentsSettings.herdr`（`:702-703`）、
  `DEFAULTS` 里 7 个 herdr 键（`:790-807`，改造后 `DEFAULTS` 只剩 `turnTimeoutMs`/`settleQuietMs`）、
  `ErrorCodes.HERDR_UNAVAILABLE`（`:769`）与 `ErrorCodes.PANE_BUSY`（`:772`）。
- **`RunRecord.herdr`（`types.ts:382-388`）保留原名不删**（活跃字段，改名是另一场改动）。
- 旧 settings 文件里残留 `subagents.herdr` 时：`parseHerdrSettings` 被删后该键**静默丢弃**
  （与 `parseInProcessLimits` 的「未知键忽略」一致）。**这是可接受的**，因为该块自 2.0.0 起已被忽略、
  且当前会打 deprecation 警告——警告随解析器一起消失。契约声明：**不做**新的「未知键报警」机制。

**D6 — 用户可见的 `herdr` 措辞清理。**
- `src/tui/status.ts:555` 的 widget 标题 `● Async agents · herdr` → `● Async agents`。
  **同步改 `test/unit/status.test.ts:195` 的断言**（这是硬编码字面量）。
- `src/extension/playbook.ts:19`：「using herdr pane/tab/agent commands for dispatch」→
  「launching child Pi processes by hand (use the subagent tool)」。该字符串会进 LLM 上下文，措辞要准。
- `src/extension/summary.ts:620` 的 `run.herdr.supervisor ?? "legacy"` → `?? "unknown"`。
- `herdrStatus` 字段（`src/tui/status.ts:36` 及 8 处读）**保留不删**：它是 `StatusEntry` 的
  `Pick<>` 成员，且 `test/unit/status.test.ts:296` 造数依赖；改名是另一场改动。

**D7 — #233：事件类型闭集 + 轮询容错，两件事都做。**
- (a) `node_abandoned` 加入 `src/legion/events.ts` 的 `LEGION_EVENT_TYPES`（现 14 → 15 项）。
  同步 `test/unit/legion-events.test.ts:20` 的 `assert.equal(LEGION_EVENT_TYPES.length, 14)`。
  `src/runs/hygiene.ts:275` 的 `RETAINED_EVENT_TYPES` 已含它，不动。
- (b) `src/extension/event-bus.ts` 的 `poll()` 容错：**一条毒行不得冻结游标**。要求：
  - `readEventsAfter` 抛出「未知类型 / 数据 JSON 损坏」这类**单行**错误时，游标**越过该行**并继续，
    `onError` 照常被调用（每个毒行报一次，不重复刷屏）。
  - 实现方式由 worker 定，但必须满足可验证性：★verifier 用真实 SQLite 造 3 行
    （`node_launched` / `node_abandoned` 快照行 / `phase_change`），断言
    `delivered === 2`、`cursor === 3`、`errors.length === 1`；
    再 poll 一次，断言 `errors.length` 仍为 1（不重复报）、`cursor === 3`（不自旋）。
  - **不要**改 `readEventsAfter` 的签名或让它静默吞错：`readEventsAfter` 的严格性（`test/unit/legion-events.test.ts`
    的 `assert.throws(appendEvent(..., "unknown" as never))`）必须保留。容错只发生在 poller。
  - **不要**在 `LegionEventBus.emit` 路径上加容错：那是进程内事件，类型由 TS 保证。

**D8 — #233 的回归测试要「翻转」，不要「删掉」。**
- `test/perf/event-bus.test.ts` 的最后一个 test（标题含 `REGRESSION (open defect)`）：
  标题改成不带 open-defect 的表述，断言翻转为「毒行之后的合法事件仍然送达」。
- 另在 `test/unit/legion-event-bus.test.ts` 增加一条**非 perf** 的容错回归（perf 套件不在 CI 里跑，
  这条必须进 CI）。可用 `makeClock()` 现有的假时钟模式。
- D2 的 `nativeModelFor("pi") === applyThinkingSuffix` 等价断言，加在删除 `nativeModelFor` **之前**跑一次
  即可（不要求留在仓库里）。

**D9 — 文档面最小改动，历史文档不重写。**
- **改（产品面，5 处）**：
  1. `README.md:87-89` —— 删「`kind !== "pi"` 会被拒」的整句。顺手修掉同段的悬空引用
     「see Isolation below」（README 无 `## Isolation` 标题）。**不要**改 `README.md:217` 的
     `legion_mail({ ..., kind? })`（邮件 kind，同名不同物）。
  2. `README.md:508-528` —— 章节标题改为 `## Supported kinds`（**保留** `herdr` 历史交代的正文），
     同步 `README.md:33` 的 Contents 项与 `CHANGELOG.md:439` 的锚点。整节重写为：
     「v4 只有 `kind: pi`；`kind` 仍是合法 frontmatter 键但只接受 `pi`；非 pi 值被忽略并按 pi 启动」。
  3. `docs/inprocess-supervisor.md:14`（fallback 触发条件去掉 non-pi）与 `:190-192`（Refusals 里的
     non-pi 条目删除）。
  4. `skills/pi-legion/SKILL.md:85-87` —— 这是**运行期注入 agent prompt 的文本**，优先级最高：
     把「Pi Legion v2 supports `kind: pi`; for a role that requires a non-Pi CLI, use the Herdr-era
     0.16.x release line」改成「Pi Legion runs `kind: pi` roles only」之类的现行表述。
  5. `CONTRIBUTING.md:110-113`（deprecated herdr 导出段）与 `:164-175`（Legacy Herdr / kind checks 段）：
     前者的 helper 已删，整段重写；后者指向已删的 `test/legacy/docker/verify-13-kinds.sh`，整段删除。
- **不改（历史设计文档）**：`docs/design.md`、`docs/legion-v2-contract.md`（除 §15 追加一条 REV）、
  `docs/legion-v2-delivery.md`、`docs/tui-viewer-contract.md`、`docs/contracts/spawn-default-inprocess-v3.md`、
  `docs/contracts/osc-busy-plugin.md`、`docs/performance-2026-10-19.md`。
  在 `docs/legion-v2-contract.md` 的 REV 表（`:448-460`）**追加一行** REV-13：`v4 收紧为仅 kind: pi；
  AGENT_KINDS 收敛为 ["pi"]；非 pi 值忽略并按 pi 启动`。
- **假阳性白名单（禁止改动）**：`docs/tui-viewer-contract.md` 的 `cursor`/`kind:` 全是文件游标与
  ChatItem 判别式；`docs/performance-2026-10-19.md` 的 `cursor` 全是事件游标；
  `docs/legion-v2-contract.md:173,313,355` 是邮件 kind；`docs/design.md:416` 是 artifact kind。

**D10 — 版本与 CHANGELOG。**
- `package.json` version → `4.0.0`，`package-lock.json:3,9` 同步（`npm install --package-lock-only`）。
- `CHANGELOG.md`：`## [Unreleased]` 下写成 `## [4.0.0] — 2026-10-19`，用既有 `### Breaking` 标题
  （唯一先例在 `CHANGELOG.md:379`），并补 `[4.0.0]:` 链接定义。
- **不推 tag、不发版**。发版由父会话在 review 通过后决定。

## 文件所有权（并行 writer 之间）

- **T1 writer（events，#233）**：`src/legion/events.ts`、`src/extension/event-bus.ts`、
  `test/unit/legion-events.test.ts`、`test/unit/legion-event-bus.test.ts`、`test/perf/event-bus.test.ts`。
  禁止触碰其它文件。
- **T2 writer（kind/backend 删除）**：`src/shared/types.ts`、`src/api.ts`、`src/runs/kind.ts`（删）、
  `src/runs/orchestrator.ts`、`src/agents/{agents,presets,step-model,settings,overrides}.ts`、
  `src/extension/{slash,summary,playbook}.ts`、`src/tui/status.ts`、`src/backends/**`（删）、
  `test/legacy/**`（删）、`test/unit/*`（除 T1 的四个文件）、`test/integration/orchestrator.test.ts`、
  `tsconfig.json`（不改内容，仅确认 include 仍成立）、`package.json:56` 文案。
  禁止触碰 `src/legion/**` 与 `src/extension/event-bus.ts`。
- **T3 writer（文档 + 版本）**：`README.md`、`docs/inprocess-supervisor.md`、`docs/legion-v2-contract.md`
  （仅 REV 表追加一行）、`skills/pi-legion/SKILL.md`、`CONTRIBUTING.md`、`CHANGELOG.md`、
  `package.json`（仅 version）、`package-lock.json`。
  禁止触碰 `src/**` 与 `test/**`。
- 三个 writer 的改动集**不相交**。T1 与 T2 都碰 `test/unit/`，但文件不重叠；T2 的清单里已显式排除 T1 的四个文件。

## 验收（每个 writer 的 verify，由父会话在本 worktree 执行）

T1：`npm run typecheck` && `npm test` && `npm run test:perf`
T2：`npm run typecheck` && `npm test` && `npm run test:integration` && `npm run test:mock-llm`
T3：`npm run typecheck`（文档不改代码，这道只保证 package.json 改动没打断类型检查）+ 父会话人工读改后的文档段。

**全绿判据**：`npm run typecheck` exit 0；`npm test` 0 fail；`npm run test:integration` 0 fail；
`npm run test:mock-llm` 0 fail；`npm run test:perf` 0 fail。用例总数会下降（删测试），
**只允许因删除非 pi kind 用例而下降，任何断言级失败都是 rejected**。

## 明确不做（防止越界返工）

1. **不删** `spawnMode` 的 `rpc`/`inprocess`，不删 `RoutingSupervisor`。
2. **不删** `AgentConfig.kind` 字段、`LegionNode.kind` 列、`RunRecord.herdr`、`StatusEntry.herdrStatus`。
3. **不删** `LEGACY_EXTRA_AGENT_DIRS_ENV`（`PI_HERDR_SUBAGENTS_EXTRA_AGENT_DIRS` 别名）——
   与 kind 无关，见 README:456 的「至少保留一个 minor」承诺。
4. **不改** `docs/design.md` 等历史文档的既有正文。
5. **不改** `readEventsAfter` / `appendEvent` 的签名与严格性。
6. **不推** tag、不发 npm。
