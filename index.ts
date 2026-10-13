/**
 * Subagent tool — the model-facing surface.
 *
 * Design refs: §11 (tool API), §12 (persistence).
 * All heavy lifting lives in src/runs/orchestrator.ts; this file is the adapter.
 *
 * Completion follows pi-subagents, not "child prompts parent":
 *   launch is async by default → this process watches the child →
 *   `pi.sendMessage({ customType: "subagent-notify" }, { triggerTurn, deliverAs: "followUp" })`
 *   wakes the parent when idle, or waits out the current turn if the parent
 *   is still working. Running children are painted next to the input box.
 */

import * as path from "node:path";
import type { AgentToolResult, AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { RpcSupervisor } from "./src/supervisor/rpc-supervisor.ts";
import type { LegionSupervisor } from "./src/supervisor/types.ts";
import { InMemoryUIProxy, type UIProxy } from "./src/supervisor/ui-proxy.ts";
import { discoverAgents, findAgent, formatAgentRoster, BUILTIN_AGENTS_DIR } from "./src/agents/agents.ts";
import {
	applyAgentOverrides,
	applyDefaultModel,
	applyDefaultOnBlocked,
} from "./src/agents/overrides.ts";
import {
	applyTeam,
	DEFAULT_TEAM,
	TEAM_ENV,
	type ActiveTeam,
} from "./src/agents/teams.ts";
import { resolveModel } from "./src/agents/model-resolution.ts";
import { resolveStepModel } from "./src/agents/step-model.ts";
import { checkModelScope } from "./src/agents/model-scope.ts";
import {
	loadSubagentSettings,
	resolveSubagentSettings,
} from "./src/agents/settings.ts";
import { createSessionRuntime, type SessionRuntime, type TrackedJob, shouldRecycleAfterCollect, type WaitResult } from "./src/extension/runtime.ts";
import { createDbEventSource, createLegionEventBus, type DbEventSource, type LegionEventBus } from "./src/extension/event-bus.ts";
import { LegionPostman, registerLegionTools, type LegionMailCommand } from "./src/extension/legion-tools.ts";
import { LEGION_DB_ENV, LEGION_NODE_ID_ENV } from "./src/runs/args.ts";
import type { VerifyRunner } from "./src/runs/acceptance.ts";
import { legionDbPath, openLegionDb, type DatabaseSync } from "./src/legion/db.ts";
import { appendEvent } from "./src/legion/events.ts";
import { upsertUsage } from "./src/legion/usage.ts";
import { getChildByName, getChildren, getNode, getSubtree, insertNode, type LegionNode, updateNode } from "./src/legion/nodes.ts";
import { DEFAULT_LEGION_SETTINGS, type LegionSettings } from "./src/shared/types.ts";
import { parseNestedPathEnv } from "./src/shared/nested-path.ts";
import { makeName } from "./src/shared/name.ts";
import { deriveOutcome, isLastTurnComplete, parseSessionFile } from "./src/shared/session.ts";
import {
	publishSupervisorEvent,
	publishUIRequest,
	registerLegionCommand,
	type RpcEventSource,
} from "./src/extension/legion-commands.ts";
import { DEFAULT_FLUSH_MS, DEFAULT_JOIN_MODE } from "./src/extension/join.ts";
import { registerChildGuard } from "./src/extension/child-guard.ts";
import { ALLOW_NESTED_ENV } from "./src/extension/budget.ts";
import {
	applyOnBlockedPolicy,
	followUpFor,
} from "./src/extension/blocked.ts";
import { formatAlreadyRecycled } from "./src/extension/recycle.ts";
import {
	SUBAGENT_NOTIFY_TYPE,
} from "./src/extension/notify.ts";
import { renderSubagentNotice } from "./src/extension/notice-renderer.ts";
import {
	registerProfileCommands,
	registerAgentsCommand,
	registerTeamCommand,
	registerToggleCommand,
} from "./src/extension/slash.ts";
import { registerSummaryCommand } from "./src/extension/summary.ts";
import { PARENT_PLAYBOOK, TOOL_DESCRIPTION } from "./src/extension/playbook.ts";
import { getAgentDir } from "./src/agents/paths.ts";
import {
	effectiveMaxDepth,
	Orchestrator,
	type OrchestratorLegionContext,
} from "./src/runs/orchestrator.ts";
import { RunStore, pickChildByName } from "./src/runs/store.ts";
import { resolveLaunchWorktree } from "./src/runs/worktree.ts";
import {
	type AgentConfig,
	type AgentScope,
	DEFAULTS,
	DEFAULT_ON_BLOCKED,
	ErrorCodes,
	type ModelOrigin,
	SubagentError,
} from "./src/shared/types.ts";

// The parent turn owns its child lifetime. Parallel tool aborts in one turn
// share this graceful-retire cascade; turn_start begins a fresh cycle.
let cascadePromise: Promise<void> | undefined;

// ---------------------------------------------------------------------------
// Parameters
// ---------------------------------------------------------------------------

const TaskItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task to delegate" }),
	cwd: Type.Optional(Type.String()),
	model: Type.Optional(Type.String()),
	preset: Type.Optional(
		Type.String({ description: "Named kind+model+thinking preset" }),
	),
	worktree: Type.Optional(
		Type.Boolean({
			description:
				"Parent decides isolation for this child. true = own git branch, child opens an MR. false = write the current checkout.",
		}),
	),
	verify: Type.Optional(
		Type.Array(Type.String(), {
			description:
				"Commands the extension runs itself in the child worktree at collect time; first non-zero exit rejects the verdict.",
		}),
	),
});

const SubagentParams = Type.Object({
	action: Type.Optional(
		Type.Union(
			[
				Type.Literal("launch"),
				Type.Literal("continue"),
				Type.Literal("steer"),
				Type.Literal("resume"),
				Type.Literal("retire"),
				Type.Literal("status"),
				Type.Literal("collect"),
				Type.Literal("list"),
				Type.Literal("wait"),
				Type.Literal("stop"),
			],
			{ description: "Defaults to launch." },
		),
	),
	agent: Type.Optional(
		Type.String({ description: "Agent name (single launch)" }),
	),
	task: Type.Optional(Type.String({ description: "Task text (single launch)" })),
	tasks: Type.Optional(
		Type.Array(TaskItem, { description: "Parallel launches" }),
	),
	async: Type.Optional(
		Type.Boolean({
			description: "Return after launch instead of waiting. Default true.",
		}),
	),
	model: Type.Optional(
		Type.String({ description: "Model override for this run" }),
	),
	preset: Type.Optional(
		Type.String({ description: "Named kind+model+thinking preset" }),
	),
	cwd: Type.Optional(Type.String()),
	worktree: Type.Optional(
		Type.Boolean({
			description:
				"Parent decides isolation. true = isolated git branch, child opens an MR. false = edit the current checkout. Omit to use the role default (bundled worker: true).",
		}),
	),
	verify: Type.Optional(
		Type.Array(Type.String(), {
			description:
			"Verification commands the extension runs itself in the child worktree at collect time (launch only). Each must exit 0; the first non-zero exit rejects the child's verdict as `rejected (verified-path)`. The worker does not need to paste test output.",
		}),
	),
	agentScope: Type.Optional(
		Type.Union(
			[Type.Literal("user"), Type.Literal("project"), Type.Literal("both")],
			{
				description: 'Which agent directories to load. Default "user".',
			},
		),
	),
	name: Type.Optional(
		Type.String({ description: "Child handle name (control actions, including wait and stop)" }),
	),
	all: Type.Optional(
		Type.Boolean({
			description: "wait: wait for active children; stop: stop every non-retired child",
		}),
	),
	timeoutMs: Type.Optional(
		Type.Number({
			description: "wait: per-child timeout in ms; event-driven completion returns early (default: role turnTimeoutMs)",
		}),
	),
	message: Type.Optional(
		Type.String({ description: "Text for steer/continue" }),
	),
	team: Type.Optional(
		Type.String({ description: "Team to use for the launched child and its nested roster" }),
	),
});

/** The validated tool parameters, as the model supplies them. */
type SubagentParams = Static<typeof SubagentParams>;

const VexillatioParams = Type.Object({
	task: Type.String({ description: "Recon task: one clear question list" }),
	agent: Type.Optional(Type.String({ description: "Utility agent name (default: scout)" })),
	tasks: Type.Optional(Type.Array(TaskItem, { description: "Parallel recon launches" })),
	cwd: Type.Optional(Type.String()),
	model: Type.Optional(Type.String()),
	timeoutMs: Type.Optional(Type.Number({ description: "Per-child wait in ms, default 600000" })),
});

const UTILITY_CHILD_ENV = "PI_SUBAGENT_UTILITY_CHILD";

const blockedUi = new WeakMap<
	SessionRuntime,
	{
		getConfirm: () => ((message: string) => Promise<boolean>) | undefined;
		notifyBlocked: (message: string) => void;
	}
>();

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export interface ExtensionSupervisorDeps {
	supervisor?: LegionSupervisor;
	uiProxy?: UIProxy;
	onBudgetRefused?: NonNullable<ConstructorParameters<typeof Orchestrator>[0]["onBudgetRefused"]>;
	/** Injected verify runner for tests; production falls back to the real shell runner. */
	verifyRunner?: VerifyRunner;
}

interface LegionRuntimeIdentity {
	pi: ExtensionAPI;
	db: DatabaseSync;
	dbPath: string;
	runStore: RunStore;
	nodeId: string;
	parentNodeId: string | null;
	parentRunId: string | null;
	runId: string;
	runDir: string;
	rootRunId: string;
	storeRootDir: string;
	settings: LegionSettings;
	eventBus: LegionEventBus;
	dbEventSource: DbEventSource;
	postman: LegionPostman;
	childNodeId(name: string): string | undefined;
}

function settingsForLegion(settings: ReturnType<typeof loadSubagentSettings>): LegionSettings {
	return { ...DEFAULT_LEGION_SETTINGS, ...(settings.legion ?? {}), phaseTimeouts: { ...DEFAULT_LEGION_SETTINGS.phaseTimeouts, ...(settings.legion?.phaseTimeouts ?? {}) } };
}

function runStoreFor(cwd: string): RunStore {
	const sharedDbPath = process.env[LEGION_DB_ENV];
	if (sharedDbPath && path.isAbsolute(sharedDbPath)) {
		const storeRoot = path.dirname(path.dirname(path.dirname(sharedDbPath)));
		return new RunStore({ rootDir: storeRoot });
	}
	return new RunStore({ rootDir: path.join(cwd, ".pi-subagents") });
}

function notice(pi: ExtensionAPI, text: string): void {
	pi.sendMessage({ customType: SUBAGENT_NOTIFY_TYPE, content: text, display: true }, { triggerTurn: true, deliverAs: "followUp" });
}

function createLegionRuntime(input: {
	pi: ExtensionAPI;
	supervisor: LegionSupervisor;
	db: DatabaseSync;
	dbPath: string;
	nodeId: string;
	rootRunId: string;
	runDir: string;
	cwd: string;
	storeRootDir: string;
	settings: LegionSettings;
	eventBus: LegionEventBus;
	registerTools: boolean;
}): LegionRuntimeIdentity {
	const self = getNode(input.db, input.nodeId);
	const eventBus = input.eventBus;
	const dbEventSource = createDbEventSource(input.db);
	dbEventSource.start(eventBus);
	const postman = new LegionPostman({
		db: input.db,
		nodeId: input.nodeId,
		supervisor: input.supervisor,
		settings: input.settings,
		eventBus,
		sendRootMessage: (text: string) => notice(input.pi, text),
		sendSelfMessage: (text: string) => notice(input.pi, text),
		resumeChild: (node: LegionNode, mail: LegionMailCommand) => resumeLegionChild({
			pi: input.pi, supervisor: input.supervisor, db: input.db, dbPath: input.dbPath,
			eventBus, settings: input.settings, cwd: input.cwd, storeRootDir: input.storeRootDir,
			parentNodeId: input.nodeId, node, message: mail.text,
		}),
	});
	const identity: LegionRuntimeIdentity = {
		pi: input.pi,
		db: input.db,
		dbPath: input.dbPath,
		runStore: new RunStore({ rootDir: input.storeRootDir }),
		nodeId: input.nodeId,
		parentNodeId: self?.parentId ?? null,
		parentRunId: self?.parentId ? getNode(input.db, self.parentId)?.runId ?? null : null,
		runId: self?.runId ?? input.rootRunId,
		runDir: input.runDir,
		rootRunId: input.rootRunId,
		storeRootDir: input.storeRootDir,
		settings: input.settings,
		eventBus,
		dbEventSource,
		postman,
		childNodeId: (name) => getChildByName(input.db, input.nodeId, name)?.id,
	};
	if (input.registerTools && input.nodeId !== "root") registerLegionTools(input.pi, { db: input.db, nodeId: input.nodeId, role: self?.role, settings: input.settings, cwd: input.cwd, runDir: input.runDir, eventBus, sendSelfMessage: (text: string) => notice(input.pi, text) });
	postman.start();
	return identity;
}

