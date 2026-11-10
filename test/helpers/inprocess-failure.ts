/**
 * The in-process backend's own wording for a model it could not resolve, and the
 * pieces of advice it must attract.
 *
 * `defaultSessionFactory` raises exactly this text as `SubagentError(START_FAILED)`,
 * and `appendInprocessModelHint` appends the in-process `Hint:`/`Fix:` section to
 * it. Two files assert on the same bytes for different reasons — `teams.test.ts`
 * proves the hint reaches the caller through the REAL tool, `spawn-hints.test.ts`
 * proves the append is a pure, once-only gate — so the literals live in one place
 * instead of drifting apart.
 */
export const INPROCESS_MODEL_FAILURE =
	"inprocess model resolve failed for 'ghost/model': Model \"ghost/model\" not found. Use --list-models";

/** The identifying half of that message, for `✗ <agent>: …` failure lines. */
export const INPROCESS_MODEL_FAILURE_LINE =
	/inprocess model resolve failed for 'ghost\/model'/;

/**
 * The in-process `Fix:` sentence. An rpc-shaped failure must NEVER grow it
 * (argv advice is wrong for a backend with no argv), which is why it is named
 * rather than retyped where both directions are asserted.
 */
export const INPROCESS_FIX_ADVICE =
	/Fix: declare the provider statically in `models\.json`/;
