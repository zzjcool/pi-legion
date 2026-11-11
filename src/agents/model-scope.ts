/**
 * Model-scope enforcement (design §6.2).
 *
 * An allow-list of glob patterns constraining which models a subagent may use.
 * Violations are ERRORS when the model was requested explicitly (a deliberate
 * choice we can reject up front) and WARNINGS when inherited (so an existing
 * configuration keeps working).
 */

import {
	type ModelScopeConfig,
	type ModelScopeViolation,
	isThinkingLevel,
} from "../shared/types.ts";

/**
 * Strip a trailing `:thinking` suffix, returning both parts.
 * Only known levels are stripped, so `provider/model:variant` survives.
 * The level list lives in shared/types.ts so it cannot drift from the
 * argv builder's copy.
 */
export function splitThinkingSuffix(model: string): {
	baseModel: string;
	thinking?: string;
} {
	const idx = model.lastIndexOf(":");
	if (idx === -1) return { baseModel: model };
	const suffix = model.slice(idx + 1);
	if (!isThinkingLevel(suffix)) return { baseModel: model };
	return { baseModel: model.slice(0, idx), thinking: suffix };
}

export function stripThinkingSuffix(model: string): string {
	return splitThinkingSuffix(model).baseModel;
}

/**
 * The RUNNING form of a model, for display (D-R8.1).
 *
 * One producer for every place that shows `model` next to `thinking`: the status
 * widget, the summary detail and `/legion agents`. Each used to assemble the
 * string its own way, so the same child read `cb/x` in one view and `cb/x:max`
 * in another, and the status widget swallowed an explicit `:off`.
 *
 * Rules, in order:
 *  - `thinking: false` is an explicit "no reasoning": no level is shown, not even
 *    one baked into the model id. The normal launch path already strips the
 *    level in that case (`step-model`), so this only keeps the label honest for
 *    a record written by an older process.
 *  - a trailing KNOWN level in the model id wins: it is what the child actually
 *    runs (`applyThinkingSuffix` keeps the suffix), so `cb/x:high` + `max` is
 *    `cb/x:high`.
 *  - a trailing UNKNOWN segment is part of the model id (`provider/model:variant`),
 *    so the configured level is appended after it — exactly what the launcher
 *    does with the same input, which is the whole point of sharing the rule.
 *  - otherwise a known level in `thinking` is appended.
 *
 * `off` is a real, effective level and therefore rendered when it is the level
 * that runs.
 */
export function modelLabel(
	model: string | undefined,
	thinking: string | false | undefined,
): string | undefined {
	if (!model) return undefined;
	// `false` means reasoning is OFF: strip a level an older record may still
	// carry, rather than render one that no longer applies.
	if (thinking === false) return stripThinkingSuffix(model);
	// Everything else is literally the launcher's own rule — see
	// `withThinkingLevel` below, which `applyThinkingSuffix` also delegates to.
	// One implementation, so a label can never disagree with the argv.
	return withThinkingLevel(model, thinking) ?? model;
}

/**
 * Append `:<thinking>` to a model id, unless it already carries a known suffix.
 *
 * The single implementation behind BOTH the launcher's argv/model-ref
 * (`applyThinkingSuffix` in `src/runs/args.ts`) and the display label above.
 * They were two hand-written copies of the same rule, so a change to one could
 * leave the other describing a child differently from how it actually runs —
 * exactly the class of bug the label exists to prevent.
 *
 * `replaceExisting` is only used by the argv builder's callers.
 */
export function withThinkingLevel(
	model: string | undefined,
	thinking: string | false | undefined,
	replaceExisting = false,
): string | undefined {
	if (!model || !thinking) return model;
	const colon = model.lastIndexOf(":");
	if (colon !== -1 && isThinkingLevel(model.slice(colon + 1))) {
		return replaceExisting ? `${model.slice(0, colon)}:${thinking}` : model;
	}
	return `${model}:${thinking}`;
}

