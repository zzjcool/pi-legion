/**
 * P5d — the artifact path is never handed to a model (user ruling, 2026-11-11:
 * "还是文件，但文件路径永远不让 agent 知道，也不告诉他，只指引他通过工具来读；软的就可以了").
 *
 * Two halves, both soft:
 *
 * 1. `tool_call` blocks `read`/`write`/`edit` of a path under `<runDir>/artifacts/` with a
 *    reason that names `legion_output` — no `terminate`, and every shape the guard cannot
 *    judge (no identity, no runDir, no path, a throw) fails OPEN, because a guard that
 *    cannot decide must never break an ordinary file read/write.
 * 2. Every render a model reads (`renderCollect` via `renderWait`, the completion notice,
 *    the batch notice) names the READER — `legion_output({ name, round })` — instead of
 *    the body's path. The body is still an ordinary immutable file; nothing is encrypted
 *    or moved.
 *
 * The path predicate is tested on ITS OWN axis (prefix trap, traversal, relative paths):
 * `artifacts-evil/` shares every character of `artifacts` but is a different directory,
 * which is exactly what a string `startsWith` would get wrong.
 *
 * The last test drives the REAL `tool_call` handler registered by `index.ts` against a
 * real adopted identity — a guard the handler never calls would still pass every unit
 * test above, so the wiring needs its own positive assertion.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { initTheme } from "@earendil-works/pi-coding-agent";

import piLegion, { artifactPathToolCallBlock, renderWait } from "../../index.ts";
import {
	artifactReadCall,
	formatCompletionNotice,
	formatGroupedNotice,
	type GroupedEntry,
} from "../../src/extension/notify.ts";
import type { CollectSnapshot } from "../../src/extension/runtime.ts";
import { LEGION_OUTPUT_TOOL_NAME } from "../../src/extension/legion-output.ts";
import { openLegionDb } from "../../src/legion/db.ts";
import { insertNode } from "../../src/legion/nodes.ts";
import { RunStore } from "../../src/runs/store.ts";
import { FakeSupervisor } from "../helpers/fake-supervisor.ts";

initTheme("dark");

/** A run dir on disk is not needed: both halves of P5d are pure path/text decisions. */
const RUN_DIR = path.join(path.sep, "tmp", "runs", "r-1");
const IDENTITY = { runDir: RUN_DIR };

/** The exact event shape the host hands a `tool_call` handler (types.d.ts). */
function callEvent(toolName: string, filePath: unknown, extra: Record<string, unknown> = {}): Record<string, unknown> {
	return { type: "tool_call", toolCallId: "call-1", toolName, input: { path: filePath, ...extra } };
}

function blocked(toolName: string, filePath: string): { block: true; reason: string } | undefined {
	return artifactPathToolCallBlock({ event: callEvent(toolName, filePath), identity: IDENTITY });
}

// ───────────────────────────── the soft block (task P5d.1) ─────────────────────────────

test("P5d: a `read` of an artifact is blocked with the legion_output pointer — a plain read is NOT", () => {
	const artifact = path.join(RUN_DIR, "artifacts", "worker-0", "r1.md");

	const verdict = blocked("read", artifact);
	assert.ok(verdict, "an artifact path under this run's artifacts/ is blocked");
	assert.equal(verdict.block, true);
	assert.match(verdict.reason, /legion_output/, "the reason names the ONE tool that can read it");
	assert.match(verdict.reason, /legion_output\(\{ name, round \}\)/, "and the call shape it wants");
	assert.equal("terminate" in verdict, false, "soft: the model may act on the sentence, the turn goes on");

	// Positive control, SAME call shape and the SAME run dir: an ordinary file is untouched.
	assert.equal(blocked("read", path.join(RUN_DIR, "worker-0.output.md")), undefined);
	assert.equal(blocked("read", path.join(RUN_DIR, "notes", "r1.md")), undefined);
	// …and another run's artifacts/ is not this run's (the guard is scoped by runDir).
	assert.equal(blocked("read", path.join(path.sep, "tmp", "runs", "r-2", "artifacts", "worker-0", "r1.md")), undefined);
});

