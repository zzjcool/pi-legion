/**
 * Public programmatic surface for `pi-legion`.
 *
 * The extension registers a `subagent` tool, but a host that wants to drive the
 * same machinery directly (another extension, a script, a test harness) can
 * import from here instead of reaching into `src/`. Everything re-exported below
 * is covered by the package's test suite and is safe to depend on.
 *
 * ```ts
 * import { Orchestrator, RpcSupervisor, loadAgentsFromDir } from "pi-legion/api";
 *
 * const [scout] = loadAgentsFromDir("/path/to/agents", "user");
 * const orch = new Orchestrator({ supervisor: new RpcSupervisor(), runDir: "/tmp/run", cwd: process.cwd() });
 * const handle = await orch.launch({ agent: scout, task: "survey the repo" });
 * const result = await orch.collect(handle.name);
 * ```
 */

// ── deprecated herdr transport ──────────────────────────────────────────────
/** @deprecated Use `RpcSupervisor` for the v2 execution path. */
export {
	createHerdrClient,
	parseHerdrResponse,
	mapHerdrErrorCode,
	readPaneDiagnostic,
	SubagentError,
} from "./backends/legacy/client.ts";
/** @deprecated Only for pi-legion v0.16.x Herdr workflows. */
export { createCommandRunner, resolveHerdrBin } from "./backends/legacy/runner.ts";
export type { RunnerOptions } from "./backends/legacy/runner.ts";

// ── agent definitions ───────────────────────────────────────────────────────
export {
	BUILTIN_AGENT_NAMES,
	BUILTIN_AGENTS_DIR,
	EXTRA_AGENT_DIRS_ENV,
	LEGACY_EXTRA_AGENT_DIRS_ENV,
	discoverAgents,
	findAgent,
	findNearestProjectAgentsDir,
	formatAgentList,
	formatAgentRoster,
	loadAgentsFromDir,
	parseAgentDocument,
	resolveExtraAgentDirs,
} from "./agents/agents.ts";
export type { DiscoverOptions } from "./agents/agents.ts";
export {
	applyAgentOverrides,
	applyDefaultModel,
	applyOverride,
} from "./agents/overrides.ts";
export {
	parseFrontmatter,
	parseFrontmatterList,
} from "./agents/frontmatter.ts";
export type { ParsedFrontmatter } from "./agents/frontmatter.ts";
export {
	providerOf,
	resolveModel,
	modelCandidates,
} from "./agents/model-resolution.ts";
export type {
	ResolvedModel,
	ResolveModelInput,
} from "./agents/model-resolution.ts";
export {
	applyPreset,
	assertKindModelCoherent,
	expandPreset,
	parsePresets,
	requirePreset,
	resolvePresetName,
} from "./agents/presets.ts";
export { resolveStepModel } from "./agents/step-model.ts";
export type { StepModelInput, StepModelResult } from "./agents/step-model.ts";
export {
	checkModelScope,
	matchesScopePattern,
	parseModelScopeConfig,
	stripThinkingSuffix,
} from "./agents/model-scope.ts";
export {
	loadSubagentSettings,
	parseSubagentSettings,
	resolveSubagentSettings,
} from "./agents/settings.ts";
export {
	applyTeam,
	listTeamNames,
	resolveActiveTeamName,
	DEFAULT_TEAM,
	TEAM_ENV,
} from "./agents/teams.ts";
export type { ActiveTeam } from "./agents/teams.ts";
export type { LoadSettingsOptions } from "./agents/settings.ts";
export { getAgentDir } from "./agents/paths.ts";

export {
	parseTeamCommandArgs,
	createAgentsCommand,
	createTeamCommand,
	createToggleCommand,
	renderTeamStatus,
	sendSlashText,
	updateSubagentSettingsFile,
} from "./extension/slash.ts";
export type { LegionSubcommand } from "./extension/slash.ts";
export {
	aggregateSubagentRuns,
	formatSubagentSummary,
	formatSubagentDetail,
	formatTokens,
	formatCost,
	formatDuration,
	summaryRole,
} from "./extension/summary.ts";
export type {
	SummaryAggregationOptions,
	SummaryChild,
	SummaryDetailInput,
	SummaryFormatOptions,
	SummaryGroup,
	SummarySession,
	SummaryTotals,
	SubagentSummary,
} from "./extension/summary.ts";

