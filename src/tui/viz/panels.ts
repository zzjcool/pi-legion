/** Panel renderers for the /legion full view. All drawing is clipped to its rect. */

import { Canvas, cellWidth, ellipsize, type TextStyle } from "./canvas.ts";
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

/**
 * The inner (content) rect `frame()` hands back, or `undefined` when the pane is
 * too small to be painted at all.
 *
 * Pure half of `frame()`'s geometry, exported so the mouse hit-test (view.ts, D11)
 * derives a pane's content cells from the *draw layer's* border offset instead of
 * keeping a second copy of `+1 / -2` that could drift from it.
 */
export function paneInner(r: Rect): Rect | undefined {
	if (r.w < 4 || r.h < 3) return undefined;
	return { x: r.x + 1, y: r.y + 1, w: r.w - 2, h: r.h - 2 };
}

export function frame(cv: Canvas, r: Rect, title: string, focused: boolean, hint?: string): Rect {
	const inner = paneInner(r);
	if (!inner) return { x: r.x, y: r.y, w: Math.max(0, r.w), h: Math.max(0, r.h) };
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
	return inner;
}

/**
 * Row count of a header + optional-footer list pane (status, timing) inside an
 * `innerH`-tall inner rect: one header row, plus one footer row once the pane has
 * the four rows that shape needs and the list is non-empty.
 */
function innerListRows(innerH: number, total: number): number {
	const footerH = total > 0 && innerH >= 4 ? 1 : 0;
	return Math.max(0, innerH - 1 - footerH);
}

/** Rows `drawTiming` paints inside an `innerH`-tall inner rect. */
function timingVisibleRows(innerH: number, total: number): number {
	return innerListRows(innerH, total);
}

/** Rows `drawLog` paints: one summary/scroll row above the first event, then one inner row per event. */
function logVisibleRows(innerH: number): number {
	return Math.max(0, innerH - 1);
}

/** The panes made of one row per entry (D11). The galaxy is clickable too, but it is not a list (D13). */
export type ListPane = "timing" | "log" | "status";

/**
 * Rows this pane actually painted, given its `frame()` inner rect and row list
 * length — `0` when the draw layer paints nothing at all at this size.
 *
 * This is the mouse hit-test's single source of truth (view.ts, D11): row `i` of a
 * pane sits on cell `inner.y + 1 + i` and every row is painted across the pane's
 * inner columns, so "the cell carries an agent" is exactly
 * `0 <= y - (inner.y + 1) < visibleListRows(...)`. The width floors below are the
 * draw functions' own early returns, kept here rather than duplicated at the
 * click site.
 */
export function visibleListRows(pane: ListPane, inner: Rect, total: number): number {
	switch (pane) {
		case "log":
			return inner.w < 8 || inner.h < 2 ? 0 : logVisibleRows(inner.h);
		case "timing":
			return inner.w < 8 || inner.h < 2 ? 0 : timingVisibleRows(inner.h, total);
		case "status":
			// `drawStatus` needs `statusColumns()` (20 columns) before it paints a row.
			return inner.w < 20 || inner.h < 2 ? 0 : innerListRows(inner.h, total);
	}
}

/** Shared empty list: `map.get(id) ?? []` allocated one array per miss, per pass (~200/frame). */
const NO_NODES: readonly VizNode[] = [];

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

/**
 * Depth-first order (roots first), used for keyboard navigation.
 *
 * #364 A4: `kids` is optional so a caller that already built this frame's
 * `childrenMap` (the galaxy legend) hands it over instead of paying for a second
 * copy of the same map. The default keeps every existing caller unchanged.
 */
export function dfsOrder(nodes: readonly VizNode[], kids: Map<string | null, VizNode[]> = childrenMap(nodes)): VizNode[] {
	const out: VizNode[] = [];
	const visit = (node: VizNode, guard: Set<string>): void => {
		if (guard.has(node.id)) return;
		guard.add(node.id);
		out.push(node);
		for (const child of kids.get(node.id) ?? NO_NODES) visit(child, guard);
	};
	const guard = new Set<string>();
	for (const root of kids.get(null) ?? NO_NODES) visit(root, guard);
	for (const node of nodes) if (!guard.has(node.id)) visit(node, guard);
	return out;
}

// ---------------------------------------------------------------- galaxy

const BRAILLE_BITS = [[0x1, 0x8], [0x2, 0x10], [0x4, 0x20], [0x40, 0x80]] as const;

/**
 * `String.fromCharCode(0x2800 + m)` for all 256 bit patterns, hoisted to module
 * scope (#364 A2): the paint loop used to build one fresh glyph string per
 * painted cell — 2,000+ strings a frame at 200×60.
 */
