import { test } from "node:test";
import assert from "node:assert/strict";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { FakeSupervisor } from "../helpers/fake-supervisor.ts";
import { LegionPostman } from "../../src/extension/legion-tools.ts";
import piLegion from "../../index.ts";
import { LEGION_DB_ENV, LEGION_NODE_ID_ENV } from "../../src/runs/args.ts";
import { createLegionEventBus } from "../../src/extension/event-bus.ts";
import { createSessionRuntime } from "../../src/extension/runtime.ts";
import { legionDbPath, openLegionDb } from "../../src/legion/db.ts";
import { readEventsAfter } from "../../src/legion/events.ts";
import { inbox, MAIL_DELIVERY, sendMail } from "../../src/legion/mail.ts";
import { getNode, insertNode } from "../../src/legion/nodes.ts";
import { appendEvent } from "../../src/legion/events.ts";
import { getUsage } from "../../src/legion/usage.ts";
import { liveRateNodeIds } from "../../src/tui/viz/rate.ts";
import { Orchestrator } from "../../src/runs/orchestrator.ts";
import { RunStore } from "../../src/runs/store.ts";
import { ErrorCodes, SubagentError, type AgentConfig } from "../../src/shared/types.ts";
import { assistantMsg, sessionHeader, toolResult, userMsg } from "../helpers/fixtures.ts";

import { stripTerminalSequences, type Component, type OverlayHandle } from "@earendil-works/pi-tui";
import type { LegionEvent } from "../../src/extension/event-bus.ts";
import {
	createStatusNodeOpener,
	publishSupervisorEvent,
	publishUIRequest,
	registerLegionCommand,
	type RpcEventSource,
} from "../../src/extension/legion-commands.ts";
import { resolveModalOverlayOptions, type LiveOverlayComponent } from "../../src/tui/live-overlay.ts";
import type { TreeNodeSnapshot, TreeViewComponent } from "../../src/tui/tree-view.ts";
import type { SupervisorEvent } from "../../src/supervisor/types.ts";

// Unit tests run without Pi's host process, which normally initializes the theme.
initTheme("dark");

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

/**
 * Role pinned to the RPC backend.
 *
 * Legion ledger budgets (`maxChildrenPerNode`, `maxActiveNodes`, `maxDepth`) are
 * RPC-side gates: in-process children are budgeted by `subagents.inprocess.*`
 * only, so they deliberately bypass the ledger table. Since the default spawn
 * mode is `inprocess`, any test that asserts an RPC ledger gate must pin
 * `spawnMode: "rpc"` explicitly — otherwise it silently tests nothing.
 */
function rpcAgent(name = "worker", overrides: Partial<AgentConfig> = {}): AgentConfig {
	return agent(name, { spawnMode: "rpc", ...overrides });
}

