/**
 * #411 §2 — the live mirror pump (contract: `.pi-legion/contract.md`).
 *
 * Every test here pins ONE of the eight invariants, by name, against a fake
 * remote that is nothing but a `Buffer`: no `hc`, no second machine, no socket.
 * There is no `setTimeout`/sleep in this file — `now` is an injected clock and
 * the timer tests only assert `start()`/`stop()` bookkeeping, because a test that
 * waits five seconds to prove a 5 s interval fires is a broken test.
 *
 * The files are real (`mkdtempSync`), because half of the contract is about what a
 * concurrent reader of `sessionFile` can observe: atomicity, line boundaries and
 * the absence of temp files cannot be asserted against an in-memory mirror.
 */

import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import {
	LIVE_MIRROR_CHUNK_BYTES,
	LIVE_MIRROR_ENV,
	LIVE_MIRROR_INTERVAL_ENV,
	LIVE_MIRROR_INTERVAL_MS,
	LIVE_MIRROR_MAX_BYTES,
	LIVE_MIRROR_MAX_BYTES_ENV,
	LIVE_MIRROR_MIN_INTERVAL_MS,
	LIVE_MIRROR_MIN_MAX_BYTES,
	LiveMirror,
	liveMirrorStatePathFor,
	resolveLiveMirrorConfig,
	type LiveMirrorFacts,
	type LiveMirrorRemote,
} from "../../src/runs/live-mirror.ts";

// ── fixtures ───────────────────────────────────────────────────────────────

/** A fake remote: the transcript on "that machine" is just a Buffer. */
class FakeRemote implements LiveMirrorRemote {
	data: Buffer;
	/** `undefined` responses, i.e. "that machine has no such file (yet)". */
	absent = false;
	sizeCalls = 0;
	readCalls: Array<{ from: number; max: number }> = [];
	closes = 0;
	failSize: Error | undefined;
	failRead: Error | undefined;
	/** Runs inside `read()`, i.e. exactly when a tick asks for bytes. */
	onRead: (() => void) | undefined;

	constructor(initial: string | Buffer = "") {
		this.data = Buffer.from(initial);
	}

	append(text: string): void {
		this.data = Buffer.concat([this.data, Buffer.from(text)]);
	}

	reset(data: string | Buffer): void {
		this.data = Buffer.from(data);
	}

	async size(): Promise<number | undefined> {
		this.sizeCalls += 1;
		if (this.failSize) throw this.failSize;
		return this.absent ? undefined : this.data.length;
	}

	async read(from: number, max: number): Promise<Buffer> {
		this.readCalls.push({ from, max });
		this.onRead?.();
		if (this.failRead) throw this.failRead;
		return this.data.subarray(from, from + max);
	}

	close(): void {
		this.closes += 1;
	}
}

