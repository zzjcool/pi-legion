# 冻结契约：spawn 默认翻转为 inprocess（v3.0.0）

状态：**FROZEN** — 实施中禁止偏离。发现矛盾立刻停下报告，不要自圆其说。

## 目标

`spawnMode` 缺省值从 `rpc` 改为 `inprocess`，且**不引入任何已知回归**。翻转默认是 breaking
change，因此本次发 `3.0.0`。

## 已实测的硬事实（禁止重新侦察）

| 事实 | 证据 |
|---|---|
| 默认常量唯一开关 | `src/supervisor/spawn-mode.ts:9` |
| 写角色卡写死 `worktree: true` | `agents/centurion.md:8`、`agents/worker.md:22`；`agents.ts:563-566` 对 `acceptance.role: writer` 自动补 |
| orchestrator 的 worktree 解析在 spawnMode 检查**之后** | `orchestrator.ts:549`(`inProcess`) vs `:575-583`(`worktree`) |
| `:550` 查**原始**字段，绕过 `worktree: false` 覆盖 | `orchestrator.ts:550`；优先级见 `src/runs/worktree.ts:34-45` |
| `:550`/`:584` 零测试覆盖 | grep `cannot combine with worktree isolation` 在 `test/` 无命中 |
| inprocess 无配置块 → `limits() === {}`（无上限） | `inprocess-supervisor.ts:322-331`，注释原文 `// No inprocess block → no limits (unlimited).` |
| in-process 子会话与父共享 `process.env`（值为**父的**，不是空） | 实测；`createAgentSession` 的 options 里 `env` 字段数 = 0 |
| `SessionManager.inMemory()` → `getSessionFile() === undefined` | `session-manager.js:1364-1365`；实测 |
| `SessionManager.open(空文件)` 成功且 `getSessionFile()` 正确 | 实测 |
| `globalThis[Symbol.for(k)]` 持有 ALS 经 jiti `moduleCache:false` 仍同一实例 | 实测：`childMod.store === shared → true`，父 ALS 值可被子模块读到 |
| `bindExtensions` 仅 rpc/print/interactive 模式调用，SDK session 不触发 `session_start` | `agent-session.js:2612-2619`；三个 mode 调用点 |

## 不变量（必须保持）

- **I1**：显式 `spawnMode: "inprocess"` + 解析后 `worktree === true` → 仍然 **loud throw** `INVALID_PARAMS`。仲裁只影响「缺省」。
- **I2**：`kind !== "pi"` + inprocess → 仍然 loud throw（`routing-supervisor.ts:73-78`、`inprocess-supervisor.ts:336-341`）。
- **I3**：RPC 路径行为**零变化**。`lineageEnv()`、`buildPiArgs`、`rpc-supervisor` 的 env 遮蔽逻辑不动。
- **I4**：`test/unit/inprocess-supervisor.test.ts` 现有 10 条必须全绿（尤其 `:172-186` maxActive 默认断言、`:188-228` 路由/跨后端同名校验）。
- **I5**：`test/unit/worktree.test.ts:52-58` 的 `resolveLaunchWorktree` 优先级不动。
- **I6**：禁止在 `spawnMode` 显式给值时做任何静默降级。

## 决策

### D1 — 默认常量
`DEFAULT_SPAWN_MODE: SpawnMode = "inprocess"`（`src/supervisor/spawn-mode.ts:9`）。
`resolveSpawnMode` 保持纯配置解析语义：**只返回意图**，不感知 worktree。

### D2 — 仲裁位置与形状（唯一实现点：`Orchestrator.launch`）
把 `const inProcess = isInProcessSpawn(input.agent)` 从 `:549` **移到 `:583` 之后**（`worktree`
const 结束处）。`:549` 与 `:583` 之间无 `inProcess` 使用点（仅 `:550`、`:564`、`:584`），移动是局部的。

仲裁逻辑（紧接移动后的位置）：

