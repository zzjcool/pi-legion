/**
 * W4: renewal wiring — baseline (D8), counting (D6/D5-a) and the proposal
 * decision (D1/D5/D6/D7) that W3's renderer consumes.
 *
 * Contract: docs/contracts/subagent-renewal-v1.md (FROZEN).
 *
 * Scope note: these tests deliberately exercise the **pure functions** W4
 * exports (`renewalProposalFor` / `wasBudgetCut` / `chargeRenewal` /
 * `seedRenewalState` / `renewalBaselineFor`) and the renderer they feed
 * (`formatCompletionNotice`). The one line that physically attaches a proposal
 * to a notice lives in `src/extension/runtime.ts` (`join.onTerminal`), which
 * the contract assigns to W3 (§4) and this unit may not touch — the acceptance
 * table below records exactly which half each test pins.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import {
	chargeRenewal,
	renewalBaselineFor,
	renewalProposalFor,
	seedRenewalState,
	wasBudgetCut,
} from "../../index.ts";
import { formatCompletionNotice } from "../../src/extension/notify.ts";
import { measureProgress } from "../../src/runs/progress-signal.ts";
import { NO_ASSISTANT_ABORT_REASON } from "../../src/shared/session.ts";
import type { AgentConfig, ChildRecord, Execution } from "../../src/shared/types.ts";

// ─────────────────────────── fixtures ───────────────────────────

/** A session directory that cleans itself up. */
function sessionDir(): { dir: string; cleanup: () => void } {
	const dir = mkdtempSync(path.join(tmpdir(), "legion-renewal-wiring-"));
	return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** One session JSONL row in the measured shape (`{type:"message",message:{role}}`). */
function row(role: "assistant" | "toolResult" | "user"): string {
	return JSON.stringify({ type: "message", message: { role } });
}

/** Write a session file with `toolResults` tool rows and `assistants` assistant rows. */
function writeSession(file: string, toolResults: number, assistants: number): void {
	const rows: string[] = [];
	for (let i = 0; i < assistants; i += 1) rows.push(row("assistant"));
	for (let i = 0; i < toolResults; i += 1) rows.push(row("toolResult"));
	writeFileSync(file, `${rows.join("\n")}\n`);
}

/** Append rows to an existing session file (a renewal's new output). */
function appendSession(file: string, toolResults: number, assistants: number): void {
	const rows: string[] = [];
	for (let i = 0; i < assistants; i += 1) rows.push(row("assistant"));
	for (let i = 0; i < toolResults; i += 1) rows.push(row("toolResult"));
	writeFileSync(file, `${rows.join("\n")}\n`, { flag: "a" });
}

/** The two role knobs `renewalProposalFor` reads, nothing else. */
function role(over: Partial<Pick<AgentConfig, "renewable" | "maxRenewals">> = {}): Pick<
	AgentConfig,
	"renewable" | "maxRenewals"
> {
	return { ...over };
}

/** A child as the proposal builder sees it: only the two renewal fields matter. */
function child(
	over: Partial<Pick<ChildRecord, "renewalBaseline" | "renewalsUsed">> = {},
): Pick<ChildRecord, "renewalBaseline" | "renewalsUsed"> {
	return { renewalBaseline: { at: 1_000, lines: 0 }, renewalsUsed: 0, ...over };
}

/** A terminated execution in the shape a budget casualty actually produces. */
const TERMINATED = { status: "aborted", reason: "terminated during tool call" };

// ───────────────────── A4: renewable: false ─────────────────────

test("A4: `renewable: false` yields no proposal, so the notice carries zero renewal lines", () => {
	const proposal = renewalProposalFor({
		agent: role({ renewable: false }),
		child: child(),
		sessionFile: "/nonexistent/session.jsonl",
		execution: TERMINATED,
		name: "scout-1",
	});
	assert.equal(proposal, undefined, "D5: a role that forbids renewal gets no proposal");

	// The renderer contract: an absent `renewal` keeps every renewal line out —
	// that is what makes the unrenewable notice byte-identical to pre-W3.
	const notice = formatCompletionNotice({
		name: "scout-1",
		agent: "scout",
		execution: TERMINATED,
		output: "search timed out",
		...(proposal ? { renewal: proposal } : {}),
	});
	assert.doesNotMatch(notice.content, /renew/i, "zero renewal lines (A4)");
	assert.doesNotMatch(notice.content, /progressed:/);
});

test("A4: a `renewable: true` role *does* produce a proposal (the A4 switch is the only difference)", () => {
	const proposal = renewalProposalFor({
		agent: role({ renewable: true }),
		child: child(),
		sessionFile: "/nonexistent/session.jsonl",
		execution: TERMINATED,
		name: "worker-1",
		measure: () => ({ toolResults: 9, assistantMessages: 2 }),
	});
	assert.ok(proposal, "the same child/execution with renewable:true is offered a renewal");
	assert.equal(proposal.used, 0);
	assert.equal(proposal.max, 2, "D6 default");
});

// ─────────────────── A5: budget exhausted ───────────────────

test("A5: `used >= max` still builds a proposal so the notice can say `renewals exhausted`", () => {
	const proposal = renewalProposalFor({
		agent: role({ maxRenewals: 2 }),
		child: child({ renewalsUsed: 2 }),
		sessionFile: "/nonexistent/session.jsonl",
		execution: TERMINATED,
		name: "worker-1",
		measure: () => ({ toolResults: 47, assistantMessages: 12, filesChanged: 6 }),
	});
	assert.ok(proposal, "an exhausted child still reports, it does not go silent (D6/A5)");
	assert.equal(proposal.used, 2);
	assert.equal(proposal.max, 2);

	const notice = formatCompletionNotice({
		name: "worker-1",
		agent: "worker",
		execution: TERMINATED,
		output: "partial work",
		renewal: proposal,
	});
	assert.match(notice.content, /renewals exhausted \(2\/2\)/, "A5 wording");
	assert.match(notice.content, /split the task instead of renewing/);
	// The exhausted branch must NOT also hand out a `renew:` command line.
	assert.doesNotMatch(notice.content, /^renew:/m);
});

test("A5: `maxRenewals: 0` disables renewal outright rather than offering `0/0`", () => {
	const proposal = renewalProposalFor({
		agent: role({ maxRenewals: 0 }),
		child: child(),
		sessionFile: "/nonexistent/session.jsonl",
		execution: TERMINATED,
		name: "worker-1",
		measure: () => ({ toolResults: 47, assistantMessages: 12 }),
	});
	assert.equal(proposal, undefined, "D6: 0 = renewal disabled");
});

// ────────────── A6/D8: baseline resets, only new rows count ──────────────

test("A6/D8: a reset baseline counts only the rows written after it, not the history", () => {
	const { dir, cleanup } = sessionDir();
	try {
		const session = path.join(dir, "worker-1.jsonl");
		// History: a long, productive first turn.
		writeSession(session, 20, 8);

		// D8: the renewal takes the baseline at the current line count.
		const baseline = renewalBaselineFor(session);
		assert.equal(baseline.lines, 28, "baseline = the file's line count at renewal time");
		assert.ok(baseline.at > 0, "baseline carries a timestamp");

		// The child then does almost nothing before being cut off again.
		appendSession(session, 1, 1);
		const afterRenewal = measureProgress({ sessionFile: session, baseline });
		assert.equal(afterRenewal.toolResults, 1, "only the post-baseline tool row counts");
		assert.equal(afterRenewal.assistantMessages, 1);
		assert.equal(afterRenewal.progressed, false, "D2-a: 1 toolResult is below the threshold");

		// Without the reset, all 21 tool rows would count and the child would look
		// productive — the exact misreading D8 exists to prevent.
		const sinceSpawn = measureProgress({
			sessionFile: session,
			baseline: { at: 0, lines: 0 },
		});
		assert.equal(sinceSpawn.toolResults, 21);
		assert.equal(sinceSpawn.progressed, true, "history alone passes the threshold");
	} finally {
		cleanup();
	}
});

test("A6/D8: `seedRenewalState` seeds the baseline once and never overwrites a renewal's reset", () => {
	const { dir, cleanup } = sessionDir();
	try {
		const session = path.join(dir, "worker-2.jsonl");
		writeSession(session, 5, 1);

		const fresh: Pick<ChildRecord, "sessionFile" | "renewalBaseline" | "renewalsUsed"> = {
			sessionFile: session,
		};
		seedRenewalState(fresh, 5_000);
		assert.deepEqual(fresh.renewalBaseline, { at: 5_000, lines: 6 }, "spawn baseline");
		assert.equal(fresh.renewalsUsed, 0, "a fresh child has spent nothing");

		// A renewal moves the baseline forward; a later seed must not undo it.
		const renewed = { at: 9_000, lines: 12 };
		fresh.renewalBaseline = renewed;
		seedRenewalState(fresh, 10_000);
		assert.deepEqual(
			fresh.renewalBaseline,
			renewed,
			"the guard is 'absent', so an existing baseline is left alone",
		);
	} finally {
		cleanup();
	}
});

test("A6: an empty or unreadable session seeds a zero baseline instead of failing the launch", () => {
	const { dir, cleanup } = sessionDir();
	try {
		const empty = path.join(dir, "empty.jsonl");
		writeFileSync(empty, "");
		assert.deepEqual(
			renewalBaselineFor(empty, 1),
			{ at: 1, lines: 0 },
			"a just-created session measures as zero lines",
		);
		assert.deepEqual(
			renewalBaselineFor(path.join(dir, "missing.jsonl"), 1),
			{ at: 1, lines: 0 },
			"a missing session file is 'nothing written yet', never a throw",
		);
	} finally {
		cleanup();
	}
});

// ─────────────── D7: wait/collect timeouts never propose ───────────────

test("D7/A3: a `running` snapshot (wait/collect deadline on a live child) is never offered a renewal", () => {
	const proposal = renewalProposalFor({
		agent: role(),
		child: child(),
		sessionFile: "/nonexistent/session.jsonl",
		// The shape `inprocess-supervisor` resolves on a parent-side timeout:
		// the child is ALIVE and simply has not finished yet.
		execution: { status: "running", reason: "collect deadline" },
		name: "worker-1",
		measure: () => ({ toolResults: 99, assistantMessages: 99, filesChanged: 9 }),
	});
	assert.equal(
		proposal,
		undefined,
		"D7: renewing a live child would spend a budget it never lost",
	);

	// The notice for that path therefore has no renewal field and no renewal line.
	const notice = formatCompletionNotice({
		name: "worker-1",
		agent: "worker",
		execution: { status: "failed", reason: "collect deadline (child is alive)" },
		output: "still working",
	});
	assert.doesNotMatch(notice.content, /^renew/m);
	assert.doesNotMatch(notice.content, /progressed:/);
});

// ──────────────── D1: completed children are not candidates ────────────────

test("D1: a `completed` child is never offered a renewal", () => {
	const proposal = renewalProposalFor({
		agent: role(),
		child: child(),
		sessionFile: "/nonexistent/session.jsonl",
		execution: { status: "success" },
		name: "worker-1",
		measure: () => ({ toolResults: 50, assistantMessages: 20, filesChanged: 3 }),
	});
	assert.equal(proposal, undefined, "a child with a verdict is not a budget casualty");
});

test("D1: even a hand-built proposal cannot reach a completed notice (renderer half)", () => {
	// Belt and braces from both sides: W4 refuses to build it, and W3's renderer
	// refuses to print it, so neither unit alone can resurrect finished work.
	const notice = formatCompletionNotice({
		name: "worker-1",
		agent: "worker",
		execution: { status: "success" },
		output: "done",
		renewal: {
			progress: { toolResults: 9, assistantMessages: 2 },
			used: 0,
			max: 2,
			command: 'subagent({ action: "continue", name: "worker-1", message: "x" })',
		},
	});
	assert.doesNotMatch(notice.content, /^renew/m);
	assert.doesNotMatch(notice.content, /progressed:/);
});

// ─────────── A2: no measurable progress is reported, not hidden ───────────

test("A2: a measurement of zero still produces a proposal so the notice can say so", () => {
	const proposal = renewalProposalFor({
		agent: role(),
		child: child(),
		sessionFile: "/nonexistent/session.jsonl",
		execution: TERMINATED,
		name: "worker-1",
		measure: () => ({ toolResults: 0, assistantMessages: 0 }),
	});
	assert.ok(proposal, "the decision to withhold is D2-a's, made by the renderer");
	const notice = formatCompletionNotice({
		name: "worker-1",
		agent: "worker",
		execution: TERMINATED,
		output: "stuck",
		renewal: proposal,
	});
	assert.match(notice.content, /no measurable progress since spawn/);
	assert.doesNotMatch(notice.content, /^renew:/m);
});

// ────────────── D4/A8: the command is always `continue` ──────────────

test("D4/A8: the proposal's command is a ready-made `continue`, never a new action", () => {
	const proposal = renewalProposalFor({
		agent: role(),
		child: child(),
		sessionFile: "/nonexistent/session.jsonl",
		execution: TERMINATED,
		name: "W2",
		measure: () => ({ toolResults: 47, assistantMessages: 12, filesChanged: 6 }),
	});
	assert.ok(proposal);
	assert.match(
		proposal.command,
		/^subagent\(\{ action: "continue", name: "W2", message: "<what to continue>" \}\)$/,
		"exactly the shape the parent can paste",
	);
	assert.doesNotMatch(proposal.command, /action: "(renew|extend)"/);
});

// ───────── D5-a / A10: only a budget cut spends a renewal ─────────

test("A10/D5-a: `stopReason: toolUse` (cut off mid-tool) spends a renewal", () => {
	const child = { renewalsUsed: 0 };
	assert.equal(wasBudgetCut({ status: "aborted", stopReason: "toolUse" }), true);
	chargeRenewal(child);
	assert.equal(child.renewalsUsed, 1);
});

test("A10/D5-a: a hard kill with no assistant message spends a renewal", () => {
	const child = { renewalsUsed: 1 };
	const hardKilled: Execution = { status: "aborted", reason: NO_ASSISTANT_ABORT_REASON };
	assert.equal(
		wasBudgetCut(hardKilled),
		true,
		"F29: 'missing reply' IS the abort signal",
	);
	chargeRenewal(child);
	assert.equal(child.renewalsUsed, 2, "the budget moved, not just the baseline");
});

test("A10/D5-a: a host `terminated` reason spends a renewal (third, weakest signal)", () => {
	assert.equal(
		wasBudgetCut({ status: "aborted", reason: "terminated during tool call" }),
		true,
	);
	assert.equal(
		wasBudgetCut({ status: "failed", reason: "Terminated by host" }),
		true,
		"the wording match is case-insensitive",
	);
});

test("A10/D5-a: a normal `stop`/`length` turn does NOT spend a renewal", () => {
	for (const stopReason of ["stop", "length"] as const) {
		const child = { renewalsUsed: 1 };
		const execution: Execution = { status: "success", stopReason };
		assert.equal(
			wasBudgetCut(execution),
			false,
			`a clean '${stopReason}' turn is a user retry, not a budget casualty`,
		);
		if (wasBudgetCut(execution)) chargeRenewal(child);
		assert.equal(child.renewalsUsed, 1, "the budget is untouched by a plain retry");
	}
});

test("A10/D5-a: a normal failed turn after a real reply does not spend a renewal", () => {
	// A provider error after the model answered: the turn has an assistant row,
	// so it is a failure to retry, not a budget cut.
	assert.equal(
		wasBudgetCut({ status: "failed", stopReason: "error", reason: "model error" }),
		false,
	);
	// A missing record (never collected) is not evidence of a budget cut.
	assert.equal(wasBudgetCut(undefined), false);
});

test("A10/D5-a: the budget cutoff and the counter agree end to end", () => {
	const { dir, cleanup } = sessionDir();
	try {
		const session = path.join(dir, "worker-9.jsonl");
		writeSession(session, 20, 5);

		// Termination #1: cut off mid-tool → budget charged, baseline reset.
		const renewed: Pick<ChildRecord, "renewalBaseline" | "renewalsUsed"> = {
			renewalBaseline: { at: 0, lines: 0 },
			renewalsUsed: 0,
		};
		if (wasBudgetCut({ status: "aborted", stopReason: "toolUse" })) chargeRenewal(renewed);
		renewed.renewalBaseline = renewalBaselineFor(session);
		assert.equal(renewed.renewalsUsed, 1);
		assert.equal(renewed.renewalBaseline.lines, 25);

		// Termination #2 after real work → second charge, and the proposal now
		// reports 2/2 so the notice can tell the parent to split the task.
		appendSession(session, 4, 1);
		if (wasBudgetCut({ status: "aborted", stopReason: "toolUse" })) chargeRenewal(renewed);
		const proposal = renewalProposalFor({
			agent: role({ maxRenewals: 2 }),
			child: renewed,
			sessionFile: session,
			execution: TERMINATED,
			name: "worker-9",
		});
		assert.ok(proposal);
		assert.equal(proposal.used, 2);
		assert.equal(proposal.max, 2);
		assert.equal(proposal.progress.toolResults, 4, "only the post-renewal rows");
	} finally {
		cleanup();
	}
});

// ───────────── D6: the counter never moves without a reason ─────────────

test("D6: `chargeRenewal` treats a missing counter as zero and increments by one", () => {
	const legacy: Pick<ChildRecord, "renewalsUsed"> = {};
	assert.equal(chargeRenewal(legacy), 1, "#266-era record reads as 0, not NaN");
	assert.equal(chargeRenewal(legacy), 2);
});

test("D6: a child with no baseline (pre-contract record) is not offered a renewal", () => {
	const proposal = renewalProposalFor({
		agent: role(),
		child: { renewalsUsed: 0 },
		sessionFile: "/nonexistent/session.jsonl",
		execution: TERMINATED,
		name: "worker-1",
		measure: () => ({ toolResults: 47, assistantMessages: 12 }),
	});
	assert.equal(proposal, undefined, "D8: nothing to measure from, so nothing to promise");
});

// ── D3 physical wiring: the CompletionInput construction point ────────────

test("D3 wiring: the notice carries the proposal through the runtime hook, and nothing else does", () => {
	// `src/extension/runtime.ts` builds the ONLY `CompletionInput` in the
	// repository (the `join.onTerminal` call). It cannot import `index.ts` (that
	// would be a cycle), so the proposal arrives through `deps.getRenewalProposal`
	// and the runtime must forward it untouched. W4 originally could not attach
	// this wire because the contract assigned runtime.ts to another unit; the
	// assertion lives here so the seam is pinned wherever the code lives.
	const execution = { status: "failed", reason: "terminated during tool call" };
	const proposal = {
		progress: { toolResults: 5, assistantMessages: 2 },
		used: 0,
		max: 2,
		command: 'subagent({ action: "continue", name: "w-1", message: "keep going" })',
	};
	const withProposal = formatCompletionNotice({
		name: "w-1",
		agent: "worker",
		execution,
		output: "partial",
		renewal: proposal,
	});
	assert.match(withProposal.content, /progressed: 5 tool results/);
	assert.match(withProposal.content, /action: "continue"/);
	assert.match(withProposal.content, /renewals: 0\/2/);

	// The hook returning undefined (D1/D5/D7/D8, or no hook at all) is the whole
	// "do not offer" decision — the notice must then be byte-identical to the
	// pre-renewal shape, which the regression test above already pins per status.
	const without = formatCompletionNotice({
		name: "w-1",
		agent: "worker",
		execution,
		output: "partial",
		renewal: undefined,
	});
	assert.doesNotMatch(without.content, /progressed:/);
	assert.doesNotMatch(without.content, /action: "continue"/);
});
