import { after, test } from "node:test";
import assert from "node:assert/strict";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import type { AgentConfig, SubagentsSettings } from "../../src/shared/types.ts";
import {
	applyTeam,
	DEFAULT_TEAM,
	listTeamNames,
	resolveActiveTeamName,
	TEAM_ENV,
} from "../../src/agents/teams.ts";
import {
	parseSubagentSettings,
	resolveSubagentSettings,
} from "../../src/agents/settings.ts";
import {
	parseTeamCommandArgs,
	createTeamCommand,
	renderAgentsListing,
	updateSubagentSettingsFile,
} from "../../src/extension/slash.ts";
import { formatAgentRoster } from "../../src/agents/agents.ts";
import {
	loadCatalog,
	renderAgentList,
	renderParentRoster,
	unknownAgentLine,
	unknownAgentLineForCatalog,
	waitAction,
} from "../../index.ts";
import { createSessionRuntime, type WaitResult } from "../../src/extension/runtime.ts";
import { RunStore } from "../../src/runs/store.ts";
import { FakeSupervisor } from "../helpers/fake-supervisor.ts";
import piLegion from "../../index.ts";

const savedTeamEnv = process.env[TEAM_ENV];
delete process.env[TEAM_ENV];
after(() => {
	if (savedTeamEnv === undefined) delete process.env[TEAM_ENV];
	else process.env[TEAM_ENV] = savedTeamEnv;
});

function agent(name: string, over: Partial<AgentConfig> = {}): AgentConfig {
	return {
		name,
		description: name,
		systemPromptMode: "replace",
		inheritProjectContext: true,
		inheritSkills: false,
		kind: "pi",
		systemPrompt: "",
		source: "user",
		filePath: `/${name}.md`,
		...over,
	};
}

function restoreEnv(name: string, previous: string | undefined): void {
	if (previous === undefined) delete process.env[name];
	else process.env[name] = previous;
}

function withTeamSettings(
	overrides: Partial<SubagentsSettings> = {},
): SubagentsSettings {
	return {
		teams: {
			frontend: { description: "front end", members: ["designer", "worker"] },
		},
		...overrides,
	};
}

test("teams: environment wins over settings, then default", () => {
	assert.deepEqual(resolveActiveTeamName({}, {}), {
		name: DEFAULT_TEAM,
		source: "default",
	});
	assert.deepEqual(resolveActiveTeamName({ team: "frontend" }, {}), {
		name: "frontend",
		source: "settings",
	});
	assert.deepEqual(
		resolveActiveTeamName(
			{ team: "frontend" },
			{ [TEAM_ENV]: "  backend  " },
		),
		{ name: "backend", source: "env" },
	);
	assert.deepEqual(
		resolveActiveTeamName({ team: "frontend" }, { [TEAM_ENV]: "   " }),
		{ name: "frontend", source: "settings" },
	);
});

test("teams: default returns the exact input array", () => {
	const agents = [agent("worker")];
	const result = applyTeam(agents, {}, {});
	assert.equal(result.agents, agents);
	assert.deepEqual(result.team, { name: "default", source: "default" });
	assert.deepEqual(result.warnings, []);
});

test("teams: members preserve first-seen order and warnings are exact", () => {
	const agents = [agent("designer"), agent("worker")];
	const result = applyTeam(
		agents,
		{
			team: "frontend",
			teams: {
				frontend: {
					members: ["worker", "missing", "designer", "missing"],
				},
			},
		},
		{},
	);
	assert.deepEqual(result.agents.map((entry) => entry.name), ["worker", "designer"]);
	assert.deepEqual(result.warnings, [
		'Subagent team "frontend" references missing agent "missing"; skipped.',
		'Subagent team "frontend" references missing agent "missing"; skipped.',
	]);
});

test("teams: star expands each role once and later object overrides win", () => {
	const agents = [
		agent("designer", { model: "old-designer" }),
		agent("worker", { model: "old-worker" }),
		agent("reviewer", { model: "old-reviewer" }),
	];
	const result = applyTeam(
		agents,
		{
			team: "full",
			teams: {
				full: {
					members: ["worker", "*", { agent: "worker", model: "new-worker" }],
				},
			},
		},
		{},
	);
	assert.deepEqual(result.agents.map((entry) => entry.name), [
		"worker",
		"designer",
		"reviewer",
	]);
	assert.equal(result.agents[0]?.model, "new-worker");
	assert.equal(result.agents[1]?.model, "old-designer");
	assert.deepEqual(result.warnings, []);
});

test("teams: a later member or star restores a role removed by disabled", () => {
	const agents = [agent("worker"), agent("reviewer")];
	const afterExplicitMention = applyTeam(
		agents,
		{
			team: "restore",
			teams: {
				restore: {
					members: [
						"worker",
					{ agent: "worker", disabled: true },
					"reviewer",
					"worker",
				],
				},
			},
		},
		{},
	);
	assert.deepEqual(afterExplicitMention.agents.map((entry) => entry.name), [
		"reviewer",
		"worker",
	]);

	const afterWildcard = applyTeam(
		agents,
		{
			team: "restore",
			teams: {
				restore: {
					members: ["*", { agent: "worker", disabled: true }, "*"],
				},
			},
		},
		{},
	);
	assert.deepEqual(afterWildcard.agents.map((entry) => entry.name), [
		"reviewer",
		"worker",
	]);
});

test('teams: object member agent:"*" is not a wildcard and warns as a missing role', () => {
	const agents = [agent("worker")];
	const settings = parseSubagentSettings(
		{ subagents: { team: "literal", teams: { literal: { members: [{ agent: "*" }] } } } },
		"/settings.json",
	);
	const result = applyTeam(agents, settings, {});
	assert.deepEqual(result.agents, []);
	assert.deepEqual(result.warnings, [
		'Subagent team "literal" references missing agent "*"; skipped.',
	]);
});

test("teams: undefined constructor selection warns and returns the full catalog", () => {
	const agents = [agent("worker")];
	const result = applyTeam(agents, {}, { [TEAM_ENV]: "constructor" });
	assert.equal(result.agents, agents);
	assert.deepEqual(result.team, { name: "constructor", source: "env" });
	assert.deepEqual(result.warnings, [
		'Subagent team "constructor" is not defined; using all agents. Available teams: default.',
	]);
});

test("teams: configured constructor key is an own, usable team name", () => {
	const doc = JSON.parse(
		'{"subagents":{"team":"constructor","teams":{"constructor":{"members":["worker"]}}}}',
	) as Record<string, unknown>;
	const settings = parseSubagentSettings(doc, "/constructor.json");
	assert.equal(Object.getPrototypeOf(settings.teams), null);
	assert.equal(Object.hasOwn(settings.teams ?? {}, "constructor"), true);
	const result = applyTeam([agent("worker")], settings, {});
	assert.deepEqual(result.agents.map((entry) => entry.name), ["worker"]);
	assert.deepEqual(result.warnings, []);
});

test("teams: missing active name falls back to all roles with exact warning", () => {
	const agents = [agent("worker")];
	const result = applyTeam(
		agents,
		{ team: "missing", teams: { frontend: { members: ["worker"] } } },
		{},
	);
	assert.equal(result.agents, agents);
	assert.deepEqual(result.warnings, [
		'Subagent team "missing" is not defined; using all agents. Available teams: default, frontend.',
	]);
});

test("teams: list puts default first and keeps configured insertion order", () => {
	assert.deepEqual(
		listTeamNames({
			teams: { z: { members: ["worker"] }, a: { members: ["worker"] } },
		}),
		["default", "z", "a"],
	);
});

test("settings: project team entries replace same names; absent project teams keep user teams", () => {
	const user = parseSubagentSettings(
		{
			subagents: {
				team: "user-team",
				teams: {
					shared: { description: "user", members: ["worker"] },
					userOnly: { members: ["worker"] },
				},
			},
		},
		"/user/settings.json",
	);
	const project = parseSubagentSettings(
		{
			subagents: {
				team: "project-team",
				teams: {
					shared: { description: "project", members: ["designer"] },
					projectOnly: { members: ["designer"] },
				},
			},
		},
		"/project/settings.json",
	);
	const merged = resolveSubagentSettings(user, project);
	assert.equal(merged.team, "project-team");
	assert.deepEqual(merged.teams?.shared, {
		description: "project",
		members: ["designer"],
	});
	assert.deepEqual(Object.keys(merged.teams ?? {}).sort(), [
		"projectOnly",
		"shared",
		"userOnly",
	]);

	const noProjectTeams = resolveSubagentSettings(user, { defaultModel: "project/model" });
	assert.equal(noProjectTeams.team, "user-team");
	assert.deepEqual(noProjectTeams.teams?.userOnly, { members: ["worker"] });
});

