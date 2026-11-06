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
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
	bindChildSessionExtensions,
	type ChildSessionBinding,
} from "../../src/supervisor/child-session.ts";

/** Records every bindings object it is handed; never touches the SDK. */
function fakeSession() {
	const calls: Array<{ mode?: "print"; onError?: (error: unknown) => void }> = [];
	const session: ChildSessionBinding = {
		async bindExtensions(bindings) {
			calls.push(bindings);
		},
	};
	return { session, calls };
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

test("D7.3 a bind failure propagates instead of leaving a half-started session", async () => {
	// `extendResourcesFromExtensions` runs inside bindExtensions and can throw. A
	// child whose extensions were never told the session exists must not be handed
	// back as healthy, so this is deliberately not caught.
	const session: ChildSessionBinding = {
		async bindExtensions() {
			throw new Error("resources_discover exploded");
		},
	};
	await assert.rejects(() => bindChildSessionExtensions(session, "root.worker"), /resources_discover exploded/);
});
