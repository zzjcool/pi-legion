/**
 * M1 RPC supervisor contracts and the narrow client adapter seam used by tests.
 */

import type { RpcClientOptions as PiRpcClientOptions } from "@earendil-works/pi-coding-agent";
import type { Writable } from "node:stream";
import type { BuildArgsInput } from "../runs/args.ts";
import type { ChildLaunchContext } from "./child-context.ts";
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
	/**
	 * In-process lineage identity (spawn-default-inprocess-v3 D5).
	 *
	 * Deliberately NOT named `childContext`: that inherited `BuildArgsInput`
	 * field is the *string* settings-injected prompt context, and an interface
	 * cannot narrow an inherited member to an object type (TS2430). The two
	 * channels are unrelated — one is prompt text, this one is identity.
	 *
	 * Only the inprocess backend consumes it; RPC keeps using env lineage.
	 * Absent → InProcessSupervisor derives a minimal fallback context.
	 */
	childLaunchContext?: ChildLaunchContext;
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
	/** Called with the refusal text when the memory gate blocks a spawn (UI notify hook). */
	onSpawnRefused?: (message: string) => void;
	/** Override the available-memory probe (MB) in tests. */
	memoryAvailable?: () => number;
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

/**
 * What a `steer` call actually achieved (#313).
 *
 * `"queued"` is the honest default: the message is sitting behind the child's
 * in-flight work, not in front of the model. `"delivered"` means the child's
 * input handler consumed it right away.
 */
export type SteerDisposition = "queued" | "delivered";

/**
 * Normalize the SDK's steer vocabulary (`"handled" | "queued"`) into
 * {@link SteerDisposition} (#313 D2). The only place this mapping happens.
 *
 * Anything that is not literally `"handled"` — `"queued"`, `undefined`, a
 * backend that returns junk, an older SDK that returns nothing — maps to
 * `"queued"`. Rationale: a receipt must never claim delivery on doubt. A
 * false `"queued"` merely understates; a false `"delivered"` would tell a
 * parent its correction landed while the child is still running its previous
 * tool batch.
 */
export function toSteerDisposition(raw: unknown): SteerDisposition {
	return raw === "handled" ? "delivered" : "queued";
}

/** The orchestrator's frozen backend seam (legion-v2-contract.md §3.1). */
export interface LegionSupervisor {
	spawnChild(input: SpawnInput): Promise<ChildHandle>;
	prompt(name: string, text: string): Promise<void>;
	/**
	 * Steer a running child (#313): the returned disposition says whether the
	 * message was taken now (`"delivered"`) or banked behind the current tool
	 * batch (`"queued"`). Callers that build a receipt must report it.
	 */
	steer(name: string, text: string): Promise<SteerDisposition>;
	followUp(name: string, text: string): Promise<void>;
	abort(name: string): Promise<void>;
	waitSettled(name: string, timeoutMs?: number, signal?: AbortSignal): Promise<SettleResult>;
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
