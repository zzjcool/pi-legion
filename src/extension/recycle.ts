/** Helpers for collect/retire calls made after a child is auto-retired. */

import type { TaskState } from "../shared/types.ts";

export function formatAlreadyRecycled(
	name: string,
	sessionFile: string,
): string {
	return (
		`Already retired ${name}. This is a no-op — the child is already stopped. ` +
		`Session kept for resume: ${sessionFile}`
	);
}

/** States where collect should return the snapshot already on the child. */
export function canUseCachedCollect(state: TaskState): boolean {
	// `queued` is deliberately NOT cacheable (#266 D3/§4.4): the record has no
	// execution, no acceptance and only a PLACEHOLDER session file, so a cached
	// collect would hand back a stale/empty snapshot as if the launch had finished.
	// A queued child must go through `collect`'s wait-for-admission path (D8).
	return (
		state === "retired" ||
		state === "awaiting" ||
		state === "blocked" ||
		state === "exited"
	);
}
