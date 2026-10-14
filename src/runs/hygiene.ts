/**
 * Startup storage hygiene for `.pi-subagents/` (#37, #38, #40).
 *
 * Runs once per root (non-child) session, best effort, never throws. Every
 * destructive step is gated on BOTH age and process ownership so a concurrent
 * live pi session in the same project is never touched, and every limit is
 * env-configurable (0 disables that step).
 *
 *  - #38 temp sweep: `runs/<id>/rpc-child-*` dirs whose owner pid is dead
 *    (or, for legacy dirs without a marker, older than the legacy age).
 *  - #38 stale records: in run dirs whose owner pid is dead, non-root ledger
 *    nodes still `starting`/`running`/`blocked` and not updated for
 *    `staleNodeHours` are marked `failed` with a `node_abandoned` event, and
 *    a leftover WAL is checkpointed.
 *  - #37 prune: whole run dirs idle longer than `retentionDays`, owner dead,
 *    and WITHOUT a `worktrees/` entry (retired worktrees are kept on purpose
 *    as resume credentials — docs/legion-v2-contract.md:270).
 *  - #40 event retention: see `applyEventRetention` (called on the live db).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { openLegionDb, type DatabaseSync } from "../legion/db.ts";
import { RUN_OWNER_FILE, TEMP_OWNER_FILE, isPidAlive, ownerState } from "./owner.ts";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export interface HygieneConfig {
	/** #37: prune run dirs idle longer than this. 0 disables. */
	retentionDays: number;
	/** #38: mark abandoned nodes idle longer than this. 0 disables. */
	staleNodeHours: number;
	/** #38: legacy rpc-child dirs without an owner marker older than this are swept. */
	legacyTempHours: number;
	/** #40: delete terminal-node events older than this. 0 disables. */
	eventRetentionDays: number;
	/** #40: soft row cap for the events table (oldest terminal-node rows go first). 0 disables. */
	eventMaxRows: number;
}

export const HYGIENE_DEFAULTS: HygieneConfig = {
	retentionDays: 14,
	staleNodeHours: 72,
	legacyTempHours: 24,
	eventRetentionDays: 30,
	eventMaxRows: 200_000,
};

/** Written under storeRoot after each startup sweep so doctor can show "last sweep". */
export const HYGIENE_LAST_FILE = ".hygiene-last.json";

export const HYGIENE_ENV = {
	disable: "PI_LEGION_HYGIENE",
	retentionDays: "PI_LEGION_RUN_RETENTION_DAYS",
	staleNodeHours: "PI_LEGION_STALE_NODE_HOURS",
	legacyTempHours: "PI_LEGION_STALE_TEMP_HOURS",
	eventRetentionDays: "PI_LEGION_EVENT_RETENTION_DAYS",
	eventMaxRows: "PI_LEGION_EVENT_MAX_ROWS",
} as const;

function envNumber(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
	const raw = env[key]?.trim();
	if (!raw) return fallback;
	const n = Number(raw);
	return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export function resolveHygieneConfig(env: NodeJS.ProcessEnv = process.env): HygieneConfig {
	return {
		retentionDays: envNumber(env, HYGIENE_ENV.retentionDays, HYGIENE_DEFAULTS.retentionDays),
		staleNodeHours: envNumber(env, HYGIENE_ENV.staleNodeHours, HYGIENE_DEFAULTS.staleNodeHours),
		legacyTempHours: envNumber(env, HYGIENE_ENV.legacyTempHours, HYGIENE_DEFAULTS.legacyTempHours),
		eventRetentionDays: envNumber(env, HYGIENE_ENV.eventRetentionDays, HYGIENE_DEFAULTS.eventRetentionDays),
		eventMaxRows: Math.floor(envNumber(env, HYGIENE_ENV.eventMaxRows, HYGIENE_DEFAULTS.eventMaxRows)),
	};
}

/** `PI_LEGION_HYGIENE=0|off|false` turns the whole startup sweep off. */
export function hygieneEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	const raw = env[HYGIENE_ENV.disable]?.trim().toLowerCase();
	return !(raw === "0" || raw === "off" || raw === "false");
}

export interface HygieneReport {
	removedTempDirs: string[];
	abandonedNodes: string[];
	checkpointedDbs: string[];
	prunedRuns: string[];
	deletedEvents: number;
	freedBytes: number;
	errors: string[];
}

export interface HygieneOptions {
	storeRoot: string;
	/** Run ids that belong to this process and must never be touched. */
	protectRunIds?: Iterable<string>;
	config?: HygieneConfig;
	now?: () => number;
	isAlive?: (pid: number) => boolean;
}

function listDirs(dir: string): string[] {
	try {
		return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => path.join(dir, e.name));
	} catch {
		return [];
	}
}

function safeStat(p: string): fs.Stats | undefined {
	try { return fs.statSync(p); } catch { return undefined; }
}

