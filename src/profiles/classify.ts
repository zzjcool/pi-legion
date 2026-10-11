/**
 * Role-tier classification used to generate cheap / medium / strong profiles.
 *
 * Ported from pi-subagents: rank models by cost + name heuristics, then pick
 * three points on that ranking. Quota profiles sit lower; quality profiles sit
 * higher. Built-in writer roles map onto those three tiers.
 */

export type ProfileKind = "quota" | "quality";
export type CostTier = "cheap" | "medium" | "expensive";
export type QualityTier = "weak" | "medium" | "strong";
export type LatencyTier = "fast" | "medium" | "slow";
export type RecommendedRoleTier = "cheap" | "medium" | "strong";
export type ClassificationSource = "official-metadata" | "heuristic-name";

export const TIER_AGENTS = {
	cheap: ["scout", "prototype"],
	medium: ["planner"],
	strong: ["worker", "reviewer", "designer", "centurion"],
} as const;

export type BuiltinProfileAgent =
	| (typeof TIER_AGENTS.cheap)[number]
	| (typeof TIER_AGENTS.medium)[number]
	| (typeof TIER_AGENTS.strong)[number];

export interface ModelClassificationInput {
	id: string;
	name?: string;
	reasoning?: boolean;
	contextWindow?: number;
	maxTokens?: number;
	cost?: {
		input?: number;
		output?: number;
		cacheRead?: number;
		cacheWrite?: number;
	};
}

export interface ModelClassification {
	profileRank: number;
	costTier: CostTier;
	qualityTier: QualityTier;
	latencyTier: LatencyTier;
	recommendedRoleTier: RecommendedRoleTier;
	recommendedAgents: BuiltinProfileAgent[];
	classificationSources: ClassificationSource[];
}

interface NumericStats {
	min: number;
	max: number;
}

export interface ClassificationContext {
	cost?: NumericStats;
	contextWindow?: NumericStats;
	maxTokens?: NumericStats;
}

export interface RankedModel {
	fullId: string;
	profileRank: number;
	cost?: ModelClassificationInput["cost"];
	reasoning?: boolean;
	contextWindow?: number;
	maxTokens?: number;
}

export interface ProfileAgentOverride {
	model?: string;
	thinking?: string | false;
	fallbackModels?: string[] | false;
}

export interface SubagentProfileFile {
	subagents: {
		agentOverrides: Record<string, ProfileAgentOverride>;
		disableBuiltins?: boolean;
		[key: string]: unknown;
	};
}

export function agentsForRoleTier(
	roleTier: RecommendedRoleTier,
): BuiltinProfileAgent[] {
	if (roleTier === "cheap") return [...TIER_AGENTS.cheap];
	if (roleTier === "medium") return [...TIER_AGENTS.medium];
	return [...TIER_AGENTS.strong];
}

export function extractVersionScore(id: string): number {
	const match = id.match(/(\d+(?:\.\d+)?)/g);
	if (!match || match.length === 0) return 0;
	return Math.max(
		...match
			.map((value) => Number.parseFloat(value))
			.filter((value) => Number.isFinite(value)),
	);
}

export function modelNameTokens(modelName: string): string[] {
	return modelName
		.toLowerCase()
		.replace(/([a-z])([0-9])/g, "$1 $2")
		.replace(/([0-9])([a-z])/g, "$1 $2")
		.split(/[^a-z0-9.]+/)
		.filter(Boolean);
}

/** Name-heuristic band: 0 flash/nano … 4 opus/pro. */
export function inferProfileBand(modelName: string): 0 | 1 | 2 | 3 | 4 {
	const tokens = new Set(modelNameTokens(modelName));
	if (
		["spark", "flash", "nano", "tiny", "instant"].some((token) =>
			tokens.has(token),
		)
	) {
		return 0;
	}
	if (["mini", "haiku", "small"].some((token) => tokens.has(token))) return 1;
	if (["opus", "max", "ultra", "pro"].some((token) => tokens.has(token))) {
		return 4;
	}
	if (["sonnet", "turbo", "plus"].some((token) => tokens.has(token))) return 3;
	return 2;
}

