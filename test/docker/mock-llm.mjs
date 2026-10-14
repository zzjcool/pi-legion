#!/usr/bin/env node
/**
 * Compatibility launcher for docker inside-* scripts.
 *
 * Prefer the TypeScript mock under the plugin tree (scriptable scenarios).
 * Falls back only if the entry is missing.
 *
 * Env (same as test/mock-llm):
 *   MOCK_LLM_PORT, MOCK_LLM_SCENARIO, MOCK_LLM_LOG,
 *   MOCK_TOOL_NAME, MOCK_TOOL_ARGS  (scenario tool-once)
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const candidates = [
	process.env.MOCK_LLM_ENTRY,
	"/plugin/test/mock-llm/cli.ts",
	path.resolve(here, "../mock-llm/cli.ts"),
].filter(Boolean);

const entry = candidates.find((candidate) => existsSync(candidate));
if (!entry) {
	process.stderr.write(
		`mock-llm: cli.ts not found (tried ${candidates.join(", ")}). ` +
			`Mount the repo at /plugin or set MOCK_LLM_ENTRY.\n`,
	);
	process.exit(1);
}

// Default docker / legacy callers to tool-once so existing inside-*.sh keep working.
if (!process.env.MOCK_LLM_SCENARIO) {
	process.env.MOCK_LLM_SCENARIO = "tool-once";
}
if (!process.env.MOCK_LLM_PORT) {
	process.env.MOCK_LLM_PORT = "8765";
}

const child = spawn(
	process.execPath,
	["--experimental-strip-types", entry],
	{ stdio: "inherit", env: process.env },
);
child.on("exit", (code, signal) => {
	if (signal) {
		process.kill(process.pid, signal);
		return;
	}
	process.exit(code ?? 1);
});
