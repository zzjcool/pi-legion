/**
 * Frozen interfaces for pi-legion.
 *
 * This file is the CONTRACT between modules. Parallel work depends on it, so:
 *   - Treat every exported type here as FROZEN once workers start.
 *   - Additive changes (new optional fields) are allowed.
 *   - Breaking changes require coordinating all modules.
 *
 * Design authority: docs/legion-v2-contract.md.
 */

// =============================================================================
// Agent definitions (aligned with pi-subagents conventions)
// =============================================================================

export type AgentScope = "user" | "project" | "both";

export type SystemPromptMode = "replace" | "append";

/** Agent kinds parsed from role files; the RPC supervisor accepts only `pi`. */
export const AGENT_KINDS = [
	"pi",
	"claude",
	"codex",
	"gemini",
	"cursor",
	"devin",
	"agy",
	"cline",
	"omp",
	"mastracode",
	"opencode",
	"copilot",
	"kimi",
	"kiro",
	"droid",
	"amp",
	"grok",
	"hermes",
	"kilo",
	"qodercli",
	"qwen",
	"maki",
	"muse",
] as const;

export type AgentKind = (typeof AGENT_KINDS)[number];

/** How Legion launches a child session: omit → `inprocess` (with automatic rpc fallback when the agent needs a worktree or `kind !== "pi"`). */
export const SPAWN_MODES = ["rpc", "inprocess"] as const;
export type SpawnMode = (typeof SPAWN_MODES)[number];


/**
 * How the model a child starts with was chosen.
 *
 * `explicit` — someone deliberately named it: agent frontmatter, an
 * `agentOverrides` entry, a preset, or a per-run `model` param.
 * `inherited` — it fell through from configuration not aimed at this role:
 * `subagents.defaultModel`, or the parent session's own model.
 *
 * The distinction decides what happens when the target CLI cannot accept the
 * model: an explicit choice is a mistake worth refusing, while an inherited
 * parent model is expected to be irrelevant to a different CLI and is dropped.
 */
export type ModelOrigin = "explicit" | "inherited";

/** What to do when an agent reports `blocked` (design §5.3). */
export type OnBlockedPolicy = "forward" | "auto-approve" | "notify";

/**
 * The policy used when an agent sets no `onBlocked` and no
 * `subagents.defaultOnBlocked` is configured: subagents run unattended, so an
 * approval dialog is a deadlock. `forward` restores a human gate.
 */
export const DEFAULT_ON_BLOCKED: OnBlockedPolicy = "auto-approve";

export type AcceptanceLevel = "none" | "attested" | "verified";

export interface AcceptanceCriterion {
	id: string;
	must: string;
	evidence?: string[];
	severity?: "required" | "optional";
	/** Exact shell command to run for `evidence: [verification-output]`. */
	command?: string;
}

export interface AcceptanceConfig {
	level: AcceptanceLevel;
	/** Read-only agents degrade to `attested` (pi-subagents convention). */
	role?: "read-only" | "writer" | "unknown";
	criteria?: AcceptanceCriterion[];
}

export interface ToolBudgetConfig {
	maxToolCalls?: number;
}

export interface TurnBudgetConfig {
	maxTurns?: number;
}

/**
 * A discovered agent definition (from `agents/*.md` frontmatter + body).
 * Field set mirrors pi-subagents where applicable (design §6.1).
 */
export interface AgentConfig {
	name: string;
	description: string;

	// ── model ──
	model?: string;
	/** Name of a `subagents.presets` entry that bundles kind+model+thinking. */
	preset?: string;
	fallbackModels?: string[];
	thinking?: string | false;

	// ── capability bounds ──
	tools?: string[];
	skills?: string[] | false;
	skillPath?: string[];
	extensions?: string[];
	subagentOnlyExtensions?: string[];
	systemPromptMode: SystemPromptMode;
	inheritProjectContext: boolean;
	inheritSkills: boolean;
	/**
	 * Load the host's discovered extensions (settings `packages`, project
	 * extensions) in the child. Default false: children get `--no-extensions`
	 * plus only explicit `--extension` paths (#43).
	 */
	inheritExtensions?: boolean;

