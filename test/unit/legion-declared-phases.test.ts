/**
 * #371 — the state machine is DECLARED by the root at dispatch time.
 *
 * The declaration used to be the role name: every `centurion` was born `planning`
 * and marched through the built-in four-phase pipeline whether or not the work
 * needed a team. This file covers the two halves that live in
 * `src/legion/phase-machine.ts` and `src/extension/legion-tools.ts`:
 *
 *   - G4's terminal-reachability question (`canReachTerminal`), asked only of an
 *     INLINE declaration and only of the DECLARED graph;
 *   - G5: `done` follows the declaration, while an undeclared machine keeps the
 *     pre-#371 rule verbatim (invariant I6);
 *   - G6: verification runs in the machine's own success phase, so a workflow
 *     that calls its last phase `ship` can still complete.
 *
 * The dispatch-side guards (G1–G3, I7) and the three e2e shapes of §6 live in
 * `test/integration/legion-declared-phases.test.ts`, because they need a real
 * launch: worktree, ledger row and spawn.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { registerLegionTools, requestLegionPhase, type LegionCommandRunner } from "../../src/extension/legion-tools.ts";
import { evaluatePhaseTransition } from "../../src/legion/state-machine.ts";
import { openLegionDb } from "../../src/legion/db.ts";
import { getNode, insertNode } from "../../src/legion/nodes.ts";
import {
	DEFAULT_PHASE_MACHINE,
	canReachTerminal,
	phaseStart,
	successPhaseOf,
	type PhaseMachine,
} from "../../src/legion/phase-machine.ts";
import { parsePhaseMachine } from "../../src/agents/agents.ts";

const NOW = 100_000;

/**
 * The shape a REAL dispatch runs (#371 C1).
 *
 * Every gate in the tool reads the machine the way production hands it over:
 * already normalized by `parsePhaseMachine`, which means the three universal
 * terminals are present and every non-terminal phase carries an INJECTED `→ done`
 * unless its author declared one. Feeding a raw literal instead is what let a
 * green unit test certify a gate that was true for every possible machine.
 */
function productionShape(machine: PhaseMachine): PhaseMachine {
	const parsed = parsePhaseMachine(machine, "subagent.phases", { requireTerminal: true });
	assert.ok(parsed, "the fixture must survive the production parser");
	return parsed;
}

/**
 * `spec → impl` with NO declared `done`: the injected edge is the only way out.
 *
 * The declared `impl → failed` is what keeps this a legal INLINE declaration —
 * G4 asks the DECLARED graph, and a machine whose only finish is the injected
 * `→ done` cannot answer "yes, I can end". (Card machines are not asked; their
 * rules are frozen, which is exactly why the supervisor's injected-edge path has
 * to keep working.)
 */
const NO_DONE_MACHINE: PhaseMachine = {
	start: "spec",
	phases: [
		{ id: "spec", next: [{ to: "impl" }] },
		{ id: "impl", next: [{ to: "failed" }] },
	],
};

/** `planning → implementing → done`, no conditions anywhere: the zero-child workflow. */
const SOLO_MACHINE: PhaseMachine = {
	start: "planning",
	phases: [
		{ id: "planning", next: [{ to: "implementing" }] },
		{ id: "implementing", next: [{ to: "done" }] },
		{ id: "done", terminal: true, next: [] },
	],
};

/** A workflow the built-in union has never heard of: `spec → impl → ship → done`. */
const SHIP_MACHINE: PhaseMachine = {
	start: "spec",
	phases: [
		{ id: "spec", next: [{ to: "impl" }] },
		{ id: "impl", next: [{ to: "ship" }] },
		{ id: "ship", next: [{ to: "done", require: ["verification_passed"] }] },
	],
};

/**
 * Well formed and a LOOP: every phase names a successor, nothing is terminal, no
 * dead end, the start is reachable-and-not-terminal. `validatePhaseMachine` passes
 * it (see the test below), which is exactly the hole G4 closes.
 */
const LOOP_MACHINE: PhaseMachine = {
	start: "a",
	phases: [
		{ id: "a", next: [{ to: "b" }] },
		{ id: "b", next: [{ to: "a" }] },
	],
};

