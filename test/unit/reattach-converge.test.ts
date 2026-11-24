/**
 * #463 — the session-start pass CONVERGES the leftovers it cannot adopt.
 *
 * The ghost `working` row: a `run.json` child still saying `working` after its
 * session was replaced, with `owner.json` naming a pid that proves nothing (often
 * this very process). #445's pass only ever ADOPTED, so such a row was logged and
 * left exactly as it was — `status` counted it live forever and `stop` could not
 * settle it.
 *
 * The pass now reconciles those records with what the LEDGER says, in the store that
 * holds them, and writes the `unsupervised` mark the status/stop predicate reads:
 *
 *   - ledger row still running / missing and NOBODY here holds the child ⇒ the record
 *     keeps its state and gets the mark (`ledger: "running"` / `"missing"`), so
 *     `status` renders `unreachable (no supervisor)` and `stop` settles it.
 *
 * Everything else must stay byte-identical to 6.2.12: a row whose ledger row already
 * ENDED (#445 A3 — "a settled/retired child is not adopted and not announced", the
 * record left exactly as found), an adopted child (adoption CLEARS the mark), a live
 * one, a row another live session holds, a row a previous pass already marked, an #456
 * orphan, a ledger that could not be read, a terminal record — and a store with no
 * `updateChild` (a mark that exists only in memory is worse than no mark).
 *
 * Real on-disk stores and the real `legion.db` schema: this step's whole job is that
 * a LATER session reads what an EARLIER one wrote, so a fake store would test the
 * fixture instead of the fix.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { legionDbPath, openLegionDb } from "../../src/legion/db.ts";
import { appendEvent, readEventsAfter } from "../../src/legion/events.ts";
import { hasEnded, insertNode } from "../../src/legion/nodes.ts";
import { RUN_OWNER_FILE, writeOwnerFile } from "../../src/runs/owner.ts";
import type { RemoteTerminalProbe } from "../../src/runs/remote-artifact.ts";
import {
	formatReattachSummary,
	REATTACH_LOG_FILE,
	runReattachPass,
	type ReattachReport,
	type ReattachStore,
} from "../../src/runs/reattach.ts";
import { RunStore } from "../../src/runs/store.ts";
import type { ChildRecord, CrossMachineSettings } from "../../src/shared/types.ts";

const HOST = "njbox";
const TERMINAL = `${HOST}/t7`;
/** A pid nobody holds (ESRCH), i.e. the previous session is gone. */
const DEAD_PID = 2_147_483_000;

// ── fixtures ────────────────────────────────────────────────────────────────

interface Fixture {
	root: string;
	cwd: string;
	store: RunStore;
	runId: string;
	runDir: string;
	/** This (new) session's transcript — the "who" a convergence names. */
	sessionFile: string;
	logLines: string[];
	cleanup: () => void;
}

/** A run store exactly as the previous session left it (#445's fixture, local child). */
function fixture(prefix = "reattach-converge-"): Fixture {
	const root = mkdtempSync(path.join(tmpdir(), prefix));
	const cwd = path.join(root, "work");
	mkdirSync(cwd, { recursive: true });
	const store = new RunStore({ rootDir: path.join(cwd, ".pi-subagents") });
	const previousSession = path.join(root, "sessions", "previous.jsonl");
	const sessionFile = path.join(root, "sessions", "current.jsonl");
	mkdirSync(path.dirname(previousSession), { recursive: true });
	writeFileSync(previousSession, "");
	writeFileSync(sessionFile, "");
	const run = store.createRun({ task: "ship it", cwd, sessionFile: previousSession });
	const runDir = store.runDir(run.runId);
	writeOwnerFile(path.join(runDir, RUN_OWNER_FILE), DEAD_PID);
	return {
		root,
		cwd,
		store,
		runId: run.runId,
		runDir,
		sessionFile,
		logLines: [],
		cleanup: () => rmSync(root, { recursive: true, force: true }),
	};
}

