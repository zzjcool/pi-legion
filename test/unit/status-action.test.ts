/**
 * #145: subagent({ action: "status" }) without name returns live-children overview.
 *
 * Named status and unknown-name NOT_FOUND stay unchanged; slash /legion status
 * is out of scope.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import piLegion, {
	listLiveChildrenForStatus,
	renderStatusOverview,
} from "../../index.ts";
import { FakeSupervisor } from "../helpers/fake-supervisor.ts";
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
	piLegion(pi as never, { supervisor });
	const tool = tools.get("subagent");
	assert.ok(tool);
	return {
		cwd,
		supervisor,
		tool,
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

		const overview = await harness.invoke({ action: "status" });
		assert.doesNotMatch(overview.text, /name` is required/i);
		assert.notEqual(overview.details?.error, ErrorCodes.INVALID_PARAMS);
		assert.match(overview.text, /Status · 2 live children/);
		assert.match(overview.text, /scout-a/);
		assert.match(overview.text, /worker-b/);

		const viaAll = await harness.invoke({ action: "status", all: true });
		assert.match(viaAll.text, /Status · 2 live children/);
		assert.match(viaAll.text, /scout-a/);
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
