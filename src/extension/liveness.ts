/**
 * The single authority for "is this child alive?" (contract
 * `docs/contracts/display-liveness-v1.md`, D1 / D2 / D5).
 *
 * Before this module every display surface answered the question its own way:
 * the status list looked at `child.state`, the text renderer additionally
 * computed an owner verdict, and the railway strip arbitrated an event
 * timestamp against a ledger heartbeat written by a *different* process. The
 * same child could therefore be `live` (list), `failed` (text) and `running`
 * (rail) at the same instant. `liveness()` replaces all three with one ordered
 * projection over the facts available at the moment of rendering.
 *
 * ## Order, not union (D1)
 *
 * The eight rules below form a *total order* of evidence strength, not a set of
 * predicates OR'd together. A union would let a leftover `running` ledger row
 * outvote "this process already knows the child is gone"; the order makes the
 * stronger evidence win:
 *
 * 1. `inMemory` present and non-terminal   → `live`   (we are holding it)
 * 2. `inMemory` present and terminal       → `dead`
 * 3. `pidAlive === true`                   → `live`   (a real process runs)
 * 4. `pidAlive === false`                  → `dead`   (D4: no heartbeat grace)
 * 5. `ledger` non-terminal, heartbeat fresh → `live`
 * 6. `ledger` non-terminal, heartbeat stale → `dead`   (orphan; D7 converges it)
 * 7. `record` terminal                     → `dead`
 * 8. everything else (incl. all-undefined) → `unknown`
 *
 * ## Three states, not two (D2)
 *
 * `unknown` exists and must never be rendered as `live`. Treating unknown as
 * live is exactly the bug that printed `Status · 1 live child` next to
 * `owner: dead (pid gone)`; treating it as dead would kill children that are
 * merely starting. The third state is the only honest answer.
 *
 * ## Purity (D1, §7-7)
 *
 * Pure by construction: no fs, no path, no database, no timer, and **no clock
 * read**. `now` is a parameter because a module that reads its own clock cannot
 * be asked "what would this render as at time T" — and two reads at slightly
 * different times would reintroduce the off-by-a-tick behaviour R2 describes.
 * `test/unit/liveness.test.ts` asserts these properties by reading this file's
 * source text.
 *
 * ## No timestamp arbitration (D3)
 *
 * Nothing here compares timestamps that came from different writers. The only
 * time comparison is `now - ledger.updatedAt < staleMs`, where `now` is the
 * caller's render clock and `updatedAt` is that same ledger row's own heartbeat —
 * one clock family, and the comparison decides freshness rather than "whose
 * conclusion wins". Event-bus timestamps are never consulted: events only
 * trigger a recompute (D8).
 */

/** D2: the three truthful answers. `unknown` is a state, not a synonym for live. */
export type Liveness = "live" | "dead" | "unknown";

/**
 * Facts for one child at one instant. Every source is optional because every
 * source can be absent: a child may exist only in the in-memory registry, only
 * in the ledger, only in `run.json`, or in none of them (replayed history).
 */
export interface LivenessFacts {
	/** Entry in this process's in-memory child registry, if any. */
	readonly inMemory?: { readonly state: string } | undefined;
	/** Ledger row plus the heartbeat timestamp its own process last wrote. */
	readonly ledger?: { readonly status: string; readonly updatedAt: number } | undefined;
	/** `run.json` child record (scheduling layer). */
	readonly record?: { readonly state: string } | undefined;
	/** Pid-marker verdict; `undefined` means there is no marker to consult. */
	readonly pidAlive?: boolean | undefined;
	/** Render clock, supplied by the caller — never read inside this module. */
	readonly now: number;
	/** Age after which a non-terminal ledger row is an orphan (default 90s). */
	readonly staleMs: number;
}

/**
 * States that mean "this lifecycle is over". Shared by W1/W2/W4 so the seven
 * divergent sets listed in R3 collapse into one.
 *
 * Note what is *absent*: `idle` and `queued` are non-terminal (D5). An `idle`
 * child is still alive and still holds a concurrency slot, and a `queued` child
 * has been admitted but not started — calling either one terminal is what made
 * the strip paint them as `retired`.
 */
export const TERMINAL_STATES: ReadonlySet<string> = new Set([
	"settled",
	"success",
	"completed",
	"done",
	"failed",
	"aborted",
	"error",
	"truncated",
	"retired",
]);

