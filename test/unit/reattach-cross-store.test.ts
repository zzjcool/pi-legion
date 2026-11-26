/**
 * #450 — the re-attach scan surface is "every store this machine plausibly knows
 * about", not just the session's own `<cwd>/.pi-subagents`.
 *
 * The measured defect: a child launched from `~/code/anotify` was invisible to a
 * session started in `~/agents` — `status` listed nothing and the automatic
 * re-attach #445 added never looked there. #450 widens WHICH STORES the pass reads
 * and nothing else: every #445 hard constraint (liveness is evidence, the owner
 * gate, the terminal gate, the `notifiedAt` latch, the setting, 3s/20/5s) survives
 * unchanged, and each case below names the clause it holds:
 *
 *   1. `§1` discovery carries each candidate's store (`storeRoot` / `storeCwd`,
 *      `run.json`'s existing `cwd` — no new field), store order preserved, newest
 *      run first inside a store, deduped by resolved rootDir, no cross-store
 *      dedupe of names;
 *   2. `§2` the pass merges `[store, ...stores]` and adopts a FOREIGN store's live
 *      child through the store it was read from, reporting the surface;
 *   3. `A3` the same child name in two stores is two children — separate claims,
 *      separate records, separate watcher entries, no cross-talk;
 *   4. `§3` the owner gate (#445 A2) and the terminal gate still decide BEFORE the
 *      wire, through the new surface;
 *   5. `§4` a bounded surface is reported (`truncated` + `skipped`) and a tiny
 *      budget defers candidates instead of running past the deadline;
 *   6. `§7` the notice latch spans stores — one owed notice per store, never twice;
 *   7. `§6` the summary is ONE line: byte-for-byte #445 when the adoption stayed in
 *      the session store, `— store <label>` when it did not;
 *   8. `§5` `subagents.reattachLiveChildren: false` still short-circuits the WHOLE
 *      pass, across stores.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { legionDbPath, openLegionDb } from "../../src/legion/db.ts";
import { insertNode } from "../../src/legion/nodes.ts";
import { readOwnerFile, RUN_OWNER_FILE, writeOwnerFile } from "../../src/runs/owner.ts";
import type { RemoteTerminalProbe } from "../../src/runs/remote-artifact.ts";
import {
	discoverReattachCandidates,
	discoverReattachCandidatesAcrossStores,
	formatReattachSummary,
	pendingReattachNotices,
	type ReattachReport,
	type ReattachStore,
	type ReattachWatchTarget,
	ReattachWatcher,
	runReattachPass,
	REATTACH_BUDGET_MS,
} from "../../src/runs/reattach.ts";
import { formatStoreLabel, STORE_DIR } from "../../src/runs/store-scan.ts";
import { RunStore } from "../../src/runs/store.ts";
import type { ChildRecord, CrossMachineSettings } from "../../src/shared/types.ts";

const HOST = "njbox";
/** A pid nobody holds: `process.kill` answers ESRCH, i.e. the owner is gone. */
const DEAD_PID = 2_147_483_000;

const CROSS_MACHINE: CrossMachineSettings = { enabled: true, hosts: { [HOST]: { cwd: "/srv/app" } } };

const noLines = async (): Promise<number> => 0;
const noMirrorOrphans = async (): Promise<Array<{ name: string; path: string }>> => [];
const silent = (): void => {};

// ── fixtures: several real stores under one `$HOME` tree ────────────────────

interface StoreHandle {
	/** `formatStoreLabel` of this store — what the log/summary must print. */
	label: string;
	/** The cwd its runs were launched from. */
	cwd: string;
	store: RunStore;
}

interface Workspace {
	root: string;
	/** A temp `$HOME`, so labels are `~/…` without touching this machine's home. */
	home: string;
	/** This session's transcript (never one of the seeded runs' own). */
	session: string;
	store(name: string): StoreHandle;
	cleanup(): void;
}

/**
 * `home/<name>/.pi-subagents` — the real thing `discoverLocalStores` would find.
 *
 * One shared monotonic clock makes `createdAt` strictly increasing across the
 * whole workspace, so "newest run first inside a store" is testable without
 * sleeping (two `RunStore`s created in the same millisecond would tie).
 */
