/**
 * Session recovery for a cross-machine child (schema v5).
 *
 * The requirement, in the user's words: *“这个是不是可以放到数据库里面，下次打开会话
 * 恢复？”* — a parent's launch exits, the child keeps running on the remote machine,
 * and a NEW session can neither see nor collect it. These tests build exactly that
 * situation on disk:
 *
 *   - a REAL `legion.db` in a temp dir, written through the normal `insertNode` path
 *     by one connection (the "previous session"), then read by a SECOND connection
 *     (`openLegionDb` on the same file) that shares no memory with it;
 *   - a transcript at the path the row says lives on that machine, served by the
 *     fake `hc` core (`HC_BIN`), so the read-back is the production one;
 *   - the four facts the requirement names — discovered in `/legion status`,
 *     `recover` returns `execution: success` plus the child's text, the row is
 *     settled, and a second `recover` is idempotent — plus the two honest refusals:
 *     a transcript that is not there (`unknown` + the fetch command, never
 *     `aborted`) and a terminal that is still live over there (nothing settled).
 *
 * Nothing here mocks the grading ladder: `recover` derives the verdict with
 * `deriveOutcome` and the acceptance with `deriveAcceptance`, i.e. the same rules
 * `collect` uses, which is why the assertions can name `success`/`accepted`.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { recoverAction } from "../../index.ts";
import { Orchestrator } from "../../src/runs/orchestrator.ts";
import { renderLegionStatus } from "../../src/extension/legion-status.ts";
import { hcCliClient } from "../../src/hc/client.ts";
import { openLegionDb, type DatabaseSync } from "../../src/legion/db.ts";
import { readEventsAfter } from "../../src/legion/events.ts";
import {
	getNode,
	getSubtree,
	insertNode,
	listUnsettledRemoteNodes,
	type LegionNode,
} from "../../src/legion/nodes.ts";
import { createRemoteTerminalProbe } from "../../src/runs/remote-artifact.ts";
import { recoveryCallFor } from "../../src/runs/remote-recover.ts";
import type { CrossMachineSettings } from "../../src/shared/types.ts";
import { assistantMsg, modelChange, sessionHeader, userMsg } from "../helpers/fixtures.ts";
import { FakeSupervisor } from "../helpers/fake-supervisor.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE_CORE = path.resolve(HERE, "../helpers/fake-hc-core.mjs");
const HOST = "fakebox";
const NODE_NAME = "worker-0";
const NODE_ID = `root.${NODE_NAME}`;
const REMOTE_TERMINAL = `${HOST}/lgl-run1-${NODE_NAME}`;

interface Harness {
	root: string;
	remoteRoot: string;
	remoteCwd: string;
	/** The ledger file — `<root>/run/legion.db`, i.e. `<runDir>/legion.db`. */
	dbPath: string;
	/** The child's mirror dir ON THE OTHER MACHINE (what the row records). */
	remoteDir: string;
	/** `<remoteDir>/session.jsonl` as that machine spells it. */
	remoteSessionPath: string;
	/** The same file on THIS filesystem (the fake core's `FAKE_HC_REMOTE_ROOT`). */
	localSessionPath: string;
	settings: CrossMachineSettings;
	cleanup: () => void;
}

