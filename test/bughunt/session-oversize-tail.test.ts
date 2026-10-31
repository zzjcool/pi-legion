/**
 * BUGHUNT C6 — an oversized row that has no terminating newline is neither
 * committed, nor counted as torn, nor used to advance the byte cursor.
 *
 * Policy as implemented for a *terminated* row (src/shared/session.ts:506-521):
 * once a pending line exceeds `maxLineBytes` the parser drops it (`skipping`),
 * counts it in `tornLines`, and moves the cursor past its newline.
 *
 * A row with the same bytes but no trailing newline hits a different branch:
 * `readCompleteSessionLines` reports `offset` unchanged and `tornLines === 0`,
 * and the provisional-tail fallback in `parseSessionFile` (src/shared/session.ts:722-727)
 * and `readSessionJsonlDelta` (src/shared/session.ts:610-614) only reads a tail
 * when `stat.size - offset <= maxLineBytes`. So the tail is skipped by BOTH
 * paths, forever: every poll re-opens at the same offset and re-scans the whole
 * tail, and the oversized row is never counted as torn.
 *
 * These tests pin the parity requirement: same bytes, same cap, only the
 * trailing newline differs ⇒ same `tornLines` and cursor progress.
 *
 * Read-only against the SUT: this file is the only addition.
 */
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	clearSessionParseCache,
	parseSessionFile,
	readSessionJsonlDelta,
	resolveSessionMaxLineBytes,
	SESSION_MAX_LINE_BYTES_ENV,
} from "../../src/shared/session.ts";

/**
 * Mirrors the private `SESSION_READ_CHUNK_BYTES` (src/shared/session.ts:384).
 * It matters: the cap is only enforced while *accumulating pending bytes*, so a
 * terminated row trips `skipping` only if it spans more than one read chunk.
 * A row that fits inside a single 1 MiB chunk is delivered whole (a separate,
 * pre-existing quirk), which is why the parity fixture is >1 MiB and not 2 KiB.
 */
const READ_CHUNK_BYTES = 1024 * 1024;

/** Cap we shrink to; the env var requires a floored value >= 1 (#174). */
const CAP_BYTES = 1024;

/** One JSONL row whose serialized form is comfortably larger than READ_CHUNK_BYTES. */
function oversizeRow(totalBytes: number): string {
	const row = JSON.stringify({
		type: "message",
		message: {
			role: "toolResult",
			isError: false,
			content: [{ type: "text", text: "y".repeat(totalBytes) }],
		},
	});
	if (row.length <= totalBytes) throw new Error(`fixture bug: row ${row.length} <= ${totalBytes}`);
	return row;
}

interface Fixture {
	dir: string;
	file(name: string, contents: string): string;
}

/** Fresh temp dir per test; removed in `finally` so nothing leaks into other suites. */
function fixture(): Fixture {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bughunt-c6-"));
	return {
		dir,
		file(name, contents) {
			const p = path.join(dir, name);
			fs.writeFileSync(p, contents);
			return p;
		},
	};
}

/**
 * Run `fn` with `PI_LEGION_SESSION_MAX_LINE_BYTES=CAN_BYTES`, restoring the
 * previous value (or deleting it) afterwards. The cache is cleared on both sides
 * so no incremental state crosses a cap change.
 */
function withCap<T>(fn: () => T): T {
	const prev = process.env[SESSION_MAX_LINE_BYTES_ENV];
	process.env[SESSION_MAX_LINE_BYTES_ENV] = String(CAP_BYTES);
	clearSessionParseCache();
	try {
		// Fixture sanity: the knob really is in effect, so a green control cannot
		// come from the 32 MiB default making every fixture "small".
		assert.equal(resolveSessionMaxLineBytes(), CAP_BYTES, "env cap must be live");
		return fn();
	} finally {
		if (prev === undefined) delete process.env[SESSION_MAX_LINE_BYTES_ENV];
		else process.env[SESSION_MAX_LINE_BYTES_ENV] = prev;
		clearSessionParseCache();
	}
}

// ---------------------------------------------------------------------------
// Control: the same oversized row WITH a newline is torn and the cursor moves.
// This proves the fixture really exceeds the cap and that the torn path works.
// ---------------------------------------------------------------------------
test("control: terminated oversized row is counted torn and advances the cursor", () => {
	const fx = fixture();
	try {
		withCap(() => {
			const file = fx.file("terminated.jsonl", `${oversizeRow(READ_CHUNK_BYTES + 64 * 1024)}\n`);

			const first = parseSessionFile(file);
			const second = parseSessionFile(file);
			assert.ok(first.tornLines >= 1, `terminated oversized row must be torn (got ${first.tornLines})`);
			assert.equal(second.tornLines, first.tornLines, "a torn row stays counted on the next poll");

			// Cursor must land on EOF: the row is consumed (dropped), not re-scanned.
			const delta = readSessionJsonlDelta(file, undefined);
			assert.ok(delta, "delta must parse the fixture");
			assert.equal(delta.tornLines, 1);
			assert.equal(delta.cursor.offset, delta.fileSize, "cursor must advance past the dropped row");
			assert.equal(delta.provisional, "", "nothing stays provisional once the newline arrived");
		});
	} finally {
		fs.rmSync(fx.dir, { recursive: true, force: true });
	}
});

