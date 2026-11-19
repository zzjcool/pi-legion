/**
 * D3: `{"subagents":{"crossMachine":{"enabled":true}}}` is a COMPLETE
 * configuration — "zero configuration except the directory".
 *
 * End to end through the real `HcCliClient` and the fake `hc` core
 * (`test/helpers/fake-hc-core.mjs`), with a real temp tree standing for the
 * other machine, because the claim under test is not "the resolver accepts an
 * empty object" (that would be a unit test of `??=`) but "a launch works with a
 * settings file that names nothing about the host":
 *
 *   - admission comes from `hc machine ls` (one round trip, already there);
 *   - `node`, `piCli`, this package and the provider extensions come from the
 *     discovery probe;
 *   - `cwd` is the ONE input the call must name, and when it does not the
 *     resolver asks the D2 question with ZERO `machine.exec` — no probe, no
 *     `test -d`, no `--list-models`, and never a guessed directory.
 *
 * The harness is the same shape `fake-core-host-discovery.test.ts` builds (its
 * `harness` is file-local, and importing a test file would register its cases
 * here), trimmed to the single project this file needs.
 */

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { HcCliClient, type HcClient, type HcMethod } from "../../src/hc/client.ts";
import { clearHostDiscoveryCache, missingRemoteCwdQuestion, resolveHostTargetAsync, type HostTarget } from "../../src/runs/remote.ts";
import { TerminalSupervisor } from "../../src/supervisor/terminal-supervisor.ts";
import { SubagentError, type AgentConfig } from "../../src/shared/types.ts";
import type { SpawnInput } from "../../src/supervisor/types.ts";

// Hermetic: an inherited extension is an absolute path from THIS machine, and a
// remote launch refuses an argv path it cannot map.
process.env.PI_LEGION_CHILD_INHERIT_EXTENSIONS = "0";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../..");
const FAKE_CORE = path.join(REPO_ROOT, "test/helpers/fake-hc-core.mjs");
const HOST = "fakebox";
const TERMINAL_ID = "t1k";
const SOCKET = "/tmp/hc-fake-minimal-config/default.sock";
const MODEL = "workbuddy/deepseek-v4.1-flash";

interface WireRequest {
	jsonrpc?: string;
	id?: number;
	method?: string;
	params?: Record<string, unknown>;
}

interface Harness {
	root: string;
	remoteRoot: string;
	remoteCwd: string;
	realNode: string;
	nodeShim: string;
	piEntry: string;
	legionRoot: string;
	client: HcClient;
	supervisor: TerminalSupervisor;
	spawnRoot: string;
	wire(): WireRequest[];
	wireFor(method: HcMethod): Record<string, unknown>[];
	cleanup(): void;
}

const LIVE: Harness[] = [];

/** One copy of this interpreter, hard-linked into every fake remote root. */
let NODE_COPY: string | undefined;
function nodeCopy(): string {
	if (NODE_COPY !== undefined) return NODE_COPY;
	const dir = mkdtempSync(path.join(tmpdir(), "legion-minimal-node-"));
	const copy = path.join(dir, "node");
	copyFileSync(process.execPath, copy);
	chmodSync(copy, 0o755);
	NODE_COPY = copy;
	return copy;
}

/**
 * Lay out a machine that is NOT this one: its own home, its own pi install, a
 * `node` that really lives there but is reachable only through a mise-style
 * shim, and one project directory.
 */
