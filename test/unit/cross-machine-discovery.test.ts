/**
 * Cross-machine host discovery (contract addendum v1.1).
 *
 * Three layers are pinned here, and the ORACLE for the first one is a real
 * `sh -c` run of the generated probe against a temp directory laid out like a
 * pi install — not a string assertion:
 *
 *   1. the probe itself: a mise/asdf `node` shim resolves to the REAL binary,
 *      a `case "$0"` pi launcher resolves to its `bundle/cli.js`, and the
 *      installed legion + provider extension are found;
 *   2. the refusals: "no node there", "no pi entry there", "this core knows no
 *      such machine" each name the fact AND what was found;
 *   3. the resolver: explicit settings always win, discovered values only fill
 *      holes, the per-call cwd override wins over the host default, and a
 *      fully explicit pre-v1.1 entry resolves to the byte-identical target.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { HcRpcError, type HcClient, type HcMethod } from "../../src/hc/client.ts";
import {
	buildDiscoveryReport,
	clearHostDiscoveryCache,
	localPackageForFile,
	mapRemoteArgv,
	mapRemoteArgvAllowingSkips,
	needsPackageIndex,
	planSkippedExtensions,
	resolvePackagePathOnHost,
	describeDiscovery,
	discoveredFields,
	discoverHost,
	parseDiscoveryReport,
	parseMachineList,
	probeHost,
	remoteDiscoveryScript,
	resolveHostTarget,
	resolveHostTargetAsync,
	missingRemoteCwdQuestion,
	thisPackageRoot,
	type HcExecResult,
} from "../../src/runs/remote.ts";
import { ErrorCodes, SubagentError, type SubagentsSettings } from "../../src/shared/types.ts";
import { cwdIsRemote, firstRemoteCwd, localRepoFor } from "../../index.ts";

// ── fixtures ───────────────────────────────────────────────────────────────

type Params = Record<string, unknown>;

class FakeClient implements HcClient {
	readonly calls: Array<{ method: HcMethod; params: Params }> = [];

	private readonly handlers: {
		machines?: () => unknown;
		exec?: (params: Params) => HcExecResult;
	};

	constructor(handlers: {
		machines?: () => unknown;
		exec?: (params: Params) => HcExecResult;
	} = {}) {
		this.handlers = handlers;
		// Every fake client stands for one process talking to one core, so the
		// module-level registry cache must not leak between tests (in production its
		// 60 s TTL is what covers `hc machine add`).
		clearHostDiscoveryCache();
	}

	async start(): Promise<void> {}

	async request<T = unknown>(method: HcMethod, params: Params = {}): Promise<T> {
		this.calls.push({ method, params });
		if (method === "machine.list") {
			if (this.handlers.machines === undefined) {
				throw new HcRpcError({ code: -32601, message: "unknown method: machine.list", data: { kind: "method_not_found" } });
			}
			return this.handlers.machines() as T;
		}
		if (method === "machine.exec") {
			const result = this.handlers.exec?.(params) ?? { code: 0, stdout: "", stderr: "", timed_out: false };
			return result as T;
		}
		throw new Error(`fake client: unexpected ${method}`);
	}

	close(): void {}

	paramsFor(method: HcMethod): Params[] {
		return this.calls.filter((call) => call.method === method).map((call) => call.params);
	}
}

function b64(text: string): string {
	return Buffer.from(text, "utf8").toString("base64");
}

function probeResult(stdout: string): HcExecResult {
	return { code: 0, ms: 4, signal: null, stdout: b64(stdout), stderr: "", truncated: false, timed_out: false };
}

/**
 * A temp directory laid out like a pi install, plus a shim'd `node`.
 *
 * `mise`/`asdf` put a SHELL SCRIPT named `node` on PATH; handing that path to
 * `terminal.run` as argv[0] is the 6.1.0 bug in a different costume. The shim is
 * the only `node` this "machine" has, so a resolver that returns `command -v
 * node` fails the assertion and one that asks node itself passes.
 */