```ts
const explicitMode = input.agent.spawnMode !== undefined;
// 缺省 + 解析后需要 worktree / 非 pi → 回落 rpc。显式给值绝不降级。
const mode: SpawnMode =
    !explicitMode && worktree === true
        ? "rpc"
        : resolveSpawnMode(input.agent);
const inProcess = mode === "inprocess";
// 下游必须看到仲裁结果，否则 RoutingSupervisor 会独立重算并抛错。
// `worktree` 也必须归一化：角色卡上的 worktree:true 在本次发射「不需要隔离」时
// 会让 RoutingSupervisor(:79) / InProcessSupervisor(:342) 直接拒绝，即使 mode 已是
// inprocess 且解析结果 worktree===false。只改 spawnMode 不改 worktree 是错的。
const agent: AgentConfig = mode === input.agent.spawnMode && worktree
    ? input.agent
    : { ...input.agent, spawnMode: mode, ...(worktree ? {} : { worktree: false }) };
```

**硬约束（两条，缺一不可）**：
1. 仲裁结果必须**写回一个 agent 克隆**并同时传给 `reserveNode({agent})`（`:636`）和
   `spawnInput.agent`（`:652`）。否则 `routing-supervisor.ts:71` 会独立重算
   `resolveSpawnMode` 得到 `inprocess` 并在 `:79-84` 抛错，仲裁白做。
2. 克隆必须**同时归一化 `worktree`** 为本次发射的真实值（不需要隔离时写 `false`）。
   只写 `spawnMode` 会让 `{spawnMode:"inprocess", worktree:true}` 这个自相矛盾的组合
   流到 `routing-supervisor.ts:79` 与 `inprocess-supervisor.ts:342`，直接 `INVALID_PARAMS`。
   这正是 `centurion 派 worker` 主链路的形态（centurion 父 → `parentRole==="centurion"` →
   解析 worktree=false，而 `agents/worker.md` 写死 `worktree: true`），必须由该归一化兜住。

**注（`kind !== "pi"` 子句）**：`Orchestrator.launch` 在 `:545-548` 已对 `kind !== "pi"` 早抛，
因此仲裁里不再重复该条件（原契约写的 `|| input.agent.kind !== "pi"` 在本文件内不可达，属死代码）。
`kind !== "pi"` 的保护由 `:545-548` 早 guard 承担，不在本契约范围内变更其归属。

### D3 — 删除 `:550` 的原始字段门，统一到 `:584`
`orchestrator.ts:550-555`（`if (inProcess && (input.worktree === true || input.agent.worktree === true)) throw`）
**删除**。保留并复用 `:584` 的检查，改为基于仲裁结果：

```ts
if (inProcess && worktree) { throw ... }  // 只可能命中"显式 inprocess"
```

理由：D2 已保证「缺省 + worktree → rpc」，所以此处命中必为显式，I1 不受影响；同时修掉
`regressions.test.ts:148` 的 bug（调用方显式 `worktree: false` 被原始角色字段误拒）。
`:564` 的 `if (!input.utilityDispatch && !inProcess)` 保持原样（移到新位置后语义不变）。

### D4 — inprocess 安全默认限额（契约变更，必须同步改文档）
`InProcessSupervisor.limits()`（`inprocess-supervisor.ts:322-331`）改为：

```ts
private limits(): Required<Pick<InProcessLimits,"maxDepth"|"maxChildrenPerNode"|"maxActive">> & InProcessLimits
```

- **无 `subagents.inprocess` 块** → `{ maxDepth: 4, maxChildrenPerNode: 8, maxActive: 30 }`
  （镜像 `legion.*` 默认值：`types.ts:539-542`，`budget.ts:6-9`）。
- **有块但缺 `maxActive`** → 维持现状 `DEFAULT_INPROCESS_MAX_ACTIVE = 8`（I4 依赖这条，不得改）。
- 有块且显式给值 → 原值。
- `maxSpawnsPerSession` / `waitTimeoutMs` **不给默认**（与 RPC 列对称：RPC 侧无默认）。

理由：默认翻转后「无配置 = 无限递归派生」不可接受。这是**已记录**的契约变更，必须改
`docs/inprocess-supervisor.md:45-55` 与 `src/shared/types.ts:599-611` 的注释。

### D5 — `SpawnInput.env` 不被 inprocess 消费：以进程内上下文取代 env

