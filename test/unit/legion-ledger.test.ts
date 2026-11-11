import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { LEGION_DB_USER_VERSION, openLegionDb } from "../../src/legion/db.ts";
import type { DatabaseSync } from "../../src/legion/db.ts";
import {
	artifactById,
	consumptionFor,
	hasRead,
	listArtifacts,
	markNotified,
	markRead,
	recordArtifact,
	undelivered,
} from "../../src/legion/ledger.ts";
import type { NewArtifact } from "../../src/legion/ledger.ts";

function artifact(overrides: Partial<NewArtifact> = {}): NewArtifact {
	return {
		id: "r-1/scout-a/r1",
		parentId: "root",
		nodeId: "root.scout-a",
		name: "scout-a",
		round: 1,
		path: "/tmp/runs/r-1/artifacts/scout-a/r1.md",
		bytes: 1_000,
		createdAt: 1_700_000_000_000,
		...overrides,
	};
}

function withDb(run: (db: DatabaseSync) => void): void {
	const db = openLegionDb(":memory:");
	try {
		run(db);
	} finally {
		db.close();
	}
}

test("recordArtifact is idempotent and never rewrites an existing artifact row (A1b)", () => {
	withDb((db) => {
		recordArtifact(db, artifact());
		// A replay must not update: `INSERT OR REPLACE` here would let `bytes` shrink,
		// flip `read_bytes >= bytes` early and silently drop a notice.
		recordArtifact(db, artifact({ bytes: 2_048, path: "/tmp/runs/r-1/artifacts/scout-a/r1-changed.md" }));

		const rows = listArtifacts(db, "root");
		assert.equal(rows.length, 1, "writing the same artifact id twice must leave exactly one row");
		assert.equal(artifactById(db, "r-1/scout-a/r1")?.bytes, 1_000, "the replay does not change the row");
		assert.equal(
			artifactById(db, "r-1/scout-a/r1")?.path,
			"/tmp/runs/r-1/artifacts/scout-a/r1.md",
			"identity is immutable: the first write wins",
		);
		assert.equal(
			Number(db.prepare("SELECT COUNT(*) AS n FROM artifacts").get()?.n),
			1,
			"no duplicate row appears in the table",
		);
	});
});

test("recordArtifact rejects a zero-byte artifact (A1: an empty output is not an artifact)", () => {
	withDb((db) => {
		assert.throws(() => recordArtifact(db, artifact({ bytes: 0 })), /bytes must be a positive safe integer/);
		assert.throws(() => recordArtifact(db, artifact({ bytes: -1 })), /bytes must be a positive safe integer/);
		assert.equal(listArtifacts(db, "root").length, 0, "nothing was written");
	});
});

test("markRead keeps read_bytes as a high-water mark and records the latest read", () => {
	withDb((db) => {
		recordArtifact(db, artifact());
		markRead(db, { artifactId: "r-1/scout-a/r1", consumerId: "root", bytesRead: 500, at: 10 });
		assert.equal(consumptionFor(db, "r-1/scout-a/r1", "root")?.readBytes, 500);
		assert.equal(consumptionFor(db, "r-1/scout-a/r1", "root")?.readAt, 10);

		markRead(db, { artifactId: "r-1/scout-a/r1", consumerId: "root", bytesRead: 1_200, at: 20 });
		assert.equal(consumptionFor(db, "r-1/scout-a/r1", "root")?.readBytes, 1_200);

		// A paging client scrolling back up must not pretend it read less.
		markRead(db, { artifactId: "r-1/scout-a/r1", consumerId: "root", bytesRead: 500, at: 30 });
		const consumption = consumptionFor(db, "r-1/scout-a/r1", "root");
		assert.equal(consumption?.readBytes, 1_200, "read_bytes only ever grows");
		assert.equal(consumption?.readAt, 30, "read_at tracks the latest attempt");
		assert.equal(consumption?.notifiedAt, null, "reading never writes notified_at");
		assert.equal(
			Number(db.prepare("SELECT COUNT(*) AS n FROM consumptions").get()?.n),
			1,
			"one row per (artifact, consumer), not one per read",
		);
	});
});

test("markNotified is write-once: a replayed delivery keeps the first timestamp", () => {
	withDb((db) => {
		recordArtifact(db, artifact());
		markNotified(db, { artifactId: "r-1/scout-a/r1", consumerId: "root", at: 40 });
		assert.equal(consumptionFor(db, "r-1/scout-a/r1", "root")?.notifiedAt, 40);

		markNotified(db, { artifactId: "r-1/scout-a/r1", consumerId: "root", at: 99 });
		assert.equal(consumptionFor(db, "r-1/scout-a/r1", "root")?.notifiedAt, 40, "notified_at is never moved");

		// And a later read does not clear it either (the two facts are orthogonal).
		markRead(db, { artifactId: "r-1/scout-a/r1", consumerId: "root", bytesRead: 1_000, at: 120 });
		assert.equal(consumptionFor(db, "r-1/scout-a/r1", "root")?.notifiedAt, 40, "reading leaves notified_at alone");
		assert.equal(consumptionFor(db, "r-1/scout-a/r1", "root")?.readBytes, 1_000);
	});
});

