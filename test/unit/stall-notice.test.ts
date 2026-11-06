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
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { initTheme } from "@earendil-works/pi-coding-agent";
import { LegionPostman } from "../../src/extension/legion-tools.ts";
import { legionDbPath, openLegionDb } from "../../src/legion/db.ts";
import { RunStore } from "../../src/runs/store.ts";
import { readEventsAfter } from "../../src/legion/events.ts";
import { MAIL_DELIVERY, inbox, isStaleStallNotice, sendMail, type LegionMessage } from "../../src/legion/mail.ts";
import { getChildren, getNode, insertNode, updateNode } from "../../src/legion/nodes.ts";
import {
	DEFAULT_LOOP_NOTICE_MS,
	LONG_RUNNING_NOTICE_LIMIT,
	SILENCE_NOTICE_LIMIT,
	STALL_NOTICE_SUBJECT_PREFIX,
	decideStallNotice,
	formatStallDuration,
	formatStallNotice,
	isActiveStallThreshold,
	resolveLoopRadiusMs,
	stallNoticeChildNames,
	type StallAnnouncement,
	type StallChildFacts,
	type StallLineState,
	type StallThresholds,
} from "../../src/legion/stall-notice.ts";
import type { InFlightToolStack } from "../../src/supervisor/types.ts";
import { DEFAULT_LEGION_SETTINGS, DEFAULTS, ErrorCodes, type AgentConfig } from "../../src/shared/types.ts";
import { parseSubagentSettings } from "../../src/agents/settings.ts";
import { parseAgentDocument } from "../../src/agents/agents.ts";
import piLegion, { LOOP_NOTICE_ROLE_TTL_MS, extendStallNotice, loopNoticeMsForRole } from "../../index.ts";
import { applyOverride } from "../../src/agents/overrides.ts";
import { FakeSupervisor } from "../helpers/fake-supervisor.ts";

const MINUTE = 60_000;

// ───────────────────────────── 1. pure decision ─────────────────────────────

/** The window as the postman builds it: `announced` = lines already sent. */
/** The window as the postman builds it: per-kind `{ count, lastAt }` (D6). */
function window(
	loopBaseAt: number,
	announced: { silence?: StallLineState; longRunning?: StallLineState } = {},
) {
	return {
		loopBaseAt,
		silence: announced.silence ?? { count: 0 },
		longRunning: announced.longRunning ?? { count: 0 },
	};
}

/** A line already sent at `lastAt` (the repeat clock's whole input). */
function sentAt(count: number, lastAt: number): StallLineState {
	return { count, lastAt };
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
	const announce = (now: number, already: StallLineState) =>
		decideStallNotice({
			now,
			child: child({ lastEventAt: since }),
			thresholds: silence(silenceNoticeMs),
			window: window(0, { silence: already }),
		});

	assert.equal(announce(silenceNoticeMs, { count: 0 })?.sequence, 1);
	// D6: the second line waits one threshold after the FIRST line, not after `2×base`.
	assert.equal(announce(silenceNoticeMs + 1_000, sentAt(1, silenceNoticeMs)), undefined, "no second mail one tick later");
	assert.equal(announce(2 * silenceNoticeMs - 1, sentAt(1, silenceNoticeMs)), undefined, "one threshold after the first line");
	assert.equal(announce(2 * silenceNoticeMs, sentAt(1, silenceNoticeMs))?.sequence, 2);
	assert.equal(SILENCE_NOTICE_LIMIT, 2);
	assert.equal(announce(3 * silenceNoticeMs, sentAt(2, 2 * silenceNoticeMs)), undefined, "a dead child must not mail every 2 minutes");
	assert.equal(announce(100 * silenceNoticeMs, sentAt(2, 3 * silenceNoticeMs)), undefined);
	// A NEW event opens a new window, and the count restarts with it.
	assert.equal(
		decideStallNotice({
			now: 3 * silenceNoticeMs,
			child: child({ lastEventAt: 2 * silenceNoticeMs }),
			thresholds: silence(silenceNoticeMs),
			window: window(0),
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
	const at = (now: number, longRunning: StallLineState) =>
		decideStallNotice({
			now,
			child: child(),
			thresholds: long(radius),
			window: window(base, { longRunning }),
		});

	assert.equal(at(radius, { count: 0 })?.sequence, 1);
	// ‘每再过一个 loopRadiusMs’ measured from the PREVIOUS line (D6), not one tick later.
	assert.equal(at(radius + 1, sentAt(1, radius)), undefined);
	assert.equal(at(2 * radius - 1, sentAt(1, radius)), undefined);
	assert.equal(at(2 * radius, sentAt(1, radius))?.sequence, 2);
	assert.equal(at(3 * radius, sentAt(2, 2 * radius))?.sequence, 3);
	assert.equal(LONG_RUNNING_NOTICE_LIMIT, 3);
	assert.equal(at(4 * radius, sentAt(3, 3 * radius)), undefined, "the cap holds until an `extend` or the child ends");
	assert.equal(at(100 * radius, sentAt(3, 4 * radius)), undefined);
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
		window: window(0, { silence: sentAt(SILENCE_NOTICE_LIMIT, 2 * 120_000) }),
	});
	assert.equal(later?.kind, "long-running");
});

