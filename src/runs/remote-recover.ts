/**
 * Session recovery for a cross-machine child (schema v5, `nodes.remote_dir` +
 * `nodes.remote_terminal`).
 *
 * The case this module exists for: a parent's launch ends — the process exits, a
 * headless run finishes, the user closes the session — while the child keeps
 * working on the OTHER machine. The next session has no in-memory handle on that
 * child at all (no supervisor entry, no run-store record worth trusting, no
 * `(host, terminalName)` pair), so `collect` cannot reach it and `/legion status`
 * shows a row nobody can act on. Adopting the child into a live supervisor is
 * deliberately NOT attempted here (that is S5's problem, and a half-adoption would
 * be a second process writing one child's ledger row).
 *
 * What recovery IS, and nothing more:
 *
 *   1. locate the row by name among the cross-machine rows this ledger holds;
 *   2. ask that machine two things at once — the transcript (`file.read`, through
 *      the EXISTING read-back seam in `remote-artifact.ts`) and the terminal
 *      (`terminal.get`, through `createRemoteTerminalProbe`);
 *   3. grade the transcript with `deriveOutcome` / `deriveAcceptance`, i.e. the
 *      exact rules `collect` uses, so a recovered verdict cannot differ from a
 *      collected one;
 *   4. settle the row (`settledStatusFor` + the same `node_settled` /
 *      `node_failed` / `node_retired` event a collect writes) so it stops
 *      advertising itself as a leftover.
 *
 * Three outcomes deliberately do NOT settle, because settling is a claim:
 *
 *   - a LIVE terminal over there (the work is not over — say so, write nothing);
 *   - a transcript that could not be read (`unknown` is not a verdict, and the
 *     render names the file plus the `hc exec --cat` line that fetches it);
 *   - a machine that could not be asked about the terminal (liveness unknown).
 *
 * The ledger is the only state this module reads and writes, which is what makes
 * it work from a process that never launched the child.
 */

import type { DatabaseSync, SqliteRow } from "../legion/db.ts";
import { appendEvent } from "../legion/events.ts";
import {
	hasEnded,
	listRemoteNodesNamed,
	listUnsettledRemoteNodes,
	sanitizeNodeSlug,
	updateNode,
	type LegionNode,
	type NodeStatus,
} from "../legion/nodes.ts";
import { upsertUsage } from "../legion/usage.ts";
import { deriveOutcome, parseSessionFile, parseSessionText } from "../shared/session.ts";
import type { AcceptanceResult, CrossMachineSettings, Execution, ExecutionStatus } from "../shared/types.ts";
import { deriveAcceptance, settledStatusFor, transcriptNotRetrievedReason } from "./orchestrator.ts";
import {
	createRemoteSessionReadback,
	createRemoteTerminalProbe,
	remoteMirrorPathFor,
	type RemoteReadbackResult,
	type RemoteSessionRequest,
	type RemoteTerminalProbe,
	type RemoteTerminalProbeRequest,
} from "./remote-artifact.ts";
import { normalizeHost } from "./remote.ts";

/** The action name and the exact call a leftover is collected with. */
export const RECOVERY_ACTION = "recover";

/** `subagent({ action: "recover", name: "worker-0" })` — the one string a user copies. */
export function recoveryCallFor(name: string): string {
	return `subagent({ action: "recover", name: ${JSON.stringify(name)} })`;
}

/**
 * `CollectResult.remoteReadback`, minus the parts a recovered child cannot have.
 *
 * Deliberately the same field set `renderCollect` already understands: the recovery
 * path renders through that function, so the `read-back from host '<h>': N of M
 * lines (…)` line is produced by ONE formatter, not two.
 */
export interface RecoveryReadbackFacts {
	host: string;
	lines: number;
	returned: number;
	truncated: boolean;
	byteCapped?: boolean;
	localPath?: string;
	remotePath?: string;
	reason?: string;
	fate?: "no-child" | "no-session" | "path" | "unreachable";
	evidence?: string[];
	nextStep?: string;
	screenTail?: string[];
}

/**
 * What a recovery call produced, as facts (the rendering happens in `index.ts`,
 * where `renderCollect` lives — this module never formats a collect).
 */