function resolveLegionIdentity(input: {
	pi: ExtensionAPI;
	supervisor: LegionSupervisor;
	store: RunStore;
	cwd: string;
	settings: ReturnType<typeof loadSubagentSettings>;
	eventBus: LegionEventBus;
	cached?: LegionRuntimeIdentity;
	/** This process's session file (identity credential). From ctx.sessionManager. */
	sessionFile?: string | undefined;
}): LegionRuntimeIdentity | undefined {
	const dbPath = process.env[LEGION_DB_ENV];
	const nodeId = process.env[LEGION_NODE_ID_ENV];
	if (Boolean(dbPath) !== Boolean(nodeId)) throw new Error("PI_LEGION_DB and PI_LEGION_NODE_ID must be set together");
	if (dbPath && nodeId) {
		if (!path.isAbsolute(dbPath)) throw new Error("PI_LEGION_DB must be an absolute path");
		if (input.cached?.dbPath === path.resolve(dbPath) && input.cached.nodeId === nodeId) return input.cached;
		const absoluteDbPath = path.resolve(dbPath);
		const db = openLegionDb(absoluteDbPath);
		const node = getNode(db, nodeId);
		if (!node) { db.close(); throw new Error(`legion node not found: ${nodeId}`); }
		// Identity credential check: the node's recorded sessionFile must match
		// THIS process's session. A child env (PI_LEGION_DB/PI_LEGION_NODE_ID)
		// inherited by an arbitrary subprocess (e.g. a scout running `npm test`
		// whose tests load this extension) must not adopt the scout's tree
		// identity — that produced the "healthy ghost nodes" incident: fake
		// launches persisted into the live ledger. A mismatch means the env
		// belongs to an ancestor process, not to us; refuse to attach.
		const mySession = input.sessionFile;
		if (mySession && node.sessionFile && path.resolve(mySession) !== path.resolve(node.sessionFile)) {
			db.close();
			throw new Error(
					`legion identity mismatch: node ${nodeId} belongs to session ${node.sessionFile}, ` +
						`but this process runs ${mySession}; inherited PI_LEGION_* env is not yours to adopt`,
			);
		}
		const nodeRuns = input.store.listRuns().filter((run) => run.nodeId === nodeId || run.herdr.node_id === nodeId);
		let nodeRun = nodeRuns.at(-1);
		if (!nodeRun) {
			nodeRun = input.store.createRun({ task: node.taskSummary ?? `Resume ${node.role} node ${node.id}`, cwd: input.cwd, path: parseNestedPathEnv(process.env.PI_SUBAGENT_PARENT_PATH), maxDepth: effectiveMaxDepth(input.settings.legion?.maxDepth), nodeId, herdr: { supervisor: "rpc", node_id: nodeId } });
		}
		if (node.runId !== nodeRun.runId) updateLegionRunId(db, nodeId, nodeRun.runId);
		const identity = createLegionRuntime({ pi: input.pi, supervisor: input.supervisor, db, dbPath: absoluteDbPath, nodeId, rootRunId: getNode(db, "root")?.runId ?? path.basename(path.dirname(absoluteDbPath)), runDir: input.store.runDir(nodeRun.runId), cwd: input.cwd, storeRootDir: input.store.rootDir, settings: settingsForLegion(input.settings), eventBus: input.eventBus, registerTools: true });
		if (node.role === "centurion") void resumeLegionTeam({ identity, input });
		return identity;
	}
	if (input.cached?.nodeId === "root" && path.resolve(input.cached.storeRootDir) === path.resolve(input.store.rootDir)) return input.cached;
	// A root runtime belongs to the current Pi session. Do not adopt a different
	// session's most recent tree merely because it shares the same project cwd.
	return undefined;
}

function updateLegionRunId(db: DatabaseSync, nodeId: string, runId: string): void {
	db.prepare("UPDATE nodes SET run_id = ?, updated_at = ? WHERE id = ?").run(runId, Date.now(), nodeId);
}

async function resumeLegionTeam(input: { identity: LegionRuntimeIdentity; input: { pi: ExtensionAPI; supervisor: LegionSupervisor; cwd: string } }): Promise<void> {
	for (const node of getChildren(input.identity.db, input.identity.nodeId)) {
		if (["settled", "failed"].includes(node.status) || ["done", "failed", "aborted"].includes(node.phase ?? "") || input.input.supervisor.isAlive(node.name)) continue;
		if (node.sessionFile) {
			const parsed = parseSessionFile(node.sessionFile);
			const recovered = deriveOutcome(parsed);
			if (isLastTurnComplete(parsed) && recovered.status === "success") {
				updateNode(input.identity.db, node.id, { status: "settled" });
				appendEvent(input.identity.db, node.id, "node_settled", { recoveredFromSession: true, execution: recovered.status });
				const usage = recovered.usage;
				if (usage) upsertUsage(input.identity.db, { nodeId: node.id, tokensIn: usage.input + usage.cacheRead + usage.cacheWrite, tokensOut: usage.output, costUsd: usage.cost });
				continue;
			}
			if (isLastTurnComplete(parsed) && recovered.status !== "running" && recovered.status !== "unknown") {
				updateNode(input.identity.db, node.id, { status: "failed" });
				appendEvent(input.identity.db, node.id, "node_failed", { recoveredFromSession: true, execution: recovered.status, reason: recovered.reason });
				continue;
			}
		}
		try {
			await resumeLegionChild({ pi: input.input.pi, supervisor: input.input.supervisor, db: input.identity.db, dbPath: input.identity.dbPath, eventBus: input.identity.eventBus, settings: input.identity.settings, cwd: input.input.cwd, storeRootDir: input.identity.storeRootDir, parentNodeId: input.identity.nodeId, node, message: `Resume from saved session ${node.sessionFile} and continue interrupted work.` });
		} catch (error) { notice(input.input.pi, `Could not resume ${node.id}: ${error instanceof Error ? error.message : String(error)}`); }
	}
}

function createRootLegion(input: { pi: ExtensionAPI; supervisor: LegionSupervisor; store: RunStore; cwd: string; task: string; settings: ReturnType<typeof loadSubagentSettings>; maxDepth: number; eventBus: LegionEventBus }): LegionRuntimeIdentity {
	const rootRun = input.store.createRun({ task: input.task, cwd: input.cwd, maxDepth: input.maxDepth, nodeId: "root", herdr: { supervisor: "rpc" } });
	const dbPath = path.resolve(legionDbPath(input.store.runDir(rootRun.runId)));
	const db = openLegionDb(dbPath);
	const now = Date.now();
	insertNode(db, { id: "root", parentId: null, name: "root", role: "root", kind: "pi", depth: 0, runId: rootRun.runId, status: "running", taskSummary: input.task.slice(0, 2_000), createdAt: now, updatedAt: now }, () => now);
	appendEvent(db, "root", "node_launched", { runId: rootRun.runId, task: input.task }, { now: () => now });
	return createLegionRuntime({ pi: input.pi, supervisor: input.supervisor, db, dbPath, nodeId: "root", rootRunId: rootRun.runId, runDir: input.store.runDir(rootRun.runId), cwd: input.cwd, storeRootDir: input.store.rootDir, settings: settingsForLegion(input.settings), eventBus: input.eventBus, registerTools: false });
}

async function resumeLegionChild(input: { pi: ExtensionAPI; supervisor: LegionSupervisor; db: DatabaseSync; dbPath: string; eventBus: LegionEventBus; settings: LegionSettings; cwd: string; storeRootDir: string; parentNodeId: string; node: LegionNode; message: string }): Promise<void> {
	const parent = getNode(input.db, input.parentNodeId);
	if (!parent || !input.node.runId || !input.node.sessionFile) throw new Error(`resume credentials missing for ${input.node.id}`);
	const store = new RunStore({ rootDir: input.storeRootDir });
	const nodeRun = store.readRun(input.node.runId);
	if (!nodeRun) throw new Error(`resume run.json not found: ${input.node.runId}`);
	const parentRunId = parent.runId;
	if (!parentRunId) throw new Error(`parent run id missing for ${input.node.id}`);
	let parentRun = store.readRun(parentRunId);
	if (!parentRun) throw new Error(`parent run.json not found: ${parentRunId}`);
	let saved = parentRun.children.find((child) => child.nodeId === input.node.id || child.sessionFile === input.node.sessionFile);
	if (!saved) {
		await store.addChild(parentRunId, {
			name: input.node.name,
			nodeId: input.node.id,
			sessionFile: input.node.sessionFile,
			ownerToken: `legion-${input.node.id}`,
			state: input.node.status === "settled" ? "awaiting" : "retired",
			spawnedAt: new Date(input.node.createdAt).toISOString(),
			agent: input.node.role,
			kind: input.node.kind as AgentConfig["kind"],
			...(input.node.model ? { model: input.node.model } : {}),
			...(input.node.worktreePath ? { worktreePath: input.node.worktreePath } : {}),
		});
		parentRun = store.readRun(parentRunId)!;
		saved = parentRun.children.find((child) => child.nodeId === input.node.id);
	}
	if (!saved) throw new Error(`resume child record not found: ${input.node.id}`);
	const cwd = input.node.worktreePath ?? parent.worktreePath ?? parentRun.cwd ?? input.cwd;
	const catalog = loadCatalog(cwd, cwd, undefined);
	const resumedTeam = input.node.team
		? applyTeam(catalog.allAgents, { ...catalog.settings, team: input.node.team }, { ...process.env, [TEAM_ENV]: input.node.team })
		: { agents: catalog.agents, team: catalog.team, warnings: catalog.teamWarnings };
	const agent = findControlAgent(resumedTeam.agents, catalog.allAgents, input.node.role);
	if (!agent) throw new Error(`resume role no longer exists: ${input.node.role}`);
	const childRun = store.readRun(input.node.runId);
	if (!childRun) throw new Error(`child run.json not found: ${input.node.runId}`);
	const parentOfSupervisor = parent.parentId ? getNode(input.db, parent.parentId) : null;
	const orchestrator = new Orchestrator({ supervisor: input.supervisor, runDir: store.runDir(parentRun.runId), cwd, maxDepth: catalog.settings.legion?.maxDepth, maxSpawns: catalog.settings.maxSubagentSpawnsPerSession ?? null, team: resumedTeam.team, childContext: catalog.settings.childContext, parentPath: parentRun.path, legion: { db: input.db, dbPath: input.dbPath, nodeId: parent.id, parentNodeId: parent.parentId, parentRunId: parentOfSupervisor?.runId ?? null, runId: parentRun.runId, runStore: store, settings: input.settings, eventBus: input.eventBus } });
	orchestrator.restore(parentRun);
	const handle = await orchestrator.launch({ agent, task: input.message, name: saved.name, ...(input.node.team ? { team: input.node.team } : {}), ...(saved.model ? { model: saved.model } : {}), worktree: Boolean(saved.worktreePath) });
	await store.updateChild(parentRun.runId, saved.name, (child) => Object.assign(child, handle.child));
}

