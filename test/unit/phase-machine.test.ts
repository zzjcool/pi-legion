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
import { parsePhaseMachine } from "../../src/agents/agents.ts";
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
	// A centurion-only edge keeps the historical code; any other reserved
	// edge reports the general name.
	if (!denied.allowed) assert.equal(denied.reason, "centurion_required");
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

// ---------------------------------------------------------------------------
// #坑1 — a terminal phase may omit `next`, and every problem is classified
//
// The real failure this pins: a model declared
//   phases: [{ id: "planning", next: [{ to: "implementing" }] }, ..., { id: "done", terminal: true }]
// and got `phases[2].next: next must be an array` — a rule the author had not
// broken, because a terminal phase ends the walk and has nothing to declare. The
// self-edge in the same machine arrived as one more anonymous line, so the author
// could not tell which problem to fix first. Then fixing `next: []` kept the same
// message, because the crash was in normalizing ANOTHER terminal phase.
// ---------------------------------------------------------------------------

/** `planning → done`, where `done` is terminal and OMITS `next` entirely. */
const OMITTED_TERMINAL_NEXT = {
	start: "planning",
	phases: [
		{ id: "planning", next: [{ to: "done" }] },
		// `next` intentionally absent: a terminal phase declares no exits. Written as a
		// bare object on purpose — this is what a model actually hands over.
		{ id: "done", terminal: true },
	],
} as unknown as PhaseMachine;

/** The same machine, spelled with the (equally legal) explicit empty list. */
const EXPLICIT_EMPTY_TERMINAL_NEXT: PhaseMachine = {
	start: "planning",
	phases: [
		{ id: "planning", next: [{ to: "done" }] },
		{ id: "done", terminal: true, next: [] },
	],
};

test("# 坑1: a terminal phase may OMIT next — it validates, and the parser does not throw", () => {
	assert.deepEqual(
		validatePhaseMachine(OMITTED_TERMINAL_NEXT),
		[],
		"a terminal phase ends the walk, so declaring no exits is not an error",
	);
	const parsed = parsePhaseMachine(OMITTED_TERMINAL_NEXT, "subagent.phases", { requireTerminal: true });
	assert.ok(parsed, "`{ id: \"done\", terminal: true }` must be dispatchable as written");
	assert.deepEqual(
		parsed.phases.find((phase) => phase.id === "done")?.next,
		[],
		"normalization makes the omission explicit, so no later reader has to know about it",
	);
});

test("# 坑1: an omitted next and an explicit next: [] are the same machine", () => {
	assert.deepEqual(validatePhaseMachine(EXPLICIT_EMPTY_TERMINAL_NEXT), []);
	const omitted = parsePhaseMachine(OMITTED_TERMINAL_NEXT, "subagent.phases", { requireTerminal: true });
	const explicit = parsePhaseMachine(EXPLICIT_EMPTY_TERMINAL_NEXT, "subagent.phases", { requireTerminal: true });
	assert.deepEqual(omitted, explicit, "the two spellings must normalize to one machine, not merely both parse");
});

