/**
 * #445 — the SESSION-START re-attach path, end to end.
 *
 * The unit file pins the decisions; this one runs them through the production
 * seams: the REAL `hc` client (against the fake core, so every round trip is a
 * real JSON-RPC call over a real child process), the REAL
 * `recoverCrossMachineChild` grading/settle ladder, and the REAL run record.
 *
 * The scenario is the one the issue measured, compressed in time:
 *
 *   - session A launched `worker-0` on `njbox` and is gone (a dead `owner.json`,
 *     the record the exit left says `orphaned`, the ledger row is still running);
 *   - session B starts in the same cwd and runs ONE pass — no `recover` call;
 *   - `worker-0` is listed again with `host=njbox state=working`;
 *   - the program ends over there and the watcher's next tick settles the row and
 *     delivers exactly ONE completion notice.
 *
 * Every failure mode the issue names has its own case: a live foreign owner, a
 * retired ledger row (the record still says `working`), an unreachable machine
 * (bounded), and the growth-only candidate whose transcript is the sole evidence.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { hcCliClient } from "../../src/hc/client.ts";
import { legionDbPath, openLegionDb } from "../../src/legion/db.ts";
import { getNode, insertNode, updateNode } from "../../src/legion/nodes.ts";
import { RUN_OWNER_FILE, writeOwnerFile } from "../../src/runs/owner.ts";
import { createRemoteTerminalProbe } from "../../src/runs/remote-artifact.ts";
import {
	createReattachSettle,
	createRemoteLineCount,
	formatReattachSummary,
	pendingReattachNotices,
	type ReattachReport,
	ReattachWatcher,
	runReattachPass,
} from "../../src/runs/reattach.ts";
import { RunStore } from "../../src/runs/store.ts";
import { classifyChildrenForStatus, renderStatusOverview } from "../../index.ts";
import { renderLiveChildStatus } from "../../src/extension/runtime.ts";
import { ownerState } from "../../src/runs/owner.ts";
import type { ChildRecord, CrossMachineSettings } from "../../src/shared/types.ts";
import { assistantMsg, modelChange, sessionHeader, userMsg } from "../helpers/fixtures.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE_CORE = path.resolve(HERE, "../helpers/fake-hc-core.mjs");
const HOST = "njbox";
const NAME = "worker-0";
const NODE_ID = `root.${NAME}`;

interface Harness {
	root: string;
	cwd: string;
	store: RunStore;
	runId: string;
	runDir: string;
	dbPath: string;
	/** Session A's transcript — the "previous session" identity. */
	previousSession: string;
	/** The ctx.sessionManager file of session B (this process). */
	newSession: string;
	remoteRoot: string;
	remoteCwd: string;
	remoteDir: string;
	remoteSessionPath: string;
	localSessionPath: string;
	settings: CrossMachineSettings;
	/** Where the manifest is written BEFORE a terminal is created. */
	terminalsFile: string;
	coreLog: string;
	cleanup: () => void;
}

