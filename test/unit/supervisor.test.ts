/**
 * Unit coverage for the M1 RPC supervisor process and event lifecycle.
 */

import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { RpcClient } from "@earendil-works/pi-coding-agent";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
	RpcSupervisor,
	defaultPiCliPath,
	type RpcSupervisorOptions,
} from "../../src/supervisor/rpc-supervisor.ts";
import {
	InMemoryUIProxy,
	type ExtensionUIRequest,
} from "../../src/supervisor/ui-proxy.ts";
import type {
	RpcClientFactory,
	RpcClientLike,
	RpcClientOptions,
	RpcProcessHandle,
	SpawnInput,
} from "../../src/supervisor/types.ts";
import { currentPgid } from "../../src/supervisor/proc-tree.ts";
import { RoutingSupervisor } from "../../src/supervisor/routing-supervisor.ts";
import { Orchestrator } from "../../src/runs/orchestrator.ts";
import {
	discoveredHostExtensions,
	resetExtensionDiscoveryCache,
} from "../../src/runs/extension-inheritance.ts";

class FakeRpcProcess implements RpcProcessHandle {
	readonly pid: number;
	readonly stdin = new PassThrough();
	exitCode: number | null = null;
	signalCode: NodeJS.Signals | null = null;
	readonly signals: NodeJS.Signals[] = [];
	readonly ignoredSignals = new Set<NodeJS.Signals>();
	ignoreInputClose = false;
	private readonly events = new EventEmitter();

	constructor(pid: number) {
		this.pid = pid;
		this.stdin.on("finish", () => {
			if (!this.ignoreInputClose) this.exit(0, null);
		});
	}

	once(
		event: "exit",
		listener: (code: number | null, signal: NodeJS.Signals | null) => void,
	): this;
	once(event: "error", listener: (error: Error) => void): this;
	once(
		event: "exit" | "error",
		listener:
			| ((code: number | null, signal: NodeJS.Signals | null) => void)
			| ((error: Error) => void),
	): this {
		this.events.once(event, listener);
		return this;
	}

	on(
		event: "exit" | "close",
		listener: (code: number | null, signal: NodeJS.Signals | null) => void,
	): this {
		this.events.on(event, listener);
		return this;
	}

	off(
		event: "exit" | "close",
		listener: (code: number | null, signal: NodeJS.Signals | null) => void,
	): this {
		this.events.off(event, listener);
		return this;
	}

	kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
		this.signals.push(signal);
		if (!this.ignoredSignals.has(signal)) this.exit(null, signal);
		return true;
	}

	exit(code: number | null, signal: NodeJS.Signals | null): void {
		if (this.exitCode !== null || this.signalCode !== null) return;
		this.exitCode = code;
		this.signalCode = signal;
		this.events.emit("exit", code, signal);
	}
}

class FakeRpcClient implements RpcClientLike {
	readonly options: RpcClientOptions;
	readonly process: FakeRpcProcess;
	readonly events = new Set<(event: unknown) => void>();
	readonly prompts: string[] = [];
	readonly steers: string[] = [];
	readonly followUps: string[] = [];
	/**
	 * Raw value this fake's `steer` resolves with (#313). Deliberately the SDK's
	 * own vocabulary — the real `RpcClient.steer()` returns the RPC reply's
	 * `disposition`, i.e. `"handled" | "queued"` — so RpcSupervisor's mapping
	 * through `toSteerDisposition` is exercised, not bypassed.
	 */
	steerDisposition: unknown = "queued";
	starts = 0;
	stops = 0;
	aborts = 0;
	startError?: Error;
	promptError?: Error;
	statsValue: unknown = {
		tokens: { input: 23, output: 11 },
		cost: 0.0125,
	};

	constructor(options: RpcClientOptions, pid: number) {
		this.options = options;
		this.process = new FakeRpcProcess(pid);
	}

	async start(): Promise<void> {
		this.starts += 1;
		if (this.startError) throw this.startError;
	}

	async stop(): Promise<void> {
		this.stops += 1;
		this.process.kill("SIGTERM");
	}

	onEvent(listener: (event: unknown) => void): () => void {
		this.events.add(listener);
		return () => this.events.delete(listener);
	}

	getStderr(): string {
		return "";
	}

	async prompt(message: string): Promise<void> {
		this.prompts.push(message);
		if (this.promptError) throw this.promptError;
	}

	async steer(message: string): Promise<unknown> {
		this.steers.push(message);
		return this.steerDisposition;
	}

	async followUp(message: string): Promise<void> {
		this.followUps.push(message);
	}

	async abort(): Promise<void> {
		this.aborts += 1;
	}

	async getSessionStats(): Promise<unknown> {
		return this.statsValue;
	}

	emit(event: unknown): void {
		for (const listener of [...this.events]) listener(event);
	}
}

function testAgent() {
	return {
		name: "worker",
		description: "unit test agent",
		kind: "pi" as const,
		source: "user" as const,
		filePath: "/tmp/worker.md",
		systemPrompt: "Follow the role instructions.",
		systemPromptMode: "append" as const,
		inheritProjectContext: true,
		inheritSkills: false,
		tools: ["read", "bash"],
		extensions: ["/tmp/example-extension.ts"],
	};
}

function testInput(root: string, name = "root.worker"): SpawnInput {
	return {
		name,
		task: "Complete the M1 supervisor smoke task.",
		agent: testAgent(),
		sessionFile: path.join(root, `${name}.jsonl`),
		tempDir: root,
		cwd: root,
		model: "openai/gpt-4.1",
		cliPath: "/tmp/pi-cli.js",
	};
}

