/**
 * Named kind+model+thinking presets (`subagents.presets`).
 *
 * A preset is referenced by name from agent frontmatter (`preset: cheap`),
 * from `agentOverrides.<name>.preset`, or from the tool's `preset` param.
 * It slots into model precedence at level 2 — below the per-run tool
 * `model`, above `agentOverrides` (design §6.2).
 *
 * Two invariants live here:
 *
 *  1. ATOMICITY — `kind`, `model` and `thinking` come from the same preset
 *     object, so a preset can never ship half of one bundle and half another.
 *
 *  2. LOUD UNDEFINED — a referenced preset name with no matching entry is
 *     an error that names the defined presets, never a silent fallback to
 *     the dispatch model (mirrors `checkModelScope`'s out-of-scope error).
 *
 * v4 runs `kind: pi` only: a preset that names another kind is reported once
 * and applied as `pi` (see `parsePreset`).
 */

import {
	AGENT_KINDS,
	ErrorCodes,
	SubagentError,
	type AgentConfig,
	type AgentKind,
	type PresetConfig,
} from "../shared/types.ts";

const VALID_KINDS: ReadonlySet<string> = new Set(AGENT_KINDS);

/**
 * Validate + normalize raw `subagents.presets`. Throws on malformed values.
 *
 * `undefined` input means the key is absent (not an error); every present
 * value must be a record of `{kind?, model?, thinking?}` objects, because a
 * config that passes validation and is then ignored is the exact
 * "accepted but inert" trap this feature is designed against.
 */
export function parsePresets(
	value: unknown,
	meta: { filePath: string },
): Record<string, PresetConfig> | undefined {
	if (value === undefined) return undefined;
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(
			`Subagent settings in '${meta.filePath}' have invalid 'presets'; expected an object.`,
		);
	}
	const out: Record<string, PresetConfig> = {};
	for (const [name, raw] of Object.entries(value as Record<string, unknown>)) {
		out[name] = parsePreset(name, raw, meta.filePath);
	}
	return out;
}

function parsePreset(
	name: string,
	raw: unknown,
	filePath: string,
): PresetConfig {
	const label = `presets.${name}`;
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		throw new Error(
			`Subagent settings in '${filePath}' have invalid '${label}'; expected an object with kind/model/thinking.`,
		);
	}
	const input = raw as Record<string, unknown>;
	const out: PresetConfig = {};

	if (input.kind !== undefined) {
		// A non-`pi` kind is no longer a validation error (the field is still a
		// legal key, it just only accepts one value). Report the ignored value once
		// and apply the preset as `pi`, the single supported kind.
		if (typeof input.kind !== "string" || !VALID_KINDS.has(input.kind)) {
			console.error(
				`[pi-legion] preset '${name}' in ${filePath} sets kind ${JSON.stringify(input.kind)}; ` +
					`v4 supports kind: pi only, so that field is ignored and the preset applies as kind: pi.`,
			);
		} else {
			out.kind = input.kind as AgentKind;
		}
	}

	if (input.model !== undefined) {
		if (typeof input.model !== "string" || !input.model.trim()) {
			throw new Error(
				`Subagent settings in '${filePath}' have invalid '${label}.model'; expected a non-empty string.`,
			);
		}
		out.model = input.model.trim();
	}

	const thinking = input.thinking;
	if (thinking !== undefined) {
		if (thinking === false) {
			out.thinking = false;
		} else if (typeof thinking === "string" && thinking.trim()) {
			out.thinking = thinking.trim();
		} else {
			throw new Error(
				`Subagent settings in '${filePath}' have invalid '${label}.thinking'; expected a non-empty string or false.`,
			);
		}
	}

	return out;
}

/**
 * Highest-precedence preset reference: tool param > agentOverrides > frontmatter.
 *
 * The caller folds `agentOverrides` into the agent BEFORE this runs, so
 * `agent.preset` already reflects the first two levels below the tool param.
 *
 * Returns a bare name: the reference SITE is not consumed by any caller, and
 * `ModelSourceInfo` already distinguishes the winning model's origin. (A
 * `source` field here used to report tool-param references as `"dispatch"`,
 * which in that union means "the parent session's model" — the opposite of an
 * explicit per-run choice.)
 */
export function resolvePresetName(input: {
	toolPreset?: string;
	agent: AgentConfig;
}): string | undefined {
	const tool = input.toolPreset?.trim();
	if (tool) return tool;
	const agentPreset = input.agent.preset?.trim();
	return agentPreset || undefined;
}

/**
 * Look up `name`; throw a descriptive error when undefined.
 *
 * The message lists the presets that ARE defined so a shared agent package
 * shipping `preset:` gets an actionable error on a host with no presets,
 * not a mystery model from a silent fallback.
 */
export function requirePreset(
	name: string,
	presets: Record<string, PresetConfig> | undefined,
): PresetConfig {
	const preset = presets?.[name];
	if (preset) return preset;
	const defined = Object.keys(presets ?? {});
	const suffix = defined.length
		? `Defined: ${defined.join(", ")}.`
		: "None are defined.";
	// A `SubagentError` gives the refusal line a code instead of a bare
	// `Error:` prefix (see `launchStep`'s catch), matching every other refusal.
	throw new SubagentError(
		`Preset '${name}' is not defined in subagents.presets. ${suffix}`,
		ErrorCodes.INVALID_PARAMS,
	);
}

/**
 * Return a COPY of `agent` with kind/model/thinking from `preset`.
 *
 * All three fields are written together from the same object — the atomicity
 * invariant. `undefined` preset fields leave the agent's value untouched;
 * `modelSource` records the provenance when the preset sets a model.
 */
export function applyPreset(
	agent: AgentConfig,
	presetName: string,
	preset: PresetConfig,
): AgentConfig {
	const out: AgentConfig = { ...agent };
	out.preset = presetName;
	if (preset.kind !== undefined) out.kind = preset.kind;
	if (preset.model !== undefined) {
		out.model = preset.model;
		out.modelSource = { type: "preset", model: preset.model };
	}
	if (preset.thinking !== undefined) out.thinking = preset.thinking;
	return out;
}

/**
 * Expand the agent's referenced preset, if any.
 *
 * Single entry point for "which preset, was it defined, what does it change",
 * so the launch path cannot accidentally look up a preset and then forget to
 * apply it (or vice versa). Returns `undefined` when no preset is referenced,
 * in which case the caller must pass the ORIGINAL agent through untouched.
 *
 * Throws when a referenced name is not defined — see `requirePreset`.
 */
export function expandPreset(input: {
	agent: AgentConfig;
	toolPreset?: string;
	presets?: Record<string, PresetConfig>;
}):
	| { agent: AgentConfig; presetName: string; presetModel?: string }
	| undefined {
	const name = resolvePresetName({
		toolPreset: input.toolPreset,
		agent: input.agent,
	});
	if (!name) return undefined;
	const preset = requirePreset(name, input.presets);
	const expanded: { agent: AgentConfig; presetName: string; presetModel?: string } = {
		agent: applyPreset(input.agent, name, preset),
		presetName: name,
	};
	if (preset.model !== undefined) expanded.presetModel = preset.model;
	return expanded;
}
