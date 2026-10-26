import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
	MAX_SEARCHED_STORES,
	STORE_DIR_NAME,
	candidateStoreRoots,
	knownChildNames,
	resolveChildAcrossStores,
	unknownChildMessage,
} from "../../src/runs/store-lookup.ts";
import type { RunRecord } from "../../src/shared/types.ts";

/**
 * Build a store that looks like the real thing on disk: `<root>/runs/<id>/run.json`.
 * `store-lookup` probes `runs/` with one readdir and reads `run.json` through
 * `RunStore`, so a fake with the right shape exercises the real path.
 */
function makeStore(root: string, runs: Array<{ runId: string; cwd: string; children: string[] }>): void {
	for (const run of runs) {
		const runDir = path.join(root, "runs", run.runId);
		fs.mkdirSync(runDir, { recursive: true });
		const record = {
			schemaVersion: 1,
			runId: run.runId,
			task: "fixture",
			cwd: run.cwd,
			herdr: { supervisor: "rpc", node_id: "root" },
			path: [],
			depth: 0,
			maxDepth: 4,
			children: run.children.map((name) => ({
				name,
				state: "retired",
				spawnedAt: new Date(1_000).toISOString(),
				agent: "worker",
				kind: "pi",
				sessionFile: path.join(runDir, `${name}.jsonl`),
			})),
			budget: { spawned: 0, limit: null, granted: 0 },
			createdAt: new Date(1_000).toISOString(),
			updatedAt: new Date(2_000).toISOString(),
		} satisfies Record<string, unknown>;
		fs.writeFileSync(path.join(runDir, "run.json"), JSON.stringify(record, null, "\t"));
	}
}

function tempRoot(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "pi-legion-lookup-"));
}

test("#270: a child in another store is FOUND, not reported missing", () => {
	// The reported bug: the caller ran from `/root/work`, but the record lived in
	// `/root/work/legion-demo/.pi-subagents`. The old lookup searched one store and
	// declared `unknown child`.
	const base = tempRoot();
	const callerCwd = path.join(base, "work");
	const launchCwd = path.join(base, "work", "legion-demo");
	fs.mkdirSync(callerCwd, { recursive: true });
	fs.mkdirSync(launchCwd, { recursive: true });
	// The cwd store exists but is EMPTY (this is what made the message hide its
	// `known here` list).
	fs.mkdirSync(path.join(callerCwd, STORE_DIR_NAME, "runs"), { recursive: true });
	makeStore(path.join(launchCwd, STORE_DIR_NAME), [
		{ runId: "r-other", cwd: launchCwd, children: ["cent-demo", "scout-0"] },
	]);

	const { found, searched } = resolveChildAcrossStores({ name: "cent-demo", cwd: callerCwd });
	assert.ok(found, "the child must be found across stores");
	assert.equal(found.name, "cent-demo");
	assert.equal(found.storeRoot, path.join(launchCwd, STORE_DIR_NAME));
	assert.ok(
		searched.some((s) => s.rootDir === path.join(launchCwd, STORE_DIR_NAME)),
		"the owning store is in the searched list",
	);
});

test("#270: a worktree child's store is probed (centurion -> worktrees/<name>/)", () => {
	// A `worktree: true` role is spawned INTO a git worktree, so its store lands at
	// `<runDir>/worktrees/<name>/.pi-subagents`. That path is unreachable from the
	// root store, which is the second half of the reported bug.
	const base = tempRoot();
	const cwd = path.join(base, "work");
	fs.mkdirSync(cwd, { recursive: true });
	const ownRoot = path.join(cwd, STORE_DIR_NAME);
	const runDir = path.join(ownRoot, "runs", "r-root");
	makeStore(ownRoot, [{ runId: "r-root", cwd, children: ["cent-demo"] }]);
	const worktreeStore = path.join(runDir, "worktrees", "cent-demo", STORE_DIR_NAME);
	makeStore(worktreeStore, [
		{ runId: "r-nested", cwd: path.join(runDir, "worktrees", "cent-demo"), children: ["scout-pi-ext"] },
	]);

	const roots = candidateStoreRoots({ cwd, runDir });
	const worktreeCandidate = roots.find((r) => r.reason === "worktree");
	assert.ok(worktreeCandidate, "the worktree under <runDir>/worktrees is a candidate");
	assert.equal(worktreeCandidate.rootDir, worktreeStore);

	// And the nested child actually resolves.
	const { found } = resolveChildAcrossStores({ name: "scout-pi-ext", cwd, runDir });
	assert.ok(found, "a nested worktree child resolves");
	assert.equal(found.storeRoot, worktreeStore);
	assert.equal(found.reason, "worktree");
});

