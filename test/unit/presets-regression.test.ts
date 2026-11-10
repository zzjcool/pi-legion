/** End-to-end model/preset regressions through the real registered RPC tool. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import piLegion from "../../index.ts";
import { RunStore } from "../../src/runs/store.ts";
import { FakeSupervisor } from "../helpers/fake-supervisor.ts";

const BROKEN = "---\nname: broken\ndescription: b\npreset: nonexistent\n---\np\n";
const HEALTHY = "---\nname: healthy\ndescription: h\n---\np\n";
const UTILITY = "---\nname: scout\ndescription: read-only utility role\nutility: true\ntools: read, grep, find, ls\nkind: pi\n---\np\n";

type ToolResult = { content?: Array<{ text?: string }> };
type Tool = {
	parameters: { properties?: Record<string, unknown>; additionalProperties?: boolean };
	execute: (...args: unknown[]) => Promise<ToolResult>;
};

interface BatchOutcome {
	threw?: Error;
	text: string;
	parameters: Tool["parameters"];
	supervisor: FakeSupervisor;
}

interface Harness {
	dir: string;
	supervisor: FakeSupervisor;
	tools: Map<string, Tool>;
	/** Run `session_shutdown`, restore the env snapshot and delete the temp tree. */
	cleanup(): void;
}

/**
 * Boot the extension over a throwaway settings/agent tree with a fake RPC
 * supervisor.
 *
 * Every test here needs the same env snapshot, temp agent dirs, pi stub and
 * teardown; only the tool call afterwards differs, so that scaffolding lives in
 * one place.
 */
function startHarness(params: {
	settings: Record<string, unknown>;
	agents: Record<string, string>;
	supervisor?: ConstructorParameters<typeof FakeSupervisor>[0];
	/** Blank the Legion env so a revive takes the plain run-store path. */
	plainRunStore?: boolean;
}): Harness {
	const dir = mkdtempSync(path.join(tmpdir(), "rpc-model-harness-"));
	const previous = new Map<string, string | undefined>(
		([
			"PI_SUBAGENT_CHILD",
			"PI_CODING_AGENT_DIR",
			"PI_HERDR_SUBAGENTS_EXTRA_AGENT_DIRS",
			"PI_LEGION_DB",
			"PI_LEGION_NODE_ID",
		] as const).map((name) => [name, process.env[name]] as const),
	);
	const agentDir = path.join(dir, "agentdir");
	const extra = path.join(dir, "extra-agents");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(extra, { recursive: true });
	writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ subagents: params.settings }));
	for (const [file, content] of Object.entries(params.agents)) {
		writeFileSync(path.join(extra, file), content);
	}
	process.env.PI_CODING_AGENT_DIR = agentDir;
	process.env.PI_HERDR_SUBAGENTS_EXTRA_AGENT_DIRS = extra;
	delete process.env.PI_SUBAGENT_CHILD;
	if (params.plainRunStore) {
		delete process.env.PI_LEGION_DB;
		delete process.env.PI_LEGION_NODE_ID;
	}

	const supervisor = new FakeSupervisor(params.supervisor);
	const tools = new Map<string, Tool>();
	const handlers = new Map<string, (...args: unknown[]) => unknown>();
	const pi = {
		registerTool(tool: unknown) {
			const registered = tool as Tool & { name: string };
			tools.set(registered.name, registered);
		},
		registerMessageRenderer() {},
		registerCommand() {},
		sendMessage() {},
		events: { emit() {} },
		on(name: string, handler: (...args: unknown[]) => unknown) { handlers.set(name, handler); },
	};
	const cleanup = (): void => {
		handlers.get("session_shutdown")?.();
		for (const [name, value] of previous) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
		rmSync(dir, { recursive: true, force: true });
	};
	try {
		piLegion(pi as never, { supervisor });
	} catch (error) {
		// A failed registration must not leave the process env pointing at this
		// temp tree for every later test in the file.
		cleanup();
		throw error;
	}
	return { dir, supervisor, tools, cleanup };
}

