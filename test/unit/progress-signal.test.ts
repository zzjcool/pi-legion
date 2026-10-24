/**
 * W1 — renewal progress measurement (contract: docs/contracts/subagent-renewal-v1.md,
 * D2 / D2-a thresholds / D8 baseline reset).
 *
 * Fixture rows mirror a measured session file
 * (`.pi-subagents/runs/r-4ea9cadf/worker-0.jsonl`): every row is
 * `{"type":"message","id","parentId","timestamp","message":{"role":...}}`,
 * the row kind living in `message.role` (`assistant` / `toolResult` / `user` /
 * `system`), preceded by `session` / `model_change` / `thinking_level_change`
 * header events.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
	PROGRESS_MIN_FILES_CHANGED,
	PROGRESS_MIN_TOOL_RESULTS,
	measureProgress,
	readSessionLines,
	type ProgressBaseline,
} from "../../src/runs/progress-signal.ts";

// ---------------------------------------------------------------------------
// Fixtures — measured shape, no home-grown schema
// ---------------------------------------------------------------------------

function row(role: string, extra: Record<string, unknown> = {}): string {
	return JSON.stringify({
		type: "message",
		id: `r-${role}`,
		parentId: null,
		timestamp: "2026-10-18T10:41:52.704Z",
		message: { role, content: [], ...extra },
	});
}

const sessionHeader = (): string =>
	JSON.stringify({
		type: "session",
		version: 3,
		id: "01a14e9a-78df-7607-a6f1-88ac456a1d6f",
		timestamp: "2026-10-18T10:41:48.768Z",
		cwd: "/tmp/project",
	});

const modelChange = (): string =>
	JSON.stringify({
		type: "model_change",
		id: "f3963151",
		parentId: null,
		timestamp: "2026-10-18T10:41:49.401Z",
		provider: "any-endpoint",
		modelId: "workbuddy/deepseek-v4.1-flash",
	});

const thinkingLevel = (): string =>
	JSON.stringify({
		type: "thinking_level_change",
		id: "8378a182",
		parentId: "f3963151",
		timestamp: "2026-10-18T10:41:49.401Z",
		thinkingLevel: "max",
	});

const assistantRow = (): string => row("assistant", { stopReason: "stop", model: "test/glm-5.3" });
const systemRow = (): string => row("system");
const userRow = (): string => row("user");
const toolResultRow = (): string =>
	row("toolResult", {
		toolCallId: "call_00_x",
		toolName: "read",
		isError: false,
		content: [{ type: "text", text: "ok" }],
	});

/** N tool-result rows / M assistant rows, appended after the header block. */
function sessionText(opts: { toolResults?: number; assistants?: number; trailing?: string } = {}): string {
	const lines: string[] = [sessionHeader(), modelChange(), thinkingLevel(), systemRow(), userRow()];
	for (let i = 0; i < (opts.assistants ?? 0); i += 1) lines.push(assistantRow());
	for (let i = 0; i < (opts.toolResults ?? 0); i += 1) lines.push(toolResultRow());
	if (opts.trailing !== undefined) lines.push(opts.trailing);
	return lines.join("\n") + "\n";
}

const BASELINE_AT = 1_760_000_000_000;

/** Baseline whose `lines` sits at the end of `text` (0 new rows). */
function baselineAtEndOf(text: string): ProgressBaseline {
	const lines = text.split("\n").filter((line) => line !== "");
	return { at: BASELINE_AT, lines: lines.length };
}

function measure(
	text: string | undefined,
	baseline: ProgressBaseline,
	opts: { filesChanged?: () => number | undefined } = {},
) {
	return measureProgress({
		sessionFile: "/tmp/session.jsonl",
		baseline,
		readLines: () => (text === undefined ? undefined : text.split("\n").filter((line) => line !== "")),
		...(opts.filesChanged ? { countFilesChanged: opts.filesChanged } : {}),
	});
}

// ---------------------------------------------------------------------------
// A7 — D2-a threshold boundary: 3 tool results (or 1 file) is the bar
// ---------------------------------------------------------------------------

test("A7: thresholds are exported as 3 tool results / 1 file", () => {
	assert.equal(PROGRESS_MIN_TOOL_RESULTS, 3);
	assert.equal(PROGRESS_MIN_FILES_CHANGED, 1);
});

test("A7: 2 new tool results do not count as progress", () => {
	const measure2 = measure(sessionText({ toolResults: 2 }), { at: BASELINE_AT, lines: 0 });
	assert.equal(measure2.toolResults, 2);
	assert.equal(measure2.assistantMessages, 0);
	assert.equal(measure2.progressed, false);
});

test("A7: 3 new tool results count as progress", () => {
	const measure3 = measure(sessionText({ toolResults: 3 }), { at: BASELINE_AT, lines: 0 });
	assert.equal(measure3.toolResults, 3);
	assert.equal(measure3.progressed, true);
});

test("A7: a single changed file alone counts as progress", () => {
	const result = measure(sessionText({}), { at: BASELINE_AT, lines: 0 }, { filesChanged: () => 1 });
	assert.equal(result.toolResults, 0);
	assert.equal(result.filesChanged, 1);
	assert.equal(result.progressed, true);
});

