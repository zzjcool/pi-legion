/**
 * M2-(g) fast guard — the CI-visible half of the 60-supervisor WAL stress claim
 * (`docs/legion-v2-contract.md` §14-M2 item (g)).
 *
 * ## What this test proves
 *
 * 1. **`busy_timeout` is honoured rather than bypassed.** A connection that loses
 *    the write lock to another connection's open transaction **waits** for the
 *    holder and then commits — it neither fails fast nor reports a bogus success.
 * 2. **Contention really is produced by this harness**, and the assertion in (3)
 *    therefore has discriminating power: the *same* workload with `busy_timeout`
 *    forced to 0 fails on `SQLITE_BUSY`. Without that control, "zero busy
 *    failures" would be unfalsifiable — a single-threaded fixture that never
 *    overlaps two writers passes no matter what the timeout is (verified: 12
 *    same-thread connections with `busy_timeout = 0` commit 96/96 with zero busy
 *    errors, because each synchronous transaction finishes before the next
 *    begins).
 * 3. **Zero `SQLITE_BUSY` at concurrent short-write load**, using
 *    `heartbeatEventTransaction` from `test/stress/wal-contract.ts` — the very
 *    helper the 5-minute driver runs, so the two cannot drift apart.
 * 4. **Preconditions**: every connection reports `PRAGMA journal_mode = wal` and
 *    `PRAGMA busy_timeout = LEGION_DB_BUSY_TIMEOUT_MS`.
 * 5. **The classifier is tight**: a constraint violation is not counted as a lock
 *    timeout, so a driver cannot reach "0 busy failures" by laundering real
 *    errors into the busy bucket.
 *
 * ## What this test does NOT prove
 *
 * The contract's claim is about **60 separate OS processes for 5 minutes**. This
 * test runs 8 worker **threads** for well under a second, and only the driver
 * measures the criterion. Specifically:
 *
 * - **Threads are not processes.** Each worker thread here is its own OS thread
 *   with its own `openLegionDb` connection, so SQLite's lock attempts genuinely
 *   block in parallel — that is real mutex contention, not simulated. But the
 *   contract fixes *one connection per supervisor **process*** (§4.1), and
 *   forked processes differ from threads in ways that matter to this claim:
 *   process start-up skew, scheduler placement across cores, and per-process
 *   page-cache/fs state. A thread-based harness can only *approximate* the
 *   collision profile of 60 forked children.
 * - **Duration.** A 5-minute run reaches regimes this test cannot: checkpoint
 *   stalls once the WAL grows past `wal_autocheckpoint`, long-lived readers
 *   pinning frames, and lock-wait queues that only form after sustained
 *   pile-ups. Milliseconds of queuing say nothing about 300 seconds of it.
 * - **A rate.** There is no busy rate here to compare against `< 0.1%`. The only
 *   number that answers the contract is printed by `npm run test:wal-stress`.
 *
 * This test pins the *properties the long run depends on*, and only
 * `test/stress/wal-stress.ts` measures the acceptance criterion.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { Worker } from "node:worker_threads";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import {
	LEGION_DB_BUSY_TIMEOUT_MS,
	LEGION_DB_REQUIRED_JOURNAL_MODE,
	openLegionDb,
} from "../../src/legion/db.ts";
import { insertNode } from "../../src/legion/nodes.ts";
// `heartbeatEventTransaction` is not called from this file: the worker body below
// `require`s `wal-contract.ts` so each thread runs the production helper. Only the
// classifier is needed here, for the unit-level assertion on it.
import { isBusyError } from "../stress/wal-contract.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC_DB = path.join(HERE, "..", "..", "src", "legion", "db.ts");
const CONTRACT = path.join(HERE, "..", "stress", "wal-contract.ts");

/** Concurrent writers; the task's suggested 8–12 range. */
const THREADS = 8;

interface Ledger {
	file: string;
	cleanup(): void;
}

