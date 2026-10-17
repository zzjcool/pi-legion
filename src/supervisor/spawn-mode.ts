/**
 * Spawn-mode resolution helpers for #197 (rpc | inprocess).
 */

import type { AgentConfig, SpawnMode } from "../shared/types.ts";
import { SPAWN_MODES } from "../shared/types.ts";

/** Default backend when `spawnMode` is omitted. */
export const DEFAULT_SPAWN_MODE: SpawnMode = "rpc";

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
