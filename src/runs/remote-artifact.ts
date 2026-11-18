/**
 * Remote read-back (contract `cross-machine-spawn-v1` D15, S4).
 *
 * A cross-machine child writes its transcript on ITS machine; everything this
 * process derives from a transcript (`deriveOutcome`, the verdict, the artifact
 * body, the session tail) reads a local file. This module closes that gap: read
 * the remote file through `hc file.read`, land the text under
 * `<runDir>/remote/<name>.jsonl`, and report EXACTLY how much of it we have.
 *
 * Two facts from the spike shape the whole design:
 *
 * 1. `file.read` returns the FILE's total line count as `lines` — `first`/`last`
 *    describe the window actually returned. So the way to know "how much is
 *    there" is one `limit: 0` probe, not a `wc -l` round trip.
 * 2. A response can be byte-capped SILENTLY (no flag, no error). Therefore the
 *    product must never infer completeness from "the call succeeded": it asks
 *    for a window, compares `last` against what that window should have covered,
 *    and marks `truncated` itself. `file.write`'s 8 MB limit is a different
 *    contract altogether — a REFUSAL (`too_large`), tested separately.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { HcRpcError, hcCliClient, type HcClient } from "../hc/client.ts";
import type { CrossMachineSettings, SubagentError as SubagentErrorType } from "../shared/types.ts";
import { SubagentError, ErrorCodes } from "../shared/types.ts";
import {
	missingRemoteCwdQuestion,
	probeRemoteChild,
	remoteFateNextStep,
	resolveHostTarget,
	type HostTarget,
	type RemoteChildFate,
} from "./remote.ts";
import { terminalName } from "../supervisor/terminal-supervisor.ts";

/**
 * How many trailing lines a truncated read-back keeps.
 *
 * A verdict lives at the END of a transcript (the last turn's last assistant
 * message), so a tail window is the right slice, not a head. 4000 lines is
 * generous for a turn and small enough to parse quickly.
 */
export const REMOTE_TAIL_LINES = 4_000;

/** What a read-back produced, in the shape the collector and the render need. */
export interface RemoteReadback {
	ok: true;
	host: string;
	/** Local copy the collector parses (under `<runDir>/remote/`). */
	localPath: string;
	/** Lines the file has ON THAT MACHINE. */
	lines: number;
	/** Lines actually received. */
	returned: number;
	/** `returned < lines`, or the core byte-capped the window we asked for. */
	truncated: boolean;
	/** The core returned fewer lines than the window we requested (byte cap). */
	byteCapped: boolean;
}

export interface RemoteReadbackFailure {
	ok: false;
	host: string;
	reason: string;
	/** `started` never appears here: a failure is one of these four. */
	fate: RemoteReadbackFate;
	/** 1..5 short lines ("terminal finished", "exit 1", "dir holds: system-prompt.md"). */
	evidence: string[];
	nextStep: string;
	/**
	 * The child's own last screen lines, when the probe could read them.
	 *
	 * Not in the contract's field list (§5) but the render it freezes (§6.1) prints
	 * `screen: <screenTail …>` "only when the fate carries one" — the probe is the
	 * only thing that can carry it, so it travels beside the three new fields.
	 */
	screenTail?: string[];
}

/** The three classes a read-back failure can carry, plus "we could not even ask". */
export type RemoteReadbackFate = "no-child" | "no-session" | "path" | "unreachable";

export type RemoteReadbackResult = RemoteReadback | RemoteReadbackFailure;

interface HcFileReadResult {
	text?: string;
	first?: number;
	last?: number;
	lines?: number;
}

