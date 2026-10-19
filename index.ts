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
	ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { RpcSupervisor } from "./src/supervisor/rpc-supervisor.ts";
import { InProcessSupervisor } from "./src/supervisor/inprocess-supervisor.ts";
import { RoutingSupervisor } from "./src/supervisor/routing-supervisor.ts";
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
import { providerForModel, type ProviderLookup } from "./src/runs/provider-pin.ts";
import { resolveStepModel } from "./src/agents/step-model.ts";
import { checkModelScope } from "./src/agents/model-scope.ts";
import {
	loadSubagentSettings,
	resolveSubagentSettings,
} from "./src/agents/settings.ts";
import { resolveTeamContext } from "./src/agents/context.ts";
import { createSessionRuntime, renderLiveChildStatus, type SessionRuntime, shouldRecycleAfterCollect, type WaitResult } from "./src/extension/runtime.ts";
import { createDbEventSource, createLegionEventBus, type DbEventSource, type LegionEventBus } from "./src/extension/event-bus.ts";
import { LegionPostman, registerLegionTools, type LegionMailCommand } from "./src/extension/legion-tools.ts";
import { LEGION_DB_ENV, LEGION_NODE_ID_ENV } from "./src/runs/args.ts";
import type { VerifyRunner } from "./src/runs/acceptance.ts";
import { legionDbPath, openLegionDb, type DatabaseSync } from "./src/legion/db.ts";
import { appendEvent } from "./src/legion/events.ts";
import { attachUsageTotals, upsertUsage } from "./src/legion/usage.ts";
import { getChildByName, getChildren, getNode, getSubtree, insertNode, type LegionNode, updateNode } from "./src/legion/nodes.ts";
import { DEFAULT_LEGION_SETTINGS, type LegionSettings } from "./src/shared/types.ts";
import { parseNestedPathEnv } from "./src/shared/nested-path.ts";
import { allocateSiblingNames, isValidAgentName } from "./src/shared/name.ts";
import { deriveOutcome, isLastTurnComplete, parseSessionFile } from "./src/shared/session.ts";
import { restoreHostNodeOptions } from "./src/supervisor/child-memory.ts";
import { currentChildContext } from "./src/supervisor/child-context.ts";
import { setVerifyQueueListener } from "./src/runs/verify-queue.ts";
import { applyEventRetention, checkpoint, formatHygieneReport, hygieneEnabled, runStartupHygiene } from "./src/runs/hygiene.ts";
import {
	createStatusNodeOpener,
	publishSupervisorEvent,
	publishUIRequest,
	registerLegionCommand,
	type RpcEventSource,
	confirmAndStopNode,
} from "./src/extension/legion-commands.ts";
import { DEFAULT_FLUSH_MS, DEFAULT_JOIN_MODE } from "./src/extension/join.ts";
import { registerChildGuard } from "./src/extension/child-guard.ts";
import { registerScoutGuard } from "./src/extension/scout-guard.ts";
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
import { renderSpawnResult } from "./src/extension/spawn-render.ts";
import { PARENT_PLAYBOOK, TOOL_DESCRIPTION } from "./src/extension/playbook.ts";
import { configureSessionErrors, recordSessionError } from "./src/extension/session-errors.ts";
import { getAgentDir } from "./src/agents/paths.ts";
import { expectedModelsFromSettings, parseDoctorSections, runLegionDoctor } from "./src/extension/legion-doctor.ts";
import { readFileSync } from "node:fs";
import {
	effectiveMaxDepth,
	Orchestrator,
	type OrchestratorLegionContext,
} from "./src/runs/orchestrator.ts";
import { RunStore, pickChildByName } from "./src/runs/store.ts";
import { RUN_OWNER_FILE, ownerState } from "./src/runs/owner.ts";
import { resolveLaunchWorktree } from "./src/runs/worktree.ts";
import {
	type AgentConfig,
	type AgentScope,
	DEFAULTS,
	DEFAULT_ON_BLOCKED,
	ErrorCodes,
	type ModelOrigin,
	type RetireOptions,
	type SpawnMode,
	SubagentError,
	type SubagentsSettings,
} from "./src/shared/types.ts";

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
				"Parent decides isolation for this child. true = own git branch, child opens an MR. false = write the current checkout. Reserved for `centurion` (#214): any other role asking for true is downgraded to false with a one-time warning.",
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
				Type.Literal("diagnose"),
			],
			{ description: "Defaults to launch. wait REQUIRES name or all:true (mutually exclusive) — bare wait is rejected. diagnose = Legion doctor self-check (extensions/models/spawn/memory/tools/storage/runtime); optional section filters like /legion doctor." },
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
				"Parent decides isolation. true = isolated git branch, child opens an MR. false = edit the current checkout. Reserved for `centurion` (#214): only a centurion gets a subtree worktree, every other role is downgraded to false with a one-time warning — dispatch a centurion when you need an isolated delivery unit.",
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
		Type.String({
			description:
				"Child handle name. On launch (single agent+task): registers this exact name (lowercase [a-z][a-z0-9_-]{0,31}) instead of auto scout-N; collisions refuse. On wait: REQUIRED unless all:true (mutually exclusive with all). On other control actions (stop/collect/…): addresses that child. For status: omit (or pass all:true) for a live-children overview; pass name for one child.",
		}),
	),
	all: Type.Optional(
		Type.Boolean({
			description: "wait: REQUIRED unless name is set — wait for every live (working/blocked) child; mutually exclusive with name. stop: stop every non-retired child; status: overview of all live (non-retired) children under cwd",
		}),
	),
	timeoutMs: Type.Optional(
		Type.Number({
			description: "wait: per-child timeout in ms; event-driven completion returns early (default: role turnTimeoutMs)",
		}),
	),
	force: Type.Optional(
		Type.Boolean({
			description:
			'stop only: when true, hard-retire via SIGTERM→SIGKILL + descendant sweep (retire hardening). Omit/false = graceful retire. Example: subagent({ action: "stop", name: "worker-0", force: true }).',
		}),
	),
	message: Type.Optional(
		Type.String({ description: "Text for steer/continue" }),
	),
	team: Type.Optional(
		Type.String({ description: "Team to use for the launched child and its nested roster" }),
	),
	section: Type.Optional(
		Type.String({
			description:
				'diagnose only: optional section filter (summary|extensions|models|spawn|memory|tools|storage|runtime|errors|next), same as `/legion doctor [section]`. Space/comma-separated for multiple.',
		}),
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

function runStoreFor(cwd: string, dbPathOverride?: string): RunStore {
	const sharedDbPath = dbPathOverride ?? process.env[LEGION_DB_ENV];
	if (sharedDbPath && path.isAbsolute(sharedDbPath)) {
		const storeRoot = path.dirname(path.dirname(path.dirname(sharedDbPath)));
		return new RunStore({ rootDir: storeRoot });
	}
	return new RunStore({ rootDir: path.join(cwd, ".pi-subagents") });
}

/**
 * Backend THIS process was started on (#209), for `run.json`'s `herdr.supervisor`.
 *
 * A host/root session and an RPC child are both ordinary `pi` processes, so the
 * historic `rpc` marker is the truth for them. An in-process child shares this
 * process, and its backend travels on the ALS child context — the one case where
 * the truthful marker is not `rpc`. Reading it from there (instead of writing a
 * literal) is what stops the record from claiming RPC for an inprocess child.
 */
function currentProcessSpawnMode(): SpawnMode {
	return currentChildContext()?.spawnMode ?? "rpc";
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
	/**
	 * In-process child identity (#197 D8): the orchestrator names the ledger row
	 * this session owns. Wins over `process.env.PI_LEGION_DB/NODE_ID` because an
	 * in-process child shares the parent's env and would otherwise read the
	 * *parent's* identity — or nothing at all when the parent is root.
	 */
	legionNode?: { dbPath: string; nodeId: string } | undefined;
}): LegionRuntimeIdentity | undefined {
	const injected = input.legionNode;
	const dbPath = injected?.dbPath ?? process.env[LEGION_DB_ENV];
	const nodeId = injected?.nodeId ?? process.env[LEGION_NODE_ID_ENV];
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
			// Contract D3: a run synthesized while attaching to an already-existing
			// node has no launch arbitration behind it, so it keeps the historic
			// marker instead of inventing a backend.
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
	const rootRun = input.store.createRun({ task: input.task, cwd: input.cwd, maxDepth: input.maxDepth, nodeId: "root", herdr: { supervisor: currentProcessSpawnMode() } });
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
	const orchestrator = new Orchestrator({ supervisor: input.supervisor, runDir: store.runDir(parentRun.runId), cwd, maxDepth: catalog.settings.legion?.maxDepth, maxSpawns: catalog.settings.maxSubagentSpawnsPerSession ?? null, team: resumedTeam.team, childContext: resolveTeamContext("child", catalog.settings, resumedTeam.team), parentPath: parentRun.path, ...rpcApproveFrom(catalog.settings), legion: { db: input.db, dbPath: input.dbPath, nodeId: parent.id, parentNodeId: parent.parentId, parentRunId: parentOfSupervisor?.runId ?? null, runId: parentRun.runId, runStore: store, settings: input.settings, eventBus: input.eventBus } });
	orchestrator.restore(parentRun);
	const handle = await orchestrator.launch({ agent, task: input.message, name: saved.name, ...(input.node.team ? { team: input.node.team } : {}), ...(saved.model ? { model: saved.model } : {}), worktree: Boolean(saved.worktreePath) });
	await store.updateChild(parentRun.runId, saved.name, (child) => Object.assign(child, handle.child));
}

