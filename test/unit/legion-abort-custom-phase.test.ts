/**
 * #351 — `retire()` / `retireAll()` / `/legion stop` silently dropped the abort
 * for a team whose current phase name came from its OWN declarative machine.
 *
 * `Orchestrator.abortLegionPhase` called `evaluatePhaseTransition` without the
 * team's machine, so a custom name (`"build"`) fell through to
 * `DEFAULT_PHASE_MACHINE` and was refused with `invalid_phase`; the caller then
 * did `if (!decision.allowed) return;` — a silent drop. The node kept its
 * pre-retire phase forever, which is exactly the "a team that cannot be stopped
 * is a safety hole" case `phase-machine.ts` promises to prevent.
 *
 * Two layers are pinned here:
 *
 *   1. the machine is actually FORWARDED (a declared machine resolves the custom
 *      name, no forced fallback, no warning), and
 *   2. when it still cannot be resolved, the retire is FORCED through: the phase
 *      becomes `aborted`, a `phase_change` event carries
 *      `{ forced: true, reason: "parent_retire_unresolved_phase", denied }`, and
 *      one `console.warn` names the node, the phase and the refusal.
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
import { Orchestrator } from "../../src/runs/orchestrator.ts";
import { RunStore } from "../../src/runs/store.ts";
import { FakeSupervisor } from "../helpers/fake-supervisor.ts";

/** A phase name the built-in union does not know, as a declared team may use. */
const CUSTOM_PHASE = "build";

/**
 * The declared machine of a team whose workflow is named by the card itself.
 * `normalizePhaseMachine` injects done/failed/aborted into ANY machine, so the
 * abort target exists as soon as the machine is supplied; the declared phase
 * still needs a non-empty `next` (`isTerminalIn` reads `next.length === 0`).
 */
const CUSTOM_MACHINE: PhaseMachine = {
	start: CUSTOM_PHASE,
	maxRework: 2,
	phases: [{ id: CUSTOM_PHASE, next: [{ to: "done" }] }],
};

/** Every await here is bounded: a wedged retire path must fail, not hang. */
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

interface Fixture {
	rootDir: string;
	runStore: RunStore;
	db: ReturnType<typeof openLegionDb>;
	nodeId: string;
	cleanup(): void;
}

/**
 * The lightest real fixture: an in-memory legion db, a run record on disk, and
 * `restore()` to seat a child in the orchestrator without spawning anything.
 * `retire()` needs no live process — it reads the record, skips the supervisor
 * when the child is not alive, and still runs the ledger branch that calls
 * `abortLegionPhase`.
 */
function fixture(phase: string): Fixture {
	const rootDir = mkdtempSync(path.join(tmpdir(), "legion-abort-custom-phase-"));
	const runStore = new RunStore({ rootDir: path.join(rootDir, ".pi-subagents") });
	const db = openLegionDb(":memory:");
	insertNode(db, { id: "root", parentId: null, name: "root", role: "root", status: "running" }, () => 1);
	const node = insertNode(db, { parentId: "root", name: "team-lead", role: "centurion", status: "running", phase }, () => 2);
	return {
		rootDir,
		runStore,
		db,
		nodeId: node.id,
		cleanup() {
			db.close();
			rmSync(rootDir, { recursive: true, force: true });
		},
	};
}

/** Seat the ledger node in the run record (`retire()` addresses children by name). */
async function seat(fx: Fixture, runId: string) {
	await fx.runStore.addChild(runId, {
		name: "team-lead",
		nodeId: fx.nodeId,
		sessionFile: fx.runStore.sessionFileFor(runId, "team-lead"),
		ownerToken: "team-lead-token",
		state: "working",
		spawnedAt: fx.runStore.readRun(runId)!.createdAt,
		agent: "centurion",
		kind: "pi",
	});
}

function orchestratorFor(
	fx: Fixture,
	runId: string,
	machineForRole?: (role: string | null | undefined) => PhaseMachine | undefined,
): Orchestrator {
	return new Orchestrator({
		supervisor: new FakeSupervisor({ immediateTimeout: false }),
		runDir: fx.runStore.runDir(runId),
		cwd: fx.rootDir,
		maxDepth: 4,
		legion: {
			db: fx.db,
			dbPath: path.join(fx.runStore.runDir(runId), "legion.db"),
			nodeId: "root",
			parentNodeId: null,
			parentRunId: null,
			runId,
			runStore: fx.runStore,
			settings: { maxDepth: 4, maxChildrenPerNode: 8, maxActiveNodes: 30 },
			eventBus: createLegionEventBus(),
			...(machineForRole ? { machineForRole } : {}),
		},
	});
}

