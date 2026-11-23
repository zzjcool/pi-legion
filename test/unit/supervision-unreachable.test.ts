/**
 * #460 — a supervision READ failing is not the child dying.
 *
 * The incident: a cross-machine dispatch was judged `execution: failed` with
 * `terminal.get failed for terminal 'lgl-r-…': hc connect exited (code 0)`, the
 * parent re-dispatched the work into a second worktree, and the ORIGINAL child —
 * still running on the other machine — finished the issue and opened its own PR.
 * Transport was down; the child was fine. Two implementations, two PRs.
 *
 * What is pinned here:
 *
 *   1. a `terminal.get` TRANSPORT failure mid-poll puts the record in
 *      `unreachable` (never `failed`/`gone`), keeps the terminal address, and a
 *      channel that recovers is picked up again in the SAME wait;
 *   2. `stop` still reaches that address — `terminal.kill` is really sent to the
 *      terminal the child was created with;
 *   3. control group: `not_found` (the core no longer knows the address) and a dead
 *      process are still deaths, with the verdicts they had before this change;
 *   4. the re-dispatch guard: an `unreachable` child still holds its name;
 *   5. `collect` on an unreachable child is `running` + an explicit
 *      "supervision unreachable" reason, so the watch re-arms and a parent cannot
 *      mistake a dead channel for a failed child.
 *
 * Nothing here spawns `hc`: the backend is driven through an injected protocol
 * client, and `collect` through the in-memory supervisor.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { HcRpcError, type HcClient, type HcMethod } from "../../src/hc/client.ts";
import { COLLECT_DEADLINE_REASON, Orchestrator, SUPERVISION_UNREACHABLE_REASON } from "../../src/runs/orchestrator.ts";
import { shouldRecycleAfterCollect } from "../../src/extension/runtime.ts";
import {
	HERDR_SPACE_LABEL,
	SUPERVISION_UNREACHABLE_REASON as SUPERVISOR_UNREACHABLE_REASON,
	TerminalSupervisor,
	UNREACHABLE_STRIKE_LIMIT,
} from "../../src/supervisor/terminal-supervisor.ts";
import { ErrorCodes, SubagentError, type AgentConfig } from "../../src/shared/types.ts";
import type { SettleResult, SpawnInput } from "../../src/supervisor/types.ts";
import { FakeSupervisor } from "../helpers/fake-supervisor.ts";

// ── fixture ───────────────────────────────────────────────────────────────

type Params = Record<string, unknown>;

interface Call {
	method: HcMethod;
	params: Params;
}

/** A protocol client that records calls and can fail a read on demand. */
class FakeHcClient implements HcClient {
	readonly calls: Call[] = [];
	private readonly handlers = new Map<string, (params: Params) => unknown>();

	on(method: HcMethod, handler: (params: Params) => unknown): this {
		this.handlers.set(method, handler);
		return this;
	}

	async start(): Promise<void> {
		/* nothing to start */
	}

	async request<T = unknown>(method: HcMethod, params: Params = {}): Promise<T> {
		this.calls.push({ method, params });
		const handler = this.handlers.get(method);
		if (!handler) throw new Error(`fake hc client: no handler for ${method}`);
		return (await handler(params)) as T;
	}

	close(): void {
		/* nothing to close */
	}

	methods(): HcMethod[] {
		return this.calls.map((call) => call.method);
	}

	paramsFor(method: HcMethod): Params[] {
		return this.calls.filter((call) => call.method === method).map((call) => call.params);
	}
}

const TERMINAL_ID = "t1k";
const SOCKET = "/tmp/hc-test/default.sock";
const CHILD = "root.centurion-0";

/**
 * The failure the incident really reported: `hc connect exited (code 0)`. It is a
 * `HcRpcError` with `kind: "transport"` — NOT `not_found`, which is the only
 * answer that means "this terminal is gone".
 */
function transportError(): HcRpcError {
	return new HcRpcError({ code: -32603, message: "hc connect exited (code 0)", data: { kind: "transport" } });
}

