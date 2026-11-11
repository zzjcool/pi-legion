import {
	AssistantMessageComponent,
	ToolExecutionComponent,
	UserMessageComponent,
	getMarkdownTheme,
	migrateSessionEntries,
	parseSessionEntries,
	sessionEntryToContextMessages,
} from "@earendil-works/pi-coding-agent";
import type { ToolRenderers } from "@earendil-works/pi-coding-agent";
import type {
	AssistantMessage,
	ThinkingContent,
	TextContent,
	ToolResultMessage,
} from "@earendil-works/pi-ai";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { MarkdownTheme, TUI } from "@earendil-works/pi-tui";
import { createToolRendererLookup } from "./tool-renderers.ts";

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
	/** D1: how a tool name maps to the host's built-in renderers; defaults to `createToolRendererLookup(cwd)`. */
	rendererLookup?: (toolName: string) => ToolRenderers | undefined;
}

/** D9: session-entry metadata a host message component renders with, when the entry carries it. */
export interface SessionMessageMeta {
	/** Session entry `id`; forwarded to the component as `messageId`. */
	entryId?: string;
	/** Session entry `timestamp` as an ISO string; forwarded to the component as `timestamp`. */
	timestamp?: string;
}

export interface SessionMessagesWithMeta {
	messages: AgentMessage[];
	/** Parallel to `messages`: `meta[i]` describes `messages[i]`. */
	meta: SessionMessageMeta[];
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
	/** D4: accumulate a thinking delta into the current streaming assistant (created when absent). */
	appendStreamingThinking(delta: string, model?: string): AssistantMessageComponent;
	/** D5: snapshot of the streaming accumulation; does not finalize the item. */
	streamingParts(): { text: string; thinking: string };
	/** D6: live tool arguments; an unknown `toolCallId` is a silent no-op. */
	updateToolArgs(toolCallId: string, args: unknown): void;
	/** D8: the tool started executing (host `Elapsed` clock + shell state). Repeated calls are idempotent. */
	markToolStarted(toolCallId: string): void;
	/** D3: release the host's per-tool timers before the viewer is discarded. */
	releaseToolTimers(): void;
}

const fallbackTui = { requestRender() {} } as TUI;

/**
 * Entry metadata of every message produced by {@link parseSessionMessagesWithMeta}, keyed by the
 * message object itself. `appendMessages()` keeps its signature (messages only), so this registry is
 * how D9 metadata reaches the host components without a parallel-array hand-off.
 */
const entryMetaByMessage = new WeakMap<AgentMessage, SessionMessageMeta>();

/**
 * Parse a session JSONL file using Pi's public session APIs. Invalid/torn JSON
 * lines are skipped by parseSessionEntries; non-object rows and unsupported
 * entry kinds are ignored before they can reach the message components.
 */
export function parseSessionMessages(content: string): AgentMessage[] {
	return parseSessionMessagesWithMeta(content).messages;
}

/**
 * Same parse as {@link parseSessionMessages}, plus the session-entry metadata (`id` / `timestamp`)
 * of each message, so message components can be built exactly like the host's transcript (D9).
 * The metadata is also registered for `appendMessages()`; see {@link entryMetaByMessage}.
 */
export function parseSessionMessagesWithMeta(content: string): SessionMessagesWithMeta {
	const entries = parseSessionEntries(content).filter(isRecord) as ReturnType<typeof parseSessionEntries>;
	try {
		migrateSessionEntries(entries);
	} catch {
		// A damaged legacy record must not prevent valid messages around it from rendering.
	}

	const messages: AgentMessage[] = [];
	const meta: SessionMessageMeta[] = [];
	for (const entry of entries) {
		if (!entry || typeof entry !== "object" || entry.type !== "message") continue;
		try {
			const entryMeta = readEntryMeta(entry);
			for (const message of sessionEntryToContextMessages(entry).map(sanitizeMessageContent)) {
				entryMetaByMessage.set(message, entryMeta);
				messages.push(message);
				meta.push(entryMeta);
			}
		} catch {
			// Session JSONL is external input; skip a malformed row and keep going.
		}
	}
	return { messages, meta };
}

