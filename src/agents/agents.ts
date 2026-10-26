/**
 * Agent discovery: load `agents/*.md` definitions.
 *
 * Design refs: §6.1 (frontmatter fields), §6.2 (model precedence).
 * A single malformed file must never take down the rest of discovery.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
	AGENT_KINDS,
	type AgentConfig,
	type AgentDiscoveryResult,
	type AgentKind,
	type AgentScope,
	type AgentSource,
	type AcceptanceConfig,
	type AcceptanceCriterion,
	type OnBlockedPolicy,
	type SpawnMode,
	type SystemPromptMode,
	type ToolBudgetConfig,
	type TurnBudgetConfig,
} from "../shared/types.ts";
import {
	parseFrontmatter,
	parseFrontmatterList,
	stripQuotes,
} from "./frontmatter.ts";
import { getAgentDir } from "./paths.ts";
import { ignoredKindMessage, reportIgnoredOnce } from "../shared/ignored-kind.ts";
import {
	type PhaseDefinition,
	type PhaseMachine,
	type PhaseTransitionRule,
	normalizePhaseMachine,
	validatePhaseMachine,
} from "../legion/phase-machine.ts";
import type { PhaseCondition } from "../legion/phase-conditions.ts";

export const BUILTIN_AGENT_NAMES = [
	"scout",
	"worker",
	"centurion",
] as const;

/**
 * Agent definitions shipped with this package.
 *
 * Anchored to the module rather than to `~/.pi/agent`, because pi's package
 * resource conventions (`extensions/`, `skills/`, `prompts/`, `themes/`) have no
 * slot for `agents/`. A package manifest entry would be silently ignored, so the
 * bundled roles would never be discovered. Resolving `../../agents` from
 * `src/agents/agents.ts` lands on the package root.
 */
export const BUILTIN_AGENTS_DIR = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
	"agents",
);

/**
 * Extra read-only directories to scan for agent definitions, PATH-style.
 *
 * Lets a hermetic install (Nix store, container, read-only mount) expose bundled
 * or vendored roles without copying them into the writable user agent dir. These
 * load as `user`-level, at LOWER precedence than the real user directory, so a
 * user's own definition of the same name still wins.
 *
 * Canonical env: `PI_LEGION_EXTRA_AGENT_DIRS`. The Herdr-era name
 * `PI_HERDR_SUBAGENTS_EXTRA_AGENT_DIRS` remains a compatibility alias for at
 * least one minor version. When both are set, the new name wins (old ignored).
 */
export const EXTRA_AGENT_DIRS_ENV = "PI_LEGION_EXTRA_AGENT_DIRS";

/** @deprecated Use {@link EXTRA_AGENT_DIRS_ENV} (`PI_LEGION_EXTRA_AGENT_DIRS`). */
export const LEGACY_EXTRA_AGENT_DIRS_ENV = "PI_HERDR_SUBAGENTS_EXTRA_AGENT_DIRS";

let legacyExtraAgentDirsWarned = false;

/** @internal Reset one-shot deprecation warn (unit tests). */
export function resetExtraAgentDirsDeprecationWarnForTests(): void {
	legacyExtraAgentDirsWarned = false;
}

/** Split EXTRA_AGENT_DIRS: colon+semicolon (+comma) on POSIX; comma+semicolon on Windows (drive letters). */
const EXTRA_AGENT_DIRS_SEP = path.delimiter === ";" ? /[,;]/ : /[;:,]/;

function splitExtraAgentDirEntries(raw: string | undefined): string[] {
	if (!raw) return [];
	return raw.split(EXTRA_AGENT_DIRS_SEP).flatMap((entry) => {
		const trimmed = entry.trim();
		return trimmed ? [path.resolve(trimmed)] : [];
	});
}

function envHasContent(value: string | undefined): value is string {
	return value !== undefined && value.trim() !== "";
}

/**
 * Resolve PATH-style extra agent dirs from env.
 *
 * Priority: `PI_LEGION_EXTRA_AGENT_DIRS` overrides
 * `PI_HERDR_SUBAGENTS_EXTRA_AGENT_DIRS` when both are set. Setting the legacy
 * name alone still works and emits one stderr deprecation warning per process.
 */
export function resolveExtraAgentDirs(
	env: NodeJS.ProcessEnv = process.env,
	warn: (message: string) => void = (message) => console.warn(message),
): string[] {
	const modern = env[EXTRA_AGENT_DIRS_ENV];
	const legacy = env[LEGACY_EXTRA_AGENT_DIRS_ENV];
	const hasModern = envHasContent(modern);
	const hasLegacy = envHasContent(legacy);

	if (hasLegacy && !legacyExtraAgentDirsWarned) {
		legacyExtraAgentDirsWarned = true;
		if (hasModern) {
			warn(
				`[pi-legion] Both ${EXTRA_AGENT_DIRS_ENV} and ${LEGACY_EXTRA_AGENT_DIRS_ENV} are set; using ${EXTRA_AGENT_DIRS_ENV} (new name wins). Remove the deprecated ${LEGACY_EXTRA_AGENT_DIRS_ENV}.`,
			);
		} else {
			warn(
				`[pi-legion] ${LEGACY_EXTRA_AGENT_DIRS_ENV} is deprecated; use ${EXTRA_AGENT_DIRS_ENV}. The old name remains as a compatibility alias for at least one minor version.`,
			);
		}
	}

	if (hasModern) return splitExtraAgentDirEntries(modern);
	if (hasLegacy) return splitExtraAgentDirEntries(legacy);
	return [];
}

