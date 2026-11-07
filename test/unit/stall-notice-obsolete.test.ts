/**
 * The settle-side stall sweep: a child that ends writes its own mail verdict.
 *
 * The delivery paths already refuse a notice whose children have all ended
 * (`discardIfStaleNotice`, pinned in `legion-tools.test.ts` §6.2/§6.6). But they
 * only run on a postman tick: a child that ends between two ticks leaves the row
 * `PENDING` for up to 2s, and — the observation this file exists for — a parent
 * that just finished a `vexillatio` batch was handed exactly that expired to-do as a
 * followUp as soon as its turn ended.
 *
 * So the fact "the child ended" carries its own consequence now: `Orchestrator`
 * sweeps the parent's pending stall notices at the three places it writes a child's
 * terminal status (`recordSettled`, and the two `retired` writes in `retire`). It
 * needs no postman tick and keeps no state of its own: the verdict is read off the
 * ledger every time.
 *
 * What is pinned here, clause by clause:
 *
 *   - the sweep obsoletes exactly the rows the STALL predicate calls stale (reason
 *     `obsolete_after_child_end`), leaves a merged notice that still names a live
 *     child alone, and does NOT touch the phase-timeout class;
 *   - idempotence — a second sweep returns 0 and writes nothing (an OBSOLETE row is
 *     terminal);
 *   - every hook writes the verdict itself: no postman tick exists in this file, so an
 *     OBSOLETE row after `recordSettled`/`retire` can only come from the hook;
 *   - the sweep answers for ONE recipient, walks only the `PENDING` window (an `ACCEPTED`
 *     row is past its reach — the documented limitation), and a row whose predicate
 *     throws costs that row only;
 *   - a HELD inbox still detects: the detector writes a row and only delivery is
 *     withheld (a `tick()` that early-returns while held turns that case red).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { createLegionEventBus } from "../../src/extension/event-bus.ts";
import { LegionPostman } from "../../src/extension/legion-tools.ts";
import { openLegionDb, type DatabaseSync, type SqliteBindValue } from "../../src/legion/db.ts";
import { appendEvent, readEventsAfter } from "../../src/legion/events.ts";
import { MAIL_BOUNCE_REASON, MAIL_DELIVERY, inbox, isStalePhaseTimeoutNotice, isStaleStallNotice, pendingInbox, sendMail, transitionDelivery } from "../../src/legion/mail.ts";
import { beginMailHold, endMailHold, obsoleteStaleStallNotices } from "../../src/legion/mail-release.ts";
import { getNode, insertNode, updateNode } from "../../src/legion/nodes.ts";
import { formatStallNotice } from "../../src/legion/stall-notice.ts";
import { Orchestrator, type OrchestratorLegionContext } from "../../src/runs/orchestrator.ts";
import { RunStore } from "../../src/runs/store.ts";
import type { AgentConfig } from "../../src/shared/types.ts";
import { FakeSupervisor } from "../helpers/fake-supervisor.ts";

const DETECTED_AT = 1_000;

/**
 * The row `writeStallNotice` writes (`legion-tools.ts`): self-addressed
 * (`from_node = to_node`), `notice`, `action-needed`, `PENDING`, body in the frozen
 * `- <child>: ` grammar produced by the real `formatStallNotice`.
 *
 * Reproduced instead of calling the private writer because these cases are about
 * what happens AFTER the row exists.
 */
function queueStallNotice(
	db: DatabaseSync,
	nodeId: string,
	names: readonly string[],
	createdAt = DETECTED_AT,
): number {
	const { subject, body } = formatStallNotice(
		names.map((childName) => ({
			kind: "long-running" as const,
			childName,
			sinceBucket: createdAt,
			sequence: 1,
			elapsedMs: 600_000,
			thresholdMs: 600_000,
		})),
		createdAt,
	);
	const inserted = db
		.prepare(
			`INSERT INTO messages (
				from_node, to_node, subject, body, kind, urgency, delivered, created_at
			) VALUES (?, ?, ?, ?, 'notice', 'action-needed', ?, ?)`,
		)
		.run(nodeId, nodeId, subject, body, MAIL_DELIVERY.PENDING, createdAt);
	return Number(inserted.lastInsertRowid);
}

/** `root` with the named running children. */
function tree(names: readonly string[]): { db: DatabaseSync; ids: Map<string, string> } {
	const db = openLegionDb(":memory:");
	insertNode(db, { parentId: null, name: "root", role: "root", status: "running" }, () => 1);
	const ids = new Map<string, string>();
	names.forEach((name, index) => {
		const node = insertNode(db, { parentId: "root", name, role: "worker", status: "running" }, () => 2 + index);
		ids.set(name, node.id);
	});
	return { db, ids };
}

