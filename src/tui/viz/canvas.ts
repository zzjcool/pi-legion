/** Tiny cell grid: every cell is one terminal column wide, so widths are exact. */

import { ROLE_COLOR_PREFIX, resolveRolePalette, type VizTheme } from "./palette.ts";

export interface Cell {
	ch: string;
	color?: string;
	bold?: boolean;
	inverse?: boolean;
}

/**
 * #362: the grid owns `width × height` mutable cells, allocated once in the
 * constructor. `set()` writes through to the existing cell instead of building
 * a fresh object per write (measured 52–128 B/write, 4,583–9,691 writes/frame).
 *
 * Consequence for readers: `get()` and `cells` are a **live view**, not a
 * snapshot. A cell object returned by `get()` is re-written in place by the next
 * `set()` on that coordinate, so hold the value (`cell.ch`), never the object.
 */
export class Canvas {
	readonly width: number;
	readonly height: number;
	readonly cells: Cell[][];

	/**
	 * #364: agent types painted into this grid, as live counts, maintained by
	 * `set()` instead of scanning all `W×H` cells at paint time. `roles()` used to
	 * walk every cell (12,000 at 200×60) and `slice()` a string per role-coloured
	 * cell — measured ~75KB/frame, none of it information.
	 *
	 * Contract T5: this table must match the grid exactly. A role that is no
	 * longer painted (its cell overwritten) changes how `resolveRolePalette`
	 * assigns colours to the roles that ARE painted, so `set()` decrements the
	 * role it replaced and `reset()` zeroes the table. Counts are never deleted —
	 * keys are stable role names, so a `set()` on an existing key allocates
	 * nothing (contract T7: `set()` must not start allocating again).
	 */
	private readonly roleCounts = new Map<string, number>();

	constructor(width: number, height: number) {
		this.width = Math.max(0, Math.floor(width));
		this.height = Math.max(0, Math.floor(height));
		const cells: Cell[][] = new Array(this.height);
		for (let y = 0; y < this.height; y++) {
			const row: Cell[] = new Array(this.width);
			for (let x = 0; x < this.width; x++) row[x] = { ch: " " } as Cell;
			cells[y] = row;
		}
		this.cells = cells;
	}

	/** Live cell at `(x, y)` — re-written in place by the next `set()`. Do not retain it. */
	get(x: number, y: number): Cell | undefined {
		return this.cells[y]?.[x];
	}

	/**
	 * #364 A5: blank every cell in place (and forget the roles) so one canvas can
	 * paint frame after frame. The cell OBJECTS survive — `get()`/`cells` stay a
	 * live view of the same grid (contract I5) — and the cost is W×H field writes
	 * instead of W×H fresh objects (+190KB/472KB per frame).
	 *
	 * Only `view.ts`'s production render path may use this; `new Canvas(W, H)`
	 * keeps its exact old semantics and cost.
	 */
	reset(): void {
		for (let y = 0; y < this.height; y++) {
			const row = this.cells[y]!;
			for (let x = 0; x < this.width; x++) {
				const cell = row[x]!;
				cell.ch = " ";
				cell.color = undefined;
				cell.bold = undefined;
				cell.inverse = undefined;
			}
		}
		for (const role of this.roleCounts.keys()) this.roleCounts.set(role, 0);
	}

	set(x: number, y: number, ch: string, color?: string, style: { bold?: boolean; inverse?: boolean } = NO_STYLE): void {
		const row = this.cells[y];
		if (!row || x < 0 || x >= this.width) return;
		const cell = row[x] as Cell;
		// #364: keep the painted-role table in step with the grid. Both lookups are
		// memoized/`startsWith`-only, so this stays allocation-free.
		const nextRole = roleIdOf(color);
		const prevRole = roleIdOf(cell.color);
		if (nextRole !== prevRole) {
			if (prevRole !== undefined) this.roleCounts.set(prevRole, (this.roleCounts.get(prevRole) ?? 0) - 1);
			if (nextRole !== undefined) this.roleCounts.set(nextRole, (this.roleCounts.get(nextRole) ?? 0) + 1);
		}
		// Explicit field writes: an object spread here would allocate an intermediate
		// object per write, which is the whole cost #362 is removing.
		cell.ch = sanitizeChar(ch);
		cell.color = color;
		cell.bold = style.bold;
		cell.inverse = style.inverse;
	}

