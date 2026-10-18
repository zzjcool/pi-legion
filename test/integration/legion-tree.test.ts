import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerLegionTools, type LegionCommandRunner } from "../../src/extension/legion-tools.ts";
import { createLegionEventBus } from "../../src/extension/event-bus.ts";
import { openLegionDb, legionDbPath } from "../../src/legion/db.ts";
import { appendEvent, readEventsAfter } from "../../src/legion/events.ts";
import { getNode, insertNode } from "../../src/legion/nodes.ts";
import { Orchestrator } from "../../src/runs/orchestrator.ts";
import { RunStore } from "../../src/runs/store.ts";
import { RoutingSupervisor } from "../../src/supervisor/routing-supervisor.ts";
import { InMemoryUIProxy } from "../../src/supervisor/ui-proxy.ts";
import { FakeSupervisor } from "../helpers/fake-supervisor.ts";
import type { AgentConfig } from "../../src/shared/types.ts";

function agent(name: string, overrides: Partial<AgentConfig> = {}): AgentConfig {
	return {
		name,
		description: `${name} integration role`,
		systemPromptMode: "append",
		inheritProjectContext: true,
		inheritSkills: false,
		kind: "pi",
		systemPrompt: `You are the ${name}.`,
		source: "project",
		filePath: `/fixtures/${name}.md`,
		...overrides,
	};
}

/**
 * Role pinned to the RPC backend.
 *
 * Use this ONLY where the assertion reads an RPC-only observable: the child's
 * lineage env (`PI_LEGION_DB` / `PI_LEGION_NODE_ID` / `PI_SUBAGENTS_TEAM`) or the
 * `worktreeBranch` passed to RPC spawn. In-process children carry identity in an
 * in-process context instead of env, so a defaulted worker would make
 * `spawns.every(...)` assertions vacuously true on an empty spawn list.
 * Everywhere else the suite must keep running on the default backend — that is
 * what catches default-flip regressions.
 */
function rpcAgent(name: string, overrides: Partial<AgentConfig> = {}): AgentConfig {
	return agent(name, { spawnMode: "rpc", ...overrides });
}

function phaseTool(db: ReturnType<typeof openLegionDb>, nodeId: string, cwd: string, runDir: string, runCommand?: LegionCommandRunner) {
	const tools = new Map<string, { execute: (id: string, params: Record<string, unknown>) => Promise<{ content?: Array<{ text?: string }>; details?: unknown }> }>();
	const pi = {
		registerTool(tool: unknown) {
			const typed = tool as { name: string; execute: (id: string, params: Record<string, unknown>) => Promise<{ content?: Array<{ text?: string }>; details?: unknown }> };
			tools.set(typed.name, typed);
		},
	};
	const messages: string[] = [];
	registerLegionTools(pi as unknown as ExtensionAPI, {
		db,
		nodeId,
		role: "centurion",
		cwd,
		runDir,
		runCommand,
		settings: { verifyCommandTimeoutMs: 5_000 },
		eventBus: createLegionEventBus(),
		sendSelfMessage: (text) => messages.push(text),
	});
	const tool = tools.get("legion_phase");
	assert.ok(tool, "a centurion must receive legion_phase");
	return {
		messages,
		async request(to: string): Promise<string> {
			const result = await tool.execute("phase-test", { to });
			return (result.content ?? []).map((item) => item.text ?? "").join("\n");
		},
	};
}

async function finishChild(input: {
	orchestrator: Orchestrator;
	supervisor: FakeSupervisor;
	store: RunStore;
	runId: string;
	role: string;
	task: string;
	text: string;
}) {
	const handle = await input.orchestrator.launch({ agent: agent(input.role), task: input.task, worktree: false });
	if (input.store.findChild(input.runId, handle.name)) {
		await input.store.updateChild(input.runId, handle.name, (child) => Object.assign(child, handle.child));
	} else {
		await input.store.addChild(input.runId, handle.child);
	}
	const collecting = input.orchestrator.collect(handle.name, { timeoutMs: 1_000 });
	input.supervisor.settle(handle.name, { text: input.text });
	const collected = await collecting;
	assert.equal(collected.execution.status, "success");
	await input.orchestrator.retire(handle.name);
	await input.store.updateChild(input.runId, handle.name, (child) => Object.assign(child, input.orchestrator.childrenSnapshot().find((record) => record.name === handle.name)));
	return handle;
}

