/**
 * Display snapshots of every child session file a set of runs mentions (#348).
 *
 * The one implementation behind `/legion summary` and `/legion timing`: both
 * commands used to carry an identical private `sessionMapFor`, which is how the
 * two copies drift apart (one gets the `(size, mtimeMs)` gate, the other does
 * not). It belongs in `shared/` rather than in either command because the
 * contract is the same and neither file owns it.
 *
 * Read-only display data: the parse goes through `parseSessionFileCached`, so an
 * unchanged file is answered from the gate instead of being re-parsed. Nothing
 * here mutates the snapshot; verdict derivation must keep calling
 * `parseSessionFile` on the file it is judging.
 */

import { parseSessionFileCached } from "./session.ts";
import type { ParsedSession, RunRecord } from "./types.ts";

export function sessionMapFor(runs: readonly RunRecord[]): Map<string, ParsedSession> {
	const sessions = new Map<string, ParsedSession>();
	for (const run of runs) {
		for (const child of run.children) {
			if (child.sessionFile) {
				sessions.set(child.sessionFile, parseSessionFileCached(child.sessionFile));
			}
		}
	}
	return sessions;
}
