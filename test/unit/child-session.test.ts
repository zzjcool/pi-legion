/**
 * D7.3 / D7.4 — the one `session_start` a child session ever gets (`child-mcp-v1` D3).
 *
 * Why a unit test and not an end-to-end one: `defaultSessionFactory` is not
 * exported, so the CALL itself is unobservable from outside (§6 gap 1). What is
 * testable is the function it calls, and the two mutations that would silently
 * break MCP are both visible in the bindings:
 *
 *   - dropping `onError` → extension failures are swallowed with no warning
 *   - `mode: "tui"` → an extension thinks a real UI is attached
 *
 * D7.4's mutation run (deleting `onError`, switching `mode` to `"tui"`, and
 * deleting the `builtin:mcp` injection in `collectChildExtensions`) was executed
 * against these assertions and the D7.2 gate; the recorded output is in the MR
 * report.
 *
 * r2 adds the other half: whether the factory binds at all must be the SAME
 * judgment as whether the MCP path is injected. `bindExtensions` shows
 * `session_start` to every loaded extension (inherited third-party ones
 * included) and an in-process child has no `session_shutdown` to reclaim them,
 * so a second judgment for the bind would silently reopen that door.
 *
 * r3 C1 adds D7.5: the `session_shutdown` side. MCP's ONLY disconnect path is
 * that event, `dispose()` does not emit it, and an in-process child is retired by
 * `dispose()` alone — so a retired child would keep its MCP servers until the
 * root exits. These five cases pin the emit (once, `reason: "quit"`, before the
 * real dispose, even when the handler throws, and never for an unbound session).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	BUILTIN_MCP,
	BUILTIN_TOOL_SEARCH,
	childEnablesMcp,
	collectChildExtensions,
} from "../../src/runs/args.ts";
import { childEnablesMcp as policyChildEnablesMcp } from "../../src/runs/extension-inheritance.ts";
import { createChildDiagnosticSink } from "../../src/supervisor/child-diagnostics.ts";
import {
	attachChildSessionRelease,
	bindChildSessionExtensions,
	type ChildSessionBinding,
} from "../../src/supervisor/child-session.ts";

/** What a fake session records: the bindings handed over, the call order, the events. */
interface FakeOptions {
	/** Whether the fake extension runner reports a `session_shutdown` handler. */
	shutdownHandlers?: boolean;
	/** Make `emit` reject, the way a throwing handler does. */
	emitThrows?: boolean;
}

/** Records every bindings object it is handed and every call, in order. */
function fakeSession(options: FakeOptions = {}) {
	const calls: Array<{ mode?: "print"; onError?: (error: unknown) => void }> = [];
	const order: string[] = [];
	const events: Array<{ type: string; reason?: string }> = [];
	const session: ChildSessionBinding = {
		async bindExtensions(bindings) {
			calls.push(bindings);
			order.push("bind");
		},
		extensionRunner: {
			hasHandlers: (event: string) => (options.shutdownHandlers ?? true) && event === "session_shutdown",
			async emit(event) {
				order.push("emit");
				events.push(event);
				if (options.emitThrows) throw new Error("shutdown handler exploded");
				return undefined;
			},
		},
		dispose() {
			order.push("dispose");
		},
	};
	return { session, calls, order, events };
}

/** Let the fire-and-forget `dispose()` chain (release → raw dispose) finish. */
function settle(): Promise<void> {
	return new Promise<void>((resolve) => setImmediate(resolve));
}

/** Run `fn` with `console.warn` captured (restored even when it throws). */
async function captureWarnings(fn: (warnings: string[]) => Promise<void> | void): Promise<string[]> {
	const warnings: string[] = [];
	const previous = console.warn;
	console.warn = (...args: unknown[]) => {
		warnings.push(args.map((arg) => (typeof arg === "string" ? arg : String(arg))).join(" "));
	};
	try {
		await fn(warnings);
	} finally {
		console.warn = previous;
	}
	return warnings;
}

/**
 * A child sink aimed at a throwaway run dir (#468), with the host channel captured.
 *
 * `host` is what the HOST would show: the whole point of #468 is that it stays
 * empty unless real extension errors happened (one run-end summary line) or the
 * `PI_LEGION_CHILD_DIAGNOSTICS` switch is on.
 */