function harness(options: Partial<RpcSupervisorOptions> = {}) {
	const root = mkdtempSync(path.join(tmpdir(), "legion-supervisor-test-"));
	const clients: FakeRpcClient[] = [];
	const factory: RpcClientFactory = (rpcOptions) => {
		const client = new FakeRpcClient(rpcOptions, 10_000 + clients.length);
		clients.push(client);
		return client;
	};
	const supervisor = new RpcSupervisor({
		clientFactory: factory,
		retireTimeoutMs: 100,
		signalTimeoutMs: 100,
		killTimeoutMs: 100,
		enumerateDescendants: () => [],
		...options,
	});
	return {
		root,
		clients,
		supervisor,
		close() {
			rmSync(root, { recursive: true, force: true });
		},
	};
}

function emitSettled(client: FakeRpcClient): void {
	client.emit({ type: "agent_settled" });
}

function emitAbortRecord(
	client: FakeRpcClient,
	source: "turn_end" | "agent_end",
): void {
	const abortedMessage = { role: "assistant", stopReason: "aborted" };
	if (source === "turn_end") {
		client.emit({
			type: "turn_end",
			message: abortedMessage,
			toolResults: [],
		});
	} else {
		client.emit({
			type: "agent_end",
			messages: [abortedMessage],
			willRetry: false,
		});
	}
	client.emit({ type: "agent_settled" });
}

test("spawn passes the complete buildPiArgs CLI context and starts the first prompt", async () => {
	const h = harness();
	try {
		const input = testInput(h.root);
		const handle = await h.supervisor.spawnChild(input);
		const client = h.clients[0]!;

		assert.equal(handle.name, input.name);
		assert.equal(handle.sessionFile, input.sessionFile);
		assert.equal(handle.pid, 10_000);
		assert.equal(client.options.cliPath, path.resolve("/tmp/pi-cli.js"));
		assert.equal(client.options.cwd, h.root);
		const args = client.options.args ?? [];
		const sessionIndex = args.indexOf("--session");
		assert.ok(sessionIndex >= 0);
		assert.equal(args[sessionIndex + 1], input.sessionFile);
		const modelIndex = args.indexOf("--model");
		assert.ok(modelIndex >= 0);
		assert.equal(args[modelIndex + 1], "openai/gpt-4.1");
		const toolsIndex = args.indexOf("--tools");
		assert.ok(toolsIndex >= 0);
		// REV-17.7 §2.7: non-utility allowlists include the separate recon tool.
		assert.equal(args[toolsIndex + 1], "read,bash,vexillatio");
		assert.ok(args.includes("--extension"));
		assert.ok(args.includes("/tmp/example-extension.ts"));
		assert.ok(args.includes("--append-system-prompt"));
		assert.equal(args.some((arg) => arg.startsWith("@")), false);
		assert.equal(client.starts, 1);
		assert.match(client.prompts[0] ?? "", /Complete the M1 supervisor smoke task/);
		assert.match(client.prompts[0] ?? "", /Task:/);
		assert.equal(h.supervisor.isAlive(input.name), true);
	} finally {
		await h.supervisor.retire("root.worker");
		h.close();
	}
});

test("RpcClient SDK sentinel keeps the host-visible runtime process slot", () => {
	const client = new RpcClient({ cliPath: "/tmp/pi-cli.js" });
	assert.equal(
		Object.hasOwn(client, "process"),
		true,
		"the host adapter relies on RpcClient.process remaining an own runtime field",
	);
	assert.equal(Reflect.get(client, "process"), null);
});

test("spawn → first prompt → agent_settled → graceful retire lifecycle", async () => {
	const h = harness();
	try {
		await h.supervisor.spawnChild(testInput(h.root));
		const client = h.clients[0]!;
		const waiting = h.supervisor.waitSettled("root.worker", 1_000);
		emitSettled(client);
		assert.deepEqual(await waiting, {
			settled: true,
			abnormal: false,
			aborted: false,
		});

		await h.supervisor.retire("root.worker");
		assert.equal(client.process.stdin.writableEnded, true);
		assert.deepEqual(client.process.signals, []);
		assert.equal(h.supervisor.isAlive("root.worker"), false);
	} finally {
		h.close();
	}
});

test("waitSettled: parent abort resolves promptly and clears the waiter timeout", async () => {
	const h = harness();
	const originalSetTimeout = globalThis.setTimeout;
	const originalClearTimeout = globalThis.clearTimeout;
	let waitTimer: ReturnType<typeof setTimeout> | undefined;
	let clearedWaitTimer = false;
	try {
		await h.supervisor.spawnChild(testInput(h.root));
		const controller = new AbortController();
		globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
			const timer = originalSetTimeout(...args);
			if (args[1] === 60_000) waitTimer = timer;
			return timer;
		}) as typeof setTimeout;
		globalThis.clearTimeout = ((...args: Parameters<typeof clearTimeout>) => {
			if (args[0] === waitTimer) clearedWaitTimer = true;
			return originalClearTimeout(...args);
		}) as typeof clearTimeout;

		const pending = h.supervisor.waitSettled("root.worker", 60_000, controller.signal);
		controller.abort();
		assert.deepEqual(await pending, {
			settled: false,
			abnormal: false,
			reason: "aborted by parent",
		});
		assert.ok(waitTimer, "the waiter installs a timeout guard");
		assert.equal(clearedWaitTimer, true, "abort clears the timeout guard");
	} finally {
		globalThis.setTimeout = originalSetTimeout;
		globalThis.clearTimeout = originalClearTimeout;
		await h.supervisor.retire("root.worker").catch(() => {});
		h.close();
	}
});