/** Bytes under `dir` (no symlink following). */
export function dirBytes(dir: string): number {
	let total = 0;
	const stack = [dir];
	while (stack.length) {
		const cur = stack.pop()!;
		let entries: fs.Dirent[];
		try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch { continue; }
		for (const e of entries) {
			const p = path.join(cur, e.name);
			if (e.isDirectory()) stack.push(p);
			else if (e.isFile()) total += safeStat(p)?.size ?? 0;
		}
	}
	return total;
}

/** Newest mtime among the run dir and its direct entries (cheap idleness signal). */
function lastActivityMs(runDir: string): number {
	let newest = safeStat(runDir)?.mtimeMs ?? 0;
	try {
		for (const name of fs.readdirSync(runDir)) {
			const st = safeStat(path.join(runDir, name));
			if (st && st.mtimeMs > newest) newest = st.mtimeMs;
		}
	} catch { /* ignore */ }
	return newest;
}

function hasWorktrees(runDir: string): boolean {
	try {
		return fs.readdirSync(path.join(runDir, "worktrees")).length > 0;
	} catch {
		return false;
	}
}

const ACTIVE_STATUSES = ["starting", "running", "blocked"];

function markAbandoned(dbPath: string, staleBefore: number, now: number): string[] {
	const db = openLegionDb(dbPath);
	try {
		const rows = db.prepare(
			`SELECT id FROM nodes WHERE parent_id IS NOT NULL AND status IN (${ACTIVE_STATUSES.map(() => "?").join(",")}) AND updated_at < ?`,
		).all(...ACTIVE_STATUSES, staleBefore);
		const ids = rows.map((r) => String(r.id));
		for (const id of ids) {
			db.prepare("UPDATE nodes SET status = 'failed', updated_at = ? WHERE id = ?").run(now, id);
			db.prepare("INSERT INTO events (node_id, type, data, ts) VALUES (?, 'node_abandoned', ?, ?)")
				.run(id, JSON.stringify({ reason: "owner process gone; startup sweep", staleBefore }), now);
		}
		return ids;
	} finally {
		db.close();
	}
}

/** Fold the WAL back into the main db and truncate it. Never throws. */
export function checkpoint(db: DatabaseSync): boolean {
	try {
		db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
		return true;
	} catch {
		return false;
	}
}

export function runStartupHygiene(opts: HygieneOptions): HygieneReport {
	const config = opts.config ?? resolveHygieneConfig();
	const now = (opts.now ?? Date.now)();
	const alive = opts.isAlive ?? isPidAlive;
	const protect = new Set(opts.protectRunIds ?? []);
	const report: HygieneReport = { removedTempDirs: [], abandonedNodes: [], checkpointedDbs: [], prunedRuns: [], deletedEvents: 0, freedBytes: 0, errors: [] };
	const runsRoot = path.join(opts.storeRoot, "runs");

	for (const runDir of listDirs(runsRoot)) {
		const runId = path.basename(runDir);
		if (protect.has(runId)) continue;

		// #38(1): orphan rpc-child temp dirs.
		for (const tmp of listDirs(runDir).filter((d) => path.basename(d).startsWith("rpc-child-"))) {
			const state = ownerState(path.join(tmp, TEMP_OWNER_FILE), alive);
			const legacyStale = state === "unknown" && config.legacyTempHours > 0 &&
				now - (safeStat(tmp)?.mtimeMs ?? now) > config.legacyTempHours * HOUR_MS;
			if (state !== "dead" && !legacyStale) continue;
			try {
				const bytes = dirBytes(tmp);
				fs.rmSync(tmp, { recursive: true, force: true });
				report.removedTempDirs.push(tmp);
				report.freedBytes += bytes;
			} catch (error) {
				report.errors.push(`${tmp}: ${String(error)}`);
			}
		}

		// Ownership of the run itself: only a dead (or long-silent legacy) owner is fair game.
		const runOwner = ownerState(path.join(runDir, RUN_OWNER_FILE), alive);
		if (runOwner === "live") continue;
		const idleMs = now - lastActivityMs(runDir);

		// #37: prune whole idle run dirs, keeping any with worktrees.
		if (config.retentionDays > 0 && idleMs > config.retentionDays * DAY_MS && !hasWorktrees(runDir) && safeStat(path.join(runDir, "run.json"))) {
			try {
				const bytes = dirBytes(runDir);
				fs.rmSync(runDir, { recursive: true, force: true });
				report.prunedRuns.push(runDir);
				report.freedBytes += bytes;
				continue;
			} catch (error) {
				report.errors.push(`${runDir}: ${String(error)}`);
			}
		}

		// #38(2): stale "working" ledger records + leftover WAL in dead-owner runs.
		const dbPath = path.join(runDir, "legion.db");
		if (!safeStat(dbPath)) continue;
		const walBytes = safeStat(`${dbPath}-wal`)?.size ?? 0;
		const markStale = config.staleNodeHours > 0 && (runOwner === "dead" || idleMs > config.staleNodeHours * HOUR_MS);
		const bigDb = (safeStat(dbPath)?.size ?? 0) > 1024 * 1024;
		if (!markStale && walBytes === 0 && !bigDb) continue;
		try {
			if (markStale) {
				const ids = markAbandoned(dbPath, now - config.staleNodeHours * HOUR_MS, now);
				report.abandonedNodes.push(...ids.map((id) => `${runId}/${id}`));
			}
			const db = openLegionDb(dbPath);
			try {
				const retention = applyEventRetention(db, config, now);
				report.deletedEvents += retention.deleted;
			} finally { db.close(); }
			if (walBytes > 0) {
				report.checkpointedDbs.push(dbPath);
				report.freedBytes += Math.max(0, walBytes - (safeStat(`${dbPath}-wal`)?.size ?? 0));
			}
		} catch (error) {
			report.errors.push(`${dbPath}: ${String(error)}`);
		}
	}
	try {
		fs.writeFileSync(
			path.join(opts.storeRoot, HYGIENE_LAST_FILE),
			`${JSON.stringify({
				at: now,
				removedTempDirs: report.removedTempDirs.length,
				abandonedNodes: report.abandonedNodes.length,
				prunedRuns: report.prunedRuns.length,
				deletedEvents: report.deletedEvents,
				freedBytes: report.freedBytes,
				errors: report.errors.length,
			})}\n`,
			{ mode: 0o600 },
		);
	} catch {
		/* best-effort marker for doctor */
	}
	return report;
}

