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
	/** Cumulative tokens reported for the node. */
	tokens: number;
}

const RUNNING = new Set(["starting", "running", "blocked", "active", "spawning", "working", "idle", "pending", "queued"]);
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
		});
	}
	// Parents that are missing from the snapshot re-attach to the nearest known ancestor.
	const ids = new Set(out.map((node) => node.id));
	for (const node of out) {
		if (node.parentId !== null && !ids.has(node.parentId)) node.parentId = ids.has("root") && node.id !== "root" ? "root" : null;
	}
	return out;
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
