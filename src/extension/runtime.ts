/**
 * Session-scoped runtime for live RPC children.
 *
 * Tool calls are short; child processes are not. This object lives for the
 * parent session so it can show running children, collect in the background,
 * and wake the parent when a turn finishes.
 */

import * as fs from "node:fs";
import {
	deliverCompletion,
	formatCompletionNotice,
	formatGroupedNotice,
	collectFailureInput,
	type SendMessageApi,
} from "./notify.ts";
import {
	DEFAULT_FLUSH_MS,
	DEFAULT_JOIN_MODE,
	JoinCoordinator,
	type JoinConfig,
} from "./join.ts";
import {
	createStatusBoard,
	type StatusStripStyle,
	type StatusVizSnapshot,
	formatBusyLabel,
	type StatusEntry,
	type StatusUi,
} from "../tui/status.ts";
import { progressFromSessionFile } from "../shared/progress.ts";
import { isTransientConnectionFailure } from "../shared/session.ts";
import { DEFAULTS, type AgentKind, type RetireOptions } from "../shared/types.ts";
import type {
	EventSubscriptionOptions,
	SupervisorEvent,
} from "../supervisor/types.ts";
import type { LegionEvent, LegionEventBus } from "./event-bus.ts";
import { LEGION_EVENT_TYPES } from "./event-bus.ts";
import { createDbEventSource, type DbEventSource } from "./event-bus.ts";
import { openLegionDb, type DatabaseSync } from "../legion/db.ts";
import { getSubtree } from "../legion/nodes.ts";
import { attachUsageTotals } from "../legion/usage.ts";
import type { TreeNodeSnapshot } from "../tui/tree-view.ts";

export interface CollectSnapshot {
	execution: { status: string; reason?: string };
	output: string;
	/** Full output persisted to disk; named in the notice so a truncated preview has a one-step recovery. */
	outputFile?: string;
	acceptance: {
		status: string;
		level?: string;
		pendingCriteria?: Array<{
			id: string;
			must: string;
			severity?: string;
		}>;
	};
	/** True when the child is alive but waiting on a tool approval. */
	blocked?: boolean;
}

export interface TrackedJobInput {
	name: string;
	runId: string;
	agent: string;
	sessionFile: string;
	spawnedAt?: number;
	timeoutMs: number;
	kind?: AgentKind;
	model?: string;
	thinking?: string | false;
	worktreeBranch?: string;
	/** Legion tree identity supplied by the host when the M2 ChildRecord is available. */
	nodeId?: string;
	parentId?: string | null;
	depth?: number;
	collect: (opts?: { signal?: AbortSignal }) => Promise<CollectSnapshot>;
	/** Live RPC process check. A connection blip is non-terminal only while this is true. */
	isAlive?: () => boolean;
	persist?: (snapshot: CollectSnapshot) => Promise<void>;
	/** Retire the RPC child after a terminal collect. Blocked children stay alive. */
	retire?: (opts?: RetireOptions) => Promise<void>;
	/**
	 * Called when collect reports a blocked child. `resume` rewatches after
	 * the parent approved or denied; `hold` keeps the widget up.
	 */
	handleBlocked?: (
		snapshot: CollectSnapshot,
	) => Promise<"resume" | "hold">;
}

export interface TrackedJob extends TrackedJobInput {
	spawnedAt: number;
	state: string;
	consumedByTool: boolean;
	notified: boolean;
	watching: boolean;
	generation: number;
	settledAt?: number;
	unsubscribeRpcEvents?: () => void;
	collectPromise?: Promise<CollectSnapshot>;
}

export interface LegionTreeIdentity {
	nodeId: string;
	parentId: string | null;
	depth: number;
	supervisorName?: string;
}

export interface SessionRuntimeDeps {
	sendMessage: SendMessageApi["sendMessage"];
	emitBusy?: (active: boolean, label?: string) => void;
	now?: () => number;
	refreshMs?: number;
	/** Shared extension-lifetime bus; all visual refreshes are driven through it. */
	eventBus?: LegionEventBus;
	/** Optional host snapshot; the host also owns the DB event source when it supplies this callback. */
	getTreeNodes?: () => readonly TreeNodeSnapshot[] | undefined;
	/** Optional name-to-tree mapping for live RPC jobs backed by M2 ChildRecord.nodeId. */
	getTreeIdentity?: (name: string) => LegionTreeIdentity | undefined;
	/** Open the live activity viewer for a node selected in the resident status widget. */
	onStatusNodeClick?: (nodeId: string) => void;
	/** Above-input strip style; the extension uses "railway", the default stays "tree". */
	statusStrip?: StatusStripStyle;
	/** Error hook for an optional PI_LEGION_DB feed. */
	onDbEventSourceError?: (error: unknown) => void;
	/**
	 * Adapter for coarse RPC observations. The index supplies only a bus-forwarding
	 * listener; text_delta remains disabled unless a live overlay opts in.
	 */
	subscribeSupervisorEvents?: (
		name: string,
		listener: (event: SupervisorEvent) => void,
		options?: EventSubscriptionOptions,
	) => () => void;
	/** Batching config; applied via setJoinConfig right after construction. */
	joinConfig?: JoinConfig;
}

const DEFAULT_REFRESH_MS = 500;
/** Fallback per-child timeout for wait(); index.ts passes the role value. */
const DEFAULT_WAIT_TIMEOUT_MS = DEFAULTS.turnTimeoutMs;

/** A wait() promise that must settle by the deadline. */
class WaitTimeoutError extends Error {}
const WAIT_INTERRUPTED = Symbol("wait interrupted");

/** Retire after collect unless the child is still waiting on the user. */
export function shouldRecycleAfterCollect(status: string): boolean {
	// `unknown` is terminal for old records without a structured outcome.
	// `running` means the child is still alive: collect deadline, or a
	// connection blip that must not be retired.
	return status !== "blocked" && status !== "running";
}

