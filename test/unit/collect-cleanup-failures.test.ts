/**
 * A delivered turn outranks a cleanup failure (defect E).
 *
 * The 6.2.2 release run judged a SUCCESSFUL cross-machine centurion `failed`, twice
 * out of two. Two separate mechanisms produced that:
 *
 *   E1 — the collect's own acceptance path refused a remote tree by name
 *        (`assertLocalWorktree` on the whole record), so a remote child never got a
 *        verdict at all;
 *   E2 — anything that threw inside `finishCollect` escaped `collect`, and the watch
 *        turns a thrown collect into a `failed` notice, so plumbing (verification, a
 *        D13 guard, a rollback) became the child's verdict;
 *   E3 — a cleanup failure during a failed LAUNCH replaced the launch's real reason
 *        with the cleanup's message.
 *
 * These tests pin the three rules that fix it:
 *   1. a finished turn with an assistant message is DELIVERED — and says so along
 *      with the cleanup failure (`delivered with cleanup warning: …`);
 *   2. a rollback failure is a `secondary:` line, never the reason;
 *   3. a child whose tree belongs to another machine collects successfully.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { verificationSummary } from "../../src/extension/legion-tools.ts";
import { Orchestrator } from "../../src/runs/orchestrator.ts";
import type { RemoteReadbackResult, RemoteSessionRequest } from "../../src/runs/remote-artifact.ts";
import type { HostTarget } from "../../src/runs/remote.ts";
import type { LegionNode } from "../../src/legion/nodes.ts";
import { ErrorCodes, SubagentError, withSecondaryFailures, type AgentConfig } from "../../src/shared/types.ts";
import { FakeSupervisor } from "../helpers/fake-supervisor.ts";
import { assistantMsg, sessionHeader, userMsg } from "../helpers/fixtures.ts";

const HOST = "vps";

function agent(overrides: Partial<AgentConfig> = {}): AgentConfig {
	return {
		name: "worker",
		description: "cleanup-failure test role",
		systemPromptMode: "append",
		inheritProjectContext: false,
		inheritSkills: false,
		kind: "pi",
		systemPrompt: "You are a test worker.",
		source: "user",
		filePath: "/fake/worker.md",
		worktree: true,
		...overrides,
	};
}

function gitRepo(root: string): string {
	const repo = path.join(root, "repo");
	execFileSync("git", ["init", "-q", repo]);
	execFileSync("git", ["-C", repo, "-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-qm", "init"]);
	return repo;
}

/** A transcript whose last turn finished with an assistant message. */
function deliveredTranscript(text: string): string {
	return [
		sessionHeader({ cwd: "/srv/app" }),
		userMsg("ship it"),
		assistantMsg({ text, stopReason: "stop" }),
	].join("\n") + "\n";
}

/** Settle the child: the fake appends the assistant turn its session file needs. */
function deliver(supervisor: FakeSupervisor, name: string, text: string): void {
	supervisor.settle(name, { text });
}

function target(): HostTarget {
	return {
		host: HOST,
		cwd: "/srv/app",
		node: "node",
		piCli: "pi",
		pathMap: [],
		piLegionRoot: "/srv/pi-legion",
		piExtensions: [],
		mirrorRoot: "/srv/.pi-subagents-mirror",
		worktreeRoot: "/srv/.pi-worktrees",
	};
}

/** Run `body` inside an hc terminal, the only place a cross-machine launch is legal. */
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

test("withSecondaryFailures: the original reason stays first, the cleanup becomes `secondary:`", () => {
	const original = new SubagentError("worktree bootstrap failed (npm-install): EACCES", ErrorCodes.START_FAILED, { stage: "bootstrap" });
	const merged = withSecondaryFailures(original, ["worktree rollback for '/tmp/x' failed: busy"]);
	assert.ok(merged instanceof SubagentError);
	assert.match(merged.message, /^worktree bootstrap failed \(npm-install\): EACCES/, "the real cause is the message, not the cleanup");
	assert.match(merged.message, /\n  secondary: worktree rollback for '\/tmp\/x' failed: busy/);
	assert.equal(merged.code, ErrorCodes.START_FAILED, "the class survives a cleanup line");
	assert.deepEqual(merged.details, { stage: "bootstrap" });
});

