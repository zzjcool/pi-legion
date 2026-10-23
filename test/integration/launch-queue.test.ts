/**
 * Launch admission queue, end to end (issue #266, contract
 * `launch-admission-queue-v1` §8 A1).
 *
 * This is the acceptance case the issue was filed for: a 12-step fanout against
 * `maxChildrenPerNode: 8` used to produce 8 successes and 4 `BUDGET_EXCEEDED`
 * errors — the user-visible `inprocess maxChildrenPerNode reached for '<root>'
 * (8/8)` line. Now all 12 must run, the four over the cap must go through
 * `queued` → `admitted`, admission order must equal enqueue order, and no result
 * may mention the budget.
 *
 * The in-process backend is REAL (`InProcessSupervisor`): its counting, its gate
 * and its slot-release hook are the production ones. Only the SDK session
 * factory is faked, so no model is contacted and the whole case runs in
 * milliseconds.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { Orchestrator } from "../../src/runs/orchestrator.ts";
import { RunStore } from "../../src/runs/store.ts";
import { openLegionDb } from "../../src/legion/db.ts";
import { insertNode } from "../../src/legion/nodes.ts";
import { createLegionEventBus } from "../../src/extension/event-bus.ts";
import { InProcessSupervisor, type InProcessSession } from "../../src/supervisor/inprocess-supervisor.ts";
import { RoutingSupervisor } from "../../src/supervisor/routing-supervisor.ts";
import { resetAdmissionQueuesForTests } from "../../src/supervisor/admission-queue.ts";
import { FakeSupervisor } from "../helpers/fake-supervisor.ts";
import type { AgentConfig, ChildRecord } from "../../src/shared/types.ts";

function agent(overrides: Partial<AgentConfig> = {}): AgentConfig {
	return {
		name: "worker",
		description: "launch-queue integration role",
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
 * Role pinned to the RPC backend, for the legion-ledger assertions.
 *
 * The legion gates (`maxChildrenPerNode` / `maxActiveNodes`) are RPC-side only:
 * in-process children are budgeted by `subagents.inprocess.*`, so a test that
 * means to exercise the ledger must pin `spawnMode: "rpc"` or it silently tests
 * the in-process bucket instead.
 */
function rpcAgent(overrides: Partial<AgentConfig> = {}): AgentConfig {
	return agent({ spawnMode: "rpc", ...overrides });
}

/**
 * Session whose turn can be finished on demand, so the test controls exactly
 * when a slot is freed (`retire` → `onSlotReleased`).
 */
class ControlledSession implements InProcessSession {
	private readonly listeners = new Set<(event: unknown) => void>();
	private readonly sessionFile: string;
	constructor(sessionFile: string) {
		this.sessionFile = sessionFile;
	}

	subscribe(listener: (event: unknown) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	async prompt(text: string): Promise<void> {
		fs.appendFileSync(
			this.sessionFile,
			`${JSON.stringify({ type: "message", message: { role: "user", content: text } })}\n`,
		);
		for (const listener of [...this.listeners]) listener({ type: "agent_start" });
	}

	dispose(): void {}
}

interface Fixture {
	runDir: string;
	orchestrator: Orchestrator;
	inprocess: InProcessSupervisor;
	spawned: string[];
	/** Every record the orchestrator reported, in order (A1's order check). */
	updates: ChildRecord[];
	/** Highest `admissionCounts().active` ever observed. */
	peakActive(): number;
	cleanup(): void;
}

function fixture(limits: { maxActive?: number; maxChildrenPerNode?: number }): Fixture {
	resetAdmissionQueuesForTests();
	const root = fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "legion-launch-queue-"));
	const runDir = path.join(root, "run");
	fs.mkdirSync(runDir, { recursive: true });
	const spawned: string[] = [];
	const updates: ChildRecord[] = [];
	let peak = 0;
	const inprocess: InProcessSupervisor = new InProcessSupervisor({
		limits: { maxActive: 30, maxChildrenPerNode: 8, ...limits },
		sessionFactory: async (input) => {
			spawned.push(input.name);
			// A2: sample the live count at the moment a child is actually created.
			peak = Math.max(peak, inprocess.admissionCounts(input.name).active);
			return new ControlledSession(input.sessionFile);
		},
	});
	const orchestrator = new Orchestrator({
		supervisor: new RoutingSupervisor({ inprocess }),
		runDir,
		cwd: runDir,
		maxDepth: 4,
		onChildUpdate: (child) => updates.push({ ...child }),
	});
	return {
		runDir,
		orchestrator,
		inprocess,
		spawned,
		updates,
		peakActive: () => peak,
		cleanup() {
			orchestrator.flushLaunchQueue("test cleanup");
			resetAdmissionQueuesForTests();
			fs.rmSync(root, { recursive: true, force: true });
		},
	};
}

