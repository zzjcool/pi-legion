/**
 * stall-notice D1/D2/D5–D8 — the PURE half of "很久没有动静" (stall notice v1).
 *
 * Two failure modes, two detectors, no action:
 *
 * ```
 * L1 (silence) : in-flight stack empty  AND  now - lastEventAt >= silenceNoticeMs
 * L1, stack non-empty : never reported (D1)
 * L2 (long)    : now - loopBaseAt       >= loopRadiusMs
 * ```
 *
 * Nothing here reads a clock, touches SQLite, or calls a supervisor: the caller
 * passes `now` and the facts it folded, and gets a decision back. That is what
 * makes the boundaries (`>=` vs `>` at the millisecond) testable without a fake
 * clock, and it is why this file lives under `src/legion/` rather than inside the
 * postman (contract §D9: "纯判定 + 纯文案，无 IO").
 *
 * **D1 is the load-bearing rule**: a 10-minute `npm run build` produces exactly
 * the same event stream as a hung `bash` (`tool_execution_start` → silence →
 * `tool_execution_end`), so a non-empty stack is never evidence of a stall. It may
 * only appear as EVIDENCE inside an L2 line ("inside `bash` for 38m"), never as a
 * verdict of its own.
 *
 * This module never decides to abort, stop or retire anything (D3). It produces a
 * decision and two strings; the parent decides.
 *
 * **#413: the de-duplication key is the crossed THRESHOLD, never a timestamp.**
 * `floor(elapsed / thresholdMs)` names the boundary (`tier`); a window announces
 * each tier at most once, so every check inside the same boundary is silent. The
 * caller passes what it has already announced ({@link StallLineState}) and records
 * the `tier` of the line it just wrote — see {@link crossedTier} and `decideStallNotice`.
 */

import { DEFAULTS } from "../shared/types.ts";

/**
 * The one subject prefix a stall notice has, exported because the delivery side
 * (`isStaleStallNotice`) has to recognise the row by the SAME literal the writer
 * emits — two readers, one spelling, no drift.
 *
 * stall-notice-staleness D1.
 */
export const STALL_NOTICE_SUBJECT_PREFIX = "Stall notice: ";

/** L1 announces at `1×` and `2×` the threshold, then stops (D6). */
export const SILENCE_NOTICE_LIMIT = 2;
/** L2 announces at three boundaries per window at most (D6). */
export const LONG_RUNNING_NOTICE_LIMIT = 3;
/**
 * D8's last rung: a role that declares neither `loopNoticeMs` nor `timeoutMs`
 * falls back to the SDK turn budget. Imported (not copied) so the two numbers
 * cannot drift apart.
 */
export const DEFAULT_LOOP_NOTICE_MS = DEFAULTS.turnTimeoutMs;

export type StallNoticeKind = "silence" | "long-running";

/**
 * What the caller knows about ONE child at decision time.
 *
 * `lastEventAt` is the host-clock reading of that child's last coarse event (D2)
 * and is optional on purpose: a supervisor that cannot answer it has no fact, and
 * "no fact" must not become an L1 notice. `inFlightTool` is the innermost frame of
 * the in-flight stack; `undefined` means the stack is empty.
 */
export interface StallChildFacts {
	readonly name: string;
	readonly lastEventAt?: number;
	readonly inFlightTool?: string;
	readonly inFlightToolStartedAt?: number;
}

/** Both thresholds are "off" when they are absent, non-finite, or `<= 0` (D6). */
export interface StallThresholds {
	readonly silenceNoticeMs?: number;
	readonly loopRadiusMs?: number;
}

/**
 * What has already been said in ONE window (D6) — #413: the de-duplication key is
 * the crossed THRESHOLD, not the time the previous line was sent.
 *
 * `tier` is `floor(elapsed / thresholdMs)`: the ordinal of the boundary the window
 * has reached (`1` = the first threshold, `2` = twice it, …). Recording the highest
 * tier announced makes "this boundary was already announced" a fact the next tick
 * can re-derive from `(windowBase, thresholdMs, elapsed)` alone — so N checks inside
 * one boundary produce exactly ONE line, no matter how the caller's clock moves.
 * `count` is separate because it is D6's cap: a child first observed three radii in
 * spends one line, not three, so `count` can stay below `tier` forever.
 *
 * `lastAt` is kept for diagnostics only ("when did the last line go out"); nothing
 * decides on it any more. Measuring the next repeat from the SENT time was the
 * pre-#413 rule, and it could not answer "was THIS boundary announced?" because a
 * re-created detector had no sent time to compare against.
 */
