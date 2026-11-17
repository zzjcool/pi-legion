/**
 * Cross-machine spawn — S1 end to end through the REAL `HcCliClient` and the
 * fake `hc` core (`test/helpers/fake-hc-core.mjs`, the oracle).
 *
 * Nothing here touches a real `hc`, a socket or a second machine: `HC_BIN`
 * points at a generated wrapper that runs the fake core, and the "other
 * machine's filesystem" is `FAKE_HC_REMOTE_ROOT` — a real directory on this
 * host, which is exactly what makes the assertions checkable (the mirrored
 * system prompt is compared byte for byte).
 *
 * What the oracle proves that a params-shape assertion cannot: a parent-absolute
 * path in `argv`, a parent `PATH`, a parent `TERM`, or a bare terminal name for
 * a remote child all fail HARD in the fake core, with the real core's own
 * wording. So a green run here means the launch really crossed.
 */

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, createWriteStream, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { HcCliClient, type HcClient, type HcMethod } from "../../src/hc/client.ts";
import {
	MAX_REMOTE_FILE_BYTES,
	mirrorRemoteFile,
	remoteDirFor,
	resolveHostTarget,
	type HostTarget,
} from "../../src/runs/remote.ts";
import { HERDR_SPACE_LABEL, TerminalSupervisor } from "../../src/supervisor/terminal-supervisor.ts";
import { ErrorCodes, SubagentError, type AgentConfig } from "../../src/shared/types.ts";
import type { SpawnInput } from "../../src/supervisor/types.ts";

// ── fixtures ───────────────────────────────────────────────────────────────

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../..");
const FAKE_CORE = path.join(REPO_ROOT, "test/helpers/fake-hc-core.mjs");
// Hermetic: the host's discovered extensions are absolute paths from whatever
// machine runs the suite, and a remote launch refuses an argv path it cannot map.
// Inheritance off leaves one absolute entry (this package's own), which the
// target maps through `piLegionRoot` below.
process.env.PI_LEGION_CHILD_INHERIT_EXTENSIONS = "0";

const HOST = "fakebox";
const TERMINAL_ID = "t1k";
const SOCKET = "/tmp/hc-fake/default.sock";

interface WireRequest {
	jsonrpc?: string;
	id?: number;
	method?: string;
	params?: Record<string, unknown>;
}

interface Harness {
	/** The root of this test's scratch space. */
	root: string;
	/** What stands for the other machine's filesystem. */
	remoteRoot: string;
	/** Remote cwd configured for the target. */
	remoteCwd: string;
	/** Every request the fake core received, in order. */
	wire(): WireRequest[];
	/** Requests of one method only. */
	wireFor(method: HcMethod): Record<string, unknown>[];
	/** Replies this process received, paired with the request that caused them. */
	replies: Array<{ method: HcMethod; params: Record<string, unknown>; result: unknown }>;
	client: HcClient;
	supervisor: TerminalSupervisor;
	target: HostTarget;
	spawnRoot: string;
	cleanup(): void;
}

/**
 * Every harness that has been built and not yet cleaned up.
 *
 * The per-test cleanup is `t.after`, because a FAILING assertion must still
 * close the transport — a leaked `hc connect` child keeps this process's event
 * loop alive forever (`node --test` has no per-test timeout), which turns one
 * red assertion into a hung suite. This list is only the file-level backstop
 * for a harness that was built and then thrown out of before it could register.
 */
const LIVE: Harness[] = [];
after(() => {
	for (const h of LIVE.splice(0)) h.cleanup();
});

/**
 * Build the scratch layout, the `HC_BIN` wrapper and a supervisor wired to the
 * fake core. `exec node <fake core>` uses THIS process's node, not whatever is
 * on the wrapper's PATH — the harness must not depend on the caller's env.
 */
