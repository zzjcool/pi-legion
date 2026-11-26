/**
 * #456 — reclaiming an ORPHANED row, end to end, through the production surfaces.
 *
 * The situation the issue measured: yesterday's session launched a child on another
 * machine, the session exited, and what it left behind is a row nothing can close —
 * run.json says `orphaned`, the ledger row is still `running`, the previous process
 * is gone (so no postman tick converges it), and the remote terminal keeps the
 * process alive on that machine. After a restart there was NO way out:
 * `subagent({action:"stop", name})` answered `unknown child … (not tracked by this
 * session)` forever, and `status` printed `state=orphaned`, which reads exactly like
 * a child that is still working over there.
 *
 * The unit files pin the decisions (`test/unit/orphan-reclaim-status.test.ts` the
 * rendering, the reclaim ladder its own rules). This file is the acceptance proof,
 * and it deliberately runs over the REAL seams: a real `hc` JSON-RPC client against
 * the fake core (`test/helpers/fake-hc-core.mjs`, durable terminals), the real
 * `run.json` and the real SQLite ledger, and the real `subagent` tool's `execute`.
 * Nothing here is stubbed: a green case means the calls a user makes actually do it.
 *
 * The eight pillars (issue numbers refer to the acceptance list in #456):
 *
 *   A1  a dead leftover is VISIBLE as `orphaned (terminal gone, work done)` and one
 *       `stop` reclaims it: ledger settled from the graded transcript, run.json
 *       retired, one `reclaimed …` line in `<storeRoot>/orphan-reclaim.log`.
 *   A2  REVERSE: a terminal whose transcript is still GROWING is refused — nothing
 *       is killed, nothing is written. "The terminal exists" is not "the work is
 *       over" (a kept terminal stays `running` after its program exits).
 *   A3  a terminal the core does not hold must still settle: a missing terminal can
 *       never become a hang (the ledger row is retired, not graded — there is
 *       nothing to grade).
 *   A4  the #445 owner gate survives: a row whose `owner.json` pid is ALIVE and is
 *       not this process is not even probed, let alone killed.
 *   A5  the empirical cross-store case (#450's surface): the leftover lives in
 *       ANOTHER store, and `status`/`stop` find it through the bounded surface.
 *   A6  idempotence: a second `stop` after the reclaim is an honest no-op, and the
 *       ledger holds exactly ONE settle event for the node.
 *   A7  a record with NO recorded terminal address is never settled on the core's
 *       "missing" answer for an inferred spelling — the address is not proof, so
 *       the row stays visible (`unknown`), untouched.
 *   A8  the POSITIVE stale-orphan path: a kept terminal idle at the prompt is
 *       really killed over `hc`, then settled from the graded transcript.
 *
 * Every case builds its own temp tree (`mkdtemp`) and restores every env var it
 * touched in a `finally`, so the suite is order-independent and leaves nothing on
 * disk. Waits are driven, not raced: the only real sleep is the growth sample
 * (~1.2s, the production bound) in A2, which is the one case that MUST watch a
 * file change while the call is in flight.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import piLegion from "../../index.ts";
import { hcCliClient } from "../../src/hc/client.ts";
import { legionDbPath, openLegionDb, type DatabaseSync } from "../../src/legion/db.ts";
import { appendEvent, readEventsAfter } from "../../src/legion/events.ts";
import { getNode, insertNode, listUnsettledRemoteNodes } from "../../src/legion/nodes.ts";
import { RUN_OWNER_FILE, writeOwnerFile } from "../../src/runs/owner.ts";
import { RunStore } from "../../src/runs/store.ts";
import type { ChildRecord } from "../../src/shared/types.ts";
import { FakeSupervisor } from "../helpers/fake-supervisor.ts";
import { assistantMsg, modelChange, sessionHeader, userMsg } from "../helpers/fixtures.ts";

initTheme("dark");

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE_CORE = path.resolve(HERE, "../helpers/fake-hc-core.mjs");
const HOST = "njbox";
const NAME = "worker-0";
const NODE_ID = `root.${NAME}`;
/** Cannot exist as a pid on any supported platform: the shape of a killed session. */
const DEAD_PID = 2_147_483_000;
/** `<storeRoot>/orphan-reclaim.log` — the per-store reclaim log the caller names in its answer. */
const RECLAIM_LOG = "orphan-reclaim.log";

const SCOUT_FILE =
	"---\nname: scout\ndescription: read-only utility role\nutility: true\ntools: read, grep, find, ls\nkind: pi\n---\nscout prompt\n";
const WORKER_FILE = "---\nname: worker\ndescription: worker role\n---\nworker prompt\n";

/** Vars this file SETS (restored to their previous value, or deleted). */
const SET_KEYS = [
	"HC_BIN",
	"FAKE_HC_REMOTE_ROOT",
	"FAKE_HC_MACHINES",
	"FAKE_HC_LOG",
	"FAKE_HC_TERMINALS",
	"FAKE_HC_TERMINAL_STATE",
	"PI_CODING_AGENT_DIR",
	"PI_LEGION_EXTRA_AGENT_DIRS",
] as const;
/**
 * Vars this file must DELETE for the duration of a case: a nested-agent identity or
 * another session's ledger would change what the extension thinks it is. The runner
 * already unsets them; clearing here means the file is correct on its own.
 */