function notFoundError(): HcRpcError {
	return new HcRpcError({ code: -32000, message: "not_found", data: { kind: "not_found" } });
}

function agent(): AgentConfig {
	return {
		name: "centurion",
		description: "terminal backend test role",
		systemPromptMode: "append",
		inheritProjectContext: false,
		inheritSkills: false,
		kind: "pi",
		systemPrompt: "You are a test centurion.",
		source: "user",
		filePath: "/fake/centurion.md",
		worktree: true,
	};
}

function spawnInput(root: string): SpawnInput {
	return {
		name: CHILD,
		task: "Implement the slice.",
		agent: agent(),
		sessionFile: path.join(root, "session.jsonl"),
		tempDir: root,
		cwd: root,
		env: {},
		cliPath: "/fake/pi/dist/cli.js",
	};
}

interface Harness {
	client: FakeHcClient;
	supervisor: TerminalSupervisor;
	root: string;
	cleanup(): void;
}

/**
 * `childReads` is the handler for the CHILD's `terminal.get` (the parent-space
 * lookup shares the method and is answered separately, exactly as the core does).
 */
function harness(
	childReads: (params: Params) => unknown,
	options: { unreachableStrikeLimit?: number } = {},
): Harness {
	const root = mkdtempSync(path.join(tmpdir(), "supervision-unreachable-"));
	const client = new FakeHcClient();
	client.on("terminal.get", (params) => {
		if (params.terminal === TERMINAL_ID) {
			return { address: TERMINAL_ID, state: "live", labels: { [HERDR_SPACE_LABEL]: "space-7" } };
		}
		return childReads(params);
	});
	client.on("terminal.run", () => ({ address: "hc-addr-8", state: "live", turn: 0, status: { state: "idle" }, pid: 4242 }));
	client.on("terminal.send", () => ({ turn: 1, started: true }));
	client.on("terminal.kill", () => ({ address: "hc-addr-8", state: "finished" }));
	client.on("terminal.rm", () => ({ removed: "hc-addr-8" }));
	const supervisor = new TerminalSupervisor({
		clientFactory: () => client,
		env: { HC_TERMINAL_SOCKET: SOCKET, HC_TERMINAL_ID: TERMINAL_ID, PATH: "/usr/bin", HOME: "/home/test" },
		pollIntervalMs: 5,
		// Local transport only: the remote start-up gate has nothing to ask here.
		remoteStartupConfirmMs: 0,
		...(options.unreachableStrikeLimit !== undefined ? { unreachableStrikeLimit: options.unreachableStrikeLimit } : {}),
	});
	return {
		client,
		supervisor,
		root,
		cleanup: () => rmSync(root, { recursive: true, force: true }),
	};
}

/**
 * The terminal NAME the child was created with — which IS the address every later
 * call passes (`terminalAddress()` prefixes the machine only for a remote child;
 * the remote half of that invariant is pinned in `remote-child-fate.test.ts`).
 */
function createdTerminalName(h: Harness): string {
	const run = h.client.paramsFor("terminal.run")[0];
	assert.ok(run, "the launch must have reached terminal.run");
	const name = String(run.name);
	assert.ok(name.length > 0, "terminal.run carries the name every later call addresses");
	return name;
}

// ── 1. transport failure is `unreachable`, and recovery resumes tracking ──

