# perf-core benchmarks — the core execution chain

Read-only measurement scripts for the perf investigation of `launch → child → collect → retire`.
They drive **production modules directly** (no reimplementation of any hot path) and each one
prints a single JSON blob with per-measurement samples so a re-run can be compared honestly.

Nothing here changes `src/`. Every script writes only to `os.tmpdir()` and removes what it created.

## Run

```bash
node --experimental-strip-types bench/perf-core/01-session-parse.ts
node --expose-gc --experimental-strip-types bench/perf-core/01-session-parse.ts   # with heap numbers
node --experimental-strip-types bench/perf-core/02-collect-parses.ts [runsDir]
node --experimental-strip-types bench/perf-core/03-launch.ts
node --experimental-strip-types bench/perf-core/04-launch-git-probe.ts
node --experimental-strip-types bench/perf-core/05-ledger-writes.ts
node --experimental-strip-types bench/perf-core/06-watch-tick.ts
node --experimental-strip-types bench/perf-core/07-list-runs.ts
node --experimental-strip-types bench/perf-core/08-steer-abort-sweep.ts
node --experimental-strip-types bench/perf-core/09-legion-mount.ts
node --expose-gc --experimental-strip-types bench/perf-core/10-legion-frame-alloc.ts
```

`02` and `07` also read the real run corpus; pass a different `runsDir` (or edit the
`RunStore` root) to point them somewhere else.

## What each script measures

