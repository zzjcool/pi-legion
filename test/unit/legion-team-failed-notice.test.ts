/**
 * #372 A: a team that declared NO phase machine still reports "all my children
 * failed" instead of vanishing.
 *
 * Since #371 the phase machine is declared, not inferred from the role name, so
 * an undeclared centurion is born with `nodes.phase IS NULL` (contract
 * `centurion-declared-phases-v1.md` §5 I2). The safety net in
 * `LegionPostman.failTeamIfAllChildrenFailed` opened with `!node?.phase` — "no
 * phase, nothing to fail" — which was true while every team had a phase and is
 * exactly wrong now: a lead that dispatched N workers and lost all N was left
 * `running`, nothing was written to the ledger, and the parent heard nothing.
 *
 * The declared-machine path is pinned by the existing #350 case in
 * `legion-tools.test.ts` and must not change; these cases pin the undeclared
 * one.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createLegionEventBus } from "../../src/extension/event-bus.ts";
import { LegionPostman } from "../../src/extension/legion-tools.ts";
import { openLegionDb } from "../../src/legion/db.ts";
import { readEventsAfter } from "../../src/legion/events.ts";
import { MAIL_DELIVERY, inbox } from "../../src/legion/mail.ts";
import type { PhaseMachine } from "../../src/legion/phase-machine.ts";
import { getNode, insertNode } from "../../src/legion/nodes.ts";
import { FakeSupervisor } from "../helpers/fake-supervisor.ts";

/**
 * root → team (centurion) → one child per status given.
 *
 * `phase` defaults to NULL (the undeclared shape #371 introduced); a value makes
 * it a DECLARED team, which is the shape the round-2 review found unguarded.
 */
function teamFixture(childStatuses: readonly string[], teamStatus = "running", phase: string | null = null) {
	const db = openLegionDb(":memory:");
	insertNode(db, { parentId: null, name: "root", role: "root", status: "running" }, () => 1);
	insertNode(db, { parentId: "root", name: "team", role: "centurion", status: teamStatus as "running", phase }, () => 2);
	childStatuses.forEach((status, index) => {
		insertNode(db, {
			parentId: "root.team",
			name: `w${index}`,
			role: "worker",
			status: status as "running",
			phase: null,
		}, () => 3 + index);
	});
	return db;
}

function postmanFor(
	db: ReturnType<typeof openLegionDb>,
	nodeId: string,
	collected: { self: string[]; root: string[] },
	now: number,
	machine?: PhaseMachine,
) {
	const eventBus = createLegionEventBus();
	const busEvents: string[] = [];
	eventBus.on("node_failed", (event) => busEvents.push(event.nodeId));
	const postman = new LegionPostman({
		db,
		nodeId,
		supervisor: new FakeSupervisor(),
		...(machine ? { machine } : {}),
		eventBus,
		now: () => now,
		intervalMs: 10_000,
		sendSelfMessage: (message) => collected.self.push(message),
		sendRootMessage: (message) => collected.root.push(message),
	});
	return { postman, busEvents };
}

/** `recon → build`, with `recon` NON-terminal — the declared shape of a live team. */
const DECLARED_MACHINE: PhaseMachine = {
	start: "recon",
	phases: [
		{ id: "recon", next: [{ to: "build" }] },
		{ id: "build", terminal: true, next: [] },
	],
};

test("#372 A: a team with NO phase whose children ALL failed is failed, recorded and reported to its parent", async () => {
	const db = teamFixture(["failed", "failed"]);
	const collected = { self: [] as string[], root: [] as string[] };
	try {
		const { postman, busEvents } = postmanFor(db, "root.team", collected, 100);
		await postman.tick();
		postman.stop();

		const team = getNode(db, "root.team");
		assert.equal(team?.status, "failed", "an all-failed undeclared team must not be left running");
		assert.equal(team?.phase, null, "the verdict invents no phase — it has no machine to put one on");

		const failed = readEventsAfter(db, 0).filter((event) => event.type === "node_failed");
		assert.deepEqual(
			failed.map((event) => ({ nodeId: event.nodeId, data: event.data })),
			[{ nodeId: "root.team", data: { execution: "failed", reason: "all_children_failed" } }],
			"the ledger records the failure once (no new event type: node_failed already exists)",
		);
		assert.deepEqual(busEvents, ["root.team"], "the bus learns about the verdict in the same tick");
		assert.deepEqual(collected.self, ["Legion team root.team failed because all direct children failed."]);

		const parentMail = inbox(db, "root", { delivery: MAIL_DELIVERY.PENDING });
		assert.equal(parentMail.length, 1, "the parent must be told, not left to poll the ledger");
		assert.match(parentMail[0]?.subject ?? "", /Team failed/);
		assert.match(parentMail[0]?.body ?? "", /all direct children failed/);

		// The row is now terminal, so a later tick must not repeat the verdict:
		// nothing new to fail, nothing new to mail.
		const again = postmanFor(db, "root.team", collected, 200);
		await again.postman.tick();
		again.postman.stop();
		assert.equal(readEventsAfter(db, 0).filter((event) => event.type === "node_failed").length, 1, "one verdict, one event");
		assert.equal(inbox(db, "root", { delivery: MAIL_DELIVERY.PENDING }).length, 1, "one verdict, one notice");
		assert.equal(collected.self.length, 1);
	} finally {
		db.close();
	}
});

