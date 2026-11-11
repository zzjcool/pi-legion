/**
 * Index-layer tests for the wait action.
 *
 * resolveWaitTargets itself is covered by wait-action.test.ts; these lock
 * the wiring around it: the finished-cache probe that lets a just-finished
 * child stay waitable, the strictest-role default timeout (min, not max),
 * and the renderWait summary line. waitAction/renderWait are exported from
 * index.ts precisely so this file can drive them without a fake herdr.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { buildWaitTimeoutDetails, artifactBytesLookup, renderWait, stopAction, waitAction, WAIT_PARENT_DECISIONS, WAIT_TIMEOUT_HINT } from "../../index.ts";
import {
	createSessionRuntime,
	type CollectSnapshot,
	type SessionRuntime,
	type WaitResult,
} from "../../src/extension/runtime.ts";
import { RunStore } from "../../src/runs/store.ts";
import { openLegionDb } from "../../src/legion/db.ts";
import { recordArtifact } from "../../src/legion/ledger.ts";
import { DEFAULTS, type AgentConfig } from "../../src/shared/types.ts";

function snapshot(output: string): CollectSnapshot {
	return {
		execution: { status: "success" },
		output,
		acceptance: { status: "accepted", level: "attested" },
	};
}

function agent(name: string, timeoutMs?: number): AgentConfig {
	return {
		name,
		description: `${name} role`,
		source: "user",
		...(timeoutMs !== undefined ? { timeoutMs } : {}),
	} as AgentConfig;
}

function runtimeWith(jobs: Array<{ name: string; agent: string }>): SessionRuntime {
	const runtime = createSessionRuntime({ sendMessage() {} });
	for (const job of jobs) {
		runtime.track({
			name: job.name,
			runId: "r-1",
			agent: job.agent,
			sessionFile: `/tmp/${job.name}.jsonl`,
			timeoutMs: 1_000,
			// Never resolves: wait() must bail at its own timeout.
			collect: () => new Promise<CollectSnapshot>(() => {}),
		});
	}
	return runtime;
}

function tempStore(): { store: RunStore; cwd: string } {
	const cwd = mkdtempSync(path.join(tmpdir(), "wait-action-"));
	return { store: new RunStore({ rootDir: path.join(cwd, ".pi-subagents") }), cwd };
}

function text(result: { content?: unknown }): string {
	return (result.content as Array<{ text?: string }>)
		.map((c) => c.text ?? "")
		.join("\n");
}

test("waitAction: a finished child is waitable via the finished-cache probe", async () => {
	const runtime = createSessionRuntime({ sendMessage() {} });
	runtime.track({
		name: "done",
		runId: "r-1",
		agent: "worker",
		sessionFile: "/tmp/done.jsonl",
		timeoutMs: 1_000,
		collect: async () => snapshot("cached-output"),
	});
	runtime.watch("done");
	const deadline = Date.now() + 1_000;
	while (runtime.activeJobs().length > 0) {
		if (Date.now() > deadline) throw new Error("watch never settled");
		await new Promise((r) => setTimeout(r, 5));
	}
	// The name is no longer live — resolveWaitTargets misses it — but the
	// finished cache must rescue it instead of reporting an unknown child.
	const { store, cwd } = tempStore();
	const res = await waitAction({
		params: { action: "wait", name: "done" },
		runtime,
		agents: [agent("worker")],
		store,
		cwd,
	});
	assert.match(text(res), /── done ──/);
	assert.match(text(res), /cached-output/);
	assert.match(text(res), /1 done, 0 still running/);
	assert.doesNotMatch(text(res), /unknown child/);
});

test("waitAction: an untracked name with no cache is a loud unknown child", async () => {
	const runtime = runtimeWith([{ name: "live", agent: "worker" }]);
	const { store, cwd } = tempStore();
	const res = await waitAction({
		params: { action: "wait", name: "ghost" },
		runtime,
		agents: [agent("worker")],
		store,
		cwd,
	});
	const details = res.details as { error?: string } | undefined;
	assert.equal(details?.error, "NOT_FOUND");
	assert.match(text(res), /unknown child: ghost/);
	runtime.dispose();
});

test("waitAction: default timeout is the strictest (smallest) role timeout", async () => {
	const calls: Array<{ names: string[]; timeoutMs?: number }> = [];
	const base = runtimeWith([
		{ name: "fast", agent: "worker" },
		{ name: "slow", agent: "oracle" },
	]);
	// Spy on the timeout handed to runtime.wait: min(80, 60_000) = 80.
	const runtime: SessionRuntime = {
		...base,
		wait: (names, opts) => {
			calls.push({ names, timeoutMs: opts?.timeoutMs });
			return Promise.resolve(
				names.map((name) => ({ name, stillRunning: true }) as WaitResult),
			);
		},
	};
	const { store, cwd } = tempStore();
	const res = await waitAction({
		params: { action: "wait", all: true },
		runtime,
		agents: [agent("worker", 80), agent("oracle", 60_000)],
		store,
		cwd,
	});
	assert.equal(calls.length, 1);
	assert.equal(calls[0]?.timeoutMs, 80, "min, not max, of role timeouts");
	assert.match(text(res), /0 done, 2 still running/);
	base.dispose();
});

test("waitAction forwards the parent abort signal into runtime.wait", async () => {
	const base = runtimeWith([{ name: "live", agent: "worker" }]);
	const controller = new AbortController();
	const calls: Array<{ names: string[]; signal?: AbortSignal }> = [];
	const runtime: SessionRuntime = {
		...base,
		wait: (names, opts) => {
			calls.push({ names, signal: opts?.signal });
			return Promise.resolve(names.map((name) => ({ name, interrupted: true })));
		},
	};
	const { store, cwd } = tempStore();
	await waitAction({
		params: { action: "wait", name: "live" },
		signal: controller.signal,
		runtime,
		agents: [agent("worker")],
		store,
		cwd,
	});
	assert.equal(calls.length, 1);
	assert.deepEqual(calls[0], { names: ["live"], signal: controller.signal });
	base.dispose();
});

test("waitAction: targets without a role entry fall back to DEFAULTS.turnTimeoutMs", async () => {
	const calls: Array<{ names: string[]; timeoutMs?: number }> = [];
	const base = runtimeWith([{ name: "mystery", agent: "no-such-role" }]);
	const runtime: SessionRuntime = {
		...base,
		wait: (names, opts) => {
			calls.push({ names, timeoutMs: opts?.timeoutMs });
			return Promise.resolve(
				names.map((name) => ({ name, stillRunning: true }) as WaitResult),
			);
		},
	};
	const { store, cwd } = tempStore();
	const res = await waitAction({
		params: { action: "wait", all: true },
		runtime,
		agents: [agent("worker", 80)],
		store,
		cwd,
	});
	assert.equal(calls.length, 1);
	assert.equal(calls[0]?.timeoutMs, DEFAULTS.turnTimeoutMs);
	assert.match(text(res), /0 done, 1 still running/);
	base.dispose();
});

test("stopAction: all retires active children sequentially and releases each target", async () => {
	const runtime = runtimeWith([
		{ name: "first", agent: "worker" },
		{ name: "already-retired", agent: "worker" },
		{ name: "second", agent: "worker" },
	]);
	runtime.get("already-retired")!.state = "retired";
	const supervisorCalls: string[] = [];
	let retiring = false;
	const supervisor = {
		async retire(name: string) {
			assert.equal(retiring, false, "stop must await each retirement before starting the next");
			retiring = true;
			await Promise.resolve();
			supervisorCalls.push(name);
			retiring = false;
		},
	};
	const result = await stopAction({
		params: { all: true },
		runtime,
		retire: (name) => supervisor.retire(name),
	});
	assert.deepEqual(supervisorCalls, ["first", "second"]);
	assert.deepEqual(runtime.activeJobs().map((job) => job.name), ["already-retired"]);
	assert.match(text(result), /Stopped 2 children/);
	runtime.dispose();
});

test("stopAction: a child that had already settled is reaped, not reported as stopped", async () => {
	const runtime = runtimeWith([
		{ name: "live-child", agent: "worker" },
		{ name: "settled-child", agent: "worker" },
	]);
	// Settled but still tracked: the runtime sets `awaiting` before its watch
	// retires and releases the job, which is the window a stop can land in.
	const settled = runtime.get("settled-child")!;
	settled.state = "awaiting";
	settled.settledAt = Date.parse("2026-01-02T03:04:05.000Z");
	const retired: string[] = [];
	const result = await stopAction({
		params: { all: true },
		runtime,
		retire: async (name) => {
			retired.push(name);
		},
	});
	assert.deepEqual(retired, ["live-child", "settled-child"], "both targets are still retired");
	const rendered = text(result);
	assert.match(rendered, /Stopped 1 child: live-child\./);
	assert.match(
		rendered,
		/Retired 1 already-settled child: settled-child \(settled at 2026-01-02T03:04:05\.000Z\)/,
	);
	assert.doesNotMatch(rendered, /Stopped 2 children|Stopped 1 child: settled-child/);
	runtime.dispose();
});

test("renderWait: summary line counts done and still-running", () => {
	const rendered = renderWait([
		{ name: "a", snapshot: snapshot("A-out") },
		{ name: "b", stillRunning: true, elapsedMs: 42 },
		{ name: "c", missing: true },
	]);
	assert.match(rendered, /── a ──/);
	assert.match(rendered, /A-out/);
	assert.match(rendered, /── b ──\nstill running \(spawned 0\.0s ago\)/);
	assert.match(rendered, /── c ──\nnot tracked/);
	assert.match(rendered, /1 done, 1 still running/);
	assert.match(rendered, /status: still_running/);
	assert.match(rendered, /decisions: extend, steer_again, stop, force_stop/);
	const interrupted = renderWait([{ name: "wait", interrupted: true }]);
	assert.match(interrupted, /── wait ──\ninterrupted \(parent turn ended; children still running\)/);
	assert.match(interrupted, /0 done, 0 still running/);
	assert.match(interrupted, /1 interrupted/);
	assert.doesNotMatch(interrupted, /status:/);
});

test("buildWaitTimeoutDetails: wait_timeout includes decisions and does not imply stop", () => {
	const details = buildWaitTimeoutDetails([
		{ name: "done", snapshot: snapshot("ok") },
		{ name: "live", stillRunning: true, timedOut: true, elapsedMs: 12_345 },
	]);
	assert.ok(details);
	assert.equal(details!.status, "wait_timeout");
	assert.equal(details!.done, 1);
	assert.deepEqual(details!.stillRunning, [{ name: "live", elapsedMs: 12_345 }]);
	assert.deepEqual(details!.decisions, [...WAIT_PARENT_DECISIONS]);
	assert.equal(details!.hint, WAIT_TIMEOUT_HINT);
});

test("buildWaitTimeoutDetails: still_running when no timedOut flag", () => {
	const details = buildWaitTimeoutDetails([
		{ name: "live", stillRunning: true, elapsedMs: 100 },
	]);
	assert.equal(details?.status, "still_running");
});

test("buildWaitTimeoutDetails: undefined when nothing still running", () => {
	assert.equal(
		buildWaitTimeoutDetails([{ name: "a", snapshot: snapshot("x") }]),
		undefined,
	);
});

test("waitAction: timeout details land in tool details (no auto-stop)", async () => {
	const base = runtimeWith([{ name: "live", agent: "worker" }]);
	const runtime: SessionRuntime = {
		...base,
		wait: (names) =>
			Promise.resolve(
				names.map(
					(name) =>
						({
							name,
							stillRunning: true,
							timedOut: true,
							elapsedMs: 500,
						}) as WaitResult,
				),
			),
	};
	const { store, cwd } = tempStore();
	const res = await waitAction({
		params: { action: "wait", name: "live", timeoutMs: 50 },
		runtime,
		agents: [agent("worker")],
		store,
		cwd,
	});
	const details = res.details as {
		status?: string;
		stillRunning?: Array<{ name: string; elapsedMs: number }>;
		decisions?: string[];
		hint?: string;
	};
	assert.equal(details.status, "wait_timeout");
	assert.deepEqual(details.stillRunning, [{ name: "live", elapsedMs: 500 }]);
	assert.deepEqual(details.decisions, [...WAIT_PARENT_DECISIONS]);
	assert.equal(details.hint, WAIT_TIMEOUT_HINT);
	assert.match(text(res), /status: wait_timeout/);
	assert.match(text(res), /decisions: extend, steer_again, stop, force_stop/);
	assert.match(text(res), /hint: wait only stopped waiting: the children are still running/);
	// Children stay tracked — wait must not retire.
	assert.ok(runtime.get("live"));
	base.dispose();
});

test("stopAction: force:true passes graceful:false to retire", async () => {
	const runtime = runtimeWith([{ name: "stubborn", agent: "worker" }]);
	const calls: Array<{ name: string; opts?: { graceful?: boolean } }> = [];
	const result = await stopAction({
		params: { name: "stubborn", force: true },
		runtime,
		retire: async (name, opts) => {
			calls.push({ name, opts });
		},
	});
	assert.deepEqual(calls, [{ name: "stubborn", opts: { graceful: false } }]);
	assert.match(text(result), /force-stopped 1 child: stubborn/);
	assert.equal(runtime.get("stubborn"), undefined);
	runtime.dispose();
});

test("stopAction: omit force keeps graceful default (no graceful:false)", async () => {
	const runtime = runtimeWith([{ name: "soft", agent: "worker" }]);
	const calls: Array<{ name: string; opts?: { graceful?: boolean } }> = [];
	await stopAction({
		params: { name: "soft" },
		runtime,
		retire: async (name, opts) => {
			calls.push({ name, opts });
		},
	});
	assert.deepEqual(calls, [{ name: "soft", opts: undefined }]);
	runtime.dispose();
});

// ────────────────── P5c (result-ledger-v1 §3 D8 v1.12): "this is a summary" ──────────────────
//
// The strip is KEPT (D8 改判): the completion cache still hands a 4000-char head back when
// its `outputFile` is gone. What was missing is the LABEL — the model could not tell a head
// from a whole result (W7). These three cases pin the only two shapes a stripped snapshot
// may render as, plus the silence a complete result keeps.

/** A stripped snapshot: head text + the metadata the cache never drops (`outputTruncated`). */
function truncatedSnapshot(over: Partial<CollectSnapshot> = {}): CollectSnapshot {
	return {
		execution: { status: "success" },
		output: "h".repeat(4_000),
		outputFile: "/runs/r-1/artifacts/a/r1.md",
		artifactId: "r-1/a/r1",
		outputTruncated: true,
		acceptance: { status: "accepted", level: "attested" },
		...over,
	};
}

