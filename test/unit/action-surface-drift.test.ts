/**
 * tool-surface-dedup-v1 D1 — the action set exists ONCE, and drift is loud.
 *
 * The `subagent` action set used to live in four places that drifted apart
 * silently: the schema union (14), the README table (13, no `recover`), the
 * `docs/design.md` §9.3 table (13, no `recover`) and the model-facing `Actions:`
 * line (12, no `extend`/`recover`). The code side now DERIVES from
 * `ACTION_NAMES` (`index.ts` builds the union, `playbook.ts` builds the line);
 * the Markdown side stays hand-written and is ASSERTED here.
 *
 * This file is the assertion half of that contract:
 *   1. README table, design.md §9.3, `TOOL_DESCRIPTION`'s `Actions:` line and the
 *      registered schema's `anyOf` are all the SAME set — a missing action in any
 *      one of them (or an extra one) fails.
 *   2. The comparison itself is not vacuous: a dropped / duplicated / invented
 *      action is proven to throw, so a future "simplification" of the comparator
 *      cannot turn all four checks into no-ops.
 *   3. Every action carries a non-empty `summary` and a spec — the surface is
 *      described, not just enumerated.
 *
 * The schema is read off the REGISTERED tool (a real `piLegion` registration),
 * because `SubagentParams` is not exported and because the registered copy is the
 * one a model actually sees.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import piLegion from "../../index.ts";
import { ACTION_NAMES, ACTION_SPECS } from "../../src/extension/action-surface.ts";
import { TOOL_DESCRIPTION } from "../../src/extension/playbook.ts";
import { FakeSupervisor } from "../helpers/fake-supervisor.ts";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

function readRepo(relativePath: string): string {
	return readFileSync(path.join(ROOT, relativePath), "utf8");
}

/**
 * The one comparison every surface goes through.
 *
 * Set equality, not "contains": an action missing from a table and an action
 * invented in a table are both drift, and a table that lists one twice is drift
 * too (it means a row was pasted back in after a rename).
 */
function assertSameActionSet(label: string, actual: readonly string[], expected: readonly string[]): void {
	assert.deepEqual(
		[...new Set(actual)].sort(),
		[...new Set(expected)].sort(),
		`${label} must list exactly the action set`,
	);
	assert.equal(
		actual.length,
		new Set(actual).size,
		`${label} must not list an action twice`,
	);
}

/** The README action table: one row per action, first cell is `` `name` ``. */
function readmeActionNames(markdown: string): string[] {
	const lines = markdown.split("\n");
	const announced = lines.findIndex((line) => line.includes("The `action` union is closed"));
	assert.notEqual(announced, -1, "README must still announce the closed action union");
	const names: string[] = [];
	let inTable = false;
	for (const line of lines.slice(announced)) {
		if (!line.startsWith("|")) {
			if (inTable) break;
			continue;
		}
		// The separator row (`| --- | --- |`) opens the body; everything before it is
		// the header, which names the column (`action`), not an action.
		if (/^\|\s*-{3,}/.test(line)) {
			inTable = true;
			continue;
		}
		if (!inTable) continue;
		const first = line.split("|")[1] ?? "";
		const match = /^\s*`([a-z]+)`/.exec(first);
		if (match?.[1]) names.push(match[1]);
	}
	return names;
}

/** The `subagent` row of the `docs/design.md` §9.3 table; the 作用 cell lists them. */
function designActionNames(markdown: string): string[] {
	const row = markdown.split("\n").find((line) => line.startsWith("| `subagent` |"));
	assert.ok(row, "docs/design.md §9.3 must keep its `subagent` row");
	const what = row.split("|").find((cell) => cell.includes("个动作"));
	assert.ok(what, "the `subagent` row must keep its action list");
	return [...what.matchAll(/`([a-z]+)`/g)].map((match) => match[1] as string);
}

/** The enumeration inside `TOOL_DESCRIPTION`'s `Actions:` line (the only periods end it). */
function descriptionActionNames(description: string): string[] {
	const line = /Actions: ([^.]*)\./.exec(description);
	assert.ok(line?.[1], "TOOL_DESCRIPTION must still carry the derived `Actions:` line");
	return line[1].split(",").map((entry) => entry.trim().replace(/\s*\(default\)$/, ""));
}

const ENV_KEYS = [
	"PI_CODING_AGENT_DIR",
	"PI_LEGION_EXTRA_AGENT_DIRS",
	"PI_SUBAGENT_CHILD",
	"PI_SUBAGENT_ALLOW_NESTED",
	"PI_LEGION_DB",
	"PI_LEGION_NODE_ID",
];

/**
 * The `action` union exactly as a model receives it.
 *
 * A real registration against a `FakeSupervisor` in a throwaway agent dir — the
 * same harness shape as `tool-surface-polish.test.ts`, cut down to the one
 * schema this file reads. Nothing is launched.
 */
