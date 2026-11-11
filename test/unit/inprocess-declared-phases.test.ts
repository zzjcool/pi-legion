/**
 * R7 — the declared phase machine reaches an IN-PROCESS child (#371 / #374).
 *
 * `PI_LEGION_PHASES` is written by `Orchestrator.lineageEnv` into the spawn env,
 * which is the rpc child's real environment. An in-process child shares the
 * HOST's `process.env` instead, so `phaseMachineForNode` read nothing there and
 * a declared machine silently degraded to the role card — an undeclared card
 * means NO machine, so a custom phase name then failed `invalid_phase` at run
 * time. The machine therefore rides the same ALS channel `team` and `role` use
 * (`ChildLaunchContext.phases`).
 *
 * This file is the CONSUMER half. The producer half (`phasesFromSpawnEnv` and
 * the two context branches) is pinned in `inprocess-supervisor.test.ts`.
 * Splitting them matters: the previous suite asserted only "the spawn input's
 * env carries the machine" and then parsed it by hand — a fact that stays true
 * with the entire consumer deleted (`phaseMachineForNode` had zero references
 * in `test/`). The false green dies here, where the assertion runs against the
 * function production actually calls.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import {
	runInChildContext,
	runOutsideChildContext,
	type ChildLaunchContext,
} from "../../src/supervisor/child-context.ts";
import {
	InProcessSupervisor,
	type InProcessSession,
} from "../../src/supervisor/inprocess-supervisor.ts";
import type { SpawnInput } from "../../src/supervisor/types.ts";
import { parsePhaseMachine } from "../../src/agents/agents.ts";
import { LEGION_PHASES_ENV } from "../../src/runs/args.ts";
import type { PhaseMachine } from "../../src/legion/phase-machine.ts";
import { phaseMachineForNode } from "../../index.ts";

/**
 * `spec → impl → ship → done`: names the built-in machine has never heard of,
 * which is exactly the shape that used to die as `invalid_phase`.
 */
const DECLARED = {
	start: "spec",
	phases: [
		{ id: "spec", next: [{ to: "impl" }] },
		{ id: "impl", next: [{ to: "ship" }] },
		{ id: "ship", next: [{ to: "done", require: ["verification_passed"] }] },
	],
};

/** The machine as the production parser hands it over (normalized terminals). */
function declaredMachine(): PhaseMachine {
	const parsed = parsePhaseMachine(JSON.stringify(DECLARED), LEGION_PHASES_ENV);
	assert.ok(parsed, "the fixture must survive the production parser");
	return parsed;
}

class NullSession implements InProcessSession {
	subscribe(): () => void {
		return () => {};
	}
	async prompt(): Promise<unknown> {
		return undefined;
	}
	dispose(): void {}
}

function testAgent() {
	return {
		name: "centurion",
		description: "unit test agent",
		kind: "pi" as const,
		source: "user" as const,
		filePath: "/tmp/centurion.md",
		systemPrompt: "Follow the role instructions.",
		systemPromptMode: "append" as const,
		inheritProjectContext: true,
		inheritSkills: false,
		tools: ["read"],
		spawnMode: "inprocess" as const,
	};
}

function spawnInput(root: string, name = "root.team"): SpawnInput {
	return {
		name,
		task: "declare a phase machine",
		agent: testAgent(),
		sessionFile: path.join(root, `${name}.jsonl`),
		tempDir: root,
		cwd: root,
	};
}

