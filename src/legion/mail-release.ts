/**
 * #384 — hand a node its mail while it is BLOCKED in `wait`/`collect`.
 *
 * `legion_mail` reaches a parent through `notice()` → `pi.sendMessage({ deliverAs:
 * "followUp" })`, and the host only takes a followUp when the current turn is
 * about to stop (`agent-loop.js:197`). A parent sitting in a long `wait` therefore
 * held its mail until that wait ended — measured at 17.3 minutes in
 * `docs/contracts/wait-mail-preempt-v1.md` §0.
 *
 * This module is the ledger half of the fix (contract §1/§2/§3): take the
 * recipient's `PENDING` mail exactly once, render the same envelope the postman
 * would have injected, and re-enqueue what a discarded tool result would have lost.
 * It knows nothing about waiting, signals, or tools — `waitAction`/`collectChild`
 * own that half.
 *
 * Why taking is just a delivery-state transition: `mail_sent` is already written
 * by `sendMail` (`src/legion/mail.ts`), `ACCEPTED` writes no event, and the
 * postman's own delivery claims the same row before sending (#384 review P0-1), so
 * one of the two routes wins on the ledger and a message can never be delivered
 * twice (I2). No new event type and no new column (I3).
 */

import { appendEvent } from "./events.ts";
import type { DatabaseSync } from "./db.ts";
import {
	claimForDelivery,
	formatMail,
	getMessage,
	MAIL_DELIVERY,
	pendingInbox,
	releaseDeliveryClaim,
	transitionDelivery,
	type LegionMessage,
} from "./mail.ts";

/** Contract §2: at most this many mails ride out on one preemption. */
const MAIL_RELEASE_LIMIT = 100;

/** Contract §1: how often a blocked `wait`/`collect` looks at the inbox. */
const MAIL_PREEMPT_POLL_MS = 250;

/**
 * How long a delivery claim lives (#384 review, ruling: lease, not a new edge).
 *
 * `claimForDelivery` stamps `delivered_at` on a `PENDING` row; that stamp is the
 * lease. It exists for CRASH RECOVERY only — the normal path is closed by
 * `transitionDelivery` (a returned send writes `ACCEPTED`, a thrown one releases the
 * claim immediately), so this number only has to outlive the slowest real
 * `supervisor.*` call a host performs (RPC steer/followUp/prompt round trips, which
 * are seconds at worst). A holder that dies without releasing therefore blocks its own
 * claim for 60s and no longer: after that another route may take the message over.
 *
 * Not a timeout: nothing is written when it expires, and an expired-but-alive holder
 * can only lose a race it was about to lose anyway.
 */
export const MAIL_DELIVERY_CLAIM_LEASE_MS = 60_000;

/**
 * The inbox a blocking tool has to watch, when the caller is a legion node.
 *
 * Absent (a plain session, not a node) the tools keep today's behaviour exactly:
 * no query, no timer, no abort controller.
 */
export interface MailReleaseSeam {
	db: DatabaseSync;
	nodeId: string;
}

/** Contract §1: is there anything to release right now, that nobody else holds? */
function pendingMailCount(db: DatabaseSync, nodeId: string): number {
	if (!nodeId) throw new TypeError("nodeId must be a non-empty node id");
	const cutoff = Date.now() - MAIL_DELIVERY_CLAIM_LEASE_MS;
	const row = db
		.prepare(
			"SELECT COUNT(*) AS count FROM messages WHERE to_node = ? AND delivered = ? AND (delivered_at IS NULL OR delivered_at < ?)",
		)
		.get(nodeId, MAIL_DELIVERY.PENDING, cutoff);
	return Number(row?.count ?? 0);
}

/**
 * Take every `PENDING` message addressed to `nodeId`, oldest id first.
 *
 * "Take" is exactly the postman's own bookkeeping — `PENDING` → `ACCEPTED`, no
 * event — so whoever gets there first wins and the loser sees an empty list
 * instead of a duplicate. A message another writer moved in between is dropped
 * (the transition throws), never re-delivered: contract §3 is "exactly once",
 * and the postman remains the fallback route for anything this call missed.
 *
 * Review P1.3: only a row that REALLY became `ACCEPTED` is returned. A recipient
 * that went terminal bounces instead (`transitionDelivery` answers `BOUNCED`), and
 * a bounce is not a delivery — handing that text to the caller would be the same
 * lie the ledger just refused to tell.
 */
export function takePendingMail(db: DatabaseSync, nodeId: string): LegionMessage[] {
	const now = () => Date.now();
	const taken: LegionMessage[] = [];
	for (const message of pendingInbox(db, nodeId, MAIL_RELEASE_LIMIT)) {
		// The SAME lease the postman uses (#384 review): whoever claims first delivers,
		// and an in-flight postman send is not stolen out from under its followUp.
		if (!claimForDelivery(db, message.id, now, MAIL_DELIVERY_CLAIM_LEASE_MS)) continue;
		try {
			const claimed = transitionDelivery(db, message.id, MAIL_DELIVERY.ACCEPTED);
			if (claimed.delivered === MAIL_DELIVERY.ACCEPTED) taken.push(claimed);
		} catch {
			// Raced: another writer moved it between claim and transition. Hand the lease
			// back so the row is claimable again rather than parked for a minute.
			releaseDeliveryClaim(db, message.id);
		}
	}
	return taken.sort((left, right) => left.id - right.id);
}

/** Contract §2: the preempted mail, verbatim, one blank line between messages. */
export function renderReleasedMail(messages: readonly LegionMessage[]): string {
	return messages.map((message) => formatMail(message)).join("\n\n");
}

/**
 * Put released mail back in the queue, once per message (#384 review P0-3).
 *
 * A preemption moves the row to `ACCEPTED`, and `takePendingMail` is not
 * reversible by design. When the tool layer's abort net then throws the whole
 * result away — the mail text never reached the model — the message would be lost
 * for good, where before #384 it was still `PENDING` and a restart would deliver
 * it. So the discarded result is re-enqueued as a NEW row: same sender, recipient,
 * body, kind and urgency, subject prefixed `Redelivered: `, `delivered = 0`, plus
 * the ordinary `mail_sent` event (`sendMail`'s own insert shape, no new event type
 * and no new column). The postman's next tick picks it up like any other mail.
 *
 * Not idempotent on purpose: it is called once per discarded result, and the ids it
 * is handed are exactly the ones that result carried.
 */
export function redeliverMail(db: DatabaseSync, messageIds: readonly number[]): LegionMessage[] {
	const now = Date.now();
	const copies: LegionMessage[] = [];
	for (const id of messageIds) {
		const original = getMessage(db, id);
		if (!original) continue;
		const insert = db
			.prepare(
				`INSERT INTO messages (
					from_node, to_node, subject, body, kind, urgency, delivered, created_at
				) VALUES (?, ?, ?, ?, ?, ?, 0, ?)`,
			)
			.run(
				original.fromNode,
				original.toNode,
				`Redelivered: ${original.subject}`,
				original.body,
				original.kind,
				original.urgency,
				now,
			);
		const copy = getMessage(db, Number(insert.lastInsertRowid));
		if (!copy) continue;
		appendEvent(
			db,
			copy.fromNode,
			"mail_sent",
			{ messageId: copy.id, toNode: copy.toNode },
			{ now: () => now },
		);
		copies.push(copy);
	}
	return copies;
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
