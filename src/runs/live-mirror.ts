/**
 * #411 — the live mirror of a cross-machine child's transcript
 * (contract: `.pi-legion/contract.md` §2, frozen).
 *
 * A cross-machine child writes `session.jsonl` on ITS machine. The record's
 * `sessionFile` here is an empty placeholder this machine pre-created, so every
 * local reader of it (the panel, `lastJsonlEventAgeMs`, `progressFromSessionFile`)
 * reads zero bytes forever. This module is the PUMP: it copies the remote file's
 * bytes into `localPath` incrementally, so those readers need no change at all.
 *
 * Design rules, each of them load-bearing:
 *
 *   - **Incremental, never full.** `offset` is "how far into the remote file this
 *     mirror has consumed". It is independent of the local byte count: the cap
 *     drops bytes from the head of the mirror, and that must not make the pump
 *     re-read the remote from zero.
 *   - **Atomic visible writes.** Every local write is `<target>.<pid>-<n>.tmp` in
 *     the SAME directory, then `renameSync`. A concurrent reader sees the old
 *     length or the new one, never a half-written line.
 *   - **Complete lines only.** Bytes after the last `\n` of what was read are NOT
 *     written; they are read again on the next tick, once the newline exists. The
 *     local file therefore always ends on a complete line, which is what a JSONL
 *     reader needs to make progress.
 *   - **The pump can never hurt the child.** `syncNow()` swallows everything: a
 *     dead connection, a missing remote command, a full disk. It records the
 *     message in `facts().error` and tails off; it never throws into `launch`,
 *     `collect` or a status render. The same text is warned once, not every tick.
 *
 * One known limitation, deliberately inside the contract rather than around it:
 * a single remote line longer than `chunkBytes` (default 256 KiB) cannot be
 * committed while it has no newline, so the mirror waits for that line to
 * complete. That is invariant 7 taken literally; the alternative (writing a
 * partial line) breaks the reader.
 */

import { Buffer } from "node:buffer";
import * as fs from "node:fs";
import * as path from "node:path";

import { hcCliClient, type HcClient } from "../hc/client.ts";
import { execResultText, type HcExecResult } from "./remote.ts";

// ── frozen defaults ────────────────────────────────────────────────────────

/** How often the production pump ticks. */
export const LIVE_MIRROR_INTERVAL_MS = 5_000;
/** Hard cap on the local mirror; the tail is what is kept (invariant 3). */
export const LIVE_MIRROR_MAX_BYTES = 4 * 1024 * 1024;
/** Bytes per `tail -c` round trip; also the per-tick read budget floor. */
export const LIVE_MIRROR_CHUNK_BYTES = 256 * 1024;
/** `off` / `0` / `false` (case-insensitive, trimmed) disables the pump. */
export const LIVE_MIRROR_ENV = "PI_LEGION_LIVE_MIRROR";
export const LIVE_MIRROR_INTERVAL_ENV = "PI_LEGION_LIVE_MIRROR_INTERVAL_MS";
export const LIVE_MIRROR_MAX_BYTES_ENV = "PI_LEGION_LIVE_MIRROR_MAX_BYTES";

/**
 * Floors. A configured interval of `0` would hammer the target machine once per
 * event-loop turn and a `maxBytes` of `0` would leave an empty mirror, so both
 * inputs are clamped rather than trusted.
 */
export const LIVE_MIRROR_MIN_INTERVAL_MS = 500;
export const LIVE_MIRROR_MIN_MAX_BYTES = 4096;

/** The remote file's name inside `remoteDir`; the child's own transcript. */
const REMOTE_FILE_NAME = "session.jsonl";
/** `machine.exec` bound for one `wc -c` / `tail -c` round trip, in SECONDS. */
const DEFAULT_REMOTE_TIMEOUT_S = 30;
/** The byte the pump cuts on. */
const NEWLINE = 0x0a;

// ── config ─────────────────────────────────────────────────────────────────

export interface LiveMirrorConfig {
	enabled: boolean;
	intervalMs: number;
	maxBytes: number;
}

/**
 * A strictly positive integer, or `undefined` for "not usable, use the default".
 *
 * Env values arrive as strings, so `"0"`, `"-1"`, `"1.5"`, `"abc"` and `""` all
 * mean "the operator typed something that is not a positive integer" — the
 * default is better than a pump with a 0 ms interval.
 */
