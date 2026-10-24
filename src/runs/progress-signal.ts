/**
 * Renewal progress signal (subagent-renewal contract v1, W1 / D2 + D2-a + D8).
 *
 * Answers exactly one question: *since the last renewal baseline, did the child
 * produce observable output?* Only output signals count (session JSONL rows and
 * worktree file changes) — process liveness, CPU time and token spend are
 * explicitly excluded (§7-3: they also grow while a child loops on failure).
 *
 * Measured session shape (`.pi-subagents/runs/<run>/<child>.jsonl`): every row
 * is `{"type":"message","id","parentId","timestamp","message":{"role",...}}`
 * where `message.role` is `assistant` / `toolResult` / `user` / `system`.
 * Top-level `type` is `message`, so the row kind lives in `message.role`; a
 * legacy flat `{"type":"toolResult"}` row is accepted too.
 */

import * as fs from "node:fs";

/** A renewal point: when it was taken plus the session line count then (D8). */
export interface ProgressBaseline {
	/** Unix ms when this baseline was taken (D8). */
	readonly at: number;
	/** Session JSONL line count at baseline time. */
	readonly lines: number;
}

export interface ProgressMeasure {
	/** New `toolResult` rows since the baseline (strongest evidence — a tool returned). */
	readonly toolResults: number;
	/** New assistant messages since the baseline. */
	readonly assistantMessages: number;
	/** Files created/modified in the worktree since the baseline, when measurable. */
	readonly filesChanged: number | undefined;
	/** D2-a: does this count as "real progress"? */
	readonly progressed: boolean;
}

/** D2-a thresholds, exported so tests and docs cannot drift. */
export const PROGRESS_MIN_TOOL_RESULTS = 3;
export const PROGRESS_MIN_FILES_CHANGED = 1;

/**
 * Default line reader: the file's raw lines, or `undefined` when unreadable.
 * Never throws — a child that was killed mid-write leaves a torn final line,
 * and a missing file is a normal "nothing to measure" state.
 */
export function readSessionLines(file: string): string[] | undefined {
	let text: string;
	try {
		text = fs.readFileSync(file, "utf8");
	} catch {
		return undefined;
	}
	return splitLines(text);
}

/**
 * Split on `\n`, dropping the phantom element a trailing newline produces so
 * the count matches "number of lines written". A torn tail without a trailing
 * newline is kept (the parser skips it).
 */
function splitLines(text: string): string[] {
	const lines = text.split("\n").map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
	if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
	return lines;
}

/** Row kind, or `undefined` for non-message / malformed rows. */
function rowKind(line: string): "assistant" | "toolResult" | undefined {
	const trimmed = line.trim();
	if (!trimmed) return undefined;
	let decoded: unknown;
	try {
		decoded = JSON.parse(trimmed);
	} catch {
		// Torn line, or a non-JSON header: skip, never throw.
		return undefined;
	}
	if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) return undefined;
	const event = decoded as Record<string, unknown>;
	// Measured shape: {type:"message", message:{role}}.
	const message = event.message;
	if (message && typeof message === "object" && !Array.isArray(message)) {
		const role = (message as Record<string, unknown>).role;
		if (role === "assistant") return "assistant";
		if (role === "toolResult") return "toolResult";
	}
	// Legacy flat shape: {type:"toolResult"} / {type:"assistant"}.
	if (event.type === "assistant") return "assistant";
	if (event.type === "toolResult") return "toolResult";
	return undefined;
}

/** Non-negative integer, or `undefined` when the counter is not measurable. */
function normalizeCount(value: number | undefined): number | undefined {
	if (value === undefined || !Number.isFinite(value)) return undefined;
	return Math.max(0, Math.floor(value));
}

/**
 * Measure progress since `baseline`. Rows at or before `baseline.lines` are
 * history and are never counted (D8).
 *
 * `progressed` follows D2-a exactly:
 * `toolResults >= PROGRESS_MIN_TOOL_RESULTS || filesChanged >= PROGRESS_MIN_FILES_CHANGED`,
 * with an unmeasurable `filesChanged` dropping out of the comparison.
 */
export function measureProgress(input: {
	sessionFile: string;
	baseline: ProgressBaseline;
	/** Injectable for tests: returns the session file's raw lines, or undefined when unreadable. */
	readLines?: (file: string) => string[] | undefined;
	/** Injectable: count of changed files in the worktree, or undefined when not measurable. */
	countFilesChanged?: () => number | undefined;
}): ProgressMeasure {
	const lines = (input.readLines ?? readSessionLines)(input.sessionFile);
	const filesChanged = normalizeCount(input.countFilesChanged?.());
	if (!lines) return { toolResults: 0, assistantMessages: 0, filesChanged, progressed: hasFileProgress(filesChanged) };

	// Baseline beyond the current file (truncated/rotated): nothing is new.
	const start = Math.max(0, Math.min(normalizeCount(input.baseline.lines) ?? 0, lines.length));
	let toolResults = 0;
	let assistantMessages = 0;
	for (let i = start; i < lines.length; i += 1) {
		const kind = rowKind(lines[i] ?? "");
		if (kind === "toolResult") toolResults += 1;
		else if (kind === "assistant") assistantMessages += 1;
	}

	const progressed = toolResults >= PROGRESS_MIN_TOOL_RESULTS || hasFileProgress(filesChanged);

	return { toolResults, assistantMessages, filesChanged, progressed };
}

/** D2-a's file half; an unmeasurable count never counts as progress. */
function hasFileProgress(filesChanged: number | undefined): boolean {
	return filesChanged !== undefined && filesChanged >= PROGRESS_MIN_FILES_CHANGED;
}
