import {
	decodeKittyPrintable,
	Key,
	matchesKey,
	stripTerminalSequences,
	truncateToWidth,
	visibleWidth,
	type Component,
	type TuiMouseEvent,
	type TUI,
} from "@earendil-works/pi-tui";
import type { LegionEvent } from "../extension/event-bus.ts";
import type { LegionNode } from "../legion/nodes.ts";
import { NODE_STATUSES } from "../legion/nodes.ts";
import { isTerminalState } from "../extension/liveness.ts";
import type { SpawnMode } from "../shared/types.ts";
import { osc8NodeLink } from "./status.ts";

const TREE_HEADER = "Legion tree · j/k move · enter toggle · / search · pgup/pgdn scroll · esc/q close";
const DEFAULT_TERMINAL_ROWS = 24;
const MAX_ACTIVITY_TOOLS = 2;
/**
 * Active/terminal partition, derived from the liveness authority instead of
 * hand-written here (contract `docs/contracts/display-liveness-v1.md` D1-a,
 * D6 exit 4).
 *
 * The gain is anti-drift rather than a bug fix: `node.status` is `NodeStatus`,
 * the six-value ledger set, and for those six the old local pair happened to
 * agree with `isTerminalState`. But it was a fourth independent copy of the
 * vocabulary, so the next ledger status would be terminal in the panel and
 * non-terminal here — exactly the divergence D6 forbids.
 *
 * `idle`/`queued` are display states that cannot appear here (D9 keeps them out
 * of `NODE_STATUSES`). They are unioned into the active side anyway so the two
 * sets stay a partition of anything a snapshot row might carry: calling a
 * pending row terminal would fold its subtree and freeze its clock for work
 * that has not started.
 */
const ACTIVE_STATUSES: ReadonlySet<string> = new Set<string>([
	...NODE_STATUSES.filter((status) => !isTerminalState(status)),
	"idle",
	"queued",
]);
const TERMINAL_STATUSES: ReadonlySet<string> = new Set<string>(
	NODE_STATUSES.filter((status) => isTerminalState(status)),
);

import type { PhaseMachine } from "../legion/phase-machine.ts";

export interface TreeNodeSnapshot extends LegionNode {
	/** Snapshot from legion.db usage table (≤30s granularity). */
	tokensTotal?: number;
	/** Output tokens from the usage ledger (for tok/s when session is unavailable). */
	tokensOut?: number;
	turn?: number;
	turns?: number;
	tools?: readonly string[];
	lastTools?: readonly string[];
	/** Unix ms start of the current turn, when known (bus events or snapshots). */
	turnStartedAt?: number;
	/**
	 * Arbitrated backend for this child (#209), merged from the tracked job at
	 * snapshot time — `legion.db` has no spawn_mode column. Absent for legacy
	 * records and for nodes never launched in this session; readers must render
	 * that as unknown, never as `rpc`.
	 */
	spawnMode?: SpawnMode;
	/**
	 * #298: the phase machine this node runs under, when known.
	 *
	 * Only the team root's card declares one, so children inherit their ancestor's.
	 * Absent means the built-in four-phase pipeline — renderers should show that
	 * default rather than nothing, because "no machine" and "the default machine"
	 * are the same thing to the runtime.
	 */
	phaseMachine?: PhaseMachine;
}

export interface TreeViewTheme {
	fg(color: "accent" | "dim", text: string): string;
}

export interface TreeViewOptions {
	nodes: readonly TreeNodeSnapshot[];
	events?: readonly LegionEvent[];
	now?: () => number;
	theme?: TreeViewTheme;
	requestRender?: () => void;
	/** Maximum component height. Production custom UI supplies `tui.terminal.rows`. */
	terminalRows?: number | (() => number);
}

export interface TreeViewState {
	selectedId: string | undefined;
	expandedIds: readonly string[];
	visibleIds: readonly string[];
	searchMode: boolean;
	searchQuery: string;
	/** First body line in the current page. The fixed title/search lines are excluded. */
	scrollTop: number;
	/** Number of tree body lines available below the fixed title/search lines. */
	pageSize: number;
	maxScrollTop: number;
}