export default function herdrSubagents(pi: ExtensionAPI, deps: ExtensionSupervisorDeps = {}) {
	cascadePromise = undefined;
	const isChild = process.env.PI_SUBAGENT_CHILD === "1";
	const allowNested = process.env[ALLOW_NESTED_ENV] === "1";
	const supervisor = deps.supervisor ?? new RpcSupervisor();
	const verifyRunner = deps.verifyRunner;
	const legionBus = createLegionEventBus();
	const rpcUIProxy = (supervisor as LegionSupervisor & { uiProxy?: UIProxy }).uiProxy;
	const uiProxy = deps.uiProxy ?? rpcUIProxy ?? new InMemoryUIProxy();
	const onBudgetRefused = deps.onBudgetRefused ?? ((event) => {
		try { pi.events.emit("pi-legion:budget_refused", event); } catch { /* optional host event */ }
	});
	let sessionEnabledOverride: boolean | undefined;
	const subagentsEnabled = (cwd: string): boolean => {
		if (sessionEnabledOverride !== undefined) return sessionEnabledOverride;
		try {
			return loadSubagentSettings({
				userSettingsPath: path.join(getAgentDir(), "settings.json"),
				projectSettingsPath: path.join(cwd, ".pi", "settings.json"),
			}).enabled !== false;
		} catch (error) {
			console.warn(
				"[pi-legion] Unable to load settings while checking whether subagents are enabled; defaulting to enabled.",
				error,
			);
			return true;
		}
	};
	let lastCwd = process.cwd();
	let legionIdentity: LegionRuntimeIdentity | undefined;
	const stopLegionRuntime = (): void => {
		if (!legionIdentity) return;
		legionIdentity.postman.stop();
		legionIdentity.dbEventSource.stop();
		legionIdentity.db.close();
		legionIdentity = undefined;
	};
	const initializeLegionRuntime = (ctx: Pick<ExtensionContext, "cwd"> & { sessionFile?: string }): void => {
		const store = runStoreFor(ctx.cwd);
		const settings = loadSubagentSettings({
			userSettingsPath: path.join(getAgentDir(), "settings.json"),
			projectSettingsPath: path.join(ctx.cwd, ".pi", "settings.json"),
		});
		const next = resolveLegionIdentity({ pi, supervisor, store, cwd: ctx.cwd, settings, eventBus: legionBus, cached: legionIdentity, sessionFile: ctx.sessionFile });
		if (legionIdentity && next !== legionIdentity) stopLegionRuntime();
		legionIdentity = next;
	};
	if (isChild) {
		registerChildGuard(pi);
		if (process.env[LEGION_DB_ENV] && process.env[LEGION_NODE_ID_ENV]) {
			// Boot-time attach: no ExtensionContext yet, so no session credential —
			// the session_start handler re-runs this with the real credential.
			try { initializeLegionRuntime({ cwd: process.cwd() }); }
			catch (error) { console.error(`[pi-legion] legion initialization failed: ${error instanceof Error ? error.message : String(error)}`); }
		}
	}
	pi.on("session_start", (_event, ctx) => {
		try { initializeLegionRuntime({ cwd: ctx.cwd, sessionFile: ctx.sessionManager?.getSessionFile() }); }
		catch (error) { console.error(`[pi-legion] legion initialization failed: ${error instanceof Error ? error.message : String(error)}`); }
	});
	const pendingUtilityRetires: Array<() => Promise<void>> = [];
	let sessionRuntime: SessionRuntime | undefined;
	let cascadingJobs = new Set<TrackedJob>();
	let cascadingUtilityRetires = new Set<() => Promise<void>>();
	const cascadeRetireAll = (): Promise<void> => {
		const jobs = (sessionRuntime?.activeJobs() ?? []).filter(
			(job) => job.state !== "retired" && !cascadingJobs.has(job),
		);
		const utilityRetires = pendingUtilityRetires.filter(
			(retire) => !cascadingUtilityRetires.has(retire),
		);
		if (!cascadePromise) cascadePromise = Promise.resolve();
		if (jobs.length === 0 && utilityRetires.length === 0) return cascadePromise;
		for (const job of jobs) {
			cascadingJobs.add(job);
			sessionRuntime?.cancelWatch(job.name);
		}
		for (const retire of utilityRetires) cascadingUtilityRetires.add(retire);
		const retirements = [
			...jobs.map((job) => async () => job.retire?.()),
			...utilityRetires.map((retire) => async () => retire()),
		];
		cascadePromise = cascadePromise.then(async () => {
			// allSettled waits for every graceful retire without turning a child
			// failure into a user-visible result or skipping runtime release.
			await Promise.allSettled(retirements.map((retire) => retire()));
			for (const job of jobs) sessionRuntime?.release(job.name);
		});
		return cascadePromise;
	};
	// Register before the child early-return paths below: a command-chain child
	// may use vexillatio across multiple turns without creating a session runtime.
	pi.on("turn_start", () => {
		cascadePromise = undefined;
		cascadingJobs = new Set();
		cascadingUtilityRetires = new Set();
	});
	// An async launch has already returned when ESC lands: no subagent-family
	// tool call is in flight to observe the abort signal, so the run's settle
	// event is the last chance to retire this turn's children. Never awaited —
	// a graceful retire may take seconds and must not stall the settle path.
	pi.on("agent_settled", (event) => {
		if (!event.aborted) return;
		void cascadeRetireAll();
	});
	if (process.env[UTILITY_CHILD_ENV] !== "1") {
		pi.registerTool({
			name: "vexillatio",
			label: "Vexillatio",
			description: "Launch only read-only utility agents and return their collected output.",
			parameters: VexillatioParams,
			async execute(_id, params, signal, _onUpdate, ctx: ExtensionContext): Promise<AgentToolResult<unknown>> {
				if (signal?.aborted) {
					await cascadeRetireAll();
					return ok("interrupted (parent turn aborted)");
				}
				if (!subagentsEnabled(ctx.cwd)) {
					return fail("subagents are disabled (subagents.enabled: false or /subagents-toggle off). Re-enable with /subagents-toggle on.", ErrorCodes.DISABLED);
				}
				const result = await launchUtilityFamily({
					pi,
					ctx,
					params,
					supervisor,
					uiProxy,
					onBudgetRefused,
					cwd: params.cwd ?? ctx.cwd,
					sessionCwd: ctx.cwd,
					signal,
					isChild,
					legion: legionIdentity,
					eventBus: legionBus,
					onLegion: (identity) => {
						if (legionIdentity && legionIdentity !== identity) stopLegionRuntime();
						legionIdentity = identity;
					},
					onUtilityChild: (retire) => pendingUtilityRetires.push(retire),
				});
				if (signal?.aborted) {
					await cascadeRetireAll();
					return ok("interrupted (parent turn aborted)");
				}
				return result;
			},
		});
	}
	pi.on("before_agent_start", (event, ctx) => {
		if (process.env[UTILITY_CHILD_ENV] === "1") return;
		if (!subagentsEnabled(ctx?.cwd ?? lastCwd)) return;
		const tools = event.systemPromptOptions?.selectedTools;
		if (Array.isArray(tools) && !tools.includes("subagent") && !tools.includes("vexillatio")) return;
		if (ctx?.cwd) lastCwd = ctx.cwd;
		const catalog = loadCatalog(lastCwd, lastCwd, undefined);
		const parentContext = catalog.settings.parentContext?.trim();
		return {
			systemPrompt: `${event.systemPrompt}\n\n${PARENT_PLAYBOOK}\n\n${renderParentRoster(
				catalog.agents,
				catalog.team,
				catalog.teamWarnings,
			)}${parentContext ? `\n\n${parentContext}` : ""}`,
		};
	});
	if (process.env[UTILITY_CHILD_ENV] === "1") {
		pi.on("session_shutdown", () => stopLegionRuntime());
		return;
	}
	if (isChild && !allowNested) {
		pi.on("session_shutdown", async () => {
			await Promise.all(pendingUtilityRetires.map((retire) => retire().catch(() => {})));
			stopLegionRuntime();
		});
		return;
	}
	// The parent transcript records every finish; the renderer keeps a
	// completed child to one line so visibility does not cost a screen.
	pi.registerMessageRenderer(SUBAGENT_NOTIFY_TYPE, renderSubagentNotice);

	let lastUi: ExtensionContext["ui"] | undefined;
	let lastModelRegistry: ExtensionContext["modelRegistry"] | undefined;
	let lastConfirm: ((message: string) => Promise<boolean>) | undefined;
	// turn_start/turn_end maintain this so a flush window can wait out a
	// busy parent instead of queueing behind the whole turn (join extends
	// the window at most MAX_BUSY_EXTENSIONS times).
	let parentTurnActive = false;
	const rpcEventSource = supervisor as LegionSupervisor & RpcEventSource;
	const runtime = createSessionRuntime({
		sendMessage: (message, options) => pi.sendMessage(message, options),
		eventBus: legionBus,
		getTreeNodes: () => legionIdentity
			? getSubtree(legionIdentity.db, legionIdentity.nodeId)
			: [],
		getTreeIdentity: (name) => {
			const node = legionIdentity && getChildByName(legionIdentity.db, legionIdentity.nodeId, name);
			return node ? {
				nodeId: node.id,
				parentId: node.parentId,
				depth: node.depth,
				supervisorName: name,
			} : undefined;
		},
		subscribeSupervisorEvents: (name, listener, options) => rpcEventSource.onEvent?.(
			name,
			(event) => {
				const nodeId = legionIdentity?.childNodeId(name);
				if (nodeId) publishSupervisorEvent(legionBus, nodeId, event, options);
				listener(event);
			},
			options,
		) ?? (() => {}),
		emitBusy: (active, label) => {
			try { pi.events.emit("pi-legion:busy", active ? { active: true, label } : { active: false }); }
			catch { /* optional display integration */ }
		},
	});
	sessionRuntime = runtime;
	blockedUi.set(runtime, {
		getConfirm: () => lastConfirm,
		notifyBlocked: (message) => {
			try {
				pi.sendMessage(
					{
						customType: SUBAGENT_NOTIFY_TYPE,
						content: message,
						display: true,
					},
					{ triggerTurn: true, deliverAs: "followUp" },
				);
			} catch {
				// Parent session may already be gone.
			}
		},
	});

	registerProfileCommands(pi, {
		getModelRegistry: () => lastModelRegistry,
	});
	registerSummaryCommand(pi);
	registerLegionCommand(pi, { bus: legionBus, runtime, supervisor: rpcEventSource });

	// ── Master switch ────────────────────────────────────────────────────
	registerToggleCommand(pi, {
		sessionEnabled: () => subagentsEnabled(lastCwd),
		setSessionEnabled: (enabled) => {
			sessionEnabledOverride = enabled;
		},
		settingsEnabled: (cwd) =>
			loadSubagentSettings({
				userSettingsPath: path.join(getAgentDir(), "settings.json"),
				projectSettingsPath: path.join(cwd, ".pi", "settings.json"),
			}).enabled !== false,
		runningChildren: () =>
			runtime
				.activeJobs()
				.filter((job) => job.state === "working" || job.state === "blocked")
				.length,
	});

	// The human-facing roster: what the model gets injected into its system
	// prompt each turn, but on demand and with resolved models. The catalog
	// loading is the same function the tool uses, so the two listings cannot
	// drift apart. Re-loads on every invocation — cheap (a few stat+read calls)
	// and always fresh after an agent file is edited.
	const commandCatalogLoader = (input: {
		sessionCwd: string;
		runCwd: string;
		scope: AgentScope | undefined;
	}) => loadCatalog(input.sessionCwd, input.runCwd, input.scope);
	registerAgentsCommand(pi, { loadCatalog: commandCatalogLoader });
	registerTeamCommand(pi, { loadCatalog: commandCatalogLoader });

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: TOOL_DESCRIPTION,
		parameters: SubagentParams,

		// The parameter list is fixed by Pi's `ExtensionAPI.registerTool`
		// contract — an options object is not ours to choose.
		// pi-lens-ignore: long-parameter-list
		async execute(
			_id,
			params,
			signal,
			onUpdate,
			ctx: ExtensionContext,
		): Promise<AgentToolResult<unknown>> {
			runtime.bind(ctx);
			const action = params.action ?? "launch";
			if (signal?.aborted && action !== "stop") {
				await cascadeRetireAll();
				return ok("interrupted (parent turn aborted)");
			}
			// Master switch: refuse NEW launches with a pointer to the toggle;
			// control actions (status/collect/wait/…) must stay available so a
			// disable with live children remains observable and collectable.
			if (!subagentsEnabled(ctx.cwd) && (action === "launch" || !action)) {
				return fail(
					"subagents are disabled (subagents.enabled: false or /subagents-toggle off). " +
						"Existing children are unaffected; re-enable with /subagents-toggle on.",
					ErrorCodes.DISABLED,
				);
			}
			const cwd = params.cwd ?? ctx.cwd;
			const store = runStoreFor(cwd);
			const catalog = loadCatalog(ctx.cwd, cwd, params.agentScope);
			const { allAgents, settings } = catalog;
			const teamName = action === "launch" ? params.team : undefined;
			const selectedTeam = teamName
				? applyTeam(allAgents, { ...settings, team: teamName }, { ...process.env, [TEAM_ENV]: teamName })
				: { agents: catalog.agents, team: catalog.team, warnings: catalog.teamWarnings };
			const agents = selectedTeam.agents;
			const team = selectedTeam.team;
			const teamWarnings = teamName
				? [...selectedTeam.warnings, ...catalog.utilityWarnings]
				: selectedTeam.warnings;
			runtime.setJoinConfig({
				mode: settings.joinMode ?? DEFAULT_JOIN_MODE,
				flushMs: settings.joinFlushMs ?? DEFAULT_FLUSH_MS,
				parentBusy: () => parentTurnActive,
			});

			if (action === "list") return ok(renderAgentList(agents, team, teamWarnings));

			let activeLegion: LegionRuntimeIdentity | undefined;
			try {
				activeLegion = resolveLegionIdentity({ pi, supervisor, store, cwd, settings, eventBus: legionBus, cached: legionIdentity, sessionFile: ctx.sessionManager?.getSessionFile() });
				if (!activeLegion && action === "launch" && !isChild) {
					const plan = buildPlan(params);
					if (plan.ok) activeLegion = createRootLegion({ pi, supervisor, store, cwd, task: plan.task, settings, maxDepth: effectiveMaxDepth(settings.legion?.maxDepth), eventBus: legionBus });
				}
				if (activeLegion) legionIdentity = activeLegion;
			} catch (error) {
				return fail(`legion runtime initialization failed: ${error instanceof Error ? error.message : String(error)}`, ErrorCodes.INVALID_PARAMS);
			}
			if (signal?.aborted && action !== "stop") {
				await cascadeRetireAll();
				return ok("interrupted (parent turn aborted)");
			}

			// Control actions address an EXISTING child; launch-family actions
			// create new ones. The two share almost nothing, so they are separate.
			if (action !== "launch") {
				const result = await controlAction({
					action,
					params,
					signal,
					supervisor,
					uiProxy,
					onBudgetRefused,
					verifyRunner,
					store,
					cwd,
					agents,
					allAgents,
					team,
					runtime,
					settings,
					legion: activeLegion,
				});
				if (signal?.aborted && action !== "stop") {
					await cascadeRetireAll();
					return ok("interrupted (parent turn aborted)");
				}
				return result;
			}

			const result = await launchFamily({
				params,
				signal,
				ctx,
				supervisor,
				uiProxy,
				onBudgetRefused,
				verifyRunner,
				store,
				cwd,
				agents,
				allAgents,
				settings,
				team,
				legion: activeLegion,
				runtime,
				onUpdate,
			});
			if (signal?.aborted) {
				await cascadeRetireAll();
				return ok("interrupted (parent turn aborted)");
			}
			return result;
		},
	});

	const bindUi = (_event: unknown, ctx: ExtensionContext): void => {
		lastModelRegistry = ctx.modelRegistry;
		lastUi = ctx.hasUI ? ctx.ui : undefined;
		if (ctx.cwd) lastCwd = ctx.cwd;
		runtime.bind(ctx);
		lastConfirm =
			ctx.hasUI && typeof ctx.ui?.confirm === "function"
				? (message) => ctx.ui.confirm("", message)
				: undefined;
	};

	uiProxy.onRequest((pending) => {
		const legionNodeId = legionIdentity?.childNodeId(pending.childName);
		if (legionNodeId) publishUIRequest(legionBus, legionNodeId, pending.request.method);
		const ui = lastUi;
		if (!ui) return;
		const request = pending.request;
		if (request.method === "confirm") return;
		if (request.method === "select") {
			void ui.select(request.title, request.options).then((value) => uiProxy.respond(pending.id, value === undefined ? { cancelled: true } : { value }));
		} else if (request.method === "input") {
			void ui.input(request.title, request.placeholder).then((value) => uiProxy.respond(pending.id, value === undefined ? { cancelled: true } : { value }));
		} else if (request.method === "editor") {
			void ui.editor(request.title, request.prefill).then((value) => uiProxy.respond(pending.id, value === undefined ? { cancelled: true } : { value }));
		} else if (request.method === "notify") ui.notify(request.message, request.notifyType);
		else if (request.method === "setStatus") ui.setStatus(request.statusKey, request.statusText);
		else if (request.method === "setWidget") ui.setWidget(request.widgetKey, request.widgetLines, { placement: request.widgetPlacement });
		else if (request.method === "setTitle") ui.setTitle(request.title);
		else if (request.method === "set_editor_text") ui.setEditorText(request.text);
	});

	pi.on("session_start", bindUi);
	pi.on("session_info_changed", bindUi);
	pi.on("turn_start", (event, ctx) => {
		parentTurnActive = true;
		bindUi(event, ctx);
	});
	pi.on("turn_end", (event, ctx) => {
		parentTurnActive = false;
		bindUi(event, ctx);
	});
	pi.on("agent_start", bindUi);
	pi.on("agent_end", bindUi);
	pi.on("input", bindUi);
	pi.on("tool_result", (_event, ctx) => {
		bindUi(_event, ctx);
		runtime.refreshUi();
	});
	pi.on("session_shutdown", async () => {
		const children = runtime.activeJobs();
		runtime.dispose();
		await Promise.all([
			...children.map((job) => job.retire?.().catch(() => {})),
			...pendingUtilityRetires.map((retire) => retire().catch(() => {})),
		]);
		stopLegionRuntime();
	});
}