	/** Write text clipped to [x, maxX). Returns the column after the last written cell. */
	text(x: number, y: number, value: string, color?: string, style: { bold?: boolean; inverse?: boolean; maxX?: number } = {}): number {
		const limit = Math.min(this.width, style.maxX ?? this.width);
		let col = x;
		// #364: walk code points by index instead of `Array.from(value)` — the old
		// loop allocated one throw-away array per written string, and the galaxy
		// writes ~100 label strings and the legend per frame. Surrogate pairs are
		// the only case that still builds a string, and `sanitizeChar` collapses
		// them exactly as it did before.
		for (let i = 0; i < value.length; i++) {
			let ch = value[i] as string;
			const code = value.charCodeAt(i);
			if (code >= 0xd800 && code <= 0xdbff && i + 1 < value.length) {
				const low = value.charCodeAt(i + 1);
				if (low >= 0xdc00 && low <= 0xdfff) {
					ch = value.slice(i, i + 2);
					i++;
				}
			}
			if (col >= limit) break;
			if (col >= 0) this.set(col, y, ch, color, style);
			col++;
		}
		return col;
	}

	/** Agent types referenced by deferred `role:` colors in this canvas. */
	roles(): Set<string> {
		return new Set(this.roleList());
	}

	/**
	 * Present roles, in the order they were first written. `toLines` composes the
	 * palette cache key from this, so it has to be exactly the set of roles still
	 * on the grid (contract T5) — a count of 0 means the role was overwritten.
	 */
	private roleList(): string[] {
		const out: string[] = [];
		for (const [role, count] of this.roleCounts) if (count > 0) out.push(role);
		return out;
	}

	/**
	 * #364 (contract T5): a palette is a function of the theme **and** of exactly
	 * the roles this canvas paints — dropping a role changes which token the
	 * remaining ones get. Both parts are in the key, so a stale palette can never
	 * be returned; the cache only ever saves the `resolveRolePalette` work
	 * (`tokenSwatch` regexes over every candidate token) for an unchanged frame.
	 */
	private rolePalette(theme: VizTheme): Map<string, string> {
		let byTheme = PALETTES.get(theme);
		if (!byTheme) {
			byTheme = new Map();
			PALETTES.set(theme, byTheme);
		}
		const roles = this.roleList().sort();
		const key = roles.join(",");
		const cached = byTheme.get(key);
		if (cached) return cached;
		const resolved = resolveRolePalette(theme, roles);
		if (byTheme.size >= PALETTE_CACHE_MAX) byTheme.clear();
		byTheme.set(key, resolved);
		return resolved;
	}

	toLines(theme: VizTheme, palette?: Map<string, string>): string[] {
		const colors = palette ?? this.rolePalette(theme);
		const lines: string[] = new Array(this.height);
		for (let y = 0; y < this.height; y++) lines[y] = renderRow(this.cells[y]!, theme, colors);
		return lines;
	}

	toPlain(): string[] {
		const lines: string[] = new Array(this.height);
		for (let y = 0; y < this.height; y++) {
			const row = this.cells[y]!;
			const width = row.length;
			PLAIN_CHARS.length = width;
			for (let x = 0; x < width; x++) PLAIN_CHARS[x] = row[x]!.ch;
			lines[y] = PLAIN_CHARS.join("");
		}
		return lines;
	}
}

/** Shared empty style so a `set(x, y, ch)` call allocates no default object. */
const NO_STYLE: { bold?: boolean; inverse?: boolean } = {};

/** Palette cache bound: one theme × one role set is a handful of entries. */
const PALETTE_CACHE_MAX = 32;
const PALETTES = new WeakMap<VizTheme, Map<string, Map<string, string>>>();

/**
 * `role:worker` → `worker`, memoized so `set()` can keep the painted-role table
 * without allocating a slice per write (contract T7). Bounded: the value side is
 * a role name, of which a run has a handful.
 */
const ROLE_IDS = new Map<string, string>();
const ROLE_IDS_MAX = 512;

function roleIdOf(color: string | undefined): string | undefined {
	if (color === undefined || !color.startsWith(ROLE_COLOR_PREFIX)) return undefined;
	const cached = ROLE_IDS.get(color);
	if (cached !== undefined) return cached;
	const id = color.slice(ROLE_COLOR_PREFIX.length);
	if (ROLE_IDS.size >= ROLE_IDS_MAX) ROLE_IDS.clear();
	ROLE_IDS.set(color, id);
	return id;
}

