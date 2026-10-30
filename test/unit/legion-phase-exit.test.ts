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
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const TEAM_ID = "root.team-a";
const PHASE_SINCE = 1_000;
const NOW = 5_000;

type Db = ReturnType<typeof openLegionDb>;

function makePhaseFixture(): Db {
	const db = openLegionDb(":memory:");
	insertNode(db, { parentId: null, name: "root", role: "root", status: "running" }, () => PHASE_SINCE - 500);
	// `reworkCount: 0` is the whole point: `implementing` has no rework edge, so a
	// team that lands here can never raise it, and the `reworkCount > 0` derivation
	// of `handledIds` can never fire from this phase.
	insertNode(db, {
		parentId: "root",
		name: "team-a",
		role: "centurion",
		status: "running",
		phase: "implementing",
		phaseSince: PHASE_SINCE,
		reworkCount: 0,
	}, () => PHASE_SINCE);
	return db;
}

/** One failed child plus one settled sibling: the partial-failure shape of #309. */
function seedPartialFailure(db: Db): void {
	insertNode(db, { parentId: TEAM_ID, name: "worker", role: "worker", status: "failed" }, () => PHASE_SINCE + 10);
	insertNode(db, { parentId: TEAM_ID, name: "replacement", role: "worker", status: "settled" }, () => PHASE_SINCE + 20);
}

async function withFixture(run: (db: Db, cwd: string) => Promise<void>): Promise<void> {
	const cwd = mkdtempSync(path.join(tmpdir(), "legion-phase-exit-"));
	const db = makePhaseFixture();
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