test("abort → waitSettled observes aborted turns from real RPC event shapes", async () => {
	for (const source of ["turn_end", "agent_end"] as const) {
		const h = harness();
		const name = `root.worker-${source}`;
		try {
			await h.supervisor.spawnChild(testInput(h.root, name));
			const client = h.clients[0]!;
			const waiting = h.supervisor.waitSettled(name, 1_000);
			await h.supervisor.abort(name);
			assert.equal(client.aborts, 1);
			emitAbortRecord(client, source);
			assert.deepEqual(await waiting, {
				settled: true,
				abnormal: false,
				aborted: true,
			});
		} finally {
			await h.supervisor.retire(name);
			h.close();
		}
	}
});

test("abnormal retire preserves the unexpected exit result for waitSettled", async () => {
	const h = harness();
	try {
		await h.supervisor.spawnChild(testInput(h.root));
		const client = h.clients[0]!;
		client.process.exitCode = 19;

		assert.equal(h.supervisor.isAlive("root.worker"), false);
		await h.supervisor.retire("root.worker");
		assert.deepEqual(await h.supervisor.waitSettled("root.worker"), {
			settled: false,
			abnormal: true,
			reason: "Pi RPC process exited before agent_settled",
			exitCode: 19,
			signal: null,
		});
	} finally {
		h.close();
	}
});

test("retire resolving timeout is retryable after a child ignores SIGTERM and SIGKILL", async () => {
	const h = harness();
	try {
		await h.supervisor.spawnChild(testInput(h.root));
		const process = h.clients[0]!.process;
		process.ignoreInputClose = true;
		process.ignoredSignals.add("SIGTERM");
		process.ignoredSignals.add("SIGKILL");

		await assert.rejects(
			h.supervisor.retire("root.worker", { graceful: false }),
			{ code: "RETIRE_FAILED" },
		);
		assert.equal(h.supervisor.isAlive("root.worker"), true);
		assert.deepEqual(process.signals, ["SIGTERM", "SIGKILL"]);

		process.ignoredSignals.delete("SIGTERM");
		await h.supervisor.retire("root.worker", { graceful: false });
		assert.deepEqual(process.signals, ["SIGTERM", "SIGKILL", "SIGTERM"]);
		assert.equal(h.supervisor.isAlive("root.worker"), false);
	} finally {
		h.close();
	}
});

test("SIGKILL escalation retires a child that ignores SIGTERM", async () => {
	const h = harness();
	try {
		await h.supervisor.spawnChild(testInput(h.root));
		const process = h.clients[0]!.process;
		process.ignoreInputClose = true;
		process.ignoredSignals.add("SIGTERM");

		await h.supervisor.retire("root.worker", { graceful: false });

		assert.deepEqual(process.signals, ["SIGTERM", "SIGKILL"]);
		assert.equal(h.supervisor.isAlive("root.worker"), false);
	} finally {
		h.close();
	}
});

test("retire sweeps enumerated descendants with SIGTERM then SIGKILL", async () => {
	const calls: Array<[number, NodeJS.Signals]> = [];
	const h = harness({
		enumerateDescendants: () => [
			{ pid: 4242, pgid: 4242 },
			{ pid: 5150, pgid: 4242 },
		],
		signalProcess: (target, signal) => {
			calls.push([target, signal]);
			return true;
		},
	});
	try {
		await h.supervisor.spawnChild(testInput(h.root));
		await h.supervisor.retire("root.worker", { graceful: false });

		assert.deepEqual(calls, [
			[-4242, "SIGTERM"],
			[4242, "SIGTERM"],
			[5150, "SIGTERM"],
			[-4242, "SIGKILL"],
			[4242, "SIGKILL"],
			[5150, "SIGKILL"],
		]);
	} finally {
		h.close();
	}
});

const ownPgidForSweepTest = currentPgid();
test(
	"descendant sweep never signals the supervisor's own process group",
	{ skip: ownPgidForSweepTest === null },
	async () => {
		if (ownPgidForSweepTest === null) return;
		const ownPgid = ownPgidForSweepTest;
		const calls: Array<[number, NodeJS.Signals]> = [];
		const h = harness({
			enumerateDescendants: () => [{ pid: 777, pgid: ownPgid }],
			signalProcess: (target, signal) => {
				calls.push([target, signal]);
				return true;
			},
		});
		try {
			await h.supervisor.spawnChild(testInput(h.root));
			await h.supervisor.retire("root.worker", { graceful: false });

			assert.deepEqual(calls, [
				[777, "SIGTERM"],
				[777, "SIGKILL"],
			]);
			assert.equal(calls.some(([target]) => target < 0), false);
		} finally {
			h.close();
		}
	},
);

test("retire completes without sweep when no descendants", async () => {
	const calls: Array<[number, NodeJS.Signals]> = [];
	const h = harness({
		signalProcess: (target, signal) => {
			calls.push([target, signal]);
			return true;
		},
	});
	try {
		await h.supervisor.spawnChild(testInput(h.root));
		await h.supervisor.retire("root.worker", { graceful: false });
		assert.deepEqual(calls, []);
	} finally {
		h.close();
	}
});

test("simultaneous spawns of the same name reject only the duplicate", async () => {
	const h = harness();
	try {
		const first = h.supervisor.spawnChild(testInput(h.root));
		const duplicate = h.supervisor.spawnChild(testInput(h.root));
		await assert.rejects(
			duplicate,
			(error: unknown) =>
				error instanceof Error &&
				"code" in error &&
				error.code === "NAME_TAKEN",
		);
		const handle = await first;
		assert.equal(handle.name, "root.worker");
		assert.equal(h.clients.length, 1);
		await h.supervisor.retire(handle.name);
	} finally {
		h.close();
	}
});

