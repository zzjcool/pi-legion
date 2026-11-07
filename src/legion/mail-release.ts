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
	MAIL_BOUNCE_REASON,
	MAIL_DELIVERY,
	isStalePhaseTimeoutNotice,
	isStaleStallNotice,
	pendingInbox,
	releaseDeliveryClaim,
	transitionDelivery,
	type LegionMessage,
	type MailBounceReason,
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
 * claim immediately), and a send that runs long RENEWS it (`renewDeliveryClaim` every
 * `leaseMs / 3`, wired in `deliverToChild`) so the length is not a bet on the slowest
 * call: entry into the resume/admission queue defaults to 900s, which is why the
 * holder renews instead of the constant trying to cover it. A holder that dies
 * without releasing therefore blocks its own claim for 60s and no longer: after that
 * another route may take the message over.
 *
 * Not a timeout: nothing is written when it expires, and an expired-but-alive holder
 * can only lose a race it was about to lose anyway.
 */
export const MAIL_DELIVERY_CLAIM_LEASE_MS = 60_000;

/** Contract §3: the marker that tells the rate limiter this row is a re-delivery. */
export const REDELIVERED_SUBJECT_PREFIX = "Redelivered: ";

function redeliveredSubject(subject: string): string {
	return subject.startsWith(REDELIVERED_SUBJECT_PREFIX)
		? subject
		: `${REDELIVERED_SUBJECT_PREFIX}${subject}`;
}

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

/**
 * Nodes whose postman must hold its inbox because a blocking call is running
 * (#384 review round 3 — the reason the feature worked in tests but not in life).
 *
 * Measured on the issue's own ledger: root's postman moves a message
 * `PENDING → ACCEPTED` ~200ms after it is written, pushing it into the host's
 * followUp queue. A `wait` that starts afterwards sees an EMPTY pending inbox for its
 * whole 15 minutes and preempts nothing — the mail still waits for the turn boundary,
 * which is the bug #384 set out to fix. So while a blocking call from a node runs,
 * that node's own postman must not deliver: the message stays `PENDING`, the poll
 * sees it, and the tool hands it over immediately. Releasing the hold restores the
 * postman (a `wait` that timed out must not park the inbox forever).
 *
 * A counter, not a flag, so nested/overlapping holds cannot release each other early.
 * Process-wide on purpose: the postman that delivers to a node runs in the SAME
 * process as that node's tools (this is the root node's case). A child's delivery
 * happens in the parent process, where this registry is invisible — there the claim
 * lease keeps the message from being delivered twice, which is all it owes.
 */
const mailHolds = new Map<string, number>();

/** Hold this node's postman until the matching {@link endMailHold}. */
export function beginMailHold(nodeId: string): void {
	if (!nodeId) throw new TypeError("nodeId must be a non-empty node id");
	mailHolds.set(nodeId, (mailHolds.get(nodeId) ?? 0) + 1);
}

/** Release one hold; the postman resumes when the last holder lets go. */
export function endMailHold(nodeId: string): void {
	if (!nodeId) throw new TypeError("nodeId must be a non-empty node id");
	const remaining = (mailHolds.get(nodeId) ?? 0) - 1;
	if (remaining > 0) mailHolds.set(nodeId, remaining);
	else mailHolds.delete(nodeId);
}

/** Is a blocking call from this node currently holding its inbox? */
export function isMailHeld(nodeId: string): boolean {
	return (mailHolds.get(nodeId) ?? 0) > 0;
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
	const pending = Number(row?.count ?? 0);
	if (pending === 0) return 0;
	// The count must mean "releasable", not "pending" (contract D3, R3). A row the
	// preemption is about to obsolete is not something to wake a blocked `wait` for:
	// counting it would abort the tool, `takePendingMail` would hand back an empty
	// list, and the caller would report `interrupted (parent turn ended; children
	// still running)` — an empty return reported as a parent-turn abort. A stale
	// stall notice is exactly that row (its children all ended while it waited), so
	// the count runs the SAME window and the SAME predicate as `takePendingMail`
	// below; the cheap COUNT first only spares the 250ms poll a row fetch when the
	// inbox is empty.
	const releasable = pendingInbox(db, nodeId, MAIL_RELEASE_LIMIT).filter(
		(message) => (message.deliveredAt === null || message.deliveredAt < cutoff) && staleNoticeReason(db, message) === undefined,
	);
	return releasable.length;
}

/**
 * The single "this notice is already pointless, and why" predicate (contract D3).
 *
 * The phase-timeout rule keeps its own reason (`obsolete_after_phase_change`, #333)
 * and the stall rule has its own (`obsolete_after_child_end`); folding them into one
 * function is what makes the preemption, the poll counter and the postman's discard
 * literally the same judgement instead of three copies that drift (R3 in the
 * contract: two predicate sets = an empty return + a false `interrupted`).
 *
 * `undefined` is the whole answer for "deliver it": no caller is allowed to invent
 * a third outcome here.
 */