function retireChild(db: DatabaseSync, ids: Map<string, string>, name: string): void {
	updateNode(db, ids.get(name)!, { status: "retired" }, () => 9_000);
}

// ───────────────────────── the sweep itself ─────────────────────────

test("sweep: a pending stall notice whose children have ALL ended is obsoleted, once", () => {
	const { db, ids } = tree(["alpha"]);
	try {
		const messageId = queueStallNotice(db, "root", ["alpha"]);
		retireChild(db, ids, "alpha");

		assert.equal(obsoleteStaleStallNotices(db, "root"), 1, "the row the stall predicate calls stale is obsoleted");
		assert.equal(pendingInbox(db, "root").length, 0);
		assert.equal(inbox(db, "root", { delivery: MAIL_DELIVERY.OBSOLETE }).length, 1);
		const bounced = readEventsAfter(db, 0).filter((event) => event.type === "mail_bounced");
		assert.deepEqual(
			bounced.map((event) => event.data),
			[{ messageId, toNode: "root", reason: MAIL_BOUNCE_REASON.OBSOLETE_AFTER_CHILD_END }],
			"the verdict names the child-end reason, not the phase-change one",
		);

		// An OBSOLETE row is terminal, so the sweep is idempotent by construction.
		assert.equal(obsoleteStaleStallNotices(db, "root"), 0, "a second sweep has nothing left to do");
		assert.equal(readEventsAfter(db, 0).filter((event) => event.type === "mail_bounced").length, 1, "one verdict, one event");
	} finally {
		db.close();
	}
});

test("sweep: a merged notice that still names a LIVE child is left pending, then obsoleted when the last one ends", () => {
	const { db, ids } = tree(["alpha", "beta"]);
	try {
		queueStallNotice(db, "root", ["alpha", "beta"]);
		retireChild(db, ids, "alpha");

		assert.equal(obsoleteStaleStallNotices(db, "root"), 0, "`beta` is still running: the to-do is still actionable");
		assert.equal(pendingInbox(db, "root").length, 1, "and it stays deliverable rather than being thrown away");

		retireChild(db, ids, "beta");
		assert.equal(obsoleteStaleStallNotices(db, "root"), 1, "the last live name ended: the notice now describes nothing");
		assert.equal(inbox(db, "root", { delivery: MAIL_DELIVERY.OBSOLETE }).length, 1);
	} finally {
		db.close();
	}
});

test("sweep: only the STALL class is swept — a stale phase-timeout notice is not its business", () => {
	const db = openLegionDb(":memory:");
	try {
		insertNode(db, { parentId: null, name: "root", role: "root", status: "running" }, () => 1);
		insertNode(db, { parentId: "root", name: "team", role: "centurion", status: "running", phase: "reviewing", phaseSince: 100 }, () => 2);
		appendEvent(db, "root.team", "phase_timeout", { phase: "reviewing", phaseSince: 100, elapsedMs: 1_800_573, timeoutMs: 1_800_000 }, { now: () => 1_000 });
		const mailed = sendMail(db, {
			fromNode: "root.team",
			to: "parent",
			subject: "Phase timeout: team",
			kind: "notice",
			urgency: "action-needed",
			body: "Legion phase timeout: root.team has been in reviewing for 1800573ms (limit 1800000ms). Work was not killed; decide whether to extend or abort.",
		}, { now: () => 1_000 });
		assert.equal(mailed.ok, true);
		if (!mailed.ok) return;
		// The phase moved on, so the phase-timeout predicate says "stale" — the stall
		// sweep must not act on a verdict it does not own (one predicate each).
		updateNode(db, "root.team", { phase: "done", phaseSince: 5_000 }, () => 5_000);
		// Fixture self-check: without this the case would stay green even if the row it
		// guards were no longer stale by its own class — the exact shape that made an
		// earlier ACCEPTED assertion vacuous.
		assert.equal(
			isStalePhaseTimeoutNotice(db, inbox(db, "root")[0]!),
			true,
			"fixture: the phase-timeout class IS stale here, so a stall-only sweep is a real exclusion",
		);

		assert.equal(obsoleteStaleStallNotices(db, "root"), 0, "only stall notices are swept here");
		assert.equal(pendingInbox(db, "root").length, 1, "the phase-timeout notice keeps its own delivery path");
		assert.equal(inbox(db, "root", { delivery: MAIL_DELIVERY.OBSOLETE }).length, 0);
	} finally {
		db.close();
	}
});

