/**
 * #423 — the RECORD side of a launch: what `run.json` must carry, what a failed
 * launch must leave behind, and what a never-started child may never be called.
 *
 * The issue was debugged from a `run.json` that said `cwd=<parent host>`, had no
 * `host`, no `remoteTerminal` and `updatedAt == createdAt`. Everything a reader
 * needed to act was in those three missing facts, and the record that answered
 * `subagent({action:"stop"})` was worse: a child that never executed retired as
 * `execution: success`, which a parent (or an automated flow) reads as DELIVERED.
 *
 * Real Orchestrator over a real ledger + run store (the same fixture shape
 * `child-terminal-error.test.ts` uses), with a fake supervisor, so these are
 * assertions about behaviour rather than about a guard function existing.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { stopAction } from "../../index.ts";
import { createSessionRuntime } from "../../src/extension/runtime.ts";
import type { OrchestratorLegionContext } from "../../src/runs/orchestrator.ts";
import { Orchestrator } from "../../src/runs/orchestrator.ts";
import { RunStore } from "../../src/runs/store.ts";
import { legionDbPath, openLegionDb } from "../../src/legion/db.ts";
import { createLegionEventBus } from "../../src/extension/event-bus.ts";
import { insertNode } from "../../src/legion/nodes.ts";
import type { AgentConfig, ChildRecord } from "../../src/shared/types.ts";
import { ErrorCodes, SubagentError } from "../../src/shared/types.ts";
import { FakeSupervisor } from "../helpers/fake-supervisor.ts";

const HOST = "hw-nj";

function workerAgent(overrides: Partial<AgentConfig> = {}): AgentConfig {
	return {
		name: "worker",
		description: "launch verification role",
		systemPromptMode: "append",
		inheritProjectContext: false,
		inheritSkills: false,
		kind: "pi",
		systemPrompt: "You are a test worker.",
		source: "user",
		filePath: "/fake/worker.md",
		worktree: false,
		...overrides,
	};
}

/** A real legion ledger + run store, so `run.json` is the file a reader sees. */
function fixture(): {
	rootDir: string;
	runStore: RunStore;
	rootRunId: string;
	context: OrchestratorLegionContext;
	orchestrator: (supervisor: FakeSupervisor) => Orchestrator;
	child: (name: string) => ChildRecord | undefined;
	seed: (record: Partial<ChildRecord> & { name: string }) => Promise<void>;
	cleanup: () => void;
} {
	const rootDir = mkdtempSync(path.join(tmpdir(), "launch-verification-"));
	const runStore = new RunStore({ rootDir: path.join(rootDir, ".pi-subagents") });
	const rootRun = runStore.createRun({ task: "root task", cwd: rootDir, nodeId: "root", maxDepth: 4, herdr: { supervisor: "terminal" } });
	const dbPath = path.resolve(legionDbPath(runStore.runDir(rootRun.runId)));
	const db = openLegionDb(dbPath);
	insertNode(db, { parentId: null, name: "root", role: "root", runId: rootRun.runId, status: "running" });
	const context: OrchestratorLegionContext = {
		db,
		dbPath,
		nodeId: "root",
		parentNodeId: null,
		parentRunId: null,
		runId: rootRun.runId,
		runStore,
		settings: { maxDepth: 4, maxChildrenPerNode: 8, maxActiveNodes: 30 },
		eventBus: createLegionEventBus(),
	};
	return {
		rootDir,
		runStore,
		rootRunId: rootRun.runId,
		context,
		orchestrator: (supervisor) =>
			new Orchestrator({ supervisor, runDir: runStore.runDir(rootRun.runId), cwd: rootDir, maxDepth: 4, legion: context }),
		child: (name) => runStore.findChild(rootRun.runId, name) ?? undefined,
		seed: async (record) => {
			await runStore.addChild(rootRun.runId, {
				ownerToken: `${record.name}-token`,
				state: "launching",
				spawnedAt: new Date().toISOString(),
				agent: "worker",
				kind: "pi",
				sessionFile: path.join(runStore.runDir(rootRun.runId), `${record.name}.jsonl`),
				...record,
			});
		},
		cleanup: () => {
			db.close();
			rmSync(rootDir, { recursive: true, force: true });
		},
	};
}

