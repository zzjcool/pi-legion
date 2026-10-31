/**
 * #350 — the phase a team is BORN in.
 *
 * `Orchestrator.reserveNode` used to write a hard-coded `phase: "planning"` into
 * every team row, whatever machine the card declared. A card whose machine starts
 * elsewhere (`recon -> build`) therefore produced a team born in a phase its own
 * machine never heard of, and `evaluatePhaseTransition` refuses every transition
 * out of an unknown `from` as `invalid_phase` — before the target, the outgoing
 * edge or the `failed` escape hatch (#309) is consulted. Advancing, declaring
 * failure and aborting were all closed.
 *
 * Two layers, each stated for what it proves:
 *
 *   1. PURE — `phaseStart` is the single derivation of "where a new team starts",
 *      shared by the state machine and the birth site. The cases pin the order
 *      (`start` wins over `phases[0]`) and the empty-machine fallback.
 *   2. SPAWN — the real `Orchestrator.launch` writes the row, and the assertions
 *      are made on THAT row and on the registered `legion_phase` tool acting on
 *      it: the birth phase is the card's own start, the machine's declared edge
 *      moves it, and a declared failure still gets out.
 *
 * The control runs the same fixture with a card that declares NO machine: the
 * built-in four-phase pipeline must be bit-for-bit unchanged (`planning`).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { FakeSupervisor } from "../helpers/fake-supervisor.ts";
import { registerLegionTools } from "../../src/extension/legion-tools.ts";
import { createLegionEventBus } from "../../src/extension/event-bus.ts";
import { openLegionDb } from "../../src/legion/db.ts";
import { getNode, insertNode } from "../../src/legion/nodes.ts";
import {
	DEFAULT_PHASE_MACHINE,
	normalizePhaseMachine,
	phaseStart,
	type PhaseMachine,
} from "../../src/legion/phase-machine.ts";
import { evaluatePhaseTransition } from "../../src/legion/state-machine.ts";
import { Orchestrator } from "../../src/runs/orchestrator.ts";
import { RunStore } from "../../src/runs/store.ts";
import type { AgentConfig } from "../../src/shared/types.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** The role the birth site special-cases (`Orchestrator.reserveNode`). */
const TEAM_ROLE = "centurion";

const NOW = 5_000;

/**
 * A two-phase machine that does NOT start in the built-in `planning`. `start` and
 * the first declared phase are the same id on purpose: "start from the machine"
 * and "start from its first phase" are then the same repair, so this file cannot
 * prefer one by accident.
 */
const RECON_MACHINE: PhaseMachine = {
	start: "recon",
	phases: [
		{ id: "recon", next: [{ to: "build" }] },
		{ id: "build", next: [{ to: "failed" }] },
	],
};

/** What the loader (`parseAgentDocument`) hands the orchestrator: normalized. */
const EFFECTIVE_MACHINE = normalizePhaseMachine(RECON_MACHINE);

// ---------------------------------------------------------------------------
// Layer 1 — the pure derivation
// ---------------------------------------------------------------------------

test("phaseStart: an explicit `start` wins over the first declared phase", () => {
	// Declaration validity is `validatePhaseMachine`'s job, not this function's: a
	// machine that declares its entry point makes `start` authoritative even when it
	// is not the first element of `phases`.
	const machine: PhaseMachine = {
		start: "build",
		phases: [
			{ id: "recon", next: [{ to: "build" }] },
			{ id: "build", next: [] },
		],
	};
	assert.equal(phaseStart(machine), "build");
});

test("phaseStart: with no declared `start`, the first phase is the entry point", () => {
	const machine: PhaseMachine = {
		phases: [
			{ id: "recon", next: [{ to: "build" }] },
			{ id: "build", next: [] },
		],
	};
	assert.equal(phaseStart(machine), "recon");
});

