/**
 * Orchestrator-level launch admission (issue #266, contract
 * `launch-admission-queue-v1` §4.3).
 *
 * The gate that matters most is A21: eight launches in one tick must all reach
 * the supervisor's `spawns`, and the ninth must be **queued**. Without the
 * in-flight reservation (D2-b) every one of the nine probes would read 0 live
 * children — the child only lands in the supervisor's registry after the first
 * `await` inside `spawnChild` — and all nine would be admitted, so the last one
 * would hit the real gate and throw `maxChildrenPerNode reached`. That is
 * exactly the bug #266 exists to fix.
 *
 * The in-process path is exercised against a REAL `InProcessSupervisor` (its
 * counts, its gate messages and its limits are the ones production uses); only
 * the SDK session factory is faked, so no model is ever contacted.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { Orchestrator } from "../../src/runs/orchestrator.ts";
import { InProcessSupervisor, type InProcessSession } from "../../src/supervisor/inprocess-supervisor.ts";
import { RoutingSupervisor } from "../../src/supervisor/routing-supervisor.ts";
import { resetAdmissionQueuesForTests } from "../../src/supervisor/admission-queue.ts";
import { RunStore } from "../../src/runs/store.ts";
import { openLegionDb } from "../../src/legion/db.ts";
import { insertNode } from "../../src/legion/nodes.ts";
import { createLegionEventBus } from "../../src/extension/event-bus.ts";
import { inProcessDepth, runAtAbsoluteDepth } from "../../src/supervisor/inprocess-depth.ts";
import { runInChildContext, type ChildLaunchContext } from "../../src/supervisor/child-context.ts";
import { getNode } from "../../src/legion/nodes.ts";
import { ErrorCodes, SubagentError, type AgentConfig, type ChildRecord } from "../../src/shared/types.ts";

// ── Fixtures ───────────────────────────────────────────────────────────────

function agent(overrides: Partial<AgentConfig> = {}): AgentConfig {
	return {
		name: "worker",
		description: "admission test role",
		systemPromptMode: "append",
		inheritProjectContext: true,
		inheritSkills: false,
		kind: "pi",
		systemPrompt: "You are the worker.",
		source: "user",
		filePath: "/fake/worker.md",
		...overrides,
	};
}

/**
 * Minimal in-process session: records the prompt and appends the user line to
 * the transcript so `firstTurnAccepted` sees an accepted turn (no model).
 */
class SyncSession implements InProcessSession {
	private readonly listeners = new Set<(event: unknown) => void>();
	private readonly sessionFile: string;
	readonly prompts: string[] = [];

	constructor(sessionFile: string) {
		this.sessionFile = sessionFile;
	}

	subscribe(listener: (event: unknown) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	async prompt(text: string): Promise<void> {
		this.prompts.push(text);
		fs.appendFileSync(
			this.sessionFile,
			`${JSON.stringify({ type: "message", message: { role: "user", content: text } })}\n`,
		);
		for (const listener of [...this.listeners]) listener({ type: "agent_start" });
	}

	dispose(): void {}
}

interface Harness {
	runDir: string;
	orchestrator: Orchestrator;
	/** The real in-process backend the probe reads. */
	inprocess: InProcessSupervisor;
	/** Names the backend actually spawned. */
	spawned(): string[];
	notices: string[];
	/** Records handed to `onChildUpdate`, newest last. */
	updates: ChildRecord[];
	cleanup(): void;
}

function harness(
	options: {
		limits?: { maxActive?: number; maxChildrenPerNode?: number; maxDepth?: number };
		launchQueue?: { maxPending?: number; timeoutMs?: number };
	} = {},
): Harness {
	// The queue registry is keyed by `${pid}:${runDir}`, and every harness uses a
	// fresh runDir, so suites cannot pollute each other (A17). Clearing anyway
	// keeps a leftover queue from a previous file out of the picture.
	resetAdmissionQueuesForTests();
	const root = fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "legion-admission-"));
	const runDir = path.join(root, "run");
	fs.mkdirSync(runDir, { recursive: true });
	const spawnedNames: string[] = [];
	const notices: string[] = [];
	const updates: ChildRecord[] = [];
	const inprocess = new InProcessSupervisor({
		limits: { maxActive: 30, maxChildrenPerNode: 8, ...(options.limits ?? {}) },
		sessionFactory: async (input) => {
			spawnedNames.push(input.name);
			return new SyncSession(input.sessionFile);
		},
	});
	const supervisor = new RoutingSupervisor({ inprocess });
	const orchestrator = new Orchestrator({
		supervisor,
		runDir,
		cwd: runDir,
		maxDepth: 4,
		...(options.launchQueue ? { launchQueue: options.launchQueue } : {}),
		onChildUpdate: (child) => updates.push({ ...child }),
		onLaunchQueueNotice: (line) => notices.push(line),
	});
	return {
		runDir,
		orchestrator,
		inprocess,
		spawned: () => [...spawnedNames],
		notices,
		updates,
		cleanup() {
			// D7/R10: a live queue holds closures over this orchestrator. Failing to
			// flush would leave an unref'd timer pumping a torn-down harness.
			orchestrator.flushLaunchQueue("test cleanup");
			resetAdmissionQueuesForTests();
			fs.rmSync(root, { recursive: true, force: true });
		},
	};
}

/**
 * Await `work`, but fail loudly if it never settles.
 *
 * Several admission defects had the same symptom: a promise that simply never
 * resolves (an unsettled guard, a bare await on a queue wait). `assert.rejects`
 * would turn that into a suite hang rather than a failing case, and node's own
 * "unsettled top-level await" only surfaces after the whole file's timeout. This
 * turns a non-settling promise into an immediate, legible verdict.
 */
async function settleWithin(
	work: Promise<unknown>,
	timeoutMs: number,
): Promise<{ kind: "resolved" } | { kind: "rejected"; error: unknown } | { kind: "hang" }> {
	const settled = work.then(
		() => ({ kind: "resolved" as const }),
		(error: unknown) => ({ kind: "rejected" as const, error }),
	);
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			settled,
			new Promise<{ kind: "hang" }>((resolve) => {
				timer = setTimeout(() => resolve({ kind: "hang" }), timeoutMs);
				timer.unref?.();
			}),
		]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

// ── A21 (D2-b): the in-flight reservation is what makes same-tick fanout work ──

