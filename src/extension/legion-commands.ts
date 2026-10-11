import { matchesKey, type TuiMouseEvent } from "@earendil-works/pi-tui";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import {
	createLiveOverlay,
	createLiveOverlayFactory,
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
import { osc8NodeLink } from "../tui/status.ts";
import {
	type LegionEvent,
	type LegionEventBus,
	LEGION_EVENT_TYPES,
} from "./event-bus.ts";
import type {
	EventSubscriptionOptions,
	LegionSupervisor,
	SupervisorEvent,
} from "../supervisor/types.ts";

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

export interface LegionSupervisorEventAdapter extends RpcEventSource, LegionSupervisor {
	/** Optional bridge for M2 ChildRecord.nodeId once orchestration returns it. */
	setNodeId(name: string, nodeId: string): void;
}

export function createLegionSupervisorEventAdapter(
	supervisor: LegionSupervisor & RpcEventSource,
	bus: LegionEventBus,
	nodeIdForName: (name: string) => string | undefined,
): LegionSupervisorEventAdapter {
	const nodeIds = new Map<string, string>();
	const pendingLifecycle = new Map<string, Array<Extract<
		LegionEvent["type"],
		"node_launched" | "node_steered" | "node_retired" | "node_aborted"
	>>>();
	const resolveNodeId = (name: string): string | undefined => nodeIds.get(name) ?? nodeIdForName(name);
	const emitLifecycle = (
		name: string,
		type: Extract<
			LegionEvent["type"],
			"node_launched" | "node_steered" | "node_retired" | "node_aborted"
		>,
	): void => {
		const nodeId = resolveNodeId(name);
		if (!nodeId) {
			const pending = pendingLifecycle.get(name) ?? [];
			pending.push(type);
			pendingLifecycle.set(name, pending);
			return;
		}
		bus.emit({ nodeId, type, data: null, ts: Date.now() });
	};
	return {
		setNodeId(name, nodeId) {
			nodeIds.set(name, nodeId);
			for (const type of pendingLifecycle.get(name) ?? []) {
				bus.emit({ nodeId, type, data: null, ts: Date.now() });
			}
			pendingLifecycle.delete(name);
		},
		async spawnChild(input) {
			const handle = await supervisor.spawnChild(input);
			emitLifecycle(handle.name, "node_launched");
			return handle;
		},
		prompt: (name, text) => supervisor.prompt(name, text),
		async steer(name, text) {
			await supervisor.steer(name, text);
			emitLifecycle(name, "node_steered");
		},
		followUp: (name, text) => supervisor.followUp(name, text),
		async abort(name) {
			await supervisor.abort(name);
			emitLifecycle(name, "node_aborted");
		},
		waitSettled: (name, timeoutMs) => supervisor.waitSettled(name, timeoutMs),
		isAlive: (name) => supervisor.isAlive(name),
		stats: (name) => supervisor.stats(name),
		async retire(name, options) {
			await supervisor.retire(name, options);
			emitLifecycle(name, "node_retired");
		},
		...(supervisor.onEvent
			? {
				onEvent: (name: string, listener: (event: SupervisorEvent) => void, options?: EventSubscriptionOptions) =>
					supervisor.onEvent!(name, listener, options),
			}
			: {}),
	};
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
): () => void {
	const unsubscribe = supervisor.onEvent?.(
		supervisorName,
		(event) => publishSupervisorEvent(bus, nodeId, event, {
			includeTextDelta: true,
			textDeltaOnly: true,
		}),
		{ includeTextDelta: true },
	);
	return unsubscribe ?? (() => {});
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
		subscribe(nodeId: string, listener: LiveOverlayListener): LiveOverlaySubscription {
			refresh();
			const currentNode = nodes.get(nodeId);
			const activeJob = deps.runtime.activeJobs().find((job) =>
				job.nodeId === nodeId || (job.nodeId === undefined && currentNode !== undefined && job.name === currentNode.name),
			);
			const rpcUnsubscribe = activeJob
				? subscribeTextDeltas(
					deps.supervisor,
					deps.bus,
					supervisorName(nodeId, currentNode),
					nodeId,
				)
				: () => {};
			const busUnsubscribers = LEGION_EVENT_TYPES.map((type) =>
				deps.bus.on(type, (event) => {
					if (event.nodeId !== nodeId) return;
					refresh();
					listener({
						type: event.type,
						nodeId: event.nodeId,
						ts: event.ts,
						data: event.data,
					});
				}),
			);
			let active = true;
			return (() => {
				if (!active) return;
				active = false;
				rpcUnsubscribe();
				for (const unsubscribe of busUnsubscribers) unsubscribe();
			}) as LiveOverlaySubscription;
		},
		unsubscribe(subscription) {
			subscription();
		},
		getNode(nodeId) {
			return nodes.has(nodeId) ? liveNode(nodes.get(nodeId)!) : undefined;
		},
	};
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function withOsc8Links(
	component: TreeViewComponent,
	nodes: readonly TreeNodeSnapshot[],
): TreeViewComponent {
	let byId = new Map(nodes.map((node) => [node.id, node]));
	return {
		...component,
		updateSnapshot(nextNodes, events) {
			byId = new Map(nextNodes.map((node) => [node.id, node]));
			component.updateSnapshot(nextNodes, events);
		},
		render(width) {
			return component.render(width).map((line) => {
				for (const id of component.getState().visibleIds) {
					const node = byId.get(id);
					if (!node) continue;
					const pattern = new RegExp(`(● |▸ )(${escapeRegExp(node.name)})(?=\\s|\\+|$)`);
					if (pattern.test(line)) {
						return line.replace(pattern, (_match, marker: string, name: string) =>
							`${marker}${osc8NodeLink(node.id, name)}`,
						);
					}
				}
				return line;
			});
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
					const wrapped = withOsc8Links(tree, nodes);
					return {
						...wrapped,
						handleInput(data) {
							if (!tree.getState().searchMode && matchesKey(data, "o")) {
								const selectedId = tree.getState().selectedId;
								if (selectedId) openLiveOverlay(ctx, liveOverlay, selectedId);
								return;
							}
							wrapped.handleInput?.(data);
						},
						handleMouse(event: TuiMouseEvent) {
							const result = wrapped.handleMouse?.(event);
							if (event.type === "click" && event.button === "left" && result?.handled) {
								const selectedId = tree.getState().selectedId;
								if (selectedId) openLiveOverlay(ctx, liveOverlay, selectedId);
							}
							return result;
						},
						dispose() {
							wrapped.dispose();
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
