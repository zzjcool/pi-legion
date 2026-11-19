/**
 * `d0`: a READ-ONLY remote call resolves the machine, not a launch target.
 *
 * The 6.2.2 harness pinned the bug: with `subagents.crossMachine.enabled: true` and
 * no `hosts.<name>` entry (which is what a zero-config launch leaves behind, because
 * it discovered that machine's directory per call), `collect` never fetched a
 * transcript at all. The read-back resolved the host through `resolveHostTarget`,
 * which demands an absolute `hosts.<name>.cwd` — a LAUNCH question — and the
 * refusal was then masked by the worktree-ownership guard.
 *
 * `resolveReadTarget` answers the read question: who, not where. These tests pin the
 * two properties that fix depends on — it accepts a zero-config machine, and it
 * derives the same `mirrorRoot` a launch would when the settings do name a cwd — and
 * then prove the read-back really fetches over a zero-config setup.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { createRemoteSessionReadback } from "../../src/runs/remote-artifact.ts";
import { resolveHostTarget, resolveReadTarget } from "../../src/runs/remote.ts";
import { ErrorCodes, SubagentError, type CrossMachineSettings } from "../../src/shared/types.ts";

const HOST = "vps";

function settings(overrides: Partial<CrossMachineSettings> = {}): CrossMachineSettings {
	return { enabled: true, ...overrides };
}

test("d0: a zero-config host resolves for a READ (enabled alone is enough)", () => {
	const target = resolveReadTarget(HOST, settings());
	assert.equal(target.host, HOST);
	assert.equal(target.mirrorRoot, undefined, "no cwd in the settings ⇒ no derivable mirror prefix");

	// And the contrast that made this a defect: the LAUNCH resolver refuses the very
	// same settings, because it cannot start a child without a directory.
	assert.throws(
		() => resolveHostTarget(HOST, settings()),
		(error: unknown) => error instanceof SubagentError && error.code === ErrorCodes.INVALID_PARAMS,
	);
});

test("d0: a configured host derives the SAME mirrorRoot a launch would use", () => {
	const configured = settings({ hosts: { [HOST]: { cwd: "/srv/app" } } });
	assert.equal(resolveReadTarget(HOST, configured).mirrorRoot, resolveHostTarget(HOST, configured).mirrorRoot);
});

test("d0: cross-machine must still be ENABLED for a read, and a host must be named", () => {
	assert.throws(() => resolveReadTarget(HOST, { enabled: false }), /crossMachine\.enabled = true/);
	assert.throws(() => resolveReadTarget(HOST, undefined), /crossMachine\.enabled = true/);
	assert.throws(() => resolveReadTarget("   ", settings()), /needs a host name/);
});

test("d0: the read-back really fetches over zero-config, using the record's remote_dir", async () => {
	const reads: string[] = [];
	const client = {
		async start() {},
		async request(method: string, params: Record<string, unknown>) {
			reads.push(`${method}:${String(params.path ?? params.machine ?? "")}`);
			if (method === "file.read") {
				// First call: the line count. Second: the window. `remote_dir` decides the
				// path, so the reply must be about the recorded file, not a derived one.
				const offset = params.offset;
				if (offset === undefined) return { lines: 2 };
				return { text: '{"a":1}\n{"b":2}\n', last: 2 };
			}
			return {};
		},
		close() {},
	} as never;
	const readback = createRemoteSessionReadback({ crossMachine: settings(), clientFactory: () => client });
	const result = await readback({
		host: HOST,
		name: "centurion-0",
		remoteDir: "/srv/.pi-subagents-mirror/r-1/centurion-0",
		localPath: "/tmp/xm-readback-zero-config.jsonl",
	});
	assert.equal(result.ok, true, `zero-config read-back must succeed: ${JSON.stringify(result)}`);
	assert.equal(result.ok && result.remotePath, "/srv/.pi-subagents-mirror/r-1/centurion-0/session.jsonl");
	assert.equal(result.ok && result.lines, 2);
	assert.ok(reads.some((entry) => entry.includes("/srv/.pi-subagents-mirror/r-1/centurion-0/session.jsonl")));
});
