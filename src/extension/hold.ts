/**
 * settle-hold-v1 (#417): keep the parent session's settle boundary open while a
 * child of THIS session is still running, and hand that child's completion to the
 * SAME turn instead of letting it wait for the next one.
 *
 * What it is for. legion's completion notices are delivered at a run boundary
 * (`deliverBatch`: `parentRunActive` ⇒ outbox ⇒ `agent_settled` ⇒ followUp). That
 * boundary is the parent's own turn end, so the notice waits for a turn that is
 * already over and then starts another one — measured +32.2s end to end
 * (`CHANGELOG.md` 6.0.2) and 1284 ms for a message queued inside a live turn
 * (`docs/reports/hold-spike.md` §2). The host awaits `agent_before_settle`
 * handlers serially and with **no timeout** (`runner.js:767-812`), so that
 * boundary is the one place where spending wall time is legitimate: while it
 * runs, the run still reports streaming.
 *
 * What it is NOT. It never prevents, cancels or postpones a user turn: every
 * non-delivery exit returns `undefined` (the host then settles exactly as it
 * would have) and the module never returns `continue: false` — in the host's
 * handler chain that field would silently cancel another extension's hold and
 * commit its drafts (`hold-spike.md` §1 case 1i). It also never registers a
 * `turn_end` handler (the sibling of this file, `index.ts`, documents why the
 * repository deliberately has none).
 *
 * The three exits, kept apart on purpose (`hold-spike.md` §4 D3):
 *  - `completed` — every child settled: take the notice that is waiting in the
 *    outbox, persist its `notified` latch, and return `entries: [...event.entries,
 *    ...drafts]` plus one continuation. The spread is mandatory: the host
 *    REPLACES `entries` with whatever a handler returns (§1 case 1d — a bare list
 *    silently deletes every draft queued before us).
 *  - any other outcome — `release` first, then return `undefined`. The release
 *    hands the notice back to the normal followUp path untouched; a `commit`
 *    without a delivered boundary would be a lost notification, and a `release`
 *    after the drafts were returned would be a duplicate.
 *  - `cancelled` (Esc, or a run the host already marked `aborted`/`error`) —
 *    release and return `undefined` with NO drafts: entries are persisted even
 *    when the run is aborted (`agent-session.js:1637-1641`, measured in
 *    `hold-spike.md` §3: 0 notifications + one orphan draft). A cancelled turn
 *    must not leave an announcement behind.
 *
 * `docs/reports/legion-hold.md` is the report; `test/unit/settle-hold.test.ts`
 * pins every rule above, including the exits' ORDER.
 */
import * as fs from "node:fs";
import { SUBAGENT_NOTIFY_TYPE } from "./notify.ts";

/**
 * Budget for one hold: ten minutes, frozen by #417.
 *
 * It is the user-visible worst case, not an internal knob: while the boundary is
 * open nothing can preempt it (a notification has no channel, and `ctx.signal` is
 * `undefined` at this boundary — `hold-spike.md` §3 H10), so a queued notice
 * waits at most this long. `hold-spike.md` §4 D2 argues for 3000 ms on exactly
 * that reasoning; the frozen checklist for #417 fixes 600000 instead, and the
 * report records the trade-off rather than quietly re-deciding it here.
 *
 * On expiry the hold does NOT continue: it releases and returns `undefined`, so
 * the turn settles exactly as it would have without the feature, and the notice
 * keeps waiting for the normal path. Nothing is stretched to cover the budget.
 */
export const legionHoldMaxMs = 600_000;

/** Poll cadence of the live-child probe. Bounds the user-message delay (§7). */
export const HOLD_POLL_MS = 200;

/** One child the session is still waiting on: `name#round` is the hold's identity. */
export interface HoldChild {
	name: string;
	round: number;
}

/**
 * A `custom_message` boundary draft, structurally identical to the host's
 * `CustomMessageEntryDraft` (`types.d.ts:780-786`) so `index.ts` can hand the
 * result straight to `pi.on` without a cast at the call site.
 */
export interface HoldDraft {
	type: "custom_message";
	customType: typeof SUBAGENT_NOTIFY_TYPE;
	content: string;
	display: boolean;
	details?: unknown;
}

/** What the outbox handed over: the drafts for this boundary plus their text. */
export interface TakenHoldNotice {
	drafts: HoldDraft[];
	/** Plain text of the notice, for the trace (the drafts carry it too). */
	content: string;
}

