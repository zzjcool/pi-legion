/**
 * #314 — supervisor-layer abort (soft interrupt).
 *
 * Two facts belong to the supervisor seam:
 *
 *  - the queue is cleared **before** the turn is interrupted. Abort landing
 *    first lets the child start the oldest queued instruction immediately,
 *    which is the opposite of "stop that";
 *  - the wait is bounded, so a child stuck in a long tool call cannot park the
 *    caller — and a timeout kills nothing (no retire, no state poke);
 *  - the queue clear is bounded by the same limit (#314 D4). The only
 *    reason to abort is an unresponsive child, so a clear that never answers
 *    must cost at most one bound and must never swallow the interrupt.
 *
 * Every case runs against BOTH backends: a fix in only one of them is exactly
 * the drift this file exists to catch.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
	InProcessSupervisor,
	type InProcessSession,
} from "../../src/supervisor/inprocess-supervisor.ts";
import { RpcSupervisor } from "../../src/supervisor/rpc-supervisor.ts";
import { RoutingSupervisor } from "../../src/supervisor/routing-supervisor.ts";
import { ErrorCodes } from "../../src/shared/types.ts";
import { currentChildContext } from "../../src/supervisor/child-context.ts";
import { inProcessDepth } from "../../src/supervisor/inprocess-depth.ts";
import { DEFAULT_ABORT_TIMEOUT_MS, MAX_ABORT_TIMER_DELAY_MS } from "../../src/supervisor/types.ts";
import type {
	LegionSupervisor,
	RpcClientFactory,
	RpcClientLike,
	RpcClientOptions,
	RpcProcessHandle,
	SpawnInput,
} from "../../src/supervisor/types.ts";

/**
 * Ordered log of the backend calls an abort may make.
 *
 * Deliberately shared by reference with the fakes: assertions deep-equal the
 * whole array, so "clearQueue ran before abort" and "nothing else ran" are the
 * same assertion.
 */
type AbortLog = string[];

/**
 * Upper bound for every "this call must settle" assertion.
 *
 * The pre-change code awaits a promise that can never settle (a hanging
 * interrupt with no timeout path), and `node --test` has no default per-test
 * timeout — so an unbounded `await` parks the whole suite with zero output.
 * Racing the call against this guard turns "the timeout path is missing" into a
 * 4s failure with a readable message instead of a hang.
 */
const ABORT_BOUND_MS = 4_000;

function bounded<T>(call: Promise<T>, what = "abort()"): Promise<T> {
	let timer: NodeJS.Timeout | undefined;
	const guard = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(
			() =>
				reject(
					new Error(
						`${what} did not resolve within ${ABORT_BOUND_MS}ms — the timeout path is missing`,
					),
				),
			ABORT_BOUND_MS,
		);
		// A guard that is never needed must not hold the test process open.
		timer.unref?.();
	});
	return Promise.race([call, guard]).finally(() => clearTimeout(timer));
}

/** What the shared cases need from either backend (plus a fake-side handle). */
interface AbortHarness {
	readonly supervisor: Pick<
		LegionSupervisor,
		"abort" | "steer" | "isAlive" | "retire" | "waitSettled"
	>;
	readonly name: string;
	readonly log: AbortLog;
	/** Texts that reached the child through the **steer** seam, in call order. */
	readonly steers: string[];
	/** Texts that were sent as a fresh **prompt**, in call order. */
	readonly prompts: string[];
	/**
	 * The backend's own record for this child, read straight off the supervisor's
	 * record map.
	 *
	 * `stats()` cannot answer this: it returns `null` for a child with nothing to
	 * report (these fakes report no usage) exactly as it does for one that is no
	 * longer alive, so `retired` is only observable where the state machine writes
	 * it. `undefined` means the child is gone from the registry entirely.
	 */
	turnState(): string | undefined;
	/** Raw value the next `clearQueue` call answers with. */
	setClearQueueResult(value: unknown): void;
	/** Make the queue clear reject outright. */
	failClearQueue(): void;
	/** Make the queue clear never answer (the bounded-clear case). */
	hangClearQueue(): void;
	/**
	 * Make the queue clear reject LATE — after the bound has already answered the
	 * abort — so the losing promise's rejection has to be observed by the backend.
	 */
	rejectClearQueueAfter(ms: number): void;
	/** Make the underlying interrupt request never settle (timeout case). */
	hangAbort(): void;
	/** The child's OWN settle event — the only thing allowed to converge state. */
	settle(): void;
	close(): void;
}

function testAgent(overrides: Record<string, unknown> = {}) {
	return {
		name: "worker",
		description: "abort seam test agent",
		kind: "pi" as const,
		source: "user" as const,
		filePath: "/tmp/worker.md",
		systemPrompt: "Follow the role instructions.",
		systemPromptMode: "append" as const,
		inheritProjectContext: true,
		inheritSkills: false,
		tools: ["read"],
		...overrides,
	};
}

function spawnInput(
	root: string,
	name: string,
	agentOverrides: Record<string, unknown> = {},
): SpawnInput {
	return {
		name,
		task: "exercise the abort seam",
		agent: testAgent(agentOverrides),
		sessionFile: path.join(root, `${name}.jsonl`),
		tempDir: root,
		cwd: root,
	};
}

/* ------------------------------------------------------------------ *
 * RPC backend fakes
 * ------------------------------------------------------------------ */

