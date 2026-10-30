/**
 * #145: subagent({ action: "status" }) without name returns live-children overview.
 *
 * Named status and unknown-name NOT_FOUND stay unchanged; slash /legion status
 * is out of scope.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import * as path from "node:path";
import piLegion, {
	listLiveChildrenForStatus,
	renderStatusOverview,
} from "../../index.ts";
import { FakeSupervisor } from "../helpers/fake-supervisor.ts";
import type { LegionSupervisor } from "../../src/supervisor/types.ts";
import { ErrorCodes } from "../../src/shared/types.ts";
import type { ChildRecord, RunRecord } from "../../src/shared/types.ts";

initTheme("dark");

const ENV_KEYS = [
	"PI_CODING_AGENT_DIR",
	"PI_HERDR_SUBAGENTS_EXTRA_AGENT_DIRS",
	"PI_SUBAGENT_CHILD",
	"PI_SUBAGENT_ALLOW_NESTED",
	"PI_LEGION_DB",
	"PI_LEGION_NODE_ID",
	"PI_SUBAGENTS_TEAM",
];

const SCOUT_FILE =
	"---\nname: scout\ndescription: read-only utility role\nutility: true\ntools: read, grep, find, ls\nkind: pi\n---\nscout prompt\n";
const WORKER_FILE =
	"---\nname: worker\ndescription: worker role\n---\nworker prompt\n";

function restoreEnv(previous: Map<string, string | undefined>): void {
	for (const [name, value] of previous) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
}

function childStub(partial: Partial<ChildRecord> & { name: string }): ChildRecord {
	return {
		sessionFile: `/tmp/${partial.name}.jsonl`,
		ownerToken: `tok-${partial.name}`,
		state: "working",
		spawnedAt: "2026-01-01T00:00:00.000Z",
		agent: "scout",
		kind: "pi",
		...partial,
	};
}

function runStub(runId: string, children: ChildRecord[], createdAt = "2026-01-01T00:00:00.000Z"): RunRecord {
	return {
		schemaVersion: 1,
		runId,
		task: "t",
		cwd: "/tmp",
		herdr: { supervisor: "rpc", node_id: "root" },
		path: [],
		depth: 0,
		maxDepth: 3,
		budget: { spawned: children.length, limit: null, granted: 0 },
		createdAt,
		updatedAt: createdAt,
		children,
	};
}

function indexHarness() {
	const cwd = mkdtempSync(path.join(tmpdir(), "legion-status-action-"));
	const agentDir = path.join(cwd, "agent-config");
	const extraAgentsDir = path.join(cwd, "extra-agents");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(extraAgentsDir, { recursive: true });
	writeFileSync(
		path.join(agentDir, "settings.json"),
		JSON.stringify({ subagents: { disableBuiltins: true } }),
	);
	writeFileSync(path.join(extraAgentsDir, "scout.md"), SCOUT_FILE);
	writeFileSync(path.join(extraAgentsDir, "worker.md"), WORKER_FILE);
	const previous = new Map(ENV_KEYS.map((name) => [name, process.env[name]]));
	const tools = new Map<
		string,
		{ execute: (...args: unknown[]) => Promise<{ content?: Array<{ text?: string }>; details?: unknown }> }
	>();
	const handlers = new Map<string, (...args: unknown[]) => unknown>();
	/** Slash commands this extension registered, by name (#315). */
	const commands = new Map<
		string,
		{ handler: (args: string, ctx: unknown) => Promise<void> }
	>();
	/** Chat text this extension sent through `pi.sendMessage` (#315). */
	const sentMessages: string[] = [];
	const supervisor = new FakeSupervisor({
		autoSettle: { text: '{"ok":true}' },
		immediateTimeout: false,
	});
	const pi = {
		registerTool(value: unknown) {
			const typed = value as {
				name: string;
				execute: (...args: unknown[]) => Promise<{ content?: Array<{ text?: string }>; details?: unknown }>;
			};
			tools.set(typed.name, typed);
		},
		registerCommand(name: string, command: { handler: (args: string, ctx: unknown) => Promise<void> }) {
			commands.set(name, command);
		},
		registerMessageRenderer() {},
		sendMessage(message: { content?: unknown }) {
			if (typeof message?.content === "string") sentMessages.push(message.content);
		},
		events: { emit() {} },
		on(name: string, handler: (...args: unknown[]) => unknown) {
			handlers.set(name, handler);
		},
	};
	process.env.PI_CODING_AGENT_DIR = agentDir;
	process.env.PI_HERDR_SUBAGENTS_EXTRA_AGENT_DIRS = extraAgentsDir;
	for (const name of ENV_KEYS.slice(2)) delete process.env[name];
	piLegion(pi as never, { supervisor });
	const tool = tools.get("subagent");
	assert.ok(tool);
	return {
		cwd,
		supervisor,
		tool,
		commands,
		sentMessages,
		async invoke(params: Record<string, unknown>) {
			const result = await tool.execute(
				"status-action-test",
				params,
				undefined,
				undefined,
				{ cwd, hasUI: false, ui: { notify() {}, setStatus() {} } },
			);
			return {
				text: (result.content ?? []).map((item) => item.text ?? "").join("\n"),
				details: result.details as { error?: string; code?: string } | undefined,
			};
		},
		async cleanup() {
			await handlers.get("session_shutdown")?.();
			restoreEnv(previous);
			rmSync(cwd, { recursive: true, force: true });
		},
	};
}