/** States known to be in flight. `idle`/`queued` are alive: slot held, not working. */
export const NON_TERMINAL: ReadonlySet<string> = new Set([
	"starting",
	"working",
	"running",
	"blocked",
	"idle",
	"queued",
]);

/**
 * A state is terminal only when it is in `TERMINAL_STATES`. Anything unknown —
 * including `""` — is *not* terminal: we do not get to declare a lifecycle over
 * because we failed to recognise the label.
 */
export function isTerminalState(state: string | undefined): boolean {
	return state !== undefined && TERMINAL_STATES.has(state.toLowerCase());
}

/**
 * D1: one ordered projection over the facts of a single instant.
 *
 * Total and side-effect free: the same `facts` always produce the same answer,
 * which is what makes "render is a projection, not an event replay" (D8)
 * checkable — see A6.
 */
export function liveness(facts: LivenessFacts): Liveness {
	// 1 + 2: the strongest evidence is a live handle in this very process.
	const inMemory = facts.inMemory;
	if (inMemory !== undefined) {
		return isTerminalState(inMemory.state) ? "dead" : "live";
	}

	// 3 + 4: an actual OS process. D4 accepts the seconds-wide window where a
	// just-exited pid still reads alive rather than inventing a grace period.
	if (facts.pidAlive === true) return "live";
	if (facts.pidAlive === false) return "dead";

	// 5 + 6: last-written heartbeat. A frozen `updatedAt` from a dead writer is
	// exactly the orphan case, and staleness is the only timestamp comparison
	// here — same row, same writer, measuring age instead of ranking writers.
	//
	// "Non-terminal" is read as the complement of `TERMINAL_STATES` (D1's wording)
	// rather than as membership in `NON_TERMINAL`: a row carrying a label we do
	// not recognise has not told us the lifecycle is over, and rule 8 still keeps
	// an *absent* ledger out of this branch.
	const ledger = facts.ledger;
	if (ledger !== undefined && !isTerminalState(ledger.status)) {
		return facts.now - ledger.updatedAt < facts.staleMs ? "live" : "dead";
	}

	// 7 + 8: a terminal verdict from either writer. The ledger row coming first is
	// D1-a's 2026-10-24 amendment: a ledger row that reached `settled`/`failed`
	// states a finished lifecycle even when the scheduler record is already gone,
	// and leaving that case at `unknown` would make the status panel call a
	// finished child undecided.
	if (ledger !== undefined && isTerminalState(ledger.status)) return "dead";
	if (facts.record !== undefined && isTerminalState(facts.record.state)) return "dead";

	// 9: never guess (D2).
	return "unknown";
}

/**
 * The display states a node can take. Declared here rather than in
 * `src/tui/viz/model.ts` so this module stays dependency-free and every W can
 * import the mapping without importing the TUI; W4 feeds `VizStatus` with
 * these values. `idle` and `queued` are new first-class states (D5), and
 * `unknown` replaces the old `retired` fallback — an unrecognised state must
 * not be painted as "retired".
 */
export type DisplayStatus =
	| "running"
	| "idle"
	| "queued"
	| "settled"
	| "failed"
	| "retired"
	| "unknown";

const DISPLAY_RUNNING: ReadonlySet<string> = new Set(["starting", "working", "running", "blocked"]);
const DISPLAY_SETTLED: ReadonlySet<string> = new Set(["settled", "success", "completed", "done"]);
const DISPLAY_FAILED: ReadonlySet<string> = new Set(["failed", "aborted", "error", "truncated"]);

/**
 * D5: raw lifecycle state → display state.
 *
 * `idle` maps to `idle` and `queued` to `queued` (rendered grey / `queued(n)`),
 * the four in-flight states collapse to `running`, and everything unrecognised
 * — including `undefined` — becomes `unknown` rather than the old `retired`
 * fallback that made a starting child look finished.
 */
export function displayStatusFromState(state: string | undefined): DisplayStatus {
	const value = (state ?? "").toLowerCase();
	if (value === "idle") return "idle";
	if (value === "queued") return "queued";
	if (DISPLAY_SETTLED.has(value)) return "settled";
	if (DISPLAY_FAILED.has(value)) return "failed";
	if (DISPLAY_RUNNING.has(value)) return "running";
	if (value === "retired") return "retired";
	return "unknown";
}