function remoteTarget() {
	return {
		host: HOST,
		cwd: "/srv/app",
		node: "node",
		piCli: "pi",
		pathMap: [],
		piLegionRoot: "/srv/pi-legion",
		piExtensions: [],
		mirrorRoot: "/srv/.pi-subagents-mirror",
		worktreeRoot: "/srv/.pi-worktrees",
		allowRoles: ["worker"],
	};
}

/** The two hc env markers, so a `host` launch is admitted. */
async function insideHcTerminal(body: () => Promise<void>): Promise<void> {
	const socket = process.env.HC_TERMINAL_SOCKET;
	const id = process.env.HC_TERMINAL_ID;
	process.env.HC_TERMINAL_SOCKET = "/tmp/hc-launch-verification/default.sock";
	process.env.HC_TERMINAL_ID = "t1k";
	try {
		await body();
	} finally {
		if (socket === undefined) delete process.env.HC_TERMINAL_SOCKET;
		else process.env.HC_TERMINAL_SOCKET = socket;
		if (id === undefined) delete process.env.HC_TERMINAL_ID;
		else process.env.HC_TERMINAL_ID = id;
	}
}

// ── req 3: run.json must record host + remoteTerminal ──────────────────────

test("#423 req 3: a launched remote child's run.json carries host and the terminal address", async () => {
	const fx = fixture();
	try {
		const supervisor = new FakeSupervisor({
			handleExtras: { remoteDir: `/srv/.pi-subagents-mirror/${"r-x"}/worker-0`, remoteTerminal: `${HOST}/lgl-rx-worker-0` },
		});
		const orchestrator = fx.orchestrator(supervisor);
		await insideHcTerminal(async () => {
			await orchestrator.launch({ agent: workerAgent(), task: "do it", name: "worker-0", host: HOST, hostTarget: remoteTarget(), worktree: false });
		});
		const record = fx.child("worker-0");
		assert.ok(record, "the child must be persisted");
		// The three facts the issue found missing from the shell's record.
		assert.equal(record.host, HOST, "run.json must say WHICH machine the child runs on");
		assert.equal(record.remoteTerminal, `${HOST}/lgl-rx-worker-0`, "run.json must carry the address `hc` holds");
		assert.equal(record.remoteDir, "/srv/.pi-subagents-mirror/r-x/worker-0");
	} finally {
		fx.cleanup();
	}
});

// ── req 1: a failed launch leaves no `launching` shell ─────────────────────

test("#423 req 1: a launch that throws leaves NO record behind (the shell was the bug)", async () => {
	const fx = fixture();
	try {
		const supervisor = new FakeSupervisor({
			rejectSpawn: () => new SubagentError("host 'hw-nj': refused for this test", ErrorCodes.START_FAILED),
		});
		const orchestrator = fx.orchestrator(supervisor);
		await insideHcTerminal(async () => {
			await assert.rejects(
				orchestrator.launch({ agent: workerAgent(), task: "do it", name: "worker-0", host: HOST, hostTarget: remoteTarget(), worktree: false }),
				(error: unknown) => error instanceof SubagentError && error.code === ErrorCodes.START_FAILED,
			);
		});
		assert.equal(fx.child("worker-0"), undefined, "a record that says `launching` is exactly the shell #423 measured");
	} finally {
		fx.cleanup();
	}
});