test("undelivered returns unread and half-read artifacts, and drops notified or fully-read ones", () => {
	withDb((db) => {
		recordArtifact(db, artifact({ id: "r-1/unread/r1", name: "unread", nodeId: "root.unread", createdAt: 1 }));
		recordArtifact(db, artifact({ id: "r-1/half/r1", name: "half", nodeId: "root.half", createdAt: 2 }));
		recordArtifact(db, artifact({ id: "r-1/read/r1", name: "read", nodeId: "root.read", createdAt: 3 }));
		recordArtifact(db, artifact({ id: "r-1/notified/r1", name: "notified", nodeId: "root.notified", createdAt: 4 }));

		markRead(db, { artifactId: "r-1/half/r1", consumerId: "root", bytesRead: 999, at: 10 });
		markRead(db, { artifactId: "r-1/read/r1", consumerId: "root", bytesRead: 1_000, at: 10 });
		markNotified(db, { artifactId: "r-1/notified/r1", consumerId: "root", at: 10 });

		const ids = undelivered(db, "root").map((row) => row.id);
		assert.deepEqual(
			ids,
			["r-1/unread/r1", "r-1/half/r1"],
			"a partial read suppresses nothing (D6); only full coverage or an existing notice does",
		);

		// `parent_id` scopes the projection (contract D2, P1 review critical #1):
		// none of those artifacts belong to `root.team`, so it must be handed nothing.
		assert.deepEqual(
			undelivered(db, "root.team"),
			[],
			"a consumer never receives another consumer's artifacts",
		);
		assert.deepEqual(
			undelivered(db, "nobody"),
			[],
			"an unknown consumer sees an empty projection, not the whole ledger",
		);

		// Positive control: the same consumer DOES get its own unread artifact, so the
		// two empty results above are not an artifact of a broken query.
		recordArtifact(
			db,
			artifact({ id: "r-1/team-child/r1", name: "team-child", nodeId: "root.team.team-child", parentId: "root.team", createdAt: 5 }),
		);
		assert.deepEqual(
			undelivered(db, "root.team").map((row) => row.id),
			["r-1/team-child/r1"],
			"the consumer's own unread artifact is still delivered to it",
		);
		assert.equal(undelivered(db, "root").length, 2, "and it does not leak into the other consumer");
	});
});

test("undelivered is stable-ordered by created_at then id", () => {
	withDb((db) => {
		recordArtifact(db, artifact({ id: "r-1/b/r2", name: "b", nodeId: "root.b", round: 2, createdAt: 50 }));
		recordArtifact(db, artifact({ id: "r-1/a/r1", name: "a", nodeId: "root.a", createdAt: 50 }));
		recordArtifact(db, artifact({ id: "r-1/older/r1", name: "older", nodeId: "root.older", createdAt: 10 }));
		assert.deepEqual(
			undelivered(db, "root").map((row) => row.id),
			["r-1/older/r1", "r-1/a/r1", "r-1/b/r2"],
			"created_at ASC, id ASC — paging through the projection must not reshuffle",
		);
	});
});

test("undelivered is served by idx_artifacts_parent, not a full scan (contract §7-10)", () => {
	withDb((db) => {
		recordArtifact(db, artifact());
		const projection = captureProjectionSql(db, "root");
		const plan = db
			.prepare(`EXPLAIN QUERY PLAN ${projection}`)
			.all("root", "root")
			.map((row) => String(row.detail));
		const detail = plan.join("\n");
		assert.match(
			detail,
			/USING\s+INDEX\s+idx_artifacts_parent/,
			`the projection must be served by (parent_id, created_at); plan was:\n${detail}`,
		);
		assert.doesNotMatch(
			detail,
			/\bSCAN\s+(?:artifacts|a\b)/i,
			`the projection must not scan the artifacts table; plan was:\n${detail}`,
		);
	});
});

/**
 * The exact SQL `undelivered` prepares, captured off the connection so the plan
 * test cannot drift from the shipped query (no hand-copied predicate).
 */
function captureProjectionSql(db: DatabaseSync, consumerId: string): string {
	const original = db.prepare;
	const call = original as (sql: string, ...rest: unknown[]) => ReturnType<DatabaseSync["prepare"]>;
	const prepared: string[] = [];
	db.prepare = ((sql: string, ...rest: unknown[]) => {
		prepared.push(sql);
		return call.call(db, sql, ...rest);
	}) as DatabaseSync["prepare"];
	try {
		undelivered(db, consumerId);
	} finally {
		db.prepare = original;
	}
	const projection = prepared.find((sql) => /FROM\s+artifacts\s+AS\s+a/i.test(sql));
	assert.ok(projection, "undelivered must prepare its projection query");
	return projection;
}

