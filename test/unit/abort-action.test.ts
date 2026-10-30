/**
 * #314 — `subagent({ action: "abort" })`: the receipt and the tool wiring.
 *
 * `abort` is a *soft* interrupt: it cuts the child's current turn short and
 * keeps the session, so the child stays continuable. `stop` is the one that
 * takes the process down. The receipt is the only thing the parent sees, so it
 * carries all three honest outcomes — and none of them is an error:
 *
 *   - `interrupted` — the turn was cut. Context survives, partial edits may not.
 *   - `no-turn`     — nothing was running, so nothing was done.
 *   - `timeout`     — the abort was sent but the child had not settled inside
 *                     the bounded wait; a tool that ignores cancellation looks
 *                     exactly like this, so the receipt points at `stop`.
 *
 * Two layers are pinned here, same split as `steer-receipt.test.ts`:
 *   1. `abortReceipt` — the four exact strings (with/without dropped counts,
 *      no-turn, timeout incl. the `2.5` seconds formatting).
 *   2. the tool surface end to end — `subagent({ action: "abort", … })` through
 *      the real extension entry point, so `clearQueued` reaches the supervisor
 *      unmodified (`undefined` on the default path) and the three statuses all
 *      come back as successes.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import piLegion, { abortReceipt } from "../../index.ts";
import { FakeSupervisor } from "../helpers/fake-supervisor.ts";
import { ErrorCodes } from "../../src/shared/types.ts";
import {
	DEFAULT_ABORT_TIMEOUT_MS,
	type AbortOutcome,
} from "../../src/supervisor/types.ts";
import type { ChildRecord, RunRecord } from "../../src/shared/types.ts";

initTheme("dark");

const NOTHING_CLEARED = { steering: 0, followUp: 0 };

/**
 * An `AbortOutcome` with the shared default bound (#325).
 *
 * `timeoutMs` is required on the type because the receipt reports the bound that
 * was really applied; a receipt test therefore has to say which bound it is
 * talking about instead of inheriting a default from the function under test.
 */
function outcome(
	status: AbortOutcome["status"],
	cleared = NOTHING_CLEARED,
	timeoutMs = DEFAULT_ABORT_TIMEOUT_MS,
): AbortOutcome {
	return { status, cleared, timeoutMs };
}

const INTERRUPTED =
	"Aborted worker-0's current turn (context kept; partial edits may remain)";
const INTERRUPTED_DROPPED = `${INTERRUPTED} — dropped 3 queued message(s)`;
const NO_TURN = "Nothing to abort: worker-0 is not running a turn.";
// Derived from the shared constant on purpose: the receipt's default must be the
// bound the supervisor actually used, so a drifted literal fails here.
const DEFAULT_BOUND_SECONDS = DEFAULT_ABORT_TIMEOUT_MS / 1000;
const TIMEOUT_DEFAULT = `Abort sent to worker-0, but it had not settled within ${DEFAULT_BOUND_SECONDS}s — the running tool may ignore cancellation; use stop (or stop with force) if it must die.`;

// ── 1. receipts ─────────────────────────────────────────────────────────

test("#314 abortReceipt: interrupted keeps the context and warns about partial edits", () => {
	const receiptOutcome = outcome("interrupted");
	// Byte-exact: this string is the contract for the `interrupted` state.
	assert.equal(abortReceipt("worker-0", receiptOutcome), INTERRUPTED);
	// "context kept" is the whole difference from `stop`; "partial edits may
	// remain" is the part a rollback promise would have to lie about.
	assert.match(abortReceipt("worker-0", receiptOutcome), /context kept/);
	assert.match(abortReceipt("worker-0", receiptOutcome), /partial edits may remain/);
	// Nothing was dropped, so the receipt must not append a drop clause.
	assert.doesNotMatch(abortReceipt("worker-0", receiptOutcome), /dropped/);
});

test("#314 abortReceipt: interrupted reports the queued messages it dropped", () => {
	// `n` is steering + followUp, not either alone.
	const dropped = abortReceipt(
		"worker-0",
		outcome("interrupted", { steering: 2, followUp: 1 }),
	);
	assert.equal(dropped, INTERRUPTED_DROPPED);
	// The clause is appended, never replaces the context/partial-edits half: the
	// same receipt without the dropped messages is its prefix.
	assert.ok(dropped.startsWith(abortReceipt("worker-0", outcome("interrupted"))));
	// Singular wording does not exist on purpose — the count carries the number.
	assert.equal(
		abortReceipt("worker-0", outcome("interrupted", { steering: 1, followUp: 0 })),
		`${INTERRUPTED} — dropped 1 queued message(s)`,
	);
});