function positiveInt(value: unknown): number | undefined {
	if (typeof value === "number") {
		return Number.isInteger(value) && value > 0 ? value : undefined;
	}
	if (typeof value !== "string") return undefined;
	const text = value.trim();
	// Digits only: `Number("1e3")` is 1000 and `Number(" 5 ")` is 5, but neither is
	// what "a positive integer" means in a settings file.
	if (!/^[0-9]+$/.test(text)) return undefined;
	const parsed = Number.parseInt(text, 10);
	return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function atLeast(value: number, floor: number): number {
	return value < floor ? floor : value;
}

/**
 * Resolve the pump's configuration.
 *
 * Precedence: the env kill switch is absolute (`PI_LEGION_LIVE_MIRROR=off` must
 * never be overridden by a settings block — it exists to stop a misbehaving pump
 * NOW); otherwise an env value beats an override, which beats the default, in the
 * classic "env overrides config" order. An invalid value at any level falls
 * through to the next one instead of disabling the feature.
 */
export function resolveLiveMirrorConfig(input?: {
	env?: Record<string, string | undefined>;
	overrides?: Partial<LiveMirrorConfig>;
}): LiveMirrorConfig {
	const env = input?.env ?? process.env;
	const overrides = input?.overrides;
	const switchWord = (env[LIVE_MIRROR_ENV] ?? "").trim().toLowerCase();
	const switchedOff = switchWord === "off" || switchWord === "0" || switchWord === "false";
	const enabled = switchedOff
		? false
		: typeof overrides?.enabled === "boolean"
			? overrides.enabled
			: true;
	const intervalMs = atLeast(
		positiveInt(env[LIVE_MIRROR_INTERVAL_ENV])
			?? positiveInt(overrides?.intervalMs)
			?? LIVE_MIRROR_INTERVAL_MS,
		LIVE_MIRROR_MIN_INTERVAL_MS,
	);
	const maxBytes = atLeast(
		positiveInt(env[LIVE_MIRROR_MAX_BYTES_ENV])
			?? positiveInt(overrides?.maxBytes)
			?? LIVE_MIRROR_MAX_BYTES,
		LIVE_MIRROR_MIN_MAX_BYTES,
	);
	return { enabled, intervalMs, maxBytes };
}

/**
 * `<dirname(sessionFile)>/remote/<basename-without-.jsonl>.mirror.json`.
 *
 * Next to (not on top of) `remoteMirrorPathFor`'s `<name>.jsonl`: that file is the
 * collect-time read-back and keeps being written by `createRemoteSessionReadback`;
 * this one only carries the pump's own bookkeeping.
 */
export function liveMirrorStatePathFor(sessionFile: string): string {
	const dir = path.dirname(sessionFile);
	const base = path.basename(sessionFile);
	const stem = base.endsWith(".jsonl") ? base.slice(0, -".jsonl".length) : base;
	return path.join(dir, "remote", `${stem.length > 0 ? stem : "child"}.mirror.json`);
}

// ── the remote side ────────────────────────────────────────────────────────

/** The remote side of one pump. Production = `machine.exec`; tests fake it. */
export interface LiveMirrorRemote {
	/** Total bytes of the remote file; `undefined` = that machine has no such file (yet). */
	size(): Promise<number | undefined>;
	/** Bytes `[from, from+max)`. Shorter than asked = end of file. */
	read(from: number, max: number): Promise<Buffer>;
	/** Release the connection. Never throws. */
	close(): void;
}

export type LiveMirrorMode = "on" | "off";

export interface LiveMirrorFacts {
	localPath: string;
	mode: LiveMirrorMode;
	/** Bytes in the local mirror. */
	bytes: number;
	/** How far into the remote file the mirror has consumed. */
	offset: number;
	remoteBytes?: number;
	/** `max(0, remoteBytes - offset)` — bytes that exist there but not here. */
	staleBytes: number;
	/** Epoch ms of the last tick that brought new bytes; 0 = never. */
	lastGrowthAt: number;
	/** Epoch ms of the last finished tick (ok or failed); 0 = never. */
	lastSyncAt: number;
	/** The last failure, cleared by the next success. */
	error?: string;
}

/**
 * Production remote: `machine.exec wc -c` + `tail -c +N`, one long-lived `hc connect`.
 *
 * `undefined` when `remoteDir` is unknown: guessing the path would produce a
 * `wc` against a directory that does not exist and turn "we do not know where the
 * child writes" into a permanent error row.
 *
 * `tail -c` is addressed in BYTES and its offset argument is 1-based, hence
 * `+${from + 1}`; the payload is taken from the BASE64 stdout WITHOUT a utf8 round
 * trip, because a transcript chunk can split a multi-byte character and any decode
 * would corrupt it.
 */
export function createLiveMirrorRemote(opts: {
	host: string;
	name: string;
	/** The launch's mirrored-argv dir on that machine. Absent ⇒ cannot know the path. */
	remoteDir?: string;
	clientFactory?: () => HcClient;
	timeoutS?: number;
}): LiveMirrorRemote | undefined {
	const remoteDir = typeof opts.remoteDir === "string" ? opts.remoteDir.trim() : "";
	if (remoteDir.length === 0) return undefined;
	const host = opts.host;
	const remotePath = path.posix.join(remoteDir, REMOTE_FILE_NAME);
	const timeoutS = positiveInt(opts.timeoutS) ?? DEFAULT_REMOTE_TIMEOUT_S;

	// One connection for the pump's whole lifetime: `hc connect` is a spawn, and a
	// spawn per 5 s tick would cost more than the pump transfers. `start()` is
	// awaited once and the promise is shared, so concurrent `size()`/`read()` calls
	// cannot race a second connection into existence.
	let client: HcClient | undefined;
	let started: Promise<void> | undefined;
	const connected = async (): Promise<HcClient> => {
		if (!client) {
			client = opts.clientFactory ? opts.clientFactory() : hcCliClient({ env: process.env });
		}
		if (!started) started = client.start();
		await started;
		return client;
	};

	return {
		async size(): Promise<number | undefined> {
			const active = await connected();
			// Transport failures are NOT caught here: the pump owns "never throws" and
			// turns them into `facts().error` with the child-safe policy.
			const result = await active.request<HcExecResult>("machine.exec", {
				on: host,
				argv: ["wc", "-c", remotePath],
				timeout: timeoutS,
			});
			if (result?.code !== 0) return undefined; // `wc` failed ⇒ the file is not there yet.
			const text = execResultText({ stdout: result?.stdout });
			const token = text.split(/\s+/)[0] ?? "";
			const value = Number.parseInt(token, 10);
			return Number.isFinite(value) && value >= 0 ? value : undefined;
		},
		async read(from: number, max: number): Promise<Buffer> {
			const active = await connected();
			const result = await active.request<HcExecResult>("machine.exec", {
				on: host,
				argv: ["tail", "-c", `+${from + 1}`, remotePath],
				timeout: timeoutS,
			});
			if (result?.code !== 0) {
				throw new Error(`tail -c +${from + 1} exited ${result?.code === undefined ? "without a status" : result.code}`);
			}
			// Base64 straight into a Buffer: no utf8 decode, so a chunk that splits a
			// multi-byte character stays byte-identical. A `truncated: true` result
			// (the core caps captured stdout at ~1 MiB) simply hands back fewer bytes
			// than asked, which the pump reads as "not yet" and continues next tick.
			const buffer = Buffer.from(typeof result?.stdout === "string" ? result.stdout : "", "base64");
			return buffer.subarray(0, max);
		},
		close(): void {
			try {
				client?.close();
			} catch {
				/* a closed connection is the goal, not an error */
			}
		},
	};
}

// ── the pump ───────────────────────────────────────────────────────────────

/**
 * Monotonic per-process sequence for temp names. `renameSync` is atomic but two
 * pumps writing the same directory must not share a temp path, so the name is
 * `<target>.<pid>-<n>.tmp`.
 */
let tempSequence = 0;

function tempPathFor(target: string): string {
	tempSequence += 1;
	return `${target}.${process.pid}-${tempSequence}.tmp`;
}

function errorText(error: unknown): string {
	if (error instanceof Error) return error.message.length > 0 ? error.message : error.name;
	const text = typeof error === "string" ? error : String(error);
	return text.trim().length > 0 ? text.trim() : "unknown error";
}

/**
 * Keep the trailing ≤ `maxBytes`, cut on a line boundary (invariant 3).
 *
 * The cut starts at the first newline at or after `length - maxBytes`, so the
 * kept slice begins on a whole line and — because the mirror only ever ends on a
 * newline — also ends on one. A buffer with no newline at all (impossible through
 * `commit`, harmless here) degrades to the plain tail.
 */
function trimToLineBoundaryTail(buffer: Buffer, maxBytes: number): Buffer {
	if (buffer.length <= maxBytes) return buffer;
	const start = buffer.length - maxBytes;
	const newline = buffer.indexOf(NEWLINE, start);
	return newline < 0 ? buffer.subarray(start) : buffer.subarray(newline + 1);
}

/**
 * The pump for ONE child's transcript.
 *
 * Not thread-safe by construction (it is owned by one orchestrator entry), but
 * `syncNow()` is safe to call while a tick is in flight only in the sense that
 * nothing crashes: the interval callback and the collect-time final sync are
 * sequentially awaited on the same object by the caller.
 */
export class LiveMirror {
	readonly localPath: string;

	private readonly remote: LiveMirrorRemote | undefined;
	private readonly intervalMs: number;
	private readonly maxBytes: number;
	private readonly chunkBytes: number;
	private readonly clock: () => number;
	private readonly onGrowth: ((facts: LiveMirrorFacts) => void) | undefined;
	private readonly warnSink: ((message: string) => void) | undefined;
	private readonly statePath: string | false;

	/** The mirror's content, as last written. The single source of truth for `bytes`. */
	private held: Buffer;
	/** Consumed remote bytes. Independent of {@link held}'s length (the cap trims it). */
	private offset: number;
	/** Last observed remote size; `undefined` until a `size()` answers. */
	private remoteBytes: number | undefined = undefined;
	private lastGrowthAt = 0;
	private lastSyncAt = 0;
	private error: string | undefined = undefined;
	private grew = false;
	private timer: ReturnType<typeof setInterval> | undefined;
	private runningFlag = false;
	private closed = false;
	/** Distinct warning texts already emitted (invariant: no retry storm). */
	private readonly warned = new Set<string>();

	constructor(opts: {
		localPath: string;
		/** Absent ⇒ `mode: "off"` (configured off): no network, facts say `off`. */
		remote?: LiveMirrorRemote;
		intervalMs?: number;
		maxBytes?: number;
		chunkBytes?: number;
		now?: () => number;
		/** Fired for every tick that GROWS the mirror (never for a no-op / failure). */
		onGrowth?: (facts: LiveMirrorFacts) => void;
		/** One warning sink. Distinct failure texts are warned ONCE each — no retry storm. */
		warn?: (message: string) => void;
		/** Persisted-facts path; `false` disables persistence. Default `liveMirrorStatePathFor(localPath→...)`. */
		statePath?: string | false;
	}) {
		this.localPath = opts.localPath;
		this.remote = opts.remote;
		// A non-positive value falls back to the default (a 0 ms interval or a 0-byte cap
		// is never what anyone meant). No floor is imposed HERE: the floors belong to
		// `resolveLiveMirrorConfig`, the entry point an operator's settings go through,
		// while the constructor is also the seam a test uses to pin the cap with a
		// deliberately tiny budget.
		this.intervalMs = positiveInt(opts.intervalMs) ?? LIVE_MIRROR_INTERVAL_MS;
		this.maxBytes = positiveInt(opts.maxBytes) ?? LIVE_MIRROR_MAX_BYTES;
		this.chunkBytes = positiveInt(opts.chunkBytes) ?? LIVE_MIRROR_CHUNK_BYTES;
		this.clock = opts.now ?? Date.now;
		this.onGrowth = opts.onGrowth;
		this.warnSink = opts.warn;
		this.statePath = opts.statePath === false
			? false
			: (opts.statePath ?? liveMirrorStatePathFor(opts.localPath));

		// Seed from disk: the orchestrator pre-creates `sessionFile` empty, and after a
		// restart the bytes a previous pump wrote are still there. `bytes` must report
		// what a reader would actually find, not what this instance wrote.
		let seed = Buffer.alloc(0);
		try {
			seed = fs.readFileSync(this.localPath);
		} catch {
			/* absent / unreadable: an empty mirror, created on the first commit */
		}
		this.held = seed;
		// Default `offset` = the local byte count, the state of "the mirror started at
		// remote byte 0 and was never trimmed" — which is what a fresh mirror is.
		this.offset = seed.length;
		const persisted = this.readPersistedOffset();
		if (persisted !== undefined) this.offset = persisted;
	}

	get running(): boolean {
		return this.runningFlag;
	}

	/** Current facts: no network, no disk. */
	facts(): LiveMirrorFacts {
		return this.snapshot();
	}

	/**
	 * One tick, awaited. NEVER throws, even when the remote does.
	 *
	 * Everything — `size()`, `read()`, the local write, the state file — is inside
	 * one try/catch, because this runs inside a launch and inside a collect: an
	 * exception here would turn a readable child into a failed run.
	 */
	async syncNow(): Promise<LiveMirrorFacts> {
		this.grew = false;
		try {
			await this.pump();
			this.error = undefined;
		} catch (error) {
			this.error = errorText(error);
			this.warnOnce(`live mirror ${this.localPath}: ${this.error}`);
		}
		this.lastSyncAt = this.clock();
		try {
			this.persist();
		} catch (error) {
			// Persistence is diagnostics, not the mirror: a read-only run dir must not
			// stop the bytes from flowing.
			this.warnOnce(`live mirror state ${this.statePath || "(disabled)"}: ${errorText(error)}`);
		}
		const facts = this.snapshot();
		if (this.grew) {
			this.grew = false;
			try {
				this.onGrowth?.(facts);
			} catch (error) {
				this.warnOnce(`live mirror onGrowth ${this.localPath}: ${errorText(error)}`);
			}
		}
		return facts;
	}

	/** Start the periodic pump (unref'd `setInterval`). Idempotent. */
	start(): void {
		if (this.runningFlag) return;
		this.runningFlag = true;
		const timer = setInterval(() => {
			// `syncNow()` never rejects; `void` keeps a lint honest about that.
			void this.syncNow();
		}, this.intervalMs);
		const unrefable = timer as unknown as { unref?: () => void };
		// `unref` when the host has it (Node does): a pump must never be the reason a
		// process stays alive after its run is over.
		if (typeof unrefable.unref === "function") unrefable.unref();
		this.timer = timer;
	}

	/** Stop the pump + `remote.close()`. Idempotent, never throws. */
	stop(): void {
		if (this.timer !== undefined) {
			try {
				clearInterval(this.timer);
			} catch {
				/* a handle the runtime already forgot */
			}
			this.timer = undefined;
		}
		this.runningFlag = false;
		if (this.closed) return;
		this.closed = true;
		try {
			this.remote?.close();
		} catch {
			/* the contract says close() never throws; a broken fake is contained too */
		}
	}

	// ── internals ────────────────────────────────────────────────────────

	/** One remote read pass. Throws on transport failure; `syncNow` contains it. */
	private async pump(): Promise<void> {
		const remote = this.remote;
		if (!remote) return; // mode "off": no network, by definition

		let remoteBytes: number | undefined;
		try {
			remoteBytes = await remote.size();
		} catch (error) {
			throw new Error(`remote size failed: ${errorText(error)}`);
		}
		if (remoteBytes === undefined) {
			// "That machine has no such file (yet)" is an observation, not a failure:
			// the child has not written its first line. Keep the offset; the next tick
			// asks again.
			this.remoteBytes = undefined;
			return;
		}
		this.remoteBytes = remoteBytes;

		if (remoteBytes < this.offset) {
			// Invariant 2: the file is shorter than what we consumed — a re-created
			// session (a retried launch, a truncated log). Appending would interleave two
			// transcripts; the mirror is REPLACED from the remote's first byte instead.
			const previous = this.offset;
			this.offset = 0;
			this.held = Buffer.alloc(0);
			this.warnOnce(
				`live mirror ${this.localPath}: the remote transcript shrank (${remoteBytes} bytes, mirror had consumed ${previous}); restarting from the remote's first byte`,
			);
			if (remoteBytes === 0) {
				// "Replaced from its first byte" when the remote is EMPTY means an empty file.
				// The read loop below has nothing to append, so without this the old transcript
				// would sit on disk forever while `facts().bytes` said 0 — a reader would keep
				// showing a child whose log no longer exists.
				try {
					this.writeLocalAtomic(this.held);
				} catch (error) {
					throw new Error(`local write ${this.localPath} failed: ${errorText(error)}`);
				}
			}
		}

		// Per-tick read budget: a machine that produced 100 MB while we were away must
		// not turn one tick into 400 round trips. The default is 16 × chunkBytes.
		let budget = Math.max(this.chunkBytes, this.maxBytes);
		while (this.offset < remoteBytes && budget > 0) {
			const want = Math.min(this.chunkBytes, remoteBytes - this.offset);
			if (want <= 0) break;
			let chunk: Buffer;
			try {
				chunk = await remote.read(this.offset, want);
			} catch (error) {
				throw new Error(`remote read at ${this.offset} failed: ${errorText(error)}`);
			}
			const bounded = chunk.length > want ? chunk.subarray(0, want) : chunk;
			if (bounded.length === 0) break; // nothing more to read
			budget -= bounded.length;
			const lineEnd = bounded.lastIndexOf(NEWLINE);
			if (lineEnd < 0) {
				// Invariant 7: not one byte of a partial line is written. The offset stays
				// put, so the next tick re-reads these bytes together with the newline that
				// is still to come.
				break;
			}
			const usable = bounded.subarray(0, lineEnd + 1);
			try {
				this.commit(usable);
			} catch (error) {
				throw new Error(`local write ${this.localPath} failed: ${errorText(error)}`);
			}
			this.offset += usable.length;
			// A short read is the core's own word for "end of file" (it may also have
			// capped its capture at ~1 MiB): stop asking this tick.
			if (bounded.length < want) break;
		}
	}

	/**
	 * Append to the in-memory mirror, trim the head when the cap is exceeded, and
	 * replace the visible file atomically.
	 *
	 * Transactional on purpose: the new buffer is built, WRITTEN, and only then adopted.
	 * Adopting first and writing second would leave the in-memory mirror holding bytes
	 * that never reached the disk (a full disk, a pre-created directory in the way), and
	 * the next successful tick would append them a second time.
	 */
	private commit(bytes: Buffer): void {
		if (bytes.length === 0) return;
		const joined = this.held.length === 0 ? Buffer.from(bytes) : Buffer.concat([this.held, bytes]);
		const next = joined.length > this.maxBytes ? trimToLineBoundaryTail(joined, this.maxBytes) : joined;
		this.writeLocalAtomic(next);
		this.held = next;
		this.lastGrowthAt = this.clock();
		this.grew = true;
	}

	/** Invariant 6: temp file in the same directory, then `renameSync`. */
	private writeLocalAtomic(content: Buffer): void {
		const dir = path.dirname(this.localPath);
		fs.mkdirSync(dir, { recursive: true });
		const temp = tempPathFor(this.localPath);
		try {
			fs.writeFileSync(temp, content, { mode: 0o600 });
			fs.renameSync(temp, this.localPath);
		} catch (error) {
			// A temp file is not a mirror: leaving one behind would litter the run dir (and
			// a reader that globs `*.jsonl*` could pick it up). Cleanup is best-effort; the
			// original failure is what the caller must see.
			try {
				fs.rmSync(temp, { force: true });
			} catch {
				/* already gone */
			}
			throw error;
		}
	}

	/** Offset from the persisted facts, when they describe THIS file. */
	private readPersistedOffset(): number | undefined {
		if (this.statePath === false) return undefined;
		try {
			const parsed = JSON.parse(fs.readFileSync(this.statePath, "utf8")) as Partial<LiveMirrorFacts> | null;
			if (!parsed || typeof parsed !== "object") return undefined;
			// A state file for a different path is a stale leftover (a reused run dir): its
			// offset would skip bytes in a transcript that never had them.
			if (parsed.localPath !== this.localPath) return undefined;
			const offset = parsed.offset;
			if (typeof offset !== "number" || !Number.isFinite(offset) || offset < 0) return undefined;
			return Math.floor(offset);
		} catch {
			// Absent, truncated or not JSON: the local byte count is the seed.
			return undefined;
		}
	}

	/** Write the facts row (temp + rename, so a reader never parses half a JSON). */
	private persist(): void {
		if (this.statePath === false) return;
		fs.mkdirSync(path.dirname(this.statePath), { recursive: true });
		const temp = tempPathFor(this.statePath);
		try {
			fs.writeFileSync(temp, `${JSON.stringify(this.snapshot())}\n`, { encoding: "utf8", mode: 0o600 });
			fs.renameSync(temp, this.statePath);
		} catch (error) {
			try {
				fs.rmSync(temp, { force: true });
			} catch {
				/* already gone */
			}
			throw error;
		}
	}

	private snapshot(): LiveMirrorFacts {
		const staleBytes = this.remoteBytes === undefined ? 0 : Math.max(0, this.remoteBytes - this.offset);
		return {
			localPath: this.localPath,
			mode: this.remote ? "on" : "off",
			bytes: this.held.length,
			offset: this.offset,
			...(this.remoteBytes !== undefined ? { remoteBytes: this.remoteBytes } : {}),
			staleBytes,
			lastGrowthAt: this.lastGrowthAt,
			lastSyncAt: this.lastSyncAt,
			...(this.error !== undefined ? { error: this.error } : {}),
		};
	}

	private warnOnce(message: string): void {
		const line = message.trim();
		if (line.length === 0) return;
		if (this.warned.has(line)) return;
		this.warned.add(line);
		try {
			this.warnSink?.(line);
		} catch {
			/* an unruly log sink is not a pump failure */
		}
	}
}
