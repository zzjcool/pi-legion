/**
 * The cross-machine checkup (contract `first-run-success-v1` D6/D7/D8/D10).
 *
 * What this file pins, and nowhere else:
 *
 *   - the frozen item ORDER and the three statuses, on a host where everything
 *     works — a checkup that reported PASS on a machine it never asked about
 *     would be worse than the sync section it replaces;
 *   - the parent-side three answers (D5): a real checkout with an origin, and a
 *     session directory that is NOT one (the sentence must be D5's, not "git
 *     remote add origin" in a directory that is not a repository — pitfall #1);
 *   - the v1.1 minimal configuration (`{enabled:true}`, no `hosts` block): the
 *     host comes from `machine list` with `source: "hc"`, and with no directory
 *     named anywhere the D2 QUESTION is the answer and no launch line is printed;
 *   - D4's fix: a package missing on the target FAILs with the concrete role and
 *     with settings JSON that `JSON.parse`s — the key the reader would otherwise
 *     have to look up in the source (pitfall #2);
 *   - a missing model lists what the target DOES serve (pitfall #5);
 *   - an old core (`machine.list` unsupported) is a SKIP, never a throw and never
 *     "no machines": the hosts this configuration names are still checked;
 *   - a transport failure FAILs the item that hit it and SKIPs the rest with the
 *     reason, instead of five identical failures.
 *
 * Everything is an in-process recording client (the pattern of
 * `cross-machine-preflight.test.ts`'s `FakePreflightClient`) plus a real
 * temporary git repo — no socket, no `hc`, no second machine.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { HcRpcError, type HcClient, type HcMethod } from "../../src/hc/client.ts";
import type { AgentConfig, SubagentsSettings } from "../../src/shared/types.ts";
import { crossMachineCheckupRequested, runCrossMachineCheckup } from "../../src/runs/cross-machine-checkup.ts";
import { clearHostDiscoveryCache } from "../../src/runs/remote.ts";
import { ensureHostExtensions, resetExtensionDiscoveryCache } from "../../src/runs/extension-inheritance.ts";
import type { HcExecResult } from "../../src/runs/remote.ts";

// ── fixtures ───────────────────────────────────────────────────────────────

type Params = Record<string, unknown>;

interface Call {
	method: HcMethod;
	params: Params;
}

/**
 * A protocol client that answers `machine.list` + `machine.exec` per handler and
 * records every call.
 *
 * `machineList` absent = an OLD core: the method is refused the way a core that
 * predates the registry refuses it, which is the third answer `listHcMachines`
 * is built to preserve.
 */
class FakeCheckupClient implements HcClient {
	readonly calls: Call[] = [];
	machineList: (() => unknown) | undefined;
	private readonly execHandlers: Array<{ match: (params: Params) => boolean; answer: () => unknown }> = [];

	onMachineList(answer: () => unknown): this {
		this.machineList = answer;
		return this;
	}

	onExec(match: (params: Params) => boolean, answer: () => unknown): this {
		this.execHandlers.push({ match, answer });
		return this;
	}

	/** Answer by the argv the target would run (`argv` joined with spaces). */
	onArgv(fragment: string, answer: () => unknown): this {
		return this.onExec(
			(params) => Array.isArray(params.argv) && (params.argv as string[]).join(" ").includes(fragment),
			answer,
		);
	}

	/** The discovery probe is the ONE `machine.exec` that travels as a shell line. */
	onLine(answer: () => unknown): this {
		return this.onExec((params) => typeof params.line === "string", answer);
	}

	/** Same as {@link onArgv}, checked BEFORE earlier answers (per-test overrides). */
	override(fragment: string, answer: () => unknown): this {
		this.execHandlers.unshift({
			match: (params) => Array.isArray(params.argv) && (params.argv as string[]).join(" ").includes(fragment),
			answer,
		});
		return this;
	}

	async start(): Promise<void> {}
	async close(): Promise<void> {}

	async request<T = unknown>(method: HcMethod, params: Params = {}): Promise<T> {
		this.calls.push({ method, params });
		if (method === "machine.list") {
			if (this.machineList === undefined) {
				const error = new HcRpcError({ code: -32601, message: "unknown method machine.list" });
				// The kind is what `listHcMachines` branches on (never the prose).
				Object.defineProperty(error, "kind", { value: "method_not_found", enumerable: true });
				throw error;
			}
			return this.machineList() as T;
		}
		if (method !== "machine.exec") throw new Error(`unexpected method ${method}`);
		for (const handler of this.execHandlers) {
			if (handler.match(params)) return handler.answer() as T;
		}
		throw new Error(`no handler for ${JSON.stringify(params)}`);
	}

