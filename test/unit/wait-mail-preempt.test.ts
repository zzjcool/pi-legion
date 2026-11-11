/**
 * #384 — a BLOCKED `wait`/`collect` hands over this node's mail instead of holding
 * it until the turn ends.
 *
 * Frozen contract: `docs/contracts/wait-mail-preempt-v1.md`. The failure it fixes
 * is a queueing one: `legion_mail → root` rides the host's followUp, which is only
 * taken at a turn boundary, so mail written while the root sat in a long `wait`
 * waited with it (measured 17.3 minutes, contract §0).
 *
 * What this file pins, one test per contract clause and per review finding:
 *
 *   - §2/I2 — `wait` with a live child returns the mail within a second, the mail
 *     envelope is the postman's own (`formatMail`), `details.state === "mail"`, the
 *     ledger says ACCEPTED, and a postman tick afterwards injects NOTHING;
 *   - §2/I4 — the same for `collect`, plus the child is untouched: still tracked and
 *     still `working`;
 *   - I1 — with no mail, `wait`'s timeout result and `collect`'s collected result are
 *     byte-identical to the same call made without the seam at all;
 *   - I5 — a caller abort (Esc / parent turn end) still answers the frozen
 *     `interrupted …` line and takes nothing out of the ledger, whether the signal
 *     was already aborted at entry or ended the call before the poll saw the mail.
 *
 * Review rework (2026-xx, all on this branch) adds the regressions that review
 * found missing, each named after its finding:
 *
 *   - P0-1 — the postman claims the ledger row BEFORE it sends, so a child blocked
 *     in its own `wait` cannot take the same row and receive two copies;
 *   - P0-2 — `wait(all:true)` with a settled child keeps that child's result, states
 *     `Still running: <name>` once, and never claims the PARENT turn ended;
 *   - P0-3 — a mail result the tool layer's abort net throws away is re-delivered;
 *   - P1.1/P1.2/P1.3 — the postman-won fallback keeps the collected result, an
 *     unknown child is still an error even with mail waiting, and a message the
 *     ledger bounces is not handed out as taken;
 *   - P1 gap — the 250ms poll timer never outlives the call.
 *
 * LAYERS. Most cases below drive `waitAction`/`collectChild` against the LEDGER only:
 * no postman runs, so the mail is `PENDING` when the seam looks. That is the layer the
 * preemption mechanics live in, but it is NOT the production race — measured on the
 * issue's own ledger, root's postman flips the row to `ACCEPTED` ~200ms after the write,
 * which is why the feature originally shipped "green but inert". The production path
 * (a live `LegionPostman` ticking against the blocked call) is pinned by the two tests
 * whose names start with "a held inbox" / "the hold is released" — the others are
 * documented as ledger-layer on purpose.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { collectChild, interruptedControlResult, waitAction } from "../../index.ts";
import {
	createSessionRuntime,
	type CollectSnapshot,
	type SessionRuntime,
} from "../../src/extension/runtime.ts";
import { LegionPostman } from "../../src/extension/legion-tools.ts";
import { RunStore } from "../../src/runs/store.ts";
import { openLegionDb, type DatabaseSync } from "../../src/legion/db.ts";
import { appendEvent } from "../../src/legion/events.ts";
import {
	DEFAULT_MAIL_RATE_PER_5_MIN,
	MAIL_DELIVERY,
	claimForDelivery,
	getMessage,
	renewDeliveryClaim,
	inbox,
	pendingInbox,
	sendMail,
} from "../../src/legion/mail.ts";
import {
	MAIL_DELIVERY_CLAIM_LEASE_MS,
	beginMailHold,
	endMailHold,
	isMailHeld,
	redeliverMail,
	takePendingMail,
} from "../../src/legion/mail-release.ts";
import { getNode, hasEnded, insertNode, updateNode, type LegionNode } from "../../src/legion/nodes.ts";
import { formatStallNotice } from "../../src/legion/stall-notice.ts";
import type { OrchestratorLegionContext } from "../../src/runs/orchestrator.ts";
import type { AgentConfig } from "../../src/shared/types.ts";
import { FakeSupervisor } from "../helpers/fake-supervisor.ts";

/** Wall-clock bound for every fixture wait: nothing here may hang the suite. */
const BOUND_MS = 5_000;
/** The children this file controls; the run they belong to is irrelevant to the seam. */
const CHILD = "live";
const SETTLING = "fast";
const RUN = "r-1";

const INTERRUPTED_REPLY = "interrupted (parent turn ended; children still running)";
const COLLECT_MAIL_REPLY =
	"The collect was interrupted by this mail; call collect again after handling it.";

type Result = { content?: unknown; details?: unknown };

function textOf(result: Result): string {
	const parts = (result.content ?? []) as Array<{ text?: string }>;
	return parts.map((part) => part.text ?? "").join("\n");
}

/** `Promise.race` with a sentinel: every fixture wait is bounded, never unbounded. */
function within<T>(work: Promise<T>, label: string, boundMs = BOUND_MS): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const bound = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(
			() => reject(new Error(`bounded fixture wait expired (${boundMs}ms): ${label}`)),
			boundMs,
		);
		timer.unref?.();
	});
	return Promise.race([work, bound]).finally(() => {
		if (timer) clearTimeout(timer);
	});
}