/**
 * Process stub: alive forever, so a case can prove the abort did not retire it.
 * `stdin: null` makes `retireChild`'s graceful close a documented no-op instead
 * of an incidental pipe close.
 */
class FakeAbortProcess implements RpcProcessHandle {
	readonly stdin = null;
	exitCode: number | null = null;
	signalCode: NodeJS.Signals | null = null;

	once(
		event: "exit",
		listener: (code: number | null, signal: NodeJS.Signals | null) => void,
	): this;
	once(event: "error", listener: (error: Error) => void): this;
	once(): this {
		return this;
	}

	on(
		event: "exit" | "close",
		listener: (code: number | null, signal: NodeJS.Signals | null) => void,
	): this {
		return this;
	}

	off(
		event: "exit" | "close",
		listener: (code: number | null, signal: NodeJS.Signals | null) => void,
	): this {
		return this;
	}

	kill(): boolean {
		// Mark the process gone, so `retire` finishes at its SIGTERM step instead of
		// escalating into a RETIRE_FAILED throw. Nothing else in this file kills.
		this.exitCode = 0;
		return true;
	}
}

class FakeAbortClient implements RpcClientLike {
	readonly process = new FakeAbortProcess();
	/** Raw answer of `clearQueue`; the real `RpcClient` answers the SDK shape. */
	clearQueueResult: unknown = { steering: [], followUp: [] };
	/** A clear that rejects — the caller must still interrupt. */
	clearQueueThrows = false;
	/** A clear that never answers — the bound must win and zeros stay. */
	clearQueueHangs = false;
	/** A clear that rejects only after this many ms — the bound answers first. */
	clearQueueRejectsAfterMs = 0;
	/** A never-settling interrupt request (the "child ignores cancellation" case). */
	abortHangs = false;
	/** Which seam the supervisor used for a text: the steer one, or a prompt. */
	readonly steers: string[] = [];
	readonly prompts: string[] = [];
	private readonly events = new Set<(event: unknown) => void>();
	private readonly log: AbortLog;

	constructor(log: AbortLog) {
		this.log = log;
	}

	async start(): Promise<void> {}

	async stop(): Promise<void> {}

	onEvent(listener: (event: unknown) => void): () => void {
		this.events.add(listener);
		return () => this.events.delete(listener);
	}

	async prompt(text: string): Promise<unknown> {
		this.prompts.push(text);
		// `undefined` is what an older backend answers for a prompt, i.e. "a run
		// started" — the spawn must treat it as accepted, not intercepted.
		return undefined;
	}

	async steer(text: string): Promise<unknown> {
		this.steers.push(text);
		return "queued";
	}

	async followUp(): Promise<void> {}

	async clearQueue(): Promise<unknown> {
		this.log.push("clearQueue");
		if (this.clearQueueRejectsAfterMs > 0) {
			const delay = this.clearQueueRejectsAfterMs;
			return new Promise<unknown>((_resolve, reject) => {
				setTimeout(() => reject(new Error("clearQueue rejected too late")), delay);
			});
		}
		if (this.clearQueueHangs) return new Promise<unknown>(() => {});
		if (this.clearQueueThrows) throw new Error("clearQueue refused");
		return this.clearQueueResult;
	}

	abort(): Promise<void> {
		this.log.push("abort");
		if (this.abortHangs) return new Promise<void>(() => {});
		return Promise.resolve();
	}

	async getSessionStats(): Promise<unknown> {
		return null;
	}

	emit(event: unknown): void {
		for (const listener of [...this.events]) listener(event);
	}
}

async function rpcHarness(): Promise<AbortHarness> {
	const root = mkdtempSync(path.join(tmpdir(), "legion-abort-rpc-"));
	const log: AbortLog = [];
	const clients: FakeAbortClient[] = [];
	const factory: RpcClientFactory = (_options: RpcClientOptions) => {
		const client = new FakeAbortClient(log);
		clients.push(client);
		return client;
	};
	const supervisor = new RpcSupervisor({
		clientFactory: factory,
		// Same seam the rest of the unit suite uses: the memory gate probes the
		// host, and a loaded machine must not turn this seam test into a refusal.
		memoryAvailable: () => 1_000_000,
		retireTimeoutMs: 50,
		signalTimeoutMs: 50,
		killTimeoutMs: 50,
		enumerateDescendants: () => [],
	});
	const name = "root.worker";
	await supervisor.spawnChild(spawnInput(root, name));
	return {
		supervisor,
		name,
		log,
		steers: clients[0]!.steers,
		prompts: clients[0]!.prompts,
		turnState() {
			return (
				supervisor as unknown as { children: Map<string, { state?: string }> }
			).children.get(name)?.state;
		},
		setClearQueueResult(value) {
			clients[0]!.clearQueueResult = value;
		},
		failClearQueue() {
			clients[0]!.clearQueueThrows = true;
		},
		hangClearQueue() {
			clients[0]!.clearQueueHangs = true;
		},
		rejectClearQueueAfter(ms) {
			clients[0]!.clearQueueRejectsAfterMs = ms;
		},
		hangAbort() {
			clients[0]!.abortHangs = true;
		},
		settle() {
			clients[0]!.emit({ type: "agent_settled" });
		},
		close() {
			rmSync(root, { recursive: true, force: true });
		},
	};
}

/* ------------------------------------------------------------------ *
 * In-process backend fakes
 * ------------------------------------------------------------------ */

