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
const nodeFs = createRequire(import.meta.url)("node:fs") as {
	openSync: (...args: unknown[]) => number;
	statSync: (...args: unknown[]) => unknown;
};
const realOpenSync = nodeFs.openSync;
const realStatSync = nodeFs.statSync;
let openTarget: string | null = null;
let opens = 0;

/**
 * Seed-race injection for `waitOutTransientConnection`.
 *
 * Arms a session file plus a callback that fires exactly once, immediately
 * BEFORE the first `statSync` of that file during the hold — i.e. between the
 * seed's size reading and the seed's parse, whichever order the implementation
 * uses, and with the size reading observing the append.
 *
 * Firing *before* the stat is what makes the two orderings differ:
 *
 *   stat-then-parse (current): the stat returns the post-append size and the
 *     parse that follows already contains the recovery, so the hold ends on its
 *     first iteration check (spent 0ms).
 *   parse-then-stat (pre-fix): the parse runs before the append and misses the
 *     recovery, then the stat folds the append into `parsedSize`. The stale
 *     `parsed` keeps reporting a blip while the size never changes again, so
 *     `size !== parsedSize` stays false and the append is only picked up after
 *     the deadline — the stall this test exists to prevent.
 *
 * `parseSessionFile` stats through `fstatSync(fd)`, not `statSync(path)`, and no
 * `statSync` of the session file happens before the hold, so "first statSync"
 * unambiguously identifies the seed size reading in either ordering.
 */
let raceTarget: string | null = null;
let raceAppend: (() => void) | null = null;
let raceFired = false;

function fireSeedRace(file: unknown): void {
	if (raceTarget === null || file !== raceTarget || raceFired) return;
	raceFired = true;
	raceAppend?.();
}

nodeFs.openSync = (...args: unknown[]) => {
	if (openTarget !== null && args[0] === openTarget) opens += 1;
	return realOpenSync(...args);
};
nodeFs.statSync = (...args: unknown[]) => {
	fireSeedRace(args[0]);
	return realStatSync(...args);
};
syncBuiltinESMExports();

/** Append once, between the hold's seed size reading and its seed parse. */
function injectBetweenSeedStatAndParse(file: string, append: () => void): () => void {
	raceTarget = file;
	raceAppend = append;
	raceFired = false;
	return () => { raceTarget = null; raceAppend = null; };
}

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

test("#232 ③: an append landing between the seed stat and the seed parse is not missed", async () => {
	// Regression guard for the seed ordering (stat before parse). The window is a
	// single pair of synchronous calls inside waitOutTransientConnection, so it is
	// injected through fs: the append fires immediately before the seed's
	// statSync, and therefore between the seed's size reading and its parse.
	//
	// Pre-fix (parse before stat) the parse ran first and missed the recovery,
	// while the stat that followed folded it into `parsedSize` — so
	// `size !== parsedSize` stayed false for the rest of the hold and the outcome
	// was identical but only reached when the deadline expired (measured: 900000ms
	// of waiting instead of 0ms).
	const h = harness(undefined, { immediateTimeout: false });
	let disarm: (() => void) | undefined;
	try {
		const sessionFile = await blipChild(h);
		let appended = false;
		disarm = injectBetweenSeedStatAndParse(sessionFile, () => {
			appended = true;
			appendFileSync(sessionFile, `${assistantMsg({ stopReason: "stop", text: '{"ok":true}' })}\n`);
		});
		const startedAt = h.clock();
		const collected = await h.orchestrator.collect("worker-0", { timeoutMs: 900_000 });
		const spent = h.clock() - startedAt;

		assert.equal(appended, true, "the fixture did append inside the seed window");
		assert.equal(collected.execution.status, "success", "a recovery appended during the seed must not be missed");
		assert.match(collected.output, /"ok":true/);
		// Seen on the first iteration check, i.e. without waiting at all. Pre-fix
		// this assertion read 900000ms: the whole deadline.
		assert.equal(spent, 0, `the seed-time append was noticed after ${spent}ms of waiting; it must be noticed immediately`);
		assert.deepEqual(h.sleeps, [], "no poll may be needed: the recovery is in the seed parse itself");
	} finally {
		disarm?.();
		h.cleanup();
	}
});

test("#232 ③: an exit during the hold is noticed within one capped interval, far below the deadline", async () => {
	// During the hold the loop's isAlive() is the ONLY exit detector (D2: no
	// onEvent subscription, and waitSettled already returned "timeout"). The
	// backoff therefore bounds exit-observation latency, and nothing else in the
	// suite bounded it — so it could silently grow without a failing test.
	//
	// The child dies once the virtual clock passes `exitAtMs`, driven from the
	// harness's post-sleep hook (the virtual clock only moves inside sleeps).
	const exitAtMs = 60_000;
	let exited = false;
	const h = harness(() => {
		if (exited || h.clock() < exitAtMs) return;
		exited = true;
		h.supervisor.exit("worker-0");
	}, { immediateTimeout: false });
	try {
		await blipChild(h);
		const startedAt = h.clock();
		const collected = await h.orchestrator.collect("worker-0", { timeoutMs: 900_000 });
		const spent = h.clock() - startedAt;

		assert.equal(exited, true, "the fixture did kill the child mid-hold");
		// The exit is observed at the first poll tick at or after the death. Tick 17
		// is t=59500ms and tick 18 is t=63500ms, so the bound below is the cap.
		assert.ok(
			spent >= exitAtMs && spent <= exitAtMs + 4_000,
			`an exit during the hold was noticed at ${spent}ms; expected just after ${exitAtMs}ms and bounded by the 4s cap, never the 900s deadline`,
		);
		assert.notEqual(collected.execution.reason, TRANSIENT_CONNECTION_REASON, "a dead child is no longer a live blip");
	} finally {
		h.cleanup();
	}
});

test("#232 ③: growth is still detected long after the backoff has reached its cap", async () => {
	// What this actually proves: growth at t=60s is still seen, and the hold ends
	// at the first tick at or after that — so the size guard keeps stat'ing and
	// keeps comparing against a live baseline deep in the capped regime.
	//
	// What it does NOT prove: it cannot observe a *wrongly latched* baseline,
	// because a baseline that is too old makes `size !== parsedSize` permanently
	// TRUE (over-parse — the safe failure, just wasted work), not permanently
	// false. The assertion that fails if the guard stops working is the cadence
	// check at the end (the backoff must actually be at its 4s cap), not the
	// timing bound — the pre-#232 flat 500ms loop also ends promptly here.
	//
	// Cadence grid: cumulative virtual time reaches 59500ms on tick 17 and
	// 63500ms on tick 18 (500+1000+2000, then 4000s), so a recovery triggered at
	// 60s is observed on tick 18.
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
