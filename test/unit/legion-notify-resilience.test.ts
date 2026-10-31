/**
 * #353 review (major 3) — a refusal at the `legion_mail` boundary must not silence an
 * INTERNAL notice.
 *
 * #353 made `sendMail` throw `MailInvalidTextError` for a U+0000, because SQLite
 * truncates text there and the send used to answer `ok: true` while handing the
 * recipient a fragment. That refusal is right where the text is the model's own
 * (`legion_mail`). It is wrong at the three call sites that compose a notice from ledger
 * facts, because they run AFTER the durable move they describe:
 *
 *   1. `requestLegionPhase` writes `updateNode` + `phase_change` and only then calls
 *      `notifyParent`, so a throw turned an accepted transition — including a failed
 *      team's notice, the promise #309 made — into a tool error while the team had
 *      already moved;
 *   2. the same is true of the `reason` a centurion passes to `to:"failed"`, which is
 *      model-authored text and therefore a real NUL carrier;
 *   3. `checkOwnPhaseTimeout` wrote the `phase_timeout` row (also the de-dup key) BEFORE
 *      mailing, and `LegionPostman.start()` swallows whatever escapes (`.catch(() => {})`) —
 *      so a refused notice was lost for the whole stint.
 *
 * The tests below pin the repaired behaviour: the tool boundary refuses visibly, the
 * internal paths degrade instead of dropping, and a notice that could not be placed
 * leaves the de-dup key unwritten so the next tick tries again.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { createLegionEventBus } from "../../src/extension/event-bus.ts";
import { LegionPostman, registerLegionTools, requestLegionPhase } from "../../src/extension/legion-tools.ts";
import { openLegionDb } from "../../src/legion/db.ts";
import { readEventsAfter } from "../../src/legion/events.ts";
import { MAIL_INVALID_TEXT_CODE, MAIL_DELIVERY, inbox, sendMail } from "../../src/legion/mail.ts";
import { getNode, insertNode } from "../../src/legion/nodes.ts";
import type { PhaseMachine } from "../../src/legion/phase-machine.ts";
import { FakeSupervisor } from "../helpers/fake-supervisor.ts";

type Db = ReturnType<typeof openLegionDb>;

const NATIVE_NUL = "\u0000";
const NOW = 1_000_000;

function makeDb(options: { phase: string; phaseSince: number }): Db {
	const db = openLegionDb(":memory:");
	insertNode(db, { parentId: null, name: "root", role: "root", status: "running" }, () => NOW - 1_000);
	insertNode(db, {
		parentId: "root",
		name: "team",
		role: "centurion",
		status: "running",
		phase: options.phase,
		phaseSince: options.phaseSince,
	}, () => NOW - 1_000);
	return db;
}

function phaseTimeouts(db: Db) {
	return readEventsAfter(db, 0, { nodeId: "root.team" }).filter((event) => event.type === "phase_timeout");
}

/** One postman tick for the team itself: the seam that owns `checkOwnPhaseTimeout`. */
async function tickTeam(
	db: Db,
	options: { now: number; settings?: Record<string, unknown>; machine?: PhaseMachine; rootMessages?: string[] },
): Promise<void> {
	const postman = new LegionPostman({
		db,
		nodeId: "root.team",
		supervisor: new FakeSupervisor(),
		...(options.settings ? { settings: options.settings } : {}),
		...(options.machine ? { machine: options.machine } : {}),
		now: () => options.now,
		intervalMs: 10_000,
		sendRootMessage: (message) => options.rootMessages?.push(message),
		eventBus: createLegionEventBus(),
	});
	await postman.tick();
	postman.stop();
}

// ---------------------------------------------------------------------------
// 1. The `legion_mail` boundary: the refusal stays loud and visible (#353 minor 4)
// ---------------------------------------------------------------------------

function registerMailTool(db: Db, nodeId: string) {
	const tools = new Map<string, { execute: (id: string, params: Record<string, unknown>) => Promise<{ content?: Array<{ text?: string }>; details?: unknown }> }>();
	const pi = {
		registerTool(tool: unknown) {
			const typed = tool as { name: string; execute: (id: string, params: Record<string, unknown>) => Promise<{ content?: Array<{ text?: string }>; details?: unknown }> };
			tools.set(typed.name, typed);
		},
	};
	registerLegionTools(pi as unknown as ExtensionAPI, { db, nodeId, cwd: process.cwd() });
	return tools;
}

test("#353 review (minor 1): a NUL from the model is a visible tool refusal, not a thrown turn", async () => {
	const db = makeDb({ phase: "implementing", phaseSince: NOW });
	try {
		const mail = registerMailTool(db, "root.team").get("legion_mail");
		assert.ok(mail, "the mail tool is registered for every node");

		// The framework only reads `content`, so a bare throw would reach the model as a
		// failed tool call with no code. The refusal must arrive as a normal result whose
		// `details.error` carries the same vocabulary the `MailDenied` refusals use.
		const result = await mail.execute("call-1", {
			to: "parent",
			subject: "status",
			body: `done${NATIVE_NUL}truncated`,
		});
		assert.deepEqual((result.details as { error?: string }).error, MAIL_INVALID_TEXT_CODE);
		const text = (result.content ?? []).map((item) => item.text ?? "").join("\n");
		assert.match(text, /U\+0000/u, "the refusal names what is wrong with the text");
		assert.match(text, /body/u, "…and which field carries it");
		assert.deepEqual(inbox(db, "root"), [], "nothing is stored: the send did not happen");
	} finally {
		db.close();
	}
});