test("#460: a transport failure mid-poll is `unreachable`, not `failed` — and the same wait resumes when the channel returns", async () => {
	let childReads = 0;
	/** State the supervisor reported BEFORE each read was answered. */
	const statesBeforeRead: Array<string | undefined> = [];
	let strikesAtSecondFailure: number | undefined;
	let detail = "";
	const h = harness(() => {
		childReads += 1;
		const state = h.supervisor.supervision(CHILD);
		statesBeforeRead.push(state?.state);
		if (childReads === 1) {
			// The pre-failure reading: live, boot-time turn 0 (D8 never settles on it).
			return { state: "live", turn: 0, status: { state: "idle" } };
		}
		if (childReads <= 3) {
			// Two consecutive transport failures — under the strike budget, so the wait
			// must KEEP POLLING rather than give up on the child.
			detail = state?.unreachable?.detail ?? "";
			throw transportError();
		}
		// Recovery: this read is answered, and the child has finished its turn. The
		// marker at this instant is the one both failures produced.
		strikesAtSecondFailure = state?.unreachable?.strikes;
		return { state: "live", turn: 1, status: { state: "done" } };
	});
	try {
		await h.supervisor.spawnChild(spawnInput(h.root));
		const address = createdTerminalName(h);
		const settled = await h.supervisor.waitSettled(CHILD, 2_000);

		// (a) the wait treated the failure as a CHANNEL problem, not a death: it kept
		// polling and settled on the recovered reading.
		assert.deepEqual(settled, { settled: true, abnormal: false });
		assert.ok(childReads >= 4, `the wait must poll through the failure (reads=${childReads})`);

		// (b) mid-poll the record said `unreachable` — never `finished`/`retired`.
		// Index 0/1 are recorded BEFORE the read that fails answers, so the marker
		// appears from the read after the first failure and holds through the
		// recovery read (it is cleared by folding that reading in, not by asking).
		assert.deepEqual(statesBeforeRead, ["live", "live", "unreachable", "unreachable"]);
		assert.equal(strikesAtSecondFailure, 2, "consecutive strikes are counted on the record (two failures, one read later)");
		assert.match(detail, /hc connect exited \(code 0\)/, "the transport failure itself is visible, quoted");

		// (c) the address never changed: every child read used the name the terminal
		// was created with (`isAlive`/`status`/`stop` all address it that way).
		const childGets = h.client.paramsFor("terminal.get").filter((params) => params.terminal !== TERMINAL_ID);
		assert.deepEqual(
			childGets.map((params) => params.terminal),
			childGets.map(() => address),
			"every read addressed the same terminal",
		);
		assert.ok(address.length > 0);

		// (d) after the recovery the child is `live` again and tracking continues.
		assert.equal(h.supervisor.supervision(CHILD)?.state, "live");
		assert.equal(h.supervisor.supervision(CHILD)?.unreachable, undefined, "the outage marker is cleared on recovery");
		assert.equal(h.supervisor.isAlive(CHILD), true);
		// A wait never kills: the child was never observed dead.
		assert.equal(h.client.methods().includes("terminal.kill"), false);
	} finally {
		h.cleanup();
	}
});

// ── 1b. bounded: a channel that never returns gives an epoch, not a death ──

test("#460: a channel that never returns answers `unreachable` after a BOUNDED number of retries, keeping the child alive", async () => {
	let childReads = 0;
	const h = harness(() => {
		childReads += 1;
		throw transportError();
	});
	try {
		await h.supervisor.spawnChild(spawnInput(h.root));
		const settled = await h.supervisor.waitSettled(CHILD, 5_000);

		// The result is not a verdict about the child: `abnormal` stays false, and the
		// unreachable fact travels beside it.
		assert.equal(settled.settled, false);
		assert.equal(settled.abnormal, false, "a blind supervisor may never report a death");
		assert.equal(settled.reason, SUPERVISOR_UNREACHABLE_REASON);
		assert.equal(settled.unreachable?.strikes, UNREACHABLE_STRIKE_LIMIT, "retries are capped, not unbounded");
		assert.match(String(settled.unreachable?.detail), /hc connect exited \(code 0\)/);

		// Bounded here too: the poll stopped at the strike limit instead of spending
		// the whole 5 s budget (the issue's "no unbounded retry").
		assert.equal(childReads, UNREACHABLE_STRIKE_LIMIT);

		// Visible state, kept record: `status` still lists the child and `stop` can
		// still reach it (asserted in the next test).
		assert.equal(h.supervisor.supervision(CHILD)?.state, "unreachable");
		assert.equal(h.supervisor.isAlive(CHILD), true, "an unreachable child is still listed");
		assert.equal(h.supervisor.supervision(CHILD)?.unreachable?.strikes, UNREACHABLE_STRIKE_LIMIT);
		// …and the outage is dated, so an operator can see how long the channel is down.
		assert.equal(typeof h.supervisor.supervision(CHILD)?.unreachable?.since, "number");
		// Nothing was killed by a WAIT.
		assert.equal(h.client.methods().includes("terminal.kill"), false);
	} finally {
		h.cleanup();
	}
});

