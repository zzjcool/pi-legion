/** End-to-end model/preset regressions through the real registered RPC tool. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import piLegion from "../../index.ts";
import { Orchestrator } from "../../src/runs/orchestrator.ts";
import type { ProviderLookup } from "../../src/runs/provider-pin.ts";
import { RunStore } from "../../src/runs/store.ts";
import { ErrorCodes, SubagentError, type AgentConfig } from "../../src/shared/types.ts";
import { FakeSupervisor } from "../helpers/fake-supervisor.ts";
import { MODEL_WARNING } from "../helpers/model-warning.ts";

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
function contextOf(
	harness: Harness,
	dispatchModel?: string,
	modelRegistry?: ProviderLookup,
): Record<string, unknown> {
	return {
		cwd: harness.dir,
		hasUI: false,
		ui: { notify() {}, confirm: async () => true, setStatus() {} },
		// #123: the parent registry `continue`/`resume` re-pin from.
		...(modelRegistry ? { modelRegistry } : {}),
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
	/** Fake RPC supervisor knobs (spawn failure, handle warning, …). */
	supervisor?: ConstructorParameters<typeof FakeSupervisor>[0];
	/** Default false (wait + collect); `true` returns the bare launch text. */
	async?: boolean;
}): Promise<BatchOutcome> {
	const harness = startHarness({ settings: params.settings, agents: params.agents, ...(params.supervisor ? { supervisor: params.supervisor } : {}) });
	let text = "";
	let threw: Error | undefined;
	let parameters: Tool["parameters"] = {};
	try {
		const tool = toolOf(harness, "subagent");
		parameters = tool.parameters;
		try {
			text = textOf(await tool.execute(
				"rpc-presets-test",
				{ ...(params.toolParams ?? { tasks: params.tasks }), async: params.async ?? false, worktree: false },
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

// ─────────── B8a: `inherit` with no parent model refuses, never spawns ───────────

const INHERIT_CARD = "---\nname: heir\ndescription: i\nmodel: inherit\n---\np\n";

/**
 * The sentinel used to resolve to a MODEL-LESS shape, so `index.ts` passed no
 * model, `Orchestrator.launch` re-read `agent.model` (the literal `inherit`) and
 * spawned `--model inherit` — pi's fatal `Model "inherit" not found`.
 *
 * The whole point of B8a is the shape of the failure: a `✗` line naming the
 * sentinel, and NO child. Asserted together because either half alone passes on
 * the buggy code (it spat a message AND the spawn).
 */
test("B8a.1 end-to-end: a card `model: inherit` with no parent model refuses and spawns nothing", async () => {
	const result = await runBatch({
		settings: {},
		agents: { "heir.md": INHERIT_CARD },
		tasks: [{ agent: "heir", task: "t1" }],
	});
	assert.equal(
		result.threw,
		undefined,
		`a bad model must degrade to a refusal line, not reject the batch: ${result.threw?.message}`,
	);
	assert.match(result.text, /✗ heir: /);
	assert.match(result.text, /Model 'inherit' was requested for 'heir'/);
	assert.equal(
		result.supervisor.spawns.length,
		0,
		`the sentinel must never reach --model:\n${result.text}`,
	);
});

test("B8a.1 end-to-end: a tool-param `model: \"inherit\"` with no parent model refuses too", async () => {
	const result = await runBatch({
		settings: {},
		agents: { "healthy.md": HEALTHY },
		tasks: [],
		toolParams: { agent: "healthy", task: "t1", model: "inherit" },
	});
	assert.match(result.text, /✗ healthy: /);
	assert.match(result.text, /but the parent session has no model/);
	assert.equal(result.supervisor.spawns.length, 0);
});

test("B8a.1 end-to-end: `inherit` WITH a parent model still launches on it", async () => {
	// The working half of the sentinel must not regress while the missing-parent
	// half starts refusing.
	const result = await runBatch({
		settings: {},
		agents: { "heir.md": INHERIT_CARD },
		tasks: [{ agent: "heir", task: "t1" }],
		dispatchModel: "parent/opus",
	});
	assert.equal(result.supervisor.spawns.length, 1);
	assert.equal(result.supervisor.spawns[0]?.input.model, "parent/opus");
});

// ─────────── B8b: a configured `thinking` wins over a level in the model ───────────

/**
 * The end of the chain the decision is judged on: the CHILD's argv.
 *
 * `applyThinkingSuffix` only appends a level when the model has none, so on the
 * pre-fix code the child started on `cb/x:high` and the preset's `thinking: max`
 * vanished without a word. Asserting `input.model` alone would miss half of it:
 * the model ref the child actually receives is the suffixed one.
 */
test("B8b end-to-end: a preset's `thinking` replaces the level inside its own model", async () => {
	const result = await runBatch({
		settings: { presets: { strong: { kind: "pi", model: "cb/x:high", thinking: "max" } } },
		agents: { "healthy.md": "---\nname: healthy\ndescription: h\npreset: strong\n---\np\n" },
		tasks: [{ agent: "healthy", task: "t1" }],
	});
	const spawn = result.supervisor.spawns[0];
	assert.ok(spawn, `the preset must still launch:\n${result.text}`);
	assert.equal(spawn.input.model, "cb/x");
	assert.ok(spawn.args.includes("cb/x:max"), `argv must carry the configured level: ${spawn.args.join(" ")}`);
	assert.equal(spawn.args.includes("cb/x:high"), false, "the model string's own level must be gone");
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
	/** `ChildRecord.modelProvider` recorded at first launch (#123). */
	childModelProvider?: string;
	model?: string;
	/** Parent registry the revive re-pins from when THIS call chose the model. */
	modelRegistry?: ProviderLookup;
	/** Fake RPC supervisor knobs (a spawn-time `warning`, …). */
	supervisor?: ConstructorParameters<typeof FakeSupervisor>[0];
}): Promise<{ text: string; supervisor: FakeSupervisor }> {
	const harness = startHarness({
		settings: { disableBuiltins: true },
		agents: { "worker.md": "---\nname: worker\ndescription: w\n---\np\n" },
		plainRunStore: true,
		...(params.supervisor ? { supervisor: params.supervisor } : {}),
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
			...(params.childModelProvider ? { modelProvider: params.childModelProvider } : {}),
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
			contextOf(harness, undefined, params.modelRegistry),
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

// ──────────────── B5: an in-process parse warning is visible, not fatal ────────────────

/**
 * The two `resolveCliModel` warnings a legitimate configuration produces (a
 * custom model id, an invalid `:thinking` suffix) used to be dropped by the
 * in-process backend, so the child ran on a model nobody registered with
 * nothing said about it (B5). The channel is `handle.warning` → one `⚠` line
 * after the `▶` line. It must NEVER become a refusal — a custom id is a
 * supported usage.
 *
 * The exact bytes live in `test/helpers/model-warning.ts`, shared with the
 * backend-level test that makes pi produce them.
 */
test("B5: a spawn warning is rendered as a `⚠ name:` line right after `▶`", async () => {
	const result = await runBatch({
		settings: {},
		agents: { "healthy.md": "---\nname: healthy\ndescription: h\nmodel: cb/custom-thing\n---\np\n" },
		tasks: [{ agent: "healthy", task: "t1" }],
		async: true,
		supervisor: { handleWarning: MODEL_WARNING },
	});
	const name = result.supervisor.spawns[0]?.input.name;
	assert.ok(name, `the child must still spawn:\n${result.text}`);
	const lines = result.text.split("\n");
	assert.equal(
		lines[0],
		`▶ ${name} (healthy) supervisor=inprocess`,
		"the ▶ line is unchanged",
	);
	assert.equal(lines[1], `  ⚠ ${name}: ${MODEL_WARNING}`, "the warning is rendered right below it");
});

test("B5: a warning never turns the launch into a failure", async () => {
	const result = await runBatch({
		settings: {},
		agents: { "healthy.md": HEALTHY },
		tasks: [{ agent: "healthy", task: "t1" }],
		async: true,
		supervisor: { handleWarning: MODEL_WARNING },
	});
	assert.equal(result.threw, undefined, "a warning must not throw");
	assert.equal(result.supervisor.spawns.length, 1, "a warning must not block the launch");
	assert.doesNotMatch(result.text, /✗/, "a warning is not a refusal");
});

/** Anti-regression: a clean spawn's text is byte for byte what it always was. */
test("B5 regression: a spawn with no warning renders exactly the previous text", async () => {
	const result = await runBatch({
		settings: {},
		agents: { "healthy.md": HEALTHY },
		tasks: [{ agent: "healthy", task: "t1" }],
		async: true,
	});
	const name = result.supervisor.spawns[0]?.input.name;
	assert.equal(
		result.text.split("\n")[0],
		`▶ ${name} (healthy) supervisor=inprocess`,
	);
	assert.doesNotMatch(result.text, /⚠/, "no warning line may be invented");
});

// ──────────── #123 residual: the provider pin is persisted and replayed ────────────

function testAgent(overrides: Partial<AgentConfig> = {}): AgentConfig {
	return {
		name: "worker",
		description: "worker",
		systemPrompt: "role prompt",
		systemPromptMode: "append",
		inheritProjectContext: true,
		inheritSkills: false,
		kind: "pi",
		source: "user",
		filePath: "/worker.md",
		...overrides,
	};
}

const registryOf = (...models: Array<{ provider: string; id: string }>) => ({
	getAll: () => models,
});

/**
 * D-R3.2: `recordChild` persists the provider that was paired with the model
 * that actually started, and the pair survives the run.json round-trip — which
 * is the only place `continue`/`resume` can read it back from (`legion.db`'s
 * `nodes` table has no provider column and is deliberately not migrated).
 */
test("R3: launch records the provider paired with the started model", async () => {
	const dir = mkdtempSync(path.join(tmpdir(), "rpc-provider-persist-"));
	try {
		const supervisor = new FakeSupervisor();
		const orchestrator = new Orchestrator({ supervisor, runDir: dir, cwd: "/tmp/project" });
		const handle = await orchestrator.launch({
			agent: testAgent({ model: "cb/kimi-k3" }),
			task: "go",
			modelProvider: "live",
			worktree: false,
		});
		assert.equal(handle.child.model, "cb/kimi-k3");
		assert.equal(handle.child.modelProvider, "live");

		const store = new RunStore({ rootDir: path.join(dir, "store") });
		const run = store.createRun({ task: "go", cwd: dir });
		await store.addChild(run.runId, handle.child);
		const persisted = store.findChild(run.runId, handle.name);
		assert.equal(persisted?.model, "cb/kimi-k3");
		assert.equal(persisted?.modelProvider, "live", "the pin must survive run.json");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

/**
 * The pairing rule (D-R3.2): the provider was computed for CANDIDATE 0. When a
 * fallback candidate is what actually started, the pin describes a different
 * model, so it must be dropped — not pinning at all beats pinning wrong.
 */
test("R3: a fallback candidate does NOT persist the candidate-0 provider", async () => {
	const dir = mkdtempSync(path.join(tmpdir(), "rpc-provider-fallback-"));
	try {
		const supervisor = new FakeSupervisor({
			rejectSpawn: (input) =>
				input.model === "cb/primary"
					? new SubagentError("model unavailable", ErrorCodes.START_FAILED)
					: undefined,
		});
		const orchestrator = new Orchestrator({ supervisor, runDir: dir, cwd: "/tmp/project" });
		const handle = await orchestrator.launch({
			agent: testAgent({ model: "cb/primary", fallbackModels: ["cb/fallback"] }),
			task: "go",
			modelProvider: "live-primary",
			worktree: false,
		});
		assert.equal(handle.child.model, "cb/fallback", "the fallback candidate is what started");
		assert.equal(
			Object.hasOwn(handle.child, "modelProvider"),
			false,
			"a fallback candidate must not inherit candidate 0's pin",
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

/** D-R3.3: the recorded `model` AND `modelProvider` are replayed as a pair. */
test("R3: `continue` replays the recorded provider with the recorded model", async () => {
	const result = await runContinue({
		childModel: "cb/recorded",
		childModelProvider: "any-endpoint",
	});
	assert.equal(result.supervisor.spawns.length, 1, `the child must be relaunched through the tool:\n${result.text}`);
	assert.equal(result.supervisor.spawns[0]?.input.model, "cb/recorded");
	assert.equal(result.supervisor.spawns[0]?.input.modelProvider, "any-endpoint");
});

/**
 * D-R3.3 the other half: a model THIS call chose was never priced against the
 * recorded provider, so replaying it would pin the wrong one. It is computed
 * fresh from the parent registry instead.
 */
test("R3: `continue` on a model THIS call chose re-pins from the parent registry", async () => {
	const result = await runContinue({
		childModel: "cb/recorded",
		childModelProvider: "stale-provider",
		model: "cb/kimi-k3",
		modelRegistry: registryOf({ provider: "live", id: "cb/kimi-k3" }),
	});
	assert.equal(result.supervisor.spawns.length, 1, `the child must be relaunched through the tool:\n${result.text}`);
	assert.equal(result.supervisor.spawns[0]?.input.model, "cb/kimi-k3");
	assert.equal(
		result.supervisor.spawns[0]?.input.modelProvider,
		"live",
		"the recorded pin belongs to a different model and must not be replayed",
	);
});

/**
 * Anti-regression: no recorded pin ⇒ the field is never invented. The empty
 * string is not the danger here (two falsy spreads eat it); a GUESS is — which
 * is why the mutation this guards against is `?? "guessed-provider"`.
 */
test("R3: `continue` with no recorded provider writes no `modelProvider` field", async () => {
	const result = await runContinue({ childModel: "cb/recorded" });
	assert.equal(result.supervisor.spawns.length, 1);
	assert.equal(Object.hasOwn(result.supervisor.spawns[0]!.input, "modelProvider"), false);
});

// ─────────── REV-1.1–1.3: the pin is paired with the model it priced ───────────

/**
 * REV-1.1 (review F1, measured): a relaunch used to keep the OLD pin when the
 * new launch carried none, so `launch(cb/model-a, prov-a)` → retire → `launch(cb/model-b)`
 * landed as `{model: "cb/model-b", modelProvider: "prov-a"}` and the next
 * `continue` replayed exactly the wrong pair — #123 all over again. The pin only
 * survives a relaunch that keeps the model it was computed for.
 */
test("R3/REV-1.1: a relaunch on a NEW model drops the pin that belonged to the old one", async () => {
	const dir = mkdtempSync(path.join(tmpdir(), "rpc-provider-relaunch-"));
	try {
		const supervisor = new FakeSupervisor();
		const orchestrator = new Orchestrator({ supervisor, runDir: dir, cwd: "/tmp/project" });
		const first = await orchestrator.launch({
			agent: testAgent({ model: "cb/model-a" }),
			task: "go",
			modelProvider: "prov-a",
			worktree: false,
		});
		assert.equal(first.child.modelProvider, "prov-a");
		await orchestrator.retire(first.name);

		const second = await orchestrator.launch({
			agent: testAgent({ model: "cb/model-b" }),
			task: "go again",
			name: first.name,
			worktree: false,
		});
		assert.equal(second.child.model, "cb/model-b");
		assert.equal(
			Object.hasOwn(second.child, "modelProvider"),
			false,
			"prov-a priced cb/model-a; keeping it next to cb/model-b is the #123 replay bug",
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

/** REV-1.1, the other half: the same model ⇒ the pin was never disproved. */
test("R3/REV-1.1: a relaunch on the SAME model keeps its pin, and a fresh pin still wins", async () => {
	const dir = mkdtempSync(path.join(tmpdir(), "rpc-provider-relaunch-same-"));
	try {
		const supervisor = new FakeSupervisor();
		const orchestrator = new Orchestrator({ supervisor, runDir: dir, cwd: "/tmp/project" });
		const first = await orchestrator.launch({
			agent: testAgent({ model: "cb/model-a" }),
			task: "go",
			modelProvider: "prov-a",
			worktree: false,
		});
		await orchestrator.retire(first.name);
		// No provider computed this time: "nothing new" is not a disproof.
		const second = await orchestrator.launch({
			agent: testAgent({ model: "cb/model-a" }),
			task: "again",
			name: first.name,
			worktree: false,
		});
		assert.equal(second.child.modelProvider, "prov-a", "the same model keeps the pin it came with");

		await orchestrator.retire(first.name);
		const third = await orchestrator.launch({
			agent: testAgent({ model: "cb/model-a" }),
			task: "third",
			name: first.name,
			modelProvider: "prov-b",
			worktree: false,
		});
		assert.equal(third.child.modelProvider, "prov-b", "a newly computed pin replaces the old one");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

/**
 * REV-1.2 (review F2, measured): `spawnInput` used to hand candidate 0's
 * provider to EVERY candidate. A fallback then routed to the wrong endpoint (or
 * died on "No API key"), i.e. the fallback never fell back — and it emitted a B5
 * warning on top. Only candidate 0, and only with a model, may carry the pin.
 */
test("R3/REV-1.2: a fallback candidate is spawned WITHOUT candidate 0's provider", async () => {
	const dir = mkdtempSync(path.join(tmpdir(), "rpc-provider-fallback-spawn-"));
	try {
		const supervisor = new FakeSupervisor({
			rejectSpawn: (input) =>
				input.model === "cb/primary"
					? new SubagentError("model unavailable", ErrorCodes.START_FAILED)
					: undefined,
		});
		const orchestrator = new Orchestrator({ supervisor, runDir: dir, cwd: "/tmp/project" });
		const handle = await orchestrator.launch({
			agent: testAgent({ model: "cb/primary", fallbackModels: ["cb/fallback"] }),
			task: "go",
			modelProvider: "live-primary",
			worktree: false,
		});
		assert.equal(handle.child.model, "cb/fallback", "the fallback candidate is what started");
		// A rejected spawn never reaches `spawns`, so the attempts are read from
		// `calls` — candidate 0's own pin is asserted on the input it was given.
		const attempts = supervisor.calls.filter((call) => call.method === "spawnChild");
		assert.equal(attempts.length, 2, "candidate 0, then the fallback");
		assert.equal(attempts[0]?.input?.model, "cb/primary");
		assert.equal(attempts[0]?.input?.modelProvider, "live-primary", "candidate 0 keeps its own pin");
		assert.equal(attempts[1]?.input?.model, "cb/fallback");
		assert.equal(
			Object.hasOwn(attempts[1]!.input!, "modelProvider"),
			false,
			"a fallback pointed at candidate 0's provider is not a fallback",
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

/** REV-1.3 (review F7): a provider without a model is half a pair — never written. */
test("R3/REV-1.3: no model means no pin (a provider is never recorded alone)", async () => {
	const dir = mkdtempSync(path.join(tmpdir(), "rpc-provider-nomodel-"));
	try {
		const supervisor = new FakeSupervisor();
		const orchestrator = new Orchestrator({ supervisor, runDir: dir, cwd: "/tmp/project" });
		const handle = await orchestrator.launch({
			agent: testAgent(),
			task: "go",
			modelProvider: "live",
			worktree: false,
		});
		assert.equal(handle.child.model, undefined, "no candidate model was planned");
		assert.equal(
			Object.hasOwn(handle.child, "modelProvider"),
			false,
			"`undefined === models[0]` must not read as `this is candidate 0`",
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// ─────────── REV-1.4/1.5: revive picks and validates the pin, and shows ⚠ ───────────

/**
 * REV-1.4 (review F3): a model equal to the recorded one means the child did not
 * move, so the recorded pin is still the best answer — re-deriving it from the
 * registry would throw away exactly the custom ids a registry cannot know. The
 * registry here DOES own `any-endpoint` (so the pin is still valid) but does not
 * list `cb/custom-thing`, which is what "custom id" means.
 */
test("R3/REV-1.4: an explicit model equal to the recorded one reuses the recorded pin", async () => {
	const result = await runContinue({
		childModel: "cb/custom-thing",
		childModelProvider: "any-endpoint",
		model: "cb/custom-thing",
		modelRegistry: registryOf({ provider: "any-endpoint", id: "cb/another-model" }),
	});
	assert.equal(result.supervisor.spawns.length, 1, `the child must be relaunched:\n${result.text}`);
	assert.equal(result.supervisor.spawns[0]?.input.model, "cb/custom-thing");
	assert.equal(
		result.supervisor.spawns[0]?.input.modelProvider,
		"any-endpoint",
		"the registry cannot see a custom id, which is no reason to unpin it",
	);
});

/**
 * REV-1.4 (review F4): #123's original scene is a pin computed while an EXTENSION
 * provider was loaded. If this process has not loaded it, replaying the pin is
 * fatal (`Unknown provider`), which is worse than not pinning at all.
 */
test("R3/REV-1.4: a recorded pin the current registry does not know is skipped, not forced", async () => {
	const result = await runContinue({
		childModel: "cb/recorded",
		childModelProvider: "gone-extension",
		modelRegistry: registryOf({ provider: "live", id: "cb/kimi-k3" }),
	});
	assert.equal(result.supervisor.spawns.length, 1, `the child must be relaunched:\n${result.text}`);
	assert.equal(
		Object.hasOwn(result.supervisor.spawns[0]!.input, "modelProvider"),
		false,
		"`--provider <unknown>` kills the child; no pin leaves it to resolve the id itself",
	);
});

/** REV-1.5 (review F5): a revived child must not be the silent path to a warning. */
test("B5: a revive renders its spawn warning as a `⚠ name:` line after the resume line", async () => {
	const result = await runContinue({
		childModel: "cb/recorded",
		supervisor: { handleWarning: MODEL_WARNING },
	});
	assert.equal(result.supervisor.spawns.length, 1, `the child must be relaunched:\n${result.text}`);
	const lines = result.text.split("\n");
	assert.match(lines[0] ?? "", /^Resumed worker-0 from its session\./u, "the resume line is unchanged");
	assert.equal(lines[1], `  ⚠ worker-0: ${MODEL_WARNING}`, "the warning is rendered right below it");
});