// ---------------------------------------------------------------------------
// 2. Internal notices degrade instead of throwing (or vanishing)
// ---------------------------------------------------------------------------

test("#353 review (major 3): a declared failure whose reason carries a NUL is still mailed to the parent", async () => {
	const rootDir = mkdtempSync(path.join(tmpdir(), "legion-notify-nul-"));
	const db = makeDb({ phase: "implementing", phaseSince: NOW });
	try {
		// The transition and its `phase_change` land BEFORE `notifyParent` runs, so a throw
		// here would report failure for a move that already happened — and drop the notice
		// #309 requires a declaring centurion to send.
		const result = await requestLegionPhase(db, "root.team", "failed", {
			cwd: rootDir,
			reason: `tests cannot even start${NATIVE_NUL} the fixture is missing`,
			now: () => NOW,
			sendSelfMessage() {},
		});

		assert.equal(result.ok, true, "the transition itself must not be undone by the mail path");
		assert.equal(getNode(db, "root.team")?.phase, "failed", "the phase moved");
		assert.ok(
			readEventsAfter(db, 0, { nodeId: "root.team" }).some((event) => event.type === "phase_change"),
			"…and the ledger says so",
		);

		const mail = inbox(db, "root", { delivery: MAIL_DELIVERY.PENDING });
		assert.equal(mail.length, 1, "the parent still hears about the failure: the notice is degraded, never dropped");
		assert.ok(!mail[0]!.body.includes(NATIVE_NUL), "the unrepresentable character is gone from what was stored");
		assert.match(mail[0]!.body, /Team failed by centurion decision: tests cannot even start the fixture is missing/u);
		assert.ok(!mail[0]!.subject.includes(NATIVE_NUL));
	} finally {
		db.close();
		rmSync(rootDir, { recursive: true, force: true });
	}
});

test("#353 review (major 3): a `note` carrying a NUL still reaches the parent, after the phase move", async () => {
	// The second `notifyParent` call site the review named. `reviewing -> planning` is the
	// built-in edge that tells the parent (`notifyParent: true`), and `note` is model-authored
	// text — a real NUL carrier, and the one place a NUL can exist at all: a ledger column
	// would have truncated it on write (`node:sqlite` binds text the same way `#353` describes,
	// so `nodes.phase` cannot even hold one).
	const db = makeDb({ phase: "reviewing", phaseSince: NOW });
	try {
		const result = await requestLegionPhase(db, "root.team", "planning", {
			cwd: tmpdir(),
			note: `back to the drawing board${NATIVE_NUL} the contract was not read`,
			now: () => NOW + 1,
			sendSelfMessage() {},
		});

		assert.equal(result.ok, true, "the transition is accepted on its own terms");
		assert.equal(getNode(db, "root.team")?.phase, "planning");
		const mail = inbox(db, "root", { delivery: MAIL_DELIVERY.PENDING });
		assert.equal(mail.length, 1, "the parent is still notified");
		assert.ok(!mail[0]!.body.includes(NATIVE_NUL), "with the unrepresentable character removed");
		assert.match(mail[0]!.body, /back to the drawing board the contract was not read/u);
	} finally {
		db.close();
	}
});

test("#353 review (major 3): a refused notice leaves the de-dup key unwritten, so the next tick retries", async () => {
	const IMPLEMENTING_MS = 60 * 60_000;
	const timedOutAt = NOW + IMPLEMENTING_MS + 1;
	const db = makeDb({ phase: "implementing", phaseSince: NOW });
	const rootMessages: string[] = [];
	try {
		// One earlier message from this team inside the rate window is enough to refuse the
		// notice at `mailRatePer5Min: 1` — a refusal the ledger understands (`ok: false`),
		// the same shape a corrupt envelope produces on the throw path.
		const prior = sendMail(db, { fromNode: "root.team", to: "parent", subject: "working", body: "still here" }, { now: () => timedOutAt - 60_000 });
		assert.equal(prior.ok, true);
		const settings = { mailRatePer5Min: 1 };

		await tickTeam(db, { now: timedOutAt, settings, rootMessages });
		assert.deepEqual(phaseTimeouts(db), [], "no de-dup key for a notice that was never placed");
		assert.equal(rootMessages.length, 1, "…but the fact is not dropped: root is told instead");
		assert.match(rootMessages[0]!, /^Legion phase timeout:/u);

		// The window moves on, so the same notice has somewhere to go this time.
		const retriedAt = timedOutAt + 5 * 60_000 + 1;
		await tickTeam(db, { now: retriedAt, settings, rootMessages });
		const timeouts = phaseTimeouts(db);
		assert.equal(timeouts.length, 1, "the retried stint is announced exactly once");
		assert.deepEqual(timeouts[0]!.data, {
			phase: "implementing",
			phaseSince: NOW,
			elapsedMs: retriedAt - NOW,
			timeoutMs: IMPLEMENTING_MS,
		});
		const mail = inbox(db, "root", { delivery: MAIL_DELIVERY.PENDING });
		assert.equal(mail.length, 2, "the earlier message plus the retried notice");
		assert.equal(mail.at(-1)!.subject, "Phase timeout: team", "the frozen subject convention is untouched");
		assert.equal(rootMessages.length, 1, "root is not spammed once the mail lands");

		// And the written key still dedupes: one stint, one announcement.
		await tickTeam(db, { now: retriedAt + IMPLEMENTING_MS, settings, rootMessages });
		assert.equal(phaseTimeouts(db).length, 1, "a later tick in the same stint must not re-alarm");
		assert.equal(inbox(db, "root").length, 2);
	} finally {
		db.close();
	}
});
