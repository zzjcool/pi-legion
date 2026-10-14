/**
 * Scriptable OpenAI-compatible mock LLM for pi-legion tests.
 *
 * Pi registers providers via ~/.pi/agent/models.json with
 * `api: "openai-completions"` and a `baseUrl` pointing here
 * (see docs/mock-llm.md). Never put real API keys in scripts.
 */

export interface MockModelDef {
	id: string;
	name?: string;
	reasoning?: boolean;
	contextWindow?: number;
	maxTokens?: number;
}

export type MockAction =
	| { type: "text"; content: string }
	| {
			type: "tool_call";
			name: string;
			arguments: Record<string, unknown> | string;
			id?: string;
	  }
	| { type: "error"; status?: number; message: string };

export interface MockWhen {
	/** Match when the conversation already contains a tool role message. */
	hasToolResult?: boolean;
	/** 0-based count of prior assistant turns in this request's messages. */
	turnIndex?: number;
	/** Substring(s) that must appear in concatenated message text. */
	promptIncludes?: string | string[];
	/** Regex tested against concatenated message text. */
	promptMatches?: string;
	/** Match model id from the request body. */
	model?: string;
	/**
	 * Match agent role inferred from system/user text
	 * (e.g. "你是 scout" / "You are a worker" / PI_SUBAGENT_ROLE hints).
	 */
	role?: string;
	/** Match named scenario from env / query / header. */
	scenario?: string;
}

export interface MockRule {
	name?: string;
	when?: MockWhen;
	then: MockAction | MockAction[];
}

export interface MockScript {
	models?: MockModelDef[];
	/** First matching rule wins. Always include a catch-all last. */
	rules: MockRule[];
}

export interface ChatMessage {
	role?: string;
	content?: unknown;
	tool_calls?: unknown;
	name?: string;
	tool_call_id?: string;
}

export interface ChatCompletionRequest {
	model?: string;
	stream?: boolean;
	messages?: ChatMessage[];
	tools?: unknown[];
}

export interface ResolvedRequestContext {
	model: string;
	scenario: string;
	messages: ChatMessage[];
	textBlob: string;
	hasToolResult: boolean;
	turnIndex: number;
	role?: string;
	lastToolContent: string;
}

export interface MockServerOptions {
	host?: string;
	port?: number;
	/** Named built-in scenario, or "script" when using `script`. */
	scenario?: string;
	script?: MockScript;
	logPath?: string;
	/** Legacy docker env: first tool call name when scenario is tool-once. */
	defaultToolName?: string;
	defaultToolArgs?: string;
}
