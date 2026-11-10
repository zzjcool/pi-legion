/**
 * #391 — the 500ms sweep (`refreshUi()` → `statusEntries()`) must cost what the
 * ledger is *doing*, not what it *has done*.
 *
 * The reported session had 279 ledger rows (2 running, 277 terminal) over 279
 * distinct session files, 134.5 MB in total. Every tick folded all 279 files,
 * and `SESSION_FILE_CACHE_MAX_ENTRIES = 256` meant the sweep was wider than the
 * cache, so the hit rate was exactly 0: 134.5 MB re-read twice a second on the
 * main thread (142–148 MB/s `rchar`, 126–133 % CPU at idle).
 *
 * `LiveProgress` is a pure function of the file (`progressFromSession` never
 * reads a clock), so a terminal row only has to be folded once. These cases pin
 * that: terminal rows leave the per-tick parse path, live rows keep it, a
 * resumed (and re-settled) row re-reads its file instead of replaying the old
 * answer, two rows that share a transcript are parsed once per sweep, the
 * revalidation window actually revalidates, and an empty answer is never memoized
 * (a missing transcript must not be pinned as "zero tokens").
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import { sessionFileCacheStats } from "../../src/shared/session.ts";
import { createSessionRuntime } from "../../src/extension/runtime.ts";
import type { TreeNodeSnapshot } from "../../src/tui/tree-view.ts";
import { withTempDir } from "../helpers/tmp.ts";

/** When the seeded terminal rows settled. Well inside the orphan horizon at `now`. */
const SETTLED_AT = 1_000;
/** A frozen clock: nothing here may depend on wall time. */
const NOW = 10_000;
/** Mirrors `TERMINAL_PROGRESS_TTL_MS` in runtime.ts — the revalidation window. */
const TTL_MS = 30_000;

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

/** Two turns of JSONL; the fold totals `output: 2` twice, so `tokensOut` is 4. */
const twoTurns = (lastText: string): string =>
	`${user("a")}\n${asst("one")}\n${user("b")}\n${asst(lastText)}\n`;

function treeNode(
	id: string,
	parentId: string | null,
	name: string,
	depth: number,
	sessionFile: string | null,
	status: TreeNodeSnapshot["status"] = "running",
	updatedAt = 0,
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
		status,
		phase: null,
		phaseSince: null,
		reworkCount: 0,
		contractPath: null,
		taskSummary: null,
		createdAt: 0,
		updatedAt,
	};
}

test("#391: 300 terminal rows and 2 running rows parse only the running ones", async () => {
	await withTempDir((dir) => {
		const nodes: TreeNodeSnapshot[] = [treeNode("root", null, "root", 0, null, "running")];
		// The reported distribution: everything but a couple of rows has settled.
		// All three final statuses are seeded, because the memo must cover all three.
		const finalStatuses = ["settled", "failed", "retired"] as const;
		for (let i = 0; i < 300; i += 1) {
			const file = path.join(dir, `final-${i}.jsonl`);
			fs.writeFileSync(file, twoTurns(`final-${i}`));
			nodes.push(treeNode(`root.s${i}`, "root", `s${i}`, 1, file, finalStatuses[i % 3], SETTLED_AT));
		}
		for (let i = 0; i < 2; i += 1) {
			const file = path.join(dir, `live-${i}.jsonl`);
			fs.writeFileSync(file, twoTurns(`live-${i}`));
			nodes.push(treeNode(`root.l${i}`, "root", `l${i}`, 1, file, "running"));
		}
		const runtime = createSessionRuntime({
			sendMessage() {},
			getTreeNodes: () => nodes,
			now: () => NOW,
		});
		try {
			// Warm twice: the terminal memo is filled on the first sight of each
			// terminal row, and the second pass drops any warm-up cache pressure, so
			// the measurement cannot depend on the row order `getTreeNodes()` uses.
			runtime.refreshUi();
			runtime.refreshUi();
			const before = sessionFileCacheStats();

			for (let tick = 0; tick < 10; tick += 1) runtime.refreshUi();

			const after = sessionFileCacheStats();
			const stats = {
				statCalls: after.statCalls - before.statCalls,
				misses: after.misses - before.misses,
				hits: after.hits - before.hits,
			};
			assert.equal(stats.statCalls, 20, "only the two running rows may touch the gate: 2 rows x 10 ticks");
			assert.equal(stats.misses, 0, "neither the terminal nor the unchanged running files are re-parsed");
			assert.equal(stats.hits, 20, "every running row is served from the stat gate");
			assert.equal(
				stats.hits / (stats.hits + stats.misses),
				1,
				"the reported cliff was a hit rate of exactly 0 at 279 files > 256",
			);

			// Every final status is memoized, and the row still carries the facts the
			// panel renders (output tokens, finished stamp) — leaving the parse path
			// must not blank a row.
			for (const name of ["s0", "s1", "s2"]) {
				const entry = runtime.statusEntries().find((e) => e.name === name);
				assert.equal(entry?.tokensOut, 4, `a memoized ${name} row still reports its output tokens`);
				assert.equal(entry?.finishedAt, SETTLED_AT, "a terminal row is stamped with its own updatedAt");
			}
			assert.equal(
				runtime.statusEntries().filter((e) => e.name === "s1")[0]?.state,
				"failed",
				"the projection keeps the status the ledger recorded",
			);
			assert.equal(
				runtime.statusEntries().filter((e) => e.name === "s2")[0]?.state,
				"retired",
			);
		} finally {
			runtime.dispose();
		}
	});
});