test("spawn failure stops the client, removes temp files, and permits retry", async () => {
	const root = mkdtempSync(path.join(tmpdir(), "legion-supervisor-rollback-"));
	const clients: FakeRpcClient[] = [];
	const supervisor = new RpcSupervisor({
		retireTimeoutMs: 100,
		signalTimeoutMs: 100,
		enumerateDescendants: () => [],
		clientFactory: (options) => {
			const client = new FakeRpcClient(options, 20_000 + clients.length);
			if (clients.length === 0) client.promptError = new Error("prompt rejected");
			clients.push(client);
			return client;
		},
	});
	try {
		await assert.rejects(
			supervisor.spawnChild(testInput(root)),
			/prompt rejected/,
		);
		assert.equal(clients[0]?.stops, 1);
		assert.deepEqual(readdirSync(root), []);

		const handle = await supervisor.spawnChild(testInput(root));
		assert.equal(handle.name, "root.worker");
		assert.equal(clients.length, 2);
		await supervisor.retire(handle.name);
		assert.deepEqual(readdirSync(root), []);
	} finally {
		await supervisor.retire("root.worker").catch(() => {});
		rmSync(root, { recursive: true, force: true });
	}
});

test("retire resolves a pending waiter when an injected client hides its process", async () => {
	const h = harness({
		clientFactory: () => {
			const listeners = new Set<(event: unknown) => void>();
			return {
				async start() {},
				async stop() {},
				onEvent(listener) {
					listeners.add(listener);
					return () => listeners.delete(listener);
				},
				async prompt() {},
				async steer() {},
				async followUp() {},
				async abort() {},
				async getSessionStats() {
					return null;
				},
			} satisfies RpcClientLike;
		},
	});
	try {
		await h.supervisor.spawnChild(testInput(h.root));
		const waiting = h.supervisor.waitSettled("root.worker", 1_000);
		await h.supervisor.retire("root.worker");
		assert.deepEqual(await waiting, {
			settled: false,
			abnormal: false,
			reason: "child retired before agent_settled",
		});
		assert.equal(h.supervisor.isAlive("root.worker"), false);
	} finally {
		h.close();
	}
});

test("steer and follow-up target an active RPC turn without starting another prompt", async () => {
	const h = harness();
	try {
		await h.supervisor.spawnChild(testInput(h.root));
		const client = h.clients[0]!;

		await h.supervisor.steer("root.worker", "Change direction now.");
		await h.supervisor.followUp("root.worker", "After the current turn, inspect tests.");
		assert.equal(client.prompts.length, 1);
		assert.deepEqual(client.steers, ["Change direction now."]);
		assert.deepEqual(client.followUps, ["After the current turn, inspect tests."]);

		emitSettled(client);
		await h.supervisor.steer("root.worker", "Start a fresh turn while idle.");
		assert.deepEqual(client.prompts.slice(1), ["Start a fresh turn while idle."]);
		assert.equal(client.steers.length, 1);
		emitSettled(client);
	} finally {
		await h.supervisor.retire("root.worker");
		h.close();
	}
});

test("steer returns the disposition mapped from the RPC client's raw answer (#313)", async () => {
	const h = harness();
	try {
		await h.supervisor.spawnChild(testInput(h.root));
		const client = h.clients[0]!;

		// The fake mirrors the SDK vocabulary, so the default is a raw "queued":
		// busying child + unnormalized answer must not be reported as delivered.
		assert.equal(client.steerDisposition, "queued");
		assert.equal(await h.supervisor.steer("root.worker", "default answer"), "queued");

		// raw "handled" is the only value that means the input handler took it now.
		client.steerDisposition = "handled";
		assert.equal(await h.supervisor.steer("root.worker", "take this now"), "delivered");

		// raw "queued" stays queued through the mapping.
		client.steerDisposition = "queued";
		assert.equal(await h.supervisor.steer("root.worker", "bank this"), "queued");
		assert.deepEqual(client.steers, ["default answer", "take this now", "bank this"]);
		assert.equal(client.prompts.length, 1);

		// A steer against an idle child starts the turn, so it did reach the model.
		emitSettled(client);
		assert.equal(await h.supervisor.steer("root.worker", "fresh turn"), "delivered");
		assert.deepEqual(client.prompts.slice(1), ["fresh turn"]);
		assert.equal(client.steers.length, 3);
		emitSettled(client);
	} finally {
		await h.supervisor.retire("root.worker");
		h.close();
	}
});

test("isAlive is a pure process-state query", async () => {
	const h = harness();
	try {
		await h.supervisor.spawnChild(testInput(h.root));
		const client = h.clients[0]!;
		client.process.exitCode = 23;

		assert.equal(h.supervisor.isAlive("root.worker"), false);
		assert.equal(
			client.events.size,
			1,
			"isAlive must not detach the RPC event listener or transition child state",
		);
	} finally {
		await h.supervisor.retire("root.worker").catch(() => {});
		h.close();
	}
});

test("unexpected process exit immediately resolves waitSettled as abnormal", async () => {
	const h = harness();
	try {
		await h.supervisor.spawnChild(testInput(h.root));
		const client = h.clients[0]!;
		const waiting = h.supervisor.waitSettled("root.worker", 5_000);
		client.process.exit(17, null);

		assert.deepEqual(await waiting, {
			settled: false,
			abnormal: true,
			reason: "Pi RPC process exited before agent_settled",
			exitCode: 17,
			signal: null,
		});
		assert.equal(h.supervisor.isAlive("root.worker"), false);
	} finally {
		h.close();
	}
});

