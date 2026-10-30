/**
 * #309 D4 — a finished child must not be reported as "out of budget".
 *
 * Three production lines are pinned, each driven through the layer that owns
 * it (no reconstruction of the behaviour under test):
 *
 *  1. `ErrorCodes.CHILD_TERMINAL` exists and is distinct from `BUDGET_EXCEEDED`.
 *  2. Both `Orchestrator` refusals of a terminal legion child carry it:
 *     - `childFromNode` when the tracker learns the node from the ledger
 *       (a fresh orchestrator — the plain `subagent` control-call shape);
 *     - `reserveNode` when a child record was `restore()`d first, which is the
 *       production resume path (`controlAction` always restores before launch).
 *  3. `reviveChild`'s catch keeps a `SubagentError`'s code in `details.error`
 *     and still falls back to `START_FAILED` for a plain error — and in NO case
 *     does the code leak into the user-visible body text (the #266 A1/A20 and
 *     `launch-queue.test.ts:181` assertions depend on that).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { initTheme } from "@earendil-works/pi-coding-agent";
import piLegion from "../../index.ts";
import { createLegionEventBus } from "../../src/extension/event-bus.ts";
import { TEAM_ENV } from "../../src/agents/teams.ts";
import { legionDbPath, openLegionDb } from "../../src/legion/db.ts";
import { insertNode } from "../../src/legion/nodes.ts";
import { LEGION_DB_ENV, LEGION_NODE_ID_ENV } from "../../src/runs/args.ts";
import { Orchestrator, type OrchestratorLegionContext } from "../../src/runs/orchestrator.ts";
import { RunStore } from "../../src/runs/store.ts";
import { ErrorCodes, SubagentError, type AgentConfig } from "../../src/shared/types.ts";
import { FakeSupervisor } from "../helpers/fake-supervisor.ts";

// Unit tests run without Pi's host process, which normally initializes the theme.
initTheme("dark");

/** The frozen wording. Only the CODE was wrong; the message must not drift. */
const TERMINAL_MESSAGE = "legion child is terminal and cannot be resumed";

interface ToolResult {
	content?: Array<{ text?: string }>;
	details?: unknown;
}

interface RegisteredTool {
	execute(
		id: string,
		params: Record<string, unknown>,
		signal: undefined,
		onUpdate: undefined,
		ctx: unknown,
	): Promise<ToolResult>;
}

function workerAgent(overrides: Partial<AgentConfig> = {}): AgentConfig {
	return {
		name: "worker",
		description: "worker test role",
		systemPromptMode: "append",
		inheritProjectContext: true,
		inheritSkills: false,
		kind: "pi",
		systemPrompt: "You are worker.",
		source: "user",
		filePath: "/fake/worker.md",
		worktree: false,
		...overrides,
	};
}

function resultText(result: ToolResult): string {
	return (result.content ?? []).map((item) => item.text ?? "").join("\n");
}

/**
 * A real legion ledger on disk (`legion.db`) plus the run store beside it.
 *
 * The extension resolves its own store root from `PI_LEGION_DB`
 * (`runStoreFor` in `index.ts`), so the file-backed ledger is what lets the
 * same fixture serve the orchestrator-level and the tool-level tests.
 */
function makeLegionFixture() {
	const rootDir = mkdtempSync(path.join(tmpdir(), "child-terminal-"));
	const runStore = new RunStore({ rootDir: path.join(rootDir, ".pi-subagents") });
	const rootRun = runStore.createRun({
		task: "root task",
		cwd: rootDir,
		nodeId: "root",
		maxDepth: 4,
		herdr: { supervisor: "rpc" },
	});
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
	/**
	 * A child that exists in BOTH places the resume path reads: its own run, the
	 * ledger row, and the parent run's `children[]` record (`restore()` feeds the
	 * orchestrator from that record, `reserveNode` re-reads the ledger row).
	 */
	const seedChild = async (input: { name: string; status: "failed" | "settled"; phase?: string; withoutSession?: boolean }) => {
		const nodeId = `root.${input.name}`;
		const run = runStore.createRun({
			task: `${input.name} task`,
			cwd: rootDir,
			path: rootRun.path,
			maxDepth: 4,
			nodeId,
			herdr: { supervisor: "rpc", node_id: nodeId },
		});
		const sessionFile = runStore.sessionFileFor(run.runId, input.name);
		const node = insertNode(db, {
			parentId: "root",
			name: input.name,
			role: "worker",
			runId: run.runId,
			...(input.withoutSession ? {} : { sessionFile }),
			status: input.status,
			...(input.phase ? { phase: input.phase } : {}),
		});
		if (input.withoutSession) return { run, node, sessionFile };
		await runStore.addChild(rootRun.runId, {
			name: input.name,
			nodeId: node.id,
			sessionFile,
			ownerToken: `${input.name}-token`,
			state: "retired",
			spawnedAt: rootRun.createdAt,
			agent: "worker",
			kind: "pi",
		});
		return { run, node, sessionFile };
	};
	return {
		rootDir,
		runStore,
		rootRun,
		db,
		dbPath,
		context,
		seedChild,
		cleanup() {
			db.close();
			rmSync(rootDir, { recursive: true, force: true });
		},
	};
}

