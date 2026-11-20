/**
 * #442 — where a `notice()` goes, and what the user is allowed to read when it
 * cannot go there.
 *
 * Three defects, one file, because they are three answers to the same question
 * ("did this notice reach the session?") and separating them would let them drift:
 *
 * **A. the channel has to be LIVE.** `notice()` used to call the `pi` its closure
 * captured at extension-load time. The host invalidates that object on
 * `ctx.newSession()` / `fork` / `switchSession` / `reload()`
 * (`ExtensionRunner.invalidate` → `ExtensionRuntime.assertActive`), and every
 * action on it then throws "This extension ctx is stale after session replacement
 * or reload". A legion runtime outlives the replacement by design — a stall
 * watcher, the mail postman, a resume queued from the load path — so the captured
 * `pi` was a guaranteed silent loss: the user saw the red stderr line and got no
 * notice. The fix is NOT "catch harder": the replacement session loads the
 * extension again with a FRESH `pi`, so this module keeps a per-scope registry of
 * the newest load's channel and a caller resolves it at delivery time. `pi` stays
 * as the last-resort fallback (a session that no later load instruments, or a host
 * that still accepts it).
 *
 * The scope is what keeps that registry from becoming a router between siblings:
 * one process holds the root session AND every in-process child, so a single
 * "current channel" slot would hand a parent's notice to whichever child happened
 * to load last. A child's scope is its own legion node
 * (`legionIdentityKey`'s `(dbPath, nodeId)` — the same pair the identity cache
 * uses, so a resume of that node replaces exactly its own entry), and the root's
 * is the constant {@link ROOT_NOTICE_SCOPE}.
 *
 * **B. a failure is ONE line, never the body.** The body is the notice itself: a
 * stall mail is hundreds of bytes of From/Subject/Urgency/facts, and printing it
 * per delivery attempt is what the user reported as "满屏红字". The body goes to
 * the log file (it is the recovery path — a notice nobody received must still be
 * readable), and the transcript gets one summary line per failure CLASS per
 * {@link NOTICE_FAILURE_WINDOW_MS}; the rest are counted.
 *
 * **C. the same detection is attempted once.** Three postman instances can stamp
 * the same stall fact milliseconds apart; their bodies differ only in the fields
 * the delivery layer can see change per tick (the mail row id, the
 * `Detected at …` stamp), so the delivery key is the body with those normalized.
 * That is `(child, kind, tier, windowBase)` as the writer froze it into the text —
 * see {@link stallNoticeDeliveryKey}. #441 owns "should this have been reported at
 * all"; this file only stops the repeat from reaching the transcript three times.
 *
 * Everything here is injectable (clock, log sink, reporter) and the shared state
 * lives on ONE process-global symbol: the host reloads the extension with
 * `moduleCache: false`, so a module-level `Map` would be re-created per load and
 * the "resolve the newest channel" lookup would answer nothing in production even
 * though it answers fine in a test that imports this file once.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { STALL_NOTICE_SUBJECT_PREFIX } from "../legion/stall-notice.ts";

/** The scope of the process's root session (there is exactly one per process). */
export const ROOT_NOTICE_SCOPE = "root";

/** Log file (under the run store root) that holds undelivered bodies. */
export const NOTICE_LOG_FILE = "notice-delivery.log";

/** Above this the log keeps its newest half; it is a recovery aid, not a journal. */
export const NOTICE_LOG_MAX_BYTES = 256 * 1024;

/**
 * How long one stall detection may not be attempted again (#442 C).
 *
 * Far longer than the millisecond-apart stampede this closes, and far shorter
 * than any threshold the detectors use (minutes), so a genuinely LATER boundary is
 * never suppressed — and it cannot be anyway: a new boundary changes the elapsed
 * text, which is part of the key.
 */
export const NOTICE_DEDUPE_WINDOW_MS = 60_000;

/** At most one summary line per failure class per window (#442 B). */
export const NOTICE_FAILURE_WINDOW_MS = 1_000;

/** The reason in the summary line is truncated here; the log keeps it whole. */
export const NOTICE_REASON_MAX_CHARS = 160;

/** One delivery target: send `text` into the session transcript. May throw. */
export type NoticeSend = (text: string) => void;

/**
 * A session load's delivery channel.
 *
 * `owner` is the `pi` the load captured, compared by identity and used for exactly
 * one decision: when the caller IS the channel's owner there is nothing to fall
 * back to, so one send attempt is one attempt (not the same broken object twice).
 */
