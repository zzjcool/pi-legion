/**
 * perf-core bench 6 — the 500ms watch tick (`statusEntries`) in the parent.
 *
 * `src/extension/runtime.ts:1308` `refreshUi()` runs every `DEFAULT_REFRESH_MS`
 * (500ms, runtime.ts:206) and calls `statusEntries()` once. This wires the
 * runtime exactly the way `index.ts:1196-1237` does (getTreeNodes =
 * getSubtree + attachUsageTotals; getTreeIdentity = getChildByName) against a
 * real WAL ledger, tracks real jobs with real session files, and times one tick.
 *
 * It also asserts the sweep contract, which timing alone cannot make: a warm tick
 * must parse **zero** session files, stat once per distinct ACTIVE session file,
 * and touch no terminal row's transcript at all — a terminal row's `LiveProgress`
 * is memoized by the runtime (#391), because `progressFromSession` never reads a
 * clock and a settled transcript never grows. Before #391 the `[300, 2]` tier
 * folded 300 distinct transcripts on every tick. That is counted
 * through `sessionFileCacheStats()` (`statCalls`, `misses`) rather than by
 * patching `fs`: `import * as fs from "node:fs"` bindings are read-only in ESM,
 * so a monkeypatch in this file would be invisible to `session.ts`.
 * A violation prints in the JSON and then fails the bench.
 *
 * Every seeded row owns a DISTINCT `sessionFile` path (a hard link to one base
 * transcript), so the expected gate traffic is one stat per ACTIVE row: with all
 * rows pointing at one path, the sweep's per-file dedupe would collapse the gate
 * to a single call and a regression that put terminal rows back on the parse path
 * would measure exactly the same numbers. On the `[300, 2, 298]` tier the old
 * code stat'ed 300 files and re-parsed the 44 the 256-entry cap had evicted, on
 * every tick; the fix stats 2 and parses none.
 *
 * Run: node --experimental-strip-types bench/perf-core/06-watch-tick.ts
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { openLegionDb } from "../../src/legion/db.ts";
import type { DatabaseSync } from "../../src/legion/db.ts";
import { insertNode, getSubtree, getChildByName } from "../../src/legion/nodes.ts";
import { attachUsageTotals, upsertUsage } from "../../src/legion/usage.ts";
import { createSessionRuntime } from "../../src/extension/runtime.ts";
import { isTerminalState } from "../../src/extension/liveness.ts";
import { sessionFileCacheStats } from "../../src/shared/session.ts";

function median(xs: number[]): number {
	const s = [...xs].sort((a, b) => a - b);
	const mid = Math.floor(s.length / 2);
	return s.length % 2 ? (s[mid] as number) : (((s[mid - 1] as number) + (s[mid] as number)) / 2);
}

// A real child transcript from the corpus (~500KB, the p50 shape).
const corpusRoot = "/root/code/pi-legion/.pi-subagents/runs";
function findSession(): string | undefined {
	const files: string[] = [];
	const walk = (dir: string, depth = 0): void => {
		let entries: fs.Dirent[] = [];
		try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
		for (const e of entries) {
			const full = path.join(dir, e.name);
			if (e.isDirectory() && depth < 3) walk(full, depth + 1);
			else if (e.isFile() && e.name.endsWith(".jsonl")) files.push(full);
		}
	};
	walk(corpusRoot);
	return files.find((f) => { try { const s = fs.statSync(f).size; return s > 300_000 && s < 900_000; } catch { return false; } });
}
const realSession = findSession();

interface Setup { dir: string; db: DatabaseSync; dbPath: string; files: string[] }

/**
 * One base transcript for the whole seed. The real p50-shaped corpus file when
 * this checkout has one, a two-turn synthetic file otherwise — the bench must
 * not depend on run artifacts surviving in `.pi-subagents/runs`.
 */
function seedBase(dir: string): string {
	const base = path.join(dir, "base.jsonl");
	if (realSession) {
		fs.copyFileSync(realSession, base);
		return base;
	}
	const user = JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "go" }] } });
	const assistant = JSON.stringify({
		type: "message",
		message: {
			role: "assistant",
			content: [{ type: "text", text: "done" }],
			stopReason: "stop",
			usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
		},
	});
	fs.writeFileSync(base, `${user}\n${assistant}\n`);
	return base;
}