const CLEAR_KEYS = [
	"PI_SUBAGENT_ROLE",
	"PI_SUBAGENT_ACCEPTANCE_ROLE",
	"PI_SUBAGENT_ALLOW_NESTED",
	"PI_SUBAGENT_CHILD",
	"PI_SUBAGENT_UTILITY_CHILD",
	"PI_SUBAGENT_MAX_DEPTH",
	"PI_SUBAGENT_PARENT_PATH",
	"PI_LEGION_DB",
	"PI_LEGION_NODE_ID",
	"PI_SUBAGENTS_TEAM",
	"HC_TERMINAL_SOCKET",
	"HC_TERMINAL_ID",
	// The Herdr-era spelling of the extra agent dirs: cleared so the developer's
	// environment cannot inject roles, and so the run emits no deprecation warning.
	"PI_HERDR_SUBAGENTS_EXTRA_AGENT_DIRS",
] as const;
const ENV_KEYS: readonly string[] = [...SET_KEYS, ...CLEAR_KEYS, "HOME"];

type ToolResult = { content?: Array<{ text?: string }>; details?: { error?: string; [key: string]: unknown } };

interface Harness {
	root: string;
	/** The session cwd: `<root>/work`, so the session store is `<root>/work/.pi-subagents`. */
	work: string;
	storeRoot: string;
	store: RunStore;
	runId: string;
	runDir: string;
	dbPath: string;
	/** The transcript session A (the previous process) owned. */
	previousSession: string;
	/** This session's transcript, the "who" a reclaim names. */
	sessionFile: string;
	remoteRoot: string;
	/** A directory ON "that machine" a launch may start in. */
	remoteWork: string;
	remoteDir: string;
	/** The transcript's path ON that machine (= a real file under `remoteRoot`). */
	remoteSessionPath: string;
	terminalsFile: string;
	coreLog: string;
	invoke(params: Record<string, unknown>, ctxCwd?: string): Promise<{ text: string; details?: { error?: string; [key: string]: unknown } }>;
	cleanup(): Promise<void>;
}

interface HarnessOptions {
	prefix?: string;
	/**
	 * A5 only: make `$HOME` the temp root so the bounded discovery walk
	 * (`src/runs/store-scan.ts`) sees the sibling directory that holds the OLD
	 * store. Without it a temp cwd is (by design) hermetic and scans its own store
	 * only — which is why the cross-store case needs this one axis pinned.
	 */
	homeIsRoot?: boolean;
}