test("a notified consumer that later reads to EOF is not queued again", () => {
	withDb((db) => {
		recordArtifact(db, artifact());
		markNotified(db, { artifactId: "r-1/scout-a/r1", consumerId: "root", at: 10 });
		assert.equal(undelivered(db, "root").length, 0, "notified and partially unread still suppresses: at most one notice");

		markRead(db, { artifactId: "r-1/scout-a/r1", consumerId: "root", bytesRead: 1_000, at: 20 });
		assert.equal(undelivered(db, "root").length, 0, "reading the rest after a notice does not re-notify");
	});
});

test("hasRead flips only at full byte coverage", () => {
	withDb((db) => {
		recordArtifact(db, artifact());
		assert.equal(hasRead(db, "r-1/scout-a/r1", "root"), false, "no consumption row is not a read");
		markRead(db, { artifactId: "r-1/scout-a/r1", consumerId: "root", bytesRead: 999, at: 10 });
		assert.equal(hasRead(db, "r-1/scout-a/r1", "root"), false, "one byte short is not read");
		markRead(db, { artifactId: "r-1/scout-a/r1", consumerId: "root", bytesRead: 1_000, at: 20 });
		assert.equal(hasRead(db, "r-1/scout-a/r1", "root"), true, "full coverage is read");
		assert.equal(hasRead(db, "r-missing/scout-a/r1", "root"), false, "an unknown artifact has nothing to read");
	});
});

test("a v2 ledger opens as v3: the two tables appear and no existing row is lost", () => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "legion-ledger-v2-v3-"));
	const file = path.join(directory, "legion.db");
	try {
		const v3 = openLegionDb(file);
		try {
			v3.prepare(
				`INSERT INTO nodes (id, parent_id, name, role, kind, depth, status, created_at, updated_at)
				 VALUES ('root', NULL, 'root', 'root', 'pi', 0, 'running', 1, 1)`,
			).run();
			v3.prepare(
				`INSERT INTO messages (from_node, to_node, subject, body, kind, urgency, delivered, created_at)
				 VALUES ('root.child', 'root', 'kept before v3', 'body kept byte for byte', 'notice', 'info', 3, 7)`,
			).run();
			// Rewind to a v2 file: the four original tables only, `user_version = 2`.
			// That is exactly what a ledger written before the result ledger exists
			// looks like on disk.
			v3.exec("DROP TABLE consumptions;");
			v3.exec("DROP TABLE artifacts;");
			v3.exec("PRAGMA user_version = 2;");
			assert.equal(Number(v3.prepare("PRAGMA user_version").get()?.user_version), 2);
		} finally {
			v3.close();
		}

		const upgraded = openLegionDb(file);
		try {
			assert.equal(Number(upgraded.prepare("PRAGMA user_version").get()?.user_version), LEGION_DB_USER_VERSION);
			assert.equal(LEGION_DB_USER_VERSION, 3);
			const tables = upgraded
				.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
				.all()
				.map((row) => String(row.name))
				.filter((name) => !name.startsWith("sqlite_"));
			assert.deepEqual(
				tables,
				["artifacts", "consumptions", "events", "messages", "nodes", "usage"],
				"opening a v2 ledger adds the result-ledger tables",
			);
			assert.equal(
				String(upgraded.prepare("SELECT subject FROM messages").get()?.subject),
				"kept before v3",
				"existing rows survive the v2 → v3 migration",
			);
			assert.equal(String(upgraded.prepare("SELECT name FROM nodes WHERE id = 'root'").get()?.name), "root");
			// The index is part of the migration, not just the tables: without it the
			// projection (§7-10) would scan the whole artifacts table.
			assert.deepEqual(
				upgraded
					.prepare("PRAGMA index_list(artifacts)")
					.all()
					.map((row) => String(row.name))
					.filter((name) => !name.startsWith("sqlite_autoindex_")),
				["idx_artifacts_parent"],
				"a migrated v2 ledger also gains idx_artifacts_parent",
			);
			// Idempotent: the tables are usable straight away and re-opening is a no-op.
			recordArtifact(upgraded, artifact());
			assert.equal(listArtifacts(upgraded, "root").length, 1);
		} finally {
			upgraded.close();
		}

		const reopened = openLegionDb(file);
		try {
			assert.equal(Number(reopened.prepare("PRAGMA user_version").get()?.user_version), LEGION_DB_USER_VERSION);
			assert.equal(listArtifacts(reopened, "root").length, 1, "a v3 ledger re-opens without losing artifact rows");
		} finally {
			reopened.close();
		}
	} finally {
		fs.rmSync(directory, { recursive: true, force: true });
	}
});
