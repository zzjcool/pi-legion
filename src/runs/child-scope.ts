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

import type { ChildRecord, RunRecord } from "../shared/types.ts";

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

/**
 * The node a resolution answered with, plus the run that holds it.
 *
 * Same shape `findChild` / `findChildAcrossStores` answer with, so a caller does
 * not care which of them resolved it.
 */
export interface ScopedRunChild {
	runId: string;
	run: RunRecord;
	child: ChildRecord;
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

// ── wiring the rule to a store's run records ───────────────────────────────
//
// These three live here, next to the rule they implement, because there must be
// exactly ONE definition of "what a name means": the lazy resolver below and the
// callers that already hold every run both go through them.

/**
 * The record `scopeRunId` actually owns for `name`, or `null`.
 *
 * This is the whole definition of "a direct child": an exact `(runId, name)`
 * pair — never "the newest record with that name".
 */
export function foundInScope(
	runs: readonly RunRecord[],
	scopeRunId: string | undefined,
	name: string,
): ScopedRunChild | null {
	if (!scopeRunId) return null;
	const run = runs.find((candidate) => candidate.runId === scopeRunId);
	const child = run?.children.find((candidate) => candidate.name === name);
	if (!run || !child) return null;
	return { runId: run.runId, run, child };
}

/** {@link resolveChildScope}, wired to one store's run records. */
export function scopeHitFor(input: {
	name: string;
	/**
	 * The run whose children count as direct: the explicit `runId` when the caller
	 * named one, else the run this session owns. Separate from `explicitRunId` on
	 * purpose — see it below.
	 */
	directRunId: string | undefined;
	/**
	 * The `runId` the CALLER passed, which is the only thing allowed to narrow the
	 * cross-run search. The inferred session run must not: with it in the filter a
	 * name that lives in another run would come back `absent` instead of
	 * `elsewhere`, and the refusal that tells the caller where it actually is
	 * would never be reachable.
	 */
	explicitRunId?: string | undefined;
	runs: readonly RunRecord[];
}): ChildScopeHit {
	return resolveChildScope({
		name: input.name,
		runId: input.explicitRunId,
		direct: (name) => foundInScope(input.runs, input.directRunId, name)?.child,
		scan: () =>
			input.runs.flatMap((run) =>
				run.children.map((child) => ({
					runId: run.runId,
					nodeId: child.nodeId,
					name: child.name,
					state: child.state,
					sessionFile: child.sessionFile,
				})),
			),
	});
}

/**
 * The one node an `elsewhere` hit points at, when it is unambiguous.
 *
 * `null` for `absent` and for an ambiguity: a caller that cannot name the node
 * must not pick one, and the ambiguity is reported before this is consulted.
 */
export function foundElsewhere(
	runs: readonly RunRecord[],
	name: string,
	hit: ChildScopeHit,
): ScopedRunChild | null {
	if (hit.kind !== "elsewhere" || hit.candidates.length !== 1) return null;
	const only = hit.candidates[0];
	if (!only) return null;
	return foundInScope(runs, only.runId, name);
}

/** What {@link resolveScopedChild} answers. */
export interface ScopedChildResolution {
	/** What the name resolved to — the same three-way answer as {@link resolveChildScope}. */
	readonly hit: ChildScopeHit;
	/** The node the hit points at; `null` for `absent` and for an `elsewhere` ambiguity. */
	readonly found: ScopedRunChild | null;
	/**
	 * Every readable run, oldest first. Scans on FIRST use and at most once, so a
	 * caller that also needs the full registry (an overview, an owner verdict)
	 * pays for it a single time — and a caller that does not never pays at all.
	 *
	 * Treat the array as read-only.
	 */
	runs(): RunRecord[];
}

/** A `readRun` that reports a malformed `runId` as "not found" instead of throwing. */
function readRunOrNull(
	readRun: (runId: string) => RunRecord | null,
	runId: string,
): RunRecord | null {
	try {
		return readRun(runId);
	} catch {
		// `RunStore.readRun` rejects run ids that cannot be a directory name
		// (`../../etc`, `a/b`). Such an id names no run, which is exactly what a
		// caller-supplied `runId` deserves: `absent`, resolved like any other miss.
		return null;
	}
}

/**
 * Resolve one name, paying for the run registry only when the answer needs it (#344).
 *
 * Every control call (`collect` / `status` / `steer` / `abort` / `retire` /
 * `continue`) used to start with `store.listRuns()` — a `readdir` plus a
 * `JSON.parse` per run — even when it already knew the run it was scoped to.
 * The scan is O(runs) and the scope is usually free, so the order is inverted
 * here: read the ONE run the scope names, and fall back to the registry only
 * when the answer genuinely depends on other runs.
 *
 * The three steps, in order:
 *
 *   1. **direct hit** — `directRunId` is known (`params.runId` / the session's
 *      legion run / the run the runtime tracks the name under) and that run
 *      holds the name. The resolver's answer is `direct` by construction, and
 *      its scan is never consulted (see `resolveChildScope`: `direct` short-
 *      circuits before the scan), so one `readRun` answers it.
 *   2. **explicit `runId`, name not in it** — the cross-run search is narrowed
 *      to that same run, so a scan could not produce a candidate: `absent`.
 *   3. **everything else** — the name may live in another run. That is the case
 *      #312 exists for (report / refuse instead of adopting), and it needs the
 *      registry. `listRuns` is called once, through the store's cached scan.
 *
 * #312's strict-scope semantics are untouched: this function only decides WHICH
 * reads happen, never what a hit means. Steps 1 and 2 are provably identical to
 * what the scan would have answered, which is what makes the shortcut safe.
 */
export function resolveScopedChild(input: {
	name: string;
	/** The `runId` the caller passed, if any (narrows the cross-run search). */
	explicitRunId?: string | undefined;
	/** The run this call is scoped to (see `scopeRunIdFor` in the caller). */
	directRunId?: string | undefined;
	/** O(1) single-run read. */
	readRun: (runId: string) => RunRecord | null;
	/** The full registry. Called at most once, and only when a scan is required. */
	listRuns: () => RunRecord[];
}): ScopedChildResolution {
	const { name, explicitRunId, directRunId } = input;
	let scanned: RunRecord[] | undefined;
	const runs = (): RunRecord[] => (scanned ??= input.listRuns());

	if (directRunId !== undefined) {
		const scopeRun = readRunOrNull(input.readRun, directRunId);
		// The record's own `runId` has to agree with the directory the caller
		// asked for: `foundInScope` matches on the FIELD, so a tampered run.json
		// whose field disagrees with its directory is not a direct hit either.
		const child =
			scopeRun && scopeRun.runId === directRunId
				? scopeRun.children.find((candidate) => candidate.name === name)
				: undefined;
		if (scopeRun && child) {
			return {
				hit: { kind: "direct", name, child },
				found: { runId: scopeRun.runId, run: scopeRun, child },
				runs,
			};
		}
		// Step 2: an explicit `runId` filters the scan to the very run just read
		// (`scopeRunIdFor` puts the explicit id first, so the two agree), and "not
		// in that run" is then `absent` without asking the registry. The equality
		// test keeps this a shortcut instead of an assumption: given a scope that
		// somehow differs from the explicit id, the scan below decides.
		if (explicitRunId !== undefined && explicitRunId === directRunId) {
			return { hit: { kind: "absent", name, candidates: [] }, found: null, runs };
		}
	}

	// Step 3: the registry. One scan, memoized for whoever else needs it.
	const all = runs();
	const hit = scopeHitFor({ name, directRunId, explicitRunId, runs: all });
	const found =
		hit.kind === "direct"
			? foundInScope(all, directRunId, name)
			: foundElsewhere(all, name, hit);
	return { hit, found, runs };
}
