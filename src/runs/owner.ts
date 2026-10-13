/**
 * Process-ownership markers for run dirs and RPC child temp dirs (#38).
 *
 * The parent writes its pid next to the state it owns. A later session's
 * startup sweep only touches state whose owner pid is gone, so concurrent pi
 * sessions in the same project never clean up each other's live data.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const RUN_OWNER_FILE = "owner.json";
export const TEMP_OWNER_FILE = ".owner";

export interface OwnerRecord {
	pid: number;
	host: string;
	at: number;
}

export function writeOwnerFile(file: string, pid: number = process.pid): void {
	const record: OwnerRecord = { pid, host: os.hostname(), at: Date.now() };
	fs.writeFileSync(file, `${JSON.stringify(record)}\n`, { mode: 0o600 });
}

export function writeRunOwner(runDir: string, pid: number = process.pid): void {
	writeOwnerFile(path.join(runDir, RUN_OWNER_FILE), pid);
}

export function readOwnerFile(file: string): OwnerRecord | undefined {
	try {
		const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<OwnerRecord>;
		if (typeof raw.pid !== "number" || !Number.isSafeInteger(raw.pid) || raw.pid <= 0) return undefined;
		return { pid: raw.pid, host: typeof raw.host === "string" ? raw.host : "", at: typeof raw.at === "number" ? raw.at : 0 };
	} catch {
		return undefined;
	}
}

/** True when `pid` names a live process (EPERM still means "exists"). */
export function isPidAlive(pid: number): boolean {
	if (!Number.isSafeInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/**
 * Ownership verdict for a marker file: "live" (owner running, or on another
 * host so we cannot tell), "dead" (owner gone), or "unknown" (no marker).
 */
export function ownerState(file: string, alive: (pid: number) => boolean = isPidAlive): "live" | "dead" | "unknown" {
	const owner = readOwnerFile(file);
	if (!owner) return "unknown";
	if (owner.host && owner.host !== os.hostname()) return "live";
	return alive(owner.pid) ? "live" : "dead";
}
