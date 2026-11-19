/**
 * Defect E2: a headless run must be able to EXIT.
 *
 * `pi --print` returns from its turn and lets Node's event loop drain — it never
 * calls `process.exit` (`runPrintMode` in the host awaits `disposeRuntime()` and
 * returns). So any ref'd handle the extension keeps alive is an immortal `pi -p`.
 * The terminal backend keeps exactly one: the session-scoped `hc connect` child
 * process, opened lazily and never closed anywhere — retiring a CHILD ends that
 * child's terminal, not the transport.
 *
 * The 6.2.2 release run measured the consequence: the cross-machine scenario's
 * `pi -p` never exited and had to be killed by hand.
 *
 * Two levels, because they fail for different reasons:
 *   - the seam itself (`shutdown()` closes and drops the client), so a regression is
 *     a unit failure with an exact message;
 *   - a real `pi --print` process, so "the harness exits" is a MEASURED property of
 *     the product rather than of a mock.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import type { HcClient } from "../../src/hc/client.ts";
import { RoutingSupervisor } from "../../src/supervisor/routing-supervisor.ts";
import { TerminalSupervisor } from "../../src/supervisor/terminal-supervisor.ts";
import { mockPiEnv, startMockLlm, writeMockPiHome } from "../mock-llm/index.ts";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** A client that records what happened to it. */
function fakeClient() {
	const state = { started: 0, closed: 0, startResolve: undefined as (() => void) | undefined };
	const client = {
		async start() {
			state.started += 1;
		},
		async request() {
			return {} as never;
		},
		close() {
			state.closed += 1;
		},
	} as unknown as HcClient;
	return { client, state };
}

test("E2: `shutdown()` closes the session-scoped transport and drops it exactly once", async () => {
	const fake = fakeClient();
	const supervisor = new TerminalSupervisor({
		clientFactory: () => fake.client,
		env: { PATH: process.env.PATH ?? "" },
	});
	// Anything that needs the transport opens it; the seam must then be reachable.
	// `preflightRemoteDelivery` is the cheapest such call and is exactly what a
	// cross-machine launch performs first.
	await supervisor.preflightRemoteDelivery({
		host: "vps",
		target: {
			host: "vps",
			cwd: "/srv/app",
			node: "node",
			piCli: "pi",
			pathMap: [],
			piLegionRoot: "/srv/pi-legion",
			piExtensions: [],
			mirrorRoot: "/srv/.pi-subagents-mirror",
			worktreeRoot: "/srv/.pi-worktrees",
		},
		localRepo: pluginRoot,
	}).catch(() => {
		// The preflight may refuse for reasons that do not matter here: what matters is
		// that the transport was opened, which the assertion below proves.
	}).then(() => {});
	assert.ok(fake.state.started >= 1, "the transport was opened by a remote preflight");

	supervisor.shutdown();
	assert.equal(fake.state.closed, 1, "shutdown() closes the `hc connect` child — the one handle that outlives every child");
	supervisor.shutdown();
	assert.equal(fake.state.closed, 1, "and it is idempotent: the second call has nothing left to close");
});

test("E2: RoutingSupervisor.shutdown() reaches the terminal backend", async () => {
	const fake = fakeClient();
	const terminal = new TerminalSupervisor({ clientFactory: () => fake.client, env: { PATH: process.env.PATH ?? "" } });
	const routing = new RoutingSupervisor({ terminal });
	// Same trick as above: force the transport open, then let the facade close it.
	await terminal.preflightRemoteDelivery({
		host: "vps",
		target: {
			host: "vps",
			cwd: "/srv/app",
			node: "node",
			piCli: "pi",
			pathMap: [],
			piLegionRoot: "/srv/pi-legion",
			piExtensions: [],
			mirrorRoot: "/srv/.pi-subagents-mirror",
			worktreeRoot: "/srv/.pi-worktrees",
		},
		localRepo: pluginRoot,
	}).catch(() => { /* the refusal is not what this test is about */ });
	assert.ok(fake.state.started >= 1, "the transport is open");
	routing.shutdown();
	assert.equal(fake.state.closed, 1, "the facade forwards, so index.ts only has to call one method");
});

const piProbe = spawnSync("pi", ["--version"], { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"] });
const piSkip = piProbe.error || piProbe.status !== 0 ? "pi is not installed on PATH" : false;

function runPi(
	args: string[],
	opts: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number },
): Promise<{ status: number | null; stdout: string; stderr: string; ms: number; timedOut: boolean }> {
	return new Promise((resolve) => {
		const started = Date.now();
		const child = spawn("pi", args, { cwd: opts.cwd, env: opts.env, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		child.stdout.on("data", (chunk) => { stdout += String(chunk); });
		child.stderr.on("data", (chunk) => { stderr += String(chunk); });
		const timer = setTimeout(() => {
			// The measured failure of a hang: this fires, the test goes red, and the
			// process is killed so the suite cannot hang with it.
			timedOut = true;
			child.kill("SIGTERM");
			setTimeout(() => child.kill("SIGKILL"), 2_000);
		}, opts.timeoutMs);
		child.on("error", (error) => {
			clearTimeout(timer);
			resolve({ status: null, stdout, stderr: `${stderr}\n${String(error)}`, ms: Date.now() - started, timedOut });
		});
		child.on("exit", (status) => {
			clearTimeout(timer);
			resolve({ status, stdout, stderr, ms: Date.now() - started, timedOut });
		});
	});
}

test("E2: a real `pi --print` session with the plugin loaded EXITS on its own (bounded)", {
	skip: piSkip,
	timeout: 180_000,
}, async () => {
	const runDir = mkdtempSync(path.join(tmpdir(), "legion-exit-"));
	const mock = await startMockLlm({ scenario: "spawn-scout", port: 0 });
	try {
		const home = writeMockPiHome({
			dir: path.join(runDir, "agent"),
			baseUrl: mock.baseUrl,
			// The real plugin, so the dispatcher, the run store and the supervisors are
			// all constructed exactly as a user's session constructs them.
			packages: [pluginRoot],
			extraSettings: { subagents: { enabled: true } },
		});
		const result = await runPi(
			[
				"--print",
				"--mode",
				"text",
				"--no-skills",
				"--no-prompt-templates",
				"--no-themes",
				"--no-context-files",
				"--thinking",
				"off",
				"--model",
				home.modelRef,
				"--approve",
				"--",
				"Use the subagent tool once and then stop.",
			],
			{
				cwd: runDir,
				timeoutMs: 150_000,
				env: { ...process.env, ...mockPiEnv(home.agentDir), HOME: runDir },
			},
		);
		const combined = `${result.stdout}\n${result.stderr}`;
		assert.equal(result.timedOut, false, `pi --print did not exit within 150s (the E2 hang): ${combined.slice(-2000)}`);
		assert.equal(result.status, 0, `pi exited ${result.status}: ${combined.slice(-2000)}`);
		assert.ok(mock.requestCount() >= 1, "the session really ran (the mock answered)");
	} finally {
		await mock.close();
		rmSync(runDir, { recursive: true, force: true });
	}
});
