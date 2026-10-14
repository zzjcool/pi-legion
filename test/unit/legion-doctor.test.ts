import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
	expectedModelsFromSettings,
	parseListModels,
	runLegionDoctor,
} from "../../src/extension/legion-doctor.ts";
import { clearSpawnFailures, recordSpawnFailure } from "../../src/extension/spawn-hints.ts";

test("parseListModels reads pi --list-models table", () => {
	const out = parseListModels(`provider      model                               context  max-out  thinking  images
any-endpoint  workbuddy/hy4-preview-ioa           960K     64K      yes       yes   
any-endpoint  cursor-plugin/glm-5p3               1M       262.1K   yes       yes   
`);
	assert.deepEqual(out, [
		"any-endpoint/workbuddy/hy4-preview-ioa",
		"any-endpoint/cursor-plugin/glm-5p3",
	]);
	assert.deepEqual(parseListModels("No models available. Use /login"), []);
});

test("expectedModelsFromSettings reads team members", () => {
	const models = expectedModelsFromSettings({
		subagents: {
			team: "be-value",
			teams: {
				"be-value": {
					members: [
						{ agent: "scout", model: "workbuddy/hy4-preview-ioa" },
						"centurion",
						{ agent: "worker", model: "workbuddy/gpt-6-luna" },
					],
				},
			},
			defaultModel: "cursor-plugin/glm-5p3",
		},
	});
	assert.ok(models.includes("workbuddy/hy4-preview-ioa"));
	assert.ok(models.includes("workbuddy/gpt-6-luna"));
	assert.ok(models.includes("cursor-plugin/glm-5p3"));
});

test("doctor flags CHILD_NO_MODELS and suggests restoring extension", () => {
	clearSpawnFailures();
	const dir = mkdtempSync(path.join(tmpdir(), "legion-doctor-"));
	try {
		const npmRoot = path.join(dir, "npm", "node_modules", "pi-any-endpoint");
		mkdirSync(path.join(npmRoot, "extensions"), { recursive: true });
		writeFileSync(
			path.join(npmRoot, "package.json"),
			JSON.stringify({
				name: "pi-any-endpoint",
				keywords: ["pi", "provider"],
				description: "Pi provider for any compatible endpoint",
				pi: { extensions: ["./extensions/index.ts"] },
			}),
		);
		writeFileSync(path.join(npmRoot, "extensions", "index.ts"), "export default {};\n");
		writeFileSync(
			path.join(dir, "settings.json"),
			JSON.stringify({ packages: ["npm:pi-any-endpoint@0.1.2", "../../code/pi-legion"] }),
		);

		recordSpawnFailure({
			name: "scout-0",
			message: "exited",
			stderr: 'Error: Model "workbuddy/hy4-preview-ioa:high" not found. Use --list-models',
			hadNoExtensions: true,
		});

		const extPath = path.join(npmRoot, "extensions", "index.ts");
		const report = runLegionDoctor({
			agentDir: dir,
			probeModels: false,
			hostModels: ["any-endpoint/workbuddy/hy4-preview-ioa"],
			childModels: [],
			expectedModels: ["workbuddy/hy4-preview-ioa"],
			env: {
				...process.env,
				PI_LEGION_CHILD_INHERIT_EXTENSIONS: undefined,
				PI_LEGION_CHILD_EXTENSIONS: undefined,
			},
			runPi: (args) => {
				if (args.includes("--extension") && args.some((a) => a.includes("pi-any-endpoint"))) {
					return `provider model\nany-endpoint workbuddy/hy4-preview-ioa 1M 1K yes yes\n`;
				}
				if (args.includes("--no-extensions") && !args.includes("--extension")) {
					return "No models available.\n";
				}
				return `provider model\nany-endpoint workbuddy/hy4-preview-ioa 1M 1K yes yes\n`;
			},
		});

		assert.equal(report.ok, false);
		assert.ok(report.issues.some((i) => i.code === "CHILD_NO_MODELS"));
		assert.ok(report.issues.some((i) => i.code === "TEAM_MODELS_MISSING"));
		assert.match(report.text, /export PI_LEGION_CHILD_EXTENSIONS=/);
		assert.match(report.text, /pi-any-endpoint\/extensions\/index\.ts/);
		assert.match(report.text, /pi-any-endpoint/);
		assert.match(report.text, /--no-extensions: yes/);
		assert.ok(report.packages.some((p) => p.name === "pi-any-endpoint" && p.likelyProvider));
		assert.ok(report.packages.some((p) => p.extensionPaths[0] === extPath));
	} finally {
		clearSpawnFailures();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("doctor OK when child inherits or sees models", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "legion-doctor-ok-"));
	try {
		writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ packages: [] }));
		const report = runLegionDoctor({
			agentDir: dir,
			probeModels: false,
			hostModels: ["any-endpoint/x"],
			childModels: ["any-endpoint/x"],
			expectedModels: ["x"],
			env: { ...process.env, PI_LEGION_CHILD_INHERIT_EXTENSIONS: undefined },
		});
		assert.equal(report.ok, true);
		assert.equal(report.issues.filter((i) => i.severity === "error").length, 0);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