test("M2 default spawn mode: a centurion parent dispatches a worktree:true worker card on the default backend", async () => {
	// Regression guard for the `centurion dispatches worker` production path.
	//
	// `agents/worker.md` pins `worktree: true` and sets no spawnMode, while a
	// centurion parent forces the launch worktree to false (`parentRole ===
	// "centurion"`). With the default backend now `inprocess`, the arbitrated
	// agent must have BOTH fields normalized, or the real router rejects the
	// self-contradictory `{spawnMode:"inprocess", worktree:true}` pair with
	// INVALID_PARAMS on every nested dispatch. FakeSupervisor cannot see this (it
	// only checks kind), so this case deliberately wires a real RoutingSupervisor
	// with recording backend stubs: the router's own guard runs for real, only the
	// would-be child process is replaced.
	const sandbox = mkdtempSync(path.join(tmpdir(), "legion-tree-default-mode-"));
	const repo = path.join(sandbox, "repo");
	mkdirSync(repo, { recursive: true });
	const git = (args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "ignore" });
	git(["init", "-q"]);
	git(["config", "user.email", "legion-test@example.invalid"]);
	git(["config", "user.name", "Legion integration test"]);
	writeFileSync(path.join(repo, "README.md"), "fixture\n");
	git(["add", "README.md"]);
	git(["commit", "-m", "test fixture", "-q"]);

	const store = new RunStore({ rootDir: path.join(repo, ".pi-subagents") });
	const rootRun = store.createRun({ task: "default mode nested dispatch", cwd: repo, maxDepth: 4, nodeId: "root", herdr: { supervisor: "rpc" } });
	const dbPath = legionDbPath(store.runDir(rootRun.runId));
	const db = openLegionDb(dbPath);
	const seen: Array<{ mode: string | undefined; worktree: boolean | undefined }> = [];
	const record = (input: { agent: AgentConfig }) => {
		seen.push({ mode: input.agent.spawnMode, worktree: input.agent.worktree });
		return { name: "recorded", sessionFile: path.join(repo, "unused.jsonl"), pid: 1 };
	};
	const uiProxy = new InMemoryUIProxy();
	const supervisor = new RoutingSupervisor({
		rpc: { uiProxy, isAlive: () => false, spawnChild: async (input: { agent: AgentConfig }) => record(input) } as never,
		inprocess: { uiProxy, isAlive: () => false, spawnChild: async (input: { agent: AgentConfig }) => record(input) } as never,
		uiProxy,
	});
	try {
		insertNode(db, { id: "root", parentId: null, name: "root", role: "root", runId: rootRun.runId, status: "running" });
		insertNode(db, { id: "root.centurion-0", parentId: "root", name: "centurion-0", role: "centurion", runId: rootRun.runId, status: "running" });
		const orchestrator = new Orchestrator({
			supervisor,
			runDir: store.runDir(rootRun.runId),
			cwd: repo,
			maxDepth: 4,
			legion: { db, dbPath, nodeId: "root.centurion-0", runId: rootRun.runId, runStore: store, settings: { maxDepth: 4, maxChildrenPerNode: 8, maxActiveNodes: 30 }, eventBus: createLegionEventBus() },
		});
		// Exactly the worker role-card shape: worktree pinned true, spawnMode omitted.
		const handle = await orchestrator.launch({ agent: agent("worker", { worktree: true }), task: "Implement the slice." });
		assert.equal(handle.child.worktreePath, undefined, "a centurion parent suppresses its workers' worktrees");
		assert.equal(handle.child.nodeId, "root.centurion-0.worker-0");
		assert.deepEqual(seen, [{ mode: "inprocess", worktree: false }], "default backend, worktree normalized away");
	} finally {
		db.close();
		rmSync(sandbox, { recursive: true, force: true });
	}
});

