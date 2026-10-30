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
		"Fix: set `PI_LEGION_CHILD_EXTENSIONS` to the provider extension path(s), " +
		"add them under the role's `extensions:` frontmatter, or set " +
		"`inheritExtensions: true` / `PI_LEGION_CHILD_INHERIT_EXTENSIONS=1` " +
		"(costs more memory). Run `/legion doctor` or `subagent action=diagnose` for paths.",
	);
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
