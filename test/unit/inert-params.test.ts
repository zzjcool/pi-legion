/**
 * tool-surface-dedup-v1 D3 — an inert parameter is REFUSED, not silently dropped.
 *
 * The schema is a flat bag: every consumer sees all 25 fields, so `subagent({
 * action: "collect", force: true })` used to run a plain collect and answer with
 * a receipt — the caller believed it forced something. Only params whose ONE
 * consumer is proven are hardened (the contract's table); `name` / `all` /
 * `runId` / `message` / `model` are read by several actions and stay permissive.
 *
 * Three layers are pinned here:
 *   1. the table is exactly the frozen contract's list, and it agrees with
 *      `ACTION_SPECS.params` (the field is claimed by its owner and nobody else);
 *   2. the pure function: what counts as "provided", what stays permissive, and
 *      the order fields are reported in;
 *   3. the tool wiring end to end — the refusal fires BEFORE any side effect
 *      (no child resolved, no launch attempted) and carries an actionable text.
 *
 * Explicitly out of scope, and pinned as such: `runId` on `wait` is ignored by
 * design (the wait path returns before scope resolution), `timeoutMs` values are
 * not validated, and no root-level `anyOf` was added.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import piLegion from "../../index.ts";
import {
	ACTION_NAMES,
	ACTION_SPECS,
	PARAM_OWNER_ACTIONS,
	inertParamsFor,
	inertParamsMessage,
	type ActionName,
} from "../../src/extension/action-surface.ts";
import { ErrorCodes } from "../../src/shared/types.ts";
import { FakeSupervisor } from "../helpers/fake-supervisor.ts";

/**
 * The contract's D3 table, transcribed by hand ON PURPOSE: this literal is the
 * frozen decision, so editing the implementation's table cannot edit the test.
 */
const CONTRACT_PARAM_OWNERS: Readonly<Record<string, ActionName>> = {
	timeoutMs: "wait",
	ms: "extend",
	force: "stop",
	clearQueued: "abort",
	section: "diagnose",
	team: "launch",
	agent: "launch",
	task: "launch",
	tasks: "launch",
	async: "launch",
	preset: "launch",
	worktree: "launch",
	verify: "launch",
	phases: "launch",
	start: "launch",
	host: "launch",
};

/** A value of the right shape for each refused field (only presence matters here). */
function sampleValue(field: string): unknown {
	if (field === "timeoutMs" || field === "ms") return 1_000;
	if (field === "section") return "summary";
	if (field === "team") return "backend";
	if (field === "agent") return "worker";
	if (field === "task") return "do the thing";
	if (field === "tasks") return [{ agent: "worker", task: "do the thing" }];
	if (field === "preset") return "worker-fast";
	if (field === "verify") return ["npm test"];
	if (field === "phases") return "planning, implementing";
	if (field === "start") return "planning";
	if (field === "host") return "build-box";
	return true; // force / clearQueued / async / worktree
}

test("D3: the refusal table is exactly the contract's proven-single-consumer set", () => {
	assert.deepEqual(
		Object.keys(PARAM_OWNER_ACTIONS).sort(),
		Object.keys(CONTRACT_PARAM_OWNERS).sort(),
		"the refused set must not grow or shrink without a new contract",
	);
	for (const [field, owner] of Object.entries(CONTRACT_PARAM_OWNERS)) {
		assert.equal(
			PARAM_OWNER_ACTIONS[field as keyof typeof PARAM_OWNER_ACTIONS],
			owner,
			`${field} is read by "${owner}" only`,
		);
	}
	// Nothing that several actions read may be refused, and the three documented
	// exclusions must stay out of the table entirely.
	for (const field of ["name", "all", "runId", "message", "model", "cwd", "hostCwd", "agentScope"]) {
		assert.equal(
			PARAM_OWNER_ACTIONS[field as keyof typeof PARAM_OWNER_ACTIONS],
			undefined,
			`${field} is multi-consumer and must stay permissive`,
		);
	}
});

test("D3: each refused param is claimed by exactly its owner in ACTION_SPECS", () => {
	for (const [field, owner] of Object.entries(PARAM_OWNER_ACTIONS)) {
		const claiming = ACTION_NAMES.filter((action) => ACTION_SPECS[action].params.includes(field));
		assert.deepEqual(
			claiming,
			[owner],
			`${field} must be listed by "${owner}" and by no other action's params`,
		);
	}
});

