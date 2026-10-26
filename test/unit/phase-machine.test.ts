/**
 * #298: a team can declare its own phase machine.
 *
 * The old table was a switch, and its rules were keyed on ROLE NAMES — leaving
 * `implementing` required every `role === "worker"` to be settled. These cases
 * pin the two properties that make a declaration meaningful:
 *
 *   1. a custom phase list actually drives transitions
 *   2. nothing depends on a role being called "worker" or "reviewer"
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
	DEFAULT_PHASE_MACHINE,
	validatePhaseMachine,
	type PhaseMachine,
} from "../../src/legion/phase-machine.ts";
import {
	checkPhaseCondition,
	checkPhaseRequirements,
} from "../../src/legion/phase-conditions.ts";
import { evaluatePhaseTransition } from "../../src/legion/state-machine.ts";

const decide = (input: Parameters<typeof evaluatePhaseTransition>[0]) =>
	evaluatePhaseTransition(input, () => 12_345);

/** A three-phase machine that shares no phase names with the built-in one. */
const CUSTOM: PhaseMachine = {
	start: "draft",
	maxRework: 1,
	phases: [
		{
			id: "draft",
			next: [
				{ to: "build", require: ["contract_file"] },
				{ to: "failed" },
			],
		},
		{
			id: "build",
			next: [
				{ to: "ship", require: ["children_settled"] },
				{ to: "failed", require: ["children_all_failed"] },
			],
		},
		{
			id: "ship",
			next: [
				{ to: "draft", require: ["verdict_not_ok"], rework: true },
				{ to: "done", require: ["verdict_ok"] },
			],
		},
		{ id: "done", terminal: true, next: [] },
		{ id: "failed", terminal: true, next: [] },
	],
};

test("#298: a custom machine drives transitions, and its own names are accepted", () => {
	const ok = decide({ from: null, to: "draft", machine: CUSTOM });
	assert.equal(ok.allowed, true, "a new team enters the declared start phase");

	assert.equal(
		decide({ from: "draft", to: "build", contractPresent: true, contractPath: "/c.md", machine: CUSTOM }).allowed,
		true,
	);
	assert.equal(
		decide({ from: "draft", to: "build", contractPresent: false, machine: CUSTOM }).allowed,
		false,
		"the edge requires a contract",
	);
	// Phase names that do not exist in the built-in machine.
	assert.equal(decide({ from: "build", to: "ship", children: [], machine: CUSTOM }).allowed, true);
	assert.equal(decide({ from: "ship", to: "done", reviewerVerdictOk: true, machine: CUSTOM }).allowed, true);
});

test("#298: the declared phase list is the ONLY list — built-in names are refused", () => {
	const refused = decide({ from: "draft", to: "implementing", machine: CUSTOM });
	assert.equal(refused.allowed, false);
	if (!refused.allowed) assert.equal(refused.reason, "invalid_phase");

	// And the reverse: the built-in machine does not know the custom names.
	const builtin = decide({ from: "draft", to: "build" });
	assert.equal(builtin.allowed, false);
});

test("#298: no condition branches on a role name", () => {
	// The same child set decides the same way whatever the roles are called.
	const settled = [
		{ id: "a", role: "worker", status: "settled" },
		{ id: "b", role: "reviewer", status: "settled" },
	];
	const renamed = [
		{ id: "a", role: "anyone", status: "settled" },
		{ id: "b", role: "whatever", status: "settled" },
	];
	for (const condition of ["children_settled", "children_none_failed"] as const) {
		assert.equal(
			checkPhaseCondition(condition, { children: settled }),
			checkPhaseCondition(condition, { children: renamed }),
			`'${condition}' must not distinguish roles`,
		);
	}
	// An active child blocks settlement regardless of its role.
	for (const role of ["worker", "reviewer", "totally-made-up"]) {
		assert.equal(
			checkPhaseCondition("children_settled", { children: [{ id: "x", role, status: "running" }] }),
			false,
		);
	}
});

test("#298: children_all_failed needs children, and children_none_failed honours handled ids", () => {
	assert.equal(checkPhaseCondition("children_all_failed", { children: [] }), false, "no children is not 'all failed'");
	assert.equal(
		checkPhaseCondition("children_all_failed", {
			children: [{ id: "a", role: "any", status: "failed" }],
		}),
		true,
	);
	const withFailure = {
		children: [{ id: "a", role: "any", status: "failed" }],
	};
	assert.equal(checkPhaseCondition("children_none_failed", withFailure), false);
	assert.equal(
		checkPhaseCondition("children_none_failed", { ...withFailure, handledIds: ["a"] }),
		true,
		"a handled failure no longer blocks",
	);
});

test("#298: rework edges count against the declared cap", () => {
	const first = decide({ from: "ship", to: "draft", reviewerVerdictOk: false, reworkCount: 0, machine: CUSTOM });
	assert.equal(first.allowed, true);
	if (first.allowed) assert.equal(first.reworkCount, 1);

	// maxRework is 1 in CUSTOM, so a second rework forces failure.
	const second = decide({ from: "ship", to: "draft", reviewerVerdictOk: false, reworkCount: 1, machine: CUSTOM });
	assert.equal(second.allowed, false);
	if (!second.allowed) {
		assert.equal(second.reason, "rework_limit_exceeded");
		assert.equal(second.forcedTransition?.to, "failed");
	}
});

