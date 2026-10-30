import { test } from "node:test";
import assert from "node:assert/strict";
import { openLegionDb } from "../../src/legion/db.ts";
import {
	MAIL_BODY_HARD_LIMIT_BYTES,
	MAIL_BODY_SOFT_LIMIT_BYTES,
	MAIL_DELIVERY,
	formatMail,
	inbox,
	mailMatchesUserText,
	mailReachedTurns,
	mailboxStats,
	pendingInbox,
	resolveMailTargets,
	sendMail,
	transitionDelivery,
	type LegionMessage,
} from "../../src/legion/mail.ts";
import { readEventsAfter } from "../../src/legion/events.ts";
import { insertNode, updateNode } from "../../src/legion/nodes.ts";

function makeTree() {
	const db = openLegionDb(":memory:");
	insertNode(db, { parentId: null, name: "root", role: "root" });
	insertNode(db, { parentId: "root", name: "team-a", role: "centurion" });
	insertNode(db, { parentId: "root", name: "team-b", role: "centurion" });
	insertNode(db, { parentId: "root.team-a", name: "alice", role: "worker" });
	insertNode(db, { parentId: "root.team-a", name: "bob", role: "reviewer" });
	insertNode(db, { parentId: "root.team-a", name: "deep", role: "centurion" });
	insertNode(db, { parentId: "root.team-a.deep", name: "leaf", role: "worker" });
	insertNode(db, { parentId: "root.team-b", name: "cora", role: "worker" });
	return db;
}

test("mail permission matrix allows parent, child, and same-parent sibling targets", () => {
	const db = makeTree();
	try {
		for (const [fromNode, to] of [
			["root.team-a.alice", "parent"],
			["root.team-a", "alice"],
			["root.team-a.alice", "bob"],
			["root.team-a.deep", "root.team-a"],
		] as const) {
			assert.equal(sendMail(db, { fromNode, to, subject: "hello", body: "message" }, { now: () => 100 }).ok, true);
		}
		assert.equal(inbox(db, "root.team-a").length, 2);
		insertNode(db, { parentId: "root.team-a", name: "Alice Helper", role: "worker" });
		const normalizedShortName = sendMail(db, {
			fromNode: "root.team-a", to: "ALICE Helper", subject: "normalized", body: "slug lookup",
		});
		assert.equal(normalizedShortName.ok, true);
		assert.equal(inbox(db, "root.team-a.alice-helper").length, 1);
	} finally {
		db.close();
	}
});

test("mail refuses cousins, deep descendants, and direct root jumps with route hints", () => {
	const db = makeTree();
	try {
		for (const to of ["root.team-b.cora", "root.team-a.deep.leaf", "root"]) {
			const result = sendMail(db, { fromNode: "root.team-a.alice", to, subject: "no", body: "x" });
			assert.equal(result.ok, false);
			if (!result.ok) {
				assert.equal(result.code, "forbidden");
				assert.ok(result.routingHint);
			}
		}
		assert.equal(
			resolveMailTargets(db, "root.team-a.alice", "root.team-b.cora").denied[0]?.routingHint,
			"ask root.team-a or root.team-b to relay this message",
		);
	} finally {
		db.close();
	}
});

test("mail broadcasts expand children and squad without duplicate or self delivery", () => {
	const db = makeTree();
	try {
		assert.deepEqual(resolveMailTargets(db, "root.team-a", "children").recipients, [
			"root.team-a.alice", "root.team-a.bob", "root.team-a.deep",
		]);
		assert.deepEqual(resolveMailTargets(db, "root.team-a.alice", "squad").recipients, [
			"root.team-a", "root.team-a.bob", "root.team-a.deep",
		]);
		assert.deepEqual(resolveMailTargets(db, "root.team-a.alice", ["parent", "squad"]).recipients, [
			"root.team-a", "root.team-a.bob", "root.team-a.deep",
		]);
	} finally {
		db.close();
	}
});

test("mail validates the 256-byte subject ceiling and kind whitelist", () => {
	const db = makeTree();
	try {
		const maxSubject = sendMail(db, {
			fromNode: "root.team-a", to: "alice", subject: "é".repeat(128), body: "ok",
		});
		assert.equal(maxSubject.ok, true, "exactly 256 UTF-8 bytes is allowed");

		const oversized = sendMail(db, {
			fromNode: "root.team-a", to: "alice", subject: "é".repeat(129), body: "must be refused",
		});
		assert.equal(oversized.ok, false);
		if (!oversized.ok) assert.equal(oversized.code, "subject_too_large");

		const invalidKind = sendMail(db, {
			fromNode: "root.team-a", to: "alice", subject: "valid", body: "body", kind: "spoofed" as never,
		});
		assert.equal(invalidKind.ok, false);
		if (!invalidKind.ok) assert.equal(invalidKind.code, "forbidden");
	} finally {
		db.close();
	}
});