/**
 * Keep cells single-width: wide/control characters become a placeholder.
 *
 * #362: memoized per input char. `String.fromCodePoint` allocates a fresh string
 * for every code point outside Latin-1, and the chart/galaxy paint `█ ⣿ ─` tens of
 * thousands of times per frame — without this cache `set()` would still allocate
 * one string per write. The table is bounded (terminal cell glyphs are a small set)
 * and cleared if a pathological caller ever feeds it thousands of distinct chars.
 */
const SANITIZED = new Map<string, string>();
const SANITIZED_MAX = 4096;

export function sanitizeChar(ch: string): string {
	const hit = SANITIZED.get(ch);
	if (hit !== undefined) return hit;
	const out = sanitizeUncached(ch);
	if (SANITIZED.size >= SANITIZED_MAX) SANITIZED.clear();
	SANITIZED.set(ch, out);
	return out;
}

function sanitizeUncached(ch: string): string {
	if (ch.length === 0) return " ";
	const code = ch.codePointAt(0)!;
	if (code < 0x20 || (code >= 0x7f && code < 0xa0)) return " ";
	if (isWide(code)) return "?";
	return String.fromCodePoint(code);
}

function isWide(code: number): boolean {
	return (
		(code >= 0x1100 && code <= 0x115f) ||
		(code >= 0x2e80 && code <= 0xa4cf) ||
		(code >= 0xac00 && code <= 0xd7a3) ||
		(code >= 0xf900 && code <= 0xfaff) ||
		(code >= 0xfe30 && code <= 0xfe4f) ||
		(code >= 0xff00 && code <= 0xff60) ||
		(code >= 0xffe0 && code <= 0xffe6) ||
		(code >= 0x1f300 && code <= 0x1faff) ||
		(code >= 0x20000 && code <= 0x3fffd)
	);
}

/** Length of the code point at `i`, in UTF-16 units (2 only for a surrogate pair). */
function codePointLength(value: string, i: number): number {
	const code = value.charCodeAt(i);
	if (code >= 0xd800 && code <= 0xdbff && i + 1 < value.length) {
		const low = value.charCodeAt(i + 1);
		if (low >= 0xdc00 && low <= 0xdfff) return 2;
	}
	return 1;
}

/** The code point starting at `i` as a string (a lone surrogate comes back as itself). */
function codePointAt(value: string, i: number): string {
	return codePointLength(value, i) === 2 ? value.slice(i, i + 2) : (value[i] as string);
}

/** Grapheme / cell count (UTF-16-safe). Prefer over `String.length` for layout budgets. */
export function cellWidth(value: string): number {
	// #364: same answer as `Array.from(value).length` without materialising the array.
	let count = 0;
	for (let i = 0; i < value.length; i += codePointLength(value, i)) count++;
	return count;
}

/** Truncate plain text to `width` single-width cells with an ellipsis. */
export function ellipsize(value: string, width: number): string {
	if (width <= 0) return "";
	if (cellWidth(value) <= width) return sanitizeAll(value);
	const keep = Math.max(0, width - 1);
	let out = "";
	let taken = 0;
	for (let i = 0; i < value.length && taken < keep; i += codePointLength(value, i)) {
		out += sanitizeChar(codePointAt(value, i));
		taken++;
	}
	return `${out}…`;
}

/**
 * `Array.from(value).map(sanitizeChar).join("")`, but returns `value` untouched
 * when nothing needs sanitising — which is the common case (agent names, role
 * names, legend labels) and what keeps `ellipsize` allocation-free there.
 * #364 A2/A3: the old version built a per-code-point array + string for every
 * label on every frame.
 */
function sanitizeAll(value: string): string {
	let changed = false;
	for (let i = 0; i < value.length; i += codePointLength(value, i)) {
		const raw = codePointAt(value, i);
		if (sanitizeChar(raw) !== raw) {
			changed = true;
			break;
		}
	}
	if (!changed) return value;
	let out = "";
	for (let i = 0; i < value.length; i += codePointLength(value, i)) out += sanitizeChar(codePointAt(value, i));
	return out;
}

