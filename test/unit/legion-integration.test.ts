import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { FakeSupervisor } from "../helpers/fake-supervisor.ts";
import herdrSubagents from "../../index.ts";
import { LEGION_DB_ENV, LEGION_NODE_ID_ENV } from "../../src/runs/args.ts";
import { createLegionEventBus } from "../../src/extension/event-bus.ts";
import { legionDbPath, openLegionDb } from "../../src/legion/db.ts";
import { readEventsAfter } from "../../src/legion/events.ts";
import { getNode, insertNode } from "../../src/legion/nodes.ts";
import { getUsage } from "../../src/legion/usage.ts";
import { Orchestrator } from "../../src/runs/orchestrator.ts";
import { RunStore } from "../../src/runs/store.ts";
import { ErrorCodes, SubagentError, type AgentConfig } from "../../src/shared/types.ts";
import { assistantMsg, sessionHeader, userMsg } from "../helpers/fixtures.ts";

function agent(name = "worker", overrides: Partial<AgentConfig> = {}): AgentConfig {
	return {
		name,
		description: `${name} test role`,
		systemPromptMode: "append",
		inheritProjectContext: true,
		inheritSkills: false,
		kind: "pi",
		systemPrompt: `You are ${name}.`,
		source: "user",
		filePath: `/fake/${name}.md`,
		...overrides,
	};
}

function fixture(options: { maxActiveNodes?: number } = {}) {
	const rootDir = mkdtempSync(path.join(tmpdir(), "legion-orchestrator-"));
	const runStore = new RunStore({ rootDir: path.join(rootDir, ".pi-subagents") });
	const rootRun = runStore.createRun({ task: "root task", cwd: rootDir, nodeId: "root", maxDepth: 4, herdr: { supervisor: "rpc" } });
	const db = openLegionDb(":memory:");
	insertNode(db, { id: "root", parentId: null, name: "root", role: "root", runId: rootRun.runId, status: "running" });
	const settings = { maxDepth: 4, maxChildrenPerNode: 8, maxActiveNodes: options.maxActiveNodes ?? 30 };
	const context = {
		db,
		dbPath: path.join(runStore.runDir(rootRun.runId), "legion.db"),
		nodeId: "root",
		parentNodeId: null,
		parentRunId: null,
		runId: rootRun.runId,
		runStore,
		settings,
		eventBus: createLegionEventBus(),
	};
	return {
		rootDir,
		runStore,
		rootRun,
		db,
		context,
		cleanup() { db.close(); rmSync(rootDir, { recursive: true, force: true }); },
	};
}

