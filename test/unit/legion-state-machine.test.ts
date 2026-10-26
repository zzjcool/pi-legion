import { test } from "node:test";
import assert from "node:assert/strict";
import {
	DEFAULT_PHASE_TIMEOUTS,
	LEGION_PHASES,
	MAX_REWORK_COUNT,
	checkPhaseTimeout,
	evaluatePhaseTransition,
} from "../../src/legion/state-machine.ts";
import type { EvaluatePhaseTransitionInput, LegionPhase, PhaseChild } from "../../src/legion/state-machine.ts";

const worker: PhaseChild = { id: "root.team.worker", role: "worker", status: "settled" };
const reviewer: PhaseChild = { id: "root.team.reviewer", role: "reviewer", status: "settled" };
const decide = (input: EvaluatePhaseTransitionInput) => evaluatePhaseTransition(input, () => 12_345);

test("phase machine allows each normal transition, including notifying parent on plan reset", () => {
	assert.equal(decide({ from: null, to: "planning" }).allowed, true);
	assert.equal(decide({ from: "planning", to: "implementing", contractPath: "/tmp/contract.md" }).allowed, true);
	assert.equal(decide({ from: "implementing", to: "reviewing", children: [worker] }).allowed, true);
	assert.equal(decide({ from: "reviewing", to: "verifying", children: [reviewer], reviewerVerdictOk: true }).allowed, true);
	assert.equal(decide({ from: "verifying", to: "done", children: [worker], verificationPassed: true }).allowed, true);
	const reset = decide({ from: "reviewing", to: "planning", actorRole: "centurion" });
	assert.equal(reset.allowed, true);
	if (reset.allowed) {
		assert.equal(reset.notifyParent, true);
		assert.equal(reset.event.type, "phase_change");
	}
	assert.equal(decide({ from: "implementing", to: "failed", terminalReason: "parent_decision" }).allowed, true);
	assert.equal(decide({ from: "reviewing", to: "aborted", terminalReason: "parent_retire" }).allowed, true);
	assert.equal(
		decide({ from: "implementing", to: "aborted", terminalReason: "parent_retire", children: [{ id: "p", role: "planner", status: "running" }] }).allowed,
		true,
	);
});

test("phase machine matches the complete §7.1 source/destination matrix", () => {
	const active: Array<LegionPhase | null> = [null, "planning", "implementing", "reviewing", "verifying"];
	for (const from of active) {
		for (const to of LEGION_PHASES) {
			const result = decide(transitionInput(from, to));
			assert.equal(result.allowed, isAllowed(from, to), `${from ?? "new"} -> ${to}`);
		}
	}
	for (const from of ["done", "failed", "aborted"] as const) {
		for (const to of LEGION_PHASES) {
			const result = decide(transitionInput(from, to));
			assert.equal(result.allowed, false, `${from} -> ${to}`);
			if (!result.allowed) assert.equal(result.reason, from === to ? "same_phase" : "terminal_phase");
		}
	}
});

test("rework returns to implementing twice and forces failed after count exceeds two", () => {
	for (const evidence of [
		{ from: "reviewing", reviewerVerdictOk: false },
		{ from: "verifying", verificationPassed: false },
	] as const) {
		const first = decide({ ...evidence, to: "implementing", reworkCount: 0 });
		const second = decide({ ...evidence, to: "implementing", reworkCount: 1 });
		const third = decide({ ...evidence, to: "implementing", reworkCount: 2 });
		assert.equal(first.allowed, true);
		if (first.allowed) assert.equal(first.reworkCount, 1);
		assert.equal(second.allowed, true);
		if (second.allowed) assert.equal(second.reworkCount, MAX_REWORK_COUNT);
		assert.equal(third.allowed, false);
		if (!third.allowed) {
			assert.equal(third.reason, "rework_limit_exceeded");
			assert.equal(third.forcedTransition?.to, "failed");
			assert.equal(third.forcedTransition?.reworkCount, MAX_REWORK_COUNT + 1);
		}
	}
});

