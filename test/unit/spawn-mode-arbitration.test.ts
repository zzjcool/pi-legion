/**
 * Spawn-mode arbitration in `Orchestrator.launch` (contract D2/D3).
 *
 * `DEFAULT_SPAWN_MODE` is `inprocess`, but `resolveSpawnMode` only reports the
 * *configured intent* — it deliberately knows nothing about worktree isolation.
 * The launch context arbitrates an OMITTED mode down to `rpc` when the
 * in-process backend cannot serve the launch, and never downgrades an explicit
 * value (contract invariant I6).
 *
 * **Test authenticity requirement (contract)**: every assertion about a
 * `spawnMode × worktree` combination runs against a REAL `RoutingSupervisor`.
 * `test/helpers/fake-supervisor.ts` validates only `kind !== "pi"` and would
 * happily accept `{spawnMode: "inprocess", worktree: true}`, so a FakeSupervisor
 * based assertion of this behaviour is a false green — that exact blind spot
 * hid the `centurion dispatches worker` regression.
 *
 * The real router rejects the invalid combination in `spawnChild` *before* any
 * process is started (`routing-supervisor.ts:79`), so no child is ever spawned;
 * the backends below are still stubbed to guarantee nothing escapes the guard.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { Orchestrator } from "../../src/runs/orchestrator.ts";
import { RoutingSupervisor } from "../../src/supervisor/routing-supervisor.ts";
import type { RpcSupervisor } from "../../src/supervisor/rpc-supervisor.ts";
import type { InProcessSupervisor } from "../../src/supervisor/inprocess-supervisor.ts";
import { InMemoryUIProxy } from "../../src/supervisor/ui-proxy.ts";
import { openLegionDb, legionDbPath } from "../../src/legion/db.ts";
import { insertNode } from "../../src/legion/nodes.ts";
import { RunStore } from "../../src/runs/store.ts";
import { createLegionEventBus } from "../../src/extension/event-bus.ts";
import { ErrorCodes, SubagentError, type AgentConfig } from "../../src/shared/types.ts";

interface AcceptedLaunch {
	name: string;
	mode: string | undefined;
	worktree: boolean | undefined;
}

/**
 * A REAL `RoutingSupervisor` whose two backends are recording stubs.
 *
 * The code under test is the router's own `spawnChild` guard
 * (`routing-supervisor.ts:71-84`), which runs *before* it picks a backend — so
 * an illegal `spawnMode × worktree` combination is rejected by real production
 * code, not by a stub. The stubs only replace the would-be child process launch
 * (a real RPC spawn is impossible in a unit test, and an in-process SDK session
 * would need a model). `accepted` therefore records exactly the launches that
 * got past the real guard.
 */
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

/**
 * A role card that still pins `worktree: true` (the pre-#214 `agents/worker.md`
 * shape) and sets no spawnMode. #214 D2 flipped the bundled card to
 * `worktree: false`, but a user card may still pin it — the launch must
 * downgrade it rather than throw, and downstream must see `worktree: false`.
 */
function workerCard(overrides: Partial<AgentConfig> = {}): AgentConfig {
	return agent({ worktree: true, steer: true, maxSubagentDepth: 3, ...overrides });
}

function gitRepo(root: string): string {
	const repo = path.join(root, "repo");
	execFileSync("git", ["init", "-q", repo]);
	execFileSync("git", ["-C", repo, "-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-qm", "init"]);
	return repo;
}

