/**
 * JSON-RPC client over `hc connect` (herdr-core, "hc").
 *
 * Contract: `docs/contracts/centurion-terminal-backend-v1.md` D3.
 *
 * Why a client at all: the `hc` CLI's `run` subcommand has no `--env`, while the
 * `terminal.run` JSON-RPC method accepts `env`, `labels`, `cwd`, `name` and
 * `argv` (`hc schema`). So the transport is the protocol, not the argv surface:
 * this module spawns `hc connect` once and speaks newline-delimited JSON-RPC
 * 2.0 on its stdin/stdout.
 *
 * The client is deliberately dumb: it knows the method allowlist, id
 * correlation, timeouts and the shape of an error reply. It knows nothing about
 * terminals — `terminal-supervisor.ts` owns every semantic decision.
 *
 * No shell is ever involved: `spawn(bin, ["connect"])` takes an argv array, and
 * request params travel as JSON. There is no string interpolation into a
 * command line anywhere on this path.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

/**
 * The methods this client may call.
 *
 * An allowlist, not a formality: the connection is a general-purpose control
 * channel for the core (`server.stop`, `machine.*`, `file.write` …), and a
 * backend that only needs terminal facts must not be one typo away from
 * stopping the core.
 */
export const HC_METHODS = [
	"hello",
	"terminal.run",
	"terminal.get",
	"terminal.send",
	"terminal.wait",
	"terminal.interrupt",
	"terminal.kill",
	"terminal.rm",
] as const;

export type HcMethod = (typeof HC_METHODS)[number];

const HC_METHOD_SET: ReadonlySet<string> = new Set(HC_METHODS);

/** Per-call bound. `terminal.wait` is never called with a long timeout here. */
export const DEFAULT_HC_REQUEST_TIMEOUT_MS = 30_000;

/** Env var naming the `hc` binary when it is not on `PATH` (D3). */
export const HC_BIN_ENV = "HC_BIN";

/** What the client needs from a connection; the fake in tests implements this. */
export interface HcClient {
	/** Spawn `hc connect` and complete the `hello` handshake (idempotent). */
	start(): Promise<void>;
	/** One request/response round trip. Unknown methods are refused locally. */
	request<T = unknown>(
		method: HcMethod,
		params?: Readonly<Record<string, unknown>>,
		options?: { timeoutMs?: number },
	): Promise<T>;
	/** Tear the connection down; safe to call twice. */
	close(): void;
}

/** Params the protocol accepts as an object; `undefined` fields are dropped. */
export type HcParams = Readonly<Record<string, unknown>>;

/**
 * A JSON-RPC error reply, kept structured.
 *
 * `kind` is the core's own name for the failure (`name_taken`, `not_found`,
 * `spawn_failed`, …): it arrives as `error.data.kind`, and the `message` field
 * carries the same word by OpenRPC convention. Callers branch on `kind`, never
 * by matching prose, because the prose is allowed to grow a suffix.
 */
export class HcRpcError extends Error {
	readonly code: number;
	readonly kind: string;
	readonly data: unknown;

	constructor(payload: { code?: unknown; message?: unknown; data?: unknown }) {
		const data = payload.data;
		const kindFromData =
			typeof data === "object" && data !== null
				? (data as { kind?: unknown }).kind
				: undefined;
		const message =
			typeof payload.message === "string" && payload.message.length > 0
				? payload.message
				: "hc request failed";
		super(message);
		this.name = "HcRpcError";
		this.code =
			typeof payload.code === "number" && Number.isFinite(payload.code)
				? payload.code
				: -32603;
		this.kind = typeof kindFromData === "string" ? kindFromData : message;
		this.data = data;
	}
}

export interface HcClientOptions {
	/**
	 * `HC_BIN` when set, else `hc` on `PATH` (D3).
	 *
	 * Passed to `spawn` as argv[0] and resolved by the OS — this module never
	 * shells out to `which` or builds a command string.
	 */
	bin?: string;
	/** Environment for the `hc connect` child (defaults to `process.env`). */
	env?: NodeJS.ProcessEnv;
	/** Working directory for the connection process. */
	cwd?: string;
	/** Per-call default bound. */
	requestTimeoutMs?: number;
}

interface PendingCall {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
	timer?: NodeJS.Timeout;
}

/**
 * The production implementation: one `hc connect` child, newline-delimited
 * JSON, ids allocated per call.
 *
 * Failure modes are all local and synchronous to report:
 * - the process cannot be spawned → `start()` rejects;
 * - the process exits → every pending call rejects and later calls fail fast;
 * - a call exceeds its bound → that call rejects, the connection stays usable.
 */
/**
 * Resolve the `hc` executable without a shell.
 *
 * `HC_BIN` always wins. Otherwise: the first `hc` on `PATH`, then the default
 * install location `~/.local/bin/hc` (the installer's choice, and — measured on
 * this host — a directory that is frequently absent from `PATH`, e.g. inside an
 * hc terminal itself, whose PATH is only `/usr/local/bin:/usr/bin`). Failing
 * both, return the bare name so the spawn error names what was attempted.
 */
export function resolveHcBin(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
	const configured = env[HC_BIN_ENV];
	if (configured && configured.length > 0) return configured;
	for (const dir of (env.PATH ?? "").split(delimiter)) {
		if (dir.length === 0) continue;
		const candidate = join(dir, "hc");
		if (existsSync(candidate)) return candidate;
	}
	try {
		const local = join(home, ".local", "bin", "hc");
		if (existsSync(local)) return local;
	} catch {
		// A home directory that cannot be read is not a reason to fail before spawn.
	}
	return "hc";
}

