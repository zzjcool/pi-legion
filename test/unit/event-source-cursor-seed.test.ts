/**
 * #238: seed the DB event source cursor at attach.
 *
 * `createDbEventSource` defaults `cursor` to 0 ("replay the whole log"). Before
 * this fix the production attach path (`createLegionRuntime` in `index.ts`) used
 * that default, so attaching to a ledger with history re-delivered every stored
 * event through the bus, and `runtime.onWidgetEvent` charged each one a full
 * `snapshotNodes()` plus a repaint — seconds of blocked UI at 120 nodes / 1000
 * events — to reach a state the DB already described.
 *
 * The fix seeds at the call site (`{ cursor: maxEventId(db) }`). The factory's
 * default stays 0, which is a documented option semantic other tests and the
 * frozen contract in `docs/contracts/drop-non-pi-kinds-v4.md:114-120` rely on
 * (rows written BEFORE `start()` must still be delivered when no cursor is
 * passed). These tests pin both halves: seeded attach replays nothing, and
 * `cursor: 0` still replays everything.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { attachLegionRuntime } from "../../index.ts";
import {
	createDbEventSource,
	createLegionEventBus,
	type DbEventSource,
	type EventSourceClock,
	type EventSourceIntervalHandle,
	type LegionEvent as BusEvent,
} from "../../src/extension/event-bus.ts";
import { openLegionDb, type DatabaseSync } from "../../src/legion/db.ts";
import {
	LEGION_EVENT_TYPES,
	appendEvent,
	maxEventId,
	readEventsAfter,
} from "../../src/legion/events.ts";
import { getSubtree, insertNode } from "../../src/legion/nodes.ts";
import { createSessionRuntime, type SessionRuntime } from "../../src/extension/runtime.ts";
import { attachUsageTotals } from "../../src/legion/usage.ts";

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

function withFileDb(fn: (file: string) => void | Promise<void>): Promise<void> {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "legion-cursor-seed-"));
	const file = path.join(directory, "legion.db");
	return Promise.resolve(fn(file)).finally(() => {
		fs.rmSync(directory, { recursive: true, force: true });
	});
}

function seedRoot(db: DatabaseSync): void {
	insertNode(db, {
		id: "root",
		parentId: null,
		name: "root",
		role: "root",
		kind: "pi",
		depth: 0,
		status: "running",
		createdAt: 1,
		updatedAt: 1,
	});
}

function seedEvents(db: DatabaseSync, count: number): number[] {
	const ids: number[] = [];
	for (let i = 0; i < count; i += 1) {
		ids.push(appendEvent(db, "root", "phase_change", { i }, { now: () => 100 + i }).id);
	}
	return ids;
}

// ---------------------------------------------------------------- helper ----

test("maxEventId returns the tail id, 0 for an empty log, and is not counted as an event SELECT", () => {
	withFileDb((file) => {
		const db = openLegionDb(file);
		try {
			assert.equal(maxEventId(db), 0, "an empty log seeds at 0");

			const ids = seedEvents(db, 3);
			assert.deepEqual(ids, [1, 2, 3]);
			assert.equal(maxEventId(db), 3);

			// Deleted tail rows must not make the seed unreadable: COALESCE(MAX(id))
			// follows AUTOINCREMENT, so a pruned log still seeds at its high-water mark.
			db.exec("DELETE FROM events WHERE id = 3");
			assert.equal(maxEventId(db), 2);
		} finally {
			db.close();
		}
	});
});

test("maxEventId degrades to 0 only where that is provably safe", () => {
	// Documents WHY the helper narrows instead of throwing. A seed of 0 means "replay
	// everything", so the only question is whether an id can be unreadable here.
	// It cannot: a non-numeric write into an INTEGER PRIMARY KEY is refused with
	// "datatype mismatch", and node:sqlite refuses to hand back an id it cannot
	// represent exactly as a JS number. A stored id of 0 IS possible (CAST), and
	// COALESCE then still reports the real tail when any real row exists.
	withFileDb((file) => {
		const db = openLegionDb(file);
		try {
			seedRoot(db);
			seedEvents(db, 1);
			assert.throws(
				() => db.exec("UPDATE events SET id = 'not-a-number' WHERE id = 1"),
				/datatype mismatch/i,
				"a non-numeric id cannot land in an INTEGER PRIMARY KEY",
			);
			// CAST does produce a storable 0; with only that row MAX is 0 -> seed 0,
			// which is exactly the safe "replay" default rather than a skipped row.
			db.exec("UPDATE events SET id = CAST('x' AS INTEGER) WHERE id = 1");
			assert.equal(maxEventId(db), 0, "a lone id-0 row seeds at 0, which replays (safe)");
			// Any real row restores a proper tail.
			const next = appendEvent(db, "root", "phase_change", null, { now: () => 5 });
			assert.ok(next.id > 0);
			assert.equal(maxEventId(db), next.id, "MAX(id) ignores the degenerate 0 row");
		} finally {
			db.close();
		}
	});
});

test("maxEventId's SQL does not collide with the instrumented event-SELECT counter", () => {
	// `test/unit/legion-event-bus.test.ts` wraps a DatabaseSync and counts
	// `prepare()` calls whose SQL starts with the event-read prefix. The seed
	// query must keep a different shape or those exact-count assertions break.
	withFileDb((file) => {
		const db = openLegionDb(file);
		seedRoot(db);
		seedEvents(db, 2);
		let eventSelects = 0;
		const instrumented: DatabaseSync = {
			exec: (sql) => db.exec(sql),
			prepare(sql) {
				if (sql.startsWith("SELECT id, node_id, type, data, ts FROM events WHERE id > ?")) {
					eventSelects++;
				}
				return db.prepare(sql);
			},
			close: () => db.close(),
		};
		try {
			assert.equal(maxEventId(instrumented), 2);
			assert.equal(eventSelects, 0, "the seed query is not an event SELECT");
		} finally {
			db.close();
		}
	});
});

// ------------------------------------------------------- route S: attach ----

test("#238: the production attach path (index.ts attachLegionRuntime) delivers zero historical events, then new ones", () => {
	withFileDb((file) => {
		const writer = openLegionDb(file);
		let source: DbEventSource | undefined;
		try {
			seedRoot(writer);
			const historical = seedEvents(writer, 50);
			assert.equal(historical.length, 50);

			// A separate reader connection: same-connection writes never dirty data_version.
			const reader = openLegionDb(file);
			const bus = createLegionEventBus();
			const delivered: string[] = [];
			for (const type of LEGION_EVENT_TYPES) {
				bus.on(type, (event) => delivered.push(`${event.type}:${event.id}`));
			}
			// THE SEAM: this is the exact call the production attach makes. Exercising
			// the factory directly here instead would keep passing if the seed were
			// removed from index.ts, which is precisely the regression to gate.
			source = attachLegionRuntime({ db: reader, eventBus: bus });

			assert.deepEqual(delivered, [], "attach replays no historical event");
			assert.equal(source.getCursor(), 50, "the cursor starts at the seeded tail");

			// A dirty-version cycle with nothing new must not resurrect history either.
			// (`poll()` is the public one-cycle read; the seam arms the real interval.)
			source.poll();
			assert.deepEqual(delivered, [], "an attach poll stays quiet");

			// A newly appended row after start() still arrives.
			const fresh = appendEvent(writer, "root", "node_settled", { done: true }, { now: () => 999 });
			source.poll();
			assert.deepEqual(delivered, [`node_settled:${fresh.id}`], "post-attach commits still flow");
			assert.equal(source.getCursor(), fresh.id);

			source.stop();
			reader.close();
		} finally {
			source?.stop();
			writer.close();
		}
	});
});

test("#238: the attach seam replays nothing on a ledger with history", () => {
	// This is the regression gate for the SEED ITSELF: with `delivered` counting the
	// ledger's own history, removing the seed makes this assertion fail (verified:
	// 7 vs 0). Note what does NOT gate it — the poller drains to the tail anyway, so
	// `getCursor()` reads 7 whether or not the seed ran and cannot distinguish the
	// two. Do not add a getCursor assertion here claiming otherwise.
	withFileDb((file) => {
		const writer = openLegionDb(file);
		try {
			seedRoot(writer);
			seedEvents(writer, 7);
			const reader = openLegionDb(file);
			const bus = createLegionEventBus();
			let delivered = 0;
			for (const type of LEGION_EVENT_TYPES) bus.on(type, () => { delivered += 1; });
			const source = attachLegionRuntime({ db: reader, eventBus: bus });
			try {
				assert.equal(delivered, 0, "attach replays nothing; unseeded it replays all 7");
				assert.equal(maxEventId(reader), 7, "the ledger tail is where the seed points");
			} finally {
				source.stop();
			}
			reader.close();
		} finally {
			writer.close();
		}
	});
});

test("#238: cursor: 0 still replays the whole log (the escape hatch did not become the default)", () => {
	withFileDb((file) => {
		const writer = openLegionDb(file);
		const timers = makeClock();
		let source: DbEventSource | undefined;
		try {
			seedRoot(writer);
			const ids = seedEvents(writer, 5);
			const reader = openLegionDb(file);
			const bus = createLegionEventBus();
			const delivered: number[] = [];
			bus.on("phase_change", (event) => delivered.push(event.id ?? -1));

			source = createDbEventSource(reader, {
				cursor: 0,
				pollMs: 250,
				clock: timers.clock,
			});
			source.start(bus);
			assert.deepEqual(delivered, ids, "explicit cursor: 0 replays every stored row");
			assert.equal(source.getCursor(), 5);

			source.stop();
			reader.close();
		} finally {
			source?.stop();
			writer.close();
		}
	});
});

test("#238: omitting cursor keeps the documented default of full replay", () => {
	// The factory's own default is untouched by the fix; this is the semantic the
	// frozen contract clause and the 6 pre-existing tests depend on.
	withFileDb((file) => {
		const writer = openLegionDb(file);
		const timers = makeClock();
		let source: DbEventSource | undefined;
		try {
			seedRoot(writer);
			const ids = seedEvents(writer, 3);
			const reader = openLegionDb(file);
			const bus = createLegionEventBus();
			const delivered: number[] = [];
			bus.on("phase_change", (event) => delivered.push(event.id ?? -1));

			source = createDbEventSource(reader, { pollMs: 250, clock: timers.clock });
			source.start(bus);
			assert.deepEqual(delivered, ids, "no cursor option => replay from the beginning");

			source.stop();
			reader.close();
		} finally {
			source?.stop();
			writer.close();
		}
	});
});

// ------------------------------------------------ atomicity / gap window ----

test("#238: a row committed between the seed query and start() is picked up, not lost", () => {
	// The seed (`SELECT COALESCE(MAX(id),0)`) is not atomic with `start()`'s first
	// poll. This test pins the actual behaviour of that window, because "the cursor
	// selects rows" makes the naive worry ("a skipped row is skipped forever")
	// plausible. It is NOT what happens: the poller never latches a version on the
	// seed, so the first poll (lastDataVersion === undefined) reads and then
	// records the current data_version. A commit that lands after that first poll
	// bumps data_version again and is read on the next tick.
	withFileDb((file) => {
		const writer = openLegionDb(file);
		const timers = makeClock();
		let source: DbEventSource | undefined;
		try {
			seedRoot(writer);
			seedEvents(writer, 4);

			const reader = openLegionDb(file);
			const cursorAtSeed = maxEventId(reader);
			assert.equal(cursorAtSeed, 4);

			// THE GAP: an external commit lands after the seed query, before start().
			const inWindow = appendEvent(writer, "root", "node_failed", { why: "race" }, { now: () => 500 });

			const bus = createLegionEventBus();
			const delivered: string[] = [];
			for (const type of LEGION_EVENT_TYPES) {
				bus.on(type, (event) => delivered.push(`${event.type}:${event.id}`));
			}
			source = createDbEventSource(reader, {
				cursor: cursorAtSeed,
				pollMs: 250,
				clock: timers.clock,
			});
			source.start(bus);

			// start()'s synchronous first poll sees the row: `id > 4` selects it and
			// the first poll always runs because lastDataVersion starts undefined.
			assert.deepEqual(
				delivered,
				[`node_failed:${inWindow.id}`],
				"the in-window commit is delivered by the first poll, not skipped",
			);
			assert.equal(source.getCursor(), inWindow.id);

			// And a further commit after that first poll still flows on the next tick.
			const later = appendEvent(writer, "root", "node_settled", null, { now: () => 501 });
			timers.tick();
			assert.deepEqual(delivered, [`node_failed:${inWindow.id}`, `node_settled:${later.id}`]);
			assert.equal(source.getCursor(), later.id);

			source.stop();
			reader.close();
		} finally {
			source?.stop();
			writer.close();
		}
	});
});

test("#238: a commit landing after start()'s first poll is read on the next dirty tick", () => {
	// The other half of the window: seed, start (first poll records data_version),
	// THEN a commit. The dirty check is what carries it, so it must not be eaten.
	withFileDb((file) => {
		const writer = openLegionDb(file);
		const timers = makeClock();
		let source: DbEventSource | undefined;
		try {
			seedRoot(writer);
			seedEvents(writer, 2);
			const reader = openLegionDb(file);
			const bus = createLegionEventBus();
			const delivered: string[] = [];
			for (const type of LEGION_EVENT_TYPES) {
				bus.on(type, (event) => delivered.push(`${event.type}:${event.id}`));
			}
			source = createDbEventSource(reader, { cursor: maxEventId(reader), pollMs: 250, clock: timers.clock });
			source.start(bus);
			const afterFirstPoll = appendEvent(writer, "root", "node_launched", null, { now: () => 600 });
			assert.deepEqual(delivered, [], "nothing is delivered before the next poll");
			timers.tick();
			assert.deepEqual(delivered, [`node_launched:${afterFirstPoll.id}`]);
			source.stop();
			reader.close();
		} finally {
			source?.stop();
			writer.close();
		}
	});
});

test("#238: seeding is safe on an empty ledger (seed 0 still reads the first row)", () => {
	withFileDb((file) => {
		const writer = openLegionDb(file);
		let source: DbEventSource | undefined;
		try {
			seedRoot(writer);
			const reader = openLegionDb(file);
			assert.equal(maxEventId(reader), 0, "an empty log seeds at 0 (not -1, not null)");
			const bus = createLegionEventBus();
			const delivered: number[] = [];
			bus.on("phase_change", (event) => delivered.push(event.id ?? -1));
			const timers = makeClock();
			source = createDbEventSource(reader, { cursor: maxEventId(reader), pollMs: 250, clock: timers.clock });
			source.start(bus);
			assert.deepEqual(delivered, [], "an empty ledger delivers nothing on attach");
			// A cross-connection commit dirties data_version and is read on the next tick:
			// the seed of 0 is exactly the default, so nothing is skipped.
			const first = appendEvent(writer, "root", "phase_change", null, { now: () => 1 });
			timers.tick();
			assert.deepEqual(delivered, [first.id], "a seeded-at-0 source reads the first new row");
			assert.equal(source.getCursor(), first.id);
			reader.close();
		} finally {
			source?.stop();
			writer.close();
		}
	});
});

// --------------------------------------------- attach-time board repaint ----

test("#238: attach with no tracked jobs and no new events still paints the tree from the DB", () => {
	// Seeding removes the accidental "replay repaints the board" effect. The board
	// is only written by `paint()`, so this pins that the production shapes
	// (`getTreeNodes` supplied by the host, no bus traffic) still produce rows.
	withFileDb((file) => {
		const db = openLegionDb(file);
		const bus = createLegionEventBus();
		seedRoot(db);
		insertNode(db, {
			id: "root.worker",
			parentId: "root",
			name: "worker",
			role: "worker",
			kind: "pi",
			depth: 1,
			status: "running",
			createdAt: 2,
			updatedAt: 2,
		});
		const rendered: string[] = [];
		// Same shape as index.ts:805 — the host reads the authoritative tree.
		const getTreeNodes = () => attachUsageTotals(db, getSubtree(db, "root"));
		let runtime: SessionRuntime | undefined;
		try {
			runtime = createSessionRuntime({
				sendMessage() {},
				eventBus: bus,
				getTreeNodes,
			});
			// Seeded attach: no historical event exists, and none is delivered.
			const timers = makeClock();
			let source: DbEventSource | undefined;
			const delivered: BusEvent[] = [];
			for (const type of LEGION_EVENT_TYPES) {
				bus.on(type, (event) => delivered.push(event));
			}
			source = createDbEventSource(db, { cursor: maxEventId(db), pollMs: 250, clock: timers.clock });
			source.start(bus);
			try {
				assert.deepEqual(delivered, [], "no event drives the attach repaint");
				// bind() alone must populate the board from the ledger snapshot.
				runtime.bind({
					hasUI: true,
					ui: {
						theme: { fg: (_c: string, text: string) => text },
						setStatus() {},
						setWidget(_key: string, content: unknown) {
							if (typeof content === "function") {
								const component = (content as (
									tui: { requestRender(): void },
									theme: { fg(c: string, t: string): string },
								) => { render(width?: number): string[] })(
									{ requestRender() {} },
									{ fg: (_c: string, text: string) => text },
								);
								rendered.splice(0, rendered.length, ...component.render());
							}
						},
					},
				} as never);
				const entries = runtime.statusEntries();
				assert.deepEqual(
					entries.map((entry) => entry.nodeId),
					["root", "root.worker"],
					"the ledger tree is visible through statusEntries with zero events",
				);
				assert.ok(rendered.length > 0, "bind() painted a widget without any bus event");
				assert.match(rendered.join("\n"), /worker/, "the painted widget shows the tree");
			} finally {
				source.stop();
			}
		} finally {
			runtime?.dispose();
			db.close();
		}
	});
});

test("#238: seeded attach over a long log leaves statusEntries populated (no replay needed)", () => {
	withFileDb((file) => {
		const db = openLegionDb(file);
		seedRoot(db);
		const ids = seedEvents(db, 200);
		assert.equal(maxEventId(db), ids.at(-1));
		let runtime: SessionRuntime | undefined;
		const bus = createLegionEventBus();
		const source = createDbEventSource(db, {
			cursor: maxEventId(db),
			pollMs: 250,
			clock: makeClock().clock,
		});
		try {
			runtime = createSessionRuntime({
				sendMessage() {},
				eventBus: bus,
				getTreeNodes: () => attachUsageTotals(db, getSubtree(db, "root")),
			});
			source.start(bus);
			// Sanity: the raw read confirms 200 rows exist that replay would have walked.
			assert.equal(readEventsAfter(db, 0, { limit: 1_000 }).length, 200);
			assert.deepEqual(runtime.statusEntries().map((entry) => entry.nodeId), ["root"]);
		} finally {
			source.stop();
			runtime?.dispose();
			db.close();
		}
	});
});
