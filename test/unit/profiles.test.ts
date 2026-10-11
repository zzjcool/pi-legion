import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { BUILTIN_AGENT_NAMES } from "../../src/agents/agents.ts";
import { getAgentDir } from "../../src/agents/paths.ts";
import {
	TIER_AGENTS,
	agentsForRoleTier,
	buildClassificationContext,
	buildProfileFile,
	classifyModel,
	filterDominatedModels,
	inferProfileBand,
	pickTierModels,
} from "../../src/profiles/classify.ts";
import {
	applySubagentProfile,
	checkSubagentProfile,
	generateProfilesForProvider,
	isProviderModelCatalogStale,
	listSubagentProfiles,
	normalizePathToken,
	readSubagentProfile,
	refreshProviderModelCatalog,
	resolveProfilePaths,
	validateSubagentProfile,
	type RegistryModelLike,
} from "../../src/profiles/profiles.ts";
import {
	parseProviderArgs,
	parseSingleRequiredArg,
} from "../../src/extension/slash.ts";
import { withTempDir } from "../helpers/tmp.ts";

function registryModel(
	over: Partial<RegistryModelLike> & Pick<RegistryModelLike, "id">,
): RegistryModelLike {
	return {
		provider: "cb",
		...over,
	};
}

function fakeRegistry(models: RegistryModelLike[]) {
	return { getAvailable: () => models };
}

test("every bundled role is assigned a cheap/medium/strong tier", () => {
	const assigned = new Set([
		...TIER_AGENTS.cheap,
		...TIER_AGENTS.medium,
		...TIER_AGENTS.strong,
	]);
	// advisor is a cursor-kind role: it carries its own model and never takes
	// a pi-tier override, so the tier system must cover every PI role exactly.
	const piRoles = BUILTIN_AGENT_NAMES.filter((n) => n !== "advisor");
	assert.deepEqual([...assigned].sort(), [...piRoles].sort());
	assert.deepEqual(agentsForRoleTier("cheap"), [...TIER_AGENTS.cheap]);
	assert.deepEqual(agentsForRoleTier("medium"), [...TIER_AGENTS.medium]);
	assert.deepEqual(agentsForRoleTier("strong"), [...TIER_AGENTS.strong]);
});

test("name heuristics: flash/haiku/sonnet/opus bands", () => {
	assert.equal(inferProfileBand("glm-5.3-flash"), 0);
	assert.equal(inferProfileBand("claude-haiku-4"), 1);
	assert.equal(inferProfileBand("generic-model"), 2);
	assert.equal(inferProfileBand("claude-sonnet-4"), 3);
	assert.equal(inferProfileBand("claude-opus-4"), 4);
});

test("classify: flash is cheap, opus is strong", () => {
	const models = [
		{ id: "glm-flash", name: "GLM Flash" },
		{ id: "claude-sonnet", name: "Claude Sonnet" },
		{ id: "claude-opus", name: "Claude Opus", reasoning: true },
	];
	const ctx = buildClassificationContext(models);
	const flash = classifyModel(models[0]!, ctx);
	const opus = classifyModel(models[2]!, ctx);
	assert.equal(flash.recommendedRoleTier, "cheap");
	assert.ok(opus.profileRank > flash.profileRank);
	assert.equal(opus.recommendedRoleTier, "strong");
	assert.deepEqual(flash.classificationSources, ["heuristic-name"]);
});

test("classify: official cost metadata is recorded as a source", () => {
	const models = [
		{ id: "a", cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } },
		{ id: "b", cost: { input: 9, output: 9, cacheRead: 0, cacheWrite: 0 } },
	];
	const classified = classifyModel(models[0]!, buildClassificationContext(models));
	assert.ok(classified.classificationSources.includes("official-metadata"));
	assert.equal(classified.costTier, "cheap");
});

test("pickTierModels: quota sits lower than quality", () => {
	const ranked = [
		{ fullId: "cb/a" },
		{ fullId: "cb/b" },
		{ fullId: "cb/c" },
		{ fullId: "cb/d" },
		{ fullId: "cb/e" },
		{ fullId: "cb/f" },
	];
	const quota = pickTierModels(ranked, "quota");
	const quality = pickTierModels(ranked, "quality");
	assert.equal(quota.cheap, "cb/a");
	assert.notEqual(quota.strong, "cb/f", "quota drops the strongest model");
	assert.equal(quality.strong, "cb/f");
	const order = ranked.map((m) => m.fullId);
	assert.ok(
		order.indexOf(quota.medium) <= order.indexOf(quality.medium),
		"quota medium should not sit above quality medium",
	);
});

test("pickTierModels: a single model fills every tier", () => {
	const only = pickTierModels([{ fullId: "cb/solo" }], "quality");
	assert.deepEqual(only, {
		cheap: "cb/solo",
		medium: "cb/solo",
		strong: "cb/solo",
	});
});

