/** End-to-end model/preset regressions through the real registered RPC tool. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import piLegion from "../../index.ts";
import { FakeSupervisor } from "../helpers/fake-supervisor.ts";

const BROKEN = "---\nname: broken\ndescription: b\npreset: nonexistent\n---\np\n";
const HEALTHY = "---\nname: healthy\ndescription: h\n---\np\n";

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

/** Drive the real launch planner with a fake RPC supervisor and isolated settings. */
async function runBatch(params: {
	settings: Record<string, unknown>;
	agents: Record<string, string>;
	tasks: Array<Record<string, unknown>>;
	toolParams?: Record<string, unknown>;
	dispatchModel?: string;
}): Promise<BatchOutcome> {
	const dir = mkdtempSync(path.join(tmpdir(), "rpc-presets-launch-"));
	const previous = {
		child: process.env.PI_SUBAGENT_CHILD,
		extra: process.env.PI_HERDR_SUBAGENTS_EXTRA_AGENT_DIRS,
		agentDir: process.env.PI_CODING_AGENT_DIR,
	};
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

	const supervisor = new FakeSupervisor();
	const tools: Array<Record<string, unknown>> = [];
	const handlers = new Map<string, (...args: unknown[]) => unknown>();
	const pi = {
		registerTool(tool: unknown) { tools.push(tool as Record<string, unknown>); },
		registerMessageRenderer() {},
		registerCommand() {},
		sendMessage() {},
		events: { emit() {} },
		on(name: string, handler: (...args: unknown[]) => unknown) { handlers.set(name, handler); },
	};
	let text = "";
	let threw: Error | undefined;
	let parameters: Tool["parameters"] = {};
	try {
		piLegion(pi as never, { supervisor });
		const tool = tools.find((entry) => entry.name === "subagent") as unknown as Tool | undefined;
		assert.ok(tool, "subagent tool must be registered");
		parameters = tool.parameters;
		try {
			const result = await tool.execute(
				"rpc-presets-test",
				{ ...(params.toolParams ?? { tasks: params.tasks }), async: false, worktree: false },
				undefined,
				undefined,
				{
					cwd: dir,
					hasUI: false,
					ui: { notify() {}, confirm: async () => true, setStatus() {} },
					...(params.dispatchModel
						? { model: { provider: params.dispatchModel.split("/")[0], id: params.dispatchModel.split("/").slice(1).join("/") } }
						: {}),
				},
			);
			text = (result.content ?? []).map((block) => block.text ?? "").join("\n");
		} catch (error) {
			threw = error instanceof Error ? error : new Error(String(error));
		}
	} finally {
		handlers.get("session_shutdown")?.();
		if (previous.child === undefined) delete process.env.PI_SUBAGENT_CHILD;
		else process.env.PI_SUBAGENT_CHILD = previous.child;
		if (previous.extra === undefined) delete process.env.PI_HERDR_SUBAGENTS_EXTRA_AGENT_DIRS;
		else process.env.PI_HERDR_SUBAGENTS_EXTRA_AGENT_DIRS = previous.extra;
		if (previous.agentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous.agentDir;
		rmSync(dir, { recursive: true, force: true });
	}
	return { ...(threw ? { threw } : {}), text, parameters, supervisor };
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

// The main chain has one supported kind; old CLI/model compatibility tests are
// now explicit refusals rather than fake-herdr starts for non-pi agents.
test("e2e: inherited non-pi roles receive migration guidance without an RPC spawn", async () => {
	const result = await runBatch({
		settings: {},
		agents: { "websearch.md": "---\nname: websearch\ndescription: search\nkind: cursor\n---\np\n" },
		tasks: [{ agent: "websearch", task: "search" }],
		dispatchModel: "cb/kimi-k3",
	});
	assert.equal(result.threw, undefined);
	assert.match(result.text, /✗ websearch: /);
	assert.match(result.text, /only supports pi children/);
	assert.match(result.text, /pin pi-legion v0\.16\.x/);
	assert.equal(result.supervisor.spawns.length, 0);
});

test("e2e: explicit non-pi model choices are refused with migration guidance", async () => {
	const result = await runBatch({
		settings: {},
		agents: { "websearch.md": "---\nname: websearch\ndescription: search\nkind: cursor\nmodel: cb/kimi-k3\n---\np\n" },
		tasks: [{ agent: "websearch", task: "search" }],
		dispatchModel: "cb/kimi-k3",
	});
	assert.match(result.text, /only supports pi children/);
	assert.match(result.text, /pin pi-legion v0\.16\.x/);
	assert.equal(result.supervisor.spawns.length, 0);
});
