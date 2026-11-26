import {
	childDiagnosticsLogFile,
	createChildDiagnosticSink,
	type ChildDiagnosticSink,
} from "./child-diagnostics.ts";

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
	/**
	 * Public getter on `AgentSession` (`agent-session.d.ts:488` in 1.6.0, `:476` in
	 * 1.5.0 — `package.json` allows both); `undefined` for an in-memory session
	 * manager. Only used to derive `<runDir>/diagnostics.log` (#468) — the
	 * transcript's directory IS the run directory, because the orchestrator
	 * pre-creates `<runDir>/<name>.jsonl`.
	 */
	sessionFile?: string | undefined;
}

/**
 * Sinks already built for a session, so bind / release / dispose share ONE record.
 *
 * Keyed by session on purpose: the diagnostic is the session's, and the three
 * call sites (`onError`, the shutdown emit, the armed dispose) are the same run.
 * Weak, so a retired session is not kept alive by its own diagnostics.
 */
const sessionSinks = new WeakMap<object, ChildDiagnosticSink>();

/**
 * The sink for a session: the one handed in, the one already registered for it,
 * or a fresh one derived from the session's transcript path.
 *
 * Deriving rather than requiring a sink keeps every existing call site (and every
 * test) valid: the only thing a caller must supply for disk records is the child
 * name, and `<runDir>/diagnostics.log` follows from `sessionFile`.
 */
