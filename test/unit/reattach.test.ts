/**
 * #445 — session start re-attaches the cross-machine children a previous session
 * left running.
 *
 * The unit half pins the DECISIONS; `test/integration/reattach-live-children.test.ts`
 * pins the same decisions through the real `hc` client (fake core) and the real
 * recovery core, i.e. the path a user gets. Each case names the #445 clause it
 * holds:
 *
 *   1. candidate sources (run store: `working`/`orphaned` leftovers; mirror-only
 *      orphans reported, never adopted);
 *   2. liveness = evidence (`unreachable` is not live, growth is, "the row exists"
 *      is not);
 *   3. never adopted: a settled/retired ROW and a row a live session holds;
 *   4. bounded: 3s per child, 20 candidates, a 5s pass that defers the rest;
 *   5. `subagents.reattachLiveChildren: false`;
 *   6. one summary line, detail in the log;
 *   7. the `notifiedAt` latch: a delivered notice is never announced twice, and an
 *      undelivered one is still owed after a restart.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { loadSubagentSettings } from "../../src/agents/settings.ts";
import { legionDbPath, openLegionDb } from "../../src/legion/db.ts";
import { getNode, insertNode, updateNode } from "../../src/legion/nodes.ts";
import { RUN_OWNER_FILE, writeOwnerFile } from "../../src/runs/owner.ts";
import type { RemoteTerminalProbe } from "../../src/runs/remote-artifact.ts";
import {
	alreadyNotified,
	discoverReattachCandidates,
	formatReattachSummary,
	type ReattachWatchTarget,
	ReattachWatcher,
	type RemoteLineCount,
	ledgerGate,
	ownerGate,
	pendingReattachNotices,
	probeLiveness,
	reattachLogSink,
	REATTACH_BUDGET_MS,
	REATTACH_LOG_FILE,
	runReattachPass,
} from "../../src/runs/reattach.ts";
import { RunStore } from "../../src/runs/store.ts";
import type { ChildRecord, CrossMachineSettings } from "../../src/shared/types.ts";

const HOST = "njbox";
const NAME = "worker-0";
const NODE_ID = `root.${NAME}`;
const TERMINAL = `${HOST}/t7`;

// ── fixtures ────────────────────────────────────────────────────────────────

interface Fixture {
	root: string;
	cwd: string;
	store: RunStore;
	runId: string;
	runDir: string;
	/** Session A's transcript (the previous session, now gone). */
	previousSession: string;
	remoteDir: string;
	cleanup: () => void;
}

/**
 * A run store exactly as the previous session left it: `run.json` written by
 * `RunStore`, the ledger beside it, and an `owner.json` whose pid is DEAD (a
 * restart). Nothing here is special-cased for the test — the same two files a
 * killed `pi` leaves behind.
 */
function fixture(prefix = "reattach-"): Fixture {
	const root = mkdtempSync(path.join(tmpdir(), prefix));
	const cwd = path.join(root, "work");
	mkdirSync(cwd, { recursive: true });
	const store = new RunStore({ rootDir: path.join(cwd, ".pi-subagents") });
	const previousSession = path.join(root, "sessions", "previous.jsonl");
	mkdirSync(path.dirname(previousSession), { recursive: true });
	writeFileSync(previousSession, "");
	const run = store.createRun({ task: "ship it", cwd, sessionFile: previousSession });
	const runDir = store.runDir(run.runId);
	// A pid nobody holds: `process.kill` answers ESRCH, i.e. the owner is gone.
	writeOwnerFile(path.join(runDir, RUN_OWNER_FILE), 2_147_483_000);
	return {
		root,
		cwd,
		store,
		runId: run.runId,
		runDir,
		previousSession,
		remoteDir: path.posix.join("/srv/.pi-subagents-mirror", run.runId, NAME),
		cleanup: () => rmSync(root, { recursive: true, force: true }),
	};
}

