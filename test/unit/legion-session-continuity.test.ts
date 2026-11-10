/**
 * #374 — the same session reopens its old ledger; exiting a session PAUSES its
 * subtree; getting it running again is an explicit act.
 *
 * Contract: `docs/contracts/legion-session-continuity-v1.md`.
 *
 * Four production facts are pinned here, each driven through the layer that owns
 * it rather than reconstructed:
 *
 *  §2  `createRootLegion` reuses this session's run (`RunRecord.sessionFile`) and
 *      UPDATES the existing root row — `insertNode` would throw on the name.
 *  §3  `retire({cause:"session-shutdown"})` retires the node WITHOUT aborting its
 *      phase, which is what keeps `isTerminalNode` false and the team resumable.
 *      Every other cause still aborts (invariant I4).
 *  §4  `phases` survives the process (`ChildRecord.phases`) so a revived inline
 *      declaration still ships the same `PI_LEGION_PHASES`, and `subagent resme`
 *      is what restarts a paused child — never the startup path (invariant I6).
 *  §5  the prompt names the interrupted children, and the section disappears by
 *      itself once nothing is left to resume.
 *  §1/I1 a DIFFERENT session looks at nothing and writes nothing.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { initTheme } from "@earendil-works/pi-coding-agent";

import piLegion, { INTERRUPTED_NODES_NOTE, interruptedChildren, renderInterruptedSection } from "../../index.ts";
import { parsePhaseMachine } from "../../src/agents/agents.ts";
import { createLegionEventBus } from "../../src/extension/event-bus.ts";
import { legionDbPath, openLegionDb } from "../../src/legion/db.ts";
import { appendEvent, readEventsAfter } from "../../src/legion/events.ts";
import { getChildren, getNode, insertNode } from "../../src/legion/nodes.ts";
import { markSessionInterrupted } from "../../src/legion/interrupt.ts";
import { sendMail } from "../../src/legion/mail.ts";
import type { ProviderLookup } from "../../src/runs/provider-pin.ts";
import { LEGION_PHASES_ENV } from "../../src/runs/args.ts";
import { Orchestrator, type OrchestratorLegionContext } from "../../src/runs/orchestrator.ts";
import { RunStore } from "../../src/runs/store.ts";
import type { ChildRecord } from "../../src/shared/types.ts";
import { FakeSupervisor } from "../helpers/fake-supervisor.ts";

initTheme("dark");

const ENV_KEYS = [
	"PI_CODING_AGENT_DIR",
	"PI_SUBAGENT_CHILD",
	"PI_SUBAGENT_UTILITY_CHILD",
	"PI_SUBAGENT_ALLOW_NESTED",
	"PI_SUBAGENT_MAX_DEPTH",
	"PI_SUBAGENT_PARENT_PATH",
	"PI_LEGION_DB",
	"PI_LEGION_NODE_ID",
	"PI_LEGION_PHASES",
];

/**
 * `spec → build → done` — phase names the BUILT-IN union has never heard of, so
 * "the revived team still knows them" cannot be satisfied by a fallback.
 */
const TEAM_MACHINE = {
	start: "spec",
	phases: [
		{ id: "spec", next: [{ to: "build" }] },
		{ id: "build", next: [{ to: "done" }] },
		{ id: "done", terminal: true, next: [] },
	],
};

interface ToolResult {
	content?: Array<{ text?: string }>;
	details?: unknown;
}

interface RegisteredTool {
	name: string;
	execute(
		id: string,
		params: Record<string, unknown>,
		signal: undefined,
		onUpdate: undefined,
		ctx: unknown,
	): Promise<ToolResult>;
}

function textOf(result: ToolResult): string {
	return (result.content ?? []).map((part) => part.text ?? "").join("\n");
}

/** Every completed run under this checkout's store, by id. */
function runIds(cwd: string): string[] {
	const runsDir = path.join(cwd, ".pi-subagents", "runs");
	if (!existsSync(runsDir)) return [];
	return readdirSync(runsDir).filter((entry) => existsSync(path.join(runsDir, entry, "run.json"))).sort();
}

/** Parsed run.json of every run in this store. */
function runRecords(cwd: string): Array<Record<string, unknown>> {
	const runsDir = path.join(cwd, ".pi-subagents", "runs");
	return runIds(cwd).map((id) => JSON.parse(readFileSync(path.join(runsDir, id, "run.json"), "utf8")) as Record<string, unknown>);
}

function runFileOf(cwd: string, runId: string): string {
	return path.join(cwd, ".pi-subagents", "runs", runId, "run.json");
}

