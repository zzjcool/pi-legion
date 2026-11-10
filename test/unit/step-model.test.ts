/**
 * Step-model resolution: preset expansion + the model precedence chain.
 *
 * These tests exist because the feature's central claim — "a referenced preset
 * beats `agentOverrides`" — was previously asserted only against a BARE
 * settings object with `agent.model` unset. That construction never exercises
 * the real path: `loadCatalog` folds `agentOverrides` into `agent.model` BEFORE
 * anything resolves, which is exactly why a preset needs its own precedence
 * level. Demoting the preset to the frontmatter level made the whole feature a
 * silent no-op and left all 381 tests green, so the folded shape is built
 * explicitly here via `applyAgentOverrides`.
 *
 * v4 runs `kind: pi` only, so the old kind/model coherence guard (BUG A1) no
 * longer exists: there is no second kind for a resolved model to disagree with.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyModelOrigin, resolveStepModel } from "../../src/agents/step-model.ts";
import { applyAgentOverrides, applyDefaultModel } from "../../src/agents/overrides.ts";
import { applyTeam } from "../../src/agents/teams.ts";
import type { AgentConfig } from "../../src/shared/types.ts";

function agent(over: Partial<AgentConfig> = {}): AgentConfig {
	return {
		name: "scout",
		description: "d",
		systemPromptMode: "replace",
		inheritProjectContext: true,
		inheritSkills: false,
		kind: "pi",
		systemPrompt: "p",
		source: "user",
		filePath: "/f.md",
		...over,
	};
}

/** Example settings pin bundled roles while presets provide overrides. */
const SETTINGS = {
	agentOverrides: {
		scout: { model: "cb/deepseek-v4.1-flash" },
		planner: { model: "cb/glm-5.3" },
		worker: { model: "cb/kimi-k3" },
	},
	presets: {
		cheap: { kind: "pi" as const, model: "cb/deepseek-v4.1-flash" },
		strong: { kind: "pi" as const, model: "cb/kimi-k3" },
	},
};

/** Fold overrides the way `loadCatalog` does, asserting the single result. */
function fold(
	agentConfig: AgentConfig,
	overrides: Record<string, Partial<AgentConfig>>,
): AgentConfig {
	const [first] = applyAgentOverrides([agentConfig], overrides);
	assert.ok(first, "applyAgentOverrides must return the agent");
	return first;
}

// ─────────────────── the claim the feature exists for ───────────────────

test("step-model: preset beats agentOverrides AFTER loadCatalog folds them in", () => {
	// Reproduce loadCatalog's real order: overrides are folded onto the agent.
	const folded = fold(agent({ preset: "strong" }), SETTINGS.agentOverrides);
	assert.equal(folded.model, "cb/deepseek-v4.1-flash", "precondition: folded");

	const out = resolveStepModel({
		agent: folded,
		step: {},
		params: {},
		settings: SETTINGS,
	});
	// Without the dedicated precedence level this resolves to the override.
	assert.equal(out.resolved.model, "cb/kimi-k3");
	assert.equal(out.resolved.source?.type, "preset");
	assert.equal(out.usedPreset, true);
});

test("step-model: a per-run tool `model` still beats the preset", () => {
	const folded = fold(agent({ preset: "strong" }), SETTINGS.agentOverrides);
	const out = resolveStepModel({
		agent: folded,
		step: { model: "cb/glm-5.3" },
		params: {},
		settings: SETTINGS,
	});
	assert.equal(out.resolved.model, "cb/glm-5.3");
});

test("step-model: tool `preset` beats the agent's own frontmatter preset", () => {
	const folded = fold(agent({ preset: "cheap" }), {});
	const out = resolveStepModel({
		agent: folded,
		step: { preset: "strong" },
		params: {},
		settings: SETTINGS,
	});
	assert.equal(out.resolved.model, "cb/kimi-k3");
	assert.equal(out.agent.preset, "strong");
});

