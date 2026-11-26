/**
 * #456 — reclaiming an orphaned row whose terminal over there is already over.
 *
 * The module under test answers ONE question per leftover (is the program in that
 * terminal still running?) and writes three facts when — and only when — the
 * answer is a FACT: `terminal-gone` settles the row without killing anything,
 * `stale-orphan` kills the kept terminal first, and `working`/`unknown` settle
 * nothing at all.
 *
 * Everything here is behavioural and seam-injected: the terminal probe, the
 * transcript line counter, the transcript read-back and the kill are all stubs,
 * so no test reaches `hc`, the network or `$HOME`. The only real pieces are the
 * run store (`run.json`) and the sqlite ledger, which are the two things the
 * reclaim actually mutates — asserting against fakes there would prove nothing.
 *
 * A refusal must leave BOTH surfaces untouched: a row that says "cleaned up"
 * while the process still runs is worse than a row left visible.
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { legionDbPath, openLegionDb, type DatabaseSync } from "../../src/legion/db.ts";
import { appendEvent, readEventsAfter } from "../../src/legion/events.ts";
import { getNode, insertNode } from "../../src/legion/nodes.ts";
import { getUsage } from "../../src/legion/usage.ts";
import {
	findOrphanedRecordsInStore,
	inspectOrphan,
	isOrphanedRecord,
	orphanOwnerGate,
	orphanSubjectFor,
	reclaimOrphan,
	type OrphanEvidence,
	type OrphanSubject,
} from "../../src/runs/orphan-reclaim.ts";
import type { RemoteReadbackResult, RemoteSessionRequest, RemoteTerminalProbe } from "../../src/runs/remote-artifact.ts";
import { RunStore } from "../../src/runs/store.ts";
import type { ChildRecord, TaskState } from "../../src/shared/types.ts";
import { assistantMsg, modelChange, sessionHeader, userMsg } from "../helpers/fixtures.ts";

const HOST = "njbox";
const TERMINAL = `${HOST}/t2`;
const REMOTE_DIR = "/srv/.pi-subagents-mirror/r-fixture/worker-0";
const REMOTE_SESSION = `${REMOTE_DIR}/session.jsonl`;
/** A dead pid: nothing listens there, so the real `isPidAlive` says "gone". */
const DEAD_PID = 2_147_483_000;
const NOW = 1_700_000_000_000;
const SESSION = "/tmp/pi-legion-456-session/w.jsonl";
const CHILD_NODE = "root.worker-0";

// ── fixtures ────────────────────────────────────────────────────────────────

function tempRoot(): string {
	return mkdtempSync(path.join(tmpdir(), "orphan-reclaim-unit-"));
}

/** A cross-machine child record still carrying the exit's `orphaned` marker. */
function childRecord(over: Partial<ChildRecord> = {}): ChildRecord {
	return {
		name: "worker-0",
		sessionFile: SESSION,
		ownerToken: "tok-456",
		state: "orphaned",
		spawnedAt: new Date(NOW - 120_000).toISOString(),
		host: HOST,
		remoteDir: REMOTE_DIR,
		remoteTerminal: TERMINAL,
		nodeId: CHILD_NODE,
		orphaned: {
			at: NOW - 60_000,
			fate: "orphaned",
			reason: "session-shutdown",
			host: HOST,
			remoteDir: REMOTE_DIR,
			remoteTerminal: TERMINAL,
		},
		...over,
	};
}

function subjectOf(over: Partial<OrphanSubject> = {}): OrphanSubject {
	return {
		storeRoot: "/tmp/pi-legion-456-store",
		runId: "r-fixture",
		runDir: "/tmp/pi-legion-456-store/runs/r-fixture",
		name: "worker-0",
		nodeId: CHILD_NODE,
		host: HOST,
		remoteDir: REMOTE_DIR,
		remoteTerminal: TERMINAL,
		recordState: "orphaned",
		...over,
	};
}

/** The core's answer, complete enough that every branch reads only what it needs. */
function probeOf(over: Partial<RemoteTerminalProbe> = {}): RemoteTerminalProbe {
	return { address: TERMINAL, state: "live", live: true, ...over };
}

interface LineCounter {
	/** Every request the inspection made (empty ⇒ the transcript was never asked for). */
	seen: Array<{ host: string; remotePath: string }>;
	lines: (request: { host: string; remotePath: string }) => Promise<number | undefined>;
}

/** A transcript line counter that answers from `samples` in order (last one repeats). */
function lineCounter(...samples: Array<number | undefined>): LineCounter {
	const seen: LineCounter["seen"] = [];
	return {
		seen,
		lines: async (request) => {
			const index = seen.length;
			seen.push(request);
			return samples[Math.min(index, samples.length - 1)];
		},
	};
}

/** A finished child transcript: session header, one turn, a machine-readable verdict. */
function transcript(): string[] {
	return [
		sessionHeader(),
		modelChange("test/glm-5.3-flash"),
		userMsg("reclaim me", { timestamp: 1 }),
		assistantMsg({
			text: "settled the leftover\n{\"ok\": true}",
			usage: { input: 100, output: 20, cacheRead: 5, cacheWrite: 0, cost: { total: 0.01 } },
			timestamp: 2,
		}),
	];
}

