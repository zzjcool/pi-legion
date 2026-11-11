/**
 * The `resolveCliModel` warning a legitimate CUSTOM model id produces (B5).
 *
 * pi answers `Model "<id>" not found for provider "<p>". Using custom model id.`
 * when a role names a model nobody registered — a supported usage, so the text
 * is a warning and never an error. It is pinned in exactly ONE place because
 * three layers assert on its bytes: the in-process backend test that produces it
 * (`test/unit/inprocess-supervisor.test.ts`), the rendered-line tests
 * (`test/unit/presets-regression.test.ts`) and the queued-admission notice test
 * (`test/unit/orchestrator-admission.test.ts`).
 */
export const MODEL_WARNING =
	'Model "cb/custom-thing" not found for provider "cb". Using custom model id.';
