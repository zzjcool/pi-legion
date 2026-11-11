/**
 * P5a — D5: a generic `read` of an artifact body IS consumption
 * (`docs/contracts/result-ledger-v1.md` §3 D5 + §6 P5a).
 *
 * The window this closes is W5: the completion notice tells the parent where the body
 * is, a model that takes that advice calls the ordinary `read` tool, and no ledger-aware
 * path used to see it — so the artifact stayed `undelivered` (D4) and the same result
 * arrived twice. The fix is one hook on the `tool_result` event, keyed by a path → id
 * parse of the SAME shape the writer uses (`artifactIdFromPath` lives beside
 * `artifactPathFor`, so there is exactly one regex for the two directions).
 *
 * The two facts that must not blur together:
 *
 * - **D6 (user ruling)**: only a read that reached EOF settles the artifact. `offset`
 *   and `limit` are the read tool's paging arguments, so their PRESENCE means "a page";
 *   `read_bytes` must not move, and the projection must keep owing the notice.
 * - **D5's direction**: a missing/unknown shape records NOTHING (a redundant notice is
 *   cheap, a silently dropped result is not). Every "no" case below therefore asserts
 *   both halves: no `consumptions` row, and the artifact is still in `undelivered`.
 *
 * Layers, on purpose: tests 1-6 drive the exported hook directly (it is the whole
 * decision), and the last test drives the REAL `tool_result` handler registered by
 * `index.ts` against a real `legion.db` and a real adopted identity — a hook the handler
 * never calls would still pass every unit test above, so the wiring needs its own
 * positive assertion.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { initTheme } from "@earendil-works/pi-coding-agent";

import piLegion, { recordArtifactReadFromToolResult, type ArtifactReadHookIdentity } from "../../index.ts";
import { artifactIdFromPath, artifactPathFor } from "../../src/runs/artifacts.ts";
import { openLegionDb, type DatabaseSync } from "../../src/legion/db.ts";
import { consumptionFor, recordArtifact, undelivered } from "../../src/legion/ledger.ts";
import { insertNode } from "../../src/legion/nodes.ts";
import { RunStore } from "../../src/runs/store.ts";
import { FakeSupervisor } from "../helpers/fake-supervisor.ts";

initTheme("dark");

const CONSUMER = "root";
const RUN_ID = "r-hook";
const BODY = "the child answer\n";

interface Fixture {
	root: string;
	runDir: string;
	db: DatabaseSync;
	identity: ArtifactReadHookIdentity;
	dispose: () => void;
}

function fixture(): Fixture {
	const root = mkdtempSync(path.join(tmpdir(), "legion-read-hook-"));
	const runDir = path.join(root, ".pi-subagents", "runs", RUN_ID);
	mkdirSync(runDir, { recursive: true });
	const db = openLegionDb(":memory:");
	return {
		root,
		runDir,
		db,
		identity: { db, nodeId: CONSUMER, runId: RUN_ID, runDir },
		dispose: () => {
			db.close();
			rmSync(root, { recursive: true, force: true });
		},
	};
}

/**
 * One artifact exactly as the orchestrator writes it: the body via `artifactPathFor`, the
 * row via `recordArtifact`, and the id parsed back out of the PATH — so a parser that
 * disagrees with the writer fails here, not in production.
 */
function writeArtifact(
	fixture: Fixture,
	name: string,
	round: number,
	body = BODY,
): { id: string; file: string; bytes: number } {
	const file = artifactPathFor(fixture.runDir, name, round);
	mkdirSync(path.dirname(file), { recursive: true });
	writeFileSync(file, body, "utf8");
	const bytes = Buffer.byteLength(body, "utf8");
	const id = artifactIdFromPath(file, fixture.runDir, RUN_ID);
	assert.ok(id, "positive control: the writer's own path parses back into an artifact id");
	recordArtifact(fixture.db, {
		id,
		parentId: CONSUMER,
		nodeId: `${RUN_ID}.${name}`,
		name,
		round,
		path: path.resolve(file),
		bytes,
		createdAt: Date.now(),
	});
	return { id, file, bytes };
}

/** The exact event shape the host hands a `tool_result` handler (types.d.ts). */
function readEvent(file: string, input: Record<string, unknown> = {}, extra: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		type: "tool_result",
		toolName: "read",
		input: { path: file, ...input },
		content: [{ type: "text", text: BODY }],
		isError: false,
		...extra,
	};
}

function owedIds(db: DatabaseSync): string[] {
	return undelivered(db, CONSUMER).map((artifact) => artifact.id);
}