test("ten concurrent children keep commands, events, stats, and exits isolated", async () => {
	// #131: host free-mem must not gate this isolation assertion (default minFree+10×reserve can
	// INSUFFICIENT_MEMORY on low-RAM boxes). Stub the probe; product gate stays intact.
	const h = harness({ memoryAvailable: () => 1_000_000 });
	try {
		const inputs = Array.from({ length: 10 }, (_, index) =>
			testInput(h.root, `root.worker-${index}`),
		);
		await Promise.all(inputs.map((input) => h.supervisor.spawnChild(input)));
		assert.equal(h.clients.length, 10);

		const seen = new Map<string, string[]>();
		for (const input of inputs) {
			seen.set(input.name, []);
			h.supervisor.onEvent(input.name, (event) => {
				if (event.type === "tool_execution_start") {
					seen.get(input.name)?.push(String(event.toolName));
				}
			});
		}
		for (let index = 0; index < inputs.length; index += 1) {
			const client = h.clients[index]!;
			const name = inputs[index]!.name;
			client.emit({ type: "tool_execution_start", toolCallId: `call-${index}`, toolName: name });
		}
		for (const input of inputs) {
			assert.deepEqual(seen.get(input.name), [input.name]);
		}

		await h.supervisor.steer("root.worker-4", "Only worker 4 gets this steer.");
		for (let index = 0; index < h.clients.length; index += 1) {
			assert.deepEqual(
				h.clients[index]!.steers,
				index === 4 ? ["Only worker 4 gets this steer."] : [],
			);
		}
		assert.deepEqual(await h.supervisor.stats("root.worker-7"), {
			tokensIn: 23,
			tokensOut: 11,
			costUsd: 0.0125,
		});

		const pending = inputs.map((input) =>
			h.supervisor.waitSettled(input.name, 1_000),
		);
		for (let index = 0; index < h.clients.length; index += 1) {
			emitSettled(h.clients[index]!);
		}
		const settled = await Promise.all(pending);
		assert.equal(settled.every((result) => result.settled && !result.abnormal), true);
	} finally {
		await Promise.all(
			h.clients.map((_, index) =>
				h.supervisor.retire(`root.worker-${index}`).catch(() => {}),
			),
		);
		h.close();
	}
});

test("memory gate refuses ten-concurrent spawn when free mem is insufficient", async () => {
	// #131: gate assertion lives here (not in the isolation test). Issue numbers:
	// PI_LEGION_MIN_FREE_MEM_MB=1024 + 160 MB × 10 starting = 2624 required; 2469 available → refuse.
	const prevMin = process.env.PI_LEGION_MIN_FREE_MEM_MB;
	const prevReserve = process.env.PI_LEGION_CHILD_RESERVE_MB;
	process.env.PI_LEGION_MIN_FREE_MEM_MB = "1024";
	process.env.PI_LEGION_CHILD_RESERVE_MB = "160";
	const h = harness({ memoryAvailable: () => 2469 });
	try {
		const inputs = Array.from({ length: 10 }, (_, index) =>
			testInput(h.root, `root.worker-${index}`),
		);
		const results = await Promise.allSettled(
			inputs.map((input) => h.supervisor.spawnChild(input)),
		);
		const rejected = results.filter(
			(r): r is PromiseRejectedResult => r.status === "rejected",
		);
		assert.ok(rejected.length >= 1, "at least one spawn must hit INSUFFICIENT_MEMORY");
		for (const r of rejected) {
			const err = r.reason as { code?: string; message?: string };
			assert.equal(err.code, "INSUFFICIENT_MEMORY");
			assert.match(String(err.message), /insufficient memory/);
			assert.match(String(err.message), /2624 MB required/);
		}
		const fulfilled = results.filter((r) => r.status === "fulfilled").length;
		assert.equal(fulfilled + rejected.length, 10);
		assert.ok(fulfilled < 10, "burst must not fully succeed under insufficient free mem");
	} finally {
		if (prevMin === undefined) delete process.env.PI_LEGION_MIN_FREE_MEM_MB;
		else process.env.PI_LEGION_MIN_FREE_MEM_MB = prevMin;
		if (prevReserve === undefined) delete process.env.PI_LEGION_CHILD_RESERVE_MB;
		else process.env.PI_LEGION_CHILD_RESERVE_MB = prevReserve;
		await Promise.all(
			Array.from({ length: 10 }, async (_, index) => {
				try {
					await h.supervisor.retire(`root.worker-${index}`);
				} catch {
					/* never registered (gate refused before spawn) */
				}
			}),
		);
		h.close();
	}
});

// ── R1-b: the warm-up must cover a backend driven without the router ────────

/**
 * A fake `pi` on PATH that reports one package dir we control.
 *
 * Discovery shells out to `pi list`, so the honest way to drive it is a real
 * child process: stubbing `execFile` would not exercise the argv or the env
 * passthrough that the production warm-up relies on.
 */
interface FakePiHost {
	entry: string;
	pathValue: string;
	piCalls(): number;
	cleanup(): void;
}

