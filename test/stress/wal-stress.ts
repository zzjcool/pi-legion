/**
 * M2-(g) acceptance driver — "60 模拟 supervisor 并发写 5 分钟，busy 超时率 <0.1%"
 * (`docs/legion-v2-contract.md` §14-M2 item (g)).
 *
 * This is a **verification tool, not production code and not a CI test**. It is
 * not in the `npm test` glob; run it explicitly:
 *
 *   npm run test:wal-stress                       # the contract scenario, 60 × 5 min
 *   npm run test:wal-stress -- --duration 30      # same shape, quick smoke
 *
 * Why separate OS processes: contract §4.1 fixes **one connection per supervisor
 * process**. Sixty `openLegionDb` handles inside one Node process would share one
 * event loop and one fs lock context, so the run would not exercise
 * inter-process WAL contention at all — it would measure a single process
 * multiplexing writes, which is a different (and easier) problem. `--mode
 * in-process` exists only to *demonstrate* that difference; it is not the
 * contract scenario and never reports the acceptance number.
 *
 * What is counted: `heartbeatEventTransaction` per supervisor per cadence tick —
 * the same helper the fast CI guard (`test/unit/wal-concurrency.test.ts`) pins.
 * `SQLITE_BUSY` / `SQLITE_LOCKED` are counted separately from every other error,
 * so a broken harness can never be hidden inside a lock-timeout statistic.
 */

import { fork } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { LEGION_DB_BUSY_TIMEOUT_MS, openLegionDb } from "../../src/legion/db.ts";
import { insertNode } from "../../src/legion/nodes.ts";
import {
	WAL_STRESS_DEFAULT_DURATION_MS,
	WAL_STRESS_DEFAULT_START_RAMP_MS,
	WAL_STRESS_DEFAULT_SUPERVISORS,
	WAL_STRESS_POSTMAN_INTERVAL_MS,
	WAL_STRESS_WORKLOADS,
	heartbeatEventTransaction,
	isBusyError,
	offeredTxPerSecond,
	percentile,
	type Workload,
} from "./wal-contract.ts";
import type { WorkerConfig, WorkerStats } from "./wal-worker.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKER_ENTRY = path.join(HERE, "wal-worker.ts");

/** The contract threshold. Reported, and only enforced when asked to. */
const CONTRACT_BUSY_RATE_PCT = 0.1;

type RunMode = "process" | "in-process";

interface Options {
	supervisors: number;
	durationMs: number;
	workload: Workload;
	startRampMs: number;
	mode: RunMode;
	dbFile: string | null;
	keepDb: boolean;
	assertBusyRatePct: number | null;
}

function parseArgs(argv: readonly string[]): Options {
	const options: Options = {
		supervisors: WAL_STRESS_DEFAULT_SUPERVISORS,
		durationMs: WAL_STRESS_DEFAULT_DURATION_MS,
		workload: "postman",
		startRampMs: WAL_STRESS_DEFAULT_START_RAMP_MS,
		mode: "process",
		dbFile: null,
		keepDb: false,
		assertBusyRatePct: null,
	};
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i] as string;
		const [flag, inline] = arg.includes("=") ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)] : [arg, undefined];
		const value = (): string => {
			if (inline !== undefined) return inline;
			const next = argv[i + 1];
			if (next === undefined || next.startsWith("--")) throw new Error(`${flag} requires a value`);
			i += 1;
			return next;
		};
		const int = (name: string, min: number): number => {
			const parsed = Number(value());
			if (!Number.isInteger(parsed) || parsed < min) throw new Error(`${name} must be an integer >= ${min}`);
			return parsed;
		};
		switch (flag) {
			case "--supervisors":
				options.supervisors = int("--supervisors", 1);
				break;
			case "--duration":
				options.durationMs = int("--duration", 1) * 1_000;
				break;
			case "--workload": {
				const workload = value() as Workload;
				if (!WAL_STRESS_WORKLOADS.includes(workload)) {
					throw new Error(`--workload must be one of ${WAL_STRESS_WORKLOADS.join("|")}`);
				}
				options.workload = workload;
				break;
			}
			case "--ramp-ms":
				options.startRampMs = int("--ramp-ms", 0);
				break;
			case "--mode": {
				const mode = value();
				if (mode !== "process" && mode !== "in-process") throw new Error("--mode must be process|in-process");
				options.mode = mode;
				break;
			}
			case "--db":
				options.dbFile = path.resolve(value());
				break;
			case "--keep-db":
				options.keepDb = true;
				break;
			case "--assert-busy-rate":
				options.assertBusyRatePct = Number(value());
				break;
			case "--help":
			case "-h":
				printUsage();
				process.exit(0);
				break;
			default:
				throw new Error(`unknown argument: ${arg}`);
		}
	}
	return options;
}