/** Pause before re-arming a thrown connection blip so a hot reject cannot spin. */
const TRANSIENT_CONNECTION_REARM_MS = 200;

function thrownText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export interface LiveChildStatusInput {
	name: string;
	state: string;
	agent?: string;
	kind?: string;
	sessionFile: string;
	execution?: {
		status: string;
		reason?: string;
		usage?: { input: number; output: number; cost: number } | null;
	};
	acceptance?: { status: string; level?: string };
	/** RPC process is still running. */
	alive: boolean;
	now?: number;
}

/** Milliseconds since the session JSONL was last written, when the file exists. */
export function lastJsonlEventAgeMs(sessionFile: string, now: number): number | undefined {
	if (!sessionFile) return undefined;
	try {
		return Math.max(0, now - fs.statSync(sessionFile).mtimeMs);
	} catch {
		return undefined;
	}
}

/** Quiet age at or above this is treated as a long silent stretch (P2a). */
export const LONG_QUIET_MS = 30_000;

/**
 * Lead line for a living child: process is up, session JSONL quiet for N seconds.
 * `ageMs` undefined means the session file is missing or unreadable.
 * Long quiet (>= {@link LONG_QUIET_MS}) adds `(living)` so 「活着但安静」reads first.
 */
export function formatAliveQuiet(ageMs: number | undefined): string {
	if (ageMs === undefined) return "alive · quiet unknown";
	const secs = Math.floor(ageMs / 1000);
	if (ageMs >= LONG_QUIET_MS) return `alive · quiet ${secs}s (living)`;
	return `alive · quiet ${secs}s`;
}

/** @deprecated Prefer {@link formatAliveQuiet}; kept for older call sites. */
export function formatLastEventAge(ageMs: number): string {
	return `last event ${Math.floor(ageMs / 1000)}s ago`;
}

/**
 * Collect-deadline / transient-connection / "still alive" reasons are progress
 * signals, not verdicts. Showing them next to quiet age steals the eye.
 */
export function isAliveProgressSignalReason(reason: string | undefined): boolean {
	if (!reason) return false;
	return /still alive|rpc child alive|transient connection/i.test(reason);
}

function persistedSnapshotIsStale(input: LiveChildStatusInput): boolean {
	if (!input.alive) return false;
	if (input.state === "retired" || input.state === "exited") return true;
	const execution = input.execution;
	if (!execution || execution.status === "running" || execution.status === "unknown") return false;
	return isTransientConnectionFailure(execution);
}

function formatExecutionStatusLine(
	alive: boolean,
	execution: { status: string; reason?: string },
): string {
	const label = alive ? "execution snapshot" : "execution";
	// Alive + progress-signal reason: status only — quiet age owns the liveness story.
	if (alive && isAliveProgressSignalReason(execution.reason)) {
		return `${label}: ${execution.status}`;
	}
	return `${label}: ${execution.status}${execution.reason ? ` (${execution.reason})` : ""}`;
}

/**
 * Status text for one child (`/legion status <name>` and `subagent status`).
 *
 * Living children lead with `alive · quiet Ns` so a long silent reasoning
 * stretch is obvious before any execution/acceptance snapshot. Progress-signal
 * reasons (collect deadline, transient connection) are omitted from the
 * snapshot line while alive so they do not steal attention from quiet age.
 * A retired or failed record left by a connection blip is not treated as
 * current state while the RPC process is still alive.
 */
export function renderLiveChildStatus(input: LiveChildStatusInput): string {
	const stale = persistedSnapshotIsStale(input);
	const state = stale ? "working" : input.state;
	const execution = stale
		? { status: "running", reason: "rpc child alive", usage: input.execution?.usage }
		: input.execution;
	const lines = [
		`${input.name} — state=${state} agent=${input.agent ?? "?"} kind=${input.kind ?? "?"}`,
	];
	if (input.alive) {
		const age = lastJsonlEventAgeMs(input.sessionFile, input.now ?? Date.now());
		lines.push(formatAliveQuiet(age));
	}
	// Quiet age first; path metadata after snapshots so old store lines stay below.
	const meta = [
		"supervisor=rpc",
		`session=${input.sessionFile}`,
	];
	if (execution) {
		lines.push(formatExecutionStatusLine(input.alive, execution));
		if (execution.usage) {
			lines.push(
				`usage: in=${execution.usage.input} out=${execution.usage.output} cost=${execution.usage.cost.toFixed(4)}`,
			);
		}
	}
	if (!stale && input.acceptance) {
		const acceptanceLabel = input.alive ? "acceptance snapshot" : "acceptance";
		lines.push(
			`${acceptanceLabel}: ${input.acceptance.status}${input.acceptance.level ? ` (${input.acceptance.level})` : ""}`,
		);
	}
	lines.push(...meta);
	if (stale) {
		const persistedExecution = input.execution
			? `execution=${input.execution.status}${input.execution.reason ? ` (${input.execution.reason})` : ""}`
			: "execution=absent";
		const persistedAcceptance = input.acceptance
			? `acceptance=${input.acceptance.status}${input.acceptance.level ? ` (${input.acceptance.level})` : ""}`
			: "acceptance=absent";
		lines.push(`persisted snapshot is stale: state=${input.state}, ${persistedExecution}, ${persistedAcceptance}`);
	}
	return lines.join("\n");
}

export interface WaitResult {
	name: string;
	/** Terminal snapshot (wait hit, or completed before the timeout). */
	snapshot?: CollectSnapshot;
	/** Still running when the timeout fired. */
	stillRunning?: boolean;
	/** The parent turn ended while this wait was pending; children still running. */
	interrupted?: boolean;
	/** Not tracked live and no finished cache (pre-validated upstream). */
	missing?: boolean;
}

