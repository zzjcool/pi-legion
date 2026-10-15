/**
 * Above-input "railway" strip: one git-graph lane per live subagent.
 *
 * Only agents live now get a lane (oldest first, then shallowest), drawn on a
 * single shared time axis that ends at "now". When an agent ends its lane and
 * label disappear and the rows below shift up — no empty rows are ever kept.
 * The strip is hidden entirely when no subagent is live. A spawn fork that
 * slides off the left stays pinned there until that agent ends, so the parent
 * vertical remains traceable.
 */

import { formatAgentElapsed, formatActivityAgo } from "../status.ts";
import { Canvas, ellipsize } from "./canvas.ts";
import { formatCount, isAgent, type VizNode } from "./model.ts";
import { roleColor, type VizTheme } from "./palette.ts";

export const RAIL_MAX_LANES = 4;
export const RAIL_MAX_LANES_NARROW = 3;
export const RAIL_NARROW_COLS = 80;
export const RAIL_WINDOW_MS = 6 * 60 * 1000;

/**
 * Map a timestamp onto the shared railway axis.
 *
 * Using `floor(t/dt) - floor(origin/dt) - 1` (instead of `floor((t-origin)/dt)`)
 * keeps every live lane's glyphs shifting by the exact same column count when
 * the window slides — required for "all lanes scroll left in sync".
 * The trailing `- 1` places `now` on the last drawable column (`axisWidth - 1`).
 */
export function axisColumn(t: number, now: number, windowMs: number, axisWidth: number): number {
	if (axisWidth <= 0 || windowMs <= 0) return 0;
	const dt = windowMs / axisWidth;
	const originCol = Math.floor((now - windowMs) / dt);
	return Math.floor(t / dt) - originCol - 1;
}


