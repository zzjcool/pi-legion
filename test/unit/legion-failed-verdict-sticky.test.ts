/**
 * #372 m2: a supervisor VERDICT is not a pause — the drain must not launder it.
 *
 * The all-children-failed safety net can fail a team while its lead is still
 * thinking (`LegionPostman.failTeamIfAllChildrenFailed`, pinned in
 * `legion-team-failed-notice.test.ts`). The lead then finishes its turn normally,
 * the parent drains it, and `recordSettled` — which deliberately derives the
 * status from the session without asking the row, so a genuine shutdown-drain
 * completion can improve on a pause (#374 §3) — wrote `settled` over `failed`.
 *
 * That left the ledger contradicting itself (a `node_failed` event on a row that
 * reads `settled`) and flipped `isTerminalNode` back to false: a team the
 * supervisor had already buried became resumable again.
 *
 * The verdict is written here with the SAME two writes and the SAME reason
 * constant the safety net uses, because the launch is a worker: dispatching a
 * real centurion forces rpc plus a provisioned worktree, which is orthogonal to
 * the guard under test. The verdict's own production path is pinned in
 * `legion-team-failed-notice.test.ts`.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { createLegionEventBus } from "../../src/extension/event-bus.ts";
import { openLegionDb } from "../../src/legion/db.ts";
import { appendEvent, readEventsAfter } from "../../src/legion/events.ts";
import { ALL_CHILDREN_FAILED_REASON } from "../../src/legion/interrupt.ts";
import { getNode, insertNode, isTerminalNode, updateNode } from "../../src/legion/nodes.ts";
import { Orchestrator } from "../../src/runs/orchestrator.ts";
import { RunStore } from "../../src/runs/store.ts";
import type { AgentConfig } from "../../src/shared/types.ts";
import { FakeSupervisor } from "../helpers/fake-supervisor.ts";

function agent(): AgentConfig {
	return {
		name: "worker",
		description: "worker test role",
		systemPromptMode: "append",
		inheritProjectContext: true,
		inheritSkills: false,
		kind: "pi",
		systemPrompt: "You are worker.",
		source: "user",
		filePath: "/fake/worker.md",
	};
}

/** A rooted legion ledger plus the run store a launch needs. */
function fixture() {
	const rootDir = mkdtempSync(path.join(tmpdir(), "legion-372-verdict-"));
	const runStore = new RunStore({ rootDir: path.join(rootDir, ".pi-subagents") });
	const rootRun = runStore.createRun({ task: "root task", cwd: rootDir, nodeId: "root", maxDepth: 4, herdr: { supervisor: "inprocess" } });
	const db = openLegionDb(":memory:");
	insertNode(db, { parentId: null, name: "root", role: "root", runId: rootRun.runId, status: "running" });
	return {
		rootDir,
		runStore,
		rootRun,
		db,
		context: {
			db,
			dbPath: path.join(rootDir, "legion.db"),
			nodeId: "root",
			parentNodeId: null,
			parentRunId: null,
			runId: rootRun.runId,
			runStore,
			settings: { maxDepth: 4, maxChildrenPerNode: 8, maxActiveNodes: 30 },
			eventBus: createLegionEventBus(),
		},
		cleanup() {
			db.close();
			rmSync(rootDir, { recursive: true, force: true });
		},
	};
}

test("#372 m2: a supervisor verdict survives a later successful drain (status stays `failed`)", async () => {
	const fx = fixture();
	const supervisor = new FakeSupervisor({ immediateTimeout: false });
	const orchestrator = new Orchestrator({
		supervisor,
		runDir: fx.runStore.runDir(fx.rootRun.runId),
		cwd: fx.rootDir,
		maxDepth: 4,
		legion: fx.context,
	});
	try {
		const { child } = await orchestrator.launch({ agent: agent(), task: "own the slice", name: "w0", worktree: false });
		const nodeId = child.nodeId;
		assert.equal(nodeId, "root.w0");

		// The safety net's two writes, verbatim (status first, then the event that
		// says who decided — see `failTeamIfAllChildrenFailed`).
		updateNode(fx.db, nodeId, { status: "failed" }, () => 100);
		appendEvent(fx.db, nodeId, "node_failed", { execution: "failed", reason: ALL_CHILDREN_FAILED_REASON }, { now: () => 100 });

		// …and now the child's own turn ends SUCCESSFULLY, which is the drain that
		// used to overwrite the verdict.
		supervisor.settle("w0", { text: "all done", stopReason: "stop" });
		const collected = await orchestrator.collect("w0", { timeoutMs: 5_000 });
		assert.equal(collected.execution.status, "success", "the turn really did finish successfully");

		const row = getNode(fx.db, nodeId);
		assert.equal(row?.status, "failed", "the verdict stands: a completed turn does not un-fail a team");
		assert.equal(isTerminalNode(row!), true, "…so it is still terminal, i.e. not silently resumable again");
		const events = readEventsAfter(fx.db, 0);
		assert.equal(events.filter((event) => event.type === "node_failed").length, 1, "exactly one verdict, no second one");
		assert.equal(events.filter((event) => event.type === "node_settled").length, 0, "and no fake completion next to it");
	} finally {
		fx.cleanup();
	}
});

test("#372 m2 control: an ordinary drain still settles a node that has NO supervisor verdict", async () => {
	// The guard must not freeze every drain: without a verdict, a successful turn
	// still ends `settled` — the pre-existing behaviour, byte for byte.
	const fx = fixture();
	const supervisor = new FakeSupervisor({ immediateTimeout: false });
	const orchestrator = new Orchestrator({
		supervisor,
		runDir: fx.runStore.runDir(fx.rootRun.runId),
		cwd: fx.rootDir,
		maxDepth: 4,
		legion: fx.context,
	});
	try {
		const { child } = await orchestrator.launch({ agent: agent(), task: "own the other slice", name: "w1", worktree: false });
		supervisor.settle("w1", { text: "all done", stopReason: "stop" });
		await orchestrator.collect("w1", { timeoutMs: 5_000 });

		assert.equal(getNode(fx.db, child.nodeId!)?.status, "settled", "no verdict ⇒ the drain writes `settled` as always");
		assert.equal(readEventsAfter(fx.db, 0).filter((event) => event.type === "node_settled").length, 1);
	} finally {
		fx.cleanup();
	}
});
