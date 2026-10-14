import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
	AUTO_DOCTOR_MAX_CHARS,
	classifyFailure,
	enrichFailureWithAutoDoctor,
	sectionsForKind,
} from "../../src/extension/auto-doctor.ts";
import { clearSpawnFailures, recentSpawnFailures } from "../../src/extension/spawn-hints.ts";

test("classifyFailure gates the expected kinds", () => {
	assert.equal(
		classifyFailure({ message: "x", stderr: 'Error: Model "a:high" not found. Use --list-models' }),
		"model",
	);
	assert.equal(classifyFailure({ message: "insufficient memory to start", code: "INSUFFICIENT_MEMORY" }), "memory");
	assert.equal(classifyFailure({ message: "Cannot find package 'foo'", stderr: "ERR_MODULE_NOT_FOUND" }), "extension");
	assert.equal(classifyFailure({ message: "Pi RPC process exited during startup: boom", code: "START_FAILED" }), "spawn_exit");
	assert.equal(classifyFailure({ message: "nested spawn blocked by PI_SUBAGENT_ALLOW_NESTED" }), "nested");
	assert.equal(classifyFailure({ message: "unknown child: x", code: "NOT_FOUND" }), undefined);
});

test("sectionsForKind maps focused sections", () => {
	assert.deepEqual([...sectionsForKind("model")], ["models", "extensions", "next"]);
	assert.deepEqual([...sectionsForKind("memory")], ["memory", "next"]);
});

test("enrichFailureWithAutoDoctor attaches snippet for model miss; skips unrelated", () => {
	clearSpawnFailures();
	const agentDir = mkdtempSync(path.join(tmpdir(), "auto-doc-"));
	const prev = process.env.PI_CODING_AGENT_DIR;
	try {
		process.env.PI_CODING_AGENT_DIR = agentDir;
		mkdirSync(path.join(agentDir, "npm/node_modules/pi-any-endpoint/extensions"), { recursive: true });
		writeFileSync(
			path.join(agentDir, "npm/node_modules/pi-any-endpoint/package.json"),
			JSON.stringify({
				name: "pi-any-endpoint",
				keywords: ["provider"],
				description: "Pi provider",
				pi: { extensions: ["./extensions/index.ts"] },
			}),
		);
		writeFileSync(path.join(agentDir, "npm/node_modules/pi-any-endpoint/extensions/index.ts"), "export default {};\n");
		writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ packages: ["npm:pi-any-endpoint@0.1.2"] }));

		const enriched = enrichFailureWithAutoDoctor(
			'Pi RPC process exited during startup: Error: Model "workbuddy/x:high" not found',
			{
				name: "scout-0",
				stderr: 'Error: Model "workbuddy/x:high" not found. Use --list-models',
				args: ["--no-extensions", "--model", "workbuddy/x:high"],
				code: "START_FAILED",
			},
		);
		assert.match(enriched, /Hint:/);
		assert.match(enriched, /Legion auto-doctor \(model/);
		assert.match(enriched, /## Models \/ providers|## Extensions|## Next steps/);
		assert.match(enriched, /PI_LEGION_CHILD_EXTENSIONS|pi-any-endpoint/);
		assert.ok(enriched.length < AUTO_DOCTOR_MAX_CHARS + 800);
		assert.equal(recentSpawnFailures()[0]?.name, "scout-0");

		const plain = enrichFailureWithAutoDoctor("unknown child: z", {
			name: "z",
			code: "NOT_FOUND",
			record: false,
		});
		assert.equal(plain, "unknown child: z");
		assert.doesNotMatch(plain, /auto-doctor/);
	} finally {
		if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = prev;
		clearSpawnFailures();
		rmSync(agentDir, { recursive: true, force: true });
	}
});

test("enrichFailureWithAutoDoctor attaches memory section on INSUFFICIENT_MEMORY", () => {
	clearSpawnFailures();
	const enriched = enrichFailureWithAutoDoctor(
		"insufficient memory to start subagent scout-0: 100 MB available, 1184 MB required",
		{ name: "scout-0", code: "INSUFFICIENT_MEMORY" },
	);
	assert.match(enriched, /Legion auto-doctor \(memory/);
	assert.match(enriched, /## Memory/);
	assert.match(enriched, /## Next steps/);
	clearSpawnFailures();
});