test("A21: eight same-tick launches all spawn, the ninth is queued (D2-b in-flight reservation)", async () => {
	const h = harness({ limits: { maxChildrenPerNode: 8 } });
	try {
		// `Promise.all` starts all nine before any of them awaits: this is the exact
		// shape of the 12-step fanout in issue #266.
		const handles = await Promise.all(
			Array.from({ length: 9 }, (_value, index) =>
				h.orchestrator.launch({ agent: agent(), task: `step-${index}`, name: `worker-${index}`, worktree: false })),
		);
		const spawnedNow = handles.slice(0, 8);
		const ninth = handles[8]!;
		// The eight admitted launches really spawned...
		assert.equal(h.spawned().length, 8, `expected 8 spawns, saw ${h.spawned().length}: ${h.spawned().join(",")}`);
		assert.deepEqual(h.spawned().sort(), spawnedNow.map((handle) => handle.name).sort());
		assert.ok(spawnedNow.every((handle) => handle.queued !== true), "the first eight are not queued");
		// ...and the ninth waited instead of throwing `maxChildrenPerNode reached`.
		assert.equal(ninth.queued, true, "the ninth launch must be queued, not refused");
		assert.equal(ninth.child.state, "queued");
		assert.equal(ninth.sessionFile, path.join(h.runDir, "worker-8.jsonl"));
		assert.equal(h.orchestrator.launchQueueEntries().length, 1);
		assert.equal(h.orchestrator.launchQueueEntries()[0]?.name, "worker-8");
	} finally {
		h.cleanup();
	}
});

test("A21: the fast path enqueues nothing and gains no queue entry (D2-b)", async () => {
	const h = harness({ limits: { maxChildrenPerNode: 8 } });
	try {
		const handle = await h.orchestrator.launch({ agent: agent(), task: "single", name: "worker-0", worktree: false });
		assert.ok(handle.queued !== true, "a launch with a free slot must not queue");
		assert.equal(h.orchestrator.launchQueueEntries().length, 0, "the queue stays untouched");
		assert.equal(h.spawned().join(","), "worker-0");
	} finally {
		h.cleanup();
	}
});

// ── A15: placeholder session file, real one after admission ────────────────

test("A15: a queued record points at a placeholder sessionFile that does not exist", async () => {
	const h = harness({ limits: { maxChildrenPerNode: 1 } });
	try {
		await h.orchestrator.launch({ agent: agent(), task: "first", name: "worker-0", worktree: false });
		const queued = await h.orchestrator.launch({ agent: agent(), task: "second", name: "worker-1", worktree: false });
		assert.equal(queued.child.state, "queued");
		assert.equal(queued.child.sessionFile, path.join(h.runDir, "worker-1.jsonl"));
		assert.equal(fs.existsSync(queued.child.sessionFile), false, "the placeholder is a path, never a file");
		assert.equal(queued.child.execution, undefined);
	} finally {
		h.cleanup();
	}
});

// ── A4: stop a queued item ────────────────────────────────────────────────

test("A4: stop dequeues a queued launch without spawning it", async () => {
	const h = harness({ limits: { maxChildrenPerNode: 1 } });
	try {
		await h.orchestrator.launch({ agent: agent(), task: "first", name: "worker-0", worktree: false });
		const queued = await h.orchestrator.launch({ agent: agent(), task: "second", name: "worker-1", worktree: false });
		assert.equal(queued.queued, true);
		const retired = await h.orchestrator.retire("worker-1");
		assert.equal(retired.state, "retired");
		assert.ok(retired.retiredAt, "a stopped queued item is stamped retired");
		assert.equal(h.orchestrator.launchQueueEntries().length, 0, "the queue shrank");
		assert.deepEqual(h.spawned(), ["worker-0"], "the stopped item never spawned");
		assert.ok(
			h.notices.some((line) => line.includes("launch queue stopped")),
			`expected a stop notice, saw: ${JSON.stringify(h.notices)}`,
		);
	} finally {
		h.cleanup();
	}
});

// ── A5: abort flush ───────────────────────────────────────────────────────

test("A5: flushLaunchQueue empties every queued item and spawns nothing", async () => {
	const h = harness({ limits: { maxChildrenPerNode: 1 } });
	try {
		await h.orchestrator.launch({ agent: agent(), task: "first", name: "worker-0", worktree: false });
		const queued = await Promise.all(
			Array.from({ length: 5 }, (_value, index) =>
				h.orchestrator.launch({ agent: agent(), task: `q-${index}`, name: `worker-${index + 1}`, worktree: false })),
		);
		assert.ok(queued.every((handle) => handle.queued === true), "all five wait");
		const flushed = h.orchestrator.flushLaunchQueue("parent turn ended");
		assert.deepEqual(flushed, ["worker-1", "worker-2", "worker-3", "worker-4", "worker-5"], "seq order");
		assert.equal(h.orchestrator.launchQueueEntries().length, 0, "the queue is empty");
		assert.deepEqual(h.spawned(), ["worker-0"], "flush spawns nothing");
		for (const name of flushed) {
			const child = h.orchestrator.childrenSnapshot().find((entry) => entry.name === name);
			assert.equal(child?.state, "retired", `${name} is retired`);
		}
	} finally {
		h.cleanup();
	}
});

// ── A12: collect blocks on a queued name instead of reading a ghost session ──

test("A12: collect on a queued child waits for admission and then collects the real result", async () => {
	const h = harness({ limits: { maxChildrenPerNode: 1 } });
	try {
		await h.orchestrator.launch({ agent: agent(), task: "first", name: "worker-0", worktree: false });
		const queued = await h.orchestrator.launch({ agent: agent(), task: "second", name: "worker-1", worktree: false });
		assert.equal(queued.queued, true);
		// `collect` must not resolve while the item is still queued, and must not
		// parse the placeholder file.
		let resolved = false;
		const pending = h.orchestrator.collect("worker-1", { timeoutMs: 2_000 }).then((result) => {
			resolved = true;
			return result;
		});
		await new Promise((resolve) => setTimeout(resolve, 20));
		assert.equal(resolved, false, "collect must block until the child is admitted");
		// Freeing the slot lets the queued item start; then give it a turn to settle.
		await h.orchestrator.retire("worker-0");
		await new Promise((resolve) => setTimeout(resolve, 120));
		const session = path.join(h.runDir, "worker-1.jsonl");
		if (fs.existsSync(session)) {
			fs.appendFileSync(session, `${JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: '{"ok":true}' }], stopReason: "stop" } })}\n`);
		}
		// A spawned-but-unsettled child stays `running` until its turn ends; the point
		// of A12 is that the wait ended on the REAL session, not on the placeholder.
		const result = await pending;
		assert.equal(resolved, true);
		assert.notEqual(result.execution.status, "aborted", "the placeholder must never be read as an empty session");
	} finally {
		h.cleanup();
	}
});

