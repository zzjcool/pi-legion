# Stall candidates v1 — who may be judged, and by what fact

> Status: frozen for `#441`. Extends `stall-notice-v1` (D1/D2/D5–D9 unchanged) and
> `stall-notice-staleness-v1` (delivery side untouched). Supersedes exactly two of
> `stall-notice-v1`'s sentences: **L2's only input is no longer the clock**, and
> **a row the detector can see is not the same fact as a run that is running**.
>
> Measured regression (2026-08, 10+ mails in one day, all false):
>
> | child | what it was really doing | what the notice said |
> |---|---|---|
> | `anotify-doc-purge` | retired at 16:45:12 (`state=retired execution=success acceptance=accepted`, terminal gone) | `running for 1h 45m (threshold 45m 0s), with no tool in flight` at **18:08:07** |
> | `anotify-vars-ui` | writing `session.jsonl` at 17:38:29 (2.1 MB) | notice at **17:38:06**, 23 s before the write |
> | `anotify-audit-bulk` | compiling, `CPU 27% / 80 °C` | `no tool in flight` |
> | `flake-478` | blocked in `gh pr checks --watch`, 16 minutes | `no tool in flight` |
> | `479-rebase` | rebasing, `CPU 49% / 95 °C` | `no tool in flight` |

## D441-1 — Two sources answer "is this run over?", and either one is enough

```
candidate = NOT ledgerEnded   AND   NOT runEnded
```

- `ledgerEnded` is `hasEnded` (`nodes.ts`): `status ∈ {settled, failed, retired}`
  or a terminal phase. Unchanged from `stall-notice-v1` D5.
- `runEnded` is the `run.json` `ChildRecord` this node's own postman dispatches
  into: `state ∈ {settled, success, completed, done, failed, aborted, error,
  truncated, retired, exited}` **or** `execution.status` in the same set.

The two are not redundant, and the earlier one wins. `run.json` is written by the
process that actually RAN the child, so it retires the child the moment that
happens; the ledger row only moves when the parent collects. The measured ghost
lived exactly in that gap: the run said `retired` at 16:45, the row still looked
live, and the clock kept running.

Deliberately NOT terminal: `working`, `awaiting`, `blocked`, `queued`, `launching`,
`idle`, `orphaned`, `orphaned_turn_over`. The last two are `remote-child-fate-v1` D2's
non-terminal fate: `recover` must still be able to fetch a cross-machine child the
parent session left behind.

Absence is not evidence: no run record (a caller predating #441, a test double) means
"this source says nothing", never "the child ended".

A child that leaves the candidate set is tombstoned exactly like an ended one, so a
later re-dispatch (a NEW process) gets a fresh baseline instead of inheriting "70m
old". `extend` consults the same predicate and refuses with `child-ended` — a receipt
that promises a reminder which can never arrive is worse than a refusal.

## D441-2 — L2 is a composition, not a clock

```
alert(L2) = threshold crossed
            AND nothing is in flight                          (D441-3)
            AND, when this host cannot see tools, the transcript did NOT grow
                inside the window                             (D441-4)
```

The clock only OPENS the question. It no longer answers it.

## D441-3 — A visible command in flight means WORKING (`#441-C`)

`inFlightTool !== undefined` ⇒ no L2 notice, at any age. Before this, the stack was
quoted as EVIDENCE inside the line ("inside `bash` for 38m") while the line itself
still asked the parent to suspect a loop; a 16-minute `gh pr checks --watch` produced
one notice per boundary.

The same fact on a backend that folds no tool events is the container's own status
word: `working` ⇒ working, no notice.

## D441-4 — Tool-blind backends are judged by GROWTH (`#441-B`)

`observesToolEvents(name) === false` — the `hc` terminal backend (contract D12), which
hosts every cross-machine child AND every worktree-holding centurion inside a terminal,
local or not. For such a child `inFlightTool === undefined` is PERMANENTLY true, so it
carries no information:

```
containerIdle = programState !== undefined ? programState !== "working" : NOT toolBlind
```

- With no container word either (`programState === undefined`), the child is
  **undecidable** ⇒ no notice. `unknown ≠ stalled`.
- When the container IS idle, growth decides:
  - cross-machine: the mirror pump's `lastGrowthAt` (`live-mirror.ts` `readMirrorFacts`,
    `mode === "on"` and `> 0`; mirror off / never grew ⇒ **no evidence**);
  - local terminal child: its own transcript's `mtime`;
  - `now - lastGrowthAt < thresholdMs` ⇒ it is growing ⇒ no notice. Fresh growth is
    proof of life no clock can argue with: `anotify-vars-ui`'s notice was 23 s older
    than a write.
  - no growth evidence at all ⇒ no notice.

**Deliberate deviation from `stall-notice-v1` D2.** That contract forbids using the
session file's mtime as an activity clock ("长生成期间也会静默"). Its reason was L1:
a 120-second silence during one generation is not evidence of anything. Here the
window is the ROLE RADIUS (45 minutes for a worker) and the fact is only ever used
NEGATIVELY — a transcript that DID grow inside the window suppresses the notice, and
one that stopped growing is what makes the container's `idle` word an anomaly. The
prohibition stays in force for L1, where it belongs.

The two reads are bounded: growth is one `statSync` (or one small JSON), and the
`terminal.get` behind `programState` is asked only after the child's radius has
already elapsed — never per tick. Nothing is cached: a stale `working` is the one
answer that could hide a real stall.

## D441-5 — Nothing else changes

- L1 (`silence`) keeps `stall-notice-v1` D1/D2 verbatim: empty stack + `lastEventAt`
  age, and its text (`steer cannot land here; abort can`).
- De-duplication (`tier` = the crossed boundary, `#413`), caps (2 × L1, 3 × L2),
  `extend` semantics, the one self-addressed `messages` row, the pre-delivery
  obsoletion and all three delivery paths are untouched.
- The L2 line's evidence text changes: it now says what was actually measured
  (`nothing in flight` / `container status \`idle\`` / `transcript has not grown for
  Nm`) instead of the permanent `with no tool in flight` that a tool-blind host could
  never verify. The line grammar (`- <name>: `) is unchanged, so
  `stall-notice-staleness` D2 keeps parsing it.

## Revision log

| date | change |
|---|---|
| 2026-11-20 | created for `#441`: D441-1 (candidate sources), D441-2/3/4 (L2 composition). `stall-notice-v1` D1's L2 row and its "L2 = total duration" judgement are superseded; L1 is untouched. |
