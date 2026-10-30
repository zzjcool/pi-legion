import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createLegionEventBus } from "../../src/extension/event-bus.ts";
import {
	LegionPostman,
	parseLegionVerifyCommands,
	readTree,
	registerLegionTools,
	requestLegionPhase,
	runVerification,
	type LegionCommandRunner,
} from "../../src/extension/legion-tools.ts";
import { openLegionDb } from "../../src/legion/db.ts";
import { appendEvent, readEventsAfter } from "../../src/legion/events.ts";
import { MAIL_DELIVERY, formatMail, inbox, pendingInbox, sendMail, transitionDelivery } from "../../src/legion/mail.ts";
import { getNode, insertNode, listStaleNodes, updateNode } from "../../src/legion/nodes.ts";
import { getUsage } from "../../src/legion/usage.ts";
import { FakeSupervisor } from "../helpers/fake-supervisor.ts";
import type { AgentConfig } from "../../src/shared/types.ts";

function agent(name: string): AgentConfig {
	return {
		name,
		description: `${name} test role`,
		systemPromptMode: "append",
		inheritProjectContext: true,
		inheritSkills: false,
		kind: "pi",
		systemPrompt: `You are ${name}.`,
		source: "user",
		filePath: `/fake/${name}.md`,
	};
}

function makeTools(db: ReturnType<typeof openLegionDb>, nodeId: string, role: string, extras: Record<string, unknown> = {}) {
	const tools = new Map<string, { execute: (id: string, params: Record<string, unknown>) => Promise<{ content?: Array<{ text?: string }>; details?: unknown }> }>();
	const pi = {
		registerTool(tool: unknown) {
			const typed = tool as { name: string; execute: (id: string, params: Record<string, unknown>) => Promise<{ content?: Array<{ text?: string }>; details?: unknown }> };
			tools.set(typed.name, typed);
		},
	};
	registerLegionTools(pi as unknown as ExtensionAPI, { db, nodeId, role, cwd: process.cwd(), ...extras });
	return tools;
}

function toolText(result: { content?: Array<{ text?: string }> }): string {
	return (result.content ?? []).map((item) => item.text ?? "").join("\n");
}

function session(text: string): string {
	const messages = [
		{ type: "session", id: "legion-tools-test", cwd: "/tmp/project", created: "2026-01-01T00:00:00.000Z" },
		{ type: "message", message: { role: "user", content: "review" } },
		{ type: "message", message: { role: "assistant", content: [{ type: "text", text }], stopReason: "stop", usage: { input: 4, output: 2, cacheRead: 0, cacheWrite: 0, cost: { total: 0.001 } } } },
	];
	return `${messages.map((line) => JSON.stringify(line)).join("\n")}\n`;
}

/** A session whose user turns are exactly the given strings, one turn each. */
function userSession(texts: readonly string[]): string {
	const lines = texts.map((text) =>
		JSON.stringify({ type: "message", message: { role: "user", content: text } }),
	);
	return `${lines.join("\n")}\n`;
}

function makePhaseFixture() {
	const db = openLegionDb(":memory:");
	insertNode(db, { parentId: null, name: "root", role: "root", status: "running" }, () => 10);
	insertNode(db, { parentId: "root", name: "team-a", role: "centurion", status: "running", phase: "planning", phaseSince: 10, taskSummary: "team task" }, () => 10);
	return db;
}

test("Legion tools expose mail/tree to every node and phase only to centurions", async () => {
	const db = openLegionDb(":memory:");
	try {
		insertNode(db, { parentId: null, name: "root", role: "root" });
		insertNode(db, { parentId: "root", name: "team-a", role: "centurion" });
		insertNode(db, { parentId: "root", name: "team-b", role: "centurion" });
		insertNode(db, { parentId: "root.team-a", name: "worker", role: "worker" });
		insertNode(db, { parentId: "root.team-a", name: "reviewer", role: "reviewer" });
		insertNode(db, { parentId: "root.team-b", name: "other", role: "worker" });
		const centurionTools = makeTools(db, "root.team-a", "centurion");
		const workerTools = makeTools(db, "root.team-a.worker", "worker");
		assert.deepEqual([...centurionTools.keys()], ["legion_mail", "legion_tree", "legion_phase"]);
		assert.deepEqual([...workerTools.keys()], ["legion_mail", "legion_tree"]);

		const mail = await centurionTools.get("legion_mail")!.execute("mail-1", {
			to: "children", subject: "implementation scope", body: "See .pi-legion/contract.md.", kind: "notice", urgency: "info",
		});
		assert.match(toolText(mail), /Queued 2 legion mail/);
		assert.equal(pendingInbox(db, "root.team-a.worker").length, 1);
		assert.equal(pendingInbox(db, "root.team-a.reviewer").length, 1);
		const forbidden = await workerTools.get("legion_mail")!.execute("mail-2", {
			to: "root.team-b.other", subject: "cross-subtree", body: "must route through manager",
		});
		assert.match(toolText(forbidden), /across subtrees/);
		assert.match(toolText(forbidden), /routing:/);
		const tree = await workerTools.get("legion_tree")!.execute("tree-1", { scope: "squad" });
		assert.match(toolText(tree), /root\.team-a\.worker/);
		assert.doesNotMatch(toolText(tree), /root\.team-b/);
		assert.deepEqual(readTree(db, "root.team-a", "children").map((node) => node.name).sort(), ["reviewer", "worker"]);
	} finally {
		db.close();
	}
});