function harness(opts: HarnessOptions = {}): Harness {
	const root = mkdtempSync(path.join(tmpdir(), opts.prefix ?? "orphan-reclaim-e2e-"));
	const work = path.join(root, "work");
	mkdirSync(work, { recursive: true });
	const remoteRoot = path.join(root, "remote");
	const remoteWork = path.join(remoteRoot, "work");
	mkdirSync(remoteWork, { recursive: true });

	// The real `hc` entry point: `hcCliClient` resolves `HC_BIN` first, so every
	// round trip below is a real JSON-RPC call over a real child process.
	const binDir = path.join(root, "bin");
	mkdirSync(binDir, { recursive: true });
	const wrapper = path.join(binDir, "hc");
	writeFileSync(wrapper, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(FAKE_CORE)} "$@"\n`, { mode: 0o755 });
	chmodSync(wrapper, 0o755);
	// Where the manifest is written BEFORE a terminal is created (read per `terminal.run`).
	const terminalsFile = path.join(root, "terminals.json");
	writeFileSync(terminalsFile, "{}\n");
	const coreLog = path.join(root, "core.jsonl");
	// #445: terminals must survive the CLIENT process. `hcCliClient` spawns one core
	// per call, so without a state file the terminal "the previous session created"
	// would not exist for this one — the premise of every case below.
	const terminalState = path.join(root, "terminal-state.json");

	// The extension's own settings: cross-machine must be enabled for the reclaim's
	// read-back/probe to reach the fake core, and the builtin roles are replaced by
	// the two files below so the catalog never depends on the developer's machine.
	const agentDir = path.join(root, "agent-config");
	const extraAgentsDir = path.join(root, "extra-agents");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(extraAgentsDir, { recursive: true });
	writeFileSync(
		path.join(agentDir, "settings.json"),
		JSON.stringify({
			subagents: {
				disableBuiltins: true,
				crossMachine: { enabled: true, hosts: { [HOST]: { cwd: remoteWork } } },
			},
		}),
	);
	writeFileSync(path.join(extraAgentsDir, "scout.md"), SCOUT_FILE);
	writeFileSync(path.join(extraAgentsDir, "worker.md"), WORKER_FILE);

	const previous = new Map(ENV_KEYS.map((name) => [name, process.env[name] as string | undefined]));
	Object.assign(process.env, {
		HC_BIN: wrapper,
		FAKE_HC_REMOTE_ROOT: remoteRoot,
		FAKE_HC_MACHINES: HOST,
		FAKE_HC_LOG: coreLog,
		FAKE_HC_TERMINALS: terminalsFile,
		FAKE_HC_TERMINAL_STATE: terminalState,
		PI_CODING_AGENT_DIR: agentDir,
		PI_LEGION_EXTRA_AGENT_DIRS: extraAgentsDir,
		...(opts.homeIsRoot ? { HOME: root } : {}),
	});
	for (const name of CLEAR_KEYS) delete process.env[name];

	// The store the SESSION uses: `<cwd>/.pi-subagents`, exactly what the tool loads.
	const store = new RunStore({ rootDir: path.join(work, ".pi-subagents") });
	const previousSession = path.join(root, "sessions", "previous.jsonl");
	const sessionFile = path.join(root, "sessions", "current.jsonl");
	mkdirSync(path.dirname(previousSession), { recursive: true });
	writeFileSync(previousSession, "");
	writeFileSync(sessionFile, "");
	const run = store.createRun({ task: "ship the fix", cwd: work, sessionFile: previousSession });
	const runDir = store.runDir(run.runId);
	// The exit's marker: the pid belongs to the process that launched the child, and
	// that process is gone — exactly what a killed `pi` leaves.
	writeOwnerFile(path.join(runDir, RUN_OWNER_FILE), DEAD_PID);

	const tools = new Map<string, { execute: (...args: unknown[]) => Promise<ToolResult> }>();
	const handlers = new Map<string, (...args: unknown[]) => unknown>();
	const supervisor = new FakeSupervisor({ autoSettle: { text: '{"ok":true}' }, immediateTimeout: false });
	const pi = {
		registerTool(value: unknown) {
			const typed = value as { name: string; execute: (...args: unknown[]) => Promise<ToolResult> };
			tools.set(typed.name, typed);
		},
		registerCommand() {},
		registerMessageRenderer() {},
		sendMessage() {},
		events: { emit() {} },
		on(name: string, handler: (...args: unknown[]) => unknown) {
			handlers.set(name, handler);
		},
	};
	piLegion(pi as never, { supervisor });
	const tool = tools.get("subagent");
	assert.ok(tool, "the `subagent` tool must be registered");

	const remoteDir = path.posix.join(remoteRoot, ".pi-subagents-mirror", run.runId, NAME);
	const h: Harness = {
		root,
		work,
		storeRoot: store.rootDir,
		store,
		runId: run.runId,
		runDir,
		dbPath: legionDbPath(runDir),
		previousSession,
		sessionFile,
		remoteRoot,
		remoteWork,
		remoteDir,
		remoteSessionPath: path.posix.join(remoteDir, "session.jsonl"),
		terminalsFile,
		coreLog,
		async invoke(params, ctxCwd = work) {
			const result = await tool.execute(
				"orphan-reclaim-test",
				params,
				undefined,
				undefined,
				{
					cwd: ctxCwd,
					hasUI: false,
					ui: { notify() {}, setStatus() {} },
					// The reclaim's log line says WHO did it (`by=session:<file>`), so the
					// session identity has to be the real one — the same accessor the host
					// offers (`ctx.sessionManager.getSessionFile`).
					sessionManager: { getSessionFile: () => sessionFile },
				},
			);
			return {
				text: (result.content ?? []).map((item) => item.text ?? "").join("\n"),
				details: result.details,
			};
		},
		async cleanup() {
			await handlers.get("session_shutdown")?.();
			for (const [name, value] of previous) {
				if (value === undefined) delete process.env[name];
				else process.env[name] = value;
			}
			rmSync(root, { recursive: true, force: true });
		},
	};
	return h;
}

// ── fixtures ────────────────────────────────────────────────────────────────

/** The transcript the child writes ON ITS MACHINE: a complete, gradeable turn. */
function finishedTranscript(text: string): string {
	return [
		sessionHeader({ cwd: "/srv/app" }),
		modelChange("workbuddy/deepseek-v4.1-flash"),
		userMsg("fix the flaky test"),
		assistantMsg({ text: `${text}\n{"ok": true, "reason": "tests pass"}`, stopReason: "stop" }),
	].join("\n") + "\n";
}

interface TerminalFate {
	/** The TERMINAL's state: `running` (kept after the program exits) or `finished`. */
	state?: "running" | "finished";
	/** The PROGRAM's own word while the terminal is `running` (#456 in the fake core). */
	programState?: "idle" | "working" | "done" | "error";
	exitCode?: number;
	/** The transcript written at `terminal.run` (absent = the child wrote nothing). */
	transcript?: string;
	/** Where the transcript is written ON that machine (defaults to this store's mirror dir). */
	transcriptPath?: string;
}

/**
 * Create one terminal on the fake core with a REAL `terminal.run` — the same call a
 * launch makes, so the address the record carries is an address the core holds (not
 * a guess), and it survives into the next `hc` process through the durable state.
 */
async function startTerminal(h: Harness, fate: TerminalFate): Promise<string> {
	const manifest: Record<string, unknown> = {
		state: fate.state ?? "running",
		...(fate.programState !== undefined ? { program_state: fate.programState } : {}),
		...(fate.exitCode !== undefined ? { exit_code: fate.exitCode } : {}),
		...(fate.transcript !== undefined
			? { writes: [{ path: fate.transcriptPath ?? h.remoteSessionPath, text: fate.transcript }] }
			: {}),
	};
	// `"*"` is the fake core's fallback key: the terminal is created under the
	// launch-shaped name, not under the bare handle.
	writeFileSync(h.terminalsFile, `${JSON.stringify({ "*": manifest })}\n`);
	const client = hcCliClient({ env: process.env });
	try {
		await client.start();
		const result = await client.request<{ address: string }>("terminal.run", {
			on: HOST,
			name: `lgl-${h.runId}-${NAME}`,
			argv: [path.posix.join(h.remoteRoot, "bin", "pi")],
			cwd: h.remoteWork,
		});
		return result.address;
	} finally {
		client.close();
	}
}

/** The record the previous session left: cross-machine, owed, with the exit's marker. */
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
		orphaned: {
			at: Date.now() - 60_000,
			fate: "orphaned",
			reason: "session-shutdown",
			host: HOST,
			remoteDir: h.remoteDir,
			...(terminal ? { remoteTerminal: terminal } : {}),
		},
		...overrides,
	});
}

/**
 * The ledger rows the launch inserted: a root plus a RUNNING cross-machine child,
 * and the `orphan_detected` event the exit writes (the same shape
 * `src/legion/orphan.ts` produces — the marker `recover`/`/legion status` reads).
 */
function seedLedger(h: Harness, opts: { terminal?: string } = {}): void {
	const db = openLegionDb(h.dbPath);
	try {
		insertNode(db, { id: "root", parentId: null, name: "root", role: "root", kind: "pi", depth: 0, runId: h.runId, status: "running" });
		const node = insertNode(db, {
			parentId: "root",
			name: NAME,
			role: "worker",
			kind: "pi",
			status: "running",
			host: HOST,
			remoteDir: h.remoteDir,
			...(opts.terminal ? { remoteTerminal: opts.terminal } : {}),
			sessionFile: path.join(h.runDir, `${NAME}.jsonl`),
		});
		assert.equal(node.id, NODE_ID);
		appendOrphanMarker(db, h, opts.terminal);
	} finally {
		db.close();
	}
}

/**
 * The exit's `orphan_detected` event, written with the PRODUCTION writer: the type
 * is a stored closed set, so a hand-rolled INSERT could drift from it.
 */
function appendOrphanMarker(db: DatabaseSync, h: Harness, terminal?: string): void {
	appendEvent(db, NODE_ID, "orphan_detected", {
		parentId: "root",
		reason: "session-shutdown",
		fate: "orphaned",
		host: HOST,
		remoteDir: h.remoteDir,
		...(terminal ? { remoteTerminal: terminal } : {}),
		remoteSessionPath: h.remoteSessionPath,
	});
}

// ── ledger / record readers ─────────────────────────────────────────────────

function withDb<T>(h: Harness, fn: (db: DatabaseSync) => T): T {
	const db = openLegionDb(h.dbPath);
	try {
		return fn(db);
	} finally {
		db.close();
	}
}

const SETTLE_TYPES = new Set(["node_settled", "node_failed", "node_retired"]);

interface SettleEvent {
	type: string;
	data: Record<string, unknown> | null;
}

/** Every settle-shaped event for the node, oldest first. */
function settleEvents(db: DatabaseSync): SettleEvent[] {
	return readEventsAfter(db, 0, { nodeId: NODE_ID })
		.filter((event) => SETTLE_TYPES.has(event.type))
		.map((event) => ({ type: event.type, data: (event.data ?? null) as Record<string, unknown> | null }));
}

/**
 * The `reclaimed` stamp on the run record, read through a local shape.
 *
 * Deliberately NOT imported from `src/runs/orphan-reclaim.ts`: the stamp is the
 * record's contract, and a test that read it through the writer's own type would
 * pass a rename of the field. `unknown` cast keeps the typecheck honest without
 * coupling the assertion to the module's declarations.
 */
function reclaimStamp(record: ChildRecord | null): { verdict?: string; ledgerStatus?: string; evidence?: string; at?: number; sessionFile?: string } | undefined {
	return (record as unknown as { reclaimed?: { verdict?: string; ledgerStatus?: string; evidence?: string; at?: number; sessionFile?: string } } | null)?.reclaimed;
}

/** The lines of the per-store reclaim log (empty when nothing was written). */
function reclaimLogLines(h: Harness, storeRoot: string = h.storeRoot): string[] {
	const file = path.join(storeRoot, RECLAIM_LOG);
	return existsSync(file) ? readFileSync(file, "utf8").split("\n").filter((line) => line.length > 0) : [];
}

function coreLogText(h: Harness): string {
	return existsSync(h.coreLog) ? readFileSync(h.coreLog, "utf8") : "";
}

// ── A1: the end-to-end the issue asks for ───────────────────────────────────

test("#456 A1: an orphaned row whose terminal is gone is VISIBLE as such, and one `stop` reclaims it end to end", async () => {
	const h = harness({ prefix: "orphan-reclaim-a1-" });
	try {
		// The previous session's child: the program ended (exit 0) and wrote a
		// complete, gradeable turn. Only the terminal survived the exit.
		const terminal = await startTerminal(h, { state: "finished", exitCode: 0, transcript: finishedTranscript("all green") });
		await seedLeftover(h, {}, terminal);
		seedLedger(h, { terminal });

		// ── `status` (no name): the row is decorated, and NOT counted live ──────
		const overview = await h.invoke({ action: "status" });
		assert.equal(overview.details?.error, undefined, overview.text);
		assert.match(overview.text, /worker-0 — state=orphaned \(terminal gone, work done\)/);
		assert.match(overview.text, /^orphan: terminal /m, "the evidence is rendered under the header");
		assert.match(overview.text, /Status · 0 live children \(1 orphaned\)/);
		assert.doesNotMatch(overview.text, /Status · 1 live child/, "a dead leftover holds no live slot");
		assert.doesNotMatch(overview.text, /state=working/);

		// ── `status name`: the SAME decoration, through the other surface ───────
		const named = await h.invoke({ action: "status", name: NAME });
		assert.equal(named.details?.error, undefined, named.text);
		assert.match(named.text, /worker-0 — state=orphaned \(terminal gone, work done\)/);
		assert.match(named.text, /^orphan: terminal /m);
		// The probe really went over the wire (the evidence is a fact about that core).
		assert.match(coreLogText(h), /"terminal\.get"/);

		// ── `stop`: reclaimed, not "unknown child" ─────────────────────────────
		const stopped = await h.invoke({ action: "stop", name: NAME });
		assert.equal(stopped.details?.error, undefined, stopped.text);
		assert.doesNotMatch(stopped.text, /unknown child/);
		assert.doesNotMatch(stopped.text, /not tracked by this session/);
		assert.match(stopped.text, /Reclaimed worker-0/);
		assert.match(stopped.text, /verdict: terminal-gone/);
		assert.match(stopped.text, /ledger settled \(execution: success\)/);

		// ── the ledger: settled from the GRADED transcript ─────────────────────
		withDb(h, (db) => {
			assert.equal(getNode(db, NODE_ID)?.status, "settled");
			const settles = settleEvents(db);
			assert.equal(settles.length, 1, JSON.stringify(settles));
			assert.equal(settles[0]!.type, "node_settled");
			const data = settles[0]!.data!;
			assert.equal(data.execution, "success");
			assert.equal(data.reason, "terminal-gone");
			assert.equal(data.reclaimed, true);
			// The rail block (`/legion status`'s "recoverable" list) reads THIS query,
			// so an empty answer is the block disappearing.
			assert.deepEqual(listUnsettledRemoteNodes(db), []);
		});

		// ── run.json: retired, the exit's marker dropped, the stamp written ────
		const record = h.store.findChild(h.runId, NAME);
		assert.ok(record);
		assert.equal(record.state, "retired");
		assert.equal(record.orphaned, undefined, "the exit's marker is history once reclaimed");
		assert.equal(record.execution?.status, "success");
		const stamp = reclaimStamp(record);
		assert.equal(stamp?.verdict, "terminal-gone");
		assert.equal(stamp?.ledgerStatus, "settled");
		assert.match(stamp?.evidence ?? "", /is finished/);

		// ── the per-store log names every fact a reader needs to check it ──────
		const lines = reclaimLogLines(h);
		const reclaimed = lines.find((line) => line.includes(" reclaimed "));
		assert.ok(reclaimed, `no reclaimed line in:\n${lines.join("\n")}`);
		for (const needle of [
			`name=${NAME}`,
			`run=${h.runId}`,
			`host=${HOST}`,
			`terminal=${terminal}`,
			"verdict=terminal-gone",
			"evidence=",
			"ledger=settled",
			"execution=success",
			"by=session:",
			"pid=",
		]) {
			assert.ok(reclaimed!.includes(needle), `log line is missing ${needle}: ${reclaimed}`);
		}
		assert.ok(reclaimed!.includes(`by=session:${h.sessionFile}`), "the log names the session that reclaimed it");

		// ── a SECOND `status` drops the retired record entirely ───────────────
		const after = await h.invoke({ action: "status" });
		assert.doesNotMatch(after.text, /state=orphaned/, after.text);
		assert.doesNotMatch(after.text, /worker-0/, after.text);
	} finally {
		await h.cleanup();
	}
});

// ── A2: a child still WRITING must never be cleaned up ───────────────────────

test("#456 A2: a kept terminal whose transcript is still GROWING is refused — nothing is killed, nothing is written", async () => {
	const h = harness({ prefix: "orphan-reclaim-a2-" });
	let grower: ReturnType<typeof setInterval> | undefined;
	try {
		// The stale-orphan SHAPE, but alive: the terminal stays `running` after its
		// program exits (a kept terminal), so its own state cannot answer "is the work
		// over?" — the transcript is the only evidence.
		const terminal = await startTerminal(h, {
			state: "running",
			programState: "idle",
			transcript: finishedTranscript("still writing"),
		});
		await seedLeftover(h, {}, terminal);
		seedLedger(h, { terminal });
		const before = readFileSync(h.remoteSessionPath, "utf8").split("\n").filter(Boolean).length;
		assert.ok(before > 0, "the fixture transcript must exist before growth is measured");

		// Real growth, driven while the call is in flight: the reclaim samples the
		// transcript twice ~1.2s apart, and a line lands every ~100ms in between.
		grower = setInterval(() => {
			try {
				appendFileSync(
					h.remoteSessionPath,
					`${JSON.stringify({ type: "message", message: { role: "assistant", content: "more" } })}\n`,
				);
			} catch {
				// the file is the fake core's; a failed append must not kill the run
			}
		}, 100);
		grower.unref?.();

		const stopped = await h.invoke({ action: "stop", name: NAME });
		assert.equal(stopped.details?.error, undefined, stopped.text);
		assert.match(stopped.text, /Refusing to reclaim worker-0/);
		assert.match(stopped.text, /still working over there/);
		assert.match(stopped.text, /is growing \(\d+ → \d+ lines in \d+ms\)/);

		// Nothing was written: the row is exactly as the previous session left it.
		withDb(h, (db) => {
			assert.equal(getNode(db, NODE_ID)?.status, "running");
			assert.deepEqual(settleEvents(db), [], "a refusal writes no settle event");
			assert.deepEqual(listUnsettledRemoteNodes(db).map((node) => node.id), [NODE_ID]);
		});
		const record = h.store.findChild(h.runId, NAME);
		assert.equal(record?.state, "orphaned");
		assert.ok(record?.orphaned, "the exit's marker survives a refusal");
		assert.equal(reclaimStamp(record), undefined, "a refusal never stamps the record");

		// The hard constraint behind the whole case: no kill was even ASKED for.
		assert.doesNotMatch(coreLogText(h), /"terminal\.kill"/, "a still-working child must never be killed");
	} finally {
		if (grower !== undefined) clearInterval(grower);
		await h.cleanup();
	}
});

// ── A3: a terminal that does not exist must still settle ─────────────────────

test("#456 A3: a terminal the core does not hold settles the row (a missing terminal cannot hang forever)", async () => {
	const h = harness({ prefix: "orphan-reclaim-a3-" });
	try {
		// Never created: this address is not in the core's namespace, and the previous
		// session left no transcript to grade (it died before writing one).
		const missing = `${HOST}/t9123`;
		await seedLeftover(h, {}, missing);
		seedLedger(h, { terminal: missing });
		assert.equal(existsSync(h.remoteSessionPath), false, "the premise is 'no transcript'");

		const started = Date.now();
		const stopped = await h.invoke({ action: "stop", name: NAME });
		const elapsed = Date.now() - started;
		// Not a budget assertion (a loaded box may be slow) — the "did not hang" backstop.
		assert.ok(elapsed < 30_000, `the reclaim did not return for ${elapsed}ms`);
		assert.equal(stopped.details?.error, undefined, stopped.text);
		assert.match(stopped.text, /Reclaimed worker-0/);
		assert.match(stopped.text, /verdict: terminal-gone/);

		// Nothing to grade ⇒ the row is RETIRED (fetchable later), never "settled".
		withDb(h, (db) => {
			assert.equal(getNode(db, NODE_ID)?.status, "retired");
			const settles = settleEvents(db);
			assert.equal(settles.length, 1, JSON.stringify(settles));
			assert.equal(settles[0]!.type, "node_retired");
			assert.equal(settles[0]!.data!.execution, "unknown");
			assert.equal(settles[0]!.data!.reason, "terminal-gone");
			assert.equal(settles[0]!.data!.reclaimed, true);
			assert.deepEqual(listUnsettledRemoteNodes(db), [], "a retired row leaves the rail");
		});

		const record = h.store.findChild(h.runId, NAME);
		assert.equal(record?.state, "retired");
		assert.equal(record?.orphaned, undefined);
		const stamp = reclaimStamp(record);
		assert.equal(stamp?.verdict, "terminal-gone");
		assert.equal(stamp?.ledgerStatus, "retired");
		assert.equal(record?.execution, undefined, "no transcript ⇒ no invented execution");

		const reclaimed = reclaimLogLines(h).find((line) => line.includes(" reclaimed "));
		assert.ok(reclaimed, "the reclaim log is written for a retire too");
		assert.ok(reclaimed!.includes("verdict=terminal-gone"), reclaimed);
		assert.ok(reclaimed!.includes("ledger=retired"), reclaimed);
	} finally {
		await h.cleanup();
	}
});

// ── A4: never probe a row another LIVE session holds (#445) ─────────────────

test("#456 A4: a row a LIVE session owns is refused before any wire call — not probed, not killed", async () => {
	const h = harness({ prefix: "orphan-reclaim-a4-" });
	// A real live process that is NOT this test process: session A is still running.
	const owner = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
	owner.unref();
	try {
		const terminal = await startTerminal(h, { state: "finished", exitCode: 0, transcript: finishedTranscript("not yours") });
		await seedLeftover(h, {}, terminal);
		seedLedger(h, { terminal });
		writeOwnerFile(path.join(h.runDir, RUN_OWNER_FILE), owner.pid!);
		// Only what the STOP asks for is evidence: drop the setup's own round trips.
		writeFileSync(h.coreLog, "");

		const stopped = await h.invoke({ action: "stop", name: NAME });
		assert.equal(stopped.details?.error, undefined, stopped.text);
		assert.match(stopped.text, /Not reclaiming worker-0/);
		assert.match(stopped.text, /owned by /);
		assert.match(stopped.text, /is alive/);
		assert.doesNotMatch(stopped.text, /Reclaimed/);

		// The other session's record/ledger are untouched.
		withDb(h, (db) => {
			assert.equal(getNode(db, NODE_ID)?.status, "running");
			assert.deepEqual(settleEvents(db), []);
		});
		const record = h.store.findChild(h.runId, NAME);
		assert.equal(record?.state, "orphaned");
		assert.ok(record?.orphaned);
		assert.equal(reclaimStamp(record), undefined);

		// The gate is BEFORE the wire: neither a probe nor a kill was attempted.
		const log = coreLogText(h);
		assert.doesNotMatch(log, /"terminal\.get"/, `the held row must not be probed:\n${log}`);
		assert.doesNotMatch(log, /"terminal\.kill"/);
	} finally {
		owner.kill("SIGKILL");
		await h.cleanup();
	}
});

// ── A5: the empirical cross-store case ──────────────────────────────────────

test("#456 A5: a leftover in ANOTHER store is found through the bounded surface, shown, and reclaimed", async () => {
	// `homeIsRoot` puts the temp tree inside `$HOME` so the bounded discovery walk can
	// reach the sibling directory — the production shape being that the previous
	// session ran in another checkout of the same home tree.
	const h = harness({ prefix: "orphan-reclaim-a5-", homeIsRoot: true });
	try {
		// The previous session's store: `<root>/old/.pi-subagents`, NOT this session's.
		const oldCwd = path.join(h.root, "old");
		mkdirSync(oldCwd, { recursive: true });
		const oldStore = new RunStore({ rootDir: path.join(oldCwd, ".pi-subagents") });
		const oldRun = oldStore.createRun({ task: "yesterday's work", cwd: oldCwd, sessionFile: h.previousSession });
		const oldRunDir = oldStore.runDir(oldRun.runId);
		writeOwnerFile(path.join(oldRunDir, RUN_OWNER_FILE), DEAD_PID);
		const oldRemoteDir = path.posix.join(h.remoteRoot, ".pi-subagents-mirror", oldRun.runId, NAME);
		const terminal = await startTerminal(h, {
			state: "finished",
			exitCode: 0,
			transcript: finishedTranscript("yesterday's green run"),
			// The transcript lives in the OLD run's mirror dir, which is the path the old
			// record names — a read-back resolves it from the record, not from this store.
			transcriptPath: path.posix.join(oldRemoteDir, "session.jsonl"),
		});
		await oldStore.addChild(oldRun.runId, {
			name: NAME,
			sessionFile: path.join(oldRunDir, `${NAME}.jsonl`),
			ownerToken: "tok-old",
			state: "orphaned",
			spawnedAt: new Date(Date.now() - 3_600_000).toISOString(),
			host: HOST,
			remoteDir: oldRemoteDir,
			remoteTerminal: terminal,
			nodeId: NODE_ID,
			orphaned: {
				at: Date.now() - 3_500_000,
				fate: "orphaned",
				reason: "session-shutdown",
				host: HOST,
				remoteDir: oldRemoteDir,
				remoteTerminal: terminal,
			},
		});
		const oldDbPath = legionDbPath(oldRunDir);
		{
			const db = openLegionDb(oldDbPath);
			try {
				insertNode(db, { id: "root", parentId: null, name: "root", role: "root", kind: "pi", depth: 0, runId: oldRun.runId, status: "running" });
				insertNode(db, {
					parentId: "root",
					name: NAME,
					role: "worker",
					kind: "pi",
					status: "running",
					host: HOST,
					remoteDir: oldRemoteDir,
					remoteTerminal: terminal,
					sessionFile: path.join(oldRunDir, `${NAME}.jsonl`),
				});
				appendEvent(db, NODE_ID, "orphan_detected", {
					parentId: "root",
					reason: "session-shutdown",
					fate: "orphaned",
					host: HOST,
					remoteDir: oldRemoteDir,
					remoteTerminal: terminal,
				});
			} finally {
				db.close();
			}
		}

		// The call stands in `<root>/work`; `ctx.cwd` is `<root>`, so the caller-cwd
		// sibling scan is what reaches `<root>/old`.
		const overview = await h.invoke({ action: "status", cwd: h.work }, h.root);
		assert.equal(overview.details?.error, undefined, overview.text);
		assert.match(overview.text, /worker-0 — state=orphaned \(terminal gone, work done\)/, overview.text);
		assert.match(overview.text, /^store=/m, "a foreign row names the store it came from");
		// #450/#463: the line now carries the store, the run and the run's age (`<label> · <runId> · today`).
		assert.match(overview.text, /^store=~?\/?.*old · r-[0-9a-z]+ · (today|\d+d old)$/m, overview.text);
		assert.match(overview.text, /\(1 orphaned\)/, "the header counts the foreign leftover as orphaned, not live");
		assert.doesNotMatch(overview.text, /Status · 1 live child/, "a leftover is never a live child");

		const stopped = await h.invoke({ action: "stop", name: NAME, cwd: h.work }, h.root);
		assert.equal(stopped.details?.error, undefined, stopped.text);
		assert.match(stopped.text, /Reclaimed worker-0/);
		assert.match(stopped.text, /verdict: terminal-gone/);

		// That STORE moved: its ledger settled, its run.json retired, its log written.
		{
			const db = openLegionDb(oldDbPath);
			try {
				assert.equal(getNode(db, NODE_ID)?.status, "settled");
				assert.deepEqual(listUnsettledRemoteNodes(db), []);
			} finally {
				db.close();
			}
		}
		const oldRecord = oldStore.findChild(oldRun.runId, NAME);
		assert.equal(oldRecord?.state, "retired");
		assert.equal(reclaimStamp(oldRecord)?.verdict, "terminal-gone");
		const oldLog = reclaimLogLines(h, oldStore.rootDir);
		const reclaimed = oldLog.find((line) => line.includes(" reclaimed "));
		assert.ok(reclaimed, `no reclaimed line in the OLD store's log:\n${oldLog.join("\n")}`);
		assert.ok(reclaimed!.includes(`run=${oldRun.runId}`), reclaimed);
		assert.ok(reclaimed!.includes("verdict=terminal-gone"), reclaimed);
		// This session's own store was not the one written.
		assert.equal(existsSync(path.join(h.storeRoot, RECLAIM_LOG)), false, "the log belongs to the store that held the row");
	} finally {
		await h.cleanup();
	}
});

