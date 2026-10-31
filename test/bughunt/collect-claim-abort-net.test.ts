/**
 * BUGHUNT C4 — a `wait` result is claimed, the tool layer's abort net throws it
 * away, and the claim is never handed back: that child's completion notice is lost.
 *
 * The claim (`reported`, `src/extension/runtime.ts:687-709`) arbitrates the two
 * delivery routes for one child result: the tool result (`wait`/`collect`) and the
 * pushed notice (watch → join → outbox). `deliverBatch`
 * (`runtime.ts:959-1022`) filters every entry whose key is claimed, so a claim that
 * never reached the parent suppresses that round's notice PERMANENTLY.
 *
 * ── WHERE THE CLAIM IS TAKEN (this is the part that is easy to get wrong) ───────
 *
 * In this window the claim is taken by `waitAction`'s FINISHED-CACHE PROBE, not by
 * `waitOne`. A child that already settled is `state === "awaiting"`, and
 * `resolveWaitTargets` (`index.ts:4388-4389`) only counts `working`/`blocked` as
 * live, so the wait falls through to
 *
 *     const cached = runtime.consumeCollect(params.name);   // index.ts:4751
 *
 * and — as that call site says in so many words (`index.ts:4745-4757`: "since
 * notice-claim-v1 that probe is NOT side-effect free: a cache hit claims the
 * result") — the cache hit claims the round there, with `claimedNow === true`.
 *
 * `runtime.ts:1708`'s `claimReported(…)` still runs further down the same call, but
 * on this path it is an IDEMPOTENT NO-OP that returns `false`: the key is already
 * in `reported`. That matters for anyone fixing this bug — threading `waitOne`'s
 * return value into `unclaimUndelivered(name, snapshot, claimedNow)` rolls back
 * nothing at all, because `unclaimUndelivered` (`runtime.ts:819-838`) treats
 * `claimedNow === false` as "an earlier delivery owns this claim" and returns. The
 * probe's `(snapshot, claimedNow)` pair is the one that has to travel, exactly as
 * `collectChild` does it for `collect` (`index.ts:2470-2476`: the seam's
 * `ClaimedCollect` comes back with the call and every bail hands it to
 * `unclaimUndelivered`).
 *
 * ── WHERE THE ABORT REALLY LANDS ───────────────────────────────────────────────
 *
 * `src/extension/runtime.ts:1700-1717`, the `waitOne` terminal branch:
 *
 *     const origin = originOf(snapshot, job);            // 1707
 *     claimReported(origin.runId, name, origin.round);   // 1708 — no-op on this path
 *     if (jobs.get(name) === job) {
 *         try { await job.retire?.(); } catch {}         // 1711 — REAL macrotask await
 *         runtime.release(name);                         // 1715
 *     }
 *     return { name, snapshot };                         // 1717 — the signal is never re-read
 *
 * `job.retire` is the child's teardown (an RPC round trip in production), so an Esc
 * delivered by the event loop lands inside it — no microtask needs to lose a race
 * (the earlier revision of this file put the window in the `collect` layer, where
 * every await between `collectChild`'s own gate (`index.ts:2473`) and the outer net
 * is microtask-level: `persistChild` → `store.updateChild` → `store.ts:347-368` is a
 * promise chain over synchronous `writeFileSync`/`renameSync`, so nothing could ever
 * land there).
 *
 * `waitOne` then returns the snapshot, `waitAction` renders it, and the tool layer's
 * net — `index.ts:1581-1583`, AFTER the control action already claimed:
 *
 *     if (signal?.aborted && action !== "stop") {
 *         return ok("interrupted (parent turn ended; children still running)");
 *     }
 *
 * — replaces the rendered result with the frozen head line. Nothing reached the
 * parent, the child is already released (`runtime.ts:1715`), and the claim stands:
 * the notice queued while the child finished is filtered at `deliverBatch` and the
 * parent is never told the child finished.
 *
 * Contract `docs/contracts/notice-claim-v1.md:41` says the DELIVERY side has no
 * unclaim path — correct: a *delivered* result must stay claimed. A result that was
 * claimed and then discarded by the tool layer is the opposite case, which is what
 * `:43`/`:45` carve out ("此时还没有任何副本落到父手里，待发的通知是唯一剩下的送达
 * 路径"). The rollback that fits is `unclaimUndelivered`, NOT `unclaimReported`
 * (`:723-744`): the revoke path also drops the queued copy (D7), i.e. the only
 * remaining route, while the undelivered path only gives the claim back.
 *
 * ── THE SIX TESTS ─────────────────────────────────────────────────────────────
 *
 * Three fix the CLAIM MECHANISM on one small fixture (a watched child that finishes,
 * notice queued, then the probe's own call takes the claim). No wait and no abort is
 * involved, so no fix can interfere — these describe `deliverBatch`, not the bug:
 *
 *   1. MECHANISM — the probe's claim (`claimedNow === true`) takes the queued notice
 *      out of `pending`; the flush then delivers nothing. That filter is what a bail
 *      has to undo.
 *   2. WRONG CLAIM — plus exactly one call, `unclaimUndelivered(name, snapshot,
 *      false)`, i.e. the shape you get by threading `waitOne`'s `claimReported`
 *      return (`runtime.ts:1708`, a no-op `false` here): `pending` does not move and
 *      the notice is still filtered. Handing back a claim this call never took is
 *      not a rollback.
 *   3. CONTROL — plus exactly one call, `unclaimUndelivered(name, snapshot, true)`
 *      with the PROBE's pair, the way `collectChild` does it for `collect`
 *      (`index.ts:2470-2476`): the notice arrives exactly once.
 *
 * One pins the claim SITE on the real wait path (`waitAction` → `runtime.wait` →
 * `waitOne`, abort landing inside `retire`):
 *
 *   4. PROVENANCE — `waitAction`'s finished-cache probe holds the claim
 *      (`claimedNow === true`, `index.ts:4751`) while the wait is still parked, and a
 *      second probe cannot take it again (`claimedNow === false`) — which is exactly
 *      why `runtime.ts:1708` is a no-op in this window, and why a fix must carry the
 *      probe's `(snapshot, claimedNow)` and not `waitOne`'s return value.
 *
 * Two run the real extension entry point (`piLegion` → the registered `subagent`
 * tool → `execute(…, signal, …)`), so `index.ts:1581-1583` EXECUTES. These carry the
 * verdict, and they only ask one thing — does the notice arrive? — so ANY fix that
 * really restores delivery flips them, wherever the rollback lives:
 *
 *   5. CONTROL — the same fixture with nothing aborting it: one notice.
 *   6. RED — the same window with the abort: 0 notices, because the bail throws the
 *      result away and hands the probe's claim back to nobody.
 *
 * Everything is in-process and deterministic: no network, no real LLM, no sleep used
 * as a synchronisation mechanism (every fixture wait is event-driven or a bounded
 * pump with an explicit sentinel).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import piLegion, { waitAction } from "../../index.ts";
import {
	createSessionRuntime,
	type ClaimedCollect,
	type CollectSnapshot,
	type SessionRuntime,
	type WaitResult,
} from "../../src/extension/runtime.ts";
import { RunStore } from "../../src/runs/store.ts";
import { DEFAULTS, type AgentConfig } from "../../src/shared/types.ts";
import { FakeSupervisor } from "../helpers/fake-supervisor.ts";

/** Wall-clock bound for every fixture wait. Nothing here may hang the suite. */
const BOUND_MS = 5_000;
const CHILD = "x";

