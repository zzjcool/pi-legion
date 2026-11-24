/**
 * #445 — a session start RE-ATTACHES the cross-machine children a previous
 * session left running, so `status` lists them and their completion notice
 * arrives without anyone typing `recover`.
 *
 * The situation, measured on the release machine: restart `pi` and two children
 * are still writing on `hw-nj` (16s and 90s ago), while the new session sees
 * nothing — the run record says `orphaned`, the ledger row says `running`, the
 * terminal over there is alive, and the only way back was
 * `subagent({ action: "recover", name })`, one child at a time. The user's report
 * was "我的任务全没了"; the work was in fact still running.
 *
 * This module answers the seven questions #445 froze, and nothing else:
 *
 * 1. **Candidates.** Two sources, both read-only:
 *    - the run store under this cwd — a child record in a state that still means
 *      "owed" ({@link REATTACH_CANDIDATE_STATES}). The issue names
 *      `launching`/`working`; `orphaned`/`unfetched` are the SAME leftovers after
 *      a *clean* exit (`Orchestrator.orphanOnShutdown`), and leaving them out
 *      would make "restart pi" — a clean exit — the one case reattach never
 *      serves;
 *    - mirror-only orphans: `<mirrorRoot>/no-run/<name>/session.jsonl` dirs on a
 *      reachable machine. They have no run record and no ledger row, so they are
 *      REPORTED (log + one summary suffix) and never adopted: the settle every
 *      path here relies on is keyed on a ledger row that does not exist there.
 *
 * 2. **Liveness is evidence.** A child is adopted only when that machine says the
 *    program is still running (`terminal.get`, read through `terminalProgramEnd`,
 *    i.e. the same rule `collect`/`recover` apply) or — for a record with no
 *    terminal address at all — when its transcript is measurably GROWING between
 *    two samples. `unreachable`/`unknown` is not live: the candidate is skipped
 *    with a reason (`unknown ≠ live`).
 *
 * 3. **Never adopted.** A settled/retired row (the ledger is the authority:
 *    `hasEnded`), and a row another LIVE session holds (`owner.json`'s pid is
 *    alive and is not this process). Two sessions on one child is duplicate
 *    notices and duplicate collects.
 *
 * 4. **Bounded.** {@link REATTACH_PROBE_DEADLINE_MS} per child,
 *    {@link REATTACH_MAX_CANDIDATES} candidates, {@link REATTACH_BUDGET_MS} for
 *    the whole session-start pass. A pass that runs out of budget defers the rest
 *    ("the next start retries"); it never holds the host's `session_start`.
 *
 * 5. **Switchable.** `subagents.reattachLiveChildren: false` (default: on).
 *
 * 6. **Visible, not noisy.** ONE summary line reaches the session (the same
 *    `ui.notify` channel hygiene uses — never the transcript); per-child detail
 *    goes to {@link REATTACH_LOG_FILE} under the run store root.
 *
 * 7. **No re-reporting.** The completion notice writes `reattached.notifiedAt`
 *    on the child record only AFTER a delivered send — the persistence #417 froze
 *    for notices. A cross-machine leftover has no local artifact row, so the latch
 *    lives on the record that carries the leftover (see {@link alreadyNotified} /
 *    {@link pendingReattachNotices}).
 *
 * What adoption IS, precisely — deliberately short of "adopting into a live
 * supervisor", which `remote-recover.ts` records as a different, larger job:
 *
 *   1. the child record is re-opened (`state: "working"`, the exit's `orphaned`
 *      marker dropped, `reattached` stamped with the adopting session). `status`
 *      reads run.json, so the child is listed again with `host`, `name` and
 *      `state=working`, counted live — and the run dir's `owner.json` now names
 *      this process, which is the truth: this session watches it;
 *   2. the ledger row keeps running and its heartbeat moves (a `nodes` write: no
 *      new event type, no schema change);
 *   3. a {@link ReattachWatcher} polls that machine and, when the program ends,
 *      settles the row through `recoverCrossMachineChild` — the SAME grading and
 *      settle a `collect`/`recover` performs — and delivers ONE completion
 *      notice.
 *
 * #450 narrows nothing above; it widens only WHICH STORES this pass reads: the run
 * store is per-cwd, so a leftover launched from `~/code/anotify` was invisible to a
 * session started in `~/agents`. The pass now takes `stores` (discovery's order, the
 * session store first, deduped by resolved rootDir) and reads every store's
 * leftovers under the SAME one budget; adoption goes back through the store the
 * candidate was read from, so two stores holding the same child name never
 * cross-talk. Every candidate, adopted child and watcher target carries its
 * `storeRoot` (identity = `(storeRoot, runId, name)`), and the one summary line
 * names a foreign store only when the adoption actually reached into one.
 *
 * #463 adds the OTHER half of the same walk: what this pass does with a leftover it
 * cannot ADOPT (see {@link convergeLeftovers}). Adoption used to be the only answer,
 * so a record nobody could adopt was logged and left exactly as it was — which, for a
 * `run.json` child still saying `state=working`, meant forever: `status` counted it as
 * a live child and `stop` could not settle it (the "ghost working row"). The pass now
 * CONVERGES those rows in place, in the store that holds them:
 *
 *   - the LEDGER row already ended (`hasEnded`) ⇒ the record follows it (`state =
 *     "retired"`, `retiredAt`, the `orphaned` marker dropped) and carries an
 *     `unsupervised` mark with `ledger: "ended"`. No ledger write: the ledger is the
 *     authority (#456), and a row that ended stays as it ended;
 *   - the ledger row still runs (or is gone) and NOBODY HERE holds the child ⇒ the
 *     record keeps its state and gets the same mark with `ledger: "running"` /
 *     `"missing"`, so `status` says `unreachable (no supervisor)` and `stop` can
 *     settle it. That question is asked in exactly ONE place — `convergeVerdict`
 *     in `src/runs/unsupervised-row.ts` — so `status`, `stop` and this pass cannot
 *     answer it differently.
 *
 * Deliberately NOT converged (byte-identical to 6.2.12): an ADOPTED child (adoption
 * clears the mark), a live one, a row another LIVE session's `owner.json` holds (and
 * a marker written on another HOST, which cannot be checked from here), an #456
 * orphan (its own path owns it), a row whose ledger could not be READ ("unreadable"
 * is not "ended"), a row an earlier pass already marked, and anything terminal. The
 * step is bounded ({@link REATTACH_CONVERGE_MAX_ROWS} rows, the same pass deadline),
 * makes no wire call and writes no ledger, and it never grows a sentence of its own:
 * ` (N converged)` is a suffix on the ONE line the pass already had, and only when
 * N > 0.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { hcCliClient, type HcClient } from "../hc/client.ts";
import { deliverNotice, type NoticeChannel, type NoticeSend } from "../extension/notice-delivery.ts";
import { formatCompletionNotice, type CompletionNotice } from "../extension/notify.ts";
import { legionDbPath, openLegionDb } from "../legion/db.ts";
import { getNode, hasEnded, updateNode } from "../legion/nodes.ts";
import { isCrossMachineHost } from "../legion/orphan.ts";
import type {
	AcceptanceResult,
	ChildRecord,
	CrossMachineSettings,
	Execution,
	SubagentsSettings,
} from "../shared/types.ts";
import { raceWithTimeout } from "../supervisor/race-timeout.ts";
import { isPidAlive, ownerState, readOwnerFile, writeRunOwner, RUN_OWNER_FILE } from "./owner.ts";
import {
	createRemoteTerminalProbe,
	type RemoteTerminalProbe,
	type RemoteTerminalProbeRequest,
} from "./remote-artifact.ts";
import { execResultText, normalizeHost, resolveReadTarget, type HcExecResult } from "./remote.ts";
import { recoverCrossMachineChild, type CrossMachineRecovery } from "./remote-recover.ts";
import { formatStoreLabel, STORE_DIR, storeCwdOf } from "./store-scan.ts";
import {
	convergeVerdict,
	isOrphanLeftover,
	isTerminalRecordState,
	UNSUPERVISED_REASON,
	type UnsupervisedFacts,
} from "./unsupervised-row.ts";

// ── frozen bounds (#445 §4) ─────────────────────────────────────────────────

/** Per-child probe deadline. A machine that cannot answer in 3s does not exist for this pass. */
export const REATTACH_PROBE_DEADLINE_MS = 3_000;
/** Candidates one session-start pass may look at. */
export const REATTACH_MAX_CANDIDATES = 20;
/** The whole pass. Reaching it defers the rest instead of holding the host's start. */
export const REATTACH_BUDGET_MS = 5_000;
/** How often the watcher asks a machine whether the program is still running. */
export const REATTACH_WATCH_INTERVAL_MS = 15_000;
/** Two samples closer than this cannot show growth (a transcript is not a clock). */
export const REATTACH_MIN_GROWTH_WAIT_MS = 250;
/** Upper bound for one growth sample; the pass budget is the real limit. */
export const REATTACH_MAX_GROWTH_WAIT_MS = 1_200;
/** Consecutive unanswerable probes before the watcher stops watching a child. */
export const REATTACH_MAX_STRIKES = 3;
/** Per-child detail (never the transcript); under the run store root. */
export const REATTACH_LOG_FILE = "reattach-live-children.log";
/** Above this the log keeps its newest half; it is a diagnostic, not a journal. */
export const REATTACH_LOG_MAX_BYTES = 128 * 1024;
/** The settings key (#445 §5). Absent = on. */
export const REATTACH_SETTING_KEY = "reattachLiveChildren";
/**
 * #463: leftover rows ONE pass may converge (see {@link convergeLeftovers}).
 *
 * The step is local (no wire), but every converged row is a `run.json` write and a
 * store can hold years of leftovers; a session start must stay bounded whatever it
 * finds. Rows beyond this — or beyond the pass deadline — are reported as deferred
 * and the next start picks them up.
 */
export const REATTACH_CONVERGE_MAX_ROWS = 20;