// ───────────────────────────── 2. pure text ─────────────────────────────

/**
 * A frozen tick reading for the D1 stamp: `2025-10-09T08:53:20.123Z`.
 *
 * Fixed on purpose — `formatStallNotice` takes the detection clock as an argument, so
 * the text is reproducible and the purity test below stays honest.
 */
const DETECTED_AT = 1_760_000_000_123;

/** An announcement shape the predicate tests can reuse without spelling every field. */
function silenceAnnouncement(childName: string, overrides: Partial<StallAnnouncement> = {}): StallAnnouncement {
	return {
		kind: "silence",
		childName,
		sinceBucket: 0,
		sequence: 1,
		elapsedMs: 125_000,
		thresholdMs: 120_000,
		...overrides,
	};
}

test("L1 text carries the frozen qualifier: steer cannot land, abort can (D3)", () => {
	const announcement: StallAnnouncement = {
		kind: "silence",
		childName: "root.worker",
		sinceBucket: 0,
		sequence: 1,
		elapsedMs: 125_000,
		thresholdMs: 120_000,
	};
	const { subject, body } = formatStallNotice([announcement], DETECTED_AT);
	assert.equal(subject, "Stall notice: root.worker");
	assert.match(body, /steer cannot land here; abort can/);
	assert.match(body, /no event for 2m 5s/);
	assert.match(body, /threshold 2m 0s/);
});

test("D1: the body stamps the tick that detected it, so a late delivery is self-evident", () => {
	const { subject, body } = formatStallNotice([silenceAnnouncement("worker")], DETECTED_AT);
	const stamp = `Detected at ${new Date(DETECTED_AT).toISOString()}.`;
	assert.equal(subject, `${STALL_NOTICE_SUBJECT_PREFIX}worker`);
	// Exactly where the contract puts it: the line right after the heading, before any
	// section — a reader hits the age of the snapshot before the snapshot itself.
	assert.deepEqual(body.split("\n").slice(0, 2), [
		"Legion stall notice — nothing was stopped, steered or retired; these are facts for you to check.",
		stamp,
	]);
	assert.equal(body.match(/Detected at /g)?.length, 1, "one stamp per mail, not one per line");
	// It is not a child line, so the D2 parser cannot mistake it for one.
	assert.equal(stamp.startsWith("- "), false);
	assert.deepEqual(stallNoticeChildNames(body), ["worker"]);
});

test("D1: an unusable detection clock omits the line instead of printing `Invalid Date`", () => {
	for (const detectedAt of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
		const { body } = formatStallNotice([silenceAnnouncement("worker")], detectedAt);
		assert.doesNotMatch(body, /Detected at/, `detectedAt=${detectedAt} must not be stamped`);
		assert.doesNotMatch(body, /Invalid Date/);
		// The facts are still owed to the parent: only the stamp is dropped.
		assert.match(body, /- worker: no event for 2m 5s/);
	}
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
	], DETECTED_AT);
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
	], DETECTED_AT);
	assert.equal(merged.subject, "Stall notice: 3 children");
	const lines = merged.body.split("\n").filter((line) => line.startsWith("- "));
	assert.deepEqual(
		lines.map((line) => line.slice(2, line.indexOf(":"))),
		["root.a", "root.b", "root.c"],
		"one line per child, grouped L1 first",
	);
	assert.equal(merged.body.match(/L1 silence/g)?.length, 1, "the section heading is not repeated per child");
	assert.equal(merged.body.match(/L2 long-running/g)?.length, 1);
	// D2: the delivery-side parser reads the same three names out of the same text,
	// and the `Detected at` stamp above them does not become a fourth.
	assert.deepEqual(stallNoticeChildNames(merged.body), ["root.a", "root.b", "root.c"]);
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
	/** What reached a child's session through `deliverToChild` (D4 path 3). */
	readonly steered: Array<{ name: string; text: string }> = [];

	override async steer(name: string, text: string) {
		this.steered.push({ name, text });
		return "queued" as const;
	}

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
	mailRatePer5Min?: number;
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
			mailRatePer5Min: options.mailRatePer5Min ?? 10,
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
		// D1 WIRING, not just D1 text: the row's stamp must be THIS tick's clock reading
		// (`checkStallNotices(timestamp)` → `formatStallNotice(announcements, timestamp)`),
		// spelled out to the millisecond. The pure-text tests above cannot see a caller
		// that passes `0` (or any other number) instead of the timestamp, and that
		// mutation is the one that matters: a notice stamped with a wrong time is the
		// "delivered late, looks fresh" defect this contract removes. The expected ISO
		// string is `new Date(TICK_AT)`, never `new Date(0)` and never a fresh reading.
		assert.ok(
			notice.body.includes(`Detected at ${new Date(TICK_AT).toISOString()}.`),
			`the mailbox row is stamped with the tick that detected it, not with \`0\`: ${notice.body}`,
		);
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
		assert.ok("childName" in receipt, "a live child gets a receipt");
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