/**
 * Load the effective agent catalog for a request.
 *
 * User settings (`~/.pi/agent/settings.json`, including a loaded profile) merge
 * with project `.pi/settings.json`. Agent directories are resolved from the
 * run's `cwd`. Bundled roles are included unless `subagents.disableBuiltins`
 * opts out.
 *
 * Also returns the discovery directories, for listings that tell the user
 * WHERE the roles came from (the /subagents-agents command).
 */
export function loadCatalog(
	sessionCwd: string,
	runCwd: string,
	scope: AgentScope | undefined,
): {
	agents: AgentConfig[];
	allAgents: AgentConfig[];
	settings: ReturnType<typeof loadSubagentSettings>;
	team: ActiveTeam;
	teamWarnings: string[];
	projectAgentsDir: string | null;
	builtinAgentsDir: string;
	utilityWarnings: string[];
} {
	const settings = loadSubagentSettings({
		userSettingsPath: path.join(getAgentDir(), "settings.json"),
		projectSettingsPath: path.join(sessionCwd, ".pi", "settings.json"),
	});
	const discovery = discoverAgents(runCwd, scope ?? "user", {
		includeBuiltin: settings.disableBuiltins !== true,
	});
	const overridden = applyAgentOverrides(discovery.agents, settings.agentOverrides);
	const teamResult = applyTeam(overridden, settings);
	const utilityWarnings = [...new Map(
		[...overridden, ...teamResult.agents]
			.filter((agent) => agent.utility && agent.allowNestedSubagents)
			.map((agent) => [
				agent.name,
				`Utility agent "${agent.name}" sets allowNestedSubagents: true; utility identity takes precedence and nested dispatch is ignored.`,
			] as const),
	).values()];
	const resolveDefaults = (items: AgentConfig[]): AgentConfig[] =>
		applyDefaultOnBlocked(
			applyDefaultModel(items, settings.defaultModel),
			settings.defaultOnBlocked ?? DEFAULT_ON_BLOCKED,
		);
	return {
		// Team member overrides must be applied before defaults so they win over
		// subagents.defaultModel and defaultOnBlocked.
		agents: resolveDefaults(teamResult.agents),
		allAgents: resolveDefaults(overridden),
		team: teamResult.team,
		teamWarnings: [...teamResult.warnings, ...utilityWarnings],
		utilityWarnings,
		settings,
		projectAgentsDir: discovery.projectAgentsDir,
		builtinAgentsDir: discovery.builtinAgentsDir ?? BUILTIN_AGENTS_DIR,
		...(discovery.userAgentsDir
			? { userAgentsDir: discovery.userAgentsDir }
			: {}),
	};
}

/**
 * Act on an EXISTING child: status, steer, collect, retire, continue, resume.
 *
 * The extension stays loaded for the session, but a control call may arrive
 * after a reload — so the orchestrator is rebuilt from `run.json` when we do
 * not already have a live tracker. `onChildUpdate` is synchronous while
 * RunStore is async, so persistence happens explicitly after each operation.
 */
async function controlAction(input: {
	action: string;
	params: SubagentParams;
	signal?: AbortSignal;
	legion?: OrchestratorLegionContext;
	supervisor: LegionSupervisor;
	uiProxy: UIProxy;
	onBudgetRefused: NonNullable<ConstructorParameters<typeof Orchestrator>[0]["onBudgetRefused"]>;
	verifyRunner?: VerifyRunner;
	store: RunStore;
	cwd: string;
	agents: AgentConfig[];
	allAgents: AgentConfig[];
	team: ActiveTeam;
	runtime: SessionRuntime;
	settings: ReturnType<typeof loadSubagentSettings>;
}): Promise<AgentToolResult<unknown>> {
	const { action, params, store, cwd } = input;

	if (action === "wait") {
		if (params.name && params.all) {
			return fail(
				"`name` and `all` are mutually exclusive for wait.",
				ErrorCodes.INVALID_PARAMS,
			);
		}
		if (!params.name && !params.all) {
			return fail(
				"`name` or `all` is required for wait",
				ErrorCodes.INVALID_PARAMS,
			);
		}
		return waitAction({
			params,
			signal: input.signal,
			runtime: input.runtime,
			agents: input.agents,
			allAgents: input.allAgents,
			store,
			cwd,
		});
	}

	if (action === "stop") {
		return stopAction({
			params,
			runtime: input.runtime,
			retire: async (name) => {
				const job = input.runtime.get(name);
				if (job?.retire) {
					await job.retire();
					return;
				}
				// A completion watch can retire/release a target after stop snapshots
				// all names but before the serial loop reaches it. Treat that target as
				// stopped; only rebuild if its persisted record is not already retired.
				const found = findChild(input.store.listRuns(), name);
				if (!found) throw new SubagentError(`unknown child: ${name}`, ErrorCodes.NOT_FOUND);
				if (found.child.state === "retired") return;
				const orchestrator = new Orchestrator({
					supervisor: input.supervisor,
					uiProxy: input.uiProxy,
					runDir: input.store.runDir(found.runId),
					cwd: input.cwd,
					maxDepth: input.settings.legion?.maxDepth,
					childContext: input.settings.childContext,
					...teamForChildren(input.team),
					...(input.legion ? { legion: { ...input.legion, runId: found.runId, runStore: input.store } } : {}),
					onBudgetRefused: input.onBudgetRefused,
				});
				orchestrator.restore(found.run);
				await orchestrator.retire(name);
				await persistChild(input.store, found.runId, orchestrator, name);
			},
		});
	}

	if (!params.name) {
		return fail(
			`\`name\` is required for the "${action}" action.`,
			ErrorCodes.INVALID_PARAMS,
		);
	}

	const found = findChild(store.listRuns(), params.name);
	if (!found) return unknownChild(params.name, store, cwd);

	const orchestrator = new Orchestrator({
		supervisor: input.supervisor,
		uiProxy: input.uiProxy,
		runDir: store.runDir(found.runId),
		cwd,
		maxDepth: input.settings.legion?.maxDepth,
		childContext: input.settings.childContext,
		verifyRunner: input.verifyRunner,
		worktreeBootstrap: input.settings.legion?.worktreeBootstrap,
		worktreeBootstrapTimeoutMs: input.settings.legion?.worktreeBootstrapTimeoutMs,
		...teamForChildren(input.team),
		...(input.legion ? { legion: { ...input.legion, runId: found.runId, runStore: store } } : {}),
		onBudgetRefused: input.onBudgetRefused,
	});
	orchestrator.restore(found.run);

	const ctx: ChildContext = {
		...input,
		name: params.name,
		found,
		orchestrator,
	};

	if (action === "status") return renderChild(found.child, "status");
	if (action === "steer") return steerChild(ctx);
	if (action === "collect") return collectChild(ctx, input.signal);
	if (action === "retire") return retireChild(ctx);
	if (action === "continue" || action === "resume") return reviveChild(ctx);

	return fail(`unhandled action: ${action}`, ErrorCodes.INVALID_PARAMS);
}

/** A resolved child plus the collaborators every control action needs. */
interface ChildContext {
	action: string;
	params: SubagentParams;
	/** Always set: `controlAction` rejects a request without a name. */
	name: string;
	supervisor: LegionSupervisor;
	uiProxy: UIProxy;
	onBudgetRefused: NonNullable<ConstructorParameters<typeof Orchestrator>[0]["onBudgetRefused"]>;
	store: RunStore;
	cwd: string;
	agents: AgentConfig[];
	allAgents: AgentConfig[];
	found: NonNullable<ReturnType<typeof findChild>>;
	orchestrator: Orchestrator;
	runtime: SessionRuntime;
}

/**
 * Explain a lookup miss.
 *
 * Child records live under `<cwd>/.pi-subagents`, so a control call from a
 * different directory cannot see them. Saying so — and listing what IS visible —
 * saves the caller from hunting for a typo that does not exist.
 */
function unknownChild(
	name: string,
	store: RunStore,
	cwd: string,
): AgentToolResult<unknown> {
	const known = store.listRuns().flatMap((run) => run.children.map((child) => child.name));
	return fail(
		`unknown child: ${name} (no run under ${cwd}/.pi-subagents` +
			`${known.length ? `; known here: ${known.join(", ")}` : ""}). ` +
			`Child records are scoped to the \`cwd\` they were launched from — ` +
			`pass the same \`cwd\` you used for \`launch\`.`,
		ErrorCodes.NOT_FOUND,
	);
}

