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
import { checkLaunchBudget, withLaunchBudget, type LegionBudgetLimits } from "../legion/budget.ts";
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
	unknownChildError,
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
import {
	type AdmissionDimension,
	type AdmissionQueue,
	type AdmissionQueueEntry,
	type AdmissionVerdict,
	acquireAdmissionQueue,
	evaluateInProcessAdmission,
	type InProcessAdmissionCounts,
	peekAdmissionQueue,
	type QueuedLaunch,
	queueTimeoutMessage,
} from "../supervisor/admission-queue.ts";
import { type ChildLaunchContext, currentChildContext, runInChildContext } from "../supervisor/child-context.ts";
import { inProcessDepth, runAtAbsoluteDepth } from "../supervisor/inprocess-depth.ts";
import { subscribeInProcessSlotReleases } from "../supervisor/routing-supervisor.ts";
import type { LegionSupervisor, SettleResult, SpawnInput } from "../supervisor/types.ts";
import type { PendingUIRequest, UIProxy } from "../supervisor/ui-proxy.ts";
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
	reason: string;
	/** Present for maxDepth hard-cap warnings. */
	requestedMaxDepth?: number;
	/** Present for maxDepth hard-cap warnings. */
	effectiveMaxDepth?: number;
	/** Role name when reason is `worktree_denied_non_centurion` (#214). */
	agent?: string;
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
	/**
	 * D6/D10 (launch admission queue): queue bounds. Absent fields fall back to
	 * the defaults declared in `admission-queue.ts` (32 pending / 900_000 ms).
	 */
	launchQueue?: { maxPending?: number; timeoutMs?: number };
	/** D9: one user-visible line per queued / admitted / expired / stopped launch. */
	onLaunchQueueNotice?: (line: string) => void;
}

/**
 * One queued launch (contract §4.3, issue #266).
 *
 * `run()` re-enters `launchInternal` with `admissionAlreadyGranted: true`, so the
 * name allocated at enqueue time is reused (D4) and the authoritative gates are
 * re-evaluated at admission time (I-O1).
 */
export interface LaunchQueuePayload {
	readonly name: string;
	readonly parentKey: string;
	readonly inProcess: boolean;
	/** ALS depth captured at enqueue time; admission restores it (A18). */
	readonly parentDepth: number;
	/** ALS identity captured at enqueue time; admission restores it (A18). */
	readonly parentContext?: ChildLaunchContext;
	/** Run the real launch. */
	run(): Promise<Handle>;
	/** Settles when the item leaves the queue. */
	readonly settled: Promise<AdmitOutcome>;
}

/** How a queued item left the queue (contract §4.3). */
export type AdmitOutcome =
	| { readonly kind: "admitted"; readonly waitedMs: number }
	| { readonly kind: "rejected"; readonly reason: "timeout" | "stopped" | "flushed"; readonly message: string };

/**
 * I-O3: what a `queued` record from a *previous* process means. The queue lives
 * in memory, so such a record can never become live again — say so instead of
 * reporting `unknown child`, and let `retire` clean it up.
 */
function launchQueueLostMessage(name: string): string {
	return `child '${name}' never started: the launch queue was lost when the previous process exited; re-dispatch it (or relaunch) instead`;
}

/** Launch parameters (extracted so the queued replay can reuse them verbatim). */
export interface LaunchInput {
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
}

	/**
	 * I-O3: a *live* queued item was asked to do something that needs a spawned
	 * child. D4 freezes the payload at enqueue time, so the only way to change a
	 * queued launch is to stop it and launch again (§10).
	 */
	function queuedNotStartedMessage(name: string): string {
		return `child '${name}' has not started yet (state=queued); stop it and relaunch to change it`;
	}

	/** Everything `probeAdmission` needs, captured once per launch attempt. */
interface AdmissionProbeContext {
	readonly inProcess: boolean;
	readonly agent: AgentConfig;
	readonly nodeId?: string;
	readonly ledgerPrevious: LegionNode | null;
	/** Utility nodes are hard leaves; their ledger depth ceiling differs. */
	readonly utility: boolean;
}

	/**
	 * Bookkeeping for one queued item (paired 1:1 with its `queued` ChildRecord).
	 *
	 * `settled` is the channel D8 §"other errors bubble to the caller" needs: a
	 * timeout/stop/flush resolves it with a `rejected` outcome, while a genuine
	 * spawn failure rejects it with the original error.
	 */
	interface LaunchGuard {
		/** Resolve the item's `settled` promise exactly once. */
		readonly settle: (outcome: AdmitOutcome) => void;
		/** Leaves the queue (admitted / timeout / stopped / flushed) — what `collect` awaits. */
		readonly settled: Promise<AdmitOutcome>;
		/** Re-run the advisory gate for this item (D2-c attribution, D5 head-of-line skip). */
		readonly probe: () => AdmissionVerdict;
		readonly dimension: AdmissionDimension;
		/** When the item first entered the queue — the requeue path keeps this deadline. */
		readonly enqueuedAt: number;
	}

/** The narrow, read-only supervisor surface the probe consumes (I-O1). */
interface AdmissionProbeSource {
	admissionCounts(name: string): InProcessAdmissionCounts;
	preflightAdmission(name: string): AdmissionVerdict;
}

function asAdmissionProbe(source: unknown): AdmissionProbeSource | undefined {
	if (!source || typeof source !== "object") return undefined;
	const candidate = source as Partial<AdmissionProbeSource>;
	return typeof candidate.admissionCounts === "function" && typeof candidate.preflightAdmission === "function"
		? (source as AdmissionProbeSource)
		: undefined;
}

/**
 * §4.3: the in-process probe lives on the `InProcessSupervisor` instance. A
 * `RoutingSupervisor` keeps it as `inprocess`; a bare in-process supervisor (or
 * a test double) may expose the members itself. Anything else (RPC, fakes)
 * admits — the probe is advisory only (I-O1).
 */
