/**
 * Hints appended to child spawn failures, and a ring buffer of recent failures
 * so `/legion doctor` / `subagent action=diagnose` can show what just broke.
 */

import type { SpawnMode } from "../shared/types.ts";

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

/** Inprocess children have no argv; point at models.json / role extensions (#212). */
export const INPROCESS_MODEL_HINT =
	"Hint: default spawnMode is `inprocess` — children resolve models via ModelRuntime, " +
	"not a `--no-extensions` argv.\n" +
	"Fix: declare the provider statically in `models.json` (agent dir / project), " +
	"list the extension under the role's `extensions:` frontmatter, or set " +
	"`inheritExtensions: true` / `PI_LEGION_CHILD_INHERIT_EXTENSIONS=1`. " +
	"Run `/legion doctor` or `subagent action=diagnose`.";

/**
 * When a child dies because its model/provider is invisible, point at the
 * right escape hatch for the spawn backend (`rpc` argv vs `inprocess`).
 */
export function spawnFailureHint(input: {
	stderr?: string;
	args?: readonly string[];
	/** Prefer this when known; inprocess never gets argv / CHILD_EXTENSIONS advice (#212). */
	spawnMode?: SpawnMode;
}): string | undefined {
	if (!looksLikeMissingModel(input.stderr)) return undefined;
	if (input.spawnMode === "inprocess") {
		return INPROCESS_MODEL_HINT;
	}
	const noExt = input.args?.includes("--no-extensions") ?? true;
	if (!noExt) {
		return (
			"Hint: the child could not resolve that model. Run `/legion doctor` " +
			"(or `subagent action=diagnose`) and compare host vs child model lists."
		);
	}
	return (
		"Hint: children start with `--no-extensions`, so host packages that register " +
		"providers (e.g. `pi-any-endpoint`) are not loaded. The model works in the " +
		"parent but is unknown to the child.\n" +
		"Fix: set `PI_LEGION_CHILD_EXTENSIONS` to the provider extension path(s), " +
		"add them under the role's `extensions:` frontmatter, or set " +
		"`inheritExtensions: true` / `PI_LEGION_CHILD_INHERIT_EXTENSIONS=1` " +
		"(costs more memory). Run `/legion doctor` or `subagent action=diagnose` for paths."
	);
}

/** Short hint only. Spawn paths use `enrichFailureWithAutoDoctor` for auto snippets. */
export function withSpawnFailureHint(message: string, input: {
	stderr?: string;
	args?: readonly string[];
	name?: string;
	spawnMode?: SpawnMode;
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
