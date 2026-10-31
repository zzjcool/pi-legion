/**
 * BUGHUNT C2 — `abortLegionPhase` drops the abort for custom-named phases.
 *
 * `Orchestrator.abortLegionPhase` (`src/runs/orchestrator.ts:712-730`) documents
 * that "an ABORT must never be blocked by that — a team that cannot be stopped
 * is a safety hole", and that "a custom name resolves through the machine when
 * one is attached". The call it makes, however, never forwards `machine`:
 *
 *     evaluatePhaseTransition({ from, to: "aborted", reworkCount,
 *                               terminalReason: "parent_retire",
 *                               actorRole: "supervisor" }, this.now)
 *
 * With `machine` absent, `evaluatePhaseTransition` falls back to
 * `DEFAULT_PHASE_MACHINE` (`src/legion/state-machine.ts:316`), whose phase set
 * does not contain a team-declared name, so `evaluateDeclarative` returns
 * `invalid_phase` (`src/legion/state-machine.ts:142-144`). `abortLegionPhase`
 * then hits `if (!decision.allowed) return;` (`orchestrator.ts:727`) and the
 * refusal is discarded: no `phase_change` event, no error, no trace. The node
 * stays in its custom phase forever even though retire has already killed it.
 *
 * Test 1 is the behavioural proof (real Orchestrator, real ledger, real
 * `retire()` entry point — the one path `retire()`/`retireAll()`/`/legion stop`
 * share). Test 2 is the locator: the pure decision function already does the
 * right thing once a machine is handed to it, so the defect is exactly one
 * missing argument in the caller, not in the state machine.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { createLegionEventBus } from "../../src/extension/event-bus.ts";
import { openLegionDb } from "../../src/legion/db.ts";
import { readEventsAfter } from "../../src/legion/events.ts";
import { getNode, insertNode } from "../../src/legion/nodes.ts";
import type { PhaseMachine } from "../../src/legion/phase-machine.ts";
import { evaluatePhaseTransition } from "../../src/legion/state-machine.ts";
import { Orchestrator } from "../../src/runs/orchestrator.ts";
import { RunStore } from "../../src/runs/store.ts";
import { FakeSupervisor } from "../helpers/fake-supervisor.ts";

/** A phase name the built-in union does not know, as a declared team may use. */
const CUSTOM_PHASE = "build";

/**
 * Every await in this file is bounded: a wedged orchestrator path must fail the
 * test with a message, not hang the runner forever.
 */