test("listLiveChildrenForStatus skips retired/exited and dedupes by newest name", () => {
	const runs = [
		runStub("old", [
			childStub({ name: "a", state: "working", agent: "scout" }),
			childStub({ name: "b", state: "retired", agent: "worker" }),
		], "2026-01-01T00:00:00.000Z"),
		runStub("new", [
			childStub({ name: "a", state: "working", agent: "worker" }),
			childStub({ name: "c", state: "exited", agent: "scout" }),
			childStub({ name: "d", state: "blocked", agent: "scout" }),
		], "2026-01-02T00:00:00.000Z"),
	];
	const live = listLiveChildrenForStatus(runs);
	assert.deepEqual(
		live.map((c) => ({ name: c.name, agent: c.agent })),
		[
			{ name: "a", agent: "worker" },
			{ name: "d", agent: "scout" },
		],
	);
});

test("renderStatusOverview empty / multi-child", () => {
	assert.equal(renderStatusOverview([]), "No live children.");
	const text = renderStatusOverview([
		{ child: childStub({ name: "scout-a", agent: "scout" }), alive: false },
		{ child: childStub({ name: "worker-0", agent: "worker" }), alive: true },
	]);
	assert.match(text, /Status · 2 live children/);
	assert.match(text, /scout-a — state=working/);
	assert.match(text, /worker-0 — state=working/);
	assert.match(text, /alive · quiet/);
});