/** Bounded pump over a real observable — never a sleep used as synchronisation. */
async function until(pred: () => boolean, label: string, boundMs = BOUND_MS): Promise<void> {
	const deadline = Date.now() + boundMs;
	while (!pred()) {
		if (Date.now() > deadline) {
			throw new Error(`bounded fixture pump expired (${boundMs}ms): ${label}`);
		}
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
}

/** A full role card: `FakeSupervisor.spawnChild` refuses anything without `kind: "pi"`. */
function agent(name: string): AgentConfig {
	return {
		name,
		description: `${name} role`,
		systemPromptMode: "append",
		inheritProjectContext: true,
		inheritSkills: false,
		kind: "pi",
		systemPrompt: `You are ${name}.`,
		source: "user",
		filePath: `/fake/${name}.md`,
	} as AgentConfig;
}

function terminalSnapshot(output: string): CollectSnapshot {
	return {
		execution: { status: "success" },
		output,
		acceptance: { status: "accepted", level: "attested" },
	};
}

/** A tracked child whose collect never resolves — the wait/collect is blocked. */
function blockedRuntime(name = CHILD): SessionRuntime {
	const runtime = createSessionRuntime({ sendMessage() {} });
	runtime.track({
		name,
		runId: RUN,
		agent: "worker",
		sessionFile: `/tmp/${name}.jsonl`,
		timeoutMs: 60_000,
		collect: () => new Promise<CollectSnapshot>(() => {}),
	});
	return runtime;
}

/** A tracked child that has already produced its terminal result. */
function settledRuntime(output: string): SessionRuntime {
	const runtime = createSessionRuntime({ sendMessage() {} });
	runtime.track({
		name: CHILD,
		runId: RUN,
		agent: "worker",
		sessionFile: `/${CHILD}.jsonl`,
		timeoutMs: 60_000,
		collect: async () => terminalSnapshot(output),
	});
	return runtime;
}

function tempStore(): { store: RunStore; cwd: string; dispose: () => void } {
	const cwd = mkdtempSync(path.join(tmpdir(), "mail-preempt-"));
	return {
		store: new RunStore({ rootDir: path.join(cwd, ".pi-subagents") }),
		cwd,
		dispose: () => rmSync(cwd, { recursive: true, force: true }),
	};
}

/**
 * `root` with one child, so `root.team → parent` is a legal route and the ledger's
 * delivery transitions see a live (non-terminal) recipient.
 */
function mailLedger(): DatabaseSync {
	const db = openLegionDb(":memory:");
	insertNode(db, { parentId: null, name: "root", role: "root", status: "running" });
	insertNode(db, { parentId: "root", name: "team", role: "centurion", status: "running" });
	return db;
}

function mailFromChild(db: DatabaseSync, subject: string, body: string, to = "parent"): number {
	return fixtureMail(db, { from: "root.team", to, subject, body });
}

/**
 * The row `writeStallNotice` writes: SELF-addressed (`from_node = to_node = nodeId`),
 * `notice`, `action-needed`, `PENDING`, body in the frozen `- <child>: ` grammar.
 *
 * `sendMail` cannot produce it (it drops the sender from its own recipient list), and
 * the writer itself is private — so the shape is reproduced here, with the body built
 * by the real `formatStallNotice` so the D1 stamp and the D2 line grammar are the ones
 * production emits.
 */
function queueStallNotice(db: DatabaseSync, nodeId: string, names: readonly string[], detectedAt: number): number {
	const { subject, body } = formatStallNotice(
		names.map((childName) => ({
			kind: "long-running" as const,
			childName,
			sinceBucket: detectedAt,
			sequence: 1,
			elapsedMs: 600_000,
			thresholdMs: 600_000,
		})),
		detectedAt,
	);
	const inserted = db
		.prepare(
			`INSERT INTO messages (
				from_node, to_node, subject, body, kind, urgency, delivered, created_at
			) VALUES (?, ?, ?, ?, 'notice', 'action-needed', ?, ?)`,
		)
		.run(nodeId, nodeId, subject, body, MAIL_DELIVERY.PENDING, detectedAt);
	return Number(inserted.lastInsertRowid);
}

/** A send whose refusal is the answer the test wants, not a fixture failure. */
function mailFromChildOk(db: DatabaseSync, subject: string): boolean {
	return sendMail(db, { fromNode: "root.team", to: "parent", subject, body: "rate probe" }, { now: () => Date.now() }).ok;
}

/**
 * Every `mail_bounced` verdict this fixture wrote, oldest first, `data` parsed.
 *
 * The obsolete verdict's ONLY trace is this event (`mailbox-delivery-v1`: no new event
 * type, no new column), and the two notice classes are told apart by `data.reason`
 * alone (`stall-notice-staleness` D4) — so the assertions below read the event, not
 * the row. Read straight from `events` because nothing else in this file needs the
 * `readEventsAfter` projection.
 */
function bouncedEvents(db: DatabaseSync): Array<{ messageId?: number; toNode?: string; reason?: string }> {
	const rows = db.prepare("SELECT data FROM events WHERE type = 'mail_bounced' ORDER BY id").all() as Array<{
		data: string;
	}>;
	return rows.map((row) => JSON.parse(row.data) as { messageId?: number; toNode?: string; reason?: string });
}

function fixtureMail(
	db: DatabaseSync,
	input: { from: string; to: string; subject: string; body: string; kind?: string },
): number {
	const sent = sendMail(
		db,
		{
			fromNode: input.from,
			to: input.to,
			subject: input.subject,
			body: input.body,
			...(input.kind ? { kind: input.kind as never } : {}),
		},
		{ now: () => Date.now() },
	);
	if (!sent.ok) throw new Error(`fixture mail was refused: ${sent.message}`);
	return sent.messages[0]!.id;
}

/**
 * Run one postman tick on `root` and report what it would have injected.
 *
 * This is the I2 probe: the preemption's `PENDING → ACCEPTED` is the ONLY
 * anti-duplicate mechanism on the root side, so the tick after a release has to
 * come up empty.
 */
async function postmanTick(db: DatabaseSync): Promise<string[]> {
	const injected: string[] = [];
	const postman = new LegionPostman({
		db,
		nodeId: "root",
		supervisor: new FakeSupervisor(),
		now: () => Date.now(),
		sendRootMessage: (message) => injected.push(message),
		intervalMs: 10_000,
	});
	try {
		await postman.tick();
	} finally {
		postman.stop();
	}
	return injected;
}

/** The minimum a `collect` needs to reach the runtime seam (nothing below uses it). */
function collectFixture(runtime: SessionRuntime, store: RunStore, cwd: string) {
	return {
		action: "collect",
		params: { action: "collect", name: CHILD },
		name: CHILD,
		supervisor: new FakeSupervisor(),
		onBudgetRefused: () => ({ ok: false, message: "no budget" }),
		store,
		cwd,
		agents: [agent("worker")],
		allAgents: [agent("worker")],
		found: { runId: RUN, run: { runId: RUN }, child: { name: CHILD, agent: "worker" } },
		// Never reached by a preempted collect, and empty here so `persistChild` is a
		// no-op on the collected path.
		orchestrator: {
			childrenSnapshot: () => [] as unknown[],
			cachedCollect: () => undefined,
			retire: async () => ({}),
			collect: async () => {
				throw new Error("orchestrator fallback must not run in this fixture");
			},
		},
		runtime,
	} as unknown as Parameters<typeof collectChild>[0];
}

test("wait hands over mail written while it is blocked (§2, I2)", async () => {
	const db = mailLedger();
	const { store, cwd, dispose } = tempStore();
	const runtime = blockedRuntime();
	let mailId = 0;
	let sentAt = 0;
	let returnedAt = 0;
	// 100ms into the wait — contract §6.1's own scenario.
	const send = setTimeout(() => {
		mailId = mailFromChild(db, "contract frozen", "the frozen body of the mail");
		sentAt = Date.now();
	}, 100);
	try {
		const result = await within(
			waitAction({
				params: { action: "wait", name: CHILD, timeoutMs: 60_000 },
				runtime,
				agents: [agent("worker")],
				store,
				cwd,
				mail: { db, nodeId: "root" },
			}).then((value) => {
				returnedAt = Date.now();
				return value;
			}),
			"wait preempted by mail",
			1_000,
		);

		const body = textOf(result);
		assert.notEqual(mailId, 0, "the fixture mail must have been written");
		assert.match(body, /\[legion mail #\d+\]/, "the mail envelope is the postman's own");
		assert.match(body, /Subject: contract frozen/);
		assert.match(body, /the frozen body of the mail/);
		// Review P0-2: the still-running fact is stated plainly and ONCE — no
		// `interrupted (parent turn ended …)`, because the parent turn is alive.
		assert.match(body, /Still running: live/);
		assert.doesNotMatch(body, /parent turn ended/);
		const details = result.details as {
			state?: string;
			mailIds?: number[];
			targets?: string[];
		};
		assert.equal(details.state, "mail");
		assert.deepEqual(details.mailIds, [mailId]);
		assert.deepEqual(details.targets, [CHILD]);
		// P4c: no claim record rides along any more — the seam takes nothing to hand
		// back, so a discarded result cannot leave a suppressed notice behind.
		assert.equal("waitClaims" in details, false);
		// I2: taken exactly once, by the one write the contract allows.
		assert.equal(inbox(db, "root", { delivery: MAIL_DELIVERY.ACCEPTED }).length, 1);
		assert.equal(pendingInbox(db, "root").length, 0);
		assert.deepEqual(await postmanTick(db), [], "an ACCEPTED message is never injected twice");
		// I4: the child was not touched.
		assert.equal(runtime.get(CHILD)?.state, "working");
		// Contract I6: preemption lands inside one poll of the write, well under 500ms.
		assert.ok(returnedAt - sentAt < 500, `preempted in ${returnedAt - sentAt}ms`);
	} finally {
		clearTimeout(send);
		runtime.dispose();
		dispose();
		db.close();
	}
});

test("collect hands over mail instead of waiting for the child (§2, I4)", async () => {
	const db = mailLedger();
	const { store, cwd, dispose } = tempStore();
	const runtime = blockedRuntime();
	let mailId = 0;
	const send = setTimeout(() => {
		mailId = mailFromChild(db, "frozen contract", "the collect body of the mail");
	}, 100);
	try {
		const result = await within(
			collectChild(collectFixture(runtime, store, cwd), undefined, {
				db,
				nodeId: "root",
			}),
			"collect preempted by mail",
			1_000,
		);

		const body = textOf(result);
		assert.notEqual(mailId, 0, "the fixture mail must have been written");
		assert.match(body, /Subject: frozen contract/);
		assert.match(body, /the collect body of the mail/);
		assert.ok(body.endsWith(COLLECT_MAIL_REPLY), `collect must end with the frozen line: ${body}`);
		const details = result.details as {
			state?: string;
			mailIds?: number[];
			targets?: string[];
		};
		assert.equal(details.state, "mail");
		assert.deepEqual(details.mailIds, [mailId]);
		assert.deepEqual(details.targets, [CHILD]);
		assert.equal(inbox(db, "root", { delivery: MAIL_DELIVERY.ACCEPTED }).length, 1);
		assert.equal(pendingInbox(db, "root").length, 0);
		assert.deepEqual(await postmanTick(db), [], "an ACCEPTED message is never injected twice");
		// I4: only the CALL returns — the child is still there, and its notice route is
		// open. P4c deleted the `consumedByTool` flag this used to inspect: a preempted
		// collect declares no `ledgerReads`, so nothing was marked read and the notice is
		// still owed (D3b). "Still tracked and working" is the observable fact.
		assert.equal(runtime.get(CHILD)?.state, "working");
	} finally {
		clearTimeout(send);
		runtime.dispose();
		dispose();
		db.close();
	}
});

test("wait with no mail keeps today's timeout result, byte for byte (I1)", async () => {
	const db = mailLedger();
	// `elapsedMs` is wall clock: it is the ONE field two runs cannot share.
	const normalizeText = (value: string): string => value.replace(/\d+ms/g, "<ms>");
	const canonicalDetails = (details: unknown): unknown => {
		const clone = JSON.parse(JSON.stringify(details ?? null)) as {
			stillRunning?: Array<{ elapsedMs?: number }>;
		} | null;
		for (const child of clone?.stillRunning ?? []) child.elapsedMs = 0;
		return clone;
	};
	const runOnce = async (withSeam: boolean): Promise<Result> => {
		const { store, cwd, dispose } = tempStore();
		const runtime = blockedRuntime();
		try {
			return await waitAction({
				params: { action: "wait", name: CHILD, timeoutMs: 60 },
				runtime,
				agents: [agent("worker")],
				store,
				cwd,
				...(withSeam ? { mail: { db, nodeId: "root" } } : {}),
			});
		} finally {
			runtime.dispose();
			dispose();
		}
	};
	try {
		const plain = await runOnce(false);
		const seam = await runOnce(true);
		assert.match(textOf(seam), /status: wait_timeout/);
		assert.equal(normalizeText(textOf(seam)), normalizeText(textOf(plain)), "text unchanged");
		assert.deepEqual(
			canonicalDetails(seam.details),
			canonicalDetails(plain.details),
			"details unchanged",
		);
		assert.equal((seam.details as { state?: string }).state, undefined);
	} finally {
		db.close();
	}
});

test("collect with no mail returns the collected result, byte for byte (I1)", async () => {
	const db = mailLedger();
	const runOnce = async (withSeam: boolean): Promise<Result> => {
		const { store, cwd, dispose } = tempStore();
		const runtime = settledRuntime("the child's own output");
		try {
			return await within(
				collectChild(
					collectFixture(runtime, store, cwd),
					undefined,
					...(withSeam ? [{ db, nodeId: "root" }] : []),
				),
				"collect returns",
			);
		} finally {
			runtime.dispose();
			dispose();
		}
	};
	try {
		const plain = await runOnce(false);
		const seam = await runOnce(true);
		assert.match(textOf(seam), /the child's own output/);
		assert.equal(textOf(seam), textOf(plain), "text unchanged");
		assert.deepEqual(seam.details, plain.details, "details unchanged");
	} finally {
		db.close();
	}
});

test("a caller abort at entry still answers `interrupted …` and takes no mail (I5)", async () => {
	const db = mailLedger();
	const { store, cwd, dispose } = tempStore();
	const runtime = blockedRuntime();
	try {
		// The caller is already gone when the tool is entered, and mail is waiting: the
		// abort wins on precedence (contract §4) and the ledger keeps its mail.
		const id = mailFromChild(db, "queued before the abort", "still pending afterwards");
		const aborted = new AbortController();
		aborted.abort();
		const result = await within(
			waitAction({
				params: { action: "wait", name: CHILD, timeoutMs: 60_000 },
				signal: aborted.signal,
				runtime,
				agents: [agent("worker")],
				store,
				cwd,
				mail: { db, nodeId: "root" },
			}),
			"already-aborted wait",
		);
		assert.match(textOf(result), /interrupted \(parent turn ended; children still running\)/);
		assert.equal((result.details as { state?: string }).state, undefined);
		assert.equal(pendingInbox(db, "root").length, 1, "the caller's abort takes nothing");
		assert.equal(inbox(db, "root", { delivery: MAIL_DELIVERY.ACCEPTED }).length, 0);
		assert.equal(pendingInbox(db, "root")[0]?.id, id);
	} finally {
		runtime.dispose();
		dispose();
		db.close();
	}
});

test("mail written before the abort still loses to the abort that ends the call (I5)", async () => {
	const db = mailLedger();
	const { store, cwd, dispose } = tempStore();
	const runtime = blockedRuntime();
	// Review gap 4: the mail exists BEFORE the abort — the old fixture wrote it 350ms
	// after the wait had already answered, so it pinned nothing. Now both are live
	// when the call ends, and the winner is whoever ENDS the call: the abort (60ms)
	// beats the first poll tick (250ms), so the frozen line stands and the mail stays
	// queued for the postman instead of being consumed by a call that returned
	// `interrupted …`.
	const mailed = new Promise<number>((resolve) => {
		setTimeout(() => resolve(mailFromChild(db, "too late", "written before the abort")), 50);
	});
	const controller = new AbortController();
	const abortAt = setTimeout(() => controller.abort(), 60);
	try {
		const result = await within(
			waitAction({
				params: { action: "wait", name: CHILD, timeoutMs: 60_000 },
				signal: controller.signal,
				runtime,
				agents: [agent("worker")],
				store,
				cwd,
				mail: { db, nodeId: "root" },
			}),
			"mid-wait abort",
		);
		const mailId = await mailed;
		assert.match(textOf(result), /interrupted \(parent turn ended; children still running\)/);
		assert.equal((result.details as { state?: string }).state, undefined);
		// Written first, but never consumed: the postman still owns it.
		assert.deepEqual(
			pendingInbox(db, "root").map((message) => message.id),
			[mailId],
		);
		assert.equal(inbox(db, "root", { delivery: MAIL_DELIVERY.ACCEPTED }).length, 0);
	} finally {
		clearTimeout(abortAt);
		await mailed.catch(() => 0);
		runtime.dispose();
		dispose();
		db.close();
	}
});

test("wait(all:true) keeps the settled result and never blames the parent turn (P0-2)", async () => {
	const db = mailLedger();
	const { store, cwd, dispose } = tempStore();
	const runtime = createSessionRuntime({ sendMessage() {} });
	// `fast` settles 120ms in (so the wait HAS a result to carry), `slow` never does.
	runtime.track({
		name: SETTLING,
		runId: RUN,
		agent: "worker",
		sessionFile: `/${SETTLING}.jsonl`,
		timeoutMs: 60_000,
		collect: () =>
			new Promise<CollectSnapshot>((resolve) => {
				setTimeout(() => resolve(terminalSnapshot("fast-own-output")), 120);
			}),
	});
	runtime.track({
		name: CHILD,
		runId: RUN,
		agent: "worker",
		sessionFile: `/${CHILD}.jsonl`,
		timeoutMs: 60_000,
		collect: () => new Promise<CollectSnapshot>(() => {}),
	});
	const send = setTimeout(() => {
		mailFromChild(db, "all-true preempt", "the body for the all:true wait");
	}, 200);
	try {
		const result = await within(
			waitAction({
				params: { action: "wait", all: true, timeoutMs: 60_000 },
				runtime,
				agents: [agent("worker")],
				store,
				cwd,
				mail: { db, nodeId: "root" },
			}),
			"all:true preempted by mail",
			2_000,
		);
		const body = textOf(result);
		assert.match(body, /Subject: all-true preempt/);
		assert.match(body, /the body for the all:true wait/);
		// The result this wait DID collect rides along, verbatim.
		assert.match(body, /fast-own-output/);
		assert.match(body, /Still running: live/);
		// The review finding: no invented conclusion about the parent's turn.
		assert.doesNotMatch(body, /parent turn ended/);
		assert.doesNotMatch(body, /interrupted/);
		const details = result.details as { state?: string; targets?: string[] };
		assert.equal(details.state, "mail");
		assert.deepEqual([...(details.targets ?? [])].sort(), [CHILD, SETTLING].sort());
	} finally {
		clearTimeout(send);
		runtime.dispose();
		dispose();
		db.close();
	}
});

/**
 * The postman, with the one seam review P0-1 needs: a `followUp` that parks until
 * the test releases it. `deliverToChild` awaits that call, so parking inside it is
 * exactly the window a blocked child's own `wait` could take the same row in.
 */
/** Throws on the FIRST followUp, then behaves: the transport blip P0-1 has to survive. */
class FlakyFollowUpSupervisor extends FakeSupervisor {
	readonly handed: string[] = [];
	private failNext = true;

	override async followUp(name: string, text: string): Promise<void> {
		if (this.failNext) {
			this.failNext = false;
			throw new Error("rpc blip");
		}
		this.handed.push(text);
		return super.followUp(name, text);
	}
}

class GatedFollowUpSupervisor extends FakeSupervisor {
	readonly handed: string[] = [];
	private release?: () => void;
	private announce?: () => void;
	/** Resolves once the postman is parked INSIDE the send call. */
	readonly parked: Promise<void> = new Promise<void>((resolve) => {
		this.announce = resolve;
	});

	override async followUp(name: string, text: string): Promise<void> {
		this.handed.push(text);
		this.announce?.();
		await new Promise<void>((resolve) => {
			this.release = resolve;
		});
		return super.followUp(name, text);
	}

	free(): void {
		const release = this.release;
		this.release = undefined;
		release?.();
	}
}

test("the postman and a blocked child can never both deliver the same mail (P0-1)", async () => {
	const rootDir = mkdtempSync(path.join(tmpdir(), "mail-preempt-postman-"));
	const db = openLegionDb(":memory:");
	const supervisor = new GatedFollowUpSupervisor();
	const sessionFile = path.join(rootDir, "team.jsonl");
	mkdirSync(rootDir, { recursive: true });
	try {
		insertNode(db, { parentId: null, name: "root", role: "root", status: "running" }, () => 1);
		const child: LegionNode = insertNode(
			db,
			{ parentId: "root", name: "team", role: "centurion", status: "running", sessionFile },
			() => 2,
		);
		await supervisor.spawnChild({
			name: child.name,
			task: "blocked in its own wait",
			agent: agent("centurion"),
			sessionFile,
			tempDir: rootDir,
			cwd: rootDir,
		});
		const messageId = fixtureMail(db, {
			from: "root",
			to: "team",
			subject: "one copy only",
			body: "the body that must not double",
		});
		const postman = new LegionPostman({
			db,
			nodeId: "root",
			supervisor,
			now: () => Date.now(),
			intervalMs: 10_000,
		});
		const tick = postman.tick();
		try {
			await within(supervisor.parked, "the postman is parked inside its send call");
			assert.equal(
				getNode(db, child.id)?.status,
				"running",
				"fixture: the child is live during the delivery",
			);
			// Review ruling (lease, not a new edge): the send is in flight, so the row is
			// leased — still `PENDING`, with `delivered_at` carrying "claimed at". Nothing
			// terminal is written for a claim, and #322's edges are untouched.
			const claimed = getMessage(db, messageId);
			assert.equal(claimed?.delivered, MAIL_DELIVERY.PENDING, "a claim is not a delivery state");
			assert.equal(claimed?.deliveredAt !== null, true, "delivered_at is the lease while PENDING");
			assert.deepEqual(
				takePendingMail(db, child.id),
				[],
				"the child's own blocked wait cannot take a leased row",
			);
		} finally {
			supervisor.free();
			await within(tick, "the postman tick finished");
		}
		// Exactly one copy reached the child, and the ledger backs that up: the lease
		// handed the story to the transition, which is what wrote ACCEPTED.
		assert.equal(supervisor.handed.length, 1, "one send call, one copy");
		assert.match(supervisor.handed[0]!, /Subject: one copy only/);
		assert.equal(inbox(db, child.id, { delivery: MAIL_DELIVERY.ACCEPTED }).length, 1);
		// …and a second tick has nothing to send: the row left PENDING.
		await within(postman.tick(), "the follow-up tick finished");
		postman.stop();
		assert.equal(supervisor.handed.length, 1, "the next tick does not repeat the send");
		assert.ok(messageId > 0);
	} finally {
		rmSync(rootDir, { recursive: true, force: true });
		db.close();
	}
});

test("a discarded mail result is re-delivered instead of lost (P0-3)", async () => {
	const db = mailLedger();
	const { store, cwd, dispose } = tempStore();
	const runtime = blockedRuntime();
	const send = setTimeout(() => {
		mailFromChild(db, "abort-net victim", "the body the model never read");
	}, 100);
	try {
		const preempted = await within(
			waitAction({
				params: { action: "wait", name: CHILD, timeoutMs: 60_000 },
				runtime,
				agents: [agent("worker")],
				store,
				cwd,
				mail: { db, nodeId: "root" },
			}),
			"wait preempted by mail",
			1_000,
		);
		assert.equal((preempted.details as { state?: string }).state, "mail");
		// The tool layer's abort net: the caller aborted after the call returned, so the
		// rendered result (and the mail text in it) is replaced by the frozen line.
		const replaced = await interruptedControlResult({
			result: preempted,
			legion: { db, nodeId: "root" } as unknown as OrchestratorLegionContext,
		});
		assert.equal(
			textOf(replaced),
			INTERRUPTED_REPLY,
			"the frozen line still replaces the rendered result",
		);
		// …and the mail that result had taken is back in the queue, as a fresh copy.
		const requeued = pendingInbox(db, "root");
		assert.equal(requeued.length, 1, "the discarded mail is PENDING again");
		assert.match(requeued[0]!.subject, /^Redelivered: abort-net victim$/);
		assert.match(requeued[0]!.body, /the body the model never read/, "body carried over verbatim");
		assert.equal(requeued[0]!.fromNode, "root.team");
		assert.equal(requeued[0]!.toNode, "root");
		// …and the postman delivers it on the next tick, exactly once.
		const injected = await postmanTick(db);
		assert.equal(injected.length, 1, "the redelivered mail reaches the parent");
		assert.match(injected[0]!, /Subject: Redelivered: abort-net victim/);
		assert.deepEqual(await postmanTick(db), [], "and only once");
	} finally {
		clearTimeout(send);
		runtime.dispose();
		dispose();
		db.close();
	}
});

/**
 * A seam whose ledger reports mail to the POLL but has none to take.
 *
 * That is the P1.1 interleaving in one object: the poll saw a `PENDING` row, the
 * postman claimed it before `takePendingMail` ran, so the take comes back empty.
 * Faking it at the `prepare` boundary keeps the real ledger, real transitions and
 * real `collectChild`; only the "page of pending rows" query lies.
 *
 * The page is ONE query for both readers (stall-notice-staleness D3: the poll counts
 * what a take would hand over, so it reads the same page `takePendingMail` does), and
 * in this test it is read exactly three times in a fixed order:
 *
 *   [0] `collectChild`'s ENTRY take — finds nothing, so the call proceeds to block;
 *   [1] the 250ms poll's releasable count — MUST see the row, or the abort that this
 *       test is built around never happens and the fixture waits out its 2s bound;
 *   [2…] the take AFTER that abort — finds nothing, which is the race itself (the
 *       postman won) and what makes the collect fall back to the snapshot it got.
 *
 * So "the ledger loses the mail" is applied from the take onwards, not to the poll: a
 * plain "always empty" sabotage now tests nothing, because the poll would correctly
 * count zero and never fire.
 */
function ledgerThatLosesTheMail(real: DatabaseSync): DatabaseSync {
	let pagesRead = 0;
	return new Proxy(real, {
		get(target, property, receiver) {
			if (property === "prepare") {
				return (sql: string) => {
					if (/SELECT \* FROM messages WHERE to_node = \? AND delivered = \? AND id > \?/.test(sql)) {
						const read = pagesRead++;
						if (read === 1) return target.prepare(sql);
						return { all: () => [], get: () => undefined, run: () => ({ changes: 0 }) };
					}
					return target.prepare(sql);
				};
			}
			const value = Reflect.get(target, property, receiver);
			return typeof value === "function" ? value.bind(target) : value;
		},
	}) as DatabaseSync;
}

test("collect answers with the result it got when the postman wins the ledger (P1.1)", async () => {
	const db = mailLedger();
	const { store, cwd, dispose } = tempStore();
	// An untracked child: `collectChild` falls through to the orchestrator seam, whose
	// answer is the one `waitSettled` gave up on when OUR abort cut it (exactly what
	// orchestrator.collect reports for any aborted signal).
	const runtime = createSessionRuntime({ sendMessage() {} });
	const fixture = collectFixture(runtime, store, cwd);
	(fixture as unknown as { orchestrator: unknown }).orchestrator = {
		childrenSnapshot: () => [] as unknown[],
		cachedCollect: () => undefined,
		retire: async () => ({}),
		collect: (_name: string, opts?: { signal?: AbortSignal }) =>
			new Promise((resolve) => {
				opts?.signal?.addEventListener(
					"abort",
					() =>
						resolve({
							execution: { status: "running", reason: "aborted by parent" },
							output: "partial output collected so far",
							acceptance: { status: "unknown", level: "none" },
						}),
					{ once: true },
				);
			}),
	};
	const seam = { db: ledgerThatLosesTheMail(db), nodeId: "root" };
	// The real row the poll sees; the proxy makes the take find nothing.
	fixtureMail(db, { from: "root.team", to: "root", subject: "claimed elsewhere", body: "gone" });
	try {
		const result = await within(
			collectChild(
				fixture as unknown as Parameters<typeof collectChild>[0],
				undefined,
				seam,
			),
			"collect answered with the snapshot it got",
			2_000,
		);
		const body = textOf(result);
		assert.match(body, /partial output collected so far/, "the snapshot the collect got is delivered");
		assert.doesNotMatch(body, /parent turn ended/, "no invented verdict about the parent turn");
		assert.equal((result.details as { state?: string }).state, undefined);
	} finally {
		runtime.dispose();
		dispose();
		db.close();
	}
});

test("an unknown child is still an error when mail is waiting (P1.2)", async () => {
	const db = mailLedger();
	const { store, cwd, dispose } = tempStore();
	const runtime = blockedRuntime();
	mailFromChild(db, "unrelated mail", "the body that must not answer a bad call");
	try {
		const result = await within(
			waitAction({
				params: { action: "wait", name: "ghost", timeoutMs: 1_000 },
				runtime,
				agents: [agent("worker")],
				store,
				cwd,
				mail: { db, nodeId: "root" },
			}),
			"the unknown child answer",
		);
		assert.equal((result.details as { error?: string }).error, "NOT_FOUND");
		assert.match(textOf(result), /unknown child: ghost/);
		assert.doesNotMatch(textOf(result), /unrelated mail/);
		assert.equal(pendingInbox(db, "root").length, 1, "the error path takes no mail");
	} finally {
		runtime.dispose();
		dispose();
		db.close();
	}
});

test("takePendingMail never returns a message the ledger bounced (P1.3)", () => {
	const db = mailLedger();
	try {
		const id = fixtureMail(db, {
			from: "root",
			to: "team",
			subject: "for a dead recipient",
			body: "nobody will read this",
		});
		// The recipient goes terminal between the page read and the transition, so
		// `ACCEPTED` becomes `BOUNCED` inside the ledger (`isTerminalNode`: a failed
		// status, or a terminal phase).
		updateNode(db, "root.team", { status: "failed" }, () => Date.now());
		const taken = takePendingMail(db, "root.team");
		assert.deepEqual(taken, [], "a bounce is not a delivery");
		assert.equal(inbox(db, "root.team", { delivery: MAIL_DELIVERY.BOUNCED }).length, 1);
		assert.equal(inbox(db, "root.team", { delivery: MAIL_DELIVERY.ACCEPTED }).length, 0);
		assert.ok(id > 0);
	} finally {
		db.close();
	}
});

test("a held inbox survives the postman and reaches the blocked wait (production path)", async () => {
	const db = mailLedger();
	const { store, cwd, dispose } = tempStore();
	const runtime = blockedRuntime();
	const injected: string[] = [];
	// A REAL postman on the node the test calls from — the interleaving that made this
	// feature inert in production: it delivers ~200ms after the write, long before a
	// 250ms poll could ever see the row.
	const postman = new LegionPostman({
		db,
		nodeId: "root",
		supervisor: new FakeSupervisor(),
		now: () => Date.now(),
		sendRootMessage: (message) => injected.push(message),
		intervalMs: 10_000,
	});
	let mailId = 0;
	try {
		const startedAt = Date.now();
		let returnedAt = 0;
		const waiting = waitAction({
			params: { action: "wait", name: CHILD, timeoutMs: 60_000 },
			runtime,
			agents: [agent("worker")],
			store,
			cwd,
			mail: { db, nodeId: "root" },
		}).then((value) => {
			returnedAt = Date.now();
			return value;
		});
		// Let the call reach `runtime.wait` (it takes the hold synchronously on the way).
		await new Promise<void>((resolve) => setTimeout(resolve, 60));
		assert.equal(isMailHeld("root"), true, "fixture: the blocked wait holds the inbox");
		// 1. mail lands while the wait is blocked…
		mailId = mailFromChild(db, "the postman cannot race me", "the body that must reach the tool");
		// 2. …and the postman ticks: it must leave the row PENDING (hold).
		await postman.tick();
		assert.deepEqual(injected, [], "the held postman delivers nothing");
		assert.equal(
			inbox(db, "root", { delivery: MAIL_DELIVERY.ACCEPTED }).length,
			0,
			"the mail is still PENDING for the blocked call to take",
		);
		await postman.tick();
		assert.deepEqual(injected, [], "a second held tick delivers nothing either");
		// 3. the waiting call preempts on its next poll (250ms cadence).
		const result = await within(waiting, "the blocked wait preempted while the postman ticked", 1_000);
		const elapsed = returnedAt - startedAt;
		const body = textOf(result);
		assert.notEqual(mailId, 0);
		assert.equal((result.details as { state?: string }).state, "mail");
		assert.match(body, /Subject: the postman cannot race me/);
		assert.match(body, /Still running: live/);
		assert.ok(elapsed < 500, `preempted in ${elapsed}ms despite the live postman`);
		// 4. delivered exactly once, and the postman is back on duty with nothing to send.
		assert.equal(inbox(db, "root", { delivery: MAIL_DELIVERY.ACCEPTED }).length, 1);
		await postman.tick();
		assert.deepEqual(injected, [], "an ACCEPTED message is never injected twice");
	} finally {
		postman.stop();
		runtime.dispose();
		dispose();
		db.close();
	}
});

test("collect holds the inbox too: a live postman cannot deliver past it (M4-1)", async () => {
	const db = mailLedger();
	const { store, cwd, dispose } = tempStore();
	const runtime = blockedRuntime();
	const injected: string[] = [];
	const postman = new LegionPostman({
		db,
		nodeId: "root",
		supervisor: new FakeSupervisor(),
		now: () => Date.now(),
		sendRootMessage: (message) => injected.push(message),
		intervalMs: 10_000,
	});
	try {
		const startedAt = Date.now();
		let returnedAt = 0;
		// The child's collect never settles, so this `collect` blocks exactly like a real
		// long one. The hold is taken synchronously, before the first await.
		const collecting = collectChild(collectFixture(runtime, store, cwd), undefined, {
			db,
			nodeId: "root",
		}).then((value) => {
			returnedAt = Date.now();
			return value;
		});
		assert.equal(isMailHeld("root"), true, "the blocked collect holds its inbox from entry");
		mailFromChild(db, "the postman waits its turn", "the body the collect must hand over");
		await postman.tick();
		await postman.tick();
		assert.deepEqual(injected, [], "two ticks inside the block deliver nothing");
		assert.equal(inbox(db, "root", { delivery: MAIL_DELIVERY.ACCEPTED }).length, 0);
		const result = await within(collecting, "the blocked collect preempted", 1_000);
		const elapsed = returnedAt - startedAt;
		assert.equal((result.details as { state?: string }).state, "mail");
		assert.ok(elapsed < 500, `the collect settled in ${elapsed}ms`);
		// The hold is gone with the call: the postman is back on duty.
		assert.equal(isMailHeld("root"), false, "the finished collect hands the inbox back");
		mailFromChild(db, "second mail", "the postman's again, not the tool's");
		await postman.tick();
		assert.equal(injected.length, 1, "the next tick injects exactly the new mail");
		assert.match(injected[0]!, /Subject: second mail/);
	} finally {
		postman.stop();
		runtime.dispose();
		dispose();
		db.close();
	}
});

test("collect releases the hold when the caller is already gone (M4-2)", async () => {
	const db = mailLedger();
	const { store, cwd, dispose } = tempStore();
	const runtime = blockedRuntime();
	mailFromChild(db, "waiting for a gone caller", "must stay queued");
	try {
		const aborted = new AbortController();
		aborted.abort();
		const result = await within(
			collectChild(collectFixture(runtime, store, cwd), aborted.signal, {
				db,
				nodeId: "root",
			}),
			"the already-aborted collect",
		);
		assert.match(textOf(result), /interrupted \(parent turn ended; children still running\)/);
		assert.equal((result.details as { state?: string }).state, undefined);
		assert.equal(isMailHeld("root"), false, "the entry return path must release the hold");
		assert.equal(pendingInbox(db, "root").length, 1, "and it takes no mail");
	} finally {
		runtime.dispose();
		dispose();
		db.close();
	}
});

test("collect releases the hold when it preempts at entry (M4-3)", async () => {
	const db = mailLedger();
	const { store, cwd, dispose } = tempStore();
	const runtime = blockedRuntime();
	mailFromChild(db, "already here", "the collect takes it on entry");
	try {
		const result = await within(
			collectChild(collectFixture(runtime, store, cwd), undefined, {
				db,
				nodeId: "root",
			}),
			"the collect that preempts on entry",
		);
		assert.equal((result.details as { state?: string }).state, "mail");
		assert.match(textOf(result), /Subject: already here/);
		assert.equal(isMailHeld("root"), false, "the entry-preempt path must release the hold too");
		assert.equal(inbox(db, "root", { delivery: MAIL_DELIVERY.ACCEPTED }).length, 1);
	} finally {
		runtime.dispose();
		dispose();
		db.close();
	}
});

test("the hold is released when the blocking call ends without mail", async () => {
	const db = mailLedger();
	const { store, cwd, dispose } = tempStore();
	const runtime = blockedRuntime();
	const injected: string[] = [];
	const postman = new LegionPostman({
		db,
		nodeId: "root",
		supervisor: new FakeSupervisor(),
		now: () => Date.now(),
		sendRootMessage: (message) => injected.push(message),
		intervalMs: 10_000,
	});
	try {
		const result = await within(
			waitAction({
				params: { action: "wait", name: CHILD, timeoutMs: 100 },
				runtime,
				agents: [agent("worker")],
				store,
				cwd,
				mail: { db, nodeId: "root" },
			}),
			"the wait timed out",
		);
		assert.match(textOf(result), /status: wait_timeout/);
		// The timeout path is the one that could park the inbox forever.
		assert.equal(isMailHeld("root"), false, "a finished wait hands the inbox back");
		mailFromChild(db, "after the wait", "delivered by the postman as usual");
		await postman.tick();
		assert.equal(injected.length, 1, "the postman delivers again once the hold is gone");
		assert.match(injected[0]!, /Subject: after the wait/);
		assert.equal(inbox(db, "root", { delivery: MAIL_DELIVERY.ACCEPTED }).length, 1);
	} finally {
		postman.stop();
		runtime.dispose();
		dispose();
		db.close();
	}
});

test("an in-process child that holds its inbox is skipped by the parent postman (m6)", async () => {
	const db = openLegionDb(":memory:");
	const rootDir = mkdtempSync(path.join(tmpdir(), "mail-preempt-child-hold-"));
	const supervisor = new FakeSupervisor();
	const sessionFile = path.join(rootDir, "team.jsonl");
	mkdirSync(rootDir, { recursive: true });
	try {
		insertNode(db, { parentId: null, name: "root", role: "root", status: "running" }, () => 1);
		const child = insertNode(
			db,
			{ parentId: "root", name: "team", role: "centurion", status: "running", sessionFile },
			() => 2,
		);
		await supervisor.spawnChild({
			name: child.name,
			task: "held child fixture",
			agent: agent("centurion"),
			sessionFile,
			tempDir: rootDir,
			cwd: rootDir,
		});
		fixtureMail(db, { from: "root", to: "team", subject: "for a blocked child", body: "hold me" });
		const postman = new LegionPostman({
			db,
			nodeId: "root",
			supervisor,
			now: () => Date.now(),
			intervalMs: 10_000,
		});
		try {
			// A child's `wait`/`collect` takes the same hold under its own node id; the
			// parent's postman runs in this process, so it must stand aside too.
			beginMailHold(child.id);
			await postman.tick();
			assert.equal(
				supervisor.calls.filter((call) => call.method === "followUp").length,
				0,
				"the held child receives nothing",
			);
			assert.equal(inbox(db, child.id, { delivery: MAIL_DELIVERY.PENDING }).length, 1);
			endMailHold(child.id);
			await postman.tick();
			assert.equal(
				supervisor.calls.filter((call) => call.method === "followUp").length,
				1,
				"once the hold is gone the parent postman delivers normally",
			);
			assert.equal(inbox(db, child.id, { delivery: MAIL_DELIVERY.ACCEPTED }).length, 1);
		} finally {
			postman.stop();
		}
	} finally {
		rmSync(rootDir, { recursive: true, force: true });
		db.close();
	}
});

test("a re-delivered mail spends no quota and is never double-prefixed (m5)", () => {
	const db = mailLedger();
	try {
		// Fill most of the sender's window with genuine sends (the limiter counts them).
		const ids: number[] = [];
		for (let index = 0; index < DEFAULT_MAIL_RATE_PER_5_MIN - 2; index += 1) {
			ids.push(mailFromChild(db, `genuine ${index}`, "counted once"));
		}
		// Five platform re-deliveries of those same mails: five extra rows, none of them
		// a send the sender chose to make.
		const copies = redeliverMail(db, [ids[0]!, ids[1]!, ids[2]!, ids[3]!, ids[4]!]);
		assert.equal(copies.length, 5);
		assert.match(copies[0]!.subject, /^Redelivered: genuine 0$/);
		// Re-delivering a copy keeps ONE prefix.
		const again = redeliverMail(db, [copies[0]!.id]);
		assert.equal(again[0]!.subject, "Redelivered: genuine 0", "no `Redelivered: Redelivered:`");
		// The quota still has the two slots the genuine sends left, and only those.
		assert.equal(mailFromChildOk(db, "after copies 1"), true);
		assert.equal(mailFromChildOk(db, "after copies 2"), true);
		assert.equal(
			mailFromChildOk(db, "the 11th counted mail"),
			false,
			"the copies did not spend the quota, so this is the sender's own 11th message",
		);
	} finally {
		db.close();
	}
});

test("a stale phase-timeout notice is discarded, never handed over (M1)", () => {
	const db = mailLedger();
	try {
		// The sender of a `Phase timeout:` notice is what makes it stale: once that child
		// has ended, the phase it is nagging about is over. The postman already refuses to
		// deliver these (#333); the preemption must agree, or the model gets a to-do that
		// the ledger itself considers pointless.
		const timedOut = insertNode(
			db,
			{ parentId: "root", name: "late", role: "centurion", status: "failed" },
			() => 100,
		);
		assert.equal(hasEnded(timedOut), true, "fixture: the sender has ended");
		const stale = fixtureMail(db, {
			from: timedOut.id,
			to: "root",
			subject: "Phase timeout: implementing",
			body: "the phase this asked about is over",
			kind: "notice",
		});
		// A live second mail proves the loop keeps going after the discard.
		const live = fixtureMail(db, {
			from: "root.team",
			to: "root",
			subject: "still relevant",
			body: "this one must be handed over",
		});
		assert.deepEqual(
			takePendingMail(db, "root").map((message) => message.id),
			[live],
			"the stale notice is skipped, the live mail still comes through",
		);
		assert.equal(inbox(db, "root", { delivery: MAIL_DELIVERY.OBSOLETE }).length, 1);
		assert.equal(getMessage(db, stale)?.delivered, MAIL_DELIVERY.OBSOLETE);
		assert.equal(getMessage(db, live)?.delivered, MAIL_DELIVERY.ACCEPTED);
		// D4: the preemption names WHY it discarded the row, through the same `mail_bounced`
		// event the postman writes — the two notice classes are only distinguishable here.
		// A missing/renamed reason (the `takePendingMail` call passing no `{ reason }` and
		// some later refactor moving the default) leaves the operator unable to tell a
		// "phase moved on" verdict from a "children are gone" one.
		assert.deepEqual(
			bouncedEvents(db).map((event) => ({ messageId: event.messageId, reason: event.reason })),
			[{ messageId: stale, reason: "obsolete_after_phase_change" }],
			"the phase-timeout discard carries its own reason, not the stall one",
		);
	} finally {
		db.close();
	}
});

/**
 * stall-notice-staleness §6.7 / D3 (R3): the 250ms poll counts "releasable", not
 * "pending", and it uses the SAME predicate as `takePendingMail`.
 *
 * The production shape of this: root sits in a 15-minute `wait`, the postman's stall
 * detector writes a notice into root's inbox, and by the time the poll looks the child
 * is already back. If the count includes that row the wait aborts, `takePendingMail`
 * hands back nothing and the caller reports an abort that never happened — a stall
 * notice about finished work would end a live wait. So the notice is written MID-wait
 * (an empty inbox at entry proves nothing about the poll) and the wait must run to its
 * own timeout.
 */
test("a stale stall notice does not preempt a blocked wait — a fresh one still does (§6.7)", async () => {
	const db = mailLedger();
	// One child that has ended and one that has not: the notice's verdict is decided by
	// the tree, not by how recently it was written.
	const gone = insertNode(db, { parentId: "root", name: "gone", role: "worker", status: "retired" }, () => 100);
	const alive = insertNode(db, { parentId: "root", name: CHILD, role: "worker", status: "running" }, () => 100);
	assert.equal(hasEnded(gone), true, "fixture: `gone` has ended");
	assert.equal(hasEnded(alive), false, "fixture: `live` is still running");
	const { store, cwd, dispose } = tempStore();
	try {
		// 1. Only a STALE notice arrives while the wait is blocked.
		const queuedId = queueStallNotice(db, "root", ["gone"], 1_000);
		const runtime = blockedRuntime();
		// Written MID-wait on purpose: an inbox that is empty at entry proves nothing about
		// the 250ms poll, and the poll is the half of D3/R3 under test here.
		let midWaitId = 0;
		const staleTimer = setTimeout(() => {
			midWaitId = queueStallNotice(db, "root", ["gone"], 1_001);
		}, 100);
		const startedAt = Date.now();
		let timedOut: Result;
		try {
			timedOut = await within(
				waitAction({
					params: { action: "wait", name: CHILD, timeoutMs: 900 },
					runtime,
					agents: [agent("worker")],
					store,
					cwd,
					mail: { db, nodeId: "root" },
				}),
				"wait runs to its own timeout instead of preempting on stale mail",
				3_000,
			);
		} finally {
			clearTimeout(staleTimer);
			runtime.dispose();
		}
		const waited = Date.now() - startedAt;
		const body = textOf(timedOut);
		assert.match(body, /status: wait_timeout/, "the wait ends the ordinary way");
		assert.ok(body.includes("── live ──"), "the frozen timeout rendering, for this child");
		assert.match(body, /still running \(spawned \d+\.\d+s ago\)/);
		assert.doesNotMatch(body, /\[legion mail #/, "no envelope: nothing was handed over");
		assert.doesNotMatch(body, /parent turn ended/, "and no invented abort either");
		assert.ok(waited >= 700, `the poll ran at least twice and declined (${waited}ms of a 900ms wait)`);
		assert.equal((timedOut.details as { state?: string }).state, undefined);
		assert.notEqual(midWaitId, 0, "fixture: the stale notice really landed while the wait was blocked");
		// The two stale rows end in different places, and both are correct:
		// - the one queued BEFORE the call was obsoleted by the entry `takePendingMail`;
		// - the one that landed DURING the call was only *filtered* by the poll's
		//   releasable count — the poll must not claim or mutate it, so it stays PENDING
		//   for the postman. A count that did not filter it would have aborted the wait.
		assert.equal(getMessage(db, queuedId)?.delivered, MAIL_DELIVERY.OBSOLETE, "the entry take obsoletes the queued one");
		assert.equal(getMessage(db, midWaitId)?.delivered, MAIL_DELIVERY.PENDING, "the poll filters the mid-wait row without claiming it");
		assert.equal(inbox(db, "root", { delivery: MAIL_DELIVERY.ACCEPTED }).length, 0, "nothing was handed over");

		// 2. Positive control: the SAME fixture and the SAME write timing, but the notice
		// names the child that is still running. It must preempt through the POLL, which is
		// what makes this a control for step 1 rather than for the entry take.
		const live = blockedRuntime();
		let freshId = 0;
		const freshTimer = setTimeout(() => {
			freshId = queueStallNotice(db, "root", [CHILD], 1_002);
		}, 100);
		const preemptStartedAt = Date.now();
		let preempted: Result;
		try {
			preempted = await within(
				waitAction({
					// A generous ceiling on the tool's own wait, but not a CI hazard: when the
					// preemption is broken this call must fail the `within` bound in 3s, not sit
					// here for a minute (the poll timer is deliberately not unref'd, so a stuck
					// wait keeps the whole file alive).
					params: { action: "wait", name: CHILD, timeoutMs: 4_000 },
					runtime: live,
					agents: [agent("worker")],
					store,
					cwd,
					mail: { db, nodeId: "root" },
				}),
				"wait preempted by the fresh stall notice",
				3_000,
			);
		} finally {
			clearTimeout(freshTimer);
			live.dispose();
		}
		const preemptedIn = Date.now() - preemptStartedAt;
		const preemptBody = textOf(preempted);
		assert.notEqual(freshId, 0, "fixture: the fresh notice landed while the wait was blocked");
		// One poll is 250ms; 2s tolerates a loaded CI runner while still being far below the
		// tool's 4s budget, so "returned because it was preempted" and "returned because the
		// wait timed out" remain distinguishable. Which path fired is proved independently
		// below (`details.state === "mail"` + the envelope), not by this bound.
		assert.ok(preemptedIn < 2_000, `a live notice still preempts inside the poll window (${preemptedIn}ms)`);
		assert.match(preemptBody, /\[legion mail #\d+\]/, "the mail envelope, exactly as the postman renders it");
		assert.match(preemptBody, /Subject: Stall notice: live/);
		assert.match(preemptBody, /Detected at /, "D1: even a preempted notice says when it was detected");
		const details = preempted.details as { state?: string; mailIds?: number[] };
		assert.equal(details.state, "mail");
		// The stale rows in the same inbox must not hide the live one: `takePendingMail`
		// skips them (obsoleting, never returning) and hands over exactly the fresh id.
		assert.deepEqual(details.mailIds, [freshId]);
		assert.equal(getMessage(db, midWaitId)?.delivered, MAIL_DELIVERY.OBSOLETE, "the take obsoletes the stale row it skips");
		// D4: `takePendingMail` passes the STALL reason explicitly. Without it the ledger's
		// default would relabel this row as a phase-timeout verdict — the two classes are
		// only told apart by `data.reason`, so nothing else in this fixture notices.
		assert.deepEqual(
			bouncedEvents(db)
				.filter((event) => event.messageId === queuedId || event.messageId === midWaitId)
				.map((event) => ({ messageId: event.messageId, reason: event.reason })),
			[
				{ messageId: queuedId, reason: "obsolete_after_child_end" },
				{ messageId: midWaitId, reason: "obsolete_after_child_end" },
			],
			"both stall discards (entry take + mid-wait take) carry obsolete_after_child_end",
		);
		assert.equal(
			inbox(db, "root", { delivery: MAIL_DELIVERY.ACCEPTED }).length,
			1,
			"only the live notice is accepted — the stale ones are discarded, not delivered",
		);
	} finally {
		dispose();
		db.close();
	}
});

/**
 * §6.7, the PHASE-TIMEOUT half of the same rule (D3/R3).
 *
 * `pendingMailCount` is the single place where "count only what the take can release"
 * has to be spelled out per notice class, so each class gets its own blocked wait: the
 * stall case above pins the stall arm, this one pins the phase-timeout arm. A poll that
 * filtered only the stall half — the obvious way to half-fix R3, since the stall notice
 * is the class this contract added — leaves the RAW COUNT above zero on this fixture,
 * aborts the wait on the next poll, and `takePendingMail` then filters the row away and
 * hands back nothing: the caller reports `interrupted (parent turn ended; children
 * still running)` for a wait whose parent turn is alive.
 *
 * The row is written MID-wait for the same reason as the stall case: an inbox that is
 * empty at entry says nothing about the 250ms poll, and the poll is the half under test.
 */
test("a stale phase-timeout notice does not preempt a blocked wait — a fresh one still does (§6.7)", async () => {
	const db = mailLedger();
	// The M1 shape: a `Phase timeout:` notice is stale once its SENDER has ended. The
	// raw `COUNT(*)` of pending rows is 1 either way; only the predicate differs.
	const late = insertNode(db, { parentId: "root", name: "late", role: "centurion", status: "failed" }, () => 100);
	insertNode(db, { parentId: "root", name: CHILD, role: "worker", status: "running" }, () => 100);
	assert.equal(hasEnded(late), true, "fixture: the phase-timeout sender has ended");
	const { store, cwd, dispose } = tempStore();
	try {
		// 1. Only a STALE phase-timeout notice arrives while the wait is blocked.
		const runtime = blockedRuntime();
		let staleId = 0;
		const staleTimer = setTimeout(() => {
			staleId = fixtureMail(db, {
				from: late.id,
				to: "root",
				subject: "Phase timeout: implementing",
				body: "the phase this asked about is over",
				kind: "notice",
			});
		}, 100);
		const startedAt = Date.now();
		let timedOut: Result;
		try {
			timedOut = await within(
				waitAction({
					params: { action: "wait", name: CHILD, timeoutMs: 900 },
					runtime,
					agents: [agent("worker")],
					store,
					cwd,
					mail: { db, nodeId: "root" },
				}),
				"wait runs to its own timeout instead of preempting on a stale phase-timeout notice",
				3_000,
			);
		} finally {
			clearTimeout(staleTimer);
			runtime.dispose();
		}
		const waited = Date.now() - startedAt;
		const body = textOf(timedOut);
		assert.match(body, /status: wait_timeout/, "the wait ends the ordinary way");
		assert.ok(body.includes("── live ──"), "the frozen timeout rendering, for this child");
		assert.match(body, /still running \(spawned \d+\.\d+s ago\)/);
		assert.doesNotMatch(body, /\[legion mail #/, "no envelope: nothing was handed over");
		assert.doesNotMatch(body, /parent turn ended/, "and no invented abort either");
		assert.ok(waited >= 700, `the poll ran at least twice and declined (${waited}ms of a 900ms wait)`);
		assert.equal((timedOut.details as { state?: string }).state, undefined);
		assert.notEqual(staleId, 0, "fixture: the stale notice really landed while the wait was blocked");
		// The raw count is 1 and the releasable count is 0: exactly the split the poll must
		// make (contract D3/R3). A `COUNT(*)` poll would have aborted on it.
		assert.equal(pendingInbox(db, "root").length, 1, "precondition: an unfiltered count of this inbox is 1");
		// The poll FILTERS, it never claims: the row is still the postman's to obsolete.
		assert.equal(getMessage(db, staleId)?.delivered, MAIL_DELIVERY.PENDING, "the poll filters the mid-wait row without claiming it");
		assert.equal(inbox(db, "root", { delivery: MAIL_DELIVERY.ACCEPTED }).length, 0, "nothing was handed over");

		// 2. Positive control: the SAME fixture and the SAME write timing, but the sender is
		// alive and still in the phase the notice names. It must preempt through the POLL —
		// that is what makes this a control for step 1 rather than for the entry take.
		const team = getNode(db, "root.team")!;
		updateNode(db, team.id, { phase: "implementing", phaseSince: 100 }, () => 100);
		appendEvent(
			db,
			team.id,
			"phase_timeout",
			{ phase: "implementing", phaseSince: 100, elapsedMs: 1_800_573, timeoutMs: 1_800_000 },
			{ now: () => Date.now() - 1_000 },
		);
		assert.equal(getNode(db, team.id)?.phase, "implementing", "fixture: the live sender is in the phase it names");
		const live = blockedRuntime();
		let freshId = 0;
		const freshTimer = setTimeout(() => {
			freshId = fixtureMail(db, {
				from: team.id,
				to: "root",
				subject: "Phase timeout: team",
				body: "the phase this asked about is still current",
				kind: "notice",
			});
		}, 100);
		const preemptStartedAt = Date.now();
		let preempted: Result;
		try {
			preempted = await within(
				waitAction({
					// Bounded so a broken preemption fails the `within` bound in 3s instead of
					// parking the whole file behind the un-unref'd poll timer.
					params: { action: "wait", name: CHILD, timeoutMs: 4_000 },
					runtime: live,
					agents: [agent("worker")],
					store,
					cwd,
					mail: { db, nodeId: "root" },
				}),
				"wait preempted by the fresh phase-timeout notice",
				3_000,
			);
		} finally {
			clearTimeout(freshTimer);
			live.dispose();
		}
		const preemptedIn = Date.now() - preemptStartedAt;
		const preemptBody = textOf(preempted);
		assert.notEqual(freshId, 0, "fixture: the fresh notice landed while the wait was blocked");
		assert.ok(preemptedIn < 2_000, `a live phase-timeout notice still preempts inside the poll window (${preemptedIn}ms)`);
		assert.match(preemptBody, /\[legion mail #\d+\]/, "the mail envelope, exactly as the postman renders it");
		assert.match(preemptBody, /Subject: Phase timeout: team/);
		const details = preempted.details as { state?: string; mailIds?: number[] };
		assert.equal(details.state, "mail");
		assert.deepEqual(details.mailIds, [freshId], "exactly the fresh notice, never the stale one");
		assert.equal(getMessage(db, staleId)?.delivered, MAIL_DELIVERY.OBSOLETE, "the take obsoletes the stale row it skips");
		// D4: the phase-timeout class keeps its OWN reason through the preemption path.
		assert.deepEqual(
			bouncedEvents(db).map((event) => ({ messageId: event.messageId, reason: event.reason })),
			[{ messageId: staleId, reason: "obsolete_after_phase_change" }],
		);
	} finally {
		dispose();
		db.close();
	}
});

test("a long send keeps renewing its claim, so the lease never lapses (M3)", async (t) => {
	const db = openLegionDb(":memory:");
	const rootDir = mkdtempSync(path.join(tmpdir(), "mail-preempt-renew-"));
	const supervisor = new GatedFollowUpSupervisor();
	const sessionFile = path.join(rootDir, "team.jsonl");
	mkdirSync(rootDir, { recursive: true });
	t.mock.timers.enable({ apis: ["setInterval", "Date"], now: Date.now() });
	try {
		insertNode(db, { parentId: null, name: "root", role: "root", status: "running" }, () => 1);
		const child = insertNode(
			db,
			{ parentId: "root", name: "team", role: "centurion", status: "running", sessionFile },
			() => 2,
		);
		await supervisor.spawnChild({
			name: child.name,
			task: "slow send fixture",
			agent: agent("centurion"),
			sessionFile,
			tempDir: rootDir,
			cwd: rootDir,
		});
		const messageId = fixtureMail(db, {
			from: "root",
			to: "team",
			subject: "a send that outlives the lease",
			body: "resumeChild waits on the admission queue",
		});
		const postman = new LegionPostman({
			db,
			nodeId: "root",
			supervisor,
			now: () => Date.now(),
			intervalMs: 10_000,
		});
		const tick = postman.tick();
		try {
			await within(supervisor.parked, "the postman is parked inside its send call");
			const claimedAt = getMessage(db, messageId)!.deliveredAt;
			assert.equal(getMessage(db, messageId)?.delivered, MAIL_DELIVERY.PENDING);
			// Three whole lease periods pass inside ONE send (the ruling's slow-send case:
			// `resumeChild` waits on an admission queue whose default is 900s).
			t.mock.timers.tick(MAIL_DELIVERY_CLAIM_LEASE_MS * 3);
			const renewedAt = getMessage(db, messageId)!.deliveredAt;
			assert.ok(
				renewedAt !== null && claimedAt !== null && renewedAt > claimedAt,
				`the claim was renewed while the send ran (${claimedAt} -> ${renewedAt})`,
			);
			// Still exclusive: nobody else can take a lease the holder keeps alive.
			assert.equal(
				claimForDelivery(db, messageId, () => Date.now(), MAIL_DELIVERY_CLAIM_LEASE_MS),
				false,
				"a renewed lease is as exclusive as a fresh one",
			);
			assert.equal(getMessage(db, messageId)?.delivered, MAIL_DELIVERY.PENDING);
		} finally {
			supervisor.free();
			await within(tick, "the postman tick finished");
			postman.stop();
		}
		// The send returned: the transition owns the row, and the renewal stopped.
		const acceptedAt = getMessage(db, messageId)!.deliveredAt;
		assert.equal(getMessage(db, messageId)?.delivered, MAIL_DELIVERY.ACCEPTED);
		t.mock.timers.tick(MAIL_DELIVERY_CLAIM_LEASE_MS * 3);
		assert.equal(
			getMessage(db, messageId)!.deliveredAt,
			acceptedAt,
			"no renewal runs after the send settled",
		);
		// …and renewal itself refuses a row that already left PENDING.
		assert.equal(renewDeliveryClaim(db, messageId, () => Date.now(), MAIL_DELIVERY_CLAIM_LEASE_MS), false);
	} finally {
		rmSync(rootDir, { recursive: true, force: true });
		db.close();
	}
});

test("a lease is exclusive while it runs and reclaimable after 60s (P0-1 lease)", async () => {
	const db = openLegionDb(":memory:");
	const rootDir = mkdtempSync(path.join(tmpdir(), "mail-preempt-lease-"));
	const supervisor = new FakeSupervisor();
	const sessionFile = path.join(rootDir, "team.jsonl");
	mkdirSync(rootDir, { recursive: true });
	try {
		insertNode(db, { parentId: null, name: "root", role: "root", status: "running" }, () => 1);
		const child = insertNode(
			db,
			{ parentId: "root", name: "team", role: "centurion", status: "running", sessionFile },
			() => 2,
		);
		await supervisor.spawnChild({
			name: child.name,
			task: "lease fixture",
			agent: agent("centurion"),
			sessionFile,
			tempDir: rootDir,
			cwd: rootDir,
		});
		const messageId = fixtureMail(db, {
			from: "root",
			to: "team",
			subject: "leased message",
			body: "one holder at a time",
		});
		const t = 1_000_000;
		// Whoever claims first holds it: the predicate is `delivered_at < now - leaseMs`.
		assert.equal(claimForDelivery(db, messageId, () => t, MAIL_DELIVERY_CLAIM_LEASE_MS), true);
		assert.equal(
			claimForDelivery(db, messageId, () => t + MAIL_DELIVERY_CLAIM_LEASE_MS, MAIL_DELIVERY_CLAIM_LEASE_MS),
			false,
			"the last millisecond of the lease still belongs to the holder",
		);
		assert.equal(
			claimForDelivery(db, messageId, () => t + MAIL_DELIVERY_CLAIM_LEASE_MS + 1, MAIL_DELIVERY_CLAIM_LEASE_MS),
			true,
			"the ruling's now + 60_001: an expired lease is reclaimable",
		);
		// The lease is what a crash leaves behind, so the postman must be able to take an
		// expired one over on its next tick.
		db.prepare("UPDATE messages SET delivered_at = ?, delivered = ? WHERE id = ?").run(
			Date.now() - MAIL_DELIVERY_CLAIM_LEASE_MS - 1,
			MAIL_DELIVERY.PENDING,
			messageId,
		);
		const postman = new LegionPostman({
			db,
			nodeId: "root",
			supervisor,
			now: () => Date.now(),
			intervalMs: 10_000,
		});
		try {
			await within(postman.tick(), "the postman took the expired lease over");
		} finally {
			postman.stop();
		}
		assert.equal(inbox(db, child.id, { delivery: MAIL_DELIVERY.ACCEPTED }).length, 1);
		assert.equal(supervisor.calls.filter((call) => call.method === "followUp").length, 1);
	} finally {
		rmSync(rootDir, { recursive: true, force: true });
		db.close();
	}
});

test("a thrown send releases the lease so the next tick retries (P0-1 lease)", async () => {
	const db = openLegionDb(":memory:");
	const rootDir = mkdtempSync(path.join(tmpdir(), "mail-preempt-release-"));
	const supervisor = new FlakyFollowUpSupervisor();
	const sessionFile = path.join(rootDir, "team.jsonl");
	mkdirSync(rootDir, { recursive: true });
	try {
		insertNode(db, { parentId: null, name: "root", role: "root", status: "running" }, () => 1);
		const child = insertNode(
			db,
			{ parentId: "root", name: "team", role: "centurion", status: "running", sessionFile },
			() => 2,
		);
		await supervisor.spawnChild({
			name: child.name,
			task: "flaky send fixture",
			agent: agent("centurion"),
			sessionFile,
			tempDir: rootDir,
			cwd: rootDir,
		});
		const messageId = fixtureMail(db, {
			from: "root",
			to: "team",
			subject: "retry me",
			body: "the first send throws",
		});
		const postman = new LegionPostman({
			db,
			nodeId: "root",
			supervisor,
			now: () => Date.now(),
			intervalMs: 10_000,
		});
		try {
			await within(postman.tick(), "the failing tick finished");
			const afterFailure = getMessage(db, messageId);
			assert.equal(afterFailure?.delivered, MAIL_DELIVERY.PENDING, "a send failure is not a verdict");
			assert.equal(afterFailure?.deliveredAt, null, "the lease is handed back, not left to expire");
			assert.equal(inbox(db, child.id, { delivery: MAIL_DELIVERY.BOUNCED }).length, 0, "nothing bounced");
			// The retry the pre-#384 comment promised still happens.
			await within(postman.tick(), "the retry tick finished");
		} finally {
			postman.stop();
		}
		assert.equal(supervisor.handed.length, 1, "the retry is the one that got through");
		assert.equal(inbox(db, child.id, { delivery: MAIL_DELIVERY.ACCEPTED }).length, 1);
	} finally {
		rmSync(rootDir, { recursive: true, force: true });
		db.close();
	}
});

test("the 250ms poll never outlives the call it was armed for (P1 gap)", async () => {
	const db = mailLedger();
	const { store, cwd, dispose } = tempStore();
	// No mail anywhere: the poll is armed, never fires a hit, and only the call ending
	// can put it down. Deleting the `finally { stopPolling?.() }` leaves it running.
	const runUnwatched = async (
		run: () => Promise<unknown>,
	): Promise<{ created: number; survivors: number }> => {
		const realSetInterval = globalThis.setInterval;
		const realClearInterval = globalThis.clearInterval;
		const created: unknown[] = [];
		const cleared = new Set<unknown>();
		globalThis.setInterval = ((handler: () => void, ms?: number) => {
			const handle = realSetInterval(handler, ms);
			created.push(handle);
			return handle;
		}) as typeof setInterval;
		globalThis.clearInterval = ((handle?: ReturnType<typeof setInterval>) => {
			cleared.add(handle);
			return realClearInterval(handle);
		}) as typeof clearInterval;
		try {
			await run();
		} finally {
			globalThis.setInterval = realSetInterval;
			globalThis.clearInterval = realClearInterval;
		}
		const survivors = created.filter((handle) => !cleared.has(handle));
		// Clean up whatever the call leaked so this test never owns a live timer.
		for (const handle of survivors) realClearInterval(handle as ReturnType<typeof setInterval>);
		return { created: created.length, survivors: survivors.length };
	};
	try {
		// The runtime is built OUTSIDE the spy: `createSessionRuntime` arms its own
		// refresh interval, and counting that would make this test measure the wrong thing.
		const waitRuntime = blockedRuntime();
		const wait = await runUnwatched(async () => {
			try {
				return await waitAction({
					params: { action: "wait", name: CHILD, timeoutMs: 60 },
					runtime: waitRuntime,
					agents: [agent("worker")],
					store,
					cwd,
					mail: { db, nodeId: "root" },
				});
			} finally {
				waitRuntime.dispose();
			}
		});
		assert.equal(wait.created, 1, "fixture: the wait armed exactly one poll");
		assert.equal(wait.survivors, 0, "the wait's poll must be cleared before it returns");
		const collectRuntime = settledRuntime("done-output");
		const collect = await runUnwatched(async () => {
			try {
				return await collectChild(collectFixture(collectRuntime, store, cwd), undefined, {
					db,
					nodeId: "root",
				});
			} finally {
				collectRuntime.dispose();
			}
		});
		assert.equal(collect.created, 1, "fixture: the collect armed exactly one poll");
		assert.equal(collect.survivors, 0, "the collect's poll must be cleared before it returns");
	} finally {
		dispose();
		db.close();
	}
});
