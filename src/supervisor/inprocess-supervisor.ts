/**
 * LegionSupervisor backed by in-process AgentSession (#197).
 *
 * Uses createAgentSession + `SessionManager.open(input.sessionFile, ...)` so the
 * child transcript lands on the file the Orchestrator pre-created (D7; an
 * in-memory manager would leave it empty), or an injectable factory in unit
 * tests. Production factory wires role tools / model / system prompt (#199).
 * Does NOT use RpcClient. Process-tree / SIG retire is skipped.
 */

import { formatChildTask } from "../extension/child-guard.ts";
import {
	applyThinkingSuffix,
	childInheritsExtensions,
	collectChildExtensions,
} from "../runs/args.ts";
import {
	ErrorCodes,
	isThinkingLevel,
	type InProcessLimits,
	SubagentError,
	DEFAULT_LEGION_SETTINGS,
} from "../shared/types.ts";
import {
	DEFAULT_INPROCESS_MAX_ACTIVE,
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

	const noExtensions = !childInheritsExtensions(input.agent);
	const additionalExtensionPaths = noExtensions
		? collectChildExtensions(input.agent)
		: [];

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
	onSpawnRefused?: (message: string) => void;
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
	/** Identity reused by every later dispatch into this child (tools inherit it). */
	context: ChildLaunchContext;
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
	};
}

function recordOf(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
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
	readonly uiProxy: UIProxy;
	private spawnCount = 0;

	constructor(options: InProcessSupervisorOptions = {}) {
		this.sessionFactory = options.sessionFactory ?? defaultSessionFactory;
		this.uiProxy = options.uiProxy ?? new InMemoryUIProxy();
		this.getLimits = options.getLimits
			?? (() => options.limits);
		this.onSpawnRefused = options.onSpawnRefused;
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
					this.beginTurn(registration);
					await session.prompt(
						formatChildTask(input.task, {
							allowNested: input.allowNestedSubagents === true,
							...(input.worktreeBranch
								? { worktreeBranch: input.worktreeBranch }
								: {}),
						}),
					);
					if (!this.isAlive(input.name)) {
						throw new SubagentError(
							`in-process session ended after its first prompt: ${input.name}`,
							ErrorCodes.START_FAILED,
						);
					}
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
		const limits = this.limits();
		const active = [...this.children.values()].filter(
			(c) => c.state !== "exited" && c.state !== "retired",
		);
		if (limits.maxSpawnsPerSession !== undefined && this.spawnCount >= limits.maxSpawnsPerSession) {
			const message =
				`inprocess spawn budget exhausted (${this.spawnCount}/${limits.maxSpawnsPerSession}); ` +
				`raise subagents.inprocess.maxSpawnsPerSession to allow more`;
			this.onSpawnRefused?.(message);
			throw new SubagentError(message, ErrorCodes.BUDGET_EXCEEDED);
		}
		if (limits.maxActive !== undefined && active.length >= limits.maxActive) {
			const message =
				`inprocess maxActive reached (${active.length}/${limits.maxActive}); ` +
				`raise subagents.inprocess.maxActive to allow more`;
			this.onSpawnRefused?.(message);
			throw new SubagentError(message, ErrorCodes.BUDGET_EXCEEDED);
		}
		const nextDepth = inProcessDepth() + 1;
		if (limits.maxDepth !== undefined && nextDepth > limits.maxDepth) {
			const message =
				`inprocess nesting limit reached (depth ${inProcessDepth()}, max ${limits.maxDepth}); ` +
				`raise subagents.inprocess.maxDepth to allow deeper nesting`;
			this.onSpawnRefused?.(message);
			throw new SubagentError(message, ErrorCodes.BUDGET_EXCEEDED);
		}
		if (limits.maxChildrenPerNode !== undefined) {
			const parent = parentKeyOf(name);
			const siblings = active.filter((c) => c.parentKey === parent).length;
			if (siblings >= limits.maxChildrenPerNode) {
				const message =
					`inprocess maxChildrenPerNode reached for '${parent || "<root>"}' ` +
					`(${siblings}/${limits.maxChildrenPerNode})`;
				this.onSpawnRefused?.(message);
				throw new SubagentError(message, ErrorCodes.BUDGET_EXCEEDED);
			}
		}
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
		child.lastTurnResult = undefined;
		child.exitResult = undefined;
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
			throw new SubagentError(`unknown child: ${name}`, ErrorCodes.NOT_FOUND);
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
		if (event.type !== "agent_settled") return;
		const result: SettleResult = {
			settled: true,
			abnormal: false,
			aborted: child.abortedPending,
		};
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
	}
}

