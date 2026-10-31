/**
 * C5 — a second `collect({ timeoutMs })` reuses the FIRST call's pending wait, so
 * a smaller bound is silently ignored and the collect never returns.
 *
 * Mechanism (`src/runs/orchestrator.ts:2507-2532`, `awaitSupervisor`):
 *
 * ```ts
 * let pending = signal ? undefined : this.pendingWaits.get(child.name);
 * if (!pending) {
 *   const wait = this.supervisor.waitSettled(child.name, Math.max(1, deadline - this.now()), ...);
 *   pending = wait;                       // ← armed with THIS call's bound
 *   if (!signal) this.pendingWaits.set(child.name, pending);
 * }
 * ...
 * if (!this.uiProxy && !signal) return await waitForSettle;   // ← no deadline race
 * ```
 *
 * The wait is cached per child, but the second call's `deadline` (computed in
 * `collect()` from *this* call's `timeoutMs`, `:2150`/`:2177`) is never used
 * again: neither branch of `awaitSupervisor` (the plain `!uiProxy && !signal`
 * return, nor the `Promise.race` further down at `:2547`) races the reused wait
 * against the new deadline. The effective bound therefore stays the one the
 * first `collect` armed — a ≥60s bound keeps a `collect({ timeoutMs: 1 })`
 * pending for the full 60s.
 *
 * Why the shipped helper cannot show this: `test/helpers/fake-supervisor.ts:242-249`
 * only short-circuits `immediateTimeout` / `timeoutMs === 0` and otherwise pushes
 * the resolver onto `child.waiters`, so it never arms a real timer. A timeout
 * that never arrives would make the *first* call hang too, and the contrast
 * below would be impossible to draw. The harness here therefore honors the
 * `timeoutMs` the orchestrator actually passed with an unref'd timer — exactly
 * what `RpcSupervisor.waitSettled` does in production — and records every bound
 * it was asked for.
 *
 * Both suite shapes are exercised because the bug does not depend on the
 * `uiProxy` branch: with a proxy attached (`RpcSupervisor`/`RoutingSupervisor`
 * always expose one, and `Orchestrator` adopts it at `:485`) the same reused
 * promise is raced against `waitForChildEvent` + `blocked`, neither of which can
 * resolve while the child stays alive without approval requests.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { COLLECT_DEADLINE_REASON, Orchestrator } from "../../src/runs/orchestrator.ts";
import { clearSessionParseCache } from "../../src/shared/session.ts";
import type { AgentConfig } from "../../src/shared/types.ts";
import type { SettleResult } from "../../src/supervisor/types.ts";
import { FakeSupervisor } from "../helpers/fake-supervisor.ts";

const NAME = "worker-0";
/** The first collect's bound: far longer than any assertion window here. */
const LONG_BOUND_MS = 60_000;
/** The second collect's bound: it must win, and it does not. */
const SMALL_BOUND_MS = 1;
/** Wall-clock budget for "did this collect return?" (real time, not virtual). */
const SENTINEL_MS = 300;

