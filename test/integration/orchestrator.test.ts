import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { COLLECT_DEADLINE_REASON, Orchestrator, preCreateSessionFile, TRANSIENT_CONNECTION_REASON } from "../../src/runs/orchestrator.ts";
import { ErrorCodes, SubagentError, type AgentConfig } from "../../src/shared/types.ts";
import { FakeSupervisor } from "../helpers/fake-supervisor.ts";
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
	const runDir = tempDir("rpc-orchestrator-growing-");
	const supervisor = new FakeSupervisor({ immediateTimeout: true });
	let clock = 0;
	let childName = "";
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
			supervisor.settle(childName, { text: "late, but complete" });
		},
	});
	try {
		const handle = await orchestrator.launch({ agent: agent(), task: "long response", worktree: false });
		childName = handle.name;
		sessionFile = handle.sessionFile;
		const startedAt = clock;
		const result = await orchestrator.collect(handle.name, { timeoutMs });
		assert.equal(result.execution.status, "success");
		assert.match(result.output, /late, but complete/);
		assert.equal(grewDuringFirstPoll, true);
		assert.ok(clock - startedAt > timeoutMs, "growth must extend collection past the first timeout");
		assert.ok(supervisor.calls.filter((call) => call.method === "waitSettled").length >= 2, "growing output grants another RPC wait");
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

test("RPC child kind and spawn budget are refused before any process is created", async () => {
	const h = harness();
	try {
		await assert.rejects(
			() => h.orchestrator.launch({ agent: agent({ kind: "cursor" }), task: "unsupported" }),
			(error: unknown) => error instanceof SubagentError && error.code === ErrorCodes.INVALID_PARAMS && /pin pi-legion v0\.16\.x/.test(error.message),
		);
		assert.equal(h.supervisor.spawns.length, 0);
	} finally {
		h.cleanup();
	}

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
		// #214 D4: worktree isolation is centurion-only. The rollback/retry rule
		// under test is card-name agnostic, so a centurion card drives it.
		await assert.rejects(
			() => orchestrator.launch({ agent: agent({ name: "centurion" }), task: "retry after start failure", name: "worker-retry", worktree: true }),
			(error: unknown) => error instanceof SubagentError && error.code === ErrorCodes.START_FAILED,
		);
		assert.equal(existsSync(worktreePath), false, "failed spawn must remove its worktree directory");
		assert.doesNotMatch(execFileSync("git", ["-C", repo, "worktree", "list", "--porcelain"], { encoding: "utf8" }), /worker-retry/);
		assert.equal(supervisor.spawns.length, 0);

		rejectStart = false;
		const handle = await orchestrator.launch({ agent: agent({ name: "centurion" }), task: "retry same name", name: "worker-retry", worktree: true });
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
		const collected = await orchestrator.collect(handle.name, { timeoutMs: 5_000 });
		assert.equal(collected.execution.status, "success");
		assert.equal(supervisor.isAlive(handle.name), true);
		assert.equal(orchestrator.childrenSnapshot()[0]?.state, "awaiting");
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
