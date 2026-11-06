/**
 * stall-notice v1 (`docs/contracts/stall-notice-v1.md`) — "很久没有动静" push.
 *
 * Two failure modes, two detectors, no action:
 *
 * ```
 * L1 (silence) : in-flight stack empty AND now - lastEventAt >= silenceNoticeMs
 * L1, stack non-empty : NEVER reported (D1) — a 10-minute build is shaped exactly
 *                       like a hung bash, so a busy stack is not evidence of a stall
 * L2 (long)    : now - loopBaseAt >= loopRadiusMs
 * ```
 *
 * The load-bearing assertions here are the RULES, not the rendering:
 *
 * 1. a non-empty stack can never produce an L1 notice (`D1`), no matter how long
 *    the child has been quiet;
 * 2. the decision is a PURE function — time arrives as an argument, nothing reads a
 *    clock, nothing touches a db (`no IO, no clock`);
 * 3. the exit is exactly one self-addressed `messages` row and ZERO `events` rows
 *    (`D4`/`D9`), de-duplicated in memory per `(child, kind, sinceBucket)`;
 * 4. `extend` moves the L2 baseline only and never the L1 silence fact.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { LegionPostman } from "../../src/extension/legion-tools.ts";
import { openLegionDb } from "../../src/legion/db.ts";
import { readEventsAfter } from "../../src/legion/events.ts";
import { inbox } from "../../src/legion/mail.ts";
import { getNode, insertNode, updateNode } from "../../src/legion/nodes.ts";
import {
	DEFAULT_LOOP_NOTICE_MS,
	LONG_RUNNING_NOTICE_LIMIT,
	SILENCE_NOTICE_LIMIT,
	decideStallNotice,
	formatStallDuration,
	formatStallNotice,
	isActiveStallThreshold,
	resolveLoopRadiusMs,
	type StallAnnouncement,
	type StallChildFacts,
	type StallThresholds,
} from "../../src/legion/stall-notice.ts";
import type { InFlightToolStack } from "../../src/supervisor/types.ts";
import { DEFAULT_LEGION_SETTINGS, DEFAULTS, ErrorCodes, type AgentConfig } from "../../src/shared/types.ts";
import { parseSubagentSettings } from "../../src/agents/settings.ts";
import { parseAgentDocument } from "../../src/agents/agents.ts";
import { extendStallNotice } from "../../index.ts";
import { applyOverride } from "../../src/agents/overrides.ts";
import { FakeSupervisor } from "../helpers/fake-supervisor.ts";

const MINUTE = 60_000;

// ───────────────────────────── 1. pure decision ─────────────────────────────

/** The window as the postman builds it: `announced` = lines already sent. */
function window(loopBaseAt: number, silenceAnnounced = 0, longRunningAnnounced = 0) {
	return { loopBaseAt, silenceAnnounced, longRunningAnnounced };
}

function child(facts: Partial<StallChildFacts> = {}): StallChildFacts {
	return { name: "root.worker", ...facts };
}

function silence(ms: number | undefined): StallThresholds {
	return { silenceNoticeMs: ms };
}

function long(ms: number | undefined): StallThresholds {
	return { loopRadiusMs: ms };
}

test("L1: exactly the threshold fires, one millisecond short does not", () => {
	const silenceNoticeMs = 120_000;
	const since = 1_000_000;
	const at = (now: number) =>
		decideStallNotice({
			now,
			child: child({ lastEventAt: since }),
			thresholds: silence(silenceNoticeMs),
			window: window(0),
		});

	assert.equal(at(since + silenceNoticeMs - 1), undefined, "1ms short of the bound is not silence");
	const fired = at(since + silenceNoticeMs);
	assert.ok(fired, "`>=` is the frozen comparison (D1)");
	assert.equal(fired.kind, "silence");
	assert.equal(fired.elapsedMs, silenceNoticeMs);
	assert.equal(fired.thresholdMs, silenceNoticeMs);
	assert.equal(fired.sequence, 1);
	assert.equal(fired.sinceBucket, since, "the bucket is the silence start, i.e. `lastEventAt`");
});

test("L1: 0, a negative number, NaN and Infinity all disable the detector (D6)", () => {
	for (const disabled of [0, -1, -120_000, Number.NaN, Number.POSITIVE_INFINITY]) {
		assert.equal(isActiveStallThreshold(disabled), false, `${disabled} must not be a threshold`);
		assert.equal(
			decideStallNotice({
				now: 10 * MINUTE,
				child: child({ lastEventAt: 0 }),
				thresholds: silence(disabled),
				window: window(0),
			}),
			undefined,
			`silenceNoticeMs=${disabled} means "off", not "always on"`,
		);
	}
	// `undefined` (the key absent) is off as well: no threshold, no claim.
	assert.equal(isActiveStallThreshold(undefined), false);
});

