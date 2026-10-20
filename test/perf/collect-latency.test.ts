/**
 * Collect latency — the largest measured single-point loss
 * (reports/perf-2026-10-19/REPORT.md, P1).
 *
 * Fixed in #232. `collect()` used to receive `wait === "settled"` from the
 * supervisor and then still await `waitForQuiet`, polling
 * `statSync(sessionFile)` until the size had been stable for
 * `DEFAULTS.settleQuietMs` (2500ms): 2509ms of collect time, ~2007ms of it that
 * quiet window. The wait is gone; these cases now assert it stays gone.
 *
 * The orchestrator takes injected `now`/`sleep` (see OrchestratorDeps), so the
 * latency is measured on a virtual clock instead of sleeping for real.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { Orchestrator } from "../../src/runs/orchestrator.ts";
import { DEFAULTS, type AgentConfig } from "../../src/shared/types.ts";
import { parseSessionFile } from "../../src/shared/session.ts";
import { FakeSupervisor } from "../helpers/fake-supervisor.ts";

function agent(over: Partial<AgentConfig> = {}): AgentConfig {
	return {
		name: "worker",
		description: "test agent",
		systemPromptMode: "append",
		inheritProjectContext: true,
		inheritSkills: false,
		kind: "pi",
		systemPrompt: "You are a test agent.",
		source: "user",
		filePath: "/fake/worker.md",
		...over,
	};
}

interface Harness {
	runDir: string;
	orchestrator: Orchestrator;
	/** Virtual milliseconds consumed by sleeps since construction. */
	elapsed: () => number;
	cleanup(): void;
}

function harness(): Harness {
	const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "legion-collect-"));
	const supervisor = new FakeSupervisor({ autoSettle: { text: "done", stopReason: "stop" } });
	let clock = 0;
	let slept = 0;
	const orchestrator = new Orchestrator({
		supervisor,
		runDir,
		cwd: "/tmp/project",
		now: () => clock,
		sleep: async (ms) => { clock += ms; slept += ms; },
	});
	return {
		runDir,
		orchestrator,
		elapsed: () => slept,
		cleanup() { fs.rmSync(runDir, { recursive: true, force: true }); },
	};
}

test("the settled session is already terminal before the quiet wait runs", async () => {
	const h = harness();
	try {
		await h.orchestrator.launch({ agent: agent(), task: "do the thing", name: "worker-0" });
		await h.orchestrator.collect("worker-0");
		const sessionFile = path.join(h.runDir, "worker-0.jsonl");
		assert.ok(fs.existsSync(sessionFile), "the fake supervisor writes a real session JSONL");
		const parsed = parseSessionFile(sessionFile);
		const last = parsed.turns.at(-1)?.assistants?.at(-1);
		assert.equal(last?.stopReason, "stop", "the last assistant message is terminally complete");
		assert.equal(parsed.lastTurnMissing, false);
	} finally {
		h.cleanup();
	}
});

test("collect() no longer waits for a quiet window after the turn settled (#232)", async () => {
const h = harness();
try {
await h.orchestrator.launch({ agent: agent(), task: "do the thing", name: "worker-0" });
const before = h.elapsed();
await h.orchestrator.collect("worker-0");
const spent = h.elapsed() - before;

// Regression guard for #232: the old implementation slept the full
// settleQuietMs window (2500ms) here even though `waitSettled` had already
// reported the turn complete. The guard is deliberately far below that (and
// below the 50ms growth-sampling step #232 ② introduced), so any wait
// reintroduced on the settled path trips it — a `< settleQuietMs` bound
// would still pass with 2.4s of new sleep.
assert.equal(
spent,
0,
`collect() burned ${spent}ms of sleeps on an already-settled turn; the settled path must not sleep at all (#232)`,
);
} finally {
h.cleanup();
}
});