interface GradingReadback {
	requests: RemoteSessionRequest[];
	readback: (request: RemoteSessionRequest) => Promise<RemoteReadbackResult>;
}

/** A read-back that lands a REAL transcript file, so grading runs the production ladder. */
function gradingReadback(lines: string[] = transcript()): GradingReadback {
	const requests: RemoteSessionRequest[] = [];
	return {
		requests,
		readback: async (request) => {
			requests.push(request);
			mkdirSync(path.dirname(request.localPath), { recursive: true });
			writeFileSync(request.localPath, `${lines.join("\n")}\n`, "utf8");
			return {
				ok: true,
				host: request.host,
				localPath: request.localPath,
				remotePath: REMOTE_SESSION,
				lines: lines.length,
				returned: lines.length,
				truncated: false,
				byteCapped: false,
			};
		},
	};
}

/** The "the transcript could not be read" answer (no local file is written). */
function failingReadback(reason = "the machine did not answer"): (request: RemoteSessionRequest) => Promise<RemoteReadbackResult> {
	return async () => ({ ok: false, host: HOST, reason, fate: "unreachable", evidence: [], nextStep: "retry later" });
}

interface LogCapture {
	lines: string[];
	log: (line: string) => void;
}

function logCapture(): LogCapture {
	const lines: string[] = [];
	return { lines, log: (line) => lines.push(line) };
}

interface OrphanFixture {
	store: RunStore;
	runId: string;
	runDir: string;
	dbPath: string;
	subject: OrphanSubject;
}

/**
 * A real store + (optionally) a real ledger holding one orphaned `worker-0`:
 * `root` at ledger status `running`, the child row `running`, and the exit's
 * `orphan_detected` marker — exactly what the release machine had.
 */
async function seedOrphanStore(root: string, opts: { ledger?: boolean } = {}): Promise<OrphanFixture> {
	const store = new RunStore({ rootDir: root });
	const run = store.createRun({ task: "#456 reclaim fixture", cwd: root, sessionFile: SESSION });
	await store.addChild(run.runId, childRecord());
	const runDir = store.runDir(run.runId);
	const dbPath = legionDbPath(runDir);
	if (opts.ledger !== false) {
		const db = openLegionDb(dbPath);
		try {
			insertNode(db, { parentId: null, name: "root", role: "root", runId: run.runId }, () => NOW - 1_000);
			insertNode(
				db,
				{
					parentId: "root",
					name: "worker-0",
					role: "worker",
					status: "running",
					host: HOST,
					remoteDir: REMOTE_DIR,
					remoteTerminal: TERMINAL,
					runId: run.runId,
				},
				() => NOW - 900,
			);
			appendEvent(db, CHILD_NODE, "orphan_detected", { reason: "session-shutdown", host: HOST }, { now: () => NOW - 500 });
		} finally {
			db.close();
		}
	}
	const record = store.findChild(run.runId, "worker-0");
	assert.ok(record, "the seeded child must be readable from run.json");
	const subject = orphanSubjectFor({ storeRoot: root, runId: run.runId, runDir, run, child: record });
	assert.equal(subject.name, "worker-0");
	return { store, runId: run.runId, runDir, dbPath, subject };
}

function withDb<T>(dbPath: string, fn: (db: DatabaseSync) => T): T {
	const db = openLegionDb(dbPath);
	try {
		return fn(db);
	} finally {
		db.close();
	}
}

function nodeStatus(dbPath: string): string | undefined {
	return withDb(dbPath, (db) => getNode(db, CHILD_NODE)?.status);
}

function eventCount(dbPath: string): number {
	return withDb(dbPath, (db) => Number(db.prepare("SELECT COUNT(*) AS n FROM events").get()?.n ?? 0));
}

function nodeEvents(dbPath: string, type: string): Array<Record<string, unknown>> {
	return withDb(dbPath, (db) =>
		readEventsAfter(db, 0, { nodeId: CHILD_NODE })
			.filter((event) => event.type === type)
			.map((event) => (event.data ?? {}) as Record<string, unknown>),
	);
}

// ── inspection ──────────────────────────────────────────────────────────────

test("#456: a finished terminal is terminal-gone, and the transcript is never sampled", async () => {
	const counter = lineCounter(4, 4);
	const evidence = await inspectOrphan(subjectOf(), {
		probeTerminal: async () => probeOf({ state: "finished", live: false, exitCode: 1 }),
		remoteLines: counter.lines,
	});

	assert.equal(evidence.verdict, "terminal-gone");
	assert.match(evidence.evidence, new RegExp(`terminal '${TERMINAL}' is finished on '${HOST}' \\(exit 1\\)`));
	assert.equal(evidence.terminal?.state, "finished");
	assert.equal(evidence.terminal?.exitCode, 1);
	assert.equal(counter.seen.length, 0, "a gone terminal is a fact about the terminal: no growth sampling is needed");
});

