/**
 * P4a — the READ side of the result ledger
 * (`docs/contracts/result-ledger-v1.md` §3 D3 + D3b + §6 P4a).
 *
 * The fact this file pins is small and sharp: a result the parent RECEIVED through
 * `collect`/`wait` must leave a `consumptions` row whose `read_bytes` equals the
 * artifact's `bytes`, and a call whose text never reached the parent must leave NONE —
 * that asymmetry is the whole reason the claim API (`unclaimUndelivered`) can be deleted
 * in P4c instead of being re-invented.
 *
 * D3b (the ruling this file was rewritten for) moves the write one layer up: the
 * handlers only DECLARE (`details.ledgerReads`), and `settleControlResult` — the same
 * place that runs the abort net — is the only writer. So every test below drives the
 * real two-step shape: `collectChild`/`waitAction`, then the tool layer. A test that
 * skipped the second step would be asserting a fact the shipped code never writes, and
 * a test that settled an `aborted` result would be asserting the exact bug D3b names.
 *
 * Layers, on purpose:
 *
 * - tests 1/2/3/4/5 drive the REAL path: a real `Orchestrator` on a real `RunStore`, a
 *   real `legion.db`, a real artifact row written by the orchestrator's collect, and the
 *   real `collectChild` / `waitAction` / `settleControlResult` from `index.ts` (only the
 *   supervisor and the LLM are fake, as everywhere else);
 * - test 5 drives the finished-cache window through a real `SessionRuntime` and a real
 *   ledger row;
 * - test 6 covers the four "record nothing, throw nothing" conditions of D3.
 *
 * What is NOT asserted here: `notified_at`. It stays NULL in every case (P4a does not
 * touch the notification side), so a `markNotified`-shaped regression in this path shows
 * up as a failed `notifiedAt === null` rather than as a silently delivered notice.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { collectChild, settleControlResult, waitAction } from "../../index.ts";
import {
	createSessionRuntime,
	type CollectSnapshot,
	type SessionRuntime,
} from "../../src/extension/runtime.ts";
import { Orchestrator, type OrchestratorLegionContext } from "../../src/runs/orchestrator.ts";
import { RunStore } from "../../src/runs/store.ts";
import { openLegionDb, type DatabaseSync } from "../../src/legion/db.ts";
import { artifactById, consumptionFor, recordArtifact, undelivered } from "../../src/legion/ledger.ts";
import { insertNode } from "../../src/legion/nodes.ts";
import { createLegionEventBus } from "../../src/extension/event-bus.ts";
import type { AgentConfig } from "../../src/shared/types.ts";
import { FakeSupervisor } from "../helpers/fake-supervisor.ts";

/** Wall-clock bound for every fixture wait: nothing here may hang the suite. */
const BOUND_MS = 5_000;
const CHILD = "worker-0";
const OUTPUT = "the child answer";
/** What the orchestrator writes: the output with exactly one trailing newline (D1b). */
const BODY = `${OUTPUT}\n`;
const INTERRUPTED_REPLY = "interrupted (parent turn ended; children still running)";

type Result = { content?: unknown; details?: unknown };

function textOf(result: Result): string {
	const parts = (result.content ?? []) as Array<{ text?: string }>;
	return parts.map((part) => part.text ?? "").join("\n");
}

