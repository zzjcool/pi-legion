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
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { renderCollect } from "../../index.ts";
import { lastDeliveryPreflight, preflightDelivery, resetDeliveryPreflightState } from "../../src/runs/cross-machine-preflight.ts";
import { Orchestrator } from "../../src/runs/orchestrator.ts";
import type { RemoteReadbackResult, RemoteSessionRequest } from "../../src/runs/remote-artifact.ts";
import { resolveHostTarget, type HostTarget } from "../../src/runs/remote.ts";
import type { HcClient, HcMethod } from "../../src/hc/client.ts";
import { NO_ASSISTANT_ABORT_REASON } from "../../src/shared/session.ts";
import { ErrorCodes, SubagentError, type AgentConfig } from "../../src/shared/types.ts";
import { FakeSupervisor } from "../helpers/fake-supervisor.ts";
import { assistantMsg, sessionHeader, toolResult, userMsg } from "../helpers/fixtures.ts";

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

function harness(
	prefix: string,
	remoteReadback?: (request: RemoteSessionRequest) => Promise<RemoteReadbackResult>,
	/** Injected virtual clock (the collect grace window is asserted in ms, not slept). */
	deps: { now?: () => number; sleep?: (ms: number) => Promise<void> } = {},
) {
	const root = mkdtempSync(path.join(tmpdir(), prefix));
	const supervisor = new FakeSupervisor();
	return {
		root,
		supervisor,
		orchestrator: new Orchestrator({
			supervisor,
			runDir: path.join(root, "run"),
			cwd: gitRepo(root),
			...(remoteReadback ? { remoteReadback } : {}),
			...deps,
		}),
		cleanup: () => rmSync(root, { recursive: true, force: true }),
	};
}

