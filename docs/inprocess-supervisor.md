# In-process AgentSession mode (#197)

Optional backend for short, dense fan-out. **Default remains RPC** (`pi --mode rpc` subprocess).

## When to use

| Mode | Good for | Avoid when |
|---|---|---|
| `rpc` (default) | Long runs, untrusted tasks, need crash / env / cwd isolation, **worktree** | Cold-start cost dominates |
| `inprocess` | Short, trusted fan-out; lower spawn latency; simpler approval / UI fan-in | Need OS worktree, separate credentials, crash isolation |

**Non-goals:** no OS worktree isolation; no promise of process crash containment; OpenAaaS Go in-process transport is out of scope.

## Config

Per agent (frontmatter → `agentOverrides` → team member override):

```yaml
# agents/scout.md
---
name: scout
description: Fast read-only recon
spawnMode: inprocess   # omit = rpc
worktree: false        # required: inprocess + worktree is refused
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
| Spawns / session | `maxSubagentSpawnsPerSession` | `inprocess.maxSpawnsPerSession` |
| Tree depth | `legion.maxDepth` | `inprocess.maxDepth` (AsyncLocalStorage) |
| Concurrent alive | `legion.maxActiveNodes` | `inprocess.maxActive` (default **8** when block present) |
| Children / node | `legion.maxChildrenPerNode` | `inprocess.maxChildrenPerNode` |
| Wait timeout | agent `timeoutMs` / wait default | `inprocess.waitTimeoutMs` |

Never fall back across columns. Omit an `inprocess.*` key → that dimension is unlimited (except `maxActive` default above).

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

- `kind !== "pi"` + `inprocess` → `INVALID_PARAMS`
- `worktree: true` + `inprocess` → `INVALID_PARAMS`
- Invalid `spawnMode` string → loud throw at settings / frontmatter parse

## Tests

See `test/unit/inprocess-supervisor.test.ts` (mock session) and settings parse coverage in `test/unit/spawn-mode-settings.test.ts`.