function combinedCost(
	cost: ModelClassificationInput["cost"],
): number | undefined {
	if (!cost) return undefined;
	const values = [
		cost.input,
		cost.output,
		cost.cacheRead,
		cost.cacheWrite,
	].filter(
		(value): value is number =>
			typeof value === "number" && Number.isFinite(value),
	);
	if (values.length === 0) return undefined;
	return values.reduce((sum, value) => sum + value, 0);
}

function collectStats(values: Array<number | undefined>): NumericStats | undefined {
	const filtered = values.filter(
		(value): value is number =>
			typeof value === "number" && Number.isFinite(value),
	);
	if (filtered.length === 0) return undefined;
	return { min: Math.min(...filtered), max: Math.max(...filtered) };
}

function normalize(
	value: number | undefined,
	stats: NumericStats | undefined,
): number | undefined {
	if (value === undefined || !stats) return undefined;
	if (stats.max <= stats.min) return 0.5;
	return (value - stats.min) / (stats.max - stats.min);
}

export function buildClassificationContext(
	models: ModelClassificationInput[],
): ClassificationContext {
	return {
		cost: collectStats(models.map((model) => combinedCost(model.cost))),
		contextWindow: collectStats(models.map((model) => model.contextWindow)),
		maxTokens: collectStats(models.map((model) => model.maxTokens)),
	};
}

function rankToCostTier(rank: number): CostTier {
	if (rank <= 0.33) return "cheap";
	if (rank <= 0.66) return "medium";
	return "expensive";
}

function scoreToQualityTier(score: number): QualityTier {
	if (score <= 0.33) return "weak";
	if (score <= 0.66) return "medium";
	return "strong";
}

function qualityTierToRoleTier(
	quality: QualityTier,
	cost: CostTier,
): RecommendedRoleTier {
	if (quality === "strong") return "strong";
	if (quality === "medium") return cost === "cheap" ? "cheap" : "medium";
	return "cheap";
}

export function classifyModel(
	input: ModelClassificationInput,
	context: ClassificationContext = {},
): ModelClassification {
	const modelName = input.name?.trim() || input.id;
	const tokens = new Set(modelNameTokens(modelName));
	const band = inferProfileBand(modelName);
	const versionScore = extractVersionScore(input.id);
	const costNorm = normalize(combinedCost(input.cost), context.cost);
	const contextNorm = normalize(input.contextWindow, context.contextWindow);
	const maxTokensNorm = normalize(input.maxTokens, context.maxTokens);
	const hasOfficialMetadata =
		costNorm !== undefined ||
		contextNorm !== undefined ||
		maxTokensNorm !== undefined;
	const classificationSources: ClassificationSource[] = hasOfficialMetadata
		? ["official-metadata", "heuristic-name"]
		: ["heuristic-name"];
	const heuristicBase = band / 4;
	const qualitySignals = [
		heuristicBase,
		...(contextNorm !== undefined ? [contextNorm] : []),
		...(maxTokensNorm !== undefined ? [maxTokensNorm] : []),
		...(input.reasoning === true ? [1] : []),
		...(input.reasoning === false ? [0] : []),
	];
	const latencyHintsFast =
		tokens.has("highspeed") ||
		tokens.has("flash") ||
		tokens.has("instant") ||
		tokens.has("turbo");
	const latencyHintsSlow =
		tokens.has("pro") ||
		tokens.has("ultra") ||
		tokens.has("opus") ||
		tokens.has("max");
	let qualityScore =
		qualitySignals.reduce((sum, value) => sum + value, 0) /
		qualitySignals.length;
	if (latencyHintsFast) qualityScore -= 0.2;
	qualityScore = Math.max(0, Math.min(1, qualityScore));
	const costTier =
		costNorm !== undefined
			? rankToCostTier(costNorm)
			: band === 0
				? "cheap"
				: band >= 3
					? "expensive"
					: "medium";
	const qualityTier = scoreToQualityTier(qualityScore);
	const latencyTier: LatencyTier = latencyHintsFast
		? "fast"
		: latencyHintsSlow
			? "slow"
			: costNorm !== undefined
				? costNorm <= 0.33
					? "fast"
					: costNorm <= 0.66
						? "medium"
						: "slow"
				: band <= 1
					? "fast"
					: band >= 3
						? "slow"
						: "medium";
	const recommendedRoleTier = qualityTierToRoleTier(qualityTier, costTier);
	const latencyPenalty = latencyHintsFast ? 125 : 0;
	const profileRank =
		Math.round(qualityScore * 100 * 10) +
		Math.round(versionScore * 25) -
		latencyPenalty;
	return {
		profileRank,
		costTier,
		qualityTier,
		latencyTier,
		recommendedRoleTier,
		recommendedAgents: agentsForRoleTier(recommendedRoleTier),
		classificationSources,
	};
}

