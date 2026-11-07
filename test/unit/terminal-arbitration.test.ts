/**
 * Centurion terminal backend v1 — arbitration
 * (`docs/contracts/centurion-terminal-backend-v1.md` D1/D2, invariants I1/I4/I5).
 *
 * The orchestrator picks ONE backend per launch, and the terminal backend is
 * reachable from exactly one place: a worktree-holding centurion inside an `hc`
 * terminal. These tests pin all four sides of that gate against a REAL
 * `RoutingSupervisor` (the frozen rule: a fake supervisor cannot prove an
 * arbitration, because the router's own guards are part of the answer):
 *
 *   - `HC_TERMINAL_SOCKET` + `HC_TERMINAL_ID` present ⇒ `terminal`;
 *   - either missing ⇒ byte-identical to the old decision (`rpc`);
 *   - non-centurion ⇒ unchanged (`inprocess`, worktree demoted);
 *   - the default (no worktree) is still `inprocess`.
 *
 * Env is set/deleted around each launch and restored afterwards; the tests in
 * this file run sequentially (`node:test` default), so the mutation is scoped.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { Orchestrator } from "../../src/runs/orchestrator.ts";
import { RoutingSupervisor } from "../../src/supervisor/routing-supervisor.ts";
import type { RpcSupervisor } from "../../src/supervisor/rpc-supervisor.ts";
import type { InProcessSupervisor } from "../../src/supervisor/inprocess-supervisor.ts";
import type { TerminalSupervisor } from "../../src/supervisor/terminal-supervisor.ts";
import { terminalHostAvailable } from "../../src/supervisor/terminal-supervisor.ts";
import { resolveSpawnMode } from "../../src/supervisor/spawn-mode.ts";
import { InMemoryUIProxy } from "../../src/supervisor/ui-proxy.ts";
import { ErrorCodes, SubagentError, type AgentConfig } from "../../src/shared/types.ts";

const SOCKET = "/tmp/hc-test/default.sock";
const TERMINAL = "t1k";

interface AcceptedLaunch {
	name: string;
	mode: string | undefined;
	worktree: boolean | undefined;
}

/** A real router whose three backends only record what reached them. */
function realRouter(options: { terminal?: boolean } = {}): {
	supervisor: RoutingSupervisor;
	accepted: AcceptedLaunch[];
} {
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
	const terminal = {
		isAlive: () => false,
		stats: async () => null,
		spawnChild: async (input: { name: string; sessionFile: string; agent: AgentConfig }) => record(input, 1003),
	} as unknown as TerminalSupervisor;
	const supervisor = new RoutingSupervisor({
		rpc,
		inprocess,
		...(options.terminal === false ? {} : { terminal }),
		uiProxy,
	});
	return { supervisor, accepted };
}

function agent(overrides: Partial<AgentConfig> = {}): AgentConfig {
	return {
		name: "worker",
		description: "terminal arbitration test role",
		systemPromptMode: "append",
		inheritProjectContext: false,
		inheritSkills: false,
		kind: "pi",
		systemPrompt: "You are a test role.",
		source: "user",
		filePath: "/fake/role.md",
		...overrides,
	};
}

function gitRepo(root: string): string {
	const repo = path.join(root, "repo");
	execFileSync("git", ["init", "-q", repo]);
	execFileSync("git", ["-C", repo, "-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-qm", "init"]);
	return repo;
}

interface Harness {
	runDir: string;
	repo: string;
	supervisor: RoutingSupervisor;
	accepted: AcceptedLaunch[];
	cleanup(): void;
}

function harness(options: { terminal?: boolean } = {}): Harness {
	const root = mkdtempSync(path.join(tmpdir(), "terminal-arbitration-"));
	const { supervisor, accepted } = realRouter(options);
	return {
		runDir: path.join(root, "run"),
		repo: gitRepo(root),
		supervisor,
		accepted,
		cleanup: () => rmSync(root, { recursive: true, force: true }),
	};
}

/** Run `fn` with exactly the given HC markers (an absent key is deleted). */
async function withHcEnv<T>(
	vars: { socket?: string; id?: string },
	fn: () => Promise<T>,
): Promise<T> {
	const keys = ["HC_TERMINAL_SOCKET", "HC_TERMINAL_ID"] as const;
	const previous = new Map(keys.map((key) => [key, process.env[key]]));
	const apply = (key: (typeof keys)[number], value: string | undefined): void => {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	};
	try {
		apply("HC_TERMINAL_SOCKET", vars.socket);
		apply("HC_TERMINAL_ID", vars.id);
		return await fn();
	} finally {
		for (const key of keys) apply(key, previous.get(key));
	}
}

// ── D2 / I4: host detection & the literal ─────────────────────────────────

test("D2: terminalHostAvailable needs BOTH markers (no probe of any kind)", () => {
	assert.equal(terminalHostAvailable({}), false);
	assert.equal(terminalHostAvailable({ HC_TERMINAL_SOCKET: SOCKET }), false);
	assert.equal(terminalHostAvailable({ HC_TERMINAL_ID: TERMINAL }), false);
	assert.equal(terminalHostAvailable({ HC_TERMINAL_SOCKET: SOCKET, HC_TERMINAL_ID: TERMINAL }), true);
});

test("I4: SPAWN_MODES knows the new literal, and it resolves like any other", () => {
	assert.equal(resolveSpawnMode({ spawnMode: "terminal" }), "terminal");
	assert.equal(resolveSpawnMode({ spawnMode: undefined }), "inprocess");
	assert.equal(resolveSpawnMode(undefined), "inprocess");
});

// ── D1 / D2: the arbitration table ────────────────────────────────────────