test("centurion phase tool enforces gates, rework, verification, and automatic DONE", async () => {
	const rootDir = mkdtempSync(path.join(tmpdir(), "legion-phase-tool-"));
	const cwd = path.join(rootDir, "repo");
	mkdirSync(path.join(cwd, ".pi-legion"), { recursive: true });
	writeFileSync(path.join(cwd, ".pi-legion", "contract.md"), [
		"# Contract",
		"Goal: exercise the verifier.",
		"```legion-verify",
		"# comment is ignored",
		"npm test",
		"```",
		"",
	].join("\n"));
	const db = makePhaseFixture();
	const reviewerSession = path.join(rootDir, "reviewer.jsonl");
	const commands: Array<{ command: string; commandCwd: string; timeout: number }> = [];
	const messages: string[] = [];
	const runCommand: LegionCommandRunner = async (command, commandCwd, timeout) => {
		commands.push({ command, commandCwd, timeout });
		return { code: 0, stdout: "unit tests green", stderr: "" };
	};
	try {
		writeFileSync(reviewerSession, session('{"ok":false,"reason":"major finding"}'));
		const events = createLegionEventBus();
		const options = { cwd, runDir: rootDir, now: () => 100, eventBus: events, runCommand, sendSelfMessage: (text: string) => messages.push(text), settings: { verifyCommandTimeoutMs: 1234 } };
		const toImplementing = await requestLegionPhase(db, "root.team-a", "implementing", options);
		assert.equal(toImplementing.ok, true);
		assert.equal(getNode(db, "root.team-a")?.contractPath, path.join(cwd, ".pi-legion", "contract.md"));

		const worker = insertNode(db, { parentId: "root.team-a", name: "worker", role: "worker", status: "running" }, () => 101);
		const premature = await requestLegionPhase(db, "root.team-a", "reviewing", options);
		assert.equal(premature.ok, false);
		// #298: the rule no longer names a role, so the message describes what is
		// missing instead of who was supposed to provide it.
		assert.match(premature.message, /still running|settle/i);
		assert.equal(getNode(db, "root.team-a")?.phase, "implementing");

		updateNode(db, worker.id, { status: "settled" }, () => 102);
		insertNode(db, { parentId: "root.team-a", name: "reviewer", role: "reviewer", status: "settled", sessionFile: reviewerSession }, () => 103);
		assert.equal((await requestLegionPhase(db, "root.team-a", "reviewing", options)).ok, true);
		const rework = await requestLegionPhase(db, "root.team-a", "implementing", options);
		assert.equal(rework.ok, true);
		assert.equal(getNode(db, "root.team-a")?.reworkCount, 1);

		const retryReviewerSession = path.join(rootDir, "reviewer-retry.jsonl");
		writeFileSync(retryReviewerSession, session('{"ok":true,"reason":"fixed"}'));
		assert.equal((await requestLegionPhase(db, "root.team-a", "reviewing", options)).ok, true);
		insertNode(db, { parentId: "root.team-a", name: "reviewer-retry", role: "reviewer", status: "settled", sessionFile: retryReviewerSession }, () => 104);
		const verifying = await requestLegionPhase(db, "root.team-a", "verifying", options);
		assert.equal(verifying.ok, true);
		assert.equal(verifying.phase, "done");
		assert.deepEqual(commands, [{ command: "npm test", commandCwd: cwd, timeout: 1234 }]);
		assert.equal(getNode(db, "root.team-a")?.phase, "done");
		assert.equal(getNode(db, "root.team-a")?.reworkCount, 1);
		assert.ok(messages.some((message) => /squash/.test(message)));
		assert.ok(readEventsAfter(db, 0).some((event) => event.type === "phase_change" && (event.data as { to?: string } | null)?.to === "done"));
	} finally {
		db.close();
		rmSync(rootDir, { recursive: true, force: true });
	}
});

test("phase rework beyond the frozen limit forces failed and notifies the parent", async () => {
	const db = openLegionDb(":memory:");
	const rootDir = mkdtempSync(path.join(tmpdir(), "legion-rework-limit-"));
	const reviewerSession = path.join(rootDir, "reviewer.jsonl");
	try {
		insertNode(db, { parentId: null, name: "root", role: "root" });
		insertNode(db, { parentId: "root", name: "team", role: "centurion", phase: "reviewing", reworkCount: 2 });
		writeFileSync(reviewerSession, session('{"ok":false,"reason":"still broken"}'));
		insertNode(db, { parentId: "root.team", name: "reviewer", role: "reviewer", status: "settled", sessionFile: reviewerSession });
		const result = await requestLegionPhase(db, "root.team", "implementing", {
			cwd: rootDir,
			now: () => 500,
			sendSelfMessage() {},
		});
		assert.equal(result.ok, false);
		assert.match(result.message, /exceeds limit 2/);
		assert.equal(getNode(db, "root.team")?.phase, "failed");
		assert.equal(getNode(db, "root.team")?.reworkCount, 3);
		const parentMail = inbox(db, "root", { delivery: MAIL_DELIVERY.PENDING });
		assert.equal(parentMail.length, 1, "rework exhaustion must queue a notice for the parent");
		assert.match(parentMail[0]?.body ?? "", /exceeds limit 2/);
	} finally {
		db.close();
		rmSync(rootDir, { recursive: true, force: true });
	}
});

test("verification parser, command timeout runner seam, and persisted result preserve the task summary", async () => {
	const rootDir = mkdtempSync(path.join(tmpdir(), "legion-verification-"));
	const db = openLegionDb(":memory:");
	try {
		insertNode(db, { parentId: null, name: "root", role: "root" });
		const team = insertNode(db, { parentId: "root", name: "team", role: "centurion", taskSummary: "original task" });
		assert.deepEqual(parseLegionVerifyCommands("```legion-verify\n# ignored\nnpm test\nprintf ok\n```"), ["npm test", "printf ok"]);
		const calls: string[] = [];
		const result = await runVerification(db, team, "```legion-verify\nnpm test\n```", {
			cwd: rootDir,
			runDir: path.join(rootDir, "run"),
			now: () => 900,
			settings: { verifyCommandTimeoutMs: 80 },
			runCommand: async (command, cwd, timeout) => {
				calls.push(`${command}|${cwd}|${timeout}`);
				return { code: 0, stdout: "green", stderr: "" };
			},
		});
		assert.equal(result.passed, true);
		assert.deepEqual(calls, [`npm test|${rootDir}|80`]);
		const metadata = JSON.parse(getNode(db, team.id)?.taskSummary ?? "{}") as { __piLegion?: { taskSummary?: string } };
		assert.equal(metadata.__piLegion?.taskSummary, "original task", "verification metadata must preserve the task summary");
		assert.equal(readFileSync(result.outputFile, "utf8").includes("exit: 0"), true);
	} finally {
		db.close();
		rmSync(rootDir, { recursive: true, force: true });
	}
});

test("root orphan scan ignores normally retired nodes and live squads but reports a stale running orphan", async () => {
	const rootDir = mkdtempSync(path.join(tmpdir(), "legion-orphan-scan-"));
	const db = openLegionDb(":memory:");
	const supervisor = new FakeSupervisor();
	const messages: string[] = [];
	const now = 10_000;
	try {
		insertNode(db, { parentId: null, name: "root", role: "root", status: "running" }, () => 1);
		const retired = insertNode(db, { parentId: "root", name: "retired-child", role: "worker", status: "retired" }, () => 1);
		const orphan = insertNode(db, { parentId: "root", name: "lost-child", role: "worker", status: "running" }, () => 1);
		const liveSquad = insertNode(db, { parentId: "root", name: "live-squad", role: "centurion", status: "running" }, () => 1);
		const hostedStaleChild = insertNode(db, { parentId: liveSquad.id, name: "hosted-child", role: "worker", status: "running" }, () => 1);
		const sessionFile = path.join(rootDir, "live-squad.jsonl");
		await supervisor.spawnChild({ name: liveSquad.name, task: "active host", agent: agent("centurion"), sessionFile, tempDir: rootDir, cwd: rootDir });
		const postman = new LegionPostman({
			db, nodeId: "root", supervisor, settings: { orphanStaleMs: 100 },
			now: () => now, sendRootMessage: (message) => messages.push(message), intervalMs: 10_000,
		});
		await postman.tick();
		const orphanEvents = readEventsAfter(db, 0).filter((event) => event.type === "orphan_detected");
		assert.deepEqual(orphanEvents.map((event) => event.nodeId), [orphan.id]);
		assert.equal(messages.some((message) => message.includes(retired.id)), false);
		assert.equal(messages.some((message) => message.includes(hostedStaleChild.id)), false, "an active host supervisor prevents a nested orphan report");
		assert.equal(messages.some((message) => message.includes(orphan.id)), true);
		postman.stop();
	} finally {
		await supervisor.retire("live-squad").catch(() => {});
		db.close();
		rmSync(rootDir, { recursive: true, force: true });
	}
});