interface FakeMachine {
	root: string;
	bin: string;
	home: string;
	realNode: string;
	shimNode: string;
	piLauncher: string;
	piEntry: string;
	legionRoot: string;
	providerExtension: string;
	environment(extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
	cleanup(): void;
}

const LIVE: FakeMachine[] = [];

function fakeMachine(t: { after: (fn: () => void) => void }): FakeMachine {
	const root = mkdtempSync(path.join(tmpdir(), "legion-discovery-"));
	const bin = path.join(root, "bin");
	const home = path.join(root, "home");
	const realNode = process.execPath;
	mkdirSync(bin, { recursive: true });
	mkdirSync(home, { recursive: true });

	// A mise/asdf-style shim: a shell script that execs the real binary.
	const shimNode = path.join(bin, "node");
	writeFileSync(shimNode, `#!/bin/sh\nexec ${JSON.stringify(realNode)} "$@"\n`, { mode: 0o755 });
	chmodSync(shimNode, 0o755);

	// The managed pi layout: bin/pi launcher -> install/releases/<v>/…/cli.js
	const agent = path.join(home, ".pi", "agent");
	const launcher = path.join(agent, "bin", "pi");
	mkdirSync(path.dirname(launcher), { recursive: true });
	writeFileSync(launcher, "#!/bin/sh\nexec \"$pi_release_bin\" \"$@\"\n", { mode: 0o755 });
	const release = path.join(agent, "install", "releases", "9.9.9", "node_modules");
	mkdirSync(path.join(release, ".bin"), { recursive: true });
	const piEntry = path.join(release, "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js");
	mkdirSync(path.dirname(piEntry), { recursive: true });
	writeFileSync(
		piEntry,
		`#!/usr/bin/env node
if (process.argv.includes("--version")) process.stdout.write("9.9.9\\n");
else if (process.argv.includes("--list-models")) {
	process.stdout.write("provider      model                    context  max-out\\n");
	process.stdout.write("any-endpoint  workbuddy/deepseek-v4.1   128k     8k\\n");
}
`,
		{ mode: 0o755 },
	);
	mkdirSync(path.join(agent, "install"), { recursive: true });
	writeFileSync(path.join(agent, "install", "current-version"), "9.9.9\n");
	symlinkSync(path.posix.join("..", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js"), path.join(release, ".bin", "pi"));
	symlinkSync(launcher, path.join(bin, "pi"));

	const npmModules = path.join(agent, "npm", "node_modules");
	// The directory name is NOT the package name on a real machine (`pi-legion`
	// holds `"name": "pi-legion"`), which is why the probe validates package.json.
	const legionRoot = path.join(npmModules, "pi-legion");
	mkdirSync(legionRoot, { recursive: true });
	writeFileSync(path.join(legionRoot, "index.ts"), "// fake legion\n");
	writeFileSync(path.join(legionRoot, "package.json"), JSON.stringify({ name: "pi-legion", version: "9.9.9" }));
	const providerExtension = path.join(npmModules, "pi-any-endpoint", "extensions", "index.ts");
	mkdirSync(path.dirname(providerExtension), { recursive: true });
	writeFileSync(providerExtension, "export function registerProvider() {}\n");
	writeFileSync(
		path.join(npmModules, "pi-any-endpoint", "package.json"),
		JSON.stringify({ name: "pi-any-endpoint", keywords: ["provider"], pi: { extensions: ["./extensions/index.ts"] } }),
	);

	const machine: FakeMachine = {
		root,
		bin,
		home,
		realNode,
		shimNode,
		piLauncher: launcher,
		piEntry,
		legionRoot,
		providerExtension,
		environment: (extra: NodeJS.ProcessEnv = {}) => ({
			...process.env,
			HOME: home,
			PATH: `${bin}:/usr/bin:/bin`,
			...extra,
		}),
		cleanup: () => {
			const index = LIVE.indexOf(machine);
			if (index >= 0) LIVE.splice(index, 1);
			rmSync(root, { recursive: true, force: true });
		},
	};
	LIVE.push(machine);
	t.after(() => machine.cleanup());
	return machine;
}

/** Run the generated probe for real against one fake machine. */
function runProbe(machine: FakeMachine, extraEnv: NodeJS.ProcessEnv = {}): string {
	return execFileSync("/bin/sh", ["-c", remoteDiscoveryScript()], {
		encoding: "utf8",
		env: machine.environment(extraEnv),
	});
}

function config(
	hosts: Record<string, { cwd?: string; node?: string; piCli?: string; piLegionRoot?: string; piExtensions?: string[]; discover?: boolean }>,
	extra: Omit<NonNullable<SubagentsSettings["crossMachine"]>, "hosts"> = { enabled: true },
): SubagentsSettings["crossMachine"] {
	return { ...extra, hosts };
}

function thrownSync(work: () => unknown): unknown {
	try {
		work();
	} catch (error) {
		return error;
	}
	return undefined;
}

async function thrown(work: () => Promise<unknown>): Promise<unknown> {
	try {
		await work();
	} catch (error) {
		return error;
	}
	return undefined;
}

// ── 1. the probe (real sh) ─────────────────────────────────────────────────

test("v1.1 probe: a mise shim resolves to the REAL node, and the pi launcher to its bundle entry", (t) => {
	const machine = fakeMachine(t);
	const facts = parseDiscoveryReport(runProbe(machine));
	assert.equal(facts.get("PROBE_OK"), "1");
	// The shim is on PATH...
	assert.equal(facts.get("NODE_CMD"), machine.shimNode);
	// ...and node itself is what names the real binary: never the shim.
	assert.equal(facts.get("NODE_BIN"), machine.realNode);
	assert.equal(facts.get("NODE_SHIM"), machine.shimNode);
	assert.match(facts.get("NODE_VERSION") ?? "", /^v\d+/);
	// The launcher is a shell script; argv[1] must be the JavaScript entry.
	assert.equal(facts.get("PI_CMD"), path.join(machine.bin, "pi"));
	assert.equal(facts.get("PI_ENTRY"), machine.piEntry);
	assert.equal(facts.get("PI_VERSION"), "9.9.9");
	// This package, found by its package.json name — not by its directory name.
	assert.equal(facts.get("LEGION_ROOT"), machine.legionRoot);
	assert.equal(facts.get("LEGION_VERSION"), "9.9.9");
	// A provider extension is what `--no-extensions` silently removed (S5.6).
	const extensions = buildDiscoveryReport(facts).extensions;
	assert.deepEqual(
		extensions.map((entry) => [entry.name, entry.path, entry.provider]),
		[["pi-any-endpoint", machine.providerExtension, true]],
	);
	const report = buildDiscoveryReport(facts);
	// v1.2: every installed package is reported by name+dir, and the declared
	// entries by package-relative path — the input for re-rooting a parent path.
	assert.ok(
		report.packages.some((entry) => entry.name === "pi-any-endpoint"),
		`the package list must name pi-any-endpoint: ${JSON.stringify(report.packages)}`,
	);
	assert.deepEqual(
		report.packageEntries.filter((entry) => entry.name === "pi-any-endpoint").map((entry) => entry.relative),
		["extensions/index.ts"],
	);
	assert.deepEqual(discoveredFields(report), {
		node: machine.realNode,
		piCli: machine.piEntry,
		piLegionRoot: machine.legionRoot,
		piExtensions: [machine.providerExtension],
	});
});

test("v1.1 probe: a machine with no node/pi reports that, not an empty report", (t) => {
	const machine = fakeMachine(t);
	// /usr/bin has no node in this environment; drop the shim directory entirely.
	const emptyBin = path.join(machine.root, "empty-bin");
	mkdirSync(emptyBin, { recursive: true });
	const text = execFileSync("/bin/sh", ["-c", remoteDiscoveryScript()], {
		encoding: "utf8",
		env: { ...process.env, HOME: machine.home, PATH: `${emptyBin}:/usr/bin:/bin` },
	});
	const facts = parseDiscoveryReport(text);
	assert.equal(facts.get("NODE_MISSING"), "1");
	assert.equal(facts.get("PI_MISSING"), "1");
	assert.equal(facts.get("PROBE_OK"), "1", "the probe still finishes and says what it saw");
	const report = buildDiscoveryReport(facts);
	assert.equal(report.node, undefined);
	assert.equal(report.pi, undefined);
	// The package is there even without node: that is a file-system fact, not a
	// runtime one, and it is what the hand-written fix can be based on.
	assert.deepEqual(discoveredFields(report), { piLegionRoot: machine.legionRoot });
	assert.match(describeDiscovery(report), /node: not found on PATH/);
	assert.match(describeDiscovery(report), /pi: not found on PATH/);
});

test("v1.1 probe: repeated EXT rows survive parsing (a Map would keep only the last)", (t) => {
	const machine = fakeMachine(t);
	// A second provider package, so the parser has to keep two rows.
	const modules = path.join(machine.home, ".pi", "agent", "npm", "node_modules");
	const second = path.join(modules, "pi-other-provider");
	mkdirSync(path.join(second, "ext"), { recursive: true });
	writeFileSync(path.join(second, "ext", "index.ts"), "export const x = 1;\n");
	writeFileSync(
		path.join(second, "package.json"),
		JSON.stringify({ name: "pi-other-provider", pi: { extensions: ["./ext/index.ts"] } }),
	);
	const report = buildDiscoveryReport(parseDiscoveryReport(runProbe(machine)));
	assert.deepEqual(
		report.extensions.map((entry) => entry.name).sort(),
		["pi-any-endpoint", "pi-other-provider"],
	);
});

// ── 2. admission + refusal wording ─────────────────────────────────────────

test("v1.1 admission: a host this core does not know is refused by name, listing what it DOES know", async () => {
	clearHostDiscoveryCache();
	const client = new FakeClient({
		machines: () => ({ machines: [{ name: "a" }, { name: "b" }] }),
	});
	const error = await thrown(() => resolveHostTargetAsync("hw-nj", { enabled: true }, { client, cacheDir: null }));
	assert.ok(error instanceof SubagentError);
	assert.equal((error as SubagentError).code, ErrorCodes.INVALID_PARAMS);
	const message = (error as SubagentError).message;
	assert.match(message, /host 'hw-nj' is not a machine this hc core knows/);
	assert.match(message, /`hc machine ls` here lists: a, b/);
	assert.match(message, /hc machine add --name hw-nj/);
	assert.doesNotMatch(message, /subagents\.crossMachine\.hosts/, "a registry miss must not send the operator to settings");
	assert.equal(client.paramsFor("machine.exec").length, 0, "nothing may be probed for a machine hc does not know");
});

test("v1.1 admission: an EMPTY registry says so and still prints the fix", async () => {
	clearHostDiscoveryCache();
	const client = new FakeClient({ machines: () => ({ machines: [] }) });
	const error = await thrown(() => resolveHostTargetAsync("hw-nj", { enabled: true }, { client, cacheDir: null }));
	assert.ok(error instanceof SubagentError);
	assert.match((error as SubagentError).message, /`hc machine ls` here lists no machines/);
	assert.match((error as SubagentError).message, /hc machine add --name hw-nj/);
});

test("v1.1 admission: a core without machine.list cannot confirm the host — the ACTION is `hc machine add` (D1/F2)", async () => {
	clearHostDiscoveryCache();
	// No `machines` handler: the call throws kind=method_not_found.
	const client = new FakeClient();
	const error = await thrown(() => resolveHostTargetAsync("vps", { enabled: true }, { client, cacheDir: null }));
	assert.ok(error instanceof SubagentError);
	const message = (error as SubagentError).message;
	// Action first: register the machine (pasteable), settings key as one aside.
	assert.match(message, /^host 'vps': register the machine, then retry — hc machine add --name vps ssh:\/\/user@that-machine\./);
	assert.match(message, /did not answer `machine list`/);
	assert.match(message, /no entry in subagents\.crossMachine\.hosts/);
	assert.match(message, /Legion will not run the child on this machine instead\./);
	assert.equal(((error as SubagentError).details as { reason?: string }).reason, "host-unconfirmed");
	assert.deepEqual(client.paramsFor("machine.exec"), [], "an unconfirmed host is never probed");
});

test("v1.1 admission: `always` refuses a configured host the registry does not know; `never` lets resume ask the machine itself", async () => {
	clearHostDiscoveryCache();
	const client = new FakeClient({ machines: () => ({ machines: [{ name: "other" }] }) });
	const settings = { enabled: true, hosts: { vps: { cwd: "/srv/app", node: "/opt/node", piCli: "/opt/pi/cli.js", piLegionRoot: "/srv/legion" } } };
	const refused = await thrown(() => resolveHostTargetAsync("vps", settings, { client, admission: "always", cacheDir: null }));
	assert.ok(refused instanceof SubagentError);
	assert.match((refused as SubagentError).message, /host 'vps' is not a machine this hc core knows/);
	// A resume of a child that already ran there must not be refused by a registry
	// this session cannot see (machine registration is per HC_SESSION).
	const resumed = await resolveHostTargetAsync("vps", settings, { client, admission: "never", cacheDir: null });
	assert.equal(resumed.cwd, "/srv/app");
});

test("v1.1 admission: enabled:false still refuses every host", async () => {
	const error = await thrown(() => resolveHostTargetAsync("vps", { enabled: false }, { cacheDir: null }));
	assert.ok(error instanceof SubagentError);
	assert.equal((error as SubagentError).message, "host 'vps' needs subagents.crossMachine.enabled = true");
});

test("v1.1 probe failure: the error names the missing field, what WAS found, and the JSON to paste", async (t) => {
	clearHostDiscoveryCache();
	const machine = fakeMachine(t);
	const emptyBin = path.join(machine.root, "empty-bin");
	mkdirSync(emptyBin, { recursive: true });
	// The "remote" has no node: run the probe for real, under a PATH without it.
	const text = execFileSync("/bin/sh", ["-c", remoteDiscoveryScript()], {
		encoding: "utf8",
		env: { ...process.env, HOME: machine.home, PATH: `${emptyBin}:/usr/bin:/bin` },
	});
	const client = new FakeClient({
		machines: () => ({ machines: [{ name: "fakebox" }] }),
		exec: () => probeResult(text),
	});
	const error = await thrown(() =>
		resolveHostTargetAsync("fakebox", { hosts: { fakebox: { cwd: "/srv/app" } } }, { client, cacheDir: null }),
	);
	assert.ok(error instanceof SubagentError);
	const message = (error as SubagentError).message;
	assert.match(message, /could not find node \/ piCli on that machine/);
	// What the probe found — the fact that makes "is this the machine I meant?" answerable.
	assert.match(message, /node: not found on PATH/);
	assert.match(message, /pi: not found on PATH/);
	assert.match(message, /legion: /);
	// The hand-written fix, by key.
	assert.match(message, /"hosts": \{ "fakebox": \{ "cwd": "\/srv\/app", "node": "\/abs\/path\/on\/fakebox\/bin\/node", "piCli": /);
	assert.doesNotMatch(message, /HOME/, "HOME is never suggested as a cwd");
});

test("v1.1 probe failure: a transport failure says the probe could not run, not that a field is missing", async () => {
	clearHostDiscoveryCache();
	const client = new FakeClient({
		machines: () => ({ machines: [{ name: "vps" }] }),
		exec: () => {
			throw new HcRpcError({ code: -32000, message: "connection reset", data: { kind: "transport" } });
		},
	});
	const error = await thrown(() =>
		resolveHostTargetAsync("vps", { hosts: { vps: { cwd: "/srv/app" } } }, { client, cacheDir: null }),
	);
	assert.ok(error instanceof SubagentError);
	assert.match((error as SubagentError).message, /host discovery could not run \(transport: connection reset\)/);
	assert.doesNotMatch((error as SubagentError).message, /could not find node/);
});

test("v1.1 probe failure: a workable legacy entry (cwd + one program) survives an unusable probe", async () => {
	clearHostDiscoveryCache();
	// No node was written, but `piCli` was — exactly the pre-v1.1 entry a resume
	// of an existing remote child has. The probe cannot run (transport), and the
	// launch must still reach the preflight / resume gate that names the machine.
	const client = new FakeClient({ exec: () => { throw new Error("hc connect failed to start"); } });
	const resolved = await resolveHostTargetAsync(
		"vps",
		{ enabled: true, hosts: { vps: { cwd: "/srv/app", piCli: "/opt/pi/dist/bundle/cli.js" } } },
		{ client, admission: "never", cacheDir: null },
	);
	assert.equal(resolved.node, "node", "the pre-v1.1 default is what a legacy entry had");
	assert.equal(resolved.piCli, "/opt/pi/dist/bundle/cli.js");
	assert.equal(resolved.discovered, undefined);
	// A `{}` host has no such fallback: it has to name the machine problem.
	const bare = await thrown(() => resolveHostTargetAsync("vps", { hosts: { vps: { cwd: "/srv/app" } } }, { client, cacheDir: null }));
	assert.ok(bare instanceof SubagentError);
	assert.match((bare as SubagentError).message, /host discovery could not run/);
});

// ── xm-dispatch D2: skipped inherited extensions ──────────────────────────

test("xm-dispatch D2: a missing inherited extension is SKIPPED, and the whole launch yields ONE aggregated warning", (t) => {
	const sop = parentPackage(t, "pi-sop", { entry: "src/index.ts" });
	const sysmon = parentPackage(t, "pi-sysmon", { entry: "src/index.ts" });
	const index = packageIndex("/srv/pi", [{ name: "pi-any-endpoint", entry: "extensions/index.ts" }]);
	const mapping = mapRemoteArgvAllowingSkips(
		["--no-extensions", "-e", sop.entry, "-e", sysmon.entry, "-e", sop.entry, "--model", "x"],
		{
			host: "hw-nj",
			remoteCwd: "/srv/app",
			remoteDir: "/srv/.mirror/r/n",
			localCwd: "/local/app",
			pathMap: [],
			packages: index,
		},
	);
	// The PAIR goes: dropping `-e` alone would hand the remote pi the path as its task.
	assert.deepEqual(mapping.args, ["--no-extensions", "--model", "x"]);
	assert.deepEqual(mapping.skipped.map((entry) => entry.reason), ["not-installed", "not-installed", "not-installed"]);
	const plan = planSkippedExtensions({ host: "hw-nj", agentName: "scout", skipped: mapping.skipped });
	assert.equal(plan.refused, undefined);
	assert.equal(plan.warnings.length, 1, "one warning per launch, never one per package");
	const warning = plan.warnings[0] as string;
	assert.match(warning, /host 'hw-nj': skipped 2 inherited extensions/);
	assert.match(warning, /pi-sop, pi-sysmon/);
	// The durable fix travels with the warning, ready to paste.
	assert.match(warning, /"agentOverrides":\{"scout":\{"excludeExtensions":\["pi-sop","pi-sysmon"\]\}\}/);
});

test("xm-dispatch D2: a card that declares the extension REQUIRED gets one aggregated refusal instead of a skip", (t) => {
	const sop = parentPackage(t, "pi-sop", { entry: "src/index.ts" });
	const sysmon = parentPackage(t, "pi-sysmon", { entry: "src/index.ts" });
	const index = packageIndex("/srv/pi", []);
	const mapping = mapRemoteArgvAllowingSkips(["-e", sop.entry, "-e", sysmon.entry], {
		host: "hw-nj",
		remoteCwd: "/srv/app",
		remoteDir: "/srv/.mirror/r/n",
		localCwd: "/local/app",
		pathMap: [],
		packages: index,
	});
	const plan = planSkippedExtensions({ host: "hw-nj", agentName: "worker", skipped: mapping.skipped, required: ["pi-sop", "pi-sysmon"] });
	assert.ok(plan.refused instanceof SubagentError);
	assert.equal(plan.warnings.length, 0, "a refusal is not also a warning");
	const message = (plan.refused as SubagentError).message;
	assert.match(message, /agent 'worker' declares requiredExtensions that machine cannot load/);
	assert.match(message, /pi-sop \(not installed there\)/);
	assert.match(message, /pi-sysmon \(not installed there\)/);
	// A required name the target CAN load is not a refusal: only the unmet ones are.
	const partial = planSkippedExtensions({ host: "hw-nj", agentName: "worker", skipped: mapping.skipped, required: ["pi-lens"] });
	assert.equal(partial.refused, undefined);
	assert.equal(partial.warnings.length, 1);
});

test("xm-dispatch D2: the skip is scoped to `-e/--extension` — any other unmappable path still refuses", (t) => {
	const sop = parentPackage(t, "pi-sop", { entry: "src/index.ts" });
	const index = packageIndex("/srv/pi", []);
	const outcome = thrownSync(() => mapRemoteArgvAllowingSkips(["--skill", "/opt/loose/thing.md", "-e", sop.entry], {
		host: "hw-nj",
		remoteCwd: "/srv/app",
		remoteDir: "/srv/.mirror/r/n",
		localCwd: "/local/app",
		pathMap: [],
		packages: index,
	}));
	assert.ok(outcome instanceof SubagentError);
	assert.match((outcome as SubagentError).message, /cannot be mapped to that machine/);
	// And the STRICT entry point keeps D6 exactly as it was: the first unmappable
	// extension is refused, so nothing that still uses `mapRemoteArgv` degrades.
	const strict = thrownSync(() => mapRemoteArgv(["-e", sop.entry], {
		host: "hw-nj",
		remoteCwd: "/srv/app",
		remoteDir: "/srv/.mirror/r/n",
		localCwd: "/local/app",
		pathMap: [],
		packages: index,
	}));
	assert.ok(strict instanceof SubagentError);
	assert.match((strict as SubagentError).message, /not installed on that machine/);
});


test("xm-dispatch D2: an `entry-missing` skip is skipped too (a different layout is not a hard failure)", (t) => {
	// The other skippable reason: the package IS there, its declared entries just do not
	// include this one (a version/layout difference). Before D2 that refused the launch.
	const parent = parentPackage(t, "pi-layout", { entry: "extensions/deep/index.ts" });
	const index = packageIndex("/srv/pi", [{ name: "pi-layout", entry: "dist/index.js" }]);
	const mapping = mapRemoteArgvAllowingSkips(["--no-extensions", "-e", parent.entry], {
		host: "hw-nj",
		remoteCwd: "/srv/app",
		remoteDir: "/srv/.mirror/r/n",
		localCwd: "/local/app",
		pathMap: [],
		packages: index,
	});
	assert.deepEqual(mapping.args, ["--no-extensions"]);
	assert.equal(mapping.skipped.length, 1);
	assert.equal(mapping.skipped[0]?.reason, "entry-missing");
	// And a card that REQUIRES it still refuses (the same upgrade path as not-installed).
	const plan = planSkippedExtensions({ host: "hw-nj", agentName: "worker", skipped: mapping.skipped, required: ["pi-layout"] });
	assert.ok(plan.refused instanceof SubagentError);
	assert.match((plan.refused as SubagentError).message, /pi-layout \(entry missing there\)/);
});

test("xm-dispatch D2: a path that is not inside a package keeps the hard refusal (it is not an inherited extension)", (t) => {
	// `no-package` means "this argv element was never an extension we could hand over":
	// a hand-written absolute path is a configuration error, not something to skip.
	const index = packageIndex("/srv/pi", []);
	const outcome = thrownSync(() => mapRemoteArgvAllowingSkips(["-e", "/opt/loose/plugin.ts"], {
		host: "hw-nj",
		remoteCwd: "/srv/app",
		remoteDir: "/srv/.mirror/r/n",
		localCwd: "/local/app",
		pathMap: [],
		packages: index,
	}));
	assert.ok(outcome instanceof SubagentError);
	assert.match((outcome as SubagentError).message, /cannot be mapped to that machine/);
});

test("xm-dispatch D2: the one-token `--extension=<path>` form takes the same rules", (t) => {
	const sop = parentPackage(t, "pi-sop", { entry: "src/index.ts" });
	const index = packageIndex("/srv/pi", []);
	const opts = { host: "hw-nj", remoteCwd: "/srv/app", remoteDir: "/srv/.mirror/r/n", localCwd: "/local/app", pathMap: [], packages: index };
	// Skipped like the pair form (the args builder emits pairs; a hand-written launch
	// may not, and an absolute parent path in it must not reach the remote `pi`).
	const mapping = mapRemoteArgvAllowingSkips([`--extension=${sop.entry}`, "--model", "x"], opts);
	assert.deepEqual(mapping.args, ["--model", "x"]);
	assert.equal(mapping.skipped.length, 1);
	// And the strict walk refuses it exactly like the pair form.
	const strict = thrownSync(() => mapRemoteArgv([`--extension=${sop.entry}`], opts));
	assert.ok(strict instanceof SubagentError);
	assert.match((strict as SubagentError).message, /not installed on that machine/);
});

test("xm-dispatch D4: the ASYNC resolver carries allowRoles onto the target (the tool launch path)", async (t) => {
	// Every real launch resolves its target through the async resolver, so a whitelist
	// that only the sync one stamped would silently fall back to the default and make
	// `subagents.crossMachine.allowRoles` a no-op.
	clearHostDiscoveryCache();
	const machine = fakeMachine(t);
	const client = new FakeClient({
		machines: () => ({ machines: [{ name: "fakebox" }] }),
		exec: () => probeResult(runProbe(machine)),
	});
	const resolved = await resolveHostTargetAsync(
		"fakebox",
		{ enabled: true, allowRoles: ["centurion", "worker"], hosts: { fakebox: { cwd: "/srv/app" } } },
		{ client, cacheDir: null },
	);
	assert.deepEqual(resolved.allowRoles, ["centurion", "worker"]);
	// Absent stays absent: the default lives with the launch guard, so an unconfigured
	// target keeps the exact pre-v1.6 shape.
	const plain = await resolveHostTargetAsync(
		"fakebox",
		{ enabled: true, hosts: { fakebox: { cwd: "/srv/app" } } },
		{ client, cacheDir: null },
	);
	assert.equal(plain.allowRoles, undefined);
});

test("xm-model-fallback: the ASYNC resolver carries hosts.<h>.model onto the target too", async (t) => {
	// The tool launch path resolves its target here, so a `model` key only the sync
	// resolver stamped would be a key no real launch ever sees — the same trap
	// `allowRoles` fell into, one stage earlier.
	clearHostDiscoveryCache();
	const machine = fakeMachine(t);
	const client = new FakeClient({
		machines: () => ({ machines: [{ name: "fakebox" }] }),
		exec: () => probeResult(runProbe(machine)),
	});
	const resolved = await resolveHostTargetAsync(
		"fakebox",
		{ enabled: true, hosts: { fakebox: { cwd: "/srv/app", model: "codebuddy/glm-5.2" } } },
		{ client, cacheDir: null },
	);
	assert.equal(resolved.model, "codebuddy/glm-5.2");
	// Absent stays absent (the fallback to that machine's listing is the launch's rule).
	const plain = await resolveHostTargetAsync(
		"fakebox",
		{ enabled: true, hosts: { fakebox: { cwd: "/srv/app" } } },
		{ client, cacheDir: null },
	);
	assert.equal(plain.model, undefined);
});

// ── 2b. extensions by package name (v1.2) ──────────────────────────────────

/**
 * A parent-side npm package tree, like the one `--extension` paths come from:
 * `<root>/node_modules/<name>/{package.json, extensions/index.ts}` (plus an
 * alternate layout for the "different entry" case).
 */
function parentPackage(t: { after: (fn: () => void) => void }, name: string, layout: { entry: string }): { dir: string; entry: string; cleanup: () => void } {
	const root = mkdtempSync(path.join(tmpdir(), "legion-parent-pkg-"));
	const dir = path.join(root, "node_modules", name);
	const entry = path.join(dir, layout.entry);
	mkdirSync(path.dirname(entry), { recursive: true });
	writeFileSync(entry, "export const x = 1;\n");
	writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name, pi: { extensions: [`./${layout.entry}`] } }));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	return { dir, entry, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function packageIndex(hostRoot: string, packages: Array<{ name: string; entry?: string }>) {
	const index = {
		packages: [] as Array<{ name: string; dir: string }>,
		entries: [] as Array<{ name: string; relative: string; path: string }>,
	};
	for (const pkg of packages) {
		const dir = path.posix.join(hostRoot, "npm", "node_modules", pkg.name);
		index.packages.push({ name: pkg.name, dir });
		if (pkg.entry !== undefined) {
			index.entries.push({ name: pkg.name, relative: pkg.entry, path: path.posix.join(dir, pkg.entry) });
		}
	}
	return index;
}

test("v1.2 extensions: a parent package path is re-rooted by PACKAGE NAME when the target has the same package", (t) => {
	const parent = parentPackage(t, "pi-any-endpoint", { entry: "extensions/index.ts" });
	const remoteRoot = "/srv/pi";
	const index = packageIndex(remoteRoot, [{ name: "pi-any-endpoint", entry: "extensions/index.ts" }]);
	// The manifest walk finds the package, not the file.
	assert.deepEqual(localPackageForFile(parent.entry), { name: "pi-any-endpoint", dir: parent.dir });
	const resolved = resolvePackagePathOnHost(parent.entry, index);
	assert.deepEqual(resolved, {
		ok: true,
		path: "/srv/pi/npm/node_modules/pi-any-endpoint/extensions/index.ts",
		packageName: "pi-any-endpoint",
		relative: "extensions/index.ts",
	});
	// And `mapRemoteArgv` actually returns that path for the `-e <path>` pair.
	assert.deepEqual(
		mapRemoteArgv(["--no-extensions", "-e", parent.entry, "--model", "x"], {
			host: "hw-nj",
			remoteCwd: "/srv/app",
			remoteDir: "/srv/.mirror/r/n",
			localCwd: "/local/app",
			pathMap: [],
			packages: index,
		}),
		["--no-extensions", "-e", "/srv/pi/npm/node_modules/pi-any-endpoint/extensions/index.ts", "--model", "x"],
	);
});

test("v1.2 extensions: the package is ABSENT there — refuse before launch, naming package, path and the fix", (t) => {
	const parent = parentPackage(t, "pi-sysmon", { entry: "src/index.ts" });
	const index = packageIndex("/srv/pi", [{ name: "pi-any-endpoint", entry: "extensions/index.ts" }]);
	const outcome = thrownSync(() => mapRemoteArgv(["-e", parent.entry], {
		host: "hw-nj",
		remoteCwd: "/srv/app",
		remoteDir: "/srv/.mirror/r/n",
		localCwd: "/local/app",
		pathMap: [],
		packages: index,
	}));
	assert.ok(outcome instanceof SubagentError);
	const message = (outcome as SubagentError).message;
	assert.match(message, /the extension '.*pi-sysmon\/src\/index\.ts' belongs to package 'pi-sysmon'/);
	assert.match(message, /which is not installed on that machine/, "the greppable sentence is preserved verbatim (D4)");
	// D4: TWO ways out, both pasteable, and no reader has to open the source.
	assert.match(message, /Two ways out: 1\) install it there — hc exec --on hw-nj -- pi install npm:pi-sysmon \(same entry names are then mapped automatically\)/);
	// No role at this layer (resume / read-back): the second way out names the key
	// with a placeholder and omits the JSON, because a JSON for `<role>` is not a
	// pasteable fix.
	assert.match(message, /2\) keep it on this machine only, for the role you launch: subagents\.agentOverrides\.<role>\.excludeExtensions/);
	assert.doesNotMatch(message, /agentOverrides":\{/, "no role, no JSON block");
	assert.deepEqual((outcome as SubagentError).details, {
		host: "hw-nj",
		extension: parent.entry,
		package: "pi-sysmon",
		reason: "not-installed",
		// A6: a package that is not on that machine is deterministic, so the
		// candidate chain must not retry it. (This assertion was stale at HEAD:
		// `remote.ts` gained the flag in 3752669, the expectation did not.)
		noModelFallback: true,
	});
});

test("v1.2/D4: with a role, the missing-package refusal carries the concrete excludeExtensions JSON (and it parses as settings)", (t) => {
	const parent = parentPackage(t, "pi-sysmon", { entry: "src/index.ts" });
	const index = packageIndex("/srv/pi", [{ name: "pi-any-endpoint", entry: "extensions/index.ts" }]);
	const outcome = thrownSync(() => mapRemoteArgv(["-e", parent.entry], {
		host: "hw-nj",
		remoteCwd: "/srv/app",
		remoteDir: "/srv/.mirror/r/n",
		localCwd: "/local/app",
		pathMap: [],
		packages: index,
		role: "centurion",
	}));
	assert.ok(outcome instanceof SubagentError);
	const message = (outcome as SubagentError).message;
	assert.match(message, /for role 'centurion': subagents\.agentOverrides\.centurion\.excludeExtensions/);
	const json = message.match(/\{"subagents":\{"agentOverrides":\{.*\}\}\}/)?.[0];
	assert.ok(json, `expected the settings JSON in the message, got:\n${message}`);
	assert.equal(
		json,
		'{"subagents":{"agentOverrides":{"centurion":{"excludeExtensions":["pi-sysmon"]}}}}',
	);
	// Settings-shaped, not prose-shaped: the operator can paste it into settings.json.
	const parsed = JSON.parse(json) as { subagents?: { agentOverrides?: Record<string, { excludeExtensions?: string[] }> } };
	assert.deepEqual(parsed.subagents?.agentOverrides?.centurion?.excludeExtensions, ["pi-sysmon"]);
	assert.equal(((outcome as SubagentError).details as { role?: string }).role, "centurion");
});

test("v1.2 extensions: the package IS there but the entry differs — refuse, listing what it declares", (t) => {
	const parent = parentPackage(t, "pi-any-endpoint", { entry: "extensions/index.ts" });
	const index = packageIndex("/srv/pi", [{ name: "pi-any-endpoint", entry: "dist/index.js" }]);
	const outcome = thrownSync(() => resolvePackagePathOnHost(parent.entry, index));
	assert.ok(outcome === undefined, "resolvePackagePathOnHost reports, it does not throw");
	const resolution = resolvePackagePathOnHost(parent.entry, index);
	assert.equal(resolution.ok, false);
	assert.equal(resolution.ok === false ? resolution.reason : "", "entry-missing");
	const refusal = thrownSync(() => mapRemoteArgv(["-e", parent.entry], {
		host: "hw-nj",
		remoteCwd: "/srv/app",
		remoteDir: "/srv/.mirror/r/n",
		localCwd: "/local/app",
		pathMap: [],
		packages: index,
	}));
	assert.ok(refusal instanceof SubagentError);
	assert.match((refusal as SubagentError).message, /package 'pi-any-endpoint' IS installed there at \/srv\/pi\/npm\/node_modules\/pi-any-endpoint/);
	assert.match((refusal as SubagentError).message, /does not expose '\.\/extensions\/index\.ts'/);
	assert.match((refusal as SubagentError).message, /declared: \.\/dist\/index\.js -> \/srv\/pi\/npm\/node_modules\/pi-any-endpoint\/dist\/index\.js/);
});

test("xm-dispatch D1: a package that declares a DIRECTORY covers the entries inside it (pi-autoresearch@1.9.0 layout)", (t) => {
	// The real failure: `pi.extensions: ["./extensions"]` on both machines, the file
	// `extensions/pi-autoresearch/index.ts` present on both, and the launch refused
	// because the remote manifest never spelled that file out.
	const root = mkdtempSync(path.join(tmpdir(), "legion-parent-pkg-"));
	const dir = path.join(root, "node_modules", "pi-autoresearch");
	const entry = path.join(dir, "extensions", "pi-autoresearch", "index.ts");
	mkdirSync(path.dirname(entry), { recursive: true });
	writeFileSync(entry, "export const x = 1;\n");
	writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "pi-autoresearch", pi: { extensions: ["./extensions"] } }));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const index = packageIndex("/srv/pi", [{ name: "pi-autoresearch", entry: "extensions" }]);
	assert.deepEqual(resolvePackagePathOnHost(entry, index), {
		ok: true,
		path: "/srv/pi/npm/node_modules/pi-autoresearch/extensions/pi-autoresearch/index.ts",
		packageName: "pi-autoresearch",
		relative: "extensions/pi-autoresearch/index.ts",
	});
	assert.deepEqual(
		mapRemoteArgv(["--no-extensions", "-e", entry], {
			host: "hw-nj",
			remoteCwd: "/srv/app",
			remoteDir: "/srv/.mirror/r/n",
			localCwd: "/local/app",
			pathMap: [],
			packages: index,
		}),
		["--no-extensions", "-e", "/srv/pi/npm/node_modules/pi-autoresearch/extensions/pi-autoresearch/index.ts"],
	);
});