test("P5d/A1b: `write` and `edit` of an artifact are refused too — the body is immutable", () => {
	const artifact = path.join(RUN_DIR, "artifacts", "worker-0", "r1.md");
	for (const toolName of ["write", "edit"]) {
		const verdict = blocked(toolName, artifact);
		assert.ok(verdict, `${toolName} of an artifact is refused`);
		assert.equal(verdict.block, true);
		assert.match(verdict.reason, /immutable/);
		assert.match(verdict.reason, /legion_output is the read path/);
		assert.equal("terminate" in verdict, false);
	}
	// Positive control: an ordinary write is never touched by this guard.
	assert.equal(blocked("write", path.join(RUN_DIR, "worker-0.output.md")), undefined);
	assert.equal(blocked("edit", path.join(RUN_DIR, "notes.md")), undefined);
});

test("P5d: only `read`/`write`/`edit` are guarded — other tools keep their paths", () => {
	const artifact = path.join(RUN_DIR, "artifacts", "worker-0", "r1.md");
	for (const toolName of ["bash", "ls", "grep", "find", LEGION_OUTPUT_TOOL_NAME]) {
		assert.equal(blocked(toolName, artifact), undefined, `${toolName} is not a file-body tool`);
	}
});

test("P5d: the path predicate uses resolve+relative — `artifacts-evil/`, traversal and relative paths", () => {
	const cases: Array<{ label: string; file: string; block: boolean }> = [
		{ label: "canonical artifact", file: path.join(RUN_DIR, "artifacts", "worker-0", "r1.md"), block: true },
		{ label: "a nested path under artifacts/", file: path.join(RUN_DIR, "artifacts", "worker-0", "nested", "r1.md"), block: true },
		{ label: "any non-canonical file under artifacts/", file: path.join(RUN_DIR, "artifacts", "worker-0", "notes.txt"), block: true },
		// The prefix trap: `artifacts-evil` shares every character of `artifacts` up to the
		// separator, which is exactly what a `startsWith` check would get wrong.
		{ label: "artifacts-evil/, the prefix trap", file: path.join(RUN_DIR, "artifacts-evil", "worker-0", "r1.md"), block: false },
		{ label: "the artifacts/ directory itself", file: path.join(RUN_DIR, "artifacts"), block: false },
		// Normalisation happens BEFORE the comparison, so `..` cannot be used to walk in
		// (or out) of the subtree…
		{ label: "a `..` that lands back inside artifacts/", file: path.join(RUN_DIR, "artifacts", "worker-0", "..", "r1.md"), block: true },
		{ label: "a `..` that escapes artifacts/", file: path.join(RUN_DIR, "artifacts", "..", "host-file.md"), block: false },
		{ label: "a run dir that is a prefix of this one", file: path.join(RUN_DIR, "-other", "artifacts", "worker-0", "r1.md"), block: false },
	];
	for (const entry of cases) {
		const verdict = blocked("read", entry.file);
		assert.equal(verdict !== undefined, entry.block, `${entry.label}: block=${entry.block} (${entry.file})`);
	}

	// …and a RELATIVE path is resolved against the process cwd, then normalised: the same
	// file named relatively is still the artifact.
	const relative = path.relative(process.cwd(), path.join(RUN_DIR, "artifacts", "worker-0", "sub", "..", "r1.md"));
	assert.ok(!path.isAbsolute(relative), "positive control: this case really is a relative path");
	assert.equal(blocked("read", relative)?.block, true, "a relative path with a `..` still normalises onto the artifact");
});

test("P5d: every shape the guard cannot judge fails OPEN (never a block, never a throw)", () => {
	const artifact = path.join(RUN_DIR, "artifacts", "worker-0", "r1.md");
	const cases: Array<{ label: string; input: Parameters<typeof artifactPathToolCallBlock>[0] }> = [
		{ label: "no identity (a plain session)", input: { event: callEvent("read", artifact), identity: undefined } },
		{ label: "an empty runDir", input: { event: callEvent("read", artifact), identity: { runDir: "" } } },
		{ label: "no event", input: { event: undefined, identity: IDENTITY } },
		{ label: "no tool name", input: { event: { type: "tool_call", input: { path: artifact } }, identity: IDENTITY } },
		{ label: "no input", input: { event: { type: "tool_call", toolName: "read" }, identity: IDENTITY } },
		{ label: "a non-string path", input: { event: callEvent("read", 42), identity: IDENTITY } },
		{ label: "an empty path", input: { event: callEvent("read", ""), identity: IDENTITY } },
		{
			label: "an input that throws while being read",
			input: {
				event: {
					type: "tool_call",
					toolName: "read",
					get input(): Record<string, unknown> {
						throw new Error("boom");
					},
				},
				identity: IDENTITY,
			},
		},
	];
	for (const entry of cases) {
		assert.equal(artifactPathToolCallBlock(entry.input), undefined, `${entry.label}: allowed`);
	}
});