/**
 * The bytes of a file once the post-shutdown writes have stopped landing.
 *
 * A completion watch persists the child's final record a few ms AFTER the
 * shutdown handler resolved; an assertion about "nothing else ever writes this"
 * has to start from the quiescent state, or it measures the tail of the previous
 * session instead of the new one.
 */
async function settledBytes(file: string): Promise<string> {
	let previous = "";
	let current = readFileSync(file, "utf8");
	for (let attempt = 0; attempt < 40 && current !== previous; attempt += 1) {
		previous = current;
		await new Promise((resolve) => setTimeout(resolve, 25));
		current = readFileSync(file, "utf8");
	}
	return current;
}

/**
 * One Pi session per `boot()`.
 *
 * The point of the harness is that a second `boot()` is a SECOND PROCESS as far
 * as the extension can tell: fresh factory entry, fresh handler map, fresh tool
 * map. Only the disk (run.json + legion.db) and the session transcript path are
 * shared — which is exactly the channel #374 is defined on.
 */
function harness(prefix: string) {
	const root = mkdtempSync(path.join(tmpdir(), prefix));
	const agentDir = path.join(root, "agent");
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({}));
	const repo = path.join(root, "repo");
	execFileSync("git", ["init", "-q", repo]);
	execFileSync("git", ["-C", repo, "-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-qm", "init"]);

	const previousEnv = new Map(ENV_KEYS.map((name) => [name, process.env[name]]));
	process.env.PI_CODING_AGENT_DIR = agentDir;
	for (const name of ENV_KEYS.slice(1)) delete process.env[name];

	const supervisor = new FakeSupervisor({ immediateTimeout: false });
	const notices: string[] = [];
	let sessionFile = path.join(root, "session.jsonl");
	/** The parent model registry, when a test needs a provider pin (#123). */
	let modelRegistry: ProviderLookup | undefined;
	let tools = new Map<string, RegisteredTool>();
	let handlers = new Map<string, Array<(...args: unknown[]) => unknown>>();

	const ctx = () => ({
		cwd: repo,
		hasUI: false,
		ui: { notify: (text: string) => notices.push(text), setStatus() {} },
		sessionManager: { getSessionFile: () => sessionFile },
		...(modelRegistry ? { modelRegistry } : {}),
	});

	const boot = (): void => {
		tools = new Map();
		handlers = new Map();
		const pi = {
			registerTool(tool: unknown) {
				const typed = tool as RegisteredTool;
				tools.set(typed.name, typed);
			},
			registerCommand() {},
			registerMessageRenderer() {},
			sendMessage() {},
			events: { emit() {} },
			on(name: string, handler: (...args: unknown[]) => unknown) {
				const list = handlers.get(name) ?? [];
				list.push(handler);
				handlers.set(name, list);
			},
		};
		piLegion(pi as never, { supervisor });
	};

	const shutdown = async (): Promise<void> => {
		for (const handler of handlers.get("session_shutdown") ?? []) {
			await handler({ type: "session_shutdown", reason: "quit" }, { mode: "tui", ...ctx() });
		}
		// Belt and braces: a scenario that leaves a child behind (a deliberately
		// broken build under mutation testing) must not keep the test process alive.
		for (const name of [...supervisor.children.keys()]) {
			await supervisor.retire(name).catch(() => {});
		}
	};

	/** The system prompt the agent would start this turn with. */
	const systemPrompt = (): string => {
		let out = "";
		for (const handler of handlers.get("before_agent_start") ?? []) {
			const result = handler(
				{
					type: "before_agent_start",
					prompt: "keep going",
					systemPrompt: "BASE PROMPT",
					systemPromptOptions: { selectedTools: ["subagent"] },
				},
				ctx(),
			) as { systemPrompt?: string } | undefined;
			if (result?.systemPrompt) out = result.systemPrompt;
		}
		return out;
	};

	const call = async (params: Record<string, unknown>): Promise<ToolResult> => {
		const tool = tools.get("subagent");
		assert.ok(tool, "the subagent tool is registered");
		return tool.execute("call", params, undefined, undefined, ctx());
	};

	const launchTeam = async (task: string): Promise<ToolResult> =>
		call({ agent: "centurion", task, phases: TEAM_MACHINE, async: true, worktree: true });

	/**
	 * THIS session's tree: the one run whose node is `root`. A team launch also
	 * opens a run of its own (the child's run dir), so "the number of runs" is
	 * never the identity — `nodeId: "root"` is.
	 */
	const rootRun = (): { runId: string; file: string; record: Record<string, unknown> } => {
		const roots = runRecords(repo).filter((record) => record.nodeId === "root");
		assert.equal(roots.length, 1, `exactly one root run for this session: ${roots.map((record) => String(record.runId)).join(", ")}`);
		const record = roots[0]!;
		return { runId: String(record.runId), file: runFileOf(repo, String(record.runId)), record };
	};

	return {
		root,
		repo,
		agentDir,
		supervisor,
		notices,
		boot,
		shutdown,
		systemPrompt,
		call,
		launchTeam,
		runIds: () => runIds(repo),
		rootRun,
		store: () => new RunStore({ rootDir: path.join(repo, ".pi-subagents") }),
		/** The single ledger this session owns, opened for reading, with a closer. */
		ledger(): { db: ReturnType<typeof openLegionDb>; close: () => void } {
			const db = openLegionDb(legionDbPath(path.join(repo, ".pi-subagents", "runs", rootRun().runId)));
			return { db, close: () => db.close() };
		},
		useSession(file: string): void {
			sessionFile = file;
		},
		/** Register the parent providers `providerForModel` may pin (#123). */
		useModelRegistry(registry: ProviderLookup): void {
			modelRegistry = registry;
		},
		/** This checkout's ledger path for the root run (`PI_LEGION_DB`). */
		legionDb(): string {
			return legionDbPath(path.join(repo, ".pi-subagents", "runs", rootRun().runId));
		},
		cleanup(): void {
			for (const [name, value] of previousEnv) {
				if (value === undefined) delete process.env[name];
				else process.env[name] = value;
			}
			rmSync(root, { recursive: true, force: true });
		},
	};
}