export interface NoticeChannel {
	readonly owner: unknown;
	readonly send: NoticeSend;
	/** Where an undelivered body is written; absent = no log for this session. */
	readonly logPath?: () => string | undefined;
}

export type NoticeDeliveryStatus = "delivered" | "deduped" | "undelivered";
/** Which attempt won: the scope's live channel, or the caller's captured `pi`. */
export type NoticeDeliveryVia = "live" | "fallback";

export interface NoticeDeliveryOutcome {
	readonly status: NoticeDeliveryStatus;
	readonly via?: NoticeDeliveryVia;
	/** Identical stall detections merged into THIS attempt (#442 C). */
	readonly deduped: number;
	/** Failure reason, when `status === "undelivered"`. */
	readonly reason?: string;
	/** The log file this notice was written to / pointed at, when one resolved. */
	readonly logPath?: string;
	/** True when this failure also produced the ONE summary line (#442 B). */
	readonly reported?: boolean;
}

export interface NoticeDeliveryStats {
	delivered: number;
	deduped: number;
	undelivered: number;
	/** Summary lines actually emitted (== 1 per failure class per window). */
	reported: number;
}

export interface NoticeDeliveryOptions {
	/** Clock reading for this attempt (tests pin it; production uses `Date.now`). */
	now?: number;
	dedupeWindowMs?: number;
	failureWindowMs?: number;
	/** Sink for the ONE summary line. Defaults to `console.error`. */
	report?: (line: string) => void;
}

interface DeliveryState {
	channels: Map<string, NoticeChannel>;
	/** load-captured `pi` → the scope it delivers for (#442 A). */
	scopes: WeakMap<object, string>;
	anonymousScopes: number;
	/** `(scope, delivery key)` → the window this key is currently in (#442 C). */
	dedupe: Map<string, { at: number; deduped: number }>;
	/** `(scope, subject)` → the failure burst this class is in (#442 B). */
	failures: Map<string, { at: number; deduped: number }>;
	stats: NoticeDeliveryStats;
}

const STORE_KEY = Symbol.for("pi-legion.notice-delivery");

function store(): DeliveryState {
	const holder = globalThis as unknown as Record<symbol, DeliveryState | undefined>;
	const existing = holder[STORE_KEY];
	if (existing !== undefined) return existing;
	const created: DeliveryState = {
		channels: new Map(),
		scopes: new WeakMap(),
		anonymousScopes: 0,
		dedupe: new Map(),
		failures: new Map(),
		stats: { delivered: 0, deduped: 0, undelivered: 0, reported: 0 },
	};
	holder[STORE_KEY] = created;
	return created;
}

/**
 * Forget every channel, window and counter (#442 test seam).
 *
 * Process-global state outliving the module is the point in production and a
 * hazard in a suite that boots several extension instances in one process, so the
 * tests reset it between harnesses.
 */
export function resetNoticeDelivery(): void {
	const holder = globalThis as unknown as Record<symbol, DeliveryState | undefined>;
	delete holder[STORE_KEY];
}

/** The counters as they stand (#442: `reported` is what the transcript got). */
export function noticeDeliveryStats(): NoticeDeliveryStats {
	return { ...store().stats };
}

/**
 * The scope a load-captured `pi` delivers for. An unregistered object answers
 * {@link ROOT_NOTICE_SCOPE}: this extension has one root session per process, and
 * a caller that reaches `notice()` without a channel is that root.
 */
export function rememberNoticeScope(owner: object, scope: string): void {
	store().scopes.set(owner, scope);
}

export function noticeScopeOf(owner: object): string {
	return store().scopes.get(owner) ?? ROOT_NOTICE_SCOPE;
}

/**
 * The scope key of THIS extension load (#442 A).
 *
 * A child's channel is keyed by its legion identity, from the SAME two fields the
 * identity cache uses — and from the SAME channel: an in-process child carries
 * them in its AsyncLocalStorage context and must NOT read `PI_LEGION_*` (that env
 * is its parent's, and under an rpc parent it points at an ancestor). The root has
 * no identity before its first launch, and needs none: there is one.
 */
export function noticeScopeKey(input: {
	isChild: boolean;
	dbPath?: string | undefined;
	nodeId?: string | undefined;
}): string {
	if (!input.isChild) return ROOT_NOTICE_SCOPE;
	if (input.nodeId) return `node:${input.dbPath ?? "-"}\u0000${input.nodeId}`;
	// A utility child may have no node id at all. It gets a scope nobody else can
	// resolve, which is the truthful answer: there is no successor of "unknown node".
	const state = store();
	state.anonymousScopes += 1;
	return `node:anonymous#${state.anonymousScopes}`;
}

