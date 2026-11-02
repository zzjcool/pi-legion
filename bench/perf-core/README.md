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
#368 OK 14/14 gates (environment satisfied (psi some avg10 0.0%, loadavg 1.6/8 (0.07 per cpu minus this process), foreign 0.34 cores, probe p95/min 1.06))

# two busy cores next door: time gates are NOT judged, exit code stays 0
$ node --experimental-strip-types bench/perf-core/09-legion-mount.ts
#368 SKIP (environment not satisfied: foreign 2.10 cores > 0.8 (psi some avg10 0.0%, loadavg 2.5/8 (0.19 per cpu minus this process), foreign 2.10 cores, probe p95/min 1.05)) — 3/3 clock-independent gate(s) judged and passing, 11 time gate(s) not judged
```

How to read it:

- **`ok: true`** — every gate was judged and passed. Only meaningful when the
  environment line says `satisfied`.
- **`ok: "inconclusive"`** — the probe says the box was busy (PSI stalls, foreign
  cores, `loadavg` or the tight-loop tail ratio over budget), so the time-class gates are
  reported as `not judged` (`"judged": false`, `"ok": null` in the JSON). The
  byte gates are still judged. Exit code **0**: this is **not** a regression, and
  it is **not** a pass either — re-run on an idle box before drawing a conclusion.
  Do not "fix" the numbers by re-running until green on a loaded box.
- **`ok: false`, exit code 1** — a gate was actually judged and missed (byte
  growth, or a time gate on a machine the probe accepted). Treat as a regression.

The probe (`environment.probe` in the JSON) runs five ~50ms windows around a fixed
tight arithmetic loop, plus the kernel's own stall accounting. Any one signal over
its limit means "not judged" (they are OR-ed; none of them is trusted alone):

| field | what it measures | limit | why that number |
|---|---|---|---|
| `ratioP95Min` | the loop's p95/min batch time — was *this thread* preempted? | **> 1.5** | idle 1.00–1.09 over a dozen runs; a preempted thread goes past 2 |
| `psiSomeAvg10` | `/proc/pressure/cpu` `some avg10`: share of wall time some task stalled waiting for a CPU | **> 5%** | the cleanest signal — idle is 0.00, a contended box reads 20–30% |
| `foreignCores` | `foreignCpu × cpus`: cores of *persistent* other-process CPU work (quietest of the 5 windows, this process's own CPU subtracted) | **> 0.8** | idle baseline 0–0.35 cores; one co-running core reads ~1.0, two ~2.0 |
| `loadPerCpu` | `(loadavg[0] − 1)/cpus` — one thread is subtracted because it is this benchmark itself, and back-to-back runs would otherwise disqualify their own successors | **> 0.8** | this box's resident baseline is 0.13–0.22/core; 0.8 ≈ 6.4 runnable threads on 8 CPUs |

Two calibration notes, both measured on the box these numbers came from:
**PSI is not universal** — that box reads 4.6% `some avg10` even with all 8 cores
busy (SMT siblings get scheduled quickly), so `foreignCores` is what actually
catches a co-runner there; PSI carries boxes where stalls are real. And
**`foreignCores`, not a percentage, is the unit**: 15% of an 8-CPU machine is
1.2 cores, which *is* a co-runner — a percentage of one core and a percentage of
the machine read nothing alike.

Off Linux, `/proc/stat` and `/proc/pressure/cpu` are unreadable: `foreignCpu`,
`foreignCores` and `psiSomeAvg10` are `null` and the remaining two signals decide.

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
