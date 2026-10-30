import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	LEGION_DB_BUSY_TIMEOUT_MS,
	LEGION_DB_USER_VERSION,
	assertLegionJournalMode,
	legionDbPath,
	openLegionDb,
	sqliteHasRow,
} from "../../src/legion/db.ts";
import { insertNode } from "../../src/legion/nodes.ts";

const TABLE_COLUMNS = {
	nodes: ["id", "parent_id", "name", "role", "kind", "depth", "run_id", "session_file", "worktree_path", "model", "team", "status", "phase", "phase_since", "rework_count", "contract_path", "task_summary", "created_at", "updated_at"],
	events: ["id", "node_id", "type", "data", "ts"],
	usage: ["node_id", "tokens_in", "tokens_out", "cost_usd", "updated_at"],
	messages: ["id", "from_node", "to_node", "subject", "body", "kind", "urgency", "delivered", "delivered_at", "created_at"],
} as const;

const INDEX_COLUMNS = {
	idx_nodes_parent: ["parent_id"],
	idx_nodes_status: ["status", "updated_at"],
	idx_events_node: ["node_id", "id"],
	idx_events_type_ts: ["type", "ts"],
	idx_messages_inbox: ["to_node", "delivered", "id"],
	idx_messages_rate: ["from_node", "created_at"],
} as const;

test("legion db schema snapshot matches contract columns and indexes (v2)", () => {
	const db = openLegionDb(":memory:");
	try {
		assert.equal(Number(db.prepare("PRAGMA user_version").get()?.user_version), LEGION_DB_USER_VERSION);
		for (const [table, expected] of Object.entries(TABLE_COLUMNS)) {
			const actual = db.prepare(`PRAGMA table_info(${table})`).all().map((row) => String(row.name));
			assert.deepEqual(actual, expected, `${table} columns changed`);
		}
		const indexes = new Map<string, string[]>();
		for (const table of Object.keys(TABLE_COLUMNS)) {
			for (const index of db.prepare(`PRAGMA index_list(${table})`).all()) {
				const indexName = String(index.name);
				if (indexName.startsWith("sqlite_autoindex_")) continue;
				indexes.set(indexName, db.prepare(`PRAGMA index_info(${indexName})`).all().map((column) => String(column.name)));
			}
		}
		assert.deepEqual(Object.fromEntries(indexes), INDEX_COLUMNS);
		assert.equal(Number(db.prepare("PRAGMA foreign_keys").get()?.foreign_keys), 1);
	} finally {
		db.close();
	}
});

test("legion db uses WAL and contract busy timeout and resolves run path", () => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "legion-db-"));
	const file = legionDbPath(path.join(directory, "root-run"));
	const db = openLegionDb(file);
	try {
		assert.equal(db.prepare("PRAGMA journal_mode").get()?.journal_mode, "wal");
		assert.equal(Number(db.prepare("PRAGMA busy_timeout").get()?.timeout), LEGION_DB_BUSY_TIMEOUT_MS);
		assert.ok(fs.existsSync(file));
	} finally {
		db.close();
		fs.rmSync(directory, { recursive: true, force: true });
	}
});

/**
 * The WAL precondition exists because `PRAGMA journal_mode = WAL` can decline
 * without raising. A fixture that reliably reproduces that decline does not
 * exist for `node:sqlite`: every candidate we probed (read-only directory, a
 * directory squatting `<db>-wal` or `<db>-shm`, a writer holding a conflicting
 * lock) either still reached `wal` or threw straight out of the driver, which is
 * precisely the failure the precondition is meant to *replace*. Those paths are
 * therefore covered by injecting the observed mode into the validation seam
 * instead of pretending a real fixture exists, and the half that can be pinned
 * for real — that `openLegionDb` actually routes the driver's answer through
 * that seam — is pinned below by driving a genuine `:memory:` connection, whose
 * mode is `memory` and never `wal`, through `openLegionDb` itself.
 */
