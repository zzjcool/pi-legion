# 冻结契约 — issue #209 三个 PR（2026-10-18，基线 master@d5b9d74 / 3.0.2）

本文件是三个并行 worker 的唯一接口约定。**不得自行解释或扩展**；与本文冲突的任务卡视为错误，向父会话报告而非就地改造。

## PR 划分与文件所有权（硬边界）

| PR | 主题 | 你的文件（只能改这些） |
|---|---|---|
| **A / #209-1** | inprocess 无法解析扩展注册的 provider | `src/supervisor/inprocess-supervisor.ts`, `test/unit/inprocess-supervisor.test.ts` |
| **B / #209-2** | `supervisor=rpc` 硬编码，不反映真实后端 | `src/shared/types.ts`, `src/extension/runtime.ts`, `src/runs/orchestrator.ts`, `index.ts`, `src/extension/summary.ts`（仅在必要时）, `test/unit/teams.test.ts`, `test/unit/runtime.test.ts`, `test/unit/legion-status.test.ts`, `test/unit/store.test.ts`, `test/unit/summary.test.ts` |
| **C / #209-3** | foreign 死 child 报 `state=working`；stop 不可达 | `index.ts`, `src/extension/runtime.ts`, `test/unit/status-action.test.ts`, `test/unit/runtime.test.ts` |

**冲突已知并接受**：B 与 C 都改 `index.ts` 与 `src/extension/runtime.ts`，但落在不同函数、不同行区间。父会话负责合并时解决冲突。**不要**为了让两方"不冲突"而擅自重命名或搬移对方代码。

## 冻结决策（D 编号）

### D1 — A 的模型解析修复形状
`defaultSessionFactory` **保持**现有 `new DefaultResourceLoader(...)` + `createAgentSession(...)` 结构不变（systemPromptOverride 等定制不动）。只插入一个显式 drain：

1. 从 `inprocess-supervisor.ts` 导出新函数
   ```ts
   export function drainExtensionRegistrations(
     resourceLoader: { getExtensions(): { runtime: ExtensionRegistrationQueues } },
     modelRuntime: ModelRuntimeLike,
   ): Promise<DiagnosticLike[]>
   ```
   - 依次消费 `runtime.pendingProviderRegistrations`（`registerProvider(name, config)`）、`pendingNativeProviderRegistrations`（`registerNativeProvider(provider)`）、`pendingVirtualModelRegistrations`（`registerVirtualModel(definition)`）
   - 每条 try/catch，失败 push 一条 `{ type: "error", message: ... }` 诊断，**不抛**
   - 三个队列都置空（`= []`）
   - 最后 `await modelRuntime.refresh({ allowNetwork: false })`（这是让扩展的自发现模型目录落进同步快照的关键，`pi-any-endpoint` 在 `allowNetwork:false` 下读离线 `stored.models`）
   - 返回诊断数组
   - 以 `unknown`/最小结构化类型声明，不 import SDK 类型（保持现有文件风格：SDK 是动态 import）
2. `defaultSessionFactory` 里：`await resourceLoader.reload()` 之后立即
   `const modelRuntime = await ModelRuntime.create(); const diagnostics = await drainExtensionRegistrations(resourceLoader, modelRuntime);`
3. **无条件**把 `createOptions.modelRuntime = modelRuntime`（即使 `plan.modelRef` 为空也要注入——否则 `createAgentSession` 内部自建 runtime 同样看不见扩展 provider）
4. `plan.modelRef` 存在时才 `resolveCliModel({ ..., modelRuntime })` —— 逻辑不变，只是复用上面那一个 runtime
5. 诊断不中断启动（沿用 SDK 行为）：仅当模型确实解析失败才抛原错误

**不做**：不改用 `createAgentSessionServices()`（会重建 loader 并引入 SettingsManager 语义变化）。不新增 SDK 依赖版本约束（`peerDependencies` 保持 `"*"`）。

