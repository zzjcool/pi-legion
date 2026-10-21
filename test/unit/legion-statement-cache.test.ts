/**
 * The data layer keeps one compiled statement per distinct SQL text per
 * connection (#236 part 2). These tests assert the *mechanism*, not timing:
 * a timing-only assertion ("reused beats fresh") still passes when the cache is
 * deleted, so it cannot protect the cache. Identity of the returned statement
 * and the number of compilations that reach the driver can.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
	LEGION_STMT_CACHE_LIMIT,
	legionStatementCacheSize,
	openLegionDb,
	type DatabaseSync,
} from "../../src/legion/db.ts";
import { appendEvent } from "../../src/legion/events.ts";
import { insertNode } from "../../src/legion/nodes.ts";

type PrepareCapable = { prepare(sql: string): unknown };

/** Close for `finally` blocks: a connection already closed in the test body throws. */
function closeQuietly(db: DatabaseSync): void {
	try {
		db.close();
	} catch {
		// already closed by the test body
	}
}

/**
 * Count compilations at the driver boundary while the connection is opened.
 *
 * The cache captures the driver's `prepare` when `openLegionDb` runs, so the
 * instrumentation has to be installed on the driver prototype *before* the
 * connection under test is opened — that is exactly what makes it a count of
 * real compilations rather than of cache lookups.
 */
function countingDriverPrototype(probe: DatabaseSync): {
	mounted: boolean;
	compiles: () => number;
	restore: () => void;
} {
	const prototype = Object.getPrototypeOf(probe) as PrepareCapable & {
		prepare: (sql: string) => unknown;
	};
	const original = prototype.prepare;
	const descriptor = Object.getOwnPropertyDescriptor(prototype, "prepare");
	if (!descriptor?.configurable) return { mounted: false, compiles: () => 0, restore: () => {} };
	let compiles = 0;
	prototype.prepare = function patched(this: unknown, sql: string): unknown {
		compiles += 1;
		return original.call(this, sql);
	};
	return {
		mounted: true,
		compiles: () => compiles,
		restore: () => {
			prototype.prepare = original;
		},
	};
}

test("identical SQL compiles once and returns the same statement; different SQL does not", (t) => {
	const probe = openLegionDb(":memory:");
	const counter = countingDriverPrototype(probe);
	if (!counter.mounted) {
		t.skip("driver prototype is not instrumentable");
		return;
	}
	const db = openLegionDb(":memory:");
	try {
		// Opening a connection already compiles the migration's `PRAGMA user_version`,
		// so cache assertions below are deltas from the size right after open.
		const baseSize = legionStatementCacheSize(db);
		const sql = "SELECT * FROM nodes WHERE id = ?";
		const before = counter.compiles();
		const statements = new Set<unknown>();
		for (let i = 0; i < 25; i += 1) statements.add(db.prepare(sql));
		assert.equal(statements.size, 1, "25 prepares of one SQL must yield one statement object");
		assert.equal(counter.compiles() - before, 1, "25 prepares of one SQL must compile exactly once");
		assert.equal(legionStatementCacheSize(db), baseSize + 1);

		const other = db.prepare("SELECT * FROM nodes WHERE parent_id = ?");
		assert.notEqual(other, db.prepare(sql), "a different SQL must not reuse the first statement");
		assert.equal(counter.compiles() - before, 2, "a second distinct SQL compiles once");
		assert.equal(legionStatementCacheSize(db), baseSize + 2);

		// The cached statement is still fully functional, not a dead handle.
		insertNode(db, { parentId: null, name: "root", role: "root" });
		const byId = db.prepare(sql);
		assert.equal(byId.get("root")?.id, "root");
		assert.equal(byId.get("missing"), undefined);
	} finally {
		db.close();
		counter.restore();
		probe.close();
	}
});

test("every prepare() call still enters the data layer, so call-site counters are unaffected", () => {
	const db = openLegionDb(":memory:");
	try {
		const sql = "SELECT * FROM nodes WHERE id = ?";
		// The shape legion-event-bus.test.ts uses to count prepare() calls: a
		// delegating wrapper that sees every call a call site makes.
		let seen = 0;
		const instrumented: DatabaseSync = {
			exec: (statement) => db.exec(statement),
			prepare(statement) {
				if (statement === sql) seen += 1;
				return db.prepare(statement);
			},
			close: () => db.close(),
		};
		const first = instrumented.prepare(sql);
		const second = instrumented.prepare(sql);
		assert.equal(seen, 2, "the cache must sit inside prepare, so both calls are observed");
		assert.equal(first, second, "yet both calls are served by one compiled statement");
	} finally {
		db.close();
	}
});

