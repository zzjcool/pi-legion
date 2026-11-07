import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import piLegion from "../../index.ts";
import { LegionPostman } from "../../src/extension/legion-tools.ts";
import { ErrorCodes, type AgentConfig } from "../../src/shared/types.ts";
import { RpcSupervisor } from "../../src/supervisor/rpc-supervisor.ts";
import type { RpcClientOptions, SettleResult } from "../../src/supervisor/types.ts";
import { openLegionDb, legionDbPath, type DatabaseSync } from "../../src/legion/db.ts";
import { readEventsAfter } from "../../src/legion/events.ts";
import { MAIL_BOUNCE_REASON, MAIL_DELIVERY, inbox, pendingInbox } from "../../src/legion/mail.ts";
import { isMailHeld } from "../../src/legion/mail-release.ts";
import { getNode, insertNode } from "../../src/legion/nodes.ts";
import { STALL_NOTICE_SUBJECT_PREFIX, formatStallNotice } from "../../src/legion/stall-notice.ts";
import { FakeSupervisor } from "../helpers/fake-supervisor.ts";

interface ToolResult {
	content: Array<{ type: string; text?: string }>;
	details?: unknown;
}

interface RegisteredTool {
	name: string;
	parameters: unknown;
	execute: (...args: unknown[]) => Promise<ToolResult>;
}

function fakePi() {
	const tools = new Map<string, RegisteredTool>();
	const handlers = new Map<string, (...args: unknown[]) => unknown>();
	const messages: unknown[] = [];
	return {
		tools,
		handlers,
		messages,
		registerTool(tool: unknown) {
			const typed = tool as RegisteredTool;
			tools.set(typed.name, typed);
		},
		registerMessageRenderer() {},
		on(name: string, handler: (...args: unknown[]) => unknown) {
			handlers.set(name, handler);
		},
		registerCommand() {},
		sendMessage(message: unknown) { messages.push(message); },
		events: { emit() {} },
	};
}

type FakePi = ReturnType<typeof fakePi>;

interface CapturedFooter {
	status?: string;
	widgetVisible?: boolean;
	widgetText?: string;
}

function context(
	cwd: string,
	options: { footer?: CapturedFooter; model?: { provider: string; id: string } } = {},
) {
	return {
		cwd,
		hasUI: options.footer !== undefined,
		ui: {
			setStatus(_key: string, status: string | undefined) {
				if (options.footer) options.footer.status = status;
			},
			setWidget(_key: string, widget: unknown) {
				if (!options.footer) return;
				options.footer.widgetVisible = widget !== undefined;
				if (typeof widget !== "function") {
					options.footer.widgetText = undefined;
					return;
				}
				const factory = widget as (
					tui: { requestRender(): void },
					theme: { fg(color: string, text: string): string },
				) => { render(width?: number): string[] };
				const view = factory(
					{ requestRender() {} },
					{ fg(_color, text) { return text; } },
				);
				options.footer.widgetText = view.render(120).join("\n");
			},
		},
		sessionManager: { getSessionFile: () => path.join(cwd, "root-session.jsonl") },
		...(options.model ? { model: options.model } : {}),
	};
}

class FirstTimeoutSupervisor extends FakeSupervisor {
	private readonly timedOut = new Set<string>();

	constructor() {
		super({ immediateTimeout: false });
	}

	override waitSettled(name: string, timeoutMs?: number): Promise<SettleResult> {
		if (!this.timedOut.has(name)) {
			this.timedOut.add(name);
			return Promise.resolve({ settled: false, abnormal: false, reason: "timeout" });
		}
		return super.waitSettled(name, timeoutMs);
	}
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
				piLegion(pi as never, { supervisor });
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
	signal?: AbortSignal,
): Promise<ToolResult> {
	const tool = pi.tools.get(name);
	assert.ok(tool, `${name} tool must be registered`);
	return tool.execute("test-call", params, signal, undefined, ctx);
}

