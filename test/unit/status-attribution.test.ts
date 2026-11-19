/**
 * 6.2.5 / D1+D4 — one ownership block for a cross-machine leftover, with the
 * launch time as the age.
 *
 * D1: `/legion status` printed `<N> old` from `node.updatedAt`, but hygiene's
 *     `markAbandoned` rewrites `updated_at` on every sweep, so a leftover from a
 *     week ago read "2m old". The age is now `createdAt` (launch, immutable) and
 *     `updatedAt` is printed as the heartbeat it really is.
 * D4: the block that lists a leftover must say WHOSE it is: node id, run, cwd and
 *     the owning session are already in run.json — they were simply dropped.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { renderLegionStatus } from "../../src/extension/legion-status.ts";
import { openLegionDb } from "../../src/legion/db.ts";
import { insertNode, getNode, type LegionNode } from "../../src/legion/nodes.ts";
import {
	listRecoverableLeftovers,
	recoverCrossMachineChild,
	recoveryHeadline,
	renderRemoteOwnershipBlock,
	type CrossMachineRecovery,
} from "../../src/runs/remote-recover.ts";
import { RunStore } from "../../src/runs/store.ts";

const HOST = "hw-nj";
const TERMINAL = "hw-nj/t5g";
const NOW = Date.parse("2026-01-08T00:00:00.000Z");
const LAUNCHED = Date.parse("2026-01-01T00:00:00.000Z"); // 7 days before NOW
const HEARTBEAT = Date.parse("2026-01-07T23:58:00.000Z"); // 2 minutes before NOW

function node(over: Partial<LegionNode> & Pick<LegionNode, "id" | "name" | "parentId" | "depth">): LegionNode {
	return {
		role: "worker",
		kind: "pi",
		runId: "r-1",
		sessionFile: "/tmp/worker-0.jsonl",
		worktreePath: null,
		worktreeHost: null,
		host: HOST,
		remoteDir: "/srv/.pi-subagents-mirror/r-1/worker-0",
		remoteTerminal: TERMINAL,
		model: null,
		team: null,
		status: "running",
		phase: null,
		phaseSince: null,
		reworkCount: 0,
		contractPath: null,
		taskSummary: null,
		createdAt: LAUNCHED,
		updatedAt: HEARTBEAT,
		...over,
	};
}

test("D1: the age comes from createdAt; updatedAt is the heartbeat", () => {
	const block = renderRemoteOwnershipBlock({
		name: "worker-0",
		nodeId: "root.worker-0",
		host: HOST,
		state: "running",
		terminal: TERMINAL,
		launchedAt: LAUNCHED,
		heartbeatAt: HEARTBEAT,
		runId: "r-1",
		cwd: "/Users/someone/code/repo",
		sessionFile: "/Users/someone/.pi/agent/sessions/2026-01-01T00-00-00_abc.jsonl",
		ownerPid: 4242,
		ownerAlive: false,
		now: NOW,
	});
	const text = block.join("\n");
	assert.match(text, /^ {2}launched 2026-01-01T00:00:00\.000Z \(168h00m old\)/m, "launch time and a 7-day age");
	assert.doesNotMatch(text, /launched .*\(2m old\)/, "the heartbeat must not be read as the age");
	assert.match(text, /^ {2}heartbeat 2026-01-07T23:58:00\.000Z \(2m old\)$/m);
});

test("D4: the block names the node, run, cwd, session and owner", () => {
	const block = renderRemoteOwnershipBlock({
		name: "worker-0",
		nodeId: "root.worker-0",
		host: HOST,
		state: "orphaned",
		terminal: TERMINAL,
		launchedAt: LAUNCHED,
		heartbeatAt: HEARTBEAT,
		runId: "r-1bb33dde",
		cwd: "/Users/someone/code/repo",
		sessionFile: "/Users/someone/.pi/agent/sessions/2026-01-01T00-00-00_abc.jsonl",
		ownerPid: 4242,
		ownerAlive: true,
		now: NOW,
	});
	assert.deepEqual(block, [
		`- worker-0 · root.worker-0 · host ${HOST} · orphaned · terminal ${TERMINAL}`,
		"  launched 2026-01-01T00:00:00.000Z (168h00m old)  · run r-1bb33dde · cwd /Users/someone/code/repo · session 2026-01-01T00-00-00_abc.jsonl",
		"  owner pid 4242 (alive)",
		"  heartbeat 2026-01-07T23:58:00.000Z (2m old)",
		'  collect: subagent({ action: "recover", name: "worker-0" })',
	]);
});

test("D4: /legion status prints the same block, with the facts carried from the listing", () => {
	const report = renderLegionStatus({
		nodes: [],
		jobs: [],
		recoverable: [{
			...node({ id: "root.worker-0", name: "worker-0", parentId: "root", depth: 1 }),
			ledgerRunId: "r-1bb33dde",
			cwd: "/Users/someone/code/repo",
			ownerSessionFile: "/Users/someone/.pi/agent/sessions/2026-01-01T00-00-00_abc.jsonl",
			ownerPid: 4242,
			ownerAlive: false,
		}],
		now: NOW,
	});
	assert.equal(report.ok, true);
	assert.match(report.text, /^ {2}launched 2026-01-01T00:00:00\.000Z \(168h00m old\) {2}· run r-1bb33dde · cwd \/Users\/someone\/code\/repo · session 2026-01-01T00-00-00_abc\.jsonl$/m);
	assert.match(report.text, /^ {2}owner pid 4242 \(gone since 2026-01-07T23:58:00\.000Z\)$/m);
});

test("D4: listRecoverableLeftovers carries run.json's cwd/session and the run dir's owner pid", () => {
	const root = mkdtempSync(path.join(tmpdir(), "attribution-"));
	try {
		const store = new RunStore({ rootDir: root });
		const run = store.createRun({
			task: "t",
			cwd: "/Users/someone/code/repo",
			path: [],
			maxDepth: 3,
			herdr: { supervisor: "rpc", node_id: "root" },
		});
		// The owning session's transcript: the ONE credential that says whose run this is.
		writeFileSync(path.join(store.runDir(run.runId), "run.json"), JSON.stringify({
			...store.readRun(run.runId),
			sessionFile: "/Users/someone/.pi/agent/sessions/2026-01-01T00-00-00_abc.jsonl",
		}));
		writeFileSync(path.join(store.runDir(run.runId), "owner.json"), JSON.stringify({ pid: process.pid, host: "x", at: NOW }));

		const db = openLegionDb(path.join(store.runDir(run.runId), "legion.db"));
		try {
			insertNode(db, { id: "root", parentId: null, name: "root", role: "root", kind: "pi", depth: 0, status: "running", createdAt: LAUNCHED, updatedAt: HEARTBEAT });
			insertNode(db, { id: "root.worker-0", parentId: "root", name: "worker-0", role: "worker", kind: "pi", host: HOST, remoteTerminal: TERMINAL, remoteDir: "/srv/x", status: "running", createdAt: LAUNCHED, updatedAt: HEARTBEAT });
			const rows = listRecoverableLeftovers(store);
			assert.equal(rows.length, 1, "one unsettled cross-machine row");
			assert.equal(rows[0]!.cwd, "/Users/someone/code/repo");
			assert.equal(rows[0]!.sessionFile, "/Users/someone/.pi/agent/sessions/2026-01-01T00-00-00_abc.jsonl");
			assert.equal(rows[0]!.ownerPid, process.pid, "the run dir's owner marker");
			assert.equal(rows[0]!.ownerAlive, true);
			assert.equal(getNode(db, "root.worker-0")?.status, "running");
		} finally {
			db.close();
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("D4: recover's headline and miss use the same block", async () => {
	const root = mkdtempSync(path.join(tmpdir(), "attribution-recover-"));
	try {
		const db = openLegionDb(path.join(root, "legion.db"));
		try {
			insertNode(db, { id: "root", parentId: null, name: "root", role: "root", kind: "pi", depth: 0, status: "running", createdAt: LAUNCHED, updatedAt: HEARTBEAT });
			insertNode(db, { id: "root.worker-0", parentId: "root", name: "worker-0", role: "worker", kind: "pi", host: HOST, remoteTerminal: TERMINAL, remoteDir: "/srv/x", status: "running", createdAt: LAUNCHED, updatedAt: HEARTBEAT });

			// A miss lists the waiting rows as the SAME block, not a bare name list.
			const miss = await recoverCrossMachineChild({
				db,
				name: "ghost",
				crossMachine: undefined,
				mirrorDir: root,
				ownership: { runId: "r-1bb33dde", cwd: "/Users/someone/code/repo" },
				now: () => NOW,
			});
			assert.equal(miss.ok, false);
			if (!miss.ok) {
				assert.match(miss.text, /^- worker-0 · root\.worker-0 · host hw-nj · running · terminal hw-nj\/t5g$/m);
				assert.match(miss.text, /^ {2}launched 2026-01-01T00:00:00\.000Z \(168h00m old\) {2}· run r-1bb33dde · cwd \/Users\/someone\/code\/repo · session \(session not recorded\)$/m);
			}

			// The headline of a real recovery prepends the block.
			const recovery: CrossMachineRecovery = {
				kind: "unreadable",
				node: node({ id: "root.worker-0", name: "worker-0", parentId: "root", depth: 1 }),
				execution: { status: "unknown", reason: "unreadable" },
				acceptance: { status: "unknown", level: "none" },
				output: "",
				readback: { host: HOST, lines: 0, returned: 0, truncated: false },
				ageMs: NOW - LAUNCHED,
				ownership: {
					name: "worker-0",
					nodeId: "root.worker-0",
					host: HOST,
					state: "running",
					terminal: TERMINAL,
					launchedAt: LAUNCHED,
					heartbeatAt: HEARTBEAT,
					runId: "r-1bb33dde",
					cwd: "/Users/someone/code/repo",
					ownerPid: 4242,
					ownerAlive: false,
					now: NOW,
				},
			};
			const headline = recoveryHeadline(recovery);
			assert.match(headline, /^- worker-0 · root\.worker-0 · host hw-nj · running · terminal hw-nj\/t5g$/m, "the block leads");
			assert.match(headline, /^recover: the transcript could not be read from 'hw-nj'/m, "then the outcome sentence");
			assert.ok(headline.indexOf("collect:") < headline.indexOf("recover:"), "the block is the head, the verdict follows");
		} finally {
			db.close();
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
