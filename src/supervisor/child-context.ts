/**
 * In-process child identity channel (#197 / spawn-default-inprocess-v3 D5).
 *
 * An in-process child session shares the host's `process.env`: it sees the
 * *parent's* values, not an empty environment. So env cannot carry lineage
 * identity for it — `PI_SUBAGENT_CHILD` is empty at the root and the child
 * would be mistaken for another root. Identity therefore travels through an
 * AsyncLocalStorage scope instead.
 *
 * Why the store lives on `globalThis` under `Symbol.for(...)`:
 * `jiti` may re-evaluate this module with `moduleCache: false` (the extension
 * host does exactly that for a child's `--extension` load). A module-level
 * `const store = new AsyncLocalStorage()` would be a *different* instance on
 * every re-evaluation, so a value written by one module instance would be
 * invisible to the other — the store would look empty and identity would be
 * silently lost. `Symbol.for` is registry-backed and `globalThis` survives
 * module re-evaluation (measured: `childMod.store === shared` after jiti
 * reload). Do not replace this with a module-level constant.
 *
 * Security property: AsyncLocalStorage does NOT cross a `spawn()` boundary, so
 * a real subprocess (`bash npm test`, a nested `pi` CLI, …) can never inherit
 * this identity. The env channel lacked exactly that isolation (see the
 * healthy-ghost-nodes incident). Never re-introduce an env fallback here.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type { NestedPathEntry, SpawnMode } from "../shared/types.ts";

/** Lineage identity of one in-process child session. Never routed via process.env. */
export interface ChildLaunchContext {
	/** Legion node id of this child session (undefined for a root-level in-process child). */
	nodeId?: string;
	/** Parent legion node id. */
	parentNodeId?: string;
	/** Absolute path to legion.db. */
	dbPath?: string;
	/**
	 * The caller's nested path segments, so the child's orchestrator can continue it.
	 * Same shape as the RPC lineage path (`NestedPathEntry`), not bare strings.
	 */
	parentPath?: NestedPathEntry[];
	/** The role's `acceptance.role` (read-only / writer / …). */
	acceptanceRole?: string;
	/** Whether this child may spawn children of its own (maps to allowNestedSubagents). */
	allowNested: boolean;
	/** Utility hard leaf. */
	utility: boolean;
	/** Spawn backend of this child, so the child's doctor/diagnostics can self-report. */
	spawnMode: SpawnMode;
}

const STORE_KEY = Symbol.for("pi-legion.child-context.als");

/** Symbol-indexed view of globalThis so the store survives module re-evaluation. */
type StoreHolder = {
	[key: symbol]: AsyncLocalStorage<ChildLaunchContext> | undefined;
};

// SAFETY: `globalThis` is an object, so a `Symbol.for`-keyed property on it is
// readable; the only invariant TypeScript cannot check is that whoever wrote
// that slot first stored an AsyncLocalStorage under this exact symbol key. Both
// sides of that contract live in this file, so the slot type is authoritative.
const store = ((globalThis as unknown as StoreHolder)[STORE_KEY] ??=
	new AsyncLocalStorage<ChildLaunchContext>());

/** Run `fn` under `ctx`; everything awaited inside (tool execution included) inherits it. */
export function runInChildContext<T>(
	ctx: ChildLaunchContext,
	fn: () => Promise<T>,
): Promise<T> {
	return store.run(ctx, fn);
}

/** Identity of the current child session; undefined in the root process/session. */
export function currentChildContext(): ChildLaunchContext | undefined {
	return store.getStore();
}

/**
 * Run `fn` outside any child identity (REV2-7).
 *
 * Parent-side callbacks are reached synchronously from inside a child's await
 * chain — an `onEvent` listener is the case in point. Letting such a callback
 * observe the child's identity makes host code believe it *is* the child (and
 * inherit the child's spawn permissions). Anything leaving the child's own
 * execution path must step out of the scope first.
 */
export function runOutsideChildContext<T>(fn: () => T): T {
	return store.exit(fn);
}
