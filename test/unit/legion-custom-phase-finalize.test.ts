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
import { legionSettingsForRun, parseSubagentSettings } from "../../src/agents/settings.ts";
import { openLegionDb } from "../../src/legion/db.ts";
import { readEventsAfter } from "../../src/legion/events.ts";
import { MAIL_DELIVERY, inbox } from "../../src/legion/mail.ts";
import { getNode, insertNode } from "../../src/legion/nodes.ts";
import type { PhaseMachine } from "../../src/legion/phase-machine.ts";
import type { LegionSettings } from "../../src/shared/types.ts";
import { FakeSupervisor } from "../helpers/fake-supervisor.ts";

/**
 * The `legion` settings a run REALLY carries (#358 review, major 1).
 *
 * `index.ts` handed the postman a default-FILLED object, so `phaseTimeouts` held all
 * four built-in numbers whether or not an operator ever wrote one down. Every fixture
 * in this file used to inject a slim `{ phaseTimeouts: { ... } }` instead — an object
 * production never produced — so `setting > machine > default` looked correct here
 * while a real run always had a value on the left of the `??`. These helpers go through
 * the same two seams `index.ts` does: `parseSubagentSettings` for a settings.json the
 * operator wrote, `legionSettingsForRun` for the run-time fill.
 */
function runSettings(legion?: Record<string, unknown>): LegionSettings {
	return legionSettingsForRun(
		legion ? parseSubagentSettings({ subagents: { legion } }, "/fake/settings.json") : undefined,
	);
}

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