test("step-model: the preset's kind and thinking reach the launched agent", () => {
	const out = resolveStepModel({
		agent: agent({ preset: "strong" }),
		step: {},
		params: {},
		settings: SETTINGS,
	});
	// This is what orchestrator.launch reads for `--kind` and thinking.
	assert.equal(out.agent.kind, "pi");
	assert.equal(out.resolved.model, "cb/kimi-k3");
	assert.equal(out.usedPreset, true);
});

test("step-model: an agentOverrides-supplied preset reference is honoured", () => {
	const folded = fold(agent({}), { scout: { preset: "strong" } });
	assert.equal(folded.preset, "strong");
	const out = resolveStepModel({ agent: folded, step: {}, params: {}, settings: SETTINGS });
	assert.equal(out.resolved.model, "cb/kimi-k3");
});

// ──────────────────── regression safety: no preset ────────────────────

test("step-model: an agent with no preset is untouched", () => {
	const original = agent();
	const out = resolveStepModel({
		agent: original,
		step: {},
		params: {},
		settings: SETTINGS,
	});
	assert.equal(out.usedPreset, false);
	// The SAME object is passed through, not a copy.
	assert.equal(out.agent, original);
});

test("step-model: no preset + no overrides falls through to defaultModel", () => {
	const out = resolveStepModel({
		agent: agent(),
		step: {},
		params: {},
		settings: { defaultModel: "cb/fallback" },
	});
	assert.equal(out.resolved.model, "cb/fallback");
});

// ───────────────────────── loud undefined preset ─────────────────────────

test("step-model: an undefined preset throws (never a silent fallback)", () => {
	assert.throws(
		() =>
			resolveStepModel({
				agent: agent({ preset: "nope" }),
				step: {},
				params: {},
				settings: SETTINGS,
			}),
		/Preset 'nope' is not defined in subagents\.presets\. Defined: /,
	);
});

// ───────── modelOrigin: the explicit/inherited distinction the guard needs ─────────

// `ModelSourceInfo.type` reports BOTH a per-run `model` override and the
// parent session's fallen-through model as `"dispatch"`, so only this layer can
// tell a deliberate choice from an inherited one. The orchestrator refuses an
// explicit model the kind cannot accept and merely drops an inherited one, so
// mislabelling here either breaks legitimate launches or hides a real mistake.

test("origin: frontmatter, agentOverrides and preset are explicit choices", () => {
	const frontmatter = resolveStepModel({
		agent: agent({ model: "cb/a" }),
		step: {},
		params: {},
		settings: {},
	});
	assert.equal(frontmatter.modelOrigin, "explicit");

	const override = resolveStepModel({
		agent: agent(),
		step: {},
		params: {},
		settings: { agentOverrides: { scout: { model: "cb/b" } } },
	});
	assert.equal(override.modelOrigin, "explicit");

	const preset = resolveStepModel({
		agent: agent({ preset: "strong" }),
		step: {},
		params: {},
		settings: SETTINGS,
	});
	assert.equal(preset.modelOrigin, "explicit");
});

test("origin: defaultModel and the parent session model are inherited", () => {
	const viaDefault = resolveStepModel({
		agent: agent(),
		step: {},
		params: {},
		settings: { defaultModel: "cb/default" },
	});
	assert.equal(viaDefault.modelOrigin, "inherited");

	// The parent's model arrives as `source.type === "dispatch"`, exactly like a
	// per-run override does — the distinction is the whole point of this field.
	const viaParent = resolveStepModel({
		agent: agent(),
		step: {},
		params: {},
		dispatchModel: "cb/parent",
		settings: {},
	});
	assert.equal(viaParent.resolved.source?.type, "dispatch");
	assert.equal(viaParent.modelOrigin, "inherited");
});

test("origin: a per-run model param is an explicit choice", () => {
	const viaTool = resolveStepModel({
		agent: agent(),
		step: {},
		params: { model: "cb/chosen" },
		dispatchModel: "cb/parent",
		settings: {},
	});
	// Same `dispatch` source type as the inherited case above, opposite verdict.
	assert.equal(viaTool.resolved.source?.type, "dispatch");
	assert.equal(viaTool.modelOrigin, "explicit");
});

