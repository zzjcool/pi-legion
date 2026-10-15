/**
 * LegionSupervisor backed by one headless Pi RpcClient per child node.
 *
 * This module owns process registration, RPC event routing and graceful child
 * retirement; it deliberately does not orchestrate runs or depend on herdr.
 */

import { RpcClient } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { formatChildTask } from "../extension/child-guard.ts";
import { buildPiArgs, LEGION_IDENTITY_ENV_KEYS } from "../runs/args.ts";
import { TEMP_OWNER_FILE, writeOwnerFile } from "../runs/owner.ts";
import { checkMemoryGate, childMemoryEnv } from "./child-memory.ts";
import { enrichFailureWithAutoDoctor } from "../extension/auto-doctor.ts";
import { ErrorCodes, SubagentError } from "../shared/types.ts";
import {
	InMemoryUIProxy,
	extensionActivityToUIRequest,
	isExtensionActivity,
	isExtensionUIRequest,
	type ExtensionUIResponse,
	type UIProxy,
} from "./ui-proxy.ts";
import {
	type ChildHandle,
	type DescendantInfo,
	type EventSubscriptionOptions,
	type LegionSupervisor,
	type RpcClientFactory,
	type RpcClientLike,
	type RpcClientOptions,
	type RpcProcessHandle,
	type RpcSupervisorOptions,
	type SettleResult,
	type SpawnInput,
	type SupervisorEvent,
	type SupervisorEventListener,
	type UsageSnapshot,
} from "./types.ts";
import { currentPgid, enumerateDescendants } from "./proc-tree.ts";

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
	client: RpcClientLike | null;
	process: RpcProcessHandle | null;
	tempDir: string;
	/** Argv passed to the child pi (for doctor / spawn hints). */
	lastArgs?: string[];
	/** Spawn cwd (for auto-doctor storeRoot). */
	cwd?: string;
	state: ChildState;
	processAlive: boolean;
	turnActive: boolean;
	retireRequested: boolean;
	lastTurnResult?: SettleResult;
	exitResult?: SettleResult;
	waiters: Set<SettleWaiter>;
	subscriptions: Set<EventSubscription>;
	unsubscribeRpcEvents?: () => void;
	retirePromise?: Promise<void>;
	abortedPending: boolean;
}

export type { RpcSupervisorOptions } from "./types.ts";

const DEFAULT_RETIRE_TIMEOUT_MS = 5_000;
const DEFAULT_SIGNAL_TIMEOUT_MS = 1_000;
const DEFAULT_KILL_TIMEOUT_MS = 1_000;
const COARSE_EVENT_TYPES = new Set([
	"agent_start",
	"agent_end",
	"agent_settled",
	"turn_start",
	"turn_end",
	"tool_execution_start",
	"tool_execution_end",
]);

/**
 * Resolve the Pi CLI that children should run.
 *
 * Children MUST speak the same RPC protocol dialect as the RpcClient we
 * import (the host pi process's own copy). Resolving through
 * import.meta.resolve would pick this repo's devDependency (0.85.x), whose
 * prompt responses lack the `data.disposition` field the 1.1.x client
 * reads — producing "Cannot read properties of undefined (reading
 * 'disposition')" on every launch in real deployments. The live tests
 * missed this because, inside this repo, client and child were both 0.85.x
 * (self-consistent). Prefer, in order:
 *   1. an explicit PI_SUBAGENT_CLI env override;
 *   2. the host pi executable actually running this process
 *      (process.execPath is node, so resolve via argv[1]);
 *   3. fall back to import.meta.resolve for bare test harnesses.
 */