test("#145 status without name returns multi-child overview (not INVALID_PARAMS)", async () => {
	const harness = indexHarness();
	try {
		await harness.invoke({
			agent: "scout",
			task: "one",
			name: "scout-a",
			async: true,
			worktree: false,
		});
		await harness.invoke({
			agent: "worker",
			task: "two",
			name: "worker-b",
			async: true,
			worktree: false,
		});

		// #232 removed collect()'s settle-quiet wait, so a child whose turn already
		// finished is auto-recycled as soon as its background watch collects it —
		// `scout-a` may legitimately be `retired` by the time status runs, and
		// `status` reports live (non-retired) children only.
		//
		// Pin the behaviour this test is actually about: `status` without a name
		// answers with the overview shape instead of rejecting, and it lists the
		// children the store currently reports as live.
		const overview = await harness.invoke({ action: "status" });
		assert.doesNotMatch(overview.text, /name` is required/i);
		assert.notEqual(overview.details?.error, ErrorCodes.INVALID_PARAMS);
		assert.match(overview.text, /^Status · \d+ live child/);
		assert.match(overview.text, /worker-b/);

		const viaAll = await harness.invoke({ action: "status", all: true });
		assert.match(viaAll.text, /^Status · \d+ live child/);
		assert.match(viaAll.text, /worker-b/);
	} finally {
		await harness.cleanup();
	}
});

test("#145 status with name returns single child; unknown → NOT_FOUND", async () => {
	const harness = indexHarness();
	try {
		await harness.invoke({
			agent: "scout",
			task: "named",
			name: "scout-a",
			async: true,
			worktree: false,
		});
		await harness.invoke({
			agent: "worker",
			task: "other",
			name: "worker-b",
			async: true,
			worktree: false,
		});

		const byName = await harness.invoke({ action: "status", name: "scout-a" });
		assert.match(byName.text, /scout-a/);
		assert.doesNotMatch(byName.text, /Status ·/);
		assert.doesNotMatch(byName.text, /worker-b/);

		const missing = await harness.invoke({ action: "status", name: "ghost" });
		assert.match(missing.text, /unknown child: ghost/);
		assert.equal(missing.details?.error, ErrorCodes.NOT_FOUND);

		const both = await harness.invoke({ action: "status", name: "scout-a", all: true });
		assert.match(both.text, /mutually exclusive/);
		assert.equal(both.details?.error, ErrorCodes.INVALID_PARAMS);
	} finally {
		await harness.cleanup();
	}
});

// ── #315: "alive but no longer progressing" made visible ─────────────

/**
 * Teach a harness supervisor to answer the display-only activity read (#315).
 *
 * `inFlightTool` is an OPTIONAL member of `LegionSupervisor` for exactly this
 * reason: a supervisor that cannot answer must keep satisfying the contract, so
 * absence renders no line. The shared FakeSupervisor predates that member and is
 * used by dozens of tests, so the fact is attached here the same way a real
 * backend exposes it rather than widening the double for everyone.
 */
function withActivity(
	supervisor: FakeSupervisor,
	activity: { tool: string; startedAt: number } | undefined,
): void {
	const seam: LegionSupervisor = supervisor;
	seam.inFlightTool = () => activity;
}

test("#315 renderStatusOverview prepends the activity lead and renders nothing when absent", () => {
	const now = 1_000_000;
	const child = childStub({ name: "worker-0", agent: "worker" });
	const text = renderStatusOverview(
		[{ child, alive: true, activity: { tool: "bash", startedAt: now - 12_000 } }],
		now,
	);
	// A lead line for the block: what it is doing, and for how long.
	assert.match(text, /^working · bash 00:00:12$/m);
	assert.ok(
		text.indexOf("working · bash") < text.indexOf("worker-0 — state="),
		"the activity line leads the block it describes",
	);
	// The rest of the block is untouched.
	assert.match(text, /worker-0 — state=working/);

	// No fact, no line — the overview is byte-identical to the pre-#315 shape.
	assert.doesNotMatch(renderStatusOverview([{ child, alive: true }], now), /working · /);
});

test("#315 status with name shows what a live child is running and for how long", async () => {
	const harness = indexHarness();
	try {
		await harness.invoke({
			agent: "scout",
			task: "probe",
			name: "scout-a",
			async: true,
			worktree: false,
		});
		withActivity(harness.supervisor, { tool: "bash", startedAt: Date.now() - 12_000 });

		const byName = await harness.invoke({ action: "status", name: "scout-a" });
		assert.match(byName.text, /^working · bash 00:00:12\nscout-a — state=/m);
		// Display only: the liveness verdict and the snapshot are unchanged.
		assert.match(byName.text, /alive · quiet/);
	} finally {
		await harness.cleanup();
	}
});

test("#315 status all marks a single tool past the 5m bound without changing any verdict", async () => {
	const harness = indexHarness();
	try {
		await harness.invoke({
			agent: "worker",
			task: "build",
			name: "worker-b",
			async: true,
			worktree: false,
		});
		withActivity(harness.supervisor, { tool: "bash", startedAt: Date.now() - 12 * 60_000 });

		const overview = await harness.invoke({ action: "status", all: true });
		assert.match(
			overview.text,
			/^working · bash 00:12:00 \(long-running tool — no progress for 12m; `steer` cannot interrupt it, `abort` can\)$/m,
		);
		// The marker is a string and nothing else: the child is still listed as
		// one live child, still tracked, and never retired by rendering a status.
		assert.match(overview.text, /^Status · 1 live child/m);
		assert.equal(
			harness.supervisor.calls.filter((call) => call.method === "retire").length,
			0,
			"rendering a status never retires anything",
		);
	} finally {
		await harness.cleanup();
	}
});

test("#315 /legion status <name> reads the same activity fact as subagent status", async () => {
	const harness = indexHarness();
	try {
		await harness.invoke({
			agent: "worker",
			task: "build",
			name: "worker-b",
			async: true,
			worktree: false,
		});
		withActivity(harness.supervisor, { tool: "bash", startedAt: Date.now() - 12_000 });

		const legion = harness.commands.get("legion");
		assert.ok(legion, "the /legion command must be registered");
		await legion.handler("status worker-b", {
			cwd: harness.cwd,
			mode: "headless",
			hasUI: false,
			ui: { notify() {}, setStatus() {} },
		});
		// The slash exit builds its facts in index.ts (`childStatus`), so this pins
		// that wiring, not just the renderer the unit test above covers.
		assert.match(harness.sentMessages.at(-1) ?? "", /^working · bash 00:00:12$/m);
	} finally {
		await harness.cleanup();
	}
});

test("#145 status with no children returns empty overview", async () => {
	const harness = indexHarness();
	try {
		const overview = await harness.invoke({ action: "status" });
		assert.equal(overview.text.trim(), "No live children.");
		assert.doesNotMatch(overview.text, /name` is required/i);
	} finally {
		await harness.cleanup();
	}
});

