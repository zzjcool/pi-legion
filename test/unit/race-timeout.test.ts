/**
 * `raceWithTimeout` (#325) — the one bounded wait both supervisor backends share.
 *
 * The three details that made two identical copies worth keeping are exactly the
 * three that are easy to lose in a refactor, so they are pinned here directly:
 *
 *  - the timer is cleared on the settling path (a leftover timer keeps the
 *    process, and a `node --test` case, alive);
 *  - the loser's rejection is observed (`abort` races a promise that may reject
 *    after the timer already answered — an unhandled rejection fails the run);
 *  - the delay is capped at the largest one `setTimeout` honours (Node collapses
 *    an out-of-range delay to 1 ms, which would fabricate an instant timeout).
 *
 * The two backends' acceptance cases (`abort-supervisor.test.ts`) exercise the
 * same helper through `abort`; this file is the direct contract.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_ABORT_TIMER_DELAY_MS } from "../../src/supervisor/types.ts";
import { raceWithTimeout } from "../../src/supervisor/race-timeout.ts";

test("raceWithTimeout: a work that settles first wins and leaves no timer behind", async () => {
	const originalSetTimeout = globalThis.setTimeout;
	const originalClearTimeout = globalThis.clearTimeout;
	const armed: Array<{ timer: ReturnType<typeof setTimeout>; delay: number }> = [];
	const cleared = new Set<unknown>();
	try {
		globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
			const timer = originalSetTimeout(...args);
			if (typeof args[1] === "number") armed.push({ timer, delay: args[1] });
			return timer;
		}) as typeof setTimeout;
		globalThis.clearTimeout = ((handle?: Parameters<typeof clearTimeout>[0]) => {
			cleared.add(handle);
			return originalClearTimeout(handle);
		}) as typeof clearTimeout;

		const value = await raceWithTimeout(Promise.resolve("done"), 1_234, () => "timed-out");
		assert.equal(value, "done", "the work's own answer, not the timeout's");
		const timer = armed.find((entry) => entry.delay === 1_234);
		assert.ok(timer, "the bound reached setTimeout unmodified");
		assert.equal(cleared.has(timer.timer), true, "the settling path clears its timer");
	} finally {
		globalThis.setTimeout = originalSetTimeout;
		globalThis.clearTimeout = originalClearTimeout;
	}
});

test("raceWithTimeout: an expiring bound answers onTimeout, freshly built per call", async () => {
	const first = await raceWithTimeout(new Promise<string>(() => {}), 5, () => "timeout");
	assert.equal(first, "timeout");
	// A factory, not a value: two callers (or two calls) must never share one
	// mutable answer object.
	const answers: Array<{ steering: number; followUp: number }> = [];
	const second = await raceWithTimeout(new Promise<never>(() => {}), 5, () => {
		const answer = { steering: 0, followUp: 0 };
		answers.push(answer);
		return answer;
	});
	assert.deepEqual(second, { steering: 0, followUp: 0 });
	assert.equal(answers.length, 1, "called exactly once, after the bound");
});

test("raceWithTimeout: the loser's late rejection is observed, never unhandled", async () => {
	const unhandled: unknown[] = [];
	const collect = (reason: unknown): void => {
		unhandled.push(reason);
	};
	process.on("unhandledRejection", collect);
	try {
		// The loser rejects well after the bound answered — the RPC abort case (a
		// child that exits while the interrupt was pending).
		const late = new Promise<never>((_resolve, reject) => {
			setTimeout(() => reject(new Error("rejected too late")), 30);
		});
		const answer = await raceWithTimeout(late, 5, () => "timeout");
		assert.equal(answer, "timeout");
		await new Promise((resolve) => setTimeout(resolve, 60));
		assert.deepEqual(unhandled, [], "the losing promise's rejection must be observed");
	} finally {
		process.off("unhandledRejection", collect);
	}
});

test("raceWithTimeout: an over-large bound is capped at the largest timer delay", async () => {
	const originalSetTimeout = globalThis.setTimeout;
	const delays: number[] = [];
	try {
		globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
			if (typeof args[1] === "number") {
				delays.push(args[1]);
				// Shorten it: the cap is what this case asserts, not a 24-day wait.
				args[1] = 5;
			}
			return originalSetTimeout(...args);
		}) as typeof setTimeout;
		const answer = await raceWithTimeout(new Promise<never>(() => {}), 1e12, () => "timeout");
		assert.equal(answer, "timeout");
		assert.deepEqual(delays, [MAX_ABORT_TIMER_DELAY_MS], "clamped, not passed through");
		assert.equal(delays.includes(1), false, "an unclamped delay would collapse to 1 ms");
	} finally {
		globalThis.setTimeout = originalSetTimeout;
	}
});