interface NodeActivity {
	turn?: number;
	turnStartedAt?: number;
	/** Set when the in-flight turn settles; cleared by the next turn_start. */
	turnEndedAt?: number;
	tools: string[];
}

export interface SessionRuntime {
	bind(ctx: StatusUi): void;
	track(input: TrackedJobInput): TrackedJob;
	watch(name: string, opts?: { triggerTurn?: boolean }): void;
	/**
	 * Mark this result as belonging to an explicit `collect` tool call so the
	 * watcher will not also inject a completion message. Returns the shared
	 * collect promise when we are already tracking the child.
	 */
	consumeCollect(name: string): Promise<CollectSnapshot> | undefined;
	/** Abortable variant used by an in-flight collect tool call. */
	consumeCollectInterruptible(name: string, signal: AbortSignal): Promise<CollectSnapshot | undefined> | undefined;
	/** Invalidate an in-flight notification watch without dropping the job. */
	cancelWatch(name: string): void;
	rewatch(name: string, opts?: { triggerTurn?: boolean }): void;
	release(name: string): void;
	get(name: string): TrackedJob | undefined;
	activeJobs(): TrackedJob[];
	/** Immutable metadata snapshot for tree/custom UI consumers. */
	treeNodes(): TreeNodeSnapshot[];
	/** Current live widget rows, including any retained Legion tree facts. */
	statusEntries(): StatusEntry[];
	refreshUi(): void;
	/** Live visualization data (nodes + token-rate sampler) for the /legion view. */
	vizSnapshot(): StatusVizSnapshot;
	/** TUI hosting the status widget (unknown shape; used for overlay/focus checks). */
	statusTui(): unknown;
	/** Forward join config to the internal coordinator (settings wiring). */
	setJoinConfig(config: JoinConfig): void;
	/**
	 * Explicit wait: suppress auto-notify on the targets via consumedByTool
	 * and aggregate their results. A timeout restores auto-notify.
	 */
	wait(
		names: string[],
		opts?: { timeoutMs?: number; signal?: AbortSignal },
	): Promise<WaitResult[]>;
	/**
	 * Non-interactive shutdown: let in-flight collects finish before the
	 * caller retires whatever is still alive. Watches do not re-arm.
	 */
	drainBeforeShutdown(): Promise<void>;
	dispose(): void;
}

