/**
 * #463 — the ghost `working` row: `status` said alive, `stop` said "not tracked".
 *
 * The measured shape: a child that finished and was retired still listed as a LIVE
 * child (`state=working`, `owner: live`, `supervisor=inprocess`) because `owner.json`'s
 * pid — the process that last wrote that run dir, i.e. usually the very `pi` reading it
 * — was alive, while `stop` found nothing to act on and answered
 * `unknown child: X (not tracked by this session)`.
 *
 * The contract (`docs/contracts/ghost-working-row-v1.md`) fixes two things and this
 * file pins both:
 *
 *  1. ONE predicate decides the row (`src/runs/unsupervised-row.ts`), so the two views
 *     cannot disagree: what `status` no longer calls live, `stop` settles;
 *  2. settling is NOT a death verdict — the ledger gets the child's graded outcome
 *     when its own transcript grades, else `retired` with `execution: unknown`
 *     (#460: an absent supervisor never judges a child dead).
 *
 * Storage is REAL: temp dirs, the real `RunStore` on disk, the real `legion.db`
 * schema, and the real `subagent` tool loaded from `index.ts`. A fake store would test
 * the fixture, not the fix.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";

import piLegion, { classifyChildrenForStatus, renderStatusOverview, type StatusLivenessFacts } from "../../index.ts";
import { renderLiveChildStatus } from "../../src/extension/runtime.ts";
import { legionDbPath, openLegionDb } from "../../src/legion/db.ts";
import { readEventsAfter } from "../../src/legion/events.ts";
import { getNode, insertNode } from "../../src/legion/nodes.ts";
import { RUN_OWNER_FILE, writeOwnerFile } from "../../src/runs/owner.ts";
import { RunStore } from "../../src/runs/store.ts";
import {
	findUnsupervisedRows,
	UNSUPERVISED_REASON,
	unsupervisedMarkOf,
	unsupervisedVerdict,
} from "../../src/runs/unsupervised-row.ts";
import type { ChildRecord } from "../../src/shared/types.ts";
import { FakeSupervisor } from "../helpers/fake-supervisor.ts";
import { assistantMsg, sessionHeader, userMsg } from "../helpers/fixtures.ts";

initTheme("dark");

const STAMP = "2026-01-01T00:00:00.000Z";
/** A pid that is alive but is NOT this process: another live session's marker. */
const FOREIGN_LIVE_PID = 1;

const SCOUT_FILE =
	"---\nname: scout\ndescription: read-only utility role\nutility: true\ntools: read, grep, find, ls\nkind: pi\n---\nscout prompt\n";
const WORKER_FILE = "---\nname: worker\ndescription: worker role\n---\nworker prompt\n";

const ENV_KEYS = [
	"PI_CODING_AGENT_DIR",
	"PI_HERDR_SUBAGENTS_EXTRA_AGENT_DIRS",
	"PI_SUBAGENT_CHILD",
	"PI_SUBAGENT_ALLOW_NESTED",
	"PI_LEGION_DB",
	"PI_LEGION_NODE_ID",
	"PI_SUBAGENTS_TEAM",
	"PI_SUBAGENT_ROLE",
	"PI_SUBAGENT_UTILITY_CHILD",
];

// ── fixtures ────────────────────────────────────────────────────────────────

/** A record the LAST session left saying `working` — the ghost's raw shape. */
function childRecord(name: string, over: Partial<ChildRecord> = {}): ChildRecord {
	return {
		name,
		sessionFile: `/tmp/does-not-exist-${name}.jsonl`,
		ownerToken: `tok-${name}`,
		state: "working",
		spawnedAt: STAMP,
		agent: "worker",
		kind: "pi",
		spawnMode: "inprocess",
		execution: { status: "running", reason: "collect deadline (per collect attempt) exceeded; child still alive" },
		...over,
	};
}