const BRAILLE_GLYPHS: string[] = Array.from({ length: 256 }, (_, m) => String.fromCharCode(0x2800 + m));

/** Label search offsets and side order, hoisted out of the per-candidate loop (#364 A2). */
const LABEL_DY = [0, -1, 1, -2, 2] as const;
const SIDES_RIGHT = [1, -1] as const;
const SIDES_LEFT = [-1, 1] as const;
/** Two constant style objects: `text()` only reads them, so every label can share one. */
const LABEL_STYLE: Readonly<TextStyle> = { bold: true, inverse: false };
const LABEL_STYLE_SELECTED: Readonly<TextStyle> = { bold: true, inverse: true };
/** Legend entries in fixed order (failed before retired); filtered per frame, never rebuilt. */
const STATUS_ITEMS = [["failed", "✗ failed", "error"], ["retired", "⣿ retired", "dim"]] as const;

/**
 * Two-argument `Math.hypot`, inlined.
 *
 * `Math.hypot` is a variadic builtin: V8 materialises an arguments array on every
 * call, and the disc fill alone makes ~10k of them per frame — measured at
 * **170KB/frame**, a third of `drawGalaxy`'s allocation and the single largest
 * item left after the buffers were reused (#364 S1).
 *
 * This is the same algorithm V8 runs for it (scale by the larger magnitude, then
 * `max * sqrt(sum of scaled squares)`), which is why it is bit-for-bit equal to
 * `Math.hypot(a, b)` — exported only so
 * `test/unit/legion-viz.test.ts` can hold that equality over the whole drawing
 * domain (all disc-fill coordinate pairs + 5k random pairs). The page digests are
 * the second guard: a one-ulp difference would move a `<= rad` comparison and
 * change the picture.
 *
 * `@internal` — exported for that differential test only; nothing outside
 * `panels.ts` calls it.
 */
export function hypot2(a: number, b: number): number {
	const x = Math.abs(a);
	const y = Math.abs(b);
	if (x === Number.POSITIVE_INFINITY || y === Number.POSITIVE_INFINITY) return Number.POSITIVE_INFINITY;
	// `Math.max`, not `x > y ? x : y`: `Math.hypot` propagates NaN, and a plain
	// comparison would silently answer `hypot2(NaN, 0) === 0`. `Math.max` is a
	// two-argument builtin (no arguments object), so this stays allocation-free.
	const max = Math.max(x, y);
	if (max === 0) return 0;
	const xr = x / max;
	const yr = y / max;
	return max * Math.sqrt(xr * xr + yr * yr);
}

interface PxCell {
	m: number;
	col: string;
	z: number;
}

/**
 * #369: every mutable container the two painters read, in **one** object with
 * **one** entry point (`begin`).
 *
 * None of it is a cache: `begin()` empties it before a frame paints, so a reader
 * only ever sees this frame's entries — the answer to "how much of this is
 * already clean at this point?" is "everything with a length or a counter",
 * which is what used to require reading both painters end to end (the resets were
 * spread over 14 lines, and `if (!center) return` in the middle of `drawGalaxy`
 * made the rest look missed).
 *
 * Seven arrays are addressed through a counter instead of being truncated:
 * `posX/posY` (by `pos`), `occX/occY/occW` (by `occCount`), `bandTop/bandRole`
 * (by `bandCount`). `begin` zeroes those counters, which is the same state a fresh
 * instance has — every reader indexes below the counter — and leaving the tails
 * alone is deliberate: `length = 0` would drop V8's backing store and the next
 * write would allocate, which is the one thing #364 forbids (contract §1.2).
 *
 * Nothing here may be re-allocated per frame either: `clear()` / `length = 0` / a
 * counter back to `0` keeps every container's identity across frames, and that
 * identity is what makes a frame allocation-free (#364 I3, contract §2 A1). The
 * containers are therefore `readonly` — only their *contents* change — and the
 * few scalars that are assigned (`pxGrid` as the braille grid's size key, the
 * three counters, the reentrancy flag) are the ones that cannot be.
 *
 * **Contract T2/T3**: `data.nodes` and every `VizNode` is a NEW object each frame
 * (`status.ts:925` → `model.ts:93`), and the drawing path compares nodes by
 * IDENTITY (`node === center`, `node === virtualRoot`). A cross-frame cache of
 * these maps would hand back last frame's objects and degrade the centre sphere
 * to a plain node, so they may only ever hold *this* frame's data — which is why
 * `begin` empties them unconditionally instead of keying them on anything.
 */
class GalaxyScratch {
	// ------------------------------------------------------- braille pixel buffer