test("filterDominatedModels: cheaper equal-or-better model wins", () => {
	const kept = filterDominatedModels([
		{
			fullId: "cb/weak-expensive",
			profileRank: 10,
			cost: { input: 9, output: 9 },
		},
		{
			fullId: "cb/strong-cheap",
			profileRank: 50,
			cost: { input: 1, output: 1 },
			reasoning: true,
			contextWindow: 200_000,
			maxTokens: 16_000,
		},
	]);
	assert.deepEqual(
		kept.map((m) => m.fullId),
		["cb/strong-cheap"],
	);
});

test("buildProfileFile maps all profiled built-in roles onto the three tiers", () => {
	const file = buildProfileFile({
		cheap: "cb/flash",
		medium: "cb/sonnet",
		strong: "cb/opus",
	});
	assert.equal(file.subagents.agentOverrides.scout?.model, "cb/flash");
	assert.equal(file.subagents.agentOverrides.prototype?.model, "cb/flash");
	assert.equal(file.subagents.agentOverrides.planner?.model, "cb/sonnet");
	assert.equal(file.subagents.agentOverrides.worker?.model, "cb/opus");
	assert.equal(file.subagents.agentOverrides.reviewer?.model, "cb/opus");
	assert.equal(file.subagents.agentOverrides.designer?.model, "cb/opus");
	assert.equal(file.subagents.agentOverrides.centurion?.model, "cb/opus");
	assert.equal(
		Object.keys(file.subagents.agentOverrides).length,
		[...TIER_AGENTS.cheap, ...TIER_AGENTS.medium, ...TIER_AGENTS.strong]
			.length,
	);
});

test("normalizePathToken rejects traversal and empty names", () => {
	assert.equal(normalizePathToken("cb", "Provider"), "cb");
	assert.throws(() => normalizePathToken("../x", "Provider"));
	assert.throws(() => normalizePathToken("a/b", "Provider"));
	assert.throws(() => normalizePathToken("", "Provider"));
	assert.throws(() => normalizePathToken("..", "Profile name"));
});

test("applySubagentProfile writes agentOverrides and keeps other settings", async () => {
	await withTempDir(async (dir) => {
		const paths = resolveProfilePaths({ agentDir: dir });
		mkdirSync(paths.profilesDir, { recursive: true });
		writeFileSync(
			path.join(paths.profilesDir, "cb.quota.json"),
			JSON.stringify(
				buildProfileFile({
					cheap: "cb/flash",
					medium: "cb/sonnet",
					strong: "cb/opus",
				}),
			),
		);
		writeFileSync(
			paths.settingsPath,
			JSON.stringify({
				theme: "keep-me",
				subagents: {
					defaultModel: "cb/other",
					modelScope: { enforce: true, allow: ["cb/*"] },
					herdr: { maxConcurrentAgents: 3 },
				},
			}),
		);

		const result = applySubagentProfile("cb.quota", { agentDir: dir });
		assert.equal(result.settingsPath, paths.settingsPath);
		const saved = JSON.parse(readFileSync(paths.settingsPath, "utf-8")) as {
			theme: string;
			subagents: {
				defaultModel: string;
				agentOverrides: Record<string, { model: string }>;
				modelScope: { enforce: boolean };
				herdr: { maxConcurrentAgents: number };
			};
		};
		assert.equal(saved.theme, "keep-me");
		assert.equal(saved.subagents.defaultModel, "cb/other");
		assert.equal(saved.subagents.modelScope.enforce, true);
		assert.equal(saved.subagents.herdr.maxConcurrentAgents, 3);
		const scout = saved.subagents.agentOverrides.scout;
		const reviewer = saved.subagents.agentOverrides.reviewer;
		assert.ok(scout);
		assert.ok(reviewer);
		assert.equal(scout.model, "cb/flash");
		assert.equal(reviewer.model, "cb/opus");
	});
});

test("readSubagentProfile reports malformed JSON with its file path", async () => {
	await withTempDir(async (dir) => {
		const paths = resolveProfilePaths({ agentDir: dir });
		mkdirSync(paths.profilesDir, { recursive: true });
		const file = path.join(paths.profilesDir, "broken.json");
		writeFileSync(file, "{ invalid");
		assert.throws(
			() => readSubagentProfile("broken", { agentDir: dir }),
			(error: unknown) =>
				error instanceof Error &&
				error.message.includes(`Invalid JSON in '${file}'`),
		);
	});
});

test("list/read profiles ignore the providers subdirectory", async () => {
	await withTempDir(async (dir) => {
		const paths = resolveProfilePaths({ agentDir: dir });
		mkdirSync(paths.providersDir, { recursive: true });
		writeFileSync(
			path.join(paths.profilesDir, "cb.quality.json"),
			JSON.stringify(
				buildProfileFile({
					cheap: "cb/a",
					medium: "cb/b",
					strong: "cb/c",
				}),
			),
		);
		writeFileSync(
			path.join(paths.providersDir, "cb.models.json"),
			JSON.stringify({ provider: "cb", models: [] }),
		);
		assert.deepEqual(listSubagentProfiles({ agentDir: dir }), ["cb.quality"]);
		const { profile } = readSubagentProfile("cb.quality", { agentDir: dir });
		assert.equal(profile.subagents.agentOverrides.worker?.model, "cb/c");
	});
});

