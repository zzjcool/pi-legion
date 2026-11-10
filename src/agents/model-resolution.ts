/**
 * Model resolution (design §6.2).
 *
 * Precedence, strongest first:
 *   1. per-run override
 *   2. preset model (a referenced `subagents.presets.<name>.model`)
 *   3. agentOverridesByProvider.<parentProvider>.<name>.model
 *   4. agentOverrides.<name>.model
 *   5. agent frontmatter `model` (a folded `subagents.defaultModel` also lands
 *      here; `agentModelSource` keeps its inherited label)
 *   6. subagents.defaultModel
 *   7. the dispatching (parent) session model
 *
 * `model: "inherit"` at any of levels 1-4 explicitly selects the parent model.
 * Level 2 is new: the preset's model is passed in by the caller (which owns
 * preset expansion), so this module stays a pure candidate chain.
 */

import type {
	AgentConfig,
	ModelSourceInfo,
	SubagentsSettings,
} from "../shared/types.ts";
import { splitThinkingSuffix } from "./model-scope.ts";

export interface ResolveModelInput {
	agent: AgentConfig;
	/** Per-run override (highest priority). */
	override?: string;
	/**
	 * Model of the referenced preset (level 2 — beats agentOverrides, loses
	 * to `override`). Set by the caller after `applyPreset`/`requirePreset`.
	 */
	presetModel?: string;
	/** The parent session's model as `provider/id`. */
	dispatchModel?: string;
	/** `subagents.defaultModel`. */
	defaultModel?: string;
	settings?: SubagentsSettings;
	/** The parent session's provider, used to select provider-scoped overrides. */
	parentProvider?: string;
}

export interface ResolvedModel {
	model?: string;
	source?: ModelSourceInfo;
}

/** Read a model string from a provider-scoped override map. */
function providerScopedModel(
	settings: SubagentsSettings | undefined,
	provider: string | undefined,
	agentName: string,
): string | undefined {
	if (!settings || !provider) return undefined;
	const model = settings.agentOverridesByProvider?.[provider]?.[agentName]?.model;
	return typeof model === "string" && model.trim() ? model.trim() : undefined;
}

function overrideModel(
	settings: SubagentsSettings | undefined,
	agentName: string,
): string | undefined {
	const entry = settings?.agentOverrides?.[agentName];
	const model = entry?.model;
	return typeof model === "string" && model.trim() ? model.trim() : undefined;
}

/**
 * The provenance candidate 5 (the agent's own `model`) reports.
 *
 * `applyDefaultModel` folds `subagents.defaultModel` into `agent.model` and
 * records where it came from, so by the time this chain runs the folded default
 * looks like frontmatter. Reporting it as `frontmatter` would let
 * `modelScope.enforce` treat the operator's OWN configured default as a
 * deliberate (`explicit`) choice and refuse it, so a fold that matches the
 * current model keeps its `subagents.defaultModel` identity (which
 * `classifyModelOrigin` maps to `inherited`). A `modelSource` that does not
 * match `agent.model` is stale and is ignored.
 */
function agentModelSource(agent: AgentConfig): ModelSourceInfo["type"] {
	const source = agent.modelSource;
	return source?.type === "subagents.defaultModel" && source.model === agent.model
		? "subagents.defaultModel"
		: "frontmatter";
}

/**
 * Resolve the effective model for a child agent.
 *
 * Note: `thinking` is appended as a `:level` suffix by the caller (buildPiArgs),
 * so this function returns a clean model id plus provenance.
 */
export function resolveModel(input: ResolveModelInput): ResolvedModel {
	const name = input.agent.name;
	const candidates: Array<{
		value: string | undefined;
		source: ModelSourceInfo["type"];
		scope?: "user" | "project";
	}> = [
		{ value: input.override, source: "dispatch" },
		{ value: input.presetModel, source: "preset" },
		{
			value: providerScopedModel(input.settings, input.parentProvider, name),
			source: "agentOverrides",
		},
		{ value: overrideModel(input.settings, name), source: "agentOverrides" },
		{ value: input.agent.model, source: agentModelSource(input.agent) },
		{ value: input.defaultModel, source: "subagents.defaultModel" },
	];

	for (const candidate of candidates) {
		const raw = candidate.value?.trim();
		if (!raw) continue;

		// Explicit inheritance request.
		if (raw === "inherit") {
			if (!input.dispatchModel) {
				return { source: { type: "inherit", model: "inherit" } };
			}
			return {
				model: input.dispatchModel,
				source: { type: "inherit", model: input.dispatchModel },
			};
		}

		return {
			model: raw,
			source: {
				type: candidate.source,
				model: raw,
				...(candidate.scope ? { scope: candidate.scope } : {}),
			},
		};
	}

	// Fall through to the dispatching session's model.
	if (input.dispatchModel) {
		return {
			model: input.dispatchModel,
			source: { type: "dispatch", model: input.dispatchModel },
		};
	}
	return {};
}

/** The provider half of a `provider/id` model string. */
export function providerOf(model: string | undefined): string | undefined {
	if (!model) return undefined;
	const base = splitThinkingSuffix(model).baseModel;
	const slash = base.indexOf("/");
	return slash === -1 ? undefined : base.slice(0, slash);
}

/**
 * Unique model ids to try at start, primary first.
 *
 * Empty primary with no fallbacks yields `[undefined]` so the caller still
 * makes one start attempt without `--model`.
 */
export function modelCandidates(
	primary?: string,
	fallbacks?: string[],
): Array<string | undefined> {
	const out: Array<string | undefined> = [];
	const seen = new Set<string>();
	for (const raw of [primary, ...(fallbacks ?? [])]) {
		const value = raw?.trim() ? raw.trim() : undefined;
		const key = value ?? "";
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(value);
	}
	return out.length > 0 ? out : [undefined];
}