function roundIndex(count: number, position: number): number {
	if (count <= 1) return 0;
	return Math.max(
		0,
		Math.min(count - 1, Math.round((count - 1) * position)),
	);
}

export function profilePositions(
	kind: ProfileKind,
): { cheap: number; medium: number; strong: number } {
	return kind === "quota"
		? { cheap: 0, medium: 1 / 3, strong: 2 / 3 }
		: { cheap: 1 / 3, medium: 2 / 3, strong: 1 };
}

export function pickTierModels(
	models: Array<{ fullId: string }>,
	kind: ProfileKind,
): { cheap: string; medium: string; strong: string } {
	if (models.length === 0) {
		throw new Error("No provider models are available for profile generation.");
	}
	const selectionPool =
		kind === "quota" && models.length > 1 ? models.slice(0, -1) : models;
	const positions = profilePositions(kind);
	const cheap = selectionPool[roundIndex(selectionPool.length, positions.cheap)];
	const medium = selectionPool[roundIndex(selectionPool.length, positions.medium)];
	const strong = selectionPool[roundIndex(selectionPool.length, positions.strong)];
	if (!cheap || !medium || !strong) {
		throw new Error("No provider models are available for profile generation.");
	}
	return {
		cheap: cheap.fullId,
		medium: medium.fullId,
		strong: strong.fullId,
	};
}

function observedCombinedCost(model: RankedModel): number | undefined {
	return combinedCost(model.cost);
}

function dominatesModel(a: RankedModel, b: RankedModel): boolean {
	const costA = observedCombinedCost(a);
	const costB = observedCombinedCost(b);
	if (costA === undefined || costB === undefined) return false;
	if (costA > costB) return false;
	if (a.profileRank < b.profileRank) return false;
	if ((a.reasoning === true ? 1 : 0) < (b.reasoning === true ? 1 : 0)) {
		return false;
	}
	if ((a.contextWindow ?? 0) < (b.contextWindow ?? 0)) return false;
	if ((a.maxTokens ?? 0) < (b.maxTokens ?? 0)) return false;
	return (
		costA < costB ||
		a.profileRank > b.profileRank ||
		(a.reasoning === true && b.reasoning !== true) ||
		(a.contextWindow ?? 0) > (b.contextWindow ?? 0) ||
		(a.maxTokens ?? 0) > (b.maxTokens ?? 0)
	);
}

export function filterDominatedModels<T extends RankedModel>(models: T[]): T[] {
	return models.filter(
		(candidate, index) =>
			!models.some(
				(other, otherIndex) =>
					otherIndex !== index && dominatesModel(other, candidate),
			),
	);
}

/** Build the `agentOverrides` document a profile file stores. */
export function buildProfileFile(
	models: { cheap: string; medium: string; strong: string },
): SubagentProfileFile {
	const agentOverrides: Record<string, ProfileAgentOverride> = {};
	for (const name of TIER_AGENTS.cheap) {
		agentOverrides[name] = { model: models.cheap };
	}
	for (const name of TIER_AGENTS.medium) {
		agentOverrides[name] = { model: models.medium };
	}
	for (const name of TIER_AGENTS.strong) {
		agentOverrides[name] = { model: models.strong };
	}
	return { subagents: { agentOverrides } };
}

export function usesHeuristicClassification(
	sources: ClassificationSource[],
): boolean {
	return (
		sources.includes("heuristic-name") &&
		!sources.includes("official-metadata")
	);
}