function fakePiHost(options: { alwaysFail?: boolean } = {}): FakePiHost {
	const root = mkdtempSync(path.join(tmpdir(), "legion-warm-host-"));
	const pkgDir = path.join(root, "npm", "node_modules", "fake-lens");
	mkdirSync(pkgDir, { recursive: true });
	writeFileSync(path.join(pkgDir, "index.ts"), "export default {};\n");
	const binDir = path.join(root, "bin");
	mkdirSync(binDir, { recursive: true });
	const logPath = path.join(root, "calls.log");
	const shim = path.join(binDir, "pi");
	writeFileSync(
		shim,
		[
			"#!/bin/sh",
			`echo "pi $*" >> ${JSON.stringify(logPath)}`,
			// A host whose `pi list` always fails (non-zero exit). The call is
			// still logged first, so the count is about probes attempted.
			...(options.alwaysFail ? ["exit 4"] : []),
			'echo "User packages:"',
			`echo "    ${pkgDir}"`,
		].join("\n") + "\n",
	);
	chmodSync(shim, 0o755);
	const lines = (): string[] => {
		try {
			return readFileSync(logPath, "utf8").split("\n").filter((line) => line.length > 0);
		} catch {
			return [];
		}
	};
	return {
		entry: path.join(pkgDir, "index.ts"),
		pathValue: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
		piCalls: () => lines().filter((line) => line.startsWith("pi ")).length,
		cleanup: () => rmSync(root, { recursive: true, force: true }),
	};
}

/** Run `fn` with the fake host first on PATH and a cold discovery cache. */
async function withFakePiHost<T>(host: FakePiHost, fn: () => Promise<T>): Promise<T> {
	const prevPath = process.env.PATH;
	process.env.PATH = host.pathValue;
	resetExtensionDiscoveryCache();
	try {
		return await fn();
	} finally {
		resetExtensionDiscoveryCache();
		if (prevPath === undefined) delete process.env.PATH;
		else process.env.PATH = prevPath;
	}
}

/** The slice of `AgentConfig` these cases need; no `spawnMode` means the default. */
function warmAgent(overrides: Record<string, unknown> = {}) {
	return {
		name: "worker",
		description: "warm-up test role",
		kind: "pi" as const,
		source: "user" as const,
		filePath: "/tmp/worker.md",
		systemPrompt: "Follow the role instructions.",
		systemPromptMode: "append" as const,
		inheritProjectContext: true,
		inheritSkills: false,
		tools: ["read"],
		...overrides,
	};
}

test("A14: a directly-constructed RpcSupervisor warms discovery through Orchestrator.launch", async () => {
	// The documented public shape (`api.ts:13`): `new Orchestrator({ supervisor:
	// new RpcSupervisor(), ... })`. It never touches RoutingSupervisor, so the
	// router-level warm-up (#280 D3) cannot cover it and #280's symptom returns
	// in full — the child's argv builder would read an empty sync cache.
	const host = fakePiHost();
	const h = harness({ memoryAvailable: () => 1_000_000 });
	try {
		await withFakePiHost(host, async () => {
			assert.equal(discoveredHostExtensions(), undefined, "precondition: cold cache");
			const orchestrator = new Orchestrator({
				supervisor: h.supervisor,
				runDir: h.root,
				cwd: h.root,
				maxDepth: 4,
			});
			const handle = await orchestrator.launch({ agent: warmAgent(), task: "t", name: "worker", worktree: false });
			assert.deepEqual(
				discoveredHostExtensions(),
				[host.entry],
				"the backend's own spawnChild must have warmed discovery (R1-b)",
			);
			assert.ok(
				(h.clients.at(-1)?.options.args ?? []).includes(host.entry),
				"and that warm set is what the child is started with",
			);
			orchestrator.flushLaunchQueue("test cleanup");
			await h.supervisor.retire(handle.name).catch(() => {});
		});
	} finally {
		h.close();
		host.cleanup();
	}
});

test("A16: router + backend both warming still runs exactly one `pi list`", async () => {
	// The router keeps its warm (it runs before parameter validation and covers
	// both backends), and the backend now warms too (R1-b). Two spawns must still
	// cost one `pi list`: the second call is a cache hit, not a second probe.
	const host = fakePiHost();
	const h = harness({ memoryAvailable: () => 1_000_000 });
	try {
		await withFakePiHost(host, async () => {
			const router = new RoutingSupervisor({ rpc: h.supervisor });
			const input = (name: string): SpawnInput => ({
				...testInput(h.root, name),
				agent: { ...warmAgent({ spawnMode: "rpc", extensions: [] }), name: "worker" } as SpawnInput["agent"],
			});
			await router.spawnChild(input("root.first"));
			await router.spawnChild(input("root.second"));
			assert.deepEqual(discoveredHostExtensions(), [host.entry], "the router path is warm");
			assert.equal(h.clients.length, 2, "precondition: two real backend spawns happened");
			assert.equal(host.piCalls(), 1, "router warm + backend warm must not add a second `pi list`");
			await router.retire("root.first").catch(() => {});
			await router.retire("root.second").catch(() => {});
		});
	} finally {
		h.close();
		host.cleanup();
	}
});

test("A20: a failing `pi list` costs one probe per spawn, not two", async () => {
	// R2-b/F39: three warm-up points sit on one spawn (router, then the backend).
	// Before the failure backoff each of them re-probed a failing host, so a
	// failing `pi list` cost 2× per spawn — before the memory gate, and `pi list`
	// costs 0.3–0.9 s when it works (up to its timeout when it does not).
	const host = fakePiHost({ alwaysFail: true });
	const h = harness({ memoryAvailable: () => 1_000_000 });
	try {
		await withFakePiHost(host, async () => {
			const router = new RoutingSupervisor({ rpc: h.supervisor });
			const input = (name: string): SpawnInput => ({
				...testInput(h.root, name),
				agent: { ...warmAgent({ spawnMode: "rpc", extensions: [] }), name: "worker" } as SpawnInput["agent"],
			});

			await router.spawnChild(input("root.failing"));
			assert.equal(
				host.piCalls(),
				1,
				"router warm + backend warm share one failed probe (F39: it used to be 2)",
			);
			assert.deepEqual(
				discoveredHostExtensions(),
				undefined,
				"and the failure is still NOT cached as [] (F23), only backed off",
			);
			assert.equal(h.clients.length, 1, "precondition: the backend really did spawn");

			// The second spawn inside the window continues off the same backoff.
			await router.spawnChild(input("root.failing.2"));
			assert.equal(h.clients.length, 2, "precondition: two real backend spawns happened");
			assert.equal(
				host.piCalls(),
				1,
				"still one probe: the TTL covers every warm call of these spawns",
			);

			await router.retire("root.failing").catch(() => {});
			await router.retire("root.failing.2").catch(() => {});
		});
	} finally {
		h.close();
		host.cleanup();
	}
});

