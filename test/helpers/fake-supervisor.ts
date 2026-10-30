/**
 * In-memory LegionSupervisor for orchestrator and extension tests.
 *
 * It records the RPC launch arguments and writes realistic Pi session JSONL;
 * no child process, herdr binary, pane or tab is created.
 */

import * as fs from "node:fs";
import { buildPiArgs } from "../../src/runs/args.ts";
import { formatChildTask } from "../../src/extension/child-guard.ts";
import type { Usage } from "../../src/shared/types.ts";
import {
	InMemoryUIProxy,
	type ExtensionUIRequest,
	type ExtensionUIResponse,
} from "../../src/supervisor/ui-proxy.ts";
import {
	type AbortOutcome,
	type ChildHandle,
	type LegionSupervisor,
	type RpcClientOptions,
	type SettleResult,
	type SpawnInput,
	type SteerDisposition,
	type SupervisorEvent,
	type SupervisorEventListener,
	type UsageSnapshot,
	DEFAULT_ABORT_TIMEOUT_MS,
} from "../../src/supervisor/types.ts";

export interface FakeSupervisorCall {
	method: "spawnChild" | "prompt" | "steer" | "followUp" | "abort" | "waitSettled" | "retire";
	name: string;
	text?: string;
	timeoutMs?: number;
	/** `opts.clearQueued` received by an `abort` call (#314); absent when omitted. */
	clearQueued?: boolean;
	/**
	 * The abort's `opts` argument exactly as received (#314): `undefined` when the
	 * caller passed no options object at all, which is what the default path owes
	 * the supervisor.
	 */
	abortOpts?: { clearQueued?: boolean; timeoutMs?: number };
	input?: SpawnInput;
}

export interface FakeSpawnRecord {
	input: SpawnInput;
	options: RpcClientOptions;
	args: string[];
	promptText: string;
	systemPrompt?: string;
	resumedFromExistingSession: boolean;
}

export interface FakeTurn {
	text: string;
	stopReason?: "stop" | "length" | "toolUse" | "error" | "aborted";
	errorMessage?: string;
	usage?: Partial<Usage>;
	model?: string;
}

interface FakeChild {
	name: string;
	sessionFile: string;
	alive: boolean;
	settleResult?: SettleResult;
	waiters: Array<(result: SettleResult) => void>;
	responses: Array<{ requestId: string; response: ExtensionUIResponse }>;
	usage: UsageSnapshot | null;
}

export interface FakeSupervisorOptions {
	/** Unsettled waits resolve with timeout immediately; useful for fast timeout tests. */
	immediateTimeout?: boolean;
	/** Auto-finish each launched child (for extension tool tests). */
	autoSettle?: FakeTurn | ((input: SpawnInput) => FakeTurn);
	/** Reject selected spawns to exercise model fallback. */
	rejectSpawn?: (input: SpawnInput) => Error | undefined;
	/** Optional initial cumulative stats snapshot. */
	usage?: UsageSnapshot | null;
}

function sessionLine(message: Record<string, unknown>): string {
	return JSON.stringify({ type: "message", message });
}

function userLine(text: string): string {
	return sessionLine({ role: "user", content: text });
}

function assistantLine(turn: FakeTurn): string {
	const usage = turn.usage;
	return JSON.stringify({
		type: "message",
		message: {
			role: "assistant",
			content: turn.text ? [{ type: "text", text: turn.text }] : [],
			stopReason: turn.stopReason ?? "stop",
			...(turn.errorMessage ? { errorMessage: turn.errorMessage } : {}),
			model: turn.model ?? "test/glm-5.3-flash",
			usage: {
				input: usage?.input ?? 10,
				output: usage?.output ?? 2,
				cacheRead: usage?.cacheRead ?? 0,
				cacheWrite: usage?.cacheWrite ?? 0,
				cost: { total: usage?.cost ?? 0.001 },
			},
		},
	});
}

function appendLines(file: string, lines: string[]): void {
	if (lines.length === 0) return;
	fs.appendFileSync(file, `${lines.join("\n")}\n`);
}

