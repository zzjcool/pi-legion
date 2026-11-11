/**
 * Hints appended to child spawn failures, and a ring buffer of recent failures
 * so `/legion doctor` / `subagent action=diagnose` can show what just broke.
 */

import type { SpawnMode } from "../shared/types.ts";
import {
	hostExtensionDiscoveryState,
	type HostExtensionDiscoveryStatus,
} from "../runs/extension-inheritance.ts";

export interface SpawnFailureRecord {
	ts: number;
	name: string;
	message: string;
	stderr?: string;
	hadNoExtensions?: boolean;
	/** When known, doctor / hints can avoid RPC-only advice for inprocess (#212). */
	spawnMode?: SpawnMode;
}

const MAX_FAILURES = 8;
const recentFailures: SpawnFailureRecord[] = [];

export function recordSpawnFailure(entry: Omit<SpawnFailureRecord, "ts"> & { ts?: number }): void {
	recentFailures.unshift({ ts: entry.ts ?? Date.now(), ...entry });
	if (recentFailures.length > MAX_FAILURES) recentFailures.length = MAX_FAILURES;
}

export function recentSpawnFailures(): readonly SpawnFailureRecord[] {
	return recentFailures;
}

/** Test helper. */
export function clearSpawnFailures(): void {
	recentFailures.length = 0;
}

const MODEL_NOT_FOUND =
	/Model\s+"[^"]+"\s+not found|No models available|Use --list-models|Unknown provider|inprocess model resolve failed/i;

/**
 * The in-process backend's own wording for a model it could not resolve
 * (`defaultSessionFactory` → `SubagentError(START_FAILED)`).
 *
 * Not an idempotence gate any more (R7): a message can carry this marker AND a
 * credential root cause, and the root cause must win. `hasHintSection` below is
 * the once-only gate; this constant only selects the model-hint branch.
 */
const INPROCESS_RESOLVE_FAILED = /inprocess model resolve failed/i;

/**
 * Root-cause wording for "the provider has no usable credential" (R7).
 *
 * Case-insensitive, matching the SDK's real strings:
 *  - `No API key found for "<provider>"` (`model-registry.ts`)
 *  - `Authentication failed for "<provider>". …` (`agent-session.ts`)
 *  - `No matching provider is authenticated.` (`model-resolver.ts`, ambiguous
 *    provider set — the one that used to arrive as
 *    `inprocess model resolve failed …` and collect model advice)
 *
 * Deliberately NOT folded into `MODEL_NOT_FOUND`: a credential problem is not a
 * missing model, and widening that regex would also change `looksLikeMissingModel`
 * and the rpc enrich path (R7 D-R7.8).
 */
const CREDENTIAL_FAILURE =
	/No API key found for|Authentication failed for|No matching provider is authenticated/i;

/**
 * A hint section already exists: do not stack a second one (R7 D-R7.7).
 *
 * Both shapes are what this codebase appends — the `Hint: ` block every hint
 * follows, and the `--- Legion auto-doctor ---` section the rpc path writes. A
 * failure that already carries either went through this gate once.
 *
 * `(^|\n\n)` rather than plain `\n\n`: a hint that IS the whole message (the SDK
 * rejection is often wrapped as the message alone, so the first line is already
 * `Hint: `) has no leading blank line, and the old check missed it — appending a
 * second `Fix:` block to the only sentence the operator gets.
 */
function hasHintSection(message: string): boolean {
	return /(^|\n\n)Hint: /.test(message) || message.includes("--- Legion auto-doctor");
}

/**
 * The credential hint (R7 D-R7.5) — points ONLY at repairs that create a
 * credential.
 *
 * The model hint below teaches `models.json` / `PI_LEGION_CHILD_EXTENSIONS`,
 * which is exactly wrong here: no declaration can make an unauthenticated
 * provider serve a request. The wording also says out loud that this is not a
 * model-name problem, because that is the misdiagnosis it replaces.
 */
