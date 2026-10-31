/** Panel renderers for the /legion full view. All drawing is clipped to its rect. */

import { Canvas, cellWidth, ellipsize } from "./canvas.ts";
import type { Rect } from "./layout.ts";
import { formatCount, formatDuration, isAgent, type VizNode, type VizStatus } from "./model.ts";
import { nodeToken, roleColor } from "./palette.ts";
import type { RateSampler, RateSeries } from "./rate.ts";
import { visibleRateNodeIds } from "./rate.ts";
import { breakdown } from "../../shared/timing-breakdown.ts";

export type Pane = "galaxy" | "chart" | "timing" | "log" | "status";

export interface ViewData {
	nodes: readonly VizNode[];
	sampler: RateSampler;
	now: number;
	/** Header tok/s (live agents only; 0 when none running). Chart avg/buckets keep full-series windows. */
	rate: number;
}

export function frame(cv: Canvas, r: Rect, title: string, focused: boolean, hint?: string): Rect {
	if (r.w < 4 || r.h < 3) return { x: r.x, y: r.y, w: Math.max(0, r.w), h: Math.max(0, r.h) };
	const col = focused ? "borderAccent" : "borderMuted";
	const [tl, tr, bl, br, hz, vt] = focused ? ["┏", "┓", "┗", "┛", "━", "┃"] : ["╭", "╮", "╰", "╯", "─", "│"];
	const maxX = r.x + r.w;
	cv.text(r.x, r.y, tl + hz.repeat(r.w - 2) + tr, col, { maxX });
	cv.text(r.x, r.y + r.h - 1, bl + hz.repeat(r.w - 2) + br, col, { maxX });
	for (let j = 1; j < r.h - 1; j++) {
		cv.set(r.x, r.y + j, vt, col);
		cv.set(r.x + r.w - 1, r.y + j, vt, col);
	}
	const titleText = ` ${ellipsize(title, Math.max(0, r.w - 6))} `;
	const after = cv.text(r.x + 2, r.y, titleText, focused ? "borderAccent" : "accent", { bold: true, maxX: maxX - 1 });
	if (hint) {
		const h = ` ${hint} `;
		const hx = r.x + r.w - h.length - 2;
		if (hx > after + 1) cv.text(hx, r.y, h, "dim", { maxX: maxX - 1 });
	}
	return { x: r.x + 1, y: r.y + 1, w: r.w - 2, h: r.h - 2 };
}

export function childrenMap(nodes: readonly VizNode[]): Map<string | null, VizNode[]> {
	const map = new Map<string | null, VizNode[]>();
	for (const node of nodes) {
		const key = node.parentId;
		const list = map.get(key) ?? [];
		list.push(node);
		map.set(key, list);
	}
	for (const list of map.values()) list.sort((a, b) => a.startedAt - b.startedAt || a.name.localeCompare(b.name));
	return map;
}

/** Depth-first order (roots first), used for keyboard navigation. */
export function dfsOrder(nodes: readonly VizNode[]): VizNode[] {
	const kids = childrenMap(nodes);
	const out: VizNode[] = [];
	const visit = (node: VizNode, guard: Set<string>): void => {
		if (guard.has(node.id)) return;
		guard.add(node.id);
		out.push(node);
		for (const child of kids.get(node.id) ?? []) visit(child, guard);
	};
	const guard = new Set<string>();
	for (const root of kids.get(null) ?? []) visit(root, guard);
	for (const node of nodes) if (!guard.has(node.id)) visit(node, guard);
	return out;
}

// ---------------------------------------------------------------- galaxy

const BRAILLE_BITS = [[0x1, 0x8], [0x2, 0x10], [0x4, 0x20], [0x40, 0x80]] as const;