function fixture(phase: string | null): { db: ReturnType<typeof openLegionDb>; cwd: string; cleanup: () => void } {
	const dir = mkdtempSync(path.join(tmpdir(), "legion-declared-phases-"));
	mkdirSync(path.join(dir, ".pi-legion"), { recursive: true });
	const db = openLegionDb(":memory:");
	insertNode(db, { parentId: null, name: "root", role: "root", status: "running" }, () => NOW - 10);
	insertNode(db, { parentId: "root", name: "team", role: "centurion", status: "running", phase, phaseSince: phase === null ? null : NOW - 5 }, () => NOW - 5);
	return { db, cwd: dir, cleanup: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

const TEAM_ID = "root.team";

function writeContract(cwd: string, commands: readonly string[]): void {
	writeFileSync(
		path.join(cwd, ".pi-legion", "contract.md"),
		["# Contract", "Goal: exercise the declared machine.", "```legion-verify", ...commands, "```", ""].join("\n"),
	);
}

// ---------------------------------------------------------------------------
// canReachTerminal — G4's missing half
// ---------------------------------------------------------------------------

test("#371 canReachTerminal: the built-in pipeline and a solo workflow both end somewhere", () => {
	assert.equal(canReachTerminal(DEFAULT_PHASE_MACHINE), true);
	assert.equal(canReachTerminal(SOLO_MACHINE), true);
	assert.equal(canReachTerminal(SHIP_MACHINE), true);
});

test("#371 canReachTerminal: a declared LOOP is refused, and it is a machine the validator accepts", () => {
	// The premise of the check: this graph passes every rule `validatePhaseMachine`
	// has, because "can this team ever finish" is not one of them.
	const errors = parsePhaseMachine(LOOP_MACHINE, "test-card.md");
	assert.ok(errors, "a looping machine must survive the card parser, or G4 would be redundant");
	assert.equal(canReachTerminal(LOOP_MACHINE), false);
	// …and the same parse, asked for the terminal guarantee, is refused with the
	// contract's wording.
	assert.throws(
		() => parsePhaseMachine(LOOP_MACHINE, "subagent.phases", { requireTerminal: true }),
		/phase machine cannot reach a terminal phase from 'a'/,
	);
});

test("#371 parsePhaseMachine: the reachability question is OPT-IN, so card loading is unchanged", () => {
	// A card has never been checked for it and its rules are frozen (§7 non-goals),
	// so the option defaults off: the same bytes parse fine without it.
	const machine = parsePhaseMachine(LOOP_MACHINE, "agents/some-card.md");
	assert.ok(machine, "a looping machine is still a parseable CARD (nothing about cards changed)");
	assert.deepEqual(machine.phases.map((phase) => phase.id), ["a", "b", "done", "failed", "aborted"]);
	assert.equal(phaseStart(machine), "a");
	// A structurally broken machine still reports its own validator lines, and the
	// reachability check does not pile a second, misleading error on top.
	assert.throws(
		() => parsePhaseMachine({ phases: [{ id: "a", next: [{ to: "a" }] }, { id: "a", next: [] }] }, "subagent.phases", { requireTerminal: true }),
		/phases\[1\]\.id: duplicate phase id 'a'/,
	);
});

// ---------------------------------------------------------------------------
// I2 + the upgrade path — the tool follows the MACHINE, not the role name
// ---------------------------------------------------------------------------

test("#371 I2: an centurion with neither a machine nor a phase gets no legion_phase; a legacy row keeps it", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "legion-declared-tools-"));
	const db = openLegionDb(":memory:");
	const toolNames = (nodeId: string, options: { machine?: PhaseMachine } = {}): string[] => {
		const names: string[] = [];
		const pi = { registerTool(tool: { name: string }) { names.push(tool.name); } };
		registerLegionTools(pi as never, {
			db,
			nodeId,
			role: "centurion",
			cwd: dir,
			runDir: dir,
			settings: { verifyCommandTimeoutMs: 1_000 },
			...(options.machine ? { machine: options.machine } : {}),
		});
		return names.sort();
	};
	try {
		insertNode(db, { parentId: null, name: "root", role: "root", status: "running" }, () => NOW - 10);
		// The #371 shape: declared nothing, born with no phase.
		insertNode(db, { parentId: "root", name: "fresh", role: "centurion", status: "running", phase: null }, () => NOW - 5);
		// The pre-#371 shape: born `planning`, and this process may not have its card
		// machine (a resumed team, a card the user has since edited). Dropping its tool
		// would strand a team that is mid-flight for an upgrade it had no part in.
		insertNode(db, { parentId: "root", name: "legacy", role: "centurion", status: "running", phase: "planning", phaseSince: NOW - 5 }, () => NOW - 5);

		assert.deepEqual(toolNames("root.fresh"), ["legion_mail", "legion_tree"], "no machine, no phase ⇒ no legion_phase");
		assert.deepEqual(toolNames("root.legacy"), ["legion_mail", "legion_phase", "legion_tree"], "a node that already lives in a phase keeps its tool");
		assert.deepEqual(toolNames("root.legacy", { machine: SOLO_MACHINE }), ["legion_mail", "legion_phase", "legion_tree"]);
	} finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// m7 — the contract is recorded on the machine's own intake boundary
// ---------------------------------------------------------------------------

test("#371 m7: contract_path follows the machine's ENTRY phase, not the literals planning/implementing", async () => {
	const { db, cwd, cleanup } = fixture("spec");
	try {
		// A declared machine whose intake phase is called `spec`. The old test was the
		// literal pair `self.phase === "planning" && to === "implementing"`, which never
		// matched a custom workflow — the contract the team froze was never recorded.
		const machine = productionShape({
			start: "spec",
			phases: [
				{ id: "spec", next: [{ to: "impl" }] },
				{ id: "impl", next: [{ to: "done" }] },
			],
		});
		const moved = await requestLegionPhase(db, TEAM_ID, "impl", { cwd, now: () => NOW, machine });
		assert.equal(moved.ok, true, moved.message);
		assert.equal(
			getNode(db, TEAM_ID)?.contractPath,
			path.resolve(cwd, ".pi-legion", "contract.md"),
			"leaving the machine's entry phase must record the contract",
		);
	} finally { cleanup(); }
});

test("#371 m7 CONTROL: the built-in pipeline is unchanged, and the write is tied to the entry phase rather than to any move", async () => {
	// (a) No machine: the pre-#371 shape. `phaseStart(DEFAULT_PHASE_MACHINE)` is
	// `planning`, so the generalization has to be byte-for-byte the old rule here.
	const first = fixture("planning");
	try {
		writeContract(first.cwd, ["npm test"]);
		const moved = await requestLegionPhase(first.db, TEAM_ID, "implementing", { cwd: first.cwd, now: () => NOW });
		assert.equal(moved.ok, true, moved.message);
		assert.equal(getNode(first.db, TEAM_ID)?.contractPath, path.resolve(first.cwd, ".pi-legion", "contract.md"));
	} finally { first.cleanup(); }

	// (b) The same declared machine, but the team is already PAST its entry phase
	// (`spec`): a later move must not claim a contract it never froze. Without this
	// half, "write on every successful transition" would pass just as well.
	const second = fixture("impl");
	try {
		const machine = productionShape(SHIP_MACHINE);
		const moved = await requestLegionPhase(second.db, TEAM_ID, "ship", { cwd: second.cwd, now: () => NOW, machine });
		assert.equal(moved.ok, true, moved.message);
		assert.equal(getNode(second.db, TEAM_ID)?.phase, "done");
		assert.equal(getNode(second.db, TEAM_ID)?.contractPath, null, "only the entry phase records the contract");
	} finally { second.cleanup(); }
});

// ---------------------------------------------------------------------------
// G5 — `done` follows the declaration
// ---------------------------------------------------------------------------

test("#371 G5: a declared exit to done lets the team complete itself", async () => {
	const { db, cwd, cleanup } = fixture("implementing");
	try {
		// PRODUCTION shape (#371 C1): the raw fixture would be a fake guarantee —
		// `maySelfComplete` must find the AUTHOR's edge among the injected ones.
		const result = await requestLegionPhase(db, TEAM_ID, "done", { cwd, now: () => NOW, machine: productionShape(SOLO_MACHINE) });
		assert.equal(result.ok, true, `implementing → done must be allowed: ${result.message}`);
		assert.equal(result.phase, "done");
		assert.equal(getNode(db, TEAM_ID)?.phase, "done");
	} finally { cleanup(); }
});

test("#371 G5: an undeclared machine keeps the pre-#371 refusal, verbatim (I6)", async () => {
	const { db, cwd, cleanup } = fixture("implementing");
	try {
		// No `machine` at all: this is the legacy shape, built-in four-phase pipeline.
		const done = await requestLegionPhase(db, TEAM_ID, "done", { cwd, now: () => NOW });
		assert.equal(done.ok, false);
		assert.equal(done.code, "INVALID_PARAMS");
		assert.equal(done.message, "done is controlled by the parent or supervisor");
		assert.equal(getNode(db, TEAM_ID)?.phase, "implementing");
	} finally { cleanup(); }
});

test("#371 G5: `aborted` is never the team's own call, machine or not", async () => {
	const { db, cwd, cleanup } = fixture("implementing");
	try {
		const aborted = await requestLegionPhase(db, TEAM_ID, "aborted", { cwd, now: () => NOW, machine: SOLO_MACHINE });
		assert.equal(aborted.ok, false);
		assert.equal(aborted.message, "aborted is controlled by the parent or supervisor");
		assert.equal(getNode(db, TEAM_ID)?.phase, "implementing");
	} finally { cleanup(); }
});

test("#371 G5/C1: a declared machine with no exit to done from THIS phase still refuses", async () => {
	const { db, cwd, cleanup } = fixture("impl");
	try {
		// `impl` declares exactly one exit (`ship`). The blanket refusal is replaced by
		// the DECLARATION, not by a blanket permission — and the machine handed over is
		// the PRODUCTION shape, i.e. `impl` also carries the injected unconditional
		// `→ done` that normalization adds. Counting that edge as a declared exit made
		// this refusal unreachable for every machine (#371 C1: the exploit probe).
		const refused = await requestLegionPhase(db, TEAM_ID, "done", { cwd, now: () => NOW, machine: productionShape(SHIP_MACHINE) });
		assert.equal(refused.ok, false);
		assert.equal(refused.message, "done is controlled by the parent or supervisor");
		assert.equal(getNode(db, TEAM_ID)?.phase, "impl", "the refused request must not move the team");
		// The declared edge is still usable when asked for by its own name — and it
		// runs verification, so a failing command leaves the team parked in `ship`
		// rather than silently completing it (G6).
		writeContract(cwd, ["npm test"]);
		const ship = await requestLegionPhase(db, TEAM_ID, "ship", {
			cwd,
			now: () => NOW,
			machine: SHIP_MACHINE,
			runCommand: async () => ({ code: 1, stdout: "", stderr: "boom" }),
			settings: { verifyCommandTimeoutMs: 1_000 },
		});
		assert.equal(ship.ok, true, ship.message);
		assert.match(ship.message, /Verification failed/);
		assert.equal(getNode(db, TEAM_ID)?.phase, "ship");
	} finally { cleanup(); }
});

// ---------------------------------------------------------------------------
// C1 — an INJECTED `→ done` belongs to the supervisor, never to the team
// ---------------------------------------------------------------------------

test("#371 C1: the injected → done is refused for a team and allowed for the supervisor (raw AND production shape)", () => {
	// The exploit, exactly as reported: `ship → done require:["verification_passed"]`
	// is the author's gate, but `evalutePhaseTransition` takes the FIRST edge whose
	// `to` matches, and `normalizePhaseMachine` appends an unconditional `→ done` to
	// `impl`. A team asking for `done` from `impl` therefore completed WITHOUT ever
	// entering `ship` or running `legion-verify`.
	//
	// Both shapes are asserted on purpose: production hands over a normalized machine
	// (injected edges present and marked), while a raw caller — a test, a fixture, the
	// panel — hands over the author's literal. The state machine normalizes internally,
	// so both must answer the same thing.
	for (const [label, machine] of [
		["raw", SHIP_MACHINE],
		["production", productionShape(SHIP_MACHINE)],
	] as const) {
		const team = evaluatePhaseTransition({ from: "impl", to: "done", actorRole: "centurion", machine }, () => NOW);
		assert.equal(team.allowed, false, `[${label}] impl → done must be refused for the team`);
		assert.equal(team.allowed ? "<allowed>" : team.reason, "injected_done_is_supervisor_only", `[${label}] reason`);
		assert.match(
			team.allowed ? "" : team.message,
			/the declared machine has no transition to done from 'impl'/,
			`[${label}] the message must name the missing declaration, not an unmet condition`,
		);

		// …and the SUPERVISOR still takes it: that edge is how a machine which never
		// declares `done` gets closed out (`finalizeVerifiedTeamIfReady`).
		const supervisor = evaluatePhaseTransition({ from: "impl", to: "done", actorRole: "supervisor", machine }, () => NOW);
		assert.equal(supervisor.allowed, true, `[${label}] the supervisor must still complete through the injected edge: ${supervisor.allowed ? "" : supervisor.message}`);
	}
});

test("#371 C1: the author's own → done edge is untouched — the filter is about injection, not about `done`", () => {
	const declared = productionShape(SOLO_MACHINE);
	const fromAuthor = declared.phases.find((phase) => phase.id === "implementing")?.next.find((rule) => rule.to === "done");
	assert.ok(fromAuthor, "the solo machine's implementing phase must still reach done");
	assert.equal(fromAuthor.injected, undefined, "an authored edge must never be marked injected");
	// The injected siblings are marked, which is what makes them skippable. `done`
	// is NOT among them here: the solo machine declares the phase, so nothing was
	// injected for it (`planning → done` is simply not a transition this machine
	// has, which is the point of declaring `done` at all).
	const injected = declared.phases.find((phase) => phase.id === "planning")?.next.filter((rule) => rule.injected === true) ?? [];
	assert.deepEqual(injected.map((rule) => rule.to).sort(), ["aborted", "failed"]);
});

test("#371 C1: a machine that declares no → done still completes through the injected edge when the SUPERVISOR runs verification", async () => {
	const { db, cwd, cleanup } = fixture("spec");
	const messages: string[] = [];
	try {
		// `NO_DONE_MACHINE` declares `spec → impl` and never mentions `done`. Entering
		// `impl` is entering its success phase, so the tool runs `legion-verify` and
		// then takes the injected `impl → done` edge AS THE SUPERVISOR. If the filter
		// above were applied to that path too, such a machine could never finish.
		const machine = productionShape(NO_DONE_MACHINE);
		assert.equal(successPhaseOf(machine), "impl", "the injected exit is what makes `impl` the success phase");
		const result = await requestLegionPhase(db, TEAM_ID, "impl", {
			cwd,
			now: () => NOW,
			machine,
			sendSelfMessage: (text) => messages.push(text),
			settings: { verifyCommandTimeoutMs: 1_000 },
		});
		assert.equal(result.ok, true, result.message);
		assert.equal(result.phase, "done", `the supervisor path must still close the team; receipt: ${result.message}`);
		assert.equal(getNode(db, TEAM_ID)?.phase, "done");
		assert.ok(messages.some((message) => /squash/.test(message)), "the collection prompt still fires");
	} finally { cleanup(); }
});

// ---------------------------------------------------------------------------
// G6 — verification runs in the machine's own success phase
// ---------------------------------------------------------------------------

test("#371 G6: a machine that calls its verify phase `ship` still reaches done", async () => {
	const { db, cwd, cleanup } = fixture("impl");
	const commands: string[] = [];
	const runCommand: LegionCommandRunner = async (command) => {
		commands.push(command);
		return { code: 0, stdout: "green", stderr: "" };
	};
	const messages: string[] = [];
	try {
		writeContract(cwd, ["npm test"]);
		const result = await requestLegionPhase(db, TEAM_ID, "ship", {
			cwd,
			now: () => NOW,
			machine: SHIP_MACHINE,
			runCommand,
			sendSelfMessage: (text) => messages.push(text),
			settings: { verifyCommandTimeoutMs: 1_000 },
		});
		assert.deepEqual(commands, ["npm test"], "entering `ship` must run the contract's legion-verify block");
		assert.equal(result.ok, true, result.message);
		assert.equal(result.phase, "done", `ship → done must be reachable; receipt: ${result.message}`);
		assert.match(result.message, /automatically advanced to done/);
		assert.equal(getNode(db, TEAM_ID)?.phase, "done");
		assert.ok(messages.some((message) => /squash/.test(message)), "the collection prompt must still fire");
	} finally { cleanup(); }
});

test("#371 G6: successPhaseOf names the declared phase and stays undefined when a machine never completes", () => {
	assert.equal(successPhaseOf(DEFAULT_PHASE_MACHINE), "verifying", "the built-in answer is unchanged");
	assert.equal(successPhaseOf(SHIP_MACHINE), "ship");
	assert.equal(successPhaseOf(SOLO_MACHINE), "implementing", "the deepest phase that can complete a team wins");
	assert.equal(
		successPhaseOf({ phases: [{ id: "a", next: [{ to: "failed" }] }, { id: "failed", terminal: true, next: [] }] }),
		undefined,
		"a machine with no exit to done must say so, not invent a phase name",
	);
});
