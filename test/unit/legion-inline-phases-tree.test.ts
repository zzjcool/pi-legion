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
 * What is pinned here, layer by layer:
 *   1. the runtime seam resolves per NODE (inline first, and inline BEATS card);
 *   2. the run record is the source, so a reopened session still sees it — and
 *      only the run that DISPATCHED the node may answer (a bare node id repeats
 *      in every run of a checkout: `root.team` is not an identity);
 *   3. a render asks ONCE per team root, however many descendants it has;
 *   4. rendering is unchanged — an inline team and a card team produce the same
 *      phase lines (no new column, no new layout).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { createInlineMachineLookup, inlinePhaseMachineForNode } from "../../index.ts";
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

/** A DIFFERENT machine, as a role card would declare one (#298). */
const CARD_MACHINE: PhaseMachine = {
	start: "plan",
	phases: [
		{ id: "plan", next: [{ to: "ship" }] },
		{ id: "ship", terminal: true, next: [] },
	],
};

/** The run id the root row carries — the run that dispatches the teams below. */
const ROOT_RUN = "r-root";

function node(
	id: string,
	parentId: string | null,
	name: string,
	depth: number,
	role: string,
	phase: string | null,
	runId: string | null = null,
): TreeNodeSnapshot {
	return {
		id,
		parentId,
		name,
		role,
		kind: "pi",
		depth,
		runId,
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
		node("root", null, "root", 0, "root", null, ROOT_RUN),
		node("root.a", "root", "a", 1, "centurion", "recon", "r-a"),
		node("root.a.w", "root.a", "w", 2, "worker", null, "r-a-w"),
		node("root.b", "root", "b", 1, "centurion", null, "r-b"),
		node("root.b.w", "root.b", "w", 2, "worker", null, "r-b-w"),
	];
}

