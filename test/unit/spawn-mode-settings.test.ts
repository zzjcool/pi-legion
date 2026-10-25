import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAgentDocument } from "../../src/agents/agents.ts";
import { parseSubagentSettings } from "../../src/agents/settings.ts";
import { applyAgentOverrides } from "../../src/agents/overrides.ts";
import {
	DEFAULT_LAUNCH_QUEUE_MAX_PENDING,
	DEFAULT_LAUNCH_QUEUE_TIMEOUT_MS,
} from "../../src/supervisor/admission-queue.ts";

test("inprocess limits: parse separate keys", () => {
	const parsed = parseSubagentSettings(
		{
			subagents: {
				maxSubagentSpawnsPerSession: 3,
				legion: { maxDepth: 2, maxActiveNodes: 5 },
				inprocess: {
					maxSpawnsPerSession: 10,
					maxDepth: 1,
					maxActive: 4,
					maxChildrenPerNode: 2,
					waitTimeoutMs: 60_000,
				},
			},
		},
		"/tmp/settings.json",
	);
	assert.equal(parsed.maxSubagentSpawnsPerSession, 3);
	assert.equal(parsed.legion?.maxDepth, 2);
	assert.deepEqual(parsed.inprocess, {
		maxSpawnsPerSession: 10,
		maxDepth: 1,
		maxActive: 4,
		maxChildrenPerNode: 2,
		waitTimeoutMs: 60_000,
	});
});

test("inprocess limits: invalid shape throws", () => {
	assert.throws(
		() =>
			parseSubagentSettings(
				{ subagents: { inprocess: "nope" } },
				"/tmp/settings.json",
			),
		/invalid 'inprocess'/,
	);
	assert.throws(
		() =>
			parseSubagentSettings(
				{ subagents: { inprocess: { maxActive: 0 } } },
				"/tmp/settings.json",
			),
		/inprocess\.maxActive/,
	);
});

test("#193 rpc.approve: parse + project merge", () => {
	const parsed = parseSubagentSettings(
		{ subagents: { rpc: { approve: true } } },
		"/tmp/settings.json",
	);
	assert.deepEqual(parsed.rpc, { approve: true });

	const omitted = parseSubagentSettings({ subagents: {} }, "/tmp/settings.json");
	assert.equal(omitted.rpc, undefined);

	assert.throws(
		() =>
			parseSubagentSettings(
				{ subagents: { rpc: { approve: "yes" } } },
				"/tmp/settings.json",
			),
		/rpc\.approve/,
	);
});

// ── #266 D10: launch-admission-queue bounds ───────────────────────────────

test("inprocess launch queue: parses maxQueuedLaunches + launchQueueTimeoutMs", () => {
	const parsed = parseSubagentSettings(
		{
			subagents: {
				inprocess: { maxQueuedLaunches: 4, launchQueueTimeoutMs: 120_000 },
			},
		},
		"/tmp/settings.json",
	);
	assert.equal(parsed.inprocess?.maxQueuedLaunches, 4);
	assert.equal(parsed.inprocess?.launchQueueTimeoutMs, 120_000);
});

test("inprocess launch queue: omitted keys stay absent (defaults live in admission-queue.ts)", () => {
	const parsed = parseSubagentSettings(
		{ subagents: { inprocess: { maxChildrenPerNode: 2 } } },
		"/tmp/settings.json",
	);
	assert.equal(parsed.inprocess?.maxQueuedLaunches, undefined);
	assert.equal(parsed.inprocess?.launchQueueTimeoutMs, undefined);
	assert.equal(DEFAULT_LAUNCH_QUEUE_MAX_PENDING, 32);
	assert.equal(DEFAULT_LAUNCH_QUEUE_TIMEOUT_MS, 900_000);
});

test("inprocess launch queue: 0 is invalid (positiveInt), not 'queue disabled'", () => {
	for (const key of ["maxQueuedLaunches", "launchQueueTimeoutMs"] as const) {
		assert.throws(
			() =>
				parseSubagentSettings(
					{ subagents: { inprocess: { [key]: 0 } } },
					"/tmp/settings.json",
				),
			(error: unknown) =>
				(error as Error).message.includes(`inprocess.${key}`) &&
				(error as Error).message.includes("expected a positive integer"),
		);
	}
	assert.throws(
		() =>
			parseSubagentSettings(
				{ subagents: { inprocess: { maxQueuedLaunches: 1.5 } } },
				"/tmp/settings.json",
			),
		/inprocess\.maxQueuedLaunches/,
	);
});