test("postman injects active/retired-recipient mail, bounces terminal mail, and records usage", async () => {
	const rootDir = mkdtempSync(path.join(tmpdir(), "legion-postman-"));
	const db = openLegionDb(":memory:");
	const supervisor = new FakeSupervisor({ usage: { tokensIn: 31, tokensOut: 12, costUsd: 0.04 } });
	const sessionFile = path.join(rootDir, "active.jsonl");
	mkdirSync(rootDir, { recursive: true });
	let now = 10;
	try {
		insertNode(db, { parentId: null, name: "root", role: "root", status: "running" }, () => 1);
		insertNode(db, { parentId: "root", name: "team", role: "centurion", status: "running" }, () => 2);
		const active = insertNode(db, { parentId: "root.team", name: "active", role: "worker", status: "running", sessionFile }, () => 3);
		const retired = insertNode(db, { parentId: "root.team", name: "retired", role: "worker", status: "retired", sessionFile: path.join(rootDir, "retired.jsonl") }, () => 4);
		const terminal = insertNode(db, { parentId: "root.team", name: "failed", role: "worker", status: "failed" }, () => 5);
		await supervisor.spawnChild({ name: active.name, task: "active", agent: agent("worker"), sessionFile, tempDir: rootDir, cwd: rootDir });
		const eventBus = createLegionEventBus();
		const received: string[] = [];
		const orphanUnsubscribe = eventBus.on("orphan_detected", (event) => received.push(event.nodeId));
		const resumed: string[] = [];
		const activeMail = sendMail(db, { fromNode: "root.team", to: "active", subject: "do now", body: "work", urgency: "action-needed" }, { now: () => now });
		const retiredMail = sendMail(db, { fromNode: "root.team", to: "retired", subject: "wake", body: "continue" }, { now: () => now + 1 });
		const terminalMail = sendMail(db, { fromNode: "root.team", to: "failed", subject: "cannot deliver", body: "terminal" }, { now: () => now + 2 });
		assert.equal(activeMail.ok && retiredMail.ok && terminalMail.ok, true);
		const postman = new LegionPostman({
			db,
			nodeId: "root.team",
			supervisor,
			settings: { usagePollMs: 1 },
			eventBus,
			now: () => now,
			resumeChild: async (node) => { resumed.push(node.id); },
			intervalMs: 10_000,
		});
		await postman.tick();
		assert.ok(supervisor.calls.some((call) => call.method === "steer" && call.name === active.name));
		assert.deepEqual(resumed, [retired.id]);
		assert.equal(inbox(db, terminal.id, { delivery: MAIL_DELIVERY.BOUNCED }).length, 1);
		assert.equal(pendingInbox(db, active.id).length, 0);
		assert.deepEqual(getUsage(db, active.id), { nodeId: active.id, tokensIn: 31, tokensOut: 12, costUsd: 0.04, updatedAt: now });
		assert.equal(getNode(db, active.id)?.updatedAt, now);

		// The root poller reports a stale, unsupervised squad to the CEO.
		db.prepare("UPDATE nodes SET updated_at = 1 WHERE id = ?").run("root.team");
		now = 200_000;
		const rootPostman = new LegionPostman({
			db,
			nodeId: "root",
			supervisor,
			settings: { orphanStaleMs: 100 },
			eventBus,
			now: () => now,
			sendRootMessage: (message) => received.push(message),
			intervalMs: 10_000,
		});
		await rootPostman.tick();
		assert.ok(received.some((entry) => entry.includes("Legion orphan detected") && entry.includes(": root.team")));
		// The notice carries its detection time so a delayed delivery cannot be
		// mistaken for a fresh detection (#227 follow-up).
		assert.ok(
			received.some((entry) => entry.startsWith("Legion orphan detected at ") && entry.includes(new Date(now).toISOString())),
			"the orphan notice stamps when the scan ran, not just how stale the node was",
		);
		assert.ok(readEventsAfter(db, 0).some((event) => event.nodeId === "root.team" && event.type === "orphan_detected"));
		orphanUnsubscribe();
		postman.stop();
		rootPostman.stop();
	} finally {
		db.close();
		rmSync(rootDir, { recursive: true, force: true });
	}
});

test("an intercepted steer-mail bounces with a reason instead of claiming acceptance (#322)", async () => {
	const rootDir = mkdtempSync(path.join(tmpdir(), "legion-postman-intercepted-"));
	const db = openLegionDb(":memory:");
	const supervisor = new FakeSupervisor();
	const sessionFile = path.join(rootDir, "active.jsonl");
	mkdirSync(rootDir, { recursive: true });
	const now = 10;
	const warnings: string[] = [];
	const originalWarn = console.warn;
	try {
		insertNode(db, { parentId: null, name: "root", role: "root", status: "running" }, () => 1);
		insertNode(db, { parentId: "root", name: "team", role: "centurion", status: "running" }, () => 2);
		const active = insertNode(db, { parentId: "root.team", name: "active", role: "worker", status: "running", sessionFile }, () => 3);
		await supervisor.spawnChild({ name: active.name, task: "active", agent: agent("worker"), sessionFile, tempDir: rootDir, cwd: rootDir });
		// The child's input handler swallows the mail: it is never queued.
		supervisor.steerDisposition = "intercepted";
		const mail = sendMail(db, { fromNode: "root.team", to: "active", subject: "do now", body: "work", urgency: "action-needed" }, { now: () => now });
		assert.equal(mail.ok, true);
		if (!mail.ok) return;
		const messageId = mail.messages[0]!.id;
		// #338 minor 1: an intercepted send is not a steer, so it emits no
		// `node_steered` — the observable signal consumers get is the bounce.
		const eventBus = createLegionEventBus();
		const busBounces: Array<{ messageId?: number; reason?: string }> = [];
		const busSteers: string[] = [];
		eventBus.on("mail_bounced", (event) => busBounces.push(event.data as { messageId?: number; reason?: string }));
		eventBus.on("node_steered", (event) => busSteers.push(event.nodeId));
		const postman = new LegionPostman({
			db,
			nodeId: "root.team",
			supervisor,
			settings: { usagePollMs: 1 },
			eventBus,
			now: () => now,
			intervalMs: 10_000,
		});
		console.warn = (message?: unknown) => { warnings.push(String(message)); };
		await postman.tick();
		postman.stop();

		// The child never saw the text and no retry exists, so the ledger says so
		// (#322): bounced, not accepted — and the state itself carries the news, which
		// is why the old console.warn is gone.
		assert.equal(inbox(db, active.id, { delivery: MAIL_DELIVERY.ACCEPTED }).length, 0, "an intercepted send is not ACCEPTED");
		assert.equal(inbox(db, active.id, { delivery: MAIL_DELIVERY.BOUNCED }).length, 1);
		assert.equal(pendingInbox(db, active.id).length, 0, "a bounce promises no retry");
		assert.deepEqual(warnings, [], "the state now tells the truth; no side-channel warning is needed");
		const bounced = readEventsAfter(db, 0).filter((event) => event.type === "mail_bounced");
		assert.equal(bounced.length, 1);
		assert.equal(
			(bounced[0]!.data as { messageId?: number; reason?: string }).messageId,
			messageId,
			"the sender gets a mail_bounced event naming the message",
		);
		assert.equal(
			(bounced[0]!.data as { reason?: string }).reason,
			"intercepted_by_input_handler",
			"#322 D2: the reason distinguishes a swallowed send from a terminal recipient",
		);
		assert.equal(
			readEventsAfter(db, 0).filter((event) => event.type === "mail_delivered").length,
			0,
			"nothing was delivered, so nothing claims to be",
		);
		assert.deepEqual(busSteers, [], "an intercepted text was never steered: no node_steered may claim otherwise");
		assert.deepEqual(busBounces, [{ messageId, toNode: active.id, reason: "intercepted_by_input_handler" }], "the bounce is the signal the bus carries instead");
	} finally {
		console.warn = originalWarn;
		db.close();
		rmSync(rootDir, { recursive: true, force: true });
	}
});

