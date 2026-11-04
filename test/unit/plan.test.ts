/**
 * Tests for the `subagent` tool's request planning.
 *
 * `buildPlan` decides which of the two request shapes was used and turns it
 * into the list of steps to launch. It is the last gate before resources are
 * allocated, so every malformed input must be rejected HERE rather than
 * surfacing later as a child that starts with nothing to do.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPlan, unknownAgentLine } from "../../index.ts";
import type { AgentConfig } from "../../src/shared/types.ts";

test("plan: exactly one request shape must be provided", () => {
	const none = buildPlan({});
	assert.equal(none.ok, false);

	const both = buildPlan({
		agent: "worker",
		task: "do it",
		tasks: [{ agent: "worker", task: "other" }],
	});
	assert.equal(both.ok, false, "ambiguous requests must be refused");
});

test("plan: a single agent+task is accepted", () => {
	const plan = buildPlan({ agent: "worker", task: "do it" });
	assert.equal(plan.ok, true);
	assert.deepEqual(plan.steps, [{ agent: "worker", task: "do it" }]);
});

test("plan: a single request with a blank task is refused", () => {
	for (const task of ["", "   ", "\n", "\t"]) {
		const plan = buildPlan({ agent: "worker", task });
		assert.equal(
			plan.ok,
			false,
			`a blank task must be refused (got ${JSON.stringify(task)})`,
		);
	}
});

// ─────────────────────────────────────────────────────────────────────────────
// BUG 19: `tasks[]` entries were taken on trust, so a missing or
// blank `agent`/`task` produced a step that launched a child with nothing to do
// — or with an empty agent name that failed only after a pane was allocated.
// ─────────────────────────────────────────────────────────────────────────────

test("plan: tasks[] entries are validated", () => {
	const bad: Array<[string, unknown]> = [
		["empty task", { tasks: [{ agent: "worker", task: "" }] }],
		["whitespace task", { tasks: [{ agent: "worker", task: "   " }] }],
		["empty agent", { tasks: [{ agent: "", task: "do it" }] }],
		["missing agent", { tasks: [{ task: "do it" }] }],
		["missing task", { tasks: [{ agent: "worker" }] }],
		[
			"second entry bad",
			{
				tasks: [
					{ agent: "a", task: "x" },
					{ agent: "", task: "y" },
				],
			},
		],
	];
	for (const [label, params] of bad) {
		const plan = buildPlan(params as Parameters<typeof buildPlan>[0]);
		assert.equal(plan.ok, false, `tasks[] must reject: ${label}`);
	}

	const good = buildPlan({
		tasks: [
			{ agent: "worker", task: "a" },
			{ agent: "reviewer", task: "b", model: "cb/glm-5.3" },
		],
	});
	assert.equal(good.ok, true);
	assert.equal(good.steps.length, 2);
});

test("plan: tasks[] preserves a per-child worktree flag", () => {
	const plan = buildPlan({
		tasks: [
			{ agent: "worker", task: "a", worktree: true },
			{ agent: "worker", task: "b", worktree: false },
		],
	});
	assert.equal(plan.ok, true);
	assert.equal(plan.steps[0]?.worktree, true);
	assert.equal(plan.steps[1]?.worktree, false);
});

test("plan: the unknown-agent refusal is a single, complete line", () => {
	// This is the ONLY feedback a typo'd agent name produces, and the marker was
	// accidentally doubled during a refactor without any test noticing. Assert the
	// exact string so a future rewrite cannot silently re-prefix it.
	const agents = [{ name: "scout" }, { name: "worker" }] as AgentConfig[];
	assert.equal(
		unknownAgentLine(agents, "nope"),
		'✗ unknown agent "nope". Available: scout, worker',
	);
	// One marker, not two (the regression that prompted this test).
	assert.equal((unknownAgentLine(agents, "nope").match(/✗/g) ?? []).length, 1);
});

test('plan: the unknown-agent refusal says "none" when no agent is known', () => {
	assert.match(unknownAgentLine([], "nope"), /Available: none$/);
});

// ─────────────────────────────────────────────────────────────────────────────
// `tasks[]` entries could always carry a `name` (models wrote one: the top-level
// `name` is documented right next to `tasks[]`), but the field was not in the
// schema nor read by `launchStep`, so every child was silently numbered
// `role-N`. The handle now has to be honored — and a handle that cannot be
// honored refuses the WHOLE batch, before anything is spawned.
// ─────────────────────────────────────────────────────────────────────────────

test("plan: a tasks[] step name is normalized like name= (trim + lowercase)", () => {
	const plan = buildPlan({
		tasks: [
			{ agent: "worker", task: "a", name: " Worker-A " },
			{ agent: "worker", task: "b", name: "SCOUT_B" },
		],
	});
	assert.equal(plan.ok, true);
	assert.equal((plan.steps[0] as { name?: string }).name, "worker-a");
	assert.equal((plan.steps[1] as { name?: string }).name, "scout_b");
});

test("plan: an illegal tasks[] step name is refused with its step number", () => {
	const plan = buildPlan({
		tasks: [
			{ agent: "worker", task: "fine", name: "worker-a" },
			{ agent: "worker", task: "bad", name: "Worker A!" },
		],
	});
	assert.equal(plan.ok, false, "an unhonorable handle must not be launched under a different name");
	if (plan.ok) return;
	assert.match(plan.message, /^tasks\[\]: step 2/);
	// The grammar refusal itself is reused verbatim, so the fix has one wording.
	assert.match(plan.message, /invalid child name "Worker A!": must match \[a-z\]/);
});

test("plan: duplicate tasks[] step names refuse and name both steps", () => {
	for (const [second, label] of [
		["worker-a", "identical"],
		[" WORKER-A ", "case/space difference"],
	] as const) {
		const plan = buildPlan({
			tasks: [
				{ agent: "worker", task: "a", name: "worker-a" },
				{ agent: "worker", task: "b", name: second },
			],
		});
		assert.equal(plan.ok, false, `duplicate names must be refused (${label})`);
		if (plan.ok) continue;
		assert.match(plan.message, /steps 1 and 2 both ask for the name "worker-a"/);
	}
	// Three entries: report the pair that collides, not the first entry.
	const third = buildPlan({
		tasks: [
			{ agent: "worker", task: "a", name: "worker-a" },
			{ agent: "worker", task: "b", name: "worker-b" },
			{ agent: "worker", task: "c", name: "worker-b" },
		],
	});
	assert.equal(third.ok, false);
	if (!third.ok) assert.match(third.message, /steps 2 and 3/);
});

test("plan: a one-entry tasks[] may name the child in both places only if they agree", () => {
	const conflict = buildPlan({
		name: "worker-b",
		tasks: [{ agent: "worker", task: "a", name: "worker-a" }],
	});
	assert.equal(conflict.ok, false, "two different handles for one child is ambiguous");
	if (!conflict.ok) {
		assert.match(conflict.message, /step 1 asks for the name "worker-a"/);
		assert.match(conflict.message, /also passes name="worker-b"/);
	}

	const agree = buildPlan({
		name: " Worker-A ",
		tasks: [{ agent: "worker", task: "a", name: "worker-a" }],
	});
	assert.equal(agree.ok, true, "the same handle in both places is not a conflict");
	assert.equal((agree.steps[0] as { name?: string }).name, "worker-a");
});

test("plan: a tasks[] entry without a name keeps no name key", () => {
	const plan = buildPlan({
		tasks: [
			{ agent: "worker", task: "a" },
			{ agent: "scout", task: "b", name: "scout-b" },
		],
	});
	assert.equal(plan.ok, true);
	assert.equal(Object.hasOwn(plan.steps[0] ?? {}, "name"), false, "no synthesized name key");
	assert.deepEqual(plan.steps[0], { agent: "worker", task: "a" });
	assert.deepEqual(plan.steps[1], { agent: "scout", task: "b", name: "scout-b" });
});
