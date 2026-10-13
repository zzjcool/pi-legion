import {
	Container,
	Key,
	Spacer,
	matchesKey,
	stripTerminalSequences,
	truncateToWidth,
	visibleWidth,
	type Component,
	type OverlayHandle,
	type TUI,
	type TuiMouseEvent,
} from "@earendil-works/pi-tui";
import type { KeybindingsManager } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { LegionNode } from "../legion/nodes.ts";
import {
	createChatItemFactory,
	type ChatItem,
	type ChatItemSettings,
} from "./chat-items.ts";

export interface LiveOverlayNode extends Pick<LegionNode, "id" | "name" | "role" | "model" | "status" | "createdAt" | "updatedAt"> {
	turn?: number;
	turns?: number;
	sessionFile?: string | null;
	worktreePath?: string | null;
}

/** A normalized tree-bus or RPC event associated with one Legion node. */
export interface LiveOverlayEvent {
	type: string;
	nodeId?: string;
	ts?: number;
	id?: number;
	domain?: "stored" | "process";
	data?: unknown;
	[key: string]: unknown;
}

export interface LiveOverlayBackfillCursor {
	/** Number of parsed user messages already represented by the overlay. */
	turnCount: number;
	/** Number of parsed assistant messages already represented by the overlay. */
	assistantMessageCount: number;
	/** Number of parsed message entries already represented by the overlay. */
	messageCount: number;
	/** Session file size used to skip polls when the append-only file is unchanged. */
	fileSize: number;
}

export interface LiveOverlayBackfillResult {
	/** Full parsed transcript; the cursor identifies messages already consumed. */
	messages: readonly AgentMessage[];
	cursor: LiveOverlayBackfillCursor;
}

/**
 * Load structured session history before subscribing. `maxBackfillTurns` is retained
 * for API/test compatibility; the context viewer deliberately renders all turns.
 */
export type LiveOverlayBackfill = (
	nodeId: string,
	maxBackfillTurns: number,
) => LiveOverlayBackfillResult | undefined;

export type LiveOverlaySubscription = (() => void) & {
	/** Session-file backfill poll, including when a live text-delta RPC feed is subscribed. */
	pollBackfill?: (cursor: LiveOverlayBackfillCursor) => LiveOverlayBackfillResult | undefined;
};
export type LiveOverlayListener = (event: LiveOverlayEvent) => void;

export interface LiveOverlaySource {
	subscribe(nodeId: string, listener: LiveOverlayListener): LiveOverlaySubscription;
	unsubscribe(subscription: LiveOverlaySubscription): void;
	getNode(nodeId: string): LiveOverlayNode | null | undefined;
	backfill?: LiveOverlayBackfill;
}

export interface LiveOverlayTheme {
	fg(color: "accent" | "dim" | "success" | "error", text: string): string;
}

export interface LiveOverlayOpenOptions {
	done?: (result?: undefined) => void;
	now?: () => number;
	theme?: LiveOverlayTheme;
	requestRender?: () => void;
	maxLines?: number;
	maxLineWidth?: number;
	maxBackfillTurns?: number;
	/** Working directory supplied to tool renderers when the node has no worktree. */
	cwd?: string;
	/** Effective pi host settings used by the reusable message components. */
	settings?: ChatItemSettings;
	/** Runtime arguments supplied by ctx.ui.custom; direct callers may omit them. */
	tui?: TUI;
	keybindings?: KeybindingsManager;
	terminalRows?: number | (() => number);
	/** `x`: ask the host to stop this agent (it confirms first). */
	onStop?: (nodeId: string) => void;
	/** Override the source's session-history loader (primarily for embedding and tests). */
	backfill?: LiveOverlayBackfill;
}

export interface LiveOverlayState {
	nodeId: string;
	open: boolean;
	items: readonly ChatItem[];
	itemCount: number;
	/** Compatibility/test projection of message and coarse event text; not rendered. */
	activity: readonly string[];
	/** Plain-text projection of transcript components (ANSI sequences removed). */
	text: string;
	streamingText: string;
	turn: number;
	status: string;
	hasSession: boolean;
	cursor: LiveOverlayBackfillCursor | undefined;
	scrollTop: number;
	followEnd: boolean;
}