/** Split env extra-agent-dir entries into absolute directory paths. */
function extraAgentDirs(): string[] {
	return resolveExtraAgentDirs();
}

const VALID_KINDS: ReadonlySet<string> = new Set(AGENT_KINDS);

const VALID_ON_BLOCKED: ReadonlySet<string> = new Set([
	"forward",
	"auto-approve",
	"notify",
]);
const VALID_ACCEPTANCE_LEVELS: ReadonlySet<string> = new Set([
	"none",
	"attested",
	"verified",
]);

const VALID_ACCEPTANCE_ROLES: ReadonlySet<string> = new Set([
	"read-only",
	"writer",
	"unknown",
]);

/** Raw frontmatter values are `unknown`: a YAML scalar or collection may appear. */
type AgentFrontmatter = Record<string, unknown>;

function str(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function bool(value: unknown): boolean | undefined {
	if (typeof value === "boolean") return value;
	if (value === "true") return true;
	if (value === "false") return false;
	return undefined;
}

function int(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isInteger(value)) return value;
	if (typeof value === "string" && /^\d+$/.test(value.trim()))
		return Number(value.trim());
	return undefined;
}


/**
 * Accept `tools: read, bash`, `tools: [read, bash]`, and block-list spellings.
 *
 * The frontmatter parser stores flow arrays as the raw string `[read, bash]`,
 * so strip the brackets before splitting on commas.
 */
function list(value: unknown): string[] | undefined {
	if (Array.isArray(value)) {
		// Single pass: keep strings, trim, drop empties. A filter→map→filter
		// chain walked the array three times for no benefit.
		const items = value.flatMap((v) => {
			if (typeof v !== "string") return [];
			const trimmed = v.trim();
			return trimmed ? [trimmed] : [];
		});
		return items.length > 0 ? items : undefined;
	}
	if (typeof value === "string") {
		const trimmed = value.trim();
		const inner =
			trimmed.startsWith("[") && trimmed.endsWith("]")
				? trimmed.slice(1, -1)
				: trimmed;
		return parseFrontmatterList(inner);
	}
	return undefined;
}

/** `false` is meaningful for skills (disable inheritance), so it is distinct from absent. */
function listOrFalse(value: unknown): string[] | false | undefined {
	if (value === false || value === "false") return false;
	return list(value);
}

/**
 * Parse a small indented YAML block (as returned by the frontmatter parser for
 * a nested key) into a plain object.
 *
 * Supports exactly the shape agent definitions use:
 *
 * ```text
 * level: attested
 * role: read-only
 * criteria:
 *   - id: a
 *     must: something
 *     evidence: [x, y]
 * ```
 *
 * Deliberately minimal — no anchors, no multi-line scalars, no deep nesting
 * beyond one list of objects. Returns `undefined` when the text does not look
 * like a block, so a JSON string still takes the JSON path.
 */
function parseIndentedBlock(text: string): Record<string, unknown> | undefined {
	const lines = text.split("\n");
	// A block always starts with `key:` on the first line.
	if (!/^[A-Za-z_][\w-]*:/.test(lines[0] ?? "")) return undefined;

	const out: Record<string, unknown> = {};
	const state: BlockState = { listKey: null, item: null };

	for (const rawLine of lines) {
		if (!rawLine.trim()) continue;
		const indent = rawLine.length - rawLine.trimStart().length;
		applyBlockLine(out, state, rawLine.trim(), indent);
	}

	// An empty list means the key was a nested map, not a list — drop it.
	for (const [k, v] of Object.entries(out)) {
		if (Array.isArray(v) && v.length === 0) delete out[k];
	}
	return out;
}

/** Parser position: the list currently being filled, and its open item. */
interface BlockState {
	listKey: string | null;
	item: Record<string, unknown> | null;
}

/**
 * Apply one line of an indented block. Three shapes matter:
 *   `- key: value`  a new object in the current list
 *   `key:`          opens a list (or a nested map, resolved at the end)
 *   `key: value`    a scalar, or a continuation of the open list item
 */
function applyBlockLine(
	out: Record<string, unknown>,
	state: BlockState,
	line: string,
	indent: number,
): void {
	const itemMatch = line.match(/^-\s+([A-Za-z_][\w-]*):\s*(.*)$/);
	if (itemMatch && state.listKey) {
		const [, key, value] = itemMatch;
		state.item = { [key as string]: parseScalar(value as string) };
		const arr = out[state.listKey];
		if (Array.isArray(arr)) arr.push(state.item);
		else out[state.listKey] = [state.item];
		return;
	}

	const kvMatch = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
	if (!kvMatch) return;
	const key = kvMatch[1] as string;
	const value = (kvMatch[2] as string).trim();

	if (value === "") {
		// A key with no inline value opens either a nested map or a list.
		state.listKey = key;
		state.item = null;
		out[key] = [];
		return;
	}

	// A deeper-indented line continues the open list item.
	if (state.item && indent > 0) {
		state.item[key] = parseScalar(value);
		return;
	}

	state.listKey = null;
	state.item = null;
	out[key] = parseScalar(value);
}

