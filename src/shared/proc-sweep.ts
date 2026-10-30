/**
 * Tree-wide process cleanup for spawned shell commands (#310).
 *
 * Every command runner in this repo spawns a shell (`bash -lc ...`, or
 * `timeout ... bash -lc ...`). Killing that direct child reaps only the shell:
 * a grandchild (`cmd &`, a `node --test` worker, a dev server) is reparented to
 * init and keeps running — a real 44-minute `node --test` outlived its run with
 * `ppid=1`. Both execution points (`src/runs/acceptance.ts`,
 * `src/extension/legion-tools.ts`) now spawn **detached** (own process group)
 * and, when *we* end a command (timeout, output cap, abort), sweep the whole
 * group plus every descendant enumerated from procfs before resolving.
 *
 * A normal exit is deliberately never swept: `cmd &` in a verification command
 * is a legal way to leave a background process behind, and killing it would
 * break that usage. Those leftovers are reported instead (see
 * `survivingDescendants`). A command that has *exited* while an unreaped
 * background job keeps its pipes open is a normal exit too — the runners say so
 * explicitly by reading `child.exitCode` before their own deadline counts as a
 * timeout.
 *
 * Contract:
 *  - never throws — every syscall is guarded, and `sweepProcessTree` resolves
 *    even for a pid that never existed (`ESRCH`) or that belongs to someone
 *    else (`EPERM`);
 *  - `rootPid` is watched like any descendant: after an `exec` it is the only
 *    process there is, so an escalation gated on "a descendant survived" would
 *    let a root that ignores the first signal live on while reporting
 *    `survivors: []`;
 *  - `/proc` unavailable (non-Linux) degrades to "signal the process group",
 *    which is still the correct group because the caller spawned detached;
 *  - the returned promise is the completion signal: when it settles, the grace
 *    period and the `SIGKILL` escalation have already run, so a caller that
 *    reports a timeout knows the descendants are gone. That is up to
 *    `graceMs + killAfterMs` of extra latency (2.5s with the defaults), paid
 *    only by the paths that end a command themselves — see
 *    `docs/contracts/proc-sweep-v1.md`.
 */

import { readFileSync, readdirSync } from "node:fs";
import { enumerateDescendants, parseProcStatLine } from "../supervisor/proc-tree.ts";
import type { DescendantInfo } from "../supervisor/types.ts";

export type SweepResult = {
	/** Successful deliveries of the first signal (a process group counts once). */
	signaled: number;
	/** Successful `SIGKILL` deliveries (the process group counts once, like `signaled`). */
	killed: number;
	/** Pids still alive after the `SIGKILL` escalation (root included), ascending. */
	survivors: number[];
};

export interface SweepOptions {
	/** First signal, default `SIGTERM`. */
	signal?: NodeJS.Signals;
	/** How long the first signal gets before escalation, default 2000ms. */
	graceMs?: number;
	/** How long `SIGKILL` gets before survivors are listed, default 500ms. */
	killAfterMs?: number;
}

const DEFAULT_SIGNAL: NodeJS.Signals = "SIGTERM";
const DEFAULT_GRACE_MS = 2_000;
const DEFAULT_KILL_AFTER_MS = 500;
/** Aliveness poll while a grace/kill window is open — short enough to exit early. */
const POLL_MS = 25;
const PROC_ROOT = "/proc";

function usablePid(pid: unknown): pid is number {
	return typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0;
}

function nonNegative(value: number | undefined, fallback: number): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return fallback;
	return Math.floor(value);
}

/** `setTimeout` wrapper that must keep the loop alive (an unref'ed timer would let node drain). */
function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Signal one pid or negative process-group id. A dead, reaped or
 * permission-denied target is a normal outcome here, never an error. Signal `0`
 * is the existence probe: no signal is delivered.
 */
function signalTarget(target: number, signal: NodeJS.Signals | 0): boolean {
	try {
		process.kill(target, signal);
		return true;
	} catch {
		return false;
	}
}

