/**
 * Role → pi theme token mapping. Colors are always theme tokens (never hex),
 * so the visualization follows `/theme` changes automatically.
 */

import type { VizNode, VizStatus } from "./model.ts";

export interface VizTheme {
	fg(color: string, text: string): string;
	bg?(color: string, text: string): string;
	bold?(text: string): string;
	inverse?(text: string): string;
	getFgAnsi?(color: string): string;
}

export const ROLE_TOKENS: Readonly<Record<string, string>> = {
	centurion: "accent",
	planner: "syntaxKeyword",
	worker: "syntaxVariable",
	scout: "syntaxNumber",
	reviewer: "syntaxFunction",
	advisor: "syntaxString",
};

/** Fallback pool for roles that are not in the table (deterministic hash pick). */
export const FALLBACK_TOKENS = [
	"syntaxType",
	"syntaxString",
	"syntaxFunction",
	"syntaxNumber",
	"syntaxKeyword",
	"syntaxVariable",
	"syntaxOperator",
] as const;

function hash(value: string): number {
	let h = 2166136261;
	for (let i = 0; i < value.length; i++) {
		h ^= value.charCodeAt(i);
		h = Math.imul(h, 16777619);
	}
	return h >>> 0;
}

export function roleToken(role: string): string {
	const key = role.toLowerCase();
	return ROLE_TOKENS[key] ?? FALLBACK_TOKENS[hash(key) % FALLBACK_TOKENS.length]!;
}

/** Prefix marking a cell color as "the color of this agent type", resolved per theme at paint time. */
export const ROLE_COLOR_PREFIX = "role:";

/** Deferred per-type color; resolved by `resolveRolePalette` when a canvas is painted. */
export function roleColor(role: string): string {
	// The ledger root is the user's own pi session, not an agent type: keep it
	// neutral so it never takes a type's color (centurion owns accent).
	if (role.toLowerCase() === "root") return "text";
	return `${ROLE_COLOR_PREFIX}${role.toLowerCase()}`;
}

/**
 * Extra theme tokens tried, in order, when a type's preferred token renders
 * with the same ANSI color as a type already assigned. pi's `system` theme in
 * its palette-index tier (terminal reported no palette) maps accent AND
 * syntaxNumber to ANSI slot 5, so centurion and scout were both magenta.
 */
export const DISTINCT_FALLBACK_TOKENS = [
	"syntaxKeyword",
	"syntaxVariable",
	"syntaxNumber",
	"syntaxFunction",
	"syntaxString",
	"syntaxType",
	"success",
	"warning",
	"accent",
	"mdLink",
	"mdHeading",
	"mdCode",
	"thinkingHigh",
	"thinkingMedium",
	"toolDiffAdded",
	"bashMode",
] as const;

/** ANSI prefix a token renders with. */
export function tokenAnsi(theme: VizTheme, token: string): string {
	try {
		if (typeof theme.getFgAnsi === "function") return theme.getFgAnsi(token);
		return theme.fg(token, "\u0000").split("\u0000")[0] ?? token;
	} catch {
		return `?${token}`;
	}
}

type Swatch = { kind: "rgb"; l: number; a: number; b: number } | { kind: "key"; key: string };

function xterm256(n: number): [number, number, number] {
	if (n >= 232) {
		const v = 8 + 10 * (n - 232);
		return [v, v, v];
	}
	const i = n - 16;
	const step = [0, 95, 135, 175, 215, 255];
	return [step[Math.floor(i / 36)]!, step[Math.floor(i / 6) % 6]!, step[i % 6]!];
}

function oklab(r: number, g: number, b: number): Swatch {
	const lin = (c: number) => {
		const v = c / 255;
		return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
	};
	const [R, G, B] = [lin(r), lin(g), lin(b)];
	const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
	const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
	const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
	return {
		kind: "rgb",
		l: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
		a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
		b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
	};
}

/**
 * What a token actually looks like: an OKLab color for truecolor / 256-color
 * output, or an opaque key for the 16 terminal-defined palette slots (whose
 * real color is unknown, so only the same slot counts as equal).
 */
export function tokenSwatch(theme: VizTheme, token: string): Swatch {
	const ansi = tokenAnsi(theme, token);
	const rgb = /38;2;(\d+);(\d+);(\d+)/.exec(ansi);
	if (rgb) return oklab(Number(rgb[1]), Number(rgb[2]), Number(rgb[3]));
	const idx = /38;5;(\d+)/.exec(ansi);
	if (idx && Number(idx[1]) >= 16) return oklab(...xterm256(Number(idx[1])));
	const basic = /(?:^|\[|;)(3[0-7]|9[0-7])m/.exec(ansi);
	return { kind: "key", key: idx ? `p${idx[1]}` : basic ? `b${basic[1]}` : ansi };
}

/** OKLab distance below which two colors read as the same (~JND); pi's own dark/light role tokens are >= 0.04 apart, the system-theme accent/syntaxNumber clash is ~0.002. */
export const MIN_TYPE_COLOR_DISTANCE = 0.025;

export function swatchesClash(x: Swatch, y: Swatch): boolean {
	if (x.kind === "key" || y.kind === "key") return x.kind === y.kind && (x as { key: string }).key === (y as { key: string }).key;
	return Math.hypot(x.l - y.l, x.a - y.a, x.b - y.b) < MIN_TYPE_COLOR_DISTANCE;
}

const ROLE_ORDER = Object.keys(ROLE_TOKENS);

/**
 * Map each agent type present to a theme token so that, where the theme can
 * tell them apart, no two types share an on-screen color (nor the failed /
 * retired colors). Known types are assigned first in table order so their
 * preferred tokens win; the rest follow alphabetically (deterministic).
 */
export function resolveRolePalette(theme: VizTheme, roles: Iterable<string>): Map<string, string> {
	const unique = [...new Set([...roles].map((role) => role.toLowerCase()))].sort((a, b) => {
		const ia = ROLE_ORDER.indexOf(a);
		const ib = ROLE_ORDER.indexOf(b);
		return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
	});
	// Compare what the colors LOOK like, not their escape bytes: pi's system
	// theme derives accent and syntaxNumber from the same palette slot, giving
	// e.g. #b38eb9 vs #b38fb8 in truecolor — different bytes, same pink.
	const used: Swatch[] = [tokenSwatch(theme, "error"), tokenSwatch(theme, "dim")];
	const out = new Map<string, string>();
	for (const role of unique) {
		const preferred = roleToken(role);
		const candidates = [preferred, ...FALLBACK_TOKENS.slice(hash(role) % FALLBACK_TOKENS.length), ...DISTINCT_FALLBACK_TOKENS];
		const pick = candidates.find((token) => {
			const swatch = tokenSwatch(theme, token);
			return !used.some((other) => swatchesClash(swatch, other));
		}) ?? preferred;
		used.push(tokenSwatch(theme, pick));
		out.set(role, pick);
	}
	return out;
}

export function statusToken(role: string, status: VizStatus): string {
	if (status === "failed") return "error";
	if (status === "retired") return "dim";
	return roleColor(role);
}

export function nodeToken(node: Pick<VizNode, "role" | "status">): string {
	return statusToken(node.role, node.status);
}
