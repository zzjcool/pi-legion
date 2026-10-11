/**
 * Run store — durable state for subagent runs (design §12).
 *
 * Layout:
 *   <rootDir>/runs/<runId>/run.json          — the tree (authoritative, F27)
 *   <rootDir>/runs/<runId>/<name>.jsonl      — session files (resume credentials)
 *   <rootDir>/runs/<runId>/out/              — artifacts
 *
 * Key guarantees:
 *   - Atomic writes: `<file>.tmp` + renameSync; a partial run.json is impossible.
 *   - Session files are PRE-CREATED empty at mode 0600 (design F4): pi creates the
 *     session file lazily (no turn ⇒ no file), which opens a data-loss window.
 *   - A corrupt run.json never throws: readRun() returns null and quarantines
 *     the file as run.json.corrupt.
 *   - Per-runId in-process mutex: concurrent updateRun() calls serialize.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import {
	MAX_NESTED_PATH_ENTRIES,
	SubagentError,
	ErrorCodes,
	type ChildRecord,
	type NestedPathEntry,
	type RunRecord,
} from "../shared/types.ts";

/** M2 tree identity is an additive field on persisted v1 run/child records. */
declare module "../shared/types.ts" {
	interface ChildRecord { nodeId?: string; }
	interface RunRecord { nodeId?: string; }
}

export interface StoreOptions {
	rootDir: string;
	/** Injectable clock (ms epoch) for tests. Defaults to Date.now. */
	now?: () => number;
}

const RUNS_DIR = "runs";
const RUN_FILE = "run.json";
const CORRUPT_SUFFIX = ".corrupt";
const ARTIFACT_DIR = "out";
const SESSION_EXT = ".jsonl";

/** 16 hex chars of entropy give each persisted child a stable owner token. */
function newOwnerToken(): string {
	return randomBytes(8).toString("hex");
}

function newRunId(): string {
	return `r-${randomBytes(4).toString("hex")}`;
}

/**
 * Sanitize a child name for filesystem use. Hostile input
 * (`../../etc/passwd`, spaces, unicode, control chars) is reduced to a
 * safe single path segment; names that sanitize to nothing are rejected.
 */
export function sanitizeNameForFs(name: string): string {
	if (typeof name !== "string") {
		throw new SubagentError(
			"child name must be a string",
			ErrorCodes.INVALID_PARAMS,
		);
	}
	// Only the final segment survives — kills any traversal prefix.
	const base = path.basename(name);
	const cleaned = base
		.normalize("NFKD")
		.replace(/[^\x20-\x7E]/g, "") // drop non-ASCII / control / unicode
		.replace(/[^A-Za-z0-9._-]/g, "-") // spaces & specials → '-'
		.replace(/^[-.]+/, "") // no leading dots/dashes (no hidden, no '..')
		.replace(/-+/g, "-")
		.replace(/[-.]+$/, "")
		.slice(0, 64);
	if (cleaned.length === 0 || cleaned === "..") {
		throw new SubagentError(
			`child name is not usable on the filesystem: ${JSON.stringify(name)}`,
			ErrorCodes.INVALID_PARAMS,
		);
	}
	return cleaned;
}

/**
 * Resolve a child handle across runs within the current cwd.
 *
 * Names are reused after retirement, so prefer a live child and then the newest
 * run record. The v2 RPC name registry replaces parent-pane scoping.
 */
export function pickChildByName(
	runs: readonly RunRecord[],
	name: string,
): { run: RunRecord; child: ChildRecord } | null {
	const matches: Array<{ run: RunRecord; child: ChildRecord }> = [];
	for (const run of runs) {
		const child = run.children.find((c) => c.name === name);
		if (child) matches.push({ run, child });
	}
	if (matches.length === 0) return null;

	const live = matches.filter(
		(m) => m.child.state !== "retired" && m.child.state !== "exited",
	);
	const pickFrom = live.length > 0 ? live : matches;
	const ranked = [...pickFrom].sort((a, b) =>
		b.run.createdAt.localeCompare(a.run.createdAt),
	);
	return ranked[0] ?? null;
}

function isValidIsoDate(v: unknown): v is string {
	return typeof v === "string" && !Number.isNaN(Date.parse(v));
}

/** Defensive validation on read — a tampered run.json is treated as corrupt. */
function isRunRecordLike(value: unknown): value is RunRecord {
	if (!value || typeof value !== "object") return false;
	const r = value as Record<string, unknown>;
	return (
		typeof r.runId === "string" &&
		r.runId.length > 0 &&
		typeof r.task === "string" &&
		typeof r.cwd === "string" &&
		isValidIsoDate(r.createdAt) &&
		isValidIsoDate(r.updatedAt) &&
		Array.isArray(r.children)
	);
}

