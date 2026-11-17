/**
 * Cross-machine launch guards (`docs/contracts/cross-machine-spawn-v1.md` D1).
 *
 * D1 is the contract's hardest promise: a launch that names a `host` never runs
 * on this machine by accident. Four things are refused, each with the reason the
 * caller can act on, and the fifth case proves the accepted shape — that the
 * arbitration really reaches the terminal backend regardless of `worktree`.
 *
 * These run through the real `Orchestrator.launch`, so the assertions are about
 * behaviour rather than about a guard function existing.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { Orchestrator } from "../../src/runs/orchestrator.ts";
import { resolveHostTarget, type HostTarget } from "../../src/runs/remote.ts";
import { ErrorCodes, SubagentError, type AgentConfig } from "../../src/shared/types.ts";
import { FakeSupervisor } from "../helpers/fake-supervisor.ts";

const HOST = "vps";

function agent(overrides: Partial<AgentConfig> = {}): AgentConfig {
	return {
		name: "centurion",
		description: "cross-machine guard test role",
		systemPromptMode: "append",
		inheritProjectContext: false,
		inheritSkills: false,
		kind: "pi",
		systemPrompt: "You are a test centurion.",
		source: "user",
		filePath: "/fake/centurion.md",
		worktree: false,
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
	const supervisor = new FakeSupervisor();
	return {
		root,
		supervisor,
		orchestrator: new Orchestrator({
			supervisor,
			runDir: path.join(root, "run"),
			cwd: gitRepo(root),
		}),
		cleanup: () => rmSync(root, { recursive: true, force: true }),
	};
}

function target(overrides: Partial<HostTarget> = {}): HostTarget {
	return { host: HOST, cwd: "/srv/app", node: "node", piCli: "pi", pathMap: [], ...overrides };
}

/** Run `body` with the two hc env markers set (so `terminalHostAvailable` is true). */
async function insideHcTerminal(body: () => Promise<void>): Promise<void> {
	const socket = process.env.HC_TERMINAL_SOCKET;
	const id = process.env.HC_TERMINAL_ID;
	process.env.HC_TERMINAL_SOCKET = "/tmp/hc-guard/default.sock";
	process.env.HC_TERMINAL_ID = "t1k";
	try {
		await body();
	} finally {
		if (socket === undefined) delete process.env.HC_TERMINAL_SOCKET;
		else process.env.HC_TERMINAL_SOCKET = socket;
		if (id === undefined) delete process.env.HC_TERMINAL_ID;
		else process.env.HC_TERMINAL_ID = id;
	}
}

function expectRefusal(fragment: RegExp) {
	return (error: unknown): boolean => {
		assert.ok(error instanceof SubagentError, `must refuse with a SubagentError, got ${String(error)}`);
		assert.equal((error as SubagentError).code, ErrorCodes.INVALID_PARAMS);
		assert.match((error as SubagentError).message, fragment);
		return true;
	};
}

test("D1: a host without a resolved target is refused (never a local fallback)", async () => {
	const h = harness("xm-guard-target-");
	try {
		await assert.rejects(
			() => h.orchestrator.launch({ agent: agent(), task: "t", host: HOST }),
			expectRefusal(/resolved target/),
		);
		assert.equal(h.supervisor.calls.length, 0, "nothing may be spawned");
	} finally {
		h.cleanup();
	}
});

test("D1: a host whose target names another machine is refused", async () => {
	const h = harness("xm-guard-mismatch-");
	try {
		await assert.rejects(
			() => h.orchestrator.launch({ agent: agent(), task: "t", host: HOST, hostTarget: target({ host: "other" }) }),
			expectRefusal(/different machine/),
		);
		assert.equal(h.supervisor.calls.length, 0);
	} finally {
		h.cleanup();
	}
});

test("D1: a host outside an hc terminal is refused (rpc/inprocess cannot leave this machine)", async () => {
	const h = harness("xm-guard-nohc-");
	const socket = process.env.HC_TERMINAL_SOCKET;
	const id = process.env.HC_TERMINAL_ID;
	delete process.env.HC_TERMINAL_SOCKET;
	delete process.env.HC_TERMINAL_ID;
	try {
		await assert.rejects(
			() => h.orchestrator.launch({ agent: agent(), task: "t", host: HOST, hostTarget: target() }),
			expectRefusal(/needs an hc terminal host/),
		);
		assert.equal(h.supervisor.calls.length, 0);
	} finally {
		if (socket !== undefined) process.env.HC_TERMINAL_SOCKET = socket;
		if (id !== undefined) process.env.HC_TERMINAL_ID = id;
		h.cleanup();
	}
});

test("D1: host + worktree:true is refused until S2, and says so", async () => {
	const h = harness("xm-guard-worktree-");
	await insideHcTerminal(async () => {
		try {
			await assert.rejects(
				() => h.orchestrator.launch({ agent: agent({ worktree: true }), task: "t", host: HOST, hostTarget: target(), worktree: true }),
				expectRefusal(/S2/),
			);
			assert.equal(h.supervisor.calls.length, 0);
		} finally {
			h.cleanup();
		}
	});
});

test("D1: a utility dispatch cannot carry a host (its contract is in-process)", async () => {
	const h = harness("xm-guard-utility-");
	await insideHcTerminal(async () => {
		try {
			await assert.rejects(
				() => h.orchestrator.launch({
					agent: agent({ name: "scout", utility: true }),
					task: "t",
					host: HOST,
					hostTarget: target(),
					utilityDispatch: true,
				}),
				expectRefusal(/utility dispatch/),
			);
			assert.equal(h.supervisor.calls.length, 0);
		} finally {
			h.cleanup();
		}
	});
});

test("D1: host + worktree:false reaches the terminal backend with the target", async () => {
	const h = harness("xm-guard-ok-");
	await insideHcTerminal(async () => {
		try {
			const handle = await h.orchestrator.launch({
				agent: agent(),
				task: "t",
				host: HOST,
				hostTarget: target({ cwd: "/srv/app" }),
			});
			const spawn = h.supervisor.calls.find((call) => call.method === "spawnChild");
			assert.ok(spawn, "the supervisor must receive a spawn");
			// The arbitrated backend is the terminal one, whatever `worktree` said.
			assert.equal(spawn.input?.agent.spawnMode, "terminal");
			assert.equal(spawn.input?.host, HOST);
			assert.equal(spawn.input?.hostTarget?.cwd, "/srv/app");
			// The record keeps the machine, so collect/resume can tell it apart.
			assert.equal(handle.child.host, HOST);
		} finally {
			h.cleanup();
		}
	});
});

test("D1: resolveHostTarget refuses a pathMap entry that is relative on either side", () => {
	// A relative prefix would resolve against two different homes; the settings
	// parser keeps it and the resolver is the one place that can name it.
	assert.throws(
		() => resolveHostTarget(HOST, { enabled: true, hosts: { [HOST]: { cwd: "/srv/app", pathMap: { "opt/x": "/srv/x" } } } }),
		/must be absolute on both sides/,
	);
	assert.throws(
		() => resolveHostTarget(HOST, { enabled: true, hosts: { [HOST]: { cwd: "/srv/app", pathMap: { "/opt/x": "srv/x" } } } }),
		/must be absolute on both sides/,
	);
});
