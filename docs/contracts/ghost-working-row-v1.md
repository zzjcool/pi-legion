# Contract — #463: the ghost `working` row

Status: frozen. Baseline `origin/master` @ `cfc7ce4` (6.2.12).
Report: `docs/reports/ghost-working-row.md`. Fixes #463.

## 1. The measured defect

A child that finished and was retired (`Child retired`) is still listed as a **live
child** by `subagent status`, and `stop` cannot settle it:

```
status → state=working owner: live supervisor=inprocess execution: running (…)
stop   → unknown child: X (not tracked by this session)
```

Two independent causes, both must be fixed:

| # | cause | evidence in code |
|---|---|---|
| C1 | `status` counts a row live from `owner.json` alone: `owner === "live"` ⇒ live even when this process holds no supervisor entry. `owner.json`'s pid is refreshed by **any** write to that run dir, so a stale `working` record reads `owner: live` because the pid is *this very process*. | `index.ts` `classifyChildrenForStatus` (`live = facts.orphaned !== true && !(owner === "dead" && !alive)`), `ownerVerdictFor` → `ownerState` (`src/runs/owner.ts:56`) |
| C2 | `status` scans the bounded store surface (`scanSurfaceFor`), `stop` reads only the session store (`stopAction` → `input.store.listRuns()`), so a record in another store is listed but not addressable. | `index.ts` `scanSurfaceFor` / `stopAction` |

## 2. Terms (frozen)

