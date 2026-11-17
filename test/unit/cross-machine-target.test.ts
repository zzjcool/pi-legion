/**
 * Cross-machine spawn — S1 target resolution and the thin transport layer
 * (`docs/contracts/cross-machine-spawn-v1.md` D1/D6/D7/D9).
 *
 * Everything here is pure logic plus a recording fake client: no socket, no
 * `hc`, no second machine. What is pinned:
 *
 *   D1  a host with no usable `subagents.crossMachine` entry is REFUSED, with a
 *       message that names the host, the setting and the value to write —
 *       never silently downgraded to a local launch;
 *   D6  the remote temp dir is a posix path under the target's cwd, with both
 *       segments sanitized so a handle cannot climb out of it;
 *   D9  a file over `file.write`'s 8 MB ceiling is refused on THIS side, before
 *       any request is sent — a truncated system prompt is never an option;
 *   the preflight exit codes (11/12/13) and an unreachable core produce
 *   DIFFERENT errors, so a broken machine is not reported as a missing path.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { HcRpcError, type HcClient, type HcMethod } from "../../src/hc/client.ts";
import {
	MAX_REMOTE_FILE_BYTES,
	REMOTE_DIR_NAME,
	ensureRemoteDir,
	execResultText,
	mirrorRemoteFile,
	remoteDirFor,
	remotePreflight,
	resolveHostTarget,
	thisPackageRoot,
	type HcExecResult,
	type HostTarget,
} from "../../src/runs/remote.ts";
import { parseSubagentSettings } from "../../src/agents/settings.ts";
import { ErrorCodes, SubagentError, type SubagentsSettings } from "../../src/shared/types.ts";

// ── fixtures ───────────────────────────────────────────────────────────────

type Params = Record<string, unknown>;

interface Call {
	method: HcMethod;
	params: Params;
}

/** A protocol client that records every call and answers through handlers. */
class FakeRemoteClient implements HcClient {
	readonly calls: Call[] = [];
	private readonly handlers = new Map<string, (params: Params) => unknown>();

	on(method: HcMethod, handler: (params: Params) => unknown): this {
		this.handlers.set(method, handler);
		return this;
	}

	async start(): Promise<void> {}

	async request<T = unknown>(method: HcMethod, params: Params = {}): Promise<T> {
		this.calls.push({ method, params });
		const handler = this.handlers.get(method);
		if (!handler) throw new Error(`fake remote client: no handler for ${method}`);
		return (await handler(params)) as T;
	}

	close(): void {}

	paramsFor(method: HcMethod): Params[] {
		return this.calls.filter((call) => call.method === method).map((call) => call.params);
	}
}

function config(
	hosts: Record<string, { cwd?: string; node?: string; piCli?: string; piLegionRoot?: string; pathMap?: Record<string, string> }>,
	enabled = true,
): SubagentsSettings["crossMachine"] {
	return { enabled, hosts };
}

function target(overrides: Partial<HostTarget> = {}): HostTarget {
	// `worktreeRoot` is resolved by `resolveHostTarget` (S2: `dirname(cwd)/.pi-worktrees`).
	return { host: "vps", cwd: "/srv/app", node: "node", piCli: "pi", pathMap: [], worktreeRoot: "/srv/.pi-worktrees", ...overrides };
}

/** The package root, imported here so the fixture cannot drift from the resolver. */

function execResult(overrides: Partial<HcExecResult> = {}): HcExecResult {
	return { code: 0, ms: 3, signal: null, stdout: "", stderr: "", truncated: false, timed_out: false, ...overrides };
}

function b64(text: string): string {
	return Buffer.from(text, "utf8").toString("base64");
}

/** Catch a throw and hand the error to the assertion callback. */
function thrown(work: () => unknown): unknown {
	try {
		work();
	} catch (error) {
		return error;
	}
	return undefined;
}

// ── D1: resolveHostTarget ──────────────────────────────────────────────────

