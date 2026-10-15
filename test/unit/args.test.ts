import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { AgentConfig } from "../../src/shared/types.ts";
import {
	BUILTIN_CODEMODE,
	buildPiArgs,
	childGuardExtensionPath,
	collectChildExtensions,
} from "../../src/runs/args.ts";
import { CHILD_TASK_APPENDIX } from "../../src/extension/child-guard.ts";

function agent() {
	return {
		name: "scout",
		description: "d",
		systemPrompt: "",
		systemPromptMode: "replace" as const,
		inheritProjectContext: true,
		inheritSkills: false,
		kind: "pi" as const,
		source: "user" as const,
		filePath: "/f.md",
		tools: ["read", "bash"],
	};
}

test("buildPiArgs injects the child-guard extension", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "args-ext-"));
	try {
		const built = buildPiArgs({
			agent: agent(),
			task: "recon",
			sessionFile: "/tmp/s.jsonl",
			tempDir: dir,
		});
		const idx = built.args.indexOf("--extension");
		assert.ok(idx >= 0, "child argv must load an extension");
		assert.equal(built.args[idx + 1], childGuardExtensionPath());
		assert.equal(
			built.args.filter((a) => a === "--extension").length,
			1,
			"must not duplicate the guard extension",
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("buildPiArgs writes the frozen task appendix", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "args-task-"));
	try {
		const built = buildPiArgs({
			agent: agent(),
			task: "Review src/foo.ts",
			sessionFile: "/tmp/s.jsonl",
			tempDir: dir,
		});
		const taskArg = built.args.find((a) => a.startsWith("@"));
		assert.ok(taskArg);
		const text = readFileSync(taskArg!.slice(1), "utf8");
		assert.match(text, /Task: Review src\/foo\.ts/);
		assert.ok(text.includes(CHILD_TASK_APPENDIX));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("buildPiArgs allowNested omits the no-nested-agents constraint", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "args-nested-"));
	try {
		const built = buildPiArgs({
			agent: agent(),
			task: "delegate",
			sessionFile: "/tmp/s.jsonl",
			tempDir: dir,
			allowNestedSubagents: true,
		});
		const taskArg = built.args.find((a) => a.startsWith("@"));
		assert.ok(taskArg);
		const text = readFileSync(taskArg!.slice(1), "utf8");
		assert.match(text, /Nested subagents via `subagent` tool only/);
		assert.doesNotMatch(text, /Do not spawn nested agents/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("buildPiArgs worktreeBranch lands in the task file", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "args-wt-"));
	try {
		const built = buildPiArgs({
			agent: agent(),
			task: "implement",
			sessionFile: "/tmp/s.jsonl",
			tempDir: dir,
			worktreeBranch: "pi-subagent/worker-0-deadbeef",
		});
		const taskArg = built.args.find((a) => a.startsWith("@"));
		assert.ok(taskArg);
		const text = readFileSync(taskArg!.slice(1), "utf8");
		assert.match(text, /pi-subagent\/worker-0-deadbeef/);
		assert.match(text, /merge request \/ pull request/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
	const prev: Record<string, string | undefined> = {};
	for (const k of Object.keys(vars)) { prev[k] = process.env[k]; if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]; }
	try { return fn(); } finally { for (const k of Object.keys(prev)) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]; } }
}

function argvFor(a: AgentConfig): string[] {
	const dir = mkdtempSync(path.join(tmpdir(), "args-noext-"));
	try { return buildPiArgs({ agent: a, task: "t", sessionFile: "/tmp/s.jsonl", tempDir: dir }).args; }
	finally { rmSync(dir, { recursive: true, force: true }); }
}

test("#43 children get --no-extensions by default, guard + explicit extensions still load", () => {
	withEnv({ PI_LEGION_CHILD_INHERIT_EXTENSIONS: undefined, PI_LEGION_CHILD_EXTENSIONS: undefined }, () => {
		const args = argvFor({ ...agent(), extensions: ["/opt/ext/lsp.ts"] });
		assert.equal(args.filter((a) => a === "--no-extensions").length, 1);
		const exts = args.flatMap((a, i) => (a === "--extension" ? [args[i + 1]] : []));
		assert.deepEqual(exts, ["/opt/ext/lsp.ts", childGuardExtensionPath()]);
		assert.ok(args.indexOf("--no-extensions") < args.indexOf("--extension"));
	});
});