export class FakeSupervisor implements LegionSupervisor {
	readonly uiProxy = new InMemoryUIProxy();
	readonly calls: FakeSupervisorCall[] = [];
	readonly spawns: FakeSpawnRecord[] = [];
	readonly children = new Map<string, FakeChild>();
	private readonly listeners = new Map<string, Set<SupervisorEventListener>>();
	private readonly immediateTimeout: boolean;
	private readonly autoSettle?: FakeSupervisorOptions["autoSettle"];
	private readonly rejectSpawn?: FakeSupervisorOptions["rejectSpawn"];
	private readonly initialUsage: UsageSnapshot | null;
	/**
	 * Disposition every `steer` call reports (#313). Defaults to the honest
	 * `"queued"`; a test that wants `"accepted"` or `"intercepted"` sets it
	 * explicitly.
	 */
	steerDisposition: SteerDisposition = "queued";

	constructor(options: FakeSupervisorOptions = {}) {
		this.immediateTimeout = options.immediateTimeout ?? true;
		this.autoSettle = options.autoSettle;
		this.rejectSpawn = options.rejectSpawn;
		this.initialUsage = options.usage ?? null;
	}

	async spawnChild(input: SpawnInput): Promise<ChildHandle> {
		this.calls.push({ method: "spawnChild", name: input.name, input });
		const failure = this.rejectSpawn?.(input);
		if (failure) throw failure;
		if (input.agent.kind !== "pi") throw new Error(`FakeSupervisor only supports pi children, received ${input.agent.kind}`);
		const previous = this.children.get(input.name);
		if (previous?.alive) throw Object.assign(new Error(`child already alive: ${input.name}`), { code: "NAME_TAKEN" });
		const existed = this.spawns.some((spawn) => spawn.input.name === input.name && spawn.input.sessionFile === input.sessionFile) && fs.existsSync(input.sessionFile);
		fs.mkdirSync(input.tempDir, { recursive: true });
		const { name: _name, cwd: _cwd, env: _env, cliPath: _cliPath, ...buildInput } = input;
		const built = buildPiArgs({ ...buildInput, includeTask: false });
		const promptText = formatChildTask(input.task, {
			allowNested: input.allowNestedSubagents === true,
			...(input.worktreeBranch ? { worktreeBranch: input.worktreeBranch } : {}),
		});
		const systemPromptArg = built.args.find((arg) => arg.endsWith("system-prompt.md"));
		const systemPrompt = systemPromptArg ? fs.readFileSync(systemPromptArg, "utf8") : undefined;
		const options: RpcClientOptions = {
			cliPath: input.cliPath ?? "fake-pi-cli.js",
			cwd: input.cwd,
			args: built.args,
			...(input.env ? { env: input.env } : {}),
		};
		this.spawns.push({
			input,
			options,
			args: [...built.args],
			promptText,
			...(systemPrompt ? { systemPrompt } : {}),
			resumedFromExistingSession: existed,
		});
		appendLines(input.sessionFile, [userLine(promptText)]);
		for (const file of built.tempFiles) {
			try { fs.rmSync(file, { force: true }); } catch { /* test temp cleanup */ }
		}
		const child: FakeChild = {
			name: input.name,
			sessionFile: input.sessionFile,
			alive: true,
			waiters: [],
			responses: [],
			usage: this.initialUsage,
		};
		this.children.set(input.name, child);
		this.publish(input.name, { type: "agent_start" });
		if (this.autoSettle) {
			const turn = typeof this.autoSettle === "function" ? this.autoSettle(input) : this.autoSettle;
			queueMicrotask(() => {
				if (this.isAlive(input.name)) this.settle(input.name, turn);
			});
		}
		return { name: input.name, sessionFile: input.sessionFile, pid: 1000 + this.spawns.length };
	}

	async prompt(name: string, text: string): Promise<void> {
		const child = this.requireChild(name);
		this.calls.push({ method: "prompt", name, text });
		appendLines(child.sessionFile, [userLine(text)]);
		child.settleResult = undefined;
	}

	async steer(name: string, text: string): Promise<SteerDisposition> {
		const child = this.requireChild(name);
		this.calls.push({ method: "steer", name, text });
		appendLines(child.sessionFile, [userLine(text)]);
		child.settleResult = undefined;
		return this.steerDisposition;
	}