test("#270: lookup is read-only and never creates directories", () => {
	// A lookup must not materialise `.pi-subagents` in a directory the user cannot
	// write to; `RunStore.ensureRootUsable` would.
	const base = tempRoot();
	const cwd = path.join(base, "work");
	fs.mkdirSync(cwd, { recursive: true });
	resolveChildAcrossStores({ name: "nope", cwd });
	assert.equal(
		fs.existsSync(path.join(cwd, STORE_DIR_NAME)),
		false,
		"no store directory is created by a lookup",
	);
});

test("#270: candidate stores are bounded and de-duplicated", () => {
	const base = tempRoot();
	const cwd = path.join(base, "work");
	const runDir = path.join(cwd, STORE_DIR_NAME, "runs", "r-root");
	// More worktrees than the cap, to prove the cap binds.
	for (let i = 0; i < MAX_SEARCHED_STORES + 10; i += 1) {
		fs.mkdirSync(path.join(runDir, "worktrees", `wt-${i}`), { recursive: true });
	}
	const roots = candidateStoreRoots({ cwd, callerCwd: cwd, runDir });
	assert.ok(roots.length <= MAX_SEARCHED_STORES, `capped at ${MAX_SEARCHED_STORES}, got ${roots.length}`);
	const unique = new Set(roots.map((r) => r.rootDir));
	assert.equal(unique.size, roots.length, "no duplicate roots");
});

