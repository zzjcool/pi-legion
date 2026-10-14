import type {
	ChatCompletionRequest,
	ChatMessage,
	MockAction,
	MockRule,
	MockScript,
	MockWhen,
	ResolvedRequestContext,
} from "./types.ts";

function messageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((part) => {
				if (typeof part === "string") return part;
				if (part && typeof part === "object" && "text" in part) {
					const text = (part as { text?: unknown }).text;
					return typeof text === "string" ? text : "";
				}
				return "";
			})
			.join("\n");
	}
	if (content && typeof content === "object" && "text" in content) {
		const text = (content as { text?: unknown }).text;
		return typeof text === "string" ? text : "";
	}
	return "";
}

export function flattenMessages(messages: ChatMessage[]): string {
	return messages
		.map((m) => `${m.role ?? "?"}: ${messageText(m.content)}`)
		.join("\n");
}

const ROLE_PATTERNS: Array<{ role: string; re: RegExp }> = [
	{ role: "centurion", re: /你是\s*centurion|you are (a |an )?centurion\b/i },
	{ role: "worker", re: /你是\s*worker|you are (a |an )?worker\b/i },
	{ role: "scout", re: /你是\s*scout|you are (a |an )?scout\b/i },
	{ role: "reviewer", re: /你是\s*reviewer|you are (a |an )?reviewer\b/i },
	{ role: "planner", re: /你是\s*planner|you are (a |an )?planner\b/i },
	{ role: "advisor", re: /你是\s*advisor|you are (a |an )?advisor\b/i },
	{ role: "designer", re: /你是\s*designer|you are (a |an )?designer\b/i },
	{ role: "prototype", re: /你是\s*prototype|you are (a |an )?prototype\b/i },
];

export function inferRole(textBlob: string): string | undefined {
	for (const { role, re } of ROLE_PATTERNS) {
		if (re.test(textBlob)) return role;
	}
	const envHint = textBlob.match(/PI_SUBAGENT_ROLE[=:]\s*([a-z0-9_-]+)/i);
	if (envHint?.[1]) return envHint[1].toLowerCase();
	return undefined;
}

export function resolveContext(
	body: ChatCompletionRequest,
	scenario: string,
): ResolvedRequestContext {
	const messages = Array.isArray(body.messages) ? body.messages : [];
	const textBlob = flattenMessages(messages);
	const hasToolResult = messages.some((m) => m?.role === "tool");
	const turnIndex = messages.filter((m) => m?.role === "assistant").length;
	const lastTool = [...messages].reverse().find((m) => m?.role === "tool");
	return {
		model: typeof body.model === "string" ? body.model : "flash",
		scenario,
		messages,
		textBlob,
		hasToolResult,
		turnIndex,
		role: inferRole(textBlob),
		lastToolContent: messageText(lastTool?.content) || "tool finished",
	};
}

function includesAll(haystack: string, needle: string | string[]): boolean {
	const parts = Array.isArray(needle) ? needle : [needle];
	return parts.every((p) => haystack.includes(p));
}

export function whenMatches(when: MockWhen | undefined, ctx: ResolvedRequestContext): boolean {
	if (!when) return true;
	if (when.hasToolResult !== undefined && when.hasToolResult !== ctx.hasToolResult) {
		return false;
	}
	if (when.turnIndex !== undefined && when.turnIndex !== ctx.turnIndex) {
		return false;
	}
	if (when.promptIncludes !== undefined && !includesAll(ctx.textBlob, when.promptIncludes)) {
		return false;
	}
	if (when.promptMatches !== undefined) {
		const re = new RegExp(when.promptMatches, "i");
		if (!re.test(ctx.textBlob)) return false;
	}
	if (when.model !== undefined && when.model !== ctx.model) return false;
	if (when.role !== undefined && when.role.toLowerCase() !== (ctx.role ?? "").toLowerCase()) {
		return false;
	}
	if (when.scenario !== undefined && when.scenario !== ctx.scenario) return false;
	return true;
}

export function expandTemplates(content: string, ctx: ResolvedRequestContext): string {
	return content
		.replaceAll("{{lastToolContent}}", ctx.lastToolContent.slice(0, 4000))
		.replaceAll("{{role}}", ctx.role ?? "unknown")
		.replaceAll("{{model}}", ctx.model)
		.replaceAll("{{scenario}}", ctx.scenario)
		.replaceAll("{{turnIndex}}", String(ctx.turnIndex));
}

/** Inline directive in the latest user message: MOCK_SAY: text here */
export function extractMockSay(ctx: ResolvedRequestContext): string | undefined {
	const userTexts = ctx.messages
		.filter((m) => m.role === "user")
		.map((m) => messageText(m.content));
	const latest = userTexts.at(-1) ?? "";
	const match = latest.match(/MOCK_SAY:\s*(.+?)(?:\n|$)/i);
	return match?.[1]?.trim() || undefined;
}

/**
 * Inline directive: MOCK_TOOL: name | {"arg":1}
 * or MOCK_TOOL: name | arg text as command for bash
 */
export function extractMockTool(
	ctx: ResolvedRequestContext,
): { name: string; arguments: Record<string, unknown> } | undefined {
	const userTexts = ctx.messages
		.filter((m) => m.role === "user")
		.map((m) => messageText(m.content));
	const latest = userTexts.at(-1) ?? "";
	const match = latest.match(/MOCK_TOOL:\s*([a-zA-Z0-9_-]+)\s*\|\s*(.+?)(?:\n|$)/i);
	if (!match) return undefined;
	const name = match[1]!;
	const raw = match[2]!.trim();
	try {
		const parsed = JSON.parse(raw) as unknown;
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			return { name, arguments: parsed as Record<string, unknown> };
		}
	} catch {
		/* fall through */
	}
	if (name === "bash") return { name, arguments: { command: raw } };
	return { name, arguments: { input: raw } };
}

export function pickActions(script: MockScript, ctx: ResolvedRequestContext): MockAction[] {
	// Highest-priority inline directives in the latest user turn.
	if (!ctx.hasToolResult) {
		const tool = extractMockTool(ctx);
		if (tool) {
			return [{ type: "tool_call", name: tool.name, arguments: tool.arguments }];
		}
		const say = extractMockSay(ctx);
		if (say) return [{ type: "text", content: say }];
	}

	for (const rule of script.rules) {
		if (!whenMatches(rule.when, ctx)) continue;
		const then = Array.isArray(rule.then) ? rule.then : [rule.then];
		return then.map((action) => {
			if (action.type === "text") {
				return { ...action, content: expandTemplates(action.content, ctx) };
			}
			if (action.type === "error") {
				return { ...action, message: expandTemplates(action.message, ctx) };
			}
			if (action.type === "tool_call" && typeof action.arguments === "string") {
				return {
					...action,
					arguments: expandTemplates(action.arguments, ctx),
				};
			}
			return action;
		});
	}
	return [{ type: "text", content: `MOCK_OK role={{role}}`.replace("{{role}}", ctx.role ?? "unknown") }];
}

export function findMatchingRule(
	script: MockScript,
	ctx: ResolvedRequestContext,
): MockRule | undefined {
	if (!ctx.hasToolResult && (extractMockTool(ctx) || extractMockSay(ctx))) {
		return { name: "inline-directive", then: { type: "text", content: "" } };
	}
	return script.rules.find((rule) => whenMatches(rule.when, ctx));
}