// ───────────────────────────── the renders name the reader (P5d.2) ─────────────────────────────

/** One complete snapshot exactly as a `collect`/`wait` hands it over. */
const ARTIFACT_ID = "r-1/worker-0/r1";
const ARTIFACT_PATH = path.join(RUN_DIR, "artifacts", "worker-0", "r1.md");

function snapshot(over: Partial<CollectSnapshot> = {}): CollectSnapshot {
	return {
		execution: { status: "success" },
		output: "the whole answer\n",
		outputFile: ARTIFACT_PATH,
		artifactId: ARTIFACT_ID,
		acceptance: { status: "accepted", level: "attested" },
		...over,
	};
}

test("P5d: renderWait/renderCollect name legion_output and never print the artifact path", () => {
	const rendered = renderWait([
		{ name: "worker-0", snapshot: snapshot() },
		{ name: "worker-1", snapshot: snapshot({ artifactId: undefined, outputFile: undefined, output: "no artifact here\n" }) },
	]);

	// Positive face: the header and the body are still exactly what they were.
	assert.match(rendered, /── worker-0 ──/);
	assert.match(rendered, /execution: success/);
	assert.match(rendered, /the whole answer/);
	assert.match(rendered, /── worker-1 ──/);
	assert.match(rendered, /no artifact here/);

	// The reader is named with the round the artifact id carries…
	assert.ok(rendered.includes('full text: legion_output({ name: "worker-0", round: 1 })'));
	// …and the artifact's path is nowhere in the text the model reads.
	assert.ok(!rendered.includes(ARTIFACT_PATH), "P5d: the artifact path is not printed");
	assert.doesNotMatch(rendered, /artifacts\/worker-0/);
});

test("P5d: without a parseable artifact id the pointer degrades to `{ name }` — still no path", () => {
	const rendered = renderWait([{ name: "worker-0", snapshot: snapshot({ artifactId: "not-an-artifact-id" }) }]);
	assert.ok(rendered.includes('full text: legion_output({ name: "worker-0" })'));
	assert.ok(!rendered.includes(ARTIFACT_PATH));
});

test("P5d: the completion notice names legion_output and keeps the session file", () => {
	const notice = formatCompletionNotice({
		name: "worker-0",
		agent: "worker",
		execution: { status: "success" },
		output: `{"ok": true}\n${"z".repeat(5_000)}`,
		outputFile: ARTIFACT_PATH,
		artifactId: ARTIFACT_ID,
		sessionFile: path.join(RUN_DIR, "worker-0.jsonl"),
		acceptance: { status: "accepted", level: "attested" },
	});
	// Positive face: the subject, the execution line and the body are still there.
	assert.match(notice.content, /Background task completed: \*\*worker-0 \(worker\)\*\*/);
	assert.match(notice.content, /execution: success/);
	assert.match(notice.content, /\{"ok": true\}/);
	// The reader — with its round — replaced the path, in BOTH the truncation hint and the
	// full-text line.
	assert.ok(notice.content.includes(`…(preview truncated — full text: ${LEGION_OUTPUT_TOOL_NAME}({ name: "worker-0" }))`));
	assert.ok(notice.content.includes('Full text: legion_output({ name: "worker-0", round: 1 })'));
	assert.ok(!notice.content.includes(ARTIFACT_PATH), "P5d: the artifact path is not printed");
	// The session file is a diagnostic pointer, not an artifact, and stays.
	assert.ok(notice.content.includes(`Session file: ${path.join(RUN_DIR, "worker-0.jsonl")}`));
});

test("P5d: a batch notice names each member's reader and no member's path", () => {
	const entry = (over: Partial<GroupedEntry> = {}): GroupedEntry => ({
		name: "a",
		agent: "worker",
		execution: { status: "success" },
		acceptance: { status: "accepted", level: "attested" },
		status: "completed",
		output: "ok",
		...over,
	});
	const notice = formatGroupedNotice({
		runId: "r-1",
		entries: [
			entry({
				output: "a".repeat(5_000),
				outputFile: path.join(RUN_DIR, "artifacts", "a", "r2.md"),
				artifactId: "r-1/a/r2",
			}),
			entry({ name: "b", output: "short" }),
		],
	});
	// Positive face: the header and both bodies are still there.
	assert.match(notice.content, /Background tasks completed \(2\):/);
	assert.match(notice.content, /- a \(worker\): completed/);
	assert.match(notice.content, /- b \(worker\): completed/);
	assert.ok(notice.content.includes('  Full text: legion_output({ name: "a", round: 2 })'));
	assert.ok(!notice.content.includes(path.join(RUN_DIR, "artifacts", "a", "r2.md")));
	assert.doesNotMatch(notice.content, /artifacts\/a\/r2\.md/);
});

