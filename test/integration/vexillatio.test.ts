import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import herdrSubagents from "../../index.ts";
import { ErrorCodes, type AgentConfig } from "../../src/shared/types.ts";
import { RpcSupervisor } from "../../src/supervisor/rpc-supervisor.ts";
import type { RpcClientOptions } from "../../src/supervisor/types.ts";
import { FakeSupervisor } from "../helpers/fake-supervisor.ts";

interface ToolResult {
	content: Array<{ type: string; text?: string }>;
	details?: unknown;
}

interface RegisteredTool {
	name: string;
	execute: (...args: unknown[]) => Promise<ToolResult>;
}

function fakePi() {
	const tools = new Map<string, RegisteredTool>();
	const handlers = new Map<string, (...args: unknown[]) => unknown>();
	return {
		tools,
		handlers,
		registerTool(tool: unknown) {
			const typed = tool as RegisteredTool;
			tools.set(typed.name, typed);
		},
		registerMessageRenderer() {},
		on(name: string, handler: (...args: unknown[]) => unknown) {
			handlers.set(name, handler);
		},
		registerCommand() {},
		sendMessage() {},
		events: { emit() {} },
	};
}

type FakePi = ReturnType<typeof fakePi>;

function context(cwd: string) {
	return {
		cwd,
		hasUI: false,
		ui: { setStatus() {}, setWidget() {} },
		sessionManager: { getSessionFile: () => path.join(cwd, "root-session.jsonl") },
	};
}