class FakeAbortSession implements InProcessSession {
	readonly clearQueueResultSink: { value: unknown } = {
		value: { steering: [], followUp: [] },
	};
	/** A clear that throws. */
	clearQueueThrows = false;
	/** A clear that never answers (returns a promise the session type allows). */
	clearQueueHangs = false;
	/** A clear that rejects only after this many ms — the bound answers first. */
	clearQueueRejectsAfterMs = 0;
	abortHangs = false;
	/** Identity (ALS store + nesting depth) observed inside `clearQueue`. */
	seenDuringClear?: { context: ReturnType<typeof currentChildContext>; depth: number };
	/** Identity observed inside `abort()` — the scope the clear has to match. */
	seenDuringAbort?: { context: ReturnType<typeof currentChildContext>; depth: number };
	/** Which seam the supervisor used for a text: the steer one, or a prompt. */
	readonly steers: string[] = [];
	readonly prompts: string[] = [];
	private readonly listeners = new Set<(event: unknown) => void>();
	private readonly log: AbortLog;

	constructor(log: AbortLog) {
		this.log = log;
	}

	subscribe(listener: (event: unknown) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	async prompt(text: string): Promise<unknown> {
		this.prompts.push(text);
		// The SDK emits the turn's opening events before `prompt()` resolves, and
		// `spawnChild` returns once the prompt is accepted (not when it ends), so
		// the child is left in an ACTIVE turn — the state abort cares about.
		this.emit({ type: "agent_start" });
		this.emit({ type: "turn_start" });
		return undefined;
	}

	async steer(text: string): Promise<unknown> {
		this.steers.push(text);
		return "queued";
	}

	async followUp(): Promise<void> {}

	/** Synchronous on `AgentSession` (`{steering, followUp}`), hence `unknown`. */
	clearQueue(): unknown {
		this.log.push("clearQueue");
		this.seenDuringClear = { context: currentChildContext(), depth: inProcessDepth() };
		if (this.clearQueueRejectsAfterMs > 0) {
			const delay = this.clearQueueRejectsAfterMs;
			return new Promise<unknown>((_resolve, reject) => {
				setTimeout(() => reject(new Error("clearQueue rejected too late")), delay);
			});
		}
		if (this.clearQueueHangs) return new Promise<unknown>(() => {});
		if (this.clearQueueThrows) throw new Error("clearQueue refused");
		return this.clearQueueResultSink.value;
	}

	abort(): Promise<unknown> {
		this.log.push("abort");
		this.seenDuringAbort = { context: currentChildContext(), depth: inProcessDepth() };
		if (this.abortHangs) return new Promise<unknown>(() => {});
		return Promise.resolve();
	}

	dispose(): void {}

	emit(event: unknown): void {
		for (const listener of [...this.listeners]) listener(event);
	}

	settle(): void {
		this.emit({ type: "turn_end" });
		this.emit({ type: "agent_end" });
		this.emit({ type: "agent_settled" });
	}
}

async function inprocessHarness(): Promise<AbortHarness> {
	const root = mkdtempSync(path.join(tmpdir(), "legion-abort-inprocess-"));
	const log: AbortLog = [];
	const sessions: FakeAbortSession[] = [];
	const supervisor = new InProcessSupervisor({
		limits: { maxActive: 8 },
		sessionFactory: async () => {
			const session = new FakeAbortSession(log);
			sessions.push(session);
			return session;
		},
	});
	const name = "root.worker";
	await supervisor.spawnChild(
		spawnInput(root, name, { spawnMode: "inprocess" }),
	);
	return {
		supervisor,
		name,
		log,
		steers: sessions[0]!.steers,
		prompts: sessions[0]!.prompts,
		turnState() {
			return (
				supervisor as unknown as { children: Map<string, { state?: string }> }
			).children.get(name)?.state;
		},
		setClearQueueResult(value) {
			sessions[0]!.clearQueueResultSink.value = value;
		},
		failClearQueue() {
			sessions[0]!.clearQueueThrows = true;
		},
		hangClearQueue() {
			sessions[0]!.clearQueueHangs = true;
		},
		rejectClearQueueAfter(ms) {
			sessions[0]!.clearQueueRejectsAfterMs = ms;
		},
		hangAbort() {
			sessions[0]!.abortHangs = true;
		},
		settle() {
			sessions[0]!.settle();
		},
		close() {
			rmSync(root, { recursive: true, force: true });
		},
	};
}

/* ------------------------------------------------------------------ *
 * Shared cases
 * ------------------------------------------------------------------ */

type MakeHarness = () => Promise<AbortHarness>;

/**
 * #314 D2: the one bound both backends and the tool receipt name, in one place.
 */
test("abort: the default bound is the shared 5s constant", () => {
	assert.equal(DEFAULT_ABORT_TIMEOUT_MS, 5_000);
});

/**
 * #314 D1: a retired child keeps throwing `NOT_FOUND`, and nothing gets called.
 *
 * Pins the order of the two guards: `assertCanSend` must run BEFORE the
 * `turnActive` check, or a retired child would answer `"no-turn"` from a
 * `turnActive` flag nobody resets — a silent success for a control action on a
 * child that no longer exists.
 */
async function assertRetiredChildIsNotFound(
	makeHarness: MakeHarness,
): Promise<void> {
	const h = await makeHarness();
	try {
		await h.supervisor.retire(h.name);
		await assert.rejects(
			() => h.supervisor.abort(h.name),
			(error: unknown) =>
				(error as { code?: string }).code === ErrorCodes.NOT_FOUND,
		);
		assert.deepEqual(h.log, [], "a retired child is neither cleared nor interrupted");
	} finally {
		h.close();
	}
}

/** D1: no turn running ⇒ nothing was done, not even a queue clear. */
async function assertNoTurn(makeHarness: MakeHarness): Promise<void> {
	const h = await makeHarness();
	try {
		// Let the child finish its turn through its own settle event.
		h.settle();
		const outcome = await bounded(h.supervisor.abort(h.name));
		assert.deepEqual(outcome, {
			status: "no-turn",
			cleared: { steering: 0, followUp: 0 },
			timeoutMs: DEFAULT_ABORT_TIMEOUT_MS,
		});
		// The whole point: neither call happened.
		assert.deepEqual(h.log, []);
	} finally {
		h.close();
	}
}

/** D2: the dropped counts come from the clear call's return value. */
async function assertInterrupted(makeHarness: MakeHarness): Promise<void> {
	const h = await makeHarness();
	try {
		h.setClearQueueResult({ steering: ["s1", "s2"], followUp: ["f1"] });
		const outcome = await bounded(h.supervisor.abort(h.name));
		assert.equal(outcome.status, "interrupted");
		assert.deepEqual(outcome.cleared, { steering: 2, followUp: 1 });
		assert.equal(
			h.log.filter((entry) => entry === "abort").length,
			1,
			"the turn is interrupted exactly once",
		);
	} finally {
		h.close();
	}
}

/** D3: clear BEFORE abort — the assertion the whole design exists for. */
async function assertClearBeforeAbort(makeHarness: MakeHarness): Promise<void> {
	const h = await makeHarness();
	try {
		h.setClearQueueResult({ steering: ["s1"], followUp: [] });
		await bounded(h.supervisor.abort(h.name));
		assert.deepEqual(h.log, ["clearQueue", "abort"]);
	} finally {
		h.close();
	}
}

/** D4/D5: bounded wait, no throw, no retire, no hand-written turn state. */
async function assertTimeout(makeHarness: MakeHarness): Promise<void> {
	const h = await makeHarness();
	try {
		h.setClearQueueResult({ steering: ["s1"], followUp: [] });
		h.hangAbort();
		// Not wrapped in try/catch on purpose: a rejection fails the test, and the
		// contract is that a timeout resolves instead of throwing. `bounded` makes the
		// missing-timeout-path case fail in seconds instead of parking the suite.
		const outcome = await bounded(
			h.supervisor.abort(h.name, { timeoutMs: 25 }),
		);
		assert.deepEqual(outcome, {
			status: "timeout",
			cleared: { steering: 1, followUp: 0 },
			// #325: the applied bound travels in the outcome, so the receipt can name it.
			timeoutMs: 25,
		});
		assert.equal(
			h.supervisor.isAlive(h.name),
			true,
			"a timed-out abort must not retire the child",
		);
		// The request did go out — both calls happened, in order.
		assert.deepEqual(h.log, ["clearQueue", "abort"]);
		// D5: state converges naturally. Had the abort faked the end of the turn,
		// this wait would have answered from a fabricated result instead of the
		// child's own `agent_settled`.
		const waiting = h.supervisor.waitSettled(h.name, 1_000);
		h.settle();
		assert.deepEqual(await waiting, {
			settled: true,
			abnormal: false,
			aborted: false,
		});
	} finally {
		h.close();
	}
}

/** D2: `clearQueued: false` leaves the queue alone and reports zeros. */
async function assertClearSkipped(makeHarness: MakeHarness): Promise<void> {
	const h = await makeHarness();
	try {
		// A non-empty answer must stay unread: nothing may be reported as dropped
		// for a clear that never happened.
		h.setClearQueueResult({ steering: ["s1", "s2"], followUp: ["f1"] });
		const outcome = await bounded(h.supervisor.abort(h.name, { clearQueued: false }));
		assert.equal(outcome.status, "interrupted");
		assert.deepEqual(outcome.cleared, { steering: 0, followUp: 0 });
		assert.deepEqual(h.log, ["abort"]);
	} finally {
		h.close();
	}
}

/**
 * #314 D4: a clear that throws reports zeros and the interrupt still goes out.
 *
 * "Best effort" has to survive the hostile case: a throwing clear is not a
 * reason to leave the child running.
 */
async function assertThrowingClearStillInterrupts(
	makeHarness: MakeHarness,
): Promise<void> {
	const h = await makeHarness();
	try {
		h.failClearQueue();
		const outcome = await bounded(h.supervisor.abort(h.name));
		assert.deepEqual(outcome, {
			status: "interrupted",
			cleared: { steering: 0, followUp: 0 },
			timeoutMs: DEFAULT_ABORT_TIMEOUT_MS,
		});
		assert.deepEqual(h.log, ["clearQueue", "abort"]);
	} finally {
		h.close();
	}
}

/**
 * #314 D4: a clear that never answers is bounded, and the interrupt is
 * sent anyway.
 *
 * This is the case the bound exists for: the only reason to abort is a child
 * that is not responding, so an unbounded pre-step would make the feature fail
 * exactly in its own use case. A short `timeoutMs` proves the bound is the
 * caller's, not the transport's; `bounded()` turns a lost race into a fast
 * failure instead of a parked suite.
 */
async function assertHangingClearIsBounded(
	makeHarness: MakeHarness,
): Promise<void> {
	const h = await makeHarness();
	try {
		h.hangClearQueue();
		const outcome = await bounded(
			h.supervisor.abort(h.name, { timeoutMs: 25 }),
		);
		assert.deepEqual(outcome, {
			status: "interrupted",
			cleared: { steering: 0, followUp: 0 },
			timeoutMs: 25,
		});
		assert.deepEqual(h.log, ["clearQueue", "abort"]);
	} finally {
		h.close();
	}
}

/**
 * #314 D4: a clear that rejects AFTER the bound answered must stay observed.
 *
 * The bound settles the caller's promise first, so the losing clear is free to
 * reject afterwards — with the interrupt already sent and nothing left awaiting
 * it. `node --test` fails a case on a rejection nobody observed, so this installs
 * a collector for exactly that window and asserts it stays empty: an abort may
 * not leak the loser it stopped waiting for. (Mutation-checked: the explicit
 * `work.catch(() => {})` is belt-and-braces — the race already observes its
 * participants — so this case pins the observable contract, not that one line.)
 */
async function assertLateClearRejectionIsObserved(
	makeHarness: MakeHarness,
): Promise<void> {
	const h = await makeHarness();
	const unhandled: unknown[] = [];
	const collect = (reason: unknown): void => {
		unhandled.push(reason);
	};
	process.on("unhandledRejection", collect);
	try {
		h.rejectClearQueueAfter(80);
		const outcome = await bounded(
			h.supervisor.abort(h.name, { timeoutMs: 25 }),
		);
		// The bound answered first, and the hopeless clear did not swallow the
		// interrupt: this is the whole point of racing the clear.
		assert.deepEqual(outcome, {
			status: "interrupted",
			cleared: { steering: 0, followUp: 0 },
			timeoutMs: 25,
		});
		assert.deepEqual(h.log, ["clearQueue", "abort"]);
		// Wait past the fake's 80ms rejection: the abort has already resolved, so
		// this is exactly the window where an unobserved loser would blow up.
		await new Promise((resolve) => setTimeout(resolve, 120));
		assert.deepEqual(
			unhandled,
			[],
			"the losing clear's rejection must be observed, not left unhandled",
		);
	} finally {
		process.off("unhandledRejection", collect);
		h.close();
	}
}

/**
 * #314 D2/D4: an `abort()` without `timeoutMs` bounds BOTH steps with the
 * shared default.
 *
 * Captured by patching `globalThis.setTimeout` instead of sleeping 5 s: the
 * clear settles immediately, so both timers are armed and cleared within the
 * same tick — only the delays they asked for are observed.
 */
async function assertDefaultBound(makeHarness: MakeHarness): Promise<void> {
	const h = await makeHarness();
	const originalSetTimeout = globalThis.setTimeout;
	const delays: number[] = [];
	try {
		globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
			if (typeof args[1] === "number") delays.push(args[1]);
			return originalSetTimeout(...args);
		}) as typeof setTimeout;
		const outcome = await bounded(h.supervisor.abort(h.name));
		assert.equal(outcome.status, "interrupted");
		// One timer for the clear, one for the interrupt: neither may fall back to
		// the transport's own timeout or to a literal that drifted from the constant.
		assert.deepEqual(
			delays.filter((delay) => delay === DEFAULT_ABORT_TIMEOUT_MS),
			[DEFAULT_ABORT_TIMEOUT_MS, DEFAULT_ABORT_TIMEOUT_MS],
		);
	} finally {
		globalThis.setTimeout = originalSetTimeout;
		h.close();
	}
}

