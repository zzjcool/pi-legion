/**
 * Ledger write/read cost — the SQLite layer every UI tick and every postman
 * heartbeat sits on.
 *
 * Findings these numbers back (see reports/perf-2026-10-19/REPORT.md):
 *   - `attachUsageTotals` is an N+1: one `getUsage` per node, ~72% of the
 *     `snapshotNodes()` cost that runs on the 500ms refresh and on every event.
 *   - `heartbeatNode` -> `updateNode` is one implicit transaction (one fsync
 *     under the default `synchronous=FULL`) per child per 2s tick.
 *   - every `prepare()` recompiles: the data layer keeps no statement cache.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { getSubtree, getChildren, getNode, updateNode } from "../../src/legion/nodes.ts";
import { attachUsageTotals } from "../../src/legion/usage.ts";
import { appendEvent, getDataVersion, readEventsAfter } from "../../src/legion/events.ts";
import { buildTree, medianMs, usPerOp, withBench } from "./fixtures.ts";

const NODES = 200;

test("snapshotNodes: attachUsageTotals dominates the recursive CTE", () => {
	withBench((h) => {
		buildTree(h.db, NODES);
		const subtree = getSubtree(h.db, "root");
		const treeMs = medianMs(() => { getSubtree(h.db, "root"); });
		const usageMs = medianMs(() => { attachUsageTotals(h.db, subtree); });
		const bothMs = medianMs(() => { attachUsageTotals(h.db, getSubtree(h.db, "root")); });

		// Attach is the N+1; it must be the larger half of the snapshot.
		assert.ok(subtree.length >= NODES - 1, `expected a ${NODES}-node tree, got ${subtree.length}`);
		assert.ok(
			usageMs > treeMs,
			`N+1 usage (${usageMs.toFixed(2)}ms) should exceed the single CTE (${treeMs.toFixed(2)}ms)`,
		);
		// Loose ceiling: catches an order-of-magnitude regression only.
		assert.ok(bothMs < 400, `snapshot of ${subtree.length} nodes took ${bothMs.toFixed(1)}ms`);
	});
});

test("heartbeat: one implicit transaction per child (a batch pays one fsync)", () => {
	withBench((h) => {
		buildTree(h.db, 60);
		const children = getChildren(h.db, "root");
		assert.ok(children.length >= 8, `expected child rows, got ${children.length}`);

		const autocommit = medianMs(() => {
			for (const child of children) updateNode(h.db, child.id, {});
		}, 7);
		const batched = medianMs(() => {
			h.db.exec("BEGIN IMMEDIATE");
			for (const child of children) updateNode(h.db, child.id, {});
			h.db.exec("COMMIT");
		}, 7);

		// The batch pays one fsync instead of N. This is the measurable gap the
		// "wrap heartbeats in a transaction" fix is meant to close.
		assert.ok(
			autocommit > batched,
			`per-child autocommit (${autocommit.toFixed(2)}ms) should cost more than one batch (${batched.toFixed(2)}ms)`,
		);
		assert.ok(autocommit < 2_000, `heartbeat loop took ${autocommit.toFixed(0)}ms for ${children.length} children`);
	});
});

test("prepare() recompiles: a reused statement is cheaper than prepare-per-call", () => {
	withBench((h) => {
		buildTree(h.db, 50);
		const sql = "SELECT * FROM nodes WHERE id = ?";
		const fresh = usPerOp(() => { h.db.prepare(sql).get("root"); }, 1_000);
		const reused = h.db.prepare(sql);
		const cached = usPerOp(() => { reused.get("root"); }, 1_000);

		assert.ok(
			cached < fresh,
			`reused (${cached.toFixed(1)}us) should beat prepare-per-call (${fresh.toFixed(1)}us)`,
		);
	});
});

test("poll dirty-check is cheap: getDataVersion stays in the microsecond range", () => {
	withBench((h) => {
		buildTree(h.db, 20);
		const us = usPerOp(() => { getDataVersion(h.db); }, 1_000);
		// The 250ms poll's whole point is that this is cheap enough to run 4x/s.
		assert.ok(us < 500, `getDataVersion took ${us.toFixed(1)}us`);
	});
});

test("event cursor read is served by the rowid index", () => {
	withBench((h) => {
		buildTree(h.db, 20);
		for (let i = 0; i < 100; i += 1) appendEvent(h.db, "root", "phase_change", { i });
		const cursor = 50;
		const events = readEventsAfter(h.db, cursor, { limit: 1_000 });
		assert.equal(events.length, 50, "a cursor read must return only events past the cursor");
		const ms = medianMs(() => { readEventsAfter(h.db, cursor, { limit: 1_000 }); });
		assert.ok(ms < 100, `cursor read took ${ms.toFixed(1)}ms`);
	});
});

test("getNode is index-served and does not scale with tree size", () => {
	withBench((h) => {
		buildTree(h.db, 300);
		assert.ok(getNode(h.db, "root"));
		const us = usPerOp(() => { getNode(h.db, "root"); }, 2_000);
		// PK lookup: stays flat regardless of the 300 rows above.
		assert.ok(us < 400, `getNode took ${us.toFixed(1)}us at 300 nodes`);
	});
});
