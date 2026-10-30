/** /legion full view: galaxy + tok/s chart + timing + git-log history with linked selection. */

import { Key, matchesKey } from "@earendil-works/pi-tui";
import { Canvas, cellWidth, ellipsize } from "./canvas.ts";
import { computeLayout, type LayoutKind, type LegionLayout } from "./layout.ts";
import { formatCount, formatDuration, isAgent, type VizNode } from "./model.ts";
import { roleColor, type VizTheme } from "./palette.ts";
import {
	buildLog,
	dfsOrder,
	drawChart,
	drawGalaxy,
	drawLog,
	drawStatus,
	drawTiming,
	frame,
	statusRowsFromNodes,
	statusVisibleRows,
	timingRowsFromNodes,
	type Pane,
	type ViewData,
} from "./panels.ts";

export interface LegionViewState {
	focus: Pane;
	selectedId?: string;
	logOffset: number;
	logCursor: number;
	timingOffset: number;
	timingCursor: number;
	statusOffset: number;
	statusCursor: number;
	/** `x` pressed: an in-view y/N prompt for stopping this agent (dialogs would be hidden behind the full-screen view). */
	pendingStopId?: string;
}

export function initialViewState(): LegionViewState {
	return {
		focus: "galaxy",
		logOffset: 0,
		logCursor: 0,
		timingOffset: 0,
		timingCursor: 0,
		statusOffset: 0,
		statusCursor: 0,
	};
}

/** Tab order (D8): `status` last, so the existing galaxy→chart→timing→log walk is unchanged. */
const PANES: readonly Pane[] = ["galaxy", "chart", "timing", "log", "status"];

/**
 * Panes this layout actually placed. Portrait leaves no room for a fifth pane
 * and returns a zero-height `status` rect (D1); Tab must skip what is not drawn
 * rather than park the focus on an invisible box.
 */
export function availablePanes(layout: LegionLayout): Pane[] {
	return PANES.filter((pane) => layout[pane].h > 0);
}

/** Min grapheme cells before painting a selection badge. Shared by portrait + landscape so a truncated stub never paints (#128). Was portrait `>4` vs landscape `>0`. */
export const MIN_SELECTION_BADGE_W = 5;

/**
 * #308: the `ThemeBg` token used as the /legion page floor.
 *
 * `toolPendingBg` is the only one of the seven `ThemeBg` keys that is a **neutral
 * surface** rather than a hued panel: dark theme `okhsl(229 5% 24%)`, light theme
 * `okhsl(248 3% 91%)`, and the `system` theme's `neutral` family — a lifted grey
 * with no hue identity, which is what a page background is. The alternatives all
 * carry a color story that would paint the whole page: `selectedBg` /
 * `userMessageBg` are blue (`blueBg` in both built-in themes), `customMessageBg`
 * violet, `searchMatchBg` yellow (a highlight), `toolSuccessBg` / `toolErrorBg`
 * green / red. The trade-off is brightness, not hue: `toolPendingBg` sits ~8 points
 * lighter than the theme's export-only `pageBg` (`okhsl(262 14% 16%)` dark), which
 * is the token the upstream theme package does not expose as a renderable color.
 * The contract (`docs/contracts/legion-page-floor-v1.md`) records the consequence
 * for the `system` theme, where every `ThemeBg` key renders as `\x1b[49m`.
 */
export const LEGION_PAGE_BG = "toolPendingBg";

/**
 * #308: wrap every /legion row in the page floor.
 *
 * pi-tui's overlay compositor inherits styling for the rectangle *beside* an
 * overlay from a one-shot snapshot of the SGR state active at the first grapheme
 * after the rect (`extractSegments`). A /legion row ends in plain spaces with no
 * SGR at all, so that snapshot is empty and the gutter right of the floating
 * modal fell back to the terminal's default background — a black band on the
 * right of the frame (#308). Painting the floor on the whole row makes the
 * inherited state the page background instead.
 *
 * `theme.bg` is optional on purpose: a theme that ships no background tokens
 * (every unit-test fake) gets today's bytes, unchanged.
 */
