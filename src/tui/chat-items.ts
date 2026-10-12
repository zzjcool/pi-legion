import {
	AssistantMessageComponent,
	ToolExecutionComponent,
	UserMessageComponent,
	getMarkdownTheme,
	migrateSessionEntries,
	parseSessionEntries,
	sessionEntryToContextMessages,
} from "@earendil-works/pi-coding-agent";
import type {
	AssistantMessage,
	ThinkingContent,
	TextContent,
	ToolResultMessage,
} from "@earendil-works/pi-ai";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { MarkdownTheme, TUI } from "@earendil-works/pi-tui";

export type ChatItem =
	| { kind: "user"; component: UserMessageComponent; revoked?: boolean }
	| { kind: "assistant"; component: AssistantMessageComponent; revoked?: boolean }
	| { kind: "tool"; component: ToolExecutionComponent; toolCallId: string; revoked?: boolean };

export interface ChatItemSettings {
	outputPad?: number;
	hideThinkingBlock?: boolean;
	codeBlockIndent?: string;
	showImages?: boolean;
	imageWidthCells?: number;
}

export interface ChatItemFactoryOptions {
	tui?: TUI;
	cwd: string;
	settings?: ChatItemSettings;
	markdownTheme?: MarkdownTheme;
}

export interface ChatItemFactory {
	/** All components created so far, in transcript order; revoked items preserve mount indices. */
	readonly items: readonly ChatItem[];
	/** Append parsed session messages. Returns the new items and whether the view changed. */
	appendMessages(messages: readonly AgentMessage[]): {
		added: readonly ChatItem[];
		changed: boolean;
	};
	/** Create/update the one currently streaming assistant component. */
	updateStreamingText(text: string, model?: string): AssistantMessageComponent;
	/** Revoke the streaming assistant without finalizing it; return its accumulated text. */
	retractStreamingItem(): string;
	/** Mark the current streaming assistant message complete, if one exists. */
	finishStreaming(): void;
	/** Change every tool component's expanded state. */
	setToolsExpanded(expanded: boolean): void;
}

const fallbackTui = { requestRender() {} } as TUI;

/**
 * Parse a session JSONL file using Pi's public session APIs. Invalid/torn JSON
 * lines are skipped by parseSessionEntries; non-object rows and unsupported
 * entry kinds are ignored before they can reach the message components.
 */
export function parseSessionMessages(content: string): AgentMessage[] {
	const entries = parseSessionEntries(content).filter(isRecord) as ReturnType<typeof parseSessionEntries>;
	try {
		migrateSessionEntries(entries);
	} catch {
		// A damaged legacy record must not prevent valid messages around it from rendering.
	}

	const messages: AgentMessage[] = [];
	for (const entry of entries) {
		if (!entry || typeof entry !== "object" || entry.type !== "message") continue;
		try {
			messages.push(...sessionEntryToContextMessages(entry).map(sanitizeMessageContent));
		} catch {
			// Session JSONL is external input; skip a malformed row and keep going.
		}
	}
	return messages;
}

