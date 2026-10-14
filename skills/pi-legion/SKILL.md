---
name: pi-legion
description: "Use the subagent tool to delegate to a loaded role; use centurion for recursive squads and /legion to inspect the tree. Pi Legion v2 runs headless Pi RPC children and records their shared tree state in legion.db."
---

# Pi Legion

Use the `subagent` tool to delegate to a matching loaded role. Prefer the
specific role that fits the task; use a `centurion` when the task needs a
recursive team, a frozen squad contract, and a tree-shaped delivery. Do not
launch child processes manually.

## Dispatch

```text
subagent({ agent: "search", task: "<query>" })
subagent({ agent: "worker", task: "<task card>" })
subagent({ agent: "centurion", task: "<目标 + 验收清单>" })
subagent({ tasks: [
  { agent: "reviewer", task: "<lane A>" },
  { agent: "reviewer", task: "<lane B>" },
] })
```

That is the dispatch path: Pi Legion starts headless `pi --mode rpc` child
processes under a tree-aware supervisor. A `centurion` leads its own squad and
may recursively dispatch when its role and inherited depth budget allow it;
ordinary roles should not be assumed to have that permission. Give every child
a concrete task and acceptance criteria. Children communicate through the
Legion tools, not by starting another runtime or editing the shared tree ledger
directly.

## Legion visualization

In an interactive Pi session, `/legion` opens the paged Legion tree. Navigate
with `j`/`k` or the arrow keys, use Enter/Space to expand or collapse, `/` to
search, and PageUp/PageDown to scroll; `q` or Esc closes the tree. Press `o` on
the selected node, or use a component-routed mouse click in the full-screen
tree, to open its live overlay. `/legion <name>` opens a node directly. If
short names are ambiguous, use the full node ID shown in command completion.
`/legion status` prints the whole tree in the chat (the same lines as
`legion_tree`). `/legion status <name>` prints one node with the same text as
`subagent({ action: "status", name })`. Esc closes an overlay and unsubscribes
its node's live feed. OSC 8 links are visual anchors only; they do not open
overlays or route clicks.

## Tree tools and phases

Child nodes have access to:

- `legion_mail` for asynchronous messages along permitted parent/child/sibling
  tree edges. Cross-squad mail must be routed through the relevant centurions;
  there is no direct bypass to the root.
- `legion_tree` for read-only machine state. Observation does not interrupt the
  node being observed.
- `legion_phase` for centurions to request a phase transition. The supervisor
  validates and records the transition; do not claim a phase change from chat
  text alone.

A squad's four work phases are **planning → implementing → reviewing →
verifying**. Planning writes `.pi-legion/contract.md` with interfaces, file
ownership, and acceptance commands before implementation starts. Reviewing
uses independent review; verifying runs the contract's `legion-verify`
commands under the supervisor, without an LLM deciding whether they passed.

## Delivery, resume, and isolation

A centurion owns a Git worktree for its subtree; squad members share that
worktree, and a nested centurion gets a nested Git worktree. Each squad
squashes its subtree into an MR for its parent. MRs move upward until the root
reviews and merges into the default branch. Do not merge a child squad's work
at the wrong level.

Resume uses saved run records and Pi session files. Parent shutdown does not
leave detached child processes; recovery follows the tree's resume chain.
Keep the run/session records while the squad may need to resume. The
`legion.db` file is a machine-owned shared ledger: use `legion_mail`,
`legion_tree`, and `legion_phase`, not direct database access.

A Git worktree is workspace separation, not a security sandbox. Read-only
checks remain guardrails rather than a process boundary; never rely on them to
protect against intentional writes. Pi Legion v2 supports `kind: pi`; for a
role that requires a non-Pi CLI, use the Herdr-era 0.16.x release line rather
than expecting v2 to launch it.

## Later control

Steer, inspect, collect, resume, or retire children with the `subagent` tool:

```text
subagent({ action: "status", name: "worker-0" })
subagent({ action: "collect", name: "worker-0" })
subagent({ action: "steer", name: "worker-0", message: "Focus on the parser tests." })
subagent({ action: "resume", name: "worker-0" })
subagent({ action: "retire", name: "worker-0" })
```

A person can read that same status without a tool call: `/legion status` for
the tree, `/legion status <name>` for one child.

For a blocked extension UI request, the RPC supervisor bubbles the request up
to the root Pi UI for human response by default. A child completion or a
`legion_mail` message is not a substitute for checking its saved result and
machine-recorded state.

`pi --print` and JSON mode wait for live async children during session
shutdown, up to each child's turn timeout. That keeps a just-spawned child
from being retired before its first assistant message. To put the child's
result in the same print turn, use `wait`, `collect`, or `async: false`.