// ── 1c. an announced outage stops answering early (no fast re-arm loop) ──

/**
 * The watch re-arms a `running` snapshot with NO delay
 * (`runtime.ts rearmLiveWatch`) — that is only not a busy loop because a collect
 * normally blocks for its whole deadline. An `unreachable` verdict returned in ~2 s
 * would therefore be retried every ~2 s forever, which is the "no unbounded retry"
 * the issue rules out. So the FIRST epoch answers fast (the caller must learn about
 * the outage) and later epochs poll out the caller's own budget at the slow cadence.
 */
test("#460: a second wait for an ALREADY-ANNOUNCED outage spends the caller's budget instead of re-arming a fast loop", async () => {
	let childReads = 0;
	const h = harness(() => {
		childReads += 1;
		throw transportError();
	});
	try {
		await h.supervisor.spawnChild(spawnInput(h.root));

		// Epoch 1 — fast: answered as soon as the strike budget is spent.
		const first = await h.supervisor.waitSettled(CHILD, 5_000);
		assert.equal(first.reason, SUPERVISOR_UNREACHABLE_REASON);
		assert.equal(first.abnormal, false);
		const readsAfterFirst = childReads;
		assert.equal(readsAfterFirst, UNREACHABLE_STRIKE_LIMIT);
		assert.equal(h.supervisor.supervision(CHILD)?.unreachable?.epochs, 1, "the outage is now announced");
		const outageStart = h.supervisor.supervision(CHILD)?.unreachable?.since;
		assert.equal(typeof outageStart, "number");

		// Epoch 2 — the outage is known, so the wait must not answer after three quick
		// reads; it has to spend the budget it was given (a collect re-arm is bounded
		// by the deadline, not by the strike cadence).
		const started = Date.now();
		const second = await h.supervisor.waitSettled(CHILD, 400);
		const elapsed = Date.now() - started;
		assert.equal(second.reason, SUPERVISOR_UNREACHABLE_REASON);
		assert.equal(second.abnormal, false, "still no death certificate");
		assert.ok(elapsed >= 300, `the announced epoch must spend the caller's budget (spent ${elapsed}ms)`);
		assert.ok(
			childReads - readsAfterFirst <= 3,
			`no fast retry loop: ${childReads - readsAfterFirst} reads in ${elapsed}ms`,
		);
		assert.equal(h.supervisor.supervision(CHILD)?.unreachable?.epochs, 2);
		assert.equal(
			h.supervisor.supervision(CHILD)?.unreachable?.since,
			outageStart,
			"the outage is dated from its FIRST failure, not from the last one",
		);
		assert.equal(h.supervisor.isAlive(CHILD), true, "the child is still tracked, with its address");
	} finally {
		h.cleanup();
	}
});

// ── 1d. a failing read never resurrects a finished/retired record ────────

test("#460: a failing read does not resurrect a record that already ended", async () => {
	let channelDown = false;
	const h = harness(() => {
		if (channelDown) throw transportError();
		return { state: "live", turn: 0, status: { state: "idle" } };
	});
	try {
		await h.supervisor.spawnChild(spawnInput(h.root));
		await h.supervisor.retire(CHILD);
		assert.equal(h.supervisor.supervision(CHILD)?.state, "retired");
		channelDown = true;
		const settled = await h.supervisor.waitSettled(CHILD, 100);
		// Retirement is a fact this host established; a later failed read cannot undo it.
		assert.equal(settled.abnormal, true);
		assert.equal(settled.unreachable, undefined);
		assert.equal(settled.reason, "terminal retired");
		assert.equal(h.supervisor.supervision(CHILD)?.state, "retired");
		assert.equal(h.supervisor.isAlive(CHILD), false, "a dead record must not answer `alive`");
	} finally {
		h.cleanup();
	}
});

