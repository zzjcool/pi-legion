/**
 * Cross-machine spawn — S0 params/primitive tests
 * (`docs/contracts/cross-machine-spawn-v1.md`).
 *
 * S0 ships types, the `host` plumbing and ONE wire mapping; nothing here spawns
 * a real `hc`. Two things are pinned:
 *
 *   D4  `host` absent ⇒ `terminal.run` receives exactly the five local params
 *       (plus `caller` when this process is itself an hc terminal) — no `on`
 *       key at all, which is what keeps every `paramsFor("terminal.run")`
 *       assertion in `terminal-supervisor.test.ts` byte-identical;
 *   D2  `host` present ⇒ the value travels as `on`, and the child record keeps
 *       it so later calls can build `host/name` addresses;
 *   D4  `normalizeHost` is the single "absent = this host" predicate, and
 *       `terminalAddress` / `assertLocalWorktree` read only through it.
 *
 * Self-contained on purpose: importing another `*.test.ts` would register ITS
 * cases in this file's process as well.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { type HcClient, type HcMethod } from "../../src/hc/client.ts";
import { TerminalSupervisor, HERDR_SPACE_LABEL, LEGION_HOST_LABEL } from "../../src/supervisor/terminal-supervisor.ts";
import {
	assertLocalWorktree,
	normalizeHost,
	remoteDirFor,
	resolveHostTarget,
	terminalAddress,
	thisPackageRoot,
	type HostTarget,
} from "../../src/runs/remote.ts";
import { parseSubagentSettings } from "../../src/agents/settings.ts";
import { ErrorCodes, SubagentError, type AgentConfig } from "../../src/shared/types.ts";
import type { SpawnInput } from "../../src/supervisor/types.ts";

// ── fixtures ───────────────────────────────────────────────────────────────

type Params = Record<string, unknown>;

interface Call {
	method: HcMethod;
	params: Params;
}

/** A protocol client that records calls and answers through per-method handlers. */
class FakeHcClient implements HcClient {
	readonly calls: Call[] = [];
	started = 0;
	closed = 0;
	private readonly handlers = new Map<string, (params: Params) => unknown>();

	on(method: HcMethod, handler: (params: Params) => unknown): this {
		this.handlers.set(method, handler);
		return this;
	}

	async start(): Promise<void> {
		this.started += 1;
	}

	async request<T = unknown>(method: HcMethod, params: Params = {}): Promise<T> {
		this.calls.push({ method, params });
		const handler = this.handlers.get(method);
		if (!handler) throw new Error(`fake hc client: no handler for ${method}`);
		return (await handler(params)) as T;
	}

	close(): void {
		this.closed += 1;
	}

	paramsFor(method: HcMethod): Params[] {
		return this.calls.filter((call) => call.method === method).map((call) => call.params);
	}
}

// Hermetic on purpose: the host's discovered extensions are absolute paths from
// whatever machine runs the suite, and a remote launch REFUSES an argv path it
// cannot map (`pathMap`). Turning inheritance off leaves exactly one absolute
// entry — this package's own — which the fixture maps portably.
process.env.PI_LEGION_CHILD_INHERIT_EXTENSIONS = "0";

const TERMINAL_ID = "t1k";
const SOCKET = "/tmp/hc-test/default.sock";

/** Not itself an hc terminal: no `caller`, no parent space lookup. */
function localEnv(): NodeJS.ProcessEnv {
	return { PATH: "/parent/bin:/usr/bin", HOME: "/home/tester" };
}

/** This process IS an hc terminal, so `terminal.run` carries `caller`. */
function callerEnv(): NodeJS.ProcessEnv {
	return { ...localEnv(), HC_TERMINAL_SOCKET: SOCKET, HC_TERMINAL_ID: TERMINAL_ID };
}

function agent(overrides: Partial<AgentConfig> = {}): AgentConfig {
	return {
		name: "centurion",
		description: "cross-machine params test role",
		systemPromptMode: "append",
		inheritProjectContext: false,
		inheritSkills: false,
		kind: "pi",
		systemPrompt: "You are a test centurion.",
		source: "user",
		filePath: "/fake/centurion.md",
		worktree: true,
		...overrides,
	};
}

function spawnInput(root: string, overrides: Partial<SpawnInput> = {}): SpawnInput {
	return {
		name: "root.centurion-0",
		task: "Implement the slice.",
		agent: agent(),
		sessionFile: path.join(root, "session.jsonl"),
		tempDir: root,
		cwd: root,
		env: { PI_LEGION_DB: path.join(root, "legion.db"), PI_LEGION_NODE_ID: "root.centurion-0" },
		cliPath: "/fake/pi/dist/cli.js",
		...overrides,
	};
}

interface Harness {
	client: FakeHcClient;
	supervisor: TerminalSupervisor;
	root: string;
	cleanup(): void;
}

/** `machine.exec` carries stdout/stderr base64-encoded — the wire shape, not a choice. */
function b64(text: string): string {
	return Buffer.from(text).toString("base64");
}

