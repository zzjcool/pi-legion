/**
 * Session jsonl parsing + execution-outcome derivation.
 *
 * This is the ONLY trustworthy source for success/failure (findings F26-F31):
 * process lifecycle events cannot distinguish successful turns from LLM errors and kills.
 *
 * Authoritative stopReason enum (pi docs, session-format.md:88):
 *   "stop" | "length" | "toolUse" | "error" | "aborted"
 *
 * Measured semantics:
 *   F29 — `"aborted"` is never actually written. A graceful interrupt (esc) writes
 *         `error` + an errorMessage containing "aborted". A hard kill writes NO
 *         assistant message at all, so "missing reply" IS the abort signal.
 *   F30 — tool errors are per-turn and do NOT make a turn fail.
 *   F31 — only the LAST turn decides the outcome.
 */

import * as fs from "node:fs";
import type {
	Execution,
	ParsedSession,
	StopReason,
	TurnRecord,
	Usage,
} from "./types.ts";

const KNOWN_STOP_REASONS: ReadonlySet<string> = new Set([
	"stop",
	"length",
	"toolUse",
	"error",
	"aborted",
]);
function emptyUsage(): Usage {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
}

/** Mutable clock used while folding events; not part of ParsedSession. */
export interface GenerationClock {
	/** Nested Unix-ms timestamp of the message that opened this generation window. */
	awaitingSince?: number;
	/**
	 * Same window edge expressed as the enclosing entry's write instant.
	 *
	 * Sessions may carry only the nested timestamp, only the entry ISO timestamp,
	 * or both. Measuring an end against a start from a different axis yields a
	 * nonsense span, so each window records both edges and `applyAssistant`
	 * pairs like with like.
	 */
	awaitingWall?: number;
}

export function emptyParsedSession(): ParsedSession {
	return {
		output: "",
		lastTurnOutput: null,
		usage: emptyUsage(),
		model: null,
		stopReason: null,
		turns: [],
		toolErrors: 0,
		lastTurnMissing: false,
		tornLines: 0,
		generationMs: 0,
	};
}

function asStopReason(value: unknown): StopReason | null {
	return typeof value === "string" && KNOWN_STOP_REASONS.has(value)
		? (value as StopReason)
		: null;
}

function textOf(content: unknown): string | null {
	if (!Array.isArray(content)) return null;
	let last: string | null = null;
	for (const part of content) {
		if (
			part &&
			typeof part === "object" &&
			(part as { type?: unknown }).type === "text"
		) {
			const t = (part as { text?: unknown }).text;
			if (typeof t === "string" && t.trim()) last = t;
		}
	}
	return last;
}

function toolsOf(content: unknown): string[] {
	if (!Array.isArray(content)) return [];
	const out: string[] = [];
	for (const part of content) {
		if (
			part &&
			typeof part === "object" &&
			(part as { type?: unknown }).type === "toolCall"
		) {
			const n = (part as { name?: unknown }).name;
			if (typeof n === "string") out.push(n);
		}
	}
	return out;
}

function userTextOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const part of content) {
		if (typeof part === "string") parts.push(part);
		else if (
			part &&
			typeof part === "object" &&
			typeof (part as { text?: unknown }).text === "string"
		) {
			parts.push((part as { text: string }).text);
		}
	}
	return parts.join(" ");
}

/**
 * Accumulate token usage from an assistant message into the running total.
 *
 * Returns this message's context size — `input + cacheRead + cacheWrite`, the
 * prompt the model actually saw. `usage` is a lifetime sum across every
 * message, so it cannot answer "how full is the context right now"; the caller
 * keeps only the LAST returned value. `undefined` when the message carried no
 * usage object (nothing was reported, which is not the same as zero).
 */
function accumulateUsage(
	target: Usage,
	message: Record<string, unknown>,
): number | undefined {
	const usage = message.usage as Record<string, unknown> | undefined;
	if (!usage || typeof usage !== "object") return undefined;
	const cost = usage.cost as Record<string, unknown> | undefined;
	target.input += num(usage.input);
	target.output += num(usage.output);
	target.cacheRead += num(usage.cacheRead);
	target.cacheWrite += num(usage.cacheWrite);
	target.cost += num(cost?.total);
	return num(usage.input) + num(usage.cacheRead) + num(usage.cacheWrite);
}

/**
 * Turn-boundary timestamp for the current-turn elapsed display.
 *
 * Prefers the nested message `timestamp` (Unix ms, session-format.md) — for the
 * elapsed display the moment generation began is exactly what we want — and
 * falls back to the ISO 8601 entry timestamp for entries written without it.
 * Generation *duration* is measured elsewhere (`applyAssistant`): the nested
 * value marks a start, not a completion, and `durationMs` carries the length.
 */
function messageTimestamp(
	event: Record<string, unknown>,
	message: Record<string, unknown>,
): number | undefined {
	const inner = message.timestamp;
	if (typeof inner === "number" && Number.isFinite(inner)) return inner;
	const outer = event.timestamp;
	if (typeof outer === "string") {
		const ms = Date.parse(outer);
		if (Number.isFinite(ms)) return ms;
	}
	return undefined;
}

/**
 * The instant a message was written, on the same Unix-ms axis as
 * `message.timestamp`. Used for the generation clock so start and end share a
 * basis; a session that only carries the entry ISO timestamp would otherwise
 * mix a wall-clock instant into a Unix-ms subtraction.
 */
function entryWrittenAt(event: Record<string, unknown>): number | undefined {
	const outer = event.timestamp;
	if (typeof outer !== "string") return undefined;
	const ms = Date.parse(outer);
	return Number.isFinite(ms) ? ms : undefined;
}

/** Find (or create) the turn an assistant/toolResult message belongs to. */
function currentTurn(parsed: ParsedSession): TurnRecord {
	const existing = parsed.turns.at(-1);
	if (existing) return existing;
	const created: TurnRecord = {
		userText: "",
		assistants: [],
		toolResults: 0,
		toolErrors: 0,
	};
	parsed.turns.push(created);
	return created;
}