	// ── behavior ──
	output?: string;
	defaultReads?: string[];
	defaultProgress?: boolean;
	async?: boolean;
	timeoutMs?: number;
	toolTimeoutMs?: number;
	acceptance?: AcceptanceConfig;
	completionGuard?: boolean;
	maxSubagentDepth?: number;
	allowNestedSubagents?: boolean;
	utility?: boolean;
	toolBudget?: ToolBudgetConfig;
	turnBudget?: TurnBudgetConfig;
	disabled?: boolean;
	alias?: string[];
	extraFields?: Record<string, string>;

	// ── execution metadata ──
	kind: AgentKind;
	worktree?: boolean;
	steer?: boolean;
	/**
	 * Launch backend for this role. Omit → `inprocess` (createAgentSession in
	 * the parent Node process), with automatic rpc fallback when the resolved
	 * spawn needs a worktree (`worktree: true`, the writer/centurion default)
	 * or `kind !== "pi"`. An explicit `inprocess` + `worktree: true` is still
	 * refused with `INVALID_PARAMS` — the fallback only applies to the implicit
	 * default, never to an explicit request.
	 */
	spawnMode?: SpawnMode;
	onBlocked?: OnBlockedPolicy;

	// ── provenance ──
	systemPrompt: string;
	source: AgentSource;
	filePath: string;
	/** Which fields came from frontmatter (for override merging). */
	frontmatterFields?: Set<string>;
	modelSource?: ModelSourceInfo;
	/**
	 * Fields this agent sets that the runtime does not act on yet.
	 * Surfaced so a key that looks accepted is never silently ignored.
	 * Populated by `parseAgentDocument`; see `unenforcedFieldsIn`.
	 */
	unenforcedFields?: string[];
}

export type AgentSource = "builtin" | "user" | "project";

export interface ModelSourceInfo {
	type:
		| "subagents.defaultModel"
		| "agentOverrides"
		| "preset"
		| "frontmatter"
		| "dispatch"
		| "inherit";
	scope?: "user" | "project";
	path?: string;
	model: string;
}

export interface AgentDiscoveryResult {
	agents: AgentConfig[];
	projectAgentsDir: string | null;
	/** Directory the package's own agent definitions were loaded from. */
	builtinAgentsDir?: string;
	/** The user-level agents directory that took part (resolved, not `~`). */
	userAgentsDir?: string;
}

// =============================================================================
// Model scope (design §6.2)
// =============================================================================

export interface ModelScopeConfig {
	enforce: boolean;
	allow: string[];
}

export interface ModelScopeViolation {
	model: string;
	severity: "error" | "warn";
	allowedPatterns: string[];
	message: string;
}

// =============================================================================
// Lifecycle + outcome (design §3) — ORTHOGONAL dimensions
// =============================================================================

/** Lifecycle state. Independent of execution outcome. */
export type TaskState =
	| "launching"
	| "working"
	| "awaiting"
	| "blocked"
	| "retired"
	| "exited";

/** Execution outcome, derived ONLY from session jsonl (F26-F31). */
export type ExecutionStatus =
	| "success"
	| "failed"
	| "aborted"
	| "truncated"
	| "running"
	| "unknown";

/** pi's authoritative stop reason enum (session-format.md:88). */
export type StopReason = "stop" | "length" | "toolUse" | "error" | "aborted";

export interface Execution {
	status: ExecutionStatus;
	stopReason?: StopReason | null;
	errorMessage?: string | null;
	reason?: string;
	turns?: number;
	/** Cumulative tool errors — diagnostic only, never affects status (F30). */
	toolErrors?: number;
	/** Only the final turn decides the outcome (F31). */
	lastTurn?: { stopReason?: StopReason | null; toolErrors: number };
	model?: string | null;
	usage?: Usage | null;
	completedAt?: string;
}

/**
 * Why a still-live child is being retired.
 * `session-shutdown` is the parent process leaving, not a model failure.
 */
