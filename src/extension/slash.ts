/** Slash command handlers for the `/legion` command and its subcommands. */

import * as fs from "node:fs";
import * as path from "node:path";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type {
	AgentConfig,
	AgentScope,
	SubagentsSettings,
} from "../shared/types.ts";
import { classifyModelOrigin, resolveStepModel } from "../agents/step-model.ts";
import { checkModelScope } from "../agents/model-scope.ts";
import { nativeModelFor } from "../runs/kind.ts";
import {
	DEFAULT_TEAM,
	TEAM_ENV,
	listTeamNames,
	type ActiveTeam,
} from "../agents/teams.ts";
import { getAgentDir } from "../agents/paths.ts";

export const SLASH_TEXT_RESULT_TYPE = "subagent-slash-text";

export interface LegionSubcommand {
	description: string;
	getArgumentCompletions?: (prefix: string) => Array<{ value: string; label: string }> | null;
	handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
}

export type TeamCommandArgs =
	| { action: "show" }
	| { action: "list" }
	| { action: "use"; name: string; global: boolean }
	| { action: "create"; name: string; members: string[]; global: boolean };

/** Pure parser for /legion team arguments. */
export function parseTeamCommandArgs(
	args: string,
): { ok: true; value: TeamCommandArgs } | { ok: false; message: string } {
	const usage =
		"Usage: /legion team [list|use <name> [--global]|create <name> a,b,c [--global]]";
	const trimmed = args.trim();
	if (!trimmed) return { ok: true, value: { action: "show" } };
	const tokens = trimmed.split(/\s+/).filter(Boolean);
	const action = tokens.shift();
	if (action === "list" && tokens.length === 0)
		return { ok: true, value: { action: "list" } };
	if (action !== "use" && action !== "create")
		return { ok: false, message: usage };
	const global = tokens.includes("--global");
	const rest = tokens.filter((token) => token !== "--global");
	if (tokens.filter((token) => token === "--global").length > 1)
		return { ok: false, message: usage };
	if (action === "use") {
		if (rest.length !== 1 || !rest[0]?.trim())
			return { ok: false, message: usage };
		return { ok: true, value: { action, name: rest[0].trim(), global } };
	}
	if (rest.length < 2 || !rest[0]?.trim())
		return { ok: false, message: usage };
	const memberText = rest.slice(1).join(" ");
	const rawMembers = memberText.split(",");
	const members = rawMembers.map((member) => member.trim());
	if (members.some((member) => !member))
		return { ok: false, message: usage };
	return {
		ok: true,
		value: { action, name: rest[0].trim(), members, global },
	};
}

export function sendSlashText(pi: ExtensionAPI, text: string): void {
	pi.sendMessage({
		customType: SLASH_TEXT_RESULT_TYPE,
		content: text,
		display: true,
	});
}

async function withSlashStatus<T>(
	ctx: ExtensionContext,
	text: string,
	run: () => Promise<T>,
): Promise<T> {
	if (ctx.hasUI) ctx.ui.setStatus("subagent-slash-text", text);
	try {
		return await run();
	} finally {
		if (ctx.hasUI) ctx.ui.setStatus("subagent-slash-text", undefined);
	}
}

function notifyError(ctx: ExtensionCommandContext, error: unknown): void {
	ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
}

function assertCreatableTeamName(
	name: string,
	...catalogs: Array<Record<string, unknown>>
): void {
	if (name === DEFAULT_TEAM || name === "__proto__") {
		throw new Error(`Team name "${name}" is reserved.`);
	}
	if (catalogs.some((teams) => Object.hasOwn(teams, name))) {
		throw new Error(`Team "${name}" already exists; edit it manually instead.`);
	}
}

// ── /legion agents ─────────────────────────────────────────────────────────

const AGENT_SCOPES = ["user", "project", "both"] as const;

/** Parse the optional scope argument; empty means the tool default (`user`). */
export function parseAgentsScopeArg(
	args: string,
	usage: string,
): { ok: true; scope: AgentScope | undefined } | { ok: false; message: string } {
	const parts = args.trim().split(/\s+/).filter(Boolean);
	if (parts.length === 0) return { ok: true, scope: undefined };
	if (parts.length > 1) return { ok: false, message: usage };
	const scope = parts[0] as AgentScope;
	if (!AGENT_SCOPES.includes(scope)) return { ok: false, message: usage };
	return { ok: true, scope };
}

