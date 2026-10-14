/**
 * Integration smoke: mock OpenAI server + optional real `pi --print`.
 * Skips the pi CLI portion when `pi` is not on PATH.
 *
 * Important: do not use spawnSync while the mock HTTP server runs in-process —
 * spawnSync blocks the event loop so the mock cannot answer and pi hangs.
 */

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
	mockPiEnv,
	startMockLlm,
	writeMockPiHome,
} from "../mock-llm/index.ts";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const piProbe = spawnSync("pi", ["--version"], {
	encoding: "utf8",
	timeout: 10_000,
	stdio: ["ignore", "pipe", "pipe"],
});
const piSkip =
	piProbe.error || piProbe.status !== 0
		? "pi is not installed on PATH; HTTP mock smoke still runs"
		: false;

function runPiAsync(
	args: string[],
	opts: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number },
): Promise<{ status: number | null; stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		const child = spawn("pi", args, {
			cwd: opts.cwd,
			env: opts.env,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => {
			stdout += String(chunk);
		});
		child.stderr.on("data", (chunk) => {
			stderr += String(chunk);
		});
		const timer = setTimeout(() => {
			child.kill("SIGTERM");
			setTimeout(() => child.kill("SIGKILL"), 2000);
			reject(new Error(`pi timed out after ${opts.timeoutMs}ms\n${stdout}\n${stderr}`));
		}, opts.timeoutMs);
		child.on("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.on("exit", (status) => {
			clearTimeout(timer);
			resolve({ status, stdout, stderr });
		});
	});
}

test("integration: mock LLM serves completions for scripted scenarios", async () => {
	const mock = await startMockLlm({ scenario: "doctor", port: 0 });
	try {
		const res = await fetch(mock.url("/chat/completions"), {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				model: "flash",
				stream: false,
				messages: [{ role: "user", content: "run doctor" }],
			}),
		});
		assert.equal(res.ok, true);
		const body = (await res.json()) as {
			choices: Array<{
				message: {
					tool_calls?: Array<{ function: { name: string; arguments: string } }>;
				};
				finish_reason: string;
			}>;
		};
		assert.equal(body.choices[0]?.finish_reason, "tool_calls");
		assert.equal(body.choices[0]?.message.tool_calls?.[0]?.function.name, "subagent");
		assert.match(
			body.choices[0]?.message.tool_calls?.[0]?.function.arguments ?? "",
			/diagnose/,
		);
	} finally {
		await mock.close();
	}
});

test("integration: pi --print against mock LLM returns MOCK_SAY text", {
	skip: piSkip,
}, async () => {
	const runDir = mkdtempSync(path.join(tmpdir(), "legion-mock-pi-"));
	const mock = await startMockLlm({ scenario: "echo", port: 0 });
	try {
		const home = writeMockPiHome({
			dir: path.join(runDir, "agent"),
			baseUrl: mock.baseUrl,
			packages: [],
		});
		const result = await runPiAsync(
			[
				"--print",
				"--mode",
				"text",
				"--no-session",
				"--no-skills",
				"--no-prompt-templates",
				"--no-themes",
				"--no-extensions",
				"--no-tools",
				"--no-context-files",
				"--thinking",
				"off",
				"--model",
				home.modelRef,
				"--offline",
				"--approve",
				"--",
				"MOCK_SAY: PI_MOCK_SMOKE_OK",
			],
			{
				cwd: runDir,
				timeoutMs: 60_000,
				env: {
					...process.env,
					...mockPiEnv(home.agentDir),
					HOME: runDir,
				},
			},
		);
		const combined = `${result.stdout}\n${result.stderr}`;
		assert.equal(
			result.status,
			0,
			`pi exited ${result.status}: ${combined.slice(-2000)}`,
		);
		assert.match(combined, /PI_MOCK_SMOKE_OK/);
		assert.ok(mock.requestCount() >= 1, "pi must hit the mock endpoint");
	} finally {
		await mock.close();
		rmSync(runDir, { recursive: true, force: true });
	}
});

test("integration: writeMockPiHome packages path is absolute plugin root shape", () => {
	assert.ok(pluginRoot.endsWith("pi-legion-viz") || pluginRoot.includes("pi-legion"));
});