export function drawGalaxy(cv: Canvas, r: Rect, data: ViewData, selectedId: string | undefined): void {
	if (r.w < 6 || r.h < 3) return;
	const legendRows = 1;
	const CW = r.w;
	const CH = r.h - legendRows;
	const PW = CW * 2;
	const PH = CH * 4;
	const px = Array.from({ length: CH }, () => Array.from({ length: CW }, () => ({ m: 0, col: "", z: -1 })));
	const dot = (x: number, y: number, col: string, z: number): void => {
		const ix = Math.round(x);
		const iy = Math.round(y);
		if (ix < 0 || iy < 0 || ix >= PW || iy >= PH) return;
		const cell = px[iy >> 2]![ix >> 1]!;
		cell.m |= BRAILLE_BITS[iy & 3]![ix & 1]!;
		if (z >= cell.z) {
			cell.z = z;
			cell.col = col;
		}
	};
	let seed = 99;
	const rnd = (): number => (seed = (seed * 16807) % 2147483647) / 2147483647;
	for (let i = 0; i < (CW * CH) / 12; i++) dot(rnd() * PW, rnd() * PH, "borderMuted", 0);

	const nodes = data.nodes;
	if (!nodes.some(isAgent)) {
		const msg = "no subagents yet";
		cv.text(r.x + Math.max(0, Math.floor((r.w - msg.length) / 2)), r.y + Math.floor(r.h / 2) + 2, ellipsize(msg, r.w), "dim");
	}
	const kids = childrenMap(nodes);
	const roots = kids.get(null) ?? [];
	const virtualRoot: VizNode | undefined = roots.length === 1 ? undefined : {
		id: "\u0000center", name: "legion", role: "centurion", parentId: null, depth: 0, status: "running", startedAt: data.now, tokens: 0, tokensOut: 0, generationMs: 0,
	};
	const childrenOf = (node: VizNode): VizNode[] => node === virtualRoot ? roots : kids.get(node.id) ?? [];
	const center = virtualRoot ?? roots[0]!;
	if (!center) return;
	const leafMemo = new Map<string, number>();
	const leaves = (node: VizNode, guard = new Set<string>()): number => {
		if (leafMemo.has(node.id)) return leafMemo.get(node.id)!;
		if (guard.has(node.id)) return 1;
		guard.add(node.id);
		const children = childrenOf(node);
		const value = children.length ? children.reduce((sum, child) => sum + leaves(child, guard), 0) : 1;
		leafMemo.set(node.id, value);
		return value;
	};
	let maxRel = 1;
	const rel = new Map<string, number>();
	(function depth(node: VizNode, d: number, guard: Set<string>): void {
		if (guard.has(node.id)) return;
		guard.add(node.id);
		rel.set(node.id, d);
		maxRel = Math.max(maxRel, d);
		for (const child of childrenOf(node)) depth(child, d + 1, guard);
	})(center, 0, new Set());
	const cx = PW / 2;
	const cy = PH / 2;
	const RY = Math.max(2, PH / 2 - 3);
	const RX = Math.max(2, PW / 2 - 6);
	const pos = new Map<string, [number, number]>();
	(function lay(node: VizNode, a0: number, a1: number, guard: Set<string>): void {
		if (guard.has(node.id)) return;
		guard.add(node.id);
		const a = (a0 + a1) / 2;
		const d = rel.get(node.id) ?? 0;
		const k = Math.pow(d / maxRel, 0.85);
		pos.set(node.id, [cx + Math.cos(a) * RX * k, cy + Math.sin(a) * RY * k]);
		let start = a0;
		const total = leaves(node);
		for (const child of childrenOf(node)) {
			const span = ((a1 - a0) * leaves(child)) / total;
			lay(child, start, start + span, guard);
			start += span;
		}
	})(center, -Math.PI / 2, Math.PI * 1.5, new Set());

	for (let d = 1; d <= maxRel; d++) {
		const k = Math.pow(d / maxRel, 0.85);
		for (let a = 0; a < Math.PI * 2; a += 0.02) if (Math.floor(a * 60) % 4 === 0) dot(cx + Math.cos(a) * RX * k, cy + Math.sin(a) * RY * k, "borderMuted", 0);
	}
	const all = virtualRoot ? [virtualRoot, ...nodes] : [...nodes];
	for (const node of all) {
		const parentId = node === virtualRoot ? undefined : node.parentId ?? (virtualRoot ? virtualRoot.id : undefined);
		if (!parentId) continue;
		const a = pos.get(parentId);
		const b = pos.get(node.id);
		if (!a || !b) continue;
		const dist = Math.hypot(b[0] - a[0], b[1] - a[1]);
		const col = node.status === "running" ? roleColor(node.role) : node.status === "failed" ? "error" : "borderMuted";
		for (let t = 0; t < dist; t += 1.7) dot(a[0] + ((b[0] - a[0]) * t) / dist, a[1] + ((b[1] - a[1]) * t) / dist, col, 1);
	}
	const maxTokens = Math.max(1, ...nodes.map((node) => node.tokens));
	const radii = new Map<string, number>();
	for (const node of all) {
		const p = pos.get(node.id);
		if (!p) continue;
		const [x, y] = p;
		const isCenter = node === center;
		const col = isCenter ? roleColor(node.role) : nodeToken(node);
		let rad = isCenter ? Math.max(2, Math.min(5, PH / 14)) : Math.max(node.status === "failed" ? 1.5 : 0.8, 0.8 + Math.sqrt(node.tokens / maxTokens) * Math.min(4, PH / 16));
		radii.set(node.id, rad);
		if (node.status === "running" && !isCenter) {
			const act = Math.min(1, data.sampler.nodeRate(node.id, data.now) / 250);
			for (let i = 0; i < 12 + rad * 6; i++) {
				const a = rnd() * Math.PI * 2;
				const d = rad + 1.5 + rnd() * (2 + act * 3);
				dot(x + Math.cos(a) * d, y + Math.sin(a) * d, col, 2);
			}
		}
		if (isCenter) {
			for (let i = 0; i < 60; i++) {
				const a = rnd() * Math.PI * 2;
				const d = rad + 1.5 + Math.pow(rnd(), 2) * 6;
				dot(x + Math.cos(a) * d * 1.6, y + Math.sin(a) * d, col, 2);
			}
		}
		const xs = isCenter ? 1.6 : 1;
		for (let yy = -Math.ceil(rad); yy <= Math.ceil(rad); yy++) {
			for (let xx = -Math.ceil(rad * xs); xx <= Math.ceil(rad * xs); xx++) {
				if (Math.hypot(xx / xs, yy) <= rad) dot(x + xx, y + yy, col, 3);
			}
		}
		if (node.id === selectedId) {
			rad += 3;
			for (let a = 0; a < Math.PI * 2; a += 0.12) dot(x + Math.cos(a) * rad * xs, y + Math.sin(a) * rad, "text", 5);
		}
	}
	for (let j = 0; j < CH; j++) {
		for (let i = 0; i < CW; i++) {
			const cell = px[j]![i]!;
			if (cell.m) cv.set(r.x + i, r.y + j, String.fromCharCode(0x2800 + cell.m), cell.col);
		}
	}
	// Labels: selected, center, depth-1 live, failed, and the heaviest running agents.
	const running = nodes.filter((node) => node.status === "running" && isAgent(node)).map((node) => node.tokens).sort((a, b) => b - a);
	const heavy = running[Math.min(running.length - 1, 4)] ?? Number.POSITIVE_INFINITY;
	const candidates = all.filter((node) =>
		node.id === selectedId || node === center || node.status === "failed" ||
		((rel.get(node.id) ?? 9) <= 1 && node.status !== "retired") ||
		(node.status === "running" && node.tokens >= heavy),
	).sort((a, b) =>
		Number(b.id === selectedId) - Number(a.id === selectedId) ||
		Number(b === center) - Number(a === center) ||
		b.tokens - a.tokens,
	);
	const occupied: Array<{ x: number; y: number; w: number }> = [];
	const free = (x: number, y: number, w: number): boolean =>
		x >= r.x && x + w <= r.x + r.w && y >= r.y && y < r.y + CH &&
		!occupied.some((o) => o.y === y && x < o.x + o.w + 1 && o.x < x + w + 1);
	for (const node of candidates) {
		const p = pos.get(node.id);
		if (!p) continue;
		const lx = r.x + Math.round(p[0] / 2);
		const ly = r.y + Math.round(p[1] / 4);
		const label = ellipsize(node.name + (node.status === "failed" ? " ✗" : ""), Math.max(4, Math.floor(r.w / 3)));
		const len = Array.from(label).length;
		const rw = Math.ceil((radii.get(node.id) ?? 1) * (node === center ? 1.6 : 1) / 2) + (node.id === selectedId ? 3 : 1);
		const right = p[0] >= cx - 4;
		let placed = false;
		for (const dy of [0, -1, 1, -2, 2]) {
			for (const side of right ? [1, -1] : [-1, 1]) {
				if (placed) break;
				const sx = side > 0 ? lx + rw : lx - rw - len;
				if (!free(sx, ly + dy, len)) continue;
				const selected = node.id === selectedId;
				cv.text(sx, ly + dy, label, node === center ? roleColor(node.role) : nodeToken(node), { bold: true, inverse: selected });
				occupied.push({ x: sx, y: ly + dy, w: len });
				placed = true;
			}
		}
	}
	// Legend: roles that actually appear (dynamic), then status hints.
	// Reserve room for failed/retired glyphs first so a narrow panel still matches live scout (#102/#125).
	const ly = r.y + r.h - 1;
	let lx = r.x + 1;
	const roles: string[] = [];
	for (const node of dfsOrder(nodes)) if (isAgent(node) && !roles.includes(node.role)) roles.push(node.role);
	const statuses = new Set(nodes.map((node) => node.status));
	const statusItems = ([["failed", "✗ failed", "error"], ["retired", "⣿ retired", "dim"]] as const)
		.filter(([status]) => statuses.has(status));
	// Budget in grapheme cells (not String.length) so multi-byte / emoji labels do not squeeze roles (#128).
	const statusBudget = statusItems.reduce((sum, [, label]) => sum + cellWidth(label) + 2, 0);
	const roleLimit = r.x + r.w - 1 - statusBudget;
	for (const role of roles) {
		const w = cellWidth(role) + 4;
		if (lx + w > roleLimit) break;
		cv.set(lx, ly, "⣿", roleColor(role));
		cv.text(lx + 2, ly, role, "dim");
		lx += w;
	}
	for (const [, label, col] of statusItems) {
		const lw = cellWidth(label);
		if (lx + lw + 1 > r.x + r.w - 1) break;
		cv.text(lx, ly, label, col);
		lx += lw + 2;
	}
}