test("L1: a MISSING lastEventAt is no fact, so no notice (D2)", () => {
	assert.equal(
		decideStallNotice({
			now: 60 * MINUTE,
			child: child(),
			thresholds: silence(120_000),
			window: window(0),
		}),
		undefined,
		"a supervisor that cannot answer must not produce a stall notice",
	);
});

test("L1: stack NON-empty + ten minutes without an event → NOT reported (D1)", () => {
	// This is the core of the contract: `tool_execution_start` → silence → nothing
	// looks exactly like a hung child, so a busy stack may never be judged.
	const built = decideStallNotice({
		now: 10 * MINUTE,
		child: child({ lastEventAt: 0, inFlightTool: "bash", inFlightToolStartedAt: 0 }),
		thresholds: silence(120_000),
		window: window(0),
	});
	assert.equal(built, undefined, "a 10-minute `npm run build` is not a stall");
});

test("L1: announced at 1× and 2×, then never again in the same silence window (D6)", () => {
	const silenceNoticeMs = 120_000;
	const since = 0;
	const announce = (now: number, silenceAnnounced: number) =>
		decideStallNotice({
			now,
			child: child({ lastEventAt: since }),
			thresholds: silence(silenceNoticeMs),
			window: window(0, silenceAnnounced),
		});

	assert.equal(announce(silenceNoticeMs, 0)?.sequence, 1);
	// Past 1× but before 2× there is nothing new to say.
	assert.equal(announce(silenceNoticeMs + 1_000, 1), undefined, "no second mail one tick later");
	assert.equal(announce(2 * silenceNoticeMs - 1, 1), undefined, "the second line waits for 2×");
	assert.equal(announce(2 * silenceNoticeMs, 1)?.sequence, 2);
	assert.equal(SILENCE_NOTICE_LIMIT, 2);
	assert.equal(announce(3 * silenceNoticeMs, 2), undefined, "a dead child must not mail every 2 minutes");
	assert.equal(announce(100 * silenceNoticeMs, 2), undefined);
	// A NEW event opens a new window, and the count restarts with it.
	assert.equal(
		decideStallNotice({
			now: 3 * silenceNoticeMs,
			child: child({ lastEventAt: 2 * silenceNoticeMs }),
			thresholds: silence(silenceNoticeMs),
			window: window(0, 0),
		})?.sequence,
		1,
	);
});

test("L2: the radius boundary, and it works without lastEventAt (D2)", () => {
	const radius = 45 * MINUTE;
	const base = 1_000;
	const at = (now: number) =>
		decideStallNotice({
			now,
			child: child(), // no lastEventAt at all
			thresholds: long(radius),
			window: window(base),
		});

	assert.equal(at(base + radius - 1), undefined);
	const fired = at(base + radius);
	assert.ok(fired);
	assert.equal(fired.kind, "long-running");
	assert.equal(fired.sinceBucket, base, "the bucket is the L2 baseline");
	assert.equal(fired.inFlightTool, undefined);
});

test("L2: it repeats once per radius and stops after three unhandled lines (D6)", () => {
	const radius = 10 * MINUTE;
	const base = 0;
	const at = (now: number, announced: number) =>
		decideStallNotice({
			now,
			child: child(),
			thresholds: long(radius),
			window: window(base, 0, announced),
		});

	assert.equal(at(radius, 0)?.sequence, 1);
	assert.equal(at(radius + 1, 1), undefined, "‘每再过一个 loopRadiusMs’ — not one tick later");
	assert.equal(at(2 * radius, 1)?.sequence, 2);
	assert.equal(at(3 * radius, 2)?.sequence, 3);
	assert.equal(LONG_RUNNING_NOTICE_LIMIT, 3);
	assert.equal(at(4 * radius, 3), undefined, "the cap holds until an `extend` or the child ends");
	assert.equal(at(100 * radius, 3), undefined);
});