test("D3: a provided field is inert on every action except its owner", () => {
	for (const [field, owner] of Object.entries(PARAM_OWNER_ACTIONS)) {
		for (const action of ACTION_NAMES) {
			const inert = inertParamsFor(action, { [field]: sampleValue(field) });
			if (action === owner) {
				assert.deepEqual(inert, [], `${field} is legal on "${owner}"`);
			} else {
				assert.deepEqual(inert, [field], `${field} must be refused on "${action}"`);
			}
		}
	}
});

test("D3: only an explicitly provided value counts as provided", () => {
	// A caller that spreads a config carries `undefined` for keys it did not set;
	// refusing that would punish the spread, not the mistake.
	assert.deepEqual(inertParamsFor("collect", { name: "worker-0", force: undefined }), []);
	assert.deepEqual(inertParamsFor("collect", {}), []);
	// `false` / `0` / `""` ARE provided — they are choices, not absences.
	assert.deepEqual(inertParamsFor("collect", { force: false }), ["force"]);
	assert.deepEqual(inertParamsFor("collect", { timeoutMs: 0 }), ["timeoutMs"]);
	assert.deepEqual(inertParamsFor("collect", { section: "" }), ["section"]);
});

test("D3: multi-consumer params, and the documented exclusions, stay permissive", () => {
	// `name`/`all`/`runId`/`message`/`model` are read by several actions.
	const control = { name: "worker-0", runId: "r-1", message: "go on", model: "p/m" };
	for (const action of ["continue", "steer", "abort", "resume", "retire", "status", "collect"] as const) {
		assert.deepEqual(inertParamsFor(action, control), [], `${action} reads the control fields`);
	}
	assert.deepEqual(inertParamsFor("stop", { name: "worker-0", all: true, force: true }), []);
	assert.deepEqual(inertParamsFor("wait", { all: true, timeoutMs: 50 }), []);
	// EXCLUDED by the contract: `wait` ignores `runId` (it returns before scope
	// resolution). That inconsistency is a separate decision, so it must NOT be
	// refused here — this assertion is the pin that it stays untouched.
	assert.deepEqual(inertParamsFor("wait", { name: "worker-0", runId: "r-1" }), []);
	// EXCLUDED: `timeoutMs` values are not validated (negative / NaN / 0 pass through).
	assert.deepEqual(inertParamsFor("wait", { name: "worker-0", timeoutMs: -5 }), []);
});

test("D3: every offending field is reported, in table order", () => {
	assert.deepEqual(
		inertParamsFor("collect", { name: "worker-0", timeoutMs: 1, ms: 2, force: true, clearQueued: false }),
		["timeoutMs", "ms", "force", "clearQueued"],
		"declaration order, so the message reads the same way every time",
	);
	assert.deepEqual(
		inertParamsFor("stop", { name: "worker-0", agent: "worker", task: "t", tasks: [], async: false }),
		["agent", "task", "tasks", "async"],
	);
});

test("D3: the refusal text names the field, its action, the action used, and both ways out", () => {
	// The contract's own example, character for character.
	assert.equal(
		inertParamsMessage(["force"], "collect"),
		'force is only read by action "stop" (got action "collect"). Drop it or call action:"stop".',
	);
	// Several fields: one clause each, then a single actionable tail.
	assert.equal(
		inertParamsMessage(["timeoutMs", "ms"], "collect"),
		'timeoutMs is only read by action "wait"; ms is only read by action "extend" (got action "collect"). ' +
			'Drop them or call the action that reads each (timeoutMs → action:"wait", ms → action:"extend").',
	);
	// Every field must remain resolvable to a real action — a message that says
	// `only read by action "undefined"` is worse than no message.
	for (const field of Object.keys(PARAM_OWNER_ACTIONS)) {
		const text = inertParamsMessage([field], "collect");
		assert.match(text, /only read by action "[a-z]+"/, `${field} must name a real action`);
		assert.match(text, /Drop it or call action:"[a-z]+"\.$/, `${field} must say what to do instead`);
	}
});

// ---------------------------------------------------------------------------
// The tool wiring: the gate runs after `action` is parsed, before any side effect
// ---------------------------------------------------------------------------

const ENV_KEYS = [
	"PI_CODING_AGENT_DIR",
	"PI_LEGION_EXTRA_AGENT_DIRS",
	"PI_SUBAGENT_CHILD",
	"PI_SUBAGENT_ALLOW_NESTED",
	"PI_LEGION_DB",
	"PI_LEGION_NODE_ID",
];

