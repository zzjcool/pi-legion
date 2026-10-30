/**
 * #309 — the legal exit from `implementing` when part of the squad failed.
 *
 * Every test here drives the REAL `requestLegionPhase`, not the state machine
 * directly: the deadlock was never in the transition table (the table is
 * correct — partial failure satisfies neither `children_none_failed` nor
 * `children_all_failed`), it was in the absence of a way to SAY which failures
 * are accounted for and in a blanket `to: "failed"` refusal. A unit test of
 * `evaluatePhaseTransition` would have been green throughout the bug.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
	registerLegionTools,
	requestLegionPhase,
	type PhaseRequestOptions,
	type PhaseRequestResult,
} from "../../src/extension/legion-tools.ts";
import { openLegionDb } from "../../src/legion/db.ts";
import { readEventsAfter } from "../../src/legion/events.ts";
import { getNode, insertNode, updateNode } from "../../src/legion/nodes.ts";
import { describeFailedCondition } from "../../src/legion/phase-conditions.ts";
import { validatePhaseMachine, type PhaseMachine } from "../../src/legion/phase-machine.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const TEAM_ID = "root.team-a";
const PHASE_SINCE = 1_000;
const NOW = 5_000;

type Db = ReturnType<typeof openLegionDb>;

function makePhaseFixture(options: { reworkCount?: number } = {}): Db {
	const db = openLegionDb(":memory:");
	insertNode(db, { parentId: null, name: "root", role: "root", status: "running" }, () => PHASE_SINCE - 500);
	// `reworkCount: 0` is the whole point: `implementing` has no rework edge, so a
	// team that lands here can never raise it, and the `reworkCount > 0` derivation
	// of `handledIds` can never fire from this phase. Tests that pin the OTHER half
	// of the union raise it explicitly.
	insertNode(db, {
		parentId: "root",
		name: "team-a",
		role: "centurion",
		status: "running",
		phase: "implementing",
		phaseSince: PHASE_SINCE,
		reworkCount: options.reworkCount ?? 0,
	}, () => PHASE_SINCE);
	return db;
}

/** One failed child plus one settled sibling: the partial-failure shape of #309. */
function seedPartialFailure(db: Db): void {
	insertNode(db, { parentId: TEAM_ID, name: "worker", role: "worker", status: "failed" }, () => PHASE_SINCE + 10);
	insertNode(db, { parentId: TEAM_ID, name: "replacement", role: "worker", status: "settled" }, () => PHASE_SINCE + 20);
}

async function withFixture(
	run: (db: Db, cwd: string) => Promise<void>,
	options: { reworkCount?: number } = {},
): Promise<void> {
	const cwd = mkdtempSync(path.join(tmpdir(), "legion-phase-exit-"));
	const db = makePhaseFixture(options);
	try {
		await run(db, cwd);
	} finally {
		db.close();
		rmSync(cwd, { recursive: true, force: true });
	}
}

function request(
	db: Db,
	cwd: string,
	to: string,
	extra: Partial<PhaseRequestOptions> = {},
): Promise<PhaseRequestResult> {
	return requestLegionPhase(db, TEAM_ID, to, {
		cwd,
		now: () => NOW,
		sendSelfMessage() { /* phase requests never need a mailbox in these tests */ },
		...extra,
	});
}

function eventsOfType(db: Db, type: string) {
	return readEventsAfter(db, 0).filter((event) => event.type === type);
}

interface RegisteredTool {
	name: string;
	description?: string;
	parameters?: { properties?: Record<string, { description?: string }> };
	execute: (
		id: string,
		params: Record<string, unknown>,
	) => Promise<{ content?: Array<{ text?: string }> }>;
}

/** The same registration path a live centurion gets, minus the host. */
function makeTools(db: Db, cwd: string): Map<string, RegisteredTool> {
	const tools = new Map<string, RegisteredTool>();
	const pi = {
		registerTool(tool: unknown) {
			const typed = tool as RegisteredTool;
			tools.set(typed.name, typed);
		},
	};
	registerLegionTools(pi as unknown as ExtensionAPI, {
		db,
		nodeId: TEAM_ID,
		role: "centurion",
		cwd,
		now: () => NOW,
	});
	return tools;
}

function toolText(result: { content?: Array<{ text?: string }> }): string {
	return (result.content ?? []).map((item) => item.text ?? "").join("\n");
}

