import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
	createDbEventSource,
	createLegionEventBus,
	type DbEventSource,
	type EventSourceClock,
	type EventSourceIntervalHandle,
} from "../../src/extension/event-bus.ts";
import { appendEvent, getDataVersion } from "../../src/legion/events.ts";
import { openLegionDb, type DatabaseSync } from "../../src/legion/db.ts";
import { insertNode } from "../../src/legion/nodes.ts";

function makeClock(): { clock: EventSourceClock; tick(): void; clearCount(): number } {
	let callback: (() => void) | undefined;
	let clears = 0;
	const clock: EventSourceClock = {
		setInterval(next) {
			callback = next;
			const handle = setInterval(() => {}, 60_000);
			handle.unref();
			return handle;
		},
		clearInterval(handle: EventSourceIntervalHandle) {
			clears++;
			clearInterval(handle);
		},
	};
	return {
		clock,
		tick() {
			assert.ok(callback, "polling interval is registered");
			callback();
		},
		clearCount: () => clears,
	};
}

test("LegionEventBus delivers direct process events synchronously to multiple subscribers", () => {
	const bus = createLegionEventBus();
	const calls: string[] = [];
	const first = bus.on("tool_call", (event) => calls.push(`first:${event.nodeId}`));
	bus.on("tool_call", (event) => calls.push(`second:${event.type}`));
	bus.emit({ nodeId: "root.worker", type: "tool_call", data: { name: "read" }, ts: 10 });
	assert.deepEqual(calls, ["first:root.worker", "second:tool_call"]);
	first();
	first();
	calls.length = 0;
	bus.emit({ nodeId: "root.worker", type: "tool_call", data: null, ts: 11 });
	assert.deepEqual(calls, ["second:tool_call"]);
});

test("LegionEventBus isolates a throwing handler and still delivers to later handlers", () => {
	const failures: unknown[] = [];
	const bus = createLegionEventBus({ onHandlerError: (error) => failures.push(error) });
	const calls: string[] = [];
	bus.on("node_launched", () => {
		throw new Error("subscriber failed");
	});
	bus.on("node_launched", () => calls.push("delivered"));
	assert.doesNotThrow(() => {
		bus.emit({ nodeId: "root.worker", type: "node_launched", data: null, ts: 20 });
	});
	assert.deepEqual(calls, ["delivered"]);
	assert.equal(failures.length, 1);
	assert.match(String(failures[0]), /subscriber failed/);
});

test("DB event source uses data_version, advances its cursor and goes quiet after unsubscribe", () => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "legion-event-bus-"));
	const file = path.join(directory, "legion.db");
	const writer = openLegionDb(file);
	const timers = makeClock();
	insertNode(writer, { parentId: null, name: "root", role: "root" }, () => 1);
	const reader = openLegionDb(file);
	let eventSelects = 0;
	const instrumentedReader: DatabaseSync = {
		exec: (sql) => reader.exec(sql),
		prepare(sql) {
			if (sql.startsWith("SELECT id, node_id, type, data, ts FROM events WHERE id > ?")) {
				eventSelects++;
			}
			return reader.prepare(sql);
		},
		close: () => reader.close(),
	};
	let source: DbEventSource | undefined;
	try {
		source = createDbEventSource(instrumentedReader, { pollMs: 250, clock: timers.clock });
		const bus = createLegionEventBus();
		const received: number[] = [];
		const unsubscribe = bus.on("node_launched", (event) => received.push(event.id ?? -1));
		source.start(bus);
		assert.deepEqual(received, [], "initial read starts at the configured cursor");
		assert.equal(eventSelects, 1, "start performs one initial cursor read");
		timers.tick();
		assert.equal(eventSelects, 1, "unchanged data_version skips event SELECTs");

		const launched = appendEvent(writer, "root.worker", "node_launched", { fact: true }, { now: () => 2 });
		timers.tick(); // the next 250ms poll notices the external commit
		assert.deepEqual(received, [launched.id]);
		assert.equal(eventSelects, 2, "changed data_version triggers one incremental SELECT");
		assert.equal(source.getCursor(), launched.id);

		const settled = appendEvent(writer, "root.worker", "node_settled", null, { now: () => 3 });
		timers.tick();
		assert.equal(source.getCursor(), settled.id);
		assert.deepEqual(received, [launched.id], "unrelated event types do not reach this subscriber");

		unsubscribe();
		const nextLaunch = appendEvent(writer, "root", "node_launched", null, { now: () => 4 });
		timers.tick();
		assert.equal(source.getCursor(), nextLaunch.id);
		assert.deepEqual(received, [launched.id], "unsubscribe is silent while source cursor keeps advancing");

		source.stop();
		assert.equal(source.isRunning(), false);
		assert.equal(timers.clearCount(), 1);
		timers.tick();
		assert.deepEqual(received, [launched.id]);
	} finally {
		source?.stop();
		writer.close();
		reader.close();
		fs.rmSync(directory, { recursive: true, force: true });
	}
});

