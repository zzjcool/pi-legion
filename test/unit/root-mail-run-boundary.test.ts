/**
 * root 收件箱的 run 边界门 — `docs/contracts/root-mail-run-boundary-v1.md` §4.
 *
 * The defect this file pins is a queueing one: `followUp` mail is consumed only at a
 * turn boundary, so pushing it into the host's queue DURING the root's own run buys no
 * latency and only deepens a queue the host cannot retract (R2/R4). The gate lives in
 * `LegionPostman.deliverRootInbox` (D1) and reads one fact through one seam (D2):
 * `isRunActive` → `isLegionRunActive(nodeId)` → the runtime's `() => parentRunActive`.
 *
 * One test per clause of §4:
 *
 *   §4.1 the gate: a live run means the notice stays PENDING, never ACCEPTED;
 *   §4.2 the positive control on the same fixture (`agent_settled` delivers);
 *   §4.3 the incident: the child ends DURING the held run — the verdict is written at
 *        the boundary, which is exactly the injection that must not happen;
 *   §4.4 scope is the whole inbox: a `report` waits too (D1 is not a kind whitelist);
 *   §4.5 the child channel is untouched (`deliverChildren` is not shorted by the gate);
 *   §4.6 fail-open: absent / throwing seam ⇒ deliver now, byte-for-byte as before (D3);
 *   §4.7 publish is idempotent and `dispose()` withdraws the reader.
 *
 * §4.8 needs no test here — it is the existing regression set (`legion-tools.test.ts`
 * §6.2/§6.3/§6.6 and `wait-mail-preempt.test.ts`), run alongside this file.
 *
 * LAYERS. `FakeSupervisor` has no `lastEventAt`, so L1 never fires and no
 * `noticeMsForRole` is passed, so L2 never fires: every notice in this file is
 * INSERTed directly (`queueStallNotice`) instead of being detected. That is the layer
 * the gate lives in — what happens AFTER the row exists. No timer is started; the
 * tests call `tick()` themselves.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { createSessionRuntime } from "../../src/extension/runtime.ts";
import { LegionPostman, type LegionPostmanOptions } from "../../src/extension/legion-tools.ts";
import { openLegionDb, type DatabaseSync } from "../../src/legion/db.ts";
import { readEventsAfter } from "../../src/legion/events.ts";
import { MAIL_BOUNCE_REASON, MAIL_DELIVERY, inbox, pendingInbox, sendMail } from "../../src/legion/mail.ts";
import { insertNode, updateNode } from "../../src/legion/nodes.ts";
import { isLegionRunActive, publishLegionRunActivity, withdrawLegionRunActivity } from "../../src/legion/run-active.ts";
import { formatStallNotice } from "../../src/legion/stall-notice.ts";
import { FakeSupervisor } from "../helpers/fake-supervisor.ts";

/** Fixed clock: every ledger write in a case gets the same, tiny timestamp. */
const NOW = 5_001;

/**
 * The row `writeStallNotice` writes (`legion-tools.ts`): self-addressed
 * (`from_node = to_node`), `notice`, `action-needed`, `PENDING`, body in the frozen
 * `- <child>: ` grammar produced by the real `formatStallNotice`.
 *
 * Reproduced instead of calling the private writer because these cases are about the
 * DELIVERY side: the row must already exist, verbatim, before a tick starts.
 */
