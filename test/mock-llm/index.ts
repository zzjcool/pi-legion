/** Public entry for tests and harnesses that import the mock LLM. */
export { startMockLlm } from "./server.ts";
export type { MockLlmHandle } from "./server.ts";
export {
	echoScenario,
	toolOnceScenario,
	spawnScoutScenario,
	childDoneScenario,
	doctorScenario,
	stopAllScenario,
	declareVerifyScenario,
	listScenarioNames,
	resolveScenario,
} from "./scenarios.ts";
export {
	writeMockPiHome,
	mockProviderBlock,
	mockPiEnv,
	MOCK_PROVIDER_ID,
	MOCK_MODEL_ID,
	MOCK_API_KEY,
} from "./pi-home.ts";
export type { WriteMockPiHomeOptions } from "./pi-home.ts";
export {
	pickActions,
	resolveContext,
	whenMatches,
	inferRole,
	extractMockSay,
	extractMockTool,
	flattenMessages,
} from "./script-engine.ts";
export type {
	MockScript,
	MockRule,
	MockAction,
	MockWhen,
	MockModelDef,
	MockServerOptions,
	ChatCompletionRequest,
	ResolvedRequestContext,
} from "./types.ts";
