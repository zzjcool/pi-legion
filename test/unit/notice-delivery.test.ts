/**
 * #442 — notice delivery: the live channel (A), one line per failure burst (B),
 * one attempt per stall detection (C).
 *
 * The first half of this file exercises the delivery seam directly
 * (`src/extension/notice-delivery.ts`) — that is where the ordering, the window
 * and the log shape live. The second half boots the REAL extension twice in one
 * process, which is the production shape of `ctx.newSession()`: the host disposes
 * the old `AgentSession` (invalidating its `pi`) and loads the extension again for
 * the replacement session with a fresh one. `notice()` is called with the OLD `pi`
 * there, exactly as an old postman's closure would after the replacement.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { initTheme } from "@earendil-works/pi-coding-agent";

import { notice, default as piLegion } from "../../index.ts";
import {
	NOTICE_LOG_FILE,
	deliverNotice,
	installNoticeChannel,
	liveNoticeChannel,
	noticeDeliveryStats,
	noticeScopeKey,
	noticeScopeOf,
	rememberNoticeScope,
	resetNoticeDelivery,
	stallNoticeDeliveryKey,
} from "../../src/extension/notice-delivery.ts";
import { FakeSupervisor } from "../helpers/fake-supervisor.ts";

initTheme("dark");

/** The host's invalidation message, verbatim (pi `ExtensionRunner.invalidate`). */
const STALE =
	"This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload().";

/**
 * A `formatMail` body for a stall notice — the writer's frozen shape, with the two
 * fields that differ per DETECTION (the row id and the tick stamp) exposed so a
 * test can stamp the same fact three times the way three postman instances did.
 */
function stallMail(input: { id?: number; detectedAt?: string; child?: string; elapsed?: string } = {}): string {
	const id = input.id ?? 42;
	const child = input.child ?? "worker-0";
	const elapsed = input.elapsed ?? "1h 30m 0s";
	return [
		`[legion mail #${id}]`,
		"From: root",
		`Subject: Stall notice: ${child}`,
		"Urgency: action-needed",
		"",
		"Legion stall notice — nothing was stopped, steered or retired; these are facts for you to check.",
		`Detected at ${input.detectedAt ?? "2026-01-01T00:00:00.000Z"}.`,
		"",
		"L2 long-running (past the role's notice budget):",
		`- ${child}: running for ${elapsed} (threshold 1h 30m), with no tool in flight. It may be looping — check its actual execution context; steer reaches a child at a turn boundary.`,
	].join("\n");
}

/** A non-stall mail: same envelope, different subject ⇒ no delivery dedupe. */
function phaseTimeoutMail(id = 7): string {
	return [
		`[legion mail #${id}]`,
		"From: root",
		"Subject: Phase timeout: worker-0",
		"Urgency: action-needed",
		"",
		"worker-0 has not moved for 10m 0s.",
	].join("\n");
}

function tempDir(prefix: string): string {
	return mkdtempSync(path.join(tmpdir(), prefix));
}

/** Capture what would land in the transcript (the reporter's default sink). */
function captureConsoleError(): { lines: string[]; restore: () => void } {
	const original = console.error;
	const lines: string[] = [];
	console.error = (...args: unknown[]) => {
		lines.push(args.map((arg) => String(arg)).join(" "));
	};
	return {
		lines,
		restore: () => {
			console.error = original;
		},
	};
}

// ── seam: A — which object actually receives the notice ──────────────────────

test("#442 A: the scope's LIVE channel delivers; a stale captured pi is never used", () => {
	resetNoticeDelivery();
	const sent: string[] = [];
	const uninstall = installNoticeChannel("root", { owner: { load: "new" }, send: (text) => sent.push(text) });
	try {
		const stalePi = {
			sendMessage(_text?: string) {
				throw new Error(STALE);
			},
		};
		let staleAttempts = 0;
		const outcome = deliverNotice({
			scope: "root",
			owner: stalePi,
			live: liveNoticeChannel("root"),
			text: stallMail(),
			fallback: (text) => {
				staleAttempts += 1;
				stalePi.sendMessage(text);
			},
		});
		assert.equal(outcome.status, "delivered");
		assert.equal(outcome.via, "live", "the live channel must win; the captured pi is the LAST resort");
		assert.equal(staleAttempts, 0, "a stale pi must not even be attempted while the live channel works");
		assert.deepEqual(sent, [stallMail()]);
	} finally {
		uninstall();
		resetNoticeDelivery();
	}
});