export class RunStore {
	readonly rootDir: string;
	private readonly nowFn: () => number;
	/** Per-runId write mutex: maps runId → tail of the write chain. */
	private readonly locks = new Map<string, Promise<unknown>>();

	constructor(opts: StoreOptions) {
		if (!opts.rootDir || typeof opts.rootDir !== "string") {
			throw new SubagentError(
				"RunStore requires rootDir",
				ErrorCodes.INVALID_PARAMS,
			);
		}
		this.rootDir = opts.rootDir;
		this.nowFn = opts.now ?? (() => Date.now());
	}

	// ── paths ───────────────────────────────────────────────────────────

	/** runDir = <root>/runs/<runId> */
	runDir(runId: string): string {
		if (
			!runId ||
			runId.includes("/") ||
			runId.includes("\\") ||
			runId.includes("..")
		) {
			throw new SubagentError(
				`invalid runId: ${JSON.stringify(runId)}`,
				ErrorCodes.INVALID_PARAMS,
			);
		}
		return path.join(this.rootDir, RUNS_DIR, runId);
	}

	private runFile(runId: string): string {
		return path.join(this.runDir(runId), RUN_FILE);
	}

	/**
	 * Resolve the run root, failing with an ACTIONABLE message when it cannot be
	 * used. A bare `mkdir` ENOENT/EACCES here is otherwise reported as an opaque
	 * "ENOENT: no such file or directory, mkdir '/plugin/.pi-subagents/runs/...'"
	 * from deep inside the launcher, which does not tell the caller what to do.
	 */
	private ensureRootUsable(): void {
		try {
			fs.mkdirSync(this.rootDir, { recursive: true });
			fs.accessSync(this.rootDir, fs.constants.W_OK);
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code ?? "UNKNOWN";
			throw new SubagentError(
				`cannot write run artifacts to ${this.rootDir} (${code}). ` +
					`Subagent runs need a writable directory: pass a writable \`cwd\` ` +
					`to the subagent tool, or run from a checkout you can write to.`,
				ErrorCodes.INVALID_PARAMS,
				{ rootDir: this.rootDir },
			);
		}
	}