async function registeredActionLiteral(): Promise<string[]> {
	const cwd = mkdtempSync(path.join(tmpdir(), "action-surface-drift-"));
	const agentDir = path.join(cwd, "agent-config");
	const extraAgentsDir = path.join(cwd, "extra-agents");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(extraAgentsDir, { recursive: true });
	writeFileSync(
		path.join(agentDir, "settings.json"),
		JSON.stringify({ subagents: { disableBuiltins: true } }),
	);
	const previous = new Map(ENV_KEYS.map((name) => [name, process.env[name]]));
	const tools = new Map<string, unknown>();
	const handlers = new Map<string, (...args: unknown[]) => unknown>();
	const pi = {
		registerTool(value: unknown) {
			tools.set((value as { name: string }).name, value);
		},
		registerCommand() {},
		registerMessageRenderer() {},
		sendMessage() {},
		events: { emit() {} },
		on(name: string, handler: (...args: unknown[]) => unknown) {
			handlers.set(name, handler);
		},
	};
	process.env.PI_CODING_AGENT_DIR = agentDir;
	process.env.PI_LEGION_EXTRA_AGENT_DIRS = extraAgentsDir;
	for (const name of ENV_KEYS.slice(2)) delete process.env[name];
	try {
		piLegion(pi as never, { supervisor: new FakeSupervisor({ immediateTimeout: false }) });
		const tool = tools.get("subagent") as
			| { parameters?: { properties?: { action?: { anyOf?: Array<{ const?: unknown }> } } } }
			| undefined;
		assert.ok(tool, "the `subagent` tool must be registered");
		const anyOf = tool.parameters?.properties?.action?.anyOf;
		assert.ok(Array.isArray(anyOf) && anyOf.length > 0, "`action` must be a union of literals");
		return anyOf.map((branch) => String(branch.const));
	} finally {
		await handlers.get("session_shutdown")?.();
		for (const [name, value] of previous) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
		rmSync(cwd, { recursive: true, force: true });
	}
}

test("D1: README, design.md §9.3, the description line and the schema are ONE action set", async () => {
	const canonical = [...ACTION_NAMES];
	assert.deepEqual(
		[...canonical].sort(),
		[
			"abort", "collect", "continue", "diagnose", "extend", "launch", "list",
			"recover", "resume", "retire", "status", "steer", "stop", "wait",
		],
		"the frozen contract's action set",
	);
	for (const [label, actual] of [
		["the README action table", readmeActionNames(readRepo("README.md"))],
		["the docs/design.md §9.3 table", designActionNames(readRepo("docs/design.md"))],
		["TOOL_DESCRIPTION's `Actions:` line", descriptionActionNames(TOOL_DESCRIPTION)],
		["the registered schema's action union", await registeredActionLiteral()],
	] as const) {
		assertSameActionSet(label, actual, canonical);
	}
	// The description is DERIVED from ACTION_NAMES, so it follows its order too —
	// a hand-written reorder there would mean the derivation was dropped.
	assert.deepEqual(
		descriptionActionNames(TOOL_DESCRIPTION),
		canonical,
		"the `Actions:` line is built from ACTION_NAMES, order included",
	);
});

test("D1: the drift comparison is not vacuous — a dropped, extra or doubled action is red", () => {
	const canonical = [...ACTION_NAMES];
	// The contract's acceptance case: drop `recover` from the code side while the
	// docs keep it, and the check must fail rather than quietly agree.
	assert.throws(
		() => assertSameActionSet("schema without recover", canonical.slice(0, -1), canonical),
		/must list exactly the action set/,
	);
	assert.throws(
		() => assertSameActionSet("invented action", [...canonical, "deploy"], canonical),
		/must list exactly the action set/,
	);
	assert.throws(
		() => assertSameActionSet("duplicated row", [...canonical, "launch"], canonical),
		/must not list an action twice/,
	);
	// Order is not what the SET check cares about (the order pin lives above).
	assert.doesNotThrow(() => assertSameActionSet("same set, other order", [...canonical].reverse(), canonical));
});

test("D1: every action has a spec with a non-empty summary, and no spec is orphaned", () => {
	assert.deepEqual(
		Object.keys(ACTION_SPECS).sort(),
		[...ACTION_NAMES].sort(),
		"ACTION_SPECS must cover exactly ACTION_NAMES",
	);
	for (const action of ACTION_NAMES) {
		const spec = ACTION_SPECS[action];
		assert.ok(spec.summary.trim().length > 0, `${action} must carry a non-empty summary`);
		// `params`/`required` are field names, and a required field must also be a
		// param — otherwise the spec contradicts itself.
		for (const field of spec.params) {
			assert.ok(/^[a-z][a-zA-Z]*$/.test(field), `${action}.params entry ${field} must be a schema field name`);
		}
		for (const field of spec.required) {
			assert.ok(
				spec.params.includes(field),
				`${action}.required lists ${field}, which is not in ${action}.params`,
			);
		}
		assert.equal(spec.modelFacing, true, `${action} is model-facing in this contract (Step 2 flips ops verbs)`);
	}
});
