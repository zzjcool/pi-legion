import type { DatabaseSync, SqliteRow } from "./db.ts";
import { withTransaction } from "./db.ts";
import { appendEvent } from "./events.ts";
import { getNode, getSubtree, hasEnded, isTerminalNode, sanitizeNodeSlug, type LegionNode } from "./nodes.ts";
import type { TurnRecord } from "../shared/types.ts";

/**
 * Mail delivery state machine (`messages.delivered`, schema v2 — #322).
 *
 * The old three-value enum collapsed three different realities into `INJECTED`:
 * the text was queued behind a tool batch, the text started a new turn, or the
 * text was swallowed by an input handler and never reached the child at all.
 * `ACCEPTED` now says only what the ledger can prove — the send call returned —
 * and `DELIVERED` is written later, from evidence (see {@link mailMatchesUserText}).
 */
export const MAIL_DELIVERY = {
	PENDING: 0,
	/**
	 * A send call returned an answer — NOT proof the child's model read it (#322).
	 *
	 * That answer is three-way (`queued` waits for the child's next turn boundary,
	 * `accepted` started a turn, `intercepted` was swallowed by an input handler),
	 * and the first two both land here. `intercepted` does NOT: it bounces.
	 * ACCEPTED never promises a retry — only a thrown send leaves a message pending.
	 */
	ACCEPTED: 1,
	/** Never deliverable: terminal recipient, or the text was intercepted on arrival. */
	BOUNCED: 2,
	/** The recipient demonstrably consumed the text (exact match in its session turns). */
	DELIVERED: 3,
	/** Was valid when sent, but lost its meaning before it was consumed (#333). */
	OBSOLETE: 4,
	/**
	 * @deprecated Renamed to {@link MAIL_DELIVERY.ACCEPTED} in schema v2 (#322).
	 * Points at the same value `1`; kept only so out-of-tree imports keep compiling.
	 * The name was the bug: it claimed a delivery the ledger never observed.
	 */
	INJECTED: 1,
} as const;

/**
 * Why a message bounced. Written into the `mail_bounced` event's `data.reason`;
 * a send-side bounce to a terminal recipient still carries no reason (its event
 * shape predates this domain and the recipient state is the explanation).
 */
export const MAIL_BOUNCE_REASON = {
	/** #322: an input handler ate the text before it was queued; no retry exists. */
	INTERCEPTED_BY_INPUT_HANDLER: "intercepted_by_input_handler",
	/** #333: a `Phase timeout:` notice whose phase was already over when it landed. */
	OBSOLETE_AFTER_PHASE_CHANGE: "obsolete_after_phase_change",
} as const;
export type MailBounceReason = (typeof MAIL_BOUNCE_REASON)[keyof typeof MAIL_BOUNCE_REASON];

/**
 * How many of the recipient's most recent turns prove a delivery (#322 D3).
 * Bounded so a long-running child cannot make one confirmation scan unbounded.
 */
export const MAIL_DELIVERY_TURN_WINDOW = 20;

/**
 * Subject prefix `checkOwnPhaseTimeout` writes for a `phase_timeout` notice.
 * The only notice class {@link isStalePhaseTimeoutNotice} may obsolete.
 */
export const PHASE_TIMEOUT_MAIL_SUBJECT_PREFIX = "Phase timeout:";

export const MAIL_SUBJECT_HARD_LIMIT_BYTES = 256;
export const MAIL_BODY_SOFT_LIMIT_BYTES = 4 * 1024;
export const MAIL_BODY_HARD_LIMIT_BYTES = 32 * 1024;
export const DEFAULT_MAIL_RATE_PER_5_MIN = 10;
export const MAIL_RATE_WINDOW_MS = 5 * 60 * 1_000;
export type MailDeliveryStatus = (typeof MAIL_DELIVERY)[keyof typeof MAIL_DELIVERY];
export type MailUrgency = "info" | "action-needed";
export type MailKind = "question" | "report" | "handoff" | "notice";
export type MailTarget = "parent" | "children" | "squad";

export interface LegionMessage {
	id: number;
	fromNode: string;
	toNode: string;
	subject: string;
	body: string;
	kind: string | null;
	urgency: MailUrgency;
	delivered: MailDeliveryStatus;
	deliveredAt: number | null;
	createdAt: number;
}

