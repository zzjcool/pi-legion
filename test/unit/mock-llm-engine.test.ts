import assert from "node:assert/strict";
import { test } from "node:test";
import {
	extractMockSay,
	extractMockTool,
	inferRole,
	pickActions,
	resolveContext,
	whenMatches,
} from "../mock-llm/script-engine.ts";
import { resolveScenario } from "../mock-llm/scenarios.ts";

test("inferRole detects Chinese and English role prompts", () => {
	assert.equal(inferRole("你是 scout，一个只读侦察 agent。"), "scout");
	assert.equal(inferRole("You are a worker that implements plans."), "worker");
	assert.equal(inferRole("no role here"), undefined);
});

test("whenMatches requires all specified fields", () => {
	const ctx = resolveContext(
		{
			model: "flash",
			messages: [
				{ role: "system", content: "你是 worker" },
				{ role: "user", content: "do the thing" },
			],
		},
		"echo",
	);
	assert.equal(whenMatches({ role: "worker" }, ctx), true);
	assert.equal(whenMatches({ role: "scout" }, ctx), false);
	assert.equal(whenMatches({ promptIncludes: "do the thing" }, ctx), true);
	assert.equal(whenMatches({ hasToolResult: true }, ctx), false);
	assert.equal(whenMatches({ turnIndex: 0 }, ctx), true);
});

test("MOCK_SAY and MOCK_TOOL inline directives win before rules", () => {
	const sayCtx = resolveContext(
		{ messages: [{ role: "user", content: "please MOCK_SAY: exact-text\nthanks" }] },
		"echo",
	);
	assert.equal(extractMockSay(sayCtx), "exact-text");
	assert.deepEqual(pickActions(resolveScenario("echo"), sayCtx), [
		{ type: "text", content: "exact-text" },
	]);

	const toolCtx = resolveContext(
		{
			messages: [
				{
					role: "user",
					content: 'MOCK_TOOL: subagent | {"action":"diagnose"}',
				},
			],
		},
		"echo",
	);
	assert.deepEqual(extractMockTool(toolCtx), {
		name: "subagent",
		arguments: { action: "diagnose" },
	});
	const actions = pickActions(resolveScenario("echo"), toolCtx);
	assert.equal(actions[0]?.type, "tool_call");
	if (actions[0]?.type === "tool_call") {
		assert.equal(actions[0].name, "subagent");
		assert.deepEqual(actions[0].arguments, { action: "diagnose" });
	}
});

test("echo scenario echoes tool results", () => {
	const ctx = resolveContext(
		{
			messages: [
				{ role: "user", content: "hi" },
				{ role: "assistant", content: null, tool_calls: [{}] },
				{ role: "tool", content: "pwd-output" },
			],
		},
		"echo",
	);
	assert.deepEqual(pickActions(resolveScenario("echo"), ctx), [
		{ type: "text", content: "pwd-output" },
	]);
});

test("child-done picks role-specific verdict", () => {
	const ctx = resolveContext(
		{
			messages: [
				{ role: "system", content: "你是 scout，只读" },
				{ role: "user", content: "Task: map the repo" },
			],
		},
		"child-done",
	);
	const actions = pickActions(resolveScenario("child-done"), ctx);
	assert.equal(actions[0]?.type, "text");
	if (actions[0]?.type === "text") {
		assert.match(actions[0].content, /SCOUT_OK/);
	}
});

test("spawn-scout issues subagent tool call", () => {
	const ctx = resolveContext(
		{ messages: [{ role: "user", content: "spawn a scout please" }] },
		"spawn-scout",
	);
	const actions = pickActions(resolveScenario("spawn-scout"), ctx);
	assert.equal(actions[0]?.type, "tool_call");
	if (actions[0]?.type === "tool_call") {
		assert.equal(actions[0].name, "subagent");
		assert.equal(
			(actions[0].arguments as { agent?: string }).agent,
			"scout",
		);
	}
});

test("tool-once uses MOCK_TOOL_* defaults", () => {
	const script = resolveScenario("tool-once", {
		toolName: "bash",
		toolArgs: '{"command":"echo hi"}',
	});
	const ctx = resolveContext({ messages: [{ role: "user", content: "go" }] }, "tool-once");
	const actions = pickActions(script, ctx);
	assert.equal(actions[0]?.type, "tool_call");
	if (actions[0]?.type === "tool_call") {
		assert.equal(actions[0].name, "bash");
		assert.deepEqual(actions[0].arguments, { command: "echo hi" });
	}
});
