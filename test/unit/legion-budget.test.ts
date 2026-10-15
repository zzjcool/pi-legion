import { test } from "node:test";
import assert from "node:assert/strict";
import { openLegionDb } from "../../src/legion/db.ts";
import { readEventsAfter } from "../../src/legion/events.ts";
import { insertNode, updateNode } from "../../src/legion/nodes.ts";
import { DEFAULT_LEGION_BUDGETS, checkLaunchBudget, withLaunchBudget } from "../../src/legion/budget.ts";

test("legion budget applies default and override gates for depth, fanout, and active count", () => {
	const db = openLegionDb(":memory:");
	try {
		insertNode(db, { parentId: null, name: "root", role: "root" });
		assert.deepEqual(DEFAULT_LEGION_BUDGETS, { maxDepth: 4, maxChildrenPerNode: 8, maxActiveNodes: 30 });
		assert.equal(checkLaunchBudget(db, { parentId: "root", depth: 1 }).allowed, true);
		// Settled/retired children must not occupy maxChildrenPerNode (#142).
		for (let index = 0; index < 8; index += 1) {
			insertNode(db, { parentId: "root", name: `hist-${index}`, role: "worker", status: index < 3 ? "settled" : "retired" });
		}
		assert.equal(checkLaunchBudget(db, { parentId: "root", depth: 1 }).allowed, true, "terminal children do not fill the fanout budget");
		for (let index = 0; index < 8; index += 1) {
			insertNode(db, { parentId: "root", name: `live-${index}`, role: "worker", status: index === 0 ? "blocked" : "running" });
		}
		const fanout = checkLaunchBudget(db, { parentId: "root", depth: 1 });
		assert.equal(fanout.allowed, false);
		if (!fanout.allowed) assert.equal(fanout.reason, "max_children_per_node");
		updateNode(db, "root.live-0", { status: "retired" });
		assert.equal(checkLaunchBudget(db, { parentId: "root", depth: 1 }).allowed, true, "retire frees a maxChildrenPerNode slot");
		const depth = checkLaunchBudget(db, { parentId: "root", depth: 5 }, { limits: { maxChildrenPerNode: 20 } });
		assert.equal(depth.allowed, false);
		if (!depth.allowed) assert.equal(depth.reason, "max_depth");
		const active = checkLaunchBudget(db, { parentId: "root", depth: 1 }, { limits: { maxChildrenPerNode: 20, maxActiveNodes: 3 } });
		assert.equal(active.allowed, false);
		if (!active.allowed) assert.equal(active.reason, "max_active_nodes");
	} finally {
		db.close();
	}
});

test("atomic launch gate writes budget_refused and skips insertion on denial", () => {
	const db = openLegionDb(":memory:");
	try {
		insertNode(db, { parentId: null, name: "root", role: "root", status: "running" });
		let called = false;
		const result = withLaunchBudget(db, { parentId: "root", depth: 1 }, () => { called = true; }, {
			limits: { maxActiveNodes: 1 }, now: () => 50,
		});
		assert.equal(result.allowed, false);
		assert.equal(called, false);
		assert.equal(readEventsAfter(db, 0).at(-1)?.type, "budget_refused");
		assert.equal(checkLaunchBudget(db, { parentId: "absent", depth: 1 }).allowed, false);
		assert.equal(checkLaunchBudget(db, { parentId: null, depth: 1 }).allowed, true);
		const allowed = withLaunchBudget(
			db,
			{ parentId: "root", depth: 1 },
			() => insertNode(db, { parentId: "root", name: "child", role: "worker" }),
			{ now: () => 60 },
		);
		assert.equal(allowed.allowed, true);
		if (allowed.allowed) assert.equal(allowed.value.id, "root.child");
		assert.equal(updateNode(db, "root.child", { status: "running" }).status, "running");
	} finally {
		db.close();
	}
});