function applyAssistant(
	parsed: ParsedSession,
	message: Record<string, unknown>,
	timestamp: number | undefined,
	wall: number | undefined,
	clock: GenerationClock,
): void {
	const turn = currentTurn(parsed);
	const stopReason = asStopReason(message.stopReason);
	const text = textOf(message.content);

	turn.assistants.push({
		stopReason,
		...(typeof message.stopReason === "string"
			? { rawStopReason: message.stopReason }
			: {}),
		errorMessage:
			typeof message.errorMessage === "string" ? message.errorMessage : null,
		text,
		tools: toolsOf(message.content),
		// #316 D3: carried verbatim so a failure can be traced back to one
		// upstream response. Never read by any verdict.
		...(typeof message.responseId === "string"
			? { responseId: message.responseId }
			: {}),
	});
	if (timestamp !== undefined) turn.endedAt = timestamp;

	// Generation time spans the wait for the model plus the model call itself. Two
	// strictly paired sources, never mixed:
	//   1. `durationMs` — an exact length reported by the provider, axis-free.
	//   2. entry-to-entry (`wall` − `awaitingWall`) — both edges are write instants,
	//      so a session that omits nested timestamps still measures correctly.
	// Subtracting the nested `message.timestamp` is NOT the completion instant: it
	// marks when generation began, so it captures only prompt→first-token latency
	// (2-7ms on real sessions). It survives as a last resort for synthetic or
	// legacy sessions that carry no entry timestamps at all.
	const measured = message.durationMs;
	if (typeof measured === "number" && Number.isFinite(measured) && measured >= 0) {
		parsed.generationMs += measured;
	} else if (wall !== undefined && clock.awaitingWall !== undefined && wall >= clock.awaitingWall) {
		parsed.generationMs += wall - clock.awaitingWall;
	} else if (
		timestamp !== undefined &&
		clock.awaitingSince !== undefined &&
		timestamp >= clock.awaitingSince
	) {
		parsed.generationMs += timestamp - clock.awaitingSince;
	}
	clock.awaitingSince = undefined;
	clock.awaitingWall = undefined;

	const contextTokens = accumulateUsage(parsed.usage, message);
	// Later assistant messages overwrite earlier ones: the newest prompt size is
	// the one that describes the context the model is holding now.
	if (contextTokens !== undefined) parsed.lastContextTokens = contextTokens;
	if (typeof message.model === "string") parsed.model = message.model;
	if (stopReason) parsed.stopReason = stopReason;
	// `output`: the last non-empty text anywhere (kept for display/back-compat).
	if (text) parsed.output = text;
}

function applyToolResult(
	parsed: ParsedSession,
	message: Record<string, unknown>,
	timestamp: number | undefined,
	wall: number | undefined,
	clock: GenerationClock,
): void {
	const turn = parsed.turns.at(-1);
	if (!turn) return;
	turn.toolResults += 1;
	if (message.isError === true) {
		turn.toolErrors += 1;
		parsed.toolErrors += 1;
	}
	// Tool completion starts the next generation window (model resumes).
	if (timestamp !== undefined) clock.awaitingSince = timestamp;
	if (wall !== undefined) clock.awaitingWall = wall;
}

/**
 * Parse session JSONL text into a structured view.
 * Tolerates torn/partial lines (F12: a mid-turn kill leaves no corruption,
 * but a crash could still truncate the final write).
 */
export function parseSessionText(text: string): ParsedSession {
	const parsed = emptyParsedSession();
	if (!text) return parsed;
	const clock: GenerationClock = {};

	for (const raw of text.split("\n")) {
		const line = raw.trim();
		if (!line) continue;

		const event = decodeEvent(line);
		if (!event) {
			parsed.tornLines += 1;
			continue;
		}
		applyEvent(parsed, event, clock);
	}

	const last = parsed.turns.at(-1);
	parsed.lastTurnMissing = Boolean(last && last.assistants.length === 0);
	// Derived from the definition rather than tracked incrementally: "the final
	// assistant message of the last turn". Tracking it as messages arrive leaves
	// an earlier turn's text in place whenever the last turn has no assistant
	// message at all (a hard kill), which is exactly the stale-verdict bug (F39).
	parsed.lastTurnOutput = last?.assistants.at(-1)?.text ?? null;
	return parsed;
}

/**
 * Decode one JSONL line into an event object.
 *
 * Returns `null` for anything that is not a plain object, which covers both a
 * syntax error and a bare scalar: `JSON.parse` happily yields `null`, `42`,
 * `true` and `"x"`, and reading `.type` off `null` would take down the whole
 * parse. The session file is external input — an RPC child can be terminated
 * mid-write — so a damaged line must never be fatal.
 */
function decodeEvent(line: string): Record<string, unknown> | null {
	let decoded: unknown;
	try {
		decoded = JSON.parse(line);
	} catch {
		return null;
	}
	if (
		decoded === null ||
		typeof decoded !== "object" ||
		Array.isArray(decoded)
	) {
		return null;
	}
	return decoded as Record<string, unknown>;
}

/** Fold one decoded event into the parsed session. */
function applyEvent(
	parsed: ParsedSession,
	event: Record<string, unknown>,
	clock: GenerationClock,
): void {
	if (event.type === "model_change") {
		const model =
			typeof event.model === "string" ? event.model.trim() : "";
		if (model) parsed.model = model;
		return;
	}
	if (event.type !== "message") return;
	const message = event.message as Record<string, unknown> | undefined;
	if (!message || typeof message !== "object") return;
	const ts = messageTimestamp(event, message);
	// The entry write instant, on the same Unix-ms axis as `message.timestamp`.
	// Generation timing uses it so both window edges share one basis.
	const wall = entryWrittenAt(event);

	switch (message.role) {
		case "user":
			parsed.turns.push({
				userText: userTextOf(message.content),
				assistants: [],
				toolResults: 0,
				toolErrors: 0,
				...(ts !== undefined ? { startedAt: ts } : {}),
			});
			// User prompt opens a generation window.
			if (ts !== undefined) clock.awaitingSince = ts;
			if (wall !== undefined) clock.awaitingWall = wall;
			break;
		case "assistant":
			applyAssistant(parsed, message, ts, wall, clock);
			break;
		case "toolResult":
		case "tool":
			applyToolResult(parsed, message, ts, wall, clock);
			break;
		default:
			break;
	}
}

