/**
 * Centurion terminal backend v1 — unit tests
 * (`docs/contracts/centurion-terminal-backend-v1.md`).
 *
 * The backend is driven through an INJECTED fake protocol client, so nothing
 * here spawns `hc` or touches a core. Every assertion pins one frozen decision:
 *
 *   D4  argv is rpc's argv plus the task as ONE positional element;
 *   D5  env merge order: parent (PATH/HOME/TERM…) → memory flags → input.env;
 *   D6  labels: parent `herdr.space` (read once) + role + run, never `herdr.tab`;
 *   D7  `lgl-<runId8>-<sanitized handle>` (≤32, `[a-z0-9_-]`), used by every
 *       later call, with the finished-name retry;
 *   D8  boot-time `turn == promptTurn, idle` NEVER settles;
 *   D10 abort is `terminal.interrupt`, `clearQueued` is not claimed;
 *   D11 retire is kill → rm, and the rm path never throws.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { delimiter } from "node:path";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { formatChildTask } from "../../src/extension/child-guard.ts";
import { buildPiArgs } from "../../src/runs/args.ts";
import { HcRpcError, resolveHcBin, type HcClient, type HcMethod } from "../../src/hc/client.ts";
import {
	LEGION_ROLE_LABEL,
	LEGION_RUN_LABEL,
	HERDR_SPACE_LABEL,
	TerminalSupervisor,
	sanitizeTerminalNamePart,
	terminalHostAvailable,
	terminalName,
} from "../../src/supervisor/terminal-supervisor.ts";
import { DEFAULT_ABORT_TIMEOUT_MS } from "../../src/supervisor/types.ts";
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

	methods(): HcMethod[] {
		return this.calls.map((call) => call.method);
	}

	paramsFor(method: HcMethod): Params[] {
		return this.calls.filter((call) => call.method === method).map((call) => call.params);
	}
}

const TERMINAL_ID = "t1k";
const SOCKET = "/tmp/hc-test/default.sock";

function parentEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
	return {
		HC_TERMINAL_SOCKET: SOCKET,
		HC_TERMINAL_ID: TERMINAL_ID,
		PATH: "/parent/bin:/usr/bin",
		HOME: "/home/tester",
		...overrides,
	};
}

function agent(overrides: Partial<AgentConfig> = {}): AgentConfig {
	return {
		name: "centurion",
		description: "terminal backend test role",
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

function harness(options: { env?: NodeJS.ProcessEnv; runId?: string; pollIntervalMs?: number } = {}): Harness {
	const root = mkdtempSync(path.join(tmpdir(), "terminal-supervisor-"));
	const client = new FakeHcClient();
	client.on("terminal.get", (params) => {
		// The parent lookup (D6) and the child reads share this method; the default
		// answer is a live child at turn 0, idle — exactly the boot reading D8 says
		// must never settle.
		if (params.terminal === TERMINAL_ID) {
			return { address: TERMINAL_ID, state: "live", labels: { [HERDR_SPACE_LABEL]: "space-7", "herdr.tab": "tab-3" } };
		}
		return { address: String(params.terminal), name: String(params.terminal), state: "live", turn: 0, status: { state: "idle" } };
	});
	let nextAddress = 7;
	client.on("terminal.run", () => {
		nextAddress += 1;
		return { address: `t${nextAddress}`, state: "live", turn: 0, status: { state: "idle" }, pid: 4242 };
	});
	client.on("terminal.send", () => ({ turn: 1, started: true }));
	client.on("terminal.interrupt", () => ({ key: "esc", outcome: "stopped" }));
	client.on("terminal.kill", () => ({ address: "t8", state: "finished" }));
	client.on("terminal.rm", () => ({ removed: "t8" }));
	const supervisor = new TerminalSupervisor({
		clientFactory: () => client,
		env: options.env ?? parentEnv(),
		...(options.runId ? { runId: options.runId } : {}),
		pollIntervalMs: options.pollIntervalMs ?? 5,
	});
	return {
		client,
		supervisor,
		root,
		cleanup: () => rmSync(root, { recursive: true, force: true }),
	};
}

// ── D2: host detection is two env markers ─────────────────────────────────

test("D2: terminalHostAvailable is true only with both HC markers", () => {
	assert.equal(terminalHostAvailable({}), false);
	assert.equal(terminalHostAvailable({ HC_TERMINAL_SOCKET: SOCKET }), false);
	assert.equal(terminalHostAvailable({ HC_TERMINAL_ID: TERMINAL_ID }), false);
	assert.equal(terminalHostAvailable({ HC_TERMINAL_SOCKET: "", HC_TERMINAL_ID: TERMINAL_ID }), false);
	assert.equal(terminalHostAvailable({ HC_TERMINAL_SOCKET: SOCKET, HC_TERMINAL_ID: "  " }), false);
	assert.equal(terminalHostAvailable({ HC_TERMINAL_SOCKET: SOCKET, HC_TERMINAL_ID: TERMINAL_ID }), true);
});

// ── D4: argv ──────────────────────────────────────────────────────────────

test("D4: argv is rpc's argv (includeTask:false) plus the task as one positional element", async () => {
	const h = harness();
	try {
		const input = spawnInput(h.root);
		const handle = await h.supervisor.spawnChild(input);
		const run = h.client.paramsFor("terminal.run")[0];
		assert.ok(run, "terminal.run must be called");
		const argv = run.argv as string[];

		// Same interpreter+entry shape the rpc backend's RpcClient uses
		// (`node <cliPath> …`), with the host's own node so the core's PATH cannot
		// break it.
		assert.equal(argv[0], process.execPath);
		assert.equal(argv[1], path.resolve("/fake/pi/dist/cli.js"));

		const flags = argv.slice(2, -1);
		const systemPromptFlag = flags.includes("--append-system-prompt")
			? "--append-system-prompt"
			: "--system-prompt";
		const promptFile = flags[flags.indexOf(systemPromptFlag) + 1]!;
		const supervisorTempDir = path.dirname(promptFile);
		assert.equal(path.basename(promptFile), "system-prompt.md");
		// The role prompt really landed in the file `pi` will read.
		assert.match(readFileSync(promptFile, "utf8"), /You are a test centurion\./);

		// Byte-for-byte parity with the builder the rpc backend uses (D4): the only
		// difference allowed is the temp dir the prompt file lives in.
		const expectedDir = mkdtempSync(path.join(h.root, "expected-"));
		const expected = buildPiArgs({
			agent: input.agent,
			task: input.task,
			sessionFile: input.sessionFile,
			tempDir: expectedDir,
			includeTask: false,
		}).args;
		const normalize = (values: string[], dir: string): string[] =>
			values.map((value) => (value === path.join(dir, "system-prompt.md") ? "<tmp>/system-prompt.md" : value));
		assert.deepEqual(normalize(flags, supervisorTempDir), normalize(expected, expectedDir));

		// `--no-extensions` + an explicit `-e` set (provider extensions included by
		// the shared builder) is what makes the TUI load a model at all.
		assert.ok(flags.includes("--no-extensions"));
		assert.equal(flags.filter((flag) => flag === "--extension").length, expected.filter((flag) => flag === "--extension").length);
		assert.ok(flags.includes("--session"));
		assert.equal(flags[flags.indexOf("--session") + 1], input.sessionFile);

		// The task is ONE positional argv element, formatted exactly like rpc's first
		// prompt — and no `@task.md` file argument (that is the rpc delivery shape).
		assert.equal(argv[argv.length - 1], formatChildTask(input.task, { allowNested: false }));
		assert.equal(argv.filter((value) => value.startsWith(`${expectedDir}`)).length, 0);
		assert.equal(argv.some((value) => value.includes("task.md")), false);

		// cwd travels with the request, and the handle keeps the REGISTRY name.
		assert.equal(run.cwd, input.cwd);
		assert.equal(handle.name, input.name);
		assert.equal(handle.sessionFile, input.sessionFile);
		assert.equal(handle.pid, 4242);
	} finally {
		h.cleanup();
	}
});

// ── D5: env merge ─────────────────────────────────────────────────────────

test("D5: PATH/HOME/TERM from the parent, memory flags, then input.env last", async () => {
	const h = harness({
		env: parentEnv({
			PATH: "/parent/bin:/usr/local/bin:/usr/bin",
			HOME: "/home/tester",
			TERM: "xterm-256color",
			NODE_OPTIONS: "--max-old-space-size=4096",
		}),
	});
	try {
		await h.supervisor.spawnChild(
			spawnInput(h.root, {
				env: {
					PATH: "/lineage/bin",
					PI_LEGION_DB: "/tmp/legion.db",
					PI_LEGION_NODE_ID: "root.centurion-0",
				},
			}),
		);
		const env = h.client.paramsFor("terminal.run")[0]!.env as Record<string, string>;
		// input.env wins over the parent overlay (lineage/budgets are the caller's).
		assert.equal(env.PATH, "/lineage/bin");
		assert.equal(env.HOME, "/home/tester");
		assert.equal(env.TERM, "xterm-256color");
		assert.equal("COLORTERM" in env, false, "an unset parent variable must not be invented");
		assert.equal(env.PI_LEGION_DB, "/tmp/legion.db");
		assert.equal(env.PI_LEGION_NODE_ID, "root.centurion-0");
		// Memory flags are the shared ones, not a second copy of the policy.
		assert.match(String(env.NODE_OPTIONS), /--max-semi-space-size=1/);
		assert.equal(env.PI_LEGION_HOST_NODE_OPTIONS, "--max-old-space-size=4096");

		// Without an override, the core's own PATH (only `/usr/local/bin:/usr/bin`,
		// no `node`) is replaced by the parent's — the whole reason D5 exists.
		await h.supervisor.spawnChild(
			spawnInput(h.root, { name: "root.centurion-1", env: { PI_LEGION_DB: "/tmp/legion2.db" } }),
		);
		const inherited = h.client.paramsFor("terminal.run")[1]!.env as Record<string, string>;
		assert.equal(inherited.PATH, "/parent/bin:/usr/local/bin:/usr/bin");
	} finally {
		h.cleanup();
	}
});

// ── D6: labels ────────────────────────────────────────────────────────────

test("D6: labels copy the parent herdr.space (read once), never herdr.tab, and add role+run", async () => {
	const h = harness({ runId: "run-abcdef123456" });
	try {
		await h.supervisor.spawnChild(spawnInput(h.root));
		await h.supervisor.spawnChild(spawnInput(h.root, { name: "root.centurion-1" }));
		const runs = h.client.paramsFor("terminal.run");
		assert.equal(runs.length, 2);
		const labels = runs[0]!.labels as Record<string, string>;
		assert.deepEqual(labels, {
			[HERDR_SPACE_LABEL]: "space-7",
			[LEGION_ROLE_LABEL]: "centurion",
			[LEGION_RUN_LABEL]: "run-abcdef123456",
		});
		assert.equal("herdr.tab" in labels, false, "each child gets its own tab");
		// One parent read per supervisor, cached for the next child.
		assert.equal(
			h.client.paramsFor("terminal.get").filter((params) => params.terminal === TERMINAL_ID).length,
			1,
		);
	} finally {
		h.cleanup();
	}
});

test("D6: with no runId known the run label is omitted, not invented", async () => {
	const h = harness();
	try {
		await h.supervisor.spawnChild(spawnInput(h.root));
		const labels = h.client.paramsFor("terminal.run")[0]!.labels as Record<string, string>;
		assert.equal(LEGION_RUN_LABEL in labels, false);
		assert.equal(labels[LEGION_ROLE_LABEL], "centurion");
	} finally {
		h.cleanup();
	}
});

// ── D7: name mapping ──────────────────────────────────────────────────────

test("D7: names are lgl-<runId8>-<handle>, [a-z0-9_-] only, ≤32 chars", () => {
	assert.equal(terminalName("1a2b3c4d-eeee", "root.centurion-0"), "lgl-1a2b3c4d-root-centurion-0");
	// Every illegal character folds to `-`; uppercase is a case mapping, not a drop.
	assert.equal(sanitizeTerminalNamePart("Root Centurion/0"), "root-centurion-0");
	assert.equal(sanitizeTerminalNamePart("Ünicode.Node"), "-nicode-node");
	const messy = terminalName(undefined, "Root Centurion/Ünicode.Node");
	assert.match(messy, /^[a-z0-9_-]+$/);
	assert.ok(messy.length <= 32);
	// The prefix survives truncation; the handle is what gets cut.
	const long = terminalName("deadbeefcafe", "x".repeat(80));
	assert.equal(long.length, 32);
	assert.equal(long.startsWith("lgl-deadbeef-"), true);
	// A handle made entirely of illegal characters still yields a usable name.
	const nothing = terminalName(undefined, "///");
	assert.match(nothing, /^lgl-[a-z0-9_-]+$/);
	assert.equal(nothing.length <= 32, true);
	assert.equal(terminalName(undefined, "root.centurion-0"), "lgl-root-centurion-0");
	// A runId is sanitized too, so it cannot smuggle a separator into the name.
	assert.match(terminalName("RUN/../../x", "child"), /^[a-z0-9_-]+$/);
});

test("D7: the mapped name is what every later call addresses", async () => {
	const h = harness({ runId: "run-abcdef123456" });
	try {
		await h.supervisor.spawnChild(spawnInput(h.root));
		const expectedName = terminalName("run-abcdef123456", "root.centurion-0");
		assert.equal(h.client.paramsFor("terminal.run")[0]!.name, expectedName);
		await h.supervisor.prompt("root.centurion-0", "next step");
		assert.equal(h.client.paramsFor("terminal.send")[0]!.terminal, expectedName);
		await h.supervisor.waitSettled("root.centurion-0", 10);
		assert.equal(
			h.client.paramsFor("terminal.get").filter((params) => params.terminal !== TERMINAL_ID)[0]!.terminal,
			expectedName,
		);
		h.client.on("terminal.get", (params) => {
			if (params.terminal === TERMINAL_ID) return { state: "live", labels: {} };
			return { state: "live", turn: 1, status: { state: "working" } };
		});
		await h.supervisor.abort("root.centurion-0");
		assert.equal(h.client.paramsFor("terminal.interrupt")[0]!.terminal, expectedName);
		await h.supervisor.retire("root.centurion-0");
		assert.equal(h.client.paramsFor("terminal.kill")[0]!.terminal, expectedName);
		assert.equal(h.client.paramsFor("terminal.rm")[0]!.terminal, expectedName);
	} finally {
		h.cleanup();
	}
});

test("D7: a finished holder of the name is removed and the run is retried once", async () => {
	const h = harness();
	const attempts: string[] = [];
	h.client.on("terminal.run", (params) => {
		attempts.push(String(params.name));
		if (attempts.length === 1) {
			throw new HcRpcError({ code: -32000, message: "name_taken", data: { kind: "name_taken" } });
		}
		return { address: "t42", state: "live", turn: 0, status: { state: "idle" } };
	});
	h.client.on("terminal.get", (params) => {
		if (params.terminal === TERMINAL_ID) return { state: "live", labels: {} };
		return { name: String(params.terminal), state: "finished", turn: 3 };
	});
	try {
		const handle = await h.supervisor.spawnChild(spawnInput(h.root));
		assert.equal(handle.name, "root.centurion-0");
		assert.equal(attempts.length, 2, "exactly one retry");
		assert.equal(attempts[0], attempts[1]);
		assert.equal(h.client.paramsFor("terminal.rm").length, 1, "the finished terminal is removed first");
	} finally {
		h.cleanup();
	}
});

test("D7: a LIVE holder of the name is NAME_TAKEN, never stolen", async () => {
	const h = harness();
	h.client.on("terminal.run", () => {
		throw new HcRpcError({ code: -32000, message: "name_taken", data: { kind: "name_taken" } });
	});
	try {
		await assert.rejects(
			() => h.supervisor.spawnChild(spawnInput(h.root)),
			(error: unknown) => {
				assert.ok(error instanceof SubagentError);
				assert.equal(error.code, ErrorCodes.NAME_TAKEN);
				return true;
			},
		);
		assert.equal(h.client.paramsFor("terminal.rm").length, 0);
	} finally {
		h.cleanup();
	}
});

// ── D8: settle gate ───────────────────────────────────────────────────────

test("D8: a boot-time idle at promptTurn NEVER settles; a later done turn does", async () => {
	const h = harness({ pollIntervalMs: 5 });
	let reads = 0;
	h.client.on("terminal.get", (params) => {
		if (params.terminal === TERMINAL_ID) return { state: "live", labels: {} };
		reads += 1;
		// `hc` answers exactly this at startup (the spike's false completion).
		if (reads <= 2) return { state: "live", turn: 0, status: { state: "idle" } };
		return { state: "live", turn: 1, status: { state: "done" } };
	});
	try {
		await h.supervisor.spawnChild(spawnInput(h.root));
		const settle = await h.supervisor.waitSettled("root.centurion-0", 40);
		assert.deepEqual(settle, { settled: true, abnormal: false });
		assert.ok(reads >= 3, "the idle reading must be polled through, not accepted");
	} finally {
		h.cleanup();
	}
});

test("D8: idle forever is an honest timeout (no throw, no kill)", async () => {
	const h = harness({ pollIntervalMs: 5 });
	h.client.on("terminal.get", (params) => {
		if (params.terminal === TERMINAL_ID) return { state: "live", labels: {} };
		return { state: "live", turn: 0, status: { state: "idle" } };
	});
	try {
		await h.supervisor.spawnChild(spawnInput(h.root));
		const settle = await h.supervisor.waitSettled("root.centurion-0", 30);
		assert.deepEqual(settle, { settled: false, abnormal: false, reason: "timeout" });
		assert.equal(h.client.methods().includes("terminal.kill"), false, "a timeout kills nothing");
	} finally {
		h.cleanup();
	}
});

test("D8: a prompt records the turn it belongs to; the previous done turn cannot settle it", async () => {
	const h = harness({ pollIntervalMs: 5 });
	let childReads = 0;
	h.client.on("terminal.get", (params) => {
		if (params.terminal === TERMINAL_ID) return { state: "live", labels: {} };
		childReads += 1;
		// Read 1 is the pre-prompt refresh; reads 2–3 still show the turn that was
		// ALREADY over when the prompt went in. Only turn 2 belongs to the prompt.
		if (childReads <= 3) return { state: "live", turn: 1, status: { state: "done" } };
		return { state: "live", turn: 2, status: { state: "done" } };
	});
	h.client.on("terminal.send", () => ({ turn: 1, started: true }));
	try {
		await h.supervisor.spawnChild(spawnInput(h.root));
		await h.supervisor.prompt("root.centurion-0", "second turn");
		const settle = await h.supervisor.waitSettled("root.centurion-0", 60);
		assert.deepEqual(settle, { settled: true, abnormal: false });
		assert.ok(
			childReads >= 4,
			`the finished turn 1 must not settle the turn-2 prompt (reads=${childReads})`,
		);
	} finally {
		h.cleanup();
	}
});

test("D8: a finished terminal settles with its exit code", async () => {
	const h = harness({ pollIntervalMs: 5 });
	h.client.on("terminal.get", (params) => {
		if (params.terminal === TERMINAL_ID) return { state: "live", labels: {} };
		return { state: "finished", turn: 0, exit_code: 0, status: null };
	});
	try {
		await h.supervisor.spawnChild(spawnInput(h.root));
		assert.deepEqual(await h.supervisor.waitSettled("root.centurion-0", 40), {
			settled: true,
			abnormal: false,
			exitCode: 0,
		});
	} finally {
		h.cleanup();
	}
});

// ── D10: abort / steer ────────────────────────────────────────────────────

test("D10: abort is terminal.interrupt and claims no queue clear", async () => {
	const h = harness();
	h.client.on("terminal.get", (params) => {
		if (params.terminal === TERMINAL_ID) return { state: "live", labels: {} };
		return { state: "live", turn: 2, status: { state: "working" } };
	});
	try {
		await h.supervisor.spawnChild(spawnInput(h.root));
		const outcome = await h.supervisor.abort("root.centurion-0", { clearQueued: true });
		assert.deepEqual(outcome, {
			status: "interrupted",
			cleared: { steering: 0, followUp: 0 },
			timeoutMs: DEFAULT_ABORT_TIMEOUT_MS,
		});
		const interrupt = h.client.paramsFor("terminal.interrupt")[0]!;
		assert.equal(interrupt.terminal, terminalName(undefined, "root.centurion-0"));
		assert.equal(typeof interrupt.timeout, "number");
		// `promptDisposition: false` is the declaration that goes with this shape.
		assert.equal(h.supervisor.capabilities.promptDisposition, false);
	} finally {
		h.cleanup();
	}
});

test("D10: abort with no running turn reports no-turn and interrupts nothing", async () => {
	const h = harness();
	h.client.on("terminal.get", (params) => {
		if (params.terminal === TERMINAL_ID) return { state: "live", labels: {} };
		return { state: "live", turn: 1, status: { state: "done" } };
	});
	try {
		await h.supervisor.spawnChild(spawnInput(h.root));
		const outcome = await h.supervisor.abort("root.centurion-0", { timeoutMs: 1_000 });
		assert.deepEqual(outcome, {
			status: "no-turn",
			cleared: { steering: 0, followUp: 0 },
			timeoutMs: 1_000,
		});
		assert.equal(h.client.paramsFor("terminal.interrupt").length, 0);
	} finally {
		h.cleanup();
	}
});

test("D10: steer is a send and reports only the turn-boundary deposit", async () => {
	const h = harness();
	try {
		await h.supervisor.spawnChild(spawnInput(h.root));
		const disposition = await h.supervisor.steer("root.centurion-0", "add a test");
		assert.equal(disposition, "queued");
		assert.equal(h.client.paramsFor("terminal.send")[0]!.text, "add a test");
	} finally {
		h.cleanup();
	}
});

// ── D11: retire ───────────────────────────────────────────────────────────

test("D11: retire kills then removes, and a failing rm never throws", async () => {
	const h = harness();
	h.client.on("terminal.rm", () => {
		throw new HcRpcError({ code: -32000, message: "not_found", data: { kind: "not_found" } });
	});
	try {
		await h.supervisor.spawnChild(spawnInput(h.root));
		await h.supervisor.retire("root.centurion-0");
		const methods = h.client.methods();
		const kill = methods.indexOf("terminal.kill");
		const rm = methods.indexOf("terminal.rm");
		assert.ok(kill >= 0, "terminal.kill must run");
		assert.ok(rm > kill, "terminal.rm follows the kill");
		assert.equal(h.supervisor.isAlive("root.centurion-0"), false);
	} finally {
		h.cleanup();
	}
});

test("D11: retiring an unknown child is NOT_FOUND, like every backend", async () => {
	const h = harness();
	try {
		await assert.rejects(
			async () => {
				await h.supervisor.retire("nobody");
			},
			(error: unknown) => {
				assert.ok(error instanceof SubagentError);
				assert.equal(error.code, ErrorCodes.NOT_FOUND);
				return true;
			},
		);
	} finally {
		h.cleanup();
	}
});

// ── D12-adjacent: no invented facts ──────────────────────────────────────

test("D12: the backend declares no in-flight/stall facts and no usage stats", async () => {
	const h = harness();
	try {
		const spawned = await h.supervisor.spawnChild(spawnInput(h.root));
		assert.ok(spawned);
		assert.equal(await h.supervisor.stats("root.centurion-0"), null);
		assert.equal(typeof (h.supervisor as { inFlightTool?: unknown }).inFlightTool, "undefined");
		assert.equal(typeof (h.supervisor as { inFlightToolStack?: unknown }).inFlightToolStack, "undefined");
		assert.equal(typeof (h.supervisor as { lastEventAt?: unknown }).lastEventAt, "undefined");
	} finally {
		h.cleanup();
	}
});

// ── D3: executable resolution without a shell ────────────────────────────

test("D3: HC_BIN wins, then PATH, then ~/.local/bin/hc, then the bare name", () => {
	const home = mkdtempSync(path.join(tmpdir(), "hc-bin-home-"));
	const pathDir = mkdtempSync(path.join(tmpdir(), "hc-bin-path-"));
	try {
		// HC_BIN is absolute truth, even when PATH has a candidate.
		assert.equal(resolveHcBin({ HC_BIN: "/opt/hc", PATH: pathDir }, home), "/opt/hc");
		// PATH lookup returns the resolved absolute path, never the bare name.
		const onPath = path.join(pathDir, "hc");
		writeFileSync(onPath, "#!/bin/sh\n", { mode: 0o755 });
		assert.equal(resolveHcBin({ PATH: `${path.join(home, "nowhere")}${delimiter}${pathDir}` }, home), onPath);
		// The installer's default location: measured on this host, PATH inside an
		// hc terminal is only /usr/local/bin:/usr/bin, so this fallback is the one
		// that actually fires.
		const localDir = path.join(home, ".local", "bin");
		mkdirSync(localDir, { recursive: true });
		const local = path.join(localDir, "hc");
		writeFileSync(local, "#!/bin/sh\n", { mode: 0o755 });
		assert.equal(resolveHcBin({ PATH: "/usr/local/bin:/usr/bin" }, home), local);
		// Nothing found: the spawn error should name what was attempted.
		assert.equal(resolveHcBin({ PATH: "/nonexistent" }, path.join(home, "empty")), "hc");
	} finally {
		rmSync(home, { recursive: true, force: true });
		rmSync(pathDir, { recursive: true, force: true });
	}
});
