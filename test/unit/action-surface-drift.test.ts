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
 *   2. …and the same ORDER, because that list is what the model reads: the union
 *      and the `Actions:` line are derived, so they must follow `ACTION_NAMES`,
 *      which is pinned to the lifecycle order (附录 B2).
 *   3. The `N 个动作` COUNT in §9.3 matches too — the table could keep every name
 *      right under "99 个动作" and nobody would notice (附录 B2).
 *   4. `ACTION_SPECS[*].params` entries are real `SubagentParams` properties. This
 *      is the only mechanical defence against a spec inventing a field: the D3
 *      refusal table is derived from exactly these lists (附录 B2).
 *   5. The comparison itself is not vacuous: a dropped / duplicated / invented
 *      action is proven to throw.
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

/**
 * The lifecycle order the surface must read in (附录 B2). This literal is a
 * governance anchor, not a second source: it exists so a "harmless reorder" of
 * `ACTION_NAMES` (which would silently reorder both the union and the
 * `Actions:` line the model reads) has to be a deliberate test edit.
 */
const LIFECYCLE_ORDER = [
	"launch",
	"continue",
	"steer",
	"abort",
	"resume",
	"status",
	"wait",
	"stop",
	"diagnose",
	"extend",
	"recover",
];

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

/**
 * The `subagent` row of the `docs/design.md` §9.3 table: the 作用 cell lists the
 * actions AND states the count (`11 个动作`). Both are returned — a table can keep
 * every name right and still lie about how many there are.
 */
function designActionTable(markdown: string): { readonly names: string[]; readonly count: number } {
	const row = markdown.split("\n").find((line) => line.startsWith("| `subagent` |"));
	assert.ok(row, "docs/design.md §9.3 must keep its `subagent` row");
	const what = row.split("|").find((cell) => cell.includes("个动作"));
	assert.ok(what, "the `subagent` row must keep its action list");
	const stated = /(\d+)\s*个动作/.exec(what);
	assert.ok(stated?.[1], "the `subagent` row must state how many actions there are");
	return {
		names: [...what.matchAll(/`([a-z]+)`/g)].map((match) => match[1] as string),
		count: Number(stated[1]),
	};
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
 * The `subagent` schema exactly as a model receives it: the `action` union's
 * literals and every declared property name.
 *
 * A real registration against a `FakeSupervisor` in a throwaway agent dir — the
 * same harness shape as `tool-surface-polish.test.ts`, cut down to the two facts
 * this file reads. Nothing is launched.
 */
async function registeredSurface(): Promise<{ literals: string[]; propertyKeys: string[] }> {
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
			| {
				parameters?: {
					properties?: {
						action?: { anyOf?: Array<{ const?: unknown }> };
						[key: string]: unknown;
					};
				};
			}
			| undefined;
		assert.ok(tool, "the `subagent` tool must be registered");
		const properties = tool.parameters?.properties;
		assert.ok(properties, "`subagent` must register a parameter schema");
		const anyOf = properties.action?.anyOf;
		assert.ok(Array.isArray(anyOf) && anyOf.length > 0, "`action` must be a union of literals");
		return {
			literals: anyOf.map((branch) => String(branch.const)),
			propertyKeys: Object.keys(properties),
		};
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
	const surface = await registeredSurface();
	for (const [label, actual] of [
		["the README action table", readmeActionNames(readRepo("README.md"))],
		["the docs/design.md §9.3 table", designActionTable(readRepo("docs/design.md")).names],
		["TOOL_DESCRIPTION's `Actions:` line", descriptionActionNames(TOOL_DESCRIPTION)],
		["the registered schema's action union", surface.literals],
	] as const) {
		assertSameActionSet(label, actual, canonical);
	}
	// Order too: both code-side copies are DERIVED from ACTION_NAMES, which is the
	// order the model reads — so every one of them must follow it exactly.
	assert.deepEqual(descriptionActionNames(TOOL_DESCRIPTION), canonical, "the `Actions:` line follows ACTION_NAMES");
	assert.deepEqual(surface.literals, canonical, "the schema union follows ACTION_NAMES");
	// …and that order is the lifecycle order, not whatever landed last (附录 B2).
	assert.deepEqual(canonical, LIFECYCLE_ORDER, "ACTION_NAMES is in lifecycle order");
});

test("D1: the action COUNT in docs/design.md §9.3 is asserted, not just the list", () => {
	const table = designActionTable(readRepo("docs/design.md"));
	assert.equal(
		table.count,
		ACTION_NAMES.length,
		"§9.3's `N 个动作` must match ACTION_NAMES — a right list under a wrong count is still a lie",
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
	// Order is not what the SET check cares about (the order pins live above).
	assert.doesNotThrow(() => assertSameActionSet("same set, other order", [...canonical].reverse(), canonical));
});

test("collect-merge-v1 D1: the surface is 11 actions and no longer offers `collect`", () => {
	// The COUNT is a governance anchor (like `LIFECYCLE_ORDER` above): the set
	// assertions are computed from `ACTION_NAMES`, so only a literal number here says
	// "exactly one action was deleted, not two." The registered schema and the
	// `Actions:` line are proven `collect`-free by the equality tests above.
	assert.equal(ACTION_NAMES.length, 11, "collect-merge-v1 took the surface from 12 to 11");
	assert.equal(ACTION_NAMES.filter((action) => (action as string) === "collect").length, 0, "`collect` is not an action");
	assert.equal(Object.keys(ACTION_SPECS).includes("collect"), false, "no orphan spec survives the deletion");
});

test("D1: ACTION_SPECS covers exactly ACTION_NAMES and names only real schema fields", async () => {
	const surface = await registeredSurface();
	assert.deepEqual(
		Object.keys(ACTION_SPECS).sort(),
		[...ACTION_NAMES].sort(),
		"ACTION_SPECS must cover exactly ACTION_NAMES and contain no orphan",
	);
	for (const action of ACTION_NAMES) {
		const { params } = ACTION_SPECS[action];
		assert.equal(
			new Set(params).size,
			params.length,
			`${action}.params must not repeat a field`,
		);
		for (const field of params) {
			// THE anchor (附录 B2): a spec that invents a field would silently create a
			// refusal for something the schema never offered. Nothing else catches it —
			// `bogus` in one spec used to keep every other test green.
			assert.ok(
				surface.propertyKeys.includes(field),
				`${action}.params lists \`${field}\`, which is not a SubagentParams property`,
			);
		}
	}
});
