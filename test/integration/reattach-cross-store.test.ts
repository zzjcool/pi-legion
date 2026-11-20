/**
 * #450 — the re-attach scan surface across stores, end to end.
 *
 * #445 pinned "the same cwd, a replaced session". The measured defect this file
 * pins is the other half: the leftover was launched from `~/code/anotify`, the new
 * session starts in `~/agents`, and `status`/`recover` never looked there.
 *
 * Fidelity: the REAL `hc` client against the fake core (real JSON-RPC over a real
 * child process, real terminal state that survives the client), the REAL
 * `recoverCrossMachineChild` grading/settle ladder, and REAL run stores on disk —
 * three of them, in three different directories, all under one `$HOME` tree so the
 * discovery rule itself (not an injected list) is what makes them visible.
 *
 * Every case names the #450 clause it holds:
 *
 *   1. A1 — a session in a DIFFERENT cwd adopts the leftover, `status` shows it
 *      with `store=~/code/anotify`, and the completion notice arrives on its own;
 *   2. A2 — three stores with live rows are all adopted in ONE pass, and the pass
 *      stays inside the #445 5s budget;
 *   3. A3 — the same child name in two stores never collides: `(store,cwd,name)`
 *      is the identity, so adopting/settling one leaves the other untouched;
 *   4. A4 — the mutation: without the widened surface the foreign leftover is
 *      invisible (this is what makes A1 red when the scan reverts to per-cwd);
 *   5. A5 — an unreachable machine and a capped store surface are reasons in the
 *      report/log, and the pass still returns instead of holding session start.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { hcCliClient } from "../../src/hc/client.ts";
import { legionDbPath, openLegionDb } from "../../src/legion/db.ts";
import { getNode, insertNode } from "../../src/legion/nodes.ts";
import { RUN_OWNER_FILE, ownerState, readOwnerFile, writeOwnerFile } from "../../src/runs/owner.ts";
import { createRemoteTerminalProbe } from "../../src/runs/remote-artifact.ts";
import {
	createReattachSettle,
	discoverReattachCandidatesAcrossStores,
	formatReattachSummary,
	pendingReattachNotices,
	type ReattachReport,
	type ReattachStore,
	ReattachWatcher,
	runReattachPass,
} from "../../src/runs/reattach.ts";
import { discoverLocalStores, formatStoreLabel } from "../../src/runs/store-scan.ts";
import { RunStore } from "../../src/runs/store.ts";
import { renderLiveChildStatus } from "../../src/extension/runtime.ts";
import type { ChildRecord, CrossMachineSettings } from "../../src/shared/types.ts";
import { assistantMsg, modelChange, sessionHeader, userMsg } from "../helpers/fixtures.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE_CORE = path.resolve(HERE, "../helpers/fake-hc-core.mjs");
const HOST = "njbox";

/** `~` for the scan under test — a temp tree, never this machine's real home. */
interface StoreFixture {
	label: string;
	cwd: string;
	store: RunStore;
	runId: string;
	runDir: string;
	dbPath: string;
	name: string;
	nodeId: string;
	remoteDir: string;
	remoteSessionPath: string;
	previousSession: string;
	terminal?: string;
}

interface Harness {
	root: string;
	home: string;
	/** Session B: where the NEW session starts (a different cwd by design). */
	newCwd: string;
	newStore: RunStore;
	newSession: string;
	remoteRoot: string;
	remoteCwd: string;
	terminalsFile: string;
	coreLog: string;
	settings: CrossMachineSettings;
	cleanup: () => void;
	/** Create one store directory under `$HOME` (relative path, e.g. "code/anotify"). */
	storeAt: (relative: string) => { cwd: string; store: RunStore };
	/** Seed the leftover a previous session left in `store` (record + ledger + owner). */
	seed: (input: {
		at: { cwd: string; store: RunStore };
		name: string;
		finishAfterMs?: number;
		transcript?: string;
		state?: ChildRecord["state"];
	}) => Promise<StoreFixture>;
	/** One REAL `terminal.run` on the fake core; returns the terminal address. */
	runTerminal: (input: {
		store: RunStore;
		runId: string;
		name: string;
		finishAfterMs?: number;
		transcript?: string;
		/** ON THE TARGET MACHINE: the transcript the child writes (under the fake remote root). */
		transcriptPath?: string;
	}) => Promise<string>;
}