export function createSessionRuntime(deps: SessionRuntimeDeps): SessionRuntime {
	const now = deps.now ?? Date.now;
	const refreshMs = deps.refreshMs ?? DEFAULT_REFRESH_MS;
	const jobs = new Map<string, TrackedJob>();
	const finished = new Map<string, CollectSnapshot>();
	const board = createStatusBoard({
		onNodeClick: deps.onStatusNodeClick,
		...(deps.statusStrip ? { strip: deps.statusStrip } : {}),
	});
	const tree = new Map<string, TreeNodeSnapshot>();
	const activity = new Map<string, NodeActivity>();
	const eventOverrides = new Map<string, { ts: number; status?: TreeNodeSnapshot["status"]; phase?: string }>();
	let ledgerDb: DatabaseSync | undefined;
	let dbEventSource: DbEventSource | undefined;
	let timer: ReturnType<typeof setInterval> | undefined;
	let disposed = false;
	let draining = false;
	let drainPromise: Promise<void> | undefined;
	let busyRaised = false;

	// Smart join: batch completion notices per runId. The deliver sink merges
	// the buffered entries into ONE grouped message; an unbatched single-child
	// notice keeps the legacy "Background task …" format byte-for-byte (that
	// shape is asserted by pre-existing tests and muscle memory alike).
	let joinConfig: JoinConfig = deps.joinConfig ?? {
		mode: DEFAULT_JOIN_MODE,
		flushMs: DEFAULT_FLUSH_MS,
	};
	const join = new JoinCoordinator({
		deliver: (batch) => {
			if (disposed) return;
			const first = batch[0];
			if (!first) return;
			// A settled single-entry batch keeps the legacy "Background task …"
			// shape (asserted by pre-existing tests); a single entry flushed by
			// the WINDOW while stragglers are pending is a partial batch and
			// must use the grouped shape so the header can say "1 of N".
			// (mode "each" delivers immediately per member, so its single-entry
			// batches are never partial.)
			if (
				batch.length === 1 &&
				(joinConfig.mode === "each" || join.allSettled(first.runId))
			) {
				deliverCompletion(
					{ sendMessage: deps.sendMessage },
					formatCompletionNotice(first.input),
					first.triggerTurn,
				);
				return;
			}
			const triggerTurn = batch.some((e) => e.triggerTurn);
			// Partial flush: members of the same run still alive notify later.
			// consumedByTool members were just claimed by an explicit wait() —
			// the tool result carries them, so they are not "still running".
			const stillRunning = [...jobs.values()]
				.filter(
					(job) =>
						job.runId === first.runId &&
						job.state !== "retired" &&
						!job.consumedByTool &&
						!batch.some((e) => e.name === job.name),
				)
				.map((job) => job.name);
			deliverCompletion(
				{ sendMessage: deps.sendMessage },
				formatGroupedNotice({
					runId: first.runId,
					entries: batch.map((e) => ({ ...e.input, status: e.status })),
					...(stillRunning.length > 0 ? { stillRunning } : {}),
				}),
				triggerTurn,
			);
		},
	});
	join.setConfig(joinConfig);

	const snapshotNodes = (): TreeNodeSnapshot[] => {
		const ledger = ledgerDb;
		const provided = deps.getTreeNodes
			? deps.getTreeNodes()
			: ledger ? attachUsageTotals(ledger, getSubtree(ledger, "root")) : undefined;
		if (provided !== undefined) {
			tree.clear();
			for (const node of provided) {
				const override = eventOverrides.get(node.id);
				if (override && override.ts >= node.updatedAt) {
					tree.set(node.id, {
						...node,
						...(override.status === undefined ? {} : { status: override.status }),
						...(override.phase === undefined ? {} : { phase: override.phase }),
						updatedAt: override.ts,
					});
				} else {
					if (override) eventOverrides.delete(node.id);
					tree.set(node.id, { ...node });
				}
			}
			for (const nodeId of activity.keys()) if (!tree.has(nodeId)) activity.delete(nodeId);
			for (const nodeId of eventOverrides.keys()) if (!tree.has(nodeId)) eventOverrides.delete(nodeId);
		}
		return [...tree.values()].map((node) => ({ ...node }));
	};

	const storedNodeForJob = (
		job: TrackedJob,
		nodes: readonly TreeNodeSnapshot[],
	): TreeNodeSnapshot | undefined => {
		if (job.nodeId) return nodes.find((node) => node.id === job.nodeId);
		if (job.sessionFile) {
			const sessionMatches = nodes.filter((node) => node.sessionFile === job.sessionFile);
			if (sessionMatches.length === 1) return sessionMatches[0];
		}
		if (job.runId) {
			const runMatches = nodes.filter((node) => node.runId === job.runId && node.name === job.name);
			if (runMatches.length === 1) return runMatches[0];
		}
		const mapped = deps.getTreeIdentity?.(job.name);
		if (mapped?.nodeId) return nodes.find((node) => node.id === mapped.nodeId);
		const sameName = nodes.filter((node) => node.name === job.name);
		return sameName.length === 1 ? sameName[0] : undefined;
	};

	const identityForJob = (
		job: TrackedJob,
		storedNode?: TreeNodeSnapshot,
	): LegionTreeIdentity | undefined => {
		const provided = deps.getTreeIdentity?.(job.name);
		const nodeId = job.nodeId ?? provided?.nodeId ?? storedNode?.id;
		if (!nodeId) return undefined;
		return {
			nodeId,
			parentId: job.parentId ?? provided?.parentId ?? storedNode?.parentId ?? null,
			depth: job.depth ?? provided?.depth ?? storedNode?.depth ?? Math.max(0, nodeId.split(".").length - 1),
			supervisorName: provided?.supervisorName ?? job.name,
		};
	};

	const statusEntries = (): StatusEntry[] => {
		const nodes = snapshotNodes();
		const jobEntries = [...jobs.values()]
			.filter((job) => job.state !== "retired")
			.sort((a, b) => a.spawnedAt - b.spawnedAt)
			.map((job) => {
				const storedNode = storedNodeForJob(job, nodes);
				const mappedIdentity = deps.getTreeIdentity?.(job.name);
				const identity = job.nodeId || mappedIdentity?.nodeId || storedNode
					? identityForJob(job, storedNode)
					: undefined;
				return statusEntryFromJob(
					job,
					identity,
					storedNode,
					finished.get(job.name)?.execution.status,
				);
			});
		const seen = new Set(jobEntries.flatMap((entry) => entry.nodeId ? [entry.nodeId] : []));
		const persistedEntries: StatusEntry[] = [];
		for (const node of nodes) {
			if (seen.has(node.id)) continue;
			const details = activity.get(node.id);
			persistedEntries.push(statusEntryFromNode(node, details));
		}
		return [...persistedEntries, ...jobEntries].sort((left, right) =>
			(left.depth ?? 0) - (right.depth ?? 0) ||
			left.startedAt - right.startedAt ||
			left.name.localeCompare(right.name),
		);
	};

	const entries = statusEntries;

	const syncBusy = (list: StatusEntry[] = entries()): void => {
		const label = formatBusyLabel(list);
		if (label !== undefined) {
			deps.emitBusy?.(true, label);
			busyRaised = true;
			return;
		}
		if (busyRaised) {
			busyRaised = false;
			deps.emitBusy?.(false);
		}
	};

	const refreshUi = (): void => {
		if (disposed) return;
		const list = statusEntries();
		board.paint(list, now());
		syncBusy(list);
	};

	const applyTreeEvent = (event: LegionEvent): void => {
		const node = tree.get(event.nodeId);
		const data = event.data && typeof event.data === "object" && !Array.isArray(event.data)
			? event.data as Record<string, unknown>
			: undefined;
		if (node && event.ts >= node.updatedAt) {
			const previous = eventOverrides.get(event.nodeId);
			if (!previous || event.ts >= previous.ts) {
				const override = { ...previous, ts: event.ts };
				const updated = { ...node, updatedAt: event.ts };
				if (event.type === "node_launched" || event.type === "node_resumed") updated.status = override.status = "running";
				else if (event.type === "node_settled") updated.status = override.status = "settled";
				else if (event.type === "node_failed") updated.status = override.status = "failed";
				else if (event.type === "node_retired" && node.status !== "settled" && node.status !== "failed") updated.status = override.status = "retired";
				else if (event.type === "node_blocked") updated.status = override.status = "blocked";
				else if (event.type === "phase_change" && typeof data?.to === "string") updated.phase = override.phase = data.to;
				eventOverrides.set(event.nodeId, override);
				tree.set(event.nodeId, updated);
			}
		}
		if (event.type === "turn_start") {
			const current = activity.get(event.nodeId) ?? { tools: [] };
			current.turn = typeof data?.turn === "number" ? data.turn : (current.turn ?? 0) + 1;
			current.turnStartedAt = event.ts;
			current.turnEndedAt = undefined;
			activity.set(event.nodeId, current);
		} else if (event.type === "agent_settled") {
			// Freeze the turn at this event. The next turn_start replaces it.
			const current = activity.get(event.nodeId);
			if (current?.turnStartedAt !== undefined && current.turnEndedAt === undefined) {
				current.turnEndedAt = event.ts;
			}
		} else if (event.type === "tool_call") {
			const current = activity.get(event.nodeId) ?? { tools: [] };
			const toolName = typeof data?.toolName === "string" ? data.toolName : typeof data?.name === "string" ? data.name : undefined;
			if (toolName) current.tools = [...current.tools.slice(-1), toolName];
			activity.set(event.nodeId, current);
		}
	};

	const onWidgetEvent = (event: LegionEvent): void => {
		snapshotNodes();
		applyTreeEvent(event);
		refreshUi();
	};
	const busUnsubscribers = deps.eventBus
		? LEGION_EVENT_TYPES
			.filter((type) => type !== "text_delta")
			.map((type) => deps.eventBus!.on(type, onWidgetEvent))
		: [];

	if (process.env.PI_LEGION_DB && !deps.getTreeNodes) {
		try {
			ledgerDb = openLegionDb(process.env.PI_LEGION_DB);
			snapshotNodes();
			dbEventSource = createDbEventSource(ledgerDb, {
				onError: deps.onDbEventSourceError,
			});
			if (deps.eventBus) dbEventSource.start(deps.eventBus);
		} catch (error) {
			deps.onDbEventSourceError?.(error);
			ledgerDb?.close();
			ledgerDb = undefined;
			dbEventSource = undefined;
		}
	}

	if (!ledgerDb) snapshotNodes();

	const ensureTimer = (): void => {
		if (timer || jobs.size === 0 || disposed) return;
		timer = setInterval(() => refreshUi(), refreshMs);
		timer.unref?.();
	};

	const stopTimerIfIdle = (): void => {
		if (jobs.size > 0) return;
		if (timer) clearInterval(timer);
		timer = undefined;
	};

	const ensureCollect = (job: TrackedJob, signal?: AbortSignal): Promise<CollectSnapshot> => {
		if (!job.collectPromise) {
			const generation = job.generation;
			job.collectPromise = (async () => {
				const snapshot = await job.collect(signal ? { signal } : undefined);
				const current = jobs.get(job.name) === job && job.generation === generation;
				if (current) {
					try {
						await job.persist?.(snapshot);
					} catch {
						// Notification still happens; the tool-side persist is the backup.
					}
				}
				// C: a `running` snapshot is a timeout on a live child, not a result.
				// Caching it would let a later wait/collect hand out a stale
				// "still working" snapshot as if it were the final answer. Also do not
				// revive a result after an explicit stop invalidates this generation.
				if (
					current &&
					!snapshot.blocked &&
					snapshot.execution.status !== "running"
				) {
					finished.set(job.name, snapshot);
				}
				return snapshot;
			})();
		}
		return job.collectPromise;
	};

	/**
	 * Wait for one child. Shares the in-flight watch's collect promise, so a
	 * hit suppresses the auto-notify (consumedByTool stays set); a TIMEOUT
	 * restores consumedByTool so the watch notifies normally when it lands.
	 */
	const waitOne = async (
		name: string,
		timeoutMs: number,
		signal?: AbortSignal,
	): Promise<WaitResult> => {
		const job = jobs.get(name);
		if (!job) {
			const cached = finished.get(name);
			if (cached) return { name, snapshot: cached };
			return { name, missing: true };
		}
		job.consumedByTool = true;
		if (signal?.aborted) {
			job.consumedByTool = false;
			return { name, interrupted: true };
		}
		let timer: ReturnType<typeof setTimeout> | undefined;
		let removeAbortListener: (() => void) | undefined;
		try {
			const racers: Array<Promise<CollectSnapshot | typeof WAIT_INTERRUPTED>> = [
				ensureCollect(job, signal),
				new Promise<never>((_resolve, reject) => {
					// NOT unref'd: this timer may be the only thing driving the
					// caller's await; unref'd it could let the event loop drain
					// (and node:test abort the test) before the timeout fires.
					timer = setTimeout(
						() => reject(new WaitTimeoutError("wait timed out")),
						timeoutMs,
					);
				}),
			];
			if (signal) {
				racers.splice(1, 0, new Promise<typeof WAIT_INTERRUPTED>((resolve) => {
					const onAbort = () => resolve(WAIT_INTERRUPTED);
					removeAbortListener = () => signal.removeEventListener("abort", onAbort);
					if (signal.aborted) onAbort();
					else signal.addEventListener("abort", onAbort, { once: true });
				}));
			}
			const outcome = await Promise.race(racers);
			if (outcome === WAIT_INTERRUPTED) {
				// Esc / parent-turn abort does not retire children (esc-no-retire-v3).
				// Re-arm watch so settle still notifies the parent.
				job.consumedByTool = false;
				if (!job.watching) runtime.watch(name);
				return { name, interrupted: true };
			}
			const snapshot = outcome;
			if (
				snapshot.blocked ||
				!shouldRecycleAfterCollect(snapshot.execution.status)
			) {
				// Not terminal: keep the RPC child and let the watch flow handle it.
				job.consumedByTool = false;
				if (snapshot.blocked && !job.watching) {
					// Nobody is collecting anymore: the previous watch consumed
					// this blocked snapshot and went hold. Without a rewatch the
					// eventual completion would never surface.
					//
					// A merely-running snapshot needs no branch here: watch()
					// re-arms itself on it (the re-arm's collect is a FRESH call
					// that blocks until the next timeout, so it cannot spin on the
					// same snapshot). When no watch is in flight, wait() reports
					// stillRunning and the caller (or a later collect) decides.
					// Resume keeps the flag cleared on its own branch, so no
					// double-reset.
					job.collectPromise = undefined;
					job.notified = false;
					runtime.watch(name);
				}
				return { name, stillRunning: true };
			}
			if (jobs.get(name) === job) {
				try {
					await job.retire?.();
				} catch {
					// Recycle is best-effort; the snapshot is already in hand.
				}
				runtime.release(name);
			}
			return { name, snapshot };
		} catch (error) {
			if (error instanceof WaitTimeoutError) {
				// The watch is still in flight and shares this collect promise —
				// restore auto-notify or the result would never surface.
				job.consumedByTool = false;
				return { name, stillRunning: true };
			}
			throw error;
		} finally {
			removeAbortListener?.();
			if (timer) clearTimeout(timer);
		}
	};

	const runtime: SessionRuntime = {
		bind(next) {
			// The board is the only consumer of the UI handle; keep no second copy.
			board.bind(next);
			refreshUi();
		},

		track(input) {
			const treeIdentity = deps.getTreeIdentity?.(input.name);
			const identity = {
				...(input.nodeId !== undefined || treeIdentity?.nodeId === undefined ? {} : { nodeId: treeIdentity.nodeId }),
				...(input.parentId !== undefined || treeIdentity?.parentId === undefined ? {} : { parentId: treeIdentity.parentId }),
				...(input.depth !== undefined || treeIdentity?.depth === undefined ? {} : { depth: treeIdentity.depth }),
			};
			const existing = jobs.get(input.name);
			if (existing) {
				existing.collect = input.collect;
				existing.isAlive = input.isAlive;
				existing.persist = input.persist;
				existing.retire = input.retire;
				existing.timeoutMs = input.timeoutMs;
				existing.sessionFile = input.sessionFile;
				existing.agent = input.agent;
				existing.runId = input.runId;
				existing.kind = input.kind;
				existing.model = input.model;
				existing.thinking = input.thinking;
				existing.worktreeBranch = input.worktreeBranch;
				if (input.nodeId !== undefined || identity.nodeId !== undefined) existing.nodeId = input.nodeId ?? identity.nodeId;
				if (input.parentId !== undefined || identity.parentId !== undefined) existing.parentId = input.parentId ?? identity.parentId;
				if (input.depth !== undefined || identity.depth !== undefined) existing.depth = input.depth ?? identity.depth;
				existing.settledAt = undefined;
				existing.state = "working";
				join.addPending(input.runId, input.name);
				ensureTimer();
				refreshUi();
				return existing;
			}
			const job: TrackedJob = {
				...input,
				...identity,
				spawnedAt: input.spawnedAt ?? now(),
				state: "working",
				consumedByTool: false,
				notified: false,
				watching: false,
				generation: 0,
			};
			if (deps.subscribeSupervisorEvents) {
				job.unsubscribeRpcEvents = deps.subscribeSupervisorEvents(
					job.name,
					() => {},
					{},
				);
			}
			jobs.set(job.name, job);
			join.addPending(job.runId, job.name);
			ensureTimer();
			refreshUi();
			return job;
		},

		watch(name, opts = {}) {
			const job = jobs.get(name);
			if (!job || disposed) return;
			const triggerTurn = opts.triggerTurn !== false;
			const gen = (job.generation += 1);
			job.watching = true;
			job.state = "working";
			refreshUi();
			void (async () => {
				let snapshot: CollectSnapshot | undefined;
				let hold = false;
				const rearmLiveWatch = () => {
					// Not terminal. Clear the settled collect promise and watch
					// again. The next collect blocks until the deadline (or a
					// real settle), so this is not a busy loop.
					job.state = "working";
					job.settledAt = undefined;
					job.collectPromise = undefined;
					job.notified = false;
					job.consumedByTool = false;
					join.addPending(job.runId, job.name);
					runtime.watch(name, opts);
				};
				try {
					snapshot = await ensureCollect(job);
					if (disposed || job.generation !== gen) return;
					// Print/json shutdown is waiting on this collect. A timeout or
					// a blocked child must stay tracked so the caller can retire
					// it; re-arming would start another turn after the process
					// has already decided to exit.
					if (draining && !shouldRecycleAfterCollect(snapshot.execution.status)) {
						hold = true;
						job.watching = false;
						return;
					}
					if (snapshot.blocked) {
						job.state = "blocked";
						refreshUi();
						const next =
							(await job.handleBlocked?.(snapshot)) ?? "hold";
						if (disposed || job.generation !== gen) return;
						if (next === "resume") {
							job.settledAt = undefined;
							job.collectPromise = undefined;
							job.notified = false;
							job.consumedByTool = false;
							job.state = "working";
							join.addPending(job.runId, job.name);
							runtime.watch(name, opts);
							return;
						}
						hold = true;
						job.watching = false;
						return;
					}
					if (snapshot.execution.status === "running") {
						// Not terminal: collect deadline, or a connection blip, on a
						// live child (F29 discriminator, extended for connection
						// errors). A notice here would misreport "failed", and a
						// release would orphan the child. Re-arm instead.
						//
						// Same skeleton as the blocked-resume branch above, but NOT
						// handleBlocked: there is no approval to ask about.
						rearmLiveWatch();
						return;
					}
					job.state = "awaiting";
					job.settledAt = now();
					if (!job.consumedByTool && !job.notified) {
						job.notified = true;
						join.onTerminal({
							runId: job.runId,
							name: job.name,
							input: {
								name: job.name,
								agent: job.agent,
								execution: snapshot.execution,
								output: snapshot.output,
								...(snapshot.outputFile ? { outputFile: snapshot.outputFile } : {}),
								sessionFile: job.sessionFile,
								acceptance: snapshot.acceptance,
								recycled: shouldRecycleAfterCollect(
									snapshot.execution.status,
								),
							},
							triggerTurn,
						});
					}
				} catch (error) {
					if (disposed || job.generation !== gen) return;
					if (job.isAlive?.() && isTransientConnectionFailure(thrownText(error))) {
						// Thrown "Connection error." while the process is up is the
						// same non-terminal signal as a running snapshot. Hold this
						// generation so `finally` cannot retire it, pause so a
						// reject that never awaits cannot spin, then re-arm.
						hold = true;
						job.state = "working";
						job.settledAt = undefined;
						job.collectPromise = undefined;
						job.notified = false;
						job.consumedByTool = false;
						join.addPending(job.runId, job.name);
						refreshUi();
						await new Promise((resolve) => setTimeout(resolve, TRANSIENT_CONNECTION_REARM_MS));
						if (disposed || job.generation !== gen) return;
						if (job.isAlive?.()) {
							rearmLiveWatch();
							return;
						}
						hold = false;
					}
					job.state = "awaiting";
					job.settledAt = now();
					if (!job.consumedByTool && !job.notified) {
						job.notified = true;
						// Collect failures join the batch too, as a failed entry.
						join.onTerminal({
							runId: job.runId,
							name: job.name,
							input: collectFailureInput(job.name, error),
							triggerTurn,
						});
					}
				} finally {
					if (job.generation === gen && !hold) {
						if (
							snapshot &&
							!snapshot.blocked &&
							shouldRecycleAfterCollect(snapshot.execution.status)
						) {
							try {
								await job.retire?.();
							} catch {
								// Recycle is best-effort; the completion notice already fired.
							}
						}
						job.watching = false;
						runtime.release(name);
					}
				}
			})();
		},

		consumeCollect(name) {
			const job = jobs.get(name);
			if (job) {
				job.consumedByTool = true;
				return ensureCollect(job);
			}
			const cached = finished.get(name);
			if (cached) return Promise.resolve(cached);
			return undefined;
		},

		consumeCollectInterruptible(name, signal) {
			const job = jobs.get(name);
			if (!job) {
				const cached = finished.get(name);
				return cached ? Promise.resolve(cached) : undefined;
			}
			job.consumedByTool = true;
			if (signal.aborted) {
				job.consumedByTool = false;
				return Promise.resolve(undefined);
			}
			const pending = ensureCollect(job, signal);
			return new Promise<CollectSnapshot | undefined>((resolve, reject) => {
				let done = false;
				const cleanup = () => signal.removeEventListener("abort", onAbort);
				const onAbort = () => {
					if (done) return;
					done = true;
					cleanup();
					if (jobs.get(name) === job) {
						job.consumedByTool = false;
					}
					resolve(undefined);
				};
				signal.addEventListener("abort", onAbort, { once: true });
				if (signal.aborted) onAbort();
				pending.then(
					(snapshot) => {
						if (done) return;
						done = true;
						cleanup();
						resolve(snapshot);
					},
					(error: unknown) => {
						if (done) return;
						done = true;
						cleanup();
						reject(error);
					},
				);
			});
		},

		cancelWatch(name) {
			const job = jobs.get(name);
			if (!job) return;
			job.generation += 1;
			job.watching = false;
			job.consumedByTool = false;
			refreshUi();
		},

		rewatch(name, opts) {
			const job = jobs.get(name);
			if (!job || disposed) return;
			job.notified = false;
			job.consumedByTool = false;
			job.collectPromise = undefined;
			job.settledAt = undefined;
			job.state = "working";
			finished.delete(name);
			join.addPending(job.runId, job.name);
			runtime.watch(name, opts);
		},

		release(name) {
			const job = jobs.get(name);
			if (!job || !jobs.delete(name)) return;
			// Invalidate any in-flight watch before its collect can deliver a stale
			// completion or overwrite a terminal state after explicit stop/retire.
			job.generation += 1;
			job.watching = false;
			job.unsubscribeRpcEvents?.();
			job.unsubscribeRpcEvents = undefined;
			join.remove(name);
			stopTimerIfIdle();
			refreshUi();
		},

		get(name) {
			return jobs.get(name);
		},

		activeJobs() {
			return [...jobs.values()];
		},

		statusTui() {
			return board.getTui?.();
		},
		vizSnapshot() {
			return board.vizSnapshot!(now());
		},

		treeNodes() {
			const result = snapshotNodes();
			for (const job of jobs.values()) {
				if (job.state === "retired") continue;
				const storedNode = storedNodeForJob(job, result);
				const mappedIdentity = deps.getTreeIdentity?.(job.name);
				const hasStableIdentity = Boolean(job.nodeId || mappedIdentity?.nodeId || storedNode);
				if (!hasStableIdentity) continue;
				const resolvedIdentity = identityForJob(job, storedNode);
				if (!resolvedIdentity) continue;
				const index = result.findIndex((node) => node.id === resolvedIdentity.nodeId);
				const previous = index >= 0 ? result[index] : undefined;
				const executionStatus = finished.get(job.name)?.execution.status;
				const status = job.state === "blocked"
					? "blocked"
					: job.state === "awaiting"
						? executionStatus === "success" ? "settled"
							: executionStatus === "failed" || executionStatus === "truncated" || executionStatus === undefined ? "failed"
								: "retired"
						: "running";
				const updatedAt = previous && job.settledAt !== undefined
					? Math.max(previous.updatedAt, job.settledAt)
					: job.settledAt ?? now();
				const next: TreeNodeSnapshot = previous
					? { ...previous, status, model: job.model ?? previous.model, updatedAt }
					: {
						id: resolvedIdentity.nodeId,
						parentId: resolvedIdentity.parentId,
						name: job.name,
						role: job.agent,
						kind: job.kind ?? "pi",
						depth: resolvedIdentity.depth,
						runId: null,
						sessionFile: job.sessionFile || null,
						worktreePath: null,
						model: job.model ?? null,
						team: null,
						status,
						phase: null,
						phaseSince: null,
						reworkCount: 0,
						contractPath: null,
						taskSummary: null,
						createdAt: job.spawnedAt,
						updatedAt,
					};
				if (index >= 0) result[index] = next;
				else result.push(next);
			}
			return result;
		},

		statusEntries() {
			return statusEntries();
		},

		refreshUi,

		setJoinConfig(config) {
			joinConfig = config;
			join.setConfig(config);
		},

		async wait(names, opts = {}) {
			return Promise.all(
				names.map((name) =>
					waitOne(name, opts.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS, opts.signal),
				),
			);
		},

		drainBeforeShutdown() {
			if (disposed) return Promise.resolve();
			if (drainPromise) return drainPromise;
			draining = true;
			const pending = [...jobs.values()];
			drainPromise = (async () => {
				await Promise.all(pending.map(async (job) => {
					try {
						await ensureCollect(job);
					} catch {
						// The watch records the failure; shutdown still retires the child.
					}
				}));
				// The watch continuation shares this collect and must observe
				// `draining` before the caller snapshots the jobs it will retire.
				await new Promise<void>((resolve) => setImmediate(resolve));
			})();
			return drainPromise;
		},

		dispose() {
			if (disposed) return;
			disposed = true;
			for (const job of jobs.values()) job.unsubscribeRpcEvents?.();
			jobs.clear();
			finished.clear();
			join.dispose();
			if (timer) clearInterval(timer);
			timer = undefined;
			for (const unsubscribe of busUnsubscribers) unsubscribe();
			dbEventSource?.stop();
			ledgerDb?.close();
			ledgerDb = undefined;
			board.clear();
			if (busyRaised) {
				busyRaised = false;
				deps.emitBusy?.(false);
			}
		},
	};

	return runtime;
}