export function defaultPiCliPath(): string {
	const override = process.env.PI_SUBAGENT_CLI;
	if (override) return path.resolve(override);

	const hostEntry = process.argv[1];
	if (hostEntry && path.isAbsolute(hostEntry)) {
		let real = hostEntry;
		try {
			real = fs.realpathSync(hostEntry);
		} catch {
			// Non-existent or unreadable entry (test harnesses): use as-is.
		}
		// argv[1] may be the mise pi launcher (a shell-ish node script that
		// requires cli-runtime.js) or dist/cli.js itself; both live inside a
		// pi-coding-agent install. Walk up to the package root and use its
		// dist/cli.js so the child speaks the same dialect as the host client.
		const marker = path.join("node_modules", "@earendil-works", "pi-coding-agent");
		const idx = real.lastIndexOf(marker);
		if (idx !== -1) {
			return path.join(real.slice(0, idx + marker.length), "dist", "cli.js");
		}
		// argv[1] inside the package but not under node_modules (e.g. a linked
		// install): use it directly when it looks like the cli entry.
		if (real.endsWith("cli.js") || real.endsWith("cli-runtime.js")) {
			return real.endsWith("cli-runtime.js")
				? path.join(path.dirname(real), "cli.js")
				: real;
		}
	}

	const packageEntry = fileURLToPath(
		import.meta.resolve("@earendil-works/pi-coding-agent"),
	);
	return path.resolve(path.dirname(packageEntry), "bundle", "cli.js");
}

function defaultClientFactory(options: RpcClientOptions): RpcClientLike {
	// RpcClient's public API intentionally hides its ChildProcess. The frozen M1
	// contract also requires stdin-close shutdown and extension_ui_response; the
	// pinned implementation stores its ChildProcess in this TS-private field.
	// SAFETY: this adapter only uses the SDK's documented methods plus the
	// pinned runtime's `process` property (a TS-private, non-# field) to close
	// stdin, observe exit, and write UI responses. RpcClient's declarations
	// confirm every method in RpcClientLike; the process is checked for null.
	// Node spawn treats undefined env values as explicit removals. The SDK type
	// omits that Node behavior, so the cast stays at this adapter boundary.
	return new RpcClient(options as unknown as ConstructorParameters<typeof RpcClient>[0]) as unknown as RpcClientLike;
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
	if (!value || typeof value !== "object") return undefined;
	// SAFETY: the object check makes property reads safe; callers validate every
	// value they consume instead of trusting this broad record view.
	return value as Record<string, unknown>;
}

function processHasExited(child: RpcProcessHandle): boolean {
	return (
		typeof child.exitCode === "number" ||
		(child.signalCode !== null && child.signalCode !== undefined)
	);
}

function defaultSignalProcess(target: number, signal: NodeJS.Signals): boolean {
	try {
		process.kill(target, signal);
		return true;
	} catch {
		return false;
	}
}

