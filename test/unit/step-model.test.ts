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
import { resolveStepModel } from "../../src/agents/step-model.ts";
import { applyAgentOverrides } from "../../src/agents/overrides.ts";
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