type Harness = ReturnType<typeof harness>;

/** A team node as the ledger holds it after a session exit (phase preserved). */
function pausedTeam(db: ReturnType<typeof openLegionDb>): ReturnType<typeof getChildren> {
	return getChildren(db, "root");
}

// ---------------------------------------------------------------------------
// §2 — same session reopens its ledger
// ---------------------------------------------------------------------------

test("#374 §2: the same session reopens the SAME run, and nothing is re-created", async () => {
	const h = harness("legion-374-reopen-");
	try {
		h.boot();
		await h.launchTeam("own the slice");
		const first = h.rootRun();
		const before = first.record;
		await h.shutdown();

		// ── the next start of the same session ───────────────────────────────
		h.boot();
		// The hint is available on the FIRST prompt, before any tool call has had a
		// chance to adopt the tree — and computing it writes nothing.
		const bytesBeforePrompt = await settledBytes(first.file);
		const prompt = h.systemPrompt();
		assert.equal(readFileSync(first.file, "utf8"), bytesBeforePrompt, "probing for continuity must not write run.json");

		await h.launchTeam("own the slice (again)");
		assert.equal(h.rootRun().runId, first.runId, "no second run, no shadow tree");

		const ledger = h.ledger();
		try {
			const rootRows = ledger.db.prepare("SELECT COUNT(*) AS n FROM nodes WHERE id = 'root'").all() as Array<{ n: number }>;
			assert.equal(Number(rootRows[0]?.n ?? 0), 1, "the root row was UPDATED, never inserted twice");
			assert.equal(getNode(ledger.db, "root")?.status, "running");
			// I7: the tree from the previous session is still visible, phases intact.
			const children = pausedTeam(ledger.db);
			assert.deepEqual(children.map((node) => `${node.name}:${node.phase}:${node.status}`), [
				"centurion-0:spec:retired",
				"centurion-1:spec:running",
			], "the interrupted team kept its phase; the new one joined the same tree");
		} finally {
			ledger.close();
		}

		const after = h.rootRun().record;
		assert.notEqual(after.updatedAt, before.updatedAt, "the reopened run records the touch");
		for (const key of ["schemaVersion", "runId", "task", "cwd", "createdAt", "path", "depth", "maxDepth", "herdr", "nodeId", "sessionFile"]) {
			assert.deepEqual(after[key], before[key], `${key} of the run record is preserved verbatim`);
		}
		assert.equal(after.sessionFile, path.resolve(path.join(h.root, "session.jsonl")), "the run carries this session's identity");
		assert.match(prompt, /centurion-0 · spec/u, "the reopened prompt names the interrupted child");
		assert.ok(h.notices.some((line) => /were interrupted/u.test(line)), "the user gets one line about it");
	} finally {
		await h.shutdown().catch(() => {});
		h.cleanup();
	}
});