// ── 2. stop still reaches the address ────────────────────────────────────

test("#460: `stop` on an unreachable child still sends terminal.kill to its address", async () => {
	const h = harness(() => {
		throw transportError();
	});
	try {
		await h.supervisor.spawnChild(spawnInput(h.root));
		const address = createdTerminalName(h);
		await h.supervisor.waitSettled(CHILD, 5_000);
		assert.equal(h.supervisor.supervision(CHILD)?.state, "unreachable", "precondition: the channel is down");
		assert.equal(h.client.methods().includes("terminal.kill"), false, "precondition: only the wait has run");

		// `stop` = retire. It must not depend on being able to SEE the child.
		await h.supervisor.retire(CHILD);

		const kills = h.client.paramsFor("terminal.kill");
		assert.equal(kills.length, 1, "exactly one kill, delivered to the address");
		assert.equal(kills[0]?.terminal, address, "killed by the terminal the child was created with");
		assert.equal(String(kills[0]?.terminal).length > 0, true);
		const methods = h.client.methods();
		assert.ok(
			methods.indexOf("terminal.rm") > methods.indexOf("terminal.kill"),
			"the rm still follows the kill (D11)",
		);
		assert.equal(h.supervisor.supervision(CHILD)?.state, "retired");
		assert.equal(h.supervisor.supervision(CHILD)?.unreachable, undefined);
		assert.equal(h.supervisor.isAlive(CHILD), false);
	} finally {
		h.cleanup();
	}
});

// ── 3. control group: confirmed death is still death ─────────────────────

test("#460 control: `not_found` still ends the child (abnormal settle, finished record) — unchanged", async () => {
	let childReads = 0;
	const h = harness(() => {
		childReads += 1;
		if (childReads === 1) return { state: "live", turn: 0, status: { state: "idle" } };
		// The core no longer knows the address: this IS death, and it is the one answer
		// a supervision read may read as a lifecycle fact.
		throw notFoundError();
	});
	try {
		await h.supervisor.spawnChild(spawnInput(h.root));
		const settled = await h.supervisor.waitSettled(CHILD, 500);
		assert.equal(settled.unreachable, undefined, "confirmed death is not a supervision outage");
		assert.deepEqual(settled, { settled: false, abnormal: true, reason: "terminal not found" });
		assert.equal(h.supervisor.supervision(CHILD)?.state, "finished");
		assert.equal(h.supervisor.isAlive(CHILD), false, "a terminal the core does not know is over");
	} finally {
		h.cleanup();
	}
});

test("#460 control: a finished terminal still settles with its exit code", async () => {
	const h = harness(() => ({ state: "finished", turn: 0, exit_code: 0, status: null }));
	try {
		await h.supervisor.spawnChild(spawnInput(h.root));
		assert.deepEqual(await h.supervisor.waitSettled(CHILD, 500), { settled: true, abnormal: false, exitCode: 0 });
		assert.equal(h.supervisor.isAlive(CHILD), false);
		assert.equal(h.client.methods().includes("terminal.kill"), false);
	} finally {
		h.cleanup();
	}
});

// ── 4. the re-dispatch guard ─────────────────────────────────────────────

test("#460: an unreachable child still HOLDS its name — a second spawn is refused", async () => {
	const h = harness(() => {
		throw transportError();
	});
	try {
		await h.supervisor.spawnChild(spawnInput(h.root));
		await h.supervisor.waitSettled(CHILD, 5_000);
		assert.equal(h.supervisor.supervision(CHILD)?.state, "unreachable");
		await assert.rejects(
			() => h.supervisor.spawnChild(spawnInput(h.root)),
			(error: unknown) => {
				assert.ok(error instanceof SubagentError, `the refusal must carry a code: ${String(error)}`);
				assert.equal(error.code, ErrorCodes.NAME_TAKEN);
				// The refusal has to say WHY: the first child may be working over there,
				// which is exactly what the incident's re-dispatch got wrong.
				assert.match(error.message, /unreachable/);
				assert.match(error.message, /may still be running/);
				return true;
			},
		);
		assert.equal(h.client.paramsFor("terminal.run").length, 1, "no second terminal was created");
	} finally {
		h.cleanup();
	}
});

