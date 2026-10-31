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

## The advisory clock and the completion gate (#358)

Two supervisor-side paths used to read the built-in phase vocabulary only:

- **The clock.** `checkOwnPhaseTimeout` resolved `settings.phaseTimeouts[phase] ??
  DEFAULT_PHASE_TIMEOUTS[phase] ?? 0`. `DEFAULT_PHASE_TIMEOUTS` is keyed by the four
  built-in names, so a declared phase got `0` — "never warn" — and `PhaseDefinition.timeoutMs`
  was dead config. Resolution order is now: explicit operator override
  (`settings.legion.phaseTimeouts`) → card `timeoutMs` → built-in default → `0` (never warn).
  The operator stays first because a machine must not be able to take away a limit the
  operator set — **"explicit" is the load-bearing word**: the run-time settings object has
  every default filled in, so "the key is present" is not an operator decision, and a
  resolver that reads the filled value puts a clock of 60m on `implementing` whether or not
  anyone ever wrote one down. That is what made this order a fiction on the four built-in
  names (the case a card is most likely to declare) until the explicitness the settings
  parser already records was carried through the fill. Behaviour change worth naming: a
  card that declares `timeoutMs` on `planning`/`implementing`/`reviewing`/`verifying` now
  really wins over those defaults; with no card value and no explicit setting the four
  built-in numbers are unchanged (15m / 60m / 30m / 15m). Timeouts still only *report*.
- **The completion gate.** `finalizeVerifiedTeamIfReady` hard-coded `phase === "verifying"`
  and evaluated `verifying → done` against the built-in machine. It now asks the machine
  which phase judges success: a phase with an exit to `done`, preferring an edge that
  requires `verification_passed`, otherwise the **last** declared candidate (declaration
  order is pipeline order, and the built-in machine's answer is `verifying`). A team with
  no declared machine, or a machine with no exit to `done`, keeps the literal `verifying`.
  **`phases:` order is pipeline order, and the derivation depends on it.** When more than
  one phase can reach `done`, "the last declared candidate" is the one that completes the
  team — a card that lists its phases in some other order moves the completion gate with
  the declaration, not with the workflow, so the phase that really ends the pipeline would
  never be collected from. Declare phases in the order the work happens; the tests pin
  both the assumption (`test/unit/legion-custom-phase-finalize.test.ts`, "declaration
  order, not pipeline order…") and the control that a non-final phase cannot complete a
  team.

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
