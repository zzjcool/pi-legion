/**
 * Build the `pi` CLI argv for a child agent.
 *
 * Design refs: §9 (launch), §6.1 (agent config).
 * Measured refs: F1 (session path), F3/F4 (session pre-creation), F17 (name rules).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
	type AgentConfig,
	THINKING_LEVELS,
	isThinkingLevel,
} from "../shared/types.ts";
import { formatChildTask } from "../extension/child-guard.ts";
import { discoveredHostExtensions, inheritedExtensions, matchesExcludedExtension } from "./extension-inheritance.ts";

/** Re-exported for callers that only need the level list. */
export { THINKING_LEVELS };

/**
 * Append `:<thinking>` to a model id, unless it already carries a known suffix.
 *
 * Mirrors pi-subagents: an explicit `provider/model:level` wins over the
 * agent's `thinking` setting unless `replaceExisting` is set.
 */
export function applyThinkingSuffix(
	model: string | undefined,
	thinking: string | false | undefined,
	replaceExisting = false,
): string | undefined {
	if (!model || !thinking) return model;
	const colonIdx = model.lastIndexOf(":");
	if (colonIdx !== -1 && isThinkingLevel(model.slice(colonIdx + 1))) {
		return replaceExisting ? `${model.slice(0, colonIdx)}:${thinking}` : model;
	}
	return `${model}:${thinking}`;
}

/**
 * Task text longer than this is passed via a file to avoid argv limits.
 *
 * NOTE: length is NOT the only reason to use a file — see `pushTaskArg`.
 */
export const TASK_ARG_LIMIT = 8_000;

/** Legion identity is inherited through every RPC child environment. */
export const LEGION_DB_ENV = "PI_LEGION_DB";
export const LEGION_NODE_ID_ENV = "PI_LEGION_NODE_ID";
export const LEGION_IDENTITY_ENV_KEYS = [
	LEGION_DB_ENV,
	LEGION_NODE_ID_ENV,
	"PI_SUBAGENT_PARENT_PATH",
	"PI_SUBAGENT_MAX_DEPTH",
] as const;

/** Build the identity overlay passed from one legion supervisor to a child. */
export function legionIdentityEnv(dbPath: string, nodeId: string): Record<string, string> {
	if (!dbPath || !path.isAbsolute(dbPath)) throw new TypeError("PI_LEGION_DB must be an absolute path");
	if (!nodeId || nodeId.trim().length === 0) throw new TypeError("PI_LEGION_NODE_ID must be a non-empty node id");
	return { [LEGION_DB_ENV]: dbPath, [LEGION_NODE_ID_ENV]: nodeId };
}

/** Absolute path to this package's extension entry (injected into every child). */
export function childGuardExtensionPath(): string {
	return path.resolve(
		path.dirname(fileURLToPath(import.meta.url)),
		"../../index.ts",
	);
}

export interface BuildArgsInput {
	agent: AgentConfig;
	task: string;
	/** Absolute path to the (pre-created) session file. */
	sessionFile: string;
	/** Resolved model id, may already include a `:thinking` suffix. */
	model?: string;
	/** Provider id for `--provider` when the resolved model id is ambiguous. */
	modelProvider?: string;
	thinking?: string | false;
	/** Where to write an oversized task / system prompt. */
	tempDir: string;
	cwd?: string;
	/** Whether the child may spawn its own subagents. */
	allowNestedSubagents?: boolean;
	/** Isolated worktree branch the child should commit and MR from. */
	worktreeBranch?: string;
	/**
	 * Extra child-side context from `subagents.childContext`, appended to the
	 * system prompt after the role's own prompt (pi) or before the task
	 * (other kinds). Pre-resolved text; `@path` forms are handled upstream.
	 */
	childContext?: string;
	/**
	 * When false, omit `@task.md`; the RPC supervisor delivers the task through
	 * the child Pi process so the session records it as the first user turn.
	 */
	includeTask?: boolean;
	/**
	 * When true, append `--approve` so headless pi trusts the project cwd for
	 * settings / resources / extension discovery (#193). Default false: omit
	 * the flag (v1 never emits `--no-approve`).
	 */
	approve?: boolean;
}

export interface BuildArgsResult {
	args: string[];
	/** Files created under tempDir that the caller should clean up. */
	tempFiles: string[];
}

/**
 * Compose the child argv.
 *
 * Ordering follows pi's CLI: session → model → tools → extensions → skills →
 * system prompt → task.
 */
export function buildPiArgs(input: BuildArgsInput): BuildArgsResult {
	const args: string[] = [];
	const tempFiles: string[] = [];

	// Ordering follows pi's CLI: session → model → tools → extensions → skills
	// → system prompt → task. Each helper appends its own flags.
	args.push("--session", input.sessionFile);
	pushModelArgs(args, input);
	pushToolArgs(args, input.agent);
	pushSkillArgs(args, input.agent);
	pushSystemPromptArgs(args, tempFiles, input);
	if (input.includeTask !== false) pushTaskArg(args, tempFiles, input);
	// Opt-in project trust for headless rpc (#193). Never emit --no-approve in v1.
	if (input.approve === true) args.push("--approve");

	return { args, tempFiles };
}

