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
	// Role cards no longer carry `spawnMode`, so the orchestrator can no longer be
	// driven into the conflicting shape from a card. The supervisor guard still
	// exists (and still matters: it is the last line against an internal caller
	// constructing {spawnMode: "inprocess", worktree: true}), so pin its wording
	// directly. The orchestrator half is gone with the field.
	{
		const h = harness("214-d3-");
		try {
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

test("#279 acceptance: the backend follows worktree — a non-centurion writer can never reach rpc", async () => {
	// Role cards no longer carry `spawnMode`. rpc exists only because it is the one
	// backend that can host a worktree child, so the rule is structural rather than
	// a demotion: `worktree === true => rpc`, otherwise in-process. A non-centurion
	// role has worktree forced to false by the #214 guard, and that same guard is
	// what keeps it off rpc — there is no longer any field through which a card
	// could ask for the other backend.
	const h = harness("279-structural-");
	const events: unknown[] = [];
	try {
		const orchestrator = new Orchestrator({
			supervisor: h.supervisor,
			runDir: h.runDir,
			cwd: h.repo,
			onBudgetRefused: (e) => events.push(e),
		});
		const writer = await orchestrator.launch({ agent: agent({ worktree: true }), task: "a" });
		assert.equal(h.accepted.length, 1);
		assert.equal(h.accepted[0]!.mode, "inprocess", "the worktree refusal also keeps the launch off rpc");
		assert.equal(writer.child.spawnMode, "inprocess");
		assert.deepEqual(events, [{
			type: "budget_refused",
			reason: "worktree_denied_non_centurion",
			agent: "worker",
		}]);
	} finally {
		h.cleanup();
	}
});

test("#279 acceptance: a centurion holding a worktree runs on rpc", async () => {
	const h = harness("279-cent-");
	const events: unknown[] = [];
	try {
		const orchestrator = new Orchestrator({
			supervisor: h.supervisor,
			runDir: h.runDir,
			cwd: h.repo,
			onBudgetRefused: (e) => events.push(e),
		});
		const cent = await orchestrator.launch({ agent: agent({ name: "centurion", worktree: true }), task: "own the slice" });
		assert.equal(h.accepted.length, 1);
		assert.equal(h.accepted[0]!.mode, "rpc", "a centurion holding a worktree must run on rpc");
		assert.equal(cent.child.spawnMode, "rpc");
		assert.equal(events.length, 0, "no denial event for the reserved role");
	} finally {
		h.cleanup();
	}
});