test("D1: a host without crossMachine.enabled is refused and names the setting", () => {
	for (const value of [undefined, {}, { enabled: false }, { enabled: false, hosts: { vps: { cwd: "/srv/app" } } }]) {
		const error = thrown(() => resolveHostTarget("vps", value));
		assert.ok(error instanceof SubagentError, `expected a SubagentError for ${JSON.stringify(value)}`);
		assert.equal((error as SubagentError).code, ErrorCodes.INVALID_PARAMS);
		assert.equal(
			(error as SubagentError).message,
			"host 'vps' needs subagents.crossMachine.enabled = true",
		);
	}
});

test("D1: an enabled config with no entry for the host is refused with the shape to add", () => {
	const error = thrown(() => resolveHostTarget("vps", config({ other: { cwd: "/srv/other" } })));
	assert.ok(error instanceof SubagentError);
	assert.equal((error as SubagentError).code, ErrorCodes.INVALID_PARAMS);
	assert.match((error as SubagentError).message, /host 'vps' has no entry in subagents\.crossMachine\.hosts/);
	assert.match((error as SubagentError).message, /"cwd": "\/abs\/path\/on\/vps"/);
});

test("D1: a missing or non-absolute remote cwd is refused, naming the exact key", () => {
	for (const entry of [{}, { cwd: "" }, { cwd: "srv/app" }, { cwd: "./app" }]) {
		const error = thrown(() => resolveHostTarget("vps", config({ vps: entry })));
		assert.ok(error instanceof SubagentError, `expected a SubagentError for ${JSON.stringify(entry)}`);
		assert.equal((error as SubagentError).code, ErrorCodes.INVALID_PARAMS);
		assert.equal(
			(error as SubagentError).message,
			"host 'vps' needs an absolute cwd in subagents.crossMachine.hosts.vps.cwd (remote paths are not translated from this machine)",
		);
	}
});

test("D1: a valid entry resolves remote cwd/node/piCli, defaulting the two programs", () => {
	// `pathMap` always carries this package's own root: every child's argv names
	// that extension entry, so the launch has to know where it lives over there.
	// With no `piLegionRoot` configured the default is the SAME path (both machines
	// provisioned alike), which is an identity entry, not a guess.
	const packageRoot = { from: thisPackageRoot(), to: thisPackageRoot() };
	assert.deepEqual(resolveHostTarget("vps", config({ vps: { cwd: "/srv/app" } })), {
		host: "vps",
		cwd: "/srv/app",
		node: "node",
		piCli: "pi",
		pathMap: [packageRoot],
		// S2: remote trees live BESIDE the checkout (contract D11).
		worktreeRoot: "/srv/.pi-worktrees",
	});
	assert.deepEqual(
		resolveHostTarget("vps", config({ vps: { cwd: "/srv/app", node: "/opt/node/bin/node", piCli: "/opt/pi/bin/pi" } })),
		{ host: "vps", cwd: "/srv/app", node: "/opt/node/bin/node", piCli: "/opt/pi/bin/pi", pathMap: [packageRoot], worktreeRoot: "/srv/.pi-worktrees" },
	);
	// An explicit mapping of the package root wins over `piLegionRoot`.
	assert.deepEqual(
		resolveHostTarget("vps", config({
			vps: { cwd: "/srv/app", piLegionRoot: "/srv/legion", pathMap: { [thisPackageRoot()]: "/srv/explicit" } },
		})).pathMap,
		[{ from: thisPackageRoot(), to: "/srv/explicit" }],
	);
	assert.deepEqual(
		resolveHostTarget("vps", config({ vps: { cwd: "/srv/app", piLegionRoot: "/srv/legion" } })).pathMap,
		[{ from: thisPackageRoot(), to: "/srv/legion" }],
	);
	// The host name is trimmed like every other host read (one predicate).
	assert.equal(resolveHostTarget("  vps  ", config({ vps: { cwd: "/srv/app" } })).host, "vps");
});

// ── D9: remoteDirFor ───────────────────────────────────────────────────────