test("#391: a live row keeps being re-read when its transcript grows", async () => {
	await withTempDir((dir) => {
		const file = path.join(dir, "live.jsonl");
		fs.writeFileSync(file, twoTurns("one"));
		const nodes = [treeNode("root", null, "root", 0, null, "running"), treeNode("root.w", "root", "w", 1, file, "running")];
		const runtime = createSessionRuntime({
			sendMessage() {},
			getTreeNodes: () => nodes,
			now: () => NOW,
		});
		try {
			runtime.refreshUi();
			assert.equal(runtime.statusEntries().find((e) => e.nodeId === "root.w")?.tokensOut, 4);

			fs.appendFileSync(file, `${user("c")}\n${asst("three")}\n`);
			runtime.refreshUi();
			assert.equal(
				runtime.statusEntries().find((e) => e.nodeId === "root.w")?.tokensOut,
				6,
				"a live row is never memoized — the appended turn must show up on the next tick",
			);
		} finally {
			runtime.dispose();
		}
	});
});

test("#391: resume bypasses the memo, and settling again re-reads the file", async () => {
	await withTempDir((dir) => {
		const file = path.join(dir, "child.jsonl");
		fs.writeFileSync(file, twoTurns("one"));
		const node = treeNode("root.w", "root", "w", 1, file, "settled", SETTLED_AT);
		const nodes = [treeNode("root", null, "root", 0, null, "running"), node];
		const runtime = createSessionRuntime({
			sendMessage() {},
			getTreeNodes: () => nodes,
			now: () => NOW,
		});
		try {
			runtime.refreshUi();
			assert.equal(runtime.statusEntries().find((e) => e.nodeId === "root.w")?.tokensOut, 4);

			// `resume` pulls the row back to `running` (orchestrator writes `starting`
			// first); the live path must parse again even though the memo has an entry.
			node.status = "running";
			node.updatedAt = NOW;
			fs.appendFileSync(file, `${user("c")}\n${asst("three")}\n`);
			runtime.refreshUi();
			assert.equal(
				runtime.statusEntries().find((e) => e.nodeId === "root.w")?.tokensOut,
				6,
				"a resumed row is live again, so its new turn is visible",
			);

			// It settles again with a new stamp: the memo guard is per row, so this
			// re-reads instead of replaying the pre-resume answer.
			node.status = "settled";
			node.updatedAt = NOW + 5_000;
			runtime.refreshUi();
			const entry = runtime.statusEntries().find((e) => e.nodeId === "root.w");
			assert.equal(entry?.tokensOut, 6);
			assert.equal(entry?.finishedAt, NOW + 5_000);
		} finally {
			runtime.dispose();
		}
	});
});