/** Send a message to a running child without waiting for its reply. */
async function steerChild(
	ctx: ChildContext,
): Promise<AgentToolResult<unknown>> {
	if (!ctx.params.message) {
		return fail("`message` is required for steer.", ErrorCodes.INVALID_PARAMS);
	}
	try {
		await ctx.orchestrator.steer(ctx.name, ctx.params.message);
		followChild(ctx, { watch: true });
		return ok(`Steered ${ctx.name}.`);
	} catch (error) {
		return fail(`steer failed: ${String(error)}`, ErrorCodes.NOT_FOUND);
	}
}

/** Wait for the child's current turn and derive its outcome from the session. */
async function collectChild(
	ctx: ChildContext,
	signal?: AbortSignal,
): Promise<AgentToolResult<unknown>> {
	try {
		if (signal?.aborted) return ok("interrupted (parent turn aborted)");
		const pending = signal
			? ctx.runtime.consumeCollectInterruptible(ctx.name, signal)
			: ctx.runtime.consumeCollect(ctx.name);
		if (pending) {
			const collected = await pending;
			if (!collected || signal?.aborted) return ok("interrupted (parent turn aborted)");
			await persistChild(ctx.store, ctx.found.runId, ctx.orchestrator, ctx.name, { preserveRetired: true });
			return ok(renderCollect(ctx.name, collected));
		}

		const cached = ctx.orchestrator.cachedCollect(ctx.name);
		if (cached) return ok(renderCollect(ctx.name, cached));

		const agentDef = findControlAgent(
			ctx.agents,
			ctx.allAgents,
			ctx.found.child.agent,
		);
		const timeoutMs = agentDef?.timeoutMs ?? DEFAULTS.turnTimeoutMs;
		const collected = await ctx.orchestrator.collect(ctx.name, {
			timeoutMs,
			...(signal ? { signal } : {}),
		});
		if (signal?.aborted || collected.execution.reason === "aborted by parent") {
			return ok("interrupted (parent turn aborted)");
		}
		const retireAlreadyFinishedJob = shouldRecycleAfterCollect(collected.execution.status) && !collected.blocked;
		await persistChild(ctx.store, ctx.found.runId, ctx.orchestrator, ctx.name, { preserveRetired: !retireAlreadyFinishedJob });
		if (retireAlreadyFinishedJob) {
			await ctx.orchestrator.retire(ctx.name);
			await persistChild(ctx.store, ctx.found.runId, ctx.orchestrator, ctx.name);
		}
		ctx.runtime.release(ctx.name);
		return ok(renderCollect(ctx.name, collected));
	} catch (error) {
		return fail(`collect failed: ${String(error)}`, ErrorCodes.NOT_FOUND);
	}
}

/** Retire the RPC child while preserving its outcome and session for resume. */
async function retireChild(
	ctx: ChildContext,
): Promise<AgentToolResult<unknown>> {
	try {
		const live = ctx.orchestrator
			.childrenSnapshot()
			.find((child) => child.name === ctx.name);
		if (live?.state === "retired") {
			ctx.runtime.release(ctx.name);
			return ok(formatAlreadyRecycled(ctx.name, live.sessionFile));
		}
		ctx.runtime.release(ctx.name);
		const child = await ctx.orchestrator.retire(ctx.name);
		await persistChild(ctx.store, ctx.found.runId, ctx.orchestrator, ctx.name);
		return ok(
			`Retired ${ctx.name} (execution=${child.execution?.status ?? "unknown"}). ` +
				`RPC process stopped; session kept for resume: ${child.sessionFile}`,
		);
	} catch (error) {
		return fail(`retire failed: ${String(error)}`, ErrorCodes.RETIRE_FAILED);
	}
}

/**
 * Continue or resume a child.
 *
 * A live agent is prompted in place; an exited one is relaunched from its
 * persisted session so its context survives the process being gone (F12).
 */
async function reviveChild(
	ctx: ChildContext,
): Promise<AgentToolResult<unknown>> {
	const { action, params, supervisor, name, found, orchestrator } = ctx;

	if (!params.message) {
		return fail(
			`\`message\` is required for ${action}.`,
			ErrorCodes.INVALID_PARAMS,
		);
	}

	const agentDef = findControlAgent(
		ctx.agents,
		ctx.allAgents,
		found.child.agent,
	);
	if (!agentDef) {
		return fail(
			`agent "${found.child.agent}" is no longer defined`,
			ErrorCodes.UNKNOWN_AGENT,
		);
	}

	try {
		if (supervisor.isAlive(name)) {
			await orchestrator.steer(name, params.message);
			followChild(ctx, { watch: true });
			return ok(
				`${action === "resume" ? "Resumed" : "Continued"} ${name} (live RPC child steered).`,
			);
		}

		const handle = await orchestrator.launch({
			agent: agentDef,
			task: params.message,
			name,
			...(found.child.model ? { model: found.child.model } : {}),
		});
		followChild(ctx, { watch: true });
		return ok(
			`Resumed ${handle.name} from its session. Context preserved from ${handle.sessionFile}`,
		);
	} catch (error) {
		return fail(`${action} failed: ${String(error)}`, ErrorCodes.START_FAILED);
	}
}

/**
 * Create children: a single `agent`+`task` or a `tasks[]` fan-out.
 *
 * One child failure must not abort the rest, so each step reports its own line.
 */
async function launchFamily(input: {
	params: SubagentParams;
	ctx: ExtensionContext;
	supervisor: LegionSupervisor;
	uiProxy: UIProxy;
	onBudgetRefused: NonNullable<ConstructorParameters<typeof Orchestrator>[0]["onBudgetRefused"]>;
	verifyRunner?: VerifyRunner;
	store: RunStore;
	cwd: string;
	agents: AgentConfig[];
	allAgents: AgentConfig[];
	settings: ReturnType<typeof resolveSubagentSettings>;
	team: ActiveTeam;
	legion?: LegionRuntimeIdentity;
	runtime: SessionRuntime;
	signal?: AbortSignal;
	onUpdate?: AgentToolUpdateCallback;
}): Promise<AgentToolResult<unknown>> {
	const { params, ctx, store, cwd, agents, settings, runtime, onUpdate } = input;

	const plan = buildPlan(params);
	if (!plan.ok) return fail(plan.message, ErrorCodes.INVALID_PARAMS);

	onUpdate?.({
		content: [
			{
				type: "text",
				text: `playbook: ${plan.steps.map((s) => s.agent).join(", ")} → RPC launch → watch`,
			},
		],
		details: {},
	});

	const maxDepth = effectiveMaxDepth(settings.legion?.maxDepth);
	const legion = input.legion;
	let run = legion ? store.readRun(legion.runId) : null;
	if (!run) {
		run = store.createRun({
			task: plan.task,
			cwd,
			maxDepth,
			...(legion ? { path: parseNestedPathEnv(process.env.PI_SUBAGENT_PARENT_PATH), nodeId: legion.nodeId, herdr: { supervisor: "rpc" as const, node_id: legion.nodeId } } : { herdr: { supervisor: "rpc" as const } }),
		});
		if (legion && legion.nodeId !== "root" && legion.parentRunId) {
			const node = getNode(legion.db, legion.nodeId);
			if (node?.sessionFile) {
				const parentRun = store.readRun(legion.parentRunId);
				if (parentRun && !parentRun.children.some((child) => child.nodeId === node.id)) {
					await store.addChild(legion.parentRunId, {
						name: node.name,
						nodeId: node.id,
						sessionFile: node.sessionFile,
						ownerToken: node.id,
						state: "working",
						spawnedAt: run.createdAt,
						agent: node.role,
						kind: node.kind as AgentConfig["kind"],
						...(node.model ? { model: node.model } : {}),
						...(node.worktreePath ? { worktreePath: node.worktreePath } : {}),
					});
				}
			}
			updateLegionRunId(legion.db, legion.nodeId, run.runId);
		}
	}
	const orchestrator = new Orchestrator({
		supervisor: input.supervisor,
		uiProxy: input.uiProxy,
		runDir: legion?.runDir ?? store.runDir(run.runId),
		cwd,
		maxDepth: settings.legion?.maxDepth,
		maxSpawns: settings.maxSubagentSpawnsPerSession ?? null,
		childContext: settings.childContext,
		verifyRunner: input.verifyRunner,
		worktreeBootstrap: settings.legion?.worktreeBootstrap,
		worktreeBootstrapTimeoutMs: settings.legion?.worktreeBootstrapTimeoutMs,
		...teamForChildren(input.team),
		...(legion ? { legion: { db: legion.db, dbPath: legion.dbPath, nodeId: legion.nodeId, runId: run.runId, parentNodeId: legion.parentNodeId ?? undefined, parentRunId: legion.parentRunId ?? undefined, runStore: store, settings: legion.settings, eventBus: legion.eventBus } } : {}),
		onBudgetRefused: input.onBudgetRefused,
	});
	orchestrator.restore(run);

	const session: LaunchSession = {
		params,
		signal: input.signal,
		teamOverride: params.team,
		store,
		agents,
		allAgents: input.allAgents,
		settings,
		team: input.team,
		runId: run.runId,
		orchestrator,
		runtime,
		onUpdate,
		dispatchModel: ctx.model
			? `${ctx.model.provider}/${ctx.model.id}`
			: undefined,
		results: [],
		handles: [],
		timeoutByName: new Map(),
	};

	const interruptedResult = async (): Promise<AgentToolResult<unknown> | undefined> => {
		if (!input.signal?.aborted) return undefined;
		for (const name of session.handles) await abandonLaunchedChild(session, name);
		session.handles.length = 0;
		return {
			content: [{ type: "text", text: session.results.join("\n") || "interrupted (parent turn aborted)" }],
			details: { runId: run.runId, handles: [], async: params.async ?? true },
		};
	};

	// Every planned child is independent and launches concurrently.
	await Promise.all(plan.steps.map((step) => launchStep(session, step)));
	const interruptedLaunch = await interruptedResult();
	if (interruptedLaunch) return interruptedLaunch;

	// Persist children first so a crash during the wait still leaves a record.
	for (const name of session.handles) {
		await persistChild(store, run.runId, orchestrator, name);
	}
	const interruptedPersistence = await interruptedResult();
	if (interruptedPersistence) return interruptedPersistence;

	// Collect inline unless the caller asked for async (the default).
	// Async: the session runtime watches each child and wakes the parent
	// with a completion message — children must not prompt the parent.
	const isAsync = params.async ?? true;
	for (const name of session.handles) {
		followLaunched(session, name, { watch: isAsync });
	}
	if (!isAsync) {
		await collectInline(session, input.signal);
		for (const name of session.handles) {
			const child = orchestrator
				.childrenSnapshot()
				.find((c) => c.name === name);
			if (input.signal?.aborted && (!child?.execution || !shouldRecycleAfterCollect(child.execution.status))) {
				followLaunched(session, name, { watch: true });
				await persistChild(store, run.runId, orchestrator, name);
				continue;
			}
			if (
				child?.execution &&
				shouldRecycleAfterCollect(child.execution.status)
			) {
				await orchestrator.retire(name);
			}
			await persistChild(store, run.runId, orchestrator, name);
			runtime.release(name);
		}
	}

	if (isAsync && session.handles.length > 0) {
		session.results.push(
			"↳ async: a completion message is queued when each RPC child finishes. It wakes this session when idle; otherwise it is delivered after the current turn. Use wait or collect for results. Do not tell children to message the parent.",
		);
	}

	return {
		content: [{ type: "text", text: session.results.join("\n") }],
		details: { runId: run.runId, handles: session.handles, async: isAsync },
	};
}

/** Accumulated state for one launch-family request. */
interface LaunchSession {
	params: SubagentParams;
	signal?: AbortSignal;
	teamOverride?: string;
	store: RunStore;
	agents: AgentConfig[];
	allAgents: AgentConfig[];
	settings: ReturnType<typeof resolveSubagentSettings>;
	team: ActiveTeam;
	runId: string;
	orchestrator: Orchestrator;
	runtime: SessionRuntime;
	onUpdate?: AgentToolUpdateCallback;
	dispatchModel: string | undefined;
	results: string[];
	handles: string[];
	timeoutByName: Map<string, number>;
}

/**
 * Launch one step, recording either a launch line or a refusal.
 * Never throws: a bad step degrades to a message so the others still run.
 */