/** One persisted child record, in the shape the orchestrator writes at launch. */
function childRecord(overrides: Partial<ChildRecord> = {}): ChildRecord {
	return {
		name: NAME,
		// For a cross-machine child this path is the empty LOCAL placeholder (S1).
		sessionFile: "/tmp/placeholder.jsonl",
		ownerToken: "tok",
		state: "working",
		spawnedAt: new Date(Date.now() - 60_000).toISOString(),
		host: HOST,
		remoteDir: "/srv/.pi-subagents-mirror/r-1/worker-0",
		remoteTerminal: TERMINAL,
		nodeId: NODE_ID,
		...overrides,
	};
}

/** The ledger rows the launch inserted: one root + one running child per name. */
function seedLedger(
	f: Fixture,
	opts: { status?: "running" | "settled" | "retired" | "failed"; remoteDir?: string; names?: string[] } = {},
): void {
	const db = openLegionDb(legionDbPath(f.runDir));
	try {
		insertNode(db, { id: "root", parentId: null, name: "root", role: "root", kind: "pi", depth: 0, runId: f.runId, status: "running" });
		for (const name of opts.names ?? [NAME]) {
			insertNode(db, {
				parentId: "root",
				name,
				role: "worker",
				kind: "pi",
				status: opts.status ?? "running",
				host: HOST,
				remoteDir: opts.remoteDir ?? f.remoteDir,
				remoteTerminal: TERMINAL,
				sessionFile: "/tmp/placeholder.jsonl",
			});
		}
	} finally {
		db.close();
	}
}

const CROSS_MACHINE: CrossMachineSettings = { enabled: true, hosts: { [HOST]: { cwd: "/srv/app" } } };

function liveProbe(): (request: { host: string; name: string }) => Promise<RemoteTerminalProbe> {
	return async () => ({ address: TERMINAL, state: "live", live: true, program: "working" });
}

function finishedProbe(): (request: { host: string; name: string }) => Promise<RemoteTerminalProbe> {
	return async () => ({ address: TERMINAL, state: "finished", live: false, exitCode: 0 });
}

function unreachableProbe(reason = "dial tcp 10.0.0.9:22: connection refused"): (request: { host: string; name: string }) => Promise<RemoteTerminalProbe> {
	return async () => ({ address: TERMINAL, state: "unknown", live: false, unreachable: reason });
}

const noLines: RemoteLineCount = async () => 0;

/** Every child record in the store, as `status` would read them. */
function records(f: Fixture): ChildRecord[] {
	return f.store.listRuns().flatMap((run) => run.children);
}

// ── 1. candidate sources ────────────────────────────────────────────────────

test("#445 §1: discovery reads the store's leftovers — cross-machine, owed, not ours", async () => {
	const f = fixture();
	try {
		await f.store.addChild(f.runId, childRecord());
		const candidates = discoverReattachCandidates(f.store, { sessionFile: "/some/new/session.jsonl" });
		assert.equal(candidates.length, 1);
		assert.equal(candidates[0]!.name, NAME);
		assert.equal(candidates[0]!.host, HOST);
		assert.equal(candidates[0]!.ownerSessionFile, f.previousSession);
	} finally {
		f.cleanup();
	}
});

test("#445 §1: `orphaned`/`unfetched` are the same leftover after a CLEAN exit, so they are candidates too", async () => {
	const f = fixture();
	try {
		await f.store.addChild(f.runId, childRecord({ state: "orphaned" }));
		await f.store.addChild(f.runId, childRecord({ name: "worker-1", nodeId: "root.worker-1", state: "unfetched" }));
		const names = discoverReattachCandidates(f.store, { sessionFile: "/new.jsonl" }).map((candidate) => candidate.name);
		assert.deepEqual(names.sort(), ["worker-0", "worker-1"]);
	} finally {
		f.cleanup();
	}
});

