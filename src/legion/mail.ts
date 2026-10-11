import type { DatabaseSync, SqliteRow } from "./db.ts";
import { withTransaction } from "./db.ts";
import { appendEvent } from "./events.ts";
import { getNode, getSubtree, sanitizeNodeSlug, type LegionNode } from "./nodes.ts";

export const MAIL_SUBJECT_HARD_LIMIT_BYTES = 256;
export const MAIL_BODY_SOFT_LIMIT_BYTES = 4 * 1024;
export const MAIL_BODY_HARD_LIMIT_BYTES = 32 * 1024;
export const DEFAULT_MAIL_RATE_PER_5_MIN = 10;
export const MAIL_RATE_WINDOW_MS = 5 * 60 * 1_000;

export const MAIL_DELIVERY = {
	PENDING: 0,
	INJECTED: 1,
	BOUNCED: 2,
} as const;
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

export function inbox(
	db: DatabaseSync,
	toNode: string,
	options: { delivery?: MailDeliveryStatus; limit?: number } = {},
): LegionMessage[] {
	if (!toNode) throw new TypeError("toNode must be a non-empty node id");
	const limit = options.limit ?? 100;
	if (!Number.isSafeInteger(limit) || limit < 1) throw new TypeError("inbox limit must be a positive safe integer");
	const rows = options.delivery === undefined
		? db.prepare("SELECT * FROM messages WHERE to_node = ? ORDER BY id LIMIT ?").all(toNode, limit)
		: db.prepare("SELECT * FROM messages WHERE to_node = ? AND delivered = ? ORDER BY id LIMIT ?").all(toNode, options.delivery, limit);
	return rows.map(mapMessage);
}

export function pendingInbox(db: DatabaseSync, toNode: string, limit = 100): LegionMessage[] {
	return inbox(db, toNode, { delivery: MAIL_DELIVERY.PENDING, limit });
}

/** Pending messages can only become injected or bounced; repeating the same result is idempotent. */
export function transitionDelivery(
	db: DatabaseSync,
	messageId: number,
	next: Exclude<MailDeliveryStatus, typeof MAIL_DELIVERY.PENDING>,
	now: () => number = () => Date.now(),
): LegionMessage {
	if (
		!Number.isSafeInteger(messageId) ||
		messageId < 1 ||
		(next !== MAIL_DELIVERY.INJECTED && next !== MAIL_DELIVERY.BOUNCED)
	) {
		throw new TypeError("invalid message delivery transition");
	}
	const timestamp = now();
	if (!Number.isFinite(timestamp)) throw new TypeError("delivery clock must return a finite timestamp");
	return withTransaction(db, () => {
		const current = getMessage(db, messageId);
		if (!current) throw new Error(`message not found: ${messageId}`);
		const recipient = getNode(db, current.toNode);
		const terminal =
			recipient === null ||
			recipient.status === "failed" ||
			recipient.phase === "done" ||
			recipient.phase === "failed" ||
			recipient.phase === "aborted";
		const actualNext = next === MAIL_DELIVERY.INJECTED && terminal ? MAIL_DELIVERY.BOUNCED : next;
		const update = db
			.prepare("UPDATE messages SET delivered = ?, delivered_at = ? WHERE id = ? AND delivered = 0")
			.run(actualNext, timestamp, messageId);
		if (Number(update.changes) === 0) {
			if (current.delivered === actualNext) return current;
			throw new InvalidDeliveryTransitionError(current.delivered, actualNext);
		}
		const updated = getMessage(db, messageId);
		if (!updated) throw new Error(`message not found: ${messageId}`);
		const type = actualNext === MAIL_DELIVERY.INJECTED ? "mail_delivered" : "mail_bounced";
		appendEvent(db, updated.fromNode, type, { messageId: updated.id, toNode: updated.toNode }, { now: () => timestamp });
		if (actualNext === MAIL_DELIVERY.BOUNCED) {
			db.prepare(
				`INSERT INTO messages (
					from_node, to_node, subject, body, kind, urgency, delivered, created_at
				) VALUES (?, ?, ?, ?, 'notice', 'info', 0, ?)`,
			).run(
				updated.toNode,
				updated.fromNode,
				`Delivery bounced: ${updated.subject}`,
				`Message ${updated.id} could not be delivered because the recipient is terminal.`,
				timestamp,
			);
		}
		return updated;
	});
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