/** Latest visible activity ms across tree / session / turn clocks. */
function latestActivityAt(...candidates: Array<number | undefined>): number | undefined {
	let best: number | undefined;
	for (const value of candidates) {
		if (value === undefined || !Number.isFinite(value)) continue;
		best = best === undefined ? value : Math.max(best, value);
	}
	return best;
}

function statusEntryFromJob(
	job: TrackedJob,
	identity?: LegionTreeIdentity,
	node?: TreeNodeSnapshot,
	executionStatus?: string,
): StatusEntry {
	const live = progressFromSessionFile(job.sessionFile);
	const model = live.model ?? job.model ?? node?.model ?? undefined;
	const thinking = job.thinking;
	const terminalNode = node && (node.status === "settled" || node.status === "failed" || node.status === "retired");
	const state = job.state !== "awaiting"
		? job.state
		: terminalNode ? node.status
			: executionStatus === "success" ? "settled"
				: executionStatus === "failed" || executionStatus === "truncated" || executionStatus === undefined ? "failed"
					: "retired";
	const finishedAt = terminalNode ? node.updatedAt : job.settledAt;
	const lastActivityAt = latestActivityAt(
		node?.updatedAt,
		live.currentTurnStartedAt,
		live.currentTurnEndedAt,
		finishedAt,
	);
	return {
		name: job.name,
		agent: job.agent,
		state,
		startedAt: node?.createdAt ?? job.spawnedAt,
		...(finishedAt !== undefined ? { finishedAt } : {}),
		...(node?.phase ? { phase: node.phase } : {}),
		...(job.kind ? { kind: job.kind } : {}),
		...(model ? { model } : {}),
		...(thinking !== undefined ? { thinking } : {}),
		...(job.worktreeBranch ? { worktreeBranch: job.worktreeBranch } : {}),
		...(live.turns ? { turns: live.turns } : {}),
		...(live.lastTools?.length ? { lastTools: live.lastTools } : {}),
		...(live.currentTurnStartedAt !== undefined
			? { currentTurnStartedAt: live.currentTurnStartedAt }
			: {}),
		...(live.currentTurnEndedAt !== undefined
			? { currentTurnEndedAt: live.currentTurnEndedAt }
			: {}),
		...(live.usageTotal
			? { tokensTotal: live.usageTotal }
			: node?.tokensTotal ? { tokensTotal: node.tokensTotal } : {}),
		...(live.tokensOut
			? { tokensOut: live.tokensOut }
			: node?.tokensOut ? { tokensOut: node.tokensOut } : {}),
		...(live.generationMs ? { generationMs: live.generationMs } : {}),
		...(lastActivityAt !== undefined ? { lastActivityAt } : {}),
		...(identity ? {
			nodeId: identity.nodeId,
			parentId: identity.parentId,
			depth: identity.depth,
		} : {}),
	};
}