export type RecoveryKind =
	/** The row was unsettled, the work is over: this call settled it. */
	| "settled-now"
	/** The row was already terminal; nothing was written, the recorded outcome is returned. */
	| "already-settled"
	/** The machine still holds a live terminal for this child: the work is NOT over. */
	| "live"
	/** The transcript could not be read: no verdict, and the row stays unsettled. */
	| "unreadable"
	/** The transcript was graded (or was empty), but nothing was settled — see `holdReason`. */
	| "unsettled";

export interface CrossMachineRecovery {
	kind: RecoveryKind;
	node: LegionNode;
	execution: Execution;
	acceptance: AcceptanceResult;
	/** The child's own text (the last turn), empty when nothing readable was fetched. */
	output: string;
	readback: RecoveryReadbackFacts;
	/** What the machine said about the terminal, when it could be asked. */
	terminal?: { address: string; state: string; unreachable?: string };
	/** The status this call wrote to the ledger (set only for `settled-now`). */
	settledStatus?: Extract<NodeStatus, "settled" | "failed" | "retired">;
	/** The one-line summary recorded in the settle event. */
	summary?: string;
	/** Why nothing was written, for the `unsettled` kind. */
	holdReason?: string;
	/** Timestamp of the settle event a SECOND recovery read back. */
	recordedAt?: number;
	/** Age of the row (last movement → now), for the caller's context. */
	ageMs: number;
}

export type RecoveryOutcome =
	| { ok: true; recovery: CrossMachineRecovery }
	| { ok: false; text: string };

export interface RecoverCrossMachineChildInput {
	db: DatabaseSync;
	/** The child's handle (the name it was launched under). */
	name: string;
	/** Cross-machine settings, so the read-back resolves the same target the launch did. */
	crossMachine: CrossMachineSettings | undefined;
	/**
	 * Directory the fetched transcript is mirrored into; `remoteMirrorPathFor` adds
	 * `<name>.jsonl`. The caller passes the LEDGER's own directory, so the mirror of
	 * a previous collect is the one this read refreshes.
	 */
	mirrorDir: string;
	/** Test seam: the read-back. Defaults to the production `hc` client. */
	readback?: (request: RemoteSessionRequest) => Promise<RemoteReadbackResult>;
	/** Test seam: the terminal probe. Defaults to the production `hc` client. */
	probeTerminal?: (request: RemoteTerminalProbeRequest) => Promise<RemoteTerminalProbe>;
	now?: () => number;
}

/**
 * Recover one cross-machine child from the ledger alone.
 *
 * Idempotent by construction: a second call finds the row terminal (`hasEnded`) and
 * answers `already-settled` with the outcome the FIRST call recorded in the ledger,
 * writing nothing. The transcript is re-read on that second call (best effort) only
 * so the child's text can travel with the answer; a machine that no longer has the
 * file costs the text, not the recorded verdict.
 */
