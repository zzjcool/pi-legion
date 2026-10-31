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

	set(x: number, y: number, ch: string, color?: string, style: { bold?: boolean; inverse?: boolean } = NO_STYLE): void {
		const row = this.cells[y];
		if (!row || x < 0 || x >= this.width) return;
		const cell = row[x] as Cell;
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
		for (const ch of Array.from(value)) {
			if (col >= limit) break;
			if (col >= 0) this.set(col, y, ch, color, style);
			col++;
		}
		return col;
	}

	/** Agent types referenced by deferred `role:` colors in this canvas. */
	roles(): Set<string> {
		const roles = new Set<string>();
		for (const row of this.cells) for (const cell of row) {
			if (cell.color?.startsWith(ROLE_COLOR_PREFIX)) roles.add(cell.color.slice(ROLE_COLOR_PREFIX.length));
		}
		return roles;
	}

	toLines(theme: VizTheme, palette = resolveRolePalette(theme, this.roles())): string[] {
		const resolve = (color: string | undefined): string | undefined =>
			color?.startsWith(ROLE_COLOR_PREFIX) ? palette.get(color.slice(ROLE_COLOR_PREFIX.length)) ?? "text" : color;
		return this.cells.map((row) => renderRow(row.map((cell) => cell.color?.startsWith(ROLE_COLOR_PREFIX) ? { ...cell, color: resolve(cell.color) } : cell), theme));
	}

	toPlain(): string[] {
		return this.cells.map((row) => row.map((cell) => cell.ch).join(""));
	}
}

/** Shared empty style so a `set(x, y, ch)` call allocates no default object. */
const NO_STYLE: { bold?: boolean; inverse?: boolean } = {};

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

/** Grapheme / cell count (UTF-16-safe). Prefer over `String.length` for layout budgets. */
export function cellWidth(value: string): number {
	return Array.from(value).length;
}

/** Truncate plain text to `width` single-width cells with an ellipsis. */
export function ellipsize(value: string, width: number): string {
	const chars = Array.from(value).map(sanitizeChar);
	if (width <= 0) return "";
	if (chars.length <= width) return chars.join("");
	return `${chars.slice(0, Math.max(0, width - 1)).join("")}…`;
}

function renderRow(row: Cell[], theme: VizTheme): string {
	let out = "";
	let i = 0;
	while (i < row.length) {
		const start = row[i]!;
		let text = "";
		while (
			i < row.length &&
			row[i]!.color === start.color &&
			!!row[i]!.bold === !!start.bold &&
			!!row[i]!.inverse === !!start.inverse
		) {
			text += row[i]!.ch;
			i++;
		}
		let styled = start.color && text.trim().length > 0 ? theme.fg(start.color, text) : text;
		if (start.bold && theme.bold) styled = theme.bold(styled);
		if (start.inverse && theme.inverse) styled = theme.inverse(styled);
		out += styled;
	}
	return out;
}
