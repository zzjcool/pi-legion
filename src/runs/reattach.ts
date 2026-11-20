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
import { isPidAlive, readOwnerFile, writeRunOwner, RUN_OWNER_FILE } from "./owner.ts";
import {
	createRemoteTerminalProbe,
	type RemoteTerminalProbe,
	type RemoteTerminalProbeRequest,
} from "./remote-artifact.ts";
import { execResultText, normalizeHost, resolveReadTarget, type HcExecResult } from "./remote.ts";
import { recoverCrossMachineChild, type CrossMachineRecovery } from "./remote-recover.ts";

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

export interface ReattachReport {
	/** `subagents.reattachLiveChildren: false`. */
	disabled: boolean;
	/** Candidates the pass actually probed. */
	considered: number;
	adopted: ReattachedChild[];
	skipped: ReattachSkip[];
	mirrorOnly: MirrorOnlyOrphan[];
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
 * The store surface this module needs, spelled structurally so a test can hand in
 * a directory without a supervisor (the same shape `remote-recover.ts` uses).
 */
export interface ReattachStore {
	readonly rootDir: string;
	listRuns(): Array<{ runId: string; createdAt: string; sessionFile?: string; cwd?: string; children: readonly ChildRecord[] }>;
	runDir(runId: string): string;
	updateChild?(
		runId: string,
		name: string,
		fn: (child: ChildRecord) => void,
	): Promise<unknown>;
}

/** The line counter the growth fallback reads (`file.read limit: 0` → total lines). */
export type RemoteLineCount = (request: { host: string; remotePath: string }) => Promise<number | undefined>;

export interface ReattachPassInput {
	store: ReattachStore;
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
	const own = opts.sessionFile !== undefined ? path.resolve(opts.sessionFile) : undefined;
	const runs = [...store.listRuns()].sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
	const out: ReattachCandidate[] = [];
	for (const run of runs) {
		// Our own run is not a leftover: this session launched it and holds the jobs.
		if (own !== undefined && typeof run.sessionFile === "string" && path.resolve(run.sessionFile) === own) continue;
		const owner = readOwnerFile(path.join(store.runDir(run.runId), RUN_OWNER_FILE));
		for (const child of run.children) {
			if (!REATTACH_CANDIDATE_STATES.includes(child.state)) continue;
			// A local child dies with its process; there is nothing to re-attach to.
			if (!isCrossMachineHost(child.host)) continue;
			const host = normalizeHost(child.host);
			if (host === undefined) continue;
			out.push({
				runId: run.runId,
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

function unansweredProbe(candidate: ReattachCandidate, reason: string): RemoteTerminalProbe {
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
	candidate: ReattachCandidate,
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
		...(candidate.nodeId ? { nodeId: candidate.nodeId } : {}),
		...(candidate.remoteTerminal ? { terminal: candidate.remoteTerminal } : {}),
		evidence,
		ledgerDbPath: ledgerPath,
	};
}

// ── the pass ────────────────────────────────────────────────────────────────

/**
 * One session-start pass: discover, gate, probe, adopt — bounded, never throwing.
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
	const report: ReattachReport = {
		disabled: input.settings?.reattachLiveChildren === false,
		considered: 0,
		adopted: [],
		skipped: [],
		mirrorOnly: [],
		deferred: 0,
		elapsedMs: 0,
		budgetMs,
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
		const discovered = discoverReattachCandidates(input.store, { sessionFile: input.sessionFile });
		const considered = discovered.slice(0, input.maxCandidates ?? REATTACH_MAX_CANDIDATES);
		report.deferred = Math.max(0, discovered.length - considered.length);
		const reachedHosts = new Set<string>();
		for (const candidate of considered) {
			if (now() >= deadline) {
				report.deferred += 1;
				continue;
			}
			const owned = ownerGate(candidate, { pid, alive });
			if (owned !== undefined) {
				report.skipped.push(owned);
				log(skipLine(now(), candidate, owned.reason));
				continue;
			}
			const ledger = ledgerGate(candidate, { runDir: input.store.runDir(candidate.runId) });
			if ("skip" in ledger) {
				report.skipped.push(ledger.skip);
				log(skipLine(now(), candidate, ledger.skip.reason));
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
				log(skipLine(now(), candidate, verdict.reason));
				if (verdict.terminal?.unreachable === undefined) reachedHosts.add(candidate.host);
				continue;
			}
			reachedHosts.add(candidate.host);
			try {
				const adopted = await adoptCandidate(candidate, verdict.evidence, { store: input.store, sessionFile: input.sessionFile, now, pid });
				report.adopted.push(adopted);
				log(`${new Date(now()).toISOString()} adopted ${candidate.name} run=${candidate.runId} host=${candidate.host} node=${candidate.nodeId ?? "(none)"} evidence=${JSON.stringify(verdict.evidence)}`);
			} catch (error) {
				report.skipped.push({ name: candidate.name, host: candidate.host, reason: `adoption failed (${messageOf(error)})` });
				log(skipLine(now(), candidate, `adoption failed (${messageOf(error)})`));
			}
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

function skipLine(at: number, candidate: ReattachCandidate, reason: string): string {
	return `${new Date(at).toISOString()} skipped ${candidate.name} run=${candidate.runId} host=${candidate.host} record=${candidate.recordState}: ${reason}`;
}

/** `legion: reattached 2 live children (a, b)` — the ONLY line the session sees (#445 §6). */
export function formatReattachSummary(report: ReattachReport): string | undefined {
	if (report.adopted.length === 0 && report.mirrorOnly.length === 0 && report.deferred === 0) return undefined;
	const names = report.adopted.map((child) => child.name);
	const parts: string[] = [];
	if (names.length > 0) {
		const noun = names.length === 1 ? "child" : "children";
		parts.push(`legion: reattached ${names.length} live ${noun} (${names.join(", ")})`);
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
	return parts.join("; ");
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
		this.targets.set(`${target.runId}\u0000${target.name}`, { target, strikes: 0, settling: false });
		this.deps.log(`${new Date(this.now()).toISOString()} watching ${target.name} run=${target.runId} host=${target.host} terminal=${target.remoteTerminal ?? "(none)"}`);
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
				this.targets.delete(`${target.runId}\u0000${target.name}`);
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
					this.targets.delete(`${target.runId}\u0000${target.name}`);
				}
				return;
			}
			const recovery = outcome.recovery;
			const key = `${target.runId}\u0000${target.name}`;
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
}

/**
 * The other half of the latch: "already reported, never twice" only holds if
 * "reported at all" survives a restart.
 *
 * A child still working owes nothing (its watcher announces it when the program
 * ends). A record with `notifiedAt` owes nothing. Everything else — adopted, has a
 * terminal execution, no latch — is a notice a previous session failed to deliver.
 */
export function pendingReattachNotices(
	store: ReattachStore,
	opts: { limit?: number } = {},
): PendingReattachNotice[] {
	const out: PendingReattachNotice[] = [];
	for (const run of store.listRuns()) {
		for (const child of run.children) {
			if (child.reattached === undefined) continue;
			if (alreadyNotified(child)) continue;
			const status = child.execution?.status;
			if (status === undefined || status === "running" || status === "unknown") continue;
			out.push({ runId: run.runId, name: child.name, child });
			if (out.length >= (opts.limit ?? 5)) return out;
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