// ---------------------------------------------------------------------------
// §1 / I1 — a different session is untouched
// ---------------------------------------------------------------------------

test("#374 I1: a different session writes nothing to the old run (byte-identical) and is told nothing", async () => {
	const h = harness("legion-374-cross-session-");
	try {
		h.boot();
		await h.launchTeam("own the slice");
		const first = h.rootRun();
		await h.shutdown();
		const oldBytes = await settledBytes(first.file);

		// A different session: same checkout, different transcript.
		h.useSession(path.join(h.root, "another-session.jsonl"));
		h.boot();
		assert.ok(!h.systemPrompt().includes(INTERRUPTED_NODES_NOTE), "no session identity matched, so nothing is claimed");
		await h.launchTeam("a different session's work");

		assert.equal(readFileSync(first.file, "utf8"), oldBytes, "the previous session's run.json is byte-identical");
		const roots = runRecords(h.repo).filter((record) => record.nodeId === "root");
		assert.equal(roots.length, 2, "a different session gets its own run — that is today's behaviour, unchanged");
		const fresh = roots.find((record) => record.runId !== first.runId);
		assert.ok(fresh, "the new session did NOT adopt the previous run");
		assert.equal(fresh!.sessionFile, path.resolve(path.join(h.root, "another-session.jsonl")), "…it carries its own session identity");
	} finally {
		await h.shutdown().catch(() => {});
		h.cleanup();
	}
});

// ---------------------------------------------------------------------------
// §5 / I6 — the hint, and zero automatic resumption
// ---------------------------------------------------------------------------

test("#374 §5/I6: the prompt lists what was interrupted, spawns nothing, and drops each entry as it is resumed", async () => {
	const h = harness("legion-374-hint-");
	try {
		h.boot();
		await h.launchTeam("own the first slice");
		await h.launchTeam("own the second slice");
		await h.shutdown();

		h.boot();
		const spawnsBefore = h.supervisor.spawns.length;
		const prompt = h.systemPrompt();
		assert.match(prompt, /centurion-0 · spec/u);
		assert.match(prompt, /centurion-1 · spec/u);
		assert.ok(prompt.includes(INTERRUPTED_NODES_NOTE), "the frozen §5 wording is what the agent reads");
		assert.match(prompt, /Do NOT resume them on your own/u);
		assert.equal(h.supervisor.spawns.length, spawnsBefore, "I6: the startup path never spawns anything");
		assert.equal(h.supervisor.calls.filter((call) => call.method === "spawnChild").length, spawnsBefore);
		assert.equal(h.notices.filter((line) => /were interrupted/u.test(line)).length, 1, "the user is told once");

		// The agent asks, the user approves, and the tool is what restarts a team —
		// exactly ONE team. A reopen that also replayed the rest of the list would
		// spend tokens nobody asked for, which is invariant I6.
		await h.call({ action: "resume", name: "centurion-0", message: "keep going" });
		assert.equal(h.supervisor.spawns.length, spawnsBefore + 1, "I6: resuming one team spawns one child, not the whole paused list");
		assert.equal(
			h.supervisor.calls.filter((call) => call.method === "spawnChild").length,
			spawnsBefore + 1,
			"I6: the supervisor was asked for exactly one child (the call log is the ground truth)",
		);
		const partial = h.systemPrompt();
		assert.doesNotMatch(partial, /centurion-0 · spec/u, "a recovered team leaves the list");
		assert.match(partial, /centurion-1 · spec/u, "…while the one still paused stays listed");
		assert.equal(h.notices.filter((line) => /were interrupted/u.test(line)).length, 1, "one notice per startup, not per turn");

		await h.call({ action: "resume", name: "centurion-1", message: "keep going too" });
		assert.equal(h.supervisor.spawns.length, spawnsBefore + 2, "…and the second approval spawns the second child");
		assert.ok(!h.systemPrompt().includes(INTERRUPTED_NODES_NOTE), "nothing left to resume ⇒ the section is gone");
	} finally {
		await h.shutdown().catch(() => {});
		h.cleanup();
	}
});