test("#309 the deadlock is real: a partial failure blocks implementing → reviewing", async () => {
	await withFixture(async (db, cwd) => {
		seedPartialFailure(db);
		const result = await request(db, cwd, "reviewing");
		assert.equal(result.ok, false);
		// The refusal must carry the reason's human text, not just a code: this is
		// the message a stuck centurion reads before it gives up.
		assert.match(result.message, /a child failed and must be handled/);
		assert.equal(getNode(db, TEAM_ID)?.phase, "implementing");
		// A refused transition persists nothing — no phase_change, no audit trail.
		assert.deepEqual(eventsOfType(db, "phase_change"), []);
		assert.deepEqual(eventsOfType(db, "node_handled"), []);
	});
});

test("#309 D2: supersedes a failed child unlocks the exit and audits node_handled", async () => {
	await withFixture(async (db, cwd) => {
		seedPartialFailure(db);
		const result = await request(db, cwd, "reviewing", { supersedes: ["worker"] });
		assert.equal(result.ok, true);
		assert.equal(getNode(db, TEAM_ID)?.phase, "reviewing");
		// The audit event must sit immediately before the transition it justified,
		// both owned by the centurion node — an auditor reads "this failure
		// was accounted for" and then "the phase moved".
		assert.deepEqual(readEventsAfter(db, 0).map((event) => event.type), ["node_handled", "phase_change"]);
		const handled = eventsOfType(db, "node_handled");
		assert.equal(handled.length, 1);
		assert.equal(handled[0]!.nodeId, TEAM_ID);
		const data = handled[0]!.data as Record<string, unknown>;
		assert.equal(data.handledId, "root.team-a.worker");
		assert.equal(data.byNodeId, TEAM_ID);
		// No `note` was passed, so the audit event carries no `reason` key at all.
		assert.ok(!("reason" in data), "reason is absent when note is empty");
	});
});

test("#309 D2: a superseded child resolves by id as well as by name", async () => {
	await withFixture(async (db, cwd) => {
		seedPartialFailure(db);
		const result = await request(db, cwd, "reviewing", { supersedes: ["root.team-a.worker"] });
		assert.equal(result.ok, true);
		assert.equal(getNode(db, TEAM_ID)?.phase, "reviewing");
		assert.equal((eventsOfType(db, "node_handled")[0]!.data as Record<string, unknown>).handledId, "root.team-a.worker");
	});
});

test("#309 D2: the node_handled audit carries the trimmed note as its reason", async () => {
	await withFixture(async (db, cwd) => {
		seedPartialFailure(db);
		const result = await request(db, cwd, "reviewing", {
			supersedes: ["worker"],
			note: "  replacement took the work over  ",
		});
		assert.equal(result.ok, true);
		assert.equal(
			(eventsOfType(db, "node_handled")[0]!.data as Record<string, unknown>).reason,
			"replacement took the work over",
		);
	});
});

test("#309 D2: supersedes refuses a settled child and names the entry", async () => {
	await withFixture(async (db, cwd) => {
		seedPartialFailure(db);
		const result = await request(db, cwd, "reviewing", { supersedes: ["replacement"] });
		assert.equal(result.ok, false);
		assert.match(result.message, /supersedes:\[replacement\] is not a failed child \(status=settled\)/);
		assert.equal(getNode(db, TEAM_ID)?.phase, "implementing");
		assert.deepEqual(eventsOfType(db, "node_handled"), []);
	});
});

test("#309 D2: supersedes refuses an entry that is not a child of this team", async () => {
	await withFixture(async (db, cwd) => {
		seedPartialFailure(db);
		const result = await request(db, cwd, "reviewing", { supersedes: ["ghost"] });
		assert.equal(result.ok, false);
		assert.match(result.message, /supersedes:\[ghost\] is not a child of this team/);
		assert.equal(getNode(db, TEAM_ID)?.phase, "implementing");
		assert.deepEqual(eventsOfType(db, "node_handled"), []);
	});
});

test("#309 D2: supersedes without a settled sibling cannot launder a failure into an exit", async () => {
	await withFixture(async (db, cwd) => {
		insertNode(db, { parentId: TEAM_ID, name: "worker", role: "worker", status: "failed" }, () => PHASE_SINCE + 10);
		const result = await request(db, cwd, "reviewing", { supersedes: ["worker"] });
		assert.equal(result.ok, false);
		assert.match(result.message, /supersedes requires a settled sibling/);
		assert.equal(getNode(db, TEAM_ID)?.phase, "implementing");
		assert.deepEqual(eventsOfType(db, "node_handled"), []);
	});
});

