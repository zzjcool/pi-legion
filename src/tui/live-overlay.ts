import {
	Key,
	matchesKey,
	stripTerminalSequences,
	truncateToWidth,
	visibleWidth,
	type Component,
	type OverlayHandle,
	type TUI,
} from "@earendil-works/pi-tui";
import type { LegionNode } from "../legion/nodes.ts";

export interface LiveOverlayNode extends Pick<LegionNode, "id" | "name" | "role" | "model" | "status" | "createdAt" | "updatedAt"> {
	turn?: number;
	turns?: number;
}

/** A normalized tree-bus or coarse RPC activity event; text is display-only. */
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
	/** Number of parsed turns already represented by the overlay. */
	turnCount: number;
	/** Number of assistant messages already represented by the overlay. */
	assistantMessageCount: number;
	/** Session file size used to skip polls when the append-only file is unchanged. */
	fileSize: number;
}

export interface LiveOverlayBackfillResult {
	lines: readonly string[];
	cursor: LiveOverlayBackfillCursor;
}

export type LiveOverlayBackfill = (
	nodeId: string,
	maxBackfillTurns: number,
) => LiveOverlayBackfillResult | undefined;

export type LiveOverlaySubscription = (() => void) & {
	/** Present only when the subscription did not acquire the live text-delta RPC feed. */
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
	/** Override the source's session-history loader (primarily for embedding and tests). */
	backfill?: LiveOverlayBackfill;
}

export interface LiveOverlayState {
	nodeId: string;
	open: boolean;
	activity: readonly string[];
	turn: number;
	status: string;
}

export interface LiveOverlayComponent extends Component {
	readonly nodeId: string;
	close(): void;
	attachOverlayHandle(handle: OverlayHandle): void;
	getState(): LiveOverlayState;
	dispose(): void;
}

export interface LiveOverlayController {
	/** Open one node's overlay, subscribing only for the lifetime of this component. */
	open(nodeId: string, options?: LiveOverlayOpenOptions): LiveOverlayComponent;
	/** Close the current overlay, if any. */
	close(): void;
	getCurrent(): LiveOverlayComponent | undefined;
}

const DEFAULT_ACTIVITY_LINES = 120;
const DEFAULT_ACTIVITY_LINE_WIDTH = 2_000;
const DEFAULT_BACKFILL_TURNS = 3;
const BACKFILL_POLL_INTERVAL_MS = 250;