async function tick(db: Db, options: { machine?: PhaseMachine; now?: number; settings?: LegionSettings } = {}) {
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

test("#358 review (minor 3): a non-final declared phase can never complete the team", async () => {
	// The control for the derivation: `successPhase` answers `ship` for this machine, and a
	// team parked in `impl` — verified as its work may be — must not be collected from
	// there, or every intermediate phase would become a completion gate.
	const db = makeDb({ phase: "impl", taskSummary: verifiedSummary() });
	try {
		await tick(db, { machine: SPEC_MACHINE });
		assert.equal(getNode(db, "root.team")?.phase, "impl", "only the machine's success phase completes a team");
		assert.deepEqual(phaseChanges(db), [], "no phase_change either — nothing to announce");
	} finally {
		db.close();
	}
});

/**
 * A card whose DECLARATION order is not its pipeline order: `ship` ends the workflow
 * (`spec -> review -> ship -> done`) but is listed first.
 *
 * `successPhase` prefers an edge gated on `verification_passed` and otherwise takes the
 * LAST declared candidate — which is only correct because a machine is expected to list
 * its phases in pipeline order (README/contract: "`phases:` order is pipeline order").
 * This machine breaks that expectation on purpose, so the test can pin what depends on it.
 */
const SHUFFLED_MACHINE: PhaseMachine = {
	start: "spec",
	phases: [
		{ id: "ship", next: [{ to: "done", require: ["verification_passed"] }] },
		{ id: "spec", next: [{ to: "review" }] },
		{ id: "review", next: [{ to: "ship" }, { to: "done", require: ["verification_passed"] }] },
	],
};

test("#358 review (minor 3): declaration order, not pipeline order, decides the completion gate", async () => {
	// Two candidates can reach `done` here, so "last" is observable: the rule follows the
	// ORDER THE CARD WROTE, which is why "`phases:` order is pipeline order" is a load-bearing
	// assumption and not a style note. The last declared candidate is `review`, although the
	// workflow's own last phase is `ship`.
	const fromReview = makeDb({ phase: "review", taskSummary: verifiedSummary() });
	const fromShip = makeDb({ phase: "ship", taskSummary: verifiedSummary() });
	try {
		await tick(fromReview, { machine: SHUFFLED_MACHINE });
		assert.equal(
			getNode(fromReview, "root.team")?.phase,
			"done",
			"a shuffled declaration moves the success phase with the declaration, not the workflow",
		);

		await tick(fromShip, { machine: SHUFFLED_MACHINE });
		assert.equal(
			getNode(fromShip, "root.team")?.phase,
			"ship",
			"…so the workflow's real last phase is NOT the gate here: declare phases in pipeline order",
		);
		assert.deepEqual(phaseChanges(fromShip), []);
	} finally {
		fromReview.close();
		fromShip.close();
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
	// Both settings shapes matter: the slim object these fixtures used to inject, and the
	// default-FILLED one a real run carries (#358 review, major 1). The two must agree
	// byte for byte, or "no explicit setting, no machine" means something different in a
	// test than in production.
	const shapes: Array<[string, LegionSettings]> = [["slim", {}], ["default-filled", runSettings()]];
	for (const [label, settings] of shapes) {
		for (const [phase, timeoutMs] of [
			["planning", 15 * 60_000],
			["implementing", 60 * 60_000],
			["reviewing", 30 * 60_000],
			["verifying", 15 * 60_000],
		] as const) {
			const db = makeDb({ phase, phaseSince: NOW });
			try {
				await tick(db, { settings, now: NOW + timeoutMs - 1 });
				assert.deepEqual(phaseTimeouts(db), [], `${label}/${phase}: one millisecond early is early`);
				await tick(db, { settings, now: NOW + timeoutMs });
				const timeouts = phaseTimeouts(db);
				assert.equal(timeouts.length, 1, `${label}/${phase}: the built-in clock still fires exactly on time`);
				assert.equal((timeouts[0]!.data as { timeoutMs: number }).timeoutMs, timeoutMs);
			} finally {
				db.close();
			}
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

test("#358 review (major 1): a card's timeoutMs on a BUILT-IN phase name really wins", async () => {
	// The hole the earlier tests could not reach: `implementing` is one of the four names
	// `DEFAULT_LEGION_SETTINGS` fills (60m). With the fill spread into a plain object, the
	// left side of `settings.phaseTimeouts[phase] ?? machineTimeout(...)` was never null, so
	// a card that declared 5m for `implementing` was ignored in silence — the very order
	// this file documents. `legionExplicitFields` is what tells the two apart.
	const cardMachine: PhaseMachine = {
		start: "implementing",
		phases: [{ id: "implementing", timeoutMs: 5 * 60_000, next: [{ to: "done" }] }],
	};
	const db = makeDb({ phase: "implementing", phaseSince: NOW });
	try {
		await tick(db, { machine: cardMachine, settings: runSettings(), now: NOW + 5 * 60_000 - 1 });
		assert.deepEqual(phaseTimeouts(db), [], "one millisecond before the card's clock nothing is said");
		await tick(db, { machine: cardMachine, settings: runSettings(), now: NOW + 5 * 60_000 });
		const timeouts = phaseTimeouts(db);
		assert.equal(timeouts.length, 1, "the card's 5m must arm a phase the built-in table also knows");
		assert.deepEqual(timeouts[0]!.data, {
			phase: "implementing",
			phaseSince: NOW,
			elapsedMs: 5 * 60_000,
			timeoutMs: 5 * 60_000,
		});
	} finally {
		db.close();
	}
});

test("#358 review (major 1): an explicit operator clock still beats the card, through the production seam", async () => {
	// Same default-filled object, but this time the operator DID write `implementing: 10s`
	// down and the card asks for an hour. The fill and the decision must stay
	// distinguishable — that is the whole point of the explicitness marker.
	const cardMachine: PhaseMachine = {
		start: "implementing",
		phases: [{ id: "implementing", timeoutMs: 60 * 60_000, next: [{ to: "done" }] }],
	};
	const db = makeDb({ phase: "implementing", phaseSince: NOW });
	try {
		await tick(db, { machine: cardMachine, settings: runSettings({ phaseTimeouts: { implementing: 10_000 } }), now: NOW + 10_000 });
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
