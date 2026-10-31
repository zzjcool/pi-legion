/**
 * #354 — a `Phase timeout:` notice still reached its parent after the team had
 * ENDED IN THE VERY PHASE IT TIMED OUT IN.
 *
 * `isStalePhaseTimeoutNotice` asked `isTerminalNode`, which reads
 * `status === "failed" || phase ∈ {done,failed,aborted}`. A team that only
 * investigated (never called `legion_phase`) keeps its birth phase and ends with
 * `status: "settled"` / `"retired"` — neither predicate fires, `phase_since`
 * never moved either, so an `action-needed` about a team that no longer exists
 * was delivered 30 minutes after its work had merged.
 *
 * The frozen predicate is `hasEnded` (nodes.ts): terminal, or settled/retired.
 * `isTerminalNode` itself is deliberately NOT widened — mail bounce and the
 * orphan scan share it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { LegionPostman } from "../../src/extension/legion-tools.ts";
import { openLegionDb } from "../../src/legion/db.ts";
import { appendEvent, readEventsAfter } from "../../src/legion/events.ts";
import { MAIL_DELIVERY, inbox, pendingInbox, sendMail, transitionDelivery } from "../../src/legion/mail.ts";
import { insertNode, updateNode } from "../../src/legion/nodes.ts";
import { FakeSupervisor } from "../helpers/fake-supervisor.ts";

const NOTICE_AT = 1_000;
const TICK_AT = 5_001;

interface TimeoutFixture {
	db: ReturnType<typeof openLegionDb>;
	postman: LegionPostman;
	rootMessages: string[];
	messageId: number;
	stop(): void;
}

/**
 * A team root in `phase`, one `phase_timeout` event recorded for that exact
 * stint, and one `Phase timeout:` notice queued to root. `accepted` decides which
 * of the two obsolete paths the test exercises: the pre-delivery discard
 * (`PENDING`) or the confirmation pass (`ACCEPTED`).
 */
function fixture(phase: string, accepted: boolean): TimeoutFixture {
	const db = openLegionDb(":memory:");
	const supervisor = new FakeSupervisor();
	const rootMessages: string[] = [];
	insertNode(db, { parentId: null, name: "root", role: "root", status: "running" }, () => 1);
	insertNode(db, { parentId: "root", name: "team", role: "centurion", status: "running", phase, phaseSince: 100 }, () => 2);
	appendEvent(db, "root.team", "phase_timeout", { phase, phaseSince: 100, elapsedMs: 1_800_573, timeoutMs: 1_800_000 }, { now: () => NOTICE_AT });
	const mailed = sendMail(db, {
		fromNode: "root.team",
		to: "parent",
		subject: "Phase timeout: team",
		kind: "notice",
		urgency: "action-needed",
		body: `Legion phase timeout: root.team has been in ${phase} for 1800573ms (limit 1800000ms). Work was not killed; decide whether to extend or abort.`,
	}, { now: () => NOTICE_AT });
	assert.equal(mailed.ok, true);
	if (!mailed.ok) throw new Error("fixture could not queue the notice");
	const messageId = mailed.messages[0]!.id;
	if (accepted) transitionDelivery(db, messageId, MAIL_DELIVERY.ACCEPTED, () => NOTICE_AT);
	const postman = new LegionPostman({
		db, nodeId: "root", supervisor, now: () => TICK_AT,
		sendRootMessage: (text) => rootMessages.push(text), intervalMs: 10_000,
	});
	return { db, postman, rootMessages, messageId, stop: () => postman.stop() };
}

/** The `mail_bounced` rows for this notice — the obsolete verdict's only trace. */
function bounces(db: ReturnType<typeof openLegionDb>, messageId: number) {
	return readEventsAfter(db, 0).filter((event) => event.type === "mail_bounced" && (event.data as { messageId?: number }).messageId === messageId);
}

