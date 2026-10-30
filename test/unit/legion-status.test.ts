import assert from "node:assert/strict";
import { utimesSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { formatTree } from "../../src/extension/legion-tools.ts";
import { registerLegionCommand } from "../../src/extension/legion-commands.ts";
import { renderLegionStatus, type LegionChildStatusFacts } from "../../src/extension/legion-status.ts";
import { createLegionEventBus } from "../../src/extension/event-bus.ts";
import { renderLiveChildStatus } from "../../src/extension/runtime.ts";
import type { LegionNode } from "../../src/legion/nodes.ts";
import { withTempDir } from "../helpers/tmp.ts";

function node(over: Partial<LegionNode> & Pick<LegionNode, "id" | "name" | "parentId" | "depth">): LegionNode {
	return {
		role: over.name === "root" ? "root" : "worker",
		kind: "pi",
		runId: null,
		sessionFile: null,
		worktreePath: null,
		model: null,
		team: null,
		status: "running",
		phase: null,
		phaseSince: null,
		reworkCount: 0,
		contractPath: null,
		taskSummary: null,
		createdAt: 0,
		updatedAt: 0,
		...over,
	};
}

test("legion status with no name prints the tree summary", () => {
	const nodes = [
		node({ id: "root", name: "root", parentId: null, depth: 0, role: "root", status: "running" }),
		node({
			id: "root.worker-0",
			name: "worker-0",
			parentId: "root",
			depth: 1,
			status: "running",
			phase: "implementing",
			model: "example/model",
		}),
		node({ id: "root.scout-0", name: "scout-0", parentId: "root", depth: 1, role: "scout", status: "settled" }),
	];
	const report = renderLegionStatus({
		nodes,
		jobs: [{ name: "orphan", state: "working" }],
	});
	assert.equal(report.ok, true);
	assert.match(report.text, /^Legion status · 3 nodes · running=2, settled=1/);
	assert.ok(report.text.includes(formatTree(nodes)));
	assert.match(report.text, /Live jobs not in the tree:\n- orphan state=working/);
	assert.match(report.text, /One node: \/legion status <name>/);
});

test("legion status with no nodes says so", () => {
	const report = renderLegionStatus({ nodes: [] });
	assert.equal(report.ok, true);
	assert.match(report.text, /Legion status · 0 nodes/);
	assert.match(report.text, /No legion nodes\./);
});

test("legion status name matches renderLiveChildStatus, including a stale live child", async () => {
	await withTempDir(async (dir) => {
		const sessionFile = `${dir}/worker-0.jsonl`;
		writeFileSync(sessionFile, "{\"type\":\"message\"}\n");
		const now = Date.now();
		utimesSync(sessionFile, new Date(now - 12_000), new Date(now - 12_000));
		const facts: LegionChildStatusFacts = {
			name: "worker-0",
			state: "retired",
			agent: "worker",
			kind: "pi",
			sessionFile,
			execution: { status: "failed", reason: "Connection error." },
			acceptance: { status: "rejected", level: "none" },
			alive: true,
		};
		const treeNode = node({
			id: "root.worker-0",
			name: "worker-0",
			parentId: "root",
			depth: 1,
			status: "running",
			sessionFile,
		});
		const report = renderLegionStatus({
			query: "root.worker-0",
			nodes: [node({ id: "root", name: "root", parentId: null, depth: 0, role: "root" }), treeNode],
			lookupChild: (name) => (name === "worker-0" ? facts : undefined),
			now,
		});
		assert.equal(report.ok, true);
		assert.equal(report.text, renderLiveChildStatus({ ...facts, now }));
		assert.match(report.text, /state=working/);
		assert.match(report.text, /persisted snapshot is stale/);

		const byStoreOnly = renderLegionStatus({
			query: "worker-0",
			nodes: [],
			lookupChild: () => facts,
			now,
		});
		assert.equal(byStoreOnly.text, renderLiveChildStatus({ ...facts, now }));
	});
});

test("#315 legion status leads a child block with the tool it is inside", async () => {
	await withTempDir(async (dir) => {
		const sessionFile = `${dir}/worker-0.jsonl`;
		writeFileSync(sessionFile, "{\"type\":\"message\"}\n");
		const now = 1_000_000;
		const base: LegionChildStatusFacts = {
			name: "worker-0",
			state: "working",
			agent: "worker",
			kind: "pi",
			sessionFile,
			alive: true,
			activity: { tool: "bash", startedAt: now - 12_000 },
		};
		const report = renderLegionStatus({
			query: "worker-0",
			nodes: [],
			lookupChild: () => base,
			now,
		});
		assert.equal(report.ok, true);
		assert.match(report.text, /^working · bash 00:00:12$/m);
		// Same renderer as `subagent status`: the slash command cannot drift.
		assert.equal(
			report.text.split("\n")[0],
			"working · bash 00:00:12",
			"the activity line leads the block",
		);

		// No activity fact (a rebuilt record from another session): no line, and
		// the block is exactly what it was before #315.
		const { activity: _activity, ...withoutActivity } = base;
		const plain = renderLegionStatus({
			query: "worker-0",
			nodes: [],
			lookupChild: () => withoutActivity,
			now,
		});
		assert.equal(plain.text, renderLiveChildStatus({ ...withoutActivity, now }));
	});
});

test("legion status renders the arbitrated spawnMode from the child record (D5)", async () => {
	await withTempDir(async (dir) => {
		const sessionFile = `${dir}/worker-0.jsonl`;
		writeFileSync(sessionFile, "{\"type\":\"message\"}\n");
		const base: LegionChildStatusFacts = {
			name: "worker-0",
			state: "working",
			agent: "worker",
			kind: "pi",
			sessionFile,
			alive: false,
		};
		const withMode = renderLegionStatus({
			query: "worker-0",
			nodes: [],
			lookupChild: () => ({ ...base, spawnMode: "inprocess" }),
			now: 0,
		});
		// The record's own backend, not a guessed `rpc`.
		assert.match(withMode.text, /^supervisor=inprocess$/m);
		assert.doesNotMatch(withMode.text, /supervisor=rpc/);

		// A legacy record still carries no spawnMode: say unknown, never guess.
		const withoutMode = renderLegionStatus({
			query: "worker-0",
			nodes: [],
			lookupChild: () => base,
			now: 0,
		});
		assert.match(withoutMode.text, /^supervisor=unknown$/m);
		assert.doesNotMatch(withoutMode.text, /supervisor=rpc/);
	});
});

test("legion status shows the run-dir owner verdict from the child record (D5)", async () => {
	await withTempDir(async (dir) => {
		const sessionFile = `${dir}/worker-0.jsonl`;
		writeFileSync(sessionFile, "{\"type\":\"message\"}\n");
		const base: LegionChildStatusFacts = {
			name: "worker-0",
			state: "working",
			agent: "worker",
			kind: "pi",
			sessionFile,
			execution: { status: "running" },
			alive: false,
		};
		const dead = renderLegionStatus({
			query: "worker-0",
			nodes: [],
			lookupChild: () => ({ ...base, owner: "dead" }),
			now: 0,
		});
		// #209-3: a persisted `working` whose owner pid is gone is failed, and the
		// block says why rather than leaving the reader to guess.
		assert.match(dead.text, /state=failed/);
		assert.match(dead.text, /^owner: dead \(pid gone\)$/m);

		const unknownOwner = renderLegionStatus({
			query: "worker-0",
			nodes: [],
			lookupChild: () => ({ ...base, owner: "unknown" }),
			now: 0,
		});
		assert.match(unknownOwner.text, /^owner: unknown$/m);
		assert.match(unknownOwner.text, /state=working/);

		// No verdict at all (alive, or no marker consulted) emits no owner line.
		const none = renderLegionStatus({
			query: "worker-0",
			nodes: [],
			lookupChild: () => base,
			now: 0,
		});
		assert.doesNotMatch(none.text, /^owner: /m);
	});
});

test("legion status shows the context size of the child's own session (D4)", async () => {
	await withTempDir(async (dir) => {
		const sessionFile = `${dir}/worker-0.jsonl`;
		// Two assistant messages: the cumulative usage grows, but the context is
		// the LAST prompt size (input+cacheRead+cacheWrite), not a lifetime sum.
		writeFileSync(
			sessionFile,
			[
				JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "go" }] } }),
				JSON.stringify({
					type: "message",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "first" }],
						stopReason: "toolUse",
						usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
					},
				}),
				JSON.stringify({
					type: "message",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "done" }],
						stopReason: "stop",
						usage: { input: 24_000, output: 300, cacheRead: 300, cacheWrite: 0, cost: { total: 0.02 } },
					},
				}),
			].join("\n") + "\n",
		);
		const report = renderLegionStatus({
			query: "worker-0",
			nodes: [],
			lookupChild: () => ({
				name: "worker-0",
				state: "working",
				agent: "worker",
				kind: "pi",
				sessionFile,
				alive: false,
			}),
			now: 0,
		});
		assert.equal(report.ok, true);
		// 24000 + 300 + 0 = 24300 → 24.3K. Absolute tokens only: session JSONL
		// records no contextWindow, so a percentage would be invented.
		assert.match(report.text, /^context: ctx=24\.3K tok$/m);
		assert.doesNotMatch(report.text, /%/);

		// No assistant message yet → no context line at all (unknown, not zero).
		const empty = `${dir}/empty.jsonl`;
		writeFileSync(empty, `${JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "go" }] } })}\n`);
		const noContext = renderLegionStatus({
			query: "worker-0",
			nodes: [],
			lookupChild: () => ({
				name: "worker-0",
				state: "working",
				agent: "worker",
				kind: "pi",
				sessionFile: empty,
				alive: false,
			}),
			now: 0,
		});
		assert.doesNotMatch(noContext.text, /^context: /m);
	});
});

