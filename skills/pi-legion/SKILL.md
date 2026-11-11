---
name: pi-legion
description: "Use the subagent tool to delegate to a loaded role; use centurion for recursive squads and /legion to inspect the tree. Pi Legion v2 runs children in-process by default (rpc only for a worktree-owning centurion) and records their shared tree state in legion.db."
---

# Pi Legion

Use the `subagent` tool to delegate to a matching loaded role. Prefer the
specific role that fits the task; use a `centurion` when the task needs a
recursive team, a frozen squad contract, and a tree-shaped delivery. Do not
launch child processes manually.

## Dispatch

```text
subagent({ agent: "scout", task: "<question list>" })
subagent({ agent: "worker", task: "<task card>" })
subagent({ agent: "centurion", task: "<目标 + 验收清单>" })
subagent({ tasks: [
  { agent: "worker", task: "<lane A>" },
  { agent: "worker", task: "<lane B>" },
] })
```

The loaded roles are whatever `subagent({ action: "list" })` reports; this
package bundles only three of them — `centurion`, `worker`, and `scout`.

That is the dispatch path: Pi Legion starts children as `AgentSession`s inside
the parent process under a tree-aware supervisor; only a worktree-owning
`centurion` becomes a separate `pi --mode rpc` process (a real `pi` TUI in an
`hc` terminal). A `centurion` leads its own squad and
may recursively dispatch when its role and inherited depth budget allow it;
ordinary roles should not be assumed to have that permission. Give every child
a concrete task and acceptance criteria. Children communicate through the
Legion tools, not by starting another runtime or editing the shared tree ledger
directly.

## Legion visualization

In an interactive Pi session, bare `/legion` opens the **galaxy / tok-s / log**
full view (when a viz snapshot is available and you did not pass `--tree`).
Tab switches panes; arrows move or scroll; Enter selects an agent; `o` opens
its live overlay; `q` or Esc closes. `/legion --tree` opens the classic paged
tree (`j`/`k`, Enter/Space fold, `/` search, PageUp/PageDown). `/legion <name>`
opens a node overlay directly; if short names are ambiguous, use the full node
ID from completion. `/legion status` prints the caller's whole subtree in chat:
every node's line format is `legion_tree`'s (`formatTree`), but the command wraps
it with a `Legion status · N nodes` header, an optional `Live jobs not in the
tree:` section, and a `One node: /legion status <name>` footer — and its range is
the full subtree, while the tool's default is `scope="children", depth=1` (direct
children only). `/legion status <name>` prints one node like
`subagent({ action: "status", name })`: same renderer, same fields, when a
run-store record exists (the tool prepends `resolved: …` when that record lives
in another run); with no record the command falls back to the node's own fields.
Esc closes an overlay and unsubscribes its live feed. OSC 8 links are visual
anchors only.

To stop live children yourself: `/legion stop` (or `/legion stop <name>`), idle
Esc with an empty editor (confirm "Stop N running subagents?"), or `x` then `y`
on the selected live agent in the `/legion` view or overlay.

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

When a squad declares the built-in machine, its four work phases are
**planning → implementing → reviewing → verifying**; a squad that declares no
`phases` has no phase machine at all (no `nodes.phase`, no `legion_phase` tool).
Planning writes `.pi-legion/contract.md` with interfaces, file
ownership, and acceptance commands before implementation starts. The
executable acceptance commands are declared in one of two equivalent forms, and
markdown's own line prefixes (a `> ` quote, a `#{1,6}` heading marker, one list
marker — `- ` / `* ` / `+ ` / `N.` / `N)`) are stripped before the line is read,
so `> legion-verify: npm test` and `1. legion-verify: npm test` are the same
declaration as the bare one:

- a fenced block whose info string is exactly `legion-verify` — with backticks or
  with tildes, both are read the same:

  ```legion-verify
  npm run typecheck
  npm test
  ```

- one command per bare line, `legion-verify: <command>`:

  ```text
  - legion-verify: npm run typecheck
  > legion-verify: npm test
  ```

What the supervisor then does with a contract is exactly one of four things:

| the contract… | result |
|---|---|
| declares either legal form above — a fenced block with info string exactly `legion-verify` on a backtick or a tilde fence, or a `legion-verify: <command>` line behind any of those prefixes | the declared commands RUN under the supervisor |
| OPENS a line with `legion-verify` in a shape nothing reads — a `## legion-verify` heading (quoted or not), or a fence whose info string carries extra words, e.g. info string `legion-verify bash` on a backtick or a tilde fence | verification FAILS; the team stays in `verifying` |
| mentions `legion-verify` mid-sentence only ("use the legion-verify block") | IGNORED: no command runs, and by contract (§7.3) that is a pass |
| never mentions it, or declares an empty fence block / an empty `legion-verify:` line | 0 commands, and by contract (§7.3) a pass |

`0 commands` is not a green: it means there is no evidence, not that something
failed. It is a pass by contract (§7.3 — the usual read-only case), the report
has to say so instead of claiming a check happened, and it is never by itself a
reason to hold a team back — only row 2 fails. Reviewing
uses independent review; verifying runs the contract's `legion-verify`
commands under the supervisor, without an LLM deciding whether they passed.

## Delivery, resume, and isolation

A centurion owns a Git worktree for its subtree; squad members share that
worktree, and a nested centurion gets a nested Git worktree. Each squad
squashes its subtree onto a branch for its parent — the branch is the deliverable, and an
MR is added only when the repository has a remote. Deliveries move upward until the root
reviews and merges into the default branch. Do not merge a child squad's work
at the wrong level. Stage the delivered paths explicitly — `git add -A` sweeps
run artifacts and duplicate contract copies into the branch.

Resume uses saved run records and Pi session files. Parent shutdown does not
leave detached child processes; recovery follows the tree's resume chain.
Keep the run/session records while the squad may need to resume. The
`legion.db` file is a machine-owned shared ledger: use `legion_mail`,
`legion_tree`, and `legion_phase`, not direct database access.

A Git worktree is workspace separation, not a security sandbox. Read-only
checks remain guardrails rather than a process boundary; never rely on them to
protect against intentional writes. Pi Legion runs `kind: pi` roles only; the
`kind` frontmatter key is still legal but `pi` is the only accepted value.

## Later control

Steer, inspect, collect, resume, or retire children with the `subagent` tool:

```text
subagent({ action: "status", name: "worker-0" })
subagent({ action: "collect", name: "worker-0" })
subagent({ action: "wait", all: true })
subagent({ action: "wait", name: "worker-0" })
subagent({ action: "steer", name: "worker-0", message: "Focus on the parser tests." })
subagent({ action: "resume", name: "worker-0" })
subagent({ action: "retire", name: "worker-0" })
```

`wait` always needs a target: pass `all: true` for every live child, or `name`
for one child (mutually exclusive). A bare `action: "wait"` is rejected.

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