/** A real ledger with a real `artifacts` row — the `<bytes>` source D8 names. */
function ledgerWith(bytes: number): { db: ReturnType<typeof openLegionDb>; dispose: () => void } {
	const db = openLegionDb(":memory:");
	recordArtifact(db, {
		id: "r-1/a/r1",
		parentId: "root",
		nodeId: "root.a",
		name: "a",
		round: 1,
		path: "/runs/r-1/artifacts/a/r1.md",
		bytes,
		createdAt: 1,
	});
	return { db, dispose: () => db.close() };
}

test("P5c: a stripped snapshot says it is the cached head, with the ledger's full size", () => {
	const ledger = ledgerWith(24_576);
	try {
		const rendered = renderWait(
			[{ name: "a", snapshot: truncatedSnapshot() }],
			artifactBytesLookup({ db: ledger.db }),
		);
		// The honest sentence: how much is shown, how much there was, and the one-step read.
		assert.match(
			rendered,
			/this is the cached head \(3\.9 KB of 24\.0 KB\); full text: legion_output\(\{ name: "a" \}\)/,
		);
		// P5d: the line names the READER with the round the artifact id carries — the
		// artifact path is never handed to the model — and the OLD unconditional advice is gone.
		assert.match(rendered, /^full text: legion_output\(\{ name: "a", round: 1 \}\)$/m);
		assert.doesNotMatch(rendered, /\/runs\/r-1\/artifacts\/a\/r1\.md/);
		assert.doesNotMatch(rendered, /read this file when the output above is truncated/);
	} finally {
		ledger.dispose();
	}
});