test("#298: an edge reserved to an actor is refused for anyone else", () => {
	const machine: PhaseMachine = {
		phases: [
			{ id: "a", next: [{ to: "b", actorRole: "centurion" }, { to: "failed" }] },
			{ id: "b", next: [{ to: "failed" }] },
			{ id: "failed", terminal: true, next: [] },
		],
		start: "a",
	};
	const denied = decide({ from: "a", to: "b", actorRole: "worker", machine });
	assert.equal(denied.allowed, false);
	if (!denied.allowed) assert.equal(denied.reason, "actor_not_permitted");
	assert.equal(decide({ from: "a", to: "b", actorRole: "centurion", machine }).allowed, true);
});

test("#298: terminal exits keep their non-negotiable preconditions", () => {
	// `failed` still needs a reason.
	const noReason = decide({ from: "build", to: "failed", machine: CUSTOM });
	assert.equal(noReason.allowed, false);

	assert.equal(
		decide({ from: "build", to: "failed", terminalReason: "parent_decision", machine: CUSTOM }).allowed,
		true,
	);
	// `aborted` still needs a parent retire.
	assert.equal(decide({ from: "build", to: "aborted", machine: CUSTOM }).allowed, false);
	assert.equal(
		decide({ from: "build", to: "aborted", terminalReason: "parent_retire", machine: CUSTOM }).allowed,
		true,
	);
});

test("#298: an invalid machine is rejected at load with every problem listed", () => {
	const broken: PhaseMachine = {
		start: "a",
		phases: [
			{ id: "a", next: [{ to: "ghost" }] },
			{ id: "a", next: [] },
			{ id: "b", next: [] },
		],
	};
	const errors = validatePhaseMachine(broken);
	assert.ok(errors.length >= 3, `expected several problems, got ${JSON.stringify(errors)}`);
	const messages = errors.map((error) => `${error.path}: ${error.message}`).join("\n");
	assert.match(messages, /duplicate phase id 'a'/);
	assert.match(messages, /unknown target phase 'ghost'/);
	assert.match(messages, /unreachable/);
});

test("#298: an unknown condition, a self-edge, and a terminal start are caught", () => {
	const bad = validatePhaseMachine({
		start: "done",
		phases: [
			// @ts-expect-error deliberately invalid condition name
			{ id: "a", next: [{ to: "a", require: ["no_such_condition"] }] },
			{ id: "done", terminal: true, next: [] },
		],
	});
	const text = bad.map((error) => error.message).join("\n");
	assert.match(text, /unknown condition/);
	assert.match(text, /lists itself as a successor/);
	assert.match(text, /terminal/);
});

test("#298: the built-in machine validates, and reproduces the old pipeline", () => {
	assert.deepEqual(validatePhaseMachine(DEFAULT_PHASE_MACHINE), []);
	const ids = DEFAULT_PHASE_MACHINE.phases.map((phase) => phase.id);
	assert.deepEqual(ids, ["planning", "implementing", "reviewing", "verifying", "done", "failed", "aborted"]);

	// A requirement list is a conjunction; an empty one is vacuously true.
	assert.deepEqual(checkPhaseRequirements([], { children: [] }), { ok: true });
	assert.equal(checkPhaseRequirements(["always"], { children: [] }).ok, true);
});

test("#298: a refused transition names the legal exits", () => {
	// Measured: with a custom `recon -> build` machine, a model described the
	// available transitions as `recon -> check` and `recon -> done`, neither of
	// which existed. It had no way to read the machine, so it guessed. The refusal
	// must therefore carry the answer instead of leaving the model to invent one.
	// Universal terminals are injected into every non-terminal phase, so an
	// illegal edge can only be a non-terminal target: `check` is declared but
	// `recon` lists only `build` and the injected terminals.
	const refused = decide({ from: "recon", to: "check", machine: RECON_ONLY });
	assert.equal(refused.allowed, false);
	if (!refused.allowed) {
		assert.equal(refused.reason, "invalid_transition");
		assert.match(refused.message, /legal next phases from 'recon'/);
		// `done` is injected as a universal terminal, so it IS legal — a card cannot
		// lose the ability to complete. What must appear is the real shortlist.
		assert.match(refused.message, /build/);
	}
	// A phase with no exits is reported as such rather than an empty list.
	assert.equal(RECON_ONLY.phases.find((phase) => phase.id === "check")?.next.length, 1);
});

/** `recon` may only reach `build`; everything else is injected. */
const RECON_ONLY: PhaseMachine = {
	start: "recon",
	phases: [
		{ id: "recon", next: [{ to: "build" }] },
		{ id: "build", next: [{ to: "recon" }] },
		{ id: "check", next: [{ to: "recon" }] },
	],
};
