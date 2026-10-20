import { readFileSync, statSync } from "node:fs";
import * as path from "node:path";
import { matchesKey, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { resolveStopTarget, runLegionStop, stopCompletions, type StopDeps } from "./legion-stop.ts";
import {
	DOCTOR_SECTIONS,
	LEGION_SLASH_HELP_LINES,
	expectedModelsFromSettings,
	parseDoctorSections,
	runLegionDoctor,
	type DoctorRuntimeSnapshot,
} from "./legion-doctor.ts";
import {
	renderLegionStatus,
	type LegionChildStatusFacts,
} from "./legion-status.ts";
import { ALLOW_NESTED_ENV } from "./budget.ts";
import {
	createAgentsCommand,
	createTeamCommand,
	createToggleCommand,
	sendSlashText,
	type LegionSubcommand,
	type AgentsCommandDeps,
	type TeamCommandDeps,
	type ToggleCommandDeps,
} from "./slash.ts";
import { createSummaryCommand } from "./summary.ts";
import { createTimingCommand } from "./timing.ts";
import { getAgentDir } from "../agents/paths.ts";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	createLiveOverlay,
	createLiveOverlayFactory,
	resolveModalOverlayOptions,
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
	type ChatItemSettings,
} from "../tui/chat-items.ts";
import { readSessionMessagesFile } from "../tui/session-messages-file.ts";
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
	activeJobs(): ReadonlyArray<{ name: string; nodeId?: string; state: string }>;
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
	/** Graceful retire via the subagent `stop` action (see legion-stop.ts). */
	stop?: (params: { name?: string; all?: boolean }) => Promise<{ ok: boolean; text: string }>;
	/**
	 * Persisted child snapshot used by `subagent({ action: "status" })`.
	 * Undefined when this process has no run-store record for `name`.
	 */
	childStatus?: (name: string, cwd: string) => LegionChildStatusFacts | undefined;
	/** Existing user-facing subcommand handlers; absent only in isolated tests. */
	commands?: {
		team: TeamCommandDeps;
		agents: AgentsCommandDeps;
		toggle: ToggleCommandDeps;
	};
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

/** Completions for `/legion status <prefix>`: tree nodes, then live jobs the tree does not already name. */
function statusArgumentCompletions(
	prefix: string,
	deps: LegionCommandDeps,
): Array<{ value: string; label: string }> {
	const nodes = deps.runtime.treeNodes();
	const out: Array<{ value: string; label: string }> = [];
	const seen = new Set<string>();
	const add = (value: string, label: string): void => {
		if (!value.startsWith(prefix) || seen.has(value)) return;
		seen.add(value);
		out.push({ value: `status ${value}`, label });
	};
	for (const node of nodes) {
		const value = nodes.filter((candidate) => candidate.name === node.name).length > 1
			? node.id
			: node.name;
		add(value, nodeLabel(node.id, node.name));
	}
	for (const job of deps.runtime.activeJobs()) {
		if (job.state === "retired") continue;
		add(job.name, `${job.name} (live)`);
	}
	return out;
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
	// Incremental reader (#234): cold cache reads from byte 0 once; later polls
	// seek past the fingerprint offset. Take size via the reader so a concurrent
	// append is visible on the next tick.
	try {
		const loaded = readSessionMessagesFile(sessionFile);
		if (!loaded) return undefined;
		return { messages: loaded.messages, cursor: sessionCursor(loaded.messages, loaded.fileSize) };
	} catch {
		return undefined;
	}
}