export const INPROCESS_CREDENTIAL_HINT =
	"Hint: this is an authentication failure, not a model-name or declaration problem — no API " +
	"key is available for the provider this child must call (children use the host's credentials, " +
	"and that provider is not logged in).\n" +
	"Fix: run `/login <provider>` for that provider (or add its API key to the provider's own " +
	"configuration), then retry. `/legion doctor` or `subagent action=diagnose` shows the child's " +
	"provider state.";

export function looksLikeMissingModel(stderr: string | undefined): boolean {
	return Boolean(stderr && MODEL_NOT_FOUND.test(stderr));
}

/** Inprocess children have no argv; point at models.json / child extensions (#212, #317). */
export const INPROCESS_MODEL_HINT =
	"Hint: default spawnMode is `inprocess` — children resolve models via ModelRuntime, " +
	"not a `--no-extensions` argv.\n" +
	// #317: `inheritExtensions: true` / `PI_LEGION_CHILD_INHERIT_EXTENSIONS=1` used to be
	// printed here. Both are dead advice now: `true` is the default policy (#280), and
	// when host discovery fails the switch still yields 0 extensions. Only the two levers
	// that actually change the child's extension set are named.
	"Fix: declare the provider statically in `models.json` (agent dir / project), or pass the " +
	"provider extension explicitly with `PI_LEGION_CHILD_EXTENSIONS=<path>` (host extensions " +
	"are inherited by default, but that inherits nothing when host discovery fails). " +
	"Run `/legion doctor` or `subagent action=diagnose`.";

/**
 * The "inheritance produced nothing" note (#317).
 *
 * Only meaningful for a non-`ok` discovery state: `ok` with 0 entries means the
 * host really ships no package extensions, which is a different (and harmless)
 * diagnosis. Pure text — the state is read by the caller.
 */
function discoveryNote(status: HostExtensionDiscoveryStatus): string | undefined {
	if (status === "ok") return undefined;
	const what = status === "failed" ? "failed" : "never probed";
	return `Note: inheritance is enabled but host discovery is ${what} — the child got 0 host extensions.`;
}

/**
 * When a child dies because its model/provider is invisible, point at the
 * right escape hatch for the spawn backend (`rpc` argv vs `inprocess`).
 *
 * Pure with respect to IO: the optional `discoveryStatus` keeps a call
 * deterministic; when it is omitted the in-memory discovery holder is read (no
 * probe, no subprocess), which is what production spawn paths want without every
 * caller having to pass it.
 *
 * The discovery note is appended to EVERY branch, so no branch may still offer
 * `inheritExtensions` / `PI_LEGION_CHILD_INHERIT_EXTENSIONS=1` as a fix: that
 * would contradict the note directly below it ("inheritance is enabled but host
 * discovery is failed — the child got 0 host extensions").
 */
export function spawnFailureHint(input: {
	stderr?: string;
	args?: readonly string[];
	/** Prefer this when known; inprocess never gets argv advice (#212, #317). */
	spawnMode?: SpawnMode;
	/** Host discovery state for the "0 inherited extensions" note (#317). */
	discoveryStatus?: HostExtensionDiscoveryStatus;
}): string | undefined {
	if (!looksLikeMissingModel(input.stderr)) return undefined;
	const note = discoveryNote(input.discoveryStatus ?? hostExtensionDiscoveryState().status);
	const withNote = (hint: string): string => (note ? `${hint}\n${note}` : hint);
	if (input.spawnMode === "inprocess") {
		return withNote(INPROCESS_MODEL_HINT);
	}
	const noExt = input.args?.includes("--no-extensions") ?? true;
	if (!noExt) {
		return withNote(
			"Hint: the child could not resolve that model. Run `/legion doctor` " +
			"(or `subagent action=diagnose`) and compare host vs child model lists.",
		);
	}
	return withNote(
		"Hint: children start with `--no-extensions`, so host packages that register " +
		"providers (e.g. `pi-any-endpoint`) are not loaded. The model works in the " +
		"parent but is unknown to the child.\n" +
		// #317 review: the dead-switch clause (`inheritExtensions: true` /
		// `PI_LEGION_CHILD_INHERIT_EXTENSIONS=1`) is gone. The discovery note this
		// branch now carries says inheritance is already on and still yields 0 host
		// extensions, so recommending the switch here contradicted the next line.
		"Fix: set `PI_LEGION_CHILD_EXTENSIONS` to the provider extension path(s), " +
		"or add them under the role's `extensions:` frontmatter. " +
		"Run `/legion doctor` or `subagent action=diagnose` for paths.",
	);
}

