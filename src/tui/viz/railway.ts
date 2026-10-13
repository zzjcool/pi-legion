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
}

export interface RailRender {
	canvas: Canvas;
	/** Node id rendered on each output row (undefined for the header). */
	nodeIdsByRow: Array<string | undefined>;
	shown: VizNode[];
	hidden: VizNode[];
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
 * Lane assignment with compaction: the first `maxLanes` live agents get rows
 * 0..k-1 in priority order; the rest are folded into the `+N` overflow.
 */
export function assignLanes(nodes: readonly VizNode[], t: number, maxLanes: number): {
	lanes: Map<string, number>;
	shown: VizNode[];
	hidden: VizNode[];
} {
	const live = liveAt(nodes, t);
	const shown = live.slice(0, Math.max(0, maxLanes));
	return { lanes: new Map(shown.map((node, index) => [node.id, index])), shown, hidden: live.slice(shown.length) };
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
	const current = assignLanes(nodes, now, maxLanes);
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
	const byId = new Map(nodes.map((node) => [node.id, node]));
	const color = (node: VizNode): string => roleColor(node.role);

	// One shared time axis: column c covers (tc(c-1), tc(c)], the last column is
	// "now". Only agents live NOW get a lane; ended agents are not drawn at all,
	// so their labels/ticks can never be compacted onto a surviving row. Every
	// lane's head sits at the same "now" column, so all lanes scroll in sync.
	const colOf = (t: number): number => Math.floor((t - (now - windowMs)) / dt - 1e-9);
	const cells = new Map<string, { ch: string; color: string }>();
	const put = (c: number, r: number, ch: string, col: string): void => {
		if (c < 0 || c >= AW || r < 0 || r >= rows) return;
		cells.set(`${c},${r}`, { ch, color: col });
	};
	for (const [id, r] of current.lanes) {
		const node = byId.get(id)!;
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
		if (p === undefined || p === r) { put(start, r, "╺", col); continue; }
		put(start, r, p < r ? "╰" : "╭", col);
		for (let y = Math.min(p, r) + 1; y < Math.max(p, r); y++) if (!cells.has(`${start},${y}`)) put(start, y, "│", col);
		const pc = cells.get(`${start},${p}`);
		if (pc && pc.ch === "━") put(start, p, p < r ? "┳" : "┻", pc.color);
	}

	// Header: plain rule (no lane glyphs ever drawn on it).
	const y0 = 1;
	for (let x = 0; x < width; x++) canvas.set(x, 0, "─", "borderMuted");
	for (let r = 0; r < rows; r++) for (let c = 0; c < AW; c++) canvas.set(LX + c, y0 + r, "·", "borderMuted");
	for (const [key, cell] of cells) {
		const [c, r] = key.split(",").map(Number) as [number, number];
		canvas.set(LX + c, y0 + r, cell.ch, cell.color);
	}

	const live = current.shown.length + current.hidden.length;
	const rateText = formatRate(input.rate);
	const winLabel = ` −${Math.max(1, Math.round(windowMs / 60000))}m `;
	canvas.text(LX + 1, 0, winLabel, "dim");
	const header = portrait
		? ` ${live} live · ${rateText} `
		: ` legion ${live} live · ${rateText} `;
	canvas.text(Math.max(LX + 1 + winLabel.length, width - header.length - 1), 0, header, "accent", { bold: true, maxX: width - 1 });

	const nameX = LX + AW;
	current.shown.forEach((node, i) => {
		const y = y0 + i;
		const col = color(node);
		canvas.set(nameX, y, "▶", col, { bold: true });
		const overflow = i === rows - 1 && current.hidden.length > 0 ? ` +${current.hidden.length}` : "";
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
		shown: current.shown,
		hidden: current.hidden,
	};
}

export function railwayLines(input: RailInput, theme: VizTheme): { lines: string[]; nodeIdsByRow: Array<string | undefined> } {
	const rendered = renderRailway(input);
	if (!rendered) return { lines: [], nodeIdsByRow: [] };
	return { lines: rendered.canvas.toLines(theme), nodeIdsByRow: rendered.nodeIdsByRow };
}