test("xm-dispatch D1: a directory declaration is matched on the `/` boundary, never as a bare string prefix", (t) => {
	const parent = parentPackage(t, "pi-sibling", { entry: "extensions/a/index.ts" });
	// Declared `extensions` must not cover a sibling directory whose name merely
	// STARTS with it — `extensions-other/a/index.ts` is not under `extensions/`.
	const index = packageIndex("/srv/pi", [{ name: "pi-sibling", entry: "extensions" }]);
	const resolution = resolvePackagePathOnHost(
		path.join(parent.dir, "extensions-other", "a", "index.ts"),
		index,
	);
	assert.equal(resolution.ok, false);
	assert.equal(resolution.ok === false ? resolution.reason : "", "entry-missing");
});

test("xm-dispatch D1: a FILE declaration still refuses an entry it does not name (the only failing case)", (t) => {
	const parent = parentPackage(t, "pi-autoresearch", { entry: "extensions/pi-autoresearch/index.ts" });
	// The target holds the package at a DIFFERENT layout: a file declaration cannot
	// be widened by the directory rule, so this must stay `entry-missing`.
	const index = packageIndex("/srv/pi", [{ name: "pi-autoresearch", entry: "dist/index.js" }]);
	const resolution = resolvePackagePathOnHost(parent.entry, index);
	assert.equal(resolution.ok, false);
	assert.equal(resolution.ok === false ? resolution.reason : "", "entry-missing");
	const refusal = thrownSync(() => mapRemoteArgv(["-e", parent.entry], {
		host: "hw-nj",
		remoteCwd: "/srv/app",
		remoteDir: "/srv/.mirror/r/n",
		localCwd: "/local/app",
		pathMap: [],
		packages: index,
	}));
	assert.ok(refusal instanceof SubagentError);
	assert.match((refusal as SubagentError).message, /does not expose/);
});