/**
 * Render the /legion agents listing.
 *
 * Pure function of its inputs so tests can drive it directly. `dispatchModel`
 * is the parent session model as `provider/id` (when known) — supplied so the
 * `model:` line matches what a launch from THIS session would actually use;
 * omit it and roles without an explicit model say so instead of guessing.
 */
export function renderAgentsListing(input: {
	agents: AgentConfig[];
	team?: ActiveTeam;
	teamWarnings?: string[];
	scope: AgentScope;
	projectAgentsDir: string | null;
	builtinAgentsDir: string;
	userAgentsDir?: string;
	settings: SubagentsSettings;
	dispatchModel?: string;
}): string {
	const { agents, scope } = input;
	const lines: string[] = ["Subagent roles", `Scope: ${scope}`];
	const teamWarnings = input.teamWarnings ?? [];
	if (input.team && (input.team.name !== DEFAULT_TEAM || teamWarnings.length > 0)) {
		lines.push(`Active team: ${input.team.name} (source: ${input.team.source})`);
	}
	lines.push(...teamWarnings.map((warning) => `Warning: ${warning}`));

	const groupOrder: Array<AgentConfig["source"]> = ["builtin", "user", "project"];
	for (const group of groupOrder) {
		const members = agents.filter((a) => a.source === group);
		if (members.length === 0) continue;
		lines.push("", `${group} (${members.length})`);
		for (const agent of members) {
			lines.push(renderOneAgent(agent, input));
		}
	}

	if (agents.length === 0) {
		lines.push(
			"",
			"No agents found. Add definitions to ~/.pi/agent/agents/*.md or .pi/agents/*.md.",
		);
	}

	lines.push(
		"",
		"Directories",
		`  builtin: ${input.builtinAgentsDir}`,
		`  user: ${input.userAgentsDir ?? "~/.pi/agent/agents"}${
			scope === "project" ? " (skipped by scope)" : ""
		}`,
		`  project: ${input.projectAgentsDir ?? "(none found)"}`,
	);
	if (input.settings.disableBuiltins === true) {
		lines.push(
			"  (builtin layer disabled by subagents.disableBuiltins)",
		);
	}
	return lines.join("\n");
}

function renderOneAgent(
	agent: AgentConfig,
	input: {
		settings: SubagentsSettings;
		dispatchModel?: string;
	},
): string {
	const lines: string[] = [`  ${agent.name}`];
	lines.push(`    ${agent.description}`);

	const details: string[] = [];
	if (agent.kind !== "pi") details.push(`kind=${agent.kind}`);
	if (agent.alias?.length) details.push(`alias: ${agent.alias.join(", ")}`);

	// Model resolution mirrors the launch path (resolveStepModel) so the line
	// reports what a launch from this session would use — a preset's
	// kind/model/thinking fold in, and precedence is the real one.
	try {
		const resolved = resolveStepModel({
			agent,
			step: {},
			params: {},
			settings: input.settings,
			...(input.dispatchModel ? { dispatchModel: input.dispatchModel } : {}),
		});
		if (resolved.resolved.model) {
			details.push(modelLine(agent, resolved, input.settings));
		} else {
			details.push("model: (agent CLI default)");
		}
	} catch {
		// An undefined preset or an incoherent kind/model pair throws here —
		// the launch would refuse too. Report it instead of guessing.
		details.push(
			`model: ${agent.model ?? "(agent CLI default)"} (unresolvable — a launch with this configuration would be refused)`,
		);
	}
	lines.push(`    ${details.join(" · ")}`);

	lines.push(`    file: ${agent.filePath}`);
	if (agent.unenforcedFields?.length) {
		lines.push(
			`    ⚠ not enforced yet: ${agent.unenforcedFields.join(", ")}`,
		);
	}
	return lines.join("\n");
}

/**
 * The `model:` detail line, including everything the LAUNCH path would do
 * with that model. Three behaviours are replicated so the listing tells the
 * truth about a launch instead of just naming the model:
 *
 *   - `classifyModelOrigin` (the launch path's own classifier) — so a parent
 *     model falling through is labelled `parent session model`, never
 *     `per-run override` (which cannot happen from this command: step and
 *     params are empty).
 *   - `checkModelScope` — an out-of-scope model is flagged exactly like
 *     `launchStep` would flag it (error-severity for explicit models).
 *   - `nativeModelFor` — a model the target kind cannot express is either a
 *     launch refusal (explicit origin, mirroring `planModelCandidates`) or a
 *     documented drop to the CLI's own default (inherited origin).
 */
