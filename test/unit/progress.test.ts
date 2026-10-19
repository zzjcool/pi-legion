import { test } from "node:test";
import assert from "node:assert/strict";
import {
	mergeProgress,
	progressFromSession,
} from "../../src/shared/progress.ts";
import { parseSessionText } from "../../src/shared/session.ts";
import {
	assistantMsg,
	modelChange,
	sessionHeader,
	toolResult,
	userMsg,
} from "../helpers/fixtures.ts";

test("progressFromSession: model_change is enough before any assistant message", () => {
	const parsed = parseSessionText(
		[sessionHeader(), modelChange("cb/glm-5.3")].join("\n"),
	);
	assert.deepEqual(progressFromSession(parsed), { model: "cb/glm-5.3" });
});

test("progressFromSession: turns and in-flight tools come from the last assistant", () => {
	const parsed = parseSessionText(
		[
			sessionHeader(),
			modelChange("cb/glm-5.3"),
			userMsg("go"),
			assistantMsg({
				stopReason: "toolUse",
				tools: ["bash", "read"],
				model: "cb/glm-5.3",
			}),
			toolResult(),
			assistantMsg({
				stopReason: "toolUse",
				tools: ["edit"],
				model: "cb/glm-5.3",
			}),
		].join("\n"),
	);
	assert.deepEqual(progressFromSession(parsed), {
		model: "cb/glm-5.3",
		turns: 1,
		lastTools: ["edit"],
		usageTotal: 24,
		tokensOut: 4,
		// D4: the fixture's assistant carries input:10/cache:0, so the current
		// context size is 10. Adding the key makes this deepEqual STRONGER.
		contextTokens: 10,
	});
});

test("progressFromSession: a finished text turn does not keep stale tools", () => {
	const parsed = parseSessionText(
		[
			userMsg("go"),
			assistantMsg({ stopReason: "toolUse", tools: ["bash"] }),
			toolResult(),
			assistantMsg({ stopReason: "stop", text: "done" }),
		].join("\n"),
	);
	const live = progressFromSession(parsed);
	assert.equal(live.turns, 1);
	assert.equal(live.lastTools, undefined);
});

test("progressFromSession: in-flight turn exposes its start timestamp", () => {
	const parsed = parseSessionText(
		[
			userMsg("first", { timestamp: 1_000 }),
			assistantMsg({ stopReason: "stop", text: "ok", timestamp: 2_000 }),
			userMsg("second", { timestamp: 10_000 }),
			assistantMsg({ stopReason: "toolUse", tools: ["bash"], timestamp: 11_000 }),
		].join("\n"),
	);
	assert.deepEqual(progressFromSession(parsed), {
		model: "test/glm-5.3-flash",
		turns: 2,
		lastTools: ["bash"],
		currentTurnStartedAt: 10_000,
		usageTotal: 24,
		tokensOut: 4,
		// D4: last assistant carries input:10/cache:0 → context size 10.
		contextTokens: 10,
		generationMs: 2_000,
	});
});

test("progressFromSession: a settled last turn freezes its start and end", () => {
	const parsed = parseSessionText(
		[
			userMsg("go", { timestamp: 1_000 }),
			assistantMsg({ stopReason: "stop", text: "done", timestamp: 9_000 }),
		].join("\n"),
	);
	assert.equal(progressFromSession(parsed).currentTurnStartedAt, 1_000);
	assert.equal(progressFromSession(parsed).currentTurnEndedAt, 9_000);
});

test("progressFromSession: the next user message resets a frozen turn", () => {
	const parsed = parseSessionText(
		[
			userMsg("go", { timestamp: 1_000 }),
			assistantMsg({ stopReason: "stop", text: "done", timestamp: 9_000 }),
			userMsg("again", { timestamp: 20_000 }),
		].join("\n"),
	);
	assert.equal(progressFromSession(parsed).currentTurnStartedAt, 20_000);
	assert.equal(progressFromSession(parsed).currentTurnEndedAt, undefined);
	assert.equal(progressFromSession(parsed).turns, 2);
});

test("progressFromSession: a settled turn without an end timestamp is not frozen", () => {
	const parsed = parseSessionText(
		[
			userMsg("go", { timestamp: 1_000 }),
			assistantMsg({ stopReason: "stop", text: "done" }),
		].join("\n"),
	);
	assert.equal(progressFromSession(parsed).currentTurnStartedAt, undefined);
	assert.equal(progressFromSession(parsed).currentTurnEndedAt, undefined);
});

test("progressFromSession: timestamps are absent when the session omits them", () => {
	const parsed = parseSessionText(
		[userMsg("go"), assistantMsg({ stopReason: "toolUse", tools: ["bash"] })].join("\n"),
	);
	assert.equal(progressFromSession(parsed).currentTurnStartedAt, undefined);
});

test("progressFromSession: token usage includes input, cache, and output", () => {
	const parsed = parseSessionText(
		[
			sessionHeader(),
			userMsg("go"),
			assistantMsg({
				usage: { input: 100, cacheRead: 200, cacheWrite: 300, output: 400 },
			}),
		].join("\n"),
	);
	const live = progressFromSession(parsed);
	assert.equal(live.usageTotal, 1_000);
	assert.equal(live.tokensOut, 400);
});

test("progressFromSession: all-zero token usage stays absent", () => {
	const parsed = parseSessionText(
		[
			sessionHeader(),
			userMsg("go"),
			assistantMsg({
				usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
			}),
		].join("\n"),
	);
	const live = progressFromSession(parsed);
	assert.equal(live.usageTotal, undefined);
	assert.equal(live.tokensOut, undefined);
	assert.equal(live.generationMs, undefined);
});

