/**
 * Session-level error journal for `/legion doctor` (#160).
 *
 * Tool validation failures and other observable agent-side errors append to a
 * JSONL log under storeRoot so they survive beyond a single turn. Doctor reads
 * a summary (counts + recent one-liners) and prints the log path when the file
 * is large — never dumps the whole log into the terminal.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export const SESSION_ERRORS_FILE = "session-errors.jsonl";

/** Soft cap: doctor summarizes and points at the path past this size. */
export const SESSION_ERRORS_LARGE_BYTES = 32 * 1024;

/** Keep at most this many recent lines when rotating the on-disk log. */
export const SESSION_ERRORS_MAX_LINES = 500;

/** In-process ring shown even when storeRoot is unset. */
const MEMORY_RING = 32;

export interface SessionErrorRecord {
	ts: number;
	code: string;
	message: string;
	tool?: string;
	action?: string;
}

let defaultStoreRoot: string | undefined;
let defaultTool: string | undefined;
let defaultAction: string | undefined;
const recent: SessionErrorRecord[] = [];

export function configureSessionErrors(opts: {
	storeRoot?: string;
	tool?: string;
	action?: string;
}): void {
	if (opts.storeRoot) defaultStoreRoot = opts.storeRoot;
	if (opts.tool !== undefined) defaultTool = opts.tool;
	if (opts.action !== undefined) defaultAction = opts.action;
}

/** Test helper. */
export function clearSessionErrors(): void {
	recent.length = 0;
	defaultStoreRoot = undefined;
	defaultTool = undefined;
	defaultAction = undefined;
}

export function recentSessionErrors(): readonly SessionErrorRecord[] {
	return recent;
}

export function sessionErrorsLogPath(storeRoot?: string): string | undefined {
	const root = storeRoot ?? defaultStoreRoot;
	return root ? path.join(root, SESSION_ERRORS_FILE) : undefined;
}

function pushMemory(entry: SessionErrorRecord): void {
	recent.unshift(entry);
	if (recent.length > MEMORY_RING) recent.length = MEMORY_RING;
}

function appendToLog(storeRoot: string, entry: SessionErrorRecord): void {
	const file = path.join(storeRoot, SESSION_ERRORS_FILE);
	try {
		fs.mkdirSync(storeRoot, { recursive: true });
		fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, "utf8");
		rotateIfNeeded(file);
	} catch {
		/* best-effort — doctor still sees the in-memory ring */
	}
}

function rotateIfNeeded(file: string): void {
	try {
		const raw = fs.readFileSync(file, "utf8");
		const lines = raw.split("\n").filter((line) => line.trim().length > 0);
		if (lines.length <= SESSION_ERRORS_MAX_LINES) return;
		const kept = lines.slice(-SESSION_ERRORS_MAX_LINES);
		fs.writeFileSync(file, `${kept.join("\n")}\n`, "utf8");
	} catch {
		/* ignore */
	}
}

/**
 * Record one session error. Prefer an explicit storeRoot; otherwise use the
 * last configureSessionErrors() root (set on tool execute / session_start).
 */
export function recordSessionError(
	entry: Omit<SessionErrorRecord, "ts"> & { ts?: number; storeRoot?: string },
): SessionErrorRecord {
	const record: SessionErrorRecord = {
		ts: entry.ts ?? Date.now(),
		code: entry.code,
		message: entry.message,
		tool: entry.tool ?? defaultTool,
		action: entry.action ?? defaultAction,
	};
	pushMemory(record);
	const root = entry.storeRoot ?? defaultStoreRoot;
	if (root) appendToLog(root, record);
	return record;
}

export interface SessionErrorSummary {
	total: number;
	byCode: Record<string, number>;
	recent: SessionErrorRecord[];
	logPath?: string;
	logBytes: number;
	large: boolean;
	/** True when the on-disk log has more rows than we show inline. */
	truncated: boolean;
}

function readLogRecords(logPath: string): SessionErrorRecord[] {
	try {
		const raw = fs.readFileSync(logPath, "utf8");
		const out: SessionErrorRecord[] = [];
		for (const line of raw.split("\n")) {
			const trimmed = line.trim();
			if (!trimmed) continue;
			try {
				const parsed = JSON.parse(trimmed) as SessionErrorRecord;
				if (parsed && typeof parsed.message === "string") out.push(parsed);
			} catch {
				/* skip bad lines */
			}
		}
		return out;
	} catch {
		return [];
	}
}

/**
 * Build a doctor-facing summary. Prefer on-disk log when present; fall back to
 * the in-memory ring. Never returns the full log body — only recent titles.
 */
export function summarizeSessionErrors(opts?: {
	storeRoot?: string;
	/** How many recent one-liners to include (default 5). */
	recentLimit?: number;
	largeBytes?: number;
}): SessionErrorSummary {
	const recentLimit = opts?.recentLimit ?? 5;
	const largeBytes = opts?.largeBytes ?? SESSION_ERRORS_LARGE_BYTES;
	const logPath = sessionErrorsLogPath(opts?.storeRoot);
	let logBytes = 0;
	let disk: SessionErrorRecord[] = [];
	if (logPath) {
		try {
			logBytes = fs.statSync(logPath).size;
			disk = readLogRecords(logPath);
		} catch {
			logBytes = 0;
			disk = [];
		}
	}
	const source = disk.length > 0 ? disk : [...recent].reverse();
	const byCode: Record<string, number> = {};
	for (const row of source) {
		byCode[row.code] = (byCode[row.code] ?? 0) + 1;
	}
	const recentSlice = source.slice(-recentLimit).reverse();
	return {
		total: source.length,
		byCode,
		recent: recentSlice,
		logPath,
		logBytes,
		large: logBytes >= largeBytes,
		truncated: source.length > recentLimit,
	};
}

/** One-line title for doctor output. */
export function formatSessionErrorTitle(row: SessionErrorRecord): string {
	const when = new Date(row.ts).toISOString();
	const where = [row.tool, row.action].filter(Boolean).join("/");
	const head = where ? `${where} ` : "";
	const msg = row.message.trim().replace(/\s+/g, " ").slice(0, 160);
	return `${when} [${row.code}] ${head}${msg}`;
}