test("#43 escape hatches: role inheritExtensions, env inherit, env extra extensions", () => {
	withEnv({ PI_LEGION_CHILD_INHERIT_EXTENSIONS: undefined, PI_LEGION_CHILD_EXTENSIONS: undefined }, () => {
		assert.ok(!argvFor({ ...agent(), inheritExtensions: true }).includes("--no-extensions"));
	});
	for (const v of ["1", "true", "on"]) {
		withEnv({ PI_LEGION_CHILD_INHERIT_EXTENSIONS: v }, () => assert.ok(!argvFor(agent()).includes("--no-extensions")));
	}
	withEnv({ PI_LEGION_CHILD_INHERIT_EXTENSIONS: "0", PI_LEGION_CHILD_EXTENSIONS: "/a/provider.ts,/b/x.ts" }, () => {
		const args = argvFor(agent());
		assert.ok(args.includes("--no-extensions"));
		const exts = args.flatMap((a, i) => (a === "--extension" ? [args[i + 1]] : []));
		assert.deepEqual(exts, ["/a/provider.ts", "/b/x.ts", childGuardExtensionPath()]);
	});
});


test("#89 tools:codemode auto-loads builtin:codemode under --no-extensions", () => {
	withEnv({ PI_LEGION_CHILD_INHERIT_EXTENSIONS: undefined, PI_LEGION_CHILD_EXTENSIONS: undefined }, () => {
		const args = argvFor({ ...agent(), tools: ["read", "bash", "codemode"] });
		assert.ok(args.includes("--no-extensions"));
		const exts = args.flatMap((a, i) => (a === "--extension" ? [args[i + 1]] : []));
		assert.ok(exts.includes(BUILTIN_CODEMODE), `expected ${BUILTIN_CODEMODE} in ${exts.join(",")}`);
		assert.equal(exts.filter((e) => e === BUILTIN_CODEMODE).length, 1);
		assert.ok(exts.includes(childGuardExtensionPath()));
		// builtin refs must not be path.resolved into cwd/builtin:codemode
		assert.equal(exts.some((e) => !!e && e.includes("/") && e.endsWith("builtin:codemode")), false);
	});
});

test("#89 collectChildExtensions dedupes explicit builtin:codemode", () => {
	withEnv({ PI_LEGION_CHILD_INHERIT_EXTENSIONS: undefined, PI_LEGION_CHILD_EXTENSIONS: undefined }, () => {
		const exts = collectChildExtensions({
			tools: ["codemode"],
			extensions: [BUILTIN_CODEMODE],
		});
		assert.equal(exts.filter((e) => e === BUILTIN_CODEMODE).length, 1);
		assert.deepEqual(
			exts,
			[BUILTIN_CODEMODE, childGuardExtensionPath()],
		);
	});
});

test("#89 no codemode tool → no auto builtin:codemode", () => {
	withEnv({ PI_LEGION_CHILD_INHERIT_EXTENSIONS: undefined, PI_LEGION_CHILD_EXTENSIONS: undefined }, () => {
		const exts = argvFor(agent()).flatMap((a, i, args) => (a === "--extension" ? [args[i + 1]] : []));
		assert.equal(exts.includes(BUILTIN_CODEMODE), false);
	});
});

test("#123 modelProvider pins --provider next to --model", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "args-provider-"));
	try {
		const built = buildPiArgs({
			agent: agent(),
			task: "recon",
			sessionFile: "/tmp/s.jsonl",
			tempDir: dir,
			model: "workbuddy/hy4-preview-ioa",
			thinking: "high",
			modelProvider: "any-endpoint",
		});
		const mIdx = built.args.indexOf("--model");
		assert.ok(mIdx >= 0, "argv must carry --model");
		const pIdx = built.args.indexOf("--provider");
		assert.ok(pIdx >= 0, "argv must carry --provider");
		assert.equal(built.args[mIdx + 1], "workbuddy/hy4-preview-ioa:high");
		assert.equal(built.args[pIdx + 1], "any-endpoint");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("#123 no modelProvider → no --provider flag", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "args-noprovider-"));
	try {
		const built = buildPiArgs({
			agent: agent(),
			task: "recon",
			sessionFile: "/tmp/s.jsonl",
			tempDir: dir,
			model: "workbuddy/hy4-preview-ioa",
		});
		assert.ok(built.args.includes("--model"));
		assert.equal(built.args.includes("--provider"), false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("#123 no model → neither --model nor --provider", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "args-nomodel-"));
	try {
		const built = buildPiArgs({
			agent: agent(),
			task: "recon",
			sessionFile: "/tmp/s.jsonl",
			tempDir: dir,
			modelProvider: "any-endpoint",
		});
		assert.equal(built.args.includes("--model"), false);
		// --provider without --model is rejected by pi; both move together.
		assert.equal(built.args.includes("--provider"), false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
