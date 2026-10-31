/**
 * #358 — a declared machine's own phase names were invisible to two supervisor paths.
 *
 * Both holes came from the same mistake: reading the BUILT-IN vocabulary while a
 * team runs a machine its card declared.
 *
 *   1. `finalizeVerifiedTeamIfReady` tested `node.phase !== "verifying"` and then
 *      evaluated `verifying → done` against the built-in machine, so a team whose
 *      declaration calls its last phase `ship` could never take the supervisor's
 *      verified-completion path. It now asks the machine which phase judges
 *      success (an exit to `done`, preferring one gated on `verification_passed`)
 *      and hands that machine to the transition evaluator.
 *   2. `checkOwnPhaseTimeout` asked `checkPhaseTimeout`, whose timeout falls back to
 *      `DEFAULT_PHASE_TIMEOUTS[phase] ?? 0` for a name the built-in table has never
 *      heard of. A custom phase's advisory clock was therefore always 0 and
 *      `PhaseDefinition.timeoutMs` (`machineTimeout`) was dead code. The machine's
 *      value is now consulted first, the built-in default second, and `0` (never
 *      warn) stays the last word when neither declares one.
 *
 * The control tests in this file run the same fixtures with NO declared machine:
 * the built-in four-phase pipeline must behave exactly as before, timeout values
 * included.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { createLegionEventBus } from "../../src/extension/event-bus.ts";
import { LegionPostman } from "../../src/extension/legion-tools.ts";
import { openLegionDb } from "../../src/legion/db.ts";
import { readEventsAfter } from "../../src/legion/events.ts";
import { MAIL_DELIVERY, inbox } from "../../src/legion/mail.ts";
import { getNode, insertNode } from "../../src/legion/nodes.ts";
import type { PhaseMachine } from "../../src/legion/phase-machine.ts";
import { FakeSupervisor } from "../helpers/fake-supervisor.ts";

type Db = ReturnType<typeof openLegionDb>;

/** A workflow the built-in union has never heard of, in three declared phases. */
const SPEC_MACHINE: PhaseMachine = {
	start: "spec",
	phases: [
		{ id: "spec", next: [{ to: "impl" }] },
		{ id: "impl", next: [{ to: "ship" }] },
		// The declared success exit. Deliberately a bare edge: the machine's SHAPE,
		// not a built-in phase name, is what has to identify it.
		{ id: "ship", next: [{ to: "done" }] },
	],
};

/** The same machine, but `ship` gates completion on the verification verdict. */
const SPEC_MACHINE_GATED: PhaseMachine = {
	...SPEC_MACHINE,
	phases: [
		{ id: "spec", next: [{ to: "impl" }] },
		{ id: "impl", next: [{ to: "ship" }] },
		{ id: "ship", next: [{ to: "done", require: ["verification_passed"] }] },
	],
};

/** A custom phase with its own advisory clock (dead code before #358). */
const TIMED_MACHINE: PhaseMachine = {
	start: "spec",
	phases: [
		{ id: "spec", timeoutMs: 5_000, next: [{ to: "ship" }] },
		{ id: "ship", next: [{ to: "done" }] },
	],
};

const NOW = 100_000;

/** A satisfied verification verdict, in the shape `writeVerificationResult` stores. */
function verifiedSummary(): string {
	return JSON.stringify({
		__piLegion: {
			version: 1,
			taskSummary: null,
			verification: { passed: true, outputFile: "/tmp/verify.log", commandCount: 1, checkedAt: NOW - 1 },
		},
	});
}

function makeDb(options: { phase: string | null; phaseSince?: number; taskSummary?: string }): Db {
	const db = openLegionDb(":memory:");
	insertNode(db, { parentId: null, name: "root", role: "root", status: "running" }, () => NOW - 1_000);
	insertNode(db, {
		parentId: "root",
		name: "team",
		role: "centurion",
		status: "running",
		phase: options.phase,
		phaseSince: options.phaseSince ?? NOW - 1_000,
		...(options.taskSummary ? { taskSummary: options.taskSummary } : {}),
	}, () => NOW - 1_000);
	return db;
}

async function tick(db: Db, options: { machine?: PhaseMachine; now?: number; settings?: Record<string, unknown> } = {}) {
	const selfMessages: string[] = [];
	const postman = new LegionPostman({
		db,
		nodeId: "root.team",
		supervisor: new FakeSupervisor(),
		...(options.machine ? { machine: options.machine } : {}),
		...(options.settings ? { settings: options.settings } : {}),
		now: () => options.now ?? NOW,
		intervalMs: 10_000,
		sendSelfMessage: (message) => selfMessages.push(message),
		eventBus: createLegionEventBus(),
	});
	await postman.tick();
	postman.stop();
	return selfMessages;
}

function phaseTimeouts(db: Db) {
	return readEventsAfter(db, 0, { nodeId: "root.team" }).filter((event) => event.type === "phase_timeout");
}

function phaseChanges(db: Db) {
	return readEventsAfter(db, 0, { nodeId: "root.team" }).filter((event) => event.type === "phase_change");
}

// ---------------------------------------------------------------------------
// 1. The verifying/finalize path
// ---------------------------------------------------------------------------

test("#358: a declared machine's success phase finalizes the team (spec → impl → ship)", async () => {
	const db = makeDb({ phase: "ship", taskSummary: verifiedSummary() });
	try {
		const selfMessages = await tick(db, { machine: SPEC_MACHINE });

		assert.equal(
			getNode(db, "root.team")?.phase,
			"done",
			"the supervisor must complete a team whose OWN last phase judges success",
		);
		const changes = phaseChanges(db);
		assert.equal(changes.length, 1);
		assert.deepEqual(
			{ ...(changes[0]!.data as { from: string; to: string }) },
			{ from: "ship", to: "done", reworkCount: 0 },
		);
		assert.equal(selfMessages.length, 1, "…and the team is told to collect, squash and report");
		assert.match(selfMessages[0]!, /verification passed/iu);
	} finally {
		db.close();
	}
});