function modelLine(
	agent: AgentConfig,
	resolved: ReturnType<typeof resolveStepModel>,
	settings: SubagentsSettings,
): string {
	const model = resolved.resolved.model as string;
	const { origin, label } = classifyModelOrigin(resolved.resolved, undefined);

	const parts = [`model: ${model} (${label ?? "resolved"})`];

	// Same settings, same severity semantics as `launchStep`.
	const violation = checkModelScope(
		model,
		settings.modelScope,
		origin === "explicit" ? "explicit" : "inherited",
	);
	if (violation) {
		parts.push(
			violation.severity === "error"
				? `✗ outside model scope — a launch would refuse this`
				: `⚠ outside model scope — a launch would warn`,
		);
	}

	// Kind/model coherence: a model the target CLI cannot express.
	if (agent.kind !== "pi") {
		const native = nativeModelFor(agent.kind, model, agent.thinking);
		if (native === undefined) {
			if (origin === "explicit") {
				parts.push(
					`✗ cannot be used with kind '${agent.kind}' — a launch would refuse this`,
				);
			} else {
				parts.push(
					`dropped at launch: kind '${agent.kind}' runs on its own default`,
				);
			}
		}
	}

	return parts.join(" · ");
}

export interface AgentsCommandDeps {
	/** Load the agent catalog the same way the subagent tool does. */
	loadCatalog: (input: {
		sessionCwd: string;
		runCwd: string;
		scope: AgentScope | undefined;
	}) => {
		agents: AgentConfig[];
		settings: SubagentsSettings;
		team?: ActiveTeam;
		teamWarnings?: string[];
		projectAgentsDir: string | null;
		builtinAgentsDir: string;
		userAgentsDir?: string;
	};
}

export interface TeamCommandDeps {
	loadCatalog: (input: {
		sessionCwd: string;
		runCwd: string;
		scope: AgentScope | undefined;
	}) => {
		agents: AgentConfig[];
		allAgents: AgentConfig[];
		settings: SubagentsSettings;
		team: ActiveTeam;
		teamWarnings: string[];
	};
}

/** Parsed `/legion on|off` arguments. */
export type ToggleCommandArgs = { action: "on" } | { action: "off" };

/** Pure parser for `/legion on|off` arguments. */
export function parseToggleCommandArgs(
	args: string,
): { ok: true; value: ToggleCommandArgs } | { ok: false; message: string } {
	const usage = "Usage: /legion on|off";
	const trimmed = args.trim();
	if (trimmed === "on" || trimmed === "off") {
		return { ok: true, value: { action: trimmed } };
	}
	return { ok: false, message: usage };
}

export interface ToggleCommandDeps {
	/** Whether subagents are currently enabled in THIS session (session-level override included). */
	sessionEnabled: () => boolean;
	/** Set the session-level override without touching settings files. */
	setSessionEnabled: (enabled: boolean) => void;
	/** Effective `subagents.enabled` from merged settings, for display. */
	settingsEnabled: (cwd: string) => boolean;
	/** Count of currently running children, to warn before turning off mid-flight. */
	runningChildren: () => number;
}

/** Render the status line shown after `/legion on|off`. */
export function renderToggleStatus(input: {
	enabled: boolean;
	settingsEnabled: boolean;
	outcome: "flipped" | "already-on" | "already-off";
	running: number;
}): string {
	const state = input.enabled ? "enabled" : "disabled";
	const origin = input.enabled === input.settingsEnabled
		? "matches settings"
		: "session override (settings unchanged; /reload restores them)";
	const lines = [`Subagents are ${state} — ${origin}.`];
	switch (input.outcome) {
		case "flipped":
			lines.push(
				input.enabled
					? "New launches are accepted again; the roster returns with the next turn."
					: "No new launches; the roster and the bash dispatch guard are off from the next turn. Existing children are untouched — status/collect/wait keep working.",
			);
			break;
		case "already-on":
			lines.push("Already enabled — nothing to do.");
			break;
		case "already-off":
			lines.push("Already disabled — nothing to do.");
			break;
	}
	if (input.running > 0)
		lines.push(
			`${input.running} child${input.running === 1 ? "" : "ren"} still running; they finish and notify normally.`,
		);
	return lines.join("\n");
}