test("#309 D2: an empty supersedes array is equivalent to not passing it", async () => {
	await withFixture(async (db, cwd) => {
		seedPartialFailure(db);
		const result = await request(db, cwd, "reviewing", { supersedes: [] });
		assert.equal(result.ok, false);
		assert.match(result.message, /a child failed and must be handled/);
		assert.equal(getNode(db, TEAM_ID)?.phase, "implementing");
		assert.deepEqual(eventsOfType(db, "node_handled"), []);
	});
});

test("#309 D1: to failed with a reason is a declared parent_decision", async () => {
	await withFixture(async (db, cwd) => {
		seedPartialFailure(db);
		// Padding on purpose: the trim is load-bearing, both in the event and in the
		// message a reader sees.
		const result = await request(db, cwd, "failed", { reason: "  worker died  " });
		assert.equal(result.ok, true);
		const team = getNode(db, TEAM_ID);
		assert.equal(team?.phase, "failed");
		assert.equal(team?.phaseSince, NOW);
		const phaseEvents = eventsOfType(db, "phase_change");
		assert.equal(phaseEvents.length, 1);
		const data = phaseEvents[0]!.data as Record<string, unknown>;
		assert.equal(data.to, "failed");
		assert.equal(data.terminalReason, "parent_decision");
		assert.equal(data.reason, "worker died");
		assert.equal(result.message, "Team failed by centurion decision: worker died");
	});
});

test("#309 D1: to failed without a reason stays refused and the team stays put", async () => {
	await withFixture(async (db, cwd) => {
		seedPartialFailure(db);
		const missing = await request(db, cwd, "failed");
		assert.equal(missing.ok, false);
		assert.equal(missing.code, "INVALID_PARAMS");
		assert.match(missing.message, /to:"failed" requires a reason/);
		const blank = await request(db, cwd, "failed", { reason: "   " });
		assert.equal(blank.ok, false);
		assert.equal(blank.code, "INVALID_PARAMS");
		assert.match(blank.message, /to:"failed" requires a reason/);
		assert.equal(getNode(db, TEAM_ID)?.phase, "implementing");
		assert.deepEqual(eventsOfType(db, "phase_change"), []);
	});
});

test("#309 D1: done and aborted stay controlled by the parent, reason or not", async () => {
	await withFixture(async (db, cwd) => {
		seedPartialFailure(db);
		for (const to of ["done", "aborted"]) {
			for (const extra of [{}, { reason: "because I said so" }]) {
				const result = await request(db, cwd, to, extra);
				assert.equal(result.ok, false, `${to} must be refused (${JSON.stringify(extra)})`);
				assert.equal(result.code, "INVALID_PARAMS");
				assert.equal(result.message, `${to} is controlled by the parent or supervisor`);
			}
		}
		assert.equal(getNode(db, TEAM_ID)?.phase, "implementing");
	});
});

test("#309 D1: an illegal failed edge still refuses through the state machine", async () => {
	await withFixture(async (db, cwd) => {
		seedPartialFailure(db);
		// A terminal team (this one already finished as `done`) cannot transition at
		// all. `to:"failed"` must NOT be special-cased past the machine just because
		// it now carries a reason.
		updateNode(db, TEAM_ID, { phase: "done", phaseSince: PHASE_SINCE }, () => PHASE_SINCE);
		const result = await request(db, cwd, "failed", { reason: "worker died" });
		assert.equal(result.ok, false);
		assert.equal(result.code, "INVALID_PARAMS");
		assert.match(result.message, /terminal phase done cannot transition/);
		assert.deepEqual(eventsOfType(db, "phase_change"), []);
	});
});

test("#309 D3: the children_none_failed text names only reachable actions", () => {
	const text = describeFailedCondition("children_none_failed");
	assert.ok(text.includes("supersedes"), `text must name supersedes: ${text}`);
	assert.ok(text.includes('to:"failed"'), `text must name the failure exit: ${text}`);
	// The old advice ("reworked or the team must fail") was double-unreachable:
	// `implementing` has no rework edge and `to:"failed"` was refused outright.
	assert.ok(!text.includes("reworked or the team must fail"), `stale advice must be gone: ${text}`);
	assert.equal(
		text,
		'a child failed and must be handled: pass supersedes:[<failed child>] once a replacement has settled, or declare to:"failed" with a reason to fail the team',
	);
});