export function staleNoticeReason(
	db: DatabaseSync,
	message: LegionMessage,
): MailBounceReason | undefined {
	if (isStalePhaseTimeoutNotice(db, message)) return MAIL_BOUNCE_REASON.OBSOLETE_AFTER_PHASE_CHANGE;
	if (isStaleStallNotice(db, message)) return MAIL_BOUNCE_REASON.OBSOLETE_AFTER_CHILD_END;
	return undefined;
}

/**
 * Obsolete this node's pending stall notices whose named children have all ended.
 *
 * The delivery paths already refuse to hand over a notice whose subject is gone
 * (`discardIfStaleNotice`), but they only run on a postman tick — so the row sat
 * `PENDING` for up to 2s after the child returned, and a parent that had just finished
 * a synchronous `vexillatio` batch was handed that expired to-do as a followUp the
 * moment its turn ended. The fact "the child ended" therefore writes its own
 * consequence, where that fact is recorded (`Orchestrator.recordSettled` and the two
 * direct `retired` writes in `retire`).
 *
 * Only the STALL predicate is consulted on purpose: `staleNoticeReason` would also
 * sweep `Phase timeout:` notices, which have their own owner (#333) and their own
 * hook-free path — this sweep must not become a second, differently-timed writer for
 * a class it does not own.
 *
 * Idempotent, and BOUNDED: it visits the first `pendingInbox` window (100 rows), so a
 * backlog past it is not swept in one pass — those rows keep today's behaviour and are
 * discarded by the postman's next tick. A second call returns 0 (an `OBSOLETE` row is
 * terminal and only `PENDING` rows are visited), and a row another writer already moved
 * is skipped rather than raised at a settle path that must never fail on bookkeeping.
 */
export function obsoleteStaleStallNotices(
	db: DatabaseSync,
	parentNodeId: string,
	now: () => number = () => Date.now(),
): number {
	if (!parentNodeId) throw new TypeError("parentNodeId must be a non-empty node id");
	let obsoleted = 0;
	// A row another delivery already holds is mid-send, not "pending" in any sense this
	// sweep may rewrite: a claim is `delivered_at` on a still-`PENDING` row (#384), and
	// obsoleting it would only make that sender's own transition throw afterwards. Same
	// lease window `pendingMailCount` uses.
	const cutoff = now() - MAIL_DELIVERY_CLAIM_LEASE_MS;
	for (const message of pendingInbox(db, parentNodeId)) {
		if (message.deliveredAt !== null && message.deliveredAt >= cutoff) continue;
		try {
			// The PREDICATE is inside the guard too: it reads the tree (`getNode`,
			// `getChildByName`), so one malformed row could throw there and — with the
			// check outside — take the whole pass with it, costing every row behind it.
			if (!isStaleStallNotice(db, message)) continue;
			transitionDelivery(db, message.id, MAIL_DELIVERY.OBSOLETE, now, {
				reason: MAIL_BOUNCE_REASON.OBSOLETE_AFTER_CHILD_END,
			});
			obsoleted += 1;
		} catch {
			// Raced, unreadable, or an edge the ledger refuses: leave this row to the
			// postman's own discard rather than failing the settle/retire that called us.
			continue;
		}
	}
	return obsoleted;
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
		// #333 + stall-notice-staleness D3: the postman discards notices whose subject is
		// already over, and this path must agree with it — otherwise the preemption hands
		// the model a to-do that is already pointless, one the postman would have thrown
		// away. `staleNoticeReason` is the SHARED predicate (`pendingMailCount` runs it
		// too), and it is applied BEFORE the claim so the row is never leased for a
		// message nobody will read. The reason is the same one the postman writes.
		const staleReason = staleNoticeReason(db, message);
		if (staleReason !== undefined) {
			transitionDelivery(db, message.id, MAIL_DELIVERY.OBSOLETE, now, { reason: staleReason });
			continue;
		}
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
 *
 * Two ledger rules follow from "this is a platform re-delivery, not a new send"
 * (#384 review m5): the subject is prefixed ONCE (a copy of a copy must not read
 * `Redelivered: Redelivered: …`), and the rate limiter ignores these rows, so a
 * discarded tool result can never spend the sender's five-minute quota — contract §3.
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
				redeliveredSubject(original.subject),
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
 * `finally`; a ledger that closed under us is not the caller's problem.
 *
 * The timer is deliberately NOT `unref`'d (#384 CI): the poll is the only thing
 * that can end a blocked `wait`/`collect` early, so a process whose event loop
 * holds nothing else would otherwise drain and leave the tool's promise pending
 * forever — node reports that as `Promise resolution is still pending but the
 * event loop has already resolved`. It lives exactly as long as the blocking
 * call and is cleared in the same `finally`, so it cannot outlive its owner.
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
	return cancel;
}
