/**
 * #456 — reclaim an orphaned row whose terminal over there is already over.
 *
 * The situation measured on the release machine: yesterday's centurion finished
 * (its PR was merged), but its `pi` process is still sitting in an `hc` terminal
 * on another machine. After a restart, the new session sees a row that is
 * `orphaned` in run.json and `running` in the ledger, and there is no way out:
 *
 *   - `subagent({action:"stop"})` answers `unknown child … (not tracked by this
 *     session)` — the name lives in a previous session's store/run, and stop only
 *     searches the session's own store;
 *   - nothing settles the row on its own: the previous process is gone, so no
 *     postman tick converges it, and #445's re-attach pass cannot adopt a child
 *     that is not live (`unknown ≠ live`, and a finished terminal is not live);
 *   - the terminal keeps the process alive, so the `hc` rail keeps listing it.
 *
 * The facts needed to settle it are already recorded: run.json has `host` and
 * `remoteTerminal`, the ledger has the `orphan_detected` marker. So this module
 * asks the machine ONE question — is the program in that terminal still running?
 * — and acts only when the answer is a fact, not a guess:
 *
 * | terminal probe                              | verdict         | action                    |
 * | ------------------------------------------- | --------------- | ------------------------- |
 * | `missing` / `finished` / `killed` / exited  | `terminal-gone` | settle the row (no kill)  |
 * | alive but the PROGRAM ended (prompt / idle) | two samples …   | `stale-orphan` → kill+settle |
 * | alive and the program is working            | `working`       | leave it alone            |
 * | the machine could not be asked              | `unknown`       | leave it alone            |
 *
 * The "alive but idle" case is the one that needs the hard constraint: a kept
 * terminal stays `live` long after its program exits, so "the terminal exists"
 * must never be read as "the child is working" (the same rule `createRemoteProbe`
 * and `terminalProgramEnd` already apply). Before calling it idle, the transcript
 * is sampled TWICE: growth means the work is still being written (a flush, a
 * background writer), no growth means the row is stale. Two samples that cannot
 * be taken answer `unknown` — and `unknown` never cleans anything up.
 *
 * Nothing here adopts the child: reclaiming is settling a dead leftover, and
 * `recover` remains the (separate) way to fetch its result. A graded transcript
 * is written with the same ladder `collect`/`recover` use, so the ledger cannot
 * disagree with them about what the child did.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { hcCliClient, HcRpcError } from "../hc/client.ts";
import { legionDbPath, openLegionDb } from "../legion/db.ts";
import { appendEvent } from "../legion/events.ts";
import { getNode, hasEnded, listRemoteNodesNamed, updateNode, type LegionNode } from "../legion/nodes.ts";
import { upsertUsage } from "../legion/usage.ts";
import { deriveOutcome, parseSessionFile } from "../shared/session.ts";
import type {
	AcceptanceResult,
	ChildRecord,
	CrossMachineSettings,
	Execution,
	OrphanReclaimVerdict,
	RunRecord,
} from "../shared/types.ts";
import { raceWithTimeout } from "../supervisor/race-timeout.ts";
import { isTerminalRecordState } from "./unsupervised-row.ts";
import { deriveAcceptance, settledStatusFor } from "./orchestrator.ts";
import { isPidAlive, ownerState, readOwnerFile, RUN_OWNER_FILE } from "./owner.ts";
import {
	createRemoteSessionReadback,
	createRemoteTerminalProbe,
	remoteMirrorPathFor,
	type RemoteReadbackResult,
	type RemoteSessionRequest,
	type RemoteTerminalProbe,
	type RemoteTerminalProbeRequest,
} from "./remote-artifact.ts";
import type { RunStore } from "./store.ts";

// ── bounds ──────────────────────────────────────────────────────────────────

/** One `terminal.get` / `file.read` sample. A machine that cannot answer is unknown. */
export const ORPHAN_PROBE_DEADLINE_MS = 3_000;
/** Two samples closer than this cannot show growth (a transcript is not a clock). */
export const ORPHAN_MIN_GROWTH_WAIT_MS = 250;
/** Upper bound for one growth sample. */
export const ORPHAN_MAX_GROWTH_WAIT_MS = 1_200;
/** The whole transcript read-back, when one is attempted. */
export const ORPHAN_READBACK_DEADLINE_MS = 15_000;
/** Per-store detail log (never the transcript). */
export const ORPHAN_RECLAIM_LOG_FILE = "orphan-reclaim.log";
/** Above this the log keeps its newest half; it is a diagnostic, not a journal. */
export const ORPHAN_RECLAIM_LOG_MAX_BYTES = 128 * 1024;

// ── the persisted mark ──────────────────────────────────────────────────────

/** What reclaiming wrote on the record — who, when, on which evidence. */
export interface OrphanReclaimMark {
	at: number;
	verdict: OrphanReclaimVerdict;
	/** The one-sentence evidence the verdict rested on. */
	evidence: string;
	/** The status written to the ledger (`already-ended` when there was nothing left to write). */
	ledgerStatus: OrphanReclaimLedgerStatus | "missing";
	/** The session that reclaimed it — the "who" a later reader can check. */
	sessionFile?: string;
}

declare module "../shared/types.ts" {
	interface ChildRecord {
		/** #456: this leftover was reclaimed (see {@link OrphanReclaimMark}). */
		reclaimed?: OrphanReclaimMark;
	}
}

