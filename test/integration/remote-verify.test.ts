/**
 * S3 — remote verify against the fake hc core (contract
 * `cross-machine-spawn-v1` D14).
 *
 * The four classes must be OBSERVABLE and DISTINCT, because the whole point is
 * that a machine failure never becomes a `rejected` verdict about the child's
 * work. The fake core runs `machine.exec` for real (`spawnSync("sh", …)`), so
 * `true` / `false` / a command past the deadline are genuine executions, not
 * scripted answers.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { hcCliClient, type HcClient } from "../../src/hc/client.ts";
import { applyVerification } from "../../src/runs/acceptance.ts";
import {
	REMOTE_EXEC_TIMEOUT_CEILING_S,
	clampRemoteVerifyTimeout,
	remoteVerifyCommand,
} from "../../src/runs/remote-verify.ts";
import type { HostTarget } from "../../src/runs/remote.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE_CORE = path.resolve(HERE, "../helpers/fake-hc-core.mjs");
const HOST = "fakebox";

interface Harness {
	root: string;
	remoteRoot: string;
	remoteCwd: string;
	target: HostTarget;
	client: HcClient;
	cleanup: () => void;
}

/** A core whose "other machine" is a real directory tree under a temp root. */
function harness(prefix = "remote-verify-"): Harness {
	const root = mkdtempSync(path.join(tmpdir(), prefix));
	const remoteRoot = path.join(root, "remote");
	const remoteCwd = path.join(remoteRoot, "work");
	mkdirSync(remoteCwd, { recursive: true });
	const binDir = path.join(root, "bin");
	mkdirSync(binDir, { recursive: true });
	const wrapper = path.join(binDir, "hc");
	writeFileSync(wrapper, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(FAKE_CORE)} "$@"\n`, { mode: 0o755 });
	chmodSync(wrapper, 0o755);
	const previous = { ...process.env };
	Object.assign(process.env, {
		HC_BIN: wrapper,
		FAKE_HC_REMOTE_ROOT: remoteRoot,
		FAKE_HC_MACHINES: HOST,
	});
	const client = hcCliClient({ env: process.env });
	const target: HostTarget = {
		host: HOST,
		cwd: remoteCwd,
		node: "node",
		piCli: "pi",
		pathMap: [],
		piLegionRoot: path.posix.join(remoteRoot, ".pi-legion"),
		mirrorRoot: path.posix.join(remoteRoot, ".pi-subagents-mirror"),
		worktreeRoot: path.posix.join(remoteRoot, ".pi-worktrees"),
	};
	return {
		root,
		remoteRoot,
		remoteCwd,
		target,
		client,
		cleanup: () => {
			client.close();
			for (const key of ["HC_BIN", "FAKE_HC_REMOTE_ROOT", "FAKE_HC_MACHINES"]) {
				if (previous[key] === undefined) delete process.env[key];
				else process.env[key] = previous[key];
			}
			rmSync(root, { recursive: true, force: true });
		},
	};
}

test("S3/D14: `true` on that machine passes, and the result names the machine", async (t) => {
	// The sample the report quotes: a passing verify.
	const h = harness();
	t.after(() => h.cleanup());
	const result = await remoteVerifyCommand({
		client: h.client,
		target: h.target,
		command: "true",
		timeoutMs: 30_000,
	});
	assert.equal(result.code, 0);
	assert.equal(result.failure, undefined, "a real pass carries no failure class");
	assert.equal(result.host, HOST);

	// And through the acceptance chain it reads as `verified … on host 'fakebox'`.
	const acceptance = await applyVerification(
		{ status: "accepted", level: "attested", reason: "child says ok" },
		{
			cwd: h.remoteCwd,
			criteria: [{ id: "v", must: "true", evidence: ["verification-output"], severity: "required", command: "true" }],
			run: async (command, _cwd, timeoutMs) => remoteVerifyCommand({
				client: h.client,
				target: h.target,
				command,
				timeoutMs: timeoutMs ?? 30_000,
			}),
			timeoutMs: 30_000,
		},
	);
	assert.equal(acceptance.status, "accepted");
	assert.equal(acceptance.level, "verified");
	assert.match(String(acceptance.reason), /^verified by `true` on host 'fakebox'$/);
});

test("S3/D14: `false` is a CODE failure — a verdict about the work, not the machine", async (t) => {
	const h = harness();
	t.after(() => h.cleanup());
	const result = await remoteVerifyCommand({
		client: h.client,
		target: h.target,
		command: "false",
		timeoutMs: 30_000,
	});
	assert.equal(result.failure, "code");
	assert.equal(result.code, 1);
	assert.equal(result.host, HOST);

	const acceptance = await applyVerification(
		{ status: "accepted", level: "attested" },
		{
			cwd: h.remoteCwd,
			criteria: [{ id: "v", must: "false", evidence: ["verification-output"], severity: "required", command: "false" }],
			run: async (command, _cwd, timeoutMs) => remoteVerifyCommand({
				client: h.client,
				target: h.target,
				command,
				timeoutMs: timeoutMs ?? 30_000,
			}),
			timeoutMs: 30_000,
		},
	);
	assert.equal(acceptance.status, "rejected");
	assert.match(String(acceptance.reason), /^verification failed on host 'fakebox' \(`false`\)/);
});

test("S3/D14: a command past the deadline is a TIMEOUT, never a code failure", async (t) => {
	// `sleep 700` would outlive the whole test run; the point is the class, so the
	// budget is 1s and the core kills the process at that deadline (spike fact #3).
	const h = harness();
	t.after(() => h.cleanup());
	const started = Date.now();
	const result = await remoteVerifyCommand({
		client: h.client,
		target: h.target,
		command: "sleep 700",
		timeoutMs: 1_000,
	});
	const elapsed = Date.now() - started;
	assert.equal(result.failure, "timeout", `expected a timeout, got ${JSON.stringify(result)}`);
	assert.ok(elapsed < 20_000, `the deadline must fire promptly, took ${elapsed}ms`);
	assert.equal(result.host, HOST);

	const acceptance = await applyVerification(
		{ status: "accepted", level: "attested" },
		{
			cwd: h.remoteCwd,
			criteria: [{ id: "v", must: "long", evidence: ["verification-output"], severity: "required", command: "sleep 700" }],
			run: async () => result,
			timeoutMs: 1_000,
		},
	);
	// The whole point: a machine-side timeout is NOT "the child's work failed".
	assert.equal(acceptance.status, "unknown");
	assert.match(String(acceptance.reason), /^verification unavailable on host 'fakebox' \(timeout\)/);
});

test("S3/D14: an unknown machine is its own class, not `unreachable`", async (t) => {
	const h = harness();
	t.after(() => h.cleanup());
	const result = await remoteVerifyCommand({
		client: h.client,
		target: { ...h.target, host: "ghost" },
		command: "true",
		timeoutMs: 5_000,
	});
	assert.equal(result.failure, "unknown-host");
	assert.match(String(result.failureDetail), /unknown machine: ghost/);
});

test("S3/D14: a dead core is `unreachable`, and a missing tree says which path", async (t) => {
	const h = harness();
	t.after(() => h.cleanup());
	// A client pointed at nothing: the transport fails, not the command.
	const dead = hcCliClient({ env: { ...process.env, HC_BIN: path.join(h.root, "no-such-hc") } });
	try {
		const result = await remoteVerifyCommand({
			client: dead,
			target: h.target,
			command: "true",
			timeoutMs: 5_000,
		});
		assert.equal(result.failure, "unreachable");
	} finally {
		dead.close();
	}
	// The machine is fine, the tree is gone: still a machine fact, and it names the path.
	const missing = await remoteVerifyCommand({
		client: h.client,
		target: h.target,
		command: "true",
		cwd: path.posix.join(h.remoteCwd, "gone"),
		timeoutMs: 5_000,
	});
	assert.equal(missing.failure, "unreachable");
	assert.match(String(missing.failureDetail), /gone does not exist on fakebox/);
});

test("S3/D14: every non-code class becomes `unknown` on the acceptance chain", async () => {
	// The one regression that matters: `unreachable` must never render as rejected.
	for (const failure of ["timeout", "unreachable", "unknown-host"] as const) {
		const acceptance = await applyVerification(
			{ status: "accepted", level: "attested", reason: "child claims ok" },
			{
				cwd: "/tmp",
				criteria: [{ id: "v", must: "x", evidence: ["verification-output"], severity: "required", command: "npm test" }],
				run: async () => ({ code: 1, stdout: "", stderr: "", failure, failureDetail: "detail", host: "vps" }),
				timeoutMs: 1_000,
			},
		);
		assert.equal(acceptance.status, "unknown", `${failure} must not reject`);
		assert.equal(acceptance.level, "attested", `${failure} must not claim verified`);
		assert.match(String(acceptance.reason), new RegExp(`^verification unavailable on host 'vps' \\(${failure}\\)`));
	}
});

test("S3: a budget over hc's ceiling is clamped AND announced", () => {
	const exact = clampRemoteVerifyTimeout(REMOTE_EXEC_TIMEOUT_CEILING_S * 1000);
	assert.deepEqual(exact, { seconds: REMOTE_EXEC_TIMEOUT_CEILING_S, clamped: false });
	const over = clampRemoteVerifyTimeout(30 * 60 * 1000);
	assert.deepEqual(over, { seconds: REMOTE_EXEC_TIMEOUT_CEILING_S, clamped: true });
	// Sub-second budgets round UP: a 1ms verify must still be a real deadline.
	assert.deepEqual(clampRemoteVerifyTimeout(1), { seconds: 1, clamped: false });
	assert.deepEqual(clampRemoteVerifyTimeout(0), { seconds: REMOTE_EXEC_TIMEOUT_CEILING_S, clamped: false });
});

test("S3: the clamp is written into the verdict and to stderr (log header carries the host)", async (t) => {
	const h = harness();
	t.after(() => h.cleanup());
	const warnings: string[] = [];
	const original = process.stderr.write.bind(process.stderr);
	process.stderr.write = ((chunk: unknown) => {
		warnings.push(String(chunk));
		return true;
	}) as typeof process.stderr.write;
	try {
		const result = await remoteVerifyCommand({
			client: h.client,
			target: h.target,
			command: "true",
			timeoutMs: 30 * 60 * 1000,
		});
		assert.equal(result.code, 0);
		assert.match(String(result.failureDetail), /clamped to 600s/);
		assert.ok(
			warnings.some((line) => line.includes(`verify on host '${HOST}'`) && line.includes("clamped to 600s")),
			`the clamp must be announced with the host: ${warnings.join("")}`,
		);
	} finally {
		process.stderr.write = original;
	}
});
