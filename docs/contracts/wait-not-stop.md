# Contract: wait ≠ stop (parent decides)

Status: FROZEN-1 (2026-10-16, #179 Archer lock)

> **权威来源**（本文件是摘要，不是原始依据；冲突时以下两份为准）：
> - `docs/contracts/esc-no-retire-v3.md` —— 「Esc / 父 turn abort 不 retire children」的全部语义。
> - `docs/contracts/retire-hardening-v1.md` —— `stop` / `force: true` 的 SIGKILL 升级与后代清场条款。
>
> 本文件**独有**的只有下面「Rule」里的 `wait_timeout` 结构化字段定义。它的消费点（代码为准）：
> `buildWaitTimeoutDetails()` 构造 `WaitTimeoutDetails`（`status` / `done` / `stillRunning[]` / `decisions[]` / `hint`），
> `WAIT_PARENT_DECISIONS` 与 `WAIT_TIMEOUT_HINT` 是它的具体值；调用点是 `renderWait()`（人读文本）
> 与 `waitAction()`（工具 `details` 字段）——都在 `index.ts`。`WaitResult.timedOut` 是前端标记，
> 由 `src/extension/runtime.ts` 的 wait 循环置位，`status: "wait_timeout"` 就由它推导。

## Rule

`wait` (and a still-running / timeout tool result) **never** retires children.
Esc also does not retire children (`esc-no-retire-v3`). Only an explicit
`subagent({ action: "stop", … })`, `/legion stop`, or session shutdown retires.

When `wait` times out (or otherwise returns while children are live), the tool
result includes structured fields for the **parent** to decide:

- `status`: `wait_timeout` | `still_running` | `budget_exceeded` (budget optional)
- `done` / `stillRunning[{ name, elapsedMs }]`
- `decisions`: `extend` | `steer_again` | `stop` | `force_stop` (model hint enum, not a new RPC)
- `hint`: wait only stopped waiting — the children are still running and keep their context; prefer `status`/`extend`/`steer_again`, and use `stop`/`force_stop` only to abandon the work

The parent then calls existing tools (`wait` again, `steer`, or `stop` with
optional `force: true`). Tooling must not auto-SIGKILL on timeout.

## Force stop

`subagent({ action: "stop", name?, all?, force?: boolean })`:

- `force` omitted / false → graceful retire (stdin close → SIGTERM escalate)
- `force: true` → retire hardening (`docs/contracts/retire-hardening-v1.md`):
  SIGTERM → SIGKILL + descendant sweep

Do not add a parallel `action: "force_stop"`.
