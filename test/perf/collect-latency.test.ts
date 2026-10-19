/**
 * Collect latency — the largest measured single-point loss
 * (reports/perf-2026-10-19/REPORT.md, P1).
 *
 * `Orchestrator.collect()` already receives `wait === "settled"` from the
 * supervisor (the child's turn ended), yet then awaits `waitForQuiet`, which
 * polls `statSync(sessionFile)` until the size has been stable for
 * `DEFAULTS.settleQuietMs` (2500ms). Measured on the real Orchestrator against
 * FakeSupervisor: 2509ms of collect time, ~2007ms of it that quiet window.
 *
 * The orchestrator takes injected `now`/`sleep` (see OrchestratorDeps), so this
 * measures the wait precisely on a virtual clock instead of sleeping for real.
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

test("collect() sleeps through the whole settleQuietMs window (P1 dead time)", async () => {
	const h = harness();
	try {
		await h.orchestrator.launch({ agent: agent(), task: "do the thing", name: "worker-0" });
		const before = h.elapsed();
		await h.orchestrator.collect("worker-0");
		const spent = h.elapsed() - before;

		// The turn is already settled when collect() starts, so every virtual ms
		// it sleeps here is pure latency. waitForQuiet alone is worth
		// DEFAULT_settleQuietMs, polled in POLL_INTERVAL_MS increments.
		assert.ok(
			spent >= DEFAULTS.settleQuietMs,
			`collect() slept ${spent}ms, expected at least the ${DEFAULTS.settleQuietMs}ms quiet window`,
		);
		// Pin the observed magnitude so a fix makes this number drop visibly.
		// Seen: 2500 (quiet) + 500 (artifact grace) = 3000.
		assert.ok(spent < 10 * DEFAULTS.settleQuietMs, `collect() slept ${spent}ms, expected a bounded window`);
	} finally {
		h.cleanup();
	}
});