function decoded(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function integer(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : undefined;
}

/**
 * Read at most `tailLines` lines from the END of a remote text file, with an
 * explicit completeness answer.
 *
 * Two calls, both cheap: `limit: 0` for the line count (`lines` is the file's
 * total, so the text field is ignored), then one windowed read. Asking for the
 * count first is what makes "truncated" a fact we state rather than a guess we
 * make from a success code.
 */
export async function readRemoteText(opts: {
	client: HcClient;
	target: HostTarget;
	remotePath: string;
	tailLines?: number;
}): Promise<{ text: string; lines: number; returned: number; truncated: boolean; byteCapped: boolean }> {
	const tail = Math.max(1, opts.tailLines ?? REMOTE_TAIL_LINES);
	const count = await opts.client.request<HcFileReadResult>("file.read", {
		on: opts.target.host,
		path: opts.remotePath,
		limit: 0,
	});
	const lines = integer(count?.lines) ?? 0;
	if (lines === 0) return { text: "", lines: 0, returned: 0, truncated: false, byteCapped: false };

	const first = Math.max(1, lines - tail + 1);
	const wanted = lines - first + 1;
	const window = await opts.client.request<HcFileReadResult>("file.read", {
		on: opts.target.host,
		path: opts.remotePath,
		offset: first,
		limit: wanted,
	});
	const text = decoded(window?.text);
	const last = integer(window?.last);
	const returned = last === undefined ? (text.length === 0 ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0)) : Math.max(0, last - first + 1);
	// The core never says "I truncated this"; a short window is the only signal.
	const byteCapped = last !== undefined && last < lines;
	return { text, lines, returned, truncated: returned < lines || byteCapped, byteCapped };
}

/** `<runDir>/remote/<name>.jsonl` — the local mirror. Never under `sessions/`. */
export function remoteMirrorPathFor(runDir: string, name: string): string {
	const safe = name.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^\.+$/, "child") || "child";
	return path.join(runDir, "remote", `${safe}.jsonl`);
}

/**
 * Where the child's transcript lives ON ITS MACHINE.
 *
 * `remoteDir` is the mirrored-argv directory the launch created (`m6`): the argv
 * rewrite puts both the session and every built file under it. A record written
 * before `m6` has no `remoteDir`, so the same value is recomputed from the
 * resolver + the same sanitizer the launch used — the two can only agree, because
 * both are `remoteDirFor(target, runId, name)`'s answer.
 */
export function remoteSessionPathFor(target: HostTarget, record: { name: string; remoteDir?: string }): string {
	const dir = record.remoteDir && record.remoteDir.length > 0
		? record.remoteDir
		: path.posix.join(target.mirrorRoot, "no-run", record.name.replace(/[^A-Za-z0-9._-]/g, "-"));
	return path.posix.join(dir, "session.jsonl");
}

export interface RemoteSessionRequest {
	host: string;
	name: string;
	/** Local path the text must be written to (`<runDir>/remote/…`). */
	localPath: string;
	/** The record's persisted mirror dir, when it has one (m6). */
	remoteDir?: string;
	/**
	 * The address the record says the core holds (`host/name`).
	 *
	 * Falls back to `terminalName(undefined, name)` — the same convention
	 * `assertRemoteResume` uses — because a core may have shortened the name it was
	 * asked for, and asking about the shortened one is the only way to get an answer.
	 */
	remoteTerminal?: string;
	tailLines?: number;
}

/**
 * The read-back the orchestrator calls for a child that ran elsewhere.
 *
 * One client per CALL, closed in `finally` (same reasoning as remote verify: a
 * collect owns no lifecycle, so a cache would leak a socket per collect).
 */