export async function recoverCrossMachineChild(
	input: RecoverCrossMachineChildInput,
): Promise<RecoveryOutcome> {
	const now = (input.now ?? Date.now)();
	const rows = listRemoteNodesNamed(input.db, input.name);
	if (rows.length === 0) return { ok: false, text: unknownRecoveryMessage(input.db, input.name) };
	// The newest unsettled row wins; a settled one is only ever consulted for the
	// idempotent answer (`already-settled`) below.
	const unsettled = rows.filter((row) => !hasEnded(row));
	const node = unsettled.at(-1) ?? rows[rows.length - 1]!;
	const host = normalizeHost(node.host);
	if (host === undefined) {
		// Unreachable through the query above (it requires a host); kept so the type
		// survives a future caller that hands in a row directly.
		return { ok: false, text: `node ${node.id} has no host: it did not run on another machine, so there is nothing to recover there` };
	}
	const alreadySettled = hasEnded(node);

	const read = (input.readback ?? createRemoteSessionReadback({ crossMachine: input.crossMachine }))({
		host,
		name: node.name,
		localPath: remoteMirrorPathFor(input.mirrorDir, node.name),
		...(node.remoteDir ? { remoteDir: node.remoteDir } : {}),
		...(node.remoteTerminal ? { remoteTerminal: node.remoteTerminal } : {}),
	});
	const probe = (input.probeTerminal ?? createRemoteTerminalProbe({ crossMachine: input.crossMachine }))({
		host,
		name: node.name,
		...(node.remoteTerminal ? { remoteTerminal: node.remoteTerminal } : {}),
	});
	const [readback, terminal] = await Promise.all([read, probe]);
	const facts = readbackFacts(readback);
	const terminalFacts: CrossMachineRecovery["terminal"] = {
		address: terminal.address,
		state: terminal.state,
		...(terminal.unreachable !== undefined ? { unreachable: terminal.unreachable } : {}),
	};
	const parsed = readback.ok ? parseSessionFile(readback.localPath) : undefined;
	const ageMs = Math.max(0, now - node.updatedAt);

	// 1. A live terminal outranks every other fact: the child is still working over
	//    there, so there is no verdict to settle whatever the transcript's tail says.
	if (terminal.live) {
		const execution: Execution = {
			status: "running",
			reason: `terminal '${terminal.address}' is still '${terminal.state}' on host '${host}': the child is still working there, so nothing was graded`,
		};
		return {
			ok: true,
			recovery: {
				kind: "live",
				node,
				execution,
				// Deliberately NOT `deriveAcceptance` here: that ladder reads a verdict line
				// out of the text first, and the text of a child still working is a PREVIOUS
				// turn's report. Accepting unfinished work is the one claim this action must
				// never make, so liveness speaks before the verdict does.
				acceptance: { status: "unknown", level: "none", reason: execution.reason },
				output: parsed?.output ?? "",
				readback: facts,
				terminal: terminalFacts,
				ageMs,
			},
		};
	}

	// 2. A terminal row is the idempotent case: nothing to write, and the recorded
	//    outcome — not a fresh guess — is what the caller gets back.
	if (alreadySettled) {
		const recorded = recordedSettle(input.db, node.id);
		const base: Execution = parsed
			? deriveOutcome(parsed)
			: { status: "unknown", reason: transcriptNotRetrievedReason(host, readback.ok ? "no text" : readback.reason) };
		const reason = recorded?.reason ?? base.reason;
		const execution: Execution = {
			...base,
			status: recorded?.status ?? base.status,
			...(reason ? { reason } : {}),
		};
		return {
			ok: true,
			recovery: {
				kind: "already-settled",
				node,
				execution,
				acceptance: acceptanceFor(parsed, execution),
				output: outputOf(parsed, execution),
				readback: facts,
				terminal: terminalFacts,
				...(recorded?.ts !== undefined ? { recordedAt: recorded.ts } : {}),
				ageMs,
			},
		};
	}

	// 3. No transcript = no verdict. `unknown` is the honest answer and the render
	//    names the file plus the command that fetches it; the row stays unsettled so
	//    the operator can fix the path and call recover again.
	if (parsed === undefined) {
		const execution: Execution = {
			status: "unknown",
			reason: transcriptNotRetrievedReason(host, readback.ok ? "no text" : readback.reason),
		};
		return {
			ok: true,
			recovery: {
				kind: "unreadable",
				node,
				execution,
				acceptance: acceptanceFor(undefined, execution),
				output: "",
				readback: facts,
				terminal: terminalFacts,
				ageMs,
			},
		};
	}

	const execution = deriveOutcome(parsed);
	const acceptance = deriveAcceptance(parsed, execution, undefined);
	const output = outputOf(parsed, execution);

	// 4. A machine we could not ask is a machine whose terminal may still be live:
	//    grading is fine, settling would be a claim about liveness nobody made.
	if (terminal.unreachable !== undefined) {
		return {
			ok: true,
			recovery: {
				kind: "unsettled",
				node,
				execution,
				acceptance,
				output,
				readback: facts,
				terminal: terminalFacts,
				holdReason: `host '${host}' could not be asked about terminal '${terminal.address}' (${terminal.unreachable}), so nothing was settled`,
				ageMs,
			},
		};
	}

	// 5. A transcript with no messages at all is not a verdict either (`unknown`),
	//    and neither is a status that never terminates.
	if (execution.status === "unknown" || execution.status === "running") {
		return {
			ok: true,
			recovery: {
				kind: "unsettled",
				node,
				execution,
				acceptance,
				output,
				readback: facts,
				terminal: terminalFacts,
				holdReason: `the transcript holds no gradeable turn (${execution.reason ?? execution.status}), so nothing was settled`,
				ageMs,
			},
		};
	}

	// 6. The work is over and it is gradeable: settle the row exactly the way a
	//    collect does, so a later reader cannot tell recovered from collected.
	const settledStatus = settledStatusFor(execution);
	const summary = summarize(host, execution, readback, terminal);
	settleNode(input.db, node, settledStatus, execution, summary, () => now, parsed);
	return {
		ok: true,
		recovery: {
			kind: "settled-now",
			node,
			execution,
			acceptance,
			output,
			readback: facts,
			terminal: terminalFacts,
			settledStatus,
			summary,
			ageMs,
		},
	};
}

