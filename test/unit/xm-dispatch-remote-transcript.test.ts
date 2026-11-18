/**
 * xm-dispatch D3 — the cross-machine transcript must be read AFTER the child settles.
 *
 * The 6.2.0 real run (`docs/reports/xm-dispatch-fixes.md`): a worker finished on
 * `hw-nj` — 11 lines of transcript, an assistant report, a file it created on that
 * machine — and the parent answered
 *
 *     execution: aborted (no assistant message for the last prompt)
 *     read-back from host 'hw-nj': 5 of 5 lines (complete)
 *
 * Three separate facts, each pinned by one test below:
 *
 * 1. the read-back happened ONCE, at launch+ε, and the verdict was derived from
 *    that frozen snapshot (`D3.1`) — so an assistant message that arrived later
 *    could never be seen;
 * 2. the count said "5 of 5 (complete)" because it described the SNAPSHOT, not
 *    the transcript (`D3.3`) — a settled read must agree with the real line count;
 * 3. a failed read-back must not be reported as "the child never spoke" — the two
 *    are different facts and only one of them justifies retiring a live child.
 *
 * These use the real `Orchestrator` with the `FakeSupervisor` and a read-back seam
 * whose answer CHANGES between calls: that is the only way to prove a refresh
 * happened at all.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { Orchestrator } from "../../src/runs/orchestrator.ts";
import { COLLECT_DEADLINE_REASON, transcriptNotRetrievedReason } from "../../src/runs/orchestrator.ts";
import { remoteMirrorPathFor, type RemoteReadbackResult, type RemoteSessionRequest } from "../../src/runs/remote-artifact.ts";
import { resolveHostTarget, type HostTarget } from "../../src/runs/remote.ts";
import { NO_ASSISTANT_ABORT_REASON } from "../../src/shared/session.ts";
import { type AgentConfig } from "../../src/shared/types.ts";
import { FakeSupervisor } from "../helpers/fake-supervisor.ts";
import { renderCollect } from "../../index.ts";

const HOST = "hw-nj";

function agent(overrides: Partial<AgentConfig> = {}): AgentConfig {
	return {
		name: "worker",
		description: "xm-dispatch remote transcript role",
		systemPromptMode: "append",
		inheritProjectContext: false,
		inheritSkills: false,
		kind: "pi",
		systemPrompt: "You are a test worker.",
		source: "user",
		filePath: "/fake/worker.md",
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
		// This file is about the TRANSCRIPT, not about who may cross (D4 has its own
		// tests): allow the worker role so a role refusal never masks these assertions.
		allowRoles: ["centurion", "worker"],
	};
}

/** The two hc env markers, so a `host` launch is admitted. */
async function insideHcTerminal(body: () => Promise<void>): Promise<void> {
	const socket = process.env.HC_TERMINAL_SOCKET;
	const id = process.env.HC_TERMINAL_ID;
	process.env.HC_TERMINAL_SOCKET = "/tmp/hc-xm-dispatch/default.sock";
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

const message = (value: Record<string, unknown>): string => JSON.stringify({ type: "message", message: value });

/**
 * What the child's transcript looks like at launch+ε: the header lines a `pi`
 * writes before it has said anything, plus the prompt. FIVE lines — the exact
 * number the real run reported as "5 of 5".
 */
function earlyTranscript(prompt: string): string {
	return `${[
		JSON.stringify({ type: "session", id: "sess-xm-1", cwd: "/srv/app" }),
		JSON.stringify({ type: "model_change", model: "workbuddy/deepseek-v4.1-flash" }),
		JSON.stringify({ type: "thinking_level_change", thinking: "max" }),
		message({ role: "system", content: "You are a test worker." }),
		message({ role: "user", content: prompt }),
	].join("\n")}\n`;
}

/** The same transcript once the child finished: ELEVEN lines, assistant last. */
function settledTranscript(prompt: string): string {
	const assistants = [
		"Now write the report.",
		"Read the config.",
		"Ran the suite: green.",
		"Committed on the branch.",
		"Pushed and reported.",
		"Done. Repo clean (no output from git status --porcelain).",
	];
	return earlyTranscript(prompt) + `${assistants.map((text) => message({ role: "assistant", content: [{ type: "text", text }], stopReason: "stop" })).join("\n")}\n`;
}

interface Harness {
	root: string;
	runDir: string;
	supervisor: FakeSupervisor;
	orchestrator: Orchestrator;
	cleanup: () => void;
}

/**
 * A run whose read-back seam is a SCRIPT: `answers` is consumed one call per
 * read-back, so a test states what the machine looked like at launch and again
 * after the child settled.
 */
function harness(prefix: string, opts: {
	answers: (request: RemoteSessionRequest, call: number) => RemoteReadbackResult | Promise<RemoteReadbackResult>;
	supervisor?: FakeSupervisor;
}): Harness {
	const root = mkdtempSync(path.join(tmpdir(), prefix));
	const runDir = path.join(root, "run");
	mkdirSync(runDir, { recursive: true });
	const supervisor = opts.supervisor ?? new FakeSupervisor();
	let calls = 0;
	const orchestrator = new Orchestrator({
		supervisor,
		runDir,
		cwd: gitRepo(root),
		// The collect's growth window is real time; these tests are about ORDER, so
		// the clock is virtual and a poll resolves immediately.
		now: () => Date.now(),
		sleep: async () => {},
		remoteReadback: async (request) => {
			calls += 1;
			return opts.answers(request, calls);
		},
	});
	return {
		root,
		runDir,
		supervisor,
		orchestrator,
		cleanup: () => rmSync(root, { recursive: true, force: true }),
	};
}

/** Write the mirror exactly as the seam does, so the collector can parse it. */
function writeMirror(request: RemoteSessionRequest, text: string): void {
	mkdirSync(path.dirname(request.localPath), { recursive: true });
	writeFileSync(request.localPath, text);
}

function okReadback(request: RemoteSessionRequest, text: string, lines: number): RemoteReadbackResult {
	return {
		ok: true,
		host: request.host,
		localPath: request.localPath,
		remotePath: "/srv/.pi-subagents-mirror/no-run/worker-0/session.jsonl",
		lines,
		returned: lines,
		truncated: false,
		byteCapped: false,
	};
}

// ── D3.1 / D3.3: the verdict must read the SETTLED transcript ───────────────

test("D3.1: an assistant message written before the wait settles is never `aborted` — the mirror is re-read after the wait", async () => {
	const prompt = "Implement the slice.";
	const h = harness("xm-transcript-refresh-", {
		answers: (request, call) => {
			// Call 1 = the launch-time snapshot (5 lines, prompt only: exactly the real
			// run). Call 2+ = the transcript as it really ends (11 lines, assistant last).
			const text = call === 1 ? earlyTranscript(prompt) : settledTranscript(prompt);
			writeMirror(request, text);
			const lines = text.split("\n").filter((line) => line.length > 0).length;
			return okReadback(request, text, lines);
		},
	});
	try {
		await insideHcTerminal(async () => {
			const handle = await h.orchestrator.launch({ agent: agent(), task: prompt, host: HOST, hostTarget: target() });
			// The child is over BEFORE the collect starts: the only thing that can make
			// the verdict wrong is reading the launch-time snapshot.
			h.supervisor.settle(handle.name, { text: '{"ok":true,"reason":"done"}' });
			const collected = await h.orchestrator.collect(handle.name);

			// (a) an assistant message exists ⇒ never this verdict.
			assert.notEqual(
				collected.execution.reason,
				NO_ASSISTANT_ABORT_REASON,
				`a settled child with an assistant message must not be called silent:\n${renderCollect(handle.name, collected)}`,
			);
			assert.equal(collected.execution.status, "success");
			assert.match(collected.output, /Done\. Repo clean/);
			// (b) the read-back counts the REAL transcript, not the snapshot.
			assert.equal(collected.remoteReadback?.lines, 11);
			assert.equal(collected.remoteReadback?.returned, 11);
			assert.equal(collected.remoteReadback?.truncated, false);
			const text = renderCollect(handle.name, collected);
			assert.match(text, new RegExp(`read-back from host '${HOST}': 11 of 11 lines \\(complete\\)`));
		});
	} finally {
		h.cleanup();
	}
});

test("D3.3: a read-back that never arrived is `unknown` ('transcript not retrieved'), never 'the child never spoke'", async () => {
	const prompt = "Implement the slice.";
	const h = harness("xm-transcript-unavailable-", {
		answers: (request, call) => {
			if (call === 1) {
				// A stale 5-line snapshot from the launch, then the machine stops answering.
				writeMirror(request, earlyTranscript(prompt));
				return okReadback(request, earlyTranscript(prompt), 5);
			}
			return {
				ok: false,
				host: request.host,
				reason: "connection error: the core went away",
				remotePath: "/srv/.pi-subagents-mirror/no-run/worker-0/session.jsonl",
				fate: "unreachable",
				evidence: ["the hc core on this machine did not start"],
				nextStep: "check that `hc` is on PATH (or HC_BIN)",
			};
		},
	});
	try {
		await insideHcTerminal(async () => {
			const handle = await h.orchestrator.launch({ agent: agent(), task: prompt, host: HOST, hostTarget: target() });
			h.supervisor.settle(handle.name, { text: '{"ok":true,"reason":"done"}' });
			const collected = await h.orchestrator.collect(handle.name);

			// The transcript is unreadable, so the work cannot be graded — but the child
			// is not accused of silence either.
			assert.equal(collected.execution.status, "unknown");
			assert.equal(
				collected.execution.reason,
				transcriptNotRetrievedReason(HOST, "connection error: the core went away"),
			);
			const rendered = renderCollect(handle.name, collected);
			assert.doesNotMatch(rendered, /aborted/);
			assert.doesNotMatch(rendered, new RegExp(NO_ASSISTANT_ABORT_REASON));
			// The failure names the file and the command that fetches it (D3.3).
			assert.match(rendered, /remote: \/srv\/\.pi-subagents-mirror\/no-run\/worker-0\/session\.jsonl/);
			assert.match(rendered, /hc exec --on hw-nj -- cat \/srv\/\.pi-subagents-mirror/);
		});
	} finally {
		h.cleanup();
	}
});

// ── D3.3: timeout is not abort ─────────────────────────────────────────────

test("D3.3: a wait that runs out on a LIVE cross-machine child is `running`, never `aborted`", async () => {
	const prompt = "Implement the slice.";
	const h = harness("xm-transcript-timeout-", {
		answers: (request) => {
			writeMirror(request, earlyTranscript(prompt));
			return okReadback(request, earlyTranscript(prompt), 5);
		},
		// Every unsettled wait answers "timeout" immediately: a live child whose
		// budget ran out, which is the one shape that must never read as an abort.
		supervisor: new FakeSupervisor({ immediateTimeout: true }),
	});
	try {
		await insideHcTerminal(async () => {
			const handle = await h.orchestrator.launch({ agent: agent(), task: prompt, host: HOST, hostTarget: target() });
			const collected = await h.orchestrator.collect(handle.name, { timeoutMs: 1 });
			assert.equal(collected.execution.status, "running");
			assert.equal(collected.execution.reason, COLLECT_DEADLINE_REASON);
			const rendered = renderCollect(handle.name, collected);
			assert.doesNotMatch(rendered, /aborted/);
			assert.match(rendered, /^execution: running \(collect deadline/m);
		});
	} finally {
		h.cleanup();
	}
});

// ── D3.2: the mirror is the reader's source in a LATER process ─────────────

test("D3.2: a reader with no read-back in memory parses the on-disk mirror, not the empty local placeholder", async () => {
	const prompt = "Implement the slice.";
	const h = harness("xm-transcript-mirror-path-", {
		answers: (request) => okReadback(request, earlyTranscript(prompt), 5),
	});
	try {
		await insideHcTerminal(async () => {
			const handle = await h.orchestrator.launch({ agent: agent(), task: prompt, host: HOST, hostTarget: target() });
			// The launch pre-created an EMPTY local placeholder (the remote child writes on
			// its own machine). A mirror a PREVIOUS collect left behind is the only local
			// text, and it is what a reader with no in-memory read-back must find — that is
			// the whole shape of a fresh process retiring a cross-machine child.
			const mirror = remoteMirrorPathFor(h.runDir, handle.name);
			const full = settledTranscript(prompt);
			writeMirror({ host: HOST, name: handle.name, localPath: mirror }, full);
			const retired = await h.orchestrator.retire(handle.name, { graceful: false });
			// Before D3.2 this parsed `<runDir>/<name>.jsonl` — zero bytes forever — and
			// recorded "no messages in session" next to a transcript that had them all.
			assert.equal(retired.execution?.status, "success", `the mirror must be the source, got ${JSON.stringify(retired.execution)}`);
		});
	} finally {
		h.cleanup();
	}
});