/**
 * `index.ts:1581-1583`, verbatim. The net that replaces a rendered result with this
 * line; the seam tests reproduce its CONSEQUENCE, test 5 executes the code.
 */
const INTERRUPTED_REPLY = "interrupted (parent turn ended; children still running)";

type SentMessage = { customType: string; content: string; display: boolean };

function terminalSnapshot(output: string): CollectSnapshot {
	return {
		execution: { status: "success" },
		output,
		acceptance: { status: "accepted", level: "attested" },
	};
}

function agentConfig(name: string): AgentConfig {
	return { name, description: `${name} role`, source: "user" } as AgentConfig;
}

function textOf(result: { content?: unknown }): string {
	const parts = (result.content ?? []) as Array<{ text?: string }>;
	return parts.map((part) => part.text ?? "").join("\n");
}

/** `Promise.race` with a sentinel: every fixture wait is bounded, never unbounded. */
function within<T>(work: Promise<T>, label: string, boundMs = BOUND_MS): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const bound = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(
			() => reject(new Error(`bounded fixture wait expired (${boundMs}ms): ${label}`)),
			boundMs,
		);
		timer.unref?.();
	});
	return Promise.race([work, bound]).finally(() => {
		if (timer) clearTimeout(timer);
	});
}

/**
 * Bounded pump over a real observable. Not a sleep used as a synchronisation
 * primitive: it re-reads the runtime's own state and fails loudly at the bound
 * instead of waiting for a guessed interval.
 */