test("#309 the legion_phase tool advertises and forwards supersedes and reason", async () => {
	// A model only learns about an argument if the tool surface names it, so the
	// schema is part of the fix, not documentation about it.
	await withFixture(async (db, cwd) => {
		const phase = makeTools(db, cwd).get("legion_phase");
		assert.ok(phase, "a centurion must receive legion_phase");
		assert.match(phase.description ?? "", /supersedes/);
		assert.match(phase.description ?? "", /reason/);
		const properties = phase.parameters?.properties ?? {};
		assert.match(properties.reason?.description ?? "", /to:"failed"/);
		assert.match(properties.supersedes?.description ?? "", /settled/);
	});
	// The arguments must actually reach `requestLegionPhase` from the tool.
	await withFixture(async (db, cwd) => {
		seedPartialFailure(db);
		const phase = makeTools(db, cwd).get("legion_phase")!;
		const text = toolText(await phase.execute("exit-1", { to: "reviewing", supersedes: ["worker"] }));
		assert.match(text, /Phase changed to reviewing/);
		assert.equal(getNode(db, TEAM_ID)?.phase, "reviewing");
		assert.equal(eventsOfType(db, "node_handled").length, 1);
	});
	await withFixture(async (db, cwd) => {
		seedPartialFailure(db);
		const phase = makeTools(db, cwd).get("legion_phase")!;
		const text = toolText(await phase.execute("exit-2", { to: "failed", reason: "  worker died  " }));
		assert.equal(text, "Team failed by centurion decision: worker died");
	});
});

/** TWO failed children plus one settled sibling. */
function seedTwoFailed(db: Db): void {
	insertNode(db, { parentId: TEAM_ID, name: "w1", role: "worker", status: "failed" }, () => PHASE_SINCE + 10);
	insertNode(db, { parentId: TEAM_ID, name: "w2", role: "worker", status: "failed" }, () => PHASE_SINCE + 20);
	insertNode(db, { parentId: TEAM_ID, name: "replacement", role: "worker", status: "settled" }, () => PHASE_SINCE + 30);
}

/**
 * A declared machine whose CURRENT phase (`implementing`) may declare its own
 * `failed` edge, or none at all. `failed` stays reachable from `reviewing` in
 * every variant, so `validatePhaseMachine` is clean either way.
 */
function machineWithFailedEdge(failedEdge?: { actorRole?: string }): PhaseMachine {
	return {
		start: "implementing",
		maxRework: 2,
		phases: [
			{
				id: "implementing",
				next: [
					{ to: "reviewing" },
					...(failedEdge === undefined ? [] : [{ to: "failed", ...failedEdge }]),
					{ to: "aborted" },
				],
			},
			{ id: "reviewing", next: [{ to: "done" }, { to: "failed" }, { to: "aborted" }] },
			{ id: "done", terminal: true, next: [] },
			{ id: "failed", terminal: true, next: [] },
			{ id: "aborted", terminal: true, next: [] },
		],
	};
}

test("#309 the node_handled audit is written ONLY on the accepted path, never on a machine refusal", async () => {
	// The refusals exercised elsewhere are all supersedes-VALIDATION refusals, which
	// return before the audit loop by construction. This one has a VALID
	// `supersedes` (`w1` is a failed direct child and a settled sibling exists) and
	// is refused by the state machine instead, because `w2` is still unhandled:
	// the only shape that can tell "audit after the guard" from "audit before it".
	await withFixture(async (db, cwd) => {
		seedTwoFailed(db);
		const refused = await request(db, cwd, "reviewing", { supersedes: ["w1"] });
		assert.equal(refused.ok, false);
		assert.match(refused.message, /a child failed and must be handled/);
		assert.equal(getNode(db, TEAM_ID)?.phase, "implementing");
		assert.deepEqual(eventsOfType(db, "node_handled"), []);
		assert.deepEqual(eventsOfType(db, "phase_change"), []);

		// Every failure accounted for: accepted, and now both are audited.
		const accepted = await request(db, cwd, "reviewing", { supersedes: ["w1", "w2"] });
		assert.equal(accepted.ok, true);
		assert.equal(getNode(db, TEAM_ID)?.phase, "reviewing");
		assert.equal(eventsOfType(db, "node_handled").length, 2);
	});
});

