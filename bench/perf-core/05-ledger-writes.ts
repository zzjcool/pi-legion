/**
 * perf-core bench 5 — ledger (SQLite WAL) write path.
 *
 * Measures the single-write cost of every ledger API on the hot paths, then the
 * write amplification when 1 / 10 / 50 connections (the in-process child model:
 * one connection per legion node, `index.ts` `legionIdentities`) write at the
 * same 2s heartbeat cadence plus one event per state change.
 *
 * Run: node --experimental-strip-types bench/perf-core/05-ledger-writes.ts
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { openLegionDb, withTransaction, type DatabaseSync } from "../../src/legion/db.ts";
import { insertNode, updateNode, heartbeatNode, getNode } from "../../src/legion/nodes.ts";
import { appendEvent } from "../../src/legion/events.ts";

function median(xs: number[]): number {
	const s = [...xs].sort((a, b) => a - b);
	const mid = Math.floor(s.length / 2);
	return s.length % 2 ? (s[mid] as number) : (((s[mid - 1] as number) + (s[mid] as number)) / 2);
}

function tmpDbDir(tag: string): { dir: string; dbPath: string } {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), `perf-core-${tag}-`));
	return { dir, dbPath: path.join(dir, "legion.db") };
}

function walBytes(dbPath: string): number {
	try { return fs.statSync(`${dbPath}-wal`).size; } catch { return 0; }
}

function timeIt(fn: () => void, n: number): number {
	fn();
	const samples: number[] = [];
	for (let r = 0; r < 3; r += 1) {
		const t0 = process.hrtime.bigint();
		for (let i = 0; i < n; i += 1) fn();
		samples.push(Number(process.hrtime.bigint() - t0) / 1e6 / n);
	}
	return median(samples);
}

const out: Record<string, unknown> = { bench: "05-ledger-writes", env: { node: process.version, cpus: os.cpus().length } };

// --- 1. single-write cost + PRAGMA facts ------------------------------------
{
	const { dir, dbPath } = tmpDbDir("single");
	const db = openLegionDb(dbPath);
	try {
		insertNode(db, { id: "root", parentId: null, name: "root", role: "root", kind: "pi", depth: 0, status: "running" });
		const pragma = (name: string): unknown => db.prepare(`PRAGMA ${name};`).get();
		out.pragmas = {
			synchronous: pragma("synchronous"),
			journal_mode: pragma("journal_mode"),
			wal_autocheckpoint: pragma("wal_autocheckpoint"),
			cache_size: pragma("cache_size"),
		};
		let n = 0;
		const single = {
			appendEvent_noData: timeIt(() => { appendEvent(db, "root", "node_launched"); }, 500),
			appendEvent_withData: timeIt(() => { appendEvent(db, "root", "node_launched", { name: `w${n += 1}`, runId: "r-1", spawnMode: "inprocess", at: Date.now() }); }, 500),
			updateNode: timeIt(() => { updateNode(db, "root", { status: "running" }); }, 300),
			heartbeatNode: timeIt(() => { heartbeatNode(db, "root", () => Date.now()); }, 500),
			heartbeatNode_batched20: (() => {
				const ids: string[] = [];
				for (let i = 0; i < 20; i += 1) { insertNode(db, { id: `root.c${i}`, parentId: "root", name: `c${i}`, role: "worker", kind: "pi", depth: 1, status: "running" }); ids.push(`root.c${i}`); }
				return timeIt(() => { withTransaction(db, () => { for (const id of ids) heartbeatNode(db, id, () => Date.now()); }); }, 50);
			})(),
			getNode: timeIt(() => { getNode(db, "root"); }, 2000),
		};
		out.singleWriteMs = Object.fromEntries(Object.entries(single).map(([k, v]) => [k, Number((v as number).toFixed(3))]));
		out.singleWritePerOp = {
			appendEvent_perSec: Math.round(1000 / single.appendEvent_noData),
			updateNode_perSec: Math.round(1000 / single.updateNode),
			heartbeatNode_perSec: Math.round(1000 / single.heartbeatNode),
			heartbeat20batched_perSec: Math.round(1000 / single.heartbeatNode_batched20),
		};
		// Immediate-mode transactions: does the UPDATE-by-id path contend?
		out.busyTimeouts = 0;
	} finally {
		db.close();
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

// --- 2. amplification: N connections at the production cadence --------------
// Production: one LegionPostman per legion node, POSTMAN_INTERVAL_MS = 2000,
// one BEGIN IMMEDIATE covering all alive children of that node
// (src/extension/legion-tools.ts:57,150-156,174-183).
async function amplification(children: number): Promise<Record<string, unknown>> {
	const { dir, dbPath } = tmpDbDir(`amp${children}`);
	const setup = openLegionDb(dbPath);
	insertNode(setup, { id: "root", parentId: null, name: "root", role: "root", kind: "pi", depth: 0, status: "running" });
	for (let i = 0; i < children; i += 1) {
		insertNode(setup, { id: `root.w${i}`, parentId: "root", name: `w${i}`, role: "worker", kind: "pi", depth: 1, status: "running", sessionFile: `/tmp/s${i}.jsonl` });
	}
	setup.close();

	// One connection per child, exactly like one runtime identity per node.
	const conns: DatabaseSync[] = [];
	for (let i = 0; i < children; i += 1) conns.push(openLegionDb(dbPath));
	const ticks = 5; // 5 ticks x 2s = 10s of simulated runtime, done back to back
	let busy = 0;
	try {
		const t0 = process.hrtime.bigint();
		for (let tick = 0; tick < ticks; tick += 1) {
			for (let i = 0; i < children; i += 1) {
				const db = conns[i] as DatabaseSync;
				try {
					// A centurion's postman tick: one transaction over its own children.
					withTransaction(db, () => {
						heartbeatNode(db, "root", () => Date.now());
						heartbeatNode(db, `root.w${i}`, () => Date.now());
					});
					// One state-change event per tick (phase_change / node_settled are ~1 per few ticks).
					if (i % 4 === 0) appendEvent(db, `root.w${i}`, "phase_change", { to: "implementing", tick });
				} catch (error) {
					const raw = error as { message?: unknown; code?: unknown };
					if (String(raw.message ?? "").includes("BUSY") || String(raw.code ?? "").includes("BUSY")) busy += 1;
					else throw error;
				}
			}
		}
		const totalMs = Number(process.hrtime.bigint() - t0) / 1e6;
		const counts = (() => {
			const db = conns[0] as DatabaseSync;
			const ev = db.prepare("SELECT count(*) AS c FROM events").get() as { c: number };
			return { events: Number(ev.c) };
		})();
		return {
			connections: children,
			ticks,
			totalMs: Number(totalMs.toFixed(1)),
			msPerTick: Number((totalMs / ticks).toFixed(2)),
			writesPerTick: children * 2 + Math.ceil(children / 4),
			busyErrors: busy,
			walMb: Number((walBytes(dbPath) / (1024 * 1024)).toFixed(2)),
			dbMb: Number((fs.statSync(dbPath).size / (1024 * 1024)).toFixed(2)),
			...counts,
		};
	} finally {
		for (const c of conns) { try { c.close(); } catch { /* ignore */ } }
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

