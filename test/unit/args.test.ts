import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { AgentConfig } from "../../src/shared/types.ts";
import {
	buildPiArgs,
	childGuardExtensionPath,
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