test("legion status highlights alive · quiet before execution snapshot", async () => {
	await withTempDir(async (dir) => {
		const sessionFile = `${dir}/worker-0.jsonl`;
		writeFileSync(sessionFile, "{\"type\":\"message\"}\n");
		const now = Date.now();
		utimesSync(sessionFile, new Date(now - 90_000), new Date(now - 90_000));
		const facts: LegionChildStatusFacts = {
			name: "worker-0",
			state: "working",
			agent: "worker",
			kind: "pi",
			sessionFile,
			execution: {
				status: "running",
				reason: "collect deadline (cumulative since launch) exceeded; child still alive",
			},
			acceptance: { status: "unknown", level: "none" },
			alive: true,
		};
		const report = renderLegionStatus({
			query: "worker-0",
			nodes: [],
			lookupChild: () => facts,
			now,
		});
		assert.equal(report.ok, true);
		assert.equal(report.text, renderLiveChildStatus({ ...facts, now }));
		const lines = report.text.split("\n");
		assert.equal(lines[0], "worker-0 — state=working agent=worker kind=pi");
		assert.match(lines[1]!, /^alive · quiet \d+s \(living\)$/);
		assert.ok(report.text.indexOf("alive · quiet") < report.text.indexOf("execution snapshot:"));
		assert.match(report.text, /^execution snapshot: running$/m);
		assert.doesNotMatch(report.text, /collect deadline/);
		// #209: anchor on the `supervisor=` prefix — the fixture has no spawnMode,
		// so the value renders `unknown` and a literal `rpc` anchor would be a lie.
		assert.ok(report.text.indexOf("execution snapshot:") < report.text.indexOf("supervisor="));
	});
});

