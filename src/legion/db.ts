import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";

export const LEGION_DB_USER_VERSION = 1;
export const LEGION_DB_BUSY_TIMEOUT_MS = 5_000;

/**
 * Bound on one connection's compiled-statement cache.
 *
 * The ledger has ~29 distinct static SQL texts behind the 46 `prepare()` call
 * sites (many sites share a text), plus a handful of dynamically-shaped
 * families — `usage.ts`'s chunked `IN (?,?,…)` (stable chunk length at runtime)
 * and `hygiene.ts`'s retention `NOT IN (…)` lists. 64 holds everything a
 * connection reuses with 2x headroom, while an unbounded map keyed on SQL text
 * would grow with every distinct chunk size ever requested.
 */
export const LEGION_STMT_CACHE_LIMIT = 64;

export type SqliteBindValue = string | number | bigint | null | Uint8Array;
export type SqliteRow = Record<string, string | number | bigint | null | Uint8Array>;

export interface LegionStatementSync {
	/**
	 * Fetch one row. Node's `node:sqlite` returns `undefined` on a miss;
	 * Bun's `bun:sqlite` returns `null`. Callers must treat both as absent
	 * (see {@link sqliteHasRow}).
	 */
	get(...parameters: SqliteBindValue[]): SqliteRow | null | undefined;
	all(...parameters: SqliteBindValue[]): SqliteRow[];
	run(...parameters: SqliteBindValue[]): {
		changes: number | bigint;
		lastInsertRowid: number | bigint;
	};
}

/** Minimal synchronous SQL interface shared by Bun and Node SQLite drivers. */
export interface DatabaseSync {
	exec(sql: string): void;
	prepare(sql: string): LegionStatementSync;
	close(): void;
}

type SqliteDatabaseConstructor = new (dbPath: string) => DatabaseSync;
type SqliteModule = Record<string, unknown>;
type SqliteDriver = {
	id: "bun:sqlite" | "node:sqlite";
	constructorName: "Database" | "DatabaseSync";
};
const SQLITE_DRIVERS: readonly SqliteDriver[] = [
	{ id: "bun:sqlite", constructorName: "Database" },
	{ id: "node:sqlite", constructorName: "DatabaseSync" },
];
let cachedSqliteConstructor: SqliteDatabaseConstructor | null | undefined;
const transactionDepth = new WeakMap<DatabaseSync, number>();
const statementCaches = new WeakMap<DatabaseSync, Map<string, LegionStatementSync>>();
let savepointSequence = 0;

const SCHEMA_V1 = `
CREATE TABLE nodes (
  id            TEXT PRIMARY KEY,
  parent_id     TEXT REFERENCES nodes(id),
  name          TEXT NOT NULL,
  role          TEXT NOT NULL,
  kind          TEXT NOT NULL DEFAULT 'pi',
  depth         INTEGER NOT NULL,
  run_id        TEXT,
  session_file  TEXT,
  worktree_path TEXT,
  model         TEXT,
  team          TEXT,
  status        TEXT NOT NULL,
  phase         TEXT,
  phase_since   INTEGER,
  rework_count  INTEGER NOT NULL DEFAULT 0,
  contract_path TEXT,
  task_summary  TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX idx_nodes_parent ON nodes(parent_id);
CREATE INDEX idx_nodes_status ON nodes(status, updated_at);

CREATE TABLE events (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  node_id TEXT NOT NULL,
  type    TEXT NOT NULL,
  data    TEXT,
  ts      INTEGER NOT NULL
);
CREATE INDEX idx_events_node ON events(node_id, id);
CREATE INDEX idx_events_type_ts ON events(type, ts);

CREATE TABLE usage (
  node_id    TEXT PRIMARY KEY REFERENCES nodes(id),
  tokens_in  INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  cost_usd  REAL NOT NULL DEFAULT 0,
  updated_at INTEGER
);

CREATE TABLE messages (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  from_node    TEXT NOT NULL,
  to_node      TEXT NOT NULL,
  subject      TEXT NOT NULL,
  body         TEXT NOT NULL,
  kind         TEXT,
  urgency      TEXT NOT NULL DEFAULT 'info',
  delivered    INTEGER NOT NULL DEFAULT 0,
  delivered_at INTEGER,
  created_at   INTEGER NOT NULL
);
CREATE INDEX idx_messages_inbox ON messages(to_node, delivered, id);
`;

/**
 * True when a prepared-statement `.get()` returned a real row.
 * Bun returns `null` for no match; Node returns `undefined` — both are misses.
 */
export function sqliteHasRow(row: SqliteRow | null | undefined): boolean {
	return row != null;
}

/** Resolve the tree ledger location specified by contract §4.1. */
export function legionDbPath(rootRunDir: string): string {
	if (typeof rootRunDir !== "string" || rootRunDir.trim().length === 0) {
		throw new TypeError("rootRunDir must be a non-empty path");
	}
	return path.join(rootRunDir, "legion.db");
}

/**
 * Open one supervisor's connection to the shared tree ledger. SQLite is loaded
 * lazily so importing the extension does not require a driver until v2 is used.
 */
export function openLegionDb(dbPath: string): DatabaseSync {
	if (typeof dbPath !== "string" || dbPath.trim().length === 0) {
		throw new TypeError("dbPath must be a non-empty path");
	}
	if (dbPath !== ":memory:") {
		fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
	}
	const Database = sqliteDatabaseConstructor();
	const db = new Database(dbPath);
	try {
		// Compiled statements are reused for every one of the call sites above.
		attachStatementCache(db);
		db.exec(`PRAGMA busy_timeout = ${LEGION_DB_BUSY_TIMEOUT_MS};`);
		db.exec("PRAGMA foreign_keys = ON;");
		db.exec("PRAGMA journal_mode = WAL;");
		migrate(db);
		return db;
	} catch (error) {
		db.close();
		throw error;
	}
}