### D2 — A 的测试
`defaultSessionFactory` 是模块私有，不要为了测试它而改成导出工厂。**只测 `drainExtensionRegistrations`**（纯函数，fake loader + fake runtime）：
- 三个队列各一条 → 三个 register* 各被调用一次，队列清空，`refresh` 被 await（用 `{ allowNetwork: false }` 断言）
- 单个 `registerProvider` 抛错 → 该条进 diagnostics，其余仍被注册，队列仍清空
- 空队列 → 不调 register*，仍 await refresh
禁止跑真实网络。

### D3 — B 的字段与语义
- `src/shared/types.ts`
  - `RunRecord.herdr.supervisor?: SpawnMode`（**把字面量 `"rpc"` 放宽为 `SpawnMode`**；`SPAWN_MODES` 已在同文件 :50-51）
  - `Handle` 增加 `spawnMode: SpawnMode`（必填，无默认）
  - `ChildRecord` 增加 `spawnMode?: SpawnMode`（可选：历史 run.json 无此字段）
- `src/runs/orchestrator.ts`
  - `createRun({ ..., herdr: { supervisor: mode, node_id: nodeId } })`（用仲裁后的 `mode`）
  - `recordChild({ ..., spawnMode: mode })`
  - `Handle` 返回值加 `spawnMode: mode`
- `src/extension/runtime.ts`
  - `LiveChildStatusInput` 增加 `spawnMode?: string`（**C 也会读这个字段；保留可选**）
  - `renderLiveChildStatus` 的 meta 行改为 `` `supervisor=${input.spawnMode ?? "unknown"}` ``，**位置与 `session=` 顺序不变**（`["supervisor=...", "session=..."]`），并保持 `lines.push(...meta)` 在所有 snapshot 行之后
- `index.ts`
  - `launchStep` 的结果行用 `handle.spawnMode` 渲染（`index.ts:1922`，实际行号以你看到的为准）
  - 删除死代码 `renderChild`（全仓无调用者；`index.ts:3083-3100` 附近，含其中的 `"supervisor=rpc"`）
  - 其余 4 处 `createRun({ herdr: { supervisor: "rpc" ... } })` 按该处实际已知的 mode 写入：能拿到仲裁结果的地方写真实值；确实不知道的（如 resume 一个历史 run）保留读旧值/`"rpc"` 不变
- `src/extension/summary.ts:620` 展示逻辑沿用 `run.herdr.supervisor ?? "legacy"`，类型放宽后自动生效，**不需要改**，除非确实编译报错

### D4 — B 的测试改写（这是刻意行为变更，不是放宽断言）
- `test/unit/teams.test.ts:1311/1326/1339` 三条 `/supervisor=rpc/`：这些用例的 `WORKER_FILE` 无 `spawnMode`、`worktree: false` → 实际仲裁为 **inprocess**。改为断言 `/supervisor=inprocess/`。
- `test/unit/runtime.test.ts:1270/1370`、`test/unit/legion-status.test.ts:143`：这些用 `supervisor=rpc` 当**位置锚点**（断言 `execution snapshot:` 在它之前）。改为锚 `supervisor=` 前缀或 `session=`，保持"snapshot 行在 path meta 之前"的原始意图。
- `test/unit/store.test.ts:95` 的 `herdr` round-trip：值改为随写入走；若仍写 `"rpc"` 则断言不变。
- **新增**至少一条：`renderLiveChildStatus` 在 `spawnMode: "inprocess"` 时输出 `supervisor=inprocess`；缺省输出 `supervisor=unknown`。
- **新增**至少一条：`LaunchHandle` / `ChildRecord` 带出仲裁后的 mode（可用 FakeSupervisor 或 orchestrator 单元）。

