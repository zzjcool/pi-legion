import { test } from "node:test";
import assert from "node:assert/strict";
import {
	matchesScopePattern,
	checkModelScope,
	stripThinkingSuffix,
	splitThinkingSuffix,
	parseModelScopeConfig,
} from "../../src/agents/model-scope.ts";
import { resolveModel, providerOf, modelCandidates } from "../../src/agents/model-resolution.ts";
import {
	applyAgentOverrides,
	applyDefaultModel,
	applyDefaultOnBlocked,
	applyOverride,
} from "../../src/agents/overrides.ts";
import {
	parseSubagentSettings,
	resolveSubagentSettings,
	loadSubagentSettings,
} from "../../src/agents/settings.ts";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { AgentConfig } from "../../src/shared/types.ts";

function agent(over: Partial<AgentConfig> = {}): AgentConfig {
	return {
		name: "reviewer",
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

// ─────────────────────────── model scope ───────────────────────────

test("scope: thinking suffix is stripped only for known levels", () => {
	assert.equal(stripThinkingSuffix("cb/glm-5.3:high"), "cb/glm-5.3");
	assert.equal(stripThinkingSuffix("cb/model:variant"), "cb/model:variant");
	assert.deepEqual(splitThinkingSuffix("a/b:low"), {
		baseModel: "a/b",
		thinking: "low",
	});
});

test("scope: glob matching is case-insensitive and anchored", () => {
	assert.equal(matchesScopePattern("cb/glm-5.3", "cb/*"), true);
	assert.equal(matchesScopePattern("cb/glm-5.3:high", "cb/*"), true);
	assert.equal(matchesScopePattern("anthropic/claude", "cb/*"), false);
	assert.equal(matchesScopePattern("xcb/glm", "cb/*"), false);
});

test("scope: explicit violation is an error, inherited is a warning", () => {
	const scope = { enforce: true, allow: ["cb/*"] };
	const explicit = checkModelScope("anthropic/claude", scope, "explicit");
	assert.equal(explicit?.severity, "error");
	const inherited = checkModelScope("anthropic/claude", scope, "inherited");
	assert.equal(inherited?.severity, "warn");
});

test("scope: in-scope model yields no violation", () => {
	assert.equal(
		checkModelScope(
			"cb/glm-5.3",
			{ enforce: true, allow: ["cb/*"] },
			"explicit",
		),
		undefined,
	);
});

test("scope: enforcement without allow list is a no-op", () => {
	assert.equal(
		checkModelScope("anything", { enforce: true, allow: [] }, "explicit"),
		undefined,
	);
});

test("scope: disabled enforcement never violates", () => {
	assert.equal(
		checkModelScope(
			"anything",
			{ enforce: false, allow: ["cb/*"] },
			"explicit",
		),
		undefined,
	);
});

test("scope: parse rejects malformed config", () => {
	assert.throws(() => parseModelScopeConfig("nope", { filePath: "/s.json" }));
	assert.throws(() =>
		parseModelScopeConfig({ enforce: "yes" }, { filePath: "/s.json" }),
	);
	assert.throws(() =>
		parseModelScopeConfig({ allow: "cb/*" }, { filePath: "/s.json" }),
	);
	assert.throws(() =>
		parseModelScopeConfig(
			{ enforce: true, allow: [] },
			{ filePath: "/s.json" },
		),
	);
});

test("scope: parse accepts a valid config", () => {
	assert.deepEqual(
		parseModelScopeConfig(
			{ enforce: true, allow: ["cb/*"] },
			{ filePath: "/s.json" },
		),
		{
			enforce: true,
			allow: ["cb/*"],
		},
	);
});

// ─────────────────────────── model resolution ───────────────────────────

test("resolve: per-run override wins over everything", () => {
	const r = resolveModel({
		agent: agent({ model: "frontmatter-model" }),
		override: "override-model",
		presetModel: "preset-model",
		dispatchModel: "parent/model",
		defaultModel: "default-model",
	});
	assert.equal(r.model, "override-model");
});

test("resolve: preset model beats agentOverrides (level 2)", () => {
	const r = resolveModel({
		agent: agent(),
		presetModel: "cb/kimi-k3",
		settings: { agentOverrides: { reviewer: { model: "cb/flash" } } },
	});
	assert.equal(r.model, "cb/kimi-k3");
	assert.equal(r.source?.type, "preset");
});

test("resolve: preset model beats the provider-scoped override too", () => {
	const r = resolveModel({
		agent: agent(),
		presetModel: "cb/kimi-k3",
		settings: {
			agentOverridesByProvider: { cb: { reviewer: { model: "scoped" } } },
		},
		parentProvider: "cb",
	});
	assert.equal(r.model, "cb/kimi-k3");
	assert.equal(r.source?.type, "preset");
});

test("resolve: no preset means the old chain is bit-for-bit unchanged", () => {
	const r = resolveModel({
		agent: agent({ model: "frontmatter" }),
		settings: { agentOverrides: { reviewer: { model: "override" } } },
		dispatchModel: "parent/model",
	});
	assert.equal(r.model, "override");
	assert.equal(r.source?.type, "agentOverrides");
});

test("resolve: provider-scoped override beats plain override", () => {
	const r = resolveModel({
		agent: agent(),
		settings: {
			agentOverrides: { reviewer: { model: "plain" } },
			agentOverridesByProvider: { cb: { reviewer: { model: "scoped" } } },
		},
		parentProvider: "cb",
	});
	assert.equal(r.model, "scoped");
});

test("resolve: plain override beats frontmatter", () => {
	const r = resolveModel({
		agent: agent({ model: "frontmatter" }),
		settings: { agentOverrides: { reviewer: { model: "override" } } },
	});
	assert.equal(r.model, "override");
});

test("resolve: frontmatter beats defaultModel", () => {
	const r = resolveModel({
		agent: agent({ model: "frontmatter" }),
		defaultModel: "default",
	});
	assert.equal(r.model, "frontmatter");
	assert.equal(r.source?.type, "frontmatter");
});

test("resolve: defaultModel used when frontmatter is absent", () => {
	const r = resolveModel({ agent: agent(), defaultModel: "default" });
	assert.equal(r.model, "default");
	assert.equal(r.source?.type, "subagents.defaultModel");
});

test("resolve: falls back to the dispatch model", () => {
	const r = resolveModel({ agent: agent(), dispatchModel: "parent/model" });
	assert.equal(r.model, "parent/model");
});

test("resolve: 'inherit' selects the dispatch model explicitly", () => {
	const r = resolveModel({
		agent: agent({ model: "inherit" }),
		dispatchModel: "parent/model",
	});
	assert.equal(r.model, "parent/model");
	assert.equal(r.source?.type, "inherit");
});

test("resolve: no candidates yields no model", () => {
	const r = resolveModel({ agent: agent() });
	assert.equal(r.model, undefined);
});

test("resolve: providerOf extracts the provider half", () => {
	assert.equal(providerOf("cb/glm-5.3:high"), "cb");
	assert.equal(providerOf("bare-model"), undefined);
	assert.equal(providerOf(undefined), undefined);
});

// ─────────────────────────── overrides ───────────────────────────

test("overrides: scalar fields replace frontmatter values", () => {
	const out = applyOverride(agent({ model: "old" }), {
		model: "new",
		thinking: "high",
	});
	assert.equal(out.model, "new");
	assert.equal(out.thinking, "high");
});

test("overrides: arrays are copied, not aliased", () => {
	const tools = ["read"];
	const out = applyOverride(agent(), { tools });
	tools.push("bash");
	assert.deepEqual(out.tools, ["read"]);
});

test("overrides: disabled removes the agent", () => {
	const out = applyAgentOverrides(
		[agent({ name: "a" }), agent({ name: "b" })],
		{ a: { disabled: true } },
	);
	assert.deepEqual(
		out.map((x) => x.name),
		["b"],
	);
});

test("overrides: unknown agent names are ignored", () => {
	const out = applyAgentOverrides([agent()], { nobody: { model: "x" } });
	assert.equal(out.length, 1);
	assert.equal(out[0]?.model, undefined);
});

test("overrides: absent overrides returns the same list", () => {
	const list = [agent()];
	assert.equal(applyAgentOverrides(list, undefined), list);
});

test("overrides: applyOverride honours a preset reference", () => {
	const out = applyOverride(agent(), { preset: "strong" });
	assert.equal(out.preset, "strong");
});

test("overrides: applyDefaultModel only fills agents without a model", () => {
	const out = applyDefaultModel(
		[agent({ name: "a" }), agent({ name: "b", model: "keep" })],
		"default",
	);
	assert.equal(out[0]?.model, "default");
	assert.equal(out[0]?.modelSource?.type, "subagents.defaultModel");
	assert.equal(out[1]?.model, "keep");
});

test("overrides: applyDefaultModel is a no-op without a default", () => {
	const list = [agent()];
	assert.equal(applyDefaultModel(list, undefined), list);
});

test("overrides: applyDefaultOnBlocked fills unset agents, keeps explicit choices", () => {
	const unset = agent();
	const gated = agent({ onBlocked: "forward" });
	const notified = agent({ onBlocked: "notify" });
	const out = applyDefaultOnBlocked([unset, gated, notified], "auto-approve");
	assert.equal(out[0]?.onBlocked, "auto-approve");
	assert.equal(out[1]?.onBlocked, "forward");
	assert.equal(out[2]?.onBlocked, "notify");
	// A filled agent is a copy, never an in-place mutation of the catalog.
	assert.notEqual(out[0], unset);
});

// ─────────────────────────── settings ───────────────────────────

test("settings: absent subagents key yields empty settings", () => {
	assert.deepEqual(parseSubagentSettings({}, "/s.json"), {});
	assert.deepEqual(parseSubagentSettings(undefined, "/s.json"), {});
});

test("settings: rejects a non-object subagents value", () => {
	assert.throws(() => parseSubagentSettings({ subagents: "x" }, "/s.json"));
	assert.throws(() => parseSubagentSettings({ subagents: [] }, "/s.json"));
});

test("settings: rejects an empty defaultModel", () => {
	assert.throws(() =>
		parseSubagentSettings({ subagents: { defaultModel: "  " } }, "/s.json"),
	);
});

test("settings: defaultOnBlocked validates and merges", () => {
	assert.deepEqual(
		parseSubagentSettings(
			{ subagents: { defaultOnBlocked: "forward" } },
			"/s.json",
		),
		{ defaultOnBlocked: "forward" },
	);
	assert.throws(() =>
		parseSubagentSettings(
			{ subagents: { defaultOnBlocked: "yolo" } },
			"/s.json",
		),
	);
	// Project wins over user for the overlapping key.
	const merged = resolveSubagentSettings(
		{ defaultOnBlocked: "auto-approve" },
		{ defaultOnBlocked: "forward" },
	);
	assert.equal(merged.defaultOnBlocked, "forward");
});

test("settings: a residual subagents.herdr block is silently dropped by the whitelist", () => {
	// v4 deleted the herdr settings surface, so the parser and its deprecation
	// warning are gone. An existing settings file must keep loading, with the
	// key ignored exactly like any other unknown key (contract D5).
	const original = console.warn;
	const warnings: string[] = [];
	try {
		console.warn = (...args: unknown[]) => warnings.push(args.map(String).join(" "));
		const settings = parseSubagentSettings(
			{ subagents: { herdr: { defaultPlacement: "new-tab", maxConcurrentAgents: 3 } } },
			"/legacy/settings.json",
		);
		assert.equal("herdr" in settings, false, "the key must not survive parsing");
		assert.equal(warnings.length, 0, "no deprecation warning remains");
	} finally {
		console.warn = original;
	}
});

test("settings: project settings win over user settings", () => {
	const merged = resolveSubagentSettings(
		{ defaultModel: "user" },
		{ defaultModel: "project" },
	);
	assert.equal(merged.defaultModel, "project");
});

test("settings: agentOverrides shallow-merge across scopes", () => {
	const merged = resolveSubagentSettings(
		{ agentOverrides: { a: { model: "ua" } } },
		{ agentOverrides: { b: { model: "pb" } } },
	);
	assert.deepEqual(Object.keys(merged.agentOverrides ?? {}).sort(), ["a", "b"]);
});

test("settings: presets survive parseSubagentSettings (the whitelist)", () => {
	// parseSubagentSettings assigns each key it reads explicitly; a parsed key
	// that is never assigned is silently discarded. This is the assertion the
	// whole feature leans on: `presets` must NOT be silently dropped. The
	// unknown-key twin below proves the drop is real, so this assertion is
	// not vacuous.
	const parsed = parseSubagentSettings(
		{
			subagents: {
				presets: { strong: { kind: "pi", model: "cb/kimi-k3" } },
			},
		},
		"/s.json",
	);
	assert.deepEqual(parsed.presets, {
		strong: { kind: "pi", model: "cb/kimi-k3" },
	});
});

test("settings: unknown subagents keys ARE silently dropped (whitelist)", () => {
	// Documents the exact behaviour the presets whitelist guards against:
	// any key not explicitly parsed+assigned vanishes without a word.
	const parsed = parseSubagentSettings(
		{ subagents: { typoKey: { model: "cb/x" } } },
		"/s.json",
	);
	assert.deepEqual(parsed, {});
	assert.equal((parsed as Record<string, unknown>).typoKey, undefined);
});

test("settings: presets shallow-merge across user/project", () => {
	const merged = resolveSubagentSettings(
		{
			presets: {
				cheap: { model: "cb/flash" },
				strong: { model: "cb/user-strong" },
			},
		},
		{ presets: { strong: { model: "cb/project-strong" } } },
	);
	assert.deepEqual(merged.presets, {
		cheap: { model: "cb/flash" },
		strong: { model: "cb/project-strong" },
	});
});

test("settings: project without presets keeps the user's presets", () => {
	const merged = resolveSubagentSettings(
		{ presets: { cheap: { model: "cb/flash" } } },
		{ defaultModel: "cb/mid" },
	);
	assert.deepEqual(merged.presets, { cheap: { model: "cb/flash" } });
});

test("settings: loadSubagentSettings tolerates a missing file", () => {
	assert.deepEqual(
		loadSubagentSettings({ userSettingsPath: "/nonexistent/xyz.json" }),
		{},
	);
});

test("settings: loadSubagentSettings reports malformed JSON with the path", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "settings-test-"));
	try {
		const file = path.join(dir, "settings.json");
		writeFileSync(file, "{ not json");
		assert.throws(
			() => loadSubagentSettings({ userSettingsPath: file }),
			/Invalid JSON/,
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("settings: a project file overlays user agentOverrides", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "settings-test-"));
	try {
		const user = path.join(dir, "user.json");
		const project = path.join(dir, "project.json");
		writeFileSync(
			user,
			JSON.stringify({
				subagents: {
					agentOverrides: {
						scout: { model: "cb/flash" },
						oracle: { model: "cb/opus" },
					},
				},
			}),
		);
		writeFileSync(
			project,
			JSON.stringify({
				subagents: {
					defaultModel: "cb/mid",
					agentOverrides: { oracle: { model: "cb/project-opus" } },
				},
			}),
		);
		const loaded = loadSubagentSettings({
			userSettingsPath: user,
			projectSettingsPath: project,
		});
		assert.equal(loaded.agentOverrides?.scout?.model, "cb/flash");
		assert.equal(loaded.agentOverrides?.oracle?.model, "cb/project-opus");
		assert.equal(loaded.defaultModel, "cb/mid");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// ─────────────────────────────────────────────────────────────────────────────
// BUG 14 (security): the glob → RegExp translation produced nested quantifiers
// (`*a*a*a…b` → `.*a.*a.*a…b`), which backtrack exponentially. The patterns
// come from `.pi/settings.json`, a file that travels with a cloned repository,
// so a hostile repo could hang the host process. Measured before the fix: a
// 100-star pattern against a non-matching model took 14.5s, doubling per star.
// ─────────────────────────────────────────────────────────────────────────────

test("glob matching is linear, not exponential, on adversarial patterns", () => {
	// Worst case: many stars, and an input that never matches (forces the
	// matcher to exhaust every alternative).
	const stars = 200;
	const pattern = `${"*a".repeat(stars)}*b`;
	const model = `cb/${"a".repeat(stars + 5)}`;

	const started = Date.now();
	const matched = matchesScopePattern(model, pattern);
	const elapsed = Date.now() - started;

	assert.equal(matched, false, "a model without 'b' must not match");
	assert.ok(
		elapsed < 1000,
		`glob matching must stay fast (took ${elapsed}ms; RegExp backtracking took ~14s at 100 stars)`,
	);
});

test("glob semantics: full match, case-insensitive, star spans slashes", () => {
	// A `*` is not path-aware here: it matches any characters, including `/`.
	assert.equal(matchesScopePattern("cb/glm-5.3", "*"), true);
	assert.equal(matchesScopePattern("cb/glm-5.3", "*glm*"), true);
	assert.equal(matchesScopePattern("cb/glm-5.3", "cb/glm-*"), true);
	assert.equal(matchesScopePattern("cb/glm-5.3", "CB/GLM-5.3"), true, "case-insensitive");
	// Anchored at both ends.
	assert.equal(matchesScopePattern("cb/glm-5.3", "glm-5.3"), false, "must be a full match");
	assert.equal(matchesScopePattern("cb/glm-5.3", "cb/glm"), false, "must be a full match");
	// Trailing stars may match the empty remainder.
	assert.equal(matchesScopePattern("cb/x", "cb/x*"), true);
	assert.equal(matchesScopePattern("cb/x", "cb/*"), true);
	// A pattern with no star is an exact comparison.
	assert.equal(matchesScopePattern("cb/x", "cb/x"), true);
	assert.equal(matchesScopePattern("cb/xy", "cb/x"), false);
	// Thinking suffixes are stripped before matching.
	assert.equal(matchesScopePattern("cb/glm-5.3:high", "cb/glm-5.3"), true);
	// Literal regex metacharacters are treated literally, not as syntax.
	assert.equal(matchesScopePattern("cb/a.b", "cb/a.b"), true);
	assert.equal(matchesScopePattern("cb/axb", "cb/a.b"), false, "'.' must be literal");
	assert.equal(matchesScopePattern("cb/a+b", "cb/a+b"), true);
	assert.equal(matchesScopePattern("cb/aab", "cb/a+b"), false, "'+' must be literal");
});

// ─────────────────────────────────────────────────────────────────────────────
// BUG 22: `agentOverrides` values were accepted as anything. A scalar passed
// validation and was then ignored by the field-by-field merge, so the override
// looked configured while doing nothing — the same "accepted but inert" trap
// as F45, except here the user wrote the setting themselves.
// ─────────────────────────────────────────────────────────────────────────────

test("agentOverrides: a non-object value is rejected, not silently ignored", () => {
	for (const value of ["x", 42, true, [], null]) {
		assert.throws(
			() =>
				parseSubagentSettings(
					{ subagents: { agentOverrides: { worker: value } } },
					"/s.json",
				),
			/agentOverrides\.worker/,
			`agentOverrides.worker = ${JSON.stringify(value)} must be rejected`,
		);
	}
});

test("agentOverrides: valid object values are accepted", () => {
	const parsed = parseSubagentSettings(
		{
			subagents: {
				agentOverrides: {
					worker: { model: "cb/glm-5.3" },
					reviewer: { disabled: true },
				},
			},
		},
		"/s.json",
	);
	assert.deepEqual(parsed.agentOverrides, {
		worker: { model: "cb/glm-5.3" },
		reviewer: { disabled: true },
	});
});

test("applyOverride ignores the dead legacy Placement field", () => {
	const override = { placement: "new-tab" } as unknown as Parameters<typeof applyOverride>[1];
	const resolved = applyOverride(agent(), override);
	assert.equal("placement" in resolved, false);
});

test("agentOverrides ignore legacy Placement in the RPC migration", () => {
	const parsed = parseSubagentSettings(
		{
			subagents: {
				agentOverrides: { worker: { model: "cb/glm-5.3", placement: "new-tab" } },
				teams: { frontend: { members: [{ agent: "worker", placement: "split-down" }] } },
			},
		},
		"/s.json",
	);
	assert.deepEqual(parsed.agentOverrides, { worker: { model: "cb/glm-5.3" } });
	assert.deepEqual(parsed.teams?.frontend?.members, [{ agent: "worker" }]);
});

test("modelCandidates is unique and keeps an empty primary as one attempt", () => {
	assert.deepEqual(modelCandidates("a/b", ["a/b", "c/d"]), ["a/b", "c/d"]);
	assert.deepEqual(modelCandidates(undefined, ["c/d"]), [undefined, "c/d"]);
	assert.deepEqual(modelCandidates(undefined, undefined), [undefined]);
	assert.deepEqual(modelCandidates("  ", [" x "]), [undefined, "x"]);
});

// ─────────────────────────── join settings (smart join) ───────────────────────────

test("settings: joinMode accepts each/smart, rejects anything else", () => {
	assert.deepEqual(
		parseSubagentSettings({ subagents: { joinMode: "each" } }, "/s.json"),
		{ joinMode: "each" },
	);
	assert.deepEqual(
		parseSubagentSettings({ subagents: { joinMode: "smart" } }, "/s.json"),
		{ joinMode: "smart" },
	);
	assert.throws(
		() => parseSubagentSettings({ subagents: { joinMode: "batch" } }, "/s.json"),
		/invalid 'joinMode'/,
	);
	assert.throws(
		() => parseSubagentSettings({ subagents: { joinMode: 42 } }, "/s.json"),
		/invalid 'joinMode'/,
	);
});

test("settings: joinFlushMs must be a positive integer", () => {
	assert.deepEqual(
		parseSubagentSettings({ subagents: { joinFlushMs: 5000 } }, "/s.json"),
		{ joinFlushMs: 5000 },
	);
	assert.throws(() =>
		parseSubagentSettings({ subagents: { joinFlushMs: 0 } }, "/s.json"),
	);
	assert.throws(() =>
		parseSubagentSettings({ subagents: { joinFlushMs: -1 } }, "/s.json"),
	);
	assert.throws(() =>
		parseSubagentSettings({ subagents: { joinFlushMs: 1.5 } }, "/s.json"),
	);
});

test("settings: join keys default to absent and project overrides user", () => {
	assert.deepEqual(parseSubagentSettings({ subagents: {} }, "/s.json"), {});
	const merged = resolveSubagentSettings(
		{ joinMode: "each", joinFlushMs: 1000 },
		{ joinMode: "smart", joinFlushMs: 2000 },
	);
	assert.equal(merged.joinMode, "smart");
	assert.equal(merged.joinFlushMs, 2000);
	// A project that sets neither keeps the user's join config.
	const kept = resolveSubagentSettings(
		{ joinMode: "each", joinFlushMs: 1000 },
		{ defaultModel: "cb/mid" },
	);
	assert.equal(kept.joinMode, "each");
	assert.equal(kept.joinFlushMs, 1000);
});
