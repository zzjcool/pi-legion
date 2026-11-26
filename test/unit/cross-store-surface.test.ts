/**
 * #450 — the cross-store SCAN surface: `status`, `list all:true` and `recover`.
 *
 * The bug: a run store is per-cwd (`<cwd>/.pi-subagents`), so a child launched from
 * `~/code/anotify` is invisible to a session started in `~/agents` — `status` lists
 * nothing, `recover` answers `No cross-machine child named …`, and the automatic
 * re-attach #445 added only ever looked at ONE store.
 *
 * These tests pin the five surfaces the contract froze, and — just as important — the
 * two things the widened surface must never cost:
 *
 *  - a single-store session's output stays byte-identical (no `store=` line, no header
 *    change, no reordering);
 *  - a name that exists in two stores is NEVER silently resolved to one of them
 *    (cross-talk is acceptance 3), while the pre-existing same-store ambiguity path is
 *    untouched.
 *
 * The storage half uses REAL temp dirs, the REAL `RunStore` on disk and the REAL
 * `legion.db` schema: the whole point is that these readers see what another process
 * actually wrote, so a fake store would test the fixture, not the fix.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";

import piLegion, { recoverAction } from "../../index.ts";
import { renderLiveChildStatus } from "../../src/extension/runtime.ts";
import { legionDbPath, openLegionDb } from "../../src/legion/db.ts";
import { getNode, insertNode } from "../../src/legion/nodes.ts";
import { RunStore } from "../../src/runs/store.ts";
import { STORE_DIR_NAME, candidateStoreRoots, resolveChildAcrossStores } from "../../src/runs/store-lookup.ts";
import type { ChildRecord, RunRecord } from "../../src/shared/types.ts";
import { FakeSupervisor } from "../helpers/fake-supervisor.ts";
import { assistantMsg, modelChange, sessionHeader, userMsg } from "../helpers/fixtures.ts";

initTheme("dark");

const STAMP = "2026-01-01T00:00:00.000Z";

const SCOUT_FILE =
	"---\nname: scout\ndescription: read-only utility role\nutility: true\ntools: read, grep, find, ls\nkind: pi\n---\nscout prompt\n";
const WORKER_FILE = "---\nname: worker\ndescription: worker role\n---\nworker prompt\n";

// ── fixtures ────────────────────────────────────────────────────────────────

function childRecord(name: string, partial: Partial<ChildRecord> = {}): ChildRecord {
	return {
		name,
		sessionFile: `/tmp/${name}.jsonl`,
		ownerToken: `tok-${name}`,
		state: "working",
		spawnedAt: STAMP,
		agent: "worker",
		kind: "pi",
		...partial,
	};
}

/**
 * Write one `<root>/runs/<id>/run.json` by hand.
 *
 * `status`/`list` read run.json and nothing else, so a hand-written record is the
 * honest input for them — and it lets a test compare the file BEFORE and AFTER a call
 * to prove the reader wrote nothing.
 */
function writeStoreRun(
	rootDir: string,
	run: { runId: string; cwd: string; children: ChildRecord[]; createdAt?: string },
): string {
	const runDir = path.join(rootDir, "runs", run.runId);
	mkdirSync(runDir, { recursive: true });
	const createdAt = run.createdAt ?? STAMP;
	const record = {
		schemaVersion: 1,
		runId: run.runId,
		task: "fixture",
		cwd: run.cwd,
		herdr: { supervisor: "rpc", node_id: "root" },
		path: [],
		depth: 0,
		maxDepth: 3,
		budget: { spawned: run.children.length, limit: null, granted: 0 },
		createdAt,
		updatedAt: createdAt,
		children: run.children,
	} satisfies Record<string, unknown>;
	const file = path.join(runDir, "run.json");
	writeFileSync(file, JSON.stringify(record, null, "\t"));
	return file;
}

interface TempHome {
	root: string;
	home: string;
}

/**
 * A temp tree with its own `$HOME`.
 *
 * `store-scan.ts` reads `os.homedir()`, which is `$HOME` on POSIX — that is exactly the
 * seam the #450 hermetic rule is defined against, so the tests move it rather than
 * inventing a second one.
 */
async function inTempHome(fn: (ctx: TempHome) => Promise<void> | void): Promise<void> {
	const previous = process.env.HOME;
	const root = mkdtempSync(path.join(tmpdir(), "pi-legion-450-"));
	const home = path.join(root, "home");
	mkdirSync(home, { recursive: true });
	process.env.HOME = home;
	try {
		await fn({ root, home });
	} finally {
		if (previous === undefined) delete process.env.HOME;
		else process.env.HOME = previous;
		rmSync(root, { recursive: true, force: true });
	}
}