test("validateSubagentProfile rejects a missing agentOverrides object", () => {
	assert.throws(
		() => validateSubagentProfile("/p.json", { subagents: {} }),
		/agentOverrides/,
	);
	assert.throws(
		() =>
			validateSubagentProfile("/p.json", {
				subagents: { agentOverrides: { scout: "nope" } },
			}),
		/override 'scout'/,
	);
});

test("generateProfilesForProvider writes quota and quality files", async () => {
	await withTempDir(async (dir) => {
		const models = [
			registryModel({ id: "flash", name: "Flash" }),
			registryModel({ id: "mid", name: "Mid" }),
			registryModel({
				id: "opus",
				name: "Opus",
				reasoning: true,
				contextWindow: 200_000,
			}),
		];
		const result = await generateProfilesForProvider(
			{},
			fakeRegistry(models),
			"cb",
			{ agentDir: dir, probe: false },
		);
		assert.ok(existsSync(result.quotaPath));
		assert.ok(existsSync(result.qualityPath));
		assert.ok(existsSync(result.catalogPath));
		const quota = readSubagentProfile("cb.quota", { agentDir: dir }).profile;
		assert.equal(
			quota.subagents.agentOverrides.scout?.model,
			result.quotaModels.cheap,
		);
		assert.equal(
			quota.subagents.agentOverrides.planner?.model,
			result.quotaModels.medium,
		);
		assert.equal(
			quota.subagents.agentOverrides.worker?.model,
			result.quotaModels.strong,
		);
		assert.equal(result.quotaModels.cheap, "cb/flash");
		assert.equal(result.qualityModels.strong, "cb/opus");
	});
});

test("refresh reuses a fresh catalog and refreshes a stale one", async () => {
	await withTempDir(async (dir) => {
		const models = [registryModel({ id: "flash", name: "Flash" })];
		const first = await refreshProviderModelCatalog(
			{},
			fakeRegistry(models),
			"cb",
			{ agentDir: dir, probe: false },
		);
		assert.equal(first.reused, false);
		const second = await refreshProviderModelCatalog(
			{},
			fakeRegistry(models),
			"cb",
			{ agentDir: dir, probe: false },
		);
		assert.equal(second.reused, true);
		assert.equal(
			isProviderModelCatalogStale(first.catalog, 7, Date.parse(first.catalog.refreshedAt) + 8 * 24 * 60 * 60 * 1000),
			true,
		);
		const forced = await refreshProviderModelCatalog(
			{},
			fakeRegistry([
				...models,
				registryModel({ id: "opus", name: "Opus" }),
			]),
			"cb",
			{ agentDir: dir, probe: false, force: true },
		);
		assert.equal(forced.reused, false);
		assert.equal(forced.catalog.models.length, 2);
	});
});

test("checkSubagentProfile reports registry hits without probing", async () => {
	await withTempDir(async (dir) => {
		const models = [
			registryModel({ id: "flash", name: "Flash" }),
			registryModel({ id: "opus", name: "Opus" }),
		];
		await generateProfilesForProvider({}, fakeRegistry(models), "cb", {
			agentDir: dir,
			probe: false,
		});
		const checked = await checkSubagentProfile(
			{},
			fakeRegistry(models),
			"cb.quota",
			{ agentDir: dir, probe: false },
		);
		assert.ok(checked.results.length >= 3);
		assert.ok(checked.results.every((entry) => entry.inRegistry));
		assert.ok(checked.results.every((entry) => entry.probe.status === "skipped"));
	});
});

test("refresh reports unknown providers clearly", async () => {
	await withTempDir(async (dir) => {
		await assert.rejects(
			() =>
				refreshProviderModelCatalog({}, fakeRegistry([]), "cb", {
					agentDir: dir,
					probe: false,
					force: true,
				}),
			/No models found/,
		);
	});
});

test("slash arg parsing: required name, force, no-probe", () => {
	assert.deepEqual(parseSingleRequiredArg("cb.quota", "usage"), {
		ok: true,
		value: "cb.quota",
	});
	assert.equal(parseSingleRequiredArg("", "usage").ok, false);
	assert.equal(parseSingleRequiredArg("a b", "usage").ok, false);

	const force = parseProviderArgs("cb --force", "usage");
	assert.equal(force.ok, true);
	if (force.ok) {
		assert.equal(force.provider, "cb");
		assert.equal(force.force, true);
		assert.equal(force.probe, true);
	}

	const noProbe = parseProviderArgs("cb --no-probe", "usage");
	assert.equal(noProbe.ok, true);
	if (noProbe.ok) {
		assert.equal(noProbe.provider, "cb");
		assert.equal(noProbe.force, false);
		assert.equal(noProbe.probe, false);
	}
});

test("getAgentDir honours PI_CODING_AGENT_DIR", () => {
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = "/tmp/custom-pi-agent";
	try {
		assert.equal(getAgentDir(), "/tmp/custom-pi-agent");
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
	}
});