/** Component returned by the custom-UI factory; it has no context or DB dependency. */
export interface TreeViewComponent extends Component {
	updateSnapshot(nodes: readonly TreeNodeSnapshot[], events?: readonly LegionEvent[]): void;
	applyEvent(event: LegionEvent): void;
	getState(): TreeViewState;
	isExpanded(nodeId: string): boolean;
	dispose(): void;
}

export type TreeViewDone = (result?: undefined) => void;

/**
 * Construct the /legion tree custom component. Pass this component from a
 * `ctx.ui.custom()` factory. It paginates its own line window because custom UI
 * components are layout leaves and do not receive an allocated viewport height.
 */
export function createTreeView(
	options: TreeViewOptions,
	done: TreeViewDone = () => {},
): TreeViewComponent {
	const now = options.now ?? (() => Date.now());
	const theme = options.theme;
	const requestRender = options.requestRender ?? (() => {});
	const readTerminalRows: () => number = () =>
		typeof options.terminalRows === "function"
			? options.terminalRows()
			: options.terminalRows ?? DEFAULT_TERMINAL_ROWS;
	function currentTerminalRows(): number {
		const value = readTerminalRows();
		if (!Number.isSafeInteger(value) || value < 1) {
			throw new TypeError("terminalRows must be a positive safe integer");
		}
		return value;
	}
	currentTerminalRows();

	const nodes = new Map<string, TreeNodeSnapshot>();
	const children = new Map<string, string[]>();
	const activity = new Map<string, TreeActivity>();
	const expanded = new Set<string>();
	const manualExpansion = new Map<string, boolean>();
	const rowOffsets = new Map<string, number>();
	let selectedId: string | undefined;
	let searchMode = false;
	let searchQuery = "";
	let searchMatchIndex = -1;
	let closed = false;
	let rowLines: string[] = [];
	let contentWidth = 80;
	let headerLineCount = 1;
	let scrollTop = 0;

	function sortedChildren(parentId: string): string[] {
		return [...(children.get(parentId) ?? [])];
	}

	function rootIds(): string[] {
		return [...nodes.values()]
			.filter((node) => node.parentId === null)
			.sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))
			.map((node) => node.id);
	}

	function allNodeIds(): string[] {
		const result: string[] = [];
		const visited = new Set<string>();
		const visit = (id: string): void => {
			if (visited.has(id)) return;
			visited.add(id);
			result.push(id);
			for (const childId of sortedChildren(id)) visit(childId);
		};
		for (const id of rootIds()) visit(id);
		// Include malformed/orphaned snapshots deterministically rather than silently dropping facts.
		for (const id of nodes.keys()) visit(id);
		return result;
	}

	function activeSubtreeSnapshot(): Map<string, boolean> {
		const result = new Map<string, boolean>();
		const visiting = new Set<string>();
		const containsActiveNode = (id: string): boolean => {
			const known = result.get(id);
			if (known !== undefined) return known;
			if (visiting.has(id)) return false;
			visiting.add(id);
			const node = nodes.get(id);
			let active = node !== undefined && ACTIVE_STATUSES.has(node.status);
			if (!active) {
				for (const childId of sortedChildren(id)) {
					if (containsActiveNode(childId)) {
						active = true;
						break;
					}
				}
			}
			visiting.delete(id);
			result.set(id, active);
			return active;
		};
		for (const id of nodes.keys()) containsActiveNode(id);
		return result;
	}

	/** Derive default folding from the whole snapshot, independent of input/event order. */
	function reconcileExpansion(): void {
		const activeSubtrees = activeSubtreeSnapshot();
		expanded.clear();
		for (const node of nodes.values()) {
			if (sortedChildren(node.id).length === 0) continue;
			const activeSubtree = activeSubtrees.get(node.id) === true;
			const manualChoice = manualExpansion.get(node.id);
			const defaultExpanded = node.depth <= 2 && !TERMINAL_STATUSES.has(node.status);
			// Any active descendant forces the entire ancestor path open; manual
			// collapse is remembered and applied after that subtree becomes terminal.
			if (activeSubtree || (manualChoice ?? defaultExpanded)) expanded.add(node.id);
		}
	}

	function rebuildIndexes(nextNodes: readonly TreeNodeSnapshot[]): void {
		nodes.clear();
		children.clear();
		for (const node of nextNodes) {
			nodes.set(node.id, { ...node });
			children.set(node.id, []);
		}
		for (const node of nextNodes) {
			if (node.parentId === null) continue;
			const siblings = children.get(node.parentId);
			if (siblings && nodes.has(node.id)) siblings.push(node.id);
		}
		for (const ids of children.values()) {
			ids.sort((leftId, rightId) => {
				const left = nodes.get(leftId)!;
				const right = nodes.get(rightId)!;
				return left.createdAt - right.createdAt || left.id.localeCompare(right.id);
			});
		}
		for (const id of [...activity.keys()]) {
			if (!nodes.has(id)) activity.delete(id);
		}
		for (const id of [...manualExpansion.keys()]) {
			if (!nodes.has(id)) manualExpansion.delete(id);
		}
		if (!selectedId || !nodes.has(selectedId)) selectedId = rootIds()[0];
		reconcileExpansion();
		buildRows();
	}

	function subtreeSize(id: string, visited = new Set<string>()): number {
		if (visited.has(id)) return 0;
		visited.add(id);
		return 1 + sortedChildren(id).reduce((sum, childId) => sum + subtreeSize(childId, visited), 0);
	}

	function safeText(value: string | null | undefined): string {
		return value
			? stripTerminalSequences(value)
				.replace(/[\r\n\t]/g, " ")
				.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, "")
			: "";
	}

	function fitLine(line: string, width: number): string {
		const safeWidth = Math.max(1, Math.floor(width));
		return visibleWidth(line) <= safeWidth ? line : truncateToWidth(line, safeWidth);
	}

	function styleNodeLine(line: string, node: TreeNodeSnapshot, selected: boolean): string {
		if (TERMINAL_STATUSES.has(node.status) && theme) return theme.fg("dim", line);
		if (selected && theme) return theme.fg("accent", line);
		return line;
	}

	function rowHead(node: TreeNodeSnapshot, isSelected: boolean, forcedExpanded = false): string {
		const hasChildren = sortedChildren(node.id).length > 0;
		const marker = hasChildren ? (expanded.has(node.id) || forcedExpanded ? "▾" : "▸") : " ";
		const selection = isSelected ? "❯" : " ";
		const indent = "  ".repeat(Math.max(0, node.depth));
		const model = safeText(node.model);
		return formatNodeLine(node, `${indent}${selection}${marker} `, model);
	}

	function formatNodeLine(node: TreeNodeSnapshot, prefix: string, model: string, suffix?: string): string {
		const head = `${prefix}● ${osc8NodeLink(node.id, safeText(node.name))} (${safeText(node.role)})`;
		return [head, ...(model ? [model] : []), formatElapsed(node), ...(suffix ? [suffix] : [])].join(" · ");
	}

	function rowDetail(node: TreeNodeSnapshot, isSelected: boolean): string {
		const info = activity.get(node.id);
		const turn = info?.turn ?? node.turn ?? node.turns;
		const turnStartedAt = info?.turnStartedAt ?? node.turnStartedAt;
		const tools = info?.tools.length ? info.tools : node.lastTools ?? node.tools ?? [];
		const detail = [safeText(info?.phase ?? node.phase ?? node.status)];
		if (turn !== undefined && turn > 0) {
			const turnSuffix = formatTurnElapsed(turnStartedAt, node);
			detail.push(`turn ${turn}${turnSuffix ? ` (${turnSuffix})` : ""}`);
		}
		if (tools.length > 0) {
			detail.push(tools.slice(-MAX_ACTIVITY_TOOLS).map((tool) => safeText(tool)).join(", "));
		}
		return `${"  ".repeat(Math.max(0, node.depth))}${isSelected ? "│" : " "}   ⎿ ${detail.join(" · ")}`;
	}

	/**
	 * The expanded phase machine for the selected node (#298).
	 *
	 * Before the machine became declarative this was unnecessary: the seven phases
	 * were fixed and an operator could hold them in their head. Now each team can
	 * declare its own phases, so "where is this team and what may it do next" is
	 * only answerable by reading the machine. The runtime refuses illegal moves and
	 * names the legal ones, but nothing showed the WHOLE picture — this does.
	 *
	 * Rendered only for the node that DECLARES the machine (the team root) and only
	 * while it is selected, so the tree does not become a wall of config.
	 */
	function machineLines(node: TreeNodeSnapshot, isSelected: boolean): string[] {
		if (!isSelected) return [];
		// Only a node that DECLARES a machine shows one. Falling back to the built-in
		// machine here would unfold seven phases under every selected row — a wall of
		// config on a node that never configured anything, and it shifted every row's
		// position (breaking scrolling and collapse).
		const machine = node.phaseMachine;
		if (!machine || machine.phases.length === 0) return [];
		const current = node.phase;
		const indent = "  ".repeat(Math.max(0, node.depth)) + (isSelected ? "│" : " ");
		const out: string[] = [];
		out.push(`${indent}     phases · current: ${safeText(current ?? "-")}`);
		for (const phase of machine.phases) {
			const here = phase.id === current;
			const marker = here ? "●" : "○";
			const timeout = phase.timeoutMs !== undefined ? ` ${Math.round(phase.timeoutMs / 1000)}s` : "";
			out.push(`${indent}     ${marker} ${safeText(phase.id)}${timeout}${here ? "  ← now" : ""}`);
			for (const rule of phase.next) {
				const bits: string[] = [];
				if (rule.require?.length) bits.push(`if ${rule.require.join(" & ")}`);
				if (rule.actorRole) bits.push(`by ${rule.actorRole}`);
				if (rule.rework) bits.push("rework");
				const suffix = bits.length ? `  (${bits.join(", ")})` : "";
				out.push(`${indent}         → ${safeText(rule.to)}${suffix}`);
			}
			if (phase.next.length === 0) out.push(`${indent}         (terminal)`);
		}
		return out;
	}

	/**
	 * Current-turn elapsed for the tree detail line: live while the node runs,
	 * frozen at the node's terminal transition once it settles.
	 */
	function formatTurnElapsed(
		turnStartedAt: number | undefined,
		node: TreeNodeSnapshot,
	): string | undefined {
		if (turnStartedAt === undefined) return undefined;
		const end = TERMINAL_STATUSES.has(node.status) ? node.updatedAt : now();
		if (end < turnStartedAt) return undefined;
		return `${Math.max(0, Math.round((end - turnStartedAt) / 1_000))}s`;
	}

	function findMatches(): string[] {
		const query = searchQuery.trim().toLocaleLowerCase();
		if (!query) return [];
		return allNodeIds().filter((id) => {
			const node = nodes.get(id);
			return Boolean(
				node &&
				[id, node.name, node.role, node.model ?? ""]
					.some((value) => safeText(value).toLocaleLowerCase().includes(query)),
			);
		});
	}

	function searchVisibleNodeIds(): string[] {
		if (!searchMode || !searchQuery.trim()) return [];
		const included = new Set(findMatches());
		for (const id of [...included]) {
			let current = nodes.get(id);
			const ancestors = new Set<string>();
			while (current?.parentId && !ancestors.has(current.parentId)) {
				ancestors.add(current.parentId);
				included.add(current.parentId);
				current = nodes.get(current.parentId);
			}
		}
		return allNodeIds().filter((id) => included.has(id));
	}

	function isVisuallyExpanded(id: string, searchVisible?: ReadonlySet<string>): boolean {
		if (searchVisible) return sortedChildren(id).some((childId) => searchVisible.has(childId));
		return expanded.has(id);
	}

	function visibleNodeIds(): string[] {
		if (searchMode && searchQuery.trim()) return searchVisibleNodeIds();
		const result: string[] = [];
		const visited = new Set<string>();
		const visit = (id: string): void => {
			if (visited.has(id)) return;
			visited.add(id);
			result.push(id);
			if (!expanded.has(id)) return;
			for (const childId of sortedChildren(id)) visit(childId);
		};
		for (const id of rootIds()) visit(id);
		return result;
	}

	function bodyPageSize(): number {
		return Math.max(0, currentTerminalRows() - headerLineCount);
	}

	function maxScrollTop(): number {
		return Math.max(0, rowLines.length - headerLineCount - bodyPageSize());
	}

	function clampScrollTop(): void {
		scrollTop = Math.max(0, Math.min(maxScrollTop(), Math.trunc(scrollTop)));
	}

	function renderTree(width: number): string[] {
		contentWidth = Math.max(1, Math.floor(width));
		rowLines = buildRows();
		clampScrollTop();
		const end = headerLineCount + scrollTop + bodyPageSize();
		return [
			...rowLines.slice(0, headerLineCount),
			...rowLines.slice(headerLineCount + scrollTop, end),
		];
	}

	function scrollBy(lines: number): void {
		rowLines = buildRows();
		clampScrollTop();
		const delta = Number.isFinite(lines) ? Math.trunc(lines) : 0;
		const nextScrollTop = Math.max(0, Math.min(maxScrollTop(), scrollTop + delta));
		if (nextScrollTop === scrollTop) return;
		scrollTop = nextScrollTop;
		requestRender();
	}

	function rowHeight(nodeId: string, searchVisible?: ReadonlySet<string>): number {
		return sortedChildren(nodeId).length > 0 && !isVisuallyExpanded(nodeId, searchVisible) ? 1 : 2;
	}

	function ensureSelectionVisible(): void {
		rowLines = buildRows();
		clampScrollTop();
		if (!selectedId || bodyPageSize() <= 0) return;
		const start = rowOffsets.get(selectedId);
		if (start === undefined) return;
		const searchVisible = searchMode && searchQuery.trim()
			? new Set(searchVisibleNodeIds())
			: undefined;
		const selectedHeight = rowHeight(selectedId, searchVisible);
		const visibleHeight = Math.min(selectedHeight, bodyPageSize());
		if (start < scrollTop) scrollTop = start;
		else if (start + visibleHeight > scrollTop + bodyPageSize()) {
			scrollTop = start + visibleHeight - bodyPageSize();
		}
		clampScrollTop();
	}

	function notifyRender(): void {
		requestRender();
	}

	function select(id: string): void {
		if (!nodes.has(id) || selectedId === id) return;
		selectedId = id;
		ensureSelectionVisible();
		notifyRender();
	}

	function toggleExpanded(id: string): void {
		if (sortedChildren(id).length === 0) return;
		const currentExpanded = expanded.has(id);
		if (currentExpanded && activeSubtreeSnapshot().get(id) === true) return;
		manualExpansion.set(id, !currentExpanded);
		reconcileExpansion();
		if (!expanded.has(id) && selectedId !== id && isDescendantOf(selectedId, id)) {
			selectedId = id;
		}
		ensureSelectionVisible();
		notifyRender();
	}

	function isDescendantOf(nodeId: string | undefined, ancestorId: string): boolean {
		if (!nodeId) return false;
		let current = nodes.get(nodeId);
		const visited = new Set<string>();
		while (current?.parentId) {
			if (current.parentId === ancestorId) return true;
			if (visited.has(current.parentId)) return false;
			visited.add(current.parentId);
			current = nodes.get(current.parentId);
		}
		return false;
	}

	function reveal(id: string): void {
		let current = nodes.get(id);
		const visited = new Set<string>();
		while (current?.parentId && !visited.has(current.parentId)) {
			visited.add(current.parentId);
			manualExpansion.set(current.parentId, true);
			current = nodes.get(current.parentId);
		}
		reconcileExpansion();
	}

	function submitSearch(): void {
		const matches = findMatches();
		if (matches.length === 0) return;
		const selectedIndex = selectedId ? matches.indexOf(selectedId) : -1;
		searchMatchIndex = (selectedIndex + 1 + matches.length) % matches.length;
		const target = matches[searchMatchIndex];
		if (!target) return;
		searchMode = false;
		reveal(target);
		selectedId = target;
		ensureSelectionVisible();
		notifyRender();
	}

	function moveSelection(delta: number): void {
		const ids = visibleNodeIds();
		if (ids.length === 0) return;
		const index = selectedId ? ids.indexOf(selectedId) : -1;
		const next = Math.max(0, Math.min(ids.length - 1, index + delta));
		const target = ids[next];
		if (target) select(target);
	}

	function finish(): void {
		if (closed) return;
		closed = true;
		done(undefined);
	}

	function toggleSelected(): void {
		if (selectedId) toggleExpanded(selectedId);
	}

	function handleInput(data: string): void {
		if (closed) return;
		if (matchesKey(data, Key.escape)) {
			if (searchMode) {
				searchMode = false;
				searchQuery = "";
				searchMatchIndex = -1;
				clampScrollTop();
				notifyRender();
			} else {
				finish();
			}
			return;
		}
		if (searchMode) {
			if (matchesKey(data, Key.enter)) {
				submitSearch();
				return;
			}
			if (matchesKey(data, Key.backspace)) {
				searchQuery = searchQuery.slice(0, -1);
				searchMatchIndex = -1;
				clampScrollTop();
				notifyRender();
				return;
			}
			if (matchesKey(data, Key.ctrl("u"))) {
				searchQuery = "";
				searchMatchIndex = -1;
				clampScrollTop();
				notifyRender();
				return;
			}
			if (matchesKey(data, "q")) {
				searchQuery += "q";
				clampScrollTop();
				notifyRender();
				return;
			}
			const searchChar = printableCharacter(data);
			if (searchChar) {
				searchQuery += searchChar;
				searchMatchIndex = -1;
				clampScrollTop();
				notifyRender();
			}
			return;
		}
		if (matchesKey(data, "q")) {
			finish();
		} else if (matchesKey(data, "j") || matchesKey(data, Key.down)) {
			moveSelection(1);
		} else if (matchesKey(data, "k") || matchesKey(data, Key.up)) {
			moveSelection(-1);
		} else if (matchesKey(data, Key.enter) || matchesKey(data, Key.space)) {
			toggleSelected();
		} else if (matchesKey(data, Key.right)) {
			if (selectedId && !expanded.has(selectedId)) toggleExpanded(selectedId);
			else if (selectedId) {
				const firstChild = sortedChildren(selectedId)[0];
				if (firstChild) select(firstChild);
			}
		} else if (matchesKey(data, Key.left)) {
			if (selectedId && expanded.has(selectedId)) toggleExpanded(selectedId);
			else if (selectedId) {
				const parentId = nodes.get(selectedId)?.parentId;
				if (parentId) select(parentId);
			}
		} else if (matchesKey(data, "/")) {
			searchMode = true;
			searchQuery = "";
			searchMatchIndex = -1;
			clampScrollTop();
			notifyRender();
		} else if (matchesKey(data, Key.pageDown)) {
			scrollBy(Math.max(1, bodyPageSize()));
		} else if (matchesKey(data, Key.pageUp)) {
			scrollBy(-Math.max(1, bodyPageSize()));
		}
	}

	function handleTreeMouse(event: TuiMouseEvent): { handled: boolean; focus?: boolean } | undefined {
		if (event.type === "press" && event.button === "left") {
			return { handled: true, focus: true };
		}
		if (event.type === "wheel" && event.wheelDelta) {
			// Pi TUI uses negative deltas for wheel-up; preserve that orientation.
			scrollBy(event.wheelDelta);
			return { handled: true };
		}
		if (event.type !== "click" || event.button !== "left") return undefined;
		rowLines = buildRows();
		clampScrollTop();
		const searchVisible = searchMode && searchQuery.trim()
			? new Set(searchVisibleNodeIds())
			: undefined;
		const contentY = event.y - headerLineCount + scrollTop;
		if (contentY < 0) return undefined;
		for (const id of visibleNodeIds()) {
			const start = rowOffsets.get(id);
			if (start === undefined) continue;
			const node = nodes.get(id);
			if (!node) continue;
			const height = rowHeight(id, searchVisible);
			if (contentY < start || contentY >= start + height) continue;
			select(id);
			if (contentY === start && sortedChildren(id).length > 0) toggleExpanded(id);
			return { handled: true, focus: true };
		}
		return undefined;
	}

	function applyStoredEvents(events: readonly LegionEvent[]): void {
		for (const event of events) applyEvent(event, false);
		reconcileExpansion();
	}

	function applyEvent(event: LegionEvent, redraw = true): void {
		const current = nodes.get(event.nodeId);
		if (!current) return;
		const updated: TreeNodeSnapshot = { ...current };
		const data = recordOf(event.data);
		const details = activity.get(event.nodeId) ?? { tools: [] };
		let changed = false;
		switch (event.type) {
			case "node_launched":
				updated.status = "running";
				updated.updatedAt = event.ts;
				changed = true;
				break;
			case "node_settled":
				updated.status = "settled";
				updated.updatedAt = event.ts;
				changed = true;
				break;
			case "node_failed":
				updated.status = "failed";
				updated.updatedAt = event.ts;
				changed = true;
				break;
			case "node_retired":
				updated.status = "retired";
				updated.updatedAt = event.ts;
				changed = true;
				break;
			case "node_blocked":
				updated.status = "blocked";
				updated.updatedAt = event.ts;
				changed = true;
				break;
			case "node_resumed":
				updated.status = "running";
				updated.updatedAt = event.ts;
				changed = true;
				break;
			case "phase_change":
				if (typeof data?.to === "string") {
					updated.phase = data.to;
					details.phase = data.to;
					updated.phaseSince = event.ts;
					changed = true;
				}
				break;
			case "turn_start":
				details.turn =
					typeof data?.turn === "number"
						? data.turn
						: (details.turn ?? current.turn ?? current.turns ?? 0) + 1;
				details.turnStartedAt = event.ts;
				changed = true;
				break;
			case "agent_settled":
				// The in-flight turn is over; stop timing it. Turn count stays.
				if (details.turnStartedAt !== undefined) {
					details.turnStartedAt = undefined;
					changed = true;
				}
				break;
			case "tool_call": {
				const toolName = stringField(data, "toolName") ?? stringField(data, "name");
				if (toolName) {
					details.tools.push(toolName);
					if (details.tools.length > MAX_ACTIVITY_TOOLS) details.tools.shift();
					changed = true;
				}
				break;
			}
			case "text_delta":
				// Text is intentionally not interpreted by the tree: RPC text is display-only elsewhere.
				break;
			default:
				break;
		}
		if (!changed) return;
		nodes.set(event.nodeId, updated);
		activity.set(event.nodeId, details);
		if (redraw) {
			reconcileExpansion();
			ensureSelectionVisible();
			notifyRender();
		}
	}

	function getState(): TreeViewState {
		rowLines = buildRows();
		clampScrollTop();
		return {
			selectedId,
			expandedIds: allNodeIds().filter((id) => expanded.has(id)),
			visibleIds: visibleNodeIds(),
			searchMode,
			searchQuery,
			scrollTop,
			pageSize: bodyPageSize(),
			maxScrollTop: maxScrollTop(),
		};
	}

	function dispose(): void {
		closed = true;
	}

	function buildRows(): string[] {
		const searchVisible = searchMode && searchQuery.trim()
			? new Set(searchVisibleNodeIds())
			: undefined;
		const visibleIds = searchVisible ? [...searchVisible] : visibleNodeIds();
		const headerLines = [fitLine(TREE_HEADER, contentWidth)];
		if (searchMode) {
			const matches = findMatches();
			const suffix = matches.length
				? ` · ${Math.min(searchMatchIndex + 1, matches.length)}/${matches.length}`
				: " · no matches";
			const searchLine = fitLine(`/${searchQuery}▏${suffix}`, contentWidth);
			if (currentTerminalRows() > 1) headerLines.push(searchLine);
			else headerLines[0] = fitLine(`${TREE_HEADER} · ${searchLine}`, contentWidth);
		}
		headerLineCount = headerLines.length;
		const lines = [...headerLines];
		rowOffsets.clear();
		if (nodes.size === 0) {
			lines.push(fitLine("No Legion nodes yet.", contentWidth));
			return lines;
		}
		for (const id of visibleIds) {
			const node = nodes.get(id);
			if (!node) continue;
			const bodyOffset = lines.length - headerLineCount;
			rowOffsets.set(id, bodyOffset);
			const isSelected = selectedId === id;
			const childCount = sortedChildren(id).length;
			const isExpanded = isVisuallyExpanded(id, searchVisible);
			const hiddenCount = subtreeSize(id) - 1;
			const collapsedLine = `${"  ".repeat(Math.max(0, node.depth))}${isSelected ? "❯" : " "}▸ ${osc8NodeLink(node.id, safeText(node.name))} +${hiddenCount} collapsed`;
			const head = childCount > 0 && !isExpanded
				? collapsedLine
				: rowHead(node, isSelected, Boolean(searchVisible && isExpanded));
			lines.push(fitLine(styleNodeLine(head, node, isSelected), contentWidth));
			if (childCount > 0 && !isExpanded) continue;
			lines.push(fitLine(styleNodeLine(rowDetail(node, isSelected), node, isSelected), contentWidth));
			for (const line of machineLines(node, isSelected)) {
				lines.push(fitLine(styleNodeLine(line, node, isSelected), contentWidth));
			}
		}
		return lines;
	}

	function formatElapsed(node: TreeNodeSnapshot): string {
		const elapsedEnd = TERMINAL_STATUSES.has(node.status) ? node.updatedAt : now();
		const elapsedSeconds = Math.max(0, Math.round((elapsedEnd - node.createdAt) / 1_000));
		return `${elapsedSeconds}s`;
	}

	rebuildIndexes(options.nodes);
	if (options.events) applyStoredEvents(options.events);
	rowLines = buildRows();

	return {
		render: renderTree,
		handleInput,
		handleMouse: handleTreeMouse,
		invalidate() {},
		updateSnapshot(nextNodes, events = []) {
			rebuildIndexes(nextNodes);
			if (events.length > 0) applyStoredEvents(events);
			reconcileExpansion();
			ensureSelectionVisible();
			notifyRender();
		},
		applyEvent(event) {
			applyEvent(event);
		},
		getState,
		isExpanded(nodeId) {
			return expanded.has(nodeId);
		},
		dispose,
	};
}

/**
 * Build the `ctx.ui.custom()` factory shape. The custom factory receives a TUI,
 * and injects its terminal row count for self-managed paging instead of relying
 * on layout viewport measurement.
 */
export function createTreeViewFactory(options: TreeViewOptions) {
	return <T>(
		tui: Pick<TUI, "requestRender" | "terminal">,
		theme: TreeViewTheme,
		_keybindings: unknown,
		done: (result: T) => void,
	): TreeViewComponent =>
		createTreeView(
			{
				...options,
				terminalRows: () => tui.terminal.rows,
				theme,
				requestRender: () => tui.requestRender(),
			},
			() => done(undefined as T),
		);
}

interface TreeActivity {
	turn?: number;
	turnStartedAt?: number;
	phase?: string;
	tools: string[];
}

function printableCharacter(data: string): string | undefined {
	const kitty = decodeKittyPrintable(data);
	if (kitty !== undefined) return kitty;
	if (data.length !== 1) return undefined;
	const code = data.codePointAt(0);
	return code !== undefined && code >= 0x20 && code !== 0x7f ? data : undefined;
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function stringField(record: Record<string, unknown> | undefined, key: string): string | undefined {
	const value = record?.[key];
	return typeof value === "string" ? value : undefined;
}
