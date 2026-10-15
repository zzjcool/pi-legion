# ESC 级联关闭契约（v2，2026-10-13 冻结）

> **v3 推翻（2026-10-15）**：ESC / 父 turn abort **不再**级联 retire children。当前语义以 `docs/contracts/esc-no-retire-v3.md` 为准。下文保留 v2 冻结原文，仅供历史考古。


## 背景

v1（esc-abort-v1.md，已随 e66c85f 合入）冻结了「ESC ≠ 杀 children」语义。用户裁决推翻：turn 是 children 的 owner，turn 被 abort 时 children 应级联关闭，否则是资源泄漏。

## 冻结决定

### A. ESC 打断 turn → 级联优雅关闭 children

改动点 `index.ts` 工具 execute（约 :687-691 的 `signal?.aborted` 快速返回处）：

```ts
if (signal?.aborted && action !== "stop") {
    // NEW: cascade-close children owned by this turn before returning.
    await cascadeRetireAll();   // fire-and-forget 也可以，但要保证 promise 存活到 retire 完成
    return ok("interrupted (parent turn aborted)");
}
```

**注意**：进入 execute 时 signal 已 aborted 的情况（ESC 发生在此工具调用排队后、执行前）——此时本 turn 尚未 launch 过任何 child，cascade 是 no-op，安全。

但真正的触发点是**执行中途 abort**：wait/collect 正在 await 时 signal 才 abort。这些路径已有 interrupted 返回分支（waitAction / collectChild / collectInline / waitOne），在这些分支统一调 `cascadeRetireAll()`。

### B. cascadeRetireAll 实现（index.ts）

```ts
const cascadeRetireAll = async (): Promise<void> => {
    // 1. runtime 跟踪的所有 jobs（与 stopAction all:true 相同的目标集）
    for (const name of targets) runtime.cancelWatch(name);   // 先停 watch，防 retire 期间通知噪音
    await Promise.all([...jobs.map((job) => job.retire?.()), ...pendingUtilityRetires]);  // 全部 best-effort catch
    // 2. release 全部
};
```

复用 stopAction 的骨架但**不生成工具结果文案**（不是用户显式 stop，静默级联）。vexillatio 的 pendingUtilityRetires 一并级联。

### C. wait/collect 中断路径统一接线

所有「signal aborted → return interrupted」的分支（index.ts waitAction 间接层 + runtime.waitOne + collectChild + collectInline + launchFamily abandoned 路径）在返回前触发 cascade（一次性，防重入——用 module-level `cascading` promise 去重即可，同一 signal 只触发一次）。

**防重入**：同一 abort 事件可能同时命中多个 in-flight 工具调用（parallel tool calls），cascade 必须幂等：用 `let cascadePromise: Promise<void> | undefined` 缓存，已存在则复用。turn_start 时重置（新 turn 新级联）。

### D. vexillatio collect 接 signal

`index.ts` launchUtilityFamily（约 :1895）：
```ts
const result = await handle.orchestrator.collect(handle.name, { timeoutMs, ...(signal ? { signal } : {}) });
```
vexillatio 工具 execute 也要把 signal 传进来（找到它的 registerTool 调用，第 3 参数接上）。ESC 后 utility children 也应被 retire（它们进了 pendingUtilityRetires，cascade 覆盖）。

### E. 契约/文档更新

- docs/contracts/esc-abort-v1.md：顶部加「v2 修订：ESC 语义改为级联关闭，推翻 v1 的『ESC ≠ 杀 children』」——保留原文供考古，加修订记录。
- docs/design.md、README.md、playbook（TOOL_DESCRIPTION / PARENT_PLAYBOOK）相应语句更新：ESC abort 会级联 retire children；wait 被打断时 children 一并关闭。

## 语义边界（不变）

- **stop action 不变**：显式停止仍走全链。
- **主 pi 正常退出（quit）不变**：交互 TUI 的 session_shutdown 仍立即级联 retire。
- **非交互 print/JSON（#72）**：`ctx.mode` 为 `print` 或 `json` 时，session_shutdown 先等仍活着的 async 子 agent 结算（上限为各子的 turn timeout），再 retire 尚未结束的。避免 `--print` 在首包前把刚 spawn 的子进程记成 `no assistant message for the last prompt`。父会话关机导致的无 assistant abort 原因改为 parent session shutdown，与模型自己没写出 assistant 区分。
- **SIGKILL/崩溃不覆盖**：孤儿扫描 + resume 语义不变（这是既定接受的风险）。
- **children 的 children**：retire 链本身递归（孙进程 sweep 在 rpc-supervisor 的 retireChild 里），无需额外处理。
- **blocked children**：一并 retire（stop 语义一致）。

## 文件归属

| 文件 | 改动 |
|---|---|
| index.ts | cascadeRetireAll + 各中断分支接线 + vexillatio signal |
| src/extension/playbook.ts | TOOL_DESCRIPTION / PARENT_PLAYBOOK 更新 |
| docs/contracts/esc-abort-v1.md | v2 修订记录 |
| docs/design.md, README.md | 语义说明 |
| test/unit/* | 新测试 |

## v2.1 修订（2026-10-13，会话 01a13345 实测后补）

v2 的触发点只覆盖了「abort 落在 in-flight subagent 工具调用上」（wait/collect/launch 中途）。**async launch（默认形态）在 ESC 前就早已返回**：ESC 落在模型生成、空档或别的工具上时，没有任何 subagent 工具在执行，signal 无处投递，级联不触发——子 agent 继续跑，直到 session_shutdown 或显式 stop。

实测：2026-10-13 03:20Z 会话 01a13345 async 启动 centurion（worktree），03:20:10 ESC abort 父 turn，子 agent 存活至用户退出父会话（03:20:24，走的是 session_shutdown 级联）。

**修复**：`index.ts` 注册 `pi.on("agent_settled")`——pi 核心在每个 agent run 结算时发 `{ aborted: boolean }`，ESC abort 后必为 true（见 pi AgentSettledEvent："Whether the run ended because it was aborted, for example with Escape."）。handler 在 `event.aborted` 时 fire-and-forget `cascadeRetireAll()`（不 await：优雅 retire 可达秒级，不能拖住 settle 路径）。注册点与 turn_start 相邻、位于子进程 early-return 之前，父会话/嵌套子/工具人全部生效；无 runtime 的会话上是 no-op。幂等性由既有 cascadePromise/cascadingJobs 保证：ESC 打断 in-flight 工具时工具路径先触发一次，agent_settled 再触发一次为 no-op。

## 验收

1. typecheck + unit + integration 全绿。
2. 新测试：wait 中途 abort → children 被 retire（mock 验证 retire 调用 + cancelWatch + release）。
3. 新测试：cascade 幂等（同 signal 两次触发只 retire 一次）。
4. 新测试：parallel 工具调用同时 abort，cascade 只跑一次。
5. 新测试：vexillatio collect 在 abort 时提前返回（不长等 600s）。
6. 新测试（v2.1）：async launch 已返回后 emitSettled(true) → 子 agent 被 retire、无完成通知。
7. 新测试（v2.1）：emitSettled(false)（正常结算）→ 不 retire，async 子继续运行。

## 锚点（以 master bc9c205 为准）

- index.ts:687-691（execute 入口 aborted 快速返回）
- index.ts:832-840（session_shutdown 参考——cascade 参考其形状）
- index.ts:2243-2280（stopAction 骨架——cascade 复用）
- index.ts:1890-1900（vexillatio collect）
- runtime.ts:481-590（waitOne interrupted 分支）
- master 上无 worktree 依赖，直接在主 repo 改。