test("A12: collect on a stopped queued child rejects with the queue message", async () => {
	const h = harness({ limits: { maxChildrenPerNode: 1 } });
	try {
		await h.orchestrator.launch({ agent: agent(), task: "first", name: "worker-0", worktree: false });
		await h.orchestrator.launch({ agent: agent(), task: "second", name: "worker-1", worktree: false });
		const pending = h.orchestrator.collect("worker-1", { timeoutMs: 5_000 });
		pending.catch(() => {});
		await h.orchestrator.retire("worker-1");
		await assert.rejects(
			() => pending,
			(error: unknown) => error instanceof SubagentError && error.code === ErrorCodes.BUDGET_EXCEEDED,
		);
	} finally {
		h.cleanup();
	}
});

// ── A9: `maxChildrenPerNode: 0` is a hard refusal, never a queue entry ─────

test("A9: maxChildrenPerNode 0 refuses immediately and enqueues nothing", async () => {
	const h = harness({ limits: { maxChildrenPerNode: 0 } });
	try {
		await assert.rejects(
			() => h.orchestrator.launch({ agent: agent(), task: "never", name: "worker-0", worktree: false }),
			(error: unknown) =>
				error instanceof SubagentError &&
				error.code === ErrorCodes.BUDGET_EXCEEDED &&
				error.message === "inprocess maxChildrenPerNode reached for '<root>' (0/0)",
		);
		assert.equal(h.orchestrator.launchQueueEntries().length, 0, "a disabled cap never queues");
		assert.deepEqual(h.spawned(), []);
	} finally {
		h.cleanup();
	}
});

// ── A23 (I-O3): an orphaned `queued` record from a previous process ────────

test("A23: an orphaned queued record reports the lost-queue message and can be retired", async () => {
	const h = harness();
	try {
		// Simulate a run.json written by a previous process: `state: "queued"`, a
		// placeholder session path, and no queue entry in this process.
		h.orchestrator.restore({
			schemaVersion: 1,
			runId: "previous-run",
			task: "root",
			cwd: h.runDir,
			herdr: { supervisor: "inprocess" },
			path: [{ runId: "previous-run" }],
			depth: 0,
			maxDepth: 4,
			budget: { spawned: 0, limit: null, granted: 0 },
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
			children: [
				{
					name: "ghost-0",
					sessionFile: path.join(h.runDir, "ghost-0.jsonl"),
					ownerToken: "owner-ghost",
					state: "queued",
					spawnedAt: new Date().toISOString(),
					agent: "worker",
					kind: "pi",
				},
			],
		});
		const expected =
			"child 'ghost-0' never started: the launch queue was lost when the previous process exited; re-dispatch it (or relaunch) instead";
		await assert.rejects(
			() => h.orchestrator.steer("ghost-0", "hello"),
			(error: unknown) => error instanceof SubagentError && error.message === expected,
		);
		await assert.rejects(
			() => h.orchestrator.collect("ghost-0", { timeoutMs: 100 }),
			(error: unknown) => error instanceof SubagentError && error.message === expected,
		);
		// `retire` is the documented cleanup path and must succeed.
		const retired = await h.orchestrator.retire("ghost-0");
		assert.equal(retired.state, "retired");
		assert.ok(retired.retiredAt);
		assert.deepEqual(h.spawned(), [], "no orphan is ever spawned");
	} finally {
		h.cleanup();
	}
});

// ── A21 (production shape): the window only exists when launch() awaits ────
//
// The A21 case above runs WITHOUT a legion context, and that makes it blind to
// the very bug it documents. Evidence (measured, not assumed): without `legion`,
// `launch()` reaches `await this.supervisor.spawnChild(...)` with no prior await,
// and `spawnChild` registers the child in `this.children` synchronously before
// its own first await — so launch #1 already raised `siblings` to 1 before #2
// probes. The in-flight reservation is never consulted, and deleting it leaves
// the case green.
//
// The real window is the legion path: `reserveNode` (sync, ledger only) then
// `await persistParentReservation(...)` sit BETWEEN the probe and `spawnChild`,
// while the in-process fanout gate reads the supervisor's in-memory set — still
// empty for every one of the nine. That is the shape that produced the user's
// `inprocess maxChildrenPerNode reached for '<root>' (8/8)`, so it is the one
// that must be guarded. This case fails when `inflightFor` is neutered.

test("A21 (legion shape): the reservation is what queues the ninth, not luck", async () => {
	resetAdmissionQueuesForTests();
	const root = fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "legion-admission-ledger-"));
	const runStore = new RunStore({ rootDir: path.join(root, ".pi-subagents") });
	const rootRun = runStore.createRun({ task: "root", cwd: root, nodeId: "root", maxDepth: 4, herdr: { supervisor: "rpc" } });
	const db = openLegionDb(":memory:");
	insertNode(db, { id: "root", parentId: null, name: "root", role: "root", runId: rootRun.runId, status: "running" });
	const spawned: string[] = [];
	const inprocess = new InProcessSupervisor({
		limits: { maxActive: 30, maxChildrenPerNode: 8 },
		sessionFactory: async (input) => {
			spawned.push(input.name);
			return new SyncSession(input.sessionFile);
		},
	});
	const runDir = runStore.runDir(rootRun.runId);
	const orchestrator = new Orchestrator({
		supervisor: new RoutingSupervisor({ inprocess }),
		runDir,
		cwd: root,
		maxDepth: 4,
		legion: {
			db,
			dbPath: path.join(runDir, "legion.db"),
			nodeId: "root",
			parentNodeId: null,
			parentRunId: null,
			runId: rootRun.runId,
			runStore,
			settings: { maxDepth: 4, maxChildrenPerNode: 8, maxActiveNodes: 30 },
			eventBus: createLegionEventBus(),
		},
	});
	try {
		const handles = await Promise.all(
			Array.from({ length: 9 }, (_value, index) =>
				orchestrator.launch({ agent: agent(), task: `step-${index}`, name: `worker-${index}`, worktree: false })),
		);
		assert.equal(spawned.length, 8, `expected 8 spawns, saw ${spawned.length}: ${spawned.join(",")}`);
		const ninth = handles[8]!;
		assert.equal(ninth.queued, true, "without the reservation all nine admit and the ninth throws maxChildrenPerNode");
		assert.equal(ninth.child.state, "queued");
		assert.ok(handles.slice(0, 8).every((handle) => handle.queued !== true));
	} finally {
		orchestrator.flushLaunchQueue("test cleanup");
		resetAdmissionQueuesForTests();
		db.close();
		fs.rmSync(root, { recursive: true, force: true });
	}
});