function harness(prefix = "reattach-cross-"): Harness {
	const root = mkdtempSync(path.join(tmpdir(), prefix));
	const home = path.join(root, "home");
	mkdirSync(home, { recursive: true });
	const remoteRoot = path.join(root, "remote");
	const remoteCwd = path.join(remoteRoot, "work");
	mkdirSync(remoteCwd, { recursive: true });
	const binDir = path.join(root, "bin");
	mkdirSync(binDir, { recursive: true });
	const wrapper = path.join(binDir, "hc");
	writeFileSync(wrapper, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(FAKE_CORE)} "$@"\n`, { mode: 0o755 });
	chmodSync(wrapper, 0o755);
	const terminalsFile = path.join(root, "terminals.json");
	writeFileSync(terminalsFile, "{}\n");
	const coreLog = path.join(root, "core.jsonl");
	writeFileSync(coreLog, "");
	const terminalState = path.join(root, "terminal-state.json");
	writeFileSync(terminalState, "{}\n");
	const previous = { ...process.env };
	const previousHome = process.env.HOME;
	Object.assign(process.env, {
		HC_BIN: wrapper,
		FAKE_HC_REMOTE_ROOT: remoteRoot,
		FAKE_HC_MACHINES: HOST,
		FAKE_HC_LOG: coreLog,
		FAKE_HC_TERMINALS: terminalsFile,
		FAKE_HC_TERMINAL_STATE: terminalState,
		HOME: home,
	});
	const newCwd = path.join(home, "agents");
	mkdirSync(newCwd, { recursive: true });
	const newSession = path.join(root, "sessions", "new.jsonl");
	mkdirSync(path.dirname(newSession), { recursive: true });
	writeFileSync(newSession, "");
	const storeAt = (relative: string) => {
		const cwd = path.join(home, relative);
		mkdirSync(cwd, { recursive: true });
		return { cwd, store: new RunStore({ rootDir: path.join(cwd, ".pi-subagents") }) };
	};
	const newStore = new RunStore({ rootDir: path.join(newCwd, ".pi-subagents") });
	let sequence = 0;
	const runTerminal: Harness["runTerminal"] = async (input) => {
		sequence += 1;
		const manifest: Record<string, unknown> = {
			state: "running",
			...(input.finishAfterMs !== undefined ? { finish_after_ms: input.finishAfterMs } : {}),
			// The transcript lives on the TARGET machine (the fake remote root), at the
			// very `remoteDir/session.jsonl` the record names — what a launch leaves.
			...(input.transcript !== undefined && input.transcriptPath !== undefined
				? { writes: [{ path: input.transcriptPath, text: input.transcript }] }
				: {}),
		};
		writeFileSync(terminalsFile, `${JSON.stringify({ "*": manifest })}\n`);
		const client = hcCliClient({ env: process.env });
		await client.start();
		try {
			const result = await client.request<{ address: string }>("terminal.run", {
				on: HOST,
				name: `lgl-${input.runId}-${input.name}`,
				argv: [path.posix.join(remoteRoot, "bin", "pi")],
				cwd: remoteCwd,
			});
			return result.address;
		} finally {
			client.close();
		}
	};
	const seed: Harness["seed"] = async (input) => {
		const previousSession = path.join(root, "sessions", `${input.name}-${Date.now()}-${sequence}-previous.jsonl`);
		mkdirSync(path.dirname(previousSession), { recursive: true });
		writeFileSync(previousSession, "");
		const run = input.at.store.createRun({ task: `leftover ${input.name}`, cwd: input.at.cwd, sessionFile: previousSession });
		const runDir = input.at.store.runDir(run.runId);
		const remoteDir = path.posix.join(remoteRoot, ".pi-subagents-mirror", run.runId, input.name);
		const remoteSessionPath = path.posix.join(remoteDir, "session.jsonl");
		const nodeId = `root.${input.name}`;
		const terminal = await runTerminal({
			store: input.at.store,
			runId: run.runId,
			name: input.name,
			transcriptPath: remoteSessionPath,
			...(input.finishAfterMs !== undefined ? { finishAfterMs: input.finishAfterMs } : {}),
			...(input.transcript !== undefined ? { transcript: input.transcript } : {}),
		});
		await input.at.store.addChild(run.runId, {
			name: input.name,
			sessionFile: path.join(runDir, `${input.name}.jsonl`),
			ownerToken: "tok",
			state: input.state ?? "orphaned",
			spawnedAt: new Date(Date.now() - 120_000).toISOString(),
			host: HOST,
			remoteDir,
			remoteTerminal: terminal,
			nodeId,
			...(input.state === undefined
				? { orphaned: { at: Date.now() - 60_000, fate: "orphaned" as const, reason: "session-shutdown", host: HOST, remoteDir } }
				: {}),
		});
		// The exit's marker: the pid is gone, i.e. exactly what a killed `pi` leaves.
		writeOwnerFile(path.join(runDir, RUN_OWNER_FILE), 2_147_483_000);
		const dbPath = legionDbPath(runDir);
		const db = openLegionDb(dbPath);
		try {
			insertNode(db, { id: "root", parentId: null, name: "root", role: "root", kind: "pi", depth: 0, runId: run.runId, status: "running" });
			insertNode(db, {
				parentId: "root",
				name: input.name,
				role: "worker",
				kind: "pi",
				status: "running",
				host: HOST,
				remoteDir,
				remoteTerminal: terminal,
				sessionFile: path.join(runDir, `${input.name}.jsonl`),
			});
		} finally {
			db.close();
		}
		return {
			label: formatStoreLabel(input.at.store.rootDir, { home }),
			cwd: input.at.cwd,
			store: input.at.store,
			runId: run.runId,
			runDir,
			dbPath,
			name: input.name,
			nodeId,
			remoteDir,
			remoteSessionPath,
			previousSession,
			terminal,
		};
	};
	return {
		root,
		home,
		newCwd,
		newStore,
		newSession,
		remoteRoot,
		remoteCwd,
		terminalsFile,
		coreLog,
		settings: { enabled: true, hosts: { [HOST]: { cwd: remoteCwd } } },
		storeAt,
		seed,
		runTerminal,
		cleanup: () => {
			for (const key of ["HC_BIN", "FAKE_HC_REMOTE_ROOT", "FAKE_HC_MACHINES", "FAKE_HC_LOG", "FAKE_HC_TERMINALS", "FAKE_HC_TERMINAL_STATE"]) {
				if (previous[key] === undefined) delete process.env[key];
				else process.env[key] = previous[key];
			}
			if (previousHome === undefined) delete process.env.HOME;
			else process.env.HOME = previousHome;
			rmSync(root, { recursive: true, force: true });
		},
	};
}

/** The transcript the child writes ON ITS MACHINE (a complete, gradeable turn). */
function finishedTranscript(text: string): string {
	return [
		sessionHeader({ cwd: "/srv/app" }),
		modelChange("workbuddy/deepseek-v4.1-flash"),
		userMsg("fix the flaky test"),
		assistantMsg({ text: `${text}\n{"ok": true, "reason": "tests pass"}`, stopReason: "stop" }),
	].join("\n") + "\n";
}

/** The status block a foreign child gets — the same renderer, with the store marker. */
function foreignStatusBlock(child: ChildRecord, label: string): string {
	return renderLiveChildStatus({
		name: child.name,
		state: child.state,
		agent: child.agent,
		kind: child.kind,
		sessionFile: child.sessionFile,
		execution: child.execution,
		acceptance: child.acceptance,
		...(child.host ? { host: child.host } : {}),
		...(child.remoteTerminal ? { remoteTerminal: child.remoteTerminal } : {}),
		alive: false,
		owner: "live",
		store: label,
	});
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function storesOf(...fixtures: Array<{ store: RunStore }>): ReattachStore[] {
	return fixtures.map((fixture) => fixture.store);
}

/** A watcher wired to the PRODUCTION settle seam, with per-store record writes. */
function productionWatcher(h: Harness, stores: readonly ReattachStore[]) {
	const byRoot = new Map(stores.map((store) => [path.resolve(store.rootDir), store]));
	const storeFor = (target: { storeRoot?: string | undefined }): ReattachStore => {
		const found = target.storeRoot !== undefined ? byRoot.get(path.resolve(target.storeRoot)) : undefined;
		return found ?? h.newStore;
	};
	/** `updateChild` is optional on the structural `ReattachStore`; a real store has it. */
	const update = async (target: { storeRoot?: string | undefined }, runId: string, name: string, fn: (child: ChildRecord) => void): Promise<void> => {
		const store = storeFor(target);
		if (store.updateChild === undefined) throw new Error(`store ${store.rootDir} cannot write child records`);
		await store.updateChild(runId, name, fn);
	};
	const notices: Array<{ text: string; storeRoot?: string }> = [];
	const latched: Array<{ name: string; storeRoot?: string }> = [];
	const records: string[] = [];
	const watcher = new ReattachWatcher({
		probe: createRemoteTerminalProbe({ crossMachine: h.settings }),
		settle: createReattachSettle(h.settings),
		notify: (notice, target) => {
			notices.push({ text: notice.content, ...(target.storeRoot !== undefined ? { storeRoot: target.storeRoot } : {}) });
			return true;
		},
		recordSettlement: async (target, recovery) => {
			records.push(`${target.name}@${target.storeRoot ?? "?"}:${recovery.execution.status}`);
			await update(target, target.runId, target.name, (child) => {
				child.state = "retired";
				child.retiredAt = new Date().toISOString();
				child.execution = recovery.execution;
				child.acceptance = recovery.acceptance;
				delete child.orphaned;
			});
		},
		markNotified: async (target, at) => {
			latched.push({ name: target.name, ...(target.storeRoot !== undefined ? { storeRoot: target.storeRoot } : {}) });
			await update(target, target.runId, target.name, (child) => {
				if (child.reattached) child.reattached.notifiedAt ??= at;
			});
		},
		log: () => {},
	});
	return { watcher, notices, latched, records };
}

function targetsOf(h: Harness, report: ReattachReport) {
	return report.adopted.map((child) => ({
		runId: child.runId,
		name: child.name,
		host: child.host,
		...(child.nodeId ? { nodeId: child.nodeId } : {}),
		...(child.terminal ? { remoteTerminal: child.terminal } : {}),
		ledgerDbPath: child.ledgerDbPath,
		...(child.storeRoot ? { storeRoot: child.storeRoot } : {}),
	}));
}

// ── A1: acceptance 1 — a session in a different cwd adopts the leftover ────

test("#450 A1: a session in ~/agents adopts the leftover launched from ~/code/anotify, lists it with `store=`, and its completion arrives", async () => {
	const h = harness();
	try {
		const anotify = h.storeAt("code/anotify");
		const leftover = await h.seed({
			at: anotify,
			name: "anotify-uishift-budget",
			finishAfterMs: 1_500,
			transcript: finishedTranscript("all green"),
		});

		// The DISCOVERY, not an injected list, is what makes the store visible.
		const discovery = discoverLocalStores({ cwd: h.newCwd, home: h.home });
		assert.ok(
			discovery.stores.some((store) => path.resolve(store.rootDir) === path.resolve(anotify.store.rootDir)),
			`~/code/anotify must be in the surface: ${discovery.stores.map((store) => store.cwd).join(", ")}`,
		);
		assert.equal(discovery.stats.homeScanned, true);

		const log: string[] = [];
		const report = await runReattachPass({
			store: h.newStore,
			stores: storesOf(anotify),
			storeScan: discovery.stats,
			home: h.home,
			sessionFile: h.newSession,
			settings: { crossMachine: h.settings },
			listMirrorOrphans: async () => [],
			log: (line) => log.push(line),
		});
		assert.equal(report.adopted.length, 1, `expected one adoption, got ${JSON.stringify(report.skipped)}`);
		assert.equal(report.sessionStoreRoot, path.resolve(h.newStore.rootDir));
		assert.equal(path.resolve(report.adopted[0]!.storeRoot ?? ""), path.resolve(anotify.store.rootDir));
		assert.equal(report.adopted[0]!.storeCwd, anotify.cwd);
		assert.equal(report.adopted[0]!.terminal, leftover.terminal);
		// ONE line, and it names the store the child actually lives in.
		const summary = formatReattachSummary(report, { home: h.home });
		assert.match(summary ?? "", /^legion: reattached 1 live child \(anotify-uishift-budget\) — store ~\/code\/anotify$/);
		assert.equal((summary ?? "").split("\n").length, 1);

		// `status` reads run.json: the record in THAT store is re-opened, and the
		// block carries the store marker (the `store=` line the issue asks for).
		const record = anotify.store.findChild(leftover.runId, leftover.name)!;
		assert.equal(record.state, "working");
		assert.equal(record.orphaned, undefined);
		assert.equal(record.reattached?.host, HOST);
		// The claim landed in the FOREIGN run dir, and it is this process.
		assert.equal(readOwnerFile(path.join(leftover.runDir, RUN_OWNER_FILE))?.pid, process.pid);
		const block = foreignStatusBlock(record, leftover.label);
		assert.match(block, /^anotify-uishift-budget — state=working/);
		assert.match(block, /store=~\/code\/anotify/);
		assert.match(block, new RegExp(`host=${HOST}`));

		// ── the program ends over there; the watcher settles + notifies ─────────
		const { watcher, notices, latched } = productionWatcher(h, [h.newStore, anotify.store]);
		for (const target of targetsOf(h, report)) watcher.add(target);
		await delay(1_700);
		await watcher.tick();

		assert.equal(notices.length, 1, "exactly one completion notice");
		assert.match(notices[0]!.text, /Background task completed: \*\*anotify-uishift-budget\*\*/);
		assert.match(notices[0]!.text, /execution: success/);
		assert.equal(path.resolve(notices[0]!.storeRoot ?? ""), path.resolve(anotify.store.rootDir));
		assert.equal(latched.length, 1);
		assert.deepEqual(pendingReattachNotices([h.newStore, anotify.store]), [], "the latch means a later session owes nothing");

		// The ledger in THAT store is settled by the same ladder a collect uses.
		const db = openLegionDb(leftover.dbPath);
		try {
			assert.equal(getNode(db, leftover.nodeId)?.status, "settled");
		} finally {
			db.close();
		}
		// The run record followed, so `status` no longer claims `working`.
		assert.equal(anotify.store.findChild(leftover.runId, leftover.name)!.state, "retired");
		assert.equal(anotify.store.findChild(leftover.runId, leftover.name)!.execution?.status, "success");
		assert.match(log.join("\n"), /reattach stores=2 withRuns=1 candidates=1/);

		// A SECOND session-start pass (a restart) adopts nothing and announces nothing.
		const again = await runReattachPass({
			store: h.newStore,
			stores: storesOf(anotify),
			home: h.home,
			sessionFile: h.newSession,
			settings: { crossMachine: h.settings },
			listMirrorOrphans: async () => [],
			log: () => {},
		});
		assert.equal(again.adopted.length, 0);
		assert.equal(formatReattachSummary(again, { home: h.home }), undefined);
		assert.deepEqual(pendingReattachNotices([h.newStore, anotify.store]), []);
	} finally {
		h.cleanup();
	}
});

// ── A2: acceptance 2 — three stores, one pass, inside the 5s budget ────────

test("#450 A2: three stores with live rows are all adopted by ONE pass, inside the #445 5s budget", async () => {
	const h = harness("reattach-cross-three-");
	try {
		const anotify = h.storeAt("code/anotify");
		const piLegion = h.storeAt("code/pi-legion");
		const piAsync = h.storeAt("code/pi-async");
		// All three must still be running while the pass probes them.
		await h.seed({ at: anotify, name: "anotify-uishift-budget", finishAfterMs: 8_000, transcript: finishedTranscript("a") });
		await h.seed({ at: piLegion, name: "legion-450-scope", finishAfterMs: 8_000, transcript: finishedTranscript("b") });
		await h.seed({ at: piAsync, name: "async-watch", finishAfterMs: 8_000, transcript: finishedTranscript("c") });

		const discovery = discoverLocalStores({ cwd: h.newCwd, home: h.home });
		const candidates = discoverReattachCandidatesAcrossStores([h.newStore, anotify.store, piLegion.store, piAsync.store], { sessionFile: h.newSession });
		assert.equal(candidates.length, 3, "all three stores contribute candidates");
		assert.equal(new Set(candidates.map((candidate) => candidate.storeRoot)).size, 3);

		const started = Date.now();
		const report = await runReattachPass({
			store: h.newStore,
			stores: storesOf(anotify, piLegion, piAsync),
			storeScan: discovery.stats,
			home: h.home,
			sessionFile: h.newSession,
			settings: { crossMachine: h.settings },
			listMirrorOrphans: async () => [],
			log: () => {},
		});
		const elapsed = Date.now() - started;
		assert.equal(report.adopted.length, 3, `expected three adoptions, got ${JSON.stringify(report.skipped)}`);
		assert.equal(report.deferred, 0);
		assert.ok(elapsed <= 5_000, `the pass took ${elapsed}ms — #445 §4 says a session start is bounded by 5s`);
		assert.equal(report.stores.scanned, 4, "the session store + the three discovered ones");
		assert.equal(report.stores.withRuns, 3);
		// One line, three stores named, no repetition, adoption order preserved.
		const summary = formatReattachSummary(report, { home: h.home });
		assert.equal((summary ?? "").split("\n").length, 1);
		assert.match(summary ?? "", /^legion: reattached 3 live children \(anotify-uishift-budget, legion-450-scope, async-watch\)/);
		assert.match(summary ?? "", /— stores ~\/code\/anotify, ~\/code\/pi-legion, ~\/code\/pi-async/);
	} finally {
		h.cleanup();
	}
});