// ── what a leftover looks like ──────────────────────────────────────────────

/** States that mean "this record is over"; a leftover is never one of them. */
const TERMINAL_RECORD_STATES = new Set(["retired", "exited", "failed", "settled"]);

/**
 * Is this run.json child an orphaned leftover?
 *
 * Two spellings mean the same thing: the exit's `orphaned`/`unfetched` state, and
 * the marker the exit writes (`child.orphaned`). A record that also reached a
 * terminal state is not a leftover — it is history, and a second session must not
 * resurrect it.
 */
export function isOrphanedRecord(child: Pick<ChildRecord, "state" | "orphaned" | "host">): boolean {
	if (TERMINAL_RECORD_STATES.has(child.state)) return false;
	if (typeof child.host !== "string" || child.host.trim().length === 0) return false;
	return child.orphaned !== undefined || child.state === "orphaned" || child.state === "unfetched";
}

/** One leftover, with everything the wire and the ledger need — no store object. */
export interface OrphanSubject {
	/** The store whose `run.json` holds the record. */
	storeRoot: string;
	runId: string;
	/** `<storeRoot>/runs/<runId>` — where `legion.db` sits. */
	runDir: string;
	name: string;
	nodeId?: string;
	host: string;
	remoteDir?: string;
	remoteTerminal?: string;
	/** The run.json state it was found in (`orphaned` / `unfetched` / …) — for the log. */
	recordState: string;
	/** `owner.json`'s pid for that run dir, when one was recorded. */
	ownerPid?: number;
	/** The host that wrote `owner.json`; a foreign host is "live, cannot tell" (review F8). */
	ownerHost?: string;
	/** That run's `sessionFile` — the session that left the child behind. */
	ownerSessionFile?: string;
	/**
	 * #463: the CHILD's own transcript on this machine (`ChildRecord.sessionFile`).
	 *
	 * A local leftover has no `host`, so there is no machine to read a transcript
	 * back from — the child's transcript is already here, and grading it is the same
	 * ladder `collect`/`recover` use. A cross-machine subject leaves this unused.
	 */
	transcriptPath?: string;
}

/** A discovered leftover: the subject plus the record it was read from. */
export interface OrphanRow {
	subject: OrphanSubject;
	run: RunRecord;
	child: ChildRecord;
}

/** The store surface discovery needs (the same shape reattach accepts). */
export type OrphanStore = Pick<RunStore, "rootDir" | "listRuns" | "runDir" | "updateChild" | "findChild">;

/**
 * The display/identity key of a leftover: one row per `(store, name)`.
 *
 * A name is scoped to a store (#450): `worker-0` in `~/agents` and `worker-0` in
 * `~/code/anotify` are two different children, and every surface that carries an
 * inspected verdict (status overview, stop) must key it the same way.
 */
export function orphanRowKey(storeRoot: string, name: string): string {
	return `${path.resolve(storeRoot)}\u0000${name}`;
}

/** Build the subject for one record, reading the run dir's owner marker once. */
export function orphanSubjectFor(input: {
	storeRoot: string;
	runId: string;
	runDir: string;
	run: Pick<RunRecord, "sessionFile">;
	child: ChildRecord;
}): OrphanSubject {
	const owner = readOwnerFile(path.join(input.runDir, RUN_OWNER_FILE));
	return {
		storeRoot: input.storeRoot,
		runId: input.runId,
		runDir: input.runDir,
		name: input.child.name,
		...(input.child.nodeId ? { nodeId: input.child.nodeId } : {}),
		host: String(input.child.host ?? "").trim(),
		...(input.child.remoteDir ? { remoteDir: input.child.remoteDir } : {}),
		...(input.child.remoteTerminal ? { remoteTerminal: input.child.remoteTerminal } : {}),
		recordState: input.child.state,
		...(owner ? { ownerPid: owner.pid } : {}),
		...(owner?.host ? { ownerHost: owner.host } : {}),
		...(input.run.sessionFile ? { ownerSessionFile: input.run.sessionFile } : {}),
		...(input.child.sessionFile ? { transcriptPath: input.child.sessionFile } : {}),
	};
}

/**
 * Every leftover in ONE store, newest run first.
 *
 * `name` narrows to one handle; `runId` narrows to one run (an explicit scope
 * must never be widened by the search). Pure file reads — no wire, no ledger.
 */
export function findOrphanedRecordsInStore(
	store: Pick<RunStore, "rootDir" | "listRuns" | "runDir">,
	opts: { name?: string; runId?: string } = {},
): OrphanRow[] {
	let runs: RunRecord[];
	try {
		runs = store.listRuns();
	} catch {
		// An unreadable store holds nothing this call can act on; a scan that throws
		// would take the whole status/stop call with it.
		return [];
	}
	const rows: OrphanRow[] = [];
	const ordered = [...runs].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
	for (const run of ordered) {
		if (opts.runId !== undefined && run.runId !== opts.runId) continue;
		for (const child of run.children) {
			if (opts.name !== undefined && child.name !== opts.name) continue;
			if (!isOrphanedRecord(child)) continue;
			rows.push({
				run,
				child,
				subject: orphanSubjectFor({
					storeRoot: store.rootDir,
					runId: run.runId,
					runDir: store.runDir(run.runId),
					run,
					child,
				}),
			});
		}
	}
	return rows;
}