const ENV_KEYS = [
	"PI_CODING_AGENT_DIR",
	"PI_HERDR_SUBAGENTS_EXTRA_AGENT_DIRS",
	"PI_SUBAGENT_CHILD",
	"PI_SUBAGENT_ALLOW_NESTED",
	"PI_LEGION_DB",
	"PI_LEGION_NODE_ID",
	"PI_SUBAGENTS_TEAM",
];

interface Harness {
	invoke: (params: Record<string, unknown>) => Promise<{ text: string; details?: { error?: string; code?: string } }>;
	cleanup: () => Promise<void>;
}

/**
 * The tool wiring, with a FakeSupervisor and NO launches.
 *
 * The records the tests assert on are pre-written into real stores on disk, because
 * `status`/`list` are readers: what they must see is another process's run.json, not a
 * child this harness happens to have spawned.
 */
function indexHarness(ctx: { root: string; cwd: string }): Harness {
	const agentDir = path.join(ctx.root, "agent-config");
	const extraAgentsDir = path.join(ctx.root, "extra-agents");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(extraAgentsDir, { recursive: true });
	writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ subagents: { disableBuiltins: true } }));
	writeFileSync(path.join(extraAgentsDir, "scout.md"), SCOUT_FILE);
	writeFileSync(path.join(extraAgentsDir, "worker.md"), WORKER_FILE);
	const previous = new Map(ENV_KEYS.map((name) => [name, process.env[name]]));
	const tools = new Map<
		string,
		{ execute: (...args: unknown[]) => Promise<{ content?: Array<{ text?: string }>; details?: unknown }> }
	>();
	const handlers = new Map<string, (...args: unknown[]) => unknown>();
	const supervisor = new FakeSupervisor({ autoSettle: { text: '{"ok":true}' }, immediateTimeout: false });
	const pi = {
		registerTool(value: unknown) {
			const typed = value as {
				name: string;
				execute: (...args: unknown[]) => Promise<{ content?: Array<{ text?: string }>; details?: unknown }>;
			};
			tools.set(typed.name, typed);
		},
		registerCommand() {},
		registerMessageRenderer() {},
		sendMessage() {},
		events: { emit() {} },
		on(name: string, handler: (...args: unknown[]) => unknown) {
			handlers.set(name, handler);
		},
	};
	process.env.PI_CODING_AGENT_DIR = agentDir;
	process.env.PI_HERDR_SUBAGENTS_EXTRA_AGENT_DIRS = extraAgentsDir;
	for (const name of ENV_KEYS.slice(2)) delete process.env[name];
	piLegion(pi as never, { supervisor });
	const tool = tools.get("subagent");
	assert.ok(tool, "the subagent tool is registered");
	return {
		async invoke(params) {
			const result = await tool.execute("cross-store-test", params, undefined, undefined, {
				cwd: ctx.cwd,
				hasUI: false,
				ui: { notify() {}, setStatus() {} },
			});
			return {
				text: (result.content ?? []).map((item) => item.text ?? "").join("\n"),
				details: result.details as { error?: string; code?: string } | undefined,
			};
		},
		async cleanup() {
			await handlers.get("session_shutdown")?.();
			for (const [name, value] of previous) {
				if (value === undefined) delete process.env[name];
				else process.env[name] = value;
			}
		},
	};
}

// ── A: renderLiveChildStatus grows exactly one optional line ────────────────

test("#450 A: renderLiveChildStatus prints `store=` only when a store is passed", () => {
	const base = {
		name: "worker-0",
		state: "working",
		agent: "worker",
		kind: "pi",
		sessionFile: "/tmp/does-not-exist-worker-0.jsonl",
		alive: false,
	};
	const plain = renderLiveChildStatus(base);
	assert.doesNotMatch(plain, /^store=/m, "a same-store child grows no line");

	const marked = renderLiveChildStatus({ ...base, store: "~/code/anotify" });
	const lines = marked.split("\n");
	const storeIndex = lines.findIndex((line) => line.startsWith("store="));
	assert.notEqual(storeIndex, -1, "the marker is printed for a foreign record");
	assert.equal(lines[storeIndex], "store=~/code/anotify");
	// The contract's exact placement: right after the `session=` meta line.
	assert.ok(lines[storeIndex - 1]?.startsWith("session="), "store= follows session=");
	assert.equal(lines.filter((line) => line.startsWith("store=")).length, 1, "exactly one line");
	// And nothing else moved: dropping the line gives the plain block back.
	assert.equal(
		[...lines.slice(0, storeIndex), ...lines.slice(storeIndex + 1)].join("\n"),
		plain,
		"the rest of the block is byte-identical",
	);
});