test("postman: `extend` refuses an unknown name and an ended child (D5)", async () => {
	const fx = fixture();
	try {
		assert.deepEqual(fx.postman.extendStallWindow("ghost"), { reason: "unknown-child" });
		const receipt = fx.postman.extendStallWindow("worker");
		assert.ok("childName" in receipt, "a live child does get one");
		assert.equal(receipt.childName, "worker");
		assert.equal(receipt.loopBaseAt, TICK_AT);

		// D5: "an ended child does not accept `extend`" — a receipt would promise a
		// reminder that no tick can ever send.
		updateNode(fx.db, "root.worker", { status: "settled" }, () => TICK_AT);
		assert.deepEqual(fx.postman.extendStallWindow("worker"), { reason: "child-ended" });
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
		assert.match(text, /ghost is not a child of this node/);

		// D5: an ENDED child is refused too — the receipt must not promise a reminder
		// that no tick can send.
		updateNode(fx.db, "root.worker", { status: "retired" }, () => TICK_AT);
		const ended = extendStallNotice({ postman: fx.postman }, { name: "worker" });
		assert.equal(errorOf(ended), ErrorCodes.NOT_FOUND);
		assert.match(textOf(ended), /has already ended/);
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

// ─────────── 8. review round: D5 tombstone + D6 repeat clock (M1 / M2) ───────────

test("M2: a child first observed already past its radius gets ONE line, not three", async () => {
	let now = TICK_AT;
	const radius = 10 * MINUTE;
	const fx = fixture({
		now: () => now,
		// Handed over long after it started: 3h of run time at the first observation.
		children: [{ name: "worker", role: "worker", createdAt: TICK_AT - 3 * 60 * MINUTE }],
		noticeMsForRole: () => radius,
	});
	try {
		await fx.postman.tick();
		assert.equal(inbox(fx.db, "root").length, 1, "the late first line is due immediately");
		// The next ticks are 2s apart, like the real postman. The second line is due
		// one RADIUS after the first, not one `base + n×radius` step.
		now = TICK_AT + 2_000;
		await fx.postman.tick();
		now = TICK_AT + 4_000;
		await fx.postman.tick();
		assert.equal(inbox(fx.db, "root").length, 1, "three consecutive ticks must not burn the whole quota");
	} finally {
		fx.db.close();
	}
});

test("M1: a terminal child that is revived must not fire L2 immediately (D5 tombstone)", async () => {
	let now = TICK_AT;
	const radius = 10 * MINUTE;
	const fx = fixture({
		now: () => now,
		children: [{ name: "worker", role: "worker", createdAt: TICK_AT - radius }],
		noticeMsForRole: () => radius,
	});
	try {
		await fx.postman.tick();
		assert.equal(inbox(fx.db, "root").length, 1, "the first window is due");

		// The child ends (its `nodes.created_at` never moves) …
		updateNode(fx.db, "root.worker", { status: "settled" }, () => now);
		now = TICK_AT + 60 * MINUTE;
		await fx.postman.tick();
		assert.equal(inbox(fx.db, "root").length, 1, "an ended child is never reminded about");

		// … and `continue`/resume brings it back. The reviving tick must NOT read the
		// old `created_at` as the baseline and announce "running for 70m".
		updateNode(fx.db, "root.worker", { status: "running" }, () => now);
		await fx.postman.tick();
		assert.equal(inbox(fx.db, "root").length, 1, "the clock restarts at the revival, not at createdAt");

		// One radius after the revival it is a real window again.
		now += radius;
		await fx.postman.tick();
		assert.equal(inbox(fx.db, "root").length, 2);
	} finally {
		fx.db.close();
	}
});

// ─────────── 9. review round: D6 late first line (pure) + D8 cache (m4) ───────────

test("D6 late first line: one line now, the next only after a whole radius", () => {
	const radius = 45 * MINUTE;
	// Observed for the first time 3h into its run (a restarted postman taking over).
	const base = 0;
	const at = (now: number, longRunning: StallLineState) =>
		decideStallNotice({ now, child: child(), thresholds: long(radius), window: window(base, { longRunning }) });

	const first = at(180 * MINUTE, { count: 0 });
	assert.equal(first?.sequence, 1, "the late first line is due at once");
	// Three ticks 2s apart must not walk through 2× and 3× of the base.
	for (const tick of [180 * MINUTE + 2_000, 180 * MINUTE + 4_000, 180 * MINUTE + 6_000]) {
		assert.equal(at(tick, sentAt(1, 180 * MINUTE)), undefined, "the repeat clock starts at the SENT line");
	}
	assert.equal(at(180 * MINUTE + radius, sentAt(1, 180 * MINUTE))?.sequence, 2);
	assert.equal(at(180 * MINUTE + 2 * radius, sentAt(2, 180 * MINUTE + radius))?.sequence, 3);
	assert.equal(at(180 * MINUTE + 3 * radius, sentAt(3, 180 * MINUTE + 2 * radius)), undefined, "cap holds");
});

test("m4: the role radius is cached per (cwd, role) for the TTL, then re-resolved", () => {
	// The first discovery pass reads the USER layer (`agentScope: "user"`, the launch
	// default), so this card has to live in `$PI_CODING_AGENT_DIR/agents`. The
	// project-layer fallback is covered by its own tests below.
	const cwd = mkdtempSync(path.join(tmpdir(), "legion-loop-notice-cache-"));
	const agentDir = path.join(cwd, "agents");
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(
		path.join(agentDir, "probe.md"),
		"---\nname: probe\ndescription: probe role\ntimeoutMs: 600000\n---\nbody\n",
	);
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = cwd;
	try {
		const settings = { disableBuiltins: true, agentOverrides: { probe: {} } } as unknown as Parameters<typeof loopNoticeMsForRole>[2];
		let now = 1_000;
		assert.equal(loopNoticeMsForRole("probe", agentDir, settings, () => now), 600_000);

		// An override written while the entry is warm is NOT seen: that is the cache.
		const overridden = { disableBuiltins: true, agentOverrides: { probe: { loopNoticeMs: 90_000 } } } as unknown as typeof settings;
		now += LOOP_NOTICE_ROLE_TTL_MS - 1;
		assert.equal(loopNoticeMsForRole("probe", agentDir, overridden, () => now), 600_000, "warm entry wins");
		// One millisecond past the TTL it re-resolves — with the new override.
		now += 1;
		assert.equal(loopNoticeMsForRole("probe", agentDir, overridden, () => now), 90_000, "the TTL expires");
		// A different role is a different key, never a stale hit from this one.
		writeFileSync(
			path.join(agentDir, "other.md"),
			"---\nname: other\ndescription: other role\n---\nbody\n",
		);
		assert.equal(
			loopNoticeMsForRole("other", agentDir, { disableBuiltins: true } as unknown as typeof settings, () => now),
			DEFAULTS.turnTimeoutMs,
			"a card with neither field falls back to the SDK turn budget",
		);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(cwd, { recursive: true, force: true });
	}
});

/**
 * D8's layer resolution: the user layer first (the launch default), then every layer
 * for roles that were launched with `agentScope: "project" | "both"`. Without the
 * second pass such a card fell through to `DEFAULTS.turnTimeoutMs`, which reminded a
 * 45-minute project role three times before it ever reached its budget.
 */
function withAgentLayers<T>(input: {
	project?: Record<string, string>;
	user?: Record<string, string>;
	run: (cwd: string, settings: Parameters<typeof loopNoticeMsForRole>[2]) => T;
}): T {
	const cwd = mkdtempSync(path.join(tmpdir(), "legion-loop-notice-layers-"));
	const userRoot = mkdtempSync(path.join(tmpdir(), "legion-loop-notice-agentdir-"));
	const projectDir = path.join(cwd, ".pi", "agents");
	const userDir = path.join(userRoot, "agents");
	for (const [dir, cards] of [[projectDir, input.project ?? {}], [userDir, input.user ?? {}]] as const) {
		if (Object.keys(cards).length === 0) continue;
		mkdirSync(dir, { recursive: true });
		for (const [name, body] of Object.entries(cards)) writeFileSync(path.join(dir, `${name}.md`), body);
	}
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = userRoot;
	try {
		return input.run(cwd, { disableBuiltins: true } as unknown as Parameters<typeof loopNoticeMsForRole>[2]);
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		rmSync(cwd, { recursive: true, force: true });
		rmSync(userRoot, { recursive: true, force: true });
	}
}

test("D8: a role that lives only in the PROJECT layer keeps its own radius", () => {
	const radius = withAgentLayers({
		project: { qa: "---\nname: qa\ndescription: d\ntimeoutMs: 2700000\n---\nbody\n" },
		run: (cwd, settings) => loopNoticeMsForRole("qa", cwd, settings),
	});
	assert.equal(radius, 45 * MINUTE, "not the 15-minute SDK budget a single-pass resolver gave it");
});

test("D8: the user layer wins over the project layer for the same role name", () => {
	const radius = withAgentLayers({
		user: { dual: "---\nname: dual\ndescription: d\ntimeoutMs: 600000\n---\nbody\n" },
		project: { dual: "---\nname: dual\ndescription: d\ntimeoutMs: 2700000\n---\nbody\n" },
		run: (cwd, settings) => loopNoticeMsForRole("dual", cwd, settings),
	});
	assert.equal(radius, 10 * MINUTE, "the default (user) scope is what the launch resolved");
});

test("D8: a user-layer `loopNoticeMs: 0` is an answer, not a miss — it does not fall through", () => {
	const radius = withAgentLayers({
		user: { off: "---\nname: off\ndescription: d\nloopNoticeMs: 0\ntimeoutMs: 600000\n---\nbody\n" },
		project: { off: "---\nname: off\ndescription: d\ntimeoutMs: 2700000\n---\nbody\n" },
		run: (cwd, settings) => loopNoticeMsForRole("off", cwd, settings),
	});
	assert.equal(radius, undefined, "a lower-precedence card must not re-enable what the launched card switched off");
});

// ─────── 10. review round: the exit does not charge the sender (D4 / m1) ───────

test("m1: a self-addressed notice does not spend the sender's mailRatePer5Min", async () => {
	// rate 1: ONE counted row already exceeds the allowance, so this fails if the
	// notice is counted (the exact defect: a node's own reminder rate-limits its
	// `legion_mail`).
	const fx = fixture({ silenceNoticeMs: 120_000, mailRatePer5Min: 1 });
	try {
		fx.supervisor.eventAges.set("worker", TICK_AT - 125_000);
		await fx.postman.tick();
		fx.stop();
		assert.equal(inbox(fx.db, "root").length, 1, "fixture: the self-addressed row exists");

		const sent = sendMail(
			fx.db,
			{ fromNode: "root", to: "worker", subject: "still allowed", body: "the parent can still write" },
			{ ratePer5Min: 1, now: () => TICK_AT },
		);
		assert.equal(sent.ok, true, "the notice must not be charged to the sender");

		// The window still counts real mail: one more send now exceeds rate 1.
		const second = sendMail(
			fx.db,
			{ fromNode: "root", to: "worker", subject: "one too many", body: "rate window still works" },
			{ ratePer5Min: 1, now: () => TICK_AT },
		);
		assert.equal(second.ok, false);
		assert.equal(second.ok ? "" : second.code, "rate_limited");
	} finally {
		fx.db.close();
	}
});

// ───── 11. review round: a centurion's notice is delivered by ITS parent (D4 path 3) ─────

test("non-root: a centurion's own notice is delivered by its parent's postman (D4 path 3)", async () => {
	const db = openLegionDb(":memory:");
	const supervisor = new StallSupervisor();
	insertNode(db, { parentId: null, name: "root", role: "root", status: "running" }, () => TICK_AT);
	insertNode(db, { parentId: "root", name: "team", role: "centurion", status: "running" }, () => TICK_AT);
	insertNode(db, { parentId: "root.team", name: "worker", role: "worker", status: "running" }, () => TICK_AT - 45 * MINUTE);
	supervisor.live.add("team");
	supervisor.live.add("worker");
	const rootMessages: string[] = [];
	const teamPostman = new LegionPostman({
		db,
		nodeId: "root.team",
		supervisor,
		settings: { orphanStaleMs: Number.MAX_SAFE_INTEGER },
		noticeMsForRole: () => 45 * MINUTE,
		now: () => TICK_AT,
		intervalMs: 10_000,
	});
	const rootPostman = new LegionPostman({
		db,
		nodeId: "root",
		supervisor,
		settings: { orphanStaleMs: Number.MAX_SAFE_INTEGER },
		noticeMsForRole: () => 45 * MINUTE,
		now: () => TICK_AT,
		sendRootMessage: (text) => rootMessages.push(text),
		intervalMs: 10_000,
	});
	try {
		await teamPostman.tick();
		const written = inbox(db, "root.team");
		assert.equal(written.length, 1, "the detector writes into its OWN inbox");
		assert.equal(written[0]?.fromNode, "root.team");
		assert.equal(written[0]?.toNode, "root.team");
		assert.equal(
			inbox(db, "root.team", { delivery: MAIL_DELIVERY.PENDING }).length,
			1,
			"a non-root postman does not deliver its own inbox — path 3 does",
		);

		await rootPostman.tick();
		assert.equal(
			inbox(db, "root.team", { delivery: MAIL_DELIVERY.ACCEPTED }).length,
			1,
			"the grandparent's deliverChildren handed it over",
		);
		const steered = supervisor.steered.filter((call) => call.name === "team");
		assert.equal(steered.length, 1);
		assert.match(steered[0]?.text ?? "", /Stall notice: worker/);
		assert.match(steered[0]?.text ?? "", /running for 45m 0s/);
		assert.deepEqual(rootMessages, [], "the root's own inbox was never used for this");
	} finally {
		teamPostman.stop();
		rootPostman.stop();
		db.close();
	}
});

// ───── 12. review round: `extend` through the REAL tool entry (controlAction) ─────

const ENTRY_ENV_KEYS = [
	"PI_CODING_AGENT_DIR",
	"PI_HERDR_SUBAGENTS_EXTRA_AGENT_DIRS",
	"PI_SUBAGENT_CHILD",
	"PI_SUBAGENT_ALLOW_NESTED",
	"PI_LEGION_DB",
	"PI_LEGION_NODE_ID",
	"PI_SUBAGENTS_TEAM",
];

/**
 * The `abort-action.test.ts` harness: a real `piLegion` registration driven through
 * `tools.get("subagent").execute(...)`, so `extend` is exercised through
 * `controlAction` (name resolution, scope rules, the postman it reaches) and not
 * only through the exported helper.
 */
function extendEntryHarness() {
	const cwd = mkdtempSync(path.join(tmpdir(), "legion-extend-entry-"));
	const agentDir = path.join(cwd, "agent-config");
	const extraAgentsDir = path.join(cwd, "extra-agents");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(extraAgentsDir, { recursive: true });
	writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ subagents: { disableBuiltins: true } }));
	writeFileSync(path.join(extraAgentsDir, "worker.md"), "---\nname: worker\ndescription: worker role\nkind: pi\n---\nworker prompt\n");
	const previous = new Map(ENTRY_ENV_KEYS.map((name) => [name, process.env[name]]));
	const tools = new Map<string, { execute: (...args: unknown[]) => Promise<{ content?: Array<{ text?: string }>; details?: unknown }> }>();
	const handlers = new Map<string, (...args: unknown[]) => unknown>();
	const supervisor = new FakeSupervisor({ immediateTimeout: false });
	const pi = {
		registerTool(value: unknown) {
			const typed = value as { name: string; execute: (...args: unknown[]) => Promise<{ content?: Array<{ text?: string }>; details?: unknown }> };
			tools.set(typed.name, typed);
		},
		registerCommand() {},
		registerMessageRenderer() {},
		sendMessage() {},
		events: { emit() {} },
		on(name: string, handler: (...args: unknown[]) => unknown) {
			handlers.set(name, handler);
		},
	};
	process.env.PI_CODING_AGENT_DIR = agentDir;
	process.env.PI_HERDR_SUBAGENTS_EXTRA_AGENT_DIRS = extraAgentsDir;
	for (const name of ENTRY_ENV_KEYS.slice(2)) delete process.env[name];
	piLegion(pi as never, { supervisor });
	const tool = tools.get("subagent");
	assert.ok(tool);
	return {
		cwd,
		supervisor,
		async invoke(params: Record<string, unknown>) {
			const result = await tool.execute("stall-notice-extend", params, undefined, undefined, {
				cwd,
				hasUI: false,
				ui: { notify() {}, setStatus() {} },
			});
			return {
				text: (result.content ?? []).map((item) => item.text ?? "").join("\n"),
				error: (result.details as { error?: string } | undefined)?.error,
			};
		},
		/** The ledger this session's root runtime created (one db per run dir). */
		openLedger() {
			const store = new RunStore({ rootDir: path.join(cwd, ".pi-subagents") });
			const rootRun = store.listRuns().find((run) => run.nodeId === "root");
			assert.ok(rootRun, "the launch created a root run");
			return openLegionDb(legionDbPath(store.runDir(rootRun.runId)));
		},
		async cleanup() {
			await handlers.get("session_shutdown")?.();
			for (const [name, value] of previous) {
				if (value === undefined) delete process.env[name];
				else process.env[name] = value;
			}
			rmSync(cwd, { recursive: true, force: true });
		},
	};
}

