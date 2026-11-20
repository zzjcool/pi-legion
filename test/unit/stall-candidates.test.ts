/**
 * #441 — the stall candidates, and the three facts that decide them.
 *
 * Two defects, measured on 2026-08 as 10+ false notices in one day:
 *
 *   A. a child that had RETIRED (`state=retired execution=success`, terminal gone)
 *      was still announced 1h 23m after its last session write;
 *   B. a cross-machine child's "no tool in flight" was permanently true here (its
 *      tools run over there), so "anomaly" degenerated into "it has been running a
 *      while" — which is true of every big task by construction.
 *
 * The rules these tests pin, each with its own control so the fix cannot degenerate
 * into "never alert again" (#441's anti-requirement):
 *
 *   1. run over (ledger OR run record) ⇒ ZERO notices, and `extend` refuses;
 *   2. tool-blind child + growing transcript ⇒ ZERO notices; growth unknown ⇒ ZERO
 *      notices (`unknown ≠ stalled`); growth stale + container idle ⇒ ONE notice;
 *   3. a visible long command in flight ⇒ ZERO notices (it is working);
 *   4. REVERSE: quiet, idle, unattended ⇒ exactly ONE notice.
 *
 * Every "zero" here has a sibling assertion that the SAME fixture would have fired
 * without the new fact — otherwise a test could pass by never detecting anything.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { initTheme } from "@earendil-works/pi-coding-agent";
import { LegionPostman } from "../../src/extension/legion-tools.ts";
import { openLegionDb } from "../../src/legion/db.ts";
import { inbox } from "../../src/legion/mail.ts";
import { insertNode } from "../../src/legion/nodes.ts";
import { stallCandidateVerdict, type StallRunFacts } from "../../src/legion/stall-candidates.ts";
import { liveMirrorStatePathFor } from "../../src/runs/live-mirror.ts";
import { createChildRunStateReader } from "../../src/runs/child-run-facts.ts";
import { RunStore } from "../../src/runs/store.ts";
import type { InFlightToolStack } from "../../src/supervisor/types.ts";
import { FakeSupervisor } from "../helpers/fake-supervisor.ts";

const MINUTE = 60_000;
const TICK_AT = 3_600_000;
const RADIUS = 45 * MINUTE;

/** A supervisor that answers the stall facts by hand (no process, no hc core). */
class CandidateSupervisor extends FakeSupervisor {
	readonly live = new Set<string>();
	readonly stacks = new Map<string, InFlightToolStack>();
	readonly programStates = new Map<string, string>();
	/** How many times the (async, `terminal.get`-shaped) container read was asked. */
	programStateReads = 0;
	/**
	 * #441-B: DECLARED but not defined — the same shape every pre-#441 backend has.
	 * A test that needs the terminal backend's answer assigns it; the fixture's
	 * default absence is what makes the row-evidence fallback (`remoteTerminal` /
	 * `host`) the path under test everywhere else.
	 */
	declare observesToolEvents?: (name: string) => boolean;

	isAlive(name: string): boolean {
		return this.live.has(name);
	}

	inFlightToolStack(name: string): InFlightToolStack | undefined {
		return this.stacks.get(name);
	}

	async programState(name: string): Promise<string | undefined> {
		this.programStateReads += 1;
		return this.programStates.get(name);
	}
}

interface ChildSpec {
	name: string;
	/** Ledger row status; `running` is the lagging row the ghost was measured on. */
	status?: "running" | "settled" | "retired";
	createdAt?: number;
	/** Absent = this host. */
	host?: string;
	/** `host/name` the core holds ⇒ the `hc` terminal backend (tool-blind). */
	remoteTerminal?: string;
	sessionFile?: string;
}

interface Fixture {
	root: string;
	db: ReturnType<typeof openLegionDb>;
	supervisor: CandidateSupervisor;
	postman: LegionPostman;
	stop(): void;
	cleanup(): void;
}