| Script | Question it answers |
|---|---|
| `01-session-parse.ts` | `parseSessionFile` cost vs line/turn count: cold vs warm vs incremental, and how much of a warm parse is `projectForCaller`. |
| `02-collect-parses.ts` | How many times one `cachedCollect → collect → retire` sequence opens a child's session file, counted by wrapping `fs.openSync` (the technique `test/unit/collect-polling.test.ts` uses). Also surveys the real session corpus. |
| `03-launch.ts` | `launch()` fixed overhead by ablation: legion vs no-legion, git cwd vs non-git cwd, no-op supervisor vs `FakeSupervisor`; plus every unit (ledger writes, `preCreateSessionFile`, `createRun`, `git worktree add`). |
| `04-launch-git-probe.ts` | Counts the real synchronous `git` subprocesses per launch (wraps `child_process.execFileSync`) and times a real `git worktree add` inside this repo. |
| `05-ledger-writes.ts` | Single-write cost of `appendEvent`/`updateNode`/`heartbeatNode`, the PRAGMAs in force, write amplification at 1/10/50 connections, and whether the WAL is bounded. |
| `06-watch-tick.ts` | One 500ms `statusEntries()` tick, wired the way `index.ts` wires it (`getSubtree` + `attachUsageTotals` + `getChildByName`) over a real ledger. |
| `07-list-runs.ts` | `RunStore.listRuns()` on the real corpus and on 100/1000/3000-run stores, plus the breakdown and the single-`readRun` baseline. |
| `08-steer-abort-sweep.ts` | `/proc` enumeration and `sweepProcessTree`, `raceWithTimeout` timer accounting, `steer`/`abort` on a 50-child orchestrator, run-registry age distribution. |
| `09-legion-mount.ts` | `/legion` as a full-screen overlay vs a main-screen child (#347, #368): page-frame `renderNow` median/p95 per terminal size, the detail modal's own cost next to a blank-rect control measured **paired inside each round**, bytes per frame, the issue's gates, and an environment probe (see below). |
| `10-legion-frame-alloc.ts` | Per-frame heap allocation of one `/legion` frame on the real `Theme(dark)` (#364): median of 20 single-frame `heapUsed` deltas, frame median/p95 (5×50), the drawGalaxy/chart/toLines/Canvas/other attribution, and the visible-byte digests gated against `10-baseline.json`. |

## `09-legion-mount.ts` must run on an idle, exclusive box (#368)

`09` is the only script here that gates on wall-clock numbers, so it is also the
only one that can be spoiled by **anything else running on the machine** — its own
`npm test` in another pane is enough. It therefore checks the machine before the
first frame and tells you when it could not judge:

```
# idle box: every gate is judged
$ node --experimental-strip-types bench/perf-core/09-legion-mount.ts
#368 OK 14/14 gates (environment satisfied (loadavg 1.5/8 (0.06 per cpu minus this process), probe p95/min 1.01, foreign cpu 0%))

# two busy cores next door: time gates are NOT judged, exit code stays 0
$ node --experimental-strip-types bench/perf-core/09-legion-mount.ts
#368 SKIP (environment not satisfied: foreign cpu 22% > 10% (loadavg 2.5/8 (0.19 per cpu minus this process), probe p95/min 1.06, foreign cpu 22%)) — 3/3 clock-independent gate(s) judged and passing, 11 time gate(s) not judged
```

How to read it:

- **`ok: true`** — every gate was judged and passed. Only meaningful when the
  environment line says `satisfied`.
- **`ok: "inconclusive"`** — the probe says the box was busy (`loadavg` /
  foreign CPU / a tight-loop tail ratio over budget), so the time-class gates are
  reported as `not judged` (`"judged": false`, `"ok": null` in the JSON). The
  byte gates are still judged. Exit code **0**: this is **not** a regression, and
  it is **not** a pass either — re-run on an idle box before drawing a conclusion.
  Do not "fix" the numbers by re-running until green on a loaded box.
- **`ok: false`, exit code 1** — a gate was actually judged and missed (byte
  growth, or a time gate on a machine the probe accepted). Treat as a regression.

The probe (`environment.probe` in the JSON) is, on all CPUs, a fixed tight
arithmetic loop sampled in 5 windows: `ratioP95Min` is the loop's p95/min batch
time (≥ ~1.5 means this thread was being preempted) and `foreignCpu` is the
quietest window's machine-wide busy fraction **minus this process's own CPU**
(≥ 10% means somebody else is using the box; one co-running core on 8 is ~13%).
`loadavg[0]/cpus` — with one thread subtracted for this benchmark itself — is the
slow global backstop (≥ 0.20). Off Linux, `/proc/stat` is unreadable, `foreignCpu`
is `null` and the other two signals decide.

### The floor gate is paired, so re-runs agree (#368)

`modalDeltaWithinBlankRectFloor` used to compare two medians taken a minute
apart (`modalDelta <= blankDelta + 0.5ms`): on a shared box each batch median
drifts by ~±0.5ms on its own, so the same commit went red twice and green once.
It now measures base → modal → blank in three interleaved segments *inside each
of 5 rounds* and gates the median of the per-round `slack = modalDelta -
blankDelta`. Idle measurements put that median at 0.17–0.28 / 0.33–0.45 /
0.42–0.61 ms (80×24 / 120×40 / 200×60) with a per-round p95 of at most 0.87 ms
(200×60, where the modal's 39 rows genuinely cost more to composite than 39 blank
rows), so the epsilon is 0.9 ms — `max(observed upper bound, 0.5 ms)` from
`reports/368-mount-gate.md`, not a hand-picked number. If the rounds split on the
sign (≥2 positive, ≥2 negative) a median over the epsilon reports
`inconclusive`, not red: that is between-round noise, not a cost the code pays.

## Cautions

- These are **measurement** scripts, not regression gates. On a shared box the medians move by
  2x; each script reports its own samples so the spread is visible. Compare medians, never single runs.
- `04` patches the CJS `child_process` export and `02` patches `node:fs`, each followed by
  `syncBuiltinESMExports()` so the ESM imports inside `src/` see the wrapper. Both restore at exit.
- `04` creates and removes real git worktrees inside this repo when measuring a centurion launch
  and `git worktree add`. Because every `createChildWorktree` mints a fresh random branch, the script
  explicitly removes each worktree, deletes the branch it created, and runs `git worktree prune` —
  otherwise one branch per measured launch would be left behind in the host repo. Cleanup is
  best-effort (it also runs for the non-git-cwd case, which has nothing to clean).
