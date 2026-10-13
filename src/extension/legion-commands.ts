import { readFileSync, statSync } from "node:fs";
import { matchesKey, type TuiMouseEvent } from "@earendil-works/pi-tui";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
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
import type { StatusVizSnapshot } from "../tui/status.ts";
import { createLegionViewFactory } from "../tui/viz/view.ts";
import {
	parseSessionMessages,
	type ChatItemSettings,
} from "../tui/chat-items.ts";
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

export const LEGION_COMMAND = "legion";

export interface LegionCommandRuntime {
	activeJobs(): ReadonlyArray<{ name: string; nodeId?: string }>;
	treeNodes(): readonly TreeNodeSnapshot[];
	/** Live visualization data; when present, bare `/legion` opens the galaxy/tok-s/log view. */
	vizSnapshot?(): StatusVizSnapshot;
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

function sessionCursor(
	messages: readonly AgentMessage[],
	fileSize: number,
): LiveOverlayBackfillCursor {
	return {
		turnCount: messages.filter((message) => message.role === "user").length,
		assistantMessageCount: messages.filter((message) => message.role === "assistant").length,
		messageCount: messages.length,
		fileSize,
	};
}

function readSessionSize(sessionFile: string): number | undefined {
	try {
		return statSync(sessionFile).size;
	} catch {
		return undefined;
	}
}

function readSessionBackfill(
	sessionFile: string,
	_maxBackfillTurns: number,
): LiveOverlayBackfillResult | undefined {
	// Take the size before parsing: if the append-only file grows during the
	// parse, the next poll sees that newer size and can safely re-read it.
	const fileSize = readSessionSize(sessionFile);
	if (fileSize === undefined) return undefined;
	try {
		const messages = parseSessionMessages(readFileSync(sessionFile, "utf8"));
		return { messages, cursor: sessionCursor(messages, fileSize) };
	} catch {
		return undefined;
	}
}

function readSessionDelta(
	sessionFile: string,
	cursor: LiveOverlayBackfillCursor,
): LiveOverlayBackfillResult | undefined {
	// The append-only JSONL file is only reparsed after its byte size changes.
	const fileSize = readSessionSize(sessionFile);
	if (fileSize === undefined || fileSize === cursor.fileSize) return undefined;
	let messages: ReturnType<typeof parseSessionMessages>;
	try {
		messages = parseSessionMessages(readFileSync(sessionFile, "utf8"));
	} catch {
		return undefined;
	}
	const nextCursor = sessionCursor(messages, fileSize);
	if (
		nextCursor.messageCount < cursor.messageCount ||
		nextCursor.turnCount < cursor.turnCount ||
		nextCursor.assistantMessageCount < cursor.assistantMessageCount ||
		fileSize < cursor.fileSize
	) {
		// Do not move a monotonic cursor backwards during a concurrent partial write.
		return undefined;
	}
	// Return the full parsed transcript; the viewer compares the message cursor
	// and appends only new entries. This covers assistant appends within a turn.
	return { messages, cursor: nextCursor };
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
		sessionFile: node.sessionFile,
		worktreePath: node.worktreePath,
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
			// Keep session-file backfill alongside RPC deltas; the viewer reconciles overlap.
			if (currentNode?.sessionFile) {
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

function viewerSettings(settings: ReturnType<ExtensionAPI["getSettings"]>): ChatItemSettings {
	return {
		outputPad: settings.outputPad,
		hideThinkingBlock: settings.hideThinkingBlock,
		codeBlockIndent: settings.markdown?.codeBlockIndent,
		showImages: settings.terminal?.showImages,
		imageWidthCells: settings.terminal?.imageWidthCells,
	};
}

function reportOverlayOpenError(
	controller: ReturnType<typeof createLiveOverlay>,
	ui: ExtensionUIContext | undefined,
	error: unknown,
): void {
	try {
		controller.close();
	} catch {
		// Closing is best effort too; never leak a status-open failure to the host.
	}
	try {
		if (ui !== undefined && typeof ui.notify === "function") {
			ui.notify(`Unable to open Legion activity: ${String(error)}`, "error");
		}
	} catch {
		// Some UI contexts cannot display notifications; keep the failure silent.
	}
}

function openLiveOverlay(
	pi: ExtensionAPI,
	ui: ExtensionUIContext,
	cwd: string,
	controller: ReturnType<typeof createLiveOverlay>,
	nodeId: string,
): void {
	const factory = createLiveOverlayFactory(controller, nodeId, {
		cwd,
		settings: viewerSettings(pi.getSettings()),
	});
	void ui.custom(factory, {
		overlay: true,
		overlayOptions: { width: "100%" },
		onHandle: (handle) => controller.getCurrent()?.attachOverlayHandle(handle),
	}).catch((error: unknown) => reportOverlayOpenError(controller, ui, error));
}

export function createStatusNodeOpener(
	pi: ExtensionAPI,
	controller: ReturnType<typeof createLiveOverlay>,
	getUi: () => ExtensionUIContext | undefined,
	getCwd: () => string | undefined,
): (nodeId: string) => void {
	return (nodeId) => {
		let ui: ExtensionUIContext | undefined;
		try {
			if (controller.getCurrent()?.nodeId === nodeId) return;
			ui = getUi();
			const cwd = getCwd();
			if (ui === undefined || cwd === undefined) return;
			openLiveOverlay(pi, ui, cwd, controller, nodeId);
		} catch (error) {
			reportOverlayOpenError(controller, ui, error);
		}
	};
}

export function registerLegionCommand(
	pi: ExtensionAPI,
	deps: LegionCommandDeps,
): ReturnType<typeof createLiveOverlay> {
	const liveOverlay = createLiveOverlay(treeForLiveSource(deps));
	let warnedNonTui = false;

	pi.registerCommand(LEGION_COMMAND, {
		description: "Open the Legion view (galaxy · tok/s · log), /legion --tree for the classic tree, or /legion <name>",
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
			if (ctx.mode !== "tui") {
				if (!warnedNonTui) {
					warnedNonTui = true;
					notify(ctx, "/legion is available only in TUI mode", "warning");
				}
				return;
			}
			let query = args.trim();
			const nodes = deps.runtime.treeNodes();
			const classicTree = query === "--tree";
			if (classicTree) query = "";
			const vizSnapshot = deps.runtime.vizSnapshot?.bind(deps.runtime);
			if (!query && !classicTree && vizSnapshot) {
				await ctx.ui.custom(createLegionViewFactory({
					getData: () => vizSnapshot(),
					onOpenNode: (nodeId) => {
						if (nodes.some((node) => node.id === nodeId) || deps.runtime.treeNodes().some((node) => node.id === nodeId)) {
							openLiveOverlay(pi, ctx.ui, ctx.cwd, liveOverlay, nodeId);
						}
					},
				}));
				return;
			}
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
				openLiveOverlay(pi, ctx.ui, ctx.cwd, liveOverlay, node.id);
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
								if (selectedId) openLiveOverlay(pi, ctx.ui, ctx.cwd, liveOverlay, selectedId);
								return;
							}
							tree.handleInput?.(data);
						},
						handleMouse(event: TuiMouseEvent) {
							const result = tree.handleMouse?.(event);
							if (event.type === "click" && event.button === "left" && result?.handled) {
								const selectedId = tree.getState().selectedId;
								if (selectedId) openLiveOverlay(pi, ctx.ui, ctx.cwd, liveOverlay, selectedId);
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
	return liveOverlay;
}
