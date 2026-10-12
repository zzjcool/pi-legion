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
	registerTeamCommand,
	renderAgentsListing,
	updateSubagentSettingsFile,
} from "../../src/extension/slash.ts";
import { readSubagentProfile } from "../../src/profiles/profiles.ts";
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
import herdrSubagents from "../../index.ts";

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
	registerTeamCommand(pi, { loadCatalog: () => catalog });
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
			"Created subagent team backend. Select it with /subagents-team use backend",
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
			"Created subagent team backend. Select it with /subagents-team use backend",
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
		'✗ unknown agent "worker" in team "frontend". Available: designer. Switch with /subagents-team use frontend (or "default").',
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

test("profiles: malformed JSON error includes the file path", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "teams-profile-json-"));
	try {
		const profiles = path.join(dir, "profiles", "pi-legion");
		mkdirSync(profiles, { recursive: true });
		const file = path.join(profiles, "broken.json");
		writeFileSync(file, "{ invalid");
		assert.throws(
			() => readSubagentProfile("broken", { agentDir: dir }),
			new RegExp(`Invalid JSON in '${file.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}'`),
		);
	} finally {
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
	tool: { execute: (...args: unknown[]) => Promise<{ content?: Array<{ text?: string }> }> };
	shutdown(): Promise<void>;
	cleanup(): Promise<void>;
} {
	const cwd = mkdtempSync(path.join(tmpdir(), "teams-index-rpc-"));
	const names = ["PI_SUBAGENT_CHILD", "PI_CODING_AGENT_DIR", "PI_HERDR_SUBAGENTS_EXTRA_AGENT_DIRS", "PI_LEGION_DB", "PI_LEGION_NODE_ID", TEAM_ENV];
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
	for (const name of ["PI_LEGION_DB", "PI_LEGION_NODE_ID", TEAM_ENV]) delete process.env[name];
	const supervisor = new FakeSupervisor({
		immediateTimeout: supervisorOptions.immediateTimeout ?? true,
		...(supervisorOptions.autoSettle === false ? {} : { autoSettle: { text: `{"ok":true,"reason":"fake RPC child completed"}` } }),
	});
	const tools: Array<Record<string, unknown>> = [];
	const sentMessages: unknown[] = [];
	const handlers = new Map<string, (...args: any[]) => unknown>();
	const pi = {
		registerTool(tool: unknown) { tools.push(tool as Record<string, unknown>); },
		registerCommand() {}, registerMessageRenderer() {}, sendMessage(message: unknown) { sentMessages.push(message); },
		events: { emit() {} },
		on(name: string, handler: (...args: any[]) => unknown) { handlers.set(name, handler); },
	};
	herdrSubagents(pi as never, { supervisor, ...(verifyRunner ? { verifyRunner } : {}) });
	const tool = tools.find((entry) => entry.name === "subagent") as {
		execute: (...args: unknown[]) => Promise<{ content?: Array<{ text?: string }> }>;
	};
	assert.ok(tool, "subagent tool registered through the index entry point");
	return {
		cwd, supervisor, sentMessages, tool,
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
const DESIGNER_FILE = "---\nname: designer\ndescription: designer role\nkind: cursor\n---\ndesigner prompt\n";

async function invokeIndex(
	harness: ReturnType<typeof indexHarness>,
	params: Record<string, unknown>,
): Promise<string> {
	const result = await harness.tool.execute(
		"teams-test", params, undefined, undefined,
		{ cwd: harness.cwd, hasUI: false, ui: { notify() {}, setStatus() {} } },
	);
	return (result.content ?? []).map((item) => item.text ?? "").join("\n");
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

test("index launch abort retires the child spawned while the parent turn was canceled", async () => {
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
			{ agent: "worker", task: "do not keep a canceled launch", async: true, worktree: false },
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
		assert.match((result.content ?? []).map((item) => item.text ?? "").join("\n"), /abandoned because parent turn aborted/);
		assert.equal(harness.supervisor.isAlive(handle.name), false, "an abandoned launch is retired without starting a watch");
		const records = new RunStore({ rootDir: path.join(harness.cwd, ".pi-subagents") }).listRuns();
		const child = records.flatMap((run) => run.children).find((entry) => entry.name === handle.name);
		assert.equal(child?.state, "retired");
		assert.equal(child?.execution?.status, "failed", "the abandoned launch persists a failed run outcome");
		assert.equal(harness.sentMessages.length, 0, "the abandoned child was never watched");
	} finally {
		releaseSpawn();
		await harness.cleanup();
	}
});

test("index collect abort returns promptly and leaves the RPC child running", async () => {
	const harness = indexHarness(
		{ disableBuiltins: true },
		{ "worker.md": WORKER_FILE },
		{ autoSettle: false, immediateTimeout: false },
	);
	try {
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
		assert.match((result.content ?? []).map((item) => item.text ?? "").join("\n"), /interrupted \(parent turn aborted\)/);
		assert.equal(harness.supervisor.isAlive(name), true, "collect abort does not retire the child");

		harness.supervisor.settle(name, { text: "the child completed after Esc" });
		const deadline = Date.now() + 5_000;
		while (harness.supervisor.isAlive(name)) {
			if (Date.now() > deadline) throw new Error("watch did not retire the completed child");
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
	} finally {
		await harness.cleanup();
	}
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
		assert.match(text, /supervisor=rpc/);
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
		assert.match(text, /supervisor=rpc/);
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
		assert.match(text, /supervisor=rpc/);
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
