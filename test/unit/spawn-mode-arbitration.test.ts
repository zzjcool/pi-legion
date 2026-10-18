/**
 * Spawn-mode arbitration in `Orchestrator.launch` (contract D2/D3).
 *
 * `DEFAULT_SPAWN_MODE` is `inprocess`, but `resolveSpawnMode` only reports the
 * *configured intent* — it deliberately knows nothing about worktree isolation
 * or role kind. The launch context arbitrates an OMITTED mode down to `rpc`
 * when the in-process backend cannot serve the launch, and never downgrades an
 * explicit value (contract invariant I6).
 *
 * These tests observe the arbitrated mode exactly the way downstream code sees
 * it: `SpawnInput.agent.spawnMode` on the supervisor call. That is the field
 * `RoutingSupervisor.spawnChild` re-resolves, so asserting it here pins the
 * contract that arbitration must be written back, not just computed locally.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { Orchestrator } from "../../src/runs/orchestrator.ts";
import { ErrorCodes, SubagentError, type AgentConfig } from "../../src/shared/types.ts";
import { FakeSupervisor } from "../helpers/fake-supervisor.ts";

function agent(overrides: Partial<AgentConfig> = {}): AgentConfig {
	return {
		name: "worker",
		description: "arbitration test role",
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

interface Harness {
	runDir: string;
	repo: string;
	supervisor: FakeSupervisor;
	orchestrator: Orchestrator;
	cleanup(): void;
}

/**
 * `gitRepo` is only needed by the launches that actually resolve to a worktree:
 * `createChildWorktree` shells out to git.
 */
function harness(prefix: string, gitRepo = false): Harness {
	const root = mkdtempSync(path.join(tmpdir(), prefix));
	const runDir = path.join(root, "run");
	const repo = path.join(root, "repo");
	if (gitRepo) {
		execFileSync("git", ["init", "-q", repo]);
		execFileSync("git", ["-C", repo, "-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-qm", "init"]);
	}
	const supervisor = new FakeSupervisor();
	return {
		runDir,
		repo,
		supervisor,
		orchestrator: new Orchestrator({ supervisor, runDir, cwd: gitRepo ? repo : "/tmp/project" }),
		cleanup: () => rmSync(root, { recursive: true, force: true }),
	};
}

/** The mode the supervisor (and therefore RoutingSupervisor) actually received. */
function spawnedMode(h: Harness): unknown {
	return h.supervisor.spawns[0]?.input.agent.spawnMode;
}

test("arbitration: omitted spawnMode + worktree:true falls back to rpc", async () => {
	const h = harness("spawn-arb-worktree-", true);
	try {
		// The role asks for isolation but does not pin a backend.
		const handle = await h.orchestrator.launch({ agent: agent({ worktree: true }), task: "isolated work" });
		assert.ok(handle.child.worktreePath, "a resolved worktree must really be created");
		assert.equal(existsSync(handle.child.worktreePath!), true);
		assert.equal(spawnedMode(h), "rpc", "an omitted mode that needs a worktree must reach the supervisor as rpc");
	} finally {
		h.cleanup();
	}
});

test("arbitration: omitted spawnMode + worktree:false stays inprocess", async () => {
	const h = harness("spawn-arb-no-worktree-");
	try {
		const handle = await h.orchestrator.launch({ agent: agent(), task: "shared checkout", worktree: false });
		assert.equal(handle.child.worktreePath, undefined);
		assert.equal(spawnedMode(h), "inprocess", "the default backend is used when nothing forces rpc");
	} finally {
		h.cleanup();
	}
});

test("arbitration: an explicit rpc mode is never downgraded by a worktree", async () => {
	const h = harness("spawn-arb-explicit-rpc-", true);
	try {
		const handle = await h.orchestrator.launch({
			agent: agent({ spawnMode: "rpc", worktree: true }),
			task: "isolated rpc work",
		});
		assert.ok(handle.child.worktreePath);
		assert.equal(spawnedMode(h), "rpc");
	} finally {
		h.cleanup();
	}
});

test("arbitration: omitted spawnMode + kind !== pi never becomes inprocess", async () => {
	// `Orchestrator.launch` refuses non-pi children outright before arbitration
	// (`RPC supervisor only supports pi children`), so the arbitration clause
	// for `kind !== "pi"` is a second, defensive layer that keeps a future
	// in-process-capable non-pi role off the SDK backend. The observable
	// contract for callers today is: an omitted mode must fail loud here rather
	// than be silently routed to the in-process supervisor, whose own guard
	// (`spawnMode "inprocess" requires kind "pi"`) would be a worse error.
	const h = harness("spawn-arb-non-pi-");
	try {
		await assert.rejects(
			() => h.orchestrator.launch({ agent: agent({ kind: "cursor" }), task: "unsupported kind", worktree: false }),
			(error: unknown) =>
				error instanceof SubagentError &&
				error.code === ErrorCodes.INVALID_PARAMS &&
				/pin pi-legion v0\.16\.x/.test(error.message),
		);
		assert.equal(h.supervisor.spawns.length, 0, "no backend is asked to start a non-pi child");
	} finally {
		h.cleanup();
	}
});

test("arbitration: explicit inprocess + worktree:true still throws INVALID_PARAMS (I1)", async () => {
	const h = harness("spawn-arb-explicit-inprocess-", true);
	try {
		await assert.rejects(
			() => h.orchestrator.launch({ agent: agent({ spawnMode: "inprocess", worktree: true }), task: "conflict" }),
			(error: unknown) =>
				error instanceof SubagentError &&
				error.code === ErrorCodes.INVALID_PARAMS &&
				/cannot use worktree isolation/.test(error.message),
			"arbitration must not soften an explicit inprocess + worktree combination",
		);
		// Also when the worktree comes from the launch argument instead of the role.
		await assert.rejects(
			() => h.orchestrator.launch({ agent: agent({ spawnMode: "inprocess" }), task: "conflict", worktree: true }),
			(error: unknown) => error instanceof SubagentError && error.code === ErrorCodes.INVALID_PARAMS,
		);
		assert.equal(h.supervisor.spawns.length, 0, "a refused combination never reaches the supervisor");
	} finally {
		h.cleanup();
	}
});

test("arbitration: launch({ worktree: false }) overrides a worktree role and runs (regression)", async () => {
	// Before D3 the orchestrator gated on the RAW fields
	// (`input.worktree === true || input.agent.worktree === true`), so a caller
	// that explicitly opted out of isolation for a `worktree: true` role — the
	// documented priority in `resolveLaunchWorktree` — was rejected with
	// "cannot combine with worktree isolation" once the default became
	// inprocess. The override must win and the launch must succeed without a tree.
	const h = harness("spawn-arb-override-", true);
	try {
		const handle = await h.orchestrator.launch({ agent: agent({ worktree: true }), task: "share the checkout", worktree: false });
		assert.equal(handle.child.worktreePath, undefined, "an explicit worktree:false must not create a worktree");
		assert.equal(h.supervisor.spawns.length, 1);
		assert.equal(spawnedMode(h), "inprocess");
	} finally {
		h.cleanup();
	}
});