function workspace(prefix = "reattach-cross-"): Workspace {
	const root = mkdtempSync(path.join(tmpdir(), prefix));
	const home = path.join(root, "home");
	mkdirSync(home, { recursive: true });
	const session = path.join(root, "sessions", "new.jsonl");
	mkdirSync(path.dirname(session), { recursive: true });
	writeFileSync(session, "");
	let clock = Date.parse("2024-01-01T00:00:00.000Z");
	const tick = () => (clock += 1_000);
	return {
		root,
		home,
		session,
		store(name: string): StoreHandle {
			const cwd = path.join(home, name);
			mkdirSync(cwd, { recursive: true });
			const rootDir = path.join(cwd, STORE_DIR);
			return { label: formatStoreLabel(rootDir, { home }), cwd, store: new RunStore({ rootDir, now: tick }) };
		},
		cleanup: () => rmSync(root, { recursive: true, force: true }),
	};
}

/** One persisted child record, in the shape the orchestrator writes at launch. */
function childRecord(overrides: Partial<ChildRecord> = {}): ChildRecord {
	const name = overrides.name ?? "worker-0";
	return {
		name,
		// For a cross-machine child this path is the empty LOCAL placeholder (S1).
		sessionFile: "/tmp/placeholder.jsonl",
		ownerToken: "tok",
		state: "working",
		spawnedAt: new Date(Date.now() - 60_000).toISOString(),
		host: HOST,
		remoteDir: path.posix.join("/srv/.pi-subagents-mirror", `r-${name}`, name),
		remoteTerminal: `${HOST}/t-${name}`,
		nodeId: `root.${name}`,
		...overrides,
	};
}

interface Leftover {
	handle: StoreHandle;
	runId: string;
	runDir: string;
	name: string;
}

/**
 * A store exactly as a previous session left it in ANOTHER cwd: `run.json` written
 * by `RunStore`, the ledger beside it, and an `owner.json` whose pid is DEAD (a
 * restart) — the same files a killed `pi` leaves behind, in a different directory.
 */
async function seedLeftover(
	handle: StoreHandle,
	opts: {
		name?: string;
		state?: ChildRecord["state"];
		/** The ledger row's status; `"none"` seeds no ledger at all. */
		ledgerStatus?: "running" | "settled" | "retired" | "failed" | "none";
		ownerPid?: number;
		overrides?: Partial<ChildRecord>;
	} = {},
): Promise<Leftover> {
	const name = opts.name ?? "worker-0";
	const terminal = `${HOST}/t-${name}`;
	const previousSession = path.join(handle.cwd, ".pi-sessions", `${name}-previous.jsonl`);
	mkdirSync(path.dirname(previousSession), { recursive: true });
	writeFileSync(previousSession, "");
	const run = handle.store.createRun({ task: `task ${name}`, cwd: handle.cwd, sessionFile: previousSession });
	const runDir = handle.store.runDir(run.runId);
	const nodeId = `root.${name}`;
	const remoteDir = path.posix.join("/srv/.pi-subagents-mirror", run.runId, name);
	await handle.store.addChild(run.runId, childRecord({
		name,
		nodeId,
		remoteDir,
		remoteTerminal: terminal,
		...(opts.state !== undefined ? { state: opts.state } : {}),
		...opts.overrides,
	}));
	// AFTER the store write: `writeRun` stamps ITS pid the first time a run is
	// written, and this file is the "who holds this child" fact the gate reads.
	writeOwnerFile(path.join(runDir, RUN_OWNER_FILE), opts.ownerPid ?? DEAD_PID);
	const ledgerStatus = opts.ledgerStatus ?? "running";
	if (ledgerStatus !== "none") {
		const db = openLegionDb(legionDbPath(runDir));
		try {
			insertNode(db, { id: "root", parentId: null, name: "root", role: "root", kind: "pi", depth: 0, runId: run.runId, status: "running" });
			insertNode(db, {
				parentId: "root",
				name,
				role: "worker",
				kind: "pi",
				status: ledgerStatus,
				host: HOST,
				remoteDir,
				remoteTerminal: terminal,
				sessionFile: "/tmp/placeholder.jsonl",
			});
		} finally {
			db.close();
		}
	}
	return { handle, runId: run.runId, runDir, name };
}