export class HcCliClient implements HcClient {
	private readonly bin: string;
	private readonly env: NodeJS.ProcessEnv;
	private readonly cwd: string | undefined;
	private readonly requestTimeoutMs: number;
	private child: ChildProcess | undefined;
	private stdoutBuffer = "";
	private nextId = 1;
	private readonly pending = new Map<number, PendingCall>();
	private started: Promise<void> | undefined;
	private closed = false;
	private exitReason: string | undefined;

	constructor(options: HcClientOptions = {}) {
		this.bin = options.bin ?? resolveHcBin(options.env ?? process.env);
		this.env = options.env ?? process.env;
		this.cwd = options.cwd;
		this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_HC_REQUEST_TIMEOUT_MS;
	}

	start(): Promise<void> {
		if (!this.started) {
			this.started = (async () => {
				this.launch();
				await this.send("hello", { framed: false });
			})();
			// A failed handshake must leave `start()` retryable: the transport is
			// gone, so the next attempt spawns a fresh connection.
			this.started.catch(() => {
				this.started = undefined;
			});
		}
		return this.started;
	}

	async request<T = unknown>(
		method: HcMethod,
		params: HcParams = {},
		options: { timeoutMs?: number } = {},
	): Promise<T> {
		if (!HC_METHOD_SET.has(method)) {
			throw new Error(`hc method not allowed: ${method}`);
		}
		await this.start();
		return (await this.send(method, params, options.timeoutMs)) as T;
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.failAll(new Error("hc connection closed"));
		const child = this.child;
		this.child = undefined;
		if (!child) return;
		try {
			child.stdin?.end();
		} catch {
			/* the pipe may already be gone */
		}
		try {
			child.kill("SIGTERM");
		} catch {
			/* already exited */
		}
	}

	private launch(): void {
		const child = spawn(this.bin, ["connect"], {
			cwd: this.cwd,
			env: { ...process.env, ...this.env },
			stdio: ["pipe", "pipe", "pipe"],
		});
		this.child = child;
		this.stdoutBuffer = "";
		this.exitReason = undefined;

		child.stdout?.setEncoding("utf8");
		child.stdout?.on("data", (chunk: string) => {
			this.onStdout(chunk);
		});
		child.stderr?.on("data", () => {
			// stderr is diagnostic only: every fact this client acts on arrives on
			// stdout as protocol. Keeping it off the host's stderr stops a chatty
			// core from writing into the parent TUI.
		});
		child.once("error", (error: Error) => {
			this.onExit(`hc connect failed to start: ${error.message}`);
		});
		child.once("exit", (code, signal) => {
			const how = signal ? `signal ${signal}` : `code ${String(code)}`;
			this.onExit(`hc connect exited (${how})`);
		});
	}

	private onStdout(chunk: string): void {
		this.stdoutBuffer += chunk;
		let newline = this.stdoutBuffer.indexOf("\n");
		while (newline !== -1) {
			const line = this.stdoutBuffer.slice(0, newline).trim();
			this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
			if (line.length > 0) this.onLine(line);
			newline = this.stdoutBuffer.indexOf("\n");
		}
	}

	private onLine(line: string): void {
		// The protocol is newline-delimited JSON; anything else on stdout is noise
		// and is ignored rather than allowed to break the connection.
		if (!line.startsWith("{")) return;
		let message: unknown;
		try {
			message = JSON.parse(line);
		} catch {
			return;
		}
		if (typeof message !== "object" || message === null) return;
		const reply = message as {
			id?: unknown;
			result?: unknown;
			error?: { code?: unknown; message?: unknown; data?: unknown };
		};
		// Notifications (events, heartbeats) carry no id and are not this client's
		// business: v1 subscribes to nothing (contract D12).
		if (typeof reply.id !== "number") return;
		const call = this.pending.get(reply.id);
		if (!call) return;
		this.pending.delete(reply.id);
		if (call.timer) clearTimeout(call.timer);
		if (reply.error !== undefined) {
			call.reject(new HcRpcError(reply.error ?? {}));
			return;
		}
		call.resolve(reply.result);
	}

	private send(
		method: HcMethod,
		params: HcParams,
		timeoutMs = this.requestTimeoutMs,
	): Promise<unknown> {
		if (this.closed) return Promise.reject(new Error("hc connection closed"));
		if (this.exitReason) return Promise.reject(new Error(this.exitReason));
		const child = this.child;
		if (!child?.stdin) return Promise.reject(new Error("hc connection is not running"));
		const id = this.nextId++;
		const frame = `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`;
		return new Promise<unknown>((resolve, reject) => {
			const call: PendingCall = { resolve, reject };
			if (timeoutMs > 0) {
				call.timer = setTimeout(() => {
					if (!this.pending.delete(id)) return;
					reject(new Error(`hc request timed out after ${timeoutMs} ms: ${method}`));
				}, timeoutMs);
			}
			this.pending.set(id, call);
			try {
				child.stdin!.write(frame);
			} catch (error) {
				this.pending.delete(id);
				if (call.timer) clearTimeout(call.timer);
				reject(error instanceof Error ? error : new Error(String(error)));
			}
		});
	}

	private onExit(reason: string): void {
		this.exitReason = reason;
		this.child = undefined;
		this.failAll(new Error(reason));
	}

	private failAll(error: Error): void {
		for (const [id, call] of this.pending) {
			this.pending.delete(id);
			if (call.timer) clearTimeout(call.timer);
			call.reject(error);
		}
	}
}

/** Build the production client from the parent environment (D3). */
export function hcCliClient(options: HcClientOptions = {}): HcClient {
	return new HcCliClient(options);
}
