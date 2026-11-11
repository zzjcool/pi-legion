import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { openLegionDb } from "../../src/legion/db.ts";
import { readEventsAfter } from "../../src/legion/events.ts";
import { getNode, insertNode } from "../../src/legion/nodes.ts";
import { getUsage } from "../../src/legion/usage.ts";
import { consumptionFor, listArtifacts, markNotified, markRead, undelivered } from "../../src/legion/ledger.ts";
import { rebuildLegionDb, resolveArtifactOwner } from "../../src/legion/rebuild.ts";
import type { RunRecord } from "../../src/shared/types.ts";

function writeRun(directory: string, run: RunRecord): void {
	fs.mkdirSync(directory, { recursive: true });
	fs.writeFileSync(path.join(directory, "run.json"), JSON.stringify(run));
}

function runRecord(
	runId: string,
	pathEntries: RunRecord["path"] = [],
	children: RunRecord["children"] = [],
	updatedAt = 4_000,
): RunRecord {
	return {
		schemaVersion: 1,
		runId,
		task: runId,
		cwd: "/tmp",
		herdr: {},
		path: pathEntries,
		depth: pathEntries.length,
		maxDepth: 4,
		children,
		budget: { spawned: children.length, limit: null, granted: 0 },
		createdAt: new Date(500).toISOString(),
		updatedAt: new Date(updatedAt).toISOString(),
	};
}

test("rebuild reconstructs root, centurion, worker, events and usage from run.json/jsonl", () => {
	const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "legion-rebuild-"));
	const runs = path.join(sandbox, "runs");
	const rootDir = path.join(runs, "r-root");
	const childDir = path.join(runs, "r-centurion");
	const centurionSession = path.join(rootDir, "centurion.jsonl");
	const workerSession = path.join(childDir, "worker.jsonl");
	const root: RunRecord = {
		schemaVersion: 1, runId: "r-root", task: "root", cwd: sandbox, herdr: {}, path: [],
		depth: 0, maxDepth: 4,
		children: [{
			name: "centurion", sessionFile: centurionSession, ownerToken: "root-token",
			state: "working", spawnedAt: new Date(1_000).toISOString(), agent: "centurion", kind: "pi",
			worktreePath: "/tmp/team-a",
		}],
		budget: { spawned: 1, limit: null, granted: 0 },
		createdAt: new Date(500).toISOString(), updatedAt: new Date(3_000).toISOString(),
	};
	const nested: RunRecord = {
		...root, runId: "r-centurion", task: "team", path: [{ runId: "r-root", agent: "centurion" }],
		depth: 1,
		children: [{
			name: "worker", sessionFile: workerSession, ownerToken: "worker-token",
			state: "exited", execution: { status: "success", turns: 1, usage: { input: 12, output: 8, cacheRead: 2, cacheWrite: 1, cost: 0.42 } },
			spawnedAt: new Date(2_000).toISOString(), agent: "worker", kind: "pi",
		}],
		createdAt: new Date(1_500).toISOString(), updatedAt: new Date(4_000).toISOString(),
	};
	writeRun(rootDir, root);
	writeRun(childDir, nested);
	fs.writeFileSync(centurionSession, [
		JSON.stringify({ type: "message", message: { role: "user", content: "task" } }),
		JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "running" }], stopReason: "toolUse" } }),
	].join("\n"));
	fs.writeFileSync(workerSession, [
		JSON.stringify({ type: "message", message: { role: "user", content: "task" } }),
		JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop", usage: { input: 12, output: 8, cacheRead: 2, cacheWrite: 1, cost: { total: 0.42 } } } }),
		"{torn json",
	].join("\n"));
	const db = openLegionDb(":memory:");
	try {
		const result = rebuildLegionDb({ rootRunDir: rootDir, db, now: () => 5_000 });
		assert.equal(result.runFiles.length, 2);
		assert.equal(result.nodesRebuilt, 3);
		assert.equal(getNode(db, "root")?.runId, "r-root");
		assert.equal(getNode(db, "root.centurion")?.runId, "r-centurion");
		assert.equal(getNode(db, "root.centurion")?.status, "running");
		assert.equal(getNode(db, "root.centurion.worker")?.status, "settled");
		assert.equal(getNode(db, "root.centurion")?.worktreePath, "/tmp/team-a");
		assert.deepEqual(readEventsAfter(db, 0).map((event) => event.type), ["node_launched", "node_launched", "node_settled"]);
		assert.deepEqual(getUsage(db, "root.centurion.worker"), {
			nodeId: "root.centurion.worker", tokensIn: 15, tokensOut: 8, costUsd: 0.42,
			updatedAt: new Date(4_000).getTime(),
		});
		assert.equal(result.warnings.length, 0);
	} finally {
		db.close();
		fs.rmSync(sandbox, { recursive: true, force: true });
	}
});