test("A7: assistant messages are counted but do not cross the threshold alone", () => {
	const result = measure(sessionText({ assistants: 5 }), { at: BASELINE_AT, lines: 0 });
	assert.equal(result.toolResults, 0);
	assert.equal(result.assistantMessages, 5);
	assert.equal(result.progressed, false);
});

// ---------------------------------------------------------------------------
// A2 (first half) — no new rows and no file changes means no progress
// ---------------------------------------------------------------------------

test("A2: zero new rows and zero file changes are not progress", () => {
	const text = sessionText({ toolResults: 4, assistants: 2 });
	const result = measure(text, baselineAtEndOf(text), { filesChanged: () => 0 });
	assert.equal(result.toolResults, 0);
	assert.equal(result.assistantMessages, 0);
	assert.equal(result.filesChanged, 0);
	assert.equal(result.progressed, false);
});

// ---------------------------------------------------------------------------
// A6 / D8 — history before baseline.lines is never counted
// ---------------------------------------------------------------------------

test("A6/D8: rows before baseline.lines are ignored (long history, nothing new)", () => {
	const history: string[] = [sessionHeader(), modelChange(), thinkingLevel()];
	for (let i = 0; i < 200; i += 1) {
		history.push(userRow(), assistantRow(), toolResultRow());
	}
	const text = history.join("\n") + "\n";
	const result = measure(text, baselineAtEndOf(text));
	assert.equal(result.toolResults, 0);
	assert.equal(result.assistantMessages, 0);
	assert.equal(result.progressed, false);
});

test("A6/D8: only rows after baseline.lines are counted", () => {
	const before = [sessionHeader(), modelChange(), thinkingLevel(), userRow()];
	for (let i = 0; i < 50; i += 1) before.push(assistantRow(), toolResultRow());
	const baseline: ProgressBaseline = { at: BASELINE_AT, lines: before.length };
	const after = [toolResultRow(), toolResultRow(), assistantRow()];
	const text = [...before, ...after].join("\n") + "\n";
	const result = measure(text, baseline);
	assert.equal(result.toolResults, 2);
	assert.equal(result.assistantMessages, 1);
	assert.equal(result.progressed, false);
});

test("A6/D8: a baseline past the current line count counts nothing", () => {
	const text = sessionText({ toolResults: 9, assistants: 9 });
	const result = measure(text, { at: BASELINE_AT, lines: 10_000 });
	assert.equal(result.toolResults, 0);
	assert.equal(result.assistantMessages, 0);
	assert.equal(result.progressed, false);
});

// ---------------------------------------------------------------------------
// Tolerance — torn tail, unreadable file
// ---------------------------------------------------------------------------

test("tolerance: a torn final line is skipped instead of throwing", () => {
	const torn = '{"type":"message","id":"9a17dc20","message":{"role":"assistant","content":[{"type":"te';
	const text = sessionText({ toolResults: 3 }) + torn;
	const result = measure(text, { at: BASELINE_AT, lines: 0 });
	assert.equal(result.toolResults, 3);
	assert.equal(result.progressed, true);
});

test("tolerance: non-JSON and non-message rows are skipped", () => {
	const text = [sessionHeader(), "not json at all", "", "[1,2,3]", "null", toolResultRow(), toolResultRow(), toolResultRow()].join("\n");
	const result = measure(text, { at: BASELINE_AT, lines: 0 });
	assert.equal(result.toolResults, 3);
	assert.equal(result.progressed, true);
});

test("tolerance: unreadable session file reports zeros and no progress", () => {
	const result = measure(undefined, { at: BASELINE_AT, lines: 7 });
	assert.equal(result.toolResults, 0);
	assert.equal(result.assistantMessages, 0);
	assert.equal(result.filesChanged, undefined);
	assert.equal(result.progressed, false);
});

test("tolerance: default reader returns undefined for a missing file", () => {
	assert.equal(readSessionLines("/tmp/pi-legion-does-not-exist-progress.jsonl"), undefined);
});

test("tolerance: flat legacy row types are recognised too", () => {
	const text = [
		JSON.stringify({ type: "toolResult", toolName: "bash" }),
		JSON.stringify({ type: "toolResult", toolName: "bash" }),
		JSON.stringify({ type: "toolResult", toolName: "bash" }),
	].join("\n");
	const result = measure(text, { at: BASELINE_AT, lines: 0 });
	assert.equal(result.toolResults, 3);
	assert.equal(result.progressed, true);
});

// ---------------------------------------------------------------------------
// filesChanged === undefined — unmeasurable, so it cannot sway the verdict
// ---------------------------------------------------------------------------

test("filesChanged undefined: 2 tool results still means no progress", () => {
	const result = measure(sessionText({ toolResults: 2 }), { at: BASELINE_AT, lines: 0 });
	assert.equal(result.filesChanged, undefined);
	assert.equal(result.progressed, false);
});

test("filesChanged undefined: 3 tool results still means progress", () => {
	const result = measure(sessionText({ toolResults: 3 }), { at: BASELINE_AT, lines: 0 }, { filesChanged: () => undefined });
	assert.equal(result.filesChanged, undefined);
	assert.equal(result.progressed, true);
});

test("filesChanged undefined: unreadable file with a live worktree count still measures files", () => {
	const result = measure(undefined, { at: BASELINE_AT, lines: 0 }, { filesChanged: () => 2 });
	assert.equal(result.filesChanged, 2);
	assert.equal(result.progressed, true);
});
