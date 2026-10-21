/**
 * #237 P9: the per-sender rate-limit COUNT on `messages` must never full-scan.
 *
 * `sendMail` runs this COUNT **inside its write transaction** (the rate gate sits
 * in the same `withTransaction` as the INSERTs). `messages` also has no retention
 * policy — nothing ever deletes from it except `rebuild.ts` when
 * `preserveMessages === false` — so a full scan there gets dearer every minute a
 * squad stays alive, all of it while holding the write lock.
 *
 * This is a QUERY PLAN guard, not a perf number: `test/perf` is not in
 * `.github/workflows/ci.yml`, so a timing-only guard cannot fail a PR. Assert on
 * the plan SQLite actually chose, which is what `idx_messages_rate` buys.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { openLegionDb, type DatabaseSync } from "../../src/legion/db.ts";
import { DEFAULT_MAIL_RATE_PER_5_MIN, MAIL_RATE_WINDOW_MS, sendMail } from "../../src/legion/mail.ts";
import { insertNode } from "../../src/legion/nodes.ts";

/**
 * The exact statement text `sendMail` prepares, kept in sync by
 * `sendMail rate-limit COUNT query keeps its index` below.
 */
const RATE_LIMIT_COUNT_SQL = "SELECT COUNT(*) AS count FROM messages WHERE from_node = ? AND created_at > ?";
const RATE_LIMIT_COUNT_PREFIX = "SELECT COUNT(*) AS count FROM messages";
const WINDOW_START = (now: number) => now - MAIL_RATE_WINDOW_MS;

/**
 * Seed `messages` for `senders` senders. Each sender gets `inWindow` rows inside
 * the rate window and `outOfWindow` rows before it, so the COUNT has to filter
 * on both index columns and the interleaving keeps a scan honest.
 */
function seedSenders(db: DatabaseSync, senders: number, inWindow: number, outOfWindow: number, now: number): void {
	const insert = db.prepare(
		`INSERT INTO messages (from_node, to_node, subject, body, kind, urgency, delivered, created_at)
		 VALUES (?, ?, ?, ?, NULL, 'info', 1, ?)`,
	);
	db.exec("BEGIN IMMEDIATE;");
	try {
		let row = 0;
		for (let sender = 0; sender < senders; sender += 1) {
			for (let n = 0; n < inWindow + outOfWindow; n += 1) {
				// Interleave senders so rows for one `from_node` are spread across the
				// rowid index: a scan has to walk the whole table to find one sender.
				const createdAt = n < inWindow
					? now - MAIL_RATE_WINDOW_MS + 1_000 + n
					: now - MAIL_RATE_WINDOW_MS - 1_000 - n;
				insert.run(`root.w${sender}`, "root", `s${row}`, "body", createdAt);
				row += 1;
			}
		}
		db.exec("COMMIT;");
	} catch (error) {
		db.exec("ROLLBACK;");
		throw error;
	}
}

function queryPlan(db: DatabaseSync, sql: string, ...params: Array<string | number>): string[] {
	return db
		.prepare(`EXPLAIN QUERY PLAN ${sql}`)
		.all(...params)
		.map((row) => String(row.detail));
}

test("mail rate-limit COUNT is served by idx_messages_rate, never a messages scan", () => {
	const db = openLegionDb(":memory:");
	try {
		// 50k rows: the size at which the reported SCAN costs ~3.3ms inside the
		// write transaction. The plan is the same at every size (the optimizer
		// prefers the covering index even on a near-empty table), so this is not
		// a threshold test whose meaning drifts with the row count.
		const now = Date.now();
		seedSenders(db, 200, 5, 245, now);

		const plan = queryPlan(db, RATE_LIMIT_COUNT_SQL, "root.w1", WINDOW_START(now));
		const rendered = plan.join(" | ");

		assert.ok(plan.length > 0, "EXPLAIN QUERY PLAN must report at least one step");
		assert.doesNotMatch(
			rendered,
			/SCAN messages/,
			`the rate-limit COUNT full-scans messages (${rendered}); it must use idx_messages_rate`,
		);
		assert.match(
			rendered,
			/SEARCH messages USING (?:COVERING )?INDEX idx_messages_rate/,
			`expected a SEARCH on idx_messages_rate, got: ${rendered}`,
		);
		// from_node and created_at both live in the index, so the scan-free plan
		// must not need a row fetch either.
		assert.match(rendered, /COVERING INDEX/, `the index should answer the COUNT without fetching rows, got: ${rendered}`);
	} finally {
		db.close();
	}
});