export function createRemoteSessionReadback(opts: {
	crossMachine: CrossMachineSettings | undefined;
	clientFactory?: () => HcClient;
}): (request: RemoteSessionRequest) => Promise<RemoteReadbackResult> {
	return async (request) => {
		let target: HostTarget;
		try {
			target = resolveHostTarget(request.host, opts.crossMachine);
		} catch (error) {
			// Nothing about the child is knowable: this machine cannot even name its
			// target. D1: the missing directory is answered by the CALL, not by a
			// settings lesson, so the same two shapes the launch path prints appear here.
			const message = error instanceof Error ? error.message : String(error);
			const missingCwd = message.includes(missingRemoteCwdQuestion(request.host));
			return unreachableFailure(request.host, message, {
				evidence: ["the host target could not be resolved"],
				nextStep: missingCwd
					? `pass the directory ON ${request.host} with the call (and on the launch that started it): subagent({ host: "${request.host}", cwd: "/abs/path/on/${request.host}", task: "..." })`
					: `fix subagents.crossMachine.hosts.${request.host} (enabled, cwd, piExtensions): the launch and this read-back must resolve the same target`,
			});
		}
		const client = opts.clientFactory ? opts.clientFactory() : hcCliClient({ env: process.env });
		try {
			await client.start();
		} catch (error) {
			return unreachableFailure(request.host, `cannot reach the hc core: ${error instanceof Error ? error.message : String(error)}`, {
				evidence: ["the hc core on this machine did not start"],
				nextStep: `check that \`hc\` is on PATH (or HC_BIN) and that this machine's core is running — a child on '${request.host}' cannot be asked about from here`,
			});
		}
		try {
			const remotePath = remoteSessionPathFor(target, request);
			const read = await readRemoteText({
				client,
				target,
				remotePath,
				...(request.tailLines ? { tailLines: request.tailLines } : {}),
			});
			fs.mkdirSync(path.dirname(request.localPath), { recursive: true });
			// The text is written as-is: a marker line inside a JSONL transcript would be
			// one more unparsable line, and the truncation fact belongs to the RESULT
			// (which the render reads), not to the file the collector parses.
			fs.writeFileSync(request.localPath, read.text, { mode: 0o600 });
			return {
				ok: true,
				host: request.host,
				localPath: request.localPath,
				lines: read.lines,
				returned: read.returned,
				truncated: read.truncated,
				byteCapped: read.byteCapped,
			};
		} catch (error) {
			const detail = error instanceof HcRpcError
				? `${error.kind}: ${error.message}`
				: error instanceof Error
					? error.message
					: String(error);
			// A bare `not_found` is the bug this contract exists for: the class, the
			// evidence and the next step are what turn it into something an operator can
			// act on. The probe never invents a class it cannot support, so a probe that
			// cannot answer is `unreachable` — never "no child".
			const configuredDir = configuredMirrorDirFor(target, request);
			let fate: RemoteChildFate;
			const recordedTerminal = typeof request.remoteTerminal === "string" && request.remoteTerminal.trim().length > 0;
			try {
				fate = await probeRemoteChild({
					client,
					target,
					terminal: recordedTerminal ? (request.remoteTerminal as string).trim() : `${target.host}/${terminalName(undefined, request.name)}`,
					sessionPath: path.posix.join(configuredDir, "session.jsonl"),
					...(recordedTerminal ? {} : { terminalInferred: true }),
					...(request.remoteDir && request.remoteDir.trim().length > 0 ? { recordedDir: request.remoteDir.trim() } : {}),
				});
			} catch (probeError) {
				const probeDetail = probeError instanceof HcRpcError
					? `${probeError.kind}: ${probeError.message}`
					: probeError instanceof Error
						? probeError.message
						: String(probeError);
				return unreachableFailure(request.host, detail, {
					evidence: [`the read failed (${detail})`, `the probe could not classify it (${probeDetail})`],
					nextStep: `ask that machine directly, or check subagents.crossMachine.hosts.${request.host}: the read-back could not classify what it saw`,
				});
			}
			const classified = classifyReadbackFailure({ target, request, fate, configuredDir });
			return { ok: false, host: request.host, reason: detail, ...classified };
		} finally {
			try {
				client.close();
			} catch {
				/* closing a socket is not a verdict */
			}
		}
	};
}

/**
 * The mirror dir THIS configuration would use for the record's run segment.
 *
 * Both segments come from the record on purpose: the run label and the handle are
 * facts the launch wrote, and the one thing that can move under a record's feet is
 * the PREFIX — `subagents.crossMachine.hosts.<host>.cwd` / `worktreeRoot` decide
 * `mirrorRoot`. Rebuilding the segments from the name instead would report a
 * disagreement every time a run id differs from the production default, i.e. it
 * would turn "nothing has been written yet" into "the dirs disagree".
 */
function configuredMirrorDirFor(target: HostTarget, request: RemoteSessionRequest): string {
	const recorded = typeof request.remoteDir === "string" ? request.remoteDir.trim() : "";
	const runSegment = recorded.length > 0 ? path.posix.basename(path.posix.dirname(recorded)) : "no-run";
	const handleSegment = recorded.length > 0 ? path.posix.basename(recorded) : request.name.replace(/[^A-Za-z0-9._-]/g, "-");
	return path.posix.join(target.mirrorRoot, runSegment, handleSegment);
}

