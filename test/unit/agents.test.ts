import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
	parseFrontmatter,
	parseFrontmatterList,
} from "../../src/agents/frontmatter.ts";
import {
	parseAgentDocument,
	loadAgentsFromDir,
	findNearestProjectAgentsDir,
	discoverAgents,
	findAgent,
	formatAgentRoster,
	BUILTIN_AGENT_NAMES,
	BUILTIN_AGENTS_DIR,
	EXTRA_AGENT_DIRS_ENV,
	LEGACY_EXTRA_AGENT_DIRS_ENV,
	resolveExtraAgentDirs,
	resetExtraAgentDirsDeprecationWarnForTests,
} from "../../src/agents/agents.ts";
import type { AgentConfig } from "../../src/shared/types.ts";
import {
	DEFAULT_MAX_RENEWALS,
	DEFAULT_RENEWABLE,
} from "../../src/shared/types.ts";
import { applyOverride } from "../../src/agents/overrides.ts";

function withDir<T>(fn: (dir: string) => T): T {
	const dir = mkdtempSync(path.join(tmpdir(), "agents-test-"));
	try {
		return fn(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

/**
 * Load the roles this package actually ships.
 *
 * Uses the module's own `BUILTIN_AGENTS_DIR` rather than re-deriving the path:
 * the package resolves it with `fileURLToPath`, so a checkout path containing
 * spaces survives, and there is one definition of where the roles live.
 */
function loadBundledAgents(): AgentConfig[] {
	return loadAgentsFromDir(BUILTIN_AGENTS_DIR, "builtin");
}

// ─────────────────────────── frontmatter ───────────────────────────

test("frontmatter: no fence yields empty frontmatter", () => {
	const r = parseFrontmatter("just a body");
	assert.deepEqual(r.frontmatter, {});
	assert.equal(r.body, "just a body");
});

test("frontmatter: unterminated fence is treated as body", () => {
	const r = parseFrontmatter("---\nname: x\nbody without close");
	assert.deepEqual(r.frontmatter, {});
});

test("frontmatter: simple key/value + body", () => {
	const r = parseFrontmatter(
		"---\nname: scout\ndescription: finds things\n---\nYou are scout.",
	);
	assert.equal(r.frontmatter.name, "scout");
	assert.equal(r.frontmatter.description, "finds things");
	assert.equal(r.body, "You are scout.");
});

test("frontmatter: quoted values are unquoted", () => {
	const r = parseFrontmatter("---\na: \"hello: world\"\nb: 'single'\n---\nx");
	assert.equal(r.frontmatter.a, "hello: world");
	assert.equal(r.frontmatter.b, "single");
});

test("frontmatter: CRLF is normalized", () => {
	const r = parseFrontmatter("---\r\nname: a\r\ndescription: b\r\n---\r\nbody");
	assert.equal(r.frontmatter.name, "a");
	assert.equal(r.body, "body");
});

test("frontmatter: literal block scalar preserves newlines", () => {
	const r = parseFrontmatter(
		"---\nsystemPrompt: |\n  line one\n  line two\n---\nx",
	);
	assert.equal(r.frontmatter.systemPrompt, "line one\nline two");
});

test("frontmatter: folded block scalar joins lines with spaces", () => {
	const r = parseFrontmatter("---\nnote: >\n  one\n  two\n---\nx");
	assert.equal(r.frontmatter.note, "one two");
});

test("frontmatter: block list is preserved for list parsing", () => {
	const r = parseFrontmatter("---\ntools:\n  - read\n  - bash\n---\nx");
	assert.deepEqual(parseFrontmatterList(r.frontmatter.tools), ["read", "bash"]);
});

test("frontmatter: comments and blank lines are ignored", () => {
	const r = parseFrontmatter(
		"---\n# a comment\nname: a\n\ndescription: b\n---\nx",
	);
	assert.equal(r.frontmatter.name, "a");
	assert.equal(r.frontmatter.description, "b");
});

test("parseFrontmatterList: comma separated", () => {
	assert.deepEqual(parseFrontmatterList("read, bash , ls"), [
		"read",
		"bash",
		"ls",
	]);
});

test("parseFrontmatterList: hyphenated values survive", () => {
	assert.deepEqual(parseFrontmatterList("gpt-5-mini, claude-sonnet-4"), [
		"gpt-5-mini",
		"claude-sonnet-4",
	]);
});

test("parseFrontmatterList: undefined yields undefined", () => {
	assert.equal(parseFrontmatterList(undefined), undefined);
});

// ─────────────────────────── agent documents ───────────────────────────

test("agent: requires name and description", () => {
	assert.equal(
		parseAgentDocument("---\nname: x\n---\nbody", "/f.md", "user"),
		null,
	);
	assert.equal(
		parseAgentDocument("---\ndescription: y\n---\nbody", "/f.md", "user"),
		null,
	);
	assert.ok(
		parseAgentDocument(
			"---\nname: x\ndescription: y\n---\nbody",
			"/f.md",
			"user",
		),
	);
});

test("agent: defaults match the documented conventions", () => {
	const a = parseAgentDocument(
		"---\nname: r\ndescription: d\n---\nprompt",
		"/f.md",
		"user",
	);
	assert.ok(a);
	assert.equal(a.systemPromptMode, "replace");
	assert.equal(a.inheritProjectContext, true);
	assert.equal(a.inheritSkills, false);
	assert.equal(a.kind, "pi");
	assert.equal(a.systemPrompt, "prompt");
});

test("agent: invalid kind degrades to pi instead of failing", () => {
	const a = parseAgentDocument(
		"---\nname: r\ndescription: d\nkind: not-a-kind\n---\np",
		"/f.md",
		"user",
	);
	assert.ok(a);
	assert.equal(a.kind, "pi");
});

test("agent: a non-pi kind is ignored and reported once, the role launches as pi", () => {
	const original = console.error;
	const errors: string[] = [];
	try {
		console.error = (...args: unknown[]) => errors.push(args.map(String).join(" "));
		const a = parseAgentDocument(
			"---\nname: r\ndescription: d\nkind: cursor\n---\np",
			"/f.md",
			"user",
		);
		assert.equal(a?.kind, "pi");
		assert.equal(errors.length, 1, "the ignored kind is reported exactly once");
		// Names the role, the value the user wrote, and what happened to it.
		assert.match(errors[0] ?? "", /agent 'r'/);
		assert.match(errors[0] ?? "", /"cursor"/);
		assert.match(errors[0] ?? "", /v4 supports kind: pi only/);
	} finally {
		console.error = original;
	}
});

test("agent: the ignored-kind report is deduplicated across catalog reloads", () => {
	// The catalog is re-read on several UI paths, not once per process. Without
	// dedupe the same role emits the same stderr line a dozen times as the user
	// moves through the UI, which reads as a dozen problems.
	const original = console.error;
	const errors: string[] = [];
	try {
		console.error = (...args: unknown[]) => errors.push(args.map(String).join(" "));
		const doc = "---\nname: reloaded\ndescription: d\nkind: gemini\n---\np";
		for (let i = 0; i < 3; i += 1) {
			assert.equal(parseAgentDocument(doc, "/f.md", "user")?.kind, "pi");
		}
		assert.equal(errors.length, 1, "three parses of the same role report once");
	} finally {
		console.error = original;
	}
});

test("agent: tools parse from comma string and array spellings", () => {
	const s = parseAgentDocument(
		"---\nname: r\ndescription: d\ntools: read, bash\n---\np",
		"/f.md",
		"user",
	);
	assert.deepEqual(s?.tools, ["read", "bash"]);
	const arr = parseAgentDocument(
		"---\nname: r\ndescription: d\ntools: [read, bash]\n---\np",
		"/f.md",
		"user",
	);
	assert.deepEqual(arr?.tools, ["read", "bash"]);
});

test("agent: skills false is distinct from absent", () => {
	const a = parseAgentDocument(
		"---\nname: r\ndescription: d\nskills: false\n---\np",
		"/f.md",
		"user",
	);
	assert.equal(a?.skills, false);
	const b = parseAgentDocument(
		"---\nname: r\ndescription: d\n---\np",
		"/f.md",
		"user",
	);
	assert.equal(b?.skills, undefined);
});

test("agent: numeric and boolean fields are coerced", () => {
	const a = parseAgentDocument(
		"---\nname: r\ndescription: d\ntimeoutMs: 1000\nmaxSubagentDepth: 2\nasync: true\nsteer: false\n---\np",
		"/f.md",
		"user",
	);
	assert.equal(a?.timeoutMs, 1000);
	assert.equal(a?.maxSubagentDepth, 2);
	assert.equal(a?.async, true);
	assert.equal(a?.steer, false);
});

test("agent: acceptance JSON is parsed", () => {
	const a = parseAgentDocument(
		'---\nname: r\ndescription: d\nacceptance: {"level":"attested","role":"read-only"}\n---\np',
		"/f.md",
		"user",
	);
	assert.equal(a?.acceptance?.level, "attested");
	assert.equal(a?.acceptance?.role, "read-only");
});

test("agent: malformed acceptance JSON is ignored, not fatal", () => {
	const a = parseAgentDocument(
		"---\nname: r\ndescription: d\nacceptance: {not json\n---\np",
		"/f.md",
		"user",
	);
	assert.ok(a);
	assert.equal(a?.acceptance, undefined);
});

test("agent: frontmatterFields records provenance", () => {
	const a = parseAgentDocument(
		"---\nname: r\ndescription: d\nmodel: x\n---\np",
		"/f.md",
		"user",
	);
	assert.ok(a?.frontmatterFields?.has("model"));
	assert.ok(a?.frontmatterFields?.has("name"));
});

test("agent: frontmatter preset is parsed onto the config", () => {
	const a = parseAgentDocument(
		"---\nname: r\ndescription: d\npreset: strong\n---\np",
		"/f.md",
		"user",
	);
	assert.equal(a?.preset, "strong");
	// Absent preset stays absent — the no-preset path must be untouched.
	const plain = parseAgentDocument(
		"---\nname: r\ndescription: d\n---\np",
		"/f.md",
		"user",
	);
	assert.equal(plain?.preset, undefined);
	// `preset` is enforced (level 2 of model precedence), so it must never
	// be reported as an accepted-but-inert field.
	assert.equal(a?.unenforcedFields?.includes("preset") ?? false, false);
});

// ─────────────────────────── discovery ───────────────────────────

test("discovery: loadAgentsFromDir skips bad files without throwing", () => {
	withDir((dir) => {
		writeFileSync(
			path.join(dir, "good.md"),
			"---\nname: good\ndescription: d\n---\np",
		);
		writeFileSync(path.join(dir, "bad.md"), "no frontmatter here");
		writeFileSync(
			path.join(dir, "ignored.txt"),
			"---\nname: x\ndescription: y\n---\np",
		);
		const agents = loadAgentsFromDir(dir, "user");
		assert.equal(agents.length, 1);
		assert.equal(agents[0]?.name, "good");
	});
});

test("discovery: missing directory yields empty list", () => {
	assert.deepEqual(loadAgentsFromDir("/nonexistent/path/xyz", "user"), []);
});

test("discovery: findNearestProjectAgentsDir walks up", () => {
	withDir((dir) => {
		const nested = path.join(dir, "a", "b", "c");
		mkdirSync(path.join(dir, ".pi", "agents"), { recursive: true });
		mkdirSync(nested, { recursive: true });
		assert.equal(
			findNearestProjectAgentsDir(nested),
			path.join(dir, ".pi", "agents"),
		);
	});
});

test("discovery: returns null when no project dir exists", () => {
	withDir((dir) => {
		assert.equal(findNearestProjectAgentsDir(dir), null);
	});
});

test("discovery: project overrides user on name collision in 'both'", () => {
	withDir((root) => {
		const userDir = path.join(root, "user-agents");
		const projDir = path.join(root, "proj", ".pi", "agents");
		mkdirSync(userDir, { recursive: true });
		mkdirSync(projDir, { recursive: true });
		writeFileSync(
			path.join(userDir, "dup.md"),
			"---\nname: dup\ndescription: from-user\n---\nuser prompt",
		);
		writeFileSync(
			path.join(projDir, "dup.md"),
			"---\nname: dup\ndescription: from-project\n---\nproj prompt",
		);

		const res = discoverAgents(path.join(root, "proj"), "both", {
			userAgentsDir: userDir,
			includeBuiltin: false,
		});
		assert.equal(res.agents.length, 1);
		assert.equal(res.agents[0]?.description, "from-project");
		assert.equal(res.agents[0]?.source, "project");
	});
});

test("discovery: scope 'user' excludes project agents", () => {
	withDir((root) => {
		const userDir = path.join(root, "user-agents");
		const projDir = path.join(root, "proj", ".pi", "agents");
		mkdirSync(userDir, { recursive: true });
		mkdirSync(projDir, { recursive: true });
		writeFileSync(
			path.join(userDir, "u.md"),
			"---\nname: u\ndescription: d\n---\np",
		);
		writeFileSync(
			path.join(projDir, "p.md"),
			"---\nname: p\ndescription: d\n---\np",
		);

		const res = discoverAgents(path.join(root, "proj"), "user", {
			userAgentsDir: userDir,
			includeBuiltin: false,
		});
		assert.deepEqual(
			res.agents.map((a) => a.name),
			["u"],
		);
	});
});

test("discovery: scope 'project' excludes user agents", () => {
	withDir((root) => {
		const userDir = path.join(root, "user-agents");
		const projDir = path.join(root, "proj", ".pi", "agents");
		mkdirSync(userDir, { recursive: true });
		mkdirSync(projDir, { recursive: true });
		writeFileSync(
			path.join(userDir, "u.md"),
			"---\nname: u\ndescription: d\n---\np",
		);
		writeFileSync(
			path.join(projDir, "p.md"),
			"---\nname: p\ndescription: d\n---\np",
		);

		const res = discoverAgents(path.join(root, "proj"), "project", {
			userAgentsDir: userDir,
			includeBuiltin: false,
		});
		assert.deepEqual(
			res.agents.map((a) => a.name),
			["p"],
		);
	});
});

test("discovery: bundled roles are present by default", () => {
	withDir((root) => {
		const res = discoverAgents(root, "user", {
			userAgentsDir: path.join(root, "empty-user-dir"),
		});
		const names = res.agents.map((a) => a.name);
		for (const expected of BUILTIN_AGENT_NAMES) {
			assert.ok(
				names.includes(expected),
				`bundled role "${expected}" must load`,
			);
		}
		const scout = res.agents.find((a) => a.name === "scout");
		assert.equal(scout?.source, "builtin");
		const centurion = res.agents.find((a) => a.name === "centurion");
		assert.equal(centurion?.source, "builtin");
	});
});

test("discovery: includeBuiltin false drops the bundled roles", () => {
	withDir((root) => {
		const res = discoverAgents(root, "user", {
			userAgentsDir: path.join(root, "empty-user-dir"),
			includeBuiltin: false,
		});
		assert.deepEqual(res.agents, []);
	});
});

test("discovery: a user definition overrides a bundled role of the same name", () => {
	withDir((root) => {
		const userDir = path.join(root, "user-agents");
		mkdirSync(userDir, { recursive: true });
		// `scout` is a bundled role; the user redefines it.
		writeFileSync(
			path.join(userDir, "scout.md"),
			"---\nname: scout\ndescription: my-own-scout\n---\np",
		);

		const res = discoverAgents(root, "user", { userAgentsDir: userDir });
		const scout = res.agents.find((a) => a.name === "scout");
		assert.equal(scout?.description, "my-own-scout");
		assert.equal(scout?.source, "user");
		// The other bundled roles must still be present.
		assert.ok(res.agents.length >= BUILTIN_AGENT_NAMES.length);
	});
});

test("discovery: a project definition overrides a bundled role in 'both'", () => {
	withDir((root) => {
		const projDir = path.join(root, "proj", ".pi", "agents");
		mkdirSync(projDir, { recursive: true });
		writeFileSync(
			path.join(projDir, "reviewer.md"),
			"---\nname: reviewer\ndescription: project-reviewer\n---\np",
		);

		const res = discoverAgents(path.join(root, "proj"), "both", {
			userAgentsDir: path.join(root, "empty-user-dir"),
		});
		const reviewer = res.agents.find((a) => a.name === "reviewer");
		assert.equal(reviewer?.description, "project-reviewer");
		assert.equal(reviewer?.source, "project");
	});
});

test("discovery: extra agent dirs load below the user dir in precedence", () => {
	withDir((root) => {
		const extraDir = path.join(root, "extra-agents");
		const userDir = path.join(root, "user-agents");
		mkdirSync(extraDir, { recursive: true });
		mkdirSync(userDir, { recursive: true });
		writeFileSync(
			path.join(extraDir, "vendored.md"),
			"---\nname: vendored\ndescription: from-extra\n---\np",
		);
		// Same name in both layers: the user dir must win.
		writeFileSync(
			path.join(extraDir, "dup.md"),
			"---\nname: dup\ndescription: from-extra\n---\np",
		);
		writeFileSync(
			path.join(userDir, "dup.md"),
			"---\nname: dup\ndescription: from-user\n---\np",
		);

		const res = discoverAgents(root, "user", {
			userAgentsDir: userDir,
			includeBuiltin: false,
			extraAgentDirs: [extraDir],
		});
		const names = res.agents.map((a) => a.name);
		assert.ok(names.includes("vendored"), "extra dir roles must load");
		assert.equal(
			res.agents.find((a) => a.name === "dup")?.description,
			"from-user",
			"the user dir must outrank the extra dirs",
		);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// PI_LEGION_EXTRA_AGENT_DIRS (+ legacy PI_HERDR_SUBAGENTS_EXTRA_AGENT_DIRS alias)
// ─────────────────────────────────────────────────────────────────────────────

test("resolveExtraAgentDirs: new env alone", () => {
	withDir((root) => {
		resetExtraAgentDirsDeprecationWarnForTests();
		const dir = path.join(root, "new-only");
		mkdirSync(dir, { recursive: true });
		const warnings: string[] = [];
		const resolved = resolveExtraAgentDirs(
			{ [EXTRA_AGENT_DIRS_ENV]: dir },
			(message) => warnings.push(message),
		);
		assert.deepEqual(resolved, [path.resolve(dir)]);
		assert.equal(warnings.length, 0, "canonical env must not warn");
	});
});

test("resolveExtraAgentDirs: legacy env alone still works with deprecation warn", () => {
	withDir((root) => {
		resetExtraAgentDirsDeprecationWarnForTests();
		const dir = path.join(root, "legacy-only");
		mkdirSync(dir, { recursive: true });
		const warnings: string[] = [];
		const resolved = resolveExtraAgentDirs(
			{ [LEGACY_EXTRA_AGENT_DIRS_ENV]: dir },
			(message) => warnings.push(message),
		);
		assert.deepEqual(resolved, [path.resolve(dir)]);
		assert.equal(warnings.length, 1);
		assert.match(warnings[0]!, /deprecated/);
		assert.match(warnings[0]!, /PI_LEGION_EXTRA_AGENT_DIRS/);
	});
});

test("resolveExtraAgentDirs: both set — new name wins, legacy ignored", () => {
	withDir((root) => {
		resetExtraAgentDirsDeprecationWarnForTests();
		const modernDir = path.join(root, "modern");
		const legacyDir = path.join(root, "legacy");
		mkdirSync(modernDir, { recursive: true });
		mkdirSync(legacyDir, { recursive: true });
		const warnings: string[] = [];
		const resolved = resolveExtraAgentDirs(
			{
				[EXTRA_AGENT_DIRS_ENV]: modernDir,
				[LEGACY_EXTRA_AGENT_DIRS_ENV]: legacyDir,
			},
			(message) => warnings.push(message),
		);
		assert.deepEqual(resolved, [path.resolve(modernDir)]);
		assert.ok(!resolved.includes(path.resolve(legacyDir)));
		assert.equal(warnings.length, 1);
		assert.match(warnings[0]!, /new name wins/);
	});
});

test("resolveExtraAgentDirs: PATH-style multiple entries on new env", () => {
	withDir((root) => {
		resetExtraAgentDirsDeprecationWarnForTests();
		const a = path.join(root, "a");
		const b = path.join(root, "b");
		mkdirSync(a, { recursive: true });
		mkdirSync(b, { recursive: true });
		const resolved = resolveExtraAgentDirs(
			{ [EXTRA_AGENT_DIRS_ENV]: `${a}${path.delimiter}${b}` },
			() => {},
		);
		assert.deepEqual(resolved, [path.resolve(a), path.resolve(b)]);
	});
});


// ─────────────────────────────────────────────────────────────────────────────
// A frontmatter key that is accepted but does nothing is worse than an unknown
// one: the user believes it is in effect. Fields the runtime does not yet act
// on are recorded on the agent so tool output can warn about them.
// ─────────────────────────────────────────────────────────────────────────────

test("formerly unenforced fields are now honoured", () => {
	const doc = [
		"---",
		"name: probe",
		"description: d",
		"worktree: true",
		"fallbackModels: [a/b, c/d]",
		"toolBudget: '{\"maxToolCalls\": 5}'",
		"turnBudget: '{\"maxTurns\": 3}'",
		"toolTimeoutMs: 60000",
		"alias: [p]",
		"completionGuard: true",
		"allowNestedSubagents: true",
		"---",
		"body",
	].join("\n");
	const agent = parseAgentDocument(doc, "/x/probe.md", "user");
	assert.ok(agent);
	assert.deepEqual(
		agent.unenforcedFields ?? [],
		[],
		"every previously inert field is now wired",
	);
	assert.equal(agent.worktree, true);
	assert.deepEqual(agent.fallbackModels, ["a/b", "c/d"]);
	assert.equal(agent.toolBudget?.maxToolCalls, 5);
	assert.equal(agent.turnBudget?.maxTurns, 3);
	assert.equal(agent.toolTimeoutMs, 60_000);
	assert.deepEqual(agent.alias, ["p"]);
	assert.equal(agent.completionGuard, true);
	assert.equal(agent.allowNestedSubagents, true);
});

test("Placement is not parsed or reported as an active agent field", () => {
	const doc = [
		"---",
		"name: probe",
		"description: d",
		"kind: pi",
		"placement: new-tab",
		"tools: [read]",
		"steer: true",
		"onBlocked: forward",
		"---",
		"body",
	].join("\n");
	const agent = parseAgentDocument(doc, "/x/probe.md", "user");
	assert.ok(agent);
	assert.deepEqual(
		agent.unenforcedFields ?? [],
		[],
		"fields the runtime honours must not be listed",
	);
	assert.equal("placement" in agent, false, "legacy placement frontmatter is ignored");
});

test("acceptance.criteria is no longer reported unenforced (it is surfaced instead)", () => {
	const withCriteria = parseAgentDocument(
		[
			"---",
			"name: probe",
			"description: d",
			'acceptance: \'{"level": "attested", "criteria": [{"id": "c1", "must": "tests pass"}]}\'',
			"---",
			"body",
		].join("\n"),
		"/x/probe.md",
		"user",
	);
	assert.ok(withCriteria);
	assert.deepEqual(
		withCriteria.unenforcedFields ?? [],
		[],
		"criteria are surfaced to the caller as a pending checklist, so they are not inert",
	);
	assert.equal(
		withCriteria.acceptance?.criteria?.length,
		1,
		"the criteria themselves must still be parsed and kept",
	);

	const levelOnly = parseAgentDocument(
		[
			"---",
			"name: probe",
			"description: d",
			'acceptance: \'{"level": "attested"}\'',
			"---",
			"body",
		].join("\n"),
		"/x/probe.md",
		"user",
	);
	assert.ok(levelOnly);
	assert.deepEqual(
		levelOnly.unenforcedFields ?? [],
		[],
		"a plain acceptance.level IS honoured via verdict extraction",
	);
});

test("the reviewer role is read-only", () => {
	// `scripts/verify-agents.ts` used to check this. It is a real safety property
	// (a reviewer that can edit the code it reviews is not a reviewer), so it
	// belongs in the suite rather than in an unrunnable dev script.
	const reviewer = loadBundledAgents().find((a) => a.name === "reviewer");
	assert.ok(reviewer, "the reviewer role must load");

	// An ABSENT `tools:` list must fail too, not just a writable one. `buildPiArgs`
	// only emits `--tools` for a non-empty list, so a role with no `tools:` key is
	// launched with pi's full default tool set — which includes edit and write.
	// Asserting only `filter(...) == []` would therefore pass on exactly the
	// regression this test exists to catch.
	assert.ok(
		reviewer.tools?.length,
		"the reviewer must declare an explicit tool list (an absent list means pi's write-capable defaults)",
	);
	const writable = (reviewer.tools ?? []).filter((t) =>
		["edit", "write"].includes(t),
	);
	assert.deepEqual(
		writable,
		[],
		"the reviewer must not be able to edit or write files",
	);
});

test("bundled roles do not pin a vendor model", () => {
	// A shipped `cb/...` id fails for anyone who does not have that provider.
	// Pin models in project settings or on the tool call, not in the package.
	for (const agent of loadBundledAgents()) {
		assert.equal(
			agent.model,
			undefined,
			`bundled role ${agent.name} must not pin model=${agent.model}`,
		);
	}
});

test("bundled roles leave thinking configurable", () => {
	for (const agent of loadBundledAgents()) {
		assert.equal(
			agent.thinking,
			undefined,
			`bundled role ${agent.name} must not hard-code thinking`,
		);
	}
});

test("formatAgentRoster lists user roles so the parent can pick search without list", () => {
	const roster = formatAgentRoster([
		{
			name: "search",
			description: "联网检索，只返回带出处的事实",
			kind: "pi",
			source: "user",
			model: "auto",
			systemPrompt: "",
			systemPromptMode: "replace",
			inheritProjectContext: true,
			inheritSkills: false,
			filePath: "/f.md",
		},
		{
			name: "worker",
			description: "实现者",
			kind: "pi",
			source: "builtin",
			systemPrompt: "",
			systemPromptMode: "replace",
			inheritProjectContext: true,
			inheritSkills: false,
			filePath: "/w.md",
		},
	]);
	assert.match(roster, /Available subagent roles/);
	assert.match(roster, /- search \[user\] \(model=auto\)/);
	assert.match(roster, /- worker \[builtin\] — 实现者/);
	assert.doesNotMatch(roster, /kind=pi/);
});

test("formatAgentRoster includes the bundled centurion role", () => {
	assert.match(formatAgentRoster(loadBundledAgents()), /- centurion \[builtin\]/);
});

test("every bundled role ships a non-empty system prompt", () => {
	// The prompt body IS the product; a truncated or stub role would otherwise
	// load clean and ship silently. `scripts/verify-agents.ts` used to flag this
	// with a console warning — nothing asserted it, so it could regress unnoticed.
	for (const agent of loadBundledAgents()) {
		assert.ok(
			agent.systemPrompt.trim().length > 0,
			`bundled role ${agent.name} must ship a non-empty system prompt`,
		);
	}
});

test("a bundled role reports no unenforced fields", () => {
	// The shipped roles must not carry inert configuration.
	for (const name of BUILTIN_AGENT_NAMES) {
		const found = loadBundledAgents().find((a) => a.name === name);
		assert.ok(found, `${name} must load`);
		assert.deepEqual(
			found.unenforcedFields ?? [],
			[],
			`bundled role ${name} must not rely on unenforced fields`,
		);
	}
});

// ─────────────────────────────────────────────────────────────────────────────
// BUG 17: `timeoutMs` was parsed from frontmatter and then ignored — every
// bundled role declares a budget (worker 30min, oracle 20min) but `collect`
// always used the global 15min default. A role silently losing its configured
// budget is worse than not offering the field at all.
// ─────────────────────────────────────────────────────────────────────────────

test("timeoutMs is parsed and is NOT reported as unenforced", () => {
	const agent = parseAgentDocument(
		[
			"---",
			"name: probe",
			"description: d",
			"timeoutMs: 1800000",
			"---",
			"b",
		].join("\n"),
		"/x/probe.md",
		"user",
	);
	assert.ok(agent);
	assert.equal(agent.timeoutMs, 1_800_000);
	assert.ok(
		!(agent.unenforcedFields ?? []).includes("timeoutMs"),
		"timeoutMs is honoured by collect(), so it must not be listed as inert",
	);
});

test("toolTimeoutMs is parsed and is NOT reported as unenforced", () => {
	const agent = parseAgentDocument(
		[
			"---",
			"name: probe",
			"description: d",
			"toolTimeoutMs: 60000",
			"---",
			"b",
		].join("\n"),
		"/x/probe.md",
		"user",
	);
	assert.ok(agent);
	assert.equal(agent.toolTimeoutMs, 60_000);
	assert.ok(
		!(agent.unenforcedFields ?? []).includes("toolTimeoutMs"),
		"toolTimeoutMs is applied by the child-guard, so it must not be listed as inert",
	);
});

test("every bundled role declares a timeout budget the runtime honours", () => {
	const agents = loadBundledAgents();
	for (const name of BUILTIN_AGENT_NAMES) {
		const found = agents.find((a) => a.name === name);
		assert.ok(found, `${name} must load`);
		assert.equal(
			typeof found.timeoutMs,
			"number",
			`bundled role ${name} must declare timeoutMs`,
		);
		assert.ok(
			(found.timeoutMs ?? 0) > 0,
			`bundled role ${name} must declare a positive budget`,
		);
	}
});

// ─────────────────────────────────────────────────────────────────────────────
// BUG 20: the frontmatter parser is FLAT — a nested block like `acceptance:`
// arrives as raw indented text, not an object. `parseAcceptance` only tried
// `JSON.parse`, which always failed, so every bundled role's acceptance config
// (level, role, criteria) was silently dropped. The YAML spelling is the one
// the shipped roles actually use.
// ─────────────────────────────────────────────────────────────────────────────

test("acceptance: a nested YAML block is parsed, not just a JSON string", () => {
	const doc = [
		"---",
		"name: probe",
		"description: d",
		"acceptance:",
		"  level: attested",
		"  role: read-only",
		"  criteria:",
		"    - id: c1",
		"      must: tests pass",
		"      evidence: [a, b]",
		"      severity: required",
		"      command: npm test",
		"---",
		"body",
	].join("\n");

	const agent = parseAgentDocument(doc, "/x/probe.md", "user");
	assert.ok(agent);
	assert.equal(agent.acceptance?.level, "attested");
	assert.equal(agent.acceptance?.role, "read-only");
	assert.equal(agent.acceptance?.criteria?.length, 1);
	assert.deepEqual(agent.acceptance?.criteria?.[0], {
		id: "c1",
		must: "tests pass",
		evidence: ["a", "b"],
		severity: "required",
		command: "npm test",
	});
});

test("acceptance: the JSON-string spelling still works", () => {
	const doc = [
		"---",
		"name: probe",
		"description: d",
		'acceptance: \'{"level": "verified", "role": "writer", "criteria": [{"id": "j1", "must": "no secrets"}]}\'',
		"---",
		"body",
	].join("\n");
	const agent = parseAgentDocument(doc, "/x/probe.md", "user");
	assert.ok(agent);
	assert.equal(agent.acceptance?.level, "verified");
	assert.equal(agent.acceptance?.role, "writer");
	assert.equal(agent.acceptance?.criteria?.[0]?.id, "j1");
});

test("acceptance: an invalid level is rejected rather than guessed", () => {
	const doc = [
		"---",
		"name: probe",
		"description: d",
		"acceptance:",
		"  level: nonsense",
		"---",
		"body",
	].join("\n");
	const agent = parseAgentDocument(doc, "/x/probe.md", "user");
	assert.ok(agent);
	assert.equal(agent.acceptance, undefined);
});

test("acceptance: criteria missing id or must are dropped", () => {
	const doc = [
		"---",
		"name: probe",
		"description: d",
		"acceptance:",
		"  level: attested",
		"  criteria:",
		"    - id: good",
		"      must: has both",
		"    - id: no-must",
		"    - must: no-id",
		"---",
		"body",
	].join("\n");
	const agent = parseAgentDocument(doc, "/x/probe.md", "user");
	assert.ok(agent);
	assert.deepEqual(
		agent.acceptance?.criteria?.map((c) => c.id),
		["good"],
		"a criterion needs both an id and a must",
	);
});

test("acceptance: every bundled role parses its acceptance block", () => {
	const agents = loadBundledAgents();
	for (const name of BUILTIN_AGENT_NAMES) {
		const found = agents.find((a) => a.name === name);
		assert.ok(found, `${name} must load`);
		assert.ok(
			found.acceptance,
			`bundled role ${name} declares an acceptance block that must parse`,
		);
		assert.ok(
			(found.acceptance?.criteria?.length ?? 0) > 0,
			`bundled role ${name} declares criteria that must parse`,
		);
	}
});

test("writer roles no longer auto-default to worktree; only centurion pins it (#214)", () => {
	const writer = parseAgentDocument(
		[
			"---",
			"name: coder",
			"description: writes code",
			"acceptance:",
			"  level: attested",
			"  role: writer",
			"---",
			"body",
		].join("\n"),
		"/x/coder.md",
		"user",
	);
	assert.equal(writer?.worktree, undefined, "custom writers do not auto-gain worktree");
	assert.equal(writer?.acceptance?.role, "writer");

	const optedOut = parseAgentDocument(
		[
			"---",
			"name: coder",
			"description: writes code",
			"worktree: false",
			"acceptance:",
			"  level: attested",
			"  role: writer",
			"---",
			"body",
		].join("\n"),
		"/x/coder.md",
		"user",
	);
	assert.equal(optedOut?.worktree, false);

	const bundled = loadBundledAgents().find((a) => a.name === "worker");
	assert.equal(bundled?.worktree, false, "bundled worker is worktree:false per §9");
	assert.equal(bundled?.acceptance?.role, "writer");

	const centurion = loadBundledAgents().find((a) => a.name === "centurion");
	assert.equal(centurion?.worktree, true, "only centurion keeps worktree:true");
});

test("findAgent matches canonical name and alias", () => {
	const reviewer = parseAgentDocument(
		["---", "name: reviewer", "description: d", "alias: [rev, r]", "---", "b"].join(
			"\n",
		),
		"/x/reviewer.md",
		"user",
	);
	const worker = parseAgentDocument(
		["---", "name: worker", "description: d", "---", "b"].join("\n"),
		"/x/worker.md",
		"user",
	);
	assert.ok(reviewer);
	assert.ok(worker);
	const agents = [reviewer, worker];
	assert.equal(findAgent(agents, "reviewer")?.name, "reviewer");
	assert.equal(findAgent(agents, "rev")?.name, "reviewer");
	assert.equal(findAgent(agents, "R")?.name, "reviewer");
	assert.equal(findAgent(agents, "worker")?.name, "worker");
	assert.equal(findAgent(agents, "nobody"), undefined);
});

// ─────────────────────────────────────────────────────────────────────────────
// #172: acceptance.role case-insensitivity + unknown-role warn
// #176: EXTRA_AGENT_DIRS colon AND semicolon
// ─────────────────────────────────────────────────────────────────────────────

test("acceptance.role is case-insensitive (#172)", () => {
	const cases: Array<[string, string | undefined]> = [
		["read-only", "read-only"],
		["READ-ONLY", "read-only"],
		["Read-Only", "read-only"],
		["writer", "writer"],
		["WRITER", "writer"],
		["Writer", "writer"],
		["unknown", "unknown"],
		["UNKNOWN", "unknown"],
		["readonly", undefined],
		["read_only", undefined],
	];
	for (const [wrote, expectedRole] of cases) {
		const doc = [
			"---",
			`name: role-${wrote}`,
			"description: d",
			"acceptance:",
			"  level: attested",
			`  role: ${wrote}`,
			"---",
			"body",
		].join("\n");
		const agent = parseAgentDocument(doc, `/x/role-${wrote}.md`, "user");
		assert.ok(agent, wrote);
		assert.equal(agent.acceptance?.role, expectedRole, `role for ${JSON.stringify(wrote)}`);
		// #214: writers no longer auto-default to worktree:true.
		assert.equal(agent.worktree, undefined, `no auto-worktree for ${JSON.stringify(wrote)}`);
	}
});

test("acceptance.role unknown string warns (#172)", () => {
	const errors: string[] = [];
	const prev = console.error;
	console.error = (...args: unknown[]) => {
		errors.push(args.map(String).join(" "));
	};
	try {
		const doc = [
			"---",
			"name: bad-role",
			"description: d",
			"acceptance:",
			"  level: attested",
			"  role: readonly",
			"---",
			"body",
		].join("\n");
		const agent = parseAgentDocument(doc, "/x/bad-role.md", "user");
		assert.ok(agent);
		assert.equal(agent.acceptance?.role, undefined);
		assert.equal(errors.length, 1);
		assert.match(errors[0]!, /unknown acceptance\.role/);
		assert.match(errors[0]!, /bad-role/);
	} finally {
		console.error = prev;
	}
});

test("resolveExtraAgentDirs: semicolon-separated entries (#176)", () => {
	withDir((root) => {
		resetExtraAgentDirsDeprecationWarnForTests();
		const a = path.join(root, "a");
		const b = path.join(root, "b");
		mkdirSync(a, { recursive: true });
		mkdirSync(b, { recursive: true });
		const resolved = resolveExtraAgentDirs(
			{ [EXTRA_AGENT_DIRS_ENV]: `${a};${b}` },
			() => {},
		);
		assert.deepEqual(resolved, [path.resolve(a), path.resolve(b)]);
	});
});

test("resolveExtraAgentDirs: mixed colon and semicolon (#176)", () => {
	withDir((root) => {
		resetExtraAgentDirsDeprecationWarnForTests();
		const a = path.join(root, "a");
		const b = path.join(root, "b");
		const c = path.join(root, "c");
		mkdirSync(a, { recursive: true });
		mkdirSync(b, { recursive: true });
		mkdirSync(c, { recursive: true });
		const resolved = resolveExtraAgentDirs(
			{ [EXTRA_AGENT_DIRS_ENV]: `${a}:${b};${c}` },
			() => {},
		);
		assert.deepEqual(resolved, [path.resolve(a), path.resolve(b), path.resolve(c)]);
	});
});


// ─────────────────────────────────────────────────────────────────────────────
// W2 / contract docs/contracts/subagent-renewal-v1.md §3 D5 + D6:
// `renewable` and `maxRenewals` are role-level knobs for the renewal proposal
// W3 renders. The parse layer is deliberately dumb: it copies what the role
// declared and leaves the field ABSENT otherwise, so the defaults
// (DEFAULT_RENEWABLE / DEFAULT_MAX_RENEWALS) live with the consumers and
// "undeclared" stays distinguishable from "declared as the default value".
// ─────────────────────────────────────────────────────────────────────────────

/** Parse a two-key role document so each renewal case reads as one assertion. */
function parseRenewalDoc(fields: string[]): AgentConfig | null {
	return parseAgentDocument(
		["---", "name: probe", "description: d", ...fields, "---", "b"].join("\n"),
		"/x/probe.md",
		"user",
	);
}

test("renewable: false is parsed (D5 / A4 first half)", () => {
	const agent = parseRenewalDoc(["renewable: false"]);
	assert.ok(agent);
	assert.equal(agent.renewable, false, "an explicitly non-renewable role must stay false");
	// The whole point of D5: this role is never offered a renewal, so the value
	// cannot be lost between frontmatter and the notification layer.
	assert.equal(agent.unenforcedFields?.includes("renewable") ?? false, false);
});

test("renewable: true is parsed", () => {
	const agent = parseRenewalDoc(["renewable: true"]);
	assert.ok(agent);
	assert.equal(agent.renewable, true);
});

test("renewable: undeclared stays undefined (the default belongs to the consumer)", () => {
	const agent = parseRenewalDoc([]);
	assert.ok(agent);
	assert.equal(
		agent.renewable,
		undefined,
		"parsing must not bake in the default: W3 has to be able to tell " +
			"'the role said nothing' from 'the role said true'",
	);
	assert.equal(DEFAULT_RENEWABLE, true, "D5 default is renewable");
});

test("maxRenewals: 0 is preserved, not treated as absent (D6)", () => {
	const agent = parseRenewalDoc(["maxRenewals: 0"]);
	assert.ok(agent);
	// 0 means "renewal disabled" (D6), which is a different thing from the
	// default of 2. A falsy check anywhere on this path would silently turn
	// "never renew" into "renew twice", so the exact value is asserted.
	assert.strictEqual(agent.maxRenewals, 0, "0 must survive as 0, never undefined/2");
	assert.equal(agent.maxRenewals !== undefined, true, "0 is a declared value, not an absent one");
});

test("maxRenewals: 3 is parsed", () => {
	const agent = parseRenewalDoc(["maxRenewals: 3"]);
	assert.ok(agent);
	assert.equal(agent.maxRenewals, 3);
});

test("maxRenewals: undeclared stays undefined; the default is 2 (D6)", () => {
	const agent = parseRenewalDoc([]);
	assert.ok(agent);
	assert.equal(agent.maxRenewals, undefined);
	assert.equal(DEFAULT_MAX_RENEWALS, 2, "D6 default is two renewals");
});

test("renewal overrides parse and apply (agentOverrides path stays live)", () => {
	const base = parseRenewalDoc(["renewable: true", "maxRenewals: 2"]);
	assert.ok(base);
	// Both fields must be in OVERRIDE_FIELDS, or a project-level override would
	// validate, parse, and then be dropped by the field-by-field merge.
	const patched = applyOverride(base, { renewable: false, maxRenewals: 0 });
	assert.equal(patched.renewable, false);
	assert.strictEqual(patched.maxRenewals, 0, "an override to 0 must not decay to the default");
});