async function until(pred: () => boolean, label: string, boundMs = BOUND_MS): Promise<void> {
	const deadline = Date.now() + boundMs;
	while (!pred()) {
		if (Date.now() > deadline) {
			throw new Error(`bounded fixture pump expired (${boundMs}ms): ${label}`);
		}
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
}

/**
 * The child's teardown, made controllable — the shape `job.retire` really has.
 *
 * In production `retire` is `orchestrator.retire(name)` → `supervisor.retire(name)`,
 * an RPC round trip that takes real time; here it parks until the test opens the
 * gate. That is exactly the window `src/extension/runtime.ts:1711` holds open for an
 * abort: the runtime awaits what it awaits in production, only the DURATION is
 * decided by the test.
 */
interface RetireGate {
	/** How many `retire()` calls reached the gate (1-based count). */
	readonly entered: number;
	/** The `retire()` body. */
	pass(): Promise<void>;
	/** Resolves once at least `count` calls are parked inside the gate. */
	arrived(count: number, boundMs?: number): Promise<void>;
	/** Let every parked call (and every later one) finish. */
	release(): void;
}

function createRetireGate(): RetireGate {
	let entered = 0;
	let open = false;
	const parked: Array<() => void> = [];
	const arrivals: Array<{ at: number; resolve: () => void }> = [];
	const announce = (): void => {
		for (let index = arrivals.length - 1; index >= 0; index -= 1) {
			const waiter = arrivals[index];
			if (!waiter || waiter.at > entered) continue;
			arrivals.splice(index, 1);
			waiter.resolve();
		}
	};
	return {
		get entered() {
			return entered;
		},
		async pass() {
			entered += 1;
			announce();
			if (open) return;
			await new Promise<void>((resolve) => parked.push(resolve));
		},
		arrived(count: number, boundMs = BOUND_MS) {
			if (entered >= count) return Promise.resolve();
			return within(
				new Promise<void>((resolve) => arrivals.push({ at: count, resolve })),
				`retire() call #${count} reached the gate`,
				boundMs,
			);
		},
		release() {
			open = true;
			for (const resolve of parked.splice(0)) resolve();
		},
	};
}

/** What one `runtime.consumeCollect` answered, as the fixture observed it. */
interface ClaimObservation {
	claimedNow: boolean;
	output: string;
}

interface ClaimedNoticeFixture {
	/** What the parent actually received. Empty ⇒ the notice was filtered. */
	messages: SentMessage[];
	/** The probe's answer — the `(snapshot, claimedNow)` pair a rollback must carry. */
	claim: ClaimedCollect;
	/** Deliverable notices left in the outbox BEFORE the probe claimed. */
	pendingBeforeClaim: number;
	/** …and right now. */
	pending(): number;
	/** Hand the claim back (or pretend to, with `claimedNow: false`). */
	unclaim(claimedNow: boolean): void;
	/** `agent_settled`: flush the held notices. */
	flush(): Promise<void>;
	dispose(): void;
}

/**
 * The claim MECHANISM, isolated: one watched child finishes on its own (notice
 * queued), then the probe's exact call takes the claim for the round.
 *
 * No wait and no abort are involved, so no bail-side rollback exists to interfere —
 * this fixture describes `deliverBatch`'s claim filter, which is what the tool
 * layer's bail has to undo, and it stays true under any fix.
 */
async function claimedNoticeFixture(): Promise<ClaimedNoticeFixture> {
	const messages: SentMessage[] = [];
	const runtime = createSessionRuntime({
		sendMessage(message) {
			messages.push(message as SentMessage);
		},
	});
	// D-A/D-C: a live parent run makes the notice WAIT in the run-scoped outbox, so
	// the delivery attempt happens at settle — after the claim exists.
	runtime.notifyParentRunStart();
	// One child, one notice, no batching window ("each" is a configured mode).
	runtime.setJoinConfig({ mode: "each", flushMs: 0 });
	runtime.track({
		name: CHILD,
		runId: "r-1",
		agent: "worker",
		sessionFile: `/tmp/${CHILD}.jsonl`,
		timeoutMs: DEFAULTS.turnTimeoutMs,
		collect: async () => terminalSnapshot("x-out"),
	});
	runtime.watch(CHILD);
	await until(
		() => runtime.noticeQueueStats().pending === 1,
		"the watch queued exactly one deliverable notice",
	);
	const pendingBeforeClaim = runtime.noticeQueueStats().pending;
	// The probe's exact call (`index.ts:4751`). The watch has already retired and
	// released the job, so this takes the finished-cache branch a settled wait takes
	// — and a cache HIT CLAIMS THE ROUND (`index.ts:4745-4749`).
	const claim = await runtime.consumeCollect(CHILD);
	assert.ok(claim, "fixture: the finished cache answered the probe");
	return {
		messages,
		claim,
		pendingBeforeClaim,
		pending: () => runtime.noticeQueueStats().pending,
		unclaim: (claimedNow: boolean) => runtime.unclaimUndelivered(CHILD, claim.snapshot, claimedNow),
		flush: async () => {
			// `notifyParentSettled` flushes the outbox synchronously (`runtime.ts:2229`);
			// one more turn lets a would-be duplicate surface before a count is read.
			runtime.notifyParentSettled();
			await new Promise<void>((resolve) => setImmediate(resolve));
		},
		dispose: () => runtime.dispose(),
	};
}

test("C4 mechanism: the probe's claim takes the queued notice out of `pending`, so the flush delivers nothing", async () => {
	const fixture = await claimedNoticeFixture();
	try {
		assert.equal(fixture.pendingBeforeClaim, 1, "fixture: the notice was deliverable before the claim");
		assert.equal(
			fixture.claim.claimedNow,
			true,
			"the probe's call (index.ts:4751) took the claim for the round — THIS is the site",
		);
		assert.equal(fixture.claim.snapshot.output, "x-out", "…for this child's result");
		assert.equal(
			fixture.pending(),
			0,
			"the claimed round leaves `pending` at once — `deliverBatch` will filter it",
		);
		await fixture.flush();
		assert.equal(
			fixture.messages.length,
			0,
			"a claimed round delivers nothing: the notice is filtered, not missing",
		);
	} finally {
		fixture.dispose();
	}
});

test("C4 wrong claim: unclaimUndelivered(…, false) — the value runtime.ts:1708 reports here — rolls nothing back", async () => {
	const fixture = await claimedNoticeFixture();
	try {
		assert.equal(fixture.claim.claimedNow, true, "the probe took it (index.ts:4751)");
		// The shape you get by reading `runtime.ts:1708` as the claim site and threading
		// ITS return value: on this path `claimReported` answered `false` (the probe was
		// first), and `unclaimUndelivered` refuses a `false` — "an earlier delivery owns
		// this claim". Exactly one call, and nothing changes.
		fixture.unclaim(false);
		assert.equal(fixture.pending(), 0, "a `claimedNow === false` rollback leaves the claim standing");
		await fixture.flush();
		assert.equal(
			fixture.messages.length,
			0,
			"…so the notice is still filtered: handing back a claim this call never took is not a rollback",
		);
	} finally {
		fixture.dispose();
	}
});

test("C4 control: the same scenario plus ONE unclaimUndelivered(…, true) with the probe's pair delivers exactly once", async () => {
	const fixture = await claimedNoticeFixture();
	try {
		assert.equal(fixture.claim.claimedNow, true, "same claim, same site (index.ts:4751)");
		// The one call the tool layer's bail owes — with the PROBE's `claimedNow`, the
		// way `collectChild` hands the seam's `ClaimedCollect` to this helper
		// (`index.ts:2470-2476`). `unclaimUndelivered`, not `unclaimReported`: the revoke
		// path also DROPS the queued copy (D7), which is the only route left here.
		fixture.unclaim(true);
		assert.equal(fixture.pending(), 1, "handing the claim back puts the queued notice back into `pending`");
		await fixture.flush();
		assert.equal(
			fixture.messages.length,
			1,
			"with the claim handed back the queued notice is flushed — exactly once, never twice",
		);
		assert.match(fixture.messages[0]!.content, /x-out/);
	} finally {
		fixture.dispose();
	}
});

// ───────────────────────── the real wait path, claim provenance ─────────────────────────

function tempStore(): { store: RunStore; cwd: string; cleanup: () => void } {
	const cwd = mkdtempSync(path.join(tmpdir(), "bughunt-c4-"));
	return {
		store: new RunStore({ rootDir: path.join(cwd, ".pi-subagents") }),
		cwd,
		cleanup: () => rmSync(cwd, { recursive: true, force: true }),
	};
}

interface WaitInRetireScenario {
	/** What `waitAction` rendered — the copy the tool layer discards. */
	waitRendered: string;
	/** First probe, the one INSIDE `waitAction` (`index.ts:4751`). */
	probeClaim: ClaimObservation | undefined;
	/** Second probe, run while the wait is parked: `runtime.ts:1708` re-claims nothing. */
	repeatClaim: ClaimObservation | undefined;
	/** `retire()` calls the fixture saw: the watch's and the wait's. */
	retireCalls: number;
	dispose(): void;
}

/**
 * The real wait path with the abort landing inside its own teardown — used to pin
 * WHERE the claim comes from. It stops at the claim: the discard it would owe a
 * rollback for is the tool layer's, and test 6 runs that code for real.
 */
async function runWaitInRetireScenario(): Promise<WaitInRetireScenario> {
	const controller = new AbortController();
	const gate = createRetireGate();
	const runtime = createSessionRuntime({ sendMessage() {} });
	runtime.notifyParentRunStart();
	runtime.setJoinConfig({ mode: "each", flushMs: 0 });

	// Observe the probe without changing it: `waitAction` claims through this exact
	// call, and the answer it gets is the pair a rollback has to carry.
	const probes: ClaimObservation[] = [];
	const realConsume = runtime.consumeCollect.bind(runtime);
	runtime.consumeCollect = (name: string) => {
		const answer = realConsume(name);
		answer?.then(
			(value) => {
				probes.push({ claimedNow: value.claimedNow, output: value.snapshot.output });
			},
			() => {},
		);
		return answer;
	};

	let resolveCollect: ((snapshot: CollectSnapshot) => void) | undefined;
	runtime.track({
		name: CHILD,
		runId: "r-1",
		agent: "worker",
		sessionFile: `/tmp/${CHILD}.jsonl`,
		timeoutMs: DEFAULTS.turnTimeoutMs,
		collect: () =>
			new Promise<CollectSnapshot>((resolve) => {
				resolveCollect = resolve;
			}),
		retire: () => gate.pass(),
	});
	runtime.watch(CHILD);
	resolveCollect!(terminalSnapshot("x-out"));

	// The child finished under a live watch: notice queued, watch parked in retire().
	await until(
		() => runtime.noticeQueueStats().pending === 1,
		"the watch queued exactly one deliverable notice",
	);
	await gate.arrived(1);

	const seen: WaitResult[] = [];
	const realWait = runtime.wait.bind(runtime);
	runtime.wait = (names, options) =>
		realWait(names, options).then((results) => {
			seen.push(...results);
			return results;
		});
	const { store, cwd, cleanup } = tempStore();
	let settled = false;
	const waiting = waitAction({
		params: { action: "wait", name: CHILD },
		signal: controller.signal,
		runtime,
		agents: [agentConfig("worker")],
		store,
		cwd,
	}).then((result) => {
		settled = true;
		return result;
	});

	// The wait is inside `await job.retire?.()` (`runtime.ts:1711`) — a real
	// macrotask await in production — and has NOT returned.
	await gate.arrived(2);
	assert.equal(settled, false, "the wait is parked in retire() when the abort fires");
	await until(() => probes.length >= 1, "waitAction probed the finished cache");
	const probeClaim = probes[0];
	assert.equal(
		probeClaim?.claimedNow,
		true,
		"the probe (index.ts:4751) holds the claim before the abort",
	);
	assert.equal(runtime.noticeQueueStats().pending, 0, "and that claim already filters the queued notice");

	// Second probe, still while the claim stands: the round is already claimed, so
	// `runtime.ts:1708`'s `claimReported` can only answer `false` here.
	const repeat = await runtime.consumeCollect(CHILD);
	const repeatClaim = repeat ? { claimedNow: repeat.claimedNow, output: repeat.snapshot.output } : undefined;

	controller.abort();
	assert.equal(settled, false, "and it is STILL inside retire() after the abort was delivered");
	gate.release();
	const waitRendered = textOf(await within(waiting, "the wait returned after the abort"));
	assert.ok(seen[0]?.snapshot, "fixture: the wait returned a snapshot, not a timeout or an interrupt");
	assert.match(waitRendered, /x-out/, "fixture: the wait DID render the child's result");
	assert.equal(runtime.get(CHILD), undefined, "fixture: the wait released the job");

	return {
		waitRendered,
		probeClaim,
		repeatClaim,
		retireCalls: gate.entered,
		dispose: () => {
			runtime.dispose();
			cleanup();
		},
	};
}

test("C4 seam (claim provenance): waitAction's finished-cache probe holds the claim; runtime.ts:1708 re-claims nothing", async () => {
	const scenario = await runWaitInRetireScenario();
	try {
		assert.equal(
			scenario.probeClaim?.claimedNow,
			true,
			"the claim was taken by waitAction's finished-cache probe (index.ts:4751), with claimedNow === true",
		);
		assert.equal(scenario.probeClaim?.output, "x-out", "…for this child's result");
		assert.equal(
			scenario.repeatClaim?.claimedNow,
			false,
			"a second probe gets claimedNow === false — runtime.ts:1708's claimReported is an idempotent no-op on this path, " +
				"so a fix must carry the PROBE's pair, not waitOne's return value",
		);
		assert.equal(scenario.retireCalls, 2, "the watch's teardown and the wait's own teardown both ran");
		assert.match(scenario.waitRendered, /x-out/, "the wait rendered the result and handed it up the stack");
	} finally {
		scenario.dispose();
	}
});

// ─────────────────────────── the tool layer, for real ───────────────────────────

const WORKER_FILE = "---\nname: worker\ndescription: worker role\n---\nworker prompt\n";
const ENV_KEYS = [
	"PI_SUBAGENT_CHILD",
	"PI_SUBAGENT_UTILITY_CHILD",
	"PI_CODING_AGENT_DIR",
	"PI_LEGION_EXTRA_AGENT_DIRS",
	"PI_LEGION_DB",
	"PI_LEGION_NODE_ID",
] as const;

type ToolResult = { content?: Array<{ text?: string }>; details?: unknown };
type RegisteredTool = {
	name: string;
	execute: (
		id: string,
		params: Record<string, unknown>,
		signal: AbortSignal | undefined,
		onUpdate: undefined,
		ctx: Record<string, unknown>,
	) => Promise<ToolResult>;
};

/**
 * The extension entry point with a FakeSupervisor, in a throwaway project dir —
 * the harness `test/unit/teams.test.ts` uses. Only the supervisor is fake: the tool,
 * the runtime, the claim table and `index.ts:1581-1583` are the shipping ones.
 *
 * `retire` is wrapped so the child's teardown parks in a gate — the RPC round trip
 * that gives the abort its window.
 */
function toolLayerHarness() {
	const cwd = mkdtempSync(path.join(tmpdir(), "bughunt-c4-tool-"));
	const agentDir = path.join(cwd, "agentdir");
	const extraDir = path.join(cwd, "extra-agents");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(extraDir, { recursive: true });
	writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ subagents: { disableBuiltins: true } }));
	writeFileSync(path.join(extraDir, "worker.md"), WORKER_FILE);
	const previous = new Map(ENV_KEYS.map((name) => [name, process.env[name]]));
	process.env.PI_CODING_AGENT_DIR = agentDir;
	process.env.PI_LEGION_EXTRA_AGENT_DIRS = extraDir;
	delete process.env.PI_SUBAGENT_CHILD;
	delete process.env.PI_SUBAGENT_UTILITY_CHILD;
	delete process.env.PI_LEGION_DB;
	delete process.env.PI_LEGION_NODE_ID;

	const supervisor = new FakeSupervisor({ immediateTimeout: false });
	const sentMessages: SentMessage[] = [];
	const tools: RegisteredTool[] = [];
	const handlers = new Map<string, (...args: unknown[]) => unknown>();
	const pi = {
		registerTool(tool: RegisteredTool) {
			tools.push(tool);
		},
		registerCommand() {},
		registerMessageRenderer() {},
		sendMessage(message: unknown) {
			sentMessages.push(message as SentMessage);
		},
		events: { emit() {} },
		on(name: string, handler: (...args: unknown[]) => unknown) {
			handlers.set(name, handler);
		},
	};
	piLegion(pi as never, { supervisor });
	const tool = tools.find((entry) => entry.name === "subagent");
	assert.ok(tool, "the subagent tool is registered by the extension entry point");
	const ctx = { cwd, hasUI: false, ui: { notify() {}, setStatus() {} } };
	let cleanedUp = false;
	return {
		cwd,
		supervisor,
		sentMessages,
		invoke(params: Record<string, unknown>, signal?: AbortSignal) {
			return tool.execute("bughunt-c4", params, signal, undefined, ctx);
		},
		/** `agent_start` — opens the run-scoped notice window. */
		startRun() {
			handlers.get("agent_start")?.({}, ctx);
		},
		/** `agent_settled` — flushes every held notice. */
		settleParent() {
			handlers.get("agent_settled")?.({ type: "agent_settled", aborted: false }, ctx);
		},
		async cleanup() {
			if (cleanedUp) return;
			cleanedUp = true;
			// `session_shutdown` is what disposes the extension's runtime and retires
			// whatever is still tracked; without it the session's bookkeeping outlives
			// the test process (teams.test.ts does the same).
			await Promise.resolve(handlers.get("session_shutdown")?.({}, ctx));
			for (const [name, value] of previous) {
				if (value === undefined) delete process.env[name];
				else process.env[name] = value;
			}
			rmSync(cwd, { recursive: true, force: true });
		},
	};
}

