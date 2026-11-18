/**
 * Cross-machine host discovery, end to end through the REAL `HcCliClient` and
 * the fake `hc` core (`test/helpers/fake-hc-core.mjs`, the oracle).
 *
 * The three questions the contract addendum v1.1 adds, asked of a fake core
 * that behaves like a real one:
 *
 *   1. admission — a host is launchable because `hc machine ls` knows it, not
 *      because `subagents.crossMachine.hosts` repeats its paths. A name that is
 *      NOT registered is refused with the names that are (and the
 *      `hc machine add` line), never with "machine_unknown" and never by running
 *      the child here.
 *   2. discovery — a host entry may be `{}`: one `machine.exec` probe finds the
 *      real node (not the mise shim), the JavaScript entry behind the `pi`
 *      launcher, this package, and the provider extension.
 *   3. per-call cwd — one machine, many projects: the launch cwd is the call's,
 *      and a missing directory fails before a terminal exists, with the remote
 *      `ls` to run.
 *
 * The "other machine" is a real directory tree (`FAKE_HC_REMOTE_ROOT`) and the
 * probe really executes inside it, with that machine's own PATH/HOME — which is
 * why `bin/node` here is a shell shim: a resolver that returns `command -v
 * node` produces a target whose preflight fails, so the shim is asserted, not
 * assumed.
 */

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { HcCliClient, type HcClient, type HcMethod } from "../../src/hc/client.ts";
import { clearHostDiscoveryCache, mapRemoteArgv, resolveHostTargetAsync, type HostTarget } from "../../src/runs/remote.ts";
import { TerminalSupervisor } from "../../src/supervisor/terminal-supervisor.ts";
import { SubagentError, type AgentConfig } from "../../src/shared/types.ts";
import type { SpawnInput } from "../../src/supervisor/types.ts";

// Hermetic: inherited extensions are absolute paths from whatever machine runs
// the suite, and a remote launch refuses an argv path it cannot map.
process.env.PI_LEGION_CHILD_INHERIT_EXTENSIONS = "0";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../..");
const FAKE_CORE = path.join(REPO_ROOT, "test/helpers/fake-hc-core.mjs");
const HOST = "fakebox";
const TERMINAL_ID = "t1k";
const SOCKET = "/tmp/hc-fake-host-discovery/default.sock";
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
	secondProject: string;
	realNode: string;
	nodeShim: string;
	piEntry: string;
	legionRoot: string;
	providerExtension: string;
	client: HcClient;
	supervisor: TerminalSupervisor;
	spawnRoot: string;
	wire(): WireRequest[];
	wireFor(method: HcMethod): Record<string, unknown>[];
	cleanup(): void;
}

const LIVE: Harness[] = [];

/**
 * One copy of this node binary, shared by every harness in this file.
 *
 * The fake core's oracle refuses an argv[0] that is not inside the "other
 * machine's" root, and it is right to: a discovered `node` must be a path ON
 * that machine. So the fixture hard-links a copy of this interpreter inside the
 * fake remote root and points the shim at it — `process.execPath` then answers a
 * path that really belongs to that filesystem, which is exactly the fact the
 * probe is supposed to discover.
 */
let NODE_COPY: string | undefined;
function nodeCopy(): string {
	if (NODE_COPY !== undefined) return NODE_COPY;
	const dir = mkdtempSync(path.join(tmpdir(), "legion-node-copy-"));
	const copy = path.join(dir, "node");
	copyFileSync(process.execPath, copy);
	chmodSync(copy, 0o755);
	NODE_COPY = copy;
	return copy;
}

/**
 * Lay out a machine that is NOT this one: its own home, its own pi install, its
 * own node (a version-manager shim), and two project directories.
 */