function num(v: unknown): number {
	return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/** Read-chunk size for streaming session parsing (#36). */
const SESSION_READ_CHUNK_BYTES = 1024 * 1024;
export const DEFAULT_SESSION_MAX_LINE_BYTES = 32 * 1024 * 1024;
export const SESSION_MAX_LINE_BYTES_ENV = "PI_LEGION_SESSION_MAX_LINE_BYTES";
/**
 * Hard bound on the incremental (offset) parse cache below.
 *
 * Raised 64 → 256 in #348 as **headroom, not as the source of that issue's
 * win**. The hypothesis that a 64-entry cap was routinely exceeded and turned
 * every tick into a cold re-read does not survive the issue's own logs: the
 * inner cache reported `misses=0` throughout the measured windows, i.e. this
 * cache was never the cost. The win came from the file-level gate
 * (`parseSessionFileCached`), which keeps an unchanging file out of the parser
 * altogether. The raise stays because the gate deliberately lets every genuine
 * append through to this cache, and a hot child process appending on every tick
 * should not evict sibling files at the old bound; 256 is that margin.
 */
export const SESSION_CACHE_MAX_ENTRIES = 256;

/** Per-line cap: one JSONL row larger than this is skipped (counted as torn). */
export function resolveSessionMaxLineBytes(env: NodeJS.ProcessEnv = process.env): number {
	const raw = env[SESSION_MAX_LINE_BYTES_ENV]?.trim();
	const n = raw ? Number(raw) : NaN;
	// #174: require floored value >= 1 — (0,1) must not become cap=0.
	return Number.isFinite(n) && n >= 1 ? Math.floor(n) : DEFAULT_SESSION_MAX_LINE_BYTES;
}

/** Append-only JSONL byte cursor shared by parseSessionFile and live-overlay (#234). */
export interface SessionByteCursor {
	dev: number;
	ino: number;
	/** Byte offset just past the last complete line consumed. */
	offset: number;
	/** Bytes at the head and just before `offset`; a mismatch means rewrite. */
	head: Buffer;
	boundary: Buffer;
}

interface SessionParseState extends SessionByteCursor {
	parsed: ParsedSession;
	/** Generation-interval clock; survives across incremental polls. */
	clock: GenerationClock;
}

const FINGERPRINT_BYTES = 256;

function readAt(fd: number, start: number, length: number): Buffer {
	const buf = Buffer.alloc(Math.max(0, length));
	const n = length > 0 ? fs.readSync(fd, buf, 0, length, start) : 0;
	return buf.subarray(0, n);
}

export function sessionFileFingerprint(fd: number, offset: number): { head: Buffer; boundary: Buffer } {
	const head = readAt(fd, 0, Math.min(FINGERPRINT_BYTES, offset));
	const start = Math.max(0, offset - FINGERPRINT_BYTES);
	return { head, boundary: readAt(fd, start, offset - start) };
}

export function sessionFileStillValid(
	fd: number,
	stat: fs.Stats,
	state: Pick<SessionByteCursor, "dev" | "ino" | "offset" | "head" | "boundary">,
): boolean {
	if (state.dev !== stat.dev || state.ino !== stat.ino || stat.size < state.offset) return false;
	const now = sessionFileFingerprint(fd, state.offset);
	return now.head.equals(state.head) && now.boundary.equals(state.boundary);
}

function fingerprint(fd: number, offset: number): { head: Buffer; boundary: Buffer } {
	return sessionFileFingerprint(fd, offset);
}

function stillValid(fd: number, stat: fs.Stats, state: SessionParseState): boolean {
	return sessionFileStillValid(fd, stat, state);
}

/** Incremental parse cache: append-only session files are only read past `offset`. */
const sessionParseCache = new Map<string, SessionParseState>();

/** Test hook: drop all incremental parse state. */
export function clearSessionParseCache(): void {
	sessionParseCache.clear();
}

/** Test hook: number of cached paths, so the LRU cap is asserted not assumed. */
export function sessionParseCacheSize(): number {
	return sessionParseCache.size;
}

/** Test hook: whether a path is cached, so eviction order is asserted, not inferred. */
export function sessionParseCacheHas(path: string): boolean {
	return sessionParseCache.has(path);
}

function applyLine(parsed: ParsedSession, raw: string, clock: GenerationClock): void {
	const line = raw.trim();
	if (!line) return;
	const event = decodeEvent(line);
	if (!event) {
		parsed.tornLines += 1;
		return;
	}
	applyEvent(parsed, event, clock);
}

/**
 * Stream complete lines from `fd` starting at `start`, never holding more than
 * one chunk plus one (capped) line in memory. A trailing partial line is left
 * for the next call (offset stays before it). Oversized rows are skipped and
 * counted in `tornLines` — same policy as parseSessionFile (#36).
 */
export function readCompleteSessionLines(
	fd: number,
	start: number,
	size: number,
	maxLineBytes: number,
): { offset: number; lines: string[]; tornLines: number } {
	const chunk = Buffer.allocUnsafe(SESSION_READ_CHUNK_BYTES);
	let pos = start;
	let consumed = start;
	let pending: Buffer[] = [];
	let pendingBytes = 0;
	let skipping = false;
	const lines: string[] = [];
	let tornLines = 0;
	while (pos < size) {
		const n = fs.readSync(fd, chunk, 0, Math.min(chunk.length, size - pos), pos);
		if (n <= 0) break;
		let lineStart = 0;
		for (let i = 0; i < n; i++) {
			if (chunk[i] !== 0x0a) continue;
			if (skipping) {
				tornLines += 1;
				skipping = false;
			} else {
				const piece = chunk.subarray(lineStart, i);
				const text = pendingBytes ? Buffer.concat([...pending, piece]).toString("utf8") : piece.toString("utf8");
				lines.push(text);
			}
			pending = [];
			pendingBytes = 0;
			lineStart = i + 1;
			consumed = pos + i + 1;
		}
		if (lineStart < n && !skipping) {
			const rest = Buffer.from(chunk.subarray(lineStart, n));
			pendingBytes += rest.length;
			if (pendingBytes > maxLineBytes) {
				// An oversized row (typically a giant tool result) is not worth
				// materialising; drop it and resynchronise at the next newline.
				pending = [];
				pendingBytes = 0;
				skipping = true;
			} else pending.push(rest);
		}
		pos += n;
	}
	return { offset: consumed, lines, tornLines };
}

/**
 * Stream complete lines from `fd` starting at `start`, never holding more than
 * one chunk plus one (capped) line in memory. Returns the offset just past the
 * last complete line; a trailing partial line is left for the next call.
 */
function consumeLines(
	fd: number,
	start: number,
	size: number,
	parsed: ParsedSession,
	clock: GenerationClock,
	maxLineBytes: number,
): number {
	const { offset, lines, tornLines } = readCompleteSessionLines(fd, start, size, maxLineBytes);
	for (const text of lines) applyLine(parsed, text, clock);
	parsed.tornLines += tornLines;
	return offset;
}

/** Result of an incremental JSONL append read (#234). */
export interface SessionJsonlDelta {
	/** Fingerprint cursor after committing complete lines. */
	cursor: SessionByteCursor;
	/** Newly completed lines since `previous` (provisional excluded). */
	lines: string[];
	/** Trailing incomplete bytes for this call only — do not commit. */
	provisional: string;
	fileSize: number;
	/** True when `previous` was discarded (rewrite / truncate / inode change). */
	reset: boolean;
	/** Oversized lines skipped while scanning this delta. */
	tornLines: number;
}

function emptyByteCursor(stat: fs.Stats): SessionByteCursor {
	return {
		dev: stat.dev,
		ino: stat.ino,
		offset: 0,
		head: Buffer.alloc(0),
		boundary: Buffer.alloc(0),
	};
}

/**
 * Seek to `previous.offset` and parse only appended bytes (#234).
 *
 * Same rewrite detection and trailing-partial policy as `parseSessionFile`:
 * provisional bytes are returned for this call but must not be committed by the
 * caller. Pass `undefined` for a cold read from byte 0. Missing files yield
 * `undefined`.
 */
export function readSessionJsonlDelta(
	path: string,
	previous: SessionByteCursor | undefined,
): SessionJsonlDelta | undefined {
	let fd: number | undefined;
	try {
		fd = fs.openSync(path, "r");
		const stat = fs.fstatSync(fd);
		const reset = !previous || !sessionFileStillValid(fd, stat, previous);
		const cursor = reset
			? emptyByteCursor(stat)
			: {
				dev: previous.dev,
				ino: previous.ino,
				offset: previous.offset,
				head: previous.head,
				boundary: previous.boundary,
			};
		const maxLineBytes = resolveSessionMaxLineBytes();
		const before = cursor.offset;
		const read = readCompleteSessionLines(fd, cursor.offset, stat.size, maxLineBytes);
		cursor.offset = read.offset;
		cursor.dev = stat.dev;
		cursor.ino = stat.ino;
		if (cursor.offset !== before) Object.assign(cursor, sessionFileFingerprint(fd, cursor.offset));
		let provisional = "";
		if (cursor.offset < stat.size && stat.size - cursor.offset <= maxLineBytes) {
			const tail = Buffer.allocUnsafe(stat.size - cursor.offset);
			const n = fs.readSync(fd, tail, 0, tail.length, cursor.offset);
			provisional = tail.subarray(0, n).toString("utf8");
		}
		return {
			cursor,
			lines: read.lines,
			provisional,
			fileSize: stat.size,
			reset,
			tornLines: read.tornLines,
		};
	} catch {
		return undefined;
	} finally {
		if (fd !== undefined) {
			try { fs.closeSync(fd); } catch { /* ignore */ }
		}
	}
}

/**
 * Snapshot the cache object for one caller (#237 P7).
 *
 * `state.parsed` is mutated IN PLACE across polls: `accumulateUsage` adds into
 * the existing `usage` object, `currentTurn` pushes turns, `applyAssistant`
 * pushes into a turn's `assistants` and writes `turn.endedAt`, and
 * `applyToolResult` bumps `turn.toolResults`/`toolErrors`. The caller must never
 * receive those objects, because the provisional tail below is parsed into the
 * returned value: sharing a turn would push the provisional assistant into the
 * CACHED turn, and the next poll's real commit would count it a second time
 * (a silent, permanent over-count in `turns`/`assistants`).
 *
 * The depth here is the minimum that makes every write point above land on a
 * fresh object — not "as deep as structuredClone":
 *   - `usage`  — mutated in place, so it needs its own object.
 *   - `turns`  — grown with `push`, so it needs its own array.
 *   - each turn — `endedAt`/`toolResults`/`toolErrors` are written back, so the
 *     turn objects themselves must be fresh.
 *   - each turn's `assistants` — grown with `push`, so it needs its own array.
 *   - each assistant and its `tools` — nothing in production writes these
 *     today (they are built once as a literal), but a caller can, and the
 *     whole point is that no mutation any caller makes reaches the cache. It
 *     costs ~0.01ms on a 5MB session and removes the last aliased object.
 * Anything deeper is pure waste. For scale: `structuredClone` at this call site
 * cost ~2.2x a warm parse that does no copy at all (P7), and the ~1ms/file it
 * burned is what this function gives back.
 */
function projectForCaller(parsed: ParsedSession): ParsedSession {
	return {
		...parsed,
		usage: { ...parsed.usage },
		turns: parsed.turns.map((turn): TurnRecord => ({
			...turn,
			assistants: turn.assistants.map((assistant): TurnRecord["assistants"][number] => ({
				...assistant,
				tools: assistant.tools.slice(),
			})),
		})),
	};
}

function finalizeParsed(parsed: ParsedSession): ParsedSession {
	const last = parsed.turns.at(-1);
	parsed.lastTurnMissing = Boolean(last && last.assistants.length === 0);
	parsed.lastTurnOutput = last?.assistants.at(-1)?.text ?? null;
	return parsed;
}

/**
 * Parse a session file. A missing file yields an empty (not throwing) result.
 *
 * Streams the file in chunks instead of `readFileSync` + `split` (#36), and
 * keeps an incremental per-path cache so repeated polls of a growing
 * append-only session only parse the newly appended bytes. A trailing partial
 * line (a write in progress) is parsed provisionally for this call but never
 * committed to the cache, matching the previous whole-file semantics.
 */
export function parseSessionFile(path: string): ParsedSession {
	let fd: number | undefined;
	try {
		fd = fs.openSync(path, "r");
		const stat = fs.fstatSync(fd);
		let state = sessionParseCache.get(path);
		if (!state || !stillValid(fd, stat, state)) {
			state = {
				dev: stat.dev,
				ino: stat.ino,
				offset: 0,
				head: Buffer.alloc(0),
				boundary: Buffer.alloc(0),
				parsed: emptyParsedSession(),
				clock: {},
			};
		}
		const maxLineBytes = resolveSessionMaxLineBytes();
		const before = state.offset;
		state.offset = consumeLines(fd, state.offset, stat.size, state.parsed, state.clock, maxLineBytes);
		if (state.offset !== before) Object.assign(state, fingerprint(fd, state.offset));
		sessionParseCache.delete(path);
		sessionParseCache.set(path, state);
		if (sessionParseCache.size > SESSION_CACHE_MAX_ENTRIES) {
			const oldest = sessionParseCache.keys().next().value;
			if (oldest !== undefined) sessionParseCache.delete(oldest);
		}
		const result = projectForCaller(state.parsed);
		if (state.offset < stat.size && stat.size - state.offset <= maxLineBytes) {
			const tail = Buffer.allocUnsafe(stat.size - state.offset);
			const n = fs.readSync(fd, tail, 0, tail.length, state.offset);
			// Provisional tail must not mutate the cached clock.
			applyLine(result, tail.subarray(0, n).toString("utf8"), { ...state.clock });
		}
		return finalizeParsed(result);
	} catch {
		sessionParseCache.delete(path);
		return emptyParsedSession();
	} finally {
		if (fd !== undefined) {
			try { fs.closeSync(fd); } catch { /* ignore */ }
		}
	}
}

/**
 * Upper bound on the file-level (`size`, `mtimeMs`) parse cache below.
 *
 * Same reasoning as {@link SESSION_CACHE_MAX_ENTRIES}: the number of distinct
 * session files one status sweep touches is bounded by the session history, so
 * the cap must sit above the sweep size for the cache to have any hit rate at
 * all. 256 covers a long session's ledger rows (issue #348 measured 151 files
 * across three scenarios) while staying a hard memory bound — an entry holds
 * one projected `ParsedSession`, i.e. turns/assistants/usage, not the raw JSONL.
 */
export const SESSION_FILE_CACHE_MAX_ENTRIES = 256;

interface SessionFileCacheEntry {
	/** Byte length at the time of the parse; a grow means bytes were appended. */
	size: number;
	/** mtime at the time of the parse; a same-length rewrite still moves this. */
	mtimeMs: number;
	parsed: ParsedSession;
}

const sessionFileCache = new Map<string, SessionFileCacheEntry>();
let sessionFileCacheHits = 0;
let sessionFileCacheMisses = 0;

/** Hit/miss counters for `parseSessionFileCached` (#348). Observability only — never rendered. */
export interface SessionFileCacheStats {
	hits: number;
	misses: number;
	size: number;
	/**
	 * `statSync` calls the gate has made. One per call by construction, so this
	 * is how a caller counts the *cost* of the gate itself: an unchanged file
	 * must cost exactly one stat and zero parses. `bench/perf-core/06-watch-tick.ts`
	 * asserts that per tick. (Counted here rather than by patching `fs` in the
	 * bench: `import * as fs from "node:fs"` bindings are read-only, so a
	 * monkeypatch is invisible to this module.)
	 */
	statCalls: number;
}

let sessionFileCacheStatCalls = 0;

export function sessionFileCacheStats(): SessionFileCacheStats {
	return {
		hits: sessionFileCacheHits,
		misses: sessionFileCacheMisses,
		size: sessionFileCache.size,
		statCalls: sessionFileCacheStatCalls,
	};
}

/** Test hook: drop the file-level cache and zero its counters. */
export function clearSessionFileCache(): void {
	sessionFileCache.clear();
	sessionFileCacheHits = 0;
	sessionFileCacheMisses = 0;
	sessionFileCacheStatCalls = 0;
}

/** Test hook: whether a path is cached, so eviction order is asserted, not inferred. */
export function sessionFileCacheHas(path: string): boolean {
	return sessionFileCache.has(path);
}

/**
 * Caller view of a cached parse.
 *
 * Depth is deliberate and minimal (P7 measured `structuredClone` at ~2.2x of a
 * warm parse): the top level so a reassigned field cannot land in the cache,
 * `usage` because it is a small mutable object callers may total into, and
 * `turns` as an array so a `push`/`length` cannot grow the cached list. Turn
 * records and their assistants stay shared — nothing in `src/` mutates them
 * after the parse fold, and copying them per poll is exactly the cost this
 * cache exists to remove. Callers MUST treat the result as read-only.
 */
function cacheSafeCopy(parsed: ParsedSession): ParsedSession {
	return { ...parsed, usage: { ...parsed.usage }, turns: parsed.turns.slice() };
}

/**
 * Parse a session file, skipping the parse entirely when the file has not
 * changed since the last call (#348).
 *
 * This is the entry point for the *status* readers — `progressFromSessionFile`
 * (the 500ms `refreshUi()` sweep), `/legion summary`, `/legion timing` — and for
 * the host-side postman's DELIVERED evidence scan; never for verdict derivation,
 * which must read the file it is judging.
 *
 * Hit condition is exactly `(path, size, mtimeMs)` equal, as frozen in #348:
 * an append grows `size`, a rewrite moves `mtimeMs` even at equal length, and a
 * cross-process write is therefore visible without an fs watcher or a bus
 * subscription. The one blind spot is a same-millisecond rewrite that keeps the
 * byte length; `parseSessionFile`'s own head/boundary fingerprint would catch
 * that, but only by opening the file, which is the fixed cost this gate exists
 * to remove (open + fstat + 2×256B fingerprint + close measured at 36–66µs
 * warm, per #348) — so that trade is taken deliberately and resolves on the
 * next write.
 *
 * The result is a shallow copy (`cacheSafeCopy`): mutating a field, `usage` or
 * the `turns` array of what this returns cannot poison the cache.
 *
 * A *read* failure (`EACCES`, `EMFILE`, `EIO`) is never cached, for the same
 * reason a failed stat is not: `parseSessionFile` answers an unreadable file
 * with the same empty value it answers an empty one, and `(size, mtimeMs)` says
 * nothing about readability. A settled session file never moves again, so
 * caching that empty value would pin `/legion summary` and the status rows at
 * zero for the rest of the process — and `chmod` only moves `ctime`, which is
 * not part of the key. The detection is exact: a file with `size > 0` that
 * yields neither turns nor torn lines was not read.
 */
export function parseSessionFileCached(path: string): ParsedSession {
	sessionFileCacheStatCalls += 1;
	let stat: fs.Stats;
	try {
		stat = fs.statSync(path);
	} catch {
		// Missing is the same answer `parseSessionFile` gives, and there is
		// nothing to cache: the next tick retries the stat.
		sessionFileCache.delete(path);
		return emptyParsedSession();
	}
	const cached = sessionFileCache.get(path);
	if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
		sessionFileCacheHits += 1;
		// LRU touch: the files a tick actually visits are the ones that stay.
		sessionFileCache.delete(path);
		sessionFileCache.set(path, cached);
		return cacheSafeCopy(cached.parsed);
	}
	sessionFileCacheMisses += 1;
	const parsed = parseSessionFile(path);
	// Unreadable, not empty: bytes exist but the parser folded none of them
	// (see the doc above). Cache nothing and retry on the next tick. A non-empty
	// file that legitimately folds to zero turns (metadata rows only, no message
	// yet) is re-parsed per tick as a result — tiny and rarer than the pinned-zero
	// failure this prevents, and it stops being re-parsed as soon as it has a turn.
	if (parsed.turns.length === 0 && parsed.tornLines === 0 && stat.size > 0) {
		return cacheSafeCopy(parsed);
	}
	sessionFileCache.delete(path);
	if (sessionFileCache.size >= SESSION_FILE_CACHE_MAX_ENTRIES) {
		const oldest = sessionFileCache.keys().next().value;
		if (oldest !== undefined) sessionFileCache.delete(oldest);
	}
	sessionFileCache.set(path, { size: stat.size, mtimeMs: stat.mtimeMs, parsed });
	// Hand out a copy: the freshly parsed value is the cached one now.
	return cacheSafeCopy(parsed);
}