### D5 — C 的 owner 判活形状（不改 `persistedSnapshotIsStale` 的语义）
- `src/extension/runtime.ts`
  - `LiveChildStatusInput` 增加 `owner?: "live" | "dead" | "unknown"`
  - `renderLiveChildStatus` 内：
    ```
    const stale = persistedSnapshotIsStale(input);           // 原样不动
    const ownerDead = input.owner === "dead" && !input.alive;
    const state = stale ? "working"
      : ownerDead && input.state === "working" ? "failed"
      : input.state;
    ```
    并在输出追加一行 owner 说明（例如 `owner: dead (pid gone)`；`live`/`unknown` 不输出或输出对应词，**由你定文案，但必须能被测试断言**）
  - `persistedSnapshotIsStale` 函数体**保持原样**（它的原意是"活进程 + retired 快照 → 仍是 working"），不要改它的真值表
- `index.ts`
  - status 两个分支（具名 + 聚合）在 `input.supervisor.isAlive(name) === false` 时，回落到 `ownerState(<runDir>/owner.json)` 取 `"live"|"dead"|"unknown"`，把结果放进 `owner`
  - `runDir` 由 `RunStore.runDir(runId)` 或等价方式取；`owner.json` 文件名常量用 `src/runs/owner.ts` 已导出的那个，不要硬编码字符串
  - `index.ts` 需要新增 `import ... from "./src/runs/owner.ts"`
- **stop 口径统一**：`stopAction` 在 `jobs.find(...)` 未命中时（`index.ts:2911` 附近的 `unknown child: ... (not tracked by this session)`），回落到 `findChild(store.listRuns(), name)` + 现有 retire 适配器路径（`index.ts:1320-1348` 附近已有的 run.json 兜底）。只有 **两条** 都落空才返回原 `unknown child` 错误。文案保持原样。
  - 若该回落会破坏现有 `test/unit/wait-action-index.test.ts` 的 stopAction 断言，允许更新那些断言，但**必须**在 PR 描述里列出。

### D6 — C 的测试
- `renderLiveChildStatus`：`alive:false + owner:"dead" + state:"working"` → 输出 `state=failed` 且带 owner 说明；`owner:"unknown"` 时保持 `state=working`（不误判）；`alive:true` 时 owner 不影响 state
- status 聚合：构造一个 owner.json pid 必死的 run 目录（`pid: 999999999`），断言 `subagent({action:"status", all:true})` 输出 `state=failed` 而非 `state=working`
- stop：foreign/未 tracked 的 name 在 store 里存在 → 走 retire 而不是 `not tracked by this session`；store 也没有 → 仍返回原 `unknown child` 错误

## 刻意不做（reviewer 请先对照此清单再判"缺失"）

- **不改** `createAgentSessionServices()` 路由（A）
- **不改** `peerDependencies` 版本约束
- **不删** `run.json` 的历史 `herdr.supervisor` 字段（向后兼容旧 run 目录）
- **不重写** `persistedSnapshotIsStale`（C）——它制造 false-working 的路径由 owner 判死修正，函数本身语义保留
- **不新增**数据库列（legion.db nodes 表不加 spawnMode；本轮只动 run.json/record）
- **不改** `/legion status` 的 `childStatus` 提供者（`index.ts:904-921`）；它不在 #209 范围
- **不动** `src/runs/provision.ts`、`src/extension/legion-doctor.ts`。「doctor 对 inprocess 推荐 PI_LEGION_CHILD_EXTENSIONS 是 false lead」是 #209-1 的 part 3，**归入 PR-A 之后单独处理**，本轮三个 PR 都不改它 —— 若你发现不改 doctor 就无法完成 A 的验收，停下来向父会话报告

## 验收命令（父会话会在你的 worktree 里跑）

- A: `npm run typecheck` && `npm run test`
- B: `npm run typecheck` && `npm run test`
- C: `npm run typecheck` && `npm run test`

全量单测 1058 条（基线），任何新增失败都必须修到绿。CI 还跑 integration/mock-llm，你**不需要**跑它们，但不得让它们的既有断言因你的改动而失效——若你认为会失效，在报告里明确指出文件与用例。
