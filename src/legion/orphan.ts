/**
 * 6.2.4 / D2: what a parent-session exit leaves behind on ANOTHER machine.
 *
 * 6.2.3 recorded every live child as `retired` + `node_retired{reason:
 * "session-shutdown"}` when the parent session ended, and the run record's
 * outcome was stamped `aborted (session-shutdown)`. For an in-process/rpc child
 * that is honest — it dies with the parent. For a CROSS-MACHINE child it is a
 * lie with a cost:
 *
 *   - the remote process is not killed by the shutdown (measured on a real
 *     two-machine run: the child kept working for another 75s and wrote its
 *     result), and
 *   - a terminal row is read by `recover` as "already settled", so it answers
 *     with the launch-time snapshot and fetches NOTHING — the real result became
 *     permanently unreachable.
 *
 * So the exit classifies each child three ways instead of one:
 *
 * | fate        | when                                                        | recover |
 * | ----------- | ----------------------------------------------------------- | ------- |
 * | `aborted`   | this host: the child dies with the parent; or another host:  | no work |
 * |             | a stop was DELIVERED and the backend CONFIRMED it ended       | left    |
 * | `unfetched` | another host: the turn was already over (graded, or a full   | fetch   |
 * |             | transcript is already here) and nobody read it back          |         |
 * | `orphaned`  | another host: still running, or nobody can say               | fetch   |
 *
 * `orphaned`/`unfetched` are NOT terminal: the ledger row stays open on purpose
 * so `listUnsettledRemoteNodes` (the `/legion status` block) and `recover` see
 * it, and `hasEnded` stays false so recovery is allowed to touch the wire. The
 * exit itself is recorded as an `orphan_detected` event — the type is already in
 * the closed set of 16, so no ledger contract moves.
 *
 * Why the fate is computed HERE, before anything drains or aborts: once the
 * shutdown aborts the in-flight collect, the snapshot says `running`
 * ("aborted by parent") and every trace of "the work had already finished" is
 * gone. The ordering is the same reason `markSessionInterrupted` runs first.
 */
import path from "node:path";
import type { DatabaseSync, SqliteRow } from "./db.ts";

/** The ledger reason the exit writes on an orphan marker (same word as #374's pause). */
export const SESSION_ORPHAN_REASON = "session-shutdown";

/** A cross-machine child whose result this machine still owes the user. */
export type OrphanFate = "orphaned" | "unfetched";

/** The exit's three-way answer, including the one that still means `aborted`. */
export type ShutdownFate = OrphanFate | "aborted";

/** The facts the classification reads. Kept explicit so every branch is testable. */
export interface ShutdownFateFacts {
	/** The child ran on another machine (`host` recorded). */
	crossMachine: boolean;
	/**
	 * A stop was DELIVERED to the child's process and the backend CONFIRMED it
	 * ended. A shutdown never does this to a cross-machine child (see the file
	 * docstring): `stop`/`abort` do, and they keep recording `aborted`.
	 */
	stopped: boolean;
	/** The turn over there was already over: graded, or a complete transcript is here. */
	programEnded: boolean;
}

/**
 * Three-way fate of one child at a session exit.
 *
 * A local child is `aborted` unconditionally — it dies with this process, and
 * that is 6.2.3's behaviour, kept byte for byte.
 */
export function shutdownFate(facts: ShutdownFateFacts): ShutdownFate {
	if (!facts.crossMachine) return "aborted";
	if (facts.stopped) return "aborted";
	if (facts.programEnded) return "unfetched";
	return "orphaned";
}

/** `host` recorded and non-empty ⇒ the child ran somewhere else (schema v5). */
export function isCrossMachineHost(host: unknown): boolean {
	return typeof host === "string" && host.trim().length > 0;
}

/** Where that machine keeps the transcript for a child (`<remoteDir>/session.jsonl`). */
export function remoteSessionPathFor(remoteDir: string | undefined): string | undefined {
	return remoteDir ? path.posix.join(remoteDir, "session.jsonl") : undefined;
}

/** One decoded `orphan_detected{reason:"session-shutdown"}` ledger row. */
export interface OrphanMark {
	/** Event id — compared against the last settle event to decide who is newer. */
	id: number;
	fate: OrphanFate;
	ts: number;
	host?: string;
	remoteDir?: string;
	remoteTerminal?: string;
	remoteSessionPath?: string;
	sessionFile?: string;
}

/** The last event id that actually ended the node's run. */
function lastSettleEventId(db: DatabaseSync, nodeId: string): number | undefined {
	const row = db
		.prepare(
			"SELECT MAX(id) AS id FROM events WHERE node_id = ? AND type IN ('node_settled', 'node_failed', 'node_retired', 'node_abandoned')",
		)
		.get(nodeId) as SqliteRow | undefined;
	const id = row?.id;
	return typeof id === "number" && Number.isFinite(id) ? id : undefined;
}

/**
 * The exit marker for a node, when it is still the newest word on it.
 *
 * A marker older than the last settle event is history: the row was recovered
 * (or collected) afterwards, and the recorded outcome is now the answer — which
 * is what keeps a SECOND `recover` on `already settled` and off the wire.
 */
export function orphanMarkFor(db: DatabaseSync, nodeId: string): OrphanMark | undefined {
	const row = db
		.prepare(
			"SELECT id, data, ts FROM events WHERE node_id = ? AND type = 'orphan_detected' ORDER BY id DESC LIMIT 1",
		)
		.get(nodeId) as SqliteRow | undefined;
	if (row === undefined) return undefined;
	let data: unknown;
	try {
		data = row.data === null || row.data === undefined ? undefined : JSON.parse(String(row.data));
	} catch {
		return undefined;
	}
	const fields = (data ?? {}) as {
		reason?: unknown;
		fate?: unknown;
		host?: unknown;
		remoteDir?: unknown;
		remoteTerminal?: unknown;
		remoteSessionPath?: unknown;
		sessionFile?: unknown;
	};
	if (fields.reason !== SESSION_ORPHAN_REASON) return undefined;
	const fate = fields.fate === "unfetched" ? "unfetched" : fields.fate === "orphaned" ? "orphaned" : undefined;
	if (fate === undefined) return undefined;
	const id = Number(row.id);
	const settleId = lastSettleEventId(db, nodeId);
	if (settleId !== undefined && settleId > id) return undefined;
	const text = (value: unknown): string | undefined => (typeof value === "string" && value.length > 0 ? value : undefined);
	return {
		id,
		fate,
		ts: Number(row.ts),
		...(text(fields.host) ? { host: text(fields.host)! } : {}),
		...(text(fields.remoteDir) ? { remoteDir: text(fields.remoteDir)! } : {}),
		...(text(fields.remoteTerminal) ? { remoteTerminal: text(fields.remoteTerminal)! } : {}),
		...(text(fields.remoteSessionPath) ? { remoteSessionPath: text(fields.remoteSessionPath)! } : {}),
		...(text(fields.sessionFile) ? { sessionFile: text(fields.sessionFile)! } : {}),
	};
}

/** Just the fate, for display surfaces that only need the word. */
export function orphanFateOf(db: DatabaseSync, nodeId: string): OrphanFate | undefined {
	return orphanMarkFor(db, nodeId)?.fate;
}