test("#374 §3: the exit marker lands BEFORE anything drains or kills", () => {
	// `--print` drains before the retire path runs, and a child whose turn ends during
	// that drain is recorded `settled/success`. The marker therefore has to be written
	// first — and it must only touch the ledger: a child that really finishes during
	// the drain is improved to `settled` right afterwards (`recordSettled` writes the
	// status regardless), while a killed one stays interrupt-marked.
	const db = openLegionDb(":memory:");
	try {
		insertNode(db, { id: "root", parentId: null, name: "root", role: "root", status: "running" }, () => 1);
		insertNode(db, { parentId: "root", name: "live", role: "worker", status: "running", sessionFile: "/s/live.jsonl" }, () => 2);
		insertNode(db, { parentId: "root", name: "team", role: "centurion", status: "blocked", phase: "implementing", sessionFile: "/s/team.jsonl" }, () => 3);
		insertNode(db, { parentId: "root", name: "done", role: "worker", status: "settled", sessionFile: "/s/done.jsonl" }, () => 4);

		const marked = markSessionInterrupted(db, "root", () => 100);
		assert.deepEqual(marked.sort(), ["root.live", "root.team"]);
		assert.equal(getNode(db, "root.live")?.status, "retired");
		assert.equal(getNode(db, "root.team")?.status, "retired");
		assert.equal(getNode(db, "root.team")?.phase, "implementing", "a pause never touches the phase");
		assert.equal(getNode(db, "root.done")?.status, "settled", "an already-finished child is left alone");

		const retired = readEventsAfter(db, 0).filter((event) => event.type === "node_retired");
		assert.deepEqual(retired.map((event) => event.nodeId).sort(), ["root.live", "root.team"]);
		assert.ok(retired.every((event) => (event.data as { reason?: string }).reason === "session-shutdown"));

		// The marker is idempotent: the explicit retire that follows must not write a
		// second "the session ended" event for the same node.
		assert.deepEqual(markSessionInterrupted(db, "root", () => 200), []);
		assert.equal(readEventsAfter(db, 0).filter((event) => event.type === "node_retired").length, 2);
	} finally {
		db.close();
	}
});

test("#374 §5: an interrupted WORKER is listed, a deliberate stop is not", () => {
	// The phase is not part of the predicate: only a team that declares `phases:`
	// gets one (#371), so requiring a phase hid the most common case — a worker
	// killed mid-task. What separates "interrupted" from "stopped on purpose" is
	// the reason on the last `node_retired`, not the status alone.
	const db = openLegionDb(":memory:");
	try {
		insertNode(db, { id: "root", parentId: null, name: "root", role: "root", status: "running" }, () => 1);
		insertNode(db, { parentId: "root", name: "paused-worker", role: "worker", status: "retired", sessionFile: "/s/paused.jsonl" }, () => 2);
		insertNode(db, { parentId: "root", name: "stopped-worker", role: "worker", status: "retired", sessionFile: "/s/stopped.jsonl" }, () => 3);
		insertNode(db, { parentId: "root", name: "no-session", role: "worker", status: "retired" }, () => 4);
		insertNode(db, { parentId: "root", name: "finished", role: "worker", status: "settled", sessionFile: "/s/done.jsonl" }, () => 5);
		appendEvent(db, "root.paused-worker", "node_retired", { reason: "session-shutdown" }, { now: () => 10 });
		appendEvent(db, "root.stopped-worker", "node_retired", { reason: "user" }, { now: () => 10 });
		appendEvent(db, "root.no-session", "node_retired", { reason: "session-shutdown" }, { now: () => 10 });

		const listed = interruptedChildren(db).map((node) => node.name);
		assert.deepEqual(listed, ["paused-worker"], "only the paused, resumable child counts");
		const section = renderInterruptedSection(interruptedChildren(db));
		assert.match(section, /paused-worker · <none>/u, "a phase-less child is still named in the prompt");
		assert.ok(section.includes(INTERRUPTED_NODES_NOTE));

		// A live node (its process died with the session) is interrupted too, even
		// though no retire event was ever written for it.
		insertNode(db, { parentId: "root", name: "live-worker", role: "worker", status: "running", sessionFile: "/s/live.jsonl" }, () => 6);
		const names = interruptedChildren(db).map((node) => node.name);
		assert.ok(names.includes("live-worker"), "a still-live ledger row is interrupted: nothing will ever move it");
		assert.ok(!names.includes("stopped-worker"), "…and the deliberate stop stays out of the list");
	} finally {
		db.close();
	}
});

// ---------------------------------------------------------------------------
// §3 — exiting pauses, other causes still abort
// ---------------------------------------------------------------------------

const STINT_START = 1_000_000;

