/**
 * #357 — a team woken by `continue` goes permanently silent on its next timeout.
 *
 * The `Phase timeout:` notice itself was never the bug: at settle time the postman
 * correctly judges it OBSOLETE (#333/#354). The bug is what a revival left behind.
 * `Orchestrator.reserveNode`'s resume branch wrote `status` and nothing else, so a
 * team revived by `subagent({ action: "continue" })` kept the `phase_since` of the
 * stint that had already timed out — and `checkOwnPhaseTimeout` dedupes on exactly
 * that value (`hasPhaseTimeoutForSince`). One `phase_timeout` per stint therefore
 * meant one `phase_timeout` for the life of the team: the second stint could time
 * out again, and nobody would ever be told.
 *
 * The repair (issue option A) is that a revival starts a NEW stint: `phase_since`
 * moves to the revival clock and a `phase_change` (`from === to`, `reason:
 * "revived"`) records why — no new event type, no new mail subject, no change to
 * the `kind: "notice"` accounting.
 *
 * Each test drives the real `Orchestrator.launch` resume path (that is what
 * `continue` calls when the child is not alive) and a real `LegionPostman` tick,
 * then reads the ledger.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { createLegionEventBus } from "../../src/extension/event-bus.ts";
import { LegionPostman } from "../../src/extension/legion-tools.ts";
import { openLegionDb } from "../../src/legion/db.ts";
import { appendEvent, readEventsAfter } from "../../src/legion/events.ts";
import { MAIL_DELIVERY, inbox } from "../../src/legion/mail.ts";
import { getNode, insertNode, updateNode } from "../../src/legion/nodes.ts";
import { Orchestrator } from "../../src/runs/orchestrator.ts";
import { RunStore } from "../../src/runs/store.ts";
import type { AgentConfig } from "../../src/shared/types.ts";
import { FakeSupervisor } from "../helpers/fake-supervisor.ts";

const TEAM_ROLE = "centurion";
const TEAM_NAME = "team";
const TEAM_ID = `root.${TEAM_NAME}`;

/** The stint the team was already in when it timed out the first time. */
const STINT_START = 1_000_000;
/** `implementing`'s built-in advisory clock, so no settings are needed. */
const IMPLEMENTING_TIMEOUT_MS = 60 * 60_000;
const AFTER_FIRST_TIMEOUT = STINT_START + IMPLEMENTING_TIMEOUT_MS + 1;

type Db = ReturnType<typeof openLegionDb>;

function teamCard(): AgentConfig {
	return {
		name: TEAM_ROLE,
		description: "team root under test",
		systemPromptMode: "append",
		inheritProjectContext: true,
		inheritSkills: false,
		kind: "pi",
		systemPrompt: "You are the root of a team.",
		source: "user",
		filePath: `/fake/${TEAM_ROLE}.md`,
	};
}

/**
 * A live team in `implementing`, with the ledger row a resumed launch reads: a
 * session file and a non-terminal phase. A scratch git repo stands in for the
 * checkout a team inherits (a team launch always resolves to worktree isolation).
 */
function fixture() {
	const rootDir = mkdtempSync(path.join(tmpdir(), "legion-revive-stint-"));
	const git = (args: string[]) => execFileSync("git", ["-C", rootDir, ...args], { stdio: "ignore" });
	git(["init", "-q"]);
	git(["config", "user.email", "legion-test@example.invalid"]);
	git(["config", "user.name", "Legion revive fixture"]);
	writeFileSync(path.join(rootDir, "README.md"), "fixture\n");
	git(["add", "README.md"]);
	git(["commit", "-m", "test fixture", "-q"]);
	const runStore = new RunStore({ rootDir: path.join(rootDir, ".pi-subagents") });
	const rootRun = runStore.createRun({ task: "root task", cwd: rootDir, nodeId: "root", maxDepth: 4 });
	const db = openLegionDb(":memory:");
	insertNode(db, { id: "root", parentId: null, name: "root", role: "root", runId: rootRun.runId, status: "running" }, () => STINT_START - 500);
	insertNode(db, {
		parentId: "root",
		name: TEAM_NAME,
		role: TEAM_ROLE,
		status: "running",
		phase: "implementing",
		phaseSince: STINT_START,
		sessionFile: path.join(runStore.runDir(rootRun.runId), `${TEAM_NAME}.session.jsonl`),
	}, () => STINT_START);
	const context = {
		db,
		dbPath: path.join(runStore.runDir(rootRun.runId), "legion.db"),
		nodeId: "root",
		parentNodeId: null,
		parentRunId: null,
		runId: rootRun.runId,
		runStore,
		settings: { maxDepth: 4, maxChildrenPerNode: 8, maxActiveNodes: 30 },
		eventBus: createLegionEventBus(),
	};
	return {
		rootDir,
		runDir: runStore.runDir(rootRun.runId),
		db,
		context,
		cleanup() {
			db.close();
			rmSync(rootDir, { recursive: true, force: true });
		},
	};
}

type Fixture = ReturnType<typeof fixture>;

