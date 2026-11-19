/**
 * Recovery from a DIFFERENT process — the case `recover` exists for (defect D).
 *
 * The 6.2.2 release run found the hole: after the parent session exited, a new
 * session answered `No legion ledger in this session` for `recover`, and its
 * `/legion status` showed no recovery block at all. Both surfaces read
 * `ownLegionIdentity()`, which is the runtime identity of THIS process — and a fresh
 * process has none by construction, because only a launch creates one. The situation
 * recovery exists for (the process that launched is gone) was therefore the one
 * situation it could not serve.
 *
 * These tests never hand the action a ledger: `legion` is `undefined`, and the only
 * inputs are what a new process really has — a cwd, the run store under it, and its
 * own session file. The ledger is discovered from disk, opened by the call, and
 * closed by it.
 *
 * Two surfaces, because they must agree (a fix to one alone would advertise nothing
 * while `recover` would have worked, or the reverse):
 *   - `listRecoverableLeftovers` — what `/legion status` renders;
 *   - `recoverAction({store, sessionFile})` — what the tool runs.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { recoverAction } from "../../index.ts";
import { renderLegionStatus } from "../../src/extension/legion-status.ts";
import { legionDbPath, openLegionDb } from "../../src/legion/db.ts";
import { getNode, insertNode, listUnsettledRemoteNodes, type LegionNode } from "../../src/legion/nodes.ts";
import { getSubtree } from "../../src/legion/nodes.ts";
import { findRecoveryLedgerForName, listRecoverableLeftovers, recoveryCallFor } from "../../src/runs/remote-recover.ts";
import { RunStore } from "../../src/runs/store.ts";
import type { CrossMachineSettings } from "../../src/shared/types.ts";
import { assistantMsg, modelChange, sessionHeader, userMsg } from "../helpers/fixtures.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE_CORE = path.resolve(HERE, "../helpers/fake-hc-core.mjs");
const HOST = "freshbox";
const NODE_NAME = "centurion-0";
/** `insertNode` derives the id from the parent, so a row's id is never its name. */
const NODE_ID = `root.${NODE_NAME}`;
const REMOTE_TERMINAL = `${HOST}/lgl-r1-${NODE_NAME}`;

interface Harness {
	root: string;
	/** The cwd the new process runs in: its store is `<root>/work/.pi-subagents`. */
	cwd: string;
	store: RunStore;
	runId: string;
	dbPath: string;
	remoteSessionPath: string;
	localSessionPath: string;
	/** Every request the fake core answered (JSONL), so "no second fetch" is provable. */
	coreLog: string;
	settings: CrossMachineSettings;
	cleanup: () => void;
}

/**
 * A run store as a PREVIOUS process left it: `createRun` wrote `run.json`, and the
 * ledger beside it holds the cross-machine row. Nothing here touches the extension's
 * in-memory identity — the point is that a new process has none.
 */