test("v1.2 extensions: the probe index is only fetched when an argv path NEEDS it", () => {
	const legionEntry = path.posix.join(thisPackageRoot(), "index.ts");
	const base = { remoteCwd: "/srv/app", remoteDir: "/srv/.mirror/r/n", localCwd: "/local/app" };
	// This package's own entry is covered by the automatic pathMap entry.
	assert.equal(needsPackageIndex(["-e", legionEntry], {
		...base,
		pathMap: [{ from: thisPackageRoot(), to: "/srv/legion" }],
	}), false);
	// An inherited extension is not.
	assert.equal(needsPackageIndex(["-e", "/Users/me/.pi/agent/npm/node_modules/pi-async/extensions/index.ts"], {
		...base,
		pathMap: [{ from: thisPackageRoot(), to: "/srv/legion" }],
	}), true);
	// Mirrored files and checkout paths are already decided.
	assert.equal(needsPackageIndex(["/srv/.mirror/r/n/system-prompt.md", path.join(base.localCwd, "agents/a.md")], base), false);
});

// ── 3. the resolver: explicit wins, discovered fills ───────────────────────

test("v1.1 resolver: a fully explicit entry is BYTE-IDENTICAL to the pre-v1.1 target (no probe at all)", async (t) => {
	clearHostDiscoveryCache();
	const machine = fakeMachine(t);
	const client = new FakeClient({
		machines: () => ({ machines: [{ name: "vps" }] }),
		exec: () => probeResult(runProbe(machine)),
	});
	const legacy = config({
		vps: {
			cwd: "/srv/app",
			node: "/opt/node/bin/node",
			piCli: "/opt/pi/dist/bundle/cli.js",
			piLegionRoot: "/srv/legion",
		},
	});
	const resolved = await resolveHostTargetAsync("vps", legacy, { client, cacheDir: null });
	// The pre-v1.1 object, field for field — no `discovered`, no `discovery`, no
	// `rediscover`. This is the backward-compatibility proof.
	assert.deepEqual(resolved, {
		host: "vps",
		cwd: "/srv/app",
		node: "/opt/node/bin/node",
		piCli: "/opt/pi/dist/bundle/cli.js",
		pathMap: [{ from: thisPackageRoot(), to: "/srv/legion" }],
		piLegionRoot: "/srv/legion",
		piExtensions: [],
		mirrorRoot: "/srv/.pi-subagents-mirror",
		worktreeRoot: "/srv/.pi-worktrees",
	});
	assert.deepEqual(client.paramsFor("machine.exec"), [], "a complete entry must not probe the target");
});

