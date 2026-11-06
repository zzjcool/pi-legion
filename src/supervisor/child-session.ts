/**
 * Emit `session_start` for an in-process child session (`child-mcp-v1` D3).
 *
 * Why this exists: `createAgentSession` builds the session but never calls
 * `AgentSession.bindExtensions`, and `bindExtensions` is the ONLY emitter of
 * `session_start` (rpc / print / interactive modes call it; the in-process child
 * factory did not). Every `session_start` consumer was therefore dead inside an
 * in-process child — most visibly the MCP extension, which loads its config and
 * starts every server connection inside that handler
 * (`dist/extensions/mcp/index.js:971`). Naming `builtin:mcp` in the extension
 * list is necessary but not sufficient; this call is the other half.
 *
 * The bindings are pinned to exactly two fields:
 *
 *   - `mode: "print"` — the runner's own default is `"print"`, and without a
 *     `uiContext` the runner hands extensions `noOpUIContext` (`hasUI === false`),
 *     so an extension that wants UI degrades on its own (MCP has that branch).
 *     Writing it explicitly makes the intent a fact rather than a default.
 *   - `onError` — MANDATORY. `bindExtensions({})` leaves `emitError` with no
 *     listener and extension failures are then swallowed silently
 *     (`runner.js:497-501`); print-mode at least logs. A child whose MCP server
 *     failed to start must never look identical to one with no MCP configured.
 *
 * Deliberately absent: `commandContextActions` / `shutdownHandler` /
 * `abortHandler`. There is no SessionRuntimeHost behind an in-process child, so
 * passing stubs would fake capabilities nobody implements; the runner's own
 * defaults already cover those slots (`runner.js:340-353`).
 *
 * Call it EXACTLY ONCE. There is no idempotence guard, and the MCP extension
 * overwrites its `AbortController` on every `session_start` without aborting the
 * previous one (`mcp/index.js:980`) — a second bind leaves dangling connections.
 *
 * `session_shutdown` is the matching OTHER half (`child-mcp-v1` r3 C1): it is
 * MCP's only disconnect path, `dispose()` does not emit it, and an in-process
 * child is retired by `dispose()` alone — so {@link attachChildSessionRelease}
 * emits it on the way out. A session that was never bound must not see it (the
 * event is only owed to extensions that were told the session started).
 */

/** What `AgentSession.extensionRunner` exposes that this module needs. */
export interface ChildExtensionRunner {
	hasHandlers(event: string): boolean;
	emit(event: { type: "session_shutdown"; reason: "quit" }): Promise<unknown>;
}

/** The slice of `AgentSession` this module needs. Structural, so tests need no SDK. */
export interface ChildSessionBinding {
	bindExtensions(bindings: {
		mode?: "print";
		onError?: (error: unknown) => void;
	}): Promise<void>;
	/** Public getter on `AgentSession` (`agent-session.d.ts:937`). */
	extensionRunner?: ChildExtensionRunner;
	/**
	 * Sync on `AgentSession`; the armed wrapper returns a promise (F3) so the retire
	 * paths can await the real teardown before freeing the slot.
	 */
	dispose?: () => void | Promise<void>;
}

/**
 * Render an extension error for the warn line.
 *
 * The SDK hands `onError` an `{ extensionPath, event, error, stack }` record, not
 * an `Error`; but a listener must never be the thing that throws, so anything
 * else is stringified instead of dereferenced.
 */
function describeExtensionError(error: unknown): string {
	if (typeof error !== "object" || error === null) return String(error);
	const record = error as { extensionPath?: unknown; event?: unknown; error?: unknown };
	const where = [record.extensionPath, record.event]
		.filter((part): part is string => typeof part === "string" && part.length > 0)
		.join(" ");
	const message = record.error === undefined ? String(error) : String(record.error);
	return where ? `${where}: ${message}` : message;
}

/**
 * Emit `session_start` exactly once for an in-process child session.
 *
 * `name` is optional and only labels the warn line (the contract's D3 message is
 * `[pi-legion] in-process child <name> extension error: …`); omitting it keeps the
 * frozen one-argument call shape intact.
 *
 * Errors are NOT caught here. A throw from a `session_start` handler is reported
 * through `onError` by the runner itself, and a failure of `bindExtensions`
 * (resource discovery) must fail the spawn loudly instead of leaving a session
 * whose extensions were never told the session exists.
 */
export async function bindChildSessionExtensions(
	session: ChildSessionBinding,
	name?: string,
): Promise<void> {
	const label = name ? ` ${name}` : "";
	// Recorded BEFORE the call (r4 F2): if `bindExtensions` throws, the factory
	// disposes the session — and that dispose must still be allowed to emit
	// `session_shutdown`, because `session_start` may already have gone out to
	// extensions (MCP included). The reverse (record only on success) left a
	// half-started session with live MCP connections and no owner.
	boundSessions.add(session);
	await session.bindExtensions({
		mode: "print",
		onError: (error) => {
			console.warn(`[pi-legion] in-process child${label} extension error: ${describeExtensionError(error)}`);
		},
	});
}