	/**
	 * Path to a child's session file. Creates the run dir and PRE-CREATES the
	 * empty file at mode 0600 (design F4: pi creates session files lazily —
	 * no turn means no file, which opens a data-loss window; pre-creating
	 * closes it and is verified safe).
	 */
	sessionFileFor(runId: string, name: string): string {
		const dir = this.runDir(runId);
		this.ensureRootUsable();
		fs.mkdirSync(dir, { recursive: true });
		const file = path.join(dir, `${sanitizeNameForFs(name)}${SESSION_EXT}`);
		// Pre-create (F4). pi creates session files lazily, so an empty file must
		// exist before the child starts or the first turn can be lost.
		//
		// `writeFileSync` with the exclusive flag manages the descriptor itself:
		// a manual open/close leaks the fd when `closeSync` throws (EIO/ENOSPC),
		// and the launcher creates one of these per child. `wx` also removes the
		// TOCTOU window an `existsSync` check would leave.
		try {
			fs.writeFileSync(file, "", { flag: "wx", mode: 0o600 });
		} catch (error) {
			// EEXIST: a previous launch (or a resume) already made it — fine.
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
		// Enforce 0600 even if the file pre-existed with looser bits.
		try {
			fs.chmodSync(file, 0o600);
		} catch {
			// best-effort (some filesystems ignore modes)
		}
		return file;
	}

	/** Artifact dir for a run: <runDir>/out (created on demand). */
	artifactDirFor(runId: string): string {
		const dir = path.join(this.runDir(runId), ARTIFACT_DIR);
		fs.mkdirSync(dir, { recursive: true });
		return dir;
	}

	// ── atomic write ────────────────────────────────────────────────────

	/** Atomic write: temp file in the same directory, then renameSync. */
	private atomicWrite(file: string, data: string): void {
		this.ensureRootUsable();
		fs.mkdirSync(path.dirname(file), { recursive: true });
		const tmp = `${file}.tmp`;
		fs.writeFileSync(tmp, data, { encoding: "utf8", mode: 0o600 });
		fs.renameSync(tmp, file);
	}

	// ── CRUD ────────────────────────────────────────────────────────────

	createRun(input: {
		task: string;
		cwd: string;
		path?: NestedPathEntry[];
		maxDepth?: number;
		nodeId?: string;
		herdr?: RunRecord["herdr"];
	}): RunRecord {
		if (typeof input.task !== "string" || input.task.length === 0) {
			throw new SubagentError(
				"createRun requires a task",
				ErrorCodes.INVALID_PARAMS,
			);
		}
		if (typeof input.cwd !== "string" || input.cwd.length === 0) {
			throw new SubagentError(
				"createRun requires a cwd",
				ErrorCodes.INVALID_PARAMS,
			);
		}
		const nowIso = new Date(this.nowFn()).toISOString();
		const record: RunRecord = {
			schemaVersion: 1,
			runId: newRunId(),
			task: input.task,
			cwd: input.cwd,
			...(input.nodeId ? { nodeId: input.nodeId } : {}),
			herdr: {
				...(input.herdr ?? {}),
				...(input.nodeId ? { node_id: input.nodeId } : {}),
			},
			path: (input.path ?? []).slice(0, MAX_NESTED_PATH_ENTRIES),
			depth: input.path?.length ?? 0,
			maxDepth: input.maxDepth ?? MAX_NESTED_PATH_ENTRIES,
			children: [],
			budget: { spawned: 0, limit: null, granted: 0 },
			createdAt: nowIso,
			updatedAt: nowIso,
		};
		this.writeRun(record);
		return record;
	}

	writeRun(record: RunRecord): void {
		if (!isRunRecordLike(record)) {
			throw new SubagentError(
				"writeRun: not a valid RunRecord",
				ErrorCodes.INVALID_PARAMS,
			);
		}
		record.updatedAt = new Date(this.nowFn()).toISOString();
		this.atomicWrite(
			this.runFile(record.runId),
			`${JSON.stringify(record, null, "\t")}\n`,
		);
	}

	/**
	 * Read a run. Returns null (never throws) when the run does not exist.
	 * A corrupt run.json is quarantined as run.json.corrupt and null is returned.
	 */
	readRun(runId: string): RunRecord | null {
		const file = this.runFile(runId);
		let raw: string;
		try {
			raw = fs.readFileSync(file, "utf8");
		} catch {
			return null; // missing (or unreadable dir) — not an error
		}
		try {
			const parsed: unknown = JSON.parse(raw);
			if (!isRunRecordLike(parsed)) throw new Error("shape mismatch");
			return parsed;
		} catch {
			// Quarantine so a human can inspect it and retries don't re-parse it.
			try {
				fs.renameSync(file, `${file}${CORRUPT_SUFFIX}`);
			} catch {
				// ignore rename failure; still report null
			}
			return null;
		}
	}

	/**
	 * Read-modify-write under a per-runId in-process mutex, so concurrent
	 * updateRun() calls on the same run serialize instead of clobbering.
	 */
	async updateRun(
		runId: string,
		fn: (r: RunRecord) => void,
	): Promise<RunRecord> {
		const prev = this.locks.get(runId) ?? Promise.resolve();
		const result = prev.then(
			() => this.doUpdate(runId, fn),
			() => this.doUpdate(runId, fn),
		);
		// Chain the next waiter onto the settled outcome; keep the tail so
		// subsequent callers join the same queue.
		const tail = result.then(
			() => undefined,
			() => undefined,
		);
		this.locks.set(runId, tail);
		// If we are still the tail once settled, drop the entry (no unbounded growth).
		void tail.then(() => {
			if (this.locks.get(runId) === tail) this.locks.delete(runId);
		});
		return result;
	}

	private doUpdate(runId: string, fn: (r: RunRecord) => void): RunRecord {
		const record = this.readRun(runId);
		if (!record) {
			throw new SubagentError(`run not found: ${runId}`, ErrorCodes.NOT_FOUND);
		}
		fn(record);
		this.writeRun(record);
		return record;
	}

	// ── children ────────────────────────────────────────────────────────

	/** Append a child to the run and bump the spawn budget. */
	async addChild(runId: string, child: ChildRecord): Promise<RunRecord> {
		return this.updateRun(runId, (r) => {
			if (r.children.some((c) => c.name === child.name)) {
				throw new SubagentError(
					`child already exists: ${child.name}`,
					ErrorCodes.NAME_TAKEN,
				);
			}
			const withToken: ChildRecord = child.ownerToken
				? child
				: { ...child, ownerToken: newOwnerToken() };
			r.children.push(withToken);
			r.budget.spawned += 1;
		});
	}

	async removeChild(runId: string, name: string, expectedNodeId?: string): Promise<RunRecord> {
		return this.updateRun(runId, (run) => {
			const index = run.children.findIndex((child) => child.name === name);
			if (index < 0) return;
			const existing = run.children[index]!;
			if (expectedNodeId !== undefined && existing.nodeId !== expectedNodeId) {
				throw new SubagentError(`child identity mismatch while removing ${name}`, ErrorCodes.INVALID_PARAMS);
			}
			run.children.splice(index, 1);
			run.budget.spawned = Math.max(0, run.budget.spawned - 1);
		});
	}

	async updateChild(
		runId: string,
		name: string,
		fn: (c: ChildRecord) => void,
	): Promise<RunRecord> {
		return this.updateRun(runId, (r) => {
			const child = r.children.find((c) => c.name === name);
			if (!child) {
				throw new SubagentError(
					`child not found: ${name}`,
					ErrorCodes.NOT_FOUND,
				);
			}
			fn(child);
		});
	}

	findChild(runId: string, name: string): ChildRecord | null {
		return this.readRun(runId)?.children.find((c) => c.name === name) ?? null;
	}

	// ── listing ─────────────────────────────────────────────────────────

	/** All readable runs, oldest first. Corrupt entries are skipped silently. */
	listRuns(): RunRecord[] {
		const runsRoot = path.join(this.rootDir, RUNS_DIR);
		let entries: string[];
		try {
			entries = fs.readdirSync(runsRoot);
		} catch {
			return [];
		}
		const out: RunRecord[] = [];
		for (const entry of entries) {
			const record = this.readRun(entry);
			if (record) out.push(record);
		}
		out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
		return out;
	}

	// ── pruning ─────────────────────────────────────────────────────────


	/**
	 * Delete session files older than retentionDays (and enforce
	 * maxBytesPerRun on the remaining ones), then remove run dirs whose
	 * run.json is itself older than retention. Never touches run.json of a
	 * run newer than the retention cutoff.
	 */
	prune(opts: { retentionDays: number; maxBytesPerRun?: number }): {
		removedSessions: string[];
		removedRuns: string[];
	} {
		if (!(opts.retentionDays > 0)) {
			throw new SubagentError(
				"retentionDays must be > 0",
				ErrorCodes.INVALID_PARAMS,
			);
		}
		const nowMs = this.nowFn();
		const cutoffMs = nowMs - opts.retentionDays * 24 * 60 * 60 * 1000;
		const removedSessions: string[] = [];
		const removedRuns: string[] = [];

		const runsRoot = path.join(this.rootDir, RUNS_DIR);
		let entries: string[];
		try {
			entries = fs.readdirSync(runsRoot);
		} catch {
			return { removedSessions, removedRuns };
		}

		for (const entry of entries) {
			const dir = path.join(runsRoot, entry);
			const runFile = path.join(dir, RUN_FILE);
			let st: fs.Stats;
			try {
				st = fs.statSync(runFile);
			} catch {
				continue; // no run.json — not ours to judge
			}

			// 1. stale sessions inside the run dir
			const sessions = this.listSessionFiles(dir);
			for (const f of sessions) {
				try {
					if (fs.statSync(f).mtimeMs < cutoffMs) {
						fs.rmSync(f, { force: true });
						removedSessions.push(f);
					}
				} catch {
					// best effort
				}
			}

			// 2. size cap: drop oldest sessions until under budget
			if (opts.maxBytesPerRun !== undefined) {
				const remaining = this.listSessionFiles(dir).filter(
					(f) => !removedSessions.includes(f),
				);
				let total = remaining.reduce((sum, f) => sum + this.safeSize(f), 0);
				// oldest first
				remaining.sort((a, b) => this.safeMtime(a) - this.safeMtime(b));
				for (const f of remaining) {
					if (total <= opts.maxBytesPerRun) break;
					try {
						const size = this.safeSize(f);
						fs.rmSync(f, { force: true });
						removedSessions.push(f);
						total -= size;
					} catch {
						// best effort
					}
				}
			}

			// 3. run dir itself is stale (run.json older than cutoff)?
			//    Only then may the whole dir (including run.json) go.
			if (st.mtimeMs < cutoffMs) {
				try {
					fs.rmSync(dir, { recursive: true, force: true });
					removedRuns.push(dir);
				} catch {
					// best effort
				}
			}
		}
		return { removedSessions, removedRuns };
	}

	private listSessionFiles(dir: string): string[] {
		let out: string[] = [];
		try {
			out = fs
				.readdirSync(dir)
				.flatMap((f) => (f.endsWith(SESSION_EXT) ? [path.join(dir, f)] : []));
		} catch {
			out = [];
		}
		return out;
	}

	private safeSize(f: string): number {
		try {
			return fs.statSync(f).size;
		} catch {
			return 0;
		}
	}

	private safeMtime(f: string): number {
		try {
			return fs.statSync(f).mtimeMs;
		} catch {
			return 0;
		}
	}
}