test("v1.1 resolver: an empty entry ({}) is filled from the probe, explicit values still win", async (t) => {
	clearHostDiscoveryCache();
	const machine = fakeMachine(t);
	const client = new FakeClient({
		machines: () => ({ machines: [{ name: "fakebox" }] }),
		exec: () => probeResult(runProbe(machine)),
	});
	const resolved = await resolveHostTargetAsync(
		"fakebox",
		{ hosts: { fakebox: { cwd: "/srv/app", node: machine.shimNode } } },
		{ client, cacheDir: null },
	);
	assert.equal(resolved.cwd, "/srv/app");
	// Explicit node wins — even though it is the shim the operator wrote by hand.
	assert.equal(resolved.node, machine.shimNode);
	// The missing fields come from the probe.
	assert.equal(resolved.piCli, machine.piEntry);
	assert.equal(resolved.piLegionRoot, machine.legionRoot);
	assert.deepEqual(resolved.piExtensions, [machine.providerExtension]);
	assert.deepEqual(resolved.discovered, ["piCli", "piLegionRoot", "piExtensions"]);
	assert.equal(typeof resolved.rediscover, "function");
});

test("v1.1 resolver: an explicitly EMPTY piExtensions wins over the discovered provider", async (t) => {
	clearHostDiscoveryCache();
	const machine = fakeMachine(t);
	const client = new FakeClient({
		machines: () => ({ machines: [{ name: "fakebox" }] }),
		exec: () => probeResult(runProbe(machine)),
	});
	const resolved = await resolveHostTargetAsync(
		"fakebox",
		{ hosts: { fakebox: { cwd: "/srv/app", piExtensions: [] } } },
		{ client, cacheDir: null },
	);
	assert.deepEqual(resolved.piExtensions, []);
});