function target(overrides: Partial<HostTarget> = {}): HostTarget {
	return { host: HOST, cwd: "/srv/app", node: "node", piCli: "pi", pathMap: [], piLegionRoot: "/srv/pi-legion", piExtensions: [], mirrorRoot: "/srv/.pi-subagents-mirror", worktreeRoot: "/srv/.pi-worktrees", ...overrides };
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

/**
 * xm-model-fallback, steps 1 and 2 of the resolution order.
 *
 * The user's requirement: "configure the model up front, and when nothing is
 * configured fall back to a model on the target machine". "Up front" is the
 * per-machine key `subagents.crossMachine.hosts.<host>.model`; the launch uses it
 * when it has no model of its own, and an explicit one always wins. Both facts
 * live in `Orchestrator.launch` (`input.model ?? input.hostTarget.model`) because
 * the target is the only object that carries what the operator wrote for THAT
 * machine.
 */
test("xm-model-fallback: a launch with no explicit model starts with the machine's pin, and argv carries it", async () => {
	const h = harness("xm-model-host-");
	await insideHcTerminal(async () => {
		try {
			const handle = await h.orchestrator.launch({
				agent: agent(),
				task: "t",
				host: HOST,
				hostTarget: target({ model: "codebuddy/glm-5" }),
			});
			const spawn = h.supervisor.spawns.find((entry) => entry.input.name === handle.name);
			assert.ok(spawn, "the supervisor must receive a spawn");
			assert.equal(spawn.input.model, "codebuddy/glm-5", "the per-machine pin resolves the launch's model");
			// and it is what the CHILD is started with, not a value only the ledger knows.
			const at = spawn.args.indexOf("--model");
			assert.ok(at >= 0, `the child's argv must carry --model: ${spawn.args.join(" ")}`);
			assert.equal(spawn.args[at + 1], "codebuddy/glm-5");
		} finally {
			h.cleanup();
		}
	});
});

test("xm-model-fallback: an explicit model WINS over the machine's pin", async () => {
	const h = harness("xm-model-explicit-");
	await insideHcTerminal(async () => {
		try {
			const handle = await h.orchestrator.launch({
				agent: agent(),
				task: "t",
				host: HOST,
				hostTarget: target({ model: "codebuddy/glm-5" }),
				model: "workbuddy/deepseek-v4.1-flash",
			});
			const spawn = h.supervisor.spawns.find((entry) => entry.input.name === handle.name);
			assert.ok(spawn, "the supervisor must receive a spawn");
			assert.equal(spawn.input.model, "workbuddy/deepseek-v4.1-flash");
			const at = spawn.args.indexOf("--model");
			assert.equal(spawn.args[at + 1], "workbuddy/deepseek-v4.1-flash");
			// The pin is not lost when the machine is retried without its own model:
			// it is a property of the target, so the next launch on it still sees it.
			assert.equal(spawn.input.hostTarget?.model, "codebuddy/glm-5");
		} finally {
			h.cleanup();
		}
	});
});

/**
 * S2: `host` + `worktree: true` is now the SUPPORTED remote shape (contract D11).
 *
 * The arbitration has to say two things at once — "this child is worktree
 * isolated" AND "the tree is not mine to create" — because only the terminal
 * backend holds both the `hc` client and the resolved target. A local
 * `createChildWorktree` here would build a checkout on THIS machine for a child
 * that runs on another one, which is the "nobody delivers from it" shape S1
 * refused.
 */
test("D1/S2: host + worktree:true reaches the terminal backend with createWorktree", async () => {
	const h = harness("xm-guard-worktree-");
	await insideHcTerminal(async () => {
		try {
			const handle = await h.orchestrator.launch({
				agent: agent({ worktree: true }),
				task: "t",
				host: HOST,
				hostTarget: target(),
				worktree: true,
			});
			const spawn = h.supervisor.calls.find((call) => call.method === "spawnChild");
			assert.ok(spawn, "the supervisor must receive a spawn");
			assert.equal(spawn.input?.agent.spawnMode, "terminal");
			assert.equal(spawn.input?.worktree, true, "the arbitrated worktree decision travels");
			assert.equal(spawn.input?.createWorktree, true, "the BACKEND creates a remote tree");
			assert.equal(spawn.input?.host, HOST);
			assert.equal(handle.child.host, HOST);
			// No local tree was created: the run dir holds no `worktrees/` entry.
			assert.equal(existsSync(path.join(h.root, "run", "worktrees")), false);
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

// NB: `utility: true` is the SCOUT CARD's field (the role must stay a leaf); the
// `cannot carry a utility dispatch` refusal is a different flag (`utilityDispatch`,
// set by `vexillatio`) with its own contract test, and it fires before this rule.
test("xm-dispatch D4: a scout cannot cross machines by default — only a delivery-unit role may", async () => {
	// The user's design intent, verbatim: "why can scout and worker be dispatched
	// across machines? only centurion should cross." A scout is a member of the team
	// that remote centurion creates ON that machine.
	const h = harness("xm-roles-scout-");
	await insideHcTerminal(async () => {
		try {
			await assert.rejects(
				() => h.orchestrator.launch({ agent: agent({ name: "scout", utility: true }), task: "t", host: HOST, hostTarget: target() }),
				(rejected: unknown): boolean => {
					assert.ok(rejected instanceof SubagentError, `must refuse with a SubagentError, got ${String(rejected)}`);
					assert.equal((rejected as SubagentError).code, ErrorCodes.INVALID_PARAMS);
					const message = (rejected as SubagentError).message;
					// The reason AND the way out are both in the sentence.
					assert.match(message, /cross-machine launch is for a DELIVERY UNIT, and only 'centurion' may cross/);
					assert.match(message, /Dispatch a centurion to that machine and let IT create its scout team there/);
					assert.match(message, /"allowRoles": \["centurion", "scout"\]/);
					return true;
				},
			);
			assert.equal(h.supervisor.calls.length, 0, "the refusal must precede any spawn");
		} finally {
			h.cleanup();
		}
	});
});

test("xm-dispatch D4: a worker is refused too, unless the target's allowRoles says otherwise", async () => {
	const h = harness("xm-roles-worker-");
	await insideHcTerminal(async () => {
		try {
			await assert.rejects(
				() => h.orchestrator.launch({ agent: agent({ name: "worker" }), task: "t", host: HOST, hostTarget: target() }),
				/cannot be dispatched to agent 'worker'/,
			);
			// Explicit allowlist = the operator's decision, and the launch proceeds.
			const handle = await h.orchestrator.launch({
				agent: agent({ name: "worker" }),
				task: "t",
				host: HOST,
				hostTarget: target({ allowRoles: ["centurion", "worker"] }),
			});
			assert.equal(handle.child.host, HOST);
			assert.ok(h.supervisor.calls.some((call) => call.method === "spawnChild"));
		} finally {
			h.cleanup();
		}
	});
});

test("xm-dispatch D4: the role rule is a DISPATCH rule — a name that ALREADY exists over there is not re-gated", async () => {
	// What this proves, precisely: the guard keys on "is this a new dispatch", not on
	// "does the role appear in allowRoles". An operator who tightens `allowRoles` after
	// a child exists must still be able to continue/reconnect that child — a rule that
	// locks them out of work already running on the other machine would be worse than
	// the bug it fixes. It does NOT prove a resume: `launch` on an existing name
	// re-spawns (the second `spawnChild` below is real), and the resume gate for an
	// existing remote child lives in `resolveHostTargetAsync({admission:"never"})`
	// (`src/runs/remote.ts`), which this rule never touches.
	const h = harness("xm-roles-resume-");
	await insideHcTerminal(async () => {
		try {
			const first = await h.orchestrator.launch({ agent: agent({ name: "worker" }), task: "t", host: HOST, hostTarget: target({ allowRoles: ["centurion", "worker"] }) });
			await h.orchestrator.retire(first.name, { graceful: false });
			const spawnsBefore = h.supervisor.calls.filter((call) => call.method === "spawnChild").length;
			const again = await h.orchestrator.launch({
				agent: agent({ name: "worker" }),
				task: "t",
				name: first.name,
				host: HOST,
				hostTarget: target(),
			});
			assert.equal(again.name, first.name);
			assert.equal(
				h.supervisor.calls.filter((call) => call.method === "spawnChild").length,
				spawnsBefore + 1,
				"a re-launch on an existing name DOES spawn: the exemption is about not re-gating, not about resuming",
			);
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

test("S3/B1: `host` + `verify` runs the command on THAT machine — never in this checkout", async () => {
	// Pre-S3 this launch was refused, because `applyVerification` would have run the
	// command with `cwd: child.worktreePath ?? this.cwd` — this machine's checkout —
	// and recorded the answer on the remote child's acceptance. The refusal is gone
	// because the command now travels: the local runner must never be called for a
	// child that ran elsewhere.
	const h = harness("xm-verify-remote-");
	const local: string[] = [];
	const remote: Array<{ host: string; command: string; cwd?: string; timeoutMs: number }> = [];
	const orchestrator = new Orchestrator({
		supervisor: h.supervisor,
		runDir: path.join(h.root, "run"),
		cwd: gitRepo(h.root),
		verifyRunner: async (command) => {
			local.push(command);
			return { code: 0, stdout: "", stderr: "" };
		},
		remoteVerify: async (request) => {
			remote.push(request);
			return { code: 0, stdout: "", stderr: "", host: request.host };
		},
		// S4 wired the read-back: a remote collect fetches the transcript before it can
		// derive anything. This test is about the verify step, so the read-back is a
		// no-op that reports an empty (complete) file.
		remoteReadback: async (request) => ({
			ok: true,
			host: request.host,
			localPath: request.localPath,
			remotePath: `/home/there/${request.name}/session.jsonl`,
			lines: 0,
			returned: 0,
			truncated: false,
			byteCapped: false,
		}),
	});
	await insideHcTerminal(async () => {
		try {
			const withVerify = {
				...agent(),
				acceptance: {
					level: "attested" as const,
					criteria: [{
						id: "task-verify",
						must: "Launcher-supplied verify commands pass",
						evidence: ["verification-output"],
						severity: "required" as const,
						command: "npm test",
					}],
				},
			};
			const handle = await orchestrator.launch({ agent: withVerify, task: "t", host: HOST, hostTarget: target() });
			h.supervisor.settle(handle.name, { text: '{"ok":true,"reason":"done"}' });
			const collected = await orchestrator.collect(handle.name);
			assert.deepEqual(local, [], "the local runner must never verify another machine's child");
			assert.equal(remote.length, 1, "exactly one remote verify");
			assert.equal(remote[0]!.host, HOST);
			assert.equal(remote[0]!.command, "npm test");
			// The budget is the collect deadline's remainder (the pre-S3 semantics); the
			// remote runner clamps it to hc's ceiling and announces that.
			assert.ok((remote[0]!.timeoutMs ?? 0) > 0 && (remote[0]!.timeoutMs ?? 0) <= 900_000, `budget ${remote[0]!.timeoutMs}`);
			// demo-findings F2 / D2: this harness settles the child WITHOUT a transcript,
			// so `deriveOutcome` answers `unknown` ("no messages in session") — a turn that
			// is not `success` is not a completed turn. The remote verify still runs and its
			// answer is still recorded, but the collect must not promote it to `verified`:
			// nothing about THIS turn was measured. The host + command assertions above are
			// what prove the answer came from that machine.
			assert.equal(collected.execution.status, "unknown", "the harness turn is not a completed turn (D2 premise)");
			assert.equal(collected.acceptance.level, "attested", "an interrupted/unmeasured turn is never `verified` (D2)");
			assert.match(String(collected.acceptance.reason), /still ran and passed/, "the parent's verify DID run — D2 says so");
		} finally {
			h.cleanup();
		}
	});
});

test("B1: a child-only acceptance criterion (no command) still launches on a host", async () => {
	// The refusal is about COMMANDS this machine would run. A criterion the child
	// itself attests to ("the suite is green") is the remote child's own claim and
	// travels with its verdict — it must not be refused.
	const h = harness("xm-guard-verify-ok-");
	await insideHcTerminal(async () => {
		try {
			const attested = {
				...agent(),
				acceptance: {
					level: "attested" as const,
					criteria: [{
						id: "self-report",
						must: "the child reports the suite as green",
						evidence: ["verdict"],
						severity: "required" as const,
					}],
				},
			};
			const handle = await h.orchestrator.launch({ agent: attested, task: "t", host: HOST, hostTarget: target() });
			assert.equal(handle.child.host, HOST);
		} finally {
			h.cleanup();
		}
	});
});

/* ------------------------------------------------------------------------- *
 * S4/D15 — the read-back the verdict is derived from (real 6.2.0 demo)
 *
 * The demo: a remote `centurion` on hw-nj wrote 11 lines and answered, and the
 * parent's `wait` reported `aborted (no assistant message for the last prompt)` +
 * `read-back: 5 of 5 lines (complete)`. Both described a mirror that was read
 * BEFORE the turn ended: five lines whose last one is the user prompt — exactly
 * the shape `deriveOutcome` calls "no assistant message".
 * ------------------------------------------------------------------------- */

/** The mid-turn prefix: 5 lines, the last one the user prompt (no reply yet). */
const MID_TURN = [
	sessionHeader(),
	userMsg("dispatch the review"),
	assistantMsg({ stopReason: "toolUse", tools: ["read"] }),
	toolResult({ toolName: "read" }),
	userMsg("now write the report"),
];

/** The transcript that turn really produced: 11 lines, ending on the report. */
const FINISHED = [
	...MID_TURN,
	assistantMsg({ stopReason: "toolUse", tools: ["write"] }),
	toolResult({ toolName: "write" }),
	assistantMsg({ stopReason: "toolUse", tools: ["bash"] }),
	toolResult({ toolName: "bash" }),
	assistantMsg({ text: "half-way summary" }),
	assistantMsg({ text: '{"ok":true,"reason":"report written"}' }),
];

/** Where a cross-machine transcript lives on the target (xm-dispatch D3.2). */
function remoteMirrorSample(name: string): string {
	return path.posix.join("/srv/.pi-subagents-mirror", "no-run", name, "session.jsonl");
}

/** Write `lines` to the mirror the request names, the way the real seam does. */
function writeMirror(localPath: string, lines: string[]): void {
	mkdirSync(path.dirname(localPath), { recursive: true });
	writeFileSync(localPath, `${lines.join("\n")}\n`);
}

test("S4/D15 (demo): a mid-turn mirror is re-read before the verdict, so 11 lines are not judged as 5", async () => {
	// What the demo did: `collect()` entered while the remote centurion was still
	// working, read 5 lines off that machine, and — because the mirror was never
	// read again — derived the verdict from that snapshot while the turn went on to
	// write 11 lines answering the task.
	const calls = { count: 0 };
	const h = harness("xm-midturn-", async (request) => {
		calls.count += 1;
		// First read: mid-turn. Every later read: the finished transcript.
		const lines = calls.count === 1 ? MID_TURN : FINISHED;
		writeMirror(request.localPath, lines);
		return {
			ok: true,
			host: request.host,
			localPath: request.localPath,
			remotePath: remoteMirrorSample(request.name),
			lines: lines.length,
			returned: lines.length,
			truncated: false,
			byteCapped: false,
		};
	});
	await insideHcTerminal(async () => {
		try {
			const handle = await h.orchestrator.launch({ agent: agent(), task: "t", host: HOST, hostTarget: target() });
			h.supervisor.settle(handle.name, { text: '{"ok":true,"reason":"report written"}' });
			const collected = await h.orchestrator.collect(handle.name);
			// The verdict first: this is the demo's lie (`aborted (no assistant message
			// for the last prompt)` for a child that answered).
			assert.equal(collected.execution.status, "success", JSON.stringify(collected.execution));
			assert.notEqual(collected.execution.reason, NO_ASSISTANT_ABORT_REASON);
			assert.equal(calls.count, 2, "exactly one refresh — the remote is NOT polled while the turn is in flight");
			// The facts reported to the render are the LAST read, so "5 of 5 (complete)"
			// can no longer describe a transcript that has 11 lines.
			assert.equal(collected.remoteReadback?.lines, FINISHED.length);
			assert.equal(collected.remoteReadback?.returned, FINISHED.length);
			assert.match(
				renderCollect(handle.name, collected),
				/read-back from host 'vps': 11 of 11 lines \(complete\)$/m,
			);
			assert.match(collected.output, /report written/);
		} finally {
			h.cleanup();
		}
	});
});

test("S4/D15: a COMPLETE remote transcript with no assistant is still `aborted` (frozen reason kept)", async () => {
	// The honesty guard must not swallow the child's own fate: when the whole file
	// was read and it really ends without a reply, the frozen reason stands — the
	// same verdict `test/unit/session.test.ts` pins for a local transcript.
	const h = harness("xm-noassistant-", async (request) => {
		writeMirror(request.localPath, MID_TURN);
		return {
			ok: true,
			host: request.host,
			localPath: request.localPath,
			remotePath: remoteMirrorSample(request.name),
			lines: MID_TURN.length,
			returned: MID_TURN.length,
			truncated: false,
			byteCapped: false,
		};
	});
	await insideHcTerminal(async () => {
		try {
			const handle = await h.orchestrator.launch({ agent: agent(), task: "t", host: HOST, hostTarget: target() });
			h.supervisor.settle(handle.name, { text: "settled" });
			const collected = await h.orchestrator.collect(handle.name);
			assert.equal(collected.execution.status, "aborted");
			assert.equal(collected.execution.reason, NO_ASSISTANT_ABORT_REASON);
			assert.equal(collected.remoteReadback?.truncated, false);
		} finally {
			h.cleanup();
		}
	});
});

test("D15: a local retire keeps today's verdict — a transcript with no reply is still `aborted`", async () => {
	// The honesty rule is about a MIRROR; a local transcript is authoritative, so
	// the frozen sentence stays exactly as `session.test.ts` pins it.
	const h = harness("xm-retire-local-");
	try {
		const handle = await h.orchestrator.launch({ agent: agent(), task: "t", worktree: false });
		writeFileSync(handle.sessionFile, `${MID_TURN.join("\n")}\n`);
		const retired = await h.orchestrator.retire(handle.name);
		assert.equal(retired.execution?.status, "aborted");
		assert.equal(retired.execution?.reason, NO_ASSISTANT_ABORT_REASON);
	} finally {
		h.cleanup();
	}
});

// ── D5: the CALLER's checkout, not this process's record directory ──────────
//
// The released bug: a launch with `host` + a RELATIVE `cwd` refused with "this
// session's directory (<session dir>) is not a checkout" even though the relative
// `cwd` named a real clone. The preflight was asking git about `Orchestrator.cwd`
// (the record directory) because `LaunchInput` had no way to carry the caller's.
//
// The seam below is the real one (`preflightRemoteDelivery` → the frozen D5 order)
// over a fake `hc` client, so these tests pin the ARGUMENT the preflight asks git
// about — not merely that a call happened.

/** A minimal `hc` client: the target answers every question code 0. */
class FakeDeliveryClient implements HcClient {
	readonly commands: string[] = [];
	private readonly origin: string;

	constructor(origin: string) {
		this.origin = origin;
	}

	async start(): Promise<void> {}
	close(): void {}

	async request<T = unknown>(method: HcMethod, params: Record<string, unknown> = {}): Promise<T> {
		if (method !== "machine.exec") throw new Error(`fake delivery client: unexpected ${method}`);
		const command = Array.isArray(params.argv) ? (params.argv as string[]).join(" ") : String(params.line ?? "");
		this.commands.push(command);
		// Only `origin` has an answer that matters; `test -d`, `git --version`,
		// `rev-parse --git-dir` and `ls-remote` all succeed on that machine.
		const answer = command.includes("remote get-url origin")
			? { code: 0, stdout: Buffer.from(this.origin).toString("base64"), stderr: "", timed_out: false }
			: { code: 0, stdout: "", stderr: "", timed_out: false };
		return answer as T;
	}
}

/** Records the D7 seam AND answers it with the real preflight. */
class DeliveryPreflightSupervisor extends FakeSupervisor {
	readonly preflights: Array<{ host: string; target: HostTarget; localRepo: string }> = [];
	private readonly deliveryClient: FakeDeliveryClient;

	constructor(deliveryClient: FakeDeliveryClient) {
		super();
		this.deliveryClient = deliveryClient;
	}

	async preflightRemoteDelivery(input: { host: string; target: HostTarget; localRepo: string }) {
		this.preflights.push(input);
		return preflightDelivery({ client: this.deliveryClient, target: input.target, localRepo: input.localRepo });
	}
}

/**
 * A session directory that is NOT a checkout, plus the clone a relative `cwd`
 * points at — the exact shape of the report (`/Users/…/agents` next to a repo).
 */
function deliveryHarness(prefix: string) {
	const root = mkdtempSync(path.join(tmpdir(), prefix));
	const sessionDir = path.join(root, "agents");
	mkdirSync(sessionDir, { recursive: true });
	const origin = "git@example.com:acme/pi-legion.git";
	const repo = path.join(root, "my-repo");
	execFileSync("git", ["init", "-q", repo]);
	execFileSync("git", ["-C", repo, "remote", "add", "origin", origin]);
	const client = new FakeDeliveryClient(origin);
	const supervisor = new DeliveryPreflightSupervisor(client);
	const orchestrator = new Orchestrator({ supervisor, runDir: path.join(root, "run"), cwd: sessionDir });
	return {
		root,
		sessionDir,
		repo,
		client,
		supervisor,
		orchestrator,
		cleanup: () => rmSync(root, { recursive: true, force: true }),
	};
}

test("D5: `localRepo` is the checkout the delivery asks git about, not this record dir", async () => {
	resetDeliveryPreflightState();
	const h = deliveryHarness("xm-local-repo-");
	await insideHcTerminal(async () => {
		try {
			const handle = await h.orchestrator.launch({
				agent: agent({ worktree: true }),
				task: "t",
				host: HOST,
				hostTarget: target(),
				worktree: true,
				// What index.ts computes for `cwd: "../my-repo"` next to `host`.
				localRepo: path.resolve(h.sessionDir, "../my-repo"),
			});
			assert.equal(h.supervisor.preflights.length, 1, "the D7 preflight must run once");
			const asked = h.supervisor.preflights[0]!;
			assert.equal(asked.localRepo, h.repo, "the preflight asks about the CALLER's checkout");
			assert.notEqual(asked.localRepo, h.sessionDir, "never the record directory");
			// The preflight PASSED (this clone has an origin, the target answers), so
			// the target really was reached instead of being refused for a local fact.
			const report = lastDeliveryPreflight();
			assert.equal(report?.ok, true, `the delivery must pass, got ${JSON.stringify(report?.failure)}`);
			assert.notEqual(report?.failure?.category, "local-origin");
			assert.ok(h.client.commands.length > 0, "the target was probed");
			// The tree is created FROM that checkout too (the backend reads the same
			// value as its spawn cwd).
			const spawn = h.supervisor.calls.find((call) => call.method === "spawnChild");
			assert.equal(spawn?.input?.cwd, h.repo, "createRemoteChildWorktree gets the caller's checkout");
			assert.equal(handle.child.host, HOST);
		} finally {
			h.cleanup();
		}
	});
});

test("D5: a relative `cwd` that is NOT a checkout is refused, naming the RESOLVED directory", async () => {
	resetDeliveryPreflightState();
	const h = deliveryHarness("xm-local-repo-missing-");
	const resolved = path.resolve(h.sessionDir, "../no-such-repo");
	await insideHcTerminal(async () => {
		try {
			const error = await h.orchestrator
				.launch({
					agent: agent({ worktree: true }),
					task: "t",
					host: HOST,
					hostTarget: target(),
					worktree: true,
					localRepo: resolved,
				})
				.then(() => undefined, (thrown: unknown) => thrown);
			assert.ok(error instanceof SubagentError, `expected a refusal, got ${String(error)}`);
			const message = (error as SubagentError).message;
			assert.match(message, /cross-machine delivery needs a git checkout on this machine too/);
			assert.ok(message.includes(resolved), `the message must name ${resolved}: ${message}`);
			assert.equal(
				message.includes(`(${h.sessionDir})`),
				false,
				"the SESSION directory is not what the caller pointed at",
			);
			assert.equal(h.supervisor.calls.filter((call) => call.method === "spawnChild").length, 0);
		} finally {
			h.cleanup();
		}
	});
});

test("D5: no `localRepo` keeps the old behaviour — resume/revive still read this record dir", async () => {
	// Resume and revive have no caller directory to carry. Their argument must stay
	// `this.cwd`, or a remote resume would start asking git about a path nobody named.
	resetDeliveryPreflightState();
	const h = deliveryHarness("xm-local-repo-absent-");
	await insideHcTerminal(async () => {
		try {
			const error = await h.orchestrator
				.launch({ agent: agent({ worktree: true }), task: "t", host: HOST, hostTarget: target(), worktree: true })
				.then(() => undefined, (thrown: unknown) => thrown);
			assert.ok(error instanceof SubagentError, `expected a refusal, got ${String(error)}`);
			assert.equal(h.supervisor.preflights.length, 1);
			assert.equal(h.supervisor.preflights[0]!.localRepo, h.sessionDir, "absent = the record directory, unchanged");
		} finally {
			h.cleanup();
		}
	});
});