// ── A1: the issue's own reproduction ──────────────────────────────────────

test("A1: a 12-step fanout against maxChildrenPerNode 8 runs every step, admitting in queue order", async () => {
	const h = fixture({ maxChildrenPerNode: 8 });
	try {
		// All twelve launches start in one tick — the shape that used to fail.
		const handles = await Promise.all(
			Array.from({ length: 12 }, (_value, index) =>
				h.orchestrator.launch({ agent: agent(), task: `step-${index}`, name: `worker-${index}`, worktree: false })),
		);
		const queued = handles.filter((handle) => handle.queued === true).map((handle) => handle.name);
		const admittedAtLaunch = handles.filter((handle) => handle.queued !== true).map((handle) => handle.name);

		// Eight fit immediately, four wait — and the four are the LAST four.
		assert.equal(admittedAtLaunch.length, 8, `expected 8 immediate, got ${admittedAtLaunch.join(",")}`);
		assert.deepEqual(queued, ["worker-8", "worker-9", "worker-10", "worker-11"], "queue order is launch order (D5)");

		// Drain: free one slot at a time and let the pump admit the next item.
		let retired = 0;
		const admittedOrder: string[] = [];
		while (h.orchestrator.launchQueueEntries().length > 0) {
			const before = h.spawned.length;
			await h.orchestrator.retire(admittedAtLaunch[retired]!);
			retired += 1;
			// The slot release is an event; give the pump its turn.
			await new Promise((resolve) => setTimeout(resolve, 30));
			assert.ok(h.spawned.length > before, "a freed slot must admit the next queued item");
			admittedOrder.push(h.spawned[h.spawned.length - 1]!);
			if (retired >= admittedAtLaunch.length) break;
		}
		assert.deepEqual(
			admittedOrder,
			queued,
			"admission order must equal enqueue order (A1/D5)",
		);
		assert.equal(h.spawned.length, 12, "all twelve steps really ran");
		// No result may carry the old refusal: every launch resolved to a handle.
		for (const handle of handles) {
			assert.ok(handle.child, `${handle.name} returned a child record`);
			assert.equal(handle.child.state === "queued" || handle.child.state !== undefined, true);
		}
		// Nothing in the run reported a budget refusal.
		const refusalNotices = h.updates.filter((child) => child.execution?.reason?.includes("maxChildrenPerNode"));
		assert.deepEqual(refusalNotices, [], "no BUDGET_EXCEEDED / maxChildrenPerNode reached anywhere");
	} finally {
		h.cleanup();
	}
});

// ── A1: fast path untouched — no queue entry when slots are free ──────────

test("A1: under the cap nothing is queued and every launch spawns immediately", async () => {
	const h = fixture({ maxChildrenPerNode: 8 });
	try {
		const handles = await Promise.all(
			Array.from({ length: 8 }, (_value, index) =>
				h.orchestrator.launch({ agent: agent(), task: `step-${index}`, name: `worker-${index}`, worktree: false })),
		);
		assert.ok(handles.every((handle) => handle.queued !== true), "a free slot never queues (D2-b fast path)");
		assert.equal(h.orchestrator.launchQueueEntries().length, 0);
		assert.equal(h.spawned.length, 8);
	} finally {
		h.cleanup();
	}
});

// ── A2: maxActive is enforced at every sampled moment ────────────────────

