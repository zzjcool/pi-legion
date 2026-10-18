# Headless child contract

This document pins the trust / approve surface and the exit → settle mapping of
the **`rpc` backend** so operators and agents do not confuse upstream pi
behaviour with legion's own `onBlocked` policy.

On the `rpc` backend, legion children are **headless Pi RPC processes**. The
default backend is `inprocess` (an `AgentSession` inside the parent Node
process), which has no child process, no argv and therefore no trust/approve
surface — see [inprocess-supervisor.md](./inprocess-supervisor.md).

## Modes (upstream pi) vs legion

| Upstream headless form | Interactive tool-approval UI? | Legion children |
| --- | --- | --- |
| `-p` / `--print` | No | Not used |
| `--mode json` | No | Not used |
| `--mode rpc` | No | **Yes — rpc only** |

On the `rpc` backend legion always launches children via `RpcClient` →
`pi --mode rpc`. Print and json modes are listed only for contrast; they are
never legion child transports.

## Project trust under headless

Headless modes do not show a trust prompt. When `~/.pi/agent/trust.json` has no
applicable decision for the child cwd:

- global `defaultProjectTrust=ask` (default) and `never` both **ignore** project
  `.pi/settings.json`, project resources, and project extension discovery;
- only `always`, a saved `/trust` decision, or a one-shot `--approve` trusts the
  project side.

**Ops:** to load project settings / project extensions in an RPC child, either
`/trust` that cwd first (writes trust.json) or set `defaultProjectTrust=always`.
This matters most when `inheritExtensions: true` (or
`PI_LEGION_CHILD_INHERIT_EXTENSIONS`) re-enables discovery; the default
`--no-extensions` already blocks most silent project-extension loads.

### Opt-in `--approve` (legion settings)

```json
{
  "subagents": {
    "rpc": {
      "approve": true
    }
  }
}
```

Default is **false**: spawn argv does **not** pass `--approve`, `-a`, or
`--no-approve`. When `subagents.rpc.approve` is `true`, legion appends
`--approve` to the child argv. There is no inherit-parent-trust channel; the
child still reads the same agent home `trust.json` / `defaultProjectTrust` as
any other pi process on the machine. v1 does not emit `--no-approve`.

## Two approval layers (do not merge)

1. **Upstream pi tool-approval** — interactive TUI gate for tool calls. Headless
   modes have **no** interactive tool-approval UI; “ask” trust without a saved
   decision behaves like ignoring project settings (see above), which is not the
   same as a confirm dialog.
2. **Legion `onBlocked`** (`forward` / `auto-approve` / `notify`) — parent-side
   **subagent block strategy** when a child surfaces an approval-class request
   through `extension_ui`. It is **not** a replacement for pi interactive
   tool-approval; keep the layers separate in docs and debugging.

## Exit code / signal → `SettleResult` → node state

| Event | `SettleResult` | Orchestrator node |
| --- | --- | --- |
| RPC `agent_settled` | `settled:true`, `abnormal:false` (may set `aborted`) | settled |
| Process exit with `retireRequested` (incl. SIGTERM/SIGKILL escalate) | `settled:false`, `abnormal:false`, reason ≈ retired…, `exitCode?`, `signal?` | retired |
| Unexpected exit `exitCode===0` before settle | `settled:false`, `abnormal:true`, `exitCode:0` | gone → failed |
| Unexpected exit nonzero / `null` | `settled:false`, `abnormal:true`, `exitCode` | gone → failed |
| Unexpected signal (no retire) | `settled:false`, `abnormal:true`, `signal` | gone → failed |
| `waitSettled` timeout | `settled:false`, `abnormal:false`, `reason:"timeout"` | timeout (process still alive) |
| Parent abort of wait | `settled:false`, `abnormal:false`, `reason:"aborted by parent"` | aborted path |

v1 does **not** subclass failed by exit code (0 and nonzero are both abnormal);
`exitCode` / `signal` are asserted on the result for diagnostics. Parent-session
hygiene (#181) is orthogonal and unchanged by this contract.