function fixture(options: { maxActiveNodes?: number; maxChildrenPerNode?: number } = {}) {
	const rootDir = mkdtempSync(path.join(tmpdir(), "legion-orchestrator-"));
	const runStore = new RunStore({ rootDir: path.join(rootDir, ".pi-subagents") });
	const rootRun = runStore.createRun({ task: "root task", cwd: rootDir, nodeId: "root", maxDepth: 4, herdr: { supervisor: "rpc" } });
	const db = openLegionDb(":memory:");
	insertNode(db, { id: "root", parentId: null, name: "root", role: "root", runId: rootRun.runId, status: "running" });
	const settings = { maxDepth: 4, maxChildrenPerNode: options.maxChildrenPerNode ?? 8, maxActiveNodes: options.maxActiveNodes ?? 30 };
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
		piLegion(pi as never, { supervisor });
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
	const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
	const supervisor = new FakeSupervisor({ immediateTimeout: false });
	const pi = {
		registerTool(tool: unknown) { const typed = tool as { name: string; execute: (...args: unknown[]) => Promise<{ content?: Array<{ text?: string }>; details?: unknown }> }; tools.set(typed.name, typed); },
		registerCommand(name: string, command: { handler: (args: string, ctx: unknown) => Promise<void> }) { commands.set(name, command); },
		getSettings() { return {}; },
		registerMessageRenderer() {}, sendMessage() {},
		events: { emit() {} },
		on(name: string, handler: (...args: unknown[]) => unknown) { handlers.set(name, handler); },
	};
	try {
		process.env.PI_CODING_AGENT_DIR = agentDir;
		process.env.PI_HERDR_SUBAGENTS_EXTRA_AGENT_DIRS = extraAgentsDir;
		for (const key of ["PI_SUBAGENT_CHILD", "PI_SUBAGENT_ALLOW_NESTED", LEGION_DB_ENV, LEGION_NODE_ID_ENV, "PI_SUBAGENTS_TEAM"]) delete process.env[key];
		piLegion(pi as never, { supervisor });
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
		assert.ok(commands.has("legion"), "the extension registers its full-screen Legion command");
		const liveUi = new FakeCommandUi();
		await commands.get("legion")!.handler("worker-0", { hasUI: true, mode: "tui", cwd, ui: liveUi });
		const liveOverlay = liveUi.calls[0]?.component as (Component & {
			getState(): { activity: readonly string[] };
		}) | undefined;
		assert.ok(liveOverlay);
		assert.equal(liveUi.calls[0]?.options?.overlay, true);
		supervisor.requestUI("worker-0", {
			type: "extension_ui_request",
			id: "ui-request-0",
			method: "notify",
			message: "approval notification",
		});
		assert.deepEqual(liveOverlay.getState().activity, [
			"▸ Task: create the first Legion tree",
			"",
			"## Frozen child constraints (injected by pi-legion)",
			"- Do not spawn nested agents.",
			'- End with machine-readable JSON on its own: {"ok": true|false, "reason": "..."}.',
			"",
			"· ui_request",
		], "extension UI requests are visible through the shared event bus after session history");
		supervisor.settle("worker-0", { text: "done" });
		assert.deepEqual(liveOverlay.getState().activity, [
			"▸ Task: create the first Legion tree",
			"",
			"## Frozen child constraints (injected by pi-legion)",
			"- Do not spawn nested agents.",
			'- End with machine-readable JSON on its own: {"ok": true|false, "reason": "..."}.',
			"",
			"· ui_request",
			"✓ agent turn settled",
		], "index wiring forwards RPC observation events over the extension-lifetime Legion bus");
		liveOverlay.handleInput?.("\u001b");
		await liveUi.calls[0]!.promise;

		const db = openLegionDb(dbPath);
		try {
			assert.equal(getNode(db, "root")?.runId, rootRun.runId);
			assert.equal(getNode(db, "root.worker-0")?.runId, childRun.runId);
			const persistedTypes = readEventsAfter(db, 0).map((event) => String(event.type));
			assert.ok(!persistedTypes.includes("agent_settled"));
			assert.ok(!persistedTypes.includes("ui_request"));
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
		piLegion(childPi as never, { supervisor: new FakeSupervisor() });
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
		assert.ok(orphanMessages.some((message) => message.includes("Legion orphan detected") && message.includes(": root.centurion")));
		assert.ok(readEventsAfter(db, 0).some((event) => event.nodeId === "root.centurion" && event.type === "orphan_detected"));
		rootPostman.stop();
		process.env.PI_CODING_AGENT_DIR = agentDir;
		process.env.PI_HERDR_SUBAGENTS_EXTRA_AGENT_DIRS = extraAgentsDir;
		process.env.PI_SUBAGENT_CHILD = "1";
		process.env.PI_SUBAGENT_ALLOW_NESTED = "1";
		process.env[LEGION_DB_ENV] = path.resolve(dbPath);
		process.env[LEGION_NODE_ID_ENV] = "root.centurion";
		piLegion(pi as never, { supervisor });
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

test("retire frees maxChildrenPerNode slots so launch can refill to the cap (#142)", async () => {
	const fx = fixture({ maxChildrenPerNode: 2 });
	const supervisor = new FakeSupervisor({ immediateTimeout: false });
	const orchestrator = new Orchestrator({
		supervisor,
		runDir: fx.runStore.runDir(fx.rootRun.runId),
		cwd: fx.rootDir,
		maxDepth: 4,
		legion: fx.context,
	});
	try {
		const first = await orchestrator.launch({ agent: rpcAgent("worker"), task: "slot-1", name: "slot-1", worktree: false });
		const second = await orchestrator.launch({ agent: rpcAgent("worker"), task: "slot-2", name: "slot-2", worktree: false });
		assert.equal(getNode(fx.db, first.child.nodeId!)?.status, "running");
		assert.equal(getNode(fx.db, second.child.nodeId!)?.status, "running");
		await assert.rejects(
			() => orchestrator.launch({ agent: rpcAgent("worker"), task: "over fanout", name: "slot-3", worktree: false }),
			(error: unknown) =>
				error instanceof SubagentError &&
				error.code === ErrorCodes.BUDGET_EXCEEDED &&
				/max_children_per_node/.test(error.message),
		);
		await orchestrator.retire(first.name);
		await orchestrator.retire(second.name);
		// Already-retired no-op must leave slots free (session kept for resume).
		await orchestrator.retire(first.name);
		assert.equal(getNode(fx.db, first.child.nodeId!)?.status, "retired");
		assert.equal(existsSync(first.sessionFile), true, "retire keeps session for resume");
		const third = await orchestrator.launch({ agent: rpcAgent("worker"), task: "reuse slot", name: "slot-3", worktree: false });
		const fourth = await orchestrator.launch({ agent: rpcAgent("worker"), task: "reuse slot again", name: "slot-4", worktree: false });
		assert.equal(third.child.nodeId, "root.slot-3");
		assert.equal(fourth.child.nodeId, "root.slot-4");
		await assert.rejects(
			() => orchestrator.launch({ agent: rpcAgent("worker"), task: "cap again", name: "slot-5", worktree: false }),
			(error: unknown) => error instanceof SubagentError && error.code === ErrorCodes.BUDGET_EXCEEDED,
		);
	} finally {
		fx.cleanup();
	}
});


test("resume cannot exceed maxChildrenPerNode — no Math.max relaxation (#180)", async () => {
	const fx = fixture({ maxChildrenPerNode: 8 });
	const supervisor = new FakeSupervisor({ immediateTimeout: false });
	const orchestrator = new Orchestrator({
		supervisor,
		runDir: fx.runStore.runDir(fx.rootRun.runId),
		cwd: fx.rootDir,
		maxDepth: 4,
		legion: fx.context,
	});
	const live = () =>
		Number(
			fx.db
				.prepare("SELECT COUNT(*) AS c FROM nodes WHERE parent_id = 'root' AND status IN ('starting','running','blocked')")
				.get()?.c ?? 0,
		);
	try {
		const names: string[] = [];
		for (let i = 0; i < 8; i += 1) {
			const handle = await orchestrator.launch({
				agent: rpcAgent("worker"),
				task: `slot-${i}`,
				name: `worker-${i}`,
				worktree: false,
			});
			names.push(handle.name);
		}
		assert.equal(live(), 8);
		await assert.rejects(
			() => orchestrator.launch({ agent: rpcAgent("worker"), task: "fresh-9", name: "worker-9", worktree: false }),
			(error: unknown) =>
				error instanceof SubagentError &&
				error.code === ErrorCodes.BUDGET_EXCEEDED &&
				/max_children_per_node/.test(error.message),
			"9th fresh launch must still be denied",
		);
		await orchestrator.retire(names[0]!);
		assert.equal(live(), 7, "retire frees a slot");
		// Legit refill back to the cap.
		await orchestrator.launch({ agent: rpcAgent("worker"), task: "refill", name: "worker-9", worktree: false });
		assert.equal(live(), 8);
		// Resume of the retired node must NOT inflate past the cap (#180).
		await assert.rejects(
			() =>
				orchestrator.launch({
					agent: rpcAgent("worker"),
					task: "resume-retired",
					name: names[0]!,
					worktree: false,
				}),
			(error: unknown) =>
				error instanceof SubagentError &&
				error.code === ErrorCodes.BUDGET_EXCEEDED &&
				/max_children_per_node/.test(error.message),
			"resume at cap must be denied — must not create a 9th live child",
		);
		assert.equal(live(), 8, "live children stay at the cap after denied resume");
		// Below-cap resume still works.
		await orchestrator.retire(names[1]!);
		assert.equal(live(), 7);
		const resumed = await orchestrator.launch({
			agent: rpcAgent("worker"),
			task: "legit-resume",
			name: names[1]!,
			worktree: false,
		});
		assert.equal(resumed.name, names[1]);
		assert.equal(live(), 8);
	} finally {
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
			() => orchestrator.launch({ agent: rpcAgent(), task: "over active budget", worktree: false }),
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
	options?: {
		overlay?: boolean;
		overlayOptions?: () => { width: number; minWidth: number; maxHeight: number; anchor: string };
		onHandle?: (handle: OverlayHandle) => void;
	};
	promise: Promise<unknown>;
}

class FakeCommandUi {
	readonly calls: OpenCustomCall[] = [];
	readonly notifications: Array<{ message: string; level: string }> = [];
	customMode: "normal" | "reject" | "throwSynchronously" | "invokeFactorySynchronously" = "normal";
	readonly theme = { fg: (_color: string, text: string) => text };
	readonly tui = { requestRender() {}, terminal: { rows: 8 } };

	custom<T>(
		factory: (
			tui: never,
			theme: never,
			keybindings: never,
			done: (result: T) => void,
		) => Component | Promise<Component>,
		options?: {
			overlay?: boolean;
			overlayOptions?: () => { width: number; minWidth: number; maxHeight: number; anchor: string };
			onHandle?: (handle: OverlayHandle) => void;
		},
	): Promise<T> {
		if (this.customMode === "throwSynchronously") throw new Error("custom threw synchronously");
		let resolve!: (value: T) => void;
		let reject!: (error: unknown) => void;
		const promise = new Promise<T>((resolvePromise, rejectPromise) => {
			resolve = resolvePromise;
			reject = rejectPromise;
		});
		const call: OpenCustomCall = { options, promise };
		this.calls.push(call);
		if (this.customMode === "reject") {
			reject(new Error("custom rejected"));
			return promise;
		}
		if (this.customMode === "invokeFactorySynchronously") {
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
			return promise;
		}
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

function commandHarness(
	nodes: TreeNodeSnapshot[] = treeNodes,
	jobs = nodes
		.filter((node) => node.parentId !== null)
		.map((node) => ({ name: node.name, nodeId: node.id, state: "working" })),
) {
	const bus = createLegionEventBus();
	const rpc = new FakeRpcEvents();
	const ui = new FakeCommandUi();
	const runtime = {
		activeJobs: () => jobs,
		treeNodes: () => nodes.map((node) => ({ ...node })),
	};
	type RegisteredLegionCommand = {
		handler: (args: string, ctx: unknown) => Promise<void>;
		getArgumentCompletions?: (prefix: string) => Array<{ value: string; label: string }> | null;
	};
	let command: RegisteredLegionCommand | undefined;
	const pi = {
		registerCommand(name: string, value: RegisteredLegionCommand) {
			if (name === "legion") command = value;
		},
		getSettings() { return {}; },
	};
	const controller = registerLegionCommand(pi as never, { bus, runtime, supervisor: rpc });
	const ctx = { hasUI: true, mode: "tui", cwd: "/tmp", ui };
	return {
		bus,
		rpc,
		ui,
		runtime,
		controller,
		handler: (args: string, context: unknown) => command!.handler(args, context),
		completions: (prefix: string) => command?.getArgumentCompletions?.(prefix) ?? null,
		ctx,
	};
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
	assert.deepEqual(harness.ui.calls[1]?.options?.overlayOptions, resolveModalOverlayOptions());
	assert.deepEqual(harness.rpc.subscriptions.map(({ name, options }) => ({ name, options })), [
		{ name: "worker", options: { includeTextDelta: true } },
	]);
	harness.bus.emit({ nodeId: "root.worker", id: 40, type: "phase_change", data: { from: "planning", to: "implementing" }, ts: NOW });
	assert.match(stripTerminalSequences(tree.render(80).join("\n")), /implementing/);

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
	assert.deepEqual(overlay.getState().activity, ["· phase_change", "worker output"]);
	assert.equal(overlay.getState().open, true);

	overlay.handleInput?.("\u001b");
	await harness.ui.calls[1]!.promise;
	assert.equal(harness.rpc.unsubscribeCount, 1, "closing unsubscribes the one selected child RPC feed");
	tree.handleInput?.("q");
	await treeOpen;
	assert.equal(tree.getState().visibleIds.length > 0, true);
	assert.equal(harness.rpc.subscriptions.length, 0);
});

test("status widget opener shares the live overlay controller and safely ignores duplicate or unavailable opens", async () => {
	const harness = commandHarness();
	let ui: unknown = harness.ctx.ui;
	let cwd: string | undefined = "/tmp";
	const opener = createStatusNodeOpener(
		{ getSettings() { return {}; } } as never,
		harness.controller,
		() => ui as never,
		() => cwd,
	);

	opener("root.worker");
	opener("root.worker");
	await Promise.resolve();
	assert.equal(harness.ui.calls.length, 1, "the same open node is not remounted or flashed");
	assert.equal(harness.controller.getCurrent()?.nodeId, "root.worker");

	ui = undefined;
	opener("root.other");
	assert.equal(harness.ui.calls.length, 1, "no UI is a safe no-op");
	ui = harness.ctx.ui;
	cwd = undefined;
	opener("root.other");
	assert.equal(harness.ui.calls.length, 1, "no cwd is a safe no-op");

	cwd = "/tmp";
	await harness.handler("other", harness.ctx);
	assert.equal(harness.ui.calls.length, 2, "/legion and the widget use the same overlay controller");
	assert.equal(harness.controller.getCurrent()?.nodeId, "root.other");
	const overlay = harness.ui.calls[1]?.component as Component | undefined;
	assert.ok(overlay);
	overlay.handleInput?.("\u001b");
	await harness.ui.calls[1]!.promise;
	await harness.ui.calls[0]!.promise;
	assert.equal(harness.controller.getCurrent(), undefined);
});

test("status widget opener closes and reports rejected or synchronously throwing UI opens", async () => {
	for (const mode of ["reject", "throwSynchronously", "invokeFactorySynchronously", "settingsSynchronously"] as const) {
		const harness = commandHarness();
		let failSettings = false;
		const opener = createStatusNodeOpener(
			{
				getSettings() {
					if (failSettings) throw new Error("getSettings threw synchronously");
					return {};
				},
			} as never,
			harness.controller,
			() => harness.ctx.ui as never,
			() => "/tmp",
		);
		opener("root.worker");
		await Promise.resolve();
		assert.equal(harness.controller.getCurrent()?.nodeId, "root.worker", `${mode}: setup opens an existing node`);

		if (mode !== "settingsSynchronously") harness.ui.customMode = mode;
		if (mode === "invokeFactorySynchronously") {
			harness.controller.open = (() => {
				throw new Error("factory threw synchronously");
			}) as typeof harness.controller.open;
		}
		failSettings = mode === "settingsSynchronously";
		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
		process.on("unhandledRejection", onUnhandled);
		try {
			opener("root.other");
			await new Promise<void>((resolve) => setImmediate(resolve));
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}

		assert.equal(harness.controller.getCurrent(), undefined, `${mode}: current node is closed`);
		assert.equal(harness.ui.notifications.length, 1, `${mode}: UI receives an error notification`);
		assert.match(harness.ui.notifications[0]?.message ?? "", /^Unable to open Legion activity:/);
		assert.equal(harness.ui.notifications[0]?.level, "error");
		assert.deepEqual(unhandled, [], `${mode}: no unhandled promise rejection`);
	}
});

test("/legion <name> opens the selected floating overlay and Esc unsubscribes only that node", async () => {
	const harness = commandHarness();
	await harness.handler("worker", harness.ctx);
	assert.equal(harness.ui.calls.length, 1);
	assert.equal(harness.ui.calls[0]?.options?.overlay, true);
	// #193: the modal must be mounted over the frame rect only, never full-screen,
	// or pi-tui wipes every host cell (no transparency) and the underlay goes black.
	// Percentages, so the rect is re-derived from the live terminal on resize.
	assert.deepEqual(harness.ui.calls[0]?.options?.overlayOptions, resolveModalOverlayOptions());
	assert.notDeepEqual(harness.ui.calls[0]?.options?.overlayOptions, { width: "100%", maxHeight: "100%" });
	assert.deepEqual(harness.rpc.subscriptions.map((subscription) => subscription.name), ["worker"]);
	const overlay = harness.ui.calls[0]?.component as Component | undefined;
	assert.ok(overlay);
	overlay.handleInput?.("\u001b");
	await harness.ui.calls[0]!.promise;
	assert.equal(harness.rpc.unsubscribeCount, 1);
	assert.equal(harness.rpc.subscriptions.length, 0);
});

test("/legion backfills session history, polls stopped nodes for appends, then stops polling on close", async () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "legion-overlay-history-"));
	const sessionFile = path.join(cwd, "worker.jsonl");
	writeFileSync(sessionFile, [
		sessionHeader({ cwd }),
		userMsg("oldest request"),
		assistantMsg({ text: "oldest response" }),
		userMsg("first request"),
		assistantMsg({ text: "first response", tools: ["read"] }),
		userMsg("second request"),
		assistantMsg({ text: "second response" }),
		userMsg("third request"),
		assistantMsg({ text: "third response" }),
	].join("\n") + "\n");
	const nodes = [
		makeNode("root", null, "root", 0),
		{ ...makeNode("root.worker", "root", "worker", 1, "settled"), sessionFile },
	];
	const harness = commandHarness(nodes, []);
	let overlay: LiveOverlayComponent | undefined;
	try {
		await harness.handler("worker", harness.ctx);
		overlay = harness.ui.calls[0]?.component as LiveOverlayComponent | undefined;
		assert.ok(overlay);
		const state = overlay;
		assert.deepEqual(state.getState().activity, [
			"▸ oldest request",
			"oldest response",
			"▸ first request",
			"first response",
			"⚙ read",
			"▸ second request",
			"second response",
			"▸ third request",
			"third response",
		], "opening the viewer renders the complete session transcript");
		assert.equal(state.getState().itemCount, 9);

		appendFileSync(sessionFile, [userMsg("fourth request"), assistantMsg({ text: "fourth response", tools: ["write"] })].join("\n") + "\n");
		const pollDeadline = Date.now() + 1_500;
		while (state.getState().activity.at(-1) !== "⚙ write" && Date.now() < pollDeadline) {
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
		assert.deepEqual(state.getState().activity, [
			"▸ oldest request",
			"oldest response",
			"▸ first request",
			"first response",
			"⚙ read",
			"▸ second request",
			"second response",
			"▸ third request",
			"third response",
			"▸ fourth request",
			"fourth response",
			"⚙ write",
		]);

		state.close();
		await harness.ui.calls[0]!.promise;
		appendFileSync(sessionFile, [userMsg("after close"), assistantMsg({ text: "should not appear" })].join("\n") + "\n");
		await new Promise((resolve) => setTimeout(resolve, 300));
		assert.deepEqual(state.getState().activity, [
			"▸ oldest request",
			"oldest response",
			"▸ first request",
			"first response",
			"⚙ read",
			"▸ second request",
			"second response",
			"▸ third request",
			"third response",
			"▸ fourth request",
			"fourth response",
			"⚙ write",
		], "closed overlays do not continue polling the session file");
	} finally {
		overlay?.dispose();
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("/legion backfill emits a same-turn assistant append once, without re-emitting the turn", async () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "legion-overlay-same-turn-"));
	const sessionFile = path.join(cwd, "worker.jsonl");
	writeFileSync(sessionFile, [
		sessionHeader({ cwd }),
		userMsg("draft the fix"),
		assistantMsg({ text: "investigating", tools: ["read"], stopReason: "toolUse" }),
		toolResult({ toolName: "read" }),
	].join("\n") + "\n");
	const nodes = [
		makeNode("root", null, "root", 0),
		{ ...makeNode("root.worker", "root", "worker", 1, "settled"), sessionFile },
	];
	const harness = commandHarness(nodes, []);
	let overlay: LiveOverlayComponent | undefined;
	try {
		await harness.handler("worker", harness.ctx);
		overlay = harness.ui.calls[0]?.component as LiveOverlayComponent | undefined;
		assert.ok(overlay);
		const state = overlay;
		assert.deepEqual(state.getState().activity, ["▸ draft the fix", "investigating", "⚙ read"]);
		assert.equal(state.getState().itemCount, 3);

		// Same turn: turnCount stays at 1; only assistantMessageCount advances from 1 to 2.
		appendFileSync(sessionFile, assistantMsg({ text: "final answer" }) + "\n");
		const pollDeadline = Date.now() + 1_500;
		while (state.getState().activity.at(-1) !== "final answer" && Date.now() < pollDeadline) {
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
		assert.deepEqual(state.getState().activity, ["▸ draft the fix", "investigating", "⚙ read", "final answer"]);

		state.close();
		await harness.ui.calls[0]!.promise;
	} finally {
		overlay?.dispose();
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("/legion active text-delta sessions render session-file messages as they land", async () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "legion-overlay-active-"));
	const sessionFile = path.join(cwd, "worker.jsonl");
	writeFileSync(sessionFile, [sessionHeader({ cwd }), userMsg("existing request"), assistantMsg({ text: "existing response" })].join("\n") + "\n");
	const nodes = [
		makeNode("root", null, "root", 0),
		{ ...makeNode("root.worker", "root", "worker", 1), sessionFile },
	];
	const harness = commandHarness(nodes, [{ name: "worker", nodeId: "root.worker", state: "working" }]);
	let overlay: LiveOverlayComponent | undefined;
	try {
		await harness.handler("worker", harness.ctx);
		overlay = harness.ui.calls[0]?.component as LiveOverlayComponent | undefined;
		assert.ok(overlay);
		const state = overlay;
		const history = ["▸ existing request", "existing response"];
		assert.deepEqual(state.getState().activity, history);
		assert.equal(state.getState().itemCount, 2);
		assert.deepEqual(harness.rpc.subscriptions.map(({ name, options }) => ({ name, options })), [
			{ name: "worker", options: { includeTextDelta: true } },
		]);

		harness.rpc.emit("worker", {
			name: "worker",
			type: "message_update",
			updateType: "text_delta",
			delta: "RPC-owned reply",
		});
		assert.equal(state.getState().streamingText, "RPC-owned reply");
		appendFileSync(sessionFile, [userMsg("RPC-owned request"), assistantMsg({ text: "RPC-owned reply" })].join("\n") + "\n");
		await new Promise((resolve) => setTimeout(resolve, 350));

		const rendered = state.getState().text;
		assert.match(rendered, /RPC-owned request/, "session-file user messages appear on the active polling interval");
		assert.equal(rendered.split("RPC-owned reply").length - 1, 1, "the disk assistant replaces its streamed duplicate");
		assert.equal(state.getState().streamingText, "");

		state.close();
		await harness.ui.calls[0]!.promise;
		appendFileSync(sessionFile, [userMsg("after close"), assistantMsg({ text: "should not appear" })].join("\n") + "\n");
		await new Promise((resolve) => setTimeout(resolve, 350));
		assert.doesNotMatch(state.getState().text, /after close/, "closed viewers stop polling session-file changes");
	} finally {
		overlay?.handleInput?.("\u001b");
		if (harness.ui.calls[0]) await harness.ui.calls[0].promise;
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("/legion shows a prompt for an empty Legion tree", async () => {
	const harness = commandHarness([]);
	const treeOpen = harness.handler("", harness.ctx);
	await Promise.resolve();
	const tree = harness.ui.calls[0]?.component as TreeViewComponent | undefined;
	assert.ok(tree);
	assert.match(stripTerminalSequences(tree.render(80).join("\n")), /No Legion nodes yet\./);
	tree.handleInput?.("q");
	await treeOpen;
});

test("/legion component mouse clicks open a node overlay while OSC 8 remains a visual anchor", async () => {
	const harness = commandHarness();
	const treeOpen = harness.handler("", harness.ctx);
	await Promise.resolve();
	const tree = harness.ui.calls[0]?.component as TreeViewComponent | undefined;
	assert.ok(tree);
	const lines = tree.render(80);
	const workerRow = lines.findIndex((line) => stripTerminalSequences(line).includes("● worker (worker)"));
	assert.ok(workerRow > 0);
	assert.match(lines.join("\n"), /pi-legion:\/\/node\/root.worker/);
	tree.handleMouse?.({
		type: "click",
		button: "left",
		x: 1,
		y: workerRow,
		screenX: 1,
		screenY: workerRow,
		width: 80,
		height: 8,
		shift: false,
		alt: false,
		ctrl: false,
	});
	await Promise.resolve();
	assert.equal(tree.getState().selectedId, "root.worker");
	assert.equal(harness.ui.calls[1]?.options?.overlay, true);
	assert.deepEqual(harness.rpc.subscriptions.map(({ name }) => name), ["worker"]);
	const overlay = harness.ui.calls[1]?.component as Component | undefined;
	assert.ok(overlay);
	overlay.handleInput?.("\u001b");
	await harness.ui.calls[1]!.promise;
	tree.handleInput?.("q");
	await treeOpen;
	assert.equal(harness.rpc.subscriptions.length, 0);
});

test("/legion tree preserves settled and failed outcomes when processes are retired", async () => {
	for (const status of ["settled", "failed"] as const) {
		const nodes = [
			makeNode("root", null, "root", 0),
			makeNode("root.worker", "root", "worker", 1, status),
		];
		const harness = commandHarness(nodes);
		const treeOpen = harness.handler("", harness.ctx);
		await Promise.resolve();
		harness.bus.emit({ nodeId: "root.worker", type: "node_retired", data: null, ts: NOW });
		const rendered = stripTerminalSequences((harness.ui.calls[0]?.component as TreeViewComponent).render(80).join("\n"));
		assert.match(rendered, new RegExp(status));
		assert.doesNotMatch(rendered, /retired/);
		(harness.ui.calls[0]?.component as TreeViewComponent).handleInput?.("q");
		await treeOpen;
	}
});

test("live overlay deduplicates matching stored and process-domain lifecycle events", async () => {
	const harness = commandHarness();
	await harness.handler("worker", harness.ctx);
	const overlay = harness.ui.calls[0]?.component as (Component & {
		getState(): { activity: readonly string[] };
	}) | undefined;
	assert.ok(overlay);
	harness.bus.emit({ nodeId: "root.worker", id: 41, type: "node_launched", data: { runId: "worker-run" }, ts: NOW });
	harness.bus.emit({ nodeId: "root.worker", id: 41, type: "node_launched", data: { runId: "worker-run" }, ts: NOW });
	harness.bus.emit({ nodeId: "root.worker", type: "node_launched", data: { name: "worker" }, ts: NOW + 1 });
	assert.deepEqual(overlay.getState().activity, ["· node_launched"]);
	harness.bus.emit({ nodeId: "root.worker", id: 42, type: "node_retired", data: { execution: "success" }, ts: NOW + 10 });
	harness.bus.emit({ nodeId: "root.worker", type: "node_retired", data: { name: "worker" }, ts: NOW + 11 });
	assert.deepEqual(overlay.getState().activity, ["· node_launched", "· node_retired"], "stored and process retire outcomes produce one activity line");
	harness.bus.emit({ nodeId: "root.worker", type: "node_retired", data: { name: "worker" }, ts: NOW + 12 });
	assert.deepEqual(overlay.getState().activity, ["· node_launched", "· node_retired", "· node_retired"], "a separate process-only event is not swallowed with its already paired stored event");
	harness.bus.emit({ nodeId: "root.worker", type: "turn_start", data: null, ts: NOW + 13 });
	assert.deepEqual(overlay.getState().activity, ["· node_launched", "· node_retired", "· node_retired", "↻ turn 1"], "process-only fine-grained activity remains visible alongside deduplicated stored lifecycle events");
	overlay.handleInput?.("\u001b");
	await harness.ui.calls[0]!.promise;
});

test("/legion rejects ambiguous short names and completion values disambiguate by node id", async () => {
	const nodes = [
		makeNode("root", null, "root", 0),
		makeNode("root.alpha", "root", "alpha", 1),
		makeNode("root.alpha.worker", "root.alpha", "worker", 2),
		makeNode("root.beta", "root", "beta", 1),
		makeNode("root.beta.worker", "root.beta", "worker", 2),
	];
	const harness = commandHarness(nodes);
	await harness.handler("worker", harness.ctx);
	assert.equal(harness.ui.calls.length, 0);
	assert.match(harness.ui.notifications[0]?.message ?? "", /ambiguous/);
	assert.deepEqual(harness.completions("worker"), [
		{ value: "root.alpha.worker", label: "worker (root.alpha.worker)" },
		{ value: "root.beta.worker", label: "worker (root.beta.worker)" },
	]);
});

test("/legion does not subscribe a nested node overlay to a same-named direct child RPC stream", async () => {
	const nodes = [
		makeNode("root", null, "root", 0),
		makeNode("root.worker", "root", "worker", 1),
		makeNode("root.centurion", "root", "centurion", 1),
		makeNode("root.centurion.worker", "root.centurion", "worker", 2),
	];
	const harness = commandHarness(nodes, [
		{ name: "worker", nodeId: "root.worker", state: "working" },
		{ name: "centurion", nodeId: "root.centurion", state: "working" },
	]);
	await harness.handler("root.centurion.worker", harness.ctx);
	assert.equal(harness.ui.calls[0]?.options?.overlay, true);
	assert.deepEqual(harness.rpc.subscriptions, []);
	const overlay = harness.ui.calls[0]?.component as Component | undefined;
	assert.ok(overlay);
	overlay.handleInput?.("\u001b");
	await harness.ui.calls[0]!.promise;
});

test("publishUIRequest exposes request method on the process-domain event bus", () => {
	const bus = createLegionEventBus();
	const seen: LegionEvent[] = [];
	bus.on("ui_request", (event) => seen.push(event));
	publishUIRequest(bus, "root.worker", "notify");
	assert.deepEqual(seen.map(({ nodeId, type, data }) => ({ nodeId, type, data })), [
		{ nodeId: "root.worker", type: "ui_request", data: { method: "notify" } },
	]);
});

test("M2 orchestrator emits process-domain lifecycle events on the shared event bus", async () => {
	const fx = fixture();
	const supervisor = new FakeSupervisor({ immediateTimeout: false });
	const events: LegionEvent[] = [];
	for (const type of ["node_launched", "node_steered", "node_aborted", "node_retired"] as const) {
		fx.context.eventBus.on(type, (event) => {
			if (event.id === undefined) events.push(event);
		});
	}
	const orchestrator = new Orchestrator({
		supervisor,
		runDir: fx.runStore.runDir(fx.rootRun.runId),
		cwd: fx.rootDir,
		maxDepth: 4,
		legion: fx.context,
	});
	try {
		const handle = await orchestrator.launch({ agent: agent(), task: "exercise process facts", worktree: false });
		assert.equal(handle.child.nodeId, "root.worker-0");
		await orchestrator.steer(handle.name, "change course");
		await orchestrator.abort(handle.name);
		await orchestrator.retire(handle.name);
		assert.deepEqual(events.map(({ type, nodeId }) => ({ type, nodeId })), [
			{ type: "node_launched", nodeId: "root.worker-0" },
			{ type: "node_steered", nodeId: "root.worker-0" },
			{ type: "node_aborted", nodeId: "root.worker-0" },
			{ type: "node_retired", nodeId: "root.worker-0" },
		]);
	} finally {
		fx.cleanup();
	}
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

test("active Legion overlay consumes process-only lifecycle feed beside stored outcomes", async () => {
	const fx = fixture();
	const supervisor = new FakeSupervisor({ immediateTimeout: false });
	let activeSubscription: { listener: (event: SupervisorEvent) => void; options?: { includeTextDelta?: boolean } } | undefined;
	let stopCoarse: (() => void) | undefined;
	const runtime = {
		activeJobs: () => [{ name: "worker-0", nodeId: "root.worker-0", state: "working" }],
		treeNodes: () => [makeNode("root", null, "root", 0), makeNode("root.worker-0", "root", "worker-0", 1)],
	};
	const pi = {
		registerCommand(_name: string, command: { handler: (args: string, ctx: unknown) => Promise<void> }) {
			commandHandler = command.handler;
		},
		getSettings() { return {}; },
	};
	let commandHandler: ((args: string, ctx: unknown) => Promise<void>) | undefined;
	registerLegionCommand(pi as never, {
		bus: fx.context.eventBus,
		runtime,
		supervisor: {
			onEvent(_name, listener, options) {
				activeSubscription = { listener, ...(options ? { options } : {}) };
				return () => { activeSubscription = undefined; };
			},
		},
	});
	const ui = new FakeCommandUi();
	try {
		await commandHandler!("worker-0", { hasUI: true, mode: "tui", cwd: fx.rootDir, ui });
		const overlay = ui.calls[0]?.component as (Component & { getState(): { activity: readonly string[] } }) | undefined;
		assert.ok(overlay);
		assert.deepEqual(activeSubscription?.options, { includeTextDelta: true });
		fx.context.eventBus.emit({ nodeId: "root.worker-0", id: 5, type: "node_launched", data: null, ts: NOW });
		fx.context.eventBus.emit({ nodeId: "root.worker-0", type: "node_launched", data: { name: "worker-0" }, ts: NOW + 1 });
		assert.deepEqual(overlay.getState().activity, ["· node_launched"], "the process lifecycle twin is deduplicated against its stored event");
		const rpcLaunch = await supervisor.spawnChild({
			name: "worker-0",
			task: "active worker",
			agent: agent(),
			sessionFile: path.join(fx.rootDir, "worker.jsonl"),
			tempDir: fx.rootDir,
			cwd: fx.rootDir,
		});
		assert.equal(rpcLaunch.name, "worker-0");
		stopCoarse = supervisor.onEvent("worker-0", (event) => publishSupervisorEvent(fx.context.eventBus, "root.worker-0", event));
		supervisor.settle("worker-0", { text: "turn complete" });
		assert.deepEqual(overlay.getState().activity, ["· node_launched", "✓ agent turn settled"]);
		activeSubscription?.listener({ name: "worker-0", type: "message_update", updateType: "text_delta", delta: "visible output" });
		assert.deepEqual(overlay.getState().activity, ["· node_launched", "✓ agent turn settled", "visible output"]);
		overlay.handleInput?.("\u001b");
		await ui.calls[0]!.promise;
		assert.equal(activeSubscription, undefined);
	} finally {
		stopCoarse?.();
		fx.cleanup();
	}
});

test("session runtime paints injected machine facts and applies in-process Legion events", async () => {
	const bus = createLegionEventBus();
	const nodes = [
		makeNode("root", null, "root", 0),
		makeNode("root.worker", "root", "worker", 1),
	];
	let finishRetire: (() => void) | undefined;
	let retireStarted: (() => void) | undefined;
	const retiring = new Promise<void>((resolve) => { finishRetire = resolve; });
	const waitingForRetire = new Promise<void>((resolve) => { retireStarted = resolve; });
	let factory: ((tui: { requestRender(): void }, theme: { fg(color: string, text: string): string }) => { render(width?: number): string[] }) | undefined;
	const runtime = createSessionRuntime({
		sendMessage() {},
		eventBus: bus,
		getTreeNodes: () => nodes,
		getTreeIdentity: (name) => {
			const node = nodes.find((entry) => entry.name === name);
			return node ? { nodeId: node.id, parentId: node.parentId, depth: node.depth } : undefined;
		},
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
		const tracked = runtime.track({
			name: "worker",
			runId: "root-run",
			agent: "worker",
			sessionFile: "",
			timeoutMs: 1_000,
			collect: async () => ({
				execution: { status: "failed" },
				output: "failed",
				acceptance: { status: "unknown" },
			}),
			retire: async () => {
				retireStarted?.();
				await retiring;
			},
		});
		assert.equal(tracked.nodeId, "root.worker");
		assert.deepEqual(runtime.treeNodes().map(({ id, status }) => ({ id, status })), [
			{ id: "root", status: "running" },
			{ id: "root.worker", status: "running" },
		]);
		runtime.watch("worker");
		await waitingForRetire;
		const failedNode = runtime.treeNodes().find((node) => node.id === "root.worker");
		assert.equal(failedNode?.status, "failed", "a failed RPC collect overrides the previous DB fact");
		const failedEntry = runtime.statusEntries().find((entry) => entry.nodeId === "root.worker");
		assert.equal(failedEntry?.state, "failed");
		assert.equal(failedEntry?.finishedAt, NOW);
		bus.emit({ nodeId: "root", type: "phase_change", data: { from: "planning", to: "done" }, ts: NOW });
		const rendered = factory!({ requestRender() {} }, { fg: (_color, text) => text }).render().join("\n");
		// Live-panel semantics (post live-tree filter): the worker is failed and
		// nothing runs, so the resident widget clears. The full facts (phase done,
		// failed node) stay in treeNodes() — the /legion view's data source.
		assert.equal(rendered, "", "resident panel clears once nothing is running");
		assert.equal(runtime.treeNodes().find((node) => node.id === "root")?.phase, "done", "ledger facts keep the final phase");
		assert.equal(runtime.treeNodes().find((node) => node.id === "root.worker")?.status, "failed");
	} finally {
		finishRetire?.();
		runtime.dispose();
	}
});

test("session runtime rejects name-only tree fallback when stable identity is ambiguous", () => {
	const bus = createLegionEventBus();
	const nodes = [
		makeNode("root", null, "root", 0),
		makeNode("root.alpha.worker", "root.alpha", "worker", 2),
		makeNode("root.beta.worker", "root.beta", "worker", 2),
	];
	const runtime = createSessionRuntime({
		sendMessage() {},
		eventBus: bus,
		getTreeNodes: () => nodes,
		getTreeIdentity: () => undefined,
		now: () => NOW,
	});
	try {
		runtime.track({
			name: "worker",
			runId: "unknown-run",
			agent: "worker",
			sessionFile: "",
			timeoutMs: 1_000,
			collect: async () => ({ execution: { status: "running" }, output: "", acceptance: { status: "unknown" } }),
		});
		assert.deepEqual(runtime.treeNodes().map((entry) => entry.id), [
			"root",
			"root.alpha.worker",
			"root.beta.worker",
		]);
		const statusEntries = runtime.statusEntries().filter((entry) => entry.name === "worker");
		assert.equal(statusEntries.filter((entry) => entry.nodeId === undefined).length, 1, "ambiguous jobs remain visible without being attached to a wrong tree node");
		assert.equal(statusEntries.filter((entry) => entry.nodeId === "root.alpha.worker").length, 1);
		assert.equal(statusEntries.filter((entry) => entry.nodeId === "root.beta.worker").length, 1, "same-named persisted nodes are not hidden by an uncorrelated job");
	} finally {
		runtime.dispose();
	}
});

test("session runtime correlates tree fallback by child session identity, not duplicate name", () => {
	const bus = createLegionEventBus();
	const nodes = [
		makeNode("root", null, "root", 0),
		{ ...makeNode("root.alpha.worker", "root.alpha", "worker", 2), runId: "worker-run", sessionFile: "/sessions/worker.jsonl" },
		{ ...makeNode("root.beta.worker", "root.beta", "worker", 2), runId: "other-run", sessionFile: "/sessions/other.jsonl" },
	];
	const runtime = createSessionRuntime({
		sendMessage() {},
		eventBus: bus,
		getTreeNodes: () => nodes,
		getTreeIdentity: () => undefined,
		now: () => NOW,
	});
	try {
		runtime.track({
			name: "worker",
			runId: "worker-run",
			agent: "worker",
			sessionFile: "/sessions/worker.jsonl",
			timeoutMs: 1_000,
			collect: async () => ({ execution: { status: "running" }, output: "", acceptance: { status: "unknown" } }),
		});
		const worker = runtime.treeNodes().find((entry) => entry.id === "root.alpha.worker");
		const other = runtime.treeNodes().find((entry) => entry.id === "root.beta.worker");
		assert.equal(worker?.status, "running");
		assert.equal(other?.updatedAt, NOW - 1_000, "a same-named sibling's tree facts remain untouched");
		const workerEntries = runtime.statusEntries().filter((entry) => entry.name === "worker");
		assert.equal(workerEntries.filter((entry) => entry.nodeId === "root.alpha.worker").length, 1);
		assert.equal(workerEntries.filter((entry) => entry.nodeId === "root.beta.worker").length, 1, "the same-named sibling remains visible in persisted status facts");
	} finally {
		runtime.dispose();
	}
});

test("session runtime reads PI_LEGION_DB events and cleans up its event source", async () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "legion-runtime-db-source-"));
	const dbPath = path.join(cwd, "legion.db");
	const writer = openLegionDb(dbPath);
	const environmentBefore = process.env.PI_LEGION_DB;
	const bus = createLegionEventBus();
	const delivered: LegionEvent[] = [];
	const stop = bus.on("node_launched", (event) => delivered.push(event));
	const errors: unknown[] = [];
	let runtime: ReturnType<typeof createSessionRuntime> | undefined;
	try {
		insertNode(writer, { id: "root", parentId: null, name: "root", role: "root", status: "running" }, () => 1);
		process.env.PI_LEGION_DB = dbPath;
		runtime = createSessionRuntime({
			sendMessage() {},
			eventBus: bus,
			onDbEventSourceError: (error) => errors.push(error),
		});
		const initialTree = runtime.treeNodes();
		assert.deepEqual(initialTree.map((node) => node.id), ["root"]);
		const event = appendEvent(writer, "root", "node_launched", { changed: true }, { now: () => 2 });
		const deadline = Date.now() + 1_000;
		while (delivered.length === 0 && Date.now() < deadline) {
			await new Promise<void>((resolve) => setTimeout(resolve, 25));
		}
		assert.deepEqual(delivered.map((entry) => entry.id), [event.id]);
		assert.deepEqual(errors, []);
	} finally {
		runtime?.dispose();
		stop();
		writer.close();
		if (environmentBefore === undefined) delete process.env.PI_LEGION_DB;
		else process.env.PI_LEGION_DB = environmentBefore;
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("a supervisor-injected extension never adopts a legion identity from inherited env", async () => {
	// Regression (healthy ghost nodes): a scout running `npm test` in its
	// worktree inherits PI_LEGION_DB/PI_LEGION_NODE_ID; the test's extension
	// instance must not attach to the live tree and persist fake launches,
	// no matter what env says. Explicit supervisor injection = test mode.
	const dir = mkdtempSync(path.join(tmpdir(), "legion-test-mode-"));
	// Match the real layout: <root>/.pi-subagents/runs/<runId>/legion.db —
	// runStoreFor() derives the store root from the db path (three dirname hops).
	const dbPath = path.join(dir, ".pi-subagents", "runs", "r-ghost", "legion.db");
	mkdirSync(path.dirname(dbPath), { recursive: true });
	const db = openLegionDb(dbPath);
	const now = Date.now();
	insertNode(db, { id: "root", parentId: null, name: "root", role: "root", kind: "pi", depth: 0, runId: "r-ghost", status: "running", createdAt: now, updatedAt: now }, () => now);
	insertNode(db, { id: "root.scout-x", parentId: "root", name: "scout-x", role: "scout", kind: "pi", depth: 1, runId: "r-scout", status: "running", sessionFile: path.join(dir, "scout-x-session.jsonl"), createdAt: now, updatedAt: now }, () => now);
	db.close();

	const prevDb = process.env[LEGION_DB_ENV];
	const prevNode = process.env[LEGION_NODE_ID_ENV];
	process.env[LEGION_DB_ENV] = dbPath;
	process.env[LEGION_NODE_ID_ENV] = "root.scout-x";
	try {
		const tools: Array<Record<string, unknown>> = [];
		const handlers = new Map<string, (...args: unknown[]) => unknown>();
		const pi = {
			registerTool(tool: unknown) { tools.push(tool as Record<string, unknown>); },
			registerMessageRenderer() {}, registerCommand() {}, sendMessage() {},
			events: { emit() {} },
			on(name: string, handler: (...args: unknown[]) => unknown) { handlers.set(name, handler); },
		};
		// Supervisor injection is what every unit test harness does.
		piLegion(pi as never, { supervisor: new FakeSupervisor() });
		const tool = tools.find((entry) => entry.name === "subagent") as { execute: (...args: unknown[]) => Promise<unknown> };
		assert.ok(tool, "subagent tool registered");
		// Launch through the injected fake: must NOT create legion ledger rows.
		const result = (await tool.execute("t", { action: "launch", agent: "scout", task: "probe", async: true, worktree: false, cwd: dir }, undefined, undefined, {
			cwd: dir, hasUI: false, ui: { notify() {}, setStatus() {} },
			// Identity credential: this fake session differs from the scout-x node's
			// recorded session, so attach must be refused even though env matches.
			sessionManager: { getSessionFile: () => path.join(dir, "someone-elses.jsonl") },
		} as never)) as { content?: Array<{ text?: string }> };
		const text = result?.content?.[0]?.text ?? "";
		// The credential check must refuse the inherited identity — the launch
		// surfaces the refusal instead of adopting the scout's tree.
		assert.match(text, /legion identity mismatch[\s\S]*not yours to adopt/, `attach must be refused with the credential error: ${text}`);
		const check = openLegionDb(dbPath);
		const rows = check.prepare("SELECT id FROM nodes ORDER BY id").all();
		check.close();
		assert.deepEqual(rows.map((r) => r.id), ["root", "root.scout-x"], "no ghost nodes may be persisted by a test-mode extension");
		handlers.get("session_shutdown")?.();
	} finally {
		if (prevDb === undefined) delete process.env[LEGION_DB_ENV];
		else process.env[LEGION_DB_ENV] = prevDb;
		if (prevNode === undefined) delete process.env[LEGION_NODE_ID_ENV];
		else process.env[LEGION_NODE_ID_ENV] = prevNode;
		rmSync(dir, { recursive: true, force: true });
	}
});

test("runtime: a node with no tracked job still reports live tok/s from its session file", async () => {
	// in-process spawnChild() awaits the whole first agent run, so the parent has
	// NO tracked job for the child's entire first run. The status board then only
	// has the DB node path. The usage ledger has no row until settle, so unless the
	// node's sessionFile is parsed directly the token rate reads 0 for the whole
	// lifetime — the exact "in-process shows 0 tok/s, RPC is fine" split.
	const dir = mkdtempSync(path.join(tmpdir(), "legion-node-live-"));
	try {
		const sessionFile = path.join(dir, "worker.jsonl");
		const base = "2026-01-01T00:00:00.000Z";
		writeFileSync(sessionFile, [
			JSON.stringify({ type: "session", id: "s-node-live", cwd: dir, timestamp: base }),
			userMsg("go", { timestamp: 1_000 }),
			assistantMsg({ stopReason: "toolUse", tools: ["bash"], timestamp: 2_000, usage: { output: 500 } }),
			toolResult({ timestamp: 3_000 }),
		].join("\n") + "\n", "utf8");

		const nodes: TreeNodeSnapshot[] = [
			makeNode("root", null, "centurion-0", 0, "running"),
			{ ...makeNode("root.worker", "root", "worker", 1, "running"), sessionFile },
		];
		const runtime = createSessionRuntime({
			sendMessage() {},
			eventBus: createLegionEventBus(),
			getTreeNodes: () => nodes,
			now: () => NOW,
		});

		const entry = runtime.statusEntries().find((item) => item.nodeId === "root.worker");
		assert.equal(entry?.tokensOut, 500, "live tokensOut comes from the session file, not the empty ledger");
		assert.ok(entry?.generationMs !== undefined, "generationMs must exist so tok/s has its denominator");
		assert.equal(entry?.state, "running", "the node maps to a live state so nowRate counts it");

		// End-to-end: the railway header math must see a non-zero rate for this node.
		const { nodesFromEntries } = await import("../../src/tui/viz/model.ts");
		const { RateSampler } = await import("../../src/tui/viz/rate.ts");
		const vizNodes = nodesFromEntries(runtime.statusEntries());
		const worker = vizNodes.find((item) => item.id === "root.worker")!;
		assert.equal(worker.tokensOut, 500, "viz keeps the live token count");
		assert.ok(worker.generationMs > 0, "viz keeps the live generation denominator");
		assert.equal(worker.status, "running");
		assert.deepEqual(liveRateNodeIds(vizNodes).includes("root.worker"), true, "the in-process node counts as live");
		// Two samples with a growing counter: the sampler must produce a positive rate.
		const sampler = new RateSampler();
		sampler.record(NOW - 30_000, [{ ...worker, tokensOut: 500, generationMs: 1_000 }]);
		const later = { ...worker, tokensOut: 800, generationMs: 2_000 };
		sampler.record(NOW, [later]);
		assert.ok(sampler.nowRate(NOW, [later]) > 0, "a node with live session data yields a non-zero tok/s");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