/** `--model provider/id[:thinking]`, omitted when no model resolved. */
function pushModelArgs(args: string[], input: BuildArgsInput): void {
	const modelArg = applyThinkingSuffix(input.model, input.thinking);
	if (!modelArg) return;
	args.push("--model", modelArg);
	// Pin the provider so a bare model id cannot be hijacked by a colliding
	// static provider in models.json (#123: `workbuddy/...` ids also exist under
	// a provider with no usable auth; under `--no-extensions` the child resolved
	// them there and died with "No API key found"). Models may carry their own
	// slash (e.g. `any-endpoint/workbuddy/hy4-preview-ioa`), so only the longest
	// known provider prefix qualifies; an id with no provider stays bare, and
	// `--provider` without `--model` is rejected by pi, so both move together.
	const provider = input.modelProvider;
	if (provider) args.push("--provider", provider);
}

export const CHILD_INHERIT_EXTENSIONS_ENV = "PI_LEGION_CHILD_INHERIT_EXTENSIONS";
/** Extra extension paths every child loads explicitly (comma or path-delimiter separated). */
export const CHILD_EXTENSIONS_ENV = "PI_LEGION_CHILD_EXTENSIONS";

export function childExtraExtensions(env: NodeJS.ProcessEnv = process.env): string[] {
	const raw = env[CHILD_EXTENSIONS_ENV];
	if (!raw) return [];
	return raw.split(new RegExp(`[,${path.delimiter === ";" ? ";" : ":"}]`)).map((p) => p.trim()).filter(Boolean);
}

/**
 * Re-exported from `extension-inheritance.ts`, which owns the policy (#280).
 * Kept here because `args.ts` is the historical import site for the rpc argument
 * builder and `legion-doctor`.
 */
export { childInheritsExtensions } from "./extension-inheritance.ts";

/** Light pi builtin that registers the `codemode` tool (`-e builtin:codemode`). */
export const BUILTIN_CODEMODE = "builtin:codemode";

/** True for `builtin:<name>` refs — must not be `path.resolve`d. */
export function isBuiltinExtensionRef(ext: string): boolean {
	return ext.trimStart().startsWith("builtin:");
}

/** Dedup key for an `--extension` value (path or builtin ref). */
export function extensionDedupeKey(ext: string): string {
	return isBuiltinExtensionRef(ext) ? ext.trim() : path.resolve(ext);
}

export function roleListsCodemode(agent: Pick<AgentConfig, "tools">): boolean {
	return (agent.tools ?? []).some((t) => t === "codemode");
}

export function isCodemodeExtension(ext: string): boolean {
	const t = ext.trim();
	return t === BUILTIN_CODEMODE || t.endsWith("/" + BUILTIN_CODEMODE);
}

/** This package's name — its extension is never inherited, only guarded explicitly. */
export const SELF_EXTENSION_NAME = "pi-legion";

/**
 * Effective `--extension` values for a child.
 *
 * Order is deliberate: inherited host extensions FIRST (they are ambient
 * capabilities the child would otherwise lose), then the role's own explicit
 * list, then `PI_LEGION_CHILD_EXTENSIONS`, then `builtin:codemode` (#89), and
 * finally the child-guard — which is unconditional and never subject to
 * `inheritExtensions` / `excludeExtensions`, because a child without it breaks
 * the prompt/format contract regardless of what the card asked for.
 *
 * #280: the inherited set is computed by `inheritedExtensions` and is empty when
 * the card sets `inheritExtensions: false`; `excludeExtensions` subtracts from
 * it. Inherited paths are subject to the same dedupe as everything else, so a
 * card that also names an inherited extension does not load it twice.
 */
export function collectChildExtensions(
	agent: Pick<
		AgentConfig,
		"tools" | "extensions" | "subagentOnlyExtensions" | "inheritExtensions" | "excludeExtensions"
	>,
	env: NodeJS.ProcessEnv = process.env,
): string[] {
	// `env` MUST be forwarded: `PI_LEGION_CHILD_INHERIT_EXTENSIONS=0` is the
	// operator kill-switch, and dropping it here made the opt-out a no-op for the
	// inherited half of the list while still applying to everything else.
	//
	// Legion's own extension is filtered out of the inherited set. In the
	// installed-copy layout `pi list` reports the same package the child-guard
	// already names, and dedupe collapses them; in the source-tree layout the two
	// paths differ, so the child would load TWO legion factories and die on
	// `Tool "subagent" conflicts with ...`. Self-exclusion makes both layouts
	// converge on exactly one, and the guard below still appends it
	// unconditionally — so a hermetic card does not lose the guard either.
	const inherited = inheritedExtensions(agent, discoveredHostExtensions() ?? [], env).filter(
		(ext) => !matchesExcludedExtension(ext, SELF_EXTENSION_NAME),
	);
	const list = [
		...inherited,
		...(agent.extensions ?? []),
		...(agent.subagentOnlyExtensions ?? []),
		...childExtraExtensions(env),
	];
	// #89: codemode is a light builtin (unlike heavy pi-lens). Keep tools:codemode
	// honest when discovery is disabled via `--no-extensions`.
	if (roleListsCodemode(agent) && !list.some(isCodemodeExtension)) {
		list.push(BUILTIN_CODEMODE);
	}
	list.push(childGuardExtensionPath());
	const seen = new Set<string>();
	const out: string[] = [];
	for (const ext of list) {
		const key = extensionDedupeKey(ext);
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(ext);
	}
	return out;
}

