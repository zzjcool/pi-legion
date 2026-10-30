/**
 * #315 — "the process is alive but no longer progressing" was invisible.
 *
 * `liveness()` calls any child holding a non-terminal handle live, the heartbeat
 * refreshes for exactly those children, and the orphan scan exempts a node whose
 * first root child is alive. So a child stuck inside one tool call looks
 * identical to one doing useful work, and the parent finds out only when its
 * `collect` deadline (900s) fires.
 *
 * The fix is one **display-only** fact per child: the tool it is inside right
 * now, plus the host clock reading when that call started. Nothing here decides
 * liveness and nothing here kills, steers or retires anything — these tests pin
 * that boundary as much as the rendering.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
	STALL_NOTICE_MS,
	formatInFlightToolLine,
	formatToolElapsed,
	nextInFlightTool,
} from "../../src/supervisor/types.ts";
import { loadAgentsFromDir, BUILTIN_AGENTS_DIR } from "../../src/agents/agents.ts";

// ─────────────────────────── formatting ───────────────────────────

test("formatToolElapsed prints hh:mm:ss and does not wrap the hour field", () => {
	assert.equal(formatToolElapsed(0), "00:00:00");
	assert.equal(formatToolElapsed(451_000), "00:07:31");
	assert.equal(formatToolElapsed(3_600_000), "01:00:00");
	// A 30h call must read 30:00:00, never 06:00:00: a wrapped clock would
	// report a hung child as freshly started.
	assert.equal(formatToolElapsed(108_000_000), "30:00:00");
	// Sub-second and negative inputs cannot produce a negative clock.
	assert.equal(formatToolElapsed(-5), "00:00:00");
	assert.equal(formatToolElapsed(999), "00:00:00");
	// A non-finite input must not render as `NaN:NaN:NaN`: `Math.max(0, NaN)` is
	// `NaN`, and a clock made of NaNs reads like data instead of a missing fact.
	assert.equal(formatToolElapsed(Number.NaN), "00:00:00");
	assert.equal(formatToolElapsed(Number.POSITIVE_INFINITY), "00:00:00");
});

test("a short in-flight tool renders `working · <tool> hh:mm:ss` with no marker", () => {
	const activity = { tool: "bash", startedAt: 1_000 };
	assert.equal(
		formatInFlightToolLine(activity, 1_000 + 7_000),
		"working · bash 00:00:07",
	);
	// One millisecond short of the bound: still just the line.
	assert.equal(
		formatInFlightToolLine(activity, 1_000 + STALL_NOTICE_MS - 1),
		"working · bash 00:04:59",
	);
});

test("a tool at or past STALL_NOTICE_MS appends the display-only marker", () => {
	const activity = { tool: "bash", startedAt: 0 };
	const atBound = formatInFlightToolLine(activity, STALL_NOTICE_MS);
	assert.equal(
		atBound,
		"working · bash 00:05:00 (long-running tool — no progress for 5m; `steer` cannot interrupt it, `abort` can)",
	);
	// The marker counts whole minutes past the bound, not seconds.
	assert.match(formatInFlightToolLine(activity, 12 * 60_000), /no progress for 12m;/);
	// The tool name is carried through untouched.
	assert.match(
		formatInFlightToolLine({ tool: "codemode", startedAt: 0 }, STALL_NOTICE_MS),
		/^working · codemode /,
	);
});

// ─────────────────────── the event-stream fold ───────────────────────

test("nextInFlightTool sets on start, keeps on unrelated events, clears on the matching end", () => {
	const started = nextInFlightTool(
		undefined,
		{ type: "tool_execution_start", toolName: "bash", toolCallId: "c1" },
		5_000,
	);
	assert.deepEqual(started, { tool: "bash", startedAt: 5_000, toolCallId: "c1" });

	// Anything that is not a tool boundary leaves the fact exactly as it was:
	// this is what lets both backends call the fold on every single event.
	for (const type of ["turn_start", "message_update", "agent_start", "unknown"]) {
		assert.deepEqual(nextInFlightTool(started, { type }, 6_000), started);
	}

	assert.equal(
		nextInFlightTool(started, { type: "tool_execution_end", toolCallId: "c1" }, 7_000),
		undefined,
	);
	// An end with no live call is a no-op, not an error.
	assert.equal(
		nextInFlightTool(undefined, { type: "tool_execution_end", toolCallId: "c1" }, 7_000),
		undefined,
	);
});

test("nextInFlightTool: a start without a usable tool name does not invent one", () => {
	const started = nextInFlightTool(
		undefined,
		{ type: "tool_execution_start", toolName: "read", toolCallId: "c1" },
		1_000,
	);
	assert.deepEqual(
		nextInFlightTool(started, { type: "tool_execution_start" }, 2_000),
		started,
		"a start with no toolName must not clear or replace the live fact",
	);
	assert.deepEqual(
		nextInFlightTool(started, { type: "tool_execution_start", toolName: "" }, 2_000),
		started,
	);
	assert.deepEqual(
		nextInFlightTool(started, { type: "tool_execution_start", toolName: 42 }, 2_000),
		started,
	);
});

test("nextInFlightTool: a parallel sibling finishing does not clear the call still running", () => {
	const first = nextInFlightTool(
		undefined,
		{ type: "tool_execution_start", toolName: "read", toolCallId: "c1" },
		1_000,
	);
	// The newest start wins: the record holds ONE current call.
	const second = nextInFlightTool(
		first,
		{ type: "tool_execution_start", toolName: "bash", toolCallId: "c2" },
		2_000,
	);
	assert.equal(second?.tool, "bash");

	// c1 ending must not erase c2.
	assert.deepEqual(
		nextInFlightTool(second, { type: "tool_execution_end", toolCallId: "c1" }, 3_000),
		second,
	);

	// c2 ending does clear it.
	assert.equal(
		nextInFlightTool(second, { type: "tool_execution_end", toolCallId: "c2" }, 4_000),
		undefined,
	);

	// When either side cannot name its call there is nothing to match on, so the
	// end is taken at face value rather than leaving a stale fact behind forever.
	assert.equal(
		nextInFlightTool(first, { type: "tool_execution_end" }, 5_000),
		undefined,
	);
	assert.equal(
		nextInFlightTool(
			nextInFlightTool(undefined, { type: "tool_execution_start", toolName: "bash" }, 1_000),
			{ type: "tool_execution_end", toolCallId: "c9" },
			2_000,
		),
		undefined,
	);
});

// ──────────────────── the scout per-bash timeout (#315) ────────────────────

test("#315 scout declares a 600s per-bash timeout and no other bundled role gets one", () => {
	const bundled = loadAgentsFromDir(BUILTIN_AGENTS_DIR, "builtin");
	const scout = bundled.find((agent) => agent.name === "scout");
	assert.ok(scout, "the bundled scout role must load");
	assert.equal(scout.toolTimeoutMs, 600_000);
	assert.ok(
		!(scout.unenforcedFields ?? []).includes("toolTimeoutMs"),
		"toolTimeoutMs is applied by the child-guard, so the scout card must not report it as inert",
	);

	// The trade-off is deliberate: worker / centurion run full builds,
	// test suites and integration gates, where killing a slow-but-progressing
	// command costs more than the hang it would prevent.
	for (const name of ["worker", "centurion"]) {
		const role = bundled.find((agent) => agent.name === name);
		assert.ok(role, `${name} must load`);
		assert.equal(
			role.toolTimeoutMs,
			undefined,
			`${name} must keep no default bash timeout`,
		);
	}
});
