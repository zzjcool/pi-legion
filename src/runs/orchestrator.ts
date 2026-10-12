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
import { LEGION_DB_ENV, LEGION_NODE_ID_ENV, legionIdentityEnv } from "./args.ts";
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
	deriveOutcome,
	emptyParsedSession,
	extractVerdict,
	isLastTurnComplete,
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
	type RunRecord,
	SubagentError,
	type Usage,
} from "../shared/types.ts";
import { RpcSupervisor } from "../supervisor/rpc-supervisor.ts";
import type { LegionSupervisor, SettleResult, SpawnInput } from "../supervisor/types.ts";
import type { PendingUIRequest, UIProxy } from "../supervisor/ui-proxy.ts";
import { nativeModelFor } from "./kind.ts";
import { applyVerification, type VerifyRunner } from "./acceptance.ts";
import {
	createChildWorktree,
	removeChildWorktree,
	resolveLaunchWorktree,
} from "./worktree.ts";

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
	team?: ActiveTeam;
	childContext?: string;
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
const LINEAGE_ENV = "PI_SUBAGENT_PARENT_PATH";
const MAX_DEPTH_ENV = "PI_SUBAGENT_MAX_DEPTH";
const UTILITY_CHILD_ENV = "PI_SUBAGENT_UTILITY_CHILD";
const CHILD_ENV = "PI_SUBAGENT_CHILD";
const POLL_INTERVAL_MS = 500;

