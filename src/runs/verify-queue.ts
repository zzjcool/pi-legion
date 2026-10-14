/**
 * Tree-wide (machine-wide by default) concurrency limit for acceptance /
 * verify commands. Each verify (`npm test`, `tsc`, …) can peak near 1 GB, so N
 * workers verifying at once is the dominant memory spike.
 *
 * Cross-process semaphore: `limit` slot files `slot-<i>.lock` in a shared dir,
 * acquired with O_EXCL create. A holder records its pid; a slot whose holder
 * pid is dead (crash / SIGKILL) is reclaimed. Waiters poll; the wait is not
 * counted against the command timeout but is capped overall — past the cap the
 * command runs anyway (a hung-but-alive holder must not deadlock the tree).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { isPidAlive, readOwnerFile } from "./owner.ts";

export const VERIFY_CONCURRENCY_ENV = "PI_LEGION_VERIFY_CONCURRENCY";
export const VERIFY_QUEUE_MAX_MS_ENV = "PI_LEGION_VERIFY_QUEUE_MAX_MS";
export const VERIFY_LOCK_DIR_ENV = "PI_LEGION_VERIFY_LOCK_DIR";
export const DEFAULT_VERIFY_CONCURRENCY = 2;
export const DEFAULT_VERIFY_QUEUE_MAX_MS = 30 * 60_000;
const POLL_MS = 500;

export interface VerifyQueueConfig {
	limit: number;
	maxWaitMs: number;
	lockDir: string;
}

export function resolveVerifyQueueConfig(env: NodeJS.ProcessEnv = process.env): VerifyQueueConfig {
	const num = (key: string, fallback: number) => {
		const raw = env[key]?.trim();
		const n = raw ? Number(raw) : NaN;
		return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
	};
	const uid = typeof process.getuid === "function" ? process.getuid() : os.userInfo().username;
	return {
		limit: num(VERIFY_CONCURRENCY_ENV, DEFAULT_VERIFY_CONCURRENCY),
		maxWaitMs: num(VERIFY_QUEUE_MAX_MS_ENV, DEFAULT_VERIFY_QUEUE_MAX_MS),
		lockDir: env[VERIFY_LOCK_DIR_ENV]?.trim() || path.join(os.tmpdir(), `pi-legion-verify-${uid}`),
	};
}

export interface VerifyQueueEvent {
	phase: "waiting" | "acquired" | "released" | "overflow";
	command: string;
	waitedMs: number;
	holders: number;
	limit: number;
}

let listener: ((event: VerifyQueueEvent) => void) | undefined;
/** UI hook (root process): show "verify queued …" status. */
export function setVerifyQueueListener(fn: ((event: VerifyQueueEvent) => void) | undefined): void {
	listener = fn;
}

export interface VerifySlot {
	waitedMs: number;
	/** True when the overall wait cap expired and the command runs unthrottled. */
	overflow: boolean;
	release(): void;
}

function tryAcquire(file: string, command: string): boolean {
	try {
		const fd = fs.openSync(file, "wx", 0o600);
		fs.writeSync(fd, `${JSON.stringify({ pid: process.pid, host: os.hostname(), at: Date.now(), command: command.slice(0, 200) })}\n`);
		fs.closeSync(fd);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
	}
	// Reclaim a slot whose holder process is gone (crash, SIGKILL, reboot).
	const owner = readOwnerFile(file);
	const sameHost = !owner?.host || owner.host === os.hostname();
	const stale = owner ? sameHost && !isPidAlive(owner.pid) : isOldUnreadable(file);
	if (!stale) return false;
	try { fs.unlinkSync(file); } catch { return false; }
	return tryAcquire(file, command);
}

/** A slot file we cannot parse (torn write) is stale once it is a minute old. */
function isOldUnreadable(file: string): boolean {
	try { return Date.now() - fs.statSync(file).mtimeMs > 60_000; } catch { return true; }
}

function countHolders(dir: string, limit: number): number {
	let n = 0;
	for (let i = 0; i < limit; i++) if (fs.existsSync(path.join(dir, `slot-${i}.lock`))) n++;
	return n;
}