test("mail applies 4KB soft warning, 32KB hard rejection, and per-node rate limit", () => {
	const db = makeTree();
	try {
		const soft = sendMail(db, {
			fromNode: "root.team-a", to: "children", subject: "large",
			body: "x".repeat(MAIL_BODY_SOFT_LIMIT_BYTES + 1),
		}, { now: () => 100 });
		assert.equal(soft.ok, true);
		if (soft.ok) assert.ok(soft.warning);
		const hard = sendMail(db, {
			fromNode: "root.team-a", to: "alice", subject: "hard",
			body: "x".repeat(MAIL_BODY_HARD_LIMIT_BYTES + 1),
		});
		assert.equal(hard.ok, false);
		if (!hard.ok) assert.equal(hard.code, "body_too_large");
		for (let index = 0; index < 10; index += 1) {
			assert.equal(sendMail(db, {
				fromNode: "root.team-a.alice", to: "parent", subject: String(index), body: "x",
			}, { now: () => 10_000 + index }).ok, true);
		}
		const over = sendMail(db, {
			fromNode: "root.team-a.alice", to: "parent", subject: "11", body: "x",
		}, { now: () => 10_020 });
		assert.equal(over.ok, false);
		if (!over.ok) assert.equal(over.code, "rate_limited");
	} finally {
		db.close();
	}
});

test("settled nodes can resume through mail; terminal recipients bounce with receipt", () => {
	const db = makeTree();
	try {
		updateNode(db, "root.team-a.alice", { status: "settled" });
		const first = sendMail(db, {
			fromNode: "root.team-a", to: "alice", subject: "task", body: "do it",
		}, { now: () => 50 });
		assert.equal(first.ok, true);
		if (!first.ok) return;
		assert.equal(pendingInbox(db, "root.team-a.alice").length, 1);
		const injected = transitionDelivery(db, first.messages[0]!.id, MAIL_DELIVERY.INJECTED, () => 60);
		assert.equal(injected.delivered, MAIL_DELIVERY.INJECTED);
		assert.equal(injected.deliveredAt, 60);
		assert.equal(transitionDelivery(db, injected.id, MAIL_DELIVERY.INJECTED).id, injected.id);
		assert.throws(() => transitionDelivery(db, injected.id, MAIL_DELIVERY.BOUNCED), /cannot transition/);
		const second = sendMail(db, { fromNode: "root.team-a", to: "alice", subject: "again", body: "body" }, { now: () => 100 });
		assert.equal(second.ok, true);
		if (!second.ok) return;
		updateNode(db, "root.team-a.alice", { status: "failed" });
		const bounced = transitionDelivery(db, second.messages[0]!.id, MAIL_DELIVERY.INJECTED, () => 110);
		assert.equal(bounced.delivered, MAIL_DELIVERY.BOUNCED);
		assert.equal(inbox(db, "root.team-a.alice", { delivery: MAIL_DELIVERY.BOUNCED }).length, 1);
		assert.equal(inbox(db, "root.team-a", { delivery: MAIL_DELIVERY.PENDING }).length, 1);
	} finally {
		db.close();
	}
});