export interface RetireOptions {
	cause?: "session-shutdown";
	/**
	 * When false, skip graceful stdin-close and escalate via retire hardening
	 * (SIGTERM → SIGKILL + descendant sweep). Default / omitted = graceful.
	 * Used by `subagent({ action: "stop", force: true })` (#179).
	 */
	graceful?: boolean;
}

export interface Usage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
}

export interface AcceptanceResult {
	status: "accepted" | "rejected" | "unknown";
	level: AcceptanceLevel;
	evidence?: string[];
	reason?: string;
	/**
	 * Criteria the agent declared that nobody has verified yet.
	 *
	 * These are SEMANTIC requirements (`must: "tests pass"`), so the runtime
	 * cannot decide them — an agent saying "done" is exactly the signal that
	 * cannot be trusted (F32). Rather than silently claiming verification, the
	 * checklist is handed to the caller, whose job it is to confirm them. This is
	 * why `level` stays `attested` while this list is non-empty: a `verified`
	 * claim is reserved for evidence someone actually checked.
	 */
	pendingCriteria?: AcceptanceCriterion[];
}

// =============================================================================
// Tree / run record (design §4)
// =============================================================================

/** One entry in the lineage chain. Flat array, max 4 (pi-subagents convention). */
export interface NestedPathEntry {
	runId: string;
	stepIndex?: number;
	agent?: string;
}

export const MAX_NESTED_PATH_ENTRIES = 4;

export interface ChildRecord {
	/** Supervisor-local child name; unique among live children in this run. */
	name: string;
	/** ★ resume credential — must persist. */
	sessionFile: string;
	sessionId?: string;
	/** Stable per-run child identity; legacy records used a pane owner token. */
	ownerToken: string;

	// lifecycle
	state: TaskState;
	spawnedAt: string;
	retiredAt?: string;

	// outcome (snapshot taken before child retirement — F27)
	execution?: Execution;
	acceptance?: AcceptanceResult;
	/**
	 * Full terminal output persisted by the last collect (run-dir
	 * `<name>.output.md`), or absent when that collect wrote none (running
	 * snapshot / empty output). Recorded on the child — not re-derived via
	 * existsSync — so a cached collect cannot hand out an EARLIER turn's
	 * artifact as this turn's result.
	 */
	outputFile?: string;
	/**
	 * Acceptance criteria declared by the agent, copied here at launch so a
	 * `collect` in a later process (each tool call is a fresh process) can still
	 * surface them without re-reading the agent definition.
	 */
	pendingCriteria?: AcceptanceCriterion[];
	/** Snapshotted at launch so a later collect can honour design §5.3. */
	onBlocked?: OnBlockedPolicy;
	/** Snapshotted at launch; missing `{"ok":…}` on success becomes rejected. */
	completionGuard?: boolean;
	/** Isolated git worktree used by the child; left on disk after retire. */
	worktreePath?: string;
	/** Branch created in that worktree; the child ships via MR, not the parent checkout. */
	worktreeBranch?: string;

	// artifacts
	artifacts?: Array<{ kind: string; path: string }>;

	// config echo (for diagnostics)
	agent?: string;
	kind?: AgentKind;
	/** Model actually started with (resolved + fallback). */
	model?: string;
	thinking?: string | false;
	/** Models that were requested but cannot be represented by the RPC child. */
	modelDropped?: string[];
	/**
	 * Backend this child was actually spawned on, as arbitrated by
	 * `Orchestrator.launch` (#209). Optional because run.json records written
	 * before the field existed have no value — readers must render those as
	 * unknown, never guess a backend.
	 */
	spawnMode?: SpawnMode;
}

export interface RunRecord {
	schemaVersion: 1;
	runId: string;
	task: string;
	cwd: string;

	herdr: {
		/**
		 * Transport marker under the historic run.json key: the arbitrated backend
		 * of the run's own process (#209). Absent on legacy records.
		 */
		supervisor?: SpawnMode;
		/** Reserved for M2 tree identity. */
		node_id?: string;
	};