	/**
	 * #364 A1: the braille pixel buffer is rewritten in place instead of reallocated
	 * every frame (3,658 cells at 200×60, ~64B each). Its dimensions ARE its size
	 * key: `pixelGrid()` builds a new grid only when the pane's pixel budget
	 * changes, which is the one allocation this class ever makes and never a
	 * per-frame one.
	 *
	 * **Contract T1**: `begin()` clears every cell's `m` and `z`. `m` only ever
	 * accumulates (`|=`), so a stale bit paints last frame's glyph; and `z` is the
	 * write gate (`z >= cell.z`), so a stale `z` rejects this frame's lower-priority
	 * dots, which leaves `m` zero there and drops that part of the picture. `col`
	 * itself is deliberately NOT cleared: with `z = -1` on every cell and every
	 * dot's priority `z >= 0`, the FIRST dot to touch a cell always passes
	 * `z >= cell.z` and so writes `col` in the same step it sets its bit — hence
	 * "`m != 0` ⇒ `col` is this frame's" holds for free, and clearing it would only
	 * add 3,658 pointless stores. (Note the bit is set *outside* the `z` check, so
	 * that implication rests on the `z` reset, not on the assignment order.)
	 */
	private pxWidth = -1;
	private pxHeight = -1;
	private pxGrid: PxCell[][] = [];

	// ------------------------------------------------------------------- galaxy

	readonly leafMemo = new Map<string, number>();
	readonly leafGuard = new Set<string>();
	readonly depthGuard = new Set<string>();
	readonly layGuard = new Set<string>();
	readonly rel = new Map<string, number>();
	readonly radii = new Map<string, number>();
	/** id → index into `posX/Y` (two number arrays beat N `[x, y]` tuples per frame). */
	readonly pos = new Map<string, number>();
	readonly posX: number[] = [];
	readonly posY: number[] = [];
	posCount = 0;
	readonly all: VizNode[] = [];
	readonly running: number[] = [];
	readonly candidates: VizNode[] = [];
	readonly roles: string[] = [];
	readonly statusItems: Array<(typeof STATUS_ITEMS)[number]> = [];
	readonly occX: number[] = [];
	readonly occY: number[] = [];
	readonly occW: number[] = [];
	occCount = 0;

	// -------------------------------------------------------------- tok/s chart

	/**
	 * #364 S4: the chart's per-column band stack (one `{top, role}` object per
	 * non-zero role per column — up to plotW × #roles per frame) as two reused
	 * arrays with a count, re-emptied for every column.
	 */
	readonly bandTop: number[] = [];
	readonly bandRole: string[] = [];
	/** Bands used by the column being painted; reset per column, so `begin` only has to match. */
	bandCount = 0;
	/** The chart's role list for this frame (stats order first, then series-only roles). */
	readonly chartRoles: string[] = [];

	/**
	 * #369 (contract §3): these containers are a process-wide singleton, so a
	 * nested render would clear what the outer call is still reading and paint into
	 * a half-built frame. Always on: one boolean read on entry, no allocation.
	 */
	painting = false;

	/**
	 * The single reset point (contract §1/§2): one call at the top of each painter,
	 * before its first early return.
	 *
	 * Every step is an in-place empty — `Map.clear()` / `Set.clear()` /
	 * `array.length = 0` / a counter back to 0 / the grid's `m`+`z` fields — so no
	 * container changes identity and a frame allocates nothing for its scaffolding.
	 * It is idempotent (contract §1.3): all four kinds of reset are, so calling it
	 * twice for one frame is the same state as calling it once.
	 *
	 * `rect` is contract §2's frozen signature and is deliberately not used to size
	 * the braille grid: `drawChart` hands `begin` the chart's rect, and the galaxy
	 * and chart panes never share a pixel budget, so keying the grid on the rect
	 * here would rebuild it twice per frame — exactly the per-frame allocation
	 * #364 removed. The grid's size key is the mounted grid's own dimensions and
	 * `pixelGrid()` is the one place that sizes it; `begin` only empties it, which
	 * is what keeps this reset unconditional (contract §1.1) for both painters.
	 */
	begin(rect: Rect): void {
		for (let y = 0; y < this.pxHeight; y++) {
			const row = this.pxGrid[y]!;
			for (let x = 0; x < this.pxWidth; x++) {
				const cell = row[x]!;
				cell.m = 0;
				cell.z = -1;
			}
		}
		this.leafMemo.clear();
		this.leafGuard.clear();
		this.depthGuard.clear();
		this.layGuard.clear();
		this.rel.clear();
		this.radii.clear();
		this.pos.clear();
		this.posCount = 0;
		this.all.length = 0;
		this.running.length = 0;
		this.candidates.length = 0;
		this.roles.length = 0;
		this.statusItems.length = 0;
		// The counters are also the LENGTH of posX/posY and occX/occY/occW: dropping a
		// reset here would not change a byte (readers stay below the counter) but the
		// arrays would grow across frames forever, so they are memory hygiene, not
		// removable redundancy (contract §6.3).
		this.occCount = 0;
		this.bandCount = 0;
		this.chartRoles.length = 0;
	}

