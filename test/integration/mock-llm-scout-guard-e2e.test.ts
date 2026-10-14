/**
 * mock-llm / light extension harness for scout-guard (#108).
 *
 * Unit FSM/hook tests live in test/unit/scout-guard.test.ts. This file hangs
 * on `npm run test:mock-llm` so CI fails red when the real-tool_call → followUp
 * path regresses: N consecutive read-class calls, exactly one
 * scout-guard-notify followUp (copy includes threshold), dispatch clears the
 * streak, and cooldownMs blocks a second inject. No headed TUI required.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
	MOCK_API_KEY,
	startMockLlm,
	type MockScript,
} from "../mock-llm/index.ts";
import { CHILD_ROLE_ENV } from "../../src/extension/child-guard.ts";
import {
	SCOUT_GUARD_NOTIFY_TYPE,
	scoutGuardReminder,
} from "../../src/extension/scout-guard.ts";
import { FakeSupervisor } from "../helpers/fake-supervisor.ts";

const THRESHOLD = 4;
const COOLDOWN_MS = 120_000;

interface SentMessage {
	customType: string;
	content: string;
	display: boolean;
}

interface SentOptions {
	triggerTurn?: boolean;
	deliverAs?: string;
}

/** Scripted N read tool_calls (grep/find/ls/read) then settle — for mock-llm path. */
function readStreakScript(n: number): MockScript {
	const reads: Array<{ name: string; arguments: Record<string, unknown> }> = [
		{ name: "grep", arguments: { pattern: "TODO" } },
		{ name: "find", arguments: { pattern: "*.ts" } },
		{ name: "ls", arguments: { path: "src" } },
		{ name: "read", arguments: { path: "a.ts" } },
	];
	const rules: MockScript["rules"] = [
		{
			name: "after-tools",
			when: { hasToolResult: true, turnIndex: n },
			then: {
				type: "text",
				content: '{"ok": true, "reason": "SCOUT_GUARD_STREAK_OK"}',
			},
		},
	];
	for (let i = 0; i < n; i += 1) {
		const tool = reads[i % reads.length]!;
		rules.push({
			name: `read-${i}`,
			when: { turnIndex: i, hasToolResult: i > 0 },
			then: { type: "tool_call", name: tool.name, arguments: tool.arguments },
		});
		// First turn has no tool result yet.
		if (i === 0) {
			rules[rules.length - 1]!.when = { turnIndex: 0 };
		}
	}
	rules.push({ name: "default", then: { type: "text", content: "MOCK_OK" } });
	return {
		models: [{ id: "flash", name: "Mock Flash" }],
		rules,
	};
}

