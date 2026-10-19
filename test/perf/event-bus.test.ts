/**
 * Ledger event bus: the 250ms cross-process poll.
 *
 * This file is BOTH a measurement and a regression gate for the fix of #233
 * (reports/perf-2026-10-19/REPORT.md, P2):
 *
 *   `src/runs/hygiene.ts` writes an event of type `node_abandoned`. As long as
 *   `LEGION_EVENT_TYPES` did not contain it, `mapEvent` threw on the row and
 *   `createDbEventSource` left the cursor unadvanced, so every subsequent poll
 *   re-read the same poisoned batch: the cross-process view stalled permanently
 *   while burning a poll every 250ms.
 *
 * Fixed in #233: `node_abandoned` is now part of `LEGION_EVENT_TYPES`, so the
 * writer, the retention list and the read-side closed set agree again. Two
 * guards cover the two halves of that fix independently:
 *
 *   - `FIXED (was #233)` — the closed set now accepts the row hygiene writes.
 *   - `a poison event row does not stall the cursor` — a row that is STILL
 *     undecodable (a future type outside the set) must be stepped over and
 *     reported once, not freeze the poll. The closed set alone would fix only
 *     today's instance.
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

test("FIXED (was #233): hygiene's node_abandoned row does not stall the poll", () => {
	withBench((h) => {
		seedRoot(h);
		appendEvent(h.db, "root", "node_launched", { at: 1 });
		// Exactly what src/runs/hygiene.ts markAbandoned writes.
		h.db
			.prepare("INSERT INTO events (node_id, type, data, ts) VALUES (?, 'node_abandoned', ?, ?)")
			.run("root", "{}", 2);
		appendEvent(h.db, "root", "node_settled", { at: 3 });

		const bus = createLegionEventBus();
		const delivered: string[] = [];
		bus.on("node_launched", () => { delivered.push("node_launched"); });
		bus.on("node_settled", () => { delivered.push("node_settled"); });
		const errors: string[] = [];
		const source = createDbEventSource(h.db, { onError: (e) => errors.push(String(e)) });
		try {
			source.start(bus);
			// The row must no longer stop the stream: every valid event before AND
			// after it is delivered, and the cursor reaches the end.
			assert.deepEqual(delivered, ["node_launched", "node_settled"]);
			assert.equal(source.getCursor(), 3, "the cursor must advance past all three rows");
			assert.deepEqual(errors, []);
		} finally {
			source.stop();
		}
	});
});

test("a poison event row does not stall the cursor", () => {
	withBench((h) => {
		seedRoot(h);
		appendEvent(h.db, "root", "node_launched", { at: 1 });
		// An event type outside the closed set: the row cannot be decoded at all.
		// The closed-set fix above cannot help here, only read-side tolerance can.
		h.db
			.prepare("INSERT INTO events (node_id, type, data, ts) VALUES (?, 'definitely_not_a_type', ?, ?)")
			.run("root", "{}", 2);
		appendEvent(h.db, "root", "phase_change", { at: 3 });

		const bus = createLegionEventBus();
		const delivered: string[] = [];
		bus.on("node_launched", () => { delivered.push("node_launched"); });
		bus.on("phase_change", () => { delivered.push("phase_change"); });
		const errors: string[] = [];
		const source = createDbEventSource(h.db, { onError: (e) => errors.push(String(e)) });
		try {
			source.start(bus);
			assert.deepEqual(delivered, ["node_launched", "phase_change"], "valid rows around the poison row still arrive");
			assert.equal(source.getCursor(), 3, "the cursor steps over the undecodable row");
			assert.equal(errors.length, 1, "the undecodable row is reported exactly once");
			assert.match(errors[0] ?? "", /unknown legion event type: definitely_not_a_type/);
		} finally {
			source.stop();
		}
	});
});