test("mergeProgress: later sources win, empty parts do not clobber", () => {
	assert.deepEqual(
		mergeProgress(
			{ model: "launch/model" },
			{},
			{ model: "cursor/gpt-4.1", lastTools: ["edit"], turns: 3, usageTotal: 420, tokensOut: 80, generationMs: 5_000 },
		),
		{
			model: "cursor/gpt-4.1",
			lastTools: ["edit"],
			turns: 3,
			usageTotal: 420,
			tokensOut: 80,
			generationMs: 5_000,
		},
	);
});

test("mergeProgress: currentTurnStartedAt merges like other fields", () => {
	const merged = mergeProgress({ currentTurnStartedAt: 1_000 }, {}, { currentTurnStartedAt: 5_000 });
	assert.equal(merged.currentTurnStartedAt, 5_000);
	const kept = mergeProgress({ currentTurnStartedAt: 1_000 }, {});
	assert.equal(kept.currentTurnStartedAt, 1_000);
});

test("progressFromSession: generationMs sums assistant − user/toolResult intervals", () => {
	const parsed = parseSessionText(
		[
			userMsg("go", { timestamp: 1_000 }),
			assistantMsg({ stopReason: "toolUse", tools: ["bash"], timestamp: 3_000, usage: { input: 10, output: 100 } }),
			toolResult({ timestamp: 8_000 }),
			assistantMsg({ stopReason: "stop", text: "done", timestamp: 10_000, usage: { input: 10, output: 50 } }),
		].join("\n"),
	);
	const live = progressFromSession(parsed);
	// (3000-1000) + (10000-8000) = 4000; tool gap 3000→8000 excluded
	assert.equal(live.generationMs, 4_000);
	assert.equal(live.tokensOut, 150);
	assert.equal(live.usageTotal, 170);
});

test("mergeProgress: a later in-flight turn clears a frozen end", () => {
	const merged = mergeProgress(
		{ currentTurnStartedAt: 1_000, currentTurnEndedAt: 9_000 },
		{ currentTurnStartedAt: 20_000 },
	);
	assert.equal(merged.currentTurnStartedAt, 20_000);
	assert.equal(merged.currentTurnEndedAt, undefined);
	const frozen = mergeProgress(
		{ currentTurnStartedAt: 1_000 },
		{ currentTurnStartedAt: 4_000, currentTurnEndedAt: 8_000 },
	);
	assert.equal(frozen.currentTurnStartedAt, 4_000);
	assert.equal(frozen.currentTurnEndedAt, 8_000);
});

test("progressFromSession: generationMs uses the measured call length, not prompt latency", () => {
	// Real session shape: the nested `timestamp` is when generation *started*.
	// The old code subtracted it and recorded only the prompt→first-token latency
	// (1ms here, 2-7ms on real sessions), which pinned generationMs near zero and
	// disabled the tok/s denominator. `durationMs` is the measured call length.
	const lines = [
		userMsg("go", { timestamp: 1_000 }),
		JSON.stringify({
			type: "message",
			timestamp: "2026-01-01T00:00:09.999Z",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "done" }],
				stopReason: "stop",
				model: "test/glm-5.3-flash",
				usage: { input: 10, output: 400, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
				timestamp: 2_000,
				durationMs: 7_000,
			},
		}),
	];
	const live = progressFromSession(parseSessionText(lines.join("\n")));
	// The call itself took 7000ms; the 1000→2000 queue gap is excluded like any idle gap.
	assert.equal(live.generationMs, 7_000);
	assert.equal(live.tokensOut, 400);
	// Sanity: a plausible decode speed, not the 400k tok/s the old 1ms produced.
	assert.ok(Math.abs(400 / (live.generationMs! / 1_000) - 400 / 7) < 1e-6);
});

test("progressFromSession: generationMs measures entry-to-entry when only entry timestamps exist", () => {
	// A writer that omits both nested timestamps and durationMs: entries are
	// appended after each message completes, so start/end are both write instants.
	// The 5s→20s tool gap stays excluded.
	const parsed = parseSessionText(
		[
			'{"type":"message","timestamp":"2026-01-01T00:00:01.000Z","message":{"role":"user","content":"go"}}',
			'{"type":"message","timestamp":"2026-01-01T00:00:05.000Z","message":{"role":"assistant","content":[],"stopReason":"toolUse","usage":{"input":1,"output":10}}}',
			'{"type":"message","timestamp":"2026-01-01T00:00:20.000Z","message":{"role":"toolResult","toolName":"bash","content":[]}}',
			'{"type":"message","timestamp":"2026-01-01T00:00:24.000Z","message":{"role":"assistant","content":[],"stopReason":"stop","usage":{"input":1,"output":10}}}',
		].join("\n"),
	);
	const live = progressFromSession(parsed);
	// (5000 − 1000) + (24000 − 20000) = 8000; the 5000→20000 tool gap is excluded.
	assert.equal(live.generationMs, 8_000);
});

test("progressFromSession: generationMs clears the tree-row t/s gate on a real session", () => {
	const parsed = parseSessionText(
		[
			userMsg("go", { timestamp: 1_000 }),
			JSON.stringify({
				type: "message",
				timestamp: "2026-01-01T00:01:33.000Z",
				message: {
					role: "assistant", content: [], stopReason: "stop",
					usage: { input: 1, output: 600 }, timestamp: 2_000, durationMs: 92_000,
				},
			}),
		].join("\n"),
	);
	const live = progressFromSession(parsed);
	// status.ts renders `avg t/s` only when generationMs >= 1000; the old code
	// produced a 1-3ms total here and the label never appeared.
	assert.ok(live.generationMs! >= 1_000, `expected >=1000 got ${live.generationMs}`);
	assert.ok(Math.abs(live.tokensOut! / (live.generationMs! / 1_000) - 600 / 92) < 1e-6);
});
