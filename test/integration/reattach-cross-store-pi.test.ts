/**
 * #450 — the acceptance the issue measured, through a REAL `pi` process.
 *
 * `reattach-cross-store.test.ts` proves the scan surface in-process (real `hc`
 * client + real fake core + real stores). This file adds the last inch the issue's
 * acceptance 1 describes as a user experience: **restart `pi` in a DIFFERENT
 * directory than the one the child was launched from**, and have the new session
 * find it on its own — no `recover`, no `status <name>`, no `cwd:` hint — and then
 * announce its completion into that new session.
 *
 * Nothing here is simulated at the session level: it spawns the installed `pi`
 * CLI (`--print`) against the mock LLM provider, loading this checkout as a
 * package, in a temp `$HOME` whose two project directories are real stores:
 *
 *   $HOME/code/anotify/.pi-subagents   ← the leftover was launched here
 *                                      (record `orphaned`, ledger row running, a
 *                                       real terminal on the fake `njbox`)
 *   $HOME/agents                       ← the NEW session starts here
 *
 * The mock LLM asks for real tool calls (`subagent status`, `bash sleep`) and
 * echoes the tool result back as its final text, so `stdout` carries the exact
 * block a user would see.
 *
 * Skips (like the other mock-llm smoke tests) when `pi` is not on PATH.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { hcCliClient } from "../../src/hc/client.ts";
import { legionDbPath, openLegionDb } from "../../src/legion/db.ts";
import { insertNode } from "../../src/legion/nodes.ts";
import { RUN_OWNER_FILE, writeOwnerFile } from "../../src/runs/owner.ts";
import { formatStoreLabel } from "../../src/runs/store-scan.ts";
import { RunStore } from "../../src/runs/store.ts";
import { mockPiEnv, startMockLlm, writeMockPiHome } from "../mock-llm/index.ts";
import type { MockScript } from "../mock-llm/types.ts";
import { assistantMsg, modelChange, sessionHeader, userMsg } from "../helpers/fixtures.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(HERE, "../..");
const FAKE_CORE = path.resolve(HERE, "../helpers/fake-hc-core.mjs");
const HOST = "njbox";
const NAME = "anotify-uishift-budget";

const piProbe = spawnSync("pi", ["--version"], { encoding: "utf8", timeout: 15_000, stdio: ["ignore", "pipe", "pipe"] });
const piSkip = piProbe.error || piProbe.status !== 0 ? "pi is not installed on PATH" : false;

/** `subagent status` on turn 1 (after a `sleep 2` so session_start's pass is done), then echo it. */
const STATUS_SCRIPT: MockScript = {
	rules: [
		{ name: "settle", when: { turnIndex: 0 }, then: { type: "tool_call", name: "bash", arguments: { command: "sleep 2" } } },
		{ name: "status", when: { turnIndex: 1 }, then: { type: "tool_call", name: "subagent", arguments: { action: "status" } } },
		{ name: "echo", when: { turnIndex: 2 }, then: { type: "text", content: "STATUS_BLOCK_BEGIN\n{{lastToolContent}}\nSTATUS_BLOCK_END" } },
		{ name: "catch-all", then: { type: "text", content: "done" } },
	],
};

/**
 * Keep the session ALIVE past the watcher's first tick (15s, `REATTACH_WATCH_INTERVAL_MS`),
 * so the re-attach watcher inside the real process gets to settle and notify.
 * `turnIndex` 0 is the first assistant message, so this buys ~21s of wall clock.
 */
const LONG_LIVED_SCRIPT: MockScript = {
	rules: [
		{ name: "first", when: { turnIndex: 0 }, then: { type: "tool_call", name: "bash", arguments: { command: "sleep 3" } } },
		...Array.from({ length: 6 }, (_, index) => ({
			name: `keep-${index}`,
			when: { turnIndex: index + 1 },
			then: { type: "tool_call" as const, name: "bash", arguments: { command: "sleep 3" } },
		})),
		{ name: "catch-all", then: { type: "text", content: "SESSION_DONE" } },
	],
};