// ── A6: idempotent, honest no-op ────────────────────────────────────────────

test("#456 A6: a second `stop` after the reclaim claims no new stop — exactly ONE settle event, ever", async () => {
	const h = harness({ prefix: "orphan-reclaim-a6-" });
	try {
		const terminal = await startTerminal(h, { state: "finished", exitCode: 0, transcript: finishedTranscript("done once") });
		await seedLeftover(h, {}, terminal);
		seedLedger(h, { terminal });

		const first = await h.invoke({ action: "stop", name: NAME });
		assert.match(first.text, /Reclaimed worker-0/);
		assert.equal(first.details?.error, undefined, first.text);

		const second = await h.invoke({ action: "stop", name: NAME });
		assert.equal(second.details?.error, undefined, second.text);
		assert.doesNotMatch(second.text, /unknown child/);
		assert.doesNotMatch(second.text, /not tracked by this session/);
		// Any of the three honest shapes is fine; inventing a second settle is not.
		assert.match(second.text, /already retired|No non-retired children|already-ended|already/i, second.text);

		withDb(h, (db) => {
			assert.equal(getNode(db, NODE_ID)?.status, "settled");
			assert.equal(settleEvents(db).length, 1, "a repeated stop must not write a second settle");
		});
		const reclaimedLines = reclaimLogLines(h).filter((line) => line.includes(" reclaimed "));
		assert.equal(reclaimedLines.length, 1, "the reclaim happened once, and the log says so");
	} finally {
		await h.cleanup();
	}
});