/** The registered tool this call drives, asserted to exist. */
function toolOf(harness: Harness, name: string): Tool {
	const tool = harness.tools.get(name);
	assert.ok(tool, `${name} tool must be registered`);
	return tool;
}

function textOf(result: ToolResult): string {
	return (result.content ?? []).map((block) => block.text ?? "").join("\n");
}

/** The minimal tool context: a cwd, no UI and (optionally) a dispatching model. */
function contextOf(harness: Harness, dispatchModel?: string): Record<string, unknown> {
	return {
		cwd: harness.dir,
		hasUI: false,
		ui: { notify() {}, confirm: async () => true, setStatus() {} },
		...(dispatchModel
			? { model: { provider: dispatchModel.split("/")[0], id: dispatchModel.split("/").slice(1).join("/") } }
			: {}),
	};
}

/** Drive the real launch planner with a fake RPC supervisor and isolated settings. */
async function runBatch(params: {
	settings: Record<string, unknown>;
	agents: Record<string, string>;
	tasks: Array<Record<string, unknown>>;
	toolParams?: Record<string, unknown>;
	dispatchModel?: string;
}): Promise<BatchOutcome> {
	const harness = startHarness({ settings: params.settings, agents: params.agents });
	let text = "";
	let threw: Error | undefined;
	let parameters: Tool["parameters"] = {};
	try {
		const tool = toolOf(harness, "subagent");
		parameters = tool.parameters;
		try {
			text = textOf(await tool.execute(
				"rpc-presets-test",
				{ ...(params.toolParams ?? { tasks: params.tasks }), async: false, worktree: false },
				undefined,
				undefined,
				contextOf(harness, params.dispatchModel),
			));
		} catch (error) {
			threw = error instanceof Error ? error : new Error(String(error));
		}
	} finally {
		harness.cleanup();
	}
	return { ...(threw ? { threw } : {}), text, parameters, supervisor: harness.supervisor };
}

test("launch: a legacy chain field is ignored and cannot start a child", async () => {
	const result = await runBatch({
		settings: {},
		agents: { "healthy.md": HEALTHY },
		tasks: [],
		toolParams: { chain: [{ agent: "healthy", task: "this must not be launched" }] },
	});
	assert.equal(result.threw, undefined, `tool execution must not throw: ${result.threw?.message}`);
	assert.equal(Object.hasOwn(result.parameters.properties ?? {}, "chain"), false);
	assert.equal(result.parameters.additionalProperties, undefined);
	assert.match(result.text, /Provide one of: \(agent\+task\) or tasks\[\]\./);
	assert.equal(result.supervisor.spawns.length, 0, "legacy chain data must not reach RpcSupervisor");
});

// BUG P1: a malformed step must not reject Promise.all or discard its siblings.
test("BUG P1: an undefined preset degrades to a refusal instead of throwing", async () => {
	const result = await runBatch({
		settings: { presets: {} },
		agents: { "broken.md": BROKEN, "healthy.md": HEALTHY },
		tasks: [{ agent: "broken", task: "t1" }, { agent: "healthy", task: "t2" }],
	});
	assert.equal(result.threw, undefined, `bad preset escaped launchStep: ${result.threw?.message}`);
	assert.match(result.text, /✗ broken: /);
	assert.match(result.text, /Preset 'nonexistent' is not defined in subagents\.presets\./);
});

test("BUG P1: the healthy sibling reaches RPC spawn despite the bad preset", async () => {
	const result = await runBatch({
		settings: { presets: {} },
		agents: { "broken.md": BROKEN, "healthy.md": HEALTHY },
		tasks: [{ agent: "broken", task: "t1" }, { agent: "healthy", task: "t2" }],
	});
	assert.match(result.text, /▶\s+\S*healthy/);
	assert.equal(result.supervisor.spawns.length, 1);
	assert.equal(result.supervisor.spawns[0]?.input.agent.name, "healthy");
});