test("R7 consumer: an in-process child's declared machine is what phaseMachineForNode answers", async () => {
	const root = mkdtempSync(path.join(tmpdir(), "legion-inprocess-phases-als-"));
	const answers: Array<PhaseMachine | undefined> = [];
	const workerAnswers: Array<PhaseMachine | undefined> = [];
	const supervisor = new InProcessSupervisor({
		limits: { maxActive: 4 },
		sessionFactory: async () => {
			// The session factory runs inside the child's ALS scope, exactly like the
			// child's own extension load — so what this call sees is what the child
			// sees. `{}` settings means no settings file, and the temp cwd has no
			// cards, so a miss really is "no machine at all".
			answers.push(phaseMachineForNode("centurion", root, {}));
			workerAnswers.push(phaseMachineForNode("worker", root, {}));
			return new NullSession();
		},
	});
	try {
		await supervisor.spawnChild({
			...spawnInput(root),
			env: { [LEGION_PHASES_ENV]: JSON.stringify(DECLARED) },
		});
		assert.deepEqual(
			answers,
			[declaredMachine()],
			"the machine the spawn env carried, not the (absent) card fallback",
		);
		// The role gate survives: a member never walks its lead's declared machine.
		// Asserted on the declaration's own phase name, so a card that DOES declare
		// phases for `worker` is still a valid (non-leaking) answer.
		assert.equal(
			workerAnswers[0]?.phases.some((phase) => phase.id === "ship") ?? false,
			false,
			"the lead's custom phase name did not leak into the member",
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("R7 consumer: the ALS value alone is enough — context > env > card", async () => {
	const root = mkdtempSync(path.join(tmpdir(), "legion-inprocess-phases-als-scope-"));
	const ctx: ChildLaunchContext = {
		allowNested: true,
		utility: false,
		spawnMode: "inprocess",
		phases: declaredMachine(),
	};
	try {
		const answer = await runInChildContext(ctx, async () => phaseMachineForNode("centurion", root, {}));
		assert.deepEqual(answer, declaredMachine(), "the context value IS the answer");

		// Nothing leaks outside the scope: whatever the host's env/cards say, it is
		// not this declaration (an ambient `PI_LEGION_PHASES` would be the parent's).
		const outside = phaseMachineForNode("centurion", root, {});
		assert.equal(
			outside?.phases.some((phase) => phase.id === "ship") ?? false,
			false,
			"the declaration is scoped to the child, not to the process",
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

/**
 * The ENV leg: an rpc child has NO ALS context — its `process.env` really is the
 * spawn env — so the env read in `phaseMachineForNode` is that backend's only
 * channel. It had zero assertions: deleting the read kept every unit green, which
 * is exactly the false green that let a declared machine degrade to the card (or
 * to no machine at all) for rpc children.
 */
test("R7 consumer: with no child context at all, the env declaration IS the answer (the rpc channel)", () => {
	const root = mkdtempSync(path.join(tmpdir(), "legion-inprocess-phases-env-"));
	const hadKey = Object.hasOwn(process.env, LEGION_PHASES_ENV);
	const previous = process.env[LEGION_PHASES_ENV];
	// `runOutsideChildContext` makes the "no ALS context" premise explicit rather
	// than incidental: a top-level test body happens to have none today, and this
	// keeps that true if a future harness ever runs the file inside a team scope.
	process.env[LEGION_PHASES_ENV] = JSON.stringify(DECLARED);
	try {
		const answer = runOutsideChildContext(() => phaseMachineForNode("centurion", root, {}));
		assert.deepEqual(
			answer,
			declaredMachine(),
			"the env declaration, parsed and normalized, is what the rpc child's consumer returns",
		);
		// The role gate applies on this channel too: an rpc member must never adopt
		// its lead's declaration as its own.
		const member = runOutsideChildContext(() => phaseMachineForNode("worker", root, {}));
		assert.equal(
			member?.phases.some((phase) => phase.id === "ship") ?? false,
			false,
			"the lead's custom phase name did not leak into the member",
		);
	} finally {
		if (hadKey) process.env[LEGION_PHASES_ENV] = previous;
		else delete process.env[LEGION_PHASES_ENV];
		rmSync(root, { recursive: true, force: true });
	}
});

test("R7 consumer: an unreadable env declaration is NO machine — degrade, never throw", () => {
	const root = mkdtempSync(path.join(tmpdir(), "legion-inprocess-phases-env-bad-"));
	const hadKey = Object.hasOwn(process.env, LEGION_PHASES_ENV);
	const previous = process.env[LEGION_PHASES_ENV];
	const warnings: string[] = [];
	const originalWarn = console.warn;
	console.warn = (...args: unknown[]) => {
		warnings.push(args.map((arg) => String(arg)).join(" "));
	};
	process.env[LEGION_PHASES_ENV] = "{oops";
	try {
		// `index.ts` has always had this try/catch; nothing asserted it, so it could
		// have been replaced by a throw without a single red test. A bad declaration
		// costs the child its MACHINE, not its run (the same rule the in-process
		// producer applies) — and it warns, so the degrade is observable.
		const answer = runOutsideChildContext(() => phaseMachineForNode("centurion", root, {}));
		assert.equal(answer, undefined, "bad JSON is no machine, and it does not throw");
		assert.ok(
			warnings.some((line) => line.includes(LEGION_PHASES_ENV)),
			`the degrade is warned about:\n${warnings.join("\n")}`,
		);
	} finally {
		console.warn = originalWarn;
		if (hadKey) process.env[LEGION_PHASES_ENV] = previous;
		else delete process.env[LEGION_PHASES_ENV];
		rmSync(root, { recursive: true, force: true });
	}
});