test("legion status falls back to the tree node when no child record exists", () => {
	const worker = node({
		id: "root.worker-0",
		name: "worker-0",
		parentId: "root",
		depth: 1,
		status: "blocked",
		sessionFile: "",
	});
	const report = renderLegionStatus({
		query: "worker-0",
		nodes: [worker],
		now: 0,
	});
	assert.equal(report.ok, true);
	assert.equal(report.text, renderLiveChildStatus({
		name: "worker-0",
		state: "blocked",
		agent: "worker",
		kind: "pi",
		sessionFile: "",
		alive: true,
		now: 0,
	}));
});

test("legion status reports unknown and ambiguous names", () => {
	const nodes = [
		node({ id: "root.a.worker", name: "worker", parentId: "root.a", depth: 2 }),
		node({ id: "root.b.worker", name: "worker", parentId: "root.b", depth: 2 }),
	];
	const ambiguous = renderLegionStatus({ query: "worker", nodes });
	assert.equal(ambiguous.ok, false);
	assert.match(ambiguous.text, /ambiguous/);
	assert.match(ambiguous.text, /\/legion status <node-id>/);
	const exact = renderLegionStatus({ query: "root.a.worker", nodes, now: 0 });
	assert.equal(exact.ok, true);
	assert.match(exact.text, /^worker — state=running/);
	const missing = renderLegionStatus({ query: "nope", nodes });
	assert.equal(missing.ok, false);
	assert.match(missing.text, /Unknown Legion node "nope"/);
});

