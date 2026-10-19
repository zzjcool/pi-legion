/**
 * Ledger event bus: the 250ms cross-process poll.
 *
 * This file is BOTH a measurement and a regression gate for a real defect
 * (reports/perf-2026-10-19/REPORT.md, P2):
 *
 *   `src/runs/hygiene.ts` writes an event of type `node_abandoned`, but
 *   `LEGION_EVENT_TYPES` does not contain it and `mapEvent` throws on an
 *   unknown type. `createDbEventSource` records the error and leaves the
 *   cursor unadvanced, so every subsequent poll re-reads the same poisoned
 *   batch and throws again: the cross-process view stalls permanently while
 *   burning a poll every 250ms.
 *
 * The last test below pins the CURRENT (buggy) behaviour so the fix has a
 * failing-first test to turn around. Flip its assertion when the fix lands.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { createDbEventSource, createLegionEventBus } from "../../src/extension/event-bus.ts";
import { appendEvent, readEventsAfter } from "../../src/legion/events.ts";
import { insertNode } from "../../src/legion/nodes.ts";
import { buildTree, medianMs, withBench } from "./fixtures.ts";

function seedRoot(h: { db: Parameters<typeof insertNode>[0] }): void {
	insertNode(h.db, { id: "root", parentId: null, name: "root", role: "root", kind: "pi", depth: 0, status: "running" });
}

test("the poll advances its cursor and delivers every valid event once", () => {
	withBench((h) => {
		seedRoot(h);
		for (const type of ["node_launched", "phase_change", "node_settled"] as const) {
			appendEvent(h.db, "root", type, { at: 1 });
		}
		const bus = createLegionEventBus();
		const delivered: string[] = [];
		for (const type of ["node_launched", "phase_change", "node_settled"] as const) {
			bus.on(type, (event) => { delivered.push(event.type); });
		}
		const errors: string[] = [];
		const source = createDbEventSource(h.db, { onError: (e) => errors.push(String(e)) });
		try {
			source.start(bus);
			assert.deepEqual(delivered, ["node_launched", "phase_change", "node_settled"]);
			assert.equal(source.getCursor(), 3);
			assert.deepEqual(errors, []);
		} finally {
			source.stop();
		}
	});
});

test("a no-change poll does not re-read events (data_version dirty check)", () => {
	withBench((h) => {
		seedRoot(h);
		appendEvent(h.db, "root", "phase_change", { at: 1 });
		const bus = createLegionEventBus();
		let deliveries = 0;
		bus.on("phase_change", () => { deliveries += 1; });
		const source = createDbEventSource(h.db, {});
		try {
			source.start(bus);
			assert.equal(deliveries, 1);
			source.poll();
			source.poll();
			assert.equal(deliveries, 1, "an unchanged ledger must not redeliver");
		} finally {
			source.stop();
		}
	});
});

test("readEventsAfter rejects no valid type and is fast enough for a 250ms poll", () => {
	withBench((h) => {
		buildTree(h.db, 30);
		for (let i = 0; i < 200; i += 1) appendEvent(h.db, "root", "phase_change", { i });
		const ms = medianMs(() => { readEventsAfter(h.db, 0, { limit: 1_000 }); });
		assert.ok(ms < 200, `a 200-event cursor read took ${ms.toFixed(1)}ms`);
	});
});

test("REGRESSION (open defect): a node_abandoned row permanently stalls the cursor", () => {
	withBench((h) => {
		seedRoot(h);
		appendEvent(h.db, "root", "node_launched", { at: 1 });
		// This is exactly what src/runs/hygiene.ts:164 writes.
		h.db
			.prepare("INSERT INTO events (node_id, type, data, ts) VALUES (?, 'node_abandoned', ?, ?)")
			.run("root", "{}", 2);

		const bus = createLegionEventBus();
		const delivered: string[] = [];
		bus.on("node_launched", () => { delivered.push("node_launched"); });
		const errors: string[] = [];
		const source = createDbEventSource(h.db, { onError: (e) => errors.push(String(e)) });
		try {
			source.start(bus);
			const firstCursor = source.getCursor();
			source.poll();
			const secondCursor = source.getCursor();

			// CURRENT behaviour: the batch throws before any event is emitted, so
			// even the valid node_launched row ahead of it stays undelivered.
			assert.equal(delivered.length, 0, "the valid event is starved by the poisoned row");
			assert.equal(firstCursor, 0, "the cursor never advances");
			assert.equal(secondCursor, firstCursor, "polling again cannot make progress");
			assert.ok(errors.length > 0, "each poll re-reports the same error");
			assert.match(errors[0] ?? "", /unknown legion event type: node_abandoned/);
		} finally {
			source.stop();
		}
	});
});