test("rebuild scopes sibling run directories to one root and keeps old paths with an unnamed entry", () => {
	const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "legion-rebuild-tree-filter-"));
	const runs = path.join(sandbox, "runs");
	const rootDir = path.join(runs, "r-target");
	const targetRoot = runRecord("r-target", [], [{
		name: "alpha", sessionFile: "alpha.jsonl", ownerToken: "a",
		state: "working", spawnedAt: new Date(1_000).toISOString(), agent: "alpha", kind: "pi",
	}]);
	const alphaRun = runRecord("r-alpha", [{ runId: "r-target", agent: "alpha" }]);
	const legacyUnnamedPathRun = runRecord("r-legacy", [{ runId: "r-target" }], [{
		name: "legacy worker", sessionFile: "legacy.jsonl", ownerToken: "l",
		state: "working", spawnedAt: new Date(2_000).toISOString(), agent: "legacy-worker", kind: "pi",
	}]);
	const foreignRoot = runRecord("r-foreign", [], [{
		name: "stranger", sessionFile: "stranger.jsonl", ownerToken: "x",
		state: "working", spawnedAt: new Date(3_000).toISOString(), agent: "stranger", kind: "pi",
	}]);
	const foreignChild = runRecord("r-stranger", [{ runId: "r-foreign", agent: "stranger" }]);
	writeRun(rootDir, targetRoot);
	writeRun(path.join(runs, "r-alpha"), alphaRun);
	writeRun(path.join(runs, "r-legacy"), legacyUnnamedPathRun);
	writeRun(path.join(runs, "r-foreign"), foreignRoot);
	writeRun(path.join(runs, "r-stranger"), foreignChild);
	const db = openLegionDb(":memory:");
	try {
		const result = rebuildLegionDb({ rootRunDir: rootDir, db, now: () => 9_000 });
		assert.equal(result.runFiles.length, 3);
		assert.equal(result.nodesRebuilt, 3);
		assert.equal(getNode(db, "root")?.runId, "r-target");
		assert.ok(getNode(db, "root.alpha"), "same-tree node is included");
		assert.ok(getNode(db, "root.legacy-worker"), "same-tree run with missing agent metadata is retained");
		assert.equal(getNode(db, "root.stranger"), null, "foreign root children must not pollute this tree");
		assert.equal(result.runFiles.some((file) => file.includes("r-foreign") || file.includes("r-stranger")), false);
		assert.ok(result.warnings.some((warning) => warning.message.includes("outside root r-target")));
	} finally {
		db.close();
		fs.rmSync(sandbox, { recursive: true, force: true });
	}
});

