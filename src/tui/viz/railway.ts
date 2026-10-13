/**
 * Above-input "railway" strip: one git-graph lane per live subagent.
 *
 * Lanes are recomputed for every time column from the agents alive at that
 * instant (oldest first, then shallowest), so when an agent ends its row is
 * reclaimed and the lanes below shift up — no empty rows are ever kept.
 * The strip is hidden entirely when no subagent is live.
 */

import { Canvas, ellipsize } from "./canvas.ts";
import { formatCount, formatDuration, isAgent, type VizNode } from "./model.ts";
import { roleToken, type VizTheme } from "./palette.ts";

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

const BOX: Record<string, string> = {
	LR: "━", UD: "│", LU: "╯", LD: "╮", RU: "╰", RD: "╭", LRU: "┴", LRD: "┬", LUD: "┤", RUD: "├",
	LRUD: "┼", R: "╶", L: "╴", U: "╵", D: "╷",
};

function boxKey(dirs: Set<string>): string {
	return ["L", "R", "U", "D"].filter((d) => dirs.has(d)).join("");
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
	const color = (node: VizNode): string => roleToken(node.role);

	// rowsAt[c+1] = lane map at column c (c = -1 is the column before the window).
	const rowsAt: Array<Map<string, number>> = [];
	for (let c = -1; c < AW; c++) rowsAt.push(c === AW - 1 ? current.lanes : assignLanes(nodes, tc(c), rows).lanes);
	const RA = (c: number): Map<string, number> => rowsAt[c + 1] ?? new Map();

	type Mark = { c: number; r: number; kind: "fork" | "merge" | "fail" | "enter"; color: string };
	const cells = new Map<string, { dirs: Set<string>; color?: string }>();
	const marks: Mark[] = [];
	const add = (c: number, r: number, dirs: string[], col?: string): void => {
		if (c < 0 || c >= AW || r < 0 || r >= rows) return;
		const key = `${c},${r}`;
		const cell = cells.get(key) ?? { dirs: new Set<string>() };
		for (const d of dirs) cell.dirs.add(d);
		if (col) cell.color = col;
		cells.set(key, cell);
	};
	const vert = (c: number, a: number, b: number, col: string): void => {
		for (let r = Math.min(a, b) + 1; r < Math.max(a, b); r++) add(c, r, ["U", "D"], col);
	};
	const parentRow = (node: VizNode, c: number): number => {
		let parent = node.parentId ? byId.get(node.parentId) : undefined;
		while (parent && isAgent(parent)) {
			const row = RA(c).get(parent.id);
			if (row !== undefined) return row;
			parent = parent.parentId ? byId.get(parent.parentId) : undefined;
		}
		return -1;
	};
	const joinParent = (c: number, row: number, node: VizNode, kind: "fork" | "merge"): void => {
		const col = color(node);
		const p = parentRow(node, c);
		add(c, row, ["U"], col);
		vert(c, p, row, col);
		if (p >= 0) add(c, p, [kind === "fork" ? "D" : "U"]);
		else marks.push({ c, r: -1, kind, color: col });
	};

	for (let c = 0; c < AW; c++) {
		const prev = RA(c - 1);
		const cur = RA(c);
		const t0 = tc(c - 1);
		const t1 = tc(c);
		for (const [id, r] of cur) {
			const node = byId.get(id)!;
			const col = color(node);
			const rp = prev.get(id);
			if (rp !== undefined) {
				add(c - 1, rp, ["R"], col);
				if (rp === r) add(c, r, ["L"], col);
				else {
					add(c, rp, ["L", "U"], col);
					vert(c, rp, r, col);
					add(c, r, ["D"], col);
				}
			} else if (node.startedAt > t0 && node.startedAt <= t1) {
				add(c, r, [], col);
				joinParent(c, r, node, "fork");
				cells.get(`${c},${r}`)?.dirs.add("R");
			} else {
				add(c, r, [], col);
				marks.push({ c, r, kind: "enter", color: col });
			}
		}
		for (const [id, rp] of prev) {
			if (cur.has(id)) continue;
			const node = byId.get(id)!;
			const col = color(node);
			add(c - 1, rp, ["R"], col);
			if (node.status === "failed" && endOf(node) <= t1) marks.push({ c, r: rp, kind: "fail", color: "error" });
			else if (endOf(node) <= t1) {
				add(c, rp, ["L"], col);
				joinParent(c, rp, node, "merge");
			}
			// Otherwise it was pushed out of the shown lanes by priority; the lane just stops.
		}
	}

	// Live lanes run into the name column at "now".
	for (const [, r] of current.lanes) add(AW - 1, r, ["R"]);

	// Header: trunk line with window label and live summary.
	const y0 = 1;
	for (let x = 0; x < width; x++) canvas.set(x, 0, "─", "borderMuted");
	for (let r = 0; r < rows; r++) for (let c = 0; c < AW; c++) canvas.set(LX + c, y0 + r, "·", "borderMuted");
	for (const [key, cell] of cells) {
		const [c, r] = key.split(",").map(Number) as [number, number];
		const ch = BOX[boxKey(cell.dirs)];
		if (ch) canvas.set(LX + c, y0 + r, ch, cell.color ?? "borderMuted");
		else canvas.set(LX + c, y0 + r, "━", cell.color ?? "borderMuted");
	}
	for (const mark of marks) {
		if (mark.r === -1) canvas.set(LX + mark.c, 0, mark.kind === "fork" ? "┬" : "┴", mark.color);
		else if (mark.kind === "fail") canvas.set(LX + mark.c, y0 + mark.r, "✗", "error", { bold: true });
		else if (mark.kind === "enter") {
			const ch = canvas.get(LX + mark.c, y0 + mark.r)?.ch;
			if (ch === "·" || ch === "╴" || ch === "━") canvas.set(LX + mark.c, y0 + mark.r, "┄", mark.color);
		}
	}
	// Inline lane labels on long straight runs (wide only).
	if (!portrait) {
		for (let r = 0; r < rows; r++) {
			let c = 0;
			while (c < AW) {
				const entry = [...RA(c)].find(([, row]) => row === r);
				if (!entry) { c++; continue; }
				const [id] = entry;
				let e = c;
				while (e + 1 < AW && RA(e + 1).get(id) === r) e++;
				const node = byId.get(id)!;
				const label = ` ${node.name} `;
				if (e - c - 2 >= label.length + 2 && e < AW - 1) {
					let ok = true;
					for (let i = 0; i < label.length; i++) if (canvas.get(LX + c + 2 + i, y0 + r)?.ch !== "━") ok = false;
					if (ok) canvas.text(LX + c + 2, y0 + r, label, color(node), { bold: true });
				}
				c = e + 1;
			}
		}
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