// ── #209-3: foreign dead child must not report state=working ─────────────

/**
 * Build a run dir whose `owner.json` names a pid that cannot exist, plus a
 * child record still persisted as `working`. This is the shape left behind by
 * a crashed/killed session: nothing will ever rewrite that state.
 */
function foreignDeadRun(
	cwd: string,
	runId: string,
	name: string,
	extra: Partial<ChildRecord> = {},
): void {
	const runDir = path.join(cwd, ".pi-subagents", "runs", runId);
	mkdirSync(runDir, { recursive: true });
	writeFileSync(
		path.join(runDir, "owner.json"),
		`${JSON.stringify({ pid: 999999999, host: hostname(), at: Date.now() })}\n`,
	);
	const child = childStub({
		name,
		state: "working",
		execution: { status: "running" },
		...extra,
	});
	writeFileSync(
		path.join(runDir, "run.json"),
		`${JSON.stringify(runStub(runId, [child]), null, "\t")}\n`,
	);
}

test("#209-3 status overview reports a foreign dead child as state=failed", async () => {
	const harness = indexHarness();
	try {
		foreignDeadRun(harness.cwd, "r-dead0001", "worker-2");

		const overview = await harness.invoke({ action: "status", all: true });
		// display-liveness A3 / §6 repaired this assertion. The old one read
		// `/Status · 1 live child/` — it counted a child whose owner pid is gone as
		// live, because the filter only looked at `child.state` and never asked the
		// owner marker. That made the header contradict its own body: the block
		// below the header says `state=failed` + `owner: dead (pid gone)`. A dead
		// child is now listed (so the user still sees what happened) but not
		// counted as live; the count line is replaced by `No live children.` +
		// `(1 dead)` so an all-dead run dir is still distinguishable from an empty
		// one.
		assert.match(overview.text, /^No live children\./);
		assert.match(overview.text, /\(1 dead\)/);
		assert.doesNotMatch(overview.text, /Status · 1 live child/);
		// Contract §6 keeps the block text itself unchanged (W2 owns it): a dead
		// child is still reported as failed, with its owner verdict spelled out.
		assert.match(overview.text, /worker-2 — state=failed/);
		assert.doesNotMatch(overview.text, /worker-2 — state=working/);
		assert.match(overview.text, /owner: dead \(pid gone\)/);
	} finally {
		await harness.cleanup();
	}
});

