# ESC 打断 + 优雅停止契约（v1，2026-10-13 冻结）

> **v2 修订（2026-10-13）**：ESC / 父 turn abort 的语义已改为级联优雅关闭由该 turn 拥有的 children，推翻 v1 下文的「ESC ≠ 杀 children」决定。下文保留 v1 冻结原文，仅供历史考古；当前语义以 `docs/contracts/esc-cascade-v2.md` 为准。

> **v3 说明（2026-10-15）**：v3（`esc-no-retire-v3.md`）再次回到 v1 的「ESC ≠ 杀 children」原则；与 v1 不同的是保留 session_shutdown drain/归因与显式 `/legion stop`。v2 级联语义已推翻。

## 目标

1. 主 pi 按 ESC（或 RPC abort）打断当前 turn 时，正在执行的 `subagent` 工具调用必须尽快感知并优雅收场，不能钉住事件循环。
2. `wait` 不能出现「子 agent 3 分钟完成，wait 还要等满 timeoutMs（最长 3×role timeout + 600s verify）」——完成事件必须立刻解除等待。
3. 新增显式 `stop` action：一次优雅停掉指定/全部 children（复用 retire 全链）。

## 非目标

- 不改 pi 核心（SDK spawn 无 detached 注入口；ESC 键位保留不可动）。
- 不做主机级 watchdog。
- 不改 join/notify 批处理语义。
- **ESC ≠ 杀 children**。ESC 只打断父 turn 的工具等待；想停 children 用 `stop`。

## 根因（已三方侦察证实）

| # | 根因 | 证据 |
|---|---|---|
| R1 | `index.ts:613` 工具 execute 把 signal 参数命名 `_signal` 直接丢弃，全仓无 AbortSignal 处理 | scout-0 |
| R2 | pi 核心 abort 只在批次边界检查 signal，不强杀 in-flight tool promise，等它自然 resolve | scout-1 |
| R3 | `Orchestrator.collect` 内部 deadline 续期（COLLECT_GRACE_EXTENSIONS=2）+ 轮询等待点（2.5s 安静窗口 `waitForQuiet`，已由 #232 / PR #244 删除；现存 `waitOutTransientConnection` + `collectArtifactGrowing`）+ applyVerification（600s cap）使 collect 实际可等 3×timeoutMs+600s | scout-0 |
| R4 | 无显式 stop 命令，LLM 只能逐个 retire | scout-0 |

## 冻结决定

### A. execute 感知 abort signal（index.ts）

```ts
async execute(_id, params, signal, onUpdate, ctx) {
  // signal 是 pi 核心传来的 AbortSignal | undefined（ESC / RPC abort 时触发）
  // 用法：
  //   1) 进入时检查 signal?.aborted → 直接返回（不出工具结果错误）
  //   2) wait/collect 等阻塞路径监听 signal abort → 立即收场返回 interrupted 文案
  //   3) launch 的 spawn 是秒级同步，spawn 完成后若 signal.aborted → 该 child 视为
  //      abandoned：retire + 不 watch，run.json/legion.db 按失败记
}
```

- 工具内不自建 AbortController；直接把 signal 往下传给需要收场的 await 点。
- 中断返回用**正常 tool result**（isError 不设，或按 pi 对 abort 工具的惯例 error result）——实现以实际验证为准：ESC 后 pi 不再消费结果内容，关键是 promise 尽快 settle。
- **顺序注意**：`runtime.bind(ctx)`、`resolveLegionIdentity` 等前置步骤保留；只把 wait/collect/launch 的长等待接入 signal。

### B. runtime.wait 接入 signal + 事件驱动快路径

改动点 `src/extension/runtime.ts`：

1. `waitOne` 的 race 增加第三个臂（如 signal 存在）：
   ```ts
   const snapshot = await Promise.race([
       ensureCollect(job),                    // 慢路径：快照完整
       signalAborted(signal),                  // 新增：promise，signal.abort 时 resolve
       timer,                                 // 超时臂保留
   ]);
   ```
   命中 signalAborted → 返回 `{ name, interrupted: true }`（新 WaitResult 字段），finally 清 timer；`consumedByTool` 复位为 false（把通知权还给 watch 链路，ESC 后子 agent 的完成通知照常浮出）。
2. `SessionRuntime.wait` 签名扩展：`opts.signal?: AbortSignal`，透传给每个 `waitOne`。
3. `waitAction`（index.ts）把 `params` 里的 signal 透传。注意 `waitAction` 是独立导出函数，input 需新增 `signal` 字段。
4. `interrupted` 的 WaitResult 在 `renderWait` 渲染一行 `interrupted (parent turn aborted)`，不打乱 done/running 统计（新增 interrupted 计数行）。

### C. collect 的 signal 接入（orchestrator.ts）

`Orchestrator.collect(name, { timeoutMs, signal? })`：