function inProcessProbeOf(supervisor: LegionSupervisor): AdmissionProbeSource | undefined {
	const routing = supervisor as LegionSupervisor & { inprocess?: unknown };
	return asAdmissionProbe(routing.inprocess) ?? asAdmissionProbe(supervisor);
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
/**
 * Shown when this collect() call's budget elapses and the child is still in-turn.
 *
 * The "cumulative since launch" wording below is legacy: `collect()` starts its
 * deadline from the moment it is called (`orchestrator.ts` `let deadline = ...`),
 * not from launch. The literal is user-visible and asserted in integration tests,
 * so D6 of `docs/contracts/vexillatio-nonblocking-launch-v1.md` deliberately left
 * it untouched; do not read it as the actual budget origin.
 */
export const COLLECT_DEADLINE_REASON = "collect deadline (cumulative since launch) exceeded; child still alive";
/** Shown when a live child's session ends on an OpenAI/GPT connection blip. */
export const TRANSIENT_CONNECTION_REASON = "transient connection error; RPC child still alive";
const LINEAGE_ENV = "PI_SUBAGENT_PARENT_PATH";
const MAX_DEPTH_ENV = "PI_SUBAGENT_MAX_DEPTH";
const UTILITY_CHILD_ENV = "PI_SUBAGENT_UTILITY_CHILD";
const CHILD_ENV = "PI_SUBAGENT_CHILD";
const POLL_INTERVAL_MS = 500;
/** Ceiling for the geometric backoff in `waitOutTransientConnection`. */
const TRANSIENT_POLL_CAP_MS = 4_000;
/** Growth sampling step while waiting out one `POLL_INTERVAL_MS` grace window. */
const ARTIFACT_GROWTH_POLL_MS = 50;

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
	/** D6/D10: queue bounds passed to the process-level queue (first acquisition wins). */
	private readonly launchQueueBounds: { maxPending?: number; timeoutMs?: number };
	private readonly onLaunchQueueNotice?: (line: string) => void;
	private depthWarningEmitted = false;
	private worktreeDeniedWarningEmitted = false;
	private spawnModeDeniedWarningEmitted = false;
	private spawned = 0;
	private readonly children = new Map<string, ChildRecord>();
	private readonly nameCounter = new Map<string, number>();
	private readonly pendingWaits = new Map<string, Promise<SettleResult>>();
	/** Children retired because the parent session is shutting down. */
	private readonly parentShutdownRetire = new Set<string>();
	/**
	 * D2-b in-flight reservation: admissions this tick already waved through but
	 * which the authoritative gates cannot see yet (the child only lands in the
	 * supervisor's `children` map after the first `await` in `spawnChild`).
	 * Without it, a same-tick fan-out of 12 probes all read 0 live children and
	 * all pass — which is exactly the bug #266 exists to fix.
	 */
	private readonly admitting = new Map<string, { parentKey: string; dimension: AdmissionDimension }>();
	/** Lazily acquired process-level queue for this run directory (§13.6). */
	private admissionQueueRef?: AdmissionQueue<LaunchQueuePayload>;
	/**
	 * Per-name admission guard: the `settled` channel for `collect`, the re-probe
	 * closure for D2-c/D5, and the original deadline a requeue must honour.
	 */
	private readonly launchGuards = new Map<string, LaunchGuard>();
	/** D2-d-4: at most one unref'd fallback timer while the queue is non-empty. */
	private queueWatchdog?: ReturnType<typeof setTimeout>;
	/** `pumpAdmissions` mutex — a second concurrent pump must never double-admit. */
	private pumping = false;
	/**
	 * D2-d-2 subscription, held only while this instance has pending items.
	 *
	 * `index.ts` creates a fresh Orchestrator per control action, so subscribing
	 * eagerly in the constructor would leak one listener per tool call. Subscribing
	 * on the first queued item (and dropping it when the queue empties) keeps the
	 * listener set proportional to real queue owners.
	 */
	private unsubscribeSlotReleases?: () => void;

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
		this.launchQueueBounds = deps.launchQueue ?? {};
		this.onLaunchQueueNotice = deps.onLaunchQueueNotice;
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
			// #266 D4: an automatically allocated name must not collide with a QUEUED
			// item either. The queue is process-level, so a sibling instance's pending
			// launch is invisible to `this.children` / `isAlive` — allocating its name
			// here would make the new (legitimate) launch fail with NAME_TAKEN.
			if (this.isQueuedHere(candidate)) continue;
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

	private reserveNode(input: { nodeId: string; name: string; agent: AgentConfig; task: string; sessionFile: string; runId?: string; team?: string; worktreePath?: string; model?: string; utility?: boolean; inProcess?: boolean }): LegionNode | null {
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
		//
		// #279: keyed on the ARBITRATED backend, not the role card's spelling. A role
		// that pins `spawnMode: rpc` is demoted to in-process before this runs, and
		// reading the raw card again would charge the rpc buckets for a launch that
		// never runs there (the two backends have separate limits by design).
		// #279: in-process launches are budgeted again. #197 granted them unlimited
		// ledger headroom because rpc was the default and only rpc spent these slots.
		// Now that rpc is reserved for centurion, every other role runs
		// in-process — so "unlimited" would mean "avoid rpc, escape the caps", and a
		// worker could nest without bound. They still get the `inprocess.*` pools
		// enforced inside the in-process supervisor; this restores the ledger floor.
		const limits: LegionBudgetLimits = {
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

	/**
	 * #214: only `name === "centurion"` may hold worktree isolation.
	 * Non-centurion requests warn once per run (like warnDepthCap) and are
	 * forced to false — never thrown.
	 */
	private warnWorktreeDenied(agentName: string): void {
		if (this.worktreeDeniedWarningEmitted) return;
		this.worktreeDeniedWarningEmitted = true;
		const event: BudgetRefusedEvent = {
			type: "budget_refused",
			reason: "worktree_denied_non_centurion",
			agent: agentName,
		};
		console.warn(
			`[pi-legion] worktree denied for non-centurion role '${agentName}'; forced worktree: false. ` +
				`Fix the role card (set worktree: false) or dispatch a centurion for isolated parallel writers.`,
		);
		this.onBudgetRefused?.(event);
	}

	/**
	 * #279: only `name === "centurion"` may run on the rpc backend.
	 *
	 * `warnWorktreeDenied` above already forces `worktree: false` for everyone
	 * else, but that guard keys on the worktree REQUEST — a role card that pins
	 * `spawnMode: rpc` explicitly never consults `resolveSpawnMode`, so it slipped
	 * through and got a separate process (the exact isolation the worktree rule
	 * exists to reserve). This closes that bypass. Like the worktree rule it warns
	 * once per run and demotes, never throws: a stale role card must not turn every
	 * launch in the tree into a hard failure.
	 */
	private warnSpawnModeDenied(agentName: string): void {
		if (this.spawnModeDeniedWarningEmitted) return;
		this.spawnModeDeniedWarningEmitted = true;
		const event: BudgetRefusedEvent = {
			type: "budget_refused",
			reason: "spawn_mode_denied_non_centurion",
			agent: agentName,
		};
		console.warn(
			`[pi-legion] rpc denied for non-centurion role '${agentName}'; forced spawnMode: inprocess. ` +
				`Fix the role card (remove spawnMode: rpc) or dispatch a centurion when you need an isolated process.`,
		);
		this.onBudgetRefused?.(event);
	}

	async launch(
		input: LaunchInput,
		/**
		 * Internal replay of an already-admitted launch (issue #266 D2-c / §4.3).
		 * Public callers must omit it: admission is decided exactly once, at the
		 * frozen insertion point below.
		 */
		internal: { admissionAlreadyGranted?: boolean } = {},
	): Promise<Handle> {
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
		// D3-a: a `queued` record carries a PLACEHOLDER session file, so it must never
		// be mistaken for a resume credential (R8). Only real records resume.
		const priorRecord = this.children.get(name);
		const previous = priorRecord && priorRecord.state !== "queued"
			? priorRecord
			: (ledgerPrevious ? this.childFromNode(name, ledgerPrevious) : undefined);
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
		const isCenturion = input.agent.name === "centurion";
		// #281: only the ROOT session may dispatch a centurion.
		//
		// Every other guard here keys on the CHILD's role, so without this a worker
		// could dispatch a centurion and silently acquire worktree + rpc isolation
		// (measured: `subagent({agent:"centurion"})` from a worker launched on rpc
		// with a fresh worktree). A centurion exists to own an isolated tree and its
		// own team; nesting one inside another agent's turn produces a second
		// command chain the root cannot collect, so it is refused rather than
		// demoted — a demoted centurion can neither create a worktree nor do its job.
		//
		// Refused BEFORE any worktree/dir is created, so a rejected dispatch leaves
		// no artifacts behind.
		if (isCenturion && this.legion && this.legion.nodeId !== "root") {
			throw new SubagentError(
				`only the root session may dispatch a centurion; '${parentRole ?? this.legion.nodeId}' at '${this.legion.nodeId}' cannot`,
				ErrorCodes.BUDGET_EXCEEDED,
			);
		}
		// #214 D4: only centurion may hold worktree. Legion path still forces
		// centurion→true and centurion-parent→member false; non-centurion
		// requests from any source are demoted below (D1: warn, never throw).
		let worktree = isCenturion
			? (this.legion
				? true
				: resolveLaunchWorktree({
					roleDefault: input.agent.worktree,
					launch: input.worktree,
					parentInWorktree: isInsideChildWorktree(this.cwd),
				}))
			: this.legion && parentRole === "centurion"
				? false
				: resolveLaunchWorktree({
					roleDefault: input.agent.worktree,
					launch: input.worktree,
					parentInWorktree: isInsideChildWorktree(this.cwd),
				});
		if (!isCenturion && worktree === true) {
			this.warnWorktreeDenied(input.agent.name);
			worktree = false;
		}
		// Spawn-mode arbitration. Role cards no longer carry a `spawnMode` field:
		// the backend is a property of the LAUNCH, not a role, so a card cannot pin
		// itself to a process model. rpc exists for exactly one reason — it is the
		// only backend that can host a worktree child — so the rule collapses to:
		//
		//   worktree isolation ⇒ rpc;  everything else ⇒ in-process.
		//
		// A centurion is the only role allowed to hold a worktree (#214), so it is
		// also the only role that reaches rpc (#279). Nothing to deny here anymore:
		// a non-centurion cannot request worktree in the first place (the guard
		// above forces it false), and there is no card field left to smuggle a
		// backend request through.
		const mode: SpawnMode = worktree === true ? "rpc" : "inprocess";
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
		const agent: AgentConfig = { ...input.agent, spawnMode: mode, ...(worktree ? {} : { worktree: false }) };
		// A utility dispatch is a hard leaf, not a nested command-chain launch.
		//
		// #279: this check now covers EVERY backend. It used to be `!inProcess`,
		// because #197 gave in-process its own `subagents.inprocess.*` buckets. But
		// rpc is reserved for centurion, so every other role now runs in-process —
		// leaving them unchecked here would mean "avoid rpc, escape the depth and
		// per-session spawn ceilings", and a worker could nest without bound.
		// The in-process supervisor still enforces its own `inprocess.*` limits;
		// this is an additional floor, not a replacement.
		if (!input.utilityDispatch) this.assertWithinBudgets(Boolean(previous));
		if (this.supervisor.isAlive(name)) throw new SubagentError(`child is already alive: ${name}`, ErrorCodes.NAME_TAKEN);
		// D4: the name-occupancy check must cover QUEUED records too. `previous`
		// deliberately ignores them (D3-a: its placeholder session path is not a resume
		// credential) and a queued child is not `alive`, so without this clause a
		// second `launch({name})` would enqueue the SAME name twice and only fail
		// later, at admission, with a confusing `child is already alive`.
		//
		// The two cases are NOT the same refusal (I-O3 / §13.3.1):
		//  - the item is still in THIS process's queue → `NAME_TAKEN` (a live launch is
		//    in flight under that name; wait, steer it, or stop it);
		//  - the record is a leftover from a previous process → the queue is gone and it
		//    can never start, so `resume`/`continue` must get the "re-dispatch it"
		//    message instead of a `NAME_TAKEN` that implies something is running.
		// That second branch is what keeps I-O3's promise and lets a caller relaunch
		// the same name after a restart.
		const queuedHere = this.children.get(name)?.state === "queued";
		if (queuedHere || this.isQueuedHere(name)) {
			if (queuedHere && !this.isQueuedHere(name)) {
				throw new SubagentError(launchQueueLostMessage(name), ErrorCodes.BUDGET_EXCEEDED);
			}
			throw new SubagentError(`child is already alive: ${name}`, ErrorCodes.NAME_TAKEN);
		}
		// Only an EXPLICIT inprocess can reach this: the arbitration above already
		// routed every omitted-mode launch that needs a worktree to rpc, so I1
		// (explicit inprocess + worktree stays a loud throw) holds. This replaces
		// the old gate, which inspected the raw `worktree` fields and therefore
		// rejected callers that explicitly overrode a worktree role with
		// `launch({ worktree: false })` — that override now wins as it should.
		if (inProcess && worktree) {
			throw new SubagentError(
				`spawnMode "inprocess" cannot use worktree isolation for '${name}'; set worktree: false`,
				ErrorCodes.INVALID_PARAMS,
			);
		}
		// ── Launch admission queue (issue #266, contract §4.3 frozen insertion point) ──
		// Here and not later on purpose: the name is allocated (D4), the backend is
		// arbitrated, `assertWithinBudgets`/`isAlive` already passed, the illegal
		// `inprocess + worktree` combination is rejected, and **nothing has happened
		// yet** (no worktree, no run dir, no session file, no ledger row). Enqueuing
		// after `reserveNode` would self-lock the fanout gate on a `starting` row
		// that belongs to a child nobody started (R3/F10).
		const probeContext: AdmissionProbeContext = {
			inProcess,
			agent,
			...(nodeId ? { nodeId } : {}),
			ledgerPrevious,
			utility: Boolean(input.utilityDispatch && input.agent.utility),
		};
		if (!internal.admissionAlreadyGranted) {
			const verdict = this.probeAdmission(name, probeContext);
			if (verdict.admitted === false && verdict.queueable === true) {
				// D1: only the four queueable gates land here. Everything else falls
				// through to master's own gate below, so its message stays byte-identical
				// (D1-b: never re-wrap a `BUDGET_EXCEEDED` as a queue decision).
				return this.enqueueLaunch(input, name, verdict, probeContext, mode);
			}
			if (verdict.admitted === true) {
				// D2-b: reserve the slot in THIS sync block. The child does not reach the
				// supervisor's registry until the first `await` inside `spawnChild`, so a
				// same-tick fan-out would otherwise see 0 live children 12 times (R1).
				this.admitting.set(name, {
					parentKey: this.admissionParentKey(name, probeContext),
					dimension: "fanout",
				});
			}
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
			const effectiveModel = models;
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
				reservedNode = this.reserveNode({ nodeId, name, agent, task: input.task, sessionFile, runId: reservationRunId, team: input.team, worktreePath, model: models[0], utility: Boolean(input.utilityDispatch && input.agent.utility), inProcess });
				reserved = true;
				parentReservationCreated = await this.persistParentReservation({ nodeId, name, agent: input.agent, sessionFile, ...(models[0] ? { model: models[0] } : {}), ...(worktreePath ? { worktreePath } : {}) });
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
									// #295: the in-process child shares the HOST's process.env, so
									// `env` below never reaches its guard. Carry the budget here,
									// where the child context is the only channel that survives.
									...(() => {
										const budget = {
											...(agent.toolBudget?.maxToolCalls !== undefined ? { maxToolCalls: agent.toolBudget.maxToolCalls } : {}),
											...(agent.turnBudget?.maxTurns !== undefined ? { maxTurns: agent.turnBudget.maxTurns } : {}),
											...(agent.toolTimeoutMs !== undefined ? { toolTimeoutMs: agent.toolTimeoutMs } : {}),
										};
										return Object.keys(budget).length > 0 ? { budget } : {};
									})(),
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
			// The child is in the supervisor's registry now, so the advisory in-flight
			// reservation is superseded by the real counts (D2-b).
			this.admitting.delete(name);
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
				// Only an `rpc` child owns a process; `inprocess` reports no pid, so no
				// value is invented. Never persisted — a pid is host-scoped.
				...(result.pid ? { pid: result.pid } : {}),
			};
		} catch (error) {
			this.admitting.delete(name);
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
	}): Array<string | undefined> {		const requested = modelCandidates(input.model ?? input.agent.model, input.agent.fallbackModels);
		// Every candidate now belongs to the one supported kind, so the model the
		// caller asked for is the model the child starts with; an unset model is
		// the only case that leaves the choice to the child's own configuration.
		const candidates = requested.filter((model): model is string => Boolean(model));
		return candidates.length ? candidates : [undefined];
	}

	// ── Launch admission queue (issue #266) ─────────────────────────────────

	/**
	 * `maxChildrenPerNode` groups children by the name before the last dot — the
	 * exact key `InProcessSupervisor` uses (`parentKeyOf`), so the probe and the
	 * authoritative gate count the same siblings.
	 */
	private admissionParentKey(name: string, ctx: AdmissionProbeContext): string {
		const probe = ctx.inProcess ? inProcessProbeOf(this.supervisor) : undefined;
		if (probe) return probe.admissionCounts(name).parentKey;
		const idx = name.lastIndexOf(".");
		return idx === -1 ? "" : name.slice(0, idx);
	}

	/**
	 * D2-b: in-flight reservations attributable to one parent key.
	 *
	 * A reservation must only cover the window in which the backend cannot see the
	 * child yet. That window is narrow and backend-specific: the in-process
	 * supervisor registers a child **synchronously** inside `spawnChild`, and the
	 * legion path inserts its `starting` row synchronously inside `reserveNode`. Once
	 * either has happened the real counts already include the launch, so counting the
	 * reservation too would double it and halve the effective cap (measured: a
	 * 9-launch same-tick fan-out with `maxChildrenPerNode: 8` admitted only 4).
	 */
	private inflightFor(parentKey: string, ctx?: AdmissionProbeContext): { fanout: number; active: number } {
		let fanout = 0;
		let active = 0;
		for (const [name, entry] of this.admitting) {
			if (this.launchAlreadyVisible(name, ctx)) continue;
			active += 1;
			if (entry.parentKey === parentKey) fanout += 1;
		}
		return { fanout, active };
	}

	/** Has the backend registered this in-flight launch yet? */
	private launchAlreadyVisible(name: string, ctx?: AdmissionProbeContext): boolean {
		const record = this.children.get(name);
		if (record && record.state !== "queued") return true;
		if (this.supervisor.isAlive(name)) return true;
		const legion = this.legion;
		if (!ctx?.nodeId || !legion) return false;
		// `reserveNode` inserts the row before the awaited `persistParentReservation`,
		// so an existing row means the ledger counts this launch already.
		return getNode(legion.db, ctx.nodeId) !== null;
	}

	/**
	 * The advisory admission probe (contract §4.3, I-O1).
	 *
	 * Synchronous on purpose: the fast path may not gain a single `await` (D2-b /
	 * A21). `admissionCounts` and `checkLaunchBudget` are both plain reads.
	 *
	 * Nothing here replaces an authoritative gate: an `admitted: true` verdict only
	 * skips the *queue*, never `assertWithinLimits` / `withLaunchBudget` (I-O1). A
	 * launch that still loses the real gate is re-queued instead of failing (D2-c).
	 */

	/**
	 * The legion ledger gate, shared by the rpc and in-process admission paths
	 * (#279). Read-only (`checkLaunchBudget`), never `withLaunchBudget` — a probe
	 * must not insert a `starting` row (R3/F10) and must not emit
	 * `budget_refused`, which belongs to `reserveNode` (D1-b).
	 */
	private probeLedgerAdmission(name: string, ctx: AdmissionProbeContext): ReturnType<Orchestrator["probeAdmission"]> {
		// rpc/legion: the ledger gate. Read-only (`checkLaunchBudget`), never
		// `withLaunchBudget` — a probe must not insert a `starting` row (R3/F10) and
		// must not emit `budget_refused`, which belongs to `reserveNode` (D1-b).
		const legion = this.legion;
		if (!legion || !ctx.nodeId) return { admitted: true };
		const parent = getNode(legion.db, legion.nodeId);
		// `reserveNode` owns `parent_not_found`; do not pre-empt it.
		if (!parent) return { admitted: true };
		const maxChildren = legion.settings?.maxChildrenPerNode ?? 8;
		const depthCeiling = ctx.utility
			? parent.depth + 1
			: Math.min(legion.settings?.maxDepth ?? this.maxDepthValue, MAX_NESTED_PATH_ENTRIES);
		const maxActiveNodes = legion.settings?.maxActiveNodes ?? 30;
		const decision = checkLaunchBudget(
			legion.db,
			{ parentId: legion.nodeId, depth: parent.depth + 1, nodeId: ctx.nodeId },
			{ limits: { maxDepth: depthCeiling, maxChildrenPerNode: maxChildren, maxActiveNodes } },
		);
		if (decision.allowed) return { admitted: true };
		// D2-b: the ledger snapshot cannot see the rows this tick has not inserted
		// yet, so the in-flight reservations are added before judging.
		const inflight = this.inflightFor("", ctx);
		if (decision.reason === "max_children_per_node") {
			const children = decision.children + inflight.fanout;
			if (maxChildren === 0) {
				// D11: `0` means "no children at all" — waiting cannot satisfy it.
				return {
					admitted: false,
					queueable: false,
					gate: "ledger.maxChildrenPerNode.disabled",
					message: `legion launch refused (max_children_per_node): parent already has ${children} live children; maxChildrenPerNode is 0`,
				};
			}
			if (children >= maxChildren) {
				return {
					admitted: false,
					queueable: true,
					gate: "ledger.maxChildrenPerNode",
					dimension: "fanout",
					message: `legion launch refused (max_children_per_node): parent already has ${children} live children; maxChildrenPerNode is ${maxChildren}`,
				};
			}
			return { admitted: true };
		}
		if (decision.reason === "max_active_nodes") {
			const activeNodes = decision.activeNodes + inflight.active;
			if (activeNodes >= maxActiveNodes) {
				return {
					admitted: false,
					queueable: true,
					gate: "ledger.maxActiveNodes",
					dimension: "active",
					message: `legion launch refused (max_active_nodes): tree already has ${activeNodes} active nodes; maxActiveNodes is ${maxActiveNodes}`,
				};
			}
			return { admitted: true };
		}

		return { admitted: true };
	}

	private probeAdmission(name: string, ctx: AdmissionProbeContext): AdmissionVerdict {
		if (ctx.inProcess) {
			// #279: the ledger floor applies to in-process launches too. It used to be
			// skipped entirely (#197 gave in-process unlimited ledger headroom), but
			// rpc is now reserved for centurion — so "skip the ledger" would
			// mean every non-centurion role escapes `maxChildrenPerNode` /
			// `maxActiveNodes`. `reserveNode` already charges these slots, so without
			// this probe the launch is REFUSED there after admission was granted here.
			//
			// Two gates now apply and the stricter wins: this ledger check (fanout /
			// active / depth) plus the `inprocess.*` pools probed below.
			const ledgerVerdict = this.probeLedgerAdmission(name, ctx);
			if (ledgerVerdict.admitted !== true) return ledgerVerdict;
			const probe = inProcessProbeOf(this.supervisor);
			// No readable counts (a test double) → nothing to probe.
			if (!probe) return { admitted: true };
			const counts = probe.admissionCounts(name);
			return evaluateInProcessAdmission(counts, this.inflightFor(counts.parentKey, ctx));
		}
		return this.probeLedgerAdmission(name, ctx);

	}

	/**
	 * The process-level queue for this run directory (§13.6 / I-O6).
	 *
	 * `acquireAdmissionQueue` is idempotent per (pid, runDir), so the five
	 * `new Orchestrator` sites in `index.ts` share one queue — that is what lets
	 * `subagent({action:"stop"})` dequeue an item it never enqueued.
	 */
	private admissionQueue(): AdmissionQueue<LaunchQueuePayload> {
		this.admissionQueueRef ??= acquireAdmissionQueue<LaunchQueuePayload>(this.runDir, {
			...this.launchQueueBounds,
			now: this.now,
		});
		return this.admissionQueueRef;
	}

	/**
	 * The queue **if one already exists**, without creating it.
	 *
	 * The read-only and control paths must not acquire: acquisition installs an
	 * empty queue with default bounds, and "first acquisition wins" would then
	 * shadow the real owner's `launchQueue` settings.
	 */
	private existingAdmissionQueue(): AdmissionQueue<LaunchQueuePayload> | undefined {
		// §6.1/§13.6: a control-action instance (stop/status/collect) must reach the
		// queue a SIBLING instance created — otherwise `subagent stop <queued>` is a
		// silent no-op and `status` reports it as "queue lost". `peek` is read-only on
		// purpose: acquiring here would install an empty queue with default bounds and
		// shadow the real owner's settings ("first acquisition wins").
		return this.admissionQueueRef ?? peekAdmissionQueue<LaunchQueuePayload>(this.runDir);
	}

	/** D9: one user-visible line; a UI hook must never break admission. */
	private notice(line: string): void {
		const fn = this.onLaunchQueueNotice;
		if (!fn) return;
		try {
			fn(line);
		} catch {
			/* the notice is cosmetic */
		}
	}

	/**
	 * D3/D3-a: enqueue a launch that only hit a *queueable* gate.
	 *
	 * The three "must not create" rules hold here (asserted by A3/A15): no ledger
	 * `nodes` row, no child run directory / `run.json`, no `<name>.jsonl` file.
	 * `sessionFile` is a placeholder string and `nodeId` is the deterministic id
	 * the later admission will use — computed, never inserted.
	 */
	private enqueueLaunch(
		input: LaunchInput,
		name: string,
		verdict: Extract<AdmissionVerdict, { queueable: true }>,
		ctx: AdmissionProbeContext,
		mode: SpawnMode,
	): Promise<Handle> {
		const queue = this.admissionQueue();
		const parentKey = this.admissionParentKey(name, ctx);
		let settle: (outcome: AdmitOutcome) => void = () => {};
		const settled = new Promise<AdmitOutcome>((resolve) => {
			settle = resolve;
		});
		const parentDepth = inProcessDepth();
		const parentContext = currentChildContext();
		const payload: LaunchQueuePayload = {
			name,
			parentKey,
			inProcess: ctx.inProcess,
			parentDepth,
			...(parentContext ? { parentContext } : {}),
			run: () => this.launch({ ...input, name }, { admissionAlreadyGranted: true }),
			settled,
		};
		const outcome = queue.enqueue(payload, { name, parentKey });
		if (!outcome.ok) {
			// D6: overflow refuses immediately — nothing enqueued, nothing recorded,
			// and any name reservation released.
			this.children.delete(name);
			throw new SubagentError(outcome.message, ErrorCodes.BUDGET_EXCEEDED);
		}
		// D3-a: one `queued` record in the parent run.json (cross-process `status`
		// must show it, D9), and nothing else is created.
		const child: ChildRecord = {
			name,
			...(ctx.nodeId ? { nodeId: ctx.nodeId } : {}),
			sessionFile: this.sessionFileFor(name),
			ownerToken: ownerToken(),
			state: "queued",
			spawnedAt: new Date(this.now()).toISOString(),
			agent: input.agent.name,
			kind: input.agent.kind,
			spawnMode: mode,
			queuePosition: outcome.position,
		};
		this.children.set(name, child);
		this.onChildUpdate(child);
		this.launchGuards.set(name, {
			settle,
			settled,
			probe: () => this.probeAdmission(name, ctx),
			dimension: verdict.dimension,
			enqueuedAt: this.now(),
		});
		this.watchSlotReleases(true);
		this.notice(`▶ ${name} (${input.agent.name}) supervisor=${mode} queued(${outcome.position})`);
		// D2-d-1: this enqueue may itself have a free slot behind it.
		this.schedulePump();
		// D8: `async` semantics are unchanged — a queued handle returns at once.
		return Promise.resolve({
			name,
			sessionFile: child.sessionFile,
			runId: path.basename(this.runDir),
			agent: input.agent.name,
			kind: input.agent.kind,
			child,
			spawnMode: mode,
			queued: true,
			queuePosition: outcome.position,
		});
	}

	/**
	 * D2-d: wake the pump. `pumping` makes overlapping wakes harmless.
	 *
	 * Guarded on owning at least one launch: the queue is process-level and shared
	 * by every Orchestrator on this run dir (`index.ts` has five construction
	 * sites), but only the instance that enqueued an item holds its `LaunchQueuePayload`
	 * — the closure that actually performs the launch. An instance with no guards is
	 * a control-action instance (`stop`/`status`/`collect`); letting it pump would
	 * admit a sibling's items through a probe that cannot judge them, which is how
	 * retired unrelated children used to spawn somebody else's queued work and
	 * reproduce the very `maxChildrenPerNode reached` line #266 removes.
	 */
	private schedulePump(): void {
		if (this.launchGuards.size === 0) return;
		void this.pumpAdmissions();
	}

	/**
	 * D2-d-2: subscribe to in-process slot releases only while this instance owns a
	 * non-empty queue, and drop the subscription as soon as it empties.
	 *
	 * The event source is a process-level broadcast (`routing-supervisor.ts`): the
	 * Orchestrator need not own the supervisor, and `index.ts` hands the same
	 * `RoutingSupervisor` to five different Orchestrator instances.
	 */
	private watchSlotReleases(wanted: boolean): void {
		if (wanted && !this.unsubscribeSlotReleases) {
			this.unsubscribeSlotReleases = subscribeInProcessSlotReleases(() => this.schedulePump());
			return;
		}
		if (!wanted && this.unsubscribeSlotReleases) {
			this.unsubscribeSlotReleases();
			this.unsubscribeSlotReleases = undefined;
		}
	}

	/**
	 * D2-d-4: exactly one unref'd fallback timer while the queue is non-empty.
	 *
	 * A ledger slot can also be freed by *another* process (a sibling session, or
	 * hygiene) and that release sends no event here (§11 R2), so event edges alone
	 * would stall the queue. The deadline is capped by `LAUNCH_QUEUE_RECHECK_MS`
	 * inside `nextDeadlineAt()` and the timer is cleared once the queue empties.
	 *
	 * The callback is fully guarded: `pumpAdmissions` never rejects, and a throwing
	 * timer body would surface as an unhandledRejection long after the instance was
	 * abandoned (see `pumpAdmissions`).
	 */
	private armQueueWatchdog(): void {
		if (this.queueWatchdog) {
			clearTimeout(this.queueWatchdog);
			this.queueWatchdog = undefined;
		}
		const queue = this.admissionQueueRef;
		if (!queue || queue.size === 0) return;
		let deadline: number | undefined;
		try {
			deadline = queue.nextDeadlineAt();
		} catch {
			// A queue we cannot even read is a queue we must stop watching.
			this.abandonLaunchQueue();
			return;
		}
		if (deadline === undefined) return;
		const timer = setTimeout(() => {
			this.queueWatchdog = undefined;
			try {
				void this.pumpAdmissions();
			} catch {
				// `pumpAdmissions` is written not to throw; this is belt-and-braces so a
			// timer can never become an unhandledRejection/uncaughtException.
				this.abandonLaunchQueue();
			}
		}, Math.max(0, deadline - this.now()));
		// Never keep the host process alive just to watch an empty queue.
		timer.unref?.();
		this.queueWatchdog = timer;
	}

	/**
	 * Stop being a queue owner.
	 *
	 * Used when this instance can no longer serve the queue: its clock/db can no
	 * longer be probed (a disposed Orchestrator, e.g. one created per control action
	 * and then dropped). The registry entry is deliberately left in place — another
	 * live Orchestrator on the same run directory may still own it — but this
	 * instance stops pumping, stops its timer and releases its slot listeners.
	 */
	private abandonLaunchQueue(): void {
		if (this.queueWatchdog) {
			clearTimeout(this.queueWatchdog);
			this.queueWatchdog = undefined;
		}
		this.watchSlotReleases(false);
		this.admissionQueueRef = undefined;
	}

	/**
	 * Admit whatever the queue allows right now (contract §4 / D2-c / D2-d).
	 *
	 * Mutually exclusive via `pumping`. Every iteration asks the queue for its next
	 * decision, which is the ONE place a timeout is evaluated (R7): an item under
	 * admission has already left the queue and can never expire underneath the
	 * child it spawned.
	 *
	 * **Never rejects.** Every caller is fire-and-forget (`void this.pump…`), so a
	 * throw here would become an `unhandledRejection` attributed to whatever the
	 * event loop is doing — typically `database is not open` after a test disposed
	 * its fixture. A probe that throws means this instance can no longer judge
	 * admission at all, so the affected items are retired as *lost* (I-O3 wording;
	 * they never started and nothing was reserved) and the instance goes inert.
	 */
	private async pumpAdmissions(): Promise<void> {
		if (this.pumping) return;
		this.pumping = true;
		let probeFailed = false;
		try {
			const queue = this.admissionQueue();
			for (;;) {
				const lost: string[] = [];
				const next = queue.next((item) => {
					const guard = this.launchGuards.get(item.name);
					if (!guard) {
						// The queue is process-level and shared, but only the instance that
						// enqueued an item holds the payload that performs its launch. Admitting
						// somebody else's item here would run a spawn this instance cannot judge
						// (and could not record) — the pre-review code fell back to
						// `{admitted:true}` and did exactly that.
						//
						// Skipping is safe and is NOT a lost item: `next()` moves on to the
						// next candidate (D5-2), the owner's own pump admits it, and if no owner
						// is left the queue's deadline expires it (D6) through the watchdog.
						return { admitted: false, queueable: false, gate: "other", message: "" };
					}
					try {
						return guard.probe();
					} catch {
						// I-O3: nothing was reserved for this item, so “lost” is the truthful
						// outcome — never a rejection into an abandoned async frame.
						lost.push(item.name);
						return { admitted: false, queueable: false, gate: "other", message: "" };
					}
				});
				if (lost.length > 0) {
					probeFailed = true;
					for (const name of lost) this.abandonQueued(name, "flushed", launchQueueLostMessage(name));
				}
				if (next.kind === "none") break;
				if (next.kind === "expired") {
					// D6: the wait ran out — retire the placeholder, tell the user, and
					// leave the ledger untouched (nothing was ever reserved).
					this.abandonQueued(next.item.name, "timeout", next.message);
					continue;
				}
				try {
					await this.admitQueued(next.item, next.waitedMs);
				} catch (error) {
					// A genuine launch failure: the enqueue-time `launch()` promise has
					// already been returned to the caller, so surface it once and keep the
					// pump alive for the remaining items.
					this.onAdmissionFailure(next.item.name, error);
				}
			}
		} catch {
			// The queue itself became unreadable/closed — stop owning it rather than
			// retrying forever from a timer.
			probeFailed = true;
		} finally {
			this.pumping = false;
			if (probeFailed || (this.admissionQueueRef?.size ?? 0) === 0) {
				// Nothing left to admit, or this instance can no longer judge admission:
				// leave no active timer and no slot-release listener behind.
				this.abandonLaunchQueue();
			} else {
				this.armQueueWatchdog();
			}
		}
	}

	/** Report one admission failure without tearing down the pump. */
	private onAdmissionFailure(name: string, error: unknown): void {
		const detail = error instanceof Error ? error.message : String(error);
		this.notice(`launch queue: '${name}' failed to start: ${detail}`);
		this.launchGuards.delete(name);
		const child = this.children.get(name);
		if (child && child.state === "queued") {
			child.state = "exited";
			this.onChildUpdate(child);
		}
	}

	/**
	 * Take one item out of the queue and run it.
	 *
	 * D2-c: the probe is advisory (I-O1), so the replay can still lose the real
	 * gate. When that refusal is attributable to a *queueable* gate, the item goes
	 * back into the queue (keeping its original deadline) instead of failing the
	 * launch. Anything else — a hard gate, `NAME_TAKEN`, `START_FAILED`, a genuine
	 * spawn failure — is rethrown to the caller unchanged.
	 */
	private async admitQueued(item: QueuedLaunch<LaunchQueuePayload>, waitedMs: number): Promise<void> {
		const payload = item.payload;
		const guard = this.launchGuards.get(payload.name);
		this.launchGuards.delete(payload.name);
		// The placeholder is gone: from here on the real launch path owns the record.
		this.children.delete(payload.name);
		// D2-b: reserve the slot for the duration of the real launch.
		this.admitting.set(payload.name, { parentKey: payload.parentKey, dimension: guard?.dimension ?? "fanout" });
		try {
			// A18: restore the ALS depth/identity captured at enqueue time. Without
			// `runAtAbsoluteDepth` a grandchild admitted from the root chain would be
			// recorded at depth 1 and `maxDepth` could never fire.
			const handle = await runAtAbsoluteDepth(payload.parentDepth, () =>
				payload.parentContext
					? runInChildContext(payload.parentContext, () => payload.run())
					: payload.run());
			// D8/D20: the real wait, for `async:false`'s `↳ name waited Ns` line.
			handle.child.queueWaitedMs = waitedMs;
			handle.child.queuePosition = undefined;
			this.onChildUpdate(handle.child);
			this.notice(`▶ ${payload.name} started after queued ${Math.round(waitedMs / 1000)}s`);
			guard?.settle({ kind: "admitted", waitedMs });
		} catch (error) {
			const again = guard?.probe() ?? ({ admitted: true } as AdmissionVerdict);
			const attributable = again.admitted === false && again.queueable === true;
			if (attributable && error instanceof SubagentError && error.code === ErrorCodes.BUDGET_EXCEEDED) {
				// D2-c: requeue and do NOT pump again right away — spinning here would
				// busy-loop while the probe and the real gate briefly disagree.
				this.requeue(payload, guard, waitedMs);
				return;
			}
			// The guard was already removed from the map, so `abandonQueued` (which
			// looks it up again) cannot settle it — settle the local reference here or
			// a concurrent `collect` waits on a promise nobody will ever resolve.
			guard?.settle({
				kind: "rejected",
				reason: "flushed",
				message: error instanceof Error ? error.message : String(error),
			});
			this.abandonQueued(payload.name, "flushed", error instanceof Error ? error.message : String(error));
			throw error;
		} finally {
			this.admitting.delete(payload.name);
		}
	}

	/**
	 * D2-c: put a refused launch back into the queue.
	 *
	 * The frozen wording says "original `seq` (`enqueueWithSeq` or equivalent)". A
	 * re-queue therefore has to preserve the **deadline**, not the position: W1's
	 * `AdmissionQueue` assigns `seq` itself, so the item goes to the back, but its
	 * `enqueuedAt + timeoutMs` is carried over so a launch that keeps losing the
	 * real gate cannot reset its own timeout (R7).
	 */
	private requeue(payload: LaunchQueuePayload, guard: LaunchGuard | undefined, waitedMs: number): void {
		const queue = this.admissionQueue();
		const elapsed = guard ? this.now() - guard.enqueuedAt : waitedMs;
		if (guard && elapsed >= queue.timeoutMs) {
			this.abandonQueued(payload.name, "timeout", queueTimeoutMessage(payload.name, elapsed));
			return;
		}
		// The wait so far, so the record's `spawnedAt` stays truthful across a requeue.
		const carried = this.queuedPlaceholder(payload, elapsed);
		this.children.set(payload.name, carried);
		this.onChildUpdate(carried);
		if (guard) this.launchGuards.set(payload.name, guard);
		const outcome = queue.enqueue(payload, {
			name: payload.name,
			parentKey: payload.parentKey,
			// D2-c: carry the ORIGINAL deadline. `seq` is deliberately fresh (the item
			// goes to the back — D5 gives no one priority), but the wait must not
			// restart: a fresh stamp would reset `waitedMs` to 0 (under-reporting the
			// `async:false` "waited Ns" line) and hand the item a second full
			// `timeoutMs`, so an item that keeps losing the admission race could wait
			// nearly twice the configured bound before D6 fires.
			...(guard ? { enqueuedAt: guard.enqueuedAt } : {}),
		});
		if (!outcome.ok) {
			// The queue grew while this item was being admitted; overflow is still a
			// hard refusal (D6), never an unbounded wait.
			this.abandonQueued(payload.name, "stopped", outcome.message);
			return;
		}
		carried.queuePosition = outcome.position;
		this.onChildUpdate(carried);
		this.armQueueWatchdog();
	}

	/** The `queued` ChildRecord for an item that (re-)entered the queue. */
	private queuedPlaceholder(payload: LaunchQueuePayload, waitedMs: number): ChildRecord {
		const existing = this.children.get(payload.name);
		const base: ChildRecord = existing ?? {
			name: payload.name,
			sessionFile: this.sessionFileFor(payload.name),
			ownerToken: ownerToken(),
			state: "queued",
			spawnedAt: new Date(this.now()).toISOString(),
			spawnMode: payload.inProcess ? "inprocess" : "rpc",
		};
		return {
			...base,
			// `spawnedAt` is the record's creation stamp; backdating it by the wait
			// keeps it truthful across a requeue.
			spawnedAt: new Date(this.now() - waitedMs).toISOString(),
			state: "queued",
			retiredAt: undefined,
		};
	}

	/**
	 * D6/D7: an item left the queue without spawning (timeout / stop / flush).
	 * The record becomes `retired`, nothing is spawned, nothing reaches the ledger.
	 */
	private abandonQueued(
		name: string,
		reason: "timeout" | "stopped" | "flushed",
		message: string,
	): ChildRecord | undefined {
		const guard = this.launchGuards.get(name);
		this.launchGuards.delete(name);
		const child = this.children.get(name);
		if (child && child.state === "queued") {
			child.state = "retired";
			child.retiredAt = new Date(this.now()).toISOString();
			child.queuePosition = undefined;
			this.onChildUpdate(child);
		}
		// `stopped` is announced by `retire()`, which owns that user-facing line, but
		// the waiter MUST still be settled: a `collect` blocked on `settled` would
		// otherwise hang forever after its item was stopped (D7/D8).
		if (reason !== "stopped") this.notice(message);
		guard?.settle({ kind: "rejected", reason, message });
		return child?.state === "retired" ? child : undefined;
	}

	/**
	 * D7 / A5: empty the queue without spawning anything.
	 *
	 * Called from the parent turn's abort path and from session shutdown. Returns
	 * the flushed names in `seq` order so the caller can report them.
	 */
	flushLaunchQueue(reason: string): string[] {
		const queue = this.existingAdmissionQueue();
		if (this.queueWatchdog) {
			clearTimeout(this.queueWatchdog);
			this.queueWatchdog = undefined;
		}
		if (!queue) return [];
		// The queue is shared with every other Orchestrator on this run dir, so a
		// flush must only clear what THIS instance can finish clearing: the items it
		// holds a guard for. Clearing a sibling's item would dequeue it without
		// settling the owner's guard or retiring the owner's record, leaving a
		// permanent `queued` zombie (and a `collect` that never returns). The owner's
		// own abort/flush path — or the D6 deadline — retires its items.
		const mine = queue.entries().filter((entry) => this.launchGuards.has(entry.name)).map((entry) => entry.name);
		if (mine.length === 0) return [];
		const removed = new Set<string>();
		for (const name of mine) {
			if (queue.remove(name)) removed.add(name);
		}
		const names: string[] = [];
		for (const item of queue.entries()) {
			// `entries()` is re-read below only to keep `seq` order for `removed`.
			void item;
		}
		for (const name of mine) {
			if (!removed.has(name)) continue;
			const child = this.children.get(name);
			if (child && child.state === "queued") {
				child.state = "retired";
				child.retiredAt = new Date(this.now()).toISOString();
				child.queuePosition = undefined;
				this.onChildUpdate(child);
			}
			const guard = this.launchGuards.get(name);
			this.launchGuards.delete(name);
			guard?.settle({ kind: "rejected", reason: "flushed", message: `launch queue flushed (${reason})` });
			this.notice(`launch queue flushed: ${name} (${reason})`);
			names.push(name);
		}
		return names;
	}

	/** D9: read-only snapshot of the queue (shared across instances via the registry). */
	launchQueueEntries(): readonly AdmissionQueueEntry[] {
		return this.existingAdmissionQueue()?.entries() ?? [];
	}

	/** D8: is `name` still waiting in a live queue of this process? */
	private isQueuedHere(name: string): boolean {
		const queue = this.existingAdmissionQueue();
		return queue !== undefined && queue.positionOf(name) !== undefined;
	}

	/**
	 * I-O3: `queued` records that need a spawned child.
	 *
	 * A record left over from a previous process can never become live again — the
	 * queue is in memory. Say that instead of `unknown child`, so the operator
	 * knows to re-dispatch. `retire()` is exempt: it may clean such an orphan up.
	 */
	private queuedStateMessage(name: string): string | undefined {
		const child = this.children.get(name);
		if (!child || child.state !== "queued") return undefined;
		return this.isQueuedHere(name) ? queuedNotStartedMessage(name) : launchQueueLostMessage(name);
	}

	/**
	 * D8/A12: block until a queued child leaves the queue.
	 *
	 * Prefers the enqueue-time `settled` promise (same Orchestrator instance). A
	 * control-action Orchestrator owns no guard, so it polls the record instead —
	 * never `parseSessionFile` / `waitSettled` on the placeholder path (D8), which
	 * would spin on a file that does not exist and report a fake result.
	 */
	private async waitForAdmission(
		child: ChildRecord,
		timeoutMs: number,
		signal?: AbortSignal,
	): Promise<AdmitOutcome> {
		const direct = this.launchGuards.get(child.name)?.settled;
		if (direct) {
			// The reservation has not started yet: keep the record truthful while we
			// wait, so a concurrent `status` reads the position, not `launching`.
			//
			// The bare await is NOT enough: `collect(name, { signal })` is a published
			// contract and every other branch of `collect` honours `signal`/deadline.
			// Admission may take the whole `launchQueueTimeoutMs` (15 min), so an abort
			// must be able to end this wait — otherwise `async:false` keeps the parent
			// turn blocked long after the caller gave up.
			return await this.waitForAdmissionOutcome(child, direct, timeoutMs, signal);
		}
		const deadline = this.now() + timeoutMs;
		for (;;) {
			if (signal?.aborted) {
				return {
					kind: "rejected",
					reason: "stopped",
					message: `aborted by parent while queued: '${child.name}'`,
				};
			}
			if (child.state !== "queued") {
				return { kind: "admitted", waitedMs: child.queueWaitedMs ?? 0 };
			}
			const remaining = deadline - this.now();
			if (remaining <= 0) {
				return {
					kind: "rejected",
					reason: "timeout",
					message: queueTimeoutMessage(child.name, this.now() - this.enqueuedAtFor(child.name)),
				};
			}
			if (await this.sleepOrAbort(Math.min(POLL_INTERVAL_MS, remaining), signal)) continue;
		}
	}

	/**
	 * Race an enqueue-time `settled` promise against abort and the local deadline.
	 *
	 * `settled` resolves at most once and has no cleanup, so losing the race is
	 * harmless: a later admission still settles it, and nothing here mutates the
	 * queue. The loser is left pending on purpose — cancelling it would have to
	 * dequeue the item, which is `stop`'s job, not `collect`'s.
	 */
	private async waitForAdmissionOutcome(
		child: ChildRecord,
		settled: Promise<AdmitOutcome>,
		timeoutMs: number,
		signal?: AbortSignal,
	): Promise<AdmitOutcome> {
		const aborted: AdmitOutcome = {
			kind: "rejected",
			reason: "stopped",
			message: `aborted by parent while queued: '${child.name}'`,
		};
		if (signal?.aborted) return aborted;
		const deadline = this.now() + timeoutMs;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let onAbort: (() => void) | undefined;
		try {
			return await new Promise<AdmitOutcome>((resolve) => {
				const finish = (outcome: AdmitOutcome): void => {
					if (timer !== undefined) clearTimeout(timer);
					if (onAbort && signal) signal.removeEventListener("abort", onAbort);
					resolve(outcome);
				};
				void settled.then(finish, () =>
					finish({ kind: "rejected", reason: "flushed", message: `launch queue lost: '${child.name}'` }));
				timer = setTimeout(() => {
					finish({
						kind: "rejected",
						reason: "timeout",
						message: queueTimeoutMessage(child.name, this.now() - this.enqueuedAtFor(child.name)),
					});
				}, Math.max(1, deadline - this.now()));
				timer.unref?.();
				if (signal) {
					onAbort = () => finish(aborted);
					signal.addEventListener("abort", onAbort, { once: true });
				}
			});
		} finally {
			if (timer !== undefined) clearTimeout(timer);
			if (onAbort && signal) signal.removeEventListener("abort", onAbort);
		}
	}

	/** Enqueue timestamp of a live queue item, for the timeout wording. */
	private enqueuedAtFor(name: string): number {
		const guard = this.launchGuards.get(name);
		if (guard) return guard.enqueuedAt;
		const waited = this.existingAdmissionQueue()?.waitedMs(name);
		return waited === undefined ? this.now() : this.now() - waited;
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
		this.refuseQueuedControl(name);
		await this.supervisor.steer(name, text);
		this.emitProcess("node_steered", child.nodeId ?? name, { name, text });
		this.clearBlocked(child);
	}

	async followUp(name: string, text: string): Promise<void> {
		const child = this.requireChild(name);
		this.refuseQueuedControl(name);
		await this.supervisor.followUp(name, text);
		this.clearBlocked(child);
	}

	async abort(name: string): Promise<void> {
		const child = this.requireChild(name);
		this.refuseQueuedControl(name);
		await this.supervisor.abort(name);
		this.emitProcess("node_aborted", child.nodeId ?? name, { name });
	}

	/**
	 * I-O3: `steer`/`followUp`/`abort` need a spawned child. A queued one has no
	 * process and no session, so say why instead of letting the supervisor answer
	 * `unknown child` (or, worse, address a placeholder path).
	 */
	private refuseQueuedControl(name: string): void {
		const message = this.queuedStateMessage(name);
		if (message) throw new SubagentError(message, ErrorCodes.BUDGET_EXCEEDED);
	}

	private requireChild(name: string): ChildRecord {
		const child = this.children.get(name);
		if (!child) throw unknownChildError(name);
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
		let child = this.requireChild(name);
		const timeoutMs = opts.timeoutMs ?? DEFAULTS.turnTimeoutMs;
		// D8/A12: a queued child has no session yet. Block until it is admitted
		// (then fall through to the normal path) or until it leaves the queue
		// without starting (timeout / stop / flush) — never `parseSessionFile` or
		// `waitSettled` on the placeholder path, which would spin on a file that
		// does not exist and report a fake outcome.
		if (child.state === "queued") {
			// I-O3: a `queued` record whose item is not in this process's queue is an
			// orphan from a previous process — it can never start, so say that rather
			// than waiting for a timeout that would hide the real reason.
			if (!this.isQueuedHere(name)) throw new SubagentError(launchQueueLostMessage(name), ErrorCodes.BUDGET_EXCEEDED);
			const admission = await this.waitForAdmission(child, timeoutMs, opts.signal);
			if (admission.kind === "rejected") {
				throw new SubagentError(admission.message, ErrorCodes.BUDGET_EXCEEDED);
			}
			// Admission REPLACES the placeholder record (`admitQueued` deletes it and
			// the real launch registers a new one). Reading further through the old
			// object would use its placeholder `sessionFile` — which for the legion
			// path is a DIFFERENT file than the spawned child's run-dir transcript, so
			// the outcome would be derived from a file nobody ever wrote.
			child = this.requireChild(name);
		}
		const abortedSnapshot = (): CollectResult => this.interruptedCollect(child, parseSessionFile(child.sessionFile));
		if (opts.signal?.aborted) return abortedSnapshot();
		if (this.pendingDialogs(name).length) return this.blockedResult(child);
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
		// #232: no settle-quiet wait here.
		//
		// `wait === "settled"` already means the supervisor observed the turn end
		// (`waitSettled` resolves on the settle event, not on a stat poll), and
		// callers only reach `collect()` after `cachedCollect()` found the child
		// finished. Re-polling `statSync(sessionFile).size` for `settleQuietMs`
		// (2500ms) after that confirmed terminal state produced no information: an
		// append-only transcript cannot grow once the turn is complete. It cost
		// ~2.0s of dead time per successful collect and scaled with fan-out width.
		//
		// The partial-write hazard the wait was guarding against is covered by the
		// re-parse below: `parseSessionFile` leaves a trailing partial line out of
		// its committed cache (#36), so a mid-write tail is never read as a verdict.
		if (opts.signal?.aborted) return abortedSnapshot();
		parsed = parseSessionFile(child.sessionFile);
		// #227 D5: a child whose process is gone cannot produce another message.
		// When its last turn already ended with a terminal assistant message there
		// is nothing left to wait for, so finish the completed turn here.
		//
		// This is defensive rather than an observable behaviour fix: the
		// collect-deadline branch below is already gated on `isAlive(name)`, so a
		// dead child never received the `running` snapshot. Keeping the guard makes
		// the intent explicit instead of relying on that coincidence — see D5 and
		// the disclosure in the #227 contract.
		if (wait === "timeout" && !this.supervisor.isAlive(name) && isLastTurnComplete(parsed)) {
			return this.finishCollect(child, parsed, deriveOutcome(parsed), deadline);
		}
		let execution = deriveOutcome(parsed);
		if (wait === "timeout" && this.supervisor.isAlive(name) && !isLastTurnComplete(parsed)) {
			// `timeoutMs` is measured from THIS collect call, not from the launch (D6).
			// The constant's "cumulative since launch" wording is legacy; see its
			// docstring for why it was left as-is.
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
	 *
	 * #232: the wait is a poll over an append-only file, so it watches the one
	 * cheap signal that changes first — the artifact size — and only pays for a
	 * `parseSessionFile` when that size moved. Unchanged artifacts reuse the
	 * previous parse. The poll interval also backs off geometrically
	 * (`POLL_INTERVAL_MS` → `TRANSIENT_POLL_CAP_MS`), so the default 900s deadline
	 * costs 229 stats (the seed stat plus 228 sleeps, one stat each) and a single
	 * parse instead of 1800 full parses. The backoff never shortens the wait:
	 * sleeps are clamped to the remaining budget and every iteration sleeps
	 * strictly > 0ms, so the loop cannot busy-spin.
	 *
	 * Accepted tradeoff, stated plainly because it is a real regression in
	 * observation latency: **this loop is the only detector for both the blip
	 * clearing and the child exiting while it holds** (per D2 the orchestrator
	 * does not subscribe to `onEvent`, and `waitSettled` has already returned
	 * `timeout` by the time we get here). So during the hold, an exit or a settle
	 * appended to the session is observed within one capped interval —
	 * up to `TRANSIENT_POLL_CAP_MS` (4s) — where the pre-#232 flat 500ms cadence
	 * observed it within 500ms. The same applies to a UI approval raising
	 * `pendingDialogs`. Nothing is dropped and no return value changes
	 * (`TRANSIENT_CONNECTION_REASON`, `"done"`); only the latency with which the
	 * loop notices grows, and it is bounded by the cap rather than by the
	 * deadline. This is the documented reason the cap is 4s and not larger.
	 *
	 * The seed below stats *before* parsing on purpose: an append landing between
	 * the two calls then makes the next `size !== parsedSize` comparison true
	 * (over-parse, safe). Parsing first would fold that append into `parsed` while
	 * `parsedSize` also saw it, so the loop would consider the file unchanged and
	 * never notice a recovery until the deadline expired.
	 */
	private async waitOutTransientConnection(
		child: ChildRecord,
		deadline: number,
		signal?: AbortSignal,
	): Promise<"aborted" | "blocked" | "done"> {
		let parsedSize = artifactSize(child.sessionFile);
		let parsed = parseSessionFile(child.sessionFile);
		let interval = POLL_INTERVAL_MS;
		for (;;) {
			if (signal?.aborted) return "aborted";
			if (this.pendingDialogs(child.name).length) return "blocked";
			if (!this.supervisor.isAlive(child.name)) return "done";
			if (!isTransientConnectionFailure(deriveOutcome(parsed))) return "done";
			const remaining = deadline - this.now();
			if (remaining <= 0) return "done";
			const sleptFrom = this.now();
			if (await this.sleepOrAbort(Math.min(interval, remaining), signal)) return "aborted";
			// A sleep dep that never advances the clock would make this loop a busy
			// spin; stop holding instead of hammering the filesystem.
			if (this.now() <= sleptFrom) return "done";
			const size = artifactSize(child.sessionFile);
			if (size !== parsedSize) {
				parsed = parseSessionFile(child.sessionFile);
				parsedSize = size;
			}
			interval = Math.min(interval * 2, TRANSIENT_POLL_CAP_MS);
		}
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

	/**
	 * Did the session artifact grow inside one `POLL_INTERVAL_MS` window?
	 *
	 * #232: this used to sleep the whole window and stat twice. The window is
	 * unchanged (a grace extension is still only granted to an artifact that is
	 * genuinely growing), but it is now sampled at `ARTIFACT_GROWTH_POLL_MS` and
	 * returns on the first observed growth. The sleeps stay on the injected
	 * `now`/`sleep` deps, so `test/perf/collect-latency.test.ts` can drive them
	 * on its virtual clock.
	 */
	private async collectArtifactGrowing(child: ChildRecord, signal?: AbortSignal): Promise<boolean> {
		const before = artifactSize(child.sessionFile);
		if (before <= 0 || signal?.aborted) return false;
		for (let waited = 0; waited < POLL_INTERVAL_MS; waited += ARTIFACT_GROWTH_POLL_MS) {
			if (await this.sleepOrAbort(Math.min(ARTIFACT_GROWTH_POLL_MS, POLL_INTERVAL_MS - waited), signal)) return false;
			if (artifactSize(child.sessionFile) > before) return true;
		}
		return false;
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
		if (child.state === "queued") {
			// D7: stopping a queued item is a pure dequeue — no spawn, no ledger row.
			// I-O3: an orphaned `queued` record from a previous process is retired the
			// same way; there is no queue entry left to remove.
			const queuedAt = this.enqueuedAtFor(name);
			this.existingAdmissionQueue()?.remove(name);
			this.abandonQueued(
				name,
				"stopped",
				`launch queue stopped ('${name}') after waiting ${Math.round((this.now() - queuedAt) / 1000)}s`,
			);
			child.state = "retired";
			child.retiredAt ??= new Date(this.now()).toISOString();
			child.queuePosition = undefined;
			this.onChildUpdate(child);
			this.emitProcess("node_retired", child.nodeId ?? name, { name });
			this.notice(`launch queue stopped: ${name}`);
			// D2-d-3: a dequeue can also free the *queue slot* the next item needed.
			this.schedulePump();
			return child;
		}
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
		// D2-d-3: retiring a child frees a slot. The in-process backend also emits
		// `onSlotReleased`, but that hook is wired by the supervisor's owner and the
		// rpc path emits nothing at all — so the orchestrator wakes its own pump on
		// the edge it just observed. `pumping` makes the duplicate wake harmless.
		this.schedulePump();
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
