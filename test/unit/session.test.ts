/**
 * W4 tests for src/shared/session.ts — written from IMPLEMENTATION.md's spec
 * (docs/design.md §3.4, findings F12/F26–F31), not from the implementation.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	ABORT_WITHOUT_REASON,
	attributeParentSessionShutdown,
	deriveOutcome,
	NO_ASSISTANT_ABORT_REASON,
	PARENT_SESSION_SHUTDOWN_ABORT_REASON,
	extractVerdict,
	isTransientConnectionFailure,
	parseSessionFile,
	parseSessionText,
	resolveSessionMaxLineBytes,
	DEFAULT_SESSION_MAX_LINE_BYTES,
} from "../../src/shared/session.ts";
import {
	assistantMsg,
	modelChange,
	sessionHeader,
	tornLine,
	toolResult,
	userMsg,
} from "../helpers/fixtures.ts";
import { withTempDir } from "../helpers/tmp.ts";

const parseLines = (...lines: string[]) => parseSessionText(lines.filter(Boolean).join("\n"));

// ── Required test cases (session) ─────────────────────────────────────────────

test("success turn → status success", () => {
	const parsed = parseLines(sessionHeader(), modelChange("cb/glm-5.3-flash"), userMsg("do it"), assistantMsg({ stopReason: "stop", text: "done" }));
	assert.equal(deriveOutcome(parsed).status, "success");
});

test("stopReason error + message → failed, errorMessage preserved", () => {
	const parsed = parseLines(userMsg("do it"), assistantMsg({ stopReason: "error", errorMessage: "400 bad model: nope" }));
	const outcome = deriveOutcome(parsed);
	assert.equal(outcome.status, "failed");
	assert.equal(outcome.errorMessage, "400 bad model: nope");
	assert.equal(outcome.stopReason, "error");
});

test("Connection error is a transient blip; other failures are not", () => {
	assert.equal(isTransientConnectionFailure("Connection error."), true);
	assert.equal(isTransientConnectionFailure("Error: Connection error."), true);
	assert.equal(isTransientConnectionFailure({ reason: "Connection error.", errorMessage: null }), true);
	assert.equal(isTransientConnectionFailure({ errorMessage: "APIConnectionError: Connection error." }), true);
	assert.equal(isTransientConnectionFailure("provider failure"), false);
	assert.equal(isTransientConnectionFailure("connection refused"), false);
	assert.equal(isTransientConnectionFailure(deriveOutcome(parseLines(userMsg("do it"), assistantMsg({ stopReason: "error", errorMessage: "Connection error." })))), true);
	assert.equal(isTransientConnectionFailure(deriveOutcome(parseLines(userMsg("do it"), assistantMsg({ stopReason: "error", errorMessage: "400 bad model: nope" })))), false);
});

test("stopReason error + message containing aborted → aborted (F29)", () => {
	const parsed = parseLines(userMsg("do it"), assistantMsg({ stopReason: "error", errorMessage: "This operation was aborted" }));
	const outcome = deriveOutcome(parsed);
	assert.equal(outcome.status, "aborted");
});

test("stopReason length → truncated", () => {
	const parsed = parseLines(userMsg("write a lot"), assistantMsg({ stopReason: "length", text: "partial..." }));
	assert.equal(deriveOutcome(parsed).status, "truncated");
});

test("stopReason toolUse as last assistant → aborted (killed mid-tool)", () => {
	const parsed = parseLines(userMsg("do it"), assistantMsg({ stopReason: "toolUse", tools: ["bash"] }));
	assert.equal(deriveOutcome(parsed).status, "aborted");
});

test("user msg with no assistant reply → aborted, lastTurnMissing true (F29)", () => {
	const parsed = parseLines(userMsg("do it"));
	assert.equal(parsed.lastTurnMissing, true);
	const outcome = deriveOutcome(parsed);
	assert.equal(outcome.status, "aborted");
	assert.equal(outcome.reason, NO_ASSISTANT_ABORT_REASON);
	const shutdown = attributeParentSessionShutdown(outcome, parsed);
	assert.equal(shutdown.status, "aborted");
	assert.equal(shutdown.reason, PARENT_SESSION_SHUTDOWN_ABORT_REASON);
	const settled = deriveOutcome(parseLines(userMsg("do it"), assistantMsg({ stopReason: "stop", text: "done" })));
	assert.equal(attributeParentSessionShutdown(settled, parseLines(userMsg("do it"), assistantMsg({ stopReason: "stop", text: "done" }))).reason, undefined);
});

test("no messages at all → unknown", () => {
	assert.equal(deriveOutcome(parseLines()).status, "unknown");
	assert.equal(deriveOutcome(parseSessionText("")).status, "unknown");
});

test("turn1 tool error (isError:true), turn2 clean stop → success, toolErrors 1 (F30/F31)", () => {
	const parsed = parseLines(
		userMsg("run bash"),
		assistantMsg({ stopReason: "toolUse", tools: ["bash"] }),
		toolResult({ isError: true }),
		assistantMsg({ stopReason: "stop", text: "recovered and finished" }),
		userMsg("continue"),
		assistantMsg({ stopReason: "stop", text: "all done" }),
	);
	const outcome = deriveOutcome(parsed);
	assert.equal(outcome.status, "success");
	assert.equal(parsed.toolErrors, 1);
	assert.equal(outcome.toolErrors, 1);
	// F31: only the LAST turn decides; lastTurn reflects turn 2.
	assert.equal(outcome.lastTurn?.stopReason, "stop");
	assert.equal(outcome.lastTurn?.toolErrors, 0);
});

test("torn/truncated JSON line → counted in tornLines, does not throw (F12)", () => {
	const parsed = parseLines(userMsg("do it"), tornLine(), assistantMsg({ stopReason: "stop" }));
	assert.equal(parsed.tornLines, 1);
	assert.doesNotThrow(() => deriveOutcome(parsed));
	// The good assistant message after the torn line still counts.
	assert.equal(deriveOutcome(parsed).status, "success");
});

test("usage accumulation across 3 assistant messages", () => {
	const parsed = parseLines(
		userMsg("multi"),
		assistantMsg({
			stopReason: "toolUse",
			tools: ["bash"],
			usage: { input: 100, output: 10, cacheRead: 5, cacheWrite: 7, cost: { total: 0.01 } },
		}),
		toolResult(),
		assistantMsg({
			stopReason: "toolUse",
			tools: ["read"],
			usage: { input: 200, output: 20, cacheRead: 6, cacheWrite: 8, cost: { total: 0.02 } },
		}),
		toolResult(),
		assistantMsg({
			stopReason: "stop",
			text: "final",
			usage: { input: 300, output: 30, cacheRead: 9, cacheWrite: 11, cost: { total: 0.03 } },
		}),
	);
	assert.deepEqual(parsed.usage, {
		input: 600,
		output: 60,
		cacheRead: 20,
		cacheWrite: 26,
		cost: 0.06,
	});
});

test("unknown stopReason value → failed with a reason", () => {
	const parsed = parseLines(userMsg("do it"), assistantMsg({ stopReason: "warp-drive" }));
	const outcome = deriveOutcome(parsed);
	assert.equal(outcome.status, "failed");
	assert.match(outcome.reason ?? "", /unknown stopReason/);
});

test('extractVerdict(\'{"ok":false,"reason":"x"}\') → {ok:false, reason:"x"} (F33)', () => {
	assert.deepEqual(extractVerdict('{"ok":false,"reason":"x"}'), { ok: false, reason: "x" });
});

test('extractVerdict("plain text") → null', () => {
	assert.equal(extractVerdict("plain text"), null);
});

test("extractVerdict on fenced ```json block parses the JSON inside", () => {
	assert.deepEqual(
		extractVerdict('Here is my verdict:\n```json\n{"ok":true,"reason":"all green"}\n```'),
		{ ok: true, reason: "all green" },
	);
	// Fence without the `json` tag also works.
	assert.deepEqual(extractVerdict('```\n{"ok":false}\n```'), { ok: false });
});

// ── Supplementary behaviour required by the spec text ─────────────────────────

test("model_change header populates parsed.model before any assistant message", () => {
	const parsed = parseLines(sessionHeader(), modelChange("cb/glm-5.3-flash"));
	assert.equal(parsed.model, "cb/glm-5.3-flash");
	assert.equal(parsed.turns.length, 0);
	assert.equal(deriveOutcome(parsed).status, "unknown");
});

test("assistant model overrides an earlier model_change", () => {
	const parsed = parseLines(
		modelChange("cb/old"),
		userMsg("go"),
		assistantMsg({ stopReason: "stop", text: "ok", model: "cb/new" }),
	);
	assert.equal(parsed.model, "cb/new");
});

test("parseSessionFile: missing file → empty ParsedSession (no throw)", () => {
	const parsed = parseSessionFile("/nonexistent/path/session.jsonl");
	assert.equal(parsed.output, "");
	assert.equal(parsed.model, null);
	assert.equal(parsed.stopReason, null);
	assert.equal(parsed.turns.length, 0);
	assert.equal(parsed.tornLines, 0);
	assert.equal(parsed.lastTurnMissing, false);
});

test("parseSessionFile: real file round-trips like text", async () => {
	await withTempDir((dir) => {
		const file = path.join(dir, "worker-1.jsonl");
		fs.writeFileSync(
			file,
			[sessionHeader(), userMsg("go"), assistantMsg({ stopReason: "stop", text: "ok", model: "cb/glm-5.3-flash" })].join("\n"),
		);
		const parsed = parseSessionFile(file);
		assert.equal(parsed.output, "ok");
		assert.equal(parsed.model, "cb/glm-5.3-flash");
		assert.equal(parsed.stopReason, "stop");
		assert.equal(parsed.turns.length, 1);
	});
});

test("F32: agent self-reporting failure still has stopReason stop → mechanically success", () => {
	const parsed = parseLines(userMsg("task"), assistantMsg({ stopReason: "stop", text: 'FAILED: could not complete. {"ok": false, "reason": "missing input file"}' }));
	assert.equal(deriveOutcome(parsed).status, "success");
	// L2: the verdict extractor is what catches this.
	assert.deepEqual(extractVerdict(parsed.output), { ok: false, reason: "missing input file" });
});

test("extractVerdict ignores non-verdict JSON objects", () => {
	assert.equal(extractVerdict('{"result": 1, "ok": "yes"}'), null);
	assert.equal(extractVerdict('[1,2,3]'), null);
	assert.equal(extractVerdict(""), null);
});

test("turn boundaries are split by user messages; per-turn stats are independent", () => {
	const parsed = parseLines(
		userMsg("t1"),
		assistantMsg({ stopReason: "toolUse", tools: ["bash"] }),
		toolResult({ isError: true }),
		toolResult({ isError: true }),
		assistantMsg({ stopReason: "error", errorMessage: "boom" }),
		userMsg("t2"),
		assistantMsg({ stopReason: "stop", text: "fixed" }),
	);
	assert.equal(parsed.turns.length, 2);
	const t1 = parsed.turns[0];
	const t2 = parsed.turns[1];
	assert.ok(t1 && t2);
	assert.equal(t1.toolErrors, 2);
	assert.equal(t2.toolErrors, 0);
	assert.equal(t1.assistants.length, 2);
	assert.equal(t2.userText, "t2");
	// F31: overall outcome comes from t2.
	assert.equal(deriveOutcome(parsed).status, "success");
});

test("hard kill mid-turn: user msg then only toolResult, no assistant → aborted", () => {
	const parsed = parseLines(userMsg("do it"), assistantMsg({ stopReason: "toolUse", tools: ["bash"] }));
	// In reality the file would be cut here — model the truncation:
	const truncated = parseLines(userMsg("do it"), assistantMsg({ stopReason: "toolUse" }));
	assert.equal(deriveOutcome(truncated).status, "aborted");
	assert.ok(parsed);
});

test("toolResult before any user message does not crash", () => {
	const parsed = parseLines(toolResult({ isError: true }), assistantMsg({ stopReason: "stop" }));
	assert.equal(parsed.toolErrors, 0); // dropped (no turn to attach to)
	assert.doesNotThrow(() => deriveOutcome(parsed));
});

// ─────────────────────────────────────────────────────────────────────────────
// BUG 18: `JSON.parse` succeeds on bare scalars, so a session line of `null`
// produced `null`, and reading `null.type` threw — taking down the entire parse
// (and therefore `collect`). The session file is external input: a pane can be
// closed mid-write, and a file can be truncated or hand-edited.
// ─────────────────────────────────────────────────────────────────────────────

test("scalar JSON lines are treated as damaged, never crash the parse", () => {
	const scalars = ["null", "42", "true", "false", '"a string"', "[]", "[1,2]"];
	for (const scalar of scalars) {
		// Each scalar is counted as a torn line; the parse must not throw.
		const parsed = parseSessionText(`${scalar}\n`);
		assert.equal(
			parsed.turns.length,
			0,
			`${scalar} must not produce a turn`,
		);
		assert.equal(
			parsed.tornLines,
			1,
			`${scalar} must be counted as a damaged line`,
		);
	}
});

test("a null line does not prevent the valid lines around it from parsing", () => {
	const text = [
		sessionHeader(),
		userMsg("go"),
		"null",
		assistantMsg({ stopReason: "stop", text: "done" }),
	].join("\n");
	const parsed = parseSessionText(text);
	assert.equal(parsed.tornLines, 1, "the null line is counted as damaged");
	assert.equal(parsed.turns.length, 1, "the surrounding turn still parses");
	assert.equal(deriveOutcome(parsed).status, "success");
});

test("parseSessionText never throws on hostile input", () => {
	const cases = [
		"",
		"\n\n\n",
		"not json at all",
		'{"type":"message","mess',
		"null",
		"[1,2,3]",
		'"x"',
		"42",
		'{"type":"message","message":null}',
		'{"type":"message","message":{"role":"assistant","content":null}}',
		'{"type":"message","message":{"role":"assistant","content":[null]}}',
		'{"type":"message","message":{"role":"user","content":[{"type":"text"}]}}',
		'{"type":"message","message":{"role":"assistant","usage":{"cost":null}}}',
		'{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"🎉"}]}}',
		`{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"${"x".repeat(100_000)}"}]}}`,
	];
	for (const input of cases) {
		assert.doesNotThrow(
			() => deriveOutcome(parseSessionText(input)),
			`must not throw on: ${input.slice(0, 60)}`,
		);
	}
});

test("turn records capture user/assistant message timestamps (current-turn elapsed)", () => {
	const parsed = parseLines(
		userMsg("first", { timestamp: 1_000 }),
		assistantMsg({ stopReason: "stop", text: "ok", timestamp: 2_500 }),
		userMsg("second", { timestamp: 10_000 }),
		assistantMsg({ stopReason: "toolUse", tools: ["bash"], timestamp: 11_000 }),
	);
	assert.equal(parsed.turns[0]?.startedAt, 1_000);
	assert.equal(parsed.turns[0]?.endedAt, 2_500);
	assert.equal(parsed.turns[1]?.startedAt, 10_000);
	assert.equal(parsed.turns[1]?.endedAt, 11_000);
});

test("turn timestamps fall back to the ISO entry timestamp, then stay absent", () => {
	const iso = JSON.stringify({
		type: "message",
		timestamp: "2024-12-03T14:00:01.000Z",
		message: { role: "user", content: "entry ts only" },
	});
	const fromEntry = parseLines(iso);
	assert.equal(fromEntry.turns[0]?.startedAt, Date.parse("2024-12-03T14:00:01.000Z"));

	const bare = parseLines(userMsg("no timestamps at all"));
	assert.equal(bare.turns[0]?.startedAt, undefined);
	assert.equal(bare.turns[0]?.endedAt, undefined);
});

test("resolveSessionMaxLineBytes: floored value below 1 falls back (#174)", () => {
	assert.equal(resolveSessionMaxLineBytes({}), DEFAULT_SESSION_MAX_LINE_BYTES);
	assert.equal(resolveSessionMaxLineBytes({ PI_LEGION_SESSION_MAX_LINE_BYTES: "0.5" }), DEFAULT_SESSION_MAX_LINE_BYTES);
	assert.equal(resolveSessionMaxLineBytes({ PI_LEGION_SESSION_MAX_LINE_BYTES: "0" }), DEFAULT_SESSION_MAX_LINE_BYTES);
	assert.equal(resolveSessionMaxLineBytes({ PI_LEGION_SESSION_MAX_LINE_BYTES: "1" }), 1);
	assert.equal(resolveSessionMaxLineBytes({ PI_LEGION_SESSION_MAX_LINE_BYTES: "1.9" }), 1);
	assert.equal(resolveSessionMaxLineBytes({ PI_LEGION_SESSION_MAX_LINE_BYTES: "1024.5" }), 1024);
	assert.equal(resolveSessionMaxLineBytes({ PI_LEGION_SESSION_MAX_LINE_BYTES: "abc" }), DEFAULT_SESSION_MAX_LINE_BYTES);
});


// ── #227 D3b: a reason-less abort must be readable as the parent's abort ─────

test("stopReason error + bare abort message → aborted with ABORT_WITHOUT_REASON (#227 D3b)", () => {
	// Upstream writes a reason-less AbortController cancellation as
	// `stopReason:"error"` + the engine's bare message. Before D3b that was
	// indistinguishable from a real provider failure; only the reason changes,
	// the status stays `aborted` (the assertion above at "F29" is unchanged).
	for (const message of [
		"This operation was aborted",
		"The operation was aborted",
		"operation aborted",
	]) {
		const outcome = deriveOutcome(parseLines(userMsg("do it"), assistantMsg({ stopReason: "error", errorMessage: message })));
		assert.equal(outcome.status, "aborted", `${message} stays aborted`);
		assert.equal(outcome.reason, ABORT_WITHOUT_REASON, `${message} names the reason-less abort`);
		assert.equal(outcome.errorMessage, message, "the original engine message stays observable");
	}
});

test("an aborted message that carries a reason is not rewritten (#227 D3b)", () => {
	// The new branch is anchored to the whole message and must not swallow a
	// timeout (or any longer, meaningful) abort: those keep their own text.
	const timeout = deriveOutcome(parseLines(
		userMsg("do it"),
		assistantMsg({ stopReason: "error", errorMessage: "The operation was aborted due to timeout" }),
	));
	assert.equal(timeout.status, "aborted");
	assert.notEqual(timeout.reason, ABORT_WITHOUT_REASON, "a timeout is not a reason-less parent abort");
	assert.equal(timeout.reason, "The operation was aborted due to timeout");

	const longer = deriveOutcome(parseLines(
		userMsg("do it"),
		assistantMsg({ stopReason: "error", errorMessage: "This operation was aborted by the provider" }),
	));
	assert.notEqual(longer.reason, ABORT_WITHOUT_REASON, "a longer message keeps its own text");
});