// ── runs ────────────────────────────────────────────────────────────────────
export { Orchestrator, preCreateSessionFile, effectiveMaxDepth } from "./runs/orchestrator.ts";
export type { BudgetRefusedEvent, CollectResult, OrchestratorDeps } from "./runs/orchestrator.ts";
export { RpcSupervisor } from "./supervisor/rpc-supervisor.ts";
export { InProcessSupervisor } from "./supervisor/inprocess-supervisor.ts";
export { RoutingSupervisor } from "./supervisor/routing-supervisor.ts";
export { resolveSpawnMode, DEFAULT_SPAWN_MODE, DEFAULT_INPROCESS_MAX_ACTIVE } from "./supervisor/spawn-mode.ts";
export { InMemoryUIProxy, isExtensionUIRequest } from "./supervisor/ui-proxy.ts";
export type {
	ChildHandle,
	LegionSupervisor,
	RpcClientFactory,
	RpcClientLike,
	RpcClientOptions,
	SettleResult,
	SpawnInput,
	SupervisorEvent,
	UsageSnapshot,
} from "./supervisor/types.ts";
export type {
	InProcessSession,
	InProcessSessionFactory,
	InProcessSupervisorOptions,
} from "./supervisor/inprocess-supervisor.ts";
export type {
	RoutingSupervisorOptions,
	SupervisorBackend,
} from "./supervisor/routing-supervisor.ts";
export type { InProcessLimits, SpawnMode } from "./shared/types.ts";
export type {
	ExtensionUIRequest,
	ExtensionUIResponse,
	PendingUIRequest,
	UIProxy,
} from "./supervisor/ui-proxy.ts";
export {
	DEFAULT_VERIFY_TIMEOUT_MS,
	applyVerification,
	needsVerification,
	verifyCommandOf,
	defaultVerifyRunner,
} from "./runs/acceptance.ts";
export type { CommandResult, VerifyRunner } from "./runs/acceptance.ts";
export { RunStore, sanitizeNameForFs, pickChildByName } from "./runs/store.ts";
export type { StoreOptions } from "./runs/store.ts";
export {
	applyThinkingSuffix,
	buildPiArgs,
	TASK_ARG_LIMIT,
	THINKING_LEVELS,
} from "./runs/args.ts";
export type { BuildArgsInput, BuildArgsResult } from "./runs/args.ts";
export {
	cursorModel,
	isPiShapedModel,
	nativeModelFor,
	planKindStart,
} from "./runs/kind.ts";
export type { KindStartPlan } from "./runs/kind.ts";
export {
	createChildWorktree,
	isGitRepo,
	removeChildWorktree,
	resolveLaunchWorktree,
	worktreeBranchFor,
	worktreePathFor,
} from "./runs/worktree.ts";

// ── parent session: completion notify + input-box status ────────────────────
export { createSessionRuntime, shouldRecycleAfterCollect } from "./extension/runtime.ts";
export type {
	CollectSnapshot,
	SessionRuntime,
	SessionRuntimeDeps,
	TrackedJob,
	TrackedJobInput,
} from "./extension/runtime.ts";
export {
	completionDeliveryOptions,
	deliverCompletion,
	formatCollectFailure,
	formatCompletionNotice,
	formatNoticeHeadline,
	formatSize,
	SUBAGENT_NOTIFY_TYPE,
} from "./extension/notify.ts";
export type {
	CompletionDetails,
	CompletionInput,
	CompletionNotice,
	SendMessageOptions,
} from "./extension/notify.ts";
export { renderSubagentNotice } from "./extension/notice-renderer.ts";
export {
	applyOnBlockedPolicy,
	followUpFor,
	formatBlockedPrompt,
} from "./extension/blocked.ts";
export type { BlockedDecision, BlockedFollowUp } from "./extension/blocked.ts";
export {
	canUseCachedCollect,
	formatAlreadyRecycled,
} from "./extension/recycle.ts";
export {
	applyStatus,
	createStatusBoard,
	formatBusyLabel,
	formatFooterStatus,
	formatWidgetLines,
	STATUS_FOOTER_KEY,
	STATUS_WIDGET_KEY,
	STATUS_WIDGET_PLACEMENT,
} from "./tui/status.ts";
export {
	CHILD_ACCEPTANCE_ROLE_ENV,
	CHILD_ROLE_ENV,
	CHILD_TASK_APPENDIX,
	blockChildMessage,
	childTaskAppendix,
	forbiddenChildReason,
	formatChildTask,
	registerChildGuard,
} from "./extension/child-guard.ts";
export {
	ALLOW_NESTED_ENV,
	MAX_TOOL_CALLS_ENV,
	MAX_TURNS_ENV,
	TOOL_TIMEOUT_MS_ENV,
	budgetExceededReason,
	parseBudgetInt,
	wrapBashWithTimeout,
} from "./extension/budget.ts";

// ── session parsing / outcome derivation ────────────────────────────────────
export {
	countAssistantMessages,
	deriveOutcome,
	emptyParsedSession,
	extractVerdict,
	isLastTurnComplete,
	parseSessionFile,
	parseSessionText,
} from "./shared/session.ts";
export {
	mergeProgress,
	progressFromSession,
	progressFromSessionFile,
} from "./shared/progress.ts";
export type { LiveProgress } from "./shared/progress.ts";

// ── shared vocabulary ───────────────────────────────────────────────────────
export { AGENT_KINDS } from "./shared/types.ts";
export type {
	AcceptanceConfig,
	AcceptanceCriterion,
	AcceptanceLevel,
	AcceptanceResult,
	AgentConfig,
	AgentDiscoveryResult,
	AgentOverride,
	TeamConfig,
	TeamMember,
	AgentKind,
	AgentScope,
	AgentSource,
	ChildRecord,
	Execution,
	ExecutionStatus,
	ModelOrigin,
	ModelScopeConfig,
	ModelScopeViolation,
	ModelSourceInfo,
	NestedPathEntry,
	OnBlockedPolicy,
	PresetConfig,
	RunRecord,
	ScoutGuardSettings,
	StopReason,
	SubagentsSettings,
	SystemPromptMode,
	TaskState,
	ToolBudgetConfig,
	TurnBudgetConfig,
	Usage,
} from "./shared/types.ts";
/** @deprecated v0.16.x pane backend compatibility types. */
export type {
	AgentInfo,
	AgentStartResult,
	CommandRunner,
	HerdrClient,
	HerdrError,
	HerdrResult,
	PaneInfo,
	ProcessInfo,
	ReadSource,
	TabInfo,
} from "./backends/legacy/types.ts";