/** One declared team with one worker, at the phase a fresh team is born in. */
function oneTeam(phase: string | null): TreeNodeSnapshot[] {
	return [
		node("root", null, "root", 0, "root", null, ROOT_RUN),
		node("root.team", "root", "team", 1, "centurion", phase, "r-team"),
		node("root.team.w", "root.team", "w", 2, "worker", null, "r-team-w"),
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

/** A child record skeleton the run store accepts. */
function record(name: string, dir: string, nodeId: string, phases?: PhaseMachine) {
	return {
		name,
		sessionFile: path.join(dir, `${name}.jsonl`),
		ownerToken: "owner",
		state: "working" as const,
		spawnedAt: "2026-01-01T00:00:00.000Z",
		nodeId,
		...(phases ? { phases } : {}),
	};
}

test("#372 B: the runtime seam resolves a machine per NODE — inline declaration first, no invention for others", () => {
	const asked: Array<{ id: string; parentRunId: string | null }> = [];
	const runtime = createSessionRuntime({
		sendMessage() {},
		getTreeNodes: () => twoTeams(),
		// The inline declaration is recorded per node; nothing else declares one.
		getPhaseMachineForNode: (target) => {
			asked.push({ id: target.id, parentRunId: target.parentRunId });
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
	assert.deepEqual([...new Set(asked.map((entry) => entry.id))].sort(), ["root.a", "root.b"], "asked exactly the team roots, never a worker or the root shell");
	// #372 M1: the ask carries the run that DISPATCHED the node (the parent's), so
	// the host can read the one run record that is allowed to answer.
	assert.ok(
		asked.every((entry) => entry.parentRunId === ROOT_RUN),
		`every ask carries the dispatching run, got: ${JSON.stringify(asked)}`,
	);
});

test("#372 M2: the INLINE declaration beats the role card (contract §2 priority is real, not incidental)", () => {
	// Both layers answer, with DIFFERENT machines. Only an assertion that names the
	// winner can tell the priority apart: swapping the two lookups in
	// `mergePhaseMachines` must break this test.
	const runtime = createSessionRuntime({
		sendMessage() {},
		getTreeNodes: () => oneTeam("recon"),
		getPhaseMachine: () => CARD_MACHINE,
		getPhaseMachineForNode: () => INLINE_MACHINE,
	});
	const nodes = runtime.treeNodes();
	const team = nodes.find((entry) => entry.id === "root.team");

	assert.deepEqual(team?.phaseMachine, INLINE_MACHINE, "the dispatch declaration wins over a card that also declares one");
	const lines = phaseLines(nodes).join("\n");
	assert.match(lines, /phases · current: recon/, "the panel names the inline phase");
	assert.match(lines, /→ build/, "and the inline transitions");
	assert.doesNotMatch(lines, /\bplan\b/, "the card's phases are not mixed in");
	assert.doesNotMatch(lines, /\bship\b/);
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
		// The launch recorded the declaration on the team's child record (#374 §4)…
		await store.addChild(run.runId, record("team", dir, "root.team", INLINE_MACHINE));
		// …and a worker never has one, whatever its lead declared.
		await store.addChild(run.runId, record("w", dir, "root.team.w"));

		// A FRESH store stands in for the next process / a reopened session: the
		// panel can only answer from what was persisted.
		const runs = new RunStore({ rootDir: dir }).listRuns();
		assert.deepEqual(inlinePhaseMachineForNode("root.team", runs, run.runId), INLINE_MACHINE);
		assert.equal(inlinePhaseMachineForNode("root.team.w", runs, run.runId), undefined, "a worker is never given a declared machine");
		assert.equal(inlinePhaseMachineForNode("root.unknown", runs, run.runId), undefined);
	});
});

test("#372 M1: every run has a `root.team` — only the DISPATCHING run answers, and ambiguity is a miss", async () => {
	await withTempDir(async (dir) => {
		let clock = 1_000;
		const store = new RunStore({ rootDir: dir, now: () => (clock += 1) });
		// An OLD run that declared a machine for `root.team`…
		const oldRun = store.createRun({ task: "old task", cwd: dir, maxDepth: 2, nodeId: "root" });
		await store.addChild(oldRun.runId, record("team", dir, "root.team", CARD_MACHINE));
		// …and TODAY's run, which recorded the same node id and declared NOTHING.
		const currentRun = store.createRun({ task: "today's task", cwd: dir, maxDepth: 2, nodeId: "root" });
		await store.addChild(currentRun.runId, record("team", dir, "root.team"));

		const runs = new RunStore({ rootDir: dir }).listRuns();
		assert.deepEqual(
			runs.map((run) => run.runId),
			[oldRun.runId, currentRun.runId],
			"oldest first — a 'first run that mentions this id' scan is exactly the bug",
		);

		// 1) The dispatching run answers, and "declared nothing" means nothing.
		assert.equal(
			inlinePhaseMachineForNode("root.team", runs, currentRun.runId),
			undefined,
			"today's team declared nothing; an older run's machine must not paint it",
		);
		// 2) The same id still resolves in the run that DID declare it.
		assert.deepEqual(inlinePhaseMachineForNode("root.team", runs, oldRun.runId), CARD_MACHINE);
		// 3) Without a dispatching run, two owners are ambiguous ⇒ miss, never guess.
		assert.equal(inlinePhaseMachineForNode("root.team", runs), undefined, "ambiguity is a miss");
		// 4) A single owner needs no dispatch run to be unambiguous.
		assert.deepEqual(inlinePhaseMachineForNode("root.team", [runs[0]!]), CARD_MACHINE);
	});
});

/** Count `listRuns` at the STORE boundary, so a seam that reads twice goes red. */
function countingStore(store: RunStore): { store: Pick<RunStore, "listRuns">; reads: () => number } {
	let reads = 0;
	const proxy = new Proxy(store, {
		get(target, property, receiver) {
			if (property === "listRuns") {
				return () => {
					reads += 1;
					return target.listRuns();
				};
			}
			return Reflect.get(target, property, receiver);
		},
	});
	return { store: proxy, reads: () => reads };
}

test("#372 m3: a render asks ONCE per team root, and reads the registry ONCE", async () => {
	await withTempDir(async (dir) => {
		const store = new RunStore({ rootDir: dir });
		const run = store.createRun({ task: "team task", cwd: dir, maxDepth: 2, nodeId: "root" });
		const workers = 6;
		await store.addChild(run.runId, record("team", dir, "root.team", INLINE_MACHINE));
		for (let index = 0; index < workers; index += 1) {
			await store.addChild(run.runId, record(`w${index}`, dir, `root.team.w${index}`));
		}
		const nodes: TreeNodeSnapshot[] = [
			node("root", null, "root", 0, "root", null, run.runId),
			node("root.team", "root", "team", 1, "centurion", "recon", "r-team"),
			...Array.from({ length: workers }, (_, index) =>
				node(`root.team.w${index}`, "root.team", `w${index}`, 2, "worker", null, `r-team-w${index}`)),
		];

		// Counting happens at the STORE, not in this test's own callback: a seam that
		// called `listRuns()` twice inside one lookup would be counted twice here,
		// which is what makes the assertion non-tautological (round-2 review, minor 2).
		const counted = countingStore(store);
		let seamCalls = 0;
		// Assigned AFTER construction: the runtime paints once while being built, and
		// that paint must not pre-warm the wiring cache this case is measuring. A cold
		// cache is the state a freshly launched panel is in.
		let lookup: ReturnType<typeof createInlineMachineLookup> | undefined;
		const runtime = createSessionRuntime({
			sendMessage() {},
			getTreeNodes: () => nodes,
			getPhaseMachineForNode: (target) => {
				if (!lookup) return undefined;
				seamCalls += 1;
				return lookup(target);
			},
		});
		lookup = createInlineMachineLookup({ cwd: () => dir, runStoreFor: () => counted.store });

		// Measured as a DELTA so the construction-time paint cannot leak in.
		const askedBefore = seamCalls;
		const readsBefore = counted.reads();
		const rendered = runtime.treeNodes();
		assert.deepEqual(rendered.find((entry) => entry.id === "root.team")?.phaseMachine, INLINE_MACHINE, "the real store answered");
		// The walk reaches this team root from the team itself AND from every worker.
		// Without a per-snapshot memo this is N + 1 asks.
		assert.equal(seamCalls - askedBefore, 1, `one ask for the team root, not one per descendant (${workers} workers)`);
		assert.equal(counted.reads() - readsBefore, 1, "…and exactly one runs-registry read at the store boundary");
		for (const worker of rendered.filter((entry) => entry.id.startsWith("root.team.w"))) {
			assert.deepEqual(worker.phaseMachine, INLINE_MACHINE, "every worker inherited the ONE answer");
		}

		// The runtime memo is scoped to a snapshot, so a repaint asks again — and the
		// wiring's positive cache answers it without touching the registry.
		runtime.treeNodes();
		assert.equal(seamCalls - askedBefore, 2, "the runtime asks per render, not per node and not forever");
		assert.equal(counted.reads() - readsBefore, 1, "the wiring cache absorbs the repaint (no second registry read)");
	});
});

test("#372 minor 1: the wiring is run-scoped, forwards the dispatching run, and heals its own misses", async () => {
	await withTempDir(async (dir) => {
		let clock = 1_000;
		const store = new RunStore({ rootDir: dir, now: () => (clock += 1) });
		// THREE runs, all owning `root.team` — the collision that #372 M1 is about.
		// `listRuns()` is oldest-first, so an id-keyed scan or an id-keyed cache would
		// hand the FIRST one's answer to all three.
		const first = store.createRun({ task: "first", cwd: dir, maxDepth: 2, nodeId: "root" });
		await store.addChild(first.runId, record("team", dir, "root.team", CARD_MACHINE));
		const second = store.createRun({ task: "second", cwd: dir, maxDepth: 2, nodeId: "root" });
		await store.addChild(second.runId, record("team", dir, "root.team"));
		const third = store.createRun({ task: "third", cwd: dir, maxDepth: 2, nodeId: "root" });
		await store.addChild(third.runId, record("team", dir, "root.team", INLINE_MACHINE));

		let now = 10_000;
		const counted = countingStore(store);
		const lookup = createInlineMachineLookup({
			cwd: () => dir,
			runStoreFor: () => counted.store,
			now: () => now,
		});
		const ask = (parentRunId: string) => lookup({ id: "root.team", role: "centurion", parentRunId });

		// (c) the THIRD argument is really passed through: three runs, three answers —
		// an id-only answer (or a dropped `parentRunId`) collapses them into one.
		assert.deepEqual(ask(first.runId), CARD_MACHINE, "the first run's own declaration");
		assert.equal(ask(second.runId), undefined, "the second run declared nothing — never borrow from another run");
		assert.deepEqual(ask(third.runId), INLINE_MACHINE, "the third run's own declaration");
		assert.equal(counted.reads(), 3, "one registry read per distinct (run, node)");

		// (a) cache entries are per (run, node): a shared entry would now answer
		// the wrong machine for two of the three keys.
		assert.deepEqual(ask(first.runId), CARD_MACHINE);
		assert.equal(ask(second.runId), undefined);
		assert.deepEqual(ask(third.runId), INLINE_MACHINE);
		assert.equal(counted.reads(), 3, "…and each is served from its own entry, no extra reads");

		// (b) a cached MISS heals itself after the TTL: this is the `persistChild`
		// race — the row exists a moment before the record does.
		await store.updateChild(second.runId, "team", (child) => { child.phases = INLINE_MACHINE; });
		assert.equal(ask(second.runId), undefined, "still inside the TTL: the miss stands");
		assert.equal(counted.reads(), 3);
		now += 1_000;
		assert.deepEqual(ask(second.runId), INLINE_MACHINE, "after the TTL the new declaration is picked up");
		assert.equal(counted.reads(), 4);
	});
});
