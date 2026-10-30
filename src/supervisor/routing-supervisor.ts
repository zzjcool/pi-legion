/**
 * Thin LegionSupervisor facade that routes by AgentConfig.spawnMode (#197).
 *
 * rpc → RpcSupervisor (unchanged internals)
 * inprocess → InProcessSupervisor
 *
 * Same name must not be registered on both backends.
 */

import {
	ErrorCodes,
	unknownChildError,
	SubagentError,
	type InProcessLimits,
} from "../shared/types.ts";
import { InProcessSupervisor, type InProcessSlotEvent } from "./inprocess-supervisor.ts";
import { RpcSupervisor } from "./rpc-supervisor.ts";
import { resolveSpawnMode } from "./spawn-mode.ts";
import { ensureHostExtensions } from "../runs/extension-inheritance.ts";
import type { UIProxy } from "./ui-proxy.ts";
import type {
	ChildHandle,
	EventSubscriptionOptions,
	LegionSupervisor,
	SettleResult,
	SpawnInput,
	SteerDisposition,
	SupervisorEventListener,
	UsageSnapshot,
} from "./types.ts";

export type SupervisorBackend = "rpc" | "inprocess";

export interface RoutingSupervisorOptions {
	rpc?: RpcSupervisor;
	inprocess?: InProcessSupervisor;
	/** Shared UI proxy preferred; otherwise each backend keeps its own. */
	uiProxy?: UIProxy;
	getInprocessLimits?: () => InProcessLimits | undefined;
	onSpawnRefused?: (message: string) => void;
	/**
	 * D2 (issue #266): forwarded to the in-process backend only. A slot is freed
	 * exclusively by `retired`/`exited` (an `idle` child still holds one), and the
	 * Orchestrator uses the edge to wake its launch-queue pump (D2-d-2).
	 */
	onSlotReleased?: (event: InProcessSlotEvent) => void;
}

/**
 * Process-local broadcast of slot releases (D2-d-2).
 *
 * The queue lives in the Orchestrator (single choke point, D2), but the
 * Orchestrator does not necessarily own the supervisor: `index.ts` constructs
 * one `RoutingSupervisor` per extension load and hands it to five
 * `new Orchestrator` sites. `OrchestratorDeps` has no supervisor-ownership
 * guarantee, and the supervisor may also be a test double. So the hook is a
 * fan-out: whichever supervisor instance is wired with `onSlotReleased`
 * broadcasts here, and every live Orchestrator subscribes.
 *
 * Listeners are kept in a `Set` and are best-effort — a throwing listener must
 * never break a retire (it only delays an admission until the fallback timer).
 */
const slotReleaseListeners = new Set<() => void>();

/** Publish a slot-release edge to every subscribed Orchestrator. */
export function notifyInProcessSlotReleased(): void {
	for (const listener of [...slotReleaseListeners]) {
		try {
			listener();
		} catch {
			/* a listener must never break the retire that triggered it */
		}
	}
}

/** Subscribe to slot-release edges; returns the unsubscribe function. */
export function subscribeInProcessSlotReleases(listener: () => void): () => void {
	slotReleaseListeners.add(listener);
	return () => {
		slotReleaseListeners.delete(listener);
	};
}

/**
 * Chain a caller-supplied hook behind the process-wide broadcast.
 *
 * A throwing subscriber must not swallow the caller's hook (and vice versa):
 * `notifyInProcessSlotReleased` already isolates its own listeners, and the
 * caller's hook runs afterwards inside the supervisor's `emitSlotReleased`.
 */
function chainSlotRelease(hook: ((event: InProcessSlotEvent) => void) | undefined) {
	return (event: InProcessSlotEvent): void => {
		notifyInProcessSlotReleased();
		hook?.(event);
	};
}

/**
 * Routes LegionSupervisor calls to RpcSupervisor or InProcessSupervisor
 * based on the resolved spawnMode of the target agent / registered child.
 */
export class RoutingSupervisor implements LegionSupervisor {
	readonly rpc: RpcSupervisor;
	readonly inprocess: InProcessSupervisor;
	private readonly owners = new Map<string, SupervisorBackend>();
	readonly uiProxy: UIProxy;

	constructor(options: RoutingSupervisorOptions = {}) {
		const onSpawnRefused = options.onSpawnRefused;
		this.rpc =
			options.rpc ??
			new RpcSupervisor({
				...(options.uiProxy ? { uiProxy: options.uiProxy } : {}),
				...(onSpawnRefused ? { onSpawnRefused } : {}),
			});
		this.inprocess =
			options.inprocess ??
			new InProcessSupervisor({
				...(options.uiProxy ? { uiProxy: options.uiProxy } : {}),
				...(options.getInprocessLimits
					? { getLimits: options.getInprocessLimits }
					: {}),
				...(onSpawnRefused ? { onSpawnRefused } : {}),
				// D2-d-2: an in-process slot release wakes every launch-queue pump.
				onSlotReleased: chainSlotRelease(options.onSlotReleased),
			});
		this.uiProxy = options.uiProxy ?? this.rpc.uiProxy;
	}

