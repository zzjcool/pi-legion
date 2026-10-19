/**
 * Live progress derived from Pi session JSONL for the parent status widget.
 * RPC v2 has one child kind, so there are no pane/title probes.
 */

import { isLastTurnComplete, parseSessionFile } from "./session.ts";
import type { ParsedSession } from "./types.ts";

export interface LiveProgress {
	model?: string;
	turns?: number;
	lastTools?: string[];
	/**
	 * Unix ms start of the latest turn, whether it is still in flight or has
	 * just settled. Absent when the session did not record a timestamp.
	 */
	currentTurnStartedAt?: number;
	/** Unix ms the latest turn settled. Absent while that turn is still in flight. */
	currentTurnEndedAt?: number;
	/** Cumulative input+cache+output (display totals; not used for tok/s). */
	usageTotal?: number;
	/** Cumulative output tokens only (numerator for tok/s). */
	tokensOut?: number;
	/**
	 * Prompt size of the last assistant message (`input+cacheRead+cacheWrite`):
	 * how full the context is right now, not a lifetime total. Absolute value
	 * only — session JSONL records no `contextWindow`, so there is no honest
	 * percentage to show.
	 */
	contextTokens?: number;
	/**
	 * Cumulative model-generation wall ms from the session (denominator for
	 * tok/s). See ParsedSession.generationMs.
	 */
	generationMs?: number;
}

export function progressFromSession(parsed: ParsedSession): LiveProgress {
	const lastTools = lastInflightTools(parsed);
	const lastTurn = parsed.turns.at(-1);
	const turnInFlight = lastTurn !== undefined && !isLastTurnComplete(parsed);
	const total = parsed.usage.input + parsed.usage.cacheRead + parsed.usage.cacheWrite + parsed.usage.output;
	const tokensOut = parsed.usage.output;
	return {
		...(parsed.model ? { model: parsed.model } : {}),
		...(parsed.turns.length > 0 ? { turns: parsed.turns.length } : {}),
		...(lastTools.length > 0 ? { lastTools } : {}),
		...turnClock(lastTurn, turnInFlight),
		...(total > 0 ? { usageTotal: total } : {}),
		...(tokensOut > 0 ? { tokensOut } : {}),
		...(parsed.lastContextTokens !== undefined && parsed.lastContextTokens > 0
			? { contextTokens: parsed.lastContextTokens }
			: {}),
		...(parsed.generationMs > 0 ? { generationMs: parsed.generationMs } : {}),
	};
}

/**
 * In-flight turns expose only a start, so the headline keeps ticking.
 * A completed turn with both timestamps freezes at `endedAt` until the next
 * user message replaces the turn. A completed turn missing either timestamp
 * has nothing to freeze.
 */
function turnClock(
	lastTurn: { startedAt?: number; endedAt?: number } | undefined,
	turnInFlight: boolean,
): Pick<LiveProgress, "currentTurnStartedAt" | "currentTurnEndedAt"> {
	if (lastTurn?.startedAt === undefined) return {};
	if (turnInFlight) return { currentTurnStartedAt: lastTurn.startedAt };
	if (lastTurn.endedAt === undefined) return {};
	return {
		currentTurnStartedAt: lastTurn.startedAt,
		currentTurnEndedAt: lastTurn.endedAt,
	};
}

export function progressFromSessionFile(file: string): LiveProgress {
	if (!file) return {};
	return progressFromSession(parseSessionFile(file));
}

/** Later sources win when they actually have a value. */
export function mergeProgress(...parts: Array<LiveProgress | undefined>): LiveProgress {
	const out: LiveProgress = {};
	for (const part of parts) {
		if (!part) continue;
		if (part.model) out.model = part.model;
		if (part.turns && part.turns > 0) out.turns = part.turns;
		if (part.lastTools?.length) out.lastTools = part.lastTools;
		if (part.currentTurnStartedAt !== undefined) {
			out.currentTurnStartedAt = part.currentTurnStartedAt;
			// A later in-flight turn has no end and must clear a frozen one.
			if (part.currentTurnEndedAt !== undefined) out.currentTurnEndedAt = part.currentTurnEndedAt;
			else delete out.currentTurnEndedAt;
		}
		if (part.usageTotal && part.usageTotal > 0) out.usageTotal = part.usageTotal;
		if (part.tokensOut && part.tokensOut > 0) out.tokensOut = part.tokensOut;
		if (part.contextTokens && part.contextTokens > 0) out.contextTokens = part.contextTokens;
		if (part.generationMs && part.generationMs > 0) out.generationMs = part.generationMs;
	}
	return out;
}

function lastInflightTools(parsed: ParsedSession): string[] {
	const last = parsed.turns.at(-1)?.assistants.at(-1);
	if (!last?.tools.length) return [];
	return [...new Set(last.tools)];
}