export interface SendMailInput {
	fromNode: string;
	to: string | readonly string[];
	subject: string;
	body: string;
	kind?: MailKind;
	urgency?: MailUrgency;
}

export interface SendMailOptions {
	ratePer5Min?: number;
	now?: () => number;
}

export interface MailSuccess {
	ok: true;
	messages: LegionMessage[];
	recipients: string[];
	subjectBytes: number;
	bodyBytes: number;
	warning?: string;
}

export interface MailDenied {
	ok: false;
	code: "forbidden" | "subject_too_large" | "body_too_large" | "rate_limited" | "recipient_not_found";
	message: string;
	fromNode: string;
	to?: string;
	routingHint?: string;
}

export type MailResult = MailSuccess | MailDenied;

export interface MailTargetResolution {
	recipients: string[];
	denied: Array<Pick<MailDenied, "to" | "code" | "message" | "routingHint">>;
}

export function resolveMailTargets(
	db: DatabaseSync,
	fromNode: string,
	target: string | readonly string[],
): MailTargetResolution {
	const sender = getNode(db, fromNode);
	if (!sender) {
		return {
			recipients: [],
			denied: [{ to: fromNode, code: "recipient_not_found", message: `sender node not found: ${fromNode}` }],
		};
	}
	const tokens = typeof target === "string" ? [target] : [...target];
	const recipients: string[] = [];
	const denied: MailTargetResolution["denied"] = [];
	for (const token of tokens) {
		if (token === "children") {
			recipients.push(
				...getSubtree(db, sender.id, { includeRoot: false, maxDepth: 1 }).map((node) => node.id),
			);
			continue;
		}
		if (token === "squad") {
			if (sender.role === "centurion" || sender.parentId === null) {
				recipients.push(
					...getSubtree(db, sender.id, { includeRoot: false, maxDepth: 1 }).map((node) => node.id),
				);
			} else if (sender.parentId) {
				recipients.push(sender.parentId);
				recipients.push(
					...getSubtree(db, sender.parentId, { includeRoot: false, maxDepth: 1 })
						.map((node) => node.id)
						.filter((id) => id !== sender.id),
				);
			}
			continue;
		}
		if (token === "parent") {
			if (sender.parentId) recipients.push(sender.parentId);
			else denied.push({ to: token, code: "recipient_not_found", message: "root node has no parent" });
			continue;
		}
		const recipient = resolveRecipient(db, sender, token);
		if (recipient.ok) recipients.push(recipient.node.id);
		else denied.push(recipient.denial);
	}
	return { recipients: [...new Set(recipients)].filter((id) => id !== fromNode), denied };
}

