import { test } from "node:test";
import assert from "node:assert/strict";
import { openLegionDb } from "../../src/legion/db.ts";
import { insertNode } from "../../src/legion/nodes.ts";
import { attachUsageTotals, getUsage, upsertUsage, usageTotalTokens } from "../../src/legion/usage.ts";

test("usageTotalTokens sums input and output and returns zero when absent", () => {
	const db = openLegionDb(":memory:");
	try {
		insertNode(db, { parentId: null, name: "root", role: "root" });
		assert.equal(usageTotalTokens(db, "root"), 0);
		upsertUsage(db, { nodeId: "root", tokensIn: 120, tokensOut: 30, costUsd: 0.25 });
		assert.equal(usageTotalTokens(db, "root"), 150);
	} finally {
		db.close();
	}
});

test("attachUsageTotals preserves snapshots, skips root, and omits zero totals", () => {
	const db = openLegionDb(":memory:");
	try {
		const root = insertNode(db, { parentId: null, name: "root", role: "root" });
		const worker = insertNode(db, { parentId: root.id, name: "worker", role: "worker" });
		const idle = insertNode(db, { parentId: root.id, name: "idle", role: "worker" });
		upsertUsage(db, { nodeId: root.id, tokensIn: 10, tokensOut: 5 });
		upsertUsage(db, { nodeId: worker.id, tokensIn: 120, tokensOut: 30 });
		const nodes = [root, worker, idle];

		assert.deepEqual(attachUsageTotals(db, nodes), [
			root,
			{ ...worker, tokensTotal: 150 },
			idle,
		]);
		assert.deepEqual(nodes, [root, worker, idle], "the input snapshot is not mutated");
	} finally {
		db.close();
	}
});

test("usage upsert replaces the per-node cost snapshot", () => {
	const db = openLegionDb(":memory:");
	try {
		insertNode(db, { parentId: null, name: "root", role: "root" });
		assert.equal(getUsage(db, "root"), null);
		assert.deepEqual(upsertUsage(db, { nodeId: "root", tokensIn: 120, tokensOut: 30, costUsd: 0.25 }, () => 10), {
			nodeId: "root", tokensIn: 120, tokensOut: 30, costUsd: 0.25, updatedAt: 10,
		});
		assert.deepEqual(upsertUsage(db, { nodeId: "root", tokensIn: 250, tokensOut: 70, costUsd: 0.5 }, () => 20), {
			nodeId: "root", tokensIn: 250, tokensOut: 70, costUsd: 0.5, updatedAt: 20,
		});
		assert.throws(() => upsertUsage(db, { nodeId: "root", tokensIn: -1 }), /tokensIn/);
		assert.throws(() => upsertUsage(db, { nodeId: "missing" }), /FOREIGN KEY/);
	} finally {
		db.close();
	}
});