/**
 * Sessions whose extensions were bound, i.e. that are owed a `session_shutdown`.
 *
 * Module-level because the cleanup happens where the session dies, not where it
 * was bound. Weak, so a retired session is not kept alive by this bookkeeping.
 */
const boundSessions = new WeakSet<object>();

/** Bound the shutdown emit so a wedged handler cannot keep a dead session alive. */
const SHUTDOWN_EMIT_TIMEOUT_MS = 1000;

/**
 * Emit `session_shutdown` once for a bound in-process child session (r3 C1).
 *
 * Why this is mandatory rather than nice-to-have: `pi.on("session_shutdown", …)`
 * is the ONLY path that discards MCP connections (`mcp/index.js:1114-1119` —
 * `session.abort()` + `connection.close()`), `AgentSession.dispose()` does not
 * emit it, and an in-process child is retired by `dispose()` alone. Without this,
 * every retired child's MCP server processes outlive it until the root exits.
 *
 * The body is the SDK's own `emitSessionShutdownEvent` (`runner.js:80-86`):
 * `hasHandlers` first, then `emit`. Both are PUBLIC members of
 * `session.extensionRunner` — deliberately no `dist/...` deep import, which the
 * package's `exports` map does not allow. `reason` is only ever `"quit"`: an
 * in-process child has no reload / new / resume / fork.
 *
 * Never rejects and never hangs: a failed or wedged handler is reported and the
 * caller's `dispose()` still runs. No-ops for a session that was never bound
 * (`PI_LEGION_CHILD_MCP=0` means no bind, so inherited host extensions must not
 * receive a shutdown they never got a start for).
 *
 * `timeoutMs` is an injectable seam for the D7.5 case that pins the bound (r4 F5).
 */
export async function releaseChildSessionExtensions(
	session: ChildSessionBinding,
	timeoutMs: number = SHUTDOWN_EMIT_TIMEOUT_MS,
): Promise<void> {
	// `delete` is the once-guard: the first caller takes the entry, later ones see
	// false and stay silent (two `dispose()` calls, two retire paths, …).
	if (!boundSessions.delete(session)) return;
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const runner = session.extensionRunner;
		if (!runner?.hasHandlers("session_shutdown")) return;
		await Promise.race([
			runner.emit({ type: "session_shutdown", reason: "quit" }),
			new Promise<void>((resolve) => {
				timer = setTimeout(resolve, timeoutMs);
				timer.unref?.();
			}),
		]);
	} catch (error) {
		// Reported, not rethrown: the session and its MCP connections must still be
		// released, so the caller's `dispose()` runs on the rejection path too.
		console.warn(`[pi-legion] in-process child session_shutdown failed: ${describeExtensionError(error)}`);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

/**
 * Route `session.dispose()` through {@link releaseChildSessionExtensions} (r3 C1).
 *
 * Idempotent (a second `dispose()` is a no-op), emits BEFORE disposing — the
 * shutdown handlers' synchronous prefix (MCP aborts its controller and starts
 * closing every connection) must run while the extension ctx is still valid,
 * and `dispose()` invalidates it — and disposes even when the emit fails.
 *
 * Returns a promise (r4 F3): the wrapped call finishes when the real teardown has
 * run, so `rollbackSpawn` / `retireChild` can await it before freeing the slot.
 * When the 1000ms bound trips, the shutdown has been INITIATED but may not have
 * completed — that is a delayed exit, not a leak, and it must not hold the slot.
 *
 * Installed unconditionally by `defaultSessionFactory`; whether an event is owed
 * is decided by {@link releaseChildSessionExtensions}, not by the caller.
 *
 * `timeoutMs` is forwarded to the release so D7.5 can pin the bound without a
 * one-second test (r4 F5); production never passes it.
 *
 * Exported because `defaultSessionFactory` is not (contract §6 gap 1): without
 * this seam the five D7.5 assertions would have nothing to call.
 */
export function attachChildSessionRelease(
	session: ChildSessionBinding,
	timeoutMs: number = SHUTDOWN_EMIT_TIMEOUT_MS,
): void {
	const rawDispose = session.dispose?.bind(session);
	let disposing = false;
	session.dispose = async () => {
		if (disposing) return;
		disposing = true;
		await releaseChildSessionExtensions(session, timeoutMs);
		try {
			await rawDispose?.();
		} catch (error) {
			// `dispose()` is called fire-and-forget on some paths, so a throw here
			// would surface as an unhandled rejection rather than a failed retire.
			// Report it and let the retire finish.
			console.warn(`[pi-legion] in-process child dispose failed: ${describeExtensionError(error)}`);
		}
	};
}
