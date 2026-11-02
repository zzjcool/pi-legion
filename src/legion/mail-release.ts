/**
 * #384 — hand a node its mail while it is BLOCKED in `wait`/`collect`.
 *
 * `legion_mail` reaches a parent through `notice()` → `pi.sendMessage({ deliverAs:
 * "followUp" })`, and the host only takes a followUp when the current turn is
 * about to stop (`agent-loop.js:197`). A parent sitting in a long `wait` therefore
 * held its mail until that wait ended — measured at 17.3 minutes in
 * `docs/contracts/wait-mail-preempt-v1.md` §0.
 *
 * This module is the ledger half of the fix (contract §1/§2/§3): count the
 * recipient's `PENDING` mail, take it exactly once, and render the same envelope
 * the postman would have injected. It knows nothing about waiting, signals, or
 * tools — `waitAction`/`collectChild` own that half.
 *
 * Why taking is just a delivery-state transition: `mail_sent` is already written
 * by `sendMail` (`src/legion/mail.ts`), `ACCEPTED` writes no event, and the
 * postman only reads `PENDING` — so a released message can never be delivered
 * twice (I2), and no new event type or column is needed (I3).
 */

import type { DatabaseSync } from "./db.ts";
import {
	formatMail,
	MAIL_DELIVERY,
	pendingInbox,
	transitionDelivery,
	type LegionMessage,
} from "./mail.ts";

/** Contract §2: at most this many mails ride out on one preemption. */
export const MAIL_RELEASE_LIMIT = 100;

/** Contract §1: how often a blocked `wait`/`collect` looks at the inbox. */
export const MAIL_PREEMPT_POLL_MS = 250;

/**
 * The inbox a blocking tool has to watch, when the caller is a legion node.
 *
 * Absent (a plain session, not a node) the tools keep today's behaviour exactly:
 * no query, no timer, no abort controller.
 */
export interface MailReleaseSeam {
	db: DatabaseSync;
	nodeId: string;
	/** Test seam: the ledger clock. Defaults to `Date.now`. */
	now?: () => number;
}

/** Contract §1: is there anything to release right now? */
export function pendingMailCount(db: DatabaseSync, nodeId: string): number {
	if (!nodeId) throw new TypeError("nodeId must be a non-empty node id");
	const row = db
		.prepare("SELECT COUNT(*) AS count FROM messages WHERE to_node = ? AND delivered = ?")
		.get(nodeId, MAIL_DELIVERY.PENDING);
	return Number(row?.count ?? 0);
}

/**
 * Take every `PENDING` message addressed to `nodeId`, oldest id first.
 *
 * "Take" is exactly the postman's own bookkeeping — `PENDING` → `ACCEPTED`, no
 * event — so whoever gets here first wins and the loser sees an empty list
 * instead of a duplicate. A message another writer moved in between is dropped
 * (the transition throws), never re-delivered: contract §3 is "exactly once",
 * and the postman remains the fallback route for anything this call missed.
 */
export function takePendingMail(
	db: DatabaseSync,
	nodeId: string,
	now: () => number = () => Date.now(),
): LegionMessage[] {
	const taken: LegionMessage[] = [];
	for (const message of pendingInbox(db, nodeId, MAIL_RELEASE_LIMIT)) {
		try {
			taken.push(transitionDelivery(db, message.id, MAIL_DELIVERY.ACCEPTED, now));
		} catch {
			// Raced: the postman (or a previous release) already moved it.
		}
	}
	return taken.sort((left, right) => left.id - right.id);
}

/** Contract §2: the preempted mail, verbatim, one blank line between messages. */
export function renderReleasedMail(messages: readonly LegionMessage[]): string {
	return messages.map((message) => formatMail(message)).join("\n\n");
}

/**
 * Watch `seam`'s inbox every {@link MAIL_PREEMPT_POLL_MS} until mail lands, then
 * call `onMail` ONCE and stop. Returns the cancel handle for the caller's
 * `finally` — the timer is `unref`'d so a blocked wait can never hold the
 * process open, and a ledger that closed under us is not the caller's problem.
 */
export function pollInbox(seam: MailReleaseSeam, onMail: () => void): () => void {
	let timer: ReturnType<typeof setInterval> | undefined;
	const cancel = (): void => {
		if (timer === undefined) return;
		clearInterval(timer);
		timer = undefined;
	};
	timer = setInterval(() => {
		let waiting: number;
		try {
			waiting = pendingMailCount(seam.db, seam.nodeId);
		} catch {
			return;
		}
		if (waiting === 0) return;
		cancel();
		onMail();
	}, MAIL_PREEMPT_POLL_MS);
	timer.unref?.();
	return cancel;
}