/**
 * Why a boundary did or did not hold. `completed*` are the only outcomes that can
 * return entries; `cancelled` is the abort/Esc verdict and is never announced.
 */
export type HoldOutcome =
	| "completed"
	| "completed-empty"
	| "cancelled"
	| "timeout"
	| "user-waiting"
	| "idle"
	| "nested"
	| "mode"
	| "degraded"
	| "already-gave-up"
	| "disposed"
	| "error";

export interface HoldRecord {
	ev: "hold:begin" | "hold:end" | "hold:abstain" | "hold:release" | "hold:commit";
	/** Wall clock, ms since the epoch — the field the report quotes. */
	at: number;
	outcome: HoldOutcome;
	/** How long the boundary was held (only on `hold:end`). */
	heldMs?: number;
	/** `name#round` of every child the hold was waiting on. */
	children?: string[];
	/** Entries the host already had queued for this boundary, and what we returned. */
	entriesIn?: number;
	entriesOut?: number;
	/** Chars of notice text returned in the drafts. */
	noticeChars?: number;
	reason?: string;
}

/**
 * What the hold needs from the runtime. Every member is a seam so the policy can be
 * tested without a host, a child, a timer or a ledger: the runtime owns "who is
 * live" and the outbox, this module owns "when to wait and what to return".
 */
export interface SettleHoldDeps {
	/**
	 * Children of this session that can still produce a notice. `undefined` means
	 * the seam is unavailable (a host that did not provide it) — the hold must then
	 * abstain rather than guess, because a wrong list either parks the turn for no
	 * reason or delivers an empty continuation.
	 */
	liveChildren(): HoldChild[] | undefined;
	/**
	 * Take the OLDEST undelivered notice out of the outbox as boundary drafts.
	 * `undefined` = nothing is owed (every member was already read/announced), which
	 * is a normal `completed-empty` exit, not an error.
	 */
	takeNotice(): TakenHoldNotice | undefined;
	/**
	 * Persist the `notified` latch for the taken notice (write-once, so a restart
	 * cannot announce the same child twice). Called ONLY on the path that returns
	 * the drafts.
	 */
	commitNotice(): void;
	/**
	 * Put the taken notice back on the normal followUp path, untouched. Idempotent
	 * and safe when nothing was taken. Called before every non-delivery return.
	 */
	releaseNotice(): void;
	/**
	 * The hold owns this boundary now: the settle rescue timer (`SETTLE_FALLBACK_MS`)
	 * must not fire mid-hold and steal the notice from under it.
	 */
	ownsBoundary?(): void;
	/** Frozen budget; injected only by tests. */
	holdMaxMs?: number;
	pollMs?: number;
	now?: () => number;
	/** Injected by tests so a 10-minute budget costs no wall time. */
	sleep?: (ms: number) => Promise<void>;
	/** Trace sink: the report's evidence, and the ORDER assertions in the unit test. */
	record?: (record: HoldRecord) => void;
}

export interface SettleHold {
	/** The `agent_before_settle` handler body. */
	beforeSettle(
		event?: unknown,
		ctx?: unknown,
	): Promise<{ entries: HoldDraft[]; continue: true } | undefined>;
	/** End the feature for this session (the hold must not wait after teardown). */
	dispose(): void;
}

/** The slice of the host ctx this module reads. Every member is feature-detected. */
interface HoldContext {
	mode?: unknown;
	hasPendingMessages?: () => unknown;
	ui?: {
		onTerminalInput?: (handler: (data: string) => undefined) => unknown;
	};
}

/** The slice of `AgentBeforeSettleEvent` this module reads. */
interface BoundaryEvent {
	entries?: unknown;
	outcome?: unknown;
}

/** A lone ESC. Arrow/Alt keys arrive as `\x1b[A` / `\x1b a`. */
const ESC = "\x1b";

const defaultSleep = (ms: number): Promise<void> =>
	new Promise((resolve) => {
		// Deliberately NOT unref'd: `hold-spike.md`'s rig and pi-async's 0.4.0 CI
		// incident both show that an unref'd awaited timer lets node:test end the
		// suite before the poll wakes, turning a test into a silent hang.
		setTimeout(resolve, ms);
	});