export function sendMail(
	db: DatabaseSync,
	input: SendMailInput,
	options: SendMailOptions = {},
): MailResult {
	const sender = getNode(db, input.fromNode);
	if (!sender) {
		return {
			ok: false,
			code: "recipient_not_found",
			message: `sender node not found: ${input.fromNode}`,
			fromNode: input.fromNode,
		};
	}
	if (typeof input.subject !== "string" || input.subject.trim().length === 0) {
		return { ok: false, code: "forbidden", message: "mail subject must not be empty", fromNode: input.fromNode };
	}
	const subjectBytes = Buffer.byteLength(input.subject, "utf8");
	if (subjectBytes > MAIL_SUBJECT_HARD_LIMIT_BYTES) {
		return {
			ok: false,
			code: "subject_too_large",
			message: `mail subject is ${subjectBytes} bytes; hard limit is ${MAIL_SUBJECT_HARD_LIMIT_BYTES} bytes`,
			fromNode: input.fromNode,
		};
	}
	if (typeof input.body !== "string") {
		return { ok: false, code: "forbidden", message: "mail body must be a string", fromNode: input.fromNode };
	}
	const bodyBytes = Buffer.byteLength(input.body, "utf8");
	if (bodyBytes > MAIL_BODY_HARD_LIMIT_BYTES) {
		return {
			ok: false,
			code: "body_too_large",
			message: `mail body is ${bodyBytes} bytes; hard limit is ${MAIL_BODY_HARD_LIMIT_BYTES} bytes`,
			fromNode: input.fromNode,
		};
	}
	if (input.kind !== undefined && !isMailKind(input.kind)) {
		return { ok: false, code: "forbidden", message: `invalid mail kind: ${String(input.kind)}`, fromNode: input.fromNode };
	}
	const urgency = input.urgency ?? "info";
	if (urgency !== "info" && urgency !== "action-needed") {
		return { ok: false, code: "forbidden", message: `invalid mail urgency: ${String(urgency)}`, fromNode: input.fromNode };
	}
	const resolution = resolveMailTargets(db, input.fromNode, input.to);
	if (resolution.denied.length > 0) {
		const refusal = resolution.denied[0]!;
		return {
			ok: false,
			code: refusal.code,
			message: refusal.message,
			fromNode: input.fromNode,
			...(refusal.to ? { to: refusal.to } : {}),
			...(refusal.routingHint ? { routingHint: refusal.routingHint } : {}),
		};
	}
	if (resolution.recipients.length === 0) {
		return { ok: false, code: "recipient_not_found", message: "mail target expansion produced no recipients", fromNode: input.fromNode };
	}
	const now = options.now ?? (() => Date.now());
	const timestamp = now();
	if (!Number.isFinite(timestamp)) throw new TypeError("mail clock must return a finite millisecond timestamp");
	const rate = options.ratePer5Min ?? DEFAULT_MAIL_RATE_PER_5_MIN;
	if (!Number.isSafeInteger(rate) || rate < 1) throw new TypeError("ratePer5Min must be a positive integer");
	const warning = bodyBytes > MAIL_BODY_SOFT_LIMIT_BYTES
		? `mail body is ${bodyBytes} bytes; bodies above ${MAIL_BODY_SOFT_LIMIT_BYTES} bytes may be better shared as a file`
		: undefined;

	return withTransaction(db, () => {
		const recent = db
			.prepare("SELECT COUNT(*) AS count FROM messages WHERE from_node = ? AND created_at > ?")
			.get(input.fromNode, timestamp - MAIL_RATE_WINDOW_MS);
		const count = Number(recent?.count ?? 0);
		if (count + resolution.recipients.length > rate) {
			return {
				ok: false,
				code: "rate_limited",
				message: `mail rate exceeded: ${rate} message(s) per five minutes`,
				fromNode: input.fromNode,
			};
		}
		const messages: LegionMessage[] = [];
		for (const toNode of resolution.recipients) {
			const insert = db
				.prepare(
					`INSERT INTO messages (
						from_node, to_node, subject, body, kind, urgency, delivered, created_at
					) VALUES (?, ?, ?, ?, ?, ?, 0, ?)`,
				)
				.run(input.fromNode, toNode, input.subject, input.body, input.kind ?? null, urgency, timestamp);
			const message = getMessage(db, Number(insert.lastInsertRowid));
			if (!message) throw new Error("inserted mail could not be read");
			appendEvent(db, input.fromNode, "mail_sent", { messageId: message.id, toNode }, { now: () => timestamp });
			messages.push(message);
		}
		return {
			ok: true,
			messages,
			recipients: messages.map((message) => message.toNode),
			subjectBytes,
			bodyBytes,
			...(warning ? { warning } : {}),
		};
	});
}

export function getMessage(db: DatabaseSync, id: number): LegionMessage | null {
	if (!Number.isSafeInteger(id) || id < 1) throw new TypeError("message id must be a positive safe integer");
	const row = db.prepare("SELECT * FROM messages WHERE id = ?").get(id);
	return row ? mapMessage(row) : null;
}

/**
 * Newest-id-last page of one recipient's inbox.
 *
 * `afterId` is the rotation cursor the postman's confirmation scan keeps per seam
 * (#338 M3): `id > afterId` is the next page, and a page past the tail wraps to the
 * head. Without it every tick re-read the same oldest 20 rows, so 20 undecidable
 * `ACCEPTED` messages could occupy the window forever and starve the rest.
 */