function statusEntryFromNode(
	node: TreeNodeSnapshot,
	activity?: NodeActivity,
): StatusEntry {
	const lastActivityAt = latestActivityAt(
		node.updatedAt,
		activity?.turnStartedAt,
		activity?.turnEndedAt,
	);
	return {
		name: node.name,
		agent: node.role,
		state: node.status,
		startedAt: node.createdAt,
		...(node.status === "settled" || node.status === "failed" || node.status === "retired"
			? { finishedAt: node.updatedAt }
			: {}),
		...(node.phase ? { phase: node.phase } : {}),
		...(node.kind ? { kind: node.kind } : {}),
		...(node.model ? { model: node.model } : {}),
		...(node.tokensTotal ? { tokensTotal: node.tokensTotal } : {}),
		...(node.tokensOut ? { tokensOut: node.tokensOut } : {}),
		...(activity?.turn !== undefined ? { turns: activity.turn } : {}),
		...(activity?.turnStartedAt !== undefined ? { currentTurnStartedAt: activity.turnStartedAt } : {}),
		...(activity?.turnEndedAt !== undefined ? { currentTurnEndedAt: activity.turnEndedAt } : {}),
		...(activity?.tools.length ? { lastTools: activity.tools } : {}),
		...(lastActivityAt !== undefined ? { lastActivityAt } : {}),
		nodeId: node.id,
		parentId: node.parentId,
		depth: node.depth,
	};
}
