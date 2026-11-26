import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import piLegion from "../../index.ts";
import { runInChildContext } from "../../src/supervisor/child-context.ts";
import {
	forbiddenDispatchReason,
	PARENT_PLAYBOOK,
	shellChunks,
	TOOL_DESCRIPTION,
} from "../../src/extension/playbook.ts";
import { FakeSupervisor } from "../helpers/fake-supervisor.ts";

test("playbook text describes the backend-neutral launch and frozen child guidance", () => {
	assert.match(PARENT_PLAYBOOK, /subagent\(\{ agent:/);
	assert.match(PARENT_PLAYBOOK, /matching role/);
	assert.match(PARENT_PLAYBOOK, /Forbidden/);
	assert.match(PARENT_PLAYBOOK, /Isolation belongs to centurion/);
	assert.match(PARENT_PLAYBOOK, /worktree: true/);
	// #303: the playbook used to say "For N parallel isolated writers, dispatch N
	// centurions". That was an instruction to nest a centurion inside a centurion,
	// which the runtime REFUSES (only the root may dispatch one) — so it told models
	// to do something that could only fail. It now describes the ownership rule
	// without prescribing a nested dispatch.
	assert.match(PARENT_PLAYBOOK, /owns one worktree/);
	assert.doesNotMatch(PARENT_PLAYBOOK, /dispatch N centurions/);
	// D1: children are in-process by default; a separate `pi` process is the
	// worktree/`spawnMode: rpc` case only.
	assert.match(PARENT_PLAYBOOK, /Children are in-process by default/);
	// The `spawnMode` role field is gone (#290); the playbook must not describe it.
	assert.doesNotMatch(PARENT_PLAYBOOK, /spawnMode/);
	assert.match(PARENT_PLAYBOOK, /may hold one/);
	assert.doesNotMatch(PARENT_PLAYBOOK, /headless RPC children/);
	assert.match(PARENT_PLAYBOOK, /verify:/);
	assert.match(TOOL_DESCRIPTION, /async by default/);
	assert.match(PARENT_PLAYBOOK, /Esc \/ wait interrupt only ends the parent turn/);
	assert.doesNotMatch(PARENT_PLAYBOOK, /Same agent type shares one tab/);
});

test("playbook never narrows a backend-neutral fact to the rpc backend (#209/D1)", () => {
	// D1's whole point: the parent-facing copy must not present the rpc backend
	// as the default transport. This is the whole-string guard the review asked
	// for — it catches a NEW rpc-named sentence, not just the four deleted ones.
	assert.doesNotMatch(
		PARENT_PLAYBOOK + TOOL_DESCRIPTION,
		/headless RPC|via RPC|RPC child|RPC launch/i,
	);
	// `--no-extensions` is not an rpc-only fact: in-process children set
	// `noExtensions = !childInheritsExtensions(...)` too
	// (`inprocess-supervisor.ts:145`), so the sentence must stay backend-neutral.
	assert.doesNotMatch(PARENT_PLAYBOOK, /rpc children use `--no-extensions`/);
	assert.match(PARENT_PLAYBOOK, /without host extensions unless the role inherits them/);
});

test("shellChunks splits compound commands", () => {
	assert.deepEqual(shellChunks('test "$HERDR_ENV" = 1 && herdr --help'), [
		'test "$HERDR_ENV" = 1',
		"herdr --help",
	]);
});

test("parent bash no longer blocks legacy herdr inspection commands", () => {
	for (const command of ["herdr --help", "herdr pane list", "herdr agent start worker"]) {
		assert.equal(forbiddenDispatchReason(command), undefined);
	}
});





test("legacy herdr commands remain available for manual v0.16.x workflows", () => {
	const allowed = [
		"herdr pane list",
		"herdr pane read w1:p1",
		"herdr pane close w1:p2",
		"herdr agent list",
		"herdr agent get worker-0",
		"herdr agent read worker-0",
		"herdr tab list",
		"ls",
		"npm test",
		"echo hello",
	];
	for (const command of allowed) {
		assert.equal(
			forbiddenDispatchReason(command),
			undefined,
			`must allow: ${command}`,
		);
	}
});

test("playbook keeps the explicit wait action available", () => {
	assert.match(PARENT_PLAYBOOK, /Use `wait` with `name` or `all: true` when you need blocking results/);
	// The enumeration is derived from `ACTION_NAMES` (D1), so its ORDER is the
	// surface's order, not a hand-written one: assert membership, not adjacency.
	assert.match(TOOL_DESCRIPTION, /Actions: [^.]*\bwait\b/);
});

test("playbook describes event-driven waits and graceful stop", () => {
	assert.match(PARENT_PLAYBOOK, /use `stop` to gracefully retire one child or all tracked children/);
	assert.match(TOOL_DESCRIPTION, /Actions: [^.]*\bstop\b/);
	assert.match(TOOL_DESCRIPTION, /`wait` is event-driven/);
	assert.match(TOOL_DESCRIPTION, /Esc does not retire children/);
});

test("playbook explains timeout and steering semantics", () => {
	assert.match(PARENT_PLAYBOOK, /`wait` timeout with a live child is a progress signal/);
	assert.doesNotMatch(PARENT_PLAYBOOK, /live RPC child/);
	assert.match(PARENT_PLAYBOOK, /session JSONL/);
	assert.match(PARENT_PLAYBOOK, /Do not tell a child to message or prompt the parent/);
});

test("playbook documents status overview vs single child (#145)", () => {
	assert.match(PARENT_PLAYBOOK, /`status` with no name/);
	assert.match(PARENT_PLAYBOOK, /`all: true`/);
	assert.match(TOOL_DESCRIPTION, /`status` with no name \(or `all: true`\)/);
	assert.match(TOOL_DESCRIPTION, /with `name` returns that one child/);
});

test("wait requires name or all: the schema owns the rule, the description no longer repeats it (#161)", async () => {
	const harness = playbookHarness();
	try {
		// tool-surface-dedup-v1 B4: the description's `wait REQUIRES …` half-sentence
		// was a second copy of this rule, and the two could drift apart unnoticed. The
		// schema is now the single machine-facing copy.
		assert.match(
			harness.actionDescription(),
			/wait REQUIRES name or all:true \(mutually exclusive\)/,
		);
		assert.doesNotMatch(TOOL_DESCRIPTION, /`wait` REQUIRES/, "the duplicate must be gone from the description");
		// The example is a call SHAPE, not a rule — it stays.
		assert.match(TOOL_DESCRIPTION, /action: "wait", all: true/);
		assert.match(PARENT_PLAYBOOK, /Use `wait` with `name` or `all: true`/);
	} finally {
		await harness.cleanup();
	}
});

test("playbook says steer queues at a turn boundary and stop is the interrupt (#313)", () => {
	// #313: a `steer` receipt must not read like a delivery claim. `steer` is a
	// queue the child consumes at a turn boundary, so it cannot reach a child
	// that is inside a tool call — writing to stdin of a running bash is not a
	// thing. The playbook has to state the negative semantics, or models keep
	// "steering" a child that is stuck in one long command and never lands.
	assert.match(PARENT_PLAYBOOK, /`steer` is a queue, not an interrupt/);
	assert.match(PARENT_PLAYBOOK, /does not interrupt a tool call that is already executing/);
	assert.match(PARENT_PLAYBOOK, /next turn boundary/);
	assert.match(PARENT_PLAYBOOK, /after the current tool batch finishes/);
	assert.match(PARENT_PLAYBOOK, /never receives a steer/);
	// …and that `stop` is what actually interrupts.
	assert.match(PARENT_PLAYBOOK, /To actually stop a child, use `stop`/);
	assert.match(PARENT_PLAYBOOK, /`force: true` is the hard variant/);
	// tool-surface-dedup-v1 D2 reverses the old pin: the text has ONE source but
	// only ONE model-visible injection point (the systemPrompt, from
	// `before_agent_start`). The description answers HOW to call, never WHEN or
	// WHETHER — so these sentences are asserted on the playbook alone, and the
	// description is asserted NOT to embed it (see the dedicated D2 test below).
	assert.match(PARENT_PLAYBOOK, /`steer` is a queue, not an interrupt/);
	assert.match(PARENT_PLAYBOOK, /To actually stop a child, use `stop`/);
	assert.equal(TOOL_DESCRIPTION.includes(PARENT_PLAYBOOK), false);
	// Numbering stays contiguous and item 8 sits before the unnumbered
	// "Utility agents …" paragraph (D7: append, never renumber items 1-7).
	const item7 = PARENT_PLAYBOOK.indexOf("\n7. ");
	const item8 = PARENT_PLAYBOOK.indexOf("\n8. ");
	const utility = PARENT_PLAYBOOK.indexOf("\nUtility agents");
	assert.ok(item7 > 0, "item 7 must exist");
	assert.ok(item8 > item7, "item 8 must follow item 7");
	assert.ok(utility > item8, "item 8 must precede the Utility agents paragraph");
	// #314 replaced the old `doesNotMatch(/\n9\. /)` pin: that assertion existed
	// to prove the list is CONTIGUOUS, not that it may never grow. Item 9 is the
	// abort paragraph and it belongs between item 8 and the Utility agents
	// paragraph — a new item inserted anywhere else would break the numbering.
	const item9 = PARENT_PLAYBOOK.indexOf("\n9. ");
	assert.ok(item9 > item8, "item 9 must follow item 8");
	assert.ok(item9 < utility, "item 9 must precede the Utility agents paragraph");
	assert.equal(
		PARENT_PLAYBOOK.indexOf("\n10. "),
		-1,
		"the list stops at item 9 — a gap would mean an item was dropped",
	);
});

test("playbook draws the abort-vs-stop boundary and names abort where steer cannot land (#314)", () => {
	// (a) abort keeps the context/session, so the child stays continuable.
	assert.match(PARENT_PLAYBOOK, /`abort` interrupts the child's current turn and keeps its context and session/);
	assert.match(PARENT_PLAYBOOK, /the child stays alive and can be continued/);
	// (b) stop is what tears the process down and throws the context away — the
	// two must not read like the same action.
	assert.match(PARENT_PLAYBOOK, /`stop` is the one that tears the process down and throws the context away/);
	// (c) abort works where steer cannot land: a child stuck inside one long
	// command (#313 — a steer is a queue that only fires at a turn boundary).
	assert.match(PARENT_PLAYBOOK, /works on a child stuck inside one long-running command, where `steer` cannot land/);
	assert.match(PARENT_PLAYBOOK, /#313: a steer only queues at a turn boundary/);
	// Defaults and the "a timeout is not a failure" rule are spelled out, or a
	// model reads a timeout receipt as "it died".
	assert.match(PARENT_PLAYBOOK, /queued steering\/follow-up messages are dropped first/);
	assert.match(PARENT_PLAYBOOK, /`clearQueued: false` keeps them/);
	assert.match(PARENT_PLAYBOOK, /A timeout receipt is not a failure/);
	// TOOL_DESCRIPTION carries the action (derived from ACTION_NAMES, D1) and the
	// same boundary as one sentence of its own.
	assert.match(TOOL_DESCRIPTION, /Actions: [^.]*\babort\b/);
	assert.match(TOOL_DESCRIPTION, /Actions: [^.]*\bdiagnose\b/);
	assert.match(
		TOOL_DESCRIPTION,
		/`abort` stops the child's current turn but keeps its context and session \(child stays alive and continuable; queued messages are dropped first\); `stop` is the one that takes the process down\./,
	);
	// The rpc-narrowing guard in the test above covers the whole string; keep the
	// new sentences backend-neutral too.
	assert.doesNotMatch(
		PARENT_PLAYBOOK + TOOL_DESCRIPTION,
		/headless RPC|via RPC|RPC child|RPC launch/i,
	);
});

// ---------------------------------------------------------------------------
// tool-surface-dedup-v1 D2 — the description no longer carries the playbook
// ---------------------------------------------------------------------------

test("D2: the tool description does not embed the playbook — one text, one injection point", async () => {
	const harness = playbookHarness();
	try {
		// What the description is FOR: how to call — the derived Actions line, the
		// param contract, the abort/stop boundary.
		assert.match(TOOL_DESCRIPTION, /^Roles: /);
		assert.match(TOOL_DESCRIPTION, /Actions: [^.]*\blaunch \(default\)/);
		assert.match(TOOL_DESCRIPTION, /`abort` stops the child's current turn/);
		assert.match(TOOL_DESCRIPTION, /`stop` is the one that takes the process down/);
		// What it must NOT do: repeat WHEN/WHETHER. What this can actually prove is the
		// only thing a string assertion CAN prove: no playbook paragraph was pasted in
		// verbatim. It does NOT catch a paraphrase — that stays a review question, and
		// claiming otherwise here would make this comment a lie.
		assert.equal(TOOL_DESCRIPTION.includes(PARENT_PLAYBOOK), false);
		assert.doesNotMatch(TOOL_DESCRIPTION, /Pi Legion playbook/);
		for (const paragraph of PARENT_PLAYBOOK.split("\n")) {
			assert.equal(
				TOOL_DESCRIPTION.includes(paragraph),
				false,
				`the description must not carry a playbook paragraph: ${paragraph.slice(0, 60)}…`,
			);
		}
		// The playbook text itself is unchanged by the move; the gate that injects it is
		// pinned by the dedicated test below, not by a claim about another file.
		assert.match(PARENT_PLAYBOOK, /^Pi Legion playbook/);
		// B4: the diagnose parenthetical is gone — `providers` was never a section id
		// (`DOCTOR_SECTIONS` has 11, and `providers` is not one of them). The schema's
		// `action` description is the remaining machine-facing copy, and it points at
		// the real source instead of carrying a second enumeration.
		assert.doesNotMatch(TOOL_DESCRIPTION, /providers/, "the invalid section list must not come back");
		assert.doesNotMatch(TOOL_DESCRIPTION, /\(host vs child/, "the parenthetical must not come back");
		assert.match(harness.actionDescription(), /optional section filters like \/legion doctor/);
	} finally {
		await harness.cleanup();
	}
});

// ---------------------------------------------------------------------------
// tool-surface-ops-verbs-v2 D2/D3 — `recover`/`extend` keep only their compressed
// prose, and the field stays inside its character budget
// ---------------------------------------------------------------------------

/**
 * The two paragraphs `docs/contracts/tool-surface-ops-verbs-v2.md` freezes (D3,
 * D2), copied character for character.
 *
 * They are literals here on purpose. The contract's finding was that `extend`
 * (307) + `recover` (413) had grown to 720 of the field's 1,186 characters, so
 * the rewrite had to be ONE text everywhere — a test that re-read the Markdown
 * would still pass if both copies were edited together, while this one fails on
 * any edit to either.
 */
const FROZEN_EXTEND =
	"extend = defer the `may be looping` reminder for one direct child by `ms`. Reminder only: it never changes a wait budget or the child's own timeout, and never restarts, revives or steers it.";
const FROZEN_RECOVER =
	"recover = adopt a child a PREVIOUS session launched on another machine: `name` required, no `runId`. It settles the ledger row and answers like `wait`; a still-live child is only reported. `/legion status` lists what is recoverable.";

test("ops-verbs-v2 D3/D2: `extend` and `recover` are the frozen text, verbatim", async () => {
	const harness = playbookHarness();
	try {
		const description = harness.actionDescription();
		assert.notEqual(
			description.indexOf(FROZEN_EXTEND),
			-1,
			"`extend` must be the contract's text, character for character",
		);
		assert.notEqual(
			description.indexOf(FROZEN_RECOVER),
			-1,
			"`recover` must be the contract's text, character for character",
		);
		// Each frozen marker appears exactly once. Stated precisely, because the FIRST
		// version of this comment over-claimed: these two assertions guarantee (i) the
		// frozen paragraph is present character for character and (ii) no SECOND
		// `extend = ` / `recover = ` block was added beside it. They do NOT promise the
		// surrounding prose cannot grow a contradicting sentence — review injected one
		// ("… still never changes the child's own timeout") that reused neither marker,
		// stayed inside the 950-character budget, and left all three tests green.
		// Closing that hole is a different guard (semantic, or a whole-field snapshot);
		// this comment must not claim it is here.
		assert.equal(description.split("extend = ").length - 1, 1, "`extend` is described exactly once");
		assert.equal(description.split("recover = ").length - 1, 1, "`recover` is described exactly once");
	} finally {
		await harness.cleanup();
	}
});

test("ops-verbs-v2: the `action` description stays inside its 950-character budget", async () => {
	// The budget is the contract's own acceptance number, not a warning level: the
	// field was 1,186 characters before the two paragraphs were compressed, and this
	// must fail the moment the prose starts growing back.
	const harness = playbookHarness();
	try {
		const length = harness.actionDescription().length;
		assert.ok(length <= 950, `the \`action\` description must stay <= 950 chars, got ${length}`);
	} finally {
		await harness.cleanup();
	}
});

/**
 * The shapes that make `retire` read as an ACTION NAME in a schema description.
 *
 * The criterion, written down so it is reviewable rather than implied:
 *   1. a backticked token  — `` `retire` ``
 *   2. a slash-separated action list — `status/wait/…/stop)`
 *   3. an explicit call shape — `action: "retire"`
 *
 * English uses of the verb are deliberately NOT matched: `stop` really does retire
 * a child, so `force`'s own description says "hard-retire … graceful retire", and
 * the `action` description says a finished child reports as "already retired". Those
 * describe behaviour that still exists. Flagging them would make the guard either
 * red on correct text or so vague it proves nothing.
 */
const RETIRE_ACTION_SHAPES = /`retire`|\/retire\b|action: *"retire"/;

test("ops-verbs-v2: NO parameter description names a `retire` action", async () => {
	// Acceptance assertion 2, widened after review. The first version read only
	// `properties.action.description`, and `runId`'s description kept saying
	// "control actions (…/retire)" — a model-visible instruction to call a removed
	// action, three fields away from the one string that was being checked. A guard
	// scoped to the field that happens to be named in the contract is not a guard.
	const harness = playbookHarness();
	try {
		const properties = harness.properties();
		assert.ok(
			Object.keys(properties).length > 10,
			"the schema must still declare its fields — an empty map would pass vacuously",
		);
		const offending = Object.entries(properties)
			.filter(([, spec]) => RETIRE_ACTION_SHAPES.test(spec.description ?? ""))
			.map(([field]) => field);
		assert.deepEqual(offending, [], "no parameter description may name a `retire` action");
	} finally {
		await harness.cleanup();
	}
});

// ---------------------------------------------------------------------------
// tool-surface-dedup-v1 B3 — the gate that actually injects the playbook
// ---------------------------------------------------------------------------

const ENV_KEYS = [
	"PI_CODING_AGENT_DIR",
	"PI_LEGION_EXTRA_AGENT_DIRS",
	"PI_SUBAGENT_CHILD",
	"PI_SUBAGENT_ALLOW_NESTED",
	"PI_LEGION_DB",
	"PI_LEGION_NODE_ID",
	"PI_SUBAGENT_UTILITY_CHILD",
];

/**
 * A real `piLegion` registration in a throwaway agent dir: it captures the
 * `before_agent_start` handler and the `subagent` schema, nothing else runs.
 *
 * `systemPromptOptions.selectedTools` is passed straight through, because that
 * array is what the gate actually reads — the earlier coverage of this file went
 * around the gate (an empty options object), which is why deleting the injection
 * left the whole suite green.
 */
function playbookHarness() {
	const cwd = mkdtempSync(path.join(tmpdir(), "legion-playbook-"));
	const agentDir = path.join(cwd, "agent-config");
	const extraAgentsDir = path.join(cwd, "extra-agents");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(extraAgentsDir, { recursive: true });
	writeFileSync(
		path.join(agentDir, "settings.json"),
		JSON.stringify({ subagents: { disableBuiltins: true } }),
	);
	const previous = new Map(ENV_KEYS.map((name) => [name, process.env[name]]));
	const handlers = new Map<string, (...args: unknown[]) => unknown>();
	const tools = new Map<string, unknown>();
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
	piLegion(pi as never, { supervisor: new FakeSupervisor({ immediateTimeout: false }) });
	const tool = tools.get("subagent") as
		| { parameters?: { properties?: Record<string, { description?: string }> } }
		| undefined;
	return {
		/** The `action` field's description exactly as the model receives it. */
		actionDescription(): string {
			return tool?.parameters?.properties?.action?.description ?? "";
		},
		/** Every declared parameter's description, exactly as the model receives it. */
		properties(): Record<string, { description?: string }> {
			return tool?.parameters?.properties ?? {};
		},
		/**
		 * Drive `before_agent_start` the way the host does. `selectedTools` is passed
		 * only when the caller names it, so "the host said nothing" stays distinct from
		 * "the host said no dispatch tools".
		 */
		beforeAgentStart(options: { selectedTools?: string[] } = {}): string {
			const handler = handlers.get("before_agent_start");
			assert.ok(handler, "`before_agent_start` must be registered");
			const result = handler(
				{
					systemPrompt: "base prompt",
					systemPromptOptions: options.selectedTools ? { selectedTools: options.selectedTools } : {},
				},
				{ cwd, hasUI: false, ui: { notify() {}, setStatus() {} } },
			) as { systemPrompt?: string } | undefined;
			return result?.systemPrompt ?? "";
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

test("D2: `before_agent_start` is the playbook's ONE model-visible injection point", async () => {
	const harness = playbookHarness();
	try {
		// (a) a session that may dispatch gets the playbook — either dispatch tool is
		// enough, and it survives next to unrelated tools.
		for (const selectedTools of [["subagent"], ["vexillatio"], ["bash", "subagent", "edit"]]) {
			const prompt = harness.beforeAgentStart({ selectedTools });
			assert.ok(
				prompt.includes(PARENT_PLAYBOOK),
				`selectedTools=[${selectedTools.join(", ")}] must get the playbook`,
			);
		}
		// A host that names no tools at all cannot be narrowed — the pre-existing
		// default stays (this is what every other harness in the suite relies on).
		assert.ok(harness.beforeAgentStart().includes(PARENT_PLAYBOOK), "no selectedTools means no filter");

		// (b) a session that cannot dispatch anything gets no prompt from this gate.
		for (const selectedTools of [["bash", "edit"], []]) {
			const prompt = harness.beforeAgentStart({ selectedTools });
			assert.equal(
				prompt.includes(PARENT_PLAYBOOK),
				false,
				`selectedTools=[${selectedTools.join(", ")}] must not get the playbook`,
			);
		}

		// (c) a utility child is a hard leaf: it never holds the dispatch tools, so it
		// never gets the parent playbook — whatever the tool selection says.
		const utility = await runInChildContext(
			{ allowNested: false, utility: true, spawnMode: "inprocess", role: "scout" },
			async () => harness.beforeAgentStart({ selectedTools: ["subagent"] }),
		);
		assert.equal(utility.includes(PARENT_PLAYBOOK), false, "a utility child must not get the parent playbook");
	} finally {
		await harness.cleanup();
	}
});
