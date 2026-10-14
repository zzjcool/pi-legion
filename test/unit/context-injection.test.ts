import { test } from "node:test";
import assert from "node:assert/strict";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
	parseContextSetting,
	readConventionContext,
	resolveContextValue,
} from "../../src/agents/context.ts";
import piLegion from "../../index.ts";
import { FakeSupervisor } from "../helpers/fake-supervisor.ts";
import {
	loadSubagentSettings,
	resolveSubagentSettings,
} from "../../src/agents/settings.ts";
import { buildPiArgs } from "../../src/runs/args.ts";
import { planKindStart } from "../../src/runs/kind.ts";
import type { AgentConfig } from "../../src/shared/types.ts";

function agent(over: Partial<AgentConfig> = {}): AgentConfig {
	return {
		name: "worker",
		description: "d",
		systemPrompt: "You are a worker.",
		systemPromptMode: "append",
		inheritProjectContext: true,
		inheritSkills: false,
		kind: "pi",
		source: "user",
		filePath: "/f.md",
		...over,
	};
}

type ExtensionEvent = (...args: unknown[]) => unknown;

function withRegisteredExtension<T>(
	agentDir: string,
	run: (events: Map<string, ExtensionEvent>) => T,
): T {
	const previous = {
		agentDir: process.env.PI_CODING_AGENT_DIR,
		child: process.env.PI_SUBAGENT_CHILD,
		nested: process.env.PI_SUBAGENT_ALLOW_NESTED,
		extraAgents: process.env.PI_HERDR_SUBAGENTS_EXTRA_AGENT_DIRS,
	};
	try {
		process.env.PI_CODING_AGENT_DIR = agentDir;
		delete process.env.PI_SUBAGENT_CHILD;
		delete process.env.PI_SUBAGENT_ALLOW_NESTED;
		delete process.env.PI_HERDR_SUBAGENTS_EXTRA_AGENT_DIRS;

		const events = new Map<string, ExtensionEvent>();
		const pi = {
			registerMessageRenderer() {},
			registerTool() {},
			registerCommand() {},
			sendMessage() {},
			events: { emit() {} },
			on(name: string, handler: unknown) {
				events.set(name, handler as ExtensionEvent);
			},
		};
		piLegion(pi as never);
		return run(events);
	} finally {
		if (previous.agentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous.agentDir;
		if (previous.child === undefined) delete process.env.PI_SUBAGENT_CHILD;
		else process.env.PI_SUBAGENT_CHILD = previous.child;
		if (previous.nested === undefined)
			delete process.env.PI_SUBAGENT_ALLOW_NESTED;
		else process.env.PI_SUBAGENT_ALLOW_NESTED = previous.nested;
		if (previous.extraAgents === undefined)
			delete process.env.PI_HERDR_SUBAGENTS_EXTRA_AGENT_DIRS;
		else process.env.PI_HERDR_SUBAGENTS_EXTRA_AGENT_DIRS = previous.extraAgents;
	}
}

function invokeBeforeAgentStart(
	events: Map<string, ExtensionEvent>,
	cwd: string,
): string {
	const handler = events.get("before_agent_start");
	assert.ok(handler, "before_agent_start handler must be registered");
	const result = handler(
		{ systemPrompt: "base prompt", systemPromptOptions: {} },
		{ cwd },
	);
	assert.ok(result && typeof result === "object");
	assert.ok("systemPrompt" in result);
	const systemPrompt = (result as { systemPrompt?: unknown }).systemPrompt;
	assert.equal(typeof systemPrompt, "string");
	return systemPrompt as string;
}

// ── context.ts: value forms ─────────────────────────────────────────────

test("parseContextSetting passes inline markdown through", () => {
	assert.equal(
		parseContextSetting("be kind", "parentContext", "/base"),
		"be kind",
	);
});

test("readConventionContext ignores missing, unreadable, and blank files", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "ctx-convention-reader-"));
	try {
		mkdirSync(path.join(dir, "unreadable.md"));
		writeFileSync(path.join(dir, "blank.md"), " \n\t");
		writeFileSync(path.join(dir, "present.md"), "  convention text  \n");
		assert.equal(readConventionContext(dir, "missing.md"), undefined);
		assert.equal(readConventionContext(dir, "unreadable.md"), undefined);
		assert.equal(readConventionContext(dir, "blank.md"), undefined);
		assert.equal(readConventionContext(dir, "present.md"), "convention text");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("parseContextSetting resolves @file references against baseDir", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "ctx-ref-"));
	try {
		writeFileSync(path.join(dir, "policy.md"), "  dispatch discipline  \n");
		assert.equal(
			parseContextSetting("@policy.md", "childContext", dir),
			"dispatch discipline",
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("parseContextSetting expands ~ in a file reference", () => {
	// A missing home-relative file must fail resolution with the EXPANDED
	// path in the message, proving ~ was expanded rather than treated as a
	// relative segment.
	assert.throws(
		() => resolveContextValue("@~/definitely-missing-ctx.md", "childContext", "/base"),
		(e: Error) =>
			/definitely-missing-ctx\.md/.test(e.message) &&
			!e.message.includes("@~/"),
	);
});

test("parseContextSetting throws on a missing referenced file", () => {
	assert.throws(
		() => parseContextSetting("@nope.md", "parentContext", "/base"),
		/parentContext.*nope\.md.*cannot be read/,
	);
});

test("parseContextSetting throws on an empty referenced file", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "ctx-empty-"));
	try {
		writeFileSync(path.join(dir, "empty.md"), "   \n");
		assert.throws(
			() => parseContextSetting("@empty.md", "childContext", dir),
			/empty/,
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("parseContextSetting joins an array of entries", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "ctx-arr-"));
	try {
		writeFileSync(path.join(dir, "a.md"), "alpha");
		const text = parseContextSetting(
			["inline", "@a.md"],
			"childContext",
			dir,
		);
		assert.equal(text, "inline\n\nalpha");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// ── settings.ts: load + merge ───────────────────────────────────────────

test("settings load parentContext/childContext with @file resolution", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "ctx-settings-"));
	try {
		writeFileSync(path.join(dir, "policy.md"), "policy text");
		writeFileSync(
			path.join(dir, "settings.json"),
			JSON.stringify({
				subagents: {
					parentContext: "parent inline",
					childContext: "@policy.md",
				},
			}),
		);
		const settings = loadSubagentSettings({
			userSettingsPath: path.join(dir, "settings.json"),
		});
		assert.equal(settings.parentContext, "parent inline");
		assert.equal(settings.childContext, "policy text");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("settings inject adjacent convention contexts when subagents key is absent", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "ctx-convention-user-"));
	const agentDir = path.join(dir, "agent");
	const projectRoot = path.join(dir, "project");
	mkdirSync(agentDir);
	mkdirSync(projectRoot);
	const userSettingsPath = path.join(agentDir, "settings.json");
	try {
		writeFileSync(userSettingsPath, JSON.stringify({ unrelated: true }));
		writeFileSync(
			path.join(agentDir, "subagents-parent-context.md"),
			"user parent convention text",
		);
		writeFileSync(
			path.join(agentDir, "subagents-child-context.md"),
			"user child convention text",
		);

		const settings = loadSubagentSettings({ userSettingsPath });
		assert.equal(settings.parentContext, "user parent convention text");
		assert.equal(settings.childContext, "user child convention text");

		const systemPrompt = withRegisteredExtension(agentDir, (events) =>
			invokeBeforeAgentStart(events, projectRoot),
		);
		assert.ok(systemPrompt.includes("user parent convention text"));
		assert.ok(!systemPrompt.includes("user child convention text"));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("settings missing file still reads its directory convention context", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "ctx-convention-missing-settings-"));
	try {
		writeFileSync(
			path.join(dir, "subagents-parent-context.md"),
			"from a directory without settings",
		);
		assert.equal(
			loadSubagentSettings({
				userSettingsPath: path.join(dir, "settings.json"),
			}).parentContext,
			"from a directory without settings",
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("explicit @path context takes precedence over an adjacent convention file", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "ctx-convention-explicit-"));
	try {
		writeFileSync(
			path.join(dir, "settings.json"),
			JSON.stringify({ subagents: { parentContext: "@explicit.md" } }),
		);
		writeFileSync(path.join(dir, "explicit.md"), "explicit context");
		writeFileSync(
			path.join(dir, "subagents-parent-context.md"),
			"convention context",
		);
		assert.equal(
			loadSubagentSettings({
				userSettingsPath: path.join(dir, "settings.json"),
			}).parentContext,
			"explicit context",
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("false disables same-layer convention context injection", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "ctx-convention-false-"));
	const agentDir = path.join(dir, "agent");
	const projectRoot = path.join(dir, "project");
	mkdirSync(agentDir);
	mkdirSync(projectRoot);
	const userSettingsPath = path.join(agentDir, "settings.json");
	try {
		writeFileSync(
			userSettingsPath,
			JSON.stringify({
				subagents: { parentContext: false, childContext: false },
			}),
		);
		writeFileSync(
			path.join(agentDir, "subagents-parent-context.md"),
			"parent must not be injected",
		);
		writeFileSync(
			path.join(agentDir, "subagents-child-context.md"),
			"child must not be injected",
		);
		const settings = loadSubagentSettings({ userSettingsPath });
		assert.equal(settings.parentContext, undefined);
		assert.equal(settings.childContext, undefined);

		const systemPrompt = withRegisteredExtension(agentDir, (events) =>
			invokeBeforeAgentStart(events, projectRoot),
		);
		assert.ok(!systemPrompt.includes("parent must not be injected"));
		assert.ok(!systemPrompt.includes("child must not be injected"));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("an empty adjacent convention file is silently ignored", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "ctx-convention-empty-"));
	try {
		writeFileSync(path.join(dir, "settings.json"), JSON.stringify({}));
		writeFileSync(
			path.join(dir, "subagents-parent-context.md"),
			" \n\t",
		);
		assert.doesNotThrow(() => {
			assert.equal(
				loadSubagentSettings({
					userSettingsPath: path.join(dir, "settings.json"),
				}).parentContext,
				undefined,
			);
		});
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("project convention context loads when project settings omit subagents", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "ctx-convention-project-"));
	const userDir = path.join(dir, "user");
	const projectPiDir = path.join(dir, "project", ".pi");
	mkdirSync(userDir);
	mkdirSync(projectPiDir, { recursive: true });
	try {
		writeFileSync(path.join(userDir, "settings.json"), JSON.stringify({}));
		writeFileSync(path.join(projectPiDir, "settings.json"), JSON.stringify({}));
		writeFileSync(
			path.join(projectPiDir, "subagents-parent-context.md"),
			"project convention context",
		);
		assert.equal(
			loadSubagentSettings({
				userSettingsPath: path.join(userDir, "settings.json"),
				projectSettingsPath: path.join(projectPiDir, "settings.json"),
			}).parentContext,
			"project convention context",
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("project convention contexts win when both layers have only convention files", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "ctx-convention-both-layers-"));
	const userDir = path.join(dir, "user");
	const projectPiDir = path.join(dir, "project", ".pi");
	mkdirSync(userDir);
	mkdirSync(projectPiDir, { recursive: true });
	try {
		writeFileSync(path.join(userDir, "settings.json"), JSON.stringify({}));
		writeFileSync(path.join(projectPiDir, "settings.json"), JSON.stringify({}));
		writeFileSync(
			path.join(userDir, "subagents-parent-context.md"),
			"user parent convention context",
		);
		writeFileSync(
			path.join(userDir, "subagents-child-context.md"),
			"user child convention context",
		);
		writeFileSync(
			path.join(projectPiDir, "subagents-parent-context.md"),
			"project parent convention context",
		);
		writeFileSync(
			path.join(projectPiDir, "subagents-child-context.md"),
			"project child convention context",
		);

		const settings = loadSubagentSettings({
			userSettingsPath: path.join(userDir, "settings.json"),
			projectSettingsPath: path.join(projectPiDir, "settings.json"),
		});
		assert.equal(settings.parentContext, "project parent convention context");
		assert.equal(settings.childContext, "project child convention context");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("project false context suppresses its convention without masking user explicit value", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "ctx-convention-project-false-"));
	const userDir = path.join(dir, "user");
	const projectPiDir = path.join(dir, "project", ".pi");
	mkdirSync(userDir);
	mkdirSync(projectPiDir, { recursive: true });
	try {
		writeFileSync(
			path.join(userDir, "settings.json"),
			JSON.stringify({ subagents: { parentContext: "user explicit context" } }),
		);
		writeFileSync(
			path.join(projectPiDir, "settings.json"),
			JSON.stringify({ subagents: { parentContext: false } }),
		);
		writeFileSync(
			path.join(projectPiDir, "subagents-parent-context.md"),
			"project convention suppressed by false",
		);

		assert.equal(
			loadSubagentSettings({
				userSettingsPath: path.join(userDir, "settings.json"),
				projectSettingsPath: path.join(projectPiDir, "settings.json"),
			}).parentContext,
			"user explicit context",
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("project explicit context overrides user convention context", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "ctx-convention-project-explicit-"));
	const userDir = path.join(dir, "user");
	const projectPiDir = path.join(dir, "project", ".pi");
	mkdirSync(userDir);
	mkdirSync(projectPiDir, { recursive: true });
	try {
		writeFileSync(path.join(userDir, "settings.json"), JSON.stringify({}));
		writeFileSync(
			path.join(userDir, "subagents-parent-context.md"),
			"user convention context",
		);
		writeFileSync(
			path.join(projectPiDir, "settings.json"),
			JSON.stringify({ subagents: { parentContext: "project explicit context" } }),
		);
		assert.equal(
			loadSubagentSettings({
				userSettingsPath: path.join(userDir, "settings.json"),
				projectSettingsPath: path.join(projectPiDir, "settings.json"),
			}).parentContext,
			"project explicit context",
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("project convention still replaces a user explicit context wholesale", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "ctx-convention-project-wholesale-"));
	const userDir = path.join(dir, "user");
	const projectPiDir = path.join(dir, "project", ".pi");
	mkdirSync(userDir);
	mkdirSync(projectPiDir, { recursive: true });
	try {
		writeFileSync(
			path.join(userDir, "settings.json"),
			JSON.stringify({ subagents: { parentContext: "user explicit context" } }),
		);
		writeFileSync(path.join(projectPiDir, "settings.json"), JSON.stringify({}));
		writeFileSync(
			path.join(projectPiDir, "subagents-parent-context.md"),
			"project convention wins",
		);
		assert.equal(
			loadSubagentSettings({
				userSettingsPath: path.join(userDir, "settings.json"),
				projectSettingsPath: path.join(projectPiDir, "settings.json"),
			}).parentContext,
			"project convention wins",
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("user false suppresses its convention when project settings have no context", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "ctx-convention-false-project-"));
	const userDir = path.join(dir, "user");
	const projectPiDir = path.join(dir, "project", ".pi");
	mkdirSync(userDir);
	mkdirSync(projectPiDir, { recursive: true });
	try {
		writeFileSync(
			path.join(userDir, "settings.json"),
			JSON.stringify({ subagents: { parentContext: false } }),
		);
		writeFileSync(
			path.join(userDir, "subagents-parent-context.md"),
			"user convention is disabled",
		);
		writeFileSync(path.join(projectPiDir, "settings.json"), JSON.stringify({}));
		assert.equal(
			loadSubagentSettings({
				userSettingsPath: path.join(userDir, "settings.json"),
				projectSettingsPath: path.join(projectPiDir, "settings.json"),
			}).parentContext,
			undefined,
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("before_agent_start still fails loudly for a broken explicit context reference", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "ctx-before-start-broken-"));
	const agentDir = path.join(dir, "agent");
	const projectRoot = path.join(dir, "project");
	mkdirSync(agentDir);
	mkdirSync(projectRoot);
	try {
		writeFileSync(
			path.join(agentDir, "settings.json"),
			JSON.stringify({ subagents: { parentContext: "@missing-context.md" } }),
		);
		const originalWarn = console.warn;
		try {
			console.warn = () => {};
			assert.throws(
				() =>
					withRegisteredExtension(agentDir, (events) =>
						invokeBeforeAgentStart(events, projectRoot),
					),
				/parentContext.*missing-context\.md.*cannot be read/,
			);
		} finally {
			console.warn = originalWarn;
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("parent extension no longer registers a pane-era bash dispatch interceptor", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "ctx-parent-rpc-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	const previousRole = process.env.PI_SUBAGENT_ROLE;
	try {
		process.env.PI_CODING_AGENT_DIR = dir;
		delete process.env.PI_SUBAGENT_ROLE;
		const events = new Map<string, ExtensionEvent>();
		const pi = {
			registerMessageRenderer() {}, registerTool() {}, registerCommand() {}, sendMessage() {},
			events: { emit() {} },
			on(name: string, handler: unknown) { events.set(name, handler as ExtensionEvent); },
		};
		piLegion(pi as never, { supervisor: new FakeSupervisor() });
		// Scout guard observes tool_call. The old interceptor blocked or rewrote bash.
		const handler = events.get("tool_call");
		assert.equal(typeof handler, "function");
		const event = { toolName: "bash", input: { command: "echo hi" } };
		assert.equal(handler?.(event, { cwd: dir }), undefined);
		assert.equal(event.input.command, "echo hi");
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		if (previousRole === undefined) delete process.env.PI_SUBAGENT_ROLE;
		else process.env.PI_SUBAGENT_ROLE = previousRole;
		rmSync(dir, { recursive: true, force: true });
	}
});

test("project settings replace user context wholesale", () => {
	const merged = resolveSubagentSettings(
		{ parentContext: "user text", childContext: "user child" },
		{ parentContext: "project text" },
	);
	assert.equal(merged.parentContext, "project text");
	assert.equal(merged.childContext, "user child");
});

// ── args.ts: pi child system prompt ─────────────────────────────────────

test("buildPiArgs appends childContext after the role prompt", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "ctx-args-"));
	try {
		const built = buildPiArgs({
			agent: agent(),
			task: "work",
			sessionFile: "/tmp/s.jsonl",
			tempDir: dir,
			childContext: "extra discipline",
		});
		const idx = built.args.indexOf("--append-system-prompt");
		assert.ok(idx >= 0, "role mode append stays append");
		const file = built.args[idx + 1];
		assert.ok(typeof file === "string");
		const text = readFileSync(file, "utf-8");
		const roleIdx = text.indexOf("You are a worker.");
		const ctxIdx = text.indexOf("extra discipline");
		assert.ok(roleIdx >= 0 && ctxIdx > roleIdx, "context follows the role prompt");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("buildPiArgs emits append (not replace) for a context-only replace-mode child", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "ctx-args-only-"));
	try {
		const built = buildPiArgs({
			agent: agent({ systemPrompt: "", systemPromptMode: "replace" }),
			task: "work",
			sessionFile: "/tmp/s.jsonl",
			tempDir: dir,
			childContext: "ctx only",
		});
		const appendIdx = built.args.indexOf("--append-system-prompt");
		const replaceIdx = built.args.indexOf("--system-prompt");
		assert.ok(appendIdx >= 0, "context-only child must append, not replace");
		assert.equal(replaceIdx, -1);
		const file = built.args[appendIdx + 1];
		assert.ok(typeof file === "string");
		assert.match(readFileSync(file, "utf-8"), /ctx only/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("buildPiArgs omits the system-prompt flag without prompts", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "ctx-args-none-"));
	try {
		const built = buildPiArgs({
			agent: agent({ systemPrompt: "" }),
			task: "work",
			sessionFile: "/tmp/s.jsonl",
			tempDir: dir,
		});
		assert.equal(built.args.indexOf("--append-system-prompt"), -1);
		assert.equal(built.args.indexOf("--system-prompt"), -1);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// ── kind.ts: non-pi prompt composition ──────────────────────────────────

test("planKindStart rides childContext in a non-pi task prompt", () => {
	const plan = planKindStart({
		agent: agent({ kind: "cursor", systemPrompt: "role prompt" }),
		task: "do the thing",
		sessionFile: "/tmp/s.jsonl",
		tempDir: "/tmp/unused",
		childContext: "cursor discipline",
	});
	const roleIdx = plan.taskText.indexOf("role prompt");
	const ctxIdx = plan.taskText.indexOf("cursor discipline");
	const taskIdx = plan.taskText.indexOf("do the thing");
	assert.ok(
		roleIdx >= 0 && ctxIdx > roleIdx && taskIdx > ctxIdx,
		"order: role < context < task",
	);
});

test("planKindStart keeps a pi task prompt free of the context", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "ctx-kind-pi-"));
	try {
		const plan = planKindStart({
			agent: agent(),
			task: "do the thing",
			sessionFile: "/tmp/s.jsonl",
			tempDir: dir,
			childContext: "pi discipline",
		});
		assert.ok(!plan.taskText.includes("pi discipline"));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
