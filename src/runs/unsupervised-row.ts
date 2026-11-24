/**
 * #463 — the ghost `working` row: a child that finished and was retired still
 * listed as live by `status`, and unreachable by `stop`.
 *
 * The measured shape (6.2.12, after a restart):
 *
 *   status → `state=working` `owner: live` `supervisor=inprocess` — counted as a
 *            live child, forever;
 *   stop   → `unknown child: X (not tracked by this session)`.
 *
 * Both halves come from one mistake, made twice: **`owner.json`'s pid is not the
 * child.** It names the process that last wrote that run dir, and every write to a
 * run dir refreshes it — so a stale `working` record reads `owner: live` because
 * the pid is the very process now asking, which holds no supervisor entry for that
 * child at all. `status` believed the marker (and counted the row live); `stop`
 * believed its own memory (and answered "not tracked"). Neither view asked the
 * question that decides it: *does anyone actually hold this child?*
 *
 * This module is that one question, in one place ({@link unsupervisedVerdict}), so
 * the two views cannot answer it differently:
 *
 * | fact | answer |
 * |---|---|
 * | a live supervisor entry / job in this process (`alive`/`tracked`) | held — not a ghost |
 * | another LIVE session's `owner.json` pid (not this process) | held — left alone (#445 §3, #456 F8) |
 * | marker on ANOTHER host | cannot be checked from here — left alone (#456 F8) |
 * | an #456 orphaned leftover | #456 owns it — not this module's row |
 * | terminal record state (`retired`/`exited`/`failed`/`settled`) | history — never resurrected |
 * | otherwise (`working`/`launching`/`awaiting`, no supervisor, no live foreign owner) | **`no supervisor`** |
 *
 * `no supervisor` is a *reachability* verdict, not a death verdict: the row is
 * settled as `retired` (or with its graded outcome) and never as `failed` — the
 * #460 rule that an unanswerable supervisor must not judge a child dead. It exists
 * because the record is a leftover nobody can collect: the session that launched it
 * is gone (a new session in this process, or the same process after an extension
 * reload), and `owner.json` cannot prove otherwise.
 *
 * The mark ({@link UnsupervisedMark}) is what the session-start pass (#445's
 * reattach scan) writes for a row it converges, so a later reader — `status`,
 * `stop` — sees the same verdict without re-deriving it. It is additive, on
 * `ChildRecord` only: the ledger has no column for it and needs none.
 */

import * as os from "node:os";

import type { ChildRecord, RunRecord } from "../shared/types.ts";

/**
 * Record states that mean "this record is over". The same set #456 uses
 * (`orphan-reclaim.ts`); a leftover is never one of them.
 */
const TERMINAL_RECORD_STATES = new Set(["retired", "exited", "failed", "settled"]);

/** Is this record's work over (so no surface may list it as owed/live)? */
export function isTerminalRecordState(state: string): boolean {
	return TERMINAL_RECORD_STATES.has(state);
}

/**
 * States a ghost row can be found in.
 *
 * `awaiting` is included: a child whose last collect produced no terminal snapshot
 * (`#460`'s `supervision unreachable`, or a session that died between the two
 * writes) still owes a collect, and no supervisor in this process can deliver it.
 * `orphaned`/`unfetched` are deliberately absent: those are #456's leftovers, which
 * have their own predicate (`isOrphanedRecord`), their own verdict words and their
 * own reclaim path. `blocked` waits on a human decision, not on a supervisor.
 * `queued` has no record-level process yet and is owned by the admission queue.
 */
export const UNSUPERVISED_RECORD_STATES: readonly string[] = ["working", "launching", "awaiting"];

/** The one sentence the row is settled under. Also the log/settle verdict word. */
export const UNSUPERVISED_REASON = "no supervisor";

/** What a converged row carries, so later readers need not re-derive the verdict. */
export interface UnsupervisedMark {
	at: number;
	reason: typeof UNSUPERVISED_REASON;
	/** One sentence, no trailing period: the evidence the verdict rests on. */
	evidence: string;
	/** The session that converged it — the "who" a later reader can check. */
	sessionFile?: string;
	/** What the ledger said at convergence time (`ended` ⇒ the record was retired). */
	ledger?: "running" | "ended" | "missing";
}

declare module "../shared/types.ts" {
	interface ChildRecord {
		/** #463: this row was converged as `unreachable (no supervisor)` (see {@link UnsupervisedMark}). */
		unsupervised?: UnsupervisedMark;
	}
}