test("#423 req 1: a launch that throws over a PRE-EXISTING record retires it as unknown, never `launching`", async () => {
	const fx = fixture();
	try {
		// The shape a re-dispatch finds: the reservation from a previous attempt.
		await fx.seed({ name: "worker-0", nodeId: "root.worker-0" });
		assert.equal(fx.child("worker-0")?.state, "launching");
		const supervisor = new FakeSupervisor({
			rejectSpawn: () => new SubagentError("host 'hw-nj': refused for this test", ErrorCodes.START_FAILED),
		});
		const orchestrator = fx.orchestrator(supervisor);
		await insideHcTerminal(async () => {
			await assert.rejects(
				orchestrator.launch({ agent: workerAgent(), task: "do it", name: "worker-0", host: HOST, hostTarget: remoteTarget(), worktree: false }),
				(error: unknown) => error instanceof SubagentError && error.code === ErrorCodes.START_FAILED,
			);
		});
		const record = fx.child("worker-0");
		assert.ok(record, "the pre-existing record stays (it is not ours to delete)");
		assert.equal(record.state, "retired", "a failed launch must not leave a `launching` record that renders as working");
		assert.equal(record.execution?.status, "unknown");
		assert.match(record.execution?.reason ?? "", /^launch failed: /);
	} finally {
		fx.cleanup();
	}
});

// ── req 6: the same handle is dispatchable again ───────────────────────────

test("#423 req 6: re-dispatching the SAME handle over a shell record does not answer NAME_TAKEN", async () => {
	const fx = fixture();
	try {
		// A shell left by a failed attempt: `launching`, no machine facts at all.
		await fx.seed({ name: "worker-0", nodeId: "root.worker-0" });
		const supervisor = new FakeSupervisor({
			handleExtras: { remoteDir: "/srv/.pi-subagents-mirror/r-x/worker-0", remoteTerminal: `${HOST}/lgl-rx-worker-0` },
		});
		const orchestrator = fx.orchestrator(supervisor);
		await insideHcTerminal(async () => {
			const handle = await orchestrator.launch({ agent: workerAgent(), task: "do it", name: "worker-0", host: HOST, hostTarget: remoteTarget(), worktree: false });
			assert.equal(handle.name, "worker-0");
			// The live record is a real child now, not the shell the name was holding.
			const live = orchestrator.childrenSnapshot().find((candidate) => candidate.name === "worker-0");
			assert.equal(live?.state, "working");
			assert.equal(live?.host, HOST);
		});
		// The run.json record was REUSED for this attempt (its `spawnedAt` refreshed,
		// its state re-reserved) instead of the launch answering NAME_TAKEN.
		const record = fx.child("worker-0");
		assert.ok(record, "the name stayed resolvable");
		assert.equal(record.state, "launching", "a re-dispatch re-reserves the record; the tool surface persists `working` on the next write");
	} finally {
		fx.cleanup();
	}
});

// ── req 4: a never-started child may not retire as `success` ──────────────

test("#423 req 4: retire refuses `success` for a child with no terminal and no transcript", async () => {
	const fx = fixture();
	try {
		const supervisor = new FakeSupervisor();
		const orchestrator = fx.orchestrator(supervisor);
		await insideHcTerminal(async () => {
			const handle = await orchestrator.launch({ agent: workerAgent(), task: "do it", name: "worker-0", host: HOST, hostTarget: remoteTarget(), worktree: false });
			const record = orchestrator.childrenSnapshot().find((candidate) => candidate.name === handle.name);
			assert.ok(record);
			// The measured shape: a 0-byte transcript, no terminal address, and an
			// `execution: success` that came from somewhere other than this child's work.
			writeFileSync(record.sessionFile, "");
			record.execution = { status: "success", reason: "parsed from a file that is not this child's work" };
			const retired = await orchestrator.retire(handle.name, { graceful: false });
			assert.notEqual(retired.execution?.status, "success", "a child that never ran cannot claim delivery");
			assert.equal(retired.execution?.status, "unknown");
			assert.match(retired.execution?.reason ?? "", /^never started: no terminal and no session on hw-nj/);
		});
	} finally {
		fx.cleanup();
	}
});