function testSink(options: { child?: string; host?: boolean } = {}) {
	const runDir = mkdtempSync(path.join(tmpdir(), "legion-child-diag-"));
	const host: string[] = [];
	const logFile = path.join(runDir, "diagnostics.log");
	const sink = createChildDiagnosticSink({
		...(options.child ? { child: options.child } : {}),
		logFile,
		host: options.host ?? false,
		hostWrite: (line) => host.push(line),
	});
	const log = () => {
		try {
			return readFileSync(logFile, "utf8");
		} catch {
			return "";
		}
	};
	return { sink, host, logFile, log, runDir };
}

test("D7.3 binds exactly once, with exactly { mode: \"print\", onError }", async () => {
	const { session, calls } = fakeSession();

	await bindChildSessionExtensions(session);

	assert.equal(calls.length, 1, "one bind per session — a second one leaves MCP connections dangling");
	const bindings = calls[0]!;
	// Key set, not just values: `commandContextActions` / `shutdownHandler` /
	// `abortHandler` would fake capabilities an in-process child does not have.
	assert.deepEqual(
		Object.keys(bindings).sort(),
		["mode", "onError"],
		"no fabricated capability beyond mode + onError",
	);
	assert.equal(bindings.mode, "print", "mode is the runner's own default, declared on purpose");
	assert.equal(typeof bindings.onError, "function", "onError is mandatory: without it errors vanish");
});

test("D7.3 onError goes to the child sink, labelled with the child name (never the host)", async () => {
	// #468: an in-process child shares the host's stderr, so `console.warn` here was
	// drawn above the user's input box. The record must land on the child sink — and
	// nothing may reach the host for the *live* error line.
	const { session, calls } = fakeSession();
	const { sink, host, log } = testSink({ child: "root.scout" });
	await bindChildSessionExtensions(session, "root.scout", sink);

	await captureWarnings(async (warnings) => {
		// The SDK's shape: a record, not an Error.
		calls[0]!.onError!({ extensionPath: "builtin:mcp", event: "session_start", error: "spawn npx ENOENT" });
		assert.equal(warnings.length, 0, "nothing on the host console — that is the whole point");
	});

	assert.deepEqual(host, [], "no UI/console line while the run is still going");
	const record = log().trim().split("\n");
	assert.equal(record.length, 1, "one record on disk, never silence");
	assert.match(record[0]!, /^\d{4}-\d{2}-\d{2}T[\d:.]+Z child=root\.scout event=extension\.error real=true reason=/, "timestamp + event + reason");
	assert.match(record[0]!, /builtin:mcp/, "the failing extension is named");
	assert.match(record[0]!, /session_start/, "the failing event is named");
	assert.match(record[0]!, /spawn npx ENOENT/, "the cause survives");

	// A listener must never be the thing that throws.
	assert.doesNotThrow(() => {
		calls[0]!.onError!("plain string");
		calls[0]!.onError!(new Error("a real Error"));
	});
	const lines = log().trim().split("\n");
	assert.equal(lines.length, 3, "both odd payloads still produce exactly one record each");
	assert.match(lines[1]!, /reason=plain string$/);
	assert.match(lines[2]!, /reason=Error: a real Error$/);
});

test("D7.3 an unnamed child still binds (label is optional, bindings are not)", async () => {
	const { session, calls } = fakeSession();
	const { sink, host, log } = testSink();
	await bindChildSessionExtensions(session, undefined, sink);

	await captureWarnings(async (warnings) => {
		calls[0]!.onError!({ error: "boom" });
		assert.equal(warnings.length, 0, "still nothing on the host console");
	});

	assert.deepEqual(host, []);
	assert.match(log(), /child=- event=extension\.error real=true reason=boom/);
});

// #415 — the host's SKIPPED `turn_end` boundary (see `skippedTurnEndBoundary`).

/** The exact record the host's `_dispatchTurnEndBoundary` emits (`agent-session.js`), verbatim. */
const SKIPPED_BOUNDARY_RECORD = {
	extensionPath: "<boundary>",
	event: "turn_end",
	error: "turn_end could not resolve the persisted assistant entry ID",
};