test("#450 A: a live child's block also keeps every existing line, plus store=", () => {
	const input = {
		name: "worker-0",
		state: "working",
		agent: "worker",
		kind: "pi",
		sessionFile: "/tmp/does-not-exist-worker-0.jsonl",
		alive: true,
	};
	assert.doesNotMatch(renderLiveChildStatus(input), /^store=/m);
	const marked = renderLiveChildStatus({ ...input, store: "~/agents" }).split("\n");
	const storeIndex = marked.findIndex((line) => line.startsWith("store="));
	assert.ok(storeIndex > 0);
	assert.ok(marked[storeIndex - 1]?.startsWith("session="));
});

// ── B: the candidate surface widens (bounded, hermetic) ─────────────────────

test("#450 B: a sibling repository's store becomes a candidate from inside $HOME, never from outside", async () => {
	await inTempHome(({ home }) => {
		const cwd = path.join(home, "agents");
		const foreignCwd = path.join(home, "code", "anotify");
		const foreignRoot = path.join(foreignCwd, STORE_DIR_NAME);
		mkdirSync(cwd, { recursive: true });
		writeStoreRun(foreignRoot, {
			runId: "r-anotify",
			cwd: foreignCwd,
			children: [childRecord("worker-0")],
		});

		const roots = candidateStoreRoots({ cwd });
		const hit = roots.find((root) => root.rootDir === foreignRoot);
		assert.ok(hit, `the sibling repo's store is a candidate (got ${roots.map((r) => r.rootDir).join(", ")})`);
		assert.equal(hit.reason, "scan", "and it says where it came from");

		// The widened candidates are what the lookup actually resolves through.
		const { found } = resolveChildAcrossStores({ name: "worker-0", cwd });
		assert.equal(found?.storeRoot, foreignRoot);

		// The hermetic rule (#450): a cwd outside $HOME does not walk $HOME.
		const outside = path.join(path.dirname(home), "elsewhere", "scratch");
		mkdirSync(outside, { recursive: true });
		const outsideRoots = candidateStoreRoots({ cwd: outside });
		assert.equal(
			outsideRoots.some((root) => root.rootDir === foreignRoot),
			false,
			"a temp cwd must not inherit the home tree's stores",
		);
		assert.equal(resolveChildAcrossStores({ name: "worker-0", cwd: outside }).found, null);
	});
});

// ── C/D: status across stores ───────────────────────────────────────────────

