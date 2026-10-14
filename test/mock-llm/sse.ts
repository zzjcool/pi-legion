import type { ServerResponse } from "node:http";
import type { MockAction } from "./types.ts";

export function chunk(delta: Record<string, unknown>, finish: string | null = null) {
	return {
		id: "mock-chatcmpl",
		object: "chat.completion.chunk",
		created: Math.floor(Date.now() / 1000),
		model: "flash",
		choices: [{ index: 0, delta, finish_reason: finish }],
	};
}

export function writeSse(res: ServerResponse, chunks: unknown[]): void {
	res.writeHead(200, {
		"Content-Type": "text/event-stream",
		"Cache-Control": "no-cache",
		Connection: "keep-alive",
	});
	for (const item of chunks) {
		res.write(`data: ${JSON.stringify(item)}\n\n`);
	}
	res.write("data: [DONE]\n\n");
	res.end();
}

export function actionsToSseChunks(actions: MockAction[], model: string): unknown[] {
	const out: unknown[] = [];
	for (const action of actions) {
		if (action.type === "text") {
			out.push(chunk({ role: "assistant", content: "" }));
			// Stream in modest pieces so pi's delta parser is exercised.
			const text = action.content;
			const step = 64;
			for (let i = 0; i < text.length; i += step) {
				out.push(chunk({ content: text.slice(i, i + step) }));
			}
			if (text.length === 0) out.push(chunk({ content: "" }));
			out.push({
				...chunk({}, "stop"),
				model,
				usage: {
					prompt_tokens: 8,
					completion_tokens: Math.max(1, Math.ceil(text.length / 4)),
					total_tokens: 8 + Math.max(1, Math.ceil(text.length / 4)),
				},
			});
			continue;
		}
		if (action.type === "tool_call") {
			const args =
				typeof action.arguments === "string"
					? action.arguments
					: JSON.stringify(action.arguments);
			const id = action.id ?? "call_mock_1";
			out.push(
				chunk({
					role: "assistant",
					content: null,
					tool_calls: [
						{
							index: 0,
							id,
							type: "function",
							function: { name: action.name, arguments: "" },
						},
					],
				}),
			);
			const step = 48;
			for (let i = 0; i < args.length; i += step) {
				out.push(
					chunk({
						tool_calls: [
							{ index: 0, function: { arguments: args.slice(i, i + step) } },
						],
					}),
				);
			}
			out.push({
				...chunk({}, "tool_calls"),
				model,
				usage: {
					prompt_tokens: 8,
					completion_tokens: Math.max(1, Math.ceil(args.length / 4)),
					total_tokens: 8 + Math.max(1, Math.ceil(args.length / 4)),
				},
			});
		}
	}
	return out;
}

export function actionsToJsonCompletion(actions: MockAction[], model: string): unknown {
	const message: {
		role: string;
		content: string | null;
		tool_calls?: Array<{
			id: string;
			type: "function";
			function: { name: string; arguments: string };
		}>;
	} = { role: "assistant", content: null };

	for (const action of actions) {
		if (action.type === "text") {
			message.content = (message.content ?? "") + action.content;
		} else if (action.type === "tool_call") {
			const args =
				typeof action.arguments === "string"
					? action.arguments
					: JSON.stringify(action.arguments);
			message.tool_calls ??= [];
			message.tool_calls.push({
				id: action.id ?? `call_mock_${message.tool_calls.length + 1}`,
				type: "function",
				function: { name: action.name, arguments: args },
			});
		}
	}

	const finish = message.tool_calls?.length ? "tool_calls" : "stop";
	return {
		id: "mock-chatcmpl",
		object: "chat.completion",
		created: Math.floor(Date.now() / 1000),
		model,
		choices: [{ index: 0, message, finish_reason: finish }],
		usage: { prompt_tokens: 8, completion_tokens: 16, total_tokens: 24 },
	};
}