function writeProjectSubagentSettings(cwd: string, subagents: Record<string, unknown>): void {
	const piDir = path.join(cwd, ".pi");
	mkdirSync(piDir, { recursive: true });
	writeFileSync(path.join(piDir, "settings.json"), JSON.stringify({ subagents }));
}

async function waitFor(
	predicate: () => boolean,
	timeoutMs = 1_000,
): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return true;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	return predicate();
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
			const details = result.details as { async?: boolean; stillRunning?: string[] } | undefined;
			assert.equal(details?.async, false);
			assert.equal(details?.stillRunning, undefined, "settled utilities need no stillRunning detail");

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

test("vexillatio resolves utility model and thinking from the active team", async () => {
	await withSandbox(
		{ PI_SUBAGENTS_TEAM: "be-value" },
		async ({ pi, supervisor, cwd }) => {
			writeProjectSubagentSettings(cwd, {
				teams: {
					"be-value": {
						members: [{ agent: "scout", model: "workbuddy/hy4-preview-f", thinking: "high" }],
					},
				},
			});
			const result = await invoke(pi, "vexillatio", {
				task: "Inspect the test repository under the active team.",
				agent: "scout",
			}, context(cwd, { model: { provider: "parent-provider", id: "parent-model" } }));
			assert.match(result.content[0]?.text ?? "", /execution: success/);
			assert.equal(supervisor.spawns.length, 1);
			const spawn = supervisor.spawns[0];
			assert.ok(spawn);
			assert.equal(spawn.input.model, "workbuddy/hy4-preview-f");
			assert.equal(spawn.input.thinking, "high");
			const modelIndex = spawn.args.indexOf("--model");
			assert.notEqual(modelIndex, -1);
			assert.equal(spawn.args[modelIndex + 1], "workbuddy/hy4-preview-f:high");
		},
	);
});

test("vexillatio falls back to allAgents when the active team omits a utility agent", async () => {
	await withSandbox(
		{ PI_SUBAGENTS_TEAM: "be-value" },
		async ({ pi, supervisor, cwd }) => {
			writeProjectSubagentSettings(cwd, {
				teams: { "be-value": { members: ["worker"] } },
			});
			const result = await invoke(pi, "vexillatio", {
				task: "Inspect the test repository as a utility outside the team roster.",
				agent: "scout",
			}, context(cwd));
			assert.match(result.content[0]?.text ?? "", /── scout-0 ──/);
			assert.equal(supervisor.spawns.length, 1);
			assert.equal(supervisor.spawns[0]?.input.agent.name, "scout");
		},
	);
});

test("vexillatio does not resurrect a utility explicitly disabled by the active team", async () => {
	await withSandbox(
		{ PI_SUBAGENTS_TEAM: "be-value" },
		async ({ pi, supervisor, cwd }) => {
			writeProjectSubagentSettings(cwd, {
				teams: {
					"be-value": {
						members: ["worker", { agent: "scout", disabled: true }],
					},
				},
			});
			const result = await invoke(pi, "vexillatio", {
				task: "Inspect the test repository as a utility.",
				agent: "scout",
			}, context(cwd));
			assert.equal((result.details as { error?: string } | undefined)?.error, ErrorCodes.INVALID_PARAMS);
			assert.match(result.content[0]?.text ?? "", /unknown agent "scout" in team "be-value"/);
			assert.doesNotMatch(result.content[0]?.text ?? "", /not a utility agent/);
			assert.equal(supervisor.spawns.length, 0);
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
		assert.equal(supervisor.spawns[0]?.args[toolsIndex + 1], "read,grep,find,ls,legion_mail,legion_tree,legion_phase", "utility roles must not inherit vexillatio");
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
		assert.equal(spawn.args[toolsIndex + 1], "read,grep,find,ls,vexillatio,legion_mail,legion_tree,legion_phase");
		assert.equal(spawn.args[toolsIndex + 1]?.includes("subagent"), false);
		assert.equal(spawn.input.env?.PI_SUBAGENT_UTILITY_CHILD, undefined);
	});
});