/** Event types kept regardless of age: audit-relevant facts (#40). */
export const RETAINED_EVENT_TYPES = ["orphan_detected", "budget_refused", "node_abandoned"] as const;

export interface EventRetentionResult {
	deleted: number;
	vacuumed: boolean;
}

/**
 * #40: bounded events table. Only events of TERMINAL nodes (settled/failed)
 * are eligible — live/resumable nodes' events drive phase/orphan decisions —
 * and `RETAINED_EVENT_TYPES` are always kept. Deletes rows older than
 * `eventRetentionDays`, then enforces `eventMaxRows` oldest-first. VACUUMs
 * only after a large delete and only if no other connection holds the db
 * (busy → skipped, never fatal). Always finishes with a WAL checkpoint.
 */
export function applyEventRetention(db: DatabaseSync, config: HygieneConfig = resolveHygieneConfig(), now: number = Date.now()): EventRetentionResult {
	let deleted = 0;
	const keep = RETAINED_EVENT_TYPES.map(() => "?").join(",");
	const eligible = `node_id IN (SELECT id FROM nodes WHERE status IN ('settled','failed')) AND type NOT IN (${keep})`;
	try {
		if (config.eventRetentionDays > 0) {
			const r = db.prepare(`DELETE FROM events WHERE ts < ? AND ${eligible}`)
				.run(now - config.eventRetentionDays * DAY_MS, ...RETAINED_EVENT_TYPES);
			deleted += Number(r.changes);
		}
		if (config.eventMaxRows > 0) {
			const total = Number(db.prepare("SELECT COUNT(*) AS n FROM events").get()?.n ?? 0);
			const excess = total - config.eventMaxRows;
			if (excess > 0) {
				const r = db.prepare(`DELETE FROM events WHERE id IN (SELECT id FROM events WHERE ${eligible} ORDER BY id LIMIT ?)`)
					.run(...RETAINED_EVENT_TYPES, excess);
				deleted += Number(r.changes);
			}
		}
	} catch {
		return { deleted, vacuumed: false };
	}
	let vacuumed = false;
	if (deleted >= 1_000) {
		try {
			db.exec("VACUUM;");
			vacuumed = true;
		} catch {
			// another connection is active; the freed pages are reused anyway
		}
	}
	checkpoint(db);
	return { deleted, vacuumed };
}

export function formatHygieneReport(report: HygieneReport): string | undefined {
	const parts: string[] = [];
	if (report.prunedRuns.length) parts.push(`pruned ${report.prunedRuns.length} idle run dir(s)`);
	if (report.removedTempDirs.length) parts.push(`removed ${report.removedTempDirs.length} orphan rpc-child temp dir(s)`);
	if (report.abandonedNodes.length) parts.push(`marked ${report.abandonedNodes.length} abandoned node(s) failed`);
	if (report.deletedEvents) parts.push(`dropped ${report.deletedEvents} old ledger event(s)`);
	if (report.checkpointedDbs.length) parts.push(`checkpointed ${report.checkpointedDbs.length} leftover WAL(s)`);
	if (!parts.length) return undefined;
	const mb = (report.freedBytes / (1024 * 1024)).toFixed(1);
	return `pi-legion storage sweep: ${parts.join(", ")} (freed ${mb} MB)`;
}