/** A LOCAL leftover: `state=working`, no `host`, no `orphaned` marker (the ghost). */
function ghostRecord(overrides: Partial<ChildRecord> = {}): ChildRecord {
	return {
		name: "ghost-0",
		sessionFile: path.join(tmpdir(), "does-not-exist-ghost-0.jsonl"),
		ownerToken: "tok-ghost",
		state: "working",
		spawnedAt: new Date(Date.now() - 60_000).toISOString(),
		agent: "worker",
		kind: "pi",
		spawnMode: "inprocess",
		nodeId: "root.ghost-0",
		...overrides,
	};
}

/** One ledger row beside that run, in the state the launch left it. */
function seedLedger(f: Fixture, opts: { status?: "running" | "settled" | "retired"; names?: string[] } = {}): string[] {
	const names = opts.names ?? ["ghost-0"];
	const db = openLegionDb(legionDbPath(f.runDir));
	try {
		insertNode(db, { id: "root", parentId: null, name: "root", role: "root", kind: "pi", depth: 0, runId: f.runId, status: "running" });
		for (const name of names) {
			insertNode(db, { parentId: "root", name, role: "worker", kind: "pi", status: opts.status ?? "running" });
			if ((opts.status ?? "running") !== "running") {
				// A settled row reached its state through an event; keep the shape honest.
				const node = readEventsAfter(db, 0, { nodeId: `root.${name}` }).length;
				appendEvent(db, `root.${name}`, "node_settled", { attempt: node }, { now: () => Date.now() });
			}
		}
	} finally {
		db.close();
	}
	return names.map((name) => `root.${name}`);
}

const CROSS_MACHINE: CrossMachineSettings = { enabled: true, hosts: { [HOST]: { cwd: "/srv/app" } } };

/** A pass that must never touch the wire for a local row. */
function noProbe(): (request: { host: string; name: string }) => Promise<RemoteTerminalProbe> {
	return async () => {
		throw new Error("the convergence step must never probe a machine");
	};
}

function passInput(f: Fixture, over: Partial<Parameters<typeof runReattachPass>[0]> = {}) {
	return {
		store: f.store,
		home: f.root,
		sessionFile: f.sessionFile,
		settings: { crossMachine: CROSS_MACHINE },
		probeTerminal: noProbe(),
		remoteLines: async () => 0,
		listMirrorOrphans: async () => [],
		log: (line: string) => f.logLines.push(line),
		...over,
	} satisfies Parameters<typeof runReattachPass>[0];
}

function recordOf(f: Fixture, name = "ghost-0"): ChildRecord {
	const record = f.store.findChild(f.runId, name);
	assert.ok(record, `${name} must still be readable from run.json`);
	return record;
}

// ── 1. ledger running ⇒ the mark, state untouched ───────────────────────────

test("#463: a local leftover nobody holds gets the mark, and keeps its state", async () => {
	const f = fixture();
	try {
		await f.store.addChild(f.runId, ghostRecord());
		seedLedger(f);
		const report = await runReattachPass(passInput(f));

		assert.equal(report.converged?.length, 1, "the row is reported as converged");
		assert.deepEqual(report.converged?.[0] && {
			name: report.converged[0].name,
			storeRoot: path.resolve(report.converged[0].storeRoot),
			runId: report.converged[0].runId,
		}, { name: "ghost-0", storeRoot: path.resolve(f.store.rootDir), runId: f.runId });

		const record = recordOf(f);
		assert.equal(record.state, "working", "an open ledger row is not a retirement: the state stays the record's");
		assert.equal(record.retiredAt, undefined);
		assert.equal(record.unsupervised?.reason, "no supervisor");
		assert.equal(record.unsupervised?.ledger, "running");
		assert.match(record.unsupervised?.evidence ?? "", /holds no supervisor for it/);
		assert.equal(record.unsupervised?.sessionFile, path.resolve(f.sessionFile), "the mark names WHO converged it");
		assert.equal(report.adopted.length, 0);
		assert.match(f.logLines.join("\n"), /converged ghost-0 .*how=no-supervisor ledger=running/);
	} finally {
		f.cleanup();
	}
});

// ── 2. ledger ended ⇒ THE BOUNDARY: nothing is written (the #445 A3 shape) ──