// ---------------------------------------------------------------------------
// BUG (parity): identical bytes, identical cap, no trailing newline.
// Terminated ⇒ tornLines 1. Unterminated ⇒ tornLines 0. Must not differ.
// ---------------------------------------------------------------------------
test("parity: an unterminated oversized tail must be torn exactly like the terminated row", () => {
	const fx = fixture();
	try {
		withCap(() => {
			const row = oversizeRow(READ_CHUNK_BYTES + 64 * 1024);
			const terminated = fx.file("terminated.jsonl", `${row}\n`);
			const unterminated = fx.file("unterminated.jsonl", row);

			const terminatedFirst = parseSessionFile(terminated);
			const terminatedSecond = parseSessionFile(terminated);
			const unterminatedFirst = parseSessionFile(unterminated);
			const unterminatedSecond = parseSessionFile(unterminated);

			assert.ok(terminatedSecond.tornLines >= 1, "control: terminated row is torn");

			// The only difference between the two fixtures is the trailing newline.
			// An unterminated tail that ALREADY exceeds the cap can never become a
			// legal row, so it must be dropped and counted exactly like the
			// terminated one — otherwise `tornLines` silently under-reports
			// truncation depending on where the writer stopped mid-flush.
			assert.equal(
				unterminatedSecond.tornLines,
				terminatedSecond.tornLines,
				`parity broken: unterminated tail tornLines=${unterminatedSecond.tornLines}, terminated tornLines=${terminatedSecond.tornLines}`,
			);
			assert.ok(unterminatedFirst.tornLines >= 1, "the very first poll must already report the torn row");
		});
	} finally {
		fs.rmSync(fx.dir, { recursive: true, force: true });
	}
});

// ---------------------------------------------------------------------------
// BUG (cost): the unterminated tail is never consumed, so the cursor never
// moves and every poll re-reads the entire tail. Byte counts, not timings —
// wall-clock on a 1 MiB read is too noisy to assert (see note at the end).
// ---------------------------------------------------------------------------
test("cost: an unterminated oversized tail never advances the cursor, so each poll re-reads it all", () => {
	const fx = fixture();
	try {
		withCap(() => {
			const row = oversizeRow(READ_CHUNK_BYTES + 64 * 1024);
			const unterminated = fx.file("unterminated.jsonl", row);
			const terminated = fx.file("terminated.jsonl", `${row}\n`);

			// Control: with the newline the cursor reaches EOF, so the next poll
			// re-reads zero bytes. This is what "cheap poll" looks like.
			const okFirst = readSessionJsonlDelta(terminated, undefined);
			assert.ok(okFirst, "delta must parse the terminated fixture");
			const okSecond = readSessionJsonlDelta(terminated, okFirst.cursor);
			assert.ok(okSecond, "second poll must parse the terminated fixture");
			assert.equal(okSecond.reset, false, "append-only file must not be treated as rewritten");
			assert.equal(okSecond.fileSize - okSecond.cursor.offset, 0, "terminated row leaves nothing to re-read");

			// Bug: without the newline the cursor is stuck at 0 while the file is
			// the whole row, so `bytesReRead` is the full tail on every poll —
			// O(file size) per poll, forever, on a file that never grows again.
			const badFirst = readSessionJsonlDelta(unterminated, undefined);
			assert.ok(badFirst, "delta must parse the unterminated fixture");
			const badSecond = readSessionJsonlDelta(unterminated, badFirst.cursor);
			assert.ok(badSecond, "second poll must parse the unterminated fixture");

			const firstBytesReRead = badFirst.fileSize - badFirst.cursor.offset;
			const secondBytesReRead = badSecond.fileSize - badSecond.cursor.offset;
			assert.equal(badSecond.reset, false, "the same file must not be re-read as a rewrite");
			assert.equal(
				secondBytesReRead,
				0,
				`cursor stuck at byte ${badSecond.cursor.offset} of ${badSecond.fileSize}: each poll re-scans ${secondBytesReRead} bytes (first poll ${firstBytesReRead})`,
			);
			assert.equal(badSecond.tornLines, 0, "and while re-scanning it, nothing is reported as torn");

			// Informational only — no assertion: two 1 MiB re-scans are far too
			// small for a stable wall-clock signal, so asserting time here would be
			// the flaky test the brief asks us to avoid. Byte counts above are the
			// deterministic proxy for the same re-scan cost.
			const t0 = process.hrtime.bigint();
			parseSessionFile(unterminated);
			parseSessionFile(unterminated);
			const pollMs = Number(process.hrtime.bigint() - t0) / 1e6 / 2;
			console.log(`informational: no-newline tail poll ≈ ${pollMs.toFixed(3)} ms/poll over ${row.length} bytes`);
		});
	} finally {
		fs.rmSync(fx.dir, { recursive: true, force: true });
	}
});