test("rebuild fills a four-level branch when a middle run.json is missing", () => {
	const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "legion-rebuild-depth-"));
	const runs = path.join(sandbox, "runs");
	const rootDir = path.join(runs, "r-root");
	const root = runRecord("r-root", [], [{
		name: "alpha", sessionFile: "alpha.jsonl", ownerToken: "a",
		state: "working", spawnedAt: new Date(1_000).toISOString(), agent: "alpha", kind: "pi",
	}]);
	const levelOne = runRecord("r-alpha", [{ runId: "r-root", agent: "alpha" }]);
	const levelThree = runRecord("r-gamma", [
		{ runId: "r-root", agent: "alpha" },
		{ runId: "r-alpha", agent: "beta" },
		{ runId: "r-beta", agent: "gamma" },
	], [{
		name: "delta", sessionFile: "delta.jsonl", ownerToken: "d",
		state: "working", spawnedAt: new Date(4_000).toISOString(), agent: "delta", kind: "pi",
	}]);
	writeRun(rootDir, root);
	writeRun(path.join(runs, "r-alpha"), levelOne);
	// r-beta/run.json is intentionally absent; only its child lineage remains.
	writeRun(path.join(runs, "r-gamma"), levelThree);
	const db = openLegionDb(":memory:");
	try {
		const result = rebuildLegionDb({ rootRunDir: rootDir, db, now: () => 9_000 });
		assert.equal(getNode(db, "root.alpha")?.depth, 1);
		assert.equal(getNode(db, "root.alpha.beta")?.depth, 2);
		assert.equal(getNode(db, "root.alpha.beta.gamma")?.depth, 3);
		assert.equal(getNode(db, "root.alpha.beta.gamma.delta")?.depth, 4);
		assert.equal(getNode(db, "root.alpha.beta")?.status, "failed", "missing ancestor is reconstructed conservatively");
		assert.ok(result.warnings.some((warning) => warning.path === "root.alpha.beta"));
	} finally {
		db.close();
		fs.rmSync(sandbox, { recursive: true, force: true });
	}
});

test("rebuild tolerates malformed run.json and preserves messages by default", () => {
	const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "legion-rebuild-bad-"));
	const rootDir = path.join(sandbox, "runs", "r-root");
	fs.mkdirSync(rootDir, { recursive: true });
	fs.writeFileSync(path.join(rootDir, "run.json"), "{bad json");
	const db = openLegionDb(":memory:");
	try {
		db.prepare(
			"INSERT INTO messages (from_node, to_node, subject, body, created_at) VALUES (?, ?, ?, ?, ?)",
		).run("sender", "receiver", "persist", "keep it", 1);
		const result = rebuildLegionDb({ rootRunDir: rootDir, db, now: () => 9_000 });
		assert.equal(result.nodesRebuilt, 0);
		assert.ok(result.warnings.some((warning) => warning.message.includes("unreadable")));
		assert.equal(Number(db.prepare("SELECT COUNT(*) AS count FROM messages").get()?.count), 1);
		writeRun(rootDir, runRecord("r-root"));
		rebuildLegionDb({ rootRunDir: rootDir, db, now: () => 9_000, preserveMessages: false });
		assert.equal(Number(db.prepare("SELECT COUNT(*) AS count FROM messages").get()?.count), 0);
	} finally {
		db.close();
		fs.rmSync(sandbox, { recursive: true, force: true });
	}
});

test("rebuild skips a queued child: no phantom node, and the rest of the run still rebuilds", () => {
	// #266 D3/§4.4 (A16): a `queued` child was never started, so it has no ledger
	// row, no run directory and only a placeholder session path. Rebuilding it
	// would invent a node for a launch that may still be waiting — or that was
	// simply lost with the previous process (I-O3). `queued` is deliberately not
	// part of `NODE_STATUSES` either (it is an Orchestrator state, not a ledger
	// state), so there is no valid status to map it to.
	const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "legion-rebuild-queued-"));
	const runs = path.join(sandbox, "runs");
	const rootDir = path.join(runs, "r-root");
	const startedSession = path.join(rootDir, "started.jsonl");
	fs.mkdirSync(rootDir, { recursive: true });
	fs.writeFileSync(startedSession, [
		JSON.stringify({ type: "message", message: { role: "user", content: "task" } }),
		JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" } }),
	].join("\n"));
	writeRun(rootDir, {
		schemaVersion: 1, runId: "r-root", task: "root", cwd: sandbox, herdr: {}, path: [],
		depth: 0, maxDepth: 4,
		children: [
			{
				name: "started", sessionFile: startedSession, ownerToken: "t-started",
				state: "working", spawnedAt: new Date(1_000).toISOString(), agent: "worker", kind: "pi",
			},
			{
				name: "waiting", sessionFile: path.join(rootDir, "waiting.jsonl"), ownerToken: "t-waiting",
				state: "queued", queuePosition: 1,
				spawnedAt: new Date(2_000).toISOString(), agent: "worker", kind: "pi",
			},
		],
		budget: { spawned: 1, limit: null, granted: 0 },
		createdAt: new Date(500).toISOString(), updatedAt: new Date(3_000).toISOString(),
	});
	const db = openLegionDb(":memory:");
	try {
		const result = rebuildLegionDb({ rootRunDir: rootDir, db, now: () => 9_000 });
		// The root node id comes from the run's own identity, exactly as the sibling
		// test above asserts (`root`, `root.centurion`, …).
		assert.equal(getNode(db, "root.waiting"), null, "a queued child never becomes a tree node");
		const started = getNode(db, "root.started");
		assert.ok(started, "the sibling that really started is still rebuilt");
		assert.equal(started.status, "settled");
		// A queued child is skipped silently: it is a legitimate state, not corruption.
		assert.equal(
			result.warnings.some((warning) => warning.message.includes("waiting")),
			false,
			"skipping a queued child is not a warning",
		);
	} finally {
		db.close();
		fs.rmSync(sandbox, { recursive: true, force: true });
	}
});

