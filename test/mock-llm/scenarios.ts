import type { MockScript } from "./types.ts";

const flashModel = {
	id: "flash",
	name: "Mock Flash",
	reasoning: false,
	contextWindow: 32_000,
	maxTokens: 2048,
};

/** Plain text reply; honour MOCK_SAY / MOCK_TOOL inline directives. */
export const echoScenario: MockScript = {
	models: [flashModel],
	rules: [
		{
			name: "after-tool",
			when: { hasToolResult: true },
			then: { type: "text", content: "{{lastToolContent}}" },
		},
		{
			name: "default",
			then: { type: "text", content: "MOCK_OK" },
		},
	],
};

/**
 * Legacy docker behaviour: one tool call (env MOCK_TOOL_NAME / MOCK_TOOL_ARGS),
 * then echo the tool result as assistant text.
 */
export function toolOnceScenario(toolName: string, toolArgsJson: string): MockScript {
	let args: Record<string, unknown> = { command: "pwd" };
	try {
		const parsed = JSON.parse(toolArgsJson) as unknown;
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			args = parsed as Record<string, unknown>;
		}
	} catch {
		args = { command: toolArgsJson };
	}
	return {
		models: [flashModel],
		rules: [
			{
				name: "after-tool",
				when: { hasToolResult: true },
				then: { type: "text", content: "{{lastToolContent}}" },
			},
			{
				name: "first-tool",
				then: { type: "tool_call", name: toolName, arguments: args },
			},
		],
	};
}

/** Parent agent spawns a scout, then settles after the tool result. */
export const spawnScoutScenario: MockScript = {
	models: [flashModel],
	rules: [
		{
			name: "after-subagent",
			when: { hasToolResult: true },
			then: {
				type: "text",
				content: 'Spawned. {"ok": true, "reason": "subagent returned"}\n',
			},
		},
		{
			name: "spawn",
			when: { promptIncludes: "subagent" },
			then: {
				type: "tool_call",
				name: "subagent",
				arguments: {
					agent: "scout",
					task: "Reply with exactly SCOUT_OK. Do not use tools. End with {\"ok\": true, \"reason\": \"SCOUT_OK\"}.",
				},
			},
		},
		{
			name: "default-spawn",
			then: {
				type: "tool_call",
				name: "subagent",
				arguments: {
					agent: "scout",
					task: "Reply with exactly SCOUT_OK. Do not use tools. End with {\"ok\": true, \"reason\": \"SCOUT_OK\"}.",
				},
			},
		},
	],
};

/** Leaf child: no tools, declare done (acceptance attested). */
export const childDoneScenario: MockScript = {
	models: [flashModel],
	rules: [
		{
			name: "scout",
			when: { role: "scout" },
			then: {
				type: "text",
				content:
					"## Facts\n- mock probe ok\n\n{\"ok\": true, \"reason\": \"SCOUT_OK\"}\n",
			},
		},
		{
			name: "worker",
			when: { role: "worker" },
			then: {
				type: "text",
				content:
					"## Report\nMock worker finished without edits.\n\n{\"ok\": true, \"reason\": \"WORKER_OK\"}\n",
			},
		},
		{
			name: "default",
			then: {
				type: "text",
				content: "Done as {{role}}.\n\n{\"ok\": true, \"reason\": \"CHILD_OK\"}\n",
			},
		},
	],
};

/** Call subagent diagnose (doctor), then summarise. */
export const doctorScenario: MockScript = {
	models: [flashModel],
	rules: [
		{
			name: "after-diagnose",
			when: { hasToolResult: true },
			then: {
				type: "text",
				content: "Doctor ran.\n\n{\"ok\": true, \"reason\": \"DOCTOR_OK\"}\n",
			},
		},
		{
			name: "diagnose",
			then: {
				type: "tool_call",
				name: "subagent",
				arguments: { action: "diagnose" },
			},
		},
	],
};

/** Call subagent stop all, then settle. */
export const stopAllScenario: MockScript = {
	models: [flashModel],
	rules: [
		{
			name: "after-stop",
			when: { hasToolResult: true },
			then: {
				type: "text",
				content: "Stopped.\n\n{\"ok\": true, \"reason\": \"STOP_OK\"}\n",
			},
		},
		{
			name: "stop",
			then: {
				type: "tool_call",
				name: "subagent",
				arguments: { action: "stop", all: true },
			},
		},
	],
};

/**
 * Worker-like child that claims verification passed without running bash.
 * Useful for acceptance-path smoke where the real verify command is mocked
 * separately by the harness.
 */
export const declareVerifyScenario: MockScript = {
	models: [flashModel],
	rules: [
		{
			name: "declare",
			then: {
				type: "text",
				content:
					"## Verification\nAll acceptance criteria met (mock).\n\n{\"ok\": true, \"reason\": \"VERIFY_DECLARED\"}\n",
			},
		},
	],
};

const BUILTINS: Record<string, MockScript> = {
	echo: echoScenario,
	"spawn-scout": spawnScoutScenario,
	"child-done": childDoneScenario,
	doctor: doctorScenario,
	"stop-all": stopAllScenario,
	"declare-verify": declareVerifyScenario,
};

export function listScenarioNames(): string[] {
	return [...Object.keys(BUILTINS), "tool-once", "script"];
}

export function resolveScenario(
	name: string,
	opts?: { toolName?: string; toolArgs?: string; script?: MockScript },
): MockScript {
	const key = name.trim().toLowerCase() || "echo";
	if (key === "script") {
		if (!opts?.script) {
			throw new Error('scenario "script" requires an explicit MockScript');
		}
		return opts.script;
	}
	if (key === "tool-once") {
		return toolOnceScenario(
			opts?.toolName ?? process.env.MOCK_TOOL_NAME ?? "bash",
			opts?.toolArgs ?? process.env.MOCK_TOOL_ARGS ?? '{"command":"pwd"}',
		);
	}
	const found = BUILTINS[key];
	if (!found) {
		throw new Error(
			`Unknown mock scenario "${name}". Known: ${listScenarioNames().join(", ")}`,
		);
	}
	return found;
}
