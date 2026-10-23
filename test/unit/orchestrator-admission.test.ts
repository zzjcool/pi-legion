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
import { ErrorCodes, SubagentError, type AgentConfig, type ChildRecord } from "../../src/shared/types.ts";
import { withTempDir } from "../helpers/tmp.ts";

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
