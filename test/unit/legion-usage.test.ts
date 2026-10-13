import { test } from "node:test";
import assert from "node:assert/strict";
import { openLegionDb } from "../../src/legion/db.ts";
import { insertNode } from "../../src/legion/nodes.ts";
import { getUsage, upsertUsage, usageTotalTokens } from "../../src/legion/usage.ts";

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