/** A probe that answers "still running" for every host. */
function liveProbe(): (request: { host: string; name: string }) => Promise<RemoteTerminalProbe> {
	return async (request) => ({ address: `${request.host}/t-${request.name}`, state: "live", live: true, program: "working" });
}

// ── 1. discovery across stores ─────────────────────────────────────────────

test("#450 §1: discovery carries each candidate's store and launch cwd, store order, newest run first, deduped by rootDir", async () => {
	const w = workspace("reattach-cross-discovery-");
	try {
		const anotify = w.store("anotify");
		const agents = w.store("agents");
		const older = await seedLeftover(anotify, { name: "anotify-old" });
		const newer = await seedLeftover(anotify, { name: "anotify-new" });
		const foreign = await seedLeftover(agents, { name: "agents-0" });

		const candidates = discoverReattachCandidatesAcrossStores([anotify.store, agents.store], { sessionFile: w.session });
		// Store order first, then newest run first INSIDE a store.
		assert.deepEqual(candidates.map((candidate) => candidate.name), ["anotify-new", "anotify-old", "agents-0"]);
		const [newest, oldest, foreignCandidate] = candidates;
		assert.equal(newest!.storeRoot, path.resolve(anotify.store.rootDir));
		assert.equal(newest!.storeCwd, anotify.cwd);
		assert.equal(oldest!.storeRoot, path.resolve(anotify.store.rootDir));
		assert.equal(foreignCandidate!.storeRoot, path.resolve(agents.store.rootDir));
		assert.equal(foreignCandidate!.storeCwd, agents.cwd);
		// The per-store reader keeps its #445 signature and now carries the store too.
		assert.deepEqual(
			discoverReattachCandidates(older.handle.store, { sessionFile: w.session }).map((candidate) => candidate.storeRoot),
			[path.resolve(anotify.store.rootDir), path.resolve(anotify.store.rootDir)],
		);

		// Deduped by resolved rootDir: the same store twice is read once.
		assert.equal(discoverReattachCandidatesAcrossStores([anotify.store, anotify.store, agents.store], { sessionFile: w.session }).length, 3);
		// No cross-store dedupe of NAMES: identity is (storeRoot, runId, name).
		await seedLeftover(agents, { name: "anotify-new" });
		assert.equal(
			discoverReattachCandidatesAcrossStores([anotify.store, agents.store], { sessionFile: w.session }).filter((candidate) => candidate.name === "anotify-new").length,
			2,
		);
		// Sanity: the seeded runs are distinct, not one record read twice.
		assert.notEqual(newer.runId, older.runId);
		assert.notEqual(newer.runId, foreign.runId);
	} finally {
		w.cleanup();
	}
});

test("#450 §1: a run.json without `cwd` falls back to dirname(storeRoot) — no new run.json field", () => {
	const w = workspace("reattach-cross-legacy-");
	try {
		const cwd = path.join(w.home, "legacy");
		mkdirSync(cwd, { recursive: true });
		const rootDir = path.join(cwd, STORE_DIR);
		// A legacy record: `run.json` never carried a cwd for the store to read.
		const legacy: ReattachStore = {
			rootDir,
			listRuns: () => [{ runId: "r-legacy", createdAt: new Date(0).toISOString(), children: [childRecord({ name: "legacy-0" })] }],
			runDir: (runId) => path.join(rootDir, "runs", runId),
		};
		const [candidate] = discoverReattachCandidates(legacy, { sessionFile: w.session });
		assert.ok(candidate);
		assert.equal(candidate!.storeRoot, path.resolve(rootDir));
		assert.equal(candidate!.storeCwd, path.dirname(path.resolve(rootDir)));
		assert.equal(candidate!.storeCwd, cwd);
	} finally {
		w.cleanup();
	}
});

// ── 2. the pass across stores ──────────────────────────────────────────────

