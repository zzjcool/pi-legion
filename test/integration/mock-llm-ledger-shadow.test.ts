/**
 * P3 acceptance (`docs/contracts/result-ledger-v1.md` §3 D11 + §6 P3): a real
 * multi-child run must produce ZERO `ledger-shadow mismatch` lines on stderr.
 *
 * What is REAL here: the mock LLM server (both children's text comes from it), a
 * real `legion.db` with real `artifacts`/`consumptions` rows, the real artifact
 * write path (`writeArtifactAtomic` → `recordArtifact`, the same two calls the
 * orchestrator's collect makes), and the real delivery seam —
 * `createSessionRuntime` → watch → join → run-boundary outbox → `deliverBatch`.
 *
 * What is NOT: no `pi` process is spawned. Children are in-process `collect`
 * callables, so the extension's own stderr is this process's stderr — which the
 * test captures. The alternative (spawning `pi --print` per child and plumbing a
 * mock backend into each) would test the host CLI more than the shadow, and the
 * shadow's inputs are all inside this process. The tradeoff is stated in the P3
 * delivery report as well.
 *
 * Scenario — two children of one run, one per delivery route:
 *
 * ```
 * scout-consume : the parent's `collect`/`wait` takes it   → claim open? no: claimed
 * scout-notify  : nobody reads it                          → claim open: true
 * ```
 *
 * The collected child's entry is enqueued BEFORE the parent reads it (the parent
 * run is still live), which is exactly the W1/W2 window the claim set exists for:
 * at flush time the old model must suppress that entry, and the ledger must agree
 * it is settled. That agreement is what this test measures.
 *
 * P3 boundary, stated on purpose: nothing in the shipped code writes `read_bytes`
 * or `notified_at` yet — the tool-layer `markRead` is P5's (D3) and the flush-side
 * `markNotified` is P4's (D4). So the test performs the read-side write the P5
 * tool layer will perform, and asserts the *notification*-side artifact is still
 * `undelivered` afterwards (P4's job), instead of pretending P3 already records it.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import {
	MOCK_API_KEY,
	startMockLlm,
	type MockScript,
} from "../mock-llm/index.ts";
import { createSessionRuntime, type CollectSnapshot } from "../../src/extension/runtime.ts";
import {
	artifactNameSegment,
	artifactPathFor,
	writeArtifactAtomic,
} from "../../src/runs/artifacts.ts";
import { openLegionDb } from "../../src/legion/db.ts";
import { markRead, recordArtifact, undelivered } from "../../src/legion/ledger.ts";

const RUN_ID = "run-shadow";
/** The consumer the artifacts belong to — `parent_id` of the child rows (D2). */
const CONSUMER = "root";
const COLLECTED = "scout-consume";
const NOTIFIED = "scout-notify";
const NOW = 1_700_000_000_000;

function shadowScript(): MockScript {
	return {
		models: [{ id: "flash", name: "Mock Flash" }],
		rules: [
			{
				name: "consume",
				when: { promptIncludes: "CONSUME" },
				then: { type: "text", content: "COLLECTED_OUTPUT" },
			},
			{
				name: "notify",
				when: { promptIncludes: "NOTIFY" },
				then: { type: "text", content: "NOTIFIED_OUTPUT" },
			},
			{ name: "default", then: { type: "text", content: "MOCK_OK" } },
		],
	};
}

/** One child turn against the mock backend; the text IS the child's output. */
async function chat(baseUrl: string, prompt: string): Promise<string> {
	const response = await fetch(`${baseUrl}/chat/completions`, {
		method: "POST",
		headers: { "Content-Type": "application/json", Authorization: `Bearer ${MOCK_API_KEY}` },
		body: JSON.stringify({ model: "flash", stream: false, messages: [{ role: "user", content: prompt }] }),
	});
	const raw = await response.text();
	assert.equal(response.ok, true, raw);
	const body = JSON.parse(raw) as { choices: Array<{ message: { content?: string | null } }> };
	const text = body.choices[0]?.message.content;
	assert.equal(typeof text, "string", "the mock must answer with text");
	return text!;
}

