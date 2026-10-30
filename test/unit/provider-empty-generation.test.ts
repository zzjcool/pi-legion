/**
 * #316 — a provider that terminates the stream with no content
 * (`finish_reason: error` behind an HTTP 200) must not cost a child its work.
 *
 * Contract: `docs/contracts/provider-empty-generation-retry-v1.md`.
 *
 * This file pins the two layers that own their own verdict:
 *
 *  D1 — `isEmptyGeneration` and the `errorKind: "provider-empty-generation"` tag
 *       `deriveOutcome` puts on a `failed` outcome (and deliberately does NOT
 *       put on `aborted`, which must never be retried).
 *  D3 — `responseId` pass-through on the assistant record, and `errorKind` on
 *       the `node_failed` event `recordSettled` writes.
 *
 * D2 (the bounded retry itself) lives in `collect()` and is pinned end-to-end in
 * `test/integration/orchestrator.test.ts`, where a real `Orchestrator` drives it.
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
import { Orchestrator } from "../../src/runs/orchestrator.ts";
import { RunStore } from "../../src/runs/store.ts";
import { deriveOutcome, isEmptyGeneration, parseSessionText } from "../../src/shared/session.ts";
import type { AgentConfig } from "../../src/shared/types.ts";
import { FakeSupervisor, type FakeTurn } from "../helpers/fake-supervisor.ts";
import { assistantMsg, userMsg } from "../helpers/fixtures.ts";

const parseLines = (...lines: string[]) => parseSessionText(lines.filter(Boolean).join("\n"));

/** The exact message pi writes for an in-band provider stream failure (#316). */
const EMPTY_GENERATION_MESSAGE = "Provider finish_reason: error";

function agent(overrides: Partial<AgentConfig> = {}): AgentConfig {
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
		...overrides,
	};
}

// ── D1: the predicate ────────────────────────────────────────────────────────

test("#316 D1: an error turn with no text and no tool call is an empty generation", () => {
	// The measured production shape: stopReason error, nothing generated at all.
	// `usage.input: 0` is part of the report but is NOT a predicate input — it is
	// display-only, so it must not be able to change the answer either way.
	const measured = parseLines(
		userMsg("do the work"),
		assistantMsg({
			stopReason: "error",
			errorMessage: EMPTY_GENERATION_MESSAGE,
			usage: { input: 0, output: 2 },
		}),
	);
	assert.equal(isEmptyGeneration(measured), true);
	assert.equal(isEmptyGeneration(parseLines(userMsg("go"), assistantMsg({ stopReason: "error", text: "" }))), true, "an explicit empty string is still empty");
	assert.equal(isEmptyGeneration(parseLines(userMsg("go"), assistantMsg({ stopReason: "error", text: "   \n\t " }))), true, "whitespace is not output");
});

test("#316 D1: a turn that produced text, a tool call, another stop reason, or no assistant is not an empty generation", () => {
	const withText = parseLines(userMsg("go"), assistantMsg({ stopReason: "error", text: "partial work", errorMessage: EMPTY_GENERATION_MESSAGE }));
	assert.equal(isEmptyGeneration(withText), false, "generated text is work, whatever the stop reason says");

	const withTool = parseLines(userMsg("go"), assistantMsg({ stopReason: "error", tools: ["bash"], errorMessage: EMPTY_GENERATION_MESSAGE }));
	assert.equal(withTool.turns[0]?.assistants[0]?.text, null);
	assert.equal(isEmptyGeneration(withTool), false, "a requested tool call is output");

	const cleanStop = parseLines(userMsg("go"), assistantMsg({ stopReason: "stop", text: "" }));
	assert.equal(isEmptyGeneration(cleanStop), false, "only `error` is this failure class");

	assert.equal(isEmptyGeneration(parseLines()), false, "no turns at all");
	assert.equal(isEmptyGeneration(parseLines(userMsg("go"))), false, "a turn with no assistant message yet");
});

test("#316 D1: deriveOutcome tags the empty generation as failed with an errorKind", () => {
	const outcome = deriveOutcome(parseLines(userMsg("do the work"), assistantMsg({ stopReason: "error", errorMessage: EMPTY_GENERATION_MESSAGE })));
	assert.equal(outcome.status, "failed");
	assert.equal(outcome.errorKind, "provider-empty-generation");
	assert.equal(outcome.errorMessage, EMPTY_GENERATION_MESSAGE, "the provider's own message is still preserved");
});

