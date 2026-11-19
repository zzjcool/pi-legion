/**
 * #411 — the invariants the first pass could not pin.
 *
 * Three review findings are about evidence, not behaviour: a green suite that would
 * stay green if the code were broken. They get their own file rather than more
 * cases in `live-mirror.test.ts`, because each one pins a DIFFERENT thing than that
 * file's eight invariants:
 *
 *   1. **The transport.** `createLiveMirrorRemote` builds the two `machine.exec`
 *      argv it sends to another machine — `wc -c` and `tail -c +N`. `tail -c +N` is
 *      1-based, so an off-by-one there shifts every later chunk by one byte and
 *      permanently shreds the mirror. Nothing exercised it before this file.
 *   2. **Inode stability.** The steady-state write is an append, so the repository's
 *      `dev`/`ino`-keyed incremental parser keeps its cache; only a cap trim or a
 *      shrink reset replaces the file. Assert on `statSync().ino`, not on bytes: an
 *      in-place rewrite and an atomic replace are indistinguishable by content.
 *   3. **A no-op tick touches nothing.** `quiet` is derived from the mirror's
 *      `mtimeMs` (`runtime.ts` → `lastJsonlEventAgeMs`), so a pump that rewrote the
 *      file on every tick would report `quiet 0s` forever and defeat the whole point
 *      of #411's second symptom.
 *   4. **A row bigger than the read window must not stall the pump.** Growing the
 *      window is the only answer that neither stalls nor drops bytes.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import type { HcClient, HcMethod } from "../../src/hc/client.ts";
import {
	createLiveMirrorRemote,
	LiveMirror,
	type LiveMirrorRemote,
} from "../../src/runs/live-mirror.ts";

// ── fixtures ───────────────────────────────────────────────────────────────

interface ExecCall {
	method: HcMethod;
	params: Record<string, unknown>;
}

/**
 * A fake `hc` connection that answers `machine.exec` from one Buffer.
 *
 * `stdout` is BASE64 on the wire (the real core's `ExecResult`), so the fake encodes
 * too: a test that passed plain text through would prove nothing about the one
 * conversion the production reader has to get right.
 */
function fakeClient(answers: { size?: number | null; chunk?: Buffer; failSize?: boolean }): {
	client: HcClient;
	calls: ExecCall[];
} {
	const calls: ExecCall[] = [];
	const client: HcClient = {
		start: async () => {},
		close: () => {},
		request: async <T = unknown>(method: HcMethod, params: Record<string, unknown> = {}): Promise<T> => {
			calls.push({ method, params });
			const argv = Array.isArray(params.argv) ? (params.argv as string[]) : [];
			if (argv[0] === "wc") {
				if (answers.failSize === true) return { code: 1, stdout: "", stderr: "" } as T;
				return { code: 0, stdout: Buffer.from(`${answers.size ?? 0} ${argv[2]}\n`).toString("base64") } as T;
			}
			if (argv[0] === "tail") {
				return { code: 0, stdout: (answers.chunk ?? Buffer.alloc(0)).toString("base64") } as T;
			}
			return { code: 127, stdout: "", stderr: "" } as T;
		},
	};
	return { client, calls };
}

function withDir(t: { after: (fn: () => void) => void }, prefix: string): string {
	const root = mkdtempSync(path.join(tmpdir(), prefix));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	return root;
}

/** A fake remote whose "file on that machine" is one Buffer. */
class BufferRemote implements LiveMirrorRemote {
	data: Buffer;
	closes = 0;
	constructor(initial: string | Buffer = "") {
		this.data = Buffer.from(initial);
	}
	append(text: string): void {
		this.data = Buffer.concat([this.data, Buffer.from(text)]);
	}
	async size(): Promise<number | undefined> {
		return this.data.length;
	}
	async read(from: number, max: number): Promise<Buffer> {
		return this.data.subarray(from, from + max);
	}
	close(): void {
		this.closes += 1;
	}
}

// ── 1. the transport ───────────────────────────────────────────────────────