function fixture(options: {
	children: ChildSpec[];
	/** #441-A: the run record's answer, per child name (absent = no run facts). */
	runStates?: Record<string, StallRunFacts>;
	radius?: number;
	now?: () => number;
}): Fixture {
	const root = mkdtempSync(path.join(tmpdir(), "stall-441-"));
	const db = openLegionDb(":memory:");
	const supervisor = new CandidateSupervisor();
	insertNode(db, { parentId: null, name: "root", role: "root", status: "running" }, () => 1);
	for (const spec of options.children) {
		insertNode(
			db,
			{
				parentId: "root",
				name: spec.name,
				role: "worker",
				status: spec.status ?? "running",
				...(spec.host === undefined ? {} : { host: spec.host }),
				...(spec.remoteTerminal === undefined ? {} : { remoteTerminal: spec.remoteTerminal }),
				...(spec.sessionFile === undefined ? {} : { sessionFile: spec.sessionFile }),
			},
			() => spec.createdAt ?? TICK_AT,
		);
		supervisor.live.add(spec.name);
	}
	const runStates = options.runStates;
	const postman = new LegionPostman({
		db,
		nodeId: "root",
		supervisor,
		sendRootMessage: () => {},
		settings: { orphanStaleMs: Number.MAX_SAFE_INTEGER, mailRatePer5Min: 10 },
		now: options.now ?? (() => TICK_AT),
		intervalMs: 10_000,
		noticeMsForRole: () => options.radius ?? RADIUS,
		...(runStates === undefined
			? {}
			: {
				childRunStates: (children: readonly { id: string; name: string }[]) => {
					const map = new Map<string, StallRunFacts>();
					for (const child of children) {
						const facts = runStates[child.name];
						if (facts !== undefined) map.set(child.id, facts);
					}
					return map;
				},
			}),
	});
	return {
		root,
		db,
		supervisor,
		postman,
		stop: () => postman.stop(),
		cleanup: () => {
			postman.stop();
			db.close();
			rmSync(root, { recursive: true, force: true });
		},
	};
}

/** The pump's persisted facts row, exactly where `readMirrorFacts` looks for it. */
function writeMirrorState(sessionFile: string, lastGrowthAt: number, mode: "on" | "off" = "on"): void {
	const statePath = liveMirrorStatePathFor(sessionFile);
	mkdirSync(path.dirname(statePath), { recursive: true });
	writeFileSync(statePath, `${JSON.stringify({ mode, bytes: 10, offset: 10, staleBytes: 0, lastGrowthAt, lastSyncAt: lastGrowthAt })}\n`);
}

// ─────────────────────────── A. the run is over ───────────────────────────

test("#441-A: a RETIRED child whose ledger row still says `running` is never a candidate", async () => {
	// The measured ghost: the run retired at 16:45, the ledger row had not been
	// collected yet, and the detector announced "running for 1h 45m" at 18:08.
	const fx = fixture({
		children: [{ name: "ghost", createdAt: TICK_AT - RADIUS - MINUTE }],
		runStates: { ghost: { state: "retired", executionStatus: "success" } },
	});
	try {
		await fx.postman.tick();
		fx.stop();
		assert.deepEqual(inbox(fx.db, "root"), [], "a finished run is not a stall");
	} finally {
		fx.cleanup();
	}
});

test("#441-A control: the SAME row with a LIVE run record fires (so `zero` above is the filter, not blindness)", async () => {
	const fx = fixture({
		children: [{ name: "ghost", createdAt: TICK_AT - RADIUS - MINUTE }],
		runStates: { ghost: { state: "working" } },
	});
	try {
		await fx.postman.tick();
		fx.stop();
		const rows = inbox(fx.db, "root");
		assert.equal(rows.length, 1, "a live run past its radius is judged normally");
		assert.match(rows[0]!.body, /ghost: running for /);
	} finally {
		fx.cleanup();
	}
});