function readEntryMeta(entry: { id?: unknown; timestamp?: unknown }): SessionMessageMeta {
	const meta: SessionMessageMeta = {};
	if (typeof entry.id === "string" && entry.id.length > 0) meta.entryId = entry.id;
	if (typeof entry.timestamp === "string" && entry.timestamp.length > 0) {
		meta.timestamp = entry.timestamp;
	} else if (typeof entry.timestamp === "number" && Number.isFinite(entry.timestamp)) {
		meta.timestamp = new Date(entry.timestamp).toISOString();
	}
	return meta;
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
	// D1: the host's built-in renderers for built-in tool names; the caller may inject its own lookup.
	const rendererLookup = options.rendererLookup ?? createToolRendererLookup(options.cwd);
	const items: ChatItem[] = [];
	const toolsByCallId = new Map<string, ToolExecutionComponent>();
	const pendingResults = new Map<string, ToolResultMessage>();
	/** Per-tool drive state: whether the host clock was started, and whether a terminal result landed. */
	const toolRuntime = new Map<string, { started: boolean; final: boolean }>();
	let anonymousToolId = 0;
	let streamingComponent: AssistantMessageComponent | undefined;
	let streamingItem: Extract<ChatItem, { kind: "assistant" }> | undefined;
	let streamingText = "";
	let streamingThinking = "";
	let streamingModel: string | undefined;

	const applyToolResult = (
		toolCallId: string,
		component: ToolExecutionComponent,
		result: {
			content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
			details?: unknown;
			isError: boolean;
			durationMs?: number;
		},
	): void => {
		component.updateResult(result);
		const runtime = toolRuntime.get(toolCallId);
		if (runtime) runtime.final = true;
		else toolRuntime.set(toolCallId, { started: false, final: true });
	};

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
			rendererLookup(name),
			tui,
			options.cwd,
		);
		// D2/D16: a replayed block is driven the way the host drives a finished tool — expanded state and
		// complete args — but WITHOUT `markExecutionStarted()`. The host's `Took` fallback is
		// `endedAt - startedAt`, so a clock started when the viewer opened would print a fake `Took 0.0s`
		// for historical results that carry no `durationMs` (~0.35% of them). A final result that HAS a
		// `durationMs` renders it straight from the context (`toolTimerText` prefers it), so the real
		// duration is unaffected; live execution starts the clock through `markToolStarted`.
		component.setExpanded(false);
		component.setArgsComplete();
		toolRuntime.set(toolCallId, { started: false, final: false });
		items.push({ kind: "tool", component, toolCallId });
		toolsByCallId.set(toolCallId, component);
		// The pending backfill takes the same drive order: it lands after the three calls above.
		const pending = pendingResults.get(toolCallId);
		if (pending) {
			applyToolResult(toolCallId, component, {
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
					const meta = entryMetaByMessage.get(message);
					items.push({
						kind: "user",
						component: new UserMessageComponent(
							text,
							markdownTheme,
							outputPad,
							undefined,
							meta?.entryId,
							meta?.timestamp,
						),
					});
					changed = true;
					break;
				}
				case "assistant": {
					const content = Array.isArray(message.content)
						? message.content.filter(isTextOrThinking)
						: [];
					const hasToolCall = Array.isArray(message.content) &&
						message.content.some((part) => part?.type === "toolCall");
					if (content.length === 0 && !hasToolCall) break;
					const renderableMessage: AssistantMessage = { ...message, content };
					const meta = entryMetaByMessage.get(message);
					items.push({
						kind: "assistant",
						component: new AssistantMessageComponent(
							renderableMessage,
							hideThinkingBlock,
							markdownTheme,
							"Thinking...",
							outputPad,
							undefined,
							meta?.entryId,
							meta?.timestamp,
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
							applyToolResult(toolCallId, tool, {
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
						applyToolResult(safeResult.toolCallId, component, {
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

	// D4: one streaming component carries both runs, in the host's content order: thinking first, then text.
	const makeStreamingContent = (text: string, thinking: string): AssistantMessage["content"] => {
		const content: AssistantMessage["content"] = [];
		if (thinking) content.push({ type: "thinking", thinking });
		if (text) content.push({ type: "text", text });
		return content;
	};

	const makeStreamingMessage = (text: string, thinking: string, model?: string): AssistantMessage => ({
		role: "assistant",
		content: makeStreamingContent(text, thinking),
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

	/** One streaming assistant item per factory: create it on the first delta of either kind. */
	const ensureStreamingComponent = (): AssistantMessageComponent => {
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
		return streamingComponent;
	};

	const clearStreamingState = (): void => {
		streamingComponent = undefined;
		streamingItem = undefined;
		streamingText = "";
		streamingThinking = "";
		streamingModel = undefined;
	};

	return {
		get items() {
			return items;
		},
		appendMessages,
		updateStreamingText(text, model) {
			const component = ensureStreamingComponent();
			streamingText = text;
			if (model) streamingModel = model;
			component.updateContent(makeStreamingMessage(streamingText, streamingThinking, streamingModel), true);
			return component;
		},
		appendStreamingThinking(delta, model) {
			const component = ensureStreamingComponent();
			if (typeof delta === "string" && delta.length > 0) streamingThinking += delta;
			if (model) streamingModel = model;
			component.updateContent(makeStreamingMessage(streamingText, streamingThinking, streamingModel), true);
			return component;
		},
		streamingParts() {
			return { text: streamingText, thinking: streamingThinking };
		},
		retractStreamingItem() {
			if (!streamingComponent) return "";
			const text = streamingText;
			if (streamingItem) streamingItem.revoked = true;
			clearStreamingState();
			return text;
		},
		finishStreaming() {
			if (!streamingComponent) return;
			streamingComponent.updateContent(
				makeStreamingMessage(streamingText, streamingThinking, streamingModel),
				false,
			);
			clearStreamingState();
		},
		setToolsExpanded(expanded) {
			for (const item of items) {
				if (item.kind === "tool") item.component.setExpanded(expanded);
			}
		},
		updateToolArgs(toolCallId, args) {
			// D6: an id that never became a component (result-before-call, unknown tool) is a no-op.
			const component = toolsByCallId.get(toolCallId);
			if (!component) return;
			component.updateArgs(args);
		},
		markToolStarted(toolCallId) {
			// D8: the host clock starts once. Replay deliberately does NOT start it (D16), so this is the
			// only place a `startedAt` is ever recorded.
			const component = toolsByCallId.get(toolCallId);
			if (!component) return;
			const runtime = toolRuntime.get(toolCallId);
			if (runtime?.started) return;
			component.markExecutionStarted();
			if (runtime) runtime.started = true;
			else toolRuntime.set(toolCallId, { started: true, final: false });
		},
		releaseToolTimers() {
			// D3: a terminal result makes the host renderer clear its 1s interval. The component is thrown
			// away right after the viewer closes, so the placeholder content never reaches a frame.
			for (const [toolCallId, component] of toolsByCallId) {
				const runtime = toolRuntime.get(toolCallId);
				if (!runtime || !runtime.started || runtime.final) continue;
				applyToolResult(toolCallId, component, { content: [], isError: false, durationMs: 0 });
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