/**
 * Whether a pid can still be signalled. A zombie counts as gone: it has already
 * exited and only waits for its (now dead) parent to be reaped, so treating it
 * as a survivor would report a clean sweep as a leak.
 */
function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
	} catch (error) {
		// EPERM = the process exists but belongs to another user.
		return (error as NodeJS.ErrnoException | null)?.code === "EPERM";
	}
	return !isZombie(pid);
}

function isZombie(pid: number): boolean {
	let stat: string;
	try {
		stat = readFileSync(`${PROC_ROOT}/${pid}/stat`, "utf8");
	} catch {
		return false;
	}
	const commEnd = stat.lastIndexOf(")");
	if (commEnd < 0) return false;
	// The state field is the first field after the parenthesised comm.
	return stat.slice(commEnd + 1).trimStart().startsWith("Z");
}

function safeDescendants(rootPid: number): DescendantInfo[] {
	try {
		return enumerateDescendants(rootPid);
	} catch {
		return [];
	}
}

/**
 * Pids whose process group is `pgid` (excluding the group leader itself).
 *
 * This is what makes leftovers visible *after* the shell exited: the moment
 * `bash -lc "cmd &"` is reaped its children are reparented to init, so the
 * `/proc` parent chain from the shell no longer reaches them, while their
 * process group id still names the shell.
 */
function groupMembers(pgid: number): number[] {
	if (process.platform !== "linux" || !usablePid(pgid)) return [];
	let entries: string[];
	try {
		entries = readdirSync(PROC_ROOT);
	} catch {
		return [];
	}
	const pids: number[] = [];
	for (const entry of entries) {
		if (!/^\d+$/.test(entry)) continue;
		let line: string;
		try {
			line = readFileSync(`${PROC_ROOT}/${entry}/stat`, "utf8");
		} catch {
			// Processes can exit between readdir and reading their stat file.
			continue;
		}
		const stat = parseProcStatLine(line);
		if (stat && stat.pgid === pgid && stat.pid !== pgid) pids.push(stat.pid);
	}
	return pids;
}

/**
 * Live (non-zombie) members of `groupTarget`, leader excluded — `null` where
 * there is no procfs to enumerate and only the `kill(-pgid, 0)` probe is left.
 *
 * This is the "is there anything left to escalate against?" question, asked
 * after the grace expired. Going through procfs so that a **zombie** counts as
 * gone keeps it consistent with `isAlive`: an exited process only waits to be
 * reaped and `kill(-pgid, 0)` still succeeds for it — counting that as a live
 * group would make every clean sweep report a `SIGKILL` it never needed to
 * send. The group leader is not listed here; it is in `watched`, so it already
 * answered for itself.
 */
function liveGroupMembers(groupTarget: number): number[] | null {
	if (process.platform !== "linux" || groupTarget >= 0) return null;
	return groupMembers(-groupTarget).filter(isAlive);
}

/** Poll `pids` until all are gone or `timeoutMs` elapses; returns the survivors. */
async function waitForDeath(pids: Set<number>, timeoutMs: number): Promise<number[]> {
	const deadline = Date.now() + timeoutMs;
	let alive = [...pids].filter(isAlive);
	while (alive.length > 0) {
		const remaining = deadline - Date.now();
		if (remaining <= 0) break;
		await sleep(Math.min(POLL_MS, remaining));
		alive = alive.filter(isAlive);
	}
	return alive;
}

/**
 * Kill `rootPid`'s process group and every descendant it can still reach.
 *
 * Order: process group first (one syscall reaches every child that stayed in
 * it, `cmd &` included), then each enumerated descendant (`setsid`/`setpgid`
 * escapees), then `SIGKILL` for whatever ignored the first signal. The
 * descendant snapshot is taken *before* the first signal on purpose: once the
 * shell dies its children are reparented to init and no longer reachable from
 * `rootPid`'s `/proc` parent chain.
 */
