/**
 * LegionSupervisor backed by in-process AgentSession (#197).
 *
 * Uses createAgentSession + SessionManager.inMemory (or an injectable factory
 * for unit tests). Does NOT use RpcClient. Process-tree / SIG retire is skipped.
 */

import { formatChildTask } from "../extension/child-guard.ts";
import {
	ErrorCodes,
	type InProcessLimits,
	SubagentError,
} from "../shared/types.ts";
import {
	DEFAULT_INPROCESS_MAX_ACTIVE,
} from "./spawn-mode.ts";
import {
	inProcessDepth,
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

/** Narrow session surface InProcessSupervisor needs from AgentSession. */
export interface InProcessSession {
	subscribe(listener: (event: unknown) => void): () => void;
	prompt(text: string): Promise<unknown>;
	steer?(text: string): Promise<unknown>;
	followUp?(text: string): Promise<unknown>;
	abort?(): Promise<unknown>;
	dispose(): void;
	getSessionStats?(): unknown;
}

export type InProcessSessionFactory = (input: {
	name: string;
	cwd: string;
	agent: SpawnInput["agent"];
	sessionFile: string;
}) => Promise<InProcessSession>;

export interface InProcessSupervisorOptions {
	uiProxy?: UIProxy;
	/** Injected in tests; production uses createAgentSession + SessionManager.inMemory. */
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

function recordOf(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

async function defaultSessionFactory(input: {
	name: string;
	cwd: string;
	agent: SpawnInput["agent"];
	sessionFile: string;
}): Promise<InProcessSession> {
	const { createAgentSession, SessionManager } = await import(
		"@earendil-works/pi-coding-agent"
	);
	const { session } = await createAgentSession({
		cwd: input.cwd,
		sessionManager: SessionManager.inMemory(),
	});
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

	private limits(): InProcessLimits {
		const configured = this.getLimits();
		// No inprocess block → no limits (unlimited).
		if (configured === undefined) return {};
		// Documented safe default when maxActive omitted from an explicit block.
		if (configured.maxActive === undefined) {
			return { maxActive: DEFAULT_INPROCESS_MAX_ACTIVE, ...configured };
		}
		return configured;
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
				`spawnMode "inprocess" cannot use worktree isolation for '${input.name}'; use spawnMode "rpc" or set worktree: false`,
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
		};
		this.subscriptionsBeforeSpawn.delete(input.name);
		this.children.set(input.name, registration);

		try {
			return await runAtInProcessChildDepthAsync(async () => {
				const session = await this.sessionFactory({
					name: input.name,
					cwd: input.cwd,
					agent: input.agent,
					sessionFile: input.sessionFile,
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
			});
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
		await child.session?.abort?.();
	}

	waitSettled(name: string, timeoutMs = 900_000, signal?: AbortSignal): Promise<SettleResult> {
		const child = this.requireChild(name);
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
			return {
				tokensIn: Number((raw as UsageSnapshot).tokensIn ?? 0),
				tokensOut: Number((raw as UsageSnapshot).tokensOut ?? 0),
				costUsd: Number(
					(raw as UsageSnapshot).costUsd ??
						(raw as { totalCost?: number }).totalCost ??
						0,
				),
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

	private async dispatch(
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

// Silence unused import if tree-shaken oddly — AsyncLocalStorage used via depth helper.
