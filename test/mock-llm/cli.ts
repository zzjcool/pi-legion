#!/usr/bin/env node
/**
 * Start the mock OpenAI-compatible LLM.
 *
 *   MOCK_LLM_PORT=8765 MOCK_LLM_SCENARIO=echo npm run mock-llm
 *   node --experimental-strip-types test/mock-llm/cli.ts --port 8765 --scenario spawn-scout
 *
 * Point pi at it via writeMockPiHome() or the models.json snippet in README.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { listScenarioNames, resolveScenario } from "./scenarios.ts";
import { startMockLlm } from "./server.ts";
import type { MockScript } from "./types.ts";

function usage(): never {
	process.stderr.write(`Usage: mock-llm [--port N] [--host H] [--scenario NAME] [--script PATH]

Scenarios: ${listScenarioNames().join(", ")}

Env:
  MOCK_LLM_PORT          listen port (default 8765 for CLI; 0 = ephemeral in library)
  MOCK_LLM_HOST          bind address (default 127.0.0.1)
  MOCK_LLM_SCENARIO      built-in scenario name
  MOCK_LLM_SCRIPT        JSON script file (sets scenario=script)
  MOCK_LLM_LOG           append request log path
  MOCK_TOOL_NAME         tool-once scenario tool name
  MOCK_TOOL_ARGS         tool-once scenario tool args JSON
`);
	process.exit(2);
}

function parseArgs(argv: string[]) {
	let port = Number(process.env.MOCK_LLM_PORT || 8765);
	let host = process.env.MOCK_LLM_HOST || "127.0.0.1";
	let scenario = process.env.MOCK_LLM_SCENARIO || "echo";
	let scriptPath = process.env.MOCK_LLM_SCRIPT;
	for (let i = 0; i < argv.length; i += 1) {
		const a = argv[i];
		if (a === "--help" || a === "-h") usage();
		if (a === "--port") {
			port = Number(argv[++i]);
			continue;
		}
		if (a === "--host") {
			host = argv[++i] ?? host;
			continue;
		}
		if (a === "--scenario") {
			scenario = argv[++i] ?? scenario;
			continue;
		}
		if (a === "--script") {
			scriptPath = argv[++i];
			scenario = "script";
			continue;
		}
		process.stderr.write(`Unknown arg: ${a}\n`);
		usage();
	}
	return { port, host, scenario, scriptPath };
}

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));
	let script: MockScript | undefined;
	if (args.scriptPath) {
		const abs = path.resolve(args.scriptPath);
		script = JSON.parse(fs.readFileSync(abs, "utf8")) as MockScript;
		args.scenario = "script";
	}
	// Validate early for clearer errors.
	resolveScenario(args.scenario, { script });
	const handle = await startMockLlm({
		host: args.host,
		port: args.port,
		scenario: args.scenario,
		...(script ? { script } : {}),
	});
	process.stdout.write(
		`mock-llm listening on ${handle.baseUrl} scenario=${handle.scenario}\n`,
	);
	const shutdown = async () => {
		await handle.close();
		process.exit(0);
	};
	process.on("SIGINT", () => void shutdown());
	process.on("SIGTERM", () => void shutdown());
}

const isMain =
	process.argv[1] &&
	path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1]);

if (isMain) {
	main().catch((error) => {
		process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : error}\n`);
		process.exit(1);
	});
}