	async followUp(name: string, text: string): Promise<void> {
		this.requireChild(name);
		this.calls.push({ method: "followUp", name, text });
	}

	/**
	 * Outcome every `abort` call answers with (#314). Defaults to the honest
	 * `"interrupted"` with nothing dropped; a test that wants `"no-turn"` or
	 * `"timeout"` sets it explicitly.
	 */
	abortOutcome: AbortOutcome = {
		status: "interrupted",
		cleared: { steering: 0, followUp: 0 },
		timeoutMs: DEFAULT_ABORT_TIMEOUT_MS,
	};

	async abort(
		name: string,
		opts?: { clearQueued?: boolean; timeoutMs?: number },
	): Promise<AbortOutcome> {
		this.requireChild(name);
		this.calls.push({
			method: "abort",
			name,
			...(opts?.clearQueued !== undefined ? { clearQueued: opts.clearQueued } : {}),
			...(opts !== undefined ? { abortOpts: opts } : {}),
		});
		return this.abortOutcome;
	}

	waitSettled(name: string, timeoutMs?: number): Promise<SettleResult> {
		const child = this.requireChild(name);
		this.calls.push({ method: "waitSettled", name, ...(timeoutMs !== undefined ? { timeoutMs } : {}) });
		if (child.settleResult) return Promise.resolve(child.settleResult);
		if (!child.alive) return Promise.resolve({ settled: false, abnormal: true, reason: "child process exited" });
		if (this.immediateTimeout || timeoutMs === 0) return Promise.resolve({ settled: false, abnormal: false, reason: "timeout" });
		return new Promise((resolve) => child.waiters.push(resolve));
	}

	isAlive(name: string): boolean {
		return this.children.get(name)?.alive ?? false;
	}

	async stats(name: string): Promise<UsageSnapshot | null> {
		return this.children.get(name)?.usage ?? null;
	}

	async retire(name: string): Promise<void> {
		const child = this.requireChild(name);
		this.calls.push({ method: "retire", name });
		child.alive = false;
		child.settleResult ??= { settled: false, abnormal: false, reason: "child retired" };
		this.resolveWaiters(child, child.settleResult);
		this.publish(name, { type: "process_exit" });
		this.uiProxy.forgetChild(name);
	}

	onEvent(name: string, listener: SupervisorEventListener): () => void {
		let listeners = this.listeners.get(name);
		if (!listeners) {
			listeners = new Set();
			this.listeners.set(name, listeners);
		}
		listeners.add(listener);
		return () => listeners?.delete(listener);
	}

	settle(name: string, turn: FakeTurn): void {
		const child = this.requireChild(name);
		appendLines(child.sessionFile, [assistantLine(turn)]);
		child.settleResult = { settled: true, abnormal: false, aborted: turn.stopReason === "aborted" };
		this.resolveWaiters(child, child.settleResult);
		this.publish(name, { type: "agent_settled" });
	}

	exit(name: string, reason = "fake RPC child exited"): void {
		const child = this.requireChild(name);
		child.alive = false;
		child.settleResult = { settled: false, abnormal: true, reason };
		this.resolveWaiters(child, child.settleResult);
	}

	requestUI(name: string, request: ExtensionUIRequest): void {
		const child = this.requireChild(name);
		this.uiProxy.enqueue({
			childName: name,
			request,
			respond: (response) => child.responses.push({ requestId: request.id, response }),
		});
	}

	responseLog(name: string): Array<{ requestId: string; response: ExtensionUIResponse }> {
		return this.requireChild(name).responses.slice();
	}

	private requireChild(name: string): FakeChild {
		const child = this.children.get(name);
		if (!child) throw Object.assign(new Error(`unknown child: ${name}`), { code: "NOT_FOUND" });
		return child;
	}

	private resolveWaiters(child: FakeChild, result: SettleResult): void {
		for (const resolve of child.waiters.splice(0)) resolve(result);
	}

	private publish(name: string, event: Omit<SupervisorEvent, "name">): void {
		const full = { ...event, name } as SupervisorEvent;
		for (const listener of [...(this.listeners.get(name) ?? [])]) listener(full);
	}
}