	/** Lineage: root → this node. */
	path: NestedPathEntry[];
	depth: number;
	maxDepth: number;

	children: ChildRecord[];

	budget: { spawned: number; limit: number | null; granted: number };

	createdAt: string;
	updatedAt: string;
}

// =============================================================================
// Session parsing (design §10)
// =============================================================================

export interface ParsedSession {
	output: string;
	/**
	 * Text of the FINAL assistant message of the LAST turn — the same message
	 * whose `stopReason` decides the execution outcome.
	 *
	 * `output` above is the last non-empty text ANYWHERE in the session, so it
	 * keeps pointing at an earlier turn whenever the final turn ends without text
	 * (a tool call, or a mid-turn kill). Deriving the self-reported verdict from
	 * `output` therefore let a stale "ok" from turn 1 be reported as
	 * `accepted/attested` while execution said `aborted` (F39). Verdict derivation
	 * MUST read this field instead, so both layers describe the same message.
	 *
	 * `null` when that message carried no text.
	 */
	lastTurnOutput: string | null;
	usage: Usage;
	model: string | null;
	stopReason: StopReason | null;
	turns: TurnRecord[];
	toolErrors: number;
	/** True when the last user prompt has no assistant reply (F29 abort signal). */
	lastTurnMissing: boolean;
	tornLines: number;
	/**
	 * Context size of the FINAL assistant message of the session: its
	 * `input + cacheRead + cacheWrite`, i.e. the prompt the model actually saw.
	 *
	 * Unlike `usage` (a cumulative total across every message) this is a current
	 * value, so it stops growing when the session stops. Optional because a
	 * session with no assistant message has no context yet — and there is no
	 * percentage to derive: session JSONL carries no `contextWindow`.
	 */
	lastContextTokens?: number;
	/**
	 * Cumulative model-generation wall time in ms: each completed assistant
	 * message timestamp minus the preceding user or toolResult timestamp when
	 * both are known. Tool/idle gaps are excluded. Approximate — session JSONL
	 * records finished assistant messages, not mid-stream token boundaries.
	 */
	generationMs: number;
}

export interface TurnRecord {
	userText: string;
	/** Unix ms timestamp of the user message that opened this turn, when written. */
	startedAt?: number;
	/** Unix ms timestamp of the last assistant message in this turn, when written. */
	endedAt?: number;
	assistants: Array<{
		stopReason: StopReason | null;
		/**
		 * The raw stopReason string as written. Lets an unrecognized value be
		 * distinguished from an absent field (an absent field means the stream
		 * was cut short; an unknown value should be surfaced, not hidden).
		 */
		rawStopReason?: string;
		errorMessage: string | null;
		text: string | null;
		tools: string[];
	}>;
	toolResults: number;
	toolErrors: number;
}

// =============================================================================
// Tool API (design §11)
// =============================================================================

// The wire-level request/response shapes are NOT declared here: the tool's
// schema is authored with TypeBox in `index.ts` (`SubagentParams`), which is
// what the host validates against and what the model actually sees. Hand-
// written twins (`SubagentAction`, `LaunchRequest`, `CollectResult`,
// `SubagentToolParams`) used to live here and had already begun to drift from
// that schema (and from `Handle`/`collect()`), so they were removed rather
// than left as a second, silently-wrong source of truth.

/**
 * What a successful `launch()` returns to its caller.
 *
 * `child` is the authoritative record — see its doc comment for why callers
 * must persist THIS rather than rebuild an equivalent object.
 */
export interface Handle {
	name: string;
	sessionFile: string;
	runId: string;
	agent: string;
	kind: AgentKind;
	/**
	 * The authoritative child record the orchestrator created (includes the
	 * real `ownerToken`). Callers should persist THIS rather than rebuild an
	 * equivalent record, which previously hardcoded a placeholder token and
	 * silently defeated the ownership audit.
	 */
	child: ChildRecord;
	/**
	 * Backend the orchestrator actually chose for this launch (arbitration
	 * result, #209). Callers render this instead of assuming `rpc`.
	 */
	spawnMode: SpawnMode;
	/**
	 * OS process of an `rpc` child, when the supervisor reported one.
	 *
	 * Deliberately not persisted (no `run.json` / `legion.db` field): a pid is
	 * only meaningful inside the host that spawned it, so a later session would
	 * read a number that now belongs to some unrelated process. `inprocess`
	 * children have no pid of their own — they share this process.
	 */
	pid?: number;
}