/**
 * OpenAI/GPT client blip. The SDK's APIConnectionError message is exactly
 * "Connection error."; wrappers keep that substring.
 *
 * A matching snapshot is not a verdict while the RPC child is still alive:
 * the client retries, and the session can look terminal for the whole gap.
 *
 * Scope: this predicate covers ONLY a "connection error" message. It is not a
 * general "is this transient?" test and deliberately does not try to be one —
 * in particular it does NOT cover a provider that returns an empty generation
 * (`stopReason: "error"` with no content, #316), which is classified by
 * `Execution.errorKind` / {@link isEmptyGeneration} instead.
 */
export function isTransientConnectionFailure(
	input: { reason?: string | null; errorMessage?: string | null } | string | null | undefined,
): boolean {
	const text = typeof input === "string" || input == null
		? input ?? ""
		: `${input.reason ?? ""} ${input.errorMessage ?? ""}`;
	return /connection error/i.test(text);
}

/**
 * Session ended with a user prompt and no assistant reply.
 * This is a model/stream failure when the child finished on its own.
 * A parent `session_shutdown` that kills the child first must not reuse it;
 * see `attributeParentSessionShutdown`.
 */
export const NO_ASSISTANT_ABORT_REASON = "no assistant message for the last prompt";

/**
 * Parent process shutdown retired the child before any assistant message
 * was written. Distinct from {@link NO_ASSISTANT_ABORT_REASON}.
 */
