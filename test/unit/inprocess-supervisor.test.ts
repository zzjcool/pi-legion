import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
	InProcessSupervisor,
	buildInProcessSessionPlan,
	type InProcessSession,
	type InProcessSessionFactoryInput,
} from "../../src/supervisor/inprocess-supervisor.ts";
import { RoutingSupervisor } from "../../src/supervisor/routing-supervisor.ts";
import { RpcSupervisor } from "../../src/supervisor/rpc-supervisor.ts";
import type { SpawnInput } from "../../src/supervisor/types.ts";
import { ErrorCodes } from "../../src/shared/types.ts";

class FakeSession implements InProcessSession {
	readonly listeners = new Set<(event: unknown) => void>();
	readonly prompts: string[] = [];
	readonly steers: string[] = [];
	readonly followUps: string[] = [];
	aborts = 0;
	disposed = false;

	subscribe(listener: (event: unknown) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	async prompt(text: string): Promise<void> {
		this.prompts.push(text);
		this.emit({ type: "agent_start" });
		this.emit({ type: "turn_start" });
	}

	async steer(text: string): Promise<void> {
		this.steers.push(text);
	}

	async followUp(text: string): Promise<void> {
		this.followUps.push(text);
	}

	async abort(): Promise<void> {
		this.aborts += 1;
	}

	dispose(): void {
		this.disposed = true;
	}

	getSessionStats() {
		return { tokensIn: 1, tokensOut: 2, costUsd: 0.01 };
	}

	emit(event: unknown): void {
		for (const listener of [...this.listeners]) listener(event);
	}

	settle(): void {
		this.emit({ type: "turn_end" });
		this.emit({ type: "agent_end" });
		this.emit({ type: "agent_settled" });
	}
}

function testAgent(overrides: Record<string, unknown> = {}) {
	return {
		name: "worker",
		description: "unit test agent",
		kind: "pi" as const,
		source: "user" as const,
		filePath: "/tmp/worker.md",
		systemPrompt: "Follow the role instructions.",
		systemPromptMode: "append" as const,
		inheritProjectContext: true,
		inheritSkills: false,
		tools: ["read"],
		spawnMode: "inprocess" as const,
		...overrides,
	};
}

function testInput(root: string, name = "root.worker", agent = testAgent()): SpawnInput {
	return {
		name,
		task: "smoke inprocess path",
		agent,
		sessionFile: path.join(root, `${name}.jsonl`),
		tempDir: root,
		cwd: root,
	};
}

function harness(limits?: { maxActive?: number; maxSpawnsPerSession?: number; maxDepth?: number; maxChildrenPerNode?: number }) {
	const root = mkdtempSync(path.join(tmpdir(), "legion-inprocess-"));
	const sessions: FakeSession[] = [];
	const supervisor = new InProcessSupervisor({
		limits: limits ?? { maxActive: 8 },
		sessionFactory: async () => {
			const session = new FakeSession();
			sessions.push(session);
			return session;
		},
	});
	return {
		root,
		sessions,
		supervisor,
		close() {
			rmSync(root, { recursive: true, force: true });
		},
	};
}

test("inprocess: spawn → prompt settle → retire", async () => {
	const h = harness();
	try {
		const handle = await h.supervisor.spawnChild(testInput(h.root));
		assert.equal(handle.name, "root.worker");
		assert.equal(handle.pid, undefined);
		assert.equal(h.sessions.length, 1);
		assert.ok(h.sessions[0]!.prompts[0]?.includes("smoke inprocess path"));
		assert.equal(h.supervisor.isAlive("root.worker"), true);

		const waiting = h.supervisor.waitSettled("root.worker", 1_000);
		h.sessions[0]!.settle();
		const settled = await waiting;
		assert.deepEqual(settled, { settled: true, abnormal: false, aborted: false });

		await h.supervisor.retire("root.worker");
		assert.equal(h.sessions[0]!.disposed, true);
		assert.equal(h.supervisor.isAlive("root.worker"), false);
	} finally {
		h.close();
	}
});

test("inprocess: onEvent fans in agent_settled", async () => {
	const h = harness();
	try {
		const seen: string[] = [];
		h.supervisor.onEvent("root.worker", (event) => {
			seen.push(event.type);
		});
		await h.supervisor.spawnChild(testInput(h.root));
		h.sessions[0]!.settle();
		assert.ok(seen.includes("agent_start"));
		assert.ok(seen.includes("agent_settled"));
	} finally {
		h.close();
	}
});

test("inprocess: refuses worktree:true", async () => {
	const h = harness();
	try {
		await assert.rejects(
			() =>
				h.supervisor.spawnChild(
					testInput(h.root, "root.worker", testAgent({ worktree: true })),
				),
			(error: unknown) =>
				error instanceof Error &&
				(error as { code?: string }).code === ErrorCodes.INVALID_PARAMS,
		);
	} finally {
		h.close();
	}
});

test("inprocess: maxActive limit is independent of RPC keys", async () => {
	const h = harness({ maxActive: 1 });
	try {
		await h.supervisor.spawnChild(testInput(h.root, "a.one"));
		await assert.rejects(
			() => h.supervisor.spawnChild(testInput(h.root, "a.two")),
			(error: unknown) =>
				error instanceof Error &&
				(error as { code?: string }).code === ErrorCodes.BUDGET_EXCEEDED &&
				/inprocess maxActive/.test(error.message),
		);
	} finally {
		h.close();
	}
});

test("routing: inprocess vs rpc by spawnMode; name cannot cross backends", async () => {
	const root = mkdtempSync(path.join(tmpdir(), "legion-routing-"));
	const sessions: FakeSession[] = [];
	const inprocess = new InProcessSupervisor({
		limits: { maxActive: 8 },
		sessionFactory: async () => {
			const session = new FakeSession();
			sessions.push(session);
			return session;
		},
	});
	// Minimal RpcSupervisor that we never actually spawn into for this test.
	const rpc = new RpcSupervisor({
		clientFactory: () => {
			throw new Error("rpc factory should not run in this test");
		},
		enumerateDescendants: () => [],
	});
	const routing = new RoutingSupervisor({ rpc, inprocess });
	try {
		await routing.spawnChild(
			testInput(root, "root.ip", testAgent({ spawnMode: "inprocess" })),
		);
		assert.equal(routing.isAlive("root.ip"), true);
		assert.equal(sessions.length, 1);

		await assert.rejects(
			() =>
				routing.spawnChild(
					testInput(root, "bad", testAgent({ spawnMode: "inprocess", worktree: true })),
				),
			(error: unknown) =>
				(error as { code?: string }).code === ErrorCodes.INVALID_PARAMS,
		);

		sessions[0]!.settle();
		await routing.retire("root.ip");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("inprocess plan: tools + model + systemPrompt replace/append", () => {
	const baseAgent = testAgent({
		tools: ["read", "bash"],
		systemPrompt: "You are scout.",
		systemPromptMode: "replace",
		inheritSkills: false,
		inheritProjectContext: false,
	});
	const plan = buildInProcessSessionPlan({
		name: "root.scout",
		cwd: "/tmp/ws",
		agent: baseAgent,
		sessionFile: "/tmp/ws/scout.jsonl",
		model: "anthropic/claude-sonnet-4-5",
		thinking: "high",
		childContext: "machine notes",
	});
	assert.deepEqual(plan.tools, ["read", "bash", "vexillatio"]);
	assert.equal(plan.modelRef, "anthropic/claude-sonnet-4-5:high");
	assert.equal(plan.systemPromptMode, "replace");
	assert.equal(plan.systemPromptText, "You are scout.\n\nmachine notes");
	assert.equal(plan.noExtensions, true);
	assert.equal(plan.noSkills, true);
	assert.equal(plan.noContextFiles, true);
	assert.ok(plan.additionalExtensionPaths.some((p) => p.includes("index.ts")));

	const appendPlan = buildInProcessSessionPlan({
		name: "root.scout",
		cwd: "/tmp/ws",
		agent: testAgent({
			tools: undefined,
			systemPrompt: "Extra.",
			systemPromptMode: "append",
			utility: true,
		}),
		sessionFile: "/tmp/s.jsonl",
	});
	assert.equal(appendPlan.tools, undefined);
	assert.equal(appendPlan.systemPromptMode, "append");
	assert.equal(appendPlan.systemPromptText, "Extra.");
	assert.equal(appendPlan.modelRef, undefined);
});

test("inprocess plan: omit tools leaves SDK default; utility skips vexillatio", () => {
	const empty = buildInProcessSessionPlan({
		name: "u",
		cwd: "/tmp",
		agent: testAgent({ tools: [], utility: true, systemPrompt: "" }),
		sessionFile: "/tmp/u.jsonl",
	});
	assert.equal(empty.tools, undefined);
	assert.equal(empty.systemPromptText, undefined);

	const util = buildInProcessSessionPlan({
		name: "u2",
		cwd: "/tmp",
		agent: testAgent({ tools: ["read"], utility: true }),
		sessionFile: "/tmp/u2.jsonl",
	});
	assert.deepEqual(util.tools, ["read"]);
});

test("inprocess: spawnChild forwards model/thinking/childContext to factory", async () => {
	const root = mkdtempSync(path.join(tmpdir(), "legion-inprocess-fwd-"));
	const captured: InProcessSessionFactoryInput[] = [];
	const supervisor = new InProcessSupervisor({
		limits: { maxActive: 8 },
		sessionFactory: async (input) => {
			captured.push(input);
			const session = new FakeSession();
			return session;
		},
	});
	try {
		await supervisor.spawnChild({
			...testInput(root),
			model: "openai/gpt-4.1",
			modelProvider: "openai",
			thinking: "low",
			childContext: "ctx",
		});
		assert.equal(captured.length, 1);
		assert.equal(captured[0]!.model, "openai/gpt-4.1");
		assert.equal(captured[0]!.modelProvider, "openai");
		assert.equal(captured[0]!.thinking, "low");
		assert.equal(captured[0]!.childContext, "ctx");
		assert.deepEqual(captured[0]!.agent.tools, ["read"]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("inprocess: refuses kind!==pi", async () => {
	const h = harness();
	try {
		await assert.rejects(
			() =>
				h.supervisor.spawnChild(
					testInput(h.root, "root.x", testAgent({ kind: "claude" })),
				),
			(error: unknown) =>
				error instanceof Error &&
				(error as { code?: string }).code === ErrorCodes.INVALID_PARAMS,
		);
	} finally {
		h.close();
	}
});

test("inprocess: maxDepth / maxChildrenPerNode / maxSpawnsPerSession", async () => {
	const depth = harness({ maxActive: 8, maxDepth: 0 });
	try {
		await assert.rejects(
			() => depth.supervisor.spawnChild(testInput(depth.root)),
			(error: unknown) =>
				(error as { code?: string }).code === ErrorCodes.BUDGET_EXCEEDED &&
				/inprocess nesting limit/.test((error as Error).message),
		);
	} finally {
		depth.close();
	}

	const children = harness({ maxActive: 8, maxChildrenPerNode: 1 });
	try {
		await children.supervisor.spawnChild(testInput(children.root, "root.a"));
		await assert.rejects(
			() => children.supervisor.spawnChild(testInput(children.root, "root.b")),
			(error: unknown) =>
				(error as { code?: string }).code === ErrorCodes.BUDGET_EXCEEDED &&
				/maxChildrenPerNode/.test((error as Error).message),
		);
	} finally {
		children.close();
	}

	const spawns = harness({ maxActive: 8, maxSpawnsPerSession: 1 });
	try {
		await spawns.supervisor.spawnChild(testInput(spawns.root, "one"));
		await spawns.supervisor.retire("one");
		await assert.rejects(
			() => spawns.supervisor.spawnChild(testInput(spawns.root, "two")),
			(error: unknown) =>
				(error as { code?: string }).code === ErrorCodes.BUDGET_EXCEEDED &&
				/spawn budget exhausted/.test((error as Error).message),
		);
	} finally {
		spawns.close();
	}
});