// =============================================================================
// Settings (design §6.3)
// =============================================================================

/**
 * One named kind+model+thinking bundle in `subagents.presets`.
 *
 * `kind` and `model` travel together — a preset whose model does not fit the
 * target kind is rejected at expansion time (see `assertKindModelCoherent`),
 * because `nativeModelFor()` would otherwise silently drop the model.
 */
export interface PresetConfig {
	kind?: AgentKind;
	model?: string;
	thinking?: string | false;
}

/** @deprecated Transitional herdr.* settings retained until v3. */
export interface HerdrSettings {
	/** @deprecated Parsed for transition compatibility; ignored by RPC v2. */
	defaultPlacement?: "split-down" | "split-right" | "new-tab";
	/** @deprecated Legacy concurrency hint; ignored by RPC v2. */
	maxConcurrentAgents?: number;
	/** @deprecated Legacy Herdr launch retry setting. */
	startRetries?: number;
	/** @deprecated Legacy Herdr launch retry setting. */
	startRetryBackoffMs?: number;
	/** @deprecated Legacy session retention setting. */
	sessionRetentionDays?: number;
	/** @deprecated Legacy session retention setting. */
	sessionRetentionMaxBytesPerRun?: number;
}

export interface LegionPhaseTimeouts {
	planning?: number;
	implementing?: number;
	reviewing?: number;
	verifying?: number;
}

/** Settings for the v2 legion tree, incrementally consumed by its milestones. */
export interface LegionSettings {
	maxDepth?: number;
	maxChildrenPerNode?: number;
	maxActiveNodes?: number;
	phaseTimeouts?: LegionPhaseTimeouts;
	verifyCommandTimeoutMs?: number;
	/** Post-create provisioning for child worktrees: "npm-install" or a shell command. */
	worktreeBootstrap?: string;
	worktreeBootstrapTimeoutMs?: number;
	mailRatePer5Min?: number;
	usagePollMs?: number;
	orphanStaleMs?: number;
}

/** Defaults from the frozen v2 contract §11.4. */
export const DEFAULT_LEGION_SETTINGS = {
	maxDepth: 4,
	maxChildrenPerNode: 8,
	maxActiveNodes: 30,
	phaseTimeouts: {
		planning: 900_000,
		implementing: 3_600_000,
		reviewing: 1_800_000,
		verifying: 900_000,
	},
	verifyCommandTimeoutMs: 600_000,
	// Provisioning is opt-in: no default mode, a generous install budget.
	worktreeBootstrap: "",
	worktreeBootstrapTimeoutMs: 600_000,
	mailRatePer5Min: 10,
	usagePollMs: 30_000,
	orphanStaleMs: 90_000,
} as const satisfies Required<LegionSettings>;

export type AgentOverride = Partial<AgentConfig> & { disabled?: boolean };

export type TeamMember =
	| string
	| ({ agent: string } & AgentOverride);

export interface TeamConfig {
	description?: string;
	members: TeamMember[];
	/**
	 * Same forms as `subagents.parentContext` (inline / `@path` / array).
	 * Replaces the global parent context for this team; `false` disables
	 * parent injection without falling through to global/convention.
	 * Omitted → fall back to global `subagents.parentContext` (or convention).
	 */
	parentContext?: string | string[] | false;
	/**
	 * Same forms as `subagents.childContext`. Replaces the global child
	 * context for this team; `false` disables child injection (no fallthrough).
	 * Omitted → fall back to global `subagents.childContext` (or convention).
	 */
	childContext?: string | string[] | false;
}

