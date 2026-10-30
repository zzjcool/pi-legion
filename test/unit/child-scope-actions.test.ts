/**
 * #312 at the tool surface: one name must mean one node.
 *
 * The bug: inside a single root session, `status` and `collect` were called
 * seconds apart for the same `worker-0` and answered with two different nodes.
 * `status` walked every run in the store (`pickChildByName`: live first, then
 * newest `createdAt`) while `collect` acted on one run's direct children, and
 * neither said which node it had chosen — so a parent chasing its FAILED child
 * collected another run's SUCCESSFUL one and believed the work was done. `stop`
 * was worse: it picked the same wrong record and reported
 * `No non-retired children to stop.`
 *
 * These tests build that store shape for real (a launched child in the session's
 * own run plus same-named decoys in other runs) and drive the actual tool.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import piLegion from "../../index.ts";
import { RunStore } from "../../src/runs/store.ts";
import { FakeSupervisor } from "../helpers/fake-supervisor.ts";
import { ErrorCodes } from "../../src/shared/types.ts";
import type { ChildRecord } from "../../src/shared/types.ts";

initTheme("dark");

const ENV_KEYS = [
	"PI_CODING_AGENT_DIR",
	"PI_HERDR_SUBAGENTS_EXTRA_AGENT_DIRS",
	"PI_SUBAGENT_CHILD",
	"PI_SUBAGENT_ALLOW_NESTED",
	"PI_LEGION_DB",
	"PI_LEGION_NODE_ID",
	"PI_SUBAGENTS_TEAM",
];

const SCOUT_FILE =
	"---\nname: scout\ndescription: read-only utility role\nutility: true\ntools: read, grep, find, ls\nkind: pi\n---\nscout prompt\n";
const WORKER_FILE =
	"---\nname: worker\ndescription: worker role\n---\nworker prompt\n";

function restoreEnv(previous: Map<string, string | undefined>): void {
	for (const [name, value] of previous) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
}

/**
 * A child record for a decoy run. `state` defaults to a LIVE value on purpose:
 * `pickChildByName` prefers a live record over a retired one, so a live decoy is
 * exactly what the pre-#312 resolver would have handed back.
 */
function childStub(partial: Partial<ChildRecord> & { name: string }): ChildRecord {
	return {
		sessionFile: `/tmp/${partial.name}.jsonl`,
		ownerToken: `tok-${partial.name}`,
		state: "working",
		spawnedAt: "2026-01-01T00:00:00.000Z",
		agent: "worker",
		kind: "pi",
		...partial,
	};
}

/** A session file a decoy could be collected from — distinct text per decoy. */
function writeDecoySession(file: string, text: string): void {
	mkdirSync(path.dirname(file), { recursive: true });
	writeFileSync(
		file,
		`${JSON.stringify({ type: "session", id: "decoy", cwd: "/tmp", created: "2026-01-01T00:00:00.000Z" })}\n` +
			`${JSON.stringify({
				type: "message",
				message: {
					role: "assistant",
					content: [{ type: "text", text }],
					stopReason: "stop",
					model: "test/model",
					usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
				},
			})}\n`,
	);
}