test("#445 §1: a local child, a terminal record, and THIS session's own run are never candidates", async () => {
	const f = fixture();
	try {
		await f.store.addChild(f.runId, childRecord({ name: "local-0", host: undefined, nodeId: undefined }));
		await f.store.addChild(f.runId, childRecord({ name: "retired-0", nodeId: "root.retired-0", state: "retired" }));
		await f.store.addChild(f.runId, childRecord({ name: "exited-0", nodeId: "root.exited-0", state: "exited" }));
		assert.deepEqual(discoverReattachCandidates(f.store, { sessionFile: "/new.jsonl" }), []);
		// The run's OWN session (priority: a re-open, not a leftover) is skipped whole.
		assert.deepEqual(discoverReattachCandidates(f.store, { sessionFile: f.previousSession }), []);
	} finally {
		f.cleanup();
	}
});

// ── 2. liveness is evidence ────────────────────────────────────────────────

test("#445 §2: a live program over there is the evidence to adopt", async () => {
	const candidate = { runId: "r-1", name: NAME, host: HOST, remoteTerminal: TERMINAL, remoteDir: "/srv/d", recordState: "working" };
	const verdict = await probeLiveness(candidate, { probeTerminal: liveProbe(), remoteLines: noLines });
	assert.equal(verdict.live, true);
	if (verdict.live) assert.match(verdict.evidence, /is live \(working\)/);
});

test("#445 §2: `unreachable` is NOT live — unknown is not evidence of life", async () => {
	const candidate = { runId: "r-1", name: NAME, host: HOST, remoteTerminal: TERMINAL, recordState: "working" };
	const verdict = await probeLiveness(candidate, { probeTerminal: unreachableProbe(), remoteLines: noLines });
	assert.equal(verdict.live, false);
	if (!verdict.live) assert.match(verdict.reason, /no liveness evidence.*could not be asked/);
});

test("#445 §2: a gap the size of the probe deadline answers `unknown`, and unknown is not live", async () => {
	const candidate = { runId: "r-1", name: NAME, host: HOST, remoteTerminal: TERMINAL, recordState: "working" };
	const verdict = await probeLiveness(candidate, {
		probeTerminal: () => new Promise<RemoteTerminalProbe>(() => {}),
		remoteLines: noLines,
		deadlineMs: 120,
	});
	assert.equal(verdict.live, false);
	if (!verdict.live) assert.match(verdict.reason, /did not answer within 120ms/);
});

test("#445 §2: with no terminal address, a GROWING transcript is the evidence; a static one is not", async () => {
	const candidate = { runId: "r-1", name: NAME, host: HOST, remoteDir: "/srv/.pi-subagents-mirror/r-1/worker-0", recordState: "working" };
	let sample = 10;
	const growing: RemoteLineCount = async () => (sample += 5);
	const staticLines: RemoteLineCount = async () => 41;

	const live = await probeLiveness(candidate, { probeTerminal: finishedProbe(), remoteLines: growing, growthWaitMs: 250 });
	assert.equal(live.live, true);
	if (live.live) assert.match(live.evidence, /is growing \(15 → 20 lines in 250ms\)/);

	const dead = await probeLiveness(candidate, { probeTerminal: finishedProbe(), remoteLines: staticLines, growthWaitMs: 250 });
	assert.equal(dead.live, false);
	if (!dead.live) assert.match(dead.reason, /did not grow/);
});

// ── 3. never adopted ───────────────────────────────────────────────────────

