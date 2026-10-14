---
name: pi-legion
npm: "pi-legion"
description: "Pi Legion v2: recursive centurion trees on headless Pi RPC; shared SQLite WAL legion.db. Four-stage planning/implementing/reviewing/verifying state machine, parent/child/sibling legion_mail, three-layer /legion UI, upward MR trees, squad resume."
---

# pi-legion

A Pi extension for building recursive, resumable agent teams. A `centurion`
leads each squad; Pi RPC runs its children as headless processes, while a
shared SQLite ledger records the whole tree.

> **Name note.** This package was formerly published as
> `@zzjcool/pi-herdr-subagents` (through 0.14.3; renamed after an npm name
> collision), then as `pi-herdr-swarm` (0.15.0), before becoming `pi-legion`
> in 0.16.0. **2.0.0: the legion era — recursive centurion tree on pi RPC transport; herdr pane execution archived to legacy**
>
> **What changed in 2.x?** See [CHANGELOG.md](CHANGELOG.md) (Keep a Changelog). Published notes also land on [GitHub Releases](https://github.com/zzjcool/pi-legion/releases).

## Contents

- [Architecture](#architecture)
- [Quick start](#quick-start)
- [Legion tools and phases](#legion-tools-and-phases)
- [Three-layer visualization](#three-layer-visualization)
- [Settings and budget gates](#settings-and-budget-gates)
- [Scout guard](#scout-guard)
- [Team 配置](#team-配置)
- [Parent/child context conventions](#parentchild-context-conventions)
- [Delivery and resume](#delivery-and-resume)
- [Herdr transition and role migration](#herdr-transition-and-role-migration)
- [Changelog](CHANGELOG.md)
- [Development](#development)

## Architecture

```text
User (CEO) — root Pi session (TUI)
├─ pi-legion extension
│  ├─ LegionSupervisor (root)
│  │  ├─ RpcClient × N → headless `pi --mode rpc` child processes
│  │  ├─ mail postman (inbox delivery) + four-phase state machine
│  │  └─ orphan scan + child lifecycle / usage accounting
│  ├─ `legion.db` (one shared SQLite/WAL tree ledger)
│  └─ LegionEventBus → resident tree | `/legion` full view | live overlay
└─ centurion child (RpcClient; cwd = its subtree worktree)
   └─ pi-legion in child mode
      ├─ LegionSupervisor for this squad
      ├─ `legion_mail` / `legion_tree` / `legion_phase` tools
      ├─ worker / scout / reviewer … children (`worktree: false`)
      └─ nested centurions → recursive squads
```

Transport, state, decision-making, and display are separate layers:

- **Transport:** each child is a headless Pi RPC process managed by a
  `LegionSupervisor`; a centurion can supervise another squad recursively.
- **State:** all nodes in the tree share the `legion.db` SQLite ledger in WAL
  mode. Per-run `run.json` records and session files remain the resume source
  for each child.
- **Decision:** centurions and squad members do the LLM work. The supervisor
  owns machine state and validates phase transitions.
- **Display:** the event bus feeds the resident tree, the `/legion` full view,
  and an on-demand live overlay.

## Quick start

Install and load the extension in Pi:

```bash
pi install npm:pi-legion
```

Ask a `centurion` to lead a recursive squad, with a goal and concrete
acceptance checklist in its task:

```text
subagent({
  agent: "centurion",
  task: "Goal: implement the account export flow. Acceptance: contract is recorded; implementation is reviewed; the verification commands pass; return a squash MR and verdict."
})
```

The centurion plans the work, writes the squad contract, dispatches ordinary
roles such as `worker`, `scout`, and `reviewer`, and coordinates the squad
through its phases. For a single leaf task, dispatch an ordinary role directly:

```text
subagent({ agent: "scout", task: "Map the export code path and report relevant files and risks." })
```

No manual child-process launch is needed. Use `/legion` to inspect the tree;
see [Three-layer visualization](#three-layer-visualization) for navigation.
`/legion status` prints that tree in the chat, and `/legion status <name>`
prints one node — see [Status](#status-legion-status).

The `subagent` control actions include event-driven `wait` and graceful `stop`:
`subagent({ action: "wait", name: "worker-0" })` returns as soon as the child
settles (or the parent turn is interrupted with Esc). Aborting a parent turn
with Esc gracefully retires its tracked children, including those being waited
on or collected; the cascade is silent. Launch stays async by default. Under
`pi --print` or JSON mode the process would otherwise exit at the end of the
parent turn and retire those children before they write an assistant message.
That shutdown waits for each live async child to settle, bounded by the
child's turn timeout, and only then retires whatever is still running. A
child killed by that shutdown is recorded as aborted because the parent
session shut down, not because the model produced no reply. To include the
child's result in the same print turn, call `wait` or `collect` before the
turn ends, or launch with `async: false`. To stop children explicitly, use
`subagent({ action: "stop", name: "worker-0" })` or
`subagent({ action: "stop", all: true })`; this runs the normal graceful-retire
sequence for each selected child.

### Stopping async subagents yourself

Async children keep running after the main turn ends, so Esc-abort no longer
reaches them. Three user controls run the same graceful `stop` (a stopped
parent retires its own subtree on shutdown):

- **`/legion stop`** stops every live subagent; **`/legion stop <name>`** stops
  one (`all` is an alias for no name). Names complete from the live children;
  nested agents complete as `parent/name` and are reported as owned by their
  parent (stop the parent to retire them).
- **Esc** while the main agent is idle, the editor is empty, no dialog or
  overlay is open and subagents are live asks "Stop N running subagents?".
  In every other state Esc keeps pi's normal behaviour.
- **`x`** on the selected live agent in the `/legion` view or its live
  overlay asks `y` to confirm in place, then stops it.

While the main agent is idle and subagents are live, the railway header shows
a dim `esc stop all · /legion stop [name]` hint (shortened on narrow terminals,
hidden while the main agent is working).

### Status (`/legion status`)

The railway and `/legion` view are TUI surfaces. `/legion status` is the chat
snapshot of the same tree:

- `/legion status` prints every node with the same lines as `legion_tree`
  (`id role=… status=… phase=… model=… depth=…`), plus a count of each status.
  Live jobs that are not in the tree yet are listed under that summary.
- `/legion status <name>` prints one node with the same text as
  `subagent({ action: "status", name })`. Living children lead with
  `alive · quiet Ns` (session JSONL mtime); after ~30s of silence the line
  becomes `alive · quiet Ns (living)` so 「活着但安静」is obvious. Run-store
  execution/acceptance fields are labeled snapshots, and collect-deadline /
  transient-connection reasons are omitted from the snapshot line while the
  child is alive so they do not steal attention from quiet age. A ledger-only
  node still uses the same renderer with the fields the tree has.
- Quiet age is not a heartbeat: there is no child-side progress ping. Minutes
  of silence can still mean the model is reasoning (especially high-thinking
  turns). Quiet alone does not mean the child is stuck; pair it with `alive`.
- Both forms work outside the TUI. A short name that matches more than one
  node needs the full node id (`/legion status <node-id>`).

## Legion tools and phases

Child nodes receive these tree-aware tools:

```text
legion_mail({ to, subject, body, kind?, urgency? })
legion_tree({ scope?: "children" | "squad" | "subtree" | "tree", depth? })
legion_phase({ to, note?, evidence? })
```

- **`legion_mail`** sends asynchronous messages over permitted tree edges:
  parent, children, or same-parent siblings. `to` may be a short name, node ID,
  `parent`, `children`, or `squad`. Cross-squad direct mail and bypassing the
  parent are refused; route cross-squad requests through the relevant
  centurions. Keep large artifacts in the shared worktree and mail a file
  pointer. The body has a 4 KB soft limit and a 32 KB hard limit.
- **`legion_tree`** is a read-only view of machine-recorded node state. It does
  not interrupt the nodes being observed.
- **`legion_phase`** is available to centurions. It requests a state transition;
  the supervisor checks the transition's invariants and records the result.

A squad moves through **planning → implementing → reviewing → verifying**.
Planning produces a non-empty `.pi-legion/contract.md` with file ownership
and acceptance commands. During reviewing, an independent reviewer supplies
the judgment; in verifying, the supervisor runs the contract's `legion-verify`
commands without an LLM. Passing verification advances the squad to `done`.

## Three-layer visualization

1. **Railway strip above the input:** one git-graph lane per live subagent
   (max 4, 3 below 80 columns; oldest/shallowest first, `+N` for the rest).
   When an agent ends its lane merges back and lower lanes shift up. The
   header shows the live count and tok/s (trailing 60s average). Hidden when
   no subagent is live. Set `PI_LEGION_STRIP=tree` for the classic roster.
2. **`/legion` full view:** galaxy graph of the agent tree, stacked tok/s
   chart by agent type (peak marker, now/avg/peak/total, per-role share), and
   a scrollable `log --graph` history. Tab switches panes, arrows scroll or
   move the selection, Enter selects an agent (its own rate line, tok/s,
   tokens and share are overlaid), `o` opens its live overlay, `x` stops it
   (confirm with `y`), Esc clears the
   selection, `q`/Esc closes. Layouts: wide (≥140 cols), stacked, and portrait
   (<80 cols, or tall and <100 cols). `/legion --tree` opens the classic tree
   (`j`/`k`, Enter/Space fold, `/` search, PageUp/PageDown).
3. **Live overlay:** press `o` on the selected node, use a component-routed
   mouse click in the strip or classic tree, or open it directly with `/legion <name>`.
   The overlay subscribes to that node's live feed only while open; Esc closes
   it (returning to `/legion` when opened from there) and unsubscribes; `x`
   stops the agent after a `y` confirmation. OSC 8 links are visual anchors only, not overlay links.

## Settings and budget gates

Add the v2 `legion` block to `~/.pi/agent/settings.json` or the project
`.pi/settings.json`, merging it with any existing `subagents` keys:

```json
{
  "subagents": {
    "legion": {
      "maxDepth": 4,
      "maxChildrenPerNode": 8,
      "maxActiveNodes": 30,
      "phaseTimeouts": {
        "planning": 900000,
        "implementing": 3600000,
        "reviewing": 1800000,
        "verifying": 900000
      },
      "verifyCommandTimeoutMs": 600000,
      "mailRatePer5Min": 10,
      "usagePollMs": 30000,
      "orphanStaleMs": 90000
    }
  }
}
```

The three launch budget gates are enforced against the tree ledger:

| Gate | Setting | Default | Limit |
| --- | --- | ---: | --- |
| Depth | `maxDepth` | 4 | Maximum tree depth; the hard cap is 4 (`MAX_NESTED_PATH_ENTRIES`). |
| Fan-out | `maxChildrenPerNode` | 8 | Direct children for one node. |
| Concurrency | `maxActiveNodes` | 30 | Whole-tree `running` + `starting` nodes. |

The effective tree depth cap is bounded by the operator override,
`subagents.legion.maxDepth`, and the hard cap of 4. **INCL semantics:** a
launched role's `maxSubagentDepth = R` counts generations in that role's
subtree, including itself; when launched by a parent at depth `d`, it inherits
`C_child = min(C_parent, d + R, 4)` (`R = 1` makes it a leaf), so it can tighten
the inherited cap but cannot widen it.

### Scout guard

`subagents.scoutGuard` watches the main session. After `threshold` consecutive
read-like tool calls with no `subagent` launch or `vexillatio` call in
between, it injects one follow-up reminder and then waits out `cooldownMs`.
It is on by default. Set it in `~/.pi/agent/settings.json` or the project
`.pi/settings.json`; a project file overrides the same fields from the user
file.

```json
{
  "subagents": {
    "scoutGuard": {
      "enabled": true,
      "threshold": 8,
      "cooldownMs": 120000
    }
  }
}
```

| Field | Default | Meaning |
| --- | ---: | --- |
| `enabled` | `true` | Count and remind. `false` skips the guard until it is turned back on. |
| `threshold` | `8` | Consecutive read-like calls before one reminder. Positive integer. |
| `cooldownMs` | `120000` | Quiet period after a reminder, in milliseconds. Integer ≥ 0. |

`/scout-guard` turns the guard on for this session and `/no-scout-guard`
turns it off. Both override `enabled` in memory only; settings files stay
unchanged. Child sessions do not register these commands. Behavior in full
is in [docs/design.md §6.4.1](docs/design.md#641-scout-guard-subagentsscoutguard).

### Team 配置

Use `subagents.team` to select the default named team from `subagents.teams`.
The `PI_SUBAGENTS_TEAM` environment variable takes precedence over
`subagents.team`; if neither selects a named team, the full discovered roster
is used. Team definitions have a description and an ordered `members` list;
each member can be a role-name string or an object with an `agent` name and
per-member overrides. Object member overrides (for example `model` or
`thinking`) take precedence over those fields in the role card's frontmatter;
omitted override fields continue to use their normal role/configuration
values.

See [docs/subagents-teams.md](docs/subagents-teams.md) for four editable
frontend/backend × premium/value team templates. The model IDs in that template
are placeholders for your provider, not required defaults.

### Parent/child context conventions

Settings can provide `subagents.parentContext` and `subagents.childContext`
inline or through `@path` references. If either setting is omitted, Legion
looks for `subagents-parent-context.md` or `subagents-child-context.md`
respectively in the directory containing that settings file. These are
convention-based fallbacks: an explicit setting takes precedence, and setting
either field to `false` disables its context. The convention filenames are
`PARENT_CONTEXT_CONVENTION` and `CHILD_CONTEXT_CONVENTION` in
[`src/agents/settings.ts`](src/agents/settings.ts#L30-L31); missing convention
files simply contribute no context. The repository examples are
[`examples/subagents-parent-context.md`](examples/subagents-parent-context.md)
and [`examples/subagents-child-context.md`](examples/subagents-child-context.md).

### Self-diagnosis (`/legion doctor`)

When something about subagents misbehaves (model not found, spawn exit, memory
gate, missing lens tools, orphan temps, …), ask Legion rather than guessing —
same idea as `pi list` / `pi auth check`.

- `/legion doctor` — full report in the chat (works outside TUI too).
- `/legion doctor [section]` — one of: `summary`, `extensions`, `models`,
  `spawn`, `memory`, `tools`, `storage`, `runtime`, `next`.
- `subagent({ action: "diagnose" })` — same full report as tool output so the
  main agent can call it without waiting for you. The tool has no section
  field; filter with `/legion doctor [section]`.

The report is structured for the model: each section ends in **Issues** /
**Next steps** with copy-pasteable fixes (env exports, role frontmatter,
`/legion stop`, …). Spawn failures that look like a missing model also append
a short Hint automatically. **Gated auto-doctor:** on model-not-found,
`INSUFFICIENT_MEMORY`, extension load failures, and child exit during
startup / first prompt, the tool error itself includes a focused doctor
snippet (relevant sections + Next steps) so the main agent can self-fix
without anyone typing `/legion doctor`. Full `/legion doctor` remains for
manual deep dives.

Coverage:

| Section | What it checks |
| --- | --- |
| extensions | Host `packages`, resolved `--extension` paths, `--no-extensions` / inherit knobs, per-role effective extension list |
| models | Host vs child model lists, which package restores providers, team/roster gaps |
| spawn | Sample child argv, recent spawn failures + stderr, nested-spawn flags |
| memory | Free RAM, memory gate, child V8 flags, verify concurrency slots in use |
| tools | `/legion` slash list (status, team, agents, summary, on/off, scout-guard, doctor, stop), idle-Esc / strip hints, tool names |
| storage | `legion.db` sizes, orphan `rpc-child-*` temps, effective hygiene limits (default vs env), last sweep marker plus a hint when it is missing or stale |
| runtime | Live children, tree statuses, acceptance-ish / active nodes |

### Child extensions

Children start with `--no-extensions`, so they do not load the host's
discovered extensions (settings `packages`, `~/.pi/agent/extensions`, project
extensions). Each extension a child loads is a memory cost multiplied by every
concurrent child; an LSP stack is ~1 GB (#43). A child still loads pi-legion
itself (guard and nested spawning) and every path listed in the role's
`extensions` / `subagentOnlyExtensions`.

| Knob | Effect |
| --- | --- |
| role frontmatter `inheritExtensions: true` | That role loads all host extensions, as before. |
| `PI_LEGION_CHILD_INHERIT_EXTENSIONS=1` | Every child loads all host extensions, as before. |
| `PI_LEGION_CHILD_EXTENSIONS=/a.ts,/b.ts` | Extra extension paths every child loads explicitly, e.g. a provider extension the child's model needs. |

Bundled planner, reviewer, and worker do not list `lens_*` tools. pi-lens starts an LSP stack (~1 GB per child, #43) and is not part of the default `--no-extensions` child. To give a role those tools, add the tool names to its `tools:` list and point `extensions:` / `subagentOnlyExtensions` (or `PI_LEGION_CHILD_EXTENSIONS`) at the pi-lens extension file. `/legion doctor` reports `ROLE_MISSING_LENS` when a role lists the tools without that path.

### Extra agent directories

PATH-style directories scanned for agent `*.md` definitions. They load as
user-level, **below** the real user agents dir in precedence (a same-name file
in `~/.pi/agent/agents` still wins). Useful for hermetic installs (Nix store,
container, read-only mount).

| Env | Effect |
| --- | --- |
| `PI_LEGION_EXTRA_AGENT_DIRS` | Canonical name. Colon-/semicolon-separated absolute dirs (`path.delimiter`). |
| `PI_HERDR_SUBAGENTS_EXTRA_AGENT_DIRS` | Deprecated compatibility alias (kept for at least one minor version). If **both** are set, `PI_LEGION_EXTRA_AGENT_DIRS` wins and the legacy value is ignored (one stderr warning). |

### Child memory controls

| Env | Default | Effect |
| --- | ---: | --- |
| `PI_LEGION_CHILD_SEMI_SPACE_MB` | 1 | Child pi `--max-semi-space-size` (via `NODE_OPTIONS`). `0` = off. |
| `PI_LEGION_CHILD_MAX_OLD_SPACE_MB` | 1024 | Soft child heap cap `--max-old-space-size`. `0` = off. A host `NODE_OPTIONS` value wins. |
| `PI_LEGION_MIN_FREE_MEM_MB` | 1024 | Memory gate: a spawn is refused (`INSUFFICIENT_MEMORY`, plus a UI notice) when available memory minus reservations falls below this. `0` = off. |
| `PI_LEGION_CHILD_RESERVE_MB` | 160 | Per-child reservation for children still starting, so a parallel burst cannot all pass one reading. |
| `PI_LEGION_VERIFY_CONCURRENCY` | 2 | Machine-wide limit on concurrent acceptance / legion-verify commands, using slot lock files. `0` = unlimited. |
| `PI_LEGION_VERIFY_QUEUE_MAX_MS` | 1800000 | Overall queue-wait cap. After it expires the command runs without a slot. Queue wait does not count toward the command timeout. |
| `PI_LEGION_VERIFY_LOCK_DIR` | `$TMPDIR/pi-legion-verify-<uid>` | Slot directory. Set it to scope the limit more narrowly. |

The child restores the host `NODE_OPTIONS` when its extension loads, so bash
commands it runs (`tsc`, `npm test`) keep the default heap.

### Storage hygiene

Each root pi session runs one deferred, best-effort sweep of `.pi-subagents/`
at startup. A step only touches state whose owner process is gone: runs and
`rpc-child-*` temp dirs record the owner pid (`owner.json` / `.owner`). Set any
limit to `0` to disable that step.

| Env | Default | Effect |
| --- | ---: | --- |
| `PI_LEGION_HYGIENE` | on | `0`/`off` disables the whole sweep. |
| `PI_LEGION_RUN_RETENTION_DAYS` | 14 | Delete run dirs idle this long. Runs with a `worktrees/` entry are kept as resume credentials. |
| `PI_LEGION_STALE_NODE_HOURS` | 72 | Non-root ledger nodes still `starting`/`running`/`blocked` this long after their owner died are marked `failed` (`node_abandoned` event). |
| `PI_LEGION_STALE_TEMP_HOURS` | 24 | Age threshold for legacy `rpc-child-*` dirs without an owner marker. |
| `PI_LEGION_EVENT_RETENTION_DAYS` | 30 | Drop ledger events of settled/failed nodes older than this (`orphan_detected`, `budget_refused`, `node_abandoned` are kept). |
| `PI_LEGION_EVENT_MAX_ROWS` | 200000 | Soft cap on the events table. Oldest terminal-node rows are deleted first. |

The live `legion.db` gets event retention and a `wal_checkpoint(TRUNCATE)` on
session shutdown. A large delete is followed by `VACUUM`, which is skipped when
another connection holds the db.

## Delivery and resume

A centurion owns a Git worktree for its subtree; its worker/scout/reviewer
children work in that subtree, and a nested centurion gets a nested worktree.
Each subtree is delivered as a squash MR to its parent level. MRs move upward
through the tree until the root reviews and merges into the default branch.

Resuming follows the tree's saved sessions and node records. If a supervisor
process ends, its child processes do not become detached workers; resuming the
parent restores the squad, while already-settled children are not restarted.
Keep the run records and session files while the tree may need to resume.

## Herdr transition and role migration

Version **0.16.x is the final Herdr-era line**. Pi Legion 2.x is RPC-only:
child execution uses headless `pi --mode rpc` processes, and the legacy backend
is archived under `src/backends/legacy/`, not offered as a v2 runtime option.
Pin to `pi-legion` 0.16.x if a workflow must stay on the former Herdr-based
execution model. A short breaking-change summary lives in
[CHANGELOG.md](CHANGELOG.md#200---2026-10-14).

Pi Legion 2.x supports `kind: pi` only. Migrate a custom role that uses another
CLI kind by changing its frontmatter, for example:

```yaml
---
name: search
kind: pi
---
```

A non-Pi kind is rejected by v2. If that role must continue to run through
another CLI, keep it on the 0.16.x line or replace it with a Pi role.

## Development

```bash
npm install
npm run typecheck
npm test                  # unit tests
npm run test:integration  # integration tests
npm run test:all          # typecheck + unit + integration tests
```

### Mock LLM (offline pi / legion smoke)

A scriptable OpenAI-compatible server lives under [`test/mock-llm/`](test/mock-llm/README.md).
It registers with Pi like any local gateway (`models.json` → `api: "openai-completions"`),
so spawn / stop / doctor / verify paths can run without real API keys:

```bash
npm run mock-llm                 # http://127.0.0.1:8765/v1  scenario=echo
npm run test:mock-llm            # unit + integration smoke for the mock
MOCK_LLM_SCENARIO=spawn-scout npm run mock-llm
```

Use `writeMockPiHome()` from `test/mock-llm` to generate an isolated
`PI_CODING_AGENT_DIR` with dummy `apiKey: "mock"` only — never copy host
`auth.json` into fixtures.

See [CONTRIBUTING.md](CONTRIBUTING.md#project-workflow) for the project
workflow: issues, pull requests, the merge gate, and npm releases.

Version history for consumers: [CHANGELOG.md](CHANGELOG.md). Tag-by-tag
release bodies: [GitHub Releases](https://github.com/zzjcool/pi-legion/releases).

MIT. See [LICENSE](LICENSE).
