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
	type CompletionNotice,
	type SendMessageApi,
} from "./notify.ts";
import {
	DEFAULT_FLUSH_MS,
	DEFAULT_JOIN_MODE,
	JoinCoordinator,
	type JoinConfig,
	type JoinSchedulerHandle,
} from "./join.ts";
import {
	createStatusBoard,
	type StatusStripStyle,
	type StatusVizSnapshot,
	activeEntries,
	formatBusyLabel,
	type StatusEntry,
	type StatusUi,
	type WidgetTui,
} from "../tui/status.ts";
import { progressFromSessionFile } from "../shared/progress.ts";
import { readProcRss } from "../supervisor/proc-memory.ts";
import { isTransientConnectionFailure } from "../shared/session.ts";
import { isTerminalState, liveness } from "./liveness.ts";
import {
	DEFAULTS,
	type AgentKind,
	type RetireOptions,
	type SpawnMode,
} from "../shared/types.ts";
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
import { maxEventId } from "../legion/events.ts";
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
	/**
	 * Arbitrated backend for this child (`Handle.spawnMode`, #209). Optional:
	 * a job tracked from a legacy record has no value and must render as
	 * unknown rather than a guessed `rpc`.
	 */
	spawnMode?: SpawnMode;
	/**
	 * OS process of an `rpc` child (`Handle.pid`), for the memory probe only.
	 * Optional: an `inprocess` child has no process of its own, and a legacy
	 * record has no value. Never persisted — a pid is host-scoped.
	 */
	pid?: number;
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
	/**
	 * Raise/clear parent busy. When active, `children` lists live child slugs for
	 * hierarchical OSC ids (`legion/<slug>`). Cleared with `active=false`.
	 */
	emitBusy?: (active: boolean, label?: string, children?: readonly string[]) => void;
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
	/** Injectable timer for the MAX_PENDING_AGE_MS overflow (tests fire it manually); default = unref'd setTimeout. */
	scheduleNoticeOverflow?: (ms: number, fn: () => void) => JoinSchedulerHandle;
}

const DEFAULT_REFRESH_MS = 500;
/**
 * How long a ledger heartbeat stays trustworthy (D3/D7).
 *
 * Mirrors `DEFAULT_ORPHAN_STALE_MS` in `legion-tools.ts` and the `orphanStaleMs`
 * setting default (`src/shared/types.ts`). Duplicated as a literal on purpose:
 * the TUI refresh path must not read settings on every repaint, and this value is
 * the horizon for "a row that stopped heartbeating", which is exactly the orphan
 * definition. Keep the three in sync.
 */
const DEFAULT_ORPHAN_STALE_MS = 90_000;
/**
 * Hard cap on how long a completion notice may stay hidden behind a live
 * parent agent run (D-B). 80s = 2× the (1+3)×10s that the old join window
 * could reach while a busy parent kept extending it. Past this the notice is
 * force-sent even though the run is still going: reverting to the old
 * "queued as a followUp" behaviour after 80s is better than hiding it forever.
 */
export const MAX_PENDING_AGE_MS = 80_000;
/** Fallback per-child timeout for wait(); index.ts passes the role value. */
const DEFAULT_WAIT_TIMEOUT_MS = DEFAULTS.turnTimeoutMs;

/** Default timer for the MAX_PENDING_AGE_MS overflow (unref'd, like join's). */
function defaultNoticeOverflow(
	ms: number,
	fn: () => void,
): JoinSchedulerHandle {
	const id = setTimeout(fn, ms);
	id.unref?.();
	return { cancel: () => clearTimeout(id) };
}

/** A completion notice held because the parent agent run is still active (D-A). */
interface QueuedNotice {
	notice: CompletionNotice;
	triggerTurn: boolean;
	enqueuedAt: number;
}