test("#316 D1: a failure that produced output carries no errorKind", () => {
	const outcome = deriveOutcome(parseLines(userMsg("do the work"), assistantMsg({ stopReason: "error", text: "half a report", errorMessage: "provider failure" })));
	assert.equal(outcome.status, "failed");
	assert.equal(outcome.errorKind, undefined);
});

test("#316 D1: an aborted empty turn is never tagged for retry", () => {
	// Same empty shape, but the turn was cancelled rather than lost to a provider
	// fault: `aborted` must stay untagged or `collect()` would re-prompt a child
	// the parent just interrupted.
	const outcome = deriveOutcome(parseLines(userMsg("do the work"), assistantMsg({ stopReason: "error", errorMessage: "This operation was aborted" })));
	assert.equal(outcome.status, "aborted");
	assert.equal(outcome.errorKind, undefined);
});

// ── D3: observability ────────────────────────────────────────────────────────

test("#316 D3: the upstream responseId is carried through to the assistant record", () => {
	const parsed = parseLines(
		userMsg("do the work"),
		assistantMsg({ stopReason: "error", errorMessage: EMPTY_GENERATION_MESSAGE, responseId: "resp-abc123" }),
	);
	assert.equal(parsed.turns[0]?.assistants[0]?.responseId, "resp-abc123");
	// A message that carries none must not invent one (a fabricated id would be
	// worse than no id when someone is tracing a failure).
	const bare = parseLines(userMsg("do the work"), assistantMsg({ stopReason: "stop", text: "done" }));
	assert.equal("responseId" in (bare.turns[0]?.assistants[0] ?? {}), false);
});

// ── D3: the ledger event ─────────────────────────────────────────────────────

/** A rooted legion ledger plus the run store a launch needs. */
function legionFixture() {
	const rootDir = mkdtempSync(path.join(tmpdir(), "empty-gen-"));
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

/** Answer the next `prompt` the way a provider would: settle the turn it starts. */
function settleOnPrompt(supervisor: FakeSupervisor, turn: FakeTurn): void {
	const original = supervisor.prompt.bind(supervisor);
	supervisor.prompt = async (name: string, text: string) => {
		await original(name, text);
		supervisor.settle(name, turn);
	};
}

test("#316 D3: recordSettled puts errorKind on the node_failed event, once", async () => {
	const fx = legionFixture();
	const supervisor = new FakeSupervisor({ immediateTimeout: false });
	const orchestrator = new Orchestrator({
		supervisor,
		runDir: fx.runStore.runDir(fx.rootRun.runId),
		cwd: fx.rootDir,
		maxDepth: 4,
		legion: fx.context,
	});
	const emptyTurn: FakeTurn = { text: "", stopReason: "error", errorMessage: EMPTY_GENERATION_MESSAGE };
	try {
		const handle = await orchestrator.launch({ agent: agent(), task: "the provider will drop this", name: "worker-0", worktree: false });
		// Both turns fail the same way, so this is the "retried once and still
		// failed" terminal case: exactly one settle, one event.
		settleOnPrompt(supervisor, emptyTurn);
		supervisor.settle(handle.name, emptyTurn);
		const collected = await orchestrator.collect(handle.name, { timeoutMs: 5_000 });

		assert.equal(collected.execution.status, "failed");
		assert.equal(getNode(fx.db, "root.worker-0")?.status, "failed");
		const failed = readEventsAfter(fx.db, 0).filter((event) => event.type === "node_failed");
		assert.equal(failed.length, 1, "a retried turn is recorded once, not once per attempt");
		const data = (failed[0]?.data ?? null) as { execution?: string; reason?: string; errorKind?: string } | null;
		assert.equal(data?.execution, "failed");
		assert.equal(data?.errorKind, "provider-empty-generation");
		assert.match(data?.reason ?? "", /retried once/, "the reason still explains the failure");
		assert.deepEqual(
			Object.keys(data ?? {}).sort(),
			["errorKind", "execution", "reason"],
			"the existing {execution, reason} pair is kept and exactly one field is added",
		);
	} finally {
		fx.cleanup();
	}
});