test("v1.1 resolver: discover:false never probes and keeps the pre-v1.1 defaults", async () => {
	clearHostDiscoveryCache();
	const client = new FakeClient({ machines: () => ({ machines: [{ name: "vps" }] }) });
	const resolved = await resolveHostTargetAsync(
		"vps",
		{ hosts: { vps: { cwd: "/srv/app", discover: false } } },
		{ client, cacheDir: null },
	);
	assert.equal(resolved.node, "node");
	assert.equal(resolved.piCli, "pi");
	assert.equal(resolved.piLegionRoot, thisPackageRoot());
	assert.deepEqual(client.paramsFor("machine.exec"), []);
});

test("v1.1 cwd: the per-call override wins over the host default, and must be absolute", () => {
	const legacy = config({ vps: { cwd: "/srv/default" } });
	const resolved = resolveHostTarget("vps", legacy, { cwd: "/srv/other-project" });
	assert.equal(resolved.cwd, "/srv/other-project");
	// The default still wins when no override is given.
	assert.equal(resolveHostTarget("vps", legacy).cwd, "/srv/default");
	const relative = thrownSync(() => resolveHostTarget("vps", legacy, { cwd: "other-project" }));
	assert.ok(relative instanceof SubagentError);
	assert.match((relative as SubagentError).message, /per-call cwd override must be an absolute path/);
	// No default and no override: refuse, never guess HOME. D2: the answer is the
	// question (which directory on that machine?), not an instruction to edit a
	// settings file — the resolver's callers include the read-back paths.
	const none = thrownSync(() => resolveHostTarget("vps", config({ vps: {} })));
	assert.ok(none instanceof SubagentError);
	assert.equal((none as SubagentError).message, missingRemoteCwdQuestion("vps"));
});