/**
 * The in-process counterpart of `enrichFailureWithAutoDoctor` (R5 D-H1), now
 * routed by ROOT CAUSE (R7 D-R7.6).
 *
 * Three shapes reach this function:
 *
 *  1. `No API key found for "x"` — the in-process first-turn rejection
 *     (`inprocess-supervisor.ts` `START_FAILED`). It used to leave with NO hint
 *     at all: `spawnFailureHint` only knows the model-miss wording.
 *  2. `inprocess model resolve failed for '<id>': No matching provider is
 *     authenticated.` — an AUTHENTICATION failure that also carries the model
 *     marker. It used to collect `INPROCESS_MODEL_HINT`, i.e. advice to edit
 *     `models.json` when the repair is `/login`. The credential vocabulary is
 *     therefore checked FIRST and wins even when the marker is present.
 *  3. a genuine model miss (`Model "x" not found`, `Unknown provider`, …) —
 *     unchanged: the existing in-process model hint, byte for byte.
 *
 * Anything else is returned byte for byte, and a message that already carries a
 * hint section is never appended to twice.
 *
 * Deliberately NOT routed through `enrichFailureWithAutoDoctor`: that one writes
 * the process-wide `recentFailures` ring (8 entries, shared across runs), and an
 * in-process record in it (no argv, `hadNoExtensions: false`) is then offered as
 * the doctor snippet for a LATER, unrelated rpc failure.
 *
 * Pure apart from the in-memory discovery holder `spawnFailureHint` reads: no
 * ring write, no IO.
 */
export function appendInprocessModelHint(message: string): string {
	// D-R7.7: one hint section per failure, whichever call site asked. Appending
	// twice is what made an already-diagnosed message carry two `Fix:` blocks.
	if (hasHintSection(message)) return message;
	// D-R7.6: the root cause wins over the marker. A credential problem that
	// happens to travel inside `inprocess model resolve failed …` is still a
	// credential problem, and the model hint would send the operator to edit a
	// file that cannot supply a key.
	if (CREDENTIAL_FAILURE.test(message)) return `${message}\n\n${INPROCESS_CREDENTIAL_HINT}`;
	if (!INPROCESS_RESOLVE_FAILED.test(message)) return message;
	// `session.results` / the utility segments are joined with `\n`, so the shape
	// is `${message}\n\n${hint}` exactly as `enrichFailureWithAutoDoctor` does it.
	const hint = spawnFailureHint({ stderr: message, spawnMode: "inprocess" });
	return hint ? `${message}\n\n${hint}` : message;
}

/** Short hint only. Spawn paths use `enrichFailureWithAutoDoctor` for auto snippets. */
export function withSpawnFailureHint(message: string, input: {
	stderr?: string;
	args?: readonly string[];
	name?: string;
	spawnMode?: SpawnMode;
	/** Host discovery state for the "0 inherited extensions" note (#317). */
	discoveryStatus?: HostExtensionDiscoveryStatus;
}): string {
	const hint = spawnFailureHint(input);
	recordSpawnFailure({
		name: input.name ?? "?",
		message,
		stderr: input.stderr,
		hadNoExtensions:
			input.spawnMode === "inprocess" ? false : input.args?.includes("--no-extensions"),
		spawnMode: input.spawnMode,
	});
	return hint ? `${message}\n\n${hint}` : message;
}