test("rebuild recovers artifacts from disk and skips a pointer whose node is gone", () => {
	const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "legion-rebuild-artifacts-"));
	const runs = path.join(sandbox, "runs");
	const rootDir = path.join(runs, "r-root");
	const child = {
		name: "scout-a", sessionFile: path.join(rootDir, "scout-a.jsonl"), ownerToken: "s",
		state: "exited" as const, execution: { status: "success" as const, turns: 1 },
		spawnedAt: new Date(1_000).toISOString(), agent: "scout", kind: "pi" as const,
	};
	writeRun(rootDir, runRecord("r-root", [], [child]));
	const artifactFile = path.join(rootDir, "artifacts", "scout-a", "r1.md");
	fs.mkdirSync(path.dirname(artifactFile), { recursive: true });
	fs.writeFileSync(artifactFile, "hello artifact");
	fs.utimesSync(artifactFile, new Date(5_000), new Date(5_000));
	const db = openLegionDb(":memory:");
	try {
		const first = rebuildLegionDb({ rootRunDir: rootDir, db, now: () => 9_000 });
		assert.equal(first.artifactsRebuilt, 1);
		const rows = listArtifacts(db, "root");
		assert.equal(rows.length, 1);
		assert.deepEqual(
			{
				id: rows[0]?.id,
				nodeId: rows[0]?.nodeId,
				parentId: rows[0]?.parentId,
				name: rows[0]?.name,
				round: rows[0]?.round,
				bytes: rows[0]?.bytes,
				path: rows[0]?.path,
			},
			{
				id: "r-root/scout-a/r1",
				nodeId: "root.scout-a",
				parentId: "root",
				name: "scout-a",
				round: 1,
				bytes: 14,
				path: path.resolve(artifactFile),
			},
			"id/name/round come from the path, bytes from stat, node/parent from the rebuilt tree",
		);
		assert.ok(
			Math.abs((rows[0]?.createdAt ?? 0) - 5_000) <= 1,
			"created_at is the artifact file's mtime",
		);

		// Rebuild re-derives `nodes` from run.json, so dropping the child record is
		// what removes the node the artifact pointer resolves against.
		writeRun(rootDir, runRecord("r-root", [], []));
		const second = rebuildLegionDb({ rootRunDir: rootDir, db, now: () => 9_000 });
		assert.equal(second.artifactsRebuilt, 0, "an artifact with no node is skipped, not guessed");
		assert.equal(listArtifacts(db, "root").length, 0);
		assert.ok(
			second.warnings.some((warning) => warning.message.includes("skipped artifact r-root/scout-a/r1")),
			"the skip is reported instead of thrown",
		);
	} finally {
		db.close();
		fs.rmSync(sandbox, { recursive: true, force: true });
	}
});