function harness(prefix = "recover-fresh-"): Harness {
	const root = mkdtempSync(path.join(tmpdir(), prefix));
	const cwd = path.join(root, "work");
	mkdirSync(cwd, { recursive: true });
	const remoteRoot = path.join(root, "remote");
	mkdirSync(remoteRoot, { recursive: true });
	const binDir = path.join(root, "bin");
	mkdirSync(binDir, { recursive: true });
	const wrapper = path.join(binDir, "hc");
	writeFileSync(wrapper, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(FAKE_CORE)} "$@"\n`, { mode: 0o755 });
	chmodSync(wrapper, 0o755);
	const previous = { ...process.env };
	const coreLog = path.join(root, "core.jsonl");
	Object.assign(process.env, {
		HC_BIN: wrapper,
		FAKE_HC_REMOTE_ROOT: remoteRoot,
		FAKE_HC_MACHINES: HOST,
		FAKE_HC_LOG: coreLog,
	});

	const store = new RunStore({ rootDir: path.join(cwd, ".pi-subagents") });
	// The PREVIOUS process's session file: a real path, and one this process is not.
	const previousSession = path.join(root, "sessions", "previous.jsonl");
	mkdirSync(path.dirname(previousSession), { recursive: true });
	writeFileSync(previousSession, "");
	const run = store.createRun({ task: "ship the fix", cwd, sessionFile: previousSession });

	const remoteDir = path.posix.join(remoteRoot, ".pi-subagents-mirror", run.runId, NODE_NAME);
	return {
		root,
		cwd,
		store,
		runId: run.runId,
		dbPath: legionDbPath(store.runDir(run.runId)),
		remoteSessionPath: path.posix.join(remoteDir, "session.jsonl"),
		localSessionPath: path.join(remoteRoot, ".pi-subagents-mirror", run.runId, NODE_NAME, "session.jsonl"),
		coreLog,
		settings: { enabled: true, hosts: { [HOST]: { cwd: path.join(remoteRoot, "work") } } },
		cleanup: () => {
			for (const key of ["HC_BIN", "FAKE_HC_REMOTE_ROOT", "FAKE_HC_MACHINES", "FAKE_HC_LOG"]) {
				if (previous[key] === undefined) delete process.env[key];
				else process.env[key] = previous[key];
			}
			rmSync(root, { recursive: true, force: true });
		},
	};
}

function finishedTranscript(text: string): string {
	return [
		sessionHeader({ cwd: "/srv/app" }),
		modelChange("workbuddy/deepseek-v4.1-flash"),
		userMsg("fix the flaky test"),
		assistantMsg({ text: `${text}\n{"ok": true, "reason": "tests pass"}`, stopReason: "stop" }),
	].join("\n") + "\n";
}

function writeRemoteSession(h: Harness, text: string): void {
	mkdirSync(path.dirname(h.localSessionPath), { recursive: true });
	writeFileSync(h.localSessionPath, text);
}

/** The row the previous process's launch wrote (real writer, real schema). */
function seedLeftover(h: Harness): void {
	const now = Date.now();
	const db = openLegionDb(h.dbPath);
	try {
		insertNode(db, {
			id: "root",
			parentId: null,
			name: "root",
			role: "root",
			kind: "pi",
			depth: 0,
			runId: h.runId,
			status: "running",
			createdAt: now - 3_600_000,
			updatedAt: now - 3_600_000,
		});
		insertNode(db, {
			parentId: "root",
			name: NODE_NAME,
			role: "centurion",
			kind: "pi",
			status: "running",
			host: HOST,
			remoteDir: path.posix.dirname(h.remoteSessionPath),
			remoteTerminal: REMOTE_TERMINAL,
			sessionFile: path.join(h.root, "run", `${NODE_NAME}.jsonl`),
			createdAt: now - 3_600_000,
			updatedAt: now - 10 * 60_000,
		});
	} finally {
		db.close();
	}
}

/** How many hc requests the fake core has answered so far. */
function coreRequests(h: Harness): number {
	return existsSync(h.coreLog)
		? readFileSync(h.coreLog, "utf8").split("\n").filter((line) => line.trim().length > 0).length
		: 0;
}

function textOf(result: Awaited<ReturnType<typeof recoverAction>>): string {
	return result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
}

function statusText(h: Harness, sessionFile: string | undefined): string {
	const nodes: readonly LegionNode[] = getSubtree(openLegionDb(h.dbPath), "root");
	return renderLegionStatus({
		nodes,
		jobs: [],
		recoverable: listRecoverableLeftovers(h.store, { sessionFile }).map((entry) => entry.node),
		now: Date.now(),
	}).text;
}

test("D1: a NEW process (no cached identity) FINDS the previous process's cross-machine child", async (t) => {
	const h = harness();
	t.after(() => h.cleanup());
	writeRemoteSession(h, finishedTranscript("shipped it"));
	seedLeftover(h);

	// What a new process has: a cwd, its store, its own session file. No identity.
	const newSession = path.join(h.root, "sessions", "new.jsonl");

	const found = findRecoveryLedgerForName(h.store, NODE_NAME, { sessionFile: newSession });
	assert.ok(found, "the ledger must be discovered on disk when this process owns none");
	assert.equal(found.dbPath, h.dbPath, "the discovered ledger is the run's own legion.db");
	assert.equal(getNode(found.db, "root")?.runId, h.runId, "and it is really that run's tree");

	const leftovers = listRecoverableLeftovers(h.store, { sessionFile: newSession });
	assert.deepEqual(leftovers.map((entry) => entry.node.name), [NODE_NAME]);

	// The `/legion status` surface renders the block a fresh session must show.
	const status = statusText(h, newSession);
	assert.match(status, /Recoverable cross-machine children \(this session never launched them\):/);
	assert.match(status, new RegExp(`- ${NODE_NAME} · centurion · host ${HOST}`));
	assert.match(status, new RegExp(recoveryCallFor(NODE_NAME).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
	found.db.close();
});

test("D1: `recover` with NO in-memory ledger settles the row, and a second call is `already settled`", async (t) => {
	const h = harness();
	t.after(() => h.cleanup());
	writeRemoteSession(h, finishedTranscript("the suite is green"));
	seedLeftover(h);
	const newSession = path.join(h.root, "sessions", "new.jsonl");

	// The call the fresh session makes: no `legion`, no `readback` — the production
	// seams resolve through the store.
	const first = await recoverAction({
		params: { name: NODE_NAME },
		legion: undefined,
		store: h.store,
		sessionFile: newSession,
		crossMachine: h.settings,
	});
	const firstText = textOf(first);
	assert.doesNotMatch(firstText, /No legion ledger in this session/, "the fresh-process refusal must be gone");
	assert.match(firstText, /execution: success/, "the recovered verdict is the child's own");
	assert.match(firstText, /the suite is green/, "the child's last text travels with it");
	assert.match(firstText, /read-back from host 'freshbox'/, "the transcript really was pulled");
	assert.notEqual(firstText.includes("still live"), true, "a finished transcript is never reported as live");

	// The row is SETTLED, not left `running` for the next session to find again.
	const db = openLegionDb(h.dbPath);
	t.after(() => db.close());
	assert.equal(getNode(db, NODE_ID)?.status, "settled", "recovery settles the row");
	assert.deepEqual(listUnsettledRemoteNodes(db), [], "nothing is left waiting for recovery");

	// Idempotent: the second call reports the recorded verdict and asks the machine
	// NOTHING. Counted on the fake core's own request log, because the rendered body
	// legitimately replays the recorded recovery evidence — the assertion has to be
	// about the wire, not about a string the ledger already owns.
	const requestsBefore = coreRequests(h);
	const second = await recoverAction({
		params: { name: NODE_NAME },
		legion: undefined,
		store: h.store,
		sessionFile: newSession,
		crossMachine: h.settings,
	});
	assert.match(textOf(second), /already settled/);
	assert.equal(coreRequests(h), requestsBefore, "a settled row is answered from the ledger, with no re-fetch");
});

test("D1: an unknown name says where it looked and what IS waiting, never a bare NOT_FOUND", async (t) => {
	const h = harness();
	t.after(() => h.cleanup());
	writeRemoteSession(h, finishedTranscript("done"));
	seedLeftover(h);

	const result = await recoverAction({
		params: { name: "not-here" },
		legion: undefined,
		store: h.store,
		sessionFile: path.join(h.root, "sessions", "new.jsonl"),
		crossMachine: h.settings,
	});
	const text = textOf(result);
	assert.match(text, /No cross-machine child named "not-here"/);
	assert.match(text, new RegExp(`Waiting for recovery: ${NODE_NAME}`), "the real leftover is named");
	assert.match(text, new RegExp(recoveryCallFor(NODE_NAME).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("D1: a session file match wins over a newer run that merely holds the same name", async (t) => {
	const h = harness("recover-fresh-priority-");
	t.after(() => h.cleanup());
	writeRemoteSession(h, finishedTranscript("older run"));
	seedLeftover(h);

	// A SECOND run, created later, that holds a node with the same handle. Both are on
	// disk; the session that owns one of them must recover THAT one (priority 1),
	// because "newest wins" would recover a tree this conversation never launched.
	const second = h.store.createRun({ task: "another", cwd: h.cwd, sessionFile: path.join(h.root, "sessions", "other.jsonl") });
	const secondDb = openLegionDb(legionDbPath(h.store.runDir(second.runId)));
	t.after(() => secondDb.close());
	const now = Date.now();
	insertNode(secondDb, { id: "root", parentId: null, name: "root", role: "root", kind: "pi", depth: 0, runId: second.runId, status: "running", createdAt: now, updatedAt: now });
	insertNode(secondDb, {
		parentId: "root",
		name: NODE_NAME,
		role: "centurion",
		kind: "pi",
		status: "running",
		host: HOST,
		remoteDir: path.posix.dirname(h.remoteSessionPath),
		remoteTerminal: REMOTE_TERMINAL,
		createdAt: now,
		updatedAt: now,
	});

	const mine = findRecoveryLedgerForName(h.store, NODE_NAME, { sessionFile: path.join(h.root, "sessions", "previous.jsonl") });
	assert.ok(mine);
	assert.equal(mine.runId, h.runId, "the run whose run.json names THIS session wins");
	mine.db.close();

	// With no session match at all, the newest run wins — a stable, stated rule.
	const newest = findRecoveryLedgerForName(h.store, NODE_NAME, { sessionFile: path.join(h.root, "sessions", "unknown.jsonl") });
	assert.ok(newest);
	assert.equal(newest.runId, second.runId, "no session match ⇒ newest run");
	newest.db.close();
});
