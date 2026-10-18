import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAgentDocument } from "../../src/agents/agents.ts";
import { parseSubagentSettings } from "../../src/agents/settings.ts";
import { applyAgentOverrides } from "../../src/agents/overrides.ts";
import { resolveSpawnMode, DEFAULT_SPAWN_MODE } from "../../src/supervisor/spawn-mode.ts";

test("spawnMode: omit defaults to inprocess", () => {
	assert.equal(DEFAULT_SPAWN_MODE, "inprocess");
	assert.equal(resolveSpawnMode({}), DEFAULT_SPAWN_MODE);
	assert.equal(resolveSpawnMode({ spawnMode: undefined }), DEFAULT_SPAWN_MODE);
	const agent = parseAgentDocument(
		"---\nname: scout\ndescription: d\n---\nbody",
		"/a.md",
		"user",
	);
	assert.equal(agent?.spawnMode, undefined);
	assert.equal(resolveSpawnMode(agent!), DEFAULT_SPAWN_MODE);
});

test("spawnMode: frontmatter parses rpc and inprocess", () => {
	const rpc = parseAgentDocument(
		"---\nname: a\ndescription: d\nspawnMode: rpc\n---\nx",
		"/a.md",
		"user",
	);
	assert.equal(rpc?.spawnMode, "rpc");
	const ip = parseAgentDocument(
		"---\nname: b\ndescription: d\nspawnMode: inprocess\n---\nx",
		"/b.md",
		"user",
	);
	assert.equal(ip?.spawnMode, "inprocess");
});

test("spawnMode: invalid frontmatter throws loud", () => {
	assert.throws(
		() =>
			parseAgentDocument(
				"---\nname: c\ndescription: d\nspawnMode: same\n---\nx",
				"/c.md",
				"user",
			),
		/invalid spawnMode 'same'/,
	);
});

test("spawnMode: agentOverrides parse + apply", () => {
	const parsed = parseSubagentSettings(
		{ subagents: { agentOverrides: { scout: { spawnMode: "inprocess" } } } },
		"/tmp/settings.json",
	);
	assert.equal(parsed.agentOverrides?.scout?.spawnMode, "inprocess");
	const base = parseAgentDocument(
		"---\nname: scout\ndescription: helper\n---\nRead.",
		"/agents/scout.md",
		"user",
	);
	assert.ok(base);
	assert.equal(applyAgentOverrides([base], parsed.agentOverrides)[0]?.spawnMode, "inprocess");
});

test("spawnMode: invalid agentOverrides throws loud", () => {
	assert.throws(
		() =>
			parseSubagentSettings(
				{ subagents: { agentOverrides: { scout: { spawnMode: "child" } } } },
				"/tmp/settings.json",
			),
		/agentOverrides\.scout\.spawnMode/,
	);
});

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