export const PARENT_SESSION_SHUTDOWN_ABORT_REASON =
	"parent session shutdown retired the child before it produced an assistant message";

/**
 * The parent turn ended and the abort signal carried no reason (#227 D3b).
 *
 * Upstream writes a reason-less `AbortController` cancellation as
 * `stopReason:"error"` with a bare `"This operation was aborted"` message, which
 * used to be indistinguishable from a real provider failure. The status stays
 * `aborted`; only the reason becomes self-describing.
 */
export const ABORT_WITHOUT_REASON =
	"parent turn ended (abort signal without a reason)";

/**
 * The exact messages `AbortSignal`/`AbortController` produce with no reason.
 * Anchored to the whole message so a longer, meaningful error (a provider
 * message that merely mentions aborting) does not get rewritten.
 */
const REASONLESS_ABORT_MESSAGE =
	/^(this operation was aborted|the operation was aborted|operation aborted)$/i;

/**
 * The final assistant turn produced nothing: no text, no tool calls, stopReason "error".
 *
 * #316: a provider may answer HTTP 200 and then end the stream in-band with
 * `finish_reason: error`, which pi surfaces as `stopReason: "error"` with an
 * EMPTY assistant message (measured: `usage.input === 0`, 2/42 output tokens,
 * 90-175s elapsed). The child then lost all its work to a transient upstream
 * fault, because the only transient predicate in this file matches the
 * connection-error string and that message never contains one.
 *
 * The shape is read off the transcript — every clause must hold:
 *   - the last turn has an assistant record (a hard kill has none),
 *   - its `stopReason` is `error` (an abort / toolUse / length is not this),
 *   - its text is blank,
 *   - it requested no tools (a turn that called a tool did produce output).
 *
 * `usage` is intentionally NOT consulted (it is display-only, see
 * `src/extension/summary.ts`) and `errorMessage` is deliberately not matched:
 * guessing provider strings is exactly the failure mode that left #316
 * uncovered in the first place.
 */
