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
import { readEventsAfter } from "../../src/legion/events.ts";
import { MAIL_DELIVERY, inbox, pendingInbox, sendMail } from "../../src/legion/mail.ts";
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

test("an intercepted steer-mail warns instead of pretending the child saw it (#313)", async () => {
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
		const postman = new LegionPostman({
			db,
			nodeId: "root.team",
			supervisor,
			settings: { usagePollMs: 1 },
			now: () => now,
			intervalMs: 10_000,
		});
		console.warn = (message?: unknown) => { warnings.push(String(message)); };
		await postman.tick();
		postman.stop();

		// The state machine is unchanged (#313 D3): the send returned, so the mail is
		// INJECTED and will never be retried…
		const injected = inbox(db, active.id, { delivery: MAIL_DELIVERY.INJECTED });
		assert.equal(injected.length, 1);
		assert.equal(pendingInbox(db, active.id).length, 0, "INJECTED promises no retry");
		// …which is exactly why the swallowed case must be visible, not silent.
		assert.equal(warnings.length, 1, `expected exactly one warning, got: ${warnings.join(" | ")}`);
		assert.match(warnings[0]!, /was intercepted by an input handler/);
		assert.match(warnings[0]!, /never saw it/);
		assert.match(
			warnings[0]!,
			new RegExp(`mail ${injected[0]!.id} `),
			"the warning names the message so a parent can act on it",
		);
	} finally {
		console.warn = originalWarn;
		db.close();
		rmSync(rootDir, { recursive: true, force: true });
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
