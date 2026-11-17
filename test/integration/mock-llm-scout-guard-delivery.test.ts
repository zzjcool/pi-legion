/**
 * scout-guard delivery *point* (#17 follow-up): the reminder must land at a
 * turn boundary mid-run, not after the agent has stopped.
 *
 * The unit tests and mock-llm-scout-guard-e2e.test.ts assert *that* a reminder is
 * sent and with which options; this file asserts *where it lands* by running the
 * real host (`pi --print`) against the mock endpoint. That distinction is what
 * regressed: `deliverAs: "followUp"` also sent a well-formed reminder, it just
 * landed after the work was over.
 *
 * How the two modes are told apart end to end:
 *   - the mock keeps returning read-class tool calls (`ls`) every turn, so the
 *     tool loop never becomes idle;
 *   - `steer` is drained at the turn boundary (`agent-loop.js:191`), so the
 *     request after the Nth read already carries the reminder and the mock can
 *     answer `..._OK_AT_TURN_<n>`;
 *   - `followUp` is only drained once the agent has no more tool calls
 *     (`agent-loop.js:197`), which never happens here, so the cap rule fires and
 *     the mock answers `..._DEFERRED`.
 *
 * Runs the host bundle shipped in devDependencies, so no PATH `pi` is required.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { mockPiEnv, startMockLlm, writeMockPiHome } from "../mock-llm/index.ts";
import type { MockScript } from "../mock-llm/index.ts";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../");

const THRESHOLD = 8;
/** Read-class tool calls the mock keeps issuing. Must stay above THRESHOLD. */
const READ_CALLS = 12;
/** Substring that only the guard's reminder copy contains. */
const REMINDER_MARKER = "若这是侦察工作";
const OK_MARKER = "SCOUT_GUARD_MID_RUN_OK";
const DEFERRED_MARKER = "SCOUT_GUARD_REMINDER_DEFERRED";
const DUPLICATED_MARKER = "SCOUT_GUARD_DUPLICATED";

/**
 * The host bundle from devDependencies. `package.json` "bin" points at
 * dist/bundle/cli.js; resolving the package entry keeps this pinned to the
 * version CI installs instead of whatever `pi` happens to be on PATH.
 */
function hostCliPath(): string {
	const entry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
	return path.resolve(path.dirname(entry), "bundle/cli.js");
}

/**
 * First matching rule wins. Rule order matters: the reminder rule is tested
 * before the read rule, so the request that carries the reminder is answered
 * with the marker rather than with another tool call.
 */
function deliveryScript(): MockScript {
	const rules: MockScript["rules"] = [
		{
			// Ordered first: if the guard ever queued a second reminder into the same
			// streak, the model would answer with this instead of the OK marker, which
			// would break the assertions below. This is the end-to-end answer to "does
			// steering at a tool boundary make the reminder fire repeatedly?".
			name: "duplicate-reminder",
			when: { promptMatches: `${REMINDER_MARKER}[\\s\\S]*${REMINDER_MARKER}` },
			then: { type: "text", content: DUPLICATED_MARKER },
		},
		{
			name: "reminder-arrived-mid-run",
			when: { promptIncludes: REMINDER_MARKER },
			then: { type: "text", content: `${OK_MARKER}_AT_TURN_{{turnIndex}}` },
		},
		{
			name: "deferred-cap",
			when: { turnIndex: READ_CALLS },
			then: { type: "text", content: DEFERRED_MARKER },
		},
	];
	for (let index = 0; index < READ_CALLS; index += 1) {
		rules.push({
			name: `read-${index}`,
			when: { turnIndex: index },
			then: {
				type: "tool_call",
				name: "ls",
				arguments: { path: "." },
				id: `call_read_${index}`,
			},
		});
	}
	rules.push({ name: "default", then: { type: "text", content: "SCOUT_GUARD_UNEXPECTED" } });
	return { models: [{ id: "flash", name: "Mock Flash" }], rules };
}

function runHost(
	args: string[],
	opts: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number },
): Promise<{ status: number | null; stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		// Never spawnSync: the mock HTTP server is in-process.
		const child = spawn(process.execPath, [hostCliPath(), ...args], {
			cwd: opts.cwd,
			env: opts.env,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => void (stdout += String(chunk)));
		child.stderr.on("data", (chunk) => void (stderr += String(chunk)));
		const timer = setTimeout(() => {
			child.kill("SIGTERM");
			setTimeout(() => child.kill("SIGKILL"), 2000);
			reject(new Error(`host timed out after ${opts.timeoutMs}ms\n${stdout}\n${stderr}`));
		}, opts.timeoutMs);
		child.on("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.on("close", (status) => {
			clearTimeout(timer);
			resolve({ status, stdout, stderr });
		});
	});
}

test("delivery point: the Nth-read reminder reaches the model mid-run, not after the turn", async () => {
	const runDir = mkdtempSync(path.join(tmpdir(), "legion-scout-delivery-"));
	const mock = await startMockLlm({ scenario: "script", script: deliveryScript(), port: 0 });
	try {
		const home = writeMockPiHome({
			dir: path.join(runDir, "agent"),
			baseUrl: mock.baseUrl,
			packages: [],
			extraSettings: {
				subagents: {
					enabled: true,
					scoutGuard: { enabled: true, threshold: THRESHOLD, cooldownMs: 120_000 },
				},
			},
		});
		const env: NodeJS.ProcessEnv = {
			...process.env,
			...mockPiEnv(home.agentDir),
			HOME: runDir,
		};
		// A nested legion child must never run this test's guard logic.
		for (const key of Object.keys(env)) {
			if (key.startsWith("PI_SUBAGENT_") || key.startsWith("PI_LEGION_")) delete env[key];
		}

		const result = await runHost(
			[
				"--print",
				"--mode",
				"text",
				"--no-session",
				"--no-skills",
				"--no-prompt-templates",
				"--no-themes",
				"--no-context-files",
				// Explicit -e still loads under --no-extensions, so only this repo is
				// loaded and no ambient package can obscure the result.
				"--no-extensions",
				"-e",
				path.join(pluginRoot, "index.ts"),
				"--tools",
				"ls",
				"--thinking",
				"off",
				"--model",
				home.modelRef,
				"--offline",
				"--approve",
				"--",
				"walk the tree and report what you find",
			],
			{ cwd: runDir, env, timeoutMs: 120_000 },
		);

		const combined = `${result.stdout}\n${result.stderr}`;
		assert.equal(
			result.status,
			0,
			`host exited ${result.status}: ${combined.slice(-3000)}`,
		);
		// `--mode text` prints only the final assistant text, so this asserts on the
		// turn the reminder was *seen* at. turnIndex 8 is the boundary right after the
		// 8th read; 9 is tolerated because the reminder is sent from a deferred timer
		// and may lose one race — still well inside the still-pending read loop. Under
		// `followUp` the reminder only surfaced at turn 13, after `deferred-cap` ended
		// the loop, which is exactly the "reminder arrives once the work is over" bug.
		assert.match(
			combined,
			new RegExp(`${OK_MARKER}_AT_TURN_(${THRESHOLD}|${THRESHOLD + 1})\\b`),
			`the reminder must land at a turn boundary while reads are still pending: ${combined.slice(-3000)}`,
		);
		assert.ok(
			mock.requestCount() >= THRESHOLD + 1,
			`expected at least ${THRESHOLD + 1} requests, got ${mock.requestCount()}`,
		);
	} finally {
		await mock.close();
		rmSync(runDir, { recursive: true, force: true });
	}
});
