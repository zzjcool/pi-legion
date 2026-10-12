/**
 * M1 RPC supervisor contracts and the narrow client adapter seam used by tests.
 */

import type { RpcClientOptions as PiRpcClientOptions } from "@earendil-works/pi-coding-agent";
import type { Writable } from "node:stream";
import type { BuildArgsInput } from "../runs/args.ts";
import type { UIProxy } from "./ui-proxy.ts";

/**
 * Input to one child launch. `name` is the registry key supplied by the caller
 * (the tree node id in v2); this layer does not sanitize or expand it.
 */
export interface SpawnInput extends Omit<BuildArgsInput, "cwd" | "includeTask"> {
	name: string;
	/** Working directory for the child Pi process. */
	cwd: string;
	/** Environment overlay passed to RpcClient. */
	env?: Record<string, string>;
	/** Whether to remove Legion lineage identity from the inherited environment. */
	stripLegionIdentity?: boolean;
	/** Optional Pi CLI entry point override. */
	cliPath?: string;
}

/** Handle returned after the RPC process accepts its first prompt. */
export interface ChildHandle {
	name: string;
	sessionFile: string;
	pid?: number;
}

/** Process id and process group id for one descendant of a supervised child. */
export interface DescendantInfo {
	pid: number;
	pgid: number;
}

/** Injectable options for process lifecycle handling in RpcSupervisor. */
export interface RpcSupervisorOptions {
	/** Replace the Pi client constructor in unit tests. */
	clientFactory?: RpcClientFactory;
	/** In-memory by default; M1-integration supplies a real TUI consumer. */
	uiProxy?: UIProxy;
	/** Grace period after stdin close before SIGTERM. */
	retireTimeoutMs?: number;
	/** Grace period for a child to exit after SIGTERM. */
	signalTimeoutMs?: number;
	/** Grace period for a child to exit after SIGKILL. */
	killTimeoutMs?: number;
	/** Enumerate process descendants before retiring a child. */
	enumerateDescendants?: (rootPid: number) => DescendantInfo[];
	/** Signal a PID or process group while sweeping descendants. */
	signalProcess?: (target: number, signal: NodeJS.Signals) => boolean;
}

/** Result of waiting for a child turn to settle or for its process to exit. */
export interface SettleResult {
	/** True only when Pi emitted `agent_settled`. */
	settled: boolean;
	/** True when the process exited before a settle event was observed. */
	abnormal: boolean;
	aborted?: boolean;
	exitCode?: number | null;
	signal?: NodeJS.Signals | null;
	reason?: string;
}

/** Cumulative usage reported by the Pi RPC `get_session_stats` command. */
export interface UsageSnapshot {
	tokensIn: number;
	tokensOut: number;
	costUsd: number;
}

/** The orchestrator's frozen backend seam (legion-v2-contract.md §3.1). */
export interface LegionSupervisor {
	spawnChild(input: SpawnInput): Promise<ChildHandle>;
	prompt(name: string, text: string): Promise<void>;
	steer(name: string, text: string): Promise<void>;
	followUp(name: string, text: string): Promise<void>;
	abort(name: string): Promise<void>;
	waitSettled(name: string, timeoutMs?: number): Promise<SettleResult>;
	isAlive(name: string): boolean;
	stats(name: string): Promise<UsageSnapshot | null>;
	retire(name: string, opts?: { graceful?: boolean }): Promise<void>;
}

/**
 * RpcClient's public constructor options. Kept as an alias so the adapter tracks
 * the installed Pi SDK without widening the supervisor contract.
 */
export type RpcClientOptions = PiRpcClientOptions;

/** Runtime process controls used by the host for exit and stdin lifecycle. */
export interface RpcProcessHandle {
	pid?: number;
	stdin:
		| Pick<Writable, "destroyed" | "writableEnded" | "write" | "end">
		| null;
	exitCode: number | null;
	signalCode: NodeJS.Signals | null;
	once(
		event: "exit",
		listener: (code: number | null, signal: NodeJS.Signals | null) => void,
	): this;
	once(event: "error", listener: (error: Error) => void): this;
	on(
		event: "exit" | "close",
		listener: (code: number | null, signal: NodeJS.Signals | null) => void,
	): this;
	off(
		event: "exit" | "close",
		listener: (code: number | null, signal: NodeJS.Signals | null) => void,
	): this;
	kill(signal?: NodeJS.Signals): boolean;
}

/** Only the RpcClient operations owned by the M1 host layer. */
export interface RpcClientLike {
	/** Runtime process handle; RpcClient currently keeps it TS-private. */
	process?: RpcProcessHandle | null;
	start(): Promise<void>;
	stop(): Promise<void>;
	onEvent(listener: (event: unknown) => void): () => void;
	getStderr?(): string;
	prompt(message: string): Promise<unknown>;
	steer(message: string): Promise<unknown>;
	followUp(message: string): Promise<unknown>;
	abort(): Promise<void>;
	getSessionStats(): Promise<unknown>;
}

/** Injectable RpcClient constructor used by unit tests. */
export type RpcClientFactory = (options: RpcClientOptions) => RpcClientLike;

/** Coarse lifecycle/tool event delivered by RpcSupervisor.onEvent(). */
export interface SupervisorEvent {
	name: string;
	type: string;
	[key: string]: unknown;
}

/** text_delta payloads are opt-in to keep default event traffic coarse. */
export interface EventSubscriptionOptions {
	includeTextDelta?: boolean;
}

export type SupervisorEventListener = (event: SupervisorEvent) => void;
