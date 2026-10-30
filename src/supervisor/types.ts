/**
 * M1 RPC supervisor contracts and the narrow client adapter seam used by tests.
 */

import type { RpcClientOptions as PiRpcClientOptions } from "@earendil-works/pi-coding-agent";
import type { Writable } from "node:stream";
import type { BuildArgsInput } from "../runs/args.ts";
import type { ChildLaunchContext } from "./child-context.ts";
import type { UIProxy } from "./ui-proxy.ts";

/**
 * Input to one child launch. `name` is the registry key supplied by the caller
 * (the tree node id in v2); this layer does not sanitize or expand it.
 */
export interface SpawnInput extends Omit<BuildArgsInput, "cwd" | "includeTask"> {
	name: string;
	/** Working directory for the child Pi process. */
	cwd: string;
	/** Environment overlay passed to RpcClient. */
	env?: Record<string, string>;
	/**
	 * In-process lineage identity (spawn-default-inprocess-v3 D5).
	 *
	 * Deliberately NOT named `childContext`: that inherited `BuildArgsInput`
	 * field is the *string* settings-injected prompt context, and an interface
	 * cannot narrow an inherited member to an object type (TS2430). The two
	 * channels are unrelated — one is prompt text, this one is identity.
	 *
	 * Only the inprocess backend consumes it; RPC keeps using env lineage.
	 * Absent → InProcessSupervisor derives a minimal fallback context.
	 */
	childLaunchContext?: ChildLaunchContext;
	/** Whether to remove Legion lineage identity from the inherited environment. */
	stripLegionIdentity?: boolean;
	/** Optional Pi CLI entry point override. */
	cliPath?: string;
}

/** Handle returned after the RPC process accepts its first prompt. */
export interface ChildHandle {
	name: string;
	sessionFile: string;
	pid?: number;
}

/** Process id and process group id for one descendant of a supervised child. */
export interface DescendantInfo {
	pid: number;
	pgid: number;
}

/** Injectable options for process lifecycle handling in RpcSupervisor. */
export interface RpcSupervisorOptions {
	/** Called with the refusal text when the memory gate blocks a spawn (UI notify hook). */
	onSpawnRefused?: (message: string) => void;
	/** Override the available-memory probe (MB) in tests. */
	memoryAvailable?: () => number;
	/** Replace the Pi client constructor in unit tests. */
	clientFactory?: RpcClientFactory;
	/** In-memory by default; M1-integration supplies a real TUI consumer. */
	uiProxy?: UIProxy;
	/** Grace period after stdin close before SIGTERM. */
	retireTimeoutMs?: number;
	/** Grace period for a child to exit after SIGTERM. */
	signalTimeoutMs?: number;
	/** Grace period for a child to exit after SIGKILL. */
	killTimeoutMs?: number;
	/** Enumerate process descendants before retiring a child. */
	enumerateDescendants?: (rootPid: number) => DescendantInfo[];
	/** Signal a PID or process group while sweeping descendants. */
	signalProcess?: (target: number, signal: NodeJS.Signals) => boolean;
}

/** Result of waiting for a child turn to settle or for its process to exit. */
export interface SettleResult {
	/** True only when Pi emitted `agent_settled`. */
	settled: boolean;
	/** True when the process exited before a settle event was observed. */
	abnormal: boolean;
	aborted?: boolean;
	exitCode?: number | null;
	signal?: NodeJS.Signals | null;
	reason?: string;
}

/** Cumulative usage reported by the Pi RPC `get_session_stats` command. */
export interface UsageSnapshot {
	tokensIn: number;
	tokensOut: number;
	costUsd: number;
}

/**
 * What a `steer` call actually achieved (#313).
 *
 * - `"queued"`: the text sits behind the child's in-flight work and is consumed
 *   at its next turn boundary — the model has not seen it yet.
 * - `"accepted"`: the call started a turn with the text (the child was idle, so
 *   there was no queue to wait in). Still not proof the model read it.
 * - `"intercepted"`: an input handler consumed the text before it was ever
 *   queued — the child never saw it.
 *
 * There is deliberately no `"delivered"`: no seam observes the model reading the
 * text, so any such claim would be invented.
 */
export type SteerDisposition = "queued" | "accepted" | "intercepted";

