/**
 * D7 gate: the constant→factory wiring is real, not merely shaped right.
 *
 * D6.3 only asserts "every `builtin:` path ⊆ CHILD_BUILTIN_EXTENSIONS" and never
 * observes the injection point, so deleting `extensionFactories` from
 * `defaultSessionFactory` would leave every other gate green. This file watches a
 * real `DefaultResourceLoader` resolve the plan's paths against the real
 * factories.
 *
 * The MCP invariant flipped in MR2 (`child-mcp-v1` D1): MR1 asserted "no MCP path
 * reaches the loader"; the contract now injects `builtin:mcp` +
 * `builtin:tool-search` for every child, with `PI_LEGION_CHILD_MCP=0` as the only
 * mask. Loading a path is not yet a connection — that needs `session_start`,
 * which the child session factory emits via `bindChildSessionExtensions`; this
 * loader-only test deliberately stops short of it.
 *
 * Static import of the host SDK follows `test/unit/supervisor.test.ts:7`;
 * `src/supervisor/child-builtins.ts` itself stays SDK-free on purpose.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
	DefaultResourceLoader,
	createCodemodeExtension,
	createMcpExtension,
	createToolSearchExtension,
} from "@earendil-works/pi-coding-agent";
import {
	CHILD_BUILTIN_EXTENSIONS,
	type ChildBuiltinFactories,
	childBuiltinExtensionEntries,
} from "../../src/supervisor/child-builtins.ts";
import { buildInProcessSessionPlan } from "../../src/supervisor/inprocess-supervisor.ts";
import { resetExtensionDiscoveryCache } from "../../src/runs/extension-inheritance.ts";

/** The host's real builtins, wired the same way `defaultSessionFactory` does. */
function realFactories() {
	return {
		codemode: createCodemodeExtension(),
		"tool-search": createToolSearchExtension(),
		mcp: createMcpExtension(),
	} satisfies ChildBuiltinFactories;
}

test("D7.1 entries follow the constant's order and wire factories by name", () => {
	const factories = realFactories();
	const entries = childBuiltinExtensionEntries(factories);

	assert.equal(entries.length, CHILD_BUILTIN_EXTENSIONS.length);
	assert.deepEqual(
		entries.map((entry) => entry.name),
		[...CHILD_BUILTIN_EXTENSIONS],
		"entry order is the constant's order",
	);
	for (const entry of entries) {
		assert.equal(entry.builtin, true, `${entry.name} must be a builtin entry`);
		assert.equal(entry.replaceable, true, `${entry.name} must be replaceable`);
		// Same-NAMED factory. A positional zip would pass this only by accident.
		assert.equal(entry.factory, factories[entry.name], `${entry.name} got another builtin's factory`);
	}

	// Declaring the map in a different order must not move a factory to another
	// name: distinct sentinels make "by name" and "by position" tell each other apart.
	const sentinels = {
		mcp: Symbol("mcp"),
		codemode: Symbol("codemode"),
		"tool-search": Symbol("tool-search"),
	};
	const reshuffled = childBuiltinExtensionEntries(sentinels);
	assert.deepEqual(
		reshuffled.map((entry) => entry.name),
		[...CHILD_BUILTIN_EXTENSIONS],
		"output order follows the constant, not the input map",
	);
	for (const entry of reshuffled) {
		assert.equal(entry.factory, sentinels[entry.name], `${entry.name} is wired by position, not by name`);
	}
});

test("D7.2 a real loader resolves the plan's builtin paths; PI_LEGION_CHILD_MCP=0 masks MCP", async () => {
	const root = mkdtempSync(path.join(tmpdir(), "legion-child-loader-"));
	const previousInherit = process.env.PI_LEGION_CHILD_INHERIT_EXTENSIONS;
	const previousMcp = process.env.PI_LEGION_CHILD_MCP;

	/** Build the plan under one MCP setting and let a real loader resolve it. */
	const load = async (mcp: string | undefined) => {
		if (mcp === undefined) delete process.env.PI_LEGION_CHILD_MCP;
		else process.env.PI_LEGION_CHILD_MCP = mcp;
		resetExtensionDiscoveryCache();

		const plan = buildInProcessSessionPlan({
			name: "root.scout",
			cwd: root,
			agent: {
				name: "scout",
				description: "D7 loader probe",
				kind: "pi",
				source: "user",
				filePath: path.join(root, "scout.md"),
				systemPrompt: "",
				systemPromptMode: "replace",
				inheritProjectContext: false,
				inheritSkills: false,
				// A light builtin listed as a tool, so the plan carries `builtin:codemode`
				// exactly as a real role card does.
				tools: ["read", "codemode"],
			},
			sessionFile: path.join(root, `scout${mcp === undefined ? "-on" : "-off"}.jsonl`),
		});

		const loader = new DefaultResourceLoader({
			cwd: root,
			agentDir: root,
			noExtensions: true,
			additionalExtensionPaths: plan.additionalExtensionPaths,
			extensionFactories: childBuiltinExtensionEntries(realFactories()),
		});
		await loader.reload();

		const { extensions = [], errors = [] } = loader.getExtensions();
		assert.deepEqual(
			errors.map((error) => `${error.path}: ${error.error}`),
			[],
			"the loader must resolve every path the plan hands it",
		);
		return { plan, loaded: extensions.map((extension) => extension.path) };
	};

	try {
		// The plan's extension list must be this machine's-independent: with host
		// inheritance on it is "whatever the host has", which is not what D7 measures.
		process.env.PI_LEGION_CHILD_INHERIT_EXTENSIONS = "0";

		// D1 (child-mcp-v1): both builtins are named by default and load for real.
		const on = await load(undefined);
		assert.ok(
			on.plan.additionalExtensionPaths.includes("builtin:mcp"),
			`plan must name builtin:mcp, got ${on.plan.additionalExtensionPaths.join(", ")}`,
		);
		assert.ok(
			on.plan.additionalExtensionPaths.includes("builtin:tool-search"),
			`plan must name builtin:tool-search, got ${on.plan.additionalExtensionPaths.join(", ")}`,
		);
		for (const name of ["codemode", "mcp", "tool-search"]) {
			assert.ok(
				on.loaded.includes(`builtin:${name}`),
				`expected builtin:${name} to load, got ${on.loaded.join(", ")}`,
			);
		}

		// D2: the mask removes exactly the MCP half.
		const off = await load("0");
		assert.ok(
			off.loaded.includes("builtin:codemode"),
			`the codemode path is not MCP-gated, got ${off.loaded.join(", ")}`,
		);
		for (const name of ["mcp", "tool-search"]) {
			assert.equal(
				off.loaded.includes(`builtin:${name}`),
				false,
				`PI_LEGION_CHILD_MCP=0 must keep builtin:${name} out, got ${off.loaded.join(", ")}`,
			);
		}
	} finally {
		if (previousInherit === undefined) delete process.env.PI_LEGION_CHILD_INHERIT_EXTENSIONS;
		else process.env.PI_LEGION_CHILD_INHERIT_EXTENSIONS = previousInherit;
		if (previousMcp === undefined) delete process.env.PI_LEGION_CHILD_MCP;
		else process.env.PI_LEGION_CHILD_MCP = previousMcp;
		resetExtensionDiscoveryCache();
		rmSync(root, { recursive: true, force: true });
	}
});