/** The liveness facts the verdict reads. Only facts, no store and no wire. */
export interface UnsupervisedFacts {
	/** This process's supervisor registry: `supervisor.isAlive(name)`. */
	alive: boolean;
	/** This session's job table knows the name: `runtime.get(name) !== undefined`. */
	tracked: boolean;
	/**
	 * `owner.json` verdict for the record's OWN run dir (`ownerState`).
	 * `undefined` is read as `"unknown"` (no marker) — which is still "nobody holds it".
	 */
	owner?: "live" | "dead" | "unknown" | undefined;
	/** `owner.json`'s pid, when it recorded one. */
	ownerPid?: number | undefined;
	/** This process's pid. Default `process.pid` (pass it in tests). */
	pid?: number | undefined;
	/** The host that wrote `owner.json`; see {@link UnsupervisedMark} hosts rule. */
	ownerHost?: string | undefined;
	/** This machine's hostname (defaults to the caller's `os.hostname()`). */
	hostname?: string | undefined;
}

/** The verdict a ghost row renders and is settled under. */
export interface UnsupervisedVerdict {
	reason: typeof UNSUPERVISED_REASON;
	/** One sentence, no trailing period. */
	evidence: string;
	/** Set when the row was already converged by the session-start pass. */
	mark?: UnsupervisedMark;
}

/**
 * `true` for the #456 leftover shape (a cross-machine record carrying the exit's
 * `orphaned`/`unfetched` marker) — NOT this module's row.
 *
 * Exported because every consumer needs the same answer: an #456 leftover has its own
 * verdict words, its own reclaim path and its own `stop` branch, and #463 must leave
 * all three untouched (a scan that retired one underneath `reclaimOrphan` would also
 * retire the `orphaned (terminal gone, work done)` line a reader needs).
 */
export function isOrphanLeftover(child: Pick<ChildRecord, "state" | "host" | "orphaned">): boolean {
	if (typeof child.host !== "string" || child.host.trim().length === 0) return false;
	return child.orphaned !== undefined || child.state === "orphaned" || child.state === "unfetched";
}

/** The record's own convergence mark, when a session-start pass wrote one. */
export function unsupervisedMarkOf(child: Pick<ChildRecord, "unsupervised" | "state">): UnsupervisedMark | undefined {
	if (child.unsupervised === undefined) return undefined;
	// A mark is a fact about a row that was still owed; once the row reaches a
	// terminal state the state word speaks for itself and the mark is history.
	if (isTerminalRecordState(child.state)) return undefined;
	return child.unsupervised;
}

/**
 * The shared half of both answers: is this record a leftover **nobody here holds**?
 *
 * `undefined` means "held, or history" — every caller must treat that as "leave the
 * existing behaviour alone". Total and pure: no fs, no wire, no clock.
 */
function unheld(
	child: Pick<ChildRecord, "state" | "host" | "orphaned" | "name">,
	facts: UnsupervisedFacts,
): { evidence: string } | undefined {
	// 1. History is never resurrected (a retired row is not a ghost).
	if (isTerminalRecordState(child.state)) return undefined;
	// 2. Somebody here holds it: an in-memory supervisor entry, or a job in the
	//    session's own table (a queued/launching child exists before a handle does).
	if (facts.alive || facts.tracked) return undefined;
	// 3. #456's leftovers answer to their own predicate and their own verdict word.
	if (isOrphanLeftover(child)) return undefined;
	// 4. Only a state that owes work can be a ghost.
	if (!UNSUPERVISED_RECORD_STATES.includes(child.state)) return undefined;
	// 5. Another LIVE session's marker: that session holds the child (#445 §3).
	//    A marker written on another HOST cannot be checked from here, so it stays
	//    "live" and untouched — the same rule `ownerState` and `orphanOwnerGate`
	//    apply (#456 review F8). A pid that IS this process is not another session:
	//    it is the marker lying (that is the #463 shape).
	const pid = facts.pid ?? process.pid;
	const owner = facts.owner ?? "unknown";
	const hostname = facts.hostname ?? os.hostname();
	const foreignHost = facts.ownerHost !== undefined && facts.ownerHost !== "" && facts.ownerHost !== hostname;
	if (foreignHost) return undefined;
	if (owner === "live" && facts.ownerPid !== undefined && facts.ownerPid !== pid) return undefined;
	return { evidence: evidenceFor(child, facts, pid) };
}

/**
 * The CONVERGENCE answer — what the session-start scan stamps (#463 §4.3).
 *
 * A row nobody here holds is converged to `unreachable (no supervisor)` whatever its
 * `owner.json` says: dead, absent, or this very process. The scan is the one place
 * with the budget to look at every store's leftovers, so it is also the place that
 * turns #209-3's older words (`state=failed` for a dead owner, `state=working` for a
 * missing marker — both frozen display contracts) into the honest one.
 */