test("#351: a declared machine is forwarded, so a custom phase aborts through the normal path", async () => {
	const fx = fixture(CUSTOM_PHASE);
	const run = fx.runStore.createRun({ task: "root task", cwd: fx.rootDir, nodeId: "root", maxDepth: 4 });
	const originalWarn = console.warn;
	const warnings: string[] = [];
	console.warn = (message?: unknown) => { warnings.push(String(message)); };
	try {
		await seat(fx, run.runId);
		const requested: Array<string | null | undefined> = [];
		const orchestrator = orchestratorFor(fx, run.runId, (role) => {
			requested.push(role);
			return CUSTOM_MACHINE;
		});
		orchestrator.restore(fx.runStore.readRun(run.runId)!);
		assert.equal(getNode(fx.db, fx.nodeId)?.phase, CUSTOM_PHASE, "precondition: the node sits in the custom phase");

		await bounded(orchestrator.retire("team-lead"), "orchestrator.retire");

		assert.equal(getNode(fx.db, fx.nodeId)?.status, "retired");
		assert.equal(getNode(fx.db, fx.nodeId)?.phase, "aborted", "the declared machine resolves the custom name");
		assert.deepEqual(requested, ["centurion"], "the abort asks for the team's machine by role");
		const phaseEvents = readEventsAfter(fx.db, 0, { nodeId: fx.nodeId }).filter((event) => event.type === "phase_change");
		assert.equal(phaseEvents.length, 1, "exactly one phase_change, not one per tick");
		const data = phaseEvents[0]!.data as Record<string, unknown>;
		assert.equal(data.to, "aborted");
		assert.equal(data.from, CUSTOM_PHASE);
		assert.equal(data.forced, undefined, "a resolved machine needs no forced fallback");
		assert.deepEqual(warnings, [], "a resolved abort is not a safety event");
	} finally {
		console.warn = originalWarn;
		fx.cleanup();
	}
});

test("#351: an unresolvable phase is still forced to aborted — with a phase_change event and one warning", async () => {
	const fx = fixture(CUSTOM_PHASE);
	const run = fx.runStore.createRun({ task: "root task", cwd: fx.rootDir, nodeId: "root", maxDepth: 4 });
	const originalWarn = console.warn;
	const warnings: string[] = [];
	console.warn = (message?: unknown) => { warnings.push(String(message)); };
	try {
		await seat(fx, run.runId);
		// No machineForRole: the exact shape of a team whose card cannot be
		// resolved. The abort must NOT be dropped.
		const orchestrator = orchestratorFor(fx, run.runId);
		orchestrator.restore(fx.runStore.readRun(run.runId)!);

		await bounded(orchestrator.retire("team-lead"), "orchestrator.retire");

		assert.equal(getNode(fx.db, fx.nodeId)?.status, "retired");
		assert.equal(
			getNode(fx.db, fx.nodeId)?.phase,
			"aborted",
			"a parent retire must always take effect (safety bottom line)",
		);
		const phaseEvents = readEventsAfter(fx.db, 0, { nodeId: fx.nodeId }).filter((event) => event.type === "phase_change");
		assert.equal(phaseEvents.length, 1);
		const data = phaseEvents[0]!.data as Record<string, unknown>;
		assert.equal(data.to, "aborted");
		assert.equal(data.from, CUSTOM_PHASE);
		assert.equal(data.forced, true);
		assert.equal(data.reason, "parent_retire_unresolved_phase");
		assert.equal(data.denied, "invalid_phase");
		assert.equal(warnings.length, 1, "a refused abort is a safety event: exactly one warning");
		assert.match(warnings[0]!, /team-lead|root\.team-lead/u, "the warning names the node");
		assert.match(warnings[0]!, new RegExp(CUSTOM_PHASE, "u"), "the warning names the phase it could not resolve");
		assert.match(warnings[0]!, /invalid_phase/u, "the warning names the refusal");
	} finally {
		console.warn = originalWarn;
		fx.cleanup();
	}
});

