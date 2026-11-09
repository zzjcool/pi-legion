/**
 * Who can answer "is this node's agent run still live?" — a registry that holds the
 * READER, never the answer.
 *
 * `docs/contracts/root-mail-run-boundary-v1.md` (D2) needs one fact inside the mail
 * postman: is the recipient node's own agent run still holding the turn? That truth
 * lives in exactly one place — the closure variable `parentRunActive` owned by
 * `createSessionRuntime` in `src/extension/runtime.ts` (the D6 comment there names
 * this contract), driven by the host's `agent_start` / `agent_settled`. The postman
 * is built by `index.ts` from a `LegionPostmanOptions` and has no handle on that
 * closure, so this module is the seam: the runtime
 * `publishLegionRunActivity(nodeId, () => parentRunActive)`s once its identity is
 * known, and the postman asks `isLegionRunActive(nodeId)`.
 *
 * **No boolean copy lives here.** That is `docs/contracts/display-liveness-v1.md`
 * R1's lesson: "alive" answered independently by three owners let one child be
 * `live` and `failed` at the same time. A cached flag would be a second authority,
 * and it would go stale on exactly the edge this gate exists to observe
 * (`agent_settled`) — so what is stored is a function, and every read is the truth
 * of that instant.
 *
 * D3 fail direction: no registrant, a reader that throws, and a non-`true` return all
 * answer `false` ("not active") — byte-for-byte the pre-contract behaviour, i.e.
 * deliver now. An unknown or broken host must never be able to strand root's mail;
 * this is `notice-delivery-v2` D-H's fail-open rule. This module adds no
 * fail-closed branch of its own.
 */

/** nodeId → the one reader that owns that node's run-liveness truth. */
const runActivityReaders = new Map<string, () => boolean>();

/**
 * Register (or REPLACE) the run-activity reader for one node, and return a **bound
 * disposer** for exactly this registration.
 *
 * Idempotent by construction: a second publish for the same `nodeId` overwrites the
 * first, so the production call site may run once per identity resolution without
 * tracking what it already published.
 *
 * Review F3 — why the return value exists: teardown must not be able to withdraw
 * someone else's registration. The disposer removes the entry only when the registry
 * still holds the reader THIS call published (`get(nodeId) === read`), so a runtime
 * that is shutting down late can never unregister a newer publisher of the same node.
 */
export function publishLegionRunActivity(nodeId: string, read: () => boolean): () => void {
	if (!nodeId) throw new TypeError("nodeId must be a non-empty node id");
	if (typeof read !== "function") throw new TypeError("run activity reader must be a function");
	runActivityReaders.set(nodeId, read);
	let released = false;
	return () => {
		if (released) return;
		released = true;
		if (runActivityReaders.get(nodeId) === read) runActivityReaders.delete(nodeId);
	};
}

/**
 * Drop one node's reader, whoever published it — the blunt form, for fixtures and
 * sweeps. **Not** the production teardown path: a live `SessionRuntime` releases the
 * ownership-checked disposer {@link publishLegionRunActivity} handed it (review F3).
 * A no-op for a node that never registered.
 */
export function withdrawLegionRunActivity(nodeId: string): void {
	if (!nodeId) throw new TypeError("nodeId must be a non-empty node id");
	runActivityReaders.delete(nodeId);
}

/**
 * Is this node's agent run still live? D3: anything but a clean `true` is `false`
 * (no registrant / reader threw / reader returned a non-boolean truthy value).
 */
export function isLegionRunActive(nodeId: string): boolean {
	if (!nodeId) return false;
	const read = runActivityReaders.get(nodeId);
	if (read === undefined) return false;
	try {
		return read() === true;
	} catch {
		// An unknown host is not an active run: deliver, exactly as before D2.
		return false;
	}
}