test("#372 A control: one child still working means the team keeps running", async () => {
	const db = teamFixture(["failed", "running"]);
	const collected = { self: [] as string[], root: [] as string[] };
	try {
		const { postman, busEvents } = postmanFor(db, "root.team", collected, 100);
		await postman.tick();
		postman.stop();

		assert.equal(getNode(db, "root.team")?.status, "running", "a team with work still in flight is not failed");
		assert.equal(readEventsAfter(db, 0).filter((event) => event.type === "node_failed").length, 0);
		assert.deepEqual(busEvents, []);
		assert.equal(inbox(db, "root", { delivery: MAIL_DELIVERY.PENDING }).length, 0, "no verdict, no notice");
		assert.deepEqual(collected.self, []);
	} finally {
		db.close();
	}
});

test("#372 A: the verdict reaches the LEDGER with no event bus attached (headless)", async () => {
	// `eventBus?.emit(appendEvent(...))` short-circuits the append when there is no
	// subscriber, so an event written that way exists only when someone is
	// listening. The failure has to be in the ledger regardless: a headless run is
	// exactly where nobody re-derives it from a stream.
	const db = teamFixture(["failed"]);
	const collected = { self: [] as string[], root: [] as string[] };
	try {
		const postman = new LegionPostman({
			db,
			nodeId: "root.team",
			supervisor: new FakeSupervisor(),
			now: () => 100,
			intervalMs: 10_000,
			sendSelfMessage: (message) => collected.self.push(message),
		});
		await postman.tick();
		postman.stop();

		assert.equal(getNode(db, "root.team")?.status, "failed");
		assert.equal(
			readEventsAfter(db, 0).filter((event) => event.type === "node_failed").length,
			1,
			"no subscriber must not mean no ledger fact",
		);
	} finally {
		db.close();
	}
});

test("#372 m1: a PAUSED (retired) or already-settled team is never judged failed — declared or not", async () => {
	// `docs/contracts/legion-session-continuity-v1.md` §3: an exit PAUSES a subtree
	// (`status: retired`, phase and stint untouched) and that is exactly what keeps
	// it resumable. Judging such a team failed would make `isTerminalNode` true and
	// `reviveChild` refuse it with CHILD_TERMINAL — the pause would become a verdict
	// nobody pronounced. The same holds for a team whose row already ended
	// (`settled`): there is nothing left in flight to fail.
	//
	// Round-2 review (major): the guard must sit BEFORE the phase fork. With it
	// only on the undeclared branch, a team that had DECLARED a machine
	// (`phase: "recon"`, non-terminal) was moved to `failed` anyway — the paused
	// team became unresumable, the parent got a "Team failed" mail for a run that
	// had already ended, and the ledger carried `node_settled` next to
	// `phase_change(failed)`. Both shapes are covered here.
	for (const status of ["retired", "settled"] as const) {
		for (const declared of [false, true]) {
			const phase = declared ? "recon" : null;
			const label = `${status}/${declared ? "declared" : "undeclared"}`;
			const db = teamFixture(["failed", "failed"], status, phase);
			const collected = { self: [] as string[], root: [] as string[] };
			try {
				const { postman } = postmanFor(db, "root.team", collected, 100, declared ? DECLARED_MACHINE : undefined);
				await postman.tick();
				postman.stop();

				const row = getNode(db, "root.team");
				assert.equal(row?.status, status, `${label}: the row keeps the status it had`);
				assert.equal(row?.phase, phase, `${label}: and the phase it had`);
				const events = readEventsAfter(db, 0);
				assert.equal(events.filter((event) => event.type === "node_failed").length, 0, `${label}: no verdict is written`);
				assert.equal(events.filter((event) => event.type === "phase_change").length, 0, `${label}: no phase is moved`);
				assert.equal(inbox(db, "root", { delivery: MAIL_DELIVERY.PENDING }).length, 0, `${label}: and no notice is sent`);
				assert.deepEqual(collected.self, [], `${label}: nothing is announced locally either`);
			} finally {
				db.close();
			}
		}
	}
});

test("#372 A guard: the root row is never failed by this path (its status is the parent's mail channel)", async () => {
	// `isTerminalNode({status:"failed"})` is true, and `mail.ts` bounces mail
	// addressed to a terminal node — failing the root row would therefore silence
	// the very channel the "your team failed" notice travels on. The gate is
	// "this node leads a team", which root is not.
	const db = openLegionDb(":memory:");
	const collected = { self: [] as string[], root: [] as string[] };
	try {
		insertNode(db, { parentId: null, name: "root", role: "root", status: "running" }, () => 1);
		insertNode(db, { parentId: "root", name: "t1", role: "centurion", status: "failed", phase: null }, () => 2);
		insertNode(db, { parentId: "root", name: "t2", role: "centurion", status: "failed", phase: null }, () => 3);
		const { postman } = postmanFor(db, "root", collected, 100);
		await postman.tick();
		postman.stop();

		assert.equal(getNode(db, "root")?.status, "running", "the root row keeps its status");
		assert.equal(readEventsAfter(db, 0).filter((event) => event.type === "node_failed").length, 0);
	} finally {
		db.close();
	}
});
