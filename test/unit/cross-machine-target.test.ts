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
	ensureRemoteDir,
	execResultText,
	mirrorRemoteFile,
	remoteDirFor,
	basenameCollisions,
	remotePreflight,
	remotePreflightScript,
	resolveHostTarget,
	thisPackageRoot,
	type HcExecResult,
	type HostTarget,
} from "../../src/runs/remote.ts";
import { parseSubagentSettings, resolveSubagentSettings } from "../../src/agents/settings.ts";
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
	return { host: "vps", cwd: "/srv/app", node: "node", piCli: "pi", pathMap: [], piLegionRoot: "/srv/pi-legion", mirrorRoot: "/srv/.pi-subagents-mirror", worktreeRoot: "/srv/.pi-worktrees", ...overrides };
}

/** The package root, imported here so the fixture cannot drift from the resolver. */

/**
 * Answer the preflight's two questions differently: the `test -d` probe says the
 * checkout exists (unless `probe` overrides), the script call returns `answer`.
 */
function preflightClient(answer: () => HcExecResult, probe: () => HcExecResult = () => execResult({ code: 0 })): FakeRemoteClient {
	const client = new FakeRemoteClient();
	client.on("machine.exec", (params) => (Array.isArray(params.argv) ? probe() : answer()));
	return client;
}

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
		// review M2: the package root is also what the preflight checks over there.
		piLegionRoot: thisPackageRoot(),
		mirrorRoot: "/srv/.pi-subagents-mirror",
		// S2: remote trees live BESIDE the checkout (contract D11).
		worktreeRoot: "/srv/.pi-worktrees",
	});
	assert.deepEqual(
		resolveHostTarget("vps", config({ vps: { cwd: "/srv/app", node: "/opt/node/bin/node", piCli: "/opt/pi/bin/pi" } })),
		{ host: "vps", cwd: "/srv/app", node: "/opt/node/bin/node", piCli: "/opt/pi/bin/pi", pathMap: [packageRoot], piLegionRoot: thisPackageRoot(), mirrorRoot: "/srv/.pi-subagents-mirror", worktreeRoot: "/srv/.pi-worktrees" },
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

test("D9: the remote dir is a posix path BESIDE the checkout, with sanitized segments", () => {
	const t = target({ cwd: "/srv/app" });
	assert.equal(
		remoteDirFor(t, "run-abc123", "root.centurion-0"),
		"/srv/.pi-subagents-mirror/run-abc123/root.centurion-0",
	);
	// Review M4: the mirrored files must never be inside the tree the child
	// delivers from — a `git add -A` there would commit the system prompt and the
	// session transcript into the branch the parent fetches.
	const relative = path.posix.relative(t.cwd, remoteDirFor(t, "r", "x"));
	assert.ok(relative.startsWith(".."), `the mirror must be outside the checkout, got ${relative}`);
	// Both segments are operator/caller input: a slash must not create a new
	// level, and `..` must not climb out of the remote dir.
	assert.equal(
		remoteDirFor(t, "../../etc", "a/b/../c d"),
		"/srv/.pi-subagents-mirror/..-..-etc/a-b-..-c-d",
	);
	assert.equal(remoteDirFor(t, undefined, ".."), "/srv/.pi-subagents-mirror/no-run/child");
	assert.equal(remoteDirFor(target({ cwd: "/srv/app/" }), "r1", "x"), "/srv/.pi-subagents-mirror/r1/x");
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

test("D6: preflight asks the checkout question explicitly, then runs one `line` quoting every value", async () => {
	const client = preflightClient(() => execResult());
	await remotePreflight(client, target({ cwd: "/srv/app dir" }));
	const [probe, script] = client.paramsFor("machine.exec");
	// Spike constraint 4: `test -d` first, in the core's own directory, so a missing
	// checkout is a message rather than an unattributable chdir failure.
	assert.deepEqual(probe?.argv, ["test", "-d", "/srv/app dir"]);
	assert.equal("cwd" in (probe ?? {}), false);
	assert.ok(script);
	assert.equal(script.on, "vps");
	assert.equal(typeof script.line, "string");
	assert.equal("argv" in script, false);
	assert.equal(script.cwd, "/srv/app dir", "the script runs IN the checkout, so the core validates it");
	assert.match(String(script.line), /cd -- '\/srv\/app dir'/);
	assert.match(String(script.line), /command -v 'node'/);
	assert.match(String(script.line), /command -v 'pi'/);
	assert.equal(client.paramsFor("machine.exec").length, 2, "exactly two questions");
});

test("D6: exit 11/12/13 name the cwd, the node and the pi CLI respectively", async () => {
	const cases: Array<{ code: number; pattern: RegExp }> = [
		{ code: 11, pattern: /cwd '\/srv\/app' does not exist on vps/ },
		{ code: 12, pattern: /node 'node' is not on PATH on vps/ },
		{ code: 13, pattern: /pi CLI 'pi' is not on PATH on vps/ },
	];
	for (const item of cases) {
		const client = preflightClient(() => execResult({ code: item.code, stderr: b64("from the shell") }));
		const error = await remotePreflight(client, target()).then(
			() => undefined,
			(thrownError: unknown) => thrownError,
		);
		assert.ok(error instanceof SubagentError, `exit ${item.code} must throw`);
		assert.equal((error as SubagentError).code, ErrorCodes.START_FAILED);
		assert.match((error as SubagentError).message, item.pattern);
	}

	// Review M2: exit 14 is the package entry itself — the one absolute path every
	// child's argv carries. Missing it means `pi` either fails to start or (worse)
	// starts without the guard extension, so it is a named refusal, not a guess.
	const missingPackage = preflightClient(() => execResult({ code: 14 }));
	const error = await remotePreflight(missingPackage, target()).then(
		() => undefined,
		(thrownError: unknown) => thrownError,
	);
	assert.ok(error instanceof SubagentError);
	assert.equal((error as SubagentError).code, ErrorCodes.INVALID_PARAMS);
	assert.match((error as SubagentError).message, /this package is not installed at \/srv\/pi-legion on that machine/);
	assert.match((error as SubagentError).message, /piLegionRoot/);

	// And the script really asks: one `test -f` on `<piLegionRoot>/index.ts`.
	assert.match(remotePreflightScript(target()), /test -f '\/srv\/pi-legion\/index\.ts' \|\| exit 14/);
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
	// Review M6 changed the CLASS: an unknown machine name is an input error, not a
	// connectivity problem, and it must not enter the per-model retry chain.
	assert.equal((error as SubagentError).code, ErrorCodes.INVALID_PARAMS);
	assert.match((error as SubagentError).message, /host 'vps' is not a machine this core knows/);
	assert.match((error as SubagentError).message, /machine_unknown: unknown machine: vps/);
	assert.doesNotMatch((error as SubagentError).message, /does not exist/);
	assert.doesNotMatch((error as SubagentError).message, /unreachable/);
});

test("D6: a timed-out or exit-code-less preflight is `unreachable`, not a path problem", async () => {
	for (const result of [execResult({ code: null, timed_out: true }), execResult({ code: undefined })]) {
		const client = preflightClient(() => result);
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

test("B2: a PROJECT-level crossMachine block survives the merge (host config is project-shaped)", () => {
	// `resolveSubagentSettings` is a whitelist. Before this, a project that
	// configured `subagents.crossMachine` had it silently dropped — and the host
	// table is exactly the setting that belongs in a project (its `cwd` is a path
	// on another machine for THIS repository).
	const project = parseSubagentSettings({
		subagents: { crossMachine: { enabled: true, hosts: { vps: { cwd: "/srv/app", piCli: "/opt/pi/bin/pi" } } } },
	}, "/proj/.pi/settings.json");
	const merged = resolveSubagentSettings(parseSubagentSettings({}, "/user/settings.json"), project);
	assert.deepEqual(merged.crossMachine, { enabled: true, hosts: { vps: { cwd: "/srv/app", piCli: "/opt/pi/bin/pi" } } });

	// A user-level block still comes through when the project says nothing.
	const user = parseSubagentSettings({
		subagents: { crossMachine: { enabled: true, hosts: { a: { cwd: "/a" } } } },
	}, "/user/settings.json");
	assert.deepEqual(resolveSubagentSettings(user, parseSubagentSettings({}, "/p.json")).crossMachine, user.crossMachine);

	// Project wins wholesale: no half-merged host table can pair a user `enabled`
	// with a project's host entry by accident.
	const overridden = resolveSubagentSettings(user, parseSubagentSettings({
		subagents: { crossMachine: { enabled: false } },
	}, "/p.json"));
	assert.deepEqual(overridden.crossMachine, { enabled: false });
});

test("M6: the core's own failure kinds are classified, not folded into `unreachable`", async () => {
	// `machine_unknown` used to read as a network problem ("host 'vps' unreachable:
	// machine_unknown: …"), sending the operator to look at connectivity for a
	// misspelled machine name. It is an input error and must say so.
	const unknown = new FakeRemoteClient();
	unknown.on("machine.exec", () => {
		throw new HcRpcError({ code: -32602, message: "unknown machine: vps", data: { kind: "machine_unknown" } });
	});
	const unknownError = await remotePreflight(unknown, target()).then(() => undefined, (error: unknown) => error);
	assert.ok(unknownError instanceof SubagentError);
	assert.equal((unknownError as SubagentError).code, ErrorCodes.INVALID_PARAMS);
	assert.match((unknownError as SubagentError).message, /is not a machine this core knows/);
	assert.doesNotMatch((unknownError as SubagentError).message, /unreachable/);

	// A core that rejects the `cwd` (the path exists here, not there) keeps the cwd
	// wording instead of becoming "unreachable" too.
	const badCwd = preflightClient(() => {
		throw new HcRpcError({ code: -32602, message: "no such directory", data: { kind: "bad_cwd" } });
	});
	const cwdError = await remotePreflight(badCwd, target()).then(() => undefined, (error: unknown) => error);
	assert.ok(cwdError instanceof SubagentError);
	assert.match((cwdError as SubagentError).message, /cwd '\/srv\/app' does not exist on vps/);

	// Everything else stays `unreachable` — but carries the no-fallback marker, so a
	// host launch never re-runs remote setup once per model candidate.
	const transport = preflightClient(() => {
		throw new Error("socket closed");
	});
	const transportError = await remotePreflight(transport, target()).then(() => undefined, (error: unknown) => error);
	assert.ok(transportError instanceof SubagentError);
	assert.match((transportError as SubagentError).message, /unreachable: socket closed/);
	assert.deepEqual((transportError as SubagentError).details as Record<string, unknown>, { host: "vps", noModelFallback: true });
});

test("M2/D6: the preflight asks about the checkout explicitly and sends no `cwd`", async () => {
	// A core asked to run with a missing cwd cannot tell that from a missing program
	// (spike constraint 4), so the checkout is TESTED in the script and the exec
	// itself runs in the core's own default directory.
	const client = preflightClient(() => execResult({ code: 0 }));
	await remotePreflight(client, target());
	const [probe, script] = client.paramsFor("machine.exec");
	assert.equal("cwd" in (probe ?? {}), false, "the directory question must not chdir first");
	assert.deepEqual(probe?.argv, ["test", "-d", "/srv/app"]);
	assert.equal(script?.cwd, "/srv/app", "the paths are validated by the machine that owns them");
});

test("m3/D7: the preflight refuses a remote core that already carries legion identity", async () => {
	// `terminal.run`'s env is a merge-only overlay, so identity keys cannot be
	// DELETED there — only not sent. A core that already has them would make the
	// child join a ledger it cannot open, which is why the launch is refused.
	const script = remotePreflightScript(target());
	assert.match(script, /PI_LEGION_DB/);
	assert.match(script, /PI_LEGION_NODE_ID/);
	assert.match(script, /exit 15/);

	const client = preflightClient(() => execResult({ code: 15 }));
	const error = await remotePreflight(client, target()).then(() => undefined, (thrown: unknown) => thrown);
	assert.ok(error instanceof SubagentError);
	assert.equal((error as SubagentError).code, ErrorCodes.INVALID_PARAMS);
	assert.match((error as SubagentError).message, /already carries legion identity/);
	assert.match((error as SubagentError).message, /D7/);
});

test("S3/6: the preflight is bounded at ten seconds, so an unusable remote exec fails fast", async () => {
	// Requirement: a machine that cannot answer the preflight must fail in ~10s with
	// a name, not hang a launch for minutes. Both preflight calls carry that bound.
	const client = preflightClient(() => execResult({ code: 0 }));
	await remotePreflight(client, target());
	const [probe, script] = client.paramsFor("machine.exec");
	assert.equal(probe?.timeout, 10);
	assert.equal(script?.timeout, 10);

	// A core that reports the deadline is named as such, with the bound in the text.
	const timedOut = preflightClient(() => execResult({ code: null, timed_out: true }));
	const error = await remotePreflight(timedOut, target()).then(() => undefined, (thrown: unknown) => thrown);
	assert.ok(error instanceof SubagentError);
	assert.match((error as SubagentError).message, /preflight did not finish within 10s/);
});

test("m11: two local files with one basename are refused, never silently overwritten", () => {
	// The remote dir is flat: `a/system-prompt.md` and `b/system-prompt.md` would both
	// become `<remoteDir>/system-prompt.md`, and the child would read one file where
	// two were written.
	assert.deepEqual(basenameCollisions(["/tmp/a/system-prompt.md", "/tmp/b/system-prompt.md"]), ["system-prompt.md"]);
	// The same path twice is the SAME file, not a collision (idempotent rewrites).
	assert.deepEqual(basenameCollisions(["/tmp/a/system-prompt.md", "/tmp/a/system-prompt.md"]), []);
	assert.deepEqual(basenameCollisions(["/tmp/a/system-prompt.md", "/tmp/b/task.md"]), []);
	assert.deepEqual(basenameCollisions([]), []);
});

test("S5/D6: preflight refuses a piCli that node cannot execute (a shell launcher)", async () => {
	// The release ships `/root/.pi/agent/bin/pi` as a shell launcher. Every child's
	// argv is `[node, piCli, …]`, so that path makes node parse `case "$0" in` as
	// JavaScript; the real run saw `SyntaxError: Unexpected token case` many layers
	// below the launch. The preflight asks `<node> <piCli> --version` instead.
	const launcher = "/root/.pi/agent/bin/pi";
	const script = remotePreflightScript({ ...target(), piCli: launcher });
	assert.match(script, new RegExp(`'node' '${launcher.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}' --version`));
	// An ABSOLUTE piCli is judged (fatal); a bare name is only advised, because
	// `command -v` already proved it resolves and the script cannot see its shape.
	assert.match(script, /exit 16/);
	assert.match(remotePreflightScript({ ...target(), piCli: "pi" }), /did not answer/);
	assert.doesNotMatch(remotePreflightScript({ ...target(), piCli: "pi" }), /exit 16/);

	const client = preflightClient(() => execResult({ code: 16 }));
	const error = await remotePreflight(client, { ...target(), piCli: launcher }).then(() => undefined, (thrown: unknown) => thrown);
	assert.ok(error instanceof SubagentError);
	assert.equal((error as SubagentError).code, ErrorCodes.INVALID_PARAMS);
	assert.match((error as SubagentError).message, /not a JavaScript entry point node can execute/);
	// The message must name the shape to use, not just the thing that is wrong.
	assert.match((error as SubagentError).message, /bundle\/cli\.js/);
	assert.match((error as SubagentError).message, /Unexpected token case/);
});