function harness(prefix = "recover-xm-"): Harness {
	const root = mkdtempSync(path.join(tmpdir(), prefix));
	const remoteRoot = path.join(root, "remote");
	const remoteCwd = path.join(remoteRoot, "work");
	mkdirSync(remoteCwd, { recursive: true });
	const binDir = path.join(root, "bin");
	mkdirSync(binDir, { recursive: true });
	const wrapper = path.join(binDir, "hc");
	writeFileSync(wrapper, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(FAKE_CORE)} "$@"\n`, { mode: 0o755 });
	chmodSync(wrapper, 0o755);
	const previous = { ...process.env };
	Object.assign(process.env, {
		HC_BIN: wrapper,
		FAKE_HC_REMOTE_ROOT: remoteRoot,
		FAKE_HC_MACHINES: HOST,
	});
	const remoteDir = path.posix.join(remoteRoot, ".pi-subagents-mirror", "run-1", NODE_NAME);
	const remoteSessionPath = path.posix.join(remoteDir, "session.jsonl");
	return {
		root,
		remoteRoot,
		remoteCwd,
		dbPath: path.join(root, "run", "legion.db"),
		remoteDir,
		remoteSessionPath,
		localSessionPath: path.join(remoteRoot, ".pi-subagents-mirror", "run-1", NODE_NAME, "session.jsonl"),
		settings: { enabled: true, hosts: { [HOST]: { cwd: remoteCwd } } },
		cleanup: () => {
			for (const key of ["HC_BIN", "FAKE_HC_REMOTE_ROOT", "FAKE_HC_MACHINES"]) {
				if (previous[key] === undefined) delete process.env[key];
				else process.env[key] = previous[key];
			}
			rmSync(root, { recursive: true, force: true });
		},
	};
}

/**
 * The transcript the child wrote ON ITS MACHINE: header lines, one prompt, one
 * assistant turn that carries both a report and the machine-readable verdict
 * (`extractVerdict`'s last-line shape), so the recovered acceptance can be
 * asserted as `accepted (attested)` rather than guessed at.
 */
function finishedTranscript(text: string): string {
	return [
		sessionHeader({ cwd: "/srv/app" }),
		modelChange("workbuddy/deepseek-v4.1-flash"),
		userMsg("fix the flaky test"),
		assistantMsg({ text: `${text}\n{"ok": true, "reason": "tests pass"}`, stopReason: "stop" }),
	].join("\n") + "\n";
}

function writeRemoteSession(h: Harness, text: string): number {
	mkdirSync(path.dirname(h.localSessionPath), { recursive: true });
	writeFileSync(h.localSessionPath, text);
	// `file.read` reports the FILE's total line count; the corpus has no trailing
	// blank line, so this is exactly the number the render must print.
	return text.split("\n").filter((line, index, all) => index < all.length - 1 || line.length > 0).length;
}

/**
 * The row a PREVIOUS session left behind: a real launch row (via `insertNode`, the
 * normal writer) whose process is gone. `now - 12m` is the age `/legion status`
 * must render.
 */
function seedLeftover(h: Harness, overrides: { status?: "running" | "settled" } = {}): void {
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
			runId: "r-recover-1",
			status: "running",
			createdAt: now - 3_600_000,
			updatedAt: now - 3_600_000,
		});
		insertNode(db, {
			parentId: "root",
			name: NODE_NAME,
			role: "worker",
			kind: "pi",
			status: overrides.status ?? "running",
			host: HOST,
			remoteDir: h.remoteDir,
			remoteTerminal: REMOTE_TERMINAL,
			// The placeholder this machine pre-created for the launch (S1). Recovery must
			// never read it: it is empty, and grading it would report "the child said
			// nothing".
			sessionFile: path.join(h.root, "run", `${NODE_NAME}.jsonl`),
			createdAt: now - 3_600_000,
			updatedAt: now - 12 * 60_000,
		});
	} finally {
		db.close();
	}
}

/** This session's connection to the same ledger: no state shared with the seeder. */
function newSessionDb(h: Harness): DatabaseSync {
	return openLegionDb(h.dbPath);
}

function textOf(result: Awaited<ReturnType<typeof recoverAction>>): string {
	return result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
}

function eventsFor(db: DatabaseSync, nodeId: string) {
	return readEventsAfter(db, 0, { nodeId });
}

function settleEvents(db: DatabaseSync, nodeId: string) {
	return eventsFor(db, nodeId).filter((event) =>
		["node_settled", "node_failed", "node_retired"].includes(event.type),
	);
}

function statusText(
	db: DatabaseSync,
	options: { now?: number; jobs?: readonly { name: string; nodeId?: string; state: string }[] } = {},
): string {
	const nodes: readonly LegionNode[] = getSubtree(db, "root");
	return renderLegionStatus({
		nodes,
		jobs: options.jobs ?? [],
		recoverable: listUnsettledRemoteNodes(db),
		now: options.now ?? Date.now(),
	}).text;
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

test("(a–d) a leftover is discovered by a NEW session, recovered, settled, and re-recovery is idempotent", async (t) => {
	const h = harness();
	t.after(() => h.cleanup());
	const lines = writeRemoteSession(h, finishedTranscript("shipped the fix"));
	seedLeftover(h);

	const db = newSessionDb(h);
	t.after(() => db.close());

	// ── (a) `/legion status` names it, with everything an operator needs ────────
	const status = statusText(db);
	assert.match(status, /Recoverable cross-machine children \(this session never launched them\):/);
	assert.match(
		status,
		new RegExp(`- ${NODE_NAME} · worker · host ${HOST} · running · terminal ${escapeRegExp(REMOTE_TERMINAL)} · 12m(\\d+s)? old`),
		"name · role · host · status · terminal · age",
	);
	assert.match(status, new RegExp(escapeRegExp(recoveryCallFor(NODE_NAME))), "the exact recovery call");

	// A live child of THIS session is already on screen: it must not be repeated.
	const withLiveJob = statusText(db, { jobs: [{ name: NODE_NAME, nodeId: NODE_ID, state: "working" }] });
	assert.doesNotMatch(withLiveJob, /Recoverable cross-machine children/);

	// ── (b) `recover` collects it through the fake core ─────────────────────────
	const recovered = await recoverAction({
		params: { name: NODE_NAME },
		legion: { db, dbPath: h.dbPath },
		crossMachine: h.settings,
	});
	const text = textOf(recovered);
	assert.match(text, new RegExp(`^recover: '${NODE_NAME}' is over on '${HOST}'`), text);
	assert.match(text, new RegExp(`── ${NODE_NAME} ──`), "the collect-shaped block");
	assert.match(text, /^execution: success$/m);
	assert.match(text, /^acceptance: accepted \(attested\)$/m, "graded by collect's own acceptance ladder");
	assert.match(
		text,
		new RegExp(`read-back from host '${HOST}': ${lines} of ${lines} lines \\(complete\\)`),
		"the read-back says exactly how much of that machine's file we hold",
	);
	assert.match(text, /shipped the fix/, "the child's final message travels with the verdict");
	assert.match(text, /"ok": true/, "nothing is stripped out of the child's text");
	// The mirror lives where a collect would have put it: `<runDir>/remote/<name>.jsonl`.
	assert.doesNotMatch(text, /execution: (aborted|unknown)/);

	// ── (c) the ledger row is settled, the way a collect settles one ────────────
	const settled = getNode(db, NODE_ID);
	assert.equal(settled?.status, "settled", "the leftover stops advertising itself");
	assert.deepEqual(listUnsettledRemoteNodes(db), []);
	const writes = settleEvents(db, NODE_ID);
	assert.equal(writes.length, 1);
	assert.equal(writes[0]!.type, "node_settled");
	const data = writes[0]!.data as { recovered?: boolean; execution?: string; summary?: string };
	assert.equal(data.recovered, true, "additive marker: no reader keys on it, humans can");
	assert.equal(data.execution, "success");
	assert.match(data.summary ?? "", new RegExp(`recovered from host '${HOST}'`));
	assert.doesNotMatch(statusText(db), /Recoverable cross-machine children/, "it is gone from the status block");

	// ── (d) a second `recover` writes nothing and returns the recorded outcome ──
	const again = textOf(
		await recoverAction({ params: { name: NODE_NAME }, legion: { db, dbPath: h.dbPath }, crossMachine: h.settings }),
	);
	assert.match(again, new RegExp(`^recover: '${NODE_NAME}' is already settled \\(settled\\)`), again);
	assert.match(again, /^execution: success$/m, "the RECORDED outcome, not a fresh guess");
	assert.match(again, /shipped the fix/, "the child's text is still reachable");
	assert.equal(settleEvents(db, NODE_ID).length, 1, "idempotent: no second settle event");
	assert.equal(getNode(db, NODE_ID)?.status, "settled");
});

test("a transcript that is not on that machine is `unknown` with the fetch command — never `aborted`", async (t) => {
	const h = harness("recover-xm-missing-");
	t.after(() => h.cleanup());
	// The row says the transcript is under this dir; nothing was written there.
	mkdirSync(path.dirname(h.localSessionPath), { recursive: true });
	seedLeftover(h);
	const db = newSessionDb(h);
	t.after(() => db.close());

	const text = textOf(
		await recoverAction({ params: { name: NODE_NAME }, legion: { db, dbPath: h.dbPath }, crossMachine: h.settings }),
	);
	assert.match(text, /^execution: unknown \(transcript not retrieved/m, "an unreadable transcript cannot be graded");
	assert.doesNotMatch(text, /execution: aborted/, "`aborted` would claim the child never replied");
	assert.match(text, new RegExp(`read-back from host '${HOST}': FAILED \\(`), text);
	assert.match(text, /transcript not retrieved/);
	// The one line that makes the failure actionable: the file, and how to fetch it.
	assert.match(text, new RegExp(`hc exec --on ${HOST} -- cat ${escapeRegExp(h.remoteSessionPath)}`));
	// Nothing was settled: `unknown` is not a verdict, so the row stays a leftover.
	assert.equal(getNode(db, NODE_ID)?.status, "running");
	assert.equal(settleEvents(db, NODE_ID).length, 0);
	assert.deepEqual(listUnsettledRemoteNodes(db).map((node) => node.name), [NODE_NAME]);
});

test("a row that is already terminal answers `already settled` and writes nothing", async (t) => {
	const h = harness("recover-xm-terminal-");
	t.after(() => h.cleanup());
	writeRemoteSession(h, finishedTranscript("finished before the restart"));
	seedLeftover(h, { status: "settled" });
	const db = newSessionDb(h);
	t.after(() => db.close());

	const before = eventsFor(db, NODE_ID).length;
	const text = textOf(
		await recoverAction({ params: { name: NODE_NAME }, legion: { db, dbPath: h.dbPath }, crossMachine: h.settings }),
	);
	assert.match(text, new RegExp(`^recover: '${NODE_NAME}' is already settled \\(settled\\)`), text);
	assert.match(text, /^execution: success$/m);
	assert.match(text, /finished before the restart/);
	assert.equal(eventsFor(db, NODE_ID).length, before, "no event was appended");
	assert.equal(getNode(db, NODE_ID)?.status, "settled");
});

test("a terminal that is still LIVE on that machine is reported, and nothing is settled", async (t) => {
	const h = harness("recover-xm-live-");
	t.after(() => h.cleanup());
	writeRemoteSession(h, finishedTranscript("still working"));
	seedLeftover(h);
	const db = newSessionDb(h);
	t.after(() => db.close());

	// A terminal the core still holds, under the address the row recorded. Each `hc`
	// spawn is a separate core PROCESS, so it has to be created by the very client
	// the probe will use — hence the injected factory below.
	const live = hcCliClient({ env: process.env });
	await live.start();
	await live.request("terminal.run", {
		on: HOST,
		name: `lgl-run1-${NODE_NAME}`,
		argv: ["sleep", "30"],
		cwd: h.remoteCwd,
	});

	const text = textOf(
		await recoverAction({
			params: { name: NODE_NAME },
			legion: { db, dbPath: h.dbPath },
			crossMachine: h.settings,
			// The probe closes the client it is handed, so `live` is not closed here.
			probeTerminal: createRemoteTerminalProbe({ crossMachine: h.settings, clientFactory: () => live }),
		}),
	);
	assert.match(text, new RegExp(`terminal '${escapeRegExp(REMOTE_TERMINAL)}' is still 'running' on '${HOST}'`), text);
	assert.match(text, /^execution: running \(/m, "a live child has no verdict — it is running");
	assert.match(text, /^acceptance: unknown \(none\)$/m, "a verdict line from an earlier turn cannot accept unfinished work");
	assert.doesNotMatch(text, /execution: success/, "a partial transcript is never presented as finished work");
	assert.equal(getNode(db, NODE_ID)?.status, "running", "the row was NOT settled");
	assert.equal(settleEvents(db, NODE_ID).length, 0);
});

test("an unknown name lists what WAS recoverable instead of a bare NOT_FOUND", async (t) => {
	const h = harness("recover-xm-unknown-");
	t.after(() => h.cleanup());
	seedLeftover(h);
	const db = newSessionDb(h);
	t.after(() => db.close());

	const result = await recoverAction({ params: { name: "nobody" }, legion: { db, dbPath: h.dbPath }, crossMachine: h.settings });
	const text = textOf(result);
	assert.equal((result.details as { error?: string } | undefined)?.error !== undefined, true, "an unknown name is a failure");
	assert.match(text, /unknown cross-machine child "nobody"/);
	assert.match(text, new RegExp(`Waiting for recovery: ${NODE_NAME}`), "the miss names what would work");
});

// ── the WRITE side: a cross-machine launch records what recovery needs ────────

/**
 * The only fact recovery cannot recompute is where the launch put things on that
 * machine: `remote_dir`/`remote_terminal` come from the BACKEND's handle, and the
 * orchestrator is the one place they are persisted (schema v5). This test drives
 * `Orchestrator.launch` with a supervisor double that reports both, then reads the
 * node row the launch wrote — the exact row a later session recovers from.
 */
test("a cross-machine launch persists remote_dir/remote_terminal on the node row", async (t) => {
	const root = mkdtempSync(path.join(tmpdir(), "recover-xm-launch-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const runDir = path.join(root, "run");
	mkdirSync(runDir, { recursive: true });
	const dbPath = path.join(runDir, "legion.db");
	const db = openLegionDb(dbPath);
	t.after(() => db.close());
	insertNode(db, { id: "root", parentId: null, name: "root", role: "root", kind: "pi", depth: 0, runId: "r-xm-1", status: "running" });

	// The backend's handle is the only place these two facts exist (the orchestrator
	// cannot compute them: only the backend knows the run segment it mirrored into
	// and the address its core holds).
	const remoteDir = "/srv/.pi-subagents-mirror/r-xm-1/worker-0";
	const remoteTerminal = `${HOST}/lgl-rxm1-worker-0`;
	class RemoteHandleSupervisor extends FakeSupervisor {
		override async spawnChild(input: Parameters<FakeSupervisor["spawnChild"]>[0]) {
			const handle = await super.spawnChild(input);
			return { ...handle, remoteDir, remoteTerminal };
		}
	}
	const supervisor = new RemoteHandleSupervisor();
	const orchestrator = new Orchestrator({
		supervisor,
		runDir,
		cwd: root,
		legion: { db, dbPath, nodeId: "root", runId: "r-xm-1" },
	});

	// `terminalHostAvailable` is a pair of env markers (REV-31): a host launch is
	// refused outside one.
	const socket = process.env.HC_TERMINAL_SOCKET;
	const id = process.env.HC_TERMINAL_ID;
	process.env.HC_TERMINAL_SOCKET = "/tmp/hc-recover/default.sock";
	process.env.HC_TERMINAL_ID = "t1k";
	try {
		await orchestrator.launch({
			agent: {
				name: "worker",
				description: "recovery write-side role",
				systemPromptMode: "append",
				inheritProjectContext: false,
				inheritSkills: false,
				kind: "pi",
				systemPrompt: "You are a test worker.",
				source: "user",
				filePath: "/fake/worker.md",
				worktree: false,
			},
			task: "fix the flaky test",
			name: NODE_NAME,
			host: HOST,
			hostTarget: {
				host: HOST,
				cwd: "/srv/app",
				node: "node",
				piCli: "pi",
				pathMap: [],
				piLegionRoot: "/srv/pi-legion",
				piExtensions: [],
				mirrorRoot: "/srv/.pi-subagents-mirror",
				worktreeRoot: "/srv/.pi-worktrees",
				// This test is about the ROW the launch writes, not about who may cross
				// (D4 has its own tests): allow the worker role so the role gate is quiet.
				allowRoles: ["centurion", "worker"],
			},
		});
	} finally {
		if (socket === undefined) delete process.env.HC_TERMINAL_SOCKET;
		else process.env.HC_TERMINAL_SOCKET = socket;
		if (id === undefined) delete process.env.HC_TERMINAL_ID;
		else process.env.HC_TERMINAL_ID = id;
	}

	const node = getNode(db, NODE_ID);
	assert.equal(node?.host, HOST, "the machine the child ran on");
	assert.equal(node?.remoteDir, remoteDir, "the dir its transcript lives under, ON that machine");
	assert.equal(node?.remoteTerminal, remoteTerminal, "the address the core holds");
	// And the row is what discovery finds: the write side feeds the read side.
	assert.deepEqual(listUnsettledRemoteNodes(db).map((entry) => entry.id), [NODE_ID]);
});