test("#463 ✕ #445 A3: a leftover whose ledger row already ended is left exactly as found", async () => {
	const f = fixture();
	try {
		await f.store.addChild(f.runId, ghostRecord());
		const [nodeId] = seedLedger(f, { status: "settled" });
		const before = (() => {
			const db = openLegionDb(legionDbPath(f.runDir));
			try {
				return readEventsAfter(db, 0, { nodeId }).length;
			} finally {
				db.close();
			}
		})();

		const report = await runReattachPass(passInput(f));
		assert.equal(report.converged?.length ?? 0, 0, "an ended ledger row is the LEDGER's verdict, not this step's");
		const record = recordOf(f);
		assert.equal(record.state, "working", "the record is untouched: the pass has no verdict about an ended row");
		assert.equal(record.retiredAt, undefined);
		assert.equal(record.unsupervised, undefined, "no mark, no word: #209-3's `state=working` stands");
		assert.equal(formatReattachSummary(report), undefined, "and nothing is announced");
		assert.match(
			f.logLines.join("\n"),
			/left ghost-0 .*already ended \(settled\), and a settled\/retired child is not adopted and not announced/,
			"the reason is logged, once, without inventing a summary line",
		);

		const after = (() => {
			const db = openLegionDb(legionDbPath(f.runDir));
			try {
				return readEventsAfter(db, 0, { nodeId }).length;
			} finally {
				db.close();
			}
		})();
		assert.equal(after, before, "the ledger is the authority: convergence writes no event");
	} finally {
		f.cleanup();
	}
});

// ── 3. what must stay exactly as it was ────────────────────────────────────

test("#463: another LIVE session's row is left alone (the #445 owner gate survives)", async () => {
	const f = fixture();
	try {
		await f.store.addChild(f.runId, ghostRecord());
		writeOwnerFile(path.join(f.runDir, RUN_OWNER_FILE), 4_242);
		const report = await runReattachPass(passInput(f, { alive: (pid) => pid === 4_242 }));
		assert.equal(report.converged?.length ?? 0, 0);
		const record = recordOf(f);
		assert.equal(record.unsupervised, undefined, "a live foreign pid holds the row: no mark");
		assert.equal(record.state, "working");
	} finally {
		f.cleanup();
	}
});

test("#463: an #456 orphaned leftover keeps its own path (never converged here)", async () => {
	const f = fixture();
	try {
		await f.store.addChild(f.runId, ghostRecord({
			state: "orphaned",
			host: HOST,
			remoteTerminal: TERMINAL,
			orphaned: { at: Date.now() - 1_000, fate: "orphaned", reason: "session-shutdown", host: HOST, remoteTerminal: TERMINAL },
		}));
		// Its ledger row already ended: the tempting case for "converge it to retired".
		seedLedger(f, { status: "retired" });
		const report = await runReattachPass(passInput(f));
		assert.equal(report.converged?.length ?? 0, 0, "#456 owns its leftovers end to end");
		const record = recordOf(f);
		assert.equal(record.state, "orphaned");
		assert.equal(record.unsupervised, undefined);
	} finally {
		f.cleanup();
	}
});

test("#463: a live adoption still wins, and it CLEARS a stale mark", async () => {
	const f = fixture();
	try {
		await f.store.addChild(f.runId, ghostRecord({
			// A cross-machine candidate, already converged by an earlier pass.
			host: HOST,
			remoteTerminal: TERMINAL,
			remoteDir: "/srv/.pi-subagents-mirror/r-1/ghost-0",
			unsupervised: { at: 1_000, reason: "no supervisor", evidence: "a previous pass said so", ledger: "running" },
		}));
		seedLedger(f, { status: "running" });
		const report = await runReattachPass(passInput(f, {
			probeTerminal: async () => ({ address: TERMINAL, state: "live", live: true, program: "working" }),
		}));
		assert.equal(report.adopted.length, 1, "a live program is still adopted by #445's rule");
		const record = recordOf(f);
		assert.equal(record.state, "working");
		assert.equal(record.unsupervised, undefined, "somebody holds it now: the ghost verdict is gone");
		assert.ok(record.reattached, "and the adoption stamp is what replaced it");
	} finally {
		f.cleanup();
	}
});

test("#463: an already-retired record is history (byte-identical to 6.2.12)", async () => {
	const f = fixture();
	try {
		await f.store.addChild(f.runId, ghostRecord({ state: "retired", retiredAt: new Date().toISOString() }));
		seedLedger(f, { status: "retired" });
		const report = await runReattachPass(passInput(f));
		assert.equal(report.converged?.length ?? 0, 0);
		assert.equal(recordOf(f).unsupervised, undefined);
	} finally {
		f.cleanup();
	}
});

