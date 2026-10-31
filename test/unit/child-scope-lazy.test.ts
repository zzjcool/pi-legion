/**
 * #344: resolve one name without paying for the run registry.
 *
 * Every control call used to start with `store.listRuns()` — `readdir` plus a
 * `readFileSync` + `JSON.parse` per run — before it even looked at the run it was
 * scoped to. 352 runs made that 26ms per call (97% of a warm `status`), and it
 * grew with every run ever written, synchronously on the parent's event loop.
 *
 * `resolveScopedChild` inverts the order: read the ONE run the scope names and
 * only fall back to the registry when the answer depends on other runs. These
 * tests pin both halves of that claim:
 *
 *   - the scan is skipped exactly where it provably cannot change the answer
 *     (`direct hit`, and `explicit runId` that does not hold the name);
 *   - the answer is IDENTICAL to the eager scan everywhere else — #312 is a
 *     semantic contract, so the shortcut may never drop an ambiguity.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
	foundElsewhere,
	foundInScope,
	resolveScopedChild,
	scopeHitFor,
} from "../../src/runs/child-scope.ts";
import type { ChildRecord, RunRecord } from "../../src/shared/types.ts";

function child(name: string, over: Partial<ChildRecord> = {}): ChildRecord {
	return {
		sessionFile: `/runs/${name}.jsonl`,
		ownerToken: `tok-${name}`,
		state: "working",
		spawnedAt: "2026-01-01T00:00:00.000Z",
		agent: "worker",
		kind: "pi",
		name,
		...over,
	};
}

let runSeq = 0;
function run(runId: string, names: string[]): RunRecord {
	runSeq += 1;
	return {
		schemaVersion: 1,
		runId,
		task: `run ${runId}`,
		cwd: "/p",
		herdr: {},
		path: [],
		depth: 0,
		maxDepth: 3,
		budget: { spawned: names.length, limit: null, granted: 0 },
		children: names.map((name) => child(name)),
		createdAt: `2026-01-01T00:00:0${runSeq % 10}.000Z`,
		updatedAt: `2026-01-01T00:00:0${runSeq % 10}.000Z`,
	};
}

/** One store shape: the runs plus the two scope inputs a control call can carry. */
interface Shape {
	readonly label: string;
	readonly runs: RunRecord[];
	readonly name: string;
	readonly directRunId?: string | undefined;
	readonly explicitRunId?: string | undefined;
}

/** Every shape a named control call can meet (#312's whole decision table). */
const SHAPES: Shape[] = [
	{
		label: "direct hit: the scope run holds the name",
		runs: [run("r-a", ["worker-0"]), run("r-b", [])],
		name: "worker-0",
		directRunId: "r-a",
	},
	{
		label: "direct hit wins over a live same-named decoy elsewhere (#312)",
		runs: [run("r-a", ["worker-0"]), run("r-b", ["worker-0"]), run("r-c", ["worker-0"])],
		name: "worker-0",
		directRunId: "r-a",
	},
	{
		label: "unique same-named node elsewhere",
		runs: [run("r-a", ["worker-b"]), run("r-b", ["worker-0"])],
		name: "worker-0",
		directRunId: "r-a",
	},
	{
		label: "two same-named nodes elsewhere are an ambiguity",
		runs: [run("r-a", ["worker-b"]), run("r-b", ["worker-0"]), run("r-c", ["worker-0"])],
		name: "worker-0",
		directRunId: "r-a",
	},
	{
		label: "absent: nobody holds the name",
		runs: [run("r-a", ["worker-b"]), run("r-b", [])],
		name: "worker-0",
		directRunId: "r-a",
	},
	{
		label: "no scope at all, one candidate elsewhere (#209-3 reach)",
		runs: [run("r-a", ["worker-0"]), run("r-b", [])],
		name: "worker-0",
	},
	{
		label: "no scope at all, no candidate anywhere",
		runs: [run("r-a", ["worker-b"])],
		name: "worker-0",
	},
	{
		label: "explicit runId names the run that holds it",
		runs: [run("r-a", ["worker-b"]), run("r-b", ["worker-0"])],
		name: "worker-0",
		directRunId: "r-b",
		explicitRunId: "r-b",
	},
	{
		label: "explicit runId narrows the search away from a decoy elsewhere",
		runs: [run("r-a", []), run("r-b", ["worker-0"])],
		name: "worker-0",
		directRunId: "r-a",
		explicitRunId: "r-a",
	},
	{
		label: "explicit runId that does not exist",
		runs: [run("r-a", ["worker-0"])],
		name: "worker-0",
		directRunId: "r-gone",
		explicitRunId: "r-gone",
	},
];