test("#450 §2: a session store with no runs still adopts a foreign store's live child, and names that store", async () => {
	const w = workspace("reattach-cross-adopt-");
	try {
		const anotify = w.store("anotify");
		const agents = w.store("agents"); // the session cwd store: empty
		const leftover = await seedLeftover(anotify);

		const report = await runReattachPass({
			store: agents.store,
			stores: [anotify.store],
			home: w.home,
			sessionFile: w.session,
			settings: { crossMachine: CROSS_MACHINE },
			probeTerminal: liveProbe(),
			remoteLines: noLines,
			listMirrorOrphans: noMirrorOrphans,
			log: silent,
		});

		assert.equal(report.adopted.length, 1);
		assert.equal(report.adopted[0]!.name, leftover.name);
		assert.equal(report.adopted[0]!.storeRoot, path.resolve(anotify.store.rootDir));
		assert.equal(report.adopted[0]!.storeCwd, anotify.cwd);
		assert.equal(report.sessionStoreRoot, path.resolve(agents.store.rootDir));
		assert.equal(report.stores.scanned, 2);
		assert.equal(report.stores.withRuns, 1);
		assert.equal(report.stores.candidates, 1);
		assert.equal(report.stores.truncated, false);
		assert.equal(report.considered, 1);

		// The record in the FOREIGN store is re-opened, and the claim landed there.
		const record = anotify.store.findChild(leftover.runId, leftover.name)!;
		assert.equal(record.state, "working");
		assert.equal(record.reattached?.host, HOST);
		assert.equal(readOwnerFile(path.join(leftover.runDir, RUN_OWNER_FILE))?.pid, process.pid);

		const summary = formatReattachSummary(report, { home: w.home });
		assert.equal(summary, `legion: reattached 1 live child (${leftover.name}) — store ${anotify.label}`);
		assert.equal(summary!.includes("\n"), false);
		assert.match(summary!, /— store ~\/anotify$/);
	} finally {
		w.cleanup();
	}
});

// ── 3. acceptance 3: same name in two stores, no cross-talk ────────────────

