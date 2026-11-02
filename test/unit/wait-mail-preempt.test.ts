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
 *   - §2/I4 — the same for `collect`, plus the child is untouched: still tracked,
 *     still `working`, and its notice route (`consumedByTool`) still open (#352);
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
import { MAIL_DELIVERY, inbox, pendingInbox, sendMail } from "../../src/legion/mail.ts";
import { takePendingMail } from "../../src/legion/mail-release.ts";
import { getNode, insertNode, updateNode, type LegionNode } from "../../src/legion/nodes.ts";
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

function fixtureMail(
	db: DatabaseSync,
	input: { from: string; to: string; subject: string; body: string },
): number {
	const sent = sendMail(
		db,
		{ fromNode: input.from, to: input.to, subject: input.subject, body: input.body },
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
			waitClaims?: unknown[];
		};
		assert.equal(details.state, "mail");
		assert.deepEqual(details.mailIds, [mailId]);
		assert.deepEqual(details.targets, [CHILD]);
		assert.deepEqual(details.waitClaims, [], "the claim record is still mounted (#352)");
		// I2: taken exactly once, by the one write the contract allows.
		assert.equal(inbox(db, "root", { delivery: MAIL_DELIVERY.ACCEPTED }).length, 1);
		assert.equal(pendingInbox(db, "root").length, 0);
		assert.deepEqual(await postmanTick(db), [], "an ACCEPTED message is never injected twice");
		// I4: the child was not touched.
		assert.equal(runtime.get(CHILD)?.state, "working");
		assert.ok(returnedAt - sentAt < 1_000, `preempted in ${returnedAt - sentAt}ms`);
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
		// I4: only the CALL returns — the child is still there.
		assert.equal(runtime.get(CHILD)?.state, "working");
		// #352: the preempted collect delivered no result, so it must hold no claim and
		// must have left the notification route open.
		assert.equal(runtime.get(CHILD)?.consumedByTool, false);
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
			// The send is in flight. Review P0-1: the ledger must ALREADY say so, or the
			// child's own preemption sees `PENDING` and hands over a second copy.
			assert.equal(
				getNode(db, child.id)?.status,
				"running",
				"fixture: the child is live during the delivery",
			);
			assert.equal(
				inbox(db, child.id, { delivery: MAIL_DELIVERY.PENDING }).length,
				0,
				"the row is claimed BEFORE the send, so no second route may take it",
			);
			assert.deepEqual(
				takePendingMail(db, child.id),
				[],
				"the child's own blocked wait finds nothing to take",
			);
		} finally {
			supervisor.free();
			await within(tick, "the postman tick finished");
			postman.stop();
		}
		// Exactly one copy reached the child, and the ledger backs that up.
		assert.equal(supervisor.handed.length, 1, "one send call, one copy");
		assert.match(supervisor.handed[0]!, /Subject: one copy only/);
		assert.equal(inbox(db, child.id, { delivery: MAIL_DELIVERY.ACCEPTED }).length, 1);
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
			runtime,
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
 * A seam whose ledger reports mail to the POLL (`COUNT(*)`) but has none to take.
 *
 * That is the P1.1 interleaving in one object: the poll saw a `PENDING` row, the
 * postman claimed it before `takePendingMail` ran, so the take comes back empty.
 * Faking it at the `prepare` boundary keeps the real ledger, real transitions and
 * real `collectChild`; only the "page of pending rows" query lies.
 */
function ledgerThatLosesTheMail(real: DatabaseSync): DatabaseSync {
	return new Proxy(real, {
		get(target, property, receiver) {
			if (property === "prepare") {
				return (sql: string) => {
					if (/SELECT \* FROM messages WHERE to_node = \? AND delivered = \? AND id > \?/.test(sql)) {
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
