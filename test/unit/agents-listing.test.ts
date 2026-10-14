/**
 * `/legion agents` command tests.
 *
 * Drives the real extension factory (like presets-regression.test.ts) so the
 * whole path is covered: registerCommand wiring → loadCatalog → discovery →
 * overrides → resolveStepModel → renderAgentsListing → sendMessage.
 *
 * The environment is fully sandboxed via PI_CODING_AGENT_DIR and
 * PI_HERDR_SUBAGENTS_EXTRA_AGENT_DIRS, so a stray ~/.pi on the host cannot
 * leak agents or settings into the listing.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import herdrSubagents from "../../index.ts";
import { FakeSupervisor } from "../helpers/fake-supervisor.ts";
import {
	parseAgentsScopeArg,
	createAgentsCommand,
	renderAgentsListing,
	type AgentsCommandDeps,
} from "../../src/extension/slash.ts";
import type { AgentConfig } from "../../src/shared/types.ts";

interface SentMessage {
	customType: string;
	content: string;
}

interface RegisteredCommand {
	name: string;
	handler: (args: string, ctx: unknown) => Promise<void>;
	description?: string;
	getArgumentCompletions?: (prefix: string) => unknown;
}

/** Minimal ExtensionAPI stand-in: captures commands and outgoing messages. */
function fakePi() {
	const commands: RegisteredCommand[] = [];
	const messages: SentMessage[] = [];
	return {
		commands,
		messages,
		// pi's contract: registerCommand(name, options).
		registerCommand(name: string, options: Omit<RegisteredCommand, "name">) {
			commands.push({ name, ...options });
		},
		registerTool() {},
		registerMessageRenderer() {},
		on() {},
		sendMessage(message: SentMessage) {
			messages.push(message);
		},
		eventsBus: { emit() {} },
	};
}

type FakePi = ReturnType<typeof fakePi>;

/**
 * Sandbox the environment around one interaction with the extension:
 * temp PI_CODING_AGENT_DIR (settings.json), extra agent dir, fake herdr.
 */