test("#450 A3: the same child name in two stores is two children — own claim, own record, own watcher entry", async () => {
	const w = workspace("reattach-cross-dupe-");
	try {
		const anotify = w.store("anotify");
		const agents = w.store("agents");
		const session = w.store("session"); // empty: phase 1 sees ONLY anotify
		const a = await seedLeftover(anotify, { name: "worker-0" });
		const b = await seedLeftover(agents, { name: "worker-0", state: "orphaned" });
		assert.notEqual(a.runId, b.runId);

		// ── phase 1: only store A is in the surface ────────────────────────────
		const first = await runReattachPass({
			store: session.store,
			stores: [anotify.store],
			home: w.home,
			sessionFile: w.session,
			settings: { crossMachine: CROSS_MACHINE },
			probeTerminal: liveProbe(),
			remoteLines: noLines,
			listMirrorOrphans: noMirrorOrphans,
			log: silent,
		});
		assert.equal(first.adopted.length, 1);
		assert.equal(first.adopted[0]!.storeRoot, path.resolve(anotify.store.rootDir));
		// Store B was never read, so its record and its claim are untouched: the
		// foreign adoption did not reach across stores.
		const untouched = agents.store.findChild(b.runId, "worker-0")!;
		assert.equal(untouched.state, "orphaned");
		assert.equal(untouched.reattached, undefined);
		assert.equal(readOwnerFile(path.join(b.runDir, RUN_OWNER_FILE))?.pid, DEAD_PID);

		// ── phase 2: both stores in one pass, same child name ──────────────────
		const second = await runReattachPass({
			store: agents.store,
			stores: [anotify.store],
			home: w.home,
			sessionFile: w.session,
			settings: { crossMachine: CROSS_MACHINE },
			probeTerminal: liveProbe(),
			remoteLines: noLines,
			listMirrorOrphans: noMirrorOrphans,
			log: silent,
		});
		assert.equal(second.adopted.length, 2, `same name must not be deduped across stores: ${JSON.stringify(second.skipped)}`);
		assert.deepEqual(
			new Set(second.adopted.map((child) => `${child.storeRoot}/${child.runId}`)),
			new Set([`${path.resolve(anotify.store.rootDir)}/${a.runId}`, `${path.resolve(agents.store.rootDir)}/${b.runId}`]),
		);
		// Each run dir got its OWN claim, and each record its own mark.
		assert.equal(readOwnerFile(path.join(a.runDir, RUN_OWNER_FILE))?.pid, process.pid);
		assert.equal(readOwnerFile(path.join(b.runDir, RUN_OWNER_FILE))?.pid, process.pid);
		assert.equal(anotify.store.findChild(a.runId, "worker-0")!.reattached?.host, HOST);
		assert.equal(agents.store.findChild(b.runId, "worker-0")!.reattached?.host, HOST);

		// The watcher: two entries — the store is part of the identity.
		const settled: string[] = [];
		const watcher = new ReattachWatcher({
			probe: async () => ({ address: "x", state: "finished", live: false }),
			settle: async (target: ReattachWatchTarget) => {
				settled.push(`${target.storeRoot}/${target.runId}`);
				return { kind: "settled-now", recovery: undefined };
			},
			notify: () => true,
			markNotified: async () => {},
			log: silent,
		});
		for (const child of second.adopted) {
			watcher.add({
				storeRoot: child.storeRoot,
				storeCwd: child.storeCwd,
				runId: child.runId,
				name: child.name,
				host: child.host,
				ledgerDbPath: child.ledgerDbPath,
			});
		}
		assert.equal(watcher.watching().length, 2);

		// The sharp case: two stores holding the SAME runId + name. Without the store
		// in the key the second `add` would overwrite the first, so one child would
		// never be settled or announced.
		const keys: string[] = [];
		const sameKeys = new ReattachWatcher({
			probe: async () => ({ address: "x", state: "finished", live: false }),
			settle: async (target: ReattachWatchTarget) => {
				keys.push(`${target.storeRoot}/${target.runId}/${target.name}`);
				return { kind: "settled-now", recovery: undefined };
			},
			notify: () => true,
			markNotified: async () => {},
			log: silent,
		});
		for (const storeRoot of ["/s/store-a", "/s/store-b"]) {
			sameKeys.add({ storeRoot, runId: "r-same", name: "worker-0", host: HOST, ledgerDbPath: `${storeRoot}/runs/r-same/legion.db` });
		}
		assert.equal(sameKeys.watching().length, 2, "same runId+name in two stores must not collide");
		await sameKeys.tick();
		assert.deepEqual(keys.sort(), ["/s/store-a/r-same/worker-0", "/s/store-b/r-same/worker-0"]);
		assert.equal(sameKeys.watching().length, 0, "a settled child is still deleted");
	} finally {
		w.cleanup();
	}
});

// ── 4. the gates still decide before the wire ──────────────────────────────

test("#450 §3 (regression of #445 A2): a live owner pid in a FOREIGN store gates the candidate before any probe", async () => {
	const w = workspace("reattach-cross-owned-");
	const { spawn } = await import("node:child_process");
	// A pid that is certainly alive and is not this process: node itself.
	const other = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
	try {
		const anotify = w.store("anotify");
		const agents = w.store("agents");
		const leftover = await seedLeftover(anotify, { ownerPid: other.pid! });
		let probes = 0;

		const report = await runReattachPass({
			store: agents.store,
			stores: [anotify.store],
			home: w.home,
			sessionFile: w.session,
			settings: { crossMachine: CROSS_MACHINE },
			probeTerminal: async (request) => {
				probes += 1;
				return { address: `${request.host}/t`, state: "live", live: true };
			},
			remoteLines: noLines,
			listMirrorOrphans: noMirrorOrphans,
			log: silent,
		});

		assert.equal(report.adopted.length, 0);
		assert.equal(probes, 0, "the owner gate decides before the wire");
		assert.equal(report.skipped.length, 1);
		assert.ok(report.skipped[0]!.reason.startsWith("owned by"), report.skipped[0]!.reason);
		assert.match(report.skipped[0]!.reason, /is alive, so that session still holds this child/);
		// Untouched: the record still says what the last session left.
		const record = anotify.store.findChild(leftover.runId, leftover.name)!;
		assert.equal(record.state, "working");
		assert.equal(record.reattached, undefined);
		assert.equal(readOwnerFile(path.join(leftover.runDir, RUN_OWNER_FILE))?.pid, other.pid);
	} finally {
		other.kill("SIGKILL");
		w.cleanup();
	}
});

