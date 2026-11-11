/**
 * Polish round (`.pi-subagents/polish-round-contract.md`) — the model-facing surface.
 *
 * Three layers, all driven through exported seams:
 *   1. D6 — what a rendered result says about criteria that carry no machine verdict.
 *      Two banners: required ones gate the verdict, optional ones never did.
 *   2. D7 — the retired/finished list `status all` appends (the pure half; the tool
 *      wiring is pinned in `status-action.test.ts`).
 *   3. D2 / D8 / D9 — what the tool SCHEMA promises: two different `verify`s, the real
 *      `timeoutMs` default, and the still-running payload that must carry no dead field.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import piLegion, {
	buildWaitTimeoutDetails,
	listFinishedChildrenForStatus,
	renderCollect,
	renderFinishedStatusSection,
	renderWait,
	verificationLookup,
} from "../../index.ts";
import { runVerification, verificationSummary } from "../../src/extension/legion-tools.ts";
import { openLegionDb } from "../../src/legion/db.ts";
import { getNode, insertNode, updateNode } from "../../src/legion/nodes.ts";
import { FakeSupervisor } from "../helpers/fake-supervisor.ts";
import { DEFAULTS } from "../../src/shared/types.ts";
import type { CollectSnapshot } from "../../src/extension/runtime.ts";
import type { ChildRecord, RunRecord } from "../../src/shared/types.ts";

initTheme("dark");

/** A finished result whose acceptance carries criteria only a human/model can judge. */
function criteriaSnapshot(
	criteria: Array<{ id: string; must: string; severity?: string }>,
): CollectSnapshot {
	return {
		execution: { status: "success" },
		output: "the answer",
		acceptance: { status: "needs-review", level: "attested", pendingCriteria: criteria },
	};
}

// ── D6: the optional banner no longer demands confirmation ──────────────

test("D6: required criteria keep the gating banner and the per-line (optional) tag", () => {
	const rendered = renderWait([
		{
			name: "a",
			snapshot: criteriaSnapshot([
				{ id: "typecheck-test-pass", must: "npm run typecheck passes" },
				{ id: "readable-diff", must: "the diff reads well", severity: "optional" },
			]),
		},
	]);
	// A required criterion is present, so the banner does claim the verdict.
	assert.match(rendered, /^unverified criteria — these gate the verdict:$/m);
	// The old wording told the caller these all had to be confirmed first; D6 retires it.
	assert.doesNotMatch(rendered, /you must confirm these/);
	assert.match(rendered, /^ {2}\[ \] typecheck-test-pass: npm run typecheck passes$/m);
	// The optional one is still LISTED and still tagged — it just does not gate.
	assert.match(rendered, /^ {2}\[ \] readable-diff \(optional\): the diff reads well$/m);
});

test("D6: an all-optional list never claims to gate the verdict", () => {
	const rendered = renderWait([
		{
			name: "a",
			snapshot: criteriaSnapshot([
				{ id: "nice-names", must: "tidy the identifiers", severity: "optional" },
				{ id: "short-comment", must: "keep the comment under two lines", severity: "optional" },
			]),
		},
	]);
	assert.match(rendered, /^optional criteria — fix them if cheap, but they do not gate the verdict:$/m);
	assert.doesNotMatch(rendered, /these gate the verdict/);
	assert.doesNotMatch(rendered, /you must confirm these/);
	// Per-line labels are unchanged in this shape too.
	assert.match(rendered, /^ {2}\[ \] nice-names \(optional\): tidy the identifiers$/m);
	assert.match(rendered, /^ {2}\[ \] short-comment \(optional\): keep the comment under two lines$/m);
});

test("D6: no criteria renders no banner at all", () => {
	const rendered = renderWait([
		{
			name: "a",
			snapshot: {
				execution: { status: "success" },
				output: "the answer",
				acceptance: { status: "accepted", level: "attested" },
			},
		},
	]);
	assert.doesNotMatch(rendered, /criteria/);
});

// ── D7: the retired/finished list `status all` appends ──────────────────

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