export interface LiveOverlayComponent extends Component {
	readonly nodeId: string;
	close(): void;
	attachOverlayHandle(handle: OverlayHandle): void;
	getState(): LiveOverlayState;
	dispose(): void;
}

export interface LiveOverlayController {
	/** Open one node's viewer, subscribing only for the lifetime of this component. */
	open(nodeId: string, options?: LiveOverlayOpenOptions): LiveOverlayComponent;
	/** Close the current viewer, if any. */
	close(): void;
	getCurrent(): LiveOverlayComponent | undefined;
}

const DEFAULT_VIEWER_LINES = 120;
const DEFAULT_VIEWER_LINE_WIDTH = 2_000;
/**
 * Retained as the historical/test-injection default. The structured context
 * viewer deliberately backfills the full session transcript instead of truncating turns.
 */
const DEFAULT_BACKFILL_TURNS = 3;
const DEFAULT_TERMINAL_ROWS = 24;
const TOOL_COLLAPSED_PREVIEW_LINES = 10;
const BACKFILL_POLL_INTERVAL_MS = 250;

/**
 * Build an on-demand context-viewer controller. Calling `open` subscribes to
 * the requested node; closing, Esc, disposal, or replacing it unsubscribes once.
 */
export function createLiveOverlay(source: LiveOverlaySource): LiveOverlayController {
	let current: LiveOverlayComponent | undefined;
	return {
		open(nodeId, options = {}) {
			if (typeof nodeId !== "string" || nodeId.length === 0) {
				throw new TypeError("nodeId must be a non-empty string");
			}
			current?.close();
			let createdComponent: LiveOverlayComponent | undefined;
			const component = createSession(source, nodeId, options, () => {
				if (current === createdComponent) current = undefined;
			});
			createdComponent = component;
			current = component;
			return component;
		},
		close() {
			current?.close();
		},
		getCurrent: () => current,
	};
}

/** Create the `ctx.ui.custom()` factory shape for one node's viewer. */
export function createLiveOverlayFactory<T>(
	controller: LiveOverlayController,
	nodeId: string,
	options: Omit<LiveOverlayOpenOptions, "done" | "theme" | "requestRender" | "tui" | "keybindings" | "terminalRows"> = {},
): (
	tui: TUI,
	theme: LiveOverlayTheme,
	keybindings: KeybindingsManager,
	done: (result: T) => void,
) => LiveOverlayComponent {
	return (tui, theme, keybindings, done) =>
		controller.open(nodeId, {
			...options,
			tui,
			theme,
			keybindings,
			terminalRows: () => tui.terminal.rows,
			requestRender: () => tui.requestRender(),
			done: () => done(undefined as T),
		});
}