test("#456: a terminal the machine no longer holds is terminal-gone too", async () => {
	const counter = lineCounter(4, 4);
	const evidence = await inspectOrphan(subjectOf(), {
		probeTerminal: async () => probeOf({ state: "missing", live: false }),
		remoteLines: counter.lines,
	});

	assert.equal(evidence.verdict, "terminal-gone");
	assert.match(evidence.evidence, /no longer holds terminal/);
	assert.match(evidence.evidence, new RegExp(TERMINAL));
	assert.equal(counter.seen.length, 0);
});

test("#456: an inferred spelling the core does not hold is NOT proof the child ended", async () => {
	// The record recorded no terminal address, so the probe asked about
	// `host/lgl-<name>`. A core that never held that spelling says nothing about the
	// child — the core may simply hold a different name (reattach.ts's guard).
	const counter = lineCounter(4, 4);
	const evidence = await inspectOrphan(subjectOf({ remoteTerminal: undefined, remoteDir: undefined }), {
		probeTerminal: async () => probeOf({ address: `${HOST}/lgl-worker-0`, state: "missing", live: false }),
		remoteLines: counter.lines,
	});

	assert.equal(evidence.verdict, "unknown", "an inferred miss must never settle the row");
	assert.match(evidence.evidence, /no terminal address was recorded/);
	assert.match(evidence.evidence, /not proof the child ended/);
	assert.equal(counter.seen.length, 0);
});

test("#456: a machine that could not be asked answers unknown, never terminal-gone", async () => {
	const counter = lineCounter(4, 4);
	const evidence = await inspectOrphan(subjectOf(), {
		probeTerminal: async () => probeOf({ state: "unknown", live: false, unreachable: "boom" }),
		remoteLines: counter.lines,
	});

	assert.equal(evidence.verdict, "unknown");
	assert.match(evidence.evidence, /^no liveness evidence/);
	assert.match(evidence.evidence, /boom/);
	assert.match(String(evidence.terminal?.unreachable), /boom/, "the terminal keeps the machine's own reason for not answering");
	assert.equal(counter.seen.length, 0);
});

test("#456: a program that says it is working is left alone", async () => {
	const counter = lineCounter(4, 7);
	const evidence = await inspectOrphan(subjectOf(), {
		probeTerminal: async () => probeOf({ state: "live", live: true, program: "working" }),
		remoteLines: counter.lines,
	});

	assert.equal(evidence.verdict, "working");
	assert.match(evidence.evidence, /is live and its program is 'working'/);
	assert.equal(counter.seen.length, 0, "a working program needs no transcript sample");
});