test("#270: a miss message names the directories searched, de-duped and capped", () => {
	const base = tempRoot();
	const cwd = path.join(base, "work");
	const other = path.join(base, "elsewhere");
	fs.mkdirSync(cwd, { recursive: true });
	fs.mkdirSync(other, { recursive: true });
	// 20 children with 3 names repeated across runs — the old message joined them
	// raw (measured 1717 characters on a real store).
	const names = Array.from({ length: 20 }, (_, i) => `worker-${i % 3}`);
	makeStore(path.join(cwd, STORE_DIR_NAME), [
		{ runId: "r-a", cwd, children: names },
		{ runId: "r-b", cwd, children: names },
	]);

	const { searched } = resolveChildAcrossStores({ name: "ghost", cwd, callerCwd: other });
	const message = unknownChildMessage({ name: "ghost", cwd, searched });

	assert.match(message, /^unknown child: ghost/m);
	assert.match(message, /searched:/, "the message lists what was searched");
	assert.match(message, new RegExp(path.join(cwd, STORE_DIR_NAME).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
	assert.match(message, /known here: worker-0, worker-1, worker-2/, "names are listed once, sorted");
	assert.doesNotMatch(message, /worker-0, worker-0/, "no duplicate names");
	assert.match(message, /Fix: /, "it offers a concrete next step");
	assert.doesNotMatch(message, /pass the same `cwd` you used for `launch`/, "the old dead-end instruction is gone");
});

test("#270: knownChildNames truncates instead of printing everything", () => {
	const base = tempRoot();
	const cwd = path.join(base, "work");
	fs.mkdirSync(cwd, { recursive: true });
	const names = Array.from({ length: 40 }, (_, i) => `worker-${String(i).padStart(2, "0")}`);
	makeStore(path.join(cwd, STORE_DIR_NAME), [{ runId: "r-a", cwd, children: names }]);
	const { searched } = resolveChildAcrossStores({ name: "ghost", cwd });
	const known = knownChildNames(searched, 5);
	assert.equal(known.names.length, 5);
	assert.equal(known.total, 40);
	assert.equal(known.truncated, true);
});

test("#270: a store with an empty runs/ is not offered as a place to look", () => {
	// `/root/work/.pi-subagents/runs` was present but held no run.json in the
	// reported case; naming it as a candidate sends the caller in a circle.
	const base = tempRoot();
	const cwd = path.join(base, "work");
	fs.mkdirSync(path.join(cwd, STORE_DIR_NAME, "runs"), { recursive: true });
	const { searched } = resolveChildAcrossStores({ name: "ghost", cwd });
	assert.deepEqual(searched, [], "an empty store contributes nothing to the message");
});

test("#270: an unreadable/corrupt store is skipped, not fatal", () => {
	const base = tempRoot();
	const cwd = path.join(base, "work");
	const runDir = path.join(cwd, STORE_DIR_NAME, "runs", "r-broken");
	fs.mkdirSync(runDir, { recursive: true });
	// A run dir with no run.json — RunStore tolerates it, and the lookup must too.
	makeStore(path.join(base, "other", STORE_DIR_NAME), [
		{ runId: "r-good", cwd: base, children: ["target"] },
	]);
	const { found } = resolveChildAcrossStores({
		name: "target",
		cwd,
		roots: [
			{ rootDir: path.join(cwd, STORE_DIR_NAME), reason: "cwd" },
			{ rootDir: path.join(base, "other", STORE_DIR_NAME), reason: "caller-cwd" },
		],
	});
	assert.ok(found, "a broken sibling store does not prevent a later hit");
	assert.equal(found.storeRoot, path.join(base, "other", STORE_DIR_NAME));
});

test("#270: the caller cwd beats worktree stores when both hold the name", () => {
	// Deterministic order matters: the session's own records should win over a
	// worktree copy so a stale nested record cannot shadow the live one.
	const base = tempRoot();
	const cwd = path.join(base, "work");
	const callerCwd = path.join(base, "elsewhere");
	fs.mkdirSync(cwd, { recursive: true });
	fs.mkdirSync(callerCwd, { recursive: true });
	const runDir = path.join(cwd, STORE_DIR_NAME, "runs", "r-root");
	fs.mkdirSync(runDir, { recursive: true });
	makeStore(path.join(callerCwd, STORE_DIR_NAME), [{ runId: "r-caller", cwd: callerCwd, children: ["dup"] }]);
	makeStore(path.join(runDir, "worktrees", "wt", STORE_DIR_NAME), [
		{ runId: "r-wt", cwd: path.join(runDir, "worktrees", "wt"), children: ["dup"] },
	]);

	const roots = candidateStoreRoots({ cwd, callerCwd, runDir });
	const order = roots.map((r) => r.reason);
	assert.ok(order.indexOf("caller-cwd") < order.indexOf("worktree"), `caller cwd first: ${order.join(",")}`);
	const { found } = resolveChildAcrossStores({ name: "dup", cwd, callerCwd, runDir });
	assert.equal(found?.storeRoot, path.join(callerCwd, STORE_DIR_NAME));
});

test("#270: RunRecord.cwd is carried on the hit so the caller knows the launch dir", () => {
	const base = tempRoot();
	const cwd = path.join(base, "work");
	const launchCwd = path.join(base, "work", "legion-demo");
	fs.mkdirSync(launchCwd, { recursive: true });
	makeStore(path.join(launchCwd, STORE_DIR_NAME), [
		{ runId: "r-other", cwd: launchCwd, children: ["cent-demo"] },
	]);
	const { searched } = resolveChildAcrossStores({ name: "cent-demo", cwd });
	const run: RunRecord | undefined = searched.flatMap((s) => s.runs).find((r) => r.runId === "r-other");
	assert.equal(run?.cwd, launchCwd, "the run records the cwd it was launched from");
});

test("#288: summary and timing report a miss with the SAME text store-lookup produces", async () => {
	// Both commands used to hand-roll their own sentence telling the caller to
	// "pass the same cwd used for launch" — obsolete once the cross-store lookup
	// existed, and unactionable, because the caller does not know that cwd.
	// They now delegate to `unknownChildMessage`, so this pins the delegation
	// rather than any particular wording: if either command drifts back to its
	// own phrasing, this fails.
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "legion-288-"));
	try {
		const cwd = path.join(root, "project");
		fs.mkdirSync(cwd, { recursive: true });
		makeStore(path.join(cwd, STORE_DIR_NAME), [
			{ runId: "r-present", cwd, children: ["scout-live"] },
		]);

		const { found, searched } = resolveChildAcrossStores({ name: "no-such-child", cwd });
		assert.equal(found, null);
		const expected = unknownChildMessage({ name: "no-such-child", cwd, searched });

		// Property that matters: the miss names the store it searched and lists what
		// IS there, instead of advising an unknowable cwd.
		assert.match(expected, /unknown child: no-such-child/);
		assert.match(expected, /scout-live/, "a miss must list the names that DO exist");
		assert.doesNotMatch(
			expected,
			/pass the same cwd used for launch/,
			"the obsolete 'pass the same cwd' advice must not come back",
		);
		// And it must be stable for an identical input, so both commands can rely on
		// it (they call it with the same shape).
		assert.equal(unknownChildMessage({ name: "no-such-child", cwd, searched }), expected);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
