/**
 * #232 ② and ③ — the cost of `collect()`'s two poll loops, not their channel.
 *
 * ② `collectArtifactGrowing` used to sleep a flat `POLL_INTERVAL_MS` (500ms) and
 *    only then look for growth, so a grace extension was always granted 500ms
 *    after the artifact had already grown.
 * ③ `waitOutTransientConnection` used to run `ceil(remaining / 500)` iterations,
 *    each with a full `parseSessionFile`, so the default 900s deadline cost 1800
 *    parses of a file that had not changed a byte.
 *
 * Both are pinned on the injected `now`/`sleep` virtual clock, so the waits are
 * asserted as numbers instead of real seconds.
 *
 * The parse count is measured by wrapping `fs.openSync` for the one session file
 * under test: `parseSessionFile` opens the path once per call and nothing else
 * on the collect path opens it, so this counts real observer calls rather than
 * an internal counter the implementation could stop moving.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { Orchestrator, TRANSIENT_CONNECTION_REASON } from "../../src/runs/orchestrator.ts";
import { clearSessionParseCache } from "../../src/shared/session.ts";
import type { AgentConfig } from "../../src/shared/types.ts";
import { FakeSupervisor } from "../helpers/fake-supervisor.ts";
import { assistantMsg, userMsg } from "../helpers/fixtures.ts";

/** Flat cadence both loops used before #232 (module-private, so mirrored here). */
const LEGACY_POLL_INTERVAL_MS = 500;

/**
 * `fs.openSync` wrapper that counts opens of one armed path. Installed once for
 * the file; it only counts while a target is armed, so tests may interleave.
 */
const nodeFs = createRequire(import.meta.url)("node:fs") as { openSync: (...args: unknown[]) => number };
const realOpenSync = nodeFs.openSync;
let openTarget: string | null = null;
let opens = 0;
nodeFs.openSync = (...args: unknown[]) => {
	if (openTarget !== null && args[0] === openTarget) opens += 1;
	return realOpenSync(...args);
};
syncBuiltinESMExports();

function countOpensOf(file: string): { count(): number; stop(): void } {
	opens = 0;
	openTarget = file;
	return { count: () => opens, stop: () => { openTarget = null; } };
}

function agent(): AgentConfig {
	return {
		name: "worker",
		description: "test agent",
		systemPromptMode: "append",
		inheritProjectContext: true,
		inheritSkills: false,
		kind: "pi",
		systemPrompt: "You are a test agent.",
		source: "user",
		filePath: "/fake/worker.md",
	};
}

interface Harness {
	runDir: string;
	supervisor: FakeSupervisor;
	orchestrator: Orchestrator;
	/** Every `sleep` duration the orchestrator asked for, in order. */
	sleeps: number[];
	/** Virtual clock reading at each `waitSettled` call. */
	settleWaits: number[];
	clock(): number;
	cleanup(): void;
}

/**
 * @param onSleep runs after each injected sleep has advanced the virtual clock;
 *                used to change the child's session file mid-wait.
 */
function harness(onSleep?: () => void, options: ConstructorParameters<typeof FakeSupervisor>[0] = {}): Harness {
	clearSessionParseCache();
	const runDir = mkdtempSync(path.join(tmpdir(), "collect-polling-"));
	const supervisor = new FakeSupervisor(options);
	const sleeps: number[] = [];
	const settleWaits: number[] = [];
	let clock = 0;
	const orchestrator = new Orchestrator({
		supervisor,
		runDir,
		cwd: "/tmp/project",
		now: () => clock,
		sleep: async (ms) => { clock += ms; sleeps.push(ms); onSleep?.(); },
	});
	const waitSettled = supervisor.waitSettled.bind(supervisor);
	supervisor.waitSettled = (name, timeoutMs) => {
		settleWaits.push(clock);
		return waitSettled(name, timeoutMs);
	};
	return {
		runDir,
		supervisor,
		orchestrator,
		sleeps,
		settleWaits,
		clock: () => clock,
		cleanup: () => rmSync(runDir, { recursive: true, force: true }),
	};
}

