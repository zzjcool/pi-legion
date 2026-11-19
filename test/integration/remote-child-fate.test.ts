/**
 * Remote child fate — §7 (T1..T6) of `docs/contracts/remote-child-fate-v1.md`,
 * end to end through the REAL `HcCliClient`, the REAL read-back seam and the
 * fake `hc` core.
 *
 * The oracle is `test/helpers/fake-hc-core.mjs` + its `FAKE_HC_TERMINALS`
 * manifest: a terminal can now DIE (`state: "finished"` + `exit_code`) or stay
 * SILENT, and it can write files onto the "other machine". That is the only way
 * to prove the contract's claim — "a child that produced no transcript must say
 * WHY" — because the reason lives in facts the parent used to throw away (the
 * terminal's screen, its exit code) rather than in this process's own params.
 *
 * Nothing here touches a real `hc`, a socket or a second machine: `HC_BIN` runs
 * the fake core, and `FAKE_HC_REMOTE_ROOT` is a real directory, so every
 * assertion is about bytes that exist somewhere.
 */

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { HcCliClient, type HcClient, type HcMethod } from "../../src/hc/client.ts";
import { remoteDirFor, resolveHostTarget, type HostTarget } from "../../src/runs/remote.ts";
import { createRemoteSessionReadback, remoteMirrorPathFor, type RemoteReadbackResult } from "../../src/runs/remote-artifact.ts";
import { TerminalSupervisor, terminalName } from "../../src/supervisor/terminal-supervisor.ts";
import { ErrorCodes, SubagentError, type AgentConfig, type SubagentsSettings } from "../../src/shared/types.ts";
import type { SpawnInput } from "../../src/supervisor/types.ts";
import { renderCollect } from "../../index.ts";
import { assistantMsg, sessionHeader, userMsg } from "../helpers/fixtures.ts";

// ── fixtures ───────────────────────────────────────────────────────────────

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../..");
const FAKE_CORE = path.join(REPO_ROOT, "test/helpers/fake-hc-core.mjs");
// Hermetic: discovery reads THIS machine's install paths, and a remote launch
// refuses an argv path it cannot map. Inheritance off leaves exactly one
// absolute entry (this package's own), which the target maps via `piLegionRoot`.
process.env.PI_LEGION_CHILD_INHERIT_EXTENSIONS = "0";

const HOST = "fakebox";
/** Same run id the supervisor is built with, so `remoteDirFor` is the launch's dir. */
const RUN_ID = "run-xm-1";
const TERMINAL_ID = "t1k";
const SOCKET = "/tmp/hc-fake/default.sock";
const MODEL = "workbuddy/deepseek-v4.1-flash";

interface WireRequest {
	jsonrpc?: string;
	id?: number;
	method?: string;
	params?: Record<string, unknown>;
}

/** One `FAKE_HC_TERMINALS` entry (contract §7's manifest, one terminal at a time). */
interface TerminalFate {
	state?: string;
	exit_code?: number;
	screen?: string;
	writes?: Array<{ path: string; text?: string }>;
}

interface HarnessOptions {
	/**
	 * §4 start-up gate bound. `0` disables it (the normal case: the fake
	 * terminal already told its story); 200–500 exercises "alive but silent"
	 * without making a test wait out the production 8 s.
	 */
	remoteStartupConfirmMs: number;
}

interface Harness {
	root: string;
	/** What stands for the other machine's filesystem. */
	remoteRoot: string;
	/** Remote cwd configured for the target. */
	remoteCwd: string;
	/** Every request the fake core received, in order (both connections). */
	wire(): WireRequest[];
	wireFor(method: HcMethod): Record<string, unknown>[];
	client: HcClient;
	/** The client the read-back seam is handed (see {@link Harness.readback}). */
	reader(): HcClient;
	supervisor: TerminalSupervisor;
	target: HostTarget;
	/** The settings the read-back resolves ITS target from (must agree with `target`). */
	crossMachine: NonNullable<SubagentsSettings["crossMachine"]>;
	spawnRoot: string;
	/** Declare the fate of a terminal, keyed by the name `terminal.run` asked for. */
	terminals(manifest: Record<string, TerminalFate>): void;
	cleanup(): void;
}

