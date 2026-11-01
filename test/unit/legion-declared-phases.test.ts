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

import { requestLegionPhase, type LegionCommandRunner } from "../../src/extension/legion-tools.ts";
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
// G5 — `done` follows the declaration
// ---------------------------------------------------------------------------

test("#371 G5: a declared exit to done lets the team complete itself", async () => {
	const { db, cwd, cleanup } = fixture("implementing");
	try {
		const result = await requestLegionPhase(db, TEAM_ID, "done", { cwd, now: () => NOW, machine: SOLO_MACHINE });
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

test("#371 G5: a declared machine with no exit to done from THIS phase still refuses", async () => {
	const { db, cwd, cleanup } = fixture("impl");
	try {
		// `impl` declares exactly one exit (`ship`). The blanket refusal is replaced by
		// the DECLARATION, not by a blanket permission.
		const refused = await requestLegionPhase(db, TEAM_ID, "done", { cwd, now: () => NOW, machine: SHIP_MACHINE });
		assert.equal(refused.ok, false);
		assert.equal(refused.message, "done is controlled by the parent or supervisor");
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