export interface StallLineState {
	/** Highest boundary index already announced; `0` = nothing yet. */
	readonly tier: number;
	/** Lines already announced in this window. */
	readonly count: number;
	/** Host-clock reading of the last of them; `undefined` when `count === 0`. */
	readonly lastAt?: number;
}

/** The per-tick half of the state the CALLER owns (D5/D6: memory only). */
export interface StallWindow {
	/** L2 baseline: `nodes.created_at` on first sight, or `now` after `extend`. */
	readonly loopBaseAt: number;
	/** L1 lines already sent in the current silence window. */
	readonly silence: StallLineState;
	/** L2 lines already sent in the current long-running window. */
	readonly longRunning: StallLineState;
}

/** One line of the notice; the caller merges the lines of one tick into one mail (D7). */
export interface StallAnnouncement {
	readonly kind: StallNoticeKind;
	readonly childName: string;
	/**
	 * The window this line belongs to — L1: `lastEventAt`; L2: the base the radius
	 * is measured from. Half of the D6 de-duplication key: a new event (L1) or an
	 * `extend` (L2) produces a new bucket, which re-arms the boundary ladder.
	 */
	readonly sinceBucket: number;
	/**
	 * Which boundary this line announces: `floor(elapsedMs / thresholdMs)`, `>= 1`.
	 * The OTHER half of the D6 key (#413): `(child, kind, bucket, threshold, tier)`
	 * is announced at most once, so a child that sits past its threshold does not
	 * re-mail on every check.
	 */
	readonly tier: number;
	/** 1-based index of this line within its window. */
	readonly sequence: number;
	readonly elapsedMs: number;
	readonly thresholdMs: number;
	/** L2 only, and only when the child is inside a tool: the evidence (D1). */
	readonly inFlightTool?: string;
	readonly inFlightMs?: number;
}

/**
 * A threshold that can fire at all (D6): `0`, a negative number, `NaN` and
 * `Infinity` all mean "this detector is off".
 */
