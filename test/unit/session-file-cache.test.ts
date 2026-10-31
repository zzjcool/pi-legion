/**
 * The `(path, size, mtimeMs)` parse gate (#348).
 *
 * The 500ms status refresh (`runtime.refreshUi()` → `statusEntries()` →
 * `progressFromSessionFile`) used to parse every child's session file twice a
 * second even when nothing was written: 119 opens for one idle child in 60s.
 *
 * These cases pin the contract of `parseSessionFileCached`: an unchanged file
 * is answered from `stat` alone, an append or a same-length rewrite is visible,
 * a read failure is never cached as "empty", the bound is a hard LRU limit, and
 * a caller cannot poison the entry.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import {
	clearSessionFileCache,
	parseSessionFileCached,
	SESSION_FILE_CACHE_MAX_ENTRIES,
	sessionFileCacheHas,
	sessionFileCacheStats,
} from "../../src/shared/session.ts";
import { createSessionRuntime } from "../../src/extension/runtime.ts";
import type { TreeNodeSnapshot } from "../../src/tui/tree-view.ts";
import { withTempDir } from "../helpers/tmp.ts";

const user = (t: string): string =>
	JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: t }] } });
const asst = (t: string): string =>
	JSON.stringify({
		type: "message",
		message: {
			role: "assistant",
			content: [{ type: "text", text: t }],
			stopReason: "stop",
			usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
		},
	});

/** Two turns of JSONL: exactly the shape `parseSessionFile` folds. */
const twoTurns = (lastText: string): string =>
	`${user("a")}\n${asst("one")}\n${user("b")}\n${asst(lastText)}\n`;

test("#348: an unchanged session file is parsed once, then served from the stat gate", async () => {
	await withTempDir((dir) => {
		const file = path.join(dir, "s.jsonl");
		fs.writeFileSync(file, twoTurns("two"));
		clearSessionFileCache();

		const first = parseSessionFileCached(file);
		const second = parseSessionFileCached(file);
		const third = parseSessionFileCached(file);

		assert.deepEqual(sessionFileCacheStats(), { hits: 2, misses: 1, size: 1, statCalls: 3 });
		assert.equal(second.turns.length, first.turns.length);
		assert.equal(third.lastTurnOutput, "two");
		// two assistant messages, each `output: 2` — the fold totals them.
		assert.equal(third.usage.output, 4);
		assert.ok(sessionFileCacheHas(file));
	});
});

test("#348: an appended line is re-parsed and the new content shows up", async () => {
	await withTempDir((dir) => {
		const file = path.join(dir, "s.jsonl");
		fs.writeFileSync(file, twoTurns("two"));
		clearSessionFileCache();
		assert.equal(parseSessionFileCached(file).turns.length, 2);

		fs.appendFileSync(file, `${user("c")}\n${asst("three")}\n`);
		const grown = parseSessionFileCached(file);

		assert.equal(sessionFileCacheStats().misses, 2, "a grown file must be parsed again");
		assert.equal(grown.turns.length, 3);
		assert.equal(grown.lastTurnOutput, "three", "the appended turn is visible, not the cached one");
		assert.equal(sessionFileCacheStats().hits, 0);
	});
});

test("#348: a same-length rewrite with a new mtime is re-parsed", async () => {
	await withTempDir((dir) => {
		const file = path.join(dir, "s.jsonl");
		// "old" and "new" differ in content but not in byte length.
		fs.writeFileSync(file, twoTurns("old"));
		clearSessionFileCache();
		assert.equal(parseSessionFileCached(file).lastTurnOutput, "old");
		const before = fs.statSync(file);

		fs.writeFileSync(file, twoTurns("new"));
		assert.equal(fs.statSync(file).size, before.size, "the rewrite must keep the byte length");
		// Force the mtime to move: this is the half of the key that catches a
		// rewrite, and the test must not depend on the write landing in a later
		// millisecond than the original.
		fs.utimesSync(file, before.atime, new Date(before.mtimeMs + 1_000));

		const rewritten = parseSessionFileCached(file);
		assert.equal(sessionFileCacheStats().misses, 2, "size is unchanged, so mtime must invalidate");
		assert.equal(rewritten.lastTurnOutput, "new");
		assert.equal(sessionFileCacheStats().size, 1, "the stale entry is replaced, not duplicated");
	});
});

test("#348: 100 session files are visited twice without a thrash, well under the bound", async () => {
	await withTempDir((dir) => {
		const files = Array.from({ length: 100 }, (_, i) => {
			const file = path.join(dir, `s-${i}.jsonl`);
			fs.writeFileSync(file, twoTurns(`turn-${i}`));
			return file;
		});
		clearSessionFileCache();

		for (const file of files) parseSessionFileCached(file);
		const firstPass = sessionFileCacheStats();
		for (const file of files) parseSessionFileCached(file);
		const secondPass = sessionFileCacheStats();

		assert.equal(firstPass.misses, 100);
		assert.equal(secondPass.misses, 100, "a second sweep must not re-parse a single file");
		assert.equal(secondPass.hits, 100);
		assert.equal(secondPass.size, 100);
		assert.equal(secondPass.statCalls, 200, "one stat per file per sweep, nothing else");
	});
});