/** One postman tick for the team itself (the seam that owns `checkOwnPhaseTimeout`). */
async function tickTeam(fx: Fixture, clock: () => number, selfMessages: string[] = []): Promise<void> {
	const postman = new LegionPostman({
		db: fx.db,
		nodeId: TEAM_ID,
		supervisor: new FakeSupervisor(),
		now: clock,
		intervalMs: 10_000,
		sendSelfMessage: (message) => selfMessages.push(message),
	});
	await postman.tick();
	postman.stop();
}

/** One postman tick for the root: this is what actually delivers the notice. */
async function tickRoot(fx: Fixture, clock: () => number, rootMessages: string[]): Promise<void> {
	const postman = new LegionPostman({
		db: fx.db,
		nodeId: "root",
		supervisor: new FakeSupervisor(),
		// The fixture's team is deliberately long-lived relative to these clocks; keep
		// the orphan scan (which also talks to the root) out of the way.
		settings: { orphanStaleMs: Number.MAX_SAFE_INTEGER },
		now: clock,
		intervalMs: 10_000,
		sendRootMessage: (message) => rootMessages.push(message),
	});
	await postman.tick();
	postman.stop();
}

/** `continue` on a child that is no longer alive: relaunch it from its own ledger row. */
async function revive(fx: Fixture, clock: () => number) {
	const supervisor = new FakeSupervisor({ immediateTimeout: false });
	const orchestrator = new Orchestrator({
		supervisor,
		runDir: fx.runDir,
		cwd: fx.rootDir,
		maxDepth: 4,
		legion: fx.context,
		now: clock,
	});
	const handle = await orchestrator.launch({ agent: teamCard(), name: TEAM_NAME, task: "continue: finish the stint", worktree: false });
	return { supervisor, handle };
}

function phaseTimeouts(fx: Fixture) {
	return readEventsAfter(fx.db, 0, { nodeId: TEAM_ID }).filter((event) => event.type === "phase_timeout");
}

function phaseChanges(fx: Fixture) {
	return readEventsAfter(fx.db, 0, { nodeId: TEAM_ID }).filter((event) => event.type === "phase_change");
}

