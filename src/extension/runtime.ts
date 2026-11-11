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
	type CompletionInput,
	type CompletionNotice,
	type CompletionStatus,
	type SendMessageApi,
} from "./notify.ts";
import {
	DEFAULT_FLUSH_MS,
	DEFAULT_JOIN_MODE,
	JoinCoordinator,
	type JoinConfig,
	type JoinEntry,
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
import type { LiveProgress } from "../shared/progress.ts";
import { readProcRss } from "../supervisor/proc-memory.ts";
import { isTransientConnectionFailure } from "../shared/session.ts";
import { isTerminalState, liveness } from "./liveness.ts";
import type { RenewalProposal } from "./notify.ts";
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
import { LEGION_EVENT_TYPES, isDetailDeltaEvent } from "./event-bus.ts";
import { createDbEventSource, type DbEventSource } from "./event-bus.ts";
import { openLegionDb, type DatabaseSync } from "../legion/db.ts";
import { getSubtree } from "../legion/nodes.ts";
import { attachUsageTotals } from "../legion/usage.ts";
import { maxEventId } from "../legion/events.ts";
import { listArtifacts, markNotified, undelivered } from "../legion/ledger.ts";
import { publishLegionRunActivity } from "../legion/run-active.ts";
import type { TreeNodeSnapshot } from "../tui/tree-view.ts";
import type { PhaseMachine } from "../legion/phase-machine.ts";

export interface CollectSnapshot {
	execution: {
		status: string;
		reason?: string;
		/**
		 * Failure detail carried to the parent notice. `reason` is often a synthetic
		 * sentence (`unknown stopReason: …`), so the provider text is kept beside it
		 * instead of being lost between the transcript and the notice.
		 */
		stopReason?: string | null;
		errorMessage?: string | null;
		errorKind?: string;
	};
	output: string;
	/** Full output persisted to disk; named in the notice so a truncated preview has a one-step recovery. */
	outputFile?: string;
	/**
	 * Result-ledger identity of `outputFile` (`"<runId>/<name segment>/r<round>"`),
	 * when the collect recorded a ledger row.
	 *
	 * Straight pass-through of `CollectResult.artifactId` (`src/runs/orchestrator.ts`):
	 * an optional field on a shape the orchestrator already satisfies structurally, so
	 * nothing has to be re-mapped on the way in. Absent for a running snapshot, an
	 * empty output and any host with no legion context — the same conditions that leave
	 * `outputFile` absent.
	 *
	 * Consumed by the P3 ledger shadow (§3 D11) today; P5's `legion_output` / path
	 * index is the reason it belongs on the snapshot at all.
	 */
	artifactId?: string;
	/**
	 * #349 (issue suggestion A: "an explicit already-persisted marker"): the
	 * `output` above is NOT the child's whole text — the completion cache's
	 * resident bound dropped the tail and the full text could not be re-read from
	 * `outputFile` (the run dir was cleaned up, or the entry never had a file).
	 * Absent on every non-degraded result, including the first collect of a child
	 * whose output is larger than the whole cache budget.
	 */
	outputTruncated?: true;
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
	/**
	 * Reporting round of this child (D10).
	 *
	 * `runId` is the PARENT run id, so every steer/continue/resume of the same child
	 * shares it. One round = one deliverable result, and the round is what makes
	 * that expressible: the claim key and the delivery entries both carry it.
	 * Assigned by `track()` from a per-name monotonic counter (never rewound to 1, so
	 * a new round can never collide with an old round's key).
	 */
	round: number;
	state: string;
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
	/**
	 * #298: the phase machine for a role, so the tree can show a team's own
	 * workflow. Injected rather than imported because only the host knows the
	 * resolved agent catalog (card `phases:` plus any team override).
	 */
	getPhaseMachine?: (role: string | null | undefined) => PhaseMachine | undefined;
	/**
	 * #372 B: the phase machine for a NODE, inline declaration first.
	 *
	 * `getPhaseMachine` above answers "what does this ROLE declare", which is only
	 * the role card. Since #371 a team may declare its machine INLINE at dispatch
	 * (`subagent({ phases })`, contract §2), and such a team has no card to find:
	 * its machine is recorded per NODE (`ChildRecord.phases` in the launching run's
	 * run.json). Asked before the role lookup, so the inline layer keeps the
	 * priority the contract freezes (inline > card > none); the ancestor walk in
	 * `mergePhaseMachines` is unchanged, so a worker still inherits the machine of
	 * the team that declared it.
	 *
	 * #372 M1: `parentRunId` is the run of the node that DISPATCHED this one — the
	 * run whose `children[]` holds the record. A bare node id is not an identity:
	 * every run in a checkout has a `root.team`, so a lookup across the registry
	 * would let an OLD run's declaration paint today's node. Hosts that cannot
	 * resolve it may answer `undefined` (a miss): a guess here is worse than a
	 * blank panel, because it shows a workflow the team never had.
	 */
	getPhaseMachineForNode?: (node: {
		id: string;
		role: string | null;
		parentRunId: string | null;
	}) => PhaseMachine | undefined;
	/**
	 * Renewal proposal for a finishing child (subagent-renewal-v1 D3).
	 *
	 * Injected rather than imported: the only builder lives in `index.ts`, which
	 * already imports this module — a direct import would be a cycle. Returning
	 * `undefined` is the correct answer for every path that must NOT offer a
	 * renewal (D5 role opt-out, D1 completed, D7 still running, no baseline), so a
	 * host that never supplies this hook simply gets today's notice verbatim.
	 */
	getRenewalProposal?: (
		name: string,
		execution: { status: string; reason?: string },
	) => RenewalProposal | undefined;
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
	/**
	 * Measured decode ms for a child (contract `tps-decode-denominator-v1` D5) —
	 * the live `tok/s` denominator the supervisor folded from the child's own event
	 * stream. `undefined` means NO OBSERVATION and the row falls back to
	 * `generationMs`; a measured 0 is a real answer (a child spawned seconds ago).
	 *
	 * Injected rather than imported because this module must not reach into the
	 * supervisor instance (the host owns it, and unit tests run without one).
	 */
	getLiveDecode?: (name: string) => number | undefined;
	/** Batching config; applied via setJoinConfig right after construction. */
	joinConfig?: JoinConfig;
	/** Injectable timer for the MAX_PENDING_AGE_MS horizon (tests fire it manually); default = unref'd setTimeout. */
	scheduleNoticeOverflow?: (ms: number, fn: () => void) => JoinSchedulerHandle;
	/**
	 * The ledger handle plus the consumer id (`parent_id`) the runtime asks about — or
	 * `undefined` when this host has neither.
	 *
	 * This is the DELIVERY PROJECTION (`result-ledger-v1` §3 D4): whether a result still
	 * owes the parent a notice is answered by `ledger.undelivered(consumerId)` (see
	 * `ledgerProjection` / `owesDelivery` below), and a successful send is recorded with
	 * `ledger.markNotified`. Since P4c it is the ONLY source of that verdict — the P3
	 * shadow (which also read it) was deleted together with the claim set — and
	 * `index.ts` wires it from `ownLegionIdentity()`, so the projection is live in a
	 * real session rather than waiting for a hookup.
	 *
	 * The runtime does not open its own connection — the host already owns one, and a
	 * second writer of the same file would be a fact this code cannot justify.
	 *
	 * Optional for the same reason `publishRunActivity` is: `SessionRuntime` is also
	 * built as a literal double in tests, and a required member would break every one of
	 * them for no behaviour. Absent (or throwing) ⇒ no projection ⇒ the `deliveredOnce`
	 * fallback, never a failed delivery (D1e).
	 */
	getLedgerProjection?: () => { db: DatabaseSync; consumerId: string } | undefined;
}

const DEFAULT_REFRESH_MS = 500;
/**
 * #391: how often a terminal row's progress may be re-read.
 *
 * `LiveProgress` is a pure function of the session file — `progressFromSession`
 * never reads a clock, every field is folded content — so a row whose transcript
 * has stopped growing needs to be folded once, not twice a second. The window is
 * not cosmetic: several paths stamp a terminal status before the transcript is
 * final (the shutdown hook retires still-running children and only then drains
 * them, `liveness()` can render a dead row as `failed`, a terminal event
 * override can outrun the ledger), so those values must converge rather than
 * freeze. 279 files per 30s is ~9 stats/s against the 279 folds per 500ms this
 * replaces (134.5MB/tick in the reported session).
 */
const TERMINAL_PROGRESS_TTL_MS = 30_000;

/** The row statuses whose transcript is final — the ones `statusEntryFromNode` stamps `finishedAt` on. */
function isFinalRowStatus(status: TreeNodeSnapshot["status"]): boolean {
	return status === "settled" || status === "failed" || status === "retired";
}

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
 * Health horizon of a completion notice held behind a live parent agent run (D6).
 *
 * Since delivery v2 a notice may only enter the transcript at a RUN BOUNDARY
 * (`parentRunActive === false`). The host cannot retract a message, so anything
 * sent earlier becomes visible at a moment this code no longer controls —
 * exactly the T0 ≠ T2 gap that produced the duplicate. So this horizon no longer
 * sends anything: crossing it proves a notice has been held far longer than a
 * healthy settle boundary should take (a stuck `parentRunActive`, or a host that
 * never emits `agent_settled`), which is what `noticeQueueStats().heldOverCap`
 * reports to doctor. 80s = 2× the (1+3)×10s the old join window could reach.
 *
 * Since `root-mail-run-boundary-v1` D2 the mail postman's root-inbox gate also reads
 * the SAME `parentRunActive` variable — through the registry in
 * `src/legion/run-active.ts`, via {@link SessionRuntime.publishRunActivity} — so a
 * stuck flag parks root mail too (that contract's D7-2 names the residual). This
 * horizon plays no part in that gate: `MAX_PENDING_AGE_MS` only counts how long a
 * completion notice has been held, and it sends nothing.
 */
export const MAX_PENDING_AGE_MS = 80_000;
/** Fallback per-child timeout for wait(); index.ts passes the role value. */
const DEFAULT_WAIT_TIMEOUT_MS = DEFAULTS.turnTimeoutMs;

/** Default timer for the MAX_PENDING_AGE_MS horizon (unref'd, like join's). */
function defaultNoticeOverflow(
	ms: number,
	fn: () => void,
): JoinSchedulerHandle {
	const id = setTimeout(fn, ms);
	id.unref?.();
	return { cancel: () => clearTimeout(id) };
}

/**
 * A terminal entry on its way out: the join entry (which already carries the D10
 * round) plus its coarse verdict.
 */
type DeliverableEntry = JoinEntry & { status: CompletionStatus };

/**
 * P4b (`result-ledger-v1` §3 D4): one read of the notice projection, plus the two
 * facts a `markNotified` write needs.
 *
 * Two sets, because "not in the projection" has two very different reasons (v1.10):
 * - `undeliveredIds` — artifacts this consumer neither was told about nor read to EOF
 *   ⇒ the suppression answer;
 * - `knownIds` — every artifact id this consumer actually has a row for. An id outside
 *   it was never filed (`recordArtifact` is best-effort, D1b's reuse branch does not
 *   verify the row, a reset `legion.db` without a rebuild): the ledger cannot prove the
 *   parent ever saw it, so it must not answer "settled".
 *
 * `db`/`consumerId` travel with them so the write uses the SAME handle and scope the
 * verdict was computed from (`undefined` projection ⇒ no write, see `deliverBatch`).
 */
interface LedgerProjection {
	db: DatabaseSync;
	consumerId: string;
	undeliveredIds: ReadonlySet<string>;
	knownIds: ReadonlySet<string>;
}

/**
 * A completion batch held because the parent agent run is still active (D-A).
 *
 * D4: the batch is held STRUCTURALLY, never as formatted text. A `wait`/`collect`
 * that lands while it sits here still wins (that is the W2 duplicate), and the
 * grouped header (`N of M`, `Still running`) has to be derived from whatever
 * actually survives — which is only possible if filtering and formatting both
 * happen at flush time instead of at enqueue time.
 */
interface QueuedNotice {
	/** Already claim-filtered once; filtered AGAIN at flush (D5 step 1). */
	entries: DeliverableEntry[];
	triggerTurn: boolean;
	/**
	 * Whether this batch is a PARTIAL slice of its run (the window expired with
	 * stragglers still pending), frozen at enqueue time (D5). Recomputing it at
	 * flush would let a straggler that finished in between change the shape of a
	 * batch whose shape was already decided: a partial single must keep saying
	 * `1 of N` even though `join.allSettled()` now returns true.
	 */
	partial: boolean;
	enqueuedAt: number;
	/**
	 * D6: when this notice's hold was counted against `MAX_PENDING_AGE_MS`.
	 *
	 * One stamp per NOTICE, not per window: `heldOverCap` says "this held notice has
	 * been waiting longer than a healthy boundary" — a single fact about a single
	 * notice — so its second and third 80s must not add anything. The stamp is also
	 * where the next window is anchored: an age-derived delay for an already-counted
	 * notice would be 0 forever, which is a busy loop rather than a measurement.
	 */
	overCapAt?: number;
}

export interface NoticeQueueStats {
	/**
	 * Held batches that can still produce a message, i.e. at least one member is
	 * not claimed yet. A fully claimed batch is already dead: the flush will drop
	 * it, so counting it would report a notice as waiting that can never land.
	 */
	pending: number;
	/** now() - enqueuedAt of the oldest such batch; 0 when none. */
	oldestAgeMs: number;
	/**
	 * Lifetime count of held notices whose age crossed `MAX_PENDING_AGE_MS` (D6).
	 *
	 * Counted PER NOTICE, once, and only for a notice that can still be delivered —
	 * the same population `pending` describes. It counts the HOLD, never a send: the
	 * horizon cannot put a message into the transcript any more, so a non-zero value
	 * means notices are waiting far longer than a run boundary should take. That is
	 * a diagnostic number (exported for doctor/tests; no production consumer today),
	 * not a failure of delivery.
	 */
	heldOverCap: number;
	/**
	 * #349: what the completion cache (`finished`) is holding right now.
	 *
	 * `residentBytes` is the UTF-8 size of the output text still in memory (heads
	 * included); `stripped` counts entries whose text was dropped and will be
	 * re-read from `outputFile` on the next hit; `pinnedBytes` is text this cache
	 * cannot reclaim because the entry has no `outputFile` to rebuild from (see
	 * `docs/contracts/finished-cache-eviction-v1.md`).
	 */
	finished: {
		entries: number;
		residentBytes: number;
		stripped: number;
		pinnedBytes: number;
	};
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
	 * The explicit `collect` tool call's read of a child's result: the shared collect
	 * promise when the child is tracked, otherwise the finished cache.
	 *
	 * P4c (`result-ledger-v1` D12): this returns the bare snapshot again. The seam used
	 * to hand out a claim (`ClaimedCollect`) so a bail could roll it back; delivery is
	 * now decided by the ledger projection (D4), which has no rollback API — a result the
	 * tool call never handed over simply declares no `ledgerReads` (D3b), so nothing was
	 * written and the notice still owes its delivery.
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
	/** Parent agent run settled (pi `agent_settled`): deliver the oldest held notice (and any `triggerTurn:false` one behind it), then repaint (D-A/D-D/D2). */
	notifyParentSettled(): void;
	/** Introspection seam for tests/doctor: deferred-notice queue state (D-B/D6 health). */
	noticeQueueStats(): NoticeQueueStats;
	/**
	 * `root-mail-run-boundary-v1` D2: hand this session's run-activity reader to the
	 * process-wide registry (`src/legion/run-active.ts`) under `nodeId`, so the mail
	 * postman can ask "is this node's run still live?" without a second copy of the
	 * flag. The reader is `() => parentRunActive` — the ONE variable — and `dispose()`
	 * withdraws it.
	 *
	 * Optional on purpose (that contract's D6): `SessionRuntime` is also built as a
	 * literal double in tests (`wait-action-index.test.ts` and friends), and a required
	 * member would break every one of them for no behaviour.
	 */
	publishRunActivity?(nodeId: string): void;
	/**
	 * Explicit wait: aggregate the targets' results. The notice for a result the parent
	 * actually read is suppressed by the ledger projection, not by a flag this call sets
	 * (P4c), so a timeout needs no restore.
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

/**
 * #349: bounds on the completion cache's resident OUTPUT TEXT.
 *
 * `finished` is a one-round cache keyed by name (D7b) that used to hold every
 * child's full `CollectSnapshot.output` for the rest of the session: measured
 * 210KB resident per finished child, 10.0MB after 50 children, freed only by a
 * re-`track` or `dispose()`. What the cache actually owes its callers is the
 * RESULT — `runId`/`round` (D9/D10), `execution`, `acceptance`, `outputFile` —
 * plus a preview of the text; the full text is already on disk
 * (`CollectSnapshot.outputFile`, written by the orchestrator), so no entry keeps
 * a long text in memory and a hit re-reads it from the file.
 *
 * #349's acceptance is **≤ 1.0MB resident**, so the budget is set to satisfy it
 * rather than to be "roughly smaller":
 *
 *  - `FINISHED_CACHE_MAX_ENTRY_BYTES = 8KB` — one entry may retain at most one
 *    terminal preview's worth of text. Anything longer is not resident at all;
 *    the hit re-reads it from `outputFile` (this is also what makes the bound
 *    independent of how large a single child's output was).
 *  - `FINISHED_CACHE_MAX_OUTPUT_BYTES = 1MB` — the whole cache's resident text.
 *  - `FINISHED_CACHE_MAX_ENTRIES = 128` — derived: 1MB / 8KB. The byte bound is
 *    therefore the binding one; the count bound just keeps the per-entry
 *    bookkeeping (and the head-per-entry of 4k chars) from growing without it.
 *
 * Nothing here changes WHICH results are cached, the one-round invalidation, or
 * the claim keys — a stripped entry keeps its `runId`/`round`/snapshot metadata,
 * so a later hit claims exactly what it would have claimed before.
 */
export const FINISHED_CACHE_MAX_ENTRIES = 128;
export const FINISHED_CACHE_MAX_OUTPUT_BYTES = 1024 * 1024;
/**
 * #349: resident text cap for ONE entry. A longer output is not kept in memory:
 * the entry stores its head and the hit re-reads `outputFile`, so no single
 * child can occupy the whole budget and the internal accounting stays
 * independent of output size.
 */
export const FINISHED_CACHE_MAX_ENTRY_BYTES = 8 * 1024;
/**
 * Text a stripped entry keeps. Matches `PREVIEW_CHARS` in notify.ts (duplicated
 * for the same reason as `DEFAULT_ORPHAN_STALE_MS`: the runtime must not import
 * the formatter's internals) so a notice rendered from a cached hit is still
 * whole. 4000 chars is ≤ 8KB even at 2 bytes/char — the entry cap above.
 */
export const FINISHED_OUTPUT_HEAD_CHARS = 4_000;

/**
 * A cached terminal snapshot PLUS the run it came from.
 *
 * D9: the run id travels with the snapshot because the cache is keyed by NAME
 * only, while a claim is keyed by `(runId, name)`. Recovering the run id from
 * "the last run id seen for this name" therefore picked the NEWEST run, so a
 * cache hit for a name reused across runs claimed the wrong key — delivering a
 * notice that was already read (duplicate), or claiming the current run's entry
 * while handing out an older run's snapshot (swallowed failure).
 *
 * #349 (review major 1): `snapshot` is the cache's OWN shallow copy, never the
 * object the caller was handed. Trimming mutates `snapshot.output` in place, so
 * keeping a reference would strip the text out of a result that was already
 * delivered to `collect`/`wait`/`join.onTerminal` (and out of the in-flight
 * `job.collectPromise`) the moment the entry is inserted or evicted.
 */
interface FinishedResult {
	runId: string;
	/** Round the snapshot belongs to (D10) — a cached hit claims THAT round. */
	round: number;
	/**
	 * The collect's own snapshot (a shallow copy made by `rememberFinished`), so it
	 * carries `output`/`outputFile`/`artifactId` without a second copy of them here: a
	 * duplicated artifact id could drift from the snapshot it describes, and the
	 * trimming below mutates only the TEXT.
	 */
	snapshot: CollectSnapshot;
	/** Resident bytes of `snapshot.output` (the head alone once `stripped`). */
	bytes: number;
	/**
	 * #349: the full text was dropped to stay inside the cache bound. The next hit
	 * re-reads it from `snapshot.outputFile`; until then `snapshot.output` holds
	 * the head and the metadata is untouched.
	 */
	stripped: boolean;
}

export function createSessionRuntime(deps: SessionRuntimeDeps): SessionRuntime {
	const now = deps.now ?? Date.now;
	const refreshMs = deps.refreshMs ?? DEFAULT_REFRESH_MS;
	const jobs = new Map<string, TrackedJob>();
	const finished = new Map<string, FinishedResult>();
	const board = createStatusBoard({
		onNodeClick: deps.onStatusNodeClick,
		...(deps.statusStrip ? { strip: deps.statusStrip } : {}),
	});
	const tree = new Map<string, TreeNodeSnapshot>();
	const activity = new Map<string, NodeActivity>();
	/**
	 * #391 A: terminal-row progress, keyed by node id.
	 *
	 * Keyed by row (not by session file) because `updatedAt` is the "this row
	 * settled again" guard and two rows over one transcript carry different
	 * stamps — keyed by file, the second row would look like a re-settle and
	 * re-fold the file on every tick. `sessionFile` is part of the guard so a row
	 * that is pointed at a different transcript re-reads it. Pruned by the same
	 * rule as `activity`: the tree no longer has the node.
	 */
	const terminalProgress = new Map<
		string,
		{ sessionFile: string; updatedAt: number; progress: LiveProgress; checkedAt: number }
	>();
	const eventOverrides = new Map<string, { ts: number; status?: TreeNodeSnapshot["status"]; phase?: string }>();
	let ledgerDb: DatabaseSync | undefined;
	let dbEventSource: DbEventSource | undefined;
	let timer: ReturnType<typeof setInterval> | undefined;
	let disposed = false;
	let draining = false;
	let drainPromise: Promise<void> | undefined;
	let busyRaised = false;

	// ───────────── the delivery verdict is a PROJECTION (result-ledger-v1 D4) ─────────────
	//
	// P4c deleted the whole claim model that used to live in this closure: the reported
	// key set and its six operations (claim, claim-if-terminal, claim-a-cached-result,
	// revoke, hand-back, unclaim-on-reset), the per-snapshot round map that fed them, the
	// two flags on `TrackedJob` and the watch gate that read those flags (D12: 旧模型直接
	// 删除，不做兼容层). Nothing here is a memory bit set at a call site any more — see the
	// projection below.
	/**
	 * D10: the key is `(runId, name, round)`. `\u0000` occurs in no component, so no
	 * two triples can collide; and because the round comes from a monotonic per-name
	 * counter, a new round can never be mistaken for an old one.
	 *
	 * P4c: the claim table this key was minted for is gone. It survives because the
	 * `deliveredOnce` fallback below is still a per-round memory (the ledger write is
	 * keyed by the artifact id, not by this string).
	 */
	const reportKey = (runId: string, name: string, round: number): string =>
		`${runId}\u0000${name}\u0000${round}`;

	// ─────────────────── the projection, and its degraded fallback ───────────────────
	//
	// `result-ledger-v1` D4: whether a result still owes the parent a notice is no
	// longer a memory bit set at four call sites — it is a query. `undelivered` names
	// every artifact this consumer has neither been told about nor read to EOF, and that
	// projection IS the answer (D2's three conjuncts live in `src/legion/ledger.ts` and
	// nowhere else, A3). A result the parent read through `collect`/`wait` leaves the
	// projection by `read_bytes` (P4a), a notice that went out leaves it by
	// `notified_at` (below) — one predicate, two facts, no rank.
	//
	// A projection can also be UNAVAILABLE: no `legion.db` wired into this host yet, no
	// `consumerId`, a result collected with no ledger context (no artifact id), or a host
	// hook that throws. Those entries fall back to `deliveredOnce` — the smallest memory
	// this seam can get away with: one set of already-sent keys, no rollback API, and
	// (unlike the claim set it replaces) no part in dropping join/outbox copies. It can
	// only ever ADD suppression, so the failure direction is "a notice is repeated",
	// never "a notice is lost"; it is also the record of a delivery whose ledger write
	// (v1.10: `markNotified`) failed, which is why `owesDelivery` reads it first.
	//
	// Both the fallback and the ledger write are keyed the same way the claim set was
	// (`runId\0name\0round`): the round is what makes a child's SECOND round a
	// different result rather than a repeat of the first (D1).
	const deliveredOnce = new Set<string>();

	/**
	 * The env switch D11 introduced for the shadow, kept for the one diagnostic D4 still
	 * owes after P4c.
	 *
	 * `./ledger-shadow.ts` is deleted (D11: the shadow lives only in P3), so the flag no
	 * longer selects between two models — there is one model, the projection. What it
	 * still gates is `artifact-id-without-ledger-row` below: an id the ledger has no row
	 * for is a fact worth one stderr line, and D11's "默认零开销" (default silent) still
	 * applies to the default path.
	 */
	const DIAGNOSTIC_ENV = "PI_LEGION_LEDGER_SHADOW";
	const DIAGNOSTIC_PREFIX = "ledger-shadow mismatch";
	const diagnosticsEnabled = (): boolean => process.env[DIAGNOSTIC_ENV] === "1";

	/**
	 * One read of the projection. `undefined` = no projection available (D1e: a
	 * missing/closed handle or a throwing host hook is "no ledger", not a failed
	 * send — the caller degrades, it never throws).
	 */
	const ledgerProjection = (): LedgerProjection | undefined => {
		try {
			const facts = deps.getLedgerProjection?.();
			if (!facts) return undefined;
			return {
				db: facts.db,
				consumerId: facts.consumerId,
				undeliveredIds: new Set(undelivered(facts.db, facts.consumerId).map((artifact) => artifact.id)),
				// v1.10: the scope of the projection's authority. Same query family, same
				// `parent_id` scope, served by `idx_artifacts_parent`.
				knownIds: new Set(listArtifacts(facts.db, facts.consumerId).map((artifact) => artifact.id)),
			};
		} catch {
			return undefined;
		}
	};

	/**
	 * v1.10 diagnostic (review critical): an artifact id this consumer has no row for.
	 *
	 * A diagnostic, never a decision: by the time this runs the verdict has already
	 * failed OPEN. Gated on the D11 flag so the default path stays silent, one line per id
	 * (this runs on every `noticeQueueStats()` poll too, and a diagnostic must not become a
	 * stderr firehose), and wrapped because a closed stderr pipe may not become a failed
	 * delivery.
	 */
	const unknownArtifactReported = new Set<string>();
	const reportUnknownArtifact = (artifactId: string, consumerId: string): void => {
		if (!diagnosticsEnabled()) return;
		const key = `${consumerId}\u0000${artifactId}`;
		if (unknownArtifactReported.has(key)) return;
		unknownArtifactReported.add(key);
		try {
			process.stderr.write(
				`${DIAGNOSTIC_PREFIX} reason=artifact-id-without-ledger-row ` +
					`artifact=${artifactId} consumer=${consumerId}\n`,
			);
		} catch {
			// Diagnostics only: never a delivery outcome.
		}
	};

	/**
	 * D4: does THIS result still owe the parent a notice?
	 *
	 * - the fallback memory is read FIRST (v1.10, review major): a `markNotified` that
	 *   threw already recorded the delivery in `deliveredOnce`, and reading it after the
	 *   projection branch below would make that fallback dead code — the same result
	 *   would be re-sent at every boundary;
	 * - no artifact id, or no projection ⇒ nothing is known ⇒ deliver (contract D3's
	 *   deliberate direction: 宁多推一条，不静默丢);
	 * - an artifact id with NO ledger row ⇒ the ledger cannot have judged it, so deliver
	 *   and say so on stderr (v1.10, review critical) — the alternative is silent loss
	 *   for a whole class of real cases (best-effort insert failed, db reset without
	 *   rebuild, D1b reuse of a row that is gone);
	 * - otherwise the projection IS the answer, and nothing else (D6: a partial read
	 *   suppresses nothing, because `read_bytes < bytes` keeps it in the set).
	 *
	 * `artifactId` is optional on purpose: a LIVE tracked sibling has no artifact yet (the
	 * store writes one only at settle), so the `Still running` footer asks without an id
	 * and the answer is always the `deliveredOnce` fallback.
	 *
	 * Since P4c this is the ONLY delivery verdict in the runtime: the claim set it once had
	 * to agree with is gone, so there is no second model left to mix in.
	 */
	const owesDelivery = (
		runId: string,
		name: string,
		round: number,
		projection: LedgerProjection | undefined,
		artifactId?: string,
	): boolean => {
		if (deliveredOnce.has(reportKey(runId, name, round))) return false;
		if (artifactId === undefined || !projection) return !deliveredOnce.has(reportKey(runId, name, round));
		if (!projection.knownIds.has(artifactId)) {
			reportUnknownArtifact(artifactId, projection.consumerId);
			return true;
		}
		return projection.undeliveredIds.has(artifactId);
	};

	// ────────────────── #349: bounded completion-cache text ──────────────────
	//
	// The cache is an LRU by insertion order (Map preserves it; a hit re-inserts
	// the entry as the newest). The bound applies to resident TEXT only:
	//
	//  - an entry is never dropped for being old. Dropping it would turn a later
	//    `collect`/`wait` into `missing` — "result lost" — and `runId`/`round` are
	//    what a cache hit claims (D9/D10), so the metadata has to outlive the text.
	//  - an entry is only stripped when it can be rebuilt: `snapshot.outputFile`
	//    exists. The orchestrator writes that file for every terminal, non-empty
	//    output (`writeOutputFile`), so this covers the production collect path
	//    (in-process and rpc alike). Entries with no `outputFile` — a host-supplied
	//    `collect` that never persisted, or a run dir whose write failed — are
	//    PINNED: their text stays, and `noticeQueueStats().finished.pinnedBytes`
	//    makes that visible instead of silent.
	const outputBytes = (text: string): number => Buffer.byteLength(text, "utf8");

	/**
	 * Shrink one entry to its preview head, keeping every other field.
	 *
	 * Only the ENTRY's own `snapshot` copy is touched (see `rememberFinished`), so a
	 * result that was already handed to a caller keeps its text.
	 *
	 * The head is copied through UTF-8 on purpose: `String.prototype.slice` returns a
	 * V8 *sliced* string that keeps the whole parent alive, so a 4KB head of a 200KB
	 * output retained all 200KB and the bound did nothing (measured: 10.0MB resident
	 * after stripping every entry). Re-encoding produces a flat string with no link to
	 * the dropped text.
	 */
	const stripFinishedText = (entry: FinishedResult): void => {
		const text = entry.snapshot.output;
		const head = text.length > FINISHED_OUTPUT_HEAD_CHARS ? text.slice(0, FINISHED_OUTPUT_HEAD_CHARS) : text;
		entry.snapshot.output = Buffer.from(head, "utf8").toString("utf8");
		entry.bytes = outputBytes(entry.snapshot.output);
		entry.stripped = true;
	};

	/**
	 * Re-read the full text a stripped entry stands for, from `snapshot.outputFile`.
	 * Returns whether the entry now holds the whole text (`false` = a degraded read:
	 * no file recorded, or the run dir was cleaned up). A no-op that returns `true`
	 * for an entry that was never stripped.
	 */
	const rehydrateFinished = (entry: FinishedResult): boolean => {
		if (!entry.stripped) return true;
		const file = entry.snapshot.outputFile;
		if (!file) return false;
		let text: string;
		try {
			text = fs.readFileSync(file, "utf8");
		} catch {
			// The file is gone (deleted run dir). Keep the head and the metadata: a
			// degraded read, never a lost result.
			return false;
		}
		if (!text) return false;
		// `writeOutputFile` persists `output.trim() + "\n"`; drop that one newline so a
		// rehydrated snapshot carries the collected text (contract R3 -> §3.3: at most
		// leading/trailing whitespace can differ from the original).
		entry.snapshot.output = text.replace(/\n$/, "");
		entry.bytes = outputBytes(entry.snapshot.output);
		entry.stripped = false;
		return true;
	};

	/**
	 * Enforce the bound. Newest-first: everything inside the per-entry / byte / count
	 * budget keeps its text, everything older is stripped (if it can be rebuilt at
	 * all). `FINISHED_CACHE_MAX_ENTRY_BYTES` is what makes the bound independent of a
	 * single child's output size: a 200KB text is never resident, however new it is.
	 */
	const trimFinished = (): void => {
		const names = [...finished.keys()].reverse();
		let entries = 0;
		let bytes = 0;
		for (const name of names) {
			const entry = finished.get(name);
			if (!entry) continue;
			// Pinned, already stripped, or empty: nothing this pass can reclaim.
			if (entry.stripped || !entry.snapshot.outputFile || entry.bytes === 0) continue;
			if (
				entries < FINISHED_CACHE_MAX_ENTRIES &&
				entry.bytes <= FINISHED_CACHE_MAX_ENTRY_BYTES &&
				bytes + entry.bytes <= FINISHED_CACHE_MAX_OUTPUT_BYTES
			) {
				entries += 1;
				bytes += entry.bytes;
				continue;
			}
			stripFinishedText(entry);
		}
	};

	/**
	 * Insert / replace as the newest entry, then re-apply the bound.
	 *
	 * #349 (review major 1): the entry keeps a SHALLOW COPY of the snapshot. Trimming
	 * mutates `snapshot.output` in place, so storing the reference stripped the text
	 * out of the very object this collect is about to return (`job.collectPromise`),
	 * meaning a large output was delivered as a 4000-char head — and a later eviction
	 * from a DIFFERENT child could still strip a result the parent already held.
	 */
	const rememberFinished = (name: string, runId: string, round: number, snapshot: CollectSnapshot): void => {
		const copy: CollectSnapshot = { ...snapshot };
		const entry: FinishedResult = { runId, round, snapshot: copy, bytes: outputBytes(copy.output), stripped: false };
		// Delete first so a same-name re-insert also becomes the newest entry.
		finished.delete(name);
		finished.set(name, entry);
		trimFinished();
	};

	/**
	 * A cache HIT: the entry is the newest now, and its text is restored before the
	 * caller sees it. Every path that hands a cached snapshot out goes through here —
	 * `wait` and both `collect` seams — so "evicted" is never visible to a caller as
	 * "lost".
	 *
	 * #349 (review major 1): the order is trim-then-rehydrate, and the caller gets a
	 * COPY of the snapshot.
	 *
	 *  - trim FIRST: whatever this hit is about to take out of the budget is decided
	 *    before the text is restored, so the pass the caller reads is the full text
	 *    rather than a head that a later trim would produce anyway.
	 *  - the copy is what makes "evicted" invisible for good: the entry is re-bounded
	 *    right after (so `residentBytes` stays inside R1 at every instant, including
	 *    right after a hit) and that re-bounding mutates the ENTRY's text, which no
	 *    caller holds a reference to any more.
	 *  - the `(runId, round)` the entry was collected in travels with the hit, so a
	 *    caller can label its own bookkeeping with the round this result came FROM
	 *    rather than with the live job's current one (D9/F1).
	 */
	const cachedFinished = (name: string): FinishedResult | undefined => {
		const entry = finished.get(name);
		if (!entry) return undefined;
		finished.delete(name);
		finished.set(name, entry);
		trimFinished();
		const restored = rehydrateFinished(entry);
		const snapshot: CollectSnapshot = { ...entry.snapshot };
		if (!restored) snapshot.outputTruncated = true;
		// Re-apply the bound: the hit needed the whole text, the cache does not keep it.
		trimFinished();
		return { runId: entry.runId, round: entry.round, snapshot, bytes: entry.bytes, stripped: entry.stripped };
	};
	/**
	 * D4a (v1.11): the `(runId, round)` a snapshot was COLLECTED in — the minimal origin
	 * stamp the degraded path cannot do without.
	 *
	 * P4c deleted the claim model and, with it, the original use of this map. The stamp
	 * itself is NOT part of that model: the notice entry has to be labelled with the
	 * round the result BELONGS to, and `track()` (steer / continue) bumps `job.round`
	 * while a collect is still in flight. Labelling with the live round puts round 1's
	 * snapshot on ROUND 2's `deliveredOnce` key in a session with no projection, and
	 * round 2's own completion is then filtered as "already sent" — one result silently
	 * lost (the reviewer's probe: two pending notices, one delivered).
	 *
	 * Scope, frozen (§3 D4a): a LABEL, nothing else. No claim is taken from it, nothing
	 * is revoked, and `owesDelivery` never reads it — the delivery verdict is the
	 * projection (D4); this map only decides which round an entry SPEAKS about.
	 *
	 * Written in exactly one place (`ensureCollect`, when the collect lands) and read in
	 * exactly one (`watch`'s terminal branch). A snapshot nobody collected here has no
	 * entry, and the caller falls back to the live job.
	 */
	const snapshotOrigins = new WeakMap<CollectSnapshot, { runId: string; round: number }>();
	const originOf = (
		snapshot: CollectSnapshot | undefined,
		job: TrackedJob,
	): { runId: string; round: number } =>
		(snapshot ? snapshotOrigins.get(snapshot) : undefined) ?? {
			runId: job.runId,
			round: job.round,
		};

	/**
	 * D10 #1: the reporting round per child name.
	 *
	 * Monotonic and never rewound: reusing a number would let a new round inherit an
	 * old round's notice (and so swallow its completion). `track()` — the only writer —
	 * bumps it on BOTH branches, because both start a new reporting round.
	 */
	const roundOfName = new Map<string, number>();
	const nextRoundFor = (name: string): number => {
		const next = (roundOfName.get(name) ?? 0) + 1;
		roundOfName.set(name, next);
		return next;
	};

	// Smart join: batch completion notices per runId. The deliver sink merges
	// the buffered entries into ONE grouped message; an unbatched single-child
	// notice keeps the legacy "Background task …" format byte-for-byte (that
	// shape is asserted by pre-existing tests and muscle memory alike).
	let joinConfig: JoinConfig = deps.joinConfig ?? {
		mode: DEFAULT_JOIN_MODE,
		flushMs: DEFAULT_FLUSH_MS,
	};

	// Run-scoped completion outbox (D-A). While a parent RUN is live a completion
	// is held here and delivered at the run boundary (`agent_settled`) — one
	// waking message per boundary (D2). This is the ONLY deferral point: the join
	// window above batches stragglers and never waits on a busy parent (D-I).
	//
	// D1: there is no second delivery moment. The host cannot retract a message,
	// so a notice sent during a live run is visible at a time that is NOT the
	// moment the claim filter judged it — which is where the duplicate came from.
	//
	// D-H: the default is `false`, so a host (or a test) that never signals a
	// run start keeps today's immediate-send behaviour byte for byte.
	let parentRunActive = false;
	/**
	 * `root-mail-run-boundary-v1` D2 (review F3): the disposers this runtime owns, per
	 * nodeId. Each one only removes the reader IT published, so two runtimes can never
	 * withdraw each other's registration; the reader itself is still the closure above
	 * (`() => parentRunActive`), never a stored boolean (display-liveness R1).
	 */
	const runActivityReleases = new Map<string, () => void>();
	const outbox: QueuedNotice[] = [];
	let outboxTimer: JoinSchedulerHandle | undefined;
	let heldOverCap = 0;

	/**
	 * D6: the oldest held batch that can still produce a message.
	 *
	 * Identical predicate to `noticeQueueStats().pending`, and deliberately shared
	 * with it in spirit: a batch whose every member is already claimed is dead
	 * weight (the flush drops it, no message can come of it), so pricing a timer or
	 * a count off `outbox[0]` would describe a notice nobody is waiting for. The
	 * arm, `oldestAgeMs` and `heldOverCap` must all name the SAME entry.
	 */
	const oldestDeliverable = (): QueuedNotice | undefined => {
		// P4b/D4: the same projection `deliverBatch` will use, so the arm, `oldestAgeMs`
		// and `heldOverCap` name the notice the flush is actually going to send.
		const projection = ledgerProjection();
		return outbox.find((item) =>
			item.entries.some((entry) =>
				owesDelivery(entry.runId, entry.name, entry.round, projection, entry.input.artifactId),
			),
		);
	};

	/**
	 * Arm the horizon timer off the oldest STILL-DELIVERABLE entry.
	 *
	 * D6: this timer only COUNTS. Reaching the horizon increments `heldOverCap`
	 * once per notice and re-arms for another full window; it never sends, because
	 * the only delivery moment is a run boundary (D1) and a timer firing while the
	 * run is still live is by definition not one.
	 *
	 * `fullWindow` re-arms from NOW rather than from the head's `enqueuedAt`: once
	 * the head is past the horizon (or has already been counted) an age-derived
	 * delay is 0, which would turn the counter into a tight loop instead of one
	 * tick per window.
	 */
	const armOutboxTimer = (fullWindow = false): void => {
		if (outboxTimer || disposed) return;
		// Nothing deliverable ⇒ no timer at all. Arming anyway is what let the count
		// keep growing while `pending === 0`.
		const oldest = oldestDeliverable();
		if (!oldest) return;
		// A head that is already claimed can never be the head here, and one that has
		// already been counted is priced off the count (a full window), not off its
		// age.
		const delay =
			fullWindow || oldest.overCapAt !== undefined
				? MAX_PENDING_AGE_MS
				: Math.max(0, oldest.enqueuedAt + MAX_PENDING_AGE_MS - now());
		// `live` proves this callback is the CURRENT arm. A cancelled-but-still-
		// invoked timer (a zombie queued before the cancel landed) must be a strict
		// no-op: otherwise it would clear the live timer's handle and count a hold
		// that belongs to a notice nowhere near its horizon (and, before v2, send
		// one).
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
			// Same head the arm was priced off: a dead-weight queue head (every member
			// already claimed) is neither counted nor re-armed.
			const next = oldestDeliverable();
			if (!next) return;
			if (now() < next.enqueuedAt + MAX_PENDING_AGE_MS) {
				// Fired while the oldest notice is still younger than the horizon (a
				// coarse timer or a backwards clock step): re-arm for the remaining age.
				armOutboxTimer();
				return;
			}
			if (next.overCapAt === undefined) {
				// D6: the horizon is a HEALTH SIGNAL, not a trigger. Nothing is sent — a
				// notice that outlives its parent run stays in the outbox until the next
				// run boundary or `dispose()` — and the count is what a diagnostic reads.
				// One count per NOTICE: the next 80s of the same hold add nothing.
				next.overCapAt = now();
				heldOverCap += 1;
			}
			armOutboxTimer(true);
		});
		outboxTimer = {
			cancel: () => {
				live = false;
				handle.cancel();
			},
		};
	};

	/**
	 * `subagent-renewal-v1` D3: the proposal the notice text may carry — built at the
	 * moment the text is built.
	 *
	 * P4c moved this out of the watch. With the two job flags gone, every settle reaches
	 * `join.onTerminal`, so asking the host hook there would cost a
	 * run-registry scan per finished child — including the results the projection is about
	 * to filter out (`control-scope-scan`'s #344 guard measures exactly that). The hook's
	 * own rules are unchanged: it returns `undefined` for every case that must not offer a
	 * renewal (completed / still running / opted out / no baseline), so "absent" is
	 * meaningful, not a missing wire.
	 */
	const withRenewalProposal = (entry: DeliverableEntry): CompletionInput => {
		// D4b (v1.11): renewal is a COMPLETED result's affordance. The collect-failure
		// notice never carried one before P4c, and asking the host here both changes that
		// visible text and pays a `listRuns()` + `loadCatalog()` scan per failure.
		if (entry.input.execution?.status !== "completed") return entry.input;
		const renewal = deps.getRenewalProposal?.(entry.name, entry.input.execution);
		return renewal === undefined ? entry.input : { ...entry.input, renewal };
	};

	/**
	 * D5: THE single completion exit. Both the join `deliver` sink and the outbox
	 * flush go through here and nowhere else, so the verdict (P4b/D4: the ledger
	 * projection) is consulted at the last possible moment — after the join window and
	 * after the outbox wait, never at `onTerminal` time where a `wait` could still hand
	 * the result to the parent.
	 *
	 * Order is load-bearing:
	 *  1. filter settled entries → empty ⇒ return (this IS "read once, never
	 *     repeated");
	 *  2. hold the STRUCTURE (D4) if the parent run is live, or
	 *  3. format what survives — single & whole ⇒ legacy `Background task …`
	 *     shape, otherwise the grouped one with `stillRunning` recomputed NOW;
	 *  4. send, then record the delivery (`markNotified` / `deliveredOnce`) only after
	 *     a real one: a host rejection (`false`) must mark nothing so the next boundary
	 *     can still deliver it.
	 *
	 * P4c: the TEXT is built at the delivery moment, i.e. AFTER the hold branch. A batch
	 * that is going to be queued allocates no text and asks no host hook — the same shape
	 * `flushOutbox` produces when it re-enters here, and the reason a settle the parent
	 * already collected costs nothing but the projection read.
	 */
	const deliverBatch = (
		entries: readonly DeliverableEntry[],
		triggerTurn: boolean,
		partial: boolean,
	): number => {
		// D10 #4: each entry is judged, and later marked notified, on ITS OWN round — so
		// two unread rounds of one child both survive, while a repeated delivery inside one
		// round is still filtered.
		//
		// P4b/D4: ONE projection read for the whole batch (not one per entry), and the
		// verdict for an entry with an artifact id is that projection alone. A host with no
		// ledger handle degrades to `deliveredOnce` for every member of the batch.
		const projection = ledgerProjection();
		const surviving = entries.filter((entry) =>
			owesDelivery(entry.runId, entry.name, entry.round, projection, entry.input.artifactId),
		);
		if (surviving.length === 0) return 0;
		// D1: a run boundary is the ONLY delivery moment. While the parent run is
		// live the batch is held STRUCTURALLY (D4) — not sent, not even as a
		// followUp: the host cannot retract a message, so anything sent now would
		// become visible at a moment the projection no longer controls (T0 ≠ T2).
		if (parentRunActive) {
			outbox.push({ entries: surviving, triggerTurn, partial, enqueuedAt: now() });
			armOutboxTimer();
			return 0;
		}
		let notice: CompletionNotice;
		if (!partial && surviving.length === 1) {
			notice = formatCompletionNotice(withRenewalProposal(surviving[0]!));
		} else {
			// `stillRunning` is derived from the live job table at the moment of
			// DELIVERY, never stored: a member claimed by `wait`/`collect` while this
			// batch waited is neither an entry nor "still running", so both the
			// header (`N of M`) and the footer stay truthful (W1, W2, D4-§6).
			const delivering = new Set(surviving.map((entry) => entry.name));
			const stillRunning = [...jobs.values()]
				.filter(
					(job) =>
						job.runId === surviving[0]!.runId &&
						// `awaiting` is a TERMINAL marker: the watch has already buffered
						// this child's completion and is merely parked in `retire`. Listing
						// it as "still running" contradicts the completed entry that the
						// very same burst delivered (and D4 recomputes the footer at the run
						// boundary, so that window can be arbitrarily wide). Not done = not
						// retire yet.
						job.state !== "awaiting" &&
						job.state !== "retired" &&
						// D4: only an ARMED watch can deliver a second notice. A utility job
						// (`watching: false`) has no such path, so listing it promises a
						// message that can never come — a false fact, not a hedge.
						job.watching === true &&
						// D4: a job its own liveness hook has declared dead is not "still
						// running". No hook (`undefined`) is not permission to call it dead.
						!(job.isAlive && !job.isAlive()) &&
						// D4 (notice-delivery-v2): a sibling belongs in the footer only if it
						// really will produce another notice. P4b: a LIVE tracked job has no
						// artifact yet (the store writes one only at settle), so this ask never
						// has an id and `owesDelivery` always answers from `deliveredOnce` —
						// 宁少报不假报: a sibling this runtime has not already announced is
						// listed.
						owesDelivery(job.runId, job.name, job.round, projection) &&
						!delivering.has(job.name),
				)
				.map((job) => job.name);
			notice = formatGroupedNotice({
				runId: surviving[0]!.runId,
				entries: surviving.map((entry) => ({ ...withRenewalProposal(entry), status: entry.status })),
				...(stillRunning.length > 0 ? { stillRunning } : {}),
			});
		}
		if (deliverCompletion({ sendMessage: deps.sendMessage }, notice, triggerTurn)) {
			// P4b/D4 step 4: record the delivery. This is the ONLY write on the notice side,
			// and it is per entry, never per batch:
			//   - an artifact id with a projection ⇒ `ledger.markNotified` (write-once:
			//     `COALESCE` keeps the first timestamp, so a replay cannot move it);
			//   - no artifact id / no projection ⇒ `deliveredOnce` for this exact round.
			// A host rejection returns above and reaches NEITHER write, so the notice stays
			// deliverable and the next boundary retries it (D4: “false → do not mark”).
			const at = now();
			for (const entry of surviving) {
				const artifactId = entry.input.artifactId;
				if (artifactId !== undefined && projection) {
					try {
						markNotified(projection.db, { artifactId, consumerId: projection.consumerId, at });
					} catch {
						// D1e: a ledger failure is a diagnostic, never a delivery outcome. Falling
						// back to the memory set keeps the “one notice per result” promise on a
						// broken handle instead of turning the next boundary into a re-send loop.
						deliveredOnce.add(reportKey(entry.runId, entry.name, entry.round));
					}
				} else {
					deliveredOnce.add(reportKey(entry.runId, entry.name, entry.round));
				}
			}
			return 1;
		}
		// Host rejected the send: nothing was marked (D5 step 4), so the notice is still
		// deliverable. `flushOutbox` reacts by putting the item back at the head; the
		// direct (idle-run) path has no queue to put it back into — there the child's
		// session file is the documented recovery path.
		return 0;
	};

	// FIFO, one WAKING message per boundary (D2): the grouped shape belongs to the
	// join layer. N held notices are NOT merged into a synthetic grouped notice —
	// each one is its own completion, and the parent gets the oldest now, the next
	// at the next boundary.
	/**
	 * A2: re-entrancy guard.
	 *
	 * `sendMessage` is a host ACTION, so a host may call straight back into the
	 * runtime from inside it (`agent_start`, a `sendMessage` handler that settles a
	 * nested turn, …). A nested flush would hand out a SECOND waking notice at the
	 * same boundary — the thing D2 forbids and the one thing this loop cannot see
	 * from `parentRunActive` (a send emitted while the host is settling is
	 * deferred). So the inner call is a strict no-op: it delivers nothing and
	 * leaves the queue, the timer and the counter exactly as the outer call has
	 * them.
	 */
	let flushing = false;
	/** Returns how many messages were actually delivered (0 when all was claimed). */
	const flushOutbox = (): number => {
		if (flushing) return 0;
		flushing = true;
		try {
			outboxTimer?.cancel();
			outboxTimer = undefined;
			let sent = 0;
			// One item at a time, not `splice(0)`: a stop must leave the REST of the queue
			// exactly where it was, oldest first (FIFO).
			// `!parentRunActive` is the D1 gate read again per item, so a re-entrant
			// `agent_start` (a send that synchronously starts a new run) stops the loop
			// instead of pushing the next notice into a live turn.
			while (outbox.length > 0 && !parentRunActive) {
				const item = outbox.shift()!;
				// Snapshot AFTER the shift, so a re-queue performed by `deliverBatch`
				// itself is visible as "the queue grew".
				const queuedAfterShift = outbox.length;
				let delivered: number;
				try {
					delivered = deliverBatch(item.entries, item.triggerTurn, item.partial);
				} catch {
					// A2: `shift` + a throw must never lose the notice. Put it back at the
					// HEAD (it is still the oldest) and stop this round; the timer is re-armed
					// below so the hold keeps being observed.
					outbox.unshift(item);
					break;
				}
				if (delivered === 0) {
					if (outbox.length > queuedAfterShift) {
						// `deliverBatch` already re-queued the structure on its own
						// `parentRunActive` branch — one copy is correct, a second would duplicate it.
						break;
					}
					const stillDeliverable = (() => {
						// Same verdict `deliverBatch` just applied (P4b/D4): re-queueing is only
						// correct when the host REJECTED a batch that still owes a notice.
						const projection = ledgerProjection();
						return item.entries.some((entry) =>
							owesDelivery(entry.runId, entry.name, entry.round, projection, entry.input.artifactId),
						);
					})();
					if (stillDeliverable) {
						// Nothing was sent although a member is still unclaimed ⇒ the host REJECTED
						// the send (`deliverCompletion` reports the throw as `false`). The claim is
						// untouched, so the notice is still deliverable: put it back at the head
						// and stop, instead of dropping it silently.
						outbox.unshift(item);
						break;
					}
					// Every member was claimed while it waited: dropping it IS the claim, so it
					// does not count toward the stop condition — the loop moves on.
					continue;
				}
				sent += delivered;
				// D2: one WAKING message per boundary. The stop condition is "a
				// `triggerTurn:true` notice was delivered", never a read of
				// `parentRunActive`: while the host emits `agent_settled`,
				// `pi.sendMessage` is DEFERRED (`_isEmittingAgentSettled`), so the flag
				// cannot tell us that THIS message already started a new run. The rest
				// waits for the next boundary — pushing it into the host queue now
				// would make it visible in a turn that has not started yet, recreating
				// exactly the gap delivery v2 closes.
				if (item.triggerTurn) break;
			}
			if (outbox.length > 0) armOutboxTimer();
			return sent;
		} finally {
			flushing = false;
		}
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
			//
			// D4: decided HERE and carried through the outbox, not re-derived there —
			// the shape belongs to the batching moment, the members do not.
			const partial =
				batch.length !== 1 ||
				!(joinConfig.mode === "each" || join.allSettled(first.runId));
			deliverBatch(batch, batch.some((entry) => entry.triggerTurn), partial);
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
			// #391: a memoized terminal progress belongs to the rows the tree still owns.
			// Without this the map would outlive a collapsed subtree forever. A transient
			// empty snapshot (no ledger identity this tick) drops the memo and costs one
			// re-fold per row afterwards — bounded, and only on that path.
			for (const nodeId of terminalProgress.keys()) if (!tree.has(nodeId)) terminalProgress.delete(nodeId);
		}
		const nodes = [...tree.values()].map((node) => ({ ...node }));
		return mergePhaseMachines(mergeSpawnModes(nodes));
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

	/**
	 * #298: attach the declaring team's machine to the node that owns it.
	 *
	 * Only a team root declares `phases:`, so children inherit it downward: showing
	 * an empty machine on a worker would suggest it has none, when in fact it is
	 * governed by its lead's. The nearest ancestor that resolves a machine wins.
	 *
	 * #372 B: "resolves" now asks the NODE first and the ROLE second. A team that
	 * declared its machine inline at dispatch (#371 §2) has no card, so the role
	 * lookup could never find it; the node lookup reads the declaration recorded at
	 * launch. Order matters and matches the contract (inline > card > none).
	 *
	 * Only a team root is asked, because only a team root can carry that record: the
	 * launch guards refuse `phases` for every other role (G2/G3), and the child
	 * record is written on exactly that branch. Asking for a worker could only ever
	 * answer `undefined`, and the answer costs a runs-registry read — so the gate
	 * keeps a render of N workers from paying for N lookups. Descendants still
	 * inherit: the walk reaches the team root above them (see the header comment),
	 * which is the node the lookup is made for.
	 *
	 * #372 m3/m4: answers are memoized for the DURATION OF THIS SNAPSHOT. The walk
	 * visits the same team root from every descendant, so without the memo a team of
	 * N asks N+1 times — and an UNDECLARED team would pay a registry read once per
	 * visitor on every repaint. A miss is memoized too (it is a real answer: "this
	 * team declared nothing"), and the memo dies with this call, so the host's own
	 * caches keep owning cross-render invalidation.
	 */
	const mergePhaseMachines = (nodes: TreeNodeSnapshot[]): TreeNodeSnapshot[] => {
		const byId = new Map(nodes.map((node) => [node.id, node]));
		/** One lookup per node per snapshot (see the memo note above). */
		const declaredCache = new Map<string, PhaseMachine | undefined>();
		const declaredFor = (cursor: TreeNodeSnapshot): PhaseMachine | undefined => {
			if (cursor.role !== "centurion") return undefined;
			if (declaredCache.has(cursor.id)) return declaredCache.get(cursor.id);
			// The record lives in the run whose orchestrator DISPATCHED this node: the
			// PARENT's run (#372 M1), never "any run that happens to know this id".
			const parentRunId = cursor.parentId ? byId.get(cursor.parentId)?.runId ?? null : null;
			const machine = deps.getPhaseMachineForNode?.({ id: cursor.id, role: cursor.role, parentRunId });
			declaredCache.set(cursor.id, machine);
			return machine;
		};
		for (const node of nodes) {
			let cursor: TreeNodeSnapshot | undefined = node;
			let hops = 0;
			while (cursor && hops < 64) {
				const machine = declaredFor(cursor) ?? deps.getPhaseMachine?.(cursor.role);
				if (machine) {
					node.phaseMachine = machine;
					break;
				}
				const parentId: string | null = cursor.parentId ?? null;
				cursor = parentId ? byId.get(parentId) : undefined;
				hops += 1;
			}
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

	/**
	 * #391 A: the sweep's progress for a terminal row.
	 *
	 * `undefined` means "this row is live" — the caller then parses the file itself,
	 * because a live transcript is still growing. A terminal row is answered from
	 * the memo until its `updatedAt` moves (re-settled) or the TTL expires.
	 */
	const terminalProgressFor = (node: TreeNodeSnapshot): LiveProgress | undefined => {
		if (!node.sessionFile || !isFinalRowStatus(node.status)) return undefined;
		const at = now();
		const cached = terminalProgress.get(node.id);
		if (
			cached &&
			cached.sessionFile === node.sessionFile &&
			cached.updatedAt === node.updatedAt &&
			at - cached.checkedAt < TERMINAL_PROGRESS_TTL_MS
		) {
			return cached.progress;
		}
		const progress = progressFromSessionFile(node.sessionFile);
		// Never memoize an EMPTY answer. `progressFromSessionFile` folds a missing or
		// unreadable file to `{}`, and `session.ts` deliberately refuses to cache
		// that (a pinned zero would outlive the failure — the "token rate reads 0
		// for the agent's entire lifetime" regression). Keeping the same rule here
		// costs one retry per tick for a metadata-only transcript, and nothing for
		// the ordinary case: a settled file with content always yields fields.
		if (Object.keys(progress).length === 0) return progress;
		terminalProgress.set(node.id, {
			sessionFile: node.sessionFile,
			updatedAt: node.updatedAt,
			progress,
			checkedAt: at,
		});
		return progress;
	};

	const statusEntries = (): StatusEntry[] => {
		const nodes = snapshotNodes();
		/**
		 * #391 C: one parse per distinct session file per sweep. Rows can share one
		 * transcript (a re-followed job next to its ledger row, a resume that reuses
		 * the path), and paying for it twice in one tick is pure waste.
		 */
		const liveByFile = new Map<string, LiveProgress>();
		const liveFor = (file: string): LiveProgress => {
			const cached = liveByFile.get(file);
			if (cached) return cached;
			const progress = progressFromSessionFile(file);
			liveByFile.set(file, progress);
			return progress;
		};
		const jobEntries = [...jobs.values()]
			.filter((job) => job.state !== "retired")
			.sort((a, b) => a.spawnedAt - b.spawnedAt)
			.map((job) => {
				const storedNode = storedNodeForJob(job, nodes);
				const mappedIdentity = deps.getTreeIdentity?.(job.name);
				const identity = job.nodeId || mappedIdentity?.nodeId || storedNode
					? identityForJob(job, storedNode)
					: undefined;
				// The memo is keyed by node; the job is only allowed to use it when both
				// point at the same transcript (a re-followed record can disagree).
				const live = (storedNode && storedNode.sessionFile === job.sessionFile
					? terminalProgressFor(storedNode)
					: undefined) ?? liveFor(job.sessionFile);
				return statusEntryFromJob(
					job,
					live,
					identity,
					storedNode,
					finished.get(job.name)?.snapshot.execution.status,
					deps.getLiveDecode?.(job.name),
				);
			});
		const seen = new Set(jobEntries.flatMap((entry) => entry.nodeId ? [entry.nodeId] : []));
		const persistedEntries: StatusEntry[] = [];
		for (const node of nodes) {
			if (seen.has(node.id)) continue;
			const details = activity.get(node.id);
			const live = node.sessionFile ? terminalProgressFor(node) ?? liveFor(node.sessionFile) : undefined;
			persistedEntries.push(statusEntryFromNode(node, live ?? {}, details, deps.getLiveDecode?.(node.name)));
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
			// D18 (`viewer-transcript-parity-v1` §9): streamed-detail chunks never change
			// tree state, so subscribing the widget painter to them would pay a
			// synchronous SQLite subtree scan + a widget repaint per token (#261). One
			// predicate, three call sites — the live overlay and the classic tree view
			// call the same `isDetailDeltaEvent`.
			.filter((type) => !isDetailDeltaEvent(type))
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
			// D7b/D10 #6: the run id AND the round are captured when the collect STARTS,
			// because `track()` on an existing job rewrites `job.runId` and bumps
			// `job.round` without touching `generation`.
			const origin = { runId: job.runId, round: job.round };
			job.collectPromise = (async () => {
				const snapshot = await job.collect(signal ? { signal } : undefined);
				// D4a/F1: stamp the round this result came FROM, before anything can bump
				// the live one. Every entry built from this snapshot speaks about `origin`,
				// never about `job.round` (which a `track()` during this collect may have
				// moved on) — that label is also the `deliveredOnce` key on the degraded
				// path, so getting it wrong loses the NEXT round's notice.
				snapshotOrigins.set(snapshot, origin);
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
				//
				// F2: re-validate AFTER the `persist` await, and include the round. A
				// `track()` landing during persist does not bump `generation`, so `current`
				// alone would let this stale round-1 write-back undo the invalidation
				// `track()` just performed (D7b) — and the next `wait` would serve the
				// previous round's result.
				const stillCurrent =
					jobs.get(job.name) === job &&
					job.generation === generation &&
					job.round === origin.round;
				if (
					stillCurrent &&
					!snapshot.blocked &&
					snapshot.execution.status !== "running"
				) {
					// #349: remember as the newest entry and keep the resident text bounded.
					rememberFinished(job.name, origin.runId, origin.round, snapshot);
				}
				return snapshot;
			})();
		}
		return job.collectPromise;
	};

	/**
	 * Wait for one child. Shares the in-flight watch's collect promise, so the watch
	 * and this wait never collect the child twice.
	 *
	 * P4c: this no longer arbitrates anything. The old shape claimed the result here so
	 * the watch's two flags would skip their notice; the verdict is the
	 * ledger projection now (`result-ledger-v1` D4), taken at delivery time inside
	 * `deliverBatch` — a result the parent READ through this wait left the projection by
	 * `read_bytes`, so its notice is filtered there and not here. A timeout or an abort
	 * therefore has nothing to "restore": nothing was ever taken.
	 */
	const waitOne = async (
		name: string,
		timeoutMs: number,
		signal?: AbortSignal,
	): Promise<WaitResult> => {
		const job = jobs.get(name);
		if (!job) {
			const cached = cachedFinished(name);
			if (cached) {
				// D2(a)/D9: a cached hit hands the parent the same terminal result. The
				// job is already released here, which is precisely the W2 window: the
				// notice for this child may still be in the outbox, and only the
				// projection (the read row the tool layer writes) may settle it.
				return { name, snapshot: cached.snapshot };
			}
			return { name, missing: true };
		}
		if (signal?.aborted) {
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
				if (!job.watching) runtime.watch(name);
				return { name, interrupted: true };
			}
			const snapshot = outcome;
			if (
				snapshot.blocked ||
				!shouldRecycleAfterCollect(snapshot.execution.status)
			) {
				// Not terminal: keep the RPC child and let the watch flow handle it.
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
					job.collectPromise = undefined;
					runtime.watch(name);
				}
				return {
					name,
					stillRunning: true,
					elapsedMs: Math.max(0, now() - job.spawnedAt),
				};
			}
			// The snapshot is terminal and IS the delivery — but the delivery is
			// recorded by whoever hands the text to the parent (the tool layer's
			// `markRead`, D3b), never by this seam, which cannot know whether the caller
			// renders it. Nothing is claimed before the retire await below: a flush
			// landing inside that await is filtered by the projection, which at worst
			// repeats one notice (D3: 宁多推一条，不静默丢).
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
				// The watch is still in flight and shares this collect promise, so the
				// real completion still reaches the parent through it.
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
				// D10 #1: steering/continuing a live child starts a NEW reporting round.
				// Nothing is revoked here: the delivery verdict belongs to the ledger
				// projection (`result-ledger-v1` D4), which is scoped by artifact id, so the
				// PREVIOUS round's unread notice keeps its own row and stays deliverable
				// while this round gets an id of its own.
				//
				// D7b: the finished cache is a ONE-ROUND cache. `runId` is the PARENT
				// run id, so every round of the same child shares it — a surviving
				// cache entry would hand round N the snapshot of round N-1 and, worse,
				// settle round N's failure notice against the wrong artifact. Any
				// (re)track starts a new round.
				existing.round = nextRoundFor(input.name);
				finished.delete(input.name);
				join.addPending(input.runId, input.name);
				ensureTimer();
				refreshUi();
				return existing;
			}
			const job: TrackedJob = {
				...input,
				...identity,
				spawnedAt: input.spawnedAt ?? now(),
				// D10 #1: a fresh track (launch / resume / re-follow after a release) is
				// a new round, drawn from the same monotonic per-name counter.
				round: nextRoundFor(input.name),
				state: "working",
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
			// P4c: nothing is claimed or revoked here. The round this job just drew from
			// the monotonic counter describes a result the ledger has not seen yet, and the
			// PREVIOUS round's unread artifact keeps its own row (D4/D10).
			// D7b: same one-round rule as the revive branch above — a fresh job must
			// never be served the previous round's snapshot.
			finished.delete(job.name);
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
					// P4c: no flag to reset. Whether the next completion may notify is
					// decided at delivery time by the projection (D4); a non-terminal
					// snapshot wrote no `notified_at`, so the real completion still owes it.
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
							job.state = "working";
							// Approval resumed the child; its completion writes a fresh
							// artifact, so the projection owes that one a notice (D4).
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
					// P4c: THE GATE IS GONE (D4). It used to ask two job flags standing in
					// for "the parent already has this result". Whether the notice is owed
					// is a question about the ledger now, and it is asked at the last
					// possible moment in `deliverBatch`, where the answer covers BOTH
					// routes (a tool result the parent read, and a notice already sent).
					//
					// The round label is the one this SNAPSHOT was collected in (D4a/F1),
					// not the live job's: a `track()` during the collect bumps `job.round`,
					// and labelling with it would put this result on the NEXT round's
					// `deliveredOnce` key — the next round's own notice would then be
					// filtered as already sent. With a projection the label is only the
					// fallback key, but the degraded path has nothing else.
					const entryOrigin = originOf(snapshot, job);
					join.onTerminal({
						runId: entryOrigin.runId,
						name: job.name,
						round: entryOrigin.round,
						input: {
							name: job.name,
							agent: job.agent,
							execution: snapshot.execution,
							output: snapshot.output,
							...(snapshot.outputFile ? { outputFile: snapshot.outputFile } : {}),
							// §3 D1: the artifact this notice is about, straight off the collect
							// (absent for a running snapshot / empty output / no ledger row). The
							// rendered text does not read it; the delivery projection does.
							...(snapshot.artifactId ? { artifactId: snapshot.artifactId } : {}),
							sessionFile: job.sessionFile,
							acceptance: snapshot.acceptance,
							recycled: shouldRecycleAfterCollect(
								snapshot.execution.status,
							),
							// D3 (subagent-renewal-v1): the proposal is attached where the
							// notice TEXT is built — `withRenewalProposal` in `deliverBatch` —
							// not here, because a settle the projection filters out must not
							// pay for it (P4c).
						},
						triggerTurn,
					});
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
						// The blip was never a verdict — nothing was delivered, nothing was
						// marked notified, so the real completion still owes its notice (D4).
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
					// Collect failures join the batch too, as a failed entry. No snapshot
					// object exists here, so `originOf` answers with the live job (there is
					// no artifact id either — the projection answers from `deliveredOnce`).
					const failureOrigin = originOf(undefined, job);
					join.onTerminal({
						runId: failureOrigin.runId,
						name: job.name,
						round: failureOrigin.round,
						input: collectFailureInput(job.name, error),
						triggerTurn,
					});
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
				// P4c/D12: the bare snapshot, as before notice-claim-v1. Whether this
				// result is "delivered" is decided by the read the TOOL layer declares
				// after the parent really got the text (D3b) — never by the seam.
				return ensureCollect(job);
			}
			const cached = cachedFinished(name);
			if (cached) return Promise.resolve(cached.snapshot);
			return undefined;
		},

		consumeCollectInterruptible(name, signal) {
			const job = jobs.get(name);
			if (!job) {
				const cached = cachedFinished(name);
				if (!cached) return undefined;
				return Promise.resolve(cached.snapshot);
			}
			if (signal.aborted) return Promise.resolve(undefined);
			const pending = ensureCollect(job, signal);
			return new Promise<CollectSnapshot | undefined>((resolve, reject) => {
				let done = false;
				const cleanup = () => signal.removeEventListener("abort", onAbort);
				const onAbort = () => {
					if (done) return;
					done = true;
					cleanup();
					// Nothing to hand back: this seam took nothing (P4c).
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
			refreshUi();
		},

		rewatch(name, opts) {
			const job = jobs.get(name);
			if (!job || disposed) return;
			job.collectPromise = undefined;
			job.settledAt = undefined;
			job.state = "working";
			finished.delete(name);
			// P4c: `rewatch` used to revoke this round's claim and drop every queued /
			// buffered copy of the name — the two ways to say "tell me again" in a model
			// whose memory was the only record. The projection has no revoke API (D4), so
			// what this call still does is re-arm the watch, and the NEXT completion
			// writes a fresh artifact that the projection owes a notice for.
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
			// P4c: `join.remove(name)` and nothing else. The buffered-drop safety net
			// that used to sit here (`dropBufferedRound`, gated on the claim) is gone with
			// the claim: a buffered entry is now filtered by the projection at the flush,
			// which is the one authority that covers every copy — the window buffer, the
			// outbox, mode "each" and a group that flushed before the release.
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
				const executionStatus = finished.get(job.name)?.snapshot.execution.status;
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

		publishRunActivity(nodeId: string) {
			// Review F2: a LATE publish (an `onLegion` callback or a microtask that lands
			// after the session went away) must not install a reader on a disposed runtime —
			// it would freeze at whatever `parentRunActive` happened to be, and no teardown
			// would ever run to withdraw it. No-op, which is the fail-open direction (D3).
			if (disposed) return;
			// D2: idempotent — re-publishing for the same node drops this runtime's previous
			// reader (ownership-checked, so it cannot touch another runtime's) and takes a
			// fresh one. Bounded by the number of distinct nodeIds, not by adoption count.
			runActivityReleases.get(nodeId)?.();
			runActivityReleases.set(nodeId, publishLegionRunActivity(nodeId, () => parentRunActive));
		},

		notifyParentSettled() {
			parentRunActive = false;
			flushOutbox();
			refreshUi();
		},

		noticeQueueStats(): NoticeQueueStats {
			// Only batches that still owe a notice count: everything else is already
			// settled — read to EOF (D6) or already announced (D4) — and will be filtered
			// out at flush. The FLUSH end is deliberately unchanged — it re-reads the
			// projection, which is what makes the ledger authoritative. The horizon timer
			// and `heldOverCap` use the same predicate (`oldestDeliverable`), so `pending`,
			// `oldestAgeMs` and the count all describe the same notice.
			const projection = ledgerProjection();
			const deliverable = outbox.filter((item) =>
				item.entries.some((entry) =>
					owesDelivery(entry.runId, entry.name, entry.round, projection, entry.input.artifactId),
				),
			);
			const oldest = oldestDeliverable();
			// #349: the completion cache's footprint, so a long session can see it grow
			// (and see what it CANNOT reclaim — a pinned entry has no `outputFile`).
			let residentBytes = 0;
			let pinnedBytes = 0;
			let stripped = 0;
			for (const entry of finished.values()) {
				residentBytes += entry.bytes;
				if (entry.stripped) stripped += 1;
				if (!entry.snapshot.outputFile) pinnedBytes += entry.bytes;
			}
			return {
				pending: deliverable.length,
				oldestAgeMs: oldest ? Math.max(0, now() - oldest.enqueuedAt) : 0,
				heldOverCap,
				finished: {
					entries: finished.size,
					residentBytes,
					stripped,
					pinnedBytes,
				},
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
			// `root-mail-run-boundary-v1` D2 (review F2): withdraw FIRST. Everything below is
			// host-facing teardown (`unsubscribeRpcEvents`, `join.dispose`, `ledgerDb.close`)
			// and may throw; a reader left registered by a throw here would answer from a
			// closure nobody drives any more — a fail-CLOSED gate, the one direction D3
			// forbids. F3: each disposer only drops the reader this runtime published.
			for (const release of runActivityReleases.values()) release();
			runActivityReleases.clear();
			for (const job of jobs.values()) job.unsubscribeRpcEvents?.();
			jobs.clear();
			finished.clear();
			// D4: the degraded-path memory is session state — `dispose()` is the end of this
			// runtime's delivery authority, not a boundary that may leak into a successor.
			deliveredOnce.clear();
			unknownArtifactReported.clear();
			roundOfName.clear();
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
	live: LiveProgress,
	identity?: LegionTreeIdentity,
	node?: TreeNodeSnapshot,
	executionStatus?: string,
	liveDecode?: number,
): StatusEntry {
	const model = live.model ?? job.model ?? node?.model ?? undefined;
	const thinking = job.thinking;
	const terminalNode = node && isFinalRowStatus(node.status);
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
		// D5: the measured denominator only appears when the supervisor actually
		// observed a stream; absence keeps the row on `generationMs` upstream.
		...(liveDecode !== undefined ? { decodeMs: liveDecode } : {}),
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
	live: LiveProgress,
	activity?: NodeActivity,
	liveDecode?: number,
): StatusEntry {
	const lastActivityAt = latestActivityAt(
		node.updatedAt,
		activity?.turnStartedAt,
		activity?.turnEndedAt,
	);
	// An in-process child has no tracked job for its whole first run: spawnChild()
	// awaits the whole agent run, so the job (and its sessionFile plumbing in
	// statusEntryFromJob) does not exist yet. The node row does carry the session
	// file, so `statusEntries()` resolves its progress directly — otherwise the
	// ledger only has a tokens_out row after settle and the token rate reads 0 for
	// the agent's entire lifetime.
	// #391: that resolution is the caller's job now, so a terminal row can be
	// answered from the memo instead of a per-tick fold (`live` is `{}` when the
	// row has no session file).
	const tokensOut = live.tokensOut ?? node.tokensOut;
	return {
		name: node.name,
		agent: node.role,
		state: node.status,
		startedAt: node.createdAt,
		...(isFinalRowStatus(node.status) ? { finishedAt: node.updatedAt } : {}),
		...(node.phase ? { phase: node.phase } : {}),
		...(node.kind ? { kind: node.kind } : {}),
		// Ledger-only path (D-R8.2): the `nodes` table has no `thinking` column and
		// is deliberately not migrated, so this entry carries the model alone. Do
		// not synthesize a level here — `modelLabel` folds one in only when it is
		// actually known.
		...(node.model ? { model: node.model } : {}),
		...(node.spawnMode ? { spawnMode: node.spawnMode } : {}),
		...(live.usageTotal ? { tokensTotal: live.usageTotal } : node.tokensTotal ? { tokensTotal: node.tokensTotal } : {}),
		...(tokensOut ? { tokensOut } : {}),
		...(live.generationMs ? { generationMs: live.generationMs } : {}),
		...(liveDecode !== undefined ? { decodeMs: liveDecode } : {}),
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
