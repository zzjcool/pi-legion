import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
	InProcessSupervisor,
	buildInProcessSessionPlan,
	drainExtensionRegistrations,
	type InProcessSession,
	type InProcessSessionFactoryInput,
	type InProcessSessionStats,
	type ModelRuntimeLike,
} from "../../src/supervisor/inprocess-supervisor.ts";
import { RoutingSupervisor } from "../../src/supervisor/routing-supervisor.ts";
import { RpcSupervisor } from "../../src/supervisor/rpc-supervisor.ts";
import { currentChildContext } from "../../src/supervisor/child-context.ts";
import { inProcessDepth } from "../../src/supervisor/inprocess-depth.ts";
import { Orchestrator } from "../../src/runs/orchestrator.ts";
import {
	discoveredHostExtensions,
	resetExtensionDiscoveryCache,
} from "../../src/runs/extension-inheritance.ts";
import type { SpawnInput } from "../../src/supervisor/types.ts";
import { ErrorCodes } from "../../src/shared/types.ts";
import type { NestedPathEntry } from "../../src/shared/types.ts";
import { deriveOutcome, parseSessionFile } from "../../src/shared/session.ts";
import {
	SessionManager,
	type SessionStats as SdkSessionStats,
} from "@earendil-works/pi-coding-agent";
import { statSync, writeFileSync } from "node:fs";

/** Raw answer from the SDK's `AgentSession.steer()` (#313): `"handled"` | `"queued"`. */
type RawSteerDisposition = "queued" | "handled";

class FakeSession implements InProcessSession {
	readonly listeners = new Set<(event: unknown) => void>();
	readonly prompts: string[] = [];
	readonly steers: string[] = [];
	readonly followUps: string[] = [];
	aborts = 0;
	disposed = false;
	/**
	 * Raw answer `steer()` resolves with (#313).
	 *
	 * The real `AgentSession.steer()` returns `"queued"` unconditionally — a
	 * steer is banked whether or not a tool batch happens to be in flight
	 * (`dist/core/agent-session.js:1698-1711`). `"handled"` is *not* "taken
	 * now": it means an input handler swallowed the text before `_queueSteer`
	 * ran, so the child never sees it. A case that wants that path flips this
	 * field explicitly; the default is what the SDK really answers.
	 */
	steerDisposition: RawSteerDisposition = "queued";

