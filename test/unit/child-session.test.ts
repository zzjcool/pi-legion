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
import { readFileSync } from "node:fs";
import {
	BUILTIN_MCP,
	BUILTIN_TOOL_SEARCH,
	childEnablesMcp,
	collectChildExtensions,
} from "../../src/runs/args.ts";
import { childEnablesMcp as policyChildEnablesMcp } from "../../src/runs/extension-inheritance.ts";
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

test("D7.3 onError goes to console.warn, labelled with the child name", async () => {
	const { session, calls } = fakeSession();
	await bindChildSessionExtensions(session, "root.scout");

	await captureWarnings(async (warnings) => {
		// The SDK's shape: a record, not an Error.
		calls[0]!.onError!({ extensionPath: "builtin:mcp", event: "session_start", error: "spawn npx ENOENT" });
		assert.equal(warnings.length, 1, "one line per extension error, never silence");
		assert.match(warnings[0]!, /^\[pi-legion\] in-process child root\.scout extension error: /);
		assert.match(warnings[0]!, /builtin:mcp/, "the failing extension is named");
		assert.match(warnings[0]!, /session_start/, "the failing event is named");
		assert.match(warnings[0]!, /spawn npx ENOENT/, "the cause survives");
	});

	// A listener must never be the thing that throws.
	await captureWarnings(async (warnings) => {
		calls[0]!.onError!("plain string");
		calls[0]!.onError!(new Error("a real Error"));
		assert.equal(warnings.length, 2, "both odd payloads still produce exactly one line");
		assert.match(warnings[0]!, /plain string/);
		assert.match(warnings[1]!, /a real Error/);
	});
});

test("D7.3 an unnamed child still binds (label is optional, bindings are not)", async () => {
	const { session, calls } = fakeSession();
	await bindChildSessionExtensions(session);

	await captureWarnings(async (warnings) => {
		calls[0]!.onError!({ error: "boom" });
		assert.equal(warnings.length, 1);
		assert.match(warnings[0]!, /^\[pi-legion\] in-process child extension error: boom$/);
	});
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

	// FORMAT TRIPWIRE, not a behavioral assertion: the factory is not exported, so
	// the only mechanical check left is the call count in its source — one bind call
	// (a second one dangles MCP connections). Counted per call; the surrounding line
	// shape and `input.name` are deliberately not pinned.
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

	session.dispose();
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

test("D7.5 a throwing shutdown handler still gets disposed", async () => {
	const { session, order } = fakeSession({ emitThrows: true });
	await bindChildSessionExtensions(session);
	attachChildSessionRelease(session);

	await captureWarnings(async (warnings) => {
		session.dispose();
		await settle();
		assert.deepEqual(order, ["bind", "emit", "dispose"], "dispose must run on the rejection path too");
		assert.equal(warnings.length, 1, "the failure is reported, not silent");
		assert.match(warnings[0]!, /in-process child session_shutdown failed/);
	});
});

test("D7.5 repeated dispose() emits once (idempotent)", async () => {
	const { session, order, events } = fakeSession();
	await bindChildSessionExtensions(session);
	attachChildSessionRelease(session);

	session.dispose();
	session.dispose();
	await settle();
	session.dispose();
	await settle();

	assert.equal(events.length, 1, "one shutdown, no matter how often the retire path disposes");
	assert.deepEqual(order, ["bind", "emit", "dispose"], "and the real dispose runs exactly once");
});

test("D7.5 a session that was never bound emits nothing", async () => {
	// `PI_LEGION_CHILD_MCP=0` ⇒ no bind ⇒ inherited host extensions must not see a
	// shutdown they never got a start for. The dispose itself still happens.
	const { session, order, events } = fakeSession();
	attachChildSessionRelease(session);

	session.dispose();
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

	session.dispose();
	await settle();

	assert.deepEqual(events, [], "hasHandlers() === false ⇒ nothing emitted");
	assert.deepEqual(order, ["bind", "dispose"], "and dispose still runs");
});

// FORMAT TRIPWIRE, not a behavioral assertion: the factory is not exported, so the
// only mechanical check that the release is ARMED at all is its call count in the
// source. Without it, deleting `attachChildSessionRelease(session)` leaves every
// behavioral case green while MCP connections leak again — the C1 bug itself.
test("r3 C1 wiring: the factory arms the release exactly once (format tripwire)", () => {
	const source = readFileSync(new URL("../../src/supervisor/inprocess-supervisor.ts", import.meta.url), "utf8");
	assert.equal(
		source.split("attachChildSessionRelease(").length - 1,
		1,
		"format tripwire: the factory file calls attachChildSessionRelease( once",
	);
});
