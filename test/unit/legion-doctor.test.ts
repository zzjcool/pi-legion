import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { BUILTIN_AGENTS_DIR, loadAgentsFromDir } from "../../src/agents/agents.ts";
import {
	DOCTOR_SECTIONS,
	HYGIENE_SWEEP_STALE_DAYS,
	LEGION_SLASH_HELP_LINES,
	expectedModelsFromSettings,
	parseDoctorSections,
	parseListModels,
	runLegionDoctor,
} from "../../src/extension/legion-doctor.ts";
import { clearSpawnFailures, recordSpawnFailure } from "../../src/extension/spawn-hints.ts";
import { HYGIENE_DEFAULTS, HYGIENE_LAST_FILE } from "../../src/runs/hygiene.ts";
import { buildPiArgs } from "../../src/runs/args.ts";

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
		for (const line of LEGION_SLASH_HELP_LINES) {
			assert.ok(report.text.includes(line), `doctor slash list missing: ${line}`);
		}
		assert.match(report.text, /- slash: `\/legion doctor \[section\]`/);
		assert.match(report.text, /- tool: `subagent\(\{ action: "diagnose" \}\)`/);
		assert.doesNotMatch(report.text, /subagent\(\{ action: "diagnose" \}\) or `subagent\(\{ action: "diagnose" \}\)`/);
		const tools = report.text.split("## Tools / commands")[1]?.split("\n## ")[0] ?? "";
		assert.equal((tools.match(/subagent\(\{ action: "diagnose" \}\)/g) ?? []).length, 1);
		assert.equal(report.issues.some((issue) => issue.code === "HYGIENE_SWEEP_STALE"), false);
		assert.match(report.text, /\/scout-guard \| \/no-scout-guard/);
		assert.match(report.text, /\/legion on \| \/legion off/);
		assert.match(report.text, /\/legion status \[name\]/);
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

const LENS_TOOL = /lens|symbol_search|project_report|module_report|read_symbol|read_enclosing/i;

test("#70 bundled planner/reviewer/worker do not promise lens tools under --no-extensions", () => {
	const roles = loadAgentsFromDir(BUILTIN_AGENTS_DIR, "builtin").filter((agent) =>
		["planner", "reviewer", "worker"].includes(agent.name),
	);
	assert.deepEqual(roles.map((agent) => agent.name).sort(), ["planner", "reviewer", "worker"]);

	const prevInherit = process.env.PI_LEGION_CHILD_INHERIT_EXTENSIONS;
	const prevExtra = process.env.PI_LEGION_CHILD_EXTENSIONS;
	delete process.env.PI_LEGION_CHILD_INHERIT_EXTENSIONS;
	delete process.env.PI_LEGION_CHILD_EXTENSIONS;
	const dir = mkdtempSync(path.join(tmpdir(), "legion-doctor-lens-"));
	try {
		writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ packages: [] }));
		for (const agent of roles) {
			assert.equal(
				(agent.tools ?? []).some((tool) => LENS_TOOL.test(tool)),
				false,
				`${agent.name} tools`,
			);
			assert.doesNotMatch(agent.systemPrompt, /pi-lens|lens_|module_report|read_symbol|symbol_search/);
			const args = buildPiArgs({
				agent,
				task: "t",
				sessionFile: path.join(dir, "session.jsonl"),
				tempDir: dir,
			}).args;
			assert.ok(args.includes("--no-extensions"));
			const extensions = args.flatMap((arg, i) => (arg === "--extension" ? [args[i + 1] ?? ""] : []));
			assert.equal(extensions.some((ext) => /pi-lens/i.test(ext)), false);
		}

		const report = runLegionDoctor({
			agentDir: dir,
			probeModels: false,
			hostModels: ["any-endpoint/x"],
			childModels: ["any-endpoint/x"],
			expectedModels: ["x"],
			env: {
				...process.env,
				PI_LEGION_CHILD_INHERIT_EXTENSIONS: undefined,
				PI_LEGION_CHILD_EXTENSIONS: undefined,
			},
			agents: roles,
		});
		assert.equal(report.issues.filter((issue) => issue.code === "ROLE_MISSING_LENS").length, 0);
	} finally {
		if (prevInherit === undefined) delete process.env.PI_LEGION_CHILD_INHERIT_EXTENSIONS;
		else process.env.PI_LEGION_CHILD_INHERIT_EXTENSIONS = prevInherit;
		if (prevExtra === undefined) delete process.env.PI_LEGION_CHILD_EXTENSIONS;
		else process.env.PI_LEGION_CHILD_EXTENSIONS = prevExtra;
		rmSync(dir, { recursive: true, force: true });
	}
});

