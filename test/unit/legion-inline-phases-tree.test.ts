/**
 * #372 B: a team that declared its machine INLINE (`subagent({ phases })`, #371
 * contract §2) must show that machine in the `/legion` tree, exactly like a team
 * whose card declares `phases:`.
 *
 * The tree answered "which machine governs this node" by ROLE only
 * (`getPhaseMachine(role)` → role card), and an inline declaration has no card:
 * it lives on the NODE (`ChildRecord.phases` in run.json, written at launch and
 * kept across processes by #374 §4). So the panel showed nothing at all for the
 * very teams whose machine was configured most explicitly.
 *
 * Three layers are pinned here:
 *   1. the runtime seam resolves per NODE (inline first) instead of per role;
 *   2. the run record is the source, so a reopened session still sees it;
 *   3. rendering is unchanged — an inline team and a card team produce the same
 *      phase lines (no new column, no new layout).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { inlinePhaseMachineForNode } from "../../index.ts";
import { createSessionRuntime } from "../../src/extension/runtime.ts";
import type { PhaseMachine } from "../../src/legion/phase-machine.ts";
import { RunStore } from "../../src/runs/store.ts";
import { createTreeView, type TreeNodeSnapshot } from "../../src/tui/tree-view.ts";
import { withTempDir } from "../helpers/tmp.ts";

/** The exact shape #371 accepts from `subagent({ phases })`: no built-in names. */
const INLINE_MACHINE: PhaseMachine = {
	start: "recon",
	phases: [
		{ id: "recon", next: [{ to: "build", require: ["contract_file"] }] },
		{ id: "build", next: [{ to: "done", require: ["verdict_ok"] }] },
		{ id: "done", terminal: true, next: [] },
	],
};

function node(
	id: string,
	parentId: string | null,
	name: string,
	depth: number,
	role: string,
	phase: string | null,
): TreeNodeSnapshot {
	return {
		id,
		parentId,
		name,
		role,
		kind: "pi",
		depth,
		runId: null,
		sessionFile: null,
		worktreePath: null,
		model: null,
		team: null,
		status: "running",
		phase,
		phaseSince: null,
		reworkCount: 0,
		contractPath: null,
		taskSummary: null,
		// Fresh on purpose: `snapshotNodes()` runs `liveness()`, which calls a row
		// whose heartbeat is older than 90s DEAD and renders it `failed` — a terminal
		// status folds the row and nothing under it (phase lines included) renders.
		createdAt: Date.now(),
		updatedAt: Date.now(),
	};
}

/** Two teams side by side: `a` declared a machine, `b` declared none. */
function twoTeams(): TreeNodeSnapshot[] {
	return [
		node("root", null, "root", 0, "root", null),
		node("root.a", "root", "a", 1, "centurion", "recon"),
		node("root.a.w", "root.a", "w", 2, "worker", null),
		node("root.b", "root", "b", 1, "centurion", null),
		node("root.b.w", "root.b", "w", 2, "worker", null),
	];
}

/** One declared team with one worker, at the phase a fresh team is born in. */
function oneTeam(phase: string | null): TreeNodeSnapshot[] {
	return [
		node("root", null, "root", 0, "root", null),
		node("root.team", "root", "team", 1, "centurion", phase),
		node("root.team.w", "root.team", "w", 2, "worker", null),
	];
}

/** Render the tree with the team row selected and return its phase block. */
function phaseLines(nodes: readonly TreeNodeSnapshot[]): string[] {
	const view = createTreeView({ nodes });
	try {
		// Selection starts on the root row; the team is the first child.
		view.handleInput?.("j");
		return view
			.render(200)
			.map((line) => stripTerminalSequences(line))
			.filter((line) => line.includes("phases ·") || line.includes("→ ") || line.includes("(terminal)"));
	} finally {
		view.dispose();
	}
}