test("D5: a generic `read` with no offset/limit records the whole body and settles the notice", () => {
	const f = fixture();
	try {
		const artifact = writeArtifact(f, "worker-0", 1);
		assert.deepEqual(owedIds(f.db), [artifact.id], "positive control: the artifact starts out owed");

		const recorded = recordArtifactReadFromToolResult({ event: readEvent(artifact.file), identity: f.identity });

		assert.equal(recorded, artifact.id, "the hook answers the id it recorded");
		const consumption = consumptionFor(f.db, artifact.id, CONSUMER);
		assert.ok(consumption, "a full read leaves a consumptions row");
		assert.equal(consumption.readBytes, artifact.bytes, "read_bytes == artifacts.bytes (D5/D6: read to EOF)");
		assert.notEqual(consumption.readAt, null, "read_at is the moment of the read");
		assert.equal(consumption.notifiedAt, null, "P5a is the READ side only — notified_at stays NULL");
		assert.deepEqual(owedIds(f.db), [], "the projection no longer owes this artifact (D4): the notice is suppressed");
	} finally {
		f.dispose();
	}
});

test("D6: an `offset`/`limit` read records NOTHING and the artifact stays owed", () => {
	const f = fixture();
	try {
		const offsetRead = writeArtifact(f, "worker-0", 1);
		const limitRead = writeArtifact(f, "worker-0", 2, "a second answer\n");

		assert.equal(
			recordArtifactReadFromToolResult({ event: readEvent(offsetRead.file, { offset: 11 }), identity: f.identity }),
			undefined,
			"a paged read is not a completed read",
		);
		assert.equal(
			recordArtifactReadFromToolResult({ event: readEvent(limitRead.file, { limit: 5 }), identity: f.identity }),
			undefined,
			"a limited read is not a completed read either",
		);
		// `offset: 0` is still the paging argument: presence is what matters, not its value.
		assert.equal(
			recordArtifactReadFromToolResult({ event: readEvent(offsetRead.file, { offset: 0 }), identity: f.identity }),
			undefined,
			"even offset 0 asks for a page",
		);

		assert.equal(consumptionFor(f.db, offsetRead.id, CONSUMER), null, "no high-water mark was written");
		assert.equal(consumptionFor(f.db, limitRead.id, CONSUMER), null);
		assert.deepEqual(owedIds(f.db), [offsetRead.id, limitRead.id], "the boundary flush still delivers both notices");
	} finally {
		f.dispose();
	}
});

test("D5: a path that is not an artifact records nothing and throws nothing", () => {
	const f = fixture();
	try {
		const plain = path.join(f.runDir, "notes.md");
		writeFileSync(plain, BODY, "utf8");
		const sibling = path.join(f.runDir, "artifacts", "worker-0", "notes.md");
		mkdirSync(path.dirname(sibling), { recursive: true });
		writeFileSync(sibling, BODY, "utf8");
		const outside = path.join(f.root, "artifacts", "worker-0", "r1.md");
		mkdirSync(path.dirname(outside), { recursive: true });
		writeFileSync(outside, BODY, "utf8");

		for (const file of [plain, sibling, outside]) {
			assert.equal(
				recordArtifactReadFromToolResult({ event: readEvent(file), identity: f.identity }),
				undefined,
				`${path.basename(file)} is not an artifact of this run`,
			);
		}
		assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM consumptions").get()?.n, 0, "no row was invented");
		assert.deepEqual(owedIds(f.db), [], "and nothing that was never owed became owed");
	} finally {
		f.dispose();
	}
});

test("D5: a runDir mismatch, a missing body and an unknown id all record nothing and throw nothing", () => {
	const f = fixture();
	try {
		const artifact = writeArtifact(f, "worker-0", 1);

		// 1. The path is an artifact of ANOTHER run: same directory shape, different runDir.
		const wrongRunDir = path.join(f.root, "other-run");
		assert.equal(
			recordArtifactReadFromToolResult({
				event: readEvent(artifact.file),
				identity: { ...f.identity, runDir: wrongRunDir, runId: "r-other" },
			}),
			undefined,
			"a path is only an artifact relative to the run dir that owns it",
		);

		// 2. The row names an id, but the body is gone (A1 says this cannot happen from
		//    the writer; a hand-deleted/pruned file must not fake a completed read).
		const missing = writeArtifact(f, "worker-1", 1, "to be removed\n");
		rmSync(missing.file);
		assert.equal(
			recordArtifactReadFromToolResult({ event: readEvent(missing.file), identity: f.identity }),
			undefined,
			"a missing body is not a read to EOF",
		);

		// 3. The file is there, but the ledger has no row: `bytes` is unknowable, and the
		//    projection would not know this artifact anyway.
		const noRow = writeArtifact(f, "worker-2", 1, "unrecorded\n");
		f.db.prepare("DELETE FROM artifacts WHERE id = ?").run(noRow.id);
		assert.equal(
			recordArtifactReadFromToolResult({ event: readEvent(noRow.file), identity: f.identity }),
			undefined,
			"an id with no artifact row records nothing (same guard as markDelivered)",
		);

		assert.equal(consumptionFor(f.db, artifact.id, CONSUMER), null);
		assert.equal(consumptionFor(f.db, missing.id, CONSUMER), null);
		assert.equal(consumptionFor(f.db, noRow.id, CONSUMER), null);
		assert.deepEqual(
			owedIds(f.db),
			[artifact.id, missing.id],
			"both REAL artifacts are still owed — an unrecorded read never moves the projection",
		);
	} finally {
		f.dispose();
	}
});