function tempDir(t: TestContext): string {
	const dir = mkdtempSync(path.join(tmpdir(), "live-mirror-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

/** A temp dir plus the child's `sessionFile` placeholder, as `launch` creates it. */
function fixture(t: TestContext): { dir: string; localPath: string; statePath: string } {
	const dir = tempDir(t);
	const localPath = path.join(dir, "child.jsonl");
	writeFileSync(localPath, ""); // preCreateSessionFile: empty, forever, without a pump
	return { dir, localPath, statePath: path.join(dir, "remote", "child.mirror.json") };
}

function text(file: string): string {
	return readFileSync(file, "utf8");
}

// ── invariant 1: incremental, never full ───────────────────────────────────

test("invariant 1: only the new bytes are appended (never the whole file)", async (t) => {
	const { localPath } = fixture(t);
	const remote = new FakeRemote("first line\n");
	const mirror = new LiveMirror({ localPath, remote, statePath: false, now: () => 1_000 });

	const first = await mirror.syncNow();
	assert.equal(first.bytes, 11);
	assert.equal(first.offset, 11);
	assert.equal(first.staleBytes, 0);
	assert.equal(first.lastGrowthAt, 1_000);
	assert.equal(text(localPath), "first line\n");

	// Exactly 40 new remote bytes, in one whole line.
	const added = `${"x".repeat(39)}\n`;
	assert.equal(Buffer.byteLength(added), 40);
	remote.append(added);

	const second = await mirror.syncNow();
	// The second read starts where the first one stopped: no byte is read twice, and
	// the whole file is never re-read.
	assert.deepEqual(remote.readCalls[1], { from: 11, max: 40 });
	assert.equal(second.bytes, 51);
	assert.equal(second.offset, 51);
	assert.equal(second.staleBytes, 0);

	const onDisk = readFileSync(localPath);
	// Tick 1's bytes are byte-identical: the append did not rewrite them.
	assert.deepEqual(onDisk.subarray(0, 11), Buffer.from("first line\n"));
	assert.equal(onDisk.toString(), `first line\n${added}`);
});

test("onGrowth fires for growing ticks only (never a no-op tick)", async (t) => {
	const { localPath } = fixture(t);
	const remote = new FakeRemote("a\n");
	const grown: LiveMirrorFacts[] = [];
	let clock = 0;
	const mirror = new LiveMirror({
		localPath,
		remote,
		statePath: false,
		now: () => (clock += 1),
		onGrowth: (facts) => grown.push(facts),
	});

	await mirror.syncNow();
	assert.equal(grown.length, 1);
	assert.equal(grown[0]?.bytes, 2);

	await mirror.syncNow(); // nothing new on the remote
	assert.equal(grown.length, 1);

	remote.append("b\n");
	await mirror.syncNow();
	assert.equal(grown.length, 2);
	assert.equal(grown[1]?.bytes, 4);
});

// ── invariant 2: remote shrank ⇒ reset, replace, warn once ─────────────────

test("invariant 2: a shorter remote file resets the offset and replaces the mirror", async (t) => {
	const { localPath } = fixture(t);
	const remote = new FakeRemote("aaa\nbbb\nccc\n");
	const warnings: string[] = [];
	const mirror = new LiveMirror({
		localPath,
		remote,
		statePath: false,
		now: () => 7,
		warn: (message) => warnings.push(message),
	});

	const first = await mirror.syncNow();
	assert.equal(first.bytes, 12);
	assert.equal(first.offset, 12);

	// The session was re-created on the far side: 2 bytes where the mirror consumed 12.
	remote.reset("z\n");
	const second = await mirror.syncNow();

	assert.equal(second.offset, 2);
	assert.equal(second.bytes, 2);
	// replaced, not appended: a 12 + 2 = 14 byte file would mean the two transcripts
	// were interleaved into one unparseable log.
	assert.equal(text(localPath), "z\n");
	assert.equal(statSync(localPath).size, 2);
	assert.equal(second.staleBytes, 0);
	assert.equal(warnings.length, 1);
	assert.match(warnings[0] ?? "", /shrank/);
	assert.match(warnings[0] ?? "", /restarting from the remote's first byte/);
});

test("invariant 2: a remote that became EMPTY empties the mirror instead of keeping the old log", async (t) => {
	const { localPath } = fixture(t);
	const remote = new FakeRemote("aaa\nbbb\n");
	const warnings: string[] = [];
	const mirror = new LiveMirror({ localPath, remote, statePath: false, warn: (m) => warnings.push(m) });
	await mirror.syncNow();
	assert.equal(statSync(localPath).size, 8);

	remote.reset("");
	const facts = await mirror.syncNow();

	// 0 bytes on the far side: replaced-by-nothing must leave NOTHING, otherwise a
	// reader keeps rendering a transcript the remote no longer has.
	assert.equal(statSync(localPath).size, 0);
	assert.equal(facts.bytes, 0);
	assert.equal(facts.offset, 0);
	assert.equal(facts.staleBytes, 0);
	assert.equal(warnings.length, 1);
});

// ── invariant 3: the cap keeps the trailing maxBytes, on a line boundary ────

test("invariant 3: an over-cap mirror keeps the trailing maxBytes on a line boundary", async (t) => {
	const { localPath } = fixture(t);
	const lines = Array.from({ length: 10 }, (_, index) => `line-${index}\n`); // 7 bytes each
	const remoteText = lines.join("");
	assert.equal(Buffer.byteLength(remoteText), 70);
	const remote = new FakeRemote(remoteText);
	const mirror = new LiveMirror({ localPath, remote, statePath: false, maxBytes: 32, now: () => 3 });

	const facts = await mirror.syncNow();

	// 70 bytes consumed, but only the tail is kept — and `bytes`/`offset` are two
	// independent quantities, which is the whole reason the pump never re-reads.
	assert.equal(facts.offset, 70);
	assert.ok(facts.bytes <= 32, `bytes ${facts.bytes} must stay within the cap`);
	const kept = text(localPath);
	assert.equal(Buffer.byteLength(kept), facts.bytes);
	// A whole suffix of the remote, cut on a newline boundary...
	assert.equal(kept, remoteText.slice(remoteText.length - kept.length));
	assert.ok(kept.startsWith("line-"), `mirror must start on a line boundary: ${JSON.stringify(kept)}`);
	assert.ok(kept.endsWith("\n"), "mirror must end on a complete line");
	// ...specifically the last four lines (28 bytes; a plain 32-byte tail would split
	// "line-6\nline-7\n" open).
	assert.equal(kept, "line-6\nline-7\nline-8\nline-9\n");
	assert.equal(facts.staleBytes, 0);
});

test("invariant 3: bytes beyond the cap are dropped from the head across ticks", async (t) => {
	const { localPath } = fixture(t);
	const remote = new FakeRemote("one\n");
	const mirror = new LiveMirror({ localPath, remote, statePath: false, maxBytes: 16, now: () => 4 });

	await mirror.syncNow();
	for (const line of ["two\n", "three\n", "four\n", "five\n"]) remote.append(line);
	const facts = await mirror.syncNow();

	assert.ok(facts.bytes <= 16);
	assert.equal(facts.offset, 4 + 4 + 6 + 5 + 5);
	const kept = text(localPath);
	assert.ok(kept.endsWith("five\n"));
	assert.equal(kept, "four\nfive\n"); // the last 10 bytes, on a boundary
});

// ── invariant 4: a failing pump never touches the child ────────────────────

test("invariant 4: a throwing remote never escapes syncNow and never damages the local file", async (t) => {
	const { localPath } = fixture(t);
	const remote = new FakeRemote("one\ntwo\n");
	const warnings: string[] = [];
	const mirror = new LiveMirror({
		localPath,
		remote,
		statePath: false,
		now: () => 11,
		warn: (message) => warnings.push(message),
	});
	await mirror.syncNow();
	const before = readFileSync(localPath);

	remote.failRead = new Error("boom: connection reset");
	remote.append("three\n");
	// The assertion IS that this resolves: a rejected promise here would have aborted
	// a collect or turned a readable child into a failed launch.
	const facts = await mirror.syncNow();

	assert.match(facts.error ?? "", /boom/);
	assert.match(facts.error ?? "", /remote read/);
	assert.equal(facts.bytes, 8, "the mirror must keep exactly what it had");
	assert.deepEqual(readFileSync(localPath), before);
	assert.ok(facts.staleBytes > 0, "bytes that exist there but not here must show up as stale");
	assert.equal(warnings.length, 1);

	// No retry storm: the same failure text is warned once, however many ticks fail.
	await mirror.syncNow();
	await mirror.syncNow();
	assert.equal(warnings.length, 1);

	// ...and a recovered tick clears the error.
	remote.failRead = undefined;
	const recovered = await mirror.syncNow();
	assert.equal(recovered.error, undefined);
	assert.equal(recovered.bytes, 14);

	// `stop()` still works on a pump that has seen a transport failure.
	mirror.start();
	assert.equal(mirror.running, true);
	mirror.stop();
	assert.equal(mirror.running, false);
	assert.equal(remote.closes, 1);
});

test("invariant 4: a throwing size() is contained the same way", async (t) => {
	const { localPath } = fixture(t);
	const remote = new FakeRemote("one\n");
	const warnings: string[] = [];
	const mirror = new LiveMirror({ localPath, remote, statePath: false, warn: (m) => warnings.push(m) });

	remote.failSize = new Error("hc connect died");
	const facts = await mirror.syncNow();

	assert.match(facts.error ?? "", /hc connect died/);
	assert.match(facts.error ?? "", /remote size/);
	assert.equal(facts.bytes, 0);
	assert.equal(text(localPath), "");
	assert.equal(warnings.length, 1);
});

// ── invariant 5: staleBytes is the truth ───────────────────────────────────

test("invariant 5: staleBytes counts what exists there but not here", async (t) => {
	const { localPath } = fixture(t);
	const remote = new FakeRemote("one\ntwo\n"); // 8 bytes
	const mirror = new LiveMirror({ localPath, remote, statePath: false });

	// Before any tick nothing has been observed, so nothing is provably stale.
	assert.equal(mirror.facts().staleBytes, 0);

	remote.failRead = new Error("nope");
	const failed = await mirror.syncNow();
	assert.equal(failed.staleBytes, 8, "a failed tick leaves the whole transcript stale");

	remote.failRead = undefined;
	const caughtUp = await mirror.syncNow();
	assert.equal(caughtUp.staleBytes, 0);

	// Bytes with no newline yet exist on the far side and are NOT in the mirror, so
	// the honest answer is 3 — not 0 (the offset never moved past them).
	remote.append("abc");
	const held = await mirror.syncNow();
	assert.equal(held.offset, 8);
	assert.equal(held.bytes, 8);
	assert.equal(held.staleBytes, 3);
});

// ── invariant 6: atomic visible writes ────────────────────────────────────

test("invariant 6: the visible file is replaced atomically (no partial size is ever observable)", async (t) => {
	const { dir, localPath, statePath } = fixture(t);
	const remote = new FakeRemote("first line\n");
	const mirror = new LiveMirror({ localPath, remote, statePath, now: () => 9 });

	await mirror.syncNow();
	const afterFirstTick = statSync(localPath).size;
	assert.equal(afterFirstTick, 11);

	// A concurrent reader, sampled exactly when the next tick asks for bytes.
	const observed: number[] = [];
	remote.onRead = () => observed.push(statSync(localPath).size);
	remote.append("second line\n");

	await mirror.syncNow();

	assert.ok(observed.length > 0, "the fake remote must have been read");
	assert.deepEqual(
		observed,
		observed.map(() => afterFirstTick),
		"every read must see the previous tick's complete file — never a grown-but-partial one",
	);
	assert.equal(statSync(localPath).size, 11 + 12);
	assert.equal(text(localPath), "first line\nsecond line\n");

	// No temp file is left behind, in the mirror's directory or the state's.
	const leftovers = [
		...readdirSync(dir).filter((name) => name.endsWith(".tmp")),
		...(existsSync(path.dirname(statePath))
			? readdirSync(path.dirname(statePath)).filter((name) => name.endsWith(".tmp"))
			: []),
	];
	assert.deepEqual(leftovers, []);
});

test("invariant 6: a failed local write leaves no temp file, changes nothing, and reports the failure", async (t) => {
	const { dir, localPath } = fixture(t);
	const remote = new FakeRemote("one\n");
	const warnings: string[] = [];
	// Replace the placeholder with a DIRECTORY: `renameSync(file, dir)` cannot land, and
	// that is a write failure the pump does not control.
	rmSync(localPath);
	mkdirSync(localPath, { recursive: true });
	const mirror = new LiveMirror({ localPath, remote, statePath: false, warn: (m) => warnings.push(m) });

	const facts = await mirror.syncNow();
	assert.ok(facts.error !== undefined, "a write that cannot land must be reported, not swallowed");
	assert.match(facts.error ?? "", /local write/);
	// Nothing was adopted in memory either: the next successful tick must not append
	// these bytes a second time.
	assert.equal(facts.bytes, 0);
	assert.equal(facts.offset, 0);
	assert.equal(warnings.length, 1);
	assert.deepEqual(readdirSync(dir).filter((name) => name.endsWith(".tmp")), []);
});

// ── invariant 7: complete lines only ──────────────────────────────────────

test("invariant 7: bytes after the last newline are held until the newline arrives", async (t) => {
	const { localPath } = fixture(t);
	const remote = new FakeRemote("one\ntwo"); // 7 bytes, no trailing newline
	const mirror = new LiveMirror({ localPath, remote, statePath: false, now: () => 2 });

	const held = await mirror.syncNow();
	assert.equal(text(localPath), "one\n", "the unterminated line must NOT be written");
	assert.equal(held.bytes, 4);
	assert.equal(held.offset, 4, "the offset must not move past bytes that were not written");
	assert.equal(held.staleBytes, 3);

	remote.append("\n");
	const landed = await mirror.syncNow();
	assert.equal(text(localPath), "one\ntwo\n");
	assert.equal(landed.bytes, 8);
	assert.equal(landed.offset, 8);
	assert.equal(landed.staleBytes, 0);
});

test("invariant 7: a line split across ticks is committed exactly once, whole", async (t) => {
	const { localPath } = fixture(t);
	const remote = new FakeRemote("head\n");
	const mirror = new LiveMirror({ localPath, remote, statePath: false });

	await mirror.syncNow();
	remote.append("par");
	await mirror.syncNow();
	remote.append("tial\n");
	await mirror.syncNow();

	assert.equal(text(localPath), "head\npartial\n");
	assert.equal(mirror.facts().bytes, 13);
	assert.equal(mirror.facts().offset, 13);
});

// ── invariant 8: mode off ─────────────────────────────────────────────────

test("invariant 8: mode off does no network work and persists mode=off", async (t) => {
	const { localPath, statePath } = fixture(t);
	// No `remote` at all: an off pump has nothing it COULD call. (A throwing fake
	// would only prove this module remembers not to call it; absence proves the wire
	// cannot be touched.)
	const warnings: string[] = [];
	const mirror = new LiveMirror({
		localPath,
		statePath,
		now: () => 42,
		warn: (message) => warnings.push(message),
	});

	assert.equal(mirror.facts().mode, "off");
	const facts = await mirror.syncNow();
	assert.equal(facts.mode, "off");
	assert.equal(facts.bytes, 0);
	assert.equal(facts.offset, 0);
	assert.equal(facts.staleBytes, 0);
	assert.equal(facts.error, undefined);
	assert.equal(facts.lastSyncAt, 42);

	mirror.start();
	mirror.stop();
	assert.equal(mirror.running, false);

	const persisted = JSON.parse(readFileSync(statePath, "utf8")) as LiveMirrorFacts;
	assert.equal(persisted.mode, "off");
	assert.equal(persisted.bytes, 0);
	assert.equal(persisted.offset, 0);
	assert.equal(persisted.localPath, localPath);
	assert.deepEqual(warnings, []);
});

test("mode off is decided by the remote's ABSENCE, not by a flag", async (t) => {
	const { localPath } = fixture(t);
	const remote = new FakeRemote("a\n");
	const mirror = new LiveMirror({ localPath, remote, statePath: false });
	assert.equal(mirror.facts().mode, "on");
	await mirror.syncNow();
	assert.equal(mirror.facts().mode, "on");
	assert.equal(remote.sizeCalls, 1);
});

// ── the pump's own plumbing ───────────────────────────────────────────────

test("start()/stop() are idempotent and flip `running` without a real interval tick", async (t) => {
	const { localPath } = fixture(t);
	const remote = new FakeRemote("a\n");
	const mirror = new LiveMirror({ localPath, remote, statePath: false, intervalMs: 3_600_000 });

	assert.equal(mirror.running, false);
	mirror.start();
	mirror.start();
	assert.equal(mirror.running, true);
	mirror.stop();
	mirror.stop();
	assert.equal(mirror.running, false);
	assert.equal(remote.closes, 1, "close() runs once, not once per stop()");
	// The unref'd interval never fired, so the remote was never asked anything.
	assert.equal(remote.sizeCalls, 0);
});

test("the state file round-trips the offset, and only for the same local path", async (t) => {
	const { dir, localPath, statePath } = fixture(t);
	const remote = new FakeRemote("one\ntwo\n");
	const first = new LiveMirror({ localPath, remote, statePath, now: () => 100 });
	await first.syncNow();
	first.stop();

	const persisted = JSON.parse(readFileSync(statePath, "utf8")) as LiveMirrorFacts;
	assert.equal(persisted.offset, 8);
	assert.equal(persisted.bytes, 8);
	assert.equal(persisted.staleBytes, 0);

	// A restart picks the offset back up: nothing is re-read and nothing is appended.
	const restartedRemote = new FakeRemote("one\ntwo\n");
	const restarted = new LiveMirror({ localPath, remote: restartedRemote, statePath, now: () => 200 });
	assert.equal(restarted.facts().offset, 8, "the persisted offset must survive a restart");
	const resumed = await restarted.syncNow();
	assert.deepEqual(restartedRemote.readCalls, []);
	assert.equal(resumed.bytes, 8);

	// A state file describing a DIFFERENT transcript would skip bytes that this file
	// never had, so it is ignored and the local byte count seeds the offset instead.
	const otherPath = path.join(dir, "other.jsonl");
	writeFileSync(otherPath, "keep\n");
	const stranger = new LiveMirror({ localPath: otherPath, remote: new FakeRemote("keep\n"), statePath });
	assert.equal(stranger.facts().offset, 5);
});

test("a corrupt state file is ignored, not fatal", async (t) => {
	const { localPath, statePath } = fixture(t);
	writeFileSync(localPath, "seed\n");
	mkdirSync(path.dirname(statePath), { recursive: true });
	writeFileSync(statePath, "{not json");

	const mirror = new LiveMirror({ localPath, remote: new FakeRemote("seed\nmore\n"), statePath });
	assert.equal(mirror.facts().offset, 5);
	const facts = await mirror.syncNow();
	assert.equal(facts.bytes, 10);
	assert.equal(facts.error, undefined);
});

// ── resolveLiveMirrorConfig ───────────────────────────────────────────────

test("resolveLiveMirrorConfig: the frozen defaults", () => {
	const config = resolveLiveMirrorConfig({ env: {} });
	assert.deepEqual(config, {
		enabled: true,
		intervalMs: LIVE_MIRROR_INTERVAL_MS,
		maxBytes: LIVE_MIRROR_MAX_BYTES,
	});
	assert.equal(LIVE_MIRROR_INTERVAL_MS, 5_000);
	assert.equal(LIVE_MIRROR_MAX_BYTES, 4 * 1024 * 1024);
	assert.equal(LIVE_MIRROR_CHUNK_BYTES, 256 * 1024);
});

test("resolveLiveMirrorConfig: PI_LEGION_LIVE_MIRROR turns the pump off (off/0/false, any case)", () => {
	for (const word of ["off", "0", "false", "OFF", "False", " off ", " 0 "]) {
		const config = resolveLiveMirrorConfig({ env: { [LIVE_MIRROR_ENV]: word } });
		assert.equal(config.enabled, false, `${JSON.stringify(word)} must disable the pump`);
	}
	for (const word of ["on", "1", "true", "", "  "]) {
		const config = resolveLiveMirrorConfig({ env: { [LIVE_MIRROR_ENV]: word } });
		assert.equal(config.enabled, true, `${JSON.stringify(word)} must not disable the pump`);
	}
	// The kill switch wins over a settings block that says otherwise.
	assert.equal(resolveLiveMirrorConfig({ env: { [LIVE_MIRROR_ENV]: "off" }, overrides: { enabled: true } }).enabled, false);
	// ...and a settings block can disable it on its own.
	assert.equal(resolveLiveMirrorConfig({ env: {}, overrides: { enabled: false } }).enabled, false);
});

test("resolveLiveMirrorConfig: non-positive-integer values fall back to the defaults", () => {
	for (const word of ["", " ", "abc", "0", "-5", "1.5", "1e3", "500ms"]) {
		const config = resolveLiveMirrorConfig({
			env: { [LIVE_MIRROR_INTERVAL_ENV]: word, [LIVE_MIRROR_MAX_BYTES_ENV]: word },
		});
		assert.equal(config.intervalMs, LIVE_MIRROR_INTERVAL_MS, `${JSON.stringify(word)} is not a positive integer`);
		assert.equal(config.maxBytes, LIVE_MIRROR_MAX_BYTES, `${JSON.stringify(word)} is not a positive integer`);
	}
	// A finite non-integer NUMBER (a settings block, not env) is refused too.
	const numeric = resolveLiveMirrorConfig({ env: {}, overrides: { intervalMs: 1.5, maxBytes: 0 } });
	assert.equal(numeric.intervalMs, LIVE_MIRROR_INTERVAL_MS);
	assert.equal(numeric.maxBytes, LIVE_MIRROR_MAX_BYTES);
});

test("resolveLiveMirrorConfig: env wins over overrides, and both are floored", () => {
	const fromEnv = resolveLiveMirrorConfig({
		env: { [LIVE_MIRROR_INTERVAL_ENV]: "1500", [LIVE_MIRROR_MAX_BYTES_ENV]: "65536" },
		overrides: { intervalMs: 9000, maxBytes: 1024 },
	});
	assert.equal(fromEnv.intervalMs, 1500);
	assert.equal(fromEnv.maxBytes, 65_536);

	const fromOverrides = resolveLiveMirrorConfig({ env: {}, overrides: { intervalMs: 2000, maxBytes: 8192 } });
	assert.equal(fromOverrides.intervalMs, 2000);
	assert.equal(fromOverrides.maxBytes, 8192);

	// Floors: a 100 ms interval would hammer the target 10×/s, and a 10-byte cap would
	// leave a useless mirror.
	const floored = resolveLiveMirrorConfig({
		env: { [LIVE_MIRROR_INTERVAL_ENV]: "100", [LIVE_MIRROR_MAX_BYTES_ENV]: "10" },
	});
	assert.equal(floored.intervalMs, LIVE_MIRROR_MIN_INTERVAL_MS);
	assert.equal(floored.maxBytes, LIVE_MIRROR_MIN_MAX_BYTES);
	assert.equal(LIVE_MIRROR_MIN_INTERVAL_MS, 500);
	assert.equal(LIVE_MIRROR_MIN_MAX_BYTES, 4096);
});

test("resolveLiveMirrorConfig: no input reads process.env and stays quiet when it is unset", () => {
	const saved = process.env[LIVE_MIRROR_ENV];
	delete process.env[LIVE_MIRROR_ENV];
	try {
		assert.equal(resolveLiveMirrorConfig().enabled, true);
	} finally {
		if (saved !== undefined) process.env[LIVE_MIRROR_ENV] = saved;
	}
});

// ── liveMirrorStatePathFor ────────────────────────────────────────────────

test("liveMirrorStatePathFor: <dir>/remote/<name>.mirror.json", () => {
	assert.equal(
		liveMirrorStatePathFor("/run/r-1/worker-0.jsonl"),
		path.join("/run/r-1", "remote", "worker-0.mirror.json"),
	);
	// The `.jsonl` is replaced, not appended to: one mirror, one state row.
	assert.equal(liveMirrorStatePathFor("/x/a.jsonl"), path.join("/x", "remote", "a.mirror.json"));
	// A file that is not `.jsonl` keeps its whole basename.
	assert.equal(liveMirrorStatePathFor("/x/a.json"), path.join("/x", "remote", "a.json.mirror.json"));
	// The state lives NEXT TO the collect-time read-back, never on top of it.
	assert.notEqual(liveMirrorStatePathFor("/x/a.jsonl"), path.join("/x", "remote", "a.jsonl"));
});