test("journal mode validation refuses any mode but wal", () => {
	for (const mode of ["delete", "truncate", "persist", "memory", "off", "", "WAL"]) {
		assert.throws(
			() => assertLegionJournalMode(mode, false, "/tmp/ledger.db"),
			/\/tmp\/ledger\.db is not in WAL mode/,
			`a file database reporting ${JSON.stringify(mode)} must be refused`,
		);
	}
	// Refusal is not a stylistic complaint: the message must carry the value the
	// driver actually reported, or the startup failure cannot be diagnosed.
	assert.throws(
		() => assertLegionJournalMode("delete", false, "/tmp/ledger.db"),
		/reported "delete" \(expected "wal"\)/,
	);
	// An absent answer is a refusal too, never a pass: `undefined`/`null` mean the
	// driver gave us nothing to verify, which is the assumption this check exists
	// to remove.
	assert.throws(() => assertLegionJournalMode(undefined, false), /reported "undefined"/);
	assert.throws(() => assertLegionJournalMode(null, false), /reported "null"/);
	// ...and the accepting side, pinned to the exact token SQLite returns. The
	// comparison is case-sensitive, so lowercase `wal` passes while the
	// capitalised `WAL` in the rejection list above does not — which matches the
	// driver, since SQLite always reports the lowercase token.
	assert.doesNotThrow(() => assertLegionJournalMode("wal", false));
});

test("a file database is held to the WAL precondition", () => {
	// Guard against over-generalising the in-memory exemption below: `memory` is
	// only tolerable when `main` really is a memory database.
	assert.throws(
		() => assertLegionJournalMode("memory", false, "/tmp/ledger.db"),
		/a file database|reported "memory"/,
	);
});

/**
 * Force the driver to report a non-WAL journal mode, so the *wiring* of the
 * precondition can be tested on a file database.
 *
 * This is deliberately not a filesystem fixture. Probing `node:sqlite` for a
 * mount or permission that leaves `PRAGMA journal_mode = WAL` quietly on a
 * rollback journal produced none: a read-only directory, a directory squatting
 * `<db>-wal` / `<db>-shm`, and a competing writer holding a lock each either
 * still reached `wal` or threw straight out of the driver — the very crash the
 * precondition exists to turn into a diagnosable startup error. The portability
 * that matters here is therefore pinned where it is real: at the driver seam.
 *
 * Returns `null` when the driver's `prepare` is not patchable, matching how
 * `legion-statement-cache.test.ts` skips.
 */
function reportJournalMode(probe: { prepare(sql: string): unknown }, reported: string) {
	const prototype = Object.getPrototypeOf(probe) as {
		prepare: (sql: string) => { get(): unknown };
	};
	const descriptor = Object.getOwnPropertyDescriptor(prototype, "prepare");
	if (!descriptor?.configurable) return null;
	const original = prototype.prepare;
	prototype.prepare = function patched(this: unknown, sql: string) {
		const statement = original.call(this, sql);
		if (!sql.includes("journal_mode = WAL")) return statement;
		return { get: () => ({ journal_mode: reported }) };
	};
	return () => {
		prototype.prepare = original;
	};
}

test("openLegionDb fails loudly when a file database reports a non-WAL journal mode", (t) => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "legion-wal-refused-"));
	const file = path.join(directory, "ledger.db");
	const probe = openLegionDb(file);
	const restore = reportJournalMode(probe, "delete");
	probe.close();
	if (!restore) {
		fs.rmSync(directory, { recursive: true, force: true });
		t.skip("driver prepare() is not instrumentable");
		return;
	}
	try {
		// The assertion that guards the defect: a real file database whose PRAGMA
		// answer is not `wal` must throw from openLegionDb, not be handed back.
		assert.throws(
			() => openLegionDb(file),
			/is not in WAL mode: PRAGMA journal_mode = WAL reported "delete" \(expected "wal"\)/,
			"a file database that did not reach WAL must fail at open, loudly",
		);
	} finally {
		restore();
	}
	// Causality, stated so the test cannot pass for the wrong reason: with the
	// driver answering honestly again, the same file opens fine.
	const reopened = openLegionDb(file);
	try {
		assert.equal(reopened.prepare("PRAGMA journal_mode").get()?.journal_mode, "wal");
	} finally {
		reopened.close();
		fs.rmSync(directory, { recursive: true, force: true });
	}
});

test("openLegionDb does not hold an in-memory database to the WAL precondition", () => {
	// SQLite does not implement WAL for in-memory databases and reports `memory`
	// forever. That is benign — the database cannot outlive the process — and it is
	// the one non-WAL answer openLegionDb is expected to accept. 41 unit-test call
	// sites depend on it, so a blanket `!== "wal"` throw would take the suite down.
	const db = openLegionDb(":memory:");
	try {
		assert.equal(db.prepare("PRAGMA journal_mode").get()?.journal_mode, "memory");
		assert.equal(
			db.prepare("PRAGMA database_list").get()?.file,
			"",
			"an in-memory `main` reports an empty file — that is the signal the exemption keys on",
		);
	} finally {
		db.close();
	}
});