export function inbox(
	db: DatabaseSync,
	toNode: string,
	options: { delivery?: MailDeliveryStatus; limit?: number; afterId?: number } = {},
): LegionMessage[] {
	if (!toNode) throw new TypeError("toNode must be a non-empty node id");
	const limit = options.limit ?? 100;
	if (!Number.isSafeInteger(limit) || limit < 1) throw new TypeError("inbox limit must be a positive safe integer");
	const afterId = options.afterId ?? 0;
	if (!Number.isSafeInteger(afterId) || afterId < 0) throw new TypeError("inbox afterId must be a non-negative safe integer");
	const rows = options.delivery === undefined
		? db.prepare("SELECT * FROM messages WHERE to_node = ? AND id > ? ORDER BY id LIMIT ?").all(toNode, afterId, limit)
		: db.prepare("SELECT * FROM messages WHERE to_node = ? AND delivered = ? AND id > ? ORDER BY id LIMIT ?").all(toNode, options.delivery, afterId, limit);
	return rows.map(mapMessage);
}

export function pendingInbox(db: DatabaseSync, toNode: string, limit = 100): LegionMessage[] {
	return inbox(db, toNode, { delivery: MAIL_DELIVERY.PENDING, limit });
}

/**
 * Which state may follow which (schema v2, #322). Everything downstream of
 * ACCEPTED is terminal on purpose: once the ledger knows the outcome, a later
 * tick must not rewrite history.
 */
const MAIL_DELIVERY_TRANSITIONS: Record<number, readonly MailDeliveryStatus[]> = {
	[MAIL_DELIVERY.PENDING]: [MAIL_DELIVERY.ACCEPTED, MAIL_DELIVERY.BOUNCED, MAIL_DELIVERY.OBSOLETE],
	[MAIL_DELIVERY.ACCEPTED]: [MAIL_DELIVERY.DELIVERED, MAIL_DELIVERY.OBSOLETE],
	[MAIL_DELIVERY.BOUNCED]: [],
	[MAIL_DELIVERY.DELIVERED]: [],
	[MAIL_DELIVERY.OBSOLETE]: [],
};

export type MailDeliveryTarget = Exclude<MailDeliveryStatus, typeof MAIL_DELIVERY.PENDING>;

export interface TransitionDeliveryOptions {
	/** `data.reason` on the `mail_bounced` event (the obsolete verdict reuses that type). */
	reason?: MailBounceReason | string;
}

/**
 * Move one message along the delivery state machine.
 *
 * Legal edges (#322): pending → accepted | bounced | obsolete, accepted →
 * delivered | obsolete. Repeating a transition that already happened is a no-op
 * that writes nothing, which is what makes the postman's confirmation scan
 * idempotent across ticks.
 *
 * Events: `accepted` writes none — `sendMail` already recorded `mail_sent` for
 * the message, and a second row would duplicate that fact; `delivered` writes
 * `mail_delivered`; `bounced`/`obsolete` write `mail_bounced` (the event set is
 * closed at 16, so `obsolete` reuses `mail_bounced` with a `reason`).
 */