/** Launch a child and leave its session ending on a connection blip. */
async function blipChild(h: Harness): Promise<string> {
	const handle = await h.orchestrator.launch({ agent: agent(), task: "retry the request", name: "worker-0", worktree: false });
	h.supervisor.settle(handle.name, { text: "", stopReason: "error", errorMessage: "Connection error." });
	return handle.sessionFile;
}

/** Collect a blip child for `windowMs` and count the session-file opens it costs. */
async function blipHoldCost(windowMs: number): Promise<{ parses: number; iterations: number; spent: number; collected: Awaited<ReturnType<Orchestrator["collect"]>> }> {
	const h = harness(undefined, { immediateTimeout: false });
	try {
		const sessionFile = await blipChild(h);
		const counter = countOpensOf(sessionFile);
		const startedAt = h.clock();
		const collected = await h.orchestrator.collect("worker-0", { timeoutMs: windowMs });
		const spent = h.clock() - startedAt;
		counter.stop();
		// Observable behaviour unchanged: still holding, still live, still named.
		assert.equal(collected.execution.status, "running");
		assert.equal(collected.execution.reason, TRANSIENT_CONNECTION_REASON);
		assert.equal(h.supervisor.isAlive("worker-0"), true);
		// No early give-up: the blip tolerance is the whole deadline, as before.
		assert.equal(spent, windowMs, `the wait must consume its whole window (spent ${spent}ms)`);
		return { parses: counter.count(), iterations: h.sleeps.length, spent, collected };
	} finally {
		h.cleanup();
	}
}

test("#232 ③: the parse cost of a blip hold no longer scales with the window", async () => {
	const short = await blipHoldCost(2_000);
	const long = await blipHoldCost(60_000);

	// The two holds really are different lengths, so the comparison is honest.
	assert.ok(long.iterations > short.iterations * 3, `expected many more polls in the 60s window (${long.iterations} vs ${short.iterations})`);

	// The loop's own parses must not grow with the window: an unchanged file is
	// parsed once for the whole hold. (The rest of the opens are collect()'s own
	// fixed number of parses, identical in both runs — before #232 the 60s window
	// added 120 of them.)
	assert.equal(
		long.parses,
		short.parses,
		`a 30x longer blip window cost ${long.parses - short.parses} extra parses of an unchanged session (#232 ③)`,
	);
	assert.ok(long.parses <= 6, `an unchanged session was parsed ${long.parses} times; flat 500ms polling did 124 over 60s`);
});

test("#232 ③: the blip poll backs off geometrically and stays far below remaining/500 iterations", async () => {
	const h = harness(undefined, { immediateTimeout: false });
	try {
		await blipChild(h);
		const startedAt = h.clock();
		const collected = await h.orchestrator.collect("worker-0", { timeoutMs: 900_000 });
		const spent = h.clock() - startedAt;

		assert.equal(collected.execution.reason, TRANSIENT_CONNECTION_REASON);
		assert.equal(spent, 900_000, `the default 900s deadline must still be consumed (spent ${spent}ms)`);

		const legacyIterations = spent / LEGACY_POLL_INTERVAL_MS; // 1800
		assert.ok(
			h.sleeps.length < legacyIterations / 4,
			`${h.sleeps.length} poll iterations for a 900s window; flat ${LEGACY_POLL_INTERVAL_MS}ms polling needed ${legacyIterations}`,
		);
		// Backoff, not a smaller constant: the cadence grows, then caps.
		assert.equal(h.sleeps[0], LEGACY_POLL_INTERVAL_MS, "the first poll keeps the old 500ms cadence");
		assert.ok(h.sleeps.every((ms) => ms > 0), "no zero-delay iteration may busy-spin the loop");
		const growth = h.sleeps.slice(0, -1); // the last sleep is clamped by the deadline
		assert.ok(
			growth.every((ms, i) => i === 0 || ms >= (growth[i - 1] as number)),
			`interval must grow towards the cap, got ${growth.slice(0, 6).join(",")}…`,
		);
		const cap = Math.max(...h.sleeps);
		assert.ok(cap >= 2_000, `expected a multi-second backoff cap, max interval was ${cap}ms`);
		// The loop stops exactly on the deadline, so the window is fully honoured.
		assert.equal(h.sleeps.reduce((a, b) => a + b, 0), 900_000);
	} finally {
		h.cleanup();
	}
});