test("transport: `wc -c` is asked of the RIGHT machine and path, and its first token is the size", async () => {
	const { client, calls } = fakeClient({ size: 4_711 });
	const remote = createLiveMirrorRemote({
		host: "hw-nj",
		name: "child-a",
		remoteDir: "/root/.pi-subagents-mirror/no-run/child-a",
		clientFactory: () => client,
	});
	assert.ok(remote, "a record with a remoteDir must produce a reader");
	assert.equal(await remote.size(), 4_711);
	assert.equal(calls.length, 1);
	const [call] = calls;
	assert.ok(call, "exactly one exec was issued");
	assert.equal(call.method, "machine.exec");
	assert.equal(call.params.on, "hw-nj", "the exec must be addressed to the child's machine");
	assert.deepEqual(call.params.argv, ["wc", "-c", "/root/.pi-subagents-mirror/no-run/child-a/session.jsonl"]);
});

test("transport: `tail -c +N` is 1-based (from 0 asks for +1, from 41 asks for +42) and stdout arrives as raw bytes", async () => {
	const chunk = Buffer.from("héllo\n", "utf8");
	const { client, calls } = fakeClient({ chunk });
	const remote = createLiveMirrorRemote({
		host: "hw-nj",
		name: "child-a",
		remoteDir: "/mirror/child-a",
		clientFactory: () => client,
	});
	assert.ok(remote);
	const first = await remote.read(0, 64);
	assert.deepEqual(calls.at(-1)?.params.argv, ["tail", "-c", "+1", "/mirror/child-a/session.jsonl"]);
	// Byte-identical, not utf8-round-tripped: a multi-byte character split across a
	// chunk boundary must survive.
	assert.deepEqual(first, chunk);
	await remote.read(41, 64);
	assert.deepEqual(calls.at(-1)?.params.argv, ["tail", "-c", "+42", "/mirror/child-a/session.jsonl"]);
});

test("transport: an unknown remoteDir produces NO reader instead of a guessed path", () => {
	assert.equal(createLiveMirrorRemote({ host: "hw-nj", name: "child-a" }), undefined);
	assert.equal(createLiveMirrorRemote({ host: "hw-nj", name: "child-a", remoteDir: "  " }), undefined);
});

test("transport: `wc` failing means 'not written yet' BEFORE any success, and a real failure AFTER one", async () => {
	let fail = true;
	const calls: string[] = [];
	const client: HcClient = {
		start: async () => {},
		close: () => {},
		request: async <T = unknown>(_method: HcMethod, params: Record<string, unknown> = {}): Promise<T> => {
			const argv = Array.isArray(params.argv) ? (params.argv as string[]) : [];
			calls.push(argv[0] ?? "");
			if (fail) return { code: 1, stdout: "", stderr: "No such file" } as T;
			return { code: 0, stdout: Buffer.from("99 /x/session.jsonl\n").toString("base64") } as T;
		},
	};
	const remote = createLiveMirrorRemote({ host: "h", name: "c", remoteDir: "/x", clientFactory: () => client });
	assert.ok(remote);
	assert.equal(await remote.size(), undefined, "a child that has not written its first line yet");
	fail = false;
	assert.equal(await remote.size(), 99);
	fail = true;
	// Same answer, different meaning: the transcript went away after we had it, and
	// reporting that as "0 bytes, all good" is the exact silent-staleness bug #411 is.
	await assert.rejects(() => remote.size(), /wc -c/);
});

// ── 2. inode stability (the parse cache) ───────────────────────────────────

test("an appending tick keeps the INODE (so the incremental parse cache survives); only a cap trim replaces it", async (t) => {
	const dir = withDir(t, "live-mirror-ino-");
	const localPath = path.join(dir, "child.jsonl");
	const remote = new BufferRemote("first\n");
	const mirror = new LiveMirror({ localPath, remote, maxBytes: 24, chunkBytes: 64 });

	await mirror.syncNow();
	const afterFirst = statSync(localPath).ino;
	assert.equal(readFileSync(localPath, "utf8"), "first\n");

	remote.append("second\n");
	await mirror.syncNow();
	assert.equal(readFileSync(localPath, "utf8"), "first\nsecond\n");
	assert.equal(statSync(localPath).ino, afterFirst, "a pure append must not replace the file");

	// Push past maxBytes (24): the head has to go, which is a rewrite, which replaces.
	remote.append("third\nfourth\nfifth\n");
	await mirror.syncNow();
	const trimmed = readFileSync(localPath, "utf8");
	assert.ok(Buffer.byteLength(trimmed) <= 24, `over-cap must trim: ${trimmed}`);
	assert.ok(trimmed.endsWith("\n"), "the trim keeps whole lines");
	assert.ok(trimmed.includes("fifth"), "the TAIL is what survives the cap");
	assert.notEqual(statSync(localPath).ino, afterFirst, "a trim is a replace, not an append");
});

