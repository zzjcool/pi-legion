/**
 * Shared data model for the Legion visualization (railway strip + /legion view).
 *
 * Subagents spawn dynamically and nest, so nothing here assumes a fixed role
 * list. Node statuses collapse to four display states: `blocked` is a
 * transient in-memory approval flag and renders as running.
 */

import type { StatusEntry } from "../status.ts";

export type VizStatus = "running" | "settled" | "failed" | "retired";

export interface VizNode {
	id: string;
	name: string;
	role: string;
	parentId: string | null;
	depth: number;
	status: VizStatus;
	startedAt: number;
	/** Set once the node reaches a terminal display state. */
	endedAt?: number;
	/** Cumulative tokens reported for the node (input+cache+output; display totals). */
	tokens: number;
	/** Cumulative output tokens only; sampled for tok/s. */
	tokensOut: number;
	/**
	 * Cumulative model-generation wall ms (assistant − prior user/toolResult).
	 * Denominator for tok/s when > 0.
	 */
	generationMs: number;
	/** Unix ms start of the current turn, when the status entry recorded one. */
	currentTurnStartedAt?: number;
	/** Unix ms the current turn settled. Absent while it is still in flight. */
	currentTurnEndedAt?: number;
}

/** Same set the footer/busy label treat as active, so live counts agree everywhere. */
const RUNNING = new Set(["starting", "working", "running", "blocked"]);
const SETTLED = new Set(["settled", "success", "completed", "done"]);
const FAILED = new Set(["failed", "aborted", "error", "truncated"]);

export function displayStatus(state: string | undefined): VizStatus {
	const value = (state ?? "").toLowerCase();
	if (SETTLED.has(value)) return "settled";
	if (FAILED.has(value)) return "failed";
	if (RUNNING.has(value)) return "running";
	return "retired";
}

/** Build viz nodes from status entries (root row included when present). */
export function nodesFromEntries(entries: readonly StatusEntry[]): VizNode[] {
	const out: VizNode[] = [];
	const seen = new Set<string>();
	for (const entry of entries) {
		const id = entry.nodeId ?? entry.name;
		if (seen.has(id)) continue;
		seen.add(id);
		const status = id === "root" ? "running" : displayStatus(entry.herdrStatus ?? entry.state);
		out.push({
			id,
			name: entry.name,
			role: entry.agent || "agent",
			parentId: entry.parentId ?? (id === "root" ? null : entry.nodeId ? "root" : null),
			depth: entry.depth ?? (id === "root" ? 0 : 1),
			status,
			startedAt: entry.startedAt,
			...(status !== "running" ? { endedAt: entry.finishedAt ?? entry.startedAt } : {}),
			tokens: Math.max(0, entry.tokensTotal ?? 0),
			tokensOut: Math.max(0, entry.tokensOut ?? 0),
			generationMs: Math.max(0, entry.generationMs ?? 0),
			...(entry.currentTurnStartedAt !== undefined ? { currentTurnStartedAt: entry.currentTurnStartedAt } : {}),
			...(entry.currentTurnEndedAt !== undefined ? { currentTurnEndedAt: entry.currentTurnEndedAt } : {}),
		});
	}
	// Parents that are missing from the snapshot re-attach to the nearest known ancestor.
	const ids = new Set(out.map((node) => node.id));
	for (const node of out) {
		if (node.parentId !== null && !ids.has(node.parentId)) node.parentId = ids.has("root") && node.id !== "root" ? "root" : null;
	}
	disambiguateNames(out);
	return out;
}

/**
 * Child supervisors number their own children, so a nested "scout-0" can share
 * a name with a root-level "scout-0". Prefix duplicates with their parent name
 * (the shallowest keeps the bare name) so strip/log/galaxy labels stay unique.
 */
export function disambiguateNames(nodes: VizNode[]): void {
	const byName = new Map<string, VizNode[]>();
	for (const node of nodes) byName.set(node.name, [...(byName.get(node.name) ?? []), node]);
	const byId = new Map(nodes.map((node) => [node.id, node]));
	for (const group of byName.values()) {
		if (group.length < 2) continue;
		const sorted = [...group].sort((a, b) => a.depth - b.depth || a.startedAt - b.startedAt);
		for (const node of sorted.slice(1)) {
			const parent = node.parentId ? byId.get(node.parentId) : undefined;
			if (parent && parent.id !== "root") node.name = `${parent.name}/${node.name}`;
		}
	}
}

export function isAgent(node: VizNode): boolean {
	return node.id !== "root" && node.parentId !== null;
}

export function formatCount(value: number): string {
	if (!Number.isFinite(value) || value <= 0) return "0";
	if (value < 1000) return String(Math.round(value));
	if (value < 1_000_000) return `${(value / 1000).toFixed(1).replace(/\.0$/, "")}k`;
	return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

export function formatDuration(ms: number): string {
	const total = Math.max(0, Math.floor(ms / 1000));
	const h = Math.floor(total / 3600);
	const m = Math.floor((total % 3600) / 60);
	const s = total % 60;
	if (h > 0) return `${h}h${String(m).padStart(2, "0")}m`;
	if (m > 0) return `${m}m${String(s).padStart(2, "0")}s`;
	return `${s}s`;
}
