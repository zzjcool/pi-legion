import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { FakeSupervisor } from "../helpers/fake-supervisor.ts";
import { LegionPostman } from "../../src/extension/legion-tools.ts";
import herdrSubagents from "../../index.ts";
import { LEGION_DB_ENV, LEGION_NODE_ID_ENV } from "../../src/runs/args.ts";
import { createLegionEventBus } from "../../src/extension/event-bus.ts";
import { legionDbPath, openLegionDb } from "../../src/legion/db.ts";
import { readEventsAfter } from "../../src/legion/events.ts";
import { inbox, MAIL_DELIVERY, sendMail } from "../../src/legion/mail.ts";
import { getNode, insertNode } from "../../src/legion/nodes.ts";
import { getUsage } from "../../src/legion/usage.ts";
import { Orchestrator } from "../../src/runs/orchestrator.ts";
import { RunStore } from "../../src/runs/store.ts";
import { ErrorCodes, SubagentError, type AgentConfig } from "../../src/shared/types.ts";
import { assistantMsg, sessionHeader, userMsg } from "../helpers/fixtures.ts";

import type { Component, OverlayHandle } from "@earendil-works/pi-tui";
import type { LegionEvent } from "../../src/extension/event-bus.ts";
import {
	createLegionSupervisorEventAdapter,
	publishSupervisorEvent,
	registerLegionCommand,
	type RpcEventSource,
} from "../../src/extension/legion-commands.ts";
import type { TreeNodeSnapshot, TreeViewComponent } from "../../src/tui/tree-view.ts";
import type { LegionSupervisor, SpawnInput, SupervisorEvent } from "../../src/supervisor/types.ts";

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
	const previous = new Map(["PI_CODING_AGENT_DIR", "PI_HERDR_SUBAGENTS_EXTRA_AGENT_DIRS", "PI_SUBAGENT_CHILD", "PI_SUBAGENT_ALLOW_NESTED", "PI_LEGION_DB", "PI_LEGION_NODE_ID", "PI_SUBAGENTS_TEAM"].map((name) => [name, process.env[name]]));
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
		for (const name of ["PI_SUBAGENT_CHILD", "PI_SUBAGENT_ALLOW_NESTED", "PI_LEGION_DB", "PI_LEGION_NODE_ID", "PI_SUBAGENTS_TEAM"]) delete process.env[name];
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
		await tool.execute("root-test-second", { agent: "worker", task: "reuse the current Legion tree", async: true, worktree: false }, undefined, undefined, {
			cwd, hasUI: false, ui: { notify() {}, setStatus() {} },
		});
		const runs = store.listRuns();
		assert.equal(runs.length, 3, "one root run is reused while each node retains its own run.json");
		const rootRuns = runs.filter((run) => run.nodeId === "root");
		assert.equal(rootRuns.length, 1, "repeated root launches must not create another root ledger");
		const rootRun = rootRuns[0];
		const childRun = runs.find((run) => run.nodeId === "root.worker-0");
		assert.ok(rootRun && childRun);
		const dbPath = legionDbPath(store.runDir(rootRun.runId));
		assert.equal(existsSync(dbPath), true);
		assert.deepEqual(rootRun?.children.map((child) => child.nodeId), ["root.worker-0", "root.worker-1"]);
		assert.equal(runs.filter((run) => existsSync(legionDbPath(store.runDir(run.runId)))).length, 1, "only the root run owns legion.db");
		assert.equal(supervisor.spawns.length, 2);
		for (const childSpawn of supervisor.spawns.map((spawn) => spawn.input)) {
			assert.equal(childSpawn?.env?.[LEGION_DB_ENV], path.resolve(dbPath));
		}
		assert.deepEqual(supervisor.spawns.map((spawn) => spawn.input.env?.[LEGION_NODE_ID_ENV]), ["root.worker-0", "root.worker-1"]);

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
	writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ subagents: { disableBuiltins: true, teams: { backend: { members: ["worker"] } } } }));
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
	insertNode(db, { parentId: "root.centurion", name: "worker-running", role: "worker", runId: runningRun.runId, sessionFile: runningSession, team: "backend", status: "running" }, () => now);
	await store.addChild(rootRun.runId, { name: "centurion", nodeId: "root.centurion", sessionFile: centurionSession, ownerToken: "centurion", state: "working", spawnedAt: rootRun.createdAt, agent: "centurion", kind: "pi", worktreePath: cwd });
	await store.addChild(centurionRun.runId, { name: "worker-done", nodeId: "root.centurion.worker-done", sessionFile: settledSession, ownerToken: "worker-done", state: "retired", spawnedAt: settledRun.createdAt, agent: "worker", kind: "pi" });
	await store.addChild(centurionRun.runId, { name: "worker-running", nodeId: "root.centurion.worker-running", sessionFile: runningSession, ownerToken: "worker-running", state: "retired", spawnedAt: runningRun.createdAt, agent: "worker", kind: "pi" });
	try {
		const rootSupervisor = new FakeSupervisor({ immediateTimeout: false });
		await rootSupervisor.spawnChild({ name: "centurion", task: "old centurion process", agent: agent("centurion"), sessionFile: centurionSession, tempDir: store.runDir(rootRun.runId), cwd });
		await rootSupervisor.retire("centurion");
		db.prepare("UPDATE nodes SET updated_at = 1 WHERE id = ?").run("root.centurion");
		const orphanMessages: string[] = [];
		const rootPostman = new LegionPostman({ db, nodeId: "root", supervisor: rootSupervisor, settings: { orphanStaleMs: 100 }, now: () => now + 1_000, sendRootMessage: (message) => orphanMessages.push(message), intervalMs: 10_000 });
		await rootPostman.tick();
		assert.ok(orphanMessages.some((message) => message.includes("Legion orphan detected: root.centurion")));
		assert.ok(readEventsAfter(db, 0).some((event) => event.nodeId === "root.centurion" && event.type === "orphan_detected"));
		rootPostman.stop();
		process.env.PI_CODING_AGENT_DIR = agentDir;
		process.env.PI_HERDR_SUBAGENTS_EXTRA_AGENT_DIRS = extraAgentsDir;
		process.env.PI_SUBAGENT_CHILD = "1";
		process.env.PI_SUBAGENT_ALLOW_NESTED = "1";
		process.env[LEGION_DB_ENV] = path.resolve(dbPath);
		process.env[LEGION_NODE_ID_ENV] = "root.centurion";
		herdrSubagents(pi as never, { supervisor });
		assert.ok(tools.has("legion_mail"));
		assert.ok(tools.has("legion_tree"));
		assert.ok(tools.has("legion_phase"), "a resumed centurion keeps the phase-transition tool");
		for (let attempt = 0; attempt < 20 && supervisor.spawns.length === 0; attempt += 1) {
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		assert.equal(supervisor.spawns.length, 1, "only the unfinished child should be relaunched");
		assert.equal(supervisor.spawns[0]?.input.name, "worker-running");
		assert.equal(supervisor.spawns[0]?.input.sessionFile, runningSession);
		assert.equal(supervisor.spawns[0]?.input.env?.[LEGION_NODE_ID_ENV], "root.centurion.worker-running");
		assert.equal(supervisor.spawns[0]?.input.env?.PI_SUBAGENTS_TEAM, "backend", "a resumed node retains its persisted team override");
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

test("retireAll marks an unfinished squad aborted and queued mail cannot revive it", async () => {
	const fx = fixture();
	const name = "centurion";
	const sessionFile = fx.runStore.sessionFileFor(fx.rootRun.runId, name);
	const centurion = insertNode(fx.db, {
		parentId: "root", name, role: "centurion", runId: fx.rootRun.runId,
		sessionFile, status: "running", phase: "implementing",
	});
	await fx.runStore.addChild(fx.rootRun.runId, {
		name, nodeId: centurion.id, sessionFile, ownerToken: "centurion-token",
		state: "working", spawnedAt: fx.rootRun.createdAt, agent: name, kind: "pi",
	});
	const supervisor = new FakeSupervisor({ immediateTimeout: false });
	await supervisor.spawnChild({ name, task: "unfinished squad", agent: agent(name), sessionFile, tempDir: fx.runStore.runDir(fx.rootRun.runId), cwd: fx.rootDir });
	const orchestrator = new Orchestrator({
		supervisor,
		runDir: fx.runStore.runDir(fx.rootRun.runId),
		cwd: fx.rootDir,
		maxDepth: 4,
		legion: fx.context,
	});
	orchestrator.restore(fx.runStore.readRun(fx.rootRun.runId)!);
	try {
		await orchestrator.retireAll();
		assert.equal(getNode(fx.db, centurion.id)?.phase, "aborted");
		assert.ok(readEventsAfter(fx.db, 0).some((event) => event.nodeId === centurion.id && event.type === "phase_change" && (event.data as { to?: string } | null)?.to === "aborted"));

		const mail = sendMail(fx.db, { fromNode: "root", to: centurion.id, subject: "late task", body: "resume the old squad" });
		assert.equal(mail.ok, true);
		assert.ok(mail.ok);
		const resumed: string[] = [];
		const postman = new LegionPostman({
			db: fx.db,
			nodeId: "root",
			supervisor,
			resumeChild: async (node) => { resumed.push(node.id); },
			intervalMs: 10_000,
		});
		await postman.tick();
		assert.deepEqual(resumed, [], "an upper-level retire is deliberate and cannot be undone by mail");
		assert.equal(inbox(fx.db, centurion.id, { delivery: MAIL_DELIVERY.BOUNCED }).length, 1);
		assert.equal(supervisor.isAlive(name), false);
		postman.stop();
	} finally {
		await supervisor.retire(name).catch(() => {});
		fx.cleanup();
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

		await fx.runStore.updateRun(fx.rootRun.runId, (run) => {
			run.children[0]!.state = "working";
			run.budget.spawned = 1;
		});
		const persistedRoot = fx.runStore.readRun(fx.rootRun.runId)!;
		const resumedSupervisor = new FakeSupervisor({ immediateTimeout: false });
		const resumed = new Orchestrator({ supervisor: resumedSupervisor, runDir, cwd: fx.rootDir, maxDepth: 4, maxSpawns: 1, legion: fx.context });
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

const NOW = 50_000;

function makeNode(
	id: string,
	parentId: string | null,
	name: string,
	depth: number,
	status: TreeNodeSnapshot["status"] = "running",
): TreeNodeSnapshot {
	return {
		id,
		parentId,
		name,
		role: name === "root" ? "ceo" : "worker",
		kind: "pi",
		depth,
		runId: null,
		sessionFile: null,
		worktreePath: null,
		model: "test/model",
		team: null,
		status,
		phase: null,
		phaseSince: null,
		reworkCount: 0,
		contractPath: null,
		taskSummary: null,
		createdAt: NOW - 5_000,
		updatedAt: NOW - 1_000,
	};
}

const treeNodes = [
	makeNode("root", null, "root", 0),
	makeNode("root.worker", "root", "worker", 1),
	makeNode("root.other", "root", "other", 1),
];

class FakeRpcEvents implements RpcEventSource {
	readonly subscriptions: Array<{
		name: string;
		options?: { includeTextDelta?: boolean };
		listener: (event: SupervisorEvent) => void;
	}> = [];
	unsubscribeCount = 0;

	onEvent(
		name: string,
		listener: (event: SupervisorEvent) => void,
		options?: { includeTextDelta?: boolean },
	): () => void {
		const subscription = { name, listener, ...(options ? { options } : {}) };
		this.subscriptions.push(subscription);
		return () => {
			this.unsubscribeCount += 1;
			const index = this.subscriptions.indexOf(subscription);
			if (index >= 0) this.subscriptions.splice(index, 1);
		};
	}

	emit(name: string, event: SupervisorEvent): void {
		for (const subscription of [...this.subscriptions]) {
			if (subscription.name === name) subscription.listener(event);
		}
	}
}

function testOverlayHandle(): OverlayHandle {
	return {
		hide() {},
		setHidden() {},
		isHidden: () => false,
		focus() {},
		unfocus() {},
		isFocused: () => false,
		getBounds: () => undefined,
	};
}

interface OpenCustomCall {
	component?: Component;
	options?: { overlay?: boolean; onHandle?: (handle: OverlayHandle) => void };
	promise: Promise<unknown>;
}

class FakeCommandUi {
	readonly calls: OpenCustomCall[] = [];
	readonly notifications: Array<{ message: string; level: string }> = [];
	readonly theme = { fg: (_color: string, text: string) => text };
	readonly tui = { requestRender() {}, terminal: { rows: 8 } };

	custom<T>(
		factory: (
			tui: never,
			theme: never,
			keybindings: never,
			done: (result: T) => void,
		) => Component | Promise<Component>,
		options?: { overlay?: boolean; onHandle?: (handle: OverlayHandle) => void },
	): Promise<T> {
		let resolve!: (value: T) => void;
		let reject!: (error: unknown) => void;
		const promise = new Promise<T>((resolvePromise, rejectPromise) => {
			resolve = resolvePromise;
			reject = rejectPromise;
		});
		const call: OpenCustomCall = { options, promise };
		this.calls.push(call);
		try {
			const created = factory(
				this.tui as never,
				this.theme as never,
				undefined as never,
				(value) => resolve(value),
			);
			void Promise.resolve(created).then((component) => {
				call.component = component;
				options?.onHandle?.(testOverlayHandle());
			}, reject);
		} catch (error) {
			reject(error);
		}
		return promise;
	}

	notify(message: string, level = "info"): void {
		this.notifications.push({ message, level });
	}
}

function commandHarness(nodes: TreeNodeSnapshot[] = treeNodes) {
	const bus = createLegionEventBus();
	const rpc = new FakeRpcEvents();
	const ui = new FakeCommandUi();
	const jobs = nodes
		.filter((node) => node.parentId !== null)
		.map((node) => ({ name: node.name, nodeId: node.id, state: "working" }));
	const runtime = {
		activeJobs: () => jobs,
		treeNodes: () => nodes.map((node) => ({ ...node })),
	};
	let handler: ((args: string, ctx: unknown) => Promise<void>) | undefined;
	const pi = {
		registerCommand(name: string, command: { handler: typeof handler }) {
			if (name === "legion") handler = command.handler;
		},
	};
	registerLegionCommand(pi as never, { bus, runtime, supervisor: rpc });
	const ctx = { hasUI: true, cwd: "/tmp", ui };
	return { bus, rpc, ui, runtime, handler: handler!, ctx };
}

test("/legion mounts the paged tree; j/o opens a node overlay and q/Esc close both views", async () => {
	const harness = commandHarness();
	const treeOpen = harness.handler("", harness.ctx);
	await Promise.resolve();
	assert.equal(harness.ui.calls.length, 1);
	assert.equal(harness.ui.calls[0]?.options?.overlay, undefined);
	const tree = harness.ui.calls[0]?.component as TreeViewComponent | undefined;
	assert.ok(tree);
	assert.ok(tree.render(80).length <= 8, "the factory injects terminal rows for self-paging");

	tree.handleInput?.("j");
	tree.handleInput?.("j");
	assert.equal(tree.getState().selectedId, "root.worker");
	tree.handleInput?.("o");
	await Promise.resolve();
	assert.equal(harness.ui.calls.length, 2);
	assert.equal(harness.ui.calls[1]?.options?.overlay, true);
	assert.deepEqual(harness.rpc.subscriptions.map(({ name, options }) => ({ name, options })), [
		{ name: "worker", options: { includeTextDelta: true } },
	]);

	const overlay = harness.ui.calls[1]?.component as (Component & {
		getState(): { activity: readonly string[]; open: boolean };
	}) | undefined;
	assert.ok(overlay);
	harness.rpc.emit("other", {
		name: "other",
		type: "message_update",
		updateType: "text_delta",
		delta: "not for worker",
	});
	harness.rpc.emit("worker", {
		name: "worker",
		type: "message_update",
		updateType: "text_delta",
		delta: "worker output",
	});
	assert.deepEqual(overlay.getState().activity, ["worker output"]);
	assert.equal(overlay.getState().open, true);

	overlay.handleInput?.("\u001b");
	await harness.ui.calls[1]!.promise;
	assert.equal(harness.rpc.unsubscribeCount, 1, "closing unsubscribes the one selected child RPC feed");
	tree.handleInput?.("q");
	await treeOpen;
	assert.equal(tree.getState().visibleIds.length > 0, true);
	assert.equal(harness.rpc.subscriptions.length, 0);
});

test("/legion <name> opens the selected floating overlay and Esc unsubscribes only that node", async () => {
	const harness = commandHarness();
	await harness.handler("worker", harness.ctx);
	assert.equal(harness.ui.calls.length, 1);
	assert.equal(harness.ui.calls[0]?.options?.overlay, true);
	assert.deepEqual(harness.rpc.subscriptions.map((subscription) => subscription.name), ["worker"]);
	const overlay = harness.ui.calls[0]?.component as Component | undefined;
	assert.ok(overlay);
	overlay.handleInput?.("\u001b");
	await harness.ui.calls[0]!.promise;
	assert.equal(harness.rpc.unsubscribeCount, 1);
	assert.equal(harness.rpc.subscriptions.length, 0);
});

test("/legion rejects ambiguous short names and completes with node labels", async () => {
	const nodes = [
		makeNode("root", null, "root", 0),
		makeNode("root.alpha.worker", "root.alpha", "worker", 2),
		makeNode("root.beta.worker", "root.beta", "worker", 2),
	];
	const harness = commandHarness(nodes);
	await harness.handler("worker", harness.ctx);
	assert.equal(harness.ui.calls.length, 0);
	assert.match(harness.ui.notifications[0]?.message ?? "", /ambiguous/);
});

test("Legion supervisor adapter emits process-domain lifecycle events on operation completion", async () => {
	const bus = createLegionEventBus();
	const seen: LegionEvent[] = [];
	for (const type of ["node_launched", "node_steered", "node_aborted", "node_retired"] as const) {
		bus.on(type, (event) => seen.push(event));
	}
	const calls: string[] = [];
	const supervisor: LegionSupervisor & RpcEventSource = {
		async spawnChild(input: SpawnInput) {
			calls.push(`spawn:${input.name}`);
			return { name: input.name, sessionFile: "/tmp/child.jsonl" };
		},
		async prompt() {},
		async steer(name) { calls.push(`steer:${name}`); },
		async followUp() {},
		async abort(name) { calls.push(`abort:${name}`); },
		async waitSettled() { return { settled: true, abnormal: false }; },
		isAlive() { return true; },
		async stats() { return null; },
		async retire(name) { calls.push(`retire:${name}`); },
		onEvent: (_name, _listener) => () => {},
	};
	const adapter = createLegionSupervisorEventAdapter(
		supervisor,
		bus,
		(name) => `root.${name}`,
	);
	adapter.setNodeId("worker", "root.centurion.worker");
	await adapter.spawnChild({ name: "worker" } as SpawnInput);
	await adapter.steer("worker", "fix this");
	await adapter.abort("worker");
	await adapter.retire("worker");
	assert.deepEqual(calls, ["spawn:worker", "steer:worker", "abort:worker", "retire:worker"]);
	assert.deepEqual(seen.map(({ type, nodeId }) => ({ type, nodeId })), [
		{ type: "node_launched", nodeId: "root.centurion.worker" },
		{ type: "node_steered", nodeId: "root.centurion.worker" },
		{ type: "node_aborted", nodeId: "root.centurion.worker" },
		{ type: "node_retired", nodeId: "root.centurion.worker" },
	]);
});

test("LegionEventBus only publishes text_delta when the per-child opt-in is enabled", () => {
	const bus = createLegionEventBus();
	const seen: LegionEvent[] = [];
	bus.on("text_delta", (event) => seen.push(event));
	const event = { name: "worker", type: "message_update", updateType: "text_delta", delta: "secret body" };
	publishSupervisorEvent(bus, "root.worker", event);
	assert.deepEqual(seen, []);
	publishSupervisorEvent(bus, "root.worker", event, { includeTextDelta: true });
	assert.deepEqual(seen.map(({ nodeId, data }) => ({ nodeId, data })), [
		{ nodeId: "root.worker", data: { delta: "secret body" } },
	]);
});

test("session runtime paints injected machine facts and applies in-process Legion events", () => {
	const bus = createLegionEventBus();
	const nodes = [makeNode("root", null, "root", 0)];
	let factory: ((tui: { requestRender(): void }, theme: { fg(color: string, text: string): string }) => { render(width?: number): string[] }) | undefined;
	const runtime = createSessionRuntime({
		sendMessage() {},
		eventBus: bus,
		getTreeNodes: () => nodes,
		now: () => NOW,
	});
	runtime.bind({
		hasUI: true,
		ui: {
			theme: { fg: (_color, text) => text },
			setStatus() {},
			setWidget(_key, content) {
				if (typeof content === "function") factory = content;
			},
		},
	});
	try {
		assert.equal(typeof factory, "function");
		assert.match(factory!({ requestRender() {} }, { fg: (_color, text) => text }).render().join("\n"), /root/);
		bus.emit({ nodeId: "root", type: "phase_change", data: { from: "planning", to: "done" }, ts: NOW });
		const rendered = factory!({ requestRender() {} }, { fg: (_color, text) => text }).render().join("\n");
		assert.match(rendered, /done\/running/);
		assert.match(rendered, /Legion · 1 agents · 1 running/);
	} finally {
		runtime.dispose();
	}
});