test("statements cache per connection, not globally", () => {
	const one = openLegionDb(":memory:");
	const two = openLegionDb(":memory:");
	try {
		const sql = "SELECT 1 AS one";
		const baseOne = legionStatementCacheSize(one);
		const baseTwo = legionStatementCacheSize(two);
		const fromOne = one.prepare(sql);
		// A module-level cache would hand connection two a statement bound to one;
		// it would then throw "statement has been finalized" once `one` closes.
		assert.notEqual(two.prepare(sql), fromOne, "connections must not share compiled statements");
		assert.equal(legionStatementCacheSize(one), baseOne + 1);
		assert.equal(legionStatementCacheSize(two), baseTwo + 1);

		one.close();
		assert.equal(legionStatementCacheSize(one), 0, "closing a connection releases its cache");
		assert.equal(legionStatementCacheSize(two), baseTwo + 1, "closing one connection leaves the other intact");
		assert.equal(Number(two.prepare(sql).get()?.one), 1, "the surviving connection still works");
	} finally {
		closeQuietly(one);
		two.close();
	}
});

test("the cache is bounded at LEGION_STMT_CACHE_LIMIT and evicts least-recently-used", () => {
	const db = openLegionDb(":memory:");
	const sqlFor = (i: number): string => `SELECT ${i} AS pick`;
	try {
		const originals = new Map<number, unknown>();
		for (let i = 0; i < LEGION_STMT_CACHE_LIMIT; i += 1) {
			originals.set(i, db.prepare(sqlFor(i)));
		}
		assert.equal(legionStatementCacheSize(db), LEGION_STMT_CACHE_LIMIT, "fills to the cap");

		// Touch the OLDEST entry. Insertion order alone (FIFO) would still evict
		// entry 0 next; only a real LRU promotes it and evicts entry 1 instead.
		assert.equal(db.prepare(sqlFor(0)), originals.get(0), "a hit returns the cached statement");

		db.prepare(sqlFor(LEGION_STMT_CACHE_LIMIT));
		assert.equal(
			legionStatementCacheSize(db),
			LEGION_STMT_CACHE_LIMIT,
			`inserting past ${LEGION_STMT_CACHE_LIMIT} distinct SQL strings must not grow the cache`,
		);
		assert.equal(
			db.prepare(sqlFor(0)),
			originals.get(0),
			"the touched (previously oldest) entry survived: the cache is LRU, not insertion-ordered",
		);
		assert.notEqual(
			db.prepare(sqlFor(1)),
			originals.get(1),
			"the now least-recently-used entry was evicted, so its SQL recompiles",
		);
		assert.equal(legionStatementCacheSize(db), LEGION_STMT_CACHE_LIMIT, "still bounded after churn");
	} finally {
		db.close();
	}
});

test("cached statements re-execute: rows and PRAGMAs track committed state", () => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "legion-stmt-cache-"));
	const file = path.join(directory, "legion.db");
	const reader = openLegionDb(file);
	const writer = openLegionDb(file);
	try {
		const count = reader.prepare("SELECT COUNT(*) AS n FROM events");
		assert.equal(Number(count.get()?.n), 0);
		appendEvent(writer, "root", "node_launched", null, { now: () => 1 });
		// Same statement object, new execution: a cache that cached *results*
		// would report 0 here and silently stale every reader.
		assert.equal(Number(count.get()?.n), 1, "a cached statement must re-execute against new commits");

		const dataVersion = reader.prepare("PRAGMA data_version");
		const before = Number(dataVersion.get()?.data_version);
		appendEvent(writer, "root", "node_settled", null, { now: () => 2 });
		assert.ok(
			Number(dataVersion.get()?.data_version) > before,
			"a cached PRAGMA statement must still re-read the current value",
		);
	} finally {
		reader.close();
		writer.close();
		fs.rmSync(directory, { recursive: true, force: true });
	}
});

test("close() releases cached statements and keeps the driver's close semantics", () => {
	const db = openLegionDb(":memory:");
	const baseSize = legionStatementCacheSize(db);
	const statement = db.prepare("SELECT 1 AS one");
	assert.equal(legionStatementCacheSize(db), baseSize + 1);
	db.close();
	assert.equal(legionStatementCacheSize(db), 0, "close() must not leave the cache holding statements");
	// The driver finalizes live statements on close; the cache must not hide that
	// by keeping a usable-looking handle around.
	assert.throws(() => statement.get(), /finalized|not open/i);
	assert.throws(() => db.prepare("SELECT 1 AS one"), /not open/i);
	assert.throws(() => db.close(), /not open/i, "double close still surfaces the driver error");
});
