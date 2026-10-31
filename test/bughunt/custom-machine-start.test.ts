/**
 * One contract, one bug.
 *
 * CONTRACT (docs/contracts/declarative-phase-machine-v5.md:107 — "Status: draft"
 * on line 3, so this is a declared intent, not a shipped promise):
 *   "A new team starts in the machine's **first** phase."
 *
 * BUG: a team does not start in its machine's first phase. The orchestrator
 * writes a hard-coded `phase: "planning"` into every team node at spawn
 * (`src/runs/orchestrator.ts:632`), ignoring the machine the team's card already
 * carries in `input.agent.phases` (`src/shared/types.ts:174`; the loader at
 * `src/agents/agents.ts:570-573` returns that machine normalized). So a card
 * declaring `start: "recon"` produces a team born in a phase its own machine has
 * never heard of. `evaluatePhaseTransition` refuses ANY transition whose `from`
 * is not a phase of that machine (`src/legion/state-machine.ts:142-144`) BEFORE
 * it inspects `to`, the outgoing edge, or the terminal-reason escape hatch:
 *
 *   from=planning to=recon:  allowed=false reason=invalid_phase
 *   from=planning to=build:  allowed=false reason=invalid_phase
 *   from=planning to=failed: allowed=false reason=invalid_phase
 *
 * Even `to: "failed"` + a reason is closed, because `mayDeclareFailure`
 * (`src/extension/legion-tools.ts:886`) looks the CURRENT phase up in the
 * machine as well, so `terminalReason: "parent_decision"` is never handed to the
 * state machine. The team is stranded: no self-service exit at all.
 *
 * WHAT THIS FILE DRIVES (three layers, each stated for what it actually proves):
 *
 *   1. CHARACTERIZATION — the pure decision function. Given a team whose stored
 *      phase is the built-in `planning` and a machine that starts at `recon`,
 *      every transition is refused with reason `invalid_phase`. This is the
 *      MECHANISM. It says nothing about what the orchestrator writes; it stays
 *      true no matter how the birth cell is filled.
 *   2. CHARACTERIZATION — the same mechanism through the registered
 *      `legion_phase` path and `requestLegionPhase`. The stranded row here is
 *      built BY HAND (`insertNode`), so these tests never depend on the value
 *      the orchestrator writes and cannot become "unfixable survivors" of a
 *      repair.
 *   3. RED — the real spawn. `Orchestrator.launch()` is driven far enough that
 *      `reserveNode` writes the team row into the ledger, and the assertion is
 *      made on THAT row: the birth phase must be the phase the card's machine
 *      starts in. Today it is `"planning"` (not in the machine), so this fails.
 *      It goes green when — and only when — the birth phase comes from the
 *      machine. That is the whole defect, measured where it happens.
 *
 * plus one CONTROL on the spawn fixture: the very node the orchestrator created
 * CAN advance (`recon → build`) once its stored phase is inside its machine.
 * The control proves the fixture path is wired — the orchestrator, the ledger,
 * the request path and the machine all agree when the phase is legal. It does
 * NOT claim the birth phase is the only possible defect; it just removes "the
 * plumbing never worked" as an explanation for the layer-3 failure.
 *
 * Deliberately NOT asserted anywhere: the text of refusal messages. A fix that
 * only rewords an error would then be indistinguishable from a fix that moves
 * the birth phase, and this file would have to be rewritten to stay honest.
 * Refusals are identified by their structured `reason` (`invalid_phase`) and by
 * ledger state, and their message is only ever printed inside an assertion
 * label for debugging.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { FakeSupervisor } from "../helpers/fake-supervisor.ts";
import {
	registerLegionTools,
	requestLegionPhase,
	type PhaseRequestOptions,
	type PhaseRequestResult,
} from "../../src/extension/legion-tools.ts";
import { createLegionEventBus } from "../../src/extension/event-bus.ts";
import { openLegionDb } from "../../src/legion/db.ts";
import { getNode, insertNode, updateNode } from "../../src/legion/nodes.ts";
import {
	findPhase,
	normalizePhaseMachine,
	type PhaseMachine,
} from "../../src/legion/phase-machine.ts";
import {
	evaluatePhaseTransition,
	type PhaseTransitionDecision,
} from "../../src/legion/state-machine.ts";
import { Orchestrator } from "../../src/runs/orchestrator.ts";
import { RunStore } from "../../src/runs/store.ts";
import type { AgentConfig } from "../../src/shared/types.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** The role `src/runs/orchestrator.ts:632` special-cases. */
const TEAM_ROLE = "centurion";

