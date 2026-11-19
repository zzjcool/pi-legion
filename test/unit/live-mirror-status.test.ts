/**
 * #411 §4 — the `mirror=` line in a child's status block
 * (contract: `.pi-legion/contract.md`).
 *
 * Two halves, tested separately on purpose:
 *
 *   - `formatMirrorLine` is PURE: it turns facts into one of four answers and
 *     never touches the disk. The whole decision table lives here.
 *   - `readMirrorFacts` owns the only IO: one `readFileSync` of a small JSON next
 *     to the child's session file, with every failure mode collapsing to
 *     `undefined` (silence), because a status block that throws is worse than a
 *     status block that says nothing.
 *
 * The third group is the one that protects everyone else: a child with no state
 * file — i.e. every LOCAL child, which is all of them today — must render exactly
 * the bytes it rendered before #411. That is asserted against a literal expected
 * block, not against a regex, so an accidental extra blank line or a reordered
 * meta pair fails here too.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { test, type TestContext } from "node:test";

import {
	formatMirrorLine,
	readMirrorFacts,
	renderLiveChildStatus,
	type LiveChildStatusInput,
} from "../../src/extension/runtime.ts";
import { liveMirrorStatePathFor, type LiveMirrorFacts } from "../../src/runs/live-mirror.ts";

// ── fixtures ───────────────────────────────────────────────────────────────

/** Facts as the pump reports them: an `on` mirror that is fully caught up. */
function facts(over: Partial<LiveMirrorFacts> = {}): LiveMirrorFacts {
	return {
		localPath: "/runs/r-1/worker-0.jsonl",
		mode: "on",
		bytes: 0,
		offset: 0,
		staleBytes: 0,
		lastGrowthAt: 0,
		lastSyncAt: 0,
		...over,
	};
}

