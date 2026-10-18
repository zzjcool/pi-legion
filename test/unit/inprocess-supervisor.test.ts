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
import { currentChildContext } from "../../src/supervisor/child-context.ts";
import { inProcessDepth } from "../../src/supervisor/inprocess-depth.ts";
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

/** Harness whose settings have no `subagents.inprocess` block at all. */
function unconfiguredHarness() {
	const root = mkdtempSync(path.join(tmpdir(), "legion-inprocess-"));
	const sessions: FakeSession[] = [];
	const supervisor = new InProcessSupervisor({
		getLimits: () => undefined,
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

// ── D4: safe defaults when `subagents.inprocess` is absent ────────────────

test("inprocess: no inprocess block applies maxDepth 4 default", async () => {
	const root = mkdtempSync(path.join(tmpdir(), "legion-inprocess-"));
	const depths: number[] = [];
	const refusals: unknown[] = [];
	// Real nesting happens *inside* a child's turn: the child's tool calls
	// spawnChild while its own prompt is still in flight. The depth scope must
	// therefore be entered during prompt(), which is what this factory models.
	let supervisor: InProcessSupervisor;
	const factory = async (input: InProcessSessionFactoryInput) => {
		class NestingSession extends FakeSession {
			override async prompt(text: string): Promise<void> {
				depths.push(inProcessDepth());
				await super.prompt(text);
				// Guard: if the maxDepth default regressed to "unlimited", this test
				// must fail on the depth assertion instead of recursing forever.
				if (depths.length > 8) return;
				try {
					await supervisor.spawnChild(
						testInput(root, `${input.name}.down`),
					);
				} catch (error) {
					refusals.push(error);
				}
			}
		}
		return new NestingSession();
	};
	supervisor = new InProcessSupervisor({ getLimits: () => undefined, sessionFactory: factory });
	try {
		await supervisor.spawnChild(testInput(root, "n1"));
		// Four levels are allowed; the fifth attempt is refused.
		assert.deepEqual(depths, [1, 2, 3, 4]);
		assert.equal(refusals.length, 1);
		const refusal = refusals[0] as Error & { code?: string };
		assert.equal(refusal.code, ErrorCodes.BUDGET_EXCEEDED);
		assert.match(refusal.message, /nesting limit/);
		assert.match(refusal.message, /max 4/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("inprocess: no inprocess block applies maxActive 30 default", async () => {
	const h = unconfiguredHarness();
	try {
		// Distinct parent keys so maxChildrenPerNode (8) never fires first;
		// that isolates the assertion to the maxActive default.
		for (let i = 0; i < 30; i += 1) {
			await h.supervisor.spawnChild(testInput(h.root, `p${i}.child`));
		}
		await assert.rejects(
			() => h.supervisor.spawnChild(testInput(h.root, "p30.child")),
			(error: unknown) =>
				(error as { code?: string }).code === ErrorCodes.BUDGET_EXCEEDED &&
				/inprocess maxActive reached \(30\/30\)/.test(
					(error as Error).message,
				),
		);
	} finally {
		h.close();
	}
});

test("inprocess: no inprocess block applies maxChildrenPerNode 8 default", async () => {
	const h = unconfiguredHarness();
	try {
		for (let i = 0; i < 8; i += 1) {
			await h.supervisor.spawnChild(testInput(h.root, `root.c${i}`));
		}
		await assert.rejects(
			() => h.supervisor.spawnChild(testInput(h.root, "root.c8")),
			(error: unknown) =>
				(error as { code?: string }).code === ErrorCodes.BUDGET_EXCEEDED &&
				/maxChildrenPerNode/.test((error as Error).message),
		);
	} finally {
		h.close();
	}
});

test("inprocess: explicit block without maxActive keeps the 8 default (I4)", async () => {
	const root = mkdtempSync(path.join(tmpdir(), "legion-inprocess-"));
	const supervisor = new InProcessSupervisor({
		// Explicit block, maxActive omitted → DEFAULT_INPROCESS_MAX_ACTIVE (8),
		// not the 30 used for a fully absent block.
		limits: { maxDepth: 4, maxChildrenPerNode: 100 },
		sessionFactory: async () => new FakeSession(),
	});
	try {
		// Distinct parents keep maxChildrenPerNode out of the way.
		for (let i = 0; i < 8; i += 1) {
			await supervisor.spawnChild(testInput(root, `q${i}.child`));
		}
		await assert.rejects(
			() => supervisor.spawnChild(testInput(root, "q8.child")),
			(error: unknown) =>
				(error as { code?: string }).code === ErrorCodes.BUDGET_EXCEEDED &&
				/inprocess maxActive reached \(8\/8\)/.test((error as Error).message),
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("inprocess: explicit numeric limits still win over the defaults", async () => {
	const h = harness({ maxActive: 2, maxDepth: 3, maxChildrenPerNode: 5 });
	try {
		await h.supervisor.spawnChild(testInput(h.root, "a.one"));
		await h.supervisor.spawnChild(testInput(h.root, "b.two"));
		await assert.rejects(
			() => h.supervisor.spawnChild(testInput(h.root, "c.three")),
			(error: unknown) =>
				/inprocess maxActive reached \(2\/2\)/.test((error as Error).message),
		);
	} finally {
		h.close();
	}
});

// ── D7: the factory is handed the orchestrator's pre-created transcript ───

test("inprocess: session factory receives the real sessionFile for real persistence", async () => {
	const root = mkdtempSync(path.join(tmpdir(), "legion-inprocess-tx-"));
	const captured: InProcessSessionFactoryInput[] = [];
	const supervisor = new InProcessSupervisor({
		limits: { maxActive: 8 },
		sessionFactory: async (input) => {
			captured.push(input);
			return new FakeSession();
		},
	});
	try {
		const input = testInput(root);
		const handle = await supervisor.spawnChild(input);
		assert.equal(captured.length, 1);
		// Non-empty and identical to the file the Orchestrator pre-created —
		// this is what `SessionManager.open(input.sessionFile)` writes into.
		assert.ok(captured[0]!.sessionFile);
		assert.equal(captured[0]!.sessionFile, input.sessionFile);
		assert.equal(handle.sessionFile, input.sessionFile);
		assert.equal(path.isAbsolute(captured[0]!.sessionFile), true);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

// ── D5: child identity is visible inside spawn/first prompt ───────────────

test("inprocess: child context is active during the first prompt", async () => {
	const root = mkdtempSync(path.join(tmpdir(), "legion-inprocess-ctx-"));
	let seenDuringPrompt: ReturnType<typeof currentChildContext>;
	let seenDuringFactory: ReturnType<typeof currentChildContext>;
	let depthDuringPrompt = 0;
	class ProbeSession extends FakeSession {
		override async prompt(text: string): Promise<void> {
			seenDuringPrompt = currentChildContext();
			depthDuringPrompt = inProcessDepth();
			await super.prompt(text);
		}
	}
	const supervisor = new InProcessSupervisor({
		limits: { maxActive: 8 },
		sessionFactory: async () => {
			seenDuringFactory = currentChildContext();
			return new ProbeSession();
		},
	});
	try {
		await supervisor.spawnChild({
			...testInput(root, "root.worker", testAgent({ utility: true })),
			childLaunchContext: {
				nodeId: "node-7",
				parentNodeId: "node-1",
				dbPath: "/tmp/legion.db",
				parentPath: ["root"],
				acceptanceRole: "read-only",
				allowNested: true,
				utility: true,
				spawnMode: "inprocess",
			},
		});
		assert.equal(seenDuringFactory?.nodeId, "node-7");
		assert.equal(seenDuringPrompt?.nodeId, "node-7");
		assert.equal(seenDuringPrompt?.acceptanceRole, "read-only");
		assert.equal(seenDuringPrompt?.allowNested, true);
		assert.deepEqual(seenDuringPrompt?.parentPath, ["root"]);
		// Depth and context are independent scopes; both must be live.
		assert.equal(depthDuringPrompt, 1);
		// Root chain after the spawn turn.
		assert.equal(currentChildContext(), undefined);
		assert.equal(inProcessDepth(), 0);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("inprocess: missing childLaunchContext falls back to a derived context", async () => {
	const root = mkdtempSync(path.join(tmpdir(), "legion-inprocess-ctx-"));
	let seen: ReturnType<typeof currentChildContext>;
	class ProbeSession extends FakeSession {
		override async prompt(text: string): Promise<void> {
			seen = currentChildContext();
			await super.prompt(text);
		}
	}
	const supervisor = new InProcessSupervisor({
		limits: { maxActive: 8 },
		sessionFactory: async () => new ProbeSession(),
	});
	try {
		await supervisor.spawnChild({
			...testInput(
				root,
				"root.writer",
				testAgent({
					allowNestedSubagents: true,
					acceptance: { level: "attested", role: "writer" },
				}),
			),
			allowNestedSubagents: true,
		});
		// A child must never observe "no identity" and mistake itself for root.
		assert.ok(seen);
		assert.equal(seen.spawnMode, "inprocess");
		assert.equal(seen.allowNested, true);
		assert.equal(seen.utility, false);
		assert.equal(seen.acceptanceRole, "writer");
		assert.equal(seen.nodeId, undefined);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("inprocess: later dispatches reuse the child's context", async () => {
	const root = mkdtempSync(path.join(tmpdir(), "legion-inprocess-ctx-"));
	const seen: (string | undefined)[] = [];
	class ProbeSession extends FakeSession {
		override async prompt(text: string): Promise<void> {
			seen.push(`prompt:${currentChildContext()?.nodeId}`);
			await super.prompt(text);
		}
		override async steer(text: string): Promise<void> {
			seen.push(`steer:${currentChildContext()?.nodeId}`);
			await super.steer(text);
		}
		override async followUp(text: string): Promise<void> {
			seen.push(`followUp:${currentChildContext()?.nodeId}`);
			await super.followUp(text);
		}
	}
	const supervisor = new InProcessSupervisor({
		limits: { maxActive: 8 },
		sessionFactory: async () => new ProbeSession(),
	});
	try {
		await supervisor.spawnChild({
			...testInput(root),
			childLaunchContext: {
				nodeId: "node-9",
				allowNested: false,
				utility: false,
				spawnMode: "inprocess",
			},
		});
		await supervisor.prompt("root.worker", "second turn");
		await supervisor.steer("root.worker", "steer");
		await supervisor.followUp("root.worker", "follow");
		// Every dispatch carries the child's identity; which session method the
		// in-flight turn maps to (prompt vs steer) is not what this test pins.
		assert.equal(seen.length, 4);
		assert.ok(seen.every((entry) => entry?.endsWith(":node-9")));
		assert.equal(currentChildContext(), undefined);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