	/**
	 * The braille buffer for a `width × height` pixel budget: the mounted grid when
	 * the budget did not change (it is already empty — `begin` emptied it), a fresh
	 * zeroed one when it did. Resizing is the only allocation in this class and it
	 * happens on a pane resize, never per frame.
	 */
	pixelGrid(width: number, height: number): PxCell[][] {
		if (width === this.pxWidth && height === this.pxHeight) return this.pxGrid;
		const rows: PxCell[][] = new Array(height);
		for (let y = 0; y < height; y++) {
			const row: PxCell[] = new Array(width);
			for (let x = 0; x < width; x++) row[x] = { m: 0, col: "", z: -1 };
			rows[y] = row;
		}
		this.pxGrid = rows;
		this.pxWidth = width;
		this.pxHeight = height;
		return rows;
	}
}

/** The one instance (contract §1). */
const g = new GalaxyScratch();

/**
 * #369 (contract §3): enter a painter, or refuse a nested one. The gate reads one
 * boolean and allocates nothing on the happy path (the message is built only on
 * the throw) — and the caller's `finally` is what clears it again, including on
 * the early returns.
 */
function enterPanel(fn: "drawGalaxy" | "drawChart"): void {
	if (g.painting) throw new Error(`viz: ${fn} is not reentrant`);
	g.painting = true;
}

export function drawGalaxy(
	cv: Canvas,
	r: Rect,
	data: ViewData,
	selectedId: string | undefined,
	discs?: GalaxyDiscs,
): void {
	// The gate comes before `begin`: a nested call must not wipe the containers the
	// outer frame is still painting from before it throws.
	enterPanel("drawGalaxy");
	try {
		g.begin(r);
		paintGalaxy(cv, r, data, selectedId, discs);
	} finally {
		g.painting = false;
	}
}

/**
 * D13: where one painted galaxy frame's node discs are, in **pane-local pixel**
 * coordinates — the braille grid's own space (2 pixels per cell column, 4 per
 * cell row), which is also the space `paintGalaxy` lays the nodes out in.
 *
 * The painter writes it as it already computes `posX/posY` and `radii`, so a
 * click needs no braille-cell reverse lookup and no second copy of the layout
 * math: hit = "the nearest disc whose ellipse (plus one cell of slack) covers the
 * clicked cell's centre".
 *
 * Parallel arrays behind `count` (not one object per node), filled **in place**
 * frame after frame: the caller owns the sink, so a frame allocates nothing for
 * it (#364), and a per-component sink cannot alias another painter's frame the way
 * the process-wide scratch would. `count` is the only field a reader trusts; the
 * tails above it hold last frame's values on purpose.
 */
export interface GalaxyDiscs {
	ids: string[];
	xs: number[];
	ys: number[];
	/** Half-axes: the centre sphere is drawn `1.6×` wide (`xs` in `paintGalaxy`), every other disc is round. */
	rxs: number[];
	rys: number[];
	count: number;
}

/** An empty sink for `drawGalaxy` / `renderLegionView` to fill in place. */
export function emptyGalaxyDiscs(): GalaxyDiscs {
	return { ids: [], xs: [], ys: [], rxs: [], rys: [], count: 0 };
}

/**
 * Slack added to every disc when a click is resolved, in the painter's pixels.
 *
 * A click carries a *cell*, and the cell's centre sits up to 1 pixel (2 columns)
 * and 2 pixels (4 rows) away from any point of it — so a disc that is painted in
 * the cell must still be hit when the cell's centre is just outside its radius.
 */
const GALAXY_HIT_SLACK = 2;

/**
 * D13: the node whose disc covers cell `(x, y)` — the click side of `drawGalaxy`.
 *
 * `r` is the pane's `frame()` inner rect (exactly what `drawGalaxy` painted into)
 * and `discs` the record that same paint left behind. Overlapping discs resolve to
 * the **nearest centre**; the legend row, the pane's border cell and every pixel
 * outside a disc are `undefined`, so the host keeps dispatching them.
 */
