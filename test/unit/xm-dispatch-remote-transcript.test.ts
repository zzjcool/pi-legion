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
 * Each test below pins one of the facts that made that possible:
 *
 * 1. the read-back happened ONCE, at launch+ε, and the verdict was derived from
 *    that frozen snapshot (`D3.1`);
 * 2. a failed read-back must not be reported as "the child never spoke", nor may it
 *    grade a PREVIOUS mirror as this turn's delivery (`D3.3`);
 * 3. `wait` running out is not an abort (`D3.3`);
 * 4. a mirror left by an earlier process is what a later reader finds, rather than
 *    the empty placeholder this machine pre-created (`D3.2`).
 *
 * The seam is PHASE-AWARE, not call-order-aware: it answers "the launch-time shape"
 * until the supervisor's `waitSettled` has been asked for, and "the settled shape"
 * after. That is what distinguishes "read once, after the wait" from "read twice,
 * both before it" — the false-green shape this file already produced once, when a
 * duplicated read at the top of `collect()` made the post-wait refresh look
 * unnecessary.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { COLLECT_DEADLINE_REASON, launchNoticeLines, Orchestrator, transcriptNotRetrievedReason } from "../../src/runs/orchestrator.ts";
import { createRemoteSessionReadback, remoteMirrorPathFor, type RemoteReadbackResult, type RemoteSessionRequest } from "../../src/runs/remote-artifact.ts";
import { type HostTarget } from "../../src/runs/remote.ts";
import type { HcClient, HcMethod } from "../../src/hc/client.ts";
import { NO_ASSISTANT_ABORT_REASON } from "../../src/shared/session.ts";
import { type AgentConfig, type SubagentsSettings } from "../../src/shared/types.ts";
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

function target(overrides: Partial<HostTarget> = {}): HostTarget {
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
		...overrides,
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

/** Which half of the collect a read-back belongs to: before the wait, or after it. */
type ReadPhase = "before-wait" | "after-wait";

interface Harness {
	root: string;
	runDir: string;
	supervisor: FakeSupervisor;
	orchestrator: Orchestrator;
	/** The phase of every read-back, in order. */
	phases: ReadPhase[];
	cleanup: () => void;
}

/**
 * A run whose read-back seam is scripted BY PHASE: `answers` is told whether the
 * supervisor's wait has already been asked for, so a test states what the machine
 * looked like at launch and what it looks like once the child settled — without
 * depending on how many reads happen before the wait.
 */
function harness(prefix: string, opts: {
	answers: (request: RemoteSessionRequest, call: number, phase: ReadPhase) => RemoteReadbackResult | Promise<RemoteReadbackResult>;
	supervisor?: FakeSupervisor;
}): Harness {
	const root = mkdtempSync(path.join(tmpdir(), prefix));
	const runDir = path.join(root, "run");
	mkdirSync(runDir, { recursive: true });
	const supervisor = opts.supervisor ?? new FakeSupervisor();
	const phases: ReadPhase[] = [];
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
			// "After the wait" means the supervisor was actually asked to wait: that is
			// the moment the transcript stops being a snapshot.
			const phase: ReadPhase = supervisor.calls.some((call) => call.method === "waitSettled")
				? "after-wait"
				: "before-wait";
			phases.push(phase);
			return opts.answers(request, calls, phase);
		},
	});
	return {
		root,
		runDir,
		supervisor,
		orchestrator,
		phases,
		cleanup: () => rmSync(root, { recursive: true, force: true }),
	};
}

