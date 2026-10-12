import { statSync } from "node:fs";
import { matchesKey, type TuiMouseEvent } from "@earendil-works/pi-tui";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import {
	createLiveOverlay,
	createLiveOverlayFactory,
	type LiveOverlayBackfillCursor,
	type LiveOverlayBackfillResult,
	type LiveOverlayListener,
	type LiveOverlayNode,
	type LiveOverlaySource,
	type LiveOverlaySubscription,
} from "../tui/live-overlay.ts";
import {
	createTreeViewFactory,
	type TreeNodeSnapshot,
	type TreeViewComponent,
} from "../tui/tree-view.ts";
import {
	type LegionEvent,
	type LegionEventBus,
	LEGION_EVENT_TYPES,
	LEGION_PROCESS_EVENT_TYPES,
} from "./event-bus.ts";
import type {
	EventSubscriptionOptions,
	SupervisorEvent,
} from "../supervisor/types.ts";
import { countAssistantMessages, parseSessionFile } from "../shared/session.ts";
import type { ParsedSession } from "../shared/types.ts";

export const LEGION_COMMAND = "legion";

export interface LegionCommandRuntime {
	activeJobs(): ReadonlyArray<{ name: string; nodeId?: string }>;
	treeNodes(): readonly TreeNodeSnapshot[];
}

export interface RpcEventSource {
	onEvent?: (
		name: string,
		listener: (event: SupervisorEvent) => void,
		options?: EventSubscriptionOptions,
	) => () => void;
}

export function publishUIRequest(
	bus: LegionEventBus,
	nodeId: string,
	method: string,
): void {
	bus.emit({ nodeId, type: "ui_request", data: { method }, ts: Date.now() });
}

export interface LegionCommandDeps {
	bus: LegionEventBus;
	runtime: LegionCommandRuntime;
	supervisor: RpcEventSource;
}

function stringField(value: unknown, key: string): string | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const field = (value as Record<string, unknown>)[key];
	return typeof field === "string" ? field : undefined;
}

/**
 * Forward coarse supervisor facts onto the shared bus. Text is omitted unless a
 * caller explicitly opened a live overlay; even then it is display-only.
 */
export function publishSupervisorEvent(
	bus: LegionEventBus,
	nodeId: string,
	event: SupervisorEvent,
	options: { includeTextDelta?: boolean; textDeltaOnly?: boolean } = {},
): void {
	const timestamp = Date.now();
	const rawType = event.type;
	const updateType = stringField(event, "updateType");
	if (rawType === "message_update") {
		if (updateType === "text_delta") {
			if (!options.includeTextDelta) return;
			const delta = stringField(event, "delta");
			if (delta === undefined) return;
			bus.emit({ nodeId, type: "text_delta", data: { delta }, ts: timestamp });
			return;
		}
		if (options.textDeltaOnly) return;
		const toolName = stringField(event, "toolName");
		if (toolName) {
			bus.emit({ nodeId, type: "tool_call", data: { toolName }, ts: timestamp });
		}
		return;
	}
	if (options.textDeltaOnly) return;
	if (rawType === "agent_start" || rawType === "turn_start") {
		bus.emit({ nodeId, type: "turn_start", data: null, ts: timestamp });
		return;
	}
	if (rawType === "agent_settled") {
		bus.emit({ nodeId, type: "agent_settled", data: null, ts: timestamp });
		return;
	}
	if (rawType === "tool_call" || rawType === "tool_execution_start" || rawType === "tool_execution_end") {
		const toolName = stringField(event, "toolName");
		bus.emit({
			nodeId,
			type: "tool_call",
			data: {
				...(toolName ? { toolName } : {}),
				...(rawType === "tool_call" ? {} : { phase: rawType }),
			},
			ts: timestamp,
		});
	}
}

/** Attach the detail stream only while an overlay is open, as required by D10. */
function subscribeTextDeltas(
	supervisor: RpcEventSource,
	bus: LegionEventBus,
	supervisorName: string,
	nodeId: string,
): { unsubscribe: () => void; subscribed: boolean } {
	const unsubscribe = supervisor.onEvent?.(
		supervisorName,
		(event) => publishSupervisorEvent(bus, nodeId, event, {
			includeTextDelta: true,
			textDeltaOnly: true,
		}),
		{ includeTextDelta: true },
	);
	return {
		unsubscribe: unsubscribe ?? (() => {}),
		subscribed: unsubscribe !== undefined,
	};
}

function nodeLabel(nodeId: string, name: string): string {
	return `${name} (${nodeId})`;
}

function resolveNode(
	nodes: readonly TreeNodeSnapshot[],
	query: string,
): TreeNodeSnapshot | undefined {
	const exact = nodes.find((node) => node.id === query);
	if (exact) return exact;
	const matches = nodes.filter((node) =>
		node.name === query || node.id.slice(node.id.lastIndexOf(".") + 1) === query,
	);
	return matches.length === 1 ? matches[0] : undefined;
}

