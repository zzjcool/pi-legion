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

/**
 * The SDK's wording when a provider simply has no credential (#R7).
 *
 * `model-registry.ts` answers `No API key found for "<provider>"` and the
 * agent-session prompt rejection answers `Authentication failed for "<provider>"`;
 * both reach the caller as `START_FAILED`. This is NOT a model miss: no
 * `models.json` entry and no child extension can create a credential.
 *
 * The wording is the SDK's own, quoted, not a paraphrase: the old fixture said
 * `No API key found for provider "workbuddy"`, a string no SDK file produces, so
 * tightening the vocabulary later (a quoted-provider match) would have flipped
 * this test red for the wrong reason — or, worse, kept it green while the real
 * message stopped matching.
 */
export const INPROCESS_CREDENTIAL_FAILURE = 'No API key found for "workbuddy"';

/** The fix a credential failure must name — `/login <provider>`. */
export const CREDENTIAL_FIX_ADVICE = /\/login/;

/**
 * The fix a MODEL miss must name, and a credential failure must not: pointing an
 * unauthenticated provider at `models.json` sends the operator to edit a file
 * that cannot supply the missing key.
 */
export const MODEL_MISS_ADVICE = /models\.json/;