test("an intercepted action-needed mail must not flip a blocked node to running (#323 3)", async () => {
	const rootDir = mkdtempSync(path.join(tmpdir(), "legion-postman-blocked-"));
	const db = openLegionDb(":memory:");
	const supervisor = new FakeSupervisor();
	const sessionFile = path.join(rootDir, "blocked.jsonl");
	mkdirSync(rootDir, { recursive: true });
	const now = 10;
	try {
		insertNode(db, { parentId: null, name: "root", role: "root", status: "running" }, () => 1);
		const blocked = insertNode(db, { parentId: "root", name: "stuck", role: "worker", status: "blocked", sessionFile }, () => 2);
		await supervisor.spawnChild({ name: blocked.name, task: "blocked", agent: agent("worker"), sessionFile, tempDir: rootDir, cwd: rootDir });
		const postman = new LegionPostman({
			db,
			nodeId: "root",
			supervisor,
			settings: { usagePollMs: 1 },
			now: () => now,
			intervalMs: 10_000,
		});

		// The wake-up message is swallowed by an input handler: nothing landed, so
		// "running" would claim an unblock that never happened. #338 makes that send
		// BOUNCED and returns before the unblock; this pins the consequence on the node.
		supervisor.steerDisposition = "intercepted";
		sendMail(db, { fromNode: "root", to: "stuck", subject: "unblock", body: "go", urgency: "action-needed" }, { now: () => now });
		await postman.tick();
		assert.equal(getNode(db, blocked.id)?.status, "blocked", "an intercepted send must not report the node as unblocked");

		// Positive control: a send that did land still unblocks, exactly as before.
		supervisor.steerDisposition = "queued";
		sendMail(db, { fromNode: "root", to: "stuck", subject: "unblock 2", body: "go", urgency: "action-needed" }, { now: () => now });
		await postman.tick();
		postman.stop();
		assert.equal(getNode(db, blocked.id)?.status, "running", "a landed action-needed mail still unblocks");
	} finally {
		db.close();
		rmSync(rootDir, { recursive: true, force: true });
	}
});

test("queued, accepted, and prompted sends all settle on ACCEPTED — never on DELIVERED (#322)", async () => {
	const rootDir = mkdtempSync(path.join(tmpdir(), "legion-postman-accepted-"));
	const db = openLegionDb(":memory:");
	const supervisor = new FakeSupervisor();
	mkdirSync(rootDir, { recursive: true });
	const now = 10;
	try {
		insertNode(db, { parentId: null, name: "root", role: "root", status: "running" }, () => 1);
		insertNode(db, { parentId: "root", name: "team", role: "centurion", status: "running" }, () => 2);
		const busy = insertNode(db, { parentId: "root.team", name: "busy", role: "worker", status: "running", sessionFile: path.join(rootDir, "busy.jsonl") }, () => 3);
		const idler = insertNode(db, { parentId: "root.team", name: "idler", role: "worker", status: "settled", sessionFile: path.join(rootDir, "idler.jsonl") }, () => 4);
		await supervisor.spawnChild({ name: busy.name, task: "busy", agent: agent("worker"), sessionFile: busy.sessionFile!, tempDir: rootDir, cwd: rootDir });
		await supervisor.spawnChild({ name: idler.name, task: "idle", agent: agent("worker"), sessionFile: idler.sessionFile!, tempDir: rootDir, cwd: rootDir });
		// `queued` is the steer answer while the child is mid-tool-batch: accepted for
		// pickup at its next turn boundary, and nothing more can be claimed.
		supervisor.steerDisposition = "queued";
		assert.equal(sendMail(db, { fromNode: "root.team", to: "busy", subject: "steer", body: "one", urgency: "action-needed" }, { now: () => now }).ok, true);
		// An `info` send takes `followUp` — still no delivery evidence either.
		assert.equal(sendMail(db, { fromNode: "root.team", to: "busy", subject: "follow up", body: "two", urgency: "info" }, { now: () => now }).ok, true);
		// A settled-but-alive recipient goes through `prompt`, which returns void: the
		// backend cannot even distinguish queued from accepted, so ACCEPTED is its ceiling.
		assert.equal(sendMail(db, { fromNode: "root.team", to: "idler", subject: "wake", body: "three", urgency: "action-needed" }, { now: () => now }).ok, true);
		const postman = new LegionPostman({ db, nodeId: "root.team", supervisor, now: () => now, intervalMs: 10_000 });
		await postman.tick();
		postman.stop();

		assert.equal(inbox(db, busy.id, { delivery: MAIL_DELIVERY.ACCEPTED }).length, 2, "queued and followUp are ACCEPTED");
		assert.equal(inbox(db, idler.id, { delivery: MAIL_DELIVERY.ACCEPTED }).length, 1, "a void prompt is ACCEPTED at best");
		assert.equal(inbox(db, busy.id, { delivery: MAIL_DELIVERY.DELIVERED }).length + inbox(db, idler.id, { delivery: MAIL_DELIVERY.DELIVERED }).length, 0);
		assert.equal(pendingInbox(db, busy.id).length + pendingInbox(db, idler.id).length, 0, "a returned send is never retried");
		assert.equal(readEventsAfter(db, 0).filter((event) => event.type === "mail_sent").length, 3);
		assert.equal(readEventsAfter(db, 0).filter((event) => event.type === "mail_delivered").length, 0, "no send path may invent delivery");
	} finally {
		db.close();
		rmSync(rootDir, { recursive: true, force: true });
	}
});