test("vexillatio schema accepts tasks[] without a top-level task", async () => {
	// `tool.execute` in this suite bypasses pi's argument validation, so the
	// registered schema must be checked directly: a required `task` rejected
	// every `{ tasks: [...] }` call before `execute` ran (pi reports
	// `task: must have required properties task`), which is exactly how models
	// copy the `subagent({ tasks })` shape.
	const { Value } = await import("typebox/value");
	await withSandbox({}, async ({ pi }) => {
		const tool = pi.tools.get("vexillatio");
		assert.ok(tool, "vexillatio tool must be registered");
		const schema = tool.parameters as Parameters<typeof Value.Check>[0];
		assert.deepEqual(Value.Errors(schema, { tasks: [{ agent: "scout", task: "Inspect area A." }] }), []);
		assert.deepEqual(Value.Errors(schema, { task: "Inspect area A." }), []);
		assert.deepEqual(
			Value.Errors(schema, {
				task: "Both shapes.",
				tasks: [{ agent: "scout", task: "Inspect area A." }],
			}),
			[],
		);
		assert.equal(
			Value.Check(schema, {}),
			true,
			"an empty request passes the schema and is refused by the planner instead (next test)",
		);
	});
});

test("vexillatio launches tasks[]-only requests and labels the parent run", async () => {
	await withSandbox({}, async ({ pi, supervisor, cwd }) => {
		const result = await invoke(pi, "vexillatio", {
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

test("vexillatio refuses a request with neither task nor tasks[]", async () => {
	await withSandbox({}, async ({ pi, supervisor, cwd }) => {
		const result = await invoke(pi, "vexillatio", { timeoutMs: 10_000 }, context(cwd));
		assert.equal((result.details as { error?: string } | undefined)?.error, ErrorCodes.INVALID_PARAMS);
		assert.match(result.content[0]?.text ?? "", /Provide one of/);
		assert.equal(supervisor.spawns.length, 0);
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
			assert.match(output, /collect deadline \(per collect attempt\) exceeded; child still alive/);
			assert.match(output, /sessionFile:/);
			assert.equal(supervisor.isAlive("scout-1"), true, "timed-out utility remains alive and controllable");
			assert.deepEqual(supervisor.spawns.map((spawn) => spawn.input.name), ["scout-0", "scout-1"]);
		},
		supervisor,
	);
});

test("vexillatio tracks a timed-out utility until completion clears its Legion and widget state", async () => {
	const supervisor = new FirstTimeoutSupervisor();
	await withSandbox({}, async ({ pi, cwd }) => {
		const footer: CapturedFooter = {};
		const result = await invoke(pi, "vexillatio", {
			task: "Inspect and report after the initial collection times out.",
			agent: "scout",
			timeoutMs: 50,
		}, context(cwd, { footer }));
		const output = result.content.map((part) => part.text ?? "").join("\n");
		assert.match(output, /execution: running/);
		assert.match(output, /collect deadline \(per collect attempt\) exceeded; child still alive/);
		assert.deepEqual(
			(result.details as { stillRunning?: string[] } | undefined)?.stillRunning,
			["scout-0"],
			"the tool details name the utility that remains under a watch",
		);
		assert.equal(supervisor.isAlive("scout-0"), true);
		assert.equal(footer.status, undefined, "footer N agents running removed (#192); widget owns the count");
		assert.equal(footer.widgetVisible, true);
		assert.match(footer.widgetText ?? "", /scout-0/);
		const runId = (result.details as { runId?: string } | undefined)?.runId;
		assert.ok(runId, "vexillatio returns the parent run id");

		const dbPath = legionDbPath(path.join(cwd, ".pi-subagents", "runs", runId));
		const db = openLegionDb(dbPath);
		try {
			assert.equal(getNode(db, "root.scout-0")?.status, "running");
			supervisor.settle("scout-0", { text: "utility work completed after the timeout" });
			await waitFor(() => !supervisor.isAlive("scout-0"), 2_000);
			assert.deepEqual(
				{
					nodeStatus: getNode(db, "root.scout-0")?.status,
					footerStatus: footer.status,
					widgetVisible: footer.widgetVisible,
					widgetText: footer.widgetText ?? "",
					childAlive: supervisor.isAlive("scout-0"),
				},
				{
					nodeStatus: "settled",
					footerStatus: undefined,
					widgetVisible: false,
					widgetText: "",
					childAlive: false,
				},
			);
		} finally {
			db.close();
		}
		await pi.handlers.get("session_shutdown")?.();
		assert.equal(
			supervisor.calls.filter((call) => call.method === "retire" && call.name === "scout-0").length,
			1,
			"the retained shutdown retire hook must share the watch's completed retirement",
		);
	}, supervisor);
});

test("non-nested command-chain child retires a timed-out utility on session shutdown", async () => {
	const supervisor = new FirstTimeoutSupervisor();
	await withSandbox(
		{
			PI_SUBAGENT_CHILD: "1",
			PI_SUBAGENT_ALLOW_NESTED: undefined,
		},
		async ({ pi, cwd }) => {
			const result = await invoke(pi, "vexillatio", {
				task: "Inspect and report after the initial collection times out.",
				agent: "scout",
				timeoutMs: 50,
			}, context(cwd));
			assert.match(result.content[0]?.text ?? "", /execution: running/);
			assert.equal(supervisor.isAlive("scout-0"), true);

			await pi.handlers.get("session_shutdown")?.();
			assert.equal(supervisor.isAlive("scout-0"), false);
			assert.equal(
				supervisor.calls.filter((call) => call.method === "retire" && call.name === "scout-0").length,
				1,
				"the child and pending utility retire paths must share one retirement",
			);
		},
		supervisor,
	);
});

test("vexillatio tasks[] keeps and retires both timed-out utilities independently", async () => {
	const supervisor = new FirstTimeoutSupervisor();
	await withSandbox(
		{ PI_SUBAGENTS_TEAM: undefined },
		async ({ pi, cwd }) => {
			const footer: CapturedFooter = {};
			writeProjectSubagentSettings(cwd, { joinMode: "each" });
			await invoke(pi, "subagent", { action: "list" }, context(cwd, { footer }));

			const result = await invoke(pi, "vexillatio", {
				task: "Wait for both independent utility tasks.",
				tasks: [
					{ agent: "scout", task: "Inspect area A." },
					{ agent: "scout", task: "Inspect area B." },
				],
				timeoutMs: 50,
			}, context(cwd, { footer }));
			const output = result.content.map((part) => part.text ?? "").join("\n");
			assert.match(output, /scout-0[\s\S]*execution: running/);
			assert.match(output, /scout-1[\s\S]*execution: running/);
			assert.deepEqual(
				(result.details as { stillRunning?: string[] } | undefined)?.stillRunning,
				["scout-0", "scout-1"],
			);
			assert.equal(footer.status, undefined, "footer N agents running removed (#192); widget owns the count");
			assert.equal(footer.widgetVisible, true);
			assert.equal(supervisor.isAlive("scout-0"), true);
			assert.equal(supervisor.isAlive("scout-1"), true);

			supervisor.settle("scout-0", { text: "area A completed" });
			supervisor.settle("scout-1", { text: "area B completed" });
			assert.equal(
				await waitFor(
					() =>
						pi.messages.length === 2 &&
						footer.status === undefined &&
						footer.widgetVisible === false &&
						supervisor.calls.filter((call) => call.method === "retire").length === 2,
					2_000,
				),
				true,
				"both watches notify and retire their child, then clear the shared widget",
			);
			const notices = pi.messages.map((message) => JSON.stringify(message) ?? "");
			assert.ok(notices.some((message) => message.includes("scout-0")));
			assert.ok(notices.some((message) => message.includes("scout-1")));
		},
		supervisor,
	);
});

class ExitsOnCollectFailureSupervisor extends FakeSupervisor {
	override waitSettled(name: string, _timeoutMs?: number): Promise<SettleResult> {
		this.exit(name);
		return Promise.reject(new Error("collect failed after child exit"));
	}
}

test("vexillatio retires an already-dead utility when collect fails", async () => {
	const supervisor = new ExitsOnCollectFailureSupervisor();
	await withSandbox(
		{},
		async ({ pi, cwd }) => {
			const result = await invoke(pi, "vexillatio", {
				task: "Collect from a child that exits unexpectedly.",
				agent: "scout",
			}, context(cwd));
			assert.match(result.content[0]?.text ?? "", /collect failed after child exit/);
			assert.equal(supervisor.isAlive("scout-0"), false);
			const runId = (result.details as { runId?: string } | undefined)?.runId;
			assert.ok(runId, "vexillatio returns the parent run id");
			const db = openLegionDb(legionDbPath(path.join(cwd, ".pi-subagents", "runs", runId)));
			try {
				assert.equal(
					getNode(db, "root.scout-0")?.status,
					"retired",
					"the dead child's Legion node must not remain working after collect failure",
				);
			} finally {
				db.close();
			}
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

// ─────── a synchronous batch owns the parent inbox (#384 hold, extended) ───────

/**
 * The ledger of the root run this sandbox just created.
 *
 * The tool publishes its `runId` only in its RESULT, and the case below needs the
 * ledger while the call is still blocked — so the run directory is scanned instead
 * of predicted (`createRun` mints the id).
 */
function findRunDb(cwd: string): string | undefined {
	const runsDir = path.join(cwd, ".pi-subagents", "runs");
	let entries: string[];
	try {
		entries = readdirSync(runsDir);
	} catch {
		return undefined;
	}
	for (const entry of entries) {
		const candidate = path.join(runsDir, entry, "legion.db");
		if (existsSync(candidate)) return candidate;
	}
	return undefined;
}

/** The row `LegionPostman.writeStallNotice` writes: self-addressed, PENDING, frozen grammar. */
function queueStallNotice(db: DatabaseSync, nodeId: string, names: readonly string[], createdAt: number): number {
	const { subject, body } = formatStallNotice(
		names.map((childName) => ({
			kind: "long-running" as const,
			childName,
			sinceBucket: createdAt,
			sequence: 1,
			elapsedMs: 600_000,
			thresholdMs: 600_000,
		})),
		createdAt,
	);
	const inserted = db
		.prepare(
			`INSERT INTO messages (
				from_node, to_node, subject, body, kind, urgency, delivered, created_at
			) VALUES (?, ?, ?, ?, 'notice', 'action-needed', ?, ?)`,
		)
		.run(nodeId, nodeId, subject, body, MAIL_DELIVERY.PENDING, createdAt);
	return Number(inserted.lastInsertRowid);
}

/**
 * `Promise.race` with a sentinel: a fixture that would otherwise wait forever (a collect
 * that never settles, an abort that lands nowhere) fails with a named error instead of
 * hanging the suite.
 */
async function settleWithin<T>(work: Promise<T>, label: string, boundMs = 5_000): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const bound = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(() => reject(new Error(`bounded fixture wait expired (${boundMs}ms): ${label}`)), boundMs);
		timer.unref?.();
	});
	return Promise.race([work, bound]).finally(() => {
		if (timer) clearTimeout(timer);
	});
}

/**
 * How many stall notices about `childName` the PARENT SESSION received.
 *
 * Two postmen can deliver a root's inbox: the harness one this file builds, and the real
 * one the extension started for the run (2s tick, delivery lands in `pi.messages`). A
 * release-restored delivery may belong to either, so the assertion counts both — what
 * matters is that exactly one copy reaches the session.
 */
function stallAlertsFor(pi: FakePi, own: readonly string[], childName: string): number {
	const needle = `${STALL_NOTICE_SUBJECT_PREFIX}${childName}`;
	return [...own, ...pi.messages.map((message) => JSON.stringify(message))].filter((text) => text.includes(needle)).length;
}

/** A REAL root postman that only ticks when the test says so (2s cadence is a timer, not a fact). */
function rootPostman(db: DatabaseSync, supervisor: FakeSupervisor, collected: string[]): LegionPostman {
	return new LegionPostman({
		db,
		nodeId: "root",
		supervisor,
		now: () => Date.now(),
		sendRootMessage: (message) => collected.push(message),
		intervalMs: 10_000,
	});
}

test("vexillatio holds the parent inbox while it collects, and a child that ends obsoletes its stall notice", async () => {
	// `immediateTimeout: false` makes the utility's `waitSettled` hang, which is what a
	// 10-minute scout does to `Promise.all(handles.map(collect))`.
	const supervisor = new FakeSupervisor({ immediateTimeout: false });
	await withSandbox({}, async ({ pi, cwd }) => {
		const parentMail: string[] = [];
		const call = invoke(pi, "vexillatio", {
			task: "Inspect the repository and report facts.",
			agent: "scout",
			timeoutMs: 10_000,
		}, context(cwd));
		// The batch reaches the blocked collect only after the hold is taken, and the
		// ledger row exists before it: both are preconditions of what follows.
		assert.equal(await waitFor(() => supervisor.calls.some((entry) => entry.method === "waitSettled")), true);
		const dbPath = findRunDb(cwd);
		assert.ok(dbPath, "fixture: the root run's ledger exists");
		const db = openLegionDb(dbPath);
		const postman = rootPostman(db, supervisor, parentMail);
		try {
			assert.ok(getNode(db, "root.scout-0"), "fixture: the utility node is in the ledger");
			const messageId = queueStallNotice(db, "root", ["scout-0"], Date.now());
			// Two ticks while the collect is stuck. Without the hold this is exactly the
			// measured defect: the row went PENDING → ACCEPTED ~200ms after the write and
			// the parent turned again for a notice whose children had already returned.
			await postman.tick();
			await postman.tick();
			assert.deepEqual(parentMail, [], "the held batch delivers nothing to the parent");
			assert.equal(pendingInbox(db, "root").length, 1, "the notice waits for the batch instead of reaching the host queue");

			// The scout returns and the batch ends.
			supervisor.settle("scout-0", { text: "facts collected", stopReason: "stop" });
			const result = await call;
			assert.match(result.content.map((part) => part.text ?? "").join("\n"), /── scout-0 ──/);
			assert.equal(isMailHeld("root"), false, "the hold is released with the batch");

			// The ended child takes its notice with it — before any postman pass.
			assert.equal(pendingInbox(db, "root").length, 0, "an expired to-do is not left in the inbox");
			assert.equal(inbox(db, "root", { delivery: MAIL_DELIVERY.OBSOLETE }).length, 1);
			const verdicts = readEventsAfter(db, 0)
				.filter((event) => event.type === "mail_bounced" && (event.data as { messageId?: number }).messageId === messageId)
				.map((event) => (event.data as { reason?: string }).reason);
			assert.deepEqual(verdicts, [MAIL_BOUNCE_REASON.OBSOLETE_AFTER_CHILD_END]);
			// …and the released postman cannot resurrect it: the parent receives 0 mails.
			await postman.tick();
			assert.deepEqual(parentMail, []);
		} finally {
			postman.stop();
			db.close();
		}
	}, supervisor);
});

test("vexillatio's hold does not eat a live child's alert: a still-running notice is delivered after the batch", async () => {
	// The reverse control of the case above: the pending row and the hold must COEXIST,
	// and the notice names a child that is still RUNNING at release time — an alert the
	// hold must never absorb (a release that discards the inbox would eat real mail).
	const supervisor = new FakeSupervisor({ immediateTimeout: false });
	await withSandbox({}, async ({ pi, cwd }) => {
		const parentMail: string[] = [];
		const call = invoke(pi, "vexillatio", {
			task: "Inspect the repository and report facts.",
			agent: "scout",
			timeoutMs: 10_000,
		}, context(cwd));
		assert.equal(await waitFor(() => supervisor.calls.some((entry) => entry.method === "waitSettled")), true);
		const dbPath = findRunDb(cwd);
		assert.ok(dbPath, "fixture: the root run's ledger exists");
		const db = openLegionDb(dbPath);
		const postman = rootPostman(db, supervisor, parentMail);
		try {
			// A child of root that stays `running` for the whole case: the notice points at
			// live work, so the STALL predicate (the only thing delivery consults) says
			// "deliver it" — now and after the release alike.
			insertNode(db, { parentId: "root", name: "watcher", role: "worker", status: "running" }, () => Date.now());
			queueStallNotice(db, "root", ["watcher"], Date.now());
			await postman.tick();
			await postman.tick();
			// The two facts must be true AT THE SAME TIME, which is what makes a release
			// that clears the inbox visible: held AND still queued.
			assert.equal(isMailHeld("root"), true, "fixture: the batch still holds the inbox");
			assert.deepEqual(parentMail, [], "held: the harness postman delivers nothing");
			assert.equal(stallAlertsFor(pi, parentMail, "watcher"), 0, "…and the real postman delivers nothing either");
			assert.equal(pendingInbox(db, "root").length, 1, "the row survives the hold instead of being consumed or dropped");

			// The scout returns; the batch (and its hold) ends.
			supervisor.settle("scout-0", { text: "facts collected", stopReason: "stop" });
			await settleWithin(call, "the vexillatio batch returned");
			assert.equal(isMailHeld("root"), false, "the hold is released with the batch");

			// One harness tick revives the ordinary route; the bounded wait below then
			// tolerates the run's OWN 2s postman having won the race (it is live in this
			// sandbox), so the assertion is "delivered once", not "delivered by me".
			await postman.tick();
			assert.equal(await waitFor(() => pendingInbox(db, "root").length === 0, 2_000), true, "the released notice left the pending inbox");
			assert.equal(stallAlertsFor(pi, parentMail, "watcher"), 1, "exactly one copy reaches the parent session");
			const queued = inbox(db, "root", { delivery: MAIL_DELIVERY.ACCEPTED }).length
				+ inbox(db, "root", { delivery: MAIL_DELIVERY.DELIVERED }).length;
			assert.equal(queued, 1, "the ledger records it as accepted/delivered");
			assert.equal(inbox(db, "root", { delivery: MAIL_DELIVERY.OBSOLETE }).length, 0, "a live child's alert is never obsoleted");
		} finally {
			postman.stop();
			db.close();
		}
	}, supervisor);
});

test("vexillatio releases the hold when the parent aborts mid-batch (a leak would silence the node forever)", async () => {
	// `index.ts` releases in a `finally`, and the abort path is the one that also has to
	// work: a leaked hold parks the inbox of THIS node for the rest of the process, so
	// every future mail to it would sit PENDING with no route.
	const supervisor = new FakeSupervisor({ immediateTimeout: false });
	await withSandbox({}, async ({ pi, cwd }) => {
		const controller = new AbortController();
		const call = invoke(pi, "vexillatio", {
			task: "Inspect the repository and report facts.",
			agent: "scout",
			timeoutMs: 10_000,
		}, context(cwd), controller.signal);
		assert.equal(await waitFor(() => supervisor.calls.some((entry) => entry.method === "waitSettled")), true);
		assert.equal(isMailHeld("root"), true, "fixture: the blocked batch holds the inbox");
		controller.abort();
		const result = await settleWithin(call, "the aborted batch returned");
		assert.match(result.content.map((part) => part.text ?? "").join("\n"), /interrupted \(parent turn ended; children still running\)/);
		assert.equal(isMailHeld("root"), false, "an aborted batch must hand the inbox back");

		// …and the node's mail flows again, which is the fact the flag sums up.
		const dbPath = findRunDb(cwd);
		assert.ok(dbPath, "fixture: the root run's ledger exists");
		const db = openLegionDb(dbPath);
		const parentMail: string[] = [];
		const postman = rootPostman(db, supervisor, parentMail);
		try {
			queueStallNotice(db, "root", ["scout-0"], Date.now());
			await postman.tick();
			assert.equal(await waitFor(() => pendingInbox(db, "root").length === 0, 2_000), true, "a released node delivers again");
			assert.equal(stallAlertsFor(pi, parentMail, "scout-0"), 1);
		} finally {
			postman.stop();
			db.close();
		}
	}, supervisor);
});
