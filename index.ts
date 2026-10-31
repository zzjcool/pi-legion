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
import { runAtAbsoluteDepth } from "./src/supervisor/inprocess-depth.ts";
import { notifyInProcessSlotReleased, RoutingSupervisor } from "./src/supervisor/routing-supervisor.ts";
import type { AbortOutcome, InFlightToolStack, LegionSupervisor, SteerDisposition } from "./src/supervisor/types.ts";
import { inFlightToolStackOf } from "./src/supervisor/types.ts";
import { withInFlightToolLine } from "./src/extension/legion-status.ts";
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
import { createSessionRuntime, renderLiveChildStatus, type ClaimedCollect, type CollectSnapshot, type SessionRuntime, shouldRecycleAfterCollect, type WaitResult } from "./src/extension/runtime.ts";
import { createDbEventSource, createLegionEventBus, type DbEventSource, type LegionEventBus } from "./src/extension/event-bus.ts";
import { LegionPostman, registerLegionTools, type LegionMailCommand } from "./src/extension/legion-tools.ts";
import type { PhaseMachine } from "./src/legion/phase-machine.ts";
import { LEGION_DB_ENV, LEGION_NODE_ID_ENV } from "./src/runs/args.ts";
import type { VerifyRunner } from "./src/runs/acceptance.ts";
import { legionDbPath, openLegionDb, type DatabaseSync } from "./src/legion/db.ts";
import { appendEvent, maxEventId } from "./src/legion/events.ts";
import { attachUsageTotals, upsertUsage } from "./src/legion/usage.ts";
import { getChildByName, getChildren, getNode, getSubtree, insertNode, type LegionNode, updateNode } from "./src/legion/nodes.ts";
import { DEFAULT_LEGION_SETTINGS, type LegionSettings } from "./src/shared/types.ts";
import { parseNestedPathEnv } from "./src/shared/nested-path.ts";
import { allocateSiblingNames, isValidAgentName } from "./src/shared/name.ts";
import {
	deriveOutcome,
	isLastTurnComplete,
	NO_ASSISTANT_ABORT_REASON,
	parseSessionFile,
} from "./src/shared/session.ts";
import { restoreHostNodeOptions } from "./src/supervisor/child-memory.ts";
import { currentChildContext } from "./src/supervisor/child-context.ts";
import { setVerifyQueueListener } from "./src/runs/verify-queue.ts";
import { setLaunchQueueListener } from "./src/supervisor/admission-queue.ts";
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
	completionStatusOf,
	type RenewalProposal,
	SUBAGENT_NOTIFY_TYPE,
} from "./src/extension/notify.ts";
import { renderSubagentNotice } from "./src/extension/notice-renderer.ts";
import { renderSpawnResult } from "./src/extension/spawn-render.ts";
import { PARENT_PLAYBOOK, TOOL_DESCRIPTION } from "./src/extension/playbook.ts";
import { CHILD_ROLE_ENV } from "./src/extension/child-guard.ts";
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
import {
	describeChildScopeCandidates,
	foundElsewhere,
	foundInScope,
	resolveScopedChild,
	scopeHitFor,
	type ChildScopeCandidate,
} from "./src/runs/child-scope.ts";
import {
	candidateStoreRoots,
	resolveChildAcrossStores,
	unknownChildMessage,
	type CandidateStore,
} from "./src/runs/store-lookup.ts";
import { RUN_OWNER_FILE, ownerState } from "./src/runs/owner.ts";
import { measureProgress, readSessionLines } from "./src/runs/progress-signal.ts";
import { resolveLaunchWorktree } from "./src/runs/worktree.ts";
import {
	type AgentConfig,
	type AgentScope,
	type ChildRecord,
	DEFAULTS,
	DEFAULT_MAX_RENEWALS,
	DEFAULT_ON_BLOCKED,
	DEFAULT_RENEWABLE,
	ErrorCodes,
	type Execution,
	type ModelOrigin,
	type RetireOptions,
	type SpawnMode,
	SubagentError,
	type SubagentsSettings,
	unknownChildError,
	type Handle,
} from "./src/shared/types.ts";

// ---------------------------------------------------------------------------
// Parameters
// ---------------------------------------------------------------------------

const TaskItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task to delegate" }),
	cwd: Type.Optional(
		Type.String({
			description:
				"Directory the child records live under (`<cwd>/.pi-subagents`), used by launch and by every control action. Defaults to the session cwd. A name miss searches the neighbouring stores too, so this is rarely needed.",
		}),
	),
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
				Type.Literal("abort"),
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
	cwd: Type.Optional(
		Type.String({
			description:
				"Directory the child records live under (`<cwd>/.pi-subagents`) for launch and every control action. Defaults to the session cwd. A name miss also searches neighbouring stores, so setting this is rarely needed.",
		}),
	),
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
	runId: Type.Optional(
		Type.String({
			description:
				'control actions (status/collect/stop/continue/resume/steer/abort/retire): name the run that holds the child, instead of the run this session owns. A name is resolved against this session\'s direct children first; a same-named node in another run is reported (as `not a direct child` or as an ambiguity), never silently adopted. Example: subagent({ action: "collect", name: "worker-0", runId: "r-4fd626ee" }).',
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
	clearQueued: Type.Optional(
		Type.Boolean({
			description:
				'abort only: clear the child\'s queued steering/follow-up messages before interrupting it (default true). Omit for true. Example: subagent({ action: "abort", name: "worker-0" }).',
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
	// Optional on purpose: `tasks[]` is a complete request on its own, exactly like
	// `subagent({ tasks })`. Leaving this required made pi's own argument check
	// reject `{ tasks: [...] }` before `execute` ran, so every `tasks[]`-only call
	// failed with `task: must have required properties task` and had to be retried
	// with a dummy `task` label (models copy the `subagent` shape).
	task: Type.Optional(
		Type.String({
			description:
				"Recon task: one clear question list. Optional when `tasks[]` is provided (then it only labels the parent run).",
		}),
	),
	agent: Type.Optional(Type.String({ description: "Utility agent name (default: scout)" })),
	tasks: Type.Optional(Type.Array(TaskItem, { description: "Parallel recon launches" })),
	cwd: Type.Optional(
		Type.String({
			description:
				"Directory the child records live under (`<cwd>/.pi-subagents`) for launch and every control action. Defaults to the session cwd. A name miss also searches neighbouring stores, so setting this is rarely needed.",
		}),
	),
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
	/**
	 * #351: the phase machine a node's role card declares, by role. Carried on the
	 * identity (i.e. recorded when the tree is built) so every orchestrator this
	 * process constructs can resolve a custom phase name for a parent retire.
	 */
	machineForRole?: (role: string | null | undefined) => PhaseMachine | undefined;
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

/**
 * The frozen interruption head line (`test/unit/teams.test.ts` matches it, and
 * `esc-no-retire-v3` records why it leads every interrupted result).
 */
const INTERRUPTED_HEAD = "interrupted (parent turn ended; children still running)";

function notice(pi: ExtensionAPI, text: string): void {
	// #273: `sendMessage` is a host ACTION and pi throws
	// "Extension runtime not initialized. Action methods cannot be called during
	// extension loading." if it is reached before the runtime is up. An error
	// handler that is more fatal than the error it reports turns "a resume
	// failed" into "the whole agent process died", which is what happened on the
	// centurion recovery path. Degrade to stderr instead; the caller still gets
	// the fact, and nothing crashes.
	try {
		pi.sendMessage({ customType: SUBAGENT_NOTIFY_TYPE, content: text, display: true }, { triggerTurn: true, deliverAs: "followUp" });
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		console.error(`[pi-legion] notice not delivered (${reason}): ${text}`);
	}
}

/**
 * Launch-admission-queue bounds from settings (issue #266, contract D6-a/D10).
 *
 * Frozen key names are `subagents.inprocess.maxQueuedLaunches` /
 * `subagents.inprocess.launchQueueTimeoutMs`. An absent key is *omitted* rather
 * than defaulted here: the single source of the defaults is
 * `src/supervisor/admission-queue.ts`, and passing a literal 32/900000 from the
 * adapter would create a second copy that can drift from the docs and sentinel.
 */
function launchQueueBounds(settings: {
	inprocess?: { maxQueuedLaunches?: number; launchQueueTimeoutMs?: number };
}): { maxPending?: number; timeoutMs?: number } {
	const bounds: { maxPending?: number; timeoutMs?: number } = {};
	if (settings.inprocess?.maxQueuedLaunches !== undefined) bounds.maxPending = settings.inprocess.maxQueuedLaunches;
	if (settings.inprocess?.launchQueueTimeoutMs !== undefined) bounds.timeoutMs = settings.inprocess.launchQueueTimeoutMs;
	return bounds;
}

/**
 * D9/§13.4: the one user-visible line per queued / admitted / expired / stopped
 * launch.
 *
 * Deliberately `triggerTurn: false` (unlike {@link notice}): admission is a
 * mid-turn fact about work the caller already asked for, so waking the parent
 * with a fresh turn for every queue transition would re-enter the agent for a
 * purely cosmetic line. Anything the caller must act on still arrives through
 * the tool result and, for `async:false`, the inline `↳ waited Ns` line.
 */
function launchQueueNoticeSink(pi: ExtensionAPI): (line: string) => void {
	return (line: string) => {
		try {
			pi.sendMessage(
				{ customType: SUBAGENT_NOTIFY_TYPE, content: line, display: true },
				{ triggerTurn: false },
			);
		} catch {
			// Cosmetic: a gone parent session must never break admission.
		}
	};
}

/**
 * D9-1: the launch line's queue suffix, or `""` for a launch that spawned now.
 *
 * `▶ scout-7 (scout) supervisor=inprocess queued(3)` — the position is what the
 * operator needs to know the launch is waiting rather than broken. Only the
 * trailing segment is added: the line's published prefix and `details.spawns`
 * (a renderer input) keep their existing shapes.
 */
function launchLineQueueSuffix(handle: Pick<Handle, "queued" | "queuePosition">): string {
	if (handle.queued !== true) return "";
	return handle.queuePosition === undefined ? " queued" : ` queued(${handle.queuePosition})`;
}

/**
 * D8/A20: the honest wait line for an `async:false` child that queued.
 *
 * Read from the admitted `ChildRecord.queueWaitedMs` — never re-derived from a
 * clock here, or the number would describe the adapter's own latency instead of
 * the queue's. `""` when the child never waited.
 */
function queuedWaitLine(child: { name: string; queueWaitedMs?: number } | undefined): string {
	if (!child || child.queueWaitedMs === undefined || child.queueWaitedMs <= 0) return "";
	return `↳ ${child.name} waited ${Math.round(child.queueWaitedMs / 1000)}s in the launch queue`;
}

/**
 * D6/D7: report a queue that an abort cleared out.
 *
 * "Empty queue and zero spawns" is only half the contract; the caller must also
 * learn that N launches it asked for never ran. One line, names in `seq` order.
 */
function launchQueueFlushLine(flushed: readonly string[]): string {
	if (flushed.length === 0) return "";
	return `${flushed.length} queued launch(es) dropped: ${flushed.join(", ")}`;
}

/**
 * #238: create and start the DB event source that feeds the legion bus on attach.
 *
 * This is the production attach path and it is exported so a unit test can drive
 * it directly (same seam style as `buildPlan`/`resolveWaitTargets`): the seeding
 * behaviour is a property of THIS call, not of `createDbEventSource`, and a test
 * that only exercised the factory would keep passing if this seed were removed.
 *
 * Seeding at `MAX(id)` matters because `createDbEventSource`'s own default is 0,
 * i.e. "replay the whole log". On a ledger with history that re-delivered every
 * stored event through `onWidgetEvent` — one full `snapshotNodes()` plus a
 * repaint each, ~2.5s of blocked UI at 120 nodes / 1000 events — to reach a
 * state the DB already describes.
 *
 * Rows committed in the window between this seed query and the first poll are
 * not lost: `poll()` only skips when `lastDataVersion` matches, that variable
 * starts `undefined` (so the first poll always reads), and the cursor is only
 * ever advanced from ids actually returned by `SELECT ... WHERE id > cursor`.
 * A row committed after the seed is therefore either picked up by the first
 * poll or dirties `data_version` and is picked up on the next tick. The seed is
 * not atomic with `start()`, but it does not need to be.
 *
 * Note the drain loop's early `return`: it exits BEFORE `lastDataVersion` is
 * assigned (that assignment is after the loop), so an interrupted drain leaves
 * the version unlatched. That errs safe — the next poll re-reads from the
 * cursor instead of skipping — but it is a re-read, not a "set then return".
 */
export function attachLegionRuntime(input: {
	db: DatabaseSync;
	eventBus: LegionEventBus;
}): DbEventSource {
	const dbEventSource = createDbEventSource(input.db, { cursor: maxEventId(input.db) });
	dbEventSource.start(input.eventBus);
	return dbEventSource;
}

/**
 * The phase machine for a legion node, from its role card (#298).
 *
 * Reads `phases:` off the agent definition for the node's role. Absent means the
 * built-in machine, so an undeclared team is unaffected. A card that declares an
 * invalid machine never reaches here: `parseAgentDocument` rejects it at load.
 */
function phaseMachineForRole(role: string | null | undefined, cwd: string, settings: SubagentsSettings): PhaseMachine | undefined {
	if (!role) return undefined;
	try {
		const discovery = discoverAgents(cwd, "user", { includeBuiltin: settings.disableBuiltins !== true });
		const overridden = applyAgentOverrides(discovery.agents, settings.agentOverrides);
		return findAgent(overridden, role)?.phases;
	} catch {
		// Discovery is best-effort here: a broken project dir must not stop a team
		// from attaching, and the built-in machine still works.
		return undefined;
	}
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
	/** #298: the team root's declared phase machine, when its card supplies one. */
	machine?: PhaseMachine;
	/** #351: by-role resolver for the abort path (see LegionRuntimeIdentity). */
	machineForRole?: (role: string | null | undefined) => PhaseMachine | undefined;
}): LegionRuntimeIdentity {
	const self = getNode(input.db, input.nodeId);
	const eventBus = input.eventBus;
	const dbEventSource = attachLegionRuntime(input);
	const postman = new LegionPostman({
		db: input.db,
		nodeId: input.nodeId,
		supervisor: input.supervisor,
		settings: input.settings,
		eventBus,
		sendRootMessage: (text: string) => notice(input.pi, text),
		sendSelfMessage: (text: string) => notice(input.pi, text),
		...(input.machine ? { machine: input.machine } : {}),
		resumeChild: (node: LegionNode, mail: LegionMailCommand) => resumeLegionChild({
			pi: input.pi, supervisor: input.supervisor, db: input.db, dbPath: input.dbPath,
			eventBus, settings: input.settings, cwd: input.cwd, storeRootDir: input.storeRootDir,
			parentNodeId: input.nodeId, node, message: mail.text,
			...(input.machineForRole ? { machineForRole: input.machineForRole } : {}),
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
		...(input.machineForRole ? { machineForRole: input.machineForRole } : {}),
	};
	if (input.registerTools && input.nodeId !== "root") registerLegionTools(input.pi, { db: input.db, nodeId: input.nodeId, role: self?.role, settings: input.settings, cwd: input.cwd, runDir: input.runDir, eventBus, sendSelfMessage: (text: string) => notice(input.pi, text), ...(input.machine ? { machine: input.machine } : {}) });
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
		const machine = phaseMachineForRole(node.role, input.cwd, input.settings);
		const identity = createLegionRuntime({ pi: input.pi, supervisor: input.supervisor, db, dbPath: absoluteDbPath, nodeId, rootRunId: getNode(db, "root")?.runId ?? path.basename(path.dirname(absoluteDbPath)), runDir: input.store.runDir(nodeRun.runId), cwd: input.cwd, storeRootDir: input.store.rootDir, settings: settingsForLegion(input.settings), eventBus: input.eventBus, registerTools: true, ...(machine ? { machine } : {}), machineForRole: (role) => phaseMachineForRole(role, input.cwd, input.settings) });
		// #273: `createLegionRuntime` runs during extension LOADING, where host
		// actions (sendMessage, spawn, ui) are not available yet. Defer the team
		// recovery to the next tick so a failure inside it cannot crash the load
		// path, and so any notice it emits has a live runtime to go to.
		if (node.role === "centurion") {
			// #275: run the recovery at depth 0 explicitly. `queueMicrotask`
			// INHERITS the AsyncLocalStorage depth (verified: `als.getStore()`
			// inside a queued microtask still reads the parent's value), so a
			// recovery queued from a nested context would start already deep and
			// report `nesting limit reached (depth N, max 4)` for a two-level
			// chain. `runAtAbsoluteDepth(0, …)` is the mechanism this codebase
			// already uses for exactly that reason (see inprocess-depth.ts
			// "REV2-1"): the recovery runs at the TOP of the tree, not under
			// whatever context happened to enqueue it.
			queueMicrotask(() => {
				void runAtAbsoluteDepth(0, async () => {
					await resumeLegionTeam({ identity, input });
				}).catch((error: unknown) => {
					const reason = error instanceof Error ? error.message : String(error);
					console.error(`[pi-legion] team recovery for ${identity.nodeId} failed: ${reason}`);
				});
			});
		}
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
			await resumeLegionChild({ pi: input.input.pi, supervisor: input.input.supervisor, db: input.identity.db, dbPath: input.identity.dbPath, eventBus: input.identity.eventBus, settings: input.identity.settings, cwd: input.input.cwd, storeRootDir: input.identity.storeRootDir, parentNodeId: input.identity.nodeId, node, message: `Resume from saved session ${node.sessionFile} and continue interrupted work.`, ...(input.identity.machineForRole ? { machineForRole: input.identity.machineForRole } : {}) });
		} catch (error) { notice(input.input.pi, `Could not resume ${node.id}: ${error instanceof Error ? error.message : String(error)}`); }
	}
}

function createRootLegion(input: { pi: ExtensionAPI; supervisor: LegionSupervisor; store: RunStore; cwd: string; task: string; settings: ReturnType<typeof loadSubagentSettings>; maxDepth: number; eventBus: LegionEventBus; rootSessionFile?: string | undefined }): LegionRuntimeIdentity {
	const rootRun = input.store.createRun({ task: input.task, cwd: input.cwd, maxDepth: input.maxDepth, nodeId: "root", herdr: { supervisor: currentProcessSpawnMode() } });
	const dbPath = path.resolve(legionDbPath(input.store.runDir(rootRun.runId)));
	const db = openLegionDb(dbPath);
	const now = Date.now();
	// #322/#338 M1: record THIS session's file on the root row. The postman's
	// DELIVERED evidence scan reads `nodes.session_file` per recipient, and the root
	// node is a recipient (`to: "parent"` from a top-level centurion) — without
	// this, every mail addressed to root sat at `ACCEPTED` forever. The child path
	// writes the same column from `reserveNode`; this is the root equivalent.
	insertNode(db, { id: "root", parentId: null, name: "root", role: "root", kind: "pi", depth: 0, runId: rootRun.runId, status: "running", taskSummary: input.task.slice(0, 2_000), ...(input.rootSessionFile ? { sessionFile: input.rootSessionFile } : {}), createdAt: now, updatedAt: now }, () => now);
	appendEvent(db, "root", "node_launched", { runId: rootRun.runId, task: input.task }, { now: () => now });
	return createLegionRuntime({ pi: input.pi, supervisor: input.supervisor, db, dbPath, nodeId: "root", rootRunId: rootRun.runId, runDir: input.store.runDir(rootRun.runId), cwd: input.cwd, storeRootDir: input.store.rootDir, settings: settingsForLegion(input.settings), eventBus: input.eventBus, registerTools: false, machineForRole: (role) => phaseMachineForRole(role, input.cwd, input.settings) });
}

async function resumeLegionChild(input: { pi: ExtensionAPI; supervisor: LegionSupervisor; db: DatabaseSync; dbPath: string; eventBus: LegionEventBus; settings: LegionSettings; cwd: string; storeRootDir: string; parentNodeId: string; node: LegionNode; message: string; machineForRole?: (role: string | null | undefined) => PhaseMachine | undefined }): Promise<void> {
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
	const orchestrator = new Orchestrator({ supervisor: input.supervisor, runDir: store.runDir(parentRun.runId), cwd, maxDepth: catalog.settings.legion?.maxDepth, maxSpawns: catalog.settings.maxSubagentSpawnsPerSession ?? null, team: resumedTeam.team, childContext: resolveTeamContext("child", catalog.settings, resumedTeam.team), parentPath: parentRun.path, ...rpcApproveFrom(catalog.settings), launchQueue: launchQueueBounds(catalog.settings), onLaunchQueueNotice: launchQueueNoticeSink(input.pi), legion: { db: input.db, dbPath: input.dbPath, nodeId: parent.id, parentNodeId: parent.parentId, parentRunId: parentOfSupervisor?.runId ?? null, runId: parentRun.runId, runStore: store, settings: input.settings, eventBus: input.eventBus, ...(input.machineForRole ? { machineForRole: input.machineForRole } : {}) } });
	orchestrator.restore(parentRun);
	const handle = await orchestrator.launch({ agent, task: input.message, name: saved.name, ...(input.node.team ? { team: input.node.team } : {}), ...(saved.model ? { model: saved.model } : {}), worktree: Boolean(saved.worktreePath) });
	await store.updateChild(parentRun.runId, saved.name, (child) => Object.assign(child, handle.child));
}

/**
 * The live legion runtime for THIS process, held at module scope rather than in
 * the `piLegion` closure (#283).
 *
 * `pi` re-runs the extension factory for every `DefaultResourceLoader.reload()`,
 * and an in-process child session creates its own loader
 * (`inprocess-supervisor.ts` builds one per `createAgentSession`). So a single
 * process can enter `piLegion` many times. A closure-local `let` reset to
 * `undefined` on each entry defeated the cache inside `resolveLegionIdentity`,
 * which then opened a fresh `legion.db` — and never closed it. Measured on a
 * centurion dispatching one in-process scout: one extra open per entry, ~2.5k
 * leaked descriptors per 20 s, RSS climbing to 6 GB until V8 aborted with
 * `JavaScript heap out of memory`.
 */
/**
 * Runtime handles for THIS process, keyed by ledger path (#283).
 *
 * Two independent facts force a map rather than a single slot:
 *
 * 1. `pi` re-runs the extension factory for every `DefaultResourceLoader.reload()`,
 *    and an in-process child session builds its OWN loader per
 *    `createAgentSession` — so one process enters `piLegion` many times. A
 *    closure-local binding reset on every entry defeated the `cached`
 *    short-circuit in `resolveLegionIdentity`, which then opened a fresh
 *    `legion.db` per entry and never closed it: measured on a centurion
 *    dispatching one in-process scout, ~2.5k leaked descriptors per 20 s and RSS
 *    climbing to 6 GB until V8 aborted with `JavaScript heap out of memory`.
 * 2. Those entries do NOT share one ledger. A parent and its in-process child
 *    legitimately own different `legion.db` files, and each registers its own
 *    `session_shutdown`. With a single slot the child's shutdown closed the
 *    PARENT's database, surfacing later as `database is not open` from whichever
 *    pump or admission probe ran next.
 *
 * Keying by (resolved path, nodeId) keeps the reuse (2) while giving each owner
 * its own lifecycle (1).
 *
 * The path alone is NOT enough: a parent and its in-process child share ONE
 * ledger file (the child inherits `dbPath` from the orchestrator's launch
 * context) and differ only by the node row they own. Keying by path made them
 * collide, so the child's shutdown closed the parent's handle and a sibling's
 * next spawn failed with `database is not open` (#285 follow-up).
 */
const legionIdentityKey = (dbPath: string, nodeId: string): string => `${dbPath}\u0000${nodeId}`;
const legionIdentities = new Map<string, LegionRuntimeIdentity>();

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
		// #266 D9-3: the launch admission queue's own pill. Deliberately a separate
		// listener from verify's — different phases, and verify's is poll-driven.
		// The contract's baseline is `legion-queue: N queued`; the `· 8/8 slots busy`
		// tail needs `slotsInUse`/`slots`, which the pure queue does not know (the
		// limit lives in the supervisor), so that dimension is omitted until the
		// event carries it — the contract allows the omission explicitly.
		setLaunchQueueListener((event) => {
			try {
				if (event.phase === "queued" || event.phase === "admitted") {
					const suffix = event.slotsInUse !== undefined && event.slots !== undefined
						? ` · ${event.slotsInUse}/${event.slots} slots busy`
						: "";
					lastUi?.setStatus("legion-queue", `legion-queue: ${event.queued} queued${suffix}`);
					if (event.queued === 0) lastUi?.setStatus("legion-queue", undefined);
				} else if (event.phase === "overflow" || event.phase === "expired" || event.phase === "flushed") {
					lastUi?.setStatus("legion-queue", undefined);
				}
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
		// The in-process supervisor is constructed here (not by RoutingSupervisor) so
		// it can read live settings per spawn. That means `onSlotReleased` must be
		// wired EXPLICITLY: RoutingSupervisor only adds it when it builds the
		// backend itself (`options.inprocess ?? new InProcessSupervisor({...})`).
		// Passing a pre-built instance used to drop the hook silently, so a freed
		// slot never woke a launch-queue pump in production — admission then waited
		// for the fallback recheck instead of firing on the release (#266 D2-d-2).
		inprocess: new InProcessSupervisor({
			onSpawnRefused,
			// The event payload is not needed here: every Orchestrator on this run dir
			// re-probes its own items, so a bare wake-up edge is the whole contract.
			onSlotReleased: () => {
				notifyInProcessSlotReleased();
			},
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
	// #238: the resident status widget defers its repaint to a microtask, which puts
	// a paint failure outside the per-subscriber try/catch in `createLegionEventBus`.
	// The runtime funnels that failure through `reportError` → `onHandlerError`, so
	// a handler must actually be configured or the containment is silent. A widget
	// repaint that throws (a stale UI context, a SQLITE_IOERR on the tree read) must
	// never take the host down, and must leave a trace.
	const legionBus = createLegionEventBus({
		onHandlerError: (error, event, handler) => {
			const detail = error instanceof Error ? error.message : String(error);
			// `event === null` means a deferred failure with no event to attribute;
			// `handler` is then an origin tag rather than a subscriber function.
			const where = event
				? `${event.type} node=${event.nodeId}`
				: typeof handler === "string" ? handler : "deferred";
			console.error(`[pi-legion] legion event handler failed (${where}): ${detail}`);
		},
	});
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
	/**
	 * Close one ledger handle (by resolved path) or every handle this process
	 * opened. Shutdown handlers pass their own path so a child session teardown
	 * cannot close the parent's database (#283).
	 */
	const stopLegionRuntime = (key?: string): void => {
		const targets = key === undefined
			? [...legionIdentities.entries()]
			: (legionIdentities.has(key) ? [[key, legionIdentities.get(key)!] as const] : []);
		for (const [key, identity] of targets) {
			legionIdentities.delete(key);
			identity.postman.stop();
			identity.dbEventSource.stop();
			// #40: bound the ledger and fold the WAL back before closing.
			if (hygieneEnabled() && !isChild) applyEventRetention(identity.db);
			else checkpoint(identity.db);
			identity.db.close();
		}
	};
	/** The handle this extension entry owns, if any (see `legionIdentities`). */
	let ownLegionKey: string | undefined;
	const ownLegionIdentity = (): LegionRuntimeIdentity | undefined =>
		ownLegionKey === undefined ? undefined : legionIdentities.get(ownLegionKey);
	/**
	 * Register a resolved identity and make it this entry's own (#283/#285).
	 *
	 * One rule for every call site: the map holds at most one live handle per
	 * ledger path, and an existing handle is only closed when THIS entry is
	 * replacing the path it already owned. Reassigning across paths never closes
	 * anything — a sibling entry (parent vs in-process child) may still be using
	 * the handle, and closing it surfaced as `database is not open` from that
	 * sibling's next spawn.
	 */
	const adoptLegionIdentity = (identity: LegionRuntimeIdentity): void => {
		const key = legionIdentityKey(identity.dbPath, identity.nodeId);
		const existing = legionIdentities.get(key);
		// Only close when this entry is replacing the key it ALREADY owns: that
		// handle is provably ours. A handle owned by a sibling (same ledger file,
		// different node) is not ours to close.
		if (existing && existing !== identity && ownLegionKey === key) {
			stopLegionRuntime(key);
		}
		if (existing !== identity) legionIdentities.set(key, identity);
		ownLegionKey = key;
	};
	const initializeLegionRuntime = (ctx: Pick<ExtensionContext, "cwd"> & { sessionFile?: string; legionNode?: { dbPath: string; nodeId: string } }): void => {
		// The injected node's dbPath is authoritative: an in-process child shares the
		// parent's env, so PI_LEGION_DB here belongs to the parent (or is unset).
		const store = runStoreFor(ctx.cwd, ctx.legionNode?.dbPath);
		const settings = loadSubagentSettings({
			userSettingsPath: path.join(getAgentDir(), "settings.json"),
			projectSettingsPath: path.join(ctx.cwd, ".pi", "settings.json"),
		});
		// Resolve the ledger path BEFORE asking for a cache entry: a fresh factory
		// entry starts with no owned path, but the same database may already have a
		// live handle from an earlier entry in this process (#283).
		const targetPath = ctx.legionNode?.dbPath ?? process.env[LEGION_DB_ENV];
		const targetNode = ctx.legionNode?.nodeId ?? process.env[LEGION_NODE_ID_ENV];
		const cached = targetPath !== undefined && targetNode !== undefined && path.isAbsolute(targetPath)
			? legionIdentities.get(legionIdentityKey(path.resolve(targetPath), targetNode))
			: ownLegionIdentity();
		const next = resolveLegionIdentity({ pi, supervisor, store, cwd: ctx.cwd, settings, eventBus: legionBus, cached, sessionFile: ctx.sessionFile, legionNode: ctx.legionNode });
		if (next === undefined) return;
		// Index by ledger path: a re-entry for the SAME database reuses the cached
		// handle, a different database (parent vs its in-process child) gets its
		// own slot.
		//
		// Never close `cached` here just because this entry resolved elsewhere.
		// `resolveLegionIdentity` returns a DIFFERENT object for the same path when
		// the node/session changed, and that earlier handle may still be in use by
		// the entry that opened it — closing it produced `database is not open`
		// from a sibling's spawn (#285 follow-up). Only the entry that owns a path
		// closes it, via its own session_shutdown.
		adoptLegionIdentity(next);
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
			const report = runStartupHygiene({ storeRoot, protectRunIds: ownLegionIdentity() ? [ownLegionIdentity()!.rootRunId] : [] });
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
		// Scope to the ledger THIS entry opened: a parent and its in-process child
		// both register a shutdown handler, and each must close only its own (#283).
		stopLegionRuntime(ownLegionKey);
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
					legion: ownLegionIdentity(),
					eventBus: legionBus,
					onLegion: (identity) => {
						adoptLegionIdentity(identity);
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
		// A centurion running as a NESTED child is still a "parent" for templating
		// purposes — it dispatches its own squad — but it must not be offered itself:
		// the runtime refuses a non-root centurion dispatch (a nested centurion is
		// a second command chain the root cannot collect), so listing it invites a
		// call that can only fail. Leaving it out keeps the roster truthful.
		const selfRole = process.env[CHILD_ROLE_ENV];
		const rosterAgents = selfRole
			? catalog.agents.filter((agent) => agent.name !== selfRole)
			: catalog.agents;
		return {
			systemPrompt: `${event.systemPrompt}\n\n${PARENT_PLAYBOOK}\n\n${renderParentRoster(
				rosterAgents,
				catalog.team,
				catalog.teamWarnings,
			)}${parentContext ? `\n\n${parentContext}` : ""}`,
		};
	});
	if (process.env[UTILITY_CHILD_ENV] === "1") {
		pi.on("session_shutdown", () => stopLegionRuntime(ownLegionKey));
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
			const identity = ownLegionIdentity();
			return identity
				? attachUsageTotals(identity.db, getSubtree(identity.db, identity.nodeId))
				: [];
		},
		// #298: let the tree render a team's declared workflow. Cached per role
		// because agent discovery touches the filesystem and the tree re-renders on
		// every event.
		getPhaseMachine: (() => {
			const cache = new Map<string, PhaseMachine | undefined>();
			return (role) => {
				if (!role) return undefined;
				if (cache.has(role)) return cache.get(role);
				let machine: PhaseMachine | undefined;
				try {
					// `loadCatalog` already applies agentOverrides and team selection, so
					// this is the same definition the launch path resolves.
					const catalog = loadCatalog(lastCwd, lastCwd, undefined);
					machine = findAgent(catalog.agents, role)?.phases;
				} catch {
					// Discovery must never break rendering: a malformed project dir would
					// otherwise blank the tree.
					machine = undefined;
				}
				cache.set(role, machine);
				return machine;
			};
		})(),
		getTreeIdentity: (name) => {
			const own = ownLegionIdentity();
			const node = own && getChildByName(own.db, own.nodeId, name);
			return node ? {
				nodeId: node.id,
				parentId: node.parentId,
				depth: node.depth,
				supervisorName: name,
			} : undefined;
		},
		/**
		 * subagent-renewal-v1 D3: the one renewal proposal the completion notice
		 * may carry.
		 *
		 * Read from the persisted ChildRecord so a proposal survives process
		 * boundaries (each tool call is a fresh process). Every "do not offer"
		 * rule — D1 completed, D7 still running, D5 role opt-out, D8 no baseline —
		 * lives inside `renewalProposalFor`, so returning its undefined is the
		 * whole decision.
		 */
		getRenewalProposal: (name, execution) => {
			// Each tool call is a fresh process, so the child record comes off disk
			// rather than from any in-memory launch state.
			const cwd = lastCwd;
			if (!cwd) return undefined;
			const located = findChild(runStoreFor(cwd).listRuns(), name);
			if (!located) return undefined;
			const catalog = loadCatalog(cwd, cwd, undefined);
			const def = findControlAgent(catalog.agents, catalog.allAgents, located.child.agent);
			return renewalProposalFor({
				agent: def,
				child: located.child,
				sessionFile: located.child.sessionFile,
				execution,
				name,
			});
		},
		subscribeSupervisorEvents: (name, listener, options) => rpcEventSource.onEvent?.(
			name,
			(event) => {
				const nodeId = ownLegionIdentity()?.childNodeId(name);
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
				const owner = ownerVerdictFor(store, () => runs, child.name, alive);
				// #315/#331: same display-only activity fact `subagent status` prints,
				// so the slash command cannot drift from the tool surface.
				const inFlightTools = inFlightToolStackOf(supervisor, child.name);
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
					...(inFlightTools ? { inFlightTools } : {}),
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
				activeLegion = resolveLegionIdentity({ pi, supervisor, store, cwd, settings, eventBus: legionBus, cached: ownLegionIdentity(), sessionFile: ctx.sessionManager?.getSessionFile() });
				if (!activeLegion && action === "launch" && !isChild) {
					const plan = buildPlan(params);
					if (plan.ok) activeLegion = createRootLegion({ pi, supervisor, store, cwd, task: plan.task, settings, maxDepth: effectiveMaxDepth(settings.legion?.maxDepth), eventBus: legionBus, rootSessionFile: ctx.sessionManager?.getSessionFile() });
				}
				if (activeLegion) adoptLegionIdentity(activeLegion);
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
					// #270: the session cwd is a second store worth searching when the
					// call passes an explicit `cwd` that differs from it.
					...(ctx.cwd && ctx.cwd !== cwd ? { callerCwd: ctx.cwd } : {}),
					agents,
					allAgents,
					team,
					runtime,
					settings,
					legion: activeLegion,
				});
				if (signal?.aborted && action !== "stop") {
					// #352: the frozen head line replaces the rendered result, so the parent
					// never sees it — and `wait` CLAIMS a settled child's completion on its
					// finished-cache probe. The result is thrown away here, so the claim has
					// to go back (exactly what `collectChild` owes on its own bails): a claim
					// nobody delivered suppresses that round's notice forever.
					await releaseWaitClaims(runtime, result.details);
					return ok("interrupted (parent turn ended; children still running)");
				}
				return result;
			}

			const result = await launchFamily({
				params,
				signal,
				ctx,
				pi,
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
				// #266 D7: the inner interrupted result also carries the launch-queue
				// flush line (`N queued launch(es) dropped: …`), which a bare head line
				// would silently erase — the caller would think its launches still ran.
				// An inner result that already reports the interruption is therefore
				// kept as-is; only an otherwise-successful result is replaced.
				const inner = (result.content ?? [])
					.map((part) => (part.type === "text" ? part.text : ""))
					.join("\n");
				if (inner.includes(INTERRUPTED_HEAD)) return ok(inner, carried);
				return ok(INTERRUPTED_HEAD, carried);
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
		const legionNodeId = ownLegionIdentity()?.childNodeId(pending.childName);
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
	/**
	 * #270: the session's own cwd, when the call also passes an explicit `cwd`.
	 * Child records may live in either store, so both are searched on a miss.
	 */
	callerCwd?: string;
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
			// #312: the run this call is scoped to — the explicit `runId`, else the
			// run this session owns. `stopAction` resolves the name inside it only.
			runId: params.runId,
			sessionRunId: input.legion?.runId,
			retire: async (name, opts, scope) => {
				const merged = opts ?? retireOpts;
				const job = input.runtime.get(name);
				// #312: a live job is a node of exactly ONE run. Retire it only when the
				// scope agrees (or the caller named no run) — a same-named job in another
				// run is a different node, and stopping it would retire a child that was
				// never reported.
				if (job?.retire && (scope?.runId === undefined || job.runId === scope.runId)) {
					await job.retire(merged);
					return;
				}
				// The persisted record is read in the SAME run `stopAction` resolved the
				// name in — never re-resolved across runs (`pickChildByName` prefers a live
				// then the newest record), which is how `stop` came to REPORT this session's
				// `worker-0` and RETIRE another run's live one.
				//
				// A completion watch can retire/release a target after stop snapshots all
				// names but before the serial loop reaches it. Treat a vanished or already
				// retired target as stopped; only rebuild the orchestrator when there is
				// still something to retire.
				const runId = scope?.runId;
				const run = runId ? input.store.readRun(runId) : null;
				const child = run?.children.find((candidate) => candidate.name === name);
				if (!runId || !run || !child) throw unknownChildError(name);
				if (child.state === "retired") return;
				const orchestrator = new Orchestrator({
					supervisor: input.supervisor,
					uiProxy: input.uiProxy,
					runDir: input.store.runDir(runId),
					cwd: input.cwd,
					maxDepth: input.settings.legion?.maxDepth,
					childContext: resolveTeamContext("child", input.settings, input.team),
					...teamForChildren(input.team),
					...rpcApproveFrom(input.settings),
					...(input.legion ? { legion: { ...input.legion, runId, runStore: input.store } } : {}),
					onBudgetRefused: input.onBudgetRefused,
				});
				orchestrator.restore(run);
				await orchestrator.retire(name, merged);
				await persistChild(input.store, runId, orchestrator, name);
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
			// Liveness facts are read once per name and reused by both the filter and
			// the block, so `status` cannot classify a child one way and render it
			// another (display-liveness D6 exit 1).
			const factsByName = new Map<string, StatusLivenessFacts & { pid?: number; inFlightTools?: InFlightToolStack }>();
			const factsFor = (child: StatusChildRecord): StatusLivenessFacts & { pid?: number; inFlightTools?: InFlightToolStack } => {
				const cached = factsByName.get(child.name);
				if (cached) return cached;
				const alive = input.supervisor.isAlive(child.name);
				const owner = ownerVerdictFor(store, () => runs, child.name, alive);
				// A pid only exists for a child this process actually tracks; a
				// record from another session has none, and none is invented.
				const pid = input.runtime.get(child.name)?.pid;
				// #315/#331: same rule for the in-flight stack — only this process's
				// live backend can answer, and `undefined` renders no line.
				const inFlightTools = inFlightToolStackOf(input.supervisor, child.name);
				const facts = {
					alive,
					...(owner ? { owner } : {}),
					...(pid ? { pid } : {}),
					...(inFlightTools ? { inFlightTools } : {}),
				};
				factsByName.set(child.name, facts);
				return facts;
			};
			const classified = classifyChildrenForStatus(runs, factsFor);
			const now = Date.now();
			return ok(
				renderStatusOverview(
					classified.map(({ child, live }) => {
						const { pid, inFlightTools, ...facts } = factsFor(child);
						return {
							child,
							...facts,
							...(pid ? { pid } : {}),
							...(inFlightTools ? { inFlightTools } : {}),
							live,
						};
					}),
					now,
				),
			);
		}
		// #344: the registry scan is a FALLBACK, not an entry fee. A name this
		// session is scoped to resolves from one `readRun`; the scan only happens
		// when the answer depends on other runs.
		const directRunId = scopeRunIdFor({
			runId: params.runId,
			sessionRunId: input.legion?.runId,
			trackedRunId: input.runtime.get(params.name)?.runId,
		});
		const scope = resolveScopedChild({
			name: params.name,
			explicitRunId: params.runId,
			directRunId,
			readRun: (runId) => store.readRun(runId),
			listRuns: () => store.listRuns(),
		});
		const hit = scope.hit;
		// #312: `status` is the one action that may SHOW a node it does not own, but
		// two same-named nodes are an ambiguity it must not resolve by preference —
		// that preference is how `status` and `collect` came to disagree.
		if (hit.kind === "elsewhere" && hit.candidates.length > 1) {
			return fail(ambiguousChildMessage("status", params.name, hit.candidates), ErrorCodes.NOT_FOUND);
		}
		// #270: a miss in this store is not a miss overall — a worktree child's
		// record lives under its own store, which this one cannot enumerate.
		const found = scope.found ?? findChildAcrossStores({
			name: params.name,
			cwd,
			callerCwd: input.callerCwd,
			ownRoot: store.rootDir,
		});
		if (!found) return unknownChild(params.name, store, cwd, input.callerCwd);
		// #312: when the record is not this session's own child, say which run it
		// came from. A direct hit adds nothing — the existing output is unchanged.
		//
		// Only an `elsewhere` hit is a foreign record. `absent` means the name is in
		// no run this store can enumerate and `found` came from the #270 cross-store
		// lookup — often a child of THIS session whose worktree store is elsewhere,
		// which this note would have mislabelled as "not a direct child".
		const resolvedNote =
			hit.kind === "elsewhere"
				? `resolved: ${params.name} is not a direct child of this session — showing the record from run ${found.runId}`
				: undefined;
		const alive = input.supervisor.isAlive(params.name);
		// #312: the owner verdict belongs to the run dir of the record just resolved
		// (`found.runId`) — not to whatever `pickChildByName` prefers across runs.
		const owner = ownerVerdictFor(store, scope.runs, params.name, alive, found.runId);
		// #315: what it is doing and for how long, prepended to the block when this
		// process is actually running a tool for it.
		const snapshot = renderLiveChildStatus({
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
		});
		const inFlightTools = inFlightToolStackOf(input.supervisor, found.child.name);
		const rendered = withInFlightToolLine(snapshot, inFlightTools, Date.now());
		return ok(resolvedNote ? `${resolvedNote}\n${rendered}` : rendered);
	}

	if (!params.name) {
		return fail(
			`\`name\` is required for the "${action}" action.`,
			ErrorCodes.INVALID_PARAMS,
		);
	}

	// #344: as in `status`, the full registry is the FALLBACK. Resolving a name
	// this call is already scoped to costs one `readRun` (0.05ms) instead of a
	// scan of every run ever written (26ms at 352 runs).
	const directRunId = scopeRunIdFor({
		runId: params.runId,
		sessionRunId: input.legion?.runId,
		trackedRunId: input.runtime.get(params.name)?.runId,
	});
	const scope = resolveScopedChild({
		name: params.name,
		explicitRunId: params.runId,
		directRunId,
		readRun: (runId) => store.readRun(runId),
		listRuns: () => store.listRuns(),
	});
	const hit = scope.hit;
	if (hit.kind === "elsewhere") {
		// #312: never guess between two same-named nodes, whichever action asked.
		if (hit.candidates.length > 1) {
			return fail(ambiguousChildMessage(action, params.name, hit.candidates), ErrorCodes.NOT_FOUND);
		}
		// `collect`/`continue` are defined over this session's direct children only,
		// so a same-named node elsewhere is a refusal that names the candidates —
		// not the old silent adoption of whatever `pickChildByName` preferred.
		//
		// Only when a scope EXISTS: a session with no run of its own has no direct
		// children to protect, and #209-3 keeps that path reaching a foreign/
		// restarted run's persisted record (the pre-existing contract tests build
		// exactly that store, with no launch in this session at all). The bug #312
		// describes needs a session run whose name resolution was overridden.
		if (directRunId !== undefined && STRICT_SCOPE_ACTIONS.has(action)) {
			return fail(notDirectChildMessage(action, params.name, hit.candidates), ErrorCodes.NOT_FOUND);
		}
	}
	// `steer`/`abort`/`retire` keep their pre-#312 reach (one unambiguous record
	// outside this session's run stays addressable); the scope run is still tried
	// first, so the common case never depends on the fallback.
	const found =
		scope.found ??
		findChildAcrossStores({
			name: params.name,
			cwd,
			callerCwd: input.callerCwd,
			ownRoot: store.rootDir,
		});
	if (!found) return unknownChild(params.name, store, cwd, input.callerCwd);

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
	if (action === "abort") return abortChild(ctx);
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
	callerCwd?: string,
): AgentToolResult<unknown> {
	// #270: search the stores that can plausibly hold the record before giving up.
	// A worktree child's store lives under `<runDir>/worktrees/<name>/.pi-subagents`,
	// which the root store can never enumerate, so a single-store lookup reports a
	// miss for a child that plainly exists.
	// The store already searched comes first, then every other candidate
	// (caller cwd, worktree stores). `resolveChildAcrossStores` re-searches the
	// own store too — that is deliberate: it returns the `searched` list the
	// message needs, and a store with no runs simply drops out of it.
	const { searched } = resolveChildAcrossStores({
		name,
		cwd,
		callerCwd,
		roots: [
			{ rootDir: path.resolve(store.rootDir), reason: "cwd" as const },
			...candidateStoreRoots({ cwd, callerCwd }).filter(
				(candidate) => candidate.rootDir !== path.resolve(store.rootDir),
			),
		],
	});
	return fail(
		unknownChildMessage({ name, cwd, searched: searched as CandidateStore[] }),
		ErrorCodes.NOT_FOUND,
	);
}

/**
 * The run a named control call is scoped to (#312).
 *
 * Three sources, in the order the caller can be sure of them:
 *
 *   1. `runId` on the call itself — the explicit scope, which wins over every
 *      inference (that is the escape hatch the refusal messages point at);
 *   2. the run this session owns, from its legion identity: every child this
 *      session launched outside a worktree record belongs here;
 *   3. the run the runtime is currently tracking the name under — the window
 *      where no legion identity resolves (a reloaded extension, a resumed run)
 *      but the child is still live and known to this process.
 *
 * `undefined` is a real answer: no scope means nothing is a direct child, so a
 * same-named record elsewhere is reported instead of silently adopted.
 */
function scopeRunIdFor(input: {
	runId?: string | undefined;
	sessionRunId?: string | undefined;
	trackedRunId?: string | undefined;
}): string | undefined {
	return input.runId ?? input.sessionRunId ?? input.trackedRunId;
}

/** Actions that may only ever act on this session's own direct child (#312). */
const STRICT_SCOPE_ACTIONS = new Set(["collect", "continue", "resume"]);

/**
 * Two or more same-named nodes and not one of them is this session's child.
 *
 * Never resolved by preference: the incident behind #312 is exactly what a
 * "prefer the live one, then the newest" tie-break produces. The candidates are
 * printed so the caller can name the run it meant.
 */
function ambiguousChildMessage(
	action: string,
	name: string,
	candidates: readonly ChildScopeCandidate[],
): string {
	return (
		`${name} is ambiguous: ${candidates.length} nodes carry that name and none of them is a direct child of this session, so \`${action}\` will not guess.\n` +
		describeChildScopeCandidates(candidates) +
		"\nPass `runId` to name the run that holds the one you mean."
	);
}

/**
 * Refuse an action whose contract is "this session's direct child" (#312).
 *
 * `collect` used to reach into whatever run `pickChildByName` preferred, which
 * is how a parent chasing its own FAILED `worker-0` was handed another run's
 * SUCCESSFUL one — the silent wrong node. The candidates are named so the caller
 * can either pass `runId` or go through the node's parent instead.
 */
function notDirectChildMessage(
	action: string,
	name: string,
	candidates: readonly ChildScopeCandidate[],
): string {
	return (
		`${name} is not a direct child of this session, so \`${action}\` cannot act on it. ` +
		`${candidates.length} node(s) carry that name:\n` +
		describeChildScopeCandidates(candidates) +
		`\n\`${action}\` only acts on this session's direct children; pass \`runId\`, or address the node through its parent's scope, to reach a grandchild.`
	);
}

/**
 * The parenthetical a queued steer carries (#313 D5).
 *
 * One constant on purpose: `steerReceipt` renders it for the `steer` tool and
 * the revive/continue branch reuses it for a live child, so the queue wording
 * exists exactly once.
 */
export const STEER_QUEUED_NOTE =
	"queued — it takes effect after its current tool batch finishes";

/** The same, for a steer an input handler swallowed before it was ever queued. */
export const STEER_INTERCEPTED_NOTE =
	"intercepted by an input handler — the child never saw it";

/**
 * Render the receipt for one accepted `steer` (#313 D5).
 *
 * The only place a steer receipt is built. The three dispositions are the only
 * three things a caller can honestly claim, and there is no "delivered":
 *
 * - `queued`: Pi consumes a steer after the child's current tool batch finishes
 *   and before its next LLM call, so a message sent into a running tool says
 *   nothing about the model having seen it yet. Not an error, and it must not
 *   read like one — but it must not read as success either.
 * - `accepted`: the child was idle, so this call started a turn with the text.
 *   The model still has to read it; this only says the session took the turn.
 * - `intercepted`: an input handler ate the text before the queue. The child
 *   never sees it, so the receipt must not open with "Steered".
 */
export function steerReceipt(
	name: string,
	disposition: SteerDisposition,
): string {
	if (disposition === "intercepted") {
		return `Steer ${name} was ${STEER_INTERCEPTED_NOTE}`;
	}
	if (disposition === "accepted") {
		return `Steered ${name} (a turn was started with it)`;
	}
	return `Steered ${name} (${STEER_QUEUED_NOTE})`;
}

/**
 * Send a message to a running child without waiting for its reply.
 *
 * Exported so `test/unit/steer-receipt.test.ts` can drive the receipt end to
 * end (same reason as `waitAction`/`stopAction`).
 */
export async function steerChild(
	ctx: ChildContext,
): Promise<AgentToolResult<unknown>> {
	if (!ctx.params.message) {
		return fail("`message` is required for steer.", ErrorCodes.INVALID_PARAMS);
	}
	try {
		// Await into a local so the existing `followChild` call keeps its place
		// between the steer and the receipt; the receipt itself is still
		// `ok(steerReceipt(...))` with the disposition this steer reported.
		const disposition = await ctx.orchestrator.steer(
			ctx.name,
			ctx.params.message,
		);
		followChild(ctx, { watch: true });
		return ok(steerReceipt(ctx.name, disposition));
	} catch (error) {
		return fail(`steer failed: ${String(error)}`, ErrorCodes.NOT_FOUND);
	}
}

/**
 * Render the receipt for one `abort` (#314 D7).
 *
 * The bounded wait the `timeout` receipt names comes from `outcome.timeoutMs` —
 * the bound the backend actually applied — and NOT from a default of this
 * function's own (#325). The tool surface never passes a `timeoutMs` (it stays a
 * `wait`-only parameter), so a local default would be a second, silent source of
 * truth: a caller that arms a different bound on the supervisor would still read
 * "within 5s" here.
 *
 * All three statuses are honest outcomes of a *soft* interrupt, and none of
 * them is a failure:
 *
 * - `interrupted`: the turn was cut short. Its context survives (the session is
 *   not retired), but whatever the interrupted tool had already written to disk
 *   stays written — a receipt that only promised "context kept" would let a
 *   caller assume a clean rollback.
 * - `no-turn`: nothing was running, so nothing was done. Saying "aborted" here
 *   would claim an interrupt that never happened.
 * - `timeout`: the abort was sent but the child had not settled inside the
 *   bounded wait. A tool that ignores cancellation looks exactly like this, so
 *   the receipt points at `stop` instead of pretending the turn died.
 */
export function abortReceipt(
	name: string,
	outcome: AbortOutcome,
): string {
	if (outcome.status === "no-turn") {
		return `Nothing to abort: ${name} is not running a turn.`;
	}
	if (outcome.status === "timeout") {
		const timeoutMs = outcome.timeoutMs;
		const seconds = timeoutMs % 1000 === 0 ? String(timeoutMs / 1000) : (timeoutMs / 1000).toFixed(1);
		return `Abort sent to ${name}, but it had not settled within ${seconds}s — the running tool may ignore cancellation; use stop (or stop with force) if it must die.`;
	}
	const dropped = outcome.cleared.steering + outcome.cleared.followUp;
	const base = `Aborted ${name}'s current turn (context kept; partial edits may remain)`;
	return dropped > 0 ? `${base} — dropped ${dropped} queued message(s)` : base;
}

/**
 * Interrupt a child's current turn without tearing the child down (#314 D7).
 *
 * The child keeps its session and context, so it stays continuable — that is
 * the whole difference from `stop`, which retires the process. Deliberately no
 * `followChild` here: abort must not register a new watch (the child is already
 * tracked and settles through its existing one).
 *
 * Exported so `test/unit/abort-action.test.ts` can drive the receipt and the
 * wiring (same reason as `steerChild`/`stopAction`).
 */
export async function abortChild(
	ctx: ChildContext,
): Promise<AgentToolResult<unknown>> {
	try {
		// Only an explicit `clearQueued: false` builds an options object; the
		// default path passes nothing, so the supervisor's own default (true)
		// stays the single source of truth.
		const outcome = await ctx.orchestrator.abort(
			ctx.name,
			ctx.params.clearQueued === false ? { clearQueued: false } : undefined,
		);
		return ok(abortReceipt(ctx.name, outcome));
	} catch (error) {
		return fail(`abort failed: ${String(error)}`, ErrorCodes.NOT_FOUND);
	}
}

/**
 * Wait for the child's current turn and derive its outcome from the session.
 *
 * Exported alongside `waitAction` for the index-layer unit tests: the claim the
 * runtime seam takes has to be handed back when this call bails (D2), and that
 * wiring is only observable from here.
 */
export async function collectChild(
	ctx: ChildContext,
	signal?: AbortSignal,
): Promise<AgentToolResult<unknown>> {
	try {
		if (signal?.aborted) return ok("interrupted (parent turn ended; children still running)");
		// #312: the runtime's job table is keyed by NAME, while everything below
		// acts on the node resolved in `ctx.found.runId`. A TRACKED job belonging to
		// another run is a different node: consuming its snapshot here would answer
		// with one node's result and persist it into another's run — the same silent
		// wrong-node answer the resolver exists to stop, one layer down.
		//
		// Only a tracked job can be cross-checked. A released one leaves its finished
		// cache behind (keyed by the run the snapshot CAME from, D9), and that cache is
		// the only answer left for the node — the #320 bail wiring collects exactly
		// that window, so an absent job must not be read as "a different run".
		const trackedJob = ctx.runtime.get(ctx.name);
		const foreignJob = trackedJob !== undefined && trackedJob.runId !== ctx.found.runId;
		const pending = foreignJob
			? undefined
			: signal
				? ctx.runtime.consumeCollectInterruptible(ctx.name, signal)
				: ctx.runtime.consumeCollect(ctx.name);
		if (pending) {
			const collected = await pending;
			// D2: the seam claims a terminal snapshot on the way out, because a flush in
			// that tick would otherwise repeat it. Every bail from here hands the result
			// to NOBODY, so the claim is handed back — a permanently suppressed notice
			// for a result the parent never saw is the worse failure of the two. The
			// rollback is told `claimedNow`, the flag this very call got back: only a claim
			// THIS call took comes back (#320/1), so a result an earlier delivery already
			// claimed keeps its evidence, and the job branch restores the notification
			// route with it (#320/2).
			if (!collected || signal?.aborted) {
				if (collected) {
					ctx.runtime.unclaimUndelivered(ctx.name, collected.snapshot, collected.claimedNow);
				}
				return ok("interrupted (parent turn ended; children still running)");
			}
			try {
				await persistChild(ctx.store, ctx.found.runId, ctx.orchestrator, ctx.name, { preserveRetired: true });
			} catch (error) {
				// Same rule for the other bail: `renderCollect` is never reached, so the
				// tool result will not carry this snapshot either.
				ctx.runtime.unclaimUndelivered(ctx.name, collected.snapshot, collected.claimedNow);
				throw error;
			}
			return ok(renderCollect(ctx.name, collected.snapshot));
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
		// Only release a job that IS the node just collected. Releasing by name alone
		// would drop the tracking of a still-live same-named child in another run.
		if (!foreignJob) ctx.runtime.release(ctx.name);
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
 * D8: a fresh progress baseline, taken from the session file as it is NOW.
 *
 * A child that has just been spawned (or relaunched from its session) may have
 * an empty or not-yet-created session file; `lines: 0` is then the honest
 * answer and everything written afterwards counts as progress. Never throws —
 * an unreadable file is "nothing written yet", not a launch failure.
 */
export function renewalBaselineFor(
	sessionFile: string,
	at: number = Date.now(),
	readLines: (file: string) => string[] | undefined = readSessionLines,
): { at: number; lines: number } {
	return { at, lines: readLines(sessionFile)?.length ?? 0 };
}

/**
 * D5-a: was this child **cut off by its turn budget** rather than finishing?
 *
 * `continue`/`resume` works on every terminal child, but only a budget casualty
 * should spend a renewal (D6) — otherwise an ordinary retry after a normal
 * failure quietly eats the budget, and the budget stops meaning anything.
 *
 * Judgement order is frozen by D5-a and follows `src/shared/session.ts`'s
 * measured semantics (F29), most reliable first:
 *
 *  1. `stopReason === "toolUse"` — the final assistant row was still waiting on
 *     a tool when the process went away: the classic budget-exhaustion shape.
 *  2. No assistant message for the last prompt — F29: a hard kill writes no
 *     assistant row at all, so "missing reply" IS the abort signal.
 *  3. `reason` mentions `terminated` — the host's own label, the weakest of the
 *     three because wording is not a contract.
 *
 * A clean `stop` / `length` turn (the user simply asked for another round)
 * matches none of them and does **not** spend a renewal.
 *
 * `shouldRecycleAfterCollect` is deliberately NOT used: it only separates
 * terminal from non-terminal, which is a different question.
 */
export function wasBudgetCut(execution: Execution | undefined): boolean {
	if (!execution) return false;
	// 1. Terminated while a tool call was outstanding.
	if (execution.stopReason === "toolUse") return true;
	// 2. F29 hard kill: the turn has no assistant row at all.
	if (
		execution.reason === NO_ASSISTANT_ABORT_REASON &&
		execution.stopReason !== "stop" &&
		execution.stopReason !== "length"
	) {
		return true;
	}
	// 3. Host wording, last resort.
	return execution.reason?.toLowerCase().includes("terminated") ?? false;
}

/**
 * D3: the renewal proposal to attach to a **real termination** notice, or
 * `undefined` when the contract says not to offer one.
 *
 * Extracted as a pure function (not inlined at the notify call site) because
 * the whole decision is testable without launching a child: "was the budget
 * cut + is the role renewable + has it a baseline" is arithmetic, not I/O.
 *
 * The four exits, all locked by tests:
 * - **D1** a `completed` child is never a renewal candidate: it produced a
 *   verdict, so offering `continue` would relaunch finished work.
 * - **D7/A3** a `running` snapshot is a `wait`/`collect` deadline on a **live**
 *   child (`inprocess-supervisor` merely resolved `{settled:false}`); the child
 *   never lost a budget, so renewing it would spend a fresh one for nothing.
 * - **D5/A4** `renewable: false` → no proposal at all, so the notice keeps the
 *   exact pre-W3 bytes (no renewal lines).
 * - **A2** no measurable progress is still **reported**: the caller passes the
 *   measurement through and `notify.ts` prints "no measurable progress". The
 *   proposal is withheld only for the three reasons above, never for "we could
 *   not tell".
 *
 * **A5/D6**: `used >= max` still gets a proposal — the renderer turns it into
 * `renewals exhausted (used/max) — split the task instead of renewing`. That is
 * a deliberate hand-off to the human, not silence.
 *
 * `maxRenewals: 0` (D6) is "renewal disabled": `renewable` is the role-level
 * switch, `0` the budget-level one, and both must agree before an offer is made.
 */
export function renewalProposalFor(input: {
	agent: Pick<AgentConfig, "renewable" | "maxRenewals"> | undefined;
	child: Pick<ChildRecord, "renewalBaseline" | "renewalsUsed">;
	/** Session file the progress measurement reads; the resume credential (D8). */
	sessionFile: string;
	execution: { status: string; reason?: string };
	name: string;
	/** Injectable for tests; defaults to W1's measurer over the real session file. */
	measure?: (sessionFile: string, baseline: { at: number; lines: number }) => {
		toolResults: number;
		assistantMessages: number;
		filesChanged?: number;
	};
}): RenewalProposal | undefined {
	const status = completionStatusOf(
		input.execution.status,
		// Acceptance is not part of this decision: D1 keys on the completion
		// status alone, and `unknown` + a parsed verdict is handled by the
		// caller's own status, not re-derived here.
		undefined,
	);
	// D1: a finished child is not a renewal candidate.
	if (status === "completed") return undefined;
	// D7: `running` is a live child behind a `wait`/`collect` deadline.
	if (status === "running") return undefined;
	// D5: the role forbids renewal (e.g. scout: a timed-out search was mis-scoped).
	if ((input.agent?.renewable ?? DEFAULT_RENEWABLE) === false) return undefined;
	const max = input.agent?.maxRenewals ?? DEFAULT_MAX_RENEWALS;
	// D6: `0` disables renewal outright; offering `0/0` would be a lie.
	if (max <= 0) return undefined;
	// D8: no baseline means nothing to measure against (#266-era records).
	const baseline = input.child.renewalBaseline;
	if (!baseline) return undefined;

	const used = input.child.renewalsUsed ?? 0;
	// D2 puts the worktree probe last, so the measurement is session-file only.
	const measured = (input.measure ?? defaultRenewalMeasure)(
		input.sessionFile,
		baseline,
	);
	return {
		progress: {
			toolResults: measured.toolResults,
			assistantMessages: measured.assistantMessages,
			...(measured.filesChanged !== undefined
				? { filesChanged: measured.filesChanged }
				: {}),
		},
		used,
		max,
		// D4/A8: renewal IS `continue`; the parent gets a finished command.
		command: `subagent({ action: "continue", name: "${input.name}", message: "<what to continue>" })`,
	};
}

/** Session-file half of {@link renewalProposalFor}; no worktree probe (D2 puts it last). */
function defaultRenewalMeasure(
	sessionFile: string,
	baseline: { at: number; lines: number },
): { toolResults: number; assistantMessages: number; filesChanged?: number } {
	return measureProgress({ sessionFile, baseline });
}

/**
 * D6/D8: charge one renewal to a child, D5-a's way.
 *
 * Split out from `reviveChild` so the arithmetic is testable in isolation: the
 * caller has already decided (via {@link wasBudgetCut}) whether this continue
 * was a budget casualty, and only then does the counter move.
 *
 * Absent `renewalsUsed` means "never renewed" (#266-era record), so it reads as
 * 0 rather than throwing. The baseline is the caller's business: it must come
 * from the **relaunched** session file, which only that layer holds.
 */
export function chargeRenewal(
	child: Pick<ChildRecord, "renewalsUsed">,
): number {
	const used = (child.renewalsUsed ?? 0) + 1;
	child.renewalsUsed = used;
	return used;
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
			// #313 D5: this branch steers a live child too, so it reports the same
			// three outcomes as `steerChild`, reusing the receipt notes rather than
			// writing a second copy of the wording.
			const disposition = await orchestrator.steer(name, params.message);
			followChild(ctx, { watch: true });
			const prefix = `${action === "resume" ? "Resumed" : "Continued"} ${name}`;
			if (disposition === "intercepted") {
				return ok(`${prefix}, but the steer was ${STEER_INTERCEPTED_NOTE}.`);
			}
			if (disposition === "queued") {
				return ok(`${prefix} (live child steered — ${STEER_QUEUED_NOTE}).`);
			}
			return ok(`${prefix} (live child steered).`);
		}

		const handle = await orchestrator.launch({
			agent: agentDef,
			task: params.message,
			name,
			...(found.child.model ? { model: found.child.model } : {}),
		});
		// D6/D8/D5-a: spend one renewal, but only if this child was actually cut
		// off by its turn budget.
		//
		// `continue` is legal on every terminal child (D4), yet an ordinary retry
		// after a normal `stop` must not eat the budget — otherwise two harmless
		// retries would silently exhaust the allowance that exists for genuine
		// budget casualties. `wasBudgetCut` answers that from the session shape
		// (F29/D5-a), not from `shouldRecycleAfterCollect` (terminal vs not, a
		// different question).
		//
		// The baseline is reset in both branches. A non-budget continue still
		// moved the child's own "since" line forward: keeping the old baseline
		// would count this whole extra turn as progress at the next termination
		// and overstate how much the child achieved under the current budget.
		const resumedChild =
			orchestrator.childrenSnapshot().find((entry) => entry.name === handle.name) ??
			// #344 review: `found.child` may be an element of the process-wide
			// `listRuns` snapshot, so mutating it in place would poison the cache
			// until the next write. The fallback is latent (launch always registers
			// the child), but a copy costs nothing and keeps the invariant local.
			{ ...found.child };
		// Read the verdict from `found.child`, NOT the orchestrator's record: `launch`
		// clears `previous.execution` before returning (it is a relaunch), and
		// `found` is a freshly parsed copy from `store.listRuns()`, so the pre-resume
		// outcome is still intact there. Reading the orchestrator's object here
		// would see `undefined` on every single resume and never charge anything.
		const budgetCut = wasBudgetCut(found.child.execution);
		resumedChild.renewalBaseline = renewalBaselineFor(handle.sessionFile);
		if (budgetCut) chargeRenewal(resumedChild);
		await persistChild(ctx.store, ctx.found.runId, ctx.orchestrator, handle.name);
		followChild(ctx, { watch: true });
		return ok(
			`Resumed ${handle.name} from its session. Context preserved from ${handle.sessionFile}`,
		);
	} catch (error) {
		// #309 D4: preserve the code the launcher already decided on (e.g.
		// `CHILD_TERMINAL` for a finished legion node) instead of flattening every
		// failure into `START_FAILED`. A `SubagentError` carries its code by
		// construction (`readonly code: string`), so the instance check IS the
		// condition — testing `&& error.code` would be a branch no input can
		// distinguish. Every other `Error` falls back to `START_FAILED`.
		// The code rides in `details.error` only — the body text stays code-free on
		// purpose, because the visible-text assertions in `test/unit/teams.test.ts`
		// and `test/integration/launch-queue.test.ts` require that a code never
		// leaks into what the model reads.
		const code =
			error instanceof SubagentError
				? error.code
				: ErrorCodes.START_FAILED;
		return fail(`${action} failed: ${String(error)}`, code);
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
	pi: ExtensionAPI;
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
		// #266 D6-a/D10: queue bounds + the D9 notice channel. The command chain is
		// the bug's main path (a 12-step `tasks[]` fanout against `maxChildrenPerNode`).
		launchQueue: launchQueueBounds(settings),
		onLaunchQueueNotice: launchQueueNoticeSink(input.pi),
		...(legion ? { legion: { db: legion.db, dbPath: legion.dbPath, nodeId: legion.nodeId, runId: run.runId, parentNodeId: legion.parentNodeId ?? undefined, parentRunId: legion.parentRunId ?? undefined, runStore: store, settings: legion.settings, eventBus: legion.eventBus, ...(legion.machineForRole ? { machineForRole: legion.machineForRole } : {}) } } : {}),
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
		// #266 D7/A5: a parent turn end empties the launch queue and spawns nothing.
		// Deliberately only HERE (and in the vexillatio interrupt): Esc/wait
		// interruptions end the parent's *wait*, not its turn, and must leave
		// children — queued ones included — running (`esc-no-retire-v3`).
		const flushed = orchestrator.flushLaunchQueue("parent turn ended");
		for (const name of session.handles) await abandonLaunchedChild(session, name);
		session.handles.length = 0;
		const flushLine = launchQueueFlushLine(flushed);
		return {
			content: [{
				type: "text",
				text: [
					// The head line LEADS (same frozen shape as the vexillatio interrupt):
					// the outer abort net keeps an inner result that already reports the
					// interruption, and only a leading head makes that detection reliable
					// — otherwise each `parent turn ended; child still running (watched)`
					// line reads like a standalone notice and the flush line is lost.
					INTERRUPTED_HEAD,
					session.results.join("\n"),
					flushLine,
				].filter(Boolean).join("\n"),
			}],
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
			// The origin distinguishes a deliberate per-run model from the parent's
			// model falling through; the launch line reports which one won.
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
			`▶ ${handle.name} (${effective.name}) supervisor=${handle.spawnMode}${launchLineQueueSuffix(handle)}`,
		);
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

/**
 * Collect one child, tolerating the transient gap an admission creates.
 *
 * `pumpAdmissions` deletes the `queued` placeholder before replaying the real
 * launch, so between those two steps the name exists in neither the placeholder
 * map nor the freshly spawned record. `collect()` resolves names through
 * `requireChild`, so a collect that lands in that window throws
 * `unknown child: <name>` — a race, not a real failure, and one only a queued
 * child can hit. The window is a microtask-or-two long (the replay is awaited),
 * so a short bounded retry is enough; anything genuinely gone still surfaces.
 *
 * Only used by the sequential `async:false` path. `async:true` never collects
 * here — its watcher goes through the same `collect` but is re-armed, so a retry
 * loop there would fight the watcher instead of helping it.
 */
async function collectThroughAdmission(
	session: LaunchSession,
	name: string,
	signal?: AbortSignal,
): Promise<Awaited<ReturnType<Orchestrator["collect"]>>> {
	const deadline = Date.now() + ADMISSION_SETTLE_TIMEOUT_MS;
	for (;;) {
		try {
			return await session.orchestrator.collect(name, {
				timeoutMs: session.timeoutByName.get(name) ?? DEFAULTS.turnTimeoutMs,
				...(signal ? { signal } : {}),
			});
		} catch (error) {
			const transient = error instanceof SubagentError && error.code === ErrorCodes.NOT_FOUND;
			if (!transient || Date.now() >= deadline || signal?.aborted) throw error;
			await new Promise((resolve) => setTimeout(resolve, ADMISSION_SETTLE_POLL_MS));
		}
	}
}

/**
 * How long a collect may retry across the admission gap before reporting it.
 *
 * Deliberately much shorter than a turn timeout: the gap is two `await`s wide,
 * so anything still missing after this long is not racing — it is gone.
 */
const ADMISSION_SETTLE_TIMEOUT_MS = 5_000;
const ADMISSION_SETTLE_POLL_MS = 25;

/** Wait for each launched child's turn, appending its outcome. */
async function collectInline(session: LaunchSession, signal?: AbortSignal): Promise<void> {
	// #266 D8: collect children that already hold a slot FIRST.
	//
	// A queued handle resolves synchronously (`launch()` returns it before any
	// spawn), so it lands in `handles` BEFORE the admitted siblings. Collecting in
	// raw launch order would therefore block on the queued child first — waiting
	// for a slot that only those very siblings can release once THEY are
	// collected — i.e. a deadlock, not a wait. Launch order is preserved within
	// each group, so a run with no queue keeps its exact previous order.
	const queuedHere = new Set(
		session.orchestrator
			.childrenSnapshot()
			.filter((child) => child.state === "queued")
			.map((child) => child.name),
	);
	const ordered = [
		...session.handles.filter((name) => !queuedHere.has(name)),
		...session.handles.filter((name) => queuedHere.has(name)),
	];
	for (const name of ordered) {
		if (signal?.aborted) {
			session.results.push("interrupted (parent turn ended; children still running)");
			return;
		}
		try {
			const collected = await collectThroughAdmission(session, name, signal);
			if (signal?.aborted || collected.execution.reason === "aborted by parent") {
				session.results.push("interrupted (parent turn ended; children still running)");
				return;
			}
			session.results.push(renderCollect(name, collected));
			// #266 D8/A20: `async:false` must report the real wait, not just look slow.
			// Read AFTER collect: `queueWaitedMs` is written at admission, so an item
			// that is still waiting when the collect deadline fires has no line yet.
			const waitedLine = queuedWaitLine(
				session.orchestrator.childrenSnapshot().find((child) => child.name === name),
			);
			if (waitedLine) session.results.push(waitedLine);
			// A finished child must release its slot BEFORE the next collect starts,
			// or a queue can never drain: `collectInline` is sequential, and the
			// caller's retire loop runs after every collect (so with `maxChildrenPerNode:
			// 1` the second child would wait for a slot the first still holds).
			// Gated on a non-empty queue so the un-queued fast path is unchanged.
			if (
				session.orchestrator.launchQueueEntries().length > 0 &&
				shouldRecycleAfterCollect(collected.execution.status)
			) {
				await session.orchestrator.retire(name);
			}
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
	const singleTask = params.task ?? "";
	const parallel = params.tasks?.length ? params.tasks : undefined;
	// `tasks[]` wins and `task` degrades to a parent-run label, so both shapes
	// accepted by the schema reach a launch: `{ task }`, `{ tasks }`, `{ task, tasks }`.
	if (!parallel && !singleTask.trim()) {
		return { ok: false, message: "Provide one of: `task` (single recon) or `tasks[]` (parallel recon)." };
	}
	const steps: UtilityTaskItem[] = parallel
		? parallel
		: [{ agent: params.agent?.trim() || "scout", task: singleTask }];
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
			rootSessionFile: input.ctx.sessionManager?.getSessionFile(),
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
			// #266: the parallel-recon path shares the same bounds and notice channel
			// as the command chain — one scheduler for every dispatch family (D2).
			launchQueue: launchQueueBounds(catalog.settings),
			onLaunchQueueNotice: launchQueueNoticeSink(input.pi),
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
					...(legion.machineForRole ? { machineForRole: legion.machineForRole } : {}),
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
			// #266: a queued item is never "failed" — it never started. Treating it as
			// still running keeps it out of the failure list and lets the retry/watch
			// path own it, instead of retiring a launch the caller only asked to wait on.
			const queuedNow = handle.orchestrator
				.childrenSnapshot()
				.find((entry) => entry.name === handle.name)?.state === "queued";
			if (queuedNow) {
				followUtility(handle, true);
				stillRunning.add(handle.name);
				return `── ${handle.name} ──\nexecution: queued (waiting for a free slot)\nsessionFile: ${handle.sessionFile}`;
			}
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
	if (input.signal?.aborted) {
		// #266 D7/A5: same rule as the command chain — a parent turn end empties
		// every dispatch family's queue and spawns nothing. Each utility item owns
		// its own Orchestrator, so each one flushes its own view of the shared queue.
		const flushed: string[] = [];
		for (const handle of handles) {
			const child = handle.orchestrator.childrenSnapshot().find((entry) => entry.name === handle.name);
			// D9: a queued item produced no result, so it must never be reported as
			// one. It is either dropped by the flush below (reported by name) or, if
			// it was already admitted, genuinely still running.
			if (child?.state === "queued") flushed.push(...handle.orchestrator.flushLaunchQueue("parent turn ended"));
		}
		return interruptedUtilityResult({
			runId,
			handles,
			stillRunning,
			results,
			collected,
			flushed,
		});
	}
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
	/** #266 D7: names the abort cleared out of the launch queue (seq order). */
	flushed?: readonly string[];
}): AgentToolResult<unknown> {
	const head = "interrupted (parent turn ended; children still running)";
	// #266 D7: a dropped queued launch is the reason the rest of the result is
	// short, so it is reported even when nothing was collected at all. Trailing,
	// like the command chain's line: it reads as a summary of what was cleared.
	const segments = [
		...input.results,
		...input.collected,
		launchQueueFlushLine(input.flushed ?? []),
	].filter((segment) => segment.length > 0);
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
/**
 * D8: give a child its spawn-time progress baseline exactly once.
 *
 * Called before every persist, so whichever launch path created the record
 * seeds it at (as near as makes no difference) spawn time: `persistChild` runs
 * immediately after `launch()` on every path — fresh launch, `tasks[]` fan-out,
 * utility dispatch — and the session file is empty-ish at that moment by
 * definition (`lines: 0` is then the honest answer, see {@link renewalBaselineFor}).
 *
 * The guard is "absent", never "stale":
 * - a record written before this field existed seeds on its next write, which
 *   is the first moment anything is known about it;
 * - a renewed child keeps the baseline `reviveChild` handed it, so D8's
 *   "count only what happened since the renewal" cannot be undone here.
 */
export function seedRenewalState(
	child: Pick<ChildRecord, "sessionFile" | "renewalBaseline" | "renewalsUsed">,
	now: number = Date.now(),
	readLines: (file: string) => string[] | undefined = readSessionLines,
): void {
	if (!child.renewalBaseline) {
		child.renewalBaseline = renewalBaselineFor(child.sessionFile, now, readLines);
	}
	if (child.renewalsUsed === undefined) child.renewalsUsed = 0;
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
	// D8: every persist path is a launch path on its first call, so this is where
	// a fresh child gets its baseline (see `seedRenewalState` for why it is safe
	// to run unconditionally on later persists too).
	seedRenewalState(child);
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
	// #266: a launch that never started cannot be "still running". Reporting it as
	// watched would contradict the `N queued launch(es) dropped` line and tell the
	// caller to wait for a child that will never produce a turn.
	if (child.state === "queued") return;
	// Esc / parent-turn abort must not retire: child keeps running; follow+watch
	// so settle still notifies the parent (esc-no-retire-v3).
	followLaunched(session, name, { watch: true });
	session.results.push(`▶ ${name}: parent turn ended; child still running (watched)`);
}

// ---------------------------------------------------------------------------
// wait (§1.5): block for results instead of relying on async notices
// ---------------------------------------------------------------------------

/**
 * Child-record states that are terminal, so a record carrying one is never live
 * (display-liveness D6, exit 1). `failed`/`settled` live on the execution side
 * rather than in `TaskState`, but a run.json written by another version (or a
 * hand-edited record) can carry them and they are terminal either way, so the
 * set is keyed on strings instead of the narrow state union.
 */
const TERMINAL_STATUS_CHILD_STATES = new Set<string>([
	"retired",
	"exited",
	"failed",
	"settled",
]);

/** The persisted child record shape, as resolved through the run store. */
type StatusChildRecord = NonNullable<ReturnType<RunStore["findChild"]>>;

/**
 * Liveness facts for one child, supplied by the caller.
 *
 * `alive` is this process's in-memory supervisor answer (it never holds a child
 * launched by another session); `owner` is the run-dir ownership verdict that
 * covers that hole (#209-3). See {@link ownerVerdictFor}.
 */
export interface StatusLivenessFacts {
	alive: boolean;
	/** `undefined` while `alive` — in-memory liveness already decided (#209-3). */
	owner?: "live" | "dead" | "unknown";
}

/** One run record after the status filter ran (display-liveness D6 exit 1). */
export interface StatusChildClassification {
	child: StatusChildRecord;
	/**
	 * Counted in `Status · N live children`. `false` = listed but NOT counted:
	 * the record's run-dir owner pid is gone (#209-3 / A3).
	 */
	live: boolean;
}

/**
 * Split the persisted child records under this cwd into `live` and `dead`.
 *
 * A record is dead when its owner pid is gone and this process is not running
 * it — not merely when its `state` says so. `owner === "unknown"` counts as
 * live: filtering unknown out would hide a child that may well be starting, and
 * D2 forbids collapsing unknown into dead. Its block still reports
 * `owner: unknown` + `state=working`, so it is never *displayed* as confirmed
 * live — it is only not hidden.
 *
 * Names can be reused after retire, so the newest record per name wins, except
 * that a dead record never shadows an older record of the same name that is
 * still alive (same preference as {@link pickChildByName}).
 *
 * Without `factsFor` the filter falls back to the record state alone; that keeps
 * this callable from a context that has no store (and keeps the pre-liveness
 * signature working), but the `status` exit must pass facts.
 */
export function classifyChildrenForStatus(
	runs: ReturnType<RunStore["listRuns"]>,
	factsFor?: (child: StatusChildRecord) => StatusLivenessFacts,
): StatusChildClassification[] {
	const ranked = [...runs].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
	const candidates: StatusChildClassification[] = [];
	for (const run of ranked) {
		for (const child of run.children) {
			if (TERMINAL_STATUS_CHILD_STATES.has(child.state)) continue;
			const facts = factsFor?.(child);
			// Dead = the run dir's owner pid is gone AND this process is not running
			// it. `owner === "unknown"` (no marker, or no pid in it) is never dead:
			// unknown must not be collapsed into dead (display-liveness D2).
			const live = !(facts?.owner === "dead" && !facts.alive);
			candidates.push({ child, live });
		}
	}
	// Name reuse: a newer DEAD record must not shadow an older record of the
	// same name that is still live (mirror of `pickChildByName`, which prefers a
	// live match over a newer retired one). Among equals the newest wins, hence
	// the newest-first iteration order.
	const chosen = new Map<string, StatusChildClassification>();
	for (const entry of candidates) {
		const prior = chosen.get(entry.child.name);
		if (!prior || !prior.live) chosen.set(entry.child.name, entry);
	}
	return candidates.filter((entry) => chosen.get(entry.child.name) === entry);
}

/**
 * Live children under this cwd for the status overview.
 *
 * Pass `factsFor` to decide liveness from owner evidence instead of the record
 * state alone; see {@link classifyChildrenForStatus}.
 */
export function listLiveChildrenForStatus(
	runs: ReturnType<RunStore["listRuns"]>,
	factsFor?: (child: StatusChildRecord) => StatusLivenessFacts,
): StatusChildRecord[] {
	return classifyChildrenForStatus(runs, factsFor).flatMap((entry) =>
		entry.live ? [entry.child] : [],
	);
}

/** One child block for {@link renderStatusOverview}. */
export interface StatusChildEntry {
	child: StatusChildRecord;
	alive: boolean;
	/** Run-dir ownership verdict (#209-3); see {@link renderLiveChildStatus}. */
	owner?: "live" | "dead" | "unknown";
	/**
	 * Own process of an `rpc` child, when this session launched it. A pid is
	 * not persisted, so a record from another session has none — and none is
	 * invented here (D3).
	 */
	pid?: number;
	/**
	 * `false` = listed but not counted in the header (owner pid gone, see
	 * {@link classifyChildrenForStatus}). Absent means live, so callers that only
	 * hold live children keep their meaning.
	 */
	live?: boolean;
	/**
	 * Tool calls in flight right now (#315, #331), innermost last. Supplied by
	 * the supervisor; absent means no activity fact, which renders no line at all.
	 */
	inFlightTools?: InFlightToolStack;
}

/** Multi-child status text: one {@link renderLiveChildStatus} block per child. */
export function renderStatusOverview(children: StatusChildEntry[], now: number = Date.now()): string {
	const deadCount = children.filter((entry) => entry.live === false).length;
	const liveCount = children.length - deadCount;
	const blocks = children.map(({ child, alive, owner, pid, inFlightTools }) =>
		withInFlightToolLine(
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
			inFlightTools,
			now,
		),
	);
	const parts: string[] = [];
	if (liveCount === 0) {
		// Nothing live. With no record at all this stays the exact literal the
		// tests pin; with records that are all dead the count line below says so,
		// instead of implying the run directory is empty.
		parts.push("No live children.");
	} else {
		const noun = liveCount === 1 ? "child" : "children";
		parts.push(`Status · ${liveCount} live ${noun}`);
	}
	if (deadCount > 0) parts.push(`(${deadCount} dead)`);
	if (blocks.length > 0) parts.push("", blocks.join("\n\n"));
	return parts.join("\n");
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
	runs: () => ReturnType<RunStore["listRuns"]>,
	name: string,
	alive: boolean,
	runId?: string | undefined,
): "live" | "dead" | "unknown" | undefined {
	if (alive) return undefined;
	// #312: a named `status` resolved ONE node, so the verdict has to come from
	// that node's run dir. Reading it through `pickChildByName` mixed the record
	// this call displays with the owner marker of another run's same-named node —
	// a child whose own run dir is owned by this live process could render
	// `owner: dead (pid gone)` and even be rewritten to `state=failed`.
	if (runId) return ownerState(path.join(store.runDir(runId), RUN_OWNER_FILE));
	// Only a caller with no resolved run reaches this: the registry scan happens
	// here and nowhere earlier (#344).
	const picked = pickChildByName(runs(), name);
	if (!picked) return "unknown";
	return ownerState(path.join(store.runDir(picked.run.runId), RUN_OWNER_FILE));
}

/** The run a resolved `stop` target lives in (#312). */
export interface StopRetireScope {
	/**
	 * The run `stopAction` resolved this name in. The executor must read THIS
	 * record — re-resolving the name across runs is how `stop` came to report one
	 * node and retire another.
	 */
	runId?: string | undefined;
}

/** One node `stop` will retire, with the run that owns it (#312). */
interface StopTarget {
	name: string;
	runId: string;
}

/**
 * Refuse `stop({name, runId})` when that name's live job sits in another run (#312).
 *
 * The runtime's job table is keyed by NAME, so before this check a live child
 * answered a call scoped to a different run and was retired anyway — the
 * "reported one node, retired another" failure one layer above the store path.
 * A live job is a node of exactly one run, so the two are a conflict, never a
 * preference: neither may be retired by a tie-break. The wording is the same
 * elsewhere/ambiguity pair the store path uses, because the caller's lever is
 * the same — name the run that actually holds the node.
 */
function stopScopeMismatchMessage(
	name: string,
	live: { runId: string; nodeId?: string | undefined; state: string },
	runs: ReturnType<RunStore["listRuns"]>,
): string {
	// The scan names every same-named node; the live job is added on its own
	// because a just-spawned child may not have a persisted record yet.
	const scanned = scopeHitFor({ name, directRunId: undefined, explicitRunId: undefined, runs });
	const candidates = dedupeChildScopeCandidates([
		...(scanned.kind === "elsewhere" ? scanned.candidates : []),
		{
			runId: live.runId,
			...(live.nodeId ? { nodeId: live.nodeId } : {}),
			state: live.state,
		},
	]);
	return candidates.length > 1
		? ambiguousChildMessage("stop", name, candidates)
		: notDirectChildMessage("stop", name, candidates);
}

/**
 * One entry per node: the same run can be seen twice (persisted scan + live job).
 *
 * Sorted by `runId` like the resolver's own scan, so the message is stable.
 */
function dedupeChildScopeCandidates(
	candidates: readonly ChildScopeCandidate[],
): ChildScopeCandidate[] {
	const seen = new Set<string>();
	const out: ChildScopeCandidate[] = [];
	for (const candidate of candidates) {
		const key = `${candidate.runId}\u0000${candidate.nodeId ?? ""}`;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(candidate);
	}
	return out.sort((a, b) => a.runId.localeCompare(b.runId));
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
	/**
	 * #312: the run this call is scoped to (`runId` on the tool call, else the
	 * session's own run). Only a child of THIS run may be stopped by name; a
	 * same-named record elsewhere is reported instead of adopted.
	 */
	runId?: string | undefined;
	/** The run this session owns, used when the call names no `runId` (#312). */
	sessionRunId?: string | undefined;
	/**
	 * Retire one already-resolved target.
	 *
	 * `scope` carries the run the target was resolved IN, so the executor can act
	 * on that exact record instead of resolving the name again by preference
	 * (#312) — one resolver here, one node retired there.
	 */
	retire: (name: string, opts?: RetireOptions, scope?: StopRetireScope) => Promise<void>;
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
	let targets: StopTarget[];
	if (params.all) {
		targets = active.map((job) => ({ name: job.name, runId: job.runId }));
	} else {
		// Local const so the earlier `name`/`all` guard narrows through the lookup.
		const name = params.name;
		const target = name ? jobs.find((job) => job.name === name) : undefined;
		if (name && input.runId !== undefined && target && target.runId !== input.runId) {
			// #312: the job table is keyed by NAME, so a live child answered a call
			// scoped to another run and got retired anyway — the presented node and the
			// retired node disagreed again, one layer up (fixing only the store path
			// would have left this silent). A live job belongs to exactly one run, so
			// the mismatch is a conflict: refuse it with the wording the store path uses.
			return fail(
				stopScopeMismatchMessage(name, target, input.store ? input.store.listRuns() : []),
				ErrorCodes.NOT_FOUND,
			);
		}
		if (!target) {
			// Not tracked by this session, but a foreign/restarted run may still own a
			// persisted record — the same records `status` can display.
			//
			// #312: it has to be this session's OWN child. The old fallback took
			// whatever `pickChildByName` preferred across every run, and when that
			// happened to be a different run's retired record the whole call collapsed
			// into `No non-retired children to stop.` — which told the caller nothing
			// about the name being ambiguous, and hid the node it was trying to stop.
			const runs = input.store ? input.store.listRuns() : [];
			const directRunId = scopeRunIdFor({
				runId: input.runId,
				sessionRunId: input.sessionRunId,
				trackedRunId: name ? runtime.get(name)?.runId : undefined,
			});
			const found = name ? foundInScope(runs, directRunId, name) : null;
			if (!found) {
				const hit = name
					? scopeHitFor({ name, directRunId, explicitRunId: input.runId, runs })
					: undefined;
				if (hit?.kind === "elsewhere") {
					const ambiguous = hit.candidates.length > 1;
					// A session with no run of its own (#209-3: a foreign or restarted run's
					// record) has no direct children, so a unique match stays reachable. With
					// a scope, a name that is not in it is refused instead of adopted — that
					// adoption is what turned into `No non-retired children to stop.`
					if (ambiguous || directRunId !== undefined) {
						const message = ambiguous
							? ambiguousChildMessage("stop", name ?? "", hit.candidates)
							: notDirectChildMessage("stop", name ?? "", hit.candidates);
						return fail(message, ErrorCodes.NOT_FOUND);
					}
					const permissive = name ? foundElsewhere(runs, name, hit) : null;
					if (!permissive) {
						return fail(`unknown child: ${params.name} (not tracked by this session).`, ErrorCodes.NOT_FOUND);
					}
					targets = permissive.child.state === "retired" ? [] : [{ name: permissive.child.name, runId: permissive.runId }];
				} else {
					return fail(`unknown child: ${params.name} (not tracked by this session).`, ErrorCodes.NOT_FOUND);
				}
			} else {
				targets = found.child.state === "retired" ? [] : [{ name: found.child.name, runId: found.runId }];
			}
		} else {
			targets = target.state === "retired" ? [] : [{ name: target.name, runId: target.runId }];
		}
	}
	if (targets.length === 0) return ok("No non-retired children to stop.");

	// Stop every watcher before any retire starts: a later target must not finish
	// its own watch (and notify/release) while an earlier target is being retired.
	for (const { name } of targets) runtime.cancelWatch(name);

	const stopped: string[] = [];
	const failures: string[] = [];
	for (const { name, runId } of targets) {
		try {
			// The runtime job may have been released after the target snapshot was
			// taken. `scope` hands the resolve-time run to the executor, which reads
			// THAT record rather than picking one across runs (#312).
			await retire(name, retireOpts, { runId });
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

/**
 * #352: one completion claim a `wait` took for a result the parent never saw.
 *
 * `waitAction` claims a settled child's result on its finished-cache probe
 * (`runtime.consumeCollect`, `index.ts` — the probe is NOT side-effect free since
 * notice-claim-v1), and the tool layer in this file can still throw the rendered
 * result away when the parent turn ends. Only a claim THIS call took travels here
 * (`claimedNow === true`): a key an earlier real delivery claimed is evidence, not
 * something a bail may spend (#320/1).
 */
export interface WaitClaim {
	name: string;
	snapshot: CollectSnapshot;
}

/**
 * #352: hand back every claim a discarded `wait` result owed.
 *
 * `unclaimUndelivered`, never `unclaimReported`: nothing reached the parent, so the
 * queued notice is the ONLY remaining route — the rollback gives the claim back and
 * drops no copy (D2/D7). `claimedNow` is always `true` here: `WaitClaim`s only exist
 * for claims this call took.
 *
 * #352 review (major 1): the claim arrives ASYNCHRONOUSLY. `waitAction`'s
 * finished-cache probe is a promise (`consumeCollect` → `ensureCollect`), and the wait
 * can bail long before it answers — `signal?.aborted`, `WAIT_INTERRUPTED` and
 * `WaitTimeoutError` all win their race inside `waitOne` while that collect is still in
 * flight. The probe then resolves to a terminal snapshot and claims `(runId, name,
 * round)` AFTER the details object was already built, so the bail has to wait for that
 * answer before it rolls anything back: `details.waitClaims` is a live array (shared by
 * reference with `waitAction`), and `details.waitClaimsPending` is the promise that
 * resolves once the probe has folded its claim in. Awaited first, both windows are
 * covered: the claim that was already there, and the one that landed late.
 *
 * The await is bounded by the probe's own collect, which is what makes the claim
 * knowable at all; returning now and rolling back from a detached continuation would
 * hand the claim back after the frozen `interrupted …` line already went out.
 */
export async function releaseWaitClaims(runtime: SessionRuntime, details: unknown): Promise<void> {
	if (details === null || typeof details !== "object") return;
	const record = details as { waitClaims?: unknown; waitClaimsPending?: unknown };
	const pending = record.waitClaimsPending;
	if (pending !== undefined) {
		try {
			await (pending as Promise<unknown>);
		} catch {
			// A throwing probe took no claim — nothing to give back.
		}
	}
	const claims = record.waitClaims;
	if (!Array.isArray(claims)) return;
	for (const claim of claims as WaitClaim[]) {
		runtime.unclaimUndelivered(claim.name, claim.snapshot, true);
	}
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
	// #352: every claim THIS call takes. The array is shared by REFERENCE with the
	// returned `details.waitClaims`, because the probe below answers asynchronously:
	// a claim that lands after the details object was built must still be visible to
	// a caller that discards the rendered result.
	const claims: WaitClaim[] = [];
	// #352 review (major 1): the probe's answer, absent when this wait has no probe at
	// all (live targets). It resolves to `claims` once the probe's own claim — if any —
	// has been folded in, and travels out as `details.waitClaimsPending` so a bail that
	// lands while it is still in flight can wait for it instead of rolling back nothing.
	let claimsPending: Promise<WaitClaim[]> | undefined;
	let targets = resolveWaitTargets(
		{ name: params.name, all: params.all },
		jobs,
	);
	if (!targets.ok) {
		// A name that is merely finished (not live) is still waitable via the
		// runtime's finished cache — probe it with consumeCollect. NOTE: since
		// notice-claim-v1 that probe is NOT side-effect free: a cache hit claims the
		// result, which is correct here — the wait below returns the same result to the
		// parent, so the pushed notice for it is suppressed instead of duplicating it.
		// It is also why the claim travels back out (#352): if the caller never hands
		// the result over, nobody else can, and the claim must be given back.
		if (params.name && !params.all) {
			const probe = runtime.consumeCollect(params.name);
			if (probe) {
				const name = params.name;
				claimsPending = probe.then((claimed: ClaimedCollect) => {
					// #320/1: only a claim THIS call took may come back later.
					if (claimed.claimedNow) claims.push({ name, snapshot: claimed.snapshot });
					return claims;
				}, () => {
					// A throwing collect is the `wait` below's problem, not the probe's.
					return claims;
				});
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
	const timeoutDetails = buildWaitTimeoutDetails(results);
	// #352: `details.waitClaims` is the only record of what this call took — the tool
	// layer's abort net replaces the rendered result with the frozen `interrupted …`
	// line, and without this the claim it leaves behind suppresses that round's notice
	// forever.
	//
	// #352 review (major 1): mount BOTH unconditionally. Deciding on `claims.length` was
	// a no-op: one probe means at most one claim, and the probe has usually not answered
	// yet at this point — so the length test mounted nothing in the window that matters,
	// and when it did mount it shared a reference with a caller that could reach it anyway.
	// The array stays live (late pushes land in the same object) and the promise says
	// when the probe got its answer.
	const details: Record<string, unknown> = timeoutDetails ? { ...timeoutDetails } : {};
	details.waitClaims = claims;
	if (claimsPending) {
		// Non-enumerable: this is a live promise, and `details` is the tool result's
		// record — a promise has no business in a serialized transcript.
		Object.defineProperty(details, "waitClaimsPending", {
			value: claimsPending,
			enumerable: false,
			configurable: true,
		});
	}
	return { content: [{ type: "text", text }], details };
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

/**
 * #270: resolve a child from another store when this one has no record.
 *
 * Only reached on a miss, so the common case (child launched here) costs
 * nothing. The returned shape matches {@link findChild} so callers do not care
 * which store answered — except that `runDir` now belongs to the owning store,
 * which is why the caller re-derives its orchestrator run directory from it.
 */
function findChildAcrossStores(input: {
	name: string;
	cwd: string;
	callerCwd?: string | undefined;
	ownRoot: string;
}): {
	runId: string;
	run: ReturnType<RunStore["listRuns"]>[number];
	child: NonNullable<ReturnType<RunStore["findChild"]>>;
} | null {
	const { found } = resolveChildAcrossStores({
		name: input.name,
		cwd: input.cwd,
		callerCwd: input.callerCwd,
		roots: candidateStoreRoots({ cwd: input.cwd, callerCwd: input.callerCwd }).filter(
			(candidate) => path.resolve(candidate.rootDir) !== path.resolve(input.ownRoot),
		),
	});
	if (!found) return null;
	// Read the owning store again for the full record: `resolveChildAcrossStores`
	// only reports where the name was seen.
	const runs = new RunStore({ rootDir: found.storeRoot }).listRuns();
	const picked = pickChildByName(runs, input.name);
	if (!picked) return null;
	return { runId: picked.run.runId, run: picked.run, child: picked.child };
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