// ── A3: acceptance 3 — same name in two stores never collides ──────────────

test("#450 A3: the same child name in two stores is two children — adopting and settling one leaves the other untouched", async () => {
	const h = harness("reattach-cross-dupe-");
	try {
		const anotify = h.storeAt("code/anotify");
		const piAsync = h.storeAt("code/pi-async");
		const first = await h.seed({ at: anotify, name: "worker-0", finishAfterMs: 800, transcript: finishedTranscript("first") });
		const second = await h.seed({ at: piAsync, name: "worker-0", finishAfterMs: 30_000, transcript: finishedTranscript("second") });
		assert.notEqual(first.runId, second.runId);

		const report = await runReattachPass({
			store: h.newStore,
			stores: storesOf(anotify, piAsync),
			home: h.home,
			sessionFile: h.newSession,
			settings: { crossMachine: h.settings },
			listMirrorOrphans: async () => [],
			log: () => {},
		});
		assert.equal(report.adopted.length, 2, `same name in two stores must not be deduped: ${JSON.stringify(report.skipped)}`);
		assert.deepEqual(
			new Set(report.adopted.map((child) => `${path.resolve(child.storeRoot ?? "")}/${child.runId}`)),
			new Set([
				`${path.resolve(anotify.store.rootDir)}/${first.runId}`,
				`${path.resolve(piAsync.store.rootDir)}/${second.runId}`,
			]),
		);
		// Each run dir got its OWN claim.
		assert.equal(readOwnerFile(path.join(first.runDir, RUN_OWNER_FILE))?.pid, process.pid);
		assert.equal(readOwnerFile(path.join(second.runDir, RUN_OWNER_FILE))?.pid, process.pid);

		const { watcher, notices, latched } = productionWatcher(h, [h.newStore, anotify.store, piAsync.store]);
		for (const target of targetsOf(h, report)) watcher.add(target);
		assert.equal(watcher.watching().length, 2, "two same-named children are watched independently");

		// Only the ANOTIFY terminal finishes; the pi-async one keeps running.
		await delay(1_000);
		await watcher.tick();
		assert.equal(notices.length, 1, "one completion, for the child that ended");
		assert.match(notices[0]!.text, /\*\*worker-0\*\*/);
		assert.equal(path.resolve(notices[0]!.storeRoot ?? ""), path.resolve(anotify.store.rootDir));
		assert.equal(latched.length, 1);

		// No cross-talk: the other store's record and ledger are exactly as adopted.
		assert.equal(anotify.store.findChild(first.runId, "worker-0")!.state, "retired");
		assert.equal(anotify.store.findChild(first.runId, "worker-0")!.execution?.status, "success");
		const other = piAsync.store.findChild(second.runId, "worker-0")!;
		assert.equal(other.state, "working", "the same-named child of ANOTHER store is not settled by this one");
		assert.equal(other.reattached?.notifiedAt, undefined);
		const db = openLegionDb(second.dbPath);
		try {
			assert.equal(getNode(db, second.nodeId)?.status, "running");
		} finally {
			db.close();
		}
		assert.equal(watcher.watching().length, 1, "the live one is still watched");
	} finally {
		h.cleanup();
	}
});