test("phaseStart: an empty machine falls back to the built-in start", () => {
	// An empty machine cannot be declared (`validatePhaseMachine` rejects it, and the
	// loader rejects the card), so this leg only keeps the function total. The
	// contract's fallback is the built-in pipeline: the phase an UNDECLARED team is
	// born in.
	assert.equal(phaseStart({ phases: [] }), DEFAULT_PHASE_MACHINE.start);
	assert.equal(phaseStart({ phases: [] }), "planning");
});

test("phaseStart agrees with the state machine's own entry rule", () => {
	// The point of sharing one function: whatever the birth site writes must be a
	// legal FIRST phase for `evaluatePhaseTransition`, or the team is stranded.
	for (const machine of [RECON_MACHINE, DEFAULT_PHASE_MACHINE, EFFECTIVE_MACHINE]) {
		const start = phaseStart(machine);
		const decision = evaluatePhaseTransition({ from: null, to: start, machine }, () => NOW);
		assert.equal(
			decision.allowed,
			true,
			`a new team must be able to enter phaseStart(machine)='${start}': ${decision.allowed ? "allowed" : decision.message}`,
		);
	}
});

// ---------------------------------------------------------------------------
// Layer 2 — the real spawn
// ---------------------------------------------------------------------------

type Db = ReturnType<typeof openLegionDb>;

/** Scratch git repo (a team role forces worktree resolution), run store, ledger. */
function spawnFixture() {
	const rootDir = mkdtempSync(path.join(tmpdir(), "legion-phase-start-"));
	const git = (args: string[]) => execFileSync("git", ["-C", rootDir, ...args], { stdio: "ignore" });
	git(["init", "-q"]);
	git(["config", "user.email", "legion-test@example.invalid"]);
	git(["config", "user.name", "Legion phase-start fixture"]);
	writeFileSync(path.join(rootDir, "README.md"), "fixture\n");
	git(["add", "README.md"]);
	git(["commit", "-m", "test fixture", "-q"]);
	const runStore = new RunStore({ rootDir: path.join(rootDir, ".pi-subagents") });
	const rootRun = runStore.createRun({
		task: "root task",
		cwd: rootDir,
		nodeId: "root",
		maxDepth: 4,
		herdr: { supervisor: "rpc" },
	});
	const db = openLegionDb(":memory:");
	insertNode(db, { id: "root", parentId: null, name: "root", role: "root", runId: rootRun.runId, status: "running" }, () => NOW - 500);
	const context = {
		db,
		dbPath: path.join(runStore.runDir(rootRun.runId), "legion.db"),
		nodeId: "root",
		parentNodeId: null,
		parentRunId: null,
		runId: rootRun.runId,
		runStore,
		settings: { maxDepth: 4, maxChildrenPerNode: 8, maxActiveNodes: 30 },
		eventBus: createLegionEventBus(),
	};
	return {
		rootDir,
		runDir: runStore.runDir(rootRun.runId),
		db,
		context,
		cleanup() {
			db.close();
			rmSync(rootDir, { recursive: true, force: true });
		},
	};
}

function teamCard(machine?: PhaseMachine): AgentConfig {
	return {
		name: TEAM_ROLE,
		description: "team root under test",
		systemPromptMode: "append",
		inheritProjectContext: true,
		inheritSkills: false,
		kind: "pi",
		systemPrompt: "You are the root of a team.",
		source: "user",
		filePath: `/fake/${TEAM_ROLE}.md`,
		...(machine ? { phases: machine } : {}),
	};
}

interface RegisteredTool {
	name: string;
	execute: (id: string, params: Record<string, unknown>) => Promise<{ content?: Array<{ text?: string }> }>;
}

function toolText(result: { content?: Array<{ text?: string }> }): string {
	return (result.content ?? []).map((item) => item.text ?? "").join("\n");
}