function parseDepthCeiling(raw: string | undefined): number | undefined {
	if (raw === undefined || !/^\d+$/.test(raw.trim())) return undefined;
	const value = Number(raw.trim());
	return Number.isInteger(value) && value >= 0 ? value : undefined;
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
	private readonly team?: ActiveTeam;
	private readonly childContext?: string;
	private readonly onBudgetRefused?: (event: BudgetRefusedEvent) => void;
	private readonly legion?: OrchestratorLegionContext;
	private readonly requestedDepthCap?: number;
	private depthWarningEmitted = false;
	private spawned = 0;
	private readonly children = new Map<string, ChildRecord>();
	private readonly nameCounter = new Map<string, number>();
	private readonly pendingWaits = new Map<string, Promise<SettleResult>>();

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
		this.team = deps.team;
		this.childContext = deps.childContext?.trim() || undefined;
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
		const childCount = Number(legion.db.prepare("SELECT COUNT(*) AS count FROM nodes WHERE parent_id = ?").get(legion.nodeId)?.count ?? 0);
		const maxChildren = previous ? Math.max(legion.settings?.maxChildrenPerNode ?? 8, childCount + 1) : legion.settings?.maxChildrenPerNode;
		const activeReservation = previous && (previous.status === "starting" || previous.status === "running") ? 1 : 0;
		const limits: LegionBudgetLimits = { maxDepth: depthCeiling, maxChildrenPerNode: maxChildren, maxActiveNodes: (legion.settings?.maxActiveNodes ?? 30) + activeReservation };
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
		if (!this.legion || !child.nodeId || execution.status === "running") return;
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

	async launch(input: {
		agent: AgentConfig;
		task: string;
		name?: string;
		team?: string;
		model?: string;
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
		// A utility dispatch is a hard leaf, not a nested command-chain launch.
		// The frozen contract therefore skips assertWithinBudgets entirely.
		if (!input.utilityDispatch) this.assertWithinBudgets(Boolean(previous));
		if (this.supervisor.isAlive(name)) throw new SubagentError(`child is already alive: ${name}`, ErrorCodes.NAME_TAKEN);
		const models = this.planModelCandidates({
			agent: input.agent,
			...(input.model !== undefined ? { model: input.model } : {}),
			origin: input.modelOrigin ?? (input.model !== undefined ? "explicit" : input.agent.modelSource?.type === "subagents.defaultModel" ? "inherited" : input.agent.model ? "explicit" : "inherited"),
			...(input.thinking !== undefined ? { thinking: input.thinking } : {}),
		});
		let sessionFile = previous?.sessionFile ?? this.sessionFileFor(name);
		const tempDir = this.runDir;
		const parentRole = this.legion ? getNode(this.legion.db, this.legion.nodeId)?.role : undefined;
		const worktree = this.legion && input.agent.name === "centurion"
			? true
			: this.legion && parentRole === "centurion"
				? false
				: resolveLaunchWorktree({ roleDefault: input.agent.worktree, launch: input.worktree });
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
					herdr: { supervisor: "rpc", node_id: nodeId },
				});
				createdRunId = run.runId;
				sessionFile = this.legion.runStore.sessionFileFor(run.runId, name);
			}
			preCreateSessionFile(sessionFile);
			if (this.legion && nodeId) {
				const reservationRunId = createdRunId ?? (previous ? ledgerPrevious?.runId : undefined) ?? this.legion.runId;
				reservedNode = this.reserveNode({ nodeId, name, agent: input.agent, task: input.task, sessionFile, runId: reservationRunId, team: input.team, worktreePath, model: models.candidates[0], utility: Boolean(input.utilityDispatch && input.agent.utility) });
				reserved = true;
				parentReservationCreated = await this.persistParentReservation({ nodeId, name, agent: input.agent, sessionFile, ...(models.candidates[0] ? { model: models.candidates[0] } : {}), ...(worktreePath ? { worktreePath } : {}) });
			}
			const childEnv = this.lineageEnv(name, input.agent, input.team, nodeId);
			if (input.stripLegionIdentity) {
				for (const key of [LEGION_DB_ENV, LEGION_NODE_ID_ENV, LINEAGE_ENV, MAX_DEPTH_ENV]) delete childEnv[key];
			}
			let result: Awaited<ReturnType<LegionSupervisor["spawnChild"]>> | undefined;
			let startedModel: string | undefined;
			let lastError: unknown;
			const spawnAgent = !input.agent.utility && input.agent.tools
				? {
					...input.agent,
					tools: input.agent.tools.includes("vexillatio")
						? input.agent.tools
						: [...input.agent.tools, "vexillatio"],
				}
				: input.agent;
			for (let index = 0; index < effectiveModel.length; index += 1) {
				const model = effectiveModel[index];
				const spawnInput: SpawnInput = {
					name,
					task: input.task,
					agent: spawnAgent,
					sessionFile,
					tempDir,
					cwd: worktreePath ?? this.cwd,
					env: childEnv,
					...(model ? { model } : {}),
					...(input.stripLegionIdentity ? { stripLegionIdentity: true } : {}),
					...(input.thinking !== undefined ? { thinking: input.thinking } : input.agent.thinking !== undefined ? { thinking: input.agent.thinking } : {}),
					...(input.agent.allowNestedSubagents !== undefined && !input.agent.utility ? { allowNestedSubagents: input.agent.allowNestedSubagents } : {}),
					...(worktreeBranch ? { worktreeBranch } : {}),
					...(this.childContext ? { childContext: this.childContext } : {}),
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
				this.children.set(name, previous);
			}
			const child = previous ?? this.recordChild({
				name: result.name,
				...(nodeId ? { nodeId } : {}),
				agent: input.agent,
				sessionFile: result.sessionFile,
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

	async collect(name: string, opts: { timeoutMs?: number } = {}): Promise<CollectResult> {
		const child = this.requireChild(name);
		if (this.pendingDialogs(name).length) return this.blockedResult(child);
		const timeoutMs = opts.timeoutMs ?? DEFAULTS.turnTimeoutMs;
		let deadline = this.now() + timeoutMs;
		const initial = parseSessionFile(child.sessionFile);
		let wait: "settled" | "timeout" | "blocked" | "gone" = isLastTurnComplete(initial)
			? "settled"
			: await this.awaitSupervisor(child, deadline);
		for (let attempt = 0; wait === "timeout" && attempt < COLLECT_GRACE_EXTENSIONS; attempt += 1) {
			if (!(await this.collectArtifactGrowing(child))) break;
			deadline += timeoutMs;
			wait = await this.awaitSupervisor(child, deadline);
		}
		if (wait === "blocked") return this.blockedResult(child);
		const parsed = parseSessionFile(child.sessionFile);
		if (wait === "settled" && countAssistantMessages(parsed) > 0) await this.waitForQuiet(child.sessionFile, deadline);
		const current = parseSessionFile(child.sessionFile);
		let execution = deriveOutcome(current);
		if (wait === "timeout" && this.supervisor.isAlive(name) && !isLastTurnComplete(current)) {
			execution = { ...execution, status: "running", reason: `collect timed out after ${timeoutMs}ms; the RPC child is still alive` };
		} else if (wait === "gone" && current.turns.length === 0) {
			execution = { status: "aborted", reason: "RPC child exited before writing session JSONL", model: child.model ?? null };
		}
		return this.finishCollect(child, current, execution, deadline);
	}

	private async awaitSupervisor(child: ChildRecord, deadline: number): Promise<"settled" | "timeout" | "blocked" | "gone"> {
		if (this.pendingDialogs(child.name).length) return "blocked";
		let pending = this.pendingWaits.get(child.name);
		if (!pending) {
			pending = this.supervisor.waitSettled(child.name, Math.max(1, deadline - this.now()));
			this.pendingWaits.set(child.name, pending);
			const current = pending;
			void current.then(
				() => { if (this.pendingWaits.get(child.name) === current) this.pendingWaits.delete(child.name); },
				() => { if (this.pendingWaits.get(child.name) === current) this.pendingWaits.delete(child.name); },
			);
		}
		if (!this.uiProxy) return this.settleDisposition(await pending, child.name);
		let unsubscribe: (() => void) | undefined;
		const blocked = new Promise<"blocked">((resolve) => {
			unsubscribe = this.uiProxy?.onRequest((request) => {
				if (request.childName !== child.name || !isApprovalRequest(request)) return;
				child.state = "blocked";
				this.onChildUpdate(child);
				resolve("blocked");
			});
		});
		if (this.pendingDialogs(child.name).length) {
			unsubscribe?.();
			return "blocked";
		}
		const result = await Promise.race([
			pending.then((settled) => this.settleDisposition(settled, child.name)),
			blocked,
		]);
		unsubscribe?.();
		return result;
	}

	private settleDisposition(result: SettleResult, name: string): "settled" | "timeout" | "gone" {
		if (result.settled) return "settled";
		if (result.reason === "timeout" || (!result.abnormal && this.supervisor.isAlive(name))) return "timeout";
		return "gone";
	}

	private blockedResult(child: ChildRecord): CollectResult {
		const parsed = parseSessionFile(child.sessionFile);
		const execution: Execution = { status: "running", reason: "blocked: waiting for a child UI approval" };
		const acceptance = deriveAcceptance(parsed, execution, child.pendingCriteria, {
			...(child.completionGuard ? { completionGuard: true } : {}),
		});
		child.state = "blocked";
		child.execution = execution;
		child.acceptance = acceptance;
		this.onChildUpdate(child);
		return { execution, output: parsed.output, usage: parsed.usage, model: parsed.model ?? child.model ?? null, acceptance, blocked: true };
	}

	private async finishCollect(child: ChildRecord, parsed: ReturnType<typeof parseSessionFile>, execution: Execution, deadline: number): Promise<CollectResult> {
		const acceptance = await applyVerification(
			deriveAcceptance(parsed, execution, child.pendingCriteria, { ...(child.completionGuard ? { completionGuard: true } : {}) }),
			{ cwd: child.worktreePath ?? this.cwd, criteria: child.pendingCriteria, run: this.verifyRunner, timeoutMs: Math.max(5_000, deadline - this.now()) },
		);
		if (execution.status !== "running") child.state = "awaiting";
		child.execution = execution;
		child.acceptance = acceptance;
		if (execution.status !== "running") this.recordSettled(child, execution);
		this.onChildUpdate(child);
		const output = execution.status !== "running" && parsed.lastTurnOutput === null ? "" : parsed.output;
		let outputFile: string | undefined;
		if (execution.status === "running") child.outputFile = undefined;
		else {
			outputFile = this.writeOutputFile(child, output);
			child.outputFile = outputFile;
		}
		this.onChildUpdate(child);
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

	private async collectArtifactGrowing(child: ChildRecord): Promise<boolean> {
		const before = artifactSize(child.sessionFile);
		if (before <= 0) return false;
		await this.sleep(POLL_INTERVAL_MS);
		return artifactSize(child.sessionFile) > before;
	}

	private async waitForQuiet(sessionFile: string, deadline: number): Promise<void> {
		let previous = -1;
		let quietSince = this.now();
		const maxPolls = Math.max(1, Math.ceil(DEFAULTS.turnTimeoutMs / POLL_INTERVAL_MS));
		for (let poll = 0; poll < maxPolls; poll += 1) {
			const size = artifactSize(sessionFile);
			if (size !== previous) { previous = size; quietSince = this.now(); }
			else if (this.now() - quietSince >= DEFAULTS.settleQuietMs) return;
			if (this.now() >= deadline) return;
			await this.sleep(POLL_INTERVAL_MS);
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

	async retire(name: string): Promise<ChildRecord> {
		const child = this.requireChild(name);
		if (!child.execution && fs.existsSync(child.sessionFile)) child.execution = deriveOutcome(parseSessionFile(child.sessionFile));
		if (this.supervisor.isAlive(name)) await this.supervisor.retire(name);
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

	restore(record: RunRecord): void {
		for (const child of record.children) {
			const node = this.legion && !child.nodeId ? getChildByName(this.legion.db, this.legion.nodeId, child.name) : null;
			this.children.set(child.name, { ...child, ...(node ? { nodeId: node.id } : {}) });
		}
		this.spawned = Math.max(this.spawned, record.budget.spawned);
	}
}