/**
 * A DISTINCT `sessionFile` path per row, hard-linked to the one base file.
 *
 * Distinct paths are the point: with every row pointed at the same transcript,
 * the sweep's per-file dedupe would collapse the gate traffic to one call and a
 * regression that put terminal rows back on the parse path would stay invisible
 * (the same 1 stat / 1 hit / 0 parse would be measured either way).
 */
function rowSession(dir: string, base: string, i: number): string {
	const dest = path.join(dir, `s${i}.jsonl`);
	try {
		fs.linkSync(base, dest);
		return dest;
	} catch {
		try {
			fs.copyFileSync(base, dest);
			return dest;
		} catch {
			return base;
		}
	}
}

function seed(nodes: number, terminal: number): Setup {
	if (terminal > nodes) throw new RangeError(`terminal=${terminal} exceeds nodes=${nodes}`);
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "perf-core-tick-"));
	const dbPath = path.join(dir, "legion.db");
	const db = openLegionDb(dbPath);
	const base = seedBase(dir);
	insertNode(db, { id: "root", parentId: null, name: "root", role: "root", kind: "pi", depth: 0, status: "running" });
	const files: string[] = [];
	for (let i = 0; i < nodes; i += 1) {
		const id = `root.w${i}`;
		// The live rows come first, so a tier's jobs always land on live rows — the
		// ledger never tracks a child that already settled.
		const status = i < nodes - terminal ? "running" : "settled";
		const sessionFile = rowSession(dir, base, i);
		files.push(sessionFile);
		insertNode(db, { id, parentId: "root", name: `w${i}`, role: "worker", kind: "pi", depth: 1, status, sessionFile });
		upsertUsage(db, { nodeId: id, tokensIn: 5_000, tokensOut: 500, costUsd: 0.02 });
	}
	return { dir, db, dbPath, files };
}

interface TickResult {
	nodes: number;
	jobs: number;
	jobsWithNodeId: boolean;
	/** Rows seeded as settled/failed/retired — the memoized half (#391 A). */
	terminalRows: number;
	/** Rows the sweep still has to read every tick (running/blocked/starting + jobs). */
	activeRows: number;
	ms: number;
	identityLookups: number;
	/** Rows of one tick that carry a session file. */
	rowsWithSession: number;
	/** `statSync` calls the gate made in one warm tick. */
	statCalls: number;
	/** Cache hits in one warm tick: one per distinct active session file. */
	hits: number;
	/** Full `parseSessionFile` calls in one warm tick: must be 0, nothing changed. */
	parses: number;
}

/** Every gate assertion that failed; printed with the rows, thrown at the end. */
const violations: string[] = [];

