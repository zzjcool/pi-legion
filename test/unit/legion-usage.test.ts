import { test } from "node:test";
import assert from "node:assert/strict";
import { openLegionDb } from "../../src/legion/db.ts";
import { insertNode } from "../../src/legion/nodes.ts";
import {
	USAGE_IN_CHUNK,
	attachUsageTotals,
	getUsage,
	upsertUsage,
	usageTotalTokens,
} from "../../src/legion/usage.ts";

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
			{ ...worker, tokensTotal: 150, tokensOut: 30 },
			idle,
		]);
		assert.deepEqual(nodes, [root, worker, idle], "the input snapshot is not mutated");
	} finally {
		db.close();
	}
});

test("attachUsageTotals is byte-identical across duplicate ids and empty input", () => {
	const db = openLegionDb(":memory:");
	try {
		const root = insertNode(db, { parentId: null, name: "root", role: "root" });
		const worker = insertNode(db, { parentId: root.id, name: "worker", role: "worker" });
		upsertUsage(db, { nodeId: worker.id, tokensIn: 0, tokensOut: 0, costUsd: 0 });
		assert.deepEqual(attachUsageTotals(db, []), []);
		assert.deepEqual(attachUsageTotals(db, [root]), [root]);
		// Zero totals omit both fields (same as the old per-node path).
		assert.deepEqual(attachUsageTotals(db, [worker, worker]), [worker, worker]);
	} finally {
		db.close();
	}
});

test("attachUsageTotals chunks IN lists above USAGE_IN_CHUNK", () => {
	const db = openLegionDb(":memory:");
	try {
		const root = insertNode(db, { parentId: null, name: "root", role: "root" });
		const nodes = [root];
		const n = USAGE_IN_CHUNK + 25;
		// Fan out under synthetic parents so hierarchical ids stay valid and
		// we still force more than one IN (...) chunk.
		let parent = root;
		for (let i = 0; i < n; i += 1) {
			if (i > 0 && i % 8 === 0) {
				// new sibling under root as a fresh parent bucket
				parent = insertNode(db, {
					parentId: root.id,
					name: `bucket${i}`,
					role: "worker",
				});
				nodes.push(parent);
			}
			const child = insertNode(db, {
				parentId: parent.id,
				name: `leaf${i}`,
				role: "worker",
			});
			upsertUsage(db, { nodeId: child.id, tokensIn: i + 1, tokensOut: 2, costUsd: 0 });
			nodes.push(child);
		}
		assert.ok(nodes.length > USAGE_IN_CHUNK + 1, `need >${USAGE_IN_CHUNK} ids to exercise chunking`);
		const annotated = attachUsageTotals(db, nodes);
		assert.equal(annotated.length, nodes.length);
		assert.deepEqual(annotated[0], root, "root stays unannotated");
		const firstLeaf = annotated.find((node) => node.id.endsWith(".leaf0"));
		assert.ok(firstLeaf);
		assert.equal(firstLeaf.tokensTotal, 1 + 2);
		assert.equal(firstLeaf.tokensOut, 2);
		const lastLeaf = annotated.find((node) => node.id.endsWith(`.leaf${n - 1}`));
		assert.ok(lastLeaf);
		assert.equal(lastLeaf.tokensTotal, (n - 1) + 1 + 2);
		assert.equal(lastLeaf.tokensOut, 2);
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