export function galaxyHitAt(r: Rect, discs: GalaxyDiscs, x: number, y: number): string | undefined {
	// -1: the legend line (`paintGalaxy` lays the star field out on `r.h - 1` rows).
	if (x < r.x || x >= r.x + r.w || y < r.y || y >= r.y + r.h - 1) return undefined;
	if (discs.count === 0) return undefined;
	// Cell (i, j) covers pixels [2i, 2i+1] × [4j, 4j+3]; its centre in the painter's
	// space is therefore (2i + 1, 4j + 1.5).
	const px = 2 * (x - r.x) + 1;
	const py = 4 * (y - r.y) + 1.5;
	let bestId: string | undefined;
	let bestDist = Number.POSITIVE_INFINITY;
	for (let i = 0; i < discs.count; i++) {
		const dx = px - discs.xs[i]!;
		const dy = py - discs.ys[i]!;
		// Ellipse membership (the inflated half-axes), so a hit is the shape that was
		// drawn — then the *nearest centre* wins when two discs overlap.
		const nx = dx / (discs.rxs[i]! + GALAXY_HIT_SLACK);
		const ny = dy / (discs.rys[i]! + GALAXY_HIT_SLACK);
		if (nx * nx + ny * ny > 1) continue;
		const dist = Math.hypot(dx, dy);
		if (dist < bestDist) {
			bestDist = dist;
			bestId = discs.ids[i]!;
		}
	}
	return bestId;
}

/**
 * `drawGalaxy`'s body (contract §2): the frame's containers are empty on entry —
 * `begin` ran before the size check, so no early return below can leave a
 * container dirty for the next frame.
 */