/**
 * The extension entry, registered the way a host would register it.
 *
 * `FakeSupervisor` is enough here: these cases assert what the tool REPORTS for
 * a launch that must not start, not how a real backend behaves.
 */
function registerExtension(fx: ReturnType<typeof makeLegionFixture>, supervisor: FakeSupervisor) {
	const agentDir = path.join(fx.rootDir, "agent-config");
	const extraAgentsDir = path.join(fx.rootDir, "extra-agents");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(extraAgentsDir, { recursive: true });
	writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ subagents: { disableBuiltins: true } }));
	writeFileSync(path.join(extraAgentsDir, "worker.md"), "---\nname: worker\ndescription: worker role\nworktree: false\n---\nworker prompt\n");
	const envNames = [
		"PI_CODING_AGENT_DIR",
		"PI_HERDR_SUBAGENTS_EXTRA_AGENT_DIRS",
		"PI_SUBAGENT_CHILD",
		"PI_SUBAGENT_UTILITY_CHILD",
		LEGION_DB_ENV,
		LEGION_NODE_ID_ENV,
		TEAM_ENV,
	];
	const previous = new Map(envNames.map((name) => [name, process.env[name]]));
	const tools = new Map<string, RegisteredTool>();
	const handlers = new Map<string, (...args: unknown[]) => unknown>();
	const pi = {
		registerTool(tool: unknown) {
			const typed = tool as RegisteredTool & { name: string };
			tools.set(typed.name, typed);
		},
		registerCommand() {},
		registerMessageRenderer() {},
		sendMessage() {},
		events: { emit() {} },
		on(name: string, handler: (...args: unknown[]) => unknown) {
			handlers.set(name, handler);
		},
	};
	process.env.PI_CODING_AGENT_DIR = agentDir;
	process.env.PI_HERDR_SUBAGENTS_EXTRA_AGENT_DIRS = extraAgentsDir;
	delete process.env.PI_SUBAGENT_CHILD;
	delete process.env.PI_SUBAGENT_UTILITY_CHILD;
	process.env[LEGION_DB_ENV] = fx.dbPath;
	process.env[LEGION_NODE_ID_ENV] = "root";
	piLegion(pi as never, { supervisor });
	const tool = tools.get("subagent");
	assert.ok(tool, "the `subagent` tool is registered through the index entry point");
	return {
		tool,
		async cleanup() {
			// Stops the legion postman/event source this entry opened; without it the
			// test file never drains.
			await handlers.get("session_shutdown")?.({ mode: "interactive" });
			for (const [name, value] of previous) {
				if (value === undefined) delete process.env[name];
				else process.env[name] = value;
			}
		},
	};
}

function assertChildTerminalRefusal(error: unknown, nodeId: string): true {
	assert.ok(error instanceof SubagentError, `expected a SubagentError, got ${String(error)}`);
	assert.equal(error.code, ErrorCodes.CHILD_TERMINAL, `a terminal child is not a budget verdict: ${error.code}`);
	assert.ok(error.message.startsWith(`${TERMINAL_MESSAGE}: ${nodeId}`), `the message must not drift: ${error.message}`);
	assert.doesNotMatch(error.message, /BUDGET_EXCEEDED/, "the code must not be spliced into the message");
	return true;
}

test("#309 D4: CHILD_TERMINAL is its own code, not BUDGET_EXCEEDED", () => {
	assert.equal(ErrorCodes.CHILD_TERMINAL, "CHILD_TERMINAL");
	assert.notEqual(ErrorCodes.CHILD_TERMINAL, ErrorCodes.BUDGET_EXCEEDED, "a finished child and a spent budget must be distinguishable");
});