function queueStallNotice(
	db: DatabaseSync,
	nodeId: string,
	names: readonly string[],
	createdAt: number,
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

interface RunFixture {
	db: DatabaseSync;
	supervisor: FakeSupervisor;
	rootMessages: string[];
	/** Child name → node id (`root.<name>`). */
	ids: Map<string, string>;
	/** Flip the run fact the way the host does: `agent_start` / `agent_settled`. */
	setRunActive(active: boolean): void;
	/** Withdraw the reader FIRST (the registry is process-wide), then close the ledger. */
	dispose(): void;
}

/**
 * `root` plus `names` as running children, with a run-activity reader published under
 * `root` for the duration of the case.
 *
 * The registry outlives a test, so `dispose()` always withdraws: a leaked `true` would
 * follow this file into whichever test runs next in the same process.
 */
function fixture(names: readonly string[]): RunFixture {
	const db = openLegionDb(":memory:");
	const supervisor = new FakeSupervisor();
	const rootMessages: string[] = [];
	const ids = new Map<string, string>();
	let active = false;
	insertNode(db, { parentId: null, name: "root", role: "root", status: "running" }, () => 1);
	names.forEach((name, index) => {
		const node = insertNode(db, { parentId: "root", name, role: "worker", status: "running" }, () => 2 + index);
		ids.set(name, node.id);
	});
	publishLegionRunActivity("root", () => active);
	return {
		db,
		supervisor,
		rootMessages,
		ids,
		setRunActive(next: boolean): void {
			active = next;
		},
		dispose(): void {
			withdrawLegionRunActivity("root");
			db.close();
		},
	};
}

/**
 * The production wiring minus the process: the postman asks the registry, the registry
 * reads the closure `setRunActive` flips (`index.ts` passes exactly this shape).
 *
 * `seam: false` builds the pre-contract postman — no `isRunActive` at all — which is
 * what §4.6's fail-open case needs. `orphanStaleMs` is parked out of reach so the first
 * tick's orphan scan can never converge a fixture under timestamps this small.
 */
function postmanFor(
	f: RunFixture,
	options: Partial<LegionPostmanOptions> = {},
	seam = true,
): LegionPostman {
	return new LegionPostman({
		db: f.db,
		nodeId: "root",
		supervisor: f.supervisor,
		now: () => NOW,
		sendRootMessage: (message: string) => f.rootMessages.push(message),
		...(seam ? { isRunActive: () => isLegionRunActive("root") } : {}),
		settings: { orphanStaleMs: Number.MAX_SAFE_INTEGER },
		intervalMs: 10_000,
		...options,
	});
}

/** Run `fn` with `console.warn` captured (restored even when it throws). */
async function captureWarnings(fn: () => Promise<void>): Promise<string[]> {
	const warnings: string[] = [];
	const previous = console.warn;
	console.warn = (...args: unknown[]) => {
		warnings.push(args.map((arg) => (typeof arg === "string" ? arg : String(arg))).join(" "));
	};
	try {
		await fn();
	} finally {
		console.warn = previous;
	}
	return warnings;
}

/** Every `mail_bounced` verdict on the ledger, oldest first. */
function bounces(db: DatabaseSync): unknown[] {
	return readEventsAfter(db, 0)
		.filter((event) => event.type === "mail_bounced")
		.map((event) => event.data);
}

// ───────────────────────────── §4.1 the gate ─────────────────────────────

test("§4.1 a live root run keeps a stall notice out of the host queue", async () => {
	const f = fixture(["worker"]);
	const postman = postmanFor(f);
	try {
		const messageId = queueStallNotice(f.db, "root", ["worker"], 1_000);
		f.setRunActive(true);
		await postman.tick();
		// A second tick proves the gate is not "a one-tick delay": the row is re-judged
		// every tick and stays exactly where it is for as long as the run holds the turn.
		await postman.tick();

		assert.deepEqual(f.rootMessages, [], "nothing is pushed into the host's followUp queue while the run is live");
		assert.deepEqual(
			pendingInbox(f.db, "root").map((message) => message.id),
			[messageId],
			"the row stays PENDING, where the next tick re-judges it",
		);
		assert.equal(inbox(f.db, "root", { delivery: MAIL_DELIVERY.ACCEPTED }).length, 0, "and it is never claimed");
	} finally {
		postman.stop();
		f.dispose();
	}
});

test("§4.2 positive control: the same fixture delivers at the run boundary", async () => {
	const f = fixture(["worker"]);
	const postman = postmanFor(f);
	try {
		queueStallNotice(f.db, "root", ["worker"], 1_000);
		f.setRunActive(true);
		await postman.tick();
		assert.deepEqual(f.rootMessages, [], "precondition: the gate is closed on the same fixture");

		f.setRunActive(false); // `agent_settled`
		await postman.tick();

		assert.equal(f.rootMessages.length, 1, "the next tick after the boundary delivers");
		assert.match(f.rootMessages[0]!, /Stall notice: worker/);
		assert.equal(inbox(f.db, "root", { delivery: MAIL_DELIVERY.ACCEPTED }).length, 1);
		assert.equal(inbox(f.db, "root", { delivery: MAIL_DELIVERY.OBSOLETE }).length, 0);
		// ACCEPTED is the terminal fact of a send; DELIVERED needs the session file's own
		// evidence, and this fixture has none — so it must not move on its own account.
		assert.equal(inbox(f.db, "root", { delivery: MAIL_DELIVERY.DELIVERED }).length, 0);
	} finally {
		postman.stop();
		f.dispose();
	}
});

test("§4.3 the incident: a child that ends during the held run is judged at the boundary", async () => {
	// 2026-11-09: the hold was released at 12:06:57, the 2s tick injected the notice at
	// once, and the parent stopped that child at 12:07:11 — the text was already queued
	// and `ACCEPTED → OBSOLETE` only relabels. With the gate, the child's end happens
	// while the row is still PENDING, so the existing predicate sees it in time.
	const f = fixture(["worker"]);
	const postman = postmanFor(f);
	try {
		const messageId = queueStallNotice(f.db, "root", ["worker"], 1_000);
		f.setRunActive(true);
		await postman.tick();
		assert.equal(pendingInbox(f.db, "root").length, 1, "the notice sits PENDING while the run is live");
		assert.deepEqual(bounces(f.db), [], "the gate writes no verdict of its own: it judges nothing during the run");

		// The child the notice names returns while the parent is still inside its turn.
		updateNode(f.db, f.ids.get("worker")!, { status: "retired" }, () => 2);
		f.setRunActive(false);
		await postman.tick();

		assert.deepEqual(f.rootMessages, [], "an expired to-do must not reach the parent at all");
		assert.equal(pendingInbox(f.db, "root").length, 0);
		assert.equal(inbox(f.db, "root", { delivery: MAIL_DELIVERY.OBSOLETE }).length, 1);
		assert.equal(inbox(f.db, "root", { delivery: MAIL_DELIVERY.ACCEPTED }).length, 0, "it was never handed over");
		assert.deepEqual(
			bounces(f.db),
			[{ messageId, toNode: "root", reason: MAIL_BOUNCE_REASON.OBSOLETE_AFTER_CHILD_END }],
			"exactly one verdict, carrying the child-end reason",
		);
	} finally {
		postman.stop();
		f.dispose();
	}
});

test("§4.4 every kind is gated: a `report` waits for the boundary too", async () => {
	const f = fixture(["worker"]);
	const postman = postmanFor(f);
	try {
		const mailed = sendMail(f.db, {
			fromNode: f.ids.get("worker")!,
			to: "parent",
			subject: "Report: worker",
			kind: "report",
			body: "the report body",
		}, { now: () => 1_000 });
		assert.equal(mailed.ok, true);
		if (!mailed.ok) return;

		f.setRunActive(true);
		await postman.tick();
		assert.deepEqual(f.rootMessages, [], "D1: the scope is the whole root inbox, not a kind whitelist");
		assert.equal(pendingInbox(f.db, "root").length, 1);

		f.setRunActive(false);
		await postman.tick();
		assert.equal(f.rootMessages.length, 1, "a `report` is only late, never lost");
		assert.match(f.rootMessages[0]!, /the report body/);
		assert.equal(inbox(f.db, "root", { delivery: MAIL_DELIVERY.ACCEPTED }).length, 1);
	} finally {
		postman.stop();
		f.dispose();
	}
});

test("§4.5 the gate does not short the child channel in the same tick", async () => {
	// STRUCTURAL GUARD, not a detector of the gate's own predicate (§4.1–§4.3 own that):
	// `deliverChildren` runs BEFORE `deliverRootInbox` in the same tick, so this case pins
	// that a closed root gate does not reach the child channel — the same `return` moved
	// into `tick()` or into `deliverChildren` turns it red, while the gate's judgement is
	// invisible from here on purpose.
	const f = fixture(["worker"]);
	const postman = postmanFor(f);
	try {
		const childId = f.ids.get("worker")!;
		// `deliverChildren` needs a live route to the child, so the supervisor knows it.
		f.supervisor.children.set("worker", {
			name: "worker",
			sessionFile: "/tmp/root-mail-run-boundary-worker.jsonl",
			alive: true,
			waiters: [],
			responses: [],
			usage: null,
		});
		const toChild = sendMail(f.db, {
			fromNode: "root",
			to: "worker",
			subject: "Ping",
			kind: "report",
			body: "for the child",
		}, { now: () => 1_000 });
		assert.equal(toChild.ok, true);
		queueStallNotice(f.db, "root", ["worker"], 1_000);

		f.setRunActive(true);
		await postman.tick();

		const followUps = f.supervisor.calls.filter((call) => call.method === "followUp" && call.name === "worker");
		assert.equal(followUps.length, 1, "D1: `deliverChildren` is a different inbox and is not gated");
		assert.match(followUps[0]!.text ?? "", /for the child/);
		assert.equal(inbox(f.db, childId, { delivery: MAIL_DELIVERY.ACCEPTED }).length, 1);
		assert.deepEqual(f.rootMessages, [], "…while root's own inbox is still held");
		assert.equal(pendingInbox(f.db, "root").length, 1);
	} finally {
		postman.stop();
		f.dispose();
	}
});

// ────────────────────────────── §4.6 fail-open ──────────────────────────────

test("§4.6 fail-open: an absent seam delivers now, exactly as before the gate", async () => {
	const f = fixture(["worker"]);
	const postman = postmanFor(f, {}, false);
	try {
		queueStallNotice(f.db, "root", ["worker"], 1_000);
		// The registry says active, and it must not matter: the postman was built with no
		// seam at all ("no fact, no claim"), which is the shape every old caller has.
		f.setRunActive(true);
		await postman.tick();
		assert.equal(f.rootMessages.length, 1, "D3: an absent `isRunActive` means deliver immediately");
		assert.equal(inbox(f.db, "root", { delivery: MAIL_DELIVERY.ACCEPTED }).length, 1);
	} finally {
		postman.stop();
		f.dispose();
	}
});

test("§4.6 fail-open: a throwing seam delivers now, and says so once", async () => {
	const f = fixture(["worker"]);
	let reads = 0;
	const warnings = await captureWarnings(async () => {
		const postman = postmanFor(f, {
			isRunActive: () => {
				reads += 1;
				throw new Error("probe blew up");
			},
		});
		try {
			queueStallNotice(f.db, "root", ["worker"], 1_000);
			await postman.tick();
			assert.equal(f.rootMessages.length, 1, "D3: a throwing reader is `not active` — root's mail is never parked");
			await postman.tick();
			assert.equal(reads, 2, "the probe is still asked on every pass");
		} finally {
			postman.stop();
		}
	});
	try {
		assert.equal(warnings.length, 1, "one line for the degrade, not one per 2s tick");
		assert.match(warnings[0]!, /run-activity probe for node 'root' threw/);
	} finally {
		f.dispose();
	}
});

test("D3 registry: no registrant, a throwing reader and a non-`true` answer all read inactive", () => {
	const ids = ["node-throws", "node-truthy", "node-live"];
	try {
		assert.equal(isLegionRunActive("node-never-published"), false, "no registrant ⇒ not active");
		publishLegionRunActivity("node-throws", () => {
			throw new Error("boom");
		});
		assert.equal(isLegionRunActive("node-throws"), false, "a throwing reader ⇒ not active");
		publishLegionRunActivity("node-truthy", () => "yes" as unknown as boolean);
		assert.equal(isLegionRunActive("node-truthy"), false, "only a clean `true` is active");
		publishLegionRunActivity("node-live", () => true);
		assert.equal(isLegionRunActive("node-live"), true);
		// Idempotent: the second publish REPLACES the same key instead of stacking a reader.
		publishLegionRunActivity("node-live", () => false);
		assert.equal(isLegionRunActive("node-live"), false, "the latest reader is the one in force");
	} finally {
		for (const nodeId of ids) withdrawLegionRunActivity(nodeId);
	}
	assert.equal(isLegionRunActive("node-live"), false, "withdraw drops the reader");
});

// ───────────────────────────── §4.7 exit cleanup ─────────────────────────────

test("§4.7 the registry holds the READER: publish is idempotent and dispose withdraws", () => {
	const runtime = createSessionRuntime({ sendMessage() {} });
	// The member is OPTIONAL on the interface (D6), so a `?.` call would skip exactly the
	// thing under test if the implementation stopped providing it.
	assert.equal(typeof runtime.publishRunActivity, "function", "the runtime implements the D2 seam");
	try {
		// No boolean copy: the registry answers from the runtime's own `parentRunActive`,
		// so a flag flipped elsewhere is visible without republishing anything.
		assert.equal(isLegionRunActive("root"), false, "nothing published yet");
		runtime.publishRunActivity!("root");
		assert.equal(isLegionRunActive("root"), false, "a fresh runtime is settled");
		runtime.notifyParentRunStart();
		assert.equal(isLegionRunActive("root"), true, "the same reader now answers `true` — no copy, no republish");
		runtime.publishRunActivity!("root");
		assert.equal(isLegionRunActive("root"), true, "a second publish is a no-op on the same key");
		runtime.notifyParentSettled();
		assert.equal(isLegionRunActive("root"), false);
		// Discriminating teardown: leave the FLAG up on purpose. `dispose()` does not reset
		// `parentRunActive`, so a missing withdraw would make the assertion after the
		// `finally` read `true` — this is what gives the case any power over the teardown.
		runtime.notifyParentRunStart();
		assert.equal(isLegionRunActive("root"), true, "precondition for §4.7's second half: the flag is up while we dispose");
	} finally {
		runtime.dispose();
	}
	assert.equal(isLegionRunActive("root"), false, "dispose() withdrew the reader even though the flag is still `true`");
});

test("F2: a late publish cannot install a reader on a disposed runtime", () => {
	// Review F2, second half: an `onLegion` callback or a microtask can reach
	// `adoptLegionIdentity` AFTER the session went away. Publishing then would install a
	// reader frozen at whatever `parentRunActive` happened to be, and no teardown would
	// ever run for it — a fail-CLOSED gate nobody can close. `dispose()` freezes the flag
	// up here on purpose so a missing guard is visible.
	const runtime = createSessionRuntime({ sendMessage() {} });
	assert.equal(typeof runtime.publishRunActivity, "function", "the runtime implements the D2 seam");
	runtime.dispose();
	runtime.notifyParentRunStart();
	try {
		runtime.publishRunActivity!("root");
		assert.equal(isLegionRunActive("root"), false, "a disposed runtime publishes nothing (fail-open, D3)");
	} finally {
		withdrawLegionRunActivity("root");
	}
});

test("F2: a THROWING host teardown cannot strand the reader — withdraw runs first", () => {
	// Review F2, first half: `dispose()` runs host-facing callbacks (`unsubscribeRpcEvents`,
	// `join.dispose`, …); if one throws, a withdraw placed after it would never run and the
	// gate would stay shut forever. The withdraw is therefore the FIRST thing dispose does,
	// which this case proves by making the very next step throw.
	const runtime = createSessionRuntime({ sendMessage() {} });
	assert.equal(typeof runtime.publishRunActivity, "function", "the runtime implements the D2 seam");
	runtime.publishRunActivity!("root");
	runtime.notifyParentRunStart();
	assert.equal(isLegionRunActive("root"), true, "precondition: the reader is live and the flag is up");
	const job = runtime.track({
		name: "child",
		runId: "r-1",
		agent: "worker",
		sessionFile: "/tmp/root-mail-run-boundary-f2.jsonl",
		timeoutMs: 1_000,
		// Never collected: this case is about teardown, and a `join` entry that can never
		// settle also keeps the runtime from arming any timer of its own.
		collect: () => new Promise<never>(() => {}),
	});
	job.unsubscribeRpcEvents = () => {
		throw new Error("host callback blew up");
	};
	try {
		assert.throws(() => runtime.dispose(), /host callback blew up/, "the host callback really does throw out of dispose()");
		// The assertion has to come BEFORE the safety-net withdraw below, or the net would
		// pass the case for the fix (measured: with the withdraw moved back after the
		// teardown, this case stayed green until the order was fixed).
		assert.equal(isLegionRunActive("root"), false, "the reader was withdrawn before the teardown that threw");
	} finally {
		// Leak safety only: if the assertion above threw, the registry must not keep a
		// `true` reader for the rest of this file.
		withdrawLegionRunActivity("root");
	}
});

test("F3 ownership: a late teardown cannot withdraw a newer publisher's reader", () => {
	// Review F3: `withdrawLegionRunActivity` used to `delete` unconditionally, so a runtime
	// that teardown-ed late could unregister a newer publisher of the same node — a
	// fail-closed gate nobody could close. Publish returns an ownership-checked disposer.
	try {
		const releaseOld = publishLegionRunActivity("node-owned", () => false);
		const releaseNew = publishLegionRunActivity("node-owned", () => true);
		assert.equal(isLegionRunActive("node-owned"), true, "the newest reader is in force");
		releaseOld();
		assert.equal(
			isLegionRunActive("node-owned"),
			true,
			"the OLD registration's release leaves the new reader alone (ownership check)",
		);
		releaseNew();
		assert.equal(isLegionRunActive("node-owned"), false, "the owner's own release still withdraws");
	} finally {
		withdrawLegionRunActivity("node-owned");
	}
});
