import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
	DEFAULT_LEGION_SETTINGS,
	ErrorCodes,
	SubagentError,
	type AgentConfig,
} from "../../src/shared/types.ts";
import { parseSubagentSettings, resolveSubagentSettings } from "../../src/agents/settings.ts";
import { RunStore } from "../../src/runs/store.ts";
import { effectiveMaxDepth, Orchestrator } from "../../src/runs/orchestrator.ts";
import { FakeSupervisor } from "../helpers/fake-supervisor.ts";

const MAX_DEPTH_ENV = "PI_SUBAGENT_MAX_DEPTH";
const PARENT_PATH_ENV = "PI_SUBAGENT_PARENT_PATH";

async function withEnvironment<T>(values: Record<string, string | undefined>, action: () => Promise<T>): Promise<T> {
	const saved = Object.keys(values).map((key) => [key, process.env[key]] as const);
	for (const [key, value] of Object.entries(values)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	try { return await action(); }
	finally {
		for (const [key, value] of saved) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

/**
 * Role pinned to the RPC backend.
 *
 * Every gate in this file is RPC-only: the nested `PI_SUBAGENT_MAX_DEPTH`
 * ceiling is carried in the child's env (the RPC lineage channel) and the
 * spawn budget is asserted by `assertWithinBudgets`, which in-process children
 * deliberately skip in favour of `subagents.inprocess.*`. With `inprocess` as
 * the default backend these launches would silently bypass both, so the mode
 * is pinned here to keep the RPC semantics under test.
 */
function role(name: string, maxSubagentDepth?: number): AgentConfig {
	return {
		name, description: name, systemPromptMode: "append", inheritProjectContext: true,
		inheritSkills: false, kind: "pi", systemPrompt: "role prompt", source: "user",
		filePath: `/${name}.md`, allowNestedSubagents: true, spawnMode: "rpc",
		...(maxSubagentDepth !== undefined ? { maxSubagentDepth } : {}),
	};
}

function pathAtDepth(depth: number): Array<{ runId: string; agent: string }> {
	return Array.from({ length: depth }, (_, index) => ({ runId: `r-level-${index}`, agent: `agent-${index}` }));
}

const isolatedEnv = {
	PI_SUBAGENT_ALLOW_NESTED: undefined,
	PI_SUBAGENT_CHILD: undefined,
	PI_SUBAGENT_MAX_DEPTH: undefined,
	PI_SUBAGENT_PARENT_PATH: undefined,
};

async function spawnAt(input: {
	roleName: string;
	name: string;
	parentDepth: number;
	parentMaxDepth: number;
	roleMaxDepth?: number;
}): Promise<{ childMaxDepth: number; supervisor: FakeSupervisor; runDir: string; cleanup(): void }> {
	const runDir = mkdtempSync(path.join(tmpdir(), "legion-rpc-nesting-"));
	const supervisor = new FakeSupervisor();
	const orchestrator = new Orchestrator({
		supervisor, runDir, cwd: "/tmp/project", parentPath: pathAtDepth(input.parentDepth), maxDepth: input.parentMaxDepth,
	});
	await orchestrator.launch({ agent: role(input.roleName, input.roleMaxDepth), task: `launch ${input.name}`, name: input.name, worktree: false });
	const raw = supervisor.spawns[0]?.input.env?.[MAX_DEPTH_ENV];
	assert.ok(raw, "RPC child receives a depth ceiling");
	return { childMaxDepth: Number(raw), supervisor, runDir, cleanup: () => rmSync(runDir, { recursive: true, force: true }) };
}

async function assertLaunchRefused(input: { parentDepth: number; parentMaxDepth: number }): Promise<void> {
	const runDir = mkdtempSync(path.join(tmpdir(), "legion-rpc-nesting-refused-"));
	const supervisor = new FakeSupervisor();
	const orchestrator = new Orchestrator({ supervisor, runDir, cwd: "/tmp/project", parentPath: pathAtDepth(input.parentDepth), maxDepth: input.parentMaxDepth });
	try {
		await assert.rejects(
			() => orchestrator.launch({ agent: role("leaf"), task: "must refuse" }),
			(error: unknown) => error instanceof SubagentError && error.code === ErrorCodes.BUDGET_EXCEEDED,
		);
		assert.equal(supervisor.spawns.length, 0, "budget refusal must not spawn an RPC process");
	} finally { rmSync(runDir, { recursive: true, force: true }); }
}

function childOrchestrator(supervisor: FakeSupervisor, env: Record<string, string>): { orchestrator: Orchestrator; runDir: string } {
	const runDir = mkdtempSync(path.join(tmpdir(), "legion-rpc-depth-child-"));
	return {
		runDir,
		orchestrator: new Orchestrator({
			supervisor,
			runDir,
			cwd: "/tmp/project",
			parentPath: JSON.parse(env[PARENT_PATH_ENV] ?? "[]") as Array<{ runId: string; agent: string }>,
			maxDepth: Number(env[MAX_DEPTH_ENV]),
		}),
	};
}

test("M0 legion settings use contract defaults and merge individual fields", () => {
	const user = parseSubagentSettings({ subagents: { legion: { maxDepth: 2, phaseTimeouts: { planning: 1000, reviewing: 3000 } } } }, "/user/settings.json");
	const project = parseSubagentSettings({ subagents: { legion: { maxDepth: 3, phaseTimeouts: { verifying: 4000 } } } }, "/project/settings.json");
	assert.deepEqual(user.legion, { ...DEFAULT_LEGION_SETTINGS, maxDepth: 2, phaseTimeouts: { ...DEFAULT_LEGION_SETTINGS.phaseTimeouts, planning: 1000, reviewing: 3000 } });
	assert.deepEqual(resolveSubagentSettings(user, project).legion, { ...DEFAULT_LEGION_SETTINGS, maxDepth: 3, phaseTimeouts: { ...DEFAULT_LEGION_SETTINGS.phaseTimeouts, planning: 1000, reviewing: 3000, verifying: 4000 } });
});

test("M0 nesting a/b/b2/b3: role caps tighten the inherited max depth", async () => {
	await withEnvironment(isolatedEnv, async () => {
		const a = await spawnAt({ roleName: "x", name: "x", parentDepth: 0, parentMaxDepth: 4, roleMaxDepth: 1 });
		assert.equal(a.childMaxDepth, 1);
		a.cleanup();
		await assertLaunchRefused({ parentDepth: 1, parentMaxDepth: 1 });

		const b = await spawnAt({ roleName: "x", name: "x", parentDepth: 0, parentMaxDepth: 4, roleMaxDepth: 2 });
		assert.equal(b.childMaxDepth, 2);
		b.cleanup();
		await assertLaunchRefused({ parentDepth: 2, parentMaxDepth: 2 });

		const b2 = await spawnAt({ roleName: "y", name: "y", parentDepth: 1, parentMaxDepth: 3, roleMaxDepth: 2 });
		assert.equal(b2.childMaxDepth, 3);
		b2.cleanup();

		const b3 = await spawnAt({ roleName: "y", name: "y", parentDepth: 1, parentMaxDepth: 2, roleMaxDepth: 4 });
		assert.equal(b3.childMaxDepth, 2, "a child role cannot widen the parent's ceiling");
		const grandchild = childOrchestrator(b3.supervisor, b3.supervisor.spawns[0]?.input.env ?? {});
		try {
			await assert.rejects(
				() => grandchild.orchestrator.launch({ agent: role("leaf"), task: "must remain a leaf" }),
				(error: unknown) => error instanceof SubagentError && error.code === ErrorCodes.BUDGET_EXCEEDED,
			);
			assert.equal(b3.supervisor.spawns.length, 1, "tightened child must not spawn beyond the parent ceiling");
		} finally {
			rmSync(grandchild.runDir, { recursive: true, force: true });
			b3.cleanup();
		}
	});
});

test("M0 nesting c1: a leaf worker cannot dispatch, while its centurion may dispatch an advisor", async () => {
	await withEnvironment(isolatedEnv, async () => {
		const centurion = await spawnAt({ roleName: "centurion", name: "centurion", parentDepth: 0, parentMaxDepth: 4, roleMaxDepth: 2 });
		const manager = childOrchestrator(centurion.supervisor, centurion.supervisor.spawns[0]?.input.env ?? {});
		await manager.orchestrator.launch({ agent: role("worker", 1), task: "leaf worker", name: "worker", worktree: false });
		const workerEnv = centurion.supervisor.spawns.at(-1)?.input.env ?? {};
		assert.equal(Number(workerEnv[MAX_DEPTH_ENV]), 2);
		const leaf = childOrchestrator(centurion.supervisor, workerEnv);
		try {
			await assert.rejects(
				() => leaf.orchestrator.launch({ agent: role("grandchild"), task: "refuse", worktree: false }),
				(error: unknown) => error instanceof SubagentError && error.code === ErrorCodes.BUDGET_EXCEEDED,
			);
			const advisor = await manager.orchestrator.launch({ agent: role("advisor", 1), task: "centurion can still dispatch", name: "advisor", worktree: false });
			assert.equal(advisor.child.agent, "advisor");
			assert.equal(centurion.supervisor.spawns.length, 3);
		} finally {
			rmSync(leaf.runDir, { recursive: true, force: true });
			rmSync(manager.runDir, { recursive: true, force: true });
			centurion.cleanup();
		}
	});
});

test("M0 nesting c3: centurion R=3 permits worker R=2 and advisor, then advisor is a leaf", async () => {
	await withEnvironment(isolatedEnv, async () => {
		const centurion = await spawnAt({ roleName: "centurion", name: "centurion", parentDepth: 0, parentMaxDepth: 4, roleMaxDepth: 3 });
		const manager = childOrchestrator(centurion.supervisor, centurion.supervisor.spawns[0]?.input.env ?? {});
		await manager.orchestrator.launch({ agent: role("worker", 2), task: "worker may dispatch once", name: "worker", worktree: false });
		const workerEnv = centurion.supervisor.spawns.at(-1)?.input.env ?? {};
		assert.equal(Number(workerEnv[MAX_DEPTH_ENV]), 3);
		const workerOrchestrator = childOrchestrator(centurion.supervisor, workerEnv);
		const advisor = await workerOrchestrator.orchestrator.launch({ agent: role("advisor", 1), task: "advisor leaf", name: "advisor", worktree: false });
		const advisorEnv = centurion.supervisor.spawns.at(-1)?.input.env ?? {};
		assert.equal(Number(advisorEnv[MAX_DEPTH_ENV]), 3);
		const leaf = childOrchestrator(centurion.supervisor, advisorEnv);
		try {
			await assert.rejects(
				() => leaf.orchestrator.launch({ agent: role("observer"), task: "refuse", worktree: false }),
				(error: unknown) => error instanceof SubagentError && error.code === ErrorCodes.BUDGET_EXCEEDED,
			);
			assert.equal(advisor.child.agent, "advisor");
			assert.equal(centurion.supervisor.spawns.length, 3);
		} finally {
			for (const child of [leaf, workerOrchestrator, manager]) rmSync(child.runDir, { recursive: true, force: true });
			centurion.cleanup();
		}
	});
});

test("M0 root depth ceiling combines settings, environment, and the hard cap", async () => {
	await withEnvironment({ ...isolatedEnv, [MAX_DEPTH_ENV]: "0" }, async () => {
		assert.equal(effectiveMaxDepth(4), 0);
		await assertLaunchRefused({ parentDepth: 0, parentMaxDepth: 0 });
	});
	await withEnvironment({ ...isolatedEnv, [MAX_DEPTH_ENV]: "10" }, async () => {
		assert.equal(effectiveMaxDepth(10), 4);
	});
});

test("M0 persistence: runtime maxDepth uses min(settings, environment) and is stored in run.json", async () => {
	await withEnvironment({ ...isolatedEnv, [MAX_DEPTH_ENV]: "2" }, async () => {
		const parsed = parseSubagentSettings({ subagents: { legion: { maxDepth: 4 } } }, "/project/.pi/settings.json");
		const configuredDepth = parsed.legion?.maxDepth;
		assert.equal(configuredDepth, 4);
		const runtimeDepth = effectiveMaxDepth(configuredDepth);
		assert.equal(runtimeDepth, 2, "environment ceiling tightens settings maxDepth");

		const root = mkdtempSync(path.join(tmpdir(), "legion-rpc-persist-depth-"));
		try {
			const store = new RunStore({ rootDir: path.join(root, ".pi-subagents") });
			const run = store.createRun({ task: "persist effective ceiling", cwd: "/tmp/project", maxDepth: runtimeDepth });
			const supervisor = new FakeSupervisor();
			const orchestrator = new Orchestrator({ supervisor, runDir: store.runDir(run.runId), cwd: "/tmp/project", maxDepth: configuredDepth });
			assert.equal(orchestrator.maxDepth, runtimeDepth);
			const handle = await orchestrator.launch({ agent: role("worker"), task: "inherit tightened ceiling", worktree: false });
			assert.equal(Number(supervisor.spawns[0]?.input.env?.[MAX_DEPTH_ENV]), runtimeDepth);
			await store.addChild(run.runId, handle.child);
			const persisted = store.readRun(run.runId);
			assert.equal(persisted?.maxDepth, orchestrator.maxDepth);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

test("M1 maxDepth above the hard cap warns once and emits the structured refusal event", async () => {
	await withEnvironment(isolatedEnv, async () => {
		const runDir = mkdtempSync(path.join(tmpdir(), "legion-rpc-depth-warning-"));
		const warnings: string[] = [];
		const events: unknown[] = [];
		const previousWarn = console.warn;
		try {
			console.warn = (...args: unknown[]) => warnings.push(args.map(String).join(" "));
			const orchestrator = new Orchestrator({
				supervisor: new FakeSupervisor(),
				runDir,
				cwd: "/tmp/project",
				maxDepth: 10,
				onBudgetRefused: (event) => events.push(event),
			});
			assert.equal(orchestrator.maxDepth, 4);
			await orchestrator.launch({ agent: role("worker"), task: "launch within capped budget" });
			assert.equal(warnings.length, 1);
			assert.match(warnings[0] ?? "", /hard cap 4/);
			assert.deepEqual(events, [{ type: "budget_refused", requestedMaxDepth: 10, effectiveMaxDepth: 4, reason: "maxDepth is capped at 4" }]);
		} finally {
			console.warn = previousWarn;
			rmSync(runDir, { recursive: true, force: true });
		}
	});
});


test("legacy herdr settings remain readable but warn and do not affect RPC behavior", () => {
	const warnings: string[] = [];
	const original = console.warn;
	try {
		console.warn = (...args: unknown[]) => warnings.push(args.map(String).join(" "));
		const parsed = parseSubagentSettings({ subagents: { herdr: { defaultPlacement: "new-tab", maxConcurrentAgents: 3 } } }, "/tmp/legacy-settings.json");
		assert.deepEqual(parsed.herdr, { defaultPlacement: "new-tab", maxConcurrentAgents: 3 });
		assert.equal(warnings.length, 1);
		assert.match(warnings[0] ?? "", /deprecated and ignored/);
	} finally { console.warn = original; }
});