test("D9: the remote dir is a posix path under the target cwd, with sanitized segments", () => {
	const t = target({ cwd: "/srv/app" });
	assert.equal(
		remoteDirFor(t, "run-abc123", "root.centurion-0"),
		`/srv/app/${REMOTE_DIR_NAME}/run-abc123/root.centurion-0`,
	);
	// Both segments are operator/caller input: a slash must not create a new
	// level, and `..` must not climb out of the remote dir.
	assert.equal(
		remoteDirFor(t, "../../etc", "a/b/../c d"),
		`/srv/app/${REMOTE_DIR_NAME}/..-..-etc/a-b-..-c-d`,
	);
	assert.equal(remoteDirFor(t, undefined, ".."), `/srv/app/${REMOTE_DIR_NAME}/no-run/child`);
	assert.equal(remoteDirFor(target({ cwd: "/srv/app/" }), "r1", "x"), `/srv/app/${REMOTE_DIR_NAME}/r1/x`);
});

// ── D9: execResultText ─────────────────────────────────────────────────────

test("D9: execResultText decodes BASE64 stdout and stderr into utf8", () => {
	assert.equal(execResultText(execResult({ stdout: b64("hello\n"), stderr: b64("boom\n") })), "hello\nboom");
	assert.equal(execResultText(execResult({ stdout: b64("only stdout") })), "only stdout");
	assert.equal(execResultText(execResult()), "");
	assert.equal(execResultText(undefined), "");
	// Not plaintext: the wire value is base64 and decoding it is the whole point.
	assert.equal(execResultText({ stdout: b64("café") }), "café");
});

// ── D9: mirrorRemoteFile ───────────────────────────────────────────────────