**新增文件 `src/supervisor/child-context.ts`**（API 冻结，实现禁止改签名）：

```ts
import type { SpawnMode } from "../shared/types.ts";

/** 一个 in-process 子会话的血缘身份。绝不经过 process.env。 */
export interface ChildLaunchContext {
    /** 本子会话的 legion node id（根级 in-process 子会话为 undefined） */
    nodeId?: string;
    /** 父 node id */
    parentNodeId?: string;
    /** legion.db 绝对路径 */
    dbPath?: string;
    /**
     * Nested path segments — value equals the RPC `PI_SUBAGENT_PARENT_PATH`
     * (encodeNestedPath(childPath(name))), i.e. it ALREADY includes this child.
     * Currently unread; a future consumer must pass it straight to
     * Orchestrator's `deps.parentPath`, never append to it.
     */
    parentPath?: NestedPathEntry[];
    /** role 的 acceptance.role（read-only / writer / …） */
    acceptanceRole?: string;
    /** 是否允许该子会话再派子（对应 allowNestedSubagents） */
    allowNested: boolean;
    /** utility 硬叶子 */
    utility: boolean;
    /** 该子会话的 spawnMode（供子会话的 doctor/诊断自陈） */
    spawnMode: SpawnMode;
}

/** 在给定上下文下执行 fn；上下文经 globalThis+Symbol.for 持有，可跨 jiti 模块实例。 */
export function runInChildContext<T>(ctx: ChildLaunchContext, fn: () => Promise<T>): Promise<T>;
/** 当前异步上下文里的子会话身份；根进程/根会话返回 undefined。 */
export function currentChildContext(): ChildLaunchContext | undefined;
```

实现要求（已实测可行，不得改用手法）：

```ts
const KEY = Symbol.for("pi-legion.child-context.als");
const store: AsyncLocalStorage<ChildLaunchContext> =
    (globalThis as any)[KEY] ??= new AsyncLocalStorage();
```

**禁止**模块级 `const store = new AsyncLocalStorage()`（jiti `moduleCache:false` 会重新求值，
store 归零 —— 这是 `inprocess-depth.ts:8` 当前的 bug）。

`SpawnInput` 新增可选字段 `childContext?: ChildLaunchContext`（`src/supervisor/types.ts`）。
`InProcessSupervisor.spawnChild` 用 `runInChildContext(input.childContext, ...)` 包裹
**session factory + 首次 prompt**；`prompt`/`steer`/`followUp`/`abort` 同样在
`runInChildContext` 内派发（tool 执行发生在这些 await 链里，从而自动继承上下文）。

### D6 — `inprocess-depth.ts` 迁移到 globalThis 存储
公开 API 不变（`inProcessDepth()` / `runAtInProcessChildDepthAsync()`），内部 store 改为
`globalThis[Symbol.for("pi-legion.inprocess-depth.als")] ??= new AsyncLocalStorage<number>()`。
理由同上：当前模块级 store 在子模块实例里归零，导致 inprocess 深度上限每次重启。

### D7 — transcript 真实落盘（修「成功但零输出」）
`defaultSessionFactory`（`inprocess-supervisor.ts:238-298`）把
`sessionManager: SessionManager.inMemory()` 改为
`sessionManager: SessionManager.open(input.sessionFile, undefined, plan.cwd)`。

- 已实测：`open()` 对 `preCreateSessionFile` 建的空文件成功，`getSessionFile()` 返回该路径。
- 这样 `orchestrator.ts:899/1171` 的 `deriveOutcome(parseSessionFile(child.sessionFile))`
  能读到真实消息 → output/verdict/acceptance 恢复。
- `input.sessionFile` 已在 `InProcessSessionFactoryInput`（`:59`），无需改签名。

### D8 — child-guard 与身份消费端改读上下文（env 仅作 RPC 回落）

`src/extension/child-guard.ts`：
- 新增 `childGuardEnvFromContext()`：从 `currentChildContext()` 取 `acceptanceRole`。
- `childGuardEnvFromProcess()` 保持存在（RPC 路径用），但调用点改为
  `context 优先，env 回落`：`{ ...childGuardEnvFromProcess(), ...childGuardEnvFromContext() }`。
  实际实现即：先取 ctx，ctx 有 acceptanceRole 就用 ctx，否则用 env。