test("ACCEPTED mail is promoted to DELIVERED only on an exact session-text match (#322)", async () => {
	const rootDir = mkdtempSync(path.join(tmpdir(), "legion-postman-delivered-"));
	const db = openLegionDb(":memory:");
	const supervisor = new FakeSupervisor();
	mkdirSync(rootDir, { recursive: true });
	const exactSession = path.join(rootDir, "exact.jsonl");
	const nearSession = path.join(rootDir, "near.jsonl");
	const now = 10;
	try {
		insertNode(db, { parentId: null, name: "root", role: "root", status: "running" }, () => 1);
		insertNode(db, { parentId: "root", name: "team", role: "centurion", status: "running" }, () => 2);
		const exact = insertNode(db, { parentId: "root.team", name: "exact", role: "worker", status: "running", sessionFile: exactSession }, () => 3);
		const near = insertNode(db, { parentId: "root.team", name: "near", role: "worker", status: "running", sessionFile: nearSession }, () => 4);
		const exactMail = sendMail(db, { fromNode: "root.team", to: "exact", subject: "scope", body: "implement the parser" }, { now: () => now });
		const nearMail = sendMail(db, { fromNode: "root.team", to: "near", subject: "scope", body: "implement the lexer" }, { now: () => now });
		assert.equal(exactMail.ok && nearMail.ok, true);
		if (!exactMail.ok || !nearMail.ok) return;
		const exactMessage = exactMail.messages[0]!;
		const nearMessage = nearMail.messages[0]!;
		// Both sends already returned: ACCEPTED, and now the children have session turns.
		transitionDelivery(db, exactMessage.id, MAIL_DELIVERY.ACCEPTED, () => now);
		transitionDelivery(db, nearMessage.id, MAIL_DELIVERY.ACCEPTED, () => now);
		// Exact: the user turn is byte-for-byte the envelope the postman injects.
		writeFileSync(exactSession, userSession([formatMail(exactMessage)]));
		// Near: the body shows up inside a longer user turn (a child quoting mail back).
		// A containment test would call this delivered; the frozen criterion must not.
		writeFileSync(nearSession, userSession([`please continue: ${nearMessage.body} (quoted from mail #${nearMessage.id})`]));
		const postman = new LegionPostman({ db, nodeId: "root.team", supervisor, now: () => now, intervalMs: 10_000 });
		await postman.tick();
		// Idempotency: a second confirmation pass must not rewrite state or duplicate events.
		await postman.tick();
		postman.stop();

		assert.equal(inbox(db, exact.id, { delivery: MAIL_DELIVERY.DELIVERED }).length, 1, "an exact user turn proves delivery");
		assert.equal(inbox(db, near.id, { delivery: MAIL_DELIVERY.ACCEPTED }).length, 1, "a substring is not proof of delivery");
		assert.equal(inbox(db, near.id, { delivery: MAIL_DELIVERY.DELIVERED }).length, 0);
		const delivered = readEventsAfter(db, 0).filter((event) => event.type === "mail_delivered");
		assert.equal(delivered.length, 1, "two ticks write exactly one mail_delivered event");
		assert.equal((delivered[0]!.data as { messageId?: number }).messageId, exactMessage.id);
	} finally {
		db.close();
		rmSync(rootDir, { recursive: true, force: true });
	}
});

test("a phase-timeout notice is still delivered while its phase is current (#333)", async () => {
	const db = openLegionDb(":memory:");
	const supervisor = new FakeSupervisor();
	const rootMessages: string[] = [];
	const now = 1001;
	try {
		insertNode(db, { parentId: null, name: "root", role: "root", status: "running" }, () => 1);
		insertNode(db, { parentId: "root", name: "team", role: "centurion", status: "running", phase: "reviewing", phaseSince: 100 }, () => 2);
		appendEvent(db, "root.team", "phase_timeout", { phase: "reviewing", phaseSince: 100, elapsedMs: 1_800_573, timeoutMs: 1_800_000 }, { now: () => 1000 });
		assert.equal(sendMail(db, {
			fromNode: "root.team", to: "parent", subject: "Phase timeout: team", kind: "notice", urgency: "action-needed",
			body: "Legion phase timeout: root.team has been in reviewing for 1800573ms (limit 1800000ms). Work was not killed; decide whether to extend or abort.",
		}, { now: () => 1000 }).ok, true);
		const postman = new LegionPostman({ db, nodeId: "root", supervisor, now: () => now, sendRootMessage: (message) => rootMessages.push(message), intervalMs: 10_000 });
		await postman.tick();
		postman.stop();

		assert.equal(rootMessages.length, 1, "a live phase timeout still reaches the parent");
		assert.equal(inbox(db, "root", { delivery: MAIL_DELIVERY.OBSOLETE }).length, 0);
		assert.equal(inbox(db, "root", { delivery: MAIL_DELIVERY.ACCEPTED }).length, 1);
	} finally {
		db.close();
	}
});

test("a phase-timeout notice whose phase already ended goes OBSOLETE and is never injected (#333)", async () => {
	const db = openLegionDb(":memory:");
	const supervisor = new FakeSupervisor();
	const rootMessages: string[] = [];
	const now = 5_001;
	try {
		insertNode(db, { parentId: null, name: "root", role: "root", status: "running" }, () => 1);
		insertNode(db, { parentId: "root", name: "team", role: "centurion", status: "running", phase: "reviewing", phaseSince: 100 }, () => 2);
		appendEvent(db, "root.team", "phase_timeout", { phase: "reviewing", phaseSince: 100, elapsedMs: 1_800_573, timeoutMs: 1_800_000 }, { now: () => 1000 });
		const mailed = sendMail(db, {
			fromNode: "root.team", to: "parent", subject: "Phase timeout: team", kind: "notice", urgency: "action-needed",
			body: "Legion phase timeout: root.team has been in reviewing for 1800573ms (limit 1800000ms). Work was not killed; decide whether to extend or abort.",
		}, { now: () => 1000 });
		assert.equal(mailed.ok, true);
		if (!mailed.ok) return;
		const messageId = mailed.messages[0]!.id;
		assert.equal(pendingInbox(db, "root").length, 1, "precondition: the notice is still queued for root");
		// The #333 sequence: the team converged (reviewing → done) after the notice went out.
		updateNode(db, "root.team", { phase: "done", phaseSince: 5_000 }, () => 5_000);
		const postman = new LegionPostman({ db, nodeId: "root", supervisor, now: () => now, sendRootMessage: (message) => rootMessages.push(message), intervalMs: 10_000 });
		await postman.tick();
		await postman.tick();
		postman.stop();

		assert.deepEqual(rootMessages, [], "an expired action-needed must not reach root at all");
		assert.equal(pendingInbox(db, "root").length, 0);
		assert.equal(inbox(db, "root", { delivery: MAIL_DELIVERY.OBSOLETE }).length, 1);
		assert.equal(inbox(db, "root", { delivery: MAIL_DELIVERY.ACCEPTED }).length, 0);
		const bounced = readEventsAfter(db, 0).filter((event) => event.type === "mail_bounced");
		assert.equal(bounced.length, 1, "the obsolete verdict is written once, not once per tick");
		assert.deepEqual(bounced[0]!.data, { messageId, toNode: "root", reason: "obsolete_after_phase_change" });
	} finally {
		db.close();
	}
});

