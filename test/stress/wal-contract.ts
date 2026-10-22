/**
 * The frozen shape of the M2-(g) WAL contention claim, shared by both halves of
 * its acceptance:
 *
 *  - `test/stress/wal-stress.ts` — the 60-process / 5-minute driver that
 *    produces the number the contract actually asks for.
 *  - `test/unit/wal-concurrency.test.ts` — the seconds-long CI guard that pins
 *    the *preconditions and the transaction shape* the long run depends on.
 *
 * Both import the same `heartbeatEventTransaction`, so the fast test cannot
 * drift into validating a different write pattern than the one being stress-run.
 * This module (like its two consumers) is never loaded by production code and is
 * not in the `npm test` glob.
 */

import {
	LEGION_DB_BUSY_TIMEOUT_MS,
	LEGION_DB_REQUIRED_JOURNAL_MODE,
	withTransaction,
	type DatabaseSync,
} from "../../src/legion/db.ts";
import { appendEvent } from "../../src/legion/events.ts";
import { heartbeatNode } from "../../src/legion/nodes.ts";

/**
 * Contract §4.1 preconditions, re-exported so a reader of the stress harness
 * sees exactly which values the measurement assumes rather than guessing.
 */
export const WAL_STRESS_EXPECTED_JOURNAL_MODE = LEGION_DB_REQUIRED_JOURNAL_MODE;
export const WAL_STRESS_EXPECTED_BUSY_TIMEOUT_MS = LEGION_DB_BUSY_TIMEOUT_MS;

/** Mirror of `POSTMAN_INTERVAL_MS` (`src/extension/legion-tools.ts`). */
export const WAL_STRESS_POSTMAN_INTERVAL_MS = 2_000;

/** Contract M2-(g): "60 模拟 supervisor 并发写 5 分钟". */
export const WAL_STRESS_DEFAULT_SUPERVISORS = 60;
export const WAL_STRESS_DEFAULT_DURATION_MS = 300_000;

/**
 * Spread over which the 60 supervisors place their *first* tick.
 *
 * At a 2 s cadence every supervisor wants the same wall-clock instant; with no
 * ramp the run measures a 60-way thundering herd 150 times over, which is not
 * how independent supervisors behave (they start at unrelated times — each one
 * is a `fr.ob-open`ed child Pi). One postman interval is the natural bound: any
 * longer and the steady-state phase relation is the same as a shorter ramp,
 * because the cadence re-locks every 2 s anyway.
 */
export const WAL_STRESS_DEFAULT_START_RAMP_MS = WAL_STRESS_POSTMAN_INTERVAL_MS;

/**
 * Which offered load the run applies.
 *
 * `postman` is the contract scenario: one short transaction per supervisor per
 * `WAL_STRESS_POSTMAN_INTERVAL_MS`. `saturate` removes the sleep entirely and
 * exists only as a second, clearly-labelled data point — it measures how much
 * write capacity the ledger has, which is a different question from "does a real
 * squad's write rate stay under the busy-timeout rate".
 */
export type Workload = "postman" | "saturate";

export const WAL_STRESS_WORKLOADS: readonly Workload[] = ["postman", "saturate"];

/** Offered load implied by a workload, in transactions/second across the whole run. */
export function offeredTxPerSecond(workload: Workload, supervisors: number): number | null {
	if (workload !== "postman") return null;
	return (supervisors * 1_000) / WAL_STRESS_POSTMAN_INTERVAL_MS;
}

/**
 * Minimum committed fraction of the *offered* transaction count for a run to be
 * a measurement of anything.
 *
 * A run whose writes all fail still reports "busy rate 0.000%", which is why the
 * gate cannot look at the busy rate alone: the rate needs a denominator that
 * actually did work. 80% leaves room for the cadence losing a tick to scheduler
 * jitter (a tick whose deadline has already passed is skipped, not queued) and
 * for start-up skew across 60 forked processes, while still failing loudly on a
 * ledger whose writes are broken.
 */
export const WAL_STRESS_MIN_COMMIT_FRACTION = 0.8;

/**
 * Transactions a healthy run of this shape should commit.
 *
 * One transaction per supervisor per cadence window, for the length of the run.
 * `saturate` has no expectation: its offered count is whatever the machine can
 * absorb, so only a floor (one per supervisor) is meaningful and the caller
 * applies that.
 */
export function expectedTransactions(
	workload: Workload,
	supervisors: number,
	durationMs: number,
): number {
	if (workload !== "postman") return supervisors;
	return supervisors * Math.floor(durationMs / WAL_STRESS_POSTMAN_INTERVAL_MS);
}

/**
 * The single write transaction every simulated supervisor repeats.
 *
 * This is deliberately the *production* helpers rather than hand-written SQL, but
 * it is **not** a byte-for-byte mirror of one real postman tick, and the comment
 * here used to claim it was. The real `LegionPostman.refreshHeartbeats`
 * (`src/extension/legion-tools.ts`) issues exactly one statement per tick:
 * `heartbeatNode`'s `UPDATE nodes SET updated_at`, wrapped in a
 * `withTransaction` that covers *all* of that tick's children. `phase_change`
 * events are written by phase transitions
 * (`state-machine.ts`, `legion-tools.ts`'s `advance*`/`forcePhase` paths,
 * `orchestrator.ts`) — never by the 2 s heartbeat.
 *
 * So this helper is a deliberately *heavier* tick than production's single
 * UPDATE: it adds one `events` insert — an append to an AUTOINCREMENT table with
 * two indexes — to the same transaction. Two consequences, both intentional:
 *
 *  - the measured busy rate is **conservative**: this shape holds the write lock
 *    longer than a heartbeat-only tick would, so a real squad cannot be worse;
 *  - it keeps the run realistic rather than degenerate: a squad's ledger does
 *    take event writes continuously (the postman's own delivery/retention paths
 *    and every phase transition), and a pure 9000× single-column UPDATE would
 *    overstate how cheap contention is.
 *
 * If the intent is ever to tighten this to production's exact tick, drop the
 * `appendEvent` call and re-measure — the reported rate should only improve.
 */
export function heartbeatEventTransaction(
	db: DatabaseSync,
	nodeId: string,
	seq: number,
	now?: () => number,
): void {
	withTransaction(db, () => {
		heartbeatNode(db, nodeId, now);
		appendEvent(db, nodeId, "phase_change", { supervisor: nodeId, seq, phase: "implementing" }, { now });
	});
}

/**
 * True when an error is SQLite refusing the lock, as opposed to anything else.
 *
 * `errcode === 5` is `SQLITE_BUSY` and is the primary test; `errcode === 6`
 * (`SQLITE_LOCKED`) is the same class of contention failure. The message
 * fallback exists for drivers that drop the numeric code, and is kept narrow so
 * a genuine defect (constraint violation, malformed SQL, missing table) is never
 * laundered into a lock-timeout statistic.
 */
export function isBusyError(error: unknown): boolean {
	const candidate = error as { errcode?: unknown; message?: unknown } | null;
	if (candidate?.errcode === 5 || candidate?.errcode === 6) return true;
	const text = String(candidate?.message ?? error ?? "");
	return /SQLITE_BUSY|SQLITE_LOCKED|database is locked|database table is locked/i.test(text);
}

/** Nearest-rank percentile of an unsorted sample; `null` for an empty sample. */
export function percentile(values: readonly number[], p: number): number | null {
	if (values.length === 0) return null;
	const sorted = [...values].sort((a, b) => a - b);
	const rank = Math.ceil((p / 100) * sorted.length);
	const index = Math.min(sorted.length - 1, Math.max(0, rank - 1));
	return sorted[index] as number;
}