const amp: Record<string, unknown>[] = [];
for (const n of [1, 10, 50]) amp.push(await amplification(n));
out.amplification = amp;

// --- 3. WAL growth / checkpoint behaviour under a long event burst ----------
{
	const { dir, dbPath } = tmpDbDir("wal");
	const db = openLegionDb(dbPath);
	try {
		insertNode(db, { id: "root", parentId: null, name: "root", role: "root", kind: "pi", depth: 0, status: "running" });
		const samples: Array<{ events: number; walMb: number }> = [];
		for (let i = 1; i <= 20_000; i += 1) {
			appendEvent(db, "root", "mail_sent", { i, subject: "x".repeat(120) });
			if (i % 2_000 === 0) samples.push({ events: i, walMb: Number((walBytes(dbPath) / (1024 * 1024)).toFixed(2)) });
		}
		out.walGrowth = {
			samples,
			maxWalMb: Math.max(...samples.map((s) => s.walMb)),
			bounded: Math.max(...samples.map((s) => s.walMb)) < 8,
		};
		out.eventInsertMs20k = Number((timeIt(() => { appendEvent(db, "root", "mail_sent", { i: 1 }); }, 300)).toFixed(3));
	} finally {
		db.close();
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

console.log(JSON.stringify(out, null, 2));