/**
 * Match a `*`-glob against `text`, case-insensitively, as a FULL match.
 *
 * Deliberately NOT a RegExp. Translating a glob into `.*` produces nested
 * quantifiers (`*a*a*a…b` becomes `.*a.*a.*a…b`), which backtracks
 * exponentially on a non-matching input. Since the patterns come from
 * `.pi/settings.json` — a file that travels with a cloned repository — a
 * hostile pattern would otherwise hang the host process (measured: a 100-star
 * pattern took 14.5s, doubling per added star).
 *
 * This greedy two-pointer scan never revisits a position more than once per
 * pattern literal, so it is bounded by O(text × pattern) with no exponential
 * blow-up. `*` is the only metacharacter: no `?`, no character classes.
 *
 * Deliberately a hand-rolled index cursor rather than a `for...of`: the scan
 * must be able to REWIND `t` to a star position it already passed, which an
 * array iteration cannot express.
 */
function globMatches(text: string, pattern: string): boolean {
	let t = 0;
	let p = 0;
	// Position of the most recent `*`, and the text index it was matched at.
	let starP = -1;
	let starT = 0;
	// Hoisted: `text` never changes here, and comparing against a local keeps
	// the scan's hot loop off the property load.
	const textLen = text.length;
	const patternLen = pattern.length;

	while (t < textLen) {
		const pc = p < patternLen ? pattern[p] : undefined;
		if (pc === "*") {
			starP = p;
			starT = t;
			p += 1;
		} else if (
			pc !== undefined &&
			pc.toLowerCase() === text[t]?.toLowerCase()
		) {
			p += 1;
			t += 1;
		} else if (starP !== -1) {
			// Backtrack to just after the last `*` and let it absorb one more
			// character. Only the most recent star is retried, so this cannot
			// compound into exponential work.
			starT += 1;
			t = starT;
			p = starP + 1;
		} else {
			return false;
		}
	}

	// Any trailing `*`s may match the empty remainder.
	while (p < patternLen && pattern[p] === "*") p += 1;
	return p === patternLen;
}

/**
 * Test a resolved model against one allow pattern.
 * Both sides compare case-insensitively on the full `provider/id`.
 */
export function matchesScopePattern(model: string, pattern: string): boolean {
	return globMatches(stripThinkingSuffix(model), pattern);
}

/**
 * Pure scope decision.
 * Returns a violation when the model is out of scope and enforcement is on.
 * Enforcement with no `allow` list is a no-op.
 */
export function checkModelScope(
	model: string | undefined,
	scope: ModelScopeConfig | undefined,
	source: "explicit" | "inherited",
): ModelScopeViolation | undefined {
	if (!model || !scope?.enforce) return undefined;
	const allow = scope.allow;
	if (!allow || allow.length === 0) return undefined;
	if (allow.some((pattern) => matchesScopePattern(model, pattern)))
		return undefined;

	const baseModel = stripThinkingSuffix(model);
	return {
		model: baseModel,
		severity: source === "explicit" ? "error" : "warn",
		allowedPatterns: [...allow],
		message:
			`Model '${baseModel}' is outside the configured subagent model scope. ` +
			`Allowed patterns: ${allow.join(", ")}.`,
	};
}

/**
 * Validate and normalize a raw `subagents.modelScope` value.
 * Throws a descriptive error for malformed configs.
 */
export function parseModelScopeConfig(
	value: unknown,
	meta: { filePath: string },
): ModelScopeConfig | undefined {
	if (value === undefined) return undefined;
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(
			`Subagent settings in '${meta.filePath}' have invalid 'modelScope'; expected an object.`,
		);
	}
	const input = value as Record<string, unknown>;
	const out: ModelScopeConfig = { enforce: false, allow: [] };

	if ("enforce" in input) {
		if (typeof input.enforce !== "boolean") {
			throw new Error(
				`Subagent settings in '${meta.filePath}' have invalid 'modelScope.enforce'; expected a boolean.`,
			);
		}
		out.enforce = input.enforce;
	}

	if ("allow" in input) {
		const allow = input.allow;
		if (
			!Array.isArray(allow) ||
			allow.some((v) => typeof v !== "string" || !v.trim())
		) {
			throw new Error(
				`Subagent settings in '${meta.filePath}' have invalid 'modelScope.allow'; expected a non-empty string array.`,
			);
		}
		out.allow = (allow as string[]).map((v) => v.trim());
	}

	if (out.enforce && out.allow.length === 0) {
		throw new Error(
			`Subagent settings in '${meta.filePath}' enable 'modelScope.enforce' without an 'allow' list.`,
		);
	}

	return out;
}