export function transitionDelivery(
	db: DatabaseSync,
	messageId: number,
	next: MailDeliveryTarget,
	now: () => number = () => Date.now(),
	options: TransitionDeliveryOptions = {},
): LegionMessage {
	if (
		!Number.isSafeInteger(messageId) ||
		messageId < 1 ||
		(next !== MAIL_DELIVERY.ACCEPTED &&
			next !== MAIL_DELIVERY.BOUNCED &&
			next !== MAIL_DELIVERY.DELIVERED &&
			next !== MAIL_DELIVERY.OBSOLETE)
	) {
		throw new TypeError("invalid message delivery transition");
	}
	const timestamp = now();
	if (!Number.isFinite(timestamp)) throw new TypeError("delivery clock must return a finite timestamp");
	return withTransaction(db, () => {
		const current = getMessage(db, messageId);
		if (!current) throw new Error(`message not found: ${messageId}`);
		const recipient = getNode(db, current.toNode);
		// A send "succeeded" into a dead inbox: the recipient can never consume it.
		const actualNext = next === MAIL_DELIVERY.ACCEPTED && (recipient === null || isTerminalNode(recipient))
			? MAIL_DELIVERY.BOUNCED
			: next;
		// Idempotent: same target twice writes no row and no event.
		if (current.delivered === actualNext) return current;
		if (!(MAIL_DELIVERY_TRANSITIONS[current.delivered] ?? []).includes(actualNext)) {
			throw new InvalidDeliveryTransitionError(current.delivered, actualNext);
		}
		const update = db
			.prepare("UPDATE messages SET delivered = ?, delivered_at = ? WHERE id = ? AND delivered = ?")
			.run(actualNext, timestamp, messageId, current.delivered);
		if (Number(update.changes) === 0) {
			const raced = getMessage(db, messageId);
			if (raced && raced.delivered === actualNext) return raced;
			throw new InvalidDeliveryTransitionError((raced ?? current).delivered, actualNext);
		}
		const updated = getMessage(db, messageId);
		if (!updated) throw new Error(`message not found: ${messageId}`);
		const reason = options.reason ?? (actualNext === MAIL_DELIVERY.OBSOLETE
			? MAIL_BOUNCE_REASON.OBSOLETE_AFTER_PHASE_CHANGE
			: undefined);
		if (actualNext === MAIL_DELIVERY.DELIVERED) {
			appendEvent(db, updated.fromNode, "mail_delivered", { messageId: updated.id, toNode: updated.toNode }, { now: () => timestamp });
		} else if (actualNext === MAIL_DELIVERY.BOUNCED || actualNext === MAIL_DELIVERY.OBSOLETE) {
			appendEvent(
				db,
				updated.fromNode,
				"mail_bounced",
				{ messageId: updated.id, toNode: updated.toNode, ...(reason ? { reason } : {}) },
				{ now: () => timestamp },
			);
		}
		// Only a send-side bounce owes the sender a receipt mail. `obsolete` is not a
		// failure at all, and a post-acceptance bounce would be a reply to a letter
		// the sender already watched leave.
		if (actualNext === MAIL_DELIVERY.BOUNCED && current.delivered === MAIL_DELIVERY.PENDING) {
			db.prepare(
				`INSERT INTO messages (
					from_node, to_node, subject, body, kind, urgency, delivered, created_at
				) VALUES (?, ?, ?, ?, 'notice', 'info', 0, ?)`,
			).run(
				updated.toNode,
				updated.fromNode,
				`Delivery bounced: ${updated.subject}`,
				reason === MAIL_BOUNCE_REASON.INTERCEPTED_BY_INPUT_HANDLER
					? `Message ${updated.id} was intercepted by the recipient's input handler and never reached it; re-send it if it still matters.`
					: `Message ${updated.id} could not be delivered because the recipient is terminal.`,
				timestamp,
			);
		}
		return updated;
	});
}

/**
 * The exact text the postman injects for a message.
 *
 * Lives here (not in the extension) because the DELIVERED criterion has to compare
 * against the very string that was handed to the child — see
 * {@link mailMatchesUserText}.
 */
export function formatMail(message: LegionMessage): string {
	return [`[legion mail #${message.id}]`, `From: ${message.fromNode}`, `Subject: ${message.subject}`, `Urgency: ${message.urgency}`, "", message.body].join("\n");
}

/**
 * Frozen DELIVERED criterion (#322 D3, narrowed by #338 M2): **exact string
 * equality with the injected envelope**, never a substring, prefix, trimmed or
 * fuzzy comparison.
 *
 * The one accepted form is {@link formatMail} — the exact text the postman hands
 * to the child. The envelope embeds the message id, so an unrelated user turn can
 * only collide by reproducing the whole envelope.
 *
 * A bare `body` match is deliberately NOT accepted (#338 M2): the body carries no
 * id and no envelope, so "this sentence appears somewhere in a user turn" is true
 * for a task card, a quoted report, or a sibling copy of the same text. That is a
 * mention, not a read — and a `DELIVERED` the ledger cannot prove is exactly the
 * defect #322 set out to remove (a task text equal to a mail body was the concrete
 * false positive).
 *
 * Why not something weaker still: a child quotes mail back in its own turns
 * constantly (reports, verdicts, review notes). Any containment-based test would
 * mark a message delivered because the child *mentioned* a line of it, and the
 * whole point of the state is to answer "did the child see this?" with a fact.
 */
export function mailMatchesUserText(userText: string, message: LegionMessage): boolean {
	return userText === formatMail(message);
}

/**
 * True when the recipient's session shows this mail in one of its last
 * {@link MAIL_DELIVERY_TURN_WINDOW} user turns. Callers parse the session file;
 * this stays pure so the criterion is unit-testable without any file IO.
 */