test("#232 ③ behaviour lock: early growth inside the blip window ends the hold (not a regression guard)", async () => {
	// BEHAVIOUR LOCK, not a #232 regression guard: the pre-#232 flat 500ms poll
	// also noticed growth on its first tick, so this case passes on both
	// implementations. It exists so the recovery path keeps an explicit test now
	// that the cadence is variable and size-guarded. The regression guard for the
	// size guard is the late-growth case below, where the old and new cadences
	// genuinely disagree.
	let sessionFile = "";
	let appended = false;
	const h = harness(() => {
		if (appended) return;
		appended = true;
		// The child recovers from the blip on the first poll round.
		appendFileSync(sessionFile, `${assistantMsg({ stopReason: "stop", text: '{"ok":true}' })}\n`);
	}, { immediateTimeout: false });
	try {
		sessionFile = await blipChild(h);
		const startedAt = h.clock();
		const collected = await h.orchestrator.collect("worker-0", { timeoutMs: 900_000 });

		assert.equal(collected.execution.status, "success", "a recovered blip collects the real outcome");
		assert.match(collected.output, /"ok":true/);
		assert.ok(
			h.clock() - startedAt <= LEGACY_POLL_INTERVAL_MS,
			`recovery must end the hold at the first poll (spent ${h.clock() - startedAt}ms of a 900s window)`,
		);
	} finally {
		h.cleanup();
	}
});

test("#232 ③: growth is still detected long after the backoff has reached its cap", async () => {
	// The dangerous shape for the size guard: the hold has backed off to the 4s
	// cap and the artifact then changes. A guard that latched the wrong baseline
	// (or stopped stat'ing entirely) would silently wait out the whole deadline
	// and report a `running` snapshot for a child that had already recovered.
	// The recovery here happens at t=60s, ~21 polls in, deep in the capped regime.
	let sessionFile = "";
	let appended = false;
	const recoverAtMs = 60_000;
	const h = harness(() => {
		if (appended || h.clock() < recoverAtMs) return;
		appended = true;
		appendFileSync(sessionFile, `${assistantMsg({ stopReason: "stop", text: '{"ok":true}' })}\n`);
	}, { immediateTimeout: false });
	try {
		sessionFile = await blipChild(h);
		const startedAt = h.clock();
		const collected = await h.orchestrator.collect("worker-0", { timeoutMs: 900_000 });
		const spent = h.clock() - startedAt;

		assert.equal(appended, true, "the fixture did recover the child");
		assert.equal(collected.execution.status, "success", "late growth must still be seen, not waited out");
		assert.match(collected.output, /"ok":true/);
		// The recovery is noticed at the first poll tick at or after 60s, i.e. at
		// most one capped interval later. It must not run to the 900s deadline.
		assert.ok(
			spent >= recoverAtMs && spent <= recoverAtMs + 4_000,
			`late growth was noticed at ${spent}ms; expected just after ${recoverAtMs}ms (cap 4s) and never the full 900s deadline`,
		);
		// Proof the hold really was in the capped regime by then, not still at 500ms.
		assert.ok(Math.max(...h.sleeps) === 4_000, `expected the backoff to be at its cap, intervals were ${[...new Set(h.sleeps)].join(",")}`);
	} finally {
		h.cleanup();
	}
});