// ---------------------------------------------------------------- tok/s chart

export interface ChartStats {
	now: number;
	avg: number;
	peak: number;
	peakAt: number;
	total: number;
	from: number;
	byRole: Array<{ role: string; tokens: number }>;
}

/**
 * Chart x-domain. `to` advances only on substantive RateSampler changes
 * (tokensOut / generationMs); wall-clock `now` alone does not scroll the axis.
 * `from` stays relative to that frozen `to` (earliest start, or to−60s).
 */
export function chartWindow(data: ViewData): { from: number; to: number } {
	const starts = data.nodes.filter(isAgent).map((node) => node.startedAt);
	const earliest = Math.min(data.sampler.startedAt ?? data.now, ...(starts.length ? starts : [data.now]));
	const to = data.sampler.lastChangeAt ?? data.sampler.startedAt ?? data.now;
	return { from: Math.min(earliest, to - 60_000), to };
}

export function computeStats(data: ViewData, buckets: number, series?: RateSeries): ChartStats {
	const { from, to } = chartWindow(data);
	// #346: the chart body already bucketed this exact window, so reuse its result.
	// Recomputing it here was the measured duplicate pass (≈1.2ms + 0.6MB per
	// 200-node frame); the arguments are derived from the same `data`, so the two
	// passes could never disagree.
	const rows = series ?? chartBuckets(data, buckets, { from, to });
	let peak = 0;
	let peakIndex = -1;
	rows.total.forEach((value, i) => {
		if (value > peak) {
			peak = value;
			peakIndex = i;
		}
	});
	// The header tok/s is the shared definition, never the last bucket.
	peak = Math.max(peak, data.rate);
	const peakAt = peakIndex >= 0 && peak > data.rate ? rows.times[peakIndex]! : to;
	const roleTotals = new Map<string, number>();
	let total = 0;
	for (const node of data.nodes) {
		if (!isAgent(node)) continue;
		total += node.tokens;
		roleTotals.set(node.role, (roleTotals.get(node.role) ?? 0) + node.tokens);
	}
	return {
		now: data.rate,
		// Full-series window average over the series this frame paints (includes
		// settled ones); differs from the header tok/s on purpose. #346: the
		// visibility filter applies here too — a series the chart does not paint
		// must not inflate the avg line (measured: 40 finished ghosts moved it
		// from 300 to 1.5k tok/s) and must not cost a walk per frame.
		avg: data.sampler.totalRate(to, Math.max(1, to - from), visibleRateNodeIds(data.nodes)),
		peak,
		peakAt,
		total,
		from,
		byRole: [...roleTotals.entries()].map(([role, tokens]) => ({ role, tokens })).sort((a, b) => b.tokens - a.tokens),
	};
}