/**
 * Record states a leftover can be found in.
 *
 * `launching`/`working` are the issue's own list. `orphaned`/`unfetched` are what
 * a CLEAN exit stamps on the very same leftover (`Orchestrator.orphanOnShutdown`),
 * and neither is terminal — the ledger row stays open on purpose so `recover` can
 * still fetch it. Excluding them would mean the most common restart (the user
 * quits `pi`, the remote child keeps working) is the one case reattach ignores.
 *
 * Everything else is deliberately absent: `retired`/`exited`/`failed`/`settled`
 * answer "this is over", `queued` has no process anywhere yet, and `blocked`
 * waits on a human decision this machine cannot deliver.
 */
export const REATTACH_CANDIDATE_STATES: readonly string[] = ["launching", "working", "orphaned", "unfetched"];

// ── the persisted mark ──────────────────────────────────────────────────────

/**
 * The adoption facts, on the child record itself.
 *
 * run.json, not the ledger, because the ledger's `nodes` row deliberately has no
 * column for "who is watching this" — and adding one would be a schema revision
 * for a fact the record that carries the launch can hold (the same additive
 * reasoning as `ChildRecord.host` / `remoteDir`).
 */
export interface ReattachedMark {
	/** When this session adopted the child (ms). */
	at: number;
	/** The adopting session's transcript — the "who" a later session reads. */
	sessionFile?: string;
	host: string;
	remoteTerminal?: string;
	/** The liveness sentence this adoption rested on. */
	evidence: string;
	/** Last successful probe of that machine (heartbeat for display only). */
	lastProbeAt?: number;
	/**
	 * #445 §7 — the notice latch, in the exact sense #417 froze: written ONCE, and
	 * only after a completion notice really reached the session. Its absence is the
	 * "still owed" state ({@link pendingReattachNotices}).
	 */
	notifiedAt?: number;
}

declare module "../shared/types.ts" {
	interface ChildRecord {
		/** #445: this record was re-attached by a later session (see `ReattachedMark`). */
		reattached?: ReattachedMark;
	}
}

// ── facts ───────────────────────────────────────────────────────────────────

/** One leftover the store knows about, before any wire call. */
export interface ReattachCandidate {
	/** The run whose `run.json` holds the record. */
	runId: string;
	/**
	 * #450: the store this record lives in (resolved `<cwd>/.pi-subagents`).
	 *
	 * Candidate identity is `(storeRoot, runId, name)`: the same name may be live in
	 * two stores at once (`~/agents` and `~/code/anotify`), and adoption must go back
	 * through the store whose record it read — never a global "the" store.
	 */
	storeRoot: string;
	/**
	 * #450: the cwd that store's launches share — `run.json`'s existing `cwd` when it
	 * has one, `dirname(storeRoot)` otherwise. No new run.json field.
	 */
	storeCwd: string;
	name: string;
	host: string;
	nodeId?: string;
	remoteDir?: string;
	remoteTerminal?: string;
	/** `run.json`'s sessionFile: the transcript of the session that launched it. */
	ownerSessionFile?: string;
	/** `owner.json`'s pid for that run dir, when one was recorded. */
	ownerPid?: number;
	/** The record state it was found in (`working`, `orphaned`, …) — for the log. */
	recordState: string;
}

/** Why one candidate was left alone. Always a sentence a human can act on. */
export interface ReattachSkip {
	name: string;
	host?: string;
	reason: string;
}

/** One adopted child: what the ledger says, what the machine said, and where. */
export interface ReattachedChild {
	name: string;
	host: string;
	runId: string;
	/** #450: the store this child was adopted in (the watcher's identity, the summary's label). */
	storeRoot: string;
	/** #450: that store's launch cwd (see {@link ReattachCandidate.storeCwd}). */
	storeCwd: string;
	nodeId?: string;
	terminal?: string;
	/** The evidence sentence (`terminal 'hw-nj/t2' is live (working)`). */
	evidence: string;
	/** The ledger this child's row lives in (`<runDir>/legion.db`). */
	ledgerDbPath: string;
}

/** A `no-run` mirror dir on a reachable machine (reported, never adopted). */
export interface MirrorOnlyOrphan {
	host: string;
	name: string;
	/** The transcript's path ON THAT MACHINE. */
	path: string;
	/** Two samples agreed the file is growing. */
	growing: boolean;
}

/**
 * #450: what the store surface looked like for one pass — the numbers the log
 * line quotes, and every store/dir discovery refused to look at with its reason.
 *
 * `skipped[].store` is a LABEL (`~/code/anotify`), the same spelling the log and
 * the summary use; `dir` from discovery is a cwd, so the label is its store's.
 */
export interface ReattachStoreSurface {
	/** Stores the pass merged in (the session store first), after dedupe. */
	scanned: number;
	/** How many of them actually held runs. */
	withRuns: number;
	/** Candidates discovered across every store, before the per-pass cap. */
	candidates: number;
	/** Discovery hit one of its own caps (`MAX_LOCAL_STORES` / `MAX_SCAN_DIRS`). */
	truncated: boolean;
	skipped: Array<{ store: string; reason: string }>;
}

export interface ReattachReport {
	/** `subagents.reattachLiveChildren: false`. */
	disabled: boolean;
	/** Candidates the pass actually probed. */
	considered: number;
	adopted: ReattachedChild[];
	skipped: ReattachSkip[];
	mirrorOnly: MirrorOnlyOrphan[];
	/**
	 * #463: leftover rows this pass CONVERGED (see {@link convergeLeftovers}) — the
	 * records nobody could adopt, now reconciled with what the ledger says: retired where
	 * the row ended, marked `unreachable (no supervisor)` where nobody here holds it.
	 *
	 * Optional so a report can be hand-built (a test, a caller replaying a log);
	 * absence reads as "nothing converged", which is also the #445 shape.
	 */
	converged?: ReattachConverged[];
	/** #463: leftover rows the convergence step did not LOOK at (its row cap, or the pass deadline). */
	deferredConverge?: number;
	/** #450: the session cwd store (`input.store`), resolved — the summary compares against it. */
	sessionStoreRoot: string;
	/** #450: the store surface this pass looked at. */
	stores: ReattachStoreSurface;
	/** Candidates never probed because the pass budget ran out ("the next start retries"). */
	deferred: number;
	elapsedMs: number;
	/** The budget this pass ran under (the summary quotes it back). */
	budgetMs: number;
	/** Set when a seam threw; the pass stops rather than half-working. */
	error?: string;
}

// ── seams ───────────────────────────────────────────────────────────────────

/**
 * The run facts candidate discovery reads. Structural, so a test can hand in a
 * plain object array (and a legacy `run.json` without `cwd` is expressible).
 */
export interface ReattachRun {
	runId: string;
	createdAt: string;
	sessionFile?: string;
	cwd?: string;
	children: readonly ChildRecord[];
}

/**
 * The store surface this module needs, spelled structurally so a test can hand in
 * a directory without a supervisor (the same shape `remote-recover.ts` uses).
 */
export interface ReattachStore {
	readonly rootDir: string;
	listRuns(): ReattachRun[];
	runDir(runId: string): string;
	updateChild?(
		runId: string,
		name: string,
		fn: (child: ChildRecord) => void,
	): Promise<unknown>;
}

/** The line counter the growth fallback reads (`file.read limit: 0` → total lines). */
export type RemoteLineCount = (request: { host: string; remotePath: string }) => Promise<number | undefined>;

/**
 * #450: the slice of discovery's stats the pass reports. `StoreScanStats` satisfies
 * it as-is, so `startReattach` can pass `{ ...stats }` without a translation table.
 */
export interface ReattachStoreScan {
	truncated: boolean;
	scannedDirs: number;
	skipped: Array<{ dir: string; reason: string }>;
}

export interface ReattachPassInput {
	/** The session cwd store. Always looked at first (#450). */
	store: ReattachStore;
	/**
	 * #450: further stores to look at, in order (discovery's own output). The pass
	 * merges `[store, ...stores]`, deduped by resolved rootDir, and probes every
	 * store's candidates under the SAME #445 bounds — one budget, not one per store.
	 */
	stores?: readonly ReattachStore[] | undefined;
	/**
	 * #450: what discovery did, so a bounded surface is REPORTED rather than
	 * silently narrowed (`truncated` + one sentence per refused dir).
	 */
	storeScan?: ReattachStoreScan | undefined;
	/** `$HOME` override for `store=` labels (tests, and a host where homedir lies). */
	home?: string | undefined;
	/** This process's session transcript. A run whose `sessionFile` matches is OURS, never a leftover. */
	sessionFile?: string | undefined;
	settings: Pick<SubagentsSettings, "crossMachine" | "reattachLiveChildren"> | undefined;
	/** Test seam: the terminal probe. Defaults to the production `hc` client. */
	probeTerminal?: (request: RemoteTerminalProbeRequest) => Promise<RemoteTerminalProbe>;
	/** Test seam: line count of a remote transcript. Defaults to the production `hc` client. */
	remoteLines?: RemoteLineCount;
	/** Test seam: the `no-run` mirror dirs on a machine. Defaults to one `machine.exec` per host. */
	listMirrorOrphans?: (host: string) => Promise<Array<{ name: string; path: string }>>;
	/** Per-child detail sink. Default: append under the store root (see {@link reattachLogSink}). */
	log?: (line: string) => void;
	now?: () => number;
	/** This process's pid; an adopted run dir records it (the claim). Default `process.pid`. */
	pid?: number;
	/** Test seam for the owner gate's liveness answer. Default `isPidAlive`. */
	alive?: (pid: number) => boolean;
	budgetMs?: number;
	probeDeadlineMs?: number;
	maxCandidates?: number;
	growthWaitMs?: number;
	/** #463: rows the convergence step may write in one pass. Default {@link REATTACH_CONVERGE_MAX_ROWS}. */
	maxConvergeRows?: number;
	/**
	 * #463: does THIS session's job table know `name` (`runtime.get(name) !== undefined`)?
	 *
	 * The one liveness fact the convergence step cannot read off disk. At a session
	 * start the table is empty, so the default (`false`) is the truth there; a caller
	 * that converges while it already runs children passes its own table.
	 */
	tracked?: (name: string) => boolean;
}