test("M2 tree e2e: root → centurion worktree → parallel workers → review → verify → done", async () => {
	const sandbox = mkdtempSync(path.join(tmpdir(), "legion-tree-e2e-"));
	const repo = path.join(sandbox, "repo");
	mkdirSync(repo, { recursive: true });
	const git = (args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "ignore" });
	git(["init", "-q"]);
	git(["config", "user.email", "legion-test@example.invalid"]);
	git(["config", "user.name", "Legion integration test"]);
	writeFileSync(path.join(repo, "README.md"), "legion integration fixture\n");
	git(["add", "README.md"]);
	git(["commit", "-m", "test fixture", "-q"]);

	const store = new RunStore({ rootDir: path.join(repo, ".pi-subagents") });
	const rootRun = store.createRun({ task: "Run the nested integration tree", cwd: repo, maxDepth: 4, nodeId: "root", herdr: { supervisor: "rpc" } });
	const dbPath = legionDbPath(store.runDir(rootRun.runId));
	const db = openLegionDb(dbPath);
	insertNode(db, { id: "root", parentId: null, name: "root", role: "root", runId: rootRun.runId, status: "running", taskSummary: rootRun.task });
	appendEvent(db, "root", "node_launched", { runId: rootRun.runId, task: rootRun.task });
	const settings = { maxDepth: 4, maxChildrenPerNode: 8, maxActiveNodes: 30, verifyCommandTimeoutMs: 5_000 };
	const rootSupervisor = new FakeSupervisor({ immediateTimeout: false });
	const root = new Orchestrator({
		supervisor: rootSupervisor,
		runDir: store.runDir(rootRun.runId),
		cwd: repo,
		maxDepth: 4,
		legion: { db, dbPath, nodeId: "root", runId: rootRun.runId, runStore: store, settings, eventBus: createLegionEventBus() },
	});
	try {
		const centurion = await root.launch({
			agent: agent("centurion", { allowNestedSubagents: true, maxSubagentDepth: 2, worktree: true }),
			task: "Lead a small implementation squad.",
			team: "be-value",
		});
		assert.ok(centurion.child.worktreePath, "centurion runs in an isolated subtree worktree");
		assert.equal(centurion.child.nodeId, "root.centurion-0");
		assert.equal(rootSupervisor.spawns[0]?.input.env?.PI_LEGION_DB, path.resolve(dbPath));
		assert.equal(rootSupervisor.spawns[0]?.input.env?.PI_LEGION_NODE_ID, centurion.child.nodeId);
		await store.updateChild(rootRun.runId, centurion.name, (child) => Object.assign(child, centurion.child));
		const centurionNode = getNode(db, centurion.child.nodeId!)!;
		const centurionRun = store.readRun(centurionNode.runId!)!;
		assert.equal(centurionRun.nodeId, centurionNode.id);
		assert.equal(centurionNode.phase, "planning");
		assert.equal(centurionRun.cwd, centurion.child.worktreePath);

		const teamSupervisor = new FakeSupervisor({ immediateTimeout: false });
		const teamOrchestrator = new Orchestrator({
			supervisor: teamSupervisor,
			runDir: store.runDir(centurionRun.runId),
			cwd: centurion.child.worktreePath!,
			parentPath: centurionRun.path,
			maxDepth: 4,
			team: { name: "be-value", source: "settings" },
			legion: {
				db, dbPath, nodeId: centurionNode.id,
				parentNodeId: "root", parentRunId: rootRun.runId,
				runId: centurionRun.runId, runStore: store, settings,
				eventBus: createLegionEventBus(),
			},
		});
		const contractPath = path.join(centurion.child.worktreePath!, ".pi-legion", "contract.md");
		mkdirSync(path.dirname(contractPath), { recursive: true });
		writeFileSync(contractPath, [
			"# Frozen test contract",
			"Goal: prove the three-level Legion wiring.",
			"Interface: workers return a machine-readable verdict.",
			"Files: worker-0 and worker-1 own no overlapping files.",
			"```legion-verify",
			"test -f README.md",
			"```",
		].join("\n"));

		const verificationLog = path.join(store.runDir(centurionRun.runId), `${centurionNode.name}.legion-verify.log`);
		const tool = phaseTool(db, centurionNode.id, centurion.child.worktreePath!, store.runDir(centurionRun.runId));
		assert.match(await tool.request("implementing"), /Phase changed to implementing/);

		const workerText = "Implementation complete; no reviewer verdict is claimed.";
		const workerHandles = await Promise.all([
			// Pinned: the assertions below read these children's RPC lineage env.
			teamOrchestrator.launch({ agent: rpcAgent("worker"), task: "Implement first independent slice.", worktree: false }),
			teamOrchestrator.launch({ agent: rpcAgent("worker"), task: "Implement second independent slice.", worktree: false }),
		]);
		for (const handle of workerHandles) {
			if (store.findChild(centurionRun.runId, handle.name)) await store.updateChild(centurionRun.runId, handle.name, (child) => Object.assign(child, handle.child));
			else await store.addChild(centurionRun.runId, handle.child);
		}
		const workerCollections = workerHandles.map((handle) => teamOrchestrator.collect(handle.name, { timeoutMs: 1_000 }));
		for (const handle of workerHandles) teamSupervisor.settle(handle.name, { text: workerText });
		for (let index = 0; index < workerHandles.length; index += 1) {
			assert.equal((await workerCollections[index]!).execution.status, "success");
			await teamOrchestrator.retire(workerHandles[index]!.name);
			await store.updateChild(centurionRun.runId, workerHandles[index]!.name, (child) => Object.assign(child, teamOrchestrator.childrenSnapshot().find((record) => record.name === workerHandles[index]!.name)));
		}
		const worker0 = workerHandles[0]!;
		const worker1 = workerHandles[1]!;
		assert.deepEqual([worker0.child.nodeId, worker1.child.nodeId], ["root.centurion-0.worker-0", "root.centurion-0.worker-1"]);
		assert.ok(teamSupervisor.spawns.every((spawn) => spawn.input.worktreeBranch === undefined));
		assert.ok(teamSupervisor.spawns.every((spawn) => spawn.input.env?.PI_LEGION_DB === path.resolve(dbPath)));
		assert.ok(teamSupervisor.spawns.every((spawn) => spawn.input.env?.PI_SUBAGENTS_TEAM === "be-value"));
		assert.match(await tool.request("reviewing"), /Phase changed to reviewing/);
		const rejectedReviewerText = '{"ok":false,"reason":"One major edge case needs a fix."}';
		const rejectedReviewer = await finishChild({
			orchestrator: teamOrchestrator,
			supervisor: teamSupervisor,
			store,
			runId: centurionRun.runId,
			role: "reviewer",
			task: "Find major defects in both slices.",
			text: rejectedReviewerText,
		});
		assert.equal(getNode(db, rejectedReviewer.child.nodeId!)?.status, "settled");
		assert.match(await tool.request("verifying"), /reviewer verdict ok:true/);
		assert.match(await tool.request("implementing"), /Phase changed to implementing/);
		assert.equal(getNode(db, centurionNode.id)?.reworkCount, 1);
		assert.match(await tool.request("reviewing"), /Phase changed to reviewing/);
		const reviewerText = '{"ok":true,"reason":"Both independent slices pass adversarial review."}';
		const reviewer = await finishChild({
			orchestrator: teamOrchestrator,
			supervisor: teamSupervisor,
			store,
			runId: centurionRun.runId,
			role: "reviewer",
			task: "Review both implementation slices after the rework.",
			text: reviewerText,
		});
		assert.equal(getNode(db, reviewer.child.nodeId!)?.status, "settled");
		assert.match(await tool.request("verifying"), /automatically advanced to done/);
		assert.equal(existsSync(verificationLog), true);
		assert.match(readFileSync(verificationLog, "utf8"), /\$ test -f README\.md\nexit: 0/);
		assert.equal(getNode(db, centurionNode.id)?.phase, "done");
		assert.equal(tool.messages.some((message) => /squash/.test(message)), true);
		assert.equal(getNode(db, worker0.child.nodeId!)?.status, "settled");
		assert.equal(getNode(db, worker1.child.nodeId!)?.status, "settled");
		assert.equal(getNode(db, reviewer.child.nodeId!)?.status, "settled");
		assert.ok(readEventsAfter(db, 0).some((event) => event.nodeId === centurionNode.id && event.type === "phase_change" && (event.data as { to?: string } | null)?.to === "done"));

		const collectingCenturion = root.collect(centurion.name, { timeoutMs: 1_000 });
		rootSupervisor.settle(centurion.name, { text: '{"ok":true,"reason":"Centurion collected the squad and opened its squash proposal."}' });
		const delivered = await collectingCenturion;
		assert.equal(delivered.execution.status, "success");
		assert.equal(delivered.acceptance.status, "accepted");
		await root.retire(centurion.name);
		await store.updateChild(rootRun.runId, centurion.name, (child) => Object.assign(child, root.childrenSnapshot().find((record) => record.name === centurion.name)));
		assert.equal(store.readRun(rootRun.runId)?.children[0]?.nodeId, centurionNode.id);
		const tree = execFileSync("git", ["-C", centurion.child.worktreePath!, "branch", "--show-current"], { encoding: "utf8" }).trim();
		assert.match(tree, /^pi-subagent\/centurion-0-/);
	} finally {
		db.close();
		rmSync(sandbox, { recursive: true, force: true });
	}
});