test("#314 abortReceipt: no-turn claims no interrupt", () => {
	assert.equal(abortReceipt("worker-0", outcome("no-turn")), NO_TURN);
	// A child that was already idle must not be told it was aborted, and a "never
	// mind" is not an error either — asserted on the RECEIPT, not on the literal.
	const receipt = abortReceipt("worker-0", outcome("no-turn"));
	assert.doesNotMatch(receipt, /^Aborted/);
	assert.doesNotMatch(receipt, /fail|error/i);
});

test("#314 abortReceipt: timeout points at stop and formats the bounded wait", () => {
	const timedOut = outcome("timeout");
	assert.equal(abortReceipt("worker-0", timedOut), TIMEOUT_DEFAULT);
	// The only actionable hint in the receipt: a timeout kills nothing.
	assert.match(abortReceipt("worker-0", timedOut), /use stop/);
	assert.doesNotMatch(abortReceipt("worker-0", timedOut), /^Aborted/);
	// Integral milliseconds render as whole seconds, everything else keeps one
	// decimal — `2.5s`, never `2.500s` and never `5000`-style raw milliseconds.
	// Both come from the OUTCOME now (#325): the receipt has no default of its own.
	assert.match(
		abortReceipt("worker-0", outcome("timeout", NOTHING_CLEARED, 2_500)),
		/within 2\.5s — /,
	);
	assert.match(
		abortReceipt("worker-0", outcome("timeout", NOTHING_CLEARED, 10_000)),
		/within 10s — /,
	);
});

// ── 2. tool wiring ──────────────────────────────────────────────────────

const ENV_KEYS = [
	"PI_CODING_AGENT_DIR",
	"PI_HERDR_SUBAGENTS_EXTRA_AGENT_DIRS",
	"PI_SUBAGENT_CHILD",
	"PI_SUBAGENT_ALLOW_NESTED",
	"PI_LEGION_DB",
	"PI_LEGION_NODE_ID",
	"PI_SUBAGENTS_TEAM",
];

const WORKER_FILE =
	"---\nname: worker\ndescription: worker role\nkind: pi\n---\nworker prompt\n";

function restoreEnv(previous: Map<string, string | undefined>): void {
	for (const [name, value] of previous) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
}

/**
 * The `status-action.test.ts` harness: a real `piLegion` registration against a
 * `FakeSupervisor`, driven through `tools.get("subagent").execute(...)`.
 *
 * `immediateTimeout: false` and no `autoSettle` on purpose: abort's cases are
 * about a child that is still running, so the fake must keep it live.
 */
