# Spawn-mode visibility + RPC copy cleanup — frozen contract v1

Status: frozen for implementation. Owner decisions are D1–D7; do not re-litigate.

## Why

`DEFAULT_SPAWN_MODE = "inprocess"` (`src/supervisor/spawn-mode.ts:18`) has shipped,
but the parent-facing guidance still says every child is an "RPC child", and the
actual backend (`handle.spawnMode`) is only visible as a substring of a result
text line. Users cannot tell inprocess from rpc from the UI.

Facts established by recon (do not re-verify):

- pi never renders tool-result `details` on its own. The only consumer is
  `renderResult` (`tool-execution.js:243`); with no renderer the host falls back
  to `content` text only. Adding a `details` field alone is invisible.
- `subagent` / `vexillatio` register **no** renderer (`index.ts:708`, `index.ts:973`).
- `Handle.spawnMode: SpawnMode` is non-optional and is the arbitrated backend
  (`src/shared/types.ts:482-503`, produced at `src/runs/orchestrator.ts:809-818`).
- `LaunchSession.handles` is `string[]` (`index.ts:1831`) — the mode is dropped there.
- The `/legion` node modal footer is `metaPlain()` (`src/tui/live-overlay.ts:737-756`)
  rendering `role · model · turn N (Xs) · elapsed · status`.
- `legion.nodes` has **no** spawn_mode column (`src/legion/db.ts:47-67`).

## D1 — Wording (backend-neutral) for parent guidance

Children are **in-process by default**; a separate `pi` process is used only when
the launch needs a worktree — and since only a centurion may hold one, only a
centurion reaches `rpc`. (The `spawnMode` role field described here was removed
in 4.0.1; `handle.spawnMode` below remains the arbitrated backend and is still
what callers must render.)

Replace "RPC child / headless RPC children / started via RPC / RPC launch" with
backend-neutral phrasing in these exact places:

| File:line | Current |
| --- | --- |
| `src/extension/playbook.ts:12` | `Child processes are headless RPC children; no pane or tab is created.` |
| `src/extension/playbook.ts:13` | `when each RPC child finishes` |
| `src/extension/playbook.ts:15` | `A collect timeout with a live RPC child` |
| `src/extension/playbook.ts:25` | `children use --no-extensions` (keep only if still true for the rpc path; phrase as `rpc children use --no-extensions`) |
| `index.ts:1669` | `playbook: … → RPC launch → watch` |
| `index.ts:1966` | `playbook: … started via RPC` |
| `index.ts:1801` | `when each RPC child finishes` |
| `index.ts:1616` | `(live RPC child steered)` |
| `index.ts:1574` | `RPC process stopped; session kept for resume:` |
| `src/extension/recycle.ts:10` | `the RPC child is already stopped` |
| `src/extension/notify.ts:200` | `RPC child retired.` |
| `src/extension/notify.ts:237` | `(RPC child is not alive)` |
| `src/extension/notify.ts:315` | `(RPC child retired)` |

Use `child` as the noun. Suggested replacement vocabulary (one word list, keep it
consistent): `child`, `in-process child`, `rpc child` (lowercase, only when the
rpc backend is meant), `session`, `watch`.

## D2 — Out of scope for D1 (do NOT touch)

These are either internal identifiers or the genuine rpc backend; changing them
breaks failure classification or contracts:

- `src/supervisor/rpc-supervisor.ts` reasons (`Pi RPC process exited …`, etc.)
- `src/extension/auto-doctor.ts:50` regex (matches `Pi RPC process exited`)
- `src/runs/orchestrator.ts:146` `TRANSIENT_CONNECTION_REASON` value
- `src/runs/orchestrator.ts:579/782`, `src/runs/hygiene.ts`, `--no-extensions`
  plumbing, `rpc-child-*` temp dir prefixes, `subagents.rpc.*` keys
- the frozen head line `interrupted (parent turn ended; children still running)`
- `docs/contracts/**`

## D3 — `details` carries the mode (machine facts)

Additive only; never replace an existing field, never emit `isError`.

`subagent` launch-family success + interrupted results gain:

```ts
spawns?: Array<{ name: string; agent: string; spawnMode: "rpc" | "inprocess" }>
```

- Emitted only when at least one handle resolved (omitted otherwise, matching the
  existing `stillRunning?` "present only when non-empty" convention).
- Values come from `handle.spawnMode` (`Handle`, never re-derived, never guessed).
- Sites: `index.ts:1754` (interrupted) and `index.ts:1807` (normal).
  The interrupted path runs after `handles` is cleared, so keep the resolved
  entries in a parallel field on `LaunchSession` (precedent: `timeoutByName`).

`vexillatio` gains `spawnMode` on each handle object:

```ts
handles: Array<{ name: string; agent: string; sessionFile: string; spawnMode?: SpawnMode }>
```

`spawnMode` is optional so `ChildRecord.spawnMode?: SpawnMode` legacy runs
(`src/shared/types.ts:365-373`) render as absent, never as `"rpc"`.
`docs/vexillatio-contract.md:57` freezes top-level details keys only, so this is
allowed; do not change that doc.

## D4 — TUI renderer for both tools (this is what makes D3 visible)

New file `src/extension/spawn-render.ts`:

```ts
export function spawnModeSummary(details: unknown): string | undefined
export function renderSpawnResult(
  result: AgentToolResult<unknown>,
  opts: { expanded: boolean; isPartial: boolean },
  theme: Theme,
): Component
```

Behaviour:

