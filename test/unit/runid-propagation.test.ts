/**
 * #414 — runId propagation: the run that DISPATCHED a child is an explicit fact
 * on the three surfaces that used to guess it.
 *
 * The defect behind the issue: a completion notice and a remote artifact named
 * only the child's handle, so two same-named children of different runs were
 * indistinguishable — on one machine they even shared `<mirrorRoot>/no-run/<name>`
 * and `lgl-<name>`, and a notice could only be attributed by guessing. The fix
 * is NOT a new identity layer (the psid design was rejected): the already
 * existing run id travels on the spawn request, lands in `run.json` (both
 * directions), and rides the completion notice.
 *
 * The three faces this file pins, each with its fallback:
 *
 *   1. spawn body   — `SpawnInput.runId` (asserted here at the Orchestrator seam;
 *                     the terminal wire shape lives in `terminal-supervisor.test.ts`
 *                     and `cross-machine-params.test.ts`, next to their harnesses);
 *   2. run.json     — `ChildRecord.parentRunId` (parent → child) and the child's
 *                     own lineage `path` (child → parent);
 *   3. notice       — `Run: <id>` + `details.runId`, additive-only.
 *
 * Fallback rule (§4 of the issue): a record/caller with NO run id keeps the old
 * shape byte for byte — no error, no invented id.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { formatCompletionNotice, formatGroupedNotice } from "../../src/extension/notify.ts";
import { createLegionEventBus } from "../../src/extension/event-bus.ts";
import { legionDbPath, openLegionDb } from "../../src/legion/db.ts";
import { getChildren, getNode, insertNode } from "../../src/legion/nodes.ts";
import { Orchestrator, type OrchestratorLegionContext } from "../../src/runs/orchestrator.ts";
import { initiatorRunIdOf } from "../../src/runs/parent-anchor.ts";
import { RunStore } from "../../src/runs/store.ts";
import type { AgentConfig, RunRecord } from "../../src/shared/types.ts";
import { FakeSupervisor } from "../helpers/fake-supervisor.ts";

// ── fixture: a real run store + ledger, a fake backend ─────────────────────

function recordFixture(): {
	rootDir: string;
	runStore: RunStore;
	rootRunId: string;
	context: OrchestratorLegionContext;
	orchestrator: (supervisor: FakeSupervisor) => Orchestrator;
	child: (name: string) => ReturnType<RunStore["findChild"]>;
	cleanup: () => void;
} {
	const rootDir = mkdtempSync(path.join(tmpdir(), "runid-propagation-"));
	const runStore = new RunStore({ rootDir: path.join(rootDir, ".pi-subagents") });
	const rootRun = runStore.createRun({
		task: "root task",
		cwd: rootDir,
		nodeId: "root",
		maxDepth: 4,
		herdr: { supervisor: "terminal" },
	});
	const dbPath = path.resolve(legionDbPath(runStore.runDir(rootRun.runId)));
	const db = openLegionDb(dbPath);
	insertNode(db, { parentId: null, name: "root", role: "root", runId: rootRun.runId, status: "running" });
	const context: OrchestratorLegionContext = {
		db,
		dbPath,
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
		runStore,
		rootRunId: rootRun.runId,
		context,
		orchestrator: (supervisor) =>
			new Orchestrator({ supervisor, runDir: runStore.runDir(rootRun.runId), cwd: rootDir, maxDepth: 4, legion: context }),
		child: (name) => runStore.findChild(rootRun.runId, name),
		cleanup: () => {
			db.close();
			rmSync(rootDir, { recursive: true, force: true });
		},
	};
}

function workerAgent(): AgentConfig {
	return {
		name: "worker",
		description: "runid propagation test role",
		systemPromptMode: "append",
		inheritProjectContext: false,
		inheritSkills: false,
		kind: "pi",
		systemPrompt: "You are a test worker.",
		source: "user",
		filePath: "/fake/worker.md",
		worktree: false,
	};
}

// ── face 1 + 2: spawn body, run.json (both directions), ledger ─────────────

test("#414: the dispatching run id reaches the spawn body and both run.json directions", async () => {
	const fx = recordFixture();
	try {
		const supervisor = new FakeSupervisor();
		const orchestrator = fx.orchestrator(supervisor);
		await orchestrator.launch({ agent: workerAgent(), task: "do it", name: "worker-0" });

		// Face 1 — the wire request a backend receives. This is the only channel a
		// per-spawn fact can use: production builds ONE supervisor before any run
		// exists, so a constructor value could never name this run.
		assert.equal(supervisor.spawns[0]!.input.runId, fx.rootRunId);

		// Face 2a — the parent's run.json: the child record names its dispatcher.
		const record = fx.child("worker-0");
		assert.ok(record, "the child must be persisted");
		assert.equal(record.parentRunId, fx.rootRunId);

		// Face 2b — the child's OWN run.json: the lineage's last step is the
		// dispatcher's run id, so child → parent needs no second file.
		const childNode = getNode(fx.context.db, "root.worker-0");
		assert.ok(childNode?.runId, "the child ledger row names its own run");
		const childRun = fx.runStore.readRun(childNode!.runId!);
		assert.ok(childRun, "the child's run.json must exist");
		assert.equal(initiatorRunIdOf(childRun!), fx.rootRunId);

		// Reverse lookup, both ways, by runId:
		//   child runId → parent run   (the run.json lineage)
		//   parent runId → child record (the children[] entry)
		const initiator = initiatorRunIdOf(childRun!);
		assert.equal(initiator, fx.rootRunId);
		const parentRun = fx.runStore.readRun(initiator!);
		assert.ok(parentRun);
		assert.ok(
			parentRun.children.some((child) => child.name === "worker-0" && child.parentRunId === fx.rootRunId),
			"the initiator's run.json must list the child it dispatched",
		);

		// The ledger rows say the same thing: child row → its own run; its parent_id
		// → the initiator's row → the initiator's run id.
		assert.equal(getNode(fx.context.db, childNode!.parentId!)!.runId, fx.rootRunId);
		assert.deepEqual(
			getChildren(fx.context.db, "root").map((node) => node.runId),
			[childNode!.runId],
		);
	} finally {
		fx.cleanup();
	}
});

test("#414: the result artifact's id names the initiating run (deliverable attribution)", async () => {
	const fx = recordFixture();
	try {
		const supervisor = new FakeSupervisor();
		const orchestrator = fx.orchestrator(supervisor);
		const handle = await orchestrator.launch({ agent: workerAgent(), task: "do it", name: "worker-0" });
		supervisor.settle(handle.name, { text: "delivered" });
		const collected = await orchestrator.collect(handle.name);

		// The report/artifact identity is `<runId>/<name>/r<round>` — with the
		// DISPATCHING run id, so a later reader can walk it back to this run without
		// trusting the handle.
		assert.equal(collected.artifactId, `${fx.rootRunId}/worker-0/r1`);
		assert.ok(collected.outputFile?.startsWith(path.join(fx.runStore.runDir(fx.rootRunId), "artifacts", "worker-0")));
	} finally {
		fx.cleanup();
	}
});

test("#414: a legacy run.json (no run id anywhere) still reads and yields no initiator", () => {
	const fx = recordFixture();
	try {
		// The shape a pre-#414 build wrote: no `parentRunId`, no lineage step.
		const legacy: RunRecord = {
			schemaVersion: 1,
			runId: "r-legacy-0001",
			task: "legacy task",
			cwd: "/tmp/legacy",
			herdr: {},
			path: [],
			depth: 0,
			maxDepth: 4,
			children: [{
				name: "worker-0",
				sessionFile: "/tmp/legacy/worker-0.jsonl",
				ownerToken: "pane-7",
				state: "retired",
				spawnedAt: "2026-11-01T00:00:00.000Z",
			}],
			budget: { spawned: 1, limit: null, granted: 0 },
			createdAt: "2026-11-01T00:00:00.000Z",
			updatedAt: "2026-11-01T00:00:00.000Z",
		};
		fx.runStore.writeRun(legacy);
		const read = fx.runStore.readRun("r-legacy-0001");
		assert.ok(read, "an old run.json must keep loading");
		assert.equal(read.children[0]!.parentRunId, undefined, "no id is invented for a record that has none");
		assert.equal(initiatorRunIdOf(read), undefined);
	} finally {
		fx.cleanup();
	}
});

test("#414: the lineage rule is the last step, and a root has none", () => {
	assert.equal(initiatorRunIdOf({ path: [{ runId: "r-root" }, { runId: "r-centurion", agent: "centurion" }] }), "r-centurion");
	assert.equal(initiatorRunIdOf({ path: [] }), undefined);
	assert.equal(initiatorRunIdOf({}), undefined);
	assert.equal(initiatorRunIdOf({ path: [{ runId: "   " }] }), undefined, "blank is no fact, never a name");
});

// ── face 3: the completion notice ──────────────────────────────────────────

test("#414 notice: the run id is additive; without one the notice is byte-identical", () => {
	const base = {
		name: "worker-0",
		agent: "worker",
		execution: { status: "success" },
		output: "done the thing",
		sessionFile: "/tmp/worker-0.jsonl",
	} as const;

	const legacy = formatCompletionNotice(base);
	assert.doesNotMatch(legacy.content, /^Run:/m);
	assert.equal("runId" in legacy.details, false, "the pre-#414 rendering has no run-id field at all");

	const withRun = formatCompletionNotice({ ...base, runId: "r-initiator-1" });
	assert.match(withRun.content, /^Run: r-initiator-1$/m);
	assert.equal(withRun.details.runId, "r-initiator-1");
	// Exactly one inserted line: everything else is the legacy body, unchanged.
	assert.equal(withRun.content.replace("Run: r-initiator-1\n", ""), legacy.content);
	const { runId: _propagated, ...rest } = withRun.details;
	assert.deepEqual(rest, legacy.details, "the only details delta is the new field");
});

test("#414 notice: the grouped shape keeps its historic fields and adds runId", () => {
	const entry = {
		name: "worker-0",
		agent: "worker",
		execution: { status: "success" },
		output: "done",
		status: "completed" as const,
	};
	const legacy = formatGroupedNotice({ entries: [entry] });
	assert.equal("runId" in legacy.details, false);
	assert.doesNotMatch(legacy.content, /^Run:/m);

	const grouped = formatGroupedNotice({ runId: "r-initiator-1", entries: [entry] });
	assert.match(grouped.content, /^Run: r-initiator-1$/m);
	assert.equal(grouped.details.runId, "r-initiator-1");
	// Backward compatibility on purpose: `sessionFile` already carried the run id
	// for the grouped shape before #414, and readers depend on it.
	assert.equal(grouped.details.sessionFile, "r-initiator-1");
});
