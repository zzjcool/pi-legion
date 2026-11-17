/**
 * `pi --list-models` — reading and matching the registry listing.
 *
 * Two call sites need the same answer to "does that `pi` see this model?":
 *
 *   - `/legion doctor` compares the HOST's listing against the CHILD's
 *     (`legion-doctor.ts`, #212/#329) and prints what is missing;
 *   - a cross-machine launch asks the child's own argv before it starts a
 *     terminal (`remote.ts`, startup probe, S5.6).
 *
 * The parser and the matcher live here, in one copy, because a probe that
 * disagreed with doctor about what "the model is visible" means would report
 * two different machines as broken depending on which one you asked.
 */

import { splitThinkingSuffix } from "../agents/model-scope.ts";

export function parseListModels(output: string): string[] {
	const lines = output.split(/\r?\n/);
	const models: string[] = [];
	for (const line of lines) {
		if (/^provider\b/i.test(line) || !line.trim()) continue;
		if (/^No models available/i.test(line)) return [];
		const m = /^(\S+)\s+(\S+)\s+/.exec(line);
		if (!m) continue;
		const provider = m[1];
		const id = m[2];
		if (provider === "provider" || id === "model") continue;
		models.push(`${provider}/${id}`);
	}
	return models;
}

/**
 * Is `expected` present in the registry listing?
 *
 * The model id may carry a `:thinking` suffix, and only a KNOWN level is one
 * (`splitThinkingSuffix`, D-R8.3). The previous "drop the last `:` segment" rule
 * was a third, disagreeing definition of the same thing: it truncated
 * `provider/model:variant` — a real id whose `variant` segment is part of the
 * model — and then reported a model as missing that the host actually serves.
 */
export function modelMatches(expected: string, available: readonly string[]): boolean {
	const e = splitThinkingSuffix(expected).baseModel;
	if (available.includes(e)) return true;
	return available.some((a) => a === e || a.endsWith(`/${e}`) || a.split("/").slice(1).join("/") === e);
}