test("an already-ACCEPTED phase-timeout notice is obsoleted once its phase moves on (#333)", async () => {
	const db = openLegionDb(":memory:");
	const supervisor = new FakeSupervisor();
	const rootMessages: string[] = [];
	const now = 5_001;
	try {
		insertNode(db, { parentId: null, name: "root", role: "root", status: "running" }, () => 1);
		insertNode(db, { parentId: "root", name: "team", role: "centurion", status: "running", phase: "reviewing", phaseSince: 100 }, () => 2);
		appendEvent(db, "root.team", "phase_timeout", { phase: "reviewing", phaseSince: 100, elapsedMs: 1_800_573, timeoutMs: 1_800_000 }, { now: () => 1000 });
		const mailed = sendMail(db, {
			fromNode: "root.team", to: "parent", subject: "Phase timeout: team", kind: "notice", urgency: "action-needed",
			body: "Legion phase timeout: root.team has been in reviewing for 1800573ms (limit 1800000ms). Work was not killed; decide whether to extend or abort.",
		}, { now: () => 1000 });
		assert.equal(mailed.ok, true);
		if (!mailed.ok) return;
		// The notice was handed to root's message queue while the phase was still live…
		transitionDelivery(db, mailed.messages[0]!.id, MAIL_DELIVERY.ACCEPTED, () => 1_000);
		// …and only afterwards did the team move on.
		updateNode(db, "root.team", { phase: "done", phaseSince: 5_000 }, () => 5_000);
		const postman = new LegionPostman({ db, nodeId: "root", supervisor, now: () => now, sendRootMessage: (message) => rootMessages.push(message), intervalMs: 10_000 });
		await postman.tick();
		postman.stop();

		assert.deepEqual(rootMessages, [], "confirmation never re-injects, it only relabels");
		assert.equal(inbox(db, "root", { delivery: MAIL_DELIVERY.OBSOLETE }).length, 1);
		assert.equal(inbox(db, "root", { delivery: MAIL_DELIVERY.ACCEPTED }).length, 0);
	} finally {
		db.close();
	}
});

test("A5: a stale unsupervised running orphan is converged to failed with node_abandoned and still reported", async () => {
	const rootDir = mkdtempSync(path.join(tmpdir(), "legion-orphan-converge-"));
	const db = openLegionDb(":memory:");
	const supervisor = new FakeSupervisor();
	const messages: string[] = [];
	const now = 10_000;
	try {
		insertNode(db, { parentId: null, name: "root", role: "root", status: "running" }, () => 1);
		const orphan = insertNode(db, { parentId: "root", name: "lost-child", role: "worker", status: "running" }, () => 1);
		const postman = new LegionPostman({
			db, nodeId: "root", supervisor, settings: { orphanStaleMs: 100 },
			now: () => now, sendRootMessage: (message) => messages.push(message), intervalMs: 10_000,
		});
		await postman.tick();
		postman.stop();

		// 1. D7: the ledger row itself is terminal — detection alone used to leave it running.
		assert.equal(getNode(db, orphan.id)?.status, "failed");
		assert.equal(getNode(db, orphan.id)?.updatedAt, now, "convergence stamps the row instead of leaving the heartbeat frozen");

		// 2. The convergence is a durable fact with its own reason.
		const abandoned = readEventsAfter(db, 0).filter((event) => event.type === "node_abandoned");
		assert.deepEqual(abandoned.map((event) => event.nodeId), [orphan.id]);
		const abandonedData = abandoned[0]?.data as { reason?: string; staleMs?: number; updatedAt?: number } | null;
		assert.equal(abandonedData?.reason, "no_active_supervisor");
		assert.equal(abandonedData?.staleMs, 100);
		assert.equal(abandonedData?.updatedAt, 1, "the event names the frozen heartbeat the scan judged, not the post-convergence row");

		// 3. The pre-existing orphan report is kept untouched.
		assert.deepEqual(
			readEventsAfter(db, 0).filter((event) => event.type === "orphan_detected").map((event) => event.nodeId),
			[orphan.id],
		);

		// 4. The root notice still goes out, wording unchanged.
		assert.equal(messages.length, 1);
		assert.match(messages[0] ?? "", /^Legion orphan detected at /);
		assert.ok(messages[0]?.includes(`${orphan.id} (worker, status=running) has no active supervisor`), messages[0]);
	} finally {
		db.close();
		rmSync(rootDir, { recursive: true, force: true });
	}
});

test("A5: a converged orphan leaves the stale set, so liveness cannot read it back as live", async () => {
	const rootDir = mkdtempSync(path.join(tmpdir(), "legion-orphan-liveness-"));
	const db = openLegionDb(":memory:");
	const supervisor = new FakeSupervisor();
	const now = 10_000;
	try {
		insertNode(db, { parentId: null, name: "root", role: "root", status: "running" }, () => now);
		const orphan = insertNode(db, { parentId: "root", name: "lost-child", role: "worker", status: "running" }, () => 1);
		assert.deepEqual(listStaleNodes(db, now - 100).map((node) => node.id), [orphan.id], "the orphan is stale and non-terminal before the scan");
		const postman = new LegionPostman({
			db, nodeId: "root", supervisor, settings: { orphanStaleMs: 100 },
			now: () => now, sendRootMessage: () => {}, intervalMs: 10_000,
		});
		await postman.tick();
		postman.stop();
		// `liveness()` lands in W1. This pins the ledger precondition it reads: a
		// terminal row that the stale-node query no longer yields, so its stale-ledger
		// branch (non-terminal + expired heartbeat → dead) can never fire again.
		assert.equal(getNode(db, orphan.id)?.status, "failed");
		assert.deepEqual(listStaleNodes(db, now - 100).map((node) => node.id), [], "a converged row drops out of the stale scan instead of being re-judged");
	} finally {
		db.close();
		rmSync(rootDir, { recursive: true, force: true });
	}
});

test("A5: a mixed scan converges only the unsupervised child and leaves the live one running", async () => {
	const rootDir = mkdtempSync(path.join(tmpdir(), "legion-orphan-mixed-"));
	const db = openLegionDb(":memory:");
	const supervisor = new FakeSupervisor();
	const messages: string[] = [];
	const now = 10_000;
	const sessionFile = path.join(rootDir, "live-child.jsonl");
	try {
		insertNode(db, { parentId: null, name: "root", role: "root", status: "running" }, () => now);
		const live = insertNode(db, { parentId: "root", name: "live-child", role: "worker", status: "running" }, () => 1);
		const orphan = insertNode(db, { parentId: "root", name: "lost-child", role: "worker", status: "running" }, () => 1);
		await supervisor.spawnChild({ name: live.name, task: "still working", agent: agent("worker"), sessionFile, tempDir: rootDir, cwd: rootDir });
		const postman = new LegionPostman({
			db, nodeId: "root", supervisor, settings: { orphanStaleMs: 100 },
			now: () => now, sendRootMessage: (message) => messages.push(message), intervalMs: 10_000,
		});
		await postman.tick();
		postman.stop();
		assert.equal(supervisor.isAlive(live.name), true);
		assert.equal(getNode(db, live.id)?.status, "running", "a live supervisor must never be converged");
		assert.equal(getNode(db, live.id)?.updatedAt, now, "the live child heartbeat still advances");
		assert.equal(readEventsAfter(db, 0).some((event) => event.nodeId === live.id && event.type === "node_abandoned"), false);
		assert.equal(getNode(db, orphan.id)?.status, "failed", "the unsupervised sibling is still converged in the same scan");
		assert.equal(messages.length, 1);
		assert.ok(messages[0]?.includes(`: ${orphan.id} `), messages[0]);
		assert.equal(messages.some((message) => message.includes(live.id)), false, "no notice is raised for the live child");
	} finally {
		await supervisor.retire("live-child").catch(() => {});
		db.close();
		rmSync(rootDir, { recursive: true, force: true });
	}
});