/**
 * #314 D2: junk `timeoutMs` values fall back to the shared bound, and an
 * over-large one is capped at the largest delay a timer honours.
 *
 * Both facts are observable only in the delay handed to `setTimeout`, so this
 * patches it and records the REQUESTED delay while shortening it — paying a real
 * 5 s (let alone 2^31−1 ms) would be the test waiting on the very bound it
 * asserts. A hanging clear and a hanging interrupt mean those two timers are the
 * only things deciding the outcome.
 */
async function assertJunkTimeoutIsNormalized(
	makeHarness: MakeHarness,
): Promise<void> {
	const h = await makeHarness();
	const originalSetTimeout = globalThis.setTimeout;
	const delays: number[] = [];
	const shorten = (delay: number): number =>
		delay === DEFAULT_ABORT_TIMEOUT_MS || delay === MAX_ABORT_TIMER_DELAY_MS
			? 20
			: delay;
	try {
		globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
			if (typeof args[1] === "number") {
				delays.push(args[1]);
				args[1] = shorten(args[1]);
			}
			return originalSetTimeout(...args);
		}) as typeof setTimeout;
		h.hangClearQueue();
		h.hangAbort();
		for (const junk of [0, -5, NaN, Infinity]) {
			delays.length = 0;
			const outcome = await bounded(
				h.supervisor.abort(h.name, { timeoutMs: junk }),
			);
			// Both steps fell back to the shared bound, and the shared bound is what
			// the timer was asked for — once for the clear, once for the interrupt.
			// A junk value that reached `setTimeout` would collapse to 1 ms and turn
			// this into an instant fake `"timeout"`.
			assert.equal(outcome.status, "timeout", `timeoutMs=${String(junk)}`);
			assert.deepEqual(
				delays.filter((delay) => delay === DEFAULT_ABORT_TIMEOUT_MS),
				[DEFAULT_ABORT_TIMEOUT_MS, DEFAULT_ABORT_TIMEOUT_MS],
				`timeoutMs=${String(junk)} must bound both steps with the shared default`,
			);
		}
		delays.length = 0;
		const huge = await bounded(
			h.supervisor.abort(h.name, { timeoutMs: 1e12 }),
		);
		assert.equal(huge.status, "timeout");
		// Out-of-range, not passed through: Node collapses a delay above 2^31−1 to
		// 1 ms, which is exactly the fake timeout the normalize step exists to stop.
		assert.deepEqual(
			delays.filter((delay) => delay === MAX_ABORT_TIMER_DELAY_MS),
			[MAX_ABORT_TIMER_DELAY_MS, MAX_ABORT_TIMER_DELAY_MS],
			"an over-large bound is capped at the largest timer delay",
		);
		assert.equal(
			delays.includes(1),
			false,
			"an over-large bound must not reach setTimeout un-clamped",
		);
	} finally {
		globalThis.setTimeout = originalSetTimeout;
		h.close();
	}
}