/**
 * The scenario at the TOOL layer: launch one child, let it finish under a live run,
 * and park its teardown (`supervisor.retire`, i.e. the RPC round trip the
 * orchestrator's `retire` waits on) in a gate.
 *
 *  - `waitWithAbort: true`  — the parent then calls `subagent({ action: "wait" })`
 *    with a signal that is aborted while that call is parked INSIDE the teardown.
 *  - `waitWithAbort: false` — the fixture's own control: no wait, no abort, so the
 *    same harness must deliver the same child's notice. Without it, "0 notices"
 *    could just as well mean "this fixture never had a notice to lose".
 */
async function runToolLayerScenario(input: { waitWithAbort: boolean }): Promise<{
	notices: SentMessage[];
	answered: string;
	retireCalls: number;
	cleanup: () => Promise<void>;
}> {
	const harness = toolLayerHarness();
	const gate = createRetireGate();
	const controller = new AbortController();
	let answered = "";
	try {
		harness.startRun();
		const originalRetire = harness.supervisor.retire.bind(harness.supervisor);
		harness.supervisor.retire = async (name: string) => {
			await gate.pass();
			await originalRetire(name);
		};

		const launched = await harness.invoke({
			agent: "worker",
			task: "finish, then be waited on",
			async: true,
			worktree: false,
		});
		assert.equal((launched.details as { error?: string } | undefined)?.error, undefined, textOf(launched));
		const name = harness.supervisor.spawns[0]?.input.name;
		assert.ok(name, "fixture: the child spawned");

		// The child finishes under a live watch ⇒ its notice is queued and the watch
		// parks in the teardown.
		harness.supervisor.settle(name, { text: "x-out" });
		await gate.arrived(1);

		if (input.waitWithAbort) {
			let settled = false;
			const waiting = harness.invoke({ action: "wait", name }, controller.signal).then((result) => {
				settled = true;
				return result;
			});
			// The wait is inside `await job.retire?.()` (`runtime.ts:1711`) and the
			// finished-cache probe (`index.ts:4751`) has already taken the claim.
			await gate.arrived(2);
			assert.equal(settled, false, "fixture: the wait is parked in the teardown when the abort fires");
			assert.equal(controller.signal.aborted, false, "fixture: the abort has not been delivered yet");
			controller.abort();
			assert.equal(settled, false, "fixture: and it is STILL inside the teardown after the abort");
			gate.release();
			answered = textOf(await within(waiting, "the wait tool call returned"));
		} else {
			gate.release();
		}

		harness.settleParent();
		// The flush is synchronous; one more turn lets any duplicate surface before the
		// count is read.
		await new Promise<void>((resolve) => setImmediate(resolve));
		const notices = harness.sentMessages.filter((message) => message.customType === "subagent-notify");
		return {
			notices,
			answered,
			retireCalls: gate.entered,
			cleanup: async () => {
				gate.release();
				await harness.cleanup();
			},
		};
	} catch (error) {
		gate.release();
		await harness.cleanup();
		throw error;
	}
}

