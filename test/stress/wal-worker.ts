/**
 * One simulated supervisor for the M2-(g) WAL stress run.
 *
 * Spawned by `test/stress/wal-stress.ts` with `child_process.fork`, so every
 * copy of this file is a **separate OS process** holding **its own**
 * `openLegionDb` handle to the one shared ledger — the shape contract §4.1 fixes
 * ("每 supervisor 进程一连接") and the thing a 60-connection single process
 * cannot measure.
 *
 * The workload is the *postman* shape, not a benchmark loop: one short write
 * transaction per tick, at a fixed cadence, issued through
 * `heartbeatEventTransaction` in `wal-contract.ts` — the same helper the fast CI
 * guard pins, so the two cannot drift apart.
 *
 * Nothing here is imported by production code or by `npm test`.
 */

import { openLegionDb } from "../../src/legion/db.ts";
import {
	WAL_STRESS_EXPECTED_BUSY_TIMEOUT_MS,
	WAL_STRESS_EXPECTED_JOURNAL_MODE,
	heartbeatEventTransaction,
	isBusyError,
	type Workload,
} from "./wal-contract.ts";

export interface WorkerConfig {
	/** Ledger every worker shares. Absolute. */
	dbFile: string;
	/** The node row this simulated supervisor heartbeats. */
	nodeId: string;
	/** How long this worker keeps ticking, measured from its first tick. */
	durationMs: number;
	/** 0 = saturate (never sleep); otherwise one transaction per window. */
	intervalMs: number;
	/** Absolute epoch ms the run begins; `startRampMs` is spread from here. */
	startAt: number;
	/** Over how long this worker's first tick is spread, measured from `startAt`. */
	startRampMs: number;
	workload: Workload;
}

export interface WorkerStats {
	nodeId: string;
	attempts: number;
	committed: number;
	busyFailures: number;
	otherFailures: number;
	/** Durations of *successful* transactions only, in ms. */
	latencies: number[];
	/** Durations of transactions that died on `SQLITE_BUSY`, in ms. */
	busyLatencies: number[];
	/** First few non-busy error messages: the run never swallows them. */
	sampleOtherErrors: string[];
	observedJournalMode: unknown;
	observedBusyTimeout: number | null;
	/** Spawn-to-first-tick overhead: separates "slow to start" from "slow to write". */
	openMs: number;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

/** Run one simulated supervisor to its deadline and return what it observed. */
export async function runWorker(cfg: WorkerConfig): Promise<WorkerStats> {
	const stats: WorkerStats = {
		nodeId: cfg.nodeId,
		attempts: 0,
		committed: 0,
		busyFailures: 0,
		otherFailures: 0,
		latencies: [],
		busyLatencies: [],
		sampleOtherErrors: [],
		observedJournalMode: null,
		observedBusyTimeout: null,
		openMs: 0,
	};

	const openedAt = performance.now();
	// Exactly the production opener: WAL assertion, busy_timeout, statement cache
	// and migration all come from `openLegionDb`, never from this harness.
	const db = openLegionDb(cfg.dbFile);
	stats.openMs = performance.now() - openedAt;
	try {
		stats.observedJournalMode = db.prepare("PRAGMA journal_mode").get()?.journal_mode;
		stats.observedBusyTimeout = Number(db.prepare("PRAGMA busy_timeout").get()?.timeout ?? 0);
		if (stats.observedJournalMode !== WAL_STRESS_EXPECTED_JOURNAL_MODE) {
			throw new Error(
				`${cfg.nodeId}: journal_mode=${String(stats.observedJournalMode)}, expected ${WAL_STRESS_EXPECTED_JOURNAL_MODE}`,
			);
		}
		if (stats.observedBusyTimeout !== WAL_STRESS_EXPECTED_BUSY_TIMEOUT_MS) {
			throw new Error(
				`${cfg.nodeId}: busy_timeout=${String(stats.observedBusyTimeout)}, expected ${WAL_STRESS_EXPECTED_BUSY_TIMEOUT_MS}`,
			);
		}

		// Spread the first ticks across the ramp so the run has a *join* pattern
		// rather than a herd; ramp 0 keeps every tick on the same millisecond.
		const startOffset = cfg.startRampMs > 0 ? Math.random() * cfg.startRampMs : 0;
		const firstTickAt = Math.max(cfg.startAt + startOffset, Date.now());
		await sleep(firstTickAt - Date.now());

		const deadline = firstTickAt + cfg.durationMs;
		let seq = 0;
		while (Date.now() < deadline) {
			seq += 1;
			stats.attempts += 1;
			const began = performance.now();
			try {
				heartbeatEventTransaction(db, cfg.nodeId, seq);
				stats.committed += 1;
				stats.latencies.push(performance.now() - began);
			} catch (error) {
				const elapsed = performance.now() - began;
				if (isBusyError(error)) {
					stats.busyFailures += 1;
					stats.busyLatencies.push(elapsed);
				} else {
					stats.otherFailures += 1;
					if (stats.sampleOtherErrors.length < 5) {
						stats.sampleOtherErrors.push(String((error as Error)?.message ?? error));
					}
				}
			}
			if (cfg.intervalMs > 0) {
				const wait = firstTickAt + seq * cfg.intervalMs - Date.now();
				if (wait > 0) await sleep(wait);
			}
		}
	} finally {
		db.close();
	}
	return stats;
}

/**
 * Fork'ed-process entry point: read the config from the environment, run, and
 * hand the stats back over the IPC channel the parent gave us.
 */
export async function main(): Promise<void> {
	const send = process.send?.bind(process);
	if (!send) {
		throw new Error("wal-worker must be started by child_process.fork (IPC channel required)");
	}
	const raw = process.env.PI_LEGION_WAL_WORKER;
	if (!raw) throw new Error("PI_LEGION_WAL_WORKER is not set; start this file via test/stress/wal-stress.ts");
	const cfg = JSON.parse(raw) as WorkerConfig;
	if (!cfg.dbFile || !cfg.nodeId) throw new Error("PI_LEGION_WAL_WORKER is missing dbFile/nodeId");
	const stats = await runWorker(cfg);
	// Keep the IPC payload bounded on long runs; percentiles survive downsampling.
	stats.latencies = downsample(stats.latencies);
	stats.busyLatencies = downsample(stats.busyLatencies);
	send({ type: "wal-worker-stats", stats });
	process.disconnect?.();
}

function downsample(values: number[]): number[] {
	const limit = 4_000;
	if (values.length <= limit) return values;
	const step = values.length / limit;
	const out: number[] = [];
	for (let i = 0; i < limit; i += 1) out.push(values[Math.floor(i * step)] as number);
	return out;
}

// Fork'ed entry point. Guarded on the IPC channel so importing this module from a
// test (or a stray `node wal-worker.ts`) does not start a run and exit silently.
if (typeof process.send === "function") {
	await main();
}