test("sweep: an ACCEPTED stall notice is out of reach — the host queue cannot be recalled", () => {
	const { db, ids } = tree(["alpha"]);
	try {
		const messageId = queueStallNotice(db, "root", ["alpha"]);
		// Handed to the host while the child was still running…
		transitionDelivery(db, messageId, MAIL_DELIVERY.ACCEPTED, () => 2_000);
		// …and only afterwards did the child end. The row is stale by the very predicate
		// this sweep owns, but its text already sits in the host's followUp queue, which no
		// ledger write can recall — the documented known limitation. Pinned so a sweep that
		// walks EVERY delivery state (rather than `pendingInbox`) turns red here.
		retireChild(db, ids, "alpha");
		// Fixture self-check: the verdict IS the stale one here, so what is out of reach is
		// the delivery state, not the predicate — otherwise a sweep over every state would
		// still pass this case for the wrong reason.
		assert.equal(
			isStaleStallNotice(db, inbox(db, "root", { delivery: MAIL_DELIVERY.ACCEPTED })[0]!),
			true,
			"fixture: the stall verdict applies now — the row is unreachable because it is ACCEPTED",
		);

		assert.equal(obsoleteStaleStallNotices(db, "root"), 0, "an ACCEPTED row is not this sweep's to rewrite");
		assert.equal(inbox(db, "root", { delivery: MAIL_DELIVERY.ACCEPTED }).length, 1, "it stays ACCEPTED");
		assert.equal(inbox(db, "root", { delivery: MAIL_DELIVERY.OBSOLETE }).length, 0);
		assert.equal(readEventsAfter(db, 0).filter((event) => event.type === "mail_bounced").length, 0, "no verdict is written for it");
	} finally {
		db.close();
	}
});

test("sweep: another node's stale stall notice is not touched — the sweep answers for ONE recipient", () => {
	const db = openLegionDb(":memory:");
	try {
		insertNode(db, { parentId: null, name: "root", role: "root", status: "running" }, () => 1);
		insertNode(db, { parentId: "root", name: "team", role: "centurion", status: "running" }, () => 2);
		const alpha = insertNode(db, { parentId: "root", name: "alpha", role: "worker", status: "running" }, () => 3);
		const member = insertNode(db, { parentId: "root.team", name: "w0", role: "worker", status: "running" }, () => 4);
		queueStallNotice(db, "root", ["alpha"]);
		queueStallNotice(db, "root.team", ["w0"]);
		// BOTH notices are stale, so an implementation that ignores `parentNodeId` and sweeps
		// the whole ledger would obsolete two rows here instead of one.
		updateNode(db, alpha.id, { status: "retired" }, () => 9_000);
		updateNode(db, member.id, { status: "retired" }, () => 9_000);

		assert.equal(obsoleteStaleStallNotices(db, "root"), 1, "only the root's own notice is judged");
		assert.equal(pendingInbox(db, "root.team").length, 1, "the sibling's notice is left to its own hook/postman");
		assert.equal(inbox(db, "root", { delivery: MAIL_DELIVERY.OBSOLETE }).length, 1);

		assert.equal(obsoleteStaleStallNotices(db, "root.team"), 1, "and its own sweep still works");
	} finally {
		db.close();
	}
});

/**
 * A ledger view whose CHILD lookup for `brokenName` throws.
 *
 * `isStaleStallNotice` reaches the tree through `getChildByName(db, parent, name)`, so a
 * throw on exactly one row is the only way to prove the per-row guard really covers the
 * predicate: with the check outside the `try`, the whole pass aborted (nothing swept, and
 * the throw escaped onto the settle/retire path).
 */
function faultyChildLookup(db: DatabaseSync, brokenName: string): DatabaseSync {
	return {
		exec: (sql) => db.exec(sql),
		close: () => db.close(),
		prepare: (sql) => {
			const statement = db.prepare(sql);
			if (!sql.includes("FROM nodes")) return statement;
			return {
				get: (...args: SqliteBindValue[]) => {
					if (args[1] === brokenName) throw new Error(`injected: child lookup for ${brokenName} failed`);
					return statement.get(...args);
				},
				all: (...args: SqliteBindValue[]) => statement.all(...args),
				run: (...args: SqliteBindValue[]) => statement.run(...args),
			};
		},
	};
}