function retireFixture() {
	const root = mkdtempSync(path.join(tmpdir(), "legion-374-retire-"));
	const store = new RunStore({ rootDir: path.join(root, ".pi-subagents") });
	const run = store.createRun({ task: "root task", cwd: root, maxDepth: 4, nodeId: "root" });
	const db = openLegionDb(":memory:");
	insertNode(db, { id: "root", parentId: null, name: "root", role: "root", runId: run.runId, status: "running" }, () => STINT_START - 500);
	insertNode(
		db,
		{
			parentId: "root",
			name: "team",
			role: "centurion",
			status: "running",
			phase: "implementing",
			phaseSince: STINT_START,
			sessionFile: path.join(store.runDir(run.runId), "team.jsonl"),
		},
		() => STINT_START,
	);
	const legion: OrchestratorLegionContext = {
		db,
		dbPath: legionDbPath(store.runDir(run.runId)),
		nodeId: "root",
		parentNodeId: null,
		parentRunId: null,
		runId: run.runId,
		runStore: store,
		settings: { maxDepth: 4, maxChildrenPerNode: 8, maxActiveNodes: 30 },
		eventBus: createLegionEventBus(),
	};
	return {
		root,
		runId: run.runId,
		db,
		legion,
		/** Register the child record the way a real launch leaves it behind. */
		async seedRunRecord(): Promise<void> {
			await store.addChild(run.runId, {
				name: "team",
				nodeId: "root.team",
				sessionFile: path.join(store.runDir(run.runId), "team.jsonl"),
				ownerToken: "legion-root.team",
				state: "working",
				spawnedAt: new Date(STINT_START).toISOString(),
				agent: "centurion",
				kind: "pi",
			} satisfies ChildRecord);
		},
		orchestrator(now: () => number): Orchestrator {
			const orchestrator = new Orchestrator({
				supervisor: new FakeSupervisor({ immediateTimeout: false }),
				runDir: store.runDir(run.runId),
				cwd: root,
				maxDepth: 4,
				legion,
				now,
			});
			orchestrator.restore(store.readRun(run.runId)!);
			return orchestrator;
		},
		cleanup(): void {
			db.close();
			rmSync(root, { recursive: true, force: true });
		},
	};
}

test("#374 §3: session-shutdown PAUSES the team — retired, phase untouched, no phase_change", async () => {
	const fx = retireFixture();
	try {
		await fx.seedRunRecord();
		const orchestrator = fx.orchestrator(() => STINT_START + 60_000);
		await orchestrator.retire("team", { cause: "session-shutdown" });

		const node = getNode(fx.db, "root.team");
		assert.equal(node?.status, "retired", "the process is gone, so the node is not live");
		assert.equal(node?.phase, "implementing", "…but the phase is where the work stopped");
		assert.equal(node?.phaseSince, STINT_START, "the stint clock is not a new stint: a pause is not a revival");
		assert.equal(node?.reworkCount, 0);

		const events = readEventsAfter(fx.db, 0, { nodeId: "root.team" });
		assert.deepEqual(
			events.filter((event) => event.type === "phase_change"),
			[],
			"nothing moved, so nothing is recorded as having moved",
		);
		const retired = events.filter((event) => event.type === "node_retired");
		assert.equal(retired.length, 1);
		assert.equal((retired[0]!.data as { reason?: string }).reason, "session-shutdown");
		// I2: the closed set of 16 is untouched — the cause is a FIELD, not a new type.
		assert.ok(events.every((event) => ["node_retired", "node_launched", "node_settled", "node_resumed", "node_failed", "node_blocked", "phase_change"].includes(event.type)));
	} finally {
		fx.cleanup();
	}
});

test("#380: the orchestrator writes its ledger row with NO event bus attached", async () => {
	// The fourth #380 site: `this.legion.eventBus?.emit(appendEvent(...))` inside
	// `emitStored`. A headless host has no bus, so every event the orchestrator wrote
	// (retire, settle, failure) vanished from the ledger while the node rows moved on.
	const fx = retireFixture();
	try {
		// The bus is optional on the context; a headless embedder simply never sets it.
		fx.legion.eventBus = undefined;
		await fx.seedRunRecord();
		const orchestrator = fx.orchestrator(() => STINT_START + 60_000);
		await orchestrator.retire("team");

		const events = readEventsAfter(fx.db, 0, { nodeId: "root.team" });
		assert.ok(events.some((event) => event.type === "node_retired"), "no subscriber must not mean no ledger fact");
	} finally {
		fx.cleanup();
	}
});

