/**
 * Above-input "railway" strip: one git-graph lane per live subagent.
 *
 * Only agents live now get a lane (oldest first, then shallowest), drawn on a
 * single shared time axis that ends at "now". When an agent ends its lane and
 * label disappear and the rows below shift up — no empty rows are ever kept.
 * The strip is hidden entirely when no subagent is live.
 */

import { Canvas, ellipsize } from "./canvas.ts";
import { formatCount, formatDuration, isAgent, type VizNode } from "./model.ts";
import { roleColor, type VizTheme } from "./palette.ts";

export const RAIL_MAX_LANES = 4;
export const RAIL_MAX_LANES_NARROW = 3;
export const RAIL_NARROW_COLS = 80;
export const RAIL_WINDOW_MS = 6 * 60 * 1000;

export interface RailInput {
	nodes: readonly VizNode[];
	now: number;
	width: number;
	/** tok/s over the shared 60s window. */
	rate: number;
	windowMs?: number;
	/** Lane scroll position when more agents are live than lanes fit. */
	scroll?: RailScroll;
	/** Dim hint on the header rule (e.g. stop controls while the main agent is idle). */
	hint?: string;
	/** Shorter variant used when the full hint does not fit. */
	hintShort?: string;
}

/**
 * Scroll state: `topId` anchors the view to the agent in the top visible lane
 * so agents ending above it don't shift what's on screen; `offset` is the
 * fallback when that agent itself is gone.
 */
export interface RailScroll {
	offset: number;
	topId?: string;
}

export interface RailRender {
	canvas: Canvas;
	/** Node id rendered on each output row (undefined for the header). */
	nodeIdsByRow: Array<string | undefined>;
	/**
	 * Per-cell owner map, hit[y][x] = node id whose glyph is drawn there (lane
	 * segments, fork connectors, name column), produced in the same pass that
	 * draws the canvas. Header, dotted background and padding are undefined.
	 */
	hit: Array<Array<string | undefined>>;
	shown: VizNode[];
	hidden: VizNode[];
	/** Resolved (clamped) scroll window. */
	offset: number;
	total: number;
	maxLanes: number;
}

function endOf(node: VizNode): number {
	return node.status === "running" ? Number.POSITIVE_INFINITY : node.endedAt ?? node.startedAt;
}

/** Agents alive at t, in lane priority order: oldest first, then shallowest, then name. */
export function liveAt(nodes: readonly VizNode[], t: number): VizNode[] {
	return nodes
		.filter((node) => isAgent(node) && node.startedAt <= t && t < endOf(node))
		.sort((a, b) => a.startedAt - b.startedAt || a.depth - b.depth || a.name.localeCompare(b.name));
}

/**
 * Clamp a scroll request to the live list. The anchor agent keeps its lane on
 * top while it lives; new agents (appended at the bottom, oldest-first order)
 * never move the view; when everything fits the offset is 0.
 */
export function resolveScroll(live: readonly VizNode[], maxLanes: number, scroll?: RailScroll): number {
	const maxOffset = Math.max(0, live.length - Math.max(0, maxLanes));
	if (maxOffset === 0 || !scroll) return 0;
	let offset = scroll.offset;
	if (scroll.topId !== undefined && offset > 0) {
		const index = live.findIndex((node) => node.id === scroll.topId);
		if (index >= 0) offset = index;
	}
	return Math.min(maxOffset, Math.max(0, Math.round(offset)));
}

/** "5-8/12" — 1-based visible lane range over the live total. */
export function scrollIndicator(offset: number, shown: number, total: number): string {
	return `${offset + 1}-${offset + shown}/${total}`;
}

/**
 * Lane assignment with compaction: live agents in priority order, the window
 * [offset, offset+maxLanes) gets rows 0..k-1; the rest are scrolled out.
 */
export function assignLanes(nodes: readonly VizNode[], t: number, maxLanes: number, scroll?: RailScroll): {
	lanes: Map<string, number>;
	shown: VizNode[];
	hidden: VizNode[];
	offset: number;
	total: number;
} {
	const live = liveAt(nodes, t);
	const offset = resolveScroll(live, maxLanes, scroll);
	const shown = live.slice(offset, offset + Math.max(0, maxLanes));
	return {
		lanes: new Map(shown.map((node, index) => [node.id, index])),
		shown,
		hidden: [...live.slice(0, offset), ...live.slice(offset + shown.length)],
		offset,
		total: live.length,
	};
}

