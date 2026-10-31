/**
 * #350 review (minor 1) — `abortLegionPhase` promised to resolve a custom phase
 * "through the machine when one is attached" and never attached one.
 *
 * Consequence, measured on this fixture: retiring a child whose team sits in a
 * card-declared phase (`recon`) evaluated `recon -> aborted` against the BUILT-IN
 * machine, got `invalid_phase`, and the `!decision.allowed` guard dropped the abort
 * without an event — the node stayed in `recon` even though its process was already
 * gone. With the caller's `machineForRole` seam the same retire lands `aborted`, and
 * without it the pre-fix behaviour is preserved rather than invented.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { createLegionEventBus } from "../../src/extension/event-bus.ts";
import { openLegionDb } from "../../src/legion/db.ts";
import { readEventsAfter } from "../../src/legion/events.ts";
import { getNode, insertNode } from "../../src/legion/nodes.ts";
import type { PhaseMachine } from "../../src/legion/phase-machine.ts";
import { Orchestrator } from "../../src/runs/orchestrator.ts";
import { RunStore } from "../../src/runs/store.ts";
import type { AgentConfig } from "../../src/shared/types.ts";
import { FakeSupervisor } from "../helpers/fake-supervisor.ts";

/** A card-declared machine whose start phase the built-in machine does not know. */
const CUSTOM: PhaseMachine = {
	start: "recon",
	phases: [
		{ id: "recon", next: [{ to: "build" }] },
		{ id: "build", next: [{ to: "check" }] },
		{ id: "check", next: [] },
	],
};

function centurion(phases: PhaseMachine): AgentConfig {
	return {
		name: "centurion",
		description: "centurion role",
		kind: "pi",
		source: "user",
		filePath: "/fake/centurion.md",
		systemPrompt: "You are centurion.",
		phases,
	} as AgentConfig;
}

/** One launch + retire of a team child, with the machine seam the test wants. */
async function retireCustomPhaseTeam(input: {
	machineForRole?: (role: string | null | undefined) => PhaseMachine | undefined;
}): Promise<{ phase: string | null | undefined; phaseChanges: unknown[] }> {
	const root = mkdtempSync(path.join(tmpdir(), "legion-abort-phase-"));
	// A centurion holds a worktree by default, so the fixture must be a repo.
	const git = (args: string[]) => execFileSync("git", ["-C", root, ...args], { stdio: "ignore" });
	git(["init", "-q"]);
	git(["config", "user.email", "legion-test@example.invalid"]);
	git(["config", "user.name", "Legion test"]);
	writeFileSync(path.join(root, "README.md"), "fixture\n");
	git(["add", "README.md"]);
	git(["commit", "-m", "fixture", "-q"]);
	const db = openLegionDb(":memory:");
	const store = new RunStore({ rootDir: path.join(root, ".pi-subagents") });
	const supervisor = new FakeSupervisor({ immediateTimeout: false });
	try {
		const rootRun = store.createRun({ task: "root", cwd: root, nodeId: "root", maxDepth: 4, herdr: { supervisor: "rpc" } });
		insertNode(db, { id: "root", parentId: null, name: "root", role: "root", runId: rootRun.runId, status: "running" });
		const runDir = store.runDir(rootRun.runId);
		const orchestrator = new Orchestrator({
			supervisor,
			runDir,
			cwd: root,
			maxDepth: 4,
			legion: {
				db,
				dbPath: path.join(runDir, "legion.db"),
				nodeId: "root",
				parentNodeId: null,
				parentRunId: null,
				runId: rootRun.runId,
				runStore: store,
				settings: { maxDepth: 4, maxChildrenPerNode: 8, maxActiveNodes: 30 },
				eventBus: createLegionEventBus(),
				...(input.machineForRole ? { machineForRole: input.machineForRole } : {}),
			},
		});
		const handle = await orchestrator.launch({ agent: centurion(CUSTOM), task: "investigate", worktree: false });
		const nodeId = handle.child.nodeId;
		if (!nodeId) throw new Error("fixture: the child has a legion node");
		const childNodeId: string = nodeId;
		// #350's birth fix: the team is born in ITS machine's start phase.
		assert.equal(getNode(db, childNodeId)?.phase, "recon", "fixture: the team lives in its card's own start phase");
		await orchestrator.retire(handle.name);
		return {
			phase: getNode(db, childNodeId)?.phase,
			phaseChanges: readEventsAfter(db, 0)
				.filter((event) => event.type === "phase_change")
				.map((event) => event.data),
		};
	} finally {
		db.close();
		rmSync(root, { recursive: true, force: true });
	}
}

test("#350 minor 1: retiring a team in a card-declared phase lands `aborted` once the role's machine is attached", async () => {
	const retired = await retireCustomPhaseTeam({ machineForRole: (role) => (role === "centurion" ? CUSTOM : undefined) });
	assert.equal(
		retired.phase,
		"aborted",
		"a parent retire must reach `aborted` on a team living in a phase its card declared — not stay in `recon`",
	);
	assert.deepEqual(
		retired.phaseChanges,
		[{ from: "recon", to: "aborted", reworkCount: 0 }],
		"and it must be visible: one phase_change, not the silent `invalid_phase` drop",
	);
});