// ── candidates ──────────────────────────────────────────────────────────────

/**
 * The store's leftovers, newest run first — the most recent launch is the one the
 * user remembers.
 *
 * Pure file reads (no wire), so it always completes; the wire work is bounded
 * separately by {@link probeLiveness} and the pass budget.
 */
export function discoverReattachCandidates(
	store: ReattachStore,
	opts: { sessionFile?: string | undefined } = {},
): ReattachCandidate[] {
	return candidatesFromRuns(store, store.listRuns(), opts);
}

/**
 * #450: every store's leftovers, in STORE order (the caller's priority), newest run
 * first INSIDE a store, deduped by resolved rootDir.
 *
 * No dedupe across stores: identity is `(storeRoot, runId, name)`, because the same
 * name in two stores is two different children (`~/agents` and `~/code/anotify` can
 * both be running `worker-0`) and collapsing them would settle or announce one of
 * them twice.
 */
export function discoverReattachCandidatesAcrossStores(
	stores: readonly ReattachStore[],
	opts: { sessionFile?: string | undefined } = {},
): ReattachCandidate[] {
	const out: ReattachCandidate[] = [];
	for (const store of dedupeStores(stores)) out.push(...discoverReattachCandidates(store, opts));
	return out;
}

/** `[store, ...stores]` deduped by resolved rootDir, first spelling wins (order kept). */
function dedupeStores(stores: readonly ReattachStore[]): ReattachStore[] {
	const seen = new Set<string>();
	const out: ReattachStore[] = [];
	for (const store of stores) {
		const key = path.resolve(store.rootDir);
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(store);
	}
	return out;
}

/** The launch cwd of one run: `run.json`'s own `cwd`, else the store's directory. */
function launchCwdOf(storeRoot: string, run: { cwd?: string | undefined }): string {
	return typeof run.cwd === "string" && run.cwd.length > 0 ? run.cwd : storeCwdOf(storeRoot);
}

/** The one place candidates are built, so discovery and the pass read facts alike. */
function candidatesFromRuns(
	store: ReattachStore,
	runs: readonly ReattachRun[],
	opts: { sessionFile?: string | undefined },
): ReattachCandidate[] {
	const own = opts.sessionFile !== undefined ? path.resolve(opts.sessionFile) : undefined;
	const storeRoot = path.resolve(store.rootDir);
	const ordered = [...runs].sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
	const out: ReattachCandidate[] = [];
	for (const run of ordered) {
		// Our own run is not a leftover: this session launched it and holds the jobs.
		if (own !== undefined && typeof run.sessionFile === "string" && path.resolve(run.sessionFile) === own) continue;
		const owner = readOwnerFile(path.join(store.runDir(run.runId), RUN_OWNER_FILE));
		const storeCwd = launchCwdOf(storeRoot, run);
		for (const child of run.children) {
			if (!REATTACH_CANDIDATE_STATES.includes(child.state)) continue;
			// A local child dies with its process; there is nothing to re-attach to.
			if (!isCrossMachineHost(child.host)) continue;
			const host = normalizeHost(child.host);
			if (host === undefined) continue;
			out.push({
				runId: run.runId,
				storeRoot,
				storeCwd,
				name: child.name,
				host,
				...(child.nodeId ? { nodeId: child.nodeId } : {}),
				...(child.remoteDir ? { remoteDir: child.remoteDir } : {}),
				...(child.remoteTerminal ? { remoteTerminal: child.remoteTerminal } : {}),
				...(typeof run.sessionFile === "string" && run.sessionFile.length > 0 ? { ownerSessionFile: run.sessionFile } : {}),
				...(owner ? { ownerPid: owner.pid } : {}),
				recordState: child.state,
			});
		}
	}
	return out;
}

/** `owned by <session>` — the sentence #445's acceptance 2 asks the log to carry. */
export function ownedByLine(ownerSessionFile: string | undefined, ownerPid: number | undefined): string {
	const where = ownerSessionFile !== undefined
		? path.basename(ownerSessionFile)
		: ownerPid !== undefined
			? `pid ${ownerPid}`
			: "an unrecorded session";
	return `owned by ${where}`;
}

/**
 * The ownership gate (#445 §3): a row another LIVE session holds is left alone.
 *
 * `owner.json`'s pid is written by the process that last wrote that run.json, so a
 * live pid that is not this process is another session. A pid that IS this process
 * does not block adoption: a replaced session in this process no longer holds the
 * child (its runtime was disposed), and the record is a leftover. The
 * "another session, same pid" case is caught earlier by the `sessionFile` check in
 * {@link discoverReattachCandidates}.
 */
export function ownerGate(
	candidate: ReattachCandidate,
	opts: { pid?: number; alive?: (pid: number) => boolean } = {},
): ReattachSkip | undefined {
	const pid = opts.pid ?? process.pid;
	const alive = opts.alive ?? isPidAlive;
	if (candidate.ownerPid === undefined) return undefined;
	if (candidate.ownerPid === pid) return undefined;
	if (!alive(candidate.ownerPid)) return undefined;
	const who = ownedByLine(candidate.ownerSessionFile, candidate.ownerPid);
	return { name: candidate.name, host: candidate.host, reason: `${who} (pid ${candidate.ownerPid} is alive, so that session still holds this child)` };
}

export type LedgerGateResult =
	| { skip: ReattachSkip }
	| { ledgerPath: string; heartbeatAt?: number };

/**
 * The ledger gate (#445 §3): a settled/retired row is over, whatever the record
 * says.
 *
 * Reading the LEDGER, not the record, is what makes this the authority: a record
 * can be stale after a rebuild, a `recover` or a `collect` in another process,
 * while `nodes.status` is the one row every settle path writes. This is also where
 * #441's rule ("a clock that already passed is not a candidate") is honoured
 * without copying it: the row is asked, not re-derived.
 */
export function ledgerGate(
	candidate: ReattachCandidate,
	opts: { runDir: string; open?: typeof openLegionDb },
): LedgerGateResult {
	const dbPath = path.resolve(legionDbPath(opts.runDir));
	if (!fs.existsSync(dbPath)) {
		return { skip: { name: candidate.name, host: candidate.host, reason: `no ledger beside the run record (${dbPath}): nothing could be settled, so nothing is adopted` } };
	}
	let db: ReturnType<typeof openLegionDb> | undefined;
	try {
		db = (opts.open ?? openLegionDb)(dbPath);
		if (candidate.nodeId === undefined) {
			return { skip: { name: candidate.name, host: candidate.host, reason: "the record has no nodeId: there is no ledger row to re-attach" } };
		}
		const node = getNode(db, candidate.nodeId);
		if (node === null) {
			return { skip: { name: candidate.name, host: candidate.host, reason: `ledger row ${candidate.nodeId} is gone: the record outlived its row, so there is nothing to settle` } };
		}
		if (hasEnded(node)) {
			return { skip: { name: candidate.name, host: candidate.host, reason: `ledger row ${node.id} already ended (${node.status}): a settled/retired child is not adopted and not announced` } };
		}
		return { ledgerPath: dbPath, heartbeatAt: node.updatedAt };
	} catch (error) {
		return { skip: { name: candidate.name, host: candidate.host, reason: `the ledger at ${dbPath} could not be read (${messageOf(error)})` } };
	} finally {
		try { db?.close(); } catch { /* already closed */ }
	}
}

// ── liveness ────────────────────────────────────────────────────────────────

/** What one probe concluded, and the sentence that says why. */
export type LivenessVerdict =
	| { live: true; evidence: string; terminal?: RemoteTerminalProbe }
	| { live: false; reason: string; terminal?: RemoteTerminalProbe };

/**
 * What a liveness probe needs: the address to ask about, and nothing about which
 * store the record came from. Kept as its own shape so a caller (and a test) can
 * probe a single address without inventing a store identity for it.
 */
export interface LivenessSubject {
	runId: string;
	name: string;
	host: string;
	/** Carried so a full candidate can be passed as-is; the probe itself does not read it. */
	recordState?: string;
	remoteDir?: string;
	remoteTerminal?: string;
}

function unansweredProbe(candidate: LivenessSubject, reason: string): RemoteTerminalProbe {
	return {
		address: candidate.remoteTerminal ?? `${candidate.host}/${candidate.name}`,
		state: "unknown",
		live: false,
		unreachable: reason,
	};
}

/**
 * #445 §2 — liveness is evidence, in this order:
 *
 * 1. `terminal.get` says the program is still running (`live`, from
 *    `terminalProgramEnd` — a kept terminal whose program exited does NOT count).
 *    That is the rule `collect` and `recover` already apply, so reattach cannot
 *    disagree with them about "is this over".
 * 2. The machine could not be asked (`unreachable`) ⇒ NOT live. `unknown` is not
 *    evidence of life, and adopting on it would put a dead child back in `status`.
 * 3. A recorded address the core no longer knows (`state: "missing"`) is a fact
 *    about the address: the child ended. Not live.
 * 4. No terminal address at all: the transcript is the only evidence. Two samples
 *    `growthWaitMs` apart; growth is live, "same size" is not. One wire call per
 *    sample (`file.read limit: 0` returns the file's TOTAL line count).
 */
