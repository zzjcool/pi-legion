import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { openLegionDb } from "../../src/legion/db.ts";
import {
	LEGION_EVENT_TYPES,
	appendEvent,
	getDataVersion,
	hasExternalChanges,
	readEventsAfter,
} from "../../src/legion/events.ts";
import { insertNode } from "../../src/legion/nodes.ts";

test("legion events enforce the exact 15-type set and JSON-round-trip data", () => {
	const db = openLegionDb(":memory:");
	try {
		insertNode(db, { parentId: null, name: "root", role: "root" });
		assert.equal(LEGION_EVENT_TYPES.length, 15);
		// #233: node_abandoned is written by hygiene, so it belongs to the closed set.
		assert.ok((LEGION_EVENT_TYPES as readonly string[]).includes("node_abandoned"));
		const one = appendEvent(db, "root", "node_launched", { source: "test" }, { now: () => 99 });
		const two = appendEvent(db, "root", "phase_change", undefined, { now: () => 100 });
		assert.deepEqual(one.data, { source: "test" });
		assert.equal(two.data, null);
		assert.deepEqual(readEventsAfter(db, 0).map((event) => event.id), [one.id, two.id]);
		assert.deepEqual(readEventsAfter(db, one.id).map((event) => event.type), ["phase_change"]);
		assert.deepEqual(readEventsAfter(db, 0, { nodeId: "missing" }), []);
		assert.throws(() => appendEvent(db, "root", "unknown" as never), /invalid legion event type/);
		assert.throws(() => appendEvent(db, "root", "node_launched", () => {}), /serializable/);
		// hygiene.ts writes this type, so it must belong to the closed set. (#233)
		assert.doesNotThrow(() => appendEvent(db, "root", "node_abandoned"));
	} finally {
		db.close();
	}
});

test("PRAGMA data_version observes writes from another connection", () => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "legion-data-version-"));
	const file = path.join(directory, "ledger.db");
	const first = openLegionDb(file);
	const second = openLegionDb(file);
	try {
		insertNode(first, { parentId: null, name: "root", role: "root" });
		const version = getDataVersion(first);
		appendEvent(first, "root", "node_launched", { local: true });
		assert.equal(hasExternalChanges(first, version), false);
		appendEvent(second, "root", "node_settled", { external: true });
		assert.equal(hasExternalChanges(first, version), true);
	} finally {
		first.close();
		second.close();
		fs.rmSync(directory, { recursive: true, force: true });
	}
});