export default function piLegion(pi: ExtensionAPI, deps: ExtensionSupervisorDeps = {}) {
	// #197 D8: a session is a child if either transport says so. RPC children
	// are separate processes marked in env; in-process children share the
	// parent's `process.env`, so their marker can only come from the
	// AsyncLocalStorage child context the orchestrator injects.
	//
	// Security note: the ALS context does not survive `spawn()`, so a real
	// subprocess (`bash npm test`, a nested CLI, …) cannot inherit this
	// identity. That is exactly the isolation the env channel lacked — see the
	// "healthy ghost nodes" incident documented at the identity credential
	// check in `resolveLegionIdentity`. Do not replace this with env injection.
	const childContext = currentChildContext();
	const isChild = process.env.PI_SUBAGENT_CHILD === "1" || childContext !== undefined;
	const allowNested = process.env[ALLOW_NESTED_ENV] === "1" || childContext?.allowNested === true;
	if (isChild) restoreHostNodeOptions();
	else {
		// Root UI: surface verify-queue waits instead of a silent stall.
		setVerifyQueueListener((event) => {
			try {
				if (event.phase === "waiting") lastUi?.setStatus("legion-verify", `verify queued ${Math.round(event.waitedMs / 1000)}s · ${event.holders}/${event.limit} slots busy`);
				else lastUi?.setStatus("legion-verify", undefined);
			} catch { /* no UI */ }
		});
	}
	const onSpawnRefused = (message: string) => {
		try { lastUi?.notify(`pi-legion: ${message}`, "error"); } catch { /* no UI (child / print mode) */ }
	};
	// Mutable host cwd so inprocess limits can re-read project settings as the
	// extension follows the parent session's working directory (#197).
	let lastCwd = process.cwd();
	const supervisor = deps.supervisor ?? new RoutingSupervisor({
		rpc: new RpcSupervisor({ onSpawnRefused }),
		inprocess: new InProcessSupervisor({
			onSpawnRefused,
			getLimits: () => {
				try {
					return loadSubagentSettings({
						userSettingsPath: path.join(getAgentDir(), "settings.json"),
						projectSettingsPath: path.join(lastCwd, ".pi", "settings.json"),
					}).inprocess;
				} catch {
					return undefined;
				}
			},
		}),
		onSpawnRefused,
	});
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
	let legionIdentity: LegionRuntimeIdentity | undefined;
	const stopLegionRuntime = (): void => {
		if (!legionIdentity) return;
		legionIdentity.postman.stop();
		legionIdentity.dbEventSource.stop();
		// #40: bound the ledger and fold the WAL back before closing.
		if (hygieneEnabled() && !isChild) applyEventRetention(legionIdentity.db);
		else checkpoint(legionIdentity.db);
		legionIdentity.db.close();
		legionIdentity = undefined;
	};
	const initializeLegionRuntime = (ctx: Pick<ExtensionContext, "cwd"> & { sessionFile?: string; legionNode?: { dbPath: string; nodeId: string } }): void => {
		// The injected node's dbPath is authoritative: an in-process child shares the
		// parent's env, so PI_LEGION_DB here belongs to the parent (or is unset).
		const store = runStoreFor(ctx.cwd, ctx.legionNode?.dbPath);
		const settings = loadSubagentSettings({
			userSettingsPath: path.join(getAgentDir(), "settings.json"),
			projectSettingsPath: path.join(ctx.cwd, ".pi", "settings.json"),
		});
		const next = resolveLegionIdentity({ pi, supervisor, store, cwd: ctx.cwd, settings, eventBus: legionBus, cached: legionIdentity, sessionFile: ctx.sessionFile, legionNode: ctx.legionNode });
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
		// #197 D8: an in-process child never sees `session_start` — the SDK emits it
		// from `bindExtensions`, which only rpc / print / interactive modes call;
		// `createAgentSession` does not. So the handler further down is dead for
		// this transport and the injected identity is attached here instead.
		//
		// It is attached on the first ctx-bearing event rather than at extension
		// load: the identity credential (this session's transcript file) only
		// exists on `ctx.sessionManager`, and skipping it would defeat the
		// ghost-node guard inside `resolveLegionIdentity`.
		if (childContext?.nodeId && childContext.dbPath) {
			const legionNode = { dbPath: childContext.dbPath, nodeId: childContext.nodeId };
			let attached = false;
			const attachInjectedChildIdentity = (_event: unknown, ctx?: { cwd?: string; sessionManager?: { getSessionFile?: () => string | undefined } }): void => {
				if (attached) return;
				attached = true;
				try {
					initializeLegionRuntime({
						cwd: ctx?.cwd ?? process.cwd(),
						legionNode,
						sessionFile: ctx?.sessionManager?.getSessionFile?.(),
					});
				} catch (error) {
					console.error(`[pi-legion] legion initialization failed: ${error instanceof Error ? error.message : String(error)}`);
				}
			};
			pi.on("before_agent_start", attachInjectedChildIdentity);
		}
	}
	// #37/#38/#40/#181: one best-effort storage sweep per root process.
	// Deferred 1.5s so interactive first paint is not blocked; unref so a long
	// idle session can exit. Short --print sessions exit before the timer —
	// flushHygieneIfPending on session_shutdown still runs the sweep once.
	let hygieneScheduled = false;
	let hygieneCompleted = false;
	let pendingHygiene: { storeRoot: string; timer?: ReturnType<typeof setTimeout>; notify?: (text: string) => void } | undefined;
	const flushHygieneIfPending = (): void => {
		if (hygieneCompleted || !pendingHygiene || !hygieneEnabled()) return;
		hygieneCompleted = true;
		if (pendingHygiene.timer) {
			clearTimeout(pendingHygiene.timer);
			pendingHygiene.timer = undefined;
		}
		const { storeRoot, notify } = pendingHygiene;
		try {
			const report = runStartupHygiene({ storeRoot, protectRunIds: legionIdentity ? [legionIdentity.rootRunId] : [] });
			const text = formatHygieneReport(report);
			if (text) notify?.(text);
		} catch (error) {
			console.error(`[pi-legion] storage sweep failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	};
	pi.on("session_start", (_event, ctx) => {
		try { initializeLegionRuntime({ cwd: ctx.cwd, sessionFile: ctx.sessionManager?.getSessionFile() }); }
		catch (error) { console.error(`[pi-legion] legion initialization failed: ${error instanceof Error ? error.message : String(error)}`); }
		if (!isChild && !hygieneScheduled && hygieneEnabled()) {
			hygieneScheduled = true;
			const storeRoot = runStoreFor(ctx.cwd).rootDir;
			const timer = setTimeout(() => {
				flushHygieneIfPending();
			}, 1_500);
			timer.unref?.();
			pendingHygiene = {
				storeRoot,
				timer,
				notify: (text) => ctx.ui?.notify?.(text, "info"),
			};
		}
	});
	const pendingUtilityRetires: Array<(opts?: RetireOptions) => Promise<void>> = [];
	let sessionRuntime: SessionRuntime | undefined;
	const shutdownRetireAll = async (_event?: unknown, ctx?: { mode?: string }): Promise<void> => {
		// #181: short --print exits before the deferred timer; flush now so
		// orphan rpc-child-* dirs still get swept on a clean exit.
		if (!isChild) flushHygieneIfPending();
		// pi --print / JSON exits when the parent turn ends. Async children
		// have only just been spawned; retiring them here aborts the run
		// before the first model call. Interactive quit still retires immediately.
		const mode = ctx?.mode;
		if (mode === "print" || mode === "json") {
			await sessionRuntime?.drainBeforeShutdown();
		}
		const children = sessionRuntime?.activeJobs() ?? [];
		sessionRuntime?.dispose();
		const shutdownRetire: RetireOptions = { cause: "session-shutdown" };
		await Promise.all([
			...children.map((job) => job.retire?.(shutdownRetire).catch(() => {})),
			...pendingUtilityRetires.map((retire) => retire(shutdownRetire).catch(() => {})),
		]);
		stopLegionRuntime();
	};
	if (process.env[UTILITY_CHILD_ENV] !== "1") {
		pi.registerTool({
			name: "vexillatio",
			label: "Vexillatio",
			description: "Launch only read-only utility agents and return their collected output.",
			parameters: VexillatioParams,
			// D4: pi never renders `details` on its own, so without this the
			// arbitrated spawnMode in `details.handles[].spawnMode` is invisible.
			renderResult: (result, opts, theme) => renderSpawnResult(result, opts, theme),
			async execute(_id, params, signal, _onUpdate, ctx: ExtensionContext): Promise<AgentToolResult<unknown>> {
				if (signal?.aborted) {
					return ok("interrupted (parent turn ended; children still running)");
				}
				if (!subagentsEnabled(ctx.cwd)) {
					return fail("subagents are disabled (subagents.enabled: false or /legion off). Re-enable with /legion on.", ErrorCodes.DISABLED);
				}
				const runtime = sessionRuntime;
				if (!runtime) return fail("session runtime is not initialized", ErrorCodes.INVALID_PARAMS);
				runtime.bind(ctx);
				const result = await launchUtilityFamily({
					pi,
					ctx,
					runtime,
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
				// `launchUtilityFamily` already folds the abort into its own return
				// (head line + collected segments + `interrupted` details, #227 D4).
				// Returning `result` unconditionally is what keeps that work visible;
				// re-checking `signal.aborted` here would throw it away again.
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
		const parentContext = resolveTeamContext(
			"parent",
			catalog.settings,
			catalog.team,
		);
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
	let lastUi: ExtensionUIContext | undefined;
	/** Child slugs currently reported as OSC id=legion/<slug>. */
	const childOscIds = new Set<string>();
	/** Extension activity sources forwarded from children via RPC. */
	const childActivitySources = new Set<string>();
	let statusNodeOpener: ((nodeId: string) => void) | undefined;
	let lastConfirm: ((message: string) => Promise<boolean>) | undefined;
	// Run-scoped completion deferral lives in the runtime outbox (D-A): a child
	// finishing while this agent run is still active is held until
	// `agent_settled` instead of being queued as an undrained followUp.
	const rpcEventSource = supervisor as LegionSupervisor & RpcEventSource;
	const runtime = createSessionRuntime({
		sendMessage: (message, options) => pi.sendMessage(message, options),
		onStatusNodeClick: (nodeId) => statusNodeOpener?.(nodeId),
		statusStrip: process.env.PI_LEGION_STRIP === "tree" ? "tree" : "railway",
		eventBus: legionBus,
		getTreeNodes: () => {
			const identity = legionIdentity;
			return identity
				? attachUsageTotals(identity.db, getSubtree(identity.db, identity.nodeId))
				: [];
		},
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
		emitBusy: (active, label, children = []) => {
			try { pi.events.emit("pi-legion:busy", active ? { active: true, label } : { active: false }); }
			catch { /* optional display integration */ }
			const ui = lastUi as (ExtensionUIContext & {
				setActivity?: (source: string, activity: { message?: string } | undefined) => void;
				setProgramRecord?: (status: { state: "working" | "clear"; id: string; message?: string }) => void;
			}) | undefined;
			const next = new Set(active ? children : []);
			// Drop RPC-fan-in activities for retired children (and everything on full clear).
			if (typeof ui?.setActivity === "function") {
				for (const source of [...childActivitySources]) {
					const slug = source.startsWith("legion/") ? source.slice("legion/".length).split("/")[0] : undefined;
					if (!active || !slug || !next.has(slug)) {
						try { ui.setActivity(source, undefined); } catch { /* ignore */ }
						childActivitySources.delete(source);
					}
				}
				try {
					ui.setActivity("legion", active ? { message: label } : undefined);
				} catch { /* setActivity is optional until Pi ships it */ }
			}
			if (typeof ui?.setProgramRecord === "function") {
				for (const slug of [...childOscIds]) {
					if (!next.has(slug)) {
						try { ui.setProgramRecord({ id: `legion/${slug}`, state: "clear" }); } catch { /* ignore */ }
						childOscIds.delete(slug);
					}
				}
				for (const slug of next) {
					try {
						ui.setProgramRecord({ id: `legion/${slug}`, state: "working", message: slug });
						childOscIds.add(slug);
					} catch { /* ignore */ }
				}
			}
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

	if (isChild && !allowNested) {
		pi.on("session_shutdown", shutdownRetireAll);
		return;
	}
	// #17: main session only. Children (PI_SUBAGENT_ROLE / PI_SUBAGENT_CHILD)
	// must not count their own reads or inject this reminder. Nested children
	// also have isChild set, so they skip this even though they continue below.
	if (!isChild) {
		registerScoutGuard(pi, {
			loadSettings: (cwd) => loadSubagentSettings({
				userSettingsPath: path.join(getAgentDir(), "settings.json"),
				projectSettingsPath: path.join(cwd, ".pi", "settings.json"),
			}),
			// #182: suppress "拆 scout" nag while launches are forbidden.
			subagentsEnabled: (cwd) => subagentsEnabled(cwd),
		});
	}
	// The parent transcript records every finish; the renderer keeps a
	// completed child to one line so visibility does not cost a screen.
	pi.registerMessageRenderer(SUBAGENT_NOTIFY_TYPE, renderSubagentNotice);

	// User stop controls (/legion stop, idle Esc, `x` in /legion): a thin wrapper
	// over the subagent tool's `stop` action — graceful retire of tracked children.
	// Nova follow-up: `/legion stop --force` can pass `force: true` here (#179).
	const stopChildren = async (params: {
		name?: string;
		all?: boolean;
		force?: boolean;
	}): Promise<{ ok: boolean; text: string }> => {
		const result = await stopAction({
			params,
			runtime,
			retire: async (name, opts) => {
				await runtime.get(name)?.retire?.(opts);
			},
		});
		const text = result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
		const details = result.details as { error?: string } | undefined;
		runtime.refreshUi();
		return { ok: !details?.error, text };
	};
	const commandCatalogLoader = (input: {
		sessionCwd: string;
		runCwd: string;
		scope: AgentScope | undefined;
	}) => loadCatalog(input.sessionCwd, input.runCwd, input.scope);
	const liveOverlayController = registerLegionCommand(pi, {
		bus: legionBus,
		runtime,
		supervisor: rpcEventSource,
		stop: stopChildren,
		childStatus: (name, cwd) => {
			try {
				const store = runStoreFor(cwd);
				const runs = store.listRuns();
				const found = findChild(runs, name);
				if (!found) return undefined;
				const child = found.child;
				const alive = supervisor.isAlive(child.name);
				// Run-dir ownership verdict (#209-3), the same one `subagent status`
				// uses: `alive` is this process's in-memory registry and never holds a
				// child launched elsewhere, so a foreign record needs the owner marker.
				// Undefined while alive — liveness already wins there.
				const owner = ownerVerdictFor(store, runs, child.name, alive);
				return {
					name: child.name,
					state: child.state,
					agent: child.agent,
					kind: child.kind,
					sessionFile: child.sessionFile,
					...(child.execution ? { execution: child.execution } : {}),
					...(child.acceptance
						? { acceptance: { status: child.acceptance.status, level: child.acceptance.level } }
						: {}),
					// run.json records the arbitrated backend; a legacy record has none,
					// and `renderLiveChildStatus` renders that as `unknown` — never `rpc`.
					...(child.spawnMode ? { spawnMode: child.spawnMode } : {}),
					alive,
					...(owner ? { owner } : {}),
				};
			} catch {
				return undefined;
			}
		},
		commands: {
			team: { loadCatalog: commandCatalogLoader },
			agents: { loadCatalog: commandCatalogLoader },
			toggle: {
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
			},
		},
	});
	statusNodeOpener = createStatusNodeOpener(
		pi,
		liveOverlayController,
		() => lastUi,
		() => lastCwd,
		(ui, nodeId) => void confirmAndStopNode(ui, { runtime, stop: stopChildren }, nodeId),
	);

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: TOOL_DESCRIPTION,
		parameters: SubagentParams,

		// D4: the same renderer as `vexillatio` — it reads both detail shapes.
		renderResult: (result, opts, theme) => renderSpawnResult(result, opts, theme),

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
				return ok("interrupted (parent turn ended; children still running)");
			}
			// Master switch: refuse NEW launches with a pointer to the toggle;
			// control actions (status/collect/wait/…) must stay available so a
			// disable with live children remains observable and collectable.
			if (!subagentsEnabled(ctx.cwd) && (action === "launch" || !action)) {
				return fail(
					"subagents are disabled (subagents.enabled: false or /legion off). " +
						"Existing children are unaffected; re-enable with /legion on.",
					ErrorCodes.DISABLED,
				);
			}
			const cwd = params.cwd ?? ctx.cwd;
			const store = runStoreFor(cwd);
			configureSessionErrors({ storeRoot: store.rootDir, tool: "subagent", action });
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
			});

			if (action === "list") return ok(renderAgentList(agents, team, teamWarnings));
			if (action === "diagnose") {
				let sections;
				try {
					sections = parseDoctorSections(
						typeof params.section === "string" ? params.section : undefined,
					);
				} catch (error) {
					return fail(
						error instanceof Error ? error.message : String(error),
						ErrorCodes.INVALID_PARAMS,
					);
				}
				let settings: unknown;
				try {
					settings = JSON.parse(readFileSync(path.join(getAgentDir(), "settings.json"), "utf8"));
				} catch {
					settings = undefined;
				}
				const report = runLegionDoctor({
					agentDir: getAgentDir(),
					cwd,
					storeRoot: store.rootDir,
					expectedModels: expectedModelsFromSettings(settings),
					sampleAgent: agents[0],
					agents,
					sections,
					runtime: {
						liveJobs: runtime.activeJobs().map((job) => ({
							name: job.name,
							state: job.state,
							nodeId: job.nodeId,
						})),
						stopAvailable: true,
						idleEscWired: false,
						legionTools: ["subagent", "vexillatio"],
						allowNestedEnv: process.env[ALLOW_NESTED_ENV] === "1",
					},
				});
				return ok(report.text);
			}

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
				return ok("interrupted (parent turn ended; children still running)");
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
					return ok("interrupted (parent turn ended; children still running)");
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
				// The frozen head line still leads, but the machine facts must
				// survive: `launchFamily` already returns its own interrupted result
				// (frozen head + `runId` + `spawns`) when it observes the abort; this
				// outer net only catches an abort seen after that check. Replacing the
				// whole result with a bare `ok()` used to drop `details.spawns` — the
				// only record of the arbitrated backend once `handles` is cleared (#209/D3).
				const details = result.details;
				const carried =
					details !== null && typeof details === "object" && !Array.isArray(details)
						? (details as Record<string, unknown>)
						: undefined;
				return ok("interrupted (parent turn ended; children still running)", carried);
			}
			return result;
		},
	});

	const bindUi = (_event: unknown, ctx: ExtensionContext): void => {
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
		else if (request.method === "setActivity") {
			const uiExt = ui as ExtensionUIContext & {
				setActivity?: (source: string, activity: { message?: string } | undefined) => void;
			};
			if (typeof uiExt.setActivity !== "function") return;
			const source = `legion/${pending.childName}/${request.source}`;
			if (request.activity) {
				childActivitySources.add(source);
				uiExt.setActivity(source, request.activity);
			} else {
				childActivitySources.delete(source);
				uiExt.setActivity(source, undefined);
			}
		} else if (request.method === "setProgramRecord") {
			const record = request.record;
			const uiExt = ui as ExtensionUIContext & {
				setProgramRecord?: (status: {
					state: "idle" | "working" | "blocked" | "done" | "error" | "clear";
					id: string;
					app?: string;
					kind?: "permission" | "question" | "auth";
					message?: string;
				}) => void;
			};
			if (typeof uiExt.setProgramRecord !== "function") return;
			const id = record.id.startsWith("legion/")
				? record.id
				: `legion/${pending.childName}/${record.id}`;
			uiExt.setProgramRecord({ ...record, id });
		}
	});

	pi.on("session_start", (event, ctx) => {
		bindUi(event, ctx);
	});
	pi.on("session_info_changed", bindUi);
	pi.on("turn_start", (event, ctx) => {
		bindUi(event, ctx);
	});
	pi.on("turn_end", (event, ctx) => {
		bindUi(event, ctx);
	});
	pi.on("agent_start", (event, ctx) => {
		runtime.notifyParentRunStart();
		bindUi(event, ctx);
	});
	pi.on("agent_end", (event, ctx) => {
		bindUi(event, ctx);
	});
	pi.on("agent_settled", (event, ctx) => {
		runtime.notifyParentSettled();
		bindUi(event, ctx);
	});
	pi.on("input", bindUi);
	pi.on("tool_result", (_event, ctx) => {
		bindUi(_event, ctx);
		runtime.refreshUi();
	});
	pi.on("session_shutdown", shutdownRetireAll);
}

/**
 * Load the effective agent catalog for a request.
 *
 * User settings (`~/.pi/agent/settings.json`) merge
 * with project `.pi/settings.json`. Agent directories are resolved from the
 * run's `cwd`. Bundled roles are included unless `subagents.disableBuiltins`
 * opts out.
 *
 * Also returns the discovery directories, for listings that tell the user
 * WHERE the roles came from (the /legion agents command).
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
				"`name` or `all` is required for wait (try all:true or name:\"child-name\")",
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
		const force = params.force === true;
		const retireOpts = force ? { graceful: false as const } : undefined;
		return stopAction({
			params,
			runtime: input.runtime,
			store: input.store,
			retire: async (name, opts) => {
				const merged = opts ?? retireOpts;
				const job = input.runtime.get(name);
				if (job?.retire) {
					await job.retire(merged);
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
					childContext: resolveTeamContext("child", input.settings, input.team),
					...teamForChildren(input.team),
					...rpcApproveFrom(input.settings),
					...(input.legion ? { legion: { ...input.legion, runId: found.runId, runStore: input.store } } : {}),
					onBudgetRefused: input.onBudgetRefused,
				});
				orchestrator.restore(found.run);
				await orchestrator.retire(name, merged);
				await persistChild(input.store, found.runId, orchestrator, name);
			},
		});
	}

	// status: no name (or all:true) → live-children overview; named → one child.
	if (action === "status") {
		if (params.name && params.all) {
			return fail(
				"`name` and `all` are mutually exclusive for status.",
				ErrorCodes.INVALID_PARAMS,
			);
		}
		if (!params.name) {
			const runs = store.listRuns();
			const live = listLiveChildrenForStatus(runs);
			return ok(
				renderStatusOverview(
					live.map((child) => {
						const alive = input.supervisor.isAlive(child.name);
						const owner = ownerVerdictFor(store, runs, child.name, alive);
						// A pid only exists for a child this process actually tracks; a
						// record from another session has none, and none is invented.
						const pid = input.runtime.get(child.name)?.pid;
						return { child, alive, ...(owner ? { owner } : {}), ...(pid ? { pid } : {}) };
					}),
				),
			);
		}
		const runs = store.listRuns();
		const found = findChild(runs, params.name);
		if (!found) return unknownChild(params.name, store, cwd);
		const alive = input.supervisor.isAlive(params.name);
		const owner = ownerVerdictFor(store, runs, params.name, alive);
		return ok(renderLiveChildStatus({
			name: found.child.name,
			state: found.child.state,
			agent: found.child.agent,
			kind: found.child.kind,
			sessionFile: found.child.sessionFile,
			execution: found.child.execution,
			acceptance: found.child.acceptance,
			spawnMode: found.child.spawnMode,
			alive,
			...(owner ? { owner } : {}),
		}));
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
		childContext: resolveTeamContext("child", input.settings, input.team),
		verifyRunner: input.verifyRunner,
		worktreeBootstrap: input.settings.legion?.worktreeBootstrap,
		worktreeBootstrapTimeoutMs: input.settings.legion?.worktreeBootstrapTimeoutMs,
		...teamForChildren(input.team),
		...rpcApproveFrom(input.settings),
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
	/** Always set: named control actions reject a request without a name. */
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
		if (signal?.aborted) return ok("interrupted (parent turn ended; children still running)");
		const pending = signal
			? ctx.runtime.consumeCollectInterruptible(ctx.name, signal)
			: ctx.runtime.consumeCollect(ctx.name);
		if (pending) {
			const collected = await pending;
			if (!collected || signal?.aborted) return ok("interrupted (parent turn ended; children still running)");
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
			return ok("interrupted (parent turn ended; children still running)");
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

/** Retire the child while preserving its outcome and session for resume. */
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
				`Child stopped; session kept for resume: ${child.sessionFile}`,
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
				`${action === "resume" ? "Resumed" : "Continued"} ${name} (live child steered).`,
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
	const nameGate = resolveExplicitLaunchName(params.name, plan.steps.length);
	if (!nameGate.ok) return fail(nameGate.message, ErrorCodes.INVALID_PARAMS);

	onUpdate?.({
		content: [
			{
				type: "text",
				text: `playbook: ${plan.steps.map((s) => s.agent).join(", ")} → launch → watch`,
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
			...(legion ? { path: parseNestedPathEnv(process.env.PI_SUBAGENT_PARENT_PATH), nodeId: legion.nodeId, herdr: { supervisor: currentProcessSpawnMode(), node_id: legion.nodeId } } : { herdr: { supervisor: currentProcessSpawnMode() } }),
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
		childContext: resolveTeamContext("child", settings, input.team),
		verifyRunner: input.verifyRunner,
		worktreeBootstrap: settings.legion?.worktreeBootstrap,
		worktreeBootstrapTimeoutMs: settings.legion?.worktreeBootstrapTimeoutMs,
		...teamForChildren(input.team),
		...rpcApproveFrom(settings),
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
		modelRegistry: ctx.modelRegistry,
		results: [],
		handles: [],
		timeoutByName: new Map(),
		// #209/D3: the arbitrated mode survives `handles` being cleared on an
		// abort (interrupted results run after that), so it is kept per name
		// here — same precedent as `timeoutByName`.
		spawnByName: new Map(),
		pidByName: new Map(),
		...(nameGate.name ? { launchName: nameGate.name } : {}),
	};

	/** `details.spawns` for the handles this request actually resolved. */
	const spawnDetails = () => {
		const spawns = [...session.spawnByName.values()];
		return spawns.length > 0 ? { spawns } : {};
	};

	const interruptedResult = async (): Promise<AgentToolResult<unknown> | undefined> => {
		if (!input.signal?.aborted) return undefined;
		for (const name of session.handles) await abandonLaunchedChild(session, name);
		session.handles.length = 0;
		return {
			content: [{ type: "text", text: session.results.join("\n") || "interrupted (parent turn ended; children still running)" }],
			details: { runId: run.runId, handles: [], async: params.async ?? true, ...spawnDetails() },
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
			"↳ async: a completion message is queued when each child finishes. It wakes this session when idle; otherwise it is delivered after the current turn. Use wait or collect for results. Do not tell children to message the parent.",
		);
	}

	return {
		content: [{ type: "text", text: session.results.join("\n") }],
		details: { runId: run.runId, handles: session.handles, async: isAsync, ...spawnDetails() },
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
	/** Parent registry, used to pin `--provider` for ambiguous model ids (#123). */
	modelRegistry: ProviderLookup | undefined;
	results: string[];
	handles: string[];
	timeoutByName: Map<string, number>;
	/** Arbitrated backend per resolved handle; survives an abort clearing `handles`. */
	spawnByName: Map<string, { name: string; agent: string; spawnMode: SpawnMode }>;
	/**
	 * Own process of an `rpc` child, keyed by name — same reason `timeoutByName`
	 * exists: `Handle.pid` is not persisted, so a re-follow from `ChildRecord`
	 * cannot recover it. Kept out of `spawnByName` so `details.spawns` (a
	 * renderer input) keeps its published shape.
	 */
	pidByName: Map<string, number>;
	/** Explicit child name for this single-step launch; omit to auto-allocate. */
	launchName?: string;
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

		// Honor `name=` when the caller asked for one; otherwise let `launch()`
		// allocate from the supervisor-local registry (scout-N). The index must
		// not race separate subagent tool calls for auto names.
		const handle = await session.orchestrator.launch({
			agent: launchedAgent,
			task: step.task,
			...(session.launchName ? { name: session.launchName } : {}),
			...(session.teamOverride ? { team: session.teamOverride } : {}),
			...(resolved.model ? { model: resolved.model } : {}),
			// Pin the provider (#123): a bare id like `workbuddy/...` may also
			// exist under a static auth-less provider in models.json; under
			// `--no-extensions` the child would resolve it there and die with
			// "No API key found". The parent registry knows the live provider.
			...(resolved.model ? { modelProvider: providerForModel(session.modelRegistry, resolved.model) } : {}),
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
		// Recorded before the abort check below: an interrupted result runs after
		// `handles` is cleared and still has to name the arbitrated backend.
		session.spawnByName.set(handle.name, {
			name: handle.name,
			agent: effective.name,
			spawnMode: handle.spawnMode,
		});
		if (handle.pid) session.pidByName.set(handle.name, handle.pid);
		if (effective.timeoutMs !== undefined) {
			session.timeoutByName.set(handle.name, effective.timeoutMs);
		}
		if (session.signal?.aborted) {
			await abandonLaunchedChild(session, handle.name);
			return;
		}
		session.results.push(
			`▶ ${handle.name} (${effective.name}) supervisor=${handle.spawnMode}`,
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
					text: `playbook: ${handle.name} started (supervisor=${handle.spawnMode})`,
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
		return `✗ unknown agent "${requested}" in team "${teamName}". Available: ${available}. Switch with /legion team use ${teamName} (or "default").`;
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
			session.results.push("interrupted (parent turn ended; children still running)");
			return;
		}
		try {
			const collected = await session.orchestrator.collect(name, {
				timeoutMs: session.timeoutByName.get(name) ?? DEFAULTS.turnTimeoutMs,
				...(signal ? { signal } : {}),
			});
			if (signal?.aborted || collected.execution.reason === "aborted by parent") {
				session.results.push("interrupted (parent turn ended; children still running)");
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
	runtime: SessionRuntime;
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
	onUtilityChild: (retire: (opts?: RetireOptions) => Promise<void>) => void;
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
		const selectedAgent = findAgent(catalog.agents, step.agent);
		const fallbackAgent = findAgent(catalog.allAgents, step.agent);
		const teamMembers = catalog.settings.teams?.[catalog.team.name]?.members ?? [];
		const explicitlyMentionedByTeam = Boolean(
			!selectedAgent &&
			fallbackAgent &&
			catalog.team.name !== DEFAULT_TEAM &&
			teamMembers.some((member) => {
				const reference = typeof member === "string" ? member.trim() : member.agent.trim();
				if (reference === "*") return false;
				return findAgent(catalog.allAgents, reference)?.name === fallbackAgent.name;
			}),
		);
		if (explicitlyMentionedByTeam) {
			return fail(
				unknownAgentLineForCatalog(
					catalog.agents,
					catalog.allAgents,
					step.agent,
					catalog.team,
					catalog.settings,
				),
				ErrorCodes.INVALID_PARAMS,
			);
		}
		const agent = selectedAgent ?? fallbackAgent;
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
			herdr: { supervisor: currentProcessSpawnMode() },
		});
	if (!run) return fail("vexillatio parent run is not available", ErrorCodes.NOT_FOUND);
	const runId = run.runId;
	const timeoutMs = input.params.timeoutMs ?? 600_000;
	// §2.6: continue numbering from this parent's existing children only —
	// do NOT scan store.listRuns() (that made names climb across sessions, #42).
	const existingNames: string[] = legion
		? getChildren(legion.db, legion.nodeId).map((child) => child.name)
		: run.children.map((child) => child.name);
	const allocated = allocateSiblingNames(
		prepared.map((item) => item.agent.name),
		existingNames,
		(name) => input.supervisor.isAlive(name),
	);
	const names = new Map<UtilityTaskItem, string>();
	for (let i = 0; i < prepared.length; i++) names.set(prepared[i]!.step, allocated[i]!);

	const results: string[] = [];
	const stillRunning = new Set<string>();
	const launches = await Promise.all(prepared.map(async (item) => {
		const cwd = item.step.cwd ? path.resolve(input.cwd, item.step.cwd) : input.cwd;
		const orchestrator = new Orchestrator({
			supervisor: input.supervisor,
			uiProxy: input.uiProxy,
			runDir: legion?.runDir ?? store.runDir(runId),
			cwd,
			maxDepth: catalog.settings.legion?.maxDepth,
			maxSpawns: catalog.settings.maxSubagentSpawnsPerSession ?? null,
			childContext: resolveTeamContext("child", catalog.settings, catalog.team),
			team: catalog.team,
			...rpcApproveFrom(catalog.settings),
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
				// Provider pin (#123) — see launchStep for the rationale.
				...(item.resolved.model ? { modelProvider: providerForModel(input.ctx.modelRegistry, item.resolved.model) } : {}),
				modelOrigin: item.modelOrigin,
				...(item.step.worktree !== undefined ? { worktree: item.step.worktree } : {}),
				utilityDispatch: true,
				stripLegionIdentity: true,
			});
			await persistChild(store, runId, orchestrator, handle.name);
			let retirement: Promise<void> | undefined;
			const retire = (opts?: RetireOptions): Promise<void> => {
				if (!retirement) {
					const current = (async () => {
						await orchestrator.retire(handle.name, opts);
						await persistChild(store, runId, orchestrator, handle.name);
					})();
					retirement = current;
					void current.catch(() => {
						if (retirement === current) retirement = undefined;
					});
				}
				return retirement;
			};
			input.onUtilityChild(async (opts) => {
				try {
					await retire(opts);
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
					spawnMode: handle.spawnMode,
					...(handle.pid ? { pid: handle.pid } : {}),
					orchestrator,
					retire,
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
		spawnMode: SpawnMode;
		pid?: number;
		orchestrator: Orchestrator;
		retire: (opts?: RetireOptions) => Promise<void>;
	}> = [];
	for (const launch of launches) {
		if ("error" in launch) results.push(`✗ ${launch.item.agent.name}: ${launch.error}`);
		else handles.push(launch.value);
	}

	const followUtility = (handle: (typeof handles)[number], watch: boolean): void => {
		followJob(input.runtime, {
			name: handle.name,
			runId,
			agent: handle.agent,
			sessionFile: handle.sessionFile,
			timeoutMs,
			// Arbitrated at launch; never re-derived here (#209).
			spawnMode: handle.spawnMode,
			...(handle.pid ? { pid: handle.pid } : {}),
			orchestrator: handle.orchestrator,
			store,
			watch,
			retire: handle.retire,
		});
	};
	for (const handle of handles) followUtility(handle, false);

	const collected = await Promise.all(handles.map(async (handle) => {
		try {
			const result = await handle.orchestrator.collect(handle.name, {
				timeoutMs,
				...(input.signal ? { signal: input.signal } : {}),
			});
			await persistChild(store, runId, handle.orchestrator, handle.name);
			if (result.blocked || !shouldRecycleAfterCollect(result.execution.status)) {
				followUtility(handle, true);
				stillRunning.add(handle.name);
			} else {
				await handle.retire();
				input.runtime.release(handle.name);
			}
			const lines = [
				`── ${handle.name} ──`,
				`execution: ${result.execution.status}${result.execution.reason ? ` (${result.execution.reason})` : ""}`,
				result.output || "(no output)",
			];
			if (result.outputFile) lines.push(`outputFile: ${result.outputFile}`);
			lines.push(`sessionFile: ${handle.sessionFile}`);
			return lines.join("\n");
		} catch (error) {
			if (input.supervisor.isAlive(handle.name)) {
				followUtility(handle, true);
				stillRunning.add(handle.name);
			} else {
				await handle.retire().catch(() => {});
				input.runtime.release(handle.name);
			}
			return `✗ ${handle.name}: collect failed: ${error instanceof Error ? error.message : String(error)}\nsessionFile: ${handle.sessionFile}`;
		}
	}));
	if (input.signal?.aborted) return interruptedUtilityResult({
		runId,
		handles,
		stillRunning,
		results,
		collected,
	});
	results.push(...collected);
	return {
		content: [{ type: "text", text: results.join("\n\n") || "No utility agents were launched." }],
		details: {
			runId,
			handles: handles.map(({ name, agent, sessionFile, spawnMode }) => ({ name, agent, sessionFile, spawnMode })),
			async: false,
			...(stillRunning.size > 0
				? { stillRunning: handles.filter(({ name }) => stillRunning.has(name)).map(({ name }) => name) }
				: {}),
		},
	};
}

/**
 * Build the interrupted vexillatio result from what the collect loop already produced.
 *
 * `#227 D4`: an abort must not throw away work that already finished. The frozen
 * head line stays first and verbatim (`test/unit/teams.test.ts` matches it with a
 * regex), the collected segments are appended below it, and `details` carries the
 * same machine facts a non-interrupted return publishes plus `interrupted: true`.
 *
 * With no handles (every launch failed) the text degrades to the head line plus
 * the failure lines only — no empty segment.
 */
function interruptedUtilityResult(input: {
	runId: string;
	handles: Array<{ name: string; agent: string; sessionFile: string; spawnMode?: SpawnMode }>;
	stillRunning: Set<string>;
	results: string[];
	collected: string[];
}): AgentToolResult<unknown> {
	const head = "interrupted (parent turn ended; children still running)";
	const segments = [...input.results, ...input.collected].filter((segment) => segment.length > 0);
	const stillRunning = input.handles
		.filter(({ name }) => input.stillRunning.has(name))
		.map(({ name }) => name);
	// Routed through `ok()` so the widened `details` parameter has exactly one
	// real consumer instead of being a dead signature (#227 review F3).
	return ok(segments.length > 0 ? `${head}\n\n${segments.join("\n\n")}` : head, {
		runId: input.runId,
		handles: input.handles.map(({ name, agent, sessionFile, spawnMode }) => ({
			name,
			agent,
			sessionFile,
			// Optional on purpose: a legacy handle must render as absent, never `rpc`.
			...(spawnMode ? { spawnMode } : {}),
		})),
		async: false,
		interrupted: true,
		...(stillRunning.length > 0 ? { stillRunning } : {}),
	});
}

/**
 * Resolve an explicit `name=` on launch.
 *
 * Prefer honoring the caller's handle over auto `role-N`, so `/legion status <name>`
 * and control actions match the tool parameter. Multi-step `tasks[]` cannot share
 * one name; invalid grammar is refused rather than silently sanitized into a
 * different handle the caller would not find.
 */
export function resolveExplicitLaunchName(
	requested: string | undefined,
	stepCount: number,
): { ok: true; name?: string } | { ok: false; message: string } {
	if (requested === undefined) return { ok: true };
	const trimmed = requested.trim();
	if (!trimmed) {
		return { ok: false, message: "`name` must not be blank when provided." };
	}
	if (stepCount > 1) {
		return {
			ok: false,
			message:
				"`name` applies only to a single (agent+task) launch, not tasks[] with multiple steps.",
		};
	}
	const normalized = trimmed.toLowerCase();
	if (!isValidAgentName(normalized)) {
		return {
			ok: false,
			message:
				`invalid child name "${trimmed}": must match [a-z][a-z0-9_-]{0,31} (lowercase letter first, max 32 chars).`,
		};
	}
	return { ok: true, name: normalized };
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
		retire?: (opts?: RetireOptions) => Promise<void>;
		treeIdentity?: { nodeId: string; parentId: string | null; depth: number };
		/** Arbitrated backend from `Handle.spawnMode`; omitted when unknown (#209). */
		spawnMode?: SpawnMode;
		/**
		 * Own process of an `rpc` child (`Handle.pid`), for the memory probe.
		 * Omitted when the caller has no handle at hand — a rebuilt orchestrator
		 * only knows `ChildRecord`, and a pid is not persisted, so it must not be
		 * guessed or looked up elsewhere.
		 */
		pid?: number;
	},
): void {
	const child = input.orchestrator
		.childrenSnapshot()
		.find((entry) => entry.name === input.name);
	const existing = runtime.get(input.name);
	// The caller's Handle owns the arbitration; the persisted ChildRecord records
	// the same decision. Neither is re-derived here — no handle, no value.
	const spawnMode = input.spawnMode ?? child?.spawnMode;
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
		...(spawnMode ? { spawnMode } : {}),
		...(input.pid ? { pid: input.pid } : {}),
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
		isAlive: () => input.orchestrator.isChildAlive(input.name),
		persist: async () =>
			persistChild(input.store, input.runId, input.orchestrator, input.name),
		retire: async (opts) => {
			if (input.retire) {
				await input.retire(opts);
				return;
			}
			await input.orchestrator.retire(input.name, opts);
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

/**
 * The arbitrated backend recorded for one handled child of this request, plus
 * the OS process of that child when the launch reported one.
 *
 * Spreads to nothing when unknown, so the caller never has to invent a value.
 */
function spawnModeOf(
	session: LaunchSession,
	name: string,
): { spawnMode?: SpawnMode; pid?: number } {
	const recorded = session.spawnByName.get(name);
	const pid = session.pidByName.get(name);
	return {
		...(recorded ? { spawnMode: recorded.spawnMode } : {}),
		...(pid ? { pid } : {}),
	};
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
		// Handle-derived, recorded before an abort can clear `handles` (#209).
		...spawnModeOf(session, name),
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
	// Esc / parent-turn abort must not retire: child keeps running; follow+watch
	// so settle still notifies the parent (esc-no-retire-v3).
	followLaunched(session, name, { watch: true });
	session.results.push(`▶ ${name}: parent turn ended; child still running (watched)`);
}

// ---------------------------------------------------------------------------
// wait (§1.5): block for results instead of relying on async notices
// ---------------------------------------------------------------------------

/**
 * Live (non-retired / non-exited) children under this cwd for status overview.
 *
 * Names can be reused after retire; prefer the newest live record per name
 * (same preference as {@link pickChildByName}).
 */
export function listLiveChildrenForStatus(
	runs: ReturnType<RunStore["listRuns"]>,
): NonNullable<ReturnType<RunStore["findChild"]>>[] {
	const ranked = [...runs].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
	const seen = new Set<string>();
	const out: NonNullable<ReturnType<RunStore["findChild"]>>[] = [];
	for (const run of ranked) {
		for (const child of run.children) {
			if (child.state === "retired" || child.state === "exited") continue;
			if (seen.has(child.name)) continue;
			seen.add(child.name);
			out.push(child);
		}
	}
	return out;
}

/** Multi-child status text: one {@link renderLiveChildStatus} block per live child. */
export function renderStatusOverview(
	children: Array<{
		child: NonNullable<ReturnType<RunStore["findChild"]>>;
		alive: boolean;
		/** Run-dir ownership verdict (#209-3); see {@link renderLiveChildStatus}. */
		owner?: "live" | "dead" | "unknown";
		/**
		 * Own process of an `rpc` child, when this session launched it. A pid is
		 * not persisted, so a record from another session has none — and none is
		 * invented here (D3).
		 */
		pid?: number;
	}>,
): string {
	if (children.length === 0) return "No live children.";
	const noun = children.length === 1 ? "child" : "children";
	const blocks = children.map(({ child, alive, owner, pid }) =>
		renderLiveChildStatus({
			name: child.name,
			state: child.state,
			agent: child.agent,
			kind: child.kind,
			sessionFile: child.sessionFile,
			execution: child.execution,
			acceptance: child.acceptance,
			spawnMode: child.spawnMode,
			alive,
			...(owner ? { owner } : {}),
			...(pid ? { pid } : {}),
		}),
	);
	return [`Status · ${children.length} live ${noun}`, "", blocks.join("\n\n")].join("\n");
}

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
	if (!name) return { ok: false, message: "`name` or `all` is required for wait (try all:true or name:\"child-name\")" };
	if (live.some((job) => job.name === name)) {
		return { ok: true, names: [name] };
	}
	return {
		ok: false,
		message: `unknown child: ${name} (not a live child of this session).`,
	};
}

/** Parent-side decision hints when wait leaves children live (#179). */
export const WAIT_PARENT_DECISIONS = [
	"extend",
	"steer_again",
	"stop",
	"force_stop",
] as const;

export type WaitParentDecision = (typeof WAIT_PARENT_DECISIONS)[number];

export const WAIT_TIMEOUT_HINT =
	"wait does not stop children; choose stop/force_stop or extend/steer";

export interface WaitStillRunningChild {
	name: string;
	elapsedMs: number;
	budgetMs?: number;
}

/** Structured wait result when children are still live after wait (#179). */
export interface WaitTimeoutDetails {
	status: "wait_timeout" | "budget_exceeded" | "still_running";
	done: number;
	stillRunning: WaitStillRunningChild[];
	decisions: WaitParentDecision[];
	hint: string;
}

/** Build parent-decision payload when wait leaves children live. Does not stop them. */
export function buildWaitTimeoutDetails(
	results: WaitResult[],
): WaitTimeoutDetails | undefined {
	const stillRunning: WaitStillRunningChild[] = [];
	let timedOut = false;
	let done = 0;
	for (const result of results) {
		if (result.snapshot) {
			done += 1;
			continue;
		}
		if (!result.stillRunning) continue;
		if (result.timedOut) timedOut = true;
		stillRunning.push({
			name: result.name,
			elapsedMs: result.elapsedMs ?? 0,
		});
	}
	if (stillRunning.length === 0) return undefined;
	return {
		status: timedOut ? "wait_timeout" : "still_running",
		done,
		stillRunning,
		decisions: [...WAIT_PARENT_DECISIONS],
		hint: WAIT_TIMEOUT_HINT,
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
			const elapsed =
				result.elapsedMs !== undefined ? ` (elapsed ${result.elapsedMs}ms)` : "";
			parts.push(`── ${result.name} ──\nstill running${elapsed}`);
		} else if (result.interrupted) {
			interrupted += 1;
			parts.push(`── ${result.name} ──\ninterrupted (parent turn ended; children still running)`);
		} else {
			parts.push(`── ${result.name} ──\nnot tracked (no live job, no finished cache)`);
		}
	}
	parts.push(`${done} done, ${running} still running`);
	if (interrupted > 0) parts.push(`${interrupted} interrupted`);
	const details = buildWaitTimeoutDetails(results);
	if (details) {
		parts.push(`status: ${details.status}`);
		parts.push(`decisions: ${details.decisions.join(", ")}`);
		parts.push(`hint: ${details.hint}`);
	}
	return parts.join("\n");
}

/**
 * Run-dir ownership verdict for a child THIS process does not track (#209-3).
 *
 * `supervisor.isAlive` is an in-memory registry of children spawned by this
 * process, so it is always false for a foreign run (another session, or a
 * restart). The run dir's `owner.json` pid is the durable liveness marker; it
 * only needs to be consulted when the in-memory answer is "not alive".
 */
function ownerVerdictFor(
	store: RunStore,
	runs: ReturnType<RunStore["listRuns"]>,
	name: string,
	alive: boolean,
): "live" | "dead" | "unknown" | undefined {
	if (alive) return undefined;
	const picked = pickChildByName(runs, name);
	if (!picked) return "unknown";
	return ownerState(path.join(store.runDir(picked.run.runId), RUN_OWNER_FILE));
}

/**
 * Retire a named child or every child tracked by this session.
 * `force: true` → hard path (graceful:false / SIGTERM→SIGKILL); omit/false → graceful.
 */
export async function stopAction(input: {
	params: { name?: string; all?: boolean; force?: boolean };
	runtime: SessionRuntime;
	/**
	 * Run store used to resolve a named target this session does not track
	 * (foreign/restarted runs). Omitted callers keep the runtime-only scope.
	 */
	store?: RunStore;
	retire: (name: string, opts?: RetireOptions) => Promise<void>;
}): Promise<AgentToolResult<unknown>> {
	const { params, runtime, retire } = input;
	if (params.name && params.all) {
		return fail("`name` and `all` are mutually exclusive for stop.", ErrorCodes.INVALID_PARAMS);
	}
	if (!params.name && !params.all) {
		return fail("`name` or `all` is required for stop", ErrorCodes.INVALID_PARAMS);
	}
	const force = params.force === true;
	const retireOpts: RetireOptions | undefined = force ? { graceful: false } : undefined;
	const jobs = runtime.activeJobs();
	const active = jobs.filter((job) => job.state !== "retired");
	let targets: string[];
	if (params.all) {
		targets = active.map((job) => job.name);
	} else {
		// Local const so the earlier `name`/`all` guard narrows through the lookup.
		const name = params.name;
		const target = name ? jobs.find((job) => job.name === name) : undefined;
		if (!target) {
			// Not tracked by this session, but a foreign/restarted run may still
			// own a persisted record — the same records `status` can display. Fall
			// back to it so stop and retire agree on what is reachable.
			const found = input.store && name ? findChild(input.store.listRuns(), name) : null;
			if (!found) {
				return fail(`unknown child: ${params.name} (not tracked by this session).`, ErrorCodes.NOT_FOUND);
			}
			targets = found.child.state === "retired" ? [] : [found.child.name];
		} else {
			targets = target.state === "retired" ? [] : [target.name];
		}
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
			await retire(name, retireOpts);
			runtime.release(name);
			stopped.push(name);
		} catch (error) {
			// If the retire chain fails, restore the completion watcher so a
			// still-live child is not orphaned by the explicit stop attempt.
			if (runtime.get(name)) runtime.rewatch(name);
			failures.push(`${name}: ${String(error)}`);
		}
	}
	const mode = force ? "force-stopped" : "Stopped";
	const summary = stopped.length
		? `${mode} ${stopped.length} child${stopped.length === 1 ? "" : "ren"}: ${stopped.join(", ")}.`
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
	const text = renderWait(results);
	const details = buildWaitTimeoutDetails(results);
	return details
		? { content: [{ type: "text", text }], details }
		: ok(text);
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

/** Opt-in `--approve` for RPC children (`subagents.rpc.approve`, #193). */
function rpcApproveFrom(settings: Pick<SubagentsSettings, "rpc">): { rpcApprove?: boolean } {
	return settings.rpc?.approve === true ? { rpcApprove: true } : {};
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

/**
 * Render a success/neutral result to the model.
 *
 * `details` defaults to `{}`; callers that already computed machine facts
 * (runId/handles for an interrupted collect) pass them through instead of
 * discarding them (#227 D4) — `interruptedUtilityResult` is that caller.
 * `isError` is deliberately never set — the rendering chain and every assertion
 * in this repo work without it.
 */
function ok(
	text: string,
	details: Record<string, unknown> = {},
): AgentToolResult<unknown> {
	return { content: [{ type: "text", text }], details };
}

/**
 * Render a failure to the model.
 *
 * `AgentToolResult` has no `isError` field — the error code travels in
 * `details` and the message text carries the failure signal.
 */
function fail(text: string, code: string): AgentToolResult<unknown> {
	recordSessionError({ code, message: text });
	return { content: [{ type: "text", text }], details: { error: code } };
}