/** `.pi-legion`-free trace sink: JSONL to `path`, or nothing when the env is unset. */
export function fileHoldTrace(path: string | undefined): ((record: HoldRecord) => void) | undefined {
	if (!path) return undefined;
	return (record) => {
		try {
			fs.appendFileSync(path, `${JSON.stringify(record)}\n`);
		} catch {
			// A trace is a diagnostic, never a condition of the boundary itself.
		}
	};
}

export function createSettleHold(deps: SettleHoldDeps): SettleHold {
	const now = deps.now ?? Date.now;
	const sleep = deps.sleep ?? defaultSleep;
	const holdMaxMs = deps.holdMaxMs ?? legionHoldMaxMs;
	const pollMs = Math.max(1, deps.pollMs ?? HOLD_POLL_MS);
	let disposed = false;
	/**
	 * R3 (`hold-spike.md` §1.3): the "one hold per run" latch must NOT be reset by
	 * `agent_start`. A continuation re-enters this boundary, and re-arming there is
	 * exactly how the spike produced 278 hops in 60 s. The natural gate is "a live
	 * child", so no reset is needed at all; this set only remembers the child sets
	 * that already burned a budget, so the same still-running set cannot park the
	 * next boundary for another ten minutes.
	 */
	const gaveUp = new Set<string>();

	const record = (value: HoldRecord): void => {
		try {
			deps.record?.(value);
		} catch {
			/* a trace sink may not fail a boundary */
		}
	};

	const signatureOf = (children: readonly HoldChild[]): string =>
		children
			.map((child) => `${child.name}#${child.round}`)
			.sort()
			.join(",");

	/** True only while the user has TEXT queued for this run; never a notification (§2 H12). */
	const userWaiting = (ctx: HoldContext | undefined): boolean => {
		try {
			const probe = ctx?.hasPendingMessages;
			return typeof probe === "function" && probe.call(ctx) === true;
		} catch {
			// A stale ctx getter throws on read; a hold must not end (or fail) on it.
			return false;
		}
	};

	/** Watch for the one channel that can carry "the user pressed Esc" out of this boundary. */
	const attachEsc = (ctx: HoldContext | undefined, interrupt: () => void): (() => void) => {
		try {
			const ui = ctx?.ui;
			const subscribe = ui?.onTerminalInput;
			if (typeof subscribe !== "function") return () => undefined;
			const off = subscribe.call(ui, (data: string) => {
				if (data === ESC) interrupt();
				// Never `{ consume: true }`: the host keeps its own Esc meaning (abort()).
				return undefined;
			});
			return typeof off === "function" ? (off as () => void) : () => undefined;
		} catch {
			// A non-interactive host has no raw input; the budget stays the only bound.
			return () => undefined;
		}
	};

	const abstain = (outcome: HoldOutcome, at: number, reason?: string): undefined => {
		record({ ev: "hold:abstain", at, outcome, ...(reason === undefined ? {} : { reason }) });
		return undefined;
	};

	const beforeSettle = async (
		event?: unknown,
		ctx?: unknown,
	): Promise<{ entries: HoldDraft[]; continue: true } | undefined> => {
		const startedAt = now();
		const boundary = (event ?? {}) as BoundaryEvent;
		const entriesIn = Array.isArray(boundary.entries) ? boundary.entries : [];
		try {
			if (disposed) return abstain("disposed", startedAt);
			// The nested gate (#417 D4): a legion child keeps its own bounded reminder
			// channel and must never park its parent's boundary — otherwise every level of
			// a recursive team would wait for the level below it.
			if (process.env.PI_LEGION_NODE_ID !== undefined) return abstain("nested", startedAt);
			const context = ctx as HoldContext | undefined;
			// Mode whitelist (#417 禁止): `print`/`json` would delay the process exit and
			// `rpc` runs under a client timeout. A missing/unknown mode abstains too — the
			// whitelist is the safe direction, and an absent ctx is never a TUI session.
			if (context?.mode !== "tui") return abstain("mode", startedAt);
			// A run the host ALREADY marked aborted/errored is the cancel exit: no hold, and
			// above all no announcement (entries persist through an abort — §3 H11).
			const outcome = boundary.outcome;
			if (outcome !== undefined && outcome !== "completed") return abstain("cancelled", startedAt);
			const children = deps.liveChildren();
			if (children === undefined) return abstain("degraded", startedAt);
			if (children.length === 0) return abstain("idle", startedAt);
			// §7: the user's own message must never wait behind this hold. Checked before the
			// first sleep, so a boundary that opens with a queued message is not held at all.
			if (userWaiting(context)) return abstain("user-waiting", startedAt);
			const signature = signatureOf(children);
			if (gaveUp.has(signature)) return abstain("already-gave-up", startedAt);

			// From here the hold owns the boundary.
			deps.ownsBoundary?.();
			let interrupted = false;
			let wake = (): void => undefined;
			const interruptPromise = new Promise<void>((resolve) => {
				wake = resolve;
			});
			const detach = attachEsc(context, () => {
				interrupted = true;
				wake();
			});
			const heldFrom = now();
			record({
				ev: "hold:begin",
				at: heldFrom,
				outcome: "completed",
				children: children.map((child) => `${child.name}#${child.round}`),
				entriesIn: entriesIn.length,
			});

			/**
			 * Every exit that delivers nothing: RELEASE FIRST, then return. The order is
			 * load-bearing (§4 D3): the host commits drafts when the handler returns, so a
			 * release that ran afterwards would put a notice back into the outbox that the
			 * boundary already announced — a duplicate — while a commit without a delivered
			 * boundary loses the notification outright.
			 */
			const exitWithoutDelivery = (exitOutcome: HoldOutcome, reason?: string): undefined => {
				const at = now();
				deps.releaseNotice();
				record({ ev: "hold:release", at, outcome: exitOutcome });
				record({
					ev: "hold:end",
					at,
					outcome: exitOutcome,
					heldMs: at - heldFrom,
					entriesIn: entriesIn.length,
					entriesOut: 0,
					...(reason === undefined ? {} : { reason }),
				});
				return undefined;
			};

			try {
				// Everything from here can only END the hold early; the budget is the fallback.
				for (;;) {
					if (interrupted) return exitWithoutDelivery("cancelled");
					if (userWaiting(context)) return exitWithoutDelivery("user-waiting");
					const elapsed = now() - heldFrom;
					if (elapsed >= holdMaxMs) {
						// Budget spent: settle exactly as without the hold, and remember this child
						// set so the next boundary does not park for another ten minutes.
						gaveUp.add(signature);
						return exitWithoutDelivery("timeout");
					}
					// Never sleep past the deadline: the total cost stays holdMs + one poll.
					// Racing the wake promise means Esc is honoured in milliseconds.
					await Promise.race([sleep(Math.min(pollMs, holdMaxMs - elapsed)), interruptPromise]);
					if (interrupted) return exitWithoutDelivery("cancelled");
					if (userWaiting(context)) return exitWithoutDelivery("user-waiting");
					if (now() - heldFrom >= holdMaxMs) {
						gaveUp.add(signature);
						return exitWithoutDelivery("timeout");
					}
					const live = deps.liveChildren();
					if (live === undefined) return exitWithoutDelivery("degraded");
					if (live.length > 0) continue;
					// Every child settled. The outbox was filled synchronously by the join sink
					// the moment the last watch buffered its terminal snapshot, so an empty
					// `takeNotice()` here really means "nothing is owed", not "not yet".
					const taken = deps.takeNotice();
					if (!taken) return exitWithoutDelivery("completed-empty");
					// The latch is persisted BEFORE the drafts leave this function: the host
					// commits returned entries even when it suppresses the continuation, and a
					// notice that was announced must never be announced again.
					deps.commitNotice();
					const at = now();
					record({ ev: "hold:commit", at, outcome: "completed", noticeChars: taken.content.length });
					record({
						ev: "hold:end",
						at,
						outcome: "completed",
						heldMs: at - heldFrom,
						entriesIn: entriesIn.length,
						entriesOut: entriesIn.length + taken.drafts.length,
						noticeChars: taken.content.length,
					});
					return {
						// #417 rule 3: spread. The host REPLACES `entries`; a bare list here would
						// silently delete every draft another handler queued before us (§1 1d).
						entries: [...(entriesIn as HoldDraft[]), ...taken.drafts],
						// #417 rule 2: the only `continue` this module ever returns.
						continue: true,
					};
				}
			} finally {
				detach();
			}
		} catch (error) {
			// A hold is a courtesy: any failure lets the turn settle as it would have, and
			// a taken notice goes back to its normal sender instead of being lost.
			try {
				deps.releaseNotice();
			} catch {
				/* the release path is itself best-effort */
			}
			return abstain("error", now(), error instanceof Error ? error.message : String(error));
		}
	};

	return {
		beforeSettle,
		dispose() {
			disposed = true;
		},
	};
}
