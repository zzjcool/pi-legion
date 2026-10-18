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
	SubagentError,
	type InProcessLimits,
} from "../shared/types.ts";
import { InProcessSupervisor } from "./inprocess-supervisor.ts";
import { RpcSupervisor } from "./rpc-supervisor.ts";
import { resolveSpawnMode } from "./spawn-mode.ts";
import type { UIProxy } from "./ui-proxy.ts";
import type {
	ChildHandle,
	EventSubscriptionOptions,
	LegionSupervisor,
	SettleResult,
	SpawnInput,
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
			});
		this.uiProxy = options.uiProxy ?? this.rpc.uiProxy;
	}

	async spawnChild(input: SpawnInput): Promise<ChildHandle> {
		const mode = resolveSpawnMode(input.agent);
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

	async steer(name: string, text: string): Promise<void> {
		await this.backendFor(name).steer(name, text);
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
		throw new SubagentError(`unknown child: ${name}`, ErrorCodes.NOT_FOUND);
	}
}