/*
 * The bound and its ORDER, which no other case covers: a suite that only ever
 * fills 100 of 256 slots asserts nothing about eviction (a test whose last line
 * is `MAX > size` stays green when the bound is deleted outright). This is the
 * same fill-touch-insert shape as the inner cache's LRU case in
 * session-stream.test.ts, and it is the only assertion that separates LRU from
 * FIFO: after filling to the cap, the OLDEST path is touched, one new file is
 * inserted, and the eviction must take the second-oldest instead.
 */
test("#348: the file cache is a hard bound and evicts the least-recently-used path, not the oldest", async () => {
	await withTempDir((dir) => {
		const files = Array.from({ length: SESSION_FILE_CACHE_MAX_ENTRIES }, (_, i) => {
			const file = path.join(dir, `s-${i}.jsonl`);
			fs.writeFileSync(file, twoTurns(`turn-${i}`));
			return file;
		});
		clearSessionFileCache();
		for (const file of files) parseSessionFileCached(file);
		assert.equal(sessionFileCacheStats().size, SESSION_FILE_CACHE_MAX_ENTRIES);
		assert.equal(sessionFileCacheStats().hits, 0);

		// Insertion order is files[0] .. files[255]; touch the head so it moves to tail.
		parseSessionFileCached(files[0] as string);

		const overflow = path.join(dir, "overflow.jsonl");
		fs.writeFileSync(overflow, twoTurns("overflow"));
		parseSessionFileCached(overflow);

		assert.equal(
			sessionFileCacheStats().size,
			SESSION_FILE_CACHE_MAX_ENTRIES,
			"the bound is a hard limit, not advice — an unbounded map would report 257",
		);
		assert.equal(sessionFileCacheHas(files[0] as string), true, "a touched entry must survive (FIFO would drop it)");
		assert.equal(sessionFileCacheHas(files[1] as string), false, "the least-recently-used entry is the one evicted");
		assert.equal(sessionFileCacheHas(overflow), true);

		// And the evicted path is a real miss next time, not a silent stale hit.
		const misses = sessionFileCacheStats().misses;
		assert.equal(parseSessionFileCached(files[1] as string).lastTurnOutput, "turn-1");
		assert.equal(sessionFileCacheStats().misses, misses + 1, "an evicted path is re-parsed, not served stale");
		assert.equal(sessionFileCacheStats().size, SESSION_FILE_CACHE_MAX_ENTRIES);
	});
});

/*
 * The reviewer's F1: `parseSessionFile` answers a failed OPEN/READ with the same
 * empty value it answers an empty file, and the miss path used to cache that
 * value against `(size, mtimeMs)`. Nothing moves those two after a session
 * settles — `chmod` only bumps `ctime`, which is not part of the key — so a
 * single EACCES/EMFILE/EIO pinned `/legion summary` and every status row at 0
 * for the rest of the process (the "token rate reads 0 for the agent's entire
 * lifetime" symptom in runtime.ts).
 *
 * This case is skipped as root: root can read a 000-mode file, so there is no
 * failure to reproduce. CI (and any non-root run) exercises it for real.
 */
const unreadableIsUnreadable = (process.getuid?.() ?? 0) !== 0;

test(
	"#348: an unreadable session file is not pinned as empty — it is re-read when it becomes readable",
	{ skip: unreadableIsUnreadable ? false : "running as root: chmod 000 does not stop reads" },
	async () => {
		await withTempDir((dir) => {
			const file = path.join(dir, "s.jsonl");
			fs.writeFileSync(file, twoTurns("two"));
			clearSessionFileCache();

			fs.chmodSync(file, 0o000);
			let denied: ReturnType<typeof parseSessionFileCached>;
			try {
				denied = parseSessionFileCached(file);
			} finally {
				// Restore first: `chmod` moves ctime only, so `(size, mtimeMs)` is
				// byte-for-byte what the failed read saw — exactly the state a pinned
				// empty entry would answer from forever.
				fs.chmodSync(file, 0o644);
			}
			assert.equal(denied.turns.length, 0, "an unreadable file parses as empty");
			assert.equal(denied.tornLines, 0);
			assert.equal(sessionFileCacheHas(file), false, "a read failure must not enter the cache");

			const recovered = parseSessionFileCached(file);
			assert.equal(recovered.turns.length, 2, "the same (size, mtimeMs) must not still answer empty");
			assert.equal(recovered.lastTurnOutput, "two", "the restored file is re-read, not served from a pinned empty");
			assert.equal(recovered.usage.output, 4);
		});
	},
);