export async function probeLiveness(
	candidate: LivenessSubject,
	opts: {
		probeTerminal: (request: RemoteTerminalProbeRequest) => Promise<RemoteTerminalProbe>;
		remoteLines: RemoteLineCount;
		deadlineMs?: number;
		growthWaitMs?: number;
	},
): Promise<LivenessVerdict> {
	const deadline = opts.deadlineMs ?? REATTACH_PROBE_DEADLINE_MS;
	const probe = await raceWithTimeout(
		opts.probeTerminal({
			host: candidate.host,
			name: candidate.name,
			...(candidate.remoteTerminal ? { remoteTerminal: candidate.remoteTerminal } : {}),
		}).catch((error: unknown) => unansweredProbe(candidate, messageOf(error))),
		deadline,
		() => unansweredProbe(candidate, `the probe did not answer within ${deadline}ms`),
	);
	if (probe.unreachable !== undefined) {
		return {
			live: false,
			reason: `no liveness evidence: host '${candidate.host}' could not be asked about ${probe.address} (${probe.unreachable})`,
			terminal: probe,
		};
	}
	if (probe.live) {
		return {
			live: true,
			evidence: `terminal '${probe.address}' is live (${probe.program ?? probe.state})`,
			terminal: probe,
		};
	}
	if (probe.state === "missing") {
		// A MISSING terminal is proof the child ended only when the address was
		// RECORDED. An inferred spelling (`host/lgl-<name>`) that the core does not
		// know says nothing about the child — the core may simply hold a different
		// name — so a record with no recorded address falls through to the transcript
		// sample instead of being declared over.
		if (candidate.remoteTerminal !== undefined) {
			return { live: false, reason: `the machine no longer holds terminal '${probe.address}': the child ended over there`, terminal: probe };
		}
		if (candidate.remoteDir === undefined) {
			return {
				live: false,
				reason: `terminal '${probe.address}' is not held by that machine (inferred address, so not proof of an end) and the record has no remote_dir: no transcript to check for growth either`,
				terminal: probe,
			};
		}
	} else if (candidate.remoteDir === undefined) {
		return {
			live: false,
			reason: `terminal '${probe.address}' is '${probe.state}' and the record has no remote_dir, so there is no transcript to check for growth either`,
			terminal: probe,
		};
	}
	const remotePath = path.posix.join(candidate.remoteDir, "session.jsonl");
	const wait = growthWait(opts.growthWaitMs);
	const [first, second] = await sampleTwice(opts.remoteLines, { host: candidate.host, remotePath }, deadline, wait);
	if (first === undefined || second === undefined) {
		return { live: false, reason: `no liveness evidence: the transcript ${remotePath} on '${candidate.host}' could not be sized (${first === undefined ? "first" : "second"} sample failed)`, terminal: probe };
	}
	if (second > first) {
		return { live: true, evidence: `transcript ${remotePath} is growing (${first} → ${second} lines in ${wait}ms)`, terminal: probe };
	}
	return {
		live: false,
		reason: `transcript ${remotePath} did not grow (${first} → ${second} lines in ${wait}ms) and terminal '${probe.address}' is '${probe.state}'`,
		terminal: probe,
	};
}

function growthWait(override: number | undefined): number {
	const value = override ?? REATTACH_MAX_GROWTH_WAIT_MS;
	return Math.max(REATTACH_MIN_GROWTH_WAIT_MS, Math.min(value, REATTACH_MAX_GROWTH_WAIT_MS));
}

/** Two line-count samples `wait` apart, each bounded by `deadlineMs`. */
async function sampleTwice(
	lines: RemoteLineCount,
	request: { host: string; remotePath: string },
	deadlineMs: number,
	wait: number,
): Promise<[number | undefined, number | undefined]> {
	const first = await sampleLines(lines, request, deadlineMs);
	if (first === undefined) return [undefined, undefined];
	await delay(wait);
	const second = await sampleLines(lines, request, deadlineMs);
	return [first, second];
}

async function sampleLines(
	lines: RemoteLineCount,
	request: { host: string; remotePath: string },
	deadlineMs: number,
): Promise<number | undefined> {
	return raceWithTimeout(lines(request).catch(() => undefined), deadlineMs, () => undefined);
}

// ── adoption ────────────────────────────────────────────────────────────────

/**
 * Write the adoption (#445's "挂回账本"), in the two places the two readers look:
 *
 * 1. **run.json** — `state: "working"`, the exit's `orphaned` marker dropped,
 *    `reattached` stamped. `subagent({action:"status"})` reads this record, so
 *    this is what makes the child appear again with `host`/`state=working`.
 *    Writing through `RunStore.updateChild` also re-writes the run dir's
 *    `owner.json` to THIS pid — not decoration: it is the claim that keeps a
 *    second concurrently starting session off the same child, and it is what makes
 *    `status` count the child live instead of "owner dead".
 * 2. **the ledger** — the row keeps running and its heartbeat moves, so
 *    `/legion status`'s ownership block says when this session last confirmed the
 *    child. No new event type and no schema change: the fact the ledger owes (the
 *    settle) is written by the watcher through the same code a `collect` uses.
 */
export async function adoptCandidate(
	candidate: ReattachCandidate,
	evidence: string,
	opts: {
		store: ReattachStore;
		sessionFile?: string | undefined;
		now?: () => number;
		pid?: number;
	},
): Promise<ReattachedChild> {
	const now = (opts.now ?? Date.now)();
	const pid = opts.pid ?? process.pid;
	const ledgerPath = path.resolve(legionDbPath(opts.store.runDir(candidate.runId)));
	if (opts.store.updateChild === undefined) {
		throw new Error("the store cannot write child records (no updateChild): adoption would exist only in memory");
	}
	// The claim BEFORE the record: from here on, this process owns that run dir.
	writeRunOwner(opts.store.runDir(candidate.runId), pid);
	await opts.store.updateChild(candidate.runId, candidate.name, (child) => {
		child.state = "working";
		delete child.orphaned;
		child.retiredAt = undefined;
		// #463: an adoption is the proof that somebody DOES hold this child, so the
		// "no supervisor" verdict a passive scan may have stamped is no longer true.
		delete child.unsupervised;
		child.reattached = {
			at: now,
			...(opts.sessionFile ? { sessionFile: path.resolve(opts.sessionFile) } : {}),
			host: candidate.host,
			...(candidate.remoteTerminal ? { remoteTerminal: candidate.remoteTerminal } : {}),
			evidence,
			lastProbeAt: now,
		};
	});
	let db: ReturnType<typeof openLegionDb> | undefined;
	try {
		db = openLegionDb(ledgerPath);
		if (candidate.nodeId !== undefined) {
			const node = getNode(db, candidate.nodeId);
			// Same status, fresh `updated_at`: the row stays open (that is why it was a
			// candidate) and the heartbeat says a session is watching it again.
			if (node !== null && !hasEnded(node)) updateNode(db, candidate.nodeId, { status: node.status }, () => now);
		}
	} catch {
		// The record is already written; a heartbeat we could not stamp is not a reason
		// to un-adopt (nothing was changed either way).
	} finally {
		try { db?.close(); } catch { /* already closed */ }
	}
	return {
		name: candidate.name,
		host: candidate.host,
		runId: candidate.runId,
		// #450: the adopting store, so the watcher's key cannot collide with another
		// store's same-named child and the summary can label a foreign adoption.
		storeRoot: candidate.storeRoot,
		storeCwd: candidate.storeCwd,
		...(candidate.nodeId ? { nodeId: candidate.nodeId } : {}),
		...(candidate.remoteTerminal ? { terminal: candidate.remoteTerminal } : {}),
		evidence,
		ledgerDbPath: ledgerPath,
	};
}

// ── #463: convergence ───────────────────────────────────────────────────────

/** Which half of the record/ledger pair converged a leftover (#463 §4.3). */
export type ReattachConvergeHow = "ledger-ended" | "no-supervisor";

/** One row the pass converged, with the store it had to be written back into. */
export interface ReattachConverged {
	name: string;
	/** #450: the store the record lives in (resolved) — convergence writes THERE, never the session store. */
	storeRoot: string;
	how: ReattachConvergeHow;
	runId: string;
}

/** What the LEDGER says about one leftover — the one half this step must never write. */
type LedgerReading =
	| { ledger: "ended"; nodeId: string; nodeStatus: string }
	| { ledger: "running" }
	| { ledger: "missing" }
	| { ledger: "unreadable"; reason: string };

/**
 * Ask the ledger about one leftover, read-only.
 *
 * `ended` is the authority (#456) and is never re-opened here; an open row is
 * `running`, a row the ledger does not know is `missing` (the same two words the mark
 * carries), and a ledger that cannot be READ is its own answer — unreadable is not
 * ended (#456 F8), so the record is left exactly as it was.
 */
function ledgerReadingOf(runDir: string, nodeId: string | undefined): LedgerReading {
	if (nodeId === undefined) return { ledger: "missing" };
	const dbPath = path.resolve(legionDbPath(runDir));
	// `openLegionDb` CREATES a missing file; a ledger that is not there says nothing.
	if (!fs.existsSync(dbPath)) return { ledger: "missing" };
	let db: ReturnType<typeof openLegionDb> | undefined;
	try {
		db = openLegionDb(dbPath);
		const node = getNode(db, nodeId);
		if (node === null) return { ledger: "missing" };
		return hasEnded(node)
			? { ledger: "ended", nodeId: node.id, nodeStatus: node.status }
			: { ledger: "running" };
	} catch (error) {
		return { ledger: "unreadable", reason: messageOf(error) };
	} finally {
		try { db?.close(); } catch { /* already closed */ }
	}
}

/**
 * `owner.json`'s facts for one run dir, in the shape {@link convergeVerdict} reads.
 *
 * `ownerState` is the same rule `status` uses (a marker on ANOTHER host is "cannot be
 * checked from here"), and pid/host travel beside it so the verdict can tell "this very
 * process" — the #463 C1 lie — from "another live session holds it".
 */
function ownerFactsFor(
	runDir: string,
	alive: (pid: number) => boolean,
): Pick<UnsupervisedFacts, "owner" | "ownerPid" | "ownerHost"> {
	const file = path.join(runDir, RUN_OWNER_FILE);
	const owner = readOwnerFile(file);
	return {
		owner: ownerState(file, alive),
		...(owner !== undefined ? { ownerPid: owner.pid } : {}),
		...(owner !== undefined && owner.host !== "" ? { ownerHost: owner.host } : {}),
	};
}

