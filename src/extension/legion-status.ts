/**
 * `/legion status [name]` — chat text for humans.
 *
 * No name: the whole tree, same lines as `formatTree` (the legion_tree summary).
 * A name: `renderLiveChildStatus`, the same text as `subagent({ action: "status" })`
 * when a run-store child record is available.
 */

import { NODE_STATUSES, type LegionNode } from "../legion/nodes.ts";
import type { InFlightToolStack } from "../supervisor/types.ts";
import { formatInFlightToolLine } from "../supervisor/types.ts";
import { formatTree } from "./legion-tools.ts";
import {
	renderLiveChildStatus,
	type LiveChildStatusInput,
} from "./runtime.ts";

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

function renderTree(nodes: readonly LegionNode[], jobs: readonly LegionStatusJob[]): string {
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
	lines.push("", "One node: /legion status <name>");
	return lines.join("\n");
}

/** Human-readable `/legion status` text. `ok: false` is an unknown or ambiguous name. */
export function renderLegionStatus(input: LegionStatusInput): LegionStatusReport {
	const query = input.query?.trim() ?? "";
	const jobs = input.jobs ?? [];
	if (!query) return { ok: true, text: renderTree(input.nodes, jobs) };

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