test("D5: only the `read` tool counts — and only a read that reached EOF", () => {
	const f = fixture();
	try {
		const artifact = writeArtifact(f, "worker-0", 1);
		const cases: Array<{ label: string; event: unknown }> = [
			{ label: "tool not `read`", event: { ...readEvent(artifact.file), toolName: "bash" } },
			{ label: "no tool name", event: { type: "tool_result", input: { path: artifact.file } } },
			{ label: "no event", event: undefined },
			{ label: "no input", event: { type: "tool_result", toolName: "read" } },
			{ label: "non-string path", event: { ...readEvent(artifact.file), input: { path: 42 } } },
			{ label: "errored read", event: { ...readEvent(artifact.file), isError: true } },
			{
				label: "the tool truncated the body",
				event: readEvent(artifact.file, {}, { details: { truncation: { truncated: true } } }),
			},
		];
		for (const entry of cases) {
			assert.equal(
				recordArtifactReadFromToolResult({ event: entry.event, identity: f.identity }),
				undefined,
				`${entry.label}: nothing recorded`,
			);
		}
		// No identity = no ledger (a plain session). Nothing may throw either.
		assert.equal(recordArtifactReadFromToolResult({ event: readEvent(artifact.file), identity: undefined }), undefined);

		assert.equal(consumptionFor(f.db, artifact.id, CONSUMER), null);
		assert.deepEqual(owedIds(f.db), [artifact.id], "the notice is never suppressed by a read we cannot vouch for");
	} finally {
		f.dispose();
	}
});

test("D5: artifactIdFromPath parses exactly the canonical path and nothing else", () => {
	const runDir = path.join(path.sep, "tmp", "run-1");
	const canonical = path.join(runDir, "artifacts", "worker-0", "r3.md");
	assert.equal(artifactIdFromPath(canonical, runDir), "run-1/worker-0/r3", "runId falls back to the run dir name");
	assert.equal(artifactIdFromPath(canonical, runDir, "r-explicit"), "r-explicit/worker-0/r3", "the caller's runId wins");
	assert.equal(artifactIdFromPath(canonical, `${runDir}${path.sep}`), "run-1/worker-0/r3", "a trailing slash is not a different run");

	for (const [label, file] of [
		["a non-canonical spelling", path.join(runDir, "artifacts", "worker-0", "r03.md")],
		["round 0", path.join(runDir, "artifacts", "worker-0", "r0.md")],
		["a tmp file", path.join(runDir, "artifacts", "worker-0", "r3.md.tmp")],
		["one level too deep", path.join(runDir, "artifacts", "worker-0", "nested", "r3.md")],
		["not under artifacts/", path.join(runDir, "worker-0", "r3.md")],
		["another run", path.join(path.sep, "tmp", "run-2", "artifacts", "worker-0", "r3.md")],
		["an empty path", ""],
		// A traversal cannot name a segment: it resolves to something that is not this shape.
		["a traversal", path.join(runDir, "artifacts", "..", "r3.md")],
	] as const) {
		assert.equal(artifactIdFromPath(file, runDir), undefined, `${label}: not an artifact`);
	}
});

