# Declarative phase machine (v5)

Status: draft, layer 3 (#298).

## Problem

The legion phase machine is hard-coded in three places that must agree:

| Place | Hard-codes |
| --- | --- |
| `src/legion/state-machine.ts:1` | The seven phase names and every transition rule |
| `src/agents/settings.ts:117` | A duplicate copy of the phase names, for `phaseTimeouts` validation |
| `src/extension/legion-tools.ts:47` | The `legion_phase` tool's `to` enum |

Worse, the *rules inside a phase* are keyed on **role names**:

```text
implementing → reviewing   requires every `role === "worker"` to be settled
reviewing    → verifying   requires a settled `role === "reviewer"` with verdict ok:true
planning     → implementing requires no `role === "planner"` still running
```

So a team cannot re-shape its workflow without editing source, and a role that
merely *exists* acquires workflow meaning. "worker" is not "a worker" — it is a
specific slot in a fixed pipeline.

## Goal

A centurion declares its team's phases and the conditions for leaving them.
Defaults preserve today's behaviour exactly, so an undeclared machine is the
four-phase pipeline above.

## Non-goals

- Arbitrary scripting. Conditions are a closed vocabulary of predicates, not code.
- Per-node machines. One machine per team root; children inherit it read-only.
- Changing how children are spawned. Phases gate *progress*, not dispatch.

## Where the declaration lives

Role frontmatter, on the team root card:

```yaml
---
name: centurion
phases:
  - id: planning
    require: [contract_file]
    next: [implementing]
    timeoutMs: 900000
  - id: implementing
    require: [children_settled]
    next: [reviewing, failed]
  - id: reviewing
    require: [verdict_ok]
    next: [verifying, implementing]
  - id: verifying
    require: [verification_passed]
    next: [done]
---
```text

Kept on the card rather than in `settings` because the machine is a property of
*this team*, like its roster — two centurions in one settings file may run
different workflows.

Resolution order: card `phases` → `settings.legion.phases` → built-in default.

## Condition vocabulary

A condition answers "may this node leave phase X for phase Y?" over a snapshot of
the node and its children. Closed set, each with one meaning:

| Condition | True when |
| --- | --- |
| `contract_file` | `contract_path` is set and the file exists and is non-empty |
| `children_settled` | every child of this node is terminal (settled/failed/retired) |
| `children_none_failed` | no child is `failed`, or every failed child is listed in `handled` |
| `verdict_ok` | some settled child's last turn parsed to `{ok: true}` |
| `verdict_not_ok` | some settled child's last turn parsed to `{ok: false}` |
| `verification_passed` | the node's stored verification result is `pass` |
| `verification_failed` | the node's stored verification result is `fail` |
| `rework_available` | `rework_count < maxRework` |
| `children_all_failed` | there is ≥1 child and all are `failed` |
| `always` | unconditional |

`require` is a conjunction: all listed conditions must hold.
`next` is the allowed successor set; a transition to anything outside it is
refused with `invalid_transition`.

**Role names do not appear anywhere.** `verdict_ok` asks "did any settled child
return ok:true", not "did the reviewer". That is what lets `worker` become a
general worker.

## Terminal phases

Exactly three are terminal and are always available regardless of `next`:

- `done` — only when the phase's `require` holds
- `failed` — parent decision, all children failed, or rework exhausted
- `aborted` — parent retire only

`aborted` is the emergency stop, so a parent retire must land even when the
transition itself cannot be resolved (#351). The abort asks the machine that the
node's **role card** declares; if no machine can be resolved for the node's
current phase name, the retire is forced anyway: the phase becomes `aborted`, one
`phase_change` event carries `{ forced: true, reason:
"parent_retire_unresolved_phase", denied: "<reason>" }` (no new event type — the
set stays closed at 16), and one warning names the node, the phase and the
refusal. Silently dropping the abort is what made a team unstoppable.

## Safety rails (unchanged)

These are invariants, not configuration:

- A new team starts in the machine's **first** phase.
- `rework_count` still caps at `maxRework` (default 2).
- `centurion`-only gates stay: a child cannot advance the team.
- Phase timeouts still only *report*; they never kill work.
- A declared machine is validated at load time. Unknown condition, empty `next`,
  duplicate id, unreachable phase, or a terminal phase used as a start → the card
  is rejected (same posture as unknown frontmatter).

## Migration

The default machine reproduces today's table, so no behaviour change without a
declaration. The role-name predicates become condition predicates:

| Old rule | New condition |
| --- | --- |
| all `worker` settled before reviewing | `children_settled` |
| settled `reviewer` with ok:true | `verdict_ok` |
| no `planner` still running | covered by `children_settled` |
| verification pass before done | `verification_passed` |

Once this lands, `planner` and `reviewer` stop being load-bearing and their
bundled cards can be deleted.