test("P5c: without a ledger row the sentence says `at least`, never an invented total", () => {
	// No lookup at all (a host with no legion identity) and a lookup that knows no row
	// (db reset without rebuild, best-effort insert failed) must read the same: the head
	// the model holds is a floor. `4.0 KB of 3.1 KB` is exactly what must not appear.
	const noSeam = renderWait([{ name: "a", snapshot: truncatedSnapshot() }]);
	assert.match(noSeam, /this is the cached head \(at least 3\.9 KB\); full text: legion_output\(\{ name: "a" \}\)/);
	const noRow = renderWait([{ name: "a", snapshot: truncatedSnapshot() }], () => undefined);
	assert.match(noRow, /this is the cached head \(at least 3\.9 KB\)/);
	const smallerThanHead = renderWait([{ name: "a", snapshot: truncatedSnapshot() }], () => 10);
	assert.match(smallerThanHead, /\(at least 3\.9 KB\)/, "a row below the head is not a total");
});

test("P5c: waitAction threads the artifact-size lookup into the render (not a dead parameter)", async () => {
	// The renderer tests above prove the two shapes; this one proves the TOOL passes the
	// seam through — a lookup that is accepted but never forwarded would still leave W7
	// open on the `wait` path.
	const ledger = ledgerWith(24_576);
	const base = runtimeWith([{ name: "a", agent: "worker" }]);
	const runtime: SessionRuntime = {
		...base,
		wait: (names) =>
			Promise.resolve(names.map((name) => ({ name, snapshot: truncatedSnapshot() }) as WaitResult)),
	};
	const { store, cwd } = tempStore();
	try {
		const res = await waitAction({
			params: { action: "wait", name: "a", timeoutMs: 50 },
			runtime,
			agents: [agent("worker")],
			store,
			cwd,
			fullBytesOf: artifactBytesLookup({ db: ledger.db }),
		});
		assert.match(text(res), /this is the cached head \(3\.9 KB of 24\.0 KB\); full text: legion_output\(\{ name: "a" \}\)/);
	} finally {
		base.dispose();
		ledger.dispose();
	}
});