test("sweep: a row whose PREDICATE throws costs only that row, never the pass", () => {
	const { db, ids } = tree(["alpha", "beta"]);
	try {
		const brokenId = queueStallNotice(db, "root", ["alpha"]);
		const healthyId = queueStallNotice(db, "root", ["beta"]);
		retireChild(db, ids, "alpha");
		retireChild(db, ids, "beta");

		const faulty = faultyChildLookup(db, "alpha");
		assert.equal(
			obsoleteStaleStallNotices(faulty, "root"),
			1,
			"the healthy row behind the broken one is still swept (no throw at the caller)",
		);
		const obsoleted = inbox(db, "root", { delivery: MAIL_DELIVERY.OBSOLETE });
		assert.deepEqual(obsoleted.map((message) => message.id), [healthyId], "the healthy row is the one that moved");
		const stillPending = pendingInbox(db, "root");
		assert.deepEqual(
			stillPending.map((message) => message.id),
			[brokenId],
			"the broken row is skipped, not swept: it keeps today's behaviour (the postman discards it next tick)",
		);
	} finally {
		db.close();
	}
});

test("hold: a held inbox still DETECTS a stall — it only refuses to deliver", async () => {
	// The claim in the changelog is "the hold suppresses delivery, not detection". That is
	// only true while the detectors keep running inside the hold: a `tick()` that
	// early-returns when held would also skip heartbeats, ACCEPTED confirmation and the
	// orphan scan, and this case is what notices.
	const db = openLegionDb(":memory:");
	const supervisor = new FakeSupervisor();
	const parentMail: string[] = [];
	try {
		const bornAt = Date.now() - 120_000;
		insertNode(db, { parentId: null, name: "root", role: "root", status: "running" }, () => bornAt);
		// `nodes.created_at` is the L2 baseline's first sight (`stallClockFor`), so a child
		// born two minutes ago is already past the one-minute radius set below.
		insertNode(db, { parentId: "root", name: "alpha", role: "worker", status: "running" }, () => bornAt);
		supervisor.children.set("alpha", {
			name: "alpha",
			sessionFile: "/tmp/stall-obsolete-alpha.jsonl",
			alive: true,
			waiters: [],
			responses: [],
			usage: null,
		});
		const postman = new LegionPostman({
			db,
			nodeId: "root",
			supervisor,
			now: () => Date.now(),
			sendRootMessage: (text) => parentMail.push(text),
			noticeMsForRole: () => 60_000,
			settings: { silenceNoticeMs: 600_000, orphanStaleMs: Number.MAX_SAFE_INTEGER },
			intervalMs: 10_000,
		});
		try {
			beginMailHold("root");
			try {
				await postman.tick();
				const queued = pendingInbox(db, "root");
				assert.equal(queued.length, 1, "the detector ran inside the hold: the fact is written");
				assert.match(queued[0]!.subject, /Stall notice: alpha/);
				assert.deepEqual(parentMail, [], "…and the held postman delivered none of it");
			} finally {
				endMailHold("root");
			}
			// Same row, same postman, one holder fewer: delivery resumes.
			await postman.tick();
			assert.equal(pendingInbox(db, "root").length, 0, "the release restores the delivery path");
			assert.equal(parentMail.length, 1);
			assert.match(parentMail[0]!, /Stall notice: alpha/);
		} finally {
			postman.stop();
		}
	} finally {
		db.close();
	}
});

// ───────────────────────── the three hooks ─────────────────────────

function agent(): AgentConfig {
	return {
		name: "worker",
		description: "worker test role",
		systemPromptMode: "append",
		inheritProjectContext: true,
		inheritSkills: false,
		kind: "pi",
		systemPrompt: "You are worker.",
		source: "user",
		filePath: "/fake/worker.md",
	};
}

/** A rooted legion ledger plus the run store a launch needs (the #372 m2 fixture). */
function fixture() {
	const rootDir = mkdtempSync(path.join(tmpdir(), "stall-obsolete-"));
	const runStore = new RunStore({ rootDir: path.join(rootDir, ".pi-subagents") });
	const rootRun = runStore.createRun({ task: "root task", cwd: rootDir, nodeId: "root", maxDepth: 4, herdr: { supervisor: "inprocess" } });
	const db = openLegionDb(":memory:");
	insertNode(db, { parentId: null, name: "root", role: "root", runId: rootRun.runId, status: "running" });
	const context: OrchestratorLegionContext = {
		db,
		dbPath: path.join(rootDir, "legion.db"),
		nodeId: "root",
		parentNodeId: null,
		parentRunId: null,
		runId: rootRun.runId,
		runStore,
		settings: { maxDepth: 4, maxChildrenPerNode: 8, maxActiveNodes: 30 },
		eventBus: createLegionEventBus(),
	};
	return {
		db,
		rootDir,
		runStore,
		rootRun,
		context,
		cleanup() {
			db.close();
			rmSync(rootDir, { recursive: true, force: true });
		},
	};
}