async function withEnvironment<T>(
	values: Record<string, string | undefined>,
	action: () => Promise<T>,
): Promise<T> {
	const previous = new Map<string, string | undefined>();
	for (const [key, value] of Object.entries(values)) {
		previous.set(key, process.env[key]);
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	try {
		return await action();
	} finally {
		for (const [key, value] of previous) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

async function withSandbox(
	parentEnv: Record<string, string | undefined>,
	run: (helpers: { pi: FakePi; supervisor: FakeSupervisor; cwd: string }) => Promise<void>,
	supervisor = new FakeSupervisor({
		autoSettle: (input) => ({ text: `utility output for ${input.agent.name}` }),
	}),
): Promise<void> {
	const root = mkdtempSync(path.join(tmpdir(), "vexillatio-test-"));
	try {
		const agentDir = path.join(root, "agent-config");
		const cwd = path.join(root, "project");
		const userAgentsDir = path.join(agentDir, "agents");
		mkdirSync(userAgentsDir, { recursive: true });
		mkdirSync(cwd, { recursive: true });
		writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ subagents: {} }));
		// Exercise the REV-17.6 conflict rule in both launch channels: this
		// utility is intentionally misconfigured with allowNestedSubagents.
		writeFileSync(
			path.join(userAgentsDir, "scout.md"),
			"---\nname: scout\ndescription: test utility\ntools: read, grep, find, ls\nutility: true\nallowNestedSubagents: true\nkind: pi\n---\nInspect and report read-only facts.",
		);
		writeFileSync(
			path.join(userAgentsDir, "worker.md"),
			"---\nname: worker\ndescription: restricted command-chain role\ntools: read, grep, find, ls\nallowNestedSubagents: true\nkind: pi\n---\nImplement carefully.",
		);
		const pi = fakePi();
		await withEnvironment(
			{
				PI_CODING_AGENT_DIR: agentDir,
				PI_HERDR_SUBAGENTS_EXTRA_AGENT_DIRS: undefined,
				PI_SUBAGENT_CHILD: undefined,
				PI_SUBAGENT_UTILITY_CHILD: undefined,
				PI_LEGION_DB: undefined,
				PI_LEGION_NODE_ID: undefined,
				...parentEnv,
			},
			async () => {
				herdrSubagents(pi as never, { supervisor });
				try {
					await run({ pi, supervisor, cwd });
				} finally {
					await pi.handlers.get("session_shutdown")?.();
				}
			},
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

async function invoke(
	pi: FakePi,
	name: string,
	params: unknown,
	ctx: ReturnType<typeof context>,
): Promise<ToolResult> {
	const tool = pi.tools.get(name);
	assert.ok(tool, `${name} tool must be registered`);
	return tool.execute("test-call", params, undefined, undefined, ctx);
}

test("vexillatio dispatches a utility agent, strips lineage, and returns its collected output", async () => {
	await withSandbox(
		{
			// Simulate a nested-allowed parent: a utility child must not inherit
			// this bit or the ancestor lineage/depth values.
			PI_SUBAGENT_ALLOW_NESTED: "1",
			PI_SUBAGENT_PARENT_PATH: "[]",
			PI_SUBAGENT_MAX_DEPTH: "0",
		},
		async ({ pi, supervisor, cwd }) => {
			assert.ok(pi.tools.has("vexillatio"));
			assert.ok(pi.tools.has("subagent"));

			const beforeStart = pi.handlers.get("before_agent_start");
			assert.ok(beforeStart);
			const prompt = beforeStart(
				{ systemPrompt: "base prompt", systemPromptOptions: { selectedTools: ["vexillatio"] } },
				context(cwd),
			) as { systemPrompt?: string } | undefined;
			assert.match(prompt?.systemPrompt ?? "", /Utility agents.*`vexillatio`/);

			const result = await invoke(pi, "vexillatio", {
				task: "Inspect the test repository and report facts.",
				agent: "scout",
				cwd,
				timeoutMs: 10_000,
			}, context(cwd));
			const text = result.content.map((part) => part.text ?? "").join("\n");
			assert.match(text, /── scout-0 ──/);
			assert.match(text, /execution: success/);
			assert.match(text, /utility output for scout/);
			assert.match(text, /sessionFile:/);
			assert.equal(supervisor.spawns.length, 1);

			const env = supervisor.spawns[0]?.input.env;
			assert.equal(env?.PI_SUBAGENT_CHILD, "1");
			assert.equal(env?.PI_SUBAGENT_UTILITY_CHILD, "1");
			for (const key of [
				"PI_LEGION_DB",
				"PI_LEGION_NODE_ID",
				"PI_SUBAGENT_PARENT_PATH",
				"PI_SUBAGENT_MAX_DEPTH",
				"PI_SUBAGENT_ALLOW_NESTED",
			]) {
				assert.equal(env?.[key], undefined, `${key} must be stripped for utility dispatch`);
			}
			assert.equal(supervisor.spawns[0]?.input.allowNestedSubagents, undefined);
		},
	);
});

test("non-legion children can control utility agents dispatched through vexillatio", async () => {
	await withSandbox(
		{
			PI_SUBAGENT_CHILD: "1",
			PI_SUBAGENT_ALLOW_NESTED: "1",
		},
		async ({ pi, supervisor, cwd }) => {
			const dispatch = await invoke(pi, "vexillatio", {
				task: "Inspect this repository and report.",
				agent: "scout",
			}, context(cwd));
			assert.match(dispatch.content[0]?.text ?? "", /── scout-0 ──/);
			assert.equal(supervisor.spawns.length, 1);

			const status = await invoke(pi, "subagent", {
				action: "status",
				name: "scout-0",
			}, context(cwd));
			assert.equal((status.details as { error?: string } | undefined)?.error, undefined);
			assert.match(status.content[0]?.text ?? "", /scout-0/);

			const collected = await invoke(pi, "subagent", {
				action: "collect",
				name: "scout-0",
			}, context(cwd));
			assert.equal((collected.details as { error?: string } | undefined)?.error, undefined);
			assert.match(collected.content[0]?.text ?? "", /utility output for scout/);
		},
	);
});

test("vexillatio rejects a non-utility target with INVALID_PARAMS", async () => {
	await withSandbox({}, async ({ pi, supervisor, cwd }) => {
		const result = await invoke(pi, "vexillatio", {
			task: "Try to dispatch a command-chain role.",
			agent: "worker",
		}, context(cwd));
		assert.equal((result.details as { error?: string } | undefined)?.error, ErrorCodes.INVALID_PARAMS);
		assert.match(result.content[0]?.text ?? "", /not a utility agent: worker/);
		assert.equal(supervisor.spawns.length, 0);
	});
});

test("vexillatio rejects task verification commands instead of ignoring them", async () => {
	await withSandbox({}, async ({ pi, supervisor, cwd }) => {
		const result = await invoke(pi, "vexillatio", {
			task: "Run the requested utility task.",
			tasks: [{ agent: "scout", task: "Inspect code.", verify: ["npm test"] }],
		}, context(cwd));
		assert.equal((result.details as { error?: string } | undefined)?.error, ErrorCodes.INVALID_PARAMS);
		assert.match(result.content[0]?.text ?? "", /verify/i);
		assert.equal(supervisor.spawns.length, 0);
	});
});

test("subagent remains compatible with misconfigured utility roles and enforces leaf identity", async () => {
	await withSandbox({}, async ({ pi, supervisor, cwd }) => {
		const result = await invoke(pi, "subagent", {
			agent: "scout",
			task: "Inspect this repository and report.",
			async: false,
			worktree: false,
		}, context(cwd));
		assert.match(result.content[0]?.text ?? "", /scout-0/);
		assert.equal(supervisor.spawns.length, 1);
		assert.equal(supervisor.spawns[0]?.input.env?.PI_SUBAGENT_CHILD, "1");
		assert.equal(supervisor.spawns[0]?.input.env?.PI_SUBAGENT_UTILITY_CHILD, "1");
		assert.equal(supervisor.spawns[0]?.input.env?.PI_SUBAGENT_ALLOW_NESTED, undefined);
		assert.equal(supervisor.spawns[0]?.input.allowNestedSubagents, undefined);
		const toolsIndex = supervisor.spawns[0]?.args.indexOf("--tools") ?? -1;
		assert.equal(supervisor.spawns[0]?.args[toolsIndex + 1], "read,grep,find,ls", "utility roles must not inherit vexillatio");
	});
});

test("non-utility child allowlists include vexillatio without widening subagent access", async () => {
	await withSandbox({}, async ({ pi, supervisor, cwd }) => {
		const result = await invoke(pi, "subagent", {
			agent: "worker",
			task: "Implement the small task.",
			async: false,
			worktree: false,
		}, context(cwd));
		assert.match(result.content[0]?.text ?? "", /worker-0/);
		const spawn = supervisor.spawns[0];
		assert.ok(spawn);
		const toolsIndex = spawn.args.indexOf("--tools");
		assert.equal(spawn.args[toolsIndex + 1], "read,grep,find,ls,vexillatio");
		assert.equal(spawn.args[toolsIndex + 1]?.includes("subagent"), false);
		assert.equal(spawn.input.env?.PI_SUBAGENT_UTILITY_CHILD, undefined);
	});
});

test("vexillatio tasks launch distinct same-role children and return each output", async () => {
	await withSandbox({}, async ({ pi, supervisor, cwd }) => {
		const result = await invoke(pi, "vexillatio", {
			task: "Run both independent recon tasks.",
			tasks: [
				{ agent: "scout", task: "Inspect area A." },
				{ agent: "scout", task: "Inspect area B." },
			],
			cwd,
			timeoutMs: 10_000,
		}, context(cwd));
		const output = result.content.map((part) => part.text ?? "").join("\n");
		assert.match(output, /scout-0/);
		assert.match(output, /scout-1/);
		assert.equal(supervisor.spawns.length, 2);
	});
});

test("vexillatio continues name allocation after subagent launches the same utility", async () => {
	await withSandbox({}, async ({ pi, supervisor, cwd }) => {
		const first = await invoke(pi, "subagent", {
			agent: "scout",
			task: "Inspect the first area.",
			async: false,
			worktree: false,
		}, context(cwd));
		assert.match(first.content[0]?.text ?? "", /scout-0/);

		const second = await invoke(pi, "vexillatio", {
			task: "Inspect the second area.",
			agent: "scout",
		}, context(cwd));
		assert.match(second.content[0]?.text ?? "", /── scout-1 ──/);
		assert.deepEqual(supervisor.spawns.map((spawn) => spawn.input.name), ["scout-0", "scout-1"]);
	});
});

test("vexillatio avoids a live same-name subagent and returns on collect timeout", async () => {
	const supervisor = new FakeSupervisor({ immediateTimeout: true });
	await withSandbox(
		{},
		async ({ pi, cwd }) => {
			const first = await invoke(pi, "subagent", {
				agent: "scout",
				task: "Inspect the first area.",
				async: true,
				worktree: false,
			}, context(cwd));
			assert.match(first.content[0]?.text ?? "", /scout-0/);

			const second = await invoke(pi, "vexillatio", {
				task: "Inspect the second area.",
				agent: "scout",
				timeoutMs: 50,
			}, context(cwd));
			const output = second.content.map((part) => part.text ?? "").join("\n");
			assert.match(output, /── scout-1 ──/);
			assert.match(output, /execution: running/);
			assert.match(output, /collect timed out after 50ms/);
			assert.match(output, /sessionFile:/);
			assert.equal(supervisor.isAlive("scout-1"), true, "timed-out utility remains alive and controllable");
			assert.deepEqual(supervisor.spawns.map((spawn) => spawn.input.name), ["scout-0", "scout-1"]);
		},
		supervisor,
	);
});

test("RPC spawn masks inherited utility and Legion identities before applying target env", async () => {
	await withEnvironment(
		{
			PI_SUBAGENT_UTILITY_CHILD: "inherited-utility",
			PI_SUBAGENT_ALLOW_NESTED: "1",
			PI_SUBAGENT_PARENT_PATH: "inherited-path",
			PI_SUBAGENT_MAX_DEPTH: "4",
			PI_LEGION_DB: "/tmp/inherited-legion.db",
			PI_LEGION_NODE_ID: "inherited-node",
		},
		async () => {
			const root = mkdtempSync(path.join(tmpdir(), "vexillatio-rpc-env-"));
			let options: RpcClientOptions | undefined;
			const client = {
				process: null,
				async start() {},
				async stop() {},
				onEvent() { return () => {}; },
				async prompt() {},
				async steer() {},
				async followUp() {},
				async abort() {},
				async getSessionStats() { return null; },
			};
			const supervisor = new RpcSupervisor({
				clientFactory: (next) => {
					options = next;
					return client;
				},
			});
			const utility: AgentConfig = {
				name: "scout",
				description: "test utility",
				kind: "pi",
				systemPromptMode: "replace",
				inheritProjectContext: true,
				inheritSkills: false,
				systemPrompt: "Read-only utility",
				source: "user",
				filePath: "/agents/scout.md",
				utility: true,
				allowNestedSubagents: true,
				tools: ["read"],
			};
			try {
				await supervisor.spawnChild({
					name: "scout-0",
					task: "Inspect and report.",
					agent: utility,
					tempDir: root,
					cwd: root,
					sessionFile: path.join(root, "scout-0.jsonl"),
					env: {
						PI_SUBAGENT_CHILD: "1",
						PI_SUBAGENT_UTILITY_CHILD: "1",
					},
					stripLegionIdentity: true,
				});
				assert.ok(options?.env);
				const childEnv = { ...process.env, ...options.env };
				assert.equal(childEnv.PI_SUBAGENT_CHILD, "1");
				assert.equal(childEnv.PI_SUBAGENT_UTILITY_CHILD, "1");
				assert.equal(childEnv.PI_SUBAGENT_ALLOW_NESTED, undefined);
				for (const key of [
					"PI_LEGION_DB",
					"PI_LEGION_NODE_ID",
					"PI_SUBAGENT_PARENT_PATH",
					"PI_SUBAGENT_MAX_DEPTH",
				]) {
					assert.equal(childEnv[key], undefined, `${key} must be removed from inherited process.env`);
				}
			} finally {
				await supervisor.retire("scout-0").catch(() => {});
				rmSync(root, { recursive: true, force: true });
			}
		},
	);
});

test("non-nested command-chain children get the vexillatio playbook when selected", async () => {
	await withSandbox(
		{
			PI_SUBAGENT_CHILD: "1",
			PI_SUBAGENT_ALLOW_NESTED: undefined,
		},
		async ({ pi, cwd }) => {
			assert.equal(pi.tools.has("vexillatio"), true);
			assert.equal(pi.tools.has("subagent"), false);
			const beforeStart = pi.handlers.get("before_agent_start");
			assert.ok(beforeStart);
			const prompt = beforeStart(
				{ systemPrompt: "base prompt", systemPromptOptions: { selectedTools: ["vexillatio"] } },
				context(cwd),
			) as { systemPrompt?: string } | undefined;
			assert.match(prompt?.systemPrompt ?? "", /Utility agents.*`vexillatio`/);
		},
	);
});

test("utility child identity suppresses both dispatch tools even if ALLOW_NESTED is misconfigured", async () => {
	await withSandbox(
		{
			PI_SUBAGENT_CHILD: "1",
			PI_SUBAGENT_UTILITY_CHILD: "1",
			PI_SUBAGENT_ALLOW_NESTED: "1",
		},
		async ({ pi }) => {
			assert.equal(pi.tools.has("vexillatio"), false);
			assert.equal(pi.tools.has("subagent"), false);
		},
	);
});