export function maxLanesFor(width: number): number {
	return width < RAIL_NARROW_COLS ? RAIL_MAX_LANES_NARROW : RAIL_MAX_LANES;
}

export function formatRate(rate: number): string {
	return `${formatCount(rate)} tok/s`;
}

export function renderRailway(input: RailInput): RailRender | undefined {
	const width = Math.max(0, Math.floor(input.width));
	if (width < 20) return undefined;
	const { nodes, now } = input;
	const maxLanes = maxLanesFor(width);
	const current = assignLanes(nodes, now, maxLanes, input.scroll);
	const rows = current.shown.length;
	if (rows === 0) return undefined;
	const portrait = width < RAIL_NARROW_COLS;
	const windowMs = input.windowMs ?? RAIL_WINDOW_MS;
	const nameCol = portrait ? Math.max(8, Math.min(16, Math.floor(width * 0.32))) : Math.min(38, Math.max(24, Math.floor(width * 0.3)));
	const LX = 1;
	const AW = Math.max(4, width - LX - nameCol - 2);
	const dt = windowMs / AW;
	const tc = (c: number): number => now - windowMs + (c + 1) * dt;
	const canvas = new Canvas(width, rows + 1);
	const hit: Array<Array<string | undefined>> = Array.from({ length: rows + 1 }, () => new Array<string | undefined>(width).fill(undefined));
	const byId = new Map(nodes.map((node) => [node.id, node]));
	const color = (node: VizNode): string => roleColor(node.role);

	// One shared time axis: column c covers (tc(c-1), tc(c)], the last column is
	// "now". Only agents live NOW get a lane; ended agents are not drawn at all,
	// so their labels/ticks can never be compacted onto a surviving row. Every
	// lane's head sits at the same "now" column, so all lanes scroll in sync.
	const colOf = (t: number): number => Math.floor((t - (now - windowMs)) / dt - 1e-9);
	const cells = new Map<string, { ch: string; color: string; owner: string }>();
	let owner = "";
	// Spawn ticks on the header rule for root-spawned live lanes (first sibling owns it).
	const headerTicks = new Map<number, { color: string; owner: string }>();
	const put = (c: number, r: number, ch: string, col: string, by: string = owner): void => {
		if (c < 0 || c >= AW || r < 0 || r >= rows) return;
		cells.set(`${c},${r}`, { ch, color: col, owner: by });
	};
	for (const [id, r] of current.lanes) {
		const node = byId.get(id)!;
		owner = id;
		const col = color(node);
		const start = colOf(node.startedAt);
		const c0 = Math.max(0, start);
		for (let c = c0; c < AW; c++) put(c, r, "━", col);
		if (start < 0) { put(0, r, "┄", col); continue; }
		// Fork tick: join the nearest shown live ancestor's lane; otherwise a plain start cap.
		let parent = node.parentId ? byId.get(node.parentId) : undefined;
		let p: number | undefined;
		while (parent && isAgent(parent) && p === undefined) {
			p = current.lanes.get(parent.id);
			parent = parent.parentId ? byId.get(parent.parentId) : undefined;
		}
		if (p === r) { put(start, r, "╺", col); continue; }
		// No visible ancestor lane: the child was spawned from the root, whose
		// implicit trunk is the header rule (row -1). Siblings forking at the same
		// x share one vertical: an earlier sibling's ╰ becomes ├ when a later
		// sibling's connector passes through it.
		const from = p ?? -1;
		put(start, r, from < r ? "╰" : "╭", col);
		for (let y = Math.min(from, r) + 1; y < Math.max(from, r); y++) {
			const cell = cells.get(`${start},${y}`);
			if (!cell) put(start, y, "│", col);
			else if (cell.ch === "━") cell.ch = "┿"; // crossing another lane: that lane keeps the cell
			else if (cell.ch === "╰" && from < r) cell.ch = "├";
			else if (cell.ch === "╭" && from > r) cell.ch = "├";
		}
		if (from < 0) { if (!headerTicks.has(start)) headerTicks.set(start, { color: col, owner: id }); continue; }
		const pc = cells.get(`${start},${from}`);
		// The branch point is part of the child's fork, so clicking it opens the child.
		if (pc && pc.ch === "━") put(start, from, from < r ? "┳" : "┻", pc.color);
	}

	// Header: plain rule; the only glyphs on it are ┬ spawn ticks of live root-spawned lanes.
	const y0 = 1;
	for (let x = 0; x < width; x++) canvas.set(x, 0, "─", "borderMuted");
	for (let r = 0; r < rows; r++) for (let c = 0; c < AW; c++) canvas.set(LX + c, y0 + r, "·", "borderMuted");
	for (const [key, cell] of cells) {
		const [c, r] = key.split(",").map(Number) as [number, number];
		canvas.set(LX + c, y0 + r, cell.ch, cell.color);
		hit[y0 + r]![LX + c] = cell.owner;
	}

	const live = current.total;
	const above = current.offset > 0;
	const below = current.offset + rows < live;
	const rateText = formatRate(input.rate);
	const winLabel = ` −${Math.max(1, Math.round(windowMs / 60000))}m `;
	canvas.text(LX + 1, 0, winLabel, "dim");
	const range = above || below ? ` · ${scrollIndicator(current.offset, rows, live)} ${above ? "▲" : " "}${below ? "▼" : " "}` : "";
	const header = portrait
		? ` ${live} live${range} · ${rateText} `
		: ` legion ${live} live${range} · ${rateText} `;
	const headerX = Math.max(LX + 1 + winLabel.length, width - header.length - 1);
	canvas.text(headerX, 0, header, "accent", { bold: true, maxX: width - 1 });
	if (input.hint) {
		// Between the window label and the summary, with a rule gap on both sides.
		const hx = LX + 1 + winLabel.length + 1;
		const room = headerX - 1 - hx;
		const pick = [input.hint, input.hintShort].find((text) => text && Array.from(text).length + 2 <= room);
		if (pick) canvas.text(hx, 0, ` ${pick} `, "dim");
	}
	for (const [c, tick] of headerTicks) {
		if (canvas.get(LX + c, 0)?.ch !== "─") continue; // never draw over header text
		canvas.set(LX + c, 0, "┬", tick.color);
		hit[0]![LX + c] = tick.owner;
	}

	const nameX = LX + AW;
	current.shown.forEach((node, i) => {
		const y = y0 + i;
		const col = color(node);
		canvas.set(nameX, y, "▶", col, { bold: true });
		for (let x = nameX; x < width; x++) hit[y]![x] = node.id;
		// Scroll hints at the right edge: ▲ on the top lane, ▼ on the bottom lane.
		const overflow = i === 0 && above ? " ▲" : i === rows - 1 && below ? " ▼" : "";
		const avail = width - (nameX + 2) - overflow.length;
		if (portrait) {
			canvas.text(nameX + 2, y, ellipsize(node.name, avail), col, { bold: true });
		} else {
			const longest = Math.max(...current.shown.map((n) => Array.from(n.name).length));
			const nameW = Math.min(16, longest, Math.max(6, avail - 8));
			canvas.text(nameX + 2, y, ellipsize(node.name, nameW), col, { bold: true });
			const room = Math.max(0, avail - nameW - 1);
			const full = `${node.role} · ${formatDuration(now - node.startedAt)}`;
			const detail = ellipsize(Array.from(full).length <= room ? full : formatDuration(now - node.startedAt), room);
			canvas.text(nameX + 3 + nameW, y, detail, "dim");
		}
		if (overflow) canvas.text(width - overflow.length, y, overflow, "text", { bold: true });
	});

	return {
		canvas,
		nodeIdsByRow: [undefined, ...current.shown.map((node) => node.id)],
		hit,
		shown: current.shown,
		hidden: current.hidden,
		offset: current.offset,
		total: current.total,
		maxLanes,
	};
}

export function railwayLines(input: RailInput, theme: VizTheme): {
	lines: string[];
	nodeIdsByRow: Array<string | undefined>;
	hitAt: (x: number, y: number) => string | undefined;
	/** Resolved window (undefined when hidden); total > maxLanes means scrollable. */
	window?: { offset: number; total: number; maxLanes: number; topId?: string };
} {
	const rendered = renderRailway(input);
	if (!rendered) return { lines: [], nodeIdsByRow: [], hitAt: () => undefined };
	const { hit } = rendered;
	return {
		lines: rendered.canvas.toLines(theme),
		nodeIdsByRow: rendered.nodeIdsByRow,
		hitAt: (x, y) => hit[y]?.[x],
		window: { offset: rendered.offset, total: rendered.total, maxLanes: rendered.maxLanes, topId: rendered.shown[0]?.id },
	};
}