test("mail rate-limit COUNT returns the same rows with and without the index (zero behaviour change)", () => {
	const db = openLegionDb(":memory:");
	try {
		const now = Date.now();
		seedSenders(db, 20, 25, 5, now);
		const senders = ["root.w0", "root.w1", "root.w19", "root.absent"];
		const sample = (): number[] =>
			senders.map((sender) => Number(db.prepare(RATE_LIMIT_COUNT_SQL).get(sender, WINDOW_START(now))?.count ?? -1));

		const withIndex = sample();
		// Drop the index and re-ask: the answer is the plan's only difference.
		db.exec("DROP INDEX idx_messages_rate;");
		assert.doesNotMatch(
			queryPlan(db, RATE_LIMIT_COUNT_SQL, "root.w1", WINDOW_START(now)).join(" | "),
			/idx_messages_rate/,
			"the CONTROL must actually stop using the index, or this test proves nothing",
		);
		const withoutIndex = sample();

		assert.deepEqual(withIndex, withoutIndex, "the rate-limit COUNT result must be identical with and without the index");
		assert.deepEqual(withIndex, [25, 25, 25, 0], "sanity: 25 in-window rows per sender, none for an absent sender");
	} finally {
		db.close();
	}
});

test("sendMail rate-limit COUNT still uses the exact guarded SQL text", () => {
	// Guards against the guard: if mail.ts rewrites its COUNT (different table,
	// extra predicate, subquery), RATE_LIMIT_COUNT_SQL would keep passing while
	// the shipped statement silently drifted.
	const db = openLegionDb(":memory:");
	try {
		const prepared: string[] = [];
		const prepare = db.prepare.bind(db);
		db.prepare = (sql: string) => {
			prepared.push(sql);
			return prepare(sql);
		};
		insertNode(db, { parentId: null, name: "root", role: "root" });
		insertNode(db, { parentId: "root", name: "team-a", role: "centurion" });
		insertNode(db, { parentId: "root.team-a", name: "alice", role: "worker" });
		const sent = sendMail(
			db,
			{ fromNode: "root.team-a", to: "alice", subject: "hi", body: "x" },
			{ now: () => Date.now() },
		);
		assert.equal(sent.ok, true);

		const rateSql = prepared.find((sql) => sql.startsWith(RATE_LIMIT_COUNT_PREFIX));
		assert.ok(rateSql, `sendMail prepared no rate-limit COUNT; prepared: ${JSON.stringify(prepared)}`);
		assert.equal(
			rateSql.replace(/\s+/g, " ").trim(),
			RATE_LIMIT_COUNT_SQL,
			"sendMail's rate-limit COUNT changed; update RATE_LIMIT_COUNT_SQL and the index it depends on",
		);
	} finally {
		db.close();
	}
});

test("mail rate limit still denies the 11th message per sender in the window", () => {
	// D4: the rate gate's semantics are untouched by P9. Re-assert the boundary
	// here so a future index/plan change cannot quietly widen or narrow it.
	const db = openLegionDb(":memory:");
	try {
		insertNode(db, { parentId: null, name: "root", role: "root" });
		insertNode(db, { parentId: "root", name: "team-a", role: "centurion" });
		insertNode(db, { parentId: "root.team-a", name: "alice", role: "worker" });
		for (let index = 0; index < DEFAULT_MAIL_RATE_PER_5_MIN; index += 1) {
			const sent = sendMail(
				db,
				{ fromNode: "root.team-a", to: "alice", subject: String(index), body: "x" },
				{ now: () => 10_000 + index },
			);
			assert.equal(sent.ok, true, `message ${index} should be allowed`);
		}
		const over = sendMail(db, { fromNode: "root.team-a", to: "alice", subject: "11", body: "x" }, { now: () => 10_020 });
		assert.equal(over.ok, false);
		if (!over.ok) assert.equal(over.code, "rate_limited");

		// The window is still five minutes: the same sender passes again after it.
		const later = sendMail(
			db,
			{ fromNode: "root.team-a", to: "alice", subject: "late", body: "x" },
			{ now: () => 10_020 + MAIL_RATE_WINDOW_MS },
		);
		assert.equal(later.ok, true, "the rate window must still be five minutes wide");
	} finally {
		db.close();
	}
});