`index.ts`：
- `const isChild = process.env.PI_SUBAGENT_CHILD === "1" || currentChildContext() !== undefined;`
- `const allowNested = process.env[ALLOW_NESTED_ENV] === "1" || currentChildContext()?.allowNested === true;`
- `resolveLegionIdentity` 新增显式入参 `legionNode?: { dbPath: string; nodeId: string }`；有它时
  **优先于** `process.env[LEGION_DB_ENV]/[LEGION_NODE_ID_ENV]`，且 `sessionFile` 取
  `ctx.sessionManager?.getSessionFile()`（D7 保证非空）。in-process 子会话的 `session_start`
  不会自动触发，故在 `pi.on("session_start")` 之外，对 `currentChildContext()?.nodeId` 存在的
  情况**主动调用**一次 `initializeLegionRuntime({ cwd, sessionFile, legionNode })`。

**关键安全性质（写进注释）**：ALS 上下文不跨 `spawn()` 边界，因此 `bash npm test` 之类真实
子进程**无法**继承身份 —— 这正是 env 通道（`index.ts:375-381` healthy ghost nodes 事故）缺的
隔离性。禁回退到 env 注入。

### D9 — 版本与文档
- `package.json` version → `3.0.0`。
- `CHANGELOG.md`：`## [Unreleased]` 下新增 `### Changed` 条目说明默认后端变更（breaking），
  并按既有格式补 `[3.0.0]` 比较链接。
- `docs/inprocess-supervisor.md`：改标题下的默认说明、`:9` 表格、`:23` 注释、`:45-55` 限额
  契约（D4）、新增「身份通道 = 进程内上下文」小节。
- `src/shared/types.ts:49`、`:158`、`:599-611` 注释同步。
- `README.md` 补 `spawnMode` 与默认值（当前全文 0 次出现，属文档缺口）。
- `docs/headless-child-contract.md:13` 的 "rpc only" 措辞需限定为「RPC 后端下 rpc only」，
  注意 `test/unit/headless-child-contract.test.ts:15` 用 `/rpc only/i` 锁字符串 —— 保持该
  正则仍能匹配。

## 测试要求（新增，缺一不可）

| 测试 | 断言 |
|---|---|
| `spawn-mode` 缺省仲裁 | 缺省 + `worktree:true` → rpc；缺省 + `worktree:false` → inprocess |
| **克隆自洽（critical 回归）** | 用**真实** `RoutingSupervisor`（非 FakeSupervisor）：centurion 父 + `worktree:true` 角色 + 缺省 mode → 必须**不被 guard 拒绝**（越过 `routing-supervisor.ts:79`）；`launch({worktree:false})` 覆盖 `worktree:true` 角色 → 同上 |
| 显式保护（I1） | 显式 `spawnMode:"inprocess"` + 解析后 `worktree:true` → throw `INVALID_PARAMS`，文案 `/cannot use worktree isolation/` |
| 显式覆盖（原 bug） | `agent({worktree:true})` + `launch({worktree:false})` → 成功且 `worktreePath === undefined`（**必须用真实 router**，FakeSupervisor 不校验此组合） |
| inprocess 默认限额 | 无 `inprocess` 块时深度 5 被拒且文案含 `nesting limit` |
| 身份隔离 | `runInChildContext` 内 `currentChildContext()` 有值；外部为 `undefined`；嵌套两层各自正确 |
| guard 回落 | ctx 有 `acceptanceRole: "read-only"` 时 `rm -rf` 被拒；无 ctx 时走 env |
| transcript 落盘 | in-process 子会话结束后 `parseSessionFile(sessionFile)` 有消息（`deriveOutcome.status !== "unknown"`） |

**测试真实性硬要求**：凡断言 `spawnMode × worktree` 组合的行，必须用真实 `RoutingSupervisor`
或在测试内复现同源判据。`test/helpers/fake-supervisor.ts` **不校验**该组合（已确认），用它断言
这组行为等于假绿。

## 非目标（明确不做）

