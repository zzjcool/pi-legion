# Performance measurements (2026-10-19)

Measured on `v3.1.0` (`3071dee`), Node v24.13.1, one container. **Absolute
milliseconds drift with the machine; the ratios and the call chains are the
findings.** Reproduce with `npm run test:perf`.

These numbers back the perf issues (#236–#241). The harness lives in
`test/perf/` so a fix can turn each one around. Regression tests that pin an
open defect say so in their name and in a comment next to the assertion.

## Tier 1 — user-visible latency and correctness

### P1 · `collect()` burns ~2.5s per child in a fixed sleep

`Orchestrator.collect()` receives `wait === "settled"` from the supervisor (the
child's turn ended), then still awaits `waitForQuiet`, which polls
`statSync(sessionFile)` until the size has been stable for
`DEFAULTS.settleQuietMs` (2500ms).

Measured on the real `Orchestrator` + `FakeSupervisor` + a real session JSONL,
changing only the quiet window:

```text
collect(), production settings     2509 ms
collect(), settleQuietMs = 0        503 ms
=> ~2007 ms of dead time per successful collect
```

Guarding nothing: when `collect()` enters that branch the session's last
assistant message is already terminal **and on disk** (`stopReason: "stop"`,
`lastTurnMissing: false`). For an append-only file, a terminal message cannot
grow afterwards.

Root cause: `LegionSupervisor.onEvent` exists (`src/supervisor/types.ts`) and
both backends already publish settle events, but `src/runs/orchestrator.ts`
never subscribes — every post-`waitSettled` wait degrades to stat polling. The
same root cause drives `waitOutTransientConnection` (worst case 1800 full
`parseSessionFile` calls, ~500ms `POLL_INTERVAL_MS` cadence) and
`collectArtifactGrowing`.

Test: `test/perf/collect-latency.test.ts` (virtual clock: the injected
`now`/`sleep` deps measure the window without sleeping).

### P2 · one `node_abandoned` row permanently stalls the event bus

`src/runs/hygiene.ts` writes `type = 'node_abandoned'`, but
`LEGION_EVENT_TYPES` does not contain it and `mapEvent` throws on an unknown
type. `createDbEventSource` records the error and leaves the cursor
unadvanced, so every 250ms poll re-reads the same poisoned batch and throws again:

```text
valid ledger:            delivered=3  cursor=3  errors=0
after one poison row:    delivered=0  cursor=0  errors=4
repeat poll:             delivered=0  cursor=0  errors=4
```

The cross-process view is dead from that point on, and the poll spins at 4Hz.
Reachable whenever hygiene marks a stale `starting/running/blocked` node and
any process later attaches to that ledger.

Test: `test/perf/event-bus.test.ts`, the `REGRESSION (open defect)` case.

## Tier 2 — costs that scale with load

### P3 · live-overlay re-reads the whole session file on every append

`readSessionDelta` compares `statSync().size` against `cursor.fileSize`, then —
on any change — does `readFileSync(sessionFile, "utf8")` **from byte 0** and
re-parses every line. The byte offset is already stored in the cursor; it is
used only as a change flag, never as a read offset.

```text
4.9MB session, poll with no append:   31.9 ms   (full re-read)
4.9MB session, tail-read prototype:    0.05 ms  (stat only)  => ~600x
```

Cost grows with session length while the trigger rate grows with token rate, so
the viewer gets slower the longer the turn runs.

### P4 · `attachUsageTotals` is an N+1 (72% of the UI snapshot)

`src/legion/usage.ts` calls `getUsage` once per node inside a `map`. Measured at
400 nodes: `getSubtree` 2.62ms + `attachUsageTotals` 6.90ms = 9.64ms per
snapshot. A single `WHERE node_id IN (...)` batch measured **8.95ms -> 0.90ms**
(9.9x) with byte-identical output.

Runs twice per second from the 500ms refresh, plus once per bus event
(`src/extension/runtime.ts` subscribes to every event type except `text_delta`).

Test: `test/perf/ledger.test.ts` (asserts the N+1 exceeds the CTE).

### P5 · heartbeats pay one fsync per child

`refreshHeartbeats` loops `updateNode` per child; each is an implicit
transaction under the default `synchronous=FULL` (only `busy_timeout`,
`foreign_keys`, `journal_mode` are set in `src/legion/db.ts`).

```text
8 children, per-child autocommit    3.83 ms   (479 us/child)
8 children, one transaction         0.99 ms   (124 us/child)  => 3.9x
60 children                        31.6 ms  -> 8.2 ms
```

### P6 · no statement cache: every `prepare()` recompiles

45 `prepare()` call sites; the data layer exposes only `exec/prepare/close`.

```text
prepare-per-call   30.1 us/op
reused statement    9.2 us/op
getNode x400       15.7 ms -> 4.8 ms  (3.2x)
```

### P7 · `structuredClone` spends the incremental-parse win

`parseSessionFile` keeps a dev/ino/offset fingerprint cache (#36) but then
returns `structuredClone(state.parsed)`:

```text
6.9MB session: cold 73.3ms, warm 3.24ms
structuredClone(parsed)          3.95ms   (~106% of the warm call)
```

Called once per job and once per node per 500ms refresh. Note the honest
bound: a **warm** pass over 60 distinct sessions is only 12.3ms (~2% of the
tick). The cliff is the 64-entry LRU cap — past that every tick is cold
(measured 312ms for the same pass).

### P8 · event replay: the cursor starts at 0

`createDbEventSource` defaults `cursor = 0`, so attaching to a ledger with
history replays it from the oldest row, and each replayed event triggers a
snapshot: 300 events x 3.42ms = **1027ms** of blocking work on attach. Seeding
from `MAX(id)` makes it one query.

## Tier 3 — smaller, still measured

### P9 · `messages` rate-limit is a full table SCAN

`SELECT COUNT(*) FROM messages WHERE from_node = ? AND created_at > ?` has no
covering index. At 50,000 rows: **5.04ms** per `sendMail`, `EXPLAIN QUERY PLAN`
says `SCAN messages`. The table also has no retention policy.

> Measurement note: a first attempt reported 0.04ms because the default
> `ratePer5Min` limit kept the table at zero rows. Re-measured by inserting rows
> directly — the SCAN is real.

### P10 · six synchronous git processes per first launch

`orchestrator.ts` calls `isInsideChildWorktree(this.cwd)` twice in the same
branch (lines 608 and 615) with the same argument:

```text
isInsideChildWorktree x1    9.4 ms  (2 execFileSync)
isInsideChildWorktree x2   16.0 ms  <- 4 processes, 2 of them redundant
isGitRepo x1                3.6 ms
=> 6 synchronous git processes per first centurion launch
```

All `execFileSync`, so they block the parent event loop; provision adds one
`bash -lc` (login shell, default 600s timeout).

## Deliberately not measured / open decisions

- `PRAGMA synchronous = NORMAL`: would cut every autocommit write a further
  4–5x. WAL-safe against corruption but can lose the last transactions on power
  loss. Needs an explicit decision; the contract only fixes WAL + `busy_timeout`.
- The contract asks for a 60-supervisor concurrent-WAL stress run
  (`docs/legion-v2-contract.md`, "busy timeout rate < 0.1%"). Still unimplemented.