// ── A4: the mutation — a per-cwd scan cannot see the foreign leftover ──────

test("#450 A4 (mutation): a pass that only reads the session cwd store sees NOTHING of ~/code/anotify", async () => {
	const h = harness("reattach-cross-mutation-");
	try {
		const anotify = h.storeAt("code/anotify");
		const leftover = await h.seed({ at: anotify, name: "anotify-uishift-budget", finishAfterMs: 8_000, transcript: finishedTranscript("still here") });

		// This is the pre-#450 world: the scan surface is the cwd store and nothing
		// else. It is the mutation the acceptance asks to be red under: revert the
		// surface and A1 above fails exactly this way.
		const perCwd = await runReattachPass({
			store: h.newStore,
			home: h.home,
			sessionFile: h.newSession,
			settings: { crossMachine: h.settings },
			listMirrorOrphans: async () => [],
			log: () => {},
		});
		assert.equal(perCwd.adopted.length, 0);
		assert.equal(formatReattachSummary(perCwd, { home: h.home }), undefined);
		assert.equal(perCwd.stores.scanned, 1);
		// The leftover is untouched — it was never even looked at.
		assert.equal(anotify.store.findChild(leftover.runId, "anotify-uishift-budget")!.state, "orphaned");
	} finally {
		h.cleanup();
	}
});