test("#450 C/D: status reads every store, marks foreign rows, and never merges two stores", async () => {
	await inTempHome(async ({ root, home }) => {
		const cwd = path.join(home, "agents");
		const foreignCwd = path.join(home, "code", "anotify");
		mkdirSync(cwd, { recursive: true });
		const sessionRoot = path.join(cwd, STORE_DIR_NAME);
		const foreignRoot = path.join(foreignCwd, STORE_DIR_NAME);
		const sessionFile = writeStoreRun(sessionRoot, {
			runId: "r-session",
			cwd,
			children: [
				childRecord("worker-0", { agent: "worker" }),
				childRecord("gone-0", { state: "retired", retiredAt: STAMP }),
			],
		});
		const foreignFile = writeStoreRun(foreignRoot, {
			runId: "r-anotify",
			cwd: foreignCwd,
			children: [
				childRecord("worker-0", { agent: "centurion" }),
				childRecord("cent-0", { agent: "centurion" }),
				childRecord("done-0", { state: "retired", retiredAt: STAMP }),
			],
		});
		const before = { session: readFileSync(sessionFile, "utf8"), foreign: readFileSync(foreignFile, "utf8") };

		const harness = indexHarness({ root, cwd });
		try {
			const status = await harness.invoke({ action: "status" });
			assert.equal(status.details?.error, undefined, status.text);
			// The header is unchanged: it counts live children across the surface.
			assert.match(status.text, /^Status · 3 live children/);
			// Same name in both stores ⇒ TWO blocks (identity is `(store, name)`).
			assert.equal(
				status.text.split("\n").filter((line) => line.startsWith("worker-0 — state=")).length,
				2,
				"no cross-store dedupe",
			);
			// Session-store records come first and carry no marker; foreign rows do.
			const blocks = status.text.split("\n\n");
			assert.equal(blocks[0], "Status · 3 live children");
			assert.doesNotMatch(blocks[1] ?? "", /^store=/m, "the session store's child grows no line");
			assert.match(blocks[2] ?? "", /^store=~\/code\/anotify$/m);
			assert.match(blocks[3] ?? "", /^store=~\/code\/anotify$/m);
			assert.match(blocks[2] ?? "", /agent=centurion/, "the foreign store's own record is what is rendered");

			// `all` keeps the SESSION store's history (a foreign repository's past is not a
			// `status` the caller asked for), while the LIVE overview above is cross-store.
			const all = await harness.invoke({ action: "status", all: true });
			const finished = all.text.split("retired/finished (1):")[1] ?? "";
			assert.match(finished, /^ {2}gone-0 — state=retired/m, "the session store's own finished row is listed");
			assert.doesNotMatch(finished, /done-0/, "another store's history is not dumped into `status all`");
			assert.doesNotMatch(finished, /store=/, "no marker: every line is the session store's");

			// D: a named status resolves through the same surface and marks the store.
			const named = await harness.invoke({ action: "status", name: "cent-0" });
			assert.equal(named.details?.error, undefined, named.text);
			assert.doesNotMatch(named.text, /Status ·/, "one child, not an overview");
			assert.match(named.text, /cent-0 — state=working/);
			assert.match(named.text, /^store=~\/code\/anotify$/m);
			// ...and a name that IS in the session store keeps its unmarked block.
			const own = await harness.invoke({ action: "status", name: "worker-0" });
			assert.match(own.text, /worker-0 — state=working/);
			assert.doesNotMatch(own.text, /^store=/m);
		} finally {
			await harness.cleanup();
		}

		// C: reading a surface modifies nothing.
		assert.equal(readFileSync(sessionFile, "utf8"), before.session, "the session record is untouched");
		assert.equal(readFileSync(foreignFile, "utf8"), before.foreign, "the foreign record is untouched");
	});
});

// ── E: list all:true ────────────────────────────────────────────────────────

test("#450 E: `status` sweeps every store's live children and marks a foreign row's store", async () => {
	await inTempHome(async ({ root, home }) => {
		const cwd = path.join(home, "agents");
		const foreignCwd = path.join(home, "code", "anotify");
		mkdirSync(cwd, { recursive: true });
		writeStoreRun(path.join(cwd, STORE_DIR_NAME), {
			runId: "r-session",
			cwd,
			children: [childRecord("worker-0")],
		});
		writeStoreRun(path.join(foreignCwd, STORE_DIR_NAME), {
			runId: "r-anotify",
			cwd: foreignCwd,
			children: [childRecord("cent-0", { agent: "centurion" })],
		});

		const harness = indexHarness({ root, cwd });
		try {
			// Step 2a removed the `list` action, so this coverage moved to `status`, which
			// has always been the renderer's other caller. What is asserted is unchanged:
			// one surface, every store on the scan surface, `store=` on a foreign row only.
			const overview = (await harness.invoke({ action: "status" })).text;
			assert.match(overview, /^Status · 2 live children/, "every store's live children are counted");
			assert.match(overview, /cent-0 — state=working/);
			assert.match(overview, /^store=~\/code\/anotify$/m, "a foreign row carries its store");
			assert.doesNotMatch(
				overview.split("\n\n")[1] ?? "",
				/^store=/m,
				"the session store's own row still carries none",
			);
		} finally {
			await harness.cleanup();
		}
	});
});

// ── F: recover finds a ledger in another store ──────────────────────────────

const HOST = "hw-nj";
const REMOTE_NODE = "centurion-0";
const REMOTE_NODE_ID = `root.${REMOTE_NODE}`;

/** The row the foreign session's launch wrote: cross-machine, unsettled (real schema). */
function seedForeignLedger(dbPath: string, runId: string, remoteDir: string): void {
	const now = Date.now();
	const db = openLegionDb(dbPath);
	try {
		insertNode(db, {
			id: "root",
			parentId: null,
			name: "root",
			role: "root",
			kind: "pi",
			depth: 0,
			runId,
			status: "running",
			createdAt: now - 3_600_000,
			updatedAt: now - 3_600_000,
		});
		insertNode(db, {
			parentId: "root",
			name: REMOTE_NODE,
			role: "centurion",
			kind: "pi",
			status: "running",
			host: HOST,
			remoteDir,
			remoteTerminal: `${HOST}/lgl-450`,
			sessionFile: path.join(remoteDir, "session.jsonl"),
			createdAt: now - 3_600_000,
			updatedAt: now - 600_000,
		});
	} finally {
		db.close();
	}
}