export function paintPageFloor(theme: VizTheme, lines: readonly string[]): string[] {
	return lines.map((line) => theme.bg?.(LEGION_PAGE_BG, line) ?? line);
}

export function renderLegionView(data: ViewData, state: LegionViewState, cols: number, rows: number): { canvas: Canvas; layout: LayoutKind } {
	const W = Math.max(1, Math.floor(cols));
	const H = Math.max(6, Math.floor(rows));
	const layout = computeLayout(W, H, { logEvents: buildLog(data.nodes).length });
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
	const badgeRaw = selected ? ` ${selected.name} (${selected.role} · ${statusLabel(selected)}) ` : "";
	// Cap the selection badge so a long agent name never overwrites "⚔ /legion" / the run name.
	const badgeCap = Math.max(0, Math.min(cellWidth(badgeRaw), Math.floor(W * 0.45), W - 14));
	const badge = badgeRaw ? ellipsize(badgeRaw, badgeCap) : "";
	const badgeW = cellWidth(badge);
	const showBadge = badgeW >= MIN_SELECTION_BADGE_W;
	if (portrait) {
		cv.text(0, 0, "⚔ /legion ", "accent", { bold: true });
		const rootRoom = Math.max(0, W - 10 - (showBadge ? badgeW + 1 : 0));
		cv.text(10, 0, ellipsize(root?.name ?? "", rootRoom), "text", { bold: true });
		cv.text(0, 1, ellipsize(parts.join(" · "), W), "dim");
		if (showBadge) cv.text(W - badgeW, 0, badge, roleColor(selected!.role), { inverse: true });
	} else {
		let x = cv.text(0, 0, "⚔ /legion ", "accent", { bold: true });
		const reservedBadge = showBadge ? badgeW : 0;
		const rootRoom = Math.max(0, W - x - reservedBadge - 1);
		x = cv.text(x, 0, ellipsize(`${root?.name ?? "legion"}  `, rootRoom), "text", { bold: true });
		cv.text(x, 0, ellipsize(parts.join(" · "), Math.max(0, W - x - reservedBadge - 1)), "dim");
		if (showBadge) cv.text(W - badgeW, 0, badge, roleColor(selected!.role), { inverse: true });
	}

	const galaxyInner = frame(cv, layout.galaxy, portrait ? "galaxy" : "galaxy · structure", state.focus === "galaxy");
	drawGalaxy(cv, galaxyInner, data, state.selectedId);
	const chartInner = frame(cv, layout.chart, portrait ? "tok/s · by role" : "tok/s · stacked by role", state.focus === "chart");
	drawChart(cv, chartInner, data, selected, !portrait);

	const timingRows = timingRowsFromNodes(data.nodes, data.now);
	const timingVisible = Math.max(1, layout.timing.h - 3);
	clampList(state, "timing", timingRows.length, timingVisible);
	const timingInner = frame(
		cv,
		layout.timing,
		portrait ? "timing" : "timing · wall/gen/other",
		state.focus === "timing",
		portrait ? undefined : "↑↓ · ⏎ sel · o open",
	);
	drawTiming(cv, timingInner, timingRows, {
		offset: state.timingOffset,
		cursor: state.timingCursor,
		focused: state.focus === "timing",
		...(state.selectedId ? { selectedId: state.selectedId } : {}),
	});

	const events = buildLog(data.nodes);
	clampList(state, "log", events.length, Math.max(1, layout.log.h - 3));
	const logInner = frame(cv, layout.log, "log --graph", state.focus === "log", portrait ? undefined : "↑↓ scroll · ⏎ select");
	drawLog(cv, logInner, events, {
		offset: state.logOffset,
		cursor: state.logCursor,
		focused: state.focus === "log",
		...(state.selectedId ? { selectedId: state.selectedId } : {}),
		origin,
	});

	// Status table (D1/D7). Portrait hands back a zero-area rect, so `frame()`
	// paints nothing and `drawStatus` bails on `r.w < 20` — no special case here.
	const statusRows = statusRowsFromNodes(data.nodes);
	const statusVisible = Math.max(1, statusVisibleRows(layout.status.h, statusRows.length));
	clampList(state, "status", statusRows.length, statusVisible);
	const statusInner = frame(
		cv,
		layout.status,
		portrait ? "status" : "status · agents",
		state.focus === "status",
		statusInnerHint(layout.kind),
	);
	drawStatus(cv, statusInner, statusRows, {
		offset: state.statusOffset,
		cursor: state.statusCursor,
		focused: state.focus === "status",
		...(state.selectedId ? { selectedId: state.selectedId } : {}),
	});

	// Footer.
	const keys: Array<[string, string]> = portrait
		? [["Tab", "pane"], ["↑↓", ""], ["⏎", "sel"], ["o", "open"], ["x", "stop"], ["esc", ""], ["q", ""]]
		: [["Tab", "focus"], ["↑↓", "scroll"], ["PgUp/PgDn", "page"], ["Enter", "select agent"], ["o", "open"], ["x", "stop"], ["Esc", "clear"], ["q", "quit"]];
	const right = portrait ? state.focus : `focus: ${state.focus}`;
	const fy = layout.footer.y;
	const pending = state.pendingStopId ? data.nodes.find((node) => node.id === state.pendingStopId) : undefined;
	if (pending) {
		cv.text(0, fy, `Stop ${pending.name}? Its own subagents are retired with it.`, "warning", { bold: true, maxX: W - 1 });
		const yn = "  y stop · any other key cancel";
		cv.text(Math.min(W - 1, Array.from(`Stop ${pending.name}? Its own subagents are retired with it.`).length), fy, yn, "dim", { maxX: W - 1 });
		return { canvas: cv, layout: layout.kind };
	}
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

/**
 * Key hint on the status title rule. Suppressed in portrait, where the pane is
 * zero-area and never drawn at all.
 */
function statusInnerHint(kind: LayoutKind): string | undefined {
	return kind === "portrait" ? undefined : "↑↓ scroll · ⏎ select";
}

function clampList(
	state: LegionViewState,
	which: "log" | "timing" | "status",
	count: number,
	visible: number,
): void {
	const [cursorKey, offsetKey] = which === "log"
		? (["logCursor", "logOffset"] as const)
		: which === "status"
			? (["statusCursor", "statusOffset"] as const)
			: (["timingCursor", "timingOffset"] as const);
	state[cursorKey] = Math.max(0, Math.min(state[cursorKey], count - 1));
	if (state[cursorKey] < state[offsetKey]) state[offsetKey] = state[cursorKey];
	if (state[cursorKey] >= state[offsetKey] + visible) state[offsetKey] = state[cursorKey] - visible + 1;
	state[offsetKey] = Math.max(0, Math.min(state[offsetKey], Math.max(0, count - visible)));
}

export type ViewAction = "none" | "render" | "close" | "open" | "stop";

/** Pure key handling so it can be unit tested without a terminal. */
export function handleViewKey(
	data: string,
	state: LegionViewState,
	nodes: readonly VizNode[],
	page = 10,
	panes: readonly Pane[] = PANES,
): ViewAction {
	const events = buildLog(nodes);
	const timingRows = timingRowsFromNodes(nodes, Date.now());
	const statusRows = statusRowsFromNodes(nodes);
	const order = dfsOrder(nodes).filter(isAgent);
	if (state.pendingStopId) {
		const confirmed = matchesKey(data, "y") || data === "Y" || matchesKey(data, Key.enter);
		if (confirmed) return "stop"; // the host reads and clears pendingStopId
		delete state.pendingStopId;
		return "render";
	}
	if (matchesKey(data, "q") || matchesKey(data, Key.ctrl("c"))) return "close";
	if (matchesKey(data, Key.escape)) {
		if (state.selectedId) {
			delete state.selectedId;
			return "render";
		}
		return "close";
	}
	if (matchesKey(data, Key.tab) || matchesKey(data, Key.shift("tab"))) {
		// `panes` defaults to every pane so existing callers keep the full walk;
		// the host passes `availablePanes(layout)` so Tab skips the zero-area
		// status pane in portrait (D1).
		const ring = panes.length > 0 ? panes : PANES;
		const step = matchesKey(data, Key.tab) ? 1 : ring.length - 1;
		const at = ring.indexOf(state.focus);
		// A focus outside `ring` (e.g. status after a resize to portrait) restarts
		// the walk at a pane that is actually drawn.
		state.focus = ring[(at < 0 ? (step > 0 ? 0 : ring.length - 1) : (at + step) % ring.length)]!;
		return "render";
	}
	if (matchesKey(data, "o")) return state.selectedId ? "open" : "none";
	if (matchesKey(data, "x")) {
		const selected = state.selectedId ? nodes.find((node) => node.id === state.selectedId) : undefined;
		if (!selected || !isAgent(selected) || selected.status !== "running") return "none";
		state.pendingStopId = selected.id;
		return "render";
	}
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
	if (state.focus === "timing") {
		if (down) state.timingCursor = Math.min(timingRows.length - 1, state.timingCursor + 1);
		else if (up) state.timingCursor = Math.max(0, state.timingCursor - 1);
		else if (matchesKey(data, Key.pageDown)) state.timingCursor = Math.min(timingRows.length - 1, state.timingCursor + page);
		else if (matchesKey(data, Key.pageUp)) state.timingCursor = Math.max(0, state.timingCursor - page);
		else if (matchesKey(data, Key.home)) state.timingCursor = 0;
		else if (matchesKey(data, Key.end)) state.timingCursor = Math.max(0, timingRows.length - 1);
		else if (matchesKey(data, Key.enter)) {
			const row = timingRows[state.timingCursor];
			if (!row) return "none";
			state.selectedId = state.selectedId === row.node.id ? undefined : row.node.id;
			if (state.selectedId === undefined) delete state.selectedId;
		} else return "none";
		return "render";
	}
	if (state.focus === "status") {
		if (down) state.statusCursor = Math.min(statusRows.length - 1, state.statusCursor + 1);
		else if (up) state.statusCursor = Math.max(0, state.statusCursor - 1);
		else if (matchesKey(data, Key.pageDown)) state.statusCursor = Math.min(statusRows.length - 1, state.statusCursor + page);
		else if (matchesKey(data, Key.pageUp)) state.statusCursor = Math.max(0, state.statusCursor - page);
		else if (matchesKey(data, Key.home)) state.statusCursor = 0;
		else if (matchesKey(data, Key.end)) state.statusCursor = Math.max(0, statusRows.length - 1);
		else if (matchesKey(data, Key.enter)) {
			const row = statusRows[state.statusCursor];
			if (!row) return "none";
			state.selectedId = state.selectedId === row.id ? undefined : row.id;
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
	/** `x` then `y` on a live selected agent: the host retires it (already confirmed in-view). */
	onStopNode?(nodeId: string): void;
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
		/**
		 * Panes the last painted frame actually placed, so Tab walks what the user
		 * can see: portrait leaves no room for a fifth pane (D1). Before the first
		 * paint this stays at the full ring, which is also `handleViewKey`'s default.
		 */
		let panes: Pane[] = [...PANES];
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
				panes = availablePanes(computeLayout(width, rows));
				return paintPageFloor(theme, renderLegionView(options.getData(), state, width, rows).canvas.toLines(theme));
			},
			handleInput(data: string): void {
				const action = handleViewKey(
					data,
					state,
					options.getData().nodes,
					Math.max(1, (tui.terminal.rows ?? 24) - 8),
					panes,
				);
				if (action === "close") return close();
				if (action === "open" && state.selectedId) options.onOpenNode?.(state.selectedId);
				if (action === "stop" && state.pendingStopId) {
					const id = state.pendingStopId;
					delete state.pendingStopId;
					options.onStopNode?.(id);
				}
				tui.requestRender();
			},
			invalidate(): void {},
			dispose(): void {
				clearInterval(timer);
			},
		};
	};
}