- 三个可中断等待点全部接 signal：
  1. `awaitSupervisor` 内 `supervisor.waitSettled(...)` → supervisor 层新增可选 signal 参数：`waitSettled(name, timeoutMs, signal?)`，在 signal abort 时同步 resolve `{ settled:false, abnormal:false, reason:"aborted by parent" }` 并清 timer（`resolveWaiters` 已有清 timer 逻辑，需给单 waiter 提前退出路径——最简单：waiter 注册时若 signal 存在则挂 listener，abort 时从 child.waiters 删除自己 + clearTimeout + resolve）。
  2. `waitOutTransientConnection` / `collectArtifactGrowing` 轮询循环：每轮检查 `signal?.aborted` → return。（原文写作 `waitForQuiet`；该方法已由 #232 / PR #244 删除，`signal` 语义不变，仍覆盖 collect 内两个轮询等待点。）
  3. `applyVerification`：`RunVerifyRunner.verify(...)` 若不支持 signal，则在 `finishCollect` 前后不做额外处理（保持现状），但 collect 整体 deadline 检查点加 `signal?.aborted` 短路。
- `waitSettled` 的 signal 参数是**可选**追加参数，向后兼容（默认 undefined 行为不变）——已有调用点不传即不变。

### D. stop action（index.ts + 类型）

```ts
// SubagentParams action union 增加 Type.Literal("stop")
subagent({action:"stop", name: string})       // 单个
subagent({action:"stop", all: true})          // 全部 live children
```

- 语义 = 逐个 `orchestrator.retire(name)`（stdin close → 5s → SIGTERM → 1s → SIGKILL → sweep 的现有全链）+ 清 runtime 跟踪（`runtime.release(name)`；watch-loop 的 finally 已有 release，直接复用）。
- `name` 与 `all` 互斥，二者必选一（与 wait 相同校验）。
- 复用 `resolveWaitTargets` 同样的 live 判定（state ∈ {working, blocked}）？**否**——stop 应该能停 awaiting/working/blocked 所有非 retired 状态。用 `runtime.activeJobs()` 全量（排除已 retired）。
- 工具描述（TOOL_DESCRIPTION）与参数 schema description 同步更新。
- **stop 不接 signal**（用户显式要求停止，操作本身是收场动作）。

### E. TOOL_DESCRIPTION / 文档更新

- index.ts 的 TOOL_DESCRIPTION：action 列表加 stop；wait 描述注明事件驱动、提前返回。
- README.md 的 playbook 相关段落若有 action 枚举，同步。
- docs/design.md 补一节「ESC abort 语义 + stop」。

## 文件归属

| 文件 | 改动 | Owner |
|---|---|---|
| index.ts | execute signal 接线、waitAction signal 透传、stop action、TOOL_DESCRIPTION | worker |
| src/extension/runtime.ts | waitOne signal 臂、WaitResult.interrupted、renderWait、wait opts.signal | worker |
| src/runs/orchestrator.ts | collect opts.signal、轮询等待点/awaitSupervisor 短路 | worker |
| src/supervisor/rpc-supervisor.ts | waitSettled 可选 signal 参数 | worker |
| src/supervisor/types.ts | LegionSupervisor 接口 waitSettled 签名（如有） | worker |
| src/extension/playbook.ts | TOOL_DESCRIPTION / PARENT_PLAYBOOK 同步 stop + wait 说明 | worker |
| test/** | 单测 | worker |

全部归属同一个 worker（改动互相耦合，不拆分）。

## 验收清单

1. `npm test`（或项目 test 脚本）全绿。
2. 新增单测：waitOne 在 signal abort 时返回 interrupted 且 timer 被清（用 fake timer / 短超时验证提前返回）。
3. 新增单测：stop action 对多 child 逐个 retire（mock supervisor 验证调用顺序与 release）。
4. 手工验证（用户侧）：launch → wait → 按 ESC → 工具立刻返回 interrupted；children 继续跑，完成通知照常到达。
5. 手工验证：subagent({action:"stop", all:true}) 后所有子进程退出（ps 验证无残留）。
6. 类型检查通过（tsc / package.json 的 typecheck 脚本若有）。

| docs/design.md、README.md | 语义文档 | worker |

## 契约修订记录

> **v1.2（2026-10-13）**：文件归属新增 `src/extension/playbook.ts`（TOOL_DESCRIPTION 实际定义处，原契约只写了 index.ts）。其余不变。

## 参考实现锚点（worker 必读）

- index.ts:595-935（execute、controlAction、launchFamily 分派）
- index.ts:1765-1810（waitAction）
- runtime.ts:440-547（ensureCollect/waitOne）、831-838（wait）
- orchestrator.ts:769-941（collect/awaitSupervisor/轮询等待点/retire；原 `waitForQuiet` 已由 #232 / PR #244 删除）
- rpc-supervisor.ts:353-396（waitSettled/isAlive）、760-838（retireChild）
- 4 个单测锚点：`test/unit/supervisor.test.ts:295` 等现有 waitSettled 测试不变（可选第三参数不破坏旧签名）。
- `waitSettled` 当前在 `src/supervisor/types.ts:81` 接口里，改为 `waitSettled(name: string, timeoutMs?: number, signal?: AbortSignal): Promise<SettleResult>`；唯一非测试调用点 `orchestrator.ts:800`。
- 测试跑法：`npm run typecheck && npm test`（unit），integration 单独 `npm run test:integration`。