export function convergeVerdict(
	child: Pick<ChildRecord, "state" | "host" | "orphaned" | "unsupervised" | "name">,
	facts: UnsupervisedFacts,
): UnsupervisedVerdict | undefined {
	const base = unheld(child, facts);
	if (base === undefined) return undefined;
	const mark = unsupervisedMarkOf(child);
	return { reason: UNSUPERVISED_REASON, evidence: mark?.evidence ?? base.evidence, ...(mark ? { mark } : {}) };
}

/**
 * The DISPLAY / hand-settle answer — what `status` shows and what `stop` settles.
 *
 * Only the two cases a reader can PROVE at call time:
 *
 *   1. the record carries a `unsupervised` mark (a session-start scan already
 *      converged it) — the verdict survives even if the facts moved since;
 *   2. the run dir's own `owner.json` names THIS process: `owner: live` is then the
 *      marker lying, not a session working, which is the #463 shape exactly.
 *
 * An UNMARKED `owner: dead` record keeps #209-3's frozen word (`state=failed`) and an
 * unmarked `owner: unknown` keeps `state=working`; those rows are converged by the
 * scan, which is where the evidence for a stronger word actually gets gathered.
 */
export function unsupervisedVerdict(
	child: Pick<ChildRecord, "state" | "host" | "orphaned" | "unsupervised" | "name">,
	facts: UnsupervisedFacts,
): UnsupervisedVerdict | undefined {
	const verdict = convergeVerdict(child, facts);
	if (verdict === undefined) return undefined;
	if (verdict.mark !== undefined) return verdict;
	const pid = facts.pid ?? process.pid;
	return facts.owner === "live" && facts.ownerPid === pid ? verdict : undefined;
}

/** The one sentence under the header: what the record says, and why nobody holds it. */
function evidenceFor(
	child: Pick<ChildRecord, "state" | "name">,
	facts: UnsupervisedFacts,
	pid: number,
): string {
	const owner = facts.owner ?? "unknown";
	if (owner === "live" && facts.ownerPid === pid) {
		return `run.json says ${child.state} but this process (pid ${pid}, the run dir's own owner.json) holds no supervisor for it: no session can collect it`;
	}
	if (owner === "live" && facts.ownerPid === undefined) {
		return `run.json says ${child.state} but this process holds no supervisor for it: no session can collect it`;
	}
	if (owner === "dead" && facts.ownerPid !== undefined) {
		return `run.json says ${child.state} but this process holds no supervisor for it, and the run dir's owner (pid ${facts.ownerPid}) is gone: no session can collect it`;
	}
	return `run.json says ${child.state} but this process holds no supervisor for it and the run dir has no owner marker: no session can collect it`;
}

/** One ghost row, with the run it lives in. */
export interface UnsupervisedRow {
	run: RunRecord;
	child: ChildRecord;
	verdict: UnsupervisedVerdict;
}

/**
 * Every ghost row in a set of runs — the ONE discovery both `stop` and the
 * session-start pass use.
 *
 * Pure over `runs` (the caller passes `store.listRuns()`), so the two callers
 * cannot drift: identity is `(store, name)` exactly as #450/#456 froze it, newest
 * run first, `name`/`runId` narrow the search (an explicit scope is never widened).
 */
export function findUnsupervisedRows(
	runs: readonly Pick<RunRecord, "runId" | "createdAt" | "children">[],
	opts: {
		name?: string | undefined;
		runId?: string | undefined;
		factsFor: (child: ChildRecord, run: Pick<RunRecord, "runId" | "createdAt" | "children">) => UnsupervisedFacts;
		/**
		 * `display` (default) = the row `status` shows and `stop` settles by hand;
		 * `scan` = the wider convergence set the session-start pass stamps. See
		 * {@link unsupervisedVerdict} / {@link convergeVerdict}.
		 */
		mode?: "display" | "scan" | undefined;
	},
): UnsupervisedRow[] {
	const ordered = [...runs].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
	const rows: UnsupervisedRow[] = [];
	for (const run of ordered) {
		if (opts.runId !== undefined && run.runId !== opts.runId) continue;
		for (const child of run.children) {
			if (opts.name !== undefined && child.name !== opts.name) continue;
			const facts = opts.factsFor(child, run);
			const verdict = opts.mode === "scan" ? convergeVerdict(child, facts) : unsupervisedVerdict(child, facts);
			if (verdict === undefined) continue;
			rows.push({ run: run as RunRecord, child, verdict });
		}
	}
	return rows;
}