test("D9: a local file over the 8 MB ceiling is refused BEFORE any request is sent", async () => {
	const root = mkdtempSync(path.join(tmpdir(), "cross-machine-target-"));
	try {
		const local = path.join(root, "huge.md");
		// One byte over the ceiling: the check is `>`, not `>=`.
		writeFileSync(local, Buffer.alloc(MAX_REMOTE_FILE_BYTES + 1, 0x61));
		const client = new FakeRemoteClient();
		const error = await mirrorRemoteFile(client, target(), local, "/srv/app/x/huge.md").then(
			() => undefined,
			(thrownError: unknown) => thrownError,
		);
		assert.ok(error instanceof SubagentError);
		assert.equal((error as SubagentError).code, ErrorCodes.INVALID_PARAMS);
		const message = (error as SubagentError).message;
		assert.match(message, /vps/);
		assert.match(message, new RegExp(String(MAX_REMOTE_FILE_BYTES + 1)));
		assert.match(message, new RegExp(String(MAX_REMOTE_FILE_BYTES)));
		assert.match(message, /truncated/);
		// The whole point: nothing was sent, so nothing could be truncated remotely.
		assert.deepEqual(client.paramsFor("file.write"), []);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("D9: a file at the ceiling is written as BASE64 under the target's `on`", async () => {
	const root = mkdtempSync(path.join(tmpdir(), "cross-machine-target-"));
	try {
		const local = path.join(root, "system-prompt.md");
		writeFileSync(local, "You are a test centurion.\n");
		const client = new FakeRemoteClient();
		client.on("file.write", (params) => ({ path: params.path, bytes: 0 }));
		const bytes = await mirrorRemoteFile(client, target(), local, "/srv/app/x/system-prompt.md");
		assert.equal(bytes, Buffer.byteLength("You are a test centurion.\n"));
		const [params] = client.paramsFor("file.write");
		assert.ok(params);
		assert.equal(params.on, "vps");
		assert.equal(params.path, "/srv/app/x/system-prompt.md");
		assert.equal(Buffer.from(String(params.data), "base64").toString("utf8"), "You are a test centurion.\n");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("D9: a core-side too_large is re-thrown as START_FAILED with the core's wording kept", async () => {
	const root = mkdtempSync(path.join(tmpdir(), "cross-machine-target-"));
	try {
		const local = path.join(root, "system-prompt.md");
		writeFileSync(local, "small on this side\n");
		const client = new FakeRemoteClient();
		client.on("file.write", () => {
			throw new HcRpcError({ code: -32000, message: "refusing to write 9000000 bytes: over the 8388608 limit", data: { kind: "too_large" } });
		});
		const error = await mirrorRemoteFile(client, target(), local, "/srv/app/x/system-prompt.md").then(
			() => undefined,
			(thrownError: unknown) => thrownError,
		);
		assert.ok(error instanceof SubagentError);
		assert.equal((error as SubagentError).code, ErrorCodes.START_FAILED);
		const message = (error as SubagentError).message;
		assert.match(message, /host 'vps'/);
		assert.match(message, /too_large/);
		assert.match(message, /9000000 bytes/);
		// The request WAS attempted — the refusal came from the core, not from us.
		assert.equal(client.paramsFor("file.write").length, 1);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

// ── D6/D9: preflight classification ────────────────────────────────────────

test("D6: preflight runs one machine.exec `line` on the target, quoting every value", async () => {
	const client = new FakeRemoteClient();
	client.on("machine.exec", () => execResult());
	await remotePreflight(client, target({ cwd: "/srv/app dir" }));
	const [params] = client.paramsFor("machine.exec");
	assert.ok(params);
	assert.equal(params.on, "vps");
	assert.equal(typeof params.line, "string");
	assert.equal("argv" in params, false);
	assert.match(String(params.line), /cd -- '\/srv\/app dir'/);
	assert.match(String(params.line), /command -v 'node'/);
	assert.match(String(params.line), /command -v 'pi'/);
});

test("D6: exit 11/12/13 name the cwd, the node and the pi CLI respectively", async () => {
	const cases: Array<{ code: number; pattern: RegExp }> = [
		{ code: 11, pattern: /cwd '\/srv\/app' does not exist on vps/ },
		{ code: 12, pattern: /node 'node' is not on PATH on vps/ },
		{ code: 13, pattern: /pi CLI 'pi' is not on PATH on vps/ },
	];
	for (const item of cases) {
		const client = new FakeRemoteClient();
		client.on("machine.exec", () => execResult({ code: item.code, stderr: b64("from the shell") }));
		const error = await remotePreflight(client, target()).then(
			() => undefined,
			(thrownError: unknown) => thrownError,
		);
		assert.ok(error instanceof SubagentError, `exit ${item.code} must throw`);
		assert.equal((error as SubagentError).code, ErrorCodes.START_FAILED);
		assert.match((error as SubagentError).message, item.pattern);
	}
});

test("D6: an unreachable core is reported as such, never as a missing cwd", async () => {
	const client = new FakeRemoteClient();
	client.on("machine.exec", () => {
		throw new HcRpcError({ code: -32000, message: "unknown machine: vps", data: { kind: "machine_unknown" } });
	});
	const error = await remotePreflight(client, target()).then(
		() => undefined,
		(thrownError: unknown) => thrownError,
	);
	assert.ok(error instanceof SubagentError);
	assert.equal((error as SubagentError).code, ErrorCodes.START_FAILED);
	assert.match((error as SubagentError).message, /host 'vps' unreachable: machine_unknown: unknown machine: vps/);
	assert.doesNotMatch((error as SubagentError).message, /does not exist/);
});

test("D6: a timed-out or exit-code-less preflight is `unreachable`, not a path problem", async () => {
	for (const result of [execResult({ code: null, timed_out: true }), execResult({ code: undefined })]) {
		const client = new FakeRemoteClient();
		client.on("machine.exec", () => result);
		const error = await remotePreflight(client, target()).then(
			() => undefined,
			(thrownError: unknown) => thrownError,
		);
		assert.ok(error instanceof SubagentError);
		assert.equal((error as SubagentError).code, ErrorCodes.START_FAILED);
		assert.match((error as SubagentError).message, /host 'vps' unreachable:/);
		assert.doesNotMatch((error as SubagentError).message, /does not exist/);
	}
});

// ── D9: ensureRemoteDir ────────────────────────────────────────────────────

test("D9: ensureRemoteDir is one `mkdir -p <dir>` argv call on the target", async () => {
	const client = new FakeRemoteClient();
	client.on("machine.exec", () => execResult());
	await ensureRemoteDir(client, target(), "/srv/app/.pi-subagents-remote/r1/x");
	const [params] = client.paramsFor("machine.exec");
	assert.ok(params);
	assert.equal(params.on, "vps");
	assert.deepEqual(params.argv, ["mkdir", "-p", "/srv/app/.pi-subagents-remote/r1/x"]);

	// A non-zero exit is a START_FAILED naming the dir and the core's stderr.
	const failing = new FakeRemoteClient();
	failing.on("machine.exec", () => execResult({ code: 1, stderr: b64("mkdir: permission denied") }));
	const error = await ensureRemoteDir(failing, target(), "/srv/locked/x").then(
		() => undefined,
		(thrownError: unknown) => thrownError,
	);
	assert.ok(error instanceof SubagentError);
	assert.equal((error as SubagentError).code, ErrorCodes.START_FAILED);
	assert.match((error as SubagentError).message, /\/srv\/locked\/x/);
	assert.match((error as SubagentError).message, /permission denied/);
});

// ── S1: the settings block is actually parsed (whitelist) ──────────────────

test("S1: subagents.crossMachine survives parseSubagentSettings instead of being dropped", () => {
	const parsed = parseSubagentSettings(
		{
			subagents: {
				crossMachine: {
					enabled: true,
					hosts: {
						vps: { cwd: "/srv/app", node: "/opt/node/bin/node", piCli: "pi" },
						// A relative cwd is KEPT: the useful refusal names the value the
						// operator typed, at the launch that needs it (see
						// `parseCrossMachine`'s comment).
						broken: { cwd: "srv/app" },
					},
				},
			},
		},
		"/tmp/settings.json",
	);
	assert.deepEqual(parsed.crossMachine, {
		enabled: true,
		hosts: {
			vps: { cwd: "/srv/app", node: "/opt/node/bin/node", piCli: "pi" },
			broken: { cwd: "srv/app" },
		},
	});
	// And the kept-but-relative entry refuses at use time, naming the key.
	const error = thrown(() => resolveHostTarget("broken", parsed.crossMachine));
	assert.ok(error instanceof SubagentError);
	assert.match((error as SubagentError).message, /crossMachine\.hosts\.broken\.cwd/);
});

test("S1: a malformed crossMachine block is rejected at load, a missing one is simply absent", () => {
	assert.equal(parseSubagentSettings({ subagents: {} }, "/tmp/settings.json").crossMachine, undefined);
	for (const block of ["nope", 42, []]) {
		assert.throws(
			() => parseSubagentSettings({ subagents: { crossMachine: block } }, "/tmp/settings.json"),
			/invalid 'crossMachine'/,
		);
	}
	assert.throws(
		() => parseSubagentSettings({ subagents: { crossMachine: { enabled: "yes" } } }, "/tmp/settings.json"),
		/crossMachine\.enabled/,
	);
	assert.throws(
		() => parseSubagentSettings({ subagents: { crossMachine: { hosts: [] } } }, "/tmp/settings.json"),
		/crossMachine\.hosts/,
	);
	assert.throws(
		() => parseSubagentSettings({ subagents: { crossMachine: { hosts: { "  ": { cwd: "/srv" } } } } }, "/tmp/settings.json"),
		/host name must be a non-empty string/,
	);
	assert.throws(
		() => parseSubagentSettings({ subagents: { crossMachine: { hosts: { vps: "nope" } } } }, "/tmp/settings.json"),
		/crossMachine\.hosts\.vps/,
	);
	assert.throws(
		() => parseSubagentSettings({ subagents: { crossMachine: { hosts: { vps: { cwd: 42 } } } } }, "/tmp/settings.json"),
		/crossMachine\.hosts\.vps\.cwd/,
	);
});