test("origin: no model anywhere is inherited (nothing was chosen)", () => {
	const none = resolveStepModel({
		agent: agent(),
		step: {},
		params: {},
		settings: {},
	});
	assert.equal(none.resolved.model, undefined);
	assert.equal(none.modelOrigin, "inherited");
});

// ─────────── provider-scoped overrides (D1d) & folded provenance (D2) ───────────

test("D1d: agentOverridesByProvider.<parentProvider>.<role>.model is a real level", () => {
	const out = resolveStepModel({
		agent: agent({}),
		step: {},
		params: {},
		// The parent provider selects the provider-scoped block.
		dispatchModel: "cb/parent-model",
		settings: {
			agentOverridesByProvider: { cb: { scout: { model: "cb/glm-5.3" } } },
		},
	});
	assert.equal(out.resolved.model, "cb/glm-5.3");
	assert.equal(out.resolved.source?.type, "agentOverrides");
	assert.equal(out.modelOrigin, "explicit");
});

test("D1d: a provider-scoped override for ANOTHER provider does not apply", () => {
	const out = resolveStepModel({
		agent: agent({ model: "cb/frontmatter" }),
		step: {},
		params: {},
		dispatchModel: "cb/parent-model",
		settings: {
			agentOverridesByProvider: { pi: { scout: { model: "pi/other" } } },
		},
	});
	assert.equal(out.resolved.model, "cb/frontmatter");
	assert.equal(out.resolved.source?.type, "frontmatter");
});

test("D2a: a folded subagents.defaultModel stays INHERITED (origin + label)", () => {
	// The real shape: `loadCatalog` runs `applyDefaultModel`, which writes the
	// configured default into `agent.model` and records where it came from.
	// Candidate 5 then sees a plain string — it must not report it as a
	// deliberate frontmatter choice, or `modelScope.enforce` refuses the
	// operator's own default.
	const [folded] = applyDefaultModel([agent({})], "cb/scoped-default");
	assert.ok(folded, "applyDefaultModel must return the agent");
	assert.equal(folded.model, "cb/scoped-default", "precondition: folded into agent.model");
	assert.equal(folded.modelSource?.type, "subagents.defaultModel");

	const out = resolveStepModel({ agent: folded, step: {}, params: {}, settings: {} });
	assert.equal(out.resolved.model, "cb/scoped-default");
	assert.equal(out.resolved.source?.type, "subagents.defaultModel");
	assert.equal(out.modelOrigin, "inherited");
	assert.equal(classifyModelOrigin(out.resolved, undefined).label, "subagents.defaultModel");
});

test("D2a: a leftover modelSource that does not match agent.model is NOT trusted", () => {
	// `modelSource` is provenance for the CURRENT model. If the two disagree the
	// record is stale, and the model in hand counts as frontmatter again.
	const out = resolveStepModel({
		agent: agent({
			model: "cb/frontmatter",
			modelSource: { type: "subagents.defaultModel", model: "cb/stale-default" },
		}),
		step: {},
		params: {},
		settings: {},
	});
	assert.equal(out.resolved.source?.type, "frontmatter");
	assert.equal(out.modelOrigin, "explicit");
});

test("D2b: a plain frontmatter model is still explicit (no regression)", () => {
	const out = resolveStepModel({
		agent: agent({ model: "cb/frontmatter" }),
		step: {},
		params: {},
		settings: {},
	});
	assert.equal(out.resolved.source?.type, "frontmatter");
	assert.equal(out.modelOrigin, "explicit");
	assert.equal(classifyModelOrigin(out.resolved, undefined).label, "the agent's frontmatter");
});

// ─────────── R1: a team member's `model` is its own precedence level ───────────
//
// `loadCatalog` folds in this order: frontmatter → `agentOverrides` → the team
// member override → `defaultModel`. But `resolveModel` re-reads the SETTINGS
// overrides at candidates 3/4, so before this level existed the folded team
// `model` sat at candidate 5 and silently lost to a settings-wide override.
// The docs (README, docs/subagents-teams.md) promise the member override wins,
// and a member's `preset` already lives at level 2 — so the member's `model`
// belongs directly below it, above every settings-wide override.