function freshLedger(name: string): Ledger {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), `legion-wal-${name}-`));
	const file = path.join(dir, "legion.db");
	const db = openLegionDb(file);
	try {
		insertNode(db, { parentId: null, name: "root", role: "root", status: "running" });
		for (let i = 0; i < THREADS; i += 1) {
			insertNode(db, {
				parentId: "root",
				name: `sim-${String(i).padStart(2, "0")}`,
				role: "worker",
				status: "running",
			});
		}
	} finally {
		db.close();
	}
	return { file, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

interface ThreadOutcome {
	plain: number;
	held: number;
	busy: number;
	other: string[];
	waitedMs: number[];
	journalMode: unknown;
	busyTimeout: number;
}

/**
 * Worker body. `require` is used because the thread runs as CommonJS eval; the
 * parent's `--experimental-strip-types` is inherited, so the `.ts` modules load
 * directly and the thread runs the *production* opener and the *same* transaction
 * helper as the long driver.
 *
 * `holdMs > 0` deliberately occupies the write lock for that long inside the
 * transaction (via `Atomics.wait`, which blocks this thread without yielding).
 * That is a deterministic way to force 8 writers to overlap; it is a fixture, not
 * a claim about how long a real postman transaction takes.
 */
const WORKER_BODY = `
const { parentPort, workerData } = require("node:worker_threads");
const { openLegionDb, withTransaction } = require(workerData.srcDb);
const { heartbeatEventTransaction, isBusyError } = require(workerData.contract);
const cfg = workerData;
const db = openLegionDb(cfg.file);
if (cfg.forceBusyTimeout !== null) db.exec("PRAGMA busy_timeout = " + cfg.forceBusyTimeout + ";");
const outcome = {
  plain: 0, held: 0, busy: 0, other: [],
  waitedMs: [],
  journalMode: db.prepare("PRAGMA journal_mode").get() ? db.prepare("PRAGMA journal_mode").get().journal_mode : null,
  busyTimeout: Number(db.prepare("PRAGMA busy_timeout").get().timeout),
};
const holdSleeper = new Int32Array(new SharedArrayBuffer(4));
function attempt(fn) {
  const began = performance.now();
  try { fn(); return performance.now() - began; }
  catch (e) {
    if (isBusyError(e)) outcome.busy += 1;
    else if (outcome.other.length < 4) outcome.other.push((e && e.name) + ": " + (e && e.message));
    return -1;
  }
}
// The threads are launched together by the parent's Promise.all; overlap is then
// made deterministic by the hold inside the held rounds, not by hoping the
// plain rounds happen to collide.
for (let round = 0; round < cfg.plainRounds; round += 1) {
  if (attempt(() => heartbeatEventTransaction(db, cfg.nodeId, round + 1000)) >= 0) outcome.plain += 1;
}
for (let round = 0; round < cfg.heldRounds; round += 1) {
  const waited = attempt(() => withTransaction(db, () => {
    db.prepare("UPDATE nodes SET updated_at = ? WHERE id = ?").run(Date.now(), cfg.nodeId);
    db.prepare("INSERT INTO events (node_id, type, data, ts) VALUES (?, ?, ?, ?)").run(cfg.nodeId, "phase_change", "{\\"held\\":true}", Date.now());
    if (cfg.holdMs > 0) Atomics.wait(holdSleeper, 0, 0, cfg.holdMs);
  }));
  if (waited >= 0) { outcome.held += 1; outcome.waitedMs.push(waited); }
}
db.close();
parentPort.postMessage(outcome);
`;

interface ThreadOptions {
	file: string;
	nodeId: string;
	plainRounds: number;
	heldRounds: number;
	holdMs: number;
	/** `null` keeps the production busy_timeout; a number overrides it (control run). */
	forceBusyTimeout: number | null;
}

function runThreads(options: readonly ThreadOptions[]): Promise<ThreadOutcome[]> {
	return Promise.all(
		options.map(
			(workerData) =>
				new Promise<ThreadOutcome>((resolve, reject) => {
					const worker = new Worker(WORKER_BODY, {
						eval: true,
						workerData: { ...workerData, srcDb: SRC_DB, contract: CONTRACT },
					});
					worker.once("message", (message: ThreadOutcome) => resolve(message));
					worker.once("error", reject);
				}),
		),
	);
}

function threadOptions(ledger: Ledger, overrides: Partial<ThreadOptions> = {}): ThreadOptions[] {
	return Array.from({ length: THREADS }, (_unused, index) => ({
		file: ledger.file,
		nodeId: `root.sim-${String(index).padStart(2, "0")}`,
		plainRounds: 3,
		heldRounds: 2,
		holdMs: 10,
		forceBusyTimeout: null,
		...overrides,
	}));
}

function summarise(outcomes: readonly ThreadOutcome[]): { busy: number; other: string[]; waits: number[] } {
	const busy = outcomes.reduce((sum, o) => sum + o.busy, 0);
	const other = outcomes.flatMap((o) => o.other);
	const waits = outcomes.flatMap((o) => o.waitedMs);
	return { busy, other, waits };
}

test("every connection to a WAL ledger honours busy_timeout (M2-(g) preconditions)", () => {
	const ledger = freshLedger("preconditions");
	const connections = Array.from({ length: THREADS + 1 }, () => openLegionDb(ledger.file));
	try {
		for (const [index, db] of connections.entries()) {
			assert.equal(
				db.prepare("PRAGMA journal_mode").get()?.journal_mode,
				LEGION_DB_REQUIRED_JOURNAL_MODE,
				`connection ${index} is not on WAL`,
			);
			assert.equal(
				Number(db.prepare("PRAGMA busy_timeout").get()?.timeout),
				LEGION_DB_BUSY_TIMEOUT_MS,
				`connection ${index} does not carry the contract busy timeout`,
			);
		}
	} finally {
		for (const db of connections) db.close();
		ledger.cleanup();
	}
});

/**
 * The control that makes "zero busy failures" mean something: identical workload,
 * identical overlap, but the busy handler disabled. If this does not produce busy
 * failures, the harness is not creating contention and test (3) is vacuous.
 */
test("control: the same concurrent workload fails on SQLITE_BUSY with busy_timeout disabled", async () => {
	const ledger = freshLedger("control");
	try {
		const outcomes = await runThreads(threadOptions(ledger, { forceBusyTimeout: 0 }));
		const { busy } = summarise(outcomes);
		assert.ok(
			busy > 0,
			`expected SQLITE_BUSY with busy_timeout=0 and ${THREADS} overlapping writers, got none — the harness is not producing contention`,
		);
	} finally {
		ledger.cleanup();
	}
});

/**
 * A blocked writer must queue behind the holder instead of failing, and must
 * return inside the 5 s budget — the behaviour that keeps a real run's busy count
 * near zero.
 */
test("a writer blocked by another connection's open transaction waits and then succeeds", async () => {
	const ledger = freshLedger("waits");
	const holdMs = 120;
	try {
		const outcomes = await runThreads(
			threadOptions(ledger, { plainRounds: 0, heldRounds: 1, holdMs }),
		);
		const { busy, other, waits } = summarise(outcomes);
		assert.deepEqual(other, []);
		assert.equal(busy, 0, "no writer may fail while the holder is inside the 5s budget");

		const committed = outcomes.reduce((sum, o) => sum + o.held, 0);
		assert.equal(committed, THREADS, "every blocked writer must eventually commit");

		// At least one writer must have queued behind another (8 writers serialise on
		// one lock, so all but the first pay a hold), and none may have exceeded budget.
		const queued = waits.filter((w) => w >= holdMs * 0.5);
		assert.ok(queued.length > 0, `no writer waited ≥${holdMs * 0.5}ms: waits were ${waits.map((w) => w.toFixed(1)).join(", ")}`);
		const longest = Math.max(...waits);
		assert.ok(
			longest < LEGION_DB_BUSY_TIMEOUT_MS,
			`a writer waited ${longest.toFixed(1)}ms, beyond the ${LEGION_DB_BUSY_TIMEOUT_MS}ms budget`,
		);
	} finally {
		ledger.cleanup();
	}
});

/**
 * Real concurrency, postman-shaped transactions, production timeouts: zero busy
 * failures and every row durable. This is the fast analogue of the driver's
 * offered load.
 */
test(`${THREADS} concurrent writers commit every heartbeat/event transaction with zero busy failures`, async () => {
	const ledger = freshLedger("interleaved");
	try {
		const outcomes = await runThreads(threadOptions(ledger));
		const { busy, other } = summarise(outcomes);
		assert.deepEqual(other, [], "no transaction may fail for a non-busy reason");
		assert.equal(busy, 0, `no transaction may fail on SQLITE_BUSY (busy_timeout=${LEGION_DB_BUSY_TIMEOUT_MS}ms)`);
		for (const outcome of outcomes) {
			assert.equal(outcome.plain, 3, "every plain heartbeat transaction must commit");
			assert.equal(outcome.held, 2, "every lock-holding transaction must commit");
			assert.equal(outcome.journalMode, LEGION_DB_REQUIRED_JOURNAL_MODE);
			assert.equal(outcome.busyTimeout, LEGION_DB_BUSY_TIMEOUT_MS);
		}

		// The writes are real: one event row per transaction that inserted one.
		const db = openLegionDb(ledger.file);
		try {
			const rows = db.prepare("SELECT COUNT(*) AS n FROM events").get();
			assert.equal(Number(rows?.n), THREADS * (3 + 2), "every committed transaction must leave its event row");
		} finally {
			db.close();
		}
	} finally {
		ledger.cleanup();
	}
});

/**
 * The classifier is the only thing between "0 busy failures" and a meaningless
 * number, so pin that it does not sweep up unrelated errors.
 */
test("busy-error classification separates SQLITE_BUSY from real failures", () => {
	const busy = Object.assign(new Error("database is locked"), { code: "ERR_SQLITE_ERROR", errcode: 5 });
	assert.equal(isBusyError(busy), true);
	assert.equal(isBusyError(new Error("database is locked")), true);
	assert.equal(isBusyError(Object.assign(new Error("database table is locked"), { errcode: 6 })), true);
	assert.equal(isBusyError(new Error("UNIQUE constraint failed: nodes.id")), false);
	assert.equal(isBusyError(new Error("no such table: events")), false);
	assert.equal(isBusyError(new TypeError("dbPath must be a non-empty path")), false);
	assert.equal(isBusyError(undefined), false);
});
