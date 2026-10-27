/**
 * LegionSupervisor backed by in-process AgentSession (#197).
 *
 * Uses createAgentSession + `SessionManager.open(input.sessionFile, ...)` so the
 * child transcript lands on the file the Orchestrator pre-created (D7; an
 * in-memory manager would leave it empty), or an injectable factory in unit
 * tests. Production factory wires role tools / model / system prompt (#199).
 * Does NOT use RpcClient. Process-tree / SIG retire is skipped.
 */

import { statSync } from "node:fs";
import { formatChildTask } from "../extension/child-guard.ts";
import { childBudgetFromEnv } from "../extension/budget.ts";
import { parseSessionFile } from "../shared/session.ts";
import {
	applyThinkingSuffix,
	childInheritsExtensions,
	collectChildExtensions,
} from "../runs/args.ts";
import { ensureHostExtensions } from "../runs/extension-inheritance.ts";
import {
	ErrorCodes,
	unknownChildError,
	isThinkingLevel,
	type InProcessLimits,
	SubagentError,
	DEFAULT_LEGION_SETTINGS,
} from "../shared/types.ts";
import {
	POLL_INTERVAL_MS,
	DEFAULT_INPROCESS_MAX_ACTIVE,
	DEFAULT_INPROCESS_SPAWN_START_TIMEOUT_MS,
} from "./spawn-mode.ts";
import {
	type ChildLaunchContext,
	runInChildContext,
	runOutsideChildContext,
} from "./child-context.ts";
import {
	inProcessDepth,
	runAtAbsoluteDepth,
	runAtInProcessChildDepthAsync,
} from "./inprocess-depth.ts";
import {
	InMemoryUIProxy,
	type UIProxy,
} from "./ui-proxy.ts";
import {
	type AdmissionVerdict,
	evaluateInProcessAdmission,
	type InProcessAdmissionCounts,
} from "./admission-queue.ts";
import type {
	ChildHandle,
	EventSubscriptionOptions,
	LegionSupervisor,
	SettleResult,
	SpawnInput,
	SupervisorEvent,
	SupervisorEventListener,
	UsageSnapshot,
} from "./types.ts";

/**
 * Stats shape this supervisor reads. Permissive on purpose: it must be
 * structurally assignable from the SDK's `SessionStats` (nested `tokens` +
 * `cost`) AND from lightweight test doubles that report flat counters. Both
 * shapes are declared, and both are actually read in `stats()` — a shape that
 * is declared but never read would silently report zero (REV2-6).
 */
export interface InProcessSessionStats {
	/** Flat counters (test doubles). */
	tokensIn?: number;
	tokensOut?: number;
	costUsd?: number;
	totalCost?: number;
	/** SDK `SessionStats` shape. */
	tokens?: {
		input?: number;
		output?: number;
		cacheRead?: number;
		cacheWrite?: number;
		total?: number;
	};
	cost?: number;
}

/** Narrow session surface InProcessSupervisor needs from AgentSession. */
export interface InProcessSession {
	subscribe(listener: (event: unknown) => void): () => void;
	prompt(text: string): Promise<unknown>;
	steer?(text: string): Promise<unknown>;
	followUp?(text: string): Promise<unknown>;
	abort?(): Promise<unknown>;
	dispose(): void;
	getSessionStats?(): InProcessSessionStats | Promise<InProcessSessionStats>;
}

/** Input to the production / injectable session factory (#199). */
export interface InProcessSessionFactoryInput {
	name: string;
	cwd: string;
	agent: SpawnInput["agent"];
	sessionFile: string;
	/** Resolved model id from Orchestrator (same source as RPC `--model`). */
	model?: string;
	modelProvider?: string;
	thinking?: string | false;
	/**
	 * Settings-injected child context. Joined with the role prompt here the
	 * same way RPC's `pushSystemPromptArgs` does — Orchestrator must not also
	 * inject it through another path for the same spawn.
	 */
	childContext?: string;
}

export type InProcessSessionFactory = (
	input: InProcessSessionFactoryInput,
) => Promise<InProcessSession>;

/**
 * Pure createAgentSession plan derived from spawn input (#199).
 * Unit-tested without constructing a real SDK session.
 */
export interface InProcessSessionPlan {
	cwd: string;
	/** Undefined → omit `tools` so the SDK keeps its default selection. */
	tools?: string[];
	modelRef?: string;
	modelProvider?: string;
	/** Combined role prompt (+ childContext); undefined when neither is set. */
	systemPromptText?: string;
	systemPromptMode: "replace" | "append";
	noExtensions: boolean;
	additionalExtensionPaths: string[];
	noSkills: boolean;
	noContextFiles: boolean;
}

/**
 * Build the v1 in-process session plan: role tools whitelist, resolved model
 * ref, and system prompt (replace/append) aligned with RPC child argv.
 */
export function buildInProcessSessionPlan(
	input: InProcessSessionFactoryInput,
): InProcessSessionPlan {
	const tools = resolveInProcessTools(input.agent);
	const modelRef = applyThinkingSuffix(input.model, input.thinking);
	const { text: systemPromptText, mode: systemPromptMode } =
		resolveInProcessSystemPrompt(input);

	// #280: pi's own discovery is ALWAYS disabled, and the full extension list is
	// passed explicitly. Two reasons:
	//
	//  - the inherited set is now computed by us (minus `excludeExtensions`), so
	//    letting pi discover on top of it would re-add an excluded extension
	//  - `additionalExtensionPaths` loads independently of `noExtensions`, so the
	//    child-guard arrives either way — but only this shape keeps rpc and
	//    in-process byte-identical (rpc also emits `--no-extensions` + explicit
	//    `--extension` flags)
	const noExtensions = true;
	const additionalExtensionPaths = collectChildExtensions(input.agent);

	return {
		cwd: input.cwd,
		...(tools ? { tools } : {}),
		...(modelRef ? { modelRef } : {}),
		...(input.modelProvider ? { modelProvider: input.modelProvider } : {}),
		...(systemPromptText ? { systemPromptText } : {}),
		systemPromptMode,
		noExtensions,
		additionalExtensionPaths,
		noSkills: input.agent.inheritSkills === false,
		noContextFiles: input.agent.inheritProjectContext === false,
	};
}

/** Mirror RPC `pushToolArgs` whitelist (+ vexillatio for non-utility roles). */
function resolveInProcessTools(
	agent: SpawnInput["agent"],
): string[] | undefined {
	const tools = (agent.tools ?? []).filter(Boolean);
	if (tools.length === 0) return undefined;
	if (!agent.utility && !tools.includes("vexillatio")) {
		tools.push("vexillatio");
	}
	return tools;
}

/** Mirror RPC `pushSystemPromptArgs` join + mode rules. */
function resolveInProcessSystemPrompt(input: InProcessSessionFactoryInput): {
	text?: string;
	mode: "replace" | "append";
} {
	const systemPrompt = input.agent.systemPrompt?.trim();
	const childContext = input.childContext?.trim();
	if (!systemPrompt && !childContext) {
		return { mode: input.agent.systemPromptMode };
	}
	const text = [systemPrompt, childContext].filter(Boolean).join("\n\n");
	// When only childContext is present, never replace the SDK base prompt.
	const mode = systemPrompt
		? input.agent.systemPromptMode
		: input.agent.systemPromptMode === "replace"
			? "append"
			: input.agent.systemPromptMode;
	return { text, mode };
}