// ── A3: a timed-out queued item leaves NOTHING behind ─────────────────────
//
// The contract's zero-residue rule (§8 A3): after `launchQueueTimeoutMs` the
// record is `retired`, and there is no ledger row, no child run directory, no
// session file and no worktree. This is the assertion that keeps a queue entry
// from quietly becoming a half-created child — the failure mode `reserveNode`
// would cause if it ran at enqueue time (R3/F10).
//
// The whole timeout path was previously untested: `launchQueue` was declared in
// the harness but no case ever passed it, so `abandonQueued(..., "timeout")` had
// zero coverage.

test("A3: a timed-out queued launch retires with no ledger row, no session file, no run dir", async () => {
	resetAdmissionQueuesForTests();
	const root = fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "legion-admission-timeout-"));
	const runStore = new RunStore({ rootDir: path.join(root, ".pi-subagents") });
	const rootRun = runStore.createRun({ task: "root", cwd: root, nodeId: "root", maxDepth: 4, herdr: { supervisor: "rpc" } });
	const db = openLegionDb(":memory:");
	insertNode(db, { id: "root", parentId: null, name: "root", role: "root", runId: rootRun.runId, status: "running" });
	const spawned: string[] = [];
	const inprocess = new InProcessSupervisor({
		limits: { maxActive: 30, maxChildrenPerNode: 1 },
		sessionFactory: async (input) => {
			spawned.push(input.name);
			return new SyncSession(input.sessionFile);
		},
	});
	const runDir = runStore.runDir(rootRun.runId);
	// A controllable clock: only the queue's deadline is advanced, so the test
	// never waits a real 15 minutes.
	let clock = 1_000_000;
	const notices: string[] = [];
	const orchestrator = new Orchestrator({
		supervisor: new RoutingSupervisor({ inprocess }),
		runDir,
		cwd: root,
		maxDepth: 4,
		now: () => clock,
		launchQueue: { timeoutMs: 1_000, maxPending: 8 },
		onLaunchQueueNotice: (line) => notices.push(line),
		legion: {
			db,
			dbPath: path.join(runDir, "legion.db"),
			nodeId: "root",
			parentNodeId: null,
			parentRunId: null,
			runId: rootRun.runId,
			runStore,
			settings: { maxDepth: 4, maxChildrenPerNode: 1, maxActiveNodes: 30 },
			eventBus: createLegionEventBus(),
		},
	});
	try {
		const first = await orchestrator.launch({ agent: agent(), task: "holder", name: "worker-0", worktree: false });
		assert.equal(getNode(db, first.child.nodeId!)?.status, "running", "the slot holder is really live");
		const queued = await orchestrator.launch({ agent: agent(), task: "waits", name: "worker-1", worktree: false });
		assert.equal(queued.queued, true);
		const childRunCountBefore = runStore.listRuns().length;
		const nodesBefore = db.prepare("SELECT id FROM nodes ORDER BY id").all().map((row) => row.id as string);

		// Cross the deadline, then let the pump's own decision run (no test-side retire).
		clock += 2_000;
		// The fallback watchdog is a REAL timer armed at enqueue time
		// (`min(expiry, now + LAUNCH_QUEUE_RECHECK_MS)` = 1000 ms here); jumping the
		// injected clock does not shorten it, so wait one recheck window.
		await new Promise((resolve) => setTimeout(resolve, 1_200));

		assert.equal(orchestrator.launchQueueEntries().length, 0, "the item left the queue");
		const retired = orchestrator.childrenSnapshot().find((child) => child.name === "worker-1");
		assert.equal(retired?.state, "retired", "a timed-out launch is retired, not failed");
		assert.ok(retired?.retiredAt, "and carries the stamp");
		assert.ok(
			notices.some((line) => line.includes("launch queue timed out after")),
			`expected the timeout notice, saw: ${JSON.stringify(notices)}`,
		);
		// Zero residue, item by item.
		assert.equal(getNode(db, queued.child.nodeId!), null, "no ledger row was ever written");
		assert.deepEqual(
			db.prepare("SELECT id FROM nodes ORDER BY id").all().map((row) => row.id as string),
			nodesBefore,
			"the ledger is byte-identical to before the queued launch",
		);
		assert.equal(runStore.listRuns().length, childRunCountBefore, "no child run directory was created");
		assert.equal(fs.existsSync(path.join(runDir, "worker-1.jsonl")), false, "no session file was created");
		assert.equal(spawned.includes("worker-1"), false, "and nothing was spawned");
	} finally {
		orchestrator.flushLaunchQueue("test cleanup");
		resetAdmissionQueuesForTests();
		db.close();
		fs.rmSync(root, { recursive: true, force: true });
	}
});

// ── A18: admission replays the ALS depth/identity captured at enqueue ──────
//
// A queued launch can be admitted much later, from a different call chain (a
// slot-release broadcast, the fallback timer). If the replay ran at the ROOT's
// depth instead of the enqueue-time depth, a grandchild would be recorded at
// depth 1 and `maxDepth` could never fire — the same class of bug the
// in-process supervisor already fixed for turn 2+ (`runAtAbsoluteDepth`).

test("A18: an admitted launch keeps the depth and child context it was created in", async () => {
	resetAdmissionQueuesForTests();
	const root = fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "legion-admission-depth-"));
	const runDir = path.join(root, "run");
	fs.mkdirSync(runDir, { recursive: true });
	const spawnDepths: number[] = [];
	const inprocess = new InProcessSupervisor({
		limits: { maxActive: 30, maxChildrenPerNode: 1 },
		sessionFactory: async (input) => {
			// Recorded INSIDE the factory, i.e. at the depth the spawn really runs at.
			spawnDepths.push(inProcessDepth());
			return new SyncSession(input.sessionFile);
		},
	});
	const orchestrator = new Orchestrator({
		supervisor: new RoutingSupervisor({ inprocess }),
		runDir,
		cwd: runDir,
		maxDepth: 8,
	});
	try {
		// Hold the only slot, then enqueue from depth 2 (as a grandchild would).
		const holder = await orchestrator.launch({ agent: agent(), task: "holder", name: "worker-0", worktree: false });
		assert.ok(holder.name);
		const parentContext: ChildLaunchContext = {
			nodeId: "root.branch",
			allowNested: true,
			utility: false,
			spawnMode: "inprocess",
		};
		// Same parentKey as the holder (`""`, both are root-level names) so the
		// fanout gate is genuinely full; only the ALS scope differs.
		const queuedHandle = await runAtAbsoluteDepth(2, () =>
			runInChildContext(parentContext, () =>
				orchestrator.launch({ agent: agent(), task: "deep", name: "worker-1", worktree: false })));
		assert.equal(queuedHandle.queued, true, "enqueued from the nested scope");
		assert.equal(queuedHandle.child.name, "worker-1");

		// Admission happens later, from the root chain (this await releases the slot).
		await orchestrator.retire("worker-0");
		await new Promise((resolve) => setTimeout(resolve, 120));

		// Depth is the observable the bug class actually breaks: admitted from the
		// root chain, an unreplayed launch would spawn at depth 1 and `maxDepth`
		// could never fire. (`currentChildContext()` inside the factory is NOT a
		// valid probe here: the in-process supervisor deliberately REPLACES the
		// ambient context with the child's own identity via
		// `resolveChildLaunchContext`, so it never echoes the enqueue-time scope.)
		// `spawnDepths[0]` is the holder (launched from the root chain, depth 1);
		// the last entry is the admitted child, enqueued from absolute depth 2.
		assert.equal(
			spawnDepths.at(-1),
			3,
			`the admitted child must spawn at depth 3, saw ${JSON.stringify(spawnDepths)}`,
		);
	} finally {
		orchestrator.flushLaunchQueue("test cleanup");
		resetAdmissionQueuesForTests();
		fs.rmSync(root, { recursive: true, force: true });
	}
});