async function withSandbox(
	params: {
		settings?: Record<string, unknown>;
		extraAgents?: Record<string, string>;
		projectAgents?: Record<string, string>;
	},
	run: (helpers: {
		pi: FakePi;
		messages: SentMessage[];
		projectRoot: string;
	}) => Promise<void>,
): Promise<void> {
	const dir = mkdtempSync(path.join(tmpdir(), "agents-listing-"));
	const previous = {
		child: process.env.PI_SUBAGENT_CHILD,
		extra: process.env.PI_HERDR_SUBAGENTS_EXTRA_AGENT_DIRS,
		agentDir: process.env.PI_CODING_AGENT_DIR,
		team: process.env.PI_SUBAGENTS_TEAM,
	};
	try {
		// The tool is not registered inside a child process, and an ambient team
		// must not alter the independently sandboxed catalog under test.
		delete process.env.PI_SUBAGENT_CHILD;
		delete process.env.PI_SUBAGENTS_TEAM;

		const agentDir = path.join(dir, "agentdir");
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(
			path.join(agentDir, "settings.json"),
			JSON.stringify({ subagents: params.settings ?? {} }),
		);
		process.env.PI_CODING_AGENT_DIR = agentDir;

		// The extra dir loads at user precedence. The real ~/.pi/agent/agents is
		// still consulted after it — sandboxing HOME is not portable — so these
		// tests assert on the sandboxed roles only (extra + project + builtin),
		// never on the absence of host roles.
		const extra = path.join(dir, "extra-agents");
		mkdirSync(extra, { recursive: true });
		for (const [file, frontmatter] of Object.entries(params.extraAgents ?? {})) {
			writeFileSync(path.join(extra, file), frontmatter);
		}
		process.env.PI_HERDR_SUBAGENTS_EXTRA_AGENT_DIRS = extra;

		const projectRoot = path.join(dir, "project");
		mkdirSync(projectRoot, { recursive: true });
		const projectAgents = path.join(projectRoot, ".pi", "agents");
		mkdirSync(projectAgents, { recursive: true });
		for (const [file, frontmatter] of Object.entries(
			params.projectAgents ?? {},
		)) {
			writeFileSync(path.join(projectAgents, file), frontmatter);
		}

		const pi = fakePi();
		herdrSubagents(pi as never, { supervisor: new FakeSupervisor() });
		await run({ pi, messages: pi.messages, projectRoot });
	} finally {
		if (previous.child === undefined) delete process.env.PI_SUBAGENT_CHILD;
		else process.env.PI_SUBAGENT_CHILD = previous.child;
		if (previous.extra === undefined)
			delete process.env.PI_HERDR_SUBAGENTS_EXTRA_AGENT_DIRS;
		else process.env.PI_HERDR_SUBAGENTS_EXTRA_AGENT_DIRS = previous.extra;
		if (previous.agentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous.agentDir;
		if (previous.team === undefined) delete process.env.PI_SUBAGENTS_TEAM;
		else process.env.PI_SUBAGENTS_TEAM = previous.team;
		rmSync(dir, { recursive: true, force: true });
	}
}

/** The single `/legion` command as registered by the extension. */
function findCommand(pi: FakePi): RegisteredCommand {
	const command = pi.commands.find((c) => c.name === "legion");
	assert.ok(command, "legion command must be registered");
	return command;
}

/** Run the command; returns the sent slash-text content. */
async function invoke(
	pi: FakePi,
	args: string,
	cwd: string,
): Promise<string | undefined> {
	const command = findCommand(pi);
	pi.messages.length = 0;
	await command.handler(`agents ${args}`.trim(), {
		cwd,
		hasUI: false,
		ui: { notify() {} },
	} as never);
	return pi.messages.find((m) => typeof m.content === "string")?.content;
}

// ────────────────────── arg parsing ──────────────────────

test("parseAgentsScopeArg: empty → default (undefined)", () => {
	assert.deepEqual(parseAgentsScopeArg("", "usage"), {
		ok: true,
		scope: undefined,
	});
	assert.deepEqual(parseAgentsScopeArg("   ", "usage"), {
		ok: true,
		scope: undefined,
	});
});

test("parseAgentsScopeArg: accepts the three scopes", () => {
	for (const scope of ["user", "project", "both"] as const) {
		assert.deepEqual(parseAgentsScopeArg(scope, "usage"), {
			ok: true,
			scope,
		});
	}
});

test("parseAgentsScopeArg: rejects junk and extra tokens", () => {
	assert.deepEqual(parseAgentsScopeArg("banana", "usage"), {
		ok: false,
		message: "usage",
	});
	assert.deepEqual(parseAgentsScopeArg("user project", "usage"), {
		ok: false,
		message: "usage",
	});
});

// ────────────────────── renderAgentsListing (pure) ──────────────────────

function stubAgent(over: Partial<AgentConfig>): AgentConfig {
	return {
		name: "stub",
		description: "a stub",
		kind: "pi",
		systemPromptMode: "replace",
		inheritProjectContext: true,
		inheritSkills: false,
		systemPrompt: "",
		source: "builtin",
		filePath: "/tmp/agents/stub.md",
		...over,
	};
}

test("renderAgentsListing: groups by source with counts", () => {
	const text = renderAgentsListing({
		agents: [
			stubAgent({ name: "worker", source: "builtin" }),
			stubAgent({ name: "scout", source: "builtin" }),
			stubAgent({ name: "search", source: "user" }),
			stubAgent({ name: "deploy", source: "project" }),
		],
		scope: "both",
		projectAgentsDir: "/repo/.pi/agents",
		builtinAgentsDir: "/pkg/agents",
		settings: {},
	});
	assert.match(text, /^Subagent roles\nScope: both/);
	assert.match(text, /builtin \(2\)/);
	assert.match(text, /user \(1\)/);
	assert.match(text, /project \(1\)/);
	// builtin group before user before project
	const order = [
		text.indexOf("builtin (2)"),
		text.indexOf("user (1)"),
		text.indexOf("project (1)"),
	];
	assert.deepEqual([...order].sort((a, b) => a - b), order);
	// trailing directory block
	assert.match(
		text,
		/Directories\n {2}builtin: \/pkg\/agents\n {2}user: ~\/\.pi\/agent\/agents\n {2}project: \/repo\/\.pi\/agents/,
	);
});

test("renderAgentsListing: user dir shows the resolved path and scope skips it", () => {
	const text = renderAgentsListing({
		agents: [stubAgent({ name: "x", source: "user" })],
		scope: "user",
		projectAgentsDir: null,
		builtinAgentsDir: "/pkg/agents",
		userAgentsDir: "/custom/agents-dir",
		settings: {},
	});
	// The RESOLVED user dir, not a hardcoded ~ literal.
	assert.match(text, / {2}user: \/custom\/agents-dir/);

	const skipped = renderAgentsListing({
		agents: [],
		scope: "project",
		projectAgentsDir: "/repo/.pi/agents",
		builtinAgentsDir: "/pkg/agents",
		userAgentsDir: undefined,
		settings: {},
	});
	assert.match(skipped, / {2}user: ~\/\.pi\/agent\/agents \(skipped by scope\)/);
});

test("renderAgentsListing: empty listing explains where to add agents", () => {
	const text = renderAgentsListing({
		agents: [],
		scope: "user",
		projectAgentsDir: null,
		builtinAgentsDir: "/pkg/agents",
		settings: {},
	});
	assert.match(text, /No agents found\. Add definitions to/);
	assert.match(text, /project: \(none found\)/);
});

test("renderAgentsListing: flags disableBuiltins", () => {
	const text = renderAgentsListing({
		agents: [stubAgent({ name: "x", source: "user" })],
		scope: "user",
		projectAgentsDir: null,
		builtinAgentsDir: "/pkg/agents",
		settings: { disableBuiltins: true },
	});
	assert.match(text, /builtin layer disabled by subagents\.disableBuiltins/);
});

test("renderAgentsListing: model line reports the resolved model + provenance", () => {
	const text = renderAgentsListing({
		agents: [stubAgent({ name: "scout", model: "cb/flash" })],
		scope: "user",
		projectAgentsDir: null,
		builtinAgentsDir: "/pkg/agents",
		settings: {},
	});
	// Launch-path labels (`classifyModelOrigin`): frontmatter is "the agent's frontmatter".
	assert.match(text, /model: cb\/flash \(the agent's frontmatter\)/);
	assert.match(text, /file: \/tmp\/agents\/stub\.md/);
});

test("renderAgentsListing: no model anywhere → agent CLI default", () => {
	const text = renderAgentsListing({
		agents: [stubAgent({ name: "free", kind: "cursor" })],
		scope: "user",
		projectAgentsDir: null,
		builtinAgentsDir: "/pkg/agents",
		settings: {},
	});
	// kind=cursor is surfaced, and no model resolves
	assert.match(text, /kind=cursor/);
	assert.match(text, /model: \(agent CLI default\)/);
});

test("renderAgentsListing: parent model fall-through is labelled parent session model, never per-run override", () => {
	const text = renderAgentsListing({
		agents: [stubAgent({ name: "free" })],
		scope: "user",
		projectAgentsDir: null,
		builtinAgentsDir: "/pkg/agents",
		settings: {},
		dispatchModel: "cb/kimi-k3",
	});
	// The command passes empty step/params, so a dispatch-fall-through can
	// ONLY be the parent's model — the label must say so (launch parity with
	// classifyModelOrigin, which distinguishes exactly this case).
	assert.match(text, /model: cb\/kimi-k3 \(the parent session model\)/);
	assert.doesNotMatch(text, /per-run override/);
});

test("renderAgentsListing: modelScope violation — explicit model is a launch refusal", () => {
	const text = renderAgentsListing({
		agents: [stubAgent({ name: "pinned", model: "cb/glm-5.3" })],
		scope: "user",
		projectAgentsDir: null,
		builtinAgentsDir: "/pkg/agents",
		settings: {
			modelScope: { enforce: true, allow: ["cb/kimi-*"] },
		},
	});
	assert.match(text, /model: cb\/glm-5\.3 \(the agent's frontmatter\)/);
	assert.match(text, /✗ outside model scope — a launch would refuse this/);
});

test("renderAgentsListing: modelScope violation — inherited model is a warning", () => {
	const text = renderAgentsListing({
		agents: [stubAgent({ name: "free" })],
		scope: "user",
		projectAgentsDir: null,
		builtinAgentsDir: "/pkg/agents",
		settings: {
			modelScope: { enforce: true, allow: ["cb/kimi-*"] },
		},
		dispatchModel: "cb/glm-5.3",
	});
	assert.match(text, /⚠ outside model scope — a launch would warn/);
});

test("renderAgentsListing: explicit pi-shaped model on a cursor role is a launch refusal", () => {
	const text = renderAgentsListing({
		agents: [
			stubAgent({ name: "websearch", kind: "cursor", model: "cb/kimi-k3" }),
		],
		scope: "user",
		projectAgentsDir: null,
		builtinAgentsDir: "/pkg/agents",
		settings: {},
	});
	// `planModelCandidates` refuses an explicit model the kind cannot express.
	assert.match(
		text,
		/✗ cannot be used with kind 'cursor' — a launch would refuse this/,
	);
});

test("renderAgentsListing: inherited pi-shaped model on a cursor role is a documented drop", () => {
	const text = renderAgentsListing({
		agents: [stubAgent({ name: "websearch", kind: "cursor" })],
		scope: "user",
		projectAgentsDir: null,
		builtinAgentsDir: "/pkg/agents",
		settings: {},
		dispatchModel: "cb/kimi-k3",
	});
	// The launch path drops the model and warns; the child runs on the CLI default.
	assert.match(
		text,
		/dropped at launch: kind 'cursor' runs on its own default/,
	);
});

test("renderAgentsListing: unresolvable configuration is reported, not guessed", () => {
	// A preset that does not exist would make a launch refuse; the listing
	// must say so instead of showing a made-up model.
	const text = renderAgentsListing({
		agents: [stubAgent({ name: "broken", preset: "nonexistent" })],
		scope: "user",
		projectAgentsDir: null,
		builtinAgentsDir: "/pkg/agents",
		settings: {},
	});
	assert.match(text, /unresolvable/);
});

test("renderAgentsListing: alias and unenforced fields are surfaced", () => {
	const text = renderAgentsListing({
		agents: [
			stubAgent({
				name: "multi",
				alias: ["foo", "bar"],
				unenforcedFields: ["toolBudget"],
			}),
		],
		scope: "user",
		projectAgentsDir: null,
		builtinAgentsDir: "/pkg/agents",
		settings: {},
	});
	assert.match(text, /alias: foo, bar/);
	assert.match(text, /⚠ not enforced yet: toolBudget/);
});

// ────────────────────── command wiring (real factory) ──────────────────────

test("/legion is the sole slash command and offers unified subcommand completions", async () => {
	await withSandbox({ settings: { teams: { frontend: { members: ["worker"] } } } }, async ({ pi }) => {
		const command = findCommand(pi);
		assert.deepEqual(pi.commands.map((entry) => entry.name), ["legion"]);
		assert.ok(command.description?.includes("manage teams"));
		assert.deepEqual(command.getArgumentCompletions?.("agents "), [
			{ value: "agents user", label: "user" },
			{ value: "agents project", label: "project" },
			{ value: "agents both", label: "both" },
		]);
		assert.deepEqual(command.getArgumentCompletions?.("agents pr"), [
			{ value: "agents project", label: "project" },
		]);
		assert.equal(command.getArgumentCompletions?.("agents user x"), null);
		assert.deepEqual(command.getArgumentCompletions?.("team "), [
			{ value: "team list", label: "list" },
			{ value: "team use", label: "use" },
			{ value: "team create", label: "create" },
		]);
		assert.deepEqual(command.getArgumentCompletions?.("team use f"), [
			{ value: "team use frontend", label: "frontend" },
		]);
		assert.deepEqual(command.getArgumentCompletions?.("summary --"), [
			{ value: "summary --all", label: "--all" },
		]);
		assert.deepEqual(command.getArgumentCompletions?.("o"), [
			{ value: "on", label: "on" },
			{ value: "off", label: "off" },
		]);
		await command.handler("help", {
			cwd: process.cwd(),
			hasUI: false,
			ui: { notify() {} },
		} as never);
		const help = pi.messages.at(-1)?.content;
		assert.match(help ?? "", /\/legion team/);
		assert.match(help ?? "", /\/legion summary/);
		await command.handler("team list", {
			cwd: process.cwd(),
			hasUI: false,
			ui: { notify() {} },
		} as never);
		assert.match(pi.messages.at(-1)?.content ?? "", /Subagent teams/);
		await command.handler("summary --bogus", {
			cwd: process.cwd(),
			hasUI: false,
			ui: { notify(text: string) { assert.match(text, /Usage: \/legion summary/); } },
		} as never);
		await command.handler("off", {
			cwd: process.cwd(),
			hasUI: false,
			ui: { notify() {} },
		} as never);
		assert.match(pi.messages.at(-1)?.content ?? "", /Subagents are disabled/);
		await command.handler("on", {
			cwd: process.cwd(),
			hasUI: false,
			ui: { notify() {} },
		} as never);
		assert.match(pi.messages.at(-1)?.content ?? "", /Subagents are enabled/);
	});
});

test("command: lists sandboxed + builtin roles, grouped, with file paths", async () => {
	await withSandbox(
		{
			extraAgents: {
				"search.md":
					"---\nname: search\ndescription: web and code search\ncolor: blue\n---\np",
			},
			projectAgents: {
				"deploy.md": "---\nname: deploy\ndescription: deploys things\n---\np",
			},
		},
		async ({ pi, projectRoot }) => {
			const text = await invoke(pi, "both", projectRoot);
			assert.ok(text, "a slash text message must be sent");
			assert.match(text, /^Subagent roles\nScope: both/);
			// The project role is present with its group header…
			assert.match(text, /project \(1\)/);
			assert.match(text, /  deploy\n    deploys things/);
			assert.match(text, /file: .*deploy\.md/);
			// …the sandboxed user-level role…
			assert.match(text, /  search\n    web and code search/);
			// …and the bundled roles still load.
			assert.match(text, /builtin \(8\)/);
			assert.match(text, /  worker\n/);
			// The project directory points at the temp project.
			assert.match(text, new RegExp(`project: .*${path.basename(projectRoot)}`));
		},
	);
});

test("command: scope=project skips user layers but keeps builtin roles", async () => {
	await withSandbox(
		{
			extraAgents: {
				"search.md": "---\nname: search\ndescription: s\n---\np",
			},
			projectAgents: {
				"deploy.md": "---\nname: deploy\ndescription: d\n---\np",
			},
		},
		async ({ pi, projectRoot }) => {
			const text = await invoke(pi, "project", projectRoot);
			assert.ok(text);
			assert.match(text, /Scope: project/);
			assert.match(text, /  deploy\n/);
			// user-layer roles from the extra dir are not in the listing…
			assert.doesNotMatch(text, /  search\n/);
			// …but the bundled roles are scope-independent (same as the tool's
			// agentScope semantics: `project` skips user dirs only).
			assert.match(text, /  worker\n/);
			// The user group only appears when a user-layer role exists.
			assert.doesNotMatch(text, /user \(/);
		},
	);
});

test("command: invalid scope notifies an error and sends nothing", async () => {
	await withSandbox(
		{},
		async ({ pi, messages, projectRoot }) => {
			const notified: Array<{ text: string; level: string }> = [];
			const command = findCommand(pi);
			await command.handler("agents banana", {
				cwd: projectRoot,
				hasUI: false,
				ui: {
					notify(text: string, level: string) {
						notified.push({ text, level });
					},
				},
				} as never);
			assert.equal(messages.length, 0);
			assert.equal(notified.length, 1);
			assert.equal(notified[0]?.level, "error");
			assert.match(notified[0]?.text ?? "", /Usage: \/legion agents/);
		},
	);
});

test("command: settings flow through — override model + disableBuiltins", async () => {
	await withSandbox(
		{
			settings: {
				disableBuiltins: true,
				agentOverrides: {
					search: { model: "cb/glm-5.3" },
				},
			},
			extraAgents: {
				"search.md": "---\nname: search\ndescription: s\n---\np",
			},
		},
		async ({ pi, projectRoot }) => {
			const text = await invoke(pi, "", projectRoot);
			assert.ok(text);
			// default scope when the arg is omitted
			assert.match(text, /Scope: user/);
			// the override model resolved with agentOverrides provenance
			assert.match(text, /model: cb\/glm-5\.3 \(agentOverrides\)/);
			// builtin layer gone, and the listing says why
			assert.doesNotMatch(text, /  worker\n/);
			assert.match(text, /builtin layer disabled by subagents\.disableBuiltins/);
		},
	);
});

test("command: no roles at all → helpful empty state", async () => {
	await withSandbox(
		{ settings: { disableBuiltins: true } },
		async ({ pi, projectRoot }) => {
			const text = await invoke(pi, "", projectRoot);
			assert.ok(text);
			assert.match(text, /No agents found\. Add definitions to/);
		},
	);
});

// ────────────────────── dep contract ──────────────────────

test("command: a loadCatalog failure surfaces as ui.notify error, nothing sent", async () => {
	// e.g. malformed settings.json → loadSubagentSettings throws inside
	// loadCatalog. The handler must route that to notifyError, not crash.
	const messages: SentMessage[] = [];
	const pi = {
		sendMessage(message: SentMessage) {
			messages.push(message);
		},
	};
	const command = createAgentsCommand(pi as never, {
		loadCatalog: () => {
			throw new Error("Invalid JSON in 'settings.json': boom");
		},
	});
	const notified: Array<{ text: string; level: string }> = [];
	await command.handler("", {
		cwd: "/repo",
		hasUI: false,
		ui: {
			notify(text: string, level?: "error" | "info" | "warning") {
				notified.push({ text, level: level ?? "info" });
			},
		},
	} as never);
	assert.equal(messages.length, 0, "no listing must be sent on failure");
	assert.equal(notified.length, 1);
	assert.equal(notified[0]?.level, "error");
	assert.match(notified[0]?.text ?? "", /Invalid JSON/);
});

test("AgentsCommandDeps: loadCatalog receives the parsed scope untouched", async () => {
	const seen: Array<{ sessionCwd: string; scope?: string }> = [];
	const deps: AgentsCommandDeps = {
		loadCatalog: (input) => {
			seen.push({ sessionCwd: input.sessionCwd, scope: input.scope });
			return {
				agents: [],
				settings: {},
				projectAgentsDir: null,
				builtinAgentsDir: "/pkg/agents",
			};
		},
	};
	// Drive through a fake pi registering ONLY the agents command.
	const command = createAgentsCommand({ sendMessage() {} } as never, deps);
	await command.handler("project", {
		cwd: "/repo",
		hasUI: false,
		ui: { notify() {} },
	} as never);
	assert.deepEqual(seen, [{ sessionCwd: "/repo", scope: "project" }]);
});