test("L2: a non-empty stack becomes EVIDENCE inside the line, never a verdict of its own (D1)", () => {
	const announcement = decideStallNotice({
		now: 46 * MINUTE,
		child: child({ inFlightTool: "bash", inFlightToolStartedAt: 8 * MINUTE }),
		thresholds: long(45 * MINUTE),
		window: window(0),
	});
	assert.ok(announcement);
	assert.equal(announcement.inFlightTool, "bash");
	assert.equal(announcement.inFlightMs, 46 * MINUTE - 8 * MINUTE);
	// An unusable tool start is no evidence — the line must not print `NaN`.
	const noClock = decideStallNotice({
		now: 46 * MINUTE,
		child: child({ inFlightTool: "bash", inFlightToolStartedAt: Number.NaN }),
		thresholds: long(45 * MINUTE),
		window: window(0),
	});
	assert.equal(noClock?.inFlightTool, "bash");
	assert.equal(noClock?.inFlightMs, undefined);
});

test("L1 wins over L2 for the same child in the same tick (one line per child)", () => {
	// Both are due: an empty stack that has been silent past the whole role budget.
	const announcement = decideStallNotice({
		now: 60 * MINUTE,
		child: child({ lastEventAt: 0 }),
		thresholds: { silenceNoticeMs: 120_000, loopRadiusMs: 45 * MINUTE },
		window: window(0),
	});
	assert.equal(announcement?.kind, "silence");
	// Once L1 has spent its two lines the long-running reminder takes over.
	const later = decideStallNotice({
		now: 60 * MINUTE,
		child: child({ lastEventAt: 0 }),
		thresholds: { silenceNoticeMs: 120_000, loopRadiusMs: 45 * MINUTE },
		window: window(0, SILENCE_NOTICE_LIMIT, 0),
	});
	assert.equal(later?.kind, "long-running");
});

// ───────────────────────────── 2. pure text ─────────────────────────────

test("L1 text carries the frozen qualifier: steer cannot land, abort can (D3)", () => {
	const announcement: StallAnnouncement = {
		kind: "silence",
		childName: "root.worker",
		sinceBucket: 0,
		sequence: 1,
		elapsedMs: 125_000,
		thresholdMs: 120_000,
	};
	const { subject, body } = formatStallNotice([announcement]);
	assert.equal(subject, "Stall notice: root.worker");
	assert.match(body, /steer cannot land here; abort can/);
	assert.match(body, /no event for 2m 5s/);
	assert.match(body, /threshold 2m 0s/);
});

test("L2 text does NOT tell the parent that steer is useless (D3)", () => {
	const { body } = formatStallNotice([
		{
			kind: "long-running",
			childName: "root.worker",
			sinceBucket: 0,
			sequence: 1,
			elapsedMs: 46 * MINUTE,
			thresholdMs: 45 * MINUTE,
			inFlightTool: "bash",
			inFlightMs: 38 * MINUTE,
		},
	]);
	assert.doesNotMatch(body, /steer cannot land/);
	assert.match(body, /inside `bash` for 38m 0s/, "the stack is evidence, spelled out as one");
	assert.match(body, /running for 46m 0s/);
	assert.match(body, /threshold 45m 0s/);
	assert.match(body, /steer reaches a child at a turn boundary/);
	// D5: `extend` must be distinguishable from the other three actions.
	assert.match(body, /defers only this L2 reminder/);
	assert.match(body, /does not extend a collect\/wait budget/);
	assert.match(body, /is not `continue`/);
});

test("many children in one tick merge into ONE mail with one line each (D7)", () => {
	const merged = formatStallNotice([
		{ kind: "silence", childName: "root.a", sinceBucket: 0, sequence: 1, elapsedMs: 130_000, thresholdMs: 120_000 },
		{ kind: "silence", childName: "root.b", sinceBucket: 0, sequence: 1, elapsedMs: 140_000, thresholdMs: 120_000 },
		{ kind: "long-running", childName: "root.c", sinceBucket: 0, sequence: 1, elapsedMs: 46 * MINUTE, thresholdMs: 45 * MINUTE },
	]);
	assert.equal(merged.subject, "Stall notice: 3 children");
	const lines = merged.body.split("\n").filter((line) => line.startsWith("- "));
	assert.deepEqual(
		lines.map((line) => line.slice(2, line.indexOf(":"))),
		["root.a", "root.b", "root.c"],
		"one line per child, grouped L1 first",
	);
	assert.equal(merged.body.match(/L1 silence/g)?.length, 1, "the section heading is not repeated per child");
	assert.equal(merged.body.match(/L2 long-running/g)?.length, 1);
});