test("v1.1 tool params: an absolute cwd next to a host is REMOTE, a relative one keeps its old local meaning", () => {
	// `subagent({ host, cwd })` — the spelling the feature was asked for.
	assert.equal(firstRemoteCwd(undefined, "/srv/proj"), "/srv/proj");
	assert.equal(firstRemoteCwd("/srv/explicit", "/srv/proj"), "/srv/explicit", "hostCwd wins");
	assert.equal(firstRemoteCwd("relative/path", ""), undefined);
	assert.equal(cwdIsRemote({ host: "vps", cwd: "/srv/proj" }), true);
	// A remote cwd must never become this process's store dir.
	assert.equal(cwdIsRemote({ cwd: "/srv/proj" }), false, "no host = local, exactly as before");
	assert.equal(cwdIsRemote({ host: "vps", cwd: "sub/dir" }), false, "relative keeps its local meaning");
	assert.equal(cwdIsRemote({ host: "vps", hostCwd: "/srv/proj" }), true);
});

test("D5: `localRepoFor` resolves a RELATIVE cwd against the SESSION dir and never the remote one", () => {
	// The reported bug: with `host` named, a relative `cwd` points at a checkout on
	// THIS machine, so the parent side is that resolved directory — while an
	// ABSOLUTE `cwd` (or `hostCwd`) is the directory ON that machine and must not
	// be handed to git here.
	assert.equal(localRepoFor("/Users/me/agents", "../my-repo"), path.resolve("/Users/me/agents", "../my-repo"));
	assert.equal(localRepoFor("/Users/me/agents", "sub/dir"), "/Users/me/agents/sub/dir");
	// Absolute = remote: skipped, so the session directory stays the parent side.
	assert.equal(localRepoFor("/Users/me/agents", "/srv/app"), "/Users/me/agents");
	assert.equal(localRepoFor("/Users/me/agents"), "/Users/me/agents", "nothing named = the session dir, exactly as before");
	assert.equal(localRepoFor("/Users/me/agents", "   ", ""), "/Users/me/agents", "blank is not a path");
	// Step precedence: a step's own relative cwd wins over the call-level one, and a
	// remote step cwd falls through to a local call-level cwd.
	assert.equal(localRepoFor("/session", "step/dir", "call/dir"), "/session/step/dir");
	assert.equal(localRepoFor("/session", "/srv/step", "call/dir"), "/session/call/dir");
});