- **leftover** — a non-terminal `run.json` child record (state ∉ `retired|exited|failed|settled`).
- **ghost row** — a leftover that
  1. this process does **not** track: `runtime.get(name) === undefined` **and**
     `supervisor.isAlive(name) === false`;
  2. is **not** an #456 orphan (`isOrphanedRecord(child) === false` — no `host`+orphan
     marker; those keep their existing path), and state ∈ {`working`, `launching`, `awaiting`};
  3. is **not** held by another live session: the run dir's `owner.json` is absent,
     unreadable, dead, **or** its pid **is** this process. A marker written on another
     host is "cannot check from here" and is therefore **not** a ghost (#456 review F8);
  4. was **not adopted by the session asking**: a `reattached` stamp whose
     `sessionFile` names this session means the #445 re-attach watcher holds the child
     (it is neither a supervisor entry nor a job), so the row is **not** a ghost
     (#450 A1). A stamp from an EARLIER session proves nothing — that session is gone,
     which is the shape this contract is about.
- **`no supervisor`** — the display/settle verdict for a ghost row: the child was
  launched by a session this process no longer has any handle for, so no one can
  collect it, and `owner.json` cannot prove life. It is **not** a death verdict: the
  record is settled as `retired` (`node_retired`) unless its transcript grades, in
  which case the graded outcome is written — #460's rule ("unreachable does not
  judge the child dead") is preserved.

## 3. Wire / persisted fields (additive, no ledger schema change)

```ts
// src/shared/types.ts
export type OrphanReclaimVerdict =
  | "terminal-gone" | "stale-orphan" | "working" | "unknown"
  | "no-supervisor";            // #463

// ChildRecord (declared in src/runs/unsupervised-row.ts, same pattern as reattached/reclaimed)
interface ChildRecord { unsupervised?: UnsupervisedMark }

export interface UnsupervisedMark {
  at: number;
  reason: "no supervisor";
  /** One sentence, no trailing period: the evidence the verdict rests on. */
  evidence: string;
  /** The session that converged the row. */
  sessionFile?: string;
  /**
   * What the ledger said when the row was converged — only the two OPEN readings:
   * a row whose ledger row already `ended` is never converged at all (§4.3).
   */
  ledger?: "running" | "missing";
}
```

No `nodes` column, no new event type. A settle reuses #456's ledger write exactly
(`updateNode` + `node_settled|node_failed|node_retired` + `upsertUsage`).

## 4. Behaviour (one predicate, three consumers)

`src/runs/unsupervised-row.ts` owns **one** predicate; nothing else may invent a
second rule:

```ts
export interface UnsupervisedFacts {
  /** this process's supervisor registry: `supervisor.isAlive(name)`. */
  alive: boolean;
  /** this session's job table knows the name: `runtime.get(name) !== undefined`. */
  tracked: boolean;
  /** `owner.json` verdict for that run dir (`ownerState`). */
  owner?: "live" | "dead" | "unknown";
  /** `owner.json`'s pid, when it recorded one. */
  ownerPid?: number;
  /** this process's pid (default `process.pid`). */
  pid?: number;
  /** the session ASKING (its own transcript) — `reattached.sessionFile` is compared to it. */
  sessionFile?: string;
}
/**
 * The convergence answer (session-start scan): the row is a leftover nobody here
 * holds, whether its owner marker is dead, absent, or this very process. A row THIS
 * session adopted (`reattached.sessionFile` = `facts.sessionFile`) is held — by the
 * #445 re-attach watcher, which is neither a supervisor entry nor a job.
 */
export function convergeVerdict(child, facts): UnsupervisedVerdict | undefined;
/**
 * The display / hand-settle answer: only what a reader can PROVE at call time —
 * the record already carries a mark, or `owner.json` names THIS process.
 * An unmarked `owner: dead` record keeps #209-3's `state=failed` and an unmarked
 * missing marker keeps `state=working`; the scan converges those.
 */
export function unsupervisedVerdict(child, facts): UnsupervisedVerdict | undefined;
/** The record's own mark, when the startup pass already converged it. */
export function unsupervisedMarkOf(child): UnsupervisedMark | undefined;
/** `true` for the #456 leftover shape (host + orphan marker) — never ours. */
export function isOrphanLeftover(child): boolean;
export function isTerminalRecordState(state: string): boolean;
```

### 4.1 `status` (overview **and** named) — `index.ts`, `src/extension/runtime.ts`

- `StatusLivenessFacts` gains `unsupervised?: { reason: string; evidence: string }`.
- Facts: `unsupervised: unsupervisedVerdict(child, facts)`; a ghost row is **not live**
  (not counted in `Status · N live children`, never in `liveNames`), and the header
  carries `(N unreachable)` **only when N > 0** — with no ghost row the output is
  byte-identical to 6.2.12. #209-3's frozen words are untouched: an unmarked
  `owner: dead` record still renders `state=failed`, an unmarked missing marker still
  `state=working`.
- `renderLiveChildStatus({ …, unsupervised })` renders, as a suffix on the frozen state
  word (same shape as #456's `orphanWord`):
  `state=unreachable (no supervisor)` plus one `unreachable: <evidence>` line directly
  under the header. Existing lines keep their text and order.
- Named `status` uses the same facts (it already resolves across stores).

### 4.2 `stop` — `index.ts`

- `reclaimOrphanOnStop` (`#456`) runs first and is unchanged for orphaned rows.
- A ghost row is settled by a sibling step on the **same** insertion point and the
  **same** bounded surface (`orphanSurfaceStores`, own store first, `>1` candidate ⇒
  ambiguity refusal, `runId` narrows the search), through `reclaimOrphan` with
  `verdict: "no-supervisor"` — one write path, not a second one.
- Answer text names the verdict and the ledger status, mirroring #456's
  `Reclaimed …` / `Refusing …` shapes.
- `stop all` stays runtime-only (unchanged).
- `stop` on a row a live foreign pid holds keeps leaving it alone (an explained `ok`,
  never "unknown child … not tracked by this session").

### 4.3 Restart convergence — `src/runs/reattach.ts`

The #445 pass already walks every store's leftovers under one budget; it now also
**converges** what it cannot adopt (never adopts differently):

| leftover | pass decision |
|---|---|
| not live (probe said not-live, or a **local** leftover with no supervisor) and no live foreign owner | stamp `unsupervised` (state unchanged) with `ledger: "running"`/`"missing"` — `status` now says `unreachable (no supervisor)` and `stop` settles it. The question is asked with `convergeVerdict`, the wider scan answer. |
| ledger row `hasEnded` (settled/retired/failed) | untouched, logged only: **#445 A3 froze this shape** — "a settled/retired child is not adopted and not announced", the record is left exactly as found (`state=working` stays, #209-3's word stands). The ledger is the authority (#456); this pass has no verdict about a row that already ended. |
| live / adopted / live foreign owner / this session's own adoption / ledger unreadable / #456 orphan (`isOrphanLeftover`) | untouched (byte-identical to 6.2.12) |

A record already `retired`/`exited` is never touched. Adoption (`state="working"`,
`reattached`) still clears any `unsupervised` mark it may carry.

## 5. Regression guards (must stay green)

- #456: `test/unit/orphan-reclaim.test.ts`, `test/unit/orphan-reclaim-status.test.ts`,
  `test/integration/orphan-reclaim.test.ts`.
- #445: `test/unit/reattach*.test.ts`, `test/integration/reattach*.test.ts`.
- #460: `test/unit/supervision-unreachable.test.ts`.

## 6. Acceptance

1. Unit: `run.json` says `working`, the session's memory has no such child, the run
   dir's `owner.json` pid is alive **and is this process** ⇒ `status` must not say
   `working` (it says `unreachable (no supervisor)`) and `stop` must settle it
   (`state=retired` + ledger row ended). Both single-store and foreign-store shapes.
2. Restart convergence: a leftover whose ledger row still runs gets the `unsupervised`
   mark and is then stoppable; one whose ledger row already ended is left **exactly as
   found** (#445 A3 is the boundary this may not cross — `test/integration/reattach-live-children.test.ts`
   "#445 A3", `test/unit/reattach-converge.test.ts` "✕ #445 A3").
3. Mutation: deleting the ghost verdict (predicate returns `undefined`) turns
   acceptance 1 red.
4. `npm run typecheck` + `npm test` (compare against the `origin/master` baseline).

## 7. File ownership

| file | owner |
|---|---|
| `src/runs/unsupervised-row.ts` (new), `src/shared/types.ts`, `src/runs/orphan-reclaim.ts`, `src/extension/runtime.ts`, `index.ts` | lead |
| `src/runs/reattach.ts` | worker A |
| `test/unit/ghost-working-row.test.ts`, `test/unit/reattach-converge.test.ts` | lead / worker A |
| `docs/reports/ghost-working-row.md` | lead |