export function isEmptyGeneration(parsed: Pick<ParsedSession, "turns">): boolean {
	const final = parsed.turns.at(-1)?.assistants.at(-1);
	if (!final) return false;
	return (
		final.stopReason === "error" &&
		(final.text ?? "").trim() === "" &&
		final.tools.length === 0
	);
}

/** True when the last turn (or the whole file) has no assistant message. */
export function lastTurnHasNoAssistant(parsed: ParsedSession): boolean {
	const last = parsed.turns.at(-1);
	return parsed.turns.length === 0 || !last || last.assistants.length === 0;
}

/**
 * Rewrite a missing-assistant abort when the parent session shut down and
 * retired the child. A turn the child actually settled keeps `deriveOutcome`.
 */
export function attributeParentSessionShutdown(execution: Execution, parsed: ParsedSession): Execution {
	if (execution.status === "success" || !lastTurnHasNoAssistant(parsed)) return execution;
	return {
		...execution,
		status: "aborted",
		reason: PARENT_SESSION_SHUTDOWN_ABORT_REASON,
	};
}

/**
 * Derive the execution outcome from a parsed session.
 *
 * Order matters: "no reply to the last prompt" is checked BEFORE stopReason,
 * because a hard kill leaves the last assistant message as a stale `toolUse`.
 */