// ── A22 (D2-c): a replayed launch that loses the real gate re-queues ──────
//
// I-O1 makes `probeAdmission` consultative; `assertWithinLimits` stays the
// authority. D2-c is the narrow case where the replay of an ALREADY-WAITING item
// loses that authority: another launch took the slot between the probe and the
// gate, so the re-probe can attribute the refusal to a queueable gate. The
// contract then requires: back into the queue, deadline preserved (never
// restarted, so a stuck item still times out), caller never sees a failure, and
// no immediate re-pump (that would busy-loop while probe and gate disagree).
//
// The mismatch is staged the contract's way — the gate refuses WHILE the probe
// also reports the slot as taken — not by making the gate refuse arbitrarily.

test("A22: a replayed launch refused by the real gate is re-queued, not failed", async () => {
	resetAdmissionQueuesForTests();
	const root = fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "legion-admission-requeue-"));
	const runDir = path.join(root, "run");
	fs.mkdirSync(runDir, { recursive: true });
	const spawned: string[] = [];
	/** Staged disagreement: the probe reports the fanout slot as taken. */
	let slotTakenByOther = false;
	/** The authoritative gate refuses exactly one replay. */
	let replayRefusals = 0;
	const inprocess = new InProcessSupervisor({
		limits: { maxActive: 30, maxChildrenPerNode: 1 },
		sessionFactory: async (input) => {
			spawned.push(input.name);
			return new SyncSession(input.sessionFile);
		},
	});
	const realCounts = inprocess.admissionCounts.bind(inprocess);
	inprocess.admissionCounts = (name: string) => {
		const snapshot = realCounts(name);
		return slotTakenByOther ? { ...snapshot, siblings: 1 } : snapshot;
	};
	const realSpawn = inprocess.spawnChild.bind(inprocess);
	inprocess.spawnChild = async (input) => {
		if (input.name === "worker-alu" && replayRefusals < 1) {
			replayRefusals += 1;
			// The other launch claims the slot in the tiny window between this
			// replay's probe and the authoritative gate — the D2-c disagreement.
			slotTakenByOther = true;
			throw new SubagentError(
				"inprocess maxChildrenPerNode reached for '<root>' (1/1)",
				ErrorCodes.BUDGET_EXCEEDED,
			);
		}
		return realSpawn(input);
	};
	const notices: string[] = [];
	const orchestrator = new Orchestrator({
		supervisor: new RoutingSupervisor({ inprocess }),
		runDir,
		cwd: runDir,
		maxDepth: 4,
		onLaunchQueueNotice: (line) => notices.push(line),
	});
	try {
		const holder = await orchestrator.launch({ agent: agent(), task: "holder", name: "worker-0", worktree: false });
		assert.ok(holder.name);
		const queued = await orchestrator.launch({ agent: agent(), task: "retry", name: "worker-alu", worktree: false });
		assert.equal(queued.queued, true, "over-cap launch queues first");
		const waitedBefore = orchestrator.launchQueueEntries()[0]!.waitedMs;

		// Free the real slot: the pump replays it; the replay's own spawn claims the
		// slot and is refused by the gate, so the catch's re-probe can attribute it.
		await orchestrator.retire("worker-0");
		await new Promise((resolve) => setTimeout(resolve, 150));
		assert.equal(replayRefusals, 1, "the replay hit the authoritative gate");
		assert.equal(spawned.includes("worker-alu"), false, "the refused replay spawned nothing");
		const entries = orchestrator.launchQueueEntries();
		assert.equal(entries.length, 1, "D2-c: the item went BACK into the queue");
		assert.equal(entries[0]!.name, "worker-alu");
		// W1's `AdmissionQueue` assigns `seq` itself, so a re-queue lands at the back.
		// What protects the caller is the DEADLINE: it keeps counting instead of
		// restarting, so a launch that keeps losing the gate still times out.
		assert.ok(
			entries[0]!.waitedMs >= waitedBefore,
			"its deadline is not reset (wait keeps counting, so a stuck item still times out)",
		);
		assert.equal(
			notices.some((line) => line.includes("✗")),
			false,
			"the caller never saw a failure line for this launch",
		);

		// The disagreement clears; the fallback recheck admits it on the next pass.
		slotTakenByOther = false;
		await new Promise((resolve) => setTimeout(resolve, 1_300));
		assert.equal(spawned.includes("worker-alu"), true, "the re-queued launch eventually runs");
		assert.equal(orchestrator.launchQueueEntries().length, 0, "and leaves the queue");
	} finally {
		orchestrator.flushLaunchQueue("test cleanup");
		resetAdmissionQueuesForTests();
		fs.rmSync(root, { recursive: true, force: true });
	}
});

// ── A10 (orchestrator layer): overflow refuses, and leaves no ghost record ──
//
// The queue's own overflow return is covered in
// `test/unit/admission-queue.test.ts`; what is NOT covered there is the
// orchestrator's obligation around it (D6): the refusal must not leave a half-
// built `ChildRecord` in `this.children`, or `status` would report a child that
// can never run and a later `launch` with the same name would look taken.