/**
 * One row of cells → one terminal line.
 *
 * #364 A3: the role colours are resolved here, from the palette, instead of
 * copying every role-coloured cell into a `{...cell, color}` clone first
 * (measured 1,123/1,865 clones × 70–72B per frame). Runs are still merged on the
 * RESOLVED colour, which is what the clone-then-merge did — two role cells whose
 * tokens collide must stay one run, exactly as before.
 *
 * Contract T6: `theme.fg` is applied only to a run that has a colour AND at
 * least one non-whitespace glyph (the old `text.trim().length > 0`), because the
 * page floor relies on a row's trailing bare spaces carrying no SGR.
 */
function renderRow(row: Cell[], theme: VizTheme, palette: Map<string, string>): string {
	let out = "";
	let i = 0;
	const cells = row.length;
	while (i < cells) {
		const first = row[i]!;
		const startColor = resolvedColor(first, palette);
		const bold = !!first.bold;
		const inverse = !!first.inverse;
		let end = i + 1;
		while (end < cells) {
			const cell = row[end]!;
			if (!!cell.bold !== bold || !!cell.inverse !== inverse || resolvedColor(cell, palette) !== startColor) break;
			end++;
		}
		const len = end - i;
		// The run's text, with as few objects as its shape allows. `text += ch` per
		// cell builds one ConsString per append — ~9.6k appends per 200x60 frame,
		// measured 230KB — and one `join()` per run costs ~8B per char. Length-1 runs
		// reuse the cell's own string, an all-same run collapses to one `repeat()`
		// (page-floor row tails, borders, solid braille fills), and everything else
		// goes through the reused buffer.
		let text: string;
		if (len === 1) {
			text = first.ch;
		} else {
			let uniform = true;
			for (let k = i + 1; k < end; k++) {
				if (row[k]!.ch !== first.ch) {
					uniform = false;
					break;
				}
			}
			if (uniform) {
				text = first.ch.repeat(len);
			} else if (len === 2) {
				text = first.ch + row[i + 1]!.ch;
			} else {
				ROW_CHARS.length = len;
				for (let k = 0; k < len; k++) ROW_CHARS[k] = row[i + k]!.ch;
				text = ROW_CHARS.join("");
			}
		}
		let visible = false;
		if (startColor !== undefined) {
			for (let k = i; k < end; k++) {
				if (isVisible(row[k]!.ch)) {
					visible = true;
					break;
				}
			}
		}
		i = end;
		let styled = startColor && visible ? theme.fg(startColor, text) : text;
		if (bold && theme.bold) styled = theme.bold(styled);
		if (inverse && theme.inverse) styled = theme.inverse(styled);
		out += styled;
	}
	return out;
}

/**
 * Reusable per-row buffers (#364, contract A1).
 *
 * `line += cell.ch` looks free but builds one ConsString per append: a 200-cell
 * row cost ~288KB/frame for `toPlain` alone (measured 373KB against 12KB of
 * actual text). Pushing into a reused array and joining once per row keeps the
 * allocation proportional to the row's length instead of its cell count.
 * Neither painter is reentrant, and `toPlain` uses its own buffer so the two can
 * never interleave.
 */
const ROW_CHARS: string[] = [];
const PLAIN_CHARS: string[] = [];

/** A cell's colour with `role:` tokens resolved through the palette. */
function resolvedColor(cell: Cell, palette: Map<string, string>): string | undefined {
	const color = cell.color;
	if (color === undefined) return undefined;
	const role = roleIdOf(color);
	return role === undefined ? color : palette.get(role) ?? "text";
}

/** `text.trim().length > 0` for one glyph, without building the trimmed string. */
function isVisible(ch: string): boolean {
	for (let i = 0; i < ch.length; i++) if (!isWhitespaceCode(ch.charCodeAt(i))) return true;
	return false;
}

/** The code points `String.prototype.trim` strips (same set as regex `\s`). */
function isWhitespaceCode(code: number): boolean {
	if (code === 0x20) return true;
	if (code < 0x09 || (code > 0x0d && code < 0xa0)) return false;
	return (
		code === 0x09 || code === 0x0a || code === 0x0b || code === 0x0c || code === 0x0d ||
		code === 0xa0 || code === 0x1680 || (code >= 0x2000 && code <= 0x200a) ||
		code === 0x2028 || code === 0x2029 || code === 0x202f || code === 0x205f ||
		code === 0x3000 || code === 0xfeff
	);
}