/** Install `channel` as the live delivery target of `scope`; returns its uninstall. */
export function installNoticeChannel(scope: string, channel: NoticeChannel): () => void {
	const channels = store().channels;
	channels.set(scope, channel);
	return () => {
		// Only the newest install may uninstall: a replacement session already owns
		// the entry by the time the old session's shutdown runs.
		if (channels.get(scope) === channel) channels.delete(scope);
	};
}

/** The live channel of `scope`, or `undefined` when this process has none. */
export function liveNoticeChannel(scope: string): NoticeChannel | undefined {
	return store().channels.get(scope);
}

const MAIL_ENVELOPE_HEAD = /^\[legion mail #\d+\]$/m;
const DETECTED_AT_LINE = /^Detected at .*$/m;
const SUBJECT_LINE = /^Subject: (.*)$/m;

/**
 * The `kind` of a notice: a mail envelope's `Subject`, else its first non-empty
 * line. Used for the summary line and as the failure class (#442 B) — a stall
 * notice is one class no matter which child it names, which is what keeps a
 * stampede from three detectors down to one line.
 */
export function noticeKind(text: string): string {
	const subject = SUBJECT_LINE.exec(text)?.[1]?.trim();
	if (subject !== undefined && subject.length > 0) return subject;
	const first = text.split("\n").map((line) => line.trim()).find((line) => line.length > 0);
	return (first ?? "(empty)").slice(0, 80);
}

/**
 * The delivery key of a stall notice, or `undefined` when this is not one (#442 C).
 *
 * The requirement is one delivery attempt per `(child, kind, tier, windowBase)`.
 * Those four facts exist only inside the DETECTOR, and the detectors are not one
 * object: each postman instance owns its own window state, which is why the same
 * fact can be stamped three times in 30ms. What all writers DO share is the body
 * they freeze, so the identity is read out of it:
 *
 * - `Subject: Stall notice: <child…>` → child (and the fact that it is a stall notice);
 * - the `L1 silence` / `L2 long-running` section → kind;
 * - `running for <elapsed> (threshold <radius>)` → the tier AND the window base —
 *   a later boundary re-words this line, which is exactly when a new attempt is due.
 *
 * The two fields that change per tick are normalized away: the mail row id (three
 * writers ⇒ three rows for one fact) and the `Detected at …` stamp (D1 of
 * stall-notice-staleness: the snapshot time, not the fact). Anything else — a new
 * child, a new kind, a crossed boundary — hashes differently.
 */
export function stallNoticeDeliveryKey(text: string): string | undefined {
	const kind = noticeKind(text);
	if (!kind.startsWith(STALL_NOTICE_SUBJECT_PREFIX)) return undefined;
	const normalized = text
		.replace(MAIL_ENVELOPE_HEAD, "[legion mail #<id>]")
		.replace(DETECTED_AT_LINE, "Detected at <stamp>");
	return `${kind}\u0000${createHash("sha1").update(normalized, "utf8").digest("hex").slice(0, 16)}`;
}

/**
 * Deliver ONE notice into the session that owns `scope`.
 *
 * Order is the fix for #442 A: the scope's live channel first, the caller's
 * load-captured `pi` only when they are different loads and only after the live
 * one refused. A send is synchronous by host contract, so "the first attempt that
 * does not throw" is the whole retry policy — a retry ladder here would only
 * multiply the failures the user sees.
 */
export function deliverNotice(
	input: {
		scope: string;
		text: string;
		/** The `pi` this notice's closure captured at load time. */
		owner: unknown;
		live: NoticeChannel | undefined;
		fallback: NoticeSend;
	},
	options: NoticeDeliveryOptions = {},
): NoticeDeliveryOutcome {
	const state = store();
	const now = options.now ?? Date.now();
	const { text } = input;
	const bytes = Buffer.byteLength(text, "utf8");
	const kind = noticeKind(text);
	const logPath = input.live?.logPath?.();

	// ── C: one attempt per detection ─────────────────────────────────────────
	const dedupeKey = stallNoticeDeliveryKey(text);
	if (dedupeKey !== undefined) {
		const windowMs = options.dedupeWindowMs ?? NOTICE_DEDUPE_WINDOW_MS;
		const key = `${input.scope}\u0000${dedupeKey}`;
		const seen = state.dedupe.get(key);
		if (seen !== undefined && now - seen.at < windowMs) {
			seen.deduped += 1;
			state.stats.deduped += 1;
			appendNoticeLog(
				logPath,
				`${new Date(now).toISOString()} notice deduplicated scope=${input.scope} kind=${quote(kind)} bytes=${bytes} deduped=${seen.deduped} windowMs=${windowMs}`,
			);
			return { status: "deduped", deduped: seen.deduped, logPath };
		}
		pruneWindow(state.dedupe, now, windowMs);
		state.dedupe.set(key, { at: now, deduped: 0 });
	}

	// ── A: live channel first, the captured `pi` last ────────────────────────
	const attempts: Array<{ via: NoticeDeliveryVia; send: NoticeSend }> = [];
	if (input.live !== undefined) attempts.push({ via: "live", send: input.live.send });
	if (input.live?.owner !== input.owner) attempts.push({ via: "fallback", send: input.fallback });
	let lastError: unknown;
	for (const attempt of attempts) {
		try {
			attempt.send(text);
			state.stats.delivered += 1;
			return { status: "delivered", via: attempt.via, deduped: 0 };
		} catch (error) {
			lastError = error;
		}
	}

	// ── B: one line, counted; the body goes to the log ────────────────────────
	const reason = messageOf(lastError);
	state.stats.undelivered += 1;
	const failureKey = `${input.scope}\u0000${kind}`;
	const failureWindowMs = options.failureWindowMs ?? NOTICE_FAILURE_WINDOW_MS;
	const burst = state.failures.get(failureKey);
	const quiet = burst !== undefined && now - burst.at < failureWindowMs;
	const deduped = quiet ? burst.deduped + 1 : 0;
	const written = appendNoticeLog(
		logPath,
		`${new Date(now).toISOString()} notice undelivered scope=${input.scope} kind=${quote(kind)} bytes=${bytes} reason=${quote(reason)} deduped=${deduped}${writtenBody(text)}`,
	);
	if (!quiet) {
		state.failures.set(failureKey, { at: now, deduped });
		const line = `[pi-legion] notice not delivered: ${clamp(reason)}; kind=${clamp(kind)}; bytes=${bytes}; body → ${written ?? "not written (no log for this session)"}${deduped > 0 ? ` (deduped=${deduped})` : ""}`;
		state.stats.reported += 1;
		(options.report ?? defaultReport)(line);
	} else {
		state.failures.set(failureKey, { at: burst.at, deduped });
	}
	return {
		status: "undelivered",
		deduped,
		reason,
		reported: !quiet,
		...(written === undefined ? {} : { logPath: written }),
	};
}

function defaultReport(line: string): void {
	console.error(line);
}

function messageOf(error: unknown): string {
	if (error instanceof Error) return error.message;
	return String(error);
}

/** One-line safety: the reason/kind must not grow a second line in the transcript. */
function clamp(value: string, max = NOTICE_REASON_MAX_CHARS): string {
	const flat = value.replace(/\s+/g, " ").trim();
	return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

function quote(value: string): string {
	return JSON.stringify(clamp(value, 240));
}

const BODY_SEPARATOR = "\n  body: ";

function writtenBody(text: string): string {
	return `${BODY_SEPARATOR}${text.split("\n").join("\n  ")}`;
}

/**
 * Append one line (or one record + its body) to the notice log.
 *
 * Returns the file it actually wrote, so the summary line can point at a real path
 * instead of claiming a log that does not exist — "已写日志" and "没地方写" must not
 * look alike. Every failure here is swallowed: a log is a diagnostic, and the one
 * thing this path may never do is fail louder than the delivery it reports.
 */
function appendNoticeLog(file: string | undefined, line: string): string | undefined {
	if (file === undefined) return undefined;
	try {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.appendFileSync(file, `${line}\n`, "utf8");
		trimNoticeLog(file);
		return file;
	} catch {
		return undefined;
	}
}

function trimNoticeLog(file: string): void {
	try {
		const { size } = fs.statSync(file);
		if (size <= NOTICE_LOG_MAX_BYTES) return;
		const raw = fs.readFileSync(file, "utf8");
		const kept = raw.slice(-Math.floor(NOTICE_LOG_MAX_BYTES / 2));
		const atLineStart = kept.indexOf("\n");
		fs.writeFileSync(file, atLineStart === -1 ? kept : kept.slice(atLineStart + 1), "utf8");
	} catch {
		/* best effort — the record is already written */
	}
}

/** Drop windows that can no longer suppress anything, so the map cannot grow. */
function pruneWindow(windows: Map<string, { at: number; deduped: number }>, now: number, windowMs: number): void {
	if (windows.size < 64) return;
	for (const [key, value] of windows) {
		if (now - value.at >= windowMs) windows.delete(key);
	}
}