// ── 1e. the bound is the option's, and strikes really reset ──────────────

test("#460: `unreachableStrikeLimit` is the retry bound (a test seam that really moves it)", async () => {
	let childReads = 0;
	const h = harness(
		() => {
			childReads += 1;
			throw transportError();
		},
		{ unreachableStrikeLimit: 1 },
	);
	try {
		await h.supervisor.spawnChild(spawnInput(h.root));
		const settled = await h.supervisor.waitSettled(CHILD, 5_000);
		assert.equal(settled.reason, SUPERVISOR_UNREACHABLE_REASON);
		assert.equal(settled.unreachable?.strikes, 1);
		assert.equal(childReads, 1, "one failure is the whole budget here");
	} finally {
		h.cleanup();
	}
});

test("#460: `strikes` counts CONSECUTIVE failures — a successful read resets it", async () => {
	let childReads = 0;
	let strikesBeforeFifthRead: number | undefined;
	const h = harness(() => {
		childReads += 1;
		// fail, fail, OK (the channel comes back for one read but the turn is not
		// over), fail, fail, fail ⇒ the marker at read 5 must say ONE, not three.
		if (childReads === 3) return { state: "live", turn: 0, status: { state: "idle" } };
		if (childReads === 5) strikesBeforeFifthRead = h.supervisor.supervision(CHILD)?.unreachable?.strikes;
		throw transportError();
	});
	try {
		await h.supervisor.spawnChild(spawnInput(h.root));
		const settled = await h.supervisor.waitSettled(CHILD, 5_000);
		assert.equal(settled.reason, SUPERVISOR_UNREACHABLE_REASON);
		assert.equal(settled.unreachable?.strikes, UNREACHABLE_STRIKE_LIMIT);
		assert.equal(strikesBeforeFifthRead, 1, "the success at read 3 reset the counter");
		assert.equal(childReads, 6, "3 failures, one good read, then a fresh budget of 3");
	} finally {
		h.cleanup();
	}
});

test("#460: ANY failed read is `unreachable` (a plain Error too) — the conservative direction is deliberate", async () => {
	// The catch is a catch-all: a client that answers with something that is not even
	// an `HcRpcError` still tells this host NOTHING about the child. `not_found` is
	// the ONE lifecycle-shaped answer, and it is handled separately above. The failure
	// direction is chosen on purpose: a hole in the error vocabulary may hold a dead
	// child briefly alive, never declare a living child dead.
	const h = harness(() => {
		throw new Error("socket hang up");
	});
	try {
		await h.supervisor.spawnChild(spawnInput(h.root));
		const settled = await h.supervisor.waitSettled(CHILD, 5_000);
		assert.equal(settled.reason, SUPERVISOR_UNREACHABLE_REASON);
		assert.equal(settled.abnormal, false);
		assert.match(String(settled.unreachable?.detail), /socket hang up/);
	} finally {
		h.cleanup();
	}
});

// ── 5. collect: `running` + the supervision reason, never `failed` ───────

/**
 * Plays back ONE wait verdict — and the verdict is produced by the REAL
 * `TerminalSupervisor` in the test below, not hand-written here. Otherwise the
 * orchestrator half of #460 would be asserted against a shape the test itself
 * invented, and the `SettleResult.unreachable` seam would be unproven end to end.
 */
class FixedWaitSupervisor extends FakeSupervisor {
	/** strip-only TS rejects parameter properties, so the field is declared explicitly. */
	private readonly verdict: SettleResult;

	constructor(verdict: SettleResult) {
		super();
		this.verdict = verdict;
	}