// ── A7: no recorded address ⇒ a miss is not proof ───────────────────────────

test("#456 A7: a leftover with NO recorded terminal address is not settled on an inferred miss", async () => {
	const h = harness({ prefix: "orphan-reclaim-a7-" });
	try {
		// The record predates the recorded-address field (or the exit had none). The
		// probe can only ask the inferred `host/worker-0`, which the core does not
		// hold. That is NOT evidence the child ended (reattach.ts's guard): the core
		// may hold a differently-spelled terminal, and its program may be working.
		await seedLeftover(h);
		seedLedger(h);
		assert.equal(h.store.findChild(h.runId, NAME)?.remoteTerminal, undefined);
		withDb(h, (db) => assert.ok(getNode(db, NODE_ID)?.remoteTerminal == null, "the ledger row records no address either"));

		const status = await h.invoke({ action: "status" });
		// The record says `orphaned`, but with no address AND no transcript the #423
		// shell rule owns the state word: `unknown` is the most precise thing it can
		// say, and it is still explicitly not `working`.
		assert.match(status.text, /worker-0 — state=unknown \(liveness unknown\)/);
		assert.doesNotMatch(status.text, /state=working/);
		assert.match(status.text, /no terminal address was recorded/);
		assert.doesNotMatch(status.text, /terminal gone, work done/);

		const before = withDb(h, (db) => settleEvents(db).length);
		const stopped = await h.invoke({ action: "stop", name: NAME });
		assert.equal(stopped.details?.error, undefined, stopped.text);
		assert.match(stopped.text, /Refusing to reclaim worker-0/);
		assert.match(stopped.text, /no terminal address was recorded/);

		withDb(h, (db) => {
			assert.equal(getNode(db, NODE_ID)?.status, "running");
			assert.equal(settleEvents(db).length, before, "nothing may be settled on an inferred miss");
			assert.deepEqual(listUnsettledRemoteNodes(db).map((node) => node.id), [NODE_ID], "the rail keeps it");
		});
		const record = h.store.findChild(h.runId, NAME);
		assert.equal(record?.state, "orphaned");
		assert.ok(record?.orphaned, "the orphaned marker survives");
		assert.equal(reclaimStamp(record), undefined);
		assert.doesNotMatch(coreLogText(h), /"terminal.kill"/);
	} finally {
		await h.cleanup();
	}
});