/*
 * #314 acceptance (issue wording): "after an abort, `status` shows idle/running
 * rather than retired, and the child can still be driven with `steer`/`prompt`".
 *
 * `isAlive === true` is necessary but not the whole claim: an abort that left the
 * child registered and mute, or one that wrote a fake end-of-turn, keeps
 * `isAlive` true as well. So this case drives the child through the same entry
 * point a caller would, on both sides of the settle:
 *
 *  1. steered while the interrupted turn is still winding down, the text takes
 *     the **steer** seam (`session.steers` / `client.steers`) — which is only
 *     true while `turnActive` is still set, i.e. `abort` did not fabricate the
 *     end of a turn whose own settle event has not arrived (#314 D4);
 *  2. steered again after the child's own `agent_settled`, the same call starts a
 *     fresh turn (`"accepted"`), so the child is not merely reachable but usable.
 *
 * A child that `abort` had retired throws `NOT_FOUND` at step 1 and never reaches
 * step 2 — the regression this case exists for.
 */
async function assertStillDrivableAfterAbort(
	makeHarness: MakeHarness,
): Promise<void> {
	const h = await makeHarness();
	try {
		h.setClearQueueResult({ steering: ["s1"], followUp: [] });
		const outcome = await bounded(h.supervisor.abort(h.name));
		assert.equal(outcome.status, "interrupted");
		// Not retired, not unnamed, not dead: the abort only interrupted.
		assert.equal(h.supervisor.isAlive(h.name), true);
		assert.notEqual(h.turnState(), "retired");
		assert.equal(h.turnState(), "running");

		// 1) mid-turn: the steer seam receives the text, and no prompt is sent.
		const promptsBefore = h.prompts.length;
		const queued = await h.supervisor.steer(h.name, "take this after the abort");
		assert.equal(queued, "queued");
		assert.deepEqual(h.steers, ["take this after the abort"]);
		assert.equal(
			h.prompts.length,
			promptsBefore,
			"a busy child is steered, never re-prompted",
		);

		// The interrupted turn ends the way it does in production: on the child's
		// own event, never on anything the abort handed back.
		h.settle();
		assert.equal(h.turnState(), "idle");
		assert.equal(h.supervisor.isAlive(h.name), true);

		// 2) now idle: the same entry point starts a new turn instead of refusing.
		const accepted = await h.supervisor.steer(h.name, "next turn after abort");
		assert.equal(accepted, "accepted");
		assert.equal(h.prompts[h.prompts.length - 1], "next turn after abort");
		assert.equal(h.turnState(), "running");
		assert.equal(h.supervisor.isAlive(h.name), true);
	} finally {
		h.close();
	}
}