/** Write one `<root>/runs/<id>/run.json` by hand (a previous process's file). */
function writeStoreRun(
	rootDir: string,
	run: { runId: string; cwd: string; children: ChildRecord[]; sessionFile?: string; createdAt?: string },
): string {
	const runDir = path.join(rootDir, "runs", run.runId);
	mkdirSync(runDir, { recursive: true });
	const createdAt = run.createdAt ?? STAMP;
	const record = {
		schemaVersion: 1,
		runId: run.runId,
		task: "fixture",
		cwd: run.cwd,
		...(run.sessionFile !== undefined ? { sessionFile: run.sessionFile } : {}),
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
	return runDir;
}

/** Seed a REAL ledger beside that run: `root` + the child row, still `running`. */
function seedLedger(runDir: string, runId: string, name: string): { dbPath: string; nodeId: string } {
	const dbPath = legionDbPath(runDir);
	const db = openLegionDb(dbPath);
	const nodeId = `root.${name}`;
	try {
		insertNode(db, { parentId: null, name: "root", role: "root", runId }, () => Date.parse(STAMP));
		insertNode(db, { parentId: "root", name, role: "worker", status: "running", runId }, () => Date.parse(STAMP) + 1);
	} finally {
		db.close();
	}
	return { dbPath, nodeId };
}

/** A child transcript whose last turn completed — the graded `success` path. */
function writeCompletedTranscript(file: string): void {
	mkdirSync(path.dirname(file), { recursive: true });
	writeFileSync(
		file,
		[sessionHeader(), userMsg("do the work"), assistantMsg({ stopReason: "stop", text: '{"ok":true}' }), ""].join("\n"),
	);
}

interface TempHome {
	root: string;
	home: string;
}

/** A temp tree with its own `$HOME`, so the bounded store scan is hermetic (#450). */
async function inTempHome(fn: (ctx: TempHome) => Promise<void> | void): Promise<void> {
	const previousHome = process.env.HOME;
	const root = mkdtempSync(path.join(tmpdir(), "pi-legion-463-"));
	const home = path.join(root, "home");
	mkdirSync(home, { recursive: true });
	process.env.HOME = home;
	try {
		await fn({ root, home });
	} finally {
		if (previousHome === undefined) delete process.env.HOME;
		else process.env.HOME = previousHome;
		rmSync(root, { recursive: true, force: true });
	}
}

interface Harness {
	work: string;
	storeRoot: string;
	store: RunStore;
	invoke: (params: Record<string, unknown>) => Promise<{ text: string; details?: { error?: string; code?: string } }>;
	cleanup: () => Promise<void>;
}

/** The tool wiring: the REAL extension, a `FakeSupervisor` that holds nothing. */
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
		work: ctx.cwd,
		storeRoot: path.join(ctx.cwd, ".pi-subagents"),
		store: new RunStore({ rootDir: path.join(ctx.cwd, ".pi-subagents") }),
		async invoke(params) {
			const result = await tool.execute("ghost-row-test", params, undefined, undefined, {
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

// ── A: the predicate (one rule, three consumers) ─────────────────────────────

test("#463 A: a record this process holds is never a ghost", () => {
	const child = childRecord("worker-0");
	assert.equal(unsupervisedVerdict(child, { alive: true, tracked: false }), undefined, "a live supervisor entry holds it");
	assert.equal(unsupervisedVerdict(child, { alive: false, tracked: true }), undefined, "a job in the session table holds it");
	assert.equal(
		unsupervisedVerdict({ ...child, state: "retired" }, { alive: false, tracked: false, owner: "live", ownerPid: process.pid }),
		undefined,
		"history is never resurrected",
	);
	assert.equal(
		unsupervisedVerdict(
			{ ...child, host: "njbox", state: "orphaned", orphaned: { at: 1, fate: "orphaned", reason: "session-shutdown", host: "njbox" } },
			{ alive: false, tracked: false, owner: "dead" },
		),
		undefined,
		"#456's orphaned rows keep their own verdict and their own path",
	);
});

test("#463 A: another LIVE session's marker holds the row, a foreign-host marker too", () => {
	const child = childRecord("worker-0");
	assert.equal(
		unsupervisedVerdict(child, { alive: false, tracked: false, owner: "live", ownerPid: FOREIGN_LIVE_PID, pid: process.pid }),
		undefined,
		"a live pid that is not this process is another session holding the child",
	);
	assert.equal(
		unsupervisedVerdict(child, {
			alive: false,
			tracked: false,
			owner: "live",
			ownerPid: FOREIGN_LIVE_PID,
			ownerHost: "some-other-host",
			hostname: "this-host",
			pid: process.pid,
		}),
		undefined,
		// #456 review F8: a marker written on another host cannot be checked from here.
	);
});

test("#463 A: the ghost verdict names its evidence, for all three owner shapes", () => {
	const child = childRecord("worker-0");
	const self = unsupervisedVerdict(child, { alive: false, tracked: false, owner: "live", ownerPid: process.pid, pid: process.pid });
	assert.equal(self?.reason, UNSUPERVISED_REASON);
	assert.match(self?.evidence ?? "", new RegExp(`pid ${process.pid}`), "the evidence names the pid that lies");

	const dead = unsupervisedVerdict(child, { alive: false, tracked: false, owner: "dead", ownerPid: 2_147_483_000, pid: process.pid });
	assert.equal(dead?.reason, UNSUPERVISED_REASON);
	assert.match(dead?.evidence ?? "", /is gone/);

	const absent = unsupervisedVerdict(child, { alive: false, tracked: false, owner: "unknown" });
	assert.equal(absent?.reason, UNSUPERVISED_REASON);
	assert.match(absent?.evidence ?? "", /no owner marker/);
});

test("#463 A: discovery keeps the name/run scope and prefers the newest run", () => {
	const facts = { alive: false, tracked: false, owner: "dead" as const, ownerPid: 2_147_483_000 };
	const older = { runId: "r-old", createdAt: "2026-01-01T00:00:00.000Z", children: [childRecord("worker-0")] };
	const newer = { runId: "r-new", createdAt: "2026-02-01T00:00:00.000Z", children: [childRecord("worker-0")] };
	const found = findUnsupervisedRows([older, newer], { name: "worker-0", factsFor: () => facts });
	assert.deepEqual(found.map((row) => row.run.runId), ["r-new", "r-old"], "newest run first");
	assert.equal(findUnsupervisedRows([older, newer], { name: "worker-0", runId: "r-old", factsFor: () => facts }).length, 1, "an explicit run narrows, never widens");
	assert.equal(findUnsupervisedRows([older], { name: "someone-else", factsFor: () => facts }).length, 0);
});

// ── B: what the two surfaces render ─────────────────────────────────────────

test("#463 B: the state word is `unreachable (no supervisor)`, with its evidence under it", () => {
	const base = {
		name: "worker-0",
		state: "working",
		agent: "worker",
		kind: "pi",
		sessionFile: "/tmp/does-not-exist-worker-0.jsonl",
		alive: false,
	};
	const plain = renderLiveChildStatus({ ...base, owner: "live" });
	assert.match(plain, /^worker-0 — state=working/m, "the pre-#463 word, unchanged when no verdict is supplied");

	const ghost = renderLiveChildStatus({
		...base,
		owner: "live",
		unsupervised: { reason: "no supervisor", evidence: "run.json says working but this process holds no supervisor for it" },
	});
	assert.doesNotMatch(ghost, /state=working/, "the row must never read as working again");
	assert.match(ghost, /^worker-0 — state=unreachable \(no supervisor\) agent=worker kind=pi$/m);
	const lines = ghost.split("\n");
	assert.equal(lines[1], "unreachable: run.json says working but this process holds no supervisor for it", "evidence directly under the header");
	// Nothing else moved: dropping the one verdict line gives the plain block back.
	const stripped = lines.filter((line) => !line.startsWith("unreachable: ")).join("\n");
	assert.equal(stripped.replace("state=unreachable (no supervisor)", "state=working"), plain, "every other line keeps its text and place");
});

test("#463 B: the overview does not count a ghost live, and says how many are unreachable", () => {
	const ghost = childRecord("worker-0");
	const held = childRecord("worker-1");
	const runs = [{ runId: "r-1", createdAt: STAMP, children: [ghost, held] }];
	const facts: Record<string, StatusLivenessFacts> = {
		"worker-0": { alive: false, owner: "live", unsupervised: { reason: "no supervisor", evidence: "nobody holds it" } },
		"worker-1": { alive: true },
	};
	const classified = classifyChildrenForStatus(runs as never, (child) => facts[child.name]!);
	assert.equal(classified.find((entry) => entry.child.name === "worker-0")?.live, false, "a ghost is never live");
	assert.equal(classified.find((entry) => entry.child.name === "worker-1")?.live, true);

	const text = renderStatusOverview(classified.map((entry) => ({
		child: entry.child,
		alive: facts[entry.child.name]!.alive,
		live: entry.live,
		...(entry.child.name === "worker-0"
			? { owner: "live" as const, unsupervised: { reason: "no supervisor" as const, evidence: "nobody holds it" } }
			: {}),
	})));
	assert.match(text, /^Status · 1 live child \(1 unreachable\)$/m, "the ghost leaves the live count and gets its own bucket");
	assert.match(text, /^worker-0 — state=unreachable \(no supervisor\)/m);
	assert.match(text, /^worker-1 — state=working/m, "the held child keeps its word and its place");
});

// ── C: the acceptance — `status` must not say working, `stop` must settle ────

test("#463 C1: `status` refuses the `working` word and `stop` settles the row (owner pid = this process)", async () => {
	await inTempHome(async ({ root }) => {
		const cwd = path.join(root, "work");
		mkdirSync(cwd, { recursive: true });
		const h = indexHarness({ root, cwd });
		try {
			const runDir = writeStoreRun(h.storeRoot, { runId: "r-ghost", cwd, children: [childRecord("legion-460-unreachable")] });
			// The marker the bug rests on: the pid is this very process, so `owner: live`
			// is true and meaningless at the same time.
			writeOwnerFile(path.join(runDir, RUN_OWNER_FILE), process.pid);

			const overview = await h.invoke({ action: "status" });
			assert.doesNotMatch(overview.text, /state=working/, "the ghost must not be listed as working");
			assert.match(overview.text, /state=unreachable \(no supervisor\)/);
			assert.match(overview.text, /^Status · 0 live children \(1 unreachable\)$/m);

			const named = await h.invoke({ action: "status", name: "legion-460-unreachable" });
			assert.doesNotMatch(named.text, /state=working/);
			assert.match(named.text, /state=unreachable \(no supervisor\)/);

			const stopped = await h.invoke({ action: "stop", name: "legion-460-unreachable" });
			assert.equal(stopped.details?.error, undefined, `stop must settle, not fail: ${stopped.text}`);
			assert.match(stopped.text, /^Settled legion-460-unreachable\./m);

			const record = h.store.findChild("r-ghost", "legion-460-unreachable");
			assert.ok(record);
			assert.equal(record.state, "retired", "the record is settled");
			assert.equal(record.reclaimed?.verdict, "no-supervisor");
			assert.equal(record.unsupervised, undefined, "the ghost mark is spent");
			assert.equal(unsupervisedMarkOf(record), undefined);

			// And the two views agree afterwards: nothing lists it any more.
			const after = await h.invoke({ action: "status" });
			assert.doesNotMatch(after.text, /legion-460-unreachable/);
		} finally {
			await h.cleanup();
		}
	});
});

test("#463 C2: settling grades the child's own transcript into the ledger", async () => {
	await inTempHome(async ({ root }) => {
		const cwd = path.join(root, "work");
		mkdirSync(cwd, { recursive: true });
		const h = indexHarness({ root, cwd });
		try {
			const transcript = path.join(root, "sessions", "ghost-0.jsonl");
			writeCompletedTranscript(transcript);
			const runDir = writeStoreRun(h.storeRoot, {
				runId: "r-graded",
				cwd,
				children: [childRecord("ghost-0", { sessionFile: transcript, nodeId: "root.ghost-0" })],
			});
			writeOwnerFile(path.join(runDir, RUN_OWNER_FILE), process.pid);
			const { dbPath } = seedLedger(runDir, "r-graded", "ghost-0");

			const stopped = await h.invoke({ action: "stop", name: "ghost-0" });
			assert.equal(stopped.details?.error, undefined, stopped.text);
			assert.match(stopped.text, /^Settled ghost-0\./m);
			assert.match(stopped.text, /ledger settled \(execution: success\)/, "the graded outcome reaches the ledger, not a blind `retired`");

			const db = openLegionDb(dbPath);
			try {
				assert.equal(getNode(db, "root.ghost-0")?.status, "settled");
				const events = readEventsAfter(db, 0, { nodeId: "root.ghost-0" }).filter((event) => event.type === "node_settled");
				assert.equal(events.length, 1, "exactly one settle event");
				assert.equal((events[0]?.data as { reclaimed?: boolean } | undefined)?.reclaimed, true);
			} finally {
				db.close();
			}
			const record = h.store.findChild("r-graded", "ghost-0");
			assert.equal(record?.state, "retired");
			assert.equal(record?.execution?.status, "success", "the record carries the same outcome as the ledger");
		} finally {
			await h.cleanup();
		}
	});
});

test("#463 C3: a ghost in ANOTHER store is listed and settlable (the issue's exact shape)", async () => {
	await inTempHome(async ({ root, home }) => {
		const cwd = path.join(home, "agents");
		mkdirSync(cwd, { recursive: true });
		const h = indexHarness({ root, cwd });
		try {
			// The foreign store: a worktree's own `.pi-subagents`, exactly like the
			// issue's `store=~/code/pi-legion-wt-460`.
			const foreignCwd = path.join(home, "code", "pi-legion-wt-460");
			const foreignRoot = path.join(foreignCwd, ".pi-subagents");
			mkdirSync(foreignCwd, { recursive: true });
			const runDir = writeStoreRun(foreignRoot, { runId: "r-460", cwd: foreignCwd, children: [childRecord("legion-460-unreachable")] });
			writeOwnerFile(path.join(runDir, RUN_OWNER_FILE), process.pid);

			const overview = await h.invoke({ action: "status" });
			assert.doesNotMatch(overview.text, /state=working/);
			assert.match(overview.text, /state=unreachable \(no supervisor\)/);
			assert.match(overview.text, /store=/, "the foreign record says which store it came from");

			// NOTE: no `runId` — the ghost lives in another store's run, and `stop` has to
			// reach it from the same bounded surface `status` lists it on.
			const stopped = await h.invoke({ action: "stop", name: "legion-460-unreachable" });
			assert.equal(stopped.details?.error, undefined, `a listed row must be stoppable: ${stopped.text}`);
			assert.match(stopped.text, /^Settled legion-460-unreachable\./m);

			const foreign = new RunStore({ rootDir: foreignRoot });
			assert.equal(foreign.findChild("r-460", "legion-460-unreachable")?.state, "retired");
		} finally {
			await h.cleanup();
		}
	});
});

test("#463 C4: another live session's child is left exactly as it was", async () => {
	await inTempHome(async ({ root }) => {
		const cwd = path.join(root, "work");
		mkdirSync(cwd, { recursive: true });
		const h = indexHarness({ root, cwd });
		try {
			const runDir = writeStoreRun(h.storeRoot, { runId: "r-live", cwd, children: [childRecord("worker-9")] });
			writeOwnerFile(path.join(runDir, RUN_OWNER_FILE), FOREIGN_LIVE_PID);

			const overview = await h.invoke({ action: "status" });
			assert.match(overview.text, /state=working/, "a marker held by a live foreign session still reads working");
			assert.match(overview.text, /^Status · 1 live child$/m);
			assert.doesNotMatch(overview.text, /unreachable/, "and it is never called unreachable");
			assert.equal(h.store.findChild("r-live", "worker-9")?.state, "working", "status wrote nothing");
		} finally {
			await h.cleanup();
		}
	});
});