test("#463: a store that cannot write records converges nothing and does not throw", async () => {
	const f = fixture();
	try {
		await f.store.addChild(f.runId, ghostRecord());
		seedLedger(f);
		const readOnly: ReattachStore = {
			rootDir: f.store.rootDir,
			listRuns: () => f.store.listRuns(),
			runDir: (runId: string) => f.store.runDir(runId),
			// no `updateChild`
		};
		const report = await runReattachPass(passInput(f, { store: readOnly }));
		assert.equal(report.converged?.length ?? 0, 0);
		assert.equal(recordOf(f).unsupervised, undefined, "no write seam ⇒ no half-written state");
	} finally {
		f.cleanup();
	}
});

// ── 4. bounded, and the ONE summary line ───────────────────────────────────

test("#463: convergence is bounded — the rest is reported as deferred, not dropped", async () => {
	const f = fixture();
	try {
		await f.store.addChild(f.runId, ghostRecord({ name: "ghost-0" }));
		await f.store.addChild(f.runId, ghostRecord({ name: "ghost-1", nodeId: "root.ghost-1" }));
		seedLedger(f, { names: ["ghost-0", "ghost-1"] });
		const report = await runReattachPass(passInput(f, { maxConvergeRows: 1 }));
		assert.equal(report.converged?.length, 1);
		assert.equal(report.deferredConverge, 1);
		assert.equal(recordOf(f, "ghost-1").unsupervised, undefined, "the deferred row is untouched — the next start retries");
	} finally {
		f.cleanup();
	}
});

test("#463: the summary stays ONE line, and only mentions convergence when it happened", () => {
	const base: ReattachReport = {
		disabled: false,
		considered: 0,
		adopted: [],
		skipped: [],
		mirrorOnly: [],
		sessionStoreRoot: "/tmp/work/.pi-subagents",
		stores: { scanned: 1, withRuns: 1, candidates: 0, truncated: false, skipped: [] },
		deferred: 0,
		elapsedMs: 1,
		budgetMs: 5_000,
	};
	assert.equal(formatReattachSummary({ ...base }), undefined, "nothing to say ⇒ no line, exactly as before");
	assert.equal(
		formatReattachSummary({ ...base, converged: [{ name: "ghost-0", storeRoot: "/tmp/work/.pi-subagents", runId: "r-1" }] }),
		undefined,
		"convergence alone is bookkeeping, not news: it never invents a summary line",
	);
	const withAdoption = formatReattachSummary({
		...base,
		adopted: [{ name: "worker-0", host: HOST, runId: "r-1", storeRoot: "/tmp/work/.pi-subagents", storeCwd: "/tmp/work", evidence: "terminal is live", ledgerDbPath: "/tmp/work/legion.db" }],
	});
	assert.equal(withAdoption, "legion: reattached 1 live child (worker-0)", "byte-identical when nothing converged");
	const both = formatReattachSummary({
		...base,
		adopted: [{ name: "worker-0", host: HOST, runId: "r-1", storeRoot: "/tmp/work/.pi-subagents", storeCwd: "/tmp/work", evidence: "terminal is live", ledgerDbPath: "/tmp/work/legion.db" }],
		converged: [
			{ name: "ghost-0", storeRoot: "/tmp/work/.pi-subagents", runId: "r-1" },
			{ name: "ghost-1", storeRoot: "/tmp/work/.pi-subagents", runId: "r-1" },
		],
	});
	assert.equal(both, "legion: reattached 1 live child (worker-0) (2 converged)");
});

test("#463: the pass logs every convergence into the ONE reattach log (never the transcript)", async () => {
	const f = fixture();
	try {
		await f.store.addChild(f.runId, ghostRecord());
		seedLedger(f);
		await runReattachPass(passInput(f));
		assert.match(f.logLines.join("\n"), /converge converged=1 \(ghost-0\) deferred=0/);
		assert.equal(REATTACH_LOG_FILE, "reattach-live-children.log");
	} finally {
		f.cleanup();
	}
});