/** Create persistent message-to-component state for one viewer instance. */
export function createChatItemFactory(options: ChatItemFactoryOptions): ChatItemFactory {
	const settings = options.settings ?? {};
	const outputPad = settings.outputPad ?? 1;
	const hideThinkingBlock = settings.hideThinkingBlock ?? false;
	const baseMarkdownTheme = options.markdownTheme ?? getMarkdownTheme();
	const markdownTheme = settings.codeBlockIndent === undefined
		? baseMarkdownTheme
		: { ...baseMarkdownTheme, codeBlockIndent: settings.codeBlockIndent };
	const tui = options.tui ?? fallbackTui;
	const items: ChatItem[] = [];
	const toolsByCallId = new Map<string, ToolExecutionComponent>();
	const pendingResults = new Map<string, ToolResultMessage>();
	let anonymousToolId = 0;
	let streamingComponent: AssistantMessageComponent | undefined;
	let streamingItem: Extract<ChatItem, { kind: "assistant" }> | undefined;
	let streamingText = "";

	const addToolCall = (
		name: string,
		toolCallId: string,
		args: unknown,
	): ToolExecutionComponent => {
		const component = new ToolExecutionComponent(
			name,
			toolCallId,
			args,
			{
				showImages: settings.showImages,
				imageWidthCells: settings.imageWidthCells,
				outputPad,
			},
			undefined,
			tui,
			options.cwd,
		);
		component.setExpanded(false);
		items.push({ kind: "tool", component, toolCallId });
		toolsByCallId.set(toolCallId, component);
		const pending = pendingResults.get(toolCallId);
		if (pending) {
			component.updateResult({
				content: pending.content,
				details: pending.details,
				isError: pending.isError,
				durationMs: pending.durationMs,
			});
			pendingResults.delete(toolCallId);
		}
		return component;
	};

	const appendMessages = (messages: readonly AgentMessage[]) => {
		const start = items.length;
		let changed = false;
		for (const message of messages) {
			if (!message || typeof message !== "object") continue;
			switch (message.role) {
				case "user": {
					const text = userMessageText(message.content);
					if (!text) break;
					items.push({
						kind: "user",
						component: new UserMessageComponent(text, markdownTheme, outputPad),
					});
					changed = true;
					break;
				}
				case "assistant": {
					const content = Array.isArray(message.content)
						? message.content.filter(isTextOrThinking)
						: [];
					const renderableMessage: AssistantMessage = { ...message, content };
					items.push({
						kind: "assistant",
						component: new AssistantMessageComponent(
							renderableMessage,
							hideThinkingBlock,
							markdownTheme,
							"Thinking...",
							outputPad,
						),
					});
					changed = true;
					if (!Array.isArray(message.content)) break;
					for (const part of message.content) {
						if (!part || part.type !== "toolCall") continue;
						const toolCallId = typeof part.id === "string" && part.id.length > 0
							? part.id
							: `legion-tool-${anonymousToolId++}`;
						const tool = addToolCall(
							typeof part.name === "string" && part.name.length > 0 ? part.name : "tool",
							toolCallId,
							part.arguments ?? {},
						);
						if (message.stopReason === "aborted" || message.stopReason === "error") {
							const errorText = message.stopReason === "aborted"
								? "Operation aborted"
								: message.errorMessage || "Error";
							tool.updateResult({
								content: [{ type: "text", text: errorText }],
								isError: true,
							});
						}
					}
					break;
				}
				case "toolResult": {
					const result = message as ToolResultMessage;
					if (typeof result.toolCallId !== "string" || !Array.isArray(result.content)) break;
					const safeResult = {
						...result,
						content: filterObjectContentParts(result.content),
					};
					const component = toolsByCallId.get(safeResult.toolCallId);
					if (component) {
						component.updateResult({
							content: safeResult.content,
							details: safeResult.details,
							isError: safeResult.isError,
							durationMs: safeResult.durationMs,
						});
						changed = true;
					} else {
						pendingResults.set(safeResult.toolCallId, safeResult);
					}
					break;
				}
				default:
					// system/custom/other message roles do not belong in the viewer.
					break;
			}
		}
		return { added: items.slice(start), changed };
	};

	const makeStreamingMessage = (text: string, model?: string): AssistantMessage => ({
		role: "assistant",
		content: text ? [{ type: "text", text }] : [],
		api: "openai-completions",
		provider: "openai",
		model: model || "unknown",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "pending",
		timestamp: Date.now(),
	});

	return {
		get items() {
			return items;
		},
		appendMessages,
		updateStreamingText(text, model) {
			if (!streamingComponent) {
				streamingComponent = new AssistantMessageComponent(
					undefined,
					hideThinkingBlock,
					markdownTheme,
					"Thinking...",
					outputPad,
				);
				streamingItem = { kind: "assistant", component: streamingComponent };
				items.push(streamingItem);
			}
			streamingText = text;
			streamingComponent.updateContent(makeStreamingMessage(streamingText, model), true);
			return streamingComponent;
		},
		retractStreamingItem() {
			if (!streamingComponent) return "";
			const text = streamingText;
			if (streamingItem) streamingItem.revoked = true;
			streamingComponent = undefined;
			streamingItem = undefined;
			streamingText = "";
			return text;
		},
		finishStreaming() {
			if (!streamingComponent) return;
			streamingComponent.updateContent(makeStreamingMessage(streamingText), false);
			streamingComponent = undefined;
			streamingItem = undefined;
			streamingText = "";
		},
		setToolsExpanded(expanded) {
			for (const item of items) {
				if (item.kind === "tool") item.component.setExpanded(expanded);
			}
		},
	};
}

function sanitizeMessageContent(message: AgentMessage): AgentMessage {
	switch (message.role) {
		case "user":
			return Array.isArray(message.content)
				? { ...message, content: filterObjectContentParts(message.content) }
				: message;
		case "assistant":
			return Array.isArray(message.content)
				? { ...message, content: filterObjectContentParts(message.content) }
				: message;
		case "toolResult":
			return Array.isArray(message.content)
				? { ...message, content: filterObjectContentParts(message.content) }
				: message;
		default:
			return message;
	}
}

function filterObjectContentParts<T>(content: readonly T[]): T[] {
	return content.filter((part) =>
		part !== null && typeof part === "object" && !Array.isArray(part),
	);
}

function userMessageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part): part is TextContent =>
			Boolean(part && typeof part === "object" && (part as { type?: unknown }).type === "text" && typeof (part as { text?: unknown }).text === "string"),
		)
		.map((part) => part.text)
		.join("");
}

function isTextOrThinking(
	part: AssistantMessage["content"][number],
): part is TextContent | ThinkingContent {
	return Boolean(part && typeof part === "object" && (part.type === "text" || part.type === "thinking"));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