	execs(): Params[] {
		return this.calls.filter((call) => call.method === "machine.exec").map((call) => call.params);
	}

	/** Every `machine.exec` as `argv.join(" ")` (or its shell line), in order. */
	commands(): string[] {
		return this.execs().map((params) =>
			Array.isArray(params.argv) ? (params.argv as string[]).join(" ") : String(params.line ?? ""),
		);
	}
}

/** A `machine.exec` result carrying BASE64 streams, like the real core. */
function execResult(overrides: Partial<HcExecResult> = {}): HcExecResult {
	return { code: 0, ms: 2, signal: null, stdout: "", stderr: "", truncated: false, timed_out: false, ...overrides };
}

function base64(text: string): string {
	return Buffer.from(text, "utf8").toString("base64");
}

/** One answer per probe, in the shape the real core sends them back. */
function stdoutResult(text: string): HcExecResult {
	return execResult({ stdout: base64(text) });
}

const HOST = "fakebox";
const REMOTE_CWD = "/srv/app";
// Deliberately not a github.com url: a machine-level `url.<base>.insteadOf`
// rewrites those, and the checkup reads what git ANSWERS, not what was written.
const LOCAL_ORIGIN = "https://git.example.invalid/acme/app.git";
const MODEL = "workbuddy/deepseek-v4.1-flash";

