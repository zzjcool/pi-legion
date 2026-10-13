/** /legion full view: galaxy + tok/s chart + git-log history with linked selection. */

import { Key, matchesKey } from "@earendil-works/pi-tui";
import { Canvas, ellipsize } from "./canvas.ts";
import { computeLayout, type LayoutKind } from "./layout.ts";
import { formatCount, formatDuration, isAgent, type VizNode } from "./model.ts";
import { roleColor, type VizTheme } from "./palette.ts";
import { buildLog, dfsOrder, drawChart, drawGalaxy, drawLog, frame, type Pane, type ViewData } from "./panels.ts";

export interface LegionViewState {
	focus: Pane;
	selectedId?: string;
	logOffset: number;
	logCursor: number;
}

export function initialViewState(): LegionViewState {
	return { focus: "galaxy", logOffset: 0, logCursor: 0 };
}

const PANES: Pane[] = ["galaxy", "chart", "log"];

export function renderLegionView(data: ViewData, state: LegionViewState, cols: number, rows: number): { canvas: Canvas; layout: LayoutKind } {
	const W = Math.max(1, Math.floor(cols));
	const H = Math.max(6, Math.floor(rows));
	const layout = computeLayout(W, H);
	const cv = new Canvas(W, H);
	const selected = data.nodes.find((node) => node.id === state.selectedId);
	const portrait = layout.kind === "portrait";

	// Header.
	const agents = data.nodes.filter(isAgent);
	const live = agents.filter((node) => node.status === "running").length;
	const root = data.nodes.find((node) => node.parentId === null);
	const origin = Math.min(root?.startedAt ?? data.now, ...agents.map((node) => node.startedAt));
	const elapsed = formatDuration(data.now - origin);
	const failed = agents.filter((node) => node.status === "failed").length;
	const parts = [
		`live ${live}`,
		`${formatCount(data.rate)} tok/s`,
		elapsed,
		`${agents.length} agents`,
		...(failed ? [`${failed} failed`] : []),
	];
	const badge = selected ? ` ${selected.name} (${selected.role} · ${statusLabel(selected)}) ` : "";
	if (portrait) {
		cv.text(0, 0, "⚔ /legion ", "accent", { bold: true });
		cv.text(10, 0, ellipsize(root?.name ?? "", Math.max(0, W - 10)), "text", { bold: true });
		cv.text(0, 1, ellipsize(parts.join(" · "), W), "dim");
		if (badge) {
			const b = ellipsize(badge, Math.max(0, W - 12 - Array.from(root?.name ?? "").length));
			if (b.length > 4) cv.text(W - Array.from(b).length, 0, b, roleColor(selected!.role), { inverse: true });
		}
	} else {
		let x = cv.text(0, 0, "⚔ /legion ", "accent", { bold: true });
		x = cv.text(x, 0, `${root?.name ?? "legion"}  `, "text", { bold: true });
		const badgeW = Array.from(badge).length;
		cv.text(x, 0, ellipsize(parts.join(" · "), Math.max(0, W - x - badgeW - 1)), "dim");
		if (badge) cv.text(Math.max(0, W - badgeW), 0, ellipsize(badge, W), roleColor(selected!.role), { inverse: true });
	}

	const galaxyInner = frame(cv, layout.galaxy, portrait ? "galaxy" : "galaxy · structure", state.focus === "galaxy");
	drawGalaxy(cv, galaxyInner, data, state.selectedId);
	const chartInner = frame(cv, layout.chart, portrait ? "tok/s · by role" : "tok/s · stacked by role", state.focus === "chart");
	drawChart(cv, chartInner, data, selected, !portrait);
	const events = buildLog(data.nodes);
	clampLog(state, events.length, Math.max(1, layout.log.h - 3));
	const logInner = frame(cv, layout.log, "log --graph", state.focus === "log", portrait ? undefined : "↑↓ scroll · ⏎ select");
	drawLog(cv, logInner, events, {
		offset: state.logOffset,
		cursor: state.logCursor,
		focused: state.focus === "log",
		...(state.selectedId ? { selectedId: state.selectedId } : {}),
		origin,
	});

	// Footer.
	const keys: Array<[string, string]> = portrait
		? [["Tab", "pane"], ["↑↓", ""], ["⏎", "sel"], ["o", "open"], ["esc", ""], ["q", ""]]
		: [["Tab", "focus"], ["↑↓", "scroll"], ["PgUp/PgDn", "page"], ["Enter", "select agent"], ["o", "open"], ["Esc", "clear"], ["q", "quit"]];
	const right = portrait ? state.focus : `focus: ${state.focus}`;
	const fy = layout.footer.y;
	let fx = 0;
	for (const [key, label] of keys) {
		const w = key.length + (label ? label.length + 1 : 0) + 2;
		if (fx + w > W - right.length - 1) break;
		cv.text(fx, fy, key, "accent", { bold: true });
		if (label) cv.text(fx + key.length + 1, fy, label, "dim");
		fx += w;
	}
	if (W - right.length > fx) cv.text(W - right.length, fy, right, "accent", { bold: true });
	return { canvas: cv, layout: layout.kind };
}