test("D5 integration: the REAL `tool_result` handler records a full read and skips a paged one", async () => {
	const root = mkdtempSync(path.join(tmpdir(), "legion-read-hook-handler-"));
	const agentDir = path.join(root, "agent");
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(path.join(agentDir, "settings.json"), "{}");
	const cwd = path.join(root, "repo");
	mkdirSync(cwd, { recursive: true });

	const store = new RunStore({ rootDir: path.join(cwd, ".pi-subagents") });
	const run = store.createRun({ task: "read hook", cwd, nodeId: CONSUMER, maxDepth: 4, herdr: { supervisor: "rpc" } });
	const runDir = store.runDir(run.runId);
	const dbPath = path.join(runDir, "legion.db");
	mkdirSync(runDir, { recursive: true });
	const db = openLegionDb(dbPath);
	insertNode(db, { id: CONSUMER, parentId: null, name: CONSUMER, role: "root", runId: run.runId, status: "running" });

	// Two artifacts of one child: the read of `full` must settle it, the read of `paged`
	// must not. Both rows are real, both bodies are real.
	const bodyOf = (name: string, round: number, text: string): { id: string; file: string; bytes: number } => {
		const file = artifactPathFor(runDir, name, round);
		mkdirSync(path.dirname(file), { recursive: true });
		writeFileSync(file, text, "utf8");
		const id = artifactIdFromPath(file, runDir, run.runId);
		assert.ok(id, "positive control: the artifact path parses into an id");
		recordArtifact(db, {
			id,
			parentId: CONSUMER,
			nodeId: `${run.runId}.${name}`,
			name,
			round,
			path: path.resolve(file),
			bytes: Buffer.byteLength(text, "utf8"),
			createdAt: Date.now(),
		});
		return { id, file, bytes: Buffer.byteLength(text, "utf8") };
	};
	const full = bodyOf("worker-0", 1, "settle me\n");
	const paged = bodyOf("worker-0", 2, "a page is not a read\n");

	const envKeys = [
		"PI_CODING_AGENT_DIR",
		"PI_SUBAGENT_CHILD",
		"PI_SUBAGENT_UTILITY_CHILD",
		"PI_SUBAGENT_ALLOW_NESTED",
		"PI_SUBAGENT_MAX_DEPTH",
		"PI_SUBAGENT_PARENT_PATH",
		"PI_LEGION_DB",
		"PI_LEGION_NODE_ID",
		"PI_LEGION_PHASES",
	] as const;
	const previousEnv = new Map(envKeys.map((name) => [name, process.env[name]]));
	process.env.PI_CODING_AGENT_DIR = agentDir;
	for (const name of envKeys.slice(1)) delete process.env[name];
	// The identity the extension adopts on `session_start` (`resolveLegionIdentity`):
	// an existing node in an existing run, with no session-file credential to mismatch.
	process.env.PI_LEGION_DB = dbPath;
	process.env.PI_LEGION_NODE_ID = CONSUMER;

	const handlers = new Map<string, Array<(...args: unknown[]) => unknown>>();
	const pi = {
		registerTool() {},
		registerCommand() {},
		registerMessageRenderer() {},
		sendMessage() {},
		events: { emit() {} },
		on(name: string, handler: (...args: unknown[]) => unknown) {
			const list = handlers.get(name) ?? [];
			list.push(handler);
			handlers.set(name, list);
		},
	};
	let loaded = false;
	try {
		piLegion(pi as never, { supervisor: new FakeSupervisor({ immediateTimeout: false }) });
		loaded = true;
		const ctx = {
			cwd,
			hasUI: false,
			ui: { notify() {}, setStatus() {} },
			sessionManager: { getSessionFile: () => path.join(root, "session.jsonl") },
		};
		const dispatch = async (name: string, event: unknown): Promise<void> => {
			for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
		};

		await dispatch("session_start", { type: "session_start" });

		// The full read: the REAL handler, no arguments that page.
		await dispatch("tool_result", readEvent(full.file));
		const settled = consumptionFor(db, full.id, CONSUMER);
		assert.ok(settled, "the handler recorded the read — the identity was adopted and the path parsed back");
		assert.equal(settled.readBytes, full.bytes, "read_bytes == artifacts.bytes");
		assert.equal(settled.notifiedAt, null, "the read side never writes notified_at");
		assert.deepEqual(owedIds(db), [paged.id], "the settled artifact left the projection; the paged one stayed");

		// The paged read of the other artifact: same handler, one extra argument.
		await dispatch("tool_result", readEvent(paged.file, { offset: 0 }));
		assert.equal(consumptionFor(db, paged.id, CONSUMER), null, "a paged read records nothing through the handler either");
		assert.deepEqual(owedIds(db), [paged.id], "and it keeps owing its notice (D6)");
	} finally {
		if (loaded) {
			try {
				for (const handler of handlers.get("session_shutdown") ?? []) {
					await handler({ type: "session_shutdown" }, { mode: "print" });
				}
			} catch {
				// Shutdown is best-effort here; the assertions are done.
			}
		}
		db.close();
		for (const [name, value] of previousEnv) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
		rmSync(root, { recursive: true, force: true });
	}
});
