/**
 * #214 — worktree is centurion-only; non-centurion requests warn once and
 * force false (Archer lock D1–D4).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Orchestrator } from "../../src/runs/orchestrator.ts";
import { RoutingSupervisor } from "../../src/supervisor/routing-supervisor.ts";
import type { RpcSupervisor } from "../../src/supervisor/rpc-supervisor.ts";
import type { InProcessSupervisor } from "../../src/supervisor/inprocess-supervisor.ts";
import { InMemoryUIProxy } from "../../src/supervisor/ui-proxy.ts";
import { ErrorCodes, SubagentError, type AgentConfig } from "../../src/shared/types.ts";
import { BUILTIN_AGENTS_DIR, loadAgentsFromDir } from "../../src/agents/agents.ts";

function loadBundledAgents(): AgentConfig[] {
	return loadAgentsFromDir(BUILTIN_AGENTS_DIR, "builtin");
}

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

interface AcceptedLaunch {
	name: string;
	mode: string | undefined;
	worktree: boolean | undefined;
}

function realRouter(): { supervisor: RoutingSupervisor; accepted: AcceptedLaunch[] } {
	const accepted: AcceptedLaunch[] = [];
	const record = (input: { name: string; sessionFile: string; agent: AgentConfig }, pid: number) => {
		accepted.push({ name: input.name, mode: input.agent.spawnMode, worktree: input.agent.worktree });
		return { name: input.name, sessionFile: input.sessionFile, pid };
	};
	const uiProxy = new InMemoryUIProxy();
	const rpc = {
		uiProxy,
		isAlive: () => false,
		spawnChild: async (input: { name: string; sessionFile: string; agent: AgentConfig }) => record(input, 1001),
	} as unknown as RpcSupervisor;
	const inprocess = {
		uiProxy,
		isAlive: () => false,
		spawnChild: async (input: { name: string; sessionFile: string; agent: AgentConfig }) => record(input, 1002),
	} as unknown as InProcessSupervisor;
	return { supervisor: new RoutingSupervisor({ rpc, inprocess, uiProxy }), accepted };
}

function agent(overrides: Partial<AgentConfig> = {}): AgentConfig {
	return {
		name: "worker",
		description: "214 test role",
		systemPromptMode: "append",
		inheritProjectContext: true,
		inheritSkills: false,
		kind: "pi",
		systemPrompt: "You are a test worker.",
		source: "user",
		filePath: "/fake/worker.md",
		...overrides,
	};
}

function gitRepo(root: string): string {
	const repo = path.join(root, "repo");
	execFileSync("git", ["init", "-q", repo]);
	execFileSync("git", ["-C", repo, "-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-qm", "init"]);
	return repo;
}

function harness(prefix: string) {
	const root = mkdtempSync(path.join(tmpdir(), prefix));
	const { supervisor, accepted } = realRouter();
	return {
		runDir: path.join(root, "run"),
		repo: gitRepo(root),
		supervisor,
		accepted,
		cleanup: () => rmSync(root, { recursive: true, force: true }),
	};
}

test("#214 acceptance: agents/ only centurion has worktree: true", () => {
	const agentsDir = path.join(REPO_ROOT, "agents");
	const hits: string[] = [];
	for (const file of readdirSync(agentsDir)) {
		if (!file.endsWith(".md")) continue;
		const body = readFileSync(path.join(agentsDir, file), "utf8");
		if (/worktree:\s*true/.test(body)) hits.push(file);
	}
	assert.deepEqual(hits, ["centurion.md"], "rg 'worktree:\\s*true' agents/ must only hit centurion.md");

	const bundled = loadBundledAgents();
	const withTrue = bundled.filter((a) => a.worktree === true).map((a) => a.name);
	assert.deepEqual(withTrue, ["centurion"]);
	assert.equal(bundled.find((a) => a.name === "worker")?.worktree, false);
});

test("#214 acceptance: non-centurion role worktree:true → warn once/run + spawn false; no throw", async () => {
	const h = harness("214-role-");
	const events: unknown[] = [];
	const warns: string[] = [];
	const prevWarn = console.warn;
	console.warn = (...args: unknown[]) => {
		warns.push(args.map(String).join(" "));
	};
	try {
		const orchestrator = new Orchestrator({
			supervisor: h.supervisor,
			runDir: h.runDir,
			cwd: h.repo,
			onBudgetRefused: (e) => events.push(e),
		});
		const first = await orchestrator.launch({ agent: agent({ worktree: true }), task: "a" });
		const second = await orchestrator.launch({ agent: agent({ worktree: true }), task: "b" });
		assert.equal(first.child.worktreePath, undefined);
		assert.equal(second.child.worktreePath, undefined);
		assert.equal(h.accepted.length, 2);
		assert.ok(h.accepted.every((a) => a.mode === "inprocess" && a.worktree === false));
		assert.equal(events.length, 1, "warn once per run");
		assert.deepEqual(events[0], {
			type: "budget_refused",
			reason: "worktree_denied_non_centurion",
			agent: "worker",
		});
		assert.equal(warns.length, 1);
		assert.match(warns[0]!, /worktree denied for non-centurion role 'worker'/);
		assert.match(warns[0]!, /forced worktree: false/);
	} finally {
		console.warn = prevWarn;
		h.cleanup();
	}
});

test("#214 acceptance: launch/subagent({worktree:true}) on non-centurion demotes the same way", async () => {
	const h = harness("214-launch-");
	const events: unknown[] = [];
	try {
		const orchestrator = new Orchestrator({
			supervisor: h.supervisor,
			runDir: h.runDir,
			cwd: h.repo,
			onBudgetRefused: (e) => events.push(e),
		});
		const handle = await orchestrator.launch({
			agent: agent({ worktree: false }),
			task: "explicit launch worktree",
			worktree: true,
		});
		assert.equal(handle.child.worktreePath, undefined);
		assert.deepEqual(h.accepted, [{ name: handle.name, mode: "inprocess", worktree: false }]);
		assert.equal((events[0] as { reason?: string })?.reason, "worktree_denied_non_centurion");
	} finally {
		h.cleanup();
	}
});

test("#214 acceptance: centurion still can worktree (no regression)", async () => {
	const h = harness("214-centurion-");
	try {
		const orchestrator = new Orchestrator({ supervisor: h.supervisor, runDir: h.runDir, cwd: h.repo });
		const handle = await orchestrator.launch({
			agent: agent({ name: "centurion", worktree: true }),
			task: "subtree",
		});
		assert.ok(handle.child.worktreePath);
		assert.equal(existsSync(handle.child.worktreePath!), true);
		assert.deepEqual(h.accepted, [{ name: handle.name, mode: "rpc", worktree: true }]);
	} finally {
		h.cleanup();
	}
});

test("#214 acceptance: D3 copy prefers set worktree: false over use spawnMode rpc", async () => {
	const h = harness("214-d3-");
	try {
		const orchestrator = new Orchestrator({ supervisor: h.supervisor, runDir: h.runDir, cwd: h.repo });
		await assert.rejects(
			() =>
				orchestrator.launch({
					agent: agent({ name: "centurion", spawnMode: "inprocess", worktree: true }),
					task: "conflict",
				}),
			(error: unknown) => {
				assert.ok(error instanceof SubagentError);
				assert.equal(error.code, ErrorCodes.INVALID_PARAMS);
				assert.match(error.message, /set worktree: false/);
				assert.doesNotMatch(error.message, /use spawnMode ["']rpc["']/);
				return true;
			},
		);
		// Router guard wording (D3) — exercised directly so we pin routing-supervisor copy too.
		await assert.rejects(
			() =>
				h.supervisor.spawnChild({
					name: "probe",
					sessionFile: path.join(h.runDir, "probe.jsonl"),
					tempDir: h.runDir,
					cwd: h.repo,
					task: "x",
					agent: agent({ name: "centurion", spawnMode: "inprocess", worktree: true }),
				}),
			(error: unknown) => {
				assert.ok(error instanceof SubagentError);
				assert.match(error.message, /set worktree: false/);
				assert.doesNotMatch(error.message, /use spawnMode ["']rpc["']/);
				return true;
			},
		);
	} finally {
		h.cleanup();
	}
});

test("#214 acceptance: omitted spawnMode worker → inprocess", async () => {
	const h = harness("214-default-inprocess-");
	try {
		const orchestrator = new Orchestrator({ supervisor: h.supervisor, runDir: h.runDir, cwd: h.repo });
		const handle = await orchestrator.launch({
			agent: agent({ worktree: false, steer: true }),
			task: "writer in place",
		});
		assert.equal(handle.child.worktreePath, undefined);
		assert.deepEqual(h.accepted, [{ name: handle.name, mode: "inprocess", worktree: false }]);
	} finally {
		h.cleanup();
	}
});

test("#279 acceptance: non-centurion role with spawnMode:rpc → warn once/run + forced inprocess; no throw", async () => {
	// The #214 worktree guard keys on the worktree REQUEST. A role card that pins
	// `spawnMode: rpc` never consults `resolveSpawnMode`, so it obtained a separate
	// process — the exact isolation rpc is reserved for — while worktree stayed
	// false. This case pins that bypass shut.
	const h = harness("279-role-");
	const events: unknown[] = [];
	const warns: string[] = [];
	const prevWarn = console.warn;
	console.warn = (...args: unknown[]) => {
		warns.push(args.map(String).join(" "));
	};
	try {
		const orchestrator = new Orchestrator({
			supervisor: h.supervisor,
			runDir: h.runDir,
			cwd: h.repo,
			onBudgetRefused: (e) => events.push(e),
		});
		// No worktree request at all: the old guard cannot fire, only the new one can.
		const first = await orchestrator.launch({ agent: agent({ spawnMode: "rpc" }), task: "a" });
		const second = await orchestrator.launch({ agent: agent({ spawnMode: "rpc" }), task: "b" });
		assert.equal(h.accepted.length, 2);
		assert.ok(
			h.accepted.every((a) => a.mode === "inprocess"),
			`an explicit spawnMode:rpc must be demoted for a non-centurion role, saw ${h.accepted.map((a) => a.mode).join(",")}`,
		);
		assert.equal(events.length, 1, "warn once per run");
		assert.deepEqual(events[0], {
			type: "budget_refused",
			reason: "spawn_mode_denied_non_centurion",
			agent: "worker",
		});
		assert.equal(warns.length, 1);
		assert.match(warns[0]!, /rpc denied for non-centurion role 'worker'/);
		assert.match(warns[0]!, /forced spawnMode: inprocess/);
		// The demotion must reach the child record, not just the supervisor call.
		assert.equal(first.child.spawnMode, "inprocess");
		assert.equal(second.child.spawnMode, "inprocess");
	} finally {
		console.warn = prevWarn;
		h.cleanup();
	}
});

test("#279 acceptance: a centurion keeps spawnMode:rpc (the reservation still works)", async () => {
	const h = harness("279-cent-");
	const events: unknown[] = [];
	try {
		const orchestrator = new Orchestrator({
			supervisor: h.supervisor,
			runDir: h.runDir,
			cwd: h.repo,
			onBudgetRefused: (e) => events.push(e),
		});
		await orchestrator.launch({ agent: agent({ name: "centurion", spawnMode: "rpc" }), task: "own the slice" });
		assert.equal(h.accepted.length, 1);
		assert.equal(h.accepted[0]!.mode, "rpc", "a centurion must keep its rpc backend");
		assert.equal(events.length, 0, "no denial event for the reserved role");
	} finally {
		h.cleanup();
	}
});
