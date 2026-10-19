/**
 * Pure step-model resolution: preset expansion + model precedence.
 *
 * Extracted from `index.ts` so the launch wiring is testable without herdr.
 * Everything here is a pure function of its inputs — no panes, no process
 * state, no I/O — because the two invariants this module owns are the ones the
 * feature is judged on:
 *
 *   1. A referenced preset's kind/model/thinking reach the child, and its
 *      model beats `agentOverrides` (which `loadCatalog` folds into
 *      `agent.model` before anything here runs).
 *
 * v4 runs `kind: pi` only, so there is no second invariant to police here:
 * the resolved model always belongs to the one supported kind.
 */

import type { AgentConfig, ModelOrigin, PresetConfig } from "../shared/types.ts";
import { providerOf, resolveModel, type ResolvedModel } from "./model-resolution.ts";
import { expandPreset } from "./presets.ts";

export interface StepModelInput {
	/** The catalog agent, with `agentOverrides` already folded in. */
	agent: AgentConfig;
	/** Per-step overrides (a `tasks[]` entry). */
	step: { model?: string; preset?: string };
	/** Top-level tool params that act as per-run overrides for every step. */
	params: { model?: string; preset?: string };
	/** The parent session's model as `provider/id`, if known. */
	dispatchModel?: string;
	settings: {
		agentOverrides?: Record<string, Partial<AgentConfig>>;
		agentOverridesByProvider?: Record<string, Record<string, Partial<AgentConfig>>>;
		presets?: Record<string, PresetConfig>;
		defaultModel?: string;
	};
}

export interface StepModelResult {
	resolved: ResolvedModel;
	/** The agent to hand to `orchestrator.launch` (preset-patched when one applied). */
	agent: AgentConfig;
	/** True when a preset was referenced and expanded. */
	usedPreset: boolean;
	/**
	 * How the winning model was chosen, for `orchestrator.launch`'s guard.
	 *
	 * Only this layer can tell an inherited parent model from an explicit
	 * choice: `ModelSourceInfo.type` reports both as `"dispatch"`. Passing the
	 * wrong value here is what makes the orchestrator either refuse a legitimate
	 * inherited model or silently accept a dropped explicit one.
	 */
	modelOrigin: ModelOrigin;
}

/**
 * Resolve the model (and the effective agent) a step will launch with.
 *
 * Throws when a referenced preset is undefined. Callers are expected to turn
 * that into a refusal line rather than letting it escape.
 */
export function resolveStepModel(input: StepModelInput): StepModelResult {
	const override = input.step.model ?? input.params.model;

	const expanded = expandPreset({
		agent: input.agent,
		toolPreset: input.step.preset ?? input.params.preset,
		...(input.settings.presets ? { presets: input.settings.presets } : {}),
	});

	const effective = expanded?.agent ?? input.agent;

	const resolved = resolveModel({
		agent: effective,
		...(override ? { override } : {}),
		...(expanded?.presetModel ? { presetModel: expanded.presetModel } : {}),
		...(input.dispatchModel ? { dispatchModel: input.dispatchModel } : {}),
		...(input.settings.defaultModel
			? { defaultModel: input.settings.defaultModel }
			: {}),
		...(input.dispatchModel
			? { parentProvider: providerOf(input.dispatchModel) }
			: {}),
		settings: input.settings as Parameters<typeof resolveModel>[0]["settings"],
	});

	// Only a preset can change the kind, and v4 accepts `pi` alone, so nothing
	// here can leave the kind and the launched model incoherent.

	return {
		resolved,
		agent: effective,
		usedPreset: expanded !== undefined,
		modelOrigin: classifyModelOrigin(resolved, override).origin,
	};
}

/**
 * Classify how the winning model was chosen, with a label for error messages.
 *
 * `"dispatch"` is overloaded in `ModelSourceInfo`: it tags BOTH the per-run
 * `model` override (a deliberate choice) and the fall-through to the
 * dispatching session's model (inherited). The two are distinguished by
 * comparing the winner against the override: the override is the first
 * candidate, so anything else arriving as `dispatch` is the parent's model.
 * That distinction is what stops the orchestrator from refusing a legitimately
 * inherited parent model, so it lives in ONE place rather than being
 * re-derived per caller.
 */
export function classifyModelOrigin(
	resolved: ResolvedModel,
	override: string | undefined,
): { origin: ModelOrigin; label: string | undefined } {
	const type = resolved.source?.type;

	switch (type) {
		case "preset":
			return { origin: "explicit", label: "the preset" };
		case "agentOverrides":
			return { origin: "explicit", label: "agentOverrides" };
		case "frontmatter":
			return { origin: "explicit", label: "the agent's frontmatter" };
		case "subagents.defaultModel":
			return { origin: "inherited", label: "subagents.defaultModel" };
		case "inherit":
			return { origin: "inherited", label: "the parent session model" };
		case "dispatch": {
			// A per-run override is the caller's own choice; anything else that
			// arrives as `dispatch` is the parent's model falling through.
			if (override !== undefined && resolved.model === override) {
				return { origin: "explicit", label: "the per-run model override" };
			}
			return { origin: "inherited", label: "the parent session model" };
		}
		default:
			// No model resolved: nothing was chosen, so the CLI default applies.
			return { origin: "inherited", label: undefined };
	}
}