	override async waitSettled(name: string, timeoutMs?: number): Promise<SettleResult> {
		this.calls.push({ method: "waitSettled", name, ...(timeoutMs !== undefined ? { timeoutMs } : {}) });
		return this.verdict;
	}
}

function collectAgent(): AgentConfig {
	return {
		name: "worker",
		description: "unreachable-collect test role",
		systemPromptMode: "append",
		inheritProjectContext: false,
		inheritSkills: false,
		kind: "pi",
		systemPrompt: "You are a test worker.",
		source: "user",
		filePath: "/fake/worker.md",
		worktree: false,
	};
}

test("#460: collect on an unreachable child reports `running` + the supervision reason — never `failed`", async (t) => {
	const root = mkdtempSync(path.join(tmpdir(), "supervision-collect-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));

	// The verdict the ORCHESTRATOR will classify is the one the real terminal
	// backend produces for a dead channel (`UnreachableWaitSupervisor` is not a
	// hand-built literal): the seam under test is exactly that object.
	const backend = harness(() => {
		throw transportError();
	});
	let verdict: SettleResult;
	try {
		await backend.supervisor.spawnChild(spawnInput(backend.root));
		verdict = await backend.supervisor.waitSettled(CHILD, 5_000);
	} finally {
		backend.cleanup();
	}
	assert.equal(verdict.abnormal, false, "precondition: the backend calls this a channel outage, not a death");
	assert.notEqual(verdict.unreachable, undefined);

	const supervisor = new FixedWaitSupervisor(verdict);
	const orchestrator = new Orchestrator({ supervisor, runDir: path.join(root, "run"), cwd: root });
	const handle = await orchestrator.launch({ agent: collectAgent(), task: "t" });

	const collected = await orchestrator.collect(handle.name);
	assert.equal(collected.execution.status, "running", "a blind supervisor is not a verdict about the work");
	assert.equal(collected.execution.reason, SUPERVISION_UNREACHABLE_REASON);
	// The reason is the discriminator: the ordinary `timeout` path also answers
	// `running`, so this must NOT be its sentence.
	assert.notEqual(collected.execution.reason, COLLECT_DEADLINE_REASON);
	assert.match(SUPERVISION_UNREACHABLE_REASON, /supervision unreachable/);
	assert.match(SUPERVISION_UNREACHABLE_REASON, /STILL be running/);
	// `running` is the load-bearing word: it is what makes the watch re-arm and what
	// keeps `shouldRecycleAfterCollect` from retiring (killing) a child this host
	// merely cannot see. (`collect` itself never retires anything — the recycle
	// predicate below is the real carrier, so assert THAT, not a call count.)
	assert.equal(shouldRecycleAfterCollect(collected.execution.status), false, "an unreachable child is not recycled");
	assert.equal(shouldRecycleAfterCollect("failed"), true, "the same predicate would recycle a real failure");
	assert.equal(supervisor.isAlive(handle.name), true);
});

test("#460 control: a child that really exited still gets a terminal verdict (not `running`)", async (t) => {
	const root = mkdtempSync(path.join(tmpdir(), "supervision-collect-gone-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const supervisor = new FakeSupervisor();
	const orchestrator = new Orchestrator({ supervisor, runDir: path.join(root, "run"), cwd: root });
	const handle = await orchestrator.launch({ agent: collectAgent(), task: "t" });
	// The process is gone (`abnormal: true`, `isAlive === false`): the pre-#460 path
	// for a death, which must keep its terminal verdict.
	supervisor.exit(handle.name, "child process exited");

	const collected = await orchestrator.collect(handle.name);
	assert.equal(collected.execution.status, "aborted", "a real death is still a verdict, unchanged");
	// The pre-#460 verdict for a death: a terminal `aborted`, not `running`.
	assert.match(String(collected.execution.reason), /no assistant message for the last prompt/);
	assert.notEqual(collected.execution.reason, SUPERVISION_UNREACHABLE_REASON);
	assert.equal(shouldRecycleAfterCollect(collected.execution.status), true, "a dead child may be recycled");
});