type StepSettings = Parameters<typeof resolveStepModel>[0]["settings"];

/**
 * Reproduce `loadCatalog`'s real fold for a team member: the frontmatter agent,
 * then `agentOverrides`, then `applyTeam`.
 */
function teamFolded(
	base: AgentConfig,
	member: { model?: string; preset?: string; thinking?: string | false },
	overrides?: Record<string, Partial<AgentConfig>>,
): AgentConfig {
	const folded = overrides ? fold(base, overrides) : base;
	const result = applyTeam(
		[folded],
		{
			team: "cheap",
			teams: { cheap: { members: [{ agent: base.name, ...member }] } },
		},
		{},
	);
	const [first] = result.agents;
	assert.ok(first, "applyTeam must return the agent");
	return first;
}

test("R1: a team member `model` beats subagents.agentOverrides", () => {
	const folded = teamFolded(
		agent({}),
		{ model: "cb/team-model" },
		{ scout: { model: "cb/override" } },
	);
	assert.equal(folded.model, "cb/team-model", "precondition: the fold wins on the agent");

	const settings: StepSettings = {
		agentOverrides: { scout: { model: "cb/override" } },
	};
	const out = resolveStepModel({ agent: folded, step: {}, params: {}, settings });
	assert.equal(out.resolved.model, "cb/team-model");
	assert.equal(out.resolved.source?.type, "team");
});

test("R1: a team member `model` beats agentOverridesByProvider for the parent provider", () => {
	const settings: StepSettings = {
		agentOverridesByProvider: { cb: { scout: { model: "cb/scoped" } } },
	};
	const folded = teamFolded(agent({}), { model: "cb/team-model" });

	const out = resolveStepModel({
		agent: folded,
		step: {},
		params: {},
		dispatchModel: "cb/parent-session",
		settings,
	});
	assert.equal(out.resolved.model, "cb/team-model");
	assert.equal(out.resolved.source?.type, "team");
});

test("R1: a tool preset still beats a team member `model`", () => {
	// The new level sits BELOW the preset: a member's `preset` is already level
	// 2, so its `model` must not outrank a preset chosen for this call.
	const settings: StepSettings = {
		presets: { strong: { kind: "pi" as const, model: "cb/preset-model" } },
	};
	const folded = teamFolded(agent({}), { model: "cb/team-model" });

	const out = resolveStepModel({
		agent: folded,
		step: { preset: "strong" },
		params: {},
		settings,
	});
	assert.equal(out.resolved.model, "cb/preset-model");
	assert.equal(out.resolved.source?.type, "preset");
});

test("R1: a member's `preset` still beats that same member's `model`", () => {
	// Both fields on ONE member: the preset expands into the agent and reports
	// level 2, so the member's `model` cannot override it. Pinned so the fold
	// order can never quietly start letting `model` beat `preset`.
	const settings: StepSettings = {
		presets: { cheap: { kind: "pi" as const, model: "cb/preset-model" } },
	};
	const folded = teamFolded(agent({}), { model: "cb/team-model", preset: "cheap" });

	const out = resolveStepModel({ agent: folded, step: {}, params: {}, settings });
	assert.equal(out.resolved.model, "cb/preset-model");
	assert.equal(out.resolved.source?.type, "preset");
});

test("R1: a per-run `model` still beats a team member `model`", () => {
	const settings: StepSettings = {};
	const folded = teamFolded(agent({}), { model: "cb/team-model" });

	const out = resolveStepModel({
		agent: folded,
		step: { model: "cb/per-run" },
		params: {},
		settings,
	});
	assert.equal(out.resolved.model, "cb/per-run");
});