test("P5c/P5d: a complete result keeps the plain reader line and prints no summary warning", () => {
	const ledger = ledgerWith(24_576);
	try {
		const rendered = renderWait(
			[
				{
					name: "a",
					snapshot: truncatedSnapshot({ output: "the whole answer", outputTruncated: undefined }),
				},
			],
			artifactBytesLookup({ db: ledger.db }),
		);
		assert.match(rendered, /^full text: legion_output\(\{ name: "a", round: 1 \}\)$/m);
		assert.doesNotMatch(rendered, /\/runs\/r-1\/artifacts/);
		assert.doesNotMatch(rendered, /cached head/);
		assert.doesNotMatch(rendered, /preview truncated/);
	} finally {
		ledger.dispose();
	}
});

// ───────────────── D3 (polish round): the receipt says WHEN, not how long ─────────────────
//
// `still running (elapsed 190108ms)` rendered the child's AGE as if it were the waiting
// time. `elapsedMs` keeps its value and its other consumers (the `details` payload and the
// notices above); only the sentence changes: seconds, one decimal, "spawned … ago".

test("D3: a still-running receipt says when the child was spawned, in seconds", () => {
	const rendered = renderWait([{ name: "worker-0", stillRunning: true, elapsedMs: 190_108 }]);
	assert.match(rendered, /── worker-0 ──\nstill running \(spawned 190\.1s ago\)/);
	// The old wording must be gone entirely — that is the whole point of D3.
	assert.doesNotMatch(rendered, /elapsed/);
	assert.doesNotMatch(rendered, /ms\)/);

	// Sub-second ages keep one decimal instead of collapsing to a bare `0s`.
	assert.match(
		renderWait([{ name: "w", stillRunning: true, elapsedMs: 42 }]),
		/still running \(spawned 0\.0s ago\)/,
	);
	// No number known is still no parenthetical — never `spawned undefined`.
	assert.match(
		renderWait([{ name: "w", stillRunning: true }]),
		/── w ──\nstill running$/m,
	);
});