function runStub(
	runId: string,
	children: ChildRecord[],
	createdAt = "2026-01-01T00:00:00.000Z",
): RunRecord {
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

test("D7: the finished list keeps terminal records, newest first, one row per name", () => {
	const runs = [
		runStub(
			"old",
			[
				childStub({
					name: "gone",
					state: "retired",
					execution: { status: "success" },
					retiredAt: "2026-01-02T00:00:00.000Z",
				}),
			],
			"2026-01-01T00:00:00.000Z",
		),
		runStub(
			"new",
			[
				childStub({ name: "live-one", state: "working" }),
				childStub({ name: "exited-one", state: "exited", execution: { status: "failed" } }),
				// Same name as the older record: the NEWEST one wins, exactly like
				// `classifyChildrenForStatus` prefers the newest live record.
				childStub({ name: "gone", state: "exited", execution: { status: "failed" } }),
			],
			"2026-01-03T00:00:00.000Z",
		),
	];
	const finished = listFinishedChildrenForStatus(runs);
	assert.deepEqual(
		finished.map((child) => `${child.name}:${child.state}`),
		["exited-one:exited", "gone:exited"],
	);
	// A live record under the same name is never shadowed by an older terminal one.
	assert.equal(finished.some((child) => child.name === "live-one"), false);
});

test("D7: a name that is live elsewhere is not listed twice", () => {
	const runs = [
		runStub("r", [
			childStub({ name: "reused", state: "exited" }),
			childStub({ name: "other", state: "retired" }),
		]),
	];
	assert.deepEqual(
		listFinishedChildrenForStatus(runs, ["reused"]).map((child) => child.name),
		["other"],
	);
});

test("D7: the section names the state, the agent and what the child settled with", () => {
	assert.equal(renderFinishedStatusSection([]), undefined);
	const section = renderFinishedStatusSection([
		childStub({
			name: "scout-a",
			state: "retired",
			agent: "scout",
			execution: { status: "success" },
			retiredAt: "2026-01-02T03:04:05.000Z",
		}),
		childStub({ name: "worker-b", state: "exited", agent: "worker" }),
	]);
	assert.equal(
		section,
		[
			"retired/finished (2):",
			"  scout-a — state=retired agent=scout (execution: success, retired at 2026-01-02T03:04:05.000Z)",
			"  worker-b — state=exited agent=worker",
		].join("\n"),
	);
});

// ── D9: the still-running payload carries no dead field ─────────────────

test("D9: the still-running payload is exactly name + elapsedMs", () => {
	const details = buildWaitTimeoutDetails([
		{ name: "live", stillRunning: true, timedOut: true, elapsedMs: 12_345 },
	]);
	assert.ok(details);
	assert.deepEqual(details!.stillRunning, [{ name: "live", elapsedMs: 12_345 }]);
	// `budgetMs` was declared and never written or read anywhere (contract D9). A
	// payload key nobody fills is a promise the shape does not keep.
	assert.deepEqual(Object.keys(details!.stillRunning[0]!), ["name", "elapsedMs"]);
});

// ── D2 / D8: what the tool schema promises ──────────────────────────────

const ENV_KEYS = [
	"PI_CODING_AGENT_DIR",
	"PI_HERDR_SUBAGENTS_EXTRA_AGENT_DIRS",
	"PI_SUBAGENT_CHILD",
	"PI_SUBAGENT_ALLOW_NESTED",
	"PI_LEGION_DB",
	"PI_LEGION_NODE_ID",
	"PI_SUBAGENTS_TEAM",
];

/** The `subagent`/`vexillatio` schemas exactly as a model receives them. */
interface SchemaNode {
	description?: string;
	properties?: Record<string, SchemaNode>;
	items?: SchemaNode;
	[key: string]: unknown;
}

function restoreEnv(previous: Map<string, string | undefined>): void {
	for (const [name, value] of previous) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
}

/**
 * A minimal `piLegion` registration: the tool schemas are the only thing this file
 * needs, so nothing here launches a child. Built as a fresh process env (agent dirs,
 * a cleared child/legion identity) so `vexillatio` is really registered — it is
 * skipped for utility children, which is a different surface.
 */
function schemaHarness() {
	const cwd = mkdtempSync(path.join(tmpdir(), "tool-surface-polish-"));
	const agentDir = path.join(cwd, "agent-config");
	const extraAgentsDir = path.join(cwd, "extra-agents");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(extraAgentsDir, { recursive: true });
	writeFileSync(
		path.join(agentDir, "settings.json"),
		JSON.stringify({ subagents: { disableBuiltins: true } }),
	);
	writeFileSync(
		path.join(extraAgentsDir, "worker.md"),
		"---\nname: worker\ndescription: worker role\nkind: pi\n---\nworker prompt\n",
	);
	const previous = new Map(ENV_KEYS.map((name) => [name, process.env[name]]));
	const tools = new Map<string, SchemaNode>();
	const handlers = new Map<string, (...args: unknown[]) => unknown>();
	const pi = {
		registerTool(value: unknown) {
			const typed = value as { name: string; parameters?: SchemaNode };
			if (typed.parameters) tools.set(typed.name, typed.parameters);
		},
		registerCommand() {},
		registerMessageRenderer() {},
		sendMessage() {},
		events: { emit() {} },
		on(name: string, handler: (...args: unknown[]) => unknown) {
			handlers.set(name, handler);
		},
	};
	process.env.PI_CODING_AGENT_DIR = agentDir;
	process.env.PI_HERDR_SUBAGENTS_EXTRA_AGENT_DIRS = extraAgentsDir;
	for (const name of ENV_KEYS.slice(2)) delete process.env[name];
	piLegion(pi as never, { supervisor: new FakeSupervisor({ immediateTimeout: false }) });
	return {
		schema(tool: string): SchemaNode {
			const found = tools.get(tool);
			assert.ok(found, `${tool} must be registered`);
			return found;
		},
		async cleanup() {
			await handlers.get("session_shutdown")?.();
			restoreEnv(previous);
			rmSync(cwd, { recursive: true, force: true });
		},
	};
}

test("D2: both launch-level `verify` fields say they are NOT the legion-verify fence", async () => {
	const harness = schemaHarness();
	try {
		const params = harness.schema("subagent");
		const topLevel = params.properties?.verify?.description ?? "";
		const perStep = params.properties?.tasks?.items?.properties?.verify?.description ?? "";
		assert.ok(topLevel.length > 0, "subagent.verify must be documented");
		assert.ok(perStep.length > 0, "tasks[].verify must be documented");
		for (const [label, description] of [
			["subagent.verify", topLevel],
			["tasks[].verify", perStep],
		] as const) {
			assert.match(description, /NOT the contract's ```legion-verify fence/, label);
			assert.match(description, /supervisor/, `${label}: names who runs the fence one`);
			assert.match(description, /`verifying`/, `${label}: names the phase it is run in`);
			// The distinction is separate from the collect-time attestation, not a
			// replacement for it.
			assert.match(description, /collect time/, `${label}: keeps the original promise`);
		}
	} finally {
		await harness.cleanup();
	}
});

test("D8: the wait schema states the real default (smallest role timeout, else 15m)", async () => {
	const harness = schemaHarness();
	try {
		// The WAIT action takes the smallest target role timeout, then DEFAULTS.turnTimeoutMs.
		const subagent = harness.schema("subagent").properties?.timeoutMs?.description ?? "";
		assert.match(subagent, /smallest role `timeoutMs` among the targets/, "subagent.timeoutMs");
		assert.match(subagent, /900000 \(15m\)/, "subagent.timeoutMs");
		// The UTILITY launcher is a different field with a different default (`?? 600_000`
		// in its handler). Conflating the two is how the old text got this wrong; keep the
		// distinction pinned so a future edit cannot "unify" them back.
		const vexillatio = harness.schema("vexillatio").properties?.timeoutMs?.description ?? "";
		assert.match(vexillatio, /default 600000/, "vexillatio.timeoutMs");
		assert.doesNotMatch(vexillatio, /900000/, "vexillatio.timeoutMs");
		// The claim the schema makes is the constant `waitAction` actually falls back to.
		assert.equal(DEFAULTS.turnTimeoutMs, 900_000);
	} finally {
		await harness.cleanup();
	}
});

test("D7: the `all` parameter documents what it adds to a status overview", async () => {
	const harness = schemaHarness();
	try {
		const description = harness.schema("subagent").properties?.all?.description ?? "";
		// The switch is not silently useless in either direction: it names its effect.
		assert.match(description, /status: .*retired\/finished/);
		assert.match(description, /`all:true`/);
		// wait/stop meanings are untouched by this round.
		assert.match(description, /wait: REQUIRED unless name is set/);
		assert.match(description, /stop every non-retired child/);
	} finally {
		await harness.cleanup();
	}
});

// ---------------------------------------------------------------------------
// #5 — the collect head says what the CONTRACT verification measured
// ---------------------------------------------------------------------------

test("#5: the collect head names an empty pass, and says nothing when there is no legion run", () => {
	const snapshot: CollectSnapshot = {
		execution: { status: "success" },
		output: "body text",
		acceptance: { status: "accepted" },
	};
	const render = (verification: Parameters<typeof renderCollect>[3]) =>
		renderCollect("team-a", snapshot, undefined, verification);

	assert.match(
		render({ commandCount: 3, outputFile: "/tmp/v.log", checkedAt: 1, stale: false }),
		/^verification: 3 command\(s\) · log \/tmp\/v\.log$/m,
		"a real pass names the count and the log",
	);
	assert.match(
		render({ commandCount: 0, checkedAt: 1, stale: false }),
		/^verification: 0 commands — by contract, nothing ran$/m,
		"0 commands is named as a pass by contract, not as a green",
	);
	assert.match(
		render({ commandCount: 3, outputFile: "/tmp/v.log", checkedAt: 1, stale: true }),
		/^verification: STALE — the checkout changed after the pass \(3 command\(s\), \/tmp\/v\.log\)$/m,
		"a stale pass is the other empty shape, and it says why",
	);
	assert.match(render(null), /^verification: never ran \(no contract\)$/m, "a legion child with no row says so");
	assert.doesNotMatch(render(undefined), /^verification:/m, "a non-legion caller gets no line, not a guess");
});

test("#5: the lookup answers per child name and follows the checkout", async () => {
	const db = openLegionDb(":memory:");
	const dir = mkdtempSync(path.join(tmpdir(), "legion-verify-head-"));
	const contractFile = path.join(dir, ".pi-legion", "contract.md");
	try {
		mkdirSync(path.join(dir, ".pi-legion"), { recursive: true });
		writeFileSync(contractFile, "```legion-verify\nnpm test\n```\n");
		insertNode(db, { parentId: null, name: "root", role: "root", status: "running" }, () => 10);
		insertNode(db, { parentId: "root", name: "team", role: "centurion", status: "running", phase: "verifying", phaseSince: 10 }, () => 10);
		insertNode(db, { parentId: "root.team", name: "worker", role: "worker", status: "running" }, () => 10);
		// A TEAM-shaped child: a verification row only ever exists on a node with a phase
		// (a worker never runs a contract, and the lookup must not claim it "never ran").
		insertNode(db, { parentId: "root.team", name: "squad", role: "centurion", status: "running", phase: "verifying", phaseSince: 10 }, () => 10);
		// A team that has not verified yet — present BEFORE the lookup is taken (the
		// resolver is a snapshot of this node's children, which is all a tool call needs).
		insertNode(db, { parentId: "root.team", name: "quiet", role: "centurion", status: "running", phase: "implementing", phaseSince: 10 }, () => 10);
		await runVerification(db, getNode(db, "root.team.squad")!, "```legion-verify\nnpm test\n```\n", {
			cwd: dir, runDir: dir, now: () => 20, contractFile,
			runCommand: async () => ({ code: 0, stdout: "", stderr: "" }),
		});
		const lookup = verificationLookup({ db, nodeId: "root.team" });
		assert.ok(lookup, "a legion caller gets a resolver");
		const facts = lookup("squad");
		assert.equal(facts?.commandCount, 1);
		assert.equal(facts?.stale, false, "the pass still describes its checkout");
		assert.equal(lookup("no-such-child"), undefined, "a name that is not a child gets no verdict line");
		assert.equal(lookup("worker"), undefined, "a child without a phase never runs a contract");
		assert.equal(verificationLookup(undefined), undefined, "no legion identity, no resolver");

		// The node moves to another checkout: the pass is still the last thing that ran,
		// and the render has to say it no longer covers what would be delivered.
		updateNode(db, "root.team.squad", { worktreePath: path.join(dir, "elsewhere") }, () => 21);
		assert.equal(verificationSummary(getNode(db, "root.team.squad")!)?.stale, true);
		// A team that has not verified yet has no record at all.
		assert.equal(verificationSummary(getNode(db, "root.team.quiet")!), undefined);
		assert.equal(lookup("quiet"), null, "a team with no row says it never ran");
	} finally {
		db.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