test("#232: the settled fast path does no polling at all (CI-enforced twin of the perf guard)", async () => {
	// D3's "last-turn-complete fast path: no sleeps at all" needs a gate in the
	// CI job. test:perf is NOT part of .github/workflows/ci.yml, so the perf case
	// that pins this cannot fail a pull request; this one can.
	const h = harness(undefined, { autoSettle: { text: "done", stopReason: "stop" } });
	try {
		await h.orchestrator.launch({ agent: agent(), task: "do the thing", name: "worker-0", worktree: false });
		const startedAt = h.clock();
		const collected = await h.orchestrator.collect("worker-0");

		assert.equal(collected.execution.status, "success");
		assert.equal(h.clock() - startedAt, 0, `an already-settled turn burned ${h.clock() - startedAt}ms of virtual sleeps`);
		assert.deepEqual(h.sleeps, [], "the settled path must not ask for a single sleep");
		assert.equal(h.settleWaits.length, 0, "an already-complete last turn skips the supervisor wait entirely");
	} finally {
		h.cleanup();
	}
});

test("#232 ②: a growing artifact earns its grace extension as soon as it grows, not a full window later", async () => {
	let clockAtGrowth: number | null = null;
	let sessionFile = "";
	const h = harness(() => {
		if (clockAtGrowth !== null || h.clock() < 100) return;
		clockAtGrowth = h.clock();
		appendFileSync(sessionFile, `${userMsg("still writing progress")}\n`);
	}, { immediateTimeout: true });
	try {
		const handle = await h.orchestrator.launch({ agent: agent(), task: "long response", name: "worker-0", worktree: false });
		sessionFile = handle.sessionFile;
		await h.orchestrator.collect("worker-0", { timeoutMs: 1_000 });

		assert.equal(clockAtGrowth, 100, "the fixture grew the artifact 100ms into the 500ms window");
		// The growth still earns exactly one grace extension ...
		assert.equal(h.settleWaits.length, 2, "a genuinely growing artifact still earns a grace extension");
		const extensionAt = h.settleWaits[1] as number;
		// ... and #232 ② is precisely that it starts before the old flat window.
		assert.ok(
			extensionAt < LEGACY_POLL_INTERVAL_MS,
			`the grace extension started at ${extensionAt}ms; the old code could not start it before ${LEGACY_POLL_INTERVAL_MS}ms`,
		);
		assert.ok(
			extensionAt - (clockAtGrowth as number) <= 100,
			`detection lag ${extensionAt - (clockAtGrowth as number)}ms exceeds the 50ms sampling step`,
		);
	} finally {
		h.cleanup();
	}
});

test("#232 ②: an artifact that never grows still gets the full 500ms window and no extension", async () => {
	const h = harness(undefined, { immediateTimeout: true });
	try {
		await h.orchestrator.launch({ agent: agent(), task: "long response", name: "worker-0", worktree: false });
		const startedAt = h.clock();
		const collected = await h.orchestrator.collect("worker-0", { timeoutMs: 1_000 });
		const spent = h.clock() - startedAt;

		// Same observable contract as before the change: one waited-out window,
		// then the untouched deadline snapshot.
		assert.equal(h.settleWaits.length, 1, "no growth means no grace extension");
		assert.equal(spent, LEGACY_POLL_INTERVAL_MS, "the growth window is still one full POLL_INTERVAL_MS");
		assert.equal(collected.execution.status, "running");
		assert.equal(h.sleeps.length, 10, "the window is sampled in ten 50ms steps");
		assert.ok(h.sleeps.every((ms) => ms === 50), `growth sampling step must stay at 50ms, saw ${Math.max(...h.sleeps)}ms`);
		assert.equal(h.sleeps.reduce((a, b) => a + b, 0), LEGACY_POLL_INTERVAL_MS);
	} finally {
		h.cleanup();
	}
});
