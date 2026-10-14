/**
 * Write an isolated Pi agent dir that points at the mock OpenAI endpoint.
 * Uses dummy apiKey "mock" — never copies host auth.json / real keys.
 */

import fs from "node:fs";
import path from "node:path";
import type { MockModelDef } from "./types.ts";

export interface WriteMockPiHomeOptions {
	/** Absolute directory to create (becomes PI_CODING_AGENT_DIR). */
	dir: string;
	/** e.g. http://127.0.0.1:8765/v1 */
	baseUrl: string;
	providerId?: string;
	modelId?: string;
	models?: MockModelDef[];
	/** Absolute paths of packages / extensions to load (e.g. this plugin). */
	packages?: string[];
	extraSettings?: Record<string, unknown>;
}

export const MOCK_PROVIDER_ID = "mock";
export const MOCK_MODEL_ID = "flash";
/** Dummy credential only — OpenAI-compatible mock ignores it. */
export const MOCK_API_KEY = "mock";

export function mockProviderBlock(baseUrl: string, models?: MockModelDef[]) {
	const list =
		models && models.length > 0
			? models
			: [
					{
						id: MOCK_MODEL_ID,
						name: "Mock Flash",
						reasoning: false,
						input: ["text"],
						contextWindow: 32_000,
						maxTokens: 2048,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					},
				];
	return {
		baseUrl,
		api: "openai-completions",
		apiKey: MOCK_API_KEY,
		compat: {
			supportsDeveloperRole: false,
			supportsReasoningEffort: false,
			supportsUsageInStreaming: true,
			supportsFinishReason: true,
		},
		models: list.map((m) => ({
			id: m.id,
			name: m.name ?? m.id,
			reasoning: m.reasoning ?? false,
			input: ["text"],
			contextWindow: m.contextWindow ?? 32_000,
			maxTokens: m.maxTokens ?? 2048,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		})),
	};
}

/**
 * Create `settings.json` + `models.json` under `dir` for offline pi runs.
 * Does **not** write auth.json (dummy key lives in models.json).
 */
export function writeMockPiHome(options: WriteMockPiHomeOptions): {
	agentDir: string;
	providerId: string;
	modelId: string;
	modelRef: string;
} {
	const providerId = options.providerId ?? MOCK_PROVIDER_ID;
	const modelId = options.modelId ?? MOCK_MODEL_ID;
	const agentDir = path.resolve(options.dir);
	fs.mkdirSync(agentDir, { recursive: true });

	const settings: Record<string, unknown> = {
		defaultProvider: providerId,
		defaultModel: modelId,
		defaultThinkingLevel: "off",
		defaultProjectTrust: "always",
		...(options.packages ? { packages: options.packages } : {}),
		...options.extraSettings,
	};
	fs.writeFileSync(
		path.join(agentDir, "settings.json"),
		`${JSON.stringify(settings, null, 2)}\n`,
		{ mode: 0o600 },
	);

	const modelsJson = {
		$schema: "https://pi.dev/schemas/models.schema.json",
		providers: {
			[providerId]: mockProviderBlock(options.baseUrl, options.models),
		},
	};
	fs.writeFileSync(
		path.join(agentDir, "models.json"),
		`${JSON.stringify(modelsJson, null, 2)}\n`,
		{ mode: 0o600 },
	);

	return {
		agentDir,
		providerId,
		modelId,
		modelRef: `${providerId}/${modelId}`,
	};
}

/** Env overlay for child / parent pi processes using the mock home. */
export function mockPiEnv(agentDir: string, extra: Record<string, string> = {}): Record<string, string> {
	return {
		PI_CODING_AGENT_DIR: agentDir,
		PI_OFFLINE: "1",
		// Ensure no ambient provider keys leak into the mock session.
		OPENAI_API_KEY: "",
		ANTHROPIC_API_KEY: "",
		...extra,
	};
}
