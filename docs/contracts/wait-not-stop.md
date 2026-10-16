# Contract: wait ≠ stop (parent decides)

Status: FROZEN-1 (2026-10-16, #179 Archer lock)

## Rule

`wait` (and a still-running / timeout tool result) **never** retires children.
Esc also does not retire children (`esc-no-retire-v3`). Only an explicit
`subagent({ action: "stop", … })`, `/legion stop`, or session shutdown retires.

When `wait` times out (or otherwise returns while children are live), the tool
result includes structured fields for the **parent** to decide:

- `status`: `wait_timeout` | `still_running` | `budget_exceeded` (budget optional)
- `done` / `stillRunning[{ name, elapsedMs, budgetMs? }]`
- `decisions`: `extend` | `steer_again` | `stop` | `force_stop` (model hint enum, not a new RPC)
- `hint`: wait does not stop children; choose stop/force_stop or extend/steer

The parent then calls existing tools (`wait` again, `steer`, or `stop` with
optional `force: true`). Tooling must not auto-SIGKILL on timeout.

## Force stop

`subagent({ action: "stop", name?, all?, force?: boolean })`:

- `force` omitted / false → graceful retire (stdin close → SIGTERM escalate)
- `force: true` → retire hardening (`docs/retire-hardening-contract.md`):
  SIGTERM → SIGKILL + descendant sweep

Do not add a parallel `action: "force_stop"`.