test("BUG P1: the refusal names the presets that ARE defined", async () => {
	const result = await runBatch({
		settings: { presets: { strong: { kind: "pi", model: "cb/kimi-k3" } } },
		agents: { "broken.md": BROKEN },
		tasks: [{ agent: "broken", task: "t1" }],
	});
	assert.match(result.text, /Preset 'nonexistent' is not defined in subagents\.presets\. Defined: strong\./);
	assert.equal(result.supervisor.spawns.length, 0);
});

test("launch: a defined preset's model and thinking reach RPC SpawnInput", async () => {
	const result = await runBatch({
		settings: { presets: { strong: { kind: "pi", model: "cb/kimi-k3", thinking: "max" } } },
		agents: { "healthy.md": "---\nname: healthy\ndescription: h\npreset: strong\n---\np\n" },
		tasks: [{ agent: "healthy", task: "t1" }],
	});
	assert.match(result.text, /▶\s+\S*healthy/);
	assert.equal(result.supervisor.spawns[0]?.input.model, "cb/kimi-k3");
	assert.ok(result.supervisor.spawns[0]?.args.includes("cb/kimi-k3:max"));
});

test("launch: a preset beats a folded agentOverrides model end-to-end", async () => {
	const result = await runBatch({
		settings: {
			agentOverrides: { healthy: { model: "cb/deepseek-v4.1-flash" } },
			presets: { strong: { kind: "pi", model: "cb/kimi-k3" } },
		},
		agents: { "healthy.md": "---\nname: healthy\ndescription: h\npreset: strong\n---\np\n" },
		tasks: [{ agent: "healthy", task: "t1" }],
	});
	assert.equal(result.supervisor.spawns[0]?.input.model, "cb/kimi-k3");
	assert.equal(result.supervisor.spawns[0]?.args.includes("cb/deepseek-v4.1-flash"), false);
});

test("launch: a per-step preset overrides the role's preset", async () => {
	const result = await runBatch({
		settings: { presets: { cheap: { kind: "pi", model: "cb/deepseek-v4.1-flash" }, strong: { kind: "pi", model: "cb/kimi-k3" } } },
		agents: { "healthy.md": "---\nname: healthy\ndescription: h\npreset: cheap\n---\np\n" },
		tasks: [{ agent: "healthy", task: "t1", preset: "strong" }],
	});
	assert.equal(result.supervisor.spawns[0]?.input.model, "cb/kimi-k3");
});

// ─────────────────── model scope: real origin, visible warn ───────────────────

const SCOPED = { modelScope: { enforce: true, allow: ["cb/kimi-*"] } };

test("D3a: an EXPLICIT model outside modelScope is a ✗ refusal and no child starts", async () => {
	const result = await runBatch({
		settings: SCOPED,
		agents: { "healthy.md": HEALTHY },
		tasks: [],
		toolParams: { agent: "healthy", task: "t1", model: "other/rogue" },
	});
	assert.match(
		result.text,
		/✗ Model 'other\/rogue' is outside the configured subagent model scope\./,
	);
	assert.equal(result.supervisor.spawns.length, 0, "an explicit out-of-scope model must not spawn");
});

/**
 * The regression this fix exists for: `launchStep` passed a hardcoded
 * `"explicit"` to `checkModelScope`, so a model the caller never chose — the
 * parent session's own model falling through, `subagents.defaultModel`, or an
 * `inherit` — was refused like a deliberate choice. On the pre-fix code this
 * test reports `✗` and spawns nothing.
 */
test("D3b: an INHERITED model outside modelScope only warns and still spawns", async () => {
	const result = await runBatch({
		settings: SCOPED,
		agents: { "healthy.md": HEALTHY },
		tasks: [{ agent: "healthy", task: "t1" }],
		dispatchModel: "parent/opus",
	});
	assert.match(
		result.text,
		/⚠ Model 'parent\/opus' is outside the configured subagent model scope\./,
		`the inherited violation must be reported, not swallowed:\n${result.text}`,
	);
	assert.doesNotMatch(
		result.text,
		/✗ Model 'parent\/opus'/,
		"an inherited model is a warning, never a hard refusal",
	);
	assert.equal(result.supervisor.spawns.length, 1, "a warning must not block the launch");
	assert.equal(result.supervisor.spawns[0]?.input.model, "parent/opus");
});