test("#391: two rows sharing one session file are parsed once per sweep", async () => {
	await withTempDir((dir) => {
		const file = path.join(dir, "shared.jsonl");
		fs.writeFileSync(file, twoTurns("one"));
		const nodes = [
			treeNode("root", null, "root", 0, null, "running"),
			treeNode("root.a", "root", "a", 1, file, "running"),
			treeNode("root.b", "root", "b", 1, file, "running"),
		];
		const runtime = createSessionRuntime({
			sendMessage() {},
			getTreeNodes: () => nodes,
			now: () => NOW,
		});
		try {
			runtime.refreshUi();
			const before = sessionFileCacheStats();
			runtime.refreshUi();

			const after = sessionFileCacheStats();
			assert.equal(after.statCalls - before.statCalls, 1, "one stat for the one distinct file in this sweep");
			assert.equal(after.hits - before.hits, 1, "the second row is served from the per-sweep map, not a second stat");
			assert.equal(after.misses - before.misses, 0);
			const entries = runtime.statusEntries().filter((entry) => entry.name === "a" || entry.name === "b");
			assert.deepEqual(entries.map((entry) => entry.tokensOut), [4, 4], "both rows still carry the fold");
		} finally {
			runtime.dispose();
		}
	});
});

/*
 * The revalidation window exists for the one class of terminal rows whose
 * transcript is NOT final at the stamp: the shutdown hook retires still-running
 * children and only then drains them, and `liveness()` can render a dead row as
 * `failed` while its writer is still flushing. Without the window those values
 * freeze for the lifetime of the process; with it they converge within 30s.
 *
 * Deleting the TTL check (or making it `Infinity`) leaves every other case in
 * this file green — this is the case that pins it.
 */
test("#391: a terminal row is revalidated once the window expires, and the drained turn converges", async () => {
	await withTempDir((dir) => {
		const file = path.join(dir, "drained.jsonl");
		fs.writeFileSync(file, twoTurns("one"));
		const node = treeNode("root.w", "root", "w", 1, file, "retired", SETTLED_AT);
		const nodes = [treeNode("root", null, "root", 0, null, "running"), node];
		let clock = NOW;
		const runtime = createSessionRuntime({
			sendMessage() {},
			getTreeNodes: () => nodes,
			now: () => clock,
		});
		try {
			runtime.refreshUi();
			const before = sessionFileCacheStats();
			runtime.refreshUi();
			const inside = sessionFileCacheStats();
			assert.equal(inside.statCalls - before.statCalls, 0, "inside the window a terminal row costs no stat at all");

			// The child was retired first and drained afterwards: the file grew once
			// nothing was polling it.
			fs.appendFileSync(file, `${user("c")}\n${asst("three")}\n`);
			clock += TTL_MS + 1;
			runtime.refreshUi();
			assert.equal(
				runtime.statusEntries().find((e) => e.nodeId === "root.w")?.tokensOut,
				6,
				"the expired window must re-read the file, not serve the stamp-time answer",
			);

			// And the fresh answer is memoized again: one stat per window, no more.
			const afterRevalidate = sessionFileCacheStats();
			runtime.refreshUi();
			assert.equal(
				sessionFileCacheStats().statCalls - afterRevalidate.statCalls,
				0,
				"the revalidated answer is memoized for the next window",
			);
		} finally {
			runtime.dispose();
		}
	});
});

/*
 * An empty answer must never be memoized. `progressFromSessionFile` folds a
 * missing or unreadable file to `{}`, and `session.ts` deliberately refuses to
 * cache that ("a settled session file never moves again, so caching that empty
 * value would pin the status rows at zero for the rest of the process"). The
 * memo honours the same rule: the file appears, the next tick sees it.
 */
test("#391: a missing terminal transcript is retried, not pinned as zero for the window", async () => {
	await withTempDir((dir) => {
		const file = path.join(dir, "later.jsonl");
		const node = treeNode("root.w", "root", "w", 1, file, "settled", SETTLED_AT);
		node.tokensOut = 7;
		const nodes = [treeNode("root", null, "root", 0, null, "running"), node];
		const runtime = createSessionRuntime({
			sendMessage() {},
			getTreeNodes: () => nodes,
			now: () => NOW,
		});
		try {
			runtime.refreshUi();
			assert.equal(
				runtime.statusEntries().find((e) => e.nodeId === "root.w")?.tokensOut,
				7,
				"a missing transcript falls back to the ledger's own total",
			);

			fs.writeFileSync(file, twoTurns("now-here"));
			runtime.refreshUi();
			assert.equal(
				runtime.statusEntries().find((e) => e.nodeId === "root.w")?.tokensOut,
				4,
				"the file appeared, so the very next tick reads it instead of waiting out the window",
			);
		} finally {
			runtime.dispose();
		}
	});
});