test("#372 B: the runtime seam resolves a machine per NODE — inline declaration first, no invention for others", () => {
	const asked: string[] = [];
	const runtime = createSessionRuntime({
		sendMessage() {},
		getTreeNodes: () => twoTeams(),
		// The inline declaration is recorded per node; nothing else declares one.
		getPhaseMachineForNode: (target) => {
			asked.push(target.id);
			return target.id === "root.a" ? INLINE_MACHINE : undefined;
		},
	});
	const nodes = runtime.treeNodes();
	const teamA = nodes.find((entry) => entry.id === "root.a");
	const teamB = nodes.find((entry) => entry.id === "root.b");

	assert.deepEqual(teamA?.phaseMachine, INLINE_MACHINE, "an inline-declared team carries its machine into the panel");
	assert.equal(teamA?.phase, "recon", "and the phase the ledger holds is the one rendered");
	// #298 semantics are unchanged: a child is governed by the team that declared
	// the machine, so it inherits rather than showing an empty machine.
	assert.deepEqual(nodes.find((entry) => entry.id === "root.a.w")?.phaseMachine, INLINE_MACHINE);

	assert.equal(teamB?.phaseMachine, undefined, "an undeclared team gets no machine — the built-in one is not invented");
	assert.equal(
		nodes.find((entry) => entry.id === "root.b.w")?.phaseMachine,
		undefined,
		"a worker under an undeclared team stays blank: a worker never declares phases, and none is pushed onto it",
	);

	// Only a team root can carry an inline declaration (the launch guards refuse
	// `phases` for every other role), so only team roots are asked — a render of a
	// whole squad must not pay one runs-registry read per worker.
	assert.deepEqual([...new Set(asked)].sort(), ["root.a", "root.b"], "asked exactly the team roots, never a worker or the root shell");
});

test("#372 B: an inline-declared team renders its phases exactly like a card-declared team", () => {
	const card = createSessionRuntime({
		sendMessage() {},
		getTreeNodes: () => oneTeam("recon"),
		// What a role card declaring `phases:` resolved to before #372.
		getPhaseMachine: (role) => (role === "centurion" ? INLINE_MACHINE : undefined),
	});
	const inline = createSessionRuntime({
		sendMessage() {},
		getTreeNodes: () => oneTeam("recon"),
		// What #371's inline declaration resolves to now.
		getPhaseMachineForNode: (target) => (target.id === "root.team" ? INLINE_MACHINE : undefined),
	});

	const cardLines = phaseLines(card.treeNodes());
	const inlineLines = phaseLines(inline.treeNodes());

	assert.ok(cardLines.length > 0, "the card path renders a phase block at all");
	assert.deepEqual(inlineLines, cardLines, "same lines, same order: the panel does not distinguish the two sources");
	assert.match(cardLines.join("\n"), /phases · current: recon/);
	assert.match(cardLines.join("\n"), /→ build/);

	// …and the undeclared case renders nothing extra: no phase block, no "no
	// machine" label. This is the visibility half of the requirement.
	const bare = createSessionRuntime({ sendMessage() {}, getTreeNodes: () => oneTeam(null) });
	assert.deepEqual(phaseLines(bare.treeNodes()), []);
});

test("#372 B: the source of truth is run.json, so a later process still sees the declaration", async () => {
	await withTempDir(async (dir) => {
		const store = new RunStore({ rootDir: dir });
		const run = store.createRun({ task: "team task", cwd: dir, maxDepth: 2, nodeId: "root" });
		const base = { sessionFile: path.join(dir, "s.jsonl"), ownerToken: "owner", state: "working" as const, spawnedAt: "2026-01-01T00:00:00.000Z" };
		// The launch recorded the declaration on the team's child record (#374 §4)…
		await store.addChild(run.runId, { ...base, name: "team", nodeId: "root.team", phases: INLINE_MACHINE });
		// …and a worker never has one, whatever its lead declared.
		await store.addChild(run.runId, { ...base, name: "w", sessionFile: path.join(dir, "w.jsonl"), nodeId: "root.team.w" });

		// A FRESH store stands in for the next process / a reopened session: the
		// panel can only answer from what was persisted.
		const runs = new RunStore({ rootDir: dir }).listRuns();
		assert.deepEqual(inlinePhaseMachineForNode("root.team", runs), INLINE_MACHINE);
		assert.equal(inlinePhaseMachineForNode("root.team.w", runs), undefined, "a worker is never given a declared machine");
		assert.equal(inlinePhaseMachineForNode("root.unknown", runs), undefined);
	});
});