	async spawnChild(input: SpawnInput): Promise<ChildHandle> {
		const mode = resolveSpawnMode(input.agent);
		// #280: warm host-extension discovery before anything is spawned.
		//
		// This is the one place that sees BOTH backends and sits on an await chain
		// already, so every spawn path is covered — the tool execute frame, the
		// postman timer, the team-restore microtask and the launch-queue pump all
		// funnel through `Orchestrator.launch` → here. It deliberately does NOT live
		// in `launch()`: that fast path must not gain an await before the
		// synchronous admission block (launch-admission-queue-v1 §13.7 ban 5).
		//
		// `ensureHostExtensions` is idempotent and never rejects, so a warm cache is
		// a map lookup and a failed `pi list` leaves the child with the explicit
		// list plus the guard instead of failing the launch.
		await ensureHostExtensions();
		if (mode === "inprocess") {
			if (input.agent.kind !== "pi") {
				throw new SubagentError(
					`spawnMode "inprocess" requires kind "pi" (received '${input.agent.kind}')`,
					ErrorCodes.INVALID_PARAMS,
				);
			}
			if (input.agent.worktree === true) {
				throw new SubagentError(
					`spawnMode "inprocess" cannot combine with worktree: true for '${input.name}'; set worktree: false`,
					ErrorCodes.INVALID_PARAMS,
				);
			}
		}
		const existing = this.owners.get(input.name);
		if (existing && existing !== mode) {
			const alive =
				existing === "rpc"
					? this.rpc.isAlive(input.name)
					: this.inprocess.isAlive(input.name);
			if (alive) {
				throw new SubagentError(
					`child '${input.name}' is already registered on ${existing}; cannot spawn as ${mode}`,
					ErrorCodes.NAME_TAKEN,
				);
			}
		}
		const backend = mode === "inprocess" ? this.inprocess : this.rpc;
		const handle = await backend.spawnChild(input);
		this.owners.set(input.name, mode);
		return handle;
	}

	async prompt(name: string, text: string): Promise<void> {
		await this.backendFor(name).prompt(name, text);
	}

	/**
	 * Route the steer and hand the backend's disposition back untouched (#313):
	 * this facade must never flatten `Promise<SteerDisposition>` into
	 * `Promise<void>`, or the receipt upstream loses the queued/delivered fact.
	 */
	steer(name: string, text: string): Promise<SteerDisposition> {
		return this.backendFor(name).steer(name, text);
	}

	async followUp(name: string, text: string): Promise<void> {
		await this.backendFor(name).followUp(name, text);
	}

	async abort(name: string): Promise<void> {
		await this.backendFor(name).abort(name);
	}

	waitSettled(
		name: string,
		timeoutMs?: number,
		signal?: AbortSignal,
	): Promise<SettleResult> {
		return this.backendFor(name).waitSettled(name, timeoutMs, signal);
	}

	isAlive(name: string): boolean {
		const owner = this.owners.get(name);
		if (owner === "inprocess") return this.inprocess.isAlive(name);
		if (owner === "rpc") return this.rpc.isAlive(name);
		return this.rpc.isAlive(name) || this.inprocess.isAlive(name);
	}

	async stats(name: string): Promise<UsageSnapshot | null> {
		return this.backendFor(name).stats(name);
	}

	retire(name: string, opts?: { graceful?: boolean }): Promise<void> {
		return this.backendFor(name).retire(name, opts);
	}

	onEvent(
		name: string,
		listener: SupervisorEventListener,
		options: EventSubscriptionOptions = {},
	): () => void {
		const owner = this.owners.get(name);
		if (owner === "inprocess") {
			return this.inprocess.onEvent(name, listener, options);
		}
		if (owner === "rpc") {
			return this.rpc.onEvent(name, listener, options);
		}
		// Pre-spawn: subscribe on both so whichever backend wins still delivers.
		const offRpc = this.rpc.onEvent(name, listener, options);
		const offIn = this.inprocess.onEvent(name, listener, options);
		return () => {
			offRpc();
			offIn();
		};
	}

	private backendFor(name: string): LegionSupervisor {
		const owner = this.owners.get(name);
		if (owner === "inprocess") return this.inprocess;
		if (owner === "rpc") return this.rpc;
		if (this.inprocess.isAlive(name)) {
			this.owners.set(name, "inprocess");
			return this.inprocess;
		}
		if (this.rpc.isAlive(name)) {
			this.owners.set(name, "rpc");
			return this.rpc;
		}
		throw unknownChildError(name);
	}
}