function printUsage(): void {
	console.log(
		[
			"Usage: npm run test:wal-stress -- [options]",
			"",
			"  --supervisors <n>          simulated supervisor processes (default 60, contract)",
			"  --duration <seconds>       wall-clock run length (default 300, contract)",
			"  --workload postman|saturate  postman = 1 txn/2s each (contract); saturate = no sleep",
			"  --ramp-ms <ms>             spread of first ticks (default 2000 = one postman interval)",
			"  --mode process|in-process  process = 1 forked child + 1 connection each (contract)",
			"  --db <path>                reuse a ledger path instead of a fresh temp dir",
			"  --keep-db                  keep the temp ledger and print its path",
			"  --assert-busy-rate <pct>   exit non-zero if the busy rate exceeds <pct>",
			"",
			"The contract scenario is the default: 60 supervisors, 5 minutes, postman cadence.",
		].join("\n"),
	);
}

/** Seed the tree: one root plus one node row per simulated supervisor. */
function seedLedger(dbFile: string, supervisors: number): string[] {
	const db = openLegionDb(dbFile);
	try {
		insertNode(db, { parentId: null, name: "root", role: "root", status: "running" });
		const nodeIds: string[] = [];
		for (let i = 0; i < supervisors; i += 1) {
			// Simulated supervisors are leaves that beat their own row: the same
			// UPDATE the real postman issues for a live child.
			const node = insertNode(db, {
				parentId: "root",
				name: `sim-${String(i).padStart(2, "0")}`,
				role: "worker",
				status: "running",
				phase: "implementing",
			});
			nodeIds.push(node.id);
		}
		return nodeIds;
	} finally {
		// The driver holds no connection while the run is underway: adding a 61st
		// connection here would quietly change the thing being measured.
		db.close();
	}
}

interface ChildResult {
	nodeId: string;
	stats: WorkerStats | null;
	exitCode: number | null;
	signal: NodeJS.Signals | null;
	stderr: string;
}

/**
 * Fork the simulated supervisors and collect their per-worker statistics.
 *
 * Children report over IPC once their deadline passes; the parent also holds a
 * hard kill timer so a wedged child fails the run instead of hanging it.
 */
function runProcessMode(options: Options, nodeIds: readonly string[], startAt: number): Promise<ChildResult[]> {
	const hardStopAt = startAt + options.startRampMs + options.durationMs + 60_000;
	return Promise.all(
		nodeIds.map(
			(nodeId) =>
				new Promise<ChildResult>((resolve) => {
					const cfg: WorkerConfig = {
						dbFile: options.dbFile as string,
						nodeId,
						durationMs: options.durationMs,
						intervalMs: options.workload === "postman" ? WAL_STRESS_POSTMAN_INTERVAL_MS : 0,
						startAt,
						startRampMs: options.startRampMs,
						workload: options.workload,
					};
					const child = fork(WORKER_ENTRY, [], {
						stdio: ["ignore", "pipe", "pipe", "ipc"],
						env: { ...process.env, PI_LEGION_WAL_WORKER: JSON.stringify(cfg) },
					});
					let stats: WorkerStats | null = null;
					let stderr = "";
					child.stderr?.on("data", (chunk: Buffer) => {
						// The SQLite driver's ExperimentalWarning is expected noise.
						stderr += String(chunk).replace(/^.*ExperimentalWarning.*\n?/gm, "");
					});
					child.stdout?.on("data", () => {});
					child.on("message", (message: unknown) => {
						const payload = message as { type?: string; stats?: WorkerStats };
						if (payload?.type === "wal-worker-stats" && payload.stats) stats = payload.stats;
					});
					const killTimer = setTimeout(() => {
						stderr += `\n[driver] hard-stop after ${hardStopAt - Date.now()}ms; child killed\n`;
						child.kill("SIGKILL");
					}, Math.max(0, hardStopAt - Date.now()));
					child.on("exit", (exitCode, signal) => {
						clearTimeout(killTimer);
						resolve({ nodeId, stats, exitCode, signal, stderr });
					});
				}),
		),
	);
}