test("#456: a recorded end (finished_ms/reason) with no exit code is still an end, not unknown", async () => {
	// `probe.live === false` is `terminalProgramEnd`'s answer, which also covers
	// finished_ms/reason ends that carry no exit code and no program word. Calling
	// that unknown would keep a finished leftover forever (review F6).
	const counter = lineCounter(4, 4);
	const evidence = await inspectOrphan(subjectOf(), {
		probeTerminal: async () => probeOf({ state: "live", live: false }),
		remoteLines: counter.lines,
		growthWaitMs: 250,
	});

	assert.equal(evidence.verdict, "stale-orphan");
	assert.match(evidence.evidence, /did not grow \(4 → 4 lines/);
	assert.deepEqual(counter.seen, [
		{ host: HOST, remotePath: REMOTE_SESSION },
		{ host: HOST, remotePath: REMOTE_SESSION },
	]);
});

test("#456: an alive terminal whose idle program wrote nothing more is a stale orphan", async () => {
	const counter = lineCounter(4, 4);
	const evidence = await inspectOrphan(subjectOf(), {
		probeTerminal: async () => probeOf({ state: "live", live: true, program: "idle" }),
		remoteLines: counter.lines,
		growthWaitMs: 0, // clamped up to the module's floor; the sample spacing is behavioural
	});

	assert.equal(evidence.verdict, "stale-orphan");
	const samples = evidence.samples;
	assert.ok(samples, "a stale verdict must carry the numbers it rested on");
	assert.equal(samples.first, 4);
	assert.equal(samples.second, 4);
	assert.equal(samples.remotePath, REMOTE_SESSION);
	assert.ok(samples.waitMs >= 250 && samples.waitMs <= 1_200, `waitMs out of bounds: ${samples.waitMs}`);
	assert.equal(counter.seen.length, 2);
	assert.deepEqual(counter.seen[0], { host: HOST, remotePath: REMOTE_SESSION });
	assert.match(evidence.evidence, /did not grow \(4 → 4 lines/);
});

test("#456: a transcript that grew between the two samples is still being written", async () => {
	const counter = lineCounter(4, 7);
	const evidence = await inspectOrphan(subjectOf(), {
		probeTerminal: async () => probeOf({ state: "live", live: true, program: "idle" }),
		remoteLines: counter.lines,
		growthWaitMs: 0,
	});

	assert.equal(evidence.verdict, "working");
	assert.match(evidence.evidence, /growing/);
	assert.equal(evidence.samples?.first, 4);
	assert.equal(evidence.samples?.second, 7);
	assert.equal(counter.seen.length, 2);
});

test("#456: two samples that cannot be taken (or that shrank) are unknown, and unknown cleans nothing", async () => {
	const probe = async () => probeOf({ state: "live", live: true, program: "idle" });
	const root = tempRoot();
	try {
		const firstMissing = await inspectOrphan(subjectOf(), { probeTerminal: probe, remoteLines: lineCounter(undefined).lines, growthWaitMs: 0 });
		assert.equal(firstMissing.verdict, "unknown");
		assert.match(firstMissing.evidence, /first sample failed/);

		const secondMissing = await inspectOrphan(subjectOf(), { probeTerminal: probe, remoteLines: lineCounter(4, undefined).lines, growthWaitMs: 0 });
		assert.equal(secondMissing.verdict, "unknown");
		assert.match(secondMissing.evidence, /second sample failed/);

		const shrinking = await inspectOrphan(subjectOf(), { probeTerminal: probe, remoteLines: lineCounter(7, 5).lines, growthWaitMs: 0 });
		assert.equal(shrinking.verdict, "unknown");
		assert.match(shrinking.evidence, /shrank \(7 → 5 lines/);

		// No cleanup is reachable from `unknown`: every one of them is refused, with
		// no kill, no read-back and both surfaces still saying `running`/`orphaned`.
		const fixture = await seedOrphanStore(root);
		const log = logCapture();
		const killCalls: string[] = [];
		const readback = gradingReadback();
		for (const unknown of [firstMissing, secondMissing, shrinking]) {
			const result = await reclaimOrphan(fixture.subject, unknown, {
				store: fixture.store,
				readback: readback.readback,
				killTerminal: async (address) => {
					killCalls.push(address);
					return { ok: true };
				},
				log: log.log,
				now: () => NOW,
				pid: 4_242,
			});
			assert.equal(result.ok, false);
			assert.equal(result.verdict, "unknown");
			assert.match(log.lines.at(-1) ?? "", /refused/);
		}
		assert.equal(killCalls.length, 0);
		assert.equal(readback.requests.length, 0);
		assert.equal(nodeStatus(fixture.dbPath), "running");
		assert.equal(fixture.store.findChild(fixture.runId, "worker-0")?.state, "orphaned");
		assert.equal(nodeEvents(fixture.dbPath, "node_settled").length, 0);
		assert.equal(nodeEvents(fixture.dbPath, "node_retired").length, 0);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("#456: an idle terminal with no recorded remote_dir has no transcript to check", async () => {
	const counter = lineCounter(4, 4);
	const evidence = await inspectOrphan(subjectOf({ remoteDir: undefined }), {
		probeTerminal: async () => probeOf({ state: "live", live: true, program: "idle" }),
		remoteLines: counter.lines,
	});

	assert.equal(evidence.verdict, "unknown");
	assert.match(evidence.evidence, /no remote_dir/);
	assert.equal(counter.seen.length, 0);
});

// ── the owner gate ──────────────────────────────────────────────────────────

test("#456: another live session's row is gated, this process's own pid and a dead pid are not", () => {
	const held = orphanOwnerGate(
		subjectOf({ ownerPid: 9_999, ownerSessionFile: "/home/someone/.pi/sessions/abc.jsonl" }),
		{ pid: 4_242, alive: () => true },
	);
	assert.ok(held, "a live foreign pid must gate the reclaim");
	assert.equal(held.name, "worker-0");
	assert.equal(held.host, HOST);
	assert.match(held.reason, /owned by .*pid .* is alive/);
	assert.match(held.reason, /abc\.jsonl/, "the gate names the session file that holds the child");
	assert.match(held.reason, /pid 9999/, "and the pid a human can check");
	// No session file recorded: the reason falls back to naming the pid.
	const pidOnly = orphanOwnerGate(subjectOf({ ownerPid: 9_999, ownerSessionFile: undefined }), { pid: 4_242, alive: () => true });
	assert.ok(pidOnly);
	assert.match(pidOnly.reason, /owned by pid 9999 .* is alive/);

	assert.equal(orphanOwnerGate(subjectOf({ ownerPid: process.pid })), undefined, "our own pid is not a foreign owner (default pid = this process)");
	assert.equal(orphanOwnerGate(subjectOf({ ownerPid: process.pid }), { pid: process.pid }), undefined, "our own pid is not a foreign owner");
	// The default `alive` is the real `isPidAlive`; a pid that cannot exist is gone.
	assert.equal(orphanOwnerGate(subjectOf({ ownerPid: DEAD_PID }), { pid: 4_242 }), undefined, "a dead owner must not block the reclaim");
	assert.equal(orphanOwnerGate(subjectOf({ ownerPid: undefined }), { pid: 4_242 }), undefined, "no recorded owner is not a claim on the row");

	// A marker written on ANOTHER host cannot be checked from here (ownerState's
	// rule): it stays live even when the pid happens to be gone locally.
	const foreignHost = orphanOwnerGate(
		subjectOf({ ownerPid: 9_999, ownerHost: "otherbox" }),
		{ pid: 4_242, hostname: HOST, alive: () => false },
	);
	assert.ok(foreignHost, "a foreign-host owner must gate the reclaim");
	assert.match(foreignHost.reason, /on host 'otherbox'/);
	assert.match(foreignHost.reason, /cannot be checked from 'njbox'/);
	// Same host: the pid decides, as before.
	assert.equal(
		orphanOwnerGate(subjectOf({ ownerPid: 9_999, ownerHost: HOST }), { pid: 4_242, hostname: HOST, alive: () => false }),
		undefined,
		"a dead pid on this host is not a claim on the row",
	);
});

// ── discovery ───────────────────────────────────────────────────────────────

test("#456: discovery finds every orphaned leftover in a store, newest run first, and honours its scope", async () => {
	const root = tempRoot();
	try {
		const clock = { at: NOW - 60_000 };
		const store = new RunStore({ rootDir: root, now: () => clock.at });
		const older = store.createRun({ task: "yesterday's run", cwd: root });
		clock.at += 60_000;
		const newer = store.createRun({ task: "this run", cwd: root });

		const orphaned = childRecord({ name: "worker-0" });
		const unfetched = childRecord({ name: "unfetched-1", state: "unfetched", orphaned: undefined });
		const marked = childRecord({ name: "marked-1", state: "working" });
		// Terminal states are history, not leftovers — including the two spellings only
		// a hand-edited/legacy run.json can carry (`failed`/`settled`).
		const retired = childRecord({ name: "retired-1", state: "retired" });
		const exited = childRecord({ name: "exited-1", state: "exited" });
		const failed = childRecord({ name: "failed-1", state: "failed" as TaskState });
		const settled = childRecord({ name: "settled-1", state: "settled" as TaskState });
		// A local record (no host) is not a cross-machine leftover.
		const local = childRecord({ name: "local-1", host: undefined, remoteDir: undefined, remoteTerminal: undefined });

		for (const record of [orphaned, unfetched, marked, retired, exited, failed, settled, local]) {
			await store.addChild(older.runId, record);
		}
		await store.addChild(newer.runId, childRecord({ name: "worker-0" }));

		// The predicate itself: two spellings in, terminal states and local rows out.
		assert.equal(isOrphanedRecord(orphaned), true);
		assert.equal(isOrphanedRecord(unfetched), true);
		assert.equal(isOrphanedRecord(marked), true, "the exit's marker alone makes a non-terminal record a leftover");
		for (const terminal of [retired, exited, failed, settled]) {
			assert.equal(isOrphanedRecord(terminal), false, `${terminal.state} is history, not a leftover`);
		}
		assert.equal(isOrphanedRecord(local), false, "a record with no host never ran elsewhere");

		const all = findOrphanedRecordsInStore(store);
		assert.deepEqual(
			all.map((row) => `${row.run.runId}/${row.child.name}`),
			[`${newer.runId}/worker-0`, `${older.runId}/worker-0`, `${older.runId}/unfetched-1`, `${older.runId}/marked-1`],
			"newest run first, and only the leftovers",
		);
		assert.ok(all[0]!.run.createdAt > all[1]!.run.createdAt, "ordering is by run createdAt, not directory order");
		assert.equal(all[0]!.subject.storeRoot, root);
		assert.equal(all[0]!.subject.runDir, store.runDir(newer.runId));
		assert.equal(all[0]!.subject.host, HOST);
		assert.equal(all[0]!.subject.remoteTerminal, TERMINAL);
		assert.equal(all[0]!.subject.recordState, "orphaned");
		assert.deepEqual(findOrphanedRecordsInStore(store, { name: "unfetched-1" }).map((row) => row.child.name), ["unfetched-1"]);
		assert.deepEqual(
			findOrphanedRecordsInStore(store, { runId: older.runId }).map((row) => row.child.name),
			["worker-0", "unfetched-1", "marked-1"],
			"a runId scope must not be widened to the other run",
		);
		assert.deepEqual(
			findOrphanedRecordsInStore(store, { runId: older.runId, name: "worker-0" }).map((row) => `${row.run.runId}/${row.child.name}`),
			[`${older.runId}/worker-0`],
			"a name AND a runId narrow to one row, never to the newer run's same handle",
		);
		assert.deepEqual(findOrphanedRecordsInStore(store, { runId: "r-missing" }), []);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

// ── reclaim ─────────────────────────────────────────────────────────────────

test("#456: terminal-gone with a graded transcript settles the ledger and retires the record", async () => {
	const root = tempRoot();
	try {
		const fixture = await seedOrphanStore(root);
		const readback = gradingReadback();
		const log = logCapture();
		const evidence: OrphanEvidence = {
			verdict: "terminal-gone",
			evidence: `terminal '${TERMINAL}' is finished on '${HOST}' (exit 0)`,
			terminal: { address: TERMINAL, state: "finished", exitCode: 0 },
		};

		const result = await reclaimOrphan(fixture.subject, evidence, {
			store: fixture.store,
			readback: readback.readback,
			killTerminal: async () => {
				throw new Error("a gone terminal must never be killed");
			},
			log: log.log,
			now: () => NOW,
			sessionFile: SESSION,
			pid: 4_242,
		});

		assert.equal(result.ok, true);
		if (!result.ok) return; // narrowing for the reader; the assert above is the verdict
		assert.equal(result.verdict, "terminal-gone");
		assert.equal(result.ledgerStatus, "settled");
		assert.equal(result.execution?.status, "success");
		assert.equal(result.acceptance?.status, "accepted");

		// The read-back was addressed as the record says, to a local mirror.
		assert.equal(readback.requests.length, 1);
		assert.equal(readback.requests[0]!.host, HOST);
		assert.equal(readback.requests[0]!.remoteDir, REMOTE_DIR);
		assert.equal(readback.requests[0]!.remoteTerminal, TERMINAL);
		assert.equal(path.dirname(readback.requests[0]!.localPath), path.join(fixture.runDir, "remote"));

		// Ledger: the row ends exactly as a collect would end it.
		assert.equal(nodeStatus(fixture.dbPath), "settled");
		const settled = nodeEvents(fixture.dbPath, "node_settled");
		assert.equal(settled.length, 1);
		const data = settled[0]!;
		assert.equal(data.reason, "terminal-gone", "the event carries the verdict as its reason");
		assert.equal(data.reclaimed, true);
		assert.equal(data.reclaimedFrom, "orphaned");
		assert.equal(data.execution, "success");
		assert.equal(data.host, HOST);
		assert.equal(data.remoteTerminal, TERMINAL);
		assert.match(String(data.evidence), /finished/);
		const usage = withDb(fixture.dbPath, (db) => getUsage(db, CHILD_NODE));
		assert.ok(usage, "a graded reclaim must write the usage row it graded");
		assert.equal(usage.tokensIn, 105, "input + cacheRead + cacheWrite");
		assert.equal(usage.tokensOut, 20);
		assert.equal(usage.costUsd, 0.01);

		// run.json: retired, marker dropped, who/when/evidence stamped, outcome preserved.
		const record = fixture.store.findChild(fixture.runId, "worker-0");
		assert.ok(record);
		assert.equal(record.state, "retired");
		assert.ok(record.retiredAt, "retiredAt must be stamped");
		assert.equal(Number.isNaN(Date.parse(record.retiredAt)), false);
		assert.equal(record.orphaned, undefined, "the exit's orphaned marker must be gone");
		assert.equal(record.execution?.status, "success");
		assert.equal(record.acceptance?.status, "accepted");
		assert.equal(record.reclaimed?.verdict, "terminal-gone");
		assert.equal(record.reclaimed?.evidence, evidence.evidence);
		assert.equal(record.reclaimed?.ledgerStatus, "settled");
		assert.equal(record.reclaimed?.sessionFile, SESSION);
		assert.equal(record.reclaimed?.at, NOW);

		// The diagnostic line names the same facts, and the ISO time it was written.
		assert.equal(log.lines.length, 1);
		const line = log.lines[0]!;
		assert.match(line, new RegExp(`^${new Date(NOW).toISOString()} reclaimed `));
		assert.match(line, /name=worker-0/);
		assert.match(line, new RegExp(`run=${fixture.runId}`));
		assert.match(line, new RegExp(`host=${HOST}`));
		assert.match(line, new RegExp(`terminal=${TERMINAL}`));
		assert.match(line, /verdict=terminal-gone/);
		assert.match(line, /evidence="/);
		assert.match(line, /ledger=settled/);
		assert.match(line, new RegExp(`by=session:${SESSION}`));
		assert.match(line, /pid=4242/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("#456: an unreadable transcript retires the ledger row, and a second reclaim is a no-op settle", async () => {
	const root = tempRoot();
	try {
		const fixture = await seedOrphanStore(root);
		const log = logCapture();
		const evidence: OrphanEvidence = {
			verdict: "terminal-gone",
			evidence: `the machine no longer holds terminal '${TERMINAL}'`,
			terminal: { address: TERMINAL, state: "missing" },
		};
		const options = {
			store: fixture.store,
			readback: failingReadback(),
			killTerminal: async () => ({ ok: true as const }),
			log: log.log,
			now: () => NOW,
			sessionFile: SESSION,
			pid: 4_242,
		};

		const first = await reclaimOrphan(fixture.subject, evidence, options);
		assert.equal(first.ok, true);
		if (!first.ok) return;
		assert.equal(first.verdict, "terminal-gone");
		assert.equal(first.ledgerStatus, "retired", "an ungraded transcript retires instead of settling");
		assert.equal(first.execution, undefined);

		assert.equal(nodeStatus(fixture.dbPath), "retired");
		const retired = nodeEvents(fixture.dbPath, "node_retired");
		assert.equal(retired.length, 1);
		assert.equal(retired[0]!.execution, "unknown");
		assert.equal(retired[0]!.reason, "terminal-gone");
		assert.equal(retired[0]!.reclaimed, true);
		const record = fixture.store.findChild(fixture.runId, "worker-0");
		assert.equal(record?.state, "retired");
		assert.equal(record?.execution, undefined, "nothing was graded, so nothing is claimed");
		assert.equal(record?.orphaned, undefined);

		// A later session finds the same leftover again (the record is re-orphaned by
		// another exit): the ledger must not gain a second ending, and the record is
		// still cleaned.
		const before = eventCount(fixture.dbPath);
		await fixture.store.updateChild(fixture.runId, "worker-0", (child) => {
			child.state = "orphaned";
			child.orphaned = { at: NOW, fate: "orphaned", reason: "session-shutdown", host: HOST };
		});

		const second = await reclaimOrphan(fixture.subject, evidence, options);
		assert.equal(second.ok, true);
		if (!second.ok) return;
		assert.equal(second.ledgerStatus, "already-ended");
		assert.equal(eventCount(fixture.dbPath), before, "an already-ended row must not gain a duplicate settle event");
		assert.equal(nodeStatus(fixture.dbPath), "retired");
		const again = fixture.store.findChild(fixture.runId, "worker-0");
		assert.equal(again?.state, "retired", "the re-orphaned record is still cleaned");
		assert.equal(again?.orphaned, undefined);
		assert.equal(again?.reclaimed?.ledgerStatus, "already-ended");
		assert.match(log.lines.at(-1) ?? "", /ledger=already-ended/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("#456: a stale orphan kills the kept terminal first, then settles on the graded transcript", async () => {
	const root = tempRoot();
	try {
		const fixture = await seedOrphanStore(root);
		const counter = lineCounter(4, 4);
		const evidence = await inspectOrphan(fixture.subject, {
			probeTerminal: async () => probeOf({ state: "live", live: true, program: "idle" }),
			remoteLines: counter.lines,
			growthWaitMs: 0,
		});
		assert.equal(evidence.verdict, "stale-orphan");
		const readback = gradingReadback();
		const kills: string[] = [];
		const log = logCapture();

		const result = await reclaimOrphan(fixture.subject, evidence, {
			store: fixture.store,
			readback: readback.readback,
			killTerminal: async (address) => {
				kills.push(address);
				return { ok: true };
			},
			log: log.log,
			now: () => NOW,
			sessionFile: SESSION,
			pid: 4_242,
		});

		assert.equal(result.ok, true);
		if (!result.ok) return;
		assert.equal(result.killed, true);
		assert.equal(result.verdict, "stale-orphan");
		assert.equal(result.ledgerStatus, "settled");
		assert.deepEqual(kills, [evidence.terminal?.address], "exactly one kill, at the address the probe reported");
		assert.equal(nodeStatus(fixture.dbPath), "settled");
		const settled = nodeEvents(fixture.dbPath, "node_settled");
		assert.equal(settled.length, 1);
		assert.equal(settled[0]!.reason, "stale-orphan");
		assert.equal(fixture.store.findChild(fixture.runId, "worker-0")?.state, "retired");
		const line = log.lines[0]!;
		assert.match(line, /killed=true/);
		assert.match(line, /verdict=stale-orphan/);
		assert.match(line, /ledger=settled/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("#456: a child adopted between inspection and reclaim is not retired underneath its new session", async () => {
	const root = tempRoot();
	try {
		const fixture = await seedOrphanStore(root);
		// Another session's re-attach adopts the child after our inspection read the
		// record but before we write: the re-read must catch it.
		await fixture.store.updateChild(fixture.runId, "worker-0", (child) => {
			child.state = "working";
			child.reattached = { at: NOW - 1_000, host: HOST } as ChildRecord["reattached"];
			delete child.orphaned;
		});
		const before = eventCount(fixture.dbPath);
		const log = logCapture();
		const result = await reclaimOrphan(
			fixture.subject,
			{ verdict: "terminal-gone", evidence: "terminal is finished", terminal: { address: TERMINAL, state: "finished" } },
			{ store: fixture.store, readback: gradingReadback().readback, killTerminal: async () => ({ ok: true as const }), log: log.log, now: () => NOW },
		);

		assert.equal(result.ok, false);
		if (result.ok) return;
		assert.match(result.reason, /adopted this child while it was being inspected/);
		assert.equal(nodeStatus(fixture.dbPath), "running", "the ledger row must not be settled");
		assert.equal(eventCount(fixture.dbPath), before, "no settle event for an adopted child");
		const record = fixture.store.findChild(fixture.runId, "worker-0");
		assert.equal(record?.state, "working", "the adoption is preserved");
		assert.ok(record?.reattached, "the reattach stamp survives");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("#456: a kill that cannot be delivered is a refusal — the row stays visible", async () => {
	const root = tempRoot();
	try {
		const fixture = await seedOrphanStore(root);
		const evidence: OrphanEvidence = {
			verdict: "stale-orphan",
			evidence: `terminal '${TERMINAL}' is alive but its program is 'idle', and transcript ${REMOTE_SESSION} did not grow (4 → 4 lines in 250ms)`,
			terminal: { address: TERMINAL, state: "live", program: "idle" },
			samples: { remotePath: REMOTE_SESSION, first: 4, second: 4, waitMs: 250 },
		};
		const readback = gradingReadback();
		const log = logCapture();
		const before = eventCount(fixture.dbPath);

		const result = await reclaimOrphan(fixture.subject, evidence, {
			store: fixture.store,
			readback: readback.readback,
			killTerminal: async () => ({ ok: false as const, reason: "nope" }),
			log: log.log,
			now: () => NOW,
			sessionFile: SESSION,
			pid: 4_242,
		});

		assert.equal(result.ok, false);
		if (result.ok) return;
		assert.equal(result.verdict, "stale-orphan");
		assert.match(result.reason, /could not be killed/);
		assert.match(result.reason, /nope/);
		assert.match(result.logLine ?? "", /refused/);
		assert.match(log.lines.at(-1) ?? "", /reason=".*nope/);
		assert.equal(readback.requests.length, 0, "nothing is graded before the kill is delivered");
		assert.equal(nodeStatus(fixture.dbPath), "running", "the ledger row must be untouched");
		assert.equal(eventCount(fixture.dbPath), before, "no settle event for a refused kill");
		const record = fixture.store.findChild(fixture.runId, "worker-0");
		assert.equal(record?.state, "orphaned");
		assert.ok(record?.orphaned, "the orphaned marker must survive a refusal");
		assert.equal(record?.reclaimed, undefined);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("#456: working/unknown evidence refuses without touching the ledger or the record", async () => {
	const root = tempRoot();
	try {
		const fixture = await seedOrphanStore(root);
		const log = logCapture();
		const kills: string[] = [];
		const readback = gradingReadback();
		const before = eventCount(fixture.dbPath);
		const refusals: OrphanEvidence[] = [
			{ verdict: "working", evidence: `terminal '${TERMINAL}' is live and its program is 'working'`, terminal: { address: TERMINAL, state: "live", program: "working" } },
			{ verdict: "unknown", evidence: `no liveness evidence: host '${HOST}' could not be asked (boom)`, terminal: { address: TERMINAL, state: "unknown", unreachable: "boom" } },
		];

		for (const evidence of refusals) {
			const result = await reclaimOrphan(fixture.subject, evidence, {
				store: fixture.store,
				readback: readback.readback,
				killTerminal: async (address) => {
					kills.push(address);
					return { ok: true };
				},
				log: log.log,
				now: () => NOW,
				sessionFile: SESSION,
				pid: 4_242,
			});
			assert.equal(result.ok, false, `a ${evidence.verdict} verdict must never settle`);
			if (result.ok) return;
			assert.equal(result.verdict, evidence.verdict);
			assert.match(result.reason, /nothing was settled/);
			assert.match(result.logLine ?? "", new RegExp(`verdict=${evidence.verdict}`));
			assert.match(result.logLine ?? "", /refused/);
			assert.match(result.logLine ?? "", new RegExp(`by=session:${SESSION}`));
			assert.match(result.logLine ?? "", /pid=4242/);
		}

		assert.equal(kills.length, 0, "no kill from working/unknown");
		assert.equal(readback.requests.length, 0, "no transcript is read from working/unknown");
		assert.equal(log.lines.length, 2, "one refusal line per attempt");
		assert.equal(nodeStatus(fixture.dbPath), "running");
		assert.equal(eventCount(fixture.dbPath), before);
		const record = fixture.store.findChild(fixture.runId, "worker-0");
		assert.equal(record?.state, "orphaned");
		assert.ok(record?.orphaned);
		assert.equal(record?.reclaimed, undefined);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("#456: with no ledger at all the record is still retired, and the answer says ledger=missing", async () => {
	const root = tempRoot();
	try {
		const fixture = await seedOrphanStore(root, { ledger: false });
		assert.equal(existsSync(fixture.dbPath), false, "the fixture must have no legion.db");
		const log = logCapture();
		const readback = gradingReadback();
		const evidence: OrphanEvidence = {
			verdict: "terminal-gone",
			evidence: `terminal '${TERMINAL}' is finished on '${HOST}' (exit 0)`,
			terminal: { address: TERMINAL, state: "finished", exitCode: 0 },
		};

		const result = await reclaimOrphan(fixture.subject, evidence, {
			store: fixture.store,
			readback: readback.readback,
			killTerminal: async () => {
				throw new Error("a gone terminal must never be killed");
			},
			log: log.log,
			now: () => NOW,
			sessionFile: SESSION,
			pid: 4_242,
		});

		assert.equal(result.ok, true, "the rail reads run.json: a missing ledger must not block the reclaim");
		if (!result.ok) return;
		assert.equal(result.ledgerStatus, "missing");
		assert.equal(result.execution?.status, "success");
		const record = fixture.store.findChild(fixture.runId, "worker-0");
		assert.equal(record?.state, "retired");
		assert.equal(record?.orphaned, undefined);
		assert.equal(record?.reclaimed?.ledgerStatus, "missing");
		assert.equal(record?.execution?.status, "success");
		assert.equal(existsSync(fixture.dbPath), false, "a record-only reclaim must not create a ledger");
		const line = log.lines[0]!;
		assert.match(line, /ledger=missing/);
		assert.match(line, /verdict=terminal-gone/);
		assert.match(line, /record=retired/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
