import { readFileSync, readdirSync } from "node:fs";
import type { DescendantInfo } from "./types.ts";

const PROC_ROOT = "/proc";

interface ProcStat {
	pid: number;
	ppid: number;
	pgid: number;
}

function parseStatId(value: string | undefined): number | null {
	if (value === undefined || !/^\d+$/.test(value)) return null;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : null;
}

/** Parse the PID, parent PID, and process group from one Linux proc stat row. */
export function parseProcStatLine(
	line: string,
): { pid: number; ppid: number; pgid: number } | null {
	const pidEnd = line.indexOf(" ");
	if (pidEnd <= 0 || line[pidEnd + 1] !== "(") return null;
	const pid = parseStatId(line.slice(0, pidEnd));
	if (pid === null) return null;

	// comm is parenthesized but may itself contain spaces and parentheses.
	const commEnd = line.lastIndexOf(")");
	if (commEnd <= pidEnd + 1) return null;
	const fields = line.slice(commEnd + 1).trim().split(/\s+/);
	if (fields.length < 3 || !fields[0]) return null;
	const ppid = parseStatId(fields[1]);
	const pgid = parseStatId(fields[2]);
	if (ppid === null || pgid === null) return null;

	return { pid, ppid, pgid };
}

/**
 * Enumerate every process whose /proc parent chain leads to rootPid.
 * Descendants are returned breadth-first and never include rootPid itself.
 */
export function enumerateDescendants(rootPid: number): DescendantInfo[] {
	if (process.platform !== "linux" || !Number.isSafeInteger(rootPid) || rootPid <= 0) {
		return [];
	}

	let entries: string[];
	try {
		entries = readdirSync(PROC_ROOT);
	} catch {
		return [];
	}

	const processes = new Map<number, ProcStat>();
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
		if (stat) processes.set(stat.pid, stat);
	}

	if (!processes.has(rootPid)) return [];

	const children = new Map<number, number[]>();
	for (const stat of processes.values()) {
		const siblings = children.get(stat.ppid);
		if (siblings) siblings.push(stat.pid);
		else children.set(stat.ppid, [stat.pid]);
	}

	const descendants: DescendantInfo[] = [];
	const queue = [rootPid];
	const visited = new Set(queue);
	for (let index = 0; index < queue.length; index += 1) {
		const parentPid = queue[index];
		if (parentPid === undefined) continue;
		for (const pid of children.get(parentPid) ?? []) {
			if (visited.has(pid)) continue;
			visited.add(pid);
			queue.push(pid);
			const stat = processes.get(pid);
			if (stat) descendants.push({ pid: stat.pid, pgid: stat.pgid });
		}
	}
	return descendants;
}

/** Return this process's process group ID when Linux procfs is available. */
export function currentPgid(): number | null {
	if (process.platform === "win32") return null;
	try {
		return parseProcStatLine(readFileSync(`${PROC_ROOT}/self/stat`, "utf8"))?.pgid ?? null;
	} catch {
		return null;
	}
}