/**
 * One line, in the recovery header — the sentence that says whether the row moved.
 *
 * Kept here (not in `index.ts`) so the `/legion` block and the tool answer cannot
 * describe the same recovery differently.
 */
export function recoveryHeadline(recovery: CrossMachineRecovery): string {
	const name = recovery.node.name;
	const host = normalizeHost(recovery.node.host) ?? "(unknown host)";
	const address = recovery.terminal?.address ?? recovery.node.remoteTerminal ?? "(not recorded)";
	switch (recovery.kind) {
		case "settled-now":
			return `recover: '${name}' is over on '${host}' (terminal '${address}' is ${recovery.terminal?.state ?? "gone"}); settled node ${recovery.node.id} as ${recovery.settledStatus} — ${recovery.summary ?? "recovered from the transcript"}`;
		case "already-settled":
			return `recover: '${name}' is already settled (${recovery.node.status}) — nothing was written; this is the outcome the ledger recorded${recovery.recordedAt !== undefined ? ` at ${new Date(recovery.recordedAt).toISOString()}` : ""}.`;
		case "live":
			return `recover: terminal '${address}' is still '${recovery.terminal?.state ?? "live"}' on '${host}' — the child is still working there, so nothing was settled.`;
		case "unreadable":
			return `recover: the transcript could not be read from '${host}' — nothing was settled (an unreadable transcript is not a verdict).`;
		case "unsettled":
			return `recover: graded from the transcript, but nothing was settled — ${recovery.holdReason ?? recovery.execution.reason ?? recovery.execution.status}.`;
	}
}

/** The `read-back from host …` facts, in the shape `renderCollect` reads. */
function readbackFacts(readback: RemoteReadbackResult): RecoveryReadbackFacts {
	if (readback.ok) {
		return {
			host: readback.host,
			lines: readback.lines,
			returned: readback.returned,
			truncated: readback.truncated,
			byteCapped: readback.byteCapped,
			localPath: readback.localPath,
			remotePath: readback.remotePath,
		};
	}
	return {
		host: readback.host,
		lines: 0,
		returned: 0,
		truncated: false,
		reason: readback.reason,
		fate: readback.fate,
		...(readback.remotePath ? { remotePath: readback.remotePath } : {}),
		evidence: readback.evidence,
		nextStep: readback.nextStep,
		...(readback.screenTail && readback.screenTail.length > 0 ? { screenTail: readback.screenTail } : {}),
	};
}

/** The child's own text, or nothing when the turn produced none (same rule as `collect`). */
function outputOf(
	parsed: ReturnType<typeof parseSessionFile> | undefined,
	execution: Execution,
): string {
	if (!parsed) return "";
	return execution.status !== "running" && parsed.lastTurnOutput === null ? "" : parsed.output;
}

/**
 * `collect`'s acceptance ladder, with "no transcript at all" handled by handing it
 * an empty parse: `deriveAcceptance` then reports the execution's own reason as
 * `unknown`/`rejected`, which is exactly what the missing text can support.
 */
function acceptanceFor(
	parsed: ReturnType<typeof parseSessionFile> | undefined,
	execution: Execution,
): AcceptanceResult {
	return deriveAcceptance(parsed ?? parseSessionText(""), execution, undefined);
}