/** The evidence lines a terminal contributes (`terminal finished`, `exit 1`). */
function terminalEvidence(fate: RemoteChildFate): string[] {
	const lines = [
		fate.terminalState === "missing"
			? "terminal missing: the core does not know it"
			: `terminal ${fate.terminalState}`,
	];
	if (fate.exitCode !== undefined) lines.push(`exit ${fate.exitCode}`);
	// A terminal the core still holds, with no pid, is a program that was never
	// started — the ordinary shape of "the launch reached hc and hc never ran it".
	// Said only when the terminal is otherwise alive: a finished one legitimately
	// has no pid, and claiming death twice would blur the class.
	if (fate.pid === undefined && (fate.terminalState === "live" || fate.terminalState === "running" || fate.terminalState === "idle")) {
		lines.push("no pid: the core never started a program in that terminal");
	}
	return lines;
}

/**
 * One probe reply, as the three fields a failure carries (§5).
 *
 * `started` cannot be a failure: if the file is there while `file.read` failed,
 * the bytes came back wrong — a path/read problem, never "no child" — so that
 * case becomes `path` with the read's own reason preserved by the caller.
 */
function classifyReadbackFailure(opts: {
	target: HostTarget;
	request: RemoteSessionRequest;
	fate: RemoteChildFate;
	configuredDir: string;
}): { fate: RemoteReadbackFate; evidence: string[]; nextStep: string; screenTail?: string[] } {
	const { fate, request, configuredDir } = opts;
	const recorded = typeof request.remoteDir === "string" ? request.remoteDir.trim() : "";
	const kind: RemoteReadbackFate = fate.kind === "started" ? "path" : fate.kind;
	const mismatch = recorded.length > 0 && recorded !== configuredDir;
	const evidence: string[] = [];
	if (fate.kind === "started") evidence.push(`the transcript exists at ${fate.sessionPath} but the read failed`);
	// An inferred address explains its own `missing`: the record predates the address
	// field, so the core was asked about a name this process made up.
	if (fate.terminalState === "missing" && fate.kind === "no-session") {
		evidence.push(`the terminal name was inferred (the record has no address): '${fate.terminal}' may not be its name`);
	}
	if (mismatch || kind === "path") {
		// T4: both dirs, because "the dirs disagree" is unfalsifiable otherwise.
		evidence.push(`recorded dir: ${recorded.length > 0 ? recorded : "(none recorded)"}`);
		evidence.push(`configured dir: ${configuredDir}`);
	}
	evidence.push(...terminalEvidence(fate));
	if (kind !== "path") {
		evidence.push(
			!fate.dirExists
				? `the mirror dir does not exist (${fate.dir})`
				: fate.dirLines.length > 0
					? `dir holds: ${fate.dirLines.join(", ")}`
					: `the mirror dir is empty (${fate.dir})`,
		);
	}
	// The screen travels in its own field, not here: `renderCollect` prints it as its own
	// `screen:` line, and repeating the last line inside `evidence` made one fact look
	// like two.
	return {
		fate: kind,
		evidence: evidence.slice(0, 5),
		nextStep: remoteFateNextStep(fate.kind === "started" ? "path" : fate.kind, opts.target.host),
		...(fate.screenTail.length > 0 ? { screenTail: fate.screenTail } : {}),
	};
}

/** A failure this machine cannot classify: `fate` is `unreachable` by definition. */
function unreachableFailure(
	host: string,
	reason: string,
	parts: { evidence: string[]; nextStep: string },
): RemoteReadbackFailure {
	return { ok: false, host, reason, fate: "unreachable", evidence: parts.evidence, nextStep: parts.nextStep };
}

/**
 * Cross-machine `resume` gate: the four facts that must hold, in order, each
 * failing with a message that names its step.
 *
 * Step 1 (does the record have a host) is decided by the caller — it is the
 * branch selector, not a probe. Steps 2–4 are asked of the machine itself:
 * reachability, the terminal the child ran in, and the tree it worked in. A dead
 * terminal is a REFUSAL, not a silent relaunch: "resume" means continuing that
 * work, and relaunching would be a different child wearing the same name.
 */
export interface RemoteResumeFacts {
	host: string;
	name: string;
	/** The tree the child worked in, when it had one. */
	worktreePath?: string;
	/** Overrides the derived terminal name (tests, and a custom run id). */
	terminalName?: string;
}