/**
 * #314 D4: both bounded races clear their timer on the settling path.
 *
 * `assertDefaultBound` above only observes the delay handed to `setTimeout`, so
 * deleting `.finally(clearTimeout)` from either race keeps it green — the timer
 * is ref'd, and the sole symptom is the test process lingering for one bound
 * ("still green, just slower"). This case pins the call itself on BOTH paths,
 * the way `supervisor.test.ts` pins the `waitSettled` guard:
 *
 *  - success: both steps settle immediately, so both timers are armed and cleared
 *    within one tick and only the calls are observable;
 *  - timeout: the timers fire (that is what answers the caller) and the settling
 *    path must still clear them.
 *
 * Timer identity is compared by handle, so a `clearTimeout` aimed at some other
 * timer cannot satisfy the assertion. The timeout path asks for a bound nothing
 * else in this file uses, so no unrelated timer can be mistaken for abort's two.
 */
async function assertAbortClearsItsTimers(
	makeHarness: MakeHarness,
): Promise<void> {
	const h = await makeHarness();
	const originalSetTimeout = globalThis.setTimeout;
	const originalClearTimeout = globalThis.clearTimeout;
	/** Distinctive marker delay: no other timer in this file asks for it. */
	const TIMEOUT_PATH_BOUND_MS = 37;
	let recording = false;
	let armed: { timer: ReturnType<typeof setTimeout>; delay: number }[] = [];
	const cleared = new Set<unknown>();
	try {
		globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
			const timer = originalSetTimeout(...args);
			if (recording && typeof args[1] === "number") {
				armed.push({ timer, delay: args[1] });
			}
			return timer;
		}) as typeof setTimeout;
		globalThis.clearTimeout = ((handle?: Parameters<typeof clearTimeout>[0]) => {
			cleared.add(handle);
			return originalClearTimeout(handle);
		}) as typeof clearTimeout;
		const armedFor = (delay: number): typeof armed =>
			armed.filter((entry) => entry.delay === delay);
		const clearedAmong = (timers: typeof armed): number =>
			timers.filter((entry) => cleared.has(entry.timer)).length;

		// Path 1 — success. (`armed` is reset per path; `bounded`'s own 4s guard is
		// filtered out by delay, not by ordering.)
		recording = true;
		armed = [];
		const outcome = await bounded(h.supervisor.abort(h.name));
		recording = false;
		assert.equal(outcome.status, "interrupted");
		const successTimers = armedFor(DEFAULT_ABORT_TIMEOUT_MS);
		assert.equal(
			successTimers.length,
			2,
			"one timer for the queue clear, one for the interrupt",
		);
		assert.equal(
			clearedAmong(successTimers),
			2,
			"a successful abort clears both of its timers",
		);

		// Path 2 — timeout: the timers fire, and the settling path clears them anyway.
		h.hangClearQueue();
		h.hangAbort();
		recording = true;
		armed = [];
		const timedOut = await bounded(
			h.supervisor.abort(h.name, { timeoutMs: TIMEOUT_PATH_BOUND_MS }),
		);
		recording = false;
		assert.equal(timedOut.status, "timeout");
		const timeoutTimers = armedFor(TIMEOUT_PATH_BOUND_MS);
		assert.equal(
			timeoutTimers.length,
			2,
			"the timeout path arms the same two bounds",
		);
		assert.equal(
			clearedAmong(timeoutTimers),
			2,
			"a timed-out abort clears both of its timers too",
		);
	} finally {
		globalThis.setTimeout = originalSetTimeout;
		globalThis.clearTimeout = originalClearTimeout;
		h.close();
	}
}