/** Write the mirror exactly as the seam does, so the collector can parse it. */
function writeMirror(request: { localPath: string }, text: string): void {
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

const countLines = (text: string): number => text.split("\n").filter((line) => line.length > 0).length;

// ── D3.1 / D3.3: the verdict must read the SETTLED transcript ───────────────

test("D3.1: an assistant message written before the wait settles is never `aborted` — the mirror is re-read after the wait", async () => {
	const prompt = "Implement the slice.";
	const h = harness("xm-transcript-refresh-", {
		answers: (request, _call, phase) => {
			// BEFORE the wait = the launch-time snapshot (prompt only: exactly the real
			// run). AFTER it = the transcript as it really ends (assistant last).
			const text = phase === "before-wait" ? earlyTranscript(prompt) : settledTranscript(prompt);
			writeMirror(request, text);
			return okReadback(request, text, countLines(text));
		},
	});
	try {
		await insideHcTerminal(async () => {
			const handle = await h.orchestrator.launch({ agent: agent(), task: prompt, host: HOST, hostTarget: target() });
			// The child is over BEFORE the collect starts: the only thing that can make
			// the verdict wrong is reading the launch-time snapshot.
			h.supervisor.settle(handle.name, { text: '{"ok":true,"reason":"done"}' });
			const collected = await h.orchestrator.collect(handle.name);

			// The read that produced the verdict happened AFTER the wait — not merely
			// "more than once" (a second pre-wait read is not a refresh).
			assert.deepEqual(h.phases, ["before-wait", "after-wait"], `read-backs by phase: ${h.phases.join(", ")}`);
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
		answers: (request, _call, phase) => {
			if (phase === "before-wait") {
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

test("D3.3: a failed read-back does not grade a PREVIOUS mirror as this turn's delivery", async () => {
	// The subtle half: with a stale-but-COMPLETE mirror on disk, `deriveOutcome` says
	// `success` — which would hand the parent last turn's output as this turn's result
	// while the render says "the verdict rests on no transcript at all".
	const prompt = "Implement the slice.";
	const h = harness("xm-transcript-stale-", {
		// EVERY read fails, and the mirror is never touched — so the bytes the collector
		// parses are the ones a PREVIOUS process wrote. That is the dangerous shape: the
		// stale turn is already complete, so `deriveOutcome` says `success`.
		answers: (request) => ({
			ok: false,
			host: request.host,
			reason: "not found",
			remotePath: "/srv/.pi-subagents-mirror/no-run/worker-0/session.jsonl",
			fate: "no-session",
			evidence: ["terminal running"],
			nextStep: "check the mirror dir",
		}),
	});
	try {
		await insideHcTerminal(async () => {
			const handle = await h.orchestrator.launch({ agent: agent(), task: prompt, host: HOST, hostTarget: target() });
			// The leftover from an earlier collect in an earlier process.
			writeMirror({ localPath: remoteMirrorPathFor(h.runDir, handle.name) }, settledTranscript(prompt));
			h.supervisor.settle(handle.name, { text: '{"ok":true,"reason":"done"}' });
			const collected = await h.orchestrator.collect(handle.name);
			assert.equal(collected.execution.status, "unknown");
			assert.match(String(collected.execution.reason), /transcript not retrieved from host 'hw-nj'/);
			// And it did NOT hand out the stale turn's text as this turn's delivery.
			assert.equal(collected.output, "");
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

// ── D3.1: a RUNNING remote child must show what it already wrote ───────────

test("D3.1: a remote transcript that GROWS during the grace window earns the extension (the local size probe is blind there)", async () => {
	const prompt = "Implement the slice.";
	const h = harness("xm-transcript-growth-", {
		answers: (request, call) => {
			// The mirror keeps ending on the prompt (the child is mid-turn), but the file
			// GAINS lines on every read: exactly what a working remote child looks like.
			const text = earlyTranscript(prompt);
			writeMirror(request, text);
			return okReadback(request, text, 5 + 2 * (call - 1));
		},
		supervisor: new FakeSupervisor({ immediateTimeout: true }),
	});
	try {
		await insideHcTerminal(async () => {
			const handle = await h.orchestrator.launch({ agent: agent(), task: prompt, host: HOST, hostTarget: target() });
			const collected = await h.orchestrator.collect(handle.name, { timeoutMs: 1 });
			// A grace extension is granted only when the transcript grew — twice here,
			// i.e. two extra waits. Without the remote growth branch the local probe
			// stats the empty placeholder, answers "no growth", and there is ONE wait.
			const waits = h.supervisor.calls.filter((call) => call.method === "waitSettled").length;
			assert.ok(waits >= 3, `expected the grace loop to wait again, saw ${waits} wait(s)`);
			assert.ok((collected.remoteReadback?.lines ?? 0) > 5, "the later reads must be the longer ones");
			assert.equal(collected.execution.status, "running");
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
			writeMirror({ localPath: mirror }, settledTranscript(prompt));
			const retired = await h.orchestrator.retire(handle.name, { graceful: false });
			// Before D3.2 this parsed `<runDir>/<name>.jsonl` — zero bytes forever — and
			// recorded "no messages in session" next to a transcript that had them all.
			assert.equal(retired.execution?.status, "success", `the mirror must be the source, got ${JSON.stringify(retired.execution)}`);
		});
	} finally {
		h.cleanup();
	}
});

// ── D3.3: a zero-line answer over a non-empty mirror is not "complete" ─────

test("D3.3: a `lines: 0` answer over a non-empty mirror is a FAILURE that keeps the old bytes", async () => {
	// The seam without a core: `file.read` answers 0 lines while the local mirror holds
	// a previous read. Writing "" would present "the child said nothing"; keeping the
	// bytes and calling it "0 of 0 (complete)" would present a STALE transcript as
	// this turn's. Neither is a verdict, so the seam refuses.
	const crossMachine: SubagentsSettings["crossMachine"] = {
		enabled: true,
		hosts: { [HOST]: { cwd: "/srv/app", node: "node", piCli: "pi", piLegionRoot: "/srv/pi-legion", piExtensions: [], worktreeRoot: "/srv/.pi-worktrees" } },
	};
	const root = mkdtempSync(path.join(tmpdir(), "xm-transcript-zero-"));
	const localPath = path.join(root, "remote", "worker-0.jsonl");
	mkdirSync(path.dirname(localPath), { recursive: true });
	const previous = '{"type":"message","message":{"role":"user","content":"an earlier turn"}}\n';
	writeFileSync(localPath, previous);
	const calls: Array<{ method: HcMethod; params: Record<string, unknown> }> = [];
	const client: HcClient = {
		start: async () => {},
		close: () => {},
		request: async <T = unknown>(method: HcMethod, params: Record<string, unknown> = {}): Promise<T> => {
			calls.push({ method, params });
			// `lines` is the file's total: 0 here means "that machine sees nothing".
			return { text: "", lines: 0, first: 0, last: 0 } as T;
		},
	};
	try {
		const seam = createRemoteSessionReadback({ crossMachine, clientFactory: () => client });
		const result = await seam({ host: HOST, name: "worker-0", localPath });
		assert.equal(result.ok, false);
		if (result.ok) return;
		assert.equal(result.fate, "path");
		assert.match(result.reason, /0 lines while this machine already holds 48 bytes|0 lines while this machine already holds \d+ bytes/);
		assert.equal(result.remotePath, "/srv/.pi-subagents-mirror/no-run/worker-0/session.jsonl");
		// The old bytes survive: nothing was overwritten with "".
		assert.equal(readFileSync(localPath, "utf8"), previous);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

// ── D2 delivery channel: warnings reach the caller's render ────────────────

test("D2: `launchNoticeLines` renders model warnings AND cross-machine skip warnings, one line each", () => {
	// The channel the contract forbids replacing with `process.stderr`: a queued
	// (fan-out) launch renders no `▶` line, so this is the only place its warnings can
	// become visible — `launchStep` and the queue notice both call it.
	assert.deepEqual(launchNoticeLines("worker-0", {}), []);
	assert.deepEqual(
		launchNoticeLines("worker-0", {
			warning: "Using custom model id 'x'",
			warnings: ["host 'hw-nj': skipped 2 inherited extensions that machine cannot install/load: pi-sop, pi-sysmon."],
		}),
		[
			"  ⚠ worker-0: Using custom model id 'x'",
			"  ⚠ worker-0: host 'hw-nj': skipped 2 inherited extensions that machine cannot install/load: pi-sop, pi-sysmon.",
		],
	);
	// Empty strings are not notices (a backend that sets `warnings: [""]` must not
	// produce a blank `⚠` line).
	assert.deepEqual(launchNoticeLines("worker-0", { warnings: ["", ""] }), []);
});

test("D2: `Orchestrator.launch` carries the backend's warnings on the handle", async () => {
	const h = harness("xm-warning-channel-", {
		answers: (request) => okReadback(request, earlyTranscript("p"), 5),
	});
	// The seam is irrelevant here; the backend's handle is what must survive.
	const real = h.supervisor.spawnChild.bind(h.supervisor);
	const warning = "host 'hw-nj': skipped 1 inherited extension that machine cannot install/load: pi-sop.";
	h.supervisor.spawnChild = async (input) => ({ ...(await real(input)), warnings: [warning] });
	try {
		await insideHcTerminal(async () => {
			const handle = await h.orchestrator.launch({ agent: agent(), task: "t", host: HOST, hostTarget: target() });
			assert.deepEqual(handle.warnings, [warning]);
			assert.deepEqual(launchNoticeLines(handle.name, handle), [`  ⚠ ${handle.name}: ${warning}`]);
		});
	} finally {
		h.cleanup();
	}
});