/**
 * Normalize the SDK's disposition vocabulary into {@link SteerDisposition}
 * (#313 D2). The only place this mapping happens.
 *
 * `"handled"` is the SDK's *interception* signal, never delivery:
 * `_queueUserInput` returns it **before** `_queueSteer` runs
 * (`dist/core/agent-session.js:1694-1697`), so an input handler swallowed the
 * text and the child never saw it. The RPC client says the same from the other
 * side: `dist/modes/rpc/rpc-client.js:133` — "If the disposition is 'handled',
 * no run started for this prompt".
 *
 * Everything else — `"queued"`, `undefined`, a backend that returns junk, an
 * older SDK that returns nothing — means the text went in. `route` only decides
 * what "went in" is called, and only for a child that was idle: a steer has
 * nowhere to go but the queue (`"queued"`), while a `route` of `"prompt"` means
 * `prompt()` returned without throwing, i.e. the session accepted a turn with
 * this text (`"accepted"`) — `"handled"` is the only "no turn started" signal
 * a prompt can produce.
 */
export function toSteerDisposition(
	raw: unknown,
	route: "steer" | "prompt",
): SteerDisposition {
	if (raw === "handled") return "intercepted";
	return route === "prompt" ? "accepted" : "queued";
}

/**
 * What an `abort` request actually achieved (#314 D1).
 *
 * Three honest states, not a boolean:
 *
 * - `"interrupted"`: a turn was running and the interrupt request went through.
 * - `"no-turn"`: nothing was running, so nothing was done — the queue was not
 *   touched either, and `cleared` is all zeros.
 * - `"timeout"`: the request went out but the child did not settle within the
 *   caller's bound. It kills nothing: no retire, no state rewrite.
 *
 * `cleared` is the count the preceding queue clear reported (`steering` /
 * `followUp` message counts), not a claim about what the model read.
 */
export type AbortOutcome = {
	status: "interrupted" | "no-turn" | "timeout";
	cleared: { steering: number; followUp: number };
};

/**
 * Bound for one `abort` (#314 D2), shared by every layer that has to name it:
 * both backends and the tool-surface receipt.
 *
 * It bounds the pre-abort queue clear AND the interrupt that follows it
 * (#314 D4), so a child that answers neither can delay the caller by at most
 * about twice this — never by the RPC client's own request timeout.
 */
export const DEFAULT_ABORT_TIMEOUT_MS = 5_000;

/**
 * Largest delay `setTimeout` honours: 2^31 − 1 ms (~24.8 days).
 *
 * Node does not saturate an out-of-range delay, it **collapses it to 1 ms**
 * (`TimeoutOverflowWarning: … does not fit into a 32-bit signed integer`), so an
 * over-large `timeoutMs` would reproduce exactly the fake instant `"timeout"`
 * the abort normalization exists to prevent (#314 D2). Both backends therefore
 * clamp their bound to this value instead of trusting the caller's number.
 */
export const MAX_ABORT_TIMER_DELAY_MS = 2_147_483_647;

/**
 * Count what a queue clear dropped (#314 D2): read `{steering, followUp}` array
 * lengths off whatever the backend's `clearQueue` returned. Anything else — a
 * throw or a clear that never answers is handled by the caller — counts 0.
 *
 * Both backends call this so the two never disagree about the same payload, and
 * every call allocates, so no caller can mutate another's counts.
 */
export function countClearedQueue(raw: unknown): {
	steering: number;
	followUp: number;
} {
	const record =
		typeof raw === "object" && raw !== null
			? (raw as { steering?: unknown; followUp?: unknown })
			: undefined;
	return {
		steering: Array.isArray(record?.steering) ? record.steering.length : 0,
		followUp: Array.isArray(record?.followUp) ? record.followUp.length : 0,
	};
}

/**
 * A tool call a child is inside right now (#315).
 *
 * `startedAt` is the HOST clock reading taken when the child's own
 * `tool_execution_start` event arrived. Elapsed time is always
 * `Date.now() - startedAt`, i.e. one clock family measuring an age — never two
 * writers' timestamps arbitrated against each other (display-liveness D3).
 */
export interface ChildActivity {
	/** Tool name exactly as the child's event stream reported it. */
	readonly tool: string;
	/** Host `Date.now()` when the start event arrived. */
	readonly startedAt: number;
	/**
	 * Tool call id, when the child's event carried one. Used for exactly one
	 * thing: matching the end event to the start it belongs to, so a parallel
	 * call finishing cannot clear a different call still running.
	 */
	readonly toolCallId?: string;
}

