/**
 * #315 — "the process is alive but no longer progressing" was invisible.
 *
 * `liveness()` calls any child holding a non-terminal handle live, the heartbeat
 * refreshes for exactly those children, and the orphan scan exempts a node whose
 * first root child is alive. So a child stuck inside one tool call looks
 * identical to one doing useful work, and the parent finds out only when its
 * `collect` deadline (900s) fires.
 *
 * The fix is one **display-only** fact per child: the tool calls it is inside
 * right now (a LIFO stack since #331), plus the host clock reading when each
 * started. Nothing here decides liveness and nothing here kills, steers or
 * retires anything — these tests pin that boundary as much as the rendering.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
	STALL_NOTICE_MS,
	type ChildActivity,
	formatInFlightToolLine,
	formatToolElapsed,
	nextInFlightTool,
} from "../../src/supervisor/types.ts";
import { loadAgentsFromDir, BUILTIN_AGENTS_DIR } from "../../src/agents/agents.ts";

/** One stack frame; keeps the tests readable without inventing helper types. */
function frame(
	tool: string,
	startedAt: number,
	ids: { toolCallId?: string; parentToolCallId?: string } = {},
): ChildActivity {
	return { tool, startedAt, ...ids };
}

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
	assert.equal(
		formatInFlightToolLine([frame("bash", 1_000)], 1_000 + 7_000),
		"working · bash 00:00:07",
	);
	// One millisecond short of the bound: still just the line.
	assert.equal(
		formatInFlightToolLine([frame("bash", 1_000)], 1_000 + STALL_NOTICE_MS - 1),
		"working · bash 00:04:59",
	);
	// An unusable clock must read as "just started", never as a stall verdict:
	// `NaN < bound` is false, so the raw subtraction would skip the short path and
	// claim `no progress for NaNm` — a verdict invented from a missing fact.
	assert.equal(
		formatInFlightToolLine([frame("bash", Number.NaN)], 1_000),
		"working · bash 00:00:00",
	);
	assert.equal(
		formatInFlightToolLine([frame("bash", 1_000)], Number.NaN),
		"working · bash 00:00:00",
	);
	// No frames at all is no fact: the caller renders no line.
	assert.equal(formatInFlightToolLine([], 1_000), "");
});

test("a tool at or past STALL_NOTICE_MS appends the display-only marker", () => {
	const activity = frame("bash", 0);
	const atBound = formatInFlightToolLine([activity], STALL_NOTICE_MS);
	assert.equal(
		atBound,
		"working · bash 00:05:00 (long-running tool — no progress for 5m; `steer` cannot interrupt it, `abort` can)",
	);
	// The marker counts whole minutes past the bound, not seconds.
	assert.match(formatInFlightToolLine([activity], 12 * 60_000), /no progress for 12m;/);
	// The tool name is carried through untouched.
	assert.match(
		formatInFlightToolLine([frame("codemode", 0)], STALL_NOTICE_MS),
		/^working · codemode /,
	);
});

test("#331: nesting is named from the top frame's parent chain", () => {
	// codemode → bash: the inner call is INSIDE the outer one, so the line says
	// so and counts both frames.
	const nested = [frame("codemode", 0, { toolCallId: "c1" }), frame("bash", 0, { toolCallId: "c2", parentToolCallId: "c1" })];
	assert.equal(
		formatInFlightToolLine(nested, 5_000),
		"working · bash 00:00:05 (inside codemode ×2)",
	);
	// Three levels deep: the outermost frame is the one that encloses everything.
	const deep = [
		frame("codemode", 0, { toolCallId: "c1" }),
		frame("bash", 0, { toolCallId: "c2", parentToolCallId: "c1" }),
		frame("read", 0, { toolCallId: "c3", parentToolCallId: "c2" }),
	];
	assert.equal(
		formatInFlightToolLine(deep, 5_000),
		"working · read 00:00:05 (inside codemode ×3)",
	);
});

test("#331: parallel siblings are counted, never called `inside`", () => {
	// Two independent calls: the newest is the one displayed, the other is a
	// sibling still running — NOT an enclosing call.
	const parallel = [frame("read", 0, { toolCallId: "c1" }), frame("bash", 0, { toolCallId: "c2" })];
	assert.equal(
		formatInFlightToolLine(parallel, 5_000),
		"working · bash 00:00:05 (+1 more)",
	);
	// Without parent ids a second frame cannot be told apart from a nested one,
	// so it is reported as the weaker, always-true claim.
	assert.ok(!formatInFlightToolLine(parallel, 5_000).includes("inside"));
	// Both hints can appear at once: one enclosing call, one sibling.
	const mixed = [
		frame("codemode", 0, { toolCallId: "c1" }),
		frame("read", 0, { toolCallId: "c9" }),
		frame("bash", 0, { toolCallId: "c2", parentToolCallId: "c1" }),
	];
	assert.equal(
		formatInFlightToolLine(mixed, 5_000),
		"working · bash 00:00:05 (inside codemode ×2) (+1 more)",
	);
	// The stall marker stays last, after the context hints.
	assert.equal(
		formatInFlightToolLine(parallel, STALL_NOTICE_MS),
		"working · bash 00:05:00 (+1 more) (long-running tool — no progress for 5m; `steer` cannot interrupt it, `abort` can)",
	);
});

// ─────────────────────── the event-stream fold ───────────────────────