/**
 * Main-session scout guard (issue #17).
 *
 * After `threshold` consecutive read-like tool calls with no subagent or
 * vexillatio dispatch, the parent session gets one follow-up reminder and
 * then waits `cooldownMs`. Defaults: enabled, threshold 8, cooldown 120000.
 * `/scout-guard` and `/no-scout-guard` override `enabled` for this session.
 */
export interface ScoutGuardSettings {
	enabled?: boolean;
	/** Positive integer. Default 8. */
	threshold?: number;
	/** Integer >= 0. Default 120000. */
	cooldownMs?: number;
}


/**
 * Concurrency / depth / wait limits for the in-process supervisor (#197).
 * Keys are independent of RPC / legion.* budgets — never fall back to those.
 *
 * Defaults mirror `legion.*` when the whole `inprocess` block is absent:
 * `maxDepth: 4` / `maxChildrenPerNode: 8` / `maxActive: 30`. With an explicit
 * block that omits `maxActive`, `maxActive` is 8. `maxSpawnsPerSession` and
 * `waitTimeoutMs` have no default (unlimited).
 */
export interface InProcessLimits {
	maxSpawnsPerSession?: number;
	maxDepth?: number;
	maxActive?: number;
	maxChildrenPerNode?: number;
	waitTimeoutMs?: number;
}

/**
 * RPC-child spawn knobs (#193). Opt-in only — default stays no `--approve`.
 * v1 does not emit `--no-approve`.
 */
export interface RpcSettings {
	/**
	 * When true, child `pi --mode rpc` argv includes `--approve` so project
	 * `.pi/settings.json` / project resources / extension discovery can load
	 * without a prior `/trust` decision. Default false (omit the flag).
	 */
	approve?: boolean;
}

export interface SubagentsSettings {
	/**
	 * Master switch (default true). `false` stops new launches, system-prompt
	 * roster injection, and the bash dispatch guard. Already-running children
	 * are untouched: control actions (status/collect/wait/…) stay available.
	 * Project `.pi/settings.json` wins over the user file.
	 */
	enabled?: boolean;
	/**
	 * Extra parent-side context appended after the playbook + roster each
	 * turn. Inline markdown or `@path` file reference(s) (string or array).
	 * Lets machine-specific dispatch discipline live here instead of the
	 * user's global AGENTS.md. Project settings replace the user value.
	 */
	parentContext?: string;
	/**
	 * Extra context injected into every child's system prompt (pi kinds:
	 * `--append-system-prompt` after the role prompt; other kinds: rides along
	 * in the task prompt, like the role system prompt does). Same value forms
	 * as `parentContext`. Project settings replace the user value.
	 */
	childContext?: string;
	defaultModel?: string;
	defaultProvider?: string;
	/**
		 * Default `onBlocked` policy for agents that do not set one in frontmatter
		 * or agentOverrides. Unattended runs want `auto-approve`; `forward` keeps
		 * a human gate in the parent TUI. Defaults to `auto-approve` (see
		 * DEFAULT_ON_BLOCKED) so a fresh install never deadlocks on an approval
		 * dialog nobody is watching.
		 */
	defaultOnBlocked?: OnBlockedPolicy;
	agentOverrides?: Record<string, AgentOverride>;
	teams?: Record<string, TeamConfig>;
	team?: string;
	/**
	 * Named kind+model+thinking bundles, referenced by `preset:` (frontmatter,
	 * agentOverrides, or tool param). A preset wins over `agentOverrides` and
	 * loses to the per-run tool `model` (design §6.2, level 2).
	 */
	presets?: Record<string, PresetConfig>;
	/**
	 * Role fields layered by the active parent provider (design §6.2).
	 * Lets one role definition be configured differently per provider, e.g.
	 * `{ "cb": { "worker": { "model": "cb/glm-5.3" } } }`.
	 */
	agentOverridesByProvider?: Record<
		string,
		Record<string, Partial<AgentConfig> & { disabled?: boolean }>
	>;
	modelScope?: ModelScopeConfig;
	disableBuiltins?: boolean;
	disableThinking?: boolean;
	maxSubagentSpawnsPerSession?: number;
	/** @deprecated Transitional herdr.* keys are parsed and ignored by RPC v2. */
	herdr?: HerdrSettings;
	legion?: LegionSettings;
	/** Completion-notice merge mode. Default "smart". */
	joinMode?: "each" | "smart";
	/** smart-mode group flush window (ms). Default 10000. */
	joinFlushMs?: number;
	/** Main-session recon reminder. Absent fields use scout-guard defaults. */
	scoutGuard?: ScoutGuardSettings;
	/**
	 * Limits for `spawnMode: "inprocess"` children only (#197).
	 * RPC path never reads these keys.
	 */
	inprocess?: InProcessLimits;
	/**
	 * RPC-child spawn options (#193). Default omits `--approve`; set
	 * `rpc.approve: true` to append it. Not an inherit-parent-trust channel.
	 */
	rpc?: RpcSettings;
}