test("#374 I4: a retire WITHOUT the session-shutdown cause still aborts the phase", async () => {
	const fx = retireFixture();
	try {
		await fx.seedRunRecord();
		const orchestrator = fx.orchestrator(() => STINT_START + 60_000);
		await orchestrator.retire("team");

		const node = getNode(fx.db, "root.team");
		assert.equal(node?.status, "retired");
		assert.equal(node?.phase, "aborted", "an explicit stop is a verdict, exactly as before");

		const events = readEventsAfter(fx.db, 0, { nodeId: "root.team" });
		const changes = events.filter((event) => event.type === "phase_change");
		assert.equal(changes.length, 1);
		assert.equal((changes[0]!.data as { to?: string }).to, "aborted");
		assert.ok(
			events.filter((event) => event.type === "node_retired").every((event) => (event.data as { reason?: string }).reason !== "session-shutdown"),
			"only the shutdown cause carries that reason",
		);
	} finally {
		fx.cleanup();
	}
});

// ---------------------------------------------------------------------------
// §4 — resuming is explicit, and the declaration survives the process
// ---------------------------------------------------------------------------

test("#374 §4: `subagent resume` restarts a paused team with the SAME declared phases", async () => {
	const h = harness("legion-374-resume-");
	try {
		h.boot();
		await h.launchTeam("own the slice");
		const first = h.supervisor.spawns[0];
		assert.ok(first, "the team was spawned");
		const firstPhases = first!.input.env?.[LEGION_PHASES_ENV];
		assert.ok(firstPhases, "a declared team is born with PI_LEGION_PHASES");
		await h.shutdown();
		const paused = h.ledger();
		try {
			assert.equal(getNode(paused.db, "root.centurion-0")?.status, "retired");
			assert.equal(getNode(paused.db, "root.centurion-0")?.phase, "spec");
		} finally {
			paused.close();
		}

		// ── the same session comes back and the user asks for the team ───────
		h.boot();
		const resumed = await h.call({ action: "resume", name: "centurion-0", message: "keep going" });
		assert.match(textOf(resumed), /Resumed centurion-0/u);

		assert.equal(h.supervisor.spawns.length, 2, "an explicit resume is what spawns");
		const second = h.supervisor.spawns[1]!;
		assert.equal(second.input.sessionFile, first!.input.sessionFile, "the same session file is reused (context preserved)");
		assert.equal(
			second.input.env?.[LEGION_PHASES_ENV],
			firstPhases,
			"the declaration crossed the process boundary unchanged",
		);
		// …and the child can still resolve its own custom phase names.
		const machine = parsePhaseMachine(second.input.env?.[LEGION_PHASES_ENV], LEGION_PHASES_ENV, { requireTerminal: true });
		assert.equal(machine?.start, "spec", "the entry phase crossed the process boundary too");
		for (const id of ["spec", "build", "done"]) {
			assert.ok(machine?.phases.some((phase) => phase.id === id), `the revived declaration still names '${id}'`);
		}

		const ledger = h.ledger();
		try {
			const node = getNode(ledger.db, "root.centurion-0");
			assert.equal(node?.status, "running", "the ledger follows the child back up");
			assert.equal(node?.phase, "spec", "the work resumes where it stopped");
			const changes = readEventsAfter(ledger.db, 0, { nodeId: "root.centurion-0" }).filter((event) => event.type === "phase_change");
			assert.ok(changes.every((event) => (event.data as { to?: string }).to === "spec"), "no phase was left, only the stint restarted");
		} finally {
			ledger.close();
		}
	} finally {
		await h.shutdown().catch(() => {});
		h.cleanup();
	}
});

// ---------------------------------------------------------------------------
// #123 residual — the LEDGER's own resume route replays the pin with its model
// ---------------------------------------------------------------------------
//
// A paused legion child comes back through `resumeLegionChild` whenever MAIL
// reaches it (`LegionPostman.resumeChild`), not through `reviveChild`, which is
// what a `subagent({action:"continue"|"resume"})` tool call takes. Both replay
// the model; only this route had zero tests, so deleting its provider replay
// changed nothing anywhere in the suite — while legion revival is #123's
// original scene (`legion.db`'s `nodes` table has no provider column, so the pin
// can only come from the child's `run.json` record, or from nowhere).

const TEAM_MODEL = "cb/team-model";

/** Queue a mail to a paused child; the postman delivers it on its next tick. */
function mailPausedChild(h: Harness, nodeId: string): void {
	const ledger = h.ledger();
	try {
		const sent = sendMail(ledger.db, {
			fromNode: "root",
			to: nodeId,
			subject: "carry on",
			body: "keep going",
		});
		assert.equal(sent.ok, true, `the mail must be queued: ${JSON.stringify(sent)}`);
	} finally {
		ledger.close();
	}
}