test("extend through `subagent({action:'extend'})`: receipt, unknown name, ended child", async () => {
	initTheme("dark");
	const harness = extendEntryHarness();
	let db: ReturnType<typeof openLegionDb> | undefined;
	try {
		const launched = await harness.invoke({ agent: "worker", task: "long job", name: "worker-0", async: true, worktree: false });
		assert.equal(launched.error, undefined, launched.text);

		// 1. A real child of this session's root node: the postman moves its clock.
		const extended = await harness.invoke({ action: "extend", name: "worker-0", ms: 120_000 });
		assert.equal(extended.error, undefined, extended.text);
		assert.match(extended.text, /Extended the stall-notice clock for worker-0/);
		assert.match(extended.text, /due 120000ms from now/);
		assert.match(extended.text, /does not extend a collect\/wait budget/);

		// 2. A name nobody has: the same NOT_FOUND path as every other control action.
		const unknown = await harness.invoke({ action: "extend", name: "ghost" });
		assert.equal(unknown.error, ErrorCodes.NOT_FOUND);
		assert.match(unknown.text, /ghost/);

		// 3. D5: an ended child is refused — no receipt for a reminder nobody will send.
		db = harness.openLedger();
		const child = getChildren(db, "root").find((node) => node.name === "worker-0");
		assert.ok(child, "the launch wrote the child row");
		updateNode(db, child.id, { status: "settled" }, () => Date.now());
		const ended = await harness.invoke({ action: "extend", name: "worker-0" });
		assert.equal(ended.error, ErrorCodes.NOT_FOUND);
		assert.match(ended.text, /has already ended/);
	} finally {
		db?.close();
		await harness.cleanup();
	}
});