async function launchStep(
	session: LaunchSession,
	step: { agent: string; task: string; model?: string; preset?: string; worktree?: boolean; verify?: string[] },
): Promise<void> {
	if (session.signal?.aborted) return;
	const agent = findAgent(session.agents, step.agent);
	if (!agent) {
		session.results.push(
			unknownAgentLineForCatalog(
				session.agents,
				session.allAgents,
				step.agent,
				session.team,
				session.settings,
			),
		);
		return;
	}
	if (agent.disabled) {
		session.results.push(`✗ agent "${step.agent}" is disabled`);
		return;
	}

	try {
		// Preset expansion and the scope check can THROW (an undefined preset is
		// a loud error by design), so both run INSIDE the guard. Leaving them
		// above it let a single bad `preset:` reject the whole `Promise.all`,
		// discarding the refusal lines of every healthy sibling step.
		const model = resolveStep(session, agent, step);
		// When a preset is referenced this carries the preset's kind/model/thinking;
		// otherwise it is the ORIGINAL agent object (zero drift for no-preset runs).
		const effective = model.agent;
		const resolved = model.resolved;

		// `verify:` on the launch call becomes a criterion with an explicit
		// `command`, so `applyVerification` runs it in the child worktree at
		// collect time — the extension verifies the child's verdict instead
		// of trusting pasted test output. Blank entries are dropped; an empty
		// result is a no-op. Never mutated onto the shared agent object: the
		// catalog would hand the same reference to every later launch.
		const verifyCommands = (step.verify ?? session.params.verify ?? [])
			.map((command) => command.trim())
			.filter(Boolean);
		const launchedAgent = verifyCommands.length
			? {
				...effective,
				acceptance: {
					...(effective.acceptance ?? { level: "attested" as const }),
					criteria: [
						...(effective.acceptance?.criteria ?? []),
						{
							id: "task-verify",
							must: "Launcher-supplied verify commands pass (run by the extension, not the child)",
							evidence: ["verification-output"],
							severity: "required" as const,
							command: verifyCommands.join(" && "),
						},
					],
				},
			}
			: effective;

		const violation = checkModelScope(
			resolved.model,
			session.settings.modelScope,
			"explicit",
		);
		if (violation && violation.severity === "error") {
			session.results.push(`✗ ${violation.message}`);
			return;
		}

		// Let `launch()` allocate from the supervisor-local registry; the index
		// must not race separate subagent tool calls.
		const handle = await session.orchestrator.launch({
			agent: launchedAgent,
			task: step.task,
			...(session.teamOverride ? { team: session.teamOverride } : {}),
			...(resolved.model ? { model: resolved.model } : {}),
			// The origin decides whether an unacceptable model is refused or
			// dropped, and only this layer can tell them apart (a parent model
			// arrives as the same `dispatch` source as a per-run override).
			modelOrigin: model.modelOrigin,
			worktree: resolveLaunchWorktree({
				roleDefault: effective.worktree,
				launch: session.params.worktree,
				step: step.worktree,
			}),
		});
		const recorded = session.store.findChild(session.runId, handle.name);
		if (recorded?.nodeId && recorded.nodeId === handle.child.nodeId) {
			await session.store.updateChild(session.runId, handle.name, (child) => Object.assign(child, handle.child));
		} else {
			await session.store.addChild(session.runId, handle.child);
		}
		session.handles.push(handle.name);
		if (effective.timeoutMs !== undefined) {
			session.timeoutByName.set(handle.name, effective.timeoutMs);
		}
		if (session.signal?.aborted) {
			await abandonLaunchedChild(session, handle.name);
			return;
		}
		session.results.push(
			`▶ ${handle.name} (${effective.name}) supervisor=rpc`,
		);
		// An inherited model the target CLI cannot express is dropped on purpose
		// (the parent's pi model means nothing to cursor). Say so, or the user
		// reasonably believes the child is running the model they see on the
		// parent — the same silent surprise this whole guard exists to remove.
		if (handle.child.modelDropped?.length) {
			session.results.push(
				`  ⚠ ${effective.name} runs on ${effective.kind}'s own default: ` +
					`${handle.child.modelDropped.join(", ")} does not apply to that CLI.`,
			);
		}
		session.onUpdate?.({
			content: [
				{
					type: "text",
					text: `playbook: ${handle.name} started via RPC`,
				},
			],
			details: {},
		});
		// Surface frontmatter keys that are accepted but inert, so a user does
		// not believe an unenforced setting is protecting them.
		if (effective.unenforcedFields?.length) {
			session.results.push(
				`  ⚠ ${effective.name} sets fields that are not enforced yet: ` +
					`${effective.unenforcedFields.join(", ")}`,
			);
		}
	} catch (error) {
		const message =
			error instanceof SubagentError
				? `${error.code}: ${error.message}`
				: String(error);
		session.results.push(`✗ ${step.agent}: ${message}`);
	}
}

/**
 * The complete "no such agent" refusal line, marker included.
 *
 * Exported because the refusal lines are the ONLY feedback a caller gets on a
 * typo'd agent name, and this one regressed once to a doubled `✗` marker with
 * no test noticing. Owning the marker here (rather than at the call site)
 * makes that mistake impossible to repeat.
 */
export function unknownAgentLine(
	agents: AgentConfig[],
	requested: string,
	teamName?: string,
): string {
	const available = agents.map((a) => a.name).join(", ") || "none";
	if (teamName) {
		return `✗ unknown agent "${requested}" in team "${teamName}". Available: ${available}. Switch with /subagents-team use ${teamName} (or "default").`;
	}
	return `✗ unknown agent "${requested}". Available: ${available}`;
}

/** Apply launchStep's team-specific wording only for an actual team-filtered role. */
export function unknownAgentLineForCatalog(
	agents: AgentConfig[],
	allAgents: AgentConfig[],
	requested: string,
	team: ActiveTeam,
	settings: ReturnType<typeof loadSubagentSettings>,
): string {
	const roleExists = Boolean(findAgent(allAgents, requested));
	const hasSelectedTeam =
		team.name !== DEFAULT_TEAM &&
		Object.hasOwn(settings.teams ?? {}, team.name);
	return unknownAgentLine(
		agents,
		requested,
		roleExists && hasSelectedTeam ? team.name : undefined,
	);
}

/**
 * Resolve the model one step will launch with.
 *
 * The precedence logic itself lives in `resolveStepModel`
 * (`src/agents/step-model.ts`), which is pure and unit-tested; this wrapper
 * only adapts the session shape onto it. An undefined preset name, or a
 * resolved kind/model pair that would be silently dropped at start, throws —
 * `launchStep` renders that as a refusal line, never a silent fallback.
 */
function resolveStep(
	session: LaunchSession,
	agent: AgentConfig,
	step: { model?: string; preset?: string },
): {
	resolved: ReturnType<typeof resolveModel>;
	agent: AgentConfig;
	modelOrigin: ModelOrigin;
} {
	const { params, settings } = session;
	const result = resolveStepModel({
		agent,
		step,
		params,
		...(session.dispatchModel ? { dispatchModel: session.dispatchModel } : {}),
		settings,
	});
	return {
		resolved: result.resolved,
		agent: result.agent,
		modelOrigin: result.modelOrigin,
	};
}

