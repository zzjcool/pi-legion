import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	LEGION_DB_BUSY_TIMEOUT_MS,
	LEGION_DB_USER_VERSION,
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

test("legion db v1 schema snapshot matches contract columns and indexes", () => {
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
