/**
 * #423 — a remote launch that never proved it started must FAIL, not leave a shell.
 *
 * The issue: `subagent({agent:"centurion", host, hostCwd, worktree:true})` answered
 * success, the child never started on that machine, and the parent kept a record
 * that `status` rendered as `working` (and that later retired as
 * `execution: success`). Four of them in one day; three had been waited on for
 * 17–30 minutes.
 *
 * Two of the triggers are fixed elsewhere (#424 added `--approve`, #426 creates the
 * spawn cwd's parents) — this file pins the rule that has to survive ANY future
 * trigger: **no terminal id, or no transcript within the window, is a launch
 * failure**, and the receipt carries the five facts a human needs (machine, cwd,
 * terminal, `hc`'s own error, and the terminal's last lines).
 *
 * Everything runs against a recording fake client: no socket, no `hc`, no second
 * machine. The fake models the one thing that matters here — a core that accepted
 * `terminal.run` and a child that never wrote its session file.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { HcRpcError, type HcClient, type HcMethod } from "../../src/hc/client.ts";
import type { HcExecResult, HostTarget } from "../../src/runs/remote.ts";
import { TerminalSupervisor } from "../../src/supervisor/terminal-supervisor.ts";
import type { SpawnInput } from "../../src/supervisor/types.ts";
import { ErrorCodes, SubagentError, type AgentConfig } from "../../src/shared/types.ts";

// Hermetic: the inherited extension list is a set of absolute paths from whatever
// machine runs the suite, and a remote launch refuses an argv path it cannot map.
process.env.PI_LEGION_CHILD_INHERIT_EXTENSIONS = "0";

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

	methods(): HcMethod[] {
		return this.calls.map((call) => call.method);
	}
}

const HOST = "vps";
const RUN_ID = "run-423";
const CHILD = "worker-0";
const TERMINAL = `lgl-${RUN_ID.slice(0, 8)}-${CHILD}`;
const SESSION_PATH = `/srv/.pi-subagents-mirror/${RUN_ID}/${CHILD}/session.jsonl`;
/** The screen of a child that stopped at pi's first-run prompt (#424's root cause). */
const TRUST_SCREEN = [
	" Trust project folder?",
	` /srv/.pi-worktrees/${CHILD}`,
	" This allows pi to load .pi settings and resources, install missing project packages, and execute project extensions.",
	" → Trust",
	"   Trust parent folder (/srv/.pi-worktrees)",
	"   Do not trust",
].join("\r\n");