test("#442 A: when the live channel ALSO refuses, the captured pi is still tried (last resort)", () => {
	resetNoticeDelivery();
	const falls: string[] = [];
	const uninstall = installNoticeChannel("root", {
		owner: { load: "new" },
		send: () => {
			throw new Error("host refused the send");
		},
	});
	try {
		const outcome = deliverNotice({
			scope: "root",
			owner: { load: "old" },
			live: liveNoticeChannel("root"),
			text: phaseTimeoutMail(),
			fallback: (text) => falls.push(text),
		});
		assert.equal(outcome.status, "delivered");
		assert.equal(outcome.via, "fallback");
		assert.deepEqual(falls, [phaseTimeoutMail()]);
	} finally {
		uninstall();
		resetNoticeDelivery();
	}
});

test("#442 A: a load's own channel is attempted ONCE, not again as its own fallback", () => {
	resetNoticeDelivery();
	const pi = { name: "the-one-pi" };
	let attempts = 0;
	const uninstall = installNoticeChannel("root", {
		owner: pi,
		send: () => {
			attempts += 1;
			throw new Error(STALE);
		},
	});
	const console_ = captureConsoleError();
	try {
		const outcome = deliverNotice({
			scope: "root",
			owner: pi,
			live: liveNoticeChannel("root"),
			text: phaseTimeoutMail(),
			fallback: () => {
				attempts += 1;
			},
		});
		assert.equal(outcome.status, "undelivered");
		assert.equal(attempts, 1, "the same broken pi twice would double the red lines");
	} finally {
		console_.restore();
		uninstall();
		resetNoticeDelivery();
	}
});

test("#442 A: scopes keep the root session and each child apart (a load each replaces its own)", () => {
	resetNoticeDelivery();
	const rootLoad = { load: 1 };
	const childLoad = { load: 2 };
	const rootAgain = { load: 3 };
	try {
		const rootScope = noticeScopeKey({ isChild: false });
		const childScope = noticeScopeKey({ isChild: true, dbPath: "/tmp/legion.db", nodeId: "root.worker-0" });
		const replacement = noticeScopeKey({ isChild: true, dbPath: "/tmp/legion.db", nodeId: "root.worker-0" });
		const sibling = noticeScopeKey({ isChild: true, dbPath: "/tmp/legion.db", nodeId: "root.worker-1" });
		assert.equal(rootScope, "root");
		assert.equal(childScope, replacement, "the same node's replacement session must resolve the same scope");
		assert.notEqual(childScope, sibling, "siblings must never share a channel");
		assert.notEqual(childScope, rootScope);
		rememberNoticeScope(rootLoad, rootScope);
		rememberNoticeScope(childLoad, childScope);
		rememberNoticeScope(rootAgain, rootScope);
		assert.equal(noticeScopeOf(rootLoad), rootScope);
		assert.equal(noticeScopeOf(childLoad), childScope);
		assert.equal(noticeScopeOf({ unregistered: true }), "root", "an unregistered caller is the one root session");
	} finally {
		resetNoticeDelivery();
	}
});

// ── seam: B — a failure is one line, and the body goes to the log ────────────

