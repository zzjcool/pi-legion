/**
 * The `(path, size, mtimeMs)` parse gate (#348).
 *
 * The 500ms status refresh (`runtime.refreshUi()` → `statusEntries()` →
 * `progressFromSessionFile`) used to parse every child's session file twice a
 * second even when nothing was written: 119 opens for one idle child in 60s,
 * and a 64-entry incremental cache made that a cold re-read of every file once
 * a session carried more than 64 session files (CPU 3% → 13.15%).
 *
 * These cases pin the contract of `parseSessionFileCached`: an unchanged file
 * is answered from `stat` alone, an append or a same-length rewrite is visible,
 * 100 files do not thrash the bound, and a caller cannot poison the entry.
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

		assert.deepEqual(sessionFileCacheStats(), { hits: 2, misses: 1, size: 1 });
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

test("#348: 100 session files are visited twice without thrashing the cache", async () => {
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
		assert.ok(
			SESSION_FILE_CACHE_MAX_ENTRIES > secondPass.size,
			`the bound (${SESSION_FILE_CACHE_MAX_ENTRIES}) must sit above a 100-file sweep`,
		);
	});
});

test("#348: a caller cannot poison the cached parse by mutating the result", async () => {
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
