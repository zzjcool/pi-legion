/**
 * #214: worktree isolation is centurion-only.
 *
 * The invariant under test is a **launch-gate** invariant, so every case runs
 * against a REAL `RoutingSupervisor` (contract
 * `docs/contracts/spawn-default-inprocess-v3.md:221`: any assertion about a
 * `spawnMode × worktree` combination must use the real router — a
 * FakeSupervisor only checks `kind !== "pi"` and would accept the
 * self-contradictory `{spawnMode:"inprocess", worktree:true}` pair, i.e. a
 * false green). Only the would-be child processes are replaced by recording
 * stubs; the router's own guard runs for real.
 *
 * A real git repository is required because a granted worktree is really
 * created (`git worktree add`) — the negative cases assert no tree appears.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { Orchestrator, type OrchestratorLegionContext } from "../../src/runs/orchestrator.ts";
import { RoutingSupervisor } from "../../src/supervisor/routing-supervisor.ts";
import type { RpcSupervisor } from "../../src/supervisor/rpc-supervisor.ts";
import type { InProcessSupervisor } from "../../src/supervisor/inprocess-supervisor.ts";
import { InMemoryUIProxy } from "../../src/supervisor/ui-proxy.ts";
import { openLegionDb, legionDbPath } from "../../src/legion/db.ts";
import { getNode, insertNode } from "../../src/legion/nodes.ts";
import { RunStore } from "../../src/runs/store.ts";
import { createLegionEventBus } from "../../src/extension/event-bus.ts";
import type { AgentConfig } from "../../src/shared/types.ts";

interface RecordedSpawn {
	backend: "rpc" | "inprocess";
	name: string;
	mode: string | undefined;
	worktree: boolean | undefined;
	worktreeBranch: string | undefined;
	cwd: string;
}

/** A REAL `RoutingSupervisor` whose two backends only record the spawn input. */
function realRouter(): { supervisor: RoutingSupervisor; spawns: RecordedSpawn[] } {
	const spawns: RecordedSpawn[] = [];
	const record = (backend: "rpc" | "inprocess") =>
		async (input: {
			name: string;
			sessionFile: string;
			cwd: string;
			agent: AgentConfig;
			worktreeBranch?: string;
		}) => {
			spawns.push({
				backend,
				name: input.name,
				mode: input.agent.spawnMode,
				worktree: input.agent.worktree,
				worktreeBranch: input.worktreeBranch,
				cwd: input.cwd,
			});
			return { name: input.name, sessionFile: input.sessionFile, pid: backend === "rpc" ? 1001 : 1002 };
		};
	const uiProxy = new InMemoryUIProxy();
	const rpc = {
		uiProxy,
		isAlive: () => false,
		spawnChild: record("rpc"),
	} as unknown as RpcSupervisor;
	const inprocess = {
		uiProxy,
		isAlive: () => false,
		spawnChild: record("inprocess"),
	} as unknown as InProcessSupervisor;
	return { supervisor: new RoutingSupervisor({ rpc, inprocess, uiProxy }), spawns };
}

function agent(name: string, overrides: Partial<AgentConfig> = {}): AgentConfig {
	return {
		name,
		description: `${name} containment role`,
		systemPromptMode: "append",
		inheritProjectContext: true,
		inheritSkills: false,
		kind: "pi",
		systemPrompt: `You are a ${name}.`,
		source: "user",
		filePath: `/fixtures/${name}.md`,
		...overrides,
	};
}