/**
 * D2/§13.1: a child left the live set, so one admission slot came free.
 *
 * F9/§13.5 is the reason the state is a two-value closed set: `agent_settled`
 * moves a child to `idle`, and `idle` **still holds a slot** (the `active`
 * filter only excludes `exited`/`retired`). Emitting on `idle` would make the
 * admission probe report free slots that the real gate refuses, i.e. admission
 * jitter — the consumer re-queues items it just admitted.
 */
export interface InProcessSlotEvent {
	readonly name: string;
	/** Identical grouping key to assertWithinLimits' maxChildrenPerNode. */
	readonly parentKey: string;
	/** Only retired / exited free a slot; idle still holds one (F9). */
	readonly state: "retired" | "exited";
}

export interface InProcessSupervisorOptions {
	uiProxy?: UIProxy;
	/**
	 * Injected in tests; production uses createAgentSession +
	 * `SessionManager.open(input.sessionFile, ...)` (D7 transcript persistence).
	 */
	sessionFactory?: InProcessSessionFactory;
	/** Limits for this supervisor instance (inprocess.* only). */
	limits?: InProcessLimits;
	/** Resolve limits dynamically (settings reload). Wins over static `limits`. */
	getLimits?: () => InProcessLimits | undefined;
	/**
	 * Diagnostics for a child the supervisor could not use. Two cases:
	 *  - a spawn refused before any session existed (budget / limits), and
	 *  - since #227, a child whose **first turn failed at runtime** (the prompt
	 *    was rejected after `spawnChild` already returned its handle).
	 */
	onSpawnRefused?: (message: string) => void;
	/**
	 * Called at most once per spawn when the child had still not accepted its
	 * first prompt when `spawnStartTimeoutMs` elapsed (#227 D1). Not an error:
	 * the handle was returned anyway.
	 */
	onSpawnDelayed?: (message: string) => void;
	/**
	 * How long to wait for first-prompt acceptance before returning anyway.
	 * Defaults to `DEFAULT_INPROCESS_SPAWN_START_TIMEOUT_MS`; tests inject a
	 * short value instead of waiting 15s.
	 */
	spawnStartTimeoutMs?: number;
	/**
	 * D2: called exactly once per child that leaves the live set — `retireChild`'s
	 * finally, `rollbackSpawn`'s finally, and `disposeRecord` (idempotent across
	 * all three). Deliberately NOT wired to the `idle` transition (§13.5/A19).
	 */
	onSlotReleased?: (event: InProcessSlotEvent) => void;
}

interface EventSubscription {
	listener: SupervisorEventListener;
	includeTextDelta: boolean;
}

interface SettleWaiter {
	resolve(result: SettleResult): void;
	timer?: NodeJS.Timeout;
	cleanup?: () => void;
}

/**
 * Shared hand-off between the first turn's drain and the acceptance gate
 * (#227 D1a).
 *
 * The drain is the only place that learns *how* the prompt ended, while the gate
 * is the only place that knows whether the turn had been accepted by then.
 * `rejected` is set by the drain; `released` is set by the gate once
 * `spawnChild` has committed to returning a handle for this child — after that
 * point a failure is a runtime failure (D2), never a spawn failure.
 */
interface FirstTurnGate {
	/** The prompt rejected. */
	rejected?: { message: string };
	/** `spawnChild` is returning a handle; the failure is no longer a spawn error. */
	released: boolean;
	/**
	 * The D2 runtime-failure bookkeeping has run for `rejected`. Exactly-once:
	 * a rejection can be recorded before the gate commits (so the drain defers)
	 * and still need applying afterwards.
	 */
	applied?: boolean;
}

type ChildState = "starting" | "running" | "idle" | "retiring" | "exited" | "retired";

interface ChildRecord {
	name: string;
	sessionFile: string;
	session: InProcessSession | null;
	state: ChildState;
	alive: boolean;
	turnActive: boolean;
	retireRequested: boolean;
	lastTurnResult?: SettleResult;
	exitResult?: SettleResult;
	waiters: Set<SettleWaiter>;
	subscriptions: Set<EventSubscription>;
	unsubscribeSession?: () => void;
	retirePromise?: Promise<void>;
	abortedPending: boolean;
	spawnDepth: number;
	parentKey: string;
	/**
	 * Failure surfaced by an `error` event during the current turn (#227 D3).
	 * Cleared when the next turn starts and consumed by the next `agent_settled`,
	 * which is the only place it becomes visible (as `SettleResult.reason`).
	 */
	pendingFailure?: string;
	/** Identity reused by every later dispatch into this child (tools inherit it). */
	context: ChildLaunchContext;
	/**
	 * A19: an admission slot is freed exactly once per departure from the live
	 * set. All three release points (`retireChild`, `rollbackSpawn`,
	 * `disposeRecord`) can observe the same record, so the flag — not the call
	 * site — is what makes `onSlotReleased` fire once.
	 */
	slotReleased?: boolean;
}

const COARSE_EVENT_TYPES = new Set([
	"agent_start",
	"agent_end",
	"agent_settled",
	"turn_start",
	"turn_end",
	"tool_execution_start",
	"tool_execution_end",
]);

/** Parent key for maxChildrenPerNode (name before last `.`, or "" for roots). */
function parentKeyOf(name: string): string {
	const idx = name.lastIndexOf(".");
	return idx === -1 ? "" : name.slice(0, idx);
}

/**
 * Identity scope for one in-process child (spawn-default-inprocess-v3 D5).
 *
 * A caller may hand over a full `childLaunchContext`; when it does not, we
 * still establish a minimal context so that the child never observes "no
 * identity" and mistakes itself for the root session. The fallback is derived
 * from the spawn input only — it carries no db/node lineage, which is exactly
 * why partial identity must not be mistaken for a complete one downstream.
 */
function resolveChildLaunchContext(input: SpawnInput): ChildLaunchContext {
	const provided = input.childLaunchContext;
	if (provided) {
		// REV2-3: store a deep-enough snapshot, never the caller's live object.
		// A caller that reuses one template object (or one `parentPath` array)
		// across spawns would otherwise mutate the identity of an already-spawned
		// child for its later dispatches — the A-becomes-B leak D5 exists to kill.
		return {
			...provided,
			// Element-level copy too: after the path became `NestedPathEntry[]`
			// (objects), `[...path]` would still alias every entry, so a caller
			// mutating `template.parentPath[0].runId` would rewrite an
			// already-spawned child's lineage — the exact A-becomes-B leak.
			...(provided.parentPath
				? { parentPath: provided.parentPath.map((entry) => ({ ...entry })) }
				: {}),
		};
	}
	const acceptanceRole = input.agent.acceptance?.role;
	return {
		allowNested: input.allowNestedSubagents === true,
		utility: Boolean(input.agent.utility),
		spawnMode: "inprocess",
		...(acceptanceRole ? { acceptanceRole } : {}),
		// #295: read the budgets off `SpawnInput.env` — the same keys the rpc child
		// gets as its real environment — and carry them in the context, because the
		// in-process child shares the host's process.env and cannot see them there.
		...budgetFromSpawnEnv(input.env),
	};
}

