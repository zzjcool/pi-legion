/**
 * Single-run orchestration over the RPC supervisor.
 *
 * Process lifecycle belongs to LegionSupervisor. Session JSONL remains the
 * sole source of execution outcomes; this module owns run records, budgets,
 * lineage, acceptance and worktree setup.
 */

import * as fs from "node:fs";
import { randomBytes } from "node:crypto";
import * as path from "node:path";
import { modelCandidates } from "../agents/model-resolution.ts";
import { DEFAULT_TEAM, TEAM_ENV, type ActiveTeam } from "../agents/teams.ts";
import type { LegionSettings } from "../shared/types.ts";
import { LEGION_IDENTITY_ENV_KEYS, legionIdentityEnv } from "./args.ts";
import type { DatabaseSync } from "../legion/db.ts";
import type { RunStore } from "./store.ts";
import type { LegionEventBus, LegionProcessEventType } from "../extension/event-bus.ts";
import { appendEvent } from "../legion/events.ts";
import { withLaunchBudget, type LegionBudgetLimits } from "../legion/budget.ts";
import { getChildByName, getNode, insertNode, nodeIdForChild, sanitizeNodeSlug, type LegionNode, updateNode } from "../legion/nodes.ts";
import { upsertUsage } from "../legion/usage.ts";
import { evaluatePhaseTransition, isLegionPhase, isTerminalPhase } from "../legion/state-machine.ts";
import { CHILD_ACCEPTANCE_ROLE_ENV, CHILD_ROLE_ENV } from "../extension/child-guard.ts";
import {
	ALLOW_NESTED_ENV,
	MAX_TOOL_CALLS_ENV,
	MAX_TURNS_ENV,
	TOOL_TIMEOUT_MS_ENV,
} from "../extension/budget.ts";
import { canUseCachedCollect } from "../extension/recycle.ts";
import {
	countAssistantMessages,
	attributeParentSessionShutdown,
	deriveOutcome,
	emptyParsedSession,
	extractVerdict,
	isLastTurnComplete,
	isTransientConnectionFailure,
	parseSessionFile,
} from "../shared/session.ts";
import { encodeNestedPath, parseNestedPathEnv } from "../shared/nested-path.ts";
import { makeName } from "../shared/name.ts";
import {
	type AcceptanceResult,
	type AgentConfig,
	type ChildRecord,
	DEFAULTS,
	ErrorCodes,
	type Execution,
	type Handle,
	MAX_NESTED_PATH_ENTRIES,
	type ModelOrigin,
	type NestedPathEntry,
	type RetireOptions,
	type RunRecord,
	type SpawnMode,
	SubagentError,
	type Usage,
} from "../shared/types.ts";
import { RpcSupervisor } from "../supervisor/rpc-supervisor.ts";
import type { LegionSupervisor, SettleResult, SpawnInput } from "../supervisor/types.ts";
import { isInProcessSpawn, resolveSpawnMode } from "../supervisor/spawn-mode.ts";
import type { PendingUIRequest, UIProxy } from "../supervisor/ui-proxy.ts";
import { nativeModelFor } from "./kind.ts";
import { applyVerification, type VerifyRunner } from "./acceptance.ts";
import {
	createChildWorktree,
	isInsideChildWorktree,
	removeChildWorktree,
	resolveLaunchWorktree,
} from "./worktree.ts";
import { provisionWorktree } from "./provision.ts";

export interface BudgetRefusedEvent {
	type: "budget_refused";
	requestedMaxDepth: number;
	effectiveMaxDepth: number;
	reason: string;
}

export interface OrchestratorLegionContext {
	db: DatabaseSync;
	dbPath: string;
	nodeId: string;
	parentNodeId?: string | null;
	parentRunId?: string | null;
	runId?: string;
	runStore?: RunStore;
	settings?: LegionSettings;
	eventBus?: Pick<LegionEventBus, "emit">;
}

export interface OrchestratorDeps {
	supervisor?: LegionSupervisor;
	uiProxy?: UIProxy;
	runDir: string;
	cwd: string;
	legion?: OrchestratorLegionContext;
	onChildUpdate?: (child: ChildRecord) => void;
	now?: () => number;
	sleep?: (ms: number) => Promise<void>;
	parentPath?: NestedPathEntry[];
	maxDepth?: number;
	maxSpawns?: number | null;
	verifyRunner?: VerifyRunner;
	/** Post-create bootstrap for child worktrees (legion.worktreeBootstrap). */
	worktreeBootstrap?: string;
	worktreeBootstrapTimeoutMs?: number;
	team?: ActiveTeam;
	childContext?: string;
	/**
	 * When true, RPC child argv includes `--approve` (`subagents.rpc.approve`).
	 * Default false / omitted.
	 */
	rpcApprove?: boolean;
	onBudgetRefused?: (event: BudgetRefusedEvent) => void;
}

export interface CollectResult {
	execution: Execution;
	output: string;
	outputFile?: string;
	usage: Usage | null;
	model: string | null;
	acceptance: AcceptanceResult;
	blocked?: boolean;
}

export const COLLECT_GRACE_EXTENSIONS = 2;
/** Shown when the launch-time collect budget elapses and the child is still in-turn. */
export const COLLECT_DEADLINE_REASON = "collect deadline (cumulative since launch) exceeded; child still alive";
/** Shown when a live child's session ends on an OpenAI/GPT connection blip. */
export const TRANSIENT_CONNECTION_REASON = "transient connection error; RPC child still alive";
const LINEAGE_ENV = "PI_SUBAGENT_PARENT_PATH";
const MAX_DEPTH_ENV = "PI_SUBAGENT_MAX_DEPTH";
const UTILITY_CHILD_ENV = "PI_SUBAGENT_UTILITY_CHILD";
const CHILD_ENV = "PI_SUBAGENT_CHILD";
const POLL_INTERVAL_MS = 500;

function parseDepthCeiling(raw: string | undefined): number | undefined {
	// Genuinely unset / blank → no env ceiling (settings + hard cap still apply).
	if (raw === undefined) return undefined;
	const t = raw.trim();
	if (t === "") return undefined;
	// #173: illegal values fail closed to leaf-only (0), matching contract :361 —
	// never widen to the hard cap via `undefined` → +Infinity.
	if (!/^\d+$/.test(t)) {
		console.error(
			`[pi-legion] ${MAX_DEPTH_ENV}=${JSON.stringify(t)} is not a non-negative integer; treating as 0 (leaf only).`,
		);
		return 0;
	}
	const value = Number(t);
	return Number.isInteger(value) && value >= 0 ? value : 0;
}

