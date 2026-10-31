/**
 * #352 — a `wait` result is claimed, the tool layer's abort net throws it away,
 * and the claim used to be handed back to nobody: that child's completion notice
 * was lost for the round.
 *
 * The claim (`reported`, `src/extension/runtime.ts`) arbitrates the two delivery
 * routes for one child result: the tool result (`wait`/`collect`) and the pushed
 * notice (watch → join → outbox). `deliverBatch` filters every entry whose key is
 * claimed, so a claim that never reached the parent suppresses that round's notice
 * permanently.
 *
 * The claim site here is `waitAction`'s FINISHED-CACHE PROBE, not `waitOne`: a
 * child that already settled is not live, so the wait falls through to
 * `runtime.consumeCollect(name)`, and a cache hit claims the round
 * (`claimedNow === true`). `waitOne`'s own `claimReported` further down is an
 * idempotent no-op (`false`) on that path — threading ITS return value into the
 * rollback would roll nothing back, which is why the probe's `(snapshot,
 * claimedNow)` pair is what `details.waitClaims` carries.
 *
 * The abort lands inside `waitOne`'s `await job.retire?.()` (an RPC round trip in
 * production), and the tool layer's net then answers the frozen `interrupted …`
 * line instead of the rendered result. This file pins:
 *
 *   - the claim MECHANISM on a small fixture (probe claims → notice filtered;
 *     `false` rollback changes nothing; `true` rollback delivers exactly once);
 *   - the seam: `waitAction` exposes only the claims IT took, and the abort net's
 *     rollback (`releaseWaitClaims`) restores delivery exactly once;
 *   - the real extension entry point end to end: the same window with the abort
 *     still answers `interrupted …` AND the notice arrives exactly once.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import piLegion, { releaseWaitClaims, waitAction } from "../../index.ts";
import {
	createSessionRuntime,
	type ClaimedCollect,
	type CollectSnapshot,
	type SessionRuntime,
} from "../../src/extension/runtime.ts";
import { RunStore } from "../../src/runs/store.ts";
import { DEFAULTS, type AgentConfig } from "../../src/shared/types.ts";
import { FakeSupervisor } from "../helpers/fake-supervisor.ts";

/** Wall-clock bound for every fixture wait: nothing here may hang the suite. */
const BOUND_MS = 5_000;
const CHILD = "x";

/** The frozen bail line (`esc-no-retire-v3`) — text is asserted, never changed. */
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

/** Bounded pump over a real observable — never a sleep used as synchronisation. */
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
 * The child's teardown, made controllable — the shape `job.retire` really has
 * (an RPC round trip in production). The test decides how long it parks, so the
 * abort lands inside it deterministically.
 */
