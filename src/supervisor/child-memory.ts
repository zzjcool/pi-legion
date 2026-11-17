/**
 * Child process memory controls.
 *
 * A) V8 flags for child pi processes, delivered via NODE_OPTIONS:
 *    `--max-semi-space-size=1` (smaller young generation) and a soft
 *    `--max-old-space-size` cap. The host's original NODE_OPTIONS is carried in
 *    `PI_LEGION_HOST_NODE_OPTIONS` so the child restores it at extension load
 *    and the flags never leak into bash commands the child runs (tsc /
 *    npm test inheriting a low heap cap would crash).
 *
 * B) Memory gate: refuse a spawn when available memory (minus in-flight
 *    reservations) is below a floor, instead of letting the host OOM.
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";

export const CHILD_MAX_OLD_SPACE_ENV = "PI_LEGION_CHILD_MAX_OLD_SPACE_MB";
export const CHILD_SEMI_SPACE_ENV = "PI_LEGION_CHILD_SEMI_SPACE_MB";
export const HOST_NODE_OPTIONS_ENV = "PI_LEGION_HOST_NODE_OPTIONS";
export const MIN_FREE_MEM_ENV = "PI_LEGION_MIN_FREE_MEM_MB";
export const CHILD_RESERVE_ENV = "PI_LEGION_CHILD_RESERVE_MB";

/** Measured: an idle child is ~100 MB PSS, a long scout session peaks ~160 MB RSS. */
export const DEFAULT_CHILD_MAX_OLD_SPACE_MB = 1024;
export const DEFAULT_CHILD_SEMI_SPACE_MB = 1;
/**
 * Empirically: old-space below ~8 MB fails to start on Node v20/v24 (rc 133/134/139).
 * Clamp positive values up to this floor (#175); `0` remains the disable sentinel.
 */
export const MIN_CHILD_MAX_OLD_SPACE_MB = 16;
/** Floor of free memory that must remain after reserving the new child. */
export const DEFAULT_MIN_FREE_MEM_MB = 1024;
/** Per-child reservation for spawns that are still starting up. */
export const DEFAULT_CHILD_RESERVE_MB = 160;

function envMb(
	env: NodeJS.ProcessEnv,
	key: string,
	fallback: number,
	minPositive?: number,
): number {
	const raw = env[key]?.trim();
	if (!raw) return fallback;
	const n = Number(raw);
	if (!Number.isFinite(n) || n < 0) return fallback;
	if (n === 0) return 0; // 0 = disabled
	const floored = Math.floor(n);
	if (minPositive !== undefined && floored < minPositive) {
		console.error(
			`[pi-legion] ${key}=${raw} is below the usable minimum ${minPositive} MB; using ${minPositive}.`,
		);
		return minPositive;
	}
	return floored;
}

/** Child NODE_OPTIONS: host options + memory flags (each disabled by 0). */
export function childNodeOptions(env: NodeJS.ProcessEnv = process.env): string | undefined {
	const host = env.NODE_OPTIONS?.trim() ?? "";
	const flags: string[] = [];
	const semi = envMb(env, CHILD_SEMI_SPACE_ENV, DEFAULT_CHILD_SEMI_SPACE_MB);
	const old = envMb(
		env,
		CHILD_MAX_OLD_SPACE_ENV,
		DEFAULT_CHILD_MAX_OLD_SPACE_MB,
		MIN_CHILD_MAX_OLD_SPACE_MB,
	);
	if (semi > 0 && !/--max-semi-space-size/.test(host)) flags.push(`--max-semi-space-size=${semi}`);
	if (old > 0 && !/--max-old-space-size/.test(host)) flags.push(`--max-old-space-size=${old}`);
	const merged = [host, ...flags].filter(Boolean).join(" ");
	return merged || undefined;
}

/** Env entries the supervisor adds to every child pi process. */
export function childMemoryEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string | undefined> {
	const nodeOptions = childNodeOptions(env);
	if (nodeOptions === (env.NODE_OPTIONS?.trim() || undefined)) return {};
	return { NODE_OPTIONS: nodeOptions, [HOST_NODE_OPTIONS_ENV]: env.NODE_OPTIONS ?? "" };
}

/**
 * Called once in the child at extension load: put the host's NODE_OPTIONS back
 * so tool subprocesses (bash → tsc / npm test) do not inherit the child caps.
 */
export function restoreHostNodeOptions(env: NodeJS.ProcessEnv = process.env): void {
	if (!(HOST_NODE_OPTIONS_ENV in env)) return;
	const host = env[HOST_NODE_OPTIONS_ENV] ?? "";
	if (host) env.NODE_OPTIONS = host;
	else delete env.NODE_OPTIONS;
	delete env[HOST_NODE_OPTIONS_ENV];
}

// ── B) memory gate ────────────────────────────────────────────────────

/**
 * Raw inputs for the estimator. `null` = the file could not be read (not Linux,
 * no cgroup v2 limit, permission, …). Kept as text so tests can feed fixtures.
 */
export interface MemorySources {
	meminfoText: string | null;
	cgroupMaxText: string | null;
	cgroupCurrentText: string | null;
	cgroupStatText: string | null;
}

const INACTIVE_FILE = /^inactive_file (\d+)$/m;
const MEM_AVAILABLE = /MemAvailable:\s+(\d+)\s+kB/;

function readOrNull(path: string): string | null {
	try {
		return fs.readFileSync(path, "utf8");
	} catch {
		return null;
	}
}