export function mailReachedTurns(
	turns: readonly Pick<TurnRecord, "userText">[],
	message: LegionMessage,
): boolean {
	return turns
		.slice(-MAIL_DELIVERY_TURN_WINDOW)
		.some((turn) => mailMatchesUserText(turn.userText, message));
}

/**
 * #333: is this a `Phase timeout:` notice that has already outlived its subject?
 *
 * Only `kind: "notice"` with the frozen subject prefix is eligible. The mail kind
 * domain is `question | report | handoff | notice` (#338 M4 — there is no
 * `instruction` kind), and every other kind is a human judgement call that is
 * never auto-obsoleted: whether a question or a handed-over task went stale is not
 * a ledger fact.
 *
 * The timed-out node is the message's *sender*: `checkOwnPhaseTimeout` mails the
 * parent about its own phase. The phase it timed out in is recovered from the
 * `phase_timeout` event that produced the notice (never by parsing the body), so
 * "left that phase" is a ledger fact: the node has ended (terminal, or
 * `settled`/`retired` — #354), or its current `phase`/`phase_since` differ from
 * the recorded ones. `phase_since` is compared too, so re-entering the same phase
 * later does not resurrect the old notice.
 *
 * #354: the "has ended" arm must ask {@link hasEnded}, not `isTerminalNode`. A
 * team that only investigated never calls `legion_phase`, so it ends
 * `settled`/`retired` while its phase and `phase_since` are untouched — the two
 * older predicates both said "still current" and an `action-needed` about a team
 * whose work had already merged was delivered 30 minutes later.
 */
export function isStalePhaseTimeoutNotice(db: DatabaseSync, message: LegionMessage): boolean {
	if (message.kind !== "notice") return false;
	if (!message.subject.startsWith(PHASE_TIMEOUT_MAIL_SUBJECT_PREFIX)) return false;
	const timedOut = getNode(db, message.fromNode);
	if (!timedOut) return false;
	if (hasEnded(timedOut)) return true;
	const row = db
		.prepare(
			"SELECT data FROM events WHERE node_id = ? AND type = 'phase_timeout' AND ts <= ? ORDER BY ts DESC, id DESC LIMIT 1",
		)
		.get(message.fromNode, message.createdAt);
	let data: Record<string, unknown> | null = null;
	if (typeof row?.data === "string") {
		try {
			data = JSON.parse(row.data) as Record<string, unknown>;
		} catch {
			data = null;
		}
	}
	if (data === null) return false; // No recorded stint: stay ACCEPTED, never guess.
	const phase = typeof data.phase === "string" ? data.phase : null;
	if (phase === null) return false;
	if (timedOut.phase !== phase) return true;
	const phaseSince = typeof data.phaseSince === "number" ? data.phaseSince : null;
	return phaseSince !== null && timedOut.phaseSince !== phaseSince;
}

export interface MailboxStats {
	pending: number;
	accepted: number;
	delivered: number;
	bounced: number;
	obsolete: number;
}

/**
 * Read-only five-value census of one node's inbox (#322 D5).
 *
 * Nothing renders this yet: D5 asks for the export and its unit test, not for a
 * caller. It is the query a future `/legion` status or doctor reader would use —
 * please do not describe it as already wired to one (#338 minor 4). Unknown
 * `delivered` values (a newer ledger written by another process) are left out of
 * the census rather than crashing the reader.
 */
export function mailboxStats(db: DatabaseSync, nodeId: string): MailboxStats {
	if (!nodeId) throw new TypeError("nodeId must be a non-empty node id");
	const rows = db
		.prepare("SELECT delivered, COUNT(*) AS count FROM messages WHERE to_node = ? GROUP BY delivered")
		.all(nodeId);
	const stats: MailboxStats = { pending: 0, accepted: 0, delivered: 0, bounced: 0, obsolete: 0 };
	for (const row of rows) {
		const count = Number(row.count ?? 0);
		switch (Number(row.delivered)) {
			case MAIL_DELIVERY.PENDING:
				stats.pending += count;
				break;
			case MAIL_DELIVERY.ACCEPTED:
				stats.accepted += count;
				break;
			case MAIL_DELIVERY.BOUNCED:
				stats.bounced += count;
				break;
			case MAIL_DELIVERY.DELIVERED:
				stats.delivered += count;
				break;
			case MAIL_DELIVERY.OBSOLETE:
				stats.obsolete += count;
				break;
			default:
				break;
		}
	}
	return stats;
}