function createSession(
	source: LiveOverlaySource,
	nodeId: string,
	options: LiveOverlayOpenOptions,
	onClose: () => void,
): LiveOverlayComponent {
	const now = options.now ?? (() => Date.now());
	const maxLines = options.maxLines ?? DEFAULT_VIEWER_LINES;
	const maxLineWidth = options.maxLineWidth ?? DEFAULT_VIEWER_LINE_WIDTH;
	const maxBackfillTurns = options.maxBackfillTurns ?? DEFAULT_BACKFILL_TURNS;
	if (!Number.isSafeInteger(maxLines) || maxLines < 1) {
		throw new TypeError("maxLines must be a positive safe integer");
	}
	if (!Number.isSafeInteger(maxLineWidth) || maxLineWidth < 1) {
		throw new TypeError("maxLineWidth must be a positive safe integer");
	}
	if (!Number.isSafeInteger(maxBackfillTurns) || maxBackfillTurns < 0) {
		throw new TypeError("maxBackfillTurns must be a non-negative safe integer");
	}

	const initialNode = source.getNode(nodeId);
	const cwd = initialNode?.worktreePath ?? options.cwd ?? process.cwd();
	const chat = createChatItemFactory({
		tui: options.tui,
		cwd,
		settings: options.settings,
	});
	const transcript = new Container();
	let renderedItemCount = 0;
	const mountedItems = new Set<ChatItem>();
	let open = true;
	let hasSession = false;
	let subscription: LiveOverlaySubscription | undefined;
	let backfillInterval: ReturnType<typeof globalThis.setInterval> | undefined;
	let backfillCursor: LiveOverlayBackfillCursor | undefined;
	let overlayHandle: OverlayHandle | undefined;
	let turn = initialNode?.turn ?? initialNode?.turns ?? 0;
	let turnStartedAt: number | undefined;
	let streamingText = "";
	let finalizedAssistantText = "";
	const activity: string[] = [];
	let lastActivityTextLine = -1;
	let toolsExpanded = false;
	let followEnd = true;
	let scrollTop = 0;
	let contentWidth = 80;
	let lastBodyLines: string[] = [];
	const seenEventIds = new Set<number>();
	interface LifecyclePair {
		stored?: number;
		process?: number;
		storedPaired?: boolean;
		processPaired?: boolean;
	}
	const recentLifecycle = new Map<string, LifecyclePair>();
	const lifecycleEventTypes = new Set([
		"node_launched",
		"node_retired",
		"node_settled",
		"node_failed",
		"node_blocked",
		"node_resumed",
		"phase_change",
	]);
	const lifecyclePairWindowMs = 1_000;

	const safeText = (value: unknown): string => {
		if (typeof value !== "string") return "";
		return stripTerminalSequences(value)
			.replace(/[\r\n\t]/g, " ")
			.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
	};

	const safeActivityText = (value: string): string => stripTerminalSequences(value)
		.replace(/\r\n?/g, "\n")
		.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");

	const sourceNode = (): LiveOverlayNode | undefined => source.getNode(nodeId) ?? undefined;

	const currentTerminalRows = (): number => {
		const value = typeof options.terminalRows === "function"
			? options.terminalRows()
			: options.terminalRows ?? DEFAULT_TERMINAL_ROWS;
		if (!Number.isSafeInteger(value) || value < 1) {
			throw new TypeError("terminalRows must be a positive safe integer");
		}
		return value;
	};

	const bodyPageSize = (): number => Math.max(0, currentTerminalRows() - 1);

	const mountNewItems = (): void => {
		for (const item of mountedItems) {
			if (!item.revoked) continue;
			if (item.kind === "assistant") transcript.removeChild(item.component);
			mountedItems.delete(item);
		}
		const items = chat.items;
		for (; renderedItemCount < items.length; renderedItemCount++) {
			const item = items[renderedItemCount];
			if (!item || item.revoked) continue;
			if (item.kind === "user" && renderedItemCount > 0) transcript.addChild(new Spacer(1));
			if (item.kind !== "tool") {
				transcript.addChild(item.component);
				mountedItems.add(item);
				continue;
			}
			// pi 1.1.0's undefined-toolDefinition fallback always displays the
			// full output and ignores setExpanded(). Keep the public component,
			// but cap its transcript lines while collapsed so ctrl+o still toggles.
			transcript.addChild({
				render(width) {
					const lines = item.component.render(width);
					if (toolsExpanded || lines.length <= TOOL_COLLAPSED_PREVIEW_LINES) return lines;
					const visible = lines.slice(0, TOOL_COLLAPSED_PREVIEW_LINES);
					const expandKeys = options.keybindings?.getKeys("app.tools.expand").join("/") || "ctrl+o";
					visible.push(style(
						options.theme,
						"dim",
						fitLine(`… (${lines.length - visible.length} more lines · ${expandKeys} to expand)`, width),
					));
					return visible;
				},
				handleMouse(event) {
					return item.component.handleMouse(event);
				},
				invalidate() {
					item.component.invalidate();
				},
			});
			mountedItems.add(item);
		}
	};

	const renderBody = (width: number): string[] => {
		mountNewItems();
		const lines = transcript.render(width);
		if (lines.length > 0) return lines;
		return [hasSession ? "No displayable messages." : "No session yet."];
	};

	const maxScrollTop = (lines: readonly string[]): number =>
		Math.max(0, lines.length - bodyPageSize());

	const clampScroll = (lines: readonly string[]): void => {
		scrollTop = Math.max(0, Math.min(maxScrollTop(lines), Math.trunc(scrollTop)));
	};

	const syncScroll = (lines: readonly string[]): void => {
		if (followEnd) scrollTop = maxScrollTop(lines);
		else clampScroll(lines);
	};

	const requestRender = (): void => options.requestRender?.();

	const trimActivity = (): void => {
		if (activity.length <= maxLines) return;
		const removed = activity.length - maxLines;
		activity.splice(0, removed);
		lastActivityTextLine = lastActivityTextLine < removed
			? -1
			: lastActivityTextLine - removed;
	};

	const appendActivityLine = (line: string): void => {
		for (const segment of line.split("\n")) activity.push(safeActivityText(segment).slice(0, maxLineWidth));
		lastActivityTextLine = -1;
		trimActivity();
	};

	const appendActivityText = (text: string): void => {
		for (const [index, chunk] of text.split("\n").entries()) {
			if (index > 0) {
				activity.push("");
				lastActivityTextLine = activity.length - 1;
			}
			if (!chunk) continue;
			if (lastActivityTextLine < 0 || lastActivityTextLine !== activity.length - 1) {
				activity.push("");
				lastActivityTextLine = activity.length - 1;
			}
			activity[lastActivityTextLine] = `${activity[lastActivityTextLine] ?? ""}${safeActivityText(chunk)}`.slice(-maxLineWidth);
		}
		trimActivity();
	};

	const projectMessagesToActivity = (messages: readonly AgentMessage[]): void => {
		for (const message of messages) {
			if (!message || typeof message !== "object") continue;
			if (message.role === "user") {
				const text = messageText(message.content);
				if (text) appendActivityLine(`▸ ${text}`);
			} else if (message.role === "assistant" && Array.isArray(message.content)) {
				const text = messageText(message.content);
				if (text) appendActivityLine(text);
				for (const part of message.content) {
					if (part !== null && typeof part === "object" && part.type === "toolCall") {
						appendActivityLine(`⚙ ${part.name}`);
					}
				}
			}
		}
	};

	const messageText = (content: unknown): string => {
		if (typeof content === "string") return content;
		if (!Array.isArray(content)) return "";
		const textParts: string[] = [];
		for (const part of content) {
			if (part === null || typeof part !== "object" || Array.isArray(part)) continue;
			if (!("type" in part) || part.type !== "text") continue;
			if (!("text" in part) || typeof part.text !== "string") continue;
			textParts.push(part.text);
		}
		return textParts.join("");
	};

	const appendMessages = (messages: readonly AgentMessage[], redraw: boolean): boolean => {
		projectMessagesToActivity(messages);
		const result = chat.appendMessages(messages);
		mountNewItems();
		if (toolsExpanded) chat.setToolsExpanded(true);
		if (result.changed && redraw) {
			lastBodyLines = renderBody(contentWidth);
			syncScroll(lastBodyLines);
			requestRender();
		}
		return result.changed;
	};

	const isCursorRegression = (
		previous: LiveOverlayBackfillCursor,
		next: LiveOverlayBackfillCursor,
	): boolean => next.messageCount < previous.messageCount ||
		next.turnCount < previous.turnCount ||
		next.assistantMessageCount < previous.assistantMessageCount ||
		next.fileSize < previous.fileSize;

	const acceptBackfill = (update: LiveOverlayBackfillResult, initial: boolean): boolean => {
		const previous = backfillCursor;
		if (previous && isCursorRegression(previous, update.cursor)) return false;
		let messages = update.messages;
		if (!initial && previous) {
			// A source may retry a parsed tail after a torn write. Only consume the
			// entries beyond the previous monotonic message cursor.
			const addedMessageCount = Math.max(0, update.cursor.messageCount - previous.messageCount);
			messages = messages.slice(previous.messageCount, previous.messageCount + addedMessageCount);
		}
		backfillCursor = { ...update.cursor };
		hasSession = true;
		turn = Math.max(turn, update.cursor.turnCount);

		if (!initial && finalizedAssistantText) {
			const finalizedText = finalizedAssistantText;
			let consumedFinalizedText = false;
			messages = messages.map((message) => {
				if (
					consumedFinalizedText ||
					message.role !== "assistant" ||
					!Array.isArray(message.content) ||
					!messageText(message.content).includes(finalizedText)
				) {
					return message;
				}
				consumedFinalizedText = true;
				return { ...message, content: message.content.filter((part) => part?.type !== "text") };
			});
			if (consumedFinalizedText) finalizedAssistantText = "";
		}

		let diskAssistantText: string | undefined;
		if (!initial) {
			for (const message of messages) {
				if (message.role === "assistant") diskAssistantText = messageText(message.content);
			}
		}
		if (diskAssistantText !== undefined) {
			const retractedText = chat.retractStreamingItem();
			const currentStreamingText = retractedText || streamingText;
			let remainingStreamingText = "";
			if (currentStreamingText && !diskAssistantText.includes(currentStreamingText)) {
				remainingStreamingText = currentStreamingText.startsWith(diskAssistantText)
					? currentStreamingText.slice(diskAssistantText.length)
					: currentStreamingText;
			}
			streamingText = "";
			const changed = appendMessages(messages, false);
			if (remainingStreamingText) {
				streamingText = remainingStreamingText;
				chat.updateStreamingText(
					streamingText,
					sourceNode()?.model ?? initialNode?.model ?? undefined,
				);
				mountNewItems();
			}
			if (changed) {
				lastBodyLines = renderBody(contentWidth);
				syncScroll(lastBodyLines);
				requestRender();
			} else if (messages.length > 0) {
				requestRender();
			}
			return changed;
		}

		const changed = appendMessages(messages, !initial);
		if (!initial && !changed && messages.length > 0) requestRender();
		return changed;
	};

	const initialBackfill = options.backfill?.(nodeId, maxBackfillTurns) ??
		source.backfill?.(nodeId, maxBackfillTurns);
	if (initialBackfill) {
		acceptBackfill(initialBackfill, true);
		lastBodyLines = renderBody(contentWidth);
		if (followEnd) syncScroll(lastBodyLines);
	}

	const readString = (event: LiveOverlayEvent, key: string): string | undefined => {
		const direct = event[key];
		if (typeof direct === "string") return direct;
		if (event.data && typeof event.data === "object" && !Array.isArray(event.data)) {
			const value = (event.data as Record<string, unknown>)[key];
			if (typeof value === "string") return value;
		}
		return undefined;
	};

	const clampStreamingText = (text: string): string => text
		.split("\n")
		.slice(-maxLines)
		.map((line) => line.slice(-maxLineWidth))
		.join("\n");

	const updateStreamingText = (delta: string): void => {
		if (!delta) return;
		if (finalizedAssistantText) finalizedAssistantText = "";
		streamingText = clampStreamingText(`${streamingText}${delta}`);
		appendActivityText(delta);
		chat.updateStreamingText(streamingText, sourceNode()?.model ?? initialNode?.model ?? undefined);
		mountNewItems();
		lastBodyLines = renderBody(contentWidth);
		syncScroll(lastBodyLines);
		requestRender();
	};

	const finishStreaming = (): void => {
		if (!streamingText) return;
		chat.finishStreaming();
		finalizedAssistantText = streamingText;
		streamingText = "";
		requestRender();
	};

	const handleEvent = (event: LiveOverlayEvent): void => {
		if (!open || (event.nodeId !== undefined && event.nodeId !== nodeId)) return;
		if (event.id !== undefined) {
			if (seenEventIds.has(event.id)) return;
			seenEventIds.add(event.id);
			if (seenEventIds.size > DEFAULT_VIEWER_LINES * 4) {
				const oldest = seenEventIds.values().next().value;
				if (oldest !== undefined) seenEventIds.delete(oldest);
			}
		}
		if (lifecycleEventTypes.has(event.type)) {
			const domain = event.domain ?? (event.id === undefined ? "process" : "stored");
			const timestamp = event.ts ?? now();
			const previous = recentLifecycle.get(event.type) ?? {};
			const oppositeTimestamp = domain === "stored" ? previous.process : previous.stored;
			const oppositePaired = domain === "stored" ? previous.processPaired : previous.storedPaired;
			const duplicate = oppositeTimestamp !== undefined && oppositePaired !== true &&
				Math.abs(timestamp - oppositeTimestamp) <= lifecyclePairWindowMs;
			const next: LifecyclePair = { ...previous };
			if (domain === "stored") {
				next.stored = timestamp;
				next.storedPaired = duplicate;
				if (duplicate) next.processPaired = true;
			} else {
				next.process = timestamp;
				next.processPaired = duplicate;
				if (duplicate) next.storedPaired = true;
			}
			if (next.stored !== undefined && Math.abs(timestamp - next.stored) > lifecyclePairWindowMs) {
				next.stored = undefined;
				next.storedPaired = undefined;
			}
			if (next.process !== undefined && Math.abs(timestamp - next.process) > lifecyclePairWindowMs) {
				next.process = undefined;
				next.processPaired = undefined;
			}
			if (next.stored === undefined && next.process === undefined) recentLifecycle.delete(event.type);
			else recentLifecycle.set(event.type, next);
			if (duplicate) return;
		}

		const updateType = readString(event, "updateType");
		const eventType = event.type === "message_update" ? updateType ?? event.type : event.type;
		if (eventType === "text_delta") {
			updateStreamingText(readString(event, "delta") ?? readString(event, "text") ?? "");
			return;
		}
		if (eventType === "turn_start") {
			finishStreaming();
			const data = event.data && typeof event.data === "object" && !Array.isArray(event.data)
				? event.data as Record<string, unknown>
				: undefined;
			turn = typeof data?.turn === "number" ? data.turn : turn + 1;
			// The in-flight turn starts now; time it until settlement.
			turnStartedAt = event.ts ?? now();
			appendActivityLine(`↻ turn ${turn}`);
			requestRender();
			return;
		}
		if (eventType === "agent_settled" || eventType === "agent_end") {
			finishStreaming();
			// The timed turn is over; stop counting it as "current".
			turnStartedAt = undefined;
			appendActivityLine("✓ agent turn settled");
			requestRender();
			return;
		}
		if (eventType === "tool_call" || eventType === "toolcall_start" || eventType === "toolcall_end" ||
			eventType === "tool_execution_start" || eventType === "tool_execution_end") {
			const toolPhase = readString(event, "phase");
			const toolStarted = eventType === "toolcall_start" || eventType === "tool_execution_start" ||
				(eventType === "tool_call" && toolPhase === "tool_execution_start");
			const toolEnded = eventType === "toolcall_end" || eventType === "tool_execution_end" ||
				(eventType === "tool_call" && toolPhase === "tool_execution_end");
			if (toolStarted) finishStreaming();
			const name = safeText(readString(event, "toolName") ?? readString(event, "name") ?? "tool");
			const phase = toolEnded ? "✓" : "⚙";
			appendActivityLine(`${phase} ${name}`);
		} else if (eventType !== "message_update") {
			appendActivityLine(`· ${safeText(eventType)}`);
		}
		// Lifecycle and coarse tool facts are retained for the test/state view;
		// conversation content itself is rendered only from structured messages.
		requestRender();
	};

	const getState = (): LiveOverlayState => {
		const node = sourceNode();
		lastBodyLines = renderBody(contentWidth);
		clampScroll(lastBodyLines);
		const items = chat.items.filter((item) => !item.revoked);
		return {
			nodeId,
			open,
			items,
			itemCount: items.length,
			activity: [...activity],
			text: lastBodyLines.map((line) => stripTerminalSequences(line)).join("\n"),
			streamingText,
			turn,
			status: node?.status ?? "unknown",
			hasSession,
			cursor: backfillCursor ? { ...backfillCursor } : undefined,
			scrollTop,
			followEnd,
		};
	};

	let stopPending = false;
	const headerLine = (width: number): string => {
		const safeWidth = Math.max(1, Math.floor(width));
		const node = sourceNode();
		if (!node) {
			const missing = `● ${nodeId} · node unavailable`;
			return style(options.theme, "dim", fitLine(missing, safeWidth));
		}
		const status = node.status;
		const completed = status === "settled" || status === "failed" || status === "retired";
		const elapsedEnd = completed ? node.updatedAt : now();
		const elapsed = `${Math.max(0, Math.round((elapsedEnd - node.createdAt) / 1_000))}s`;
		const turnNumber = turn || node.turn || node.turns || 0;
		const turnElapsed = turnStartedAt !== undefined && !completed
			? `${Math.max(0, Math.round((now() - turnStartedAt) / 1_000))}s`
			: undefined;
		const turnLabel = `turn ${turnNumber}${turnElapsed !== undefined ? ` (${turnElapsed})` : ""}`;
		const details = [
			`● ${safeText(node.name)} (${safeText(node.role)})`,
			...(node.model ? [safeText(node.model)] : []),
			turnLabel,
			elapsed,
			status,
		];
		return style(options.theme, completed ? "dim" : "accent", fitLine(details.join(" · "), safeWidth));
	};

	const close = (): void => {
		if (!open) return;
		open = false;
		if (backfillInterval !== undefined) {
			globalThis.clearInterval(backfillInterval);
			backfillInterval = undefined;
		}
		const activeSubscription = subscription;
		subscription = undefined;
		if (activeSubscription) source.unsubscribe(activeSubscription);
		const handle = overlayHandle;
		overlayHandle = undefined;
		// pi's custom() `done` already hides this overlay (ui.hideOverlay() pops the
		// TOP overlay). Hiding the handle as well popped the overlay underneath —
		// the /legion view — without resolving its promise, so the /legion command
		// never returned and pi silently queued every later prompt.
		if (handle && !options.done) handle.hide();
		onClose();
		options.done?.(undefined);
	};

	const scrollBy = (amount: number): void => {
		lastBodyLines = renderBody(contentWidth);
		const maximum = maxScrollTop(lastBodyLines);
		const next = Math.max(0, Math.min(maximum, scrollTop + Math.trunc(amount)));
		if (amount < 0) followEnd = false;
		if (next === scrollTop) {
			if (next >= maximum && amount > 0) followEnd = true;
			return;
		}
		scrollTop = next;
		followEnd = scrollTop >= maximum;
		requestRender();
	};

	const goToTop = (): void => {
		followEnd = false;
		if (scrollTop === 0) return;
		scrollTop = 0;
		requestRender();
	};

	const goToEnd = (): void => {
		lastBodyLines = renderBody(contentWidth);
		followEnd = true;
		const next = maxScrollTop(lastBodyLines);
		if (scrollTop === next) return;
		scrollTop = next;
		requestRender();
	};

	const component: LiveOverlayComponent = {
		nodeId,
		render(width) {
			contentWidth = Math.max(1, Math.floor(width));
			lastBodyLines = renderBody(contentWidth);
			syncScroll(lastBodyLines);
			const start = Math.max(0, scrollTop);
			const end = start + bodyPageSize();
			const header = stopPending
				? style(options.theme, "accent", fitLine(`Stop ${safeText(sourceNode()?.name ?? nodeId)}? Its own subagents are retired with it.  y stop · any other key cancel`, contentWidth))
				: headerLine(contentWidth);
			return [header, ...lastBodyLines.slice(start, end)];
		},
		handleInput(data) {
			if (!open) return;
			if (stopPending) {
				// In-overlay y/N prompt: a pi dialog could render behind this overlay.
				stopPending = false;
				if (matchesKey(data, "y") || data === "Y" || matchesKey(data, Key.enter)) options.onStop?.(nodeId);
				requestRender();
				return;
			}
			if (matchesKey(data, Key.escape)) {
				close();
				return;
			}
			if (options.keybindings?.matches(data, "app.tools.expand")) {
				toolsExpanded = !toolsExpanded;
				chat.setToolsExpanded(toolsExpanded);
				lastBodyLines = renderBody(contentWidth);
				syncScroll(lastBodyLines);
				requestRender();
				return;
			}
			if (matchesKey(data, "j") || matchesKey(data, Key.down)) {
				scrollBy(1);
			} else if (matchesKey(data, "k") || matchesKey(data, Key.up)) {
				scrollBy(-1);
			} else if (matchesKey(data, Key.pageDown)) {
				scrollBy(Math.max(1, bodyPageSize()));
			} else if (matchesKey(data, Key.pageUp)) {
				scrollBy(-Math.max(1, bodyPageSize()));
			} else if (matchesKey(data, "g")) {
				goToTop();
			} else if (matchesKey(data, Key.shift("g"))) {
				goToEnd();
			} else if (matchesKey(data, "x") && options.onStop) {
				const node = sourceNode();
				if (node && node.status !== "settled" && node.status !== "failed" && node.status !== "retired") {
					stopPending = true;
					requestRender();
				}
			}
		},
		handleMouse(event: TuiMouseEvent) {
			if (!open) return undefined;
			if (event.type === "wheel" && event.wheelDelta) {
				scrollBy(event.wheelDelta);
				return { handled: true };
			}
			contentWidth = Math.max(1, Math.floor(event.width));
			lastBodyLines = renderBody(contentWidth);
			clampScroll(lastBodyLines);
			const viewportY = event.y - 1;
			if (viewportY < 0 || viewportY >= bodyPageSize()) return undefined;
			const transcriptY = viewportY + scrollTop;
			if (transcriptY >= lastBodyLines.length) return undefined;
			return transcript.handleMouse({
				...event,
				y: transcriptY,
				height: lastBodyLines.length,
			});
		},
		invalidate() {
			transcript.invalidate();
		},
		close,
		attachOverlayHandle(handle) {
			if (!open) {
				handle.hide();
				return;
			}
			overlayHandle = handle;
		},
		getState,
		dispose() {
			close();
		},
	};

	try {
		subscription = source.subscribe(nodeId, handleEvent);
		if (backfillCursor && subscription.pollBackfill) {
			backfillInterval = globalThis.setInterval(() => {
				if (!open || !backfillCursor || !subscription?.pollBackfill) return;
				let update: LiveOverlayBackfillResult | undefined;
				try {
					update = subscription.pollBackfill(backfillCursor);
				} catch {
					// A transient file race must not break the TUI's interval callback.
					return;
				}
				if (update) {
					try {
						acceptBackfill(update, false);
					} catch {
						// Invalid SDK/session content must not escape the host polling callback.
						return;
					}
				}
			}, BACKFILL_POLL_INTERVAL_MS);
		}
	} catch (error) {
		if (backfillInterval !== undefined) globalThis.clearInterval(backfillInterval);
		backfillInterval = undefined;
		open = false;
		onClose();
		throw error;
	}
	return component;
}

function fitLine(line: string, width: number): string {
	const safeWidth = Math.max(1, Math.floor(width));
	return visibleWidth(line) <= safeWidth ? line : truncateToWidth(line, safeWidth);
}

function style(
	theme: LiveOverlayTheme | undefined,
	color: "accent" | "dim" | "success" | "error",
	line: string,
): string {
	return theme ? theme.fg(color, line) : line;
}
