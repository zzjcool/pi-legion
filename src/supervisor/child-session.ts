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
 */

/** The slice of `AgentSession` this module needs. Structural, so tests need no SDK. */
export interface ChildSessionBinding {
	bindExtensions(bindings: {
		mode?: "print";
		onError?: (error: unknown) => void;
	}): Promise<void>;
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
	await session.bindExtensions({
		mode: "print",
		onError: (error) => {
			console.warn(`[pi-legion] in-process child${label} extension error: ${describeExtensionError(error)}`);
		},
	});
}