test("C4 TOOL LAYER control: the same fixture delivers the child's notice when nothing aborts it", async () => {
	const scenario = await runToolLayerScenario({ waitWithAbort: false });
	try {
		assert.equal(scenario.retireCalls, 1, "only the watch's teardown ran — no wait was issued");
		assert.equal(scenario.notices.length, 1, "the fixture can deliver: one child, one notice, one flush");
		assert.match(scenario.notices[0]!.content, /x-out/);
	} finally {
		await scenario.cleanup();
	}
});

test("C4 TOOL LAYER RED: index.ts:1581-1583 discards the wait result and never hands the probe's claim back", async () => {
	const scenario = await runToolLayerScenario({ waitWithAbort: true });
	try {
		assert.equal(scenario.retireCalls, 2, "the watch's teardown and the wait's own teardown both ran");
		assert.equal(
			scenario.answered,
			INTERRUPTED_REPLY,
			"index.ts:1581-1583 answered the parent: the rendered result was thrown away",
		);
		// THE VERDICT, at the layer that owns the net. The control above delivers this
		// child's notice; here the probe's claim (`index.ts:4751`) was left standing, so
		// `deliverBatch` filters the queued notice and the parent is never told the child
		// finished. The rollback this bail owes is the PROBE's pair — threading
		// `waitOne`'s `claimReported` (a no-op `false` here, runtime.ts:1708) would roll
		// nothing back and leave exactly this failure.
		assert.equal(
			scenario.notices.length,
			1,
			"the bail discarded the only delivered copy, so the completion notice must still be flushed — " +
				`it was delivered ${scenario.notices.length} times: the probe's claim (index.ts:4751) was never ` +
				"handed back, and a claimedNow === false rollback would not have changed that",
		);
		assert.match(scenario.notices[0]!.content, /x-out/);
	} finally {
		await scenario.cleanup();
	}
});