test("#450 §3 (terminal gate): a settled/retired ledger row in a FOREIGN store is skipped and never probed", async () => {
	const w = workspace("reattach-cross-ended-");
	try {
		const anotify = w.store("anotify");
		const agents = w.store("agents");
		const leftover = await seedLeftover(anotify, { state: "orphaned", ledgerStatus: "retired" });
		let probes = 0;

		const report = await runReattachPass({
			store: agents.store,
			stores: [anotify.store],
			home: w.home,
			sessionFile: w.session,
			settings: { crossMachine: CROSS_MACHINE },
			probeTerminal: async (request) => {
				probes += 1;
				return { address: `${request.host}/t`, state: "live", live: true };
			},
			remoteLines: noLines,
			listMirrorOrphans: noMirrorOrphans,
			log: silent,
		});

		assert.equal(probes, 0, "a settled/retired row is decided by the ledger, not the machine");
		assert.equal(report.considered, 0);
		assert.equal(report.adopted.length, 0);
		assert.equal(report.skipped.length, 1);
		assert.match(report.skipped[0]!.reason, /already ended \(retired\)/);
		assert.match(report.skipped[0]!.reason, /not adopted and not announced/);
		const record = anotify.store.findChild(leftover.runId, leftover.name)!;
		assert.equal(record.state, "orphaned");
		assert.equal(record.reattached, undefined);
	} finally {
		w.cleanup();
	}
});

// ── 5. bounded ─────────────────────────────────────────────────────────────

test("#450 §4: the bounded surface is reported (truncated + skipped entries, one log line each)", async () => {
	const w = workspace("reattach-cross-truncated-");
	try {
		const anotify = w.store("anotify");
		const agents = w.store("agents");
		await seedLeftover(anotify);
		const lines: string[] = [];
		const reason = "over the 32-store cap (home); a later session with fewer stores looks again";

		const report = await runReattachPass({
			store: agents.store,
			stores: [anotify.store],
			home: w.home,
			sessionFile: w.session,
			storeScan: { truncated: true, scannedDirs: 12, skipped: [{ dir: path.join(w.home, "code"), reason }] },
			settings: { crossMachine: CROSS_MACHINE },
			probeTerminal: liveProbe(),
			remoteLines: noLines,
			listMirrorOrphans: noMirrorOrphans,
			log: (line) => lines.push(line),
		});

		assert.equal(report.stores.truncated, true);
		assert.equal(report.stores.scanned, 2);
		assert.equal(report.stores.withRuns, 1);
		assert.equal(report.stores.candidates, 1);
		assert.equal(report.stores.skipped.length, 1);
		assert.equal(report.stores.skipped[0]!.store, "~/code");
		assert.equal(report.stores.skipped[0]!.reason, reason);
		// ONE surface line, and one sentence per store we refused to read.
		assert.equal(lines.filter((line) => /reattach stores=/.test(line)).length, 1);
		assert.ok(
			lines.some((line) => /reattach stores=2 withRuns=1 candidates=1 scannedDirs=12 truncated=true/.test(line)),
			lines.join("\n"),
		);
		assert.ok(lines.some((line) => line.includes(`skipped store ~/code: ${reason}`)), lines.join("\n"));
		// The candidate line names its store too.
		assert.ok(lines.some((line) => /adopted worker-0 .*store=~\/anotify/.test(line)), lines.join("\n"));
	} finally {
		w.cleanup();
	}
});