/** Bounded pump over a real observable — never a sleep used as synchronisation. */
async function until(pred: () => boolean, label: string, boundMs = BOUND_MS): Promise<void> {
	const deadline = Date.now() + boundMs;
	while (!pred()) {
		if (Date.now() > deadline) throw new Error(`bounded fixture pump expired (${boundMs}ms): ${label}`);
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
}

/** The read-side ledger target the tool layer builds from its own identity (D3). */
function legionOf(db: DatabaseSync): OrchestratorLegionContext {
	return { db, nodeId: "root" } as unknown as OrchestratorLegionContext;
}

/**
 * The tool layer's last step before the parent sees a result: the abort net plus the
 * deferred read-side write (D3b). Nothing in `index.ts` may call `markDelivered` other
 * than this path, so every assertion below settles exactly like production does.
 */
function settle(
	result: Result,
	runtime: SessionRuntime,
	legion: OrchestratorLegionContext | undefined,
	aborted = false,
): Promise<Result> {
	return settleControlResult({
		result: result as Parameters<typeof settleControlResult>[0]["result"],
		runtime,
		...(legion ? { legion } : {}),
		aborted,
	}) as Promise<Result>;
}

/** The deferred ids a handler mounted on its result (`§3 D3b`). */
function declaredReads(result: Result): string[] {
	const ids = (result.details as { ledgerReads?: unknown } | undefined)?.ledgerReads;
	return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : [];
}

/** A full role card: `FakeSupervisor.spawnChild` refuses anything without `kind: "pi"`. */
function agent(name = "worker"): AgentConfig {
	return {
		name,
		description: `${name} role`,
		systemPromptMode: "append",
		inheritProjectContext: true,
		inheritSkills: false,
		kind: "pi",
		systemPrompt: `You are ${name}.`,
		source: "user",
		filePath: `/fake/${name}.md`,
	} as AgentConfig;
}

interface Harness {
	cwd: string;
	runId: string;
	runDir: string;
	store: RunStore;
	db: DatabaseSync;
	supervisor: FakeSupervisor;
	orchestrator: Orchestrator;
	dispose: () => void;
}

/**
 * One root run with one legion identity — the shape `collect`/`wait` run inside.
 *
 * The consumer is `"root"` (D3: a root's id is literally `"root"`), and the ledger row
 * the orchestrator writes carries it as `artifacts.parent_id`, which is what makes the
 * consumption row and the delivery projection agree about the same artifact.
 */
function harness(): Harness {
	const cwd = mkdtempSync(path.join(tmpdir(), "legion-read-marking-"));
	const store = new RunStore({ rootDir: path.join(cwd, ".pi-subagents") });
	const run = store.createRun({
		task: "root task",
		cwd,
		nodeId: "root",
		maxDepth: 4,
		herdr: { supervisor: "rpc" },
	});
	const runDir = store.runDir(run.runId);
	const dbPath = path.join(runDir, "legion.db");
	const db = openLegionDb(dbPath);
	// `reserveNode` needs the consumer to exist.
	insertNode(db, { id: "root", parentId: null, name: "root", role: "root", runId: run.runId, status: "running" });
	const supervisor = new FakeSupervisor();
	const orchestrator = new Orchestrator({
		supervisor,
		runDir,
		cwd,
		legion: { db, dbPath, nodeId: "root", runId: run.runId, runStore: store, eventBus: createLegionEventBus() },
	});
	return {
		cwd,
		runId: run.runId,
		runDir,
		store,
		db,
		supervisor,
		orchestrator,
		dispose: () => {
			db.close();
			rmSync(cwd, { recursive: true, force: true });
		},
	};
}

/** A tracked child whose result comes from the REAL orchestrator's collect. */
function trackCollect(fixture: Harness, sessionFile: string): SessionRuntime {
	const runtime = createSessionRuntime({ sendMessage() {} });
	runtime.track({
		name: CHILD,
		runId: fixture.runId,
		agent: "worker",
		sessionFile,
		timeoutMs: BOUND_MS,
		collect: () => fixture.orchestrator.collect(CHILD),
	});
	return runtime;
}

/**
 * The `collect` context `controlAction` would build, cut down to what `collectChild`
 * reads. It carries NO ledger seam on purpose: since D3b the handler cannot record a
 * read at all — it only names the artifact in `details.ledgerReads`.
 */
function collectFixture(
	fixture: Harness,
	runtime: SessionRuntime,
	orchestrator: Orchestrator,
): Parameters<typeof collectChild>[0] {
	return {
		action: "collect",
		params: { action: "collect", name: CHILD },
		name: CHILD,
		supervisor: fixture.supervisor,
		onBudgetRefused: () => ({ ok: false, message: "no budget" }),
		store: fixture.store,
		cwd: fixture.cwd,
		agents: [agent("worker")],
		allAgents: [agent("worker")],
		found: { runId: fixture.runId },
		orchestrator,
		runtime,
	} as unknown as Parameters<typeof collectChild>[0];
}

function consumptionRows(db: DatabaseSync): Array<{ artifact_id: string; consumer_id: string; read_bytes: number; notified_at: number | null }> {
	return db
		.prepare("SELECT artifact_id, consumer_id, read_bytes, notified_at FROM consumptions ORDER BY artifact_id")
		.all() as Array<{ artifact_id: string; consumer_id: string; read_bytes: number; notified_at: number | null }>;
}

test("P4a: a real collect declares the read, and settling it records the row (D3, D3b)", async () => {
	const fixture = harness();
	let runtime: SessionRuntime | undefined;
	try {
		const handle = await fixture.orchestrator.launch({ agent: agent(), task: "go", name: CHILD, worktree: false });
		fixture.supervisor.settle(handle.name, { text: OUTPUT });
		runtime = trackCollect(fixture, handle.sessionFile);

		const artifactId = `${fixture.runId}/${CHILD}/r1`;
		const result = await collectChild(collectFixture(fixture, runtime, fixture.orchestrator));
		assert.match(textOf(result), new RegExp(OUTPUT), "positive control: the parent got the text");

		const artifact = artifactById(fixture.db, artifactId);
		assert.ok(artifact, "positive control: the collect wrote the artifact row");
		assert.equal(artifact.bytes, Buffer.byteLength(BODY, "utf8"), "bytes == the written body (A1)");
		assert.equal(artifact.parentId, "root", "parent_id is the consumer");

		// D3b: the handler DECLARES, it does not write. This is the assertion that keeps
		// the write out of the handler — it fails the moment `markRead` moves back in.
		assert.deepEqual(declaredReads(result), [artifactId], "details.ledgerReads names the artifact");
		assert.deepEqual(consumptionRows(fixture.db), [], "the handler itself records nothing");

		const settled = await settle(result, runtime, legionOf(fixture.db));
		assert.equal(textOf(settled), textOf(result), "the tool layer never changes the text");
		assert.deepEqual(declaredReads(settled), [artifactId], "the declaration travels through untouched");

		const consumption = consumptionFor(fixture.db, artifactId, "root");
		assert.ok(consumption, "the delivery is recorded once the result is settled");
		assert.equal(consumption.readBytes, artifact.bytes, "全文交付 ⇒ 高水位持平 bytes (D3/D6)");
		assert.notEqual(consumption.readAt, null, "read_at is the moment of the delivery");
		assert.equal(consumption.notifiedAt, null, "P4a is the READ side only — notified_at stays NULL");
		assert.deepEqual(undelivered(fixture.db, "root"), [], "the projection no longer owes this artifact (D4)");
	} finally {
		runtime?.dispose();
		fixture.dispose();
	}
});

test("P4a: a result the abort net replaces is never recorded — no silent loss (D3b)", async () => {
	// The failure D3b exists for: `interruptedControlResult` throws the whole result away
	// and answers the frozen `interrupted …` line, so the parent never sees one byte of
	// the text. Recording the read there would make `undelivered` (D4) skip the artifact
	// and the pushed notice would never come either — a result lost with no trace. The
	// ids are discarded WITH the text: nothing was read, so nothing may be recorded.
	const fixture = harness();
	let runtime: SessionRuntime | undefined;
	try {
		const handle = await fixture.orchestrator.launch({ agent: agent(), task: "go", name: CHILD, worktree: false });
		fixture.supervisor.settle(handle.name, { text: OUTPUT });
		runtime = trackCollect(fixture, handle.sessionFile);

		const artifactId = `${fixture.runId}/${CHILD}/r1`;
		const result = await collectChild(collectFixture(fixture, runtime, fixture.orchestrator));
		assert.deepEqual(declaredReads(result), [artifactId], "positive control: the handler declared the read");

		const replaced = await settle(result, runtime, legionOf(fixture.db), true);
		assert.equal(textOf(replaced), INTERRUPTED_REPLY, "the caller's abort wins and replaces the result");
		assert.ok(artifactById(fixture.db, artifactId), "positive control: the artifact the id named exists");
		assert.deepEqual(consumptionRows(fixture.db), [], "a replaced result records nothing (D3b)");
		assert.equal(consumptionFor(fixture.db, artifactId, "root"), null);
		assert.deepEqual(
			undelivered(fixture.db, "root").map((artifact) => artifact.id),
			[artifactId],
			"and the notice route is still open — the artifact stays in the projection",
		);
	} finally {
		runtime?.dispose();
		fixture.dispose();
	}
});

test("P4a: a collect that bails before delivering declares NOTHING (persistChild throws)", async () => {
	// The bail D3 names explicitly: `collectChild` awaits `persistChild` AFTER the
	// snapshot exists and BEFORE it is rendered, so a store failure means the text
	// reaches nobody. The artifact row is already on disk (the orchestrator's collect
	// wrote it) — which is exactly why "no declaration and no row" here is a real
	// assertion and not a vacuous one: the id the snapshot carried DOES name an artifact.
	const fixture = harness();
	let runtime: SessionRuntime | undefined;
	try {
		const handle = await fixture.orchestrator.launch({ agent: agent(), task: "go", name: CHILD, worktree: false });
		fixture.supervisor.settle(handle.name, { text: OUTPUT });
		runtime = trackCollect(fixture, handle.sessionFile);
		// `childrenSnapshot` runs OUTSIDE `persistChild`'s best-effort try/catch, so this
		// is the store failure that reaches `collectChild` as a throw.
		const failingOrchestrator = {
			cachedCollect: () => undefined,
			childrenSnapshot: () => {
				throw new Error("store unreachable");
			},
		} as unknown as Orchestrator;

		const result = await collectChild(collectFixture(fixture, runtime, failingOrchestrator));
		assert.match(textOf(result), /collect failed/, "the tool call failed, so the snapshot reached nobody");
		assert.equal((result.details as { error?: string }).error, "NOT_FOUND");
		assert.deepEqual(declaredReads(result), [], "a bail declares no read");

		const settled = await settle(result, runtime, legionOf(fixture.db));
		assert.match(textOf(settled), /collect failed/, "settling a failure changes nothing");

		const artifactId = `${fixture.runId}/${CHILD}/r1`;
		assert.ok(artifactById(fixture.db, artifactId), "positive control: the artifact the snapshot named exists");
		assert.deepEqual(consumptionRows(fixture.db), [], "a bail records no read — no rollback API is needed");
	} finally {
		runtime?.dispose();
		fixture.dispose();
	}
});

test("P4a: an already-aborted collect answers `interrupted …` and declares nothing", async () => {
	const fixture = harness();
	let runtime: SessionRuntime | undefined;
	try {
		const handle = await fixture.orchestrator.launch({ agent: agent(), task: "go", name: CHILD, worktree: false });
		fixture.supervisor.settle(handle.name, { text: OUTPUT });
		runtime = trackCollect(fixture, handle.sessionFile);
		const controller = new AbortController();
		controller.abort();
		const result = await collectChild(collectFixture(fixture, runtime, fixture.orchestrator), controller.signal);
		assert.equal(textOf(result), INTERRUPTED_REPLY);
		assert.deepEqual(declaredReads(result), [], "the parent turn's bail declares no read");
		assert.deepEqual(consumptionRows(fixture.db), [], "the parent turn's bail is not a delivery");
		assert.equal(fixture.orchestrator.cachedCollect(CHILD)?.artifactId, undefined, "no artifact was written either");
	} finally {
		runtime?.dispose();
		fixture.dispose();
	}
});

test("P4a: a wait that hits the finished cache records the read once, and a second wait cannot lower it", async () => {
	const db = openLegionDb(":memory:");
	const runtime = createSessionRuntime({ sendMessage() {} });
	const cwd = mkdtempSync(path.join(tmpdir(), "legion-read-marking-wait-"));
	const store = new RunStore({ rootDir: path.join(cwd, ".pi-subagents") });
	const artifactId = "r-1/done/r1";
	try {
		const bytes = Buffer.byteLength("cached output\n", "utf8");
		recordArtifact(db, {
			id: artifactId,
			parentId: "root",
			nodeId: "r-1.done",
			name: "done",
			round: 1,
			path: path.join(cwd, "r1.md"),
			bytes,
			createdAt: Date.now(),
		});
		runtime.track({
			name: "done",
			runId: "r-1",
			agent: "worker",
			sessionFile: "/tmp/done.jsonl",
			timeoutMs: 1_000,
			collect: async () => ({
				execution: { status: "success" },
				output: "cached output",
				acceptance: { status: "accepted", level: "attested" },
				artifactId,
			}) as CollectSnapshot,
		});
		runtime.watch("done");
		await until(() => runtime.activeJobs().length === 0, "the watch settled the child");

		const call = async () => {
			const result = await waitAction({
				params: { action: "wait", name: "done" },
				runtime,
				agents: [agent("worker")],
				store,
				cwd,
			});
			assert.deepEqual(declaredReads(result), [artifactId], "the wait declares the snapshot it handed over");
			return result;
		};

		const pending = await call();
		assert.deepEqual(consumptionRows(db), [], "the wait itself writes nothing — settling does (D3b)");
		const first = await settle(pending, runtime, legionOf(db));
		assert.match(textOf(first), /cached output/, "positive control: the finished-cache probe delivered the text");
		const after = consumptionFor(db, artifactId, "root");
		assert.ok(after, "the finished-cache path records too (§6 P4a)");
		assert.equal(after.readBytes, bytes);
		assert.equal(after.notifiedAt, null);

		const second = await settle(await call(), runtime, legionOf(db));
		assert.match(textOf(second), /cached output/, "the cache is still readable");
		const again = consumptionFor(db, artifactId, "root");
		assert.equal(again?.readBytes, bytes, "a re-wait cannot lower the high-water mark (A2)");
		assert.equal(consumptionRows(db).length, 1, "still ONE row for (artifact, consumer)");
		assert.equal(consumptionRows(db)[0]?.notified_at, null, "reading never writes notified_at");
	} finally {
		runtime.dispose();
		db.close();
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("P4a: no seam, no artifactId, an unknown id and a broken db all record nothing and change no answer", async () => {
	const db = openLegionDb(":memory:");
	const runtime = createSessionRuntime({ sendMessage() {} });
	const cwd = mkdtempSync(path.join(tmpdir(), "legion-read-marking-none-"));
	const store = new RunStore({ rootDir: path.join(cwd, ".pi-subagents") });
	let dbOpen = true;
	try {
		const withId = (artifactId?: string) => async () =>
			({
				execution: { status: "success" },
				output: "out",
				acceptance: { status: "accepted", level: "attested" },
				...(artifactId === undefined ? {} : { artifactId }),
			}) as CollectSnapshot;

		const cases: Array<{ label: string; name: string; legion: () => OrchestratorLegionContext | undefined; snapshot: () => Promise<CollectSnapshot> }> = [
			// No legion context: a plain session (and every unit fixture that builds a bare
			// wait input) must keep byte-identical behaviour.
			{ label: "no seam", name: "plain", legion: () => undefined, snapshot: withId("r-1/plain/r1") },
			// An empty turn / a failed artifact write / an older result: nothing to key on.
			{ label: "no artifactId", name: "noid", legion: () => legionOf(db), snapshot: withId(undefined) },
			// The id names no row: `output.length` is characters, not bytes — never invented.
			{ label: "unknown id", name: "ghost", legion: () => legionOf(db), snapshot: withId("r-1/ghost/r1") },
		];
		for (const entry of cases) {
			const settleSnapshot = entry.snapshot();
			runtime.track({
				name: entry.name,
				runId: "r-1",
				agent: "worker",
				sessionFile: `/tmp/${entry.name}.jsonl`,
				timeoutMs: 1_000,
				collect: () => settleSnapshot,
			});
			runtime.watch(entry.name);
			await until(() => runtime.activeJobs().length === 0, `${entry.label} settled`);
			const result = await waitAction({
				params: { action: "wait", name: entry.name },
				runtime,
				agents: [agent("worker")],
				store,
				cwd,
			});
			assert.match(textOf(result), /── \w/, `${entry.label}: the wait still answers normally`);
			assert.doesNotMatch(textOf(result), /unknown child/, `${entry.label}: no invented error`);
			const settled = await settle(result, runtime, entry.legion());
			assert.equal(textOf(settled), textOf(result), `${entry.label}: the answer is unchanged`);
		}
		assert.deepEqual(consumptionRows(db), [], "nothing was recorded, and nothing threw");

		// D1e: a ledger that cannot be written is a diagnostic failure, never the tool's
		// answer. Closing the connection makes every statement throw.
		db.close();
		dbOpen = false;
		const settleSnapshot = withId("r-1/broken/r1")();
		runtime.track({
			name: "broken",
			runId: "r-1",
			agent: "worker",
			sessionFile: "/tmp/broken.jsonl",
			timeoutMs: 1_000,
			collect: () => settleSnapshot,
		});
		runtime.watch("broken");
		await until(() => runtime.activeJobs().length === 0, "the broken-db child settled");
		const result = await waitAction({
			params: { action: "wait", name: "broken" },
			runtime,
			agents: [agent("worker")],
			store,
			cwd,
		});
		const settled = await settle(result, runtime, legionOf(db));
		assert.match(textOf(settled), /── broken ──[\s\S]*out/, "the answer is the ordinary render, byte-identical with or without a working ledger");
	} finally {
		runtime.dispose();
		if (dbOpen) db.close();
		rmSync(cwd, { recursive: true, force: true });
	}
});