function runPi(args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number }): Promise<{ status: number | null; stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		const child = spawn("pi", args, { cwd: opts.cwd, env: opts.env, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => { stdout += String(chunk); });
		child.stderr.on("data", (chunk) => { stderr += String(chunk); });
		const timer = setTimeout(() => {
			child.kill("SIGTERM");
			setTimeout(() => child.kill("SIGKILL"), 2_000);
			reject(new Error(`pi did not finish in ${opts.timeoutMs}ms\n${stdout.slice(-4000)}\n${stderr.slice(-4000)}`));
		}, opts.timeoutMs);
		child.on("error", (error) => { clearTimeout(timer); reject(error); });
		child.on("exit", (status) => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
	});
}

/** The transcript the child wrote on its machine: one complete, gradeable turn. */
function finishedTranscript(text: string): string {
	return [
		sessionHeader({ cwd: "/srv/app" }),
		modelChange("workbuddy/deepseek-v4.1-flash"),
		userMsg("fix the flaky test"),
		assistantMsg({ text: `${text}\n{"ok": true, "reason": "tests pass"}`, stopReason: "stop" }),
	].join("\n") + "\n";
}

interface Scenario {
	root: string;
	home: string;
	newCwd: string;
	launchCwd: string;
	store: RunStore;
	runId: string;
	runDir: string;
	terminal: string;
	/** Run one real `pi --print` session in `newCwd` with the given mock script. */
	run: (script: MockScript) => Promise<{ status: number | null; output: string }>;
	/** The log file the SESSION wrote (under its own store root). */
	sessionLog: () => string;
	cleanup: () => void;
}

/**
 * The leftover, exactly as a killed session leaves it, plus the machinery to start
 * a real `pi` in the OTHER directory. `finishAfterMs` decides how long the child
 * stays alive on the fake machine.
 */
