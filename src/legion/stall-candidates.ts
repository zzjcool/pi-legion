/**
 * #441-A — who may be judged by the stall detectors at all.
 *
 * The defect this module names facts for: a child that had already RETIRED (its
 * `session.jsonl` last written at 16:45:12, `state=retired execution=success
 * acceptance=accepted` in `run.json`, its terminal gone from the core) was still
 * announced at 18:08:07 as "running for 1h 45m (threshold 45m 0s), with no tool in
 * flight". The `extend` the parent then reaches for only defers a reminder — it
 * never restarts or revives a child — so the notice was a to-do about an object
 * that no longer existed, and every later window would have re-raised it.
 *
 * #423 fixed the sibling case ("a launch that never started is not a candidate")
 * and left the terminal one open. The two are the same class of defect: a row the
 * detector can SEE is not the same fact as a run that is RUNNING.
 *
 * Two sources answer "is this child's run over?", and either one is sufficient:
 *
 *   - the ledger row — `nodes.status ∈ {settled, failed, retired}` or a terminal
 *     phase. {@link hasEnded} already owns that answer and is reused, not copied.
 *   - the run record (`run.json`'s `ChildRecord`) — written by the process that
 *     actually ran the child, so it is the EARLIER of the two when a parent has
 *     not collected yet. Its `state` moves to `retired`/`exited` as soon as the
 *     child is retired, and `execution.status` becomes terminal when the turn is
 *     graded; the ledger row may still say `running` for the whole stretch
 *     between "the child finished" and "the parent collected".
 *
 * The verdict is deliberately three-valued rather than a boolean: the caller has
 * to tombstone its per-child clocks on "ended" exactly as it does for
 * `hasEnded`, and a reason string is what lets a test (and a log line) tell the
 * two sources apart.
 *
 * Absence is not evidence: no run record (a test double, a pre-#441 caller) means
 * "this source has nothing to say", never "the child ended" — the detector keeps
 * today's behaviour instead of silently going quiet.
 */

import { hasEnded, type LegionNode } from "./nodes.ts";

/**
 * The run record's lifecycle labels that mean "this run is over".
 *
 * Superset of `liveness.ts`'s `TERMINAL_STATES` by exactly `exited` (a record whose
 * child process left before any verdict — terminal for the stall question, since
 * no tick will ever judge that child again) and WITHOUT `orphaned` /
 * `orphaned_turn_over` (6.2.4 / D2: a cross-machine child the parent session left
 * behind is deliberately non-terminal, `recover` must still be able to fetch it).
 *
 * Declared here rather than imported from `src/extension/liveness.ts`: the legion
 * layer must not depend on the extension layer, and this set is a *lifecycle*
 * fact, not a *display* one.
 */
export const ENDED_RUN_STATES: ReadonlySet<string> = new Set([
	"settled",
	"success",
	"completed",
	"done",
	"failed",
	"aborted",
	"error",
	"truncated",
	"retired",
	"exited",
]);

/** The two `run.json` fields this module reads; anything else is not its business. */
export interface StallRunFacts {
	/** `ChildRecord.state` — `working`, `awaiting`, `blocked`, `retired`, `orphaned`, … */
	readonly state?: string;
	/** `ChildRecord.execution.status` — `running`, `success`, `failed`, `truncated`, … */
	readonly executionStatus?: string;
}

/** Why a row is (or is not) a stall candidate. */
export type StallCandidateReason = "candidate" | "ledger-ended" | "run-ended";

export interface StallCandidateVerdict {
	/** True when the detectors may judge this child this tick. */
	readonly candidate: boolean;
	readonly reason: StallCandidateReason;
}

/** `true` for a lifecycle label that means the run is over (see {@link ENDED_RUN_STATES}). */
export function isEndedRunState(state: string | undefined): boolean {
	if (typeof state !== "string") return false;
	return ENDED_RUN_STATES.has(state.trim().toLowerCase());
}

/**
 * Is this child's run over? Reads BOTH sources and takes the earlier answer.
 *
 * `executionStatus` is compared with the same set: `success` / `failed` /
 * `truncated` / `aborted` / `error` all mean the turn was graded, while `running`
 * (and the absent value) mean "no verdict yet". A record that carries only an
 * execution (an older shape) is therefore still answerable.
 */
export function stallCandidateVerdict(input: {
	readonly ledger: Pick<LegionNode, "status" | "phase">;
	readonly run?: StallRunFacts | undefined;
}): StallCandidateVerdict {
	if (hasEnded(input.ledger)) return { candidate: false, reason: "ledger-ended" };
	const run = input.run;
	if (run !== undefined && (isEndedRunState(run.state) || isEndedRunState(run.executionStatus))) {
		return { candidate: false, reason: "run-ended" };
	}
	return { candidate: true, reason: "candidate" };
}