// ── A8: the positive stale-orphan cleanup (real hc kill) ────────────────────

test("#456 A8: a kept terminal idle at the prompt is KILLED, then settled on the graded transcript", async () => {
	const h = harness({ prefix: "orphan-reclaim-a8-" });
	try {
		// A kept terminal: the terminal stays `running` after its program ended
		// (`program_state:"idle"` = the prompt), the transcript is complete and quiet.
		const terminal = await startTerminal(h, { state: "running", programState: "idle", transcript: finishedTranscript("done before the restart") });
		await seedLeftover(h, {}, terminal);
		seedLedger(h, { terminal });

		const started = Date.now();
		const stopped = await h.invoke({ action: "stop", name: NAME });
		// One production growth sample is ~1.2s; this is a "did not hang" backstop.
		assert.ok(Date.now() - started < 30_000);
		assert.equal(stopped.details?.error, undefined, stopped.text);
		assert.match(stopped.text, /Reclaimed worker-0/);
		assert.match(stopped.text, /verdict: stale-orphan/);
		assert.match(stopped.text, /terminal killed/);

		// The kill really went over the wire, addressed at the RECORDED terminal.
		const kill = coreLogText(h)
			.split("\n")
			.filter((line) => line.includes("\"terminal.kill\""))
			.map((line) => JSON.parse(line) as { method?: string; params?: { terminal?: string } });
		assert.equal(kill.length, 1, coreLogText(h));
		assert.equal(kill[0]!.params?.terminal, terminal);

		// Then the ledger settles on the transcript, and the record retires.
		withDb(h, (db) => {
			assert.equal(getNode(db, NODE_ID)?.status, "settled");
			const settles = settleEvents(db);
			assert.equal(settles.length, 1, JSON.stringify(settles));
			assert.equal(settles[0]!.data!.reason, "stale-orphan");
			assert.equal(settles[0]!.data!.execution, "success");
			assert.deepEqual(listUnsettledRemoteNodes(db), []);
		});
		const record = h.store.findChild(h.runId, NAME);
		assert.equal(record?.state, "retired");
		assert.equal(record?.orphaned, undefined);
		assert.equal(reclaimStamp(record)?.verdict, "stale-orphan");
		assert.equal(reclaimStamp(record)?.ledgerStatus, "settled");

		const reclaimed = reclaimLogLines(h).find((line) => line.includes(" reclaimed "));
		assert.ok(reclaimed, "a kill is a cleanup and must be logged");
		assert.ok(reclaimed!.includes("verdict=stale-orphan"), reclaimed);
		assert.ok(reclaimed!.includes("killed=true"), reclaimed);
	} finally {
		await h.cleanup();
	}
});
