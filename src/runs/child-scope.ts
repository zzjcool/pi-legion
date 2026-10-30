/**
 * One name, one scope (#312).
 *
 * Child names are resolved in four different places — `status`, `collect`,
 * `stop`, `continue` — and before this module each one had its own idea of what
 * a name means:
 *
 *   - `status` went through {@link pickChildByName}, which walks EVERY run in
 *     the store and prefers a live record and then the newest `createdAt`, so a
 *     name could resolve to a node in another session's run;
 *   - `collect` acted on the orchestrator's own children map, i.e. only the
 *     direct children of one run.
 *
 * Same name, adjacent calls, two different nodes — and neither path ever
 * reported the disagreement. The reported incident collected a *successful*
 * demo child while the parent was trying to collect a *failed* one, and `stop`
 * masked the whole thing as `No non-retired children to stop.`
 *
 * The fix is one resolution order, shared by all four callers:
 *
 *   1. the direct children of the current run win, always, and silently — the
 *      common case must not grow a new line of noise;
 *   2. otherwise the same name may exist in other runs: exactly one candidate is
 *      a *reportable* answer (the caller decides whether that is enough to act
 *      on, or only to show);
 *   3. two or more candidates are an ambiguity, never a guess.
 *
 * `direct` and `scan` are injected so this module stays free of store/runtime
 * imports: it is the pure rule, and the two data sources are the caller's.
 */

import type { ChildRecord } from "../shared/types.ts";

/** One same-named node found outside the current run. */
export interface ChildScopeCandidate {
	runId: string;
	nodeId?: string;
	state: string;
	sessionFile?: string;
}

/**
 * What a name resolved to.
 *
 * - `direct`: this run's own child. Nothing is said about it beyond that.
 * - `elsewhere`: not a direct child; `candidates` is what the name matched
 *   elsewhere. `length === 1` is unambiguous — show or act on it, but say so.
 *   `length >= 2` is an ambiguity the caller must report instead of picking.
 * - `absent`: the name exists nowhere the caller can see.
 */
export type ChildScopeHit =
	| { kind: "direct"; name: string; child: ChildRecord }
	| { kind: "elsewhere"; name: string; candidates: ChildScopeCandidate[] }
	| { kind: "absent"; name: string; candidates: [] };

/** One node the caller may scan, with the run it lives in. */
export interface ChildScopeScanEntry extends ChildScopeCandidate {
	name: string;
}

export function resolveChildScope(input: {
	name: string;
	/**
	 * Explicit scope from the tool call. When present only that run is scanned,
	 * so a caller can address a node by `runId` even when the name repeats.
	 */
	runId?: string;
	/** This run's own child, or `undefined`. Injected: see the module header. */
	direct: (name: string) => ChildRecord | undefined;
	/** Every node the caller may consider, across runs. */
	scan: () => ChildScopeScanEntry[];
}): ChildScopeHit {
	const { name, runId } = input;

	// 1. Direct children first, and unscoped by `runId`: `direct` is already the
	//    current run by construction, and an explicit `runId` that names a
	//    different run narrows only the SEARCH below — the run this session
	//    actually owns still answers first, because that is the one it can act on.
	const direct = input.direct(name);
	if (direct) return { kind: "direct", name, child: direct };

	// 2. Same name, other runs.
	const seen = new Set<string>();
	const candidates: ChildScopeCandidate[] = [];
	for (const entry of input.scan()) {
		if (entry.name !== name) continue;
		if (runId !== undefined && entry.runId !== runId) continue;
		// A run holds one record per name, so the identity is (runId, nodeId) —
		// `nodeId` is absent on pre-M2 records, where the run alone is the key.
		const key = `${entry.runId}\u0000${entry.nodeId ?? ""}`;
		if (seen.has(key)) continue;
		seen.add(key);
		candidates.push({
			runId: entry.runId,
			...(entry.nodeId ? { nodeId: entry.nodeId } : {}),
			state: entry.state,
			...(entry.sessionFile ? { sessionFile: entry.sessionFile } : {}),
		});
	}

	if (candidates.length === 0) return { kind: "absent", name, candidates: [] };
	// Sorted so two resolutions of the same store produce the same message.
	candidates.sort((a, b) => a.runId.localeCompare(b.runId));
	return { kind: "elsewhere", name, candidates };
}

/**
 * One line per candidate, `runId` / `nodeId` / `state` in that order.
 *
 * The caller owns the surrounding sentence — what a given action may do with the
 * list differs — but the facts must look the same everywhere, so they are
 * rendered in one place.
 */
export function describeChildScopeCandidates(
	candidates: readonly ChildScopeCandidate[],
): string {
	return candidates
		.map((candidate) => {
			const parts = [`run ${candidate.runId}`];
			if (candidate.nodeId) parts.push(`node ${candidate.nodeId}`);
			parts.push(`state ${candidate.state}`);
			return `  - ${parts.join(" · ")}`;
		})
		.join("\n");
}
