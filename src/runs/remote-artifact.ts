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
import { resolveHostTarget, type HostTarget } from "./remote.ts";
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
}

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
			return { ok: false, host: request.host, reason: error instanceof Error ? error.message : String(error) };
		}
		const client = opts.clientFactory ? opts.clientFactory() : hcCliClient({ env: process.env });
		try {
			await client.start();
		} catch (error) {
			return {
				ok: false,
				host: request.host,
				reason: `cannot reach the hc core: ${error instanceof Error ? error.message : String(error)}`,
			};
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
			return { ok: false, host: request.host, reason: detail };
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
