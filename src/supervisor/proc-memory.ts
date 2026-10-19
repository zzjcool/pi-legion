/**
 * Per-process memory from `/proc` (Linux only).
 *
 * Only an `rpc` child has a process of its own, so only it can report a real
 * RSS. An `inprocess` child runs inside this host process: callers must report
 * the host RSS once instead of apportioning it across children (D2) — a
 * per-child number there would be fabricated, and the user makes decisions on
 * it.
 *
 * Degrades instead of throwing: a non-Linux host, an unknown or already-exited
 * pid, and an unparsable status file all yield `undefined`. A memory probe runs
 * on every UI refresh and must never break the panel it feeds — the same
 * contract `proc-tree.ts` follows.
 */

import { readFileSync } from "node:fs";

const PROC_ROOT = "/proc";

export interface ProcRss {
	/** Resident set size (`VmRSS`) in megabytes, rounded. */
	rssMb: number;
	/** Peak resident set size (`VmHWM`) in megabytes, rounded; absent when unreadable. */
	peakMb?: number;
}

/**
 * Pull `VmRSS` / `VmHWM` (both kB) out of one `/proc/<pid>/status` payload.
 * Other rows are ignored, as is a status file that carries no `VmRSS`.
 */
export function parseProcStatus(text: string): ProcRss | undefined {
	let rssKb: number | undefined;
	let peakKb: number | undefined;
	for (const raw of text.split("\n")) {
		const match = /^(VmRSS|VmHWM):\s+(\d+)\s+kB$/.exec(raw.trim());
		if (!match) continue;
		const kb = Number(match[2]);
		if (!Number.isFinite(kb)) continue;
		if (match[1] === "VmRSS") rssKb = kb;
		else peakKb = kb;
	}
	if (rssKb === undefined) return undefined;
	return {
		rssMb: Math.round(rssKb / 1024),
		...(peakKb !== undefined ? { peakMb: Math.round(peakKb / 1024) } : {}),
	};
}

/**
 * Resident / peak memory for one pid, or `undefined` when it cannot be read.
 *
 * Never throws: a memory probe runs on every UI refresh, and a pid that exits
 * between an `isAlive()` check and this read is the normal case, not an error
 * (`proc-tree.ts` records the same race).
 */
export function readProcRss(pid: number): ProcRss | undefined {
	if (process.platform !== "linux") return undefined;
	if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
	let text: string;
	try {
		text = readFileSync(`${PROC_ROOT}/${pid}/status`, "utf8");
	} catch {
		// Processes can exit between an `isAlive()` check and this read.
		return undefined;
	}
	return parseProcStatus(text);
}