/**
 * The comparison variant: N connections in ONE process. Documented as a control,
 * never as the acceptance measurement — see the file header.
 */
async function runInProcessMode(options: Options, nodeIds: readonly string[], startAt: number): Promise<ChildResult[]> {
	const results = await Promise.all(
		nodeIds.map(async (nodeId, index) => {
			const stats: WorkerStats = {
				nodeId,
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
			const db = openLegionDb(options.dbFile as string);
			stats.openMs = performance.now() - openedAt;
			stats.observedJournalMode = db.prepare("PRAGMA journal_mode").get()?.journal_mode;
			stats.observedBusyTimeout = Number(db.prepare("PRAGMA busy_timeout").get()?.timeout ?? 0);
			try {
				const startOffset = options.startRampMs > 0 ? Math.random() * options.startRampMs : 0;
				const firstTickAt = Math.max(startAt + startOffset, Date.now());
				await new Promise((resolve) => setTimeout(resolve, Math.max(0, firstTickAt - Date.now())));
				const deadline = firstTickAt + options.durationMs;
				const intervalMs = options.workload === "postman" ? WAL_STRESS_POSTMAN_INTERVAL_MS : 0;
				let seq = 0;
				while (Date.now() < deadline) {
					seq += 1;
					stats.attempts += 1;
					const began = performance.now();
					try {
						heartbeatEventTransaction(db, nodeId, seq);
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
					if (intervalMs > 0) {
						const wait = firstTickAt + seq * intervalMs - Date.now();
						if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
					} else if (index % 4 === 0) {
						// Yield so the in-process control still interleaves instead of
						// letting one connection run its whole loop before the next starts.
						await new Promise((resolve) => setImmediate(resolve));
					}
				}
			} finally {
				db.close();
			}
			return { nodeId, stats, exitCode: 0, signal: null, stderr: "" } satisfies ChildResult;
		}),
	);
	return results;
}

interface Totals {
	attempts: number;
	committed: number;
	busyFailures: number;
	otherFailures: number;
	latencies: number[];
	busyLatencies: number[];
	sampleOtherErrors: string[];
	badPreconditions: string[];
	workerLatencies: { nodeId: string; p50: number }[];
}

function totalsFrom(results: readonly ChildResult[]): Totals {
	const totals: Totals = {
		attempts: 0,
		committed: 0,
		busyFailures: 0,
		otherFailures: 0,
		latencies: [],
		busyLatencies: [],
		sampleOtherErrors: [],
		badPreconditions: [],
		workerLatencies: [],
	};
	for (const result of results) {
		const stats = result.stats;
		if (!stats) {
			totals.otherFailures += 1;
			totals.sampleOtherErrors.push(`${result.nodeId}: no stats (exit=${String(result.exitCode)} signal=${String(result.signal)} ${result.stderr.trim().slice(0, 400)})`);
			continue;
		}
		totals.attempts += stats.attempts;
		totals.committed += stats.committed;
		totals.busyFailures += stats.busyFailures;
		totals.otherFailures += stats.otherFailures;
		totals.latencies.push(...stats.latencies);
		totals.busyLatencies.push(...stats.busyLatencies);
		for (const message of stats.sampleOtherErrors) {
			if (totals.sampleOtherErrors.length < 8) totals.sampleOtherErrors.push(`${stats.nodeId}: ${message}`);
		}
		if (stats.observedJournalMode !== "wal") {
			totals.badPreconditions.push(`${stats.nodeId}: journal_mode=${String(stats.observedJournalMode)}`);
		}
		if (stats.observedBusyTimeout !== LEGION_DB_BUSY_TIMEOUT_MS) {
			totals.badPreconditions.push(`${stats.nodeId}: busy_timeout=${String(stats.observedBusyTimeout)}`);
		}
		totals.workerLatencies.push({ nodeId: stats.nodeId, p50: percentile(stats.latencies, 50) ?? 0 });
	}
	return totals;
}

function fmt(value: number | null, digits = 3): string {
	return value === null ? "n/a" : value.toFixed(digits);
}

/** Print the report the contract asks for; return the busy rate in percent. */
function report(
	options: Options,
	totals: Totals,
	wallMs: number,
	dbFile: string,
	failures: readonly string[],
): number {
	const busyRatePct = totals.attempts > 0 ? (totals.busyFailures / totals.attempts) * 100 : 0;
	const perWorker = totals.attempts / Math.max(1, options.supervisors);
	const offered = offeredTxPerSecond(options.workload, options.supervisors);
	const worst = [...totals.workerLatencies].sort((a, b) => b.p50 - a.p50).slice(0, 3);
	const label = options.mode === "process" ? `process (${options.supervisors} forked child processes, 1 connection each)` : `in-process CONTROL (${options.supervisors} connections, 1 Node process) — NOT the contract scenario`;

	console.log("");
	// Compare the *values actually used*, not whether the flag was typed: passing
	// `--duration 300` explicitly is still the contract scenario.
	const contractShape =
		options.supervisors === WAL_STRESS_DEFAULT_SUPERVISORS &&
		options.durationMs === WAL_STRESS_DEFAULT_DURATION_MS &&
		options.workload === "postman" &&
		options.mode === "process";
	console.log(`=== M2-(g) WAL stress: ${options.supervisors} simulated supervisors ===`);
	console.log(`mode           ${label}`);
	console.log(`workload       ${options.workload}${options.workload === "postman" ? ` (1 txn per ${WAL_STRESS_POSTMAN_INTERVAL_MS} ms per supervisor = the postman cadence)` : " (no sleep: saturation variant, NOT the contract scenario)"}`);
	console.log(`duration       ${(options.durationMs / 1000).toFixed(1)} s configured (contract: 300 s), ${(wallMs / 1000).toFixed(1)} s wall clock`);
	console.log(`start ramp     ${options.startRampMs} ms`);
	console.log(`offered rate   ${offered === null ? "saturated (unbounded)" : `${offered.toFixed(1)} txn/s across the run (1 txn per ${WAL_STRESS_POSTMAN_INTERVAL_MS / 1000} s per supervisor); ${perWorker.toFixed(0)} txns per supervisor expected`}`);
	console.log(`busy_timeout   ${LEGION_DB_BUSY_TIMEOUT_MS} ms (production value; journal_mode wal)`);
	console.log(`ledger         ${dbFile}`);
	console.log("");
	console.log("                    attempts  committed   busy    busy%     other");
	console.log(
		`TOTAL ${String(totals.attempts).padStart(20)} ${String(totals.committed).padStart(10)} ${String(totals.busyFailures).padStart(6)} ${fmt(busyRatePct).padStart(8)}% ${String(totals.otherFailures).padStart(9)}`,
	);
	console.log("");
	console.log(`successful txn latency  p50 ${fmt(percentile(totals.latencies, 50))} ms   p95 ${fmt(percentile(totals.latencies, 95))} ms   p99 ${fmt(percentile(totals.latencies, 99))} ms   max ${fmt(percentile(totals.latencies, 100))} ms`);
	if (totals.busyLatencies.length > 0) {
		console.log(`busy-failed txn latency p50 ${fmt(percentile(totals.busyLatencies, 50))} ms   max ${fmt(percentile(totals.busyLatencies, 100))} ms`);
	}
	if (worst.length > 0 && worst[0]!.p50 > 0) {
		console.log(`slowest supervisors by p50: ${worst.map((w) => `${w.nodeId}=${w.p50.toFixed(2)}ms`).join(", ")}`);
	}
	const shape = contractShape ? "contract scenario (60 x 300s postman)" : "NON-CONTRACT SHAPE (reduced supervisors or duration)";
	console.log(`\nshape          ${shape}`);
	console.log(`verdict        busy timeout rate ${fmt(busyRatePct)}% vs contract <${CONTRACT_BUSY_RATE_PCT}% => ${busyRatePct < CONTRACT_BUSY_RATE_PCT ? "PASS" : "EXCEEDS THRESHOLD (a finding, not a harness error)"}`);
	if (!contractShape && options.mode === "process" && options.workload === "postman") {
		console.log(`               note: this run does not authorise a M2-(g) claim; only 60 supervisors x 300 s does.`);
	}
	if (totals.sampleOtherErrors.length > 0) {
		console.log("\nnon-busy errors (first few):");
		for (const message of totals.sampleOtherErrors) console.log(`  - ${message}`);
	}
	if (totals.badPreconditions.length > 0) {
		console.log("\nPRECONDITION FAILURES:");
		for (const message of totals.badPreconditions.slice(0, 5)) console.log(`  - ${message}`);
	}
	if (failures.length > 0) {
		console.log("\nHARNESS FAILURES:");
		for (const message of failures) console.log(`  - ${message}`);
	}
	return busyRatePct;
}

async function main(): Promise<void> {
	const options = parseArgs(process.argv.slice(2));
	const temp = options.dbFile === null;
	const workDir = temp ? fs.mkdtempSync(path.join(os.tmpdir(), "legion-wal-stress-")) : path.dirname(options.dbFile as string);
	options.dbFile ??= path.join(workDir, "legion.db");
	if (!temp) fs.mkdirSync(path.dirname(options.dbFile), { recursive: true });

	console.log(`seeding ${options.supervisors} simulated supervisor rows into ${options.dbFile}`);
	const nodeIds = seedLedger(options.dbFile, options.supervisors);

	// Let the children race: they all wait for the same absolute instant, then
	// their own ramp offset places the first tick.
	const startAt = Date.now() + 2_500;
	const beganAt = Date.now();
	const results = options.mode === "process"
		? await runProcessMode(options, nodeIds, startAt)
		: await runInProcessMode(options, nodeIds, startAt);
	const wallMs = Date.now() - beganAt;

	const failures: string[] = [];
	for (const result of results) {
		if (result.exitCode !== 0 || result.signal !== null) {
			failures.push(`${result.nodeId}: exit=${String(result.exitCode)} signal=${String(result.signal)} ${result.stderr.trim().slice(0, 300)}`);
		}
	}
	const totals = totalsFrom(results);
	const busyRatePct = report(options, totals, wallMs, options.dbFile as string, failures);

	if (temp && !options.keepDb) {
		fs.rmSync(workDir, { recursive: true, force: true });
	} else {
		console.log(`\nledger kept at ${options.dbFile}`);
	}

	const harnessBroken = failures.length > 0 || totals.badPreconditions.length > 0 || totals.attempts === 0;
	if (harnessBroken) {
		console.error("\nHARNESS FAILURE: the run did not complete cleanly; the busy rate above is not trustworthy.");
		process.exit(1);
	}
	if (options.assertBusyRatePct !== null && busyRatePct >= options.assertBusyRatePct) {
		console.error(`\nbusy rate ${fmt(busyRatePct)}% >= --assert-busy-rate ${options.assertBusyRatePct}%`);
		process.exit(2);
	}
}

await main();