test("R1: a team-sourced model is classified as an explicit team member override", () => {
	const settings: StepSettings = {};
	const folded = teamFolded(agent({}), { model: "cb/team-model" });
	const out = resolveStepModel({ agent: folded, step: {}, params: {}, settings });

	const classified = classifyModelOrigin(out.resolved, undefined);
	assert.equal(classified.origin, "explicit");
	assert.equal(classified.label, "the team member override");
	assert.equal(out.modelOrigin, "explicit");
});

test("R1: a stale team tag is ignored instead of promoting the model", () => {
	// `modelSource` is provenance for the CURRENT model only. If the two
	// disagree the tag is stale, and the model counts as frontmatter again —
	// otherwise a dirty tag would lift an ordinary frontmatter model above
	// `agentOverrides`.
	const stale = agent({
		model: "cb/frontmatter",
		modelSource: { type: "team", model: "cb/stale-team" },
	});

	const plain = resolveStepModel({ agent: stale, step: {}, params: {}, settings: {} });
	assert.equal(plain.resolved.model, "cb/frontmatter");
	assert.equal(plain.resolved.source?.type, "frontmatter");

	const withOverride = resolveStepModel({
		agent: stale,
		step: {},
		params: {},
		settings: { agentOverrides: { scout: { model: "cb/override" } } },
	});
	assert.equal(withOverride.resolved.model, "cb/override");
	assert.equal(withOverride.resolved.source?.type, "agentOverrides");
});

test("R1: a team member `model` still beats subagents.defaultModel", () => {
	const settings: StepSettings = { defaultModel: "cb/default-model" };
	const folded = teamFolded(agent({}), { model: "cb/team-model" });
	const [withDefaults] = applyDefaultModel([folded], settings.defaultModel);
	assert.ok(withDefaults, "applyDefaultModel must return the agent");
	assert.equal(withDefaults.model, "cb/team-model");
	assert.equal(withDefaults.modelSource?.type, "team");

	const out = resolveStepModel({
		agent: withDefaults,
		step: {},
		params: {},
		settings,
	});
	assert.equal(out.resolved.model, "cb/team-model");
	assert.equal(out.resolved.source?.type, "team");
});

// ─────────── B8b: configured `thinking` vs a `:level` in the model string ───────────
//
// `applyThinkingSuffix` (argv AND in-process model ref) keeps an existing level
// by default and nothing calls it with `replaceExisting`, so a configured
// `thinking` was silently dropped whenever the winning model string carried a
// level. The strip happens HERE — the single resolution entry point both
// backends read — so rpc and in-process stay byte-identical.

test("B8b.1: a card model level yields to the card's own `thinking`", () => {
	const out = resolveStepModel({
		agent: agent({ model: "cb/x:high", thinking: "max" }),
		step: {},
		params: {},
		settings: {},
	});
	assert.equal(out.resolved.model, "cb/x");
});

test("B8b.1: a team member's model level yields to the member's `thinking`", () => {
	const folded = teamFolded(agent({}), { model: "cb/x:high", thinking: "max" });
	assert.equal(folded.thinking, "max", "precondition: applyTeam folds the member's thinking");

	const out = resolveStepModel({ agent: folded, step: {}, params: {}, settings: {} });
	assert.equal(out.resolved.model, "cb/x");
});

test("B8b.1: a preset's model level yields to the preset's `thinking`", () => {
	const out = resolveStepModel({
		agent: agent({ preset: "strong" }),
		step: {},
		params: {},
		settings: {
			presets: { strong: { kind: "pi" as const, model: "cb/x:high", thinking: "max" } },
		},
	});
	assert.equal(out.resolved.model, "cb/x");
});

test("B8b.1: a per-run model's OWN level survives a configured `thinking`", () => {
	// The exception: a level typed into THIS call's `model` is the most specific
	// signal there is, so the lower-precedence `thinking` must not undo it.
	const out = resolveStepModel({
		agent: agent({ model: "cb/other", thinking: "low" }),
		step: { model: "cb/x:high" },
		params: {},
		settings: {},
	});
	assert.equal(out.resolved.model, "cb/x:high");

	// `tasks[].model` and the call-level `model` are the SAME level, so the
	// exception must hold for both — not just the one this test started with.
	const viaParams = resolveStepModel({
		agent: agent({ model: "cb/other", thinking: "low" }),
		step: {},
		params: { model: "cb/x:high" },
		settings: {},
	});
	assert.equal(viaParams.resolved.model, "cb/x:high");
});