export async function acquireVerifySlot(command: string, config: VerifyQueueConfig = resolveVerifyQueueConfig(), signal?: AbortSignal): Promise<VerifySlot> {
	const noop: VerifySlot = { waitedMs: 0, overflow: false, release() {} };
	if (config.limit <= 0) return noop;
	try {
		fs.mkdirSync(config.lockDir, { recursive: true, mode: 0o700 });
	} catch {
		return noop; // cannot coordinate: never block verification on the lock dir
	}
	const start = Date.now();
	let announced = false;
	for (;;) {
		const offset = process.pid % config.limit; // spread first probes across slots
		for (let k = 0; k < config.limit; k++) {
			const file = path.join(config.lockDir, `slot-${(offset + k) % config.limit}.lock`);
			let got = false;
			try { got = tryAcquire(file, command); } catch { return noop; }
			if (!got) continue;
			const waitedMs = Date.now() - start;
			listener?.({ phase: "acquired", command, waitedMs, holders: countHolders(config.lockDir, config.limit), limit: config.limit });
			let released = false;
			const release = () => {
				if (released) return;
				released = true;
				process.removeListener("exit", release);
				try {
					if (readOwnerFile(file)?.pid === process.pid) fs.unlinkSync(file);
				} catch { /* already gone */ }
				listener?.({ phase: "released", command, waitedMs, holders: countHolders(config.lockDir, config.limit), limit: config.limit });
			};
			process.once("exit", release);
			return { waitedMs, overflow: false, release };
		}
		const waitedMs = Date.now() - start;
		if (waitedMs >= config.maxWaitMs || signal?.aborted) {
			listener?.({ phase: "overflow", command, waitedMs, holders: config.limit, limit: config.limit });
			return { waitedMs, overflow: true, release() {} };
		}
		if (!announced || waitedMs % 5_000 < POLL_MS) {
			announced = true;
			listener?.({ phase: "waiting", command, waitedMs, holders: countHolders(config.lockDir, config.limit), limit: config.limit });
		}
		await new Promise((resolve) => setTimeout(resolve, POLL_MS + Math.floor(Math.random() * 200)));
	}
}

/** Prefix for command output so the reader sees the queue wait. */
export function queueNote(slot: VerifySlot, limit: number): string {
	if (slot.overflow) return `[verify queue: waited ${Math.round(slot.waitedMs / 1000)}s, cap reached — ran without a slot]\n`;
	if (slot.waitedMs >= 1_000) return `[verify queue: waited ${Math.round(slot.waitedMs / 1000)}s for one of ${limit} slots]\n`;
	return "";
}

/** Read-only view of verify slot files for `/legion doctor`. */
export interface VerifySlotInfo {
	index: number;
	file: string;
	pid?: number;
	host?: string;
	command?: string;
	at?: number;
	alive?: boolean;
}

export function inspectVerifySlots(config: VerifyQueueConfig = resolveVerifyQueueConfig()): {
	config: VerifyQueueConfig;
	holders: VerifySlotInfo[];
	inUse: number;
} {
	const holders: VerifySlotInfo[] = [];
	if (config.limit <= 0) return { config, holders, inUse: 0 };
	for (let i = 0; i < config.limit; i++) {
		const file = path.join(config.lockDir, `slot-${i}.lock`);
		if (!fs.existsSync(file)) continue;
		let pid: number | undefined;
		let host: string | undefined;
		let command: string | undefined;
		let at: number | undefined;
		try {
			const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
			if (typeof raw.pid === "number") pid = raw.pid;
			if (typeof raw.host === "string") host = raw.host;
			if (typeof raw.command === "string") command = raw.command;
			if (typeof raw.at === "number") at = raw.at;
		} catch {
			const owner = readOwnerFile(file);
			pid = owner?.pid;
			host = owner?.host;
			at = owner?.at;
		}
		holders.push({
			index: i,
			file,
			pid,
			host,
			command,
			at,
			alive: typeof pid === "number" ? isPidAlive(pid) : undefined,
		});
	}
	return { config, holders, inUse: holders.length };
}
