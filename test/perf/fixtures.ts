/**
 * Shared fixtures for the `test/perf` measurements.
 *
 * These are MEASUREMENT tests, not regression gates: they print numbers and
 * enforce only deliberately loose ceilings (an order of magnitude above the
 * observed cost) so a 30x slowdown is caught without a flaky CI on a slow box.
 *
 * Every helper drives production modules directly — no reimplementation of the
 * hot path — so a measurement here stays honest about what ships.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { openLegionDb, type DatabaseSync, type LegionStatementSync } from "../../src/legion/db.ts";
import { insertNode } from "../../src/legion/nodes.ts";
import { upsertUsage } from "../../src/legion/usage.ts";

export interface BenchDb {
	db: DatabaseSync;
	dir: string;
	close(): void;
}

/** A temp-file legion db (WAL, real fsync) — a file db, never `:memory:`. */
export function benchDb(): BenchDb {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "legion-perf-"));
	const db = openLegionDb(path.join(dir, "perf.db"));
	return {
		db,
		dir,
		close() {
			try { db.close(); } catch { /* already closed */ }
			try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
		},
	};
}

/**
 * Run `fn` against a fresh temp-file ledger and always tear it down.
 *
 * Prefer this over a manual try/finally: the teardown closes the db before
 * removing the dir, and a leaked WAL from a failed assertion would otherwise
 * wedge the next run on the same temp path.
 */
export function withBench<T>(fn: (h: BenchDb) => T): T {
	const h = benchDb();
	try {
		return fn(h);
	} finally {
		h.close();
	}
}

/**
 * Build a contract-shaped tree: 8 children per node, `total` nodes overall
 * (contract caps are depth 4 / 8 children per node / 30 active).
 */
export function buildTree(db: DatabaseSync, total: number): string[] {
	const ids: string[] = [];
	insertNode(db, { id: "root", parentId: null, name: "root", role: "root", kind: "pi", depth: 0, status: "running" });
	ids.push("root");
	let made = 1;
	let frontier: Array<{ id: string; depth: number }> = [{ id: "root", depth: 0 }];
	while (made < total && frontier.length > 0) {
		const next: Array<{ id: string; depth: number }> = [];
		for (const parent of frontier) {
			for (let k = 0; k < 8 && made < total; k += 1) {
				const id = `${parent.id}.w${k}`;
				insertNode(db, {
					id,
					parentId: parent.id,
					name: `w${k}`,
					role: "worker",
					kind: "pi",
					depth: parent.depth + 1,
					status: "running",
				});
				upsertUsage(db, { nodeId: id, tokensIn: 1_000, tokensOut: 200, costUsd: 0.01 });
				next.push({ id, depth: parent.depth + 1 });
				ids.push(id);
				made += 1;
			}
		}
		frontier = next;
	}
	return ids;
}

/**
 * Compile a statement directly on the driver, bypassing the data layer's
 * statement cache (#236 P2). The cache installs an *own* `prepare` on the
 * connection, so the prototype's `prepare` is still the raw driver call.
 *
 * Measurement helper only: use it to price compilation itself, never to
 * reach production behaviour.
 */
export function rawPrepare(db: DatabaseSync, sql: string): LegionStatementSync {
	const prototype = Object.getPrototypeOf(db) as { prepare?: (sql: string) => LegionStatementSync };
	const driverPrepare = prototype.prepare;
	if (typeof driverPrepare !== "function") {
		throw new TypeError("driver offers no prototype prepare to bypass the statement cache");
	}
	return driverPrepare.call(db, sql);
}

/**
 * Median of `runs` timings of `fn` (ms). Median, not mean: a perf number must
 * not be dragged by one GC pause or one unrelated fsync.
 */
export function medianMs(fn: () => void, runs = 5): number {
	const samples: number[] = [];
	fn(); // warm: JIT + statement compile + page cache
	for (let i = 0; i < runs; i += 1) {
		const start = performance.now();
		fn();
		samples.push(performance.now() - start);
	}
	samples.sort((a, b) => a - b);
	return samples[Math.floor(samples.length / 2)] ?? 0;
}

/** Microseconds per op for a tight loop — cheaper than timing one call. */
export function usPerOp(fn: () => void, iters = 2_000): number {
	fn();
	const start = performance.now();
	for (let i = 0; i < iters; i += 1) fn();
	return ((performance.now() - start) / iters) * 1_000;
}

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");

/**
 * Real session JSONL files from this checkout's run artifacts, largest first.
 * Returns [] when the checkout has no run artifacts (fresh clone / CI), so a
 * caller must skip rather than assert on an empty set.
 */
export function realSessionFiles(limit = 5): Array<{ file: string; bytes: number }> {
	const root = path.join(REPO_ROOT, ".pi-subagents", "runs");
	const found: Array<{ file: string; bytes: number }> = [];
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(root, { withFileTypes: true });
	} catch {
		return [];
	}
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const dir = path.join(root, entry.name);
		let files: string[];
		try {
			files = fs.readdirSync(dir).filter((n) => n.endsWith(".jsonl"));
		} catch {
			continue;
		}
		for (const name of files) {
			const file = path.join(dir, name);
			try {
				const bytes = fs.statSync(file).size;
				if (bytes > 1_000) found.push({ file, bytes });
			} catch { /* race with a running agent */ }
		}
	}
	return found.sort((a, b) => b.bytes - a.bytes).slice(0, limit);
}

/** True when real run artifacts exist (these tests are skipped otherwise). */
export function hasRealArtifacts(): boolean {
	return realSessionFiles(1).length > 0;
}
