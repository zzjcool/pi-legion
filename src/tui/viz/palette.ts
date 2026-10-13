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

export function statusToken(role: string, status: VizStatus): string {
	if (status === "failed") return "error";
	if (status === "retired") return "dim";
	return roleToken(role);
}

export function nodeToken(node: Pick<VizNode, "role" | "status">): string {
	return statusToken(node.role, node.status);
}