// ────── 13. stall-notice-staleness D2: the delivery-side liveness predicate ──────

/**
 * The predicate's home is `mail.ts`, but its facts are all stall-notice facts — the
 * body it parses is the one `formatStallNotice` just wrote — so the §6.4/§6.5 cases
 * live next to that grammar.
 *
 * `isStaleStallNotice` reads exactly five fields off a message (kind, subject, body,
 * fromNode, plus the tree), so the fixture is a plain object: no `messages` row, no
 * clock, no postman. The integration of the verdict into the four delivery paths is
 * `legion-tools.test.ts` / `wait-mail-preempt.test.ts`.
 */
function staleProbe(overrides: Partial<LegionMessage> = {}): LegionMessage {
	return {
		id: 1,
		fromNode: "root",
		toNode: "root",
		subject: `${STALL_NOTICE_SUBJECT_PREFIX}alpha`,
		body: `Legion stall notice — nothing was stopped, steered or retired; these are facts for you to check.\nDetected at ${new Date(DETECTED_AT).toISOString()}.\n\nL1 silence (no tool in flight, no child event):\n- alpha: no event for 2m 5s with nothing in flight (threshold 2m 0s).`,
		kind: "notice",
		urgency: "action-needed",
		delivered: MAIL_DELIVERY.PENDING,
		deliveredAt: null,
		createdAt: DETECTED_AT,
		...overrides,
	};
}