function readSessionDelta(
	sessionFile: string,
	cursor: LiveOverlayBackfillCursor,
): LiveOverlayBackfillResult | undefined {
	// Size gate first: unchanged append-only file ⇒ no open/parse (#234).
	const fileSize = readSessionSize(sessionFile);
	if (fileSize === undefined || fileSize === cursor.fileSize) return undefined;
	let loaded: ReturnType<typeof readSessionMessagesFile>;
	try {
		loaded = readSessionMessagesFile(sessionFile);
	} catch {
		return undefined;
	}
	if (!loaded) return undefined;
	const messages = loaded.messages;
	const nextCursor = sessionCursor(messages, loaded.fileSize);
	if (
		nextCursor.messageCount < cursor.messageCount ||
		nextCursor.turnCount < cursor.turnCount ||
		nextCursor.assistantMessageCount < cursor.assistantMessageCount ||
		loaded.fileSize < cursor.fileSize
	) {
		// Do not move a monotonic cursor backwards during a concurrent partial write.
		return undefined;
	}
	// Return the accumulated transcript; the viewer slices by message cursor.
	// Hot path only parsed bytes past the shared session.ts fingerprint offset.
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
		parentId: node.parentId,
		depth: node.depth,
		...(node.turn === undefined ? {} : { turn: node.turn }),
		...(node.turns === undefined ? {} : { turns: node.turns }),
		sessionFile: node.sessionFile,
		worktreePath: node.worktreePath,
		// #209/D5: absent for legacy nodes; the footer omits the segment entirely.
		...(node.spawnMode === undefined ? {} : { spawnMode: node.spawnMode }),
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
	onStop?: (nodeId: string) => void,
): void {
	// #193: the overlay must cover the floating frame only. A full-screen overlay
	// would make pi-tui discard every host cell (its composite has no transparency
	// option), so the area around the frame collapsed to the terminal's default
	// background — the "black modal". Anchoring to the frame rect leaves the rest of
	// the screen to the host, which paints the chat / /legion view there.
	const factory = createLiveOverlayFactory(controller, nodeId, {
		...(onStop ? { onStop } : {}),
		cwd,
		settings: viewerSettings(pi.getSettings()),
	});
	void ui.custom(factory, {
		overlay: true,
		// Percentages (not absolute cells) so pi-tui re-derives the rect from the
		// current terminal every frame; the frame survives resize.
		overlayOptions: resolveModalOverlayOptions(),
		onHandle: (handle) => controller.getCurrent()?.attachOverlayHandle(handle),
	}).catch((error: unknown) => reportOverlayOpenError(controller, ui, error));
}

export function createStatusNodeOpener(
	pi: ExtensionAPI,
	controller: ReturnType<typeof createLiveOverlay>,
	getUi: () => ExtensionUIContext | undefined,
	getCwd: () => string | undefined,
	onStop?: (ui: ExtensionUIContext, nodeId: string) => void,
): (nodeId: string) => void {
	return (nodeId) => {
		let ui: ExtensionUIContext | undefined;
		try {
			if (controller.getCurrent()?.nodeId === nodeId) return;
			ui = getUi();
			const cwd = getCwd();
			if (ui === undefined || cwd === undefined) return;
			const host = ui;
			openLiveOverlay(pi, ui, cwd, controller, nodeId, onStop ? (id) => onStop(host, id) : undefined);
		} catch (error) {
			reportOverlayOpenError(controller, ui, error);
		}
	};
}

/**
 * Stop the agent behind `nodeId` (nested agents get an "owned by" notice).
 * The /legion view and live overlay confirm in-place (y/N), so `confirm`
 * defaults to false; pass true to ask via a pi dialog instead.
 */
export async function confirmAndStopNode(ui: ExtensionUIContext, deps: Pick<LegionCommandDeps, "runtime" | "stop">, nodeId: string, confirm = false): Promise<void> {
	if (!deps.stop) return;
	const target = resolveStopTarget(nodeId, deps.runtime.activeJobs(), deps.runtime.treeNodes());
	if (confirm && target.kind === "job" && !(await ui.confirm("Stop subagent", `Stop ${target.name}? Its own subagents are retired with it.`))) return;
	const stop = deps.stop;
	await runLegionStop(nodeId, {
		jobs: () => deps.runtime.activeJobs(),
		nodes: () => deps.runtime.treeNodes(),
		stop: (params) => stop(params),
		notify: (message, type) => ui.notify(message, type),
	});
}


function buildDoctorReport(
	deps: LegionCommandDeps,
	ctxCwd: string,
	sectionArg?: string,
) {
	const agentDir = getAgentDir();
	let settings: unknown;
	try {
		settings = JSON.parse(readFileSync(path.join(agentDir, "settings.json"), "utf8"));
	} catch {
		settings = undefined;
	}
	let sections;
	try {
		sections = parseDoctorSections(sectionArg);
	} catch (error) {
		return {
			ok: false,
			text: error instanceof Error ? error.message : String(error),
			issues: [{ severity: "error" as const, code: "BAD_SECTION", message: String(error) }],
			sections: [] as const,
			hostModelCount: 0,
			childModelCount: 0,
			packages: [],
		};
	}
	const runtime: DoctorRuntimeSnapshot = {
		liveJobs: deps.runtime.activeJobs().map((job) => ({
			name: job.name,
			state: job.state,
			nodeId: job.nodeId,
		})),
		treeNodes: deps.runtime.treeNodes().map((node) => ({
			id: node.id,
			name: node.name,
			status: node.status,
			phase: "phase" in node && typeof (node as { phase?: unknown }).phase === "string"
				? (node as { phase: string }).phase
				: undefined,
		})),
		stopAvailable: Boolean(deps.stop),
		idleEscWired: false,
		legionTools: ["subagent", "vexillatio"],
		allowNestedEnv: process.env[ALLOW_NESTED_ENV] === "1",
	};
	return runLegionDoctor({
		agentDir,
		cwd: ctxCwd,
		storeRoot: path.join(ctxCwd, ".pi-subagents"),
		expectedModels: expectedModelsFromSettings(settings),
		runtime,
		sections,
	});
}