function harness(t: { after: (fn: () => void) => void }): Harness {
	const root = mkdtempSync(path.join(tmpdir(), "legion-minimal-config-"));
	const remoteRoot = path.join(root, "remote");
	const home = path.join(remoteRoot, "home");
	const bin = path.join(remoteRoot, "bin");
	const remoteCwd = path.join(remoteRoot, "proj");
	const spawnRoot = path.join(root, "spawn");
	for (const dir of [home, bin, remoteCwd, spawnRoot]) mkdirSync(dir, { recursive: true });

	const realNodeDir = path.join(remoteRoot, "opt", "node", "bin");
	mkdirSync(realNodeDir, { recursive: true });
	const realNode = path.join(realNodeDir, "node");
	try {
		linkSync(nodeCopy(), realNode);
	} catch {
		copyFileSync(nodeCopy(), realNode);
	}
	chmodSync(realNode, 0o755);
	const nodeShim = path.join(bin, "node");
	writeFileSync(nodeShim, `#!/bin/sh\nexec ${JSON.stringify(realNode)} "$@"\n`, { mode: 0o755 });
	chmodSync(nodeShim, 0o755);

	// The managed pi install the launcher resolves to (same shape as the real one).
	const agent = path.join(home, ".pi", "agent");
	const launcher = path.join(agent, "bin", "pi");
	mkdirSync(path.dirname(launcher), { recursive: true });
	writeFileSync(
		launcher,
		`#!/bin/sh
pi_release_bin="$PI_HOME_DIR/install/releases/$(cat "$PI_HOME_DIR/install/current-version")/node_modules/.bin/pi"
exec "$pi_release_bin" "$@"
`.replaceAll("$PI_HOME_DIR", agent),
		{ mode: 0o755 },
	);
	const release = path.join(agent, "install", "releases", "9.9.9", "node_modules");
	mkdirSync(path.join(release, ".bin"), { recursive: true });
	mkdirSync(path.join(agent, "install"), { recursive: true });
	writeFileSync(path.join(agent, "install", "current-version"), "9.9.9\n");
	const piEntry = path.join(release, "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js");
	mkdirSync(path.dirname(piEntry), { recursive: true });
	writeFileSync(
		piEntry,
		`#!/usr/bin/env node
if (process.argv.includes("--version")) process.stdout.write("9.9.9\\n");
else if (process.argv.includes("--list-models")) {
	process.stdout.write("provider      model                          context  max-out  thinking  images\\n");
	process.stdout.write("any-endpoint  ${MODEL}   128k     8k       yes       no\\n");
} else process.stdout.write("ok\\n");
`,
		{ mode: 0o755 },
	);
	symlinkSync(path.posix.join("..", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js"), path.join(release, ".bin", "pi"));
	symlinkSync(launcher, path.join(bin, "pi"));

	// This package, installed on that machine.
	const npmModules = path.join(agent, "npm", "node_modules");
	const legionRoot = path.join(npmModules, "pi-legion");
	mkdirSync(legionRoot, { recursive: true });
	writeFileSync(path.join(legionRoot, "index.ts"), "// fake remote install\n");
	writeFileSync(path.join(legionRoot, "package.json"), JSON.stringify({ name: "pi-legion", version: "9.9.9" }));
	const providerExtension = path.join(npmModules, "pi-any-endpoint", "extensions", "index.ts");
	mkdirSync(path.dirname(providerExtension), { recursive: true });
	writeFileSync(providerExtension, "export function registerProvider() {}\n");
	writeFileSync(
		path.join(npmModules, "pi-any-endpoint", "package.json"),
		JSON.stringify({ name: "pi-any-endpoint", keywords: ["provider"], pi: { extensions: ["./extensions/index.ts"] } }),
	);

	const hcWrapperDir = path.join(root, "hc-bin");
	mkdirSync(hcWrapperDir, { recursive: true });
	const wrapper = path.join(hcWrapperDir, "hc");
	writeFileSync(wrapper, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(FAKE_CORE)} "$@"\n`, { mode: 0o755 });
	chmodSync(wrapper, 0o755);
	const wirePath = path.join(root, "wire.jsonl");

	const env: NodeJS.ProcessEnv = {
		...process.env,
		HC_BIN: wrapper,
		HC_TERMINAL_SOCKET: SOCKET,
		HC_TERMINAL_ID: TERMINAL_ID,
		FAKE_HC_REMOTE_ROOT: remoteRoot,
		FAKE_HC_MACHINES: HOST,
		FAKE_HC_REMOTE_PATH: `${bin}:/usr/bin:/bin`,
		FAKE_HC_REMOTE_HOME: home,
		FAKE_HC_LOG: wirePath,
	};
	const real = new HcCliClient({ env, requestTimeoutMs: 20_000 });
	const client: HcClient = {
		start: () => real.start(),
		close: () => real.close(),
		request: async <T = unknown>(method: HcMethod, params: Record<string, unknown> = {}): Promise<T> =>
			(await real.request<T>(method, params)) as T,
	};
	// #423: same reason as `fake-core-host-discovery` — the fake core's child never
	// writes a transcript, and these cases are about a `{ enabled: true }` config
	// resolving at all, not about the start-up gate.
	const supervisor = new TerminalSupervisor({ clientFactory: () => client, env, runId: "run-minimal-1", pollIntervalMs: 5, remoteStartupConfirmMs: 0 });
	const wire = (): WireRequest[] => {
		if (!existsSync(wirePath)) return [];
		return readFileSync(wirePath, "utf8")
			.split("\n")
			.filter((line) => line.trim().length > 0)
			.map((line) => JSON.parse(line) as WireRequest);
	};
	const h: Harness = {
		root,
		remoteRoot,
		remoteCwd,
		realNode,
		nodeShim,
		piEntry,
		legionRoot,
		client,
		supervisor,
		spawnRoot,
		wire,
		wireFor: (method) => wire().filter((request) => request.method === method).map((request) => request.params ?? {}),
		cleanup: () => {
			const index = LIVE.indexOf(h);
			if (index >= 0) LIVE.splice(index, 1);
			try {
				client.close();
			} catch {
				/* already gone */
			}
			rmSync(root, { recursive: true, force: true });
		},
	};
	LIVE.push(h);
	t.after(() => h.cleanup());
	return h;
}

after(() => {
	for (const harness of [...LIVE]) harness.cleanup();
});

function agent(): AgentConfig {
	return {
		name: "centurion",
		description: "minimal-config fixture",
		systemPromptMode: "append",
		inheritProjectContext: false,
		inheritSkills: false,
		kind: "pi",
		systemPrompt: "You are a remote test centurion.",
		source: "user",
		filePath: "/fake/centurion.md",
		worktree: true,
	};
}

async function rejected(work: () => Promise<unknown>): Promise<unknown> {
	try {
		await work();
	} catch (error) {
		return error;
	}
	throw new Error("expected the call to reject");
}

function spawnInput(h: Harness, target: HostTarget): SpawnInput {
	return {
		name: "root.centurion-0",
		task: "Implement the slice.",
		agent: agent(),
		model: MODEL,
		sessionFile: path.join(h.spawnRoot, "session.jsonl"),
		tempDir: h.spawnRoot,
		cwd: target.cwd,
		env: { PI_LEGION_DB: path.join(h.spawnRoot, "legion.db"), PI_LEGION_NODE_ID: "root.centurion-0" },
		cliPath: "/fake/pi/dist/cli.js",
		host: HOST,
		hostTarget: target,
	};
}

// ── (a) `{ enabled: true }` is a complete configuration ────────────────────

test("D3: `{ enabled: true }` with NO hosts block resolves — admission + discovery + the per-call cwd", async (t) => {
	const h = harness(t);
	clearHostDiscoveryCache();
	// Literally the v1.1 minimal settings file: no `hosts` key at all.
	const settings = { enabled: true };
	assert.equal(Object.prototype.hasOwnProperty.call(settings, "hosts"), false, "the fixture must not smuggle a hosts block in");
	const target = await resolveHostTargetAsync(HOST, settings, {
		client: h.client,
		cwd: h.remoteCwd,
		admission: "always",
		cacheDir: null,
	});
	assert.equal(target.host, HOST);
	assert.equal(target.cwd, h.remoteCwd, "the per-call cwd is the launch cwd");
	assert.equal(target.node, h.realNode, "the mise-style shim must be resolved to the real binary");
	assert.notEqual(target.node, h.nodeShim);
	assert.equal(target.piCli, h.piEntry, "the shell launcher resolves to its bundle cli.js");
	assert.equal(target.piLegionRoot, h.legionRoot);
	assert.ok(target.discovered?.includes("node"), `node must be reported as discovered: ${String(target.discovered)}`);
	assert.ok(target.discovered?.includes("piCli"), `piCli must be reported as discovered: ${String(target.discovered)}`);
	// The one input the settings did NOT have to name came from the call.
	assert.ok(h.wireFor("terminal.run").length === 0, "resolution alone starts nothing");
});

// ── (b) that target really launches ────────────────────────────────────────

test("D3: a launch built from that target reaches terminal.run with the remote node and no parent path", async (t) => {
	const h = harness(t);
	clearHostDiscoveryCache();
	const target = await resolveHostTargetAsync(HOST, { enabled: true }, {
		client: h.client,
		cwd: h.remoteCwd,
		admission: "always",
		cacheDir: null,
	});
	const handle = await h.supervisor.spawnChild(spawnInput(h, target));
	assert.ok(handle.name.length > 0);

	const run = h.wireFor("terminal.run").at(-1);
	assert.ok(run, "a terminal must be created");
	assert.equal(run.on, HOST);
	assert.equal(run.cwd, h.remoteCwd);
	const argv = run.argv as string[];
	assert.equal(argv[0], h.realNode, "argv[0] is the node ON that machine");
	assert.equal(argv[1], h.piEntry, "argv[1] is the JS entry node can execute");
	// No parent absolute path may survive the mapping (the fake core refuses them
	// anyway, so a leak would surface as a spawn failure — this makes it readable).
	for (const arg of argv) {
		if (!path.isAbsolute(arg)) continue;
		assert.ok(arg.startsWith(h.remoteRoot), `argv carries a path that is not on that machine: ${arg}`);
	}
	const serialized = JSON.stringify(run);
	assert.equal(serialized.includes(REPO_ROOT), false, "no parent checkout path may reach the wire");
	assert.equal(serialized.includes(h.spawnRoot), false, "no parent temp path may reach the wire");
});

// ── (c) the one missing input is a QUESTION, with zero probes ──────────────

test("D3: missing cwd under `{ enabled: true }` throws the D2 question and runs ZERO machine.exec", async (t) => {
	const h = harness(t);
	clearHostDiscoveryCache();
	const error = await rejected(() =>
		resolveHostTargetAsync(HOST, { enabled: true }, { client: h.client, admission: "always", cacheDir: null }),
	);
	assert.ok(error instanceof SubagentError, `expected a refusal, got ${String(error)}`);
	assert.equal(error.message, missingRemoteCwdQuestion(HOST));
	assert.deepEqual(error.details, { host: HOST, cwd: "", reason: "cwd-missing", noModelFallback: true });
	// D2's ordering, on the real wire: admission is allowed, discovery is not.
	assert.deepEqual(
		h.wire().filter((request) => request.method === "machine.exec"),
		[],
		"nothing may be probed before the directory is named",
	);
	assert.ok(
		h.wire().some((request) => request.method === "machine.list"),
		"`machine.list` is one round trip and is allowed before the question",
	);
	assert.deepEqual(h.wireFor("terminal.run"), [], "and nothing may run");
});
