/**
 * Shared data model for the Legion visualization (railway strip + /legion view).
 *
 * Subagents spawn dynamically and nest, so nothing here assumes a fixed role
 * list. Node statuses collapse to the display states of contract
 * `docs/contracts/display-liveness-v1.md` D5: `blocked` is a transient
 * in-memory approval flag and renders as running, while `idle`/`queued` are
 * first-class display states (a child can hold a concurrency slot without
 * working) and an unrecognised label is `unknown` rather than the old
 * `retired` fallback.
 */

import type { StatusEntry } from "../status.ts";
import { SPAWN_MODES, type SpawnMode } from "../../shared/types.ts";
import { displayStatusFromState, isTerminalState, type DisplayStatus } from "../../extension/liveness.ts";

/**
 * D5's display vocabulary, imported from the single authority rather than
 * re-declared. The name `VizStatus` stays because every viz consumer imports
 * it; the values are `liveness.ts`'s `DisplayStatus` so the panel cannot drift
 * from the list/tree.
 */
export type VizStatus = DisplayStatus;

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
	/** Completed turn count (1-based latest); used to gate round clocks on the strip. */
	turns?: number;
	/** Unix ms of last visible activity for this seat (not run wall-clock start). */
	lastActivityAt?: number;
	/**
	 * Arbitrated backend the child was spawned on (#209). Optional: a row restored
	 * from disk has none, and consumers must render `unknown` — never guess `rpc`.
	 */
	spawnMode?: SpawnMode;
	/** Own OS process of an `rpc` child; `inprocess` children have none by definition. */
	pid?: number;
	/** Prompt size of the last assistant message; absolute tokens, not a ratio. */
	contextTokens?: number;
	/**
	 * Resident memory of this child in MB. Only ever set for a child with its own
	 * process (D2): an `inprocess` child has no separate RSS, so it renders `—`
	 * rather than a share of the host figure.
	 */
	rss?: number;
}

/**
 * `StatusEntry.spawnMode` is a plain string (it can come off disk or from an old
 * caller). Only a real mode reaches `VizNode`; anything else stays absent so the
 * panel prints `unknown` instead of echoing an unvalidated backend name.
 */
function asSpawnMode(value: string | undefined): SpawnMode | undefined {
	return value !== undefined && (SPAWN_MODES as readonly string[]).includes(value) ? (value as SpawnMode) : undefined;
}

/**
 * D5: raw lifecycle state → display state, delegated to `liveness.ts`.
 *
 * The three local sets that used to live here (`RUNNING`/`SETTLED`/`FAILED`)
 * plus the `return "retired"` catch-all are gone: a fourth copy of the state
 * vocabulary is exactly how the strip, the tree and the rail drifted apart. In
 * particular `idle`/`queued` no longer collapse into `retired`, and anything
 * unrecognised (including `undefined`) is `unknown` — an undecided child must
 * not be painted as finished.
 */
export function displayStatus(state: string | undefined): VizStatus {
	return displayStatusFromState(state);
}

/** Build viz nodes from status entries (root row included when present). */
export function nodesFromEntries(entries: readonly StatusEntry[]): VizNode[] {
	const out: VizNode[] = [];
	const seen = new Set<string>();
	for (const entry of entries) {
		const id = entry.nodeId ?? entry.name;
		if (seen.has(id)) continue;
		seen.add(id);
		const raw = entry.herdrStatus ?? entry.state;
		const status = id === "root" ? "running" : displayStatus(raw);
		const spawnMode = asSpawnMode(entry.spawnMode);
		// `endedAt` means "this lane's lifetime is over", and the rail/log/chart
		// read it as such: the railway drops the lane, `buildLog` emits an end
		// event, the timing pane freezes the wall clock. Only a *terminal* status
		// may claim that. `idle`/`queued` are alive (D5: slot held, not started)
		// and `unknown` is undecided — stamping an end on any of them would erase a
		// live child from the strip and fake an end event for it.
		//
		// The root row is excluded because its display status is pinned to
		// `running` above: an end stamp would contradict the status it carries.
		const ended = id !== "root" && isTerminalState(raw);
		out.push({
			id,
			name: entry.name,
			role: entry.agent || "agent",
			parentId: entry.parentId ?? (id === "root" ? null : entry.nodeId ? "root" : null),
			depth: entry.depth ?? (id === "root" ? 0 : 1),
			status,
			startedAt: entry.startedAt,
			...(ended ? { endedAt: entry.finishedAt ?? entry.startedAt } : {}),
			tokens: Math.max(0, entry.tokensTotal ?? 0),
			tokensOut: Math.max(0, entry.tokensOut ?? 0),
			generationMs: Math.max(0, entry.generationMs ?? 0),
			...(entry.currentTurnStartedAt !== undefined ? { currentTurnStartedAt: entry.currentTurnStartedAt } : {}),
			...(entry.currentTurnEndedAt !== undefined ? { currentTurnEndedAt: entry.currentTurnEndedAt } : {}),
			...(entry.turns !== undefined && entry.turns > 0 ? { turns: entry.turns } : {}),
			...(entry.lastActivityAt !== undefined ? { lastActivityAt: entry.lastActivityAt } : {}),
			...(spawnMode ? { spawnMode } : {}),
			...(entry.pid !== undefined ? { pid: entry.pid } : {}),
			...(entry.contextTokens !== undefined ? { contextTokens: entry.contextTokens } : {}),
			...(entry.rss !== undefined ? { rss: entry.rss } : {}),
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