function bounded<T>(work: Promise<T>, label: string, ms = 10_000): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const guard = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms: ${label}`)), ms);
		timer.unref();
	});
	return Promise.race([work, guard]).finally(() => {
		if (timer) clearTimeout(timer);
	});
}

/**
 * The lightest real ledger + run fixture: an in-memory legion db, a run record
 * on disk, and `restore()` to seat a child in the orchestrator without spawning
 * anything. `retire()` needs no live process — it reads the record, skips the
 * supervisor when the child is not alive, and still runs the ledger branch that
 * calls `abortLegionPhase`.
 */
function fixture() {
	const rootDir = mkdtempSync(path.join(tmpdir(), "bughunt-abort-custom-phase-"));
	const runStore = new RunStore({ rootDir: path.join(rootDir, ".pi-subagents") });
	const rootRun = runStore.createRun({ task: "root task", cwd: rootDir, nodeId: "root", maxDepth: 4 });
	const db = openLegionDb(":memory:");
	insertNode(db, {
		id: "root",
		parentId: null,
		name: "root",
		role: "root",
		runId: rootRun.runId,
		status: "running",
	});
	return {
		rootDir,
		runStore,
		rootRun,
		db,
		cleanup() {
			db.close();
			rmSync(rootDir, { recursive: true, force: true });
		},
	};
}

test("C2: retiring a child in a custom phase still lands phase=aborted in the ledger", async () => {
	const fx = fixture();
	const name = "team-lead";
	const sessionFile = fx.runStore.sessionFileFor(fx.rootRun.runId, name);
	const node = insertNode(fx.db, {
		parentId: "root",
		name,
		role: "worker",
		runId: fx.rootRun.runId,
		sessionFile,
		status: "running",
		phase: CUSTOM_PHASE,
	});
	// Seat the child in the run record (no spawn: retire() never requires a live
	// process, only a child record carrying the ledger nodeId).
	await fx.runStore.addChild(fx.rootRun.runId, {
		name,
		nodeId: node.id,
		sessionFile,
		ownerToken: `${name}-token`,
		state: "working",
		spawnedAt: fx.rootRun.createdAt,
		agent: name,
		kind: "pi",
	});
	const orchestrator = new Orchestrator({
		supervisor: new FakeSupervisor({ immediateTimeout: false }),
		runDir: fx.runStore.runDir(fx.rootRun.runId),
		cwd: fx.rootDir,
		maxDepth: 4,
		legion: {
			db: fx.db,
			dbPath: path.join(fx.runStore.runDir(fx.rootRun.runId), "legion.db"),
			nodeId: "root",
			parentNodeId: null,
			parentRunId: null,
			runId: fx.rootRun.runId,
			runStore: fx.runStore,
			settings: { maxDepth: 4, maxChildrenPerNode: 8, maxActiveNodes: 30 },
			eventBus: createLegionEventBus(),
		},
	});
	try {
		orchestrator.restore(fx.runStore.readRun(fx.rootRun.runId)!);

		// Precondition: the fixture really is mid-phase in a name the built-in
		// union does not know.
		assert.equal(getNode(fx.db, node.id)?.phase, CUSTOM_PHASE);

		await bounded(orchestrator.retire(name), "orchestrator.retire");

		// Sanity: retire() did reach and execute its ledger branch, so any missing
		// phase change below is the abort being dropped, not retire being skipped.
		assert.equal(getNode(fx.db, node.id)?.status, "retired");
		const events = readEventsAfter(fx.db, 0, { nodeId: node.id });
		assert.ok(
			events.some((event) => event.type === "node_retired"),
			"retire must reach the ledger (node_retired)",
		);

		// The bug: a retired node is left in its custom phase with no abort record.
		assert.equal(
			getNode(fx.db, node.id)?.phase,
			"aborted",
			"a retired team must not be stranded in its pre-retire phase",
		);
		assert.ok(
			events.some((event) => event.type === "phase_change"),
			"the abort must be recorded as a phase_change event",
		);
	} finally {
		fx.cleanup();
	}
});

/**
 * Positive control for the test above: the identical fixture and the identical
 * `retire()` entry point DO write `phase=aborted` when the node sits in a phase
 * the built-in union knows (`implementing`). So the RED above is the missing
 * `machine` argument, not a broken fixture or an abort path that never runs.
 */
test("C2 control: the same retire path DOES abort a built-in phase", async () => {
	const fx = fixture();
	const name = "team-lead";
	const sessionFile = fx.runStore.sessionFileFor(fx.rootRun.runId, name);
	const node = insertNode(fx.db, {
		parentId: "root",
		name,
		role: "worker",
		runId: fx.rootRun.runId,
		sessionFile,
		status: "running",
		phase: "implementing",
	});
	await fx.runStore.addChild(fx.rootRun.runId, {
		name,
		nodeId: node.id,
		sessionFile,
		ownerToken: `${name}-token`,
		state: "working",
		spawnedAt: fx.rootRun.createdAt,
		agent: name,
		kind: "pi",
	});
	const orchestrator = new Orchestrator({
		supervisor: new FakeSupervisor({ immediateTimeout: false }),
		runDir: fx.runStore.runDir(fx.rootRun.runId),
		cwd: fx.rootDir,
		maxDepth: 4,
		legion: {
			db: fx.db,
			dbPath: path.join(fx.runStore.runDir(fx.rootRun.runId), "legion.db"),
			nodeId: "root",
			parentNodeId: null,
			parentRunId: null,
			runId: fx.rootRun.runId,
			runStore: fx.runStore,
			settings: { maxDepth: 4, maxChildrenPerNode: 8, maxActiveNodes: 30 },
			eventBus: createLegionEventBus(),
		},
	});
	try {
		orchestrator.restore(fx.runStore.readRun(fx.rootRun.runId)!);
		await bounded(orchestrator.retire(name), "orchestrator.retire (control)");

		assert.equal(getNode(fx.db, node.id)?.phase, "aborted");
		assert.ok(
			readEventsAfter(fx.db, 0, { nodeId: node.id }).some((event) => event.type === "phase_change"),
		);
	} finally {
		fx.cleanup();
	}
});

test("C2 locator: the same abort transition is denied without a machine and allowed with one", () => {
	// Exactly the input `abortLegionPhase` builds today — machine omitted.
	const abortInput = {
		from: CUSTOM_PHASE,
		to: "aborted",
		reworkCount: 0,
		terminalReason: "parent_retire",
		actorRole: "supervisor",
	} as const;

	const asCalledToday = evaluatePhaseTransition({ ...abortInput });
	assert.equal(asCalledToday.allowed, false, "without a machine the custom phase is unknown");
	assert.equal(
		asCalledToday.allowed === false ? asCalledToday.reason : undefined,
		"invalid_phase",
	);
	assert.match(
		asCalledToday.allowed === false ? asCalledToday.message : "",
		/is not part of this team's machine/,
	);

	// The declared machine for a team whose phases are named by the team itself.
	// `normalizePhaseMachine` injects done/failed/aborted into ANY machine, so the
	// `aborted` phase exists as soon as the machine is supplied. The declared phase
	// must still carry a non-empty `next`: `isTerminalIn` treats `next.length === 0`
	// as terminal, which would deny with `terminal_phase` instead — a synthetic
	// machine therefore needs at least one edge, as this one has.
	const machine: PhaseMachine = {
		start: CUSTOM_PHASE,
		maxRework: 2,
		phases: [{ id: CUSTOM_PHASE, next: [{ to: "done" }] }],
	};

	const withMachine = evaluatePhaseTransition({ ...abortInput, machine });
	assert.equal(withMachine.allowed, true, "a declared machine makes the abort legal");
	assert.equal(withMachine.allowed === true ? withMachine.to : undefined, "aborted");
});