/**
 * Thinking levels accepted by `pi --thinking`, and the set of suffixes that may
 * appear as `model:level`. Single source of truth: both the argv builder
 * (src/runs/args.ts) and the model-scope matcher import this, so they cannot
 * silently disagree about what counts as a known suffix.
 */
export const THINKING_LEVELS = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
] as const;

export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

/** True when `value` is a recognized thinking level. */
// A one-statement type guard IS the point: it narrows at the call site, which
// a bare `THINKING_LEVELS.includes(...)` would not.
// pi-lens-ignore: pass-through-wrappers
export function isThinkingLevel(value: string): value is ThinkingLevel {
	return (THINKING_LEVELS as readonly string[]).includes(value);
}

// =============================================================================
// Errors
// =============================================================================

// A thin Error subclass: two fields and the two lines of constructor that
// assign them. It has no responsibilities to split.
// pi-lens-ignore: large-class
export class SubagentError extends Error {
	readonly code: string;
	readonly details?: unknown;

	constructor(message: string, code: string, details?: unknown) {
		super(message);
		this.name = "SubagentError";
		this.code = code;
		this.details = details;
	}
}

export const ErrorCodes = {
	HERDR_UNAVAILABLE: "HERDR_UNAVAILABLE",
	DISABLED: "DISABLED",
	/** @deprecated Legacy Herdr client error retained for API compatibility. */
	PANE_BUSY: "PANE_BUSY",
	START_FAILED: "START_FAILED",
	START_TIMEOUT: "START_TIMEOUT",
	NAME_TAKEN: "NAME_TAKEN",
	UNKNOWN_AGENT: "UNKNOWN_AGENT",
	AGENT_DISABLED: "AGENT_DISABLED",
	MODEL_SCOPE_VIOLATION: "MODEL_SCOPE_VIOLATION",
	BUDGET_EXCEEDED: "BUDGET_EXCEEDED",
	NOT_FOUND: "NOT_FOUND",
	RETIRE_FAILED: "RETIRE_FAILED",
	INVALID_PARAMS: "INVALID_PARAMS",
	INSUFFICIENT_MEMORY: "INSUFFICIENT_MEMORY",
} as const;

// =============================================================================
// Defaults (measured)
// =============================================================================

export const DEFAULTS = {
	/** @deprecated Legacy Herdr start-retry settings retained by the archived backend. */
	startRetries: 40,
	startRetryBackoffMs: 150,
	/** F8: agent wait covers a turn; generous default. */
	turnTimeoutMs: 900_000,
	/** jsonl quiet window before declaring a turn settled. */
	settleQuietMs: 2_500,
	/** @deprecated Legacy Herdr concurrency hint retained during migration. */
	maxConcurrentAgents: 6,
	/** @deprecated Legacy Herdr session retention setting. */
	sessionRetentionDays: 7,
	/** @deprecated Legacy Herdr probe settings; retained for the archived backend. */
	startTimeoutMs: 45_000,
	binaryProbeTimeoutMs: 3_000,
	/** @deprecated Legacy Herdr command timeout retained for the archived backend. */
	commandTimeoutMs: 15_000,
} as const;