test("#415: a skipped turn_end boundary is recorded as a skip, not as an extension error (§468: disk only)", async () => {
	// Reproduction: `pi-async` registers a real `turn_end` handler, so the host's
	// `hasHandlers("turn_end")` gate is true. The host then fails to resolve this turn's
	// assistant message to a persisted entry — a turn ended by `dispose()`'s abort, by
	// compaction, or after a fork — and emits this record against the `<boundary>`
	// pseudo-extension. Before #415 legion printed it as
	// `<child> extension error: <boundary> turn_end: …`, blaming a healthy extension.
	// Before #468 it then printed the corrected line ABOVE THE USER'S INPUT BOX.
	// Mutation that must turn this red: moving the record back to `console.warn`.
	const { session, calls } = fakeSession();
	const { sink, host, log } = testSink({ child: "hygiene-doctor" });
	await bindChildSessionExtensions(session, "hygiene-doctor", sink);

	await captureWarnings(async (warnings) => {
		assert.doesNotThrow(() => calls[0]!.onError!(SKIPPED_BOUNDARY_RECORD), "degrade, never throw");
		assert.equal(warnings.length, 0, "#468: a benign skip is never host-visible");
	});

	assert.deepEqual(host, [], "and it never reaches the host channel either");
	const line = log().trim();
	assert.match(line, /child=hygiene-doctor /, "the child is still named");
	assert.match(line, /event=turn_end\.skipped /, "the log says the HOOK was skipped");
	assert.doesNotMatch(line, /extension\.error/, "no extension failed, so do not claim one did");
	assert.match(line, /real=false/, "and it is not something to interrupt the user with");
	assert.match(line, /turn_end could not resolve the persisted assistant entry ID/, "the host's cause survives");
	assert.match(line, /no persisted entry/, "and the reader learns why it was skipped");
});

test("#415: the degrade is exact — anything else is still an extension error", async () => {
	// Pins the match width. A broad match (substring, or the path alone) would silently
	// reclassify genuine extension failures as benign skips — the inverse of the bug.
	const { session, calls } = fakeSession();
	const { sink, log } = testSink({ child: "hygiene-doctor" });
	await bindChildSessionExtensions(session, "hygiene-doctor", sink);

	// Same pseudo-extension, different cause: not the entry-id diagnostic.
	calls[0]!.onError!({
		...SKIPPED_BOUNDARY_RECORD,
		error: "turn_end requested continuation without runnable model context",
	});
	// Same message, but a real extension failed while handling turn_end.
	calls[0]!.onError!({ ...SKIPPED_BOUNDARY_RECORD, extensionPath: "builtin:mcp" });
	// Same message, a near-miss path.
	calls[0]!.onError!({ ...SKIPPED_BOUNDARY_RECORD, extensionPath: "<boundary>x" });

	const lines = log().trim().split("\n");
	assert.equal(lines.length, 3, "one record each, never silence");
	for (const line of lines) assert.match(line, /event=extension\.error real=true/, "these are real failures");
	assert.match(lines[0]!, /requested continuation without runnable model context/);
	assert.match(lines[1]!, /builtin:mcp turn_end: turn_end could not resolve/);
});

test("D7.3 a bind failure propagates (it is not swallowed)", async () => {
	// `extendResourcesFromExtensions` runs inside bindExtensions and can throw.
	// Rare, but a spawn whose extensions never learned the session exists must fail
	// loudly rather than be handed back looking healthy — this pins “throws up” and
	// claims nothing more than that.
	const session: ChildSessionBinding = {
		async bindExtensions() {
			throw new Error("resources_discover exploded");
		},
		dispose() {
			/* not exercised */
		},
	};
	await assert.rejects(() => bindChildSessionExtensions(session, "root.worker"), /resources_discover exploded/);
});

// ────────────── child-mcp-v1 r2 ──────────────