test("hook: a child that SETTLES obsoletes its pending stall notice with no postman tick", async () => {
	const fx = fixture();
	const supervisor = new FakeSupervisor({ immediateTimeout: false });
	const orchestrator = new Orchestrator({
		supervisor,
		runDir: fx.runStore.runDir(fx.rootRun.runId),
		cwd: fx.rootDir,
		maxDepth: 4,
		legion: fx.context,
	});
	try {
		const { child } = await orchestrator.launch({ agent: agent(), task: "own the slice", name: "w0", worktree: false });
		assert.equal(child.nodeId, "root.w0");
		const messageId = queueStallNotice(fx.db, "root", ["w0"]);
		assert.equal(pendingInbox(fx.db, "root").length, 1, "precondition: the notice is queued for the parent");

		supervisor.settle("w0", { text: "all done", stopReason: "stop" });
		const collected = await orchestrator.collect("w0", { timeoutMs: 5_000 });
		assert.equal(collected.execution.status, "success", "precondition: the child's turn really finished");
		assert.equal(getNode(fx.db, "root.w0")?.status, "settled");

		assert.equal(pendingInbox(fx.db, "root").length, 0, "no postman ran in this test: the settle path wrote the verdict");
		assert.equal(inbox(fx.db, "root", { delivery: MAIL_DELIVERY.OBSOLETE }).length, 1);
		assert.deepEqual(
			readEventsAfter(fx.db, 0).filter((event) => event.type === "mail_bounced").map((event) => event.data),
			[{ messageId, toNode: "root", reason: MAIL_BOUNCE_REASON.OBSOLETE_AFTER_CHILD_END }],
		);
	} finally {
		fx.cleanup();
	}
});

test("hook: retiring a PAUSED child obsoletes its pending stall notice too", async () => {
	const fx = fixture();
	const supervisor = new FakeSupervisor({ immediateTimeout: false });
	const orchestrator = new Orchestrator({
		supervisor,
		runDir: fx.runStore.runDir(fx.rootRun.runId),
		cwd: fx.rootDir,
		maxDepth: 4,
		legion: fx.context,
	});
	try {
		await orchestrator.launch({ agent: agent(), task: "own the slice", name: "w0", worktree: false });
		queueStallNotice(fx.db, "root", ["w0"]);
		// #374 §3: the parent session leaving is a pause — the branch that writes
		// `retired` directly instead of going through `recordSettled`.
		await orchestrator.retire("w0", { cause: "session-shutdown" });

		assert.equal(getNode(fx.db, "root.w0")?.status, "retired");
		assert.equal(pendingInbox(fx.db, "root").length, 0, "the retire branch sweeps on its own");
		assert.equal(inbox(fx.db, "root", { delivery: MAIL_DELIVERY.OBSOLETE }).length, 1);
	} finally {
		fx.cleanup();
	}
});

test("hook: retiring a child with no recorded execution writes `retired` and sweeps as well", async () => {
	const fx = fixture();
	const supervisor = new FakeSupervisor({ immediateTimeout: false });
	const orchestrator = new Orchestrator({
		supervisor,
		runDir: fx.runStore.runDir(fx.rootRun.runId),
		cwd: fx.rootDir,
		maxDepth: 4,
		legion: fx.context,
	});
	try {
		const { child } = await orchestrator.launch({ agent: agent(), task: "own the slice", name: "w0", worktree: false });
		queueStallNotice(fx.db, "root", ["w0"]);
		// With no session to derive an outcome from, `retire` cannot call
		// `recordSettled` — it takes the last branch and writes `retired` itself.
		rmSync(child.sessionFile, { force: true });
		await orchestrator.retire("w0");

		assert.equal(getNode(fx.db, "root.w0")?.status, "retired");
		assert.equal(pendingInbox(fx.db, "root").length, 0, "the direct `retired` write sweeps too");
		assert.equal(inbox(fx.db, "root", { delivery: MAIL_DELIVERY.OBSOLETE }).length, 1);
	} finally {
		fx.cleanup();
	}
});