/**
 * The value that line writes for EVERY team, whatever the card declares. It is
 * the built-in pipeline's first phase and no custom machine has to know it.
 */
const BUILTIN_BIRTH_PHASE = "planning";

const NOW = 5_000;

/**
 * A two-phase custom machine whose start is NOT the built-in `planning`.
 *
 * `start` and the first declared phase are the SAME id on purpose: "start from
 * the machine" and "start from its first phase" are then the same repair, so
 * this file cannot tell a correct fix from a correct fix.
 */
const RECON_MACHINE: PhaseMachine = {
	start: "recon",
	phases: [
		{ id: "recon", next: [{ to: "build" }] },
		{ id: "build", next: [{ to: "failed" }] },
	],
};

const DECLARED_START = "recon";

/** What `src/agents/agents.ts:570-573` hands the orchestrator: the normalized machine. */
const EFFECTIVE_MACHINE = normalizePhaseMachine(RECON_MACHINE);
const MACHINE_PHASES = EFFECTIVE_MACHINE.phases.map((phase) => phase.id);

type Db = ReturnType<typeof openLegionDb>;

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/**
 * Await with a deadline. Every await in this file goes through it so a wedged
 * child or a supervisor that never settles surfaces as a failed assertion
 * instead of a hung test run.
 */
async function bounded<T>(label: string, work: Promise<T>, ms = 30_000): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			work,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error(`${label}: still pending after ${ms}ms`)), ms);
				timer.unref?.();
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

/** A decision rendered for an assertion label (the text is never asserted on). */
function decisionLabel(decision: PhaseTransitionDecision): string {
	const move = `${decision.from ?? "<new>"} → ${decision.to}`;
	return decision.allowed
		? `allowed ${move}`
		: `refused ${move} reason=${decision.reason} message=${decision.message}`;
}

// ---------------------------------------------------------------------------
// Layer 1 — the pure decision function
// ---------------------------------------------------------------------------

test("CHARACTERIZATION: the fixture machine starts outside the built-in birth phase", () => {
	// Fixture integrity only: if this ever stopped holding, the tests below would
	// quietly stop testing anything.
	assert.equal(RECON_MACHINE.start, DECLARED_START, "the fixture machine must declare its own start");
	assert.ok(MACHINE_PHASES.includes(DECLARED_START), `[${MACHINE_PHASES.join(", ")}] must contain the start`);
	assert.ok(MACHINE_PHASES.includes("build"), `[${MACHINE_PHASES.join(", ")}] must contain the second phase`);
	assert.ok(
		!MACHINE_PHASES.includes(BUILTIN_BIRTH_PHASE),
		`the declared machine must not contain the built-in birth phase, got [${MACHINE_PHASES.join(", ")}]`,
	);
});

test("CHARACTERIZATION: from a phase outside the machine every direction is refused as invalid_phase", () => {
	const attempts: Array<{ to: string; extra: Partial<Parameters<typeof evaluatePhaseTransition>[0]> }> = [
		{ to: "recon", extra: {} },
		{ to: "build", extra: {} },
		// The #309 release valve in its strongest form: a declared failure with a
		// parent decision. It still never reaches the edge lookup.
		{ to: "failed", extra: { terminalReason: "parent_decision" } },
		{ to: "aborted", extra: { terminalReason: "parent_retire" } },
	];
	for (const { to, extra } of attempts) {
		const decision = evaluatePhaseTransition(
			{ from: BUILTIN_BIRTH_PHASE, to, machine: RECON_MACHINE, ...extra },
			() => NOW,
		);
		assert.equal(
			decision.allowed,
			false,
			`${BUILTIN_BIRTH_PHASE} → ${to} must be refused while the current phase is outside the machine; got ${decisionLabel(decision)}`,
		);
		// The structured reason, not the wording: `invalid_phase` is the code the
		// caller branches on, and it is produced before `to`/edges are consulted.
		assert.equal(
			decision.allowed ? "<allowed>" : decision.reason,
			"invalid_phase",
			`${BUILTIN_BIRTH_PHASE} → ${to} refusal reason (${decisionLabel(decision)})`,
		);
	}
});