test("D3b: subagents.defaultModel is inherited too, so it warns instead of refusing", async () => {
	const result = await runBatch({
		settings: { ...SCOPED, defaultModel: "other/default" },
		agents: { "healthy.md": HEALTHY },
		tasks: [{ agent: "healthy", task: "t1" }],
	});
	assert.match(result.text, /⚠ Model 'other\/default' is outside the configured subagent model scope\./);
	assert.equal(result.supervisor.spawns.length, 1);
	assert.equal(result.supervisor.spawns[0]?.input.model, "other/default");
});

/**
 * The utility family (`vexillatio`) resolves the same origin and owes the same
 * warning, through its own result channel.
 *
 * This is the coverage gap `launchUtilityFamily` opened when it started
 * collecting `scopeWarnings`: a warn that never reaches the text is silently
 * indistinguishable from a clean launch, and a warn that blocks the launch
 * would be the old `✗` bug wearing a different glyph. Both halves are asserted
 * here — the line AND the spawn.
 */
test("F1 utility: an INHERITED out-of-scope model warns and the utility still spawns", async () => {
	const result = await runVexillatio({
		// `disableBuiltins` keeps the fixture the ONLY `scout`, so the resolved
		// agent is the one this test wrote, not the shipped role card.
		settings: { ...SCOPED, disableBuiltins: true },
		agents: { "scout.md": UTILITY },
		params: { agent: "scout", task: "Inspect the repo and report facts." },
		dispatchModel: "parent/opus",
	});
	assert.match(
		result.text,
		/⚠ scout: Model 'parent\/opus' is outside the configured subagent model scope\./,
		`the utility path must surface the inherited warning:\n${result.text}`,
	);
	assert.equal(
		result.supervisor.spawns.length,
		1,
		`a warning must not block the utility launch:\n${result.text}`,
	);
	assert.equal(result.supervisor.spawns[0]?.input.model, "parent/opus");
});

/**
 * A refusal must not swallow the warnings its earlier steps already collected.
 *
 * `results` is not built until the whole plan resolves, so the prep loop has to
 * hand its `scopeWarnings` to the `fail()` message itself; an empty list must
 * leave that message byte for byte unchanged.
 */
test("F3 utility: an early failure still carries the warnings collected before it", async () => {
	const result = await runVexillatio({
		settings: { ...SCOPED, disableBuiltins: true },
		agents: { "scout.md": UTILITY, "worker.md": HEALTHY },
		params: { tasks: [{ agent: "scout", task: "t1" }, { agent: "worker", task: "t2" }] },
		dispatchModel: "parent/opus",
	});
	assert.match(
		result.text,
		/⚠ scout: Model 'parent\/opus' is outside the configured subagent model scope\.[^\n]*\nnot a utility agent: worker/,
		`the collected warning must precede the refusal:\n${result.text}`,
	);
	assert.equal(result.supervisor.spawns.length, 0, "the batch fails before any step launches");

	// Nothing collected → no stray prefix.
	const clean = await runVexillatio({
		settings: { disableBuiltins: true },
		agents: { "scout.md": UTILITY, "worker.md": HEALTHY },
		params: { tasks: [{ agent: "worker", task: "t1" }] },
	});
	assert.equal(clean.text, "not a utility agent: worker (mark it with 'utility: true')");
});

// ─────────────────── continue / resume: the per-call model ───────────────────

/**
 * Revive a persisted child through the real tool.
 *
 * The child is seeded into this checkout's run store and then `continue`d, which
 * is the only path that reaches `reviveChild`'s respawn. No live supervisor
 * entry exists, so `continue` takes the relaunch branch instead of steering.
 */