test("#358: a bare declared success exit is enough — the verdict is not required by the edge", async () => {
	const db = makeDb({ phase: "ship", taskSummary: verifiedSummary() });
	try {
		await tick(db, { machine: SPEC_MACHINE_GATED });
		assert.equal(getNode(db, "root.team")?.phase, "done", "a gated `ship → done` edge finalizes too");
	} finally {
		db.close();
	}
});

test("#358 control: an undeclared team still finalizes from `verifying` and only from there", async () => {
	const verifying = makeDb({ phase: "verifying", taskSummary: verifiedSummary() });
	const implementing = makeDb({ phase: "implementing", taskSummary: verifiedSummary() });
	try {
		await tick(verifying);
		assert.equal(getNode(verifying, "root.team")?.phase, "done", "the built-in path is unchanged");

		await tick(implementing);
		assert.equal(
			getNode(implementing, "root.team")?.phase,
			"implementing",
			"only `verifying` finalizes: the built-in pipeline must not gain a second exit to done",
		);
		assert.deepEqual(phaseChanges(implementing), []);
	} finally {
		verifying.close();
		implementing.close();
	}
});

test("#358: a custom phase cannot finalize without a passing verdict", async () => {
	const db = makeDb({ phase: "ship" }); // no verification result at all
	try {
		await tick(db, { machine: SPEC_MACHINE });
		assert.equal(getNode(db, "root.team")?.phase, "ship", "verificationPassed must still be true to complete");
		assert.deepEqual(phaseChanges(db), []);
	} finally {
		db.close();
	}
});

// ---------------------------------------------------------------------------
// 2. The advisory phase clock
// ---------------------------------------------------------------------------

test("#358: a custom phase's timeout comes from the machine, not from a 0 default", async () => {
	const db = makeDb({ phase: "spec", phaseSince: NOW });
	try {
		// Under the old code `DEFAULT_PHASE_TIMEOUTS["spec"]` was undefined → 0 → no warn.
		await tick(db, { machine: TIMED_MACHINE, now: NOW + 4_999 });
		assert.deepEqual(phaseTimeouts(db), [], "below the machine's own clock nothing is said");

		await tick(db, { machine: TIMED_MACHINE, now: NOW + 5_000 });
		const timeouts = phaseTimeouts(db);
		assert.equal(timeouts.length, 1, "the declared timeoutMs must actually arm the clock");
		assert.deepEqual(timeouts[0]!.data, {
			phase: "spec",
			phaseSince: NOW,
			elapsedMs: 5_000,
			timeoutMs: 5_000,
		});
		const notice = inbox(db, "root", { delivery: MAIL_DELIVERY.PENDING });
		assert.equal(notice.length, 1, "the parent is told");
		assert.match(notice[0]!.subject, /^Phase timeout:/u, "the frozen subject prefix is untouched");
		assert.equal(notice[0]!.kind, "notice", "…and the notice accounting is unchanged");
	} finally {
		db.close();
	}
});

test("#358: a custom phase with no timeout anywhere still says nothing (0 means never)", async () => {
	// `ship` declares no timeoutMs, and no built-in default exists for that name.
	const db = makeDb({ phase: "ship", phaseSince: NOW });
	try {
		await tick(db, { machine: SPEC_MACHINE, now: NOW + 365 * 24 * 60 * 60_000 });
		assert.deepEqual(phaseTimeouts(db), [], "no clock, no warning — the pre-existing 0 semantics");
	} finally {
		db.close();
	}
});

test("#358 control: the built-in four phases keep their exact clocks", async () => {
	for (const [phase, timeoutMs] of [
		["planning", 15 * 60_000],
		["implementing", 60 * 60_000],
		["reviewing", 30 * 60_000],
		["verifying", 15 * 60_000],
	] as const) {
		const db = makeDb({ phase, phaseSince: NOW });
		try {
			await tick(db, { now: NOW + timeoutMs - 1 });
			assert.deepEqual(phaseTimeouts(db), [], `${phase}: one millisecond early is early`);
			await tick(db, { now: NOW + timeoutMs });
			const timeouts = phaseTimeouts(db);
			assert.equal(timeouts.length, 1, `${phase}: the built-in clock still fires exactly on time`);
			assert.equal((timeouts[0]!.data as { timeoutMs: number }).timeoutMs, timeoutMs);
		} finally {
			db.close();
		}
	}
});

test("#358: an explicit operator setting still outranks the machine's advisory clock", async () => {
	// `subagents.legion.phaseTimeouts` is an operator override; a card must not be able
	// to take it away by declaring the same phase with a longer timeoutMs.
	const db = makeDb({ phase: "implementing", phaseSince: NOW });
	try {
		const machine: PhaseMachine = {
			start: "implementing",
			phases: [{ id: "implementing", timeoutMs: 60 * 60_000, next: [{ to: "done" }] }],
		};
		await tick(db, { machine, settings: { phaseTimeouts: { implementing: 10_000 } }, now: NOW + 10_000 });
		const timeouts = phaseTimeouts(db);
		assert.equal(timeouts.length, 1);
		assert.equal(
			(timeouts[0]!.data as { timeoutMs: number }).timeoutMs,
			10_000,
			"the operator's 10s wins over the card's 60m",
		);
	} finally {
		db.close();
	}
});