test("#355: a throwing machineForRole degrades to \"no machine\" instead of escaping retire()", async () => {
	const fx = fixture(CUSTOM_PHASE);
	const run = fx.runStore.createRun({ task: "root task", cwd: fx.rootDir, nodeId: "root", maxDepth: 4 });
	const originalWarn = console.warn;
	const warnings: string[] = [];
	console.warn = (message?: unknown) => { warnings.push(String(message)); };
	try {
		await seat(fx, run.runId);
		// `retire()` is already past `supervisor.retire()` when it reaches the abort,
		// so a throw from the caller-supplied lookup would escape `retire()` after the
		// process is gone and skip the bookkeeping lines below it.
		const rolesAsked: Array<string | null | undefined> = [];
		const orchestrator = orchestratorFor(fx, run.runId, (role) => {
			rolesAsked.push(role);
			throw new Error("agent discovery exploded");
		});
		orchestrator.restore(fx.runStore.readRun(run.runId)!);

		await bounded(orchestrator.retire("team-lead"), "orchestrator.retire (throwing machine)");

		assert.equal(rolesAsked.length, 1, "the lookup was asked once");
		assert.equal(getNode(fx.db, fx.nodeId)?.status, "retired", "the retire bookkeeping still runs");
		assert.equal(getNode(fx.db, fx.nodeId)?.phase, "aborted", "a throwing lookup behaves like no machine: forced through");
		const phaseEvents = readEventsAfter(fx.db, 0, { nodeId: fx.nodeId }).filter((event) => event.type === "phase_change");
		assert.equal(phaseEvents.length, 1);
		const data = phaseEvents[0]!.data as Record<string, unknown>;
		assert.equal(data.to, "aborted");
		assert.equal(data.forced, true);
		assert.equal(data.denied, "invalid_phase", "without a machine the custom name is still unresolved");
		assert.equal(warnings.length, 2, "one for the throw, one for the refused abort");
		assert.match(warnings[0]!, /agent discovery exploded/u, "the throw is reported, not swallowed silently");
		assert.ok(warnings[0]!.includes(String(rolesAsked[0])), "the warning names the role it could not resolve");
		assert.match(warnings[1]!, /invalid_phase/u);
	} finally {
		console.warn = originalWarn;
		fx.cleanup();
	}
});

test("#351 control: a built-in phase aborts exactly as before (no forced flag, no warning)", async () => {
	const fx = fixture("implementing");
	const run = fx.runStore.createRun({ task: "root task", cwd: fx.rootDir, nodeId: "root", maxDepth: 4 });
	const originalWarn = console.warn;
	const warnings: string[] = [];
	console.warn = (message?: unknown) => { warnings.push(String(message)); };
	try {
		await seat(fx, run.runId);
		const orchestrator = orchestratorFor(fx, run.runId);
		orchestrator.restore(fx.runStore.readRun(run.runId)!);

		await bounded(orchestrator.retire("team-lead"), "orchestrator.retire (control)");

		assert.equal(getNode(fx.db, fx.nodeId)?.phase, "aborted");
		const phaseEvents = readEventsAfter(fx.db, 0, { nodeId: fx.nodeId }).filter((event) => event.type === "phase_change");
		assert.equal(phaseEvents.length, 1);
		assert.equal((phaseEvents[0]!.data as Record<string, unknown>).forced, undefined);
		assert.deepEqual(warnings, []);
	} finally {
		console.warn = originalWarn;
		fx.cleanup();
	}
});

test("#351: retiring a node that already reached a terminal phase writes no second phase_change", async () => {
	const fx = fixture("done");
	const run = fx.runStore.createRun({ task: "root task", cwd: fx.rootDir, nodeId: "root", maxDepth: 4 });
	try {
		await seat(fx, run.runId);
		const orchestrator = orchestratorFor(fx, run.runId, () => CUSTOM_MACHINE);
		orchestrator.restore(fx.runStore.readRun(run.runId)!);

		await bounded(orchestrator.retire("team-lead"), "orchestrator.retire (terminal)");

		assert.equal(getNode(fx.db, fx.nodeId)?.phase, "done", "the terminal early-exit is unchanged");
		assert.equal(
			readEventsAfter(fx.db, 0, { nodeId: fx.nodeId }).filter((event) => event.type === "phase_change").length,
			0,
		);
	} finally {
		fx.cleanup();
	}
});