function harness(options: { remoteSubdir?: string } = {}): Harness {
	const root = mkdtempSync(path.join(tmpdir(), "fake-core-remote-spawn-"));
	const remoteRoot = path.join(root, "remote");
	const remoteCwd = path.join(remoteRoot, options.remoteSubdir ?? "work");
	mkdirSync(remoteCwd, { recursive: true });
	// Review M2: the preflight `test -f`s this package's entry on that machine,
	// because every child's argv loads it. The "operator" installed it here — under
	// the remote ROOT rather than the checkout, so a test that overrides `cwd`
	// still exercises the failure it is about.
	mkdirSync(path.join(remoteRoot, ".pi-legion"), { recursive: true });
	writeFileSync(path.join(remoteRoot, ".pi-legion", "index.ts"), "// fake remote install\n");
	const binDir = path.join(root, "bin");
	mkdirSync(binDir, { recursive: true });
	const wrapper = path.join(binDir, "hc");
	writeFileSync(wrapper, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(FAKE_CORE)} "$@"\n`, { mode: 0o755 });
	chmodSync(wrapper, 0o755);
	const wirePath = path.join(root, "wire.jsonl");
	const spawnRoot = path.join(root, "spawn");
	mkdirSync(spawnRoot, { recursive: true });

	const env: NodeJS.ProcessEnv = {
		...process.env,
		HC_BIN: wrapper,
		HC_TERMINAL_SOCKET: SOCKET,
		HC_TERMINAL_ID: TERMINAL_ID,
		FAKE_HC_REMOTE_ROOT: remoteRoot,
		FAKE_HC_MACHINES: HOST,
		FAKE_HC_LOG: wirePath,
	};
	const real = new HcCliClient({ env, requestTimeoutMs: 20_000 });
	const replies: Harness["replies"] = [];
	const client: HcClient = {
		start: () => real.start(),
		close: () => real.close(),
		request: async <T = unknown>(method: HcMethod, params: Record<string, unknown> = {}): Promise<T> => {
			const result = (await real.request<T>(method, params)) as unknown;
			replies.push({ method, params, result });
			return result as T;
		},
	};
	const supervisor = new TerminalSupervisor({
		clientFactory: () => client,
		env,
		runId: "run-xm-1",
		pollIntervalMs: 5,
	});
	// A real child's argv always carries this package's extension entry (args.ts),
	// so the target must say where that lives on the "other machine" — here, a
	// path the fake core accepts as being on it.
	const target = resolveHostTarget(HOST, {
		enabled: true,
		hosts: { [HOST]: { cwd: remoteCwd, piLegionRoot: path.posix.join(remoteRoot, ".pi-legion") } },
	});
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
		wire,
		wireFor: (method) => wire().filter((request) => request.method === method).map((request) => request.params ?? {}),
		replies,
		client,
		supervisor,
		target,
		spawnRoot,
		// The transport is a real child process: closing it is what lets this test
		// file's process exit (the fake core waits on stdin).
		cleanup: () => {
			// Idempotent: `t.after` and the file-level backstop both call it.
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
	return h;
}

function agent(): AgentConfig {
	return {
		name: "centurion",
		description: "fake-core remote spawn role",
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

function spawnInput(h: Harness, overrides: Partial<SpawnInput> = {}): SpawnInput {
	return {
		name: "root.centurion-0",
		task: "Implement the slice.",
		agent: agent(),
		sessionFile: path.join(h.spawnRoot, "session.jsonl"),
		tempDir: h.spawnRoot,
		cwd: h.remoteCwd,
		env: { PI_LEGION_DB: path.join(h.spawnRoot, "legion.db"), PI_LEGION_NODE_ID: "root.centurion-0" },
		cliPath: "/fake/pi/dist/cli.js",
		host: HOST,
		hostTarget: h.target,
		...overrides,
	};
}

/** The local system-prompt file the supervisor wrote (under its own temp dir). */
function localSystemPrompt(spawnRoot: string): { file: string; text: string } {
	const dirs = readdirSync(spawnRoot).filter((entry) => entry.startsWith("terminal-child-"));
	assert.equal(dirs.length, 1, "the supervisor creates exactly one local temp dir per child");
	const file = path.join(spawnRoot, dirs[0]!, "system-prompt.md");
	return { file, text: readFileSync(file, "utf8") };
}

// ── the happy path ─────────────────────────────────────────────────────────

test("S1: a remote spawn crosses the wire with the remote cwd/argv/env/labels and mirrors the prompt", async (t) => {
	const h = harness();
	t.after(() => h.cleanup());
	const input = spawnInput(h);
	const handle = await h.supervisor.spawnChild(input);

	// 1. The core accepted it as a REMOTE terminal: `on` was sent, and the reply
	//    address is qualified with that machine.
	const runReply = h.replies.find((entry) => entry.method === "terminal.run");
	assert.ok(runReply, "terminal.run must have been sent");
	const address = (runReply.result as { address?: string }).address;
	assert.equal(address, `${HOST}/t1`);
	// The handle keeps the registry name, not the hc address (D7).
	assert.equal(handle.name, input.name);

	// 2. What crossed the wire for `terminal.run`.
	const [run] = h.wireFor("terminal.run");
	assert.ok(run, "terminal.run must appear in the wire log");
	assert.equal(run.on, HOST);
	assert.ok(String(run.cwd).startsWith(h.remoteRoot), `cwd must be on that machine: ${String(run.cwd)}`);
	assert.equal(run.cwd, h.remoteCwd);
	const argv = (run.argv as string[]).map(String);
	assert.equal(argv[0], "node", "the remote interpreter, not this process's node");
	assert.equal(argv[1], "pi", "the remote CLI, not this machine's cli path");
	assert.ok(!argv.includes(process.execPath));
	for (const arg of argv) {
		if (path.isAbsolute(arg)) {
			assert.ok(arg.startsWith(h.remoteRoot), `a parent-absolute argv element survived: ${arg}`);
		}
	}
	const session = argv[argv.indexOf("--session") + 1];
	const remoteDir = remoteDirFor(h.target, "run-xm-1", input.name);
	assert.equal(session, `${remoteDir}/session.jsonl`);
	const promptFlag = argv.includes("--append-system-prompt") ? "--append-system-prompt" : "--system-prompt";
	assert.equal(argv[argv.indexOf(promptFlag) + 1], `${remoteDir}/system-prompt.md`);

	// 3. env: NOT SENT AT ALL. S5's real run proved that "forward the parent's env,
	//    minus a few keys" is not a smaller version of the truth but a different
	//    machine's facts: the remote pi looked for credentials where the PARENT keeps
	//    them (`No models available`) and its PATH took the parent's shape, so `npx`
	//    vanished (`spawn npx ENOENT`). `hc` merges an overlay into its own baseline,
	//    so an absent key means the remote process keeps its own environment.
	assert.equal("env" in run, false, `a remote launch must not carry env at all: ${JSON.stringify(run.env)}`);

	// 4. labels: role + run + host, and never the parent's space.
	const labels = run.labels as Record<string, string>;
	assert.equal(labels["legion.host"], HOST);
	assert.equal(labels["legion.role"], "centurion");
	assert.equal(labels["legion.run"], "run-xm-1");
	assert.equal(HERDR_SPACE_LABEL in labels, false);

	// 5. The mirrored prompt exists on the "remote" machine and is the same text
	//    this process generated locally — the point of D9's second temp dir.
	const local = localSystemPrompt(h.spawnRoot);
	const mirrored = path.join(remoteDir, "system-prompt.md");
	assert.ok(existsSync(mirrored), `the fake remote must hold ${mirrored}`);
	assert.equal(readFileSync(mirrored, "utf8"), local.text);
	assert.match(local.text, /You are a remote test centurion\./);
	const writes = h.wireFor("file.write");
	assert.ok(writes.some((params) => params.path === mirrored && params.on === HOST));

	// 6. The remote temp dir was created through machine.exec, not locally.
	const execs = h.wireFor("machine.exec");
	assert.ok(execs.length >= 2, "preflight + mkdir");
	assert.ok(execs.some((params) => JSON.stringify(params.argv ?? []).includes(remoteDir)));

	// 7. Later calls address the child by its QUALIFIED name: a bare name never
	//    resolves a remote terminal, so this is what makes abort/collect work.
	await h.supervisor.abort(input.name, { timeoutMs: 2_000 });
	const gets = h.wireFor("terminal.get");
	assert.ok(gets.length > 0, "abort observes the child first");
	const childGet = gets.find((params) => String(params.terminal).startsWith(`${HOST}/`));
	assert.ok(childGet, `terminal.get must use host/name, saw ${JSON.stringify(gets)}`);
	assert.match(String(childGet.terminal), new RegExp(`^${HOST}/lgl-`));
});

// ── negative: the preflight refuses before any terminal exists ─────────────

test("S1: a remote cwd that does not exist fails the preflight, naming host and cwd, and never runs a terminal", async (t) => {
	const h = harness();
	t.after(() => h.cleanup());
	const missing = path.join(h.remoteRoot, "absent");
	const error = await h.supervisor
		.spawnChild(spawnInput(h, { hostTarget: { ...h.target, cwd: missing } }))
		.then(() => undefined, (thrown: unknown) => thrown);
	assert.ok(error instanceof SubagentError, `expected a SubagentError, got ${String(error)}`);
	assert.equal((error as SubagentError).code, ErrorCodes.START_FAILED);
	assert.match((error as SubagentError).message, new RegExp(HOST));
	assert.match((error as SubagentError).message, new RegExp(missing.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
	assert.deepEqual(h.wireFor("terminal.run"), [], "no terminal may be created for an unusable cwd");
});

test("S1: a cwd OUTSIDE the target machine's filesystem is refused too", async (t) => {
	const h = harness();
	t.after(() => h.cleanup());
	const outside = path.join(h.root, "not-on-that-machine");
	mkdirSync(outside, { recursive: true });
	const error = await h.supervisor
		.spawnChild(spawnInput(h, { hostTarget: { ...h.target, cwd: outside } }))
		.then(() => undefined, (thrown: unknown) => thrown);
	assert.ok(error instanceof SubagentError);
	assert.match((error as SubagentError).message, new RegExp(HOST));
	assert.match((error as SubagentError).message, new RegExp("not-on-that-machine"));
	assert.deepEqual(h.wireFor("terminal.run"), []);
});

// ── negative: the 8 MB ceiling is enforced here, not by the core ───────────

test("S1: a file over 8 MB is refused before file.write is sent", async (t) => {
	const h = harness();
	t.after(() => h.cleanup());
	const huge = path.join(h.root, "huge.md");
	// Streamed so the test does not hold 9 MB of strings at once.
	const stream = createWriteStream(huge);
	const chunk = Buffer.alloc(1024 * 1024, 0x61);
	for (let index = 0; index < 9; index += 1) stream.write(chunk);
	await new Promise<void>((resolve, reject) => {
		stream.end(() => resolve());
		stream.on("error", reject);
	});
	assert.equal(statSync(huge).size, 9 * 1024 * 1024);
	assert.ok(statSync(huge).size > MAX_REMOTE_FILE_BYTES);

	const error = await mirrorRemoteFile(h.client, h.target, huge, path.join(h.remoteCwd, "huge.md")).then(
		() => undefined,
		(thrown: unknown) => thrown,
	);
	assert.ok(error instanceof SubagentError);
	assert.equal((error as SubagentError).code, ErrorCodes.INVALID_PARAMS);
	assert.match((error as SubagentError).message, new RegExp(String(9 * 1024 * 1024)));
	assert.match((error as SubagentError).message, new RegExp(String(MAX_REMOTE_FILE_BYTES)));
	assert.deepEqual(h.wireFor("file.write"), [], "nothing may be sent for an oversized file");
});
