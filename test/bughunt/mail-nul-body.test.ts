/**
 * BUG HUNT (candidate C3) — `legion_mail` silently loses everything after the
 * first `U+0000` in a body (or subject), and its `bodyBytes` receipt describes
 * bytes that no reader can ever get back.
 *
 * This file is a *reproducer*, not an acceptance test: it is deliberately RED on
 * the fidelity assertions and GREEN on the controls that prove the fixture itself
 * is sound. Nothing in `src/` is touched.
 *
 * Mechanism, measured on this checkout (see `mechanism:` test below for the live
 * evidence):
 *   - `sendMail` validates with `Buffer.byteLength(input.body, "utf8")`
 *     (src/legion/mail.ts:206) and gates on the hard limit (:207).
 *   - It then binds the raw string into `messages.body` — TEXT, no CHECK constraint
 *     (src/legion/db.ts:117-129). The bind itself is lossless: the row physically
 *     keeps all 12 bytes of `before\0after` (`hex(body)` = 6265666F7265006166746572).
 *   - The loss happens on the READ path. SQLite's TEXT semantics are NUL-terminated
 *     (`length(body)` = 6, `substr(body,1,20)` = "before", `quote(body)` = 'before'),
 *     and `node:sqlite`'s `sqlite3_column_text` → JS string conversion stops at the
 *     NUL as well, so `mapMessage`'s `String(row.body)` (mail.ts:642) yields
 *     `"before"`. The tail is dead weight: stored, but unreachable.
 *   - `bodyBytes` is computed from the ORIGINAL text (:206, returned at :242-243),
 *     so the receipt claims 12 bytes while only 6 are retrievable.
 *
 * Consequence downstream: `formatMail` (mail.ts:436-437) embeds the truncated body,
 * so the strict-equality DELIVERED proof (`mailMatchesUserText`, mail.ts:461-463)
 * can "succeed" for text the child never received in full — the loss is invisible
 * from both the receipt and the delivery state machine.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { openLegionDb, type DatabaseSync } from "../../src/legion/db.ts";
import { insertNode } from "../../src/legion/nodes.ts";
import {
	MAIL_BODY_HARD_LIMIT_BYTES,
	formatMail,
	getMessage,
	sendMail,
	type MailSuccess,
} from "../../src/legion/mail.ts";

const NUL_BODY = "before\u0000after";
const NUL_BODY_HEAD = "before";
/** Hex of the full `before\0after`, what a lossless row must contain. */
const NUL_BODY_HEX = "6265666F7265006166746572";

/** Two nodes (`root` -> `kid`) on a throwaway in-memory ledger: root may mail its child. */
function makeTree(): DatabaseSync {
	const db = openLegionDb(":memory:");
	insertNode(db, { parentId: null, name: "root", role: "root" });
	insertNode(db, { parentId: "root", name: "kid", role: "worker" });
	return db;
}

/** Narrow `MailResult` to the success arm with a real assertion, never a bare cast. */
function expectSent(result: ReturnType<typeof sendMail>): MailSuccess {
	if (!result.ok) assert.fail(`sendMail refused the message (${result.code}: ${result.message})`);
	return result as MailSuccess;
}

/**
 * The bytes SQLite physically stores for a row's body.
 * `length()` counts TEXT characters (and stops at NUL), so cast to BLOB: this is
 * the storage-side ground truth, independent of any JS string handling.
 */
function storedBodyBlobBytes(db: DatabaseSync, id: number): number {
	return Number(db.prepare("SELECT length(CAST(body AS BLOB)) AS bytes FROM messages WHERE id = ?").get(id)?.bytes ?? -1);
}

function storedBodyHex(db: DatabaseSync, id: number): string {
	return String(db.prepare("SELECT hex(body) AS hex FROM messages WHERE id = ?").get(id)?.hex ?? "<missing row>");
}

function storedSubject(db: DatabaseSync, id: number): string {
	return String(db.prepare("SELECT subject FROM messages WHERE id = ?").get(id)?.subject ?? "<missing row>");
}

// ---------------------------------------------------------------------------
// RED — the bug
// ---------------------------------------------------------------------------

test("BUG C3: a body containing U+0000 loses everything after the NUL", () => {
	const db = makeTree();
	try {
		const sent = expectSent(sendMail(db, { fromNode: "root", to: "kid", subject: "nul body", body: NUL_BODY }));
		// Recorded current behavior: the send call claims success for a lossy write.
		assert.equal(sent.ok, true);

		const message = sent.messages[0];
		assert.ok(message, "sendMail reported success but produced no message");
		const readBack = getMessage(db, message.id);
		assert.ok(readBack, `message #${message.id} could not be read back`);

		assert.equal(readBack.body, NUL_BODY);
	} finally {
		db.close();
	}
});