/**
 * The owner gate (#445 §3, reused verbatim): a row another LIVE session holds is
 * left alone.
 *
 * `owner.json`'s pid is written by the process that last wrote that run.json, so a
 * live pid that is not this process is another session. A pid that IS this process
 * does not block reclaim: a replaced session in this process no longer holds the
 * child, and the record is a leftover.
 */
export function orphanOwnerGate(
	subject: Pick<OrphanSubject, "ownerPid" | "ownerHost" | "ownerSessionFile" | "name" | "host">,
	opts: { pid?: number; alive?: (pid: number) => boolean; hostname?: string } = {},
): { name: string; host: string; reason: string } | undefined {
	const pid = opts.pid ?? process.pid;
	const alive = opts.alive ?? isPidAlive;
	if (subject.ownerPid === undefined) return undefined;
	if (subject.ownerPid === pid) return undefined;
	// #456 review F8: the same rule as `ownerState` — a marker written on ANOTHER
	// host cannot be checked from here, so it stays "live" (and untouched). A shared
	// or synced store must not let this host declare a foreign owner dead.
	const hostname = opts.hostname ?? os.hostname();
	if (subject.ownerHost !== undefined && subject.ownerHost !== "" && subject.ownerHost !== hostname) {
		const who = subject.ownerSessionFile !== undefined
			? path.basename(subject.ownerSessionFile)
			: `pid ${subject.ownerPid}`;
		return {
			name: subject.name,
			host: subject.host,
			reason: `owned by ${who} on host '${subject.ownerHost}' (pid ${subject.ownerPid} cannot be checked from '${hostname}', so that session still holds this child)`,
		};
	}
	if (!alive(subject.ownerPid)) return undefined;
	const who = subject.ownerSessionFile !== undefined
		? path.basename(subject.ownerSessionFile)
		: `pid ${subject.ownerPid}`;
	return {
		name: subject.name,
		host: subject.host,
		reason: `owned by ${who} (pid ${subject.ownerPid} is alive, so that session still holds this child)`,
	};
}

// ── inspection (read-only) ──────────────────────────────────────────────────

/** Two transcript samples, kept so a log line can quote the numbers. */
export interface OrphanSamples {
	remotePath: string;
	first: number;
	second: number;
	waitMs: number;
}

/** What one inspection concluded, and the sentence that says why. */
export interface OrphanEvidence {
	verdict: OrphanReclaimVerdict;
	/** One sentence, no trailing period: the evidence the verdict rests on. */
	evidence: string;
	terminal?: {
		address: string;
		state: string;
		program?: string;
		exitCode?: number;
		unreachable?: string;
	};
	samples?: OrphanSamples;
}

/** The line counter the growth fallback reads (`file.read limit: 0` → total lines). */
export type OrphanRemoteLineCount = (request: { host: string; remotePath: string }) => Promise<number | undefined>;

