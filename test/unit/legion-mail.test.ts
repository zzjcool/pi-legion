import { test } from "node:test";
import assert from "node:assert/strict";
import { openLegionDb } from "../../src/legion/db.ts";
import {
	MAIL_BODY_HARD_LIMIT_BYTES,
	MAIL_BODY_SOFT_LIMIT_BYTES,
	MAIL_DELIVERY,
	inbox,
	pendingInbox,
	resolveMailTargets,
	sendMail,
	transitionDelivery,
} from "../../src/legion/mail.ts";
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