function sessionActivityLines(
	parsed: ParsedSession,
	options: { startTurnIndex?: number; cursor?: LiveOverlayBackfillCursor } = {},
): string[] {
	const lines: string[] = [];
	const startTurnIndex = options.startTurnIndex ?? 0;
	let assistantMessageIndex = 0;
	for (const [turnIndex, turn] of parsed.turns.entries()) {
		const isNewTurn = options.cursor
			? turnIndex >= options.cursor.turnCount
			: turnIndex >= startTurnIndex;
		if (isNewTurn && turn.userText.length > 0) lines.push(`▸ ${turn.userText}`);
		for (const assistant of turn.assistants) {
			const isNewAssistant = options.cursor
				? assistantMessageIndex >= options.cursor.assistantMessageCount
				: turnIndex >= startTurnIndex;
			if (isNewAssistant) {
				if (assistant.text) lines.push(assistant.text);
				for (const toolName of assistant.tools) lines.push(`⚙ ${toolName}`);
			}
			assistantMessageIndex++;
		}
	}
	return lines;
}

function readSessionSize(sessionFile: string): number | undefined {
	try {
		return statSync(sessionFile).size;
	} catch {
		return undefined;
	}
}

function sessionCursor(parsed: ParsedSession, fileSize: number): LiveOverlayBackfillCursor {
	return {
		turnCount: parsed.turns.length,
		assistantMessageCount: countAssistantMessages(parsed),
		fileSize,
	};
}

function readSessionBackfill(
	sessionFile: string,
	maxBackfillTurns: number,
): LiveOverlayBackfillResult | undefined {
	// Take the size before parsing: if the append-only file grows during the
	// parse, the next poll sees that newer size and can safely re-read it.
	const fileSize = readSessionSize(sessionFile);
	if (fileSize === undefined) return undefined;
	const parsed = parseSessionFile(sessionFile);
	return {
		lines: sessionActivityLines(parsed, {
			startTurnIndex: Math.max(0, parsed.turns.length - maxBackfillTurns),
		}),
		cursor: sessionCursor(parsed, fileSize),
	};
}

function readSessionDelta(
	sessionFile: string,
	cursor: LiveOverlayBackfillCursor,
): LiveOverlayBackfillResult | undefined {
	// The append-only JSONL file is only reparsed after its byte size changes.
	const fileSize = readSessionSize(sessionFile);
	if (fileSize === undefined || fileSize === cursor.fileSize) return undefined;
	const parsed = parseSessionFile(sessionFile);
	const nextAssistantMessageCount = countAssistantMessages(parsed);
	if (
		parsed.turns.length < cursor.turnCount ||
		nextAssistantMessageCount < cursor.assistantMessageCount
	) {
		// Do not move a monotonic cursor backwards if a concurrent partial write is unreadable.
		return undefined;
	}
	// Parsed turn/message counts are stable positions in the append-only JSONL:
	// render only turns/messages at or beyond them, so each appended record is emitted once.
	return {
		lines: sessionActivityLines(parsed, { cursor }),
		cursor: sessionCursor(parsed, fileSize),
	};
}

function liveNode(
	node: TreeNodeSnapshot,
): LiveOverlayNode {
	return {
		id: node.id,
		name: node.name,
		role: node.role,
		model: node.model,
		status: node.status,
		createdAt: node.createdAt,
		updatedAt: node.updatedAt,
		...(node.turn === undefined ? {} : { turn: node.turn }),
		...(node.turns === undefined ? {} : { turns: node.turns }),
	};
}

function treeForLiveSource(
	deps: LegionCommandDeps,
): LiveOverlaySource {
	const nodes = new Map<string, TreeNodeSnapshot>();
	const processEventTypes = new Set<LegionEvent["type"]>(LEGION_PROCESS_EVENT_TYPES);
	const refresh = (): void => {
		for (const node of deps.runtime.treeNodes()) nodes.set(node.id, { ...node });
	};
	refresh();
	const supervisorName = (nodeId: string, node?: TreeNodeSnapshot): string => {
		const active = deps.runtime.activeJobs().find((job) =>
			job.nodeId === nodeId || (node !== undefined && job.name === node.name),
		);
		return active?.name ?? node?.name ?? nodeId;
	};

	return {
		backfill(nodeId, maxBackfillTurns) {
			refresh();
			const sessionFile = nodes.get(nodeId)?.sessionFile;
			return sessionFile ? readSessionBackfill(sessionFile, maxBackfillTurns) : undefined;
		},
		subscribe(nodeId: string, listener: LiveOverlayListener): LiveOverlaySubscription {
			refresh();
			const currentNode = nodes.get(nodeId);
			const activeJob = deps.runtime.activeJobs().find((job) =>
				job.nodeId === nodeId || (job.nodeId === undefined && currentNode !== undefined && job.name === currentNode.name),
			);
			const textDeltaFeed = activeJob
				? subscribeTextDeltas(
					deps.supervisor,
					deps.bus,
					supervisorName(nodeId, currentNode),
					nodeId,
				)
				: { unsubscribe: () => {}, subscribed: false };
			const busUnsubscribers = LEGION_EVENT_TYPES.map((type) =>
				deps.bus.on(type, (event) => {
					if (event.nodeId !== nodeId) return;
					if (event.id === undefined && !processEventTypes.has(event.type)) return;
					refresh();
					listener({
						...(event.id === undefined ? {} : { id: event.id }),
						domain: event.id === undefined ? "process" : "stored",
						type: event.type,
						nodeId: event.nodeId,
						ts: event.ts,
						data: event.data,
					});
				}),
			);
			let active = true;
			const subscription = (() => {
				if (!active) return;
				active = false;
				textDeltaFeed.unsubscribe();
				for (const unsubscribe of busUnsubscribers) unsubscribe();
			}) as LiveOverlaySubscription;
			// The RPC feed is authoritative for an active job; its subscription and
			// session-file polling are mutually exclusive to prevent double output.
			if (!textDeltaFeed.subscribed && currentNode?.sessionFile) {
				subscription.pollBackfill = (cursor) => readSessionDelta(currentNode.sessionFile!, cursor);
			}
			return subscription;
		},
		unsubscribe(subscription) {
			subscription();
		},
		getNode(nodeId) {
			return nodes.has(nodeId) ? liveNode(nodes.get(nodeId)!) : undefined;
		},
	};
}