test("A10: launch-queue overflow is a hard refusal that leaves no ghost child", async () => {
	const h = harness({ limits: { maxChildrenPerNode: 1 }, launchQueue: { maxPending: 1 } });
	try {
		await h.orchestrator.launch({ agent: agent(), task: "holder", name: "worker-0", worktree: false });
		const queued = await h.orchestrator.launch({ agent: agent(), task: "fits", name: "worker-1", worktree: false });
		assert.equal(queued.queued, true, "the queue holds one item");
		await assert.rejects(
			() => h.orchestrator.launch({ agent: agent(), task: "overflow", name: "worker-2", worktree: false }),
			(error: unknown) =>
				error instanceof SubagentError &&
				error.code === ErrorCodes.BUDGET_EXCEEDED &&
				/launch queue overflow \(1\/1\)/.test(error.message),
			"overflow refuses immediately (D6), it does not wait",
		);
		assert.equal(h.orchestrator.launchQueueEntries().length, 1, "the queue did not grow");
		assert.equal(
			h.orchestrator.childrenSnapshot().some((child) => child.name === "worker-2"),
			false,
			"the refused launch left no ghost record behind",
		);
		assert.equal(h.spawned().includes("worker-2"), false, "and nothing spawned");
	} finally {
		h.cleanup();
	}
});

// ── Review round: the multi-instance shapes `index.ts` really runs ────────
//
// Every earlier case here uses ONE Orchestrator, which is not how production
// works: `index.ts` has five `new Orchestrator` sites over the same run dir (a
// launch family, a resume path, a vexillatio family, and the stop/collect/steer
// control adapters, which `restore()` child records but hold no launch payloads).
// The queue is process-level, so those instances share it — and four real defects
// lived only in that shape. Each case below failed before its fix.

/** A session that accepts the prompt, or explodes on demand (`boom`). */
class MaybeBoomSession implements InProcessSession {
	private readonly listeners = new Set<(event: unknown) => void>();
	// Explicit fields, not constructor parameter properties: the suite runs under
	// `node --experimental-strip-types`, which cannot strip those.
	private readonly file: string;
	private readonly boom: boolean;
	constructor(file: string, boom: boolean) {
		this.file = file;
		this.boom = boom;
	}
	subscribe(listener: (event: unknown) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}
	async prompt(text: string): Promise<void> {
		if (this.boom) throw new Error("session factory exploded");
		fs.appendFileSync(
			this.file,
			`${JSON.stringify({ type: "message", message: { role: "user", content: text } })}\n`,
		);
	}
	dispose(): void {}
}

function multiInstanceHarness(boomName?: string) {
	resetAdmissionQueuesForTests();
	const root = fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "legion-admission-multi-"));
	const runStore = new RunStore({ rootDir: path.join(root, ".pi-subagents") });
	const rootRun = runStore.createRun({ task: "root", cwd: root, nodeId: "root", maxDepth: 4, herdr: { supervisor: "rpc" } });
	const runDir = runStore.runDir(rootRun.runId);
	const spawned: string[] = [];
	const inprocess = new InProcessSupervisor({
		limits: { maxActive: 30, maxChildrenPerNode: 1 },
		sessionFactory: async (input) => {
			spawned.push(input.name);
			return new MaybeBoomSession(input.sessionFile, input.name === boomName);
		},
	});
	const supervisor = new RoutingSupervisor({ inprocess });
	const make = () => new Orchestrator({ supervisor, runDir, cwd: root, maxDepth: 4 });
	/** The persisted run, or a loud failure (readRun is nullable by design). */
	const persistedRun = () => {
		const record = runStore.readRun(rootRun.runId);
		if (!record) throw new Error(`run ${rootRun.runId} was not persisted`);
		return record;
	};
	return {
		root,
		runStore,
		rootRun,
		runDir,
		spawned,
		launchInstance: make,
		persistedRun,
		cleanup() {
			resetAdmissionQueuesForTests();
			fs.rmSync(root, { recursive: true, force: true });
		},
	};
}

test("#266 review-1: a control-action instance never admits anything", async () => {
	// Two independent guards keep this property, and this case pins the one the
	// others do not:
	//  - `schedulePump` returns early when the instance owns no launch guards, and
	//  - `pumpAdmissions`' probe answers "skip" (not "admit") for items it holds no
	//    payload for.
	// Removing EITHER alone leaves the queue intact, so a test asserting only "the
	// item is still queued" cannot tell them apart (`review-6` pins the probe half via
	// the notice stream). What is unique to the pump guard is that a control-action
	// instance must not run a pump at all — observably, it must not consume the
	// fallback deadline of somebody else's item, so the item's wait keeps counting
	// down instead of being expired early by a stranger's timer.
	const h = multiInstanceHarness();
	try {
		const owner = h.launchInstance();
		await owner.launch({ agent: agent(), task: "a", name: "a", worktree: false });
		for (const name of ["b", "c", "d"]) {
			const queued = await owner.launch({ agent: agent(), task: name, name, worktree: false });
			assert.equal(queued.queued, true, `${name} must wait`);
		}
		for (const child of owner.childrenSnapshot()) await h.runStore.addChild(h.rootRun.runId, child);

		// A control-action instance with no guards of its own, restored from disk.
		const control = h.launchInstance();
		control.restore(h.persistedRun());
		// It reports the queue (peek) but must never drive it.
		assert.deepEqual(control.launchQueueEntries().map((entry) => entry.name), ["b", "c", "d"]);
		await control.retire("a");
		await new Promise((resolve) => setTimeout(resolve, 1_400));

		// The cap is 1 and `a` is gone: exactly ONE admission may follow, and the
		// other two must still be waiting — a control instance that pumped would
		// advertise "admit" for all of them at once and blow through the cap.
		assert.ok(
			h.spawned.length <= 2,
			`the cap is 1, so at most one launch may follow the retire; spawned: ${h.spawned.join(",")}`,
		);
		assert.equal(h.spawned.includes("c"), false, "the control instance must not admit c");
		assert.equal(h.spawned.includes("d"), false, "nor d");
		const stillQueued = owner.childrenSnapshot().filter((child) => child.state === "queued").map((child) => child.name);
		assert.ok(stillQueued.length >= 1, `the cap must still hold, queued: ${stillQueued.join(",")}`);
	} finally {
		h.cleanup();
	}
});