test("legion db rejects newer versions and migrates a fresh version-zero database", () => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "legion-db-version-"));
	const file = path.join(directory, "ledger.db");
	const migrated = openLegionDb(file);
	try {
		assert.equal(Number(migrated.prepare("PRAGMA user_version").get()?.user_version), LEGION_DB_USER_VERSION);
		migrated.exec(`PRAGMA user_version = ${LEGION_DB_USER_VERSION + 1};`);
	} finally {
		migrated.close();
	}
	try {
		assert.throws(() => openLegionDb(file), /newer than supported/);
	} finally {
		fs.rmSync(directory, { recursive: true, force: true });
	}
});

test("WAL busy handler retries successfully after the competing supervisor releases its lock", () => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "legion-wal-busy-"));
	const file = path.join(directory, "ledger.db");
	const parent = openLegionDb(file);
	const child = openLegionDb(file);
	try {
		insertNode(parent, { parentId: null, name: "root", role: "root" });
		parent.exec("BEGIN IMMEDIATE;");
		child.exec("PRAGMA busy_timeout = 25;");
		assert.throws(
			() => insertNode(child, { parentId: "root", name: "blocked", role: "worker" }),
			/database is locked|SQLITE_BUSY/i,
		);
		parent.exec("COMMIT;");
		assert.equal(insertNode(child, { parentId: "root", name: "retry", role: "worker" }).id, "root.retry");
	} finally {
		try { parent.exec("ROLLBACK;"); } catch { /* lock already released */ }
		parent.close();
		child.close();
		fs.rmSync(directory, { recursive: true, force: true });
	}
});

test("sqliteHasRow treats Bun null and Node undefined as miss", () => {
	assert.equal(sqliteHasRow(undefined), false);
	assert.equal(sqliteHasRow(null), false);
	assert.equal(sqliteHasRow({ found: 1 }), true);
});

test("a v1 ledger opens as schema v2 without rewriting a single row (#322)", () => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "legion-db-v1-v2-"));
	const file = path.join(directory, "ledger.db");
	try {
		const v1 = openLegionDb(file);
		try {
			insertNode(v1, { parentId: null, name: "root", role: "root" });
			insertNode(v1, { parentId: "root", name: "team", role: "centurion" });
			// A v1 row: `delivered = 1` meant "the send call returned".
			v1.prepare(
				`INSERT INTO messages (from_node, to_node, subject, body, kind, urgency, delivered, created_at)
				 VALUES (?, ?, ?, ?, 'notice', 'action-needed', 1, ?)`,
			).run("root.team", "root", "queued before v2", "body kept byte for byte", 12);
			// Rewind the header so the file looks like one written before v2 existed. v2
			// adds no DDL — it only widens the meaning of `delivered` — so this is exactly
			// what an old ledger on disk looks like.
			v1.exec("PRAGMA user_version = 1;");
			assert.equal(Number(v1.prepare("PRAGMA user_version").get()?.user_version), 1);
		} finally {
			v1.close();
		}

		const upgraded = openLegionDb(file);
		try {
			assert.equal(LEGION_DB_USER_VERSION, 2);
			assert.equal(Number(upgraded.prepare("PRAGMA user_version").get()?.user_version), 2, "opening upgrades v1 to v2");
			const row = upgraded.prepare("SELECT * FROM messages").get();
			assert.equal(Number(row?.delivered), 1, "the old 1 keeps its value and now reads as ACCEPTED");
			assert.equal(String(row?.subject), "queued before v2");
			assert.equal(String(row?.body), "body kept byte for byte");
			assert.equal(Number(row?.created_at), 12);
			assert.equal(Number(row?.delivered_at), 0, "delivered_at is still NULL for an untouched row");
			assert.deepEqual(
				upgraded.prepare("PRAGMA table_info(messages)").all().map((info) => String(info.name)),
				[...TABLE_COLUMNS.messages],
				"v1 → v2 changes no columns",
			);
		} finally {
			upgraded.close();
		}
	} finally {
		fs.rmSync(directory, { recursive: true, force: true });
	}
});