interface RetireGate {
	readonly entered: number;
	pass(): Promise<void>;
	arrived(count: number, boundMs?: number): Promise<void>;
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

function tempStore(): { store: RunStore; cwd: string; cleanup: () => void } {
	const cwd = mkdtempSync(path.join(tmpdir(), "wait-claim-"));
	return {
		store: new RunStore({ rootDir: path.join(cwd, ".pi-subagents") }),
		cwd,
		cleanup: () => rmSync(cwd, { recursive: true, force: true }),
	};
}

// ─────────────────────────── the claim mechanism, isolated ───────────────────────────

interface ClaimedNoticeFixture {
	messages: SentMessage[];
	runtime: SessionRuntime;
	/** The fixture's own probe answer — absent when `probe: false` was asked for. */
	claim: ClaimedCollect | undefined;
	pendingBeforeClaim: number;
	pending(): number;
	unclaim(claimedNow: boolean): void;
	flush(): Promise<void>;
	dispose(): void;
}

/**
 * One watched child finishes on its own, so its notice is queued and deliverable.
 *
 * `probe: true` (the default) additionally takes the claim with the probe's exact
 * call: no wait and no abort is involved, so those fixtures describe
 * `deliverBatch`'s claim filter — what the tool layer's bail has to undo — and stay
 * true under any fix. `probe: false` leaves the round UNCLAIMED, which is the shape
 * `waitAction` needs: only a claim the wait takes itself may travel out in
 * `details.waitClaims`.
 */
async function claimedNoticeFixture(input: { probe?: boolean } = {}): Promise<ClaimedNoticeFixture> {
	const messages: SentMessage[] = [];
	const runtime = createSessionRuntime({
		sendMessage(message) {
			messages.push(message as SentMessage);
		},
	});
	// A live parent run makes the notice WAIT in the run-scoped outbox, so the
	// delivery attempt happens at settle — after the claim exists.
	runtime.notifyParentRunStart();
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
	// The probe's exact call (`waitAction`). The watch has retired and released the
	// job, so this takes the finished-cache branch a settled wait takes — and a cache
	// HIT CLAIMS THE ROUND.
	const claim = input.probe === false ? undefined : await runtime.consumeCollect(CHILD);
	if (input.probe !== false) assert.ok(claim, "fixture: the finished cache answered the probe");
	return {
		messages,
		runtime,
		claim,
		pendingBeforeClaim,
		pending: () => runtime.noticeQueueStats().pending,
		unclaim: (claimedNow: boolean) => {
			assert.ok(claim, "fixture: there is no claim to hand back");
			runtime.unclaimUndelivered(CHILD, claim.snapshot, claimedNow);
		},
		flush: async () => {
			// `notifyParentSettled` flushes the outbox synchronously; one more turn
			// lets a would-be duplicate surface before a count is read.
			runtime.notifyParentSettled();
			await new Promise<void>((resolve) => setImmediate(resolve));
		},
		dispose: () => runtime.dispose(),
	};
}

test("#352 mechanism: the probe's claim takes the queued notice out of `pending`, so the flush delivers nothing", async () => {
	const fixture = await claimedNoticeFixture();
	try {
		assert.equal(fixture.pendingBeforeClaim, 1, "fixture: the notice was deliverable before the claim");
		const claim = fixture.claim;
		assert.ok(claim, "fixture: the probe took a claim");
		assert.equal(claim.claimedNow, true, "the probe's call took the claim for the round — THIS is the site");
		assert.equal(claim.snapshot.output, "x-out", "…for this child's result");
		assert.equal(fixture.pending(), 0, "the claimed round leaves `pending` at once — `deliverBatch` will filter it");
		await fixture.flush();
		assert.equal(fixture.messages.length, 0, "a claimed round delivers nothing: the notice is filtered, not missing");
	} finally {
		fixture.dispose();
	}
});

test("#352 wrong claim: unclaimUndelivered(…, false) rolls nothing back", async () => {
	const fixture = await claimedNoticeFixture();
	try {
		const claim = fixture.claim;
		assert.ok(claim, "fixture: the probe took a claim");
		assert.equal(claim.claimedNow, true, "the probe took it");
		// `waitOne`'s `claimReported` answers `false` on this path (the probe was
		// first); rolling that value back is a no-op by contract — a claim an earlier
		// delivery took is evidence, not a loan.
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

test("#352 control: unclaimUndelivered(…, true) with the probe's pair delivers exactly once", async () => {
	const fixture = await claimedNoticeFixture();
	try {
		const claim = fixture.claim;
		assert.ok(claim, "fixture: the probe took a claim");
		assert.equal(claim.claimedNow, true, "same claim, same site");
		// `unclaimUndelivered`, never `unclaimReported`: the revoke path also DROPS
		// the queued copy, which is the only route left here.
		fixture.unclaim(true);
		assert.equal(fixture.pending(), 1, "handing the claim back puts the queued notice back into `pending`");
		await fixture.flush();
		assert.equal(fixture.messages.length, 1, "with the claim handed back the queued notice is flushed — exactly once");
		assert.match(fixture.messages[0]!.content, /x-out/);
	} finally {
		fixture.dispose();
	}
});

// ─────────────────────── the seam: what `waitAction` carries out ───────────────────────

test("#352 seam: waitAction exposes the claims IT took (and only those) as details.waitClaims; handing them back delivers exactly once", async () => {
	// `probe: false`: the round is still unclaimed when the wait arrives, so the wait
	// itself is the one that takes the claim — the only kind it may travel out.
	const fixture = await claimedNoticeFixture({ probe: false });
	const { store, cwd, cleanup } = tempStore();
	try {
		const result = await within(
			waitAction({ params: { action: "wait", name: CHILD }, runtime: fixture.runtime, agents: [agentConfig("worker")], store, cwd }),
			"waitAction on a finished child",
		);
		assert.match(textOf(result), /x-out/, "fixture: the wait rendered the child's result");
		const details = result.details as { waitClaims?: Array<{ name: string; snapshot: CollectSnapshot }> } | undefined;
		assert.equal(details?.waitClaims?.length, 1, "the probe's claim must travel with the result, or the bail cannot give it back");
		assert.equal(details?.waitClaims?.[0]?.name, CHILD);
		assert.equal(details?.waitClaims?.[0]?.snapshot.output, "x-out", "…and it must be the claim for THIS result");
		assert.equal(fixture.runtime.noticeQueueStats().pending, 0, "fixture: the claim filters the queued notice");

		// EXACTLY what the abort net does with a result it throws away (`index.ts`):
		// `claimedNow` is always true here — `details.waitClaims` only ever holds
		// claims this call took.
		await releaseWaitClaims(fixture.runtime, result.details);
		assert.equal(fixture.runtime.noticeQueueStats().pending, 1, "the rollback puts the notice back into `pending`");
		await fixture.flush();
		assert.equal(fixture.messages.length, 1, "and the flush then delivers it — exactly once");
	} finally {
		cleanup();
		fixture.dispose();
	}
});

test("#352 seam control: a round another path already claimed is NOT recorded, so the bail cannot roll it back", async () => {
	const fixture = await claimedNoticeFixture({ probe: false });
	const { store, cwd, cleanup } = tempStore();
	try {
		// Someone else delivered first (a watch flush, an earlier wait, a collect):
		// its claim is evidence, not a loan.
		const earlier = await fixture.runtime.consumeCollect(CHILD);
		assert.equal(earlier?.claimedNow, true, "fixture: the first consumer took the claim");
		assert.equal(fixture.runtime.noticeQueueStats().pending, 0);

		const result = await within(
			waitAction({ params: { action: "wait", name: CHILD }, runtime: fixture.runtime, agents: [agentConfig("worker")], store, cwd }),
			"waitAction on an already-claimed result",
		);
		const details = result.details as { waitClaims?: unknown; waitClaimsPending?: unknown } | undefined;
		// #352 review (major 1): the array is mounted UNCONDITIONALLY — an empty array is
		// the honest answer (this call took nothing), while `undefined` was the shape that
		// also described a claim landing late. Either way the bail must roll nothing back.
		assert.equal(
			Array.isArray(details?.waitClaims) ? details.waitClaims.length : -1,
			0,
			"a probe that took nothing must record nothing — otherwise the bail would erase an earlier delivery's claim",
		);
		await releaseWaitClaims(fixture.runtime, result.details);
		assert.equal(fixture.runtime.noticeQueueStats().pending, 0, "the earlier claim stands");
		await fixture.flush();
		assert.equal(
			fixture.messages.length,
			0,
			"…so the round is not delivered a second time: proof the bail did not roll back someone else's claim",
		);
	} finally {
		cleanup();
		fixture.dispose();
	}
});

// ─────────────────── the async window: the probe answers AFTER the bail ───────────────────

/**
 * The real window #352's rollback missed (review major 1).
 *
 * `waitAction`'s probe is a PROMISE: the child is tracked but not in the live wait set,
 * so the probe starts a collect of its own, and the wait can bail (`signal?.aborted` /
 * `WAIT_INTERRUPTED` / `WaitTimeoutError`) while that collect is still in flight. The
 * probe then resolves to a TERMINAL snapshot — after the rendered result was already
 * discarded — and claims `(runId, name, round)`. A rollback that ran synchronously at
 * bail time rolled back nothing, so `deliverBatch` filtered that round's notice and the
 * completion was lost exactly as #352 described.
 *
 * The fixture drives the real `waitAction`, the real runtime and the real
 * `releaseWaitClaims`: the collect is a controllable gate, so the bail happens first and
 * the terminal answer lands afterwards, on a schedule the test decides.
 */
test("#352 async window: a probe that answers after the bail still gives its claim back — the notice arrives exactly once", async () => {
	const messages: SentMessage[] = [];
	const runtime = createSessionRuntime({
		sendMessage(message) {
			messages.push(message as SentMessage);
		},
	});
	// A live parent run holds the notice in the run-scoped outbox until settle (D-A), so
	// the delivery attempt — and `deliverBatch`'s claim filter — lands after both the
	// claim and its rollback.
	runtime.notifyParentRunStart();
	runtime.setJoinConfig({ mode: "each", flushMs: 0 });
	let started = false;
	let openGate = (): void => {};
	const gate = new Promise<void>((resolve) => {
		openGate = resolve;
	});
	runtime.track({
		name: CHILD,
		runId: "r-1",
		agent: "worker",
		sessionFile: `/tmp/${CHILD}.jsonl`,
		timeoutMs: DEFAULTS.turnTimeoutMs,
		collect: async () => {
			started = true;
			await gate;
			return terminalSnapshot("x-out");
		},
	});
	// The production order: the WATCH is already waiting on this child's collect when the
	// wait arrives, so the watch's continuation runs first (it was attached first) and
	// queues its notice while the probe's claim is still pending — which is exactly why
	// the rollback has to happen before the round is flushed, not at claim time.
	runtime.watch(CHILD);
	const job = runtime.get(CHILD);
	assert.ok(job, "fixture: the child is tracked");
	// …and the probe only fires for a child that is not in the LIVE wait set (`waitOne`
	// would otherwise share this collect without probing). `awaiting` is that state: the
	// watch has declared the child settled while its collect is still in flight.
	job.state = "awaiting";
	const { store, cwd, cleanup } = tempStore();
	const controller = new AbortController();
	try {
		const waiting = waitAction({
			params: { action: "wait", name: CHILD },
			runtime,
			agents: [agentConfig("worker")],
			store,
			cwd,
			signal: controller.signal,
		});
		// The probe shares the watch's in-flight collect; the wait races it against the abort.
		await until(() => started, "the watch (and the probe behind it) started the collect");
		controller.abort();
		const result = await within(waiting, "the wait answered on the abort");
		const details = result.details as
			| { waitClaims?: unknown[]; waitClaimsPending?: Promise<unknown> }
			| undefined;
		assert.equal(
			details?.waitClaims?.length,
			0,
			"fixture: the probe has not answered yet, so this call has taken nothing to show yet",
		);
		assert.ok(
			details?.waitClaimsPending,
			"the pending probe answer must travel with the result — without it the bail cannot know it is owed a claim",
		);

		// The bail itself — exactly what the tool layer's abort net calls, and it runs HERE,
		// while the probe is still in flight. That is the window: a synchronous rollback
		// finds an empty array and gives back nothing.
		const rollback = releaseWaitClaims(runtime, result.details);

		// NOW the collect resolves to a terminal snapshot: the probe claims `(runId, name,
		// round)` — strictly after the bail. Its claim lands in the array that already
		// travelled out, which is the whole point of sharing it by reference.
		openGate();
		await rollback;
		assert.equal(
			details?.waitClaims?.length,
			1,
			"by the time the bail returned, the probe's late claim had to be known AND given back — " +
				"an empty array here means the rollback ran before the claim existed and rolled back nothing",
		);

		// The claim that landed after the bail was handed back before the run settled, so
		// the round's notice is deliverable again — and arrives exactly once.
		await until(
			() => runtime.noticeQueueStats().pending === 1,
			"the rollback made this round's notice deliverable again",
			2_000,
		);
		runtime.notifyParentSettled();
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.equal(
			messages.length,
			1,
			"a claim that landed after the bail must still be handed back: the completion notice has to arrive exactly " +
				`once, it was delivered ${messages.length} times`,
		);
		assert.match(messages[0]!.content, /x-out/);
	} finally {
		openGate();
		cleanup();
		runtime.dispose();
	}
});

// ────────────────────────── the tool layer, for real ──────────────────────────

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
 * The extension entry point with a FakeSupervisor, in a throwaway project dir.
 * Only the supervisor is fake: the tool, the runtime, the claim table and the
 * abort net are the shipping ones. `retire` is wrapped so the child's teardown
 * parks in a gate — the RPC round trip that gives the abort its window.
 */
function toolLayerHarness() {
	const cwd = mkdtempSync(path.join(tmpdir(), "wait-claim-tool-"));
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
			return tool.execute("wait-claim", params, signal, undefined, ctx);
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
 * Launch one child, let it finish under a live run, and park its teardown in a
 * gate. `waitWithAbort: true` then waits on it and aborts the parent turn while
 * the wait is parked inside that teardown; `false` is the same fixture with
 * nothing aborting it (the positive control: this harness CAN deliver).
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
			// The wait is inside `await job.retire?.()` and the finished-cache probe has
			// already taken the claim.
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

test("#352 tool layer control: the same fixture delivers the child's notice when nothing aborts it", async () => {
	const scenario = await runToolLayerScenario({ waitWithAbort: false });
	try {
		assert.equal(scenario.retireCalls, 1, "only the watch's teardown ran — no wait was issued");
		assert.equal(scenario.notices.length, 1, "the fixture can deliver: one child, one notice, one flush");
		assert.match(scenario.notices[0]!.content, /x-out/);
	} finally {
		await scenario.cleanup();
	}
});

test("#352 tool layer: the abort net still answers `interrupted …`, and the round's notice is delivered exactly once", async () => {
	const scenario = await runToolLayerScenario({ waitWithAbort: true });
	try {
		assert.equal(scenario.retireCalls, 2, "the watch's teardown and the wait's own teardown both ran");
		assert.equal(
			scenario.answered,
			INTERRUPTED_REPLY,
			"the frozen bail line is unchanged: the rendered result is still thrown away (esc-no-retire-v3)",
		);
		// THE VERDICT: the probe's claim was handed back, so `deliverBatch` no longer
		// filters the queued notice and the parent learns the child finished — once.
		assert.equal(
			scenario.notices.length,
			1,
			"the discarded copy was the only one, so the completion notice must still be flushed exactly once — " +
				`it was delivered ${scenario.notices.length} times`,
		);
		assert.match(scenario.notices[0]!.content, /x-out/);
	} finally {
		await scenario.cleanup();
	}
});