function harness(prefix = "reattach-e2e-"): Harness {
	const root = mkdtempSync(path.join(tmpdir(), prefix));
	const cwd = path.join(root, "work");
	mkdirSync(cwd, { recursive: true });
	const remoteRoot = path.join(root, "remote");
	const remoteCwd = path.join(remoteRoot, "work");
	mkdirSync(remoteCwd, { recursive: true });
	const binDir = path.join(root, "bin");
	mkdirSync(binDir, { recursive: true });
	const wrapper = path.join(binDir, "hc");
	writeFileSync(wrapper, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(FAKE_CORE)} "$@"\n`, { mode: 0o755 });
	chmodSync(wrapper, 0o755);
	const terminalsFile = path.join(root, "terminals.json");
	writeFileSync(terminalsFile, "{}\n");
	const coreLog = path.join(root, "core.jsonl");
	// #445: terminals must survive the CLIENT process. `hcCliClient` spawns one core
	// per call, so without a state file the terminal "session A created" would not
	// exist for "session B" — the premise of this whole file.
	const terminalState = path.join(root, "terminal-state.json");
	const previous = { ...process.env };
	Object.assign(process.env, {
		HC_BIN: wrapper,
		FAKE_HC_REMOTE_ROOT: remoteRoot,
		FAKE_HC_MACHINES: HOST,
		FAKE_HC_LOG: coreLog,
		FAKE_HC_TERMINALS: terminalsFile,
		FAKE_HC_TERMINAL_STATE: terminalState,
	});

	const store = new RunStore({ rootDir: path.join(cwd, ".pi-subagents") });
	const previousSession = path.join(root, "sessions", "previous.jsonl");
	const newSession = path.join(root, "sessions", "new.jsonl");
	mkdirSync(path.dirname(previousSession), { recursive: true });
	writeFileSync(previousSession, "");
	writeFileSync(newSession, "");
	const run = store.createRun({ task: "ship the fix", cwd, sessionFile: previousSession });
	const runDir = store.runDir(run.runId);
	// The exit's marker: the pid is gone, i.e. exactly what a killed `pi` leaves.
	writeOwnerFile(path.join(runDir, RUN_OWNER_FILE), 2_147_483_000);
	const remoteDir = path.posix.join(remoteRoot, ".pi-subagents-mirror", run.runId, NAME);
	return {
		root,
		cwd,
		store,
		runId: run.runId,
		runDir,
		dbPath: legionDbPath(runDir),
		previousSession,
		newSession,
		remoteRoot,
		remoteCwd,
		remoteDir,
		remoteSessionPath: path.posix.join(remoteDir, "session.jsonl"),
		localSessionPath: path.join(remoteRoot, ".pi-subagents-mirror", run.runId, NAME, "session.jsonl"),
		settings: { enabled: true, hosts: { [HOST]: { cwd: remoteCwd } } },
		terminalsFile,
		coreLog,
		cleanup: () => {
			for (const key of ["HC_BIN", "FAKE_HC_REMOTE_ROOT", "FAKE_HC_MACHINES", "FAKE_HC_LOG", "FAKE_HC_TERMINALS", "FAKE_HC_TERMINAL_STATE"]) {
				if (previous[key] === undefined) delete process.env[key];
				else process.env[key] = previous[key];
			}
			rmSync(root, { recursive: true, force: true });
		},
	};
}

/** The transcript the child writes ON ITS MACHINE (a complete, gradeable turn). */
function finishedTranscript(text: string): string {
	return [
		sessionHeader({ cwd: "/srv/app" }),
		modelChange("workbuddy/deepseek-v4.1-flash"),
		userMsg("fix the flaky test"),
		assistantMsg({ text: `${text}\n{"ok": true, "reason": "tests pass"}`, stopReason: "stop" }),
	].join("\n") + "\n";
}

/**
 * Run one REAL `terminal.run` on the fake core — the same call a launch makes, so
 * the address the record carries is the address the core holds (not a guess).
 */
async function runRemoteTerminal(h: Harness, opts: { finishAfterMs?: number; transcript?: string } = {}): Promise<string> {
	const manifest: Record<string, unknown> = {
		state: "running",
		...(opts.finishAfterMs !== undefined ? { finish_after_ms: opts.finishAfterMs } : {}),
		...(opts.transcript !== undefined
			? { writes: [{ path: h.remoteSessionPath, text: opts.transcript }] }
			: {}),
	};
	// `"*"` is the fake core's fallback key: the terminal is created under the
	// launch-shaped name (`lgl-<runId>-<handle>`), not under the bare handle.
	writeFileSync(h.terminalsFile, `${JSON.stringify({ "*": manifest })}\n`);
	const client = hcCliClient({ env: process.env });
	await client.start();
	try {
		const result = await client.request<{ address: string }>("terminal.run", {
			on: HOST,
			name: `lgl-${h.runId}-${NAME}`,
			argv: [path.posix.join(h.remoteRoot, "bin", "pi")],
			cwd: h.remoteCwd,
		});
		return result.address;
	} finally {
		client.close();
	}
}

/** The record session A left: cross-machine, owed, with the exit's marker. */
async function seedLeftover(h: Harness, overrides: Partial<ChildRecord> = {}, terminal?: string): Promise<void> {
	await h.store.addChild(h.runId, {
		name: NAME,
		sessionFile: path.join(h.runDir, `${NAME}.jsonl`),
		ownerToken: "tok",
		state: "orphaned",
		spawnedAt: new Date(Date.now() - 120_000).toISOString(),
		host: HOST,
		remoteDir: h.remoteDir,
		...(terminal ? { remoteTerminal: terminal } : {}),
		nodeId: NODE_ID,
		orphaned: { at: Date.now() - 60_000, fate: "orphaned", reason: "session-shutdown", host: HOST, remoteDir: h.remoteDir },
		...overrides,
	});
}

/** The ledger row the launch inserted (root + a running cross-machine child). */
function seedLedger(h: Harness, opts: { status?: "running" | "settled" | "retired" | "failed"; terminal?: string } = {}): void {
	const db = openLegionDb(h.dbPath);
	try {
		insertNode(db, { id: "root", parentId: null, name: "root", role: "root", kind: "pi", depth: 0, runId: h.runId, status: "running" });
		insertNode(db, {
			parentId: "root",
			name: NAME,
			role: "worker",
			kind: "pi",
			status: opts.status ?? "running",
			host: HOST,
			remoteDir: h.remoteDir,
			...(opts.terminal ? { remoteTerminal: opts.terminal } : {}),
			sessionFile: path.join(h.runDir, `${NAME}.jsonl`),
		});
	} finally {
		db.close();
	}
}

/** `subagent({action:"status"})`'s overview, from the real store + the real renderers. */
function renderStatus(h: Harness): string {
	const runs = h.store.listRuns();
	const classified = classifyChildrenForStatus(runs, (child) => ({
		alive: false,
		owner: ownerState(path.join(h.runDir, RUN_OWNER_FILE)),
	}));
	return renderStatusOverview(
		classified.map(({ child, live }) => ({
			child,
			alive: false,
			owner: ownerState(path.join(h.runDir, RUN_OWNER_FILE)),
			live,
		})),
		Date.now(),
	);
}

/** A watcher wired to the PRODUCTION settle seam, with a recording notice sink. */
function productionWatcher(h: Harness) {
	const notices: string[] = [];
	const latched: number[] = [];
	const records: string[] = [];
	const watcher = new ReattachWatcher({
		probe: createRemoteTerminalProbe({ crossMachine: h.settings }),
		settle: createReattachSettle(h.settings),
		notify: (notice) => {
			notices.push(notice.content);
			return true;
		},
		recordSettlement: async (target, recovery) => {
			records.push(recovery.execution.status);
			await h.store.updateChild(target.runId, target.name, (child) => {
				child.state = "retired";
				child.retiredAt = new Date().toISOString();
				child.execution = recovery.execution;
				child.acceptance = recovery.acceptance;
				delete child.orphaned;
			});
		},
		markNotified: async (target, at) => {
			latched.push(at);
			await h.store.updateChild(target.runId, target.name, (child) => {
				if (child.reattached) child.reattached.notifiedAt ??= at;
			});
		},
		log: () => {},
	});
	return { watcher, notices, latched, records };
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ── acceptance 1: the end-to-end the issue asks for ────────────────────────

test("#445 A1: session B re-attaches A's live child without a `recover` call, then its completion arrives on its own", async () => {
	const h = harness();
	try {
		const terminal = await runRemoteTerminal(h, { finishAfterMs: 1_200, transcript: finishedTranscript("all green") });
		await seedLeftover(h, {}, terminal);
		seedLedger(h, { terminal });

		// ── session B starts ────────────────────────────────────────────────────
		const report: ReattachReport = await runReattachPass({
			store: h.store,
			sessionFile: h.newSession,
			settings: { crossMachine: h.settings },
			listMirrorOrphans: async () => [],
			log: () => {},
		});
		assert.equal(report.adopted.length, 1, `expected one adoption, got ${JSON.stringify(report.skipped)}`);
		assert.equal(report.adopted[0]!.terminal, terminal);
		assert.match(report.adopted[0]!.evidence, /is live/);
		assert.match(formatReattachSummary(report) ?? "", /^legion: reattached 1 live child \(worker-0\)/);

		// ── `status` shows it again (host + name + state=working) ───────────────
		const status = renderStatus(h);
		assert.match(status, /worker-0 — state=working/);
		assert.match(status, new RegExp(`host=${HOST}`));
		assert.match(status, /Status · 1 live child/);
		assert.match(status, new RegExp(`terminal=${terminal.replace("/", "\\/")}`));

		// The record is re-opened, not merely displayed: the exit's marker is gone.
		const record = h.store.findChild(h.runId, NAME)!;
		assert.equal(record.state, "working");
		assert.equal(record.orphaned, undefined);
		assert.equal(record.reattached?.host, HOST);

		// ── the program ends over there; the watcher settles + notifies ─────────
		const { watcher, notices, latched } = productionWatcher(h);
		watcher.add({
			runId: h.runId,
			name: NAME,
			host: HOST,
			nodeId: NODE_ID,
			remoteTerminal: terminal,
			ledgerDbPath: h.dbPath,
		});
		await delay(1_300);
		await watcher.tick();

		assert.equal(notices.length, 1, "exactly one completion notice");
		assert.match(notices[0]!, /Background task completed: \*\*worker-0\*\*/);
		assert.match(notices[0]!, /execution: success/);
		assert.equal(latched.length, 1);
		assert.equal(watcher.watching().length, 0);
		assert.deepEqual(pendingReattachNotices(h.store), [], "the latch means a later session owes nothing");

		// The ledger row is settled by the SAME ladder a collect/recover uses.
		const db = openLegionDb(h.dbPath);
		try {
			assert.equal(getNode(db, NODE_ID)?.status, "settled");
		} finally {
			db.close();
		}
		// The run record followed, so `status` no longer claims `working`.
		assert.equal(h.store.findChild(h.runId, NAME)!.state, "retired");
		assert.equal(h.store.findChild(h.runId, NAME)!.execution?.status, "success");

		// A SECOND session-start pass (a restart) adopts nothing and announces nothing:
		// both rows are terminal and the latch is written.
		const again = await runReattachPass({
			store: h.store,
			sessionFile: h.newSession,
			settings: { crossMachine: h.settings },
			listMirrorOrphans: async () => [],
			log: () => {},
		});
		assert.equal(again.adopted.length, 0);
		assert.equal(formatReattachSummary(again), undefined);
		assert.deepEqual(pendingReattachNotices(h.store), []);
		assert.deepEqual(notices.length, 1, "no second notice, ever");
	} finally {
		h.cleanup();
	}
});

// ── acceptance 2: never take a child another live session holds ────────────

test("#445 A2: a child a LIVE session still holds is left alone, and the log says `owned by <session>`", async () => {
	const h = harness("reattach-e2e-owned-");
	const other = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
	try {
		const terminal = await runRemoteTerminal(h, { transcript: finishedTranscript("still mine") });
		await seedLeftover(h, {}, terminal);
		seedLedger(h, { terminal });
		// Session A is ALIVE: its pid is real, and it is not this process.
		writeOwnerFile(path.join(h.runDir, RUN_OWNER_FILE), other.pid!);

		const lines: string[] = [];
		const report = await runReattachPass({
			store: h.store,
			sessionFile: h.newSession,
			settings: { crossMachine: h.settings },
			listMirrorOrphans: async () => [],
			log: (line) => lines.push(line),
		});
		assert.equal(report.adopted.length, 0);
		assert.equal(report.considered, 0, "a held row is not even probed");
		assert.match(report.skipped[0]!.reason, /^owned by previous\.jsonl/);
		assert.match(lines.join("\n"), /skipped worker-0 .*: owned by previous\.jsonl/);
		// The other session's record is untouched: still `orphaned`, still no latch.
		const record = h.store.findChild(h.runId, NAME)!;
		assert.equal(record.state, "orphaned");
		assert.equal(record.reattached, undefined);
	} finally {
		other.kill("SIGKILL");
		h.cleanup();
	}
});

// ── acceptance 3: a retired row is a ghost, not a child ────────────────────

test("#445 A3: a retired LEDGER row is neither adopted nor announced, even though the record says `working`", async () => {
	const h = harness("reattach-e2e-ghost-");
	try {
		const terminal = await runRemoteTerminal(h, { transcript: finishedTranscript("long over") });
		// The #441 shape: the RECORD was never updated, the ROW is terminal.
		await seedLeftover(h, { state: "working", orphaned: undefined }, terminal);
		seedLedger(h, { terminal });
		const db = openLegionDb(h.dbPath);
		try {
			updateNode(db, NODE_ID, { status: "retired" });
		} finally {
			db.close();
		}
		const report = await runReattachPass({
			store: h.store,
			sessionFile: h.newSession,
			settings: { crossMachine: h.settings },
			listMirrorOrphans: async () => [],
			log: () => {},
		});
		assert.equal(report.adopted.length, 0);
		assert.equal(report.considered, 0);
		assert.match(report.skipped[0]!.reason, /already ended \(retired\).*not adopted and not announced/);
		assert.equal(h.store.findChild(h.runId, NAME)!.state, "working", "a ghost row is left exactly as found");
		assert.equal(formatReattachSummary(report), undefined, "nothing to say");
	} finally {
		h.cleanup();
	}
});

// ── acceptance 4: an unreachable machine is a reason, not a crash ──────────

/**
 * A core that ACCEPTS the handshake, then dies with our write end still open.
 *
 * This is what a crashing/slow `hc` looks like from this side: the NEXT frame is
 * written into a pipe whose read end is already gone (`write EPIPE`). The old
 * `exit 3` binary could produce the same fact, but only by winning a race against
 * the first write — which is exactly how it took CI down once (#447: the test
 * process died of an uncaught EPIPE instead of the machine being reported).
 *
 * Closing stdin BEFORE replying makes the race impossible: by the time the client
 * sees `hello` answered, the next write is guaranteed to hit a dead pipe.
 */
function writeDyingCore(h: Harness): string {
	const dying = path.join(h.root, "bin", "hc-dying");
	writeFileSync(
		dying,
		[
			"#!/bin/sh",
			"IFS= read -r hello",
			"exec 0<&-",
			`printf '%s\\n' '{"jsonrpc":"2.0","id":1,"result":{}}'`,
			"sleep 1",
			"exit 3",
			"",
		].join("\n"),
		{ mode: 0o755 },
	);
	chmodSync(dying, 0o755);
	return dying;
}

test("#445 A4: an unreachable machine is a reason (never a crash), and its cost is bounded by the injected budget", async () => {
	const h = harness("reattach-e2e-down-");
	try {
		await seedLeftover(h, { remoteTerminal: `${HOST}/lgl-gone` });
		seedLedger(h, { terminal: `${HOST}/lgl-gone` });
		process.env.HC_BIN = writeDyingCore(h);

		const started = Date.now();
		const report = await runReattachPass({
			store: h.store,
			sessionFile: h.newSession,
			settings: { crossMachine: h.settings },
			listMirrorOrphans: async () => [],
			log: () => {},
		});
		const elapsed = Date.now() - started;
		// NOT a budget assertion: the pass is not promised to finish inside 5s on a
		// loaded CI box (and a wall clock is not evidence anyway). This is the "did not
		// hang forever" backstop only; the bound itself is proven below with the clock.
		assert.ok(elapsed < 30_000, `the pass did not return for ${elapsed}ms — a dead machine must not hang session start`);
		// A dead pipe is a BUSINESS fact: the report comes back, the machine is named.
		assert.equal(report.error, undefined, `the pass reported an error instead of a skip: ${report.error}`);
		assert.equal(report.adopted.length, 0);
		assert.match(report.skipped[0]!.reason, /no liveness evidence: host 'njbox' could not be asked/);
		assert.equal(h.store.findChild(h.runId, NAME)!.state, "orphaned", "an unknown machine adopts nothing");

		// "The whole pass is bounded" without a clock: a budget that is already spent
		// DEFERS the candidate (and names the retry) instead of probing it. The injected
		// clock advances on every read, so this is deterministic — no sleeping, no ≤5s.
		let clock = 1_000;
		const expired = await runReattachPass({
			store: h.store,
			sessionFile: h.newSession,
			settings: { crossMachine: h.settings },
			listMirrorOrphans: async () => [],
			budgetMs: 1,
			now: () => (clock += 10),
			log: () => {},
		});
		assert.equal(expired.considered, 0, "a spent budget must not probe");
		assert.equal(expired.deferred, 1, "a spent budget defers the leftover to the next start");
		assert.equal(expired.adopted.length, 0);
		assert.match(formatReattachSummary(expired) ?? "", /the next start retries/);
	} finally {
		h.cleanup();
	}
});

// ── the growth-only candidate (no terminal address recorded) ────────────────

test("#445: with no recorded terminal, a GROWING transcript on that machine is the evidence (real `file.read`, driven growth)", async () => {
	const h = harness("reattach-e2e-growth-");
	try {
		const transcript = finishedTranscript("writing slowly");
		mkdirSync(path.dirname(h.localSessionPath), { recursive: true });
		writeFileSync(h.localSessionPath, transcript);
		// No terminal address: the record predates `remote_terminal` (schema v4 records).
		await seedLeftover(h, { state: "working", orphaned: undefined });
		seedLedger(h);

		// The REAL production counter against the REAL `file.read`: the evidence is a
		// fact about the file on that machine, not a number this test made up. This one
		// sample also fails loudly if the wire is down, instead of being swallowed into
		// "first sample failed" (the #447 CI shape).
		const remoteLines = createRemoteLineCount(h.settings);
		const before = await remoteLines({ host: HOST, remotePath: h.remoteSessionPath });
		assert.equal(typeof before, "number", `the machine must size its own transcript, got ${String(before)}`);

		// GROWTH IS DRIVEN, NOT RACED. The old shape wrote from a 60ms interval and hoped
		// the two samples landed around the writes; on CI the first sample could fail
		// outright (and filesystem/clock granularity was never the point). Here the
		// transcript gains exactly one line between sample 1 and sample 2 — both samples
		// are still real `file.read` round trips.
		const base = before as number;
		let samples = 0;
		const report = await runReattachPass({
			store: h.store,
			sessionFile: h.newSession,
			settings: { crossMachine: h.settings },
			listMirrorOrphans: async () => [],
			growthWaitMs: 300,
			remoteLines: async (request) => {
				const lines = await remoteLines(request);
				samples += 1;
				if (samples === 1 && lines !== undefined) appendFileSync(h.localSessionPath, "line-added-between-samples\n");
				return lines;
			},
			log: () => {},
		});
		assert.equal(samples, 2, "the growth decision reads two samples");
		assert.equal(report.adopted.length, 1, JSON.stringify(report.skipped));
		assert.deepEqual(
			report.adopted[0]!.evidence,
			`transcript ${h.remoteSessionPath} is growing (${base} → ${base + 1} lines in 300ms)`,
		);
	} finally {
		h.cleanup();
	}
});

// ── the mirror-only orphan source ──────────────────────────────────────────

test("#445 §1: a `no-run` mirror dir is REPORTED (one line) and never adopted", async () => {
	const h = harness("reattach-e2e-orphan-");
	try {
		// A real directory on that machine, with a transcript in it.
		const orphanDir = path.posix.join(h.remoteRoot, ".pi-subagents-mirror", "no-run", "anotify-uishift-budget");
		mkdirSync(orphanDir, { recursive: true });
		writeFileSync(path.join(orphanDir, "session.jsonl"), finishedTranscript("orphan"));
		// Nothing in the run store: the ONLY source is the mirror dir.
		const report = await runReattachPass({
			store: h.store,
			sessionFile: h.newSession,
			settings: { crossMachine: h.settings },
			// One reachable host is required for the scan; the store has no candidate,
			// so the host set is taken from the mirror scan itself (see the pass).
			listMirrorOrphans: async (host) => (host === HOST
				? [{ name: "anotify-uishift-budget", path: path.posix.join(orphanDir, "session.jsonl") }]
				: []),
			probeTerminal: createRemoteTerminalProbe({ crossMachine: h.settings }),
			log: () => {},
		});
		assert.equal(report.adopted.length, 0, "a mirror-only orphan has no row, so it is never adopted");
		assert.equal(report.mirrorOnly.length, 1);
		assert.equal(report.mirrorOnly[0]!.name, "anotify-uishift-budget");
	} finally {
		h.cleanup();
	}
});

// ── `status` before and after: the whole point of the issue ────────────────

test("#445: WITHOUT the pass, `status` shows the leftover as a dead/orphaned record — the user's \"my tasks are gone\"", async () => {
	const h = harness("reattach-e2e-before-");
	try {
		const terminal = await runRemoteTerminal(h, { transcript: finishedTranscript("alive but invisible") });
		await seedLeftover(h, {}, terminal);
		seedLedger(h, { terminal });
		const status = renderStatus(h);
		assert.match(status, /worker-0 — /);
		assert.doesNotMatch(status, /state=working/, "before the pass the record does not claim it is working");
		assert.doesNotMatch(status, /Status · 1 live child/);
		// And the single-child renderer says what the record says: no live owner.
		const single = renderLiveChildStatus({
			name: NAME,
			state: "orphaned",
			sessionFile: path.join(h.runDir, `${NAME}.jsonl`),
			host: HOST,
			remoteTerminal: terminal,
			alive: false,
			owner: ownerState(path.join(h.runDir, RUN_OWNER_FILE)),
		});
		assert.match(single, /owner: dead/);
	} finally {
		h.cleanup();
	}
});

// A harness guard: the fake core really served these calls (so a silent fallback
// to "no wire" cannot make an above case green).
test("#445: the fake core answered the re-attach's `terminal.get` (the evidence was a real round trip)", async () => {
	const h = harness("reattach-e2e-wire-");
	try {
		const terminal = await runRemoteTerminal(h, { transcript: finishedTranscript("ping") });
		await seedLeftover(h, {}, terminal);
		seedLedger(h, { terminal });
		await runReattachPass({
			store: h.store,
			sessionFile: h.newSession,
			settings: { crossMachine: h.settings },
			listMirrorOrphans: async () => [],
			log: () => {},
		});
		const log = existsSync(h.coreLog) ? readFileSync(h.coreLog, "utf8") : "";
		assert.match(log, /"terminal\.get"/);
		assert.match(log, new RegExp(terminal.replace("/", "\\/")));
	} finally {
		h.cleanup();
	}
});