/** `(storeRoot, runId, name)` — #450's identity, spelled once. */
function storeChildKey(storeRoot: string, runId: string, name: string): string {
	return `${path.resolve(storeRoot)}\u0000${runId}\u0000${name}`;
}

/**
 * Did somebody else take this row while the pass was looking at it?
 *
 * A settle makes the record terminal; an ADOPTION (`reattached`) inside this pass's own
 * window means another session now holds the child. Either way the record is no longer
 * this step's to reconcile — the rule `reclaimOrphan` applies to the ledger half (#463).
 */
function takenInWindow(child: Pick<ChildRecord, "state" | "reattached">, startedAt: number): boolean {
	if (isTerminalRecordState(child.state)) return true;
	return child.reattached !== undefined && child.reattached.at >= startedAt;
}

/**
 * #463 §4.3 — reconcile the leftovers this pass could NOT adopt, in place.
 *
 * For every scanned store, for every `run.json` child that is not terminal and was not
 * adopted by this pass:
 *
 *   1. the ledger row already ENDED ⇒ the record follows it (`state="retired"`,
 *      `retiredAt`, the `orphaned` marker dropped) and carries an `unsupervised` mark
 *      with `ledger: "ended"`. The ledger is NOT written: it is the authority, and a
 *      row that ended stays as it ended;
 *   2. the ledger row still runs (or is gone) and the ONE predicate
 *      (`convergeVerdict`, `src/runs/unsupervised-row.ts`) says nobody here holds
 *      the child ⇒ the record keeps its state (`retiredAt` untouched) and gets the same
 *      mark with `ledger: "running"`/`"missing"`. `status` now says
 *      `unreachable (no supervisor)` and `stop` can settle it;
 *   3. everything else — adopted, live, a live foreign owner, a marker on another host,
 *      an #456 orphan, a row an earlier pass already marked, a ledger that could not be
 *      read, a terminal record — is left byte-identical to 6.2.12.
 *
 * No wire call, no ledger write, no throw: a store with no `updateChild` converges
 * nothing (a mark that exists only in memory is worse than no mark), and one failed
 * write costs a log line and nothing else. Bounded by the caller's row cap and the pass
 * deadline; rows it did not look at are REPORTED as deferred, never silently dropped.
 */
async function convergeLeftovers(opts: {
	stores: readonly ReattachStore[];
	/** What each store's `listRuns()` returned during the scan — read once, not twice. */
	runsByRoot: ReadonlyMap<string, readonly ReattachRun[]>;
	/** `(storeRoot, runId, name)` of everything this pass adopted: never converged. */
	adopted: ReadonlySet<string>;
	sessionFile?: string | undefined;
	/** This session's job table (`runtime.get(name) !== undefined`); `false` at a session start. */
	tracked: (name: string) => boolean;
	pid: number;
	alive: (pid: number) => boolean;
	now: () => number;
	/** When the pass started — an adoption after this instant is somebody else's claim. */
	startedAt: number;
	deadline: number;
	maxRows: number;
	storeLabel: (rootDir: string) => string;
	log: (line: string) => void;
}): Promise<{ rows: ReattachConverged[]; deferred: number }> {
	const rows: ReattachConverged[] = [];
	let deferred = 0;
	const own = opts.sessionFile !== undefined ? path.resolve(opts.sessionFile) : undefined;
	const markSession = own !== undefined ? { sessionFile: own } : {};
	for (const store of opts.stores) {
		const storeRoot = path.resolve(store.rootDir);
		const write = store.updateChild;
		// A store that cannot write records converges nothing: the same rule adoption applies.
		if (write === undefined) continue;
		for (const run of opts.runsByRoot.get(storeRoot) ?? []) {
			// This session's OWN run is never a leftover (the rule discovery already applies).
			if (own !== undefined && typeof run.sessionFile === "string" && path.resolve(run.sessionFile) === own) continue;
			const leftovers = run.children.filter((child) => !isTerminalRecordState(child.state));
			if (leftovers.length === 0) continue;
			const runDir = store.runDir(run.runId);
			const label = opts.storeLabel(storeRoot);
			for (const child of leftovers) {
				if (opts.adopted.has(storeChildKey(storeRoot, run.runId, child.name))) continue;
				// #456 owns its leftovers end to end (own verdict words, own reclaim, own
				// `stop` branch). Converging one here would silently replace the
				// `orphaned (terminal gone, work done)` line a reader came for.
				if (isOrphanLeftover(child)) continue;
				if (rows.length >= opts.maxRows || opts.now() >= opts.deadline) {
					// Not converged and not forgotten: the next start picks it up.
					deferred += 1;
					continue;
				}
				const at = opts.now();
				const reading = ledgerReadingOf(runDir, child.nodeId);
				if (reading.ledger === "unreadable") {
					// A row we could not READ is not a row that ended (#456 F8).
					opts.log(`${new Date(at).toISOString()} left ${child.name} run=${run.runId} store=${label} record=${child.state}: the ledger could not be read (${reading.reason})`);
					continue;
				}
				if (reading.ledger === "ended") {
					const evidence = `ledger row ${reading.nodeId} already ended (${reading.nodeStatus}), so the record is converged to retired`;
					let changed = false;
					try {
						await write.call(store, run.runId, child.name, (fresh) => {
							if (takenInWindow(fresh, opts.startedAt)) return;
							fresh.state = "retired";
							fresh.retiredAt = new Date(at).toISOString();
							delete fresh.orphaned;
							fresh.unsupervised = {
								// A row converged before keeps the moment it was FIRST converged.
								at: fresh.unsupervised?.at ?? at,
								reason: UNSUPERVISED_REASON,
								evidence,
								ledger: "ended",
								...markSession,
							};
							changed = true;
						});
					} catch (error) {
						opts.log(`${new Date(at).toISOString()} ${child.name} run=${run.runId} store=${label}: the record could not be converged (${messageOf(error)})`);
						continue;
					}
					if (!changed) {
						opts.log(`${new Date(at).toISOString()} left ${child.name} run=${run.runId} store=${label}: settled or adopted by someone else while the pass was running`);
						continue;
					}
					rows.push({ name: child.name, storeRoot, how: "ledger-ended", runId: run.runId });
					opts.log(`${new Date(at).toISOString()} converged ${child.name} run=${run.runId} store=${label} how=ledger-ended record=${child.state}: ${evidence}`);
					continue;
				}
				// A row an earlier pass already converged is history here: byte-identical.
				if (child.unsupervised !== undefined) continue;
				const verdict = convergeVerdict(child, {
					// At a session start nobody here holds it: no supervisor entry, no job.
					alive: false,
					tracked: opts.tracked(child.name),
					pid: opts.pid,
					...ownerFactsFor(runDir, opts.alive),
				});
				if (verdict === undefined) continue;
				let changed = false;
				try {
					await write.call(store, run.runId, child.name, (fresh) => {
						if (takenInWindow(fresh, opts.startedAt)) return;
						if (fresh.unsupervised !== undefined) return;
						fresh.unsupervised = {
							at,
							reason: UNSUPERVISED_REASON,
							evidence: verdict.evidence,
							ledger: reading.ledger,
							...markSession,
						};
						changed = true;
					});
				} catch (error) {
					opts.log(`${new Date(at).toISOString()} ${child.name} run=${run.runId} store=${label}: the record could not be converged (${messageOf(error)})`);
					continue;
				}
				if (!changed) continue;
				rows.push({ name: child.name, storeRoot, how: "no-supervisor", runId: run.runId });
				opts.log(`${new Date(at).toISOString()} converged ${child.name} run=${run.runId} store=${label} how=no-supervisor ledger=${reading.ledger} record=${child.state}: ${verdict.evidence}`);
			}
		}
	}
	return { rows, deferred };
}

// ── the pass ────────────────────────────────────────────────────────────────

/**
 * One session-start pass: discover, gate, probe, adopt — bounded, never throwing.
 *
 * #450: the same pass, over `[store, ...stores]` — the session cwd store first, then
 * every store discovery found. ONE budget covers them all (a foreign store is not a
 * second pass with its own 5s), and adoption goes back through the store the
 * candidate was READ from, so two stores holding the same name never cross-talk.
 *
 * Every failure becomes a `skipped` entry with a sentence, so a broken machine, a
 * bad settings file or a locked ledger costs the session its leftovers and nothing
 * else. The deadline is checked BEFORE each candidate, so a slow machine consumes
 * its own slice and the remainder is honestly reported as deferred.
 */
