/**
 * #451: a launch may override the role card's `worktree`.
 *
 * The measured bug: `agents/centurion.md` pins `worktree: true`, and the Legion
 * branch of the arbitration hardcoded `true` on top of that, so
 * `subagent({agent:"centurion", worktree:false})` had NO expression at all — a
 * centurion could not be told to work inside an existing checkout. The workaround
 * (N workers + pre-built worktrees + `cwd`) is write-equivalent but does not
 * record `node.worktreePath`, and that missing ledger fact is what makes resume
 * silently fall back to the record cwd.
 *
 * These tests pin both directions, the audit field, and the mutation traps:
 *
 *  1. explicit `worktree:false` on a centurion → spawn cwd is THIS checkout, no
 *     tree is created, `nodes.worktree_path` is SQL **NULL** (not undefined, not
 *     the cwd), and `worktreeSource=request` is visible in status;
 *  2. no argument at all → today's behaviour byte for byte (a real tree, rpc,
 *     `worktreeSource=role`);
 *  3. an explicit opt-out never resurrects the previous launch's tree (the
 *     "null recorded as a path" mutation dies here);
 *  4. #214's reverse rule is untouched: a non-centurion asking `true` is still
 *     demoted, warned once, and lands with no tree.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { renderStatusOverview } from "../../index.ts";
import { renderLiveChildStatus } from "../../src/extension/runtime.ts";
import { createLegionEventBus } from "../../src/extension/event-bus.ts";
import { openLegionDb, legionDbPath } from "../../src/legion/db.ts";
import { getChildByName, getNode, insertNode, type LegionNode } from "../../src/legion/nodes.ts";
import { Orchestrator } from "../../src/runs/orchestrator.ts";
import { RunStore } from "../../src/runs/store.ts";
import type { AgentConfig } from "../../src/shared/types.ts";
import type { SpawnInput } from "../../src/supervisor/types.ts";
import { FakeSupervisor } from "../helpers/fake-supervisor.ts";

function agent(name: string, over: Partial<AgentConfig> = {}): AgentConfig {
	return {
		name,
		description: `${name} #451 fixture role`,
		systemPromptMode: "append",
		inheritProjectContext: false,
		inheritSkills: false,
		kind: "pi",
		systemPrompt: `You are the ${name}.`,
		source: "project",
		filePath: `/fixtures/${name}.md`,
		...over,
	};
}

/** `agents/centurion.md` as the catalog loads it: the card pins worktree:true. */
function centurionCard(): AgentConfig {
	return agent("centurion", { worktree: true, allowNestedSubagents: true, maxSubagentDepth: 2 });
}

interface Fixture {
	repo: string;
	runDir: string;
	store: RunStore;
	db: ReturnType<typeof openLegionDb>;
	rootRunId: string;
	supervisor: FakeSupervisor;
	orchestrator: Orchestrator;
	cleanup(): void;
}

function fixture(label: string): Fixture {
	const sandbox = mkdtempSync(path.join(tmpdir(), `legion-451-${label}-`));
	const repo = path.join(sandbox, "repo");
	mkdirSync(repo, { recursive: true });
	const git = (args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "ignore" });
	git(["init", "-q"]);
	git(["config", "user.email", "legion-test@example.invalid"]);
	git(["config", "user.name", "Legion integration test"]);
	writeFileSync(path.join(repo, "README.md"), "#451 fixture\n");
	git(["add", "README.md"]);
	git(["commit", "-q", "-m", "fixture"]);

	const store = new RunStore({ rootDir: path.join(repo, ".pi-subagents") });
	const rootRun = store.createRun({
		task: "worktree override fixture",
		cwd: repo,
		maxDepth: 4,
		nodeId: "root",
		herdr: { supervisor: "rpc" },
	});
	const dbPath = legionDbPath(store.runDir(rootRun.runId));
	const db = openLegionDb(dbPath);
	insertNode(db, { id: "root", parentId: null, name: "root", role: "root", runId: rootRun.runId, status: "running" });
	const supervisor = new FakeSupervisor();
	const orchestrator = new Orchestrator({
		supervisor,
		runDir: store.runDir(rootRun.runId),
		cwd: repo,
		maxDepth: 4,
		legion: {
			db,
			dbPath,
			nodeId: "root",
			runId: rootRun.runId,
			runStore: store,
			settings: { maxDepth: 4, maxChildrenPerNode: 8, maxActiveNodes: 30 },
			eventBus: createLegionEventBus(),
		},
	});
	return {
		repo,
		runDir: store.runDir(rootRun.runId),
		store,
		db,
		rootRunId: rootRun.runId,
		supervisor,
		orchestrator,
		cleanup: () => {
			db.close();
			rmSync(sandbox, { recursive: true, force: true });
		},
	};
}

