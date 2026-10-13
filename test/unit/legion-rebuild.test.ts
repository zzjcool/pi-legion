import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { openLegionDb } from "../../src/legion/db.ts";
import { readEventsAfter } from "../../src/legion/events.ts";
import { getNode } from "../../src/legion/nodes.ts";
import { getUsage } from "../../src/legion/usage.ts";
import { rebuildLegionDb } from "../../src/legion/rebuild.ts";
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
