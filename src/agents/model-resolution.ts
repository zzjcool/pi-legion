/**
 * Model resolution (design §6.3).
 *
 * Precedence, strongest first:
 *   1. per-run override
 *   2. preset model (a referenced `subagents.presets.<name>.model`)
 *   3. team member `model` (folded in by `applyTeam`, `modelSource.type = team`)
 *   4. agentOverridesByProvider.<parentProvider>.<name>.model
 *   5. agentOverrides.<name>.model
 *   6. agent frontmatter `model` (a folded `subagents.defaultModel` also lands
 *      here; `foldedModelSource` keeps its inherited label)
 *   7. subagents.defaultModel
 *   8. the dispatching (parent) session model
 *
 * `model: "inherit"` at any of levels 1-5 explicitly selects the parent model.
 * When there is no parent model to inherit it is a loud refusal (D-B8a.1), never
 * a silent "no model": an empty resolution makes the orchestrator re-read
 * `agent.model` (the literal `inherit`) and spawn `--model inherit`, which pi
 * answers with the fatal `Model "inherit" not found`.
 * Level 2 is new: the preset's model is passed in by the caller (which owns
 * preset expansion), so this module stays a pure candidate chain. Level 3 is
 * new: a team member's `model` and its `preset` belong on the same footing, so
 * the member's `model` sits directly below the preset level and above every
 * settings-wide override.
 */

import {
	ErrorCodes,
	SubagentError,
	type AgentConfig,
	type ModelSourceInfo,
	type SubagentsSettings,
} from "../shared/types.ts";
import { splitThinkingSuffix } from "./model-scope.ts";

/**
 * The `model: "inherit"` sentinel: "use THIS (parent) session's model".
 *
 * Not a model id — it must never reach `--model` (pi answers
 * `Model "inherit" not found`). Three layers have to agree on the literal, so
 * it lives here: `resolveModel` refuses it when there is no parent model to
 * inherit, `modelCandidates` keeps it out of the candidate list, and
 * `legion-doctor` does not report it as a registry entry.
 */
export const INHERIT_MODEL_SENTINEL = "inherit";

/**
 * `details.reason` of the refusal an `inherit` with nothing to inherit raises
 * (D-B8a.1).
 *
 * A caller that RENDERS resolution failures (`/legion agents`) has to tell this
 * refusal apart from the other one (an undefined preset) to say something true
 * about it, and matching on prose would be a trap. `SubagentError.details` is
 * the structured channel it already has.
 */
export const INHERIT_WITHOUT_PARENT_MODEL = "inherit-without-parent-model";

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
 * The folded provenance of the agent's own `model`.
 *
 * Two folds write `agent.model` before this chain runs, and both record where
 * the value came from — so neither may be reported as plain frontmatter:
 *
 *   - `applyTeam` folds a team member's `model` (`"team"`): the member's explicit
 *     choice, which owns level 3;
 *   - `applyDefaultModel` folds `subagents.defaultModel`: the operator's OWN
 *     configured default. Reporting it as `frontmatter` would let
 *     `modelScope.enforce` treat it as a deliberate (`explicit`) choice and
 *     refuse it, so it keeps its `inherited` identity.
 *
 * A tag whose `model` does not match the current `agent.model` is STALE and is
 * ignored: a dirty tag must never promote (or demote) a model it no longer
 * describes.
 */
function foldedModelSource(
	agent: AgentConfig,
): "team" | "subagents.defaultModel" | "frontmatter" {
	const source = agent.modelSource;
	if (agent.model === undefined || source?.model !== agent.model) {
		return "frontmatter";
	}
	if (source.type === "team") return "team";
	if (source.type === "subagents.defaultModel") return "subagents.defaultModel";
	return "frontmatter";
}

/**
 * Level 3 value: the team member's folded `model`, only when the tag still
 * describes it. Returns `undefined` otherwise so an ordinary frontmatter model
 * is never counted twice (once here and once at its own level).
 */
function teamFoldedModel(agent: AgentConfig): string | undefined {
	return foldedModelSource(agent) === "team" ? agent.model : undefined;
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
		// Level 3: a team member's own `model`, folded in by `applyTeam`.
		{ value: teamFoldedModel(input.agent), source: "team" },
		{
			value: providerScopedModel(input.settings, input.parentProvider, name),
			source: "agentOverrides",
		},
		{ value: overrideModel(input.settings, name), source: "agentOverrides" },
		{ value: input.agent.model, source: foldedModelSource(input.agent) },
		{ value: input.defaultModel, source: "subagents.defaultModel" },
	];

	for (const candidate of candidates) {
		const raw = candidate.value?.trim();
		if (!raw) continue;

		// Explicit inheritance request.
		if (raw === INHERIT_MODEL_SENTINEL) {
			// D-B8a.1: with no parent model there is nothing to inherit, and the
			// old model-less return was NOT inert — `index.ts` then passes no
			// model, `Orchestrator.launch` re-reads `agent.model` (`inherit`) and
			// spawns `--model inherit`. Refusing here is what turns a fatal child
			// start into one actionable line for the operator.
			if (!input.dispatchModel) {
				throw new SubagentError(
					`Model 'inherit' was requested for '${name}' but the parent session has no model. ` +
						"Set `subagents.defaultModel` or pass an explicit `model` — 'inherit' means " +
						"\"use the parent session's model\", and there is none.",
					ErrorCodes.INVALID_PARAMS,
					{ reason: INHERIT_WITHOUT_PARENT_MODEL, agent: name },
				);
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
 * The `inherit` sentinel is dropped from every position (D-B8a.3): it is a
 * launch instruction, not a model id, so it must not reach `--model` / the
 * in-process model ref. Defence in depth — the normal path is already refused
 * by `resolveModel`, so this only covers callers that skip it.
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
		if (value === INHERIT_MODEL_SENTINEL) continue;
		const key = value ?? "";
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(value);
	}
	return out.length > 0 ? out : [undefined];
}
