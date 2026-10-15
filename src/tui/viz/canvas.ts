/** Tiny cell grid: every cell is one terminal column wide, so widths are exact. */

import { ROLE_COLOR_PREFIX, resolveRolePalette, type VizTheme } from "./palette.ts";

export interface Cell {
	ch: string;
	color?: string;
	bold?: boolean;
	inverse?: boolean;
}

export class Canvas {
	readonly width: number;
	readonly height: number;
	readonly cells: Cell[][];

	constructor(width: number, height: number) {
		this.width = Math.max(0, Math.floor(width));
		this.height = Math.max(0, Math.floor(height));
		this.cells = Array.from({ length: this.height }, () =>
			Array.from({ length: this.width }, () => ({ ch: " " }) as Cell),
		);
	}

	get(x: number, y: number): Cell | undefined {
		return this.cells[y]?.[x];
	}

	set(x: number, y: number, ch: string, color?: string, style: { bold?: boolean; inverse?: boolean } = {}): void {
		const row = this.cells[y];
		if (!row || x < 0 || x >= this.width) return;
		row[x] = { ch: sanitizeChar(ch), color, ...style };
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

/** Keep cells single-width: wide/control characters become a placeholder. */
export function sanitizeChar(ch: string): string {
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