export interface NoticeQueueStats {
	/** Notices currently held. */
	pending: number;
	/** now() - enqueuedAt of the oldest held notice; 0 when empty. */
	oldestAgeMs: number;
	/** Lifetime count of MAX_PENDING_AGE_MS overflows that forced a send (D-B observability). */
	forcedFlushes: number;
}

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
	/**
	 * Backend the child was actually spawned on (#209). Absent for records written
	 * before run.json carried it, and for tree-only fallbacks — renders `unknown`,
	 * never a guessed `rpc`.
	 */
	spawnMode?: string;
	/** RPC process is still running. */
	alive: boolean;
	/**
	 * Run-dir ownership verdict (#209-3), from `owner.json`.
	 * `alive` is this process's in-memory child registry, which never contains
	 * a child launched by another session — so a foreign record must be judged
	 * by the owner marker instead. Only consulted when `alive` is false.
	 */
	owner?: "live" | "dead" | "unknown";
	/**
	 * Own OS process of an `rpc` child (`Handle.pid`), when this session owns it.
	 *
	 * Only a pid of THIS host is ever supplied — pids are not persisted, so a
	 * record from a previous session has none. `inprocess` children have none by
	 * definition: they share this process.
	 */
	pid?: number;
	/**
	 * Context size of the last assistant message. Explicit override; otherwise
	 * derived from `sessionFile` through `progressFromSessionFile` — the same
	 * `accumulateUsage` source of truth the widget reads.
	 */
	contextTokens?: number;
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

/** One-line ownership verdict appended to a status block (#209-3). */
function ownerLine(owner: "live" | "dead" | "unknown"): string {
	if (owner === "dead") return "owner: dead (pid gone)";
	return `owner: ${owner}`;
}

/** Compact token count: `950`, `24.3K`, `1.4M` — absolute, never a percentage. */
export function formatContextTokens(value: number): string {
	if (!Number.isFinite(value) || value <= 0) return "0";
	const unit = value >= 1_000_000 ? "M" : value >= 1_000 ? "K" : "";
	const divisor = unit === "M" ? 1_000_000 : unit === "K" ? 1_000 : 1;
	if (!unit) return String(Math.round(value));
	return `${(value / divisor).toFixed(1).replace(/\.0$/, "")}${unit}`;
}

/** Context size of the child's own session, when it has one to read. */
function contextTokensFor(sessionFile: string): number | undefined {
	if (!sessionFile) return undefined;
	const live = progressFromSessionFile(sessionFile);
	return live.contextTokens;
}

/**
 * Memory line for one child, following D2: only an `rpc` child owns a process,
 * so only it gets a per-child RSS. An `inprocess` child runs INSIDE this host
 * process — apportioning the host RSS across children would be invented data,
 * so it reports the shared host figure and says so.
 *
 * A memory figure describes a process that is running NOW, so a child that the
 * liveness check reports gone gets no line at all (§6). Its pid may already
 * belong to an unrelated process: reading `/proc/<pid>` then would print a
 * stranger's RSS under this child's name — fabricated attribution that looks
 * real, the exact thing D2 forbids. v1 keeps no last-known cache, so there is
 * nothing honest left to show.
 *
 * `undefined` when there is nothing honest to print (child not alive, no pid,
 * non-Linux host, pid already gone).
 */