test("B8b.1: no configured `thinking` leaves the model string alone", () => {
	// The level may be the only thinking choice the operator made; stripping it
	// here would lose it for good (existing behaviour, must not change).
	const out = resolveStepModel({
		agent: agent({ model: "cb/x:high" }),
		step: {},
		params: {},
		settings: {},
	});
	assert.equal(out.resolved.model, "cb/x:high");
});

test("B8b.1: `thinking: false` strips the level (reasoning must stay off)", () => {
	const out = resolveStepModel({
		agent: agent({ model: "cb/x:high", thinking: false }),
		step: {},
		params: {},
		settings: {},
	});
	assert.equal(out.resolved.model, "cb/x");
	assert.equal(out.agent.thinking, false, "the flag itself is untouched");
});

test("B8b.1: a blank `thinking` is not a configuration, so the model's level stays", () => {
	// `agentOverrides.<role>.thinking: ""` used to count as configured and strip
	// the level — with nothing put back, because `applyThinkingSuffix` appends
	// nothing for a blank level. The operator's only thinking choice vanished.
	const blank = resolveStepModel({
		agent: agent({ model: "cb/x:high", thinking: "" }),
		step: {},
		params: {},
		settings: {},
	});
	assert.equal(blank.resolved.model, "cb/x:high", "a blank `thinking` is not a choice");
	assert.equal(blank.agent.thinking, "");

	// Whitespace is the same non-choice (the override is a string from settings).
	const spaces = resolveStepModel({
		agent: agent({ model: "cb/x:high", thinking: "   " }),
		step: {},
		params: {},
		settings: {},
	});
	assert.equal(spaces.resolved.model, "cb/x:high");
});

test("B8b.1: provenance keeps `model` and `source.model` in step after the strip", () => {
	// `resolveModel` always returns them as the same string; a strip that only
	// rewrote one of them would look like a STALE provenance tag downstream.
	const out = resolveStepModel({
		agent: agent({ model: "cb/x:high", thinking: "max" }),
		step: {},
		params: {},
		settings: {},
	});
	assert.equal(out.resolved.source?.type, "frontmatter");
	assert.equal(out.resolved.source?.model, "cb/x");
});

// ─────────── blank step fields must not shadow the call-level values (D4) ───────────

test("D4a(model): `step.model: \"\"` cannot shadow `params.model`", () => {
	const out = resolveStepModel({
		agent: agent({ model: "cb/frontmatter" }),
		step: { model: "" },
		params: { model: "cb/per-run" },
		settings: {},
	});
	assert.equal(out.resolved.model, "cb/per-run");
	assert.equal(out.modelOrigin, "explicit");
});

test("D4b(model): a padded `params.model` is trimmed AND still classified explicit", () => {
	// The override handed to `resolveModel` must be the trimmed value, otherwise
	// `classifyModelOrigin`'s `resolved.model === override` comparison misses and
	// the caller's own choice is reported as inherited.
	const out = resolveStepModel({
		agent: agent({}),
		step: {},
		params: { model: "  cb/per-run  " },
		settings: {},
	});
	assert.equal(out.resolved.model, "cb/per-run");
	assert.equal(out.modelOrigin, "explicit");
});

test("D4a(preset): a blank `step.preset` cannot shadow `params.preset`", () => {
	const out = resolveStepModel({
		agent: agent({ preset: "cheap" }),
		step: { preset: "" },
		params: { preset: "strong" },
		settings: SETTINGS,
	});
	assert.equal(out.usedPreset, true);
	assert.equal(out.resolved.model, "cb/kimi-k3");
	assert.equal(out.agent.preset, "strong");
});
