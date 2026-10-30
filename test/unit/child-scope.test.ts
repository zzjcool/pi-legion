/**
 * #312: one name, one scope.
 *
 * The resolver is the shared rule the four named-child actions (`status`,
 * `collect`, `stop`, `continue`) now go through. These tests pin the ordering —
 * direct children first, a unique same-named node elsewhere second, an ambiguity
 * never resolved by guessing — because that ordering is the whole fix: before it,
 * `status` walked all runs while `collect` saw only the current one, and neither
 * said which node it had picked.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
	describeChildScopeCandidates,
	resolveChildScope,
	type ChildScopeScanEntry,
} from "../../src/runs/child-scope.ts";
import type { ChildRecord } from "../../src/shared/types.ts";

function child(partial: Partial<ChildRecord> & { name: string }): ChildRecord {
	return {
		sessionFile: `/runs/${partial.name}.jsonl`,
		ownerToken: `tok-${partial.name}`,
		state: "working",
		spawnedAt: "2026-01-01T00:00:00.000Z",
		agent: "worker",
		kind: "pi",
		...partial,
	};
}

function entry(partial: Partial<ChildScopeScanEntry> & { runId: string; name: string }): ChildScopeScanEntry {
	return { state: "working", ...partial };
}

/** The three data sources a caller supplies, with recording counters. */
function scope(opts: {
	name: string;
	direct?: ChildRecord | undefined;
	scan?: ChildScopeScanEntry[];
	runId?: string;
}) {
	let directCalls = 0;
	let scanCalls = 0;
	const hit = resolveChildScope({
		name: opts.name,
		...(opts.runId !== undefined ? { runId: opts.runId } : {}),
		direct: () => {
			directCalls += 1;
			return opts.direct;
		},
		scan: () => {
			scanCalls += 1;
			return opts.scan ?? [];
		},
	});
	return { hit, directCalls, scanCalls };
}

test("#312 resolveChildScope: a direct child wins over a same-named node in another run", () => {
	const direct = child({ name: "worker-0", state: "exited" });
	const { hit, scanCalls } = scope({
		name: "worker-0",
		direct,
		// The exact shape of the incident: the other run's record is LIVE, so the
		// old `pickChildByName` preference (live first, newest second) chose it.
		scan: [entry({ runId: "r-other", name: "worker-0", state: "working" })],
	});
	assert.equal(hit.kind, "direct");
	assert.equal(hit.kind === "direct" && hit.child, direct);
	// The scan is not even consulted: the direct hit is the answer, and paying for
	// a full run walk to confirm it would make every status call scan the store.
	assert.equal(scanCalls, 0);
});

test("#312 resolveChildScope: a unique same-named node elsewhere is reported, not adopted", () => {
	const elsewhere = entry({
		runId: "r-aaa",
		nodeId: "n-7",
		name: "worker-0",
		state: "failed",
		sessionFile: "/runs/r-aaa/worker-0.jsonl",
	});
	const { hit, directCalls } = scope({ name: "worker-0", scan: [elsewhere] });
	assert.equal(directCalls, 1);
	assert.equal(hit.kind, "elsewhere");
	assert.deepEqual(hit.kind === "elsewhere" && hit.candidates, [
		{
			runId: "r-aaa",
			nodeId: "n-7",
			state: "failed",
			sessionFile: "/runs/r-aaa/worker-0.jsonl",
		},
	]);
});

test("#312 resolveChildScope: two or more candidates are an ambiguity the caller must report", () => {
	const { hit } = scope({
		name: "worker-0",
		scan: [
			entry({ runId: "r-bbb", name: "worker-0", state: "exited" }),
			entry({ runId: "r-aaa", name: "worker-0", state: "failed" }),
			entry({ runId: "r-ccc", name: "worker-1", state: "working" }),
		],
	});
	assert.equal(hit.kind, "elsewhere");
	const candidates = hit.kind === "elsewhere" ? hit.candidates : [];
	assert.equal(candidates.length, 2);
	// Sorted by runId so the same store always renders the same message.
	assert.deepEqual(
		candidates.map((candidate) => [candidate.runId, candidate.state]),
		[
			["r-aaa", "failed"],
			["r-bbb", "exited"],
		],
	);
});

test("#312 resolveChildScope: an explicit runId narrows the scan to that run", () => {
	const scan = [
		entry({ runId: "r-aaa", name: "worker-0", state: "failed" }),
		entry({ runId: "r-bbb", name: "worker-0", state: "exited" }),
	];
	const narrowed = scope({ name: "worker-0", scan, runId: "r-bbb" });
	assert.equal(narrowed.hit.kind, "elsewhere");
	assert.deepEqual(
		narrowed.hit.kind === "elsewhere" ? narrowed.hit.candidates.map((c) => c.runId) : [],
		["r-bbb"],
	);

	// A runId with no match for the name is a miss, not a cross-run match.
	const missed = scope({ name: "worker-0", scan, runId: "r-zzz" });
	assert.equal(missed.hit.kind, "absent");
});

test("#312 resolveChildScope: absent when the name exists nowhere", () => {
	const { hit } = scope({ name: "ghost", scan: [entry({ runId: "r-aaa", name: "worker-0" })] });
	assert.equal(hit.kind, "absent");
	assert.deepEqual(hit.kind === "absent" && hit.candidates, []);
});

test("#312 resolveChildScope: a direct hit is not duplicated into the candidate list", () => {
	// Same record reachable from both sources: the direct branch answers, and the
	// caller never sees a candidate list that could be mistaken for ambiguity.
	const direct = child({ name: "worker-0" });
	const { hit } = scope({
		name: "worker-0",
		direct,
		scan: [
			entry({ runId: "r-own", name: "worker-0" }),
			entry({ runId: "r-other", name: "worker-0" }),
		],
	});
	assert.equal(hit.kind, "direct");
});

test("#312 describeChildScopeCandidates names runId, nodeId and state", () => {
	const text = describeChildScopeCandidates([
		{ runId: "r-aaa", nodeId: "n-7", state: "failed", sessionFile: "/s.jsonl" },
		{ runId: "r-bbb", state: "retired" },
	]);
	assert.equal(
		text,
		["  - run r-aaa · node n-7 · state failed", "  - run r-bbb · state retired"].join("\n"),
	);
});