	subscribe(listener: (event: unknown) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	async prompt(text: string): Promise<void> {
		this.prompts.push(text);
		this.emit({ type: "agent_start" });
		this.emit({ type: "turn_start" });
	}

	async steer(text: string): Promise<RawSteerDisposition> {
		this.steers.push(text);
		return this.steerDisposition;
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

	getSessionStats(): InProcessSessionStats {
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

/**
 * #266: capture a refusal as a value so the whole `message` can be compared.
 * `assert.rejects` with a predicate cannot express a byte-exact comparison
 * without repeating the string in the matcher.
 */
async function refusalOf(run: () => Promise<unknown>): Promise<Error> {
	try {
		await run();
	} catch (error) {
		assert.ok(error instanceof Error, "a refusal must be an Error");
		return error;
	}
	assert.fail("expected the spawn to be refused");
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
			(error: unknown) => {
				assert.ok(error instanceof Error);
				assert.equal((error as { code?: string }).code, ErrorCodes.INVALID_PARAMS);
				// #214 D3: prefer suggesting worktree:false; do not lead with "use rpc".
				assert.match(error.message, /set worktree: false/);
				assert.doesNotMatch(error.message, /use spawnMode ["']rpc["']/);
				return true;
			},
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

test("#315 inprocess: the in-flight tool rides the session event stream already consumed", async () => {
	const h = harness();
	try {
		await h.supervisor.spawnChild(testInput(h.root));
		const session = h.sessions[0]!;
		assert.equal(
			h.supervisor.inFlightTool("root.worker"),
			undefined,
			"an idle child is inside no tool",
		);

		session.emit({ type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: {} });
		const started = h.supervisor.inFlightTool("root.worker");
		assert.equal(started?.tool, "bash");
		assert.equal(started?.toolCallId, "t1");
		assert.equal(typeof started?.startedAt, "number");

		session.emit({ type: "tool_execution_end", toolCallId: "t1", toolName: "bash" });
		assert.equal(h.supervisor.inFlightTool("root.worker"), undefined);

		// An abort can end the turn while the tool is still running, so no end
		// event ever arrives: a settled turn must not keep claiming a tool.
		session.emit({ type: "tool_execution_start", toolCallId: "t2", toolName: "codemode", args: {} });
		assert.equal(h.supervisor.inFlightTool("root.worker")?.tool, "codemode");
		session.settle();
		assert.equal(h.supervisor.inFlightTool("root.worker"), undefined);

		// A child this backend no longer runs answers nothing, whatever the record
		// still holds — the fact describes a live process, not a memory.
		session.emit({ type: "tool_execution_start", toolCallId: "t3", toolName: "bash", args: {} });
		assert.equal(h.supervisor.inFlightTool("root.worker")?.tool, "bash");
		await h.supervisor.retire("root.worker");
		assert.equal(h.supervisor.isAlive("root.worker"), false);
		assert.equal(h.supervisor.inFlightTool("root.worker"), undefined);
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

test("#315 routing: inFlightTool is forwarded to the owning backend", async () => {
	const root = mkdtempSync(path.join(tmpdir(), "legion-routing-activity-"));
	const sessions: FakeSession[] = [];
	const inprocess = new InProcessSupervisor({
		limits: { maxActive: 8 },
		sessionFactory: async () => {
			const session = new FakeSession();
			sessions.push(session);
			return session;
		},
	});
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
		assert.equal(routing.inFlightTool("root.ip"), undefined);

		sessions[0]!.emit({ type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: {} });
		assert.equal(routing.inFlightTool("root.ip")?.tool, "bash");

		// A name neither backend runs answers nothing: the pre-spawn fallback
		// must not invent activity for a record this process does not hold.
		assert.equal(routing.inFlightTool("root.ghost"), undefined);

		sessions[0]!.settle();
		await routing.retire("root.ip");
		assert.equal(routing.inFlightTool("root.ip"), undefined);
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
				parentPath: [{ runId: "root" }],
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
		assert.deepEqual(seenDuringPrompt?.parentPath, [{ runId: "root" }]);
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
		override async steer(text: string): Promise<RawSteerDisposition> {
			seen.push(`steer:${currentChildContext()?.nodeId}`);
			return super.steer(text);
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

// ── #313: a steer reports what happened — queued, accepted or intercepted ──

test("inprocess: a steer reports the session's own answer (#313)", async () => {
	const h = harness();
	try {
		await h.supervisor.spawnChild(testInput(h.root));
		const session = h.sessions[0]!;

		// The child is inside its first turn, so a steer takes the queue branch.
		// The real session still answers "queued": queued is all it ever says,
		// independent of whether a tool batch happens to be in flight.
		assert.equal(session.steerDisposition, "queued");
		assert.equal(await h.supervisor.steer("root.worker", "first correction"), "queued");
		assert.deepEqual(session.steers, ["first correction"], "the text reached the session's steer seam");
		assert.equal(session.prompts.length, 1, "a steer never starts a second prompt while the turn runs");

		// "handled" is the SDK's interception signal: an input handler swallowed the
		// text before `_queueSteer`, so the child never sees it. Reporting that as
		// steered/delivered would be the inverse lie.
		session.steerDisposition = "handled";
		assert.equal(await h.supervisor.steer("root.worker", "swallowed by a handler"), "intercepted");
		assert.deepEqual(session.steers, ["first correction", "swallowed by a handler"]);

		// Back to the SDK's real answer: queued, never a delivery claim.
		session.steerDisposition = "queued";
		assert.equal(await h.supervisor.steer("root.worker", "third correction"), "queued");
	} finally {
		h.close();
	}
});

test("inprocess: a steer on an idle child starts a turn and reports accepted (#313)", async () => {
	const h = harness();
	try {
		await h.supervisor.spawnChild(testInput(h.root));
		const session = h.sessions[0]!;
		// Let the first turn settle: `turnActive` turns false only on `agent_settled`.
		session.settle();

		// With no turn running, `steer` degrades to `session.prompt`
		// (inprocess-supervisor.ts:1323-1328). The session accepted a fresh turn,
		// nothing was intercepted, and nothing was queued behind a tool batch.
		assert.equal(await h.supervisor.steer("root.worker", "start a turn with this"), "accepted");
		assert.deepEqual(session.prompts.slice(1), ["start a turn with this"]);
		assert.deepEqual(session.steers, [], "no queue to steer into: the prompt path is what ran");
	} finally {
		h.close();
	}
});

// ── REV2-1: depth must survive the ROOT-chain turn-2+ dispatch ────────────

test("inprocess: maxDepth holds across generations driven from the root chain (REV2-1)", async () => {
	const root = mkdtempSync(path.join(tmpdir(), "legion-inprocess-rev21-"));
	const rejections: string[] = [];
	const spawned: number[] = [];
	let supervisor: InProcessSupervisor;

	/**
	 * Production timing:
	 *  - turn 1 is dispatched by spawnChild (inside runAtInProcessChildDepthAsync)
	 *  - turn 2+ is dispatched by the Orchestrator from the ROOT chain
	 *  - each generation spawns its child DURING one of its own turns
	 * Pre-fix, a spawn issued from a turn-2 await saw depth 0 → every child
	 * recorded spawnDepth 1 → maxDepth never fired.
	 */
	const factory = async (input: InProcessSessionFactoryInput) => {
		return new RootChainSpawner(input.name);
	};

	class RootChainSpawner extends FakeSession {
		readonly name: string;
		private turns = 0;
		constructor(name: string) {
			super();
			this.name = name;
		}
		override async prompt(text: string): Promise<void> {
			this.turns += 1;
			const spawnerDepth = inProcessDepth();
			await super.prompt(text);
			// Turn 1 is the spawnChild-dispatched turn (no spawn there: it would
			// collide with the turn-2 name). Every spawn happens on turn 2, which
			// the Orchestrator dispatches from the ROOT chain — the buggy path.
			if (this.turns === 2) {
				const childName = `${this.name}.child`;
				try {
					await supervisor.spawnChild(testInput(root, childName));
					const record = (
						supervisor as unknown as {
							children: Map<string, { spawnDepth: number }>;
						}
					).children.get(childName);
					spawned.push(record?.spawnDepth ?? -1);
					assert.equal(
						record?.spawnDepth,
						spawnerDepth + 1,
						`${childName}: child depth must be spawner depth + 1`,
					);
				} catch (error) {
					rejections.push((error as Error).message);
				}
			}
			// Settle the turn so the next dispatch goes through prompt(), not steer().
			this.settle();
		}
	}

	supervisor = new InProcessSupervisor({
		getLimits: () => undefined, // maxDepth 4 by default
		sessionFactory: factory,
	});
	try {
		await supervisor.spawnChild(testInput(root, "root.g1"));
		// Drive generations one at a time from the ROOT chain.
		const names = ["root.g1"];
		for (let gen = 1; gen <= 6; gen += 1) {
			const name = names[names.length - 1]!;
			if (!supervisor.isAlive(name)) break;
			await supervisor.prompt(name, `turn2 of ${name}`); // ROOT-chain dispatch
			const next = `${name}.child`;
			if (supervisor.isAlive(next)) names.push(next);
			else break;
		}

		// Four levels are allowed (root.g1 is depth 1) …
		assert.deepEqual(spawned, [2, 3, 4]);
		// … and the fifth is refused, with the nesting-limit message.
		assert.equal(rejections.length, 1);
		assert.match(rejections[0]!, /nesting limit/);
		assert.match(rejections[0]!, /max 4/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

// ── REV2-2: every omitted key falls back to a safe default ────────────────

test("inprocess: empty block {} falls back to 4/8/8 (REV2-2)", async () => {
	const root = mkdtempSync(path.join(tmpdir(), "legion-inprocess-{}"));
	const supervisor = new InProcessSupervisor({
		getLimits: () => ({}), // parseInProcessLimits("{}") yields {}
		sessionFactory: async () => new FakeSession(),
	});
	try {
		// Distinct parents keep maxChildrenPerNode out of the way until we want it.
		for (let i = 0; i < 8; i += 1) {
			await supervisor.spawnChild(testInput(root, `p${i}.child`));
		}
		await assert.rejects(
			() => supervisor.spawnChild(testInput(root, "p8.child")),
			(error: unknown) =>
				/inprocess maxActive reached \(8\/8\)/.test((error as Error).message),
			"empty block must default maxActive to 8, not unlimited",
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("inprocess: partial block {maxActive:50} still defaults maxDepth/maxChildrenPerNode (REV2-2)", async () => {
	const root = mkdtempSync(path.join(tmpdir(), "legion-inprocess-partial-"));
	const supervisor = new InProcessSupervisor({
		getLimits: () => ({ maxActive: 50 }), // maxDepth / maxChildrenPerNode omitted
		sessionFactory: async () => new FakeSession(),
	});
	try {
		// maxChildrenPerNode must default to 8 despite maxActive being raised to 50.
		for (let i = 0; i < 8; i += 1) {
			await supervisor.spawnChild(testInput(root, `root.c${i}`));
		}
		await assert.rejects(
			() => supervisor.spawnChild(testInput(root, "root.c8")),
			(error: unknown) =>
				(error as { code?: string }).code === ErrorCodes.BUDGET_EXCEEDED &&
				/maxChildrenPerNode/.test((error as Error).message),
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("inprocess: partial block {maxChildrenPerNode:50} still defaults maxDepth 4 (REV2-2)", async () => {
	const root = mkdtempSync(path.join(tmpdir(), "legion-inprocess-partial2-"));
	const rejections: string[] = [];
	let supervisor: InProcessSupervisor;
	class Nester extends FakeSession {
		readonly name: string;
		private turns = 0;
		constructor(name: string) {
			super();
			this.name = name;
		}
		override async prompt(text: string): Promise<void> {
			this.turns += 1;
			await super.prompt(text);
			if (this.turns === 2) {
				try {
					await supervisor.spawnChild(testInput(root, `${this.name}.child`));
				} catch (error) {
					rejections.push((error as Error).message);
				}
			}
			this.settle();
		}
	}
	supervisor = new InProcessSupervisor({
		getLimits: () => ({ maxChildrenPerNode: 50 }), // maxDepth omitted
		sessionFactory: async (i) => new Nester(i.name),
	});
	try {
		await supervisor.spawnChild(testInput(root, "g1"));
		let name = "g1";
		for (let gen = 1; gen <= 5; gen += 1) {
			if (!supervisor.isAlive(name)) break;
			await supervisor.prompt(name, "turn2");
			const next = `${name}.child`;
			if (!supervisor.isAlive(next)) break;
			name = next;
		}
		assert.equal(rejections.length, 1);
		assert.match(rejections[0]!, /nesting limit/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

// ── REV2-3: the stored context is a snapshot, not the caller's live object ─

test("inprocess: mutating the caller's context template does not affect a spawned child (REV2-3)", async () => {
	const root = mkdtempSync(path.join(tmpdir(), "legion-inprocess-snap-"));
	const seen: (string | undefined)[] = [];
	class ProbeSession extends FakeSession {
		override async prompt(text: string): Promise<void> {
			seen.push(currentChildContext()?.nodeId);
			await super.prompt(text);
		}
		override async steer(text: string): Promise<RawSteerDisposition> {
			seen.push(currentChildContext()?.nodeId);
			return super.steer(text);
		}
	}
	const supervisor = new InProcessSupervisor({
		limits: { maxActive: 8 },
		sessionFactory: async () => new ProbeSession(),
	});
	const template = {
		nodeId: "node-A",
		parentPath: [{ runId: "root" }, { runId: "a" }],
		allowNested: false,
		utility: false,
		spawnMode: "inprocess" as const,
	};
	try {
		await supervisor.spawnChild({
			...testInput(root),
			childLaunchContext: template,
		});
		// Caller reuses its template for another spawn: node A must keep node A.
		template.nodeId = "node-B";
		template.parentPath.push({ runId: "b" });
		await supervisor.prompt("root.worker", "turn2");
		assert.deepEqual(seen, ["node-A", "node-A"]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("inprocess: parentPath array is copied, not aliased (REV2-3)", async () => {
	const root = mkdtempSync(path.join(tmpdir(), "legion-inprocess-snap2-"));
	let seenPath: NestedPathEntry[] | undefined;
	class ProbeSession extends FakeSession {
		override async prompt(text: string): Promise<void> {
			seenPath = currentChildContext()?.parentPath;
			await super.prompt(text);
		}
	}
	const supervisor = new InProcessSupervisor({
		limits: { maxActive: 8 },
		sessionFactory: async () => new ProbeSession(),
	});
	const parentPath: NestedPathEntry[] = [{ runId: "root-run", agent: "root" }];
	try {
		await supervisor.spawnChild({
			...testInput(root),
			childLaunchContext: {
				nodeId: "n1",
				parentPath,
				allowNested: false,
				utility: false,
				spawnMode: "inprocess",
			},
		});
		parentPath.push({ runId: "mutated-after-spawn" });
		assert.deepEqual(seenPath, [{ runId: "root-run", agent: "root" }]);
		// Element-level aliasing: `[...path]` alone would still share every entry,
		// so mutating an EXISTING entry must not reach the stored snapshot.
		parentPath[0]!.runId = "HIJACKED";
		parentPath[0]!.agent = "HIJACKED";
		assert.deepEqual(
			seenPath,
			[{ runId: "root-run", agent: "root" }],
			"mutating an existing path entry must not rewrite the spawned child's lineage",
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

// ── REV2-5: transcript really lands on disk (distinguishes open vs inMemory) ─

test("inprocess: SessionManager.open on a pre-created file persists a parseable transcript (REV2-5)", () => {
	const root = mkdtempSync(path.join(tmpdir(), "legion-inprocess-open-"));
	const file = path.join(root, "child.jsonl");
	// Exactly what Orchestrator.preCreateSessionFile does.
	writeFileSync(file, "");
	assert.equal(statSync(file).size, 0);
	try {
		const manager = SessionManager.open(file, undefined, root);
		// inMemory() would report undefined here and never touch the file.
		assert.equal(manager.getSessionFile(), file);
		// open() seeds the session header immediately.
		assert.ok(statSync(file).size > 0, "open() must write the session header");

		manager.appendMessage({
			role: "user",
			content: "hello from inprocess child",
			timestamp: Date.now(),
		});
		const parsed = parseSessionFile(file);
		assert.equal(parsed.turns.length, 1);
		// The zero-output bug: an empty file yields status "unknown".
		assert.notEqual(deriveOutcome(parsed).status, "unknown");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("inprocess: default factory contract requires a non-inMemory manager (REV2-5)", async () => {
	// The production factory is not injectable, so pin the property that makes
	// D7 work: the sessionFile handed to the factory must be a real path that
	// SessionManager.open can attach to. Regression to inMemory() shows up as
	// getSessionFile() === undefined and a 0-byte transcript.
	const root = mkdtempSync(path.join(tmpdir(), "legion-inprocess-d7-"));
	const captured: InProcessSessionFactoryInput[] = [];
	const supervisor = new InProcessSupervisor({
		limits: { maxActive: 8 },
		sessionFactory: async (input) => {
			captured.push(input);
			// Mimic the real factory's persistence behaviour.
			const manager = SessionManager.open(input.sessionFile, undefined, input.cwd);
			manager.appendMessage({ role: "user", content: "task", timestamp: Date.now() });
			return new FakeSession();
		},
	});
	try {
		const input = testInput(root);
		writeFileSync(input.sessionFile, "");
		await supervisor.spawnChild(input);
		assert.equal(captured.length, 1);
		assert.equal(statSync(input.sessionFile).size > 0, true);
		assert.equal(parseSessionFile(input.sessionFile).turns.length, 1);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

// ── REV2-6: stats must read the real SDK shape ────────────────────────────

test("inprocess: stats() reads nested SDK tokens/cost (REV2-6)", async () => {
	const root = mkdtempSync(path.join(tmpdir(), "legion-inprocess-stats-"));
	class SdkStatsSession extends FakeSession {
		override getSessionStats(): InProcessSessionStats {
			// Real AgentSession.SessionStats shape (agent-session.d.ts:201-217).
			// Typed as the SDK type (not a fresh literal) so this double is checked
			// against the shape production actually returns.
			const sdk: SdkSessionStats = {
				sessionFile: "/tmp/s.jsonl",
				sessionId: "s1",
				userMessages: 1,
				assistantMessages: 1,
				toolCalls: 0,
				toolResults: 0,
				totalMessages: 2,
				tokens: { input: 1234, output: 567, cacheRead: 0, cacheWrite: 0, total: 1801 },
				cost: 0.0421,
			};
			return sdk;
		}
	}
	const supervisor = new InProcessSupervisor({
		limits: { maxActive: 8 },
		sessionFactory: async () => new SdkStatsSession(),
	});
	try {
		await supervisor.spawnChild(testInput(root));
		const stats = await supervisor.stats("root.worker");
		assert.deepEqual(stats, { tokensIn: 1234, tokensOut: 567, costUsd: 0.0421 });
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("inprocess: stats() still accepts flat counters from test doubles (REV2-6)", async () => {
	const root = mkdtempSync(path.join(tmpdir(), "legion-inprocess-stats2-"));
	const supervisor = new InProcessSupervisor({
		limits: { maxActive: 8 },
		sessionFactory: async () => new FakeSession(), // returns flat {tokensIn:1,...}
	});
	try {
		await supervisor.spawnChild(testInput(root));
		assert.deepEqual(await supervisor.stats("root.worker"), {
			tokensIn: 1,
			tokensOut: 2,
			costUsd: 0.01,
		});
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

// ── REV2-7.4: parent-side listeners must not inherit the child identity ───

test("inprocess: onEvent listeners run at root identity, not the child's (REV2-7)", async () => {
	const root = mkdtempSync(path.join(tmpdir(), "legion-inprocess-lsn-"));
	const seenByListener: (string | undefined)[] = [];
	const seenInDispatch: (string | undefined)[] = [];
	class ProbeSession extends FakeSession {
		override async prompt(text: string): Promise<void> {
			seenInDispatch.push(currentChildContext()?.nodeId);
			await super.prompt(text);
		}
	}
	const supervisor = new InProcessSupervisor({
		limits: { maxActive: 8 },
		sessionFactory: async () => new ProbeSession(),
	});
	try {
		supervisor.onEvent("root.worker", () => {
			seenByListener.push(currentChildContext()?.nodeId);
		});
		await supervisor.spawnChild({
			...testInput(root),
			childLaunchContext: {
				nodeId: "child-node",
				allowNested: false,
				utility: false,
				spawnMode: "inprocess",
			},
		});
		// Sessions emit synchronously from inside the child's await chain, so
		// without isolating the listener they'd observe "child-node" here.
		assert.ok(seenInDispatch.length > 0);
		assert.deepEqual([...new Set(seenInDispatch)], ["child-node"]);
		assert.ok(seenByListener.length > 0);
		assert.deepEqual(
			[...new Set(seenByListener)],
			[undefined],
			"host callbacks must not see the child's ALS identity",
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

// ── #209-1: extension provider registrations must reach the model runtime ──
//
// `defaultSessionFactory` itself stays module-private (D2): these tests pin the
// pure drain it calls, with a fake loader and a fake runtime. No network.

type Queues = Parameters<typeof drainExtensionRegistrations>[0] extends {
	getExtensions(): { runtime: infer R };
}
	? R
	: never;

function emptyQueues(): Queues {
	return {
		pendingProviderRegistrations: [],
		pendingNativeProviderRegistrations: [],
		pendingVirtualModelRegistrations: [],
	};
}

function fakeLoader(runtime: Queues) {
	return { getExtensions: () => ({ runtime }) };
}

interface FakeRuntime extends ModelRuntimeLike {
	/** Payloads the drain handed over, in call order across all three kinds. */
	calls: Array<{ kind: "provider" | "native" | "virtual"; payload: unknown; name?: string }>;
	refreshOptions: Array<{ allowNetwork?: boolean } | undefined>;
	/** Set inside the awaited refresh; false at return time proves it was not awaited. */
	refreshResolved: boolean;
	refreshStartedAfterCalls: boolean;
}

function fakeRuntime(options: { failProvider?: string; failNative?: boolean } = {}): FakeRuntime {
	const runtime: FakeRuntime = {
		calls: [],
		refreshOptions: [],
		refreshResolved: false,
		refreshStartedAfterCalls: false,
		registerProvider(name: string, config: unknown): void {
			if (options.failProvider === name) {
				throw new Error(`provider "${name}" is malformed`);
			}
			runtime.calls.push({ kind: "provider", payload: config, name });
		},
		registerNativeProvider(provider: unknown): void {
			if (options.failNative) throw new Error("native provider rejected");
			runtime.calls.push({ kind: "native", payload: provider });
		},
		registerVirtualModel(definition: unknown): void {
			runtime.calls.push({ kind: "virtual", payload: definition });
		},
		async refresh(refreshOptions?: { allowNetwork?: boolean }): Promise<unknown> {
			runtime.refreshStartedAfterCalls = runtime.calls.length > 0;
			runtime.refreshOptions.push(refreshOptions);
			// Yield a macrotask: an un-awaited refresh would still be pending when
			// the drain returns, leaving this flag false.
			await new Promise<void>((resolve) => setImmediate(resolve));
			runtime.refreshResolved = true;
			return { aborted: false, errors: new Map() };
		},
	};
	return runtime;
}

test("#209-1 drain: every queue is consumed, then refresh is awaited offline", async () => {
	const runtime = emptyQueues();
	runtime.pendingProviderRegistrations.push({
		name: "any-endpoint",
		config: { baseUrl: "https://example.invalid/v1" },
		extensionPath: "/plugins/pi-any-endpoint/dist/index.js",
	});
	runtime.pendingNativeProviderRegistrations.push({
		provider: { id: "native-one" },
		extensionPath: "/plugins/native.js",
	});
	runtime.pendingVirtualModelRegistrations.push({
		definition: { provider: "any-endpoint", id: "virtual-one" },
		extensionPath: "/plugins/virtual.js",
	});
	const modelRuntime = fakeRuntime();

	const diagnostics = await drainExtensionRegistrations(
		fakeLoader(runtime),
		modelRuntime,
	);

	assert.deepEqual(diagnostics, []);
	// Each register* exactly once, with the queued payload (not a copy of the queue).
	assert.deepEqual(modelRuntime.calls, [
		{ kind: "provider", name: "any-endpoint", payload: { baseUrl: "https://example.invalid/v1" } },
		{ kind: "native", payload: { id: "native-one" } },
		{ kind: "virtual", payload: { provider: "any-endpoint", id: "virtual-one" } },
	]);
	// All three queues emptied on the loader's own runtime object, so a later
	// session built from the same loader cannot replay them.
	assert.deepEqual(runtime.pendingProviderRegistrations, []);
	assert.deepEqual(runtime.pendingNativeProviderRegistrations, []);
	assert.deepEqual(runtime.pendingVirtualModelRegistrations, []);
	// Offline refresh, awaited: that is what lands the extension catalog in the
	// synchronous snapshot `resolveCliModel` reads.
	assert.deepEqual(modelRuntime.refreshOptions, [{ allowNetwork: false }]);
	assert.equal(modelRuntime.refreshResolved, true, "refresh must be awaited");
	assert.equal(modelRuntime.refreshStartedAfterCalls, true, "refresh must run after the registrations");
});

test("#209-1 drain: a throwing registerProvider is reported, not fatal", async () => {
	const runtime = emptyQueues();
	runtime.pendingProviderRegistrations.push(
		{
			name: "broken",
			config: { baseUrl: "not-a-url" },
			extensionPath: "/plugins/broken.js",
		},
		{
			name: "any-endpoint",
			config: { baseUrl: "https://example.invalid/v1" },
			extensionPath: "/plugins/pi-any-endpoint/dist/index.js",
		},
	);
	runtime.pendingNativeProviderRegistrations.push({
		provider: { id: "native-one" },
		extensionPath: "/plugins/native.js",
	});
	const modelRuntime = fakeRuntime({ failProvider: "broken" });

	const diagnostics = await drainExtensionRegistrations(
		fakeLoader(runtime),
		modelRuntime,
	);

	// One diagnostic naming the failing extension, and no throw.
	assert.equal(diagnostics.length, 1);
	assert.equal(diagnostics[0]!.type, "error");
	assert.match(diagnostics[0]!.message, /\/plugins\/broken\.js/);
	assert.match(diagnostics[0]!.message, /malformed/);
	// The healthy registrations still went through, including the later ones.
	assert.deepEqual(modelRuntime.calls, [
		{ kind: "provider", name: "any-endpoint", payload: { baseUrl: "https://example.invalid/v1" } },
		{ kind: "native", payload: { id: "native-one" } },
	]);
	// Queues are emptied even on failure, and the refresh still happens.
	assert.deepEqual(runtime.pendingProviderRegistrations, []);
	assert.deepEqual(runtime.pendingNativeProviderRegistrations, []);
	assert.deepEqual(modelRuntime.refreshOptions, [{ allowNetwork: false }]);
	assert.equal(modelRuntime.refreshResolved, true);
});

test("#209-1 drain: empty queues register nothing but still refresh offline", async () => {
	const runtime = emptyQueues();
	const modelRuntime = fakeRuntime();

	const diagnostics = await drainExtensionRegistrations(
		fakeLoader(runtime),
		modelRuntime,
	);

	assert.deepEqual(diagnostics, []);
	assert.deepEqual(modelRuntime.calls, []);
	assert.deepEqual(modelRuntime.refreshOptions, [{ allowNetwork: false }]);
	assert.equal(modelRuntime.refreshResolved, true);
});

// ── #227 D1/D2/D3: spawnChild returns on *acceptance*, not turn end ────────
//
// The bug: `spawnChild` awaited `session.prompt()` to the end of the whole
// agent run, so the ledger stayed without a job/sessionFile for the child's
// entire first turn (8–18 min in the field) and `collect` budgets started too
// late. These four cases pin the new contract: return on acceptance, drain the
// rest in the background inside the child's ALS scope, and keep a failed first
// turn visible.

test("inprocess: a never-resolving first prompt still returns the handle at the start bound (#227 D1)", { timeout: 5_000 }, async () => {
	const root = mkdtempSync(path.join(tmpdir(), "legion-inprocess-d1-"));
	const delayed: string[] = [];
	// A session that accepts the prompt and then runs "forever": this is the
	// shape of a real child mid-turn, not an error case.
	class HangingSession extends FakeSession {
		override prompt(text: string): Promise<void> {
			this.prompts.push(text);
			this.emit({ type: "agent_start" });
			return new Promise<void>(() => {});
		}
	}
	const supervisor = new InProcessSupervisor({
		limits: { maxActive: 8 },
		spawnStartTimeoutMs: 50,
		onSpawnDelayed: (message) => delayed.push(message),
		sessionFactory: async () => new HangingSession(),
	});
	try {
		const startedAt = Date.now();
		const handle = await supervisor.spawnChild(testInput(root));
		const elapsed = Date.now() - startedAt;
		assert.equal(handle.name, "root.worker");
		// The bound is 50ms; anything near the 15s default would fail here.
		assert.ok(elapsed < 1_000, `spawnChild must not await the turn (took ${elapsed}ms)`);
		// Alive: a delayed start is not a failure.
		assert.equal(supervisor.isAlive("root.worker"), true);
		// Told exactly once through the diagnostic hook.
		assert.equal(delayed.length, 1);
		assert.match(delayed[0]!, /did not accept its first prompt/);
		assert.match(delayed[0]!, /50ms/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("inprocess: a rejected first prompt keeps the child (no rollback delete) and reports the reason (#227 D2)", async () => {
	const root = mkdtempSync(path.join(tmpdir(), "legion-inprocess-d2-"));
	const refused: string[] = [];
	// Emits `agent_start` (so the turn really started), stays in-turn past the
	// start bound, then rejects. Spawn therefore returns first and the failure
	// lands *after* the caller already holds the handle — the R3 shape.
	class RejectingSession extends FakeSession {
		override prompt(text: string): Promise<void> {
			this.prompts.push(text);
			this.emit({ type: "agent_start" });
			return new Promise<void>((_resolve, reject) => {
				setTimeout(() => reject(new Error("provider exploded")), 120);
			});
		}
	}
	const supervisor = new InProcessSupervisor({
		limits: { maxActive: 8 },
		spawnStartTimeoutMs: 50,
		onSpawnRefused: (message) => refused.push(message),
		sessionFactory: async () => new RejectingSession(),
	});
	try {
		const handle = await supervisor.spawnChild(testInput(root));
		assert.equal(handle.name, "root.worker");
		// Registered while the turn is still active: the drain's catch must
		// resolve THIS waiter (not just set `lastTurnResult` for later callers).
		const pending = supervisor.waitSettled("root.worker", 1_000);
		await new Promise<void>((resolve) => setTimeout(resolve, 200));
		const resolved = await pending;
		assert.match(resolved.reason ?? "", /child turn failed/);
		// D2/R3: rollbackSpawn would have `children.delete`d this record.
		assert.equal(
			(supervisor as unknown as { children: Map<string, unknown> }).children.has("root.worker"),
			true,
			"a failed first turn must not delete the already-returned handle",
		);
		assert.equal(refused.length, 1);
		assert.match(refused[0]!, /provider exploded/);
		// The failure is visible to a waiter rather than reading as a clean turn.
		const settled = await supervisor.waitSettled("root.worker", 1_000);
		assert.equal(settled.settled, false);
		assert.match(settled.reason ?? "", /child turn failed/);
		assert.match(settled.reason ?? "", /provider exploded/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("inprocess: a drained prompt failure survives a later agent_settled (#227 D2 finally + D3)", async () => {
	const root = mkdtempSync(path.join(tmpdir(), "legion-inprocess-d2c-"));
	class LateSettleAfterReject extends FakeSession {
		override prompt(text: string): Promise<void> {
			this.prompts.push(text);
			this.emit({ type: "agent_start" });
			return new Promise<void>((_resolve, reject) => {
				setTimeout(() => reject(new Error("stream broke mid-turn")), 120);
			});
		}
	}
	const supervisor = new InProcessSupervisor({
		limits: { maxActive: 8 },
		spawnStartTimeoutMs: 50,
		sessionFactory: async () => new LateSettleAfterReject(),
	});
	try {
		await supervisor.spawnChild(testInput(root));
		await new Promise<void>((resolve) => setTimeout(resolve, 200));
		const record = (supervisor as unknown as {
			children: Map<string, { session: FakeSession | null }>;
		}).children.get("root.worker");
		// The settle arrives AFTER the drain already recorded the failure. Only
		// the error event handed to handleSessionEvent can still make it visible.
		record?.session?.settle();
		const settled = await supervisor.waitSettled("root.worker", 1_000);
		assert.match(
			settled.reason ?? "",
			/child turn failed: stream broke mid-turn/,
			"the drained failure must survive a later agent_settled",
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("inprocess: the background drain does not swallow agent_start/agent_settled (#227 D2)", async () => {
	const root = mkdtempSync(path.join(tmpdir(), "legion-inprocess-d2b-"));
	const supervisor = new InProcessSupervisor({
		limits: { maxActive: 8 },
		spawnStartTimeoutMs: 5_000,
		sessionFactory: async () => new FakeSession(),
	});
	try {
		const seen: string[] = [];
		supervisor.onEvent("root.worker", (event) => {
			seen.push(event.type);
		});
		await supervisor.spawnChild(testInput(root));
		// FakeSession.prompt is non-blocking (F10) and settles on demand; the
		// settle events arrive after spawnChild has already returned.
		supervisor.onEvent("root.worker", (event) => {
			seen.push(event.type);
		});
		const sessions = (supervisor as unknown as {
			children: Map<string, { session: FakeSession | null }>;
		}).children.get("root.worker");
		sessions?.session?.settle();
		await new Promise<void>((resolve) => setTimeout(resolve, 20));
		assert.ok(seen.includes("agent_start"), `missing agent_start in ${JSON.stringify(seen)}`);
		assert.ok(seen.includes("agent_settled"), `missing agent_settled in ${JSON.stringify(seen)}`);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("inprocess: an accepted first prompt returns before the start bound (#227 D1 condition a)", async () => {
	const root = mkdtempSync(path.join(tmpdir(), "legion-inprocess-d1b-"));
	// The factory seeds the transcript exactly like production does, and the
	// prompt writes the user line for *this* turn — F7's acceptance signal.
	class AcceptingSession extends FakeSession {
		private readonly file: string;
		constructor(file: string) {
			super();
			this.file = file;
		}
		override prompt(text: string): Promise<void> {
			this.prompts.push(text);
			// F7: the SDK appends the user message before it runs the agent, so
			// acceptance is observable while the turn is still in flight.
			const manager = SessionManager.open(this.file, undefined, path.dirname(this.file));
			manager.appendMessage({ role: "user", content: text, timestamp: Date.now() });
			this.emit({ type: "agent_start" });
			this.emit({ type: "turn_start" });
			// Never resolves: the run keeps going. Only condition (a) — the user
			// line appearing in the transcript — can end the wait before the bound.
			return new Promise<void>(() => {});
		}
	}
	const supervisor = new InProcessSupervisor({
		limits: { maxActive: 8 },
		// Far longer than the assertion below: passing proves condition (a) fired
		// rather than the bound.
		spawnStartTimeoutMs: 5_000,
		sessionFactory: async (input) => new AcceptingSession(input.sessionFile),
	});
	try {
		const startedAt = Date.now();
		await supervisor.spawnChild(testInput(root));
		const elapsed = Date.now() - startedAt;
		assert.ok(elapsed < 1_000, `acceptance must return early (took ${elapsed}ms)`);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("inprocess: an error event becomes visible on settle without inventing a stopReason (#227 D3)", async () => {
	const root = mkdtempSync(path.join(tmpdir(), "legion-inprocess-d3-"));
	const supervisor = new InProcessSupervisor({
		limits: { maxActive: 8 },
		spawnStartTimeoutMs: 5_000,
		sessionFactory: async () => new FakeSession(),
	});
	try {
		await supervisor.spawnChild(testInput(root));
		const record = (supervisor as unknown as {
			children: Map<string, { session: FakeSession | null }>;
		}).children.get("root.worker");
		const session = record?.session;
		assert.ok(session);
		// A provider failure that still settles the run (F8): today `error` was
		// dropped, so the settle looked clean.
		session.emit({ type: "error", message: "model refused the request" });
		session.settle();
		const settled = await supervisor.waitSettled("root.worker", 1_000);
		assert.equal(settled.settled, true);
		assert.equal(settled.abnormal, false);
		assert.equal(settled.aborted, false);
		assert.match(settled.reason ?? "", /model refused the request/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

// ── #227 D1a: a prompt rejected BEFORE acceptance must fail the spawn ──────
//
// Regression this guards: making `spawnChild` non-blocking swallowed the
// pre-acceptance reject. `Orchestrator.launch` only downgrades to the next
// `fallbackModels` entry when `spawnChild` *throws* `SubagentError`
// (`canFallbackStart`, orchestrator.ts:235-240). Returning a handle instead
// silently disabled the fallback chain for a child that fails instantly —
// the real trigger is no model / no API key / mid-compaction, where the SDK
// throws before `appendMessage`, so no user line ever reaches the transcript
// (agent-session.js:1568-1581).

test("inprocess: a first prompt rejected before acceptance fails the spawn (D1a)", async () => {
	const root = mkdtempSync(path.join(tmpdir(), "legion-inprocess-d1a-"));
	// Exactly the failing shape: the prompt throws immediately and — like the
	// SDK on a missing key — never writes a user line for this turn.
	class NoKeySession extends FakeSession {
		override async prompt(): Promise<void> {
			throw new Error("No API key found for provider 'any-endpoint'.");
		}
	}
	const supervisor = new InProcessSupervisor({
		limits: { maxActive: 8 },
		spawnStartTimeoutMs: 5_000,
		sessionFactory: async () => new NoKeySession(),
	});
	try {
		await assert.rejects(
			() => supervisor.spawnChild(testInput(root)),
			(error: unknown) => {
				// START_FAILED is what `canFallbackStart` requires to retry.
				assert.equal((error as { code?: string }).code, ErrorCodes.START_FAILED);
				// Provider text must survive for doctor + fallback diagnostics.
				assert.match((error as Error).message, /No API key found for provider/);
				return true;
			},
		);
		// Fully rolled back: no ghost child holding a name or a budget slot.
		const children = (supervisor as unknown as { children: Map<string, unknown> }).children;
		assert.equal(children.has("root.worker"), false, "no ghost child after a failed spawn");
		assert.equal(supervisor.isAlive("root.worker"), false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("inprocess: a prompt rejected AFTER acceptance still returns the handle (D1a counterpart)", async () => {
	const root = mkdtempSync(path.join(tmpdir(), "legion-inprocess-d1a2-"));
	// The other half of D1a: the turn really started (a user line landed), so the
	// spawn succeeded and the later failure is a runtime failure (D2), not a
	// spawn failure. This is the behaviour the pre-fix code applied to BOTH
	// cases — it must survive the fix for the accepted case only.
	class AcceptThenFail extends FakeSession {
		private readonly file: string;
		constructor(file: string) {
			super();
			this.file = file;
		}
		override prompt(text: string): Promise<void> {
			this.prompts.push(text);
			const manager = SessionManager.open(this.file, undefined, path.dirname(this.file));
			manager.appendMessage({ role: "user", content: text, timestamp: Date.now() });
			this.emit({ type: "agent_start" });
			return new Promise<void>((_resolve, reject) => {
				setTimeout(() => reject(new Error("stream broke mid-turn")), 120);
			});
		}
	}
	const supervisor = new InProcessSupervisor({
		limits: { maxActive: 8 },
		spawnStartTimeoutMs: 50,
		sessionFactory: async (input) => new AcceptThenFail(input.sessionFile),
	});
	try {
		const handle = await supervisor.spawnChild(testInput(root));
		assert.equal(handle.name, "root.worker");
		// Committed to a handle because the turn was accepted before it failed.
		const children = (supervisor as unknown as { children: Map<string, unknown> }).children;
		assert.equal(children.has("root.worker"), true, "an accepted turn must not be rolled back");
		await new Promise<void>((resolve) => setTimeout(resolve, 200));
		const settled = await supervisor.waitSettled("root.worker", 1_000);
		assert.match(settled.reason ?? "", /child turn failed/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

// ── #266 W2: supervisor hooks for the launch admission queue ───────────────
//
// Contract: `docs/contracts/launch-admission-queue-v1.md` §4.2 / §13.1 / §13.5.
// These cases pin three things master had no way to assert:
//   1. the four refusals are byte-identical to master (A6) now that they are
//      produced by W1's pure `evaluateInProcessAdmission` (D1-a),
//   2. `onSlotReleased` fires on `retired`/`exited` only — never on `idle`
//      (A19/F9/§13.5), exactly once per child,
//   3. `preflightAdmission` / `admissionCounts` are read-only (I-O1).

test("#266 A6: inprocess maxActive refusal is byte-identical to master", async () => {
	const h = harness({ maxActive: 1 });
	try {
		await h.supervisor.spawnChild(testInput(h.root, "a.one"));
		const err = await refusalOf(() => h.supervisor.spawnChild(testInput(h.root, "b.two")));
		// Whole string, including the semicolon and spacing: this is the text
		// #197 users saw, and the reason D1-a forbids a second implementation.
		assert.equal(
			err.message,
			"inprocess maxActive reached (1/1); raise subagents.inprocess.maxActive to allow more",
		);
		assert.equal((err as { code?: string }).code, ErrorCodes.BUDGET_EXCEEDED);
	} finally {
		h.close();
	}
});

test("#266 A6: inprocess nesting-limit refusal is byte-identical to master", async () => {
	const h = harness({ maxActive: 8, maxDepth: 0 });
	try {
		const err = await refusalOf(() => h.supervisor.spawnChild(testInput(h.root)));
		assert.equal(
			err.message,
			"inprocess nesting limit reached (depth 0, max 0); raise subagents.inprocess.maxDepth to allow deeper nesting",
		);
		assert.equal((err as { code?: string }).code, ErrorCodes.BUDGET_EXCEEDED);
	} finally {
		h.close();
	}
});

test("#266 A6: inprocess spawn-budget refusal is byte-identical to master", async () => {
	const h = harness({ maxActive: 8, maxSpawnsPerSession: 1 });
	try {
		await h.supervisor.spawnChild(testInput(h.root, "one"));
		await h.supervisor.retire("one");
		const err = await refusalOf(() => h.supervisor.spawnChild(testInput(h.root, "two")));
		assert.equal(
			err.message,
			"inprocess spawn budget exhausted (1/1); raise subagents.inprocess.maxSpawnsPerSession to allow more",
		);
		assert.equal((err as { code?: string }).code, ErrorCodes.BUDGET_EXCEEDED);
	} finally {
		h.close();
	}
});

test("#266 A6: maxChildrenPerNode refusal is byte-identical to master (named + <root>)", async () => {
	const named = harness({ maxActive: 8, maxChildrenPerNode: 1 });
	try {
		await named.supervisor.spawnChild(testInput(named.root, "root.a"));
		const err = await refusalOf(() => named.supervisor.spawnChild(testInput(named.root, "root.b")));
		assert.equal(err.message, "inprocess maxChildrenPerNode reached for 'root' (1/1)");
		assert.equal((err as { code?: string }).code, ErrorCodes.BUDGET_EXCEEDED);
	} finally {
		named.close();
	}

	// A name with no dot is a root-level child: the parent key renders `<root>`,
	// which is the one substitution a rewrite could silently get wrong.
	const root = harness({ maxActive: 8, maxChildrenPerNode: 0 });
	try {
		const err = await refusalOf(() => root.supervisor.spawnChild(testInput(root.root, "solo")));
		assert.equal(err.message, "inprocess maxChildrenPerNode reached for '<root>' (0/0)");
	} finally {
		root.close();
	}
});

test("#266 A19: onSlotReleased fires on retire, not on agent_settled/idle", async () => {
	const root = mkdtempSync(path.join(tmpdir(), "legion-inprocess-slots-"));
	const released: { name: string; parentKey: string; state: string }[] = [];
	const supervisor = new InProcessSupervisor({
		limits: { maxActive: 8 },
		sessionFactory: async () => new FakeSession(),
		onSlotReleased: (event) => released.push(event),
	});
	try {
		const record = (name: string) =>
			(supervisor as unknown as { children: Map<string, { session: FakeSession | null }> })
				.children.get(name);
		const child = await supervisor.spawnChild(testInput(root, "root.worker"));
		assert.equal(child.name, "root.worker");

		// F9/§13.5: `agent_settled` moves the child to idle, which STILL holds a
		// slot. Emitting here would make admission jitter — the probe reports a
		// free slot the real gate then refuses.
		record("root.worker")!.session!.settle();
		await supervisor.waitSettled("root.worker", 1_000);
		assert.deepEqual(released, [], "idle must not release a slot");

		await supervisor.retire("root.worker");
		assert.deepEqual(released, [
			{ name: "root.worker", parentKey: "root", state: "retired" },
		]);

		// Idempotent: a second retire is still a single release.
		await supervisor.retire("root.worker");
		assert.equal(released.length, 1, "one departure emits exactly one event");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("#266 A19: onSlotReleased fires once with state 'exited' when spawn fails", async () => {
	const root = mkdtempSync(path.join(tmpdir(), "legion-inprocess-slots-exit-"));
	const released: { name: string; parentKey: string; state: string }[] = [];
	class NoKeySession extends FakeSession {
		override async prompt(): Promise<void> {
			throw new Error("No API key found for provider 'any-endpoint'.");
		}
	}
	const supervisor = new InProcessSupervisor({
		limits: { maxActive: 8 },
		spawnStartTimeoutMs: 5_000,
		sessionFactory: async () => new NoKeySession(),
		onSlotReleased: (event) => released.push(event),
	});
	try {
		await assert.rejects(
			() => supervisor.spawnChild(testInput(root, "root.worker")),
			(error: unknown) =>
				(error as { code?: string }).code === ErrorCodes.START_FAILED,
		);
		// `rollbackSpawn` freed the slot on the failure path: a queued sibling
		// waiting on this fanout slot must be able to proceed.
		assert.deepEqual(released, [
			{ name: "root.worker", parentKey: "root", state: "exited" },
		]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("#266 I-O1: preflightAdmission is read-only and reports the queueable gate", async () => {
	const root = mkdtempSync(path.join(tmpdir(), "legion-inprocess-preflight-"));
	const supervisor = new InProcessSupervisor({
		limits: { maxActive: 8, maxChildrenPerNode: 1 },
		sessionFactory: async () => new FakeSession(),
	});
	const children = (supervisor as unknown as { children: Map<string, unknown> }).children;
	try {
		await supervisor.spawnChild(testInput(root, "root.a"));
		const sizeBefore = children.size;

		for (let i = 0; i < 5; i += 1) {
			assert.deepEqual(supervisor.preflightAdmission("root.b"), {
				admitted: false,
				queueable: true,
				gate: "inprocess.maxChildrenPerNode",
				dimension: "fanout",
				message: "inprocess maxChildrenPerNode reached for 'root' (1/1)",
			});
		}
		// Advisory probe (§13.1 I-O1): five calls changed nothing, so the
		// authoritative gate still refuses exactly as before.
		assert.equal(children.size, sizeBefore, "preflightAdmission must not register a child");
		await assert.rejects(
			() => supervisor.spawnChild(testInput(root, "root.b")),
			(error: unknown) =>
				(error as { code?: string }).code === ErrorCodes.BUDGET_EXCEEDED &&
				(error as Error).message === "inprocess maxChildrenPerNode reached for 'root' (1/1)",
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("#266 D11: maxChildrenPerNode 0 is a hard refusal, never a queueable one", async () => {
	const root = mkdtempSync(path.join(tmpdir(), "legion-inprocess-preflight-0-"));
	const supervisor = new InProcessSupervisor({
		limits: { maxActive: 8, maxChildrenPerNode: 0 },
		sessionFactory: async () => new FakeSession(),
	});
	try {
		// D11/F11: 0 means "no children at all", so `siblings >= 0` can never
		// become satisfiable — queueing it would disguise a config error as a
		// 15-minute wait. The distinct gate name makes that assertable.
		assert.deepEqual(supervisor.preflightAdmission("root.a"), {
			admitted: false,
			queueable: false,
			gate: "inprocess.maxChildrenPerNode.disabled",
			message: "inprocess maxChildrenPerNode reached for 'root' (0/0)",
		});
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("#266 admissionCounts: same counts and limits as the real gate", async () => {
	const root = mkdtempSync(path.join(tmpdir(), "legion-inprocess-counts-"));
	const supervisor = new InProcessSupervisor({
		limits: { maxActive: 8, maxDepth: 3, maxChildrenPerNode: 5, maxSpawnsPerSession: 7 },
		sessionFactory: async () => new FakeSession(),
	});
	try {
		await supervisor.spawnChild(testInput(root, "root.a"));
		await supervisor.spawnChild(testInput(root, "root.b"));
		assert.deepEqual(supervisor.admissionCounts("root.c"), {
			parentKey: "root",
			// Two live siblings under `root`, both globally live.
			siblings: 2,
			active: 2,
			spawnCount: 2,
			depth: inProcessDepth(),
			limits: {
				maxDepth: 3,
				maxChildrenPerNode: 5,
				maxActive: 8,
				maxSpawnsPerSession: 7,
			},
		});

		// An absent `maxSpawnsPerSession` is passed through as undefined, not
		// defaulted: "no limit" and "over the limit" are different verdicts.
		const unconfigured = new InProcessSupervisor({
			getLimits: () => undefined,
			sessionFactory: async () => new FakeSession(),
		});
		const counts = unconfigured.admissionCounts("root.a");
		assert.equal(counts.limits.maxSpawnsPerSession, undefined);
		assert.equal("maxSpawnsPerSession" in counts.limits, false);
		assert.equal(counts.siblings, 0);
		assert.equal(counts.active, 0);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

// ── R1-b: the in-process backend warms discovery on its own (contract §7 A15) ──

/** A fake `pi` on PATH reporting one package dir, so `pi list` is a real call. */
function fakePiHost(): { entry: string; pathValue: string; piCalls(): number; cleanup(): void } {
	const root = mkdtempSync(path.join(tmpdir(), "legion-warm-inprocess-"));
	const pkgDir = path.join(root, "npm", "node_modules", "fake-lens");
	mkdirSync(pkgDir, { recursive: true });
	writeFileSync(path.join(pkgDir, "index.ts"), "export default {};\n");
	const binDir = path.join(root, "bin");
	mkdirSync(binDir, { recursive: true });
	const logPath = path.join(root, "calls.log");
	const shim = path.join(binDir, "pi");
	writeFileSync(
		shim,
		[
			"#!/bin/sh",
			`echo "pi $*" >> ${JSON.stringify(logPath)}`,
			'echo "User packages:"',
			`echo "    ${pkgDir}"`,
		].join("\n") + "\n",
	);
	chmodSync(shim, 0o755);
	const lines = (): string[] => {
		try {
			return readFileSync(logPath, "utf8").split("\n").filter((line) => line.length > 0);
		} catch {
			return [];
		}
	};
	return {
		entry: path.join(pkgDir, "index.ts"),
		pathValue: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
		piCalls: () => lines().filter((line) => line.startsWith("pi ")).length,
		cleanup: () => rmSync(root, { recursive: true, force: true }),
	};
}

/** Run `fn` with the fake host first on PATH and a cold discovery cache. */
async function withFakePiHost<T>(host: ReturnType<typeof fakePiHost>, fn: () => Promise<T>): Promise<T> {
	const prevPath = process.env.PATH;
	process.env.PATH = host.pathValue;
	resetExtensionDiscoveryCache();
	try {
		return await fn();
	} finally {
		resetExtensionDiscoveryCache();
		if (prevPath === undefined) delete process.env.PATH;
		else process.env.PATH = prevPath;
	}
}

test("A15: a directly-constructed InProcessSupervisor warms discovery through Orchestrator.launch", async () => {
	// Same public shape as A14 but on the in-process backend. The plan is built
	// deep inside the injected session factory, so this also proves the warm-up
	// happens before the factory (and therefore before `collectChildExtensions`)
	// reads the sync cache.
	const host = fakePiHost();
	const root = mkdtempSync(path.join(tmpdir(), "legion-warm-inprocess-run-"));
	const plans: string[][] = [];
	const supervisor = new InProcessSupervisor({
		limits: { maxActive: 8 },
		sessionFactory: async () => {
			// The production factory calls this exactly here; recording it pins the
			// ordering against the warm-up.
			plans.push(buildInProcessSessionPlan({
				name: "worker",
				cwd: root,
				agent: testAgent(),
				sessionFile: path.join(root, "worker.jsonl"),
			} as InProcessSessionFactoryInput).additionalExtensionPaths);
			return new FakeSession();
		},
	});
	try {
		await withFakePiHost(host, async () => {
			assert.equal(discoveredHostExtensions(), undefined, "precondition: cold cache");
			const orchestrator = new Orchestrator({ supervisor, runDir: root, cwd: root, maxDepth: 4 });
			const handle = await orchestrator.launch({
				agent: { ...testAgent(), spawnMode: "inprocess" },
				task: "t",
				name: "worker",
				worktree: false,
			} as never);
			assert.deepEqual(
				discoveredHostExtensions(),
				[host.entry],
				"InProcessSupervisor.spawnChild must warm discovery itself (R1-b)",
			);
			assert.equal(plans.length, 1, "the plan was built once, inside the spawn");
			assert.ok(
				plans[0]!.includes(host.entry),
				"and the factory's plan saw the warm set — the warm-up precedes it",
			);
			orchestrator.flushLaunchQueue("test cleanup");
			await supervisor.retire(handle.name).catch(() => {});
		});
	} finally {
		rmSync(root, { recursive: true, force: true });
		host.cleanup();
	}
});