test("A21: the router retries a failing `pi list` once the backoff window passes", async () => {
	// The recoverability half of R2-b (F23/A21): the backoff must not become the
	// permanent off switch that the old `cached []` shape was. Ages the stamp the
	// way wall-clock time would, with the router driving the spawn path.
	const host = fakePiHost({ alwaysFail: true });
	const h = harness({ memoryAvailable: () => 1_000_000 });
	try {
		await withFakePiHost(host, async () => {
			const router = new RoutingSupervisor({ rpc: h.supervisor });
			const input = (name: string): SpawnInput => ({
				...testInput(h.root, name),
				agent: { ...warmAgent({ spawnMode: "rpc", extensions: [] }), name: "worker" } as SpawnInput["agent"],
			});
			await router.spawnChild(input("root.backoff"));
			assert.equal(host.piCalls(), 1);

			// Cross the window through the live holder, exactly as elapsed time would.
			const holder = (globalThis as unknown as Record<symbol, { failedAt?: number } | undefined>)[
				Symbol.for("pi-legion.extension-discovery")
			];
			assert.ok(holder, "discovery state lives on the shared holder");
			holder.failedAt = Date.now() - 60_000;

			await router.spawnChild(input("root.backoff.2"));
			assert.equal(host.piCalls(), 2, "past the TTL the router probes again (F23: not a permanent off switch)");

			await router.retire("root.backoff").catch(() => {});
			await router.retire("root.backoff.2").catch(() => {});
		});
	} finally {
		h.close();
		host.cleanup();
	}
});

test("text deltas are opt-in while default events stay coarse", async () => {
	const h = harness();
	try {
		await h.supervisor.spawnChild(testInput(h.root));
		const client = h.clients[0]!;
		const coarse: Array<Record<string, unknown>> = [];
		const detailed: Array<Record<string, unknown>> = [];
		h.supervisor.onEvent("root.worker", (event) => coarse.push(event));
		h.supervisor.onEvent("root.worker", (event) => detailed.push(event), {
			includeTextDelta: true,
		});

		client.emit({
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", delta: "secret text" },
		});
		client.emit({
			type: "message_update",
			assistantMessageEvent: { type: "thinking_delta", delta: "private reasoning" },
		});
		client.emit({
			type: "message_update",
			assistantMessageEvent: { type: "toolcall_start", toolName: "read" },
		});
		assert.equal(coarse.some((event) => event.delta === "secret text"), false);
		assert.equal(detailed.some((event) => event.delta === "private reasoning"), false);
		assert.equal(coarse.some((event) => event.updateType === "text_delta"), false);
		assert.equal(detailed.some((event) => event.delta === "secret text"), true);
		assert.equal(coarse.some((event) => event.toolName === "read"), true);
	} finally {
		await h.supervisor.retire("root.worker");
		h.close();
	}
});

test("extension UI requests queue with source identity and deliver correlated replies", async () => {
	const h = harness();
	try {
		await h.supervisor.spawnChild(testInput(h.root));
		const client = h.clients[0]!;
		const request: ExtensionUIRequest = {
			type: "extension_ui_request",
			id: "rpc-dialog-1",
			method: "confirm",
			title: "Approval",
			message: "Run the command?",
		};
		client.emit(request);
		const queued = h.supervisor.uiProxy.pending();
		assert.equal(queued.length, 1);
		assert.equal(queued[0]?.childName, "root.worker");
		assert.equal(queued[0]?.rpcRequestId, "rpc-dialog-1");

		const pending = h.supervisor.uiProxy.take();
		assert.ok(pending);
		assert.equal(
			h.supervisor.uiProxy.respond(pending.id, { confirmed: true }),
			true,
		);
		assert.equal(h.supervisor.uiProxy.respond(pending.id, { confirmed: false }), false);
		const stdinText = client.process.stdin.read()?.toString() ?? "";
		assert.deepEqual(JSON.parse(stdinText), {
			type: "extension_ui_response",
			id: "rpc-dialog-1",
			confirmed: true,
		});
	} finally {
		await h.supervisor.retire("root.worker");
		h.close();
	}
});

test("non-dialog extension UI events queue without an answer callback", () => {
	const proxy = new InMemoryUIProxy();
	let callbackCount = 0;
	const request: ExtensionUIRequest = {
		type: "extension_ui_request",
		id: "rpc-notify-1",
		method: "notify",
		message: "Heads up",
	};
	const pending = proxy.enqueue({
		childName: "root.worker",
		request,
		respond: () => callbackCount++,
	});

	assert.equal(proxy.pending()[0]?.id, pending.id);
	assert.equal(proxy.respond(pending.id, { cancelled: true }), false);
	assert.equal(callbackCount, 0);
	proxy.forgetChild("root.worker");
	assert.equal(proxy.pending().length, 0);
});