function finishedTranscript(text: string): string {
	return [
		sessionHeader({ cwd: "/srv/app" }),
		modelChange("workbuddy/deepseek-v4.1-flash"),
		userMsg("fix the flaky test"),
		assistantMsg({ text: `${text}\n{"ok": true, "reason": "tests pass"}`, stopReason: "stop" }),
	].join("\n") + "\n";
}

test("#450 F: `recover` finds and settles the ledger of a child launched from another store", async () => {
	await inTempHome(async ({ root, home }) => {
		const sessionCwd = path.join(home, "agent-run");
		const foreignCwd = path.join(home, "code", "anotify");
		mkdirSync(sessionCwd, { recursive: true });
		mkdirSync(foreignCwd, { recursive: true });

		// This session's own store: a run of ours, and NOTHING about the remote child.
		const sessionStore = new RunStore({ rootDir: path.join(sessionCwd, STORE_DIR_NAME) });
		const sessionRun = sessionStore.createRun({
			task: "today's work",
			cwd: sessionCwd,
			sessionFile: path.join(root, "sessions", "today.jsonl"),
		});

		// The other repository's store: its run.json holds the record, its ledger the row.
		const foreignRoot = path.join(foreignCwd, STORE_DIR_NAME);
		const foreignRunFile = writeStoreRun(foreignRoot, {
			runId: "r-anotify",
			cwd: foreignCwd,
			children: [childRecord(REMOTE_NODE, { agent: "centurion", host: HOST, remoteTerminal: `${HOST}/lgl-450` })],
		});
		const foreignDbPath = legionDbPath(path.join(foreignRoot, "runs", "r-anotify"));
		mkdirSync(path.dirname(foreignDbPath), { recursive: true });
		seedForeignLedger(foreignDbPath, "r-anotify", `/srv/anotify/.pi-subagents-mirror/r-anotify/${REMOTE_NODE}`);

		// The transcript the read-back seam hands over (a real file: recovery grades it).
		const transcript = path.join(root, "mirror", "session.jsonl");
		mkdirSync(path.dirname(transcript), { recursive: true });
		writeFileSync(transcript, finishedTranscript("shipped it"));
		const readback = async () => ({
			ok: true as const,
			host: HOST,
			localPath: transcript,
			remotePath: `/srv/anotify/.pi-subagents-mirror/r-anotify/${REMOTE_NODE}/session.jsonl`,
			lines: 4,
			returned: 4,
			truncated: false,
			byteCapped: false,
		});
		const probeTerminal = async () => ({
			address: `${HOST}/lgl-450`,
			state: "finished",
			live: false,
			program: "done",
			exitCode: 0,
		});

		const recovered = await recoverAction({
			params: { name: REMOTE_NODE },
			legion: undefined,
			store: sessionStore,
			sessionFile: sessionRun.sessionFile,
			crossMachine: undefined,
			readback,
			probeTerminal,
		});
		const text = recovered.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
		assert.match(text, new RegExp(REMOTE_NODE), "the answer names the child it recovered");
		assert.match(text, /is over on 'hw-nj'/, `settled through the found ledger: ${text.slice(0, 200)}`);

		// The write landed in the FOREIGN ledger — not in this session's own store.
		const foreignDb = openLegionDb(foreignDbPath);
		try {
			assert.equal(getNode(foreignDb, REMOTE_NODE_ID)?.status, "settled");
		} finally {
			foreignDb.close();
		}
		assert.equal(
			existsSync(legionDbPath(sessionStore.runDir(sessionRun.runId))),
			false,
			"this session's store gains no ledger of its own",
		);
		// ...and the run record that mirrors it is the foreign one.
		const foreignRecord = JSON.parse(readFileSync(foreignRunFile, "utf8")) as { children: ChildRecord[] };
		assert.equal(foreignRecord.children[0]?.state, "retired", "the foreign record now says retired");
	});
});

