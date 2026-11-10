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
import { splitThinkingSuffix, stripThinkingSuffix } from "./model-scope.ts";
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
 * The non-blank form of a caller-supplied string.
 *
 * A blank `""` / `"   "` is not a choice, so it must not shadow the other
 * source: `??` alone treats an empty string as present and silently drops the
 * call-level `model`/`preset`. Trimming here also keeps `classifyModelOrigin`'s
 * `resolved.model === override` comparison honest — passing `"  x/y  "` down
 * means the winner (`x/y`) never equals the override and the caller's own
 * choice is reported as inherited.
 */
function explicitValue(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed ? trimmed : undefined;
}

/**
 * Drop a `:level` that a configured `thinking` is about to replace (D-B8b.1).
 *
 * `applyThinkingSuffix` — the builder of both the rpc argv's `--model` and the
 * in-process model ref — keeps an existing level unless it is told to replace
 * it, and it is NOT told to: flipping `replaceExisting` on would also undo the
 * per-run exception below (and would do so deep in `src/runs/**`, where the
 * configuration being overridden is no longer visible). Stripping one step
 * earlier keeps `thinking` meaningful and keeps the two backends identical,
 * because both read THIS result.
 *
 * Three conditions must hold together:
 *   - a model resolved, and it did not come from the per-run override (a level
 *     typed into THIS call's `model` is the most specific signal there is —
 *     the caller chose it for this very run, so a lower-precedence setting must
 *     not undo it);
 *   - the effective agent configures `thinking` (preset / team member / card /
 *     `agentOverrides` all land there via `expandPreset` + the folds);
 *   - the model string actually carries a KNOWN level (`splitThinkingSuffix`
 *     only matches those, so `provider/model:variant` is left alone).
 *
 * `thinking: false` counts as a configuration too: leaving the suffix would
 * switch reasoning back on for a role that asked for it off. It needs no level
 * of its own — the strip is the whole effect.
 */
function stripConfiguredThinkingLevel(
	resolved: ResolvedModel,
	override: string | undefined,
	thinking: string | false | undefined,
): ResolvedModel {
	if (!resolved.model || thinking === undefined) return resolved;
	// The same judgement `classifyModelOrigin` uses to recognise the per-run
	// winner: the override is candidate 1, so a winner that IS the override came
	// from this call.
	if (override !== undefined && resolved.model === override) return resolved;
	if (splitThinkingSuffix(resolved.model).thinking === undefined) return resolved;

	const model = stripThinkingSuffix(resolved.model);
	// `resolveModel` always reports `model` and `source.model` as the same
	// string; a strip that rewrote only one of them would look exactly like a
	// STALE provenance tag to the next reader that compares them.
	return {
		...resolved,
		model,
		...(resolved.source ? { source: { ...resolved.source, model } } : {}),
	};
}

/**
 * Resolve the model (and the effective agent) a step will launch with.
 *
 * Throws when a referenced preset is undefined, or when `inherit` has no parent
 * model to inherit (D-B8a.1). Callers are expected to turn that into a refusal
 * line rather than letting it escape.
 */
export function resolveStepModel(input: StepModelInput): StepModelResult {
	const override = explicitValue(input.step.model) ?? explicitValue(input.params.model);

	const expanded = expandPreset({
		agent: input.agent,
		toolPreset: explicitValue(input.step.preset) ?? explicitValue(input.params.preset),
		...(input.settings.presets ? { presets: input.settings.presets } : {}),
	});

	const effective = expanded?.agent ?? input.agent;

	const resolvedChosen = resolveModel({
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
	// B8b: the configured `thinking` (a dedicated field) outranks a `:level`
	// embedded in the model string — except for a level that came in with THIS
	// call's `model`. See `stripConfiguredThinkingLevel`.
	const resolved = stripConfiguredThinkingLevel(
		resolvedChosen,
		override,
		effective.thinking,
	);

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
		case "team":
			// A team member's `model` is the operator's explicit pick for this
			// team, so `modelScope.enforce` may refuse it (unlike an inherited
			// default, which only warns).
			return { origin: "explicit", label: "the team member override" };
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