function normalizedNumber(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function usageSnapshot(value: unknown): UsageSnapshot | null {
	const stats = recordOf(value);
	const tokens = recordOf(stats?.tokens);
	if (!stats || !tokens) return null;
	return {
		tokensIn: normalizedNumber(tokens.input),
		tokensOut: normalizedNumber(tokens.output),
		costUsd: normalizedNumber(stats.cost),
	};
}

/**
 * Host-side process adapter for the frozen §3.1 LegionSupervisor contract.
 * Registry entries are isolated by name and own their event listeners/tempfiles.
 */
export class RpcSupervisor implements LegionSupervisor {
	private readonly children = new Map<string, ChildRecord>();
	private readonly subscriptionsBeforeSpawn = new Map<
		string,
		Set<EventSubscription>
	>();
	private readonly clientFactory: RpcClientFactory;
	private readonly retireTimeoutMs: number;
	private readonly signalTimeoutMs: number;
	private readonly killTimeoutMs: number;
	private readonly enumerateDescendants: (rootPid: number) => DescendantInfo[];
	private readonly signalProcess: (target: number, signal: NodeJS.Signals) => boolean;
	private readonly onSpawnRefused?: (message: string) => void;
	private readonly memoryAvailable?: () => number;
	readonly uiProxy: UIProxy;

	constructor(options: RpcSupervisorOptions = {}) {
		this.clientFactory = options.clientFactory ?? defaultClientFactory;
		this.uiProxy = options.uiProxy ?? new InMemoryUIProxy();
		this.retireTimeoutMs = options.retireTimeoutMs ?? DEFAULT_RETIRE_TIMEOUT_MS;
		this.signalTimeoutMs = options.signalTimeoutMs ?? DEFAULT_SIGNAL_TIMEOUT_MS;
		this.killTimeoutMs = options.killTimeoutMs ?? DEFAULT_KILL_TIMEOUT_MS;
		this.enumerateDescendants = options.enumerateDescendants ?? enumerateDescendants;
		this.signalProcess = options.signalProcess ?? defaultSignalProcess;
		this.onSpawnRefused = options.onSpawnRefused;
		this.memoryAvailable = options.memoryAvailable;
	}

	async spawnChild(input: SpawnInput): Promise<ChildHandle> {
		// Memory gate (program level): refuse before any process/temp dir exists.
		const inFlight = [...this.children.values()].filter((child) => child.state === "starting").length;
		const gate = checkMemoryGate({ name: input.name, inFlight, ...(this.memoryAvailable ? { available: this.memoryAvailable } : {}) });
		if (!gate.ok) {
			const enriched = enrichFailureWithAutoDoctor(gate.message!, {
				name: input.name,
				code: ErrorCodes.INSUFFICIENT_MEMORY,
				cwd: input.cwd,
			});
			this.onSpawnRefused?.(enriched);
			throw new SubagentError(enriched, ErrorCodes.INSUFFICIENT_MEMORY);
		}
		if (input.agent.kind !== "pi") {
			throw new SubagentError(
				`RpcSupervisor only supports pi children (received kind '${input.agent.kind}'); ` +
					"migrate the role to kind: pi or pin pi-legion v0.16.x",
				ErrorCodes.INVALID_PARAMS,
			);
		}
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
			client: null,
			process: null,
			tempDir: "",
			cwd: input.cwd,
			state: "starting",
			processAlive: false,
			turnActive: false,
			retireRequested: false,
			abortedPending: false,
			waiters: new Set(),
			subscriptions:
				this.subscriptionsBeforeSpawn.get(input.name) ?? new Set(),
		};
		this.subscriptionsBeforeSpawn.delete(input.name);
		this.children.set(input.name, registration);

		let tempDir = "";
		try {
			const parentTempDir = path.resolve(input.tempDir);
			fs.mkdirSync(parentTempDir, { recursive: true });
			tempDir = fs.mkdtempSync(path.join(parentTempDir, "rpc-child-"));
			// Owner marker for the startup sweep (#38): a hard-killed parent
			// leaves this dir behind; a later session deletes it once this pid is gone.
			writeOwnerFile(path.join(tempDir, TEMP_OWNER_FILE));
		} catch (error) {
			await this.rollbackSpawn(registration);
			throw error;
		}
		registration.tempDir = tempDir;
		let builtArgs: string[];
		try {
			const {
				name: _name,
				cwd: _cwd,
				env: _env,
				cliPath: _cliPath,
				tempDir: _tempDir,
				stripLegionIdentity: _stripLegionIdentity,
				...buildInput
			} = input;
			const built = buildPiArgs({
				...buildInput,
				tempDir,
				// RPC mode rejects positional @file prompt arguments. The task is
				// delivered as the initial RPC prompt just after process startup.
				includeTask: false,
			});
			builtArgs = built.args;
			registration.lastArgs = builtArgs;
		} catch (error) {
			await this.rollbackSpawn(registration);
			throw error;
		}

		let client: RpcClientLike;
		try {
			const env: Record<string, string | undefined> = {
				// These are identity/permission markers, not ambient settings. A child
				// only gets the roles its target's lineageEnv explicitly supplies.
				PI_SUBAGENT_UTILITY_CHILD: undefined,
				PI_SUBAGENT_ALLOW_NESTED: undefined,
				// Memory-saving V8 flags; the child restores the host NODE_OPTIONS
				// at extension load so its tool subprocesses never inherit them.
				...childMemoryEnv(),
				...(input.env ?? {}),
			};
			if (input.stripLegionIdentity) {
				for (const key of LEGION_IDENTITY_ENV_KEYS) env[key] = undefined;
			}
			const options: RpcClientOptions = {
				cliPath: input.cliPath
					? path.resolve(input.cliPath)
					: defaultPiCliPath(),
				cwd: input.cwd,
				args: builtArgs,
				env: env as Record<string, string>,
			};
			client = this.clientFactory(options);
			registration.client = client;
			registration.processAlive = true;
			registration.unsubscribeRpcEvents = client.onEvent((event) =>
				this.handleRpcEvent(registration, event),
			);
			await client.start();
			this.attachProcess(registration);
			if (!this.isAlive(input.name)) {
				throw this.startFailure(registration, "Pi RPC process exited during startup");
			}
			registration.state = "idle";
			this.beginTurn(registration);
			await client.prompt(
				formatChildTask(input.task, {
					allowNested: input.allowNestedSubagents === true,
					...(input.worktreeBranch
						? { worktreeBranch: input.worktreeBranch }
						: {}),
				}),
			);
			if (!this.isAlive(input.name)) {
				throw this.startFailure(registration, "Pi RPC process exited after its first prompt");
			}

			return {
				name: registration.name,
				sessionFile: registration.sessionFile,
				...(registration.process?.pid ? { pid: registration.process.pid } : {}),
			};
		} catch (error) {
			await this.rollbackSpawn(registration);
			throw error;
		}
	}

	/** Send a fresh prompt when idle; steer the current run when already active. */
	async prompt(name: string, text: string): Promise<void> {
		const child = this.requireChild(name);
		await this.dispatch(child, "prompt", text);
	}

	/** Use the RPC steer command while running; idle children start a prompt. */
	async steer(name: string, text: string): Promise<void> {
		const child = this.requireChild(name);
		await this.dispatch(child, "steer", text);
	}

	/** Queue a follow-up behind a running turn; idle children start a prompt. */
	async followUp(name: string, text: string): Promise<void> {
		const child = this.requireChild(name);
		await this.dispatch(child, "followUp", text);
	}

	async abort(name: string): Promise<void> {
		const child = this.requireChild(name);
		this.assertCanSend(child);
		if (!child.turnActive) return;
		await this.requireClient(child).abort();
	}

	waitSettled(name: string, timeoutMs = 900_000, signal?: AbortSignal): Promise<SettleResult> {
		const child = this.requireChild(name);
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
					reason: child.retireRequested ? "child retired" : "child process exited",
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
			if (timeoutMs > 0) {
				waiter.timer = setTimeout(() => {
					child.waiters.delete(waiter);
					waiter.cleanup?.();
					resolve({ settled: false, abnormal: false, reason: "timeout" });
				}, timeoutMs);
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
		if (!child || !child.processAlive) return false;
		if (child.process && processHasExited(child.process)) return false;
		return child.state !== "retired" && child.state !== "exited";
	}

	async stats(name: string): Promise<UsageSnapshot | null> {
		const child = this.children.get(name);
		if (!child || !child.client || !this.isAlive(name)) return null;
		try {
			return usageSnapshot(await child.client.getSessionStats());
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

	/** Subscribe to coarse events; set includeTextDelta only for a live overlay. */
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

	private async dispatch(
		child: ChildRecord,
		kind: "prompt" | "steer" | "followUp",
		text: string,
	): Promise<void> {
		this.assertCanSend(child);
		const client = this.requireClient(child);
		const wasActive = child.turnActive;
		if (!wasActive) this.beginTurn(child);

		try {
			if (kind === "followUp" && wasActive) {
				await client.followUp(text);
			} else if ((kind === "steer" || kind === "prompt") && wasActive) {
				// A prompt addressed to a busy child is an immediate correction;
				// use the explicit RPC steer command, never a second prompt command.
				await client.steer(text);
			} else {
				await client.prompt(text);
			}
		} catch (error) {
			if (!wasActive && child.turnActive) {
				child.turnActive = false;
				child.state = "idle";
				child.lastTurnResult = {
					settled: false,
					abnormal: false,
					reason: "RPC command was rejected",
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
		child.processAlive = false;
		child.turnActive = false;
		child.subscriptions.clear();
		child.unsubscribeRpcEvents?.();
		child.unsubscribeRpcEvents = undefined;
		this.uiProxy.forgetChild(child.name);
		this.resolveWaiters(child, {
			settled: false,
			abnormal: true,
			reason: "child spawn failed",
		});
		if (child.tempDir) this.removeTempDir(child);
		const client = child.client;
		try {
			if (client) await client.stop();
		} catch {
			// Preserve the launch error; rollback must not strand its registry entry.
		} finally {
			child.client = null;
			child.state = "exited";
			if (this.children.get(child.name) === child) {
				this.children.delete(child.name);
			}
		}
	}

	private assertCanSend(child: ChildRecord): void {
		if (!this.isAlive(child.name) || child.retireRequested || !child.client) {
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

	private attachProcess(child: ChildRecord): void {
		const process = this.requireClient(child).process ?? null;
		child.process = process;
		if (!process) return;

		process.once("exit", (code, signal) =>
			this.handleProcessExit(child, code, signal),
		);
		process.once("error", (error) => {
			this.handleProcessError(child, error);
		});
		if (processHasExited(process)) {
			this.handleProcessExit(child, process.exitCode, process.signalCode);
		}
	}

	private handleRpcEvent(child: ChildRecord, event: unknown): void {
		const record = recordOf(event);
		if (!record || typeof record.type !== "string") return;

		if (isExtensionUIRequest(event)) {
			this.uiProxy.enqueue({
				childName: child.name,
				request: event,
				respond: (response) => this.sendUIResponse(child, event.id, response),
			});
			return;
		}

		// Child-side setActivity / setProgramRecord → parent OSC busy fan-in (no PTY OSC parse).
		if (isExtensionActivity(event)) {
			this.uiProxy.enqueue({
				childName: child.name,
				request: extensionActivityToUIRequest(event),
			});
			return;
		}

		this.updateTurnState(child, record);

		this.publishEvent(child, record);
	}

	private updateTurnState(
		child: ChildRecord,
		event: Record<string, unknown>,
	): void {
		if (event.type === "agent_start" || event.type === "turn_start") {
			child.turnActive = true;
			if (event.type === "agent_start") child.abortedPending = false;
			if (child.state !== "retiring") child.state = "running";
			return;
		}
		if (event.type === "turn_end" || event.type === "agent_end") {
			child.abortedPending = this.eventContainsAbort(
				event,
				child.abortedPending,
			);
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
			previous || messages.some((item) => recordOf(item)?.stopReason === "aborted")
		);
	}

	private publishEvent(
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
				this.notify(
					subscription,
					isTextDelta ? detailed : coarse,
				);
			}
			return;
		}
		if (!COARSE_EVENT_TYPES.has(type)) return;

		// Keep payloads intentionally small: argument/text content is never
		// copied into the default status stream, but tool names remain visible.
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
			// A UI callback must not break process lifecycle or other subscribers.
		}
	}

	private sendUIResponse(
		child: ChildRecord,
		rpcRequestId: string,
		response: ExtensionUIResponse,
	): void {
		const stdin = child.process?.stdin;
		if (!stdin || stdin.destroyed || stdin.writableEnded) return;
		const record = {
			type: "extension_ui_response",
			id: rpcRequestId,
			...response,
		};
		try {
			stdin.write(`${JSON.stringify(record)}\n`);
		} catch {
			// The child may have exited between the UI action and this write.
		}
	}

	private resolveWaiters(child: ChildRecord, result: SettleResult): void {
		for (const waiter of [...child.waiters]) {
			child.waiters.delete(waiter);
			waiter.cleanup?.();
			waiter.resolve(result);
		}
	}

	private handleProcessExit(
		child: ChildRecord,
		code: number | null,
		signal: NodeJS.Signals | null,
	): void {
		if (!child.processAlive) return;
		child.processAlive = false;
		child.turnActive = false;
		child.state = child.retireRequested ? "retired" : "exited";
		const result: SettleResult = child.retireRequested
			? (child.lastTurnResult ?? {
					settled: false,
					abnormal: false,
					reason: "child retired before agent_settled",
					exitCode: code,
					signal,
				})
			: {
					settled: false,
					abnormal: true,
					reason: "Pi RPC process exited before agent_settled",
					exitCode: code,
					signal,
				};
		if (child.retireRequested) child.lastTurnResult = result;
		else child.exitResult = result;
		this.resolveWaiters(child, result);
		child.client = null;
		child.subscriptions.clear();
		child.unsubscribeRpcEvents?.();
		child.unsubscribeRpcEvents = undefined;
		this.uiProxy.forgetChild(child.name);
		this.removeTempDir(child);
	}

	private handleProcessError(child: ChildRecord, error: Error): void {
		if (!child.processAlive) return;
		child.processAlive = false;
		child.turnActive = false;
		child.state = child.retireRequested ? "retired" : "exited";
		const result: SettleResult = {
			settled: false,
			abnormal: !child.retireRequested,
			reason: `Pi RPC process error: ${error.message}`,
		};
		if (child.retireRequested) child.lastTurnResult = result;
		else child.exitResult = result;
		this.resolveWaiters(child, result);
		child.client = null;
		child.subscriptions.clear();
		child.unsubscribeRpcEvents?.();
		child.unsubscribeRpcEvents = undefined;
		this.uiProxy.forgetChild(child.name);
		this.removeTempDir(child);
	}

	private async retireChild(child: ChildRecord, graceful: boolean): Promise<void> {
		if (!this.isAlive(child.name)) {
			child.state = "retired";
			if (child.processAlive && child.process && processHasExited(child.process)) {
				const code = child.process.exitCode;
				const signal = child.process.signalCode;
				child.processAlive = false;
				child.turnActive = false;
				const result: SettleResult = {
					settled: false,
					abnormal: !child.retireRequested,
					...(child.retireRequested
						? { reason: "child retired before agent_settled" }
						: { reason: "Pi RPC process exited before agent_settled" }),
					exitCode: code,
					signal,
				};
				if (child.retireRequested) child.lastTurnResult = result;
				else child.exitResult = result;
				this.resolveWaiters(child, result);
			}
			child.client = null;
			child.subscriptions.clear();
			child.unsubscribeRpcEvents?.();
			child.unsubscribeRpcEvents = undefined;
			this.uiProxy.forgetChild(child.name);
			this.removeTempDir(child);
			return;
		}
		const childPid = child.process?.pid;
		const descendants = childPid === undefined
			? []
			: this.enumerateDescendants(childPid);
		child.retireRequested = true;
		child.state = "retiring";
		this.uiProxy.forgetChild(child.name);

		if (graceful && this.closeInput(child)) {
			await this.waitForExit(child, this.retireTimeoutMs);
		}
		if (this.isAlive(child.name)) {
			child.process?.kill("SIGTERM");
			if (!child.process) {
				try {
					await this.requireClient(child).stop();
					child.processAlive = false;
					child.turnActive = false;
					child.state = "retired";
					const result: SettleResult = child.lastTurnResult ?? {
						settled: false,
						abnormal: false,
						reason: "child retired before agent_settled",
					};
					child.lastTurnResult = result;
					this.resolveWaiters(child, result);
				} catch {
					// The child may already have exited; inspect state below.
				}
			}
			await this.waitForExit(child, this.signalTimeoutMs);
		}
		if (this.isAlive(child.name)) {
			child.process?.kill("SIGKILL");
			await this.waitForExit(child, this.killTimeoutMs);
		}
		await this.sweepDescendants(descendants);
		if (this.isAlive(child.name)) {
			throw new SubagentError(
				`timed out retiring Pi RPC child: ${child.name}`,
				ErrorCodes.RETIRE_FAILED,
			);
		}
		child.state = "retired";
		child.client = null;
		child.subscriptions.clear();
		child.unsubscribeRpcEvents?.();
		child.unsubscribeRpcEvents = undefined;
		this.removeTempDir(child);
	}

	private async sweepDescendants(descendants: DescendantInfo[]): Promise<void> {
		if (descendants.length === 0) return;

		const ownPgid = currentPgid();
		const pgids: number[] = [];
		const seenPgids = new Set<number>();
		for (const descendant of descendants) {
			const pgid = descendant.pgid;
			if (
				ownPgid === null ||
				!Number.isSafeInteger(pgid) ||
				pgid <= 0 ||
				pgid === ownPgid ||
				seenPgids.has(pgid)
			) {
				continue;
			}
			seenPgids.add(pgid);
			pgids.push(pgid);
		}

		const pids: number[] = [];
		const seenPids = new Set<number>();
		for (const descendant of descendants) {
			const pid = descendant.pid;
			if (!Number.isSafeInteger(pid) || pid <= 0 || seenPids.has(pid)) continue;
			seenPids.add(pid);
			pids.push(pid);
		}

		const signal = (target: number, signalName: NodeJS.Signals) => {
			try {
				this.signalProcess(target, signalName);
			} catch {
				// A stale or inaccessible descendant must not stop the sweep.
			}
		};
		for (const pgid of pgids) signal(-pgid, "SIGTERM");
		for (const pid of pids) signal(pid, "SIGTERM");

		await new Promise<void>((resolve) => {
			// NOT unref'd: this timer may be the only thing driving the
			// caller's await; unref'd it could let the event loop drain
			// (and node:test abort the test) before the timeout fires.
			setTimeout(resolve, this.signalTimeoutMs);
		});

		for (const pgid of pgids) signal(-pgid, "SIGKILL");
		for (const pid of pids) signal(pid, "SIGKILL");
	}

	private closeInput(child: ChildRecord): boolean {
		const stdin = child.process?.stdin;
		if (!stdin || stdin.destroyed || stdin.writableEnded) return false;
		try {
			stdin.end();
			return true;
		} catch {
			return false;
		}
	}

	private waitForExit(child: ChildRecord, timeoutMs: number): Promise<boolean> {
		if (!this.isAlive(child.name)) return Promise.resolve(true);
		const process = child.process;
		if (!process) return Promise.resolve(false);
		return new Promise((resolve) => {
			let done = false;
			const finish = (exited: boolean) => {
				if (done) return;
				done = true;
				clearTimeout(timer);
				process.off("exit", onExit);
				resolve(exited);
			};
			const onExit = () => finish(true);
			// NOT unref'd: retire awaits this timeout to escalate SIGTERM
			// to SIGKILL. An unref'd timer lets the event loop drain first,
			// so node:test cancels the wait and the signal is never sent.
			const timer = setTimeout(() => finish(false), timeoutMs);
			process.once("exit", onExit);
			if (processHasExited(process)) finish(true);
		});
	}

	private requireClient(child: ChildRecord): RpcClientLike {
		if (child.client) return child.client;
		throw new SubagentError(
			`child is not available: ${child.name}`,
			ErrorCodes.NOT_FOUND,
		);
	}

	private startFailure(child: ChildRecord, message: string): SubagentError {
		const stderr = child.client?.getStderr?.();
		const base = `${message}${stderr ? `: ${stderr.trim().slice(0, 500)}` : ""}`;
		return new SubagentError(
			enrichFailureWithAutoDoctor(base, {
				name: child.name,
				stderr,
				args: child.lastArgs,
				code: ErrorCodes.START_FAILED,
				cwd: child.cwd,
			}),
			ErrorCodes.START_FAILED,
		);
	}

	private disposeRecord(child: ChildRecord): void {
		child.unsubscribeRpcEvents?.();
		child.unsubscribeRpcEvents = undefined;
		this.uiProxy.forgetChild(child.name);
		this.resolveWaiters(child, {
			settled: false,
			abnormal: false,
			reason: "child record disposed",
		});
		this.removeTempDir(child);
		if (this.children.get(child.name) === child) this.children.delete(child.name);
	}

	private removeTempDir(child: ChildRecord): void {
		fs.rmSync(child.tempDir, { recursive: true, force: true });
	}
}