/**
 * Build an on-demand live overlay controller. Calling `open` subscribes to the
 * requested node; closing, Esc, disposal, or replacing it unsubscribes exactly
 * once. Pass the returned component to `ctx.ui.custom(..., { overlay: true })`.
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

/** Create the custom-UI factory for a node; set `{ overlay: true }` on ui.custom. */
export function createLiveOverlayFactory<T>(
	controller: LiveOverlayController,
	nodeId: string,
	options: Omit<LiveOverlayOpenOptions, "done" | "theme" | "requestRender"> = {},
): (
	tui: Pick<TUI, "requestRender">,
	theme: LiveOverlayTheme,
	keybindings: unknown,
	done: (result: T) => void,
) => LiveOverlayComponent {
	return (tui, theme, _keybindings, done) =>
		controller.open(nodeId, {
			...options,
			theme,
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
	const maxLines = options.maxLines ?? DEFAULT_ACTIVITY_LINES;
	const maxLineWidth = options.maxLineWidth ?? DEFAULT_ACTIVITY_LINE_WIDTH;
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

	const activity: string[] = [];
	const seenStoredEvents = new Set<number>();
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
	let open = true;
	let subscription: LiveOverlaySubscription | undefined;
	let backfillInterval: ReturnType<typeof globalThis.setInterval> | undefined;
	let backfillCursor: LiveOverlayBackfillCursor | undefined;
	let overlayHandle: OverlayHandle | undefined;
	let lastTextLine = -1;
	const initialNode = source.getNode(nodeId);
	let turn = initialNode?.turn ?? initialNode?.turns ?? 0;
	let turnStartedAt: number | undefined;

	const safeEventText = (value: unknown): string => {
		if (typeof value !== "string") return "";
		return stripTerminalSequences(value)
			.replace(/\r\n?/g, "\n")
			.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
	};

	const keepActivityBounded = (): void => {
		if (activity.length > maxLines) {
			const removed = activity.length - maxLines;
			activity.splice(0, removed);
			lastTextLine = lastTextLine < removed ? -1 : lastTextLine - removed;
		}
	};

	const appendLine = (line: string): void => {
		for (const segment of line.split("\n")) {
			activity.push(segment.slice(0, maxLineWidth));
			lastTextLine = -1;
		}
		keepActivityBounded();
	};

	// Hydrate synchronously before subscribing so the first render has history;
	// this path intentionally does not call requestRender.
	const initialBackfill = options.backfill?.(nodeId, maxBackfillTurns) ??
		source.backfill?.(nodeId, maxBackfillTurns);
	if (initialBackfill) {
		backfillCursor = initialBackfill.cursor;
		for (const line of initialBackfill.lines) appendLine(safeEventText(line));
	}

	const appendText = (text: string): void => {
		const chunks = text.split("\n");
		for (const [index, chunk] of chunks.entries()) {
			if (index > 0) {
				activity.push("");
				lastTextLine = activity.length - 1;
			}
			if (!chunk) continue;
			if (lastTextLine < 0 || lastTextLine !== activity.length - 1) {
				activity.push("");
				lastTextLine = activity.length - 1;
			}
			const line = activity[lastTextLine] ?? "";
			activity[lastTextLine] = `${line}${chunk}`.slice(-maxLineWidth);
		}
		keepActivityBounded();
	};

	const readString = (event: LiveOverlayEvent, key: string): string | undefined => {
		const direct = event[key];
		if (typeof direct === "string") return direct;
		if (event.data && typeof event.data === "object" && !Array.isArray(event.data)) {
			const value = (event.data as Record<string, unknown>)[key];
			if (typeof value === "string") return value;
		}
		return undefined;
	};

	const handleEvent = (event: LiveOverlayEvent): void => {
		if (!open || (event.nodeId !== undefined && event.nodeId !== nodeId)) return;
		if (event.id !== undefined) {
			if (seenStoredEvents.has(event.id)) return;
			seenStoredEvents.add(event.id);
			if (seenStoredEvents.size > maxLines * 4) {
				const oldest = seenStoredEvents.values().next().value;
				if (oldest !== undefined) seenStoredEvents.delete(oldest);
			}
		}
		if (lifecycleEventTypes.has(event.type)) {
			const domain = event.domain ?? (event.id === undefined ? "process" : "stored");
			const key = event.type;
			const timestamp = event.ts ?? now();
			const previous = recentLifecycle.get(key) ?? {};
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
			if (next.stored === undefined && next.process === undefined) recentLifecycle.delete(key);
			else recentLifecycle.set(key, next);
			if (duplicate) return;
		}
		const updateType = readString(event, "updateType");
		const eventType = event.type === "message_update" ? updateType ?? event.type : event.type;
		if (eventType === "text_delta") {
			const delta = readString(event, "delta") ?? readString(event, "text");
			if (delta !== undefined) appendText(safeEventText(delta));
		} else if (
			eventType === "tool_call" ||
			eventType === "toolcall_start" ||
			eventType === "toolcall_end" ||
			eventType === "tool_execution_start" ||
			eventType === "tool_execution_end"
		) {
			const toolName = safeEventText(readString(event, "toolName") ?? readString(event, "name") ?? "tool");
			const phase = eventType === "toolcall_end" || eventType === "tool_execution_end" ? "✓" : "⚙";
			appendLine(`${phase} ${toolName}`);
		} else if (eventType === "turn_start") {
			const data = event.data && typeof event.data === "object" && !Array.isArray(event.data)
				? event.data as Record<string, unknown>
				: undefined;
			turn = typeof data?.turn === "number" ? data.turn : turn + 1;
			turnStartedAt = event.ts ?? now();
			appendLine(`↻ turn ${turn}`);
		} else if (eventType === "agent_settled" || eventType === "agent_end") {
			// RPC turn completion is activity, not a Legion node lifecycle transition.
			// The timed turn is over; stop counting it as "current".
			turnStartedAt = undefined;
			appendLine("✓ agent turn settled");
		} else if (eventType !== "message_update") {
			appendLine(`· ${safeEventText(eventType)}`);
		}
		options.requestRender?.();
	};

	const sourceNode = (): LiveOverlayNode | undefined => {
		const node = source.getNode(nodeId);
		return node ?? undefined;
	};

	const getState = (): LiveOverlayState => {
		const node = sourceNode();
		return {
			nodeId,
			open,
			activity: [...activity],
			turn: turn || node?.turn || node?.turns || 0,
			status: node?.status ?? "unknown",
		};
	};

	const render = (width: number): string[] => {
		const safeWidth = Math.max(1, Math.floor(width));
		const node = sourceNode();
		const lines: string[] = [];
		if (!node) {
			lines.push(style(options.theme, "dim", `● ${nodeId} · node unavailable`));
		} else {
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
				`● ${safeEventText(node.name)} (${safeEventText(node.role)})`,
				...(node.model ? [safeEventText(node.model)] : []),
				turnLabel,
				elapsed,
				status,
			];
			const header = details.join(" · ");
			lines.push(
				style(
					options.theme,
					completed ? "dim" : "accent",
					visibleWidth(header) <= safeWidth ? header : truncateToWidth(header, safeWidth),
				),
			);
		}
		const activities = activity.slice(-maxLines);
		if (activities.length === 0) {
			const empty = "No recent activity.";
			lines.push(visibleWidth(empty) <= safeWidth ? empty : truncateToWidth(empty, safeWidth));
		}
		else {
			for (const line of activities) {
				const safeLine = safeEventText(line);
				const fitted = visibleWidth(safeLine) <= safeWidth
					? safeLine
					: truncateToWidth(safeLine, safeWidth);
				lines.push(style(options.theme, "dim", fitted));
			}
		}
		return lines;
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
		if (handle) handle.hide();
		onClose();
		options.done?.(undefined);
	};

	const component: LiveOverlayComponent = {
		nodeId,
		render,
		handleInput(data) {
			if (matchesKey(data, Key.escape)) close();
		},
		invalidate() {},
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
				if (!update) return;
				backfillCursor = update.cursor;
				for (const line of update.lines) appendLine(safeEventText(line));
				if (update.lines.length > 0) options.requestRender?.();
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

function style(
	theme: LiveOverlayTheme | undefined,
	color: "accent" | "dim" | "success" | "error",
	line: string,
): string {
	return theme ? theme.fg(color, line) : line;
}