/** `--tools a,b`, `--no-extensions` (unless inherited), plus one `--extension` per explicit extension. */
function pushToolArgs(args: string[], agent: AgentConfig): void {
	const tools = agent.tools?.filter(Boolean) ?? [];
	if (tools.length > 0) {
		if (!agent.utility && !tools.includes("vexillatio")) tools.push("vexillatio");
		args.push("--tools", tools.join(","));
	}

	// #280: pi's own discovery is ALWAYS disabled and the full list is passed
	// explicitly. `--no-extensions` only drops the settings-discovered set; `-e`
	// paths (below) and builtins still load, so this is the shape that keeps the
	// child's extension set exactly equal to what we computed — the inherited set
	// minus `excludeExtensions`, plus the role's own list, plus the child-guard.
	//
	// Letting pi discover as well would silently re-add an extension the card
	// excluded, and would make rpc disagree with in-process (which builds its
	// loader with `noExtensions: true` for the same reason).
	args.push("--no-extensions");
	for (const ext of collectChildExtensions(agent)) {
		args.push("--extension", ext);
	}
}

/**
 * Skills and project context.
 *
 * `inheritSkills: false` must suppress the parent's skills, which `--no-skills`
 * does; otherwise the agent's own list plus any explicit paths are added.
 */
function pushSkillArgs(args: string[], agent: AgentConfig): void {
	if (agent.inheritSkills === false) {
		args.push("--no-skills");
	} else if (Array.isArray(agent.skills) && agent.skills.length > 0) {
		for (const skill of agent.skills) args.push("--skill", skill);
	}
	for (const skillPath of agent.skillPath ?? []) {
		args.push("--skill", skillPath);
	}

	if (agent.inheritProjectContext === false) args.push("--no-context-files");
}

/**
 * Write the system prompt to a file and reference it.
 *
 * Passed by path rather than inline so a long prompt cannot hit the argv limit,
 * and so the file's mode (0600) keeps it out of other users' reach.
 */
function pushSystemPromptArgs(
	args: string[],
	tempFiles: string[],
	input: BuildArgsInput,
): void {
	const systemPrompt = input.agent.systemPrompt?.trim();
	const childContext = input.childContext?.trim();
	if (!systemPrompt && !childContext) return;

	// The child-guard extension, the role prompt, and the settings-injected
	// context are three separate sources with one ordering rule: frozen guards
	// (the extension) < role prompt < machine-specific context (settings). The
	// system-prompt FILE carries role + settings context so a single
	// `--append-system-prompt` flag delivers both.
	const file = path.join(input.tempDir, "system-prompt.md");
	fs.writeFileSync(
		file,
		[systemPrompt, childContext].filter(Boolean).join("\n\n"),
		{ mode: 0o600 },
	);
	tempFiles.push(file);
	// A settings-injected child context must not REPLACE the role prompt, so
	// when a role prompt is present the mode is always the role's own; only a
	// context-only child falls back to append (the safe default).
	const mode = systemPrompt
		? input.agent.systemPromptMode
		: input.agent.systemPromptMode === "replace"
			? "append"
			: input.agent.systemPromptMode;
	args.push(mode === "replace" ? "--system-prompt" : "--append-system-prompt", file);
}

/**
 * The task itself, always written to a file and referenced with `@path`.
 *
 * Two independent reasons make the file the ONLY safe carrier:
 *
 *   F38 — herdr refuses an argv element containing a control character
 *         (newline, tab, CR): `agent start` fails with `invalid_agent_argument`
 *         ("agent arguments cannot be encoded safely for the target shell").
 *         Nearly every real task card is multi-line, so passing the text as a
 *         single argv element made the common case unlaunchable. The flag is
 *         raised for newline AND tab — a quoted string with spaces is fine.
 *   E2BIG — an over-long argv element fails at exec time.
 *
 * pi expands `@path` in the task position, so the child still receives the
 * text; only the transport differs.
 */
function pushTaskArg(
	args: string[],
	tempFiles: string[],
	input: BuildArgsInput,
): void {
	const taskText = formatChildTask(input.task, {
		allowNested: input.allowNestedSubagents === true,
		...(input.worktreeBranch ? { worktreeBranch: input.worktreeBranch } : {}),
	});
	const file = path.join(input.tempDir, "task.md");
	fs.writeFileSync(file, taskText, { mode: 0o600 });
	tempFiles.push(file);
	args.push(`@${file}`);
}