/** Root/process ceiling: inherited env, settings, and the saturated path cap. */
export function effectiveMaxDepth(settingsMaxDepth?: number): number {
	return Math.min(
		parseDepthCeiling(process.env[MAX_DEPTH_ENV]) ?? Number.POSITIVE_INFINITY,
		settingsMaxDepth ?? Number.POSITIVE_INFINITY,
		MAX_NESTED_PATH_ENTRIES,
	);
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function ownerToken(): string {
	return randomBytes(8).toString("hex");
}

function artifactSize(file: string): number {
	try {
		return fs.statSync(file).size;
	} catch {
		return 0;
	}
}

function isApprovalRequest(request: PendingUIRequest): boolean {
	return request.request.method === "confirm";
}

function deriveAcceptance(
	parsed: ReturnType<typeof parseSessionFile>,
	execution: Execution,
	pendingCriteria: ChildRecord["pendingCriteria"],
	opts: { completionGuard?: boolean } = {},
): AcceptanceResult {
	let acceptance: AcceptanceResult = { status: "unknown", level: "none" };
	const verdict = extractVerdict(parsed.lastTurnOutput ?? "");
	if (verdict) {
		acceptance = {
			status: verdict.ok ? "accepted" : "rejected",
			level: "attested",
			...(verdict.reason ? { reason: verdict.reason } : {}),
		};
	} else if (execution.status === "success") {
		acceptance = opts.completionGuard
			? { status: "rejected", level: "none", reason: 'completionGuard: missing {"ok": true|false} verdict' }
			: { status: "unknown", level: "none", reason: "no machine-readable verdict" };
	} else if (execution.status === "unknown" || execution.status === "running") {
		acceptance = { status: "unknown", level: "none", reason: execution.reason ?? execution.status };
	} else {
		acceptance = { status: "rejected", level: "none", reason: execution.reason ?? execution.status };
	}
	if (pendingCriteria?.length) {
		acceptance = { ...acceptance, pendingCriteria: pendingCriteria.map((criterion) => ({ ...criterion })) };
	}
	return acceptance;
}

/** Pre-create an empty session file so the first Pi turn cannot be lost. */
export function preCreateSessionFile(file: string): void {
	const dir = path.dirname(file);
	try {
		fs.mkdirSync(dir, { recursive: true });
		if (!fs.existsSync(file)) fs.writeFileSync(file, "", { mode: 0o600 });
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code ?? "UNKNOWN";
		throw new SubagentError(
			`cannot write run artifacts to ${dir} (${code}). ` +
				"Subagent runs need a writable cwd to write session data.",
			ErrorCodes.INVALID_PARAMS,
			{ dir },
		);
	}
}

function canFallbackStart(error: unknown): boolean {
	return error instanceof SubagentError &&
		error.code !== ErrorCodes.NOT_FOUND &&
		error.code !== ErrorCodes.BUDGET_EXCEEDED &&
		error.code !== ErrorCodes.NAME_TAKEN;
}

// pi-lens-ignore: large-class
export class Orchestrator {
	private readonly supervisor: LegionSupervisor;
	private readonly uiProxy?: UIProxy;
	private readonly runDir: string;
	private readonly cwd: string;
	private readonly onChildUpdate: (child: ChildRecord) => void;
	private readonly now: () => number;
	private readonly sleep: (ms: number) => Promise<void>;
	private readonly parentPath: NestedPathEntry[];
	private readonly maxDepthValue: number;
	private readonly maxSpawns: number | null;
	private readonly verifyRunner?: VerifyRunner;
	private readonly worktreeBootstrap?: string;
	private readonly worktreeBootstrapTimeoutMs?: number;
	private readonly team?: ActiveTeam;
	private readonly childContext?: string;
	private readonly rpcApprove: boolean;
	private readonly onBudgetRefused?: (event: BudgetRefusedEvent) => void;
	private readonly legion?: OrchestratorLegionContext;
	private readonly requestedDepthCap?: number;
	private depthWarningEmitted = false;
	private worktreeWarningEmitted = false;
	private spawned = 0;
	private readonly children = new Map<string, ChildRecord>();
	private readonly nameCounter = new Map<string, number>();
	private readonly pendingWaits = new Map<string, Promise<SettleResult>>();
	/** Children retired because the parent session is shutting down. */
	private readonly parentShutdownRetire = new Set<string>();

	constructor(deps: OrchestratorDeps) {
		this.supervisor = deps.supervisor ?? new RpcSupervisor();
		const proxy = (this.supervisor as LegionSupervisor & { uiProxy?: UIProxy }).uiProxy;
		this.uiProxy = deps.uiProxy ?? proxy;
		this.runDir = deps.runDir;
		this.cwd = deps.cwd;
		this.onChildUpdate = deps.onChildUpdate ?? (() => {});
		this.now = deps.now ?? Date.now;
		this.sleep = deps.sleep ?? defaultSleep;
		this.parentPath = deps.parentPath ?? parseNestedPathEnv(process.env[LINEAGE_ENV]);
		const envDepth = parseDepthCeiling(process.env[MAX_DEPTH_ENV]);
		const oversized = [deps.maxDepth, envDepth].filter(
			(value): value is number => value !== undefined && value > MAX_NESTED_PATH_ENTRIES,
		);
		this.requestedDepthCap = oversized.length ? Math.max(...oversized) : undefined;
		this.maxDepthValue = effectiveMaxDepth(deps.maxDepth);
		this.maxSpawns = deps.maxSpawns ?? null;
		this.verifyRunner = deps.verifyRunner;
		this.worktreeBootstrap = deps.worktreeBootstrap?.trim() || undefined;
		this.worktreeBootstrapTimeoutMs = deps.worktreeBootstrapTimeoutMs;
		this.team = deps.team;
		this.childContext = deps.childContext?.trim() || undefined;
		this.rpcApprove = deps.rpcApprove === true;
		this.onBudgetRefused = deps.onBudgetRefused;
		this.legion = deps.legion;
	}

	get maxDepth(): number { return this.maxDepthValue; }
	get depth(): number { return this.parentPath.length; }

	childPath(agentName: string): NestedPathEntry[] {
		return [...this.parentPath, { runId: path.basename(this.runDir), agent: agentName }]
			.slice(-MAX_NESTED_PATH_ENTRIES);
	}

	sessionFileFor(name: string): string {
		return path.join(this.runDir, `${name}.jsonl`);
	}

	allocateName(agentName: string): string {
		const seen = this.nameCounter.get(agentName) ?? 0;
		for (let index = seen; index < seen + 1000; index += 1) {
			const candidate = makeName(agentName, index);
			if (this.children.has(candidate) || this.supervisor.isAlive(candidate)) continue;
			this.nameCounter.set(agentName, index + 1);
			return candidate;
		}
		const fallback = makeName(agentName, seen);
		this.nameCounter.set(agentName, seen + 1);
		return fallback;
	}

	private allocateLegionName(agentName: string): string {
		const legion = this.legion;
		if (!legion) return this.allocateName(agentName);
		const seen = this.nameCounter.get(agentName) ?? 0;
		for (let index = seen; index < seen + 1_000; index += 1) {
			const candidate = makeName(agentName, index);
			if (this.children.has(candidate) || getChildByName(legion.db, legion.nodeId, candidate) || this.supervisor.isAlive(candidate)) continue;
			this.nameCounter.set(agentName, index + 1);
			return candidate;
		}
		throw new SubagentError(`could not allocate a unique child name for ${agentName}`, ErrorCodes.NAME_TAKEN);
	}

	private legionLocalName(name: string): string {
		const prefix = `${this.legion?.nodeId}.`;
		const local = name.startsWith(prefix) ? name.slice(prefix.length) : name;
		return sanitizeNodeSlug(local);
	}

	private childFromNode(name: string, node: LegionNode): ChildRecord {
		if (node.status === "failed" || ["done", "failed", "aborted"].includes(node.phase ?? "")) {
			throw new SubagentError(`legion child is terminal and cannot be resumed: ${node.id}`, ErrorCodes.BUDGET_EXCEEDED);
		}
		if (!node.sessionFile) throw new SubagentError(`legion child has no session to resume: ${node.id}`, ErrorCodes.NOT_FOUND);
		return { name, nodeId: node.id, sessionFile: node.sessionFile, ownerToken: `legion-${node.id}`, state: "retired", spawnedAt: new Date(node.createdAt).toISOString(), agent: node.role, kind: node.kind as AgentConfig["kind"], ...(node.model ? { model: node.model } : {}), ...(node.worktreePath ? { worktreePath: node.worktreePath } : {}) };
	}

	private reserveNode(input: { nodeId: string; name: string; agent: AgentConfig; task: string; sessionFile: string; runId?: string; team?: string; worktreePath?: string; model?: string; utility?: boolean }): LegionNode | null {
		const legion = this.legion;
		if (!legion) return null;
		const parent = getNode(legion.db, legion.nodeId);
		if (!parent) throw new SubagentError(`legion parent node not found: ${legion.nodeId}`, ErrorCodes.BUDGET_EXCEEDED);
		const previous = getNode(legion.db, input.nodeId);
		if (!previous && getChildByName(legion.db, legion.nodeId, input.name)) {
			throw new SubagentError(`legion child already exists: ${input.name}`, ErrorCodes.NAME_TAKEN);
		}
		if (previous && (previous.status === "failed" || ["done", "failed", "aborted"].includes(previous.phase ?? ""))) {
			throw new SubagentError(`legion child is terminal and cannot be resumed: ${input.nodeId}`, ErrorCodes.BUDGET_EXCEEDED);
		}
		const team = input.team ?? input.agent.extraFields?.team ?? this.team?.name;
		// A utility node is a hard leaf and does not consume the recursive depth
		// budget. Keep the real ledger depth, but allow this one generation.
		const depthCeiling = input.utility
			? parent.depth + 1
			: Math.min(legion.settings?.maxDepth ?? this.maxDepthValue, MAX_NESTED_PATH_ENTRIES);
		// Resume must NOT inflate maxChildrenPerNode (#180). Retired nodes free
		// slots (#142); turning one live again re-charges the fanout cap — same
		// gate as a fresh launch. activeReservation below still covers the node's
		// own maxActiveNodes slot when it is already starting/running.
		const maxChildren = legion.settings?.maxChildrenPerNode ?? 8;
		const activeReservation = previous && (previous.status === "starting" || previous.status === "running") ? 1 : 0;
		// In-process children use subagents.inprocess.* only — do not spend RPC legion.* slots (#197).
		const limits: LegionBudgetLimits = isInProcessSpawn(input.agent)
			? {
					maxDepth: MAX_NESTED_PATH_ENTRIES,
					maxChildrenPerNode: Number.MAX_SAFE_INTEGER,
					maxActiveNodes: Number.MAX_SAFE_INTEGER,
			  }
			: {
					maxDepth: depthCeiling,
					maxChildrenPerNode: maxChildren,
					maxActiveNodes: (legion.settings?.maxActiveNodes ?? 30) + activeReservation,
			  };
		const gate = withLaunchBudget(legion.db, { parentId: legion.nodeId, depth: parent.depth + 1, nodeId: input.nodeId }, () => {
			if (previous) {
				updateNode(legion.db, input.nodeId, { status: "starting", sessionFile: input.sessionFile, worktreePath: input.worktreePath ?? previous.worktreePath, model: input.model ?? previous.model, team: team && team !== DEFAULT_TEAM ? team : previous.team }, this.now);
				return previous;
			}
			if (!input.runId) throw new SubagentError(`node run reservation is missing: ${input.nodeId}`, ErrorCodes.START_FAILED);
			insertNode(legion.db, {
				id: input.nodeId,
				parentId: legion.nodeId,
				name: input.name,
				role: input.agent.name,
				kind: input.agent.kind,
				runId: input.runId,
				sessionFile: input.sessionFile,
				worktreePath: input.worktreePath ?? null,
				model: input.model ?? null,
				team: team && team !== DEFAULT_TEAM ? team : null,
				status: "starting",
				...(input.agent.name === "centurion" ? { phase: "planning", phaseSince: this.now() } : {}),
				taskSummary: input.task.slice(0, 2_000),
			}, this.now);
			return null;
		}, { limits, now: this.now });
		if (!gate.allowed) {
			this.legion?.eventBus?.emit({ nodeId: input.nodeId, type: "budget_refused", data: { reason: gate.decision.reason, message: gate.decision.message, depth: gate.decision.depth, activeNodes: gate.decision.activeNodes, children: gate.decision.children, limits: gate.decision.limits }, ts: this.now() });
			throw new SubagentError(`legion launch refused (${gate.decision.reason}): ${gate.decision.message}`, ErrorCodes.BUDGET_EXCEEDED);
		}
		return gate.value;
	}

	private async persistParentReservation(input: { nodeId: string; name: string; agent: AgentConfig; sessionFile: string; team?: string; model?: string; worktreePath?: string }): Promise<boolean> {
		const legion = this.legion;
		const parentRunId = legion?.runId;
		if (!legion?.runStore || !parentRunId) return false;
		const run = legion.runStore.readRun(parentRunId);
		if (!run) throw new SubagentError(`parent run record not found: ${parentRunId}`, ErrorCodes.NOT_FOUND);
		const previous = run.children.find((child) => child.name === input.name);
		if (previous) {
			if (previous.nodeId !== input.nodeId) throw new SubagentError(`child name is already assigned to ${previous.nodeId ?? previous.name}`, ErrorCodes.NAME_TAKEN);
			await legion.runStore.updateChild(parentRunId, input.name, (child) => {
				child.sessionFile = input.sessionFile;
				child.state = "launching";
				child.spawnedAt = new Date(this.now()).toISOString();
				child.agent = input.agent.name;
				child.kind = input.agent.kind;
				child.nodeId = input.nodeId;
				if (input.model) child.model = input.model;
				if (input.worktreePath) child.worktreePath = input.worktreePath;
			});
			return false;
		}
		await legion.runStore.addChild(parentRunId, {
			name: input.name,
			nodeId: input.nodeId,
			sessionFile: input.sessionFile,
			ownerToken: `legion-${input.nodeId}`,
			state: "launching",
			spawnedAt: new Date(this.now()).toISOString(),
			agent: input.agent.name,
			kind: input.agent.kind,
			...(input.model ? { model: input.model } : {}),
			...(input.worktreePath ? { worktreePath: input.worktreePath } : {}),
		});
		return true;
	}

	private recordLegionLaunch(child: ChildRecord, agent: AgentConfig, task: string, teamOverride: string | undefined, resumed: boolean): void {
		if (!this.legion || !child.nodeId) return;
		const team = teamOverride ?? agent.extraFields?.team ?? this.team?.name;
		const current = getNode(this.legion.db, child.nodeId);
		const childRun = current?.runId ?? this.legion.runId ?? path.basename(this.runDir);
		updateNode(this.legion.db, child.nodeId, { status: "running", runId: childRun, sessionFile: child.sessionFile, worktreePath: child.worktreePath ?? null, model: child.model ?? null, team: team && team !== DEFAULT_TEAM ? team : null, taskSummary: task.slice(0, 2_000) }, this.now);
		this.emitStored(child.nodeId, resumed ? "node_resumed" : "node_launched", { parentId: this.legion.nodeId, runId: childRun, sessionFile: child.sessionFile, role: agent.name, kind: agent.kind });
	}

	private recordSettled(child: ChildRecord, execution: Execution): void {
		if (!this.legion || !child.nodeId || execution.status === "running" || child.state === "retired") return;
		const status = execution.status === "success" ? "settled" : execution.status === "failed" || execution.status === "truncated" ? "failed" : "retired";
		const current = getNode(this.legion.db, child.nodeId);
		if (!current || current.status === status) return;
		updateNode(this.legion.db, child.nodeId, { status }, this.now);
		const eventType = status === "settled" ? "node_settled" : status === "failed" ? "node_failed" : "node_retired";
		this.emitStored(child.nodeId, eventType, { execution: execution.status, reason: execution.reason });
		if (execution.usage) {
			upsertUsage(this.legion.db, { nodeId: child.nodeId, tokensIn: execution.usage.input + execution.usage.cacheRead + execution.usage.cacheWrite, tokensOut: execution.usage.output, costUsd: execution.usage.cost }, this.now);
		}
		void this.supervisor.stats(child.name).then((usage) => {
			if (usage) upsertUsage(this.legion!.db, { nodeId: child.nodeId!, tokensIn: usage.tokensIn, tokensOut: usage.tokensOut, costUsd: usage.costUsd }, this.now);
		}).catch(() => {});
	}

	private abortLegionPhase(nodeId: string): void {
		if (!this.legion) return;
		const node = getNode(this.legion.db, nodeId);
		if (!node || !isLegionPhase(node.phase) || isTerminalPhase(node.phase)) return;
		const decision = evaluatePhaseTransition({
			from: node.phase,
			to: "aborted",
			reworkCount: node.reworkCount,
			terminalReason: "parent_retire",
			actorRole: "supervisor",
		}, this.now);
		if (!decision.allowed) return;
		updateNode(this.legion.db, nodeId, { phase: decision.to, phaseSince: decision.phaseSince }, this.now);
		this.emitStored(nodeId, "phase_change", decision.event.data);
	}

	private emitProcess(type: LegionProcessEventType, nodeId: string, data: unknown): void {
		this.legion?.eventBus?.emit({ nodeId, type, data: data as Record<string, unknown> | null, ts: this.now() });
	}

	private emitStored(nodeId: string, type: Parameters<typeof appendEvent>[2], data: unknown): void {
		if (!this.legion) return;
		this.legion.eventBus?.emit(appendEvent(this.legion.db, nodeId, type, data, { now: this.now }));
	}

	private rollbackReservation(nodeId: string, previous: LegionNode | null): void {
		if (!this.legion) return;
		if (!previous) { this.legion.db.prepare("DELETE FROM nodes WHERE id = ?").run(nodeId); return; }
		updateNode(this.legion.db, nodeId, { status: previous.status, runId: previous.runId, sessionFile: previous.sessionFile, worktreePath: previous.worktreePath, model: previous.model, team: previous.team, taskSummary: previous.taskSummary }, this.now);
	}

	budget(): { used: number; limit: number | null; remaining: number | null } {
		return {
			used: this.spawned,
			limit: this.maxSpawns,
			remaining: this.maxSpawns === null ? null : Math.max(0, this.maxSpawns - this.spawned),
		};
	}

	private warnDepthCap(): void {
		if (this.depthWarningEmitted || this.requestedDepthCap === undefined) return;
		this.depthWarningEmitted = true;
		const event: BudgetRefusedEvent = {
			type: "budget_refused",
			requestedMaxDepth: this.requestedDepthCap,
			effectiveMaxDepth: this.maxDepthValue,
			reason: `maxDepth is capped at ${MAX_NESTED_PATH_ENTRIES}`,
		};
		console.warn(
			`[pi-legion] requested maxDepth ${event.requestedMaxDepth} exceeds the hard cap ${MAX_NESTED_PATH_ENTRIES}; using effective maxDepth ${event.effectiveMaxDepth}.`,
		);
		this.onBudgetRefused?.(event);
	}

	/** One-shot: a non-centurion asked for worktree isolation; it was downgraded. */
	private warnWorktreeNotCenturion(roleName: string): void {
		if (this.worktreeWarningEmitted) return;
		this.worktreeWarningEmitted = true;
		console.warn(
			`[pi-legion] worktree isolation is reserved for centurion; ` +
			`role '${roleName}' was downgraded to worktree: false (its children share the checkout). ` +
			`Set worktree: false in the role card to silence this. Dispatch a centurion when you need an isolated subtree.`,
		);
	}

	async launch(input: {
		agent: AgentConfig;
		task: string;
		name?: string;
		team?: string;
		model?: string;
		/** Provider id pinning `--provider` for an ambiguous bare model id (#123). */
		modelProvider?: string;
		thinking?: string | false;
		worktree?: boolean;
		modelOrigin?: ModelOrigin;
		/** Vexillatio launch: bypass nested-depth gates while recording its parent-side Legion node. */
		utilityDispatch?: boolean;
		/** Mask inherited Legion identity from the spawned child process. */
		stripLegionIdentity?: boolean;
	}): Promise<Handle> {
		this.warnDepthCap();
		if (input.agent.kind !== "pi") {
			throw new SubagentError(
				`RPC supervisor only supports pi children (received kind '${input.agent.kind}'); migrate the role to kind: pi or pin pi-legion v0.16.x`,
				ErrorCodes.INVALID_PARAMS,
			);
		}
		const generated = input.name ?? (this.legion ? this.allocateLegionName(input.agent.name) : this.allocateName(input.agent.name));
		const name = this.legion ? this.legionLocalName(generated) : generated;
		const nodeId = this.legion ? nodeIdForChild(this.legion.nodeId, name) : undefined;
		const ledgerPrevious = nodeId ? getNode(this.legion!.db, nodeId) : null;
		const previous = this.children.get(name) ?? (ledgerPrevious ? this.childFromNode(name, ledgerPrevious) : undefined);
		if (previous && !this.children.has(name)) this.children.set(name, previous);
		const models = this.planModelCandidates({
			agent: input.agent,
			...(input.model !== undefined ? { model: input.model } : {}),
			origin: input.modelOrigin ?? (input.model !== undefined ? "explicit" : input.agent.modelSource?.type === "subagents.defaultModel" ? "inherited" : input.agent.model ? "explicit" : "inherited"),
			...(input.thinking !== undefined ? { thinking: input.thinking } : {}),
		});
		let sessionFile = previous?.sessionFile ?? this.sessionFileFor(name);
		const tempDir = this.runDir;
		const parentRole = this.legion ? getNode(this.legion.db, this.legion.nodeId)?.role : undefined;
		// #214: worktree isolation is centurion-only. A centurion card always gets a
		// subtree worktree (nested centurions get nested worktrees, §9); a centurion
		// parent's members never do; everything else falls to the role/launch default
		// and is then gated below.
		const isCenturionCard = input.agent.name === "centurion";
		let worktree = isCenturionCard
			? true
			: this.legion && parentRole === "centurion"
				? false
				: resolveLaunchWorktree({
					roleDefault: input.agent.worktree,
					launch: input.worktree,
					parentInWorktree: isInsideChildWorktree(this.cwd),
				});
		// #214 D4: only a centurion may hold a worktree. Everyone else — including an
		// explicit `subagent({ worktree: true })` — is warned once and downgraded.
		// Downgrading (not throwing) is deliberate: it must never fail a launch.
		if (worktree && !isCenturionCard) {
			this.warnWorktreeNotCenturion(input.agent.name);
			worktree = false;
		}
		// Spawn-mode arbitration (contract D2). `resolveSpawnMode` only reports the
		// configured intent; the launch context decides whether an OMITTED mode can
		// actually run in-process. An omitted mode falls back to rpc when this
		// launch needs worktree isolation (a hard requirement of the in-process
		// backend). An explicit value is never downgraded (invariant I6) — a bad
		// explicit combination still throws below.
		// `kind !== "pi"` is NOT re-tested here: the early guard above (before this
		// arbitration) already refuses it, so such a clause would be dead code.
		const explicitMode = input.agent.spawnMode !== undefined;
		const mode: SpawnMode =
			!explicitMode && worktree === true
				? "rpc"
				: resolveSpawnMode(input.agent);
		const inProcess = mode === "inprocess";
		// Downstream must see the arbitrated result, otherwise RoutingSupervisor
		// re-resolves the omitted field to `inprocess` on its own and throws
		// "cannot combine with worktree: true" — the arbitration would be moot.
		// `worktree` is normalized too: a role card that pins `worktree: true`
		// (e.g. `agents/worker.md`) keeps that raw value even when THIS launch
		// resolved to no isolation (`parentRole === "centurion"`, an explicit
		// `launch({ worktree: false })`, or the nested-worktree suppression), and
		// leaking it makes `{spawnMode:"inprocess", worktree:true}` reach
		// routing-supervisor.ts:79 / inprocess-supervisor.ts:342, which reject it
		// with INVALID_PARAMS. That shape is exactly the "centurion dispatches
		// worker" production path, so it must be normalized to `worktree: false`.
		// The `&& worktree` short-circuit keeps the rpc path returning the
		// original object (invariant I3: zero diff on the RPC backend).
		// reserveNode() and SpawnInput.agent below both receive this clone.
		const agent: AgentConfig = mode === input.agent.spawnMode && worktree
			? input.agent
			: { ...input.agent, spawnMode: mode, ...(worktree ? {} : { worktree: false }) };
		// A utility dispatch is a hard leaf, not a nested command-chain launch.
		// In-process children use subagents.inprocess.* budgets (never RPC keys).
		if (!input.utilityDispatch && !inProcess) this.assertWithinBudgets(Boolean(previous));
		if (this.supervisor.isAlive(name)) throw new SubagentError(`child is already alive: ${name}`, ErrorCodes.NAME_TAKEN);
		// Only an EXPLICIT inprocess can reach this: the arbitration above already
		// routed every omitted-mode launch that needs a worktree to rpc, so I1
		// (explicit inprocess + worktree stays a loud throw) holds. This replaces
		// the old gate, which inspected the raw `worktree` fields and therefore
		// rejected callers that explicitly overrode a worktree role with
		// `launch({ worktree: false })` — that override now wins as it should.
		if (inProcess && worktree) {
			throw new SubagentError(
				`spawnMode "inprocess" cannot use worktree isolation for '${name}'; worktree is reserved for centurion — set worktree: false to run it in-process`,
				ErrorCodes.INVALID_PARAMS,
			);
		}
		let worktreePath = previous?.worktreePath;
		let worktreeBranch = previous?.worktreeBranch;
		let createdWorktree = false;
		let spawned = false;
		let reservedNode: LegionNode | null = null;
		let reserved = false;
		let createdRunId: string | undefined;
		let parentReservationCreated = false;
		try {
			if (worktree && !worktreePath) {
				const tree = createChildWorktree({ repoCwd: this.cwd, runDir: this.runDir, name });
				worktreePath = tree.path;
				worktreeBranch = tree.branch;
				createdWorktree = true;
				// Provision before any spawn: the child's first command and any
				// plugin-run verify command would otherwise fail on a bare checkout.
				// Failure throws through the existing rollback below (tree removed).
				provisionWorktree({
					worktreePath,
					mode: this.worktreeBootstrap,
					timeoutMs: this.worktreeBootstrapTimeoutMs,
				});
			}
			const effectiveModel = models.candidates;
			if (this.legion && nodeId && !previous && this.legion.runStore) {
				const roleDepth = input.agent.maxSubagentDepth === undefined
					? Number.POSITIVE_INFINITY
					: Number.isInteger(input.agent.maxSubagentDepth) && input.agent.maxSubagentDepth >= 1
						? input.agent.maxSubagentDepth
						: 1;
				const run = this.legion.runStore.createRun({
					task: input.task,
					cwd: worktreePath ?? this.cwd,
					path: this.childPath(name),
					maxDepth: input.utilityDispatch
						? this.depth + 1
						: Math.min(this.maxDepthValue, this.depth + roleDepth, MAX_NESTED_PATH_ENTRIES),
					nodeId,
					// #209: the run record carries the ARBITRATED backend, not a literal.
					herdr: { supervisor: mode, node_id: nodeId },
				});
				createdRunId = run.runId;
				sessionFile = this.legion.runStore.sessionFileFor(run.runId, name);
			}
			preCreateSessionFile(sessionFile);
			if (this.legion && nodeId) {
				const reservationRunId = createdRunId ?? (previous ? ledgerPrevious?.runId : undefined) ?? this.legion.runId;
				reservedNode = this.reserveNode({ nodeId, name, agent, task: input.task, sessionFile, runId: reservationRunId, team: input.team, worktreePath, model: models.candidates[0], utility: Boolean(input.utilityDispatch && input.agent.utility) });
				reserved = true;
				parentReservationCreated = await this.persistParentReservation({ nodeId, name, agent: input.agent, sessionFile, ...(models.candidates[0] ? { model: models.candidates[0] } : {}), ...(worktreePath ? { worktreePath } : {}) });
			}
			const childEnv = this.lineageEnv(name, input.agent, input.team, nodeId);
			if (input.stripLegionIdentity) {
				for (const key of LEGION_IDENTITY_ENV_KEYS) delete childEnv[key];
			}
			let result: Awaited<ReturnType<LegionSupervisor["spawnChild"]>> | undefined;
			let startedModel: string | undefined;
			let lastError: unknown;
			for (let index = 0; index < effectiveModel.length; index += 1) {
				const model = effectiveModel[index];
				const spawnInput: SpawnInput = {
					name,
					task: input.task,
					agent,
					sessionFile,
					tempDir,
					cwd: worktreePath ?? this.cwd,
					env: childEnv,
					...(model ? { model } : {}),
					...(input.modelProvider ? { modelProvider: input.modelProvider } : {}),
					...(input.stripLegionIdentity ? { stripLegionIdentity: true } : {}),
					...(input.thinking !== undefined ? { thinking: input.thinking } : input.agent.thinking !== undefined ? { thinking: input.agent.thinking } : {}),
					...(input.agent.allowNestedSubagents !== undefined && !input.agent.utility ? { allowNestedSubagents: input.agent.allowNestedSubagents } : {}),
					...(worktreeBranch ? { worktreeBranch } : {}),
					...(this.childContext ? { childContext: this.childContext } : {}),
					...(this.rpcApprove ? { approve: true } : {}),
					// D5: in-process children cannot inherit lineage through env (they share
					// the parent's process.env and would read the PARENT's identity, or none
					// at the root). Hand the arbitrator a real identity scope instead. Only
					// the in-process backend consumes it; RPC lineage stays on env (I3).
					//
					// `stripLegionIdentity` (vexillatio) must mask lineage on BOTH
					// channels: the env keys are deleted above, so the context must not
					// hand back the same identity through ALS. Keep the scope (so the
					// child still knows it is not the root) but omit node/db lineage.
					...(inProcess && this.legion
						? {
								childLaunchContext: {
									...(!input.stripLegionIdentity && nodeId ? { nodeId } : {}),
									...(input.stripLegionIdentity
										? {}
										: { parentNodeId: this.legion.nodeId, dbPath: this.legion.dbPath }),
									// The nested path is lineage too: LEGION_IDENTITY_ENV_KEYS
									// strips PI_SUBAGENT_PARENT_PATH on the rpc side, so the
									// in-process channel must not hand it back.
									...(input.stripLegionIdentity ? {} : { parentPath: this.childPath(name) }),
									...(agent.acceptance?.role ? { acceptanceRole: agent.acceptance.role } : {}),
									allowNested: input.agent.allowNestedSubagents === true && !input.agent.utility,
									utility: Boolean(input.utilityDispatch && input.agent.utility),
									spawnMode: "inprocess" as const,
								},
							}
						: {}),
				};
				try {
					result = await this.supervisor.spawnChild(spawnInput);
					startedModel = model;
					spawned = true;
					break;
				} catch (error) {
					lastError = error;
					if (!canFallbackStart(error) || index === effectiveModel.length - 1) throw error;
				}
			}
			if (!result) throw lastError ?? new SubagentError("RPC child start failed", ErrorCodes.START_FAILED);
			if (previous) {
				previous.state = "working";
				previous.spawnedAt = new Date(this.now()).toISOString();
				previous.retiredAt = undefined;
				previous.execution = undefined;
				previous.acceptance = undefined;
				previous.outputFile = undefined;
				previous.model = startedModel;
				// A resume re-arbitrates the backend; keep the record truthful (#209).
				previous.spawnMode = mode;
				this.children.set(name, previous);
			}
			const child = previous ?? this.recordChild({
				name: result.name,
				...(nodeId ? { nodeId } : {}),
				agent: input.agent,
				sessionFile: result.sessionFile,
				spawnMode: mode,
				...(startedModel ? { model: startedModel } : {}),
				...(input.thinking !== undefined ? { thinking: input.thinking } : input.agent.thinking !== undefined ? { thinking: input.agent.thinking } : {}),
				...(worktreePath ? { worktreePath } : {}),
				...(worktreeBranch ? { worktreeBranch } : {}),
			});
			if (previous) this.onChildUpdate(child);
			if (this.legion && nodeId) this.recordLegionLaunch(child, input.agent, input.task, input.team, Boolean(reservedNode));
			this.emitProcess("node_launched", nodeId ?? name, { name, agent: input.agent.name, pid: result.pid });
			return {
				name: result.name,
				sessionFile: result.sessionFile,
				runId: path.basename(this.runDir),
				agent: input.agent.name,
				kind: input.agent.kind,
				child,
				// #209: callers render this instead of assuming the RPC backend.
				spawnMode: mode,
			};
		} catch (error) {
			if (spawned) await this.supervisor.retire(name).catch(() => {});
			if (reserved && nodeId) this.rollbackReservation(nodeId, reservedNode);
			if (parentReservationCreated && this.legion?.runStore) {
				try { await this.legion.runStore.removeChild(this.legion.runId!, name, nodeId); } catch { /* rollback is best effort */ }
			}
			if (createdRunId && this.legion?.runStore) {
				try { fs.rmSync(this.legion.runStore.runDir(createdRunId), { recursive: true, force: true }); } catch { /* rollback is best effort */ }
			}
			if (createdWorktree && worktreePath) removeChildWorktree({ repoCwd: this.cwd, dest: worktreePath });
			throw error;
		}
	}

	private planModelCandidates(input: {
		agent: AgentConfig;
		model?: string;
		origin: ModelOrigin;
		thinking?: string | false;
	}): { candidates: Array<string | undefined>; dropped: string[] } {
		const requested = modelCandidates(input.model ?? input.agent.model, input.agent.fallbackModels);
		const thinking = input.thinking ?? input.agent.thinking;
		const candidates: Array<string | undefined> = [];
		const dropped: string[] = [];
		for (const model of requested) {
			if (!model || nativeModelFor("pi", model, thinking) !== undefined) candidates.push(model);
			else dropped.push(model);
		}
		if (dropped.length && input.origin === "explicit" && candidates.length === 0) {
			throw new SubagentError(`model '${dropped.join(", ")}' cannot be used with kind 'pi'.`, ErrorCodes.INVALID_PARAMS);
		}
		return { candidates: candidates.length ? candidates : [undefined], dropped };
	}

	private assertWithinBudgets(existingChild = false): void {
		if (this.depth + 1 > this.maxDepthValue) {
			throw new SubagentError(
				`subagent nesting limit reached (depth ${this.depth}, max ${this.maxDepthValue}); raise maxSubagentDepth to allow deeper nesting`,
				ErrorCodes.BUDGET_EXCEEDED,
			);
		}
		if (!existingChild && this.maxSpawns !== null && this.spawned >= this.maxSpawns) {
			throw new SubagentError(
				`subagent spawn budget exhausted (${this.spawned}/${this.maxSpawns}); raise subagents.maxSubagentSpawnsPerSession to allow more`,
				ErrorCodes.BUDGET_EXCEEDED,
			);
		}
	}

	private lineageEnv(name: string, agent: AgentConfig, teamOverride?: string, nodeId?: string): Record<string, string> {
		const roleDepth = agent.maxSubagentDepth === undefined
			? Number.POSITIVE_INFINITY
			: Number.isInteger(agent.maxSubagentDepth) && agent.maxSubagentDepth >= 1
				? agent.maxSubagentDepth
				: 1;
		const env: Record<string, string> = {
			[LINEAGE_ENV]: encodeNestedPath(this.childPath(name)),
			[MAX_DEPTH_ENV]: String(Math.min(this.maxDepthValue, this.depth + roleDepth, MAX_NESTED_PATH_ENTRIES)),
			[CHILD_ENV]: "1",
			[CHILD_ROLE_ENV]: agent.name,
		};
		const team = teamOverride ?? agent.extraFields?.team ?? this.team?.name;
		if (team !== undefined && (team !== DEFAULT_TEAM || teamOverride === DEFAULT_TEAM || this.team?.source === "env")) env[TEAM_ENV] = team;
		if (this.legion && nodeId) Object.assign(env, legionIdentityEnv(this.legion.dbPath, nodeId));
		if (agent.acceptance?.role) env[CHILD_ACCEPTANCE_ROLE_ENV] = agent.acceptance.role;
		if (agent.toolBudget?.maxToolCalls !== undefined) env[MAX_TOOL_CALLS_ENV] = String(agent.toolBudget.maxToolCalls);
		if (agent.turnBudget?.maxTurns !== undefined) env[MAX_TURNS_ENV] = String(agent.turnBudget.maxTurns);
		if (agent.toolTimeoutMs !== undefined) env[TOOL_TIMEOUT_MS_ENV] = String(agent.toolTimeoutMs);
		if (agent.utility) env[UTILITY_CHILD_ENV] = "1";
		// Utility identity takes precedence even when a role was misconfigured
		// with allowNestedSubagents: utility children are always hard leaves.
		if (agent.allowNestedSubagents && !agent.utility) env[ALLOW_NESTED_ENV] = "1";
		return env;
	}

	private recordChild(input: {
		name: string;
		nodeId?: string;
		agent: AgentConfig;
		sessionFile: string;
		/** Arbitrated spawn backend (#209); persisted so later operators see the truth. */
		spawnMode: SpawnMode;
		model?: string;
		thinking?: string | false;
		worktreePath?: string;
		worktreeBranch?: string;
	}): ChildRecord {
		const child: ChildRecord = {
			name: input.name,
			...(input.nodeId ? { nodeId: input.nodeId } : {}),
			sessionFile: input.sessionFile,
			ownerToken: ownerToken(),
			state: "working",
			spawnedAt: new Date(this.now()).toISOString(),
			agent: input.agent.name,
			kind: input.agent.kind,
			...(input.agent.acceptance?.criteria?.length ? { pendingCriteria: input.agent.acceptance.criteria.map((criterion) => ({ ...criterion })) } : {}),
			...(input.agent.onBlocked ? { onBlocked: input.agent.onBlocked } : {}),
			...(input.agent.completionGuard ? { completionGuard: true } : {}),
			...(input.model ? { model: input.model } : {}),
			...(input.thinking !== undefined ? { thinking: input.thinking } : {}),
			spawnMode: input.spawnMode,
			...(input.worktreePath ? { worktreePath: input.worktreePath } : {}),
			...(input.worktreeBranch ? { worktreeBranch: input.worktreeBranch } : {}),
		};
		this.children.set(input.name, child);
		this.spawned += 1;
		this.onChildUpdate(child);
		return child;
	}

	async steer(name: string, text: string): Promise<void> {
		const child = this.requireChild(name);
		await this.supervisor.steer(name, text);
		this.emitProcess("node_steered", child.nodeId ?? name, { name, text });
		this.clearBlocked(child);
	}

	async followUp(name: string, text: string): Promise<void> {
		const child = this.requireChild(name);
		await this.supervisor.followUp(name, text);
		this.clearBlocked(child);
	}

	async abort(name: string): Promise<void> {
		const child = this.requireChild(name);
		await this.supervisor.abort(name);
		this.emitProcess("node_aborted", child.nodeId ?? name, { name });
	}

	private requireChild(name: string): ChildRecord {
		const child = this.children.get(name);
		if (!child) throw new SubagentError(`unknown child: ${name}`, ErrorCodes.NOT_FOUND);
		return child;
	}

	private pendingDialogs(name: string): PendingUIRequest[] {
		return (this.uiProxy?.pending() ?? []).filter((request) => request.childName === name && isApprovalRequest(request));
	}

	async approveBlocked(name: string): Promise<void> {
		for (const request of this.pendingDialogs(name)) {
			if (request.request.method === "confirm") this.uiProxy?.respond(request.id, { confirmed: true });
		}
		const child = this.children.get(name);
		if (child) this.clearBlocked(child);
	}

	async rejectBlocked(name: string): Promise<void> {
		for (const request of this.pendingDialogs(name)) {
			if (request.request.method === "confirm") this.uiProxy?.respond(request.id, { confirmed: false });
		}
		const child = this.children.get(name);
		if (child) this.clearBlocked(child);
	}

	private clearBlocked(child: ChildRecord): void {
		if (child.state !== "blocked") return;
		child.state = "working";
		child.execution = undefined;
		this.onChildUpdate(child);
	}

	async collect(name: string, opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<CollectResult> {
		const child = this.requireChild(name);
		const abortedSnapshot = (): CollectResult => this.interruptedCollect(child, parseSessionFile(child.sessionFile));
		if (opts.signal?.aborted) return abortedSnapshot();
		if (this.pendingDialogs(name).length) return this.blockedResult(child);
		const timeoutMs = opts.timeoutMs ?? DEFAULTS.turnTimeoutMs;
		let deadline = this.now() + timeoutMs;
		const initial = parseSessionFile(child.sessionFile);
		// A connection blip writes stopReason "error" before the client retries.
		// That looks like a finished turn, but the RPC child is still in it.
		// Skipping the supervisor wait here is what retired a live worker.
		let wait: "settled" | "timeout" | "blocked" | "gone" | "aborted" = isLastTurnComplete(initial) && !this.liveConnectionBlip(child, initial)
			? "settled"
			: await this.awaitSupervisor(child, deadline, opts.signal);
		if (wait === "aborted" || opts.signal?.aborted) return abortedSnapshot();
		for (let attempt = 0; wait === "timeout" && attempt < COLLECT_GRACE_EXTENSIONS; attempt += 1) {
			if (opts.signal?.aborted) return abortedSnapshot();
			if (!(await this.collectArtifactGrowing(child, opts.signal))) break;
			if (opts.signal?.aborted) return abortedSnapshot();
			deadline += timeoutMs;
			wait = await this.awaitSupervisor(child, deadline, opts.signal);
			if (wait === "aborted" || opts.signal?.aborted) return abortedSnapshot();
		}
		if (wait === "blocked") return this.blockedResult(child);
		let parsed = parseSessionFile(child.sessionFile);
		if (wait === "settled" && countAssistantMessages(parsed) > 0) {
			await this.waitForQuiet(child.sessionFile, deadline, opts.signal);
			if (opts.signal?.aborted) return abortedSnapshot();
		}
		if (opts.signal?.aborted) return abortedSnapshot();
		parsed = parseSessionFile(child.sessionFile);
		let execution = deriveOutcome(parsed);
		if (wait === "timeout" && this.supervisor.isAlive(name) && !isLastTurnComplete(parsed)) {
			// `timeoutMs` is the budget from launch, not the length of this status check.
			execution = { ...execution, status: "running", reason: COLLECT_DEADLINE_REASON };
		} else if (wait === "gone" && parsed.turns.length === 0) {
			execution = { status: "aborted", reason: "RPC child exited before writing session JSONL", model: child.model ?? null };
		} else if (this.supervisor.isAlive(name) && isTransientConnectionFailure(execution)) {
			// Same non-terminal signal as the deadline path: watch() re-arms on
			// `running` and does not retire. An already-settled blip has to keep
			// waiting here, or the next collect would reproduce it instantly.
			if (wait !== "timeout") {
				const held = await this.waitOutTransientConnection(child, deadline, opts.signal);
				if (held === "aborted" || opts.signal?.aborted) return abortedSnapshot();
				if (held === "blocked") return this.blockedResult(child);
				parsed = parseSessionFile(child.sessionFile);
				execution = deriveOutcome(parsed);
			}
			if (this.supervisor.isAlive(name) && (isTransientConnectionFailure(execution) || !isLastTurnComplete(parsed))) {
				execution = { ...execution, status: "running", reason: TRANSIENT_CONNECTION_REASON };
			} else if (!this.supervisor.isAlive(name) && parsed.turns.length === 0) {
				execution = { status: "aborted", reason: "RPC child exited before writing session JSONL", model: child.model ?? null };
			}
		}
		// A parent shutdown can resolve the in-flight wait by killing the child.
		// That is not the child settling a turn with no assistant reply.
		if (this.parentShutdownRetire.has(name) && wait !== "settled") {
			execution = attributeParentSessionShutdown(execution, parsed);
		}
		return this.finishCollect(child, parsed, execution, deadline);
	}

	/** True when the session's latest outcome is a connection blip and the process is up. */
	private liveConnectionBlip(child: ChildRecord, parsed: ReturnType<typeof parseSessionFile>): boolean {
		return this.supervisor.isAlive(child.name) && isTransientConnectionFailure(deriveOutcome(parsed));
	}

	/**
	 * Hold a live child whose session currently ends on a connection blip.
	 *
	 * Returns once the session moves past that blip, the process exits, a UI
	 * approval arrives, the parent aborts, or the cumulative deadline passes.
	 */
	private async waitOutTransientConnection(
		child: ChildRecord,
		deadline: number,
		signal?: AbortSignal,
	): Promise<"aborted" | "blocked" | "done"> {
		const maxPolls = Math.max(1, Math.ceil(Math.max(0, deadline - this.now()) / POLL_INTERVAL_MS));
		for (let poll = 0; poll < maxPolls; poll += 1) {
			if (signal?.aborted) return "aborted";
			if (this.pendingDialogs(child.name).length) return "blocked";
			if (!this.supervisor.isAlive(child.name)) return "done";
			if (!isTransientConnectionFailure(deriveOutcome(parseSessionFile(child.sessionFile)))) return "done";
			if (this.now() >= deadline) return "done";
			if (await this.sleepOrAbort(POLL_INTERVAL_MS, signal)) return "aborted";
		}
		return "done";
	}

	private interruptedCollect(child: ChildRecord, parsed: ReturnType<typeof parseSessionFile>): CollectResult {
		return {
			execution: { status: "running", reason: "aborted by parent" },
			output: parsed.output,
			usage: parsed.usage,
			model: parsed.model ?? child.model ?? null,
			acceptance: { status: "unknown", level: "none", reason: "aborted by parent" },
		};
	}

	private async awaitSupervisor(
		child: ChildRecord,
		deadline: number,
		signal?: AbortSignal,
	): Promise<"settled" | "timeout" | "blocked" | "gone" | "aborted"> {
		if (signal?.aborted) return "aborted";
		if (this.pendingDialogs(child.name).length) return "blocked";
		let pending = signal ? undefined : this.pendingWaits.get(child.name);
		if (!pending) {
			const wait = this.supervisor.waitSettled(
				child.name,
				Math.max(1, deadline - this.now()),
				...(signal ? [signal] : []),
			);
			pending = wait;
			if (!signal) {
				this.pendingWaits.set(child.name, pending);
				const current = pending;
				void current.then(
					() => { if (this.pendingWaits.get(child.name) === current) this.pendingWaits.delete(child.name); },
					() => { if (this.pendingWaits.get(child.name) === current) this.pendingWaits.delete(child.name); },
				);
			}
		}
		let unsubscribe: (() => void) | undefined;
		let removeAbortListener: (() => void) | undefined;
		try {
			const waitForSettle = pending.then((settled) =>
				settled.reason === "aborted by parent"
					? "aborted" as const
					: this.settleDisposition(settled, child.name),
			);
			if (!this.uiProxy && !signal) return await waitForSettle;
			const waitForChildEvent = waitForSettle.then((result) => {
				if (result === "settled" && child.state === "retired") return "gone" as const;
				return result;
			});
			const blocked = new Promise<"blocked">((resolve) => {
				if (!this.uiProxy) return;
				unsubscribe = this.uiProxy.onRequest((request) => {
					if (request.childName !== child.name || !isApprovalRequest(request) || child.state === "retired") return;
					child.state = "blocked";
					this.onChildUpdate(child);
					resolve("blocked");
				});
			});
			if (this.pendingDialogs(child.name).length) return "blocked";
			const races: Array<Promise<"settled" | "timeout" | "blocked" | "gone" | "aborted">> = [waitForChildEvent];
			if (this.uiProxy) races.push(blocked);
			if (signal) {
				races.push(new Promise((resolve) => {
					const onAbort = () => resolve("aborted");
					removeAbortListener = () => signal.removeEventListener("abort", onAbort);
					if (signal.aborted) onAbort();
					else signal.addEventListener("abort", onAbort, { once: true });
				}));
			}
			return await Promise.race(races);
		} finally {
			unsubscribe?.();
			removeAbortListener?.();
		}
	}

	private settleDisposition(result: SettleResult, name: string): "settled" | "timeout" | "gone" {
		if (result.settled) return "settled";
		if (result.reason === "timeout" || (!result.abnormal && this.supervisor.isAlive(name))) return "timeout";
		// A connection blip reported as an abnormal settle must not look like
		// the process exited while that process is still alive.
		if (this.supervisor.isAlive(name) && isTransientConnectionFailure(result.reason)) return "timeout";
		return "gone";
	}

	private blockedResult(child: ChildRecord): CollectResult {
		const parsed = parseSessionFile(child.sessionFile);
		const execution: Execution = { status: "running", reason: "blocked: waiting for a child UI approval" };
		const acceptance = deriveAcceptance(parsed, execution, child.pendingCriteria, {
			...(child.completionGuard ? { completionGuard: true } : {}),
		});
		if (child.state !== "retired") {
			child.state = "blocked";
			child.execution = execution;
			child.acceptance = acceptance;
			this.onChildUpdate(child);
		}
		return { execution, output: parsed.output, usage: parsed.usage, model: parsed.model ?? child.model ?? null, acceptance, blocked: true };
	}

	private async finishCollect(child: ChildRecord, parsed: ReturnType<typeof parseSessionFile>, execution: Execution, deadline: number): Promise<CollectResult> {
		const acceptance = await applyVerification(
			deriveAcceptance(parsed, execution, child.pendingCriteria, { ...(child.completionGuard ? { completionGuard: true } : {}) }),
			{ cwd: child.worktreePath ?? this.cwd, criteria: child.pendingCriteria, run: this.verifyRunner, timeoutMs: Math.max(5_000, deadline - this.now()) },
		);
		const isRetired = () => child.state === "retired";
		// A running child can finish its in-flight collect while an explicit stop
		// is retiring it. Record the result, but never demote a retired lifecycle
		// state back to awaiting; only a later launch/resume may revive that child.
		if (execution.status !== "running" && !isRetired()) child.state = "awaiting";
		child.execution = execution;
		child.acceptance = acceptance;
		if (execution.status !== "running") this.recordSettled(child, execution);
		if (!isRetired()) this.onChildUpdate(child);
		const output = execution.status !== "running" && parsed.lastTurnOutput === null ? "" : parsed.output;
		if (isRetired()) {
			return { execution, output, usage: parsed.usage, model: parsed.model ?? child.model ?? null, acceptance };
		}
		let outputFile: string | undefined;
		if (execution.status === "running") child.outputFile = undefined;
		else {
			outputFile = this.writeOutputFile(child, output);
			child.outputFile = outputFile;
		}
		if (!isRetired()) this.onChildUpdate(child);
		return { execution, output, ...(outputFile ? { outputFile } : {}), usage: parsed.usage, model: parsed.model ?? child.model ?? null, acceptance };
	}

	private outputFileFor(name: string): string { return path.join(this.runDir, `${name}.output.md`); }

	private writeOutputFile(child: ChildRecord, output: string): string | undefined {
		const file = this.outputFileFor(child.name);
		const trimmed = output.trim();
		if (!trimmed) {
			try { fs.rmSync(file, { force: true }); } catch { /* stale output is best-effort cleanup */ }
			return undefined;
		}
		try {
			fs.writeFileSync(file, `${trimmed}\n`, { mode: 0o600 });
			return file;
		} catch { return undefined; }
	}

	private async collectArtifactGrowing(child: ChildRecord, signal?: AbortSignal): Promise<boolean> {
		const before = artifactSize(child.sessionFile);
		if (before <= 0 || signal?.aborted) return false;
		if (await this.sleepOrAbort(POLL_INTERVAL_MS, signal)) return false;
		return artifactSize(child.sessionFile) > before;
	}

	private async sleepOrAbort(ms: number, signal?: AbortSignal): Promise<boolean> {
		if (!signal) {
			await this.sleep(ms);
			return false;
		}
		if (signal.aborted) return true;
		return new Promise<boolean>((resolve) => {
			let settled = false;
			let timer: ReturnType<typeof setTimeout> | undefined;
			const cleanup = () => {
				signal.removeEventListener("abort", onAbort);
				if (timer) clearTimeout(timer);
			};
			const finish = (aborted: boolean) => {
				if (settled) return;
				settled = true;
				cleanup();
				resolve(aborted);
			};
			const onAbort = () => finish(true);
			signal.addEventListener("abort", onAbort, { once: true });
			if (signal.aborted) {
				onAbort();
				return;
			}
			timer = setTimeout(() => finish(false), ms);
		});
	}

	private async waitForQuiet(sessionFile: string, deadline: number, signal?: AbortSignal): Promise<void> {
		let previous = -1;
		let quietSince = this.now();
		const maxPolls = Math.max(1, Math.ceil(DEFAULTS.turnTimeoutMs / POLL_INTERVAL_MS));
		for (let poll = 0; poll < maxPolls; poll += 1) {
			if (signal?.aborted) return;
			const size = artifactSize(sessionFile);
			if (size !== previous) { previous = size; quietSince = this.now(); }
			else if (this.now() - quietSince >= DEFAULTS.settleQuietMs) return;
			if (this.now() >= deadline) return;
			if (await this.sleepOrAbort(POLL_INTERVAL_MS, signal)) return;
		}
	}

	cachedCollect(name: string): CollectResult | undefined {
		const child = this.children.get(name);
		if (!child?.execution || !canUseCachedCollect(child.state)) return undefined;
		const parsed = fs.existsSync(child.sessionFile) ? parseSessionFile(child.sessionFile) : emptyParsedSession();
		const cached: CollectResult = {
			execution: child.execution,
			output: child.execution.status !== "running" && parsed.lastTurnOutput === null ? "" : parsed.output,
			usage: parsed.usage ?? child.execution.usage ?? null,
			model: parsed.model ?? child.execution.model ?? child.model ?? null,
			acceptance: child.acceptance ?? { status: "unknown", level: "none" },
			...(child.state === "blocked" ? { blocked: true } : {}),
		};
		if (child.outputFile) cached.outputFile = child.outputFile;
		return cached;
	}

	async retire(name: string, opts?: RetireOptions): Promise<ChildRecord> {
		const child = this.requireChild(name);
		if (opts?.cause === "session-shutdown") this.parentShutdownRetire.add(name);
		if (child.state === "retired") return child;
		const sessionExists = fs.existsSync(child.sessionFile);
		const parsed = sessionExists ? parseSessionFile(child.sessionFile) : emptyParsedSession();
		if (!child.execution && sessionExists) child.execution = deriveOutcome(parsed);
		// Stamp the cause before killing so an in-flight collect cannot
		// overwrite it with "no assistant message" after the process dies.
		if (opts?.cause === "session-shutdown" && this.supervisor.isAlive(name)) {
			child.execution = attributeParentSessionShutdown(child.execution ?? deriveOutcome(parsed), parsed);
		}
		if (this.supervisor.isAlive(name)) {
			await this.supervisor.retire(
				name,
				opts?.graceful === false ? { graceful: false } : {},
			);
		}
		if (child.nodeId && this.legion) {
			if (child.execution && child.execution.status !== "unknown" && child.execution.status !== "running") {
				this.recordSettled(child, child.execution);
				if (child.execution.status !== "aborted") this.emitStored(child.nodeId, "node_retired", { parentId: this.legion.nodeId, execution: child.execution.status });
			} else {
				updateNode(this.legion.db, child.nodeId, { status: "retired" }, this.now);
				this.emitStored(child.nodeId, "node_retired", { parentId: this.legion.nodeId });
			}
			this.abortLegionPhase(child.nodeId);
		}
		child.state = "retired";
		child.retiredAt = new Date(this.now()).toISOString();
		this.emitProcess("node_retired", child.nodeId ?? name, { name });
		this.onChildUpdate(child);
		return child;
	}

	async retireAll(): Promise<ChildRecord[]> {
		const results: ChildRecord[] = [];
		for (const name of [...this.children.keys()]) {
			try { results.push(await this.retire(name)); } catch { /* continue with other child processes */ }
		}
		return results;
	}

	childrenSnapshot(): ChildRecord[] { return [...this.children.values()]; }

	/** Whether the RPC process for this child is still running. */
	isChildAlive(name: string): boolean {
		return this.supervisor.isAlive(name);
	}

	restore(record: RunRecord): void {
		for (const child of record.children) {
			const node = this.legion && !child.nodeId ? getChildByName(this.legion.db, this.legion.nodeId, child.name) : null;
			this.children.set(child.name, { ...child, ...(node ? { nodeId: node.id } : {}) });
		}
		this.spawned = Math.max(this.spawned, record.budget.spawned);
	}
}