test("#309 handled derivation: a failure older than the phase is handled without supersedes", async () => {
	// The LEFT half of `[...failedHandledIds, ...supersededIds]`: the pre-existing
	// `reworkCount > 0` + `updatedAt < phaseSince` derivation, with NO explicit
	// `supersedes` at all. Replacing the union with `[...supersededIds]` must break
	// exactly this test.
	await withFixture(async (db, cwd) => {
		insertNode(db, { parentId: TEAM_ID, name: "worker", role: "worker", status: "failed" }, () => PHASE_SINCE - 10);
		insertNode(db, { parentId: TEAM_ID, name: "replacement", role: "worker", status: "settled" }, () => PHASE_SINCE + 20);
		const result = await request(db, cwd, "reviewing");
		assert.equal(result.ok, true);
		assert.equal(getNode(db, TEAM_ID)?.phase, "reviewing");
		// The automatic derivation is not an explicit decision: no audit event.
		assert.deepEqual(eventsOfType(db, "node_handled"), []);
	}, { reworkCount: 1 });
});

test("#309 handled derivation: a failure recorded after the phase began is NOT handled", async () => {
	// Same shape as the test above, only the failure's `updatedAt` moves past
	// `phaseSince` — pinning the comparison direction of the time rule.
	await withFixture(async (db, cwd) => {
		insertNode(db, { parentId: TEAM_ID, name: "worker", role: "worker", status: "failed" }, () => PHASE_SINCE - 10);
		insertNode(db, { parentId: TEAM_ID, name: "replacement", role: "worker", status: "settled" }, () => PHASE_SINCE + 20);
		updateNode(db, "root.team-a.worker", {}, () => PHASE_SINCE + 500);
		const result = await request(db, cwd, "reviewing");
		assert.equal(result.ok, false);
		assert.match(result.message, /a child failed and must be handled/);
		assert.equal(getNode(db, TEAM_ID)?.phase, "implementing");
		assert.deepEqual(eventsOfType(db, "node_handled"), []);
	}, { reworkCount: 1 });
});

test("#309 an all-blank supersedes array is equivalent to not passing it", async () => {
	await withFixture(async (db, cwd) => {
		seedPartialFailure(db);
		const result = await request(db, cwd, "reviewing", { supersedes: ["", "   "] });
		assert.equal(result.ok, false);
		// Blank entries are dropped BEFORE validation: they cannot become
		// "is not a child of this team", and they cannot reach the machine either.
		assert.match(result.message, /a child failed and must be handled/);
		assert.equal(getNode(db, TEAM_ID)?.phase, "implementing");
		assert.deepEqual(eventsOfType(db, "node_handled"), []);
		assert.deepEqual(eventsOfType(db, "phase_change"), []);
	});
});

test("#309 supersedes refuses a grandchild: entries must be DIRECT children", async () => {
	await withFixture(async (db, cwd) => {
		seedPartialFailure(db);
		insertNode(db, { parentId: "root.team-a.worker", name: "grandchild", role: "worker", status: "failed" }, () => PHASE_SINCE + 30);
		const result = await request(db, cwd, "reviewing", { supersedes: ["grandchild"] });
		assert.equal(result.ok, false);
		// Pins the DIRECT-child half: a subtree lookup would have resolved (and
		// accepted) this entry, since the grandchild really is a failed descendant.
		assert.match(result.message, /supersedes:\[grandchild\] is not a child of this team/);
		assert.equal(getNode(db, TEAM_ID)?.phase, "implementing");
		assert.deepEqual(eventsOfType(db, "node_handled"), []);
	});
});

test("#309 supersedes dedupes repeated entries: one node_handled per distinct child", async () => {
	await withFixture(async (db, cwd) => {
		seedTwoFailed(db);
		const result = await request(db, cwd, "reviewing", { supersedes: ["w1", "w2", "w1"] });
		assert.equal(result.ok, true);
		const handledIds = eventsOfType(db, "node_handled").map((event) => (event.data as Record<string, unknown>).handledId);
		assert.deepEqual(handledIds, ["root.team-a.w1", "root.team-a.w2"]);
	});
});

test("#309 the audit events share the transition's clock", async () => {
	await withFixture(async (db, cwd) => {
		seedPartialFailure(db);
		const result = await request(db, cwd, "reviewing", { supersedes: ["worker"] });
		assert.equal(result.ok, true);
		const handled = eventsOfType(db, "node_handled");
		const phaseChange = eventsOfType(db, "phase_change");
		assert.equal(handled.length, 1);
		assert.equal(phaseChange.length, 1);
		// "Same now()" is the contract's wording: an auditor sorting by `ts` must see
		// the audit event immediately before the transition, not merely earlier.
		assert.equal(handled[0]!.ts, phaseChange[0]!.ts);
		assert.equal(handled[0]!.ts, NOW);
	});
});