test("D1/D2: inside hc, a worktree-holding centurion runs on the terminal backend", async () => {
	await withHcEnv({ socket: SOCKET, id: TERMINAL }, async () => {
		const h = harness();
		try {
			const orchestrator = new Orchestrator({ supervisor: h.supervisor, runDir: h.runDir, cwd: h.repo });
			const handle = await orchestrator.launch({
				agent: agent({ name: "centurion", worktree: true }),
				task: "isolated terminal work",
			});
			assert.ok(handle.child.worktreePath, "the worktree is still created by pi-legion (I2)");
			assert.deepEqual(h.accepted, [{ name: handle.name, mode: "terminal", worktree: true }]);
		} finally {
			h.cleanup();
		}
	});
});

test("D2/I1: without the HC markers the arbitration is byte-identical to today (rpc)", async () => {
	await withHcEnv({}, async () => {
		const h = harness();
		try {
			const orchestrator = new Orchestrator({ supervisor: h.supervisor, runDir: h.runDir, cwd: h.repo });
			const handle = await orchestrator.launch({
				agent: agent({ name: "centurion", worktree: true }),
				task: "isolated rpc work",
			});
			assert.ok(handle.child.worktreePath);
			assert.deepEqual(h.accepted, [{ name: handle.name, mode: "rpc", worktree: true }]);
		} finally {
			h.cleanup();
		}
	});
});

test("D2: ONE marker missing is still the old decision (no partial detection)", async () => {
	await withHcEnv({ socket: SOCKET }, async () => {
		const h = harness();
		try {
			const orchestrator = new Orchestrator({ supervisor: h.supervisor, runDir: h.runDir, cwd: h.repo });
			const handle = await orchestrator.launch({
				agent: agent({ name: "centurion", worktree: true }),
				task: "socket only",
			});
			assert.deepEqual(h.accepted, [{ name: handle.name, mode: "rpc", worktree: true }]);
		} finally {
			h.cleanup();
		}
	});
});

test("D1/I5: a non-centurion stays inprocess inside hc (terminal is centurion-only)", async () => {
	await withHcEnv({ socket: SOCKET, id: TERMINAL }, async () => {
		const h = harness();
		const events: unknown[] = [];
		try {
			const orchestrator = new Orchestrator({
				supervisor: h.supervisor,
				runDir: h.runDir,
				cwd: h.repo,
				onBudgetRefused: (event) => events.push(event),
			});
			const handle = await orchestrator.launch({ agent: agent({ worktree: true }), task: "no isolation" });
			assert.equal(handle.child.worktreePath, undefined, "the #214 demotion is untouched");
			assert.deepEqual(h.accepted, [{ name: handle.name, mode: "inprocess", worktree: false }]);
			assert.deepEqual(events, [{
				type: "budget_refused",
				reason: "worktree_denied_non_centurion",
				agent: "worker",
			}]);
		} finally {
			h.cleanup();
		}
	});
});

test("I5: the inprocess default is unchanged, with or without the HC markers", async () => {
	await withHcEnv({ socket: SOCKET, id: TERMINAL }, async () => {
		const h = harness();
		try {
			const orchestrator = new Orchestrator({ supervisor: h.supervisor, runDir: h.runDir, cwd: h.repo });
			await orchestrator.launch({ agent: agent(), task: "shared checkout", worktree: false });
			assert.equal(h.accepted[0]?.mode, "inprocess");
			assert.equal(h.accepted[0]?.worktree, false);
		} finally {
			h.cleanup();
		}
	});
});

// ── the router's spawn guard ──────────────────────────────────────────────

function spawnInput(repo: string, overrides: Partial<Parameters<RoutingSupervisor["spawnChild"]>[0]> = {}) {
	return {
		name: "centurion-0",
		task: "guard probe",
		sessionFile: path.join(repo, "session.jsonl"),
		tempDir: repo,
		cwd: repo,
		agent: agent({ name: "centurion", spawnMode: "terminal", worktree: true }),
		...overrides,
	};
}

test("spawn guard: terminal + worktree is allowed (unlike inprocess + worktree)", async () => {
	const h = harness();
	try {
		await h.supervisor.spawnChild(spawnInput(h.repo));
		assert.deepEqual(h.accepted, [{ name: "centurion-0", mode: "terminal", worktree: true }]);
	} finally {
		h.cleanup();
	}
});

test("spawn guard: the frozen inprocess+worktree refusal keeps its wording", async () => {
	const h = harness();
	try {
		await assert.rejects(
			() =>
				h.supervisor.spawnChild(
					spawnInput(h.repo, {
						agent: agent({ name: "centurion", spawnMode: "inprocess", worktree: true }),
					}),
				),
			(error: unknown) => {
				assert.ok(error instanceof SubagentError);
				assert.equal(error.code, ErrorCodes.INVALID_PARAMS);
				assert.match(error.message, /cannot (use|combine with) worktree/);
				assert.match(error.message, /set worktree: false/);
				return true;
			},
		);
		assert.deepEqual(h.accepted, [], "nothing may reach a backend");
	} finally {
		h.cleanup();
	}
});

test("spawn guard: a router with no terminal backend refuses terminal loudly", async () => {
	const h = harness({ terminal: false });
	try {
		await assert.rejects(
			() => h.supervisor.spawnChild(spawnInput(h.repo)),
			(error: unknown) => {
				assert.ok(error instanceof SubagentError);
				assert.equal(error.code, ErrorCodes.INVALID_PARAMS);
				assert.match(error.message, /requires a terminal backend/);
				return true;
			},
		);
		assert.deepEqual(h.accepted, []);
	} finally {
		h.cleanup();
	}
});