test("formatStallDuration never renders an unusable clock as a stall", () => {
	assert.equal(formatStallDuration(0), "0s");
	assert.equal(formatStallDuration(999), "0s");
	assert.equal(formatStallDuration(-5), "0s");
	assert.equal(formatStallDuration(Number.NaN), "0s");
	assert.equal(formatStallDuration(Number.POSITIVE_INFINITY), "0s");
	assert.equal(formatStallDuration(5_000), "5s");
	assert.equal(formatStallDuration(125_000), "2m 5s");
	assert.equal(formatStallDuration(45 * MINUTE), "45m 0s");
	assert.equal(formatStallDuration(90 * MINUTE), "1h 30m");
});

// ─────────────────── 3. purity: no IO, no clock, no db ───────────────────

test("the decision module reads no clock and performs no IO", () => {
	const source = readFileSync(
		fileURLToPath(new URL("../../src/legion/stall-notice.ts", import.meta.url)),
		"utf8",
	);
	assert.doesNotMatch(source, /Date\.now\s*\(/, "time must arrive as an argument");
	assert.doesNotMatch(source, /performance\.now/, "time must arrive as an argument");
	assert.doesNotMatch(source, /node:fs|node:child_process|node:os|node:net/, "no IO in the decision module");
	assert.doesNotMatch(source, /\bdb\b\s*[.:]/, "the decision module must not see the ledger");
	// Only the shared CONSTANTS may be imported: a dependency here would be the first
	// step toward the detector owning state of its own.
	const imports = [...source.matchAll(/^import .*?from "(.+?)";$/gm)].map((match) => match[1]);
	assert.deepEqual(imports, ["../shared/types.ts"], "the module imports constants only");
	// Same input, same answer — nothing hidden between two calls.
	const input = {
		now: 10 * MINUTE,
		child: child({ lastEventAt: 0 }),
		thresholds: { silenceNoticeMs: 120_000, loopRadiusMs: 45 * MINUTE },
		window: window(0),
	};
	assert.deepEqual(decideStallNotice(input), decideStallNotice(input));
});

// ─────────────────────────── 4. role radius chain (D8) ───────────────────────────

test("D8 chain: card loopNoticeMs → card timeoutMs → DEFAULTS.turnTimeoutMs", () => {
	// 1. neither declared → the SDK turn budget.
	assert.equal(resolveLoopRadiusMs(undefined), DEFAULT_LOOP_NOTICE_MS);
	assert.equal(DEFAULT_LOOP_NOTICE_MS, DEFAULTS.turnTimeoutMs);
	assert.equal(resolveLoopRadiusMs({}), DEFAULTS.turnTimeoutMs);
	// 2. only `timeoutMs` (scout's 600s, i.e. a 10-minute first reminder).
	assert.equal(resolveLoopRadiusMs({ timeoutMs: 600_000 }), 600_000);
	// 3. only `loopNoticeMs`.
	assert.equal(resolveLoopRadiusMs({ loopNoticeMs: 5 * MINUTE }), 5 * MINUTE);
	// 4. both → the explicit reminder wins, which is the point of the field: raising
	//    `timeoutMs` (a collect/wait budget) must not silently push the reminder back.
	assert.equal(resolveLoopRadiusMs({ loopNoticeMs: 5 * MINUTE, timeoutMs: 45 * MINUTE }), 5 * MINUTE);
	// An EXPLICIT 0 is the off switch, not a hole to fall through into `timeoutMs`.
	assert.equal(resolveLoopRadiusMs({ loopNoticeMs: 0, timeoutMs: 45 * MINUTE }), undefined);
});

test("the bundled cards produce the contract's default reminder table", () => {
	const cards: Record<string, AgentConfig> = {};
	for (const role of ["scout", "centurion", "worker"]) {
		const file = fileURLToPath(new URL(`../../agents/${role}.md`, import.meta.url));
		const parsed = parseAgentDocument(readFileSync(file, "utf8"), file, "builtin");
		assert.ok(parsed, `${role}.md must parse`);
		cards[role] = parsed;
	}
	assert.equal(resolveLoopRadiusMs(cards.scout), 600_000, "scout: 10 minutes");
	assert.equal(resolveLoopRadiusMs(cards.centurion), 1_800_000, "centurion: 30 minutes");
	assert.equal(resolveLoopRadiusMs(cards.worker), 2_700_000, "worker: 45 minutes");
	assert.equal(cards.worker?.loopNoticeMs, undefined, "no card gains a `loopNoticeMs` by accident");
});

// ─────────────────── 5. config面: settings + frontmatter (D8) ───────────────────

test("legion.silenceNoticeMs: parsed when positive, default filled when absent", () => {
	const parsed = parseSubagentSettings(
		{ subagents: { legion: { silenceNoticeMs: 90_000 } } },
		"/tmp/settings.json",
	);
	assert.equal(parsed.legion?.silenceNoticeMs, 90_000);
	const empty = parseSubagentSettings({ subagents: {} }, "/tmp/settings.json");
	assert.equal(empty.legion, undefined);
	assert.equal(DEFAULT_LEGION_SETTINGS.silenceNoticeMs, 120_000, "the frozen default");
});

test("legion.silenceNoticeMs: a non-positive-integer is the standard `positiveInt` error", () => {
	for (const invalid of [0, -5, 1.5, "120000"]) {
		assert.throws(
			() =>
				parseSubagentSettings(
					{ subagents: { legion: { silenceNoticeMs: invalid } } },
					"/tmp/settings.json",
				),
			(error: unknown) =>
				(error as Error).message.includes("legion.silenceNoticeMs") &&
				(error as Error).message.includes("expected a positive integer") &&
				(error as Error).message.includes("/tmp/settings.json"),
			`${String(invalid)} must be refused, naming the file`,
		);
	}
});

test("a card may declare loopNoticeMs; an unknown key is still a hard error", () => {
	const card = parseAgentDocument(
		["---", "name: probe", "description: d", "kind: pi", "loopNoticeMs: 300000", "---", "body"].join("\n"),
		"/x/probe.md",
		"user",
	);
	assert.ok(card);
	assert.equal(card.loopNoticeMs, 300_000);
	assert.deepEqual(card.unenforcedFields ?? [], [], "the runtime honours it, so it is not 'unenforced'");

	assert.throws(
		() =>
			parseAgentDocument(
				["---", "name: probe", "description: d", "kind: pi", "loopNotice: 300000", "---", "body"].join("\n"),
				"/x/probe.md",
				"user",
			),
		/unknown frontmatter field: 'loopNotice'/,
		"a near-miss must still be caught by the strict field list",
	);
});

test("agentOverrides may set loopNoticeMs (D8: cards OR overrides, never a launch argument)", () => {
	const base = parseAgentDocument(
		["---", "name: worker", "description: d", "kind: pi", "timeoutMs: 2700000", "---", "body"].join("\n"),
		"/x/worker.md",
		"user",
	);
	assert.ok(base);
	assert.equal(resolveLoopRadiusMs(base), 2_700_000);
	const overridden = applyOverride(base, { loopNoticeMs: 15 * MINUTE });
	assert.equal(overridden.loopNoticeMs, 15 * MINUTE);
	assert.equal(resolveLoopRadiusMs(overridden), 15 * MINUTE, "the override decouples the reminder from timeoutMs");
});

// ───────────────────── 6. postman: the exit is ONE message row ─────────────────────

/**
 * A supervisor that answers the two stall facts by hand.
 *
 * `FakeSupervisor` predates stall notice v1 and answers neither, which is exactly
 * the "no fact, no claim" case the contract protects (`lastEventAt?` optional). This
 * subclass adds ONLY the two optional reads the detector uses, so the postman test
 * exercises the real decision path without spawning anything.
 */
class StallSupervisor extends FakeSupervisor {
	readonly live = new Set<string>();
	readonly eventAges = new Map<string, number>();
	readonly stacks = new Map<string, InFlightToolStack>();

	isAlive(name: string): boolean {
		return this.live.has(name);
	}

	lastEventAt(name: string): number | undefined {
		return this.eventAges.get(name);
	}

	inFlightToolStack(name: string): InFlightToolStack | undefined {
		return this.stacks.get(name);
	}
}

const TICK_AT = 3_600_000;

interface Fixture {
	db: ReturnType<typeof openLegionDb>;
	supervisor: StallSupervisor;
	postman: LegionPostman;
	/** What this node's own postman injected into the session (D4 path 2). */
	rootMessages: string[];
	stop(): void;
}

function fixture(options: {
	children?: Array<{ name: string; role: string; createdAt?: number; phase?: string | null; status?: "running" | "settled" }>;
	loopRadiusMs?: number;
	silenceNoticeMs?: number;
	noticeMsForRole?: (role: string | null | undefined) => number | undefined;
	now?: () => number;
} = {}): Fixture {
	const db = openLegionDb(":memory:");
	const supervisor = new StallSupervisor();
	insertNode(db, { parentId: null, name: "root", role: "root", status: "running" }, () => 1);
	for (const spec of options.children ?? [{ name: "worker", role: "worker" }]) {
		insertNode(
			db,
			{
				parentId: "root",
				name: spec.name,
				role: spec.role,
				status: spec.status ?? "running",
				...(spec.phase === undefined ? {} : { phase: spec.phase }),
			},
			// A child born at THIS tick is below every radius by default, so a test that
			// cares about L2 must say how old its child is. Keeps L1 tests about L1.
			() => spec.createdAt ?? TICK_AT,
		);
		supervisor.live.add(spec.name);
	}
	const rootMessages: string[] = [];
	const postman = new LegionPostman({
		db,
		nodeId: "root",
		supervisor,
		// A root postman delivers its own inbox every tick (D4 path 2), so the row must
		// come out of the wire as text the model actually reads — not just a db row.
		sendRootMessage: (text) => rootMessages.push(text),
		settings: {
			orphanStaleMs: Number.MAX_SAFE_INTEGER,
			...(options.silenceNoticeMs === undefined ? {} : { silenceNoticeMs: options.silenceNoticeMs }),
			mailRatePer5Min: 10,
		},
		now: options.now ?? (() => TICK_AT),
		intervalMs: 10_000,
		...(options.noticeMsForRole
			? { noticeMsForRole: options.noticeMsForRole }
			: { noticeMsForRole: () => options.loopRadiusMs ?? 45 * MINUTE }),
	});
	return { db, supervisor, postman, rootMessages, stop: () => postman.stop() };
}

test("postman L1: one self-addressed notice row, kind=notice, urgency=action-needed, ZERO events", async () => {
	const fx = fixture({ silenceNoticeMs: 120_000 });
	try {
		fx.supervisor.eventAges.set("worker", TICK_AT - 125_000);
		const before = readEventsAfter(fx.db, 0).length;

		await fx.postman.tick();
		fx.stop();

		const rows = inbox(fx.db, "root");
		assert.equal(rows.length, 1, "exactly one mail — not one per detector");
		const notice = rows[0]!;
		assert.equal(notice.fromNode, "root");
		assert.equal(notice.toNode, "root", "D4: the recipient is the detector's own node");
		assert.equal(notice.kind, "notice");
		assert.equal(notice.urgency, "action-needed");
		assert.match(notice.body, /steer cannot land here; abort can/);
		assert.equal(readEventsAfter(fx.db, 0).length, before, "D9: the notice writes NO events row");
		// D4 path 2: the root postman reads its OWN inbox, so the fact reaches the
		// session in the same tick it was written.
		assert.equal(fx.rootMessages.length, 1, "the notice is delivered, not merely stored");
		assert.match(fx.rootMessages[0] ?? "", /Stall notice: worker/);

		// Same silence window, next tick: the 1× line is spent, 2× is not due yet.
		await fx.postman.tick();
		assert.equal(inbox(fx.db, "root").length, 1, "same sinceBucket must not be written twice");
		assert.equal(fx.rootMessages.length, 1, "and nothing is re-injected");
	} finally {
		fx.db.close();
	}
});

test("postman L1: an empty stack + 10 minutes of silence on a BUSY child is never reported (D1)", async () => {
	const fx = fixture({ silenceNoticeMs: 120_000 });
	try {
		// A slow tool: silent for ten minutes, but the stack says it is inside `bash`.
		fx.supervisor.eventAges.set("worker", TICK_AT - 10 * MINUTE);
		fx.supervisor.stacks.set("worker", [{ tool: "bash", startedAt: TICK_AT - 10 * MINUTE }]);

		await fx.postman.tick();
		fx.stop();

		assert.deepEqual(inbox(fx.db, "root"), [], "a busy stack is not evidence of a stall");
	} finally {
		fx.db.close();
	}
});

test("postman: a dead child and a terminal child produce nothing", async () => {
	const fx = fixture({
		children: [
			{ name: "dead", role: "worker" },
			{ name: "done", role: "worker", status: "settled" },
		],
		silenceNoticeMs: 120_000,
	});
	try {
		fx.supervisor.live.delete("dead"); // alive=false, but the row is not terminal
		fx.supervisor.eventAges.set("dead", TICK_AT - 10 * MINUTE);
		fx.supervisor.eventAges.set("done", TICK_AT - 10 * MINUTE);

		await fx.postman.tick();
		fx.stop();

		assert.deepEqual(inbox(fx.db, "root"), [], "L1 is only judged for a child this process runs");
	} finally {
		fx.db.close();
	}
});

test("postman L2: the role-derived radius fires, and the merged mail names every child", async () => {
	const fx = fixture({
		children: [
			{ name: "worker-a", role: "worker", createdAt: TICK_AT - 50 * MINUTE },
			{ name: "worker-b", role: "worker", createdAt: TICK_AT - 46 * MINUTE },
			// A young child: below its radius, so it must not appear.
			{ name: "worker-c", role: "worker", createdAt: TICK_AT - 5 * MINUTE },
		],
		// Both facts: no `lastEventAt` at all, so L1 cannot fire (D2).
		noticeMsForRole: () => 45 * MINUTE,
	});
	try {
		// `worker-a` is inside a tool: that becomes evidence, not a verdict (D1).
		fx.supervisor.stacks.set("worker-a", [{ tool: "bash", startedAt: TICK_AT - 38 * MINUTE }]);

		await fx.postman.tick();
		fx.stop();

		const rows = inbox(fx.db, "root");
		assert.equal(rows.length, 1, "D7: one mail for the whole tick");
		const body = rows[0]!.body;
		assert.match(rows[0]!.subject, /2 children/);
		assert.match(body, /\bworker-a\b/);
		assert.match(body, /\bworker-b\b/);
		assert.doesNotMatch(body, /\bworker-c\b/, "a child under its radius is not mentioned");
		assert.match(body, /inside `bash` for 38m 0s/, "D1: the stack is the evidence the L2 line carries");
		assert.doesNotMatch(body, /steer cannot land/, "D3: an L2 line must not deny steer");
	} finally {
		fx.db.close();
	}
});

test("postman L2: 3 lines per window, then silence until `extend` (D5/D6)", async () => {
	const radius = 10 * MINUTE;
	let now = TICK_AT;
	const fx = fixture({
		now: () => now,
		children: [{ name: "worker", role: "worker", createdAt: TICK_AT - radius }],
		noticeMsForRole: () => radius,
	});
	try {
		const tickAt = async (at: number) => {
			now = at;
			await fx.postman.tick();
		};
		const count = () => inbox(fx.db, "root").length;

		await tickAt(TICK_AT);
		assert.equal(count(), 1);
		await tickAt(TICK_AT + radius);
		assert.equal(count(), 2);
		await tickAt(TICK_AT + 2 * radius);
		assert.equal(count(), 3, "the third line is the cap");
		await tickAt(TICK_AT + 3 * radius);
		await tickAt(TICK_AT + 10 * radius);
		assert.equal(count(), 3, "silent until an extend or the child ends");

		// `extend` moves the baseline, which restarts the count — and nothing else.
		const receipt = fx.postman.extendStallWindow("worker");
		assert.ok(receipt);
		assert.equal(receipt.loopBaseAt, TICK_AT + 10 * radius);
		assert.equal(receipt.loopRadiusMs, radius);
		await tickAt(TICK_AT + 10 * radius + radius - 1);
		assert.equal(count(), 3, "the new window has not elapsed yet");
		await tickAt(TICK_AT + 10 * radius + radius);
		assert.equal(count(), 4, "the reminder resumes after the deferral");
	} finally {
		fx.db.close();
	}
});

test("postman: `extend` refuses a name that is not a child of this node", () => {
	const fx = fixture();
	try {
		assert.equal(fx.postman.extendStallWindow("ghost"), undefined, "an unknown name gets no receipt");
		const receipt = fx.postman.extendStallWindow("worker");
		assert.ok(receipt, "a real child does");
		assert.equal(receipt.childName, "worker");
		assert.equal(receipt.loopBaseAt, TICK_AT);
	} finally {
		fx.db.close();
	}
});

test("postman: a child that ends loses its clock; one that reappears restarts it (D5)", async () => {
	let now = TICK_AT;
	const radius = 10 * MINUTE;
	const fx = fixture({
		now: () => now,
		children: [{ name: "worker", role: "worker", createdAt: TICK_AT - radius }],
		noticeMsForRole: () => radius,
	});
	try {
		await fx.postman.tick();
		assert.equal(inbox(fx.db, "root").length, 1);

		// The child leaves the LIVE set (a crash / a retire) without a terminal row.
		fx.supervisor.live.delete("worker");
		now = TICK_AT + radius;
		await fx.postman.tick();
		assert.equal(inbox(fx.db, "root").length, 1, "an absent child is not judged");

		// It comes back (resume / re-spawn): the clock restarts NOW, not at createdAt.
		fx.supervisor.live.add("worker");
		now = TICK_AT + 20 * radius;
		await fx.postman.tick();
		assert.equal(inbox(fx.db, "root").length, 1, "the rebuilt clock has not elapsed yet");
		now += radius;
		await fx.postman.tick();
		assert.equal(inbox(fx.db, "root").length, 2, "the reminder resumes one radius after the re-spawn");

		// A terminal row deletes the entry outright.
		updateNode(fx.db, "root.worker", { status: "settled" }, () => now);
		now += 30 * radius;
		await fx.postman.tick();
		assert.equal(inbox(fx.db, "root").length, 2, "a settled child is never reminded about");
		assert.equal(getNode(fx.db, "root.worker")?.status, "settled");
	} finally {
		fx.db.close();
	}
});

test("postman: no role resolver means no L2 — a test double must not invent a budget", async () => {
	const db = openLegionDb(":memory:");
	const supervisor = new StallSupervisor();
	insertNode(db, { parentId: null, name: "root", role: "root", status: "running" }, () => 1);
	insertNode(db, { parentId: "root", name: "worker", role: "worker", status: "running" }, () => 1);
	supervisor.live.add("worker");
	const postman = new LegionPostman({
		db,
		nodeId: "root",
		supervisor,
		settings: { orphanStaleMs: Number.MAX_SAFE_INTEGER },
		now: () => TICK_AT,
		intervalMs: 10_000,
	});
	try {
		await postman.tick();
		assert.deepEqual(inbox(db, "root"), [], "no catalog ⇒ no fact about the role ⇒ no notice");
	} finally {
		postman.stop();
		db.close();
	}
});

// ─────────────────── 7. the `extend` action's tool surface (D5) ───────────────────

/** The tool result's text / error code, without a cast at every call site. */
function textOf(result: { content: ReadonlyArray<{ type: string; text?: string }> }): string {
	const first = result.content[0];
	return first?.type === "text" ? first.text ?? "" : "";
}

function errorOf(result: { details: unknown }): string | undefined {
	return (result.details as { error?: string } | undefined)?.error;
}

test("extend: a receipt that says exactly what it did and did NOT do", async () => {
	const fx = fixture({
		children: [{ name: "worker", role: "worker", createdAt: TICK_AT - 45 * MINUTE }],
		noticeMsForRole: () => 45 * MINUTE,
	});
	try {
		await fx.postman.tick();
		assert.equal(inbox(fx.db, "root").length, 1, "the reminder is due before the extend");

		const result = extendStallNotice({ postman: fx.postman }, { name: "worker", ms: 90 * MINUTE });
		const text = textOf(result);
		assert.equal(errorOf(result), undefined);
		assert.match(text, /next long-running reminder is due 5400000ms from now/);
		// D5's three "does NOT" clauses, verbatim in the receipt: a caller that reads
		// only this line must not conclude that a collect budget moved.
		assert.match(text, /does not extend a collect\/wait budget/);
		assert.match(text, /does not restart or revive the child/);
		assert.match(text, /is not `continue` or `steer`/);

		// 45 more minutes are not enough any more: the radius is now 90.
		await fx.postman.tick();
		assert.equal(inbox(fx.db, "root").length, 1, "the extended clock has not elapsed");
	} finally {
		fx.db.close();
	}
});

test("extend: an unknown name is the existing NOT_FOUND path, never a silent no-op", () => {
	const fx = fixture();
	try {
		const unknown = extendStallNotice({ postman: fx.postman }, { name: "ghost" });
		assert.equal(errorOf(unknown), ErrorCodes.NOT_FOUND);
		const text = textOf(unknown);
		assert.match(text, /ghost is not one of them/);
	} finally {
		fx.db.close();
	}
});

test("extend: `ms` must be a positive integer, and a session without a detector says so", () => {
	const fx = fixture();
	try {
		for (const ms of [0, -1, 1.5]) {
			const bad = extendStallNotice({ postman: fx.postman }, { name: "worker", ms });
			assert.equal(errorOf(bad), ErrorCodes.INVALID_PARAMS, `ms=${ms} must be refused`);
		}
		// A plain parent (no legion tree) has no detector: nothing to extend, and the
		// refusal must say that instead of pretending a clock moved.
		const noDetector = extendStallNotice({}, { name: "worker" });
		assert.equal(errorOf(noDetector), ErrorCodes.NOT_FOUND);
		assert.deepEqual(inbox(fx.db, "root"), [], "a refused extend never writes mail");
	} finally {
		fx.db.close();
	}
});