1. `spawnModeSummary` reads `details.spawns` and/or `details.handles[].spawnMode`
   defensively (unknown → undefined). Output: `spawn: scout-0=inprocess`
   or `spawn: worker-0=rpc, scout-1=inprocess`. Entries with an unknown mode are
   skipped; if none survive, return `undefined`.
2. `renderSpawnResult` builds the text from `content` text blocks only
   (`stripTerminalSequences`), prepends the summary line when defined, then
   collapsed → first 10 lines + `... (N more lines, ctrl+o to expand)`,
   expanded → all lines. Returns `new Text(text, 0, 0)`.
3. It must never throw: wrap the details access in optional chaining; a throw is
   silently swallowed by the host and would blank the card.

Attach `renderResult: (result, opts, theme) => renderSpawnResult(result, opts, theme)`
to both `subagent` (`index.ts:973`) and `vexillatio` (`index.ts:708`).
No `renderCall`, no `renderShell: "self"`.

Rationale: `content` is model-facing, `details` is TUI-facing (`docs/design.md:258`).
The summary line goes through `details` so it does not enter the LLM context.

## D5 — `/legion` node modal footer shows the same value

Thread the arbitrated mode to the overlay without a DB migration:

1. `TrackedJobInput` (`src/extension/runtime.ts:68`) gains `spawnMode?: SpawnMode`.
2. Launch sites pass `handle.spawnMode` (`index.ts` ~1914 and the follow sites
   ~2709-2790 that already carry the handle/record).
3. `TreeNodeSnapshot` (`src/tui/tree-view.ts:22`) gains `spawnMode?: SpawnMode`;
   `snapshotNodes()` (`src/extension/runtime.ts:608`) merges the job's value onto
   the node snapshot (`job.spawnMode`, matched by nodeId/name, no guessing).
4. `liveNode()` (`src/extension/legion-commands.ts:298`) maps it through
   `LiveOverlayNode` (`src/tui/live-overlay.ts:25`).
5. `metaPlain()` appends `spawn <mode>` **only when known**; legacy/unknown →
   omit the segment entirely (never print `rpc` as a default).

Do **not** add a `legion.db` column and do **not** bump `LEGION_DB_USER_VERSION`.

## D6 — Tests (must be updated/added by the same change)

Update (currently lock the old wording):

- `test/unit/playbook.test.ts:17` `/headless RPC children/`, `:76` `/RPC child is a progress signal/`
- `test/unit/notify.test.ts:52,163,169,398,410-411`
- `test/unit/recycle.test.ts:11`
- `test/unit/runtime.test.ts:1252`

Add:

- `spawnModeSummary` returns `undefined` for `{}`/unknown/legacy, and the
  documented string for both launch-family and vexillatio details shapes.
- `renderSpawnResult` collapsed keeps the summary line and caps at 10 lines +
  hint; expanded prints everything.
- launch details expose `spawns` with the arbitrated value (extend an existing
  harness that already inspects `details`, e.g. `test/unit/teams.test.ts:1320`).
- `metaPlain` includes `spawn rpc` / `spawn inprocess` when set and omits it when
  unknown (`test/unit/legion-live-overlay.test.ts`).

## Errata (review round 1, accepted)

- **D3/D6 (line numbers)**: the D1 table merged two `index.ts` copy sites into
  `playbook.ts` rows. The real sites are `playbook.ts:12/14/15` plus
  `index.ts:1669/1801/1966/1616/1574`. Behaviour unchanged.
- **D1 (`--no-extensions`)**: the suggested wording `rpc children use
  --no-extensions` was wrong — in-process children run with
  `noExtensions = !childInheritsExtensions(...)` too
  (`src/supervisor/inprocess-supervisor.ts:145`). The sentence must stay
  backend-neutral; do not name `rpc` there.
- **D4 (never-throw)**: shape checks are not enough. A `details` object with a
  throwing getter still throws, and the host silently swallows it
  (`tool-execution.js:150-160`). `spawnModeSummary` and `renderSpawnResult` must
  both be wrapped in `try/catch`. Covered by a getter/Proxy test.
- **D4 (line cap)**: the collapsed cap must count rendered lines, so `\r` and
  binary control bytes are stripped **before** splitting — parity with the host
  fallback (`render-utils.js:40`: `sanitizeBinaryOutput` + `.replace(/\r/g,"")`).
  Without it a `\r` progress stream renders 21 lines and never shows the hint.
- **D4 (dedupe)**: one `name=mode` entry per child, first occurrence wins.
- **D5 (`treeNodes()`)**: `snapshotNodes()` alone is not enough. `treeNodes()`
  synthesizes a `TreeNodeSnapshot` for a job with identity but no DB row
  (`runtime.ts:1311-1331`), and that literal dropped `spawnMode`, so the modal
  footer lost the segment in the plain-session / pre-DB-row window. Merge in
  `treeNodes()` (shared helper), not only in `snapshotNodes()`.
- **D5 (width)**: `spawn <mode>` appended last is truncated to `spawn inpr...`
  at the default 80-column layout (`resolveModalLayout(24,80)` → `innerWidth=78`).
  Put the segment before `model` so the role+status survive, and test with a
  realistic model id.

## D8 — Commit ownership

Implementation lands as a single commit **created by the parent agent**.
Sub-agents must not `git commit`, `git push`, or merge. Round 1 violated this
(`80890ba` was authored by the worker); it is amended by the parent in round 2.

## D7 — Acceptance

- `npm run typecheck`
- `npm test`
- `npm run test:integration`
- No new `RPC child` occurrences in parent-visible strings: the D1 table is empty
  afterwards, and `rg -n 'RPC child|headless RPC|via RPC' src index.ts` returns
  only the files listed in D2.
