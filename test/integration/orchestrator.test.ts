import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { COLLECT_DEADLINE_REASON, CONTINUE_PROMPT, Orchestrator, preCreateSessionFile, TRANSIENT_CONNECTION_REASON } from "../../src/runs/orchestrator.ts";
import { ErrorCodes, SubagentError, type AgentConfig } from "../../src/shared/types.ts";
import { FakeSupervisor, type FakeTurn } from "../helpers/fake-supervisor.ts";
import { RunStore } from "../../src/runs/store.ts";
import { assistantMsg, userMsg } from "../helpers/fixtures.ts";

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

function tempDir(prefix: string): string {
	return mkdtempSync(path.join(tmpdir(), prefix));
}

function harness(options: ConstructorParameters<typeof FakeSupervisor>[0] = {}) {
	const runDir = tempDir("rpc-orchestrator-");
	const supervisor = new FakeSupervisor(options);
	let clock = 0;
	const orchestrator = new Orchestrator({
		supervisor,
		runDir,
		cwd: "/tmp/project",
		now: () => clock,
		sleep: async (ms) => { clock += ms; },
	});
	return {
		runDir,
		supervisor,
		orchestrator,
		cleanup: () => rmSync(runDir, { recursive: true, force: true }),
	};
}

test("preCreateSessionFile is idempotent and leaves an empty private session file", () => {
	const root = tempDir("rpc-precreate-");
	try {
		const file = path.join(root, "nested", "session.jsonl");
		preCreateSessionFile(file);
		assert.equal(existsSync(file), true);
		assert.equal(statSync(file).size, 0);
		writeFileSync(file, "existing\n");
		preCreateSessionFile(file);
		assert.equal(readFileSync(file, "utf8"), "existing\n");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("RPC launch builds the Pi argv, records lineage/budgets, and stores a real owner token", async () => {
	const h = harness();
	h.orchestrator = new Orchestrator({
		supervisor: h.supervisor,
		runDir: h.runDir,
		cwd: "/tmp/project",
		team: { name: "frontend", source: "settings" },
		now: () => 0,
		sleep: async () => {},
	});
	try {
		const handle = await h.orchestrator.launch({
			agent: agent({
				tools: ["read", "bash"],
				allowNestedSubagents: true,
				toolBudget: { maxToolCalls: 12 },
				turnBudget: { maxTurns: 4 },
				toolTimeoutMs: 2_000,
				acceptance: { level: "attested", role: "read-only" },
			}),
			task: "inspect the project",
			model: "anthropic/claude-sonnet-4",
		});
		const spawn = h.supervisor.spawns[0];
		assert.ok(spawn);
		assert.deepEqual(handle.child, h.orchestrator.childrenSnapshot()[0]);
		assert.ok(handle.child.ownerToken.length > 0);
		assert.equal(handle.sessionFile, path.join(h.runDir, `${handle.name}.jsonl`));
		assert.deepEqual(spawn.input.agent.kind, "pi");
		assert.ok(spawn.args.includes("--session"));
		assert.ok(spawn.args.includes(handle.sessionFile));
		assert.ok(spawn.args.includes("--model"));
		assert.ok(spawn.args.includes("anthropic/claude-sonnet-4"));
		assert.ok(spawn.args.includes("--tools"));
		// REV-17.7 §2.7: non-utility allowlists include the separate recon tool.
		assert.ok(spawn.args.includes("read,bash,vexillatio"));
		assert.ok(spawn.args.includes("--extension"));
		assert.equal(spawn.args.some((arg) => arg.startsWith("@")), false, "RPC task is sent over prompt, not argv");
		assert.equal(spawn.input.env?.PI_SUBAGENT_CHILD, "1");
		assert.equal(spawn.input.env?.PI_SUBAGENT_MAX_TOOL_CALLS, "12");
		assert.equal(spawn.input.env?.PI_SUBAGENT_MAX_TURNS, "4");
		assert.equal(spawn.input.env?.PI_SUBAGENT_TOOL_TIMEOUT_MS, "2000");
		assert.equal(spawn.input.env?.PI_SUBAGENT_ACCEPTANCE_ROLE, "read-only");
		assert.equal(spawn.input.env?.PI_SUBAGENTS_TEAM, "frontend");
		assert.equal(JSON.parse(spawn.input.env?.PI_SUBAGENT_PARENT_PATH ?? "[]").length, 1);
		assert.equal(h.supervisor.calls.some((call) => call.method === "spawnChild"), true);
	} finally {
		h.cleanup();
	}
});

test("U7: a growing session artifact extends the RPC collect deadline", async () => {
	// #232 removed collect()'s settle-quiet wait, which used to inflate the total
	// virtual time and made a `spent > timeoutMs` assertion pass for the wrong
	// reason. #232 ② then turned the growth window from one flat 500ms sleep into
	// 50ms sampling, so a bare wall-clock assertion would again be measuring poll
	// rhythm. This pins both: the deadline extension the fixture is about, and the
	// early return ② added.
	const runDir = tempDir("rpc-orchestrator-growing-");
	const supervisor = new FakeSupervisor({ immediateTimeout: true });
	let clock = 0;
	let sessionFile = "";
	let grewDuringFirstPoll = false;
	const timeoutMs = 1_000;
	const orchestrator = new Orchestrator({
		supervisor,
		runDir,
		cwd: "/tmp/project",
		now: () => clock,
		sleep: async (ms) => {
			clock += ms;
			if (grewDuringFirstPoll) return;
			grewDuringFirstPoll = true;
			appendFileSync(sessionFile, `${userMsg("still writing progress")}\n`);
		},
	});
	try {
		const handle = await orchestrator.launch({ agent: agent(), task: "long response", worktree: false });
		sessionFile = handle.sessionFile;
		const startedAt = clock;
		const result = await orchestrator.collect(handle.name, { timeoutMs });

		// The child never settled, so the collect reports it as still running...
		assert.equal(result.execution.status, "running");
		// ...but the growth granted a second RPC wait past the first timeout.
		assert.equal(grewDuringFirstPoll, true);
		const waits = supervisor.calls.filter((call) => call.method === "waitSettled").map((call) => call.timeoutMs ?? 0);
		assert.equal(waits.length, 2, "growth grants exactly one more RPC wait; the next window saw no growth");
		const firstBudget = waits[0] as number;
		const secondBudget = waits[1] as number;
		assert.equal(firstBudget, timeoutMs, "the first wait gets the collect budget");
		// The second budget is the re-armed deadline minus the virtual time already
		// spent. Before #232 ② the caller had already burned a flat 500ms growth
		// window, so the extension bought only 500ms of extra budget; returning as
		// soon as the artifact grew leaves nearly the whole extra timeout.
		assert.ok(
			secondBudget - firstBudget >= timeoutMs * 0.9,
			`the extension must add a full timeout to the deadline: first wait ${firstBudget}ms, second ${secondBudget}ms`,
		);
		// Total virtual time, bounded rather than pinned: an exact sum is a function
		// of ARTIFACT_GROWTH_POLL_MS + POLL_INTERVAL_MS, and a legitimate retune of
		// either constant must not break a test that is not about them. The real
		// discrimination is the extension-budget assertion above; this bound just
		// catches a return to the pre-#232 rhythm. Observed after the fix: 550ms;
		// pre-#232: 1000ms.
		assert.ok(
			clock - startedAt <= timeoutMs * 0.9,
			`the growth window cost ${clock - startedAt}ms of virtual time; #232 ② returns as soon as growth is seen, so it must stay well under the ${timeoutMs}ms timeout`,
		);
	} finally {
		rmSync(runDir, { recursive: true, force: true });
	}
});

test("collect: parent abort returns a running snapshot and leaves the child alive", async () => {
	const h = harness({ immediateTimeout: false });
	try {
		const handle = await h.orchestrator.launch({ agent: agent(), task: "continue after parent abort", worktree: false });
		const controller = new AbortController();
		const pending = h.orchestrator.collect(handle.name, {
			timeoutMs: 60_000,
			signal: controller.signal,
		});
		controller.abort();
		const collected = await pending;
		assert.equal(collected.execution.status, "running");
		assert.equal(collected.execution.reason, "aborted by parent");
		assert.equal(collected.acceptance.reason, "aborted by parent");
		assert.equal(h.supervisor.isAlive(handle.name), true, "ESC abort must not retire the child");
		assert.equal(h.orchestrator.childrenSnapshot()[0]?.state, "working");
		h.supervisor.settle(handle.name, { text: "child still completed" });
	} finally {
		h.cleanup();
	}
});

test("collect finishing after explicit retire does not demote the child from retired", async () => {
	const h = harness({ immediateTimeout: false });
	let releaseSettle: () => void = () => {};
	const settleGate = new Promise<void>((resolve) => { releaseSettle = resolve; });
	const waitSettled = h.supervisor.waitSettled.bind(h.supervisor);
	h.supervisor.waitSettled = async (name, timeoutMs) => {
		const result = await waitSettled(name, timeoutMs);
		await settleGate;
		return result;
	};
	try {
		const handle = await h.orchestrator.launch({ agent: agent(), task: "retire during collect", worktree: false });
		const collecting = h.orchestrator.collect(handle.name, { timeoutMs: 60_000 });
		assert.ok(h.supervisor.calls.some((call) => call.method === "waitSettled" && call.name === handle.name));
		const retired = await h.orchestrator.retire(handle.name);
		assert.equal(retired.state, "retired");
		releaseSettle();
		const collected = await collecting;
		assert.equal(collected.execution.status, "aborted");
		assert.equal(h.orchestrator.childrenSnapshot()[0]?.state, "retired");
	} finally {
		releaseSettle();
		h.cleanup();
	}
});

test("an in-flight collect does not overwrite retired state after explicit retire", async () => {
	const h = harness({ immediateTimeout: false });
	let waitStartedResolve!: () => void;
	const waitStarted = new Promise<void>((resolve) => { waitStartedResolve = resolve; });
	const waitForSettle = h.supervisor.waitSettled.bind(h.supervisor);
	h.supervisor.waitSettled = async (name, timeoutMs) => {
		const pending = waitForSettle(name, timeoutMs);
		waitStartedResolve();
		return pending;
	};
	try {
		const handle = await h.orchestrator.launch({ agent: agent(), task: "retire during collect", worktree: false });
		const collecting = h.orchestrator.collect(handle.name, { timeoutMs: 60_000 });
		await waitStarted;
		const retired = await h.orchestrator.retire(handle.name);
		assert.equal(retired.state, "retired");
		const result = await collecting;
		assert.match(result.execution.reason ?? "", /no assistant message|RPC child exited before writing session JSONL/);
		assert.equal(h.orchestrator.childrenSnapshot()[0]?.state, "retired");
	} finally {
		h.cleanup();
	}
});

test("M1 lifecycle: launch, RPC steer, session JSONL collect, and retire", async () => {
	const h = harness({ immediateTimeout: false });
	try {
		const handle = await h.orchestrator.launch({ agent: agent(), task: "first task", worktree: false });
		await h.orchestrator.steer(handle.name, "focus on the failing assertion");
		assert.ok(h.supervisor.calls.some((call) => call.method === "steer" && call.name === handle.name));
		const collecting = h.orchestrator.collect(handle.name, { timeoutMs: 2_000 });
		h.supervisor.settle(handle.name, { text: '{"ok":true,"reason":"all checks pass"}' });
		const collected = await collecting;
		assert.equal(collected.execution.status, "success");
		assert.equal(collected.acceptance.status, "accepted");
		assert.equal(collected.acceptance.level, "attested");
		assert.match(collected.output, /all checks pass/);
		assert.ok(collected.outputFile && existsSync(collected.outputFile));
		const cached = h.orchestrator.cachedCollect(handle.name);
		assert.equal(cached?.execution.status, "success");
		assert.equal(cached?.output, collected.output);
		assert.equal(cached?.outputFile, collected.outputFile);
		const retired = await h.orchestrator.retire(handle.name);
		assert.equal(retired.state, "retired");
		assert.equal(h.supervisor.isAlive(handle.name), false);
		assert.equal(existsSync(handle.sessionFile), true, "retire preserves resume JSONL");
		assert.equal(h.orchestrator.cachedCollect(handle.name)?.outputFile, collected.outputFile);
		await h.orchestrator.retire(handle.name);
		assert.equal(h.supervisor.calls.filter((call) => call.method === "retire").length, 1, "retire is idempotent after the RPC process stops");
	} finally {
		h.cleanup();
	}
});

test("resume reuses the persisted session and asks the new RPC process to continue", async () => {
	const h = harness();
	try {
		const first = await h.orchestrator.launch({ agent: agent(), task: "remember the code", name: "worker-existing", worktree: false });
		h.supervisor.settle(first.name, { text: "resume sentinel: ORBIT-91" });
		await h.orchestrator.collect(first.name);
		await h.orchestrator.retire(first.name);

		const resumed = await h.orchestrator.launch({ agent: agent(), task: "repeat the resume sentinel", name: first.name, worktree: false });
		assert.equal(resumed.sessionFile, first.sessionFile);
		assert.equal(h.supervisor.spawns.at(-1)?.resumedFromExistingSession, true);
		assert.match(readFileSync(resumed.sessionFile, "utf8"), /repeat the resume sentinel/);
		h.supervisor.settle(resumed.name, { text: "ORBIT-91" });
		const collected = await h.orchestrator.collect(resumed.name);
		assert.equal(collected.execution.status, "success");
		assert.match(collected.output, /ORBIT-91/);
	} finally {
		h.cleanup();
	}
});

test("blocked RPC confirmation is correlated through UIProxy and stays live until answered", async () => {
	const h = harness();
	try {
		const handle = await h.orchestrator.launch({ agent: agent(), task: "ask for approval", worktree: false });
		h.supervisor.requestUI(handle.name, {
			type: "extension_ui_request",
			id: "rpc-confirm-1",
			method: "confirm",
			title: "Run command?",
			message: "Allow the child command?",
		});
		const result = await h.orchestrator.collect(handle.name, { timeoutMs: 2_000 });
		assert.equal(result.blocked, true);
		assert.equal(result.execution.status, "running");
		await h.orchestrator.approveBlocked(handle.name);
		assert.deepEqual(h.supervisor.responseLog(handle.name), [
			{ requestId: "rpc-confirm-1", response: { confirmed: true } },
		]);
		assert.equal(h.supervisor.isAlive(handle.name), true);
	} finally {
		h.cleanup();
	}
});

test("RPC spawn budget is refused before any process is created", async () => {
	const limited = new Orchestrator({ supervisor: new FakeSupervisor(), runDir: tempDir("rpc-budget-"), cwd: "/tmp", maxSpawns: 0 });
	// `maxSpawns` is an RPC-only gate: in-process children are budgeted by
	// `subagents.inprocess.*` and deliberately skip `assertWithinBudgets`, so the
	// mode is pinned here to keep asserting the RPC budget refusal.
	await assert.rejects(
		() => limited.launch({ agent: agent({ spawnMode: "rpc" }), task: "over budget" }),
		(error: unknown) => error instanceof SubagentError && error.code === ErrorCodes.BUDGET_EXCEEDED,
	);
});


test("collect on an unknown child refuses with NOT_FOUND", async () => {
	const h = harness();
	try {
		await assert.rejects(
			() => h.orchestrator.collect("missing"),
			(error: unknown) => error instanceof SubagentError && error.code === ErrorCodes.NOT_FOUND,
		);
	} finally {
		h.cleanup();
	}
});

test("completionGuard rejects a successful RPC turn without a verdict", async () => {
	const h = harness();
	try {
		const handle = await h.orchestrator.launch({ agent: agent({ completionGuard: true }), task: "finish with no verdict", worktree: false });
		h.supervisor.settle(handle.name, { text: "finished without JSON" });
		const collected = await h.orchestrator.collect(handle.name);
		assert.equal(collected.execution.status, "success");
		assert.equal(collected.acceptance.status, "rejected");
		assert.match(collected.acceptance.reason ?? "", /completionGuard/);
	} finally {
		h.cleanup();
	}
});

test("required verification command promotes an attested RPC verdict to verified", async () => {
	const h = harness();
	const calls: Array<{ command: string; cwd: string }> = [];
	const orchestrator = new Orchestrator({
		supervisor: h.supervisor,
		runDir: h.runDir,
		cwd: "/tmp/project",
		verifyRunner: async (command, cwd) => {
			calls.push({ command, cwd });
			return { code: 0, stdout: "verified", stderr: "" };
		},
	});
	try {
		const handle = await orchestrator.launch({
			agent: agent({ acceptance: { level: "attested", criteria: [{ id: "tests", must: "tests pass", evidence: ["verification-output"], severity: "required", command: "npm test" }] } }),
			task: "verify after completion",
			worktree: false,
		});
		h.supervisor.settle(handle.name, { text: '{"ok":true,"reason":"finished"}' });
		const collected = await orchestrator.collect(handle.name);
		assert.deepEqual(calls, [{ command: "npm test", cwd: "/tmp/project" }]);
		assert.equal(collected.acceptance.status, "accepted");
		assert.equal(collected.acceptance.level, "verified");
	} finally {
		h.cleanup();
	}
});

test("a live child timeout stays working and does not write a terminal output artifact", async () => {
	const h = harness();
	try {
		const handle = await h.orchestrator.launch({ agent: agent(), task: "continue working", worktree: false });
		const collected = await h.orchestrator.collect(handle.name, { timeoutMs: 2 });
		assert.equal(collected.execution.status, "running");
		assert.equal(collected.execution.reason, COLLECT_DEADLINE_REASON);
		assert.equal(collected.outputFile, undefined);
		assert.equal(h.orchestrator.childrenSnapshot()[0]?.state, "working");
		assert.equal(existsSync(path.join(h.runDir, `${handle.name}.output.md`)), false);
	} finally {
		h.cleanup();
	}
});

test("retireAll snapshots settled outcomes and retires every registered child", async () => {
	const h = harness();
	try {
		const first = await h.orchestrator.launch({ agent: agent(), task: "first", name: "worker-a", worktree: false });
		const second = await h.orchestrator.launch({ agent: agent(), task: "second", name: "worker-b", worktree: false });
		h.supervisor.settle(first.name, { text: "first finished" });
		h.supervisor.settle(second.name, { text: "second finished" });
		const retired = await h.orchestrator.retireAll();
		assert.deepEqual(retired.map((child) => child.name), ["worker-a", "worker-b"]);
		assert.deepEqual(retired.map((child) => child.execution?.status), ["success", "success"]);
		assert.ok(retired.every((child) => child.state === "retired"));
		assert.ok(retired.every((child) => !h.supervisor.isAlive(child.name)));
		assert.ok(h.supervisor.calls.filter((call) => call.method === "retire").length === 2);
	} finally {
		h.cleanup();
	}
});

test("restore rehydrates persisted children and the run spawn budget", async () => {
	const h = harness();
	try {
		const handle = await h.orchestrator.launch({ agent: agent(), task: "persist me", worktree: false });
		const store = new RunStore({ rootDir: path.join(h.runDir, "store") });
		const run = store.createRun({ task: "restore fixture", cwd: "/tmp/project" });
		await store.addChild(run.runId, handle.child);
		const persisted = store.readRun(run.runId);
		assert.ok(persisted);
		const restored = new Orchestrator({ supervisor: h.supervisor, runDir: h.runDir, cwd: "/tmp/project", maxSpawns: 1 });
		restored.restore(persisted);
		assert.equal(restored.childrenSnapshot()[0]?.ownerToken, handle.child.ownerToken);
		assert.equal(restored.budget().used, 1);
		await assert.rejects(
			// The restored `maxSpawns` budget is an RPC-only gate (in-process children
			// use `subagents.inprocess.*`), so pin the mode to exercise it.
			() => restored.launch({ agent: agent({ spawnMode: "rpc" }), task: "over restored budget", worktree: false }),
			(error: unknown) => error instanceof SubagentError && error.code === ErrorCodes.BUDGET_EXCEEDED,
		);
	} finally {
		h.cleanup();
	}
});

test("allocateName avoids collisions and returns valid supervisor-local names", async () => {
	const h = harness();
	try {
		assert.match(h.orchestrator.allocateName("worker"), /^worker-0$/);
		const first = await h.orchestrator.launch({ agent: agent(), task: "one", worktree: false });
		const second = await h.orchestrator.launch({ agent: agent(), task: "two", worktree: false });
		assert.notEqual(first.name, second.name);
		assert.match(first.name, /^[a-z][a-z0-9_-]{0,31}$/);
		assert.match(second.name, /^[a-z][a-z0-9_-]{0,31}$/);
	} finally {
		h.cleanup();
	}
});

test("steer on a missing child throws NOT_FOUND", async () => {
	const h = harness();
	try {
		await assert.rejects(
			() => h.orchestrator.steer("missing", "continue"),
			(error: unknown) => error instanceof SubagentError && error.code === ErrorCodes.NOT_FOUND,
		);
	} finally {
		h.cleanup();
	}
});

test("retired child records survive restore without pane or tab identifiers", async () => {
	const h = harness();
	try {
		const handle = await h.orchestrator.launch({ agent: agent(), task: "persist identity", worktree: false });
		await h.orchestrator.retire(handle.name);
		assert.equal("paneId" in handle.child, false);
		assert.equal("tabId" in handle.child, false);
	} finally {
		h.cleanup();
	}
});

test("launch failure rolls back a worktree and permits a retry with the same child name", async () => {
	const root = tempDir("rpc-launch-rollback-");
	const repo = path.join(root, "repo");
	const runDir = path.join(root, "run");
	const { execFileSync } = await import("node:child_process");
	let rejectStart = true;
	try {
		execFileSync("git", ["init", "-q", repo]);
		execFileSync("git", ["-C", repo, "-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-qm", "init"]);
		const supervisor = new FakeSupervisor({
			rejectSpawn: () => rejectStart ? new SubagentError("injected RPC start failure", ErrorCodes.START_FAILED) : undefined,
		});
		const orchestrator = new Orchestrator({ supervisor, runDir, cwd: repo });
		const worktreePath = path.join(runDir, "worktrees", "worker-retry");
		await assert.rejects(
			() => orchestrator.launch({ agent: agent({ name: "centurion", worktree: true }), task: "retry after start failure", name: "worker-retry", worktree: true }),
			(error: unknown) => error instanceof SubagentError && error.code === ErrorCodes.START_FAILED,
		);
		assert.equal(existsSync(worktreePath), false, "failed spawn must remove its worktree directory");
		assert.doesNotMatch(execFileSync("git", ["-C", repo, "worktree", "list", "--porcelain"], { encoding: "utf8" }), /worker-retry/);
		assert.equal(supervisor.spawns.length, 0);

		rejectStart = false;
		const handle = await orchestrator.launch({ agent: agent({ name: "centurion", worktree: true }), task: "retry same name", name: "worker-retry", worktree: true });
		assert.equal(handle.name, "worker-retry");
		assert.equal(supervisor.spawns.length, 1);
		assert.equal(handle.child.worktreePath, worktreePath);
		assert.equal(existsSync(worktreePath), true, "same-name retry can allocate the worktree again");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a live child's Connection error stays running and is not retired", async () => {
	const h = harness();
	try {
		const handle = await h.orchestrator.launch({ agent: agent(), task: "keep going", worktree: false });
		appendFileSync(handle.sessionFile, `${assistantMsg({ stopReason: "error", errorMessage: "Connection error.", text: "" })}\n`);
		const collected = await h.orchestrator.collect(handle.name, { timeoutMs: 2 });
		assert.equal(collected.execution.status, "running");
		assert.equal(collected.execution.reason, TRANSIENT_CONNECTION_REASON);
		assert.equal(collected.acceptance.status, "unknown");
		assert.equal(h.orchestrator.childrenSnapshot()[0]?.state, "working");
		assert.equal(h.supervisor.isAlive(handle.name), true);
		assert.equal(h.supervisor.calls.filter((call) => call.method === "retire").length, 0);
		assert.equal(existsSync(path.join(h.runDir, `${handle.name}.output.md`)), false);
	} finally {
		h.cleanup();
	}
});

test("a settled Connection error on a live child waits, then stays running", async () => {
	const h = harness({ immediateTimeout: false });
	try {
		const handle = await h.orchestrator.launch({ agent: agent(), task: "retry the request", worktree: false });
		h.supervisor.settle(handle.name, { text: "", stopReason: "error", errorMessage: "Connection error." });
		const collected = await h.orchestrator.collect(handle.name, { timeoutMs: 1_000 });
		assert.equal(collected.execution.status, "running");
		assert.equal(collected.execution.reason, TRANSIENT_CONNECTION_REASON);
		assert.equal(h.supervisor.isAlive(handle.name), true);
		assert.equal(h.orchestrator.childrenSnapshot()[0]?.state, "working");
	} finally {
		h.cleanup();
	}
});

test("a Connection error becomes terminal only after the RPC child exits", async () => {
	const h = harness();
	try {
		const handle = await h.orchestrator.launch({ agent: agent(), task: "fail closed", worktree: false });
		appendFileSync(handle.sessionFile, `${assistantMsg({ stopReason: "error", errorMessage: "Connection error.", text: "" })}\n`);
		h.supervisor.exit(handle.name);
		const collected = await h.orchestrator.collect(handle.name, { timeoutMs: 50 });
		assert.equal(collected.execution.status, "failed");
		assert.match(collected.execution.reason ?? "", /Connection error/);
		assert.equal(h.supervisor.isAlive(handle.name), false);
	} finally {
		h.cleanup();
	}
});

test("a live child that recovers past a Connection error collects the real outcome", async () => {
	const runDir = tempDir("rpc-orchestrator-");
	const supervisor = new FakeSupervisor({ immediateTimeout: false });
	let clock = 0;
	let appended = false;
	// #232 ②/③ made the blip hold interval-variable and size-guarded, so the
	// driver keys off the first poll tick after the hold starts ("the child
	// recovers right after the first sleep") instead of a fixed 500ms cadence.
	const orchestrator = new Orchestrator({
		supervisor,
		runDir,
		cwd: "/tmp/project",
		now: () => clock,
		sleep: async (ms) => {
			clock += ms;
			if (!appended) {
				appended = true;
				const child = orchestrator.childrenSnapshot()[0];
				if (child) appendFileSync(child.sessionFile, `${assistantMsg({ stopReason: "stop", text: '{"ok":true}' })}\n`);
			}
		},
	});
	try {
		const handle = await orchestrator.launch({ agent: agent(), task: "recover", worktree: false });
		supervisor.settle(handle.name, { text: "", stopReason: "error", errorMessage: "Connection error." });
		const startedAt = clock;
		const collected = await orchestrator.collect(handle.name, { timeoutMs: 5_000 });
		assert.equal(collected.execution.status, "success");
		assert.equal(supervisor.isAlive(handle.name), true);
		assert.equal(orchestrator.childrenSnapshot()[0]?.state, "awaiting");
		// The recovery was seen on the first poll, so the hold did not burn the
		// deadline: one interval, not the whole 5_000ms window.
		assert.ok(clock - startedAt <= 500, `recovery must end the blip hold on the first poll (spent ${clock - startedAt}ms)`);
	} finally {
		rmSync(runDir, { recursive: true, force: true });
	}
});

test("RPC child with a non-success stop reason is not reported as accepted", async () => {
	const h = harness();
	try {
		const handle = await h.orchestrator.launch({ agent: agent(), task: "fail", worktree: false });
		h.supervisor.settle(handle.name, { text: "provider failed", stopReason: "error", errorMessage: "provider failure" });
		const collected = await h.orchestrator.collect(handle.name);
		assert.equal(collected.execution.status, "failed");
		assert.notEqual(collected.acceptance.status, "accepted");
	} finally {
		h.cleanup();
	}
});

// ── #227 D5: a dead child with a finished turn must not burn the deadline ────

test("collect: a dead child whose last turn already finished returns the result, not COLLECT_DEADLINE_REASON (#227 D5)", async () => {
	const h = harness({ immediateTimeout: false });
	try {
		const handle = await h.orchestrator.launch({ agent: agent(), task: "finish, then die", worktree: false });
		// Drive the exact D5 precondition: the collect is already parked on the
		// supervisor when the child writes its final message and then dies, so the
		// wait resolves as `timeout` even though the process is gone and the turn
		// is complete. (A real supervisor can produce that ordering by racing its
		// wait timer against the exit.)
		const supervisor = h.supervisor as unknown as {
			waitSettled(name: string, timeoutMs?: number): Promise<{ settled: boolean; abnormal: boolean; reason?: string }>;
		};
		supervisor.waitSettled = async () => {
			appendFileSync(handle.sessionFile, `${assistantMsg({ text: "completed before the process died" })}\n`);
			h.supervisor.exit(handle.name);
			return { settled: false, abnormal: false, reason: "timeout" };
		};
		const started = Date.now();
		const collected = await h.orchestrator.collect(handle.name, { timeoutMs: 60_000 });
		// A dead child cannot settle again: waiting out the deadline is pure spin.
		assert.ok(Date.now() - started < 5_000, "a dead child must not be waited on until the collect deadline");
		assert.notEqual(collected.execution.reason, COLLECT_DEADLINE_REASON, "a dead child is never reported as a live deadline hit");
		assert.equal(collected.execution.status, "success", "the completed turn is the outcome");
		assert.match(collected.output, /completed before the process died/);
		assert.equal(h.supervisor.isAlive(handle.name), false);
		assert.equal(h.orchestrator.childrenSnapshot()[0]?.state, "awaiting", "a finished turn settles the lifecycle state");
	} finally {
		h.cleanup();
	}
});

test("collect: a dead child mid-turn keeps its aborted outcome instead of a deadline (#227 D5)", async () => {
	const h = harness({ immediateTimeout: true });
	try {
		const handle = await h.orchestrator.launch({ agent: agent(), task: "die mid-turn", worktree: false });
		await h.supervisor.prompt(handle.name, "second prompt that never gets an answer");
		h.supervisor.exit(handle.name);
		const collected = await h.orchestrator.collect(handle.name, { timeoutMs: 2 });
		assert.notEqual(collected.execution.reason, COLLECT_DEADLINE_REASON, "a dead child never reports the live deadline reason");
		assert.equal(collected.execution.status, "aborted", "an unfinished turn on a dead child is an abort, not a live wait");
		assert.equal(h.supervisor.isAlive(handle.name), false);
	} finally {
		h.cleanup();
	}
});

// ── #316: one bounded retry for an empty provider generation ─────────────────

/** The in-band failure message pi writes when a provider ends the stream empty. */
const EMPTY_GENERATION_MESSAGE = "Provider finish_reason: error";

/** Answer the next `prompt` the way a provider would: settle the turn it starts. */
function settleOnPrompt(supervisor: FakeSupervisor, turn: FakeTurn): void {
	const original = supervisor.prompt.bind(supervisor);
	supervisor.prompt = async (name: string, text: string) => {
		await original(name, text);
		supervisor.settle(name, turn);
	};
}

const prompts = (supervisor: FakeSupervisor) => supervisor.calls.filter((call) => call.method === "prompt");

test("#316 D2: a retried empty generation returns the retry's success and costs one prompt", async () => {
	const h = harness({ immediateTimeout: false });
	try {
		const handle = await h.orchestrator.launch({ agent: agent(), task: "recover from an empty turn", worktree: false });
		settleOnPrompt(h.supervisor, { text: '{"ok":true}', stopReason: "stop" });
		h.supervisor.settle(handle.name, { text: "", stopReason: "error", errorMessage: EMPTY_GENERATION_MESSAGE });
		const collected = await h.orchestrator.collect(handle.name, { timeoutMs: 5_000 });

		assert.equal(collected.execution.status, "success");
		assert.equal(collected.execution.errorKind, undefined, "a recovered child is not tagged as a provider failure");
		assert.equal(collected.output, '{"ok":true}');
		assert.equal(prompts(h.supervisor).length, 1, "exactly one retry prompt");
		assert.equal(prompts(h.supervisor)[0]?.text, CONTINUE_PROMPT);
		assert.equal(CONTINUE_PROMPT, "Your previous turn ended with no output. Continue from where you left off; do not restart the task.");
		assert.equal(h.orchestrator.childrenSnapshot()[0]?.providerRetriesUsed, 1);
		// One artifact, holding the retried turn — not two files, nor the empty turn.
		const outputs = readdirSync(h.runDir).filter((file) => file.endsWith(".output.md"));
		assert.deepEqual(outputs, [`${handle.name}.output.md`]);
		assert.match(readFileSync(path.join(h.runDir, outputs[0]!), "utf8"), /ok/);
	} finally {
		h.cleanup();
	}
});

test("#316 D2: a retry that also comes back empty fails once, says so, and is never retried again", async () => {
	const h = harness({ immediateTimeout: false });
	try {
		const handle = await h.orchestrator.launch({ agent: agent(), task: "fail twice", worktree: false });
		settleOnPrompt(h.supervisor, { text: "", stopReason: "error", errorMessage: EMPTY_GENERATION_MESSAGE });
		h.supervisor.settle(handle.name, { text: "", stopReason: "error", errorMessage: EMPTY_GENERATION_MESSAGE });
		const collected = await h.orchestrator.collect(handle.name, { timeoutMs: 5_000 });

		assert.equal(collected.execution.status, "failed");
		assert.equal(collected.execution.errorKind, "provider-empty-generation");
		assert.match(collected.execution.reason ?? "", /retried once/);
		assert.equal(prompts(h.supervisor).length, 1, "the limit is one, not a loop");
		assert.equal(h.orchestrator.childrenSnapshot()[0]?.providerRetriesUsed, 1);

		// The budget is on the child record, so a later collect does not spend it again.
		const again = await h.orchestrator.collect(handle.name, { timeoutMs: 5_000 });
		assert.equal(again.execution.status, "failed");
		assert.equal(prompts(h.supervisor).length, 1, "a collect cannot resurrect the retry budget");
	} finally {
		h.cleanup();
	}
});

test("#316 D2: a failure that produced output is final and never re-prompted", async () => {
	const h = harness();
	try {
		const handle = await h.orchestrator.launch({ agent: agent(), task: "fail with text", worktree: false });
		h.supervisor.settle(handle.name, { text: "provider failed", stopReason: "error", errorMessage: "provider failure" });
		const collected = await h.orchestrator.collect(handle.name, { timeoutMs: 50 });

		assert.equal(collected.execution.status, "failed");
		assert.equal(collected.execution.errorKind, undefined);
		assert.equal(prompts(h.supervisor).length, 0, "only an EMPTY generation is worth another prompt");
		assert.equal(h.orchestrator.childrenSnapshot()[0]?.providerRetriesUsed, undefined);
	} finally {
		h.cleanup();
	}
});

test("#316 D2: a dead child is never re-prompted for an empty generation", async () => {
	const h = harness();
	try {
		const handle = await h.orchestrator.launch({ agent: agent(), task: "die on the empty turn", worktree: false });
		h.supervisor.settle(handle.name, { text: "", stopReason: "error", errorMessage: EMPTY_GENERATION_MESSAGE });
		h.supervisor.exit(handle.name);
		const collected = await h.orchestrator.collect(handle.name, { timeoutMs: 50 });

		assert.equal(collected.execution.status, "failed");
		assert.equal(collected.execution.errorKind, "provider-empty-generation", "the verdict still names the failure class");
		assert.doesNotMatch(collected.execution.reason ?? "", /retried once/, "nothing was retried, so nothing may claim it was");
		assert.equal(prompts(h.supervisor).length, 0, "a dead child cannot take another prompt");
	} finally {
		h.cleanup();
	}
});

test("#316 D2: an aborted parent turn never retries, even an empty generation", async () => {
	const h = harness();
	try {
		const handle = await h.orchestrator.launch({ agent: agent(), task: "cancelled mid-empty-turn", worktree: false });
		h.supervisor.settle(handle.name, { text: "", stopReason: "error", errorMessage: EMPTY_GENERATION_MESSAGE });
		const controller = new AbortController();
		controller.abort();
		const collected = await h.orchestrator.collect(handle.name, { timeoutMs: 50, signal: controller.signal });

		assert.equal(collected.execution.status, "running");
		assert.equal(collected.execution.reason, "aborted by parent");
		assert.equal(prompts(h.supervisor).length, 0, "an interrupted collect must not start a new turn");
		assert.equal(h.orchestrator.childrenSnapshot()[0]?.providerRetriesUsed, undefined);
	} finally {
		h.cleanup();
	}
});