test("# 坑1: a self-edge is a successor problem that names the phase and shows a fix", () => {
	const machine = {
		start: "planning",
		phases: [
			{ id: "planning", next: [{ to: "done" }] },
			// The author's real typo: `implementing` lists itself second.
			{ id: "implementing", next: [{ to: "done" }, { to: "implementing" }] },
			{ id: "done", terminal: true },
		],
	} as unknown as PhaseMachine;
	// `implementing` is unreachable — pin the problem under test, not the noise.
	const self = validatePhaseMachine(machine).filter((error) => /lists itself/.test(error.message));
	assert.equal(self.length, 1, `expected exactly one self-edge problem, got ${JSON.stringify(self)}`);
	const [error] = self;
	assert.ok(error, "expected a self-edge problem");
	assert.equal(error.category, "successor");
	assert.match(error.path, /next\[1\]\.to$/, "the path must name the exact edge");
	assert.match(error.message, /'implementing'/, "the message must name the phase");
	assert.ok(error.fix, "every problem must say what to write instead");
	assert.match(error.fix, /\{ id: "implementing"/, "the fix must carry a copy-pasteable example");
});

test("# 坑1: an unreachable phase is reported with the start phase in the message", () => {
	const machine: PhaseMachine = {
		start: "planning",
		phases: [
			{ id: "planning", next: [{ to: "done" }] },
			{ id: "done", terminal: true, next: [] },
			// Declared, valid, and nothing points at it.
			{ id: "orphan", terminal: true, next: [] },
		],
	};
	const errors = validatePhaseMachine(machine);
	const unreachable = errors.filter((error) => error.category === "unreachable");
	assert.equal(unreachable.length, 1, JSON.stringify(errors));
	assert.match(unreachable[0]!.message, /'orphan'/);
	assert.match(unreachable[0]!.message, /'planning'/, "the message must name the start it is unreachable FROM");
	assert.match(unreachable[0]!.path, /^phases\[\d+\]$/, "one namespace: the same phases[i] every other problem uses");
	assert.ok(unreachable[0]!.fix, "an unreachable phase needs a fix with a legal edge");
	assert.match(unreachable[0]!.fix!, /\{ id: "planning"/);
});

test("# 坑1: several problems come back at once, grouped by category in a fixed order", () => {
	const machine: PhaseMachine = {
		start: "planning",
		phases: [
			// terminal-shaped AND a self-edge: two categories in one phase.
			{ id: "planning", next: [{ to: "done" }, { to: "planning" }] },
			{ id: "done", terminal: true, next: [{ to: "planning" }] },
			// nobody points at it
			{ id: "orphan", terminal: true, next: [] },
		],
	};
	const errors = validatePhaseMachine(machine);
	const categories = new Set(errors.map((error) => error.category));
	assert.ok(errors.length >= 3, `expected several problems, got ${JSON.stringify(errors)}`);
	for (const expected of ["terminal", "successor", "unreachable"] as const) {
		assert.ok(categories.has(expected), `expected a '${expected}' problem, got ${[...categories].join(", ")}`);
	}
	// …and the model-facing rendering groups them, so the author sees WHY they are
	// grouped instead of three anonymous lines.
	let rendered = "";
	assert.throws(
		() => parsePhaseMachine(machine, "subagent.phases"),
		(error: Error) => {
			rendered = error.message;
			return true;
		},
	);
	const lines = rendered.split("\n");
	assert.match(lines[0]!, /^Agent 'subagent\.phases' has an invalid phase machine: \d+ problems? in \d+ categories?\.$/);
	assert.equal(lines[0]!.endsWith("3 categories."), true, `expected three category groups: ${lines[0]}`);
	const order = lines
		.filter((line) => line.startsWith("["))
		.map((line) => line.slice(1, line.indexOf("]")));
	assert.deepEqual(order, ["terminal", "successor", "unreachable"], "group order is fixed: shape, terminal, routing, reachability");
	// Every problem line keeps the `  - <path>: <message>` shape and carries its fix.
	const problems = lines.filter((line) => line.startsWith("  - "));
	assert.equal(problems.length, errors.length);
	for (const line of problems) assert.match(line, /^  - \S+: \S/);
	assert.equal(lines.filter((line) => line.startsWith("    fix: ")).length, errors.length, "one fix line per problem");
});

test("# 坑1: maxRework is checked, and a rework edge under a zero cap names the edge", () => {
	const negative = validatePhaseMachine({
		start: "a",
		maxRework: -1,
		phases: [{ id: "a", next: [{ to: "done" }] }, { id: "done", terminal: true, next: [] }],
	}).filter((error) => error.category === "rework");
	assert.equal(negative.length, 1, "maxRework: -1 is a rework problem");
	assert.equal(negative[0]!.path, "maxRework");
	assert.match(negative[0]!.message, /non-negative integer/);

	const zeroCap = validatePhaseMachine({
		start: "ship",
		maxRework: 0,
		phases: [
			// `rework: true` under a cap of 0: the edge can never be taken, which used to
			// surface mid-run as `rework_limit_exceeded` instead of at load.
			{ id: "ship", next: [{ to: "draft", rework: true }, { to: "done" }] },
			{ id: "draft", next: [{ to: "ship" }] },
			{ id: "done", terminal: true, next: [] },
		],
	}).filter((error) => error.category === "rework");
	assert.equal(zeroCap.length, 1, JSON.stringify(zeroCap));
	assert.match(zeroCap[0]!.message, /'ship'/, "the message must name the phase");
	assert.match(zeroCap[0]!.message, /'draft'/, "…and the edge it is about");
	assert.match(zeroCap[0]!.path, /^phases\[0\]\.next\[0\]\.rework$/);
	assert.match(zeroCap[0]!.fix!, /maxRework: 1/, "the fix must offer a cap that works");
});

test("# 坑1: a non-terminal phase that omits next is told both ways out", () => {
	const errors = validatePhaseMachine({
		start: "a",
		phases: [
			{ id: "a", next: [{ to: "b" }] },
			// Omitted `next` AND not terminal: the walk would stop dead here.
			{ id: "b" },
		],
	} as unknown as PhaseMachine);
	const terminal = errors.filter((error) => error.category === "terminal");
	assert.equal(terminal.length, 1, JSON.stringify(errors));
	assert.equal(terminal[0]!.path, "phases[1].next");
	assert.match(terminal[0]!.message, /'b'/);
	assert.ok(terminal[0]!.fix, "the author must be told what to write");
	assert.match(terminal[0]!.fix!, /add a transition/, "one way out: give the phase an edge");
	assert.match(terminal[0]!.fix!, /terminal: true/, "the other way out: end the walk there");
});
