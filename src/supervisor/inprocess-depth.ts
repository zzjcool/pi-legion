/**
 * Process-local nesting depth for in-process children (#197).
 * Independent of RPC / PI_SUBAGENT_* depth env.
 *
 * The store lives on `globalThis` under `Symbol.for(...)` rather than in a
 * module-level `const store = new AsyncLocalStorage()`: jiti may re-evaluate
 * this module with `moduleCache: false`, and each re-evaluation would create a
 * fresh, empty store — the depth would silently reset to 0 in a re-loaded
 * module instance and the nesting limit would be bypassed. `globalThis` +
 * `Symbol.for` keeps one instance across module re-evaluation (measured:
 * `childMod.store === shared` after a jiti reload).
 *
 * Depth is also *not* inherited by real subprocesses: AsyncLocalStorage does
 * not cross `spawn()`. Only in-process children (same JS process) accumulate.
 */

import { AsyncLocalStorage } from "node:async_hooks";

const STORE_KEY = Symbol.for("pi-legion.inprocess-depth.als");

/** Symbol-indexed view of globalThis so the store survives module re-evaluation. */
type StoreHolder = {
	[key: symbol]: AsyncLocalStorage<number> | undefined;
};

// SAFETY: `globalThis` is an object, so a `Symbol.for`-keyed property on it is
// readable; the invariant TypeScript cannot check is that the slot holds a
// number-depth AsyncLocalStorage. Both writer and reader of that slot are in
// this file, so the declared slot type is authoritative.
const store = ((globalThis as unknown as StoreHolder)[STORE_KEY] ??=
	new AsyncLocalStorage<number>());

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
