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

/** Accumulate token usage from an assistant message into the running total. */
function accumulateUsage(
	target: Usage,
	message: Record<string, unknown>,
): void {
	const usage = message.usage as Record<string, unknown> | undefined;
	if (!usage || typeof usage !== "object") return;
	const cost = usage.cost as Record<string, unknown> | undefined;
	target.input += num(usage.input);
	target.output += num(usage.output);
	target.cacheRead += num(usage.cacheRead);
	target.cacheWrite += num(usage.cacheWrite);
	target.cost += num(cost?.total);
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

	accumulateUsage(parsed.usage, message);
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
const SESSION_CACHE_MAX_ENTRIES = 64;

/** Per-line cap: one JSONL row larger than this is skipped (counted as torn). */
export function resolveSessionMaxLineBytes(env: NodeJS.ProcessEnv = process.env): number {
	const raw = env[SESSION_MAX_LINE_BYTES_ENV]?.trim();
	const n = raw ? Number(raw) : NaN;
	// #174: require floored value >= 1 — (0,1) must not become cap=0.
	return Number.isFinite(n) && n >= 1 ? Math.floor(n) : DEFAULT_SESSION_MAX_LINE_BYTES;
}

interface SessionParseState {
	dev: number;
	ino: number;
	/** Byte offset just past the last complete line consumed. */
	offset: number;
	/** Bytes at the head and just before `offset`; a mismatch means rewrite. */
	head: Buffer;
	boundary: Buffer;
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

function fingerprint(fd: number, offset: number): { head: Buffer; boundary: Buffer } {
	const head = readAt(fd, 0, Math.min(FINGERPRINT_BYTES, offset));
	const start = Math.max(0, offset - FINGERPRINT_BYTES);
	return { head, boundary: readAt(fd, start, offset - start) };
}

function stillValid(fd: number, stat: fs.Stats, state: SessionParseState): boolean {
	if (state.dev !== stat.dev || state.ino !== stat.ino || stat.size < state.offset) return false;
	const now = fingerprint(fd, state.offset);
	return now.head.equals(state.head) && now.boundary.equals(state.boundary);
}

/** Incremental parse cache: append-only session files are only read past `offset`. */
const sessionParseCache = new Map<string, SessionParseState>();

/** Test hook: drop all incremental parse state. */
export function clearSessionParseCache(): void {
	sessionParseCache.clear();
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
	const chunk = Buffer.allocUnsafe(SESSION_READ_CHUNK_BYTES);
	let pos = start;
	let consumed = start;
	let pending: Buffer[] = [];
	let pendingBytes = 0;
	let skipping = false;
	while (pos < size) {
		const n = fs.readSync(fd, chunk, 0, Math.min(chunk.length, size - pos), pos);
		if (n <= 0) break;
		let lineStart = 0;
		for (let i = 0; i < n; i++) {
			if (chunk[i] !== 0x0a) continue;
			if (skipping) {
				parsed.tornLines += 1;
				skipping = false;
			} else {
				const piece = chunk.subarray(lineStart, i);
				const text = pendingBytes ? Buffer.concat([...pending, piece]).toString("utf8") : piece.toString("utf8");
				applyLine(parsed, text, clock);
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
	return consumed;
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
		const result = structuredClone(state.parsed);
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
 * OpenAI/GPT client blip. The SDK's APIConnectionError message is exactly
 * "Connection error."; wrappers keep that substring.
 *
 * A matching snapshot is not a verdict while the RPC child is still alive:
 * the client retries, and the session can look terminal for the whole gap.
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

	return outcomeFromFinalMessage(final, base);
}

/** Map the final assistant message's stop reason onto an execution status. */
function outcomeFromFinalMessage(
	final: {
		stopReason: StopReason | null;
		rawStopReason?: string;
		errorMessage: string | null;
	},
	base: Omit<Execution, "status" | "reason">,
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
				return {
					status: "aborted",
					stopReason: "error",
					errorMessage: msg,
					reason: msg,
					...base,
				};
			}
			return {
				status: "failed",
				stopReason: "error",
				errorMessage: msg,
				reason: msg,
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

	// Also try the last balanced {...} span, so prose around the JSON still works.
	const first = text.indexOf("{");
	const last = text.lastIndexOf("}");
	if (first !== -1 && last > first) {
		const span = text.slice(first, last + 1);
		candidates.push(span);
		// The cursor TUI word-wraps long lines, which breaks a streamed verdict
		// JSON mid-string (`…top reason:\n  arithmetic identity"}`). A newline
		// inside a JSON string literal is invalid JSON, so joining wrapped lines
		// is a safe repair: the unwrapped original is still tried first above.
		candidates.push(span.replace(/\n\s+/g, " "));
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