/**
 * A single tool call running at or past this bound gets a display-only marker
 * (#315).
 *
 * Five minutes is chosen against the observable alternative: a child that stops
 * making progress is currently invisible until its `collect` deadline (900s by
 * default), because liveness calls any child holding a non-terminal handle
 * alive. This bound fires well before that deadline, and it costs nothing but a
 * string — it decides nothing and kills nothing.
 */
export const STALL_NOTICE_MS = 300_000;

/**
 * `451_000ms` → `00:07:31`. Hours are not capped, so an all-day call reads
 * `30:00:00` instead of silently wrapping to `06:00:00`.
 *
 * A non-finite input is floored to the zero clock. `Math.max(0, Math.floor(NaN/1000))`
 * is still `NaN`, which would render the readout as `NaN:NaN:NaN` — a defect that
 * looks like data instead of a missing fact. Both clocks on this path are
 * `Date.now()` readings, so this is belt-and-braces, not a live case.
 */
export function formatToolElapsed(elapsedMs: number): string {
	const totalSecs = Number.isFinite(elapsedMs) ? Math.max(0, Math.floor(elapsedMs / 1000)) : 0;
	const pad = (value: number): string => String(value).padStart(2, "0");
	const hours = pad(Math.floor(totalSecs / 3600));
	const minutes = pad(Math.floor((totalSecs % 3600) / 60));
	return `${hours}:${minutes}:${pad(totalSecs % 60)}`;
}

/**
 * The one-line activity readout for a child that is inside a tool call (#315):
 * `working · bash 00:07:31`, plus a marker once that single call has run for
 * {@link STALL_NOTICE_MS}.
 *
 * The `working` prefix comes from the activity fact itself, not from the
 * persisted child record: a start event with no matching end IS a child inside
 * a tool call, while the record's `state` is only rewritten at turn boundaries
 * and can lag (or read `retired` from a stale snapshot).
 *
 * **Display only.** This builds a string. It does not decide `liveness()`, does
 * not abort the call, and does not steer, retire or report anything — the
 * marker names `abort` as the lever precisely because `steer` cannot reach a
 * child that is already inside a tool call (#313).
 */
export function formatInFlightToolLine(
	activity: ChildActivity,
	now: number,
): string {
	// Same non-finite trap as `formatToolElapsed`, one step earlier: `Math.max(0,
	// NaN)` is `NaN`, and `NaN < STALL_NOTICE_MS` is false, so an unusable clock
	// would skip the short path and claim “no progress for NaNm”. Both clocks are
	// `Date.now()` readings (belt-and-braces, not a live case) — but the marker is
	// a claim, so an unusable clock must render as zero, never as a verdict.
	const raw = now - activity.startedAt;
	const elapsed = Number.isFinite(raw) ? Math.max(0, raw) : 0;
	const line = `working · ${activity.tool} ${formatToolElapsed(elapsed)}`;
	if (elapsed < STALL_NOTICE_MS) return line;
	const minutes = Math.floor(elapsed / 60_000);
	return `${line} (long-running tool — no progress for ${minutes}m; \`steer\` cannot interrupt it, \`abort\` can)`;
}

/**
 * Fold one child lifecycle event into the in-flight-tool fact (#315).
 *
 * Pure and total: an event that says nothing about tool boundaries returns
 * `current` unchanged, so both backends can call this on every event without
 * having to classify first.
 *
 * `tool_execution_end` clears only the call it names. Ids are optional on both
 * sides, so the rule is: clear unless BOTH sides name a call and those names
 * differ (a parallel sibling finishing must not erase the one still running).
 */
export function nextInFlightTool(
	current: ChildActivity | undefined,
	event: {
		readonly type?: unknown;
		readonly toolName?: unknown;
		readonly toolCallId?: unknown;
	},
	now: number,
): ChildActivity | undefined {
	if (event.type === "tool_execution_start") {
		if (typeof event.toolName !== "string" || event.toolName === "") {
			return current;
		}
		return {
			tool: event.toolName,
			startedAt: now,
			...(typeof event.toolCallId === "string"
				? { toolCallId: event.toolCallId }
				: {}),
		};
	}
	if (event.type === "tool_execution_end") {
		if (current === undefined) return undefined;
		const ended =
			typeof event.toolCallId === "string" ? event.toolCallId : undefined;
		if (
			ended !== undefined &&
			current.toolCallId !== undefined &&
			ended !== current.toolCallId
		) {
			return current;
		}
		return undefined;
	}
	return current;
}