export interface RailInput {
	nodes: readonly VizNode[];
	now: number;
	width: number;
	/** Header "now" tok/s (live agents only; 0 when none running). */
	rate: number;
	windowMs?: number;
	/** Lane scroll position when more agents are live than lanes fit. */
	scroll?: RailScroll;
	/** Dim hint on the header rule (e.g. `/legion stop` while children are live). */
	hint?: string;
	/** Shorter variant used when the full hint does not fit; truncated further under squeeze. */
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


/**
 * Wide-lane detail after the name: role, optional turn/lifetime clocks (only
 * from turn ≥2), and last-activity age. Round-1 hides both current-turn and
 * lifetime clocks (#159).
 */
export function formatRailLaneDetail(node: VizNode, now: number): string {
	const parts: string[] = [node.role];
	if ((node.turns ?? 0) >= 2) {
		parts.push(formatAgentElapsed({
			state: node.status,
			startedAt: node.startedAt,
			...(node.endedAt !== undefined ? { finishedAt: node.endedAt } : {}),
			...(node.currentTurnStartedAt !== undefined ? { currentTurnStartedAt: node.currentTurnStartedAt } : {}),
			...(node.currentTurnEndedAt !== undefined ? { currentTurnEndedAt: node.currentTurnEndedAt } : {}),
		}, now));
	}
	parts.push(formatActivityAgo(node.lastActivityAt, now));
	return parts.join(" · ");
}

/** Pick the richest lane detail that fits `room` (role → clocks → ago). */
export function fitRailLaneDetail(node: VizNode, now: number, room: number): string {
	if (room <= 0) return "";
	const ago = formatActivityAgo(node.lastActivityAt, now);
	const clocks = (node.turns ?? 0) >= 2
		? formatAgentElapsed({
			state: node.status,
			startedAt: node.startedAt,
			...(node.endedAt !== undefined ? { finishedAt: node.endedAt } : {}),
			...(node.currentTurnStartedAt !== undefined ? { currentTurnStartedAt: node.currentTurnStartedAt } : {}),
			...(node.currentTurnEndedAt !== undefined ? { currentTurnEndedAt: node.currentTurnEndedAt } : {}),
		}, now)
		: undefined;
	const candidates = [
		clocks ? `${node.role} · ${clocks} · ${ago}` : `${node.role} · ${ago}`,
		...(clocks ? [`${clocks} · ${ago}`, clocks] : []),
		ago,
	];
	for (const candidate of candidates) {
		if (Array.from(candidate).length <= room) return candidate;
	}
	return ellipsize(ago, room);
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
	const canvas = new Canvas(width, rows + 1);
	const hit: Array<Array<string | undefined>> = Array.from({ length: rows + 1 }, () => new Array<string | undefined>(width).fill(undefined));
	const byId = new Map(nodes.map((node) => [node.id, node]));
	const color = (node: VizNode): string => roleColor(node.role);

	// One shared time axis. Absolute column math (floor(t/dt) − floor(origin/dt))
	// makes every lane shift by the *same* integer when `now` advances; the older
	// floor((t − origin)/dt) form crossed quantization boundaries per-lane and
	// looked like independent scrolling. "now" always lands on the last drawable
	// column; only agents live NOW get a lane (ended ones vanish and rows compact).
	const colOf = (t: number): number => axisColumn(t, now, windowMs, AW);
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
		// Fork tick: join the nearest shown live ancestor's lane; otherwise the
		// root trunk (header). When the spawn column has scrolled off the left,
		// pin the fork to column 0 so a live child keeps its parent vertical,
		// even if the parent lane itself has left the window. The lane body
		// still ends at "now" and keeps scrolling; ended agents have no lane.
		const forkX = Math.max(0, start);
		let parent = node.parentId ? byId.get(node.parentId) : undefined;
		let p: number | undefined;
		while (parent && isAgent(parent) && p === undefined) {
			p = current.lanes.get(parent.id);
			parent = parent.parentId ? byId.get(parent.parentId) : undefined;
		}
		if (p === r) { put(forkX, r, start < 0 ? "┄" : "╺", col); continue; }
		// No visible ancestor lane: the child was spawned from the root, whose
		// implicit trunk is the header rule (row -1). Siblings forking at the same
		// x share one vertical: an earlier sibling's ╰ becomes ├ when a later
		// sibling's connector passes through it. A ┄ continuation (spawn already
		// off-screen, no fork of its own) joins the same way a ━ lane does.
		const from = p ?? -1;
		put(forkX, r, from < r ? "╰" : "╭", col);
		for (let y = Math.min(from, r) + 1; y < Math.max(from, r); y++) {
			const cell = cells.get(`${forkX},${y}`);
			if (!cell) put(forkX, y, "│", col);
			else if (cell.ch === "━" || cell.ch === "┄") cell.ch = "┿"; // crossing another lane: that lane keeps the cell
			else if (cell.ch === "╰" && from < r) cell.ch = "├";
			else if (cell.ch === "╭" && from > r) cell.ch = "├";
		}
		if (from < 0) { if (!headerTicks.has(forkX)) headerTicks.set(forkX, { color: col, owner: id }); continue; }
		const pc = cells.get(`${forkX},${from}`);
		// The branch point is part of the child's fork, so clicking it opens the child.
		// A parent that itself starts on this column (╰/╭, including a fork pinned to
		// the left edge) grows a downward arm so the vertical actually meets the child.
		if (pc && (pc.ch === "━" || pc.ch === "┄")) put(forkX, from, from < r ? "┳" : "┻", pc.color);
		else if (pc && pc.ch === "╰" && from < r) pc.ch = "├";
		else if (pc && pc.ch === "╭" && from > r) pc.ch = "├";
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
	const headerFull = portrait
		? ` ${live} live${range} · ${rateText} `
		: ` legion ${live} live${range} · ${rateText} `;
	// Hint sits between the window label and the right-hand summary. Prefer the
	// full string, then short; when width squeezes, shrink the summary so the
	// short `/legion stop` still fits, and only then ellipsize the hint.
	const labelEnd = LX + 1 + winLabel.length;
	const hx = labelEnd + 1;
	let header = headerFull;
	let headerX = Math.max(labelEnd, width - Array.from(header).length - 1);
	let hintPick: string | undefined;
	if (input.hint) {
		const short = input.hintShort ?? input.hint;
		const shortBlock = Array.from(short).length + 2; // leading+trailing spaces
		const gap = 1; // rule cell between hint and summary
		const needHeaderX = hx + shortBlock + gap;
		if (headerX < needHeaderX) {
			// Pull/truncate the summary so short hint keeps a slot.
			headerX = Math.min(width - 1, Math.max(needHeaderX, labelEnd));
			const avail = Math.max(0, width - 1 - headerX);
			header = avail >= 3 ? ` ${ellipsize(headerFull.trim(), avail - 2)} ` : "";
			if (header) headerX = Math.max(labelEnd, width - Array.from(header).length - 1);
			// Re-assert short reservation if summary still crowds the hint.
			if (header && headerX < needHeaderX) {
				headerX = needHeaderX;
				const clipped = Math.max(0, width - 1 - headerX);
				header = clipped >= 3 ? ` ${ellipsize(headerFull.trim(), clipped - 2)} ` : "";
			}
		}
		const room = Math.max(0, (header ? headerX - 1 : width - 1) - hx);
		hintPick = [input.hint, input.hintShort].find((text) => text && Array.from(text).length + 2 <= room);
		if (!hintPick && room >= 3) hintPick = ellipsize(short, room - 2);
	}
	if (header) canvas.text(headerX, 0, header, "accent", { bold: true, maxX: width - 1 });
	if (hintPick) canvas.text(hx, 0, ` ${hintPick} `, "dim");
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
			const ago = formatActivityAgo(node.lastActivityAt, now);
			const label = ago === "—" ? node.name : `${node.name} · ${ago}`;
			canvas.text(nameX + 2, y, ellipsize(label, avail), col, { bold: true });
		} else {
			const longest = Math.max(...current.shown.map((n) => Array.from(n.name).length));
			const nameW = Math.min(16, longest, Math.max(6, avail - 8));
			canvas.text(nameX + 2, y, ellipsize(node.name, nameW), col, { bold: true });
			const room = Math.max(0, avail - nameW - 1);
			const detail = fitRailLaneDetail(node, now, room);
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