test("CONTROL (pure): the machine accepts a birth at its own start, and recon → build is declared", () => {
	const birth = evaluatePhaseTransition({ from: null, to: DECLARED_START, machine: RECON_MACHINE }, () => NOW);
	assert.equal(birth.allowed, true, `a new team must be able to enter the machine's start phase: ${decisionLabel(birth)}`);

	const step = evaluatePhaseTransition({ from: DECLARED_START, to: "build", machine: RECON_MACHINE }, () => NOW);
	assert.equal(step.allowed, true, `recon → build is declared by the machine: ${decisionLabel(step)}`);
});

// ---------------------------------------------------------------------------
// Layer 2 — the real request path, on a hand-built ledger row
// ---------------------------------------------------------------------------

const TEAM_ID = "root.team-a";

function makeTeamFixture(bornPhase: string): Db {
	const db = openLegionDb(":memory:");
	insertNode(db, { parentId: null, name: "root", role: "root", status: "running" }, () => NOW - 500);
	insertNode(
		db,
		{
			parentId: "root",
			name: "team-a",
			role: TEAM_ROLE,
			status: "running",
			phase: bornPhase,
			phaseSince: NOW,
			reworkCount: 0,
		},
		() => NOW,
	);
	return db;
}

async function withTeam(bornPhase: string, run: (db: Db, cwd: string) => Promise<void>): Promise<void> {
	const cwd = mkdtempSync(path.join(tmpdir(), "legion-bughunt-machine-start-"));
	const db = makeTeamFixture(bornPhase);
	try {
		// Fixture sanity: a wrong role would make every request fail for the wrong
		// reason ("legion_phase is team-only"), so pin it before asserting anything.
		assert.equal(getNode(db, TEAM_ID)?.role, TEAM_ROLE, "fixture team node must carry the team role");
		await bounded("test body", run(db, cwd));
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
	return bounded(
		`requestLegionPhase(${to})`,
		requestLegionPhase(db, TEAM_ID, to, {
			cwd,
			now: () => NOW,
			sendSelfMessage() {
				/* no mailbox needed: every request here is decided by the machine */
			},
			...extra,
		}),
	);
}

interface RegisteredTool {
	name: string;
	description?: string;
	execute: (
		id: string,
		params: Record<string, unknown>,
	) => Promise<{ content?: Array<{ text?: string }> }>;
}

/** The same registration path a live team gets, minus the host. */
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
		role: TEAM_ROLE,
		cwd,
		now: () => NOW,
		machine: RECON_MACHINE,
	});
	return tools;
}

function toolText(result: { content?: Array<{ text?: string }> }): string {
	return (result.content ?? []).map((item) => item.text ?? "").join("\n");
}

/** The failure reason every `to:"failed"` attempt below reuses. */
const FAILURE_REASON = "the team cannot proceed: nothing in its machine is reachable";

/**
 * Every exit a stranded team could plausibly try, through the real request path.
 * `done`/`aborted` are refused unconditionally before the machine is consulted
 * (`legion-tools.ts:794`), so they are listed for completeness, not as evidence.
 */
async function collectExits(db: Db, cwd: string): Promise<Array<{ to: string; result: PhaseRequestResult }>> {
	const attempts: Array<{ to: string; extra: Partial<PhaseRequestOptions> }> = [
		{ to: "recon", extra: {} },
		{ to: "build", extra: {} },
		{ to: "failed", extra: { reason: FAILURE_REASON } },
		{ to: "done", extra: {} },
		{ to: "aborted", extra: {} },
	];
	const results: Array<{ to: string; result: PhaseRequestResult }> = [];
	for (const attempt of attempts) {
		results.push({ to: attempt.to, result: await request(db, cwd, attempt.to, { machine: RECON_MACHINE, ...attempt.extra }) });
	}
	return results;
}