- 不做 RPC 侧的 in-process bwrap/sandbox 隔离。
- 不实现 inprocess 的 OSC `emitBusy`（保持 stub）。
- 不把 `lineageEnv` 改写为上下文（RPC 也要用 env）。
- 不改 `MAX_NESTED_PATH_ENTRIES = 4`。
- 不动 verify-queue / retire 硬化逻辑。

## 文件所有权

| Worker | 独占文件 |
|---|---|
| W1 | `src/supervisor/spawn-mode.ts`（**仅** D1 常量）、`src/runs/orchestrator.ts`（D2/D3）、`test/unit/spawn-mode-settings.test.ts`（翻转后默认断言）、`test/unit/legion-integration.test.ts` + `test/integration/legion-tree.test.ts` + `test/integration/nesting.test.ts`（FIX=TEST：显式给 `spawnMode: "rpc"` 保住原语义）、`test/unit/spawn-mode-arbitration.test.ts`(新) |
| W2 | `src/supervisor/child-context.ts`(新)、`src/supervisor/inprocess-depth.ts`、`src/supervisor/inprocess-supervisor.ts`、`src/supervisor/routing-supervisor.ts`、`src/supervisor/types.ts`、`test/unit/inprocess-supervisor.test.ts`（扩展，I4 必须保持全绿）、`test/unit/child-context.test.ts`(新) |
| W3 | `src/extension/child-guard.ts`、`index.ts`、`src/shared/types.ts`（仅注释 D9）、`README.md`、`CHANGELOG.md`、`package.json`、`docs/inprocess-supervisor.md`、`docs/headless-child-contract.md`、`docs/subagents-teams.md` |

**共享但禁止任何 worker 改**：`test/helpers/*`、`src/runs/args.ts`、`src/runs/worktree.ts`、
`src/legion/*`、`src/supervisor/rpc-supervisor.ts`（I3：RPC 路径零变化）。

**集成顺序**：W1 → W2 → W3（W3 的 `index.ts` 本应引用 W2 导出的 `currentChildContext`，必须排最后）。

---

## REV 2 — review 后修订（2026-10-18）

首轮 review 判 `ok:false`（W1 2 critical、W2 1 critical + 6 major）。以下为契约修订，
**修订原因**：原契约在 D4/D5/D7 三处不足以保证其自身目标。rev2 条目优先级高于上文冲突处。

### REV2-1（D4 补漏）深度必须在「根链 prompt」路径上继承
`inProcessDepth()` 只在 `spawnChild` 的 `runAtInProcessChildDepthAsync` 内非零。生产里
orchestrator 对 turn 2+ 是从**根链**调 `supervisor.prompt(name, ...)`，此时深度恒为 0 →
`assertWithinLimits` 的 `nextDepth` 永远是 1 → `maxDepth:4` 永不触发 → **无限递归**。
「spawn → collect → 再 spawn」是 centurion 的常规循环，这是主路径不是边角。

**要求**：`inprocess-depth.ts` 新增并导出
```ts
export function runAtAbsoluteDepth<T>(depth: number, fn: () => Promise<T>): Promise<T>;
```
`dispatch` / `abort` / `waitSettled` 三处派发必须用**记录的绝对深度** `child.spawnDepth`
压回作用域（而不是 `inProcessDepth() + 1`）：
```ts
runAtAbsoluteDepth(child.spawnDepth, () => runInChildContext(child.context, () => ...))
```
`ChildRecord.spawnDepth`（`:197` 声明 / `:370` 唯一写入）当前是只写死字段，正是为此预留。

**测试**：必须覆盖「turn1 由 spawnChild 派发、turn2 由根链 prompt 派发、子在自己的 turn 里
再 spawn」时序，断言连续第 5 代被拒。只测首轮递归的用例不足以证明 D4。

### REV2-2（D4 第四分支）`inprocess: {}` 与部分块的语义
`parseInProcessLimits("{}")` 返回 `{}`（不是 `undefined`），会走「有块」分支。
**裁定（安全优先）**：有块但缺 `maxDepth`/`maxChildrenPerNode` 时，**同样**兜安全默认 4/8；
缺 `maxActive` 时兜 8。即三种缺省一律安全默认，禁止「部分块 = 部分无限」。
这是**已记录的契约变更**，`docs/inprocess-supervisor.md:55` 与 `src/shared/types.ts:599-611`
的 "Omitted fields are unlimited" 必须同步改写。