const PARTIAL = [" ", "▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];

/**
 * #346: the frame's bucketing pass — ONE per frame, shared by `drawChart`'s body
 * and `computeStats`.
 *
 * The key is the sampling window `(from, to, count)` plus the frame's visible
 * series (see `BucketOptions.onlyNodeIds`): a series the frame does not paint
 * keeps its samples but contributes nothing to this pass, which is what stops a
 * long session's finished children from taxing every frame.
 */
export function chartBuckets(data: ViewData, count: number, window: { from: number; to: number } = chartWindow(data)): RateSeries {
	return data.sampler.buckets(window.from, window.to, count, { onlyNodeIds: visibleRateNodeIds(data.nodes) });
}

export function drawChart(cv: Canvas, r: Rect, data: ViewData, selected: VizNode | undefined, wideStats: boolean): void {
	if (r.w < 12 || r.h < 4) return;
	const statsW = wideStats && r.w >= 64 ? 28 : 0;
	const statsBelow = statsW === 0 ? Math.min(selected ? 4 : 3, Math.max(0, r.h - 6)) : 0;
	const axisW = 6;
	const plotX = r.x + axisW;
	// With side stats, keep room for the "◂ N" label so it never runs into the stats column.
	const plotW = Math.max(4, r.w - axisW - statsW - (statsW ? 9 : 0) - 1);
	const plotTop = r.y + 1;
	const plotH = Math.max(1, r.h - 2 - statsBelow);
	const axisY = plotTop + plotH;
	const { from, to } = chartWindow(data);
	const series = chartBuckets(data, plotW, { from, to });
	const stats = computeStats(data, plotW, series);
	const max = Math.max(1, stats.peak * 1.15);
	const rowsFor = (v: number): number => (v / max) * plotH;
	const roles = stats.byRole.map((entry) => entry.role);
	for (const role of series.byRole.keys()) if (!roles.includes(role)) roles.push(role);

	for (let i = 0; i < plotW; i++) {
		let acc = 0;
		const bands: Array<{ top: number; role: string }> = [];
		for (const role of roles) {
			const value = series.byRole.get(role)?.[i] ?? 0;
			if (value <= 0) continue;
			acc += value;
			bands.push({ top: rowsFor(acc), role });
		}
		const top = rowsFor(acc);
		for (let j = 0; j < plotH; j++) {
			const center = j + 0.5;
			const y = axisY - 1 - j;
			if (top >= j + 1) {
				const band = bands.find((b) => b.top >= center) ?? bands[bands.length - 1];
				if (band) cv.set(plotX + i, y, "█", roleColor(band.role));
			} else if (top > j) {
				const eighth = Math.round((top - j) * 8);
				if (eighth > 0) cv.set(plotX + i, y, PARTIAL[eighth]!, roleColor(bands[bands.length - 1]?.role ?? "worker"));
				break;
			}
		}
	}
	// Peak marker: dotted rule at the peak height plus a label in the top row.
	if (stats.peak > 0) {
		const peakRow = Math.min(plotH - 1, Math.floor(rowsFor(stats.peak)));
		const y = axisY - 1 - peakRow;
		for (let i = 0; i < plotW; i++) if (cv.get(plotX + i, y)?.ch === " ") cv.set(plotX + i, y, "┄", "dim");
		const label = `peak ${formatCount(stats.peak)} @ ${formatDuration(stats.peakAt - from)}`;
		cv.text(Math.max(plotX, plotX + plotW - label.length), r.y, label, "text", { bold: true, maxX: plotX + plotW });
	}
	// Selected agent's own rate line.
	if (selected && isAgent(selected)) {
		const line = data.sampler.nodeBuckets(selected.id, from, to, plotW);
		line.forEach((value, i) => {
			if (value <= 0) return;
			const row = Math.min(plotH - 1, Math.floor(rowsFor(value)));
			cv.set(plotX + i, axisY - 1 - row, "━", "text", { bold: true });
		});
	}
	// Y axis.
	for (let j = 0; j < plotH; j++) cv.set(plotX - 1, axisY - 1 - j, "│", "borderMuted");
	const yLabel = (v: number, y: number): void => {
		cv.text(r.x, y, formatCount(v).padStart(axisW - 2), "dim", { maxX: plotX - 1 });
	};
	if (stats.peak > 0) yLabel(max, plotTop);
	if (plotH >= 5 && max >= 20) yLabel(max / 2, axisY - 1 - Math.floor(plotH / 2));
	yLabel(0, axisY - 1);
	// X axis: elapsed time since the window start; the right edge is the present.
	cv.text(plotX - 1, axisY, "└" + "─".repeat(plotW), "borderMuted", { maxX: plotX + plotW });
	cv.text(plotX, axisY, "0m", "dim");
	const mid = formatDuration((to - from) / 2);
	if (plotW > 24) cv.text(plotX + Math.floor(plotW / 2) - Math.floor(mid.length / 2), axisY, mid, "dim");
	const nowLabel = `◂ ${formatCount(stats.now)}`;
	if (statsW === 0) cv.text(r.x, r.y, `${formatCount(stats.now)} tok/s`, "accent", { bold: true, maxX: Math.max(r.x, plotX + plotW - 22) });
	else cv.text(plotX + plotW + 1, axisY - 1 - Math.min(plotH - 1, Math.floor(rowsFor(stats.now))), nowLabel, "text", { maxX: r.x + r.w - statsW - 1 });

	const selLines = (): Array<[string, string]> => {
		if (!selected) return [];
		const rate = data.sampler.nodeRate(selected.id, data.now);
		const share = stats.total > 0 ? (selected.tokens / stats.total) * 100 : 0;
		return [
			[`▸ ${selected.name}`, roleColor(selected.role)],
			[`${formatCount(rate)} tok/s · ${formatCount(selected.tokens)} tok`, "text"],
			[`${share.toFixed(1)}% of run · ━ bright line`, "dim"],
		];
	};
	if (statsW) {
		const sx = r.x + r.w - statsW;
		const rows: Array<[string, string, string]> = [
			["rate", `${formatCount(stats.now)} tok/s`, "text"],
			["avg", `${formatCount(stats.avg)} tok/s`, "text"],
			["peak", stats.peak > 0 ? `${formatCount(stats.peak)} @ ${formatDuration(stats.peakAt - from)}` : "—", "text"],
			["total", `${formatCount(stats.total)} tok`, "text"],
		];
		let y = r.y;
		for (const [k, v, col] of rows) {
			if (y >= r.y + r.h) break;
			cv.text(sx, y, k, "dim");
			cv.text(sx + 6, y, v, col, { bold: true, maxX: r.x + r.w });
			y++;
		}
		y++;
		const roomForRoles = r.h - (y - r.y) - (selected ? 4 : 0);
		const top = stats.byRole[0]?.tokens ?? 1;
		for (const entry of stats.byRole.slice(0, Math.max(0, roomForRoles))) {
			const name = ellipsize(entry.role, 10);
			cv.text(sx, y, name, roleColor(entry.role));
			const barW = Math.max(0, Math.round((entry.tokens / Math.max(1, top)) * 9));
			cv.text(sx + 11, y, "▆".repeat(barW), roleColor(entry.role));
			const t = formatCount(entry.tokens);
			cv.text(r.x + r.w - t.length, y, t, "dim");
			y++;
		}
		const sl = selLines();
		let sy = r.y + r.h - sl.length;
		for (const [text, col] of sl) cv.text(sx, sy++, ellipsize(text, statsW), col, { bold: col !== "dim" });
	} else if (statsBelow > 0) {
		let y = axisY + 1;
		const line1 = `avg ${formatCount(stats.avg)} · peak ${formatCount(stats.peak)} @ ${formatDuration(stats.peakAt - from)} · total ${formatCount(stats.total)}`;
		cv.text(r.x, y++, ellipsize(line1, r.w), "dim");
		if (y < r.y + r.h) {
			let x = r.x;
			for (const entry of stats.byRole) {
				const pct = stats.total > 0 ? Math.round((entry.tokens / stats.total) * 100) : 0;
				const label = `${entry.role} ${pct}%`;
				if (x + label.length + 2 > r.x + r.w) break;
				cv.set(x, y, "■", roleColor(entry.role));
				cv.text(x + 2, y, label, "dim");
				x += label.length + 4;
			}
			y++;
		}
		const sl = selLines();
		if (sl.length && y < r.y + r.h) {
			const [name, col] = sl[0]!;
			const rest = sl[1]![0];
			cv.text(r.x, y, ellipsize(`${name}  ${rest}`, r.w), col, { bold: true });
		}
	}
}

// ---------------------------------------------------------------- git-log history

export interface LogEvent {
	ts: number;
	kind: "spawn" | "settled" | "failed" | "retired";
	node: VizNode;
	parentName?: string;
}

/** Display states that describe a *finished* lifecycle: the only ones the log knows. */
const LOG_END_KINDS: ReadonlySet<VizStatus> = new Set<VizStatus>(["settled", "failed", "retired"]);

function isLogEndKind(status: VizStatus): status is Exclude<LogEvent["kind"], "spawn"> {
	return LOG_END_KINDS.has(status);
}

export function buildLog(nodes: readonly VizNode[]): LogEvent[] {
	const byId = new Map(nodes.map((node) => [node.id, node]));
	const out: LogEvent[] = [];
	for (const node of nodes) {
		if (!isAgent(node)) continue;
		const parentName = node.parentId ? byId.get(node.parentId)?.name : undefined;
		out.push({ ts: node.startedAt, kind: "spawn", node, ...(parentName ? { parentName } : {}) });
		if (node.endedAt !== undefined && isLogEndKind(node.status)) out.push({ ts: node.endedAt, kind: node.status, node });
	}
	return out.sort((a, b) => b.ts - a.ts || (a.kind === "spawn" ? 1 : -1));
}

const KIND_GLYPH: Record<LogEvent["kind"], [string, string]> = {
	spawn: ["+", "text"],
	settled: ["✓", "success"],
	failed: ["✗", "error"],
	retired: ["○", "dim"],
};

export function drawLog(
	cv: Canvas,
	r: Rect,
	events: readonly LogEvent[],
	state: { offset: number; cursor: number; focused: boolean; selectedId?: string; origin: number },
): void {
	if (r.w < 8 || r.h < 2) return;
	// Belt and braces (#251): the border column is `r.x + r.w` (this is the INNER rect
	// `frame()` hands back), and `Canvas.text`'s `maxX` is exclusive, so `r.x + r.w` is
	// exactly "the last inner cell, never the border" — the same value `frame()` and
	// `drawStatus` use. The budgets below already keep every write inside it; this is
	// what stops a future edit to those budgets from silently running onto the border.
	const maxX = r.x + r.w;
	const filter = state.selectedId ? events.find((e) => e.node.id === state.selectedId)?.node.name : undefined;
	cv.text(r.x, r.y, ellipsize(`${events.length} events${filter ? ` · highlight: ${filter}` : ""}`, r.w), "dim", { maxX });
	const rows = r.h - 1;
	const maxDepth = Math.max(1, ...events.map((e) => e.node.depth));
	const graphW = Math.min(8, maxDepth * 2);
	const timeW = 7;
	for (let i = 0; i < rows; i++) {
		const index = state.offset + i;
		const event = events[index];
		if (!event) break;
		const y = r.y + 1 + i;
		const isCursor = state.focused && index === state.cursor;
		const highlight = state.selectedId === event.node.id;
		const dim = state.selectedId !== undefined && !highlight;
		cv.text(r.x, y, formatDuration(event.ts - state.origin).padStart(timeW - 1), "dim", { maxX });
		const gx = r.x + timeW;
		if (r.w > timeW + graphW + 10) {
			for (let d = 1; d < Math.min(event.node.depth, graphW / 2 + 1); d++) cv.set(gx + (d - 1) * 2, y, "│", "borderMuted");
			const dx = gx + Math.min(event.node.depth - 1, graphW / 2 - 1) * 2;
			cv.set(dx, y, event.kind === "spawn" ? "●" : "┘", event.kind === "spawn" ? roleColor(event.node.role) : "borderMuted");
		}
		const tx = r.w > timeW + graphW + 10 ? gx + graphW + 1 : gx;
		const [glyph, glyphCol] = KIND_GLYPH[event.kind];
		cv.set(tx, y, glyph, glyphCol, { bold: true });
		// Room between the glyph and the border: `r.x + r.w` is the border column, so the
		// last cell the name may use is `r.x + r.w - 1`. The old `Math.max(6, …)` floor
		// ignored this room, so on a narrow pane `nameW` stayed 6 with 1–2 cells left and
		// the name ran through the border (#251). `nameW <= nameRoom` also bounds the detail
		// below: its budget is `r.x + r.w - (tx + 3 + nameW)` cells, so the detail's last
		// cell is `tx + 3 + nameW + budget - 1 <= r.x + r.w - 1`. `nameRoom <= 0` degrades
		// to "" (ellipsize(_, 0) === "") instead of printing a truncated name past the rect.
		const nameRoom = r.x + r.w - (tx + 2);
		const nameW = Math.min(16, Math.max(0, Math.floor(nameRoom * 0.45)));
		const name = ellipsize(event.node.name, nameW);
		cv.text(tx + 2, y, name, dim ? "dim" : roleColor(event.node.role), { bold: !dim, inverse: isCursor, maxX });
		const detail = event.kind === "spawn"
			? `${event.parentName ?? "root"} → ${event.node.role}`
			: `${event.kind === "settled" ? "done" : event.kind} · ${formatCount(event.node.tokens)} tok`;
		cv.text(tx + 3 + nameW, y, ellipsize(detail, Math.max(0, r.x + r.w - (tx + 3 + nameW))), highlight ? "text" : "dim", { maxX });
		if (isCursor && highlight) cv.set(r.x + r.w - 1, y, "◂", "accent", { bold: true });
	}
	if (events.length > rows) {
		const thumb = Math.max(1, Math.round((rows / events.length) * rows));
		const pos = Math.round((state.offset / Math.max(1, events.length - rows)) * (rows - thumb));
		for (let i = 0; i < rows; i++) cv.set(r.x + r.w - 1, r.y + 1 + i, i >= pos && i < pos + thumb ? "┃" : "│", i >= pos && i < pos + thumb ? "scrollbarThumb" : "scrollbarTrack");
	}
}

// ---------------------------------------------------------------- timing (#151)
// TUI scope = current view VizNodes; CLI `/legion timing` = cwd RunStore children.
// Formula matches #150 (wall / gen / other); the node set can differ.

export interface TimingRow {
	node: VizNode;
	wallMs: number;
	generationMs: number | null;
	otherMs: number | null;
	liveWall: boolean;
}

/**
 * Build timing rows from viz nodes (agents only).
 * VizNode has no turn count: generationMs === 0 → gen/other shown as — (no turn data).
 */
export function timingRowsFromNodes(nodes: readonly VizNode[], now: number): TimingRow[] {
	const rows: TimingRow[] = [];
	for (const node of nodes) {
		if (!isAgent(node)) continue;
		const end = node.endedAt ?? now;
		const wallMs = Math.max(0, end - node.startedAt);
		const liveWall = node.status === "running" && node.endedAt === undefined;
		// No turn data on VizNode → treat 0 generationMs as absent (align "无 turn → —").
		const generationMs = node.generationMs > 0 ? node.generationMs : null;
		const parts = breakdown(wallMs, generationMs);
		rows.push({
			node,
			wallMs: parts.wall_ms,
			generationMs: parts.generation_ms,
			otherMs: parts.other_ms,
			liveWall,
		});
	}
	rows.sort((a, b) => a.node.startedAt - b.node.startedAt || a.node.name.localeCompare(b.node.name));
	return rows;
}

function formatTimingCell(ms: number | null, opts: { live?: boolean } = {}): string {
	if (ms === null) return "—";
	const rendered = formatDuration(ms);
	return opts.live ? `${rendered}+` : rendered;
}

function roleAbbrev(role: string): string {
	const t = role.trim();
	if (!t) return "";
	if (t.length <= 4) return t;
	return t.slice(0, 3);
}

export interface TimingDrawState {
	offset: number;
	cursor: number;
	focused: boolean;
	selectedId?: string;
}

export function drawTiming(
	cv: Canvas,
	r: Rect,
	rows: readonly TimingRow[],
	state: TimingDrawState,
): void {
	if (r.w < 8 || r.h < 2) return;
	const showExtra = r.w >= 36;
	const showRole = r.w >= 28;
	const header = showExtra
		? "name" + (showRole ? " · role" : "") + "   wall    gen   other"
		: "name" + (showRole ? " · role" : "") + "   wall";
	cv.text(r.x, r.y, ellipsize(header, r.w), "dim");

	const footerH = rows.length > 0 && r.h >= 4 ? 1 : 0;
	const rowsAvail = Math.max(0, r.h - 1 - footerH);
	for (let i = 0; i < rowsAvail; i++) {
		const index = state.offset + i;
		const row = rows[index];
		if (!row) break;
		const y = r.y + 1 + i;
		const isCursor = state.focused && index === state.cursor;
		const highlight = state.selectedId === row.node.id;
		const dim = state.selectedId !== undefined && !highlight;

		const wall = formatTimingCell(row.wallMs, { live: row.liveWall });
		const gen = formatTimingCell(row.generationMs);
		const other = formatTimingCell(row.otherMs);

		const wallW = showExtra ? 8 : Math.max(6, Math.min(10, r.w - 12));
		const genW = 7;
		const otherW = 7;
		const metaW = showExtra ? wallW + 1 + genW + 1 + otherW : wallW;
		const nameBudget = Math.max(4, r.w - metaW - (showRole ? 5 : 1));

		let name = ellipsize(row.node.name, nameBudget);
		if (showRole) {
			const abbr = roleAbbrev(row.node.role);
			const room = nameBudget - cellWidth(name) - 1;
			if (abbr && room >= cellWidth(abbr)) {
				name = `${name} ${abbr}`;
			}
		}

		cv.text(r.x, y, ellipsize(name, nameBudget), dim ? "dim" : roleColor(row.node.role), {
			bold: !dim,
			inverse: isCursor,
		});

		const metaX = r.x + r.w - metaW;
		if (showExtra) {
			cv.text(metaX, y, wall.padStart(wallW), highlight ? "text" : "dim", { maxX: r.x + r.w });
			cv.text(metaX + wallW + 1, y, gen.padStart(genW), "dim", { maxX: r.x + r.w });
			cv.text(metaX + wallW + 1 + genW + 1, y, other.padStart(otherW), "dim", { maxX: r.x + r.w });
		} else {
			cv.text(metaX, y, wall.padStart(wallW), highlight ? "text" : "dim", { maxX: r.x + r.w });
		}
		if (isCursor && highlight) cv.set(r.x + r.w - 1, y, "◂", "accent", { bold: true });
	}

	if (footerH && rows.length > 0) {
		const started = rows.map((row) => row.node.startedAt);
		const ended = rows.map((row) => (row.liveWall ? null : row.node.endedAt ?? row.node.startedAt + row.wallMs));
		const ends = ended.filter((v): v is number => v !== null);
		const span =
			started.length && ends.length
				? Math.max(0, Math.max(...ends) - Math.min(...started))
				: null;
		const sumWall = rows.reduce((sum, row) => sum + row.wallMs, 0);
		const fy = r.y + r.h - 1;
		const spanText = span === null ? "—" : formatDuration(span);
		cv.text(r.x, fy, ellipsize(`span ${spanText} · sum ${formatDuration(sumWall)}`, r.w), "dim");
	}

	if (rows.length > rowsAvail && rowsAvail > 0) {
		const thumb = Math.max(1, Math.round((rowsAvail / rows.length) * rowsAvail));
		const pos = Math.round((state.offset / Math.max(1, rows.length - rowsAvail)) * (rowsAvail - thumb));
		for (let i = 0; i < rowsAvail; i++) {
			cv.set(
				r.x + r.w - 1,
				r.y + 1 + i,
				i >= pos && i < pos + thumb ? "┃" : "│",
				i >= pos && i < pos + thumb ? "scrollbarThumb" : "scrollbarTrack",
			);
		}
	}
}

// ---------------------------------------------------------------- status (D1)
// The `/legion status` table, on the board. Every new field is optional on
// VizNode (D6), so a missing `spawnMode` prints `unknown` — never a guessed
// `rpc` — and an `inprocess` child prints `—` for rss instead of a share of the
// host figure it does not own (D2).

export interface StatusDrawState {
	offset: number;
	cursor: number;
	focused: boolean;
	selectedId?: string;
}

export interface StatusColumn {
	key: "name" | "role" | "state" | "supervisor" | "ctx" | "rss" | "turns";
	label: string;
	width: number;
	align: "left" | "right";
}

/** Placeholder for "there is no honest value here" — never a fabricated number. */
const NO_VALUE = "\u2014";

/** Agents in the status table, oldest first. The root row is the run, not an agent. */
export function statusRowsFromNodes(nodes: readonly VizNode[]): VizNode[] {
	return nodes
		.filter(isAgent)
		.sort((a, b) => a.startedAt - b.startedAt || a.name.localeCompare(b.name));
}

/**
 * D7 width grading in **absolute columns**, never a ratio (the `drawTiming`
 * convention): the row always keeps `name · state`, and the optional fields come
 * back one at a time as the rect grows. `undefined` = below the 20-column floor,
 * so the pane paints nothing instead of a column of stubs.
 *
 * The widths sum exactly to `width`, so a row can never spill past its rect.
 */
export function statusColumns(width: number): StatusColumn[] | undefined {
	if (width < 20) return undefined;
	const state: StatusColumn = { key: "state", label: "state", width: 7, align: "left" };
	if (width < 36) {
		return [{ key: "name", label: "name", width: width - 8, align: "left" }, state];
	}
	if (width < 52) {
		return [
			{ key: "name", label: "name", width: width - 15, align: "left" },
			state,
			{ key: "ctx", label: "ctx", width: 6, align: "right" },
		];
	}
	if (width < 72) {
		return [
			{ key: "name", label: "name", width: width - 25, align: "left" },
			state,
			{ key: "supervisor", label: "sup", width: 9, align: "left" },
			{ key: "ctx", label: "ctx", width: 6, align: "right" },
		];
	}
	return [
		{ key: "name", label: "name", width: width - 43, align: "left" },
		{ key: "role", label: "role", width: 4, align: "left" },
		state,
		{ key: "supervisor", label: "sup", width: 9, align: "left" },
		{ key: "ctx", label: "ctx", width: 6, align: "right" },
		{ key: "rss", label: "rss", width: 6, align: "right" },
		{ key: "turns", label: "turns", width: 5, align: "right" },
	];
}

/**
 * Rows `drawStatus` can paint for a pane whose **outer** (framed) height is
 * `outerH`. Exported so the view clamps the scroll offset with the draw layer's
 * own arithmetic instead of the off-by-one `layout.h - 3` it uses for timing.
 */
export function statusVisibleRows(outerH: number, total: number): number {
	const innerH = Math.max(0, outerH - 2);
	const footerH = total > 0 && innerH >= 4 ? 1 : 0;
	return Math.max(0, innerH - 1 - footerH);
}

/** `unknown` for a missing mode (D6): a legacy row is not evidence of `rpc`. */
function statusSupervisor(node: VizNode): string {
	return node.spawnMode ?? "unknown";
}

/**
 * D2: only an `rpc` child owns a process, so only it has an honest RSS. An
 * `inprocess` child shares this host process — apportioning the host figure
 * across children would be fabricated data the user then decides on, so it
 * prints `—`. Lowercase `m` keeps the panel inside the plain glyph set.
 */
function statusRss(node: VizNode): string {
	if (node.spawnMode === "inprocess") return NO_VALUE;
	if (node.rss === undefined || !Number.isFinite(node.rss) || node.rss < 0) return NO_VALUE;
	return `${Math.round(node.rss)}m`;
}

function statusValue(node: VizNode, key: StatusColumn["key"]): string {
	switch (key) {
		case "name":
			return node.name;
		case "role":
			return roleAbbrev(node.role);
		case "state":
			return node.status === "settled" ? "done" : node.status;
		case "supervisor":
			return statusSupervisor(node);
		case "ctx":
			return node.contextTokens !== undefined && node.contextTokens > 0 ? formatCount(node.contextTokens) : NO_VALUE;
		case "rss":
			return statusRss(node);
		case "turns":
			return node.turns !== undefined && node.turns > 0 ? String(node.turns) : NO_VALUE;
	}
}

function statusColor(node: VizNode, key: StatusColumn["key"], dim: boolean): string {
	if (dim) return "dim";
	if (key === "name") return roleColor(node.role);
	if (key === "state") {
		if (node.status === "failed") return "error";
		if (node.status === "settled") return "success";
		if (node.status === "running") return "accent";
		return "dim";
	}
	return "dim";
}

/** Ellipsize then pad to exactly `width` cells (grapheme-safe, never overflows). */
function padCell(value: string, width: number, align: "left" | "right"): string {
	const clipped = ellipsize(value, width);
	const pad = " ".repeat(Math.max(0, width - cellWidth(clipped)));
	return align === "right" ? pad + clipped : clipped + pad;
}

/**
 * Status table: header row, one row per agent, optional footer.
 *
 * `r` is the **inner** rect `frame()` hands back, so the header line sits on the
 * first row inside the border. Every `cv.text` is ellipsized to its column *and*
 * carries `maxX` — the pane never writes past its own rect the way `drawLog`
 * can on a very narrow terminal.
 */
export function drawStatus(
	cv: Canvas,
	r: Rect,
	nodes: readonly VizNode[],
	state: StatusDrawState,
): void {
	if (r.w < 20 || r.h < 2) return;
	const columns = statusColumns(r.w);
	if (!columns) return;
	const maxX = r.x + r.w;
	const rows = statusRowsFromNodes(nodes);
	const footerH = rows.length > 0 && r.h >= 4 ? 1 : 0;
	const rowsAvail = Math.max(0, r.h - 1 - footerH);

	// Header: labels only. Panel content never lands on the title rule.
	let x = r.x;
	columns.forEach((column, index) => {
		cv.text(x, r.y, padCell(column.label, column.width, column.align), "dim", { maxX });
		x += column.width + (index < columns.length - 1 ? 1 : 0);
	});

	for (let i = 0; i < rowsAvail; i++) {
		const index = state.offset + i;
		const node = rows[index];
		if (!node) break;
		const y = r.y + 1 + i;
		const isCursor = state.focused && index === state.cursor;
		const highlight = state.selectedId === node.id;
		const dim = state.selectedId !== undefined && !highlight;
		let cx = r.x;
		columns.forEach((column, ci) => {
			cv.text(cx, y, padCell(statusValue(node, column.key), column.width, column.align), statusColor(node, column.key, dim), {
				...(column.key === "name" && !dim ? { bold: true } : {}),
				...(column.key === "name" && isCursor ? { inverse: true } : {}),
				maxX,
			});
			cx += column.width + (ci < columns.length - 1 ? 1 : 0);
		});
	}

	if (footerH) {
		const live = rows.filter((node) => node.status === "running").length;
		const hidden = Math.max(0, rows.length - rowsAvail);
		const parts = [`${rows.length} agents`, `${live} live`];
		if (hidden > 0) parts.push(`+${hidden} more`);
		cv.text(r.x, r.y + r.h - 1, ellipsize(parts.join(" · "), r.w), "dim", { maxX });
	}
}