test("nextInFlightTool pushes on start, keeps on unrelated events, removes the named end", () => {
	const started = nextInFlightTool(
		[],
		{ type: "tool_execution_start", toolName: "bash", toolCallId: "c1" },
		5_000,
	);
	assert.deepEqual(started, [{ tool: "bash", startedAt: 5_000, toolCallId: "c1" }]);

	// Anything that is not a tool boundary leaves the stack exactly as it was:
	// this is what lets both backends call the fold on every single event.
	for (const type of ["turn_start", "message_update", "agent_start", "unknown"]) {
		assert.deepEqual(nextInFlightTool(started, { type }, 6_000), started);
	}

	assert.deepEqual(
		nextInFlightTool(started, { type: "tool_execution_end", toolCallId: "c1" }, 7_000),
		[],
	);
	// An end with no live call is a no-op, not an error.
	assert.deepEqual(
		nextInFlightTool([], { type: "tool_execution_end", toolCallId: "c1" }, 7_000),
		[],
	);
	// `agent_settled` empties the whole stack: an aborted tool may never send its
	// own end, and a settled turn holds no tool.
	assert.deepEqual(nextInFlightTool(started, { type: "agent_settled" }, 8_000), []);
});

test("nextInFlightTool: a start without a usable tool name does not invent one", () => {
	const started = nextInFlightTool(
		[],
		{ type: "tool_execution_start", toolName: "read", toolCallId: "c1" },
		1_000,
	);
	assert.deepEqual(
		nextInFlightTool(started, { type: "tool_execution_start" }, 2_000),
		started,
		"a start with no toolName must not add, clear or replace a frame",
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

test("#331 nested codemode → bash: the inner end keeps the outer call on screen", () => {
	let stack = nextInFlightTool(
		[],
		{ type: "tool_execution_start", toolName: "codemode", toolCallId: "c1" },
		1_000,
	);
	stack = nextInFlightTool(
		stack,
		{ type: "tool_execution_start", toolName: "bash", toolCallId: "c2", parentToolCallId: "c1" },
		2_000,
	);
	assert.deepEqual(stack.map((entry) => entry.tool), ["codemode", "bash"]);
	assert.equal(formatInFlightToolLine(stack, 5_000), "working · bash 00:00:03 (inside codemode ×2)");

	// The inner end removes ONLY its own frame. Before #331 this wiped the slot
	// and `status` printed no line at all while codemode was still running.
	stack = nextInFlightTool(stack, { type: "tool_execution_end", toolCallId: "c2" }, 6_000);
	assert.deepEqual(stack.map((entry) => entry.tool), ["codemode"], "the outer call is still in flight");
	assert.equal(formatInFlightToolLine(stack, 6_000), "working · codemode 00:00:05");

	// The outer end then empties it.
	assert.deepEqual(nextInFlightTool(stack, { type: "tool_execution_end", toolCallId: "c1" }, 7_000), []);
});

test("#331 a parallel sibling finishing does not erase the call still running", () => {
	const first = nextInFlightTool(
		[],
		{ type: "tool_execution_start", toolName: "read", toolCallId: "c1" },
		1_000,
	);
	const second = nextInFlightTool(
		first,
		{ type: "tool_execution_start", toolName: "bash", toolCallId: "c2" },
		2_000,
	);
	assert.deepEqual(second.map((entry) => entry.tool), ["read", "bash"]);

	// The DISPLAYED call (the newest) finishes first: the sibling must survive
	// and become the displayed one. Before #331 this left nothing to show.
	const afterDisplayed = nextInFlightTool(second, { type: "tool_execution_end", toolCallId: "c2" }, 3_000);
	assert.deepEqual(afterDisplayed.map((entry) => entry.tool), ["read"]);
	assert.equal(formatInFlightToolLine(afterDisplayed, 4_000), "working · read 00:00:03");

	// The older sibling ending first changes nothing about the displayed one.
	assert.deepEqual(
		nextInFlightTool(second, { type: "tool_execution_end", toolCallId: "c1" }, 3_000).map((entry) => entry.tool),
		["bash"],
	);

	// Both done: no frames, so the renderer emits no line at all.
	assert.deepEqual(nextInFlightTool(afterDisplayed, { type: "tool_execution_end", toolCallId: "c1" }, 4_000), []);
});

test("nextInFlightTool: an end without a matching id never erases a live named call", () => {
	const named = nextInFlightTool(
		[],
		{ type: "tool_execution_start", toolName: "bash", toolCallId: "c1" },
		1_000,
	);
	// A stranger's id matches no frame: leave the stack untouched rather than
	// erasing a call that is demonstrably still running.
	assert.deepEqual(
		nextInFlightTool(named, { type: "tool_execution_end", toolCallId: "c9" }, 2_000),
		named,
	);
	// An id-less end is taken at face value: pop the innermost frame.
	assert.deepEqual(nextInFlightTool(named, { type: "tool_execution_end" }, 2_000), []);
	// The same fallback applies when the live frame never had an id either side:
	// nothing to match on, so the end is taken at face value.
	assert.deepEqual(
		nextInFlightTool(
			nextInFlightTool([], { type: "tool_execution_start", toolName: "bash" }, 1_000),
			{ type: "tool_execution_end", toolCallId: "c9" },
			2_000,
		),
		[],
	);
});

test("#331 an unmatched end folds the unnamed frame, never a named one", () => {
	let stack = nextInFlightTool(
		[],
		{ type: "tool_execution_start", toolName: "bash" },
		1_000,
	);
	stack = nextInFlightTool(
		stack,
		{ type: "tool_execution_start", toolName: "read", toolCallId: "c2" },
		2_000,
	);
	assert.deepEqual(stack.map((entry) => entry.tool), ["bash", "read"]);
	// `c9` names no frame, so the fold may only fall back to the frame that never
	// got an id: the named `read(c2)` is demonstrably still running and must stay.
	assert.deepEqual(
		nextInFlightTool(stack, { type: "tool_execution_end", toolCallId: "c9" }, 3_000),
		[{ tool: "read", startedAt: 2_000, toolCallId: "c2" }],
		"an unmatched end removes only the unnamed frame",
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