test("rebuild resets consumptions: every recovered artifact is unread again (D10)", () => {
	const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "legion-rebuild-consumptions-"));
	const runs = path.join(sandbox, "runs");
	const rootDir = path.join(runs, "r-root");
	writeRun(rootDir, runRecord("r-root", [], [{
		name: "scout-a", sessionFile: path.join(rootDir, "scout-a.jsonl"), ownerToken: "s",
		state: "exited", execution: { status: "success", turns: 1 },
		spawnedAt: new Date(1_000).toISOString(), agent: "scout", kind: "pi",
	}]));
	const artifactFile = path.join(rootDir, "artifacts", "scout-a", "r1.md");
	fs.mkdirSync(path.dirname(artifactFile), { recursive: true });
	fs.writeFileSync(artifactFile, "hello artifact");
	const db = openLegionDb(":memory:");
	try {
		const first = rebuildLegionDb({ rootRunDir: rootDir, db, now: () => 9_000 });
		assert.equal(first.artifactsRebuilt, 1);
		markRead(db, { artifactId: "r-root/scout-a/r1", consumerId: "root", bytesRead: 14, at: 20 });
		markNotified(db, { artifactId: "r-root/scout-a/r1", consumerId: "root", at: 21 });
		assert.equal(undelivered(db, "root").length, 0, "settled before the rebuild");

		const second = rebuildLegionDb({ rootRunDir: rootDir, db, now: () => 9_000 });
		assert.equal(second.artifactsRebuilt, 1, "the artifact row is recovered from disk");
		assert.equal(consumptionFor(db, "r-root/scout-a/r1", "root"), null, "consumption facts are not recoverable");
		assert.deepEqual(
			undelivered(db, "root").map((row) => row.id),
			["r-root/scout-a/r1"],
			"after a rebuild an artifact can only be reported as unread (over-推, never under-推)",
		);
	} finally {
		db.close();
		fs.rmSync(sandbox, { recursive: true, force: true });
	}
});

test("artifact owner resolution never leaves its run scope (P1 review major #3)", () => {
	const db = openLegionDb(":memory:");
	try {
		insertNode(db, { parentId: null, name: "root", role: "root" });
		db.exec("UPDATE nodes SET run_id = 'r-team' WHERE id = 'root'");
		insertNode(db, { parentId: "root", name: "worker", role: "worker" });
		// Positive: inside the run's own scope the child resolves with its real parent.
		assert.deepEqual(resolveArtifactOwner(db, "r-team", "worker"), {
			kind: "ok",
			id: "root.worker",
			parentId: "root",
		});
		// No tree-wide fallback: the node exists, but not under this run. Answering
		// `ok` here is exactly how `<other-run>/artifacts/worker/r1.md` used to be
		// attached to a different run's `root.worker` — a notice for the wrong parent.
		assert.deepEqual(resolveArtifactOwner(db, "r-other", "worker"), { kind: "missing" });
		assert.deepEqual(resolveArtifactOwner(db, "r-team", "stranger"), { kind: "missing" });

		// Two nodes with that name inside ONE run scope: ambiguous, never picked.
		insertNode(db, { parentId: "root", name: "team-b", role: "centurion" });
		db.exec("UPDATE nodes SET run_id = 'r-team' WHERE id = 'root.team-b'");
		insertNode(db, { parentId: "root.worker", name: "probe", role: "worker" });
		assert.deepEqual(resolveArtifactOwner(db, "r-team", "worker"), { kind: "ok", id: "root.worker", parentId: "root" });
		insertNode(db, { parentId: "root.team-b", name: "worker", role: "worker" });
		assert.deepEqual(
			resolveArtifactOwner(db, "r-team", "worker"),
			{ kind: "ambiguous", matches: 2 },
			"two same-named children in one run scope are reported, not guessed",
		);
	} finally {
		db.close();
	}
});

