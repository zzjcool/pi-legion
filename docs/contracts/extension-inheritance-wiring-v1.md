# 冻结契约：extension inheritance 接线（#280 的漏接线修复）

状态：**FROZEN** — 实施中禁止偏离。发现矛盾立刻停下报告，不要自圆其说。
范围：implementation-ready。本文件冻结接口、落点、禁令与验收。

## 0. 目标与不做的事

**目标**：让 5.0.0 已声明的策略「children inherit every host extension by default
(#280)」在运行时真正生效。当前 `discoverHostExtensions()` 全仓零调用，
`discoveredHostExtensions()` 恒为 `undefined`，`inheritedExtensions` 恒收到空 host
列表，策略层存在但等于空转。

**顺带修掉两个独立缺陷**（它们被空 discovery 掩盖，接线后会立刻显形）：

- `collectChildExtensions(agent, env)` 丢弃 `env`，导致 `PI_LEGION_CHILD_INHERIT_EXTENSIONS=0`
  对继承集无效（实测：`inheritedExtensions(agent, HOST, envOff)` → 0 条，但
  `collectChildExtensions(agent, envOff)` → 7 条）
- legion 自身可能被当作「宿主扩展」注入子会话，与 child-guard 形成双份加载

**non-goals（本契约明确不做）**：

- 不改 `role-tool-gates.ts:79` 的「inheritsExtensions 为 true 时静音」策略。接线成功后该策略
  才真正成立；若宿主确实缺某扩展，静音仍是既有独立缺陷，另立 issue。
- 不改 doctor 的 `!inheritGlobal` 模型探测短路（`legion-doctor.ts:569/597/607`）。接线后
  `inheritGlobal=true` 与「真的继承了」重新一致。
- 不修 `playbook.ts:14` / `docs/headless-child-contract.md` 等文案。文案与代码再次一致后
  这些描述自动成立。
- 不动 `--no-extensions` + 显式 `--extension` 的既有形状。rpc/inprocess 字节级对齐是
  冻结契约（`args.ts:249-255`、`inprocess-supervisor.ts:151-159`）。

## 1. 已确认事实（父会话已核对，**禁止重新侦察**）

| # | 事实 | 证据 |
| --- | --- | --- |
| F1 | `discoverHostExtensions()` 全仓零调用；`resetExtensionDiscoveryCache()` 同样零调用 | `src/runs/extension-inheritance.ts:128`、`:70`（唯一定义处） |
| F2 | `discovered` 唯一赋值点在 `discoverHostExtensions` 内部 | `extension-inheritance.ts:144` |
| F3 | `discoveredHostExtensions()` 是纯 sync getter，返回模块级 `discovered` | `extension-inheritance.ts:156-158` |
| F4 | `collectChildExtensions` 把 `discoveredHostExtensions() ?? []` 传给 `inheritedExtensions`，**未传 env** | `src/runs/args.ts:217` |
| F5 | `childInheritsExtensions` 默认返回 `true`；env 只能降不能升（`=1` 是 no-op） | `extension-inheritance.ts:51-61`（实测三种卡片形态下 env=1 与默认完全相同） |
| F6 | 实测 `moduleCache:false` 下模块级 `let` **跨 jiti 实例不可见**，且**同实例重复 import 也重执行**（executions: 2） | jiti 探针 P1/P1h（见侦察报告） |
| F7 | 默认缓存下同一模块实例可跨 jiti 实例共享（`B 看到 A 的 6 条`） | jiti 探针 P1-default-cache |
| F8 | 本仓另三处**故意**用 `globalThis+Symbol.for` 对抗 jiti 重载 | `src/supervisor/child-context.ts:11-24`、`src/supervisor/inprocess-depth.ts:6-26`、`src/supervisor/admission-queue.ts:25-31` |
| F9 | `/reload` → `clearExtensionCache()` → 入口模块重新 import → `discovered` 归零 | `agent-session.js:3010` → `resource-loader.js:352-359` → `loader.js:89-93`、`:461-490`（实测每次 reload 重新 transpile） |
| F10 | 同 cwd 下新建子 loader **复用**父模块实例；cwd 变化才 `clearExtensionCache` | 探针 P3m（`A==B same cwd -> shared: true`、`A==C diff cwd -> re-imported`） |
| F11 | 安装副本形态下 guard 路径 === discovered legion 条目（`path.resolve` 后相等），dedupe 合并成 1 条 | 探针 P2（`dedupeKeys equal? true`、`collectChildExtensions count: 1`） |
| F12 | 源码树自举形态下两者不等，出现**两个 legion factory**并报 tool 冲突 | 探针 P2h（`legion factories: 2`、`Tool "subagent" conflicts with /root/code/...`） |
| F13 | `extensionDedupeKey` 只做 `path.resolve`（builtin 除外） | `src/runs/args.ts:181-183` |
| F14 | `matchesExcludedExtension` 支持包名形式，`pi-legion` 匹配安装副本与源码树两种路径 | `extension-inheritance.ts:170-195` |
| F15 | `launch()` 774→1072 只有 2 个 await（`:1005`、`:1072`），均在同步准入块 `:938-955` 之后 | 探针 P4 + 源码 |
| F16 | 契约禁令：禁止让 `launch()` 的快路径多出任何 await | `docs/contracts/launch-admission-queue-v1.md:829` |
| F17 | `LaunchInput` 无 `signal`/`abort` 字段；`launch()` 内无 abort 读取 | `orchestrator.ts:180-196`；P4 |
| F18 | `RoutingSupervisor.spawnChild` 是唯一分派到两个后端的点，且**本身 async** | `src/supervisor/routing-supervisor.ts:128-160` |
| F19 | 唯一 spawn 漏斗是 `Orchestrator.launch` → `supervisor.spawnChild`（`:1072`） | `orchestrator.ts:774`、`:1072` |
| F20 | 存在 3 类不在 tool execute 帧内的 spawn 出口：postman 定时器、启动期团队恢复 microtask、launch 队列泵 | `legion-tools.ts:106-110`→`:184`→`index.ts:544`；`index.ts:642-649`→`:683`；`orchestrator.ts:1488`/`:1449-1452` |
| F21 | `pi list` 实测 320–920 ms；有 project 资源时内部会加载全部扩展（309 条 jiti 记录） | 探针 P4-timing |
| F22 | `discoverHostExtensions` 只 `execFile("pi",["list"])`，不 spawn 子 agent、不写 legion.db | `extension-inheritance.ts:128-152` |
| F23 | 失败也会被缓存成 `[]`，且 `if (discovered)` 对空数组为真 → 永不重试 | `extension-inheritance.ts:129`、`:143-151` |
| F24 | 会因 discovery 接上而变红的现有测试 | `test/unit/args.test.ts:43,40,128,185`；`test/unit/legion-doctor.test.ts:261`（详见 §6） |
| F25 | 脚本：`npm run typecheck` / `npm test` / `npm run test:integration` | `package.json:52-54` |

## 2. 决策（D 编号，reviewer 必读）

### D1 — 缓存迁到 `globalThis[Symbol.for]`

**判定**：`discovered` / `discovery` 从模块级 `let` 迁到
`globalThis[Symbol.for("pi-legion.extension-discovery")]` 上的一个 holder 对象。

**理由**：F6 实测证明模块级 `let` 在 pi 的真实 loader 配置（`moduleCache:false`）下跨 jiti
实例不可见、同实例重 import 也归零。若继续用模块级变量，子会话（cwd 不同时触发
`clearExtensionCache`，F10）内的 spawn 会读到空的 `discovered`，「父预热一次惠及全树」不成立。
F8 是本仓库已验证的同因先例。

**失败模式**：不做迁移 → 探针 P1-noCache 的形态（`B.discovered: undefined`）在生产复现，
修复只对「第一次 spawn」有效。

**验收**：A1、A2。

#### D1-a — holder 形状与复位语义

```ts
const STORE_KEY = Symbol.for("pi-legion.extension-discovery");

interface DiscoveryStore {
	/** Resolved list, or undefined until discovery completes. */
	discovered?: string[];
	/** In-flight promise, so concurrent launches share one `pi list`. */
	inFlight?: Promise<string[]>;
}

type StoreHolder = { [key: symbol]: DiscoveryStore | undefined };
const store = ((globalThis as unknown as StoreHolder)[STORE_KEY] ??= {});
```

`resetExtensionDiscoveryCache()` 必须 **清空同一个 holder 的字段**（`delete store.discovered;
delete store.inFlight;`），不得重新赋值 holder —— 否则父会话与子会话会指向两个不同对象
（F6 的直接后果），`reset` 在测试外的语义也会静默失效。

### D2 — 预热落点：`RoutingSupervisor.spawnChild`，不是 `Orchestrator.launch`

**判定**：在 `RoutingSupervisor.spawnChild` 顶部（`resolveSpawnMode` 之后、分派之前）
`await ensureHostExtensions()`。**不得**在 `Orchestrator.launch` 顶部预热。

**理由**：

- F16 是**已冻结契约的禁令**：`launch()` 快路径不得多出 await。F15 显示这段只有 2 个
  await 且都在同步准入块之后，插到准入块之前会破坏 A21（同 tick 8 步 fanout 的槽位预留）。
- F18：`RoutingSupervisor.spawnChild` 本身 async、已在 await 链上、且是唯一同时看见两后端的点。
- F19 + F20：`Orchestrator.launch` 是唯一 spawn 漏斗，`RoutingSupervisor.spawnChild` 是它唯一
  的下游分派点 —— 三类后台出口（postman 定时器 / 团队恢复 microtask / 队列泵）全部经过它，
  因此预热覆盖全部 spawn 路径。
- F21：预热最坏 920 ms 且只在**首次**发生（之后 holder 命中）。放在分派点不影响准入判定。

**失败模式**：放到 `launch()` → 违反 F16，A21 测试变红；放到 `index.ts` 的 tool execute →
漏掉 F20 的三类后台出口。

**验收**：A3、A4。

#### D2-a — `ensureHostExtensions` 契约

```ts
/**
 * Resolve the host's extension set once, for the whole process.
 *
 * Never throws and never rejects: discovery failure must not fail a launch
 * (F22/F23). Returns the resolved list, or `[]` when discovery failed.
 */
export async function ensureHostExtensions(env?: NodeJS.ProcessEnv): Promise<string[]>;
```

- 幂等：并发调用共享同一个 in-flight promise（与既有 `discovery ??=` 语义一致）。
- 已缓存则立即返回缓存（不跑 `pi list`）。
- **失败缓存策略变更**：`pi list` 失败时**不缓存空数组**，只清 in-flight，让下一次 spawn 重试。
  理由 F23：既有实现把 `[]` 永久缓存，一次瞬时失败会静默关闭继承直到进程重启。
- `env` 透传给 `execFile`（既有行为），但**缓存键不区分 env** —— 保持"进程内一份主机扩展集"语义。

**验收**：A5。

### D3 — env 透传修复

**判定**：`collectChildExtensions` 把 `env` 传给 `inheritedExtensions`。

```ts
...inheritedExtensions(agent, discoveredHostExtensions() ?? [], env),
```

**理由**：F4 实测 `PI_LEGION_CHILD_INHERIT_EXTENSIONS=0` 目前对继承集无效。接线后 doctor 里
按 env 构造的场景（`legion-doctor.test.ts` 多处）会连锁失败。

**失败模式**：不修 → opt-out 在生产无效，用户设 `=0` 却仍拿到全部宿主扩展（接线后）。

**验收**：A6。

### D4 — legion 自身从继承集排除

**判定**：`collectChildExtensions` 在合并前把 legion 自身从 inherited 集合里滤掉：

```ts
const inherited = inheritedExtensions(agent, discoveredHostExtensions() ?? [], env)
	.filter((ext) => !matchesExcludedExtension(ext, SELF_EXTENSION_NAME));
```

其中 `SELF_EXTENSION_NAME` 是包名常量（`"pi-legion"`）。child-guard 仍在
函数末尾**无条件**追加，因此本判定不影响 guard 的必然存在。

**理由**：F11 显示安装副本形态本来就会 dedupe 成 1 条；F12 显示自举形态会出现两个 factory
并报 tool 冲突（`Tool "subagent" conflicts with ...`）。自排除让两种形态都收敛到 1 条。

**不做的事**：不依赖 `extensionDedupeKey` 做路径归一化。F13 显示它只做 `path.resolve`，
无法识别"同一份代码的两个副本"（F12 实测 inode 不同）。

**验收**：A7。

### D5 — 不新增 await 到 `launch()`，不碰 doctor 策略

见 non-goals 与 F16。`legion-doctor.ts` 的 `extensionsForRole` 占位串
`"(all host-discovered extensions)"` 接线后重新成立，**不改**。

**验收**：A8（`launch()` 的 await 数量与位置不变）。

## 3. 文件归属（单 writer，禁止越界）

| 文件 | 允许的改动 |
| --- | --- |
| `src/runs/extension-inheritance.ts` | D1（holder 迁移）、D2-a（新增 `ensureHostExtensions`）；`discoverHostExtensions` 失败不缓存空数组 |
| `src/runs/args.ts` | D3（第 217 行补 env）、D4（自排除 + 常量） |
| `src/supervisor/routing-supervisor.ts` | D2（`spawnChild` 顶部 `await ensureHostExtensions()`） |
| `test/unit/extension-inheritance.test.ts` | A1、A2、A5 新增用例 |
| `test/unit/args.test.ts` | A6、A7 新增用例；修 F24 的 4 条 |
| `test/unit/legion-doctor.test.ts` | 修 F24 的 1 条（`:261`） |

**禁止改动**：`src/runs/orchestrator.ts`、`src/supervisor/inprocess-supervisor.ts`、
`src/supervisor/rpc-supervisor.ts`、`src/extension/legion-doctor.ts`（生产代码）、
`src/runs/role-tool-gates.ts`、`docs/contracts/launch-admission-queue-v1.md`。

## 4. 验收清单

| # | 断言 | 方式 |
| --- | --- | --- |
| A1 | 迁移后 `discoveredHostExtensions()` 仍能读到 `ensureHostExtensions()` 的结果 | 单测：`await ensureHostExtensions()` 后 `discoveredHostExtensions()` 非 undefined |
| A2 | `resetExtensionDiscoveryCache()` 清空的是**同一个** holder（不是换新对象） | 单测：reset 前拿到 holder 引用，reset 后 `discoveredHostExtensions()` 为 undefined 且引用不变 |
| A3 | `RoutingSupervisor.spawnChild` 在分派前 await 预热 | 单测：stub `ensureHostExtensions`，断言调用发生在 backend.spawnChild 之前 |
| A4 | 预热幂等：连续 2 次 spawn 只跑一次 `pi list` | 单测：计数 stub，断言恰好 1 次 |
| A5 | 预热失败不抛、不缓存空结果（第二次会重试） | 单测：stub execFile 先失败后成功，断言第 2 次调用拿到结果 |
| A6 | `collectChildExtensions(agent, {PI_LEGION_CHILD_INHERIT_EXTENSIONS:"0"})` 不含 inherited 条目 | 单测：primed discovery 后断言 |
| A7 | inherited 集合不含 legion 自身，但 child-guard 仍在末尾 | 单测：断言 `!list.includes(selfPath) && list.includes(childGuardExtensionPath())` |
| A8 | `orchestrator.ts` 的 774→1072 区间 await 仍只有 `:1005`（内容可漂）与 `spawnChild` 那一处 | `grep -c await` 对照 + 契约禁令 5 复核 |
| A9 | 全量单测绿 | `npm run typecheck && npm test && npm run test:integration` |
| A10 | 真实端到端：primed 后 `collectChildExtensions` 含宿主扩展（pi-lens 等） | 内联 `node -e` 探针，输出与 F11 形状一致 |

## 5. 实施顺序

1. D1 holder 迁移（不改变行为，先让缓存可跨实例）
2. D2-a `ensureHostExtensions`（含失败不缓存）
3. D3 env 透传 → D4 自排除（两处都在 `args.ts`，一次改完）
4. D2 预热点接入
5. 修 F24 的 5 条测试 + 新增 A1–A7

第 1 步之后跑一次 `npm test` 确认零红，再继续 —— 否则后续失败无法归因。

## 6. 已知会变红的测试（F24，必须一并处理）

| 测试 | 位置 | 变红原因 |
| --- | --- | --- |
| `buildPiArgs injects the child-guard extension` | `args.test.ts:30`，断言 `:43-45` | `--extension` 计数从 1 变 7；第一个值不再是 guard |
| 同上 `:39-41` | 取第一个 `--extension` 值 | 同上 |
| `#43 children get --no-extensions by default` | `args.test.ts:124`，`deepEqual` `:128` | 全量数组顺序敏感 |
| `#89 collectChildExtensions dedupes explicit builtin:codemode` | `args.test.ts:178`，`deepEqual` `:185-188` | 同上 |
| `#70 bundled worker does not promise lens tools` | `legion-doctor.test.ts:230`，断言 `:261` | discovered 含 `pi-lens/dist/index.js` |

**修复方式**：这些测试断言的是「discovery 为空时」的列表形状。改为**显式控制 discovery
状态**：在 `withEnv` 里额外 `resetExtensionDiscoveryCache()`，并对需要完整列表的用例断言
「inherited 条目存在 + guard 在末尾」而不是全量 `deepEqual`。

**禁止**：用 `excludeExtensions: ["*"]` 或伪造空 host 来让旧断言继续通过 —— 那是把 F24
的假设重新固化成契约。

---

## 7. 修订 R1（review 后追加，2026-10-26）

本节由 reviewer 审查 `fix/280-extension-inheritance-wiring` 后追加。**修订原因是实施中发现了
F1–F25 未能预见的两条真实缺陷**；F 事实表保持不变，A 清单在其后增量。

### R1-a — 目录形态的 `pi.extensions` 条目必须展开成可加载文件（critical）

**新事实**：

| # | 事实 | 证据 |
| --- | --- | --- |
| F26 | `pi-diff-review` 的 `package.json` 声明 `pi.extensions: ["./extensions"]`，该目录内只有 `review.ts`、无 `package.json`/`index.ts` | `node -e require('.../pi-diff-review/package.json').pi` + `ls` |
| F27 | `resolveExtensionEntries` 对声明条目只做 `existsSync` 过滤，**不过滤目录** | `extension-inheritance.ts:130-134`（接线后实测 `非文件条目: [".../pi-diff-review/extensions"]`） |
| F28 | 真实 `pi -e <该目录> --print` → **exit 1**（`Failed to load extension: Cannot find module`）；换成 `-e <该目录>/review.ts` → **exit 0** | 实测两次退出码 |
| F29 | in-process 后端不致命但静默丢弃：`DefaultResourceLoader({additionalExtensionPaths:[该目录]})` → `errors: 1, loaded: 0`，且 `inprocess-supervisor.ts` 只 warn `pendingProviderRegistrations`，读不到 `getExtensions().errors` | SDK 探针 |

**判定**：`resolveExtensionEntries` 必须把目录条目展开成其内可加载的 `*.ts|*.js`，
镜像 pi 自己的 loader 行为；展开为空则丢弃该条目。

**为什么这不违反 non-goal 5**：non-goal 5 指「不修 `pi.extensions` 写成目录而非文件」这个
**拼写选择**。本节不改变那个选择，只保证交给 `-e` 的东西可加载。接线前该缺陷不可达（F3），
接线后它变成「每个用 pi-diff-review 的 rpc 子会话启动失败」，属改动自身引入的回归。

**新增验收**：

| # | 断言 |
| --- | --- |
| A11 | `pi.extensions: ["./extensions"]` 且目录内只有 `review.ts`（无 index/package.json）→ 解析结果是 `.../extensions/review.ts`，不是目录 |
| A12 | `pi.extensions` 指向空目录 → 该条目被丢弃，不出现在 argv |
| A13 | `collectChildExtensions` 返回值中**不存在**非文件路径（用 `statSync().isFile()` 全量断言） |

### R1-b — 预热点必须覆盖直连 `RpcSupervisor` 的公开路径（major）

**新事实**：

| # | 事实 | 证据 |
| --- | --- | --- |
| F30 | `api.ts:13` 的文档示例是 `new Orchestrator({ supervisor: new RpcSupervisor(), ... })`，绕过 `RoutingSupervisor` | 读 `src/api.ts:8-20` |
| F31 | `Orchestrator` 构造函数的 supervisor 默认值也是裸 `RpcSupervisor` | `orchestrator.ts:453` |
| F32 | `index.ts` 的 5 处 `new Orchestrator` **全部**传 `input.supervisor`（来自 `RoutingSupervisor`），故自举形态覆盖正常 | `grep -A6 "new Orchestrator" index.ts`（736/1832/1930/2422/3116） |

**判定**：预热点从 `RoutingSupervisor.spawnChild` **下沉**到两个后端各自的
`spawnChild` 顶部（`InProcessSupervisor.spawnChild`、`RpcSupervisor.spawnChild`）。
理由：这是无论调用方走 router 还是直连后端都必须经过的点，且两者本身都是 async。
`RoutingSupervisor.spawnChild` 的预热**保留**——它能在参数校验失败前就暖好缓存，
且 router 路径下第一次调用会命中已暖的 holder（幂等，无额外 `pi list`）。

**为什么不放 `Orchestrator.launch`**：F16 禁令不变，`launch()` 快路径不得新增 await。

**新增验收**：

| # | 断言 |
| --- | --- |
| A14 | 直接 `new RpcSupervisor()` + `new Orchestrator({supervisor})` 后 `launch()`，`discoveredHostExtensions()` 非 undefined |
| A15 | 同上，in-process 后端 |
| A16 | 幂等不变：router 路径下连续 2 次 spawn 仍只 1 次 `pi list` |

### R1-c — 驳回的 finding（记录以免重复争议）

reviewer 报的 minor「自排除会误吃 `acme/src/legion/index.ts`」**不成立**：
自排除常量是 `"pi-legion"`，`matchesExcludedExtension` 的 `dir === target` /
`file === target.ts` 兜底只在目录/文件名恰为 `pi-legion` 时触发。实测 5 条路径，
仅真正的 `node_modules/pi-legion/index.ts` 被丢：

```
kept    /host/node_modules/acme/src/legion/index.ts
kept    /host/node_modules/acme/extensions/legion.ts
kept    /host/node_modules/acme-legion/index.ts
kept    /host/node_modules/acme/legion-ext/index.ts
DROPPED /host/node_modules/pi-legion/index.ts
```

reviewer 用错了包名（拿 `legion` 当 target）。**不修。**

### R1-d — 修订后的文件归属

在 §3 基础上**新增允许改动**：

| 文件 | 允许的改动 |
| --- | --- |
| `src/runs/extension-inheritance.ts` | R1-a 的目录展开（`resolveExtensionEntries`） |
| `src/supervisor/inprocess-supervisor.ts` | **仅** R1-b：`spawnChild` 顶部 `await ensureHostExtensions()` |
| `src/supervisor/rpc-supervisor.ts` | **仅** R1-b：`spawnChild` 顶部 `await ensureHostExtensions()` |
| `test/unit/extension-inheritance.test.ts` | A11–A13 |
| `test/unit/routing-supervisor*.test.ts` 或 `test/unit/orchestrator*` 就近文件 | A14–A16 |

§3 的其余禁区不变（`orchestrator.ts` 仍禁止改，含 `launch()`）。

---

## 8. 修订 R2（第二次 review 后追加，2026-10-26）

由 `rev-r1` 复审 `8cf2aba` 后追加。R1 的两条修复方向正确，但**镜像 pi loader 的目标未达到**，
且三处预热点在失败路径上互相叠加。以下为增量事实与决策。

### R2-a — 目录展开必须镜像 `collectAutoExtensionEntries`（major）

| # | 事实 | 证据 |
| --- | --- | --- |
| F33 | pi 处理 manifest 声明的目录走 `collectAutoExtensionEntries`，对每个**子目录**再调 `resolveExtensionEntries`，因此 `extensions/<name>/index.ts` 是官方文档化布局 | `package-manager.js:407-462`；`loader.js:623-631` 注释「规则 2: Subdirectory with index」 |
| F34 | 本实现在同一 fixture 上返回 `[]`：`extensions/alpha/index.ts` + `extensions/beta/index.ts` 全部静默丢失 | 实测 `resolveExtensionEntries("/tmp/extprobe/pkg")` → `[]` |
| F35 | `discoverExtensionFiles` 的注释自称「Deliberately one level」，理由是「嵌套包不需要，递归会把错拼路径变成无界遍历」 | `extension-inheritance.ts:160-168` |
| F36 | 同一实现把 `extensions/.eslintrc.js` **收进**结果；pi 的 `collectAutoExtensionEntries` 显式跳过 `.` 开头与 `node_modules` | `extension-inheritance.ts:176`；`package-manager.js:407-462` |
| F37 | 但 `pi -e <点文件>` 实测 **exit 0**（不是 exit 1），故 F36 的后果是「多传一条无用条目」而非启动失败 | 实测 `.eslintrc.js` → EXIT=0；`alpha/index.ts` → EXIT=0 |

**判定（R2-a）**：`discoverExtensionFiles` 改为与 pi 同形：

- 跳过 `.` 开头的条目与 `node_modules`
- 文件且 `*.ts|*.js` → 收
- **子目录** → 调 `resolveExtensionEntries(child, false)`，收到结果就收，收不到就跳过

F35 的「无界遍历」担忧用**深度上限**解决：`resolveExtensionEntries(dir, allowNestedManifest)` 的
第二个参数（已存在）作为递归闸门，嵌套层只允许一层子目录解析，子目录内部不再继续递归。
这与 pi 的行为一致（pi 也只递归一层：`collectAutoExtensionEntries` → `resolveExtensionEntries`
→ 不再往下）。

**新增验收**：

| # | 断言 |
| --- | --- |
| A17 | `extensions/alpha/index.ts` + `extensions/beta/index.ts`（无 manifest/index 于 extensions 根）→ 两条结果都出现 |
| A18 | `extensions/.eslintrc.js` 不被收进结果 |
| A19 | 子目录内还是目录（`extensions/x/y/index.ts`）→ 不递归收，结果为空（或只收 `x` 层能解析到的） |

### R2-b — 预热点在失败路径上必须幂等（major）

| # | 事实 | 证据 |
| --- | --- | --- |
| F38 | `ensureHostExtensions` 失败时不缓存（F23 的刻意设计，保留），故每次调用都会重跑 `pi list` | `extension-inheritance.ts:292-313` |
| F39 | 三处预热点（router + rpc 后端 + inprocess 后端）叠加后，router 路径一次 spawn 会 warm 两次：router 一次（失败）+ 后端一次（再失败） | 实测三次连续 `ensureHostExtensions` → `[[],[],[]]` |
| F40 | 失败时每个 spawn 恒付 2× 探测成本（真实 0.3–1.8s；`pi list` 超时时最坏 +30s），且发生在内存门之前 | `rev-r1` 实测（fake `pi` 500ms → spawn#1 1035ms / spawn#2 1026ms） |
| F41 | A16 的字面断言「router 路径连续 2 次 spawn 仍只 1 次 `pi list`」只在成功路径成立 | 同上 |

**判定（R2-b）**：引入**同 spawn 短路标记**，不动「失败不缓存跨 spawn 可重试」的语义：

```ts
/**
 * Mark the current spawn attempt as already-warmed, so the backend's warm call
 * does not repeat a FAILED `pi list` that the router just paid for.
 *
 * Scope: one spawn attempt. Reset when the outermost warm returns.
 */
```

实现方式（选一，实施者择简）：

- **(a) 传入标记**：`ensureHostExtensions(env, { spawnScoped?: boolean })`；`RoutingSupervisor`
  调用后设置一个同步可见的 `recentlyWarmed` 时间戳/布尔，两个后端在**同一 tick 内**看到就短路。
- **(b) 失败短 TTL**：失败时把 `failedAt = Date.now()` 记进 holder，`ensureHostExtensions` 在
  `FAILURE_TTL_MS`（如 5s）内直接返回 `[]` 而不重跑。跨 spawn 的最坏情况变成「首次失败后 5s 内的
  spawn 都不重试」，比现状好，且仍满足 F23「不是永久关闭」。

**倾向 (b)**：实现最小（holder 加一个字段），无需在 router 与后端之间传状态，也不改变
`ensureHostExtensions` 的签名（A14/A15 的测试不用重写）。TTL 值必须是命名常量并注释理由。

**新增验收**：

| # | 断言 |
| --- | --- |
| A20 | `pi list` 失败下，router 路径一次 spawn 只跑 **1** 次 `pi list`（不是 2） |
| A21 | 失败后超过 `FAILURE_TTL_MS`，下一次 spawn 会**重试**（可恢复性未被永久关闭） |
| A22 | 成功路径行为不变：连续 2 次 spawn 仍只 1 次 `pi list`（既有 A16 保持绿） |

### R2-c — 测试注释必须如实（minor）

`test/unit/extension-inheritance.test.ts:601-604` 的注释声称断言集合是「fake host **PLUS the
live `pi list`**」，但 `withPathEnv` 执行的是 `process.env.PATH = pathValue`（**完全替换**，
`test/unit/extension-inheritance.test.ts:235`），真实 `pi list` 从未运行。

**判定**：删掉「PLUS the live `pi list`」这半句。**不得**为此新增不做 PATH 遮蔽的用例 ——
那会让测试依赖本机安装的包，不可移植。

### R2-d — 修订后的文件归属增量

在 §7 R1-d 基础上，**新增允许改动**：

| 文件 | 允许的改动 |
| --- | --- |
| `src/runs/extension-inheritance.ts` | R2-a 的 sweep 重写、R2-b 的失败 TTL |
| `test/unit/extension-inheritance.test.ts` | A17–A21、R2-c 的注释删除 |
| `test/unit/routing-supervisor*.test.ts` 或就近文件 | A20 |

`src/runs/orchestrator.ts`、`src/extension/legion-doctor.ts`、`src/runs/role-tool-gates.ts`、
`docs/contracts/launch-admission-queue-v1.md` 仍为禁区。

### R2-e — 降级与驳回记录

- **降级**：`rev-r1` 的 minor「点文件导致 `pi -e` exit 1」论据不成立（实测 EXIT=0）。
  但「点文件不该被收」仍成立（pi 自己会跳过，多传一条无用条目）→ 并入 R2-a 的 A18。
- **保持驳回**：§7 R1-c 的「自排除误吃 `acme/src/legion/index.ts`」仍不成立，勿再报。

---

## 9. 修订 R3（#317 诊断改动，2026-10-28）

本节只补**可见性与诊断**。§2 D2-a 的 never-reject 契约、§8 R2-b 的 `FAILURE_TTL_MS` 退避、
以及继承策略本身（D3/D4/D5）**均未改变**：失败仍然不抛、不缓存 `[]`、仍按 TTL 重试。
F/A 表继续有效，以下为增量。

### R3-a 事实（本轮实施前核对）

| # | 事实 | 证据 |
| --- | --- | --- |
| F42 | 失败探测只写 `failedAt` 时间戳，全仓无任何日志；`resolveHostExtensions` 在 catch 里丢弃错误（含 `pi list` 的 stderr） | `src/runs/extension-inheritance.ts`（改前 `catch { return undefined; }`） |
| F43 | `collectChildExtensions` 用 `discoveredHostExtensions() ?? []`，于是「发现失败 / 宿主真为空 / 从未探测」三者对下游都是 `[]` | `src/runs/args.ts:217` |
| F44 | doctor 对 inherit 角色只输出占位串 `(all host-discovered extensions)`，三种状态不可区分 | `legion-doctor.ts` `extensionsForRole` |
| F45 | `PI_LEGION_CHILD_EXTENSIONS` 对 inprocess **同样生效**：`inprocess-supervisor.ts:176` → `collectChildExtensions` → `childExtraExtensions(env)` | 读源码，与 rpc 共用同一收集函数 |
| F46 | `INPROCESS_MODEL_HINT` 仍推荐 `inheritExtensions: true` / `PI_LEGION_CHILD_INHERIT_EXTENSIONS=1`；接线后前者是默认策略、后者是 no-op | `spawn-hints.ts` |

### R3-b 决策（D6–D9）

**D6 — 失败告警一次，且仍不 reject。** 探测失败时写 `failedAt` 并发一条 `[legion]` 前缀告警，
内容含 ≤`DISCOVERY_STDERR_LIMIT`（200 字符）的 `pi list` stderr 摘要；stderr 为空时按
**exit code → `error.message`** 顺序退化（code 在 message 之前，因为 `execFile` 的 `message` 恒为
`Command failed: pi list`，message 优先会让 code 分支不可达），最后才落到兜底句，绝不抛。
`failedAt` 兼任「已告知」位：stamp 存在时后续失败不再刷屏。

**告警上界是「每进程一次」，不是「每个 episode 一次」**（review 后修订）：成功探测把结果写进
`discovered` 并永久短路后续探测，所以生产路径上不存在「恢复后再次失败」——唯一的回退手段是测试
seam `resetExtensionDiscoveryCache()`，它同时清掉 stamp，等价于重新开始。故措辞与代码都按
「每进程最多一条」表述（D6 旧措辞「恢复后再失败会再告警一次」已删除）。
**不新增任何持久化字段**，告警体自身也裹 try/catch —— 告警失败不得使 launch 失败。

**D7 — 只读内省。** 新增 `hostExtensionDiscoveryState(): { status: "ok" | "failed" | "unknown"; count: number; at?: number }`。
`unknown` = 本进程从未探测；`ok` + `count: 0` = 探测成功但宿主确实没有包扩展；`failed` 带 `at`
（上次失败时刻）。`discoveredHostExtensions()` 签名不变。该 getter 是纯内存读，**绝不触发探测**。

**D8 — doctor 新增一行。** `## Extensions` 段输出
`- discovered host extensions: N (last probe: ok | failed <n>s ago | never)`；`failed` 带距今秒数。
doctor 自身不探测（否则每次 doctor 都要付 0.3–0.9 s 的 `pi list`），所以 `never` 如实表示
「本进程还没探测过」，而不是「宿主为空」。

**D9 — spawn 提示只推荐仍然有效的杠杆。** `INPROCESS_MODEL_HINT` 改为只推荐
`PI_LEGION_CHILD_EXTENSIONS=<path>` 与把 provider 静态声明进 `models.json`，保留
`/legion doctor` / `subagent action=diagnose` 指引；当
`hostExtensionDiscoveryState().status !== "ok"` 时追加一句
`inheritance is enabled but host discovery is <failed|never probed> — the child got 0 host extensions`。
注入方式：`spawnFailureHint` 新增可选入参 `discoveryStatus`（保持纯函数、不做 IO；缺省读内存态，
生产路径 `enrichFailureWithAutoDoctor` 无需改动即可获得该提示）。`ok`（含 count 0）不追加。
该 note **对每个分支都追加**（inprocess / rpc `--no-extensions` / rpc 无 `--no-extensions`），
因此任何分支都不得再推荐 `inheritExtensions` / `PI_LEGION_CHILD_INHERIT_EXTENSIONS=1` —— 否则
同一条提示会自相矛盾（review 后修订，见 R3-e）。

### R3-c 验收增量

| # | 断言 |
| --- | --- |
| A23 | 失败探测只告警一次；同窗口重复调用不再探测也不再告警；跨 `FAILURE_TTL_MS` 重试仍不重复告警 |
| A24 | 空 stderr 的失败仍告警、不抛、且消息里不出现 `undefined` |
| A25 | `hostExtensionDiscoveryState()` 区分 `ok`(count N 与 count 0)、`failed`（带 `at`）、`unknown` |
| A26 | doctor 输出在 fake `pi list` 失败 / 成功 / 未探测三种状态下分别含 `failed \d+s ago` / `ok` / `never`，且 doctor 不额外探测 |
| A27 | `INPROCESS_MODEL_HINT` 不再出现 `inheritExtensions` 与 `PI_LEGION_CHILD_INHERIT_EXTENSIONS=1`，且含 `PI_LEGION_CHILD_EXTENSIONS=<path>`、`models.json` |
| A28 | discovery 为 `failed` / `unknown` 时提示含 `the child got 0 host extensions`；`ok` 时不追加 |
| A29 | **真生产路径**：fake `pi list` 失败 → `ensureHostExtensions()` → `spawnFailureHint({stderr, spawnMode:"inprocess"})`（**不传** `discoveryStatus`）含 `host discovery is failed`；且 `import("…extension-inheritance.ts?fresh=1")` 重新求值的实例读同一 `globalThis` holder（`hostExtensionDiscoveryState().status === "failed"`）。**#329 修订**：原文写「同一断言对 `?fresh=1` 重新求值的 **spawn-hints** 模块实例同样成立」，那是空转——ESM 解析相对说明符时丢弃 query，`spawn-hints.ts?fresh=1` 内部的 `./extension-inheritance.ts` 仍解析到**同一个**已缓存实例，底层 store 换成模块内对象也能绿；故改为对 holder 的拥有者模块 `extension-inheritance.ts` 本身重新求值 |
| A30 | `describeProbeFailure` 退化链钉住：空 stderr + exit 4 → `pi list exited 4`；无 `pi`（`ENOENT`，非数字 code）→ `spawn pi ENOENT` |
| A31 | rpc `--no-extensions` 分支不再出现 `inheritExtensions` / `PI_LEGION_CHILD_INHERIT_EXTENSIONS=1`，`PI_LEGION_CHILD_EXTENSIONS` 仍在句首 |

### R3-d 文件归属增量

`src/runs/extension-inheritance.ts`、`src/extension/legion-doctor.ts`、
`src/extension/spawn-hints.ts`、`test/unit/{extension-inheritance,legion-doctor,spawn-hints}.test.ts`、
`CHANGELOG.md`、本节。`src/runs/args.ts` 在允许清单内但**本轮无需改动**（诊断信息从 discovery
模块直接读出，不改 `?? []` 的消费形状）。

### R3-e 刻意不做（避免重复争议）

- 不改 `#212` 的「inprocess 不给 **argv** 建议」结论：argv 建议仍不出现。但
  `PI_LEGION_CHILD_EXTENSIONS` 不是 argv（F45），inprocess 同样生效，故 #317 起明确推荐它，
  并把旧断言 `doesNotMatch(PI_LEGION_CHILD_EXTENSIONS)` 改写为「不得出现 argv 建议」。
- ~~rpc 分支提示保留既有措辞~~（**review 后修订**）：本 PR 把 discovery note 注入了 rpc 分支，
  而该分支仍推荐 `inheritExtensions: true` / `PI_LEGION_CHILD_INHERIT_EXTENSIONS=1`，同一条提示
  自相矛盾（note 说的是「继承已开但 discovery 失败 → 子节点 0 条扩展」）。故删掉该子句，
  `PI_LEGION_CHILD_EXTENSIONS` 与 role `extensions:` 仍保留（A31）。
- 不做主机级 retry daemon、不改 `FAILURE_TTL_MS`、不改继承/排除策略。
- 不新增用例覆盖「恢复后再失败」（生产不可达）：可达路径只有测试 seam reset（见 D6），加用例等于把
  合成路径固化成契约；改为在 D6/代码注释/CHANGELOG 里如实表述。~~不把「每进程一次」的告警上界写成测试~~
  （**#329 修订**）：原文这句话与既有断言不符——「重复失败不刷屏」已由
  `test/unit/extension-inheritance.test.ts:859` 钉住，未覆盖的只是「恢复后再失败」这一条。