function memoryLine(input: LiveChildStatusInput): string | undefined {
	// §6 pid-reuse race: never probe a pid whose process is already gone.
	if (!input.alive) return undefined;
	if (input.spawnMode === "inprocess") {
		const host = readProcRss(process.pid);
		if (!host) return undefined;
		return `memory: host rss=${host.rssMb}m (shared by inprocess children)`;
	}
	if (input.pid === undefined) return undefined;
	const own = readProcRss(input.pid);
	if (!own) return undefined;
	return `memory: rss=${own.rssMb}m${own.peakMb !== undefined ? ` peak=${own.peakMb}m` : ""}`;
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
	// #209-3: a persisted `working` snapshot whose run-dir owner pid is gone is
	// dead, not working. `stale` (alive process + retired/failed snapshot) keeps
	// owning the opposite direction, so the two never fight over one record.
	const ownerDead = input.owner === "dead" && !input.alive;
	const state = stale
		? "working"
		: ownerDead && input.state === "working"
			? "failed"
			: input.state;
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
	// After the liveness lead: who owns the run dir, and whether that pid is gone.
	if (input.owner !== undefined) lines.push(ownerLine(input.owner));
	// Quiet age first; path metadata after snapshots so old store lines stay below.
	const meta = [
		`supervisor=${input.spawnMode ?? "unknown"}`,
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
	// Live resource facts. Appended as their own lines: every line above keeps
	// its text and position, so existing readers of this block stay valid.
	const contextTokens = input.contextTokens ?? contextTokensFor(input.sessionFile);
	if (contextTokens !== undefined) lines.push(`context: ctx=${formatContextTokens(contextTokens)} tok`);
	const memory = memoryLine(input);
	if (memory) lines.push(memory);
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
	/**
	 * True when this wait hit its per-child timeout (vs a non-terminal
	 * collect snapshot). Used by waitAction to label status `wait_timeout`.
	 */
	timedOut?: boolean;
	/** Wall-clock ms since the tracked job was spawned (for parent decide UX). */
	elapsedMs?: number;
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
	/** TUI hosting the status widget (used for overlay/focus checks). */
	statusTui(): WidgetTui | undefined;
	/** Forward join config to the internal coordinator (settings wiring). */
	setJoinConfig(config: JoinConfig): void;
	/** Parent agent run started (pi `agent_start`): hold completion notices until settle (D-A/D-C). */
	notifyParentRunStart(): void;
	/** Parent agent run settled (pi `agent_settled`): send every held notice now, then repaint (D-A/D-D). */
	notifyParentSettled(): void;
	/** Introspection seam for tests/doctor: deferred-notice queue state (D-B observability). */
	noticeQueueStats(): NoticeQueueStats;
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

	// Run-scoped completion outbox (D-A). The host only drains
	// `agent.followUpQueue` inside a live run, so a `followUp` sent while the
	// parent run is active sits invisible until the user types again. When a
	// run is active we therefore hold the formatted notice here and burst it
	// out on `agent_settled` (D-D). This is the ONLY deferral point: the join
	// window above batches stragglers and never waits on a busy parent (D-I).
	//
	// D-H: the default is `false`, so a host (or a test) that never signals a
	// run start keeps today's immediate-send behaviour byte for byte.
	let parentRunActive = false;
	const outbox: QueuedNotice[] = [];
	let outboxTimer: JoinSchedulerHandle | undefined;
	let forcedFlushes = 0;

	const armOutboxTimer = (): void => {
		if (outboxTimer || outbox.length === 0 || disposed) return;
		const oldest = outbox[0]!;
		const delay = Math.max(0, oldest.enqueuedAt + MAX_PENDING_AGE_MS - now());
		// `live` proves this callback is the CURRENT arm. A cancelled-but-still-
		// invoked timer (a zombie queued before the cancel landed) must be a strict
		// no-op: otherwise it would clear the live timer's handle and force-send a
		// notice that is nowhere near its cap.
		//
		// A boolean — not a closure over the handle — because an injected scheduler
		// is free to invoke the callback synchronously, before the `const` binding
		// is initialized (TDZ). `live` is assigned above the call, so it is always
		// safe to read from inside the callback.
		let live = true;
		const handle: JoinSchedulerHandle = (deps.scheduleNoticeOverflow ?? defaultNoticeOverflow)(delay, () => {
			if (!live) return;
			live = false;
			outboxTimer = undefined;
			if (outbox.length === 0) return;
			const next = outbox[0]!;
			if (now() < next.enqueuedAt + MAX_PENDING_AGE_MS) {
				// Fired while the oldest notice is still younger than the cap (a
				// coarse timer or a backwards clock step). Never force-send early:
				// re-arm for the remaining age instead.
				armOutboxTimer();
				return;
			}
			forcedFlushes += 1;
			flushOutbox();
		});
		outboxTimer = {
			cancel: () => {
				live = false;
				handle.cancel();
			},
		};
	};

	// FIFO, one message per notice: the grouped shape belongs to the join layer.
	// N held notices = N host `_runAgentPrompt` calls; the common case is 1 per
	// run, so the batch is not merged into a synthetic grouped notice.
	const flushOutbox = (): void => {
		outboxTimer?.cancel();
		outboxTimer = undefined;
		if (outbox.length === 0) return;
		// One splice: anything enqueued by a re-entrant send belongs to the next
		// batch, so a settle can never double-deliver what it already flushed.
		const batch = outbox.splice(0);
		for (const item of batch) {
			// A rejected send is dropped, not requeued (same as before).
			deliverCompletion(
				{ sendMessage: deps.sendMessage },
				item.notice,
				item.triggerTurn,
			);
		}
	};

	/** The single completion exit: send now, or hold until the run settles. */
	const sendCompletionNotice = (
		notice: CompletionNotice,
		triggerTurn: boolean,
	): void => {
		if (!parentRunActive) {
			deliverCompletion({ sendMessage: deps.sendMessage }, notice, triggerTurn);
			return;
		}
		outbox.push({ notice, triggerTurn, enqueuedAt: now() });
		armOutboxTimer();
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
				sendCompletionNotice(
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
			sendCompletionNotice(
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

	/**
	 * D3/D8: the orphan horizon, matching `legion-tools.ts`'s DEFAULT_ORPHAN_STALE_MS.
	 *
	 * `runtime.ts` has no settings dependency (the TUI layer must not read
	 * settings per repaint), so this mirrors the documented default. A ledger row
	 * whose heartbeat is older than this cannot describe a live child.
	 */
	const orphanStaleMs = (): number => DEFAULT_ORPHAN_STALE_MS;

	/**
	 * D3/D8: the in-process facts for a node, keyed by tree id.
	 *
	 * A tracked job is both the strongest liveness evidence (rules 1/2: this very
	 * process holds the handle) and the scheduler record. Resolved once per node
	 * rather than by scanning `jobs` twice.
	 */
	const inProcessFactsFor = (
		nodeId: string,
	): { inMemory?: { state: string }; record?: { state: string } } => {
		for (const job of jobs.values()) {
			if (job.state === undefined) continue;
			const matches =
				job.nodeId === nodeId ||
				(job.nodeId === undefined && deps.getTreeIdentity?.(job.name)?.nodeId === nodeId);
			if (matches) return { inMemory: { state: job.state }, record: { state: job.state } };
		}
		return {};
	};

	const snapshotNodes = (): TreeNodeSnapshot[] => {
		const ledger = ledgerDb;
		const provided = deps.getTreeNodes
			? deps.getTreeNodes()
			: ledger ? attachUsageTotals(ledger, getSubtree(ledger, "root")) : undefined;
		if (provided !== undefined) {
			tree.clear();
			for (const node of provided) {
				// D3: no timestamp race. `override.ts` comes from THIS process's event
				// bus while `node.updatedAt` comes from the CHILD's heartbeat, and a
				// dead child stops heartbeating (`legion-tools.ts` only heartbeats
				// `isAlive` children), so its `updatedAt` freezes. Comparing the two
				// therefore ranked two different clocks, and when the override looked
				// older the code DELETED it and trusted the frozen row — which pulled
				// finished nodes back to `running`. That was the whole reported bug.
				//
				// D8: render is a projection of facts, not a replay of events. The
				// lifecycle verdict now comes from `liveness()`; the override only
				// contributes fields that are NOT a lifecycle claim (`phase`), plus an
				// optimistic status that must still agree with `liveness()`.
				const override = eventOverrides.get(node.id);
				const verdict = liveness({
					ledger: { status: node.status, updatedAt: node.updatedAt },
					...inProcessFactsFor(node.id),
					now: now(),
					staleMs: orphanStaleMs(),
				});
				// What the verdict decides, and what it does NOT decide:
				//
				//  - `dead` wins over a non-terminal row. A row that stopped
				//    heartbeating cannot describe a live child, so it is rendered as
				//    failed rather than left looking alive.
				//  - `unknown` never promotes a row to `running` and never claims death.
				//  - `live` says the child IS alive; it does not say WHICH alive state.
				//    The ledger row only advances on heartbeat (coarse), while an event
				//    says exactly what happened (`node_launched` → running). So a live
				//    verdict keeps the MORE SPECIFIC of the two: an override status from
				//    this process's own bus wins over the row, because it is the same
				//    lifecycle seen at a finer grain. Only a terminal row outranks it —
				//    a settled/failed row is a fact that no later "running" may erase.
				//
				// Two override cases outrank the row, and they cover both directions
				// the coarse heartbeat cannot express:
				//  - the override is TERMINAL (`node_settled`) while the row has not
				//    caught up: the event ends the child now, not on the next heartbeat;
				//  - both are non-terminal and the event is more specific
				//    (`node_launched` → running vs a stale `starting` row).
				// A terminal ROW always wins over a non-terminal override: once the
				// ledger says settled/failed, no later "running" may erase that.
				const overrideStatus = override?.status;
				const rowTerminal = isTerminalState(node.status);
				const overrideTerminal = overrideStatus !== undefined && isTerminalState(overrideStatus);
				const status =
					verdict === "dead" && !rowTerminal
						? "failed"
						: overrideStatus !== undefined && !rowTerminal && (overrideTerminal || verdict === "live")
							? overrideStatus
							: node.status;
				tree.set(node.id, {
					...node,
					status,
					...(override?.phase === undefined ? {} : { phase: override.phase }),
				});
			}
			// Only overrides whose optimistic STATUS has now been superseded are
			// dropped: the tree row above is the authoritative projection, so keeping
			// a lifecycle claim around would resurrect it on the next event. `phase`
			// is not a lifecycle claim and must survive — it carries no
			// live/dead meaning and has no other source between events.
			for (const [nodeId, override] of eventOverrides) {
				if (!tree.has(nodeId)) continue;
				if (override.status === undefined) continue;
				const current = tree.get(nodeId);
				if (current !== undefined && current.status !== override.status) eventOverrides.delete(nodeId);
			}
			for (const nodeId of activity.keys()) if (!tree.has(nodeId)) activity.delete(nodeId);
			for (const nodeId of eventOverrides.keys()) if (!tree.has(nodeId)) eventOverrides.delete(nodeId);
		}
		const nodes = [...tree.values()].map((node) => ({ ...node }));
		return mergeSpawnModes(nodes);
	};

	/**
	 * #209/D5: the arbitrated backend lives on the tracked job, never in
	 * legion.db (no column, no migration), so it is merged onto the matching
	 * snapshot. Unmatched jobs contribute nothing rather than a guess.
	 *
	 * Shared by `snapshotNodes()` and `treeNodes()`: the latter synthesizes
	 * nodes of its own (a job with identity but no DB row yet) and returns that
	 * array directly, so a merge that only ran in `snapshotNodes()` would drop
	 * the mode in the pre-DB-row window and in a plain session where
	 * `getTreeNodes()` yields `[]`.
	 */
	const mergeSpawnModes = (
		nodes: TreeNodeSnapshot[],
	): TreeNodeSnapshot[] => {
		for (const job of jobs.values()) {
			if (job.spawnMode === undefined) continue;
			const match = storedNodeForJob(job, nodes);
			if (match) match.spawnMode = job.spawnMode;
		}
		return nodes;
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
		const children = activeEntries(list).map((entry) => entry.name);
		if (label !== undefined) {
			deps.emitBusy?.(true, label, children);
			busyRaised = true;
			return;
		}
		if (busyRaised) {
			busyRaised = false;
			deps.emitBusy?.(false, undefined, []);
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
		if (node) {
			// D3: no cross-writer timestamp race.
			//
			// `event.ts` is stamped by THIS process's bus; `node.updatedAt` is stamped
			// by the CHILD's heartbeat. A dead child stops heartbeating, so its
			// `updatedAt` freezes and a later real event would fail `event.ts >=
			// updatedAt` — silently dropped, leaving the panel stuck. Only the
			// SAME-writer ordering is still meaningful: an event must not undo a
			// NEWER event from the same bus (that is `previous.ts`, below).
			//
			// D8: this is an optimistic update only. `snapshotNodes()` recomputes every
			// row from facts via `liveness()`, so a stale optimistic status cannot
			// survive a refresh — which is what makes dropping the clock guard safe.
			const previous = eventOverrides.get(event.nodeId);
			if (!previous || event.ts >= previous.ts) {
				const override = { ...previous, ts: event.ts };
				const updated = { ...node };
				if (event.type === "node_launched" || event.type === "node_resumed") updated.status = override.status = "running";
				else if (event.type === "node_settled") updated.status = override.status = "settled";
				else if (event.type === "node_failed") updated.status = override.status = "failed";
				else if (event.type === "node_retired" && node.status !== "settled" && node.status !== "failed") updated.status = override.status = "retired";
				else if (event.type === "node_blocked") updated.status = override.status = "blocked";
				else if (event.type === "node_abandoned") updated.status = override.status = "failed";
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

	/**
	 * True between the first event of a burst and its trailing flush. It is both
	 * the "a flush is already scheduled" guard and the "a burst is open" marker
	 * that tells `onWidgetEvent` whether this event needs the leading snapshot.
	 */
	let burstPending = false;

	/**
	 * #238: a burst of bus events in one tick costs ONE tree snapshot + paint
	 * instead of 2×N. `snapshotNodes()` is a synchronous recursive-CTE subtree
	 * scan plus a usage batch query, and `refreshUi()` → `statusEntries()` ran it
	 * a second time per event.
	 *
	 * What stays synchronous, per event, in arrival order (D2): `applyTreeEvent`
	 * is an incremental state machine, not a render. `event.ts >= node.updatedAt`
	 * lets a later event veto an earlier one, `turn_start` increments the turn and
	 * clears the frozen endpoint, and `agent_settled` freezes it — so batching or
	 * reordering these would change the state they compute. They run in the bus
	 * callback exactly as before.
	 *
	 * What is coalesced: the trailing snapshot + paint only. The *leading*
	 * snapshot is deliberately NOT coalesced: `applyTreeEvent` reads `tree`, which
	 * only `snapshotNodes()` populates, so the first event of a burst must see a
	 * current tree or it would project this tick's status/phase delta against
	 * whatever the previous tick left behind (a node launched since then is simply
	 * absent, and its event is dropped). A burst therefore costs a leading snapshot
	 * plus one flush — a constant 2, down from 2×N.
	 *
	 * Semantics of the mid-burst window — a DOCUMENTED LIMITATION, not a claim of
	 * equivalence. Events 2..N are vetted against the tree as of burst start
	 * instead of being re-read per event (what `master` does).
	 *
	 * The divergence class is: ANY mid-burst write that changes a row in this
	 * subtree. Not just a write to the event's own node — `snapshotNodes()` clears
	 * and rebuilds the whole `tree` while `eventOverrides` survives, so a sibling
	 * process committing any row here can change whether a later event's
	 * `event.ts >= node.updatedAt` guard passes. Reachable in production because
	 * `getTreeNodes()` re-reads SQLite on every call, so a concurrent writer's
	 * commit IS visible to a per-event read but not to a burst; sibling bus
	 * subscribers also read `treeNodes()` inside the burst
	 * (`legion-commands.ts`).
	 *
	 * Sampled rather than exhaustively enumerated: a differential harness over
	 * burst/row combinations (row status x row `updatedAt` x mid-burst bump x event
	 * pair) showed the coalesced paint matching a per-event re-read in every case
	 * with no mid-burst write, and diverging in both directions once there is one —
	 * the coalesced path can miss a veto `master` applied, and can also apply one
	 * `master` correctly skipped. So neither "re-read at the flush" nor "re-read at
	 * burst start" fixes it: reproducing a SEQUENCE of per-event reads is not
	 * possible with a constant number of reads, which is why this is bounded and
	 * documented instead of repaired. `test/unit/runtime.test.ts` pins one concrete
	 * instance (the "KNOWN LIMITATION" test) so the behaviour is asserted rather
	 * than described.
	 *
	 * It IS sticky, and this is not fixed: the override wins on `ts`, exactly as
	 * `master`'s own override does, so the next `snapshotNodes()` does NOT re-vet it
	 * away. It lasts until the row moves again. Fixing it needs per-event re-reads,
	 * i.e. reverting the optimisation.
	 *
	 * One sub-case IS closed, at no cost to the common burst: an event for a node
	 * that is absent from `tree` but belongs to THIS subtree (its row only landed
	 * mid-burst) takes a fresh snapshot before applying, so `applyTreeEvent`'s
	 * `tree.get()` miss cannot silently drop it. Foreign-subtree node ids — the
	 * normal shape of a shared-ledger poll batch — cost zero extra reads.
	 *
	 * Microtask, not macrotask: the burst this targets is one synchronous emit
	 * loop (`legion-tools.ts` emits N `mail_sent` events back-to-back; the db event
	 * source drains a poll batch the same way), and a microtask drains the whole
	 * burst with no timer seam, no extra flush API, and no added latency before the
	 * TUI's next frame. A macrotask would need an explicit `flush()` seam or a
	 * timer and would delay the paint by a tick for no coalescing benefit.
	 */
	/**
	 * The subtree this runtime renders, derived from the FIRST populated snapshot.
	 * `snapshotNodes()` calls `deps.getTreeNodes()`, which the extension supplies
	 * as `getSubtree(db, identity.nodeId)` — so the shallowest node id in that
	 * result IS this session's subtree root, and every node it can ever show is
	 * that id or a strict descendant of it (`parent.child`).
	 *
	 * This is what bounds the unknown-node snapshot below (#238 review): the
	 * DbEventSource emits EVERY row on the shared legion.db, so a sibling
	 * subtree's batch routinely lands on this bus with `nodeId`s this session can
	 * never render. Paying a snapshot per such event would be backwards — a
	 * 40-event foreign batch cost 41 reads, worse than master's 80/2 ratio implied.
	 * `undefined` means "not yet known" (empty tree / a host with no tree), in
	 * which case an unknown node is treated as possibly-ours and gets the read.
	 */
	const subtreeRootId = (): string | undefined => {
		let best: string | undefined;
		for (const id of tree.keys()) {
			if (best === undefined || id.length < best.length) best = id;
		}
		return best;
	};

	/** True when `nodeId` is the subtree root itself or a strict descendant of it. */
	const isInOwnSubtree = (nodeId: string): boolean => {
		const rootId = subtreeRootId();
		if (rootId === undefined) return true;
		return nodeId === rootId || nodeId.startsWith(`${rootId}.`);
	};

	const scheduleTreeFlush = (): void => {
		if (burstPending) return;
		burstPending = true;
		queueMicrotask(() => {
			burstPending = false;
			// The old inline path ran `refreshUi()` INSIDE the bus handler, so a throw
			// from `getTreeNodes()`/`board.paint()` was contained by
			// `createLegionEventBus`'s per-subscriber try/catch. A microtask has no
			// such wrapper, so an uncaught throw here would kill the host process. The
			// bus's job is to isolate a subscriber's failure; report through the same
			// channel a throwing handler uses instead of escaping onto the microtask
			// queue. No `disposed` guard: `refreshUi()` already returns early when
			// disposed, and this callback calls no other paint-path code.
			try {
				refreshUi();
			} catch (error) {
				// Reporting must never itself break delivery, and must never re-enter
				// the microtask queue as an uncaught throw: `reportError` is optional
				// precisely so structural bus stand-ins keep working, and such a stand-in
				// would otherwise reintroduce the host-killing crash this guard exists
				// to prevent. Swallowing is the lesser evil — a lost repaint report
				// never costs the process.
				try {
					deps.eventBus?.reportError?.(error, "deferred-handler");
				} catch {
					// Isolated reporting failure: the board simply skips this frame.
				}
			}
		});
	};

	const onWidgetEvent = (event: LegionEvent): void => {
		// Leading snapshot, once per burst (see `scheduleTreeFlush`).
		if (!burstPending) snapshotNodes();
		// A node whose row only landed mid-burst is absent from `tree`, and
		// `applyTreeEvent` returns early on a `tree.get()` miss, so the event is
		// dropped and the flush cannot repair it: a just-launched child's ledger row
		// still says whatever the pre-launch write left (`starting` or nothing), so
		// re-reading cannot produce the `running` transition that a STORED
		// `node_launched` event carries. Pay one snapshot for exactly this case.
		//
		// Gated on subtree ownership: foreign-subtree events are the normal shape of
		// a shared-ledger poll batch and can never create a node here, so they cost
		// ZERO extra reads. Without the gate a 40-event foreign batch cost 41 reads;
		// with it, 2 (leading + flush).
		else if (!tree.has(event.nodeId) && isInOwnSubtree(event.nodeId)) snapshotNodes();
		applyTreeEvent(event);
		scheduleTreeFlush();
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
			// Seed at the tail for the same reason as the extension's attach path
			// (`attachLegionRuntime` in index.ts, #238): this branch attaches to a ledger
			// written by another process, and replaying its history only to reach a state
			// `snapshotNodes()` already read is pure overhead. It matters for embedders
			// using the public `createSessionRuntime` with PI_LEGION_DB and no
			// `getTreeNodes` — unreachable from the extension itself, which always passes
			// `getTreeNodes` — so keep the two call sites consistent.
			dbEventSource = createDbEventSource(ledgerDb, {
				cursor: maxEventId(ledgerDb),
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
				return {
					name,
					stillRunning: true,
					elapsedMs: Math.max(0, now() - job.spawnedAt),
				};
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
				return {
					name,
					stillRunning: true,
					timedOut: true,
					elapsedMs: Math.max(0, now() - job.spawnedAt),
				};
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
				// Only a known value overwrites: a re-follow without the handle must
				// not erase the mode an earlier launch established.
				if (input.spawnMode !== undefined) existing.spawnMode = input.spawnMode;
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
					// Repaint before the new watch takes over so the panel cannot
					// hold the old row's final second. watch() repaints too; this is
					// an idempotent second guarantee.
					refreshUi();
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
					// Repaint immediately: the row flips to a terminal state here, and
					// waiting for the 500ms sampler leaves a phantom "working" row.
					refreshUi();
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
					refreshUi();
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
			// The synthesized nodes above are built from job facts, not from a DB
			// row, so they carry no `spawnMode` of their own: run the same merge
			// the snapshot path uses before handing the array out (#209/D5).
			return mergeSpawnModes(result);
		},

		statusEntries() {
			return statusEntries();
		},

		refreshUi,

		setJoinConfig(config) {
			joinConfig = config;
			join.setConfig(config);
		},

		notifyParentRunStart() {
			parentRunActive = true;
		},

		notifyParentSettled() {
			parentRunActive = false;
			flushOutbox();
			refreshUi();
		},

		noticeQueueStats(): NoticeQueueStats {
			const oldest = outbox[0];
			return {
				pending: outbox.length,
				oldestAgeMs: oldest ? Math.max(0, now() - oldest.enqueuedAt) : 0,
				forcedFlushes,
			};
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
						return true;
					} catch {
						// The watch records the failure; shutdown still retires the child.
						return false;
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
			// Shutdown drops held notices unsent: the child's session file survives,
			// so `collect` can still recover the result from disk. The `finished`
			// cache does NOT survive — it was cleared two statements up.
			outboxTimer?.cancel();
			outboxTimer = undefined;
			outbox.length = 0;
			if (timer) clearInterval(timer);
			timer = undefined;
			for (const unsubscribe of busUnsubscribers) unsubscribe();
			dbEventSource?.stop();
			ledgerDb?.close();
			ledgerDb = undefined;
			board.clear();
			if (busyRaised) {
				busyRaised = false;
				deps.emitBusy?.(false, undefined, []);
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

/**
 * Resident memory of a tracked job in MB, or `undefined` when there is no
 * honest number to report (D2).
 *
 * Only an `rpc` child owns a process. An `inprocess` child runs inside this
 * host, so it has no RSS of its own: apportioning the host figure across
 * children would invent data the user then decides on. Those rows stay blank
 * and the host figure is reported once, by name, elsewhere.
 *
 * §6 pid-reuse race: a pid outlives nothing — once the child exits, the kernel
 * may hand the same number to an unrelated process, and its RSS would land on
 * this row as the child's memory. So the pid is only read while the caller's
 * liveness check says the child is still up; a job with no `isAlive` hook
 * (legacy / re-followed record) has unverifiable liveness and stays blank too.
 */
function rssFor(job: TrackedJob): number | undefined {
	if (job.spawnMode === "inprocess" || job.pid === undefined) return undefined;
	// `isAlive` undefined is not permission to read: unknown is not alive.
	if (!job.isAlive || !job.isAlive()) return undefined;
	return readProcRss(job.pid)?.rssMb;
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
	const rss = rssFor(job);
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
		...(live.contextTokens ? { contextTokens: live.contextTokens } : {}),
		...(job.pid ? { pid: job.pid } : {}),
		...(job.spawnMode ? { spawnMode: job.spawnMode } : {}),
		...(rss !== undefined ? { rss } : {}),
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
	// An in-process child has no tracked job for its whole first run: spawnChild()
	// awaits the whole agent run, so the job (and its sessionFile plumbing in
	// statusEntryFromJob) does not exist yet. The node row does carry the session
	// file, so parse it directly — otherwise the ledger only has a tokens_out row
	// after settle and the token rate reads 0 for the agent's entire lifetime.
	const live = node.sessionFile ? progressFromSessionFile(node.sessionFile) : {};
	const tokensOut = live.tokensOut ?? node.tokensOut;
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
		...(node.spawnMode ? { spawnMode: node.spawnMode } : {}),
		...(live.usageTotal ? { tokensTotal: live.usageTotal } : node.tokensTotal ? { tokensTotal: node.tokensTotal } : {}),
		...(tokensOut ? { tokensOut } : {}),
		...(live.generationMs ? { generationMs: live.generationMs } : {}),
		...(live.contextTokens ? { contextTokens: live.contextTokens } : {}),
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
