/**
 * #384 — a BLOCKED `wait`/`collect` hands over this node's mail instead of holding
 * it until the turn ends.
 *
 * Frozen contract: `docs/contracts/wait-mail-preempt-v1.md`. The failure it fixes
 * is a queueing one: `legion_mail → root` rides the host's followUp, which is only
 * taken at a turn boundary, so mail written while the root sat in a long `wait`
 * waited with it (measured 17.3 minutes, contract §0).
 *
 * What this file pins, one test per contract clause:
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
 *     was already aborted at entry or landed mid-wait.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { collectChild, waitAction } from "../../index.ts";
import {
	createSessionRuntime,
	type CollectSnapshot,
	type SessionRuntime,
} from "../../src/extension/runtime.ts";
import { LegionPostman } from "../../src/extension/legion-tools.ts";
import { RunStore } from "../../src/runs/store.ts";
import { openLegionDb } from "../../src/legion/db.ts";
import { MAIL_DELIVERY, inbox, pendingInbox, sendMail } from "../../src/legion/mail.ts";
import { insertNode } from "../../src/legion/nodes.ts";
import type { AgentConfig } from "../../src/shared/types.ts";
import { FakeSupervisor } from "../helpers/fake-supervisor.ts";

/** Wall-clock bound for every fixture wait: nothing here may hang the suite. */
const BOUND_MS = 5_000;
/** The child this file controls; the run it belongs to is irrelevant to the seam. */
const CHILD = "live";
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

function agent(name: string): AgentConfig {
	return { name, description: `${name} role`, source: "user" } as AgentConfig;
}

function terminalSnapshot(output: string): CollectSnapshot {
	return {
		execution: { status: "success" },
		output,
		acceptance: { status: "accepted", level: "attested" },
	};
}

/** A tracked child whose collect never resolves — the wait/collect is blocked. */
function blockedRuntime(): SessionRuntime {
	const runtime = createSessionRuntime({ sendMessage() {} });
	runtime.track({
		name: CHILD,
		runId: RUN,
		agent: "worker",
		sessionFile: `/tmp/${CHILD}.jsonl`,
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
function mailLedger(): ReturnType<typeof openLegionDb> {
	const db = openLegionDb(":memory:");
	insertNode(db, { parentId: null, name: "root", role: "root", status: "running" });
	insertNode(db, { parentId: "root", name: "team", role: "centurion", status: "running" });
	return db;
}

function mailFromChild(
	db: ReturnType<typeof openLegionDb>,
	subject: string,
	body: string,
): number {
	const sent = sendMail(
		db,
		{ fromNode: "root.team", to: "parent", subject, body },
		{ now: () => Date.now() },
	);
	assert.equal(sent.ok, true, "fixture mail must be accepted");
	if (!sent.ok) throw new Error("fixture mail was refused");
	return sent.messages[0]!.id;
}

/**
 * Run one postman tick on `root` and report what it would have injected.
 *
 * This is the I2 probe: the preemption's `PENDING → ACCEPTED` is the ONLY
 * anti-duplicate mechanism the contract allows, so the tick after a release has to
 * come up empty.
 */
async function postmanTick(db: ReturnType<typeof openLegionDb>): Promise<string[]> {
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
		assert.match(body, /Children are still running: live \(working\)/);
		const details = result.details as {
			state?: string;
			mailIds?: number[];
			targets?: string[];
		};
		assert.equal(details.state, "mail");
		assert.deepEqual(details.mailIds, [mailId]);
		assert.deepEqual(details.targets, [CHILD]);
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

test("a mid-wait caller abort wins over mail that lands after it (I5)", async () => {
	const db = mailLedger();
	const { store, cwd, dispose } = tempStore();
	const runtime = blockedRuntime();
	const controller = new AbortController();
	const abortAt = setTimeout(() => controller.abort(), 50);
	// Mail arrives well after the abort, and is always awaited before `db.close()`.
	const arriving = new Promise<number>((resolve) => {
		setTimeout(() => resolve(mailFromChild(db, "too late", "written after the abort")), 400);
	});
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
		const mailId = await arriving;
		assert.match(textOf(result), /interrupted \(parent turn ended; children still running\)/);
		assert.equal((result.details as { state?: string }).state, undefined);
		// Mail that lands after the caller's abort stays for the postman.
		assert.deepEqual(
			pendingInbox(db, "root").map((message) => message.id),
			[mailId],
		);
	} finally {
		clearTimeout(abortAt);
		await arriving.catch(() => 0);
		runtime.dispose();
		dispose();
		db.close();
	}
});