function git(args: string[], cwd: string): string {
	return execFileSync("git", ["-C", cwd, ...args], { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
}

/** A throwaway repository with one empty commit, so `git worktree add` works. */
function initRepo(root: string): string {
	const repo = path.join(root, "repo");
	execFileSync("git", ["init", "-q", repo]);
	git(["-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-qm", "init"], repo);
	return repo;
}

/** Capture `console.warn` for the duration of `action` (mirrors nesting.test.ts). */
async function captureWarnings<T>(action: () => Promise<T>): Promise<{ warnings: string[]; result: T }> {
	const warnings: string[] = [];
	const previous = console.warn;
	console.warn = (...args: unknown[]) => warnings.push(args.map(String).join(" "));
	try {
		const result = await action();
		return { warnings, result };
	} finally {
		console.warn = previous;
	}
}

function worktreesIn(runDir: string): string[] {
	const dir = path.join(runDir, "worktrees");
	return existsSync(dir) ? readdirSync(dir) : [];
}

// ─────────────────────────────────────────────────────────────────────────────
// 1 + 2 + 7: a non-centurion that asks for a worktree is warned once, silently
// downgraded, and the launch still resolves.
// ─────────────────────────────────────────────────────────────────────────────

test("#214: an explicit worktree on a non-centurion is warned once and downgraded to a shared checkout", async () => {
	const root = mkdtempSync(path.join(tmpdir(), "wt-contain-downgrade-"));
	const repo = initRepo(root);
	const runDir = path.join(root, "run");
	const { supervisor, spawns } = realRouter();
	try {
		const orchestrator = new Orchestrator({ supervisor, runDir, cwd: repo });
		const { warnings, result: handle } = await captureWarnings(() =>
			// Exactly the `subagent({ worktree: true })` shape: the role itself
			// carries no worktree field, the launch asks for isolation.
			orchestrator.launch({ agent: agent("worker"), task: "isolate me", worktree: true }),
		);
		assert.equal(warnings.length, 1, "a violating launch warns exactly once");
		assert.match(warnings[0] ?? "", /^\[pi-legion\] worktree isolation is reserved for centurion/);
		assert.match(warnings[0] ?? "", /role 'worker' was downgraded to worktree: false/);
		assert.match(warnings[0] ?? "", /Dispatch a centurion when you need an isolated subtree/);
		assert.equal(handle.child.worktreePath, undefined, "no worktree may be handed to a non-centurion");
		assert.deepEqual(worktreesIn(runDir), [], "no worktree directory is created");
		assert.deepEqual(
			spawns.map((spawn) => ({ backend: spawn.backend, mode: spawn.mode, worktree: spawn.worktree, branch: spawn.worktreeBranch })),
			[{ backend: "inprocess", mode: "inprocess", worktree: false, branch: undefined }],
			"the downgraded launch runs in-process with worktree: false (the real router accepted it)",
		);
		assert.equal(spawns[0]?.cwd, repo, "the child shares the parent checkout");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("#214: the worktree warning is emitted once per Orchestrator instance", async () => {
	const root = mkdtempSync(path.join(tmpdir(), "wt-contain-once-"));
	const repo = initRepo(root);
	const runDir = path.join(root, "run");
	const { supervisor, spawns } = realRouter();
	try {
		const orchestrator = new Orchestrator({ supervisor, runDir, cwd: repo });
		const { warnings } = await captureWarnings(async () => {
			await orchestrator.launch({ agent: agent("worker"), task: "first", worktree: true });
			await orchestrator.launch({ agent: agent("worker"), task: "second", worktree: true });
			await orchestrator.launch({ agent: agent("reviewer", { worktree: true }), task: "third" });
		});
		assert.equal(warnings.length, 1, "three violations, one warning (one-shot per instance)");
		assert.equal(spawns.length, 3, "every violating launch still spawns — downgrading never fails a launch");
		assert.ok(spawns.every((spawn) => spawn.worktree === false), "all three were downgraded");
		assert.ok(spawns.every((spawn) => spawn.backend === "inprocess"), "all three stayed on the default backend");
		// A fresh instance warns again: the flag is per Orchestrator, like depthWarningEmitted.
		const { warnings: second } = await captureWarnings(() =>
			new Orchestrator({ supervisor, runDir, cwd: repo }).launch({ agent: agent("worker"), task: "fresh", worktree: true }),
		);
		assert.equal(second.length, 1, "a new instance emits its own one-shot warning");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("#214: a worktree violation never throws — the launch resolves", async () => {
	const root = mkdtempSync(path.join(tmpdir(), "wt-contain-nothrow-"));
	const repo = initRepo(root);
	const runDir = path.join(root, "run");
	const { supervisor } = realRouter();
	try {
		const orchestrator = new Orchestrator({ supervisor, runDir, cwd: repo });
		await captureWarnings(async () => {
			await assert.doesNotReject(
				() => orchestrator.launch({ agent: agent("worker", { worktree: true }), task: "must not throw" }),
				"a non-centurion worktree request is downgraded, never rejected",
			);
			await assert.doesNotReject(
				() => orchestrator.launch({ agent: agent("scout"), task: "launch-level flag", worktree: true }),
				"the launch-level worktree flag is downgraded too",
			);
		});
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

// ─────────────────────────────────────────────────────────────────────────────
// 3: a centurion card gets a worktree and the rpc backend, with spawnMode omitted.
// ─────────────────────────────────────────────────────────────────────────────

test("#214: a centurion card gets a subtree worktree on the rpc backend (spawnMode omitted)", async () => {
	const root = mkdtempSync(path.join(tmpdir(), "wt-contain-centurion-"));
	const repo = initRepo(root);
	const runDir = path.join(root, "run");
	const { supervisor, spawns } = realRouter();
	try {
		const orchestrator = new Orchestrator({ supervisor, runDir, cwd: repo });
		const { warnings, result: handle } = await captureWarnings(() =>
			// Exactly `agents/centurion.md`: `worktree: true`, no spawnMode.
			orchestrator.launch({ agent: agent("centurion", { allowNestedSubagents: true, worktree: true }), task: "lead a squad" }),
		);
		assert.deepEqual(warnings, [], "a centurion is never warned");
		assert.ok(handle.child.worktreePath, "the centurion really gets a worktree");
		assert.equal(existsSync(handle.child.worktreePath!), true);
		assert.ok(handle.child.worktreeBranch, "and a branch to ship from");
		assert.deepEqual(worktreesIn(runDir).length, 1);
		assert.deepEqual(
			spawns.map((spawn) => ({ backend: spawn.backend, mode: spawn.mode, worktree: spawn.worktree })),
			[{ backend: "rpc", mode: "rpc", worktree: true }],
			"an omitted spawnMode arbitrates to rpc when a worktree is needed",
		);
		assert.equal(spawns[0]?.cwd, handle.child.worktreePath, "the child runs inside its worktree");
		// The card is `agents/centurion.md`'s shape: `worktree: true` is redundant
		// with the gate, but pinning it must not change anything.
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

// ─────────────────────────────────────────────────────────────────────────────
// 4: §9 — a centurion parent's members never get a worktree.
// ─────────────────────────────────────────────────────────────────────────────

/** Root dispatches a centurion; returns a live legion context for that centurion. */
function containmentTree(): {
	root: string;
	repo: string;
	store: RunStore;
	db: ReturnType<typeof openLegionDb>;
	dbPath: string;
	rootRunId: string;
	settings: { maxDepth: number; maxChildrenPerNode: number; maxActiveNodes: number };
	cleanup(): void;
} {
	const root = mkdtempSync(path.join(tmpdir(), "wt-contain-tree-"));
	const repo = initRepo(root);
	const store = new RunStore({ rootDir: path.join(repo, ".pi-subagents") });
	const run = store.createRun({ task: "containment tree", cwd: repo, maxDepth: 4, nodeId: "root", herdr: { supervisor: "rpc" } });
	const dbPath = legionDbPath(store.runDir(run.runId));
	const db = openLegionDb(dbPath);
	insertNode(db, { id: "root", parentId: null, name: "root", role: "root", runId: run.runId, status: "running" });
	return {
		root,
		repo,
		store,
		db,
		dbPath,
		rootRunId: run.runId,
		settings: { maxDepth: 4, maxChildrenPerNode: 8, maxActiveNodes: 30 },
		cleanup: () => {
			db.close();
			rmSync(root, { recursive: true, force: true });
		},
	};
}

function legionFor(
	ctx: ReturnType<typeof containmentTree>,
	nodeId: string,
	runId: string,
): OrchestratorLegionContext {
	return {
		db: ctx.db,
		dbPath: ctx.dbPath,
		nodeId,
		runId,
		runStore: ctx.store,
		settings: ctx.settings,
		eventBus: createLegionEventBus(),
	};
}

test("#214: a centurion parent dispatches a worker with no worktree, on the in-process backend", async () => {
	const ctx = containmentTree();
	const { supervisor, spawns } = realRouter();
	try {
		// The centurion node is inserted directly: this case is about the
		// centurion → member boundary, not about spawning the centurion itself.
		const parentRun = ctx.store.createRun({ task: "centurion subtree", cwd: ctx.repo, maxDepth: 4, nodeId: "root.centurion-0", herdr: { supervisor: "rpc" } });
		insertNode(ctx.db, { id: "root.centurion-0", parentId: "root", name: "centurion-0", role: "centurion", runId: parentRun.runId, status: "running" });
		const centurion = new Orchestrator({
			supervisor,
			runDir: ctx.store.runDir(parentRun.runId),
			cwd: ctx.repo,
			maxDepth: 4,
			legion: legionFor(ctx, "root.centurion-0", parentRun.runId),
		});
		const { warnings, result: worker } = await captureWarnings(async () => {
			// The shipped worker card (agents/worker.md): worktree: false, no spawnMode.
			const plain = await centurion.launch({ agent: agent("worker", { worktree: false }), task: "implement a slice" });
			// Worst case: a user card that still pins worktree: true must also be
			// suppressed by the parent role, not downgraded by the gate.
			const pinned = await centurion.launch({ agent: agent("worker", { worktree: true }), task: "pinned card" });
			return { plain, pinned };
		});
		assert.deepEqual(warnings, [], "a centurion's member is suppressed by role, so nothing is warned");
		assert.equal(worker.plain.child.worktreePath, undefined);
		assert.equal(worker.pinned.child.worktreePath, undefined, "a pinned worktree on a member is suppressed");
		assert.deepEqual(worktreesIn(ctx.store.runDir(parentRun.runId)), [], "no worktree is created for any member");
		assert.deepEqual(
			spawns.map((spawn) => ({ backend: spawn.backend, mode: spawn.mode, worktree: spawn.worktree })),
			[
				{ backend: "inprocess", mode: "inprocess", worktree: false },
				{ backend: "inprocess", mode: "inprocess", worktree: false },
			],
			"members run in the centurion's process with worktree: false",
		);
		assert.ok(spawns.every((spawn) => spawn.cwd === ctx.repo), "members share the parent checkout");
	} finally {
		ctx.cleanup();
	}
});

// ─────────────────────────────────────────────────────────────────────────────
// 5: a nested centurion gets its own nested worktree (§9).
// ─────────────────────────────────────────────────────────────────────────────

test("#214: a nested centurion gets a nested worktree instead of being suppressed", async () => {
	const ctx = containmentTree();
	const { supervisor, spawns } = realRouter();
	try {
		const outerRun = ctx.store.createRun({ task: "outer centurion", cwd: ctx.repo, maxDepth: 4, nodeId: "root.centurion-0", herdr: { supervisor: "rpc" } });
		insertNode(ctx.db, { id: "root.centurion-0", parentId: "root", name: "centurion-0", role: "centurion", runId: outerRun.runId, status: "running" });
		const outer = new Orchestrator({
			supervisor,
			runDir: ctx.store.runDir(outerRun.runId),
			cwd: ctx.repo,
			maxDepth: 4,
			legion: legionFor(ctx, "root.centurion-0", outerRun.runId),
		});
		const outerCenturion = await outer.launch({ agent: agent("centurion", { allowNestedSubagents: true, worktree: true }), task: "outer" });
		const outerWorktree = outerCenturion.child.worktreePath;
		assert.ok(outerWorktree, "the outer centurion holds a worktree");
		const outerNode = getNode(ctx.db, outerCenturion.child.nodeId!)!;
		const outerChildRun = ctx.store.readRun(outerNode.runId!)!;

		// The nested centurion runs *inside* the outer worktree — that is exactly
		// the shape the pre-#214 nested-suppression rule used to flatten.
		const nested = new Orchestrator({
			supervisor,
			runDir: ctx.store.runDir(outerChildRun.runId),
			cwd: outerWorktree,
			maxDepth: 4,
			legion: legionFor(ctx, outerNode.id, outerChildRun.runId),
		});
		const { warnings, result: nestedCenturion } = await captureWarnings(() =>
			nested.launch({ agent: agent("centurion", { allowNestedSubagents: true, worktree: true }), task: "nested" }),
		);
		assert.deepEqual(warnings, [], "a nested centurion is legitimate and is never warned");
		assert.ok(nestedCenturion.child.worktreePath, "the nested centurion gets a nested worktree");
		assert.notEqual(nestedCenturion.child.worktreePath, outerWorktree, "it is a NEW tree, not the parent's");
		assert.equal(existsSync(nestedCenturion.child.worktreePath!), true);
		assert.deepEqual(
			spawns.map((spawn) => ({ backend: spawn.backend, mode: spawn.mode, worktree: spawn.worktree })),
			[
				{ backend: "rpc", mode: "rpc", worktree: true },
				{ backend: "rpc", mode: "rpc", worktree: true },
			],
			"both generations run on rpc with their own worktree",
		);
	} finally {
		ctx.cleanup();
	}
});

// ─────────────────────────────────────────────────────────────────────────────
// 6: the recommended shape end to end — root → 2 centurions → workers.
// ─────────────────────────────────────────────────────────────────────────────

test("#214: recommended shape — root dispatches 2 centurions, each centurion dispatches in-process workers", async () => {
	const ctx = containmentTree();
	const { supervisor, spawns } = realRouter();
	try {
		const root = new Orchestrator({
			supervisor,
			runDir: ctx.store.runDir(ctx.rootRunId),
			cwd: ctx.repo,
			maxDepth: 4,
			legion: legionFor(ctx, "root", ctx.rootRunId),
		});
		const { warnings, result: centurions } = await captureWarnings(async () => {
			const first = await root.launch({ agent: agent("centurion", { allowNestedSubagents: true, worktree: true }), task: "squad A", team: "be-value" });
			const second = await root.launch({ agent: agent("centurion", { allowNestedSubagents: true, worktree: true }), task: "squad B", team: "be-value" });
			return [first, second];
		});
		assert.deepEqual(warnings, [], "no warning in the recommended shape");
		assert.equal(new Set(centurions.map((handle) => handle.child.worktreePath)).size, 2, "2 distinct worktrees");

		const workerSpawns: Array<{ spawn: RecordedSpawn; worktreePath: string }> = [];
		for (const centurion of centurions) {
			const node = getNode(ctx.db, centurion.child.nodeId!)!;
			const run = ctx.store.readRun(node.runId!)!;
			const team = new Orchestrator({
				supervisor,
				runDir: ctx.store.runDir(run.runId),
				cwd: centurion.child.worktreePath!,
				maxDepth: 4,
				legion: legionFor(ctx, node.id, run.runId),
			});
			const before = spawns.length;
			const worker = await team.launch({ agent: agent("worker", { worktree: false }), task: `slice for ${node.name}` });
			assert.equal(worker.child.worktreePath, undefined, "a worker never gets its own worktree");
			assert.deepEqual(worktreesIn(ctx.store.runDir(run.runId)), [], "the centurion's subtree creates no extra worktree");
			for (const spawn of spawns.slice(before)) workerSpawns.push({ spawn, worktreePath: centurion.child.worktreePath! });
		}

		const rpcSpawns = spawns.filter((spawn) => spawn.backend === "rpc");
		const inprocessSpawns = spawns.filter((spawn) => spawn.backend === "inprocess");
		assert.equal(rpcSpawns.length, 2, "exactly 2 rpc child processes — one per centurion");
		assert.ok(rpcSpawns.every((spawn) => spawn.mode === "rpc"), "centurions run on rpc");
		assert.ok(rpcSpawns.every((spawn) => spawn.worktree === true), "centurions own a worktree");
		assert.equal(new Set(rpcSpawns.map((spawn) => spawn.worktreeBranch)).size, 2, "2 distinct branches");
		assert.equal(inprocessSpawns.length, 2, "both workers ran in-process (no extra process)");
		assert.ok(inprocessSpawns.every((spawn) => spawn.mode === "inprocess"), "worker spawnMode is inprocess");
		assert.ok(inprocessSpawns.every((spawn) => spawn.worktreeBranch === undefined), "a worker has no worktree branch");
		assert.equal(workerSpawns.length, 2, "one worker spawn per centurion");
		assert.deepEqual(workerSpawns.map((entry) => entry.spawn), inprocessSpawns, "the workers ARE the in-process spawns");
		for (const entry of workerSpawns) {
			assert.equal(entry.spawn.cwd, entry.worktreePath, "each worker runs inside its own centurion's worktree");
		}
	} finally {
		ctx.cleanup();
	}
});