test("r2: bind gate and builtin:mcp path read the same switch (childEnablesMcp)", () => {
	// Same table as D7.1 (`args.test.ts`): only an explicit mask turns MCP off.
	const ON: Array<string | undefined> = [undefined, "", "all", "1", "true", "on", "yes", "   ", "whatever", "MCP"];
	const OFF = ["0", "false", "off", "no", "none"];

	// The two sides of the switch, compared case by case: the path injection
	// (`collectChildExtensions`, which both transports read) and the bind gate
	// (`childEnablesMcp`, which `defaultSessionFactory` reads) must agree, or
	// `PI_LEGION_CHILD_MCP=0` would disable one half only.
	for (const value of [...ON, ...OFF]) {
		const env = value === undefined ? {} : { PI_LEGION_CHILD_MCP: value };
		const shouldBind = childEnablesMcp(env);
		const exts = collectChildExtensions({ tools: ["read"] }, env);
		assert.equal(
			shouldBind,
			value === undefined || ON.includes(value),
			`the table itself disagrees with childEnablesMcp for ${JSON.stringify(value)}`,
		);
		assert.equal(
			exts.includes(BUILTIN_MCP),
			shouldBind,
			`path side vs bind side disagree for PI_LEGION_CHILD_MCP=${JSON.stringify(value)}`,
		);
		assert.equal(
			exts.includes(BUILTIN_TOOL_SEARCH),
			shouldBind,
			`tool-search must follow the same switch: ${JSON.stringify(value)}`,
		);
	}

	// One implementation, not two copies: `args.ts` re-exports the policy function.
	assert.equal(childEnablesMcp, policyChildEnablesMcp, "args.ts must re-export childEnablesMcp, never re-implement it");

	// FORMAT TRIPWIRE, not a behavioral assertion (r4 F6 — accepted as-is): the
	// factory is not exported, so the only mechanical check left is the call count in
	// its source. What it guards is the WHOLE LINE being deleted — one bind call (a
	// second one dangles MCP connections) — not its formatting: the surrounding shape
	// and `input.name` are deliberately not pinned.
	const source = readFileSync(new URL("../../src/supervisor/inprocess-supervisor.ts", import.meta.url), "utf8");
	assert.equal(
		source.split("bindChildSessionExtensions(").length - 1,
		1,
		"format tripwire: the factory file calls bindChildSessionExtensions( once",
	);
});

// ────────────── child-mcp-v1 r3 C1 (D7.5) ──────────────

test("D7.5 dispose emits session_shutdown once, reason=quit, before the real dispose", async () => {
	const { session, order, events } = fakeSession();
	await bindChildSessionExtensions(session, "root.scout");
	attachChildSessionRelease(session);

	session.dispose?.();
	await settle();

	assert.deepEqual(
		events,
		[{ type: "session_shutdown", reason: "quit" }],
		"exactly one event, and only ever reason=quit (in-process has no reload/new/fork)",
	);
	assert.deepEqual(
		order,
		["bind", "emit", "dispose"],
		"emit precedes dispose: the extension ctx must still be valid for the handlers' sync prefix",
	);
});

test("D7.5 a throwing shutdown handler still gets disposed, and is reported once (§468)", async () => {
	const { session, order } = fakeSession({ emitThrows: true });
	const { sink, host, log } = testSink({ child: "root.scout" });
	await bindChildSessionExtensions(session, undefined, sink);
	attachChildSessionRelease(session, undefined, sink);

	await captureWarnings(async (warnings) => {
		session.dispose?.();
		await settle();
		assert.deepEqual(order, ["bind", "emit", "dispose"], "dispose must run on the rejection path too");
		assert.equal(warnings.length, 0, "#468: the live line no longer goes to the host console");
	});

	assert.match(log(), /event=session_shutdown\.failed real=true reason=Error: shutdown handler exploded/);
	// The failure is real, so the host gets it — as ONE line, at run end.
	assert.equal(host.length, 1, "one summary line, not one per event");
	assert.match(host[0]!, /^\[pi-legion\] in-process child root\.scout: 1 extension error this run — first: session_shutdown failed: Error: shutdown handler exploded/);
});

test("D7.5 repeated dispose() emits once (idempotent)", async () => {
	const { session, order, events } = fakeSession();
	await bindChildSessionExtensions(session);
	attachChildSessionRelease(session);

	session.dispose?.();
	session.dispose?.();
	await settle();
	session.dispose?.();
	await settle();

	assert.equal(events.length, 1, "one shutdown, no matter how often the retire path disposes");
	assert.deepEqual(order, ["bind", "emit", "dispose"], "and the real dispose runs exactly once");
});