test("#450 §4: a tiny budget DEFERS foreign candidates instead of running past the deadline", async () => {
	const w = workspace("reattach-cross-budget-");
	try {
		const anotify = w.store("anotify");
		const agents = w.store("agents");
		// The session store's candidate is probed first; the FOREIGN one must be the
		// one deferred when the budget is gone (no sleeping, no wall-clock luck).
		await seedLeftover(agents, { name: "mine-0" });
		await seedLeftover(anotify, { name: "theirs-0" });
		let clock = 1_000_000;
		let probes = 0;

		const report = await runReattachPass({
			store: agents.store,
			stores: [anotify.store],
			home: w.home,
			sessionFile: w.session,
			settings: { crossMachine: CROSS_MACHINE },
			now: () => clock,
			probeTerminal: async () => {
				probes += 1;
				// This one probe consumed the whole budget.
				clock += 10_000;
				return { address: `${HOST}/t`, state: "live", live: true, program: "working" };
			},
			remoteLines: noLines,
			listMirrorOrphans: noMirrorOrphans,
			log: silent,
			budgetMs: 100,
		});

		assert.equal(probes, 1, "the pass stops probing once its budget is gone");
		assert.equal(report.considered, 1);
		assert.equal(report.adopted.length, 1);
		assert.equal(report.adopted[0]!.storeRoot, path.resolve(agents.store.rootDir));
		assert.equal(report.deferred, 1, "the FOREIGN candidate is deferred, not silently dropped");
		assert.equal(report.stores.candidates, 2);
		assert.equal(report.elapsedMs, 10_000, "the pass reports its own elapsed time, it does not run past it");
		assert.match(formatReattachSummary({ ...report, adopted: [], mirrorOnly: [] }) ?? "", /the next start retries/);
	} finally {
		w.cleanup();
	}
});

// ── 6. the latch across stores ─────────────────────────────────────────────

test("#450 §7: pendingReattachNotices spans stores — one owed notice per store, never twice", async () => {
	const w = workspace("reattach-cross-latch-");
	try {
		const anotify = w.store("anotify");
		const agents = w.store("agents");
		const owed = {
			state: "retired" as const,
			execution: { status: "success" as const },
			reattached: { at: 1, host: HOST, evidence: "x" },
		};
		await seedLeftover(anotify, { name: "anotify-0", overrides: owed });
		const b = await seedLeftover(agents, { name: "agents-0", overrides: owed });

		const pending = pendingReattachNotices([anotify.store, agents.store]);
		assert.equal(pending.length, 2);
		assert.deepEqual(pending.map((entry) => path.basename(entry.storeCwd)).sort(), ["agents", "anotify"]);
		assert.deepEqual(
			new Set(pending.map((entry) => entry.storeRoot)),
			new Set([path.resolve(anotify.store.rootDir), path.resolve(agents.store.rootDir)]),
		);
		// The same store twice owes its notice once (deduped by resolved rootDir)…
		assert.equal(pendingReattachNotices([anotify.store, anotify.store, agents.store]).length, 2);
		// …and the #445 single-store call still works.
		assert.equal(pendingReattachNotices(anotify.store).length, 1);

		// A delivered send writes the latch in ITS store: that one owes nothing.
		await agents.store.updateChild(b.runId, b.name, (child) => {
			if (child.reattached) child.reattached.notifiedAt = 7;
		});
		const after = pendingReattachNotices([anotify.store, agents.store]);
		assert.equal(after.length, 1);
		assert.equal(after[0]!.name, "anotify-0");
		assert.equal(after[0]!.storeRoot, path.resolve(anotify.store.rootDir));
	} finally {
		w.cleanup();
	}
});

// ── 7. the summary: one line, unchanged unless a foreign store was adopted ──

function adoptedChild(name: string, store: { label: string; cwd: string; store: RunStore }): ReattachReport["adopted"][number] {
	return {
		name,
		host: HOST,
		runId: `r-${name}`,
		storeRoot: path.resolve(store.store.rootDir),
		storeCwd: store.cwd,
		evidence: "terminal 'njbox/t' is live (working)",
		ledgerDbPath: path.join(store.store.rootDir, "runs", `r-${name}`, "legion.db"),
	};
}

function reportOf(
	adopted: ReattachReport["adopted"],
	sessionStore: { store: RunStore },
	extra: Partial<ReattachReport> = {},
): ReattachReport {
	return {
		disabled: false,
		considered: adopted.length,
		adopted,
		skipped: [],
		mirrorOnly: [],
		deferred: 0,
		elapsedMs: 0,
		budgetMs: REATTACH_BUDGET_MS,
		sessionStoreRoot: path.resolve(sessionStore.store.rootDir),
		stores: { scanned: 1, withRuns: adopted.length > 0 ? 1 : 0, candidates: adopted.length, truncated: false, skipped: [] },
		...extra,
	};
}