/** The same registration path a live team gets, minus the host. */
function toolsFor(db: Db, nodeId: string, machine?: PhaseMachine): Map<string, RegisteredTool> {
	const tools = new Map<string, RegisteredTool>();
	const pi = {
		registerTool(tool: unknown) {
			const typed = tool as RegisteredTool;
			tools.set(typed.name, typed);
		},
	};
	registerLegionTools(pi as unknown as ExtensionAPI, {
		db,
		nodeId,
		role: TEAM_ROLE,
		cwd: "/tmp",
		now: () => NOW,
		...(machine ? { machine } : {}),
	});
	return tools;
}

/** Launch the team through the real orchestrator; return the ledger row it wrote. */
async function launchTeam(fx: ReturnType<typeof spawnFixture>, machine?: PhaseMachine) {
	const supervisor = new FakeSupervisor({ immediateTimeout: false });
	const orchestrator = new Orchestrator({
		supervisor,
		runDir: fx.runDir,
		cwd: fx.rootDir,
		maxDepth: 4,
		legion: fx.context,
	});
	const handle = await orchestrator.launch({
		agent: teamCard(machine),
		task: "own a team",
		worktree: false,
	});
	const nodeId = handle.child.nodeId;
	assert.ok(nodeId, `the launch reserved no ledger node (handle: ${handle.name})`);
	const node = getNode(fx.db, nodeId);
	assert.ok(node, `no ledger row for ${nodeId}; the spawn never reached reserveNode`);
	return { name: handle.name, nodeId, node, supervisor };
}

test("spawn: a team declaring its own machine is born in THAT machine's start phase, advances, and can still fail", async () => {
	const fx = spawnFixture();
	let launched: Awaited<ReturnType<typeof launchTeam>> | undefined;
	try {
		launched = await launchTeam(fx, EFFECTIVE_MACHINE);

		// THE claim: the row `reserveNode` wrote carries the phase this team's machine
		// starts in — not a phase the machine never heard of.
		assert.equal(
			launched.node.phase,
			"recon",
			`a card declaring start='recon' produced a team born in '${String(launched.node.phase)}'`,
		);

		const tool = toolsFor(fx.db, launched.nodeId, RECON_MACHINE).get("legion_phase");
		assert.ok(tool, "legion_phase must be registered for a team node");

		// Forward: the machine's declared edge must be usable from the birth phase.
		const advanced = await tool.execute("call-1", { to: "build" });
		assert.equal(
			getNode(fx.db, launched.nodeId)?.phase,
			"build",
			`recon → build must advance a newly born team; receipt: ${toolText(advanced)}`,
		);

		// Escape hatch (#309): a declared failure still gets out — this was just as
		// dead as advancing while the birth phase was outside the machine.
		const failed = await tool.execute("call-2", { to: "failed", reason: "nothing left to try" });
		assert.equal(
			getNode(fx.db, launched.nodeId)?.phase,
			"failed",
			`build → failed with a reason must be accepted; receipt: ${toolText(failed)}`,
		);
	} finally {
		if (launched) await launched.supervisor.retire(launched.name).catch(() => {});
		fx.cleanup();
	}
});

test("spawn control: a card with no `phases` is still born in `planning` (built-in pipeline unchanged)", async () => {
	const fx = spawnFixture();
	let launched: Awaited<ReturnType<typeof launchTeam>> | undefined;
	try {
		launched = await launchTeam(fx);
		assert.equal(
			launched.node.phase,
			"planning",
			"an undeclared team must keep the literal birth phase, verbatim",
		);
		// …and `planning` really is a phase of the machine that team uses, so the
		// control is not passing on a name that happens to be spelled the same.
		const out = evaluatePhaseTransition({ from: "planning", to: "implementing" }, () => NOW);
		assert.equal(out.allowed, false);
		assert.equal(
			out.allowed ? "<allowed>" : out.reason,
			"contract_path_required",
			"the default machine must recognise 'planning' and refuse the move on the CONTRACT condition, not invalid_phase",
		);
	} finally {
		if (launched) await launched.supervisor.retire(launched.name).catch(() => {});
		fx.cleanup();
	}
});