test("settings: team structure, description, reserved names, and member override types validate", () => {
	for (const [teams, pattern] of [
		[[], /invalid 'teams';/],
		["not an object", /invalid 'teams';/],
		[null, /invalid 'teams';/],
		[{ frontend: [] }, /invalid 'teams\.frontend';/],
		[{ frontend: {} }, /invalid 'teams\.frontend\.members';/],
		[{ frontend: { members: [] } }, /invalid 'teams\.frontend\.members';/],
		[{ frontend: { description: 5, members: ["worker"] } }, /invalid 'teams\.frontend\.description';/],
	] as const) {
		assert.throws(
			() => parseSubagentSettings({ subagents: { teams } }, "/settings.json"),
			pattern,
		);
	}
	assert.throws(
		() =>
			parseSubagentSettings(
				{ subagents: { teams: { default: { members: ["worker"] } } } },
				"/settings.json",
			),
		/teams\.default/,
	);
	const protoDoc = JSON.parse(
		'{"subagents":{"teams":{"__proto__":{"members":["worker"]}}}}',
	) as Record<string, unknown>;
	assert.throws(
		() => parseSubagentSettings(protoDoc, "/unsafe/settings.json"),
		/Subagent settings in '\/unsafe\/settings\.json' have invalid 'teams\.__proto__'/,
	);
	assert.throws(
		() => parseSubagentSettings({ subagents: { team: "  " } }, "/settings.json"),
		/team/,
	);
	for (const [member, field] of [
		[{ agent: "worker", model: 5, disabled: "yes" }, "model"],
		[{ agent: "worker", disabled: "yes" }, "disabled"],
		[{ agent: "worker", tools: 5 }, "tools"],
	] as const) {
		assert.throws(
			() =>
				parseSubagentSettings(
					{ subagents: { teams: { frontend: { members: [member] } } } },
					"/settings.json",
				),
			new RegExp(`teams\\.frontend\\.members\\[0\\]\\.${field}`),
		);
	}
});

test("slash: team argument boundaries reject malformed and extra tokens", () => {
	for (const args of [
		"use a b",
		"use x --global --global",
		"--global --global",
		"create x",
		"unknown x",
		"list extra",
		"use --global",
	]) {
		assert.equal(parseTeamCommandArgs(args).ok, false, args);
	}
	assert.deepEqual(parseTeamCommandArgs(""), {
		ok: true,
		value: { action: "show" },
	});
	assert.deepEqual(parseTeamCommandArgs("list"), {
		ok: true,
		value: { action: "list" },
	});
	assert.deepEqual(parseTeamCommandArgs("use frontend --global"), {
		ok: true,
		value: { action: "use", name: "frontend", global: true },
	});
	assert.deepEqual(parseTeamCommandArgs("create frontend designer, worker"), {
		ok: true,
		value: {
			action: "create",
			name: "frontend",
			members: ["designer", "worker"],
			global: false,
		},
	});
	assert.equal(parseTeamCommandArgs("create frontend worker,").ok, false);
});