export async function runReattachPass(input: ReattachPassInput): Promise<ReattachReport> {
	const now = input.now ?? Date.now;
	const startedAt = now();
	const budgetMs = input.budgetMs ?? REATTACH_BUDGET_MS;
	const deadline = startedAt + budgetMs;
	const pid = input.pid ?? process.pid;
	const log = input.log ?? reattachLogSink(input.store.rootDir);
	const labelOf = (rootDir: string): string => formatStoreLabel(rootDir, { home: input.home });
	const report: ReattachReport = {
		disabled: input.settings?.reattachLiveChildren === false,
		considered: 0,
		adopted: [],
		skipped: [],
		mirrorOnly: [],
		deferred: 0,
		elapsedMs: 0,
		budgetMs,
		sessionStoreRoot: path.resolve(input.store.rootDir),
		stores: { scanned: 0, withRuns: 0, candidates: 0, truncated: input.storeScan?.truncated === true, skipped: [] },
	};
	if (report.disabled) {
		log(`${new Date(startedAt).toISOString()} reattach disabled (subagents.${REATTACH_SETTING_KEY}: false)`);
		report.elapsedMs = now() - startedAt;
		return report;
	}
	const crossMachine = input.settings?.crossMachine;
	const probeTerminal = input.probeTerminal ?? createRemoteTerminalProbe({ crossMachine });
	const remoteLines = input.remoteLines ?? createRemoteLineCount(crossMachine);
	const listOrphans = input.listMirrorOrphans ?? createMirrorOrphanLister(crossMachine);
	const alive = input.alive ?? isPidAlive;
	try {
		// #450: the surface is every store discovery handed over, the session store
		// first, deduped by resolved rootDir. Each candidate keeps the store it came
		// from, so adoption/gating writes back into THAT store's run dir.
		const stores = dedupeStores([input.store, ...(input.stores ?? [])]);
		const storeByRoot = new Map<string, ReattachStore>();
		/** #463: what each store's `listRuns()` returned, so convergence reads it once (not twice). */
		const runsByRoot = new Map<string, readonly ReattachRun[]>();
		const discovered: ReattachCandidate[] = [];
		report.stores.scanned = stores.length;
		// What discovery refused to look at is reported verbatim: a bounded surface must
		// say so, or "no leftovers" would be a lie about a store we never read.
		for (const skipped of input.storeScan?.skipped ?? []) {
			report.stores.skipped.push({ store: labelOf(path.join(skipped.dir, STORE_DIR)), reason: skipped.reason });
		}
		for (const store of stores) {
			const rootDir = path.resolve(store.rootDir);
			storeByRoot.set(rootDir, store);
			let runs: ReattachRun[];
			try {
				runs = store.listRuns();
			} catch (error) {
				// One unreadable store must not cost the session the others: a sentence, not a
				// thrown pass.
				report.stores.skipped.push({ store: labelOf(rootDir), reason: `its runs could not be listed (${messageOf(error)})` });
				continue;
			}
			if (runs.length > 0) report.stores.withRuns += 1;
			// #463: the same read feeds the convergence step below — one scan, not two.
			runsByRoot.set(rootDir, runs);
			discovered.push(...candidatesFromRuns(store, runs, { sessionFile: input.sessionFile }));
		}
		report.stores.candidates = discovered.length;
		log(`${new Date(now()).toISOString()} reattach stores=${report.stores.scanned} withRuns=${report.stores.withRuns} candidates=${report.stores.candidates} scannedDirs=${input.storeScan?.scannedDirs ?? 0} truncated=${String(report.stores.truncated)}`);
		for (const skipped of report.stores.skipped) {
			log(`${new Date(now()).toISOString()} skipped store ${skipped.store}: ${skipped.reason}`);
		}
		const considered = discovered.slice(0, input.maxCandidates ?? REATTACH_MAX_CANDIDATES);
		report.deferred = Math.max(0, discovered.length - considered.length);
		const reachedHosts = new Set<string>();
		for (const candidate of considered) {
			if (now() >= deadline) {
				report.deferred += 1;
				continue;
			}
			// The store whose record this candidate was read from — never "the" store.
			const store = storeByRoot.get(candidate.storeRoot) ?? input.store;
			const storeLabel = labelOf(candidate.storeRoot);
			const owned = ownerGate(candidate, { pid, alive });
			if (owned !== undefined) {
				report.skipped.push(owned);
				log(skipLine(now(), candidate, owned.reason, storeLabel));
				continue;
			}
			const ledger = ledgerGate(candidate, { runDir: store.runDir(candidate.runId) });
			if ("skip" in ledger) {
				report.skipped.push(ledger.skip);
				log(skipLine(now(), candidate, ledger.skip.reason, storeLabel));
				continue;
			}
			report.considered += 1;
			const remaining = Math.max(1, deadline - now());
			const verdict = await probeLiveness(candidate, {
				probeTerminal,
				remoteLines,
				deadlineMs: Math.min(input.probeDeadlineMs ?? REATTACH_PROBE_DEADLINE_MS, remaining),
				...(input.growthWaitMs !== undefined ? { growthWaitMs: input.growthWaitMs } : {}),
			});
			if (!verdict.live) {
				report.skipped.push({ name: candidate.name, host: candidate.host, reason: verdict.reason });
				log(skipLine(now(), candidate, verdict.reason, storeLabel));
				if (verdict.terminal?.unreachable === undefined) reachedHosts.add(candidate.host);
				continue;
			}
			reachedHosts.add(candidate.host);
			try {
				const adopted = await adoptCandidate(candidate, verdict.evidence, { store, sessionFile: input.sessionFile, now, pid });
				report.adopted.push(adopted);
				log(`${new Date(now()).toISOString()} adopted ${candidate.name} run=${candidate.runId} host=${candidate.host} node=${candidate.nodeId ?? "(none)"} store=${storeLabel} evidence=${JSON.stringify(verdict.evidence)}`);
			} catch (error) {
				report.skipped.push({ name: candidate.name, host: candidate.host, reason: `adoption failed (${messageOf(error)})` });
				log(skipLine(now(), candidate, `adoption failed (${messageOf(error)})`, storeLabel));
			}
		}
		// #463: the leftover nobody adopted. Same stores, no wire, the same budget: the
		// record is reconciled with what the LEDGER already says, and written back through
		// the store that HOLDS it. This is the half that keeps `status`/`stop` honest after
		// a restart (see the module header).
		const converge = await convergeLeftovers({
			stores,
			runsByRoot,
			adopted: new Set(report.adopted.map((child) => storeChildKey(child.storeRoot, child.runId, child.name))),
			sessionFile: input.sessionFile,
			tracked: input.tracked ?? (() => false),
			pid,
			alive,
			now,
			startedAt,
			deadline,
			maxRows: input.maxConvergeRows ?? REATTACH_CONVERGE_MAX_ROWS,
			storeLabel: labelOf,
			log,
		});
		report.converged = converge.rows;
		report.deferredConverge = converge.deferred;
		if (converge.rows.length > 0 || converge.deferred > 0) {
			const named = converge.rows.map((row) => `${row.how}:${row.name}`).join(",");
			log(`${new Date(now()).toISOString()} reattach converge converged=${converge.rows.length} (${named || "-"}) deferred=${converge.deferred}`);
		}
		// Mirror-only orphans: no record and no row, so they cannot be adopted — but a
		// live `no-run` dir on a reachable machine is the same fact #445 is about, so
		// it is named in the log and counted in the summary.
		if (now() < deadline && crossMachine?.enabled === true) {
			// A machine that answered about a child is scanned first; the CONFIGURED hosts
			// follow (up to the same cap), because an orphan with no record at all is by
			// definition one a candidate never pointed at.
			const hostsToScan = [...reachedHosts];
			for (const host of Object.keys(crossMachine.hosts ?? {})) {
				if (hostsToScan.length >= 3) break;
				if (!hostsToScan.includes(host)) hostsToScan.push(host);
			}
			for (const host of hostsToScan) {
				if (now() >= deadline) break;
				const dirs = await raceWithTimeout(listOrphans(host), Math.max(1, deadline - now()), () => []);
				for (const dir of dirs.slice(0, 5)) {
					if (now() >= deadline) break;
					const growing = await transcriptGrowing(
						remoteLines,
						{ host, remotePath: dir.path },
						Math.min(input.probeDeadlineMs ?? REATTACH_PROBE_DEADLINE_MS, Math.max(1, deadline - now())),
						input.growthWaitMs,
					);
					report.mirrorOnly.push({ host, name: dir.name, path: dir.path, growing });
					log(`${new Date(now()).toISOString()} mirror-only orphan host=${host} name=${dir.name} path=${dir.path} growing=${growing}`);
				}
			}
		}
	} catch (error) {
		// A seam that threw is a bug, not a fact: report it, keep whatever was adopted.
		report.error = messageOf(error);
		log(`${new Date(now()).toISOString()} reattach pass failed: ${messageOf(error)}`);
	}
	report.elapsedMs = now() - startedAt;
	log(`${new Date(now()).toISOString()} reattach pass done in ${report.elapsedMs}ms budget=${budgetMs}ms considered=${report.considered} adopted=${report.adopted.length} skipped=${report.skipped.length} mirrorOnly=${report.mirrorOnly.length} deferred=${report.deferred}${report.error ? ` error=${report.error}` : ""}`);
	return report;
}

async function transcriptGrowing(
	lines: RemoteLineCount,
	request: { host: string; remotePath: string },
	deadlineMs: number,
	growthWaitMs: number | undefined,
): Promise<boolean> {
	const [first, second] = await sampleTwice(lines, request, deadlineMs, growthWait(growthWaitMs));
	return first !== undefined && second !== undefined && second > first;
}

function skipLine(at: number, candidate: ReattachCandidate, reason: string, storeLabel: string): string {
	return `${new Date(at).toISOString()} skipped ${candidate.name} run=${candidate.runId} host=${candidate.host} store=${storeLabel} record=${candidate.recordState}: ${reason}`;
}

/**
 * `legion: reattached 2 live children (a, b)` — the ONLY line the session sees (#445 §6).
 *
 * #450: still ONE line. An adoption that came entirely from the session cwd store
 * keeps the #445 text byte-for-byte (a user who works in one repo sees no new
 * noise); an adoption that reached into another store names it, in adoption order
 * and deduped, so "where did this child come from" is answerable from the line —
 * before the `; ` mirrorOnly/deferred suffixes.
 *
 * #463: still ONE line, byte-for-byte #450 unless the pass also CONVERGED leftovers, in
 * which case the line ends with ` (N converged)`. Convergence is bookkeeping, not news,
 * so it never becomes a sentence of its own: a pass that converged and has nothing else
 * to say stays silent (nothing is owed and nothing is retried — `status` already shows
 * the reconciled rows).
 */
