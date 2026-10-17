/**
 * Process-local nesting depth for in-process children (#197).
 * Independent of RPC / PI_SUBAGENT_* depth env.
 */

import { AsyncLocalStorage } from "node:async_hooks";

const store = new AsyncLocalStorage<number>();

/** Current in-process nesting depth (0 at the host session). */
export function inProcessDepth(): number {
	return store.getStore() ?? 0;
}

/** Run `fn` at depth = current + 1. */
export function runAtInProcessChildDepth<T>(fn: () => T): T {
	return store.run(inProcessDepth() + 1, fn);
}

/** Run async `fn` at depth = current + 1. */
export async function runAtInProcessChildDepthAsync<T>(
	fn: () => Promise<T>,
): Promise<T> {
	return store.run(inProcessDepth() + 1, fn);
}

/** @internal */
export function resetInProcessDepthForTests(): void {
	// AsyncLocalStorage has no global clear; tests should avoid leaking across awaits.
}