test("#450 F: a `recover` miss names every store that was searched", async () => {
	await inTempHome(async ({ home }) => {
		const sessionCwd = path.join(home, "agent-run");
		const foreignCwd = path.join(home, "code", "anotify");
		mkdirSync(sessionCwd, { recursive: true });
		mkdirSync(foreignCwd, { recursive: true });
		const sessionStore = new RunStore({ rootDir: path.join(sessionCwd, STORE_DIR_NAME) });
		sessionStore.createRun({ task: "today's work", cwd: sessionCwd });
		const foreignRoot = path.join(foreignCwd, STORE_DIR_NAME);
		writeStoreRun(foreignRoot, { runId: "r-anotify", cwd: foreignCwd, children: [childRecord("other-0")] });

		const result = await recoverAction({
			params: { name: "nobody-here" },
			legion: undefined,
			store: sessionStore,
			sessionFile: undefined,
			crossMachine: undefined,
		});
		const text = result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
		assert.match(text, /No cross-machine child named "nobody-here"/);
		assert.match(text, /searched 2 stores/, "a widened miss lists what it looked at");
		assert.match(text, /~\/agent-run/, "this session's store, by label");
		assert.match(text, /~\/code\/anotify/, "and the store the scan added");
		assert.match(text, /Nothing is waiting for recovery|Waiting for recovery:/, "the actionable hint survives");
	});
});

// ── 6: ambiguity is always loud, never a cross-store pick ───────────────────

test("#450 6: a same-store ambiguity keeps its pre-#450 message, a cross-store one lists both stores", async () => {
	await inTempHome(async ({ root, home }) => {
		const cwd = path.join(home, "agents");
		mkdirSync(cwd, { recursive: true });
		const sessionRoot = path.join(cwd, STORE_DIR_NAME);
		// Two RUNS of the session store carry `dup-0`: the #312 path, untouched.
		writeStoreRun(sessionRoot, {
			runId: "r-a",
			cwd,
			children: [childRecord("dup-0", { agent: "worker" })],
			createdAt: "2026-01-01T00:00:00.000Z",
		});
		writeStoreRun(sessionRoot, {
			runId: "r-b",
			cwd,
			children: [childRecord("dup-0", { agent: "scout" })],
			createdAt: "2026-01-02T00:00:00.000Z",
		});
		// Two other stores each carry `worker-0`: the #450 path, which must refuse.
		writeStoreRun(path.join(home, "code", "anotify", STORE_DIR_NAME), {
			runId: "r-anotify",
			cwd: path.join(home, "code", "anotify"),
			children: [childRecord("worker-0", { agent: "centurion" })],
		});
		writeStoreRun(path.join(home, "code", "legion-demo", STORE_DIR_NAME), {
			runId: "r-demo",
			cwd: path.join(home, "code", "legion-demo"),
			children: [childRecord("worker-0", { agent: "worker" })],
		});

		const harness = indexHarness({ root, cwd });
		try {
			const sameStore = await harness.invoke({ action: "status", name: "dup-0" });
			assert.equal(sameStore.details?.error, "NOT_FOUND");
			assert.match(sameStore.text, /dup-0 is ambiguous: 2 nodes carry that name/);
			assert.match(sameStore.text, /Pass `runId` to name the run/);

			const crossStore = await harness.invoke({ action: "status", name: "worker-0" });
			assert.equal(crossStore.details?.error, "NOT_FOUND");
			assert.match(crossStore.text, /worker-0 is ambiguous: 2 stores hold a child with that name/);
			assert.match(crossStore.text, /store=~\/code\/anotify run=r-anotify/);
			assert.match(crossStore.text, /store=~\/code\/legion-demo run=r-demo/);
			assert.doesNotMatch(crossStore.text, /^worker-0 — state=/m, "nothing is rendered: it refused");
		} finally {
			await harness.cleanup();
		}
	});
});

// Keep the fixture honest: a run.json written by `writeStoreRun` is what RunStore reads.
test("#450: the fixture stores really parse through RunStore", async () => {
	await inTempHome(({ home }) => {
		const cwd = path.join(home, "agents");
		const rootDir = path.join(cwd, STORE_DIR_NAME);
		mkdirSync(cwd, { recursive: true });
		writeStoreRun(rootDir, { runId: "r-session", cwd, children: [childRecord("worker-0")] });
		const runs: RunRecord[] = new RunStore({ rootDir }).listRuns();
		assert.equal(runs.length, 1);
		assert.equal(runs[0]?.children[0]?.name, "worker-0");
		assert.equal(runs[0]?.cwd, cwd);
	});
});