async function chat(
	baseUrl: string,
	messages: unknown[],
): Promise<{
	choices: Array<{
		finish_reason: string;
		message: {
			content?: string | null;
			tool_calls?: Array<{
				id: string;
				function: { name: string; arguments: string };
			}>;
		};
	}>;
}> {
	const res = await fetch(`${baseUrl}/chat/completions`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${MOCK_API_KEY}`,
		},
		body: JSON.stringify({ model: "flash", stream: false, messages }),
	});
	const raw = await res.text();
	assert.equal(res.ok, true, raw);
	return JSON.parse(raw) as Awaited<ReturnType<typeof chat>>;
}

test("e2e: mock-llm scripts N consecutive read-class tool_calls then settles", async () => {
	const n = THRESHOLD;
	const mock = await startMockLlm({
		scenario: "script",
		script: readStreakScript(n),
		port: 0,
	});
	try {
		const messages: unknown[] = [{ role: "user", content: "scout the tree" }];
		const toolNames: string[] = [];
		for (let i = 0; i < n; i += 1) {
			const turn = await chat(mock.baseUrl, messages);
			const call = turn.choices[0]?.message.tool_calls?.[0];
			assert.ok(call, `expected tool_call at streak step ${i + 1}`);
			toolNames.push(call.function.name);
			messages.push({
				role: "assistant",
				content: null,
				tool_calls: turn.choices[0]?.message.tool_calls,
			});
			messages.push({
				role: "tool",
				tool_call_id: call.id,
				content: `${call.function.name}-ok`,
			});
		}
		assert.deepEqual(toolNames, ["grep", "find", "ls", "read"]);
		const settled = await chat(mock.baseUrl, messages);
		assert.match(
			settled.choices[0]?.message.content ?? "",
			/SCOUT_GUARD_STREAK_OK/,
		);
		assert.ok(mock.requestCount() >= n + 1);
	} finally {
		await mock.close();
	}
});

test("e2e: extension harness — notify once, dispatch clears, cooldown blocks second", async () => {
	const herdrSubagents = (await import("../../index.ts")).default;
	const dir = mkdtempSync(path.join(tmpdir(), "mock-scout-guard-"));
	const previous = {
		agentDir: process.env.PI_CODING_AGENT_DIR,
		child: process.env.PI_SUBAGENT_CHILD,
		role: process.env[CHILD_ROLE_ENV],
		utility: process.env.PI_SUBAGENT_UTILITY_CHILD,
	};
	try {
		writeFileSync(
			path.join(dir, "settings.json"),
			JSON.stringify({
				subagents: {
					scoutGuard: {
						enabled: true,
						threshold: THRESHOLD,
						cooldownMs: COOLDOWN_MS,
					},
				},
			}),
		);
		process.env.PI_CODING_AGENT_DIR = dir;
		delete process.env.PI_SUBAGENT_CHILD;
		delete process.env[CHILD_ROLE_ENV];
		delete process.env.PI_SUBAGENT_UTILITY_CHILD;

		const sent: Array<{ message: SentMessage; options?: SentOptions }> = [];
		const events = new Map<
			string,
			(
				event: { toolName: string; input?: unknown },
				ctx?: { cwd?: string },
			) => unknown
		>();
		let hookReturned = true;
		const pi = {
			registerMessageRenderer() {},
			registerTool() {},
			registerCommand() {},
			sendMessage(message: SentMessage, options?: SentOptions) {
				assert.equal(
					hookReturned,
					true,
					"followUp must not run inside tool_call",
				);
				sent.push({ message, options });
			},
			events: { emit() {} },
			on(name: string, handler: unknown) {
				events.set(
					name,
					handler as (
						event: { toolName: string; input?: unknown },
						ctx?: { cwd?: string },
					) => unknown,
				);
			},
		};
		herdrSubagents(pi as never, { supervisor: new FakeSupervisor() });
		const handler = events.get("tool_call");
		assert.equal(typeof handler, "function");

		const call = (toolName: string, input: unknown) => {
			hookReturned = false;
			const result = handler?.({ toolName, input }, { cwd: dir });
			hookReturned = true;
			assert.equal(result, undefined, "tool_call must not block");
		};
		const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
		const reminders = () =>
			sent.filter((entry) => entry.message.customType === SCOUT_GUARD_NOTIFY_TYPE);

		const reads: Array<[string, unknown]> = [
			["grep", { pattern: "TODO" }],
			["find", { pattern: "*.ts" }],
			["ls", { path: "src" }],
			["read", { path: "a.ts" }],
		];
		const readAt = (index: number) => {
			const [toolName, input] = reads[index % reads.length]!;
			call(toolName, input);
		};

		// (3) Dispatch mid-streak clears the counter — no notify yet.
		for (let i = 0; i < THRESHOLD - 1; i += 1) readAt(i);
		call("subagent", {
			action: "launch",
			agent: "scout",
			task: "survey the tree",
		});
		for (let i = 0; i < THRESHOLD - 1; i += 1) readAt(i);
		await flush();
		assert.equal(
			reminders().length,
			0,
			"dispatch must clear the streak before N",
		);

		// (1)+(2) N consecutive reads → exactly one scout-guard-notify followUp.
		readAt(THRESHOLD - 1);
		assert.equal(
			reminders().length,
			0,
			"Nth read only schedules followUp after tool_call returns",
		);
		await flush();
		assert.equal(reminders().length, 1);
		const [reminder] = reminders();
		assert.ok(reminder);
		assert.equal(reminder.message.customType, SCOUT_GUARD_NOTIFY_TYPE);
		assert.equal(reminder.message.display, true);
		assert.equal(reminder.message.content, scoutGuardReminder(THRESHOLD));
		assert.match(reminder.message.content, new RegExp(`连续 ${THRESHOLD} 次`));
		assert.deepEqual(reminder.options, {
			triggerTurn: true,
			deliverAs: "followUp",
		});

		// (4) Within cooldownMs, another full streak must not inject again.
		for (let i = 0; i < THRESHOLD; i += 1) readAt(i);
		await flush();
		assert.equal(
			reminders().length,
			1,
			"cooldownMs must block a second inject",
		);

		// Dispatch ends cooldown; a fresh streak can notify again (vexillatio).
		call("vexillatio", { task: "parallel survey" });
		for (let i = 0; i < THRESHOLD; i += 1) readAt(i);
		await flush();
		assert.equal(
			reminders().length,
			2,
			"dispatch clears cooldown so a new streak can notify",
		);
	} finally {
		if (previous.agentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous.agentDir;
		if (previous.child === undefined) delete process.env.PI_SUBAGENT_CHILD;
		else process.env.PI_SUBAGENT_CHILD = previous.child;
		if (previous.role === undefined) delete process.env[CHILD_ROLE_ENV];
		else process.env[CHILD_ROLE_ENV] = previous.role;
		if (previous.utility === undefined) {
			delete process.env.PI_SUBAGENT_UTILITY_CHILD;
		} else {
			process.env.PI_SUBAGENT_UTILITY_CHILD = previous.utility;
		}
		rmSync(dir, { recursive: true, force: true });
	}
});

test("e2e: mock-llm + harness — feed scripted read names into scout-guard", async () => {
	const herdrSubagents = (await import("../../index.ts")).default;
	const dir = mkdtempSync(path.join(tmpdir(), "mock-scout-guard-feed-"));
	const previous = {
		agentDir: process.env.PI_CODING_AGENT_DIR,
		child: process.env.PI_SUBAGENT_CHILD,
		role: process.env[CHILD_ROLE_ENV],
	};
	const mock = await startMockLlm({
		scenario: "script",
		script: readStreakScript(THRESHOLD),
		port: 0,
	});
	try {
		writeFileSync(
			path.join(dir, "settings.json"),
			JSON.stringify({
				subagents: {
					scoutGuard: {
						enabled: true,
						threshold: THRESHOLD,
						cooldownMs: COOLDOWN_MS,
					},
				},
			}),
		);
		process.env.PI_CODING_AGENT_DIR = dir;
		delete process.env.PI_SUBAGENT_CHILD;
		delete process.env[CHILD_ROLE_ENV];

		const sent: Array<{ message: SentMessage; options?: SentOptions }> = [];
		const events = new Map<
			string,
			(
				event: { toolName: string; input?: unknown },
				ctx?: { cwd?: string },
			) => unknown
		>();
		const pi = {
			registerMessageRenderer() {},
			registerTool() {},
			registerCommand() {},
			sendMessage(message: SentMessage, options?: SentOptions) {
				sent.push({ message, options });
			},
			events: { emit() {} },
			on(name: string, handler: unknown) {
				events.set(
					name,
					handler as (
						event: { toolName: string; input?: unknown },
						ctx?: { cwd?: string },
					) => unknown,
				);
			},
		};
		herdrSubagents(pi as never, { supervisor: new FakeSupervisor() });
		const handler = events.get("tool_call");
		assert.equal(typeof handler, "function");

		const messages: unknown[] = [{ role: "user", content: "scout the tree" }];
		for (let i = 0; i < THRESHOLD; i += 1) {
			const turn = await chat(mock.baseUrl, messages);
			const call = turn.choices[0]?.message.tool_calls?.[0];
			assert.ok(call);
			const args = JSON.parse(call.function.arguments) as unknown;
			handler?.({ toolName: call.function.name, input: args }, { cwd: dir });
			messages.push({
				role: "assistant",
				content: null,
				tool_calls: turn.choices[0]?.message.tool_calls,
			});
			messages.push({
				role: "tool",
				tool_call_id: call.id,
				content: "ok",
			});
		}
		await new Promise((resolve) => setTimeout(resolve, 0));
		const reminders = sent.filter(
			(entry) => entry.message.customType === SCOUT_GUARD_NOTIFY_TYPE,
		);
		assert.equal(reminders.length, 1);
		assert.match(reminders[0]!.message.content, new RegExp(`连续 ${THRESHOLD} 次`));
		assert.deepEqual(reminders[0]!.options, {
			triggerTurn: true,
			deliverAs: "followUp",
		});
	} finally {
		await mock.close();
		if (previous.agentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous.agentDir;
		if (previous.child === undefined) delete process.env.PI_SUBAGENT_CHILD;
		else process.env.PI_SUBAGENT_CHILD = previous.child;
		if (previous.role === undefined) delete process.env[CHILD_ROLE_ENV];
		else process.env[CHILD_ROLE_ENV] = previous.role;
		rmSync(dir, { recursive: true, force: true });
	}
});