function notify(ctx: ExtensionCommandContext, message: string, level: "info" | "warning" | "error" = "info"): void {
	ctx.ui.notify(message, level);
}

function openLiveOverlay(
	ctx: ExtensionCommandContext,
	controller: ReturnType<typeof createLiveOverlay>,
	nodeId: string,
): void {
	const factory = createLiveOverlayFactory(controller, nodeId);
	void ctx.ui.custom(factory, {
		overlay: true,
		onHandle: (handle) => controller.getCurrent()?.attachOverlayHandle(handle),
	}).catch((error: unknown) => {
		controller.close();
		notify(ctx, `Unable to open Legion activity: ${String(error)}`, "error");
	});
}

export function registerLegionCommand(
	pi: ExtensionAPI,
	deps: LegionCommandDeps,
): void {
	const liveOverlay = createLiveOverlay(treeForLiveSource(deps));

	pi.registerCommand(LEGION_COMMAND, {
		description: "Open the Legion tree, or inspect one node with /legion <name>",
		getArgumentCompletions(prefix) {
			if (prefix.includes(" ")) return null;
			const nodes = deps.runtime.treeNodes();
			return nodes
				.filter((node) => node.name.startsWith(prefix) || node.id.startsWith(prefix))
				.map((node) => ({
					value: nodes.filter((candidate) => candidate.name === node.name).length > 1
						? node.id
						: node.name,
					label: nodeLabel(node.id, node.name),
				}));
		},
		async handler(args, ctx) {
			if (!ctx.hasUI) {
				notify(ctx, "/legion requires an interactive UI", "warning");
				return;
			}
			const query = args.trim();
			const nodes = deps.runtime.treeNodes();
			if (query) {
				const node = resolveNode(nodes, query);
				if (!node) {
					const ambiguous = nodes.filter((entry) =>
						entry.name === query || entry.id.slice(entry.id.lastIndexOf(".") + 1) === query,
					).length > 1;
					notify(
						ctx,
						ambiguous
							? `"${query}" is ambiguous; use a full node id with /legion <node-id>.`
							: `Unknown Legion node "${query}".`,
						"error",
					);
					return;
				}
				openLiveOverlay(ctx, liveOverlay, node.id);
				return;
			}

			let component: TreeViewComponent | undefined;
			const unsubscribe = LEGION_EVENT_TYPES
				.filter((type) => type !== "text_delta")
				.map((type) => deps.bus.on(type, (event: LegionEvent) => {
					if (!component) return;
					const nextNodes = deps.runtime.treeNodes();
					const node = nextNodes.find((entry) => entry.id === event.nodeId);
					const retirementOnly = event.type === "node_retired" &&
						(node?.status === "settled" || node?.status === "failed");
					component.updateSnapshot(nextNodes, retirementOnly ? [] : [event]);
				}));
			const baseFactory = createTreeViewFactory({ nodes });
			try {
				await ctx.ui.custom((tui, theme, keybindings, done) => {
					const tree = baseFactory(tui, theme, keybindings, done);
					component = tree;
					return {
						...tree,
						handleInput(data) {
							if (!tree.getState().searchMode && matchesKey(data, "o")) {
								const selectedId = tree.getState().selectedId;
								if (selectedId) openLiveOverlay(ctx, liveOverlay, selectedId);
								return;
							}
							tree.handleInput?.(data);
						},
						handleMouse(event: TuiMouseEvent) {
							const result = tree.handleMouse?.(event);
							if (event.type === "click" && event.button === "left" && result?.handled) {
								const selectedId = tree.getState().selectedId;
								if (selectedId) openLiveOverlay(ctx, liveOverlay, selectedId);
							}
							return result;
						},
						dispose() {
							tree.dispose();
							component = undefined;
						},
					};
				});
			} finally {
				component?.dispose();
				component = undefined;
				for (const stop of unsubscribe) stop();
			}
		},
	});
}
