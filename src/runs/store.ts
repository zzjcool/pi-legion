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
import { writeRunOwner } from "./owner.ts";
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

/**
 * How long a `listRuns()` snapshot may be reused before it is re-taken (#344).
 *
 * In-process writes drop the snapshot immediately, and a create/delete changes
 * the runs directory's mtime, so this bounds exactly one gap: a run.json
 * rewritten IN PLACE by another process, which moves no directory mtime. Short
 * enough that a foreign state change is seen within a control call or two, long
 * enough that a burst of control calls (the N-children × rounds case the scan
 * used to tax) re-parses nothing.
 */
const LIST_RUNS_CACHE_TTL_MS = 1_000;

/**
 * Per-root registry snapshot, shared by EVERY `RunStore` instance on that root
 * in this process (#344).
 *
 * Per-process rather than per-instance because the tool surface builds a
 * `RunStore` per call (`runStoreFor(cwd)`), so an instance-level cache would
 * almost never hit. A write through any instance drops the snapshot, which also
 * keeps two stores on one directory from serving each other stale records.
 */
interface RegistryCache {
	/** The last completed scan, or undefined when the next call must rescan. */
	snapshot?: { mtimeMs: number; at: number; runs: RunRecord[] } | undefined;
}

const REGISTRY_CACHES = new Map<string, RegistryCache>();

/** Cap on distinct roots tracked at once (a long-lived parent visits many cwds). */
const MAX_CACHED_RUN_ROOTS = 64;

function registryCacheFor(rootDir: string): RegistryCache {
	let cache = REGISTRY_CACHES.get(rootDir);
	if (cache) return cache;
	// Dropping every entry at once is safe — a dropped snapshot can only cause a
	// rescan, never a stale read — and keeps a session that walks through dozens
	// of worktree roots from growing this map without bound.
	if (REGISTRY_CACHES.size >= MAX_CACHED_RUN_ROOTS) REGISTRY_CACHES.clear();
	cache = {};
	REGISTRY_CACHES.set(rootDir, cache);
	return cache;
}

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
	private readonly ownedRuns = new Set<string>();

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
		// #344: every write path funnels through here (createRun, updateRun and
		// everything built on it), so this one line keeps the cached registry
		// honest for this root — including for other RunStore instances on it.
		this.invalidateRunsCache();
		record.updatedAt = new Date(this.nowFn()).toISOString();
		this.atomicWrite(
			this.runFile(record.runId),
			`${JSON.stringify(record, null, "\t")}\n`,
		);
		// Record which process last wrote this run so the startup sweep (#38)
		// can tell a live concurrent session from a hard-killed one.
		if (!this.ownedRuns.has(record.runId)) {
			try {
				writeRunOwner(path.dirname(this.runFile(record.runId)));
				this.ownedRuns.add(record.runId);
			} catch {
				// best effort: a missing owner file only makes the sweep more conservative
			}
		}
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

	/**
	 * All readable runs, oldest first. Corrupt entries are skipped silently.
	 *
	 * ## Why this is cached (#344)
	 *
	 * Every control call (`collect` / `status` / `steer` / `abort` / `retire` /
	 * `continue`) used to start here, so a store with 352 runs paid 352
	 * `readFileSync` + `JSON.parse` (26ms) per call, synchronously, on the parent's
	 * event loop — and the cost grew with every run ever written. The control
	 * paths now resolve a scoped name with a single `readRun` and only fall back
	 * here (see `resolveScopedChild`), and this scan keeps a snapshot so that a
	 * fallback also stops re-parsing unchanged records.
	 *
	 * The snapshot is keyed by `<rootDir>/runs` and dropped when ANY of these
	 * says the directory may have moved:
	 *
	 *   - the runs directory's `mtimeMs` changed (a run dir was created or
	 *     removed, by this process or another one);
	 *   - a `RunStore` in THIS process wrote a run.json — every write funnels
	 *     through {@link writeRun} (createRun / updateRun / addChild / updateChild
	 *     / removeChild) or {@link prune}, which invalidate the snapshot for the
	 *     whole root, so two stores on one directory cannot serve each other a
	 *     stale record;
	 *   - the snapshot is older than {@link LIST_RUNS_CACHE_TTL_MS}. A record
	 *     rewritten in place by ANOTHER process changes no directory mtime, so the
	 *     TTL is the bound on that: a foreign edit is picked up within the TTL
	 *     instead of when the directory happens to change.
	 *
	 * Returning a fresh array per call keeps the promise of the old
	 * implementation: callers may sort or splice what they get without touching
	 * the snapshot.
	 */
	listRuns(): RunRecord[] {
		const runsRoot = path.join(this.rootDir, RUNS_DIR);
		let mtimeMs: number;
		try {
			mtimeMs = fs.statSync(runsRoot).mtimeMs;
		} catch {
			// No runs directory: an empty registry, and nothing worth snapshotting.
			this.invalidateRunsCache();
			return [];
		}
		const cache = registryCacheFor(this.rootDir);
		const snapshot = cache.snapshot;
		if (
			snapshot &&
			snapshot.mtimeMs === mtimeMs &&
			this.nowFn() - snapshot.at < LIST_RUNS_CACHE_TTL_MS
		) {
			return [...snapshot.runs];
		}
		let entries: string[];
		try {
			entries = fs.readdirSync(runsRoot);
		} catch {
			this.invalidateRunsCache();
			return [];
		}
		const out: RunRecord[] = [];
		for (const entry of entries) {
			const record = this.readRun(entry);
			if (record) out.push(record);
		}
		out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
		cache.snapshot = { mtimeMs, at: this.nowFn(), runs: out };
		return [...out];
	}

	/**
	 * Drop the cached `listRuns()` snapshot for this store's root.
	 *
	 * Called by every write this store performs; public so a caller that mutates
	 * the runs directory out of band (a migration, a test fixture) can say so.
	 */
	invalidateRunsCache(): void {
		registryCacheFor(this.rootDir).snapshot = undefined;
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

		// A pruned run dir disappears without going through writeRun, and a removed
		// session file may be all a run had — either way the cached registry is no
		// longer what a scan would answer.
		this.invalidateRunsCache();
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
