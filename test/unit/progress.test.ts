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
		generationMs: 2_000,
	});
});

test("progressFromSession: a settled last turn has no current-turn start", () => {
	const parsed = parseSessionText(
		[
			userMsg("go", { timestamp: 1_000 }),
			assistantMsg({ stopReason: "stop", text: "done", timestamp: 9_000 }),
		].join("\n"),
	);
	assert.equal(progressFromSession(parsed).currentTurnStartedAt, undefined);
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
