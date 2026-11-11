/**
 * Measured decode time: first streaming delta → last streaming delta.
 *
 * Why this exists (contract `docs/contracts/tps-decode-denominator-v1.md` D1):
 * `tok/s` used to divide by `generationMs`, whose source is `message.durationMs`
 * = **request sent → response finished**, i.e. it includes prompt prefill/TTFT.
 * A regression over 215 real sessions (22306 assistant calls) fits
 * `durationMs ≈ 4.3s + output / 137`: a ~4.3 s fixed cost per call, so agentic
 * turns (31–800 output tokens = 75% of calls) displayed 11–60 tok/s while the
 * model really decoded at ~137 tok/s.
 *
 * So the denominator is measured instead of inferred: the wall clock between the
 * FIRST and the LAST `*_delta` the supervisor actually saw (D1). No model
 * constants, no prefilling regression fit — just the timestamps this host
 * already takes (`Date.now()` in both backends' event folds).
 *
 * Both backends fold through this one pure module so they cannot drift (D2), and
 * the fold must run BEFORE `publishEvent`'s "text delta / tool name only" filter:
 * that filter drops `thinking_delta` (and most other deltas), so a thinking-only
 * turn would otherwise measure nothing at all.
 *
 * The accumulator is a CUMULATIVE ms value aligned with the session's own
 * `generationMs` axis (D3): on a resume the historical `generationMs` is used as
 * a seed, so the sampler never jumps between two axes mid-curve.
 */

/**
 * Lower bound for a trustworthy measured span.
 *
 * A provider that does not stream (single chunk), a test double, or a message
 * whose deltas all landed inside one millisecond produces a span too small to
 * divide by. `foldDecode` then falls back to that message's `durationMs` — i.e.
 * today's behaviour — instead of collapsing the denominator to ~0 (D2 rule 2).
 */
export const MIN_MEASURED_DECODE_MS = 50;

/**
 * Bound on the per-backend `name → last measured decode ms` archive (D4-b).
 *
 * A retired child keeps answering `decodeMs` from that archive, so it has to be
 * bounded: a long session retires thousands of children and none of their
 * accumulators may outlive the useful window. 256 is the same margin the session
 * parse cache uses (`SESSION_CACHE_MAX_ENTRIES`) — comfortably more than the
 * ~30 rows a screen or a summary asks about, far less than a runaway session.
 */
export const DECODE_ARCHIVE_MAX = 256;

/**
 * One child's decode accumulator.
 *
 * `openSince` / `openLast` describe the message currently streaming (first and
 * most recent delta). `measuredMs` only grows and only counts CLOSED messages,
 * which is what makes it a step function the sampler can difference against
 * `tokensOut` (usage also lands at `message_end`, never mid-stream).
 */
export interface DecodeClock {
	/** Host-clock ms of the first delta of the message being measured. */
	openSince?: number;
	/** Host-clock ms of the most recent delta of that same message. */
	openLast?: number;
	/** Cumulative measured decode ms (plus the resume seed). Monotone. */
	measuredMs: number;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	if (!value || typeof value !== "object") return undefined;
	// SAFETY: the object check makes property reads safe; every consumed value is
	// validated below rather than trusted.
	return value as Record<string, unknown>;
}

function finiteMs(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * Stream activity is exactly the `*_delta` family: `text_delta`, `thinking_delta`,
 * `toolcall_delta`, … (D2 rule 1). `_start` / `_end` / `done` / `error` frame a
 * message but carry no decoding progress, so counting them would inflate a span
 * to cover the whole request — the very number this module replaces.
 */
function isStreamActivity(updateType: string): boolean {
	return updateType.endsWith("_delta");
}

/**
 * Events that prove the message which was streaming is over, even when its
 * `message_end` never arrived (aborted turn, killed child, provider error).
 *
 * `message_start` is the ordinary one: every message (assistant, toolResult,
 * user) starts with it, and an assistant message's `message_end` already cleared
 * the open span, so this is only ever reached by a message that was left open.
 * The turn/agent boundaries cover the abort path, which emits `turn_end` /
 * `agent_end` / `error` with no `message_end` at all.
 *
 * Settling here rather than at the next `_delta` is numerically identical (D2
 * rule 3 only ever adds `openLast - openSince` for the abandoned message and
 * then opens a fresh one) and needs no extra flag in the frozen state shape.
 */
const STREAM_CLOSERS: ReadonlySet<string> = new Set([
	"message_start",
	"turn_start",
	"turn_end",
	"agent_start",
	"agent_end",
	"agent_settled",
	"error",
]);

/** Add the open span (no `durationMs` available) and clear it. */
function closeOpen(clock: DecodeClock): DecodeClock {
	// Nothing open (or a half-open state, which the fold never produces) → the
	// event is only a boundary: leave the accumulator exactly as it was.
	if (clock.openSince === undefined || clock.openLast === undefined) return clock;
	const span = Math.max(0, clock.openLast - clock.openSince);
	return { measuredMs: clock.measuredMs + span };
}

/**
 * Seed a child's clock from the `generationMs` already in its session file (D3).
 *
 * A fresh spawn reads an empty file → seed 0, so the axis starts where the old
 * one did. A `resume`/`continue` reuses the old session file, so the seed is that
 * history: the curve stays continuous (history keeps the old denominator, new
 * messages use the measured one) instead of sampling across two different axes
 * and painting a spike.
 *
 * Seeds are floored at 0 and never decrease.
 */
export function seedDecode(seedMs: number): DecodeClock {
	const seed = Number.isFinite(seedMs) && seedMs > 0 ? seedMs : 0;
	return { measuredMs: seed };
}

/**
 * Fold one session/RPC event into a child's clock. TOTAL (D2 rule 4): an unknown,
 * malformed, or irrelevant record returns the state untouched and never throws —
 * this runs on the lifecycle path, where a fold error would break a child.
 */
export function foldDecode(clock: DecodeClock, record: Record<string, unknown>, at: number): DecodeClock {
	if (!Number.isFinite(at)) return clock;
	if (!record || typeof record !== "object") return clock;
	const type = typeof record.type === "string" ? record.type : undefined;
	if (type === undefined) return clock;

	if (type === "message_update") {
		const update = asRecord(record.assistantMessageEvent);
		const updateType = typeof update?.type === "string" ? update.type : undefined;
		if (updateType === undefined) return clock;
		if (isStreamActivity(updateType)) {
			// Rule 1: first delta opens the span, every delta moves its end.
			return {
				openSince: clock.openSince ?? at,
				openLast: at,
				measuredMs: clock.measuredMs,
			};
		}
		// `start` belongs to a NEW message: the previous one was left open (rule 3).
		if (updateType === "start") return closeOpen(clock);
		return clock;
	}

	if (STREAM_CLOSERS.has(type)) return closeOpen(clock);

	if (type !== "message_end") return clock;

	const message = asRecord(record.message);
	// A non-assistant message_end (user / toolResult) closes whatever was open but
	// can never contribute a `durationMs` — only assistant messages carry one.
	if (message !== undefined && typeof message.role === "string" && message.role !== "assistant") {
		return closeOpen(clock);
	}
	// Rule 2: settle one assistant message.
	const span =
		clock.openSince === undefined || clock.openLast === undefined
			? undefined
			: Math.max(0, clock.openLast - clock.openSince);
	const durationMs = finiteMs(message?.durationMs);
	const add = span !== undefined && span >= MIN_MEASURED_DECODE_MS ? span : (durationMs ?? 0);
	return { measuredMs: clock.measuredMs + add };
}