/** Wait for each launched child's turn, appending its outcome. */
async function collectInline(session: LaunchSession, signal?: AbortSignal): Promise<void> {
	for (const name of session.handles) {
		if (signal?.aborted) {
			session.results.push("interrupted (parent turn aborted)");
			return;
		}
		try {
			const collected = await session.orchestrator.collect(name, {
				timeoutMs: session.timeoutByName.get(name) ?? DEFAULTS.turnTimeoutMs,
				...(signal ? { signal } : {}),
			});
			if (signal?.aborted || collected.execution.reason === "aborted by parent") {
				session.results.push("interrupted (parent turn aborted)");
				return;
			}
			session.results.push(renderCollect(name, collected));
		} catch (error) {
			session.results.push(`✗ ${name}: collect failed: ${String(error)}`);
		}
	}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Plan =
	| {
			ok: true;
			task: string;
			steps: Array<{
				agent: string;
				task: string;
				model?: string;
				preset?: string;
				worktree?: boolean;
			}>;
	  }
	| { ok: false; message: string };

type UtilityTaskItem = Static<typeof TaskItem>;
type VexillatioParams = Static<typeof VexillatioParams>;

type UtilityPlan =
	| { ok: true; steps: UtilityTaskItem[] }
	| { ok: false; message: string };

function buildUtilityPlan(params: VexillatioParams): UtilityPlan {
	if (!params.task.trim()) return { ok: false, message: "`task` must not be blank." };
	const steps: UtilityTaskItem[] = params.tasks?.length
		? params.tasks
		: [{ agent: params.agent?.trim() || "scout", task: params.task }];
	const unsupportedVerify = steps.findIndex((item) => item.verify !== undefined);
	if (unsupportedVerify >= 0) {
		return {
			ok: false,
			message: `tasks[] step ${unsupportedVerify + 1} cannot include \`verify\`; vexillatio does not run verification commands.`,
		};
	}
	const invalid = steps.findIndex((item) => !item.agent.trim() || !item.task.trim());
	if (invalid >= 0) {
		return { ok: false, message: `tasks[] step ${invalid + 1} must include non-blank \`agent\` and \`task\`.` };
	}
	return { ok: true, steps };
}

async function launchUtilityFamily(input: {
	pi: ExtensionAPI;
	ctx: ExtensionContext;
	params: VexillatioParams;
	signal?: AbortSignal;
	supervisor: LegionSupervisor;
	uiProxy: UIProxy;
	onBudgetRefused: NonNullable<ConstructorParameters<typeof Orchestrator>[0]["onBudgetRefused"]>;
	cwd: string;
	sessionCwd: string;
	isChild: boolean;
	legion?: LegionRuntimeIdentity;
	eventBus: LegionEventBus;
	onLegion: (identity: LegionRuntimeIdentity) => void;
	onUtilityChild: (retire: () => Promise<void>) => void;
}): Promise<AgentToolResult<unknown>> {
	const plan = buildUtilityPlan(input.params);
	if (!plan.ok) return fail(plan.message, ErrorCodes.INVALID_PARAMS);

	const catalog = loadCatalog(input.sessionCwd, input.cwd, undefined);
	const prepared: Array<{
		step: UtilityTaskItem;
		agent: AgentConfig;
		resolved: ReturnType<typeof resolveStepModel>["resolved"];
		modelOrigin: ModelOrigin;
	}> = [];
	for (const step of plan.steps) {
		const agent = findAgent(catalog.allAgents, step.agent);
		if (!agent?.utility) {
			return fail(
				`not a utility agent: ${step.agent} (mark it with 'utility: true')`,
				ErrorCodes.INVALID_PARAMS,
			);
		}
		if (agent.disabled) {
			return fail(`utility agent is disabled: ${agent.name}`, ErrorCodes.DISABLED);
		}
		try {
			const resolvedStep = resolveStepModel({
				agent,
				step: {
					...(step.model !== undefined ? { model: step.model } : {}),
					...(step.preset !== undefined ? { preset: step.preset } : {}),
				},
				params: { ...(input.params.model !== undefined ? { model: input.params.model } : {}) },
				...(input.ctx.model ? { dispatchModel: `${input.ctx.model.provider}/${input.ctx.model.id}` } : {}),
				settings: catalog.settings,
			});
			const violation = checkModelScope(
				resolvedStep.resolved.model,
				catalog.settings.modelScope,
				resolvedStep.modelOrigin,
			);
			if (violation?.severity === "error") {
				return fail(violation.message, ErrorCodes.INVALID_PARAMS);
			}
			prepared.push({
				step,
				agent: resolvedStep.agent,
				resolved: resolvedStep.resolved,
				modelOrigin: resolvedStep.modelOrigin,
			});
		} catch (error) {
			return fail(`✗ ${step.agent}: ${error instanceof Error ? error.message : String(error)}`, ErrorCodes.INVALID_PARAMS);
		}
	}

	const firstPrepared = prepared[0];
	const runTask = prepared.length === 1 && firstPrepared
		? firstPrepared.step.task
		: `${prepared.length} parallel utility tasks`;
	const rootStore = runStoreFor(input.cwd);
	let legion = resolveLegionIdentity({
		pi: input.pi,
		supervisor: input.supervisor,
		store: rootStore,
		cwd: input.cwd,
		settings: catalog.settings,
		eventBus: input.eventBus,
		cached: input.legion,
		sessionFile: input.ctx.sessionManager?.getSessionFile(),
	});
	if (!legion && !input.isChild) {
		legion = createRootLegion({
			pi: input.pi,
			supervisor: input.supervisor,
			store: rootStore,
			cwd: input.cwd,
			task: `vexillatio: ${runTask}`,
			settings: catalog.settings,
			maxDepth: effectiveMaxDepth(catalog.settings.legion?.maxDepth),
			eventBus: input.eventBus,
		});
	}
	if (legion) input.onLegion(legion);

	const store = legion?.runStore ?? rootStore;
	const run = legion
		? store.readRun(legion.runId)
		: store.createRun({
			task: runTask,
			cwd: input.cwd,
			maxDepth: effectiveMaxDepth(catalog.settings.legion?.maxDepth),
			path: parseNestedPathEnv(process.env.PI_SUBAGENT_PARENT_PATH),
			herdr: { supervisor: "rpc" },
		});
	if (!run) return fail("vexillatio parent run is not available", ErrorCodes.NOT_FOUND);
	const runId = run.runId;
	const timeoutMs = input.params.timeoutMs ?? 600_000;
	const existingNames = new Set(
		store.listRuns().flatMap((existingRun) => existingRun.children.map((child) => child.name)),
	);
	if (legion) {
		for (const child of getChildren(legion.db, legion.nodeId)) existingNames.add(child.name);
	}
	const names = new Map<UtilityTaskItem, string>();
	const nameCounters = new Map<string, number>();
	for (const item of prepared) {
		let index = nameCounters.get(item.agent.name) ?? 0;
		for (;; index += 1) {
			const candidate = makeName(item.agent.name, index);
			if (existingNames.has(candidate) || input.supervisor.isAlive(candidate)) continue;
			existingNames.add(candidate);
			names.set(item.step, candidate);
			nameCounters.set(item.agent.name, index + 1);
			break;
		}
	}

	const results: string[] = [];
	const launches = await Promise.all(prepared.map(async (item) => {
		const cwd = item.step.cwd ? path.resolve(input.cwd, item.step.cwd) : input.cwd;
		const orchestrator = new Orchestrator({
			supervisor: input.supervisor,
			uiProxy: input.uiProxy,
			runDir: legion?.runDir ?? store.runDir(runId),
			cwd,
			maxDepth: catalog.settings.legion?.maxDepth,
			maxSpawns: catalog.settings.maxSubagentSpawnsPerSession ?? null,
			childContext: catalog.settings.childContext,
			team: catalog.team,
			onBudgetRefused: input.onBudgetRefused,
			...(legion ? {
				legion: {
					db: legion.db,
					dbPath: legion.dbPath,
					nodeId: legion.nodeId,
					runId,
					parentNodeId: legion.parentNodeId,
					parentRunId: legion.parentRunId ?? undefined,
					runStore: store,
					settings: legion.settings,
					eventBus: legion.eventBus,
				},
			} : {}),
		});
		orchestrator.restore(run);
		try {
			const handle = await orchestrator.launch({
				agent: item.agent,
				task: item.step.task,
				name: names.get(item.step),
				...(item.resolved.model ? { model: item.resolved.model } : {}),
				modelOrigin: item.modelOrigin,
				...(item.step.worktree !== undefined ? { worktree: item.step.worktree } : {}),
				utilityDispatch: true,
				stripLegionIdentity: true,
			});
			await persistChild(store, runId, orchestrator, handle.name);
			input.onUtilityChild(async () => {
				try {
					await orchestrator.retire(handle.name);
					await persistChild(store, runId, orchestrator, handle.name);
				} catch {
					// Shutdown cleanup is best-effort; the supervisor owns final process state.
				}
			});
			return {
				item,
				value: {
					name: handle.name,
					agent: item.agent.name,
					sessionFile: handle.sessionFile,
					orchestrator,
				},
			};
		} catch (error) {
			return {
				item,
				error: error instanceof Error ? error.message : String(error),
			};
		}
	}));
	const handles: Array<{
		name: string;
		agent: string;
		sessionFile: string;
		orchestrator: Orchestrator;
	}> = [];
	for (const launch of launches) {
		if ("error" in launch) results.push(`✗ ${launch.item.agent.name}: ${launch.error}`);
		else handles.push(launch.value);
	}

	const collected = await Promise.all(handles.map(async (handle) => {
		try {
			const result = await handle.orchestrator.collect(handle.name, {
				timeoutMs,
				...(input.signal ? { signal: input.signal } : {}),
			});
			await persistChild(store, runId, handle.orchestrator, handle.name);
			const lines = [
				`── ${handle.name} ──`,
				`execution: ${result.execution.status}${result.execution.reason ? ` (${result.execution.reason})` : ""}`,
				result.output || "(no output)",
			];
			if (result.outputFile) lines.push(`outputFile: ${result.outputFile}`);
			lines.push(`sessionFile: ${handle.sessionFile}`);
			return lines.join("\n");
		} catch (error) {
			return `✗ ${handle.name}: collect failed: ${error instanceof Error ? error.message : String(error)}\nsessionFile: ${handle.sessionFile}`;
		}
	}));
	if (input.signal?.aborted) return ok("interrupted (parent turn aborted)");
	results.push(...collected);
	return {
		content: [{ type: "text", text: results.join("\n\n") || "No utility agents were launched." }],
		details: {
			runId,
			handles: handles.map(({ name, agent, sessionFile }) => ({ name, agent, sessionFile })),
			async: false,
		},
	};
}

export function buildPlan(params: {
	agent?: string;
	task?: string;
	preset?: string;
	tasks?: Array<{
		agent: string;
		task: string;
		model?: string;
		preset?: string;
		worktree?: boolean;
		verify?: string[];
	}>;
	worktree?: boolean;
	verify?: string[];
}): Plan {
	const hasSingle = isPresent(params.agent) && isPresent(params.task);
	const hasTasks = Boolean(params.tasks?.length);
	const count = Number(hasSingle) + Number(hasTasks);

	if (count === 0)
		return {
			ok: false,
			message: "Provide one of: (agent+task) or tasks[].",
		};
	if (count > 1)
		return {
			ok: false,
			message: "Provide exactly one of: (agent+task) or tasks[].",
		};

	if (hasSingle) {
		return {
			ok: true,
			task: params.task as string,
			steps: [
				{
					agent: params.agent as string,
					task: params.task as string,
					...(params.preset ? { preset: params.preset } : {}),
				},
			],
		};
	}

	// `tasks[]` entries were previously taken on trust, so a missing or blank
	// `agent`/`task` produced a step that launched a child with nothing to do (or
	// an empty agent name that failed later, after resources were allocated).
	// Validate every entry up front instead.

	const tasks = params.tasks as PlanStep[];
	const problem = firstInvalidStep(tasks, "tasks[]");
	if (problem) return { ok: false, message: problem };
	return { ok: true, task: `${tasks.length} parallel tasks`, steps: tasks };
}

/** One entry of `tasks[]`. */
interface PlanStep {
	agent: string;
	task: string;
	model?: string;
	preset?: string;
	worktree?: boolean;
	verify?: string[];
}

/**
 * True when a value is a non-blank string.
 * `Boolean("   ")` is true, so a whitespace-only task would otherwise pass and
 * launch a child with a meaningless prompt.
 */
function isPresent(value: unknown): boolean {
	return typeof value === "string" && value.trim().length > 0;
}

/**
 * Report the first entry that would launch a child with nothing to do.
 * Returns `null` when every entry is usable.
 */
function firstInvalidStep(steps: PlanStep[], label: string): string | null {
	for (let i = 0; i < steps.length; i += 1) {
		const step = steps[i] ?? ({} as PlanStep);
		if (!isPresent(step.agent))
			return `${label}: step ${i + 1} has no \`agent\`.`;
		if (!isPresent(step.task)) {
			return `${label}: step ${i + 1} has an empty \`task\`.`;
		}
	}
	return null;
}

/**
 * Keep a live child on the session runtime so the input-box widget can
 * show it, and so a background collect can wake the parent.
 *
 * If a watch is already in flight (steer mid-turn), leave it: that collect
 * covers the current turn. Starting a second watch would double-notify.
 */
function followJob(
	runtime: SessionRuntime,
	input: {
		name: string;
		runId: string;
		agent: string;
		sessionFile: string;
		timeoutMs: number;
		orchestrator: Orchestrator;
		store: RunStore;
		watch: boolean;
		treeIdentity?: { nodeId: string; parentId: string | null; depth: number };
	},
): void {
	const child = input.orchestrator
		.childrenSnapshot()
		.find((entry) => entry.name === input.name);
	const existing = runtime.get(input.name);
	runtime.track({
		name: input.name,
		runId: input.runId,
		agent: input.agent,
		sessionFile: input.sessionFile,
		timeoutMs: input.timeoutMs,
		...(child?.kind ? { kind: child.kind } : {}),
		...(child?.model ? { model: child.model } : {}),
		...(child?.thinking !== undefined ? { thinking: child.thinking } : {}),
		...(child?.worktreeBranch ? { worktreeBranch: child.worktreeBranch } : {}),
		...(input.treeIdentity ? input.treeIdentity : child?.nodeId ? {
			nodeId: child.nodeId,
			parentId: child.nodeId.includes(".") ? child.nodeId.slice(0, child.nodeId.lastIndexOf(".")) : null,
			depth: child.nodeId.split(".").length - 1,
		} : {}),
		collect: (opts) =>
			input.orchestrator.collect(input.name, {
				timeoutMs: input.timeoutMs,
				...(opts?.signal ? { signal: opts.signal } : {}),
			}),
		persist: async () =>
			persistChild(input.store, input.runId, input.orchestrator, input.name),
		retire: async () => {
			await input.orchestrator.retire(input.name);
			await persistChild(
				input.store,
				input.runId,
				input.orchestrator,
				input.name,
			);
		},
		handleBlocked: async (snapshot) => {
			const current = input.orchestrator
				.childrenSnapshot()
				.find((entry) => entry.name === input.name);
			const ui = blockedUi.get(runtime);
			const decision = await applyOnBlockedPolicy({
				policy: current?.onBlocked ?? "forward",
				name: input.name,
				reason: snapshot.execution.reason,
				confirm: ui?.getConfirm(),
				approve: () => input.orchestrator.approveBlocked(input.name),
				reject: () => input.orchestrator.rejectBlocked(input.name),
				notify: (message) => {
					ui?.notifyBlocked(message);
				},
			});
			return followUpFor(decision);
		},
	});
	if (!input.watch) return;
	if (existing?.watching) return;
	runtime.watch(input.name);
}

function followChild(ctx: ChildContext, opts: { watch: boolean }): void {
	const timeoutMs =
		findControlAgent(
			ctx.agents,
			ctx.allAgents,
			ctx.found.child.agent,
		)?.timeoutMs ?? DEFAULTS.turnTimeoutMs;
	followJob(ctx.runtime, {
		name: ctx.name,
		runId: ctx.found.runId,
		agent: ctx.found.child.agent ?? "subagent",
		sessionFile: ctx.found.child.sessionFile,
		timeoutMs,
		orchestrator: ctx.orchestrator,
		store: ctx.store,
		watch: opts.watch,
		...(ctx.found.child.nodeId ? {
			treeIdentity: {
				nodeId: ctx.found.child.nodeId,
				parentId: ctx.found.child.nodeId.includes(".") ? ctx.found.child.nodeId.slice(0, ctx.found.child.nodeId.lastIndexOf(".")) : null,
				depth: ctx.found.child.nodeId.split(".").length - 1,
			},
		} : {}),
	});
}

function followLaunched(
	session: LaunchSession,
	name: string,
	opts: { watch: boolean },
): void {
	const child = session.orchestrator
		.childrenSnapshot()
		.find((c) => c.name === name);
	followJob(session.runtime, {
		name,
		runId: session.runId,
		agent: child?.agent ?? name,
		sessionFile: child?.sessionFile ?? "",
		timeoutMs: session.timeoutByName.get(name) ?? DEFAULTS.turnTimeoutMs,
		orchestrator: session.orchestrator,
		store: session.store,
		watch: opts.watch,
		...(child?.nodeId ? {
			treeIdentity: {
				nodeId: child.nodeId,
				parentId: child.nodeId.includes(".") ? child.nodeId.slice(0, child.nodeId.lastIndexOf(".")) : null,
				depth: child.nodeId.split(".").length - 1,
			},
		} : {}),
	});
}

/**
 * Persist the orchestrator's current view of one child.
 *
 * RunStore is async while Orchestrator's `onChildUpdate` is synchronous, so
 * persistence is done explicitly here rather than from inside the callback
 * (which would leave floating promises).
 */
async function persistChild(
	store: RunStore,
	runId: string,
	orchestrator: Orchestrator,
	name: string,
	opts: { preserveRetired?: boolean } = {},
): Promise<void> {
	const child = orchestrator.childrenSnapshot().find((c) => c.name === name);
	if (!child) return;
	try {
		const recorded = store.findChild(runId, name);
		if (!recorded) {
			await store.addChild(runId, child);
			return;
		}
		if (recorded.nodeId !== child.nodeId) return;
		await store.updateChild(runId, name, (current) => {
			if (opts.preserveRetired && current.state === "retired" && child.state !== "retired") return;
			Object.assign(current, child);
		});
	} catch {
		// Persistence is best-effort when a competing lifecycle callback wins the write.
	}
}

async function abandonLaunchedChild(session: LaunchSession, name: string): Promise<void> {
	const child = session.orchestrator.childrenSnapshot().find((entry) => entry.name === name);
	if (!child) return;
	if (child.state === "retired") {
		session.runtime.release(name);
		return;
	}
	child.execution = { status: "failed", reason: "launch abandoned because parent turn aborted" };
	child.acceptance = { status: "rejected", level: "none", reason: "aborted by parent" };
	try {
		await session.orchestrator.retire(name);
		await persistChild(session.store, session.runId, session.orchestrator, name);
		session.runtime.release(name);
		session.results.push(`✗ ${name}: abandoned because parent turn aborted (child retired)`);
	} catch (error) {
		await persistChild(session.store, session.runId, session.orchestrator, name);
		followLaunched(session, name, { watch: true });
		session.results.push(`✗ ${name}: abandon retire failed: ${String(error)}; completion remains watched`);
	}
}

// ---------------------------------------------------------------------------
// wait (§1.5): block for results instead of relying on async notices
// ---------------------------------------------------------------------------

/**
 * Resolve which children a wait targets.
 *
 * `all` covers every LIVE child of this session runtime (working or blocked);
 * `name` targets one. Both pre-check against the runtime so an untracked name
 * fails loudly instead of hanging on a wait that can never resolve.
 */
export function resolveWaitTargets(
	params: { name?: string; all?: boolean },
	jobs: Array<{ name: string; state: string }>,
): { ok: true; names: string[] } | { ok: false; message: string } {
	const live = jobs.filter(
		(job) => job.state === "working" || job.state === "blocked",
	);
	if (params.all) {
		if (live.length === 0) {
			return { ok: false, message: "no running children to wait for." };
		}
		return { ok: true, names: live.map((job) => job.name) };
	}
	const name = params.name;
	if (!name) return { ok: false, message: "`name` or `all` is required for wait" };
	if (live.some((job) => job.name === name)) {
		return { ok: true, names: [name] };
	}
	return {
		ok: false,
		message: `unknown child: ${name} (not a live child of this session).`,
	};
}

/** Render one wait result, reusing the collect shape for finished children. */
export function renderWait(results: WaitResult[]): string {
	let done = 0;
	let running = 0;
	let interrupted = 0;
	const parts: string[] = [];
	for (const result of results) {
		if (result.snapshot) {
			done += 1;
			parts.push(renderCollect(result.name, result.snapshot));
		} else if (result.stillRunning) {
			running += 1;
			parts.push(`── ${result.name} ──\nstill running`);
		} else if (result.interrupted) {
			interrupted += 1;
			parts.push(`── ${result.name} ──\ninterrupted (parent turn aborted)`);
		} else {
			parts.push(`── ${result.name} ──\nnot tracked (no live job, no finished cache)`);
		}
	}
	parts.push(`${done} done, ${running} still running`);
	if (interrupted > 0) parts.push(`${interrupted} interrupted`);
	return parts.join("\n");
}

/** Gracefully retire a named child or every child tracked by this session. */
export async function stopAction(input: {
	params: { name?: string; all?: boolean };
	runtime: SessionRuntime;
	retire: (name: string) => Promise<void>;
}): Promise<AgentToolResult<unknown>> {
	const { params, runtime, retire } = input;
	if (params.name && params.all) {
		return fail("`name` and `all` are mutually exclusive for stop.", ErrorCodes.INVALID_PARAMS);
	}
	if (!params.name && !params.all) {
		return fail("`name` or `all` is required for stop", ErrorCodes.INVALID_PARAMS);
	}
	const jobs = runtime.activeJobs();
	const active = jobs.filter((job) => job.state !== "retired");
	let targets: string[];
	if (params.all) {
		targets = active.map((job) => job.name);
	} else {
		const target = jobs.find((job) => job.name === params.name);
		if (!target) {
			return fail(`unknown child: ${params.name} (not tracked by this session).`, ErrorCodes.NOT_FOUND);
		}
		targets = target.state === "retired" ? [] : [target.name];
	}
	if (targets.length === 0) return ok("No non-retired children to stop.");

	// Stop every watcher before any retire starts: a later target must not finish
	// its own watch (and notify/release) while an earlier target is being retired.
	for (const name of targets) runtime.cancelWatch(name);

	const stopped: string[] = [];
	const failures: string[] = [];
	for (const name of targets) {
		try {
			// The runtime job may have been released after the target snapshot was
			// taken. The retire adapter can then resolve its persisted run record.
			await retire(name);
			runtime.release(name);
			stopped.push(name);
		} catch (error) {
			// If the graceful-retire chain fails, restore the completion watcher so a
			// still-live child is not orphaned by the explicit stop attempt.
			if (runtime.get(name)) runtime.rewatch(name);
			failures.push(`${name}: ${String(error)}`);
		}
	}
	const summary = stopped.length
		? `Stopped ${stopped.length} child${stopped.length === 1 ? "" : "ren"}: ${stopped.join(", ")}.`
		: "No children were stopped.";
	return failures.length
		? fail(`${summary}\nFailed to stop: ${failures.join("; ")}`, ErrorCodes.RETIRE_FAILED)
		: ok(summary);
}

export async function waitAction(input: {
	params: SubagentParams;
	signal?: AbortSignal;
	runtime: SessionRuntime;
	agents: AgentConfig[];
	allAgents?: AgentConfig[];
	store: RunStore;
	cwd: string;
}): Promise<AgentToolResult<unknown>> {
	const { params, signal, runtime, agents, allAgents = agents, store, cwd } = input;
	const jobs = runtime.activeJobs();
	let targets = resolveWaitTargets(
		{ name: params.name, all: params.all },
		jobs,
	);
	if (!targets.ok) {
		// A name that is merely finished (not live) is still waitable via the
		// runtime's finished cache — probe it with consumeCollect, which is
		// side-effect free for a job that is not in the live set.
		if (params.name && !params.all) {
			const cached = runtime.consumeCollect(params.name);
			if (cached) {
				targets = { ok: true, names: [params.name] };
			} else {
				return unknownChild(params.name, store, cwd);
			}
		} else {
			return fail(targets.message, ErrorCodes.INVALID_PARAMS);
		}
	}
	// Default timeout: the strictest (smallest) role timeout among the
	// targets. Each child's own collect gives up at its role timeout, so a
	// wait that outlasts it only suppresses the notice without buying data.
	const timeoutMs =
		params.timeoutMs ??
		Math.min(
			...targets.names.map((name) => {
				const role = jobs.find((job) => job.name === name)?.agent;
				return (
					findControlAgent(agents, allAgents, role)?.timeoutMs ??
					DEFAULTS.turnTimeoutMs
				);
			}),
		);
	const results = await runtime.wait(targets.names, { timeoutMs, ...(signal ? { signal } : {}) });
	return ok(renderWait(results));
}

export function renderAgentList(
	agents: AgentConfig[],
	team: ActiveTeam,
	teamWarnings: string[],
): string {
	const lines =
		team.name !== DEFAULT_TEAM || teamWarnings.length > 0
			? [
					`Active team: ${team.name} (source: ${team.source})`,
					...teamWarnings.map((warning) => `Warning: ${warning}`),
					"",
				]
			: [];
	if (agents.length === 0) {
		lines.push(
			"No agents found. Add definitions to ~/.pi/agent/agents/*.md or .pi/agents/*.md.",
		);
		return lines.join("\n");
	}
	lines.push(
		...agents.map((a) => {
			const model = a.model ? ` (model: ${a.model})` : "";
			// A frontmatter key that is accepted but does nothing is worse than an
			// unknown one, because the user believes it is in effect.
			const inert = a.unenforcedFields?.length
				? `\n    ⚠ not enforced yet: ${a.unenforcedFields.join(", ")}`
				: "";
			return `${a.name} [${a.source}] — ${a.description}${model}${inert}`;
		}),
	);
	return lines.join("\n");
}

/** Keep team details out of the legacy roster unless they add useful context. */
export function renderParentRoster(
	agents: AgentConfig[],
	team: ActiveTeam,
	teamWarnings: string[],
): string {
	const teamLines =
		team.name !== DEFAULT_TEAM || teamWarnings.length > 0
			? [
					`Active subagent team: ${team.name}`,
					...teamWarnings.map((warning) => `Team warning: ${warning}`),
				]
			: [];
	return [...teamLines, formatAgentRoster(agents)].join("\n");
}

/** Only selected teams and explicit env overrides need to reach child processes. */
function teamForChildren(team: ActiveTeam): { team?: ActiveTeam } {
	return team.name !== DEFAULT_TEAM || team.source === "env" ? { team } : {};
}

/** Prefer a role under the active team, then fall back for existing children. */
function findControlAgent(
	agents: AgentConfig[],
	allAgents: AgentConfig[],
	roleName: string | undefined,
): AgentConfig | undefined {
	if (!roleName) return undefined;
	return (
		agents.find((agent) => agent.name === roleName) ??
		allAgents.find((agent) => agent.name === roleName)
	);
}

function findChild(
	runs: ReturnType<RunStore["listRuns"]>,
	name: string,
): {
	runId: string;
	run: ReturnType<RunStore["listRuns"]>[number];
	child: NonNullable<ReturnType<RunStore["findChild"]>>;
} | null {
	const picked = pickChildByName(runs, name);
	if (!picked) return null;
	return { runId: picked.run.runId, run: picked.run, child: picked.child };
}

function renderChild(
	child: NonNullable<ReturnType<RunStore["findChild"]>>,
	action: string,
): AgentToolResult<unknown> {
	const lines = [
		`${child.name} — state=${child.state} agent=${child.agent ?? "?"} kind=${child.kind ?? "?"}`,
		"supervisor=rpc",
		`session=${child.sessionFile}`,
	];
	if (child.execution) {
		lines.push(
			`execution: ${child.execution.status}${child.execution.reason ? ` (${child.execution.reason})` : ""}`,
		);
		if (child.execution.usage) {
			lines.push(
				`usage: in=${child.execution.usage.input} out=${child.execution.usage.output} cost=${child.execution.usage.cost.toFixed(4)}`,
			);
		}
	}
	if (child.acceptance)
		lines.push(
			`acceptance: ${child.acceptance.status} (${child.acceptance.level})`,
		);
	if (action === "collect" && !child.execution)
		lines.push("(not yet collected — call collect while the agent is alive)");
	return ok(lines.join("\n"));
}

function renderCollect(
	name: string,
	collected: {
		execution: { status: string; reason?: string };
		output: string;
		outputFile?: string;
		acceptance: {
			status: string;
			level?: string;
			reason?: string;
			pendingCriteria?: Array<{
				id: string;
				must: string;
				severity?: string;
			}>;
		};
		blocked?: boolean;
	},
): string {
	const lines = [
		`── ${name} ──`,
		`execution: ${collected.execution.status}${collected.execution.reason ? ` (${collected.execution.reason})` : ""}`,
		`acceptance: ${collected.acceptance.status}${collected.acceptance.level ? ` (${collected.acceptance.level})` : ""}`,
	];
	// The mechanical verify outcome (which command failed / which commands had
	// to pass) is the parent's primary trust anchor — surface it inline.
	if (collected.acceptance.reason && /^(verified by|verification failed)/.test(collected.acceptance.reason)) {
		lines.push(collected.acceptance.reason);
	}
	if (collected.blocked) {
		lines.push(
			"blocked: waiting for child UI approval. Answer the pending request in the parent UI, or steer the child.",
		);
	}

	// L3: semantic criteria the runtime cannot decide. An agent claiming success
	// is exactly the signal that cannot be trusted (F32), so these are handed to
	// the caller as an explicit checklist rather than assumed to hold.
	const pending = collected.acceptance.pendingCriteria ?? [];
	if (pending.length > 0) {
		lines.push(
			`unverified criteria — you must confirm these before trusting the result:`,
		);
		for (const c of pending) {
			const tag = c.severity === "optional" ? " (optional)" : "";
			lines.push(`  [ ] ${c.id}${tag}: ${c.must}`);
		}
	}

	lines.push(collected.output || "(no output)");
	if (collected.outputFile)
		lines.push(
			`full output: ${collected.outputFile} (read this file when the output above is truncated)`,
		);
	return lines.join("\n");
}

function ok(text: string): AgentToolResult<unknown> {
	return { content: [{ type: "text", text }], details: {} };
}

/**
 * Render a failure to the model.
 *
 * `AgentToolResult` has no `isError` field — the error code travels in
 * `details` and the message text carries the failure signal.
 */
function fail(text: string, code: string): AgentToolResult<unknown> {
	return { content: [{ type: "text", text }], details: { error: code } };
}