/** Only OUR lines: node's SQLite ExperimentalWarning also lands on stderr. */
function shadowLines(stderr: readonly string[]): string[] {
	return stderr.join("").split("\n").filter((line) => line.includes("ledger-shadow"));
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
	const start = Date.now();
	while (!predicate()) {
		if (Date.now() - start > 2_000) throw new Error(`timeout: ${label}`);
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

test("P3 e2e: a two-child run produces no ledger-shadow mismatch — one route collected, one notified", async () => {
	const runDir = mkdtempSync(path.join(tmpdir(), "legion-shadow-"));
	const mock = await startMockLlm({ scenario: "script", script: shadowScript(), port: 0 });
	const db = openLegionDb(path.join(runDir, "legion.db"));
	const stderr: string[] = [];
	const messages: Array<{ content: string }> = [];
	const previousFlag = process.env.PI_LEGION_LEDGER_SHADOW;
	const originalWrite = process.stderr.write;
	process.env.PI_LEGION_LEDGER_SHADOW = "1";
	process.stderr.write = ((chunk: unknown) => {
		stderr.push(String(chunk));
		return true;
	}) as typeof process.stderr.write;
	const runtime = createSessionRuntime({
		sendMessage(message) {
			messages.push(message as { content: string });
		},
		// D11: the ledger handle the runtime compares against, injected the way the
		// host will wire it (the runtime never opens a second connection itself).
		getLedgerShadowFacts: () => ({ db, consumerId: CONSUMER }),
	});
	try {
		// ── the two children's real outputs, from the mock backend ──────────────
		const collectedText = await chat(mock.baseUrl, "CONSUME: finish the collected task");
		const notifiedText = await chat(mock.baseUrl, "NOTIFY: finish the notified task");
		assert.notEqual(collectedText, notifiedText, "two children, two different results");

		// ── their artifacts, written and recorded exactly like a collect does ────
		const record = (name: string, text: string) => {
			const file = artifactPathFor(runDir, name, 1);
			const bytes = writeArtifactAtomic(file, `${text.trim()}\n`);
			const id = `${RUN_ID}/${artifactNameSegment(name)}/r1`;
			recordArtifact(db, {
				id,
				parentId: CONSUMER,
				nodeId: `${CONSUMER}.${name}`,
				name,
				round: 1,
				path: path.resolve(file),
				bytes,
				createdAt: NOW,
			});
			return { id, bytes, file, text };
		};
		const collected = record(COLLECTED, collectedText);
		const notified = record(NOTIFIED, notifiedText);

		const snapshotOf = (artifact: { id: string; file: string; text: string }): CollectSnapshot => ({
			execution: { status: "success" },
			output: artifact.text,
			outputFile: artifact.file,
			artifactId: artifact.id,
			acceptance: { status: "accepted", level: "attested" },
		});

		// ── one run, two children, notices HELD (the parent run is live) ─────────
		runtime.setJoinConfig({ mode: "each", flushMs: 10_000 });
		runtime.notifyParentRunStart();
		runtime.track({
			name: COLLECTED,
			runId: RUN_ID,
			agent: "scout",
			sessionFile: path.join(runDir, `${COLLECTED}.jsonl`),
			timeoutMs: 1_000,
			collect: async () => snapshotOf(collected),
		});
		runtime.track({
			name: NOTIFIED,
			runId: RUN_ID,
			agent: "scout",
			sessionFile: path.join(runDir, `${NOTIFIED}.jsonl`),
			timeoutMs: 1_000,
			collect: async () => snapshotOf(notified),
		});
		runtime.watch(COLLECTED);
		runtime.watch(NOTIFIED);
		await waitFor(() => runtime.noticeQueueStats().pending === 2, "both notices are held");
		assert.equal(messages.length, 0, "a live run sends nothing (D1)");

		// ── the parent reads the first child through the TOOL route ──────────────
		// The artifact id has to survive that whole path (collect → snapshot → cache
		// → wait); if it did not, P5 could never mark anything read.
		const waited = await runtime.wait([COLLECTED], { timeoutMs: 5_000 });
		assert.equal(waited[0]?.snapshot?.artifactId, collected.id, "the artifact id survives to the tool result");
		// P5's read-side write (D3), performed here because P3 ships no consumption
		// writer: reading to EOF is what makes the ledger agree that this result is
		// settled. Without it the ledger would still project the artifact and the
		// shadow would report — correctly, for P3's state — a mismatch.
		markRead(db, {
			artifactId: collected.id,
			consumerId: CONSUMER,
			bytesRead: collected.bytes,
			at: NOW + 1,
		});

		// ── the boundary: one held notice survives, one was read away ────────────
		runtime.notifyParentSettled();
		await waitFor(() => messages.length === 1, "the notification child's notice arrives");
		assert.equal(messages.length, 1, "exactly one notice — the collected child is not re-announced");
		assert.match(messages[0]!.content, /NOTIFIED_OUTPUT/);
		assert.doesNotMatch(messages[0]!.content, /COLLECTED_OUTPUT/);

		// ── THE ACCEPTANCE: the two models never disagreed on this run ───────────
		assert.deepEqual(
			shadowLines(stderr),
			[],
			`a multi-child run must not log a shadow mismatch: ${JSON.stringify(stderr)}`,
		);

		// ── the ledger's own view, so the assertion above is not vacuous ─────────
		const projected = undelivered(db, CONSUMER).map((artifact) => artifact.id);
		assert.equal(
			projected.includes(collected.id),
			false,
			"the collected artifact was read to EOF: the projection no longer owes it",
		);
		assert.equal(
			projected.includes(notified.id),
			true,
			"P3 records no `notified_at` yet (that is P4) — the delivered artifact is still projected",
		);
		assert.ok(mock.requestCount() >= 2, "both children's text came from the mock backend");
	} finally {
		runtime.dispose();
		db.close();
		process.stderr.write = originalWrite;
		if (previousFlag === undefined) delete process.env.PI_LEGION_LEDGER_SHADOW;
		else process.env.PI_LEGION_LEDGER_SHADOW = previousFlag;
		await mock.close();
		rmSync(runDir, { recursive: true, force: true });
	}
});