function plainHarness(prefix: string): { runDir: string; supervisor: RoutingSupervisor; accepted: AcceptedLaunch[]; repo: string; cleanup(): void } {
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

test("arbitration: omitted spawnMode + worktree:true falls back to rpc", async () => {
	const h = plainHarness("spawn-arb-worktree-");
	try {
		const orchestrator = new Orchestrator({ supervisor: h.supervisor, runDir: h.runDir, cwd: h.repo });
		// #214 D4: only a centurion may hold a worktree; the arbitration under
		// test (omitted mode + worktree ⇒ rpc) is driven by a centurion card.
		const handle = await orchestrator.launch({ agent: agent({ name: "centurion", worktree: true }), task: "isolated work" });
		assert.ok(handle.child.worktreePath, "a resolved worktree must really be created");
		assert.equal(existsSync(handle.child.worktreePath!), true);
		assert.deepEqual(h.accepted, [{ name: handle.name, mode: "rpc", worktree: true }]);
	} finally {
		h.cleanup();
	}
});

test("arbitration: omitted spawnMode + worktree:false stays inprocess", async () => {
	const h = plainHarness("spawn-arb-no-worktree-");
	try {
		const orchestrator = new Orchestrator({ supervisor: h.supervisor, runDir: h.runDir, cwd: h.repo });
		const handle = await orchestrator.launch({ agent: agent(), task: "shared checkout", worktree: false });
		assert.equal(handle.child.worktreePath, undefined);
		assert.equal(h.accepted.length, 1);
		assert.equal(h.accepted[0]?.mode, "inprocess", "the default backend is used when nothing forces rpc");
		assert.equal(h.accepted[0]?.worktree, false, "the raw worktree:undefined must be normalized to false");
	} finally {
		h.cleanup();
	}
});

test("arbitration: an explicit rpc mode is never downgraded by a worktree", async () => {
	const h = plainHarness("spawn-arb-explicit-rpc-");
	try {
		const orchestrator = new Orchestrator({ supervisor: h.supervisor, runDir: h.runDir, cwd: h.repo });
		const handle = await orchestrator.launch({ agent: agent({ name: "centurion", spawnMode: "rpc", worktree: true }), task: "isolated rpc work" });
		assert.ok(handle.child.worktreePath);
		assert.deepEqual(h.accepted, [{ name: handle.name, mode: "rpc", worktree: true }]);
	} finally {
		h.cleanup();
	}
});

test("arbitration: explicit inprocess + worktree:true still throws INVALID_PARAMS (I1)", async () => {
	const h = plainHarness("spawn-arb-explicit-inprocess-");
	try {
		const orchestrator = new Orchestrator({ supervisor: h.supervisor, runDir: h.runDir, cwd: h.repo });
		// #214 D4 downgrades a non-centurion's worktree BEFORE this gate (warn, not
		// throw), so the surviving loud path is a centurion card. Both the
		// role-level and launch-level worktree must be loud.
		for (const launch of [
			{ agent: agent({ name: "centurion", spawnMode: "inprocess", worktree: true }), task: "conflict" },
			{ agent: agent({ name: "centurion", spawnMode: "inprocess" }), task: "conflict", worktree: true },
		]) {
			await assert.rejects(
				() => orchestrator.launch(launch),
				(error: unknown) => {
					assert.ok(error instanceof SubagentError);
					assert.equal(error.code, ErrorCodes.INVALID_PARAMS);
					// Pin the orchestrator's own wording (the TUI surfaces it).
					assert.match(error.message, /cannot use worktree isolation/);
					// #214 D5: the message must point at the new rule (worktree is
					// centurion-only) instead of "use spawnMode rpc" as the first fix.
					assert.match(error.message, /worktree is reserved for centurion/);
					assert.doesNotMatch(error.message, /use spawnMode "rpc"/);
					return true;
				},
				"arbitration must not soften an explicit inprocess + worktree combination",
			);
		}
		assert.deepEqual(h.accepted, [], "a refused combination never reaches the router");
	} finally {
		h.cleanup();
	}
});

test("arbitration: launch({worktree:false}) over a worktree:true role passes the real router (critical regression)", async () => {
	// Before the `worktree` normalization, the clone kept the role's raw
	// `worktree: true` while switching the mode to inprocess, so the real router
	// rejected it with "cannot combine with worktree: true". FakeSupervisor does
	// not check this combination, which is why the original test was a false green.
	const h = plainHarness("spawn-arb-override-");
	try {
		const orchestrator = new Orchestrator({ supervisor: h.supervisor, runDir: h.runDir, cwd: h.repo });
		const handle = await orchestrator.launch({ agent: workerCard(), task: "share the checkout", worktree: false });
		assert.equal(handle.child.worktreePath, undefined, "an explicit worktree:false must not create a worktree");
		assert.deepEqual(h.accepted, [{ name: handle.name, mode: "inprocess", worktree: false }]);
	} finally {
		h.cleanup();
	}
});

test("arbitration: centurion parent dispatching a worker card passes the real router (critical regression)", async () => {
	// THE production path. A centurion parent forces `worktree = false`
	// (`parentRole === "centurion"`), while `agents/worker.md` pins
	// `worktree: true` and sets no spawnMode. Before the normalization this threw
	// INVALID_PARAMS on every nested dispatch.
	const root = mkdtempSync(path.join(tmpdir(), "spawn-arb-centurion-"));
	try {
		const repo = gitRepo(root);
		const { supervisor, accepted } = realRouter();
		const store = new RunStore({ rootDir: path.join(repo, ".pi-subagents") });
		const rootRun = store.createRun({ task: "centurion parent", cwd: repo, maxDepth: 4, nodeId: "root", herdr: { supervisor: "rpc" } });
		const db = openLegionDb(legionDbPath(store.runDir(rootRun.runId)));
		try {
			insertNode(db, { id: "root", parentId: null, name: "root", role: "root", runId: rootRun.runId, status: "running" });
			insertNode(db, { id: "root.centurion-0", parentId: "root", name: "centurion-0", role: "centurion", runId: rootRun.runId, status: "running" });
			const orchestrator = new Orchestrator({
				supervisor,
				runDir: store.runDir(rootRun.runId),
				cwd: repo,
				maxDepth: 4,
				legion: {
					db,
					dbPath: legionDbPath(store.runDir(rootRun.runId)),
					nodeId: "root.centurion-0",
					runId: rootRun.runId,
					runStore: store,
					settings: { maxDepth: 4, maxChildrenPerNode: 8, maxActiveNodes: 30 },
					eventBus: createLegionEventBus(),
				},
			});
			const handle = await orchestrator.launch({ agent: workerCard(), task: "Implement the slice." });
			assert.equal(handle.child.worktreePath, undefined, "a centurion parent suppresses the worktree of its workers");
			assert.equal(handle.child.nodeId, "root.centurion-0.worker-0");
			assert.deepEqual(accepted, [{ name: handle.name, mode: "inprocess", worktree: false }]);
		} finally { db.close(); }
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

// ── D5/D8: the identity channel has a producer, not just consumers ──────────
//
// `childLaunchContext` is what carries lineage into an in-process child (it
// cannot use env: the child shares the parent's `process.env`). Consumers
// (`child-guard`, `index.ts`) read it, but a consumer-only channel is dead:
// every in-process child would silently fall back to "no nodeId / no dbPath"
// and never attach legion identity. This drives a REAL Orchestrator and
// asserts the supervisor actually receives the lineage.
test("identity: orchestrator passes legion lineage to an in-process child (D5)", async () => {
	const root = mkdtempSync(path.join(tmpdir(), "spawn-identity-"));
	const repo = gitRepo(root);
	const store = new RunStore({ rootDir: path.join(repo, ".pi-subagents") });
	const rootRun = store.createRun({ task: "identity", cwd: repo, maxDepth: 4, nodeId: "root", herdr: { supervisor: "rpc" } });
	const dbPath = legionDbPath(store.runDir(rootRun.runId));
	const db = openLegionDb(dbPath);
	const seen: unknown[] = [];
	const uiProxy = new InMemoryUIProxy();
	const record = (input: { name: string; sessionFile: string; childLaunchContext?: unknown }) => {
		seen.push(input.childLaunchContext);
		return { name: input.name, sessionFile: input.sessionFile, pid: 1 };
	};
	const supervisor = new RoutingSupervisor({
		rpc: { uiProxy, isAlive: () => false, spawnChild: async (i: never) => record(i) } as unknown as RpcSupervisor,
		inprocess: { uiProxy, isAlive: () => false, spawnChild: async (i: never) => record(i) } as unknown as InProcessSupervisor,
		uiProxy,
	});
	try {
		insertNode(db, { id: "root", parentId: null, name: "root", role: "root", runId: rootRun.runId, status: "running" });
		insertNode(db, { id: "root.centurion-0", parentId: "root", name: "centurion-0", role: "centurion", runId: rootRun.runId, status: "running" });
		const orchestrator = new Orchestrator({
			supervisor,
			runDir: store.runDir(rootRun.runId),
			cwd: repo,
			maxDepth: 4,
			legion: {
				db,
				dbPath,
				nodeId: "root.centurion-0",
				runId: rootRun.runId,
				runStore: store,
				settings: { maxDepth: 4, maxChildrenPerNode: 8, maxActiveNodes: 30 },
				eventBus: createLegionEventBus(),
			},
		});
		// A centurion parent suppresses the worktree, so this really goes in-process.
		const handle = await orchestrator.launch({ agent: workerCard(), task: "Implement the slice." });
		const ctx = seen[0] as { nodeId?: string; parentNodeId?: string; dbPath?: string; spawnMode?: string; utility?: boolean; allowNested?: boolean; parentPath?: unknown[] } | undefined;
		assert.ok(ctx, "an in-process spawn must carry a launch context");
		assert.equal(ctx.nodeId, handle.child.nodeId, "the child's own node id");
		assert.equal(ctx.parentNodeId, "root.centurion-0", "the dispatching node");
		assert.equal(ctx.dbPath, dbPath, "legion.db so the child can attach");
		assert.equal(ctx.spawnMode, "inprocess");
		// This orchestrator has no `deps.parentPath`, so `childPath(name)` is just
		// this run plus the child step — the point is that a real path is threaded
		// through (not undefined), and that its last entry names the child.
		assert.equal(ctx.parentPath?.length, 1, "a real nested path is threaded through");
		assert.deepEqual(
			(ctx.parentPath?.[0] as { agent?: string } | undefined)?.agent,
			handle.name,
			"the path's last step names this child",
		);
	} finally {
		db.close();
		rmSync(root, { recursive: true, force: true });
	}
});

// ── stripLegionIdentity must mask BOTH channels ─────────────────────────────
//
// vexillatio dispatches a read-only helper with `stripLegionIdentity: true` so
// it cannot adopt the caller's Legion tree identity. On the rpc backend that is
// done by deleting the PI_LEGION_* env keys; the in-process channel must mask
// the equivalent fields, otherwise the env keys are gone but the child still
// receives nodeId/dbPath through AsyncLocalStorage and attaches anyway.
test("identity: stripLegionIdentity masks node lineage on the in-process channel", async () => {
	const root = mkdtempSync(path.join(tmpdir(), "spawn-strip-"));
	const repo = gitRepo(root);
	const store = new RunStore({ rootDir: path.join(repo, ".pi-subagents") });
	const rootRun = store.createRun({ task: "strip", cwd: repo, maxDepth: 4, nodeId: "root", herdr: { supervisor: "rpc" } });
	const dbPath = legionDbPath(store.runDir(rootRun.runId));
	const db = openLegionDb(dbPath);
	const seen: unknown[] = [];
	const uiProxy = new InMemoryUIProxy();
	const record = (input: { name: string; sessionFile: string; childLaunchContext?: unknown }) => {
		seen.push(input.childLaunchContext);
		return { name: input.name, sessionFile: input.sessionFile, pid: 1 };
	};
	const supervisor = new RoutingSupervisor({
		rpc: { uiProxy, isAlive: () => false, spawnChild: async (i: never) => record(i) } as unknown as RpcSupervisor,
		inprocess: { uiProxy, isAlive: () => false, spawnChild: async (i: never) => record(i) } as unknown as InProcessSupervisor,
		uiProxy,
	});
	try {
		insertNode(db, { id: "root", parentId: null, name: "root", role: "root", runId: rootRun.runId, status: "running" });
		insertNode(db, { id: "root.centurion-0", parentId: "root", name: "centurion-0", role: "centurion", runId: rootRun.runId, status: "running" });
		const orchestrator = new Orchestrator({
			supervisor,
			runDir: store.runDir(rootRun.runId),
			cwd: repo,
			maxDepth: 4,
			legion: {
				db,
				dbPath,
				nodeId: "root.centurion-0",
				runId: rootRun.runId,
				runStore: store,
				settings: { maxDepth: 4, maxChildrenPerNode: 8, maxActiveNodes: 30 },
				eventBus: createLegionEventBus(),
			},
		});
		await orchestrator.launch({
			agent: workerCard(),
			task: "Stripped dispatch.",
			utilityDispatch: true,
			stripLegionIdentity: true,
		});
		const ctx = seen[0] as
			| { nodeId?: string; parentNodeId?: string; dbPath?: string; parentPath?: unknown[] }
			| undefined;
		assert.ok(ctx, "a stripped in-process spawn still gets a scope");
		assert.equal(ctx.nodeId, undefined, "no node id may leak through the ALS channel");
		assert.equal(ctx.dbPath, undefined, "no db path may leak through the ALS channel");
		assert.equal(ctx.parentNodeId, undefined, "no parent node may leak either");
		// Mirrors vexillatio.test.ts, which asserts PI_SUBAGENT_PARENT_PATH is
		// stripped on the rpc side: the path carries runId/agent lineage.
		assert.equal(ctx.parentPath, undefined, "the nested path is lineage too");
	} finally {
		db.close();
		rmSync(root, { recursive: true, force: true });
	}
});