test("index root launch honors a per-request team override", async () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "legion-index-team-"));
	const agentDir = path.join(cwd, "agent-config");
	const extraAgentsDir = path.join(cwd, "extra-agents");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(extraAgentsDir, { recursive: true });
	writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ subagents: { disableBuiltins: true, teams: { backend: { members: ["worker"] } } } }));
	writeFileSync(path.join(extraAgentsDir, "worker.md"), "---\nname: worker\ndescription: unit worker\n---\nworker prompt\n");
	writeFileSync(path.join(extraAgentsDir, "designer.md"), "---\nname: designer\ndescription: unit designer\n---\ndesigner prompt\n");
	const previous = new Map(["PI_CODING_AGENT_DIR", "PI_HERDR_SUBAGENTS_EXTRA_AGENT_DIRS", "PI_SUBAGENT_CHILD", "PI_SUBAGENT_ALLOW_NESTED"].map((name) => [name, process.env[name]]));
	const tools = new Map<string, { execute: (...args: unknown[]) => Promise<{ content?: Array<{ text?: string }>; details?: unknown }> }>();
	const handlers = new Map<string, (...args: unknown[]) => unknown>();
	const supervisor = new FakeSupervisor({ immediateTimeout: false });
	const pi = {
		registerTool(value: unknown) { const typed = value as { name: string; execute: (...args: unknown[]) => Promise<{ content?: Array<{ text?: string }>; details?: unknown }> }; tools.set(typed.name, typed); },
		registerCommand() {}, registerMessageRenderer() {}, sendMessage() {}, events: { emit() {} },
		on(name: string, handler: (...args: unknown[]) => unknown) { handlers.set(name, handler); },
	};
	try {
		process.env.PI_CODING_AGENT_DIR = agentDir;
		process.env.PI_HERDR_SUBAGENTS_EXTRA_AGENT_DIRS = extraAgentsDir;
		for (const name of ["PI_SUBAGENT_CHILD", "PI_SUBAGENT_ALLOW_NESTED"]) delete process.env[name];
		herdrSubagents(pi as never, { supervisor });
		const tool = tools.get("subagent");
		assert.ok(tool);
		await tool.execute("override-team", { agent: "worker", task: "be a backend worker", team: "backend", async: true, worktree: false }, undefined, undefined, {
			cwd, hasUI: false, ui: { notify() {}, setStatus() {} },
		});
		assert.equal(supervisor.spawns.length, 1);
		assert.equal(supervisor.spawns[0]?.input.env?.PI_SUBAGENTS_TEAM, "backend");
		assert.equal(supervisor.spawns[0]?.input.agent.name, "worker");
	} finally {
		await handlers.get("session_shutdown")?.();
		for (const [name, value] of previous) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("index root launch creates one reusable ledger, child identity opens it, and shutdown closes runtime", async () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "legion-index-wiring-"));
	const agentDir = path.join(cwd, "agent-config");
	const extraAgentsDir = path.join(cwd, "extra-agents");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(extraAgentsDir, { recursive: true });
	writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ subagents: { disableBuiltins: true } }));
	writeFileSync(path.join(extraAgentsDir, "worker.md"), "---\nname: worker\ndescription: unit worker\n---\nworker prompt\n");
	const environmentNames = ["PI_CODING_AGENT_DIR", "PI_HERDR_SUBAGENTS_EXTRA_AGENT_DIRS", "PI_SUBAGENT_CHILD", "PI_SUBAGENT_ALLOW_NESTED", "PI_LEGION_DB", "PI_LEGION_NODE_ID", "PI_SUBAGENTS_TEAM"];
	const previous = new Map(environmentNames.map((name) => [name, process.env[name]]));
	const tools = new Map<string, { execute: (...args: unknown[]) => Promise<{ content?: Array<{ text?: string }>; details?: unknown }> }>();
	const handlers = new Map<string, (...args: unknown[]) => unknown>();
	const supervisor = new FakeSupervisor({ immediateTimeout: false });
	const pi = {
		registerTool(tool: unknown) { const typed = tool as { name: string; execute: (...args: unknown[]) => Promise<{ content?: Array<{ text?: string }>; details?: unknown }> }; tools.set(typed.name, typed); },
		registerCommand() {}, registerMessageRenderer() {}, sendMessage() {},
		events: { emit() {} },
		on(name: string, handler: (...args: unknown[]) => unknown) { handlers.set(name, handler); },
	};
	try {
		process.env.PI_CODING_AGENT_DIR = agentDir;
		process.env.PI_HERDR_SUBAGENTS_EXTRA_AGENT_DIRS = extraAgentsDir;
		for (const key of ["PI_SUBAGENT_CHILD", "PI_SUBAGENT_ALLOW_NESTED", LEGION_DB_ENV, LEGION_NODE_ID_ENV, "PI_SUBAGENTS_TEAM"]) delete process.env[key];
		herdrSubagents(pi as never, { supervisor });
		const tool = tools.get("subagent");
		assert.ok(tool);
		const launch = await tool.execute("root-test", { agent: "worker", task: "create the first Legion tree", async: true, worktree: false }, undefined, undefined, {
			cwd, hasUI: false, ui: { notify() {}, setStatus() {} },
		});
		assert.match((launch.content ?? []).map((part) => part.text).join("\n"), /worker-0/);
		const store = new RunStore({ rootDir: path.join(cwd, ".pi-subagents") });
		const runs = store.listRuns();
		assert.equal(runs.length, 2, "the root and its child each have a run.json");
		const rootRun = runs.find((run) => run.nodeId === "root");
		const childRun = runs.find((run) => run.nodeId === "root.worker-0");
		assert.ok(rootRun && childRun);
		const dbPath = legionDbPath(store.runDir(rootRun.runId));
		assert.equal(existsSync(dbPath), true);
		assert.equal(rootRun.children[0]?.nodeId, "root.worker-0");
		const childSpawn = supervisor.spawns[0]?.input;
		assert.equal(childSpawn?.env?.[LEGION_DB_ENV], path.resolve(dbPath));
		assert.equal(childSpawn?.env?.[LEGION_NODE_ID_ENV], "root.worker-0");

		const db = openLegionDb(dbPath);
		try {
			assert.equal(getNode(db, "root")?.runId, rootRun.runId);
			assert.equal(getNode(db, "root.worker-0")?.runId, childRun.runId);
		} finally { db.close(); }
		await handlers.get("session_shutdown")?.();

		for (const key of environmentNames) {
			const value = previous.get(key);
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		process.env.PI_CODING_AGENT_DIR = agentDir;
		process.env.PI_HERDR_SUBAGENTS_EXTRA_AGENT_DIRS = extraAgentsDir;
		process.env.PI_SUBAGENT_CHILD = "1";
		process.env.PI_SUBAGENT_ALLOW_NESTED = "1";
		process.env[LEGION_DB_ENV] = dbPath;
		process.env[LEGION_NODE_ID_ENV] = "root.worker-0";
		const childTools = new Map<string, unknown>();
		const childHandlers = new Map<string, (...args: unknown[]) => unknown>();
		const childPi = {
			registerTool(value: unknown) { childTools.set((value as { name: string }).name, value); },
			registerCommand() {}, registerMessageRenderer() {}, sendMessage() {},
			events: { emit() {} },
			on(name: string, handler: (...args: unknown[]) => unknown) { childHandlers.set(name, handler); },
		};
		herdrSubagents(childPi as never, { supervisor: new FakeSupervisor() });
		assert.ok(childTools.has("subagent"));
		assert.ok(childTools.has("legion_mail"));
		assert.ok(childTools.has("legion_tree"));
		assert.equal(childTools.has("legion_phase"), false, "only centurion nodes receive legion_phase");
		await childHandlers.get("session_shutdown")?.();
	} finally {
		await handlers.get("session_shutdown")?.();
		for (const key of environmentNames) {
			const value = previous.get(key);
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("centurion resume recovers a running child and does not revive a settled child", async () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "legion-team-resume-"));
	const agentDir = path.join(cwd, "agent-config");
	const extraAgentsDir = path.join(cwd, "extra-agents");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(extraAgentsDir, { recursive: true });
	writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ subagents: { disableBuiltins: true } }));
	writeFileSync(path.join(extraAgentsDir, "worker.md"), "---\nname: worker\ndescription: worker role\nworktree: false\n---\nworker prompt\n");
	const envNames = ["PI_CODING_AGENT_DIR", "PI_HERDR_SUBAGENTS_EXTRA_AGENT_DIRS", "PI_SUBAGENT_CHILD", "PI_SUBAGENT_ALLOW_NESTED", LEGION_DB_ENV, LEGION_NODE_ID_ENV, "PI_SUBAGENTS_TEAM"];
	const prior = new Map(envNames.map((name) => [name, process.env[name]]));
	const tools = new Map<string, unknown>();
	const handlers = new Map<string, (...args: unknown[]) => unknown>();
	const supervisor = new FakeSupervisor({ immediateTimeout: false });
	const pi = {
		registerTool(tool: unknown) { tools.set((tool as { name: string }).name, tool); },
		registerCommand() {}, registerMessageRenderer() {}, sendMessage() {},
		events: { emit() {} },
		on(name: string, handler: (...args: unknown[]) => unknown) { handlers.set(name, handler); },
	};
	const store = new RunStore({ rootDir: path.join(cwd, ".pi-subagents") });
	const rootRun = store.createRun({ task: "CEO root", cwd, nodeId: "root", maxDepth: 4, herdr: { supervisor: "rpc" } });
	const centurionRun = store.createRun({ task: "surviving team", cwd, path: [{ runId: rootRun.runId, agent: "centurion" }], nodeId: "root.centurion" });
	const settledRun = store.createRun({ task: "settled work", cwd, path: centurionRun.path, nodeId: "root.centurion.worker-done" });
	const runningRun = store.createRun({ task: "running work", cwd, path: centurionRun.path, nodeId: "root.centurion.worker-running" });
	const centurionSession = store.sessionFileFor(centurionRun.runId, "centurion");
	const settledSession = store.sessionFileFor(settledRun.runId, "worker-done");
	const runningSession = store.sessionFileFor(runningRun.runId, "worker-running");
	writeFileSync(settledSession, [sessionHeader({ cwd }), userMsg("old work"), assistantMsg({ stopReason: "stop", text: '{"ok":true}' })].join("\n") + "\n");
	writeFileSync(runningSession, [sessionHeader({ cwd }), userMsg("work before centurion crash")].join("\n") + "\n");
	const now = Date.now();
	const dbPath = legionDbPath(store.runDir(rootRun.runId));
	const db = openLegionDb(dbPath);
	insertNode(db, { parentId: null, name: "root", role: "root", runId: rootRun.runId, status: "running" }, () => now);
	insertNode(db, { parentId: "root", name: "centurion", role: "centurion", runId: centurionRun.runId, sessionFile: centurionSession, worktreePath: cwd, status: "running", phase: "implementing" }, () => now);
	insertNode(db, { parentId: "root.centurion", name: "worker-done", role: "worker", runId: settledRun.runId, sessionFile: settledSession, status: "settled" }, () => now);
	insertNode(db, { parentId: "root.centurion", name: "worker-running", role: "worker", runId: runningRun.runId, sessionFile: runningSession, status: "running" }, () => now);
	await store.addChild(rootRun.runId, { name: "centurion", nodeId: "root.centurion", sessionFile: centurionSession, ownerToken: "centurion", state: "working", spawnedAt: rootRun.createdAt, agent: "centurion", kind: "pi", worktreePath: cwd });
	await store.addChild(centurionRun.runId, { name: "worker-done", nodeId: "root.centurion.worker-done", sessionFile: settledSession, ownerToken: "worker-done", state: "retired", spawnedAt: settledRun.createdAt, agent: "worker", kind: "pi" });
	await store.addChild(centurionRun.runId, { name: "worker-running", nodeId: "root.centurion.worker-running", sessionFile: runningSession, ownerToken: "worker-running", state: "retired", spawnedAt: runningRun.createdAt, agent: "worker", kind: "pi" });
	try {
		process.env.PI_CODING_AGENT_DIR = agentDir;
		process.env.PI_HERDR_SUBAGENTS_EXTRA_AGENT_DIRS = extraAgentsDir;
		process.env.PI_SUBAGENT_CHILD = "1";
		process.env.PI_SUBAGENT_ALLOW_NESTED = "1";
		process.env[LEGION_DB_ENV] = path.resolve(dbPath);
		process.env[LEGION_NODE_ID_ENV] = "root.centurion";
		const context = { ...process.env };
		void context;
		herdrSubagents(pi as never, { supervisor });
		assert.ok(tools.has("legion_mail"));
		assert.ok(tools.has("legion_tree"));
		for (let attempt = 0; attempt < 20 && supervisor.spawns.length === 0; attempt += 1) {
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		assert.equal(supervisor.spawns.length, 1, "only the unfinished child should be relaunched");
		assert.equal(supervisor.spawns[0]?.input.name, "worker-running");
		assert.equal(supervisor.spawns[0]?.input.sessionFile, runningSession);
		assert.equal(supervisor.spawns[0]?.input.env?.[LEGION_NODE_ID_ENV], "root.centurion.worker-running");
		assert.equal(getNode(db, "root.centurion.worker-done")?.status, "settled");
		assert.equal(getNode(db, "root.centurion.worker-running")?.runId, runningRun.runId, "resume keeps the node's own run id");
		await supervisor.retire("worker-running");
		await handlers.get("session_shutdown")?.();
	} finally {
		await handlers.get("session_shutdown")?.();
		await Promise.all(supervisor.spawns.map((spawn) => supervisor.isAlive(spawn.input.name) ? supervisor.retire(spawn.input.name) : Promise.resolve()));
		for (const name of envNames) {
			const value = prior.get(name);
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
		db.close();
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("legion launch refusal is atomic, records budget_refused, and removes run reservation", async () => {
	const fx = fixture({ maxActiveNodes: 1 });
	const supervisor = new FakeSupervisor();
	const orchestrator = new Orchestrator({
		supervisor,
		runDir: fx.runStore.runDir(fx.rootRun.runId),
		cwd: fx.rootDir,
		maxDepth: 4,
		legion: fx.context,
	});
	try {
		await assert.rejects(
			() => orchestrator.launch({ agent: agent(), task: "over active budget", worktree: false }),
			(error: unknown) => error instanceof SubagentError && error.code === ErrorCodes.BUDGET_EXCEEDED,
		);
		assert.equal(supervisor.spawns.length, 0);
		assert.deepEqual(fx.runStore.listRuns().map((run) => run.runId), [fx.rootRun.runId]);
		assert.deepEqual(readEventsAfter(fx.db, 0).map((event) => event.type), ["budget_refused"]);
		assert.deepEqual(fx.db.prepare("SELECT id FROM nodes ORDER BY id").all().map((row) => row.id), ["root"]);
	} finally {
		fx.cleanup();
	}
});

test("legion child outcomes and usage reach the ledger; resuming reuses its node and session", async () => {
	const fx = fixture();
	const firstSupervisor = new FakeSupervisor({ immediateTimeout: false, usage: { tokensIn: 20, tokensOut: 7, costUsd: 0.02 } });
	const runDir = fx.runStore.runDir(fx.rootRun.runId);
	const first = new Orchestrator({ supervisor: firstSupervisor, runDir, cwd: fx.rootDir, maxDepth: 4, legion: fx.context });
	try {
		const handle = await first.launch({ agent: agent(), task: "first pass", worktree: false });
		assert.equal(handle.child.nodeId, "root.worker-0");
		const ledger = getNode(fx.db, handle.child.nodeId!);
		assert.ok(ledger);
		assert.notEqual(ledger.runId, fx.rootRun.runId);
		assert.equal(path.dirname(ledger.sessionFile!), fx.runStore.runDir(ledger.runId!));
		await fx.runStore.updateChild(fx.rootRun.runId, handle.name, (child) => Object.assign(child, handle.child));

		const collecting = first.collect(handle.name, { timeoutMs: 1_000 });
		firstSupervisor.settle(handle.name, { text: '{"ok":true,"reason":"first pass complete"}' });
		const result = await collecting;
		assert.equal(result.execution.status, "success");
		assert.equal(getNode(fx.db, ledger.id)?.status, "settled");
		assert.deepEqual(getUsage(fx.db, ledger.id), {
			nodeId: ledger.id,
			tokensIn: 20,
			tokensOut: 7,
			costUsd: 0.02,
			updatedAt: getUsage(fx.db, ledger.id)?.updatedAt,
		});
		await first.retire(handle.name);
		await fx.runStore.updateChild(fx.rootRun.runId, handle.name, (child) => Object.assign(child, first.childrenSnapshot()[0]));

		const persistedRoot = fx.runStore.readRun(fx.rootRun.runId)!;
		const resumedSupervisor = new FakeSupervisor({ immediateTimeout: false });
		const resumed = new Orchestrator({ supervisor: resumedSupervisor, runDir, cwd: fx.rootDir, maxDepth: 4, legion: fx.context });
		resumed.restore(persistedRoot);
		const handle2 = await resumed.launch({ agent: agent(), task: "resume without duplicating the node", name: handle.name, worktree: false });
		assert.equal(handle2.child.nodeId, ledger.id);
		assert.equal(getNode(fx.db, ledger.id)?.runId, ledger.runId, "resuming must retain the node's original run id");
		assert.equal(handle2.sessionFile, handle.sessionFile);
		assert.equal(resumedSupervisor.spawns.length, 1);
		assert.equal(resumedSupervisor.spawns[0]?.input.env?.PI_LEGION_NODE_ID, ledger.id);
		assert.ok(readEventsAfter(fx.db, 0).some((event) => event.type === "node_resumed" && event.nodeId === ledger.id));
	} finally {
		fx.cleanup();
	}
});
