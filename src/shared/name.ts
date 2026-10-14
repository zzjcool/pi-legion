/**
 * herdr agent-name generation.
 *
 * F17: herdr requires names matching `[a-z][a-z0-9_-]{0,31}` (lowercase,
 * no spaces, at most 32 chars). F16: names are freed on exit and reusable,
 * but `agent_name_taken` while the agent is alive.
 */

const MAX_NAME_LENGTH = 32;
const VALID_NAME = /^[a-z][a-z0-9_-]{0,31}$/;

// Intent-named predicate over the herdr name grammar (F17): the regex is an
// implementation detail, and callers (and tests) should not have to reach for
// it. Not a type predicate, so it narrows nothing — it exists to name the rule.
// pi-lens-ignore: pass-through-wrappers
export function isValidAgentName(name: string): boolean {
	return VALID_NAME.test(name);
}

/**
 * Build a valid, unique-ish agent name from a role and an index.
 *
 * Guarantees the result matches `[a-z][a-z0-9_-]{0,31}`:
 *  - lowercases, replaces invalid runs with `-`
 *  - strips leading non-letters (the first char must be a letter)
 *  - truncates to 32 chars, leaving room for the `-<index>` suffix
 */
export function makeName(agent: string, index: number): string {
	// `Math.trunc(NaN)` is NaN and `Math.max(0, NaN)` is NaN, so a non-finite
	// index used to produce `agent-NaN` — which is not a valid herdr name
	// (uppercase, and not matching the pattern). Coerce to a usable integer.
	const safeIndex = Number.isFinite(index) ? Math.max(0, Math.trunc(index)) : 0;
	const suffix = `-${safeIndex}`;
	const normalized = agent
		.toLowerCase()
		.replace(/[^a-z0-9_-]+/g, "-")
		.replace(/-{2,}/g, "-")
		.replace(/^[^a-z]+/, "")
		.replace(/[-_]+$/, "");

	const room = MAX_NAME_LENGTH - suffix.length;
	const base =
		(normalized || "agent").slice(0, Math.max(1, room)).replace(/[-_]+$/, "") ||
		"agent";
	const name = `${base}${suffix}`;

	// Defensive: if truncation somehow produced something invalid, fall back.
	return VALID_NAME.test(name) ? name : `agent${suffix}`;
}

/**
 * Allocate sibling names for a batch of agent roles under one parent (#42 / §2.6).
 *
 * Only `existing` (this parent's current children) and `isAlive` (in-process
 * supervisor) constrain the sequence — historical runs from other sessions
 * must not push the counter up.
 */
export function allocateSiblingNames(
	agentNames: readonly string[],
	existing: Iterable<string>,
	isAlive: (name: string) => boolean = () => false,
): string[] {
	const taken = new Set(existing);
	const counters = new Map<string, number>();
	const out: string[] = [];
	for (const agent of agentNames) {
		let index = counters.get(agent) ?? 0;
		for (;; index += 1) {
			const candidate = makeName(agent, index);
			if (taken.has(candidate) || isAlive(candidate)) continue;
			taken.add(candidate);
			counters.set(agent, index + 1);
			out.push(candidate);
			break;
		}
	}
	return out;
}