export function formatReattachSummary(report: ReattachReport, opts: { home?: string | undefined } = {}): string | undefined {
	const converged = report.converged?.length ?? 0;
	if (report.adopted.length === 0 && report.mirrorOnly.length === 0 && report.deferred === 0) return undefined;
	const names = report.adopted.map((child) => child.name);
	const parts: string[] = [];
	if (names.length > 0) {
		const noun = names.length === 1 ? "child" : "children";
		const foreignStores: string[] = [];
		for (const child of report.adopted) {
			// Resolved spelling: the same store reached through two paths is ONE store, so
			// a same-store adoption can never grow a `— store` suffix by accident.
			if (path.resolve(child.storeRoot) === path.resolve(report.sessionStoreRoot)) continue;
			const label = formatStoreLabel(child.storeRoot, { home: opts.home });
			if (!foreignStores.includes(label)) foreignStores.push(label);
		}
		const where = foreignStores.length === 0
			? ""
			: foreignStores.length === 1
				? ` — store ${foreignStores[0]}`
				: ` — stores ${foreignStores.join(", ")}`;
		parts.push(`legion: reattached ${names.length} live ${noun} (${names.join(", ")})${where}`);
	}
	if (report.mirrorOnly.length > 0) {
		const hosts = [...new Set(report.mirrorOnly.map((entry) => entry.host))];
		parts.push(`${names.length > 0 ? "plus " : "legion: "}${report.mirrorOnly.length} mirror-only session dir(s) on ${hosts.join(", ")} — see ${REATTACH_LOG_FILE}`);
	}
	if (report.deferred > 0) {
		const seconds = Math.round(report.budgetMs / 1000);
		// §4: "跑不完就说稍后重试". One line, and it names the retry — a silent skip is
		// how a leftover becomes "my task is gone" again.
		parts.push(
			parts.length > 0
				? `(${report.deferred} more not probed within ${seconds}s — the next start retries)`
				: `legion: ${report.deferred} cross-machine leftover(s) not probed within ${seconds}s — the next start retries`,
		);
	}
	const line = parts.join("; ");
	return converged > 0 ? `${line} (${converged} converged)` : line;
}

/** Per-child detail sink: append under the run store root, never the transcript. */
export function reattachLogSink(rootDir: string): (line: string) => void {
	const file = path.join(rootDir, REATTACH_LOG_FILE);
	return (line) => {
		try {
			fs.mkdirSync(path.dirname(file), { recursive: true });
			fs.appendFileSync(file, `${line}\n`, "utf8");
			trimLog(file);
		} catch {
			// A log is a diagnostic; losing it must never cost the adoption itself.
		}
	};
}

function trimLog(file: string): void {
	try {
		const { size } = fs.statSync(file);
		if (size <= REATTACH_LOG_MAX_BYTES) return;
		const raw = fs.readFileSync(file, "utf8");
		const kept = raw.slice(-Math.floor(REATTACH_LOG_MAX_BYTES / 2));
		const atLineStart = kept.indexOf("\n");
		fs.writeFileSync(file, atLineStart === -1 ? kept : kept.slice(atLineStart + 1), "utf8");
	} catch {
		// best effort
	}
}

// ── the watcher ─────────────────────────────────────────────────────────────

/** One child the watcher is responsible for (the adoption's persisted identity). */
export interface ReattachWatchTarget {
	/** #450: the store the child was adopted in — part of its identity (see {@link ReattachWatcher.add}). */
	storeRoot?: string;
	/** #450: that store's launch cwd (display/diagnostic only). */
	storeCwd?: string;
	runId: string;
	name: string;
	host: string;
	nodeId?: string;
	remoteDir?: string;
	remoteTerminal?: string;
	ledgerDbPath: string;
}

/** What the settle seam returned, folded from `recoverCrossMachineChild`. */
export interface ReattachSettleOutcome {
	kind: CrossMachineRecovery["kind"];
	recovery?: CrossMachineRecovery;
	/** Why nothing could be settled (unreachable / unreadable / no gradeable turn). */
	reason?: string;
}

export interface ReattachWatcherDeps {
	/** The child is over: grade + settle it. Default: `recoverCrossMachineChild` on the row. */
	settle: (target: ReattachWatchTarget) => Promise<ReattachSettleOutcome>;
	/** Deliver one completion notice into the session. `false` = not delivered (latch not written). */
	notify: (notice: CompletionNotice, target: ReattachWatchTarget) => boolean;
	/** Persist the latch ("already reported", #445 §7) after a delivered send. */
	markNotified: (target: ReattachWatchTarget, at: number) => Promise<void>;
	/**
	 * Put the outcome on the RUN RECORD (state `retired`, execution/acceptance), so
	 * `status` stops claiming `working` for a child that finished. Optional: a watcher
	 * without a record to write (a test double) still settles the ledger and notifies.
	 */
	recordSettlement?: (target: ReattachWatchTarget, recovery: CrossMachineRecovery) => Promise<void>;
	probe: (request: RemoteTerminalProbeRequest) => Promise<RemoteTerminalProbe>;
	log: (line: string) => void;
	now?: () => number;
	intervalMs?: number;
	probeDeadlineMs?: number;
	maxStrikes?: number;
}

/**
 * The half that keeps working AFTER the session start: ask that machine, every
 * {@link REATTACH_WATCH_INTERVAL_MS}, whether the program is still running, and
 * when it ends settle the row and deliver ONE notice.
 *
 * `tick()` is public and timer-free so tests drive it deterministically;
 * `start()` installs an interval that is `unref`'d — a watcher must never be the
 * reason `pi --print` cannot drain (the same rule every background timer here
 * follows).
 */
export class ReattachWatcher {
	private readonly deps: ReattachWatcherDeps;
	private readonly targets = new Map<string, { target: ReattachWatchTarget; strikes: number; settling: boolean }>();
	private timer: ReturnType<typeof setInterval> | undefined;
	private disposed = false;
	private ticking = false;

	constructor(deps: ReattachWatcherDeps) {
		this.deps = deps;
	}

	add(target: ReattachWatchTarget): void {
		this.targets.set(this.keyOf(target), { target, strikes: 0, settling: false });
		this.deps.log(`${new Date(this.now()).toISOString()} watching ${target.name} run=${target.runId} host=${target.host} terminal=${target.remoteTerminal ?? "(none)"}`);
	}

	/**
	 * #450: a child's identity is `(storeRoot, runId, name)`.
	 *
	 * The run store is per-cwd, so `~/agents` and `~/code/anotify` can each hold a
	 * `worker-0` (and a run id is only unique inside its own store). Keying on
	 * run/name alone would make the second `add` overwrite the first: one child
	 * silently watched twice, the other never settled and never announced.
	 */
	private keyOf(target: ReattachWatchTarget): string {
		return `${target.storeRoot ?? ""}\u0000${target.runId}\u0000${target.name}`;
	}

	/** The children still being watched, in adoption order. */
	watching(): ReattachWatchTarget[] {
		return [...this.targets.values()].map((entry) => entry.target);
	}

	start(): void {
		if (this.timer !== undefined || this.disposed) return;
		this.timer = setInterval(() => { void this.tick(); }, this.deps.intervalMs ?? REATTACH_WATCH_INTERVAL_MS);
		this.timer.unref?.();
	}

	stop(): void {
		this.disposed = true;
		if (this.timer !== undefined) clearInterval(this.timer);
		this.timer = undefined;
		this.targets.clear();
	}

	async tick(): Promise<void> {
		if (this.disposed || this.ticking) return;
		this.ticking = true;
		try {
			for (const entry of [...this.targets.values()]) {
				if (this.disposed) return;
				try {
					await this.step(entry);
				} catch (error) {
					// One child's failure must not stop the others.
					this.deps.log(`${new Date(this.now()).toISOString()} watch step for ${entry.target.name} failed (${messageOf(error)})`);
				}
			}
		} finally {
			this.ticking = false;
		}
	}

	private async step(entry: { target: ReattachWatchTarget; strikes: number; settling: boolean }): Promise<void> {
		const { target } = entry;
		const maxStrikes = this.deps.maxStrikes ?? REATTACH_MAX_STRIKES;
		if (entry.settling) return;
		const now = this.now();
		const unanswered = unansweredProbe(
			{ runId: target.runId, name: target.name, host: target.host, recordState: "watching", ...(target.remoteTerminal ? { remoteTerminal: target.remoteTerminal } : {}) },
			"",
		);
		const probe = await raceWithTimeout(
			this.deps.probe({
				host: target.host,
				name: target.name,
				...(target.remoteTerminal ? { remoteTerminal: target.remoteTerminal } : {}),
			}).catch((error: unknown) => ({ ...unanswered, unreachable: messageOf(error) })),
			this.deps.probeDeadlineMs ?? REATTACH_PROBE_DEADLINE_MS,
			() => ({ ...unanswered, unreachable: "the probe did not answer in time" }),
		);
		if (probe.unreachable !== undefined) {
			entry.strikes += 1;
			this.deps.log(`${new Date(now).toISOString()} ${target.name}: machine could not be asked (${probe.unreachable}); strike ${entry.strikes}/${maxStrikes}`);
			if (entry.strikes >= maxStrikes) {
				// `unknown ≠ live`: after repeated silence the record keeps its facts (the
				// next session may find the machine back) and this session stops guessing.
				this.deps.log(`${new Date(now).toISOString()} stopped watching ${target.name}: ${entry.strikes} unanswered probes`);
				this.targets.delete(this.keyOf(target));
			}
			return;
		}
		entry.strikes = 0;
		if (probe.live) {
			this.deps.log(`${new Date(now).toISOString()} ${target.name}: still working (${probe.program ?? probe.state})`);
			return;
		}
		entry.settling = true;
		try {
			const outcome = await this.deps.settle(target);
			if (outcome.kind !== "settled-now" && outcome.kind !== "already-settled") {
				entry.strikes += 1;
				this.deps.log(`${new Date(now).toISOString()} ${target.name}: not settled (${outcome.kind}${outcome.reason ? `: ${outcome.reason}` : ""}); strike ${entry.strikes}/${maxStrikes}`);
				if (entry.strikes >= maxStrikes) {
					this.deps.log(`${new Date(now).toISOString()} stopped watching ${target.name}: ${outcome.kind} on ${entry.strikes} consecutive probes`);
					this.targets.delete(this.keyOf(target));
				}
				return;
			}
			const recovery = outcome.recovery;
			const key = this.keyOf(target);
			if (recovery === undefined) {
				this.targets.delete(key);
				return;
			}
			const delivered = this.deps.notify(reattachCompletionNotice(recovery), target);
			const at = this.now();
			if (this.deps.recordSettlement) {
				try {
					await this.deps.recordSettlement(target, recovery);
				} catch (error) {
					this.deps.log(`${new Date(at).toISOString()} ${target.name}: settled in the ledger but the run record could not be updated (${messageOf(error)})`);
				}
			}
			if (delivered) {
				// #445 §7: the latch is written AFTER the send. A failed send must leave the
				// notice owed, or the next session would drop it silently.
				try {
					await this.deps.markNotified(target, at);
				} catch (error) {
					this.deps.log(`${new Date(at).toISOString()} ${target.name}: notice delivered but the latch could not be written (${messageOf(error)})`);
				}
			} else {
				this.deps.log(`${new Date(at).toISOString()} ${target.name}: completion NOT delivered; the latch stays unset so a later session retries`);
			}
			this.targets.delete(key);
		} finally {
			entry.settling = false;
		}
	}