/** A temp run dir; `t.after` removes it even when an assertion throws. */
function tempDir(t: TestContext): string {
	const dir = mkdtempSync(path.join(tmpdir(), "live-mirror-status-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

/** Pre-create the child's session file (empty: a remote child that wrote nothing yet). */
function sessionFileIn(dir: string): string {
	const sessionFile = path.join(dir, "worker-0.jsonl");
	writeFileSync(sessionFile, "");
	return sessionFile;
}

/** Write the pump's persisted row where `readMirrorFacts` looks for it. */
function writeMirrorState(sessionFile: string, row: unknown): string {
	const statePath = liveMirrorStatePathFor(sessionFile);
	mkdirSync(path.dirname(statePath), { recursive: true });
	writeFileSync(statePath, typeof row === "string" ? row : `${JSON.stringify(row)}\n`);
	return statePath;
}

/**
 * Smallest honest status input: `alive: false` keeps the quiet-age line (a real
 * clock) and the rss line (a real `/proc` read) out of the snapshot, so the whole
 * block is deterministic and can be compared literally.
 */
function input(sessionFile: string, over: Partial<LiveChildStatusInput> = {}): LiveChildStatusInput {
	return {
		name: "worker-0",
		state: "working",
		agent: "worker",
		kind: "pi",
		sessionFile,
		alive: false,
		execution: { status: "running" },
		spawnMode: "inprocess",
		now: 0,
		...over,
	};
}

// ── formatMirrorLine: the pure decision table ──────────────────────────────

test("formatMirrorLine prints nothing for undefined facts", () => {
	assert.equal(formatMirrorLine(undefined), undefined);
});

test("formatMirrorLine reports mode off without a byte count", () => {
	// Configured off: there is no mirror, so there is no number to quote — and a
	// leftover `staleBytes`/`error` from an earlier `on` run must not resurrect one.
	assert.equal(formatMirrorLine(facts({ mode: "off", bytes: 4096, staleBytes: 99 })), "mirror=off");
	assert.equal(formatMirrorLine(facts({ mode: "off", error: "boom" })), "mirror=off");
});

test("formatMirrorLine reports ok with the mirror's byte count", () => {
	assert.equal(formatMirrorLine(facts({ bytes: 123 })), "mirror=ok(123 bytes)");
	// "ok" is about the mirror being caught up, not about it being non-empty: a
	// child that has written nothing yet is current, and says so.
	assert.equal(formatMirrorLine(facts({ bytes: 0 })), "mirror=ok(0 bytes)");
});

test("formatMirrorLine reports stale with the bytes still missing", () => {
	assert.equal(formatMirrorLine(facts({ bytes: 100, staleBytes: 456 })), "mirror=stale(456 bytes)");
});

test("formatMirrorLine: an error with zero stale bytes is still stale", () => {
	// The pump clears `error` on the next success, so a present `error` is current
	// news: the last tick FAILED, even though every byte it had is mirrored.
	assert.equal(formatMirrorLine(facts({ bytes: 123, staleBytes: 0, error: "boom" })), "mirror=stale(0 bytes)");
});

// ── readMirrorFacts: the IO half ───────────────────────────────────────────

test("readMirrorFacts reads back a written state file", (t) => {
	const dir = tempDir(t);
	const sessionFile = sessionFileIn(dir);
	writeMirrorState(sessionFile, facts({
		localPath: sessionFile,
		bytes: 123,
		offset: 123,
		remoteBytes: 579,
		staleBytes: 456,
		lastGrowthAt: 1_000,
		lastSyncAt: 2_000,
		error: "remote read at 123 failed: timeout",
	}));

	const read = readMirrorFacts(sessionFile);
	assert.ok(read, "a valid state file must be read");
	assert.equal(read.mode, "on");
	assert.equal(read.bytes, 123);
	assert.equal(read.offset, 123);
	assert.equal(read.remoteBytes, 579);
	assert.equal(read.staleBytes, 456);
	assert.equal(read.lastGrowthAt, 1_000);
	assert.equal(read.lastSyncAt, 2_000);
	assert.equal(read.error, "remote read at 123 failed: timeout");
	assert.equal(read.localPath, sessionFile);
	// And the whole point: the read facts render the marker the contract promises.
	assert.equal(formatMirrorLine(read), "mirror=stale(456 bytes)");
});

test("readMirrorFacts: a missing state file is undefined", (t) => {
	const dir = tempDir(t);
	const sessionFile = sessionFileIn(dir);
	// No `remote/` dir at all — the local-child case, and the reason it is silent.
	assert.equal(readMirrorFacts(sessionFile), undefined);
});

test("readMirrorFacts: content that is not JSON is undefined", (t) => {
	const dir = tempDir(t);
	const sessionFile = sessionFileIn(dir);
	writeMirrorState(sessionFile, "not json at all\n");
	assert.equal(readMirrorFacts(sessionFile), undefined);
});

test("readMirrorFacts: an invalid mode is undefined", (t) => {
	const dir = tempDir(t);
	const sessionFile = sessionFileIn(dir);
	writeMirrorState(sessionFile, facts({ localPath: sessionFile, bytes: 1, mode: "paused" as unknown as "on" }));
	assert.equal(readMirrorFacts(sessionFile), undefined);
});

test("readMirrorFacts: a non-numeric byte count is undefined", (t) => {
	const dir = tempDir(t);
	const sessionFile = sessionFileIn(dir);
	// A hand-edited (or half-understood) row must not print `mirror=ok(abc bytes)`.
	writeMirrorState(sessionFile, { ...facts({ localPath: sessionFile }), bytes: "123" });
	assert.equal(readMirrorFacts(sessionFile), undefined);

	writeMirrorState(sessionFile, { ...facts({ localPath: sessionFile }), staleBytes: null });
	assert.equal(readMirrorFacts(sessionFile), undefined);

	writeMirrorState(sessionFile, { ...facts({ localPath: sessionFile }), staleBytes: -1 });
	assert.equal(readMirrorFacts(sessionFile), undefined, "a negative byte count is not a pump row");
});

test("readMirrorFacts: an empty sessionFile is undefined", () => {
	// No path means no place the facts could be: never derive one from "".
	assert.equal(readMirrorFacts(""), undefined);
});

// ── renderLiveChildStatus: one line, in one place ──────────────────────────

test("renderLiveChildStatus: no state file ⇒ no mirror line, block byte for byte as before #411", (t) => {
	const dir = tempDir(t);
	const sessionFile = sessionFileIn(dir);
	const out = renderLiveChildStatus(input(sessionFile));

	assert.ok(!out.includes("mirror="), `a local child must grow no mirror line:\n${out}`);
	// The literal pre-#411 block for this input. Compared as a whole so a stray
	// blank line, a reordered meta pair or a "helpful" new field fails here.
	assert.equal(
		out,
		[
			"worker-0 — state=working agent=worker kind=pi",
			"execution: running",
			"supervisor=inprocess",
			`session=${sessionFile}`,
		].join("\n"),
	);
});

test("renderLiveChildStatus: mirror=off lands after terminal= and before execution", (t) => {
	const dir = tempDir(t);
	const sessionFile = sessionFileIn(dir);
	writeMirrorState(sessionFile, facts({ localPath: sessionFile, mode: "off" }));

	// The DEAD cross-machine record: `host=`/`terminal=` and nothing else in that
	// block, so "directly after" is verifiable line by line.
	const dead = renderLiveChildStatus(input(sessionFile, { host: "hw-nj", remoteTerminal: "hw-nj/t-1" }));
	const deadLines = dead.split("\n");
	const deadMirrorAt = deadLines.indexOf("mirror=off");
	const deadTerminalAt = deadLines.indexOf("terminal=hw-nj/t-1");
	const deadExecutionAt = deadLines.indexOf("execution: running");

	assert.ok(deadMirrorAt >= 0, `missing mirror=off:\n${dead}`);
	assert.ok(deadTerminalAt >= 0, `missing the terminal line:\n${dead}`);
	assert.ok(deadExecutionAt >= 0, `missing the execution line:\n${dead}`);
	assert.equal(deadMirrorAt, deadTerminalAt + 1, "directly after the host/terminal facts");
	assert.equal(deadMirrorAt, deadExecutionAt - 1, "before the snapshot lines");
	// A configured-off mirror is not a `see:` hint and not a stale claim.
	assert.doesNotMatch(dead, /mirror=ok|mirror=stale/);

	// The LIVE cross-machine record adds a `see:` hint INSIDE the same block, so the
	// marker still comes after the whole host/terminal block — never wedged between
	// `terminal=` and `see:`, and never after a snapshot.
	const live = renderLiveChildStatus(input(sessionFile, {
		alive: true,
		host: "hw-nj",
		remoteTerminal: "hw-nj/t-1",
	}));
	const liveLines = live.split("\n");
	assert.equal(liveLines.indexOf("mirror=off"), liveLines.indexOf("execution snapshot: running") - 1);
	assert.ok(
		liveLines.indexOf("mirror=off") > liveLines.findIndex((line) => line.startsWith("see: hc read ")),
		"the marker follows the whole host/terminal block, `see:` included",
	);
});

test("renderLiveChildStatus: a clean mirror prints ok(bytes)", (t) => {
	const dir = tempDir(t);
	const sessionFile = sessionFileIn(dir);
	writeMirrorState(sessionFile, facts({
		localPath: sessionFile,
		bytes: 123,
		offset: 123,
		remoteBytes: 123,
		staleBytes: 0,
		lastGrowthAt: 1_000,
		lastSyncAt: 2_000,
	}));

	const out = renderLiveChildStatus(input(sessionFile));
	assert.ok(out.split("\n").includes("mirror=ok(123 bytes)"), `missing mirror=ok:\n${out}`);
	assert.doesNotMatch(out, /mirror=stale|mirror=off/);
});

test("renderLiveChildStatus: a lagging mirror prints stale(staleBytes)", (t) => {
	const dir = tempDir(t);
	const sessionFile = sessionFileIn(dir);
	writeMirrorState(sessionFile, facts({
		localPath: sessionFile,
		bytes: 100,
		offset: 100,
		remoteBytes: 556,
		staleBytes: 456,
		error: "boom",
	}));

	const out = renderLiveChildStatus(input(sessionFile));
	assert.ok(out.split("\n").includes("mirror=stale(456 bytes)"), `missing mirror=stale:\n${out}`);
	// The byte count is the whole message: the pump's error text stays in the
	// pump's own warning sink, not in a one-line status marker.
	assert.doesNotMatch(out, /boom/);
});