/**
 * The real `subagent` tool, registered against a `FakeSupervisor` in a throwaway
 * agent dir (the `abort-action.test.ts` harness), driven through `execute`.
 */
function indexHarness() {
	const cwd = mkdtempSync(path.join(tmpdir(), "legion-inert-params-"));
	const agentDir = path.join(cwd, "agent-config");
	const extraAgentsDir = path.join(cwd, "extra-agents");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(extraAgentsDir, { recursive: true });
	writeFileSync(
		path.join(agentDir, "settings.json"),
		JSON.stringify({ subagents: { disableBuiltins: true } }),
	);
	writeFileSync(
		path.join(extraAgentsDir, "worker.md"),
		"---\nname: worker\ndescription: worker role\nkind: pi\n---\nworker prompt\n",
	);
	const previous = new Map(ENV_KEYS.map((name) => [name, process.env[name]]));
	const tools = new Map<
		string,
		{ execute: (...args: unknown[]) => Promise<{ content?: Array<{ text?: string }>; details?: unknown }> }
	>();
	const handlers = new Map<string, (...args: unknown[]) => unknown>();
	const supervisor = new FakeSupervisor({ immediateTimeout: false });
	const pi = {
		registerTool(value: unknown) {
			const typed = value as {
				name: string;
				execute: (...args: unknown[]) => Promise<{ content?: Array<{ text?: string }>; details?: unknown }>;
			};
			tools.set(typed.name, typed);
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
	piLegion(pi as never, { supervisor });
	const tool = tools.get("subagent");
	assert.ok(tool, "the `subagent` tool must be registered");
	return {
		supervisor,
		async invoke(params: Record<string, unknown>) {
			const result = await tool.execute(
				"inert-params-test",
				params,
				undefined,
				undefined,
				{ cwd, hasUI: false, ui: { notify() {}, setStatus() {} } },
			);
			return {
				text: (result.content ?? []).map((item) => item.text ?? "").join("\n"),
				details: result.details as { error?: string } | undefined,
			};
		},
		async cleanup() {
			await handlers.get("session_shutdown")?.();
			for (const [name, value] of previous) {
				if (value === undefined) delete process.env[name];
				else process.env[name] = value;
			}
			rmSync(cwd, { recursive: true, force: true });
		},
	};
}

test("D3: execute refuses an inert param before it resolves anything", async () => {
	const harness = indexHarness();
	try {
		// `force` belongs to `stop`. The child does not exist — if the gate ran after
		// name resolution this would answer `unknown child: ghost`, which is exactly
		// the silent-drop failure the contract is about.
		const refused = await harness.invoke({ action: "collect", name: "ghost", force: true });
		assert.equal(refused.details?.error, ErrorCodes.INVALID_PARAMS);
		assert.match(
			refused.text,
			/^force is only read by action "stop" \(got action "collect"\)\. Drop it or call action:"stop"\.$/,
		);
		assert.doesNotMatch(refused.text, /unknown child/i, "the gate must precede child resolution");
		assert.deepEqual(harness.supervisor.calls, [], "no supervisor call may happen before the refusal");

		// A refused LAUNCH must not start anything either.
		const refusedLaunch = await harness.invoke({
			action: "launch",
			agent: "worker",
			task: "do the thing",
			timeoutMs: 1_000,
		});
		assert.equal(refusedLaunch.details?.error, ErrorCodes.INVALID_PARAMS);
		assert.match(refusedLaunch.text, /timeoutMs is only read by action "wait"/);
		assert.deepEqual(harness.supervisor.calls, [], "a refused launch must not reach the supervisor");
	} finally {
		await harness.cleanup();
	}
});

test("D3: execute still runs a legal call that looks similar", async () => {
	const harness = indexHarness();
	try {
		// Same field, right action: the gate stays out of the way, so the answer is
		// the pre-existing one (`wait` requires name or all), not a refusal.
		const legal = await harness.invoke({ action: "wait", timeoutMs: 5 });
		assert.equal(legal.details?.error, ErrorCodes.INVALID_PARAMS);
		assert.match(legal.text, /`name` or `all` is required for wait/, "the gate did not fire");
		assert.doesNotMatch(legal.text, /only read by action/);

		// And a stop with `force` is untouched by the gate.
		const stop = await harness.invoke({ action: "stop", name: "ghost", force: true });
		assert.doesNotMatch(stop.text, /only read by action/, "force is legal on stop");
	} finally {
		await harness.cleanup();
	}
});