/** A local git checkout with `origin` set (the parent D5 asks about). */
function localRepo(origin: string | undefined = LOCAL_ORIGIN): { root: string; repo: string; cleanup: () => void } {
	const root = mkdtempSync(path.join(tmpdir(), "cross-machine-checkup-unit-"));
	const repo = path.join(root, "repo");
	mkdirSync(repo, { recursive: true });
	execFileSync("git", ["init", "--quiet", repo], { stdio: "ignore" });
	if (origin !== undefined) execFileSync("git", ["-C", repo, "remote", "add", "origin", origin], { stdio: "ignore" });
	return { root, repo, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** The role cards a launch would use. */
function role(name: string, extra: Partial<AgentConfig> = {}): AgentConfig {
	return {
		name,
		description: `${name} role`,
		kind: "pi",
		source: "user",
		filePath: `/tmp/${name}.md`,
		systemPrompt: `You are ${name}.`,
		systemPromptMode: "append",
		inheritProjectContext: false,
		inheritSkills: false,
		...extra,
	};
}

/** A hermetic env: no inherited-extension kill switch, and a scratch host cache. */
function testEnv(cacheDir: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
	return {
		...process.env,
		XDG_CACHE_HOME: cacheDir,
		PI_LEGION_CHILD_INHERIT_EXTENSIONS: undefined,
		PI_LEGION_CHILD_EXTENSIONS: undefined,
		...extra,
	};
}

/**
 * The discovery probe's answer: `KEY<TAB>VALUE`, one fact per line, exactly what
 * `parseDiscoveryReport` reads.
 *
 * `packages` is what makes the inheritance item checkable at all (v1.2 re-roots a
 * parent package path by NAME), so a host resolved through discovery gets an
 * index and a host resolved from an explicit entry does not (the case the
 * on-demand loader exists for).
 */
function discoveryPayload(options: { packages?: string[] } = {}): string {
	const packages = options.packages ?? ["pi-sysmon", "pi-any-endpoint"];
	const rows = [
		"MACHINE\tfakebox",
		"NODE_CMD\t/usr/bin/node",
		"NODE_BIN\t/usr/bin/node",
		"NODE_VERSION\tv20.11.0",
		"PI_CMD\t/usr/local/bin/pi",
		"PI_ENTRY\t/srv/pi/dist/bundle/cli.js",
		"PI_VERSION\t1.5.2",
		"LEGION_ROOT\t/srv/pi-legion",
	];
	for (const name of packages) {
		const dir = `/srv/npm/node_modules/${name}`;
		const relative = name === "pi-any-endpoint" ? "extensions/index.ts" : "src/index.ts";
		rows.push(`PKG\t${name}\t${dir}`);
		rows.push(`PKGENTRY\t${name}\t${relative}\t${dir}/${relative}`);
		rows.push(`EXT\t${name}\t${dir}/${relative}\t${name === "pi-any-endpoint" ? "1" : "0"}`);
	}
	rows.push("PROBE_OK\t1");
	return `${rows.join("\n")}\n`;
}

/** A fully explicit host entry: every field written, so NO discovery probe runs. */
function explicitHost(overrides: Record<string, unknown> = {}) {
	return {
		cwd: REMOTE_CWD,
		node: "/usr/bin/node",
		piCli: "/srv/pi/dist/bundle/cli.js",
		piLegionRoot: "/srv/pi-legion",
		...overrides,
	};
}

/** The green answer for every probe of a working target. */
function healthyTarget(options: { models?: string; packages?: string[] } = {}): FakeCheckupClient {
	const client = new FakeCheckupClient();
	client.onMachineList(() => [{ name: HOST }]);
	client.onLine(() => stdoutResult(discoveryPayload({ packages: options.packages })));
	client.onArgv(`test -d ${REMOTE_CWD}`, () => execResult({ code: 0 }));
	client.onArgv(`git -C ${REMOTE_CWD} rev-parse --git-dir`, () => stdoutResult(".git\n"));
	client.onArgv(`git -C ${REMOTE_CWD} remote get-url origin`, () => stdoutResult(`${LOCAL_ORIGIN}\n`));
	client.onArgv("/usr/bin/node --version", () => stdoutResult("v20.11.0\n"));
	client.onArgv("/srv/pi/dist/bundle/cli.js --version", () => stdoutResult("1.5.2\n"));
	client.onArgv("--list-models", () =>
		stdoutResult(options.models ?? "PROVIDER\tMODEL\tCONTEXT\nworkbuddy\tdeepseek-v4.1-flash\t200k\tctx\n"),
	);
	return client;
}

/**
 * A `pi` on PATH that reports one package directory — the same fixture
 * `legion-doctor.test.ts` uses for #317, so host-extension discovery is real.
 */
function hostExtensionPackage(name = "pi-sysmon"): {
	packageDir: string;
	entry: string;
	pathValue: string;
	cleanup: () => void;
} {
	const root = mkdtempSync(path.join(tmpdir(), "cross-machine-checkup-pi-"));
	const packageDir = path.join(root, "npm", "node_modules", name);
	mkdirSync(path.join(packageDir, "src"), { recursive: true });
	writeFileSync(
		path.join(packageDir, "package.json"),
		JSON.stringify({ name, version: "1.0.0", pi: { extensions: ["src/index.ts"] } }),
	);
	const entry = path.join(packageDir, "src", "index.ts");
	writeFileSync(entry, "export default {};\n");
	const bin = path.join(root, "bin");
	mkdirSync(bin, { recursive: true });
	writeFileSync(
		path.join(bin, "pi"),
		["#!/bin/sh", "echo 'User packages:'", `echo '    ${packageDir}'`].join("\n") + "\n",
	);
	chmodSync(path.join(bin, "pi"), 0o755);
	return {
		packageDir,
		entry,
		pathValue: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
		cleanup: () => rmSync(root, { recursive: true, force: true }),
	};
}

/** Warm `discoveredHostExtensions()` with one `pi list` (the parent's own set). */
async function warmHostExtensions(pathValue: string): Promise<void> {
	const prev = process.env.PATH;
	process.env.PATH = pathValue;
	resetExtensionDiscoveryCache();
	try {
		await ensureHostExtensions();
	} finally {
		if (prev === undefined) delete process.env.PATH;
		else process.env.PATH = prev;
	}
}

/**
 * A fake `hc` (herdr-core) that answers `hello` and one `machine.exec` with the
 * discovery payload.
 *
 * The on-demand package loader registered by `resolveHostTargetAsync` creates its
 * OWN client (`discoverHost(..., { client: undefined })`), so the only seam that
 * reaches it is `HC_BIN` — and that is exactly the production seam. This fixture
 * exists so the "fully explicit host entry" case can be proven to still check the
 * target's packages instead of silently skipping them.
 */
function fakeHcCore(payload: string): { bin: string; cleanup: () => void } {
	const root = mkdtempSync(path.join(tmpdir(), "cross-machine-checkup-hc-"));
	const payloadPath = path.join(root, "payload.txt");
	writeFileSync(payloadPath, payload);
	const bin = path.join(root, "hc.mjs");
	writeFileSync(
		bin,
		[
			"#!/usr/bin/env node",
			'import { readFileSync } from "node:fs";',
			`const PAYLOAD = ${JSON.stringify(payloadPath)};`,
			'process.stdin.setEncoding("utf8");',
			'let buffer = "";',
			'process.stdin.on("data", (chunk) => {',
			"  buffer += chunk;",
			'  let at = buffer.indexOf("\\n");',
			"  while (at !== -1) {",
			"    const line = buffer.slice(0, at).trim();",
			"    buffer = buffer.slice(at + 1);",
			"    at = buffer.indexOf(\"\\n\");",
			'    if (!line.startsWith("{")) continue;',
			"    const message = JSON.parse(line);",
			'    if (message.method === "hello") {',
			'      process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {} })}\\n`);',
			"      continue;",
			"    }",
			'    if (message.method === "machine.exec") {',
			'      const stdout = Buffer.from(readFileSync(PAYLOAD, "utf8"), "utf8").toString("base64");',
			'      const result = { code: 0, ms: 1, signal: null, stdout, stderr: "", truncated: false, timed_out: false };',
			'      process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\\n`);',
			"      continue;",
			"    }",
			'    const error = { code: -32601, message: "unknown method", data: { kind: "method_not_found" } };',
			'    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, error })}\\n`);',
			"  }",
			"});",
		].join("\n") + "\n",
	);
	chmodSync(bin, 0o755);
	return { bin, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** Every probe on this process is cache-backed: a stale answer would fake a PASS. */
function resetProbes(env: NodeJS.ProcessEnv): void {
	clearHostDiscoveryCache(undefined, env);
	resetExtensionDiscoveryCache();
}

function item(
	list: readonly { id: string; status: string; line: string; fixes?: string[] }[],
	id: string,
): { id: string; status: string; line: string; fixes?: string[] } {
	const found = list.find((entry) => entry.id === id);
	assert.ok(found, `expected an item '${id}' in ${list.map((entry) => entry.id).join(", ")}`);
	return found;
}

// ── the cases ──────────────────────────────────────────────────────────────

test("D7/D8: a healthy host reports every item PASS in the frozen order, and a real launch line", async () => {
	const repo = localRepo();
	const ext = hostExtensionPackage();
	const cache = mkdtempSync(path.join(tmpdir(), "cross-machine-checkup-cache-"));
	const env = testEnv(cache);
	resetProbes(env);
	try {
		await warmHostExtensions(ext.pathValue);
		const client = healthyTarget();
		const checkup = await runCrossMachineCheckup({
			cwd: repo.repo,
			// `{}` holes let discovery fill node/piCli/piLegionRoot — the v1.1 shape.
			settings: { enabled: true, hosts: { [HOST]: { cwd: REMOTE_CWD } } },
			agents: [role("centurion", { model: MODEL })],
			model: MODEL,
			env,
			client,
			now: () => 1_700_000_000_000,
		});
		assert.equal(checkup.at, 1_700_000_000_000, "`now` is a seam, not a wall clock");
		assert.equal(checkup.enabled, true);
		assert.equal(checkup.cwd, repo.repo);
		// The parent block is D7 items 1 and 2, in order.
		assert.deepEqual(checkup.parent.map((entry) => entry.id), ["parent-checkout", "hc-machines"]);
		assert.equal(item(checkup.parent, "parent-checkout").status, "pass");
		assert.match(item(checkup.parent, "parent-checkout").line, new RegExp(`^${repo.repo} is a git checkout; origin ${LOCAL_ORIGIN}$`));
		assert.equal(item(checkup.parent, "hc-machines").status, "pass");
		assert.equal(item(checkup.parent, "hc-machines").line, HOST);

		assert.equal(checkup.hosts.length, 1);
		const host = checkup.hosts[0]!;
		assert.equal(host.host, HOST);
		assert.equal(host.source, "settings");
		assert.deepEqual(host.items.map((entry) => entry.id), [
			"target-checkout",
			"target-origin",
			"target-runtime",
			"inherited-extensions",
			"target-models",
		]);
		for (const entry of host.items) {
			assert.equal(entry.status, "pass", `${entry.id} should pass, got: ${entry.line}`);
		}
		assert.match(item(host.items, "target-checkout").line, /^\/srv\/app exists$/);
		assert.match(item(host.items, "target-origin").line, /origin https:\/\/git\.example\.invalid\/acme\/app\.git matches this checkout/);
		// The runtime line carries BOTH versions and the paths the child will use.
		const runtime = item(host.items, "target-runtime").line;
		assert.match(runtime, /v20\.11\.0/);
		assert.match(runtime, /1\.5\.2/);
		assert.match(runtime, /\/usr\/bin\/node/);
		assert.match(runtime, /\/srv\/pi\/dist\/bundle\/cli\.js/);
		// The inherited package resolves on that machine (discovery gave the index).
		assert.match(item(host.items, "inherited-extensions").line, /1 inherited extension\(s\) resolve on fakebox/);
		assert.match(item(host.items, "target-models").line, /workbuddy\/deepseek-v4\.1-flash is in fakebox's listing/);

		// D8: real values, and not one placeholder.
		assert.ok(host.launch, "a resolved cwd must produce a launch line");
		assert.match(host.launch!, /host: "fakebox"/);
		assert.ok(host.launch!.includes(`cwd: "${REMOTE_CWD}"`), host.launch!);
		assert.ok(!host.launch!.includes("<"), `no placeholders in a launch line: ${host.launch!}`);
		assert.equal(host.question, undefined);

		// The models probe runs through the SAME argv a child would use, minus the task.
		const modelsCall = client.execs().find((params) =>
			Array.isArray(params.argv) && (params.argv as string[]).includes("--list-models"),
		);
		assert.ok(modelsCall, "the models probe must actually run");
		assert.deepEqual(modelsCall!.argv, [
			"/usr/bin/node",
			"/srv/pi/dist/bundle/cli.js",
			"--no-extensions",
			"--extension",
			"/srv/npm/node_modules/pi-any-endpoint/extensions/index.ts",
			"--list-models",
		]);
		assert.equal(modelsCall!.cwd, REMOTE_CWD);
	} finally {
		ext.cleanup();
		rmSync(cache, { recursive: true, force: true });
		repo.cleanup();
		resetExtensionDiscoveryCache();
	}
});

test("D5: a session directory that is not a checkout gets D5's sentence, not `git remote add origin`", async () => {
	const cache = mkdtempSync(path.join(tmpdir(), "cross-machine-checkup-cache-"));
	const env = testEnv(cache);
	resetProbes(env);
	try {
		const client = healthyTarget();
		const checkup = await runCrossMachineCheckup({
			cwd: "/Users/me/agents",
			settings: { enabled: true, hosts: { [HOST]: explicitHost() } },
			agents: [role("centurion", { model: MODEL })],
			model: MODEL,
			env,
			client,
			localCheckout: () => ({ kind: "not-a-checkout" }),
		});
		const parent = item(checkup.parent, "parent-checkout");
		assert.equal(parent.status, "fail");
		// The D5 sentence, verbatim (a paraphrase would let the bad advice return).
		assert.match(parent.line, /cross-machine delivery needs a git checkout on this machine too/);
		assert.match(parent.line, /this session's directory \(\/Users\/me\/agents\) is not one/);
		assert.match(parent.line, /start pi inside yours, or pass a relative cwd/);
		assert.doesNotMatch(parent.line, /remote add origin/);
		// …and the pasteable next step names the REAL first host.
		assert.ok(parent.fixes?.length, "a FAIL must carry a fix");
		// …including the remote half, so pasting it cannot walk into the D2 question.
		assert.match(parent.fixes![0]!, /subagent\(\{ agent: "centurion", host: "fakebox", cwd: "\.\.\/my-repo", hostCwd: "\/abs\/path\/on\/fakebox", task: "\.\.\." \}\)/);
		// One broken parent fact does not hide the host block: those are different questions.
		const host = checkup.hosts[0]!;
		assert.equal(host.items.length, 5);
		assert.match(item(checkup.hosts[0]!.items, "target-checkout").line, /^\/srv\/app exists$/);
	} finally {
		rmSync(cache, { recursive: true, force: true });
	}
});

test("D3/D6: bare `{enabled:true}` + a host only `machine list` knows → source 'hc", async () => {
	const repo = localRepo();
	const cache = mkdtempSync(path.join(tmpdir(), "cross-machine-checkup-cache-"));
	const env = testEnv(cache);
	resetProbes(env);
	try {
		const client = new FakeCheckupClient();
		client.onMachineList(() => [{ name: HOST, address: "ssh://user@fakebox" }]);
		// Nothing else is answered: with no directory named anywhere, the D2 question
		// must arrive BEFORE any probe reaches the target.
		const checkup = await runCrossMachineCheckup({
			cwd: repo.repo,
			settings: { enabled: true },
			agents: [role("centurion", { model: MODEL })],
			model: MODEL,
			env,
			client,
		});
		// The v1.1 minimal configuration appears in the report at all (the bug).
		assert.equal(checkup.hosts.length, 1, "a registry-only host must not be invisible");
		const host = checkup.hosts[0]!;
		assert.equal(host.host, HOST);
		assert.equal(host.source, "hc", "it came from `machine list`, not from settings");
		assert.equal(item(checkup.parent, "hc-machines").status, "pass");
		assert.equal(item(checkup.parent, "hc-machines").line, HOST);

		// D2: the directory on that machine is a QUESTION, and no launch is printed.
		const checkout = item(host.items, "target-checkout");
		assert.equal(checkout.status, "fail");
		assert.match(checkout.line, /host 'fakebox' needs a directory on that machine/);
		assert.ok(host.question, "the host carries the question for the D8 renderer");
		assert.match(host.question!, /which directory should the child work in\?/);
		assert.equal(host.launch, undefined, "no cwd means no launch line — never a blank one");
		// The remaining target facts are present and skipped WITH the reason.
		for (const id of ["target-origin", "target-runtime", "inherited-extensions", "target-models"]) {
			const skipped = item(host.items, id);
			assert.equal(skipped.status, "skip", id);
			assert.match(skipped.line, /not checked: no directory on fakebox yet/, id);
		}
		// No probe was attempted: the refusal happens before discovery starts (D2).
		assert.deepEqual(client.execs(), []);
	} finally {
		rmSync(cache, { recursive: true, force: true });
		repo.cleanup();
	}
});

test("D4: a package missing on the target FAILs with the role and a pasteable excludeExtensions JSON", async () => {
	const repo = localRepo();
	const ext = hostExtensionPackage("pi-sysmon");
	const cache = mkdtempSync(path.join(tmpdir(), "cross-machine-checkup-cache-"));
	// The target does NOT have pi-sysmon installed: that is the whole failure.
	const core = fakeHcCore(discoveryPayload({ packages: ["pi-lens"] }));
	const env = testEnv(cache, { HC_BIN: core.bin });
	resetProbes(env);
	try {
		await warmHostExtensions(ext.pathValue);
		const client = healthyTarget();
		const checkup = await runCrossMachineCheckup({
			cwd: repo.repo,
			// Fully explicit: no field is missing, so `resolveHostTargetAsync` runs NO
			// discovery probe and the target has no package index of its own. The
			// checkup must not answer "skip" there (see the loader branch below).
			settings: { enabled: true, hosts: { [HOST]: explicitHost() } },
			agents: [role("centurion", { model: MODEL })],
			model: MODEL,
			env,
			client,
		});
		const inherited = item(checkup.hosts[0]!.items, "inherited-extensions");
		assert.equal(inherited.status, "fail", `expected a FAIL, got: ${inherited.line}`);
		// The line names the package AND the role whose set contained it (D4).
		assert.match(inherited.line, /^1 package\(s\) missing on fakebox: pi-sysmon \(role 'centurion'\)$/);
		// The install action, then the settings key as pasteable JSON (pitfall #2).
		assert.equal(inherited.fixes?.[0], "hc exec --on fakebox -- pi install npm:pi-sysmon");
		const json = inherited.fixes?.map((fix) => {
			try {
				return JSON.parse(fix) as { subagents?: { agentOverrides?: Record<string, { excludeExtensions?: string[] }> } };
			} catch {
				return undefined;
			}
		}).find((parsed) => parsed !== undefined);
		assert.ok(json, `expected a settings JSON fix, got: ${JSON.stringify(inherited.fixes)}`);
		assert.deepEqual(json!.subagents?.agentOverrides?.centurion?.excludeExtensions, ["pi-sysmon"]);
	} finally {
		core.cleanup();
		ext.cleanup();
		rmSync(cache, { recursive: true, force: true });
		resetExtensionDiscoveryCache();
		repo.cleanup();
	}
});

test("D7: a model the target does not serve FAILs and lists what that machine DOES see", async () => {
	const repo = localRepo();
	const cache = mkdtempSync(path.join(tmpdir(), "cross-machine-checkup-cache-"));
	const env = testEnv(cache);
	resetProbes(env);
	try {
		const client = healthyTarget({
			models: "PROVIDER\tMODEL\tCONTEXT\nworkbuddy\tdeepseek-v4.1-pro\t200k\tctx\n",
		});
		const checkup = await runCrossMachineCheckup({
			cwd: repo.repo,
			settings: { enabled: true, hosts: { [HOST]: explicitHost() } },
			agents: [role("centurion", { model: MODEL })],
			model: MODEL,
			env,
			client,
		});
		const models = item(checkup.hosts[0]!.items, "target-models");
		assert.equal(models.status, "fail");
		assert.match(models.line, /^workbuddy\/deepseek-v4\.1-flash is not in fakebox's listing: workbuddy\/deepseek-v4\.1-pro/);
		// One action + the `--no-extensions` aside, which is context, not a command.
		assert.equal(models.fixes?.length, 1);
		assert.match(models.fixes![0]!, /model: "workbuddy\/deepseek-v4\.1-pro"/);
		assert.match(models.line, /hosts\.fakebox\.piExtensions/);
	} finally {
		rmSync(cache, { recursive: true, force: true });
		repo.cleanup();
	}
});

test("D6: an old core (`machine.list` unsupported) is a SKIP, and the named hosts are still checked", async () => {
	const repo = localRepo();
	const cache = mkdtempSync(path.join(tmpdir(), "cross-machine-checkup-cache-"));
	const env = testEnv(cache);
	resetProbes(env);
	try {
		const client = healthyTarget();
		client.machineList = undefined; // the method is refused, like a pre-v1.1 core
		const checkup = await runCrossMachineCheckup({
			cwd: repo.repo,
			settings: { enabled: true, hosts: { [HOST]: explicitHost() } },
			agents: [role("centurion", { model: MODEL })],
			model: MODEL,
			env,
			client,
		});
		const machines = item(checkup.parent, "hc-machines");
		assert.equal(machines.status, "skip", "`cannot tell` must never be reported as `no machines`");
		assert.match(machines.line, /machine\.list did not answer/);
		// The settings hosts are still the host set, and their items still run.
		assert.equal(checkup.hosts.length, 1);
		assert.equal(checkup.hosts[0]!.source, "settings");
		assert.equal(item(checkup.hosts[0]!.items, "target-checkout").status, "pass");
		assert.equal(item(checkup.hosts[0]!.items, "target-runtime").status, "pass");
	} finally {
		rmSync(cache, { recursive: true, force: true });
		repo.cleanup();
	}
});

test("D7: a transport failure FAILs its own item and SKIPs the rest with the reason", async () => {
	const repo = localRepo();
	const cache = mkdtempSync(path.join(tmpdir(), "cross-machine-checkup-cache-"));
	const env = testEnv(cache);
	resetProbes(env);
	try {
		const client = healthyTarget();
		client.override(`test -d ${REMOTE_CWD}`, () => {
			throw new Error("hc connect exited (code 1)");
		});
		const checkup = await runCrossMachineCheckup({
			cwd: repo.repo,
			settings: { enabled: true, hosts: { [HOST]: explicitHost() } },
			agents: [role("centurion", { model: MODEL })],
			model: MODEL,
			env,
			client,
		});
		const host = checkup.hosts[0]!;
		const checkout = item(host.items, "target-checkout");
		assert.equal(checkout.status, "fail");
		assert.match(checkout.line, /^host 'fakebox' unreachable: hc connect exited \(code 1\)$/);
		for (const id of ["target-origin", "target-runtime", "inherited-extensions", "target-models"]) {
			const skipped = item(host.items, id);
			assert.equal(skipped.status, "skip", id);
			assert.match(skipped.line, /not checked: host 'fakebox' unreachable/, id);
		}
		// Nothing is inferred about a machine that did not answer.
		assert.equal(host.items.filter((entry) => entry.status === "pass").length, 0);
	} finally {
		rmSync(cache, { recursive: true, force: true });
		repo.cleanup();
	}
});

test("D6: `enabled: false` probes NOTHING and offers no launch a launch would refuse", async () => {
	const cache = mkdtempSync(path.join(tmpdir(), "cross-machine-checkup-cache-"));
	const env = testEnv(cache);
	resetProbes(env);
	try {
		const client = healthyTarget();
		const checkup = await runCrossMachineCheckup({
			cwd: "/Users/me/app",
			settings: { enabled: false, hosts: { [HOST]: explicitHost() } },
			agents: [role("centurion", { model: MODEL })],
			model: MODEL,
			env,
			client,
			localCheckout: () => ({ kind: "checkout", origin: LOCAL_ORIGIN }),
		});
		assert.equal(checkup.enabled, false);
		assert.deepEqual(checkup.hosts, [], "a switched-off feature is not probed");
		assert.deepEqual(client.calls, [], "zero round trips: not even machine.list");
		const parent = item(checkup.parent, "hc-machines");
		assert.equal(parent.status, "fail");
		assert.match(parent.line, /cross-machine launch is disabled/);
		assert.match(parent.fixes![0]!, /"enabled": true/);
	} finally {
		rmSync(cache, { recursive: true, force: true });
	}
});

test("D7: nothing registered and nothing configured FAILs with the `hc machine add` first step", async () => {
	const cache = mkdtempSync(path.join(tmpdir(), "cross-machine-checkup-cache-"));
	const env = testEnv(cache);
	resetProbes(env);
	try {
		const client = new FakeCheckupClient().onMachineList(() => []);
		const checkup = await runCrossMachineCheckup({
			cwd: "/Users/me/app",
			settings: { enabled: true },
			agents: [role("centurion", { model: MODEL })],
			env,
			client,
			localCheckout: () => ({ kind: "checkout", origin: LOCAL_ORIGIN }),
		});
		assert.deepEqual(checkup.hosts, []);
		const machines = item(checkup.parent, "hc-machines");
		assert.equal(machines.status, "fail");
		assert.match(machines.line, /no machines are registered/);
		assert.match(machines.fixes![0]!, /^hc machine add --name /);
	} finally {
		rmSync(cache, { recursive: true, force: true });
	}
});

test("D6: the checkup is paid only when the crossmachine section was asked for", () => {
	assert.equal(crossMachineCheckupRequested(undefined), true, "no filter = every section, so this one too");
	assert.equal(crossMachineCheckupRequested(["crossmachine"]), true);
	assert.equal(crossMachineCheckupRequested(["crossmachine", "next"]), true);
	assert.equal(crossMachineCheckupRequested(["models"]), false, "`/legion doctor models` must stay probe-free");
	assert.equal(crossMachineCheckupRequested([]), false, "an empty selection selects nothing");
});

test("D8: the launch is labelled after-the-fixes only when something actually failed", async () => {
	const cache = mkdtempSync(path.join(tmpdir(), "cross-machine-checkup-cache-"));
	const env = testEnv(cache);
	resetProbes(env);
	const repo = localRepo();
	try {
		const good = await runCrossMachineCheckup({
			cwd: repo.repo,
			settings: { enabled: true, hosts: { [HOST]: explicitHost() } },
			agents: [],
			env,
			client: healthyTarget(),
		});
		assert.equal(good.hosts[0]!.launchAfterFixes, undefined, "all PASS = paste it now");
		assert.doesNotMatch(good.hosts[0]!.launch!, /model: /, "no model named, so no model flag");
		const bad = await runCrossMachineCheckup({
			cwd: repo.repo,
			settings: { enabled: true, hosts: { [HOST]: explicitHost() } },
			agents: [],
			env,
			client: healthyTarget({ models: "PROVIDER\tMODEL\tCTX\nworkbuddy\tdeepseek-v4.1-pro\t200k\tctx\n" }),
			model: MODEL,
		});
		assert.equal(bad.hosts[0]!.launchAfterFixes, true, "a FAIL above the launch must relabel it");
		assert.match(bad.hosts[0]!.launch!, /model: "workbuddy\/deepseek-v4\.1-flash"/, "the model judged is the model launched");
	} finally {
		rmSync(cache, { recursive: true, force: true });
		repo.cleanup();
	}
});

test("D7: an origin mismatch names both urls and the set-url command with the REAL url", async () => {
	const cache = mkdtempSync(path.join(tmpdir(), "cross-machine-checkup-cache-"));
	const env = testEnv(cache);
	resetProbes(env);
	const repo = localRepo();
	try {
		const client = healthyTarget();
		client.override(`git -C ${REMOTE_CWD} remote get-url origin`, () => stdoutResult("https://git.example.invalid/acme/fork.git\n"));
		const checkup = await runCrossMachineCheckup({
			cwd: repo.repo,
			settings: { enabled: true, hosts: { [HOST]: explicitHost() } },
			agents: [],
			env,
			client,
		});
		const origin = item(checkup.hosts[0]!.items, "target-origin");
		assert.equal(origin.status, "fail");
		assert.match(origin.line, /acme\/fork\.git/);
		assert.ok(
			origin.fixes?.some((fix) => fix.includes(`git -C ${REMOTE_CWD} remote set-url origin ${LOCAL_ORIGIN}`)),
			`expected the real set-url command, got: ${JSON.stringify(origin.fixes)}`,
		);
	} finally {
		rmSync(cache, { recursive: true, force: true });
		repo.cleanup();
	}
});
