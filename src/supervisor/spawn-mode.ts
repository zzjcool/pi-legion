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

/**
 * How long `InProcessSupervisor.spawnChild` waits for the child to *accept* the
 * first prompt before returning anyway (#227 D1).
 *
 * The acceptance signal itself is the child transcript gaining its first user
 * line (`F7`: the SDK appends the user message before it runs the agent), so
 * this bound only covers a child that never writes one — a stuck session factory
 * or a provider that swallows the prompt. Hitting it is **not** an error: the
 * spawn still owns a live session and returns a handle, and the caller is told
 * once through `onSpawnDelayed`.
 */
export const DEFAULT_INPROCESS_SPAWN_START_TIMEOUT_MS = 15_000;

/**
 * Poll cadence for the spawn-acceptance check (#227 D1).
 *
 * CONTRACT ERRATUM (#227, `vexillatio-nonblocking-launch-v1.md` §D1): that line
 * says the constant already lives in `src/shared/types.ts`; it never did. The
 * only pre-existing `POLL_INTERVAL_MS` is module-private in
 * `src/runs/orchestrator.ts` (a Worker B file this change must not touch), so
 * the same 500 ms cadence is exported from here instead of inventing a second
 * value. Parent session to record this erratum in the contract document.
 */
export const POLL_INTERVAL_MS = 500;

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
