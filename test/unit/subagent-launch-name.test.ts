/**
 * #101: launch must honor `name=` so `/legion status <requested-name>` works.
 *
 * Before the fix, launch ignored SubagentParams.name and always allocated
 * scout-N / worker-N, while the UI still showed the requested name=.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import piLegion, { resolveExplicitLaunchName } from "../../index.ts";
import { getChildByName, getSubtree } from "../../src/legion/nodes.ts";
import { openLegionDb } from "../../src/legion/db.ts";
import { renderLegionStatus } from "../../src/extension/legion-status.ts";
import { RunStore } from "../../src/runs/store.ts";
import { FakeSupervisor } from "../helpers/fake-supervisor.ts";
import { ErrorCodes } from "../../src/shared/types.ts";

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

function indexHarness(agents: Record<string, string> = { "scout.md": SCOUT_FILE, "worker.md": WORKER_FILE }) {
	const cwd = mkdtempSync(path.join(tmpdir(), "legion-launch-name-"));
	const agentDir = path.join(cwd, "agent-config");
	const extraAgentsDir = path.join(cwd, "extra-agents");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(extraAgentsDir, { recursive: true });
	writeFileSync(
		path.join(agentDir, "settings.json"),
		JSON.stringify({ subagents: { disableBuiltins: true } }),
	);
	for (const [file, content] of Object.entries(agents)) {
		writeFileSync(path.join(extraAgentsDir, file), content);
	}
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
				"launch-name-test",
				params,
				undefined,
				undefined,
				{ cwd, hasUI: false, ui: { notify() {}, setStatus() {} } },
			);
			return {
				text: (result.content ?? []).map((item) => item.text ?? "").join("\n"),
				details: result.details as { error?: string } | undefined,
			};
		},
		async cleanup() {
			await handlers.get("session_shutdown")?.();
			restoreEnv(previous);
			rmSync(cwd, { recursive: true, force: true });
		},
	};
}

function openHarnessLegionDb(cwd: string) {
	const store = new RunStore({ rootDir: path.join(cwd, ".pi-subagents") });
	const runs = store.listRuns();
	assert.ok(runs.length > 0, "expected a root run after launch");
	const dbPath = path.join(store.runDir(runs[0]!.runId), "legion.db");
	return { store, db: openLegionDb(dbPath), runs };
}

test("resolveExplicitLaunchName: omit / honor / reject invalid / reject multi-step", () => {
	assert.deepEqual(resolveExplicitLaunchName(undefined, 1), { ok: true });
	assert.deepEqual(resolveExplicitLaunchName("scout-a", 1), { ok: true, name: "scout-a" });
	assert.deepEqual(resolveExplicitLaunchName("Scout-A", 1), { ok: true, name: "scout-a" });
	assert.equal(resolveExplicitLaunchName("  ", 1).ok, false);
	assert.equal(resolveExplicitLaunchName("scout a", 1).ok, false);
	assert.equal(resolveExplicitLaunchName("1scout", 1).ok, false);
	assert.equal(resolveExplicitLaunchName("scout-a", 2).ok, false);
});

test("#101 launch with name= registers that handle (not auto scout-N)", async () => {
	const harness = indexHarness();
	try {
		const launched = await harness.invoke({
			agent: "scout",
			task: "recon TOKEN_A",
			name: "scout-a",
			async: true,
			worktree: false,
		});
		assert.match(launched.text, /▶ scout-a \(scout\)/);
		assert.doesNotMatch(launched.text, /▶ scout-0/);
		assert.equal(harness.supervisor.spawns[0]?.input.name, "scout-a");

		const { store, db } = openHarnessLegionDb(harness.cwd);
		try {
			const child = store.listRuns().flatMap((run) => run.children).find((entry) => entry.name === "scout-a");
			assert.ok(child, "run store must record scout-a");
			assert.equal(child.nodeId, "root.scout-a");

			const node = getChildByName(db, "root", "scout-a");
			assert.ok(node, "legion ledger must register scout-a");
			assert.equal(node.id, "root.scout-a");
			assert.equal(
				getSubtree(db, "root").some((n) => n.name === "scout-0"),
				false,
			);

			const slash = renderLegionStatus({
				query: "scout-a",
				nodes: getSubtree(db, "root"),
				jobs: [{ name: "scout-a", nodeId: "root.scout-a", state: "working" }],
			});
			assert.equal(slash.ok, true);
			assert.doesNotMatch(slash.text, /Unknown Legion node/);

			const slashMiss = renderLegionStatus({
				query: "scout-0",
				nodes: getSubtree(db, "root"),
			});
			assert.equal(slashMiss.ok, false);
			assert.match(slashMiss.text, /Unknown Legion node "scout-0"/);
		} finally {
			db.close();
		}
	} finally {
		await harness.cleanup();
	}
});

test("#101 status by requested name works; auto name still allocates without name=", async () => {
	const harness = indexHarness();
	try {
		await harness.invoke({
			agent: "scout",
			task: "named",
			name: "scout-a",
			async: true,
			worktree: false,
		});
		const byName = await harness.invoke({ action: "status", name: "scout-a" });
		assert.doesNotMatch(byName.text, /unknown child/i);
		assert.match(byName.text, /scout-a/);

		const missing = await harness.invoke({ action: "status", name: "scout-0" });
		assert.match(missing.text, /unknown child: scout-0/);

		const auto = await harness.invoke({
			agent: "worker",
			task: "unnamed",
			async: true,
			worktree: false,
		});
		assert.match(auto.text, /▶ worker-0 \(worker\)/);
		assert.equal(harness.supervisor.spawns.at(-1)?.input.name, "worker-0");
	} finally {
		await harness.cleanup();
	}
});

test("#101 collision and invalid name refuse clearly", async () => {
	const harness = indexHarness();
	try {
		await harness.invoke({
			agent: "scout",
			task: "first",
			name: "scout-a",
			async: true,
			worktree: false,
		});
		const collision = await harness.invoke({
			agent: "scout",
			task: "second",
			name: "scout-a",
			async: true,
			worktree: false,
		});
		assert.match(collision.text, /NAME_TAKEN|already alive|already exists/i);

		const invalid = await harness.invoke({
			agent: "scout",
			task: "bad name",
			name: "Scout A!",
			async: true,
			worktree: false,
		});
		assert.match(invalid.text, /invalid child name/i);
		assert.equal(invalid.details?.error, ErrorCodes.INVALID_PARAMS);

		const multi = await harness.invoke({
			name: "shared",
			tasks: [
				{ agent: "scout", task: "a" },
				{ agent: "worker", task: "b" },
			],
			async: true,
			worktree: false,
		});
		assert.match(multi.text, /name.*single|tasks\[\]/i);
		assert.equal(multi.details?.error, ErrorCodes.INVALID_PARAMS);
	} finally {
		await harness.cleanup();
	}
});

// ─────────────────────────────────────────────────────────────────────────────
// A `name` on a `tasks[]` ENTRY was silently dropped: only the call-level
// `name=` reached `launch`, so every child of a named fan-out came back as
// `scout-N`/`worker-N` with nothing telling the caller its handle had been
// ignored. Per-item handles are honored now, and a batch whose handles cannot
// all be honored spawns nothing at all.
// ─────────────────────────────────────────────────────────────────────────────

test("tasks[] per-item names reach the supervisor and the run store", async () => {
	const harness = indexHarness();
	try {
		const launched = await harness.invoke({
			tasks: [
				{ agent: "scout", task: "recon TOKEN_A", name: "scout-a" },
				{ agent: "worker", task: "build TOKEN_B", name: "worker-b" },
			],
			async: true,
			worktree: false,
		});
		assert.match(launched.text, /▶ scout-a \(scout\)/);
		assert.match(launched.text, /▶ worker-b \(worker\)/);
		assert.doesNotMatch(launched.text, /▶ scout-0/);
		assert.doesNotMatch(launched.text, /▶ worker-0/);
		assert.deepEqual(
			harness.supervisor.spawns.map((spawn) => spawn.input.name).sort(),
			["scout-a", "worker-b"],
		);

		const { store, db } = openHarnessLegionDb(harness.cwd);
		try {
			const children = store.listRuns().flatMap((run) => run.children);
			for (const [name, agent] of [
				["scout-a", "scout"],
				["worker-b", "worker"],
			] as const) {
				const child = children.find((entry) => entry.name === name);
				assert.ok(child, `run store must record ${name}`);
				assert.equal(child.agent, agent);
				assert.equal(child.nodeId, `root.${name}`);
				assert.ok(getChildByName(db, "root", name), `legion ledger must register ${name}`);
			}
		} finally {
			db.close();
		}
	} finally {
		await harness.cleanup();
	}
});

test("an unhonorable tasks[] name spawns nothing (no partial start)", async () => {
	const harness = indexHarness();
	try {
		const refused = await harness.invoke({
			tasks: [
				{ agent: "scout", task: "healthy sibling", name: "scout-a" },
				{ agent: "worker", task: "bad handle", name: "Worker B!" },
			],
			async: true,
			worktree: false,
		});
		assert.equal(refused.details?.error, ErrorCodes.INVALID_PARAMS);
		assert.match(refused.text, /tasks\[\]: step 2/);
		assert.equal(
			harness.supervisor.spawns.length,
			0,
			"the healthy first entry must not be launched around the refusal",
		);
	} finally {
		await harness.cleanup();
	}
});

test("a one-entry tasks[] handle comes from either place, never from two", async () => {
	const agreed = indexHarness();
	try {
		const launched = await agreed.invoke({
			name: " Worker-A ",
			tasks: [{ agent: "worker", task: "same handle in both places", name: "worker-a" }],
			async: true,
			worktree: false,
		});
		assert.match(launched.text, /▶ worker-a \(worker\)/);
		assert.deepEqual(
			agreed.supervisor.spawns.map((spawn) => spawn.input.name),
			["worker-a"],
		);
	} finally {
		await agreed.cleanup();
	}

	const refusals: Array<[string, Record<string, unknown>]> = [
		[
			"two different handles for one child",
			{ name: "worker-b", tasks: [{ agent: "worker", task: "x", name: "worker-a" }] },
		],
		[
			"the same handle twice in one batch",
			{
				tasks: [
					{ agent: "worker", task: "x", name: "worker-a" },
					{ agent: "scout", task: "y", name: "WORKER-A" },
				],
			},
		],
	];
	for (const [label, params] of refusals) {
		const harness = indexHarness();
		try {
			const refused = await harness.invoke({ ...params, async: true, worktree: false });
			assert.equal(refused.details?.error, ErrorCodes.INVALID_PARAMS, label);
			assert.equal(harness.supervisor.spawns.length, 0, `${label}: nothing may be launched`);
		} finally {
			await harness.cleanup();
		}
	}
});