export function deriveOutcome(parsed: ParsedSession): Execution {
	const turns = parsed.turns;

	if (turns.length === 0) {
		return {
			status: "unknown",
			reason: "no messages in session",
			turns: 0,
			toolErrors: parsed.toolErrors,
		};
	}

	const last = turns.at(-1);
	if (!last) {
		return {
			status: "unknown",
			reason: "no messages in session",
			turns: 0,
			toolErrors: parsed.toolErrors,
		};
	}

	// F29: hard kill / interrupt before any reply was persisted.
	// Parent-session cascade shutdown rewrites this in the orchestrator.
	if (last.assistants.length === 0) {
		return {
			status: "aborted",
			reason: NO_ASSISTANT_ABORT_REASON,
			turns: turns.length,
			toolErrors: parsed.toolErrors,
			lastTurn: { stopReason: null, toolErrors: last.toolErrors },
			model: parsed.model,
			usage: parsed.usage,
		};
	}

	const final = last.assistants.at(-1);
	if (!final) {
		return {
			status: "aborted",
			reason: NO_ASSISTANT_ABORT_REASON,
			turns: turns.length,
			toolErrors: parsed.toolErrors,
		};
	}

	const base = {
		turns: turns.length,
		toolErrors: parsed.toolErrors,
		lastTurn: { stopReason: final.stopReason, toolErrors: last.toolErrors },
		model: parsed.model,
		usage: parsed.usage,
	};

	return outcomeFromFinalMessage(final, base, isEmptyGeneration(parsed));
}

/** Map the final assistant message's stop reason onto an execution status. */
function outcomeFromFinalMessage(
	final: {
		stopReason: StopReason | null;
		rawStopReason?: string;
		errorMessage: string | null;
	},
	base: Omit<Execution, "status" | "reason">,
	/** `isEmptyGeneration` for this session; only the `failed` branch reads it. */
	emptyGeneration: boolean,
): Execution {
	switch (final.stopReason) {
		case "stop":
			return { status: "success", stopReason: "stop", ...base };

		case "length":
			return { status: "truncated", stopReason: "length", ...base };

		case "error": {
			// F29: a graceful interrupt surfaces as `error` with an abort-ish message.
			const msg = final.errorMessage ?? "";
			if (/abort/i.test(msg)) {
				// #227 D3b: a reason-less AbortController cancellation reaches us as
				// the bare engine message. Name it as the parent's abort instead of
				// echoing text that reads like a provider failure. Anything carrying
				// more (notably a `timeout`, or a longer provider sentence) keeps the
				// original message — status is `aborted` either way.
				const reason =
					REASONLESS_ABORT_MESSAGE.test(msg.trim()) && !/timeout/i.test(msg)
						? ABORT_WITHOUT_REASON
						: msg;
				return {
					status: "aborted",
					stopReason: "error",
					errorMessage: msg,
					reason,
					...base,
				};
			}
			return {
				status: "failed",
				stopReason: "error",
				errorMessage: msg,
				reason: msg,
				// #316 D1: an empty error turn is a provider-side miss, not a
				// declared failure. Tagged here (never on `aborted`) so the
				// orchestrator can retry it on the same child exactly once.
				...(emptyGeneration ? { errorKind: "provider-empty-generation" as const } : {}),
				...base,
			};
		}

		case "toolUse":
			// Terminated while a tool call was outstanding.
			return {
				status: "aborted",
				stopReason: "toolUse",
				reason: "terminated during tool call",
				...base,
			};

		case "aborted":
			// F29 measured that pi does not currently write this value, but the type
			// allows it, so it must map to `aborted` rather than falling through to
			// the `failed` catch-all.
			return {
				status: "aborted",
				stopReason: "aborted",
				reason: "agent aborted the turn",
				...base,
			};

		case null:
			// Distinguish "the field was absent" (a truncated stream — treat like an
			// abort) from "the field held a value we do not recognize" (report it as
			// a failure so the unexpected value is visible rather than hidden).
			if (final.rawStopReason === undefined) {
				return {
					status: "aborted",
					stopReason: null,
					reason: "assistant message has no stopReason",
					...base,
				};
			}
			return {
				status: "failed",
				stopReason: null,
				errorMessage: final.errorMessage,
				reason: `unknown stopReason: ${final.rawStopReason}`,
				...base,
			};

		default:
			return {
				status: "failed",
				stopReason: final.stopReason,
				errorMessage: final.errorMessage,
				reason: `unknown stopReason: ${String(final.stopReason)}`,
				...base,
			};
	}
}

/**
 * Extract a machine-readable self-reported verdict from agent output (F33).
 *
 * Two conventions are recognized, in order:
 *   1. A JSON object with a boolean `ok` (bare, fenced, or embedded in prose).
 *   2. A textual report whose FIRST non-empty line starts with `FAILED:` —
 *      the convention the design's F32 example uses. This is deliberately
 *      strict (first line only) to avoid flagging a report that merely
 *      mentions failure somewhere in its body.
 */
