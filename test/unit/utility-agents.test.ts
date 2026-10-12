import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { parseAgentDocument } from "../../src/agents/agents.ts";
import { parseSubagentSettings } from "../../src/agents/settings.ts";
import { applyAgentOverrides } from "../../src/agents/overrides.ts";
import { loadCatalog } from "../../index.ts";
import { PARENT_PLAYBOOK } from "../../src/extension/playbook.ts";

function withEnvironment<T>(values: Record<string, string | undefined>, action: () => T): T {
	const previous = new Map<string, string | undefined>();
	for (const [key, value] of Object.entries(values)) {
		previous.set(key, process.env[key]);
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	try {
		return action();
	} finally {
		for (const [key, value] of previous) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

test("utility agents: parses the utility frontmatter boolean", () => {
	const agent = parseAgentDocument(
		"---\nname: scout\ndescription: read-only helper\nutility: true\n---\nInspect and report.",
		"/agents/scout.md",
		"user",
	);
	assert.equal(agent?.utility, true);
	assert.equal(agent?.frontmatterFields?.has("utility"), true);
});

test("utility agentOverrides: accepts and validates the utility boolean", () => {
	const parsed = parseSubagentSettings(
		{ subagents: { agentOverrides: { scout: { utility: true } } } },
		"/tmp/settings.json",
	);
	assert.equal(parsed.agentOverrides?.scout?.utility, true);
	const base = parseAgentDocument(
		"---\nname: scout\ndescription: helper\n---\nRead and report.",
		"/agents/scout.md",
		"user",
	);
	assert.ok(base);
	assert.equal(applyAgentOverrides([base], parsed.agentOverrides)[0]?.utility, true);
	assert.throws(
		() => parseSubagentSettings(
			{ subagents: { agentOverrides: { scout: { utility: "true" } } } },
			"/tmp/settings.json",
		),
		/agentOverrides\.scout\.utility.*expected a boolean/,
	);
});

test("utility catalog: utility plus allowNestedSubagents emits a warning", () => {
	const root = mkdtempSync(path.join(tmpdir(), "utility-catalog-"));
	try {
		const agentDir = path.join(root, "agent-config");
		const agentsDir = path.join(agentDir, "agents");
		const projectRoot = path.join(root, "project");
		mkdirSync(agentsDir, { recursive: true });
		mkdirSync(projectRoot, { recursive: true });
		writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ subagents: {} }));
		writeFileSync(
			path.join(agentsDir, "conflicted.md"),
			"---\nname: conflicted\ndescription: misconfigured utility\nutility: true\nallowNestedSubagents: true\n---\nInspect only.",
		);

		const catalog = withEnvironment({ PI_CODING_AGENT_DIR: agentDir }, () =>
			loadCatalog(projectRoot, projectRoot, "user"),
		);
		assert.ok(catalog.allAgents.some((agent) => agent.name === "conflicted"));
		assert.ok(
			catalog.utilityWarnings.some((warning) =>
				warning.includes("conflicted") && warning.includes("utility") && warning.includes("allowNestedSubagents"),
			),
			"the catalog should record the ignored nested-dispatch misconfiguration",
		);
		assert.ok(catalog.teamWarnings.some((warning) => warning.includes("conflicted")));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("utility playbook: documents the leaf-only vexillatio channel", () => {
	assert.match(PARENT_PLAYBOOK, /utility: true/);
	assert.match(PARENT_PLAYBOOK, /`vexillatio`/);
	assert.match(PARENT_PLAYBOOK, /always leaf/);
});