/** Extract the child budget keys from a spawn env, for the in-process channel. */
function budgetFromSpawnEnv(env: NodeJS.ProcessEnv | undefined): {
	budget?: ChildLaunchContext["budget"];
} {
	if (!env) return {};
	const budget = childBudgetFromEnv(env);
	return budget.maxToolCalls === undefined && budget.maxTurns === undefined && budget.toolTimeoutMs === undefined
		? {}
		: { budget };
}

function recordOf(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

/** Human-readable text for a rejected prompt / emitted `error` payload. */
function failureMessage(error: unknown): string {
	if (error instanceof Error) return error.message;
	const record = recordOf(error);
	if (record) {
		// SDK `error` events carry the failing assistant message under `error`
		// (or a bare `message`), and that message holds the provider text.
		const nested = recordOf(record.error) ?? recordOf(record.message);
		const text = nested?.errorMessage ?? record.message ?? record.error;
		if (typeof text === "string" && text.trim() !== "") return text;
	}
	return String(error);
}

/**
 * Provider registrations an extension queued during loading (#209-1).
 *
 * Structurally typed on purpose: this file reaches the SDK through a dynamic
 * `import()` (no static SDK type imports), so only the three arrays the drain
 * touches are declared — and `unknown` for the payloads, which are just
 * forwarded to the model runtime.
 */
export interface ExtensionRegistrationQueues {
	pendingProviderRegistrations: Array<{
		name: string;
		config: unknown;
		extensionPath?: string;
	}>;
	pendingNativeProviderRegistrations: Array<{
		provider: unknown;
		extensionPath?: string;
	}>;
	pendingVirtualModelRegistrations: Array<{
		definition: unknown;
		extensionPath?: string;
	}>;
}

/** Minimal `ModelRuntime` surface the drain needs (structurally typed). */
export interface ModelRuntimeLike {
	registerProvider(name: string, config: unknown): void;
	registerNativeProvider(provider: unknown): void;
	registerVirtualModel(definition: unknown): void;
	/** Must reset the *synchronous* catalog snapshot the resolver reads. */
	refresh(options?: { allowNetwork?: boolean }): Promise<unknown>;
}

/** The `{ type, message }` diagnostic shape the SDK's runtime APIs return. */
export interface DiagnosticLike {
	type: "info" | "warning" | "error";
	message: string;
}

function registrationDiagnostic(
	what: string,
	extensionPath: string | undefined,
	error: unknown,
): DiagnosticLike {
	const message = error instanceof Error ? error.message : String(error);
	return {
		type: "error",
		message: `Extension "${extensionPath ?? "<unknown>"}" failed to register ${what}: ${message}`,
	};
}

/**
 * Drain extension provider registrations into a `ModelRuntime` (#209-1).
 *
 * `DefaultResourceLoader.reload()` really does load and execute the extension
 * files, but before the extension runner binds, `pi.registerProvider()` and
 * friends only push onto `runtime.pending*Registrations`. Nothing in Legion
 * binds that runner for a child session, so the queues were never consumed and
 * an extension-provided provider (e.g. `pi-any-endpoint`) was invisible.
 *
 * Consuming the queues alone is not enough: `registerProvider()` kicks off its
 * catalog refresh fire-and-forget (`void this.refresh(...)`) while
 * `resolveCliModel()` reads the *synchronous* `getModels()` snapshot. The
 * awaited offline refresh below is what makes the extension's self-discovered
 * catalog land in that snapshot (`allowNetwork: false` — `pi-any-endpoint`
 * reads offline `stored.models`, so no network is involved).
 *
 * Failures are collected as diagnostics and never thrown: a broken extension
 * must not fail the child spawn. Queues are emptied either way so a retry does
 * not replay them onto the next runtime.
 */
export async function drainExtensionRegistrations(
	resourceLoader: { getExtensions(): { runtime: ExtensionRegistrationQueues } },
	modelRuntime: ModelRuntimeLike,
): Promise<DiagnosticLike[]> {
	const diagnostics: DiagnosticLike[] = [];
	const { runtime } = resourceLoader.getExtensions();

	for (const { name, config, extensionPath } of runtime.pendingProviderRegistrations) {
		try {
			modelRuntime.registerProvider(name, config);
		} catch (error) {
			diagnostics.push(
				registrationDiagnostic(`provider "${name}"`, extensionPath, error),
			);
		}
	}
	runtime.pendingProviderRegistrations = [];

	for (const { provider, extensionPath } of runtime.pendingNativeProviderRegistrations) {
		try {
			modelRuntime.registerNativeProvider(provider);
		} catch (error) {
			diagnostics.push(
				registrationDiagnostic("native provider", extensionPath, error),
			);
		}
	}
	runtime.pendingNativeProviderRegistrations = [];

	for (const { definition, extensionPath } of runtime.pendingVirtualModelRegistrations) {
		try {
			modelRuntime.registerVirtualModel(definition);
		} catch (error) {
			diagnostics.push(
				registrationDiagnostic("virtual model", extensionPath, error),
			);
		}
	}
	runtime.pendingVirtualModelRegistrations = [];

	await modelRuntime.refresh({ allowNetwork: false });
	return diagnostics;
}

async function defaultSessionFactory(
	input: InProcessSessionFactoryInput,
): Promise<InProcessSession> {
	const {
		createAgentSession,
		SessionManager,
		DefaultResourceLoader,
		getAgentDir,
		ModelRuntime,
		resolveCliModel,
	} = await import("@earendil-works/pi-coding-agent");

	const plan = buildInProcessSessionPlan(input);
	const agentDir = getAgentDir();

	const loaderOptions: ConstructorParameters<typeof DefaultResourceLoader>[0] = {
		cwd: plan.cwd,
		agentDir,
		noExtensions: plan.noExtensions,
		...(plan.additionalExtensionPaths.length > 0
			? { additionalExtensionPaths: plan.additionalExtensionPaths }
			: {}),
		...(plan.noSkills ? { noSkills: true } : {}),
		...(plan.noContextFiles ? { noContextFiles: true } : {}),
	};

	if (plan.systemPromptText) {
		if (plan.systemPromptMode === "replace") {
			loaderOptions.systemPromptOverride = () => plan.systemPromptText;
			// Avoid host APPEND_SYSTEM.md appending onto a replaced role prompt.
			loaderOptions.appendSystemPromptOverride = () => [];
		} else {
			loaderOptions.appendSystemPromptOverride = (base) => [
				...base,
				plan.systemPromptText!,
			];
		}
	}

	const resourceLoader = new DefaultResourceLoader(loaderOptions);
	await resourceLoader.reload();

	// #209-1: the extension files above were loaded and executed, but their
	// provider registrations are still sitting in `runtime.pending*Registrations`
	// (they only take effect once an extension runner binds, which a child
	// session without `createAgentSessionServices()` never does). Drain them into
	// the runtime handed to `createAgentSession` so extension-provided providers
	// are resolvable by both the `--model` resolve below and the session itself.
	const modelRuntime = await ModelRuntime.create();
	for (const diagnostic of await drainExtensionRegistrations(
		resourceLoader,
		modelRuntime,
	)) {
		if (diagnostic.type === "error") {
			// Non-fatal by design (same as the SDK): the spawn only fails if the
			// model itself cannot be resolved.
			console.warn(`[pi-legion] inprocess child '${input.name}': ${diagnostic.message}`);
		}
	}

	// D7 — the transcript must land on the file the Orchestrator pre-created
	// (`orchestrator.ts` `preCreateSessionFile`). With `SessionManager.inMemory()`
	// `getSessionFile()` returns undefined and nothing is ever written, so
	// `deriveOutcome(parseSessionFile(...))` sees an empty file and every
	// in-process child "succeeds with zero output". `open()` on the pre-created
	// empty file works and reports that path. Deliberately no try/catch fallback
	// to inMemory: a silent fallback would restore exactly that zero-output bug.
	const createOptions: Parameters<typeof createAgentSession>[0] = {
		cwd: plan.cwd,
		sessionManager: SessionManager.open(input.sessionFile, undefined, plan.cwd),
		resourceLoader,
		// Injected unconditionally — including when `plan.modelRef` is empty. Left
		// out, `createAgentSession` would build its own runtime and be blind to
		// the extension providers drained above all over again.
		modelRuntime,
		...(plan.tools ? { tools: plan.tools } : {}),
	};

	if (plan.modelRef) {
		// Same runtime instance as the drain: its snapshot is the one that
		// contains the extension-registered providers.
		const resolved = resolveCliModel({
			cliModel: plan.modelRef,
			...(plan.modelProvider ? { cliProvider: plan.modelProvider } : {}),
			modelRuntime,
		});
		if (resolved.error || !resolved.model) {
			throw new SubagentError(
				`inprocess model resolve failed for '${plan.modelRef}'` +
					(resolved.error ? `: ${resolved.error}` : ""),
				ErrorCodes.START_FAILED,
			);
		}
		createOptions.model = resolved.model;
		if (resolved.thinkingLevel && isThinkingLevel(resolved.thinkingLevel)) {
			createOptions.thinkingLevel = resolved.thinkingLevel;
		} else if (
			typeof input.thinking === "string" &&
			isThinkingLevel(input.thinking)
		) {
			createOptions.thinkingLevel = input.thinking;
		}
	}

	const { session } = await createAgentSession(createOptions);
	return session;
}

/**
 * Host-side in-process adapter for the frozen §3.1 LegionSupervisor contract.
 */
export class InProcessSupervisor implements LegionSupervisor {
	private readonly children = new Map<string, ChildRecord>();
	private readonly subscriptionsBeforeSpawn = new Map<string, Set<EventSubscription>>();
	private readonly sessionFactory: InProcessSessionFactory;
	private readonly getLimits: () => InProcessLimits | undefined;
	private readonly onSpawnRefused?: (message: string) => void;
	private readonly onSpawnDelayed?: (message: string) => void;
	private readonly onSlotReleased?: (event: InProcessSlotEvent) => void;
	private readonly spawnStartTimeoutMs: number;
	readonly uiProxy: UIProxy;
	private spawnCount = 0;

	constructor(options: InProcessSupervisorOptions = {}) {
		this.sessionFactory = options.sessionFactory ?? defaultSessionFactory;
		this.uiProxy = options.uiProxy ?? new InMemoryUIProxy();
		this.getLimits = options.getLimits
			?? (() => options.limits);
		this.onSpawnRefused = options.onSpawnRefused;
		this.onSpawnDelayed = options.onSpawnDelayed;
		this.onSlotReleased = options.onSlotReleased;
		this.spawnStartTimeoutMs =
			options.spawnStartTimeoutMs ?? DEFAULT_INPROCESS_SPAWN_START_TIMEOUT_MS;
	}

	/**
	 * Effective in-process limits.
	 *
	 * RECORDED CONTRACT CHANGE (spawn-default-inprocess-v3 D4): the old rule was
	 * "no `subagents.inprocess` block → unlimited". Now that inprocess is the
	 * default backend, "no config" would mean unbounded recursive spawning, so
	 * an absent block falls back to the same safe numbers RPC uses
	 * (`DEFAULT_LEGION_SETTINGS.maxDepth/maxChildrenPerNode/maxActiveNodes`).
	 *
	 * An *explicit* block keeps `DEFAULT_INPROCESS_MAX_ACTIVE` when it omits
	 * `maxActive` (existing behaviour; tests depend on it).
	 * `maxSpawnsPerSession` / `waitTimeoutMs` stay undefined by default — same
	 * asymmetry as the RPC knobs, which have no defaults either.
	 */
	private limits(): Required<
		Pick<InProcessLimits, "maxDepth" | "maxChildrenPerNode" | "maxActive">
	> &
		InProcessLimits {
		const configured = this.getLimits();
		if (configured === undefined) {
			return {
				maxDepth: DEFAULT_LEGION_SETTINGS.maxDepth,
				maxChildrenPerNode: DEFAULT_LEGION_SETTINGS.maxChildrenPerNode,
				maxActive: DEFAULT_LEGION_SETTINGS.maxActiveNodes,
			};
		}
		return {
			...configured,
			maxDepth: configured.maxDepth ?? DEFAULT_LEGION_SETTINGS.maxDepth,
			maxChildrenPerNode:
				configured.maxChildrenPerNode ??
				DEFAULT_LEGION_SETTINGS.maxChildrenPerNode,
			maxActive: configured.maxActive ?? DEFAULT_INPROCESS_MAX_ACTIVE,
		};
	}

	async spawnChild(input: SpawnInput): Promise<ChildHandle> {
		// #280 R1-b: warm host-extension discovery HERE, not only in
		// `RoutingSupervisor`, because a caller may construct this backend
		// directly (`new Orchestrator({ supervisor: new RpcSupervisor() })` is the
		// documented public shape in `api.ts`, and it is `Orchestrator`'s default).
		// That path bypasses the router entirely, and without this the child's
		// argv builder would read an empty sync cache and inherit nothing.
		//
		// It cannot live in `Orchestrator.launch`: that fast path must not gain an
		// await before the synchronous admission block
		// (launch-admission-queue-v1 §13.7 ban 5 / F16).
		//
		// Idempotent and never rejects, so the router's own warm call makes this a
		// map lookup, and a failed `pi list` still leaves a working launch.
		await ensureHostExtensions();
		if (input.agent.kind !== "pi") {
			throw new SubagentError(
				`InProcessSupervisor only supports pi children (received kind '${input.agent.kind}')`,
				ErrorCodes.INVALID_PARAMS,
			);
		}
		if (input.agent.worktree === true) {
			throw new SubagentError(
				`spawnMode "inprocess" cannot use worktree isolation for '${input.name}'; set worktree: false`,
				ErrorCodes.INVALID_PARAMS,
			);
		}

		this.assertWithinLimits(input.name);

		const previous = this.children.get(input.name);
		if (previous && previous.state !== "exited" && previous.state !== "retired") {
			throw new SubagentError(
				`child is already registered and alive: ${input.name}`,
				ErrorCodes.NAME_TAKEN,
			);
		}
		if (previous) this.disposeRecord(previous);

		const registration: ChildRecord = {
			name: input.name,
			sessionFile: input.sessionFile,
			session: null,
			state: "starting",
			alive: true,
			turnActive: false,
			retireRequested: false,
			abortedPending: false,
			waiters: new Set(),
			subscriptions:
				this.subscriptionsBeforeSpawn.get(input.name) ?? new Set(),
			spawnDepth: inProcessDepth() + 1,
			parentKey: parentKeyOf(input.name),
			context: resolveChildLaunchContext(input),
		};
		this.subscriptionsBeforeSpawn.delete(input.name);
		this.children.set(input.name, registration);

		try {
			return await runAtInProcessChildDepthAsync(() =>
				// Identity scope: the session factory and the first prompt both run
				// inside it, so every tool the child executes during that turn
				// inherits the child's context instead of seeing the root's.
				runInChildContext(registration.context, async () => {
					// #227 D1: the acceptance baseline is the transcript size at the
					// moment *this spawn* starts (a missing file counts as 0), so a
					// line the factory or a previous turn already wrote cannot pass
					// for this child having accepted the prompt.
					const baselineSize = this.sessionFileSize(registration.sessionFile);
					const session = await this.sessionFactory({
						name: input.name,
						cwd: input.cwd,
						agent: input.agent,
						sessionFile: input.sessionFile,
						...(input.model !== undefined ? { model: input.model } : {}),
						...(input.modelProvider !== undefined
							? { modelProvider: input.modelProvider }
							: {}),
						...(input.thinking !== undefined
							? { thinking: input.thinking }
							: {}),
						...(input.childContext !== undefined
							? { childContext: input.childContext }
							: {}),
					});
					registration.session = session;
					registration.unsubscribeSession = session.subscribe((event) =>
						this.handleSessionEvent(registration, event),
					);
					registration.state = "idle";
					this.spawnCount += 1;
					// `beginTurn` must precede the prompt (R2): the turn's events are
					// already streaming by the time this frame yields.
					this.beginTurn(registration);
					// #227 D1/D2: start the first turn and hand it to a background
					// drain instead of awaiting the whole agent run here. The drain is
					// created *inside* this ALS scope on purpose, so every later
					// continuation (and any tool promise it settles) still runs at the
					// child's identity and nesting depth (R1).
					const gate: FirstTurnGate = { released: false };
					const promptSettled = this.drainFirstTurn(
						registration,
						session.prompt(
							formatChildTask(input.task, {
								allowNested: input.allowNestedSubagents === true,
								...(input.worktreeBranch
									? { worktreeBranch: input.worktreeBranch }
									: {}),
							}),
						),
						gate,
					);
					// Return once the child has *accepted* the turn, not when it ends.
					await this.awaitFirstTurnAccepted(
						registration,
						baselineSize,
						promptSettled,
						gate,
					);
					return {
						name: registration.name,
						sessionFile: registration.sessionFile,
					};
				}),
			);
		} catch (error) {
			await this.rollbackSpawn(registration);
			if (error instanceof SubagentError) {
				this.onSpawnRefused?.(error.message);
			}
			throw error;
		}
	}

	/** Bytes in the child transcript so far; a missing file counts as 0 (#227 D1). */
	private sessionFileSize(sessionFile: string): number {
		try {
			return statSync(sessionFile).size;
		} catch {
			return 0;
		}
	}

	/**
	 * Has this child accepted the prompt? True once its transcript holds a user
	 * turn *and* has grown past the pre-spawn baseline (`F7`: the SDK appends the
	 * user message before running the agent).
	 *
	 * Contract F7 forbids using `isLastTurnComplete` here: while the prompt is
	 * merely accepted the last turn legitimately has a user message and no
	 * assistant yet, so that predicate would contradict itself.
	 */
	private firstTurnAccepted(child: ChildRecord, baselineSize: number): boolean {
		if (this.sessionFileSize(child.sessionFile) <= baselineSize) return false;
		return parseSessionFile(child.sessionFile).turns.length > 0;
	}

	/**
	 * Resolve when the child has accepted the first prompt, when the prompt has
	 * already settled (it then certainly was accepted — a fast turn is done and
	 * waiting for the bound would only add latency), or when the start bound
	 * elapses (#227 D1). The bound is never an error: the caller returns its
	 * handle either way and is told once through `onSpawnDelayed`.
	 */
	private awaitFirstTurnAccepted(
		child: ChildRecord,
		baselineSize: number,
		promptSettled: Promise<void>,
		gate: FirstTurnGate,
	): Promise<void> {
		const deadline = Date.now() + this.spawnStartTimeoutMs;
		return new Promise((resolve, reject) => {
			let timer: NodeJS.Timeout | undefined;
			let done = false;
			/**
			 * Commit to returning a handle for this child. From here on the drain
			 * treats a later failure as a runtime failure (D2), not a spawn error.
			 */
			const finish = (delayed: boolean): void => {
				if (done) return;
				done = true;
				gate.released = true;
				if (timer) {
					clearTimeout(timer);
					timer = undefined;
				}
				// A rejection recorded before this commit still has to become the
				// visible runtime failure (D2): the drain deferred it because the
				// spawn had not yet committed to returning a handle.
				this.applyFirstTurnFailure(child, gate);
				if (delayed) {
					this.onSpawnDelayed?.(
						`in-process child '${child.name}' did not accept its first prompt within ` +
							`${this.spawnStartTimeoutMs}ms; returning the handle anyway (its first turn ` +
							"keeps running in the background)",
					);
				}
				resolve();
			};
			/**
			 * #227 D1a: the prompt failed and nothing was accepted, so this child
			 * never started. Returning a handle here would let `Orchestrator.launch`
			 * believe the spawn succeeded and silently disable the `fallbackModels`
			 * chain (`canFallbackStart` only reacts to a thrown SubagentError). Fail
			 * the spawn instead; the caller's existing catch rolls the child back.
			 */
			const fail = (message: string): void => {
				done = true;
				if (timer) {
					clearTimeout(timer);
					timer = undefined;
				}
				reject(new SubagentError(message, ErrorCodes.START_FAILED));
			};
			const tick = (): void => {
				if (done) return;
				if (this.firstTurnAccepted(child, baselineSize)) return finish(false);
				if (gate.rejected) return fail(gate.rejected.message);
				const remaining = deadline - Date.now();
				if (remaining <= 0) return finish(true);
				// Reuse the shared poll cadence, but never oversleep the bound.
				timer = setTimeout(tick, Math.min(POLL_INTERVAL_MS, remaining));
			};
			/**
			 * The prompt settled. `drainFirstTurn` reports the rejection through
			 * `gate` and then resolves, so this is the one place that decides
			 * between "spawn succeeded" and "spawn failed" (#227 D1a).
			 *
			 * A plain `finish(false)` here would be exactly the regression: a
			 * pre-acceptance reject would read as a successful spawn.
			 */
			const onSettled = (): void => {
				if (done) return;
				// Accepted at any point → the turn ran, so a failure is a runtime
				// failure (D2) and `spawnChild` still returns its handle.
				if (this.firstTurnAccepted(child, baselineSize)) return finish(false);
				// Rejected without ever being accepted → the child never started.
				// Report it as a spawn failure so `canFallbackStart` can retry.
				if (gate.rejected) return fail(gate.rejected.message);
				// Prompt resolved but no user line is visible yet (a fake whose
				// transcript is not on disk, or a write still in flight): the turn
				// ended, so there is nothing left to wait for.
				finish(false);
			};
			// `drainFirstTurn` deliberately resolves rather than rejects, and the
			// second handler keeps a throwing diagnostic callback from becoming an
			// unhandled rejection on a promise nobody awaits.
			void promptSettled.then(onSettled, onSettled);
			tick();
		});
	}

	/**
	 * Detach the first turn's completion from `spawnChild` (#227 D2).
	 *
	 * Resolves (never rejects) once the prompt settles, so both callers can
	 * await it without risking an unhandled rejection.
	 */
	private drainFirstTurn(
		child: ChildRecord,
		prompt: Promise<unknown>,
		gate: FirstTurnGate,
	): Promise<void> {
		return prompt.then(
			() => {
				// Normal completion. `agent_settled` already carried the turn state
				// (the SDK emits it in the run's `finally`, before this resolves), so
				// only a child that died mid-turn needs reconciling here.
				if (!this.isAlive(child.name) && child.turnActive) {
					child.turnActive = false;
				}
			},
			(error: unknown) => {
				const message = failureMessage(error);
				// #227 D1a: publish the failure for the acceptance gate *first*, so
				// the gate can turn a pre-acceptance reject into a spawn failure.
				gate.rejected = { message };
				// Until `spawnChild` commits to returning a handle, this is a spawn
				// failure: the caller's catch runs `rollbackSpawn` + rethrow, and it
				// owns the waiter/diagnostic reporting. Doing it here as well would
				// report twice and leave state on a child that is being torn down.
				if (!gate.released) return;
				this.applyFirstTurnFailure(child, gate);
			},
		);
	}

	/**
	 * Turn a rejected first prompt into the visible runtime failure (#227 D2).
	 *
	 * Exactly-once per rejection, because it can be reached from two places: the
	 * drain (the usual path, after `spawnChild` committed to a handle) and
	 * `awaitFirstTurnAccepted`'s `finish()` (a prompt that rejected before the
	 * gate committed and then had its turn accepted anyway).
	 *
	 * Never `rollbackSpawn` here: the handle was already handed to the caller,
	 * and rollback would `children.delete` it out from under them.
	 */
	private applyFirstTurnFailure(child: ChildRecord, gate: FirstTurnGate): void {
		const message = gate.rejected?.message;
		if (message === undefined || gate.applied) return;
		gate.applied = true;
		child.turnActive = false;
		if (child.state !== "retiring") child.state = "idle";
		const result: SettleResult = {
			settled: false,
			abnormal: false,
			reason: `child turn failed: ${message}`,
		};
		child.lastTurnResult = result;
		this.resolveWaiters(child, result);
		// #227 D2: the callback's semantics now also cover a child failing at
		// runtime, not just a refused spawn.
		this.onSpawnRefused?.(message);
		// ...and leave a machine-readable trace for D3's settle mapping, so the
		// failure survives a later `agent_settled` rather than only living in the
		// transient `lastTurnResult`.
		this.handleSessionEvent(child, {
			type: "error",
			message: `child turn failed: ${message}`,
		});
	}

	async prompt(name: string, text: string): Promise<void> {
		const child = this.requireChild(name);
		await this.dispatch(child, "prompt", text);
	}

	async steer(name: string, text: string): Promise<void> {
		const child = this.requireChild(name);
		await this.dispatch(child, "steer", text);
	}

	async followUp(name: string, text: string): Promise<void> {
		const child = this.requireChild(name);
		await this.dispatch(child, "followUp", text);
	}

	async abort(name: string): Promise<void> {
		const child = this.requireChild(name);
		this.assertCanSend(child);
		if (!child.turnActive) return;
		// Same identity scope and nesting depth as the child's own turn: abort can
		// settle tool promises whose continuations still run inside it.
		await runAtAbsoluteDepth(child.spawnDepth, () =>
			runInChildContext(child.context, async () => {
				await child.session?.abort?.();
			}),
		);
	}

	waitSettled(name: string, timeoutMs = 900_000, signal?: AbortSignal): Promise<SettleResult> {
		const child = this.requireChild(name);
		return runAtAbsoluteDepth(child.spawnDepth, () =>
			runInChildContext(child.context, () =>
				this.awaitSettled(child, timeoutMs, signal),
			),
		);
	}

	private awaitSettled(
		child: ChildRecord,
		timeoutMs: number,
		signal: AbortSignal | undefined,
	): Promise<SettleResult> {
		const name = child.name;
		const limits = this.limits();
		const effectiveTimeout =
			timeoutMs === 900_000 && limits.waitTimeoutMs !== undefined
				? limits.waitTimeoutMs
				: timeoutMs;
		if (signal?.aborted) {
			return Promise.resolve({ settled: false, abnormal: false, reason: "aborted by parent" });
		}
		if (!child.turnActive && child.lastTurnResult) {
			return Promise.resolve(child.lastTurnResult);
		}
		if (child.exitResult) return Promise.resolve(child.exitResult);
		if (!this.isAlive(name)) {
			return Promise.resolve(
				child.exitResult ?? {
					settled: false,
					abnormal: !child.retireRequested,
					reason: child.retireRequested ? "child retired" : "in-process session ended",
				},
			);
		}
		if (!child.turnActive) {
			return Promise.resolve(
				child.lastTurnResult ?? {
					settled: false,
					abnormal: false,
					reason: "no active turn",
				},
			);
		}

		return new Promise((resolve) => {
			const waiter: SettleWaiter = { resolve };
			let abortListener: (() => void) | undefined;
			waiter.cleanup = () => {
				if (waiter.timer) {
					clearTimeout(waiter.timer);
					waiter.timer = undefined;
				}
				if (signal && abortListener) {
					signal.removeEventListener("abort", abortListener);
					abortListener = undefined;
				}
			};
			child.waiters.add(waiter);
			if (effectiveTimeout > 0) {
				waiter.timer = setTimeout(() => {
					child.waiters.delete(waiter);
					waiter.cleanup?.();
					resolve({ settled: false, abnormal: false, reason: "timeout" });
				}, effectiveTimeout);
			}
			if (signal) {
				abortListener = () => {
					if (!child.waiters.delete(waiter)) return;
					waiter.cleanup?.();
					resolve({ settled: false, abnormal: false, reason: "aborted by parent" });
				};
				if (signal.aborted) abortListener();
				else signal.addEventListener("abort", abortListener, { once: true });
			}
		});
	}

	isAlive(name: string): boolean {
		const child = this.children.get(name);
		if (!child || !child.alive) return false;
		return child.state !== "retired" && child.state !== "exited";
	}

	async stats(name: string): Promise<UsageSnapshot | null> {
		const child = this.children.get(name);
		if (!child || !child.session || !this.isAlive(name)) return null;
		try {
			const raw = await child.session.getSessionStats?.();
			if (!raw) return null;
			// REV2-6: the real AgentSession reports `tokens: {input, output}` + `cost`
			// (agent-session.d.ts SessionStats), while test doubles use flat counters.
			// Reading only the flat keys made production usage read as 0 and let
			// stats() overwrite the correct usage the Orchestrator had already
			// written to the transcript.
			return {
				tokensIn: Number(raw.tokensIn ?? raw.tokens?.input ?? 0),
				tokensOut: Number(raw.tokensOut ?? raw.tokens?.output ?? 0),
				costUsd: Number(raw.costUsd ?? raw.totalCost ?? raw.cost ?? 0),
			};
		} catch {
			return null;
		}
	}

	retire(name: string, opts: { graceful?: boolean } = {}): Promise<void> {
		const child = this.requireChild(name);
		if (child.retirePromise) return child.retirePromise;
		const pending = this.retireChild(child, opts.graceful !== false);
		child.retirePromise = pending;
		void pending.catch(() => {
			if (child.retirePromise === pending) child.retirePromise = undefined;
		});
		return pending;
	}

	onEvent(
		name: string,
		listener: SupervisorEventListener,
		options: EventSubscriptionOptions = {},
	): () => void {
		const child = this.children.get(name);
		const subscription: EventSubscription = {
			listener,
			includeTextDelta: options.includeTextDelta === true,
		};
		const subscriptions = child?.subscriptions ?? this.pendingSubscriptions(name);
		subscriptions.add(subscription);
		return () => {
			subscriptions.delete(subscription);
			if (
				!child &&
				subscriptions.size === 0 &&
				this.subscriptionsBeforeSpawn.get(name) === subscriptions
			) {
				this.subscriptionsBeforeSpawn.delete(name);
			}
		};
	}

	private pendingSubscriptions(name: string): Set<EventSubscription> {
		let subscriptions = this.subscriptionsBeforeSpawn.get(name);
		if (!subscriptions) {
			subscriptions = new Set();
			this.subscriptionsBeforeSpawn.set(name, subscriptions);
		}
		return subscriptions;
	}

	private assertWithinLimits(name: string): void {
		// D1-a: the four gates and their four user-visible messages live in exactly
		// one place (`evaluateInProcessAdmission`), so `admissionCounts()` /
		// `preflightAdmission()` and this authoritative gate cannot drift apart.
		const verdict = evaluateInProcessAdmission(this.admissionCounts(name));
		if (verdict.admitted) return;
		this.onSpawnRefused?.(verdict.message);
		throw new SubagentError(verdict.message, ErrorCodes.BUDGET_EXCEEDED);
	}

	/**
	 * Read-only count snapshot for the admission probe (§4.2, I-O1).
	 *
	 * The `active` / `siblings` filters are byte-identical to the ones
	 * `assertWithinLimits` always used (F5): only `exited` / `retired` leave the
	 * live set, so an `idle` child still holds its slot (F9, §13.5). `maxSpawns`
	 * is passed through as-is (`undefined` when unconfigured) — the gate treats
	 * “no limit” and “over the limit” differently.
	 */
	admissionCounts(name: string): InProcessAdmissionCounts {
		const limits = this.limits();
		const parentKey = parentKeyOf(name);
		const active = [...this.children.values()].filter(
			(c) => c.state !== "exited" && c.state !== "retired",
		);
		return {
			parentKey,
			siblings: active.filter((c) => c.parentKey === parentKey).length,
			active: active.length,
			spawnCount: this.spawnCount,
			depth: inProcessDepth(),
			limits: {
				maxDepth: limits.maxDepth,
				maxChildrenPerNode: limits.maxChildrenPerNode,
				maxActive: limits.maxActive,
				...(limits.maxSpawnsPerSession !== undefined
					? { maxSpawnsPerSession: limits.maxSpawnsPerSession }
					: {}),
			},
		};
	}

	/**
	 * Would `name` be refused right now? Pure read: never throws, never mutates
	 * state, never registers a child (I-O1).
	 *
	 * I-O1: the answer is **advisory**. Passing does not authorise a spawn —
	 * `assertWithinLimits` stays the authority, and a caller that treats this as
	 * permission will over-admit in the same-tick fanout (R1).
	 */
	preflightAdmission(name: string): AdmissionVerdict {
		return evaluateInProcessAdmission(this.admissionCounts(name));
	}

	/**
	 * A19: fire `onSlotReleased` at most once per child, and only for the two
	 * states that actually free a slot (F9).
	 */
	private emitSlotReleased(
		child: ChildRecord,
		state: "retired" | "exited",
	): void {
		if (child.slotReleased) return;
		child.slotReleased = true;
		this.onSlotReleased?.({ name: child.name, parentKey: child.parentKey, state });
	}

	private dispatch(
		child: ChildRecord,
		kind: "prompt" | "steer" | "followUp",
		text: string,
	): Promise<void> {
		// Every turn is dispatched inside the child's identity scope AND at the
		// child's recorded absolute nesting depth. The Orchestrator drives turn 2+
		// from the root chain, where `inProcessDepth()` is 0; without pinning the
		// recorded depth here a grandchild would look like a first-generation
		// child and `maxDepth` would never fire (REV2-1).
		return runAtAbsoluteDepth(child.spawnDepth, () =>
			runInChildContext(child.context, () =>
				this.dispatchInContext(child, kind, text),
			),
		);
	}

	private async dispatchInContext(
		child: ChildRecord,
		kind: "prompt" | "steer" | "followUp",
		text: string,
	): Promise<void> {
		this.assertCanSend(child);
		const session = child.session!;
		const wasActive = child.turnActive;
		if (!wasActive) this.beginTurn(child);
		try {
			if (kind === "followUp" && wasActive && session.followUp) {
				await session.followUp(text);
			} else if ((kind === "steer" || kind === "prompt") && wasActive && session.steer) {
				await session.steer(text);
			} else {
				await session.prompt(text);
			}
		} catch (error) {
			if (!wasActive && child.turnActive) {
				child.turnActive = false;
				child.state = "idle";
				child.lastTurnResult = {
					settled: false,
					abnormal: false,
					reason: "session command was rejected",
				};
				this.resolveWaiters(child, child.lastTurnResult);
			}
			throw error;
		}
	}

	private beginTurn(child: ChildRecord): void {
		// "clear first, set later" (R2): a stale result from a previous turn must
		// never satisfy the `waitSettled` fast path for the new one.
		child.lastTurnResult = undefined;
		child.exitResult = undefined;
		child.pendingFailure = undefined;
		child.turnActive = true;
		child.state = "running";
	}

	private async rollbackSpawn(child: ChildRecord): Promise<void> {
		child.state = "retiring";
		child.alive = false;
		child.turnActive = false;
		child.subscriptions.clear();
		child.unsubscribeSession?.();
		child.unsubscribeSession = undefined;
		this.uiProxy.forgetChild(child.name);
		this.resolveWaiters(child, {
			settled: false,
			abnormal: true,
			reason: "child spawn failed",
		});
		try {
			child.session?.dispose();
		} catch {
			/* preserve launch error */
		} finally {
			child.session = null;
			child.state = "exited";
			if (this.children.get(child.name) === child) {
				this.children.delete(child.name);
			}
			// A19 release point 2/3: a failed spawn frees its slot immediately.
			this.emitSlotReleased(child, "exited");
		}
	}

	private assertCanSend(child: ChildRecord): void {
		if (!this.isAlive(child.name) || child.retireRequested || !child.session) {
			throw new SubagentError(
				`child is not available: ${child.name}`,
				ErrorCodes.NOT_FOUND,
			);
		}
	}

	private requireChild(name: string): ChildRecord {
		const child = this.children.get(name);
		if (!child) {
			throw unknownChildError(name);
		}
		return child;
	}

	private handleSessionEvent(child: ChildRecord, event: unknown): void {
		const record = recordOf(event);
		if (!record || typeof record.type !== "string") return;
		this.updateTurnState(child, record);
		this.publishEvent(child, record);
	}

	private updateTurnState(child: ChildRecord, event: Record<string, unknown>): void {
		if (event.type === "agent_start" || event.type === "turn_start") {
			child.turnActive = true;
			if (event.type === "agent_start") child.abortedPending = false;
			if (child.state !== "retiring") child.state = "running";
			return;
		}
		if (event.type === "turn_end" || event.type === "agent_end") {
			child.abortedPending = this.eventContainsAbort(event, child.abortedPending);
			return;
		}
		if (event.type === "error") {
			// #227 D3: `error` used to fall through to the bottom `return` and be
			// dropped entirely (F8), so a failed child looked identical to a clean
			// one once `agent_settled` landed. Remember it and let the settle below
			// turn it into a visible fact. Deliberately NOT read from ALS: an
			// `error` can arrive on the drain chain, outside this child's scope.
			child.pendingFailure = failureMessage(event);
			return;
		}
		if (event.type !== "agent_settled") return;
		const result: SettleResult = {
			settled: true,
			abnormal: false,
			aborted: child.abortedPending,
		};
		// Only surface `reason` when there is a recorded failure: adding it
		// unconditionally would change the shape every clean settle returns, and
		// `aborted` stays the sole stop-reason signal (no invented stopReason).
		if (!result.aborted && child.pendingFailure) {
			result.reason = child.pendingFailure;
		}
		child.pendingFailure = undefined;
		child.abortedPending = false;
		child.turnActive = false;
		child.lastTurnResult = result;
		if (child.state !== "retiring") child.state = "idle";
		this.resolveWaiters(child, result);
	}

	private eventContainsAbort(
		event: Record<string, unknown>,
		previous: boolean,
	): boolean {
		const message = recordOf(event.message);
		if (message?.stopReason === "aborted") return true;
		const messages = Array.isArray(event.messages) ? event.messages : [];
		return (
			previous ||
			messages.some((item) => recordOf(item)?.stopReason === "aborted")
		);
	}

	private publishEvent(child: ChildRecord, record: Record<string, unknown>): void {
		// Sessions emit synchronously from inside the child's await chain, so a
		// parent-side listener would otherwise run with the child's ALS identity
		// (currentChildContext() would report the child). Host callbacks run at
		// root identity (REV2-7).
		runOutsideChildContext(() => this.publishEventAtRoot(child, record));
	}

	private publishEventAtRoot(
		child: ChildRecord,
		record: Record<string, unknown>,
	): void {
		const type = record.type;
		if (typeof type !== "string") return;
		if (type === "message_update") {
			const assistantEvent = recordOf(record.assistantMessageEvent);
			if (!assistantEvent || typeof assistantEvent.type !== "string") return;
			const updateType = assistantEvent.type;
			const isTextDelta = updateType === "text_delta";
			const toolName =
				typeof assistantEvent.toolName === "string"
					? assistantEvent.toolName
					: undefined;
			if (!isTextDelta && !toolName) return;
			const coarse: SupervisorEvent = {
				name: child.name,
				type,
				updateType,
				...(toolName ? { toolName } : {}),
			};
			const detailed: SupervisorEvent = {
				name: child.name,
				type,
				updateType,
				...(isTextDelta && typeof assistantEvent.delta === "string"
					? { delta: assistantEvent.delta }
					: {}),
				...(toolName ? { toolName } : {}),
			};
			for (const subscription of [...child.subscriptions]) {
				if (isTextDelta && !subscription.includeTextDelta) continue;
				this.notify(subscription, isTextDelta ? detailed : coarse);
			}
			return;
		}
		if (!COARSE_EVENT_TYPES.has(type)) return;
		const event: SupervisorEvent = { name: child.name, type };
		for (const key of ["toolName", "toolCallId", "aborted", "willRetry", "reason"]) {
			if (record[key] !== undefined) event[key] = record[key];
		}
		for (const subscription of [...child.subscriptions]) {
			this.notify(subscription, event);
		}
	}

	private notify(subscription: EventSubscription, event: SupervisorEvent): void {
		try {
			subscription.listener(event);
		} catch {
			/* UI callback must not break lifecycle */
		}
	}

	private resolveWaiters(child: ChildRecord, result: SettleResult): void {
		const waiters = [...child.waiters];
		child.waiters.clear();
		for (const waiter of waiters) {
			waiter.cleanup?.();
			waiter.resolve(result);
		}
	}

	private async retireChild(child: ChildRecord, _graceful: boolean): Promise<void> {
		if (child.state === "retired" || child.state === "exited") return;
		child.retireRequested = true;
		child.state = "retiring";
		child.alive = false;
		child.turnActive = false;
		child.unsubscribeSession?.();
		child.unsubscribeSession = undefined;
		this.uiProxy.forgetChild(child.name);
		const result: SettleResult = {
			settled: false,
			abnormal: false,
			reason: "child retired",
		};
		child.exitResult = result;
		child.lastTurnResult = result;
		this.resolveWaiters(child, result);
		try {
			child.session?.dispose();
		} catch {
			/* dispose best-effort */
		} finally {
			child.session = null;
			child.state = "retired";
			// A19 release point 1/3: retiring is the ordinary way a slot comes free.
			this.emitSlotReleased(child, "retired");
		}
	}

	private disposeRecord(child: ChildRecord): void {
		child.unsubscribeSession?.();
		try {
			child.session?.dispose();
		} catch {
			/* ignore */
		}
		this.children.delete(child.name);
		// A19 release point 3/3: a record that is discarded while it is ALREADY
		// retired/exited frees the same slot its own release point covered — the
		// `slotReleased` flag makes that a no-op. A record discarded in any other
		// state never freed a slot, so it must not emit one here either.
		if (child.state === "retired" || child.state === "exited") {
			this.emitSlotReleased(child, child.state);
		}
	}
}