/* ------------------------------------------------------------------ *
 * RPC backend
 * ------------------------------------------------------------------ */

test("abort rpc: an idle child is 'no-turn' and nothing is called", () =>
	assertNoTurn(rpcHarness));

test("abort rpc: clears the queue and reports what it dropped", () =>
	assertInterrupted(rpcHarness));

test("abort rpc: the queue is cleared before the turn is interrupted", () =>
	assertClearBeforeAbort(rpcHarness));

test("abort rpc: a hanging interrupt resolves as 'timeout' without retiring", () =>
	assertTimeout(rpcHarness));

test("abort rpc: clearQueued:false skips the clear and reports zeros", () =>
	assertClearSkipped(rpcHarness));

test("abort rpc: a retired child still throws NOT_FOUND and calls nothing", () =>
	assertRetiredChildIsNotFound(rpcHarness));

test("abort rpc: a throwing clear reports zeros and still interrupts", () =>
	assertThrowingClearStillInterrupts(rpcHarness));

test("abort rpc: a hanging clear is bounded and still interrupts", () =>
	assertHangingClearIsBounded(rpcHarness));

test("abort rpc: an abort without timeoutMs bounds both steps with the default", () =>
	assertDefaultBound(rpcHarness));

test("abort rpc: a clear that rejects after the bound still reports interrupted", () =>
	assertLateClearRejectionIsObserved(rpcHarness));

test("abort rpc: a junk timeoutMs falls back to the shared bound", () =>
	assertJunkTimeoutIsNormalized(rpcHarness));

test("abort rpc: the child is still drivable afterwards (steer, then a new turn)", () =>
	assertStillDrivableAfterAbort(rpcHarness));

test("abort rpc: both the success and the timeout path clear their timers", () =>
	assertAbortClearsItsTimers(rpcHarness));

/* ------------------------------------------------------------------ *
 * In-process backend
 * ------------------------------------------------------------------ */

test("abort inprocess: an idle child is 'no-turn' and nothing is called", () =>
	assertNoTurn(inprocessHarness));

test("abort inprocess: clears the queue and reports what it dropped", () =>
	assertInterrupted(inprocessHarness));

test("abort inprocess: the queue is cleared before the turn is interrupted", () =>
	assertClearBeforeAbort(inprocessHarness));

test("abort inprocess: a hanging interrupt resolves as 'timeout' without retiring", () =>
	assertTimeout(inprocessHarness));

test("abort inprocess: clearQueued:false skips the clear and reports zeros", () =>
	assertClearSkipped(inprocessHarness));

test("abort inprocess: a retired child still throws NOT_FOUND and calls nothing", () =>
	assertRetiredChildIsNotFound(inprocessHarness));

test("abort inprocess: a throwing clear reports zeros and still interrupts", () =>
	assertThrowingClearStillInterrupts(inprocessHarness));

test("abort inprocess: a hanging clear is bounded and still interrupts", () =>
	assertHangingClearIsBounded(inprocessHarness));

test("abort inprocess: an abort without timeoutMs bounds both steps with the default", () =>
	assertDefaultBound(inprocessHarness));

test("abort inprocess: a clear that rejects after the bound still reports interrupted", () =>
	assertLateClearRejectionIsObserved(inprocessHarness));

test("abort inprocess: a junk timeoutMs falls back to the shared bound", () =>
	assertJunkTimeoutIsNormalized(inprocessHarness));