test("CHARACTERIZATION: a team whose stored phase is outside its machine has no accepted exit", async () => {
	await withTeam(BUILTIN_BIRTH_PHASE, async (db, cwd) => {
		const exits = await collectExits(db, cwd);
		const accepted = exits.filter(({ result }) => result.ok).map(({ to }) => to);
		assert.deepEqual(
			accepted,
			[],
			`expected zero accepted transitions, got ${accepted.join(", ")}: ` +
				exits.map(({ to, result }) => `${to}: ${result.ok ? "ok" : result.message}`).join(" | "),
		);
		// Refusals left no trace: the node still sits in the phase it was born in.
		assert.equal(getNode(db, TEAM_ID)?.phase, BUILTIN_BIRTH_PHASE);
	});
});

test("CHARACTERIZATION: the registered legion_phase tool reports the same refusal", async () => {
	await withTeam(BUILTIN_BIRTH_PHASE, async (db, cwd) => {
		const tool = makeTools(db, cwd).get("legion_phase");
		assert.ok(tool, "legion_phase must be registered");

		const result = await bounded(
			"legion_phase execute",
			tool.execute("call-1", { to: "build", reason: FAILURE_REASON }),
		);
		// The receipt text is only evidence in the label; the ledger is the claim.
		assert.equal(
			getNode(db, TEAM_ID)?.phase,
			BUILTIN_BIRTH_PHASE,
			`the tool must not move a team whose stored phase is outside its machine; receipt: ${toolText(result)}`,
		);
	});
});

test("CONTROL (request path): with the SAME reason, the same request IS accepted when the phase is in the machine", async () => {
	await withTeam(DECLARED_START, async (db, cwd) => {
		// This is what makes the stranded team's `to:"failed"` refusal attributable
		// to its phase and not to the reason string: an identical request, identical
		// reason, is accepted as soon as the stored phase is a phase of the machine.
		const failed = await request(db, cwd, "failed", { machine: RECON_MACHINE, reason: FAILURE_REASON });
		assert.equal(failed.ok, true, `recon → failed with a reason must be accepted: ${failed.ok ? "ok" : failed.message}`);
		assert.equal(getNode(db, TEAM_ID)?.phase, "failed");
	});
});

test("CONTROL (tool path): recon → build actually moves the team", async () => {
	await withTeam(DECLARED_START, async (db, cwd) => {
		const tool = makeTools(db, cwd).get("legion_phase");
		assert.ok(tool, "legion_phase must be registered");

		const result = await bounded("legion_phase execute", tool.execute("call-1", { to: "build" }));
		assert.equal(
			getNode(db, TEAM_ID)?.phase,
			"build",
			`recon → build must move the team; receipt: ${toolText(result)}`,
		);
	});
});

// ---------------------------------------------------------------------------
// Layer 3 — the real spawn: what the orchestrator writes at birth
// ---------------------------------------------------------------------------

/**
 * Mirrors `test/unit/legion-integration.test.ts`'s `fixture()`: a scratch git
 * repo (a centurion forces `worktree: true`, which needs a real repo), a
 * root run in the RunStore, an in-memory ledger holding just the root node, and
 * the legion context an Orchestrator needs.
 */
function spawnFixture() {
	const rootDir = mkdtempSync(path.join(tmpdir(), "legion-bughunt-spawn-"));
	const git = (args: string[]) => execFileSync("git", ["-C", rootDir, ...args], { stdio: "ignore" });
	git(["init", "-q"]);
	git(["config", "user.email", "legion-test@example.invalid"]);
	git(["config", "user.name", "Legion bughunt fixture"]);
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
	const runDir = runStore.runDir(rootRun.runId);
	const context = {
		db,
		dbPath: path.join(runDir, "legion.db"),
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
		runDir,
		db,
		context,
		cleanup() {
			db.close();
			rmSync(rootDir, { recursive: true, force: true });
		},
	};
}

type SpawnFixture = ReturnType<typeof spawnFixture>;

/**
 * The team card, in the shape the loader hands the orchestrator: `phases` is the
 * machine the card declared, already normalized (`agents.ts:570-573`).
 */