/** `root` plus the named children at their birth phase, all still running. */
function stallTree(names: readonly string[], status: "running" | "retired" = "running") {
	const db = openLegionDb(":memory:");
	insertNode(db, { parentId: null, name: "root", role: "root", status: "running" }, () => 1);
	for (const name of names) {
		insertNode(db, { parentId: "root", name, role: "worker", status }, () => 1);
	}
	return db;
}

test("§6.4 merged notice: every named child has ended ⇒ stale; one still running ⇒ delivered", () => {
	const db = stallTree(["alpha", "beta", "gamma"]);
	try {
		const merged = formatStallNotice(
			[silenceAnnouncement("alpha"), silenceAnnouncement("beta"), silenceAnnouncement("gamma", { kind: "long-running" })],
			DETECTED_AT,
		);
		const message = staleProbe({ subject: merged.subject, body: merged.body });
		assert.equal(isStaleStallNotice(db, message), false, "three running children: nothing is stale");

		for (const name of ["alpha", "beta"]) {
			const child = getChildren(db, "root").find((node) => node.name === name);
			assert.ok(child);
			updateNode(db, child.id, { status: "retired" }, () => 2);
		}
		assert.equal(isStaleStallNotice(db, message), false, "two of three ended is NOT stale");

		const last = getChildren(db, "root").find((node) => node.name === "gamma");
		assert.ok(last);
		updateNode(db, last.id, { status: "retired" }, () => 3);
		assert.equal(isStaleStallNotice(db, message), true, "all three ended ⇒ the notice describes nothing left to act on");
		assert.match(message.body, /- gamma: /, "the fixture really names that child in its own text");
	} finally {
		db.close();
	}
});