/** Build the `/legion on|off` session-level enable/disable handler. */
export function createToggleCommand(
	pi: ExtensionAPI,
	deps: ToggleCommandDeps,
): LegionSubcommand {
	return {
		description:
			"Temporarily disable/enable subagents for this session (no files are changed)",
		getArgumentCompletions: (prefix) => {
			if (prefix.includes(" ")) return null;
			return ["on", "off"]
				.flatMap((value) => (value.startsWith(prefix) ? [{ value, label: value }] : []));
		},
		handler: async (args, ctx) => {
			const parsed = parseToggleCommandArgs(args);
			if (parsed.ok === false) {
				ctx.ui.notify(parsed.message, "error");
				return;
			}
			const enabled = deps.sessionEnabled();
			const running = deps.runningChildren();
			const next = parsed.value.action === "on";
			const outcome = enabled === next
				? next ? "already-on" : "already-off"
				: "flipped";
			deps.setSessionEnabled(next);
			sendSlashText(
				pi,
				renderToggleStatus({
					enabled: next,
					settingsEnabled: deps.settingsEnabled(ctx.cwd),
					outcome,
					running,
				}),
			);
		},
	};
}

/** Build the `/legion agents [user|project|both]` handler. */
export function createAgentsCommand(
	pi: ExtensionAPI,
	deps: AgentsCommandDeps,
): LegionSubcommand {
	return {
		description:
			"List available subagent roles (use /legion agents [user|project|both] to pick a scope)",
		getArgumentCompletions: (prefix) => {
			if (prefix.includes(" ")) return null;
			return AGENT_SCOPES.filter((scope) => scope.startsWith(prefix)).map(
				(scope) => ({ value: scope, label: scope }),
			);
		},
		handler: async (args, ctx) => {
			const usage = "Usage: /legion agents [user|project|both]";
			const parsed = parseAgentsScopeArg(args, usage);
			if (parsed.ok === false) {
				ctx.ui.notify(parsed.message, "error");
				return;
			}
			try {
				await withSlashStatus(ctx, "Loading subagent roles…", async () => {
					const catalog = deps.loadCatalog({
						sessionCwd: ctx.cwd,
						runCwd: ctx.cwd,
						scope: parsed.scope,
					});
					const dispatchModel = ctx.model
						? `${ctx.model.provider}/${ctx.model.id}`
						: undefined;
					const teamWarnings = catalog.teamWarnings ?? [];
					sendSlashText(
						pi,
						renderAgentsListing({
							agents: catalog.agents,
							...(catalog.team &&
							(catalog.team.name !== DEFAULT_TEAM || teamWarnings.length > 0)
								? { team: catalog.team }
								: {}),
							teamWarnings,
							scope: parsed.scope ?? "user",
							projectAgentsDir: catalog.projectAgentsDir,
							builtinAgentsDir: catalog.builtinAgentsDir,
							...(catalog.userAgentsDir
								? { userAgentsDir: catalog.userAgentsDir }
								: {}),
							settings: catalog.settings,
							...(dispatchModel ? { dispatchModel } : {}),
						}),
					);
				});
			} catch (error) {
				notifyError(ctx, error);
			}
		},
	};
}

/** Render the current team status for the no-argument command. */
export function renderTeamStatus(input: {
	agents: AgentConfig[];
	team: ActiveTeam;
	warnings?: string[];
}): string {
	const members = input.agents.map((agent) => agent.name);
	const source = input.team.source;
	const lines = [
		`Active subagent team: ${input.team.name}`,
		`Source: ${source}`,
		`Members (${members.length}): ${members.join(", ") || "(none)"}`,
	];
	for (const warning of input.warnings ?? []) lines.push(`Warning: ${warning}`);
	return lines.join("\n");
}

