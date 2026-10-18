# In-process AgentSession mode (#197)

Default backend for children. **In-process by default**, with an automatic `rpc`
fallback when the resolved spawn needs an OS worktree (`worktree: true`, the
writer/centurion default) or is not a `pi` role. An explicit
`spawnMode: "inprocess"` combined with `worktree: true` is still **refused**
with `INVALID_PARAMS` — the fallback only covers the implicit default.

## When to use

| Mode | Good for | Avoid when |
|---|---|---|
| `inprocess` (default; auto-fallback below) | Short, trusted fan-out; lower spawn latency; simpler approval / UI fan-in | Need OS worktree, separate credentials, crash isolation |
| `rpc` (fallback: worktree / non-pi kind; or explicit `spawnMode: rpc`) | Long runs, untrusted tasks, need crash / env / cwd isolation, **worktree** | Cold-start cost dominates |

There is no single global default in the config sense: omitting `spawnMode`
means "inprocess if this role can run in-process, otherwise rpc". Roles that
default to `worktree: true` (writer, centurion) therefore resolve to `rpc`
unless they opt out of the worktree.

**Non-goals:** no OS worktree isolation; no promise of process crash containment; OpenAaaS Go in-process transport is out of scope.

## Config

Per agent (frontmatter → `agentOverrides` → team member override):

```yaml
# agents/scout.md
---
name: scout
description: Fast read-only recon
spawnMode: inprocess   # omit = inprocess (worktree roles auto-fall back to rpc)
worktree: false        # explicit inprocess + worktree: true is still refused
---
```

```json
{
  "subagents": {
    "agentOverrides": {
      "scout": { "spawnMode": "inprocess" }
    },
    "inprocess": {
      "maxSpawnsPerSession": 32,
      "maxDepth": 2,
      "maxActive": 8,
      "maxChildrenPerNode": 4,
      "waitTimeoutMs": 300000
    }
  }
}
```

### Limit keys (independent buckets)

| Semantic | RPC | In-process |
|---|---|---|
| Spawns / session | `maxSubagentSpawnsPerSession` | `inprocess.maxSpawnsPerSession` (no default) |
| Tree depth | `legion.maxDepth` | `inprocess.maxDepth` (AsyncLocalStorage; default **4**) |
| Concurrent alive | `legion.maxActiveNodes` | `inprocess.maxActive` (default **30**; **8** when the block is present without `maxActive`) |
| Children / node | `legion.maxChildrenPerNode` | `inprocess.maxChildrenPerNode` (default **8**) |
| Wait timeout | agent `timeoutMs` / wait default | `inprocess.waitTimeoutMs` (no default) |

Never fall back across columns: in-process limits are read from
`subagents.inprocess.*` only, never from the `legion.*` keys.

Omitting an `inprocess.*` key is **not** unlimited. The documented defaults
mirror `legion.*`, so a deployment with no `subagents.inprocess` block at all
still runs under `maxDepth: 4` / `maxChildrenPerNode: 8` / `maxActive: 30`.
The two exceptions: with an explicit block that omits `maxActive`, it is 8;
and `maxSpawnsPerSession` / `waitTimeoutMs` have no default (unlimited).

## Identity channel: in-process context (AsyncLocalStorage)

In-process children share the parent's `process.env` — they are sessions, not
processes. Nothing about `PI_SUBAGENT_*` or `PI_LEGION_*` can distinguish a
child from its parent, and reading env in a child yields the **parent's**
values (or nothing at all when the parent is root). Binding child identity to
env therefore mis-scoped role enforcement: a parent `writer` silently dropped
a read-only child's write bans, and a parent read-only role wrongly banned a
`writer` child.

So in-process identity travels in an `AsyncLocalStorage` child context instead:
node id, db path, acceptance role, `allowNested`, `utility`, `spawnMode`, and
the nested parent path. The guards and the legion runtime read that context, and
only fall back to env for RPC children, whose process really does own its env.

Two consequences worth knowing:

- **ALS does not cross `spawn()`.** A real subprocess started from a child
  (`bash npm test`, another CLI, a nested agent process) cannot inherit the
  tree identity. That is the isolation the env channel lacked — it is what
  produced the "healthy ghost nodes" incident, where a test-loading extension
  adopted an ancestor's ledger identity.
- **The SDK never emits `session_start` for these sessions.** `createAgentSession`
  does not call `bindExtensions`, which is the only emitter, so the usual
  session-start identity init is dead here. The orchestrator injects the
  context explicitly and the extension attaches the identity on its first
  ctx-bearing event, using the pre-created transcript file as the credential.

Do not replace this with env injection for in-process children.

## Architecture

```
Orchestrator
    → RoutingSupervisor (LegionSupervisor)
         ├─ spawnMode rpc        → RpcSupervisor   (unchanged)
         └─ spawnMode inprocess  → InProcessSupervisor
                                      createAgentSession + SessionManager.inMemory
                                      (tools / model / systemPrompt wired)
```

`InProcessSupervisor` implements the full contract: `spawnChild` / `prompt` / `steer` / `followUp` / `abort` / `waitSettled` / `isAlive` / `stats` / `retire`. Retire calls `session.dispose()` — no SIG / descendant sweep. Events fan-in with the same coarse types as RPC (`agent_*`, `turn_*`, `tool_execution_*`) for rail / TUI. OSC hierarchical activity (#166) may be stubbed here.

## Session factory (v1 whitelist)

Production `defaultSessionFactory` calls `createAgentSession` with:

| Option | Source |
|---|---|
| `tools` | `agent.tools` (omit when unset → SDK default). Non-utility roles also get `vexillatio`, same as RPC `pushToolArgs`. |
| `model` / `thinkingLevel` | Resolved spawn `model` (+ `thinking` / `modelProvider`), via `ModelRuntime` + `resolveCliModel` — same string Orchestrator already picked for RPC. |
| system prompt | `DefaultResourceLoader` `systemPromptOverride` (replace) or `appendSystemPromptOverride` (append) from `agent.systemPrompt` + `systemPromptMode`. `childContext` is joined once here (RPC-aligned); do not double-inject. |
| extensions | Default `noExtensions: true` + explicit `additionalExtensionPaths` from role / `PI_LEGION_CHILD_EXTENSIONS` / auto `builtin:codemode` + child-guard. Does **not** reload parent MCP wholesale. `inheritExtensions: true` restores host discovery. |

See `buildInProcessSessionPlan` / `test/unit/inprocess-supervisor.test.ts`.

## Refusals

- `kind !== "pi"` + explicit `inprocess` → `INVALID_PARAMS` (an omitted
  `spawnMode` falls back to `rpc` instead)
- `worktree: true` + explicit `inprocess` → `INVALID_PARAMS` (an omitted
  `spawnMode` falls back to `rpc` instead)
- Invalid `spawnMode` string → loud throw at settings / frontmatter parse

## Tests

See `test/unit/inprocess-supervisor.test.ts` (mock session) and settings parse coverage in `test/unit/spawn-mode-settings.test.ts`.