test("D7.5 a session that was never bound emits nothing", async () => {
	// `PI_LEGION_CHILD_MCP=0` ⇒ no bind ⇒ inherited host extensions must not see a
	// shutdown they never got a start for. The dispose itself still happens.
	const { session, order, events } = fakeSession();
	attachChildSessionRelease(session);

	session.dispose?.();
	await settle();

	assert.deepEqual(events, [], "no bind, no session_shutdown");
	assert.deepEqual(order, ["dispose"], "the dispose still happens");
});

test("D7.5 no session_shutdown handler ⇒ no emit", async () => {
	// The SDK's own rule (`emitSessionShutdownEvent`): `hasHandlers` first, then
	// `emit`. A session with no handler must not be handed the event anyway.
	const { session, order, events } = fakeSession({ shutdownHandlers: false });
	await bindChildSessionExtensions(session);
	attachChildSessionRelease(session);

	session.dispose?.();
	await settle();

	assert.deepEqual(events, [], "hasHandlers() === false ⇒ nothing emitted");
	assert.deepEqual(order, ["bind", "dispose"], "and dispose still runs");
});

test("r4 F3: the armed dispose is awaitable and only resolves after the real dispose", async () => {
	// The retire paths (`rollbackSpawn` / `retireChild`) await this before freeing the
	// slot; a fire-and-forget wrapper would free the slot while the child's MCP
	// connections were still closing, letting real concurrency exceed the cap under
	// the 8-slot rotation.
	const order: string[] = [];
	const session: ChildSessionBinding = {
		async bindExtensions() {
			order.push("bind");
		},
		extensionRunner: {
			hasHandlers: (event: string) => event === "session_shutdown",
			async emit() {
				order.push("emit");
				return undefined;
			},
		},
		dispose() {
			order.push("dispose");
		},
	};
	attachChildSessionRelease(session);
	await bindChildSessionExtensions(session);

	const pending = session.dispose?.();
	assert.ok(pending instanceof Promise, "the armed dispose must return a promise, not void");
	assert.equal(order.includes("dispose"), false, "the real dispose has NOT run when it returns");

	await pending;
	assert.deepEqual(order, ["bind", "emit", "dispose"], "it resolves only after emit + real dispose");
});

test("D7.5 a wedged handler cannot hold the session: dispose still runs (r4 F5)", async () => {
	// `attachChildSessionRelease` forwards `timeoutMs` so this case takes 10ms instead
	// of a real second; production always uses the 1000ms default.
	const order: string[] = [];
	const session: ChildSessionBinding = {
		async bindExtensions() {
			order.push("bind");
		},
		extensionRunner: {
			hasHandlers: (event: string) => event === "session_shutdown",
			// A handler that never settles (a stuck `connection.close()` would look
			// like this): the emit can never be awaited forever.
			emit: () => new Promise<never>(() => {}),
		},
		dispose() {
			order.push("dispose");
		},
	};
	attachChildSessionRelease(session, 10);
	await bindChildSessionExtensions(session);

	const startedAt = Date.now();
	await session.dispose?.();

	assert.deepEqual(order, ["bind", "dispose"], "the real dispose ran despite the wedged emit");
	assert.ok(Date.now() - startedAt >= 9, "and it waited for the bound rather than hanging");
});

// FORMAT TRIPWIRE, not a behavioral assertion (r4 F6 — accepted as-is): what it
// defends is the arm LINE being deleted — not how it is written. Without it,
// removing `attachChildSessionRelease(session)` leaves every behavioral case green
// while MCP connections leak again — the C1 bug itself. The cost of making this a
// true behavior test is exporting `defaultSessionFactory`, which is not worth it.
test("r3 C1 wiring: the factory arms the release exactly once (format tripwire)", () => {
	const source = readFileSync(new URL("../../src/supervisor/inprocess-supervisor.ts", import.meta.url), "utf8");
	assert.equal(
		source.split("attachChildSessionRelease(").length - 1,
		1,
		"format tripwire: the factory file calls attachChildSessionRelease( once",
	);
});