test("defaultPiCliPath prefers the host pi install over the repo devDependency", () => {
	// Regression: import.meta.resolve picked this repo's 0.85.x devDependency
	// bundle as the child CLI while the host client was 1.1.x, whose prompt
	// responses include data.disposition. The 0.85.x child omits `data`, so
	// every real-deployment launch threw "Cannot read properties of undefined
	// (reading 'disposition')". The live suite missed it because inside this
	// repo client and child were both 0.85.x.
	const originalArgv1 = process.argv[1] ?? "/usr/bin/node";
	const originalEnv = process.env.PI_SUBAGENT_CLI;
	try {
		// 1. Explicit env override wins.
		process.env.PI_SUBAGENT_CLI = "/opt/other-pi/cli.js";
		assert.equal(defaultPiCliPath(), "/opt/other-pi/cli.js");

		// 2. Host argv[1] under a pi-coding-agent install resolves to that
		// install's dist/cli.js (same dialect as the host client).
		delete process.env.PI_SUBAGENT_CLI;
		process.argv[1] =
			"/mise/lib/node_modules/@earendil-works/pi-coding-agent/bin/pi";
		assert.match(
			defaultPiCliPath(),
			/@earendil-works[\\/]pi-coding-agent[\\/]dist[\\/]cli\.js$/,
		);

		// 3. No override and no recognizable host entry: legacy devDependency
		// fallback (keeps bare test harnesses working).
		process.argv[1] = "/usr/bin/node";
		const fallback = defaultPiCliPath();
		assert.match(fallback, /pi-coding-agent/);
	} finally {
		process.argv[1] = originalArgv1;
		if (originalEnv === undefined) delete process.env.PI_SUBAGENT_CLI;
		else process.env.PI_SUBAGENT_CLI = originalEnv;
	}
});

test("#193 mapping: unexpected exit 0 is abnormal (green exit ≠ settled)", async () => {
	const h = harness();
	try {
		await h.supervisor.spawnChild(testInput(h.root));
		const waiting = h.supervisor.waitSettled("root.worker", 5_000);
		h.clients[0]!.process.exit(0, null);
		assert.deepEqual(await waiting, {
			settled: false,
			abnormal: true,
			reason: "Pi RPC process exited before agent_settled",
			exitCode: 0,
			signal: null,
		});
	} finally {
		h.close();
	}
});

test("#193 mapping: unexpected nonzero exit is abnormal with exitCode", async () => {
	const h = harness();
	try {
		await h.supervisor.spawnChild(testInput(h.root));
		const waiting = h.supervisor.waitSettled("root.worker", 5_000);
		h.clients[0]!.process.exit(42, null);
		assert.deepEqual(await waiting, {
			settled: false,
			abnormal: true,
			reason: "Pi RPC process exited before agent_settled",
			exitCode: 42,
			signal: null,
		});
	} finally {
		h.close();
	}
});

test("#193 mapping: unexpected signal exit is abnormal with signal", async () => {
	const h = harness();
	try {
		await h.supervisor.spawnChild(testInput(h.root));
		const waiting = h.supervisor.waitSettled("root.worker", 5_000);
		h.clients[0]!.process.exit(null, "SIGKILL");
		assert.deepEqual(await waiting, {
			settled: false,
			abnormal: true,
			reason: "Pi RPC process exited before agent_settled",
			exitCode: null,
			signal: "SIGKILL",
		});
	} finally {
		h.close();
	}
});

test("#193 mapping: retireRequested + signal → abnormal:false retired", async () => {
	const h = harness();
	try {
		await h.supervisor.spawnChild(testInput(h.root));
		const client = h.clients[0]!;
		client.process.ignoreInputClose = true;
		const waiting = h.supervisor.waitSettled("root.worker", 5_000);
		const retiring = h.supervisor.retire("root.worker");
		// Fake process exits on SIGTERM from retire escalate path.
		await retiring;
		const result = await waiting;
		assert.equal(result.settled, false);
		assert.equal(result.abnormal, false);
		assert.match(result.reason ?? "", /retired/i);
		assert.ok(
			result.signal === "SIGTERM" ||
				result.signal === "SIGKILL" ||
				result.exitCode !== undefined,
			"retired result should carry exitCode and/or signal",
		);
	} finally {
		h.close();
	}
});

test("#193 mapping: agent_settled → settled:true abnormal:false", async () => {
	const h = harness();
	try {
		await h.supervisor.spawnChild(testInput(h.root));
		const waiting = h.supervisor.waitSettled("root.worker", 1_000);
		emitSettled(h.clients[0]!);
		assert.deepEqual(await waiting, {
			settled: true,
			abnormal: false,
			aborted: false,
		});
	} finally {
		await h.supervisor.retire("root.worker");
		h.close();
	}
});

test("#193 spawn approve:true puts --approve on RpcClient argv", async () => {
	const h = harness();
	try {
		const input = { ...testInput(h.root), approve: true };
		await h.supervisor.spawnChild(input);
		const args = h.clients[0]!.options.args ?? [];
		assert.ok(args.includes("--approve"));
		assert.equal(args.includes("--no-approve"), false);
	} finally {
		await h.supervisor.retire("root.worker");
		h.close();
	}
});

test("#193 spawn default argv omits --approve", async () => {
	const h = harness();
	try {
		await h.supervisor.spawnChild(testInput(h.root));
		const args = h.clients[0]!.options.args ?? [];
		assert.equal(args.includes("--approve"), false);
	} finally {
		await h.supervisor.retire("root.worker");
		h.close();
	}
});