export async function sweepProcessTree(
	rootPid: number,
	opts: SweepOptions = {},
): Promise<SweepResult> {
	if (!usablePid(rootPid)) return { signaled: 0, killed: 0, survivors: [] };

	const firstSignal = opts.signal ?? DEFAULT_SIGNAL;
	const graceMs = nonNegative(opts.graceMs, DEFAULT_GRACE_MS);
	const killAfterMs = nonNegative(opts.killAfterMs, DEFAULT_KILL_AFTER_MS);

	const known = new Set<number>();
	for (const descendant of safeDescendants(rootPid)) known.add(descendant.pid);

	// Process groups are the POSIX grouping both runners rely on. On Windows
	// there is no group to signal, so the direct child is signalled instead —
	// exactly what the pre-#310 code did, so nothing regresses there.
	const groupTarget = process.platform === "win32" ? rootPid : -rootPid;
	// `rootPid` is watched as well, on every platform: it is the process the
	// caller actually spawned, and after an `exec` it is the *only* process
	// there is. Watching descendants alone meant a root that installs a SIGTERM
	// handler and never forks fell through the escalation at the bottom of this
	// function — no SIGKILL, and `survivors: []`, i.e. a timeout that resolved
	// while the process lived on.
	const watched = new Set([rootPid, ...known]);

	let signaled = 0;
	if (signalTarget(groupTarget, firstSignal)) signaled += 1;
	for (const pid of known) {
		if (signalTarget(pid, firstSignal)) signaled += 1;
	}

	// Grace. Everything that dies on the first signal makes this return early,
	// so the common case does not pay the full window.
	let doomed = await waitForDeath(watched, graceMs);
	// A descendant that forked during the grace period is still reachable from
	// the live shell; sweep it too rather than leaving a fresh orphan behind.
	for (const descendant of safeDescendants(rootPid)) {
		if (known.has(descendant.pid)) continue;
		known.add(descendant.pid);
		watched.add(descendant.pid);
		if (isAlive(descendant.pid)) doomed.push(descendant.pid);
	}

	let killed = 0;
	// The group is SIGKILLed whenever it still has a live member, not only when
	// an *enumerated* pid survived: a member reachable only by its pgid (a
	// grandchild reparented to init mid-grace) is covered by this clause alone.
	const groupOnly = liveGroupMembers(groupTarget);
	const escalateGroup = groupOnly === null
		? signalTarget(groupTarget, 0)
		: groupOnly.length > 0;
	// Everything the SIGKILL targets has to be waited for afterwards, group-only
	// members included. Settling the promise while one of them is still on its
	// way out would make "the tree is gone" a guess, and `survivors` a lie.
	const condemned = new Set(doomed);
	for (const pid of groupOnly ?? []) condemned.add(pid);
	if (escalateGroup || condemned.size > 0) {
		if (signalTarget(groupTarget, "SIGKILL")) killed += 1;
		for (const pid of condemned) {
			if (signalTarget(pid, "SIGKILL")) killed += 1;
		}
		if (condemned.size > 0) await waitForDeath(condemned, killAfterMs);
	}

	const survivors = [...watched].filter(isAlive).sort((a, b) => a - b);
	return { signaled, killed, survivors };
}

/**
 * One-line, length-capped command summary for leftover-process warnings: a
 * verify command is frequently several lines long (`a && b && c`).
 */
export function commandSummary(command: string, maxLength = 120): string {
	const flat = command.replace(/\s+/g, " ").trim();
	return flat.length <= maxLength ? flat : `${flat.slice(0, maxLength - 1)}…`;
}

/**
 * Descendant pids of `rootPid` that are still alive — the purely observational
 * probe used on the **normal-exit** path, where a leftover is reported but
 * never killed. Reaches leftovers that were already reparented to init by
 * scanning `rootPid`'s (detached) process group as well, because the `/proc`
 * parent chain from a reaped shell no longer links to them.
 */
export function survivingDescendants(rootPid: number): number[] {
	if (!usablePid(rootPid)) return [];
	const pids = new Set<number>();
	for (const descendant of safeDescendants(rootPid)) pids.add(descendant.pid);
	for (const pid of groupMembers(rootPid)) pids.add(pid);
	return [...pids].filter(isAlive).sort((a, b) => a - b);
}