test("§6.4/§6.5 mixed: one live child in a merged notice keeps the whole mail deliverable", () => {
	const db = stallTree(["alpha", "beta", "gamma"]);
	try {
		const merged = formatStallNotice([silenceAnnouncement("alpha"), silenceAnnouncement("beta"), silenceAnnouncement("gamma")], DETECTED_AT);
		const message = staleProbe({ subject: merged.subject, body: merged.body });
		for (const name of ["alpha", "beta"]) {
			const child = getChildren(db, "root").find((node) => node.name === name);
			assert.ok(child);
			updateNode(db, child.id, { status: "retired" }, () => 2);
		}
		assert.equal(isStaleStallNotice(db, message), false, "`beta` is still running ⇒ still actionable");
		assert.match(message.body, /- beta: /, "the delivered text still names the live child (never edited at delivery)");
	} finally {
		db.close();
	}
});

test("§6.5 never guess: an unparseable body, an illegal slug, or a missing detector ⇒ deliver it", () => {
	const db = stallTree(["alpha"]);
	try {
		const child = getChildren(db, "root").find((node) => node.name === "alpha");
		assert.ok(child);
		updateNode(db, child.id, { status: "retired" }, () => 2);

		assert.equal(
			isStaleStallNotice(db, staleProbe({ body: "the notice body was rewritten by a human" })),
			false,
			"zero parseable names: there is nothing to judge, so nothing is obsoleted",
		);
		assert.equal(
			isStaleStallNotice(db, staleProbe({
				body: "L1 silence:\n- Not_A_Slug!: no event for 2m 5s",
			})),
			false,
			"a name outside the slug grammar is not a node id this code may look up",
		);
		assert.equal(
			isStaleStallNotice(db, staleProbe({ fromNode: "root.gone-team" })),
			false,
			"an unknown detector turns every `getChildByName` null into `unknown`, never into `ended`",
		);
		assert.equal(
			isStaleStallNotice(db, staleProbe({ kind: "report" })),
			false,
			"only a `notice` is a machine fact; a report about an ended child is still history",
		);
		assert.equal(
			isStaleStallNotice(db, staleProbe({ subject: "Something else: alpha" })),
			false,
			"the subject prefix is the whole gate",
		);
		// Positive control for the same fixture: the one shape that IS stale.
		assert.equal(isStaleStallNotice(db, staleProbe()), true);
	} finally {
		db.close();
	}
});