test("#423 req 4: a transcript with bytes keeps its success — the guard is not a blanket refusal", async () => {
	const fx = fixture();
	try {
		const supervisor = new FakeSupervisor();
		const orchestrator = fx.orchestrator(supervisor);
		await insideHcTerminal(async () => {
			const handle = await orchestrator.launch({ agent: workerAgent(), task: "do it", name: "worker-0", host: HOST, hostTarget: remoteTarget(), worktree: false });
			const record = orchestrator.childrenSnapshot().find((candidate) => candidate.name === handle.name);
			assert.ok(record);
			// A real turn: the child wrote an assistant message and stopped.
			writeFileSync(
				record.sessionFile,
				`${JSON.stringify({ type: "session", id: "s1", cwd: "/srv/app" })}\n${JSON.stringify({
					type: "message",
					message: {
						role: "assistant",
						content: [{ type: "text", text: '{"ok":true,"reason":"done"}' }],
						stopReason: "stop",
						model: "workbuddy/deepseek-v4.1-flash",
						usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
					},
				})}\n`,
			);
			delete record.execution;
			const retired = await orchestrator.retire(handle.name, { graceful: false });
			assert.equal(retired.execution?.status, "success", "work that really happened stays a success");
		});
	} finally {
		fx.cleanup();
	}
});

// ── req 4 at the receipt: what `stop` answers for a retired shell ─────────

test("#423 req 4: `stop` on an already-retired shell says `execution: unknown`, never `success`", async () => {
	const fx = fixture();
	try {
		const sessionFile = path.join(fx.runStore.runDir(fx.rootRunId), "legion-408.jsonl");
		// The exact record the issue quoted: retired, `execution: success`, no
		// terminal, no transcript, on another machine.
		await fx.seed({
			name: "legion-408",
			nodeId: "root.legion-408",
			state: "retired",
			sessionFile,
			host: HOST,
			retiredAt: "2026-08-01T08:23:25.000Z",
			execution: { status: "success", turns: 3 },
		});
		const runtime = createSessionRuntime({ sendMessage() {} });
		const result = await stopAction({
			params: { name: "legion-408" },
			runtime,
			store: fx.runStore,
			runId: fx.rootRunId,
			sessionRunId: fx.rootRunId,
			retire: async () => {},
		});
		const text = (result.content as Array<{ text?: string }>).map((part) => part.text ?? "").join("\n");
		assert.match(text, /legion-408 is already retired/);
		assert.doesNotMatch(text, /execution: success/, `a shell must never be reported as delivered:\n${text}`);
		assert.match(text, /execution: unknown/);
		assert.match(text, /never started: no terminal and no session on hw-nj/);
		runtime.dispose();
	} finally {
		fx.cleanup();
	}
});

test("#423 req 4: the same receipt keeps `success` when the record has a terminal", async () => {
	const fx = fixture();
	try {
		const sessionFile = path.join(fx.runStore.runDir(fx.rootRunId), "worker-0.jsonl");
		await fx.seed({
			name: "worker-0",
			nodeId: "root.worker-0",
			state: "retired",
			sessionFile,
			host: HOST,
			remoteTerminal: `${HOST}/lgl-rx-worker-0`,
			retiredAt: "2026-08-01T08:23:25.000Z",
			execution: { status: "success", turns: 3 },
		});
		const runtime = createSessionRuntime({ sendMessage() {} });
		const result = await stopAction({
			params: { name: "worker-0" },
			runtime,
			store: fx.runStore,
			runId: fx.rootRunId,
			sessionRunId: fx.rootRunId,
			retire: async () => {},
		});
		const text = (result.content as Array<{ text?: string }>).map((part) => part.text ?? "").join("\n");
		assert.match(text, /execution: success/);
		assert.doesNotMatch(text, /never started/);
		runtime.dispose();
	} finally {
		fx.cleanup();
	}
});
