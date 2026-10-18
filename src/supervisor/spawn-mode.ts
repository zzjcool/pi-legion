/**
 * Spawn-mode resolution helpers for #197 (rpc | inprocess).
 */

import type { AgentConfig, SpawnMode } from "../shared/types.ts";
import { SPAWN_MODES } from "../shared/types.ts";

/**
 * Default backend when `spawnMode` is omitted.
 *
 * `inprocess` is only the *intent* here: `Orchestrator.launch` arbitrates an
 * omitted mode down to `rpc` when the launch actually needs worktree
 * isolation or the role is not `kind: pi` (see the arbitration comment in
 * `src/runs/orchestrator.ts`). This resolver stays a pure config read and
 * must never inspect `worktree`.
 */
export const DEFAULT_SPAWN_MODE: SpawnMode = "inprocess";

/** Safe default for `inprocess.maxActive` when the inprocess block is set without it. */
export const DEFAULT_INPROCESS_MAX_ACTIVE = 8;

export function resolveSpawnMode(
	agent: Pick<AgentConfig, "spawnMode"> | undefined,
): SpawnMode {
	const mode = agent?.spawnMode;
	if (mode === undefined) return DEFAULT_SPAWN_MODE;
	if ((SPAWN_MODES as readonly string[]).includes(mode)) return mode;
	return DEFAULT_SPAWN_MODE;
}

export function isInProcessSpawn(
	agent: Pick<AgentConfig, "spawnMode"> | undefined,
): boolean {
	return resolveSpawnMode(agent) === "inprocess";
}
