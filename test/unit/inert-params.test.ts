/**
 * tool-surface-dedup-v1 D3 — an inert parameter is REFUSED, not silently dropped.
 *
 * The schema is a flat bag: every consumer sees all 25 fields, so `subagent({
 * action: "wait", force: true })` used to run a plain wait and answer with
 * a receipt — the caller believed it forced something. Only params whose ONE
 * consumer is proven are hardened; `name` / `all` / `runId` / `message` / `model`
 * are read by several actions and stay permissive, and the resolution fields
 * (`cwd` / `hostCwd` / `host` / `agentScope`) are read for EVERY action before
 * dispatch, so they can never be refused (附录 B1).
 *
 * Three layers are pinned here:
 *   1. the refusal table is the contract's, and it is DERIVED from
 *      `ACTION_SPECS.params` — the hand-written contract list below is the
 *      governance anchor, so a tweak there cannot quietly change the surface;
 *   2. the pure function: what counts as "provided", what stays permissive, the
 *      sorted order fields are reported in, and the wording rules (a `launch`
 *      owner is never suggested as "call this instead" — 附录 B1);
 *   3. the tool wiring end to end — the refusal fires before anything is resolved
 *      or launched, an aborted turn still answers `interrupted`, and a legal call
 *      that merely looks similar is untouched.
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
 * The contract's D3 table (附录 B1 applied: `host` is gone — `cwdIsRemote` reads it
 * for every action), transcribed by hand ON PURPOSE: this literal is the frozen
 * decision, so editing the implementation's spec table cannot edit the test.
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
	return true; // force / clearQueued / async / worktree
}

test("D3: the DERIVED refusal table equals the contract's proven-single-consumer set", () => {
	// The table is inverted from `ACTION_SPECS.params`, so this assertion is what
	// keeps the derivation honest: an action that starts listing `force` (or stops
	// listing `ms`) changes the refusal surface, and that must show up here.
	assert.deepEqual(
		Object.keys(PARAM_OWNER_ACTIONS).sort(),
		Object.keys(CONTRACT_PARAM_OWNERS).sort(),
		"the refused set must not grow or shrink without a new contract",
	);
	for (const [field, owner] of Object.entries(CONTRACT_PARAM_OWNERS)) {
		assert.equal(PARAM_OWNER_ACTIONS[field], owner, `${field} is read by "${owner}" only`);
	}
});

test("D3: every derived field has exactly one owner, and shared/resolution fields are absent", () => {
	for (const [field, owner] of Object.entries(PARAM_OWNER_ACTIONS)) {
		const claiming = ACTION_NAMES.filter((action) => ACTION_SPECS[action].params.includes(field));
		assert.deepEqual(claiming, [owner], `${field} must be listed by "${owner}" and no other action`);
	}
	for (const field of ["name", "all", "runId", "message", "model"]) {
		assert.equal(PARAM_OWNER_ACTIONS[field], undefined, `${field} is multi-consumer and must stay permissive`);
	}
	// 附录 B1: these are read for EVERY action before dispatch, so they are not
	// "inert" anywhere — `{ action: "resume", host: "build-box" }` is a supported
	// cross-machine revive and must never be refused.
	for (const field of ["cwd", "hostCwd", "host", "agentScope"]) {
		assert.equal(PARAM_OWNER_ACTIONS[field], undefined, `${field} is resolved for every action`);
	}
	// 附录 B1: `extend` really reads `runId` (scope resolution runs before the extend
	// branch), so the spec must say so even though `runId` stays unrefused.
	assert.ok(ACTION_SPECS.extend.params.includes("runId"), "extend reads runId");
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
	assert.deepEqual(inertParamsFor("status", { name: "worker-0", force: undefined }), []);
	assert.deepEqual(inertParamsFor("status", {}), []);
	// `false` / `0` / `""` ARE provided — they are choices, not absences.
	assert.deepEqual(inertParamsFor("status", { force: false }), ["force"]);
	assert.deepEqual(inertParamsFor("status", { timeoutMs: 0 }), ["timeoutMs"]);
	assert.deepEqual(inertParamsFor("status", { section: "" }), ["section"]);
});

test("D3: multi-consumer params, the resolution fields and the documented exclusions stay permissive", () => {
	// `name`/`all`/`runId`/`message`/`model` are read by several actions.
	const control = { name: "worker-0", runId: "r-1", message: "go on", model: "p/m" };
	for (const action of ["continue", "steer", "abort", "resume", "status"] as const) {
		assert.deepEqual(inertParamsFor(action, control), [], `${action} reads the control fields`);
	}
	assert.deepEqual(inertParamsFor("stop", { name: "worker-0", all: true, force: true }), []);
	assert.deepEqual(inertParamsFor("wait", { all: true, timeoutMs: 50 }), []);
	// 附录 B1: a cross-machine revive passes `host` (and `cwd`) on a control action.
	assert.deepEqual(inertParamsFor("resume", { name: "worker-0", message: "go", host: "build-box" }), []);
	assert.deepEqual(inertParamsFor("status", { name: "worker-0", cwd: "/tmp", hostCwd: "/r", agentScope: "both" }), []);
	// EXCLUDED by the contract: `wait` ignores `runId` (it returns before scope
	// resolution). That inconsistency is a separate decision, so it must NOT be
	// refused here — this assertion is the pin that it stays untouched.
	assert.deepEqual(inertParamsFor("wait", { name: "worker-0", runId: "r-1" }), []);
	// EXCLUDED: `timeoutMs` values are not validated (negative / NaN / 0 pass through).
	assert.deepEqual(inertParamsFor("wait", { name: "worker-0", timeoutMs: -5 }), []);
});

test("D3: every offending field is reported, sorted", () => {
	assert.deepEqual(
		inertParamsFor("status", { name: "worker-0", timeoutMs: 1, ms: 2, force: true, clearQueued: false }),
		["clearQueued", "force", "ms", "timeoutMs"],
		"sorted, so the message reads the same way however the specs are ordered",
	);
	assert.deepEqual(
		inertParamsFor("stop", { name: "worker-0", agent: "worker", task: "t", tasks: [], async: false }),
		["agent", "async", "task", "tasks"],
	);
});

test("D3: the refusal text names the field, its action, the action used, and both ways out", () => {
	// The contract's own example, character for character.
	assert.equal(
		inertParamsMessage(["force"], "status"),
		'force is only read by action "stop" (got action "status"). Drop it or call action:"stop".',
	);
	// Several control-owned fields: one clause each, then a single actionable tail.
	// `inertParamsFor` hands the message a SORTED list; the message echoes that order.
	assert.equal(
		inertParamsMessage(["ms", "timeoutMs"], "status"),
		'ms is only read by action "extend"; timeoutMs is only read by action "wait" (got action "status"). ' +
			'Drop them or call the action that reads each (ms → action:"extend", timeoutMs → action:"wait").',
	);
	// 附录 B1: a `launch`-owned field never suggests switching to `launch` — the
	// description tells the model to `wait` in the same turn, so that
	// advice would argue against the paragraph the model just read.
	assert.equal(
		inertParamsMessage(["async"], "wait"),
		'async is only read by action "launch" (got action "wait"). Drop it.',
	);
	assert.equal(
		inertParamsMessage(["async", "team"], "wait"),
		'async is only read by action "launch"; team is only read by action "launch" (got action "wait"). Drop them.',
	);
	// A mixed bag suggests only the control-owned fields, and says nothing about launch.
	assert.equal(
		inertParamsMessage(["async", "force"], "wait"),
		'async is only read by action "launch"; force is only read by action "stop" (got action "wait"). ' +
			'Drop them or call action:"stop".',
	);
	// Every field must remain resolvable to a real action — a message that says
	// `only read by action "undefined"` is worse than no message.
	for (const field of Object.keys(PARAM_OWNER_ACTIONS)) {
		const text = inertParamsMessage([field], "status");
		assert.match(text, /only read by action "[a-z]+"/, `${field} must name a real action`);
		assert.doesNotMatch(text, /action:"launch"/, `${field}: launch is never the suggested fix`);
	}
});

// ---------------------------------------------------------------------------
// The tool wiring: after `action` is parsed and after the abort net, before any
// side effect.
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
	const call = async (params: Record<string, unknown>, signal?: AbortSignal) => {
		const result = await tool.execute(
			"inert-params-test",
			params,
			signal,
			undefined,
			{ cwd, hasUI: false, ui: { notify() {}, setStatus() {} } },
		);
		return {
			text: (result.content ?? []).map((item) => item.text ?? "").join("\n"),
			details: result.details as { error?: string } | undefined,
		};
	};
	return {
		supervisor,
		invoke: (params: Record<string, unknown>) => call(params),
		async cleanup() {
			await handlers.get("session_shutdown")?.();
			for (const [name, value] of previous) {
				if (value === undefined) delete process.env[name];
				else process.env[name] = value;
			}
			rmSync(cwd, { recursive: true, force: true });
		},
		call,
	};
}

test("D3: execute refuses an inert param before it resolves anything", async () => {
	const harness = indexHarness();
	try {
		// `force` belongs to `stop`. The child does not exist — if the gate ran after
		// name resolution this would answer `unknown child: ghost`, which is exactly
		// the silent-drop failure the contract is about. The code + wording are the
		// load-bearing evidence here; `supervisor.calls` is empty either way for a
		// wait (nothing would have been spawned), so it proves nothing on its own.
		const refused = await harness.invoke({ action: "wait", name: "ghost", force: true });
		assert.equal(refused.details?.error, ErrorCodes.INVALID_PARAMS);
		assert.match(
			refused.text,
			/^force is only read by action "stop" \(got action "wait"\)\. Drop it or call action:"stop"\.$/,
		);
		assert.doesNotMatch(refused.text, /unknown child/i, "the gate must precede child resolution");

		// A refused LAUNCH must not reach the supervisor — HERE the call count IS
		// discriminating: without the gate this would have spawned a child.
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

test("D3: an aborted turn still answers `interrupted`, inert field or not", async () => {
	const harness = indexHarness();
	try {
		// 附录 B5: the gate sits AFTER the abort net. A turn that was already cut gets
		// its one honest answer; turning it into INVALID_PARAMS because the call also
		// carried an inert field would be an unannounced behaviour change.
		const controller = new AbortController();
		controller.abort();
		const interrupted = await harness.call({ action: "wait", name: "ghost", force: true }, controller.signal);
		assert.equal(interrupted.details?.error, undefined, "an aborted turn is not a param error");
		assert.equal(interrupted.text, "interrupted (parent turn ended; children still running)");
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

		// `async` on `wait` is refused, and the text does NOT point at `launch`.
		const asyncOnWait = await harness.invoke({ action: "wait", name: "ghost", async: false });
		assert.equal(asyncOnWait.details?.error, ErrorCodes.INVALID_PARAMS);
		assert.match(asyncOnWait.text, /^async is only read by action "launch" \(got action "wait"\)\. Drop it\.$/);

		// And a stop with `force` is untouched by the gate.
		const stop = await harness.invoke({ action: "stop", name: "ghost", force: true });
		assert.doesNotMatch(stop.text, /only read by action/, "force is legal on stop");
	} finally {
		await harness.cleanup();
	}
});

test("collect-merge-v1 D2: `runId` on `wait` is accepted and ignored, never refused", async () => {
	const harness = indexHarness();
	try {
		// `collect` was the only read verb that read `runId`, and `wait` never did;
		// collect-merge-v1 accepted that gap (D2 option (a)) instead of teaching `wait` a
		// second scope. `runId` is multi-consumer, so the inert gate cannot refuse it
		// either: the call must reach the ordinary wait answer, not a param error. This
		// is what a caller of the deleted action actually meets.
		const waited = await harness.invoke({ action: "wait", name: "ghost", runId: "r-4fd626ee" });
		assert.notEqual(waited.details?.error, ErrorCodes.INVALID_PARAMS, "runId is not an inert-param refusal");
		assert.doesNotMatch(waited.text, /only read by action/, "no refusal clause is invented for runId");
		assert.match(waited.text, /unknown child/i, "the call ran the ordinary wait path, ignoring runId");
	} finally {
		await harness.cleanup();
	}
});
