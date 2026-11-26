/** Helpers for collect/retire calls made after a child is auto-retired. */

import type { TaskState } from "../shared/types.ts";

/**
 * The `already retired` receipt the deleted `retire` action used to answer with.
 *
 * RETENTION NOTE (tool-surface-ops-verbs-v2 D1): the `retire` action and the
 * `retireChild` that called it are gone, so **no production caller reaches this
 * function any more**. It stays — deliberately, not by oversight — because
 * `src/api.ts` re-exports it as part of the published `pi-legion/api` surface
 * ("everything re-exported below … is safe to depend on"), and deleting an export
 * from that surface is a breaking change that needs its own major release, not a
 * side effect of dropping an action. `stop` now reports the same facts through
 * `retiredRecordNote` (`index.ts`: execution + `Session kept for resume: …`).
 * Do not add an internal caller back: one verb, one receipt.
 */
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
	// A queued child must go through `wait`'s wait-for-admission path (D8).
	return (
		state === "retired" ||
		state === "awaiting" ||
		state === "blocked" ||
		state === "exited"
	);
}