test("abort inprocess: the child is still drivable afterwards (steer, then a new turn)", () =>
	assertStillDrivableAfterAbort(inprocessHarness));

test("abort inprocess: both the success and the timeout path clear their timers", () =>
	assertAbortClearsItsTimers(inprocessHarness));

/* ------------------------------------------------------------------ *
 * In-process identity scope for the pre-abort clear (#325)
 * ------------------------------------------------------------------ */

test("abort inprocess: the pre-abort clear runs in the child's identity scope", async () => {
	// The clear is not a host-side bookkeeping call: it settles queued-message
	// promises, and a continuation resumed there inherits whatever ALS store is
	// active. Run outside the child's scope, host code would resume believing it IS
	// the child — the REV2-7 hazard the interrupt branch already guards against, so
	// the clear has to sit in the SAME `runAtAbsoluteDepth` + `runInChildContext`
	// pair. Both steps are read off the session, so "same scope" is measured, not
	// assumed: the interrupt itself is the reference.
	const root = mkdtempSync(path.join(tmpdir(), "legion-abort-identity-"));
	const log: AbortLog = [];
	const sessions: FakeAbortSession[] = [];
	const supervisor = new InProcessSupervisor({
		limits: { maxActive: 8 },
		sessionFactory: async () => {
			const session = new FakeAbortSession(log);
			sessions.push(session);
			return session;
		},
	});
	const name = "root.worker";
	try {
		await supervisor.spawnChild({
			...spawnInput(root, name, { spawnMode: "inprocess" }),
			childLaunchContext: {
				nodeId: "node-9",
				parentNodeId: "node-1",
				dbPath: "/tmp/legion.db",
				parentPath: [{ runId: "root" }],
				acceptanceRole: "writer",
				allowNested: true,
				utility: false,
				spawnMode: "inprocess",
			},
		});
		sessions[0]!.clearQueueResultSink.value = { steering: ["s1"], followUp: [] };

		const outcome = await bounded(supervisor.abort(name));
		assert.equal(outcome.status, "interrupted");

		const duringClear = sessions[0]!.seenDuringClear;
		const duringAbort = sessions[0]!.seenDuringAbort;
		assert.equal(
			duringClear?.context?.nodeId,
			"node-9",
			"the clear runs as the child, not as the host session",
		);
		assert.equal(duringClear?.depth, 1, "and at the child's own nesting depth");
		assert.deepEqual(
			duringClear?.context,
			duringAbort?.context,
			"the same identity the interrupt sees",
		);
		assert.equal(duringClear?.depth, duringAbort?.depth, "and the same depth");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

/* ------------------------------------------------------------------ *
 * Routing (D8)
 * ------------------------------------------------------------------ */

test("abort routing: forwards (name, opts) to the owning backend and returns its outcome", async () => {
	const root = mkdtempSync(path.join(tmpdir(), "legion-abort-routing-"));
	const log: AbortLog = [];
	const clients: FakeAbortClient[] = [];
	const rpc = new RpcSupervisor({
		clientFactory: () => {
			const client = new FakeAbortClient(log);
			clients.push(client);
			return client;
		},
		memoryAvailable: () => 1_000_000,
		retireTimeoutMs: 50,
		signalTimeoutMs: 50,
		killTimeoutMs: 50,
		enumerateDescendants: () => [],
	});
	const router = new RoutingSupervisor({ rpc });
	const name = "root.worker";
	try {
		// Pin the backend: the default spawn mode is `inprocess`, which would route
		// the spawn to the router's own (real) in-process backend instead of the
		// injected RPC one this case asserts against.
		await router.spawnChild(spawnInput(root, name, { spawnMode: "rpc" }));
		clients[0]!.clearQueueResult = { steering: ["s1"], followUp: ["f1", "f2"] };
		const outcome = await bounded(router.abort(name, { timeoutMs: 50 }));
		// Forwarded options AND the backend's own counts come back untouched.
		assert.deepEqual(outcome, {
			status: "interrupted",
			cleared: { steering: 1, followUp: 2 },
			timeoutMs: 50,
		});
		assert.deepEqual(log, ["clearQueue", "abort"]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("abort routing: forwards opts to the inprocess backend and returns its outcome", async () => {
	const root = mkdtempSync(path.join(tmpdir(), "legion-abort-routing-inprocess-"));
	const log: AbortLog = [];
	const sessions: FakeAbortSession[] = [];
	const inprocess = new InProcessSupervisor({
		limits: { maxActive: 8 },
		sessionFactory: async () => {
			const session = new FakeAbortSession(log);
			sessions.push(session);
			return session;
		},
	});
	const router = new RoutingSupervisor({ inprocess });
	const name = "root.worker";
	try {
		await router.spawnChild(spawnInput(root, name, { spawnMode: "inprocess" }));
		sessions[0]!.clearQueueResultSink.value = {
			steering: ["s1"],
			followUp: ["f1"],
		};
		const outcome = await bounded(router.abort(name, { clearQueued: false }));
		// `clearQueued:false` only reaches the backend if the facade forwards opts:
		// a facade that dropped them would clear here and report 1/1.
		assert.deepEqual(outcome, {
			status: "interrupted",
			cleared: { steering: 0, followUp: 0 },
			timeoutMs: DEFAULT_ABORT_TIMEOUT_MS,
		});
		assert.deepEqual(log, ["abort"]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
