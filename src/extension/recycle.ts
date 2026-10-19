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
	return (
		state === "retired" ||
		state === "awaiting" ||
		state === "blocked" ||
		state === "exited"
	);
}
