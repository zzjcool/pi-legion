/**
 * #344 at the tool surface: a control call must not scan the run registry to find
 * a child it is already scoped to.
 *
 * `index.ts` used to open every control action with `store.listRuns()` — 26ms at
 * the 352 runs this machine has, 97% of a warm `status`, and linear in the number
 * of runs ever written — before it even asked which run the call was scoped to.
 * These tests drive the real `subagent` tool and count `RunStore.listRuns` calls,
 * because "the scan moved behind a fallback" is exactly the kind of claim that
 * silently regresses the moment another branch reintroduces it on the way in.
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

const WORKER_FILE =
	"---\nname: worker\ndescription: worker role\n---\nworker prompt\n";

/** Count `listRuns()` calls made by ANY `RunStore` instance while installed. */
function spyListRuns(): { readonly calls: number; restore(): void } {
	const proto = RunStore.prototype;
	const original = proto.listRuns;
	let calls = 0;
	proto.listRuns = function patchedListRuns(this: RunStore) {
		calls += 1;
		return original.call(this);
	};
	return {
		get calls() {
			return calls;
		},
		restore() {
			proto.listRuns = original;
		},
	};
}

function indexHarness() {
	const cwd = mkdtempSync(path.join(tmpdir(), "legion-control-scan-"));
	const agentDir = path.join(cwd, "agent-config");
	const extraAgentsDir = path.join(cwd, "extra-agents");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(extraAgentsDir, { recursive: true });
	writeFileSync(
		path.join(agentDir, "settings.json"),
		JSON.stringify({ subagents: { disableBuiltins: true } }),
	);
	writeFileSync(path.join(extraAgentsDir, "worker.md"), WORKER_FILE);
	const previous = new Map(ENV_KEYS.map((name) => [name, process.env[name] as string | undefined]));
	const tools = new Map<
		string,
		{ execute: (...args: unknown[]) => Promise<{ content?: Array<{ text?: string }>; details?: unknown }> }
	>();
	const handlers = new Map<string, (...args: unknown[]) => unknown>();
	const supervisor = new FakeSupervisor({
		autoSettle: { text: '{"ok": true, "reason": "done"}' },
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
				"control-scope-scan-test",
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
		/** The run this session owns: its legion root run. */
		sessionRunId(): string {
			const run = store.listRuns().find((candidate) => candidate.nodeId === "root");
			assert.ok(run, "the session's root run should exist after a launch");
			return run.runId;
		},
		/**
		 * A launch that really lands in `run.json`, so the control call below has a
		 * direct child to resolve — the case that must not scan.
		 */
		async launchChild(name: string) {
			await this.invoke({ agent: "worker", task: "do the thing", name, async: true, worktree: false });
			const runId = this.sessionRunId();
			const record = store.readRun(runId)?.children.find((candidate) => candidate.name === name);
			assert.ok(record, `${name} should be persisted in the session run`);
			return { runId, record };
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

test("#344 collect: an explicit runId hit is resolved WITHOUT scanning the registry", async () => {
	const harness = indexHarness();
	try {
		const { runId } = await harness.launchChild("worker-0");
		const spy = spyListRuns();
		let collected: { text: string; details?: { error?: string } };
		try {
			collected = await harness.invoke({ action: "collect", name: "worker-0", runId });
		} finally {
			spy.restore();
		}
		assert.equal(collected.details?.error, undefined, "the collect itself still has to work");
		assert.equal(spy.calls, 0, "a known runId must not pay for `listRuns`");
		assert.match(collected.text, /worker-0/);
	} finally {
		await harness.cleanup();
	}
});

test("#344 status: the session's own child resolves without scanning the registry", async () => {
	const harness = indexHarness();
	try {
		const { runId } = await harness.launchChild("worker-0");
		const spy = spyListRuns();
		let status: { text: string; details?: { error?: string } };
		try {
			// No explicit runId: the scope comes from the session's legion run, which
			// is the ordinary case for everything a parent launched itself.
			status = await harness.invoke({ action: "status", name: "worker-0" });
		} finally {
			spy.restore();
		}
		assert.equal(status.details?.error, undefined, "the status must render, not fail");
		assert.equal(spy.calls, 0, "the session-scoped child must resolve from one readRun");
		assert.match(status.text, /worker-0 — state=/);
	} finally {
		await harness.cleanup();
	}
});

test("#344 status: a name that is in no scope run still scans the registry (fallback intact)", async () => {
	const harness = indexHarness();
	try {
		await harness.launchChild("worker-0");
		const spy = spyListRuns();
		let status: { text: string; details?: { error?: string } };
		try {
			status = await harness.invoke({ action: "status", name: "nobody-here" });
		} finally {
			spy.restore();
		}
		// At least the resolver's own scan: a name in no scope run can only be
		// answered by looking at every run (#270's cross-store lookup may then look
		// again, which is why this is a floor rather than an exact count).
		assert.ok(spy.calls >= 1, "the fallback scan is the only way to answer 'absent'");
		// #312/#209-3 wording is unchanged: it is a miss, not a silent pick.
		assert.match(status.text, /unknown child/i);
		assert.match(status.text, /nobody-here/);
	} finally {
		await harness.cleanup();
	}
});