test("#357: a revived team starts a new stint, so its second timeout is announced again", async () => {
	const fx = fixture();
	const rootMessages: string[] = [];
	let revived: Awaited<ReturnType<typeof revive>> | undefined;
	try {
		// 1. The team times out in `implementing` while it is still live.
		await tickTeam(fx, () => AFTER_FIRST_TIMEOUT);
		const first = phaseTimeouts(fx);
		assert.equal(first.length, 1, "the first stint times out exactly once");
		assert.equal((first[0]!.data as { phaseSince: number }).phaseSince, STINT_START);
		const firstNotice = inbox(fx.db, "root", { delivery: MAIL_DELIVERY.PENDING });
		assert.equal(firstNotice.length, 1, "the parent is told about the timeout");
		assert.match(firstNotice[0]!.subject, /^Phase timeout:/u);

		// 2. The team settles. The queued notice is now obsolete and is judged so —
		//    the pre-existing #333/#354 behaviour, unchanged here.
		updateNode(fx.db, TEAM_ID, { status: "settled" }, () => AFTER_FIRST_TIMEOUT + 1);
		await tickRoot(fx, () => AFTER_FIRST_TIMEOUT + 1, rootMessages);
		assert.equal(inbox(fx.db, "root", { delivery: MAIL_DELIVERY.OBSOLETE }).length, 1, "the stale notice went OBSOLETE");
		assert.deepEqual(rootMessages, [], "an obsolete notice is never injected");

		// 3. `continue` revives the team.
		const revivedAt = AFTER_FIRST_TIMEOUT + 10_000;
		revived = await revive(fx, () => revivedAt);
		assert.equal(getNode(fx.db, TEAM_ID)?.phaseSince, revivedAt, "a revival opens a NEW stint");
		assert.equal(getNode(fx.db, TEAM_ID)?.phase, "implementing", "the phase itself is untouched: the work resumes where it was");
		const revival = phaseChanges(fx).find((event) => (event.data as { reason?: string }).reason === "revived");
		assert.ok(revival, "the revive is recorded as a phase_change, not silently");
		const revivalData = revival.data as { from: string; to: string; reason?: string };
		assert.equal(revivalData.from, "implementing", "from === to: the phase did not move, the stint did");
		assert.equal(revivalData.to, "implementing");
		assert.equal(revivalData.reason, "revived");

		// 4. The new stint times out too. THIS is the bug: before the repair the
		//    dedup key was still STINT_START, `hasPhaseTimeoutForSince` answered
		//    "already reported", and no event or notice was ever produced again.
		const afterSecondTimeout = revivedAt + IMPLEMENTING_TIMEOUT_MS + 1;
		await tickTeam(fx, () => afterSecondTimeout);
		const second = phaseTimeouts(fx);
		assert.equal(second.length, 2, "the revived stint must be able to time out on its own");
		assert.equal((second[1]!.data as { phaseSince: number }).phaseSince, revivedAt, "…under the new stint's key");
		assert.equal(
			inbox(fx.db, "root").length,
			2,
			"a second notice was queued; without the repair this list never grew past one",
		);

		// 5. …and it is deliverable: the revived stint is current, so the notice is
		//    not obsolete and reaches the parent.
		await tickRoot(fx, () => afterSecondTimeout, rootMessages);
		assert.equal(rootMessages.length, 1, "the parent hears about the second timeout");
		assert.match(rootMessages[0]!, /^\[legion mail #\d+\]/u);
		assert.match(rootMessages[0]!, /Phase timeout/u);
		assert.equal(inbox(fx.db, "root", { delivery: MAIL_DELIVERY.ACCEPTED }).length, 1);
	} finally {
		if (revived) await revived.supervisor.retire(revived.handle.name).catch(() => {});
		fx.cleanup();
	}
});

test("#357 control: without a revival the same stint still warns only once", async () => {
	const fx = fixture();
	const rootMessages: string[] = [];
	try {
		// Two ticks, both long past the advisory clock, one uninterrupted stint.
		await tickTeam(fx, () => AFTER_FIRST_TIMEOUT);
		await tickTeam(fx, () => AFTER_FIRST_TIMEOUT + IMPLEMENTING_TIMEOUT_MS);
		assert.equal(phaseTimeouts(fx).length, 1, "re-ticking the same stint must not re-alarm");
		assert.equal(inbox(fx.db, "root").length, 1, "…nor queue a second notice");
		await tickRoot(fx, () => AFTER_FIRST_TIMEOUT + IMPLEMENTING_TIMEOUT_MS, rootMessages);
		assert.equal(rootMessages.length, 1, "the single live notice is delivered once");
	} finally {
		fx.cleanup();
	}
});

test("#357: a revival that cannot move the clock re-arms nothing — the dedup key is still phase_since", async () => {
	const fx = fixture();
	const rootMessages: string[] = [];
	let revived: Awaited<ReturnType<typeof revive>> | undefined;
	try {
		await tickTeam(fx, () => AFTER_FIRST_TIMEOUT);
		assert.equal(phaseTimeouts(fx).length, 1);
		// Revive on the SAME clock reading as the stint that already fired (a resume in
		// the same millisecond, or a coarse test clock). `phase_since` therefore does
		// not move, and `hasPhaseTimeoutForSince` must keep answering "already said".
		revived = await revive(fx, () => STINT_START);
		assert.equal(getNode(fx.db, TEAM_ID)?.phaseSince, STINT_START);
		await tickTeam(fx, () => AFTER_FIRST_TIMEOUT + IMPLEMENTING_TIMEOUT_MS * 2);
		assert.equal(
			phaseTimeouts(fx).length,
			1,
			"the same phase_since is one stint: revival alone must not duplicate the warning",
		);
		assert.equal(inbox(fx.db, "root").length, 1);
		await tickRoot(fx, () => AFTER_FIRST_TIMEOUT + IMPLEMENTING_TIMEOUT_MS * 2, rootMessages);
		assert.equal(rootMessages.length, 1);
	} finally {
		if (revived) await revived.supervisor.retire(revived.handle.name).catch(() => {});
		fx.cleanup();
	}
});

test("#357: a non-team node resume is untouched — no phase, no phase_change, no phase_since", async () => {
	const fx = fixture();
	const db: Db = fx.db;
	let revived: Awaited<ReturnType<typeof revive>> | undefined;
	const workerSupervisor = new FakeSupervisor({ immediateTimeout: false });
	try {
		insertNode(db, {
			parentId: "root",
			name: "worker",
			role: "worker",
			status: "settled",
			sessionFile: path.join(fx.runDir, "worker.session.jsonl"),
		}, () => STINT_START);
		// A `phase_timeout` row of this worker's own must not be confused with the team's.
		appendEvent(db, "root.worker", "phase_timeout", { phase: "implementing", phaseSince: STINT_START }, { now: () => STINT_START });
		const orchestrator = new Orchestrator({
			supervisor: workerSupervisor,
			runDir: fx.runDir,
			cwd: fx.rootDir,
			maxDepth: 4,
			legion: fx.context,
			now: () => AFTER_FIRST_TIMEOUT,
		});
		const handle = await orchestrator.launch({ agent: { ...teamCard(), name: "worker" }, name: "worker", task: "continue", worktree: false });
		revived = { supervisor: workerSupervisor, handle };
		const worker = getNode(db, "root.worker");
		assert.equal(worker?.phase, null, "a worker has no phase");
		assert.equal(worker?.phaseSince, null, "so a resume must not invent a stint for it");
		assert.deepEqual(
			readEventsAfter(db, 0, { nodeId: "root.worker" }).filter((event) => event.type === "phase_change"),
			[],
			"no phase_change is written for a node that has no phase",
		);
	} finally {
		if (revived) await revived.supervisor.retire(revived.handle.name).catch(() => {});
		fx.cleanup();
	}
});
