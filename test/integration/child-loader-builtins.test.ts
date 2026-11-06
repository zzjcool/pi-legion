/**
 * D7 gate: the constant→factory wiring is real, not merely shaped right.
 *
 * D6.3 only asserts "every `builtin:` path ⊆ CHILD_BUILTIN_EXTENSIONS" and never
 * observes the injection point, so deleting `extensionFactories` from
 * `defaultSessionFactory` would leave every other gate green. This file watches a
 * real `DefaultResourceLoader` resolve the plan's paths against the real
 * factories, and pins the D4 invariant (no MCP path) at the same time.
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

test("D7.2 a real loader resolves builtin:codemode from the plan and loads nothing else", async () => {
	const root = mkdtempSync(path.join(tmpdir(), "legion-child-loader-"));
	const previousInherit = process.env.PI_LEGION_CHILD_INHERIT_EXTENSIONS;
	try {
		// The plan's extension list must be this machine's-independent: with host
		// inheritance on it is "whatever the host has", which is not what D7 measures.
		process.env.PI_LEGION_CHILD_INHERIT_EXTENSIONS = "0";
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
			sessionFile: path.join(root, "scout.jsonl"),
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
		const loaded = extensions.map((extension) => extension.path);

		assert.deepEqual(
			errors.map((error) => `${error.path}: ${error.error}`),
			[],
			"the loader must resolve every path the plan hands it",
		);
		assert.ok(
			loaded.includes("builtin:codemode"),
			`expected builtin:codemode to load, got ${loaded.join(", ")}`,
		);

		// D4: mcp / tool-search factories are registered, but no path names them, so
		// the child loads neither — MR1 opens no MCP connection.
		for (const name of ["mcp", "tool-search"]) {
			assert.equal(
				loaded.includes(`builtin:${name}`),
				false,
				`builtin:${name} must not load, got ${loaded.join(", ")}`,
			);
		}
	} finally {
		if (previousInherit === undefined) delete process.env.PI_LEGION_CHILD_INHERIT_EXTENSIONS;
		else process.env.PI_LEGION_CHILD_INHERIT_EXTENSIONS = previousInherit;
		resetExtensionDiscoveryCache();
		rmSync(root, { recursive: true, force: true });
	}
});