test("slash: settings writer preserves unrelated keys", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "teams-settings-"));
	try {
		const file = path.join(dir, ".pi", "settings.json");
		mkdirSync(path.dirname(file), { recursive: true });
		writeFileSync(
			file,
			JSON.stringify({ unrelated: 1, subagents: { defaultModel: "cb/x" } }),
		);
		updateSubagentSettingsFile(file, (subagents) => {
			subagents.team = "frontend";
			const teams = (subagents.teams ?? {}) as Record<string, unknown>;
			teams.frontend = { members: ["worker"] };
			subagents.teams = teams;
		});
		const saved = JSON.parse(readFileSync(file, "utf8")) as Record<string, any>;
		assert.equal(saved.unrelated, 1);
		assert.equal(saved.subagents.defaultModel, "cb/x");
		assert.equal(saved.subagents.team, "frontend");
		assert.deepEqual(saved.subagents.teams.frontend.members, ["worker"]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

interface TeamCommandHarness {
	messages: Array<{ content: string }>;
	notifications: Array<{ message: string; level: string }>;
	invoke(args: string, cwd: string): Promise<void>;
}

function teamCommandHarness(
	catalog: {
		agents: AgentConfig[];
		allAgents: AgentConfig[];
		settings: SubagentsSettings;
		team: { name: string; source: "env" | "settings" | "default" };
		teamWarnings: string[];
	},
): TeamCommandHarness {
	const messages: Array<{ content: string }> = [];
	const notifications: Array<{ message: string; level: string }> = [];
	let handler: ((args: string, ctx: any) => Promise<void>) | undefined;
	const pi = {
		registerCommand(_name: string, options: { handler: typeof handler }) {
			handler = options.handler;
		},
		sendMessage(message: { content: string }) {
			messages.push(message);
		},
	} as never;
	const command = createTeamCommand(pi, { loadCatalog: () => catalog });
	handler = command.handler;
	return {
		messages,
		notifications,
		async invoke(args, cwd) {
			assert.ok(handler);
			await handler(args, {
				cwd,
				hasUI: false,
				ui: {
				notify(message: string, level: string) {
					notifications.push({ message, level });
				},
				},
			});
		},
	};
}

const commandCatalog = (settings: SubagentsSettings = {
	teams: { frontend: { members: ["worker"] } },
}) => ({
	agents: [agent("worker")],
	allAgents: [agent("worker")],
	settings,
	team: { name: "frontend", source: "settings" as const },
	teamWarnings: [],
});

test("slash: use/create success messages are exact and environment override is disclosed", async () => {
	const dir = mkdtempSync(path.join(tmpdir(), "teams-command-success-"));
	const previousTeam = process.env[TEAM_ENV];
	try {
		const settingsPath = path.join(dir, ".pi", "settings.json");
		mkdirSync(path.dirname(settingsPath), { recursive: true });
		writeFileSync(
			settingsPath,
			JSON.stringify({ keep: { value: true }, subagents: { defaultModel: "cb/x" } }),
		);
		const harness = teamCommandHarness(commandCatalog());
		process.env[TEAM_ENV] = "frontend";
		await harness.invoke("use frontend", dir);
		await harness.invoke("create backend worker", dir);
		assert.deepEqual(harness.notifications, []);
		assert.deepEqual(harness.messages.map((message) => message.content), [
			`Subagent team set to "frontend" in ${settingsPath}. Environment ${TEAM_ENV} is set and overrides this setting. Next prompt will use it.`,
			"Created subagent team backend. Select it with /legion team use backend",
		]);
		const saved = JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, any>;
		assert.deepEqual(saved.keep, { value: true });
		assert.equal(saved.subagents.defaultModel, "cb/x");
		assert.equal(saved.subagents.team, "frontend");
		assert.deepEqual(saved.subagents.teams.backend.members, ["worker"]);
	} finally {
		restoreEnv(TEAM_ENV, previousTeam);
		rmSync(dir, { recursive: true, force: true });
	}
});

test("slash: unknown, reserved, and existing teams error without changing file bytes", async () => {
	const dir = mkdtempSync(path.join(tmpdir(), "teams-command-errors-"));
	try {
		const settingsPath = path.join(dir, ".pi", "settings.json");
		mkdirSync(path.dirname(settingsPath), { recursive: true });
		const initial = '{"keep":1,"subagents":{"teams":{"fileOnly":{"members":["worker"]}}}}';
		writeFileSync(settingsPath, initial);
		const harness = teamCommandHarness(commandCatalog());
		for (const [args, expected] of [
			["use missing", 'Unknown team "missing"'],
			["create default worker", 'Team name "default" is reserved'],
			["create frontend worker", 'Team "frontend" already exists'],
			["create fileOnly worker", 'Team "fileOnly" already exists'],
		] as const) {
			await harness.invoke(args, dir);
			assert.ok(harness.notifications.at(-1)?.message.includes(expected), args);
			assert.equal(harness.notifications.at(-1)?.level, "error", args);
			assert.equal(readFileSync(settingsPath, "utf8"), initial, args);
		}
		assert.deepEqual(harness.messages, []);
		assert.deepEqual(
			harness.notifications.map(({ message, level }) => {
				assert.equal(level, "error");
				return message;
			}),
			[
				'Unknown team "missing". Available: default, frontend.',
				'Team name "default" is reserved.',
				'Team "frontend" already exists; edit it manually instead.',
				'Team "fileOnly" already exists; edit it manually instead.',
			],
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("slash: --global use/create update temporary user settings only", async () => {
	const dir = mkdtempSync(path.join(tmpdir(), "teams-command-global-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	try {
		const agentDir = path.join(dir, "user-agent-dir");
		process.env.PI_CODING_AGENT_DIR = agentDir;
		const project = path.join(dir, "project");
		mkdirSync(project, { recursive: true });
		const harness = teamCommandHarness(commandCatalog());
		await harness.invoke("use frontend --global", project);
		await harness.invoke("create backend worker --global", project);
		const userSettingsPath = path.join(agentDir, "settings.json");
		assert.equal(existsSync(userSettingsPath), true);
		assert.equal(existsSync(path.join(project, ".pi", "settings.json")), false);
		const saved = JSON.parse(readFileSync(userSettingsPath, "utf8")) as Record<string, any>;
		assert.equal(saved.subagents.team, "frontend");
		assert.deepEqual(saved.subagents.teams.backend.members, ["worker"]);
		assert.match(harness.messages[0]?.content ?? "", /in .*\/user-agent-dir\/settings\.json/);
		assert.equal(
			harness.messages[1]?.content,
			"Created subagent team backend. Select it with /legion team use backend",
		);
		assert.deepEqual(harness.notifications, []);
	} finally {
		restoreEnv("PI_CODING_AGENT_DIR", previous);
		rmSync(dir, { recursive: true, force: true });
	}
});

test("slash: list and status report current team and warnings", async () => {
	const dir = mkdtempSync(path.join(tmpdir(), "teams-command-status-"));
	try {
		const harness = teamCommandHarness({
			agents: [agent("worker")],
			allAgents: [agent("worker"), agent("designer")],
			settings: {
				teams: { frontend: { description: "UI", members: ["worker"] } },
			},
			team: { name: "missing", source: "env" },
			teamWarnings: ['Subagent team "missing" is not defined; using all agents. Available teams: default, frontend.'],
		});
		await harness.invoke("", dir);
		assert.equal(
			harness.messages[0]?.content,
			'Active subagent team: missing\nSource: env\nMembers (1): worker\nWarning: Subagent team "missing" is not defined; using all agents. Available teams: default, frontend.',
		);
		await harness.invoke("list", dir);
		assert.equal(
			harness.messages[1]?.content,
			'Subagent teams\n  default — all discovered agents (2 members)\n  frontend — UI (1 members)\n* missing — (not defined; using all agents)\nWarning: Subagent team "missing" is not defined; using all agents. Available teams: default, frontend.',
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("catalog: filters agents, keeps allAgents, and team overrides precede defaults", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "teams-catalog-"));
	const previous = {
		agentDir: process.env.PI_CODING_AGENT_DIR,
		extra: process.env.PI_HERDR_SUBAGENTS_EXTRA_AGENT_DIRS,
		team: process.env[TEAM_ENV],
	};
	try {
		const agentDir = path.join(dir, "agentdir");
		const extraDir = path.join(dir, "extra");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(extraDir, { recursive: true });
		writeFileSync(
			path.join(agentDir, "settings.json"),
			JSON.stringify({
				subagents: {
					disableBuiltins: true,
					team: "frontend",
					defaultModel: "fallback/model",
					defaultOnBlocked: "notify",
					teams: {
						frontend: {
							members: [{
								agent: "worker",
								model: "team/model",
								onBlocked: "forward",
								timeoutMs: 17,
								kind: "claude",
								tools: ["read"],
							}],
						},
					},
				},
			}),
		);
		writeFileSync(
			path.join(extraDir, "worker.md"),
			"---\nname: worker\ndescription: worker\ntimeoutMs: 900\n---\nworker prompt\n",
		);
		writeFileSync(
			path.join(extraDir, "designer.md"),
			"---\nname: designer\ndescription: designer\n---\ndesigner prompt\n",
		);
		process.env.PI_CODING_AGENT_DIR = agentDir;
		process.env.PI_HERDR_SUBAGENTS_EXTRA_AGENT_DIRS = extraDir;
		delete process.env[TEAM_ENV];
		const catalog = loadCatalog(dir, dir, "user");
		assert.deepEqual(catalog.agents.map((entry) => entry.name), ["worker"]);
		assert.deepEqual(catalog.allAgents.map((entry) => entry.name), [
			"designer",
			"worker",
		]);
		assert.equal(catalog.agents[0]?.model, "team/model");
		assert.equal(catalog.agents[0]?.onBlocked, "forward");
		assert.equal(catalog.agents[0]?.timeoutMs, 17);
		assert.equal(catalog.agents[0]?.kind, "claude");
		assert.deepEqual(catalog.agents[0]?.tools, ["read"]);
		assert.equal(catalog.allAgents[1]?.model, "fallback/model");
		assert.equal(catalog.allAgents[1]?.onBlocked, "notify");
		assert.equal(catalog.allAgents[1]?.timeoutMs, 900);
		assert.equal(catalog.allAgents[1]?.kind, "pi");
		assert.deepEqual(catalog.team, { name: "frontend", source: "settings" });
		assert.deepEqual(catalog.teamWarnings, []);
	} finally {
		restoreEnv("PI_CODING_AGENT_DIR", previous.agentDir);
		restoreEnv("PI_HERDR_SUBAGENTS_EXTRA_AGENT_DIRS", previous.extra);
		restoreEnv(TEAM_ENV, previous.team);
		rmSync(dir, { recursive: true, force: true });
	}
});

test("catalog: missing and constructor-selected teams warn and keep the full catalog", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "teams-catalog-fallback-"));
	const previous = {
		agentDir: process.env.PI_CODING_AGENT_DIR,
		extra: process.env.PI_HERDR_SUBAGENTS_EXTRA_AGENT_DIRS,
		team: process.env[TEAM_ENV],
	};
	try {
		const agentDir = path.join(dir, "agentdir");
		const extraDir = path.join(dir, "extra");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(extraDir, { recursive: true });
		writeFileSync(
			path.join(agentDir, "settings.json"),
			JSON.stringify({ subagents: { disableBuiltins: true, teams: { frontend: { members: ["worker"] } } } }),
		);
		writeFileSync(path.join(extraDir, "worker.md"), "---\nname: worker\ndescription: worker\n---\nprompt\n");
		process.env.PI_CODING_AGENT_DIR = agentDir;
		process.env.PI_HERDR_SUBAGENTS_EXTRA_AGENT_DIRS = extraDir;
		for (const name of ["missing", "constructor"]) {
			process.env[TEAM_ENV] = name;
			const catalog = loadCatalog(dir, dir, "user");
			assert.deepEqual(catalog.agents.map((entry) => entry.name), ["worker"]);
			assert.deepEqual(catalog.allAgents.map((entry) => entry.name), ["worker"]);
			assert.deepEqual(catalog.team, { name, source: "env" });
			assert.deepEqual(catalog.teamWarnings, [
				`Subagent team "${name}" is not defined; using all agents. Available teams: default, frontend.`,
			]);
		}
	} finally {
		restoreEnv("PI_CODING_AGENT_DIR", previous.agentDir);
		restoreEnv("PI_HERDR_SUBAGENTS_EXTRA_AGENT_DIRS", previous.extra);
		restoreEnv(TEAM_ENV, previous.team);
		rmSync(dir, { recursive: true, force: true });
	}
});

test("listing and roster: default/no-warning text is byte-for-byte legacy; team lines are conditional", () => {
	const worker = agent("worker");
	const defaultTeam = { name: DEFAULT_TEAM, source: "default" as const };
	assert.equal(renderAgentList([worker], defaultTeam, []), "worker [user] — worker");
	assert.equal(
		renderAgentList([], defaultTeam, []),
		"No agents found. Add definitions to ~/.pi/agent/agents/*.md or .pi/agents/*.md.",
	);
	assert.equal(renderParentRoster([worker], defaultTeam, []), formatAgentRoster([worker]));
	assert.equal(renderParentRoster([], defaultTeam, []), formatAgentRoster([]));

	const warning = "team config is incomplete";
	assert.equal(
		renderAgentList([worker], { name: "frontend", source: "settings" }, []),
		"Active team: frontend (source: settings)\n\nworker [user] — worker",
	);
	assert.equal(
		renderAgentList([worker], defaultTeam, [warning]),
		`Active team: default (source: default)\nWarning: ${warning}\n\nworker [user] — worker`,
	);
	assert.equal(
		renderParentRoster([worker], { name: "frontend", source: "settings" }, [warning]),
		`Active subagent team: frontend\nTeam warning: ${warning}\n${formatAgentRoster([worker])}`,
	);

	const legacyEmptySlashText = [
		"Subagent roles",
		"Scope: user",
		"",
		"No agents found. Add definitions to ~/.pi/agent/agents/*.md or .pi/agents/*.md.",
		"",
		"Directories",
		"  builtin: /builtin",
		"  user: ~/.pi/agent/agents",
		"  project: (none found)",
	].join("\n");
	const common = {
		agents: [],
		scope: "user" as const,
		projectAgentsDir: null,
		builtinAgentsDir: "/builtin",
		settings: {},
	};
	assert.equal(
		renderAgentsListing({ ...common, team: defaultTeam, teamWarnings: [] }),
		legacyEmptySlashText,
	);
	assert.match(
		renderAgentsListing({
			...common,
			team: { name: "frontend", source: "settings" },
			teamWarnings: [warning],
		}),
		/^Subagent roles\nScope: user\nActive team: frontend \(source: settings\)\nWarning: team config is incomplete/m,
	);
});

test("launch refusal: only a real team-filtered role gets team wording", () => {
	const filtered = [agent("designer")];
	const allAgents = [agent("worker"), agent("designer")];
	const settings = withTeamSettings();
	assert.equal(
		unknownAgentLineForCatalog(
			filtered,
			allAgents,
			"worker",
			{ name: "frontend", source: "settings" },
			settings,
		),
		'✗ unknown agent "worker" in team "frontend". Available: designer. Switch with /legion team use frontend (or "default").',
	);
	assert.equal(
		unknownAgentLineForCatalog(
			filtered,
			allAgents,
			"ghost",
			{ name: "frontend", source: "settings" },
			settings,
		),
		'✗ unknown agent "ghost". Available: designer',
	);
	assert.equal(
		unknownAgentLineForCatalog(
			filtered,
			allAgents,
			"worker",
			{ name: "missing", source: "env" },
			{},
		),
		'✗ unknown agent "worker". Available: designer',
	);
	assert.equal(
		unknownAgentLine(filtered, "ghost"),
		'✗ unknown agent "ghost". Available: designer',
	);
});

test("control resolution prefers team override, then recovers a filtered role from allAgents", () => {
	const baseWorker = agent("worker", { timeoutMs: 2_000, kind: "pi" });
	const teamWorker = agent("worker", { timeoutMs: 17, kind: "claude" });
	const designer = agent("designer");
	const currentTeam = [teamWorker, designer];
	const resolve = (agents: AgentConfig[], allAgents: AgentConfig[], role: string | undefined) =>
		agents.find((entry) => entry.name === role) ??
		allAgents.find((entry) => entry.name === role);
	assert.equal(resolve(currentTeam, [baseWorker], "worker"), teamWorker);
	assert.equal(resolve([designer], [baseWorker], "worker"), baseWorker);
	assert.equal(resolve([designer], [baseWorker], undefined), undefined);
});

test("control wait: filtered child falls back to allAgents timeout", async () => {
	const runtime = createSessionRuntime({ sendMessage() {} });
	runtime.track({
		name: "worker-existing",
		runId: "r-team",
		agent: "worker",
		sessionFile: "/tmp/worker-existing.jsonl",
		timeoutMs: 10,
		collect: () => new Promise(() => {}),
	});
	const requests: Array<{ names: string[]; timeoutMs?: number }> = [];
	runtime.wait = (names: string[], options?: { timeoutMs?: number }) => {
		requests.push({ names, timeoutMs: options?.timeoutMs });
		return Promise.resolve(names.map((name) => ({ name, stillRunning: true }) as WaitResult));
	};
	const dir = mkdtempSync(path.join(tmpdir(), "teams-wait-control-"));
	try {
		const store = new RunStore({ rootDir: path.join(dir, ".pi-subagents") });
		const run = store.createRun({ task: "existing", cwd: dir });
		await store.addChild(run.runId, {
			name: "worker-existing",
			sessionFile: "/tmp/worker-existing.jsonl",
			ownerToken: "owner",
			state: "working",
			spawnedAt: new Date().toISOString(),
			agent: "worker",
			kind: "pi",
		});
		const result = await waitAction({
			params: { action: "wait", name: "worker-existing" },
			runtime,
			agents: [agent("designer")],
			allAgents: [agent("worker", { timeoutMs: 2_000 })],
			store,
			cwd: dir,
		});
		assert.deepEqual(requests, [{ names: ["worker-existing"], timeoutMs: 2_000 }]);
		assert.match((result.content as Array<{ text: string }>)[0]?.text ?? "", /still running/);
	} finally {
		runtime.dispose();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("control wait: team-overridden role definition wins over allAgents", async () => {
	const runtime = createSessionRuntime({ sendMessage() {} });
	runtime.track({
		name: "worker-existing",
		runId: "r-team-override",
		agent: "worker",
		sessionFile: "/tmp/worker-existing.jsonl",
		timeoutMs: 10,
		collect: () => new Promise(() => {}),
	});
	const requests: Array<{ names: string[]; timeoutMs?: number }> = [];
	runtime.wait = (names: string[], options?: { timeoutMs?: number }) => {
		requests.push({ names, timeoutMs: options?.timeoutMs });
		return Promise.resolve(names.map((name) => ({ name, stillRunning: true }) as WaitResult));
	};
	const dir = mkdtempSync(path.join(tmpdir(), "teams-wait-override-"));
	try {
		const store = new RunStore({ rootDir: path.join(dir, ".pi-subagents") });
		const run = store.createRun({ task: "existing", cwd: dir });
		await store.addChild(run.runId, {
			name: "worker-existing",
			sessionFile: "/tmp/worker-existing.jsonl",
			ownerToken: "owner",
			state: "working",
			spawnedAt: new Date().toISOString(),
			agent: "worker",
			kind: "pi",
		});
		await waitAction({
			params: { action: "wait", name: "worker-existing" },
			runtime,
			agents: [agent("worker", { kind: "claude", timeoutMs: 17 })],
			allAgents: [agent("worker", { timeoutMs: 2_000 })],
			store,
			cwd: dir,
		});
		assert.deepEqual(requests, [{ names: ["worker-existing"], timeoutMs: 17 }]);
	} finally {
		runtime.dispose();
		rmSync(dir, { recursive: true, force: true });
	}
});

function indexHarness(
	settings: Record<string, unknown>,
	agents: Record<string, string>,
	supervisorOptions: { autoSettle?: boolean; immediateTimeout?: boolean } = {},
	verifyRunner?: (command: string, cwd: string) => Promise<{ code: number; stdout: string; stderr: string }>,
): {
	cwd: string;
	supervisor: FakeSupervisor;
	sentMessages: unknown[];
	tool: {
		execute: (...args: unknown[]) => Promise<{ content?: Array<{ text?: string }>; details?: unknown }>;
		renderResult?: (...args: unknown[]) => { render(width: number): string[] };
	};
	utilityTool: {
		execute: (...args: unknown[]) => Promise<{ content?: Array<{ text?: string }>; details?: unknown }>;
		renderResult?: (...args: unknown[]) => { render(width: number): string[] };
	};
	startTurn(): void;
	startRun(): void;
	emitSettled(aborted: boolean): void;
	shutdown(): Promise<void>;
	cleanup(): Promise<void>;
} {
	const cwd = mkdtempSync(path.join(tmpdir(), "teams-index-rpc-"));
	const names = ["PI_SUBAGENT_CHILD", "PI_SUBAGENT_UTILITY_CHILD", "PI_CODING_AGENT_DIR", "PI_HERDR_SUBAGENTS_EXTRA_AGENT_DIRS", "PI_LEGION_DB", "PI_LEGION_NODE_ID", TEAM_ENV];
	const previous = new Map(names.map((name) => [name, process.env[name]]));
	const agentDir = path.join(cwd, "agentdir");
	const extraDir = path.join(cwd, "extra-agents");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(extraDir, { recursive: true });
	writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ subagents: settings }));
	for (const [file, content] of Object.entries(agents)) writeFileSync(path.join(extraDir, file), content);
	process.env.PI_CODING_AGENT_DIR = agentDir;
	process.env.PI_HERDR_SUBAGENTS_EXTRA_AGENT_DIRS = extraDir;
	delete process.env.PI_SUBAGENT_CHILD;
	delete process.env.PI_SUBAGENT_UTILITY_CHILD;
	for (const name of ["PI_LEGION_DB", "PI_LEGION_NODE_ID", TEAM_ENV]) delete process.env[name];
	const supervisor = new FakeSupervisor({
		immediateTimeout: supervisorOptions.immediateTimeout ?? true,
		...(supervisorOptions.autoSettle === false ? {} : { autoSettle: { text: `{"ok":true,"reason":"fake RPC child completed"}` } }),
	});
	const tools: Array<Record<string, unknown>> = [];
	const sentMessages: unknown[] = [];
	const handlers = new Map<string, (...args: any[]) => unknown>();
	const turnStartHandlers: Array<(...args: any[]) => unknown> = [];
	const agentStartHandlers: Array<(...args: any[]) => unknown> = [];
	const pi = {
		registerTool(tool: unknown) { tools.push(tool as Record<string, unknown>); },
		registerCommand() {}, registerMessageRenderer() {}, sendMessage(message: unknown) { sentMessages.push(message); },
		events: { emit() {} },
		on(name: string, handler: (...args: any[]) => unknown) {
			if (name === "turn_start") turnStartHandlers.push(handler);
			else if (name === "agent_start") agentStartHandlers.push(handler);
			else handlers.set(name, handler);
		},
	};
	piLegion(pi as never, { supervisor, ...(verifyRunner ? { verifyRunner } : {}) });
	const tool = tools.find((entry) => entry.name === "subagent") as {
		execute: (...args: unknown[]) => Promise<{ content?: Array<{ text?: string }>; details?: unknown }>;
		renderResult?: (...args: unknown[]) => { render(width: number): string[] };
	};
	const utilityTool = tools.find((entry) => entry.name === "vexillatio") as {
		execute: (...args: unknown[]) => Promise<{ content?: Array<{ text?: string }>; details?: unknown }>;
		renderResult?: (...args: unknown[]) => { render(width: number): string[] };
	};
	assert.ok(tool, "subagent tool registered through the index entry point");
	assert.ok(utilityTool, "vexillatio tool registered through the index entry point");
	return {
		cwd, supervisor, sentMessages, tool, utilityTool,
		startTurn() {
			for (const handler of turnStartHandlers) handler({}, { cwd, hasUI: false, ui: { notify() {}, setStatus() {} } });
		},
		startRun() {
			// `agent_start` opens the run-scoped completion window. Fire every
			// registered handler; the index also binds UI here, which is inert in
			// this harness (hasUI: false).
			for (const handler of agentStartHandlers) handler({}, { cwd, hasUI: false, ui: { notify() {}, setStatus() {} } });
		},
		emitSettled(aborted: boolean): void {
			handlers.get("agent_settled")?.({ type: "agent_settled", aborted }, { cwd, hasUI: false, ui: { notify() {}, setStatus() {} } });
		},
		async shutdown() {
			await handlers.get("session_shutdown")?.();
		},
		async cleanup() {
			await handlers.get("session_shutdown")?.();
			for (const [name, value] of previous) restoreEnv(name, value);
			rmSync(cwd, { recursive: true, force: true });
		},
	};
}

const WORKER_FILE = "---\nname: worker\ndescription: worker role\n---\nworker prompt\n";
const RPC_WORKER_FILE = "---\nname: rpcworker\ndescription: worker role pinned to rpc\nspawnMode: rpc\n---\nworker prompt\n";
const UTILITY_FILE = "---\nname: scout\ndescription: read-only utility role\nutility: true\ntools: read, grep, find, ls\nkind: pi\n---\nscout prompt\n";
const DESIGNER_FILE = "---\nname: designer\ndescription: designer role\nkind: cursor\n---\ndesigner prompt\n";

async function invokeIndex(
	harness: ReturnType<typeof indexHarness>,
	params: Record<string, unknown>,
): Promise<string> {
	const result = await invokeIndexRaw(harness, params);
	return (result.content ?? []).map((item) => item.text ?? "").join("\n");
}

/** Same call, keeping `details` so D3 machine facts can be asserted. */
function invokeIndexRaw(
	harness: ReturnType<typeof indexHarness>,
	params: Record<string, unknown>,
): Promise<{ content?: Array<{ text?: string }>; details?: unknown }> {
	return harness.tool.execute(
		"teams-test", params, undefined, undefined,
		{ cwd: harness.cwd, hasUI: false, ui: { notify() {}, setStatus() {} } },
	);
}

test("session shutdown retires active RPC children while preserving their run record", async () => {
	const harness = indexHarness(
		{ disableBuiltins: true },
		{ "worker.md": WORKER_FILE },
		{ autoSettle: false, immediateTimeout: false },
	);
	try {
		await invokeIndex(harness, { agent: "worker", task: "leave active", async: true, worktree: false });
		const name = harness.supervisor.spawns[0]?.input.name;
		assert.ok(name);
		assert.equal(harness.supervisor.isAlive(name), true);
		await harness.shutdown();
		assert.equal(harness.supervisor.isAlive(name), false);
		assert.ok(harness.supervisor.calls.some((call) => call.method === "retire" && call.name === name));
		const runs = new RunStore({ rootDir: path.join(harness.cwd, ".pi-subagents") }).listRuns();
		assert.equal(runs.length, 2, "the root launch owns a root run and a distinct worker run");
		const rootRun = runs.find((run) => run.nodeId === "root");
		assert.ok(rootRun, "root run is marked with the Legion root identity");
		assert.equal(rootRun.children[0]?.nodeId, `root.${name}`);
	} finally {
		await harness.cleanup();
	}
});


test("index stop action retires multiple RPC children and persists their retired state", async () => {
	const harness = indexHarness(
		{ disableBuiltins: true, joinMode: "each" },
		{ "worker.md": WORKER_FILE },
		{ autoSettle: false, immediateTimeout: false },
	);
	let releaseFirstRetire: () => void = () => {};
	try {
		await invokeIndex(harness, {
			tasks: [
				{ agent: "worker", task: "first" },
				{ agent: "worker", task: "second" },
			],
			async: true,
			worktree: false,
		});
		const names = harness.supervisor.spawns.map((spawn) => spawn.input.name);
		assert.equal(names.length, 2);
		const firstName = names[0]!;
		const secondName = names[1]!;
		assert.ok(names.every((name) => harness.supervisor.isAlive(name)));

		let firstRetireStartedResolve!: () => void;
		const firstRetireStarted = new Promise<void>((resolve) => { firstRetireStartedResolve = resolve; });
		const firstRetireGate = new Promise<void>((resolve) => { releaseFirstRetire = resolve; });
		let firstRetireCalls = 0;
		const originalRetire = harness.supervisor.retire.bind(harness.supervisor);
		harness.supervisor.retire = async (name: string) => {
			if (name === firstName && firstRetireCalls++ === 0) {
				firstRetireStartedResolve();
				await firstRetireGate;
			}
			await originalRetire(name);
		};
		const stopPending = invokeIndex(harness, { action: "stop", all: true });
		await firstRetireStarted;
		harness.supervisor.settle(secondName, { text: "second finished while first retires" });
		await new Promise((resolve) => setTimeout(resolve, 2_600));
		assert.equal(harness.sentMessages.length, 0, "all completion watchers are canceled before the first retire starts");
		releaseFirstRetire();
		const stopped = await stopPending;
		assert.match(stopped, /Stopped 2 children/);
		assert.equal(harness.sentMessages.length, 0, "stop cancels every completion watcher before retiring the first child");
		assert.deepEqual(
			harness.supervisor.calls.filter((call) => call.method === "retire").map((call) => call.name),
			names,
		);
		assert.ok(names.every((name) => !harness.supervisor.isAlive(name)));
		const runs = new RunStore({ rootDir: path.join(harness.cwd, ".pi-subagents") }).listRuns();
		const stoppedRecords = runs.flatMap((run) => run.children).filter((child) => names.includes(child.name));
		assert.deepEqual(
			stoppedRecords.map((child) => ({ name: child.name, state: child.state })),
			names.map((name) => ({ name, state: "retired" })),
		);
	} finally {
		releaseFirstRetire();
		await harness.cleanup();
	}
});

test("index launch abort keeps the child running and watches for settle", async () => {
	const harness = indexHarness(
		{ disableBuiltins: true },
		{ "worker.md": WORKER_FILE },
		{ autoSettle: false, immediateTimeout: false },
	);
	let releaseSpawn: () => void = () => {};
	try {
		let spawnedResolve!: () => void;
		const spawned = new Promise<void>((resolve) => { spawnedResolve = resolve; });
		const spawnGate = new Promise<void>((resolve) => { releaseSpawn = resolve; });
		const originalSpawn = harness.supervisor.spawnChild.bind(harness.supervisor);
		harness.supervisor.spawnChild = async (input) => {
			const handle = await originalSpawn(input);
			spawnedResolve();
			await spawnGate;
			return handle;
		};
		const controller = new AbortController();
		const pending = harness.tool.execute(
			"launch-abort",
			{ agent: "worker", task: "keep running after parent abort", async: true, worktree: false },
			controller.signal,
			undefined,
			{ cwd: harness.cwd, hasUI: false, ui: { notify() {}, setStatus() {} } },
		);
		await spawned;
		controller.abort();
		releaseSpawn();
		const result = await pending;
		const handle = harness.supervisor.spawns[0]?.input;
		if (!handle) throw new Error("expected the child spawn to complete");
		assert.match((result.content ?? []).map((item) => item.text ?? "").join("\n"), /interrupted \(parent turn ended; children still running\)|parent turn ended; child still running/);
		// #209/D3: the interrupted path runs AFTER `handles` is cleared, so the
		// arbitrated backend must survive in the parallel `spawns` field. Pin
		// both halves of that shape: handles empty, spawns still populated.
		const details = (result as { details?: unknown }).details as
			| { handles?: unknown[]; spawns?: Array<{ name: string; agent: string; spawnMode: string }> }
			| undefined;
		assert.deepEqual(details?.handles, [], "the abort clears the pre-existing handles list");
		assert.equal(details?.spawns?.length, 1, "the resolved handle still reports its backend");
		assert.equal(details?.spawns?.[0]?.name, handle.name);
		assert.equal(details?.spawns?.[0]?.agent, "worker");
		assert.equal(details?.spawns?.[0]?.spawnMode, "inprocess", "the arbitrated value, never a re-derivation");
		assert.equal(harness.supervisor.isAlive(handle.name), true, "Esc must not retire a just-spawned child");
		assert.equal(
			harness.supervisor.calls.some((call) => call.method === "retire"),
			false,
			"launch abort must not call retire",
		);
		assert.ok(
			(result.content ?? []).map((item) => item.text ?? "").join("\n").includes("still running"),
			"tool result notes the child is still watched",
		);
	} finally {
		releaseSpawn();
		await harness.cleanup();
	}
});

test("index wait abort returns interrupted without retiring tracked children", async () => {
	const harness = indexHarness(
		{ disableBuiltins: true },
		{ "worker.md": WORKER_FILE },
		{ autoSettle: false, immediateTimeout: false },
	);
	try {
		harness.startTurn();
		await invokeIndex(harness, { agent: "worker", task: "finish after parent abort", async: true, worktree: false });
		const name = harness.supervisor.spawns[0]?.input.name;
		if (!name) throw new Error("worker child did not spawn");
		const controller = new AbortController();
		const pending = harness.tool.execute(
			"wait-abort",
			{ action: "wait", name },
			controller.signal,
			undefined,
			{ cwd: harness.cwd, hasUI: false, ui: { notify() {}, setStatus() {} } },
		);
		controller.abort();
		const result = await pending;
		assert.match((result.content ?? []).map((item) => item.text ?? "").join("\n"), /interrupted \(parent turn ended; children still running\)/);
		assert.equal(
			harness.supervisor.calls.some((call) => call.method === "retire"),
			false,
			"wait abort must not retire children",
		);
		assert.equal(harness.supervisor.isAlive(name), true, "child keeps running after wait interrupt");
	} finally {
		await harness.cleanup();
	}
});

test("agent_settled aborted leaves async children running (no cascade)", async () => {
	const harness = indexHarness(
		{ disableBuiltins: true },
		{ "worker.md": WORKER_FILE },
		{ autoSettle: false, immediateTimeout: false },
	);
	try {
		harness.startTurn();
		await invokeIndex(harness, { agent: "worker", task: "async child outlives the launch tool call", async: true, worktree: false });
		const name = harness.supervisor.spawns[0]?.input.name;
		if (!name) throw new Error("worker child did not spawn");
		assert.equal(harness.supervisor.isAlive(name), true, "the async child is live after the launch tool returned");
		// ESC after async launch returned: v3 does not cascade on agent_settled.
		harness.emitSettled(true);
		for (let attempt = 0; attempt < 20; attempt++) {
			if (harness.supervisor.calls.some((call) => call.method === "retire")) break;
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		assert.equal(
			harness.supervisor.calls.some((call) => call.method === "retire"),
			false,
			"agent_settled aborted must not retire async children",
		);
		assert.equal(harness.supervisor.isAlive(name), true, "async child keeps running after aborted settle");
	} finally {
		await harness.cleanup();
	}
});

test("agent_settled without abort leaves async children running", async () => {
	const harness = indexHarness(
		{ disableBuiltins: true },
		{ "worker.md": WORKER_FILE },
		{ autoSettle: false, immediateTimeout: false },
	);
	try {
		harness.startTurn();
		await invokeIndex(harness, { agent: "worker", task: "async child survives a normal settle", async: true, worktree: false });
		const name = harness.supervisor.spawns[0]?.input.name;
		if (!name) throw new Error("worker child did not spawn");
		harness.emitSettled(false);
		for (let attempt = 0; attempt < 100 && harness.supervisor.isAlive(name); attempt++) {
			if (harness.supervisor.calls.some((call) => call.method === "retire")) break;
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		assert.equal(
			harness.supervisor.calls.some((call) => call.method === "retire"),
			false,
			"a normally settled run must not retire its async children",
		);
		assert.equal(harness.supervisor.isAlive(name), true, "the async child keeps running after a normal settle");
	} finally {
		await harness.cleanup();
	}
});

test("index collect abort returns promptly without retiring the RPC child", async () => {
	const harness = indexHarness(
		{ disableBuiltins: true },
		{ "worker.md": WORKER_FILE },
		{ autoSettle: false, immediateTimeout: false },
	);
	try {
		harness.startTurn();
		await invokeIndex(harness, { agent: "worker", task: "finish after parent abort", async: true, worktree: false });
		const name = harness.supervisor.spawns[0]?.input.name;
		if (!name) throw new Error("worker child did not spawn");
		const controller = new AbortController();
		const pending = harness.tool.execute(
			"collect-abort",
			{ action: "collect", name },
			controller.signal,
			undefined,
			{ cwd: harness.cwd, hasUI: false, ui: { notify() {}, setStatus() {} } },
		);
		controller.abort();
		const result = await pending;
		assert.match((result.content ?? []).map((item) => item.text ?? "").join("\n"), /interrupted \(parent turn ended; children still running\)/);
		assert.equal(
			harness.supervisor.calls.some((call) => call.method === "retire"),
			false,
			"collect abort must not retire",
		);
		assert.equal(harness.supervisor.isAlive(name), true, "collect abort leaves the child running");
	} finally {
		await harness.cleanup();
	}
});

test("vexillatio collect abort returns promptly without retiring utility children", async () => {
	const harness = indexHarness(
		{ disableBuiltins: true },
		{ "scout.md": UTILITY_FILE },
		{ autoSettle: false, immediateTimeout: false },
	);
	try {
		harness.startTurn();
		const collectSignals: Array<AbortSignal | undefined> = [];
		const signalAwareSupervisor = harness.supervisor as unknown as {
			waitSettled(name: string, timeoutMs?: number, signal?: AbortSignal): Promise<{ settled: boolean; abnormal: boolean; reason?: string }>;
		};
		signalAwareSupervisor.waitSettled = (_name, _timeoutMs, signal) => {
			collectSignals.push(signal);
			return new Promise((resolve) => {
				const aborted = () => resolve({ settled: false, abnormal: false, reason: "aborted by parent" });
				if (signal?.aborted) aborted();
				else signal?.addEventListener("abort", aborted, { once: true });
			});
		};
		const controller = new AbortController();
		const pending = harness.utilityTool.execute(
			"vexillatio-abort",
			{ agent: "scout", task: "inspect until aborted", cwd: harness.cwd, timeoutMs: 600_000 },
			controller.signal,
			undefined,
			{ cwd: harness.cwd, hasUI: false, ui: { notify() {}, setStatus() {} } },
		);
		const collectDeadline = Date.now() + 1_000;
		while (collectSignals.length === 0) {
			if (Date.now() > collectDeadline) throw new Error("vexillatio did not start collecting the utility child");
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
		const name = harness.supervisor.spawns[0]?.input.name;
		if (!name) throw new Error("utility child did not spawn");
		assert.equal(collectSignals[0], controller.signal, "vexillatio forwards the tool signal to collect");

		controller.abort();
		let timeout: ReturnType<typeof setTimeout> | undefined;
		const result = await Promise.race([
			pending,
			new Promise<undefined>((resolve) => { timeout = setTimeout(() => resolve(undefined), 250); }),
		]);
		if (timeout) clearTimeout(timeout);
		assert.ok(result, "aborted collect returns without waiting for the 600s timeout");
		assert.match((result.content ?? []).map((item) => item.text ?? "").join("\n"), /interrupted \(parent turn ended; children still running\)/);
		assert.equal(harness.supervisor.isAlive(name), true, "utility child keeps running after Esc");
		assert.equal(
			harness.supervisor.calls.some((call) => call.method === "retire"),
			false,
			"vexillatio abort must not cascade retire",
		);
	} finally {
		await harness.cleanup();
	}
});

test("index mainline: the launch line and the child record carry the arbitrated spawnMode (#209)", async () => {
	const harness = indexHarness(
		{ disableBuiltins: true },
		{ "worker.md": WORKER_FILE, "rpcworker.md": RPC_WORKER_FILE },
	);
	try {
		// Same role shape as before but pinned to the rpc backend, so both
		// arbitration outcomes are observable through the same harness.
		const inprocess = await invokeIndex(harness, { agent: "worker", task: "default backend", async: true, worktree: false });
		assert.match(inprocess, /supervisor=inprocess/, "an omitted spawnMode with worktree:false arbitrates to inprocess");
		const rpc = await invokeIndex(harness, { agent: "rpcworker", task: "pinned backend", async: true, worktree: false });
		assert.match(rpc, /supervisor=rpc/, "an explicit spawnMode: rpc keeps rendering rpc");
		assert.doesNotMatch(rpc, /supervisor=inprocess/);

		const children = new RunStore({ rootDir: path.join(harness.cwd, ".pi-subagents") })
			.listRuns()
			.flatMap((run) => run.children);
		assert.equal(children.find((child) => child.agent === "worker")?.spawnMode, "inprocess", "ChildRecord echoes the arbitrated mode");
		assert.equal(children.find((child) => child.agent === "rpcworker")?.spawnMode, "rpc");
	} finally { await harness.cleanup(); }
});

test("index mainline: launch-family details expose the arbitrated spawnMode as spawns (#209/D3)", async () => {
	const harness = indexHarness(
		{ disableBuiltins: true },
		{ "worker.md": WORKER_FILE, "rpcworker.md": RPC_WORKER_FILE },
	);
	try {
		const inprocess = await invokeIndexRaw(harness, { agent: "worker", task: "default backend", async: true, worktree: false });
		const inprocessDetails = inprocess.details as
			| { spawns?: Array<{ name: string; agent: string; spawnMode: string }>; handles?: string[] }
			| undefined;
		assert.equal(inprocessDetails?.spawns?.length, 1, "one resolved handle, one spawn entry");
		assert.equal(inprocessDetails?.spawns?.[0]?.agent, "worker");
		assert.equal(inprocessDetails?.spawns?.[0]?.spawnMode, "inprocess", "the arbitrated value, not a re-derivation");
		assert.equal(inprocessDetails?.spawns?.[0]?.name, inprocessDetails?.handles?.[0]);
		// Additive only: the pre-existing keys are untouched.
		assert.ok(Array.isArray(inprocessDetails?.handles));
		assert.match((inprocess.details as { runId?: string }).runId ?? "", /^r-[0-9a-z]+$/i);
		assert.equal((inprocess.details as { async?: boolean }).async, true);
		assert.equal(
			(inprocess.details as { isError?: unknown }).isError,
			undefined,
			"details never carry isError",
		);

		const rpc = await invokeIndexRaw(harness, { agent: "rpcworker", task: "pinned backend", async: true, worktree: false });
		const rpcSpawns = (rpc.details as { spawns?: Array<{ spawnMode: string }> } | undefined)?.spawns;
		assert.equal(rpcSpawns?.[0]?.spawnMode, "rpc", "a role pinned to rpc reports rpc");
	} finally { await harness.cleanup(); }
});

test("index mainline: a launch with no resolved handle omits spawns entirely (#209/D3)", async () => {
	const harness = indexHarness({ disableBuiltins: true }, { "worker.md": WORKER_FILE });
	try {
		const result = await invokeIndexRaw(harness, { agent: "ghost", task: "no such role", async: true, worktree: false });
		assert.match((result.content ?? []).map((item) => item.text ?? "").join("\n"), /unknown agent/);
		assert.equal(
			(result.details as { spawns?: unknown }).spawns,
			undefined,
			"present only when non-empty, matching the stillRunning convention",
		);
	} finally { await harness.cleanup(); }
});

test("index mainline: both tools register a renderResult that shows the summary line (#209/D4)", async () => {
	const harness = indexHarness(
		{ disableBuiltins: true },
		{ "worker.md": WORKER_FILE, "scout.md": UTILITY_FILE },
	);
	try {
		assert.equal(typeof harness.tool.renderResult, "function", "subagent registers renderResult");
		assert.equal(typeof harness.utilityTool.renderResult, "function", "vexillatio registers renderResult");

		const launch = await invokeIndexRaw(harness, { agent: "worker", task: "render me", async: true, worktree: false });
		const theme = {
			fg: (_color: string, text: string) => text,
			bg: (_color: string, text: string) => text,
			bold: (text: string) => text,
		};
		const rendered = harness.tool
			.renderResult!(launch, { expanded: false, isPartial: false }, theme)
			.render(200)
			.map((line: string) => stripTerminalSequences(line));
		assert.match(rendered[0] ?? "", /spawn: worker-0=inprocess/, "the TUI card names the arbitrated backend");
		// The summary line goes through `details`, never through `content`.
		assert.doesNotMatch(
			(launch.content ?? []).map((item) => item.text ?? "").join("\n"),
			/spawn: worker-0=inprocess|spawn: scout-0=rpc/,
			"the model-facing content stays free of the summary",
		);
	} finally { await harness.cleanup(); }
});

test("index mainline: the selected team reaches RPC children", async () => {
	const harness = indexHarness(
		{ disableBuiltins: true, team: "frontend", teams: { frontend: { members: ["worker"] } } },
		{ "worker.md": WORKER_FILE },
	);
	try {
		const text = await invokeIndex(harness, {
			tasks: [{ agent: "worker", task: "first" }, { agent: "worker", task: "second" }],
			async: true, worktree: false,
		});
		// #209 D4: the role declares no spawnMode and worktree is false, so the
		// arbitrated backend is inprocess — the launch line must say so, not `rpc`.
		assert.match(text, /supervisor=inprocess/);
		assert.equal(harness.supervisor.spawns.length, 2);
		for (const spawn of harness.supervisor.spawns) {
			assert.equal(spawn.input.env?.PI_SUBAGENTS_TEAM, "frontend");
		}
	} finally { await harness.cleanup(); }
});

test("index mainline: a launch team override selects the roster and reaches the RPC child", async () => {
	const harness = indexHarness(
		{ disableBuiltins: true, teams: { backend: { members: ["worker"] } } },
		{ "worker.md": WORKER_FILE, "designer.md": DESIGNER_FILE },
	);
	try {
		const text = await invokeIndex(harness, { agent: "worker", task: "use backend squad", team: "backend", async: true, worktree: false });
		assert.match(text, /supervisor=inprocess/);
		assert.equal(harness.supervisor.spawns.length, 1);
		assert.equal(harness.supervisor.spawns[0]?.input.env?.PI_SUBAGENTS_TEAM, "backend");
		const designer = await invokeIndex(harness, { agent: "designer", task: "not in backend", team: "backend", async: true, worktree: false });
		assert.match(designer, /unknown agent/);
		assert.equal(harness.supervisor.spawns.length, 1);
	} finally { await harness.cleanup(); }
});

test("index mainline: default team omits inherited team env and RPC ignores legacy Placement params", async () => {
	const harness = indexHarness({ disableBuiltins: true }, { "worker.md": WORKER_FILE });
	try {
		const text = await invokeIndex(harness, { agent: "worker", task: "plain", async: true, worktree: false, placement: "new-tab" });
		assert.match(text, /supervisor=inprocess/);
		assert.equal(harness.supervisor.spawns.length, 1);
		assert.equal(harness.supervisor.spawns[0]?.input.env?.PI_SUBAGENTS_TEAM, undefined);
		assert.equal(harness.supervisor.spawns[0]?.input.cwd, harness.cwd);
	} finally { await harness.cleanup(); }
});

test("index mainline: environment default team reaches child and non-pi role receives migration guidance", async () => {
	const harness = indexHarness(
		{ disableBuiltins: true, team: "frontend", teams: { frontend: { members: ["designer"] } } },
		{ "worker.md": WORKER_FILE, "designer.md": DESIGNER_FILE },
	);
	const previous = process.env[TEAM_ENV];
	try {
		process.env[TEAM_ENV] = "default";
		await invokeIndex(harness, { agent: "worker", task: "default role", async: false, worktree: false });
		assert.equal(harness.supervisor.spawns[0]?.input.env?.PI_SUBAGENTS_TEAM, "default");
		const result = await invokeIndex(harness, { agent: "designer", task: "unsupported non-pi", async: false, worktree: false });
		assert.match(result, /kind: pi|v0\.16\.x/);
		assert.equal(harness.supervisor.spawns.length, 1, "non-pi kinds never reach RpcSupervisor.spawnChild");
	} finally {
		restoreEnv(TEAM_ENV, previous);
		await harness.cleanup();
	}
});

test("index verify: launch-supplied commands run at collect and gate the verdict", async () => {
	const calls: Array<{ command: string; cwd: string }> = [];
	const verifyRunner = async (command: string, cwd: string) => {
		calls.push({ command, cwd });
		// The joined criterion command is one string; fail it as bash would
		// (&& short-circuits at npm test, so the whole chain is non-zero).
		return command === "npm run typecheck && npm test" ? { code: 1, stdout: "", stderr: "1 failing" } : { code: 0, stdout: "ok", stderr: "" };
	};
	// async:false so the tool call collects inline and the verify chain runs.
	const harness = indexHarness(
		{ disableBuiltins: true },
		{ "worker.md": WORKER_FILE },
		{ autoSettle: true },
		verifyRunner,
	);
	try {
		const text = await invokeIndex(harness, {
			agent: "worker",
			task: "implement",
			async: false,
			worktree: false,
			verify: ["npm run typecheck", "npm test"],
		});
		assert.ok(text.length > 0, "inline collect produced output");
		// The launcher's verify list is joined into ONE criterion command; the
		// runner sees the joined form and the child cwd (no worktree → launch cwd).
		assert.deepEqual(calls.map((c) => c.command), ["npm run typecheck && npm test"]);
		assert.equal(calls[0]?.cwd, harness.cwd);
		// The joined command exits non-zero (npm test fails under &&) and rejects
		// the verdict with the failing command named.
		assert.match(text, /rejected/);
		assert.match(text, /npm test/);
		const runs = new RunStore({ rootDir: path.join(harness.cwd, ".pi-subagents") }).listRuns();
		const workerRun = runs.flatMap((run) => run.children).find((child) => child.agent === "worker");
		assert.ok(workerRun, "worker child record persisted");
		assert.ok(
			(workerRun.pendingCriteria ?? []).some((criterion) => criterion.id === "task-verify" && criterion.command === "npm run typecheck && npm test"),
			"task-verify criterion was snapshotted into pendingCriteria at launch",
		);
	} finally {
		await harness.cleanup();
	}
});

test("index verify: all commands passing promotes the verdict to verified", async () => {
	const calls: Array<{ command: string; cwd: string }> = [];
	const verifyRunner = async (command: string, cwd: string) => {
		calls.push({ command, cwd });
		return { code: 0, stdout: "green", stderr: "" };
	};
	const harness = indexHarness(
		{ disableBuiltins: true },
		{ "worker.md": WORKER_FILE },
		{ autoSettle: true },
		verifyRunner,
	);
	try {
		const text = await invokeIndex(harness, {
			agent: "worker",
			task: "implement",
			async: false,
			worktree: false,
			verify: ["npm run typecheck", "npm test"],
		});
		assert.deepEqual(calls.map((c) => c.command), ["npm run typecheck && npm test"]);
		assert.match(text, /accepted \(verified\)/);
		assert.match(text, /`npm run typecheck && npm test`/);
	} finally {
		await harness.cleanup();
	}
});

test("index verify: without verify the worker path keeps its attested semantics", async () => {
	const calls: Array<{ command: string; cwd: string }> = [];
	const verifyRunner = async (command: string, cwd: string) => {
		calls.push({ command, cwd });
		return { code: 0, stdout: "", stderr: "" };
	};
	const harness = indexHarness(
		{ disableBuiltins: true },
		{ "worker.md": WORKER_FILE },
		{ autoSettle: true },
		verifyRunner,
	);
	try {
		await invokeIndex(harness, {
			agent: "worker",
			task: "implement",
			async: false,
			worktree: false,
		});
		assert.deepEqual(calls, [], "no verify supplied: the extension must not guess a command");
	} finally {
		await harness.cleanup();
	}
});

/** Poll until `pred()` holds, so no test waits on a fixed long sleep. */
async function waitForTeams(pred: () => boolean, label: string, capMs = 1_000): Promise<void> {
	const start = Date.now();
	while (!pred()) {
		if (Date.now() - start > capMs) throw new Error(`timeout: ${label}`);
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

test("T8: index — a completion during the parent run is delivered on agent_settled, not before", async () => {
	const harness = indexHarness(
		{ disableBuiltins: true },
		{ "worker.md": WORKER_FILE },
		{ autoSettle: true },
	);
	try {
		// The run is live: the index's `agent_start` handler turns on the
		// outbox hold. Before this wiring `agent_settled` had no handler at all,
		// so a `followUp` sat in agent.followUpQueue until the user typed again.
		harness.startRun();
		await invokeIndex(harness, { agent: "worker", task: "finish inside the run", async: true, worktree: false });

		// The completion is produced only when the watch's collect resolves, and
		// the real orchestrator gates that on DEFAULTS.settleQuietMs (2.5s) of
		// session quiet — so a fixed ~100ms window would observe nothing on
		// either version of the code and prove nothing. The child's `retire`
		// call is the observable cue that the notice was produced: watch() emits
		// the notice (onTerminal) BEFORE awaiting retire.
		await waitForTeams(
			() => harness.supervisor.calls.some((call) => call.method === "retire"),
			"child collected and retired",
			8_000,
		);
		assert.equal(
			harness.sentMessages.length,
			0,
			"no completion message may reach the host during a live run",
		);

		harness.emitSettled(false);
		await waitForTeams(() => harness.sentMessages.length === 1, "notice flushed at agent_settled");
		const sent = harness.sentMessages[0] as { customType: string; content: string };
		assert.equal(sent.customType, "subagent-notify");
		assert.match(sent.content, /Background task completed/);
	} finally {
		await harness.cleanup();
	}
});

test("vexillatio interrupt returns the results it already collected (#227 D4)", async () => {
	const harness = indexHarness(
		{ disableBuiltins: true },
		{ "scout.md": UTILITY_FILE },
		{ autoSettle: false, immediateTimeout: false },
	);
	try {
		harness.startTurn();
		// Two utilities: the first finishes normally, the second is still in-turn
		// when the parent aborts — the exact shape issue #227 lost results from.
		// No waitSettled stub is needed: FakeSupervisor parks an unsettled wait on
		// `child.waiters`, so the real settle resolves the first collect and the
		// abort signal resolves the second (see the harness `:1254` case).
		const controller = new AbortController();
		const pending = harness.utilityTool.execute(
			"vexillatio-interrupt",
			{
				task: "two parallel utility recon tasks",
				tasks: [
					{ agent: "scout", task: "finish before the interrupt", cwd: harness.cwd },
					{ agent: "scout", task: "stay in-turn until the interrupt", cwd: harness.cwd },
				],
				cwd: harness.cwd,
				timeoutMs: 600_000,
			},
			controller.signal,
			undefined,
			{ cwd: harness.cwd, hasUI: false, ui: { notify() {}, setStatus() {} } },
		);
		// Settle the first utility so its collect has a real result to keep.
		let first: string | undefined;
		for (let attempt = 0; attempt < 200; attempt++) {
			first = harness.supervisor.spawns[0]?.input.name;
			if (first) break;
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
		if (!first) throw new Error("the first utility child did not spawn");
		harness.supervisor.settle(first, { text: '{"ok":true,"reason":"first utility finished"}' });
		// Retiring the finished utility is what proves its collect returned.
		const retireDeadline = Date.now() + 8_000;
		while (!harness.supervisor.calls.some((call) => call.method === "retire" && call.name === first)) {
			if (Date.now() > retireDeadline) throw new Error("the completed utility was never collected and retired");
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		const second = harness.supervisor.spawns[1]?.input.name;
		if (!second) throw new Error("the second utility child did not spawn");
		assert.equal(harness.supervisor.isAlive(second), true, "the second utility is still in-turn");

		controller.abort();
		const settled = await Promise.race([
			pending,
			new Promise<undefined>((resolve) => { setTimeout(() => resolve(undefined), 5_000); }),
		]);
		assert.ok(settled, "an interrupted vexillatio still returns instead of hanging");
		const text = (settled.content ?? []).map((item) => item.text ?? "").join("\n");
		// The frozen head line stays first and verbatim (esc-no-retire-v3 §22).
		assert.match(text, /interrupted \(parent turn ended; children still running\)/);
		// ...and the already-collected work is still in the result body.
		assert.match(text, /── scout-0 ──/, "the completed child's segment survives the interrupt");
		assert.match(text, /── scout-1 ──/, "the interrupted child's segment is rendered too");
		assert.match(text, /execution: /, "each segment keeps its execution line");
		assert.match(text, /first utility finished/, "the completed child's body survives the interrupt");
		assert.match(text, /execution: running \(aborted by parent\)/, "an interrupted collect is still reported as running, never as success");
		const details = (settled as { details?: unknown }).details as
			| { runId?: string; handles?: Array<{ name: string; agent: string; sessionFile: string; spawnMode?: string }>; async?: boolean; interrupted?: boolean; stillRunning?: string[] }
			| undefined;
		assert.equal(details?.interrupted, true, "details mark the interruption");
		assert.equal(details?.async, false);
		assert.equal(details?.handles?.length, 2, "details keep one handle per launched utility");
		// #209/D3: vexillatio publishes the arbitrated backend per handle. This is
		// the producer side of `spawnModeSummary`'s `handles[].spawnMode` read —
		// without it the renderer's vexillatio branch has no facts to show.
		assert.equal(
			details?.handles?.[0]?.spawnMode,
			"inprocess",
			"a utility launched with default arbitration reports its backend",
		);
		// F7: "non-empty" cannot distinguish a right run id from a constant, so pin
		// it to the run directory this interrupt actually wrote to.
		assert.match(details?.runId ?? "", /^r-[0-9a-z]+$/i, "details carry a real run id, not a placeholder");
		assert.equal(
			existsSync(path.join(harness.cwd, ".pi-subagents", "runs", details?.runId ?? "")),
			true,
			"the reported run id names a run directory that exists on disk",
		);
		assert.deepEqual(details?.stillRunning, [second], "the still-running utility is named, the retired one is not");
		assert.equal(harness.supervisor.isAlive(second), true, "an interrupt must not retire the child that is still running");
		assert.equal(
			harness.supervisor.calls.filter((call) => call.method === "retire" && call.name === second).length,
			0,
			"the abort path never cascades a retire",
		);
	} finally {
		await harness.cleanup();
	}
});

test("vexillatio interrupt keeps launch-failure lines and emits no empty segment (#227 D4)", async () => {
	const harness = indexHarness(
		{ disableBuiltins: true },
		{ "scout.md": UTILITY_FILE },
		{ autoSettle: false, immediateTimeout: false },
	);
	try {
		harness.startTurn();
		const controller = new AbortController();
		// Every launch fails and the parent aborts in the same breath: the result
		// must stay the head line plus the `✗ <agent>: <error>` lines — no blank
		// segment where the collected results would have gone.
		harness.supervisor.spawnChild = async () => {
			controller.abort();
			throw new Error("spawn refused for the interrupt test");
		};
		const result = await harness.utilityTool.execute(
			"vexillatio-interrupt-no-handles",
			{ agent: "scout", task: "never launches", cwd: harness.cwd, timeoutMs: 600_000 },
			controller.signal,
			undefined,
			{ cwd: harness.cwd, hasUI: false, ui: { notify() {}, setStatus() {} } },
		);
		const text = (result.content ?? []).map((item) => item.text ?? "").join("\n");
		const head = "interrupted (parent turn ended; children still running)";
		assert.ok(text.startsWith(head), "the frozen head line still leads the result");
		assert.match(text, /✗ scout: spawn refused for the interrupt test/, "a launch failure is never dropped by the interrupt");
		assert.doesNotMatch(text, /\n\n\n/, "no empty segment is inserted between the head line and the failure");
		assert.equal(text, `${head}\n\n✗ scout: spawn refused for the interrupt test`);
		const details = (result as { details?: unknown }).details as
			| { runId?: string; handles?: unknown[]; interrupted?: boolean; stillRunning?: string[] }
			| undefined;
		assert.equal(details?.interrupted, true);
		assert.deepEqual(details?.handles, []);
		assert.equal(details?.stillRunning, undefined, "nothing survives to report as still running");
		assert.match(details?.runId ?? "", /^r-[0-9a-z]+$/i, "the run id is reported even when every launch failed");
		assert.equal(
			existsSync(path.join(harness.cwd, ".pi-subagents", "runs", details?.runId ?? "")),
			true,
			"the reported run id names a run directory that exists on disk",
		);
	} finally {
		await harness.cleanup();
	}
});

// #227 review F6: the two interrupt cases above cover all-success and all-failed.
// The mixed shape (one launch refused, one collected, then an abort) is the only
// one where the segment order is observable, so pin it before someone reorders
// the concatenation and silently buries the failure line.
test("vexillatio interrupt keeps failure lines before collected segments (#227 D4)", async () => {
	const harness = indexHarness(
		{ disableBuiltins: true },
		{ "scout.md": UTILITY_FILE },
		{ autoSettle: false, immediateTimeout: false },
	);
	try {
		harness.startTurn();
		const controller = new AbortController();
		// Three tasks so all three states coexist at abort time: one launch is
		// refused, one finishes, and one is still in-turn when the parent aborts.
		// Only this mixed shape makes the segment order observable.
		const originalSpawn = harness.supervisor.spawnChild.bind(harness.supervisor);
		let spawns = 0;
		harness.supervisor.spawnChild = async (input) => {
			spawns += 1;
			if (spawns === 1) throw new Error("spawn refused for the mixed interrupt test");
			return originalSpawn(input);
		};
		const pending = harness.utilityTool.execute(
			"vexillatio-interrupt-mixed",
			{
				task: "one refused, one collected, one in-turn",
				tasks: [
					{ agent: "scout", task: "never launches", cwd: harness.cwd },
					{ agent: "scout", task: "finish before the interrupt", cwd: harness.cwd },
					{ agent: "scout", task: "stay in-turn until the interrupt", cwd: harness.cwd },
				],
				cwd: harness.cwd,
				timeoutMs: 600_000,
			},
			controller.signal,
			undefined,
			{ cwd: harness.cwd, hasUI: false, ui: { notify() {}, setStatus() {} } },
		);
		for (let i = 0; i < 400 && harness.supervisor.spawns.length < 2; i += 1) {
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
		const names = harness.supervisor.spawns.map((spawn) => spawn.input.name);
		assert.equal(names.length, 2, "the two runnable utilities spawned");
		const [finished, inTurn] = names as [string, string];
		harness.supervisor.settle(finished, { text: "collected-before-the-interrupt" });
		for (let i = 0; i < 600; i += 1) {
			if (harness.supervisor.calls.some((call) => call.method === "retire" && call.name === finished)) break;
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		assert.equal(harness.supervisor.isAlive(inTurn), true, "the third utility is still in-turn at abort time");
		controller.abort();
		const settled = await Promise.race([
			pending,
			new Promise<undefined>((resolve) => { setTimeout(() => resolve(undefined), 5_000); }),
		]);
		assert.ok(settled, "the mixed interrupt still returns");
		const text = (settled.content ?? []).map((item) => item.text ?? "").join("\n");
		const head = "interrupted (parent turn ended; children still running)";
		const failedAt = text.indexOf("✗ scout: spawn refused for the mixed interrupt test");
		const collectedAt = text.indexOf("collected-before-the-interrupt");
		assert.ok(text.startsWith(head), "the frozen head line still leads the result");
		assert.ok(failedAt > 0, "the launch failure survives the interrupt");
		assert.ok(collectedAt > 0, "the collected segment survives the interrupt");
		assert.ok(failedAt < collectedAt, "failure lines stay ahead of the collected segments");
		const details = (settled as { details?: unknown }).details as
			| { handles?: Array<{ name: string }>; interrupted?: boolean; stillRunning?: string[] }
			| undefined;
		assert.equal(details?.interrupted, true, "details mark the interruption");
		assert.equal(details?.handles?.length, 2, "the refused launch has no handle");
		assert.deepEqual(details?.handles?.map((handle) => handle.name), names);
		assert.deepEqual(details?.stillRunning, [inTurn], "only the in-turn utility is still running");
	} finally {
		await harness.cleanup();
	}
});