test("#442 B: ten failures produce ONE transcript line, one log record each, and the count", () => {
	resetNoticeDelivery();
	const dir = tempDir("legion-notice-b-");
	const logPath = path.join(dir, NOTICE_LOG_FILE);
	const console_ = captureConsoleError();
	try {
		const pi = { load: "only" };
		const uninstall = installNoticeChannel("root", {
			owner: pi,
			logPath: () => logPath,
			send: () => {
				throw new Error(STALE);
			},
		});
		const outcomes = Array.from({ length: 10 }, () =>
			deliverNotice({
				scope: "root",
				owner: pi,
				live: liveNoticeChannel("root"),
				text: phaseTimeoutMail(),
				fallback: () => {
					throw new Error(STALE);
				},
			}),
		);
		uninstall();

		assert.ok(outcomes.every((outcome) => outcome.status === "undelivered"));
		assert.equal(console_.lines.length, 1, "10 failures are ONE line, not ten");
		const line = console_.lines[0]!;
		assert.match(line, /^\[pi-legion\] notice not delivered: /);
		assert.match(line, /kind=Phase timeout: worker-0;/, "the summary names the kind");
		assert.match(line, /bytes=\d+;/, "the summary names the size");
		assert.ok(line.includes(`body → ${logPath}`), "the summary says WHERE the body went");
		assert.ok(!line.includes("worker-0 has not moved for 10m 0s"), "the body must never reach the transcript");

		const log = readFileSync(logPath, "utf8");
		const records = log.split("\n").filter((row) => row.includes("notice undelivered"));
		assert.equal(records.length, 10, "every failure is recorded once in the log");
		assert.match(records.at(-1)!, /deduped=9/, "the merged failures are counted, not lost");
		assert.ok(log.includes("worker-0 has not moved for 10m 0s"), "the body IS in the log file");

		const stats = noticeDeliveryStats();
		assert.equal(stats.undelivered, 10);
		assert.equal(stats.reported, 1, "one line for the whole burst");
		assert.equal(stats.delivered, 0);
	} finally {
		console_.restore();
		resetNoticeDelivery();
		rmSync(dir, { recursive: true, force: true });
	}
});

// ── seam: C — the same detection is attempted once ──────────────────────────