/**
 * One scalar value from the frontmatter block parser.
 *
 * Deliberately a closed union rather than `unknown`: this parser only ever
 * produces these four shapes, and naming them lets every caller narrow without
 * a cast. `parseScalar` used to return `unknown`, which pushed the unsafe part
 * of parsing onto consumers instead of resolving it here at the boundary.
 */
type Scalar = string | number | boolean | string[];

/** Scalar for the block parser: flow list, number, boolean, or string. */
function parseScalar(raw: string): Scalar {
	const value = raw.trim();
	if (!value) return "";
	if (value.startsWith("[") && value.endsWith("]")) {
		const inner = value.slice(1, -1).trim();
		if (!inner) return [];
		return inner.split(",").flatMap((part) => {
			const item = part.trim();
			return item ? [item] : [];
		});
	}
	if (value === "true") return true;
	if (value === "false") return false;
	return stripQuotes(value);
}

function parseAcceptance(value: unknown, agentName?: string): AcceptanceConfig | undefined {
	const raw = str(value);
	if (!raw) return undefined;

	// Two accepted spellings:
	//   acceptance: '{"level":"attested"}'   (JSON string, one line)
	//   acceptance:                            (nested YAML block, what the
	//     level: attested                      bundled roles use)
	// The frontmatter parser is flat, so a nested block arrives here as text.
	let parsed: Record<string, unknown> | undefined;
	try {
		parsed = JSON.parse(raw) as Record<string, unknown>;
	} catch {
		parsed = parseIndentedBlock(raw);
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
		return undefined;

	const level = str(parsed.level);
	if (!level || !VALID_ACCEPTANCE_LEVELS.has(level)) return undefined;

	const out: AcceptanceConfig = { level: level as AcceptanceConfig["level"] };
	// #172: author-facing role strings are case-insensitive; keep hyphenated canonical forms.
	const role = str(parsed.role)?.toLowerCase();
	if (role && VALID_ACCEPTANCE_ROLES.has(role)) {
		out.role = role as AcceptanceConfig["role"];
	} else if (role) {
		const who = agentName ? `agent "${agentName}"` : "agent";
		console.error(
			`[pi-legion] ${who}: unknown acceptance.role ${JSON.stringify(role)}; expected read-only | writer | unknown.`,
		);
	}
	const criteria = parseCriteria(parsed.criteria);
	if (criteria) out.criteria = criteria;
	return out;
}

/**
 * Parse the `criteria` list.
 *
 * A criterion without both `id` and `must` is dropped rather than kept in a
 * half-filled state: it could not be reported back to the caller usefully.
 * Returns `undefined` when nothing usable remains.
 */
function parseCriteria(value: unknown): AcceptanceCriterion[] | undefined {
	if (!Array.isArray(value)) return undefined;

	const criteria = value.flatMap((entry): AcceptanceCriterion[] => {
		if (!entry || typeof entry !== "object") return [];
		const record = entry as Record<string, unknown>;
		const id = str(record.id);
		const must = str(record.must);
		if (!id || !must) return [];

		const evidence = list(record.evidence);
		const severity = str(record.severity);
		const command = str(record.command);
		return [
			{
				id,
				must,
				...(evidence ? { evidence } : {}),
				...(severity === "required" || severity === "optional"
					? { severity: severity as AcceptanceCriterion["severity"] }
					: {}),
				...(command ? { command } : {}),
			},
		];
	});

	return criteria.length > 0 ? criteria : undefined;
}

/**
 * Read an indented `phases:` block into the machine shape (#298).
 *
 * The shared frontmatter parser is flat — nested lists come back as raw text —
 * so this walks the text itself. The grammar is deliberately tiny and matches
 * only what a card can express:
 *
 * ```text
 * - id: planning                  # a phase
 *   require: [contract_file]      # inline condition list
 *   timeoutMs: 900000
 *   terminal: false
 *   next:                         # a list of transitions
 *     - to: implementing
 *       require: [contract_file]
 *       actorRole: centurion
 *       rework: true
 *     - to: failed
 * ```
 *
 * Anything outside this shape is an error rather than a silent skip, because a
 * half-read machine is worse than none: it would run with the transitions it
 * happened to parse.
 */
function parsePhaseBlock(text: string): PhaseMachine | undefined {
	// `id` is filled from the `- id: ...` line; validatePhaseMachine rejects a
	// machine where it is missing, so the assertion at the end is safe.
	type PhaseDraft = Record<string, unknown> & { id: string; next?: Array<Record<string, unknown>> };
	const phases: PhaseDraft[] = [];
	let currentPhase: PhaseDraft | undefined;
	let currentRule: Record<string, unknown> | undefined;
	// Column where list items live. The first `- ` we see sets it, so the block may
	// be indented by any amount relative to the document.
	let itemIndent = -1;

	const scalar = (value: string): unknown => {
		const trimmed = value.trim();
		if (trimmed === "true") return true;
		if (trimmed === "false") return false;
		if (/^-?\d+$/.test(trimmed)) return Number(trimmed);
		if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
			const inner = trimmed.slice(1, -1).trim();
			if (!inner) return [];
			return inner.split(",").map((part) => part.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
		}
		return trimmed.replace(/^["']|["']$/g, "");
	};

	for (const rawLine of text.split("\n")) {
		if (!rawLine.trim()) continue;
		const indent = rawLine.length - rawLine.trimStart().length;
		const line = rawLine.trim();

		if (line.startsWith("- ")) {
			if (itemIndent === -1) itemIndent = indent;
			const body = line.slice(2).trim();
			const entry: Record<string, unknown> = {};
			const colon = body.indexOf(":");
			if (colon > 0) entry[body.slice(0, colon).trim()] = scalar(body.slice(colon + 1));
			// A `- ` at the item column opens a phase; deeper opens a transition.
			if (indent <= itemIndent) {
				currentPhase = entry as PhaseDraft;
				currentPhase.next = [];
				phases.push(currentPhase);
				currentRule = undefined;
			} else if (currentPhase) {
				currentRule = entry;
				currentPhase.next!.push(entry);
			}
			continue;
		}

		const colon = line.indexOf(":");
		if (colon <= 0) continue;
		const key = line.slice(0, colon).trim();
		const value = line.slice(colon + 1).trim();
		const target = currentRule ?? currentPhase;
		if (!target) continue;
		if (value === "") {
			// `next:` with nothing after it — the transitions follow as `- to:` lines.
			if (key === "next") target.next = target.next ?? [];
			continue;
		}
		target[key] = scalar(value);
	}

	if (phases.length === 0) return undefined;
	// Convert the walked drafts into the declared shape explicitly instead of
	// asserting it. `validatePhaseMachine` runs right after this and rejects
	// anything malformed, but doing the coercion here means the compiler — not just
	// the validator — has seen every field.
	const converted: PhaseDefinition[] = phases.map((draft) => {
		const rules: PhaseTransitionRule[] = (draft.next ?? []).map((rule) => {
			const out: PhaseTransitionRule = { to: String(rule.to ?? "") };
			if (Array.isArray(rule.require)) out.require = rule.require.map(String) as PhaseCondition[];
			if (typeof rule.actorRole === "string") out.actorRole = rule.actorRole;
			if (rule.rework === true) out.rework = true;
			if (rule.notifyParent === true) out.notifyParent = true;
			return out;
		});
		const phase: PhaseDefinition = { id: String(draft.id ?? ""), next: rules };
		if (Array.isArray(draft.require)) phase.require = draft.require.map(String) as PhaseCondition[];
		if (typeof draft.timeoutMs === "number") phase.timeoutMs = draft.timeoutMs;
		if (draft.terminal === true) phase.terminal = true;
		return phase;
	});
	const machine: PhaseMachine = { phases: converted };
	if (typeof (phases as unknown as { start?: unknown }).start === "string") {
		machine.start = String((phases as unknown as { start: string }).start);
	}
	return machine;
}

/**
 * Parse a declared phase machine from `phases:` (#298).
 *
 * Accepts the YAML shape directly (a list of phase objects), or the same thing
 * as a JSON string, matching how `toolBudget` is written.
 *
 * Validation happens HERE, at load, and every problem is reported at once. A
 * machine that only fails mid-run would surface after a team had already spent
 * tokens on a workflow that could never complete.
 */
function parsePhaseMachine(value: unknown, filePath: string): PhaseMachine | undefined {
	if (value === undefined || value === null) return undefined;
	let raw: unknown = value;
	if (typeof value === "string") {
		const text = value.trim();
		if (!text) return undefined;
		// The frontmatter parser is FLAT, so a nested `phases:` block arrives here
		// as raw text — exactly the situation `parseAcceptance` already handles.
		// Two spellings are therefore accepted: an indented YAML block (what the
		// card looks like) and a one-line JSON string (easier to generate).
		let parsedText: unknown;
		let wasJson = true;
		try {
			parsedText = JSON.parse(text);
		} catch {
			wasJson = false;
			parsedText = parsePhaseBlock(text);
		}
		if (!wasJson && parsedText === undefined) {
			throw new Error(
				`Agent '${filePath}' has invalid phases: could not read the block. ` +
					`Expected an indented list of "  - id: <name>" entries, or a JSON string.`,
			);
		}
		raw = parsedText;
	}
	// Accept both `[{...}]` and `{ phases: [...] }`.
	const shaped = Array.isArray(raw)
		? ({ phases: raw } as unknown)
		: raw;
	if (shaped === null || typeof shaped !== "object") {
		throw new Error(`Agent '${filePath}' has invalid phases: expected a list or an object with a 'phases' key.`);
	}
	const machine = shaped as PhaseMachine;
	if (!Array.isArray(machine.phases)) {
		throw new Error(`Agent '${filePath}' has invalid phases: 'phases' must be a list.`);
	}
	// Inject the universal terminals before validating, so reachability is judged
	// on the machine as it will actually run.
	const normalized = normalizePhaseMachine(machine);
	const errors = validatePhaseMachine(normalized);
	if (errors.length > 0) {
		const detail = errors.map((error) => `  - ${error.path}: ${error.message}`).join("\n");
		throw new Error(`Agent '${filePath}' has an invalid phase machine:\n${detail}`);
	}
	return normalized;
}

/**
 * Parse a child budget (`toolBudget` / `turnBudget`) strictly.
 *
 * These used to swallow every error and return `undefined`, so a typo became
 * "no limit" -- the same silent-acceptance failure the frontmatter field check
 * exists to prevent. Worse, a NEGATIVE number was accepted: `-3` reached the
 * child, `toolCalls > -3` was true immediately, and the first tool call was
 * blocked while the author believed they had set a limit of 3.
 *
 * `0` is meaningful here ("no calls allowed", per `extension/budget.ts`), so it
 * must survive rather than decay into "unset". Anything that is not a
 * non-negative integer is an error naming the file and the field.
 */
function parseBudgets(fm: AgentFrontmatter, filePath: string): {
	tool?: ToolBudgetConfig;
	turn?: TurnBudgetConfig;
} {
	const read = (
		field: "toolBudget" | "turnBudget",
		key: "maxToolCalls" | "maxTurns",
	): number | undefined => {
		const raw = str(fm[field]);
		if (!raw) return undefined;
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			throw new Error(
				`Agent '${filePath}' has invalid ${field}: expected a JSON object like '{"${key}": 10}', got '${raw}'.`,
			);
		}
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
			throw new Error(
				`Agent '${filePath}' has invalid ${field}: expected a JSON object with a '${key}' key.`,
			);
		}
		const value = (parsed as Record<string, unknown>)[key];
		if (value === undefined) return undefined;
		if (typeof value !== "number" || !Number.isInteger(value)) {
			throw new Error(
				`Agent '${filePath}' has invalid ${field}.${key}: expected a non-negative integer, got ${JSON.stringify(value)}.`,
			);
		}
		if (value < 0) {
			throw new Error(
				`Agent '${filePath}' has invalid ${field}.${key}: ${value} is negative. ` +
					`0 means "none allowed"; omit the field for "no limit".`,
			);
		}
		return value;
	};
	const toolMax = read("toolBudget", "maxToolCalls");
	const turnMax = read("turnBudget", "maxTurns");
	return {
		...(toolMax !== undefined ? { tool: { maxToolCalls: toolMax } } : {}),
		...(turnMax !== undefined ? { turn: { maxTurns: turnMax } } : {}),
	};
}

/**
 * Every frontmatter key a role card may declare.
 *
 * Kept next to the parser on purpose: an unknown key used to be silently
 * ignored, so a typo (`maxSubagentdepth`, `inheritSkill`) produced a card that
 * looked accepted but did nothing. That is the worst failure mode for a config
 * file — the author believes the setting is in effect. Cards are now validated
 * against this list and an unknown key is a hard error.
 *
 * When adding a field, add it here AND parse it; a name in this list that no
 * parser reads is just as misleading as the reverse.
 */
const AGENT_FRONTMATTER_FIELDS: ReadonlySet<string> = new Set([
	// identity
	"name", "description", "kind", "model", "thinking", "alias", "aliases",
	"preset", "team", "output", "fallbackModels",
	// prompt / context
	"systemPromptMode", "inheritProjectContext", "inheritSkills", "inheritExtensions",
	"excludeExtensions",
	"phases",
	"skillPath", "skills", "defaultReads",
	// tools
	"tools", "extensions", "subagentOnlyExtensions",
	// budgets / guards / lifecycle
	"defaultProgress", "async", "timeoutMs", "toolTimeoutMs", "completionGuard",
	"maxSubagentDepth", "allowNestedSubagents", "renewable", "maxRenewals",
	"utility", "disabled", "worktree", "steer", "onBlocked",
	"acceptance", "toolBudget", "turnBudget",
]);

/**
 * Throw when a card declares a key this parser does not understand.
 *
 * Names are compared case-sensitively: YAML keys are case-sensitive, and a
 * near-miss (`MaxRenewals`) is exactly the typo this is meant to catch.
 */
function assertKnownFrontmatter(frontmatter: Record<string, unknown>, filePath: string): void {
	const unknown = Object.keys(frontmatter).filter((key) => !AGENT_FRONTMATTER_FIELDS.has(key));
	if (unknown.length === 0) return;
	const known = [...AGENT_FRONTMATTER_FIELDS].sort().join(", ");
	throw new Error(
		`Agent '${filePath}' has unknown frontmatter ${unknown.length === 1 ? "field" : "fields"}: ` +
			`${unknown.map((key) => `'${key}'`).join(", ")}. ` +
			`Known fields: ${known}.`,
	);
}

/**
 * Convert one markdown document into an AgentConfig.
 * Returns `null` (never throws) when the file is not a usable agent definition.
 */
export function parseAgentDocument(
	content: string,
	filePath: string,
	source: AgentSource,
): AgentConfig | null {
	const { frontmatter, body } = parseFrontmatter(content);
	const fm = frontmatter as AgentFrontmatter;
	assertKnownFrontmatter(fm, filePath);

	const name = str(fm.name);
	const description = str(fm.description);
	if (!name || !description) return null;

	const config: AgentConfig = {
		name,
		description,
		systemPromptMode: promptMode(fm.systemPromptMode),
		// Defaults chosen to match pi-subagents conventions (design §6.1).
		inheritProjectContext: bool(fm.inheritProjectContext) ?? true,
		inheritSkills: bool(fm.inheritSkills) ?? false,
		...(bool(fm.inheritExtensions) !== undefined ? { inheritExtensions: bool(fm.inheritExtensions) } : {}),
		kind: parseKind(fm.kind, name),
		systemPrompt: body,
		source,
		filePath,
		frontmatterFields: new Set(Object.keys(frontmatter)),
	};

	applyModelFields(config, fm);
	applyCapabilityFields(config, fm);
	applyBehaviorFields(config, fm);
	applyHerdrFields(config, fm);
	const team = str(fm.team);
	if (team) config.extraFields = { ...(config.extraFields ?? {}), team };

	config.unenforcedFields = unenforcedFieldsIn(config);
	return config;
}

/**
 * Assign `value` when present. Keeps the field appliers below free of the
 * repeated `if (x !== undefined)` shape that made this parser hard to scan.
 *
 * Generic over the TARGET so `key` is checked against the object's real keys:
 * a typo like `setIf(config, "modle", ...)` is a compile error, and no call site
 * or the helper itself needs a cast. (`object` + a cast, the previous shape,
 * checked neither.)
 */
function setIf<T extends object, K extends keyof T>(
	target: T,
	key: K,
	value: T[K] | undefined,
): void {
	if (value !== undefined) target[key] = value as T[K];
}

/**
 * Resolve the role's `kind`.
 *
 * v4 runs `pi` only. The key stays legal frontmatter (and `AgentConfig.kind`
 * stays), but a value outside `AGENT_KINDS` is ignored: the role launches as
 * `pi` and this is reported once, naming the role and the value it tried to
 * set. Silently coercing would leave the user believing a non-pi CLI is in
 * play, so an invalid/absent value is the only case that speaks up.
 */
function parseKind(value: unknown, agentName: string): AgentKind {
	const raw = str(value);
	if (raw === undefined || raw === "") return "pi";
	if (VALID_KINDS.has(raw)) return raw as AgentKind;
	reportIgnoredOnce(
		`agent:${agentName}:${raw}`,
		ignoredKindMessage({ origin: "agent", subject: `'${agentName}'`, value: raw }),
	);
	return "pi";
}

/** `systemPromptMode` is a closed set of two; anything else means `replace`. */
function promptMode(value: unknown): SystemPromptMode {
	return str(value) === "append" ? "append" : "replace";
}

/** `model`, `fallbackModels`, `thinking`, `preset` (design §6.2). */
function applyModelFields(config: AgentConfig, fm: AgentFrontmatter): void {
	setIf(config, "model", str(fm.model));
	setIf(config, "preset", str(fm.preset));
	setIf(config, "fallbackModels", list(fm.fallbackModels));

	// `thinking: false` disables reasoning and must stay distinct from absent.
	const thinking = fm.thinking;
	if (thinking === false || thinking === "false") config.thinking = false;
	else setIf(config, "thinking", str(thinking));
}

/** tools / skills / extensions / reads — what the child may reach. */
function applyCapabilityFields(
	config: AgentConfig,
	fm: AgentFrontmatter,
): void {
	setIf(config, "tools", list(fm.tools));
	// `skills: false` disables inheritance, so it is not the same as absent.
	setIf(config, "skills", listOrFalse(fm.skills));
	setIf(config, "skillPath", list(fm.skillPath));
	setIf(config, "extensions", list(fm.extensions));
	if (list(fm.excludeExtensions)) config.excludeExtensions = list(fm.excludeExtensions);
	setIf(config, "subagentOnlyExtensions", list(fm.subagentOnlyExtensions));
	setIf(config, "alias", list(fm.alias) ?? list(fm.aliases));
	setIf(config, "output", str(fm.output));
	setIf(config, "defaultReads", list(fm.defaultReads));
}

/** Budgets, guards and lifecycle flags. */
function applyBehaviorFields(config: AgentConfig, fm: AgentFrontmatter): void {
	setIf(config, "defaultProgress", bool(fm.defaultProgress));
	setIf(config, "async", bool(fm.async));
	setIf(config, "timeoutMs", int(fm.timeoutMs));
	setIf(config, "toolTimeoutMs", int(fm.toolTimeoutMs));
	setIf(config, "completionGuard", bool(fm.completionGuard));
	setIf(config, "maxSubagentDepth", int(fm.maxSubagentDepth));
	setIf(config, "allowNestedSubagents", bool(fm.allowNestedSubagents));
	// D5/D6: parsed verbatim and left absent when undeclared — the defaults live
	// with the consumers (DEFAULT_RENEWABLE / DEFAULT_MAX_RENEWALS), so this
	// layer never has to guess whether the role was explicit. `int()` returns 0
	// for `maxRenewals: 0`, and `setIf` only skips `undefined`, so the
	// "renewal disabled" spelling survives instead of decaying to the default.
	setIf(config, "renewable", bool(fm.renewable));
	setIf(config, "maxRenewals", int(fm.maxRenewals));
	setIf(config, "utility", bool(fm.utility));
	setIf(config, "disabled", bool(fm.disabled));
	setIf(config, "worktree", bool(fm.worktree));
	setIf(config, "steer", bool(fm.steer));
	setIf(config, "acceptance", parseAcceptance(fm.acceptance, config.name));
	const phases = parsePhaseMachine(fm.phases, config.filePath);
	if (phases) config.phases = phases;
	const budgets = parseBudgets(fm, config.filePath);
	setIf(config, "toolBudget", budgets.tool);
	setIf(config, "turnBudget", budgets.turn);
	// #214 / contract §9: only centurion holds worktree isolation. Writers no
	// longer auto-default to worktree:true — members work in-place; parallel
	// isolated writers are N root-dispatched centurions. Explicit worktree:true
	// on a non-centurion is still demoted at launch (warn once / force false).
	// centurion.md pins worktree:true itself; no auto-default here.
}

/** Transitional blocked-policy frontmatter retained for approval handling. */
function applyHerdrFields(config: AgentConfig, fm: AgentFrontmatter): void {
	const onBlocked = str(fm.onBlocked);
	if (onBlocked && VALID_ON_BLOCKED.has(onBlocked)) {
		config.onBlocked = onBlocked as OnBlockedPolicy;
	}
}

/**
 * Fields that are parsed and validated but that the runtime does NOT act on
 * yet. They are surfaced (tool output, `subagent action=list`) instead of being
 * silently dropped, because a frontmatter key that looks accepted but does
 * nothing is worse than an unknown one: the user believes it is in effect.
 *
 * Keep this list honest — remove a field the moment it starts being enforced.
 * Empty means every parsed AgentConfig field the runtime can honour is wired.
 *
 * Typed against `AgentConfig`'s keys: a renamed or removed field cannot be left
 * behind here silently (the previous untyped array could name a key that no
 * longer exists and would simply stop reporting it, which is the exact drift
 * this list is meant to prevent).
 */
const UNENFORCED_FIELDS = [] as const satisfies readonly (keyof AgentConfig)[];

/** The subset of `UNENFORCED_FIELDS` this agent actually sets. */
function unenforcedFieldsIn(config: AgentConfig): string[] {
	// No cast needed: every name in `UNENFORCED_FIELDS` is a real key of
	// `AgentConfig` (typed as such below), so this is an ordinary indexed read.
	const out: string[] = [];
	for (const field of UNENFORCED_FIELDS) {
		if (config[field] !== undefined) out.push(field);
	}
	// NOTE: `acceptance.criteria` is NOT listed here. It is surfaced by
	// `collect()` as an explicit checklist for the caller, which is the only
	// honest treatment of a semantic requirement (see AcceptanceResult).
	return out;
}

/** Load every usable `*.md` agent definition from a directory. */
export function loadAgentsFromDir(
	dir: string,
	source: AgentSource,
): AgentConfig[] {
	const agents: AgentConfig[] = [];
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return agents; // missing/unreadable directory is not an error
	}

	for (const entry of entries) {
		if (!entry.name.endsWith(".md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;

		const filePath = path.join(dir, entry.name);
		let content: string;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}

		const agent = parseAgentDocument(content, filePath, source);
		if (agent) agents.push(agent);
	}

	return agents;
}

function isDirectory(p: string): boolean {
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
}

/**
 * Walk up from `cwd` looking for `.pi/agents`.
 * Stops at the filesystem root so a project without the directory is cheap.
 */
export function findNearestProjectAgentsDir(
	cwd: string,
	configDirName = ".pi",
): string | null {
	let current = path.resolve(cwd);
	while (true) {
		const candidate = path.join(current, configDirName, "agents");
		if (isDirectory(candidate)) return candidate;
		const parent = path.dirname(current);
		if (parent === current) return null;
		current = parent;
	}
}

export interface DiscoverOptions {
	/** Override the user-level agents directory (tests). */
	userAgentsDir?: string;
	/** Override the project config directory name. */
	configDirName?: string;
	/** Override the bundled agents directory (tests). */
	builtinAgentsDir?: string;
	/**
	 * Whether the package's own `agents/` definitions take part.
	 * Defaults to true; `subagents.disableBuiltins` turns it off.
	 */
	includeBuiltin?: boolean;
	/** Extra user-level directories, below the real user dir in precedence. */
	extraAgentDirs?: string[];
}

/**
 * Discover agents for a scope.
 *
 * Precedence, lowest to highest:
 *   builtin (shipped with the package)
 *   extra dirs (`PI_LEGION_EXTRA_AGENT_DIRS`, legacy `PI_HERDR_SUBAGENTS_EXTRA_AGENT_DIRS`)
 *   user    (`~/.pi/agent/agents`)
 *   project (`<nearest>/.pi/agents`)
 *
 * Later layers override earlier ones by name. The bundled roles are always
 * present unless `includeBuiltin` is false, which is what makes a fresh install
 * useful without any user setup.
 */
export function discoverAgents(
	cwd: string,
	scope: AgentScope,
	opts: DiscoverOptions = {},
): AgentDiscoveryResult {
	const projectAgentsDir = findNearestProjectAgentsDir(cwd, opts.configDirName);
	const layers = agentLayers(scope, projectAgentsDir, opts);

	const byName = new Map<string, AgentConfig>();
	const order: string[] = [];

	// Lower precedence first; each later layer may overwrite by name.
	for (const layer of layers) {
		for (const agent of layer) {
			if (!byName.has(agent.name)) order.push(agent.name);
			byName.set(agent.name, agent);
		}
	}

	return {
		agents: order.map((name) => byName.get(name) as AgentConfig),
		projectAgentsDir,
		builtinAgentsDir: opts.builtinAgentsDir ?? BUILTIN_AGENTS_DIR,
		userAgentsDir: agentLayersUserDir(scope, opts),
	};
}

/** The user-level agents directory for the scope, when that layer runs. */
function agentLayersUserDir(
	scope: AgentScope,
	opts: DiscoverOptions,
): string | undefined {
	if (scope === "project") return undefined;
	return opts.userAgentsDir ?? path.join(getAgentDir(), "agents");
}

/**
 * The agent directories to merge, lowest precedence first.
 *
 * Scope decides which layers participate: `project` skips the user layers,
 * `user` skips the project layer, `both` includes everything. The bundled roles
 * are scope-independent (they are the shipped defaults) and are always first so
 * any user or project definition can shadow them.
 */
function agentLayers(
	scope: AgentScope,
	projectAgentsDir: string | null,
	opts: DiscoverOptions,
): AgentConfig[][] {
	const layers: AgentConfig[][] = [];

	// The bundled roles ship with the package, so a fresh install has a working
	// set with no user setup at all.
	if (opts.includeBuiltin !== false) {
		layers.push(
			loadAgentsFromDir(opts.builtinAgentsDir ?? BUILTIN_AGENTS_DIR, "builtin"),
		);
	}

	if (scope !== "project") {
		// Extra read-only dirs (Nix store, container) rank below the real user dir.
		for (const dir of opts.extraAgentDirs ?? extraAgentDirs()) {
			layers.push(loadAgentsFromDir(dir, "user"));
		}
		layers.push(
			loadAgentsFromDir(
				opts.userAgentsDir ?? path.join(getAgentDir(), "agents"),
				"user",
			),
		);
	}

	if (scope !== "user" && projectAgentsDir) {
		layers.push(loadAgentsFromDir(projectAgentsDir, "project"));
	}

	return layers;
}

/**
 * Resolve an agent by canonical name or alias.
 *
 * Exact `name` wins over an alias collision. Matching is case-insensitive
 * only after the exact pass, so `Reviewer` still finds `reviewer`.
 */
export function findAgent(
	agents: AgentConfig[],
	requested: string,
): AgentConfig | undefined {
	const exactName = agents.find((a) => a.name === requested);
	if (exactName) return exactName;
	const exactAlias = agents.find((a) => (a.alias ?? []).includes(requested));
	if (exactAlias) return exactAlias;
	const needle = requested.toLowerCase();
	return agents.find(
		(a) =>
			a.name.toLowerCase() === needle ||
			(a.alias ?? []).some((alias) => alias.toLowerCase() === needle),
	);
}

/** Render a compact agent list for tool output. */
export function formatAgentList(agents: AgentConfig[], maxItems = 50): string {
	if (agents.length === 0) return "none";
	return agents
		.slice(0, maxItems)
		.map((a) => `${a.name} (${a.source}): ${a.description}`)
		.join("; ");
}

/**
 * Roster injected into the parent system prompt so the model can pick a role
 * without calling `action=list` first. Custom user/project agents (search, …)
 * only exist here — they are not hardcoded in the playbook.
 */
export function formatAgentRoster(agents: AgentConfig[]): string {
	if (agents.length === 0) {
		return "No subagent roles loaded. Add ~/.pi/agent/agents/*.md or .pi/agents/*.md.";
	}
	const lines = agents.map((a) => {
		const extras = [
			a.kind && a.kind !== "pi" ? `kind=${a.kind}` : undefined,
			a.model ? `model=${a.model}` : undefined,
		].filter((part): part is string => Boolean(part));
		const meta = extras.length ? ` (${extras.join(", ")})` : "";
		return `- ${a.name} [${a.source}]${meta} — ${a.description}`;
	});
	return [
		"Available subagent roles (call the matching name immediately; do not DIY that job with bash/curl):",
		...lines,
	].join("\n");
}
