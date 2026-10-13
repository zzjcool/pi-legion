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

## Contents

- [Architecture](#architecture)
- [Quick start](#quick-start)
- [Legion tools and phases](#legion-tools-and-phases)
- [Three-layer visualization](#three-layer-visualization)
- [Settings and budget gates](#settings-and-budget-gates)
- [Delivery and resume](#delivery-and-resume)
- [Herdr transition and role migration](#herdr-transition-and-role-migration)
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

The `subagent` control actions include event-driven `wait` and graceful `stop`:
`subagent({ action: "wait", name: "worker-0" })` returns as soon as the child
settles (or the parent turn is interrupted with Esc). Aborting a parent turn
with Esc gracefully retires its tracked children, including those being waited
on or collected; the cascade is silent. To stop children explicitly, use
`subagent({ action: "stop", name: "worker-0" })` or
`subagent({ action: "stop", all: true })`; this runs the normal graceful-retire
sequence for each selected child.

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
   tokens and share are overlaid), `o` opens its live overlay, Esc clears the
   selection, `q`/Esc closes. Layouts: wide (≥140 cols), stacked, and portrait
   (<80 cols, or tall and <100 cols). `/legion --tree` opens the classic tree
   (`j`/`k`, Enter/Space fold, `/` search, PageUp/PageDown).
3. **Live overlay:** press `o` on the selected node, use a component-routed
   mouse click in the strip or classic tree, or open it directly with `/legion <name>`.
   The overlay subscribes to that node's live feed only while open; Esc closes
   it and unsubscribes. OSC 8 links are visual anchors only, not overlay links.

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
execution model.

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

MIT. See [LICENSE](LICENSE).