test("v1.1 machine.list parsing survives the shapes a core may answer", () => {
	assert.deepEqual(parseMachineList({ machines: [{ name: "a" }, "b"] })?.map((entry) => entry.name), ["a", "b"]);
	assert.deepEqual(parseMachineList([{ id: "c" }])?.map((entry) => entry.name), ["c"]);
	assert.deepEqual(parseMachineList({ items: [{ machine: "d" }] })?.map((entry) => entry.name), ["d"]);
	assert.equal(parseMachineList({ nope: true }), undefined);
});

// ── 4. caching ─────────────────────────────────────────────────────────────

test("v1.1 cache: one probe serves many launches, refresh re-probes, and the TTL expires", async (t) => {
	clearHostDiscoveryCache();
	const machine = fakeMachine(t);
	let now = 1_000_000;
	const text = runProbe(machine);
	const client = new FakeClient({
		machines: () => ({ machines: [{ name: "fakebox" }] }),
		exec: () => probeResult(text),
	});
	const cfg = { hosts: { fakebox: { cwd: "/srv/app" } } };
	const opts = { client, cacheDir: null, now: () => now };
	await resolveHostTargetAsync("fakebox", cfg, opts);
	await resolveHostTargetAsync("fakebox", cfg, opts);
	assert.equal(client.paramsFor("machine.exec").length, 1, "the second launch reuses the cached report");
	// A fresh probe on demand (the `crossMachine.refresh` switch, or doctor --refresh).
	await resolveHostTargetAsync("fakebox", { ...cfg, refresh: true }, opts);
	assert.equal(client.paramsFor("machine.exec").length, 2);
	// Past the TTL the cache is stale even without `refresh`: this is what heals a
	// target that upgraded `pi` while the parent kept running.
	now += 15 * 60 * 1000 + 1;
	await resolveHostTargetAsync("fakebox", cfg, opts);
	assert.equal(client.paramsFor("machine.exec").length, 3);
});

test("v1.1 cache: a failed probe is never cached, so installing the tool fixes the next launch", async (t) => {
	clearHostDiscoveryCache();
	const machine = fakeMachine(t);
	const emptyBin = path.join(machine.root, "empty-bin");
	mkdirSync(emptyBin, { recursive: true });
	const broken = execFileSync("/bin/sh", ["-c", remoteDiscoveryScript()], {
		encoding: "utf8",
		env: { ...process.env, HOME: machine.home, PATH: `${emptyBin}:/usr/bin:/bin` },
	});
	let text = broken;
	const client = new FakeClient({
		machines: () => ({ machines: [{ name: "fakebox" }] }),
		exec: () => probeResult(text),
	});
	const cfg = { hosts: { fakebox: { cwd: "/srv/app" } } };
	const first = await thrown(() => resolveHostTargetAsync("fakebox", cfg, { client, cacheDir: null }));
	assert.ok(first instanceof SubagentError);
	// The operator installs node/pi; the next launch must not reuse the failure.
	text = runProbe(machine);
	const resolved = await resolveHostTargetAsync("fakebox", cfg, { client, cacheDir: null });
	assert.equal(resolved.node, machine.realNode);
	assert.equal(client.paramsFor("machine.exec").length, 2);
});

test("v1.1 cache: the disk cache survives a process (and is what a fresh pi reuses)", async (t) => {
	clearHostDiscoveryCache();
	const machine = fakeMachine(t);
	const cacheDir = path.join(machine.root, "cache");
	const text = runProbe(machine);
	const client = new FakeClient({
		machines: () => ({ machines: [{ name: "fakebox" }] }),
		exec: () => probeResult(text),
	});
	const env = { ...process.env, XDG_CACHE_HOME: cacheDir };
	const opts = { client, env, useMemoryCache: false };
	const first = await discoverHost("fakebox", undefined, opts);
	assert.equal(first.source, "probe");
	// A second "process" has no memory cache — it reads the file.
	const second = await discoverHost("fakebox", undefined, opts);
	assert.equal(second.source, "disk-cache");
	assert.equal(second.source === "disk-cache" ? second.node?.binary : undefined, machine.realNode);
	assert.equal(client.paramsFor("machine.exec").length, 1);
	// `clearHostDiscoveryCache(host)` deletes the file too.
	clearHostDiscoveryCache("fakebox", env);
	const third = await discoverHost("fakebox", undefined, opts);
	assert.equal(third.source, "probe");
});

test("v1.1 probe timeout is reported as a timeout, not as a missing field", async () => {
	clearHostDiscoveryCache();
	const client = new FakeClient({
		machines: () => ({ machines: [{ name: "vps" }] }),
		exec: () => ({ code: null, timed_out: true, stdout: b64(""), stderr: b64("") }),
	});
	const error = await thrown(() => probeHost("vps", { client }));
	assert.ok(error instanceof SubagentError);
	assert.match((error as SubagentError).message, /host discovery timed out/);
});