function sinkFor(
	session: ChildSessionBinding,
	name?: string,
	provided?: ChildDiagnosticSink,
): ChildDiagnosticSink {
	const registered = sessionSinks.get(session);
	if (registered !== undefined) {
		if (provided !== undefined && provided !== registered) {
			// A caller handing in a second sink must win, or its records would vanish;
			// the old one is flushed first so its real failures are not lost.
			registered.flush();
			sessionSinks.set(session, provided);
			return provided;
		}
		return registered;
	}
	const derived = childDiagnosticsLogFile(session.sessionFile);
	const sink =
		provided ??
		createChildDiagnosticSink({
			...(name ? { child: name } : {}),
			...(derived === undefined ? {} : { logFile: derived }),
		});
	sessionSinks.set(session, sink);
	return sink;
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
 * The host's skipped-`turn_end` record, and why it is a SKIP rather than a failure (#415).
 *
 * `_dispatchTurnEndBoundary` (`pi-coding-agent/dist/core/agent-session.js`) resolves the
 * turn's assistant message to a persisted session entry first, and when there is none it
 * emits an `onError` record attributed to a pseudo-extension literally named `<boundary>`.
 * That situation is expected, not exceptional: a turn ended after `dispose()` aborted it,
 * or after compaction collapsed the branch, or after a fork left the message behind — the
 * message simply has no entry. The host then returns without running ANY `turn_end`
 * handler, so no extension misbehaved; calling it an "extension error" aims every reader
 * at the wrong owner.
 *
 * Legion cannot close this the #383 way (unregister our own `turn_end`): `hasHandlers`
 * covers the whole extension set, and a sibling package (pi-async) registers that handler
 * to flush its steer queue. So the degradation lives here, at the sink that prints it.
 */
const BOUNDARY_PSEUDO_EXTENSION = "<boundary>";
const TURN_END_MISSING_ENTRY = "turn_end could not resolve the persisted assistant entry ID";

/**
 * Recognize the host's skipped-`turn_end` record; `undefined` for everything else.
 *
 * Exact on all three fields on purpose. A broader match (message substring, or path
 * alone) would swallow real extension failures that merely mention `turn_end`, and a
 * looser one would drift from the host's wording without a test going red.
 */
function skippedTurnEndBoundary(error: unknown): string | undefined {
	if (typeof error !== "object" || error === null) return undefined;
	const record = error as { extensionPath?: unknown; event?: unknown; error?: unknown };
	if (record.extensionPath !== BOUNDARY_PSEUDO_EXTENSION) return undefined;
	if (record.event !== "turn_end") return undefined;
	if (record.error !== TURN_END_MISSING_ENTRY) return undefined;
	return TURN_END_MISSING_ENTRY;
}

/**
 * Emit `session_start` exactly once for an in-process child session.
 *
 * `name` is optional and only labels the diagnostic records (the contract's D3
 * message is `[pi-legion] in-process child <name> extension error: …`); omitting it
 * keeps the frozen call shape intact. The one exception is the host's skipped
 * `turn_end` boundary, which is labelled `… turn_end hook skipped: …` instead (#415).
 *
 * `sink` is where every diagnostic goes (#468). Omitted, one is derived from the
 * session itself (`<runDir>/diagnostics.log`, `<runDir>` = the transcript's
 * directory), so the call site does not have to thread a path through.
 *
 * Errors are NOT caught here. A throw from a `session_start` handler is reported
 * through `onError` by the runner itself, and a failure of `bindExtensions`
 * (resource discovery) must fail the spawn loudly instead of leaving a session
 * whose extensions were never told the session exists.
 */
export async function bindChildSessionExtensions(
	session: ChildSessionBinding,
	name?: string,
	sink?: ChildDiagnosticSink,
): Promise<void> {
	// #468: the child's own diagnostics go to a CHILD-scoped sink, never to the
	// host's console. In-process means shared stderr, and a `console.warn` here is
	// drawn right above the user's input box (see `child-diagnostics.ts`).
	const diagnostics = sinkFor(session, name, sink);
	// Recorded BEFORE the call (r4 F2): if `bindExtensions` throws, the factory
	// disposes the session — and that dispose must still be allowed to emit
	// `session_shutdown`, because `session_start` may already have gone out to
	// extensions (MCP included). The reverse (record only on success) left a
	// half-started session with live MCP connections and no owner.
	boundSessions.add(session);
	await session.bindExtensions({
		mode: "print",
		onError: (error) => {
			// #415: the host SKIPPED the hook (it ran no `turn_end` handler). Report the skip,
			// never silence it and never throw — but do not point at an extension that is fine.
			// #468: `real: false` — this is expected, so it is disk-only and never host-visible.
			const skipped = skippedTurnEndBoundary(error);
			if (skipped !== undefined) {
				diagnostics.record({
					event: "turn_end.skipped",
					reason:
						`${skipped} ` +
						"(this turn's assistant message has no persisted entry, so the host ran no turn_end handler)",
				});
				return;
			}
			// A real extension failure: recorded as `real`, so it is still the user's
			// business — but through ONE summary line at run end, not one line per event.
			diagnostics.record({
				event: "extension.error",
				reason: describeExtensionError(error),
				real: true,
			});
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
				// NOT `unref()`ed on purpose. This timer is the only thing that can settle
				// a wedged emit, so it must keep the loop alive: unref'd, a process whose
				// remaining work is just this promise exits without ever running
				// `dispose()` (measured in CI as "Promise resolution is still pending but
				// the event loop has already resolved"). Clearing it in `finally` bounds
				// the cost to one second of loop keep-alive after a hung handler.
				timer = setTimeout(resolve, timeoutMs);
			}),
		]);
	} catch (error) {
		// Reported, not rethrown: the session and its MCP connections must still be
		// released, so the caller's `dispose()` runs on the rejection path too.
		// #468: a handler that threw IS a real extension failure — recorded as `real`,
		// which is what produces the one run-end summary line on the host.
		sinkFor(session).record({
			event: "session_shutdown.failed",
			reason: describeExtensionError(error),
			real: true,
		});
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
 * one-second test (r4 F5); production never passes it. `sink` (#468) comes before
 * it because every production call passes a sink and none passes a timeout.
 *
 * Exported because `defaultSessionFactory` is not (contract §6 gap 1): without
 * this seam the five D7.5 assertions would have nothing to call.
 */
export function attachChildSessionRelease(
	session: ChildSessionBinding,
	sink?: ChildDiagnosticSink,
	timeoutMs: number = SHUTDOWN_EMIT_TIMEOUT_MS,
): void {
	// Resolved LAZILY, at each use: the wrapper is armed before the extensions are
	// bound, so an eagerly derived sink would be the unnamed one and every record of
	// a named child would lose its name. By dispose time the bind (if any) has
	// registered the session's sink, and that one wins.
	const diagnostics = () => sinkFor(session, undefined, sink);
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
			diagnostics().record({
				event: "dispose.failed",
				reason: describeExtensionError(error),
				real: true,
			});
		} finally {
			// #468: the child's run ends here — this is the ONE place a real extension
			// failure becomes visible to the host, as a single summary line (and only
			// when one actually happened). `flush()` is idempotent, so a session with
			// several dispose paths still reports once.
			diagnostics().flush();
		}
	};
}