export function isActiveStallThreshold(value: number | undefined): value is number {
	return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/**
 * The decision for ONE child in ONE tick.
 *
 * At most one line per child per tick: L1 wins over L2 when both are due, because
 * a child that has been silent with an empty stack for a whole role budget is
 * already described by the sharper fact, and two lines about one child in one mail
 * spends the parent's attention twice on the same node. L2 keeps its own count and
 * still fires on later boundaries once L1 has spent its two announcements.
 */
export function decideStallNotice(input: {
	readonly now: number;
	readonly child: StallChildFacts;
	readonly thresholds: StallThresholds;
	readonly window: StallWindow;
}): StallAnnouncement | undefined {
	return silenceAnnouncement(input) ?? longRunningAnnouncement(input);
}

function silenceAnnouncement(input: {
	readonly now: number;
	readonly child: StallChildFacts;
	readonly thresholds: StallThresholds;
	readonly window: StallWindow;
}): StallAnnouncement | undefined {
	const { now, child, thresholds, window } = input;
	const thresholdMs = thresholds.silenceNoticeMs;
	if (!isActiveStallThreshold(thresholdMs)) return undefined;
	// D1: a non-empty stack is NEVER a stall. This is the most important line in
	// the file — the caller passes a frame for every child that is inside a tool,
	// so a slow build can only ever surface as L2 evidence.
	if (child.inFlightTool !== undefined) return undefined;
	const sinceBucket = child.lastEventAt;
	if (sinceBucket === undefined || !Number.isFinite(sinceBucket)) return undefined;
	const elapsedMs = now - sinceBucket;
	if (!(elapsedMs >= thresholdMs)) return undefined;
	// #413: the boundary IS the de-duplication key. `tier <= announced.tier` means
	// this crossing (or a later one) has already been announced, so every further
	// check inside the same boundary is silent — the defect the issue reports.
	const tier = crossedTier(elapsedMs, thresholdMs);
	if (tier <= window.silence.tier) return undefined;
	const sequence = window.silence.count + 1;
	if (sequence > SILENCE_NOTICE_LIMIT) return undefined;
	return { kind: "silence", childName: child.name, sinceBucket, tier, sequence, elapsedMs, thresholdMs };
}

function longRunningAnnouncement(input: {
	readonly now: number;
	readonly child: StallChildFacts;
	readonly thresholds: StallThresholds;
	readonly window: StallWindow;
}): StallAnnouncement | undefined {
	const { now, child, thresholds, window } = input;
	const thresholdMs = thresholds.loopRadiusMs;
	if (!isActiveStallThreshold(thresholdMs)) return undefined;
	const sinceBucket = window.loopBaseAt;
	if (!Number.isFinite(sinceBucket)) return undefined;
	const elapsedMs = now - sinceBucket;
	if (!(elapsedMs >= thresholdMs)) return undefined;
	// #413: one line per crossed boundary — see `crossedTier`. The cap below is the
	// other half of D6 and stays: three boundaries, then silence until `extend`.
	const tier = crossedTier(elapsedMs, thresholdMs);
	if (tier <= window.longRunning.tier) return undefined;
	const sequence = window.longRunning.count + 1;
	if (sequence > LONG_RUNNING_NOTICE_LIMIT) return undefined;
	const inFlightMs = child.inFlightTool === undefined ? undefined : now - (child.inFlightToolStartedAt ?? Number.NaN);
	return {
		kind: "long-running",
		childName: child.name,
		sinceBucket,
		tier,
		sequence,
		elapsedMs,
		thresholdMs,
		...(child.inFlightTool === undefined ? {} : { inFlightTool: child.inFlightTool }),
		...(inFlightMs !== undefined && Number.isFinite(inFlightMs) && inFlightMs >= 0 ? { inFlightMs } : {}),
	};
}

/**
 * The boundary ordinal of an elapsed time: `1` at the threshold, `2` at twice it, …
 *
 * `Math.floor`, never `round`: the tier is the de-duplication key (#413), so the
 * instant it flips must be exactly `base + n × threshold` — the same boundary the
 * `elapsed >= thresholdMs` gate uses. Rounding up would announce a boundary a hair
 * early; rounding down would repeat a boundary for half a radius.
 *
 * The caller has already checked `elapsed >= threshold`, so the result is `>= 1`.
 * A non-finite or non-positive threshold cannot reach here (the detectors are gated
 * by `isActiveStallThreshold`), and a non-finite elapsed would make the comparisons
 * false rather than crash.
 */
function crossedTier(elapsedMs: number, thresholdMs: number): number {
	return Math.floor(elapsedMs / thresholdMs);
}

/**
 * D8's chain, left to right: the card's own `loopNoticeMs`, then the card's
 * `timeoutMs`, then {@link DEFAULT_LOOP_NOTICE_MS}.
 *
 * An EXPLICIT `loopNoticeMs <= 0` disables the detector instead of falling through
 * (D6: "0 或负数 = 该探测器关闭") — falling through would silently resurrect the
 * budget the card just switched off.
 */
export function resolveLoopRadiusMs(
	card: { readonly loopNoticeMs?: number; readonly timeoutMs?: number } | undefined,
): number | undefined {
	if (card?.loopNoticeMs !== undefined) {
		return isActiveStallThreshold(card.loopNoticeMs) ? card.loopNoticeMs : undefined;
	}
	const budget = card?.timeoutMs;
	return isActiveStallThreshold(budget) ? budget : DEFAULT_LOOP_NOTICE_MS;
}

/**
 * `2m 5s`, `45m 0s`, `1h 30m` — the unit the two lines below speak.
 *
 * Not `formatToolElapsed`'s `hh:mm:ss`: that one is the status line's clock and
 * reads as a timestamp, while these numbers are ages ("silent for 2m 5s"). Both
 * are clamped the same way so an unusable clock can never render as a stall.
 */
export function formatStallDuration(ms: number): string {
	if (!Number.isFinite(ms) || ms <= 0) return "0s";
	const totalSeconds = Math.floor(ms / 1000);
	if (totalSeconds < 60) return `${totalSeconds}s`;
	const totalMinutes = Math.floor(totalSeconds / 60);
	if (totalMinutes < 60) return `${totalMinutes}m ${totalSeconds % 60}s`;
	return `${Math.floor(totalMinutes / 60)}h ${totalMinutes % 60}m`;
}

/**
 * One mail for the whole tick (D7): a line per child, grouped by detector.
 *
 * The two detectors may say different things about what the parent can DO (D3), so
 * the lines themselves carry the qualifier: an L1 line must say `steer cannot land
 * here; abort can` (the child is not inside a turn, so a steer only queues), and an
 * L2 line must NOT say that — a child that is running does reach a turn boundary.
 *
 * `detectedAt` is the DETECTION time (stall-notice-staleness D1), stamped on its own
 * line right below the heading. The text below it is frozen at the tick that saw the
 * fact, while delivery may happen minutes later (postman tick, or a `wait` preemption
 * at the top of a turn), so a recipient needs to know how old the snapshot is before
 * acting on `10m 1s, no tool in flight`. It arrives as an ARGUMENT and never from a
 * clock here: this module stays pure (see the purity test).
 *
 * A non-finite value omits the line rather than printing `Invalid Date` — a caller
 * without a usable clock still owes the parent the facts, just not a bogus time.
 */
export function formatStallNotice(
	announcements: readonly StallAnnouncement[],
	detectedAt: number,
): {
	readonly subject: string;
	readonly body: string;
} {
	if (announcements.length === 0) throw new TypeError("a stall notice needs at least one announcement");
	const silence = announcements.filter((announcement) => announcement.kind === "silence");
	const long = announcements.filter((announcement) => announcement.kind === "long-running");
	const sections: string[] = [
		"Legion stall notice — nothing was stopped, steered or retired; these are facts for you to check.",
	];
	// The line starts with `Detected at `, never `- `, so the `- <child>: ` grammar the
	// delivery side parses (D2) cannot mistake it for a child line.
	//
	// The range guard is not pedantry: `Number.isFinite` alone lets `Number.MAX_SAFE_INTEGER`
	// through, and `toISOString()` throws `RangeError` past ±8.64e15 ms. A throw here would
	// take the whole tick's notice with it (the caller catches and degrades), so a clock
	// that is merely absurd must lose only the stamp line, never the facts.
	if (Number.isFinite(detectedAt) && Math.abs(detectedAt) <= 8.64e15) {
		sections.push(`Detected at ${new Date(detectedAt).toISOString()}.`);
	}
	if (silence.length > 0) {
		sections.push(
			["", "L1 silence (no tool in flight, no child event):", ...silence.map(silenceLine)].join("\n"),
		);
	}
	if (long.length > 0) {
		sections.push(
			["", "L2 long-running (past the role's notice budget):", ...long.map(longRunningLine), "", EXTEND_FOOTER].join("\n"),
		);
	}
	return {
		subject: announcements.length === 1
			? `${STALL_NOTICE_SUBJECT_PREFIX}${announcements[0]!.childName}`
			: `${STALL_NOTICE_SUBJECT_PREFIX}${announcements.length} children`,
		body: sections.join("\n"),
	};
}

/**
 * `- <name>: ` — the frozen line grammar {@link formatStallNotice} writes, and the
 * ONLY parser of it (`stall-notice-staleness` D2).
 *
 * The name group is `\S+` (a slug never contains a space) and the trailing `: ` is
 * what stops a body prose line like `- see the report` from ever being read as a
 * child. Dedupe keeps a child named twice from checking the ledger twice.
 */
const STALL_NOTICE_CHILD_LINE = /^- (\S+): /gm;

/**
 * The child names a stall notice's body points at, in first-appearance order.
 *
 * Sharing this parser with the writer is the whole point: a second, looser reading
 * of the same text would let the delivery side obsolete a notice the writer never
 * meant (`never guess` — an unparseable body yields an empty list, which the
 * predicate treats as "not stale").
 */
export function stallNoticeChildNames(body: string): string[] {
	const names = new Set<string>();
	for (const match of body.matchAll(STALL_NOTICE_CHILD_LINE)) {
		const name = match[1];
		if (name !== undefined) names.add(name);
	}
	return [...names];
}

/**
 * D5's "not the same as the three neighbours": `renewal` continues an exhausted
 * budget, `continue` sends a finished child a new message, `extend` in a `wait`
 * receipt means "call wait again" — this one only moves the L2 reminder.
 */
const EXTEND_FOOTER =
	'`subagent({action:"extend", name, ms?})` defers only this L2 reminder: it does not extend a collect/wait budget, does not restart or revive the child, and is not `continue`.';

function silenceLine(announcement: StallAnnouncement): string {
	return `- ${announcement.childName}: no event for ${formatStallDuration(announcement.elapsedMs)} with nothing in flight (threshold ${formatStallDuration(announcement.thresholdMs)}). The child is not inside a turn, so steer cannot land here; abort can.`;
}

function longRunningLine(announcement: StallAnnouncement): string {
	const evidence = announcement.inFlightTool === undefined
		? "with no tool in flight"
		: `inside \`${announcement.inFlightTool}\`${announcement.inFlightMs === undefined ? "" : ` for ${formatStallDuration(announcement.inFlightMs)}`}`;
	return `- ${announcement.childName}: running for ${formatStallDuration(announcement.elapsedMs)} (threshold ${formatStallDuration(announcement.thresholdMs)}), ${evidence}. It may be looping — check its actual execution context; steer reaches a child at a turn boundary.`;
}