export class InvalidDeliveryTransitionError extends Error {
	constructor(current: MailDeliveryStatus, next: MailDeliveryStatus) {
		super(`mail delivery cannot transition from ${current} to ${next}`);
		this.name = "InvalidDeliveryTransitionError";
	}
}

function isMailKind(value: unknown): value is MailKind {
	return value === "question" || value === "report" || value === "handoff" || value === "notice";
}

function resolveRecipient(
	db: DatabaseSync,
	sender: LegionNode,
	token: string,
):
	| { ok: true; node: LegionNode }
	| { ok: false; denial: Pick<MailDenied, "to" | "code" | "message" | "routingHint"> } {
	const target = getNode(db, token) ?? resolveShortName(db, sender, token);
	if (!target) {
		return {
			ok: false,
			denial: { to: token, code: "recipient_not_found", message: `mail recipient not found: ${token}` },
		};
	}
	if (target.id === sender.parentId || target.parentId === sender.id) return { ok: true, node: target };
	if (sender.parentId !== null && target.parentId === sender.parentId && target.id !== sender.id) {
		return { ok: true, node: target };
	}
	if (!isSameSquad(sender, target)) {
		return {
			ok: false,
			denial: {
				to: token,
				code: "forbidden",
				message: "mail across subtrees is not allowed",
				routingHint: `ask ${sender.parentId ?? "root"} or ${target.parentId ?? "root"} to relay this message`,
			},
		};
	}
	return {
		ok: false,
		denial: {
			to: token,
			code: "forbidden",
			message: "mail may only target your parent, direct children, or siblings",
			routingHint: `route the request through ${sender.parentId ?? "root"}`,
		},
	};
}

function resolveShortName(db: DatabaseSync, sender: LegionNode, name: string): LegionNode | null {
	const slug = sanitizeNodeSlug(name);
	const child = db.prepare("SELECT * FROM nodes WHERE parent_id = ? AND name = ? LIMIT 1").get(sender.id, slug);
	if (child) return mapNode(child);
	if (!sender.parentId) return null;
	const sibling = db.prepare("SELECT * FROM nodes WHERE parent_id = ? AND name = ? LIMIT 1").get(sender.parentId, slug);
	if (sibling) return mapNode(sibling);
	const parent = db.prepare("SELECT * FROM nodes WHERE id = ? AND name = ? LIMIT 1").get(sender.parentId, slug);
	return parent ? mapNode(parent) : null;
}

function isSameSquad(left: LegionNode, right: LegionNode): boolean {
	return left.parentId !== null && left.parentId === right.parentId;
}

function mapMessage(row: SqliteRow): LegionMessage {
	return {
		id: Number(row.id),
		fromNode: String(row.from_node),
		toNode: String(row.to_node),
		subject: String(row.subject),
		body: String(row.body),
		kind: row.kind === null ? null : String(row.kind),
		urgency: String(row.urgency) as MailUrgency,
		delivered: Number(row.delivered) as MailDeliveryStatus,
		deliveredAt: row.delivered_at === null ? null : Number(row.delivered_at),
		createdAt: Number(row.created_at),
	};
}

function mapNode(row: SqliteRow): LegionNode {
	return {
		id: String(row.id),
		parentId: row.parent_id === null ? null : String(row.parent_id),
		name: String(row.name),
		role: String(row.role),
		kind: String(row.kind),
		depth: Number(row.depth),
		runId: row.run_id === null ? null : String(row.run_id),
		sessionFile: row.session_file === null ? null : String(row.session_file),
		worktreePath: row.worktree_path === null ? null : String(row.worktree_path),
		model: row.model === null ? null : String(row.model),
		team: row.team === null ? null : String(row.team),
		status: String(row.status) as LegionNode["status"],
		phase: row.phase === null ? null : String(row.phase),
		phaseSince: row.phase_since === null ? null : Number(row.phase_since),
		reworkCount: Number(row.rework_count),
		contractPath: row.contract_path === null ? null : String(row.contract_path),
		taskSummary: row.task_summary === null ? null : String(row.task_summary),
		createdAt: Number(row.created_at),
		updatedAt: Number(row.updated_at),
	};
}