export function extractVerdict(
	text: string,
): { ok: boolean; reason?: string } | null {
	if (!text) return null;

	const jsonVerdict = extractJsonVerdict(text);
	if (jsonVerdict) return jsonVerdict;

	return extractTextualFailure(text);
}

function extractJsonVerdict(
	text: string,
): { ok: boolean; reason?: string } | null {
	const candidates: string[] = [];
	const fenced = text.match(/```(?:json)?\s*\n([\s\S]*?)```/g);
	if (fenced) {
		for (const block of fenced) {
			const inner = block
				.replace(/```(?:json)?\s*\n?/, "")
				.replace(/```$/, "")
				.trim();
			if (inner) candidates.push(inner);
		}
	}
	candidates.push(text.trim());

	const first = text.indexOf("{");
	const last = text.lastIndexOf("}");
	if (first !== -1 && last > first) {
		// Also try the first `{` … last `}` span, so prose around the JSON still
		// works — but ONE brace anywhere in the report poisons it (#311), which is
		// why the two candidates below exist.
		candidates.push(text.slice(first, last + 1));
	}

	// #311/1: the last line, when it is a bare JSON object. This is the shape
	// `child-guard` injects ("End with machine-readable JSON on its own"), so a
	// verdict that needs nothing but itself must never be missed. `trimEnd()`
	// first so trailing blank lines still leave the verdict as the last line.
	const lastLine = text.trimEnd().split("\n").at(-1)?.trim();
	if (lastLine) candidates.push(lastLine);

	// #311/2: brace-balance backwards from the end, so a verdict that spans lines
	// or is followed by a short trailing note is still reachable.
	candidates.push(...trailingJsonObjects(text));

	if (first !== -1 && last > first) {
		// The cursor TUI word-wraps long lines, which breaks a streamed verdict
		// JSON mid-string (`…top reason:\n  arithmetic identity"}`). A newline
		// inside a JSON string literal is invalid JSON, so joining wrapped lines
		// is a safe repair: the unwrapped original is still tried first above.
		// Deliberately LAST: it rewrites the text, so it is the least faithful
		// candidate and only runs once every faithful reading has been refused.
		candidates.push(text.slice(first, last + 1).replace(/\n\s+/g, " "));
	}

	for (const candidate of candidates) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(candidate);
		} catch {
			continue;
		}
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
		const obj = parsed as Record<string, unknown>;
		if (typeof obj.ok !== "boolean") continue;
		const out: { ok: boolean; reason?: string } = { ok: obj.ok };
		if (typeof obj.reason === "string") out.reason = obj.reason;
		return out;
	}
	return null;
}

/**
 * The object closed by the LAST `}` in `text`, found by counting braces from the
 * end (#311/2). `text.slice(open, end + 1)` is returned only when the count
 * returns to zero, so an unbalanced tail yields nothing rather than a truncated
 * guess. Never throws.
 *
 * `mask` marks the characters that sit inside a string literal (see
 * {@link stringMask}); the masked pass is the accurate one — a `}` inside
 * `"… } …"` must not close the object — and the unmasked pass is the fallback
 * for text whose quotes do not pair up (prose that opens a quote and never
 * closes it inverts the mask, hiding the real closing brace).
 */
function trailingJsonObjects(text: string): string[] {
	const out: string[] = [];
	for (const mask of [stringMask(text), undefined]) {
		const span = lastBalancedObject(text, mask);
		if (span) out.push(span);
	}
	return out;
}

function lastBalancedObject(text: string, mask: Uint8Array | undefined): string | undefined {
	let end = -1;
	for (let i = text.length - 1; i >= 0; i -= 1) {
		if (text[i] !== "}" || mask?.[i] === 1) continue;
		end = i;
		break;
	}
	if (end === -1) return undefined;
	let depth = 0;
	for (let i = end; i >= 0; i -= 1) {
		if (mask?.[i] === 1) continue;
		const ch = text[i];
		if (ch === "}") {
			depth += 1;
			continue;
		}
		if (ch !== "{") continue;
		depth -= 1;
		if (depth === 0) return text.slice(i, end + 1);
	}
	return undefined;
}

/**
 * Mark every character that sits inside a JSON-style string literal, quotes and
 * backslash escapes included. A single forward pass, so the backward brace scan
 * never has to re-derive string state.
 */
function stringMask(text: string): Uint8Array {
	const mask = new Uint8Array(text.length);
	let inString = false;
	for (let i = 0; i < text.length; i += 1) {
		const ch = text[i];
		if (!inString) {
			if (ch === '"') {
				inString = true;
				mask[i] = 1;
			}
			continue;
		}
		mask[i] = 1;
		if (ch === "\\") {
			// An escaped character is part of the literal even when it is a quote.
			if (i + 1 < text.length) {
				mask[i + 1] = 1;
				i += 1;
			}
			continue;
		}
		if (ch === '"') inString = false;
	}
	return mask;
}

/** `FAILED: ...` on the first non-empty line means the agent gave up. */
const TEXTUAL_FAILURE = /^[*_`\s]*FAILED\s*:\s*(.*)$/i;

function extractTextualFailure(
	text: string,
): { ok: boolean; reason?: string } | null {
	const firstLine = text
		.split("\n")
		.map((line) => line.trim())
		.find((line) => line.length > 0);
	if (!firstLine) return null;

	const match = firstLine.match(TEXTUAL_FAILURE);
	if (!match) return null;

	const reason = (match[1] ?? "").trim();
	return reason ? { ok: false, reason } : { ok: false };
}

/**
 * Whether the last turn already has a terminal assistant reply.
 *
 * Used by `collect()` to avoid waiting when the turn has already settled —
 * without this, a collect issued after completion would block for the full
 * timeout because no NEW message ever appears.
 */
export function isLastTurnComplete(parsed: ParsedSession): boolean {
	const last = parsed.turns.at(-1);
	if (!last || last.assistants.length === 0) return false;
	// A trailing `toolUse` means the agent is still mid-tool, not settled.
	return last.assistants.at(-1)?.stopReason !== "toolUse";
}

/** Count assistant messages — used to detect turn progress while polling. */
export function countAssistantMessages(parsed: ParsedSession): number {
	return parsed.turns.reduce((n, t) => n + t.assistants.length, 0);
}