/*
 * Root-safe companion to the chmod case: a directory stats fine (`size` 4096 on
 * ext4/overlayfs, non-zero on tmpfs) but cannot be read, which is the exact
 * shape of the bug — stat succeeds, the parse does not. Removing the
 * "unreadable is not cacheable" branch turns the second tick into a cache HIT.
 */
test("#348: a read failure is retried every tick instead of freezing an empty entry", async () => {
	await withTempDir((dir) => {
		const file = path.join(dir, "s.jsonl");
		fs.mkdirSync(file);
		clearSessionFileCache();

		assert.equal(parseSessionFileCached(file).turns.length, 0);
		assert.equal(parseSessionFileCached(file).turns.length, 0);

		const stats = sessionFileCacheStats();
		assert.equal(stats.hits, 0, "the second tick must re-attempt the read, not hit an empty entry");
		assert.equal(stats.misses, 2);
		assert.equal(stats.size, 0, "an unreadable path takes no cache slot");
		assert.equal(sessionFileCacheHas(file), false);

		// Same path, now a readable file: the next tick gets the real content.
		fs.rmdirSync(file);
		fs.writeFileSync(file, twoTurns("two"));
		assert.equal(parseSessionFileCached(file).lastTurnOutput, "two");
		assert.equal(sessionFileCacheStats().size, 1);
	});
});

/*
 * The name says what is guaranteed, because the guarantee is about DEPTH: the
 * top level, `usage` and the `turns` ARRAY are copied, so a caller's write to
 * those cannot land in the cache.
 *
 * Deeper sharing (a turn record, its assistants) is deliberate, not an
 * oversight — see `cacheSafeCopy`: nothing in `src/` mutates a turn after the
 * fold, and copying every turn per poll is precisely the cost #348 removed. The
 * last assertion pins that intent so a future "fix" to deep-copy is a decision,
 * not an accident.
 */
test("#348: a caller cannot poison the cached fields, usage or turn list (turn records stay shared by design)", async () => {
	await withTempDir((dir) => {
		const file = path.join(dir, "s.jsonl");
		fs.writeFileSync(file, twoTurns("two"));
		clearSessionFileCache();

		const first = parseSessionFileCached(file);
		first.output = "poisoned";
		first.lastTurnOutput = "poisoned";
		first.usage.input = -1;
		first.turns.length = 0;

		const second = parseSessionFileCached(file);
		assert.equal(sessionFileCacheStats().hits, 1);
		assert.equal(second.lastTurnOutput, "two");
		assert.equal(second.output, "two");
		assert.equal(second.usage.input, 2, "the cached total survives a caller's write");
		assert.equal(second.turns.length, 2);
		assert.equal(
			Object.is(second.turns[0], parseSessionFileCached(file).turns[0]),
			true,
			"turn records are shared on purpose (cacheSafeCopy documents the depth)",
		);
	});
});

function treeNode(
	id: string,
	parentId: string | null,
	name: string,
	depth: number,
	sessionFile: string | null,
): TreeNodeSnapshot {
	return {
		id,
		parentId,
		name,
		role: name === "root" ? "root" : "worker",
		kind: "pi",
		depth,
		runId: null,
		sessionFile,
		worktreePath: null,
		model: null,
		team: null,
		status: "running",
		phase: null,
		phaseSince: null,
		reworkCount: 0,
		contractPath: null,
		taskSummary: null,
		createdAt: 0,
		updatedAt: 0,
	};
}

test("#348: ten status refreshes over an unchanged session file parse it exactly once", async () => {
	await withTempDir((dir) => {
		const file = path.join(dir, "child.jsonl");
		fs.writeFileSync(file, twoTurns("two"));
		const nodes = [
			treeNode("root", null, "root", 0, null),
			treeNode("root.worker", "root", "worker", 1, file),
		];
		const runtime = createSessionRuntime({
			sendMessage() {},
			getTreeNodes: () => nodes,
			now: () => 10_000,
		});
		try {
			// setup (snapshotNodes/refreshUi inside the constructor and track()) is
			// not part of the measurement.
			runtime.refreshUi();
			clearSessionFileCache();

			for (let tick = 0; tick < 10; tick += 1) runtime.refreshUi();

			const stats = sessionFileCacheStats();
			assert.equal(stats.misses, 1, "the session file is parsed on the first refresh only");
			assert.equal(stats.hits, 9, "the remaining nine ticks are served from the stat gate");
			assert.equal(
				runtime.statusEntries().find((entry) => entry.nodeId === "root.worker")?.tokensOut,
				4,
				"the served rows still carry the parsed facts",
			);
		} finally {
			runtime.dispose();
		}
	});
});