async function runContinue(params: {
	childModel?: string;
	model?: string;
}): Promise<{ text: string; supervisor: FakeSupervisor }> {
	const harness = startHarness({
		settings: { disableBuiltins: true },
		agents: { "worker.md": "---\nname: worker\ndescription: w\n---\np\n" },
		plainRunStore: true,
	});
	let text = "";
	try {
		const tool = toolOf(harness, "subagent");
		const store = new RunStore({ rootDir: path.join(harness.dir, ".pi-subagents") });
		const run = store.createRun({ task: "seed run", cwd: harness.dir });
		const sessionFile = path.join(store.runDir(run.runId), "worker-0.jsonl");
		writeFileSync(
			sessionFile,
			`${JSON.stringify({ type: "session", id: "seed", cwd: harness.dir, created: run.createdAt })}\n`,
		);
		await store.addChild(run.runId, {
			name: "worker-0",
			sessionFile,
			ownerToken: "seed-owner-token",
			state: "exited",
			spawnedAt: run.createdAt,
			agent: "worker",
			kind: "pi",
			...(params.childModel ? { model: params.childModel } : {}),
		});

		text = textOf(await tool.execute(
			"rpc-continue-model-test",
			{
				action: "continue",
				name: "worker-0",
				message: "keep going",
				...(params.model ? { model: params.model } : {}),
			},
			undefined,
			undefined,
			contextOf(harness),
		));
	} finally {
		harness.cleanup();
	}
	return { text, supervisor: harness.supervisor };
}

/** Drive the utility (`vexillatio`) family through the same harness. */
async function runVexillatio(params: {
	settings: Record<string, unknown>;
	agents: Record<string, string>;
	params: Record<string, unknown>;
	dispatchModel?: string;
}): Promise<{ text: string; supervisor: FakeSupervisor }> {
	const harness = startHarness({
		settings: params.settings,
		agents: params.agents,
		supervisor: { autoSettle: { text: "utility output" } },
	});
	let text = "";
	try {
		text = textOf(await toolOf(harness, "vexillatio").execute(
			"rpc-vexillatio-model-test",
			params.params,
			undefined,
			undefined,
			contextOf(harness, params.dispatchModel),
		));
	} finally {
		harness.cleanup();
	}
	return { text, supervisor: harness.supervisor };
}

test("D5a: `continue` with a per-call `model` relaunches on THAT model", async () => {
	const result = await runContinue({ childModel: "cb/recorded", model: "cb/call-time" });
	assert.equal(
		result.supervisor.spawns.length,
		1,
		`the child must be relaunched through the tool:\n${result.text}`,
	);
	assert.equal(result.supervisor.spawns[0]?.input.model, "cb/call-time");
});

test("D5b: `continue` without `model` keeps the model recorded at first launch", async () => {
	const result = await runContinue({ childModel: "cb/recorded" });
	assert.equal(result.supervisor.spawns.length, 1, `the child must be relaunched through the tool:\n${result.text}`);
	assert.equal(result.supervisor.spawns[0]?.input.model, "cb/recorded");
});

test("D1d: settings.json's agentOverridesByProvider reaches the spawned child", async () => {
	// The whole D1 chain in one call: the settings whitelist admits the key, the
	// merged settings reach `resolveStepModel`, and candidate 3 wins for the
	// dispatching provider's block (cb) while the other provider's block is inert.
	const result = await runBatch({
		settings: {
			agentOverridesByProvider: {
				cb: { healthy: { model: "cb/kimi-k3" } },
				pi: { healthy: { model: "pi/nope" } },
			},
		},
		agents: { "healthy.md": HEALTHY },
		tasks: [{ agent: "healthy", task: "t1" }],
		dispatchModel: "cb/parent-model",
	});
	assert.equal(result.supervisor.spawns.length, 1, `the role must launch:\n${result.text}`);
	assert.equal(result.supervisor.spawns[0]?.input.model, "cb/kimi-k3");
});