function paintGalaxy(cv: Canvas, r: Rect, data: ViewData, selectedId: string | undefined, discs?: GalaxyDiscs): void {
	// D13: the sink describes THIS frame, so it is emptied before any early return —
	// a pane too small to paint must not leave last frame's discs clickable.
	if (discs) discs.count = 0;
	if (r.w < 6 || r.h < 3) return;
	const legendRows = 1;
	const CW = r.w;
	const CH = r.h - legendRows;
	const PW = CW * 2;
	const PH = CH * 4;
	const px = g.pixelGrid(CW, CH);
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
	// Contract T4: the seed resets to 99 every frame. Every `rnd()` call below must
	// stay in the same order and count — the star dust and the twinkle pattern are
	// this exact sequence, so "skip a dot to save an allocation" moves every later
	// value and changes the picture.
	let seed = 99;
	const rnd = (): number => (seed = (seed * 16807) % 2147483647) / 2147483647;
	for (let i = 0; i < (CW * CH) / 12; i++) dot(rnd() * PW, rnd() * PH, "borderMuted", 0);

	const nodes = data.nodes;
	if (!nodes.some(isAgent)) {
		const msg = "no subagents yet";
		cv.text(r.x + Math.max(0, Math.floor((r.w - msg.length) / 2)), r.y + Math.floor(r.h / 2) + 2, ellipsize(msg, r.w), "dim");
	}
	const kids = childrenMap(nodes);
	const roots = kids.get(null) ?? NO_NODES;
	const virtualRoot: VizNode | undefined = roots.length === 1 ? undefined : {
		id: "\u0000center", name: "legion", role: "centurion", parentId: null, depth: 0, status: "running", startedAt: data.now, tokens: 0, tokensOut: 0, generationMs: 0, decodeMs: 0,
	};
	const childrenOf = (node: VizNode): readonly VizNode[] => node === virtualRoot ? roots : kids.get(node.id) ?? NO_NODES;
	const center = virtualRoot ?? roots[0]!;
	if (!center) return;
	// Leaf counts (contract T3: id-keyed, so this memo is frame-scoped only — `begin`
	// emptied it). The old signature was `leaves(node, guard = new Set())`, i.e. one
	// throw-away Set per call site — ~2N−1 per frame — while only the first call ever
	// walks (every later one is a memo hit). A cleared shared set reproduces the exact
	// "fresh guard per top-level call" semantics for free — which is why `leafGuard`
	// is cleared per top-level call below and not only per frame.
	const leavesWalk = (node: VizNode): number => {
		const memo = g.leafMemo.get(node.id);
		if (memo !== undefined) return memo;
		if (g.leafGuard.has(node.id)) return 1;
		g.leafGuard.add(node.id);
		const children = childrenOf(node);
		let value = 1;
		if (children.length > 0) {
			value = 0;
			for (const child of children) value += leavesWalk(child);
		}
		g.leafMemo.set(node.id, value);
		return value;
	};
	const leaves = (node: VizNode): number => {
		const memo = g.leafMemo.get(node.id);
		if (memo !== undefined) return memo;
		g.leafGuard.clear();
		return leavesWalk(node);
	};
	let maxRel = 1;
	(function depth(node: VizNode, d: number, guard: Set<string>): void {
		if (guard.has(node.id)) return;
		guard.add(node.id);
		g.rel.set(node.id, d);
		maxRel = Math.max(maxRel, d);
		for (const child of childrenOf(node)) depth(child, d + 1, guard);
	})(center, 0, g.depthGuard);
	const cx = PW / 2;
	const cy = PH / 2;
	const RY = Math.max(2, PH / 2 - 3);
	const RX = Math.max(2, PW / 2 - 6);
	(function lay(node: VizNode, a0: number, a1: number, guard: Set<string>): void {
		if (guard.has(node.id)) return;
		guard.add(node.id);
		const a = (a0 + a1) / 2;
		const d = g.rel.get(node.id) ?? 0;
		const k = Math.pow(d / maxRel, 0.85);
		g.pos.set(node.id, g.posCount);
		g.posX[g.posCount] = cx + Math.cos(a) * RX * k;
		g.posY[g.posCount] = cy + Math.sin(a) * RY * k;
		g.posCount += 1;
		let start = a0;
		const total = leaves(node);
		for (const child of childrenOf(node)) {
			const span = ((a1 - a0) * leaves(child)) / total;
			lay(child, start, start + span, guard);
			start += span;
		}
	})(center, -Math.PI / 2, Math.PI * 1.5, g.layGuard);

	for (let d = 1; d <= maxRel; d++) {
		const k = Math.pow(d / maxRel, 0.85);
		for (let a = 0; a < Math.PI * 2; a += 0.02) if (Math.floor(a * 60) % 4 === 0) dot(cx + Math.cos(a) * RX * k, cy + Math.sin(a) * RY * k, "borderMuted", 0);
	}
	if (virtualRoot) g.all.push(virtualRoot);
	for (const node of nodes) g.all.push(node);
	for (const node of g.all) {
		const parentId = node === virtualRoot ? undefined : node.parentId ?? (virtualRoot ? virtualRoot.id : undefined);
		if (!parentId) continue;
		const ai = g.pos.get(parentId);
		const bi = g.pos.get(node.id);
		if (ai === undefined || bi === undefined) continue;
		const ax = g.posX[ai]!;
		const ay = g.posY[ai]!;
		const bx = g.posX[bi]!;
		const by = g.posY[bi]!;
		const dist = hypot2(bx - ax, by - ay);
		const col = node.status === "running" ? roleColor(node.role) : node.status === "failed" ? "error" : "borderMuted";
		for (let t = 0; t < dist; t += 1.7) dot(ax + ((bx - ax) * t) / dist, ay + ((by - ay) * t) / dist, col, 1);
	}
	let maxTokens = 1;
	for (const node of nodes) if (node.tokens > maxTokens) maxTokens = node.tokens;
	for (const node of g.all) {
		const index = g.pos.get(node.id);
		if (index === undefined) continue;
		const x = g.posX[index]!;
		const y = g.posY[index]!;
		const isCenter = node === center;
		const col = isCenter ? roleColor(node.role) : nodeToken(node);
		let rad = isCenter ? Math.max(2, Math.min(5, PH / 14)) : Math.max(node.status === "failed" ? 1.5 : 0.8, 0.8 + Math.sqrt(node.tokens / maxTokens) * Math.min(4, PH / 16));
		g.radii.set(node.id, rad);
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
		// D13: record what was just painted, before the selection ring inflates `rad`
		// (+3 is a halo, not the disc). The virtual root is the run, not a node: it has
		// no id the host could open, so it is deliberately not clickable.
		if (discs && node !== virtualRoot) {
			const n = discs.count;
			discs.ids[n] = node.id;
			discs.xs[n] = x;
			discs.ys[n] = y;
			discs.rxs[n] = rad * xs;
			discs.rys[n] = rad;
			discs.count = n + 1;
		}
		for (let yy = -Math.ceil(rad); yy <= Math.ceil(rad); yy++) {
			for (let xx = -Math.ceil(rad * xs); xx <= Math.ceil(rad * xs); xx++) {
				if (hypot2(xx / xs, yy) <= rad) dot(x + xx, y + yy, col, 3);
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
			if (cell.m) cv.set(r.x + i, r.y + j, BRAILLE_GLYPHS[cell.m]!, cell.col);
		}
	}
	// Labels: selected, center, depth-1 live, failed, and the heaviest running agents.
	for (const node of nodes) if (node.status === "running" && isAgent(node)) g.running.push(node.tokens);
	g.running.sort((a, b) => b - a);
	const heavy = g.running[Math.min(g.running.length - 1, 4)] ?? Number.POSITIVE_INFINITY;
	for (const node of g.all) {
		if (
			node.id === selectedId || node === center || node.status === "failed" ||
			((g.rel.get(node.id) ?? 9) <= 1 && node.status !== "retired") ||
			(node.status === "running" && node.tokens >= heavy)
		) g.candidates.push(node);
	}
	g.candidates.sort((a, b) =>
		Number(b.id === selectedId) - Number(a.id === selectedId) ||
		Number(b === center) - Number(a === center) ||
		b.tokens - a.tokens,
	);
	const free = (x: number, y: number, w: number): boolean => {
		if (!(x >= r.x && x + w <= r.x + r.w && y >= r.y && y < r.y + CH)) return false;
		for (let i = 0; i < g.occCount; i++) {
			const oy = g.occY[i]!;
			const ox = g.occX[i]!;
			const ow = g.occW[i]!;
			if (oy === y && x < ox + ow + 1 && ox < x + w + 1) return false;
		}
		return true;
	};
	for (const node of g.candidates) {
		const index = g.pos.get(node.id);
		if (index === undefined) continue;
		const px0 = g.posX[index]!;
		const py0 = g.posY[index]!;
		const lx = r.x + Math.round(px0 / 2);
		const ly = r.y + Math.round(py0 / 4);
		const label = ellipsize(node.name + (node.status === "failed" ? " ✗" : ""), Math.max(4, Math.floor(r.w / 3)));
		const len = cellWidth(label);
		const rw = Math.ceil((g.radii.get(node.id) ?? 1) * (node === center ? 1.6 : 1) / 2) + (node.id === selectedId ? 3 : 1);
		const right = px0 >= cx - 4;
		const sides = right ? SIDES_RIGHT : SIDES_LEFT;
		let placed = false;
		for (let di = 0; di < LABEL_DY.length && !placed; di++) {
			const dy = LABEL_DY[di]!;
			for (let si = 0; si < sides.length; si++) {
				const side = sides[si]!;
				const sx = side > 0 ? lx + rw : lx - rw - len;
				if (!free(sx, ly + dy, len)) continue;
				const selected = node.id === selectedId;
				cv.text(sx, ly + dy, label, node === center ? roleColor(node.role) : nodeToken(node), selected ? LABEL_STYLE_SELECTED : LABEL_STYLE);
				g.occX[g.occCount] = sx;
				g.occY[g.occCount] = ly + dy;
				g.occW[g.occCount] = len;
				g.occCount += 1;
				placed = true;
				break;
			}
		}
	}
	// Legend: roles that actually appear (dynamic), then status hints.
	// Reserve room for failed/retired glyphs first so a narrow panel still matches live scout (#102/#125).
	const legendY = r.y + r.h - 1;
	let legendX = r.x + 1;
	for (const node of dfsOrder(nodes, kids)) if (isAgent(node) && !g.roles.includes(node.role)) g.roles.push(node.role);
	let hasFailed = false;
	let hasRetired = false;
	for (const node of nodes) {
		if (node.status === "failed") hasFailed = true;
		else if (node.status === "retired") hasRetired = true;
	}
	for (const item of STATUS_ITEMS) if (item[0] === "failed" ? hasFailed : hasRetired) g.statusItems.push(item);
	// Budget in grapheme cells (not String.length) so multi-byte / emoji labels do not squeeze roles (#128).
	let statusBudget = 0;
	for (const item of g.statusItems) statusBudget += cellWidth(item[1]) + 2;
	const roleLimit = r.x + r.w - 1 - statusBudget;
	for (const role of g.roles) {
		const w = cellWidth(role) + 4;
		if (legendX + w > roleLimit) break;
		cv.set(legendX, legendY, "⣿", roleColor(role));
		cv.text(legendX + 2, legendY, role, "dim");
		legendX += w;
	}
	for (const item of g.statusItems) {
		const label = item[1];
		const lw = cellWidth(label);
		if (legendX + lw + 1 > r.x + r.w - 1) break;
		cv.text(legendX, legendY, label, item[2]);
		legendX += lw + 2;
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
 * (tokensOut / generationMs / measured decodeMs — D8 adds the third so a
 * decode-only sample, e.g. a message closing with frozen token counters, still
 * moves the axis); wall-clock `now` alone does not scroll it.
 * `from` stays relative to that frozen `to` (earliest start, or to−60s).
 */
export function chartWindow(data: ViewData): { from: number; to: number } {
	// #364 S4: same answer as `Math.min(sampler.startedAt ?? now, ...agents.map(startedAt))`
	// without the filtered+projected array pair and the spread (both per frame),
	// and pointwise equal to it: the no-agent case still folds `data.now` into the
	// min (the old `starts.length ? starts : [data.now]`), and a NaN `startedAt`
	// still poisons the result because `Math.min` propagates NaN.
	let earliest = data.sampler.startedAt ?? data.now;
	let anyAgent = false;
	for (const node of data.nodes) {
		if (!isAgent(node)) continue;
		anyAgent = true;
		earliest = Math.min(earliest, node.startedAt);
	}
	if (!anyAgent) earliest = Math.min(earliest, data.now);
	const to = data.sampler.lastChangeAt ?? data.sampler.startedAt ?? data.now;
	return { from: Math.min(earliest, to - 60_000), to };
}

export function computeStats(data: ViewData, buckets: number, series?: RateSeries, window?: { from: number; to: number }): ChartStats {
	// #346: `drawChart` already resolved the frame's window (and bucketed it); take
	// it instead of re-deriving the same `(from, to)` — one `chartWindow` per frame.
	const { from, to } = window ?? chartWindow(data);
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
	// #364 S4: `[...roleTotals.entries()].map(...).sort(...)` built two throw-away
	// arrays per frame; the projection is the same, built once.
	const byRole: Array<{ role: string; tokens: number }> = [];
	for (const [role, tokens] of roleTotals) byRole.push({ role, tokens });
	byRole.sort((a, b) => b.tokens - a.tokens);
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
		byRole,
	};
}

const PARTIAL = [" ", "▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];

/**
 * #364 S4: the x-axis rule is `"└" + "─".repeat(plotW)` — a fresh 100–400B string
 * per frame for a value that only depends on the plot width. Keyed on that width
 * (contract I7: the key is the whole input), bounded because a page has a handful
 * of widths.
 */
const AXIS_RULES = new Map<number, string>();
const AXIS_RULES_MAX = 64;

function axisRule(width: number): string {
	const cached = AXIS_RULES.get(width);
	if (cached !== undefined) return cached;
	const rule = `└${"─".repeat(width)}`;
	if (AXIS_RULES.size >= AXIS_RULES_MAX) AXIS_RULES.clear();
	AXIS_RULES.set(width, rule);
	return rule;
}

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
	// Same gate as `drawGalaxy` (contract §3): they share `g`, so a chart painted
	// from inside a galaxy frame would read half-built containers.
	enterPanel("drawChart");
	try {
		g.begin(r);
		paintChart(cv, r, data, selected, wideStats);
	} finally {
		g.painting = false;
	}
}

/** `drawChart`'s body: the chart's containers are empty on entry (contract §2). */
function paintChart(cv: Canvas, r: Rect, data: ViewData, selected: VizNode | undefined, wideStats: boolean): void {
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
	const stats = computeStats(data, plotW, series, { from, to });
	const max = Math.max(1, stats.peak * 1.15);
	const rowsFor = (v: number): number => (v / max) * plotH;
	for (const entry of stats.byRole) g.chartRoles.push(entry.role);
	for (const role of series.byRole.keys()) if (!g.chartRoles.includes(role)) g.chartRoles.push(role);

	for (let i = 0; i < plotW; i++) {
		let acc = 0;
		g.bandCount = 0;
		for (let ri = 0; ri < g.chartRoles.length; ri++) {
			const role = g.chartRoles[ri]!;
			const value = series.byRole.get(role)?.[i] ?? 0;
			if (value <= 0) continue;
			acc += value;
			g.bandTop[g.bandCount] = rowsFor(acc);
			g.bandRole[g.bandCount] = role;
			g.bandCount += 1;
		}
		const top = rowsFor(acc);
		// The same two lookups the object array served: the first band whose top
		// covers the row centre, else the last band; and the topmost role for the
		// partial (▁▂▃…) cell.
		const lastRole = g.bandCount > 0 ? g.bandRole[g.bandCount - 1]! : undefined;
		for (let j = 0; j < plotH; j++) {
			const center = j + 0.5;
			const y = axisY - 1 - j;
			if (top >= j + 1) {
				let bandRole: string | undefined;
				for (let b = 0; b < g.bandCount; b++) {
					if (g.bandTop[b]! >= center) {
						bandRole = g.bandRole[b]!;
						break;
					}
				}
				if (bandRole === undefined) bandRole = lastRole;
				if (bandRole !== undefined) cv.set(plotX + i, y, "█", roleColor(bandRole));
			} else if (top > j) {
				const eighth = Math.round((top - j) * 8);
				if (eighth > 0) cv.set(plotX + i, y, PARTIAL[eighth]!, roleColor(lastRole ?? "worker"));
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
	cv.text(plotX - 1, axisY, axisRule(plotW), "borderMuted", { maxX: plotX + plotW });
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
		const roleRows = Math.min(stats.byRole.length, Math.max(0, roomForRoles));
		for (let ri = 0; ri < roleRows; ri++) {
			const entry = stats.byRole[ri]!;
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
	const rows = visibleListRows("log", r, events.length);
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
	const rowsAvail = visibleListRows("timing", r, rows.length);
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
	return innerListRows(Math.max(0, outerH - 2), total);
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
	const rowsAvail = visibleListRows("status", r, rows.length);

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