test("#451 acceptance 1: a centurion launched with worktree:false works in THIS checkout and records NULL", async () => {
	const fx = fixture("override");
	// The ledger row is written BEFORE the spawn and then refreshed once the
	// launch settles; a "record the cwd as worktreePath" regression can be
	// healed by the refresh, so the reservation itself is sampled here.
	let nodeWhenSpawned: LegionNode | null | undefined;
	const realSpawn = fx.supervisor.spawnChild.bind(fx.supervisor);
	fx.supervisor.spawnChild = async (input: SpawnInput) => {
		nodeWhenSpawned = getChildByName(fx.db, "root", "centurion-0") ?? null;
		return realSpawn(input);
	};
	try {
		const handle = await fx.orchestrator.launch({
			agent: centurionCard(),
			task: "Work inside the existing checkout.",
			name: "centurion-0",
			worktree: false,
		});
		const spawned = fx.supervisor.spawns.at(-1);
		assert.ok(spawned, "the launch reached a supervisor");
		assert.equal(spawned.input.cwd, fx.repo, "cwd is the checkout the caller is in");
		assert.equal(spawned.input.agent.worktree, false, "the spawn sees no isolation");
		assert.equal(handle.child.worktreePath, undefined, "no tree path on the child record");
		assert.equal(handle.child.worktreeSource, "request", "the caller's argument decided");
		assert.equal(existsSync(path.join(fx.runDir, "worktrees")), false, "no tree was created");

		const node = getNode(fx.db, handle.child.nodeId!);
		assert.ok(node, "the ledger row exists");
		// The mutation trap: `undefined` (field never written) and the record cwd
		// (the silent `worktreePath ?? cwd` fallback) must BOTH fail here.
		assert.equal(node.worktreePath, null, "nodes.worktree_path is SQL NULL");
		assert.notEqual(node.worktreePath, fx.repo, "the cwd is not smuggled into worktree_path");
		assert.equal(node.worktreePath === undefined, false, "NULL is not 'missing'");
		assert.ok(nodeWhenSpawned, "the reservation row was observable at spawn time");
		assert.equal(nodeWhenSpawned.worktreePath, null, "the reservation wrote NULL too, not a placeholder path");

		// The audit fact lands at reservation time, so a fresh process reading
		// run.json already sees it.
		const persisted = fx.store.findChild(fx.rootRunId, "centurion-0");
		assert.equal(persisted?.worktreeSource, "request", "run.json carries the source");
		assert.equal(persisted?.worktreePath, undefined, "run.json carries no tree path");

		const status = renderStatusOverview([{ child: handle.child, alive: true }], Date.now());
		assert.match(status, /worktreeSource=request worktree=none/);
	} finally {
		fx.cleanup();
	}
});

test("#451 acceptance 2: no worktree argument keeps today's behaviour byte for byte (tree + source=role)", async () => {
	const fx = fixture("default");
	try {
		const handle = await fx.orchestrator.launch({
			agent: centurionCard(),
			task: "Lead the squad.",
			name: "centurion-0",
		});
		const tree = path.join(fx.runDir, "worktrees", "centurion-0");
		assert.equal(handle.child.worktreePath, tree, "the role default still creates a tree");
		assert.ok(handle.child.worktreeBranch?.startsWith("pi-subagent/centurion-0-"));
		assert.equal(handle.child.worktreeSource, "role", "the card decided");
		assert.equal(handle.spawnMode, "rpc", "isolation still implies rpc outside hc");
		assert.equal(fx.supervisor.spawns.at(-1)?.input.cwd, tree, "the child runs in its tree");
		assert.equal(getNode(fx.db, handle.child.nodeId!)?.worktreePath, tree);

		const persisted = fx.store.findChild(fx.rootRunId, "centurion-0");
		assert.equal(persisted?.worktreeSource, "role");
		assert.equal(persisted?.worktreePath, tree);

		const status = renderStatusOverview([{ child: handle.child, alive: true }], Date.now());
		assert.match(status, /worktreeSource=role worktree=pi-subagent\/centurion-0-/);
	} finally {
		fx.cleanup();
	}
});

test("#451 acceptance 3 (mutation): an explicit opt-out never resurrects the previous launch's tree", async () => {
	const fx = fixture("optout-resume");
	try {
		const first = await fx.orchestrator.launch({
			agent: centurionCard(),
			task: "First stint in a tree.",
			name: "centurion-0",
		});
		const oldTree = first.child.worktreePath!;
		assert.ok(oldTree);
		await fx.orchestrator.retire("centurion-0");

		const second = await fx.orchestrator.launch({
			agent: centurionCard(),
			task: "Second stint in place.",
			name: "centurion-0",
			worktree: false,
		});
		assert.equal(second.child.worktreePath, undefined, "the old tree is not reused");
		assert.equal(second.child.worktreeBranch, undefined, "the old branch is not carried");
		assert.equal(second.child.worktreeSource, "request");
		assert.equal(fx.supervisor.spawns.at(-1)?.input.cwd, fx.repo, "the child runs in the caller's checkout");
		const node = getNode(fx.db, second.child.nodeId!);
		assert.equal(node?.worktreePath, null, "the revive wrote NULL over the old path");

		const persisted = fx.store.findChild(fx.rootRunId, "centurion-0");
		assert.equal(persisted?.worktreePath, undefined, "run.json no longer points at the old tree");
		assert.equal(persisted?.worktreeSource, "request");
	} finally {
		fx.cleanup();
	}
});

test("#451 (reverse unchanged): a non-centurion asking worktree:true is still demoted, with no tree", async () => {
	const fx = fixture("demote");
	try {
		const handle = await fx.orchestrator.launch({
			agent: agent("worker", { worktree: true }),
			task: "Try to grab a tree.",
			name: "worker-0",
			worktree: true,
		});
		assert.equal(handle.child.worktreePath, undefined, "#214 still demotes the request");
		assert.equal(fx.supervisor.spawns.at(-1)?.input.cwd, fx.repo);
		assert.equal(fx.supervisor.spawns.at(-1)?.input.agent.worktree, false);
		assert.equal(getNode(fx.db, handle.child.nodeId!)?.worktreePath, null);
		assert.equal(existsSync(path.join(fx.runDir, "worktrees")), false);
	} finally {
		fx.cleanup();
	}
});

test("#451: a legacy record with no worktreeSource grows no status line (byte-identical output)", () => {
	const text = renderLiveChildStatus({
		name: "worker-0",
		state: "working",
		agent: "worker",
		kind: "pi",
		sessionFile: path.join(tmpdir(), "legion-451-legacy.jsonl"),
		spawnMode: "inprocess",
		alive: false,
	});
	assert.doesNotMatch(text, /worktreeSource=/);
});