test("D3: the elapsedMs VALUE is unchanged in the details payload", () => {
	// Render-only change (contract D3: "不改 elapsedMs 的取值与其它消费者").
	const details = buildWaitTimeoutDetails([
		{ name: "live", stillRunning: true, timedOut: true, elapsedMs: 190_108 },
	]);
	assert.deepEqual(details?.stillRunning, [{ name: "live", elapsedMs: 190_108 }]);
});

// ───────────────── D4 (polish round): the wait body is a preview, and says so ─────────────────
//
// Only when the ledger can state the artifact's WHOLE byte count. Then the body is cut to
// 4 KB and flagged `outputTruncated`, which is what makes `renderCollect`'s existing head
// sentence + `legion_output({ name })` pointer fire. Without that number nothing is cut —
// an unmeasurable cut would have to lie about how much it removed.

test("D4: a wait body is capped at 4 KB when the ledger knows the whole size", () => {
	const ledger = ledgerWith(20_000);
	const long = "x".repeat(20_000);
	const snapshot = truncatedSnapshot({ output: long, outputTruncated: undefined });
	try {
		const rendered = renderWait([{ name: "a", snapshot }], artifactBytesLookup({ db: ledger.db }));
		// Both numbers are real: 4096 bytes shown, 20 000 bytes existed.
		assert.match(
			rendered,
			/this is the cached head \(4\.0 KB of 19\.5 KB\); full text: legion_output\(\{ name: "a" \}\)/,
		);
		assert.match(rendered, /^full text: legion_output\(\{ name: "a", round: 1 \}\)$/m);
		assert.doesNotMatch(rendered, /x{4100}/, "the whole 20 KB text is not handed over");
		// The caller's snapshot keeps the whole text: the trim is a COPY, never a
		// mutation of a result someone else already holds (#349, one layer up).
		assert.equal(snapshot.output.length, 20_000);
	} finally {
		ledger.dispose();
	}
});

