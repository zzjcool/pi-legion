/**
 * P5b — `legion_output` (`docs/contracts/result-ledger-v1.md` §3 D7, with D6's
 * accounting rule and D10's lookup asymmetry).
 *
 * The tool exists because the artifact body is not addressable by the model: the
 * path carries a round (`artifacts/<segment>/r<round>.md`) and the directory name
 * is sanitized, so a generic `read` works only if the model already knows both.
 * `legion_output({ name, round? })` resolves them, prefixes a header that names the
 * round/size/settled-at/phase, and — being the one reader that can say so — tells
 * the model that a page is not a read (D6: "read half is not read").
 *
 * Layers on purpose, like `ledger-read-hook.test.ts`: every behaviour below goes
 * through the REAL registered tool (`piLegion` → `registerTool` → `execute`), not
 * through a private helper. The registration layer itself is a fact worth pinning
 * — D7 puts the tool on the PLUGIN entry (root-visible), not in
 * `registerLegionTools` (child-only) — so the first test asserts exactly that,
 * before any `session_start` and with no legion identity in place.
 *
 * The ledger facts asserted here are the projection's inputs, not decoration:
 * `consumptions.read_bytes == artifacts.bytes` is what empties `undelivered()`
 * (D4/D6), and `notified_at` must stay NULL because P5b is the READ side only.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { initTheme, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

import piLegion from "../../index.ts";
import { registerLegionTools } from "../../src/extension/legion-tools.ts";
import { LEGION_OUTPUT_TOOL_NAME } from "../../src/extension/legion-output.ts";
import { openLegionDb, type DatabaseSync } from "../../src/legion/db.ts";
import { consumptionFor, recordArtifact, undelivered } from "../../src/legion/ledger.ts";
import { insertNode, nodeIdForChild } from "../../src/legion/nodes.ts";
import { artifactNameSegment, artifactPathFor } from "../../src/runs/artifacts.ts";
import { RunStore } from "../../src/runs/store.ts";
import { FakeSupervisor } from "../helpers/fake-supervisor.ts";

initTheme("dark");

const CONSUMER = "root";

/** Every env var `piLegion` reads to decide who this process is; restored on dispose. */
const ENV_KEYS = [
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

interface RegisteredTool {
	name?: string;
	parameters?: unknown;
	renderResult?: (...args: unknown[]) => { render(width: number): string[] };
	execute: (
		id: string,
		params: Record<string, unknown>,
		...rest: unknown[]
	) => Promise<{ content?: Array<{ type?: string; text?: string }>; details?: unknown }>;
}

interface ToolResult {
	text: string;
	details: Record<string, unknown>;
}

interface Harness {
	root: string;
	cwd: string;
	runId: string;
	runDir: string;
	db: DatabaseSync;
	tools: Map<string, RegisteredTool>;
	/** Adopt this process's legion identity (`session_start`). */
	start: () => Promise<void>;
	/** Insert the child node that produced an artifact, so the header can name its phase. */
	child: (name: string, phase?: string) => string;
	write: (
		name: string,
		round: number,
		body: string,
		options?: { nodeId?: string; createdAt?: number; ledgerName?: string },
	) => { id: string; file: string; bytes: number };
	/** Artifact ids the notice projection still owes this consumer (D4). */
	owed: () => string[];
	invoke: (params: Record<string, unknown>) => Promise<ToolResult>;
	render: (result: ToolResult, expanded?: boolean) => string[];
	dispose: () => Promise<void>;
}

/**
 * The whole extension, loaded the way a session loads it, with the ledger the
 * roots of `test/unit/ledger-read-hook.test.ts` already use.
 *
 * `identity: false` keeps `PI_LEGION_*` unset, i.e. a plain session that never
 * becomes a legion node — the case D7's "no legion context" answer is for.
 */
async function harness(options: { identity?: boolean } = {}): Promise<Harness> {
	const identity = options.identity !== false;
	const root = mkdtempSync(path.join(tmpdir(), "legion-output-tool-"));
	const agentDir = path.join(root, "agent");
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(path.join(agentDir, "settings.json"), "{}");
	const cwd = path.join(root, "repo");
	mkdirSync(cwd, { recursive: true });

	const store = new RunStore({ rootDir: path.join(cwd, ".pi-subagents") });
	const run = store.createRun({ task: "legion output", cwd, nodeId: CONSUMER, maxDepth: 4, herdr: { supervisor: "rpc" } });
	const runDir = store.runDir(run.runId);
	mkdirSync(runDir, { recursive: true });
	const dbPath = path.join(runDir, "legion.db");
	const db = openLegionDb(dbPath);
	insertNode(db, { id: CONSUMER, parentId: null, name: CONSUMER, role: "root", runId: run.runId, status: "running" });

	const previousEnv = new Map(ENV_KEYS.map((name) => [name, process.env[name]]));
	process.env.PI_CODING_AGENT_DIR = agentDir;
	for (const name of ENV_KEYS.slice(1)) delete process.env[name];
	if (identity) {
		process.env.PI_LEGION_DB = dbPath;
		process.env.PI_LEGION_NODE_ID = CONSUMER;
	}

	const tools = new Map<string, RegisteredTool>();
	const handlers = new Map<string, Array<(...args: unknown[]) => unknown>>();
	const pi = {
		registerTool(value: unknown) {
			const typed = value as RegisteredTool;
			tools.set(String(typed.name), typed);
		},
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
	piLegion(pi as never, { supervisor: new FakeSupervisor({ immediateTimeout: false }) });
	const tool = tools.get(LEGION_OUTPUT_TOOL_NAME);
	assert.ok(tool, `${LEGION_OUTPUT_TOOL_NAME} is registered at load time`);

	const ctx = {
		cwd,
		hasUI: false,
		ui: { notify() {}, setStatus() {} },
		sessionManager: { getSessionFile: () => path.join(root, "session.jsonl") },
	};
	const dispatch = async (name: string, event: unknown): Promise<void> => {
		for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
	};

	return {
		root,
		cwd,
		runId: run.runId,
		runDir,
		db,
		tools,
		async start() {
			await dispatch("session_start", { type: "session_start" });
		},
		child(name, phase) {
			const id = nodeIdForChild(CONSUMER, name);
			insertNode(db, {
				id,
				parentId: CONSUMER,
				name,
				role: "worker",
				status: "settled",
				...(phase ? { phase, phaseSince: Date.now() } : {}),
			});
			return id;
		},
		write(name, round, body, writeOptions = {}) {
			const file = artifactPathFor(runDir, name, round);
			mkdirSync(path.dirname(file), { recursive: true });
			writeFileSync(file, body, "utf8");
			const bytes = Buffer.byteLength(body, "utf8");
			const id = `${run.runId}/${artifactNameSegment(name)}/r${round}`;
			recordArtifact(db, {
				id,
				parentId: CONSUMER,
				nodeId: writeOptions.nodeId ?? nodeIdForChild(CONSUMER, name),
				// D10: a live write stores the raw name; a REBUILT row stores the
				// sanitized segment. Both are the same id, which is all lookup may use.
				name: writeOptions.ledgerName ?? name,
				round,
				path: path.resolve(file),
				bytes,
				createdAt: writeOptions.createdAt ?? Date.now(),
			});
			return { id, file, bytes };
		},
		owed() {
			return undelivered(db, CONSUMER).map((artifact) => artifact.id);
		},
		async invoke(params) {
			const result = await tool.execute("call-1", params, undefined, undefined, ctx);
			return {
				text: (result.content ?? []).map((part) => part.text ?? "").join("\n"),
				details: (result.details ?? {}) as Record<string, unknown>,
			};
		},
		render(result, expanded = false) {
			const theme = {
				fg: (_color: string, text: string) => text,
				bg: (_color: string, text: string) => text,
				bold: (text: string) => text,
			};
			assert.equal(typeof tool.renderResult, "function", "the tool registers a renderer");
			return tool
				.renderResult!({ content: [{ type: "text", text: result.text }], details: result.details }, { expanded, isPartial: false }, theme)
				.render(200);
		},
		async dispose() {
			try {
				await dispatch("session_shutdown", { type: "session_shutdown" });
			} catch {
				/* best effort: assertions are done */
			}
			db.close();
			for (const [name, value] of previousEnv) {
				if (value === undefined) delete process.env[name];
				else process.env[name] = value;
			}
			rmSync(root, { recursive: true, force: true });
		},
	};
}

const HEADER = /^([a-z][a-z0-9_-]*) · round (\d+) · (\d+(?:\.\d+)? (?:B|KB)) · settled (\d+[smhd] ago)( · phase=[a-z_]+)?( · changed-on-disk)?$/;

test("P5b/D7: `legion_output` is registered on the plugin entry, not in the child-only registry", async () => {
	const h = await harness();
	try {
		// Load order is the point: the tool exists before `session_start`, i.e. in a
		// ROOT session that has no legion identity yet. `registerLegionTools` is the
		// child-only path (`registerTools && nodeId !== "root"`) and must not carry it.
		const tool = h.tools.get(LEGION_OUTPUT_TOOL_NAME);
		assert.ok(tool, "registered at extension load, before any identity is adopted");
		assert.equal(tool.name, LEGION_OUTPUT_TOOL_NAME);
		assert.equal(typeof tool.execute, "function");
		assert.equal(typeof tool.renderResult, "function", "a renderer keeps the header on screen");

		const schema = tool.parameters as {
			properties?: Record<string, unknown>;
			required?: string[];
		};
		assert.deepEqual(
			Object.keys(schema.properties ?? {}).sort(),
			["limit", "name", "offset", "round"],
			"the documented parameter list: { name, round?, offset?, limit? }",
		);
		assert.deepEqual(schema.required, ["name"], "only `name` is required — round defaults to newest");

		const childNames: string[] = [];
		registerLegionTools(
			{ registerTool: (value: unknown) => childNames.push(String((value as { name?: unknown }).name)) } as unknown as ExtensionAPI,
			{ db: h.db, nodeId: CONSUMER, role: "worker", cwd: h.cwd },
		);
		assert.ok(!childNames.includes(LEGION_OUTPUT_TOOL_NAME), "not in the child-only registry (D7)");
	} finally {
		await h.dispose();
	}
});

test("D7/D6: a full read returns header + verbatim body, records read_bytes == bytes and settles the notice", async () => {
	const h = await harness();
	try {
		await h.start();
		const childId = h.child("scout-a", "implementing");
		// 24.5 KB exactly: the header sample in §7-4.
		const body = `${"x".repeat(24.5 * 1024 - 1)}\n`;
		const artifact = h.write("scout-a", 1, body, { nodeId: childId, createdAt: Date.now() - 120_000 });
		assert.deepEqual(h.owed(), [artifact.id], "positive control: the artifact starts out owed (D4)");

		const result = await h.invoke({ name: "scout-a" });
		const lines = result.text.split("\n");
		assert.equal(
			lines[0],
			"scout-a · round 1 · 24.5 KB · settled 2m ago · phase=implementing",
			"header order is fixed: name · round · bytes · settled · phase",
		);
		assert.equal(lines[1], "x".repeat(24.5 * 1024 - 1), "the body follows the header, verbatim");
		assert.match(lines[0] ?? "", HEADER);

		assert.deepEqual(result.details, { artifactId: artifact.id, round: 1, bytes: artifact.bytes, phase: "implementing" });

		const consumption = consumptionFor(h.db, artifact.id, CONSUMER);
		assert.ok(consumption, "a full read leaves a consumptions row");
		assert.equal(consumption.readBytes, artifact.bytes, "read_bytes == artifacts.bytes (D6: read to EOF)");
		assert.notEqual(consumption.readAt, null);
		assert.equal(consumption.notifiedAt, null, "P5b is the READ side only — notified_at stays NULL");
		assert.deepEqual(h.owed(), [], "the projection no longer owes it: the completion notice is suppressed");

		// The header is what the user sees, so the card must lead with it (D7).
		const rendered = h.render(result).map((line) => line.replace(/\u001b\[[0-9;]*m/g, "").trimEnd());
		assert.equal(rendered[0], "scout-a · round 1 · 24.5 KB · settled 2m ago · phase=implementing");
	} finally {
		await h.dispose();
	}
});

test("D6: a paged read records NOTHING, keeps the notice owed, and says so in the header", async () => {
	const h = await harness();
	try {
		await h.start();
		const body = `${Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join("\n")}\n`;
		const artifact = h.write("worker-0", 1, body);

		const page = await h.invoke({ name: "worker-0", offset: 3, limit: 4 });
		const lines = page.text.split("\n");
		assert.match(lines[0] ?? "", /^worker-0 · round 1 · /);
		assert.equal(
			lines[1],
			"partial 6/12 lines · notifications not suppressed — read to EOF to settle",
			"D6's sentence, verbatim",
		);
		assert.deepEqual(lines.slice(2, 6), ["line 3", "line 4", "line 5", "line 6"], "offset is 1-based and counts lines");
		assert.equal(consumptionFor(h.db, artifact.id, CONSUMER), null, "a page is not a read: nothing is recorded");
		assert.deepEqual(h.owed(), [artifact.id], "the boundary flush still delivers the notice (D6)");

		// …and the same artifact DOES settle once the whole body is read.
		const full = await h.invoke({ name: "worker-0" });
		assert.equal(full.text.slice(full.text.indexOf("\n") + 1), body, "a full read returns the file verbatim");
		assert.ok(!full.text.includes("partial"), "no partial line once the whole body was returned");
		assert.deepEqual(h.owed(), [], "read to EOF suppressed the notice");
	} finally {
		await h.dispose();
	}
});

test("D7: `round` defaults to the newest round of a name, and an explicit round is exact", async () => {
	const h = await harness();
	try {
		await h.start();
		const first = h.write("worker-0", 1, "first answer\n");
		const second = h.write("worker-0", 2, "second answer\n");
		assert.deepEqual(h.owed(), [first.id, second.id], "both rounds are owed");

		const older = await h.invoke({ name: "worker-0", round: 1 });
		assert.match(older.text, /^worker-0 · round 1 · /);
		assert.match(older.text, /first answer/);
		assert.equal(older.details.round, 1);
		assert.deepEqual(h.owed(), [second.id], "reading round 1 settles only round 1 (W6)");

		const newest = await h.invoke({ name: "worker-0" });
		assert.match(newest.text, /^worker-0 · round 2 · /);
		assert.match(newest.text, /second answer/);
		assert.equal(newest.details.round, 2);
		assert.deepEqual(h.owed(), [], "the default read settled the newest round");
	} finally {
		await h.dispose();
	}
});

test("D7/A1: a body that changed on disk is marked `changed-on-disk` and never advances `full`", async () => {
	const h = await harness();
	try {
		await h.start();
		const artifact = h.write("worker-0", 1, "the answer\n");
		// Tamper: a different size than the ledger's `bytes` (A1 says the writer never does this).
		writeFileSync(artifact.file, "the answer, but longer now\n", "utf8");

		const result = await h.invoke({ name: "worker-0" });
		const header = result.text.split("\n")[0] ?? "";
		assert.match(header, /changed-on-disk$/, "the header names the mismatch");
		assert.match(header, /· round 1 · 11 B · settled /, "the ledger's byte count is what the header reports");
		assert.match(result.text, /but longer now/, "the current body is still returned — the read is not refused");
		assert.equal(result.details.bytes, artifact.bytes, "details carry the LEDGER's bytes, not the tampered size");

		assert.equal(consumptionFor(h.db, artifact.id, CONSUMER), null, "a changed body must not be recorded as read to EOF");
		assert.deepEqual(h.owed(), [artifact.id], "the notice is still owed (D6/A1)");
	} finally {
		await h.dispose();
	}
});

test("D10: lookup goes through the artifact id, never through the `artifacts.name` column", async () => {
	const h = await harness();
	try {
		await h.start();
		const raw = "worker odd";
		const segment = artifactNameSegment(raw);
		assert.notEqual(segment, raw, "positive control: this name is sanitized into a different segment");
		// Exactly what `rebuild` produces from the directory: `name` is the SEGMENT.
		const artifact = h.write(raw, 1, "rebuilt body\n", { ledgerName: segment });

		const result = await h.invoke({ name: raw });
		assert.equal(result.details.artifactId, artifact.id);
		assert.equal(result.details.error, undefined);
		assert.match(result.text, /rebuilt body/);
		assert.deepEqual(h.owed(), [], "the row was found in the ledger, so the read could be recorded");
	} finally {
		await h.dispose();
	}
});

test("D7: an unknown name answers with a human message and up to five available names — it never throws", async () => {
	const h = await harness();
	try {
		await h.start();
		for (let index = 1; index <= 7; index += 1) h.write(`worker-${index}`, 1, `answer ${index}\n`);

		const result = await h.invoke({ name: "ghost" });
		assert.match(result.text, /no artifact named "ghost"/);
		assert.equal(result.details.error, "NOT_FOUND");
		assert.match(result.text, /available: /);
		const listed = (result.text.split("available: ")[1] ?? "").replace(/\.$/, "").split(", ");
		assert.equal(listed.length, 5, "the list is capped at five names");
		for (const name of listed) assert.match(name, /^worker-\d+$/);

		// A round that does not exist is the same kind of answer, not a throw.
		const missingRound = await h.invoke({ name: "worker-1", round: 9 });
		assert.match(missingRound.text, /no artifact named "worker-1" at round 9/);
		assert.equal(missingRound.details.error, "NOT_FOUND");

		// Nothing was recorded for a query that named nothing.
		assert.equal(h.db.prepare("SELECT COUNT(*) AS n FROM consumptions").get()?.n, 0);
	} finally {
		await h.dispose();
	}
});

test("D7: without a legion identity the tool answers in words instead of throwing", async () => {
	const h = await harness({ identity: false });
	try {
		await h.start();
		const result = await h.invoke({ name: "worker-0" });
		assert.match(result.text, /no legion identity/);
		assert.equal(result.details.error, "NO_LEGION_CONTEXT");
	} finally {
		await h.dispose();
	}
});