function statusLabel(node: VizNode): string {
	return node.status === "settled" ? "done" : node.status;
}

function clampLog(state: LegionViewState, count: number, visible: number): void {
	state.logCursor = Math.max(0, Math.min(state.logCursor, count - 1));
	if (state.logCursor < state.logOffset) state.logOffset = state.logCursor;
	if (state.logCursor >= state.logOffset + visible) state.logOffset = state.logCursor - visible + 1;
	state.logOffset = Math.max(0, Math.min(state.logOffset, Math.max(0, count - visible)));
}

export type ViewAction = "none" | "render" | "close" | "open";

/** Pure key handling so it can be unit tested without a terminal. */
export function handleViewKey(data: string, state: LegionViewState, nodes: readonly VizNode[], page = 10): ViewAction {
	const events = buildLog(nodes);
	const order = dfsOrder(nodes).filter(isAgent);
	if (matchesKey(data, "q") || matchesKey(data, Key.ctrl("c"))) return "close";
	if (matchesKey(data, Key.escape)) {
		if (state.selectedId) {
			delete state.selectedId;
			return "render";
		}
		return "close";
	}
	if (matchesKey(data, Key.tab)) {
		state.focus = PANES[(PANES.indexOf(state.focus) + 1) % PANES.length]!;
		return "render";
	}
	if (matchesKey(data, Key.shift("tab"))) {
		state.focus = PANES[(PANES.indexOf(state.focus) + PANES.length - 1) % PANES.length]!;
		return "render";
	}
	if (matchesKey(data, "o")) return state.selectedId ? "open" : "none";
	const down = matchesKey(data, Key.down) || matchesKey(data, "j");
	const up = matchesKey(data, Key.up) || matchesKey(data, "k");
	if (state.focus === "log") {
		if (down) state.logCursor = Math.min(events.length - 1, state.logCursor + 1);
		else if (up) state.logCursor = Math.max(0, state.logCursor - 1);
		else if (matchesKey(data, Key.pageDown)) state.logCursor = Math.min(events.length - 1, state.logCursor + page);
		else if (matchesKey(data, Key.pageUp)) state.logCursor = Math.max(0, state.logCursor - page);
		else if (matchesKey(data, Key.home)) state.logCursor = 0;
		else if (matchesKey(data, Key.end)) state.logCursor = Math.max(0, events.length - 1);
		else if (matchesKey(data, Key.enter)) {
			const event = events[state.logCursor];
			if (!event) return "none";
			state.selectedId = state.selectedId === event.node.id ? undefined : event.node.id;
			if (state.selectedId === undefined) delete state.selectedId;
		} else return "none";
		return "render";
	}
	if (down || up || matchesKey(data, Key.right) || matchesKey(data, Key.left)) {
		if (order.length === 0) return "none";
		const step = down || matchesKey(data, Key.right) ? 1 : -1;
		const index = order.findIndex((node) => node.id === state.selectedId);
		const next = index < 0 ? (step > 0 ? 0 : order.length - 1) : (index + step + order.length) % order.length;
		state.selectedId = order[next]!.id;
		return "render";
	}
	if (matchesKey(data, Key.enter)) return state.selectedId ? "open" : "none";
	return "none";
}

export interface LegionViewOptions {
	getData(): ViewData;
	onOpenNode?(nodeId: string): void;
	refreshMs?: number;
}

interface ViewTui {
	requestRender(): void;
	terminal: { rows: number; columns?: number };
}

/** ctx.ui.custom() factory for the full view. */
export function createLegionViewFactory(options: LegionViewOptions) {
	return (tui: ViewTui, theme: VizTheme, _keybindings: unknown, done: (result: void) => void) => {
		const state = initialViewState();
		const timer = setInterval(() => tui.requestRender(), options.refreshMs ?? 1000);
		(timer as { unref?: () => void }).unref?.();
		let closed = false;
		const close = (): void => {
			if (closed) return;
			closed = true;
			clearInterval(timer);
			done(undefined);
		};
		return {
			render(width: number): string[] {
				// Rendered as a full-screen overlay: own the whole terminal height.
				const rows = Math.max(6, tui.terminal.rows ?? 24);
				return renderLegionView(options.getData(), state, width, rows).canvas.toLines(theme);
			},
			handleInput(data: string): void {
				const action = handleViewKey(data, state, options.getData().nodes, Math.max(1, (tui.terminal.rows ?? 24) - 8));
				if (action === "close") return close();
				if (action === "open" && state.selectedId) options.onOpenNode?.(state.selectedId);
				tui.requestRender();
			},
			invalidate(): void {},
			dispose(): void {
				clearInterval(timer);
			},
		};
	};
}
