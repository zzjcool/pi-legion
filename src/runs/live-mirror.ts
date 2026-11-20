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
 *   - **Incremental appends, atomic where it matters.** The steady state is ONE
 *     `O_APPEND` write of exactly the new bytes: the inode does NOT change, so the
 *     repository's incremental parser (`sessionFileStillValid`, keyed on
 *     `dev`/`ino`, and `parseSessionFileCached`, keyed on size+mtime) keeps its
 *     cache — replacing the file every tick made every consumer re-parse up to
 *     `maxBytes` every 5 s. An append can only ever expose a torn LAST line,
 *     which is the property a live local child's own transcript already has and
 *     `parseSessionFile` already drops (#36). The stricter `<target>.<pid>-<n>.tmp`
 *     + `renameSync` replace is kept where a rewrite is unavoidable: the cap trim
 *     and the shrink reset.
 *   - **Complete lines only.** Bytes after the last `\n` of what was read are NOT
 *     written; they are read again on the next tick, once the newline exists. The
 *     local file therefore ends on a complete line, which is what a JSONL reader
 *     needs to make progress.
 *   - **The pump can never hurt the child.** `syncNow()` swallows everything: a
 *     dead connection, a missing remote command, a full disk. It records the
 *     message in `facts().error` and tails off; it never throws into `launch`,
 *     `collect` or a status render. The same text is warned once, not every tick.
 *     Ticks are SERIALISED (a periodic tick and a settle's final sync must never
 *     share one offset) and a final sync carries a deadline, so a half-dead
 *     machine cannot hold a `collect` open.
 *
 * One row size the design has to bend for: a single remote line longer than the
 * read window. Invariant 7 taken literally would say "wait for the newline", and
 * for a row longer than `chunkBytes` that wait never ends — a real transcript has
 * 256 KiB+ rows (a giant tool result), so the pump GROWS the window instead, up to
 * `maxBytes`. Only a row bigger than the mirror's own cap is written torn, because
 * refusing it would mean never mirroring anything again.
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
 * The persisted facts of a child's live mirror, or `undefined` when there is
 * nothing trustworthy to read.
 *
 * The row lives at `liveMirrorStatePathFor(sessionFile)`, i.e. under
 * `<runDir>/remote/` — a path that only the pump ever writes. Its ABSENCE is the
 * normal case for a local child, so "no file" is silence, not a warning.
 *
 * Every failure mode degrades to `undefined` for the same reason: two callers read
 * this (the status block, #411 §4; and the stall detector's growth gate, #441-B),
 * and a half-written or hand-edited JSON must not turn a diagnostic into an
 * exception — nor into a fabricated "no growth" verdict. The shape is checked field
 * by field because a `bytes` that is a string would render as `mirror=ok(abc
 * bytes)` and a `lastGrowthAt` that is a string would compare as `NaN`.
 *
 * Lives here, not in the extension layer, because `legion-tools` (#441-B) and the
 * status renderer must read the SAME row with the SAME rules: two readers, one
 * parser (the growth gate must not disagree with the `mirror=` marker).
 */
export function readMirrorFacts(sessionFile: string): LiveMirrorFacts | undefined {
	if (typeof sessionFile !== "string" || sessionFile.length === 0) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(fs.readFileSync(liveMirrorStatePathFor(sessionFile), "utf8"));
	} catch {
		return undefined;
	}
	if (!parsed || typeof parsed !== "object") return undefined;
	const row = parsed as Record<string, unknown>;
	const mode = row.mode;
	if (mode !== "on" && mode !== "off") return undefined;
	const bytes = row.bytes;
	const staleBytes = row.staleBytes;
	// Byte counts: finite and non-negative (`LiveMirror` floors `staleBytes` at 0,
	// so a negative here means this is not a pump row at all).
	if (!isByteCount(bytes) || !isByteCount(staleBytes)) return undefined;
	const offset = isByteCount(row.offset) ? row.offset : 0;
	const lastGrowthAt = isByteCount(row.lastGrowthAt) ? row.lastGrowthAt : 0;
	const lastSyncAt = isByteCount(row.lastSyncAt) ? row.lastSyncAt : 0;
	const error = typeof row.error === "string" && row.error.length > 0 ? row.error : undefined;
	return {
		localPath: typeof row.localPath === "string" ? row.localPath : sessionFile,
		mode,
		bytes,
		offset,
		...(isByteCount(row.remoteBytes) ? { remoteBytes: row.remoteBytes } : {}),
		staleBytes,
		lastGrowthAt,
		lastSyncAt,
		...(error !== undefined ? { error } : {}),
	};
}

/** A plausible byte count: a finite, non-negative number. */
function isByteCount(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
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
	/** Last size this reader ever saw; see the `code !== 0` rule inside `size()`. */
	let lastSeen = 0;
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
			if (result?.code !== 0) {
				// `wc` failing is "that file is not there yet" only BEFORE it has ever been
				// seen. After a success the same answer means the transcript went away (or the
				// command itself failed); turning that into `undefined` would report
				// `mirror=ok(0 bytes)` while nothing is being mirrored — the exact "looks fine,
				// is not" shape this marker exists to remove.
				if (lastSeen > 0) {
					throw new Error(`wc -c ${remotePath} exited ${result?.code === undefined ? "without a status" : result.code}`);
				}
				return undefined; // `wc` failed ⇒ the file is not there yet.
			}
			const text = execResultText({ stdout: result?.stdout });
			const token = text.split(/\s+/)[0] ?? "";
			const value = Number.parseInt(token, 10);
			if (!Number.isFinite(value) || value < 0) return undefined;
			lastSeen = value;
			return value;
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
	/** Tail of the tick chain: one tick at a time (see {@link syncNow}). */
	private chain: Promise<unknown> = Promise.resolve();
	/** Set by {@link stop}: a tick already in flight writes nothing more. */
	private stopped = false;
	/**
	 * The next commit must REPLACE the file instead of appending to it.
	 *
	 * True after a shrink reset: the local file still holds the previous (longer)
	 * transcript, so appending the new one would interleave two sessions.
	 */
	private replaceNext = false;
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
	async syncNow(opts: { deadlineMs?: number } = {}): Promise<LiveMirrorFacts> {
		// SERIALISED. A periodic tick and a settle's final sync can overlap — the
		// interval does not pause for a caller — and two ticks sharing one `offset`
		// would append the same bytes twice and then read the over-run as "the remote
		// shrank", i.e. reset a healthy transcript on itself. Chaining makes the second
		// caller wait its turn instead.
		const run = this.chain.then(
			() => this.tick(opts),
			() => this.tick(opts),
		);
		this.chain = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	/** One serialised tick. Never rejects; `opts.deadlineMs` bounds the round trips. */
	private async tick(opts: { deadlineMs?: number }): Promise<LiveMirrorFacts> {
		this.grew = false;
		try {
			await this.pump(opts.deadlineMs === undefined ? undefined : this.clock() + Math.max(1, opts.deadlineMs));
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
		if (this.remote === undefined) {
			// `mode: "off"`: the ONE thing a disabled pump still owes the UI is the facts
			// row that says so. Written once here, and no timer is scheduled at all — a
			// disabled feature must not tick every interval forever just to rewrite one
			// unchanged line.
			try {
				this.persist();
			} catch {
				/* diagnostics only, exactly like a tick */
			}
			return;
		}
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
		// A tick may still be in flight (`clearInterval` cannot cancel an awaited
		// `hc` round trip). `stopped` is what makes "stop means stop": the in-flight
		// tick finishes its bookkeeping but writes nothing more.
		this.stopped = true;
		if (this.closed) return;
		this.closed = true;
		try {
			this.remote?.close();
		} catch {
			/* the contract says close() never throws; a broken fake is contained too */
		}
	}

	// ── internals ────────────────────────────────────────────────────────

	/** One remote read pass. Throws on transport failure; `tick` contains it. */
	private async pump(deadline?: number): Promise<void> {
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
			this.replaceNext = true;
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
		/**
		 * Window size for the NEXT read.
		 *
		 * Normally one `chunkBytes`. It GROWS when a window came back with no newline at
		 * all, because that answer means "a single remote line is longer than this
		 * window" — not "wait for more". A real transcript contains 256 KiB+ rows (a
		 * giant tool result), so shrinking back and retrying at the same size would stall
		 * the pump at `offset` forever, silently, which is worse than the torn line this
		 * invariant exists to avoid.
		 */
		let window = this.chunkBytes;
		while (this.offset < remoteBytes && budget > 0) {
			if (deadline !== undefined && this.clock() >= deadline) break;
			const want = Math.min(window, remoteBytes - this.offset);
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
				// put, so the next attempt re-reads these bytes together with the newline
				// that is still to come.
				if (bounded.length >= this.maxBytes) {
					// The row is bigger than the mirror's own cap. Refusing it would mean never
					// mirroring anything again, so the cap wins over the line boundary: the
					// bytes are kept (torn) and the rest of the row joins them next time.
					try {
						this.commit(bounded);
					} catch (error) {
						throw new Error(`local write ${this.localPath} failed: ${errorText(error)}`);
					}
					this.offset += bounded.length;
					window = this.chunkBytes;
					continue;
				}
				if (bounded.length < want) break; // short read: the row is still being written
				window = Math.min(this.maxBytes, Math.max(window * 2, bounded.length * 2));
				continue;
			}
			const usable = bounded.subarray(0, lineEnd + 1);
			try {
				this.commit(usable);
			} catch (error) {
				throw new Error(`local write ${this.localPath} failed: ${errorText(error)}`);
			}
			this.offset += usable.length;
			window = this.chunkBytes;
			// A short read is the core's own word for "end of file" (it may also have
			// capped its capture at ~1 MiB): stop asking this tick.
			if (bounded.length < want) break;
		}
	}

	/**
	 * Append to the in-memory mirror, trim the head when the cap is exceeded, and land
	 * it on disk.
	 *
	 * Transactional on purpose: the new buffer is built, WRITTEN, and only then adopted.
	 * Adopting first and writing second would leave the in-memory mirror holding bytes
	 * that never reached the disk (a full disk, a pre-created directory in the way), and
	 * the next successful tick would append them a second time.
	 */
	private commit(bytes: Buffer): void {
		if (bytes.length === 0 || this.stopped) return;
		const joined = this.held.length === 0 ? Buffer.from(bytes) : Buffer.concat([this.held, bytes]);
		if (this.replaceNext || joined.length > this.maxBytes) {
			const next = joined.length > this.maxBytes ? trimToLineBoundaryTail(joined, this.maxBytes) : joined;
			this.writeLocalAtomic(next);
			this.held = next;
			this.replaceNext = false;
		} else {
			this.appendLocal(bytes);
			this.held = joined;
		}
		this.lastGrowthAt = this.clock();
		this.grew = true;
	}

	/**
	 * The steady-state write: ONE `O_APPEND` write of the new bytes, so the inode does
	 * not change.
	 *
	 * Inode stability is not cosmetic. `session.ts`'s incremental parser keys its cache
	 * on `(size, mtimeMs)` and treats a changed `dev`/`ino` as "the file was rewritten"
	 * (`sessionFileStillValid`): replacing the file every 5 s made every consumer — the
	 * panel's `progressFromSessionFile` included — re-parse the whole mirror (up to
	 * `maxBytes`) on every tick. Appending keeps that cache warm.
	 *
	 * `O_APPEND` + one `write(2)` also means no other writer can interleave and a reader
	 * can only ever see a torn LAST line — exactly the property a live local child's own
	 * transcript has, which `parseSessionFile` already drops (#36). The stricter
	 * "replace, never append" rule is kept where it is actually needed: the cap trim and
	 * the shrink reset replace the file ({@link writeLocalAtomic}).
	 */
	private appendLocal(bytes: Buffer): void {
		fs.mkdirSync(path.dirname(this.localPath), { recursive: true });
		fs.appendFileSync(this.localPath, bytes, { mode: 0o600 });
	}

	/** Invariant 6: temp file in the same directory, then `renameSync`. */
	private writeLocalAtomic(content: Buffer): void {
		if (this.stopped) return;
		const dir = path.dirname(this.localPath);
		fs.mkdirSync(dir, { recursive: true });
		const temp = tempPathFor(this.localPath);
		try {
			fs.writeFileSync(temp, content, { mode: 0o600 });
			fs.renameSync(temp, this.localPath);
		} catch (error) {
			// A temp file is not a mirror: leaving one behind would litter the run dir.
			// Cleanup is best-effort; the original failure is what the caller must see.
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
		if (this.statePath === false || this.stopped) return;
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
