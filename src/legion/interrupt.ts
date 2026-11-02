/**
 * #374 §3: mark what a session exit interrupts, BEFORE anything starts tearing the
 * session down.
 *
 * Why this cannot wait for the retire path (`Orchestrator.retire({cause:"session-shutdown"})`):
 * in `--print`/`--json` mode the shutdown hook drains first (`drainBeforeShutdown`),
 * and a child whose turn ends during that drain — including one whose process was
 * just killed with the parent — parses as a finished turn and is recorded `settled`
 * with `execution: "success"`. By the time the explicit retire runs, the lifecycle
 * is already over and the interrupt is lost. Measured in the container: a worker that
 * was still `running` when SIGTERM arrived came back as `settled/success`.
 *
 * So the marker is written first, and it is deliberately WRITE-ONLY about the ledger:
 * it kills nothing, touches no phase, and does not move the child record. A child that
 * really does finish during the drain improves the ledger afterwards (`recordSettled`
 * writes `settled` regardless of the node status), and a child that dies stays
 * `retired` + `node_retired{reason:"session-shutdown"}` — which is exactly what
 * `interruptedChildren` reads on the next start.
 */
import { appendEvent } from "./events.ts";
import { getChildren, LIVE_CHILD_STATUSES, updateNode } from "./nodes.ts";
import type { DatabaseSync } from "./db.ts";

/** The event field that distinguishes "paused by an exit" from "stopped on purpose". */
export const SESSION_INTERRUPT_REASON = "session-shutdown";

/**
 * Retire (do not abort) every live direct child of `parentId`.
 *
 * Returns the ids it marked, so a caller can report what it interrupted without
 * re-deriving the predicate.
 */
export function markSessionInterrupted(db: DatabaseSync, parentId: string, now: () => number): string[] {
	const marked: string[] = [];
	for (const node of getChildren(db, parentId)) {
		if (!(LIVE_CHILD_STATUSES as readonly string[]).includes(node.status)) continue;
		updateNode(db, node.id, { status: "retired" }, now);
		appendEvent(db, node.id, "node_retired", { parentId, reason: SESSION_INTERRUPT_REASON }, { now });
		marked.push(node.id);
	}
	return marked;
}

/**
 * Did an exit pause this node?
 *
 * Reads the LAST `node_retired` for the node, so a later deliberate retire (which
 * carries no reason) wins over the older pause marker.
 */
export function wasSessionInterrupted(db: DatabaseSync, nodeId: string): boolean {
	const row = db
		.prepare("SELECT data FROM events WHERE node_id = ? AND type = 'node_retired' ORDER BY id DESC LIMIT 1")
		.get(nodeId) as { data: string | null } | undefined;
	if (!row?.data) return false;
	try {
		return (JSON.parse(row.data) as { reason?: unknown }).reason === SESSION_INTERRUPT_REASON;
	} catch {
		return false;
	}
}

/**
 * #372: the ledger reason the all-children-failed safety net writes.
 *
 * Shared so the writer (`LegionPostman.failTeamIfAllChildrenFailed`) and the
 * reader below cannot drift: the reason is the ONLY thing that distinguishes a
 * supervisor verdict from an ordinary drain-recorded failure (`recordSettled`
 * writes the child's own `execution.reason` there).
 */
export const ALL_CHILDREN_FAILED_REASON = "all_children_failed";

/**
 * Did a SUPERVISOR already judge this node failed — before its own turn drained?
 *
 * `recordSettled` is the drain's writer: it derives a status from the child's
 * session and writes it, deliberately without asking the row what it already
 * says (a child that really finished during a shutdown drain is improved to
 * `settled`, #374 §3). That rule is right for a PAUSE and wrong for a VERDICT:
 * after the safety net failed a team, its lead still finishes its turn normally,
 * and the drain would rewrite `failed` → `settled`. The ledger would then
 * contradict itself — a `node_failed` event on a row that reads `settled` — and
 * `isTerminalNode` would flip back to false, so a team the supervisor had already
 * buried would look resumable again.
 *
 * The marker is the last `node_failed` carrying {@link ALL_CHILDREN_FAILED_REASON},
 * which only the safety net writes.
 */
export function wasFailedBySupervisor(db: DatabaseSync, nodeId: string): boolean {
	const row = db
		.prepare("SELECT data FROM events WHERE node_id = ? AND type = 'node_failed' ORDER BY id DESC LIMIT 1")
		.get(nodeId) as { data: string | null } | undefined;
	if (!row?.data) return false;
	try {
		return (JSON.parse(row.data) as { reason?: unknown }).reason === ALL_CHILDREN_FAILED_REASON;
	} catch {
		return false;
	}
}