test("rebuild does not attach an artifact to another run's same-named node", () => {
	const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "legion-rebuild-cross-run-"));
	const runs = path.join(sandbox, "runs");
	const rootDir = path.join(runs, "r-root");
	const teamDir = path.join(runs, "r-team");
	writeRun(rootDir, runRecord("r-root", [], [{
		name: "team", sessionFile: path.join(rootDir, "team.jsonl"), ownerToken: "t",
		state: "working", spawnedAt: new Date(1_000).toISOString(), agent: "centurion", kind: "pi",
	}]));
	writeRun(teamDir, runRecord("r-team", [{ runId: "r-root", agent: "team" }], [{
		name: "worker", sessionFile: path.join(teamDir, "worker.jsonl"), ownerToken: "w",
		state: "exited", execution: { status: "success", turns: 1 },
		spawnedAt: new Date(2_000).toISOString(), agent: "worker", kind: "pi",
	}]));
	// `root/artifacts/worker/…` has no `worker` child under `root` — only
	// `root.team.worker` exists, in another run. It must stay unresolved.
	const strayArtifact = path.join(rootDir, "artifacts", "worker", "r1.md");
	fs.mkdirSync(path.dirname(strayArtifact), { recursive: true });
	fs.writeFileSync(strayArtifact, "wrong parent if attached");
	// Positive control: the same-named artifact inside the run that owns the node.
	const ownedArtifact = path.join(teamDir, "artifacts", "worker", "r1.md");
	fs.mkdirSync(path.dirname(ownedArtifact), { recursive: true });
	fs.writeFileSync(ownedArtifact, "belongs to root.team.worker");
	const db = openLegionDb(":memory:");
	try {
		const result = rebuildLegionDb({ rootRunDir: rootDir, db, now: () => 9_000 });
		assert.equal(result.artifactsRebuilt, 1, "only the in-scope artifact is recovered");
		assert.deepEqual(
			listArtifacts(db, "root.team").map((row) => row.id),
			["r-team/worker/r1"],
			"the resolving artifact is attached to its real parent",
		);
		assert.deepEqual(listArtifacts(db, "root"), [], "the stray artifact is not attached under root");
		assert.equal(
			listArtifacts(db, "root").some((row) => row.nodeId === "root.team.worker"),
			false,
			"a cross-run name match is never used as the owner",
		);
		assert.ok(
			result.warnings.some((warning) =>
				warning.message.includes("skipped artifact r-root/worker/r1") &&
				warning.message.includes("no node named worker under run r-root"),
			),
			"the stray artifact is reported, not silently dropped",
		);
	} finally {
		db.close();
		fs.rmSync(sandbox, { recursive: true, force: true });
	}
});

test("rebuild skips a 0-byte artifact file (A1: an empty output is not an artifact)", () => {
	const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "legion-rebuild-empty-"));
	const runs = path.join(sandbox, "runs");
	const rootDir = path.join(runs, "r-root");
	writeRun(rootDir, runRecord("r-root", [], [{
		name: "scout-a", sessionFile: path.join(rootDir, "scout-a.jsonl"), ownerToken: "s",
		state: "exited", execution: { status: "success", turns: 1 },
		spawnedAt: new Date(1_000).toISOString(), agent: "scout", kind: "pi",
	}]));
	const emptyFile = path.join(rootDir, "artifacts", "scout-a", "r1.md");
	const filledFile = path.join(rootDir, "artifacts", "scout-a", "r2.md");
	fs.mkdirSync(path.dirname(emptyFile), { recursive: true });
	fs.writeFileSync(emptyFile, "");
	fs.writeFileSync(filledFile, "second round");
	const db = openLegionDb(":memory:");
	try {
		const result = rebuildLegionDb({ rootRunDir: rootDir, db, now: () => 9_000 });
		assert.equal(result.artifactsRebuilt, 1, "only the non-empty round is recorded");
		assert.deepEqual(
			listArtifacts(db, "root").map((row) => row.id),
			["r-root/scout-a/r2"],
			"the 0-byte file creates no artifact row",
		);
		assert.ok(
			result.warnings.some((warning) => warning.message.includes("empty file is not an artifact")),
			"the empty file is reported, not silently dropped",
		);
	} finally {
		db.close();
		fs.rmSync(sandbox, { recursive: true, force: true });
	}
});