test("DB event source skips an undecodable row instead of stalling on it", () => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "legion-event-bus-poison-"));
	const file = path.join(directory, "legion.db");
	const writer = openLegionDb(file);
	const timers = makeClock();
	insertNode(writer, { parentId: null, name: "root", role: "root" }, () => 1);
	const insert = writer.prepare("INSERT INTO events (node_id, type, data, ts) VALUES (?, ?, ?, ?)");
	insert.run("root", "node_launched", "{}", 1);
	insert.run("root", "definitely_not_a_type", "{}", 2);
	insert.run("root", "phase_change", "{}", 3);
	// A separate reader connection: same-connection writes never dirty data_version.
	const reader = openLegionDb(file);
	const bus = createLegionEventBus();
	const delivered: string[] = [];
	bus.on("node_launched", (event) => delivered.push(event.type));
	bus.on("phase_change", (event) => delivered.push(event.type));
	const errors: unknown[] = [];
	let source: DbEventSource | undefined;
	try {
		source = createDbEventSource(reader, {
			pollMs: 250,
			clock: timers.clock,
			onError: (error) => errors.push(error),
		});
		source.start(bus);
		assert.deepEqual(delivered, ["node_launched", "phase_change"]);
		assert.equal(source.getCursor(), 3, "the cursor steps over the poison row");
		assert.equal(errors.length, 1, "the undecodable row is reported exactly once");
		assert.match(String(errors[0]), /unknown legion event type: definitely_not_a_type/);

		timers.tick();
		assert.equal(errors.length, 1, "an unchanged ledger does not re-report the skipped row");
		assert.equal(source.getCursor(), 3, "polling again does not move the cursor backwards");

		// A later commit after the poison row must flow through without re-reading it.
		insert.run("root", "phase_change", "{}", 4);
		timers.tick();
		assert.deepEqual(delivered, ["node_launched", "phase_change", "phase_change"]);
		assert.equal(source.getCursor(), 4, "the new row advances the cursor");
		assert.equal(errors.length, 1, "the skipped row is never reported a second time");
	} finally {
		source?.stop();
		writer.close();
		reader.close();
		fs.rmSync(directory, { recursive: true, force: true });
	}
});

test("a poison row at the tail of a batch is never re-reported", () => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "legion-event-bus-poison-tail-"));
	const file = path.join(directory, "legion.db");
	const writer = openLegionDb(file);
	const timers = makeClock();
	insertNode(writer, { parentId: null, name: "root", role: "root" }, () => 1);
	const insert = writer.prepare("INSERT INTO events (node_id, type, data, ts) VALUES (?, ?, ?, ?)");
	// The poison row is the LAST row of the first batch: the skipped-row cursor
	// must not be rewound by the valid rows decoded ahead of it in that batch.
	insert.run("root", "node_launched", "{}", 1);
	insert.run("root", "definitely_not_a_type", "{}", 2);
	const reader = openLegionDb(file);
	const bus = createLegionEventBus();
	const delivered: string[] = [];
	bus.on("node_launched", (event) => delivered.push(event.type));
	bus.on("phase_change", (event) => delivered.push(event.type));
	const errors: unknown[] = [];
	let source: DbEventSource | undefined;
	try {
		source = createDbEventSource(reader, {
			pollMs: 250,
			clock: timers.clock,
			onError: (error) => errors.push(error),
		});
		source.start(bus);
		assert.deepEqual(delivered, ["node_launched"]);
		assert.equal(source.getCursor(), 2, "the cursor stays past the skipped tail row");
		assert.equal(errors.length, 1);

		insert.run("root", "phase_change", "{}", 3);
		timers.tick();
		assert.deepEqual(delivered, ["node_launched", "phase_change"], "new rows after the poison row still arrive");
		assert.equal(source.getCursor(), 3);
		assert.equal(errors.length, 1, "the skipped tail row is not reported again on the next poll");

		timers.tick();
		assert.equal(errors.length, 1);
		assert.equal(source.getCursor(), 3);
	} finally {
		source?.stop();
		writer.close();
		reader.close();
		fs.rmSync(directory, { recursive: true, force: true });
	}
});

test("same-connection writes leave data_version unchanged; process emit handles them directly", () => {
	const db = openLegionDb(":memory:");
	const timers = makeClock();
	let eventSelects = 0;
	const instrumentedDb: DatabaseSync = {
		exec: (sql) => db.exec(sql),
		prepare(sql) {
			if (sql.startsWith("SELECT id, node_id, type, data, ts FROM events WHERE id > ?")) {
				eventSelects++;
			}
			return db.prepare(sql);
		},
		close: () => db.close(),
	};
	insertNode(db, { parentId: null, name: "root", role: "root" }, () => 1);
	const source = createDbEventSource(instrumentedDb, { pollMs: 250, clock: timers.clock });
	const bus = createLegionEventBus();
	const received: number[] = [];
	const unsubscribe = bus.on("node_failed", (event) => received.push(event.id ?? -1));
	try {
		source.start(bus);
		assert.equal(eventSelects, 1, "start reads once from the initial cursor");
		const before = getDataVersion(db);
		const event = appendEvent(db, "root", "node_failed", { local: true }, { now: () => 2 });
		assert.equal(getDataVersion(db), before, "data_version intentionally tracks commits from other connections only");
		timers.tick();
		assert.equal(eventSelects, 1, "a same-connection write does not dirty the cross-process source");
		assert.deepEqual(received, []);
		bus.emit(event);
		assert.deepEqual(received, [event.id], "the in-process feed delivers local events synchronously");
	} finally {
		unsubscribe();
		source.stop();
		db.close();
	}
});

test("DB event source rejects polling outside the frozen 200–500ms interval", () => {
	const db = openLegionDb(":memory:");
	try {
		assert.throws(() => createDbEventSource(db, { pollMs: 100 }), /200 and 500/);
		assert.throws(() => createDbEventSource(db, { pollMs: 501 }), /200 and 500/);
	} finally {
		db.close();
	}
});