test("#266 review-2: a queued item stays dequeueable from a control-action instance", async () => {
	// The other half of the same design: a control instance must still SEE the
	// owner's queue (peek, never acquire) so `subagent stop <queued>` works. Before
	// the fix `existingAdmissionQueue()` only read `this.admissionQueueRef`, so every
	// control instance saw an empty queue and `stop` was a silent no-op.
	const h = multiInstanceHarness();
	try {
		const owner = h.launchInstance();
		await owner.launch({ agent: agent(), task: "a", name: "a", worktree: false });
		await owner.launch({ agent: agent(), task: "b", name: "b", worktree: false });
		for (const child of owner.childrenSnapshot()) await h.runStore.addChild(h.rootRun.runId, child);

		const control = h.launchInstance();
		control.restore(h.persistedRun());
		assert.deepEqual(control.launchQueueEntries().map((entry) => entry.name), ["b"], "a control instance can see it");

		const retired = await control.retire("b");
		assert.equal(retired.state, "retired", "stop dequeues a queued item it never enqueued");
		assert.deepEqual(owner.launchQueueEntries(), [], "the owner's queue lost the item");
		assert.deepEqual(h.spawned, ["a"], "and nothing was spawned");
	} finally {
		h.cleanup();
	}
});

test("#266 review-3: collect on a queued child returns when its admission fails", async () => {
	// Before the fix `admitQueued` deleted the guard from the map and then let
	// `abandonQueued` look it up again — so the enqueue-time `settled` promise was
	// never settled and the matching `collect` hung forever (its timeoutMs ignored,
	// because that branch awaited the promise directly).
	const h = multiInstanceHarness("b");
	try {
		const A = h.launchInstance();
		await A.launch({ agent: agent(), task: "a", name: "a", worktree: false });
		await A.launch({ agent: agent(), task: "b", name: "b", worktree: false });
		const collecting = A.collect("b", { timeoutMs: 5_000 });
		await A.retire("a");
		// Bounded on purpose: before the fix the promise simply never settled (the
		// guard was deleted from the map before `abandonQueued` looked it up), so an
		// unbounded `await assert.rejects` would just hang the suite instead of
		// failing it. The race turns a hang into a legible failure.
		const outcome = await settleWithin(collecting, 3_000);
		assert.equal(outcome.kind, "rejected", `collect must settle, saw: ${outcome.kind}`);
		assert.ok(
			outcome.kind === "rejected" &&
				outcome.error instanceof SubagentError &&
				/session factory exploded/.test(outcome.error.message),
			"the admission failure must reach the waiting collect",
		);
	} finally {
		h.cleanup();
	}
});

test("#266 review-4: collect on a queued child honours the abort signal", async () => {
	// Before the fix that branch awaited `settled` bare, so an abort could not end
	// it: `async:false` would stay blocked for up to `launchQueueTimeoutMs` (default
	// 15 min) after the caller gave up. Every other collect branch honours `signal`.
	const h = multiInstanceHarness();
	try {
		const A = h.launchInstance();
		await A.launch({ agent: agent(), task: "a", name: "a", worktree: false });
		await A.launch({ agent: agent(), task: "b", name: "b", worktree: false });
		const abort = new AbortController();
		const collecting = A.collect("b", { timeoutMs: 60_000, signal: abort.signal });
		setTimeout(() => abort.abort(), 20);
		// Bounded: the pre-fix code awaited the enqueue-time promise bare, so an abort
		// left it pending for the FULL collect budget (60 s here, 15 min in
		// production). An unbounded `await assert.rejects` would turn that regression
		// into a suite hang instead of a legible failure.
		const outcome = await settleWithin(collecting, 2_000);
		assert.equal(outcome.kind, "rejected", `an abort must end the queue wait, saw: ${outcome.kind}`);
		assert.ok(
			outcome.kind === "rejected" &&
				outcome.error instanceof SubagentError &&
				/aborted by parent while queued/.test(outcome.error.message),
			"and must report the abort, not a timeout",
		);
	} finally {
		h.cleanup();
	}
});

test("#266 review-5 (D4): a queued name cannot be launched twice", async () => {
	// D4 requires the name-occupancy check to cover queued records. `previous`
	// deliberately ignores them (D3-a: the placeholder path is not a resume
	// credential) and a queued child is not `alive`, so both existing gates missed —
	// and a second `launch({name})` (exactly what `resume`/`continue` do when they
	// see `isAlive === false`) enqueued the same name twice, failing later at
	// admission with a confusing error.
	const h = multiInstanceHarness();
	try {
		const A = h.launchInstance();
		await A.launch({ agent: agent(), task: "a", name: "a", worktree: false });
		await A.launch({ agent: agent(), task: "b", name: "b", worktree: false });
		await assert.rejects(
			() => A.launch({ agent: agent(), task: "again", name: "b", worktree: false }),
			(error: unknown) =>
				error instanceof SubagentError &&
				error.code === ErrorCodes.NAME_TAKEN &&
				/child is already alive: b/.test(error.message),
			"the name is taken while it sits in the queue",
		);
		assert.deepEqual(A.launchQueueEntries().map((entry) => entry.name), ["b"], "the queue did not grow a duplicate");
	} finally {
		h.cleanup();
	}
});