function target(overrides: Partial<HostTarget> = {}): HostTarget {
	return {
		host: HOST,
		cwd: "/srv/app",
		node: "node",
		piCli: "pi",
		pathMap: [{ from: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.."), to: "/srv/pi-legion" }],
		piLegionRoot: "/srv/pi-legion",
		piExtensions: [],
		mirrorRoot: "/srv/.pi-subagents-mirror",
		worktreeRoot: "/srv/.pi-worktrees",
		...overrides,
	};
}

function agent(): AgentConfig {
	return {
		name: "worker",
		description: "remote launch refusal role",
		systemPromptMode: "append",
		inheritProjectContext: false,
		inheritSkills: false,
		kind: "pi",
		systemPrompt: "You are a test worker.",
		source: "user",
		filePath: "/fake/worker.md",
		worktree: false,
	};
}

function b64(text: string): string {
	return Buffer.from(text, "utf8").toString("base64");
}

function execResult(overrides: Partial<HcExecResult> = {}): HcExecResult {
	return { code: 0, ms: 3, signal: null, stdout: "", stderr: "", truncated: false, timed_out: false, ...overrides };
}

function notFound(text = `no such file: ${SESSION_PATH}`): HcRpcError {
	return new HcRpcError({ code: -32000, message: text, data: { kind: "not_found" } });
}

/** A core that accepted a terminal, with a child that never wrote a session. */
function shellCore(opts: {
	/** `terminal.run` answers with no address at all. */
	noAddress?: boolean;
	/** `terminal.run` always fails with this `hc` error (a spawn the machine refused). */
	runFails?: string;
	/** What the child's terminal shows (default: pi's trust prompt). */
	screen?: string;
	/** The core reports this pid for the terminal (absent = "nothing may be running"). */
	pid?: number;
	/** `machine.exec` for the fate probe answers with these failures. */
	probeFails?: boolean;
} = {}): FakeRemoteClient {
	const client = new FakeRemoteClient();
	client.on("machine.exec", (params) => {
		if (Array.isArray(params.argv)) return execResult({ code: 0 });
		const line = String(params.line ?? "");
		if (line.includes("--list-models")) return execResult({ code: 0 });
		// Only the FATE probe (the script carrying `session=`) may fail here: the
		// preflight is a different question, and the launch under test must reach the
		// gate instead of dying in setup.
		if (opts.probeFails === true && line.includes("session=")) throw new Error("machine went away mid-probe");
		return execResult({ code: 0, stdout: b64(["dir=1", "session=0", "entry=system-prompt.md"].join("\n") + "\n") });
	});
	client.on("file.write", (params) => ({ path: params.path, bytes: 1 }));
	// The transcript never appears: this is the whole failure.
	client.on("file.read", () => {
		throw notFound();
	});
	client.on("terminal.get", (params) => ({
		address: String(params.terminal),
		name: TERMINAL,
		state: "live",
		turn: 0,
		status: { state: "idle" },
		...(opts.pid === undefined ? {} : { pid: opts.pid }),
		// #423: a real core answers the mode word here, not the screen — the text is
		// `terminal.read`'s reply below. Modelling this is what makes the receipt's
		// screen lines a real assertion instead of a fake-only fact.
		screen: "exact",
	}));
	client.on("terminal.read", () => ({ text: opts.screen ?? TRUST_SCREEN, how: "screen", complete: true }));
	client.on("terminal.run", () => {
		if (opts.runFails !== undefined) {
			throw new HcRpcError({ code: -32000, message: opts.runFails, data: { kind: "spawn_failed" } });
		}
		return {
			...(opts.noAddress === true ? {} : { address: `${HOST}/${TERMINAL}` }),
			name: TERMINAL,
			state: "running",
			turn: 0,
			status: { state: "idle" },
			pid: 4242,
		};
	});
	client.on("terminal.kill", () => ({}));
	client.on("terminal.rm", () => ({}));
	return client;
}

function harness(client: FakeRemoteClient, opts: { remoteStartupConfirmMs?: number } = {}): {
	supervisor: TerminalSupervisor;
	root: string;
	cleanup: () => void;
} {
	const root = mkdtempSync(path.join(tmpdir(), "remote-launch-refusal-"));
	const supervisor = new TerminalSupervisor({
		clientFactory: () => client,
		env: { PATH: "/usr/bin" },
		runId: RUN_ID,
		pollIntervalMs: 5,
		// Short enough that the suite is fast; the RECEIPT quotes it back, so the
		// number is asserted rather than slept on.
		remoteStartupConfirmMs: opts.remoteStartupConfirmMs ?? 40,
	});
	return { supervisor, root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function spawnInput(root: string): SpawnInput {
	return {
		name: CHILD,
		task: "Do the slice.",
		agent: agent(),
		sessionFile: path.join(root, "session.jsonl"),
		tempDir: root,
		cwd: root,
		host: HOST,
		hostTarget: target(),
		env: {},
	} as SpawnInput;
}

async function refusal(supervisor: TerminalSupervisor, root: string): Promise<SubagentError> {
	const error = await supervisor.spawnChild(spawnInput(root)).then(
		() => undefined,
		(thrown: unknown) => thrown,
	);
	assert.ok(error instanceof SubagentError, `expected a SubagentError, got ${String(error)}`);
	return error;
}

// ── req 1: no terminal id, or no session, is a launch failure ──────────────

test("#423 req 1: `terminal.run` returning no address is START_FAILED, not a launched child", async () => {
	const client = shellCore({ noAddress: true });
	const h = harness(client);
	try {
		const error = await refusal(h.supervisor, h.root);
		assert.equal(error.code, ErrorCodes.START_FAILED);
		assert.match(error.message, /returned no address/);
		assert.equal(h.supervisor.isAlive(CHILD), false, "no registry entry may be left behind");
	} finally {
		h.cleanup();
	}
});

test("#423 req 1: a core that refuses `terminal.run` fails the launch with hc's own error", async () => {
	const client = shellCore({ runFails: 'cannot start "node": No such file or directory (os error 2)' });
	const h = harness(client);
	try {
		const error = await refusal(h.supervisor, h.root);
		assert.equal(error.code, ErrorCodes.START_FAILED);
		assert.match(error.message, /terminal\.run failed for terminal 'vps\//);
		assert.match(error.message, /spawn_failed: cannot start "node"/, "hc's own words are quoted");
		assert.equal(h.supervisor.isAlive(CHILD), false);
	} finally {
		h.cleanup();
	}
});

test("#423 req 1+2: no transcript within the window is START_FAILED with machine, cwd, terminal, hc error and the screen", async () => {
	const client = shellCore();
	const h = harness(client);
	try {
		const error = await refusal(h.supervisor, h.root);
		assert.equal(error.code, ErrorCodes.START_FAILED);
		// The five facts of req 2, each one asserted on its own line (a single
		// `match(/vps/)` would pass on the header alone).
		assert.match(error.message, /^host 'vps': the launch never proved the child started/m);
		assert.match(error.message, /^ {2}host: vps$/m);
		assert.match(error.message, /^ {2}cwd: \/srv\/app \(the directory this launch asked for, on vps\)$/m);
		assert.match(error.message, new RegExp(`^ {2}terminal: vps/${TERMINAL} \\(created, then killed and removed: the name is free again\\)$`, "m"));
		assert.match(error.message, /^ {2}hc error: \(the core reported no error: every call answered\)$/m);
		// ... and the terminal's own last lines: the fact that would have made #424 a
		// one-minute diagnosis instead of a 30-minute wait.
		assert.match(error.message, /^ {2}screen \(last 6 lines of that terminal\):$/m);
		assert.match(error.message, /^ {4}\|  Trust project folder\?$/m);
		assert.match(error.message, /^ {4}\|  → Trust$/m);
		// The reproduce command is the launch's OWN argv, task included.
		assert.match(error.message, /^ {2}Command \(run on 'vps' to reproduce\):$/m);
		assert.match(error.message, /cd -- '\/srv\/app' && 'node' 'pi' '--session'/);
		// The task is the last argv element and ends with its own newline, so assert the
		// opening of its quoted form (the closing quote is on a later line).
		assert.match(error.message, /'Task: Do the slice\./);
		assert.deepEqual(error.details && (error.details as Record<string, unknown>).host, HOST);
		// req 1: nothing that could render as `working` survives.
		assert.equal(h.supervisor.isAlive(CHILD), false, "a failed launch leaves no live child");
	} finally {
		h.cleanup();
	}
});

test("#423 req 4: a shell that reports no pid says so, and a probe that cannot answer still refuses", async () => {
	const client = shellCore({ probeFails: true });
	const h = harness(client);
	try {
		const error = await refusal(h.supervisor, h.root);
		assert.equal(error.code, ErrorCodes.START_FAILED);
		// The probe could not answer, so the optional facts are absent — never invented.
		assert.match(error.message, /^ {2}mirror dir: unknown \(the machine did not answer the directory question\)$/m);
		assert.match(error.message, /^ {4}\| \(the terminal rendered nothing\)$/m);
	} finally {
		h.cleanup();
	}
});

// ── req 6: the name must be free again ─────────────────────────────────────

test("#423 req 6: the refused launch kills and removes the terminal, so the SAME handle can be dispatched again", async () => {
	const client = shellCore();
	const h = harness(client);
	try {
		const error = await refusal(h.supervisor, h.root);
		assert.equal(error.code, ErrorCodes.START_FAILED);
		// The terminal this launch created is a shell nobody will use, and it HOLDS
		// its name in that core (`terminal.run` → `name_taken` for a live holder).
		assert.deepEqual(client.paramsFor("terminal.kill").map((params) => params.terminal), [`${HOST}/${TERMINAL}`]);
		assert.deepEqual(client.paramsFor("terminal.rm").map((params) => params.terminal), [`${HOST}/${TERMINAL}`]);

		// Re-dispatch of the SAME handle: the second attempt reaches `terminal.run`
		// again instead of being refused for a name an empty shell was holding.
		const second = client.paramsFor("terminal.run").length;
		await refusal(h.supervisor, h.root);
		assert.equal(client.paramsFor("terminal.run").length, second + 1, "the name was free for the retry");
	} finally {
		h.cleanup();
	}
});

test("#423 req 6: a terminal that could NOT be removed is reported, and the receipt says the name is still held", async () => {
	const client = shellCore();
	// The core refuses the removal (a transport blip, a permissions problem).
	client.on("terminal.rm", () => {
		throw new Error("connection closed before the reply");
	});
	const h = harness(client);
	try {
		const error = await refusal(h.supervisor, h.root);
		assert.equal(error.code, ErrorCodes.START_FAILED);
		assert.match(error.message, /KEPT: terminal\.rm: .*connection closed/);
		assert.match(error.message, /a re-dispatch of this name will answer NAME_TAKEN until it is removed on that machine/);
	} finally {
		h.cleanup();
	}
});

// ── the control: the check is what refuses, nothing else ───────────────────

test("#423 (mutation control): with the gate disabled the same core returns a launched child — the check is load-bearing", async () => {
	const client = shellCore();
	const h = harness(client, { remoteStartupConfirmMs: 0 });
	try {
		const handle = await h.supervisor.spawnChild(spawnInput(h.root));
		assert.equal(handle.name, CHILD);
		assert.equal(h.supervisor.isAlive(CHILD), true, "without the gate the shell survives as a `live` child");
		assert.equal(client.paramsFor("terminal.rm").length, 0, "nothing was cleaned up because nothing was judged");
	} finally {
		h.cleanup();
	}
});

test("#423 req 1: a transcript that DOES appear launches normally (the gate is not a blanket refusal)", async () => {
	const client = shellCore();
	client.on("file.read", () => ({ text: "", first: 1, last: 0, lines: 0 }));
	const h = harness(client);
	try {
		const handle = await h.supervisor.spawnChild(spawnInput(h.root));
		assert.equal(handle.name, CHILD);
		assert.equal(handle.remoteTerminal, `${HOST}/${TERMINAL}`, "the address the core holds travels back");
		assert.equal(handle.remoteDir, `/srv/.pi-subagents-mirror/${RUN_ID}/${CHILD}`);
		assert.equal(h.supervisor.isAlive(CHILD), true);
	} finally {
		h.cleanup();
	}
});
