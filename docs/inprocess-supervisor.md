# In-process AgentSession mode (#197)

Default backend for children. **In-process by default**, with `rpc` used when
the launch needs an OS worktree (`worktree: true`, which only a `centurion` can
hold — #214).

There is no `spawnMode` config field. The backend is derived from the launch:

| Launch needs a worktree? | Backend |
| --- | --- |
| no | in-process |
| yes | `rpc` |

Since only a `centurion` may hold a worktree, only a centurion can reach
`rpc`; every other role is in-process. A non-centurion card that asks for
`worktree: true` is demoted to `worktree: false` with a once-per-run warning,
which also keeps it in-process.

## When to use

The choice is not per-role — it follows from whether the work needs a worktree.

| Mode | Good for | Avoid when |
|---|---|---|
| `inprocess` | Short, trusted fan-out; lower spawn latency; simpler approval / UI fan-in | Need OS worktree, separate credentials, crash isolation |
| `rpc` | Long runs, untrusted tasks, need crash / env / cwd isolation, **worktree** | Cold-start cost dominates |

Both backends enforce the same legion tree budgets (`maxDepth` /
`maxChildrenPerNode` / `maxActiveNodes`); the `subagents.inprocess.*` pools apply
on top and the stricter gate wins.

**Non-goals:** no OS worktree isolation; no promise of process crash containment; OpenAaaS Go in-process transport is out of scope.

## Config

There is no `spawnMode` key to configure — not in frontmatter, not in
`agentOverrides`. The old field was removed (4.0.1); a card that still declares
it is now rejected at load time, because unknown frontmatter is a hard error.

```yaml
# agents/scout.md
---
name: scout
description: Fast read-only recon
worktree: false        # a non-centurion asking for true is demoted + warned
---
```

```json
{
  "subagents": {
    "agentOverrides": {
      "scout": { "worktree": false }
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
| Queue depth | `inprocess.maxQueuedLaunches` (shared by both paths) | `inprocess.maxQueuedLaunches` (default **32**) |
| Queue wait | `inprocess.launchQueueTimeoutMs` (shared by both paths) | `inprocess.launchQueueTimeoutMs` (default **900000** = 15 min) |

Never fall back across columns: in-process limits are read from
`subagents.inprocess.*` only, never from the `legion.*` keys.

### Renewing a budget casualty (#270)

An agent's `timeoutMs` is enforced by the host, so pi-legion cannot prevent the
cut — but it can make the loss recoverable. When a child is terminated **and**
it measurably progressed, the completion notice ends with a ready-made command:

```
✗ W2 (worker) failed (terminated during tool call)
progressed: 47 tool results, 12 assistant messages, 6 files changed
renew: subagent({ action: "continue", name: "W2", message: "<what to continue>" })
renewals: 1/2
```

Renewal is `continue` — there is no separate action — so the child resumes from
its own session file with its context intact. It is **never automatic**: an
auto-renewed stuck child would hold a concurrency slot indefinitely.

Two role frontmatter keys control it:

| Key | Default | Meaning |
|---|---|---|
| `renewable` | `true` | `false` for roles where a timeout means the task was mis-scoped (a timed-out `scout` is a search that was too broad, not work to finish) |
| `maxRenewals` | `2` | `0` disables renewal. Each renewal is a **fresh full budget**, never an increment |

"Progressed" means ≥ 3 new `toolResult` rows or ≥ 1 changed file since the last
baseline — `assistant` messages are shown but never count: a model looping on the
same sentence grows that counter without doing any work. With no progress the
notice says so instead of offering the command, and once the budget is spent it
tells you to split the task.

`wait`/`collect` timeouts never produce a proposal: those return while the child
is still alive, which is the opposite situation.

### Launch admission queue (#266)

A launch that hits a **queueable** gate waits in an in-memory queue instead of
throwing `BUDGET_EXCEEDED`, and is admitted automatically when a slot frees. The
caller gets `▶ scout-7 (scout) supervisor=inprocess queued(3)` back immediately
and treats the work as dispatched.

| Gate | Queued? | Why |
|---|---|---|
| `inprocess.maxChildrenPerNode` | ✅ | pure concurrency: the slot always frees |
| `inprocess.maxActive` | ✅ | same |
| `legion.maxChildrenPerNode` (`max_children_per_node`) | ✅ | same, RPC path |
| `legion.maxActiveNodes` (`max_active_nodes`) | ✅ | same, RPC path |
| `maxDepth` / `maxSpawnsPerSession` / ledger `max_depth` | ❌ | waiting cannot satisfy them; a queue would disguise a permanent failure as a 15-minute delay |
| `maxChildrenPerNode: 0` | ❌ | 0 means "no children at all" — impossible to satisfy |
| `parent_not_found`, memory gate, `NAME_TAKEN`, unknown/disabled role, `inprocess`+`worktree`, model scope | ❌ | not a concurrency gate |

The two queue bounds are **shared** by both backends on purpose: one scheduler,
not one per spawn mode. Overflow is an immediate hard refusal
(`launch queue overflow (32/32)`), a timeout is reported as
`launch queue timed out after Ns ('<name>')`, and **neither ever creates a
ledger row, a run directory, a worktree or a session file** — a queued launch has
reserved nothing yet.

Admission is event-driven (a child reaching `retired`/`exited` frees its slot)
with one `unref`'d fallback recheck, because the ledger can also be freed by
another process. An `idle` child (turn ended, not yet collected) **still holds
its slot**, exactly as before.

Known limit: the queue is in memory, so a process restart drops it. The leftover
`queued` records in `run.json` are inert — `collect`/`steer` on one says
`never started: the launch queue was lost …` instead of `unknown child`, and
`stop` cleans it up.

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
node id, db path, acceptance role, `allowNested`, `utility`, `spawnMode` (the
arbitrated backend, for self-reporting), the per-child `budget`, and the nested
parent path. The guards and the legion runtime read that context, and
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
         ├─ worktree ⇒ rpc       → RpcSupervisor   (unchanged)
         └─ otherwise            → InProcessSupervisor
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

## Observability: live token rate during the first run

`spawnChild` returns as soon as the child **accepts** the first prompt, not when
that turn ends (#227 D1). Acceptance is read off the child transcript — a user
line for this turn appearing past the size recorded at spawn time (`F7`: the SDK
appends the user message before it runs the agent) — with
`DEFAULT_INPROCESS_SPAWN_START_TIMEOUT_MS` (15s, injectable as
`spawnStartTimeoutMs`) as a bound that is **not** an error: on expiry the handle
is still returned and `onSpawnDelayed` is called once. The turn itself keeps
running on a background drain, inside the child's identity scope.

The one exception is **rejection before acceptance** (#227 D1a): no model, no
API key, or a compaction in progress makes the SDK throw before it appends the
user message, so nothing ever lands in the transcript. In that case
`spawnChild` still **throws** `SubagentError(..., START_FAILED)` and rolls the
child back rather than returning a handle. That is deliberate: `Orchestrator`
only retries the next `fallbackModels` entry when the spawn throws
(`canFallbackStart`), so returning a handle there would silently disable the
fallback chain. A turn that was accepted and *then* failed stays a runtime
failure: the handle is returned, `SettleResult.reason` reads
`child turn failed: …`, and `onSpawnRefused` reports it.

So the *reason* the ledger needs a direct read has changed, but the read is
still required. Two windows remain uncovered by `statusEntryFromJob`:

1. **Before acceptance** (normally milliseconds, up to the start bound): the
   launch has not yet written `node_launched` / `recordChild`, so no job exists.
2. **From acceptance to settle**: the job exists, but its usage columns stay
   empty until the turn ends — `pollUsage` only samples nodes that are already
   `running`, and a spawning node is `starting`.

During window 2 the ledger row still carries no live token rate, so the status
board keeps seeing only the ledger node row. That row must still render a live
token rate, which needs two facts the ledger does not carry during a run:

| Fact | Ledger during a run | Source used instead |
|---|---|---|
| `tokensOut` | empty until settle: `pollUsage` skips nodes whose status is not `running`, and a spawning node is `starting` | `nodes.session_file` parsed directly |
| `generationMs` | never stored (`usage` has no such column) | same session parse |

Reading `node.sessionFile` stays correct for the same underlying reason as
before: the transcript is the only live source while the turn runs. What changed
is that the child is no longer *invisible* to the orchestrator for the whole of
its first turn — only its **usage ledger** still lags.

`statusEntryFromNode` reads `node.sessionFile` through `progressFromSessionFile`
for both, falling back to the ledger for nodes with no session file (rebuilt or
foreign rows). Without this the railway header showed `0 tok/s` for the whole
in-process lifetime while `rpc` looked correct.

`generationMs` itself is the sum of measured model-call lengths
(`message.durationMs`, or entry-to-entry write times). It must never be derived
from the nested `message.timestamp`, which marks when generation *started* and
yields only prompt-to-first-token latency — that mistake pinned the denominator
near zero, so `tok/s` silently fell back to a wall-clock window and stopped being
a decode rate.

## Refusals

- A non-centurion requesting `worktree: true` is **not** a refusal: it is
  downgraded to `worktree: false` with a one-time warning (#214), so the launch
  proceeds in-process. `worktree` is reserved for `centurion`.
- `worktree: true` reaching the supervisor with a pinned in-process backend →
  `INVALID_PARAMS`. Unreachable from a card now that the field is gone; kept as
  the last line against an internal caller building that shape.
- Unknown frontmatter (including a leftover `spawnMode:`) → loud throw at parse
  time

## Tests

See `test/unit/inprocess-supervisor.test.ts` (mock session) and settings parse coverage in `test/unit/spawn-mode-settings.test.ts`.