async function scenario(opts: { prefix: string; finishAfterMs: number }): Promise<Scenario> {
	const root = mkdtempSync(path.join(tmpdir(), opts.prefix));
	const previous = { ...process.env };
	const home = path.join(root, "home");
	const launchCwd = path.join(home, "code", "anotify");
	const newCwd = path.join(home, "agents");
	mkdirSync(launchCwd, { recursive: true });
	mkdirSync(newCwd, { recursive: true });
	const remoteRoot = path.join(root, "remote");
	const remoteCwd = path.join(remoteRoot, "work");
	mkdirSync(remoteCwd, { recursive: true });
	const binDir = path.join(root, "bin");
	mkdirSync(binDir, { recursive: true });
	const wrapper = path.join(binDir, "hc");
	// The installed `hc` is not replaced on this machine; the fake core is the one the
	// session's own probe talks to.
	writeFileSync(wrapper, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(FAKE_CORE)} "$@"\n`, { mode: 0o755 });
	chmodSync(wrapper, 0o755);
	const terminalsFile = path.join(root, "terminals.json");
	const terminalState = path.join(root, "terminal-state.json");
	writeFileSync(terminalsFile, "{}\n");
	writeFileSync(terminalState, "{}\n");
	Object.assign(process.env, {
		HC_BIN: wrapper,
		FAKE_HC_REMOTE_ROOT: remoteRoot,
		FAKE_HC_MACHINES: HOST,
		FAKE_HC_TERMINALS: terminalsFile,
		FAKE_HC_TERMINAL_STATE: terminalState,
		HOME: home,
	});

	// ── the leftover, exactly as a killed session leaves it ───────────────────
	const store = new RunStore({ rootDir: path.join(launchCwd, ".pi-subagents") });
	const previousSession = path.join(root, "sessions", "previous.jsonl");
	mkdirSync(path.dirname(previousSession), { recursive: true });
	writeFileSync(previousSession, "");
	const run = store.createRun({ task: `leftover ${NAME}`, cwd: launchCwd, sessionFile: previousSession });
	const runDir = store.runDir(run.runId);
	const remoteDir = path.posix.join(remoteRoot, ".pi-subagents-mirror", run.runId, NAME);
	const remoteSessionPath = path.posix.join(remoteDir, "session.jsonl");
	// One REAL terminal on the fake core; its state file makes it visible to the NEXT
	// `hc` process, i.e. to the pi session we are about to start.
	writeFileSync(
		terminalsFile,
		`${JSON.stringify({ "*": { state: "running", finish_after_ms: opts.finishAfterMs, writes: [{ path: remoteSessionPath, text: finishedTranscript("all green") }] } })}\n`,
	);
	const client = hcCliClient({ env: process.env });
	await client.start();
	let terminal: string;
	try {
		const result = await client.request<{ address: string }>("terminal.run", {
			on: HOST,
			name: `lgl-${run.runId}-${NAME}`,
			argv: [path.posix.join(remoteRoot, "bin", "pi")],
			cwd: remoteCwd,
		});
		terminal = result.address;
	} finally {
		client.close();
	}
	await store.addChild(run.runId, {
		name: NAME,
		sessionFile: path.join(runDir, `${NAME}.jsonl`),
		ownerToken: "tok",
		state: "orphaned",
		spawnedAt: new Date(Date.now() - 120_000).toISOString(),
		host: HOST,
		remoteDir,
		remoteTerminal: terminal,
		nodeId: `root.${NAME}`,
		orphaned: { at: Date.now() - 60_000, fate: "orphaned", reason: "session-shutdown", host: HOST, remoteDir },
	});
	writeOwnerFile(path.join(runDir, RUN_OWNER_FILE), 2_147_483_000);
	const db = openLegionDb(legionDbPath(runDir));
	try {
		insertNode(db, { id: "root", parentId: null, name: "root", role: "root", kind: "pi", depth: 0, runId: run.runId, status: "running" });
		insertNode(db, {
			parentId: "root",
			name: NAME,
			role: "worker",
			kind: "pi",
			status: "running",
			host: HOST,
			remoteDir,
			remoteTerminal: terminal,
			sessionFile: path.join(runDir, `${NAME}.jsonl`),
		});
	} finally {
		db.close();
	}

	return {
		root,
		home,
		newCwd,
		launchCwd,
		store,
		runId: run.runId,
		runDir,
		terminal,
		run: async (script) => {
			const mock = await startMockLlm({ script, port: 0 });
			try {
				const agentDir = path.join(root, "agent");
				writeMockPiHome({
					dir: agentDir,
					baseUrl: mock.baseUrl,
					packages: [PLUGIN_ROOT],
					extraSettings: {
						subagents: {
							// #445's switch stays on; #450 only widens the SCAN surface.
							reattachLiveChildren: true,
							crossMachine: { enabled: true, hosts: { [HOST]: { cwd: remoteCwd } } },
						},
					},
				});
				const childEnv: NodeJS.ProcessEnv = {
					// PATH matters: `pi` itself is resolved from it (same as the smoke test).
					...process.env,
					...mockPiEnv(agentDir),
					HOME: home,
					HC_BIN: wrapper,
					FAKE_HC_REMOTE_ROOT: remoteRoot,
					FAKE_HC_MACHINES: HOST,
					FAKE_HC_TERMINALS: terminalsFile,
					FAKE_HC_TERMINAL_STATE: terminalState,
					PI_OFFLINE: "1",
				};
				// A real root session: no injected legion identity, no child role.
				for (const key of ["PI_SUBAGENT_ROLE", "PI_SUBAGENT_CHILD", "PI_SUBAGENT_UTILITY_CHILD", "PI_SUBAGENT_ACCEPTANCE_ROLE", "PI_LEGION_DB", "PI_LEGION_NODE_ID", "PI_LEGION_PHASES", "HC_TERMINAL_ID", "HC_TERMINAL_SOCKET"]) {
					delete childEnv[key];
				}
				const result = await runPi(
					[
						"--print", "--mode", "text",
						"--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files",
						"--thinking", "off", "--model", "mock/flash", "--offline", "--approve",
						"--", "what is running right now?",
					],
					{ cwd: newCwd, env: childEnv, timeoutMs: 180_000 },
				);
				return { status: result.status, output: `${result.stdout}\n${result.stderr}` };
			} finally {
				await mock.close();
			}
		},
		sessionLog: () => {
			const file = path.join(newCwd, ".pi-subagents", "reattach-live-children.log");
			return existsSync(file) ? readFileSync(file, "utf8") : "";
		},
		cleanup: () => {
			for (const key of ["HC_BIN", "FAKE_HC_REMOTE_ROOT", "FAKE_HC_MACHINES", "FAKE_HC_TERMINALS", "FAKE_HC_TERMINAL_STATE", "HOME"]) {
				if (previous[key] === undefined) delete process.env[key];
				else process.env[key] = previous[key];
			}
			rmSync(root, { recursive: true, force: true });
		},
	};
}

// ── A1: the new session, in a different cwd, lists the leftover with `store=` ──

test("#450 A1 (real pi): restarting in a DIFFERENT cwd re-attaches the leftover and `status` shows it with `store=`", { skip: piSkip }, async () => {
	const s = await scenario({ prefix: "reattach-cross-pi-", finishAfterMs: 120_000 });
	try {
		const result = await s.run(STATUS_SCRIPT);
		assert.equal(result.status, 0, `pi exited ${result.status}: ${result.output.slice(-4000)}`);
		const output = result.output;

		// ── what the user sees: the child, from ANOTHER directory's store ────────
		assert.match(output, /STATUS_BLOCK_BEGIN/);
		assert.match(output, new RegExp(`${NAME} — state=working`), `the leftover must be listed by name: ${output.slice(-4000)}`);
		assert.match(output, new RegExp(`host=${HOST}`));
		assert.match(output, /store=~\/code\/anotify/, "the block must say which store the child lives in");
		assert.ok(output.includes(formatStoreLabel(s.store.rootDir, { home: s.home })), "the marker is the label discovery/report use");

		// ── the adoption really happened in that store (not only in the render) ──
		const record = s.store.findChild(s.runId, NAME)!;
		assert.equal(record.state, "working");
		assert.equal(record.orphaned, undefined);
		assert.equal(record.reattached?.host, HOST);
		const log = s.sessionLog();
		assert.match(log, /reattach stores=\d+ withRuns=1 candidates=1/);
		assert.match(log, /adopted .* store=~\/code\/anotify/);
	} finally {
		s.cleanup();
	}
});

// ── A1b: the completion lands in that new session, not in the one that died ────

test("#450 A1 (real pi): when the child ends, THAT session settles it and the notice is delivered (latch written)", { skip: piSkip }, async () => {
	// The child ends 4s after the terminal was created; the session stays alive past
	// the watcher's first 15s tick, so the settle + notice happen inside the process.
	const s = await scenario({ prefix: "reattach-cross-pi-notice-", finishAfterMs: 4_000 });
	try {
		const started = Date.now();
		const result = await s.run(LONG_LIVED_SCRIPT);
		assert.equal(result.status, 0, `pi exited ${result.status}: ${result.output.slice(-4000)}`);
		assert.ok(Date.now() - started >= 15_000, "the session must outlive the watcher's first tick for this case to mean anything");

		const record = s.store.findChild(s.runId, NAME)!;
		// `recordSettlement` made the record follow the ledger…
		assert.equal(record.state, "retired", `the child ended, so the record must not still claim working: ${JSON.stringify(record.execution)}`);
		assert.equal(record.execution?.status, "success");
		assert.equal(record.reattached?.notifiedAt !== undefined, true, "the latch is written only after a DELIVERED notice — this is the proof it reached the new session");
		const db = openLegionDb(legionDbPath(s.runDir));
		try {
			assert.equal((db.prepare("SELECT status FROM nodes WHERE name = ?").get(NAME) as { status?: string }).status, "settled");
		} finally {
			db.close();
		}
	} finally {
		s.cleanup();
	}
});