/** The pre-#344 path, verbatim: scan everything, then resolve inside it. */
function eagerResolve(shape: Shape): { hit: ReturnType<typeof scopeHitFor>; found: unknown } {
	const hit = scopeHitFor({
		name: shape.name,
		directRunId: shape.directRunId,
		explicitRunId: shape.explicitRunId,
		runs: shape.runs,
	});
	const found =
		hit.kind === "direct"
			? foundInScope(shape.runs, shape.directRunId, shape.name)
			: foundElsewhere(shape.runs, shape.name, hit);
	return { hit, found };
}

function lazyHarness(shape: Shape) {
	const byId = new Map(shape.runs.map((record) => [record.runId, record]));
	const stats = { reads: [] as string[], scans: 0 };
	const resolution = resolveScopedChild({
		name: shape.name,
		...(shape.explicitRunId !== undefined ? { explicitRunId: shape.explicitRunId } : {}),
		...(shape.directRunId !== undefined ? { directRunId: shape.directRunId } : {}),
		readRun: (runId) => {
			stats.reads.push(runId);
			return byId.get(runId) ?? null;
		},
		listRuns: () => {
			stats.scans += 1;
			return shape.runs;
		},
	});
	return { resolution, stats };
}

test("#344: the lazy resolver answers exactly what the full scan answered (every #312 shape)", () => {
	for (const shape of SHAPES) {
		const { resolution } = lazyHarness(shape);
		const eager = eagerResolve(shape);
		assert.deepEqual(resolution.hit, eager.hit, `hit drifted for: ${shape.label}`);
		assert.deepEqual(resolution.found, eager.found, `found drifted for: ${shape.label}`);
	}
});

test("#344: a direct hit is resolved from ONE readRun — the registry is never scanned", () => {
	const shape = SHAPES[1]!; // direct hit with same-named decoys in two other runs
	const { resolution, stats } = lazyHarness(shape);
	assert.equal(resolution.hit.kind, "direct");
	assert.deepEqual(stats.reads, ["r-a"], "exactly the scope run, nothing else");
	assert.equal(stats.scans, 0, "a direct hit must not call listRuns");
	// The decoys are still unreachable, which is the point of the short-circuit.
	assert.equal(resolution.hit.kind === "direct" ? resolution.hit.child.name : undefined, "worker-0");
	assert.equal(resolution.found?.runId, "r-a");
});

test("#344: an explicit runId that does not hold the name is `absent` without a scan", () => {
	const shape = SHAPES[8]!; // explicit scope r-a (empty), decoy in r-b
	const { resolution, stats } = lazyHarness(shape);
	// The eager path narrows the cross-run search to r-a, so the decoy in r-b could
	// never have been a candidate: same answer, one registry scan cheaper.
	assert.deepEqual(resolution.hit, { kind: "absent", name: "worker-0", candidates: [] });
	assert.equal(resolution.found, null);
	assert.deepEqual(stats.reads, ["r-a"]);
	assert.equal(stats.scans, 0);
});

test("#344: a name that is not in the scope run still scans, and scans once", () => {
	const shape = SHAPES[3]!; // ambiguity across r-b + r-c
	const { resolution, stats } = lazyHarness(shape);
	assert.equal(resolution.hit.kind, "elsewhere");
	assert.equal(resolution.hit.kind === "elsewhere" ? resolution.hit.candidates.length : 0, 2);
	assert.equal(stats.scans, 1, "the registry is the fallback, and it is asked once");
	// Memoized: a caller that also wants every run pays for the same scan.
	assert.deepEqual(resolution.runs(), shape.runs);
	assert.equal(stats.scans, 1);
});

test("#344: a malformed runId is `absent`, not a throw", () => {
	const byId = new Map<string, RunRecord>();
	let scans = 0;
	const resolution = resolveScopedChild({
		name: "worker-0",
		explicitRunId: "../../etc",
		directRunId: "../../etc",
		// What RunStore.readRun does with a path-shaped id.
		readRun: (runId) => {
			if (runId.includes("/")) throw new Error(`invalid runId: ${runId}`);
			return byId.get(runId) ?? null;
		},
		listRuns: () => {
			scans += 1;
			return [];
		},
	});
	assert.deepEqual(resolution.hit, { kind: "absent", name: "worker-0", candidates: [] });
	assert.equal(scans, 0);
});