/** Read the real sources; every failure degrades to `null`, never throws. */
export function readMemorySources(): MemorySources {
	return {
		meminfoText: readOrNull("/proc/meminfo"),
		cgroupMaxText: readOrNull("/sys/fs/cgroup/memory.max"),
		cgroupCurrentText: readOrNull("/sys/fs/cgroup/memory.current"),
		cgroupStatText: readOrNull("/sys/fs/cgroup/memory.stat"),
	};
}

/**
 * cgroup v2 headroom in MB, or `undefined` when there is no usable limit.
 *
 * `memory.current` counts **reclaimable page cache** as used: on a warm box it is
 * routinely 8-9 GiB of `file`/`inactive_file` while the kernel reports ~11 GiB
 * available. Subtracting `current` alone therefore claims the machine is nearly
 * out of memory whenever its cache is warm — which is exactly how the spawn gate
 * came to refuse children on a host with >11 GB free (the error said
 * `479 MB available` while `free -m` said 11.4 GiB).
 *
 * `inactive_file` is the reclaimable part, so adding it back makes this number
 * agree with `/proc/meminfo`'s `MemAvailable` and with `free -m`. Clamped to
 * `[0, limit]`: a `current` that overshoots the limit means "nothing free", never
 * a negative.
 *
 * No `memory.stat` ⇒ keep the old, deliberately conservative `limit - current`.
 * A missing file must degrade the estimate, never throw.
 */
export function cgroupAvailableMb(input: {
	maxText: string | null;
	currentText: string | null;
	statText: string | null;
}): number | undefined {
	const maxText = input.maxText?.trim();
	if (!maxText || maxText === "max") return undefined;
	const limit = Number(maxText);
	const current = Number(input.currentText?.trim() ?? "");
	if (!Number.isFinite(limit) || !Number.isFinite(current)) return undefined;
	const inactive = input.statText ? Number(INACTIVE_FILE.exec(input.statText)?.[1] ?? "") : Number.NaN;
	const reclaimable = Number.isFinite(inactive) ? inactive : 0;
	const freeBytes = Math.min(limit, Math.max(0, limit - current + reclaimable));
	return freeBytes / (1024 * 1024);
}

/**
 * The Linux-side estimate: the pessimistic minimum over every source we have.
 * `undefined` means "no Linux source available" (the caller then falls back).
 */
export function availableMbFromSources(sources: MemorySources): number | undefined {
	const candidates: number[] = [];
	const meminfo = sources.meminfoText ? MEM_AVAILABLE.exec(sources.meminfoText) : null;
	if (meminfo) candidates.push(Number(meminfo[1]) / 1024);
	const cgroup = cgroupAvailableMb({
		maxText: sources.cgroupMaxText,
		currentText: sources.cgroupCurrentText,
		statText: sources.cgroupStatText,
	});
	if (cgroup !== undefined) candidates.push(cgroup);
	if (candidates.length === 0) return undefined;
	return Math.floor(Math.max(0, Math.min(...candidates)));
}

/** Available memory in MB: cgroup limit (reclaim-aware), /proc/meminfo, macOS vm_stat, os.freemem. */
export function availableMemoryMb(): number {
	const linux = availableMbFromSources(readMemorySources());
	if (linux !== undefined) return linux;
	if (process.platform === "darwin") {
		try {
			const out = execFileSync("vm_stat", { encoding: "utf8", timeout: 2_000 });
			const page = Number(/page size of (\d+)/.exec(out)?.[1] ?? 4096);
			const pages = (k: string) => Number(new RegExp(`Pages ${k}:\\s+(\\d+)`).exec(out)?.[1] ?? 0);
			return Math.floor(((pages("free") + pages("inactive") + pages("speculative")) * page) / (1024 * 1024));
		} catch { /* fall through */ }
	}
	return Math.floor(Math.max(0, os.freemem() / (1024 * 1024)));
}

export interface MemoryGateConfig {
	minFreeMb: number;
	reserveMb: number;
}

export function resolveMemoryGateConfig(env: NodeJS.ProcessEnv = process.env): MemoryGateConfig {
	return {
		minFreeMb: envMb(env, MIN_FREE_MEM_ENV, DEFAULT_MIN_FREE_MEM_MB),
		reserveMb: envMb(env, CHILD_RESERVE_ENV, DEFAULT_CHILD_RESERVE_MB),
	};
}

export interface MemoryGateVerdict {
	ok: boolean;
	availableMb: number;
	requiredMb: number;
	message?: string;
}

/**
 * Refuse when `available - reserve × (inFlight + 1) < minFree`. `inFlight`
 * counts this supervisor's children still starting (their memory is not yet
 * visible in MemAvailable), so a parallel burst cannot all pass one reading.
 */
export function checkMemoryGate(input: { name: string; inFlight: number; config?: MemoryGateConfig; available?: () => number }): MemoryGateVerdict {
	const config = input.config ?? resolveMemoryGateConfig();
	if (config.minFreeMb <= 0) return { ok: true, availableMb: -1, requiredMb: 0 };
	const availableMb = (input.available ?? availableMemoryMb)();
	const requiredMb = config.minFreeMb + config.reserveMb * (input.inFlight + 1);
	if (availableMb >= requiredMb) return { ok: true, availableMb, requiredMb };
	return {
		ok: false,
		availableMb,
		requiredMb,
		message:
			`insufficient memory to start subagent ${input.name}: ${availableMb} MB available, ` +
			`${requiredMb} MB required (${MIN_FREE_MEM_ENV}=${config.minFreeMb} + ${config.reserveMb} MB per starting child × ${input.inFlight + 1}). ` +
			`Wait for running subagents to finish (or stop some with /legion stop) before retrying; ` +
			`set ${MIN_FREE_MEM_ENV}=0 to disable this gate.`,
	};
}