test("#445 §3: a row a LIVE session holds is skipped with `owned by <session>`", async () => {
	const f = fixture();
	try {
		await f.store.addChild(f.runId, childRecord());
		const owner = path.join(f.runDir, RUN_OWNER_FILE);
		// A pid that is certainly alive and is not this process: node itself.
		const { spawn } = await import("node:child_process");
		const other = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
		try {
			writeOwnerFile(owner, other.pid!);
			const [candidate] = discoverReattachCandidates(f.store, { sessionFile: "/new.jsonl" });
			const skip = ownerGate(candidate!, { pid: process.pid });
			assert.ok(skip, "a live foreign owner must gate the candidate");
			assert.match(skip!.reason, /^owned by previous\.jsonl \(pid \d+ is alive/);
		} finally {
			other.kill("SIGKILL");
		}
	} finally {
		f.cleanup();
	}
});

test("#445 §3: a settled/retired LEDGER row is skipped even when the record still says `working`", async () => {
	const f = fixture();
	try {
		await f.store.addChild(f.runId, childRecord());
		seedLedger(f, { status: "retired" });
		const [candidate] = discoverReattachCandidates(f.store, { sessionFile: "/new.jsonl" });
		const gate = ledgerGate(candidate!, { runDir: f.runDir });
		assert.ok("skip" in gate);
		if ("skip" in gate) assert.match(gate.skip.reason, /already ended \(retired\).*not adopted and not announced/);
	} finally {
		f.cleanup();
	}
});

test("#445 §3: an open row passes the ledger gate, and a missing ledger is a reason, not an adoption", async () => {
	const f = fixture();
	try {
		await f.store.addChild(f.runId, childRecord());
		seedLedger(f);
		const [candidate] = discoverReattachCandidates(f.store, { sessionFile: "/new.jsonl" });
		const gate = ledgerGate(candidate!, { runDir: f.runDir });
		assert.ok("ledgerPath" in gate);
		if ("ledgerPath" in gate) assert.equal(gate.ledgerPath, legionDbPath(f.runDir));

		const other = fixture("reattach-noledger-");
		try {
			await other.store.addChild(other.runId, childRecord());
			const [noLedger] = discoverReattachCandidates(other.store, { sessionFile: "/new.jsonl" });
			const closed = ledgerGate(noLedger!, { runDir: other.runDir });
			assert.ok("skip" in closed);
			if ("skip" in closed) assert.match(closed.skip.reason, /no ledger beside the run record/);
		} finally {
			other.cleanup();
		}
	} finally {
		f.cleanup();
	}
});

// ── 4. bounded ─────────────────────────────────────────────────────────────

test("#445 §4: an unreachable machine costs a reason, not the pass, and the budget is respected", async () => {
	const f = fixture();
	try {
		await f.store.addChild(f.runId, childRecord());
		seedLedger(f);
		const started = Date.now();
		const report = await runReattachPass({
			store: f.store,
			sessionFile: "/new.jsonl",
			settings: { crossMachine: CROSS_MACHINE },
			probeTerminal: unreachableProbe(),
			remoteLines: noLines,
			listMirrorOrphans: async () => [],
			log: () => {},
			budgetMs: 400,
			probeDeadlineMs: 150,
		});
		const elapsed = Date.now() - started;
		assert.equal(report.adopted.length, 0);
		assert.equal(report.skipped.length, 1);
		assert.match(report.skipped[0]!.reason, /could not be asked/);
		assert.ok(elapsed <= REATTACH_BUDGET_MS, `elapsed ${elapsed}ms must stay inside the frozen pass budget`);
		assert.ok(report.elapsedMs <= 400 + 200, `elapsed ${report.elapsedMs}ms must stay inside its own budget`);
	} finally {
		f.cleanup();
	}
});

test("#445 §4: candidates beyond the cap are DEFERRED (\"the next start retries\"), never probed", async () => {
	const f = fixture();
	try {
		const names = ["worker-0", "worker-1", "worker-2"];
		for (const name of names) {
			await f.store.addChild(f.runId, childRecord({ name, nodeId: `root.${name}` }));
		}
		seedLedger(f, { names });
		const probed: string[] = [];
		const report = await runReattachPass({
			store: f.store,
			sessionFile: "/new.jsonl",
			settings: { crossMachine: CROSS_MACHINE },
			probeTerminal: async (request) => {
				probed.push(request.name);
				return { address: TERMINAL, state: "unknown", live: false, unreachable: "no" };
			},
			remoteLines: noLines,
			listMirrorOrphans: async () => [],
			log: () => {},
			maxCandidates: 1,
		});
		assert.equal(probed.length, 1);
		assert.equal(report.deferred, 2);
		assert.match(formatReattachSummary({ ...report, adopted: [], mirrorOnly: [] }) ?? "", /^legion: /);
	} finally {
		f.cleanup();
	}
});

// ── 5. switchable ──────────────────────────────────────────────────────────

test("#445 §5: `reattachLiveChildren: false` disables the pass without touching the wire", async () => {
	const f = fixture();
	try {
		await f.store.addChild(f.runId, childRecord());
		let probed = 0;
		const report = await runReattachPass({
			store: f.store,
			sessionFile: "/new.jsonl",
			settings: { crossMachine: CROSS_MACHINE, reattachLiveChildren: false },
			probeTerminal: async () => {
				probed += 1;
				return { address: TERMINAL, state: "live", live: true };
			},
			remoteLines: noLines,
			listMirrorOrphans: async () => [],
			log: () => {},
		});
		assert.equal(report.disabled, true);
		assert.equal(probed, 0);
		assert.equal(report.adopted.length, 0);
		assert.equal(formatReattachSummary(report), undefined);
	} finally {
		f.cleanup();
	}
});

// ── 6. visible, not noisy ──────────────────────────────────────────────────

test("#445 §6: the summary is ONE line naming the children; the detail goes to the log file", async () => {
	const f = fixture();
	try {
		await f.store.addChild(f.runId, childRecord());
		seedLedger(f);
		const report = await runReattachPass({
			store: f.store,
			sessionFile: "/new.jsonl",
			settings: { crossMachine: CROSS_MACHINE },
			probeTerminal: liveProbe(),
			remoteLines: noLines,
			listMirrorOrphans: async () => [{ name: "anotify-uishift-budget", path: "/srv/.pi-subagents-mirror/no-run/anotify-uishift-budget/session.jsonl" }],
			log: reattachLogSink(f.store.rootDir),
		});
		const summary = formatReattachSummary(report);
		assert.ok(summary);
		assert.equal(summary!.includes("\n"), false, "the session-start line must not be a paragraph");
		assert.match(summary!, /^legion: reattached 1 live child \(worker-0\)/);
		assert.match(summary!, /mirror-only session dir\(s\) on njbox/);
		const log = readFileSync(path.join(f.store.rootDir, REATTACH_LOG_FILE), "utf8");
		assert.match(log, /adopted worker-0 run=r-.*host=njbox/);
		assert.match(log, /mirror-only orphan host=njbox name=anotify-uishift-budget/);
	} finally {
		f.cleanup();
	}
});

// ── adoption writes both records ───────────────────────────────────────────

test("#445: adoption re-opens the record (`working`, `reattached`, no orphan marker) and claims the run dir", async () => {
	const f = fixture();
	try {
		await f.store.addChild(f.runId, childRecord({
			state: "orphaned",
			orphaned: { at: Date.now(), fate: "orphaned", reason: "session-shutdown", host: HOST },
			retiredAt: new Date().toISOString(),
			execution: { status: "running" },
		}));
		seedLedger(f);
		const report = await runReattachPass({
			store: f.store,
			sessionFile: "/new/session.jsonl",
			settings: { crossMachine: CROSS_MACHINE },
			probeTerminal: liveProbe(),
			remoteLines: noLines,
			listMirrorOrphans: async () => [],
			log: () => {},
			pid: process.pid,
		});
		assert.equal(report.adopted.length, 1);
		const [record] = records(f);
		assert.equal(record!.state, "working");
		assert.equal(record!.orphaned, undefined);
		assert.equal(record!.retiredAt, undefined);
		assert.equal(record!.reattached?.host, HOST);
		assert.equal(record!.reattached?.sessionFile, path.resolve("/new/session.jsonl"));
		assert.match(record!.reattached?.evidence ?? "", /is live/);
		// The claim: the run dir now says this process owns it, which is also what
		// makes `status` count the child live instead of "owner dead".
		const owner = JSON.parse(readFileSync(path.join(f.runDir, RUN_OWNER_FILE), "utf8")) as { pid: number };
		assert.equal(owner.pid, process.pid);
		// The ledger heartbeat moved, the row is still open — nothing was settled.
		const db = openLegionDb(legionDbPath(f.runDir));
		try {
			assert.equal(getNode(db, NODE_ID)?.status, "running");
		} finally {
			db.close();
		}
	} finally {
		f.cleanup();
	}
});

// ── 7. the latch ───────────────────────────────────────────────────────────

function watcherHarness(opts: {
	probes: RemoteTerminalProbe[];
	settle?: () => Promise<{ kind: "settled-now"; recovery: unknown }>;
	notifyDelivered?: boolean;
}) {
	const notices: string[] = [];
	const latched: Array<{ name: string; at: number }> = [];
	const settled: string[] = [];
	const logs: string[] = [];
	let index = 0;
	const probe = async (): Promise<RemoteTerminalProbe> => opts.probes[Math.min(index++, opts.probes.length - 1)]!;
	const watcher = new ReattachWatcher({
		probe,
		settle: async (target: ReattachWatchTarget) => {
			settled.push(target.name);
			if (opts.settle) return opts.settle() as never;
			return {
				kind: "settled-now",
				recovery: {
					kind: "settled-now",
					node: { name: target.name, runId: target.runId, host: target.host },
					execution: { status: "success" },
					acceptance: { status: "accepted", level: "attested" },
					output: "done",
					readback: { host: target.host, lines: 1, returned: 1, truncated: false },
					ageMs: 1,
				},
			} as never;
		},
		notify: (notice) => {
			notices.push(notice.content);
			return opts.notifyDelivered !== false;
		},
		markNotified: async (target, at) => {
			latched.push({ name: target.name, at });
		},
		log: (line) => logs.push(line),
	});
	watcher.add({ runId: "r-1", name: NAME, host: HOST, remoteTerminal: TERMINAL, ledgerDbPath: "/tmp/x/legion.db" });
	return { watcher, notices, latched, settled, logs };
}

test("#445 §7: a child still working is never settled and never announced", async () => {
	const h = watcherHarness({ probes: [{ address: TERMINAL, state: "live", live: true, program: "working" }] });
	await h.watcher.tick();
	assert.deepEqual(h.settled, []);
	assert.deepEqual(h.notices, []);
	assert.deepEqual(h.latched, []);
	assert.equal(h.watcher.watching().length, 1, "a live child stays watched");
});

test("#445 §7: when the program ends the row is settled and ONE notice is delivered, then latched", async () => {
	const h = watcherHarness({ probes: [{ address: TERMINAL, state: "finished", live: false, exitCode: 0 }] });
	await h.watcher.tick();
	assert.deepEqual(h.settled, [NAME]);
	assert.equal(h.notices.length, 1);
	assert.match(h.notices[0]!, /Background task completed: \*\*worker-0\*\*/);
	assert.equal(h.latched.length, 1);
	assert.equal(h.watcher.watching().length, 0, "a settled child is no longer watched");
});

test("#445 §7: an UNDELIVERED notice leaves the latch unset, so a later session still owes it", async () => {
	const h = watcherHarness({ probes: [{ address: TERMINAL, state: "finished", live: false }], notifyDelivered: false });
	await h.watcher.tick();
	assert.deepEqual(h.settled, [NAME]);
	assert.equal(h.latched.length, 0);
	assert.match(h.logs.join("\n"), /completion NOT delivered; the latch stays unset/);
});

test("#445 §7: `pendingReattachNotices` is the other half — latched is silent, unlatched is owed", async () => {
	const f = fixture();
	try {
		await f.store.addChild(f.runId, childRecord({
			state: "retired",
			execution: { status: "success" },
			acceptance: { status: "accepted", level: "attested" },
			reattached: { at: 1, host: HOST, evidence: "x", notifiedAt: 2 },
		}));
		assert.deepEqual(pendingReattachNotices(f.store), [], "an announced completion is never announced again");
		const [record] = records(f);
		assert.equal(alreadyNotified(record!), true);

		await f.store.updateChild(f.runId, NAME, (child) => {
			if (child.reattached) delete child.reattached.notifiedAt;
		});
		const pending = pendingReattachNotices(f.store);
		assert.equal(pending.length, 1);
		assert.equal(pending[0]!.name, NAME);
	} finally {
		f.cleanup();
	}
});

test("#445 §4: a machine that stays silent is dropped after the strike budget (no unbounded watcher)", async () => {
	const h = watcherHarness({ probes: [{ address: TERMINAL, state: "unknown", live: false, unreachable: "no route" }] });
	await h.watcher.tick();
	await h.watcher.tick();
	assert.equal(h.watcher.watching().length, 1, "two strikes are still a chance");
	await h.watcher.tick();
	assert.equal(h.watcher.watching().length, 0);
	assert.deepEqual(h.settled, []);
	assert.match(h.logs.join("\n"), /stopped watching worker-0: 3 unanswered probes/);
});

test("#445: a retired ledger row is never re-opened by the pass (ghost-row guard, #441's rule)", async () => {
	const f = fixture();
	try {
		await f.store.addChild(f.runId, childRecord());
		seedLedger(f);
		const db = openLegionDb(legionDbPath(f.runDir));
		try {
			updateNode(db, NODE_ID, { status: "retired" });
		} finally {
			db.close();
		}
		let probed = 0;
		const report = await runReattachPass({
			store: f.store,
			sessionFile: "/new.jsonl",
			settings: { crossMachine: CROSS_MACHINE },
			probeTerminal: async () => {
				probed += 1;
				return { address: TERMINAL, state: "live", live: true };
			},
			remoteLines: noLines,
			listMirrorOrphans: async () => [],
			log: () => {},
		});
		assert.equal(probed, 0, "a retired row must not even be probed");
		assert.equal(report.adopted.length, 0);
		assert.match(report.skipped[0]!.reason, /already ended \(retired\)/);
	} finally {
		f.cleanup();
	}
});

// ── §5 through the real settings file ─────────────────────────────────────

test("#445 §5: `subagents.reattachLiveChildren: false` survives the settings parser, and the project file wins", async () => {
	const dir = mkdtempSync(path.join(tmpdir(), "reattach-settings-"));
	try {
		const user = path.join(dir, "user.json");
		const project = path.join(dir, "project.json");
		writeFileSync(user, JSON.stringify({ subagents: { reattachLiveChildren: false } }));
		writeFileSync(project, JSON.stringify({ subagents: { joinMode: "each" } }));
		assert.equal(loadSubagentSettings({ userSettingsPath: user }).reattachLiveChildren, false);
		// An absent project key leaves the user value alone (the merge's normal rule).
		assert.equal(loadSubagentSettings({ userSettingsPath: user, projectSettingsPath: project }).reattachLiveChildren, false);
		// …and a project that turns it back ON wins over the user file.
		writeFileSync(project, JSON.stringify({ subagents: { reattachLiveChildren: true } }));
		assert.equal(loadSubagentSettings({ userSettingsPath: user, projectSettingsPath: project }).reattachLiveChildren, true);
		// A wrong shape is reported, not silently dropped (the whitelist's whole point).
		writeFileSync(user, JSON.stringify({ subagents: { reattachLiveChildren: "no" } }));
		assert.throws(() => loadSubagentSettings({ userSettingsPath: user }), /reattachLiveChildren/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