export function registerLegionCommand(
	pi: ExtensionAPI,
	deps: LegionCommandDeps,
): ReturnType<typeof createLiveOverlay> {
	const liveOverlay = createLiveOverlay(treeForLiveSource(deps));
	let warnedNonTui = false;
	const stopDeps = (ctx: { ui: ExtensionUIContext }): StopDeps => ({
		jobs: () => deps.runtime.activeJobs(),
		nodes: () => deps.runtime.treeNodes(),
		stop: (params) => deps.stop!(params),
		notify: (message, type) => ctx.ui.notify(message, type),
	});
	const confirmStopNode = (ctx: { ui: ExtensionUIContext }, nodeId: string): Promise<void> => confirmAndStopNode(ctx.ui, deps, nodeId);
	const overlayStop = (ui: ExtensionUIContext) => deps.stop ? (id: string) => void confirmAndStopNode(ui, deps, id) : undefined;

	const subcommands: Record<string, LegionSubcommand> = {
		...(deps.commands
			? {
					team: createTeamCommand(pi, deps.commands.team),
					agents: createAgentsCommand(pi, deps.commands.agents),
					on: createToggleCommand(pi, deps.commands.toggle),
					off: createToggleCommand(pi, deps.commands.toggle),
				}
			: {}),
		summary: createSummaryCommand(pi),
		timing: createTimingCommand(pi),
	};
	const helpText = [
		"Legion commands:",
		...LEGION_SLASH_HELP_LINES.map((line) => `  ${line}`),
	].join("\n");
	pi.registerCommand(LEGION_COMMAND, {
		description: "Open the Legion view or manage teams, agents, subagent runs, and settings",
		getArgumentCompletions(prefix) {
			const trimmed = prefix.trimStart();
			if (/^(team|agents|on|off|summary|timing)\s/i.test(trimmed)) {
				const key = trimmed.split(/\s+/, 1)[0]?.toLowerCase() ?? "";
				if (key === "on" || key === "off") return null;
				const command = subcommands[key];
				const completions = command?.getArgumentCompletions?.(trimmed.replace(/^\S+\s*/, ""));
				return completions?.map((item) => ({
					value: `${key} ${item.value}`,
					label: item.label,
				})) ?? null;
			}
			if (deps.stop && /^stop\s/.test(prefix)) {
				const rest = prefix.replace(/^stop\s+/, "");
				return stopCompletions(rest, deps.runtime.activeJobs(), deps.runtime.treeNodes())
					.map((item) => ({ value: `stop ${item.value}`, label: item.label }));
			}
			if (/^status\s/i.test(trimmed)) {
				return statusArgumentCompletions(trimmed.replace(/^status\s+/i, ""), deps);
			}
			if (/^doctor(\s|$)/i.test(prefix)) {
				const rest = prefix.replace(/^doctor\s*/i, "");
				return DOCTOR_SECTIONS
					.filter((section) => section.startsWith(rest))
					.map((section) => ({ value: `doctor ${section}`, label: `doctor ${section}` }));
			}
			if (prefix.includes(" ")) return null;
			const nodes = deps.runtime.treeNodes();
			const verbs: { value: string; label: string }[] = [];
			if (!prefix.includes(" ")) {
				for (const command of ["team", "agents", "on", "off", "summary", "timing", "help"]) {
					if (command.startsWith(prefix)) {
						verbs.push({ value: command, label: command });
					}
				}
			}
			if ("status".startsWith(prefix)) {
				verbs.push({
					value: "status",
					label: "status [name] — tree summary, or one node (same text as subagent status)",
				});
			}
			if ("doctor".startsWith(prefix)) {
				verbs.push({ value: "doctor", label: "doctor [section] — full self-check (extensions/models/spawn/memory/tools/storage/runtime)" });
			}
			if (deps.stop && "stop".startsWith(prefix)) {
				verbs.push({ value: "stop", label: "stop [name] — stop one live subagent, or all" });
			}
			return [...verbs, ...nodes
				.filter((node) => node.name.startsWith(prefix) || node.id.startsWith(prefix))
				.map((node) => ({
					value: nodes.filter((candidate) => candidate.name === node.name).length > 1
						? node.id
						: node.name,
					label: nodeLabel(node.id, node.name),
				}))];
		},
		async handler(args, ctx) {
			let query = args.trim();
			const [keyword = "", ...rest] = query.split(/\s+/);
			const normalizedKeyword = keyword.toLowerCase();
			const subcommand = subcommands[normalizedKeyword];
			if (subcommand) {
				const subArgs = normalizedKeyword === "on" || normalizedKeyword === "off"
					? rest.length === 0 ? normalizedKeyword : [normalizedKeyword, ...rest].join(" ")
					: rest.join(" ");
				await subcommand.handler(subArgs, ctx);
				return;
			}
			if (normalizedKeyword === "help") {
				sendSlashText(pi, helpText);
				return;
			}
			if (normalizedKeyword === "status") {
				const report = renderLegionStatus({
					query: rest.join(" "),
					nodes: deps.runtime.treeNodes(),
					jobs: deps.runtime.activeJobs(),
					lookupChild: deps.childStatus
						? (name) => deps.childStatus!(name, ctx.cwd)
						: undefined,
					now: Date.now(),
				});
				if (!report.ok) {
					notify(ctx, report.text, "error");
					return;
				}
				sendSlashText(pi, report.text);
				return;
			}
			if (/^doctor(?:\s|$)/i.test(query)) {
				const sectionArg = query.replace(/^doctor\s*/i, "").trim();
				const report = buildDoctorReport(deps, ctx.cwd, sectionArg || undefined);
				pi.sendMessage({
					customType: "legion-doctor",
					content: report.text,
					display: true,
				});
				notify(
					ctx,
					report.ok
						? "Legion doctor: OK (full report above)"
						: `Legion doctor: ${report.issues.filter((i) => i.severity === "error").length} error(s) — see report`,
					report.ok ? "info" : "warning",
				);
				return;
			}
			if (ctx.mode !== "tui") {
				if (!warnedNonTui) {
					warnedNonTui = true;
					notify(ctx, "/legion is available only in TUI mode (except /legion doctor)", "warning");
				}
				return;
			}
			const stopMatch = deps.stop ? /^stop(?:\s+(.*))?$/.exec(query) : null;
			if (stopMatch && deps.stop) {
				await runLegionStop(stopMatch[1] ?? "", stopDeps(ctx));
				return;
			}
			const nodes = deps.runtime.treeNodes();
			const classicTree = query === "--tree";
			if (classicTree) query = "";
			const vizSnapshot = deps.runtime.vizSnapshot?.bind(deps.runtime);
			if (!query && !classicTree && vizSnapshot) {
				await ctx.ui.custom(createLegionViewFactory({
					getData: () => vizSnapshot(),
					onStopNode: deps.stop ? (nodeId) => void confirmStopNode(ctx, nodeId) : undefined,
					onOpenNode: (nodeId) => {
						if (nodes.some((node) => node.id === nodeId) || deps.runtime.treeNodes().some((node) => node.id === nodeId)) {
							openLiveOverlay(pi, ctx.ui, ctx.cwd, liveOverlay, nodeId, overlayStop(ctx.ui));
						}
					},
				}), {
					overlay: true,
					overlayOptions: { width: "100%", maxHeight: "100%", anchor: "top-left", row: 0, col: 0 },
				});
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
				openLiveOverlay(pi, ctx.ui, ctx.cwd, liveOverlay, node.id, overlayStop(ctx.ui));
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
								if (selectedId) openLiveOverlay(pi, ctx.ui, ctx.cwd, liveOverlay, selectedId, overlayStop(ctx.ui));
								return;
							}
							tree.handleInput?.(data);
						},
						handleMouse(event: TuiMouseEvent) {
							const result = tree.handleMouse?.(event);
							if (event.type === "click" && event.button === "left" && result?.handled) {
								const selectedId = tree.getState().selectedId;
								if (selectedId) openLiveOverlay(pi, ctx.ui, ctx.cwd, liveOverlay, selectedId, overlayStop(ctx.ui));
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