test("D2: a named child that is GONE from the tree counts as ended (nothing left to steer)", () => {
	const db = stallTree(["alpha"]);
	try {
		assert.equal(
			isStaleStallNotice(db, staleProbe({
				subject: `${STALL_NOTICE_SUBJECT_PREFIX}deleted`,
				body: "L1 silence:\n- deleted: no event for 2m 5s",
			})),
			true,
			"the detector node exists and the named child does not: there is nobody to act on",
		);
	} finally {
		db.close();
	}
});

test("D2: `settled` and `retired` count as ended, an ended phase is not required (#354)", () => {
	const db = stallTree(["alpha"]);
	try {
		const child = getChildren(db, "root").find((node) => node.name === "alpha");
		assert.ok(child);
		// A team that only investigated: it never called `legion_phase`, so its phase is
		// still its birth phase — exactly the case `isTerminalNode` cannot see.
		updateNode(db, child.id, { status: "settled" }, () => 2);
		assert.equal(getNode(db, child.id)?.phase, null);
		assert.equal(isStaleStallNotice(db, staleProbe()), true);
	} finally {
		db.close();
	}
});

test("D2: the child-name parser reads only the frozen `- <child>: ` line grammar", () => {
	assert.deepEqual(stallNoticeChildNames(""), []);
	assert.deepEqual(stallNoticeChildNames("no lines at all"), []);
	assert.deepEqual(
		stallNoticeChildNames("Heading:\n- alpha: one\n- beta: two\n- alpha: again"),
		["alpha", "beta"],
		"deduped, first-appearance order",
	);
	assert.deepEqual(
		stallNoticeChildNames(`Detected at 2025-10-09T08:53:20.123Z.\n- see the report\n- alpha: real line`),
		["alpha"],
		"the stamp and a prose bullet are not children",
	);
});
