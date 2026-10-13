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
	root: "accent",
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

/** ANSI prefix a token renders with (used to detect identical-looking tokens). */
export function tokenAnsi(theme: VizTheme, token: string): string {
	try {
		if (typeof theme.getFgAnsi === "function") return theme.getFgAnsi(token);
		return theme.fg(token, "\u0000").split("\u0000")[0] ?? token;
	} catch {
		return `?${token}`;
	}
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
	const used = new Set([tokenAnsi(theme, "error"), tokenAnsi(theme, "dim")]);
	const out = new Map<string, string>();
	for (const role of unique) {
		const preferred = roleToken(role);
		const candidates = [preferred, ...FALLBACK_TOKENS.slice(hash(role) % FALLBACK_TOKENS.length), ...DISTINCT_FALLBACK_TOKENS];
		const pick = candidates.find((token) => !used.has(tokenAnsi(theme, token))) ?? preferred;
		used.add(tokenAnsi(theme, pick));
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