test("P5d: artifactReadCall reads the round off the id's tail and degrades on any other shape", () => {
	assert.equal(artifactReadCall("a", "r-1/a/r3"), 'legion_output({ name: "a", round: 3 })');
	assert.equal(artifactReadCall("a"), 'legion_output({ name: "a" })');
	// Non-canonical spellings are NOT the id the writer emits, so no round is invented.
	assert.equal(artifactReadCall("a", "r-1/a/r03"), 'legion_output({ name: "a" })');
	assert.equal(artifactReadCall("a", "r-1/a/r0"), 'legion_output({ name: "a" })');
	assert.equal(artifactReadCall("a", "r-1/a/r1.md"), 'legion_output({ name: "a" })');
	assert.equal(artifactReadCall("a", "a/r1"), 'legion_output({ name: "a" })');
	assert.equal(artifactReadCall("a", "r-1/../r1"), 'legion_output({ name: "a" })');
	assert.equal(artifactReadCall("a", ""), 'legion_output({ name: "a" })');
	// The name is a JSON string, so a quote in it cannot break the call it prints.
	assert.equal(artifactReadCall('a"b', "r-1/a/r1"), 'legion_output({ name: "a\\"b", round: 1 })');
});

// ─────────────────────── the REAL handler: the guard is wired, not just defined ───────────────────────

test("P5d integration: the REAL `tool_call` handler blocks an artifact read and allows an ordinary one", async () => {
	const root = mkdtempSync(path.join(tmpdir(), "legion-path-guard-"));
	const agentDir = path.join(root, "agent");
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(path.join(agentDir, "settings.json"), "{}");
	const cwd = path.join(root, "repo");
	mkdirSync(cwd, { recursive: true });

	const store = new RunStore({ rootDir: path.join(cwd, ".pi-subagents") });
	const run = store.createRun({ task: "path guard", cwd, nodeId: "root", maxDepth: 4, herdr: { supervisor: "rpc" } });
	const runDir = store.runDir(run.runId);
	const dbPath = path.join(runDir, "legion.db");
	mkdirSync(runDir, { recursive: true });
	const db = openLegionDb(dbPath);
	insertNode(db, { id: "root", parentId: null, name: "root", role: "root", runId: run.runId, status: "running" });

	const artifact = path.join(runDir, "artifacts", "worker-0", "r1.md");
	mkdirSync(path.dirname(artifact), { recursive: true });
	writeFileSync(artifact, "the answer\n", "utf8");
	const plain = path.join(runDir, "worker-0.output.md");
	writeFileSync(plain, "not an artifact\n", "utf8");

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
	process.env.PI_LEGION_DB = dbPath;
	process.env.PI_LEGION_NODE_ID = "root";

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
		const dispatch = async (name: string, event: unknown): Promise<unknown> => {
			let verdict: unknown;
			for (const handler of handlers.get(name) ?? []) verdict = await handler(event, ctx);
			return verdict;
		};

		assert.ok((handlers.get("tool_call") ?? []).length > 0, "the extension registers a `tool_call` handler");
		await dispatch("session_start", { type: "session_start" });

		// The artifact, through the real handler: blocked, and the reason is the instruction.
		const verdict = (await dispatch("tool_call", callEvent("read", artifact))) as
			| { block?: boolean; reason?: string }
			| undefined;
		assert.ok(verdict, "the real handler blocks a read of an artifact under the adopted run dir");
		assert.equal(verdict.block, true);
		assert.match(verdict.reason ?? "", /legion_output/);

		// The same handler, the same batch, an ordinary file: untouched.
		assert.equal(await dispatch("tool_call", callEvent("read", plain)), undefined, "a plain read is not blocked");
		assert.equal(await dispatch("tool_call", callEvent("write", plain)), undefined, "a plain write is not blocked");
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