function agent(): AgentConfig {
	return {
		name: "worker",
		description: "bughunt test agent",
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
	orchestrator: Orchestrator;
	/** Every `timeoutMs` the orchestrator asked the supervisor to honor, in order. */
	bounds: number[];
	cleanup(): void;
}

/**
 * @param attachUiProxy `false` selects the plain `!uiProxy && !signal` return in
 *                      `awaitSupervisor`; `true` keeps the production shape and
 *                      therefore the `races` branch.
 */
function harness(options: { attachUiProxy: boolean }): Harness {
	clearSessionParseCache();
	const runDir = mkdtempSync(path.join(tmpdir(), "bughunt-c5-"));
	// `immediateTimeout: false` keeps `waitSettled` from answering `timeout`
	// instantly, so the promise really is outstanding while the child is alive.
	const supervisor = new FakeSupervisor({ immediateTimeout: false });
	if (!options.attachUiProxy) {
		// `Orchestrator` adopts `supervisor.uiProxy` at `:485`; removing the own
		// property is the only way to reach the `!this.uiProxy` return.
		Reflect.deleteProperty(supervisor, "uiProxy");
	}
	const bounds: number[] = [];
	let clock = 0;
	const orchestrator = new Orchestrator({
		supervisor,
		runDir,
		cwd: "/tmp/project",
		now: () => clock,
		sleep: async (ms) => { clock += ms; },
	});
	const baseWaitSettled = supervisor.waitSettled.bind(supervisor);
	// Honor the requested bound the way the production supervisor does. Without
	// this the fake never times out and the control case could not pass.
	supervisor.waitSettled = (name: string, timeoutMs?: number): Promise<SettleResult> => {
		const wait = baseWaitSettled(name, timeoutMs);
		if (timeoutMs === undefined) return wait;
		bounds.push(timeoutMs);
		const expired = new Promise<SettleResult>((resolve) => {
			const timer = setTimeout(() => resolve({ settled: false, abnormal: false, reason: "timeout" }), timeoutMs);
			// A 60s bound must not keep the test process alive.
			timer.unref?.();
		});
		return Promise.race([wait, expired]);
	};
	return {
		orchestrator,
		bounds,
		cleanup: () => rmSync(runDir, { recursive: true, force: true }),
	};
}

/** Launch the child and leave it alive and unsettled (no assistant message yet). */
async function launchChild(h: Harness): Promise<void> {
	await h.orchestrator.launch({ agent: agent(), task: "hold the slower job", name: NAME, worktree: false });
}

type Settled<T> =
	| { kind: "returned"; value: T }
	| { kind: "rejected"; error: unknown }
	| { kind: "pending" };

/** Await `work`, but never hang: report `pending` when the sentinel wins. */
async function settlesWithin<T>(work: Promise<T>, withinMs: number): Promise<Settled<T>> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const raced: Settled<T> = await Promise.race([
			work.then(
				(value) => ({ kind: "returned" as const, value }),
				(error: unknown) => ({ kind: "rejected" as const, error }),
			),
			new Promise<Settled<T>>((resolve) => {
				timer = setTimeout(() => resolve({ kind: "pending" }), withinMs);
			}),
		]);
		return raced;
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

function describeBounds(bounds: number[]): string {
	return bounds.length ? `${bounds.join(", ")}ms` : "(the supervisor was never asked)";
}

/**
 * Control: the bound IS honored when the pending wait is armed by the very call
 * that carries it. This is the same harness, the same fake, the same 1ms bound —
 * only the reuse path differs, so a failure here would exonerate C5.
 */
test("C5 control: the first collect honors a 1ms bound (the deadline machinery works)", async () => {
	const h = harness({ attachUiProxy: false });
	try {
		await launchChild(h);
		const run = await settlesWithin(h.orchestrator.collect(NAME, { timeoutMs: SMALL_BOUND_MS }), SENTINEL_MS);
		if (run.kind === "rejected") assert.fail(`collect({ timeoutMs: 1 }) threw: ${String(run.error)}`);
		assert.equal(
			run.kind,
			"returned",
			`collect({ timeoutMs: 1 }) never returned within ${SENTINEL_MS}ms even as the FIRST collect; bounds asked: ${describeBounds(h.bounds)}`,
		);
		if (run.kind !== "returned") return;
		assert.deepEqual(h.bounds, [SMALL_BOUND_MS], "the first collect must arm exactly the bound it was given");
		assert.equal(run.value.execution.status, "running", `expected a running snapshot, got ${JSON.stringify(run.value.execution)}`);
		assert.equal(run.value.execution.reason, COLLECT_DEADLINE_REASON);
	} finally {
		h.cleanup();
	}
});

/**
 * The defect, in the branch the task specifies: `!uiProxy && !signal`, i.e. the
 * plain `return await waitForSettle` at `:2532`.
 */
test("C5: a second collect({ timeoutMs: 1 }) reuses the 60s wait and never returns (!uiProxy branch)", async () => {
	const h = harness({ attachUiProxy: false });
	try {
		await launchChild(h);
		// Arm the long wait without blocking on it: `collect` runs synchronously up
		// to `await this.awaitSupervisor(...)`, which registers `pendingWaits`
		// before its first `await`, so the cache entry exists the moment this line
		// returns.
		const first = h.orchestrator.collect(NAME, { timeoutMs: LONG_BOUND_MS });
		const armed = await settlesWithin(first, 20);
		assert.equal(
			armed.kind,
			"pending",
			`the first collect({ timeoutMs: ${LONG_BOUND_MS} }) must still be waiting after 20ms, it was ${armed.kind}`,
		);
		assert.deepEqual(h.bounds, [LONG_BOUND_MS], "the first collect must arm its own bound");

		const second = h.orchestrator.collect(NAME, { timeoutMs: SMALL_BOUND_MS });
		const run = await settlesWithin(second, SENTINEL_MS);
		if (run.kind === "rejected") assert.fail(`second collect threw instead of returning a deadline snapshot: ${String(run.error)}`);

		assert.equal(
			run.kind,
			"returned",
			`BUG C5: the second collect({ timeoutMs: ${SMALL_BOUND_MS} }) did not return within ${SENTINEL_MS}ms, so the ${SMALL_BOUND_MS}ms bound was IGNORED. ` +
				`The supervisor was asked to honor: ${describeBounds(h.bounds)} — i.e. only the first call's ${LONG_BOUND_MS}ms bound. ` +
				"awaitSupervisor reuses pendingWaits and never races it against this call's deadline (src/runs/orchestrator.ts:2507-2532).",
		);
		if (run.kind !== "returned") return;
		// Deliberately NOT asserted: WHICH bound the supervisor was asked for. A fix may
		// either re-arm `waitSettled` with this call's bound or race the reused wait
		// against it, and both are correct; only the observable return matters. The
		// armed bounds stay in the failure messages above as diagnostics.
		assert.equal(
			run.value.execution.status,
			"running",
			`expected a running deadline snapshot; bounds asked: ${describeBounds(h.bounds)}; got ${JSON.stringify(run.value.execution)}`,
		);
		assert.equal(run.value.execution.reason, COLLECT_DEADLINE_REASON, `expected the collect-deadline reason; bounds asked: ${describeBounds(h.bounds)}`);
	} finally {
		h.cleanup();
	}
});

/**
 * Same defect in the shape production actually runs: `RpcSupervisor` and
 * `RoutingSupervisor` both expose `uiProxy`, so `collect` takes the
 * `Promise.race([waitForChildEvent, blocked])` branch at `:2547` — and that race
 * has no deadline arm either.
 */
test("C5: the same 1ms bound is ignored with a uiProxy attached (production branch)", async () => {
	const h = harness({ attachUiProxy: true });
	try {
		await launchChild(h);
		const first = h.orchestrator.collect(NAME, { timeoutMs: LONG_BOUND_MS });
		const armed = await settlesWithin(first, 20);
		assert.equal(armed.kind, "pending", `the first collect must still be waiting after 20ms, it was ${armed.kind}`);

		const second = h.orchestrator.collect(NAME, { timeoutMs: SMALL_BOUND_MS });
		const run = await settlesWithin(second, SENTINEL_MS);
		if (run.kind === "rejected") assert.fail(`second collect threw instead of returning a deadline snapshot: ${String(run.error)}`);
		assert.equal(
			run.kind,
			"returned",
			`BUG C5 (uiProxy branch): the second collect({ timeoutMs: ${SMALL_BOUND_MS} }) did not return within ${SENTINEL_MS}ms; ` +
				`bounds asked: ${describeBounds(h.bounds)}; the ` +
				`Promise.race at orchestrator.ts:2547 races the reused wait against waitForChildEvent/blocked only, never against the deadline.`,
		);
		if (run.kind !== "returned") return;
		assert.equal(run.value.execution.status, "running", `expected a running deadline snapshot, got ${JSON.stringify(run.value.execution)}`);
		assert.equal(run.value.execution.reason, COLLECT_DEADLINE_REASON);
	} finally {
		h.cleanup();
	}
});
