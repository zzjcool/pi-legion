/**
 * Builders for pi session-jsonl lines.
 *
 * Shapes follow the measured session format (docs/design.md §1.1, exp1/exp6/exp12):
 *   - session header + model_change events precede messages (exp6: size=401 header)
 *   - messages are `{"type":"message","message":{role, content, stopReason, ...}}`
 *   - toolResult errors carry `isError: true` (exp12-4)
 *
 * Only `type === "message"` events influence deriveOutcome. `model_change`
 * headers populate `parsed.model` so the status widget can show the live
 * model before the first assistant message.
 */

/** Default usage block, overridable field by field. */
export interface FixtureUsage {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	/** Raw `usage.cost` as measured in sessions: an object with a `total`. */
	cost?: { total?: number };
}

/** First line of a session: `{type:"session", ...}`. */
export function sessionHeader(opts?: { id?: string; cwd?: string }): string {
	return JSON.stringify({
		type: "session",
		id: opts?.id ?? "sess-test-0000",
		cwd: opts?.cwd ?? "/tmp/project",
		created: "2026-01-01T00:00:00.000Z",
	});
}

/** `{type:"model_change", ...}` event (exp6 header pair). */
export function modelChange(model: string): string {
	return JSON.stringify({ type: "model_change", model, provider: model.split("/")[0] ?? "test" });
}

/** User message opening a turn. `timestamp` is Unix ms (session-format.md). */
export function userMsg(text: string, opts?: { timestamp?: number }): string {
	return JSON.stringify({
		type: "message",
		message: {
			role: "user",
			content: text,
			...(opts?.timestamp !== undefined ? { timestamp: opts.timestamp } : {}),
		},
	});
}

export interface AssistantMsgOptions {
	stopReason?: string;
	text?: string;
	tools?: string[];
	errorMessage?: string;
	model?: string;
	usage?: FixtureUsage;
	timestamp?: number;
}

/** Assistant message; `content` mixes text parts and toolCall parts. */
export function assistantMsg(opts: AssistantMsgOptions = {}): string {
	const content: Array<Record<string, unknown>> = [];
	if (opts.text !== undefined) content.push({ type: "text", text: opts.text });
	for (const name of opts.tools ?? []) content.push({ type: "toolCall", name, arguments: {} });
	const usage: Record<string, unknown> = {
		input: opts.usage?.input ?? 10,
		output: opts.usage?.output ?? 2,
		cacheRead: opts.usage?.cacheRead ?? 0,
		cacheWrite: opts.usage?.cacheWrite ?? 0,
		cost: { total: opts.usage?.cost?.total ?? 0.001 },
	};
	return JSON.stringify({
		type: "message",
		message: {
			role: "assistant",
			content,
			stopReason: opts.stopReason ?? "stop",
			errorMessage: opts.errorMessage,
			model: opts.model ?? "test/glm-5.3-flash",
			usage,
			...(opts.timestamp !== undefined ? { timestamp: opts.timestamp } : {}),
		},
	});
}

/** Tool result; `isError: true` is the per-turn diagnostic signal (F30). */
export function toolResult(opts: { isError?: boolean; toolName?: string; text?: string } = {}): string {
	const isError = opts.isError ?? false;
	return JSON.stringify({
		type: "message",
		message: {
			role: "toolResult",
			toolName: opts.toolName ?? "bash",
			isError,
			content: [
				{
					type: "text",
					text: opts.text ?? (isError ? "(no output)\n\nCommand exited with code 1" : "ok"),
				},
			],
		},
	});
}

/** A JSON line truncated mid-write (F12: torn line must be counted, not thrown). */
export function tornLine(): string {
	return '{"type":"message","message":{"role":"assistant","content":[{"type":"te';
}