test("delivery states form a five-value domain with the frozen legal edges (#322)", () => {
	const db = makeTree();
	try {
		// The old name is kept only as an alias for out-of-tree imports.
		assert.equal(MAIL_DELIVERY.INJECTED, MAIL_DELIVERY.ACCEPTED);
		const first = sendMail(db, { fromNode: "root.team-a", to: "alice", subject: "s", body: "b" }, { now: () => 10 });
		const second = sendMail(db, { fromNode: "root.team-a", to: "alice", subject: "t", body: "c" }, { now: () => 11 });
		assert.equal(first.ok && second.ok, true);
		if (!first.ok || !second.ok) return;
		const acceptedId = first.messages[0]!.id;
		const bouncedId = second.messages[0]!.id;

		assert.equal(inbox(db, "root.team-a.alice", { delivery: MAIL_DELIVERY.PENDING }).length, 2);
		transitionDelivery(db, acceptedId, MAIL_DELIVERY.ACCEPTED, () => 20);
		assert.equal(inbox(db, "root.team-a.alice", { delivery: MAIL_DELIVERY.ACCEPTED }).length, 1);
		// ACCEPTED writes no event of its own: `mail_sent` already recorded the send.
		assert.equal(readEventsAfter(db, 0).filter((event) => event.type === "mail_delivered" || event.type === "mail_bounced").length, 0);
		// …and it is terminal for the send path: a bounce here would rewrite history.
		assert.throws(() => transitionDelivery(db, acceptedId, MAIL_DELIVERY.BOUNCED), /cannot transition from 1 to 2/);

		transitionDelivery(db, acceptedId, MAIL_DELIVERY.DELIVERED, () => 30);
		assert.equal(inbox(db, "root.team-a.alice", { delivery: MAIL_DELIVERY.DELIVERED }).length, 1);
		assert.equal(readEventsAfter(db, 0).filter((event) => event.type === "mail_delivered").length, 1);
		// Repeating the same terminal verdict is a no-op, event included.
		transitionDelivery(db, acceptedId, MAIL_DELIVERY.DELIVERED, () => 31);
		assert.equal(readEventsAfter(db, 0).filter((event) => event.type === "mail_delivered").length, 1);
		assert.throws(() => transitionDelivery(db, acceptedId, MAIL_DELIVERY.OBSOLETE), /cannot transition from 3 to 4/);

		// A queued message can lose its meaning before anyone hands it over (#333).
		transitionDelivery(db, bouncedId, MAIL_DELIVERY.OBSOLETE, () => 40);
		const bouncedEvents = readEventsAfter(db, 0).filter((event) => event.type === "mail_bounced");
		assert.equal(bouncedEvents.length, 1);
		assert.deepEqual(bouncedEvents[0]!.data, {
			messageId: bouncedId,
			toNode: "root.team-a.alice",
			reason: "obsolete_after_phase_change",
		}, "obsolete reuses mail_bounced with its own reason instead of adding an event type");
	} finally {
		db.close();
	}
});

test("mailboxStats reports the five delivery states per recipient (#322)", () => {
	const db = makeTree();
	try {
		const ids: number[] = [];
		for (let i = 0; i < 5; i += 1) {
			const result = sendMail(db, { fromNode: "root.team-a", to: "alice", subject: `m${i}`, body: `body ${i}` }, { now: () => 100 + i });
			assert.equal(result.ok, true);
			if (result.ok) ids.push(result.messages[0]!.id);
		}
		transitionDelivery(db, ids[1]!, MAIL_DELIVERY.ACCEPTED, () => 200);
		transitionDelivery(db, ids[2]!, MAIL_DELIVERY.BOUNCED, () => 201);
		transitionDelivery(db, ids[3]!, MAIL_DELIVERY.ACCEPTED, () => 202);
		transitionDelivery(db, ids[3]!, MAIL_DELIVERY.DELIVERED, () => 203);
		transitionDelivery(db, ids[4]!, MAIL_DELIVERY.OBSOLETE, () => 204);
		assert.deepEqual(mailboxStats(db, "root.team-a.alice"), {
			pending: 1,
			accepted: 1,
			delivered: 1,
			bounced: 1,
			obsolete: 1,
		});
		assert.deepEqual(mailboxStats(db, "root.team-a.bob"), {
			pending: 0,
			accepted: 0,
			delivered: 0,
			bounced: 0,
			obsolete: 0,
		});
	} finally {
		db.close();
	}
});

test("the DELIVERED criterion is an exact match over the last 20 turns (#322)", () => {
	const message: LegionMessage = {
		id: 7,
		fromNode: "root.team-a",
		toNode: "root.team-a.alice",
		subject: "scope",
		body: "line one\nline two",
		kind: "notice",
		urgency: "info",
		delivered: MAIL_DELIVERY.ACCEPTED,
		deliveredAt: null,
		createdAt: 1,
	};
	assert.equal(mailMatchesUserText(formatMail(message), message), true, "the injected envelope proves delivery");
	assert.equal(mailMatchesUserText(message.body, message), true, "so does a verbatim body");
	assert.equal(mailMatchesUserText(` ${formatMail(message)}`, message), false, "whitespace is never trimmed away");
	assert.equal(mailMatchesUserText(`${message.body} `, message), false);
	assert.equal(mailMatchesUserText("line one", message), false, "a line of the body is not the mail");
	assert.equal(
		mailMatchesUserText(`re: ${formatMail(message)}`, message),
		false,
		"a quoted envelope is a mention, not a read",
	);

	const filler = Array.from({ length: 20 }, (_, index) => ({ userText: `filler ${index}` }));
	const mailTurn = { userText: formatMail(message) };
	assert.equal(mailReachedTurns([...filler, mailTurn], message), true, "inside the window");
	assert.equal(
		mailReachedTurns([mailTurn, ...filler], message),
		false,
		"a mail older than the last 20 turns is not proof of consumption",
	);
});