test("#266 review-6: an instance must not judge a sibling's queue item", async () => {
	// `pumpAdmissions` scans the WHOLE shared queue, so an instance that owns at
	// least one item also walks past its siblings' items. Answering for them is
	// wrong in both directions:
	//  - `?? {admitted:true}` (the pre-fix fallback) spawns a launch this instance
	//    holds no payload for — 1b92fd3 and 1d38aa1 fixed that;
	//  - treating "no guard" as a LOST item is just as wrong: it retires a live
	//    sibling's launch with the I-O3 "queue was lost when the previous process
	//    exited" line, which is false here (the owner is alive and about to admit it).
	//
	// The observable that separates a correct skip from either failure is the
	// NOTICE stream: a healthy run reports only "queued(k)" and "started after
	// queued", never a lost-item line. Verified: neutering the skip makes this case
	// fail on the "queue was lost" assertion.
	resetAdmissionQueuesForTests();
	const root = fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "legion-admission-sibling-"));
	const runDir = path.join(root, "run");
	fs.mkdirSync(runDir, { recursive: true });
	const spawned: string[] = [];
	const notices: string[] = [];
	const inprocess = new InProcessSupervisor({
		limits: { maxActive: 30, maxChildrenPerNode: 1 },
		sessionFactory: async (input) => {
			spawned.push(input.name);
			return new SyncSession(input.sessionFile);
		},
	});
	const supervisor = new RoutingSupervisor({ inprocess });
	// Two launch-family instances over one run dir — the shape `index.ts` creates for
	// a command chain and a parallel recon family.
	const make = () => new Orchestrator({
		supervisor,
		runDir,
		cwd: root,
		maxDepth: 4,
		onLaunchQueueNotice: (line) => notices.push(line),
	});
	const a = make();
	const b = make();
	try {
		await a.launch({ agent: agent(), task: "holder", name: "a", worktree: false });
		await a.launch({ agent: agent(), task: "owned-by-a", name: "b", worktree: false });
		await b.launch({ agent: agent(), task: "owned-by-b", name: "c", worktree: false });
		assert.deepEqual(a.launchQueueEntries().map((entry) => entry.name), ["b", "c"], "one shared queue");
		assert.deepEqual(spawned, ["a"]);

		// Freeing the single slot wakes both instances; only each owner may admit its own.
		await a.retire("a");
		await new Promise((resolve) => setTimeout(resolve, 600));

		assert.deepEqual(spawned, ["a", "b"], "exactly one admission per freed slot, admitted by its owner");
		assert.deepEqual(a.launchQueueEntries().map((entry) => entry.name), ["c"], "the sibling's item is still waiting");
		assert.equal(
			notices.some((line) => /never started|queue was lost|failed to start/.test(line)),
			false,
			`no item may be declared lost while its owner is alive; notices: ${JSON.stringify(notices)}`,
		);
	} finally {
		resetAdmissionQueuesForTests();
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("#266 review-7 (I-O3): relaunching an orphaned queued name says 'queue lost', not NAME_TAKEN", async () => {
	// The D4 name gate and I-O3 must not collapse into one answer. A `queued` record
	// whose item is NOT in this process's queue is a leftover from a previous
	// process: it can never start, so `resume`/`continue` (which reach `launch` with
	// that name after seeing `isAlive === false`) must be told to re-dispatch — a
	// NAME_TAKEN would imply something is running and block the retry forever.
	// Conversely a name that IS live in this process's queue stays NAME_TAKEN.
	const h = multiInstanceHarness();
	try {
		// A run dir with one orphaned queued child and an EMPTY live queue.
		await h.runStore.addChild(h.rootRun.runId, {
			name: "ghost-0",
			sessionFile: path.join(h.runDir, "ghost-0.jsonl"),
			ownerToken: "t-ghost",
			state: "queued",
			spawnedAt: new Date(1_000).toISOString(),
		});
		const fresh = h.launchInstance();
		fresh.restore(h.persistedRun());
		assert.deepEqual(fresh.launchQueueEntries(), [], "no live queue in this process");
		await assert.rejects(
			() => fresh.launch({ agent: agent(), task: "retry", name: "ghost-0", worktree: false }),
			(error: unknown) =>
				error instanceof SubagentError &&
				error.code === ErrorCodes.BUDGET_EXCEEDED &&
				/never started: the launch queue was lost/.test(error.message),
			"an orphaned queued name must be re-dispatchable, not NAME_TAKEN",
		);
	} finally {
		h.cleanup();
	}
});

test("#266 review-8 (D4): auto-allocated names skip a sibling's queued name", async () => {
	// `allocateName` only consulted `this.children` + `supervisor.isAlive`. The queue
	// is process-level, so a sibling instance's pending launch is invisible to both —
	// allocating that name would hand back a taken name, and the D4 gate would then
	// refuse the new (perfectly legitimate) launch.
	resetAdmissionQueuesForTests();
	const root = fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "legion-admission-alloc-"));
	const runDir = path.join(root, "run");
	fs.mkdirSync(runDir, { recursive: true });
	const inprocess = new InProcessSupervisor({
		limits: { maxActive: 30, maxChildrenPerNode: 1 },
		sessionFactory: async (input) => new SyncSession(input.sessionFile),
	});
	const supervisor = new RoutingSupervisor({ inprocess });
	const make = () => new Orchestrator({ supervisor, runDir, cwd: root, maxDepth: 4 });
	const a = make();
	const b = make();
	try {
		await a.launch({ agent: agent(), task: "holder", name: "worker-0", worktree: false });
		// A takes the next auto name and it QUEUES (the cap is 1) — so it never
		// reaches the supervisor's registry, and `isAlive` cannot see it.
		const queuedName = a.allocateName("worker");
		assert.equal(queuedName, "worker-1");
		const queued = await a.launch({ agent: agent(), task: "queued", name: queuedName, worktree: false });
		assert.equal(queued.queued, true, "the item really waits in the shared queue");
		assert.equal(supervisor.isAlive(queuedName), false, "and is invisible to supervisor.isAlive");

		// B's counter starts at 0: it skips worker-0 (alive) and must ALSO skip the
		// name A is waiting on. Without the queue check it returns "worker-1" here.
		assert.notEqual(b.allocateName("worker"), queuedName, "an auto name must skip the shared queue");
	} finally {
		resetAdmissionQueuesForTests();
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("#266 review-9 (D7): flushing one instance clears only its own queue items", async () => {
	// `flushLaunchQueue` became reachable from control-action instances in 1b92fd3
	// (via `peekAdmissionQueue`). Flushing the whole shared queue would dequeue a
	// sibling's item without settling the sibling's guard or retiring its record —
	// leaving a permanent `queued` zombie whose `collect` never returns.
	resetAdmissionQueuesForTests();
	const root = fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "legion-admission-flush-"));
	const runDir = path.join(root, "run");
	fs.mkdirSync(runDir, { recursive: true });
	const inprocess = new InProcessSupervisor({
		limits: { maxActive: 30, maxChildrenPerNode: 1 },
		sessionFactory: async (input) => new SyncSession(input.sessionFile),
	});
	const supervisor = new RoutingSupervisor({ inprocess });
	const make = () => new Orchestrator({ supervisor, runDir, cwd: root, maxDepth: 4 });
	const a = make();
	const b = make();
	try {
		await a.launch({ agent: agent(), task: "holder", name: "a", worktree: false });
		await a.launch({ agent: agent(), task: "owned-by-a", name: "b", worktree: false });
		await b.launch({ agent: agent(), task: "owned-by-b", name: "c", worktree: false });
		assert.deepEqual(a.launchQueueEntries().map((entry) => entry.name), ["b", "c"], "one shared queue");

		const flushed = a.flushLaunchQueue("parent turn ended");
		assert.deepEqual(flushed, ["b"], "only the owner's own item is flushed");
		assert.deepEqual(a.launchQueueEntries().map((entry) => entry.name), ["c"], "the sibling's item survives");
		assert.equal(
			a.childrenSnapshot().find((child) => child.name === "b")?.state,
			"retired",
			"the flushed item's record is retired",
		);
		// The surviving item is still owned and still admittable — not a zombie.
		assert.equal(b.childrenSnapshot().find((child) => child.name === "c")?.state, "queued");
	} finally {
		resetAdmissionQueuesForTests();
		fs.rmSync(root, { recursive: true, force: true });
	}
});