function centurionCard(): AgentConfig {
	return {
		name: TEAM_ROLE,
		description: "team root that declares its own phase machine",
		systemPromptMode: "append",
		inheritProjectContext: true,
		inheritSkills: false,
		kind: "pi",
		systemPrompt: "You are the root of a team whose machine starts at recon.",
		source: "user",
		filePath: `/fake/${TEAM_ROLE}.md`,
		phases: EFFECTIVE_MACHINE,
	};
}

/** Launch the team through the orchestrator and hand back the ledger row it wrote. */
async function launchTeam(
	fx: SpawnFixture,
): Promise<{ name: string; nodeId: string; phase: string | null; supervisor: FakeSupervisor }> {
	const supervisor = new FakeSupervisor({ immediateTimeout: false });
	const orchestrator = new Orchestrator({
		supervisor,
		runDir: fx.runDir,
		cwd: fx.rootDir,
		maxDepth: 4,
		legion: fx.context,
	});
	const handle = await bounded(
		"Orchestrator.launch",
		orchestrator.launch({ agent: centurionCard(), task: "own a team whose machine starts at recon", worktree: false }),
	);
	const nodeId = handle.child.nodeId;
	assert.ok(nodeId, `the launch reserved no ledger node (handle: ${handle.name})`);
	const node = getNode(fx.db, nodeId);
	assert.ok(node, `no ledger row for ${nodeId}; the spawn never reached reserveNode`);
	return { name: handle.name, nodeId, phase: node.phase, supervisor };
}

test("RED: the phase a team is born in is the phase its own machine starts in", async () => {
	const fx = spawnFixture();
	let launched: Awaited<ReturnType<typeof launchTeam>> | undefined;
	try {
		launched = await launchTeam(fx);

		// THE claim: the row `reserveNode` wrote (`orchestrator.ts:632`) carries the
		// phase this team's machine starts in — not a phase the machine never heard of.
		assert.equal(
			launched.phase,
			DECLARED_START,
			`a card declaring start='${DECLARED_START}' produced a team born in '${String(launched.phase)}' ` +
				`(machine phases: [${MACHINE_PHASES.join(", ")}])`,
		);
		// Same claim stated structurally, so a fix that invents a THIRD phase cannot
		// satisfy the equality above by accident.
		assert.ok(
			findPhase(EFFECTIVE_MACHINE, launched.phase ?? ""),
			`the birth phase '${String(launched.phase)}' must be a phase of the machine the card declared ` +
				`(start='${DECLARED_START}', phases: [${MACHINE_PHASES.join(", ")}])`,
		);
		// And the consequence the bug is about: from that row, the team's next
		// declared move must be legal.
		const step = evaluatePhaseTransition(
			{ from: launched.phase, to: "build", machine: EFFECTIVE_MACHINE },
			() => NOW,
		);
		assert.equal(step.allowed, true, `a newly born team cannot take its own declared edge: ${decisionLabel(step)}`);
	} finally {
		if (launched) await launched.supervisor.retire(launched.name).catch(() => {});
		fx.cleanup();
	}
});

test("CONTROL (spawn fixture): the node the orchestrator created advances once its phase is in its machine", async () => {
	const fx = spawnFixture();
	let launched: Awaited<ReturnType<typeof launchTeam>> | undefined;
	try {
		launched = await launchTeam(fx);

		// Repair ONLY the birth cell, by hand, to the value the contract asks for.
		// Everything else is the row the orchestrator actually wrote.
		updateNode(fx.db, launched.nodeId, { phase: DECLARED_START, phaseSince: NOW }, () => NOW);

		const step = await bounded(
			"requestLegionPhase(build)",
			requestLegionPhase(fx.db, launched.nodeId, "build", {
				cwd: fx.rootDir,
				now: () => NOW,
				machine: RECON_MACHINE,
				sendSelfMessage() {
					/* the parent notice is not what this control is about */
				},
			}),
		);
		assert.equal(
			getNode(fx.db, launched.nodeId)?.phase,
			"build",
			`recon → build must advance the node the orchestrator created: ` +
				`${step.ok ? `ok (${step.message})` : `refused (${step.message})`}`,
		);
	} finally {
		if (launched) await launched.supervisor.retire(launched.name).catch(() => {});
		fx.cleanup();
	}
});