/** The orchestrator's frozen backend seam (legion-v2-contract.md §3.1). */
export interface LegionSupervisor {
	spawnChild(input: SpawnInput): Promise<ChildHandle>;
	prompt(name: string, text: string): Promise<void>;
	/**
	 * Steer a running child (#313): the returned disposition says what happened
	 * to the text — `"queued"` behind its current tool batch, `"accepted"` as a
	 * turn this call started, or `"intercepted"` by an input handler (the child
	 * never saw it). Callers that build a receipt must report it.
	 */
	steer(name: string, text: string): Promise<SteerDisposition>;
	followUp(name: string, text: string): Promise<void>;
	/**
	 * Soft interrupt (#314): drop the child's queued steering/follow-up messages
	 * FIRST, then interrupt the running turn, and wait a bounded time for it.
	 *
	 * Frozen defaults (#314 D2): `clearQueued` is **true** and `timeoutMs` is
	 * `DEFAULT_ABORT_TIMEOUT_MS`. The bound covers the clear as well as the
	 * interrupt, and a timeout never throws (#314 D4) — it returns
	 * `status:"timeout"` and kills nothing.
	 */
	abort(
		name: string,
		opts?: { clearQueued?: boolean; timeoutMs?: number },
	): Promise<AbortOutcome>;
	waitSettled(name: string, timeoutMs?: number, signal?: AbortSignal): Promise<SettleResult>;
	isAlive(name: string): boolean;
	/**
	 * The tool call this child is inside right now (#315), or `undefined`.
	 *
	 * Optional on purpose. It is a display-only read added after this seam was
	 * frozen, and a supervisor that cannot answer it — a test double, a backend
	 * predating #315 — must keep satisfying the contract. Absence means "no
	 * activity fact", which renders no line at all: the same "no fact, no claim"
	 * rule every other status source follows. Callers read it as
	 * `supervisor.inFlightTool?.(name)`.
	 *
	 * A dead child never answers: holding no live handle, it can run no tool.
	 */
	inFlightTool?(name: string): ChildActivity | undefined;
	stats(name: string): Promise<UsageSnapshot | null>;
	retire(name: string, opts?: { graceful?: boolean }): Promise<void>;
}

/**
 * RpcClient's public constructor options. Kept as an alias so the adapter tracks
 * the installed Pi SDK without widening the supervisor contract.
 */
export type RpcClientOptions = PiRpcClientOptions;

/** Runtime process controls used by the host for exit and stdin lifecycle. */
export interface RpcProcessHandle {
	pid?: number;
	stdin:
		| Pick<Writable, "destroyed" | "writableEnded" | "write" | "end">
		| null;
	exitCode: number | null;
	signalCode: NodeJS.Signals | null;
	once(
		event: "exit",
		listener: (code: number | null, signal: NodeJS.Signals | null) => void,
	): this;
	once(event: "error", listener: (error: Error) => void): this;
	on(
		event: "exit" | "close",
		listener: (code: number | null, signal: NodeJS.Signals | null) => void,
	): this;
	off(
		event: "exit" | "close",
		listener: (code: number | null, signal: NodeJS.Signals | null) => void,
	): this;
	kill(signal?: NodeJS.Signals): boolean;
}

/** Only the RpcClient operations owned by the M1 host layer. */
export interface RpcClientLike {
	/** Runtime process handle; RpcClient currently keeps it TS-private. */
	process?: RpcProcessHandle | null;
	start(): Promise<void>;
	stop(): Promise<void>;
	onEvent(listener: (event: unknown) => void): () => void;
	getStderr?(): string;
	prompt(message: string): Promise<unknown>;
	steer(message: string): Promise<unknown>;
	followUp(message: string): Promise<unknown>;
	abort(): Promise<void>;
	/**
	 * Optional so existing fakes keep satisfying this seam: drop the queued
	 * steering/follow-up messages and answer their counts (#314 D2).
	 */
	clearQueue?(): Promise<unknown>;
	getSessionStats(): Promise<unknown>;
}

/** Injectable RpcClient constructor used by unit tests. */
export type RpcClientFactory = (options: RpcClientOptions) => RpcClientLike;

/** Coarse lifecycle/tool event delivered by RpcSupervisor.onEvent(). */
export interface SupervisorEvent {
	name: string;
	type: string;
	[key: string]: unknown;
}

/** text_delta payloads are opt-in to keep default event traffic coarse. */
export interface EventSubscriptionOptions {
	includeTextDelta?: boolean;
}

export type SupervisorEventListener = (event: SupervisorEvent) => void;
