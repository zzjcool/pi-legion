import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { AgentConfig } from "../../src/shared/types.ts";
import {
	BUILTIN_CODEMODE,
	SELF_EXTENSION_NAME,
	buildPiArgs,
	childGuardExtensionPath,
	collectChildExtensions,
} from "../../src/runs/args.ts";
import { ensureHostExtensions, resetExtensionDiscoveryCache } from "../../src/runs/extension-inheritance.ts";
import { CHILD_TASK_APPENDIX } from "../../src/extension/child-guard.ts";

/**
 * A fake host for discovery: a `pi` script on PATH reporting package dirs we own.
 *
 * Discovery shells out to `pi list`, so the only honest way to control its
 * result is a real child process. Priming through this helper makes the
 * `--extension` list deterministic instead of "whatever the machine has", which
 * is what the pre-wiring assertions silently relied on.
 */
function fakeHost(packageNames: string[]): {
	entryOf(name: string): string;
	pathValue: string;
	cleanup(): void;
} {
	const root = mkdtempSync(path.join(tmpdir(), "args-host-"));
	const nodeModules = path.join(root, "npm", "node_modules");
	for (const name of packageNames) {
		const pkgDir = path.join(nodeModules, name);
		mkdirSync(pkgDir, { recursive: true });
		writeFileSync(path.join(pkgDir, "index.ts"), "export default {};\n");
	}
	const binDir = path.join(root, "bin");
	mkdirSync(binDir, { recursive: true });
	writeFileSync(
		path.join(binDir, "pi"),
		[
			"#!/bin/sh",
			'echo "User packages:"',
			...packageNames.map((name) => `echo "    ${path.join(nodeModules, name)}"`),
		].join("\n") + "\n",
	);
	chmodSync(path.join(binDir, "pi"), 0o755);
	return {
		entryOf: (name: string) => path.join(nodeModules, name, "index.ts"),
		pathValue: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
		cleanup: () => rmSync(root, { recursive: true, force: true }),
	};
}

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

/** Every value that follows an `--extension` flag, in argv order. */
function extensionsOf(args: string[]): string[] {
	return args.flatMap((arg, i) => (arg === "--extension" ? [args[i + 1] ?? ""] : []));
}

/**
 * Run `fn` with `host` first on PATH, discovery primed from it, and a clean cache
 * on both sides.
 *
 * The explicit `resetExtensionDiscoveryCache()` is the contract's §6 requirement:
 * these cases assert a list SHAPE, so discovery state must be set by the test and
 * never inherited from whatever ran before — which, now that `spawnChild` warms
 * the host set, is genuinely non-empty in a real run.
 */