function measure(nodeCount: number, jobCount: number, withNodeId: boolean, terminalCount = 0): TickResult {
	const liveNodes = nodeCount - terminalCount;
	if (jobCount > liveNodes) throw new RangeError(`jobs=${jobCount} exceeds live rows=${liveNodes}`);
	const setup = seed(nodeCount, terminalCount);
	let identityLookups = 0;
	const getTreeIdentity = (name: string): { nodeId: string; parentId: string | null; depth: number; supervisorName: string } | undefined => {
		identityLookups += 1;
		const node = getChildByName(setup.db, "root", name);
		return node ? { nodeId: node.id, parentId: node.parentId, depth: node.depth, supervisorName: name } : undefined;
	};
	const runtime = createSessionRuntime({
		sendMessage: () => {},
		getTreeNodes: () => attachUsageTotals(setup.db, getSubtree(setup.db, "root")),
		getTreeIdentity,
		refreshMs: 10 * 60 * 1000,
	});
	try {
		for (let i = 0; i < jobCount; i += 1) {
			runtime.track({
				name: `w${i}`,
				runId: "bench-run",
				agent: "worker",
				sessionFile: setup.files[i] as string,
				timeoutMs: 900_000,
				spawnMode: "inprocess",
				...(withNodeId ? { nodeId: `root.w${i}` } : {}),
				isAlive: () => true,
				collect: () => new Promise(() => {}),
			} as Parameters<typeof runtime.track>[0]);
		}
		/**
		 * Expected gate traffic, derived from the SEED and not from the measurement:
		 * every row owns a distinct transcript path, so a warm tick must stat exactly
		 * the files of the active rows (job rows, plus live rows no job covers) and
		 * none of the terminal ones. Deriving it from `statusEntries()` would let a
		 * broken sweep define its own expectation.
		 */
		const distinctActive = new Set<string>();
		for (let i = 0; i < jobCount; i += 1) distinctActive.add(setup.files[i] as string);
		for (let i = jobCount; i < liveNodes; i += 1) distinctActive.add(setup.files[i] as string);
		const expectedStatCalls = distinctActive.size;

		identityLookups = 0;
		runtime.statusEntries(); // warm: the first tick after a write pays the parse
		const entries = runtime.statusEntries().filter((entry) => entry.name !== "root");
		const terminalRows = entries.filter((entry) => isTerminalState(entry.state)).length;
		const activeRows = entries.length - terminalRows;
		const samples: number[] = [];
		let lookups = 0;
		let statCalls = 0;
		let hits = 0;
		let parses = 0;
		for (let r = 0; r < 5; r += 1) {
			identityLookups = 0;
			const before = sessionFileCacheStats();
			const t0 = process.hrtime.bigint();
			runtime.statusEntries();
			samples.push(Number(process.hrtime.bigint() - t0) / 1e6);
			const after = sessionFileCacheStats();
			lookups = Math.max(lookups, identityLookups);
			const statDelta = after.statCalls - before.statCalls;
			const hitDelta = after.hits - before.hits;
			const parseDelta = after.misses - before.misses;
			statCalls = Math.max(statCalls, statDelta);
			hits = Math.max(hits, hitDelta);
			parses = Math.max(parses, parseDelta);
			const label = `nodes=${nodeCount} jobs=${jobCount} terminal=${terminalCount} nodeId=${withNodeId ? "yes" : "no"} tick#${r}`;
			if (terminalRows !== terminalCount) {
				violations.push(
					`${label}: ${terminalRows} row(s) rendered terminal for a seed of ${terminalCount} — the expectation below assumes a row does not change status`,
				);
			}
			if (parseDelta !== 0) {
				violations.push(`${label}: parsed ${parseDelta} session file(s) — a warm tick must parse none`);
			}
			if (statDelta !== expectedStatCalls) {
				violations.push(
					`${label}: ${statDelta} stat call(s) for ${expectedStatCalls} active file(s) over ${entries.length} row(s) (${terminalRows} terminal, ${activeRows} active) — terminal rows must cost no stat and a memoized row must cost none either`,
				);
			}
			if (hitDelta !== expectedStatCalls) {
				violations.push(`${label}: ${hitDelta} cache hit(s) for ${expectedStatCalls} active file(s) — every unchanged file must be served from the cache`);
			}
		}
		return {
			nodes: nodeCount,
			jobs: jobCount,
			jobsWithNodeId: withNodeId,
			terminalRows,
			activeRows,
			ms: Number(median(samples).toFixed(2)),
			identityLookups: lookups,
			rowsWithSession: entries.length,
			statCalls,
			hits,
			parses,
		};
	} finally {
		runtime.dispose?.();
		try { setup.db.close(); } catch { /* ignore */ }
		fs.rmSync(setup.dir, { recursive: true, force: true });
	}
}

const rows: TickResult[] = [];
// [nodes, jobs, terminal] — live rows are seeded first, so jobs land on live rows.
for (const [n, j, t] of [
	[0, 0, 0],
	[10, 0, 0],
	[50, 0, 0],
	[10, 10, 0],
	[50, 10, 0],
	[50, 50, 0],
	// #391's reported shape: 300 ledger rows, 2 of them running. Before the fix
	// this tick parsed 302 files; the sweep is now O(active rows), not O(rows).
	[300, 2, 298],
] as Array<[number, number, number]>) {
	rows.push(measure(n, j, true, t));
}
for (const [n, j, t] of [
	[50, 10, 0],
	[50, 50, 0],
] as Array<[number, number, number]>) {
	rows.push(measure(n, j, false, t));
}

console.log(
	JSON.stringify(
		{
			bench: "06-watch-tick",
			env: { node: process.version, cpus: os.cpus().length },
			realSession: realSession ?? null,
			realSessionMb: realSession ? Number((fs.statSync(realSession).size / 1048576).toFixed(2)) : 0,
			rows,
			tickBudgetMs: 500,
			gate: {
				violations,
				rule: "zero parses per tick; one statSync per distinct active session file; terminal rows cost neither",
			},
		},
		null,
		2,
	),
);

if (violations.length > 0) {
	throw new Error(`#348 gate assertion failed in ${violations.length} tick(s):\n${violations.join("\n")}`);
}