test("#338 M1: mail addressed to root is confirmed from the root session file, not stranded at ACCEPTED", async () => {
	const rootDir = mkdtempSync(path.join(tmpdir(), "legion-root-delivered-"));
	const db = openLegionDb(":memory:");
	const supervisor = new FakeSupervisor();
	mkdirSync(rootDir, { recursive: true });
	const rootSession = path.join(rootDir, "root.jsonl");
	const rootMessages: string[] = [];
	let now = 10;
	try {
		// The root row carries this session's file — `createRootLegion` records it
		// (#338 M1); before that, root was a recipient with no evidence source.
		insertNode(db, { parentId: null, name: "root", role: "root", status: "running", sessionFile: rootSession }, () => 1);
		insertNode(db, { parentId: "root", name: "team", role: "centurion", status: "running" }, () => 2);
		const sent = sendMail(db, { fromNode: "root.team", to: "parent", subject: "verdict", body: "ship it" }, { now: () => now });
		assert.equal(sent.ok, true);
		if (!sent.ok) return;
		const message = sent.messages[0]!;

		const postman = new LegionPostman({
			db, nodeId: "root", supervisor, now: () => now,
			sendRootMessage: (text) => rootMessages.push(text), intervalMs: 10_000,
		});
		await postman.tick();
		postman.stop();
		assert.equal(inbox(db, "root", { delivery: MAIL_DELIVERY.ACCEPTED }).length, 1, "the send returned; nothing more is provable yet");
		assert.deepEqual(rootMessages, [formatMail(message)], "root receives the same envelope every other recipient does");

		// Root's own session now holds the turn it was handed.
		writeFileSync(rootSession, userSession([formatMail(message)]));
		now = 20;
		const confirm = new LegionPostman({
			db, nodeId: "root", supervisor, now: () => now,
			sendRootMessage: () => {}, intervalMs: 10_000,
		});
		await confirm.tick();
		confirm.stop();

		assert.equal(
			inbox(db, "root", { delivery: MAIL_DELIVERY.DELIVERED }).length,
			1,
			"root is a recipient like any other: its session proves consumption",
		);
		const delivered = readEventsAfter(db, 0).filter((event) => event.type === "mail_delivered");
		assert.equal(delivered.length, 1);
		assert.deepEqual((delivered[0]!.data as { messageId?: number }), { messageId: message.id, toNode: "root" });
	} finally {
		db.close();
		rmSync(rootDir, { recursive: true, force: true });
	}
});

test("#338 M3: the confirmation scan rotates past a full window instead of starving the tail", async () => {
	const db = openLegionDb(":memory:");
	const supervisor = new FakeSupervisor();
	const rootDir = mkdtempSync(path.join(tmpdir(), "legion-confirm-rotate-"));
	const sessionFile = path.join(rootDir, "worker.jsonl");
	mkdirSync(rootDir, { recursive: true });
	const now = 100;
	try {
		insertNode(db, { parentId: null, name: "root", role: "root", status: "running" }, () => 1);
		insertNode(db, { parentId: "root", name: "team", role: "centurion", status: "running" }, () => 2);
		const worker = insertNode(db, { parentId: "root.team", name: "worker", role: "worker", status: "running", sessionFile }, () => 3);
		const accepted = (index: number, subject: string) => {
			const result = sendMail(db, {
				fromNode: "root.team", to: "worker", subject, body: `body ${index}`,
			}, { now: () => now + index, ratePer5Min: 1_000 });
			assert.equal(result.ok, true);
			if (!result.ok) throw new Error("send failed");
			const message = result.messages[0]!;
			transitionDelivery(db, message.id, MAIL_DELIVERY.ACCEPTED, () => now + index);
			return message;
		};
		// A full window of messages that can never be proven: their text is nowhere in
		// the session. Under a fixed "oldest 20 every tick" scan they own the window
		// forever (the #338 M3 deadlock).
		for (let index = 0; index < 20; index += 1) accepted(index, `undecidable ${index}`);
		// The 21st is provable — but only reachable once the scan rotates.
		const provable = accepted(20, "provable");
		writeFileSync(sessionFile, userSession([formatMail(provable)]));

		const postman = new LegionPostman({ db, nodeId: "root.team", supervisor, now: () => now, intervalMs: 10_000 });
		await postman.tick();
		assert.equal(inbox(db, worker.id, { delivery: MAIL_DELIVERY.DELIVERED }).length, 0, "the first pass is the first 20 ids");
		await postman.tick();
		postman.stop();

		assert.equal(
			inbox(db, worker.id, { delivery: MAIL_DELIVERY.DELIVERED }).length,
			1,
			"the second pass wraps to the tail and confirms the message behind the window",
		);
		assert.equal(inbox(db, worker.id, { delivery: MAIL_DELIVERY.ACCEPTED }).length, 20, "the undecidable ones honestly stay ACCEPTED");
	} finally {
		db.close();
		rmSync(rootDir, { recursive: true, force: true });
	}
});

test("#338 M4: only `notice` mail can be obsoleted — a `report` with a Phase timeout subject stays ACCEPTED", async () => {
	const db = openLegionDb(":memory:");
	const supervisor = new FakeSupervisor();
	const rootMessages: string[] = [];
	const now = 5_001;
	try {
		insertNode(db, { parentId: null, name: "root", role: "root", status: "running" }, () => 1);
		insertNode(db, { parentId: "root", name: "team", role: "centurion", status: "running", phase: "reviewing", phaseSince: 100 }, () => 2);
		appendEvent(db, "root.team", "phase_timeout", { phase: "reviewing", phaseSince: 100 }, { now: () => 1_000 });
		// The mail kind domain is question|report|handoff|notice: there is no
		// `instruction` kind, and a report is a human judgement call either way.
		assert.equal(sendMail(db, {
			fromNode: "root.team", to: "parent", subject: "Phase timeout: team (report)", kind: "report", urgency: "action-needed",
			body: "Report about the timeout that just happened.",
		}, { now: () => 1_000 }).ok, true);
		const postman = new LegionPostman({
			db, nodeId: "root", supervisor, now: () => now,
			sendRootMessage: (text) => rootMessages.push(text), intervalMs: 10_000,
		});
		await postman.tick();
		// The team converged after the report went out; a `notice` would now be stale.
		updateNode(db, "root.team", { phase: "done", phaseSince: 5_000 }, () => 5_000);
		await postman.tick();
		postman.stop();

		assert.equal(inbox(db, "root", { delivery: MAIL_DELIVERY.OBSOLETE }).length, 0, "a report is never auto-obsoleted");
		assert.equal(inbox(db, "root", { delivery: MAIL_DELIVERY.ACCEPTED }).length, 1, "it stays ACCEPTED, whatever the subject says");
		assert.equal(readEventsAfter(db, 0).filter((event) => event.type === "mail_bounced").length, 0);
	} finally {
		db.close();
	}
});