/**
 * Serve every `prepare()` on this connection from a bounded per-connection LRU.
 *
 * The cache sits *inside* `prepare` rather than at the call sites: each call
 * still enters the data layer (so instrumentation that counts
 * `prepare(sql)` keeps counting), and all call sites get the reuse for free.
 *
 * A compiled statement is reusable — `.get()`/`.all()`/`.run()` re-execute it
 * with the new bindings, cached `PRAGMA` statements re-read the current value,
 * and a statement survives `ALTER`/`VACUUM` on the same connection. Statements
 * are keyed on the exact SQL text: two texts that differ only in whitespace are
 * deliberately two entries, because SQL text is the only identity SQLite offers.
 */
function attachStatementCache(db: DatabaseSync): void {
	if (statementCaches.has(db)) return;
	const prepare = db.prepare;
	const close = db.close;
	const cache = new Map<string, LegionStatementSync>();
	statementCaches.set(db, cache);
	db.prepare = (sql: string): LegionStatementSync => {
		const cached = cache.get(sql);
		if (cached) {
			// Re-insert so Map order stays least-recently-used first.
			cache.delete(sql);
			cache.set(sql, cached);
			return cached;
		}
		const statement = prepare.call(db, sql);
		cache.set(sql, statement);
		if (cache.size > LEGION_STMT_CACHE_LIMIT) {
			const oldest = cache.keys().next();
			if (!oldest.done) cache.delete(oldest.value);
		}
		return statement;
	};
	db.close = (): void => {
		// Drop our references before the driver finalizes them, so the cache
		// cannot outlive the connection and nothing is released twice.
		cache.clear();
		statementCaches.delete(db);
		close.call(db);
	};
}

/** Compiled statements a connection currently holds; 0 once it is closed. */
export function legionStatementCacheSize(db: DatabaseSync): number {
	return statementCaches.get(db)?.size ?? 0;
}

/** Run a short synchronous write transaction. Nested ledger helpers use savepoints. */
export function withTransaction<T>(db: DatabaseSync, run: () => T): T {
	const depth = transactionDepth.get(db) ?? 0;
	const savepoint = depth > 0 ? `legion_nested_${++savepointSequence}` : null;
	db.exec(savepoint ? `SAVEPOINT ${savepoint};` : "BEGIN IMMEDIATE;");
	transactionDepth.set(db, depth + 1);
	try {
		const result = run();
		db.exec(savepoint ? `RELEASE SAVEPOINT ${savepoint};` : "COMMIT;");
		return result;
	} catch (error) {
		try {
			if (savepoint) {
				db.exec(`ROLLBACK TO SAVEPOINT ${savepoint};`);
				db.exec(`RELEASE SAVEPOINT ${savepoint};`);
			} else {
				db.exec("ROLLBACK;");
			}
		} catch {
			// Preserve the original error if SQLite has already ended the transaction.
		}
		throw error;
	} finally {
		if (depth === 0) transactionDepth.delete(db);
		else transactionDepth.set(db, depth);
	}
}

function migrate(db: DatabaseSync): void {
	let version = readUserVersion(db);
	if (version > LEGION_DB_USER_VERSION) {
		throw new Error(
			`legion.db schema version ${version} is newer than supported version ${LEGION_DB_USER_VERSION}`,
		);
	}
	if (version === LEGION_DB_USER_VERSION) return;

	db.exec("BEGIN IMMEDIATE;");
	try {
		// A supervisor can wait here while another connection creates schema v1.
		version = readUserVersion(db);
		if (version > LEGION_DB_USER_VERSION) {
			throw new Error(
				`legion.db schema version ${version} is newer than supported version ${LEGION_DB_USER_VERSION}`,
			);
		}
		if (version === 0) {
			db.exec(SCHEMA_V1);
			db.exec(`PRAGMA user_version = ${LEGION_DB_USER_VERSION};`);
		}
		db.exec("COMMIT;");
	} catch (error) {
		try {
			db.exec("ROLLBACK;");
		} catch {
			// Preserve the original migration error.
		}
		throw error;
	}
}

function sqliteDatabaseConstructor(): SqliteDatabaseConstructor {
	if (cachedSqliteConstructor) return cachedSqliteConstructor;
	let required: (id: string) => SqliteModule;
	try {
		required = createRequire(import.meta.url) as (id: string) => SqliteModule;
	} catch (error) {
		throw new Error("cannot create a lazy require for the SQLite driver", { cause: error });
	}
	const bunRuntime = (globalThis as typeof globalThis & { Bun?: unknown }).Bun;
	const orderedDrivers = bunRuntime ? SQLITE_DRIVERS : [...SQLITE_DRIVERS].reverse();
	const failures: Error[] = [];
	for (const driver of orderedDrivers) {
		let moduleValue: SqliteModule;
		try {
			moduleValue = required(driver.id);
		} catch (error) {
			failures.push(new Error(`SQLite driver ${driver.id} is unavailable`, { cause: error }));
			continue;
		}
		const constructor = moduleValue[driver.constructorName];
		if (typeof constructor !== "function") {
			failures.push(
				new TypeError(`SQLite driver ${driver.id} does not export ${driver.constructorName}`),
			);
			continue;
		}
		cachedSqliteConstructor = constructor as SqliteDatabaseConstructor;
		return cachedSqliteConstructor;
	}
	cachedSqliteConstructor = null;
	throw new AggregateError(failures, "no supported synchronous SQLite driver is available");
}

function readUserVersion(db: DatabaseSync): number {
	const row = db.prepare("PRAGMA user_version;").get();
	return Number(row?.user_version ?? 0);
}