test("#209-3 a dead child does not hide a live one, and the header counts only live", async () => {
	const harness = indexHarness();
	try {
		// A3 is a per-child count, not an all-or-nothing gate: a run dir holding
		// one dead foreign record and one live child of this process must report
		// `1 live child` and still show the dead block underneath it.
		foreignDeadRun(harness.cwd, "r-dead0004", "worker-2");
		await harness.invoke({
			agent: "scout",
			task: "still running",
			name: "scout-a",
			async: true,
			worktree: false,
		});

		const overview = await harness.invoke({ action: "status", all: true });
		assert.match(overview.text, /Status · 1 live child\b/);
		assert.doesNotMatch(overview.text, /Status · 2 live/);
		assert.match(overview.text, /\(1 dead\)/);
		assert.match(overview.text, /scout-a — state=working/);
		assert.match(overview.text, /worker-2 — state=failed/);
		assert.match(overview.text, /owner: dead \(pid gone\)/);
	} finally {
		await harness.cleanup();
	}
});

test("#209-3 named status reports a foreign dead child as state=failed", async () => {
	const harness = indexHarness();
	try {
		foreignDeadRun(harness.cwd, "r-dead0002", "worker-2");

		const named = await harness.invoke({ action: "status", name: "worker-2" });
		assert.match(named.text, /worker-2 — state=failed/);
		assert.match(named.text, /owner: dead \(pid gone\)/);
	} finally {
		await harness.cleanup();
	}
});

test("#209-3 a live in-process child is unaffected by the owner fallback", async () => {
	const harness = indexHarness();
	try {
		await harness.invoke({
			agent: "scout",
			task: "still running",
			name: "scout-a",
			async: true,
			worktree: false,
		});
		const overview = await harness.invoke({ action: "status", all: true });
		assert.match(overview.text, /scout-a — state=working/);
		assert.doesNotMatch(overview.text, /state=failed/);
	} finally {
		await harness.cleanup();
	}
});

test("#209-3 an owner.json without a pid keeps state=working (unknown, not dead)", async () => {
	const harness = indexHarness();
	try {
		const runDir = path.join(harness.cwd, ".pi-subagents", "runs", "r-noowner1");
		mkdirSync(runDir, { recursive: true });
		writeFileSync(
			path.join(runDir, "run.json"),
			`${JSON.stringify(runStub("r-noowner1", [childStub({ name: "worker-2" })]), null, "\t")}\n`,
		);
		const overview = await harness.invoke({ action: "status", all: true });
		assert.match(overview.text, /worker-2 — state=working/);
		assert.doesNotMatch(overview.text, /state=failed/);
		assert.match(overview.text, /owner: unknown/);
	} finally {
		await harness.cleanup();
	}
});

// ── #209-3: stop must reach a foreign record, not only in-memory jobs ────

test("#209-3 stop retires a foreign record that exists in the store", async () => {
	const harness = indexHarness();
	try {
		foreignDeadRun(harness.cwd, "r-dead0003", "worker-2");

		const result = await harness.invoke({ action: "stop", name: "worker-2" });
		assert.doesNotMatch(result.text, /not tracked by this session/);
		assert.equal(result.details?.error, undefined, result.text);
		assert.match(result.text, /Stopped 1 child: worker-2/);

		// The persisted record actually moved to retired.
		const runFile = path.join(harness.cwd, ".pi-subagents", "runs", "r-dead0003", "run.json");
		const persisted = JSON.parse(readFileSync(runFile, "utf8")) as RunRecord;
		assert.equal(persisted.children[0]?.state, "retired");
	} finally {
		await harness.cleanup();
	}
});

test("#209-3 stop keeps the original error when neither runtime nor store knows the name", async () => {
	const harness = indexHarness();
	try {
		const result = await harness.invoke({ action: "stop", name: "ghost" });
		assert.match(result.text, /unknown child: ghost \(not tracked by this session\)\./);
		assert.equal(result.details?.error, ErrorCodes.NOT_FOUND);
	} finally {
		await harness.cleanup();
	}
});

test("#209-3 stop on an already-retired foreign record reports nothing to stop", async () => {
	const harness = indexHarness();
	try {
		foreignDeadRun(harness.cwd, "r-dead0004", "worker-2", {
			state: "retired",
			execution: { status: "success" },
		});
		const result = await harness.invoke({ action: "stop", name: "worker-2" });
		assert.doesNotMatch(result.text, /not tracked by this session/);
		assert.match(result.text, /No non-retired children to stop/);
	} finally {
		await harness.cleanup();
	}
});
