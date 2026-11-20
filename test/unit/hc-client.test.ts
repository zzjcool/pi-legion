/**
 * #447 — a dead WRITE END is a connection fact, never a host crash.
 *
 * `hc` is a child process speaking newline-delimited JSON on its stdin/stdout. When
 * that child dies between the spawn and a write (the CI failure that started this:
 * a fake `hc` that exited `3`, and the test process died of `write EPIPE` instead of
 * the machine being reported unreachable), Node emits `error` on `child.stdin`. A
 * stream `error` with no listener is an `uncaughtException`, so ONE unreachable
 * machine would take the whole `pi` session down. The client's contract is the same
 * terminal state as an exit: pending calls reject, later calls fail fast, nothing
 * is thrown at the process.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { hcCliClient } from "../../src/hc/client.ts";

/**
 * A fake `hc` that answers the handshake, then closes its stdin and stays alive
 * for a moment. Closing stdin BEFORE printing the reply removes the race the
 * original `exit 3` binary had: by the time the client can send its next frame,
 * the pipe's read end is already gone, so that write ALWAYS gets `EPIPE`.
 */
function dyingCore(root: string): string {
	const core = path.join(root, "hc-dying");
	writeFileSync(
		core,
		[
			"#!/bin/sh",
			"IFS= read -r hello",
			"exec 0<&-",
			`printf '%s\\n' '{"jsonrpc":"2.0","id":1,"result":{}}'`,
			"sleep 0.2",
			"",
		].join("\n"),
		{ mode: 0o755 },
	);
	chmodSync(core, 0o755);
	return core;
}

test("#447: a core that dies mid-handshake rejects the call instead of crashing the host (stdin EPIPE)", async () => {
	const root = mkdtempSync(path.join(tmpdir(), "hc-epipe-"));
	const client = hcCliClient({ env: { ...process.env, HC_BIN: dyingCore(root) } });
	try {
		// The handshake is answered; only the NEXT write hits the dead pipe.
		await client.start();
		await assert.rejects(
			() => client.request("terminal.get", { terminal: "njbox/lgl-gone" }),
			(error: Error) => /stdin failed|EPIPE/.test(error.message),
			"the failed write must reject the call, naming the dead connection",
		);
		// The connection is terminal: no second write into the dead pipe.
		await assert.rejects(
			() => client.request("terminal.get", { terminal: "njbox/lgl-gone" }),
			/stdin failed|EPIPE/,
		);
	} finally {
		client.close(); // must not throw on the already-dead write end
		rmSync(root, { recursive: true, force: true });
	}
});

test("#447: closing a client whose write end already died is silent and idempotent", async () => {
	const root = mkdtempSync(path.join(tmpdir(), "hc-epipe-close-"));
	const client = hcCliClient({ env: { ...process.env, HC_BIN: dyingCore(root) } });
	try {
		await client.start();
		await assert.rejects(() => client.request("file.read", { on: "njbox", path: "/tmp/x", limit: 0 }), /stdin failed|EPIPE/);
		client.close();
		client.close();
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