function indexHarness() {
	const cwd = mkdtempSync(path.join(tmpdir(), "legion-abort-action-"));
	const agentDir = path.join(cwd, "agent-config");
	const extraAgentsDir = path.join(cwd, "extra-agents");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(extraAgentsDir, { recursive: true });
	writeFileSync(
		path.join(agentDir, "settings.json"),
		JSON.stringify({ subagents: { disableBuiltins: true } }),
	);
	writeFileSync(path.join(extraAgentsDir, "worker.md"), WORKER_FILE);
	const previous = new Map(ENV_KEYS.map((name) => [name, process.env[name]]));
	const tools = new Map<
		string,
		{
			execute: (...args: unknown[]) => Promise<{ content?: Array<{ text?: string }>; details?: unknown }>;
			/** TypeBox schema the model sees — the only place `clearQueued` is documented. */
			parameters?: unknown;
		}
	>();
	const handlers = new Map<string, (...args: unknown[]) => unknown>();
	const supervisor = new FakeSupervisor({ immediateTimeout: false });
	const pi = {
		registerTool(value: unknown) {
			const typed = value as {
				name: string;
				parameters?: unknown;
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
	process.env.PI_HERDR_SUBAGENTS_EXTRA_AGENT_DIRS = extraAgentsDir;
	for (const name of ENV_KEYS.slice(2)) delete process.env[name];
	piLegion(pi as never, { supervisor });
	const tool = tools.get("subagent");
	assert.ok(tool);
	return {
		cwd,
		supervisor,
		async invoke(params: Record<string, unknown>) {
			const result = await tool.execute(
				"abort-action-test",
				params,
				undefined,
				undefined,
				{ cwd, hasUI: false, ui: { notify() {}, setStatus() {} } },
			);
			return {
				text: (result.content ?? []).map((item) => item.text ?? "").join("\n"),
				details: result.details as { error?: string; code?: string } | undefined,
			};
		},
		/** Launch one live child and return its handle name. */
		async launchLive(name: string) {
			const launched = await this.invoke({
				agent: "worker",
				task: `${name} task`,
				name,
				async: true,
				worktree: false,
			});
			assert.equal(launched.details?.error, undefined, launched.text);
			return name;
		},
		abortCalls() {
			return supervisor.calls.filter((call) => call.method === "abort");
		},
		/**
		 * One param's description exactly as the model-facing schema carries it.
		 *
		 * `SubagentParams` itself is not exported (it would collide with the static
		 * type of the same name), so the schema is read off the registered tool —
		 * which is also the copy a model actually sees.
		 */
		paramDescription(param: string): string {
			const schema = tool.parameters as
				| { properties?: Record<string, { description?: string }> }
				| undefined;
			return schema?.properties?.[param]?.description ?? "";
		},
		async cleanup() {
			await handlers.get("session_shutdown")?.();
			restoreEnv(previous);
			rmSync(cwd, { recursive: true, force: true });
		},
	};
}

test("#314 abort on a live child renders the interrupted receipt and passes no clearQueued", async () => {
	const harness = indexHarness();
	try {
		const name = await harness.launchLive("worker-0");
		const result = await harness.invoke({ action: "abort", name });

		assert.equal(result.text, INTERRUPTED);
		// A soft interrupt is never an error result.
		assert.equal(result.details?.error, undefined);
		const aborts = harness.abortCalls();
		assert.equal(aborts.length, 1);
		assert.equal(aborts[0]?.name, name);
		// Default path: no options object at all, so the supervisor's own default
		// (`clearQueued: true`) stays the single source of truth. `undefined` HERE
		// means "the argument was never passed", which is stronger than an empty
		// object: an empty object would still be the adapter's opinion.
		assert.equal(aborts[0]?.abortOpts, undefined);
		assert.equal(aborts[0]?.clearQueued, undefined);
		// Abort must not retire the child — that is `stop`'s job.
		assert.equal(harness.supervisor.isAlive(name), true);
	} finally {
		await harness.cleanup();
	}
});

test("#314 abort forwards an explicit clearQueued:false", async () => {
	const harness = indexHarness();
	try {
		const name = await harness.launchLive("worker-0");
		harness.supervisor.abortOutcome = outcome("interrupted", {
			steering: 2,
			followUp: 1,
		});
		const result = await harness.invoke({ action: "abort", name, clearQueued: false });

		assert.equal(result.text, INTERRUPTED_DROPPED);
		assert.equal(result.details?.error, undefined);
		const aborts = harness.abortCalls();
		assert.equal(aborts.length, 1);
		// `false` is forwarded as an explicit opt-out — distinguishable from the
		// default path above, which sends nothing.
		assert.equal(aborts[0]?.clearQueued, false);
		assert.deepEqual(aborts[0]?.abortOpts, { clearQueued: false });
	} finally {
		await harness.cleanup();
	}
});

test("#314 the clearQueued param documents itself as abort-only and default-true", async () => {
	const harness = indexHarness();
	try {
		const description = harness.paramDescription("clearQueued");
		// This text is the model's only documentation for the knob, so each
		// fragment is load-bearing: which action owns it, what it drops, and that
		// omitting it means "clear".
		assert.match(description, /abort only:/);
		assert.match(description, /queued steering\/follow-up/);
		assert.match(description, /default true/);
	} finally {
		await harness.cleanup();
	}
});

test("#314 abort reports no-turn as a plain success", async () => {
	const harness = indexHarness();
	try {
		const name = await harness.launchLive("worker-0");
		harness.supervisor.abortOutcome = outcome("no-turn");
		const result = await harness.invoke({ action: "abort", name });

		assert.equal(result.text, NO_TURN);
		assert.equal(result.details?.error, undefined);
		assert.notEqual(result.text, INTERRUPTED);
	} finally {
		await harness.cleanup();
	}
});

test("#314 abort timeout is a success whose receipt points at stop", async () => {
	const harness = indexHarness();
	try {
		const name = await harness.launchLive("worker-0");
		harness.supervisor.abortOutcome = outcome("timeout", {
			steering: 1,
			followUp: 0,
		});
		const result = await harness.invoke({ action: "abort", name });

		assert.match(result.text, /use stop/);
		// A timeout is not a failure and kills nothing: no error code, no retire.
		// These two are redundant guards kept as a cheap cross-check on THIS
		// harness; the canonical proof (timeout resolves, state untouched, child
		// still alive) lives in `abort-supervisor.test.ts`.
		assert.equal(result.details?.error, undefined);
		assert.equal(harness.supervisor.isAlive(name), true);
		assert.equal(
			harness.supervisor.calls.filter((call) => call.method === "retire").length,
			0,
		);
	} finally {
		await harness.cleanup();
	}
});

test("#325 abortReceipt: the timeout receipt names the bound the supervisor really applied", async () => {
	// The tool surface never passes `timeoutMs` (it stays a `wait`-only parameter),
	// so a receipt that formats its OWN default reports a number nobody used. Here
	// the supervisor armed 2.5 s while the tool passed nothing: the receipt has to
	// say 2.5 s, which is only possible because `AbortOutcome` carries the applied
	// bound. On the pre-#325 code this prints "within 5s" and fails.
	const harness = indexHarness();
	try {
		const name = await harness.launchLive("worker-0");
		harness.supervisor.abortOutcome = outcome("timeout", NOTHING_CLEARED, 2_500);
		const result = await harness.invoke({ action: "abort", name });

		assert.match(result.text, /within 2\.5s — /, "the applied bound, not a local default");
		assert.doesNotMatch(result.text, /within 5s/, "the receipt must not fall back to the shared default");
		assert.equal(result.details?.error, undefined);
	} finally {
		await harness.cleanup();
	}
});

test("#314 abort of an unknown name is NOT_FOUND and never reaches the supervisor", async () => {
	const harness = indexHarness();
	try {
		const result = await harness.invoke({ action: "abort", name: "ghost" });
		assert.equal(result.details?.error, ErrorCodes.NOT_FOUND);
		// The lookup answers before the supervisor is ever asked.
		assert.equal(harness.abortCalls().length, 0);
	} finally {
		await harness.cleanup();
	}
});

test("#314 abort reports a supervisor failure as 'abort failed:' + NOT_FOUND", async () => {
	const harness = indexHarness();
	try {
		// A child record this session's supervisor does not know: the store lookup
		// finds it, so the failure surfaces from `abortChild`'s own catch — the
		// only place the `abort failed: ` prefix is produced.
		const runId = "r-abort0001";
		const runDir = path.join(harness.cwd, ".pi-subagents", "runs", runId);
		mkdirSync(runDir, { recursive: true });
		const child: ChildRecord = {
			sessionFile: path.join(runDir, "worker-2.jsonl"),
			ownerToken: "tok-worker-2",
			state: "working",
			spawnedAt: "2026-01-01T00:00:00.000Z",
			agent: "scout",
			kind: "pi",
			name: "worker-2",
		};
		const run: RunRecord = {
			schemaVersion: 1,
			runId,
			task: "t",
			cwd: harness.cwd,
			herdr: { supervisor: "rpc", node_id: "root" },
			path: [],
			depth: 0,
			maxDepth: 3,
			budget: { spawned: 1, limit: null, granted: 0 },
			createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-01-01T00:00:00.000Z",
			children: [child],
		};
		writeFileSync(path.join(runDir, "run.json"), `${JSON.stringify(run, null, "\t")}\n`);

		const result = await harness.invoke({ action: "abort", name: "worker-2" });
		assert.equal(result.details?.error, ErrorCodes.NOT_FOUND);
		assert.ok(
			result.text.startsWith("abort failed:"),
			`expected the abort failure prefix, got: ${result.text}`,
		);
	} finally {
		await harness.cleanup();
	}
});
