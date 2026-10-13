import { test } from "node:test";
import assert from "node:assert/strict";
import { openLegionDb } from "../../src/legion/db.ts";
import {
	NodeNameConflictError,
	childNameExists,
	getChildByName,
	getChildren,
	getNode,
	getSubtree,
	heartbeatNode,
	insertNode,
	isValidNodeSlug,
	listNodesByStatus,
	listStaleNodes,
	nodeIdForChild,
	sanitizeNodeSlug,
	updateNode,
} from "../../src/legion/nodes.ts";

test("legion nodes create a tree with collision-free dot-separated ids and recursive queries", () => {
	const db = openLegionDb(":memory:");
	try {
		const root = insertNode(db, { parentId: null, name: "root", role: "root" }, () => 10);
		const teamA = insertNode(db, { parentId: root.id, name: "team A", role: "centurion" }, () => 20);
		assert.equal(teamA.name, "team-a", "stored short names use the canonical §5 slug");
		const deep = insertNode(db, { parentId: teamA.id, name: "Deep", role: "centurion" }, () => 30);
		const leaf = insertNode(db, { parentId: deep.id, name: "worker-a", role: "worker", status: "running" }, () => 40);
		assert.deepEqual([root.id, teamA.id, deep.id, leaf.id], ["root", "root.team-a", "root.team-a.deep", "root.team-a.deep.worker-a"]);
		assert.deepEqual([root.depth, teamA.depth, deep.depth, leaf.depth], [0, 1, 2, 3]);
		assert.deepEqual(getSubtree(db, root.id).map((node) => node.id), [root.id, teamA.id, deep.id, leaf.id]);
		assert.deepEqual(getSubtree(db, root.id, { maxDepth: 1, includeRoot: false }).map((node) => node.id), [teamA.id]);
		assert.equal(getNode(db, leaf.id)?.role, "worker");
		assert.equal(getChildByName(db, deep.id, "worker-a")?.id, leaf.id);
		assert.deepEqual(getChildren(db, deep.id).map((node) => node.id), [leaf.id]);
	} finally {
		db.close();
	}
});

test("node slugs use the REV-4 grammar, normalize hostile names, and cannot contain dots", () => {
	assert.equal(sanitizeNodeSlug("Hello World"), "hello-world");
	assert.equal(sanitizeNodeSlug("a.b"), "a-b");
	assert.equal(sanitizeNodeSlug("../A.B"), "a-b");
	assert.equal(sanitizeNodeSlug("9 starts"), "starts");
	assert.ok(isValidNodeSlug("agent_a-2"));
	assert.equal(isValidNodeSlug("a.b"), false);
	assert.equal(nodeIdForChild("root", "a.b"), "root.a-b");
	assert.equal(nodeIdForChild("root.a", "b"), "root.a.b");
	assert.notEqual(nodeIdForChild("root", "a.b"), nodeIdForChild("root.a", "b"));
});

test("subtree recursive query defaults to the 64-level corruption guard", () => {
	const bindings: unknown[][] = [];
	const fakeDb = {
		prepare() {
			return {
				all(...parameters: unknown[]) {
					bindings.push(parameters);
					return [];
				},
			};
		},
	};
	assert.deepEqual(getSubtree(fakeDb as never, "root"), []);
	assert.equal(bindings[0]?.[1], 64);
});

test("subtree query terminates on a corrupt cycle at its default depth cap", () => {
	const db = openLegionDb(":memory:");
	try {
		insertNode(db, { parentId: null, name: "root", role: "root" });
		const child = insertNode(db, { parentId: "root", name: "child", role: "worker" });
		db.prepare("UPDATE nodes SET parent_id = ? WHERE id = ?").run(child.id, "root");
		assert.equal(getSubtree(db, "root").length, 65);
	} finally {
		db.close();
	}
});

test("legion nodes enforce parent-local duplicate names and find helpers", () => {
	const db = openLegionDb(":memory:");
	try {
		insertNode(db, { parentId: null, name: "root", role: "root" });
		const manager = insertNode(db, { parentId: "root", name: "manager", role: "centurion" });
		insertNode(db, { parentId: manager.id, name: "worker", role: "worker" });
		assert.equal(childNameExists(db, manager.id, "worker"), true);
		assert.equal(childNameExists(db, manager.id, "Worker"), true);
		assert.equal(childNameExists(db, manager.id, "other"), false);
		assert.throws(() => insertNode(db, { parentId: manager.id, name: "worker", role: "reviewer" }), NodeNameConflictError);
		assert.throws(() => insertNode(db, { parentId: manager.id, name: "dot.name", role: "worker", id: "root.manager.dot.name" }), /node id must be/);
		assert.equal(getChildByName(db, manager.id, "worker")?.role, "worker");
		assert.throws(() => insertNode(db, { parentId: "missing", name: "ghost", role: "worker" }), /parent node not found/);
	} finally {
		db.close();
	}
});

test("legion nodes update status and heartbeat then scan status and stale timestamps", () => {
	const db = openLegionDb(":memory:");
	try {
		insertNode(db, { parentId: null, name: "root", role: "root", status: "settled" }, () => 10);
		const worker = insertNode(db, { parentId: "root", name: "worker", role: "worker", status: "starting" }, () => 20);
		assert.equal(heartbeatNode(db, worker.id, () => 35).updatedAt, 35);
		const updated = updateNode(db, worker.id, { status: "running", phase: "implementing", phaseSince: 40 }, () => 40);
		assert.equal(updated.status, "running");
		assert.deepEqual(listNodesByStatus(db, ["running", "starting"]).map((node) => node.id), [worker.id]);
		assert.deepEqual(listStaleNodes(db, 50).map((node) => node.id), [worker.id]);
		assert.deepEqual(listStaleNodes(db, 30), []);
		assert.throws(() => updateNode(db, worker.id, { reworkCount: -1 }), /reworkCount/);
	} finally {
		db.close();
	}
});
