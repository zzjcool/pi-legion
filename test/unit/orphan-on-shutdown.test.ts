/**
 * 6.2.4 / D2 — a parent session that exits NATURALLY must not bury a child that is
 * still running on another machine.
 *
 * The measured 6.2.3 defect (docs/reports/release-6.2.3-verification.md §3.2): the
 * exit stamped the row `retired` + `node_retired{reason:"session-shutdown"}` while
 * the remote child was still in `sleep 60`. `recover` reads a terminal row as
 * "already settled", so it answered from the launch-time snapshot, fetched nothing,
 * and the real result — which the child DID produce 75s later — became permanently
 * unreachable.
 *
 * Three states replace that single answer:
 *
 *   aborted    a local child (dies with this process), or a stop that was
 *              delivered AND confirmed;
 *   unfetched  the turn over there is over (graded, or a full transcript here) and
 *              nobody read it back;
 *   orphaned   still running over there, or nobody can say.
 *
 * `orphaned`/`unfetched` are non-terminal by construction: that is what allows
 * `recover` to fetch and `/legion status` to list them.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { renderStatusOverview } from "../../index.ts";
import { createSessionRuntime } from "../../src/extension/runtime.ts";
import { renderRecoverableSection, renderLegionStatus } from "../../src/extension/legion-status.ts";
import { openLegionDb, type DatabaseSync } from "../../src/legion/db.ts";
import { appendEvent, readEventsAfter } from "../../src/legion/events.ts";
import { markSessionInterrupted, wasSessionInterrupted } from "../../src/legion/interrupt.ts";
import { getChildren, getNode, insertNode, listUnsettledRemoteNodes } from "../../src/legion/nodes.ts";
import { orphanFateOf, orphanMarkFor, shutdownFate, isCrossMachineHost, remoteSessionPathFor } from "../../src/legion/orphan.ts";
import type { ChildRecord } from "../../src/shared/types.ts";

const HOST = "fakebox";
const REMOTE_TERMINAL = `${HOST}/lgl-r1-worker-0`;

/** A ledger with a root and one child; `host` decides local vs cross-machine. */
function ledger(prefix: string, child: { host?: string; status?: "running" | "blocked" | "settled" } = {}): {
	db: DatabaseSync;
	dir: string;
	childId: string;
	close: () => void;
} {
	const dir = mkdtempSync(path.join(tmpdir(), prefix));
	const db = openLegionDb(path.join(dir, "legion.db"));
	const now = Date.now();
	insertNode(db, { id: "root", parentId: null, name: "root", role: "root", kind: "pi", depth: 0, runId: "r-1", status: "running", createdAt: now, updatedAt: now });
	const childNode = insertNode(db, {
		parentId: "root",
		name: "worker-0",
		role: "worker",
		kind: "pi",
		status: child.status ?? "running",
		...(child.host ? { host: child.host } : {}),
		...(child.host ? { remoteDir: "/srv/.pi-subagents-mirror/r-1/worker-0", remoteTerminal: REMOTE_TERMINAL } : {}),
		sessionFile: path.join(dir, "worker-0.jsonl"),
		createdAt: now,
		updatedAt: now,
	});
	return { db, dir, childId: childNode.id, close: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

// ── the three-way decision itself ────────────────────────────────────────────

test("shutdownFate: a LOCAL child is `aborted` — it dies with this process (6.2.3 kept)", () => {
	// Every combination answers the same for a local child: the fate is not about
	// what the child was doing, it is about the parent's exit killing it.
	for (const stopped of [true, false]) {
		for (const programEnded of [true, false]) {
			assert.equal(shutdownFate({ crossMachine: false, stopped, programEnded }), "aborted");
		}
	}
});

test("shutdownFate: a cross-machine child still running (or unknown) is `orphaned`", () => {
	assert.equal(shutdownFate({ crossMachine: true, stopped: false, programEnded: false }), "orphaned");
});

test("shutdownFate: a cross-machine child whose turn is over is `unfetched`", () => {
	assert.equal(shutdownFate({ crossMachine: true, stopped: false, programEnded: true }), "unfetched");
});

test("shutdownFate: a DELIVERED and CONFIRMED stop is still `aborted`, whatever the transcript says", () => {
	// `stop`/`abort` keep 6.2.3's verdict byte for byte: the process really was killed.
	assert.equal(shutdownFate({ crossMachine: true, stopped: true, programEnded: false }), "aborted");
	assert.equal(shutdownFate({ crossMachine: true, stopped: true, programEnded: true }), "aborted");
});

test("isCrossMachineHost / remoteSessionPathFor: the two facts the marker records", () => {
	assert.equal(isCrossMachineHost("vps"), true);
	assert.equal(isCrossMachineHost(""), false);
	assert.equal(isCrossMachineHost("   "), false);
	assert.equal(isCrossMachineHost(undefined), false);
	assert.equal(remoteSessionPathFor("/srv/mirror/run-1/worker-0"), "/srv/mirror/run-1/worker-0/session.jsonl");
	assert.equal(remoteSessionPathFor(undefined), undefined);
});

// ── the ledger marker (what recover/status read) ─────────────────────────────

test("orphanMarkFor: reads the exit's marker, and a LATER settle event supersedes it", () => {
	const l = ledger("orphan-mark-", { host: HOST });
	try {
		assert.equal(orphanMarkFor(l.db, l.childId), undefined, "no marker yet");
		appendEvent(l.db, l.childId, "orphan_detected", {
			parentId: "root",
			reason: "session-shutdown",
			fate: "orphaned",
			host: HOST,
			remoteDir: "/srv/.pi-subagents-mirror/r-1/worker-0",
			remoteTerminal: REMOTE_TERMINAL,
			remoteSessionPath: "/srv/.pi-subagents-mirror/r-1/worker-0/session.jsonl",
		});
		const mark = orphanMarkFor(l.db, l.childId);
		assert.equal(mark?.fate, "orphaned");
		assert.equal(mark?.host, HOST);
		assert.equal(mark?.remoteTerminal, REMOTE_TERMINAL);
		assert.equal(mark?.remoteSessionPath, "/srv/.pi-subagents-mirror/r-1/worker-0/session.jsonl");
		assert.equal(orphanFateOf(l.db, l.childId), "orphaned");

		// The recovery that follows writes a settle event: the marker is history now,
		// and the SECOND `recover` must answer `already settled` with zero fetch.
		appendEvent(l.db, l.childId, "node_settled", { execution: "success", recovered: true });
		assert.equal(orphanMarkFor(l.db, l.childId), undefined, "a later settle wins");
		assert.equal(orphanFateOf(l.db, l.childId), undefined);
	} finally {
		l.close();
	}
});

test("orphanMarkFor: a marker with a different reason is not this exit's", () => {
	const l = ledger("orphan-mark-reason-", { host: HOST });
	try {
		appendEvent(l.db, l.childId, "orphan_detected", { parentId: "root", reason: "no_active_supervisor", fate: "orphaned" });
		assert.equal(orphanMarkFor(l.db, l.childId), undefined);
	} finally {
		l.close();
	}
});

// ── the exit marker leaves the LEDGER row open ───────────────────────────────

test("markSessionInterrupted: a local child is paused (6.2.3), a cross-machine child stays OPEN", () => {
	const local = ledger("orphan-interrupt-local-");
	try {
		assert.deepEqual(markSessionInterrupted(local.db, "root", () => Date.now()), [local.childId]);
		assert.equal(getNode(local.db, local.childId)?.status, "retired");
		assert.equal(wasSessionInterrupted(local.db, local.childId), true);
	} finally {
		local.close();
	}

	const remote = ledger("orphan-interrupt-remote-", { host: HOST });
	try {
		assert.deepEqual(markSessionInterrupted(remote.db, "root", () => Date.now()), [], "not marked retired");
		assert.equal(getNode(remote.db, remote.childId)?.status, "running", "still open for recover");
		assert.equal(wasSessionInterrupted(remote.db, remote.childId), false, "the pause marker is for local children");
		// …which is what keeps it discoverable by the next session.
		assert.deepEqual(listUnsettledRemoteNodes(remote.db).map((node) => node.name), ["worker-0"]);
		assert.deepEqual(getChildren(remote.db, "root").length, 1);
	} finally {
		remote.close();
	}
});

// ── the runtime release: not waited for, not killed ──────────────────────────

test("releaseCrossMachineChildren: stamps the record, cancels the collect, drops the job — local jobs untouched", async () => {
	const runtime = createSessionRuntime({ sendMessage() {} });
	const seen: Array<{ name: string; cause?: string }> = [];
	let remoteSignal: AbortSignal | undefined;
	let localAborted = false;

	runtime.track({
		name: "remote-0",
		runId: "r-1",
		agent: "worker",
		sessionFile: "/tmp/remote-0.jsonl",
		timeoutMs: 10_000,
		host: HOST,
		// A collect on a still-running remote child polls ref'd timers until its
		// deadline; returning a promise that only settles on abort is what makes
		// "the shutdown stopped waiting" assertable.
		collect: (opts) => new Promise((_resolve, reject) => {
			remoteSignal = opts?.signal;
			opts?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
		}),
		retire: async (opts) => { seen.push({ name: "remote-0", cause: opts?.cause }); },
	});
	runtime.track({
		name: "local-0",
		runId: "r-1",
		agent: "worker",
		sessionFile: "/tmp/local-0.jsonl",
		timeoutMs: 10_000,
		collect: (opts) => new Promise((_resolve, reject) => {
			opts?.signal?.addEventListener("abort", () => { localAborted = true; reject(new Error("aborted")); }, { once: true });
		}),
		retire: async (opts) => { seen.push({ name: "local-0", cause: opts?.cause }); },
	});

	// Start both collects the way the watch does, then leave the session.
	const pending = [runtime.watch("remote-0"), runtime.watch("local-0")];
	const released = await runtime.releaseCrossMachineChildren();
	assert.deepEqual(released, ["remote-0"], "only the cross-machine child is released");
	assert.deepEqual(seen, [{ name: "remote-0", cause: "session-shutdown" }], "its record is stamped, and nothing is killed by this call");
	assert.equal(remoteSignal?.aborted, true, "its in-flight collect was cancelled (that is what lets pi --print exit)");
	assert.equal(localAborted, false, "a local child still owes its one last collect");
	assert.deepEqual(runtime.activeJobs().map((job) => job.name), ["local-0"], "the drain/retire loop cannot see it any more");
	assert.equal(runtime.get("remote-0"), undefined);
	runtime.dispose();
	void pending;
});

// ── D3: the dead block names the machine and the terminal ────────────────────

function record(partial: Partial<ChildRecord> & { name: string }): ChildRecord {
	return {
		sessionFile: `/tmp/${partial.name}.jsonl`,
		ownerToken: `tok-${partial.name}`,
		state: "working",
		spawnedAt: "2026-01-01T00:00:00.000Z",
		agent: "worker",
		kind: "pi",
		...partial,
	};
}

test("status dead block carries host and remote terminal (D3), and an orphaned record says so", () => {
	const child = record({
		name: "worker-0",
		state: "orphaned",
		host: HOST,
		remoteTerminal: REMOTE_TERMINAL,
		orphaned: {
			at: 0,
			fate: "orphaned",
			reason: "session-shutdown",
			host: HOST,
			remoteTerminal: REMOTE_TERMINAL,
			remoteSessionPath: "/srv/.pi-subagents-mirror/r-1/worker-0/session.jsonl",
		},
	});
	const text = renderStatusOverview([{ child, alive: false, owner: "dead" }], 0);
	assert.match(text, /^worker-0 — state=orphaned agent=worker kind=pi$/m, "the fate is the state, not a fake `failed`");
	assert.match(text, /^owner: dead \(pid gone\)$/m);
	assert.match(text, new RegExp(`^host=${HOST}$`, "m"), "where it actually ran");
	assert.match(text, new RegExp(`^terminal=${REMOTE_TERMINAL}$`, "m"), "the address the core holds");
	assert.match(text, /^supervisor=unknown$/m);
	assert.doesNotMatch(text, /state=failed/, "an orphan is not a failure");
});

test("status dead block: a LOCAL record grows no host/terminal lines", () => {
	const text = renderStatusOverview([{ child: record({ name: "worker-0", state: "working" }), alive: false, owner: "dead" }], 0);
	assert.doesNotMatch(text, /^host=/m);
	assert.doesNotMatch(text, /^terminal=/m);
});

// ── /legion status lists them, with the fate ─────────────────────────────────

test("/legion status: a leftover the exit kept open is listed, and the fate is named", () => {
	const l = ledger("orphan-status-", { host: HOST });
	try {
		const node = getNode(l.db, l.childId)!;
		const plain = renderLegionStatus({ nodes: [node], jobs: [], recoverable: [node], now: Date.now() }).text;
		assert.match(plain, /Recoverable cross-machine children/);
		assert.match(plain, new RegExp(`- worker-0 · root.worker-0 · host ${HOST} · running · terminal ${REMOTE_TERMINAL}`));

		const orphaned = renderLegionStatus({
			nodes: [node],
			jobs: [],
			recoverable: [{ ...node, orphaned: "orphaned" }],
			now: Date.now(),
		}).text;
		assert.match(orphaned, new RegExp(`- worker-0 · root.worker-0 · host ${HOST} · orphaned · terminal ${REMOTE_TERMINAL}`));

		const unfetched = renderLegionStatus({
			nodes: [node],
			jobs: [],
			recoverable: [{ ...node, orphaned: "unfetched" }],
			now: Date.now(),
		}).text;
		assert.match(unfetched, /· unfetched · terminal/, "the frozen D4 state word is the fate");
		assert.equal(renderRecoverableSection([], [], 0), undefined);
	} finally {
		l.close();
	}
});

// ── the marker is not a settle event ────────────────────────────────────────

test("the exit marker is an `orphan_detected` event, inside the closed set of 16", () => {
	const l = ledger("orphan-event-", { host: HOST });
	try {
		appendEvent(l.db, l.childId, "orphan_detected", { reason: "session-shutdown", fate: "unfetched" });
		const events = readEventsAfter(l.db, 0, { nodeId: l.childId });
		assert.deepEqual(events.map((event) => event.type), ["orphan_detected"], "no settle event was written with it");
		assert.equal((events[0]?.data as { fate?: string } | null)?.fate, "unfetched");
		assert.equal(getNode(l.db, l.childId)?.status, "running", "the row was not closed");
	} finally {
		l.close();
	}
});