test("#309 a declared machine with NO failed edge out of the current phase refuses to:'failed'", async () => {
	const machine = machineWithFailedEdge();
	assert.deepEqual(validatePhaseMachine(machine), []);
	await withFixture(async (db, cwd) => {
		seedPartialFailure(db);
		const result = await request(db, cwd, "failed", { reason: "worker died", machine });
		assert.equal(result.ok, false);
		assert.equal(result.code, "INVALID_PARAMS");
		// The refusal is the MACHINE's own message, not a new tool-level one: with no
		// `parent_decision` handed to it, `evaluateDeclaredFailure` demands a real
		// terminal reason before the edge lookup can name the legal exits
		// (`src/legion/state-machine.ts:256-297`).
		assert.match(result.message, /failed requires parent decision, all children failed, or exhausted rework/);
		assert.equal(getNode(db, TEAM_ID)?.phase, "implementing");
		assert.deepEqual(eventsOfType(db, "phase_change"), []);
	});
});

test("#309 a failed edge reserved to another actor refuses to:'failed'", async () => {
	const machine = machineWithFailedEdge({ actorRole: "reviewer" });
	assert.deepEqual(validatePhaseMachine(machine), []);
	await withFixture(async (db, cwd) => {
		seedPartialFailure(db);
		const result = await request(db, cwd, "failed", { reason: "worker died", machine });
		assert.equal(result.ok, false);
		assert.equal(result.code, "INVALID_PARAMS");
		// `parent_decision` is never handed to the machine here, so the reserved edge
		// is not taken: `actorRole` says WHO may decide a failure, and that binds.
		assert.match(result.message, /failed requires parent decision, all children failed, or exhausted rework/);
		assert.equal(getNode(db, TEAM_ID)?.phase, "implementing");
		assert.deepEqual(eventsOfType(db, "phase_change"), []);
	});
});

test("#309 a plain failed edge on a declared machine still permits a parent decision", async () => {
	// The control for the two refusals above: same machine, no `actorRole`.
	const machine = machineWithFailedEdge({});
	assert.deepEqual(validatePhaseMachine(machine), []);
	await withFixture(async (db, cwd) => {
		seedPartialFailure(db);
		const result = await request(db, cwd, "failed", { reason: "worker died", machine });
		assert.equal(result.ok, true);
		assert.equal(getNode(db, TEAM_ID)?.phase, "failed");
		const data = eventsOfType(db, "phase_change")[0]!.data as Record<string, unknown>;
		assert.equal(data.terminalReason, "parent_decision");
		assert.equal(data.reason, "worker died");
	});
});

test("#309 the persisted failure reason is capped while the returned message keeps the full text", async () => {
	await withFixture(async (db, cwd) => {
		seedPartialFailure(db);
		// Longer than the 2_000-char cap `note`/`evidence`/the audit reason already use.
		const reason = `worker died: ${"x".repeat(2_500)}`;
		const result = await request(db, cwd, "failed", { reason: `  ${reason}  ` });
		assert.equal(result.ok, true);
		const data = eventsOfType(db, "phase_change")[0]!.data as Record<string, unknown>;
		assert.equal(data.reason, reason.slice(0, 2_000));
		// Not stored, so not truncated: the message a reader sees is the full reason.
		assert.equal(result.message, `Team failed by centurion decision: ${reason}`);
	});
});

test("#309 handled derivation: without a rework the old failure is not handled", async () => {
	// `reworkCount > 0` is the derivation's other precondition: an un-reworked team
	// has not sent a phase back, so a failure it records is not automatically
	// "accounted for" merely by being old.
	await withFixture(async (db, cwd) => {
		insertNode(db, { parentId: TEAM_ID, name: "worker", role: "worker", status: "failed" }, () => PHASE_SINCE - 10);
		insertNode(db, { parentId: TEAM_ID, name: "replacement", role: "worker", status: "settled" }, () => PHASE_SINCE + 20);
		const result = await request(db, cwd, "reviewing");
		assert.equal(result.ok, false);
		assert.match(result.message, /a child failed and must be handled/);
		assert.equal(getNode(db, TEAM_ID)?.phase, "implementing");
		assert.deepEqual(eventsOfType(db, "node_handled"), []);
	});
});
