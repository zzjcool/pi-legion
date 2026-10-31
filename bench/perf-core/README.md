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
| `09-legion-mount.ts` | `/legion` as a full-screen overlay vs a main-screen child (#347): page-frame `renderNow` median/p95 per terminal size, the detail modal's own delta next to a blank-rect control, bytes per frame, and the issue's gates. |
| `10-legion-frame-alloc.ts` | Per-frame heap allocation of one `/legion` frame on the real `Theme(dark)` (#364): median of 20 single-frame `heapUsed` deltas, frame median/p95 (5×50), the drawGalaxy/chart/toLines/Canvas/other attribution, and the visible-byte digests gated against `10-baseline.json`. |

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