function readSettingsFile(filePath: string): Record<string, unknown> {
	if (!fs.existsSync(filePath)) return {};
	const raw = fs.readFileSync(filePath, "utf-8");
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw) as unknown;
	} catch (error) {
		throw new Error(
			`Invalid JSON in '${filePath}': ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error(`File '${filePath}' must contain a JSON object.`);
	}
	return parsed as Record<string, unknown>;
}

function writeJsonFile(filePath: string, value: unknown): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

/** Preserve all unrelated settings while changing one subagents field. */
export function updateSubagentSettingsFile(
	filePath: string,
	update: (subagents: Record<string, unknown>) => void,
): void {
	const document = readSettingsFile(filePath);
	const raw = document.subagents;
	if (
		raw !== undefined &&
		(!raw || typeof raw !== "object" || Array.isArray(raw))
	) {
		throw new Error(`Settings file '${filePath}' has an invalid 'subagents' object.`);
	}
	const subagents = { ...(raw as Record<string, unknown> | undefined) };
	update(subagents);
	document.subagents = subagents;
	writeJsonFile(filePath, document);
}

/** Build the `/legion team [list|use|create]` handler. */
export function createTeamCommand(
	pi: ExtensionAPI,
	deps: TeamCommandDeps,
): LegionSubcommand {
	let completionCwd = process.cwd();
	return {
		description: "Show, list, switch, or create subagent teams",
		getArgumentCompletions: (prefix) => {
			const trimmed = prefix.trimStart();
			if (!trimmed.includes(" ")) {
				return ["list", "use", "create"]
					.filter((value) => value.startsWith(trimmed))
					.map((value) => ({ value, label: value }));
			}
			const useMatch = /^use\s+(.*)$/.exec(trimmed);
			if (!useMatch) return null;
			const namePrefix = useMatch[1] ?? "";
			if (namePrefix.includes(" ")) return null;
			const catalog = deps.loadCatalog({
				sessionCwd: completionCwd,
				runCwd: completionCwd,
				scope: undefined,
			});
			return listTeamNames(catalog.settings)
				.filter((name) => name.startsWith(namePrefix))
				.map((name) => ({ value: `use ${name}`, label: name }));
		},
		handler: async (args, ctx) => {
			completionCwd = ctx.cwd;
			const parsed = parseTeamCommandArgs(args);
			if (parsed.ok === false) {
				ctx.ui.notify(parsed.message, "error");
				return;
			}
			try {
				await withSlashStatus(ctx, "Loading subagent teams…", async () => {
					const catalog = deps.loadCatalog({
						sessionCwd: ctx.cwd,
						runCwd: ctx.cwd,
						scope: undefined,
					});
					const team = catalog.team;
					const warnings = catalog.teamWarnings;
					const settingsPath = (global: boolean): string =>
						path.join(
							global ? getAgentDir() : ctx.cwd,
							...(global ? [] : [".pi"]),
							"settings.json",
						);
					if (parsed.value.action === "show") {
						sendSlashText(
							pi,
							renderTeamStatus({
								agents: catalog.agents,
								team,
								warnings,
							}),
						);
						return;
					}
					if (parsed.value.action === "list") {
						const names = listTeamNames(catalog.settings);
						const lines = ["Subagent teams"];
						for (const name of names) {
							const teams = catalog.settings.teams ?? {};
							const config = Object.hasOwn(teams, name) ? teams[name] : undefined;
							const marker = name === team.name ? "* " : "  ";
							const description =
								name === DEFAULT_TEAM
									? "all discovered agents"
									: config?.description ?? "(no description)";
							const count =
								name === DEFAULT_TEAM
									? catalog.allAgents.length
									: config?.members.length ?? 0;
							lines.push(`${marker}${name} — ${description} (${count} members)`);
						}
						if (!names.includes(team.name)) {
							lines.push(`* ${team.name} — (not defined; using all agents)`);
						}
						if (warnings.length) lines.push(...warnings.map((w) => `Warning: ${w}`));
						sendSlashText(pi, lines.join("\n"));
						return;
					}

					const command = parsed.value;
					const available = listTeamNames(catalog.settings);
					const target = settingsPath(command.global);
					if (command.action === "use") {
						const teams = catalog.settings.teams ?? {};
						if (
							command.name !== DEFAULT_TEAM &&
							!Object.hasOwn(teams, command.name)
						) {
							throw new Error(
								`Unknown team "${command.name}". Available: ${available.join(", ")}.`,
							);
						}
						updateSubagentSettingsFile(target, (subagents) => {
							subagents.team = command.name;
						});
						const envNotice = process.env[TEAM_ENV]?.trim()
							? ` Environment ${TEAM_ENV} is set and overrides this setting.`
							: "";
						sendSlashText(
							pi,
							`Subagent team set to "${command.name}" in ${target}.${envNotice} Next prompt will use it.`,
						);
						return;
					}
					updateSubagentSettingsFile(target, (subagents) => {
						const fileTeams = subagents.teams;
						if (
							fileTeams !== undefined &&
							(!fileTeams || typeof fileTeams !== "object" || Array.isArray(fileTeams))
						) {
							throw new Error(`Settings file '${target}' has an invalid 'subagents.teams' object.`);
						}
						const teams = Object.assign(
							Object.create(null) as Record<string, unknown>,
							fileTeams as Record<string, unknown> | undefined,
						);
						assertCreatableTeamName(command.name, catalog.settings.teams ?? {}, teams);
						teams[command.name] = { members: command.members };
						subagents.teams = teams;
					});
					sendSlashText(
						pi,
						`Created subagent team ${command.name}. Select it with /legion team use ${command.name}`,
					);
				});
			} catch (error) {
				notifyError(ctx, error);
			}
		},
	};
}