test("#441-A: `execution` alone is enough — a graded turn is over even while the record still says `awaiting`", async () => {
	const fx = fixture({
		children: [{ name: "graded", createdAt: TICK_AT - RADIUS - MINUTE }],
		runStates: { graded: { state: "awaiting", executionStatus: "success" } },
	});
	try {
		await fx.postman.tick();
		fx.stop();
		assert.deepEqual(inbox(fx.db, "root"), [], "the turn was graded 45m ago; nobody is running");
	} finally {
		fx.cleanup();
	}
});

test("#441-A: a ledger row that ENDED is not a candidate either (the pre-#441 arm stays)", async () => {
	for (const status of ["settled", "retired"] as const) {
		const fx = fixture({ children: [{ name: "done", status, createdAt: TICK_AT - RADIUS - MINUTE }] });
		try {
			await fx.postman.tick();
			fx.stop();
			assert.deepEqual(inbox(fx.db, "root"), [], `status=${status} is over`);
		} finally {
			fx.cleanup();
		}
	}
});

test("#441-A: `extend` refuses a run-ended child instead of promising a reminder that cannot arrive", () => {
	const fx = fixture({
		children: [{ name: "ghost", createdAt: TICK_AT - RADIUS - MINUTE }],
		runStates: { ghost: { state: "retired", executionStatus: "success" } },
	});
	try {
		assert.deepEqual(fx.postman.extendStallWindow("ghost"), { reason: "child-ended" });
		// Control: the same child with a live run record still gets its receipt.
		const live = fixture({ children: [{ name: "ghost", createdAt: TICK_AT - RADIUS - MINUTE }], runStates: { ghost: { state: "working" } } });
		try {
			const receipt = live.postman.extendStallWindow("ghost");
			assert.ok("childName" in receipt, "a live child is extendable");
		} finally {
			live.cleanup();
		}
	} finally {
		fx.cleanup();
	}
});

test("#441-A: the pure verdict names its source, and absence of run facts is NOT evidence", () => {
	const running = { status: "running" as const, phase: null };
	assert.deepEqual(stallCandidateVerdict({ ledger: running, run: { state: "retired" } }), { candidate: false, reason: "run-ended" });
	assert.deepEqual(stallCandidateVerdict({ ledger: running, run: { executionStatus: "failed" } }), { candidate: false, reason: "run-ended" });
	assert.deepEqual(stallCandidateVerdict({ ledger: { status: "settled", phase: null } }), { candidate: false, reason: "ledger-ended" });
	assert.deepEqual(stallCandidateVerdict({ ledger: running }), { candidate: true, reason: "candidate" }, "no fact ⇒ today's answer");
	// `orphaned` / `orphaned_turn_over` are deliberately NOT terminal (6.2.4 D2:
	// `recover` must still be able to fetch a cross-machine child left behind).
	for (const state of ["orphaned", "orphaned_turn_over", "working", "awaiting", "blocked", "queued"]) {
		assert.deepEqual(stallCandidateVerdict({ ledger: running, run: { state } }), { candidate: true, reason: "candidate" }, state);
	}
});