test("withSecondaryFailures: nothing to add returns the SAME error object", () => {
	const original = new SubagentError("boom", ErrorCodes.START_FAILED);
	assert.equal(withSecondaryFailures(original, []), original);
	assert.equal(withSecondaryFailures(original, ["  ", ""]), original);
});

test("withSecondaryFailures: a plain Error keeps its stack and a non-Error gets a class", () => {
	const plain = new Error("spawn failed");
	const merged = withSecondaryFailures(plain, ["retire failed: gone"]);
	assert.ok(merged instanceof Error);
	assert.match(merged.message, /^spawn failed\n  secondary: retire failed: gone/);
	assert.equal(merged.stack, plain.stack, "the stack still points at the real failure");

	const unknown = withSecondaryFailures("no transport", ["cleanup failed"]);
	assert.ok(unknown instanceof SubagentError);
	assert.equal(unknown.code, ErrorCodes.START_FAILED);
	assert.match(unknown.message, /^no transport\n  secondary: cleanup failed/);
});

test("E3: a failed launch whose worktree rollback ALSO throws keeps the launch's reason", async (t) => {
	const root = mkdtempSync(path.join(tmpdir(), "cleanup-rollback-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	// The spawn fails AFTER the worktree exists: the exact shape whose rollback used to
	// replace the reason. (A launch-time failure, not a provisioning one, so nothing
	// about `worktreeBootstrap`'s mode mapping can make this test vacuous.)
	const supervisor = new FakeSupervisor({
		rejectSpawn: () => new SubagentError("no free slot on the backend", ErrorCodes.START_FAILED),
	});
	const orchestrator = new Orchestrator({
		supervisor,
		runDir: path.join(root, "run"),
		cwd: gitRepo(root),
		removeWorktree: () => {
			throw new SubagentError("worktree '/tmp/wt' belongs to host 'vps': refused", ErrorCodes.INVALID_PARAMS);
		},
	});
	await assert.rejects(
		// A CENTURION: only a delivery unit gets a worktree (a worker is demoted to
		// `worktree: false`), and the rollback under test only exists once one does.
		() => orchestrator.launch({ agent: agent({ name: "centurion", description: "delivery unit" }), task: "t", worktree: true }),
		(error: unknown) => {
			assert.ok(error instanceof Error);
			assert.match(error.message, /no free slot on the backend/, "the REAL cause leads");
			assert.match(error.message, /secondary: worktree rollback for '/, "and the cleanup failure is attached");
			assert.match(error.message, /belongs to host 'vps'/, "named verbatim");
			// The bootstrap reason must not have been REPLACED: it comes first, and the
			// D13 sentence appears only after the `secondary:` marker.
			assert.ok(
				error.message.indexOf("no free slot on the backend") < error.message.indexOf("secondary:"),
				`original reason must precede the cleanup line: ${error.message}`,
			);
			return true;
		},
	);
});

test("E2: a delivered turn survives a throwing verification step (success + cleanup warning)", async (t) => {
	const root = mkdtempSync(path.join(tmpdir(), "cleanup-collect-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const supervisor = new FakeSupervisor();
	const orchestrator = new Orchestrator({
		supervisor,
		runDir: path.join(root, "run"),
		cwd: gitRepo(root),
		// The plumbing that throws. `applyVerification` awaits the runner directly, so a
		// rejecting runner used to abort the whole collect — and the watch reports a
		// thrown collect as `failed`, which is the false-failed defect.
		verifyRunner: async () => {
			throw new Error("EACCES: cannot spawn the verifier");
		},
	});
	const verified = {
		...agent({ worktree: false }),
		acceptance: {
			level: "attested" as const,
			criteria: [{
				id: "task-verify",
				must: "the launcher's verify commands pass",
				evidence: ["verification-output"],
				severity: "required" as const,
				command: "npm test",
			}],
		},
	};
	const handle = await orchestrator.launch({ agent: verified, task: "t" });
	deliver(supervisor, handle.name, "shipped the fix");

	const collected = await orchestrator.collect(handle.name);
	assert.equal(collected.execution.status, "success", "a finished turn with an assistant message is not a failure");
	assert.match(String(collected.execution.reason), /delivered with cleanup warning: EACCES: cannot spawn the verifier/);
	assert.equal(collected.output, "shipped the fix", "and the child's text still travels");
});

test("E1: a child whose tree belongs to ANOTHER machine collects successfully (no D13 refusal)", async (t) => {
	const root = mkdtempSync(path.join(tmpdir(), "cleanup-remote-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	// E1's shape needs the RECORD to own a tree on that machine, which a real
	// cross-machine launch reports on the handle (the backend created it over there).
	const supervisor = new FakeSupervisor({
		handleExtras: { worktreePath: "/srv/.pi-worktrees/worker-0", worktreeHost: HOST },
	});
	const transcript = deliveredTranscript("delivered from the other machine");
	const readback: (request: RemoteSessionRequest) => Promise<RemoteReadbackResult> = async (request) => {
		mkdirSync(path.dirname(request.localPath), { recursive: true });
		writeFileSync(request.localPath, transcript);
		const lines = transcript.split("\n").filter((line) => line.trim().length > 0).length;
		return {
			ok: true,
			host: request.host,
			localPath: request.localPath,
			remotePath: "/srv/.pi-subagents-mirror/run/worker-0/session.jsonl",
			lines,
			returned: lines,
			truncated: false,
			byteCapped: false,
		};
	};
	const orchestrator = new Orchestrator({
		supervisor,
		runDir: path.join(root, "run"),
		cwd: gitRepo(root),
		remoteReadback: readback,
	});
	await insideHcTerminal(async () => {
		// Only a delivery unit may cross machines (xm-dispatch D4), so the record this
		// test grades is a centurion's.
		const centurion = agent({ name: "centurion", description: "cross-machine centurion", worktree: true });
		const handle = await orchestrator.launch({ agent: centurion, task: "t", host: HOST, hostTarget: target() });
		const spawn = supervisor.spawns.find((entry) => entry.input.name === handle.name);
		assert.ok(spawn, "the child really was launched on that machine");
		deliver(supervisor, handle.name, "delivered from the other machine");
		// E1's shape: the record OWNS a tree on that machine. The old acceptance path
		// refused the whole record (`assertLocalWorktree(child)`), so this collect threw
		// the D13 sentence instead of grading the turn.
		const collected = await orchestrator.collect(handle.name);
		assert.equal(collected.execution.status, "success");
		assert.doesNotMatch(String(collected.execution.reason ?? ""), /belongs to host/, "no D13 refusal in the verdict");
		assert.equal(collected.output, "delivered from the other machine", "the delivered text is the child's own");
		assert.equal(collected.remoteReadback?.host, HOST, "the transcript was really read back");
		assert.ok((collected.remoteReadback?.lines ?? 0) > 0);
	});
});

/**
 * `d1`'s second half: a REMOTE tree's verification line must render, not vanish.
 *
 * `verificationSummary` answers "is the recorded pass still true?" by touching this
 * machine's filesystem, so D13 used to refuse a node whose tree belongs to another
 * machine — and the collect head calls this for EVERY legion child, so a
 * cross-machine child lost its line (the same guard, one reader further out).
 * The recorded facts are still the truth about what ran; only the re-check cannot
 * be answered here, and the summary now says exactly that.
 */
test("d1: a verification summary for a REMOTE tree is returned, marked `staleUnknown`", () => {
	// A partial row on purpose: `verificationSummary` reads `taskSummary`, the tree pair
	// and nothing else, and spelling out every column would hide which fields matter.
	const node = {
		id: "root.centurion-0",
		parentId: "root",
		name: "centurion-0",
		role: "centurion",
		kind: "pi",
		depth: 1,
		runId: "r-1",
		status: "settled",
		phase: "done",
		sessionFile: "/tmp/x/session.jsonl",
		worktreePath: "/srv/.pi-worktrees/centurion-0",
		worktreeHost: HOST,
		host: HOST,
		createdAt: 1,
		updatedAt: 2,
		taskSummary: JSON.stringify({
			__piLegion: {
				version: 1,
				taskSummary: "delivered",
				verification: {
					passed: true,
					outputFile: "/srv/run/centurion-0.legion-verify.log",
					commandCount: 2,
					checkedAt: 1_700_000_000_000,
					cwd: "/srv/.pi-worktrees/centurion-0",
				},
			},
		}),
	} as unknown as LegionNode;
	const summary = verificationSummary(node);
	assert.ok(summary, "the recorded verification must still be reported");
	assert.equal(summary.commandCount, 2);
	assert.equal(summary.passed, true);
	assert.equal(summary.stale, false, "staleness is not claimed either way");
	assert.equal(summary.staleUnknown, true, "and it says the re-check was not answered here");
});
