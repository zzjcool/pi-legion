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
import { TerminalSupervisor, HERDR_SPACE_LABEL } from "../../src/supervisor/terminal-supervisor.ts";
import { assertLocalWorktree, normalizeHost, terminalAddress } from "../../src/runs/remote.ts";
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
		await h.supervisor.spawnChild(spawnInput(h.root, { host: "vps" }));
		const params = h.client.paramsFor("terminal.run")[0];
		assert.ok(params, "terminal.run must be called");
		assert.equal(params.on, "vps");
		assert.deepEqual(Object.keys(params).sort(), ["argv", "cwd", "env", "labels", "name", "on"]);
		assert.equal(childRecord(h.supervisor, "root.centurion-0").host, "vps");
	} finally {
		h.cleanup();
	}
});

test("D2: host + caller send both `caller` and `on`", async () => {
	const h = harness(callerEnv());
	try {
		await h.supervisor.spawnChild(spawnInput(h.root, { host: "vps" }));
		const params = h.client.paramsFor("terminal.run")[0];
		assert.ok(params, "terminal.run must be called");
		assert.equal(params.caller, TERMINAL_ID);
		assert.equal(params.on, "vps");
		assert.deepEqual(Object.keys(params).sort(), ["argv", "caller", "cwd", "env", "labels", "name", "on"]);
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