const HYGIENE_HOUR_MS = 60 * 60 * 1000;

function runStorageDoctor(env: NodeJS.ProcessEnv, storeRoot?: string) {
	const dir = mkdtempSync(path.join(tmpdir(), "legion-doctor-hy-"));
	writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ packages: [] }));
	const report = runLegionDoctor({
		agentDir: dir,
		storeRoot,
		probeModels: false,
		hostModels: ["any-endpoint/x"],
		childModels: ["any-endpoint/x"],
		expectedModels: ["x"],
		sections: ["storage"],
		env: {
			HOME: process.env.HOME,
			PI_LEGION_MIN_FREE_MEM_MB: "0",
			...env,
		},
	});
	return { dir, report };
}

test("doctor storage prints hygiene defaults vs env and a missing-sweep hint", () => {
	const store = mkdtempSync(path.join(tmpdir(), "legion-store-hy-"));
	const { dir, report } = runStorageDoctor({}, store);
	try {
		assert.match(report.text, /## Storage \/ hygiene/);
		assert.match(report.text, /hygiene enabled: true \(default; PI_LEGION_HYGIENE\)/);
		assert.match(report.text, /resolveHygieneConfig\(\):/);
		assert.match(report.text, new RegExp(`retentionDays=${HYGIENE_DEFAULTS.retentionDays}d \\(default\\)`));
		assert.match(report.text, new RegExp(`staleNodeHours=${HYGIENE_DEFAULTS.staleNodeHours}h \\(default\\)`));
		assert.match(report.text, new RegExp(`legacyTempHours=${HYGIENE_DEFAULTS.legacyTempHours}h \\(default\\)`));
		assert.match(report.text, new RegExp(`eventRetentionDays=${HYGIENE_DEFAULTS.eventRetentionDays}d \\(default\\)`));
		assert.match(report.text, new RegExp(`eventMaxRows=${HYGIENE_DEFAULTS.eventMaxRows} \\(default\\)`));
		assert.match(report.text, /last sweep: \(no marker yet/);
		const issue = report.issues.find((item) => item.code === "HYGIENE_SWEEP_STALE");
		assert.equal(issue?.severity, "info");
		assert.equal(issue?.section, "storage");
		assert.match(issue?.message ?? "", /No \.hygiene-last\.json/);
		assert.match(report.text, /\[info\] HYGIENE_SWEEP_STALE @storage:/);
		assert.match(report.text, /Restart the root pi session so startup hygiene runs, or check PI_LEGION_HYGIENE=0/);
		assert.match(report.text, /## Next steps/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
		rmSync(store, { recursive: true, force: true });
	}
});

test("doctor storage labels env hygiene overrides and ignores invalid values", () => {
	const store = mkdtempSync(path.join(tmpdir(), "legion-store-hy-env-"));
	writeFileSync(
		path.join(store, HYGIENE_LAST_FILE),
		JSON.stringify({ at: Date.now() - HYGIENE_HOUR_MS, removedTempDirs: 0, prunedRuns: 0, deletedEvents: 0, freedBytes: 0, errors: 0 }),
	);
	const { dir, report } = runStorageDoctor({
		PI_LEGION_HYGIENE: "0",
		PI_LEGION_RUN_RETENTION_DAYS: "3",
		PI_LEGION_EVENT_MAX_ROWS: "10",
		PI_LEGION_STALE_NODE_HOURS: "x",
		PI_LEGION_STALE_TEMP_HOURS: "-1",
	}, store);
	try {
		assert.match(report.text, /hygiene enabled: false \(env PI_LEGION_HYGIENE=0\)/);
		assert.match(report.text, /retentionDays=3d \(env PI_LEGION_RUN_RETENTION_DAYS\)/);
		assert.match(report.text, /eventMaxRows=10 \(env PI_LEGION_EVENT_MAX_ROWS\)/);
		assert.match(report.text, new RegExp(`staleNodeHours=${HYGIENE_DEFAULTS.staleNodeHours}h \\(default\\)`));
		assert.match(report.text, new RegExp(`legacyTempHours=${HYGIENE_DEFAULTS.legacyTempHours}h \\(default\\)`));
		assert.equal(report.issues.some((issue) => issue.code === "HYGIENE_SWEEP_STALE"), false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
		rmSync(store, { recursive: true, force: true });
	}
});

test("doctor storage hints when the hygiene sweep is older than N days", () => {
	const store = mkdtempSync(path.join(tmpdir(), "legion-store-hy-stale-"));
	const staleAt = Date.now() - (HYGIENE_SWEEP_STALE_DAYS * 24 * HYGIENE_HOUR_MS + HYGIENE_HOUR_MS);
	writeFileSync(path.join(store, HYGIENE_LAST_FILE), JSON.stringify({ at: staleAt }));
	const { dir, report } = runStorageDoctor({}, store);
	try {
		const issue = report.issues.find((item) => item.code === "HYGIENE_SWEEP_STALE");
		assert.match(issue?.message ?? "", new RegExp(`older than ${HYGIENE_SWEEP_STALE_DAYS} days`));
		assert.match(issue?.fix ?? "", /PI_LEGION_HYGIENE=0/);
		assert.match(report.text, new RegExp(`older than ${HYGIENE_SWEEP_STALE_DAYS} days`));
		assert.match(report.text, /Restart the root pi session so startup hygiene runs, or check PI_LEGION_HYGIENE=0/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
		rmSync(store, { recursive: true, force: true });
	}
});

test("doctor storage keeps a sweep inside the stale window quiet", () => {
	const store = mkdtempSync(path.join(tmpdir(), "legion-store-hy-fresh-"));
	const recentAt = Date.now() - ((HYGIENE_SWEEP_STALE_DAYS * 24 - 1) * HYGIENE_HOUR_MS);
	writeFileSync(path.join(store, HYGIENE_LAST_FILE), JSON.stringify({ at: recentAt, removedTempDirs: 1 }));
	const { dir, report } = runStorageDoctor({}, store);
	try {
		assert.equal(report.issues.some((issue) => issue.code === "HYGIENE_SWEEP_STALE"), false);
		assert.doesNotMatch(report.text, /HYGIENE_SWEEP_STALE/);
		assert.match(report.text, /last sweep:/);
		assert.match(report.text, /removedTemps=1/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
		rmSync(store, { recursive: true, force: true });
	}
});

test("hygiene sweep hint stays out of unrelated doctor sections", () => {
	const store = mkdtempSync(path.join(tmpdir(), "legion-store-hy-filter-"));
	const dir = mkdtempSync(path.join(tmpdir(), "legion-doctor-hy-filter-"));
	try {
		writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ packages: [] }));
		const report = runLegionDoctor({
			agentDir: dir,
			storeRoot: store,
			probeModels: false,
			hostModels: ["any-endpoint/x"],
			childModels: ["any-endpoint/x"],
			expectedModels: ["x"],
			sections: ["models"],
			env: { HOME: process.env.HOME, PI_LEGION_MIN_FREE_MEM_MB: "0" },
		});
		assert.ok(report.issues.some((issue) => issue.code === "HYGIENE_SWEEP_STALE"));
		assert.doesNotMatch(report.text, /HYGIENE_SWEEP_STALE/);
		assert.doesNotMatch(report.text, /Restart the root pi session so startup hygiene runs/);
		assert.match(report.text, /## Next steps/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
		rmSync(store, { recursive: true, force: true });
	}
});