test("/legion status sends chat text outside TUI and completes names", async () => {
	const nodes = [
		node({ id: "root", name: "root", parentId: null, depth: 0, role: "root", status: "settled" }),
		node({ id: "root.worker-0", name: "worker-0", parentId: "root", depth: 1, status: "running" }),
	];
	const messages: string[] = [];
	const notes: string[] = [];
	let command: {
		handler: (args: string, ctx: unknown) => Promise<void>;
		getArgumentCompletions?: (prefix: string) => Array<{ value: string; label: string }> | null;
	} | undefined;
	registerLegionCommand({
		registerCommand(_name: string, registered: NonNullable<typeof command>) {
			command = registered;
		},
		getSettings() {
			return {};
		},
		sendMessage(message: { content: string }) {
			messages.push(message.content);
		},
	} as never, {
		bus: createLegionEventBus(),
		runtime: {
			activeJobs: () => [{ name: "worker-0", nodeId: "root.worker-0", state: "working" }],
			treeNodes: () => nodes,
		},
		supervisor: {},
		childStatus: (name) => name === "worker-0"
			? {
				name: "worker-0",
				state: "working",
				agent: "worker",
				kind: "pi",
				sessionFile: "/tmp/worker-0.jsonl",
				execution: { status: "running" },
				alive: true,
			}
			: undefined,
	});
	assert.ok(command);
	const completions = command.getArgumentCompletions?.("") ?? [];
	assert.ok(completions.some((item) => item.value === "status"));
	assert.deepEqual(command.getArgumentCompletions?.("status w"), [
		{ value: "status worker-0", label: "worker-0 (root.worker-0)" },
	]);
	const ctx = {
		cwd: "/tmp/legion-status",
		mode: "headless",
		hasUI: false,
		ui: { notify: (message: string) => { notes.push(message); } },
	};
	await command.handler("status", ctx);
	assert.equal(notes.length, 0);
	assert.match(messages.at(-1) ?? "", /Legion status · 2 nodes/);
	assert.match(messages.at(-1) ?? "", /root\.worker-0 role=worker status=running/);
	await command.handler("status worker-0", ctx);
	assert.match(messages.at(-1) ?? "", /worker-0 — state=working agent=worker kind=pi/);
	assert.match(messages.at(-1) ?? "", /alive · quiet/);
	assert.match(messages.at(-1) ?? "", /execution snapshot: running/);
	await command.handler("status missing", ctx);
	assert.match(notes.at(-1) ?? "", /Unknown Legion node "missing"/);
});

// ---------------------------------------------------------------------------
// #266 A11 / D9-4: a queued child renders as `state=queued`, never `unknown`.
// ---------------------------------------------------------------------------

test("#266 A11: a queued child renders state=queued with its expected backend, not unknown", () => {
	// The queued record is a real run.json child (D3-a): it has a placeholder
	// sessionFile that does not exist yet and no execution snapshot at all.
	// `alive` is false because nothing was spawned, which is exactly the state
	// that used to fall through to `unknown child` / `supervisor=unknown`.
	const facts: LegionChildStatusFacts = {
		name: "scout-7",
		state: "queued",
		agent: "scout",
		kind: "pi",
		sessionFile: "/tmp/pi-legion-never-created/scout-7.jsonl",
		spawnMode: "inprocess",
		alive: false,
	};
	const rendered = renderLiveChildStatus(facts);
	assert.match(rendered, /state=queued/, "the queue state is shown literally (D9-4)");
	assert.match(rendered, /supervisor=inprocess/, "the expected backend is reported, not omitted");
	assert.doesNotMatch(rendered, /unknown child/, "a queued child is a known child");
	assert.doesNotMatch(rendered, /state=unknown/);
	// No liveness/memory line can be honest for a child that never ran.
	assert.doesNotMatch(rendered, /quiet/, "alive=false prints no quiet line");
	assert.doesNotMatch(rendered, /memory:/, "alive=false prints no memory line");

	// The same record through the named status route must not degrade either.
	const report = renderLegionStatus({ nodes: [], jobs: [], lookupChild: () => facts, query: "scout-7" });
	assert.equal(report.ok, true);
	assert.match(report.text, /state=queued/);
	assert.match(report.text, /supervisor=inprocess/);
	assert.doesNotMatch(report.text, /unknown/i);
});

test("#266 A11: a queued child is a live child, so status overview lists it", async () => {
	const { listLiveChildrenForStatus, renderStatusOverview } = await import("../../index.ts");
	const queuedChild = {
		name: "scout-7",
		sessionFile: "/tmp/pi-legion-never-created/scout-7.jsonl",
		ownerToken: "tok",
		state: "queued" as const,
		spawnedAt: "2026-01-01T00:00:00.000Z",
		agent: "scout",
		kind: "pi" as const,
		spawnMode: "inprocess" as const,
		queuePosition: 3,
	};
	const runs = [{
		schemaVersion: 1 as const,
		runId: "r-queued",
		task: "t",
		cwd: "/tmp",
		herdr: { supervisor: "inprocess" as const, node_id: "root" },
		path: [],
		depth: 0,
		maxDepth: 3,
		budget: { spawned: 0, limit: null, granted: 0 },
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		children: [queuedChild],
	}];
	const live = listLiveChildrenForStatus(runs);
	assert.equal(live.length, 1, "a queued child is live for status purposes (D9)");
	assert.equal(live[0]?.state, "queued");
	const overview = renderStatusOverview([{ child: live[0]!, alive: false }]);
	assert.match(overview, /state=queued/);
	assert.match(overview, /supervisor=inprocess/);
});