// ── 3. a no-op tick touches nothing (`quiet` depends on it) ────────────────

test("a tick with no new remote bytes touches neither size nor mtime nor inode (else `quiet` could never age)", async (t) => {
	const dir = withDir(t, "live-mirror-noop-");
	const localPath = path.join(dir, "child.jsonl");
	const remote = new BufferRemote("row-1\n");
	const mirror = new LiveMirror({ localPath, remote, chunkBytes: 64 });

	await mirror.syncNow();
	const before = statSync(localPath);
	const factsBefore = mirror.facts();
	assert.equal(factsBefore.bytes, 6);

	// No growth: exactly what the interval timer does over and over while a child thinks.
	await mirror.syncNow();
	await mirror.syncNow();
	const after = statSync(localPath);

	assert.equal(after.size, before.size, "a no-op tick must not change the size");
	assert.equal(after.mtimeMs, before.mtimeMs, "a no-op tick must not bump mtimeMs (`quiet` reads it)");
	assert.equal(after.ino, before.ino, "a no-op tick must not replace the file");
	assert.equal(mirror.facts().lastGrowthAt, factsBefore.lastGrowthAt, "no growth was observed, so no growth is claimed");
});

// ── 4. a row longer than the read window ───────────────────────────────────

test("a single row longer than the read window still lands, whole, in one tick", async (t) => {
	const dir = withDir(t, "live-mirror-bigrow-");
	const localPath = path.join(dir, "child.jsonl");
	// 200 bytes on ONE line — bigger than the 8-byte window the pump starts with.
	const big = `${"x".repeat(199)}\n`;
	const remote = new BufferRemote(big);
	const mirror = new LiveMirror({ localPath, remote, chunkBytes: 8, maxBytes: 4_096 });

	const facts = await mirror.syncNow();
	assert.equal(facts.offset, 200, "the window must grow instead of stalling at offset 0");
	assert.equal(facts.error, undefined);
	assert.equal(readFileSync(localPath, "utf8"), big);

	// And the row after it still arrives on the next tick.
	remote.append("small\n");
	await mirror.syncNow();
	assert.equal(readFileSync(localPath, "utf8"), `${big}small\n`);
});

test("a row bigger than the mirror's own cap is kept torn rather than refusing to mirror anything ever again", async (t) => {
	const dir = withDir(t, "live-mirror-hugetrow-");
	const localPath = path.join(dir, "child.jsonl");
	const huge = "y".repeat(300);
	const remote = new BufferRemote(huge);
	const mirror = new LiveMirror({ localPath, remote, chunkBytes: 8, maxBytes: 64 });

	const facts = await mirror.syncNow();
	assert.ok(facts.offset > 0, "an uncappable row must not freeze the pump");
	assert.ok(statSync(localPath).size > 0);
});

// ── 5. stop() means stop writing ───────────────────────────────────────────

test("stop() prevents a tick that is already in flight from writing anything", async (t) => {
	const dir = withDir(t, "live-mirror-stop-");
	const localPath = path.join(dir, "child.jsonl");
	let release: (() => void) | undefined;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const remote: LiveMirrorRemote = {
		async size(): Promise<number> {
			return 6;
		},
		async read(from: number, max: number): Promise<Buffer> {
			await gate; // the tick is now in flight, holding bytes
			return Buffer.from("row-1\n").subarray(from, from + max);
		},
		close(): void {},
	};
	const mirror = new LiveMirror({ localPath, remote, chunkBytes: 64 });
	const tick = mirror.syncNow();
	mirror.stop();
	release?.();
	await tick;
	assert.equal(existsSync(localPath), false, "a stopped pump must not land the bytes it was holding");
});