export interface RemoteResumeVerdict {
	/** `live` = still running there; `finished` = over, so a relaunch is a new turn. */
	terminalState: "live" | "finished";
}

export async function assertRemoteResume(opts: {
	crossMachine: CrossMachineSettings | undefined;
	clientFactory?: () => HcClient;
	request: RemoteResumeFacts;
}): Promise<RemoteResumeVerdict> {
	const { request } = opts;
	const fail = (step: number, message: string, details: Record<string, unknown> = {}): SubagentErrorType =>
		new SubagentError(
			`cannot resume '${request.name}' on host '${request.host}' (step ${step}/4): ${message}`,
			ErrorCodes.NOT_FOUND,
			{ host: request.host, step, ...details },
		);

	// Step 1: the record itself — a remote record needs the host it ran on.
	if (typeof request.host !== "string" || request.host.trim().length === 0) {
		throw fail(1, "the record does not say which machine it ran on");
	}
	let target: HostTarget;
	try {
		target = resolveHostTarget(request.host, opts.crossMachine);
	} catch (error) {
		throw fail(1, error instanceof Error ? error.message : String(error));
	}

	const client = opts.clientFactory ? opts.clientFactory() : hcCliClient({ env: process.env });
	try {
		await client.start();
	} catch (error) {
		throw fail(2, `unreachable: ${error instanceof Error ? error.message : String(error)}`);
	}
	try {
		// Step 2: the machine answers at all.
		let reachable = false;
		try {
			const probe = await client.request<{ code?: number | null; timed_out?: boolean }>("machine.exec", {
				on: target.host,
				argv: ["true"],
				timeout: 10,
			});
			reachable = probe?.code === 0;
		} catch (error) {
			const detail = error instanceof HcRpcError ? `${error.kind}: ${error.message}` : error instanceof Error ? error.message : String(error);
			throw fail(2, `host '${request.host}' is not reachable: ${detail}`);
		}
		if (!reachable) throw fail(2, `host '${request.host}' did not answer \`true\` within 10s`);

		// Step 3: the terminal the child ran in is still there. A terminal the core
		// does not know, or one that already finished, cannot be continued.
		const address = `${target.host}/${request.terminalName ?? terminalName(undefined, request.name)}`;
		let state: string | undefined;
		try {
			const facts = await client.request<{ state?: string; exit_code?: number | null }>("terminal.get", { terminal: address });
			state = typeof facts?.state === "string" ? facts.state : undefined;
		} catch (error) {
			const gone = error instanceof HcRpcError && /not.?found|unknown terminal/i.test(`${error.kind} ${error.message}`);
			throw fail(
				3,
				gone
					? `terminal '${address}' does not exist on that machine any more (its work is over; relaunch the task instead of resuming it)`
					: `could not ask ${target.host} about terminal '${address}': ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		// The wire's word for "alive" is `live` on some replies and `running` on others
		// (the fake core mirrors `hc`'s RunResult, which says `running`). Both mean the
		// work is in flight; only `finished` means it is over.
		const alive = state === "live" || state === "running" || state === "idle";
		if (!alive && state !== "finished") {
			throw fail(3, `terminal '${address}' is '${state ?? "unknown"}' on that machine, which this resume cannot act on`);
		}

		// Step 4: the tree it worked in is still there.
		if (request.worktreePath && request.worktreePath.length > 0) {
			const probe = await client.request<{ code?: number | null }>("machine.exec", {
				on: target.host,
				argv: ["test", "-d", request.worktreePath],
				timeout: 10,
			});
			if (probe?.code !== 0) {
				throw fail(
					4,
					`worktree ${request.worktreePath} does not exist on that machine (the branch may still hold the work; fetch it from origin)`,
					{ worktreePath: request.worktreePath },
				);
			}
		}
		// Step 4 done. The state travels back: `live` means the work is still running
		// over there (nothing to revive), `finished` means the terminal is over and a
		// relaunch on THAT machine is a new turn of the same task.
		return { terminalState: state === "finished" ? "finished" : "live" };
	} finally {
		try {
			client.close();
		} catch {
			/* closing a socket is not a verdict */
		}
	}
}