test("#354: a team that ended in the phase it timed out in (planning → retired) is obsoleted at confirmation", async () => {
	const fx = fixture("planning", true);
	try {
		// The reported shape: the phase calendar never moved, the run simply ended.
		updateNode(fx.db, "root.team", { status: "retired" }, () => TICK_AT);

		await fx.postman.tick();
		fx.stop();

		assert.deepEqual(fx.rootMessages, [], "an expired action-needed must not be injected after the team ended");
		assert.equal(pendingInbox(fx.db, "root").length, 0);
		assert.equal(inbox(fx.db, "root", { delivery: MAIL_DELIVERY.ACCEPTED }).length, 0, "the notice left ACCEPTED");
		assert.equal(inbox(fx.db, "root", { delivery: MAIL_DELIVERY.OBSOLETE }).length, 1);
		assert.deepEqual(bounces(fx.db, fx.messageId).map((event) => event.data), [
			{ messageId: fx.messageId, toNode: "root", reason: "obsolete_after_phase_change" },
		]);
	} finally {
		fx.db.close();
	}
});

test("#354: the same shape in `reviewing` with status settled is obsoleted too", async () => {
	const fx = fixture("reviewing", true);
	try {
		updateNode(fx.db, "root.team", { status: "settled" }, () => TICK_AT);

		await fx.postman.tick();
		fx.stop();

		assert.deepEqual(fx.rootMessages, []);
		assert.equal(inbox(fx.db, "root", { delivery: MAIL_DELIVERY.OBSOLETE }).length, 1);
		assert.equal(inbox(fx.db, "root", { delivery: MAIL_DELIVERY.ACCEPTED }).length, 0);
		assert.equal(bounces(fx.db, fx.messageId).length, 1);
	} finally {
		fx.db.close();
	}
});

test("#354: a still-running team in the timed-out phase is NOT killed — the notice is delivered", async () => {
	const fx = fixture("planning", false);
	try {
		// Nothing moved: same phase, same phase_since, status still running.
		await fx.postman.tick();
		fx.stop();

		assert.equal(fx.rootMessages.length, 1, "a live phase timeout must still reach the parent");
		assert.equal(inbox(fx.db, "root", { delivery: MAIL_DELIVERY.OBSOLETE }).length, 0);
		assert.equal(inbox(fx.db, "root", { delivery: MAIL_DELIVERY.ACCEPTED }).length, 1);
		assert.equal(bounces(fx.db, fx.messageId).length, 0);
	} finally {
		fx.db.close();
	}
});

test("#354 control: a team that migrated to another live phase is still obsoleted (no regression)", async () => {
	const fx = fixture("planning", true);
	try {
		updateNode(fx.db, "root.team", { phase: "implementing", phaseSince: TICK_AT - 10 }, () => TICK_AT - 10);

		await fx.postman.tick();
		fx.stop();

		assert.deepEqual(fx.rootMessages, []);
		assert.equal(inbox(fx.db, "root", { delivery: MAIL_DELIVERY.OBSOLETE }).length, 1);
		assert.equal(bounces(fx.db, fx.messageId).length, 1);
	} finally {
		fx.db.close();
	}
});

test("#354: the pre-delivery discard drops a QUEUED notice for a retired team (never injected)", async () => {
	const fx = fixture("planning", false);
	try {
		assert.equal(pendingInbox(fx.db, "root").length, 1, "precondition: the notice is still queued");
		updateNode(fx.db, "root.team", { status: "retired" }, () => TICK_AT);

		// ONE tick: the verdict has to happen in `deliverRootInbox`, before the
		// envelope is handed to root — not later, in the confirmation pass.
		await fx.postman.tick();
		fx.stop();

		assert.deepEqual(fx.rootMessages, [], "a queued notice for an ended team is never injected");
		assert.equal(pendingInbox(fx.db, "root").length, 0);
		assert.equal(inbox(fx.db, "root", { delivery: MAIL_DELIVERY.OBSOLETE }).length, 1);
		assert.equal(inbox(fx.db, "root", { delivery: MAIL_DELIVERY.ACCEPTED }).length, 0, "it never became ACCEPTED");
		assert.deepEqual(bounces(fx.db, fx.messageId).map((event) => (event.data as { reason?: string }).reason), [
			"obsolete_after_phase_change",
		]);
	} finally {
		fx.db.close();
	}
});