/**
 * Start the NEXT process and reattach this session's ledger.
 *
 * `PI_LEGION_DB`/`PI_LEGION_NODE_ID` is how a resumed process adopts an existing
 * tree; the first postman tick then delivers whatever is pending.
 */
async function reattachNextProcess(h: Harness): Promise<void> {
	h.boot();
	process.env.PI_LEGION_DB = h.legionDb();
	process.env.PI_LEGION_NODE_ID = "root";
	await h.call({ action: "status", all: true });
}

/** Wait for a spawn no tool call hands back: a postman delivery makes it. */
async function waitForSpawn(
	h: Harness,
	name: string,
	count: number,
): Promise<(typeof h.supervisor.spawns)[number]> {
	const startedAt = Date.now();
	while (Date.now() - startedAt < 3_000) {
		const matches = h.supervisor.spawns.filter((spawn) => spawn.input.name === name);
		if (matches.length >= count) return matches[matches.length - 1]!;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	assert.fail(
		`no spawn #${count} for ${name}; saw ${JSON.stringify(h.supervisor.spawns.map((spawn) => spawn.input.name))}`,
	);
}

/**
 * The first launch pins `{model, modelProvider}` into run.json; the revive that
 * a mail triggers must send BOTH again. Sending only the model is the defect:
 * the bare id can resolve into a colliding static provider with no auth (#123).
 */
test("#123: a mail-resumed legion child replays the provider pin stored with its model", async () => {
	const h = harness("legion-123-resume-pin-");
	try {
		h.boot();
		h.useModelRegistry({ getAll: () => [{ provider: "live", id: TEAM_MODEL }] });
		await h.call({
			agent: "centurion",
			task: "own the slice",
			phases: TEAM_MACHINE,
			model: TEAM_MODEL,
			async: true,
			worktree: true,
		});
		const first = h.supervisor.spawns[0];
		assert.ok(first, "the team was spawned");
		assert.equal(first.input.model, TEAM_MODEL);
		assert.equal(first.input.modelProvider, "live", "the first launch pins the provider that owns the model");
		await h.shutdown();

		const record = h.store().findChild(h.rootRun().runId, "centurion-0");
		assert.equal(record?.model, TEAM_MODEL);
		assert.equal(record?.modelProvider, "live", "run.json is the only place a later process can read the pin");

		mailPausedChild(h, "root.centurion-0");

		// ── the next process reattaches THIS session's tree; its postman tick
		// delivers the pending mail, and a delivery to a paused child is the route
		// that reaches `resumeLegionChild`.
		await reattachNextProcess(h);

		const revived = await waitForSpawn(h, "centurion-0", 2);
		assert.equal(revived.input.model, TEAM_MODEL);
		assert.equal(revived.input.modelProvider, "live", "the pin must be replayed WITH its model");
	} finally {
		await h.shutdown().catch(() => {});
		h.cleanup();
	}
});

/**
 * The same route, one record short: the ledger knows the child but `run.json`
 * does not. The synthesized record has no provider (the `nodes` table has no
 * such column and is deliberately not migrated), so the revive must send NO pin
 * rather than guess one — a pinned-but-wrong provider is the #123 failure.
 */
test("#123: a resume from a SYNTHESIZED record sends no pin — it never guesses one", async () => {
	const h = harness("legion-123-resume-synth-");
	try {
		h.boot();
		h.useModelRegistry({ getAll: () => [{ provider: "live", id: TEAM_MODEL }] });
		await h.call({
			agent: "centurion",
			task: "own the slice",
			phases: TEAM_MACHINE,
			model: TEAM_MODEL,
			async: true,
			worktree: true,
		});
		await h.shutdown();
		const store = h.store();
		await store.removeChild(h.rootRun().runId, "centurion-0");
		assert.equal(
			store.findChild(h.rootRun().runId, "centurion-0"),
			null,
			"run.json no longer knows this child",
		);

		mailPausedChild(h, "root.centurion-0");
		await reattachNextProcess(h);

		const revived = await waitForSpawn(h, "centurion-0", 2);
		assert.equal(revived.input.model, TEAM_MODEL, "the ledger still knows the model");
		assert.equal(
			Object.hasOwn(revived.input, "modelProvider"),
			false,
			"a record without a pin must revive without one",
		);
	} finally {
		await h.shutdown().catch(() => {});
		h.cleanup();
	}
});
