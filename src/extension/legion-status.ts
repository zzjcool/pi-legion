/**
 * `/legion status [name]` — chat text for humans.
 *
 * No name: the whole tree, same lines as `formatTree` (the legion_tree summary).
 * A name: `renderLiveChildStatus`, the same text as `subagent({ action: "status" })`
 * when a run-store child record is available.
 */

import { NODE_STATUSES, type LegionNode } from "../legion/nodes.ts";
import { recoveryCallFor } from "../runs/remote-recover.ts";
import type { InFlightToolStack } from "../supervisor/types.ts";
import { formatInFlightToolLine } from "../supervisor/types.ts";
import { formatTree } from "./legion-tools.ts";
import {
	renderLiveChildStatus,
	type LiveChildStatusInput,
} from "./runtime.ts";
import { formatDuration } from "./summary.ts";

/** Child snapshot the status tool already prints. `now` is supplied by the caller. */
export type LegionChildStatusFacts = Omit<LiveChildStatusInput, "now"> & {
	/**
	 * The tool calls in flight right now (#315, #331), innermost last. Read from
	 * the supervisor, never persisted: it describes this process's live child, so
	 * a rebuilt record (another session's child) has none and none is invented.
	 */
	inFlightTools?: InFlightToolStack;
};

/**
 * 6.2.4 / D2/D3: a recoverable row, annotated with the exit's three-way fate.
 *
 * The fate lives in the ledger as `orphan_detected{reason:"session-shutdown"}`
 * and is read by the caller (which has the database handle); the renderer only
 * needs the word. `LegionNode` plus one optional field keeps every existing
 * caller valid — a row without a marker renders exactly as before.
 */
export type RecoverableNode = LegionNode & { orphaned?: "orphaned" | "unfetched" };

/**
 * Put the live-activity line at the TOP of one rendered child block (#315).
 *
 * The fact is the whole stack (#331) so the line can name nesting and parallel
 * siblings; an absent or empty stack renders the block unchanged.
 *
 * A lead line, not a footnote: `working · bash 00:07:31` is the answer to "what
 * is it doing, and for how long", and the block below it already leads its own
 * liveness story with `alive · quiet Ns`. Prepending needs no knowledge of the
 * block's internal line order, so this keeps working if
 * `renderLiveChildStatus` grows or reorders lines.
 *
 * `undefined` (or an empty stack) renders the block unchanged: no fact, no
 * line. This is display only — it never decides liveness and never stops
 * anything.
 */
export function withInFlightToolLine(
	block: string,
	stack: InFlightToolStack | undefined,
	now: number,
): string {
	if (stack === undefined || stack.length === 0) return block;
	return `${formatInFlightToolLine(stack, now)}\n${block}`;
}

export interface LegionStatusJob {
	name: string;
	nodeId?: string;
	state: string;
}

export interface LegionStatusInput {
	/** Empty shows the tree. Otherwise a node id, short id, or child name. */
	query?: string;
	nodes: readonly LegionNode[];
	jobs?: readonly LegionStatusJob[];
	/**
	 * Cross-machine rows a PREVIOUS process left unsettled (schema v5): the ones
	 * `subagent({ action: "recover" })` can collect. Read from the ledger by the
	 * caller (`listUnsettledRemoteNodes`), never from this process's memory — the
	 * whole point is that this session has no handle on them.
	 */
	recoverable?: readonly RecoverableNode[];
	/**
	 * Persisted child behind the subagent status action.
	 * Undefined when this process has no run-store record for the name.
	 */
	lookupChild?: (name: string) => LegionChildStatusFacts | undefined;
	now?: number;
}

export interface LegionStatusReport {
	ok: boolean;
	text: string;
}

const LIVE_NODE_STATUSES = new Set(["starting", "running", "blocked"]);

function nodesMatching(nodes: readonly LegionNode[], query: string): LegionNode[] {
	const byId = nodes.filter((node) => node.id === query);
	if (byId.length > 0) return byId;
	return nodes.filter((node) =>
		node.name === query || node.id.slice(node.id.lastIndexOf(".") + 1) === query,
	);
}

function statusCounts(nodes: readonly LegionNode[]): string {
	const counts = new Map<string, number>();
	for (const node of nodes) counts.set(node.status, (counts.get(node.status) ?? 0) + 1);
	const known = new Set<string>(NODE_STATUSES);
	const ordered = [
		...NODE_STATUSES.filter((status) => counts.has(status)),
		...[...counts.keys()].filter((status) => !known.has(status)),
	];
	return ordered.map((status) => `${status}=${counts.get(status)}`).join(", ");
}

function withNow(facts: LegionChildStatusFacts, now: number | undefined): LiveChildStatusInput {
	return now === undefined ? facts : { ...facts, now };
}

function liveJobForNode(node: LegionNode, jobs: readonly LegionStatusJob[]): LegionStatusJob | undefined {
	return jobs.find((job) =>
		job.state !== "retired" && (job.nodeId === node.id || (job.nodeId === undefined && job.name === node.name)),
	);
}

function renderFacts(facts: LegionChildStatusFacts, now: number | undefined): string {
	// The in-flight stack is display-only and lives outside
	// `renderLiveChildStatus`, so it is split off before the snapshot is rendered
	// and prepended afterwards.
	const { inFlightTools, ...snapshot } = facts;
	return withInFlightToolLine(
		renderLiveChildStatus(withNow(snapshot, now)),
		inFlightTools,
		now ?? Date.now(),
	);
}

