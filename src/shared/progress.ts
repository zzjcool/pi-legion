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
	/** Unix ms start of the in-flight turn, when the session records it. */
	currentTurnStartedAt?: number;
}

export function progressFromSession(parsed: ParsedSession): LiveProgress {
	const lastTools = lastInflightTools(parsed);
	const lastTurn = parsed.turns.at(-1);
	const turnInFlight = lastTurn !== undefined && !isLastTurnComplete(parsed);
	return {
		...(parsed.model ? { model: parsed.model } : {}),
		...(parsed.turns.length > 0 ? { turns: parsed.turns.length } : {}),
		...(lastTools.length > 0 ? { lastTools } : {}),
		...(turnInFlight && lastTurn?.startedAt !== undefined
			? { currentTurnStartedAt: lastTurn.startedAt }
			: {}),
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
		if (part.currentTurnStartedAt !== undefined) out.currentTurnStartedAt = part.currentTurnStartedAt;
	}
	return out;
}

function lastInflightTools(parsed: ParsedSession): string[] {
	const last = parsed.turns.at(-1)?.assistants.at(-1);
	if (!last?.tools.length) return [];
	return [...new Set(last.tools)];
}