test("#309 D4: a terminal ledger node is refused with CHILD_TERMINAL by childFromNode", async () => {
	const fx = makeLegionFixture();
	try {
		// Deliberately seeded WITHOUT a session file. `childFromNode` tests
		// "terminal" BEFORE "has a session to resume", so with this row its
		// terminal branch is the only source of `CHILD_TERMINAL` in the launch:
		// drop it and the same call surfaces `no session to resume` / NOT_FOUND
		// instead. That is what keeps this assertion pinned to THIS site rather
		// than to the equivalent (and equally loud) check in `reserveNode`.
		await fx.seedChild({ name: "worker-done", status: "failed", withoutSession: true });
		// No `restore()`: the tracker starts empty, so `launch` learns the child
		// from the ledger and `childFromNode` is the site that refuses.
		const orchestrator = new Orchestrator({
			supervisor: new FakeSupervisor(),
			runDir: fx.runStore.runDir(fx.rootRun.runId),
			cwd: fx.rootDir,
			maxDepth: 4,
			legion: fx.context,
		});
		await assert.rejects(
			orchestrator.launch({ agent: workerAgent(), task: "resume the finished child", name: "worker-done", worktree: false }),
			(error: unknown) => assertChildTerminalRefusal(error, "root.worker-done"),
		);
	} finally {
		fx.cleanup();
	}
});

test("#309 D4: a restored terminal child is refused with CHILD_TERMINAL by reserveNode", async () => {
	const fx = makeLegionFixture();
	try {
		// `phase: "done"` exercises the other half of the terminal predicate: the
		// node finished normally, it never failed — and it still must not resume.
		await fx.seedChild({ name: "worker-done", status: "settled", phase: "done" });
		const orchestrator = new Orchestrator({
			supervisor: new FakeSupervisor(),
			runDir: fx.runStore.runDir(fx.rootRun.runId),
			cwd: fx.rootDir,
			maxDepth: 4,
			legion: fx.context,
		});
		// `controlAction` in index.ts always restores the run before respawning a
		// child, so the in-memory record wins over `childFromNode` and the refusal
		// happens in `reserveNode` — this is the production resume shape.
		orchestrator.restore(fx.runStore.readRun(fx.rootRun.runId)!);
		await assert.rejects(
			orchestrator.launch({ agent: workerAgent(), task: "resume the finished child", name: "worker-done", worktree: false }),
			(error: unknown) => assertChildTerminalRefusal(error, "root.worker-done"),
		);
	} finally {
		fx.cleanup();
	}
});

test("#309 D4: reviveChild keeps a SubagentError's code in details.error and out of the visible text", async () => {
	const fx = makeLegionFixture();
	const supervisor = new FakeSupervisor();
	const extension = registerExtension(fx, supervisor);
	try {
		await fx.seedChild({ name: "worker-done", status: "failed" });
		const result = await extension.tool.execute(
			"continue-terminal-child",
			{ action: "continue", name: "worker-done", message: "pick the work back up" },
			undefined,
			undefined,
			{ cwd: fx.rootDir, hasUI: false, ui: { notify() {}, setStatus() {} } },
		);
		const details = result.details as { error?: string } | undefined;
		assert.equal(details?.error, ErrorCodes.CHILD_TERMINAL, `the launcher's own code must survive the catch: ${details?.error}`);
		assert.equal(supervisor.spawns.length, 0, "a terminal child must not be relaunched");
		const text = resultText(result);
		assert.ok(text.includes(TERMINAL_MESSAGE), `the refusal is still explained to the model:\n${text}`);
		assert.doesNotMatch(text, /CHILD_TERMINAL/, `the code belongs in details.error only:\n${text}`);
		assert.doesNotMatch(text, /BUDGET_EXCEEDED/, `no budget wording on a terminal child:\n${text}`);
	} finally {
		await extension.cleanup();
		fx.cleanup();
	}
});

test("#309 D4: reviveChild still reports START_FAILED for a non-SubagentError", async () => {
	const fx = makeLegionFixture();
	// A plain `Error` from the backend — the shape that must NOT be reinterpreted.
	const supervisor = new FakeSupervisor({ rejectSpawn: () => new Error("supervisor backend crashed") });
	const extension = registerExtension(fx, supervisor);
	try {
		// Settled, not terminal: `reserveNode` lets this through, so the failure the
		// catch sees is the spawn error itself.
		await fx.seedChild({ name: "worker-settled", status: "settled" });
		const result = await extension.tool.execute(
			"continue-after-crash",
			{ action: "continue", name: "worker-settled", message: "carry on" },
			undefined,
			undefined,
			{ cwd: fx.rootDir, hasUI: false, ui: { notify() {}, setStatus() {} } },
		);
		const details = result.details as { error?: string } | undefined;
		assert.equal(details?.error, ErrorCodes.START_FAILED, `a plain error keeps the historic code: ${details?.error}`);
		const text = resultText(result);
		assert.match(text, /^continue failed: Error: supervisor backend crashed$/m, `the body keeps the raw error:\n${text}`);
		assert.doesNotMatch(text, /START_FAILED/, `the code belongs in details.error only:\n${text}`);
		assert.doesNotMatch(text, /BUDGET_EXCEEDED/, `no budget wording on a spawn failure:\n${text}`);
	} finally {
		await extension.cleanup();
		fx.cleanup();
	}
});