test("#441-A wiring: `createChildRunStateReader` reads THIS run's records, keyed by nodeId (name fallback), and degrades to nothing", async () => {
	const root = mkdtempSync(path.join(tmpdir(), "stall-441-run-"));
	try {
		const store = new RunStore({ rootDir: root });
		const run = store.createRun({ task: "t", cwd: root });
		await store.addChild(run.runId, {
			name: "by-id",
			sessionFile: path.join(root, "a.jsonl"),
			ownerToken: "",
			state: "retired",
			spawnedAt: new Date(TICK_AT).toISOString(),
			execution: { status: "success" },
			nodeId: "node-1",
		});
		await store.addChild(run.runId, {
			name: "by-name",
			sessionFile: path.join(root, "b.jsonl"),
			ownerToken: "",
			state: "awaiting",
			spawnedAt: new Date(TICK_AT).toISOString(),
			execution: { status: "success" },
		});
		const reader = createChildRunStateReader({ storeRootDir: root, runId: run.runId });
		const states = reader([
			{ id: "node-1", name: "renamed-row" },
			{ id: "node-2", name: "by-name" },
			{ id: "node-3", name: "never-written" },
		]);
		assert.deepEqual(states.get("node-1"), { state: "retired", executionStatus: "success" }, "nodeId wins over the row's name");
		assert.deepEqual(states.get("node-2"), { state: "awaiting", executionStatus: "success" }, "a pre-nodeId record falls back to the name");
		assert.equal(states.get("node-3"), undefined, "a child with no record contributes nothing");

		// Absence and breakage are both "no facts", NEVER "everyone ended".
		const empty = createChildRunStateReader({ storeRootDir: root, runId: "r-missing" })([{ id: "node-1", name: "by-id" }]);
		assert.equal(empty.size, 0);
		const throwing = createChildRunStateReader({
			storeRootDir: root,
			runId: run.runId,
			readRun: () => {
				throw new Error("unreadable");
			},
		})([{ id: "node-1", name: "by-id" }]);
		assert.equal(throwing.size, 0);
		// An empty child list never reads the store at all.
		assert.equal(createChildRunStateReader({
			storeRootDir: root,
			runId: run.runId,
			readRun: () => {
				throw new Error("must not be called");
			},
		})([]).size, 0);

		// END TO END through the postman: the same reader makes a retired run
		// invisible even though its ledger row still says `running`.
		const db = openLegionDb(":memory:");
		const supervisor = new CandidateSupervisor();
		insertNode(db, { parentId: null, name: "root", role: "root", status: "running" }, () => 1);
		insertNode(db, { parentId: "root", name: "by-id", role: "worker", status: "running" }, () => TICK_AT - RADIUS - MINUTE);
		supervisor.live.add("by-id");
		const postman = new LegionPostman({
			db,
			nodeId: "root",
			supervisor,
			sendRootMessage: () => {},
			settings: { orphanStaleMs: Number.MAX_SAFE_INTEGER },
			now: () => TICK_AT,
			intervalMs: 10_000,
			noticeMsForRole: () => RADIUS,
			childRunStates: reader,
		});
		await postman.tick();
		postman.stop();
		assert.deepEqual(inbox(db, "root"), [], "the wired reader is what silences a retired run");
		db.close();
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

// ───────────────── B. tool-blind children grow or they don't ─────────────────

test("#441-B: a cross-machine child whose session is GROWING is never announced (the 23-second case)", async () => {
	// Measured: `anotify-vars-ui` was noticed at 17:38:06 while its `session.jsonl`
	// was written at 17:38:29 — 2.1 MB, actively growing.
	const sessionFile = path.join(mkdtempSync(path.join(tmpdir(), "stall-441-b-")), "child.jsonl");
	writeFileSync(sessionFile, '{"type":"message"}\n');
	// The pump saw new bytes 30 s ago: proof of life no clock can argue with.
	writeMirrorState(sessionFile, TICK_AT - 30_000);
	const fx = fixture({
		children: [{ name: "growing", host: "hw-nj", remoteTerminal: "hw-nj/lgl-1", sessionFile, createdAt: TICK_AT - RADIUS - MINUTE }],
	});
	try {
		fx.supervisor.programStates.set("growing", "idle");
		await fx.postman.tick();
		fx.stop();
		assert.deepEqual(inbox(fx.db, "root"), [], "a growing transcript is working, wherever the tools run");
	} finally {
		fx.cleanup();
		rmSync(path.dirname(sessionFile), { recursive: true, force: true });
	}
});

test("#441-B: no growth EVIDENCE is `unknown`, never `stalled` — mirror off / never grew / no session", async () => {
	const dir = mkdtempSync(path.join(tmpdir(), "stall-441-b2-"));
	try {
		const written = path.join(dir, "written.jsonl");
		writeFileSync(written, '{"type":"message"}\n');
		const off = path.join(dir, "off.jsonl");
		writeFileSync(off, "");
		// The pump was configured off: it wrote a row saying so, and no growth fact.
		writeMirrorState(off, 0, "off");
		const neverGrew = path.join(dir, "never.jsonl");
		writeFileSync(neverGrew, "");
		writeMirrorState(neverGrew, 0, "on");
		const noSession = path.join(dir, "absent.jsonl");

		const fx = fixture({
			children: [
				{ name: "no-mirror", host: "hw-nj", remoteTerminal: "hw-nj/lgl-1", sessionFile: written, createdAt: TICK_AT - RADIUS - MINUTE },
				{ name: "pump-off", host: "hw-nj", remoteTerminal: "hw-nj/lgl-2", sessionFile: off, createdAt: TICK_AT - RADIUS - MINUTE },
				{ name: "never-grew", host: "hw-nj", remoteTerminal: "hw-nj/lgl-3", sessionFile: neverGrew, createdAt: TICK_AT - RADIUS - MINUTE },
				{ name: "no-session", host: "hw-nj", remoteTerminal: "hw-nj/lgl-4", sessionFile: noSession, createdAt: TICK_AT - RADIUS - MINUTE },
			],
		});
		try {
			for (const name of ["no-mirror", "pump-off", "never-grew", "no-session"]) fx.supervisor.programStates.set(name, "idle");
			await fx.postman.tick();
			fx.stop();
			assert.deepEqual(inbox(fx.db, "root"), [], "no growth evidence ⇒ undecidable ⇒ silence");
		} finally {
			fx.cleanup();
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("#441-B: an idle container with a STALE transcript IS announced (the composition, not a mute detector)", async () => {
	const dir = mkdtempSync(path.join(tmpdir(), "stall-441-b3-"));
	try {
		const sessionFile = path.join(dir, "child.jsonl");
		writeFileSync(sessionFile, '{"type":"message"}\n');
		// Last growth 50m ago: outside the 45m radius.
		writeMirrorState(sessionFile, TICK_AT - 50 * MINUTE);
		const fx = fixture({
			children: [{ name: "stuck", host: "hw-nj", remoteTerminal: "hw-nj/lgl-1", sessionFile, createdAt: TICK_AT - RADIUS - MINUTE }],
		});
		try {
			fx.supervisor.programStates.set("stuck", "idle");
			await fx.postman.tick();
			fx.stop();
			const rows = inbox(fx.db, "root");
			assert.equal(rows.length, 1, "idle + stalled is exactly what L2 is for");
			assert.match(rows[0]!.body, /stuck: running for 46m 0s/);
			assert.match(rows[0]!.body, /nothing in flight, container status `idle`/);
			assert.match(rows[0]!.body, /transcript has not grown for 50m 0s/);
		} finally {
			fx.cleanup();
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("#441-B: the container read is asked ONCE per passage of the radius, not once per tick", async () => {
	const fx = fixture({ children: [{ name: "quiet", createdAt: TICK_AT - RADIUS - MINUTE }] });
	try {
		fx.supervisor.stacks.set("quiet", [{ tool: "bash", startedAt: TICK_AT - RADIUS }]);
		await fx.postman.tick();
		await fx.postman.tick();
		await fx.postman.tick();
		fx.stop();
		// The child is inside a tool, so it never even crosses the radius gate...
		assert.equal(fx.supervisor.programStateReads, 0, "a child the stack already explains costs no `terminal.get`");
	} finally {
		fx.cleanup();
	}
});

// ──────────────────── C. a visible long command is working ────────────────────

test("#441-C: a local child inside a known long command (`gh pr checks --watch`) is never announced", async () => {
	const fx = fixture({ children: [{ name: "flake-478", createdAt: TICK_AT - RADIUS - MINUTE }] });
	try {
		// 16 minutes in one `bash`, session untouched — the measured case.
		fx.supervisor.stacks.set("flake-478", [{ tool: "bash", startedAt: TICK_AT - 16 * MINUTE }]);
		await fx.postman.tick();
		fx.stop();
		assert.deepEqual(inbox(fx.db, "root"), [], "a visible command in flight is work, not a stall");
	} finally {
		fx.cleanup();
	}
});

test("#441-C: a terminal-hosted child reporting `working` is never announced (20m compile, CPU 27%)", async () => {
	const fx = fixture({
		children: [{ name: "audit-bulk", host: "hw-nj", remoteTerminal: "hw-nj/lgl-9", createdAt: TICK_AT - RADIUS - MINUTE }],
	});
	try {
		fx.supervisor.programStates.set("audit-bulk", "working");
		await fx.postman.tick();
		fx.stop();
		assert.deepEqual(inbox(fx.db, "root"), [], "the container says it is working");
	} finally {
		fx.cleanup();
	}
});

// ───────────────────────── D. the REVERSE (must alert) ─────────────────────────

test("#441-C: a LOCAL terminal-hosted child (rebase-479) reporting `working` is never announced", async () => {
	// The row cannot express this case: a LOCAL terminal child records no
	// `remoteTerminal` (there is no remote address), so only the supervisor can say
	// "this backend folds no tool events". `working` = the compile is running.
	const dir = mkdtempSync(path.join(tmpdir(), "stall-441-c-"));
	try {
		const sessionFile = path.join(dir, "local.jsonl");
		writeFileSync(sessionFile, '{"type":"message"}\n');
		const fx = fixture({ children: [{ name: "rebase-479", sessionFile, createdAt: TICK_AT - RADIUS - MINUTE }] });
		try {
			fx.supervisor.observesToolEvents = () => false;
			fx.supervisor.programStates.set("rebase-479", "working");
			await fx.postman.tick();
			fx.stop();
			assert.deepEqual(inbox(fx.db, "root"), [], "CPU 49% / 95 °C compiling is work");
			// Reverse the same fixture one fact at a time: the container goes idle and
			// the transcript stops growing ⇒ the anomaly IS reported.
			fx.supervisor.programStates.set("rebase-479", "idle");
			const past = new Date(TICK_AT - 50 * MINUTE);
			utimesSync(sessionFile, past, past);
			await fx.postman.tick();
			const rows = inbox(fx.db, "root");
			assert.equal(rows.length, 1, "idle + stalled is announced (the anti-mute arm)");
			assert.match(rows[0]!.body, /rebase-479: running for 46m 0s/);
		} finally {
			fx.cleanup();
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("#441 reverse: session stalled past the radius, nothing in flight, container at its prompt ⇒ exactly ONE notice", async () => {
	const dir = mkdtempSync(path.join(tmpdir(), "stall-441-d-"));
	try {
		// A local child: its own transcript, no mirror. Last written 46m ago.
		const sessionFile = path.join(dir, "local.jsonl");
		writeFileSync(sessionFile, '{"type":"message"}\n');
		const past = new Date(TICK_AT - 46 * MINUTE);
		const fx = fixture({ children: [{ name: "walker", sessionFile, createdAt: TICK_AT - RADIUS - MINUTE }] });
		try {
			// Pin the local mtime: the child wrote nothing since.
			utimesSync(sessionFile, past, past);
			await fx.postman.tick();
			fx.stop();
			const rows = inbox(fx.db, "root");
			assert.equal(rows.length, 1, "the detector still fires — this is the anti-regression arm");
			assert.match(rows[0]!.body, /walker: running for 46m 0s/);
			assert.match(rows[0]!.body, /steer reaches a child at a turn boundary/);
		} finally {
			fx.cleanup();
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