### REV2-3（D5 快照）`ChildRecord.context` 必须是深拷贝快照
禁止把调用方传入的对象（含 `parentPath` 数组）以活引用存进 `ChildRecord` —— 调用方复用模板对象
会让**已 spawn 子会话的后续派发身份**跟着变（A 的身份变成 B 的），正是 D5 要消灭的串身份。
**要求**：元素级深拷贝（`parentPath` 是对象数组，`[...path]` 仍会共享每个
`NestedPathEntry`）：`{ ...provided, ...(provided.parentPath ? { parentPath: provided.parentPath.map((e) => ({ ...e })) } : {}) }`，
并补一条「spawn 后修改调用方模板不影响已 spawn 子会话」的测试。

### REV2-4（D5 判别性测试）globalThis 存储必须有能证伪模块级实现的测试
`AsyncLocalStorage` 天然按 async chain 隔离，所以「并发两路互不串值」对
「globalThis vs 模块级」**零判别力**（用被禁止的模块级实现跑同一段逻辑输出完全一致）。
**要求**：用 `?reload=` 二次加载模块做行为断言 —— A 实例 `runInChildContext` 写入的值，
B 实例 `currentChildContext()` 必须读到。这才是 D5 的真实需求。

### REV2-5（D7 判别性测试）必须能区分 `inMemory` 与 `open`
现有用例只断言 `captured[0].sessionFile === input.sessionFile`，但 **master 的 `spawnChild`
本来就传这个字段**（`git show master:src/supervisor/inprocess-supervisor.ts` :360），把实现
回滚成 `inMemory()` 这条照样绿。
**要求**：新增集成级测试 —— 预创建 0 字节文件 → spawn → 子会话跑完一轮 →
`parseSessionFile(file)` 有消息且 `deriveOutcome(parsed).status !== "unknown"`。
（已验证可行：`open` 空文件当场补写 header，追加消息后 3 行全部可解析，`turns=1`。）

### REV2-6（stats 形状）真实 `AgentSession` 用量恒为 0
`stats()` 只读扁平键 `raw.tokensIn`，但真实 SDK 形状是 `tokens: {input, output}` / `cost`。
生产 `defaultSessionFactory` 返回真实 session → 用量恒 0，且 `orchestrator.ts:465-470`
先在 transcript 写入正确 usage 再被 `stats()` 覆盖为 0。
**要求**：
```ts
tokensIn: Number(raw.tokensIn ?? raw.tokens?.input ?? 0),
tokensOut: Number(raw.tokensOut ?? raw.tokens?.output ?? 0),
costUsd: Number(raw.costUsd ?? raw.totalCost ?? raw.cost ?? 0),
```

### REV2-7（注释与导出）
- `inprocess-supervisor.ts:4` / `:182` 两处注释仍写 `SessionManager.inMemory`，与 `:319` 相反 → 改。
- `ChildLaunchContext` / `InProcessSessionStats` 未从 `src/api.ts` 导出，但 `SpawnInput` 已公开新增该字段 → 补导出。
- `childLaunchContext` 未在 `src/supervisor/rpc-supervisor.ts` 的 build 输入 denylist 剔除 → 加进 denylist（身份不该流进 RPC 参数构建器）。
- `publishEvent` 同步调用父侧 `onEvent` 监听器时会带上子会话 ALS 身份 → 在根上下文里调用监听器。

### REV2-8（测试环境，父会话负责）
`package.json` 的 5 条 test 脚本未 unset `PI_SUBAGENT_ROLE` / `PI_SUBAGENT_ACCEPTANCE_ROLE`，
而 `scout-guard.ts:195` 在该变量存在时直接 return → **任何子 agent 里跑 `pnpm test` 都会
误报 8 条失败**（7 条 scout-guard + 1 条 agents-listing）。这污染了全部 worker 的 verify 门禁。
**由父会话在合并阶段统一修**，worker 不要动 `package.json`。