test("#450 §6: the summary stays byte-for-byte #445 when every adoption came from the session store", () => {
	const w = workspace("reattach-cross-summary-same-");
	try {
		const agents = w.store("agents");
		const home = w.home;
		assert.equal(
			formatReattachSummary(reportOf([adoptedChild("worker-0", agents)], agents), { home }),
			"legion: reattached 1 live child (worker-0)",
		);
		assert.equal(
			formatReattachSummary(reportOf([adoptedChild("a", agents), adoptedChild("b", agents)], agents), { home }),
			"legion: reattached 2 live children (a, b)",
		);
		// Without `home` too: a same-store adoption never prints a store at all.
		assert.equal(
			formatReattachSummary(reportOf([adoptedChild("worker-0", agents)], agents)),
			"legion: reattached 1 live child (worker-0)",
		);
	} finally {
		w.cleanup();
	}
});

test("#450 §6: a foreign adoption appends `— store <label>` / `— stores <label>, <label>` (order, deduped) before any `; ` suffix", () => {
	const w = workspace("reattach-cross-summary-foreign-");
	try {
		const anotify = w.store("anotify");
		const agents = w.store("agents");
		const piAsync = w.store("pi-async");
		const home = w.home;

		assert.equal(
			formatReattachSummary(reportOf([adoptedChild("worker-0", anotify)], agents), { home }),
			"legion: reattached 1 live child (worker-0) — store ~/anotify",
		);
		// Adoption order, deduped: two children from `~/anotify` are named once.
		assert.equal(
			formatReattachSummary(
				reportOf([adoptedChild("x", anotify), adoptedChild("y", piAsync), adoptedChild("z", anotify)], agents),
				{ home },
			),
			"legion: reattached 3 live children (x, y, z) — stores ~/anotify, ~/pi-async",
		);
		// Session store + foreign store in one pass: only the foreign one is named.
		assert.equal(
			formatReattachSummary(reportOf([adoptedChild("mine", agents), adoptedChild("theirs", anotify)], agents), { home }),
			"legion: reattached 2 live children (mine, theirs) — store ~/anotify",
		);
		// The deferred suffix still comes AFTER the store suffix, and it is one line.
		const deferred = formatReattachSummary(
			reportOf([adoptedChild("worker-0", anotify)], agents, { deferred: 2 }),
			{ home },
		);
		assert.equal(deferred, "legion: reattached 1 live child (worker-0) — store ~/anotify; (2 more not probed within 5s — the next start retries)");
		assert.equal(deferred!.includes("\n"), false);
	} finally {
		w.cleanup();
	}
});

// ── 8. the setting still short-circuits the whole pass ─────────────────────

test("#445 §5 through #450: `reattachLiveChildren: false` disables the WHOLE pass across stores", async () => {
	const w = workspace("reattach-cross-disabled-");
	try {
		const anotify = w.store("anotify");
		const agents = w.store("agents");
		const leftover = await seedLeftover(anotify);
		let probes = 0;

		const report = await runReattachPass({
			store: agents.store,
			stores: [anotify.store],
			home: w.home,
			sessionFile: w.session,
			settings: { crossMachine: CROSS_MACHINE, reattachLiveChildren: false },
			probeTerminal: async () => {
				probes += 1;
				return { address: `${HOST}/t`, state: "live", live: true };
			},
			remoteLines: noLines,
			listMirrorOrphans: noMirrorOrphans,
			log: silent,
		});

		assert.equal(report.disabled, true);
		assert.equal(probes, 0, "a disabled pass never touches the wire, in any store");
		assert.equal(report.adopted.length, 0);
		assert.equal(report.stores.candidates, 0, "a disabled pass does not even scan the other stores");
		assert.equal(formatReattachSummary(report), undefined);
		// The foreign record is exactly as the previous session left it.
		const record = anotify.store.findChild(leftover.runId, leftover.name)!;
		assert.equal(record.state, "working");
		assert.equal(record.reattached, undefined);
		assert.equal(readOwnerFile(path.join(leftover.runDir, RUN_OWNER_FILE))?.pid, DEAD_PID);
	} finally {
		w.cleanup();
	}
});