test("BUG C3: the bodyBytes receipt describes bytes no reader can get back", () => {
	const db = makeTree();
	try {
		const sent = expectSent(sendMail(db, { fromNode: "root", to: "kid", subject: "nul body", body: NUL_BODY }));
		const message = sent.messages[0];
		assert.ok(message, "sendMail reported success but produced no message");

		// The receipt is exact about STORAGE — the row really does hold all 12 bytes.
		// (Recorded so the fix is not aimed at the wrong layer: nothing is dropped on write.)
		assert.equal(sent.bodyBytes, Buffer.byteLength(NUL_BODY, "utf8"), "receipt no longer reports the submitted size");
		assert.equal(sent.bodyBytes, storedBodyBlobBytes(db, message.id), "the row does not physically hold the submitted bytes");

		// ...but the payload the ledger can hand back is shorter, so the number is a
		// promise the read path cannot keep: 12 bytes claimed, 6 bytes retrievable.
		const readBack = getMessage(db, message.id);
		assert.ok(readBack, `message #${message.id} could not be read back`);
		assert.equal(sent.bodyBytes, Buffer.byteLength(readBack.body, "utf8"));
	} finally {
		db.close();
	}
});

test("BUG C3: a subject containing U+0000 is truncated at the NUL too (same class)", () => {
	const db = makeTree();
	try {
		const subject = "Sub\u0000ject";
		const sent = expectSent(sendMail(db, { fromNode: "root", to: "kid", subject, body: "plain ascii body" }));
		const message = sent.messages[0];
		assert.ok(message, "sendMail reported success but produced no message");

		assert.equal(message.subject, subject, "subject already lossy in the message sendMail returned");
		assert.equal(storedSubject(db, message.id), subject);
	} finally {
		db.close();
	}
});

// ---------------------------------------------------------------------------
// GREEN controls — evidence that the fixture is sound and the gap is NUL-specific
// ---------------------------------------------------------------------------

test("mechanism: the row keeps all bytes after the NUL, the TEXT read path drops them", () => {
	const db = makeTree();
	try {
		const sent = expectSent(sendMail(db, { fromNode: "root", to: "kid", subject: "nul body", body: NUL_BODY }));
		const message = sent.messages[0];
		assert.ok(message, "sendMail reported success but produced no message");

		// Storage is lossless: the embedded NUL and its tail are in the record.
		assert.equal(storedBodyHex(db, message.id), NUL_BODY_HEX, "the write path did not lose the tail");
		assert.equal(storedBodyBlobBytes(db, message.id), Buffer.byteLength(NUL_BODY, "utf8"));

		// Reading is lossy: both SQLite's own TEXT semantics and the column->string
		// conversion stop at the NUL, which is where the tail becomes unreachable.
		const textLength = Number(db.prepare("SELECT length(body) AS chars FROM messages WHERE id = ?").get(message.id)?.chars ?? -1);
		assert.equal(textLength, NUL_BODY_HEAD.length, "TEXT length stops at the NUL");
		const readBack = getMessage(db, message.id);
		assert.ok(readBack, `message #${message.id} could not be read back`);
		assert.equal(readBack.body, NUL_BODY_HEAD, "the JS read path stops at the NUL");

		// And the DELIVERED proof is built from that truncated text, so it can pass
		// for a payload the child never saw in full.
		const envelope = formatMail(readBack);
		assert.equal(envelope.includes(NUL_BODY_HEAD), true);
		assert.equal(envelope.includes("after"), false, "the envelope the postman injects is missing the tail");
	} finally {
		db.close();
	}
});

test("control: a pure-ASCII body round-trips byte-for-byte", () => {
	const db = makeTree();
	try {
		const body = "plain ascii body\nsecond line\n";
		const sent = expectSent(sendMail(db, { fromNode: "root", to: "kid", subject: "ascii", body }));
		const message = sent.messages[0];
		assert.ok(message, "sendMail reported success but produced no message");

		const readBack = getMessage(db, message.id);
		assert.ok(readBack, `message #${message.id} could not be read back`);
		assert.equal(readBack.body, body, "non-NUL text is lossless, so the truncation above is NUL-specific");
		assert.equal(sent.bodyBytes, storedBodyBlobBytes(db, message.id), "receipt matches the row for NUL-free text");
	} finally {
		db.close();
	}
});

test("control: the hard limit still rejects an oversized body (validation layer exists, it just misses NUL)", () => {
	const db = makeTree();
	try {
		const oversized = "x".repeat(MAIL_BODY_HARD_LIMIT_BYTES + 1);
		const rejected = sendMail(db, { fromNode: "root", to: "kid", subject: "too big", body: oversized });
		if (rejected.ok) assert.fail("a body above the hard limit must not be accepted");
		assert.equal(rejected.code, "body_too_large");
		const count = db.prepare("SELECT COUNT(*) AS count FROM messages").get();
		assert.equal(Number(count?.count ?? -1), 0, "a rejected body must not reach the ledger");
	} finally {
		db.close();
	}
});