/** `recovered from host 'h': execution success, 3 turn(s), read-back 11 of 11 lines`. */
function summarize(
	host: string,
	execution: Execution,
	readback: RemoteReadbackResult,
	terminal: RemoteTerminalProbe,
): string {
	const lines = readback.ok
		? `read-back ${readback.returned} of ${readback.lines} lines${readback.truncated ? " (truncated)" : ""}`
		: "read-back failed";
	const turns = execution.turns !== undefined ? `, ${execution.turns} turn(s)` : "";
	return `recovered from host '${host}': execution ${execution.status}${turns}, ${lines}, terminal ${terminal.state}`;
}

/**
 * Write the settle exactly as `Orchestrator.recordSettled` does: the status on the
 * node, one ledger event carrying the verdict, and the token totals the turn
 * actually spent.
 *
 * The event name follows the status, not the recovery path, so every existing
 * reader (`interruptedChildren`, the mail postman, `legion_tree`) sees a recovered
 * child as an ordinary settled one. `recovered: true` is the only extra fact, and
 * it is additive: no reader keys on it.
 */
function settleNode(
	db: DatabaseSync,
	node: LegionNode,
	status: Extract<NodeStatus, "settled" | "failed" | "retired">,
	execution: Execution,
	summary: string,
	now: () => number,
	parsed: ReturnType<typeof parseSessionFile>,
): void {
	updateNode(db, node.id, { status }, now);
	appendEvent(
		db,
		node.id,
		status === "settled" ? "node_settled" : status === "failed" ? "node_failed" : "node_retired",
		{
			execution: execution.status,
			...(execution.reason ? { reason: execution.reason } : {}),
			recovered: true,
			...(node.host ? { host: node.host } : {}),
			...(node.remoteTerminal ? { remoteTerminal: node.remoteTerminal } : {}),
			summary,
		},
		{ now },
	);
	const usage = parsed.usage;
	if (usage) {
		upsertUsage(
			db,
			{
				nodeId: node.id,
				tokensIn: usage.input + usage.cacheRead + usage.cacheWrite,
				tokensOut: usage.output,
				costUsd: usage.cost,
			},
			now,
		);
	}
}

/** The last settle event written for a node, decoded (`already-settled` reads it). */
function recordedSettle(
	db: DatabaseSync,
	nodeId: string,
): { status?: ExecutionStatus; reason?: string; ts: number } | undefined {
	// Raw SQL on purpose: this is the settle fact itself, and `readEventsAfter` is a
	// cursor API (ascending from a cursor) while recovery asks for the LAST one.
	const row = db
		.prepare(
			`SELECT type, data, ts FROM events
			 WHERE node_id = ? AND type IN ('node_settled', 'node_failed', 'node_retired', 'node_abandoned')
			 ORDER BY id DESC LIMIT 1`,
		)
		.get(nodeId) as SqliteRow | undefined;
	if (row === undefined) return undefined;
	let data: unknown;
	try {
		data = row.data === null || row.data === undefined ? undefined : JSON.parse(String(row.data));
	} catch {
		data = undefined;
	}
	const fields = (data ?? {}) as { execution?: unknown; reason?: unknown };
	const status = isExecutionStatus(fields.execution) ? fields.execution : undefined;
	const reason = typeof fields.reason === "string" ? fields.reason : undefined;
	return { ...(status ? { status } : {}), ...(reason ? { reason } : {}), ts: Number(row.ts) };
}

function isExecutionStatus(value: unknown): value is ExecutionStatus {
	return value === "success" || value === "failed" || value === "aborted" || value === "truncated" || value === "running" || value === "unknown";
}

/**
 * What a `recover` on an unknown name answers: the name, and the names that WOULD
 * work — a leftover is discovered by reading, so a miss has to say where to look.
 */
function unknownRecoveryMessage(db: DatabaseSync, name: string): string {
	const recoverable = listUnsettledRemoteNodes(db).map((node) => node.name);
	const hint = recoverable.length > 0
		? `Waiting for recovery: ${recoverable.join(", ")} — call ${recoveryCallFor(recoverable[0]!)}.`
		: "Nothing is waiting for recovery: no cross-machine node in this ledger is unsettled.";
	return `unknown cross-machine child ${JSON.stringify(sanitizeNodeSlug(name))}: no row in this ledger has that name and a host. ${hint}`;
}