function harness(t: { after: (fn: () => void) => void }, options: { hosted?: boolean } = {}): Harness {
	const root = mkdtempSync(path.join(tmpdir(), "legion-host-discovery-"));
	const remoteRoot = path.join(root, "remote");
	const home = path.join(remoteRoot, "home");
	const bin = path.join(remoteRoot, "bin");
	const remoteCwd = path.join(remoteRoot, "proj-a");
	const secondProject = path.join(remoteRoot, "proj-b");
	const spawnRoot = path.join(root, "spawn");
	for (const dir of [home, bin, remoteCwd, secondProject, spawnRoot]) mkdirSync(dir, { recursive: true });

	// A node binary that really lives ON that machine (so argv[0] is legitimate),
	// behind a mise/asdf-style shell shim, which is the only `node` on PATH.
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

	// The managed pi install the launcher resolves to.
	const agent = path.join(home, ".pi", "agent");
	const launcher = path.join(agent, "bin", "pi");
	mkdirSync(path.dirname(launcher), { recursive: true });
	writeFileSync(
		launcher,
		`#!/bin/sh
# the same shape as the real launcher: resolve the managed release, then exec it
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

	// This package, installed on that machine (the preflight `test -f`s its entry).
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
		// The machine's OWN PATH/HOME: no node except the shim, and the pi install
		// under its home. This is what makes "resolve the real binary" testable.
		FAKE_HC_REMOTE_PATH: `${bin}:/usr/bin:/bin`,
		FAKE_HC_REMOTE_HOME: home,
		FAKE_HC_LOG: wirePath,
		...(options.hosted === false ? { FAKE_HC_MACHINE_LIST: "empty" } : {}),
	};
	const real = new HcCliClient({ env, requestTimeoutMs: 20_000 });
	const client: HcClient = {
		start: () => real.start(),
		close: () => real.close(),
		request: async <T = unknown>(method: HcMethod, params: Record<string, unknown> = {}): Promise<T> =>
			(await real.request<T>(method, params)) as T,
	};
	const supervisor = new TerminalSupervisor({ clientFactory: () => client, env, runId: "run-discover-1", pollIntervalMs: 5 });
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
		secondProject,
		realNode,
		nodeShim,
		piEntry,
		legionRoot,
		providerExtension,
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
		description: "host discovery fixture",
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

/** Run `work`, require it to reject, and hand back the error for assertions. */
async function rejected(work: () => Promise<unknown>): Promise<unknown> {
	try {
		await work();
	} catch (error) {
		return error;
	}
	throw new Error("expected the call to reject");
}

function spawnInput(h: Harness, target: HostTarget, overrides: Partial<SpawnInput> = {}): SpawnInput {
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
		...overrides,
	};
}

// ── 1. minimal configuration ───────────────────────────────────────────────

test("v1.1: a host entry of {} launches — node/pi/legion/provider all discovered, the shim never used", async (t) => {
	const h = harness(t);
	clearHostDiscoveryCache();
	// The settings name the host but write NOTHING about it; the cwd is per call.
	const target = await resolveHostTargetAsync(HOST, { enabled: true, hosts: { [HOST]: {} } }, {
		client: h.client,
		cwd: h.remoteCwd,
		cacheDir: null,
	});
	assert.equal(target.cwd, h.remoteCwd, "the per-call cwd is the launch cwd");
	assert.equal(target.node, h.realNode, "the mise shim must be resolved to the real binary");
	assert.notEqual(target.node, h.nodeShim, "handing the shim to node-as-argv[0] is the 6.1.0 bug");
	assert.equal(target.piCli, h.piEntry, "the shell launcher is resolved to its bundle cli.js");
	assert.equal(target.piLegionRoot, h.legionRoot);
	assert.deepEqual(target.piExtensions, [h.providerExtension], "a discovered provider restores the models --no-extensions removed");
	assert.deepEqual(target.discovered, ["node", "piCli", "piLegionRoot", "piExtensions"]);

	// And the discovered target really crosses: preflight + startup probe + terminal.
	const handle = await h.supervisor.spawnChild(spawnInput(h, target));
	assert.ok(handle.name.length > 0);
	const run = h.wireFor("terminal.run").at(-1);
	assert.ok(run, "a terminal must be created");
	assert.equal(run.cwd, h.remoteCwd);
	const argv = run.argv as string[];
	assert.equal(argv[0], h.realNode);
	assert.equal(argv[1], h.piEntry);
	assert.ok(argv.includes(h.providerExtension), `the provider extension must be in argv: ${argv.join(" ")}`);
	assert.ok(argv.includes(path.posix.join(`${h.legionRoot}`, "index.ts")));
});

test("v1.1: with NO hosts block at all, the hc registry alone admits and configures the host", async (t) => {
	const h = harness(t);
	clearHostDiscoveryCache();
	// `crossMachine` names no host at all — the machine is registered with hc.
	const target = await resolveHostTargetAsync(HOST, undefined, {
		client: h.client,
		cwd: h.remoteCwd,
		cacheDir: null,
	});
	assert.equal(target.cwd, h.remoteCwd);
	assert.equal(target.node, h.realNode);
	assert.equal(target.piCli, h.piEntry);
	const handle = await h.supervisor.spawnChild(spawnInput(h, target));
	assert.ok(handle.name.length > 0);
	assert.equal(h.wireFor("terminal.run").at(-1)?.cwd, h.remoteCwd);
	assert.equal(h.wireFor("terminal.run").at(-1)?.on, HOST);
});

// ── 2. admission vs configuration ──────────────────────────────────────────

test("v1.1 admission: an empty hc registry names the machine, lists nothing, and points at `hc machine add`", async (t) => {
	const h = harness(t, { hosted: false });
	clearHostDiscoveryCache();
	const error = await rejected(
		() => resolveHostTargetAsync(HOST, { enabled: true, hosts: { [HOST]: { cwd: h.remoteCwd } } }, { client: h.client, admission: "always", cacheDir: null }),
	);
	assert.ok(error instanceof SubagentError, `expected a SubagentError, got ${String(error)}`);
	assert.match(error.message, new RegExp(`host '${HOST}' is not a machine this hc core knows`));
	assert.match(error.message, /`hc machine ls` here lists no machines/);
	assert.match(error.message, new RegExp(`hc machine add --name ${HOST}`));
	assert.doesNotMatch(error.message, /machine_unknown: unknown machine/, "a registry miss is not a transport failure");
	assert.deepEqual(h.wireFor("machine.exec"), [], "nothing may be probed for a machine that is not registered");
	assert.deepEqual(h.wireFor("terminal.run"), [], "and nothing may run");
});

test("v1.1 admission: registered but the probe finds no node/pi — the error names the fields and what it saw", async (t) => {
	const h = harness(t);
	clearHostDiscoveryCache();
	// Make that machine tool-less without touching the fixture: the probe runs the
	// real script, and this core's PATH for it is a directory with nothing in it.
	const empty = path.join(h.remoteRoot, "empty-bin");
	mkdirSync(empty, { recursive: true });
	// The fake core reads this at START; a second core instance is the honest way.
	const wrapper = path.join(h.root, "hc-bin", "hc");
	const env = {
		...process.env,
		HC_BIN: wrapper,
		FAKE_HC_REMOTE_ROOT: h.remoteRoot,
		FAKE_HC_MACHINES: HOST,
		FAKE_HC_REMOTE_PATH: `${empty}:/usr/bin:/bin`,
		FAKE_HC_REMOTE_HOME: path.join(h.root, "no-home"),
	};
	const client = new HcCliClient({ env, requestTimeoutMs: 20_000 });
	try {
		await client.start();
		const error = await rejected(
			() => resolveHostTargetAsync(HOST, { hosts: { [HOST]: { cwd: h.remoteCwd } } }, { client, cacheDir: null }),
		);
		assert.ok(error instanceof SubagentError, `expected a SubagentError, got ${String(error)}`);
		assert.match(error.message, /could not find node \/ piCli on that machine/);
		assert.match(error.message, /node: not found on PATH/);
		assert.match(error.message, /pi: not found on PATH/);
		assert.match(error.message, new RegExp(`"node": "/abs/path/on/${HOST}/bin/node"`));
		assert.match(error.message, /"piCli": /);
	} finally {
		client.close();
	}
});

// ── 3. compatibility + overrides ───────────────────────────────────────────

test("v1.1: a pre-v1.1 entry (cwd+node+piCli+piLegionRoot) resolves without a single probe", async (t) => {
	const h = harness(t);
	clearHostDiscoveryCache();
	const target = await resolveHostTargetAsync(HOST, {
		enabled: true,
		hosts: { [HOST]: { cwd: h.remoteCwd, node: h.nodeShim, piCli: h.piEntry, piLegionRoot: h.legionRoot } },
	}, { client: h.client, cacheDir: null });
	assert.deepEqual(h.wireFor("machine.exec"), [], "a complete entry must not cost a probe");
	// The operator's own values, verbatim — including the shim they wrote.
	assert.equal(target.node, h.nodeShim);
	assert.equal(target.piCli, h.piEntry);
	assert.equal(target.discovered, undefined);
	assert.equal(target.discovery, undefined);
	assert.equal(target.rediscover, undefined);
	// It still launches (the shim runs node, which is what a mise user expects).
	const handle = await h.supervisor.spawnChild(spawnInput(h, target));
	assert.ok(handle.name.length > 0);
	assert.equal((h.wireFor("terminal.run").at(-1)?.argv as string[] | undefined)?.[0], h.nodeShim);
});

test("v1.1: the per-call cwd overrides the host default, so one machine serves many projects", async (t) => {
	const h = harness(t);
	clearHostDiscoveryCache();
	const settings = {
		enabled: true,
		hosts: { [HOST]: { cwd: h.remoteCwd, node: h.realNode, piCli: h.piEntry, piLegionRoot: h.legionRoot, piExtensions: [] } },
	};
	const asDefault = await resolveHostTargetAsync(HOST, settings, { client: h.client, cacheDir: null });
	assert.equal(asDefault.cwd, h.remoteCwd);
	const overridden = await resolveHostTargetAsync(HOST, settings, { client: h.client, cwd: h.secondProject, cacheDir: null });
	assert.equal(overridden.cwd, h.secondProject);
	await h.supervisor.spawnChild(spawnInput(h, overridden));
	assert.equal(h.wireFor("terminal.run").at(-1)?.cwd, h.secondProject);
});

test("v1.1: a per-call cwd that does not exist fails before a terminal, naming the remote `ls`", async (t) => {
	const h = harness(t);
	clearHostDiscoveryCache();
	const settings = {
		enabled: true,
		hosts: { [HOST]: { cwd: h.remoteCwd, node: h.realNode, piCli: h.piEntry, piLegionRoot: h.legionRoot, piExtensions: [] } },
	};
	const missing = path.join(h.remoteRoot, "no-such-project");
	const target = await resolveHostTargetAsync(HOST, settings, { client: h.client, cwd: missing, cacheDir: null });
	assert.equal(target.cwd, missing);
	const failure = await rejected(() => h.supervisor.spawnChild(spawnInput(h, target)));
	assert.match(String((failure as Error)?.message ?? failure), /does not exist on fakebox/);
	assert.deepEqual(h.wireFor("terminal.run"), [], "no terminal may be created for a cwd that is not there");
});

// ── 3b. extensions by package name (v1.2) ─────────────────────────────────

/**
 * The real-run failure this covers: the parent inherited five extensions as
 * PARENT absolute paths (`…/pi-any-endpoint/extensions/index.ts`) and the target
 * (a different machine, different home) loaded none of them — the child then had
 * no model provider. The probe now reports that machine's installed packages, so
 * the same package is found by NAME and only the root changes.
 */
test("v1.2: a parent extension path is re-rooted by PACKAGE NAME from the target's real package list", async (t) => {
	const h = harness(t);
	clearHostDiscoveryCache();
	const target = await resolveHostTargetAsync(HOST, { enabled: true }, {
		client: h.client,
		cwd: h.remoteCwd,
		admission: "always",
		cacheDir: null,
	});
	assert.ok(target.packageIndex, "the probe must report the target's packages");
	assert.ok(target.packageIndex?.packages.some((entry) => entry.name === "pi-any-endpoint"));

	// A parent-side package with the SAME name + layout (that is all two machines
	// need to share; the roots differ).
	const parentRoot = path.join(h.root, "parent", "node_modules", "pi-any-endpoint");
	const parentEntry = path.join(parentRoot, "extensions", "index.ts");
	mkdirSync(path.dirname(parentEntry), { recursive: true });
	writeFileSync(parentEntry, "export function registerProvider() {}\n");
	writeFileSync(path.join(parentRoot, "package.json"), JSON.stringify({
		name: "pi-any-endpoint",
		keywords: ["provider"],
		pi: { extensions: ["./extensions/index.ts"] },
	}));
	const mapped = mapRemoteArgv(["--no-extensions", "-e", parentEntry], {
		host: HOST,
		remoteCwd: h.remoteCwd,
		remoteDir: path.posix.join(h.remoteRoot, ".mirror", "run", "child"),
		localCwd: h.remoteRoot,
		pathMap: target.pathMap,
		...(target.packageIndex ? { packages: target.packageIndex } : {}),
	});
	assert.deepEqual(mapped, ["--no-extensions", "-e", h.providerExtension]);
});

test("v1.2/D13: a target package that declares a DIRECTORY is mapped through it (the demo's false refusal)", async (t) => {
	const h = harness(t);
	clearHostDiscoveryCache();
	// The target's copy of the real `pi-autoresearch`: the manifest declares the
	// DIRECTORY and the loadable entries sit one level inside it.
	const npmModules = path.dirname(h.legionRoot);
	const remotePackage = path.join(npmModules, "pi-autoresearch");
	const remoteEntry = path.join(remotePackage, "extensions", "pi-autoresearch", "index.ts");
	mkdirSync(path.dirname(remoteEntry), { recursive: true });
	writeFileSync(remoteEntry, "export class AutoResearch {}\n");
	writeFileSync(
		path.join(remotePackage, "package.json"),
		JSON.stringify({ name: "pi-autoresearch", pi: { extensions: ["./extensions"] } }),
	);

	const target = await resolveHostTargetAsync(HOST, { enabled: true }, {
		client: h.client,
		cwd: h.remoteCwd,
		admission: "always",
		cacheDir: null,
	});
	// 1) The probe carries the FACT (one statSync), not a guess about the path shape.
	const declared = target.packageIndex?.entries.find((entry) => entry.name === "pi-autoresearch");
	assert.deepEqual(
		declared,
		{ name: "pi-autoresearch", relative: "extensions", path: path.join(remotePackage, "extensions"), directory: true },
		"the target must report its declared entry as a DIRECTORY",
	);

	// 2) The parent's expanded entry (what `pi list` gives it on THIS machine) maps.
	const parentRoot = path.join(h.root, "parent", "node_modules", "pi-autoresearch");
	const parentEntry = path.join(parentRoot, "extensions", "pi-autoresearch", "index.ts");
	mkdirSync(path.dirname(parentEntry), { recursive: true });
	writeFileSync(parentEntry, "export class AutoResearch {}\n");
	writeFileSync(
		path.join(parentRoot, "package.json"),
		JSON.stringify({ name: "pi-autoresearch", pi: { extensions: ["./extensions"] } }),
	);
	const mapped = mapRemoteArgv(["--no-extensions", "-e", parentEntry], {
		host: HOST,
		remoteCwd: h.remoteCwd,
		remoteDir: path.posix.join(h.remoteRoot, ".mirror", "run", "child"),
		localCwd: h.remoteRoot,
		pathMap: target.pathMap,
		...(target.packageIndex ? { packages: target.packageIndex } : {}),
	});
	assert.deepEqual(mapped, ["--no-extensions", "-e", remoteEntry]);
});

test("v1.2: an extension the target does not have is refused before any terminal, naming package and fixes", async (t) => {
	const h = harness(t);
	clearHostDiscoveryCache();
	const target = await resolveHostTargetAsync(HOST, { enabled: true }, {
		client: h.client,
		cwd: h.remoteCwd,
		admission: "always",
		cacheDir: null,
	});
	const parentRoot = path.join(h.root, "parent", "node_modules", "pi-not-installed");
	const parentEntry = path.join(parentRoot, "src", "index.ts");
	mkdirSync(path.dirname(parentEntry), { recursive: true });
	writeFileSync(parentEntry, "export const x = 1;\n");
	writeFileSync(path.join(parentRoot, "package.json"), JSON.stringify({ name: "pi-not-installed" }));
	const failure = await rejected(async () => mapRemoteArgv(["-e", parentEntry], {
		host: HOST,
		remoteCwd: h.remoteCwd,
		remoteDir: path.posix.join(h.remoteRoot, ".mirror", "run", "child"),
		localCwd: h.remoteRoot,
		pathMap: target.pathMap,
		...(target.packageIndex ? { packages: target.packageIndex } : {}),
		// D4: the launch path knows the role, so the refusal can name the key for it.
		role: "centurion",
	}));
	const message = String((failure as Error)?.message ?? failure);
	assert.match(message, /package 'pi-not-installed', which is not installed on that machine/);
	// D4's two ways out, with the real host and the real role — the snippet is the
	// fix the operator asked for, not a pointer to the source file.
	assert.match(message, /hc exec --on fakebox -- pi install npm:pi-not-installed/);
	assert.match(message, /for role 'centurion': subagents\.agentOverrides\.centurion\.excludeExtensions/);
	const settingsJson = message.match(/\{"subagents":\{"agentOverrides":\{.*\}\}\}/)?.[0];
	assert.ok(settingsJson, `expected the D4 settings JSON, got: ${message}`);
	const parsed = JSON.parse(settingsJson) as { subagents: { agentOverrides: Record<string, { excludeExtensions: string[] }> } };
	assert.deepEqual(parsed.subagents.agentOverrides.centurion?.excludeExtensions, ["pi-not-installed"]);
	// Nothing was started: argv mapping runs before `terminal.run`.
	assert.deepEqual(h.wireFor("terminal.run"), []);
});

// ── 4. self-healing cache ─────────────────────────────────────────────────

test("v1.1: a stale discovered piCli is re-probed once by the preflight (upgrade self-heal)", async (t) => {
	const h = harness(t);
	clearHostDiscoveryCache();
	const target = await resolveHostTargetAsync(HOST, { hosts: { [HOST]: {} } }, {
		client: h.client,
		cwd: h.remoteCwd,
		cacheDir: null,
	});
	assert.deepEqual(target.discovered?.includes("piCli"), true);
	// The target is upgraded: the old bundle path is gone, a new release exists.
	const stale = { ...target, piCli: path.posix.join(h.remoteRoot, "gone", "dist", "bundle", "cli.js") };
	const rediscover = async () => target;
	await h.supervisor.spawnChild(spawnInput(h, { ...stale, rediscover }));
	const run = h.wireFor("terminal.run").at(-1);
	assert.ok(run, "the retry must reach terminal.run");
	assert.equal((run.argv as string[])[1], h.piEntry, "the retried target carries the fresh entry");
});