test("#333: a Phase timeout notice with no recorded phase_timeout event stays ACCEPTED (never guess)", async () => {
	const db = openLegionDb(":memory:");
	const supervisor = new FakeSupervisor();
	const rootMessages: string[] = [];
	const now = 5_001;
	try {
		insertNode(db, { parentId: null, name: "root", role: "root", status: "running" }, () => 1);
		insertNode(db, { parentId: "root", name: "team", role: "centurion", status: "running", phase: "reviewing", phaseSince: 100 }, () => 2);
		// No `phase_timeout` row: the notice cannot be tied to a stint, so the frozen
		// rule is "stay ACCEPTED" — never infer staleness from the subject alone.
		assert.equal(sendMail(db, {
			fromNode: "root.team", to: "parent", subject: "Phase timeout: team", kind: "notice", urgency: "action-needed",
			body: "Legion phase timeout without a ledger row.",
		}, { now: () => 1_000 }).ok, true);
		const postman = new LegionPostman({
			db, nodeId: "root", supervisor, now: () => now,
			sendRootMessage: (text) => rootMessages.push(text), intervalMs: 10_000,
		});
		await postman.tick();
		// The team moves to another LIVE phase. Without the `phase_timeout` row there
		// is no "stint it timed out in" to compare against, so the verdict must stay
		// ACCEPTED instead of guessing from the subject. (A terminal sender is the one
		// case the ledger decides on its own — no stint needed to know it is over.)
		updateNode(db, "root.team", { phase: "verifying", phaseSince: 5_000 }, () => 5_000);
		await postman.tick();
		postman.stop();

		assert.equal(rootMessages.length, 1, "the notice is still injected: nothing proves it stale");
		assert.equal(inbox(db, "root", { delivery: MAIL_DELIVERY.OBSOLETE }).length, 0);
		assert.equal(inbox(db, "root", { delivery: MAIL_DELIVERY.ACCEPTED }).length, 1);
	} finally {
		db.close();
	}
});

test("#333: re-entering the same phase is a different stint, so the old notice goes OBSOLETE", async () => {
	const db = openLegionDb(":memory:");
	const supervisor = new FakeSupervisor();
	const rootMessages: string[] = [];
	const now = 5_001;
	try {
		insertNode(db, { parentId: null, name: "root", role: "root", status: "running" }, () => 1);
		// Same phase name, different stint start: reviewing(100) ended, reviewing(5_000) began.
		insertNode(db, { parentId: "root", name: "team", role: "centurion", status: "running", phase: "reviewing", phaseSince: 5_000 }, () => 2);
		appendEvent(db, "root.team", "phase_timeout", { phase: "reviewing", phaseSince: 100 }, { now: () => 1_000 });
		assert.equal(sendMail(db, {
			fromNode: "root.team", to: "parent", subject: "Phase timeout: team", kind: "notice", urgency: "action-needed",
			body: "Legion phase timeout in the previous reviewing stint.",
		}, { now: () => 1_000 }).ok, true);
		const postman = new LegionPostman({
			db, nodeId: "root", supervisor, now: () => now,
			sendRootMessage: (text) => rootMessages.push(text), intervalMs: 10_000,
		});
		await postman.tick();
		postman.stop();

		assert.deepEqual(rootMessages, [], "the notice about the previous stint is never injected");
		assert.equal(inbox(db, "root", { delivery: MAIL_DELIVERY.OBSOLETE }).length, 1, "same phase name, different phase_since ⇒ stale");
		assert.equal(inbox(db, "root", { delivery: MAIL_DELIVERY.ACCEPTED }).length, 0);
	} finally {
		db.close();
	}
});

test("#338 minor 2: one confirmation pass parses each seam's session at most once", async () => {
	const db = openLegionDb(":memory:");
	const supervisor = new FakeSupervisor();
	const now = 100;
	let parses = 0;
	try {
		insertNode(db, { parentId: null, name: "root", role: "root", status: "running" }, () => 1);
		insertNode(db, { parentId: "root", name: "team", role: "centurion", status: "running" }, () => 2);
		const worker = insertNode(db, { parentId: "root.team", name: "worker", role: "worker", status: "running", sessionFile: "/fake/worker.jsonl" }, () => 3);
		const messages = ["first", "second", "third"].map((subject, index) => {
			const result = sendMail(db, { fromNode: "root.team", to: "worker", subject, body: subject }, { now: () => now + index });
			assert.equal(result.ok, true);
			if (!result.ok) throw new Error("send failed");
			transitionDelivery(db, result.messages[0]!.id, MAIL_DELIVERY.ACCEPTED, () => now + index);
			return result.messages[0]!;
		});
		const postman = new LegionPostman({
			db, nodeId: "root.team", supervisor, now: () => now, intervalMs: 10_000,
			parseTurns: () => {
				parses += 1;
				return [{ userText: formatMail(messages[0]!) }];
			},
		});
		await postman.tick();
		postman.stop();

		assert.equal(parses, 1, "three messages, one projection — not one parse per message");
		assert.equal(inbox(db, worker.id, { delivery: MAIL_DELIVERY.DELIVERED }).length, 1);
		assert.equal(inbox(db, worker.id, { delivery: MAIL_DELIVERY.ACCEPTED }).length, 2);
	} finally {
		db.close();
	}
});

test("#338 minor 6: a mail_sent row beyond 100 later events is still emitted to the bus", async () => {
	const rootDir = mkdtempSync(path.join(tmpdir(), "legion-emit-mail-window-"));
	const db = openLegionDb(":memory:");
	const supervisor = new FakeSupervisor();
	const sessionFile = path.join(rootDir, "active.jsonl");
	mkdirSync(rootDir, { recursive: true });
	const now = 10;
	try {
		insertNode(db, { parentId: null, name: "root", role: "root", status: "running" }, () => 1);
		insertNode(db, { parentId: "root", name: "team", role: "centurion", status: "running" }, () => 2);
		const active = insertNode(db, { parentId: "root.team", name: "active", role: "worker", status: "running", sessionFile }, () => 3);
		await supervisor.spawnChild({ name: active.name, task: "active", agent: agent("worker"), sessionFile, tempDir: rootDir, cwd: rootDir });
		const sent = sendMail(db, { fromNode: "root.team", to: "active", subject: "old mail", body: "still pending" }, { now: () => now });
		assert.equal(sent.ok, true);
		if (!sent.ok) return;
		const messageId = sent.messages[0]!.id;
		// 150 further sends from the same node would push this row out of any
		// "newest 100 of this node+type" window — exactly the silent failure the
		// bounded lookup had.
		for (let index = 0; index < 150; index += 1) {
			appendEvent(db, "root.team", "mail_sent", { messageId: 10_000 + index, toNode: "active" }, { now: () => now + index });
		}
		const eventBus = createLegionEventBus();
		const emitted: Array<{ type: string; messageId?: number }> = [];
		eventBus.on("mail_sent", (event) => emitted.push({ type: event.type, messageId: (event.data as { messageId?: number } | null)?.messageId }));
		const postman = new LegionPostman({ db, nodeId: "root.team", supervisor, eventBus, now: () => now, intervalMs: 10_000 });
		await postman.tick();
		postman.stop();

		assert.equal(
			emitted.some((entry) => entry.messageId === messageId),
			true,
			"the bus still learns about this delivery instead of dropping it silently",
		);
		assert.equal(inbox(db, active.id, { delivery: MAIL_DELIVERY.ACCEPTED }).length, 1);
	} finally {
		db.close();
		rmSync(rootDir, { recursive: true, force: true });
	}
});