async function withPrimedHost<T>(
	host: ReturnType<typeof fakeHost>,
	vars: Record<string, string | undefined>,
	fn: () => Promise<T>,
): Promise<T> {
	const prev: Record<string, string | undefined> = { PATH: process.env.PATH };
	for (const key of Object.keys(vars)) prev[key] = process.env[key];
	process.env.PATH = host.pathValue;
	for (const [key, value] of Object.entries(vars)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	resetExtensionDiscoveryCache();
	try {
		await ensureHostExtensions();
		return await fn();
	} finally {
		resetExtensionDiscoveryCache();
		for (const key of Object.keys(prev)) {
			if (prev[key] === undefined) delete process.env[key];
			else process.env[key] = prev[key];
		}
	}
}

test("buildPiArgs injects the child-guard extension", async () => {
	// Discovery is primed with a fake host so the list shape is a fact of this
	// test, not of the machine. What the test pins: host extensions come FIRST,
	// the child-guard comes LAST, and the guard appears exactly once.
	const host = fakeHost(["fake-lens"]);
	const dir = mkdtempSync(path.join(tmpdir(), "args-ext-"));
	try {
		await withPrimedHost(host, {}, async () => {
			const built = buildPiArgs({
				agent: agent(),
				task: "recon",
				sessionFile: "/tmp/s.jsonl",
				tempDir: dir,
			});
			const exts = extensionsOf(built.args);
			assert.ok(exts.length >= 1, "child argv must load an extension");
			assert.equal(exts[0], host.entryOf("fake-lens"), "inherited host extensions come first");
			assert.equal(exts.at(-1), childGuardExtensionPath(), "the child-guard is last");
			assert.equal(
				exts.filter((e) => e === childGuardExtensionPath()).length,
				1,
				"must not duplicate the guard extension",
			);
		});
	} finally {
		resetExtensionDiscoveryCache();
		host.cleanup();
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
	// Contract §6: discovery state must be controlled by the case, never inherited
	// from whatever ran before. Now that the supervisor warms the host set, a
	// leftover cache would make the `--extension` list machine-dependent.
	resetExtensionDiscoveryCache();
	try { return fn(); } finally { resetExtensionDiscoveryCache(); for (const k of Object.keys(prev)) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]; } }
}

function argvFor(a: AgentConfig): string[] {
	const dir = mkdtempSync(path.join(tmpdir(), "args-noext-"));
	try { return buildPiArgs({ agent: a, task: "t", sessionFile: "/tmp/s.jsonl", tempDir: dir }).args; }
	finally { rmSync(dir, { recursive: true, force: true }); }
}

test("#43 children get --no-extensions by default, guard + explicit extensions still load", async () => {
	// The list is no longer just "the card's own + guard": the host set is
	// inherited first. Pin the ORDER properties instead of the whole array —
	// inherited entries first, the role's own list after, the guard last.
	const host = fakeHost(["fake-lens"]);
	try {
		await withPrimedHost(host, { PI_LEGION_CHILD_INHERIT_EXTENSIONS: undefined, PI_LEGION_CHILD_EXTENSIONS: undefined }, async () => {
			const args = argvFor({ ...agent(), extensions: ["/opt/ext/lsp.ts"] });
			assert.equal(args.filter((a) => a === "--no-extensions").length, 1);
			const exts = extensionsOf(args);
			const inheritedAt = exts.indexOf(host.entryOf("fake-lens"));
			const explicitAt = exts.indexOf("/opt/ext/lsp.ts");
			assert.ok(inheritedAt >= 0, `inherited host extension missing from ${exts.join(",")}`);
			assert.ok(explicitAt > inheritedAt, "the card's own list follows the inherited set");
			assert.equal(exts.at(-1), childGuardExtensionPath(), "the child-guard closes the list");
			assert.ok(args.indexOf("--no-extensions") < args.indexOf("--extension"));
		});
	} finally {
		host.cleanup();
	}
});

test("#280: extensions inherit by default; excludeExtensions and inheritExtensions:false narrow it", () => {
	// Policy flipped in #280: `--no-extensions` is now ALWAYS emitted (it stops pi's
	// own settings discovery), and the full list arrives via explicit `--extension`
	// flags. What a card controls is which extensions land in that list.
	const explicit = "/a/provider.ts";
	withEnv({ PI_LEGION_CHILD_INHERIT_EXTENSIONS: undefined, PI_LEGION_CHILD_EXTENSIONS: undefined }, () => {
		const args = argvFor(agent());
		assert.ok(args.includes("--no-extensions"), "pi discovery is always off; the list is ours");
	});
	withEnv({ PI_LEGION_CHILD_EXTENSIONS: explicit }, () => {
		const exts = argvFor(agent()).flatMap((a, i, all) => (a === "--extension" ? [all[i + 1]] : []));
		assert.ok(exts!.includes(explicit), "an explicit extra extension still lands");
		assert.ok(exts!.includes(childGuardExtensionPath()), "the child-guard is unconditional");

		// `inheritExtensions: false` keeps the card's own list and the guard.
		const hermetic = argvFor({ ...agent(), inheritExtensions: false }).flatMap((a, i, all) =>
			a === "--extension" ? [all[i + 1]] : [],
		);
		assert.ok(hermetic!.includes(explicit), "the card's own extensions survive opting out");
		assert.ok(hermetic!.includes(childGuardExtensionPath()), "the child-guard is still injected");

		// The env kill-switch flips the whole tree, either spelling.
		for (const v of ["0", "false", "off", "no"]) {
			withEnv({ PI_LEGION_CHILD_INHERIT_EXTENSIONS: v }, () => {
				const off = argvFor(agent()).flatMap((a, i, all) => (a === "--extension" ? [all[i + 1]] : []));
				assert.ok(off!.includes(explicit), `env=${v} must still load the card's own list`);
			});
		}
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

test("#89 collectChildExtensions dedupes explicit builtin:codemode", async () => {
	const host = fakeHost(["fake-lens"]);
	try {
		await withPrimedHost(host, { PI_LEGION_CHILD_INHERIT_EXTENSIONS: undefined, PI_LEGION_CHILD_EXTENSIONS: undefined }, async () => {
			const exts = collectChildExtensions({
				tools: ["codemode"],
				extensions: [BUILTIN_CODEMODE],
			});
			assert.equal(exts.filter((e) => e === BUILTIN_CODEMODE).length, 1);
			assert.ok(exts.includes(host.entryOf("fake-lens")), "the inherited set is still first-class");
			assert.equal(exts.at(-1), childGuardExtensionPath(), "the child-guard closes the list");
		});
	} finally {
		host.cleanup();
	}
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

test("#193 buildPiArgs default omits --approve / -a / --no-approve", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "args-no-approve-"));
	try {
		const built = buildPiArgs({
			agent: agent(),
			task: "recon",
			sessionFile: "/tmp/s.jsonl",
			tempDir: dir,
		});
		assert.equal(built.args.includes("--approve"), false);
		assert.equal(built.args.includes("-a"), false);
		assert.equal(built.args.includes("--no-approve"), false);
		assert.equal(built.args.includes("-na"), false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("#193 buildPiArgs approve:true appends --approve only", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "args-approve-"));
	try {
		const built = buildPiArgs({
			agent: agent(),
			task: "recon",
			sessionFile: "/tmp/s.jsonl",
			tempDir: dir,
			approve: true,
		});
		assert.ok(built.args.includes("--approve"));
		assert.equal(built.args.includes("--no-approve"), false);
		assert.equal(built.args.filter((a) => a === "--approve").length, 1);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// ── wiring (contract extension-inheritance-wiring-v1 §4) ────────────────────

test("A6: env kill-switch now reaches the inherited half of the list (D3)", async () => {
	// F4: `collectChildExtensions` used to drop `env`, so
	// `PI_LEGION_CHILD_INHERIT_EXTENSIONS=0` emptied `inheritedExtensions(...)`
	// but still yielded the whole host set through this function. The env must
	// apply to BOTH paths.
	const host = fakeHost(["fake-lens"]);
	try {
		await withPrimedHost(host, { PI_LEGION_CHILD_EXTENSIONS: undefined, PI_LEGION_CHILD_INHERIT_EXTENSIONS: undefined }, async () => {
			const on = collectChildExtensions(agent());
			assert.ok(on.includes(host.entryOf("fake-lens")), "default: the host set is inherited");

			const off = collectChildExtensions(agent(), {
				PI_LEGION_CHILD_INHERIT_EXTENSIONS: "0",
			});
			assert.equal(
				off.includes(host.entryOf("fake-lens")),
				false,
				`env=0 must drop inherited entries, got ${off.join(",")}`,
			);
			assert.equal(off.at(-1), childGuardExtensionPath(), "the guard survives the opt-out");

			// The card's own opt-out and the env opt-out must agree.
			const cardOptOut = collectChildExtensions({ ...agent(), inheritExtensions: false }, {
				PI_LEGION_CHILD_INHERIT_EXTENSIONS: "0",
			});
			assert.deepEqual(off, cardOptOut, "env=0 and inheritExtensions:false yield the same list");
		});
	} finally {
		host.cleanup();
	}
});

test("A7: legion never inherits itself, and the child-guard is still appended last (D4)", async () => {
	// Self-exclusion matters in the source-tree layout (F12): `pi list` reports a
	// DIFFERENT path for this package than `childGuardExtensionPath()`, so dedupe
	// cannot collapse them and the child would load two legion factories and die
	// on `Tool "subagent" conflicts with ...`.
	const host = fakeHost(["fake-lens", SELF_EXTENSION_NAME]);
	try {
		await withPrimedHost(host, { PI_LEGION_CHILD_INHERIT_EXTENSIONS: undefined, PI_LEGION_CHILD_EXTENSIONS: undefined }, async () => {
			const list = collectChildExtensions(agent());
			assert.ok(list.includes(host.entryOf("fake-lens")), "other host extensions still inherit");
			assert.equal(
				list.includes(host.entryOf(SELF_EXTENSION_NAME)),
				false,
				`the discovered legion copy must be filtered out, got ${list.join(",")}`,
			);
			assert.equal(list.at(-1), childGuardExtensionPath(), "the guard is appended unconditionally");
			assert.equal(
				list.filter((ext) => ext === childGuardExtensionPath()).length,
				1,
				"exactly one legion extension is loaded",
			);
		});
	} finally {
		host.cleanup();
	}
});

test("A7: self-exclusion cannot swallow an explicit legion entry on the card", async () => {
	// The filter applies to the INHERITED set only. A card that deliberately names
	// legion keeps it — and dedupe still collapses it with the guard.
	const host = fakeHost([SELF_EXTENSION_NAME]);
	try {
		await withPrimedHost(host, { PI_LEGION_CHILD_INHERIT_EXTENSIONS: undefined, PI_LEGION_CHILD_EXTENSIONS: undefined }, async () => {
			const guard = childGuardExtensionPath();
			const list = collectChildExtensions({ ...agent(), extensions: [guard] });
			assert.equal(list.filter((ext) => ext === guard).length, 1, "guard appears once");
			assert.equal(list.includes(host.entryOf(SELF_EXTENSION_NAME)), false, "inherited copy still filtered");
		});
	} finally {
		host.cleanup();
	}
});