function harness(env: NodeJS.ProcessEnv): Harness {
	const root = mkdtempSync(path.join(tmpdir(), "cross-machine-params-"));
	const client = new FakeHcClient();
	client.on("terminal.get", (params) => {
		if (params.terminal === TERMINAL_ID) {
			return { address: TERMINAL_ID, state: "live", labels: { [HERDR_SPACE_LABEL]: "space-7" } };
		}
		return { address: String(params.terminal), name: String(params.terminal), state: "live", turn: 0, status: { state: "idle" } };
	});
	client.on("terminal.run", () => ({ address: "t8", state: "live", turn: 0, status: { state: "idle" }, pid: 4242 }));
	client.on("terminal.send", () => ({ turn: 1, started: true }));
	client.on("terminal.interrupt", () => ({ key: "esc", outcome: "stopped" }));
	client.on("terminal.kill", () => ({ address: "t8", state: "finished" }));
	client.on("terminal.rm", () => ({ removed: "t8" }));
	// S1 remote setup calls. Both answer 0 without touching a filesystem: the
	// params (not the effect) are what these unit tests pin — the fake hc core in
	// `test/integration/fake-core-remote-spawn.test.ts` proves the effect.
	client.on("machine.exec", () => ({ code: 0, ms: 1, signal: null, stdout: "", stderr: "", truncated: false, timed_out: false }));
	client.on("file.write", (params) => ({ path: params.path, bytes: String(params.data ?? "").length }));
	const supervisor = new TerminalSupervisor({
		clientFactory: () => client,
		env,
		pollIntervalMs: 5,
	});
	return { client, supervisor, root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** The backend's per-child record is private; tests read it through the registry. */
function childRecord(supervisor: TerminalSupervisor, name: string): { host?: string; terminalName: string } {
	const record = (supervisor as unknown as { children: Map<string, { host?: string; terminalName: string }> }).children.get(name);
	assert.ok(record, `no terminal record for ${name}`);
	return record;
}

// ── D4: host absent ────────────────────────────────────────────────────────

test("D4: without a host, terminal.run gets exactly the five local params and no `on`", async () => {
	const h = harness(localEnv());
	try {
		await h.supervisor.spawnChild(spawnInput(h.root));
		const params = h.client.paramsFor("terminal.run")[0];
		assert.ok(params, "terminal.run must be called");
		// The full key set is the assertion: a stray `on: undefined` would keep
		// every value-level check green while changing what the core receives.
		assert.deepEqual(Object.keys(params).sort(), ["argv", "cwd", "env", "labels", "name"]);
		assert.ok(!("on" in params), "no host must not send an `on` key at all");
	} finally {
		h.cleanup();
	}
});

// ── D2: the single wire mapping ────────────────────────────────────────────

test("D2: with a host, `on` carries it and the child record keeps it", async () => {
	const h = harness(localEnv());
	try {
		// A named host always carries a resolved target (S1): the backend refuses a
		// bare name rather than sending this machine's argv to another machine.
		await h.supervisor.spawnChild(spawnInput(h.root, { host: "vps", hostTarget: hostTarget() }));
		const params = h.client.paramsFor("terminal.run")[0];
		assert.ok(params, "terminal.run must be called");
		assert.equal(params.on, "vps");
		assert.deepEqual(Object.keys(params).sort(), ["argv", "cwd", "labels", "name", "on"]);
		assert.equal(childRecord(h.supervisor, "root.centurion-0").host, "vps");
	} finally {
		h.cleanup();
	}
});

/**
 * S2 (constraint 5): a remote request carries `on` and NO `caller`.
 *
 * `caller` is a BARE terminal name, resolved by the core that receives the
 * request. The remote core never heard of this process's terminal, so the id is
 * either unknown there or — worse — names an unrelated terminal on that machine.
 * S1 sent it unconditionally; the pair `{on}` without `{caller}` is the fix, and
 * the local row below pins that the local shape did not move.
 */
test("D2: a remote request sends `on` and never `caller`", async () => {
	const h = harness(callerEnv());
	try {
		await h.supervisor.spawnChild(spawnInput(h.root, { host: "vps", hostTarget: hostTarget() }));
		const params = h.client.paramsFor("terminal.run")[0];
		assert.ok(params, "terminal.run must be called");
		assert.equal(params.caller, undefined, "a parent terminal id does not exist on the other machine");
		assert.equal(params.on, "vps");
		assert.deepEqual(Object.keys(params).sort(), ["argv", "cwd", "labels", "name", "on"]);
		// S5/D6: and no `env` key at all — see the dedicated test below.
	} finally {
		h.cleanup();
	}
});

test("D2: the LOCAL request keeps `caller` exactly as before", async () => {
	const h = harness(callerEnv());
	try {
		await h.supervisor.spawnChild(spawnInput(h.root));
		const params = h.client.paramsFor("terminal.run")[0];
		assert.ok(params, "terminal.run must be called");
		assert.equal(params.caller, TERMINAL_ID);
		assert.deepEqual(Object.keys(params).sort(), ["argv", "caller", "cwd", "env", "labels", "name"]);
	} finally {
		h.cleanup();
	}
});

test("D4: a local child's record carries no host at all", async () => {
	const h = harness(localEnv());
	try {
		await h.supervisor.spawnChild(spawnInput(h.root));
		assert.equal("host" in childRecord(h.supervisor, "root.centurion-0"), false);
	} finally {
		h.cleanup();
	}
});

test("D4: a blank host is not a machine", async () => {
	const h = harness(localEnv());
	try {
		await h.supervisor.spawnChild(spawnInput(h.root, { host: "   " }));
		const params = h.client.paramsFor("terminal.run")[0];
		assert.ok(params, "terminal.run must be called");
		assert.ok(!("on" in params), "an all-whitespace host means this host");
	} finally {
		h.cleanup();
	}
});

/** The remote root a host target points at (the fake client never looks at it). */
const REMOTE_CWD = "/srv/remote/work";

const REMOTE_LEGION_ROOT = `${REMOTE_CWD}/.pi-legion`;

/**
 * A resolved target as `resolveHostTarget` builds it: the package's own root is
 * mapped, because `buildPiArgs` names that extension entry in EVERY child's argv.
 */
function hostTarget(overrides: Partial<HostTarget> = {}): HostTarget {
	return {
		host: "vps",
		cwd: REMOTE_CWD,
		node: "node",
		piCli: "pi",
		pathMap: [{ from: thisPackageRoot(), to: REMOTE_LEGION_ROOT }],
		piLegionRoot: REMOTE_LEGION_ROOT,
		piExtensions: [],
		mirrorRoot: path.posix.join(path.posix.dirname(REMOTE_CWD), ".pi-subagents-mirror"),
		// S2: `resolveHostTarget` derives the tree root as a sibling of the checkout.
		worktreeRoot: path.posix.join(path.posix.dirname(REMOTE_CWD), ".pi-worktrees"),
		...overrides,
	};
}

// ── S1: the remote branch (D6/D7/D8/D9) ───────────────────────────────────

test("S1: a remote spawn preflights, makes the remote dir, and sends the remote cwd/argv/env/labels", async () => {
	// `callerEnv` on purpose: a LOCAL spawn would read the parent terminal's
	// `herdr.space` here, so "no terminal.get happened" is a real assertion.
	const h = harness(callerEnv());
	const target = hostTarget();
	try {
		const input = spawnInput(h.root, { host: "vps", hostTarget: target });
		await h.supervisor.spawnChild(input);

		// D6/D9 + S5.6: four setup calls — the explicit checkout question (`test -d`,
		// spike constraint 4), the preflight `line`, the startup probe (the child's own
		// argv with `--list-models`), and one `mkdir -p`.
		const execs = h.client.paramsFor("machine.exec");
		assert.equal(execs.length, 4, "checkout probe + preflight + startup probe + remote dir creation");
		assert.equal(execs[0]!.on, "vps");
		assert.deepEqual(execs[0]!.argv, ["test", "-d", "/srv/remote/work"]);
		assert.equal(execs[1]!.on, "vps");
		assert.equal(typeof execs[1]!.line, "string");
		assert.match(String(execs[1]!.line), /cd -- '\/srv\/remote\/work'/);
		const remoteDir = remoteDirFor(target, undefined, input.name);
		assert.equal(execs[2]!.on, "vps");
		assert.deepEqual(execs[2]!.argv, ["mkdir", "-p", remoteDir]);
		// S5.6: the startup probe is the child's own argv, task replaced by
		// `--list-models`, run on that machine BEFORE a terminal exists. The listing
		// proves model VISIBILITY; credentials play no part in it.
		assert.equal(execs[3]!.on, "vps");
		assert.match(String(execs[3]!.line), /--no-extensions/);
		assert.match(String(execs[3]!.line), /'--list-models'$/);
		assert.match(String(execs[3]!.line), /cd -- '\/srv\/remote\/work'/);

		const run = h.client.paramsFor("terminal.run")[0];
		assert.ok(run, "terminal.run must be called");
		// D2: the one wire mapping, unchanged by S1.
		assert.equal(run.on, "vps");
		// D6: the child starts in the REMOTE cwd, never this machine's.
		assert.equal(run.cwd, REMOTE_CWD);

		// D6: remote argv — the remote programs and no parent-absolute path.
		const argv = run.argv as string[];
		assert.equal(argv[0], "node");
		assert.equal(argv[1], "pi");
		assert.ok(!argv.includes(process.execPath), "the parent interpreter must not travel");
		assert.equal(argv[argv.indexOf("--session") + 1], `${remoteDir}/session.jsonl`);
		const promptFlag = argv.includes("--append-system-prompt") ? "--append-system-prompt" : "--system-prompt";
		const promptPath = argv[argv.indexOf(promptFlag) + 1];
		assert.equal(promptPath, `${remoteDir}/system-prompt.md`);
		// Every argv element that looks like a path is inside the remote dir: the
		// inherited extensions are mirrored by path mapping too, never left pointing
		// at this machine.
		for (const arg of argv) {
			if (!path.posix.isAbsolute(arg)) continue;
			// Review M4 moved the mirror BESIDE the checkout, so "inside the checkout"
			// is no longer the whole rule: in-checkout, in the mirror, or the mapped
			// package root are the three legal neighbourhoods.
			assert.ok(
				arg.startsWith(REMOTE_CWD) || arg.startsWith(target.mirrorRoot) || arg.startsWith(REMOTE_LEGION_ROOT),
				`a parent-absolute argv survived: ${arg} is in none of ${REMOTE_CWD}, ${target.mirrorRoot}, ${REMOTE_LEGION_ROOT}`,
			);
		}
		// The package's own `-e` entry (present in every child's argv) went through
		// `pathMap`, not through a basename sweep that would hand the child a path
		// to nothing.
		assert.ok(
			argv.includes(`${REMOTE_LEGION_ROOT}/index.ts`),
			`the package entry must be re-rooted: ${argv.join(" ")}`,
		);

		// D9: the mirrored file carries the real prompt, not a placeholder.
		const writes = h.client.paramsFor("file.write");
		const prompt = writes.find((params) => params.path === `${remoteDir}/system-prompt.md`);
		assert.ok(prompt, "the system prompt must be mirrored");
		assert.equal(prompt.on, "vps");
		assert.match(Buffer.from(String(prompt.data), "base64").toString("utf8"), /You are a test centurion\./);

		// D7/S5: no env at all on the other machine — not "some keys filtered out".
		assert.equal("env" in run, false, `a remote launch must not carry env: ${JSON.stringify(run.env)}`);

		// D8: role + host, and NO parent space label (and no read of it either).
		const labels = run.labels as Record<string, string>;
		assert.deepEqual(labels, { "legion.role": "centurion", [LEGION_HOST_LABEL]: "vps" });
		assert.equal(HERDR_SPACE_LABEL in labels, false, "a parent space id is meaningless over there");
		assert.deepEqual(h.client.paramsFor("terminal.get"), [], "no parent terminal read for a remote child");

		// D9: the record remembers the remote dir (the parent temp dir stays local).
		const record = childRecord(h.supervisor, input.name) as { remoteDir?: string; tempDir?: string; host?: string };
		assert.equal(record.remoteDir, remoteDir);
		assert.equal(record.host, "vps");
		assert.ok(record.tempDir && !record.tempDir.startsWith(REMOTE_CWD), "the parent temp dir is not migrated");
	} finally {
		h.cleanup();
	}
});

test("S1: a failing preflight refuses the launch before terminal.run", async () => {
	const h = harness(callerEnv());
	try {
		h.client.on("machine.exec", () => ({ code: 11, stdout: "", stderr: "", timed_out: false }));
		const error = await h.supervisor
			.spawnChild(spawnInput(h.root, { host: "vps", hostTarget: hostTarget({ cwd: "/srv/missing" }) }))
			.then(() => undefined, (thrown: unknown) => thrown);
		assert.ok(error instanceof SubagentError);
		assert.equal((error as SubagentError).code, ErrorCodes.START_FAILED);
		assert.match((error as SubagentError).message, /host 'vps'/);
		assert.match((error as SubagentError).message, /\/srv\/missing/);
		assert.deepEqual(h.client.paramsFor("terminal.run"), [], "a bad cwd must not create a terminal");
	} finally {
		h.cleanup();
	}
});

// ── D4: normalizeHost is the one predicate ─────────────────────────────────

test("D4: normalizeHost maps every absent spelling to undefined and trims the rest", () => {
	for (const value of [undefined, null, "", "   ", 42, {}, [], false]) {
		assert.equal(normalizeHost(value), undefined, `expected undefined for ${JSON.stringify(value)}`);
	}
	assert.equal(normalizeHost("vps"), "vps");
	assert.equal(normalizeHost("  vps  "), "vps");
});

// ── D2: addressing ────────────────────────────────────────────────────────

test("terminalAddress: a local child keeps its bare name, a remote one is host-qualified", () => {
	assert.equal(terminalAddress({ terminalName: "lgl-x" }), "lgl-x");
	assert.equal(terminalAddress({ terminalName: "lgl-x", host: "vps" }), "vps/lgl-x");
	assert.equal(terminalAddress({ terminalName: "lgl-x", host: "  " }), "lgl-x");
});

// ── D13: remote worktrees are not local paths ──────────────────────────────

test("assertLocalWorktree: a locally owned worktree passes", () => {
	assert.doesNotThrow(() => assertLocalWorktree({}));
	assert.doesNotThrow(() => assertLocalWorktree({ worktreePath: "/srv/app/.wt/x" }));
	assert.doesNotThrow(() => assertLocalWorktree({ worktreePath: "/srv/app/.wt/x", worktreeHost: "  " }));
	// No path means nothing local to guard — the host alone is not an operation.
	assert.doesNotThrow(() => assertLocalWorktree({ worktreeHost: "vps" }));
});

test("assertLocalWorktree: another machine's worktree is refused by name, host and path", () => {
	let thrown: unknown;
	try {
		assertLocalWorktree({ worktreeHost: "vps", worktreePath: "/srv/app/.wt/x" });
	} catch (error) {
		thrown = error;
	}
	assert.ok(thrown instanceof SubagentError, "must throw a SubagentError");
	assert.equal((thrown as SubagentError).code, ErrorCodes.INVALID_PARAMS);
	const message = (thrown as SubagentError).message;
	assert.match(message, /vps/);
	assert.match(message, /\/srv\/app\/\.wt\/x/);
	assert.match(message, /refused/);
});

// ── D6: a host without a target, and an unmappable argv path ───────────────

test("D6: a host with no resolved target is refused instead of half-crossing", async () => {
	// "Half-crossing" = sending `on` while the argv, env and cwd are still this
	// machine's. It used to be accepted as a raw seam; it is now impossible,
	// because a remote terminal that starts with a parent path is a child nobody
	// can debug (D6/D7).
	const h = harness(localEnv());
	try {
		await assert.rejects(
			() => h.supervisor.spawnChild(spawnInput(h.root, { host: "vps" })),
			(error: unknown) => {
				assert.ok(error instanceof SubagentError);
				assert.equal((error as SubagentError).code, ErrorCodes.INVALID_PARAMS);
				assert.match((error as SubagentError).message, /resolved target/);
				return true;
			},
		);
		// Refused BEFORE the wire: the client only answered the parent-space probe
		// (the harness's `terminal.get` lookup), no `terminal.run` was sent.
		assert.equal(h.client.paramsFor("terminal.run").length, 0);
	} finally {
		h.cleanup();
	}
});

test("D6: an unmappable argv path that is NOT an extension is still refused by name", async () => {
	// Extensions have their own policy (review M3: dropped with a notice, because
	// every host has a default inherited set that could never be mapped). Everything
	// else keeps the hard rule: an absolute path that is neither in the checkout nor
	// under a `pathMap` entry cannot be rewritten to a path that exists.
	const h = harness(localEnv());
	try {
		const args = spawnInput(h.root, {
			host: "vps",
			hostTarget: hostTarget({ pathMap: [{ from: thisPackageRoot(), to: REMOTE_LEGION_ROOT }] }),
		});
		args.agent = { ...args.agent, skillPath: ["/opt/thirdparty/skill/SKILL.md"] };
		await assert.rejects(
			() => h.supervisor.spawnChild(args),
			(error: unknown) => {
				assert.ok(error instanceof SubagentError);
				assert.equal((error as SubagentError).code, ErrorCodes.INVALID_PARAMS);
				const message = (error as SubagentError).message;
				assert.match(message, /\/opt\/thirdparty\/skill\/SKILL.md/);
				assert.match(message, /pathMap/);
				return true;
			},
		);
		assert.equal(h.client.paramsFor("terminal.run").length, 0, "no terminal may be created");
	} finally {
		h.cleanup();
	}
});

test("M3: an inherited-style extension that cannot be mapped is dropped with a notice, not refused", async () => {
	// The default configuration inherits the HOST's extension install paths, which
	// are never in the checkout and never in a pathMap. Refusing them made the whole
	// feature unusable out of the box; dropping them silently would change what the
	// child loads without saying so. The middle path is a loud drop.
	const h = harness(localEnv());
	const writes: string[] = [];
	const original = process.stderr.write.bind(process.stderr);
	process.stderr.write = ((chunk: unknown) => {
		writes.push(String(chunk));
		return true;
	}) as typeof process.stderr.write;
	try {
		const args = spawnInput(h.root, {
			host: "vps",
			hostTarget: hostTarget({ pathMap: [{ from: thisPackageRoot(), to: REMOTE_LEGION_ROOT }] }),
		});
		args.agent = { ...args.agent, extensions: ["/root/.pi/agent/npm/node_modules/pi-lens/extensions/index.ts"] };
		await h.supervisor.spawnChild(args);
		const run = h.client.paramsFor("terminal.run")[0];
		assert.ok(run, "the launch must proceed");
		const argv = run.argv as string[];
		assert.ok(
			!argv.some((arg) => arg.includes("pi-lens")),
			`the unmappable extension must not appear in the remote argv: ${argv.join(" ")}`,
		);
		assert.ok(
			writes.some((line) => line.includes("not loadable there") && line.includes("pi-lens")),
			`the drop must be announced: ${writes.join("")}`,
		);
	} finally {
		process.stderr.write = original;
		h.cleanup();
	}
});

test("M8: a stuck name is refused by ADDRESS, so the operator knows which machine holds it", async () => {
	// `retire` failing leaves the record live on purpose (the terminal may really be
	// running), which is what keeps this refusal armed. A bare name is then the only
	// clue, and "root.worker-0 is alive" does not say which machine to clear.
	const h = harness(callerEnv());
	try {
		const input = spawnInput(h.root, { host: "vps", hostTarget: hostTarget() });
		await h.supervisor.spawnChild(input);
		await assert.rejects(
			() => h.supervisor.spawnChild(input),
			(error: unknown) => {
				assert.ok(error instanceof SubagentError);
				assert.equal((error as SubagentError).code, ErrorCodes.NAME_TAKEN);
				assert.match((error as SubagentError).message, /already registered and alive: vps\//);
				assert.match((error as SubagentError).message, /until it is retired/);
				return true;
			},
		);
	} finally {
		h.cleanup();
	}
});

test("S5/D6: a remote launch sends NO env at all, so no parent fact can become the remote child's", async () => {
	// The real cross-machine run (S5.6) failed with `No models available` and
	// `spawn npx ENOENT` in the REMOTE child, while the same `pi` run by hand on that
	// machine worked. Cause: the backend forwarded this machine's env (minus a few
	// keys). `hc` treats `env` as an overlay on its own baseline, so every forwarded
	// key REPLACED a truthful remote one — the remote child looked for credentials
	// where this Mac keeps them, and its PATH shrank to this machine's shape.
	//
	// So the property is no longer "which keys are filtered out" (that was m4/m5, and
	// it was the wrong instinct): it is "nothing is sent". A hostile parent env is the
	// test: if any of it reaches the wire, that is the bug.
	const env = callerEnv();
	Object.assign(env, {
		PI_OPENAI_API_KEY: "parent-key",
		PI_CONFIG_DIR: "/Users/parent/.pi",
		XDG_CONFIG_HOME: "/Users/parent/.config",
		NODE_OPTIONS: "--require /root/code/pi-legion/hook.js",
		PI_LEGION_HOST_NODE_OPTIONS: "--require /root/elsewhere/hook.js",
		PI_LEGION_DB: "/root/code/pi-legion/.pi-subagents/legion.db",
		PI_LEGION_NODE_ID: "root.centurion-0",
		PI_SUBAGENT_PARENT_PATH: "root",
		PATH: "/root/.nvm/versions/node/v24.13.1/bin:/usr/bin",
		HOME: "/root",
	});
	const h = harness(env);
	try {
		const input = spawnInput(h.root, { host: "vps", hostTarget: hostTarget() });
		await h.supervisor.spawnChild(input);
		const run = h.client.paramsFor("terminal.run")[0];
		assert.ok(run);
		assert.equal("env" in run, false, `no env may travel: ${JSON.stringify(run.env)}`);
	} finally {
		h.cleanup();
	}
});

test("m10: a launch that fails after making the remote dir removes it again", async () => {
	// `ensureRemoteDir` runs BEFORE the argv mapping (which can refuse), so a failure
	// there would leave an empty `<mirrorRoot>/<run>/<name>` on that machine forever.
	// `hc` has no `file.remove`; the sweep is one best-effort `rm -rf` of the dir THIS
	// spawn created.
	const h = harness(callerEnv());
	try {
		const input = spawnInput(h.root, { host: "vps", hostTarget: hostTarget({ pathMap: [{ from: thisPackageRoot(), to: REMOTE_LEGION_ROOT }] }) });
		// An unmappable, non-extension path: the launch refuses AFTER the mkdir.
		input.agent = { ...input.agent, skillPath: ["/opt/thirdparty/skill/SKILL.md"] };
		await assert.rejects(() => h.supervisor.spawnChild(input), /pathMap|mirror/);
		const execs = h.client.paramsFor("machine.exec");
		const remoteDir = remoteDirFor(input.hostTarget ?? hostTarget(), undefined, input.name);
		const sweeps = execs.filter((exec) => Array.isArray(exec.argv) && String(exec.argv[0]) === "rm");
		assert.equal(sweeps.length, 1, `exactly one sweep, got ${JSON.stringify(execs.map((e) => e.argv ?? e.line))}`);
		assert.deepEqual(sweeps[0]!.argv, ["rm", "-rf", remoteDir]);
		assert.equal(h.client.paramsFor("terminal.run").length, 0, "nothing may be started");
	} finally {
		h.cleanup();
	}
});

test("S5.6: host piExtensions are appended as `--extension` AFTER `--no-extensions`", async () => {
	// The provider that supplies the models on that machine is an extension; the
	// child's `--no-extensions` removes it too, so the operator names the host-local
	// set and the launch appends it. These entries are already paths ON THAT MACHINE,
	// so they must NOT go through `mapRemoteArgPath` (a parent path there would be
	// refused as unmappable — they are not in this checkout).
	const h = harness(localEnv());
	const provider = "/root/.pi/agent/npm/node_modules/pi-any-endpoint/index.ts";
	try {
		const input = spawnInput(h.root, {
			host: "vps",
			hostTarget: hostTarget({ piExtensions: [provider] }),
		});
		await h.supervisor.spawnChild(input);
		const argv = ((h.client.paramsFor("terminal.run")[0]?.argv ?? []) as string[]).map(String);
		const noExtensions = argv.indexOf("--no-extensions");
		assert.ok(noExtensions >= 0, "the child still starts without the parent's plugin set");
		const appended = argv.flatMap((arg, index) => (arg === "--extension" && argv[index + 1] === provider ? [index] : []));
		assert.equal(appended.length, 1, `the host extension must be there exactly once: ${JSON.stringify(argv)}`);
		assert.ok(appended[0]! > noExtensions, "it must come AFTER --no-extensions, or the switch would drop it");
	} finally {
		h.cleanup();
	}
});

test("S5.6: with no piExtensions the argv is byte-identical to before (nothing appended)", async () => {
	const h = harness(localEnv());
	try {
		const input = spawnInput(h.root, { host: "vps", hostTarget: hostTarget() });
		const before = input;
		await h.supervisor.spawnChild(before);
		const argv = ((h.client.paramsFor("terminal.run")[0]?.argv ?? []) as string[]).map(String);
		const extensions = argv.filter((arg) => arg === "--extension").length;
		// Only the ones `buildPiArgs` itself emits (builtins + this package's entry).
		assert.equal(extensions, 3, `no extra --extension may appear: ${JSON.stringify(argv)}`);
	} finally {
		h.cleanup();
	}
});

test("S5.6: the startup probe's four failures are named before a terminal exists", async () => {
	const MODEL = "workbuddy/deepseek-v4.1-flash";
	const cases: Array<{
		name: string;
		result: { code: number; stdout: string; stderr: string; timed_out: boolean };
		expect: RegExp;
		details: string;
		model?: string;
		also?: Array<RegExp | string>;
	}> = [
		{
			// Both shapes are real: `--list-models` prints the bare marker, while an
			// older/alternate failure path prints `No API key` and the marker as a
			// warning. Neither carries a table, so both stay `no-model` (the parser
			// must not mistake the first sentence for a provider/model row).
			name: "no-model",
			result: { code: 0, stdout: b64("No API key found for the selected model.\nWarning: No models available. Use /login\n"), stderr: "", timed_out: false },
			expect: /cannot see a model there/,
			details: "no-model",
			also: [/No models available/],
		},
		{
			name: "conflict",
			result: {
				code: 1,
				stdout: "",
				stderr: b64('Error: Failed to load extension "/root/.pi/agent/npm/node_modules/pi-legion/index.ts":\n  Tool "legion_output" conflicts with /root/code/pi-legion/index.ts\n'),
				timed_out: false,
			},
			expect: /extensions collide/,
			details: "conflict",
		},
		{
			// The machine HAS models, just not this one — output deliberately free of
			// any `No API key` line, so this cannot be confused with `no-model`.
			name: "model-missing",
			result: {
				code: 0,
				stdout: b64([
					"provider      model                    context  max-out  thinking  images",
					"some-provider other/model-x            128k     8k       yes       no",
				].join("\n") + "\n"),
				stderr: "",
				timed_out: false,
			},
			expect: /is not visible there/,
			details: "model-missing",
			model: MODEL,
			// host, the expected model, the first entries of the REAL listing, both fix
			// directions, and the same command line the probe ran.
			also: [/vps/, MODEL, /some-provider\/other\/model-x/, /subagents\.defaultModel/, /agentOverrides\.<role>\.model/, /piExtensions/],
		},
		{
			name: "other",
			result: { code: 2, stdout: "", stderr: b64("boom: something else\n"), timed_out: false },
			expect: /child's own argv failed on that machine \(exit 2\)/,
			details: "failed",
		},
	];
	for (const probeCase of cases) {
		const h = harness(localEnv());
		try {
			// Every `machine.exec` answers the same thing: the two preflight questions
			// pass (code 0), the startup probe gets this case's answer. Distinguishing by
			// the params is the point — the probe is the only call that carries `line`.
			h.client.on("machine.exec", (params: Record<string, unknown>) => {
				if (String(params.line).includes("--list-models")) return probeCase.result;
				return { code: 0, stdout: "", stderr: "", timed_out: false };
			});
			const input = spawnInput(h.root, {
				host: "vps",
				hostTarget: hostTarget(),
				...(probeCase.model ? { model: probeCase.model } : {}),
			});
			const error = await h.supervisor.spawnChild(input).then(() => undefined, (thrown: unknown) => thrown);
			assert.ok(error instanceof SubagentError, `${probeCase.name}: expected a refusal`);
			const message = (error as SubagentError).message;
			assert.match(message, probeCase.expect, probeCase.name);
			for (const pattern of probeCase.also ?? []) {
				if (typeof pattern === "string") {
					assert.ok(message.includes(pattern), `${probeCase.name}: the message must contain ${pattern}`);
				} else {
					assert.match(message, pattern, probeCase.name);
				}
			}
			const details = (error as SubagentError).details as Record<string, unknown> | undefined;
			assert.equal(details?.probe, probeCase.details, probeCase.name);
			if (probeCase.model) assert.equal(details?.model, probeCase.model, probeCase.name);
			// Every refusal ends with the line to paste on that machine — and it is the
			// SAME line the probe ran, not a hand-reconstructed approximation.
			const probeLine = h.client.paramsFor("machine.exec").map((params) => String(params.line)).find((line) => line.includes("--list-models"));
			assert.ok(probeLine, `${probeCase.name}: the probe must have run`);
			assert.ok(message.includes(probeLine), `${probeCase.name}: the message must quote the probe line`);
			assert.match(message, /Command \(run on 'vps' to reproduce\):/, probeCase.name);
			// The whole point: no terminal was created, so nothing can hang for five minutes.
			assert.equal(h.client.paramsFor("terminal.run").length, 0, `${probeCase.name}: no terminal may start`);
		} finally {
			h.cleanup();
		}
	}
});

/**
 * The false negative this run is about (S5.6 follow-up).
 *
 * Real argv on the host: with the provider extension finally appended, the same
 * line answered `pong` — but a `-p ping` probe still said `No API key found for
 * any-endpoint`, because that registry also holds a second provider with no key. A
 * model that is VISIBLE in `--list-models` is enough for this launch; a credential
 * the child never uses must not refuse it.
 */
test("S5.6: a VISIBLE model passes even when another provider has no API key", async () => {
	const h = harness(localEnv());
	try {
		h.client.on("machine.exec", (params: Record<string, unknown>) => {
			if (!String(params.line).includes("--list-models")) {
				return { code: 0, stdout: "", stderr: "", timed_out: false };
			}
			return {
				code: 0,
				stdout: b64([
					"provider      model                                context  max-out  thinking  images",
					"any-endpoint  workbuddy/deepseek-v4.1-flash         128k     8k       yes       no",
				].join("\n") + "\n"),
				// The line that used to turn a working launch into a refusal.
				stderr: b64("No API key found for another-provider\n"),
				timed_out: false,
			};
		});
		const input = spawnInput(h.root, {
			host: "vps",
			hostTarget: hostTarget(),
			model: "workbuddy/deepseek-v4.1-flash",
		});
		await h.supervisor.spawnChild(input);
		const runs = h.client.paramsFor("terminal.run");
		assert.equal(runs.length, 1, "a visible model must launch, and launch once");
		const argv = (runs[0]!.argv ?? []) as string[];
		assert.equal(argv[argv.indexOf("--model") + 1], "workbuddy/deepseek-v4.1-flash");
	} finally {
		h.cleanup();
	}
});

/**
 * End to end for the root cause: a `piExtensions` written in a settings FILE has
 * to reach the remote argv. Before, `parseSubagentSettings` dropped the key, so
 * this exact test would have produced an argv without the provider extension while
 * the launch error still told the operator to add it.
 */
test("S5.6: piExtensions from a settings file reach the remote argv and its probe", async () => {
	const provider = "/root/.pi/agent/npm/node_modules/pi-any-endpoint/extensions/index.ts";
	const settings = parseSubagentSettings(
		{
			subagents: {
				crossMachine: {
					enabled: true,
					hosts: {
						vps: {
							cwd: REMOTE_CWD,
							piLegionRoot: REMOTE_LEGION_ROOT,
							piExtensions: [provider],
						},
					},
				},
			},
		},
		"/tmp/settings.json",
	);
	const target = resolveHostTarget("vps", settings.crossMachine);
	assert.deepEqual(target.piExtensions, [provider], "the settings entry must survive parsing");
	const h = harness(localEnv());
	try {
		await h.supervisor.spawnChild(spawnInput(h.root, { host: "vps", hostTarget: target }));
		const argv = ((h.client.paramsFor("terminal.run")[0]?.argv ?? []) as string[]).map(String);
		const noExtensions = argv.indexOf("--no-extensions");
		assert.ok(noExtensions >= 0, "the child still starts without the parent's plugin set");
		const appended = argv.flatMap((arg, index) => (arg === "--extension" && argv[index + 1] === provider ? [index] : []));
		assert.equal(appended.length, 1, `the host extension must appear exactly once: ${JSON.stringify(argv)}`);
		assert.ok(appended[0]! > noExtensions, "it must come AFTER --no-extensions, or the switch would drop it");
		// The probe has to ask the SAME argv: a probe run without the extension would
		// report a model-less machine and refuse the very launch it should pass.
		const probeLine = h.client.paramsFor("machine.exec").map((params) => String(params.line)).find((line) => line.includes("--list-models"));
		assert.ok(probeLine, "the startup probe must be a --list-models call");
		assert.ok(probeLine!.includes(provider), `the probe must carry the host extension too: ${probeLine}`);
		assert.equal(h.client.paramsFor("terminal.run").length, 1);
	} finally {
		h.cleanup();
	}
});