test("phase machine rejects each violated invariant and invalid evidence", () => {
	const rejected: Array<[EvaluatePhaseTransitionInput, string]> = [
		[{ from: null, to: "failed", terminalReason: "parent_decision" }, "invalid_transition"],
		[{ from: "planning", to: "implementing" }, "contract_path_required"],
		[{ from: "implementing", to: "reviewing", children: [{ ...worker, status: "running" }] }, "worker_still_active"],
		[{ from: "implementing", to: "reviewing", children: [{ ...worker, status: "failed" }, { id: "w2", role: "worker", status: "settled" }] }, "failed_worker_unhandled"],
		// #298: the old rule named `planner` and used the code `planner_still_active`.
		// The intent was "nothing may still be in flight when we leave implementation",
		// which is now the structural `children_settled` requirement — so any active
		// child blocks, whatever it is called.
		[{ from: "implementing", to: "reviewing", children: [{ id: "p", role: "planner", status: "running" }] }, "worker_still_active"],
		[{ from: "implementing", to: "failed", terminalReason: "parent_decision", children: [{ id: "p", role: "planner", status: "running" }] }, "children_not_terminal"],
		[{ from: "reviewing", to: "verifying", children: [], reviewerVerdictOk: true }, "reviewer_not_settled"],
		[{ from: "reviewing", to: "verifying", children: [reviewer], reviewerVerdictOk: false }, "review_verdict_not_accepted"],
		[{ from: "reviewing", to: "implementing", reviewerVerdictOk: true }, "review_verdict_not_rejected"],
		[{ from: "verifying", to: "implementing", verificationPassed: true }, "verification_not_failed"],
		[{ from: "reviewing", to: "planning", actorRole: "worker" }, "centurion_required"],
		[{ from: "verifying", to: "done", children: [{ ...worker, status: "running" }], verificationPassed: true }, "children_not_terminal"],
		[{ from: "verifying", to: "done", children: [worker] }, "verification_not_passed"],
		[{ from: "planning", to: "planning" }, "same_phase"],
		[{ from: "planning", to: "aborted" }, "terminal_reason_required"],
		[{ from: "planning", to: "failed" }, "terminal_reason_required"],
		[{ from: "reviewing", to: "failed", terminalReason: "all_children_failed", children: [worker] }, "all_children_not_failed"],
		[{ from: "reviewing", to: "failed", terminalReason: "rework_exhausted", reworkCount: 2 }, "rework_limit_exceeded"],
	];
	for (const [input, reason] of rejected) {
		const result = decide(input);
		assert.equal(result.allowed, false, JSON.stringify(input));
		if (!result.allowed) {
			assert.equal(result.reason, reason);
			assert.equal(result.alarm, true);
		}
	}
});

test("all failed workers produce a forced failed reason; timeout uses independent clocks", () => {
	const allFailed = decide({
		from: "implementing", to: "reviewing",
		children: [{ id: "w1", role: "worker", status: "failed" }, { id: "w2", role: "worker", status: "failed" }],
	});
	assert.equal(allFailed.allowed, false);
	if (!allFailed.allowed) assert.equal(allFailed.forcedTransition?.reason, "all_children_failed");
	assert.equal(decide({ from: "reviewing", to: "failed", terminalReason: "all_children_failed", children: [{ id: "w", role: "worker", status: "failed" }] }).allowed, true);
	assert.equal(decide({ from: "reviewing", to: "failed", terminalReason: "rework_exhausted", reworkCount: 3 }).allowed, true);
	assert.equal(DEFAULT_PHASE_TIMEOUTS.planning, 900_000);
	assert.equal(checkPhaseTimeout({ phase: "planning", phaseSince: 1_000 }, () => 901_001).timedOut, true);
	assert.equal(checkPhaseTimeout({ phase: "planning", phaseSince: null, now: 100 }).timedOut, false);
	assert.equal(checkPhaseTimeout({ phase: "done", phaseSince: 1, now: 10 }).timedOut, false);
	assert.equal(checkPhaseTimeout({ phase: "implementing", phaseSince: 0, now: 10, timeouts: { implementing: 5 } }).timedOut, true);
});

function transitionInput(from: LegionPhase | null, to: LegionPhase): EvaluatePhaseTransitionInput {
	if (from === null && to === "planning") return { from, to };
	if (from === null) return { from, to };
	if (to === "failed") return { from, to, terminalReason: "parent_decision" };
	if (to === "aborted") return { from, to, terminalReason: "parent_retire" };
	if (from === "planning" && to === "implementing") return { from, to, contractPath: "/contract.md" };
	if (from === "implementing" && to === "reviewing") return { from, to, children: [worker] };
	if (from === "reviewing" && to === "verifying") return { from, to, children: [reviewer], reviewerVerdictOk: true };
	if (from === "reviewing" && to === "implementing") return { from, to, reviewerVerdictOk: false };
	if (from === "reviewing" && to === "planning") return { from, to, actorRole: "centurion" };
	if (from === "verifying" && to === "implementing") return { from, to, verificationPassed: false };
	if (from === "verifying" && to === "done") return { from, to, children: [worker], verificationPassed: true };
	return { from, to };
}

function isAllowed(from: LegionPhase | null, to: LegionPhase): boolean {
	if (from === null) return to === "planning";
	if (["done", "failed", "aborted"].includes(from)) return false;
	if (to === "failed" || to === "aborted") return true;
	if (from === "planning") return to === "implementing";
	if (from === "implementing") return to === "reviewing";
	if (from === "reviewing") return ["planning", "implementing", "verifying"].includes(to);
	if (from === "verifying") return to === "implementing" || to === "done";
	return false;
}