// ── A5: unreachable machine + a capped surface are reasons, not hangs ──────

/** A core that accepts the handshake then dies with our write end still open (see #445 A4 / #447). */
function writeDyingCore(h: Harness): string {
	const dying = path.join(h.root, "bin", "hc-dying");
	writeFileSync(
		dying,
		["#!/bin/sh", "IFS= read -r hello", "exec 0<&-", `printf '%s\\n' '{"jsonrpc":"2.0","id":1,"result":{}}'`, "sleep 1", "exit 3", ""].join("\n"),
		{ mode: 0o755 },
	);
	chmodSync(dying, 0o755);
	return dying;
}

test("#450 A5: an unreachable machine is a reason in the log, and a capped store surface says why it stopped", async () => {
	const h = harness("reattach-cross-down-");
	try {
		const anotify = h.storeAt("code/anotify");
		await h.seed({ at: anotify, name: "anotify-uishift-budget", transcript: finishedTranscript("x") });

		// ── unreachable target: the pass returns, nothing is adopted, the reason is named
		process.env.HC_BIN = writeDyingCore(h);
		const lines: string[] = [];
		const started = Date.now();
		const down = await runReattachPass({
			store: h.newStore,
			stores: storesOf(anotify),
			home: h.home,
			sessionFile: h.newSession,
			settings: { crossMachine: h.settings },
			listMirrorOrphans: async () => [],
			log: (line) => lines.push(line),
		});
		const elapsed = Date.now() - started;
		assert.ok(elapsed < 30_000, `the pass did not return for ${elapsed}ms — a dead machine must not hold session start`);
		assert.equal(down.error, undefined, `the pass reported an error instead of a skip: ${down.error}`);
		assert.equal(down.adopted.length, 0);
		assert.match(down.skipped[0]!.reason, /no liveness evidence: host 'njbox' could not be asked/);
		assert.match(lines.join("\n"), /skipped anotify-uishift-budget .* store=~\/code\/anotify/);

		// ── a capped surface: the reason reaches the report AND the log, and the pass
		// still returns inside its budget (the injected clock proves the bound, not a
		// wall clock).
		const many = h.storeAt("code/many");
		for (let index = 0; index < 6; index += 1) {
			// A store directory EXISTS once a launch has written a run; the discovery rule
			// is "an existing `<cwd>/.pi-subagents`", not "a directory that could hold one".
			const extra = h.storeAt(`code/extra-${index}`);
			mkdirSync(path.join(extra.store.rootDir, "runs"), { recursive: true });
		}
		const discovery = discoverLocalStores({ cwd: h.newCwd, home: h.home, maxStores: 3 });
		assert.equal(discovery.stats.truncated, true);
		let clock = 1_000;
		const capped = await runReattachPass({
			store: h.newStore,
			stores: storesOf(many),
			storeScan: discovery.stats,
			home: h.home,
			sessionFile: h.newSession,
			settings: { crossMachine: h.settings },
			listMirrorOrphans: async () => [],
			budgetMs: 1,
			now: () => (clock += 10),
			log: () => {},
		});
		assert.equal(capped.error, undefined);
		assert.ok(capped.stores.truncated, "the truncated surface is reported, never silently shrunk");
		assert.ok(capped.stores.skipped.some((entry) => /cap/.test(entry.reason)), JSON.stringify(capped.stores.skipped));
	} finally {
		h.cleanup();
	}
});
