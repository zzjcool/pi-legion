/**
 * Index-layer tests for the wait action.
 *
 * resolveWaitTargets itself is covered by wait-action.test.ts; these lock
 * the wiring around it: the finished-cache probe that lets a just-finished
 * child stay waitable, the strictest-role default timeout (min, not max),
 * and the renderWait summary line. waitAction/renderWait are exported from
 * index.ts precisely so this file can drive them without a fake herdr.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { buildWaitTimeoutDetails, renderWait, stopAction, waitAction, WAIT_PARENT_DECISIONS, WAIT_TIMEOUT_HINT } from "../../index.ts";
import {
	createSessionRuntime,
	type CollectSnapshot,
	type SessionRuntime,
	type WaitResult,
} from "../../src/extension/runtime.ts";
import { RunStore } from "../../src/runs/store.ts";
import { DEFAULTS, type AgentConfig } from "../../src/shared/types.ts";

function snapshot(output: string): CollectSnapshot {
	return {
		execution: { status: "success" },
		output,
		acceptance: { status: "accepted", level: "attested" },
	};
}

function agent(name: string, timeoutMs?: number): AgentConfig {
	return {
		name,
		description: `${name} role`,
		source: "user",
		...(timeoutMs !== undefined ? { timeoutMs } : {}),
	} as AgentConfig;
}

function runtimeWith(jobs: Array<{ name: string; agent: string }>): SessionRuntime {
	const runtime = createSessionRuntime({ sendMessage() {} });
	for (const job of jobs) {
		runtime.track({
			name: job.name,
			runId: "r-1",
			agent: job.agent,
			sessionFile: `/tmp/${job.name}.jsonl`,
			timeoutMs: 1_000,
			// Never resolves: wait() must bail at its own timeout.
			collect: () => new Promise<CollectSnapshot>(() => {}),
		});
	}
	return runtime;
}

function tempStore(): { store: RunStore; cwd: string } {
	const cwd = mkdtempSync(path.join(tmpdir(), "wait-action-"));
	return { store: new RunStore({ rootDir: path.join(cwd, ".pi-subagents") }), cwd };
}

function text(result: { content?: unknown }): string {
	return (result.content as Array<{ text?: string }>)
		.map((c) => c.text ?? "")
		.join("\n");
}

test("waitAction: a finished child is waitable via the finished-cache probe", async () => {
	const runtime = createSessionRuntime({ sendMessage() {} });
	runtime.track({
		name: "done",
		runId: "r-1",
		agent: "worker",
		sessionFile: "/tmp/done.jsonl",
		timeoutMs: 1_000,
		collect: async () => snapshot("cached-output"),
	});
	runtime.watch("done");
	const deadline = Date.now() + 1_000;
	while (runtime.activeJobs().length > 0) {
		if (Date.now() > deadline) throw new Error("watch never settled");
		await new Promise((r) => setTimeout(r, 5));
	}
	// The name is no longer live — resolveWaitTargets misses it — but the
	// finished cache must rescue it instead of reporting an unknown child.
	const { store, cwd } = tempStore();
	const res = await waitAction({
		params: { action: "wait", name: "done" },
		runtime,
		agents: [agent("worker")],
		store,
		cwd,
	});
	assert.match(text(res), /── done ──/);
	assert.match(text(res), /cached-output/);
	assert.match(text(res), /1 done, 0 still running/);
	assert.doesNotMatch(text(res), /unknown child/);
});

test("waitAction: an untracked name with no cache is a loud unknown child", async () => {
	const runtime = runtimeWith([{ name: "live", agent: "worker" }]);
	const { store, cwd } = tempStore();
	const res = await waitAction({
		params: { action: "wait", name: "ghost" },
		runtime,
		agents: [agent("worker")],
		store,
		cwd,
	});
	const details = res.details as { error?: string } | undefined;
	assert.equal(details?.error, "NOT_FOUND");
	assert.match(text(res), /unknown child: ghost/);
	runtime.dispose();
});

test("waitAction: default timeout is the strictest (smallest) role timeout", async () => {
	const calls: Array<{ names: string[]; timeoutMs?: number }> = [];
	const base = runtimeWith([
		{ name: "fast", agent: "worker" },
		{ name: "slow", agent: "oracle" },
	]);
	// Spy on the timeout handed to runtime.wait: min(80, 60_000) = 80.
	const runtime: SessionRuntime = {
		...base,
		wait: (names, opts) => {
			calls.push({ names, timeoutMs: opts?.timeoutMs });
			return Promise.resolve(
				names.map((name) => ({ name, stillRunning: true }) as WaitResult),
			);
		},
	};
	const { store, cwd } = tempStore();
	const res = await waitAction({
		params: { action: "wait", all: true },
		runtime,
		agents: [agent("worker", 80), agent("oracle", 60_000)],
		store,
		cwd,
	});
	assert.equal(calls.length, 1);
	assert.equal(calls[0]?.timeoutMs, 80, "min, not max, of role timeouts");
	assert.match(text(res), /0 done, 2 still running/);
	base.dispose();
});

test("waitAction forwards the parent abort signal into runtime.wait", async () => {
	const base = runtimeWith([{ name: "live", agent: "worker" }]);
	const controller = new AbortController();
	const calls: Array<{ names: string[]; signal?: AbortSignal }> = [];
	const runtime: SessionRuntime = {
		...base,
		wait: (names, opts) => {
			calls.push({ names, signal: opts?.signal });
			return Promise.resolve(names.map((name) => ({ name, interrupted: true })));
		},
	};
	const { store, cwd } = tempStore();
	await waitAction({
		params: { action: "wait", name: "live" },
		signal: controller.signal,
		runtime,
		agents: [agent("worker")],
		store,
		cwd,
	});
	assert.equal(calls.length, 1);
	assert.deepEqual(calls[0], { names: ["live"], signal: controller.signal });
	base.dispose();
});

test("waitAction: targets without a role entry fall back to DEFAULTS.turnTimeoutMs", async () => {
	const calls: Array<{ names: string[]; timeoutMs?: number }> = [];
	const base = runtimeWith([{ name: "mystery", agent: "no-such-role" }]);
	const runtime: SessionRuntime = {
		...base,
		wait: (names, opts) => {
			calls.push({ names, timeoutMs: opts?.timeoutMs });
			return Promise.resolve(
				names.map((name) => ({ name, stillRunning: true }) as WaitResult),
			);
		},
	};
	const { store, cwd } = tempStore();
	const res = await waitAction({
		params: { action: "wait", all: true },
		runtime,
		agents: [agent("worker", 80)],
		store,
		cwd,
	});
	assert.equal(calls.length, 1);
	assert.equal(calls[0]?.timeoutMs, DEFAULTS.turnTimeoutMs);
	assert.match(text(res), /0 done, 1 still running/);
	base.dispose();
});

test("stopAction: all retires active children sequentially and releases each target", async () => {
	const runtime = runtimeWith([
		{ name: "first", agent: "worker" },
		{ name: "already-retired", agent: "worker" },
		{ name: "second", agent: "worker" },
	]);
	runtime.get("already-retired")!.state = "retired";
	const supervisorCalls: string[] = [];
	let retiring = false;
	const supervisor = {
		async retire(name: string) {
			assert.equal(retiring, false, "stop must await each retirement before starting the next");
			retiring = true;
			await Promise.resolve();
			supervisorCalls.push(name);
			retiring = false;
		},
	};
	const result = await stopAction({
		params: { all: true },
		runtime,
		retire: (name) => supervisor.retire(name),
	});
	assert.deepEqual(supervisorCalls, ["first", "second"]);
	assert.deepEqual(runtime.activeJobs().map((job) => job.name), ["already-retired"]);
	assert.match(text(result), /Stopped 2 children/);
	runtime.dispose();
});

test("renderWait: summary line counts done and still-running", () => {
	const rendered = renderWait([
		{ name: "a", snapshot: snapshot("A-out") },
		{ name: "b", stillRunning: true, elapsedMs: 42 },
		{ name: "c", missing: true },
	]);
	assert.match(rendered, /── a ──/);
	assert.match(rendered, /A-out/);
	assert.match(rendered, /── b ──\nstill running \(elapsed 42ms\)/);
	assert.match(rendered, /── c ──\nnot tracked/);
	assert.match(rendered, /1 done, 1 still running/);
	assert.match(rendered, /status: still_running/);
	assert.match(rendered, /decisions: extend, steer_again, stop, force_stop/);
	const interrupted = renderWait([{ name: "wait", interrupted: true }]);
	assert.match(interrupted, /── wait ──\ninterrupted \(parent turn ended; children still running\)/);
	assert.match(interrupted, /0 done, 0 still running/);
	assert.match(interrupted, /1 interrupted/);
	assert.doesNotMatch(interrupted, /status:/);
});

test("buildWaitTimeoutDetails: wait_timeout includes decisions and does not imply stop", () => {
	const details = buildWaitTimeoutDetails([
		{ name: "done", snapshot: snapshot("ok") },
		{ name: "live", stillRunning: true, timedOut: true, elapsedMs: 12_345 },
	]);
	assert.ok(details);
	assert.equal(details!.status, "wait_timeout");
	assert.equal(details!.done, 1);
	assert.deepEqual(details!.stillRunning, [{ name: "live", elapsedMs: 12_345 }]);
	assert.deepEqual(details!.decisions, [...WAIT_PARENT_DECISIONS]);
	assert.equal(details!.hint, WAIT_TIMEOUT_HINT);
});

test("buildWaitTimeoutDetails: still_running when no timedOut flag", () => {
	const details = buildWaitTimeoutDetails([
		{ name: "live", stillRunning: true, elapsedMs: 100 },
	]);
	assert.equal(details?.status, "still_running");
});

test("buildWaitTimeoutDetails: undefined when nothing still running", () => {
	assert.equal(
		buildWaitTimeoutDetails([{ name: "a", snapshot: snapshot("x") }]),
		undefined,
	);
});

test("waitAction: timeout details land in tool details (no auto-stop)", async () => {
	const base = runtimeWith([{ name: "live", agent: "worker" }]);
	const runtime: SessionRuntime = {
		...base,
		wait: (names) =>
			Promise.resolve(
				names.map(
					(name) =>
						({
							name,
							stillRunning: true,
							timedOut: true,
							elapsedMs: 500,
						}) as WaitResult,
				),
			),
	};
	const { store, cwd } = tempStore();
	const res = await waitAction({
		params: { action: "wait", name: "live", timeoutMs: 50 },
		runtime,
		agents: [agent("worker")],
		store,
		cwd,
	});
	const details = res.details as {
		status?: string;
		stillRunning?: Array<{ name: string; elapsedMs: number }>;
		decisions?: string[];
		hint?: string;
	};
	assert.equal(details.status, "wait_timeout");
	assert.deepEqual(details.stillRunning, [{ name: "live", elapsedMs: 500 }]);
	assert.deepEqual(details.decisions, [...WAIT_PARENT_DECISIONS]);
	assert.equal(details.hint, WAIT_TIMEOUT_HINT);
	assert.match(text(res), /status: wait_timeout/);
	assert.match(text(res), /decisions: extend, steer_again, stop, force_stop/);
	assert.match(text(res), /hint: wait does not stop children/);
	// Children stay tracked — wait must not retire.
	assert.ok(runtime.get("live"));
	base.dispose();
});

test("stopAction: force:true passes graceful:false to retire", async () => {
	const runtime = runtimeWith([{ name: "stubborn", agent: "worker" }]);
	const calls: Array<{ name: string; opts?: { graceful?: boolean } }> = [];
	const result = await stopAction({
		params: { name: "stubborn", force: true },
		runtime,
		retire: async (name, opts) => {
			calls.push({ name, opts });
		},
	});
	assert.deepEqual(calls, [{ name: "stubborn", opts: { graceful: false } }]);
	assert.match(text(result), /force-stopped 1 child: stubborn/);
	assert.equal(runtime.get("stubborn"), undefined);
	runtime.dispose();
});

test("stopAction: omit force keeps graceful default (no graceful:false)", async () => {
	const runtime = runtimeWith([{ name: "soft", agent: "worker" }]);
	const calls: Array<{ name: string; opts?: { graceful?: boolean } }> = [];
	await stopAction({
		params: { name: "soft" },
		runtime,
		retire: async (name, opts) => {
			calls.push({ name, opts });
		},
	});
	assert.deepEqual(calls, [{ name: "soft", opts: undefined }]);
	runtime.dispose();
});