function indexHarness() {
	const cwd = mkdtempSync(path.join(tmpdir(), "legion-child-scope-"));
	const agentDir = path.join(cwd, "agent-config");
	const extraAgentsDir = path.join(cwd, "extra-agents");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(extraAgentsDir, { recursive: true });
	writeFileSync(
		path.join(agentDir, "settings.json"),
		JSON.stringify({ subagents: { disableBuiltins: true } }),
	);
	writeFileSync(path.join(extraAgentsDir, "scout.md"), SCOUT_FILE);
	writeFileSync(path.join(extraAgentsDir, "worker.md"), WORKER_FILE);
	const previous = new Map(ENV_KEYS.map((name) => [name, process.env[name] as string | undefined]));
	const tools = new Map<
		string,
		{ execute: (...args: unknown[]) => Promise<{ content?: Array<{ text?: string }>; details?: unknown }> }
	>();
	const handlers = new Map<string, (...args: unknown[]) => unknown>();
	// Each child answers with its OWN text, so a collect that lands on the wrong
	// node is visible in the output instead of being a same-looking success.
	const supervisor = new FakeSupervisor({
		autoSettle: (input) => ({ text: `{"ok": true, "reason": "own-${input.name}-ok"}` }),
		immediateTimeout: false,
	});
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
	process.env.PI_HERDR_SUBAGENTS_EXTRA_AGENT_DIRS = extraAgentsDir;
	for (const name of ENV_KEYS.slice(2)) delete process.env[name];
	piLegion(pi as never, { supervisor });
	const tool = tools.get("subagent");
	assert.ok(tool);
	const store = new RunStore({ rootDir: path.join(cwd, ".pi-subagents") });
	return {
		cwd,
		store,
		async invoke(params: Record<string, unknown>) {
			const result = await tool.execute(
				"child-scope-actions-test",
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
		/**
		 * A run that is NOT this session's own, carrying `name` in `state`.
		 * Created after the session's run on purpose: the pre-#312 resolver
		 * preferred the newest record, so this decoy is what it would have used.
		 */
		async decoyRun(name: string, state: ChildRecord["state"], output: string) {
			const run = store.createRun({ task: `decoy ${name}`, cwd });
			const sessionFile = path.join(store.runDir(run.runId), `${name}.jsonl`);
			writeDecoySession(sessionFile, output);
			await store.addChild(run.runId, childStub({ name, state, sessionFile }));
			return run.runId;
		},
		/** The run this session owns: the root legion run created by its first launch. */
		sessionRunId(): string {
			const run = store.listRuns().find((candidate) => candidate.nodeId === "root");
			assert.ok(run, "the session's root run should exist after a launch");
			return run.runId;
		},
		async cleanup() {
			await handlers.get("session_shutdown")?.();
			restoreEnv(previous);
			rmSync(cwd, { recursive: true, force: true });
		},
	};
}

test("#312 collect: the session's own worker-0 wins over a live same-named node in another run", async () => {
	const harness = indexHarness();
	try {
		await harness.invoke({
			agent: "worker",
			task: "the real one",
			name: "worker-0",
			async: true,
			worktree: false,
		});
		const ownRunId = harness.sessionRunId();
		const decoyRunId = await harness.decoyRun(
			"worker-0",
			"working",
			'{"ok": false, "reason": "decoy-failed-elsewhere"}',
		);
		assert.notEqual(decoyRunId, ownRunId);

		const collected = await harness.invoke({ action: "collect", name: "worker-0" });
		// The direct child's own result, and nothing from the decoy — the silent
		// wrong-node read is the whole bug.
		assert.match(collected.text, /own-worker-0-ok/);
		assert.doesNotMatch(collected.text, /decoy-failed-elsewhere/);
		assert.match(collected.text, /acceptance: accepted/);
		assert.notEqual(collected.details?.error, ErrorCodes.NOT_FOUND);
	} finally {
		await harness.cleanup();
	}
});

test("#312 collect: a name that is not a direct child is refused with every candidate runId", async () => {
	const harness = indexHarness();
	try {
		// The session owns a run, but no worker-0 in it.
		await harness.invoke({ agent: "worker", task: "other", name: "worker-b", async: true, worktree: false });
		const first = await harness.decoyRun("worker-0", "exited", '{"ok": false, "reason": "one"}');
		const second = await harness.decoyRun("worker-0", "retired", '{"ok": false, "reason": "two"}');

		const collected = await harness.invoke({ action: "collect", name: "worker-0" });
		assert.equal(collected.details?.error, ErrorCodes.NOT_FOUND);
		assert.match(collected.text, /ambiguous/);
		// Both runs named, so the caller can pick one instead of guessing.
		assert.match(collected.text, new RegExp(`run ${first}`));
		assert.match(collected.text, new RegExp(`run ${second}`));
		assert.match(collected.text, /state exited/);
		assert.match(collected.text, /state retired/);
		// A refusal must not look like a result.
		assert.doesNotMatch(collected.text, /acceptance:/);
	} finally {
		await harness.cleanup();
	}
});

test("#312 collect: a unique candidate elsewhere is refused, not silently adopted", async () => {
	const harness = indexHarness();
	try {
		await harness.invoke({ agent: "worker", task: "other", name: "worker-b", async: true, worktree: false });
		const decoy = await harness.decoyRun("worker-0", "exited", '{"ok": false, "reason": "not-mine"}');

		const collected = await harness.invoke({ action: "collect", name: "worker-0" });
		assert.equal(collected.details?.error, ErrorCodes.NOT_FOUND);
		assert.match(collected.text, /not a direct child of this session/);
		assert.match(collected.text, new RegExp(`run ${decoy}`));
		// The two levers the caller actually has are named.
		assert.match(collected.text, /runId/);
		assert.match(collected.text, /parent/);
		assert.doesNotMatch(collected.text, /not-mine/);
	} finally {
		await harness.cleanup();
	}
});

test("#312 status: two same-named candidates elsewhere is an ambiguity, not a pick", async () => {
	const harness = indexHarness();
	try {
		await harness.invoke({ agent: "worker", task: "other", name: "worker-b", async: true, worktree: false });
		const first = await harness.decoyRun("worker-0", "exited", "one");
		const second = await harness.decoyRun("worker-0", "retired", "two");

		const status = await harness.invoke({ action: "status", name: "worker-0" });
		assert.equal(status.details?.error, ErrorCodes.NOT_FOUND);
		assert.match(status.text, /ambiguous/);
		assert.match(status.text, new RegExp(`run ${first}`));
		assert.match(status.text, new RegExp(`run ${second}`));
		assert.doesNotMatch(status.text, /state=/);
	} finally {
		await harness.cleanup();
	}
});

test("#312 status: a unique candidate elsewhere is shown, but marked as not a direct child", async () => {
	const harness = indexHarness();
	try {
		await harness.invoke({ agent: "worker", task: "other", name: "worker-b", async: true, worktree: false });
		const decoy = await harness.decoyRun("worker-0", "exited", "one");

		const status = await harness.invoke({ action: "status", name: "worker-0" });
		assert.notEqual(status.details?.error, ErrorCodes.NOT_FOUND);
		// The frozen wording: the annotation is the whole point of showing it.
		assert.match(
			status.text,
			new RegExp(
				`resolved: worker-0 is not a direct child of this session — showing the record from run ${decoy}`,
			),
		);
		// The record itself still renders.
		assert.match(status.text, /worker-0 — state=exited/);
	} finally {
		await harness.cleanup();
	}
});

test("#312 status: a direct child renders exactly as before — no new note", async () => {
	const harness = indexHarness();
	try {
		await harness.invoke({ agent: "worker", task: "the real one", name: "worker-0", async: true, worktree: false });
		await harness.decoyRun("worker-0", "working", "decoy");

		const status = await harness.invoke({ action: "status", name: "worker-0" });
		assert.notEqual(status.details?.error, ErrorCodes.NOT_FOUND);
		// Rule 3 of the frozen design: a direct hit adds no noise.
		assert.doesNotMatch(status.text, /not a direct child/);
		assert.doesNotMatch(status.text, /resolved:/);
		assert.match(status.text, /worker-0 — state=/);
	} finally {
		await harness.cleanup();
	}
});

test("#312 stop: a same-named record elsewhere says so instead of 'No non-retired children to stop.'", async () => {
	const harness = indexHarness();
	try {
		await harness.invoke({ agent: "worker", task: "other", name: "worker-b", async: true, worktree: false });
		const decoy = await harness.decoyRun("worker-0", "retired", "one");

		const stopped = await harness.invoke({ action: "stop", name: "worker-0" });
		assert.equal(stopped.details?.error, ErrorCodes.NOT_FOUND);
		assert.match(stopped.text, /not a direct child of this session/);
		assert.match(stopped.text, new RegExp(`run ${decoy}`));
		// The masking the issue reported.
		assert.doesNotMatch(stopped.text, /No non-retired children to stop/);
	} finally {
		await harness.cleanup();
	}
});

test("#312 continue: a same-named record elsewhere is refused, not steered", async () => {
	const harness = indexHarness();
	try {
		await harness.invoke({ agent: "worker", task: "other", name: "worker-b", async: true, worktree: false });
		const decoy = await harness.decoyRun("worker-0", "exited", '{"ok": false, "reason": "not-mine"}');

		const continued = await harness.invoke({
			action: "continue",
			name: "worker-0",
			message: "try again",
		});
		assert.equal(continued.details?.error, ErrorCodes.NOT_FOUND);
		assert.match(continued.text, /not a direct child of this session/);
		assert.match(continued.text, new RegExp(`run ${decoy}`));
		assert.doesNotMatch(continued.text, /Resumed|Continued|failed: /);
	} finally {
		await harness.cleanup();
	}
});

test("#312 runId: an explicit scope reaches the run the caller names", async () => {
	const harness = indexHarness();
	try {
		await harness.invoke({ agent: "worker", task: "other", name: "worker-b", async: true, worktree: false });
		const scoped = await harness.decoyRun("worker-0", "exited", "one");
		const other = await harness.decoyRun("worker-0", "working", "two");

		// Without a scope the same call is ambiguous, so the caller has to pick.
		const ambiguous = await harness.invoke({ action: "status", name: "worker-0" });
		assert.equal(ambiguous.details?.error, ErrorCodes.NOT_FOUND);
		assert.match(ambiguous.text, /ambiguous/);

		// With `runId` the named run's record IS the scoped child, so `status` shows
		// it with no "not a direct child" note — that is what the escape hatch is for.
		const status = await harness.invoke({ action: "status", name: "worker-0", runId: scoped });
		assert.notEqual(status.details?.error, ErrorCodes.NOT_FOUND);
		assert.match(status.text, /worker-0 — state=exited/);
		assert.doesNotMatch(status.text, /not a direct child/);
		assert.doesNotMatch(status.text, /ambiguous/);
		assert.match(status.text, new RegExp(`runs/${scoped}/worker-0\\.jsonl`));
		assert.doesNotMatch(status.text, new RegExp(`runs/${other}/worker-0\\.jsonl`));
	} finally {
		await harness.cleanup();
	}
});