function renderNode(
	node: LegionNode,
	jobs: readonly LegionStatusJob[],
	lookupChild: LegionStatusInput["lookupChild"],
	now: number | undefined,
): string {
	const facts = lookupChild?.(node.name);
	if (facts) return renderFacts(facts, now);
	const job = liveJobForNode(node, jobs);
	const alive = job
		? job.state === "working" || job.state === "blocked"
		: LIVE_NODE_STATUSES.has(node.status);
	return renderLiveChildStatus(withNow({
		name: node.name,
		state: node.status,
		agent: node.role,
		kind: node.kind,
		sessionFile: node.sessionFile ?? "",
		alive,
	}, now));
}

function renderJob(
	job: LegionStatusJob,
	lookupChild: LegionStatusInput["lookupChild"],
	now: number | undefined,
): string {
	const facts = lookupChild?.(job.name);
	if (facts) return renderFacts(facts, now);
	return renderLiveChildStatus(withNow({
		name: job.name,
		state: job.state,
		sessionFile: "",
		alive: job.state === "working" || job.state === "blocked",
	}, now));
}

function jobsOutsideTree(nodes: readonly LegionNode[], jobs: readonly LegionStatusJob[]): LegionStatusJob[] {
	const ids = new Set(nodes.map((node) => node.id));
	const names = new Set(nodes.map((node) => node.name));
	return jobs.filter((job) =>
		job.state !== "retired" &&
		(job.nodeId === undefined || !ids.has(job.nodeId)) &&
		!names.has(job.name),
	);
}

function renderTree(
	nodes: readonly LegionNode[],
	jobs: readonly LegionStatusJob[],
	recoverable: readonly LegionNode[],
	now: number,
): string {
	const noun = nodes.length === 1 ? "node" : "nodes";
	const counts = nodes.length > 0 ? ` · ${statusCounts(nodes)}` : "";
	const lines = [`Legion status · ${nodes.length} ${noun}${counts}`];
	lines.push("");
	lines.push(nodes.length > 0 ? formatTree(nodes) : "No legion nodes.");
	const extras = jobsOutsideTree(nodes, jobs);
	if (extras.length > 0) {
		lines.push("", "Live jobs not in the tree:");
		for (const job of extras) lines.push(`- ${job.name} state=${job.state}`);
	}
	const recovery = renderRecoverableSection(recoverable, jobs, now);
	if (recovery !== undefined) lines.push("", recovery);
	lines.push("", "One node: /legion status <name>");
	return lines.join("\n");
}

/**
 * The `Recoverable cross-machine children` block, or `undefined` when there is none.
 *
 * A child of THIS process is skipped: a live job is already rendered (its own
 * `alive` block, or the tree), and repeating it here would read as two children —
 * the exact confusion `jobsOutsideTree` above avoids. What is left is precisely the
 * set the user asked about: work a PREVIOUS session started on another machine and
 * this one cannot reach any other way.
 *
 * Every line carries the two facts the user needs to act: what it is (name, role,
 * host, status, terminal address, age) and the call that collects it. The call is
 * `recoveryCallFor`, the same string the recovery header uses, so a typo cannot
 * send the reader to an action that does not exist.
 */
export function renderRecoverableSection(
	recoverable: readonly RecoverableNode[],
	jobs: readonly LegionStatusJob[],
	now: number,
): string | undefined {
	const seen = new Set<string>();
	const rows = recoverable.filter((node) => {
		if (!node.host) return false;
		if (liveJobForNode(node, jobs)) return false;
		if (seen.has(node.id)) return false;
		seen.add(node.id);
		return true;
	});
	if (rows.length === 0) return undefined;
	const lines = ["Recoverable cross-machine children (this session never launched them):"];
	for (const node of rows) {
		const age = Number.isFinite(node.updatedAt) ? `${formatDuration(Math.max(0, now - node.updatedAt))} old` : "age unknown";
		const terminal = node.remoteTerminal ?? "(terminal not recorded)";
		// 6.2.4 / D2: the exit's fate is the actionable part — `orphaned` means the
		// work may still be running over there, `unfetched` means it is over and only
		// the read-back is missing. Rows from before 6.2.4 carry no marker and print
		// their status alone, byte for byte as they did.
		const state = node.orphaned === "orphaned"
			? "orphaned"
			: node.orphaned === "unfetched" ? `${node.status} (unfetched)` : node.status;
		lines.push(
			`- ${node.name} · ${node.role} · host ${node.host} · ${state} · terminal ${terminal} · ${age}`,
		);
		lines.push(`  collect: ${recoveryCallFor(node.name)}`);
	}
	return lines.join("\n");
}

/** Human-readable `/legion status` text. `ok: false` is an unknown or ambiguous name. */
export function renderLegionStatus(input: LegionStatusInput): LegionStatusReport {
	const query = input.query?.trim() ?? "";
	const jobs = input.jobs ?? [];
	if (!query) return { ok: true, text: renderTree(input.nodes, jobs, input.recoverable ?? [], input.now ?? Date.now()) };

	const matches = nodesMatching(input.nodes, query);
	if (matches.length > 1) {
		return {
			ok: false,
			text: `"${query}" is ambiguous; use a full node id with /legion status <node-id>.`,
		};
	}
	if (matches.length === 1) {
		return { ok: true, text: renderNode(matches[0]!, jobs, input.lookupChild, input.now) };
	}

	const namedJobs = jobs.filter((job) => job.name === query || job.nodeId === query);
	if (namedJobs.length > 1) {
		return {
			ok: false,
			text: `"${query}" is ambiguous; use a full node id with /legion status <node-id>.`,
		};
	}
	if (namedJobs.length === 1) {
		return { ok: true, text: renderJob(namedJobs[0]!, input.lookupChild, input.now) };
	}

	const facts = input.lookupChild?.(query);
	if (facts) return { ok: true, text: renderFacts(facts, input.now) };

	return { ok: false, text: `Unknown Legion node "${query}".` };
}