	private now(): number {
		return (this.deps.now ?? Date.now)();
	}
}

/**
 * The completion notice for a reattached child — the SAME formatter a `collect`
 * uses (`formatCompletionNotice`), so a user cannot tell reattached from normal,
 * which is the point of #445.
 *
 * `sessionFile` is deliberately not passed: for a cross-machine record that path
 * is the empty LOCAL placeholder this machine pre-created, and pointing the user at
 * it would be a lie. The `Run:` line plus the execution reason carry the identity.
 */
export function reattachCompletionNotice(recovery: CrossMachineRecovery): CompletionNotice {
	const execution: Execution = recovery.execution;
	const acceptance: AcceptanceResult | undefined = recovery.acceptance;
	return formatCompletionNotice({
		name: recovery.node.name,
		...(recovery.node.runId ? { runId: recovery.node.runId } : {}),
		execution: {
			status: execution.status,
			...(execution.reason ? { reason: execution.reason } : {}),
			stopReason: execution.stopReason ?? null,
			errorMessage: execution.errorMessage ?? null,
		},
		output: recovery.output,
		...(acceptance ? { acceptance: { status: acceptance.status, level: acceptance.level } } : {}),
	});
}

// ── the settle seam (production default) ────────────────────────────────────

/**
 * Grade + settle one watched child through the SAME core `collect`/`recover` use
 * (`recoverCrossMachineChild`), so a reattached completion cannot be graded by a
 * second ladder that drifts.
 *
 * The ledger is opened per settle and closed in `finally`: a watcher outlives many
 * ticks, and holding a SQLite handle for a session that may never need it again is
 * a resource the tree elsewhere deliberately avoids.
 */
export function createReattachSettle(crossMachine: CrossMachineSettings | undefined): ReattachWatcherDeps["settle"] {
	return async (target) => {
		let db: ReturnType<typeof openLegionDb> | undefined;
		try {
			db = openLegionDb(target.ledgerDbPath);
			const outcome = await recoverCrossMachineChild({
				db,
				name: target.name,
				crossMachine,
				// Beside the LEDGER, i.e. `<runDir>/remote/<name>.jsonl` — the very path a
				// collect writes, so this read refreshes the bytes the earlier session
				// fetched instead of opening a second mirror of the same file.
				mirrorDir: path.dirname(target.ledgerDbPath),
			});
			if (!outcome.ok) return { kind: "unreadable", reason: outcome.text };
			return {
				kind: outcome.recovery.kind,
				recovery: outcome.recovery,
				...(outcome.recovery.holdReason ? { reason: outcome.recovery.holdReason } : {}),
			};
		} catch (error) {
			return { kind: "unreadable", reason: messageOf(error) };
		} finally {
			try { db?.close(); } catch { /* already closed */ }
		}
	};
}

// ── the latch (#445 §7) ─────────────────────────────────────────────────────

/**
 * Deliver one completion notice through the SAME live-channel seam every other
 * notice uses (#442 A): a captured `pi` is invalidated by session replacement, so
 * the scope's CURRENT channel is tried first and the caller's captured send is the
 * last resort.
 *
 * Factored out of the extension wiring so the "通知自动到 B" claim is testable one
 * inch further than the watcher: `true` means a channel really took it (and only
 * then may the latch be written), `false` means the notice is still owed.
 */
export function deliverReattachNotice(input: {
	scope: string;
	/** The `pi` this extension load captured. */
	owner: unknown;
	/** The scope's current channel, resolved AT DELIVERY TIME by the caller. */
	live: NoticeChannel | undefined;
	/** Last resort: the caller's own send. */
	fallback: NoticeSend;
	text: string;
}): boolean {
	try {
		const outcome = deliverNotice({
			scope: input.scope,
			owner: input.owner,
			live: input.live,
			fallback: input.fallback,
			text: input.text,
		});
		return outcome.status === "delivered";
	} catch {
		// Never throws by construction (deliverNotice swallows), but a re-attach notice
		// is not worth taking a session down for.
		return false;
	}
}

/** Is this child's completion already announced? (`reattached.notifiedAt`) */
export function alreadyNotified(child: Pick<ChildRecord, "reattached">): boolean {
	return child.reattached?.notifiedAt !== undefined;
}

/** One record that was adopted, finished, and still owes its notice after a restart. */
export interface PendingReattachNotice {
	runId: string;
	name: string;
	child: ChildRecord;
	/**
	 * #450: the store this record lives in. The latch (`reattached.notifiedAt`) is
	 * written THERE — a pending notice from `~/code/anotify` must never be stamped
	 * into the session's own store, which would leave it owed forever over there.
	 */
	storeRoot: string;
	/** #450: that store's launch cwd (see {@link ReattachCandidate.storeCwd}). */
	storeCwd: string;
}

/**
 * The other half of the latch: "already reported, never twice" only holds if
 * "reported at all" survives a restart.
 *
 * A child still working owes nothing (its watcher announces it when the program
 * ends). A record with `notifiedAt` owes nothing. Everything else — adopted, has a
 * terminal execution, no latch — is a notice a previous session failed to deliver.
 *
 * #450: `stores` takes ONE store or a list; the list is deduped by resolved rootDir
 * and kept in order, so a caller can pass the discovered surface as-is and a store
 * reached twice owes its notice once.
 */
export function pendingReattachNotices(
	stores: ReattachStore | readonly ReattachStore[],
	opts: { limit?: number } = {},
): PendingReattachNotice[] {
	const surface: readonly ReattachStore[] = Array.isArray(stores)
		? (stores as readonly ReattachStore[])
		: [stores as ReattachStore];
	const limit = opts.limit ?? 5;
	const out: PendingReattachNotice[] = [];
	for (const store of dedupeStores(surface)) {
		const storeRoot = path.resolve(store.rootDir);
		for (const run of store.listRuns()) {
			const storeCwd = launchCwdOf(storeRoot, run);
			for (const child of run.children) {
				if (child.reattached === undefined) continue;
				if (alreadyNotified(child)) continue;
				const status = child.execution?.status;
				if (status === undefined || status === "running" || status === "unknown") continue;
				out.push({ runId: run.runId, name: child.name, child, storeRoot, storeCwd });
				if (out.length >= limit) return out;
			}
		}
	}
	return out;
}

/** The notice a still-owed record gets. `output` is gone with the process; the verdict is not. */
export function pendingReattachNotice(entry: PendingReattachNotice): CompletionNotice {
	const execution = entry.child.execution ?? { status: "unknown" };
	return formatCompletionNotice({
		name: entry.name,
		runId: entry.runId,
		execution: {
			status: execution.status,
			...(execution.reason ? { reason: execution.reason } : {}),
			...(execution.stopReason !== undefined ? { stopReason: execution.stopReason } : {}),
			...(execution.errorMessage !== undefined ? { errorMessage: execution.errorMessage } : {}),
		},
		output: "",
		...(entry.child.acceptance ? { acceptance: { status: entry.child.acceptance.status, level: entry.child.acceptance.level } } : {}),
	});
}

// ── defaults (production seams) ─────────────────────────────────────────────

/** One `file.read limit: 0` per call: the file's TOTAL line count (`readRemoteText`'s own trick). */
export function createRemoteLineCount(crossMachine: CrossMachineSettings | undefined): RemoteLineCount {
	return async (request) => {
		let target: ReturnType<typeof resolveReadTarget>;
		try {
			target = resolveReadTarget(request.host, crossMachine);
		} catch {
			return undefined;
		}
		const client = hcCliClient({ env: process.env });
		try {
			await client.start();
			const result = await client.request<{ lines?: number }>("file.read", { on: target.host, path: request.remotePath, limit: 0 });
			return typeof result?.lines === "number" && Number.isFinite(result.lines) ? Math.floor(result.lines) : undefined;
		} catch {
			return undefined;
		} finally {
			try { client.close(); } catch { /* closing a socket is not a verdict */ }
		}
	};
}

/**
 * `<mirrorRoot>/no-run/*` on one machine — the directories a launch left when it
 * had no run id. ONE `machine.exec` per host, capped, and only when the settings
 * can name the mirror root at all (`resolveReadTarget`'s own rule).
 */
export function createMirrorOrphanLister(
	crossMachine: CrossMachineSettings | undefined,
): (host: string) => Promise<Array<{ name: string; path: string }>> {
	return async (host) => {
		let target: ReturnType<typeof resolveReadTarget>;
		try {
			target = resolveReadTarget(host, crossMachine);
		} catch {
			return [];
		}
		if (target.mirrorRoot === undefined) return [];
		const root = path.posix.join(target.mirrorRoot, "no-run");
		const client: HcClient = hcCliClient({ env: process.env });
		try {
			await client.start();
			const result = await client.request<HcExecResult>("machine.exec", {
				on: target.host,
				line: `ls -1 ${root} 2>/dev/null | head -20`,
				timeout: 10,
			});
			const names = execResultText(result)
				.split("\n")
				.map((line) => line.trim())
				.filter((line) => /^[A-Za-z0-9._-]+$/.test(line));
			return names.map((name) => ({ name, path: path.posix.join(root, name, "session.jsonl") }));
		} catch {
			return [];
		} finally {
			try { client.close(); } catch { /* already closed */ }
		}
	};
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}
