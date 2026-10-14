import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
	DOCTOR_SECTIONS,
	expectedModelsFromSettings,
	parseDoctorSections,
	parseListModels,
	runLegionDoctor,
} from "../../src/extension/legion-doctor.ts";
import { clearSpawnFailures, recordSpawnFailure } from "../../src/extension/spawn-hints.ts";
import { HYGIENE_LAST_FILE } from "../../src/runs/hygiene.ts";

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

test("parseDoctorSections validates names", () => {
	assert.deepEqual(parseDoctorSections("models memory"), ["models", "memory"]);
	assert.throws(() => parseDoctorSections("nope"), /Unknown doctor section/);
});

test("doctor flags CHILD_NO_MODELS and covers all sections", () => {
	clearSpawnFailures();
	const dir = mkdtempSync(path.join(tmpdir(), "legion-doctor-"));
	const store = mkdtempSync(path.join(tmpdir(), "legion-store-"));
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
		mkdirSync(path.join(store, "runs", "r-dead", "rpc-child-x"), { recursive: true });
		writeFileSync(path.join(store, "runs", "r-dead", "rpc-child-x", ".owner"), JSON.stringify({ pid: 1, host: "x", at: 1 }));
		writeFileSync(
			path.join(store, HYGIENE_LAST_FILE),
			JSON.stringify({ at: Date.now() - 60_000, removedTempDirs: 2, prunedRuns: 0, deletedEvents: 0, freedBytes: 100, errors: 0 }),
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
			storeRoot: store,
			probeModels: false,
			hostModels: ["any-endpoint/workbuddy/hy4-preview-ioa"],
			childModels: [],
			expectedModels: ["workbuddy/hy4-preview-ioa"],
			env: {
				...process.env,
				PI_LEGION_CHILD_INHERIT_EXTENSIONS: undefined,
				PI_LEGION_CHILD_EXTENSIONS: undefined,
			},
			runtime: {
				liveJobs: [{ name: "scout-0", state: "starting" }],
				treeNodes: [{ id: "root.scout-0", name: "scout-0", status: "running", phase: "verify" }],
				stopAvailable: true,
				idleEscWired: true,
				legionTools: ["subagent", "vexillatio"],
			},
			agents: [
				{
					name: "scout",
					description: "d",
					kind: "pi",
					filePath: "/f.md",
					tools: ["read", "lens_diagnostics", "bash"],
					systemPrompt: "",
					systemPromptMode: "replace",
					inheritProjectContext: true,
					inheritSkills: false,
					source: "user",
				},
			],
		});

		assert.equal(report.ok, false);
		assert.ok(report.issues.some((i) => i.code === "CHILD_NO_MODELS"));
		assert.ok(report.issues.some((i) => i.code === "TEAM_MODELS_MISSING"));
		assert.ok(report.issues.some((i) => i.code === "ROLE_MISSING_LENS"));
		assert.match(report.text, /export PI_LEGION_CHILD_EXTENSIONS=/);
		assert.match(report.text, /pi-any-endpoint\/extensions\/index\.ts/);
		assert.match(report.text, /## Extensions/);
		assert.match(report.text, /## Models \/ providers/);
		assert.match(report.text, /## Spawn/);
		assert.match(report.text, /## Memory/);
		assert.match(report.text, /## Tools \/ commands/);
		assert.match(report.text, /## Storage \/ hygiene/);
		assert.match(report.text, /## Session \/ runtime/);
		assert.match(report.text, /## Next steps/);
		assert.match(report.text, /last sweep:/);
		assert.match(report.text, /live jobs: 1/);
		assert.match(report.text, /--no-extensions: yes/);
		assert.ok(report.packages.some((p) => p.name === "pi-any-endpoint" && p.likelyProvider));
		assert.ok(report.packages.some((p) => p.extensionPaths[0] === extPath));
		for (const section of DOCTOR_SECTIONS) assert.ok(report.sections.includes(section));
	} finally {
		clearSpawnFailures();
		rmSync(dir, { recursive: true, force: true });
		rmSync(store, { recursive: true, force: true });
	}
});

test("doctor section filter keeps next steps", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "legion-doctor-sec-"));
	try {
		writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ packages: [] }));
		const report = runLegionDoctor({
			agentDir: dir,
			probeModels: false,
			hostModels: ["any-endpoint/x"],
			childModels: [],
			expectedModels: ["x"],
			sections: ["models"],
			env: { ...process.env, PI_LEGION_CHILD_INHERIT_EXTENSIONS: undefined },
		});
		assert.match(report.text, /## Models \/ providers/);
		assert.doesNotMatch(report.text, /## Extensions/);
		assert.match(report.text, /## Next steps/);
		assert.ok(report.sections.includes("models"));
		assert.ok(report.sections.includes("next"));
	} finally {
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