test("#442 C: three detections 30ms apart deliver ONCE and the log says deduped=2", () => {
	resetNoticeDelivery();
	const dir = tempDir("legion-notice-c-");
	const logPath = path.join(dir, NOTICE_LOG_FILE);
	try {
		const sent: string[] = [];
		const uninstall = installNoticeChannel("root", { owner: {}, send: (text) => sent.push(text), logPath: () => logPath });
		const base = 1_700_000_000_000;
		// The same fact, stamped by three detectors: same child, same kind, same tier
		// (same elapsed/threshold), different row id and different tick stamp.
		const bodies = [
			stallMail({ id: 41, detectedAt: "2026-01-01T04:49:13.348Z" }),
			stallMail({ id: 42, detectedAt: "2026-01-01T04:49:13.361Z" }),
			stallMail({ id: 43, detectedAt: "2026-01-01T04:49:13.377Z" }),
		];
		const outcomes = bodies.map((text, index) =>
			deliverNotice(
				{ scope: "root", owner: {}, live: liveNoticeChannel("root"), text, fallback: () => {} },
				{ now: base + index * 15 },
			),
		);
		uninstall();

		assert.deepEqual(
			outcomes.map((outcome) => outcome.status),
			["delivered", "deduped", "deduped"],
			"30ms of stampede is ONE delivery attempt",
		);
		assert.deepEqual(outcomes.map((outcome) => outcome.deduped), [0, 1, 2]);
		assert.equal(sent.length, 1);
		assert.equal(sent[0], bodies[0], "the first stamp goes out; the two repeats are merged into it");
		const log = readFileSync(logPath, "utf8");
		assert.match(log, /notice deduplicated .*deduped=2/, "the log carries the merge count");
		assert.equal(noticeDeliveryStats().deduped, 2);
	} finally {
		resetNoticeDelivery();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("#442 C: a CROSSED boundary is a new fact, so it is delivered (the window is not a mute button)", () => {
	resetNoticeDelivery();
	const sent: string[] = [];
	const uninstall = installNoticeChannel("root", { owner: {}, send: (text) => sent.push(text) });
	const base = 1_700_000_000_000;
	try {
		deliverNotice(
			{ scope: "root", owner: {}, live: liveNoticeChannel("root"), text: stallMail({ elapsed: "1h 30m 0s" }), fallback: () => {} },
			{ now: base },
		);
		const second = deliverNotice(
			{ scope: "root", owner: {}, live: liveNoticeChannel("root"), text: stallMail({ elapsed: "3h 0m 0s" }), fallback: () => {} },
			{ now: base + 15 },
		);
		assert.equal(second.status, "delivered");
		assert.equal(sent.length, 2);
	} finally {
		uninstall();
		resetNoticeDelivery();
	}
});

test("#442 C: dedupe is scoped to stall notices — other mail is never swallowed", () => {
	resetNoticeDelivery();
	const sent: string[] = [];
	const uninstall = installNoticeChannel("root", { owner: {}, send: (text) => sent.push(text) });
	const base = 1_700_000_000_000;
	try {
		for (let index = 0; index < 3; index += 1) {
			deliverNotice(
				{ scope: "root", owner: {}, live: liveNoticeChannel("root"), text: phaseTimeoutMail(), fallback: () => {} },
				{ now: base + index * 15 },
			);
		}
		assert.equal(sent.length, 3);
		assert.equal(stallNoticeDeliveryKey(phaseTimeoutMail()), undefined);
		assert.equal(stallNoticeDeliveryKey(stallMail({ id: 1 })), stallNoticeDeliveryKey(stallMail({ id: 2 })));
		assert.notEqual(stallNoticeDeliveryKey(stallMail({ elapsed: "1h 30m 0s" })), stallNoticeDeliveryKey(stallMail({ elapsed: "3h 0m 0s" })));
	} finally {
		uninstall();
		resetNoticeDelivery();
	}
});

// ── wiring: the REAL extension, two loads, the old pi going stale ───────────

const ENV_KEYS = [
	"PI_CODING_AGENT_DIR",
	"PI_SUBAGENT_CHILD",
	"PI_SUBAGENT_UTILITY_CHILD",
	"PI_SUBAGENT_ALLOW_NESTED",
	"PI_SUBAGENT_MAX_DEPTH",
	"PI_SUBAGENT_PARENT_PATH",
	"PI_LEGION_DB",
	"PI_LEGION_NODE_ID",
	"PI_LEGION_PHASES",
] as const;

interface FakePi {
	sent: string[];
	attempts: number;
	/** Throw the host's staleness error from `sendMessage` (a disposed session). */
	stale: boolean;
	api: Record<string, unknown>;
}

function fakePi(): FakePi {
	const pi: FakePi = {
		sent: [],
		attempts: 0,
		stale: false,
		api: {},
	};
	const handlers = new Map<string, Array<(...args: unknown[]) => unknown>>();
	pi.api = {
		registerTool() {},
		registerCommand() {},
		registerMessageRenderer() {},
		registerShortcut() {},
		sendMessage(message: { content: string }) {
			pi.attempts += 1;
			if (pi.stale) throw new Error(STALE);
			pi.sent.push(message.content);
		},
		events: { emit() {}, on() {} },
		on(name: string, handler: (...args: unknown[]) => unknown) {
			const list = handlers.get(name) ?? [];
			list.push(handler);
			handlers.set(name, list);
		},
		handlers,
	};
	return pi;
}

function harness() {
	const root = mkdtempSync(path.join(tmpdir(), "legion-notice-wire-"));
	const agentDir = path.join(root, "agent");
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({}));
	const repo = path.join(root, "repo");
	execFileSync("git", ["init", "-q", repo]);
	execFileSync("git", ["-C", repo, "-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-qm", "init"]);

	const previousEnv = new Map(ENV_KEYS.map((name) => [name, process.env[name]]));
	process.env.PI_CODING_AGENT_DIR = agentDir;
	for (const name of ENV_KEYS.slice(1)) delete process.env[name];
	resetNoticeDelivery();

	/** Boot the extension once — i.e. what the host does per session load. */
	const boot = (pi: FakePi): void => {
		piLegion(pi.api as never, { supervisor: new FakeSupervisor({ immediateTimeout: false }) });
	};

	/**
	 * Point the instance's `lastCwd` at the temp repo (the log path is derived from
	 * it), through the cheapest event that runs `bindUi` and nothing else.
	 */
	const bindCwd = async (pi: FakePi): Promise<void> => {
		const handlers = (pi.api as { handlers: Map<string, Array<(event: unknown, ctx: unknown) => unknown>> }).handlers;
		for (const handler of handlers.get("input") ?? []) {
			await handler({ type: "input" }, { cwd: repo, hasUI: false, ui: { notify() {}, setStatus() {} }, sessionManager: { getSessionFile: () => path.join(root, "session.jsonl") } });
		}
	};

	const logPath = path.join(repo, ".pi-subagents", NOTICE_LOG_FILE);

	return {
		repo,
		logPath,
		boot,
		bindCwd,
		cleanup: () => {
			for (const [name, value] of previousEnv) {
				if (value === undefined) delete process.env[name];
				else process.env[name] = value;
			}
			resetNoticeDelivery();
			rmSync(root, { recursive: true, force: true });
		},
	};
}

test("#442 A (wiring): after a session replacement the OLD pi delivers through the NEW load", async () => {
	const h = harness();
	const console_ = captureConsoleError();
	try {
		const oldPi = fakePi();
		const newPi = fakePi();
		h.boot(oldPi);
		await h.bindCwd(oldPi);
		// The host's replacement shape: the old AgentSession is disposed (its `pi` is
		// invalidated) and the extension is loaded AGAIN for the replacement session.
		oldPi.stale = true;
		h.boot(newPi);
		await h.bindCwd(newPi);

		const body = stallMail();
		notice(oldPi.api as never, body);

		assert.deepEqual(newPi.sent, [body], "the notice must reach the replacement session");
		assert.equal(oldPi.attempts, 0, "the stale pi must not even be touched");
		assert.deepEqual(console_.lines, [], "no `notice not delivered` line after a successful delivery");
		assert.equal(noticeDeliveryStats().delivered, 1);
	} finally {
		console_.restore();
		h.cleanup();
	}
});

test("#442 A (wiring): the notice flow stays silent-and-delivered for a stall mail after replacement", async () => {
	const h = harness();
	const console_ = captureConsoleError();
	try {
		const oldPi = fakePi();
		const newPi = fakePi();
		h.boot(oldPi);
		await h.bindCwd(oldPi);
		oldPi.stale = true;
		h.boot(newPi);
		await h.bindCwd(newPi);
		// The exact text the user saw in the issue, three times over, from the old load.
		for (const stamp of ["348", "361", "377"]) {
			notice(oldPi.api as never, stallMail({ id: Number(stamp), detectedAt: `2026-01-01T04:49:13.${stamp}Z` }));
		}
		assert.equal(newPi.sent.length, 1, "#442 C: one detection, one delivery");
		assert.deepEqual(console_.lines, [], "#442 B: nothing red in the transcript");
		assert.match(readFileSync(h.logPath, "utf8"), /notice deduplicated .*deduped=2/);
	} finally {
		console_.restore();
		h.cleanup();
	}
});

test("#442 B (wiring): a host that always refuses produces ONE line and a log entry per failure", async () => {
	const h = harness();
	const console_ = captureConsoleError();
	try {
		const pi = fakePi();
		h.boot(pi);
		await h.bindCwd(pi);
		pi.stale = true;
		for (let index = 0; index < 10; index += 1) notice(pi.api as never, phaseTimeoutMail());
		assert.equal(console_.lines.length, 1, "10 failures, one transcript line");
		assert.match(console_.lines[0]!, /^\[pi-legion\] notice not delivered: /);
		assert.ok(!console_.lines[0]!.includes("worker-0 has not moved for 10m 0s"), "the body never reaches the transcript");
		assert.ok(existsSync(h.logPath), `the body log must exist at ${h.logPath}`);
		const log = readFileSync(h.logPath, "utf8");
		assert.equal(log.split("\n").filter((row) => row.includes("notice undelivered")).length, 10);
		assert.match(log, /deduped=9/);
		assert.ok(log.includes("worker-0 has not moved for 10m 0s"));
	} finally {
		console_.restore();
		h.cleanup();
	}
});