test("A2: nine steps against maxActive 4 never have more than four live children", async () => {
	const h = fixture({ maxActive: 4, maxChildrenPerNode: 100 });
	try {
		const handles = await Promise.all(
			Array.from({ length: 9 }, (_value, index) =>
				h.orchestrator.launch({ agent: agent(), task: `step-${index}`, name: `worker-${index}`, worktree: false })),
		);
		assert.equal(handles.filter((handle) => handle.queued !== true).length, 4, "only maxActive fit at once");
		assert.ok(h.peakActive() <= 4, `active never exceeded 4 (peak ${h.peakActive()})`);
		// Drain one slot at a time until every step has run. Each retire releases one
		// slot, which admits exactly one queued item (A2 + D2-d-3).
		const retired = new Set<string>();
		for (let guard = 0; guard < 40 && h.spawned.length < 9; guard += 1) {
			const next = h.spawned.find((name) => !retired.has(name));
			if (!next) break;
			retired.add(next);
			await h.orchestrator.retire(next);
			await new Promise((resolve) => setTimeout(resolve, 30));
			assert.ok(h.peakActive() <= 4, `active never exceeded 4 (peak ${h.peakActive()})`);
		}
		assert.equal(h.spawned.length, 9, `all nine ran (saw ${h.spawned.join(",")})`);
		assert.ok(h.peakActive() <= 4, `active still never exceeded 4 (peak ${h.peakActive()})`);
		assert.equal(h.orchestrator.launchQueueEntries().length, 0, "the queue drained");
	} finally {
		h.cleanup();
	}
});

// ── A12 (legion path): collect must follow the ADMITTED record ────────────

/**
 * The RPC/legion path is where the placeholder and the real transcript diverge:
 * `createRun` + `sessionFileFor(runId, name)` give the child its own run
 * directory, while the queued placeholder used the PARENT run dir. A `collect`
 * that keeps reading through the placeholder record after admission therefore
 * parses a file nobody ever writes and reports an empty/aborted outcome — the
 * child looks dead the moment it finally starts.
 *
 * This case reproduces that divergence on purpose, so it fails if the post-wait
 * re-read in `collect()` is ever removed.
 */
test("A12: a queued legion child's collect reads the spawned run dir, not the placeholder", async () => {
	const rootDir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "legion-launch-queue-legion-"));
	resetAdmissionQueuesForTests();
	const runStore = new RunStore({ rootDir: path.join(rootDir, ".pi-subagents") });
	const rootRun = runStore.createRun({
		task: "root task",
		cwd: rootDir,
		nodeId: "root",
		maxDepth: 4,
		herdr: { supervisor: "rpc" },
	});
	const db = openLegionDb(":memory:");
	insertNode(db, { id: "root", parentId: null, name: "root", role: "root", runId: rootRun.runId, status: "running" });
	const supervisor = new FakeSupervisor({ immediateTimeout: false });
	const orchestrator = new Orchestrator({
		supervisor,
		runDir: runStore.runDir(rootRun.runId),
		cwd: rootDir,
		maxDepth: 4,
		legion: {
			db,
			dbPath: path.join(runStore.runDir(rootRun.runId), "legion.db"),
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
		const first = await orchestrator.launch({ agent: rpcAgent(), task: "first", name: "worker-0", worktree: false });
		const queued = await orchestrator.launch({ agent: rpcAgent(), task: "second", name: "worker-1", worktree: false });
		assert.equal(queued.queued, true, "the second launch waits for the fanout slot");
		const placeholder = queued.sessionFile;
		const collecting = orchestrator.collect("worker-1", { timeoutMs: 5_000 });
		// Freeing the slot admits worker-1, which creates its own run + transcript.
		await orchestrator.retire(first.name);
		let spawnedHandle = supervisor.spawns.find((spawn) => spawn.input.name === "worker-1");
		for (let attempt = 0; attempt < 200 && !spawnedHandle; attempt += 1) {
			await new Promise((resolve) => setTimeout(resolve, 10));
			spawnedHandle = supervisor.spawns.find((spawn) => spawn.input.name === "worker-1");
		}
		assert.ok(spawnedHandle, "the admitted child must reach the supervisor");
		assert.notEqual(
			spawnedHandle.input.sessionFile,
			placeholder,
			"the admitted child writes its own run-dir transcript, not the placeholder path",
		);
		supervisor.settle("worker-1", { text: '{"ok":true,"reason":"admitted then finished"}' });
		const result = await collecting;
		assert.equal(result.execution.status, "success", "collect must read the spawned transcript");
	} finally {
		orchestrator.flushLaunchQueue("test cleanup");
		resetAdmissionQueuesForTests();
		db.close();
		fs.rmSync(rootDir, { recursive: true, force: true });
	}
});