export interface OrphanInspectOptions {
	crossMachine?: CrossMachineSettings | undefined;
	/** Test seam: the terminal probe. Defaults to the production `hc` client. */
	probeTerminal?: (request: RemoteTerminalProbeRequest) => Promise<RemoteTerminalProbe>;
	/** Test seam: the transcript line counter. Defaults to the production `hc` client. */
	remoteLines?: OrphanRemoteLineCount;
	deadlineMs?: number;
	growthWaitMs?: number;
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function growthWait(override: number | undefined): number {
	const value = override ?? ORPHAN_MAX_GROWTH_WAIT_MS;
	return Math.max(ORPHAN_MIN_GROWTH_WAIT_MS, Math.min(value, ORPHAN_MAX_GROWTH_WAIT_MS));
}

/** The transcript's path ON THAT MACHINE, or `undefined` when the record has no dir. */
export function orphanRemoteSessionPath(subject: Pick<OrphanSubject, "remoteDir">): string | undefined {
	return subject.remoteDir ? path.posix.join(subject.remoteDir, "session.jsonl") : undefined;
}

function unanswered(subject: OrphanSubject, reason: string): OrphanEvidence {
	return {
		verdict: "unknown",
		evidence: `no liveness evidence: ${reason}`,
		terminal: {
			address: subject.remoteTerminal ?? `${subject.host}/${subject.name}`,
			state: "unknown",
			unreachable: reason,
		},
	};
}

/**
 * Read one transcript's TOTAL line count, bounded by `deadlineMs`.
 * `undefined` means "could not size it" — never zero, which is a real answer.
 */
async function sampleLines(
	lines: OrphanRemoteLineCount,
	request: { host: string; remotePath: string },
	deadlineMs: number,
): Promise<number | undefined> {
	return raceWithTimeout(lines(request).catch(() => undefined), deadlineMs, () => undefined);
}

/**
 * The terminal's own word, plus (for an alive-but-idle program) two transcript
 * samples. Every branch is evidence, and the three "leave it alone" answers
 * (`working`, and both `unknown` classes) are as important as the actionable one.
 */
export async function inspectOrphan(
	subject: OrphanSubject,
	opts: OrphanInspectOptions = {},
): Promise<OrphanEvidence> {
	const deadline = opts.deadlineMs ?? ORPHAN_PROBE_DEADLINE_MS;
	const probeTerminal = opts.probeTerminal ?? createRemoteTerminalProbe({ crossMachine: opts.crossMachine });
	const unansweredProbe = (reason: string): RemoteTerminalProbe => ({
		address: subject.remoteTerminal ?? `${subject.host}/${subject.name}`,
		state: "unknown",
		live: false,
		unreachable: reason,
	});
	const probe = await raceWithTimeout<RemoteTerminalProbe>(
		probeTerminal({
			host: subject.host,
			name: subject.name,
			...(subject.remoteTerminal ? { remoteTerminal: subject.remoteTerminal } : {}),
		}).catch((error: unknown) => unansweredProbe(messageOf(error))),
		deadline,
		() => unansweredProbe(`the probe did not answer within ${deadline}ms`),
	);
	const terminal: OrphanEvidence["terminal"] = {
		address: probe.address,
		state: probe.state,
		...(probe.program !== undefined ? { program: probe.program } : {}),
		...(probe.exitCode !== undefined ? { exitCode: probe.exitCode } : {}),
		...(probe.unreachable !== undefined ? { unreachable: probe.unreachable } : {}),
	};
	if (probe.unreachable !== undefined) {
		return unanswered(subject, `host '${subject.host}' could not be asked about ${probe.address} (${probe.unreachable})`);
	}
	// 1. The terminal is GONE: the core does not hold it, or it has finished/ended.
	//    That is a fact about the terminal itself, so no transcript sampling is
	//    needed — and requirement 3 ("a terminal that does not exist must still
	//    settle") is exactly this branch.
	//
	//    `missing` is proof only when the address was RECORDED (#456 review F1).
	//    `createRemoteTerminalProbe` falls back to an inferred `host/lgl-<name>`
	//    spelling when the record has none; a core that never held that spelling
	//    says nothing about the child — it may simply hold a different name. This is
	//    the same guard `reattach.ts` applies (`probeLiveness`): an inferred miss
	//    falls through to the transcript instead of declaring the child over.
	if (probe.state === "missing" && subject.remoteTerminal === undefined) {
		return unanswered(subject, `no terminal address was recorded for '${subject.name}', so the machine's 'missing' answer about the inferred '${probe.address}' is not proof the child ended`);
	}
	const gone = probe.state === "missing" || probe.state === "finished" || probe.state === "killed" || probe.state === "exited";
	if (gone) {
		const how = probe.state === "missing"
			? `the machine no longer holds terminal '${probe.address}'`
			: `terminal '${probe.address}' is ${probe.state} on '${subject.host}'${probe.exitCode !== undefined ? ` (exit ${probe.exitCode})` : ""}`;
		return { verdict: "terminal-gone", evidence: how, terminal };
	}
	// 2. A program the core says is still running is not a leftover. `program` is
	//    the program's own word (`working` / `blocked` / …); an explicit `working`
	//    is the strongest form. A program word of `idle` or `done`/`error` can be a
	//    finished turn in a KEPT terminal, i.e. exactly the stale leftover.
	const program = probe.program;
	const atPrompt = program === "idle" || program === "done" || program === "error";
	if (probe.live && !atPrompt && program !== undefined) {
		return {
			verdict: "working",
			evidence: `terminal '${probe.address}' is live and its program is '${program}'`,
			terminal,
		};
	}
	//    `probe.live` false means the core recorded the program's end — by exit code,
	//    finished_ms, a reason, a finished state, or a `done`/`error` word
	//    (`terminalProgramEnd`, the same judgement every other reader uses). It is an
	//    END fact even when no exit code and no program word came with it, so it falls
	//    through to the transcript sample instead of being called unknown (review F6).
	//    `probe.live` true with NO program word and no end record is the genuinely
	//    ambiguous shape: the program may simply be thinking.
	if (probe.live && program === undefined && probe.exitCode === undefined) {
		return unanswered(subject, `terminal '${probe.address}' is live and has no program word: cannot tell whether it is working`);
	}
	// 3. Alive but idle/ended: the transcript is the second sample. Growth = still
	//    being written (leave it), two equal sizes = a stale orphan (reclaim), and a
	//    sample we cannot take = unknown (never cleanup without evidence).
	const remotePath = orphanRemoteSessionPath(subject);
	if (remotePath === undefined) {
		return unanswered(subject, `terminal '${probe.address}' is ${atPrompt ? `'${program}'` : "finished"} but the record has no remote_dir, so there is no transcript to check for growth`);
	}
	const lines = opts.remoteLines ?? createRemoteLineCount(opts.crossMachine);
	const wait = growthWait(opts.growthWaitMs);
	const first = await sampleLines(lines, { host: subject.host, remotePath }, deadline);
	if (first === undefined) {
		return unanswered(subject, `transcript ${remotePath} on '${subject.host}' could not be sized (first sample failed)`);
	}
	await new Promise((resolve) => setTimeout(resolve, wait));
	const second = await sampleLines(lines, { host: subject.host, remotePath }, deadline);
	if (second === undefined) {
		return unanswered(subject, `transcript ${remotePath} on '${subject.host}' could not be sized (second sample failed)`);
	}
	const samples: OrphanSamples = { remotePath, first, second, waitMs: wait };
	if (second > first) {
		return {
			verdict: "working",
			evidence: `transcript ${remotePath} is growing (${first} → ${second} lines in ${wait}ms)`,
			terminal,
			samples,
		};
	}
	if (second === first) {
		return {
			verdict: "stale-orphan",
			evidence: `terminal '${probe.address}' is alive but its program is ${program === undefined ? "over" : `'${program}'`}, and transcript ${remotePath} did not grow (${first} → ${second} lines in ${wait}ms)`,
			terminal,
			samples,
		};
	}
	return unanswered(subject, `transcript ${remotePath} shrank (${first} → ${second} lines in ${wait}ms), which is not evidence of a quiet turn`);
}

// ── reclaim (write) ─────────────────────────────────────────────────────────

export type OrphanReclaimLedgerStatus = "settled" | "failed" | "retired" | "already-ended" | "missing";

export interface OrphanReclaimResult {
	ok: true;
	verdict: "terminal-gone" | "stale-orphan" | "no-supervisor";
	ledgerStatus: OrphanReclaimLedgerStatus;
	/** The graded outcome, when a transcript was read and graded. */
	execution?: Execution;
	acceptance?: AcceptanceResult;
	/** True when a stale terminal was actually killed. */
	killed?: boolean;
	/** False when run.json could not be updated (the ledger may still have moved). */
	recordWritten: boolean;
	/** Why run.json was not written, when it wasn't. */
	recordNote?: string;
	evidence: string;
	logLine: string;
}

export interface OrphanReclaimRefusal {
	ok: false;
	verdict: OrphanReclaimVerdict;
	evidence: string;
	reason: string;
	/** True when the idle terminal was already killed before the refusal (#456 review F5). */
	killed?: boolean;
	logLine?: string;
}

export interface OrphanReclaimOptions {
	store: OrphanStore;
	crossMachine?: CrossMachineSettings | undefined;
	/** Test seam: the transcript read-back. Defaults to the production `hc` client. */
	readback?: (request: RemoteSessionRequest) => Promise<RemoteReadbackResult>;
	/** Test seam: kill one terminal (`{}` means delivered). Defaults to `hc terminal.kill`. */
	killTerminal?: (address: string) => Promise<{ ok: true } | { ok: false; reason: string }>;
	/** Test seam: kill/read deadlines. */
	deadlineMs?: number;
	/** Per-store detail sink. Default: append under the store root. */
	log?: (line: string) => void;
	now?: () => number;
	/** This session's transcript: the "who" in the log and the record mark. */
	sessionFile?: string;
	pid?: number;
}

/** `terminal.kill` over the production client; a `not_found` means "already gone". */
async function killTerminalAt(address: string, deadlineMs: number): Promise<{ ok: true } | { ok: false; reason: string }> {
	const client = hcCliClient({ env: process.env });
	try {
		await client.start();
		await raceWithTimeout(
			client.request("terminal.kill", { terminal: address }),
			deadlineMs,
			() => {
				throw new Error(`terminal.kill did not answer within ${deadlineMs}ms`);
			},
		);
		return { ok: true };
	} catch (error) {
		// The house rule (hc/client.ts): branch on `kind`, never on prose. A kill that
		// failed for some other "... not found ..." reason must not be read as delivered
		// — that would settle a row while its terminal lives.
		if (error instanceof HcRpcError && error.kind === "not_found") return { ok: true };
		return { ok: false, reason: messageOf(error) };
	} finally {
		try {
			client.close();
		} catch {
			/* closing a socket is not a verdict */
		}
	}
}

function trimLog(file: string): void {
	try {
		const { size } = fs.statSync(file);
		if (size <= ORPHAN_RECLAIM_LOG_MAX_BYTES) return;
		const raw = fs.readFileSync(file, "utf8");
		const kept = raw.slice(-Math.floor(ORPHAN_RECLAIM_LOG_MAX_BYTES / 2));
		const atLineStart = kept.indexOf("\n");
		fs.writeFileSync(file, atLineStart === -1 ? kept : kept.slice(atLineStart + 1), "utf8");
	} catch {
		// best effort
	}
}

/** The per-store diagnostic sink (`<storeRoot>/orphan-reclaim.log`). */
export function orphanReclaimLogSink(rootDir: string): (line: string) => void {
	const file = path.join(rootDir, ORPHAN_RECLAIM_LOG_FILE);
	return (line) => {
		try {
			fs.mkdirSync(path.dirname(file), { recursive: true });
			fs.appendFileSync(file, `${line}\n`, "utf8");
			trimLog(file);
		} catch {
			// A log is a diagnostic; losing it must never cost the settle.
		}
	};
}

/** The run-dir `owner.json` on the row's own store (re-exported for the caller's gate). */
export function orphanOwnerState(subject: Pick<OrphanSubject, "runDir">): "live" | "dead" | "unknown" {
	return ownerState(path.join(subject.runDir, RUN_OWNER_FILE));
}

function byLine(input: {
	at: number;
	action: "reclaimed" | "refused";
	subject: OrphanSubject;
	evidence: OrphanEvidence;
	pid: number;
	sessionFile?: string;
	extra?: string;
}): string {
	const fields = [
		`${new Date(input.at).toISOString()} ${input.action}`,
		`name=${input.subject.name}`,
		`run=${input.subject.runId}`,
		`host=${input.subject.host}`,
		`terminal=${input.evidence.terminal?.address ?? input.subject.remoteTerminal ?? "(not recorded)"}`,
		`verdict=${input.evidence.verdict}`,
		`evidence=${JSON.stringify(input.evidence.evidence)}`,
		...(input.extra ? [input.extra] : []),
		`by=session:${input.sessionFile ?? "(unknown)"}`,
		`pid=${input.pid}`,
	];
	return fields.join(" ");
}

/** Find the ledger row this subject names: recorded id first, then name+host. */
function ledgerNodeFor(db: ReturnType<typeof openLegionDb>, subject: OrphanSubject): LegionNode | undefined {
	if (subject.nodeId) {
		const node = getNode(db, subject.nodeId);
		if (node && !hasEnded(node)) return node;
		if (node) return node;
	}
	const rows = listRemoteNodesNamed(db, subject.name).filter((node) => (node.host ?? "").trim() === subject.host);
	return rows.filter((node) => !hasEnded(node)).at(-1) ?? rows.at(-1);
}

interface Grade {
	execution?: Execution;
	acceptance?: AcceptanceResult;
	parsed: ReturnType<typeof parseSessionFile> | undefined;
}

/** Read the transcript and grade it with the same ladder `recover`/`collect` use. */
async function gradeTranscript(
	subject: OrphanSubject,
	opts: OrphanReclaimOptions,
	deadlineMs: number,
): Promise<Grade> {
	// #463: a LOCAL leftover (`host` empty) has no machine to read back from — its
	// transcript is already on this disk (`ChildRecord.sessionFile`), so grade that
	// file with the same ladder. No wire call, no deadline: a missing transcript
	// grades as `unknown`, which the callers already handle (retired, no verdict).
	if (subject.host.trim() === "") {
		const local = subject.transcriptPath;
		if (local === undefined) return { parsed: undefined };
		const parsed = parseSessionFile(local);
		const execution = deriveOutcome(parsed);
		if (execution.status === "unknown" || execution.status === "running") return { parsed, execution };
		return { parsed, execution, acceptance: deriveAcceptance(parsed, execution, undefined) };
	}
	const read = (opts.readback ?? createRemoteSessionReadback({ crossMachine: opts.crossMachine }))({
		host: subject.host,
		name: subject.name,
		localPath: remoteMirrorPathFor(subject.runDir, subject.name),
		...(subject.remoteDir ? { remoteDir: subject.remoteDir } : {}),
		...(subject.remoteTerminal ? { remoteTerminal: subject.remoteTerminal } : {}),
	});
	const readback = await raceWithTimeout(
		read.catch((error: unknown) => ({ ok: false as const, host: subject.host, reason: messageOf(error), fate: "unreachable" as const, evidence: [], nextStep: "" })),
		deadlineMs,
		() => ({ ok: false as const, host: subject.host, reason: `the transcript read did not answer within ${deadlineMs}ms`, fate: "unreachable" as const, evidence: [], nextStep: "" }),
	);
	if (!readback.ok) return { parsed: undefined };
	const parsed = parseSessionFile(readback.localPath);
	const execution = deriveOutcome(parsed);
	if (execution.status === "unknown" || execution.status === "running") return { parsed, execution };
	return { parsed, execution, acceptance: deriveAcceptance(parsed, execution, undefined) };
}

/**
 * #463: is this record's `reattached` stamp a claim by the session ASKING?
 *
 * A stamp names the session that adopted the child, and a `no-supervisor` row is by
 * definition settled by a DIFFERENT session than the one that adopted it — the adopter
 * is gone (`src/runs/unsupervised-row.ts` calls the row unheld for exactly that
 * reason). So "some stamp exists" is not a live claim; only a stamp naming
 * `sessionFile` is. Same rule and same comparison as `unheld`'s adoption clause, so
 * `status` and `stop` cannot disagree about who holds a row. A caller with no session
 * identity proves nothing and settles.
 */
function heldByThisSession(
	child: { reattached?: { sessionFile?: string | undefined } | undefined },
	sessionFile: string | undefined,
): boolean {
	const stamp = child.reattached?.sessionFile;
	if (stamp === undefined || sessionFile === undefined) return false;
	return path.resolve(stamp) === path.resolve(sessionFile);
}

/**
 * Settle one orphaned row, on evidence that already passed {@link inspectOrphan}.
 *
 * The write is three facts, in this order — the order matters:
 *   1. a `stale-orphan` terminal is KILLED first; a kill that cannot be delivered
 *      is a refusal, not a settle (claiming "cleaned up" while the process lives is
 *      worse than leaving the row visible);
 *   2. the ledger row is ended exactly as `collect`/`recover` end one: a graded
 *      transcript writes `node_settled`/`node_failed` + the usage, anything else
 *      writes `node_retired` with `execution: "unknown"` (so `recover` can still
 *      fetch the real result later — "retired without a verdict" is fetchable);
 *   3. run.json follows (`retired`, the exit's `orphaned` marker dropped,
 *      `reclaimed` stamped with who/when/evidence).
 *
 * The log line carries the same facts. Nothing is written for `working`/`unknown`.
 *
 * #463 adds one more accepted verdict, `no-supervisor`: a LOCAL leftover nobody in
 * this process holds a supervisor for (`src/runs/unsupervised-row.ts`). It needs no
 * kill and no terminal probe — the row is settled on the one fact that nobody can
 * collect it. It is still NOT a death verdict: the child's own transcript is graded
 * when it can be (a local file, no wire), and a transcript that grades nothing is
 * retired with `execution: "unknown"`, never failed (#460).
 */
export async function reclaimOrphan(
	subject: OrphanSubject,
	evidence: OrphanEvidence,
	opts: OrphanReclaimOptions,
): Promise<OrphanReclaimResult | OrphanReclaimRefusal> {
	const now = (opts.now ?? Date.now)();
	const pid = opts.pid ?? process.pid;
	const log = opts.log ?? orphanReclaimLogSink(opts.store.rootDir);
	const deadline = opts.deadlineMs ?? ORPHAN_READBACK_DEADLINE_MS;
	/** #463: settling a row no supervisor holds (no terminal, no kill, no probe). */
	const noSupervisor = evidence.verdict === "no-supervisor";
	let killed = false;
	const refuse = (reason: string, verdict: OrphanReclaimVerdict = evidence.verdict): OrphanReclaimRefusal => {
		const logLine = byLine({
			at: now,
			action: "refused",
			subject,
			evidence,
			pid,
			...(opts.sessionFile ? { sessionFile: opts.sessionFile } : {}),
			extra: `reason=${JSON.stringify(reason)} killed=${String(killed)}`,
		});
		log(logLine);
		return { ok: false, verdict, evidence: evidence.evidence, reason, ...(killed ? { killed } : {}), logLine };
	};
	if (evidence.verdict !== "terminal-gone" && evidence.verdict !== "stale-orphan" && !noSupervisor) {
		return refuse(evidence.verdict === "working"
			? "the child is still working over there: nothing was settled"
			: "no liveness evidence: nothing was settled");
	}
	if (evidence.verdict === "stale-orphan") {
		const address = evidence.terminal?.address ?? subject.remoteTerminal;
		if (address === undefined) return refuse("no recorded terminal address, so the idle terminal could not be killed");
		const kill = await (opts.killTerminal ?? ((target: string) => killTerminalAt(target, deadline)))(address);
		if (!kill.ok) return refuse(`the idle terminal '${address}' could not be killed (${kill.reason}): nothing was settled`);
		killed = true;
	}
	// The owner gate ran before up to ~18s of wire work; re-read the record now
	// (cheap, after the wire is done) so a re-attach that adopted this child in the
	// window is not retired underneath its new session. The mutator checks again
	// (atomically, under the store lock) at write time (review F8).
	//
	// #463: a `no-supervisor` row is EXPECTED to say `working` — that lie is the
	// whole point — so the state word is not the adoption signal there. The stamp a
	// LIVE claim would carry is `reattached`; but a stamp is only live when it names
	// the session ASKING (a dead session's stamp is the ghost row itself — see
	// `heldByThisSession`), and a record that turned terminal in the window was
	// settled by someone else.
	try {
		const fresh = opts.store.findChild(subject.runId, subject.name);
		if (fresh && noSupervisor) {
			if (heldByThisSession(fresh, opts.sessionFile)) {
				return refuse("another session adopted this child while it was being inspected; nothing was settled");
			}
			if (isTerminalRecordState(fresh.state)) {
				return refuse(`the record was already settled (state=${fresh.state}) while it was being inspected; nothing was settled`);
			}
		} else if (fresh && (fresh.state === "working" || fresh.reattached !== undefined)) {
			return refuse("another session adopted this child while it was being inspected; nothing was settled");
		}
	} catch {
		// An unreadable record is handled by the mutator below; do not block a ledger
		// write on a store hiccup.
	}
	// 2. The ledger. A row that is already ended stays as it is (idempotent); a
	//    missing database or row is still a record-only reclaim — the rail reads
	//    run.json, and the caller is told which half was written.
	const grade = await gradeTranscript(subject, opts, deadline);
	let ledgerStatus: OrphanReclaimLedgerStatus = "missing";
	let dbPath: string | undefined;
	try {
		dbPath = legionDbPath(subject.runDir);
		if (fs.existsSync(dbPath)) {
			const db = openLegionDb(dbPath);
			try {
				const node = ledgerNodeFor(db, subject);
				if (node === undefined) {
					ledgerStatus = "missing";
				} else if (hasEnded(node)) {
					ledgerStatus = "already-ended";
				} else if (grade.execution !== undefined) {
					ledgerStatus = settledStatusFor(grade.execution);
					updateNode(db, node.id, { status: ledgerStatus }, () => now);
					appendEvent(
						db,
						node.id,
						ledgerStatus === "settled" ? "node_settled" : ledgerStatus === "failed" ? "node_failed" : "node_retired",
						{
							execution: grade.execution.status,
							...(grade.execution.reason ? { executionReason: grade.execution.reason } : {}),
							// The FATE is the reason: `terminal-gone` / `stale-orphan`, the same
							// word the run record and the log carry.
							reason: evidence.verdict,
							reclaimed: true,
							reclaimedFrom: subject.recordState,
							evidence: evidence.evidence,
							...(subject.host ? { host: subject.host } : {}),
							...(subject.remoteTerminal ? { remoteTerminal: subject.remoteTerminal } : {}),
						},
						{ now: () => now },
					);
				} else {
					ledgerStatus = "retired";
					updateNode(db, node.id, { status: "retired" }, () => now);
					appendEvent(
						db,
						node.id,
						"node_retired",
						{
							execution: "unknown",
							reason: evidence.verdict,
							reclaimed: true,
							reclaimedFrom: subject.recordState,
							evidence: evidence.evidence,
							...(subject.host ? { host: subject.host } : {}),
							...(subject.remoteTerminal ? { remoteTerminal: subject.remoteTerminal } : {}),
						},
						{ now: () => now },
					);
				}
				// The usage row is bookkeeping, not the settle: a failure to write it must
				// not turn an already-written ledger status into a refusal (review F5).
				const usage = grade.parsed?.usage;
				if (usage && node !== undefined && ledgerStatus !== "already-ended") {
					try {
						upsertUsage(
							db,
							{
								nodeId: node.id,
								tokensIn: usage.input + usage.cacheRead + usage.cacheWrite,
								tokensOut: usage.output,
								costUsd: usage.cost,
							},
							() => now,
						);
					} catch {
						/* a diagnostic row, not a verdict */
					}
				}
			} finally {
				try {
					db.close();
				} catch {
					/* already closed */
				}
			}
		}
	} catch (error) {
		// The ledger is the authority, so a write we could not make is a refusal —
		// never a "settled" answer built on a record-only update.
		return refuse(`the ledger at ${dbPath ?? legionDbPath(subject.runDir)} could not be updated (${messageOf(error)})`);
	}
	// 3. run.json. A record that vanished underneath us is not a failure of the
	//    ledger write; it only costs the mirror half of the reclaim.
	let recordWritten = false;
	let recordNote: string | undefined;
	try {
		await opts.store.updateChild(subject.runId, subject.name, (child) => {
			// #456 review F8: the owner gate was read before up to ~18s of wire work.
			// If another live session adopted this child in the meantime, its record
			// now says `working` / carries a `reattached` stamp — do not overwrite a
			// live adoption with our retirement.
			//
			// #463: for a `no-supervisor` row, `state === "working"` is the LIE being
			// fixed, so an adoption stamp is the only signal, the `orphaned` marker is
			// not required (a local leftover never has one), and — exactly as above — a
			// stamp only counts when the session still here wrote it.
			const adoptedMeanwhile = noSupervisor
				? heldByThisSession(child, opts.sessionFile)
				: child.reattached !== undefined;
			const changedMeanwhile = noSupervisor
				? adoptedMeanwhile || isTerminalRecordState(child.state)
				: child.state === "working" || adoptedMeanwhile || child.orphaned === undefined;
			if (changedMeanwhile) {
				recordNote = `run.json changed while reclaiming (state=${child.state}${adoptedMeanwhile ? ", adopted by another session" : ""}); it was not overwritten`;
				return;
			}
			child.state = "retired";
			// A re-orphaned-and-reclaimed row is retired NOW; keep this reclaim's time
			// (a stale retiredAt from the earlier retirement would be a lie).
			child.retiredAt = new Date(now).toISOString();
			delete child.orphaned;
			// #463: the ghost verdict is spent — `state=retired` now speaks for itself.
			delete child.unsupervised;
			child.reclaimed = {
				at: now,
				verdict: evidence.verdict,
				evidence: evidence.evidence,
				ledgerStatus,
				...(opts.sessionFile ? { sessionFile: path.resolve(opts.sessionFile) } : {}),
			};
			if (grade.execution !== undefined) child.execution = grade.execution;
			if (grade.acceptance !== undefined) child.acceptance = grade.acceptance;
		});
		recordWritten = !recordNote;
	} catch (error) {
		// best effort: the ledger already moved
		recordNote = `run.json could not be updated (${messageOf(error)})`;
	}
	const logLine = byLine({
		at: now,
		action: "reclaimed",
		subject,
		evidence,
		pid,
		...(opts.sessionFile ? { sessionFile: opts.sessionFile } : {}),
		extra: `ledger=${ledgerStatus}${grade.execution ? ` execution=${grade.execution.status}` : ""} killed=${String(killed)} record=${recordWritten ? "retired" : "NOT-retired"}${recordNote ? ` note=${JSON.stringify(recordNote)}` : ""}`,
	});
	log(logLine);
	// Only the three actionable verdicts reach this point (#463 added the third).
	const settledVerdict: OrphanReclaimResult["verdict"] = noSupervisor
		? "no-supervisor"
		: evidence.verdict === "terminal-gone" ? "terminal-gone" : "stale-orphan";
	return {
		ok: true,
		verdict: settledVerdict,
		ledgerStatus,
		recordWritten,
		...(recordNote ? { recordNote } : {}),
		...(grade.execution !== undefined ? { execution: grade.execution } : {}),
		...(grade.acceptance !== undefined ? { acceptance: grade.acceptance } : {}),
		...(killed ? { killed } : {}),
		evidence: evidence.evidence,
		logLine,
	};
}

/**
 * The production line counter (`file.read limit: 0` → the file's total lines).
 * Same shape and failure semantics as `reattach.ts`'s counter; kept here so the
 * reclaim path does not depend on the re-attach module.
 */
export function createRemoteLineCount(crossMachine: CrossMachineSettings | undefined): OrphanRemoteLineCount {
	return async (request) => {
		const client = hcCliClient({ env: process.env });
		try {
			await client.start();
			const result = await client.request<{ lines?: number }>("file.read", {
				on: request.host,
				path: request.remotePath,
				limit: 0,
			});
			return typeof result?.lines === "number" && Number.isFinite(result.lines) ? Math.floor(result.lines) : undefined;
		} catch {
			return undefined;
		} finally {
			try {
				client.close();
			} catch {
				/* closing a socket is not a verdict */
			}
		}
	};
}