test("D4: with no complete byte count the wait body is NOT truncated", () => {
	const long = "y".repeat(20_000);
	const snapshot = truncatedSnapshot({ output: long, outputTruncated: undefined });
	const cases: Array<[string, string]> = [
		["no seam at all", renderWait([{ name: "a", snapshot }])],
		["seam with no row", renderWait([{ name: "a", snapshot }], () => undefined)],
	];
	for (const [label, rendered] of cases) {
		assert.match(rendered, /y{20000}/, `${label}: the whole text stays`);
		assert.doesNotMatch(rendered, /cached head/, `${label}: nothing was cut, so nothing is claimed`);
	}
});

test("D4: a row that is smaller than the head degrades to `at least`, never to a lie", () => {
	// The row IS a number, so the body is capped — but `cachedHeadLine` will not print
	// `4.0 KB of 10 B`: the head it holds becomes the floor it reports.
	const rendered = renderWait(
		[{ name: "a", snapshot: truncatedSnapshot({ output: "y".repeat(20_000), outputTruncated: undefined }) }],
		() => 10,
	);
	assert.match(rendered, /cached head \(at least 4\.0 KB\)/);
	assert.doesNotMatch(rendered, /of 10 B/);
});

test("D4: the 4 KB cut never splits a code point", () => {
	// "漢" is 3 bytes, so 4096 lands mid-character: 1365 whole characters fit.
	const ledger = ledgerWith(6_000);
	const snapshot = truncatedSnapshot({ output: "漢".repeat(2_000), outputTruncated: undefined });
	try {
		const rendered = renderWait([{ name: "a", snapshot }], artifactBytesLookup({ db: ledger.db }));
		assert.doesNotMatch(rendered, /\uFFFD/, "no replacement character at the cut");
		assert.match(rendered, /cached head \(4\.0 KB of 5\.9 KB\)/);
		assert.doesNotMatch(rendered, new RegExp("漢{1366}"), "not one byte over the cap");
		assert.match(rendered, new RegExp("漢{1365}"), "and not one character short by accident");
	} finally {
		ledger.dispose();
	}
});

test("D4: waitAction hands over the preview, so legion_output is the way to the whole result", async () => {
	const ledger = ledgerWith(20_000);
	const long = "z".repeat(20_000);
	const base = runtimeWith([{ name: "a", agent: "worker" }]);
	const runtime: SessionRuntime = {
		...base,
		wait: (names) =>
			Promise.resolve(
				names.map(
					(name) =>
						({
							name,
							snapshot: truncatedSnapshot({ output: long, outputTruncated: undefined }),
						}) as WaitResult,
				),
			),
	};
	const { store, cwd } = tempStore();
	try {
		const res = await waitAction({
			params: { action: "wait", name: "a", timeoutMs: 50 },
			runtime,
			agents: [agent("worker")],
			store,
			cwd,
			fullBytesOf: artifactBytesLookup({ db: ledger.db }),
		});
		const rendered = text(res);
		assert.match(rendered, /cached head \(4\.0 KB of 19\.5 KB\)/);
		assert.match(rendered, /full text: legion_output\(\{ name: "a", round: 1 \}\)/);
		assert.doesNotMatch(rendered, /z{4100}/);
	} finally {
		base.dispose();
		ledger.dispose();
	}
});