/**
 * Every harness that has been built and not yet cleaned up.
 *
 * Per-test cleanup is `t.after`, because a FAILING assertion must still close
 * the transport — a leaked `hc connect` child keeps this process's event loop
 * alive forever (`node --test` has no per-test timeout), which turns one red
 * assertion into a hung suite. This list is the file-level backstop.
 */
const LIVE: Harness[] = [];
after(() => {
	for (const h of LIVE.splice(0)) h.cleanup();
});

function harness(options: HarnessOptions): Harness {
	const root = mkdtempSync(path.join(tmpdir(), "remote-child-fate-"));
	const remoteRoot = path.join(root, "remote");
	const remoteCwd = path.join(remoteRoot, "work");
	mkdirSync(remoteCwd, { recursive: true });
	// The preflight `test -f`s this package's entry on that machine, because every
	// child's argv loads it; the "operator" installed it under the remote ROOT.
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
	// The manifest lives in a FILE so a test can declare a fate after the harness
	// exists (it needs `remoteDirFor`, i.e. the target's mirrorRoot). The fake core
	// reads it per `terminal.run`, so two launches may see two different fates.
	const manifestPath = path.join(root, "terminals.json");
	writeFileSync(manifestPath, "{}");

	const env: NodeJS.ProcessEnv = {
		...process.env,
		HC_BIN: wrapper,
		HC_TERMINAL_SOCKET: SOCKET,
		HC_TERMINAL_ID: TERMINAL_ID,
		FAKE_HC_REMOTE_ROOT: remoteRoot,
		FAKE_HC_MACHINES: HOST,
		FAKE_HC_LOG: wirePath,
		FAKE_HC_TERMINALS: manifestPath,
	};
	const real = new HcCliClient({ env, requestTimeoutMs: 20_000 });
	const client: HcClient = {
		start: () => real.start(),
		close: () => real.close(),
		request: <T = unknown>(method: HcMethod, params: Record<string, unknown> = {}): Promise<T> =>
			real.request<T>(method, params),
	};
	const supervisor = new TerminalSupervisor({
		clientFactory: () => client,
		env,
		runId: RUN_ID,
		pollIntervalMs: 5,
		// §4: the gate is per-launch configuration, never the production 8 s.
		remoteStartupConfirmMs: options.remoteStartupConfirmMs,
	});
	const crossMachine: Harness["crossMachine"] = {
		enabled: true,
		hosts: {
			[HOST]: {
				cwd: remoteCwd,
				piLegionRoot: path.posix.join(remoteRoot, ".pi-legion"),
				// S5.6: the launch asks the child's own argv one question before it
				// starts a terminal, so "pi" must be something that machine can RUN.
				piCli: installFakePiCli(remoteRoot),
			},
		},
	};
	const target = resolveHostTarget(HOST, crossMachine);
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
		client,
		// A real core is ONE daemon that many `hc connect` clients address; the fake
		// core holds `terminals` per process. The read-back seam opens its own
		// connection (and closes it in `finally`), so handing it a no-op-close view of
		// THIS transport keeps both round trips inside one "core" — which is exactly
		// the situation the probe is written for.
		reader: () => ({
			start: () => real.start(),
			close: () => {},
			request: <T = unknown>(method: HcMethod, params: Record<string, unknown> = {}): Promise<T> =>
				real.request<T>(method, params),
		}),
		supervisor,
		target,
		crossMachine,
		spawnRoot,
		terminals: (manifest) => writeFileSync(manifestPath, JSON.stringify(manifest)),
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

/**
 * A `pi` CLI the "remote" machine can actually run (S5.6's startup probe).
 *
 * The probe asks `--list-models`, so the stub answers like a real registry: a
 * table listing the model this launch asks for. Anything else is the child's own
 * invocation, which only has to prove it started.
 */
function installFakePiCli(remoteRoot: string): string {
	const dir = path.join(remoteRoot, ".fake-pi");
	mkdirSync(dir, { recursive: true });
	const entry = path.join(dir, "cli.js");
	writeFileSync(
		entry,
		`#!/usr/bin/env node
if (process.argv.includes("--list-models")) {
	process.stdout.write("provider      model                                context  max-out  thinking  images\\n");
	process.stdout.write("any-endpoint  ${MODEL}         128k     8k       yes       no\\n");
} else {
	process.stdout.write("ok\\n");
}
`,
		{ mode: 0o755 },
	);
	return path.posix.join(remoteRoot, ".fake-pi", "cli.js");
}

function agent(overrides: Partial<AgentConfig> = {}): AgentConfig {
	return {
		name: "centurion",
		description: "fake-core remote child fate role",
		systemPromptMode: "append",
		inheritProjectContext: false,
		inheritSkills: false,
		kind: "pi",
		systemPrompt: "You are a remote test centurion.",
		source: "user",
		filePath: "/fake/centurion.md",
		worktree: true,
		...overrides,
	};
}

function spawnInput(h: Harness, overrides: Partial<SpawnInput> = {}): SpawnInput {
	return {
		name: "root.centurion-0",
		task: "Implement the slice.",
		agent: agent(),
		model: MODEL,
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

/** The remote mirror dir THIS launch uses — never hard-coded (contract §0.4). */
function remoteDir(h: Harness, input: SpawnInput): string {
	return remoteDirFor(h.target, RUN_ID, input.name);
}

/** A transcript a real `pi` would have written: header, one turn, one answer. */
function transcript(opts: { cwd: string }): string {
	return `${[
		sessionHeader({ id: "sess-remote-1", cwd: opts.cwd }),
		userMsg("Implement the slice."),
		assistantMsg({ text: "Implemented." }),
	].join("\n")}\n`;
}

/**
 * The read-back a collect performs, through the REAL seam (§5).
 *
 * One call = one read-back: `remoteDir`/`remoteTerminal` are the record's own
 * fields, so T1..T4 exercise the same plumbing a later `collect` would.
 */
function readback(
	h: Harness,
	handle: { name: string; remoteDir?: string; remoteTerminal?: string },
	overrides: { remoteDir?: string } = {},
) {
	const seam = createRemoteSessionReadback({
		crossMachine: h.crossMachine,
		clientFactory: () => h.reader(),
	});
	const request = {
		host: HOST,
		name: handle.name,
		localPath: remoteMirrorPathFor(path.join(h.root, "local"), handle.name),
		...((overrides.remoteDir ?? handle.remoteDir) ? { remoteDir: overrides.remoteDir ?? handle.remoteDir } : {}),
		...(handle.remoteTerminal ? { remoteTerminal: handle.remoteTerminal } : {}),
	};
	return seam(request);
}

/**
 * What `collect` shows the parent once the read-back has a class (§6).
 *
 * The `remoteReadback` object mirrors `Orchestrator.readbackFacts` (the private
 * mapping between the seam's result and `CollectResult`) so this file exercises
 * the render against the same shape the orchestrator feeds it.
 */
function rendered(name: string, result: RemoteReadbackResult): string {
	const remoteReadback: NonNullable<Parameters<typeof renderCollect>[1]["remoteReadback"]> = result.ok
		? {
			host: result.host,
			lines: result.lines,
			returned: result.returned,
			truncated: result.truncated,
			...(result.byteCapped ? { byteCapped: result.byteCapped } : {}),
			localPath: result.localPath,
		}
		: {
			host: result.host,
			lines: 0,
			returned: 0,
			truncated: false,
			reason: result.reason,
			fate: result.fate,
			evidence: result.evidence,
			nextStep: result.nextStep,
			...(result.screenTail && result.screenTail.length > 0 ? { screenTail: result.screenTail } : {}),
		};
	return renderCollect(name, {
		// §6.2's exact shape: an `unknown` verdict on a remote child.
		execution: { status: "unknown", reason: "no messages in session" },
		output: "",
		acceptance: { status: "pending" },
		remoteReadback,
	});
}

// ── T1: the happy path ─────────────────────────────────────────────────────

test("T1: a remote child that writes its transcript reads back complete, with no `read-back:` suffix", async (t) => {
	const h = harness({ remoteStartupConfirmMs: 0 });
	t.after(() => h.cleanup());
	const input = spawnInput(h);
	const dir = remoteDir(h, input);
	const sessionPath = path.posix.join(dir, "session.jsonl");
	// §7 T1: the ORACLE writes the transcript — the read-back has to cross the wire
	// to learn anything, which is the whole point of running this through a core.
	h.terminals({
		[terminalName(RUN_ID, input.name)]: {
			state: "running",
			writes: [{ path: sessionPath, text: transcript({ cwd: h.remoteCwd }) }],
		},
	});

	const handle = await h.supervisor.spawnChild(input);

	// §7 T1 + D2: the record carries the address the core really holds, as
	// `host/name` — a bare name never resolves a remote terminal.
	assert.ok(handle.remoteTerminal, "a remote launch must record the core's address");
	assert.equal(handle.remoteTerminal, `${HOST}/${terminalName(RUN_ID, input.name)}`);
	assert.match(handle.remoteTerminal, new RegExp(`^${HOST}/lgl-`));
	// §7 T1: launch and read-back must agree about the mirror dir, so the record's
	// own `remoteDir` is what a later process reads from.
	assert.equal(handle.remoteDir, dir);
	assert.equal(h.wireFor("terminal.run").length, 1);

	const collected = await readback(h, handle);
	assert.ok(collected.ok, `the read-back must succeed: ${JSON.stringify(collected)}`);
	if (!collected.ok) return;
	// §7 T1: "lines === returned" is the completeness claim the render makes.
	assert.equal(collected.lines, 3);
	assert.equal(collected.returned, 3);
	assert.equal(collected.truncated, false);

	const text = rendered(input.name, collected);
	assert.ok(
		text.includes(`read-back from host '${HOST}': 3 of 3 lines (complete)`),
		`the completeness line must be byte-for-byte the frozen one:\n${text}`,
	);
	// §6.2: the `· read-back:` suffix explains an UNKNOWN verdict; a complete
	// read-back must not grow one (the contract's T1 says so explicitly).
	assert.equal(text.includes("· read-back:"), false, `a complete read-back must not excuse the verdict:\n${text}`);
});

// ── T2: the child dies during start-up ─────────────────────────────────────

test("T2: a child that dies during start-up fails the launch with its own exit code and screen line", async (t) => {
	// §4: proving the death is the gate's job, so this is one of the launches that
	// NEEDS it. The first poll already sees `exit_code`, so 500 ms is a ceiling, not
	// a wait — and it keeps the test far away from the production 8 s.
	const h = harness({ remoteStartupConfirmMs: 500 });
	t.after(() => h.cleanup());
	const screen = 'Error: Failed to load extension "/nope/index.ts": Extension path does not exist';
	const input = spawnInput(h);
	// §7 T2 / §4: pi 1.5.2's measured startup death: exit 1, a session that is
	// never created, and the reason only on the terminal's own screen.
	h.terminals({ [terminalName(RUN_ID, input.name)]: { state: "finished", exit_code: 1, screen, writes: [] } });

	const error = await h.supervisor.spawnChild(input).then(() => undefined, (thrown: unknown) => thrown);
	assert.ok(error instanceof SubagentError, `expected a SubagentError, got ${String(error)}`);
	const failure = error as SubagentError;
	// §4/§7 T2: a launch that can PROVE the death refuses, in the launch.
	assert.equal(failure.code, ErrorCodes.START_FAILED);
	assert.match(failure.message, /did not survive startup/);
	// §4.1's frozen shape: the exit code, the dir verdict, the screen, the next
	// step and one copyable command.
	assert.match(failure.message, /exit: 1/);
	assert.match(failure.message, /dir: the mirror dir is (there|gone) \(/);
	assert.match(failure.message, /screen: .*Failed to load extension/);
	assert.match(failure.message, /next: .*the child's own error is on its terminal/);
	assert.match(failure.message, /Command \(run on '/);
	const details = failure.details as { host?: string; fate?: string; exitCode?: number };
	assert.equal(details.host, HOST);
	assert.equal(details.fate, "no-child");
	assert.equal(details.exitCode, 1);
	// §7 T2: the terminal WAS created — this is a proven death, not a pre-launch
	// refusal, which is the distinction the whole gate exists for.
	assert.equal(h.wireFor("terminal.run").length, 1);
	const gets = h.wireFor("terminal.get");
	assert.ok(
		gets.some((params) => String(params.terminal) === `${HOST}/${terminalName(RUN_ID, input.name)}`),
		`the gate must ask the core about THAT terminal, saw ${JSON.stringify(gets)}`,
	);
});

// ── T3: alive, no transcript ───────────────────────────────────────────────

test("T3: a live terminal with no transcript reads back `no-session`, with a next step", async (t) => {
	// §4 + #423: the LAUNCH gate now refuses this shape (see T3b below and
	// `test/unit/remote-launch-refusal.test.ts`), so the state is reached here the
	// only way it still exists in production: a child launched with the gate off
	// (harnesses, pre-#423 records). This test's subject is the READ-BACK
	// classification, and that must keep answering `no-session` — never `no-child` —
	// for a terminal the core still holds.
	const h = harness({ remoteStartupConfirmMs: 0 });
	t.after(() => h.cleanup());
	const input = spawnInput(h);
	// §7 T3: the terminal runs and writes NOTHING (no `writes`).
	h.terminals({ "*": { state: "running" } });

	const handle = await h.supervisor.spawnChild(input);

	const collected = await readback(h, handle);
	assert.ok(!collected.ok, `a missing transcript is not a success: ${JSON.stringify(collected)}`);
	if (collected.ok) return;
	// §2: alive + no file is `no-session`, never `no-child`.
	assert.equal(collected.fate, "no-session");
	assert.ok(collected.evidence.length > 0);
	// The probe really ASKED the core (it is the terminal's state, read over the wire,
	// that separates `no-session` from `no-child`).
	assert.ok(collected.evidence.includes("terminal running"), collected.evidence.join("; "));
	assert.match(collected.nextStep, /is not a verdict/);

	const text = rendered(input.name, collected);
	assert.match(text, /FAILED \(no-session\)/);
	assert.match(text, /  next: /);
	// §6.2: the execution line must never leave `unknown` unexplained.
	assert.match(text, /^execution: unknown \(no messages in session\) · read-back: no-session$/m);
});

test("T3b (#423): the same silent terminal with the gate ON fails the launch, naming the machine, cwd, terminal and screen", async (t) => {
	const h = harness({ remoteStartupConfirmMs: 200 });
	t.after(() => h.cleanup());
	const input = spawnInput(h);
	// The child stops at a prompt and never writes: no session, no exit code, and the
	// reason exists only on its terminal.
	h.terminals({ "*": { state: "running", screen: " Trust project folder?\n /srv/app\n → Trust" } });

	const error = await h.supervisor.spawnChild(input).then(() => undefined, (thrown: unknown) => thrown);
	assert.ok(error instanceof SubagentError, `a silent launch must be refused, got ${String(error)}`);
	const failure = error as SubagentError;
	assert.equal(failure.code, ErrorCodes.START_FAILED);
	// req 2: the five facts, on their own lines.
	assert.match(failure.message, new RegExp(`^host '${HOST}': the launch never proved the child started`, "m"));
	assert.match(failure.message, new RegExp(`^ {2}host: ${HOST}$`, "m"));
	assert.match(failure.message, /^ {2}cwd: /m);
	assert.match(failure.message, new RegExp(`^ {2}terminal: ${HOST}/`, "m"));
	assert.match(failure.message, /^ {2}hc error: /m);
	assert.match(failure.message, /^ {4}\|  Trust project folder\?$/m);
	// req 4: nothing that renders as `working` survives the refusal.
	assert.equal(h.supervisor.isAlive(input.name), false);
});

// ── T4: the record disagrees with the configuration ────────────────────────

test("T4: a record whose remoteDir disagrees with the configuration reads back `path`, naming both dirs", async (t) => {
	const h = harness({ remoteStartupConfirmMs: 0 });
	t.after(() => h.cleanup());
	const input = spawnInput(h);
	const configuredDir = remoteDir(h, input);
	// Same setup as T1: the transcript EXISTS — under the dir this configuration
	// computes. Only the RECORD is stale.
	h.terminals({
		"*": { state: "running", writes: [{ path: path.posix.join(configuredDir, "session.jsonl"), text: transcript({ cwd: h.remoteCwd }) }] },
	});
	const handle = await h.supervisor.spawnChild(input);

	// §7 T4: `path` is a PREFIX disagreement. `configuredMirrorDirFor` keeps the
	// record's run/handle segments on purpose (otherwise a run id would look like a
	// disagreement), so the stale value must differ in its prefix — an older
	// `cwd`/`worktreeRoot`, exactly what an operator changes under a live record.
	const staleDir = path.posix.join(h.remoteRoot, "old-root", ".pi-subagents-mirror", RUN_ID, input.name);
	assert.notEqual(staleDir, configuredDir);

	const collected = await readback(h, handle, { remoteDir: staleDir });
	assert.ok(!collected.ok, `a stale record cannot read the transcript: ${JSON.stringify(collected)}`);
	if (collected.ok) return;
	assert.equal(collected.fate, "path");
	const evidence = collected.evidence.join("; ");
	assert.ok(evidence.includes(`recorded dir: ${staleDir}`), evidence);
	assert.ok(evidence.includes(`configured dir: ${configuredDir}`), evidence);

	const text = rendered(input.name, collected);
	assert.match(text, /FAILED \(path\)/);
	// §7 T4: both dirs, or "the dirs disagree" is unfalsifiable.
	assert.ok(text.includes(staleDir), `the render must name the RECORDED dir:\n${text}`);
	assert.ok(text.includes(configuredDir), `the render must name the CONFIGURED dir:\n${text}`);
	assert.match(text, /  next: .*subagents\.crossMachine\.hosts\.fakebox/);
});

// ── T5: piExtensions is read ON that machine ───────────────────────────────

test("T5: a piExtensions entry missing on the target refuses the launch before any terminal exists", async (t) => {
	const h = harness({ remoteStartupConfirmMs: 0 });
	t.after(() => h.cleanup());
	// A path the operator declared and that does not exist on THAT machine.
	const missing = path.posix.join(h.remoteRoot, "host-ext", "missing-provider.ts");
	const target: HostTarget = { ...h.target, piExtensions: [missing] };

	const error = await h.supervisor
		.spawnChild(spawnInput(h, { hostTarget: target }))
		.then(() => undefined, (thrown: unknown) => thrown);
	assert.ok(error instanceof SubagentError, `expected a SubagentError, got ${String(error)}`);
	const failure = error as SubagentError;
	// §3: exit 17 is a refusal that names the file and the key — INVALID_PARAMS,
	// not START_FAILED (retrying the next model would repeat the same refusal).
	assert.equal(failure.code, ErrorCodes.INVALID_PARAMS);
	assert.match(failure.message, /piExtensions entry '/);
	assert.ok(failure.message.includes(missing), `the message must name the missing file:\n${failure.message}`);
	assert.match(failure.message, /does not exist on that machine/);
	assert.match(failure.message, /subagents\.crossMachine\.hosts\.fakebox\.piExtensions/);
	// §3/§7 T5: checked BEFORE the terminal exists — nothing to attach to yet.
	assert.deepEqual(h.wireFor("terminal.run"), [], "no terminal may be created for a missing piExtensions entry");
	// The exit code that carries the fact is in the script the machine ran.
	const preflight = h.wireFor("machine.exec").find((params) => String(params.line ?? "").includes(missing));
	assert.ok(preflight, `the preflight script must test the entry, saw ${JSON.stringify(h.wireFor("machine.exec").map((p) => p.line ?? p.argv))}`);
	assert.match(String(preflight.line), /exit 17/);
});

// ── T6: an extension that cannot be mapped is refused BEFORE the terminal ───

test("T6: an extension no pathMap/package rule can reach refuses the launch, before any terminal exists", async (t) => {
	const h = harness({ remoteStartupConfirmMs: 0 });
	t.after(() => h.cleanup());
	// Outside the checkout, no `pathMap` prefix maps it, and it is not inside an
	// installed npm package: v1.2 refuses this instead of handing the remote child a
	// path to nothing (or silently dropping it, which is how a child loses its
	// provider and then "starts and does nothing").
	const parentOnly = "/opt/parent-only/ext/index.ts";
	const input = spawnInput(h, { agent: agent({ extensions: [parentOnly] }) });

	const failure = await h.supervisor.spawnChild(input).then(
		() => undefined,
		(thrown: unknown) => thrown,
	);
	assert.ok(failure instanceof SubagentError, `expected a refusal, got ${String(failure)}`);
	assert.equal(failure.code, ErrorCodes.INVALID_PARAMS);
	assert.ok(failure.message.includes(parentOnly), `the refusal must name the path:\n${failure.message}`);
	assert.match(failure.message, /cannot be mapped to that machine/);
	assert.match(failure.message, /subagents\.crossMachine\.hosts\.fakebox\.pathMap/);
	// The point of a pre-launch refusal: nothing was created over there.
	assert.deepEqual(h.wireFor("terminal.run"), [], "no terminal may be created for an unmappable extension");
});
