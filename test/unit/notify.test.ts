import { test } from "node:test";
import assert from "node:assert/strict";
import {
	completionDeliveryOptions,
	completionStatusOf,
	deliverCompletion,
	formatCollectFailure,
	formatCompletionNotice,
	formatGroupedNotice,
	formatRenewalBlock,
	type CompletionInput,
	type CompletionNotice,
	type GroupedEntry,
	formatNoticeHeadline,
	previewOutput,
	type RenewalProgress,
	type RenewalProposal,
	sanitizeNoticeField,
	SUBAGENT_NOTIFY_TYPE,
} from "../../src/extension/notify.ts";

test("completionStatusOf: success is completed, abort is stopped, else failed", () => {
	assert.equal(completionStatusOf("success"), "completed");
	assert.equal(completionStatusOf("aborted"), "stopped");
	assert.equal(completionStatusOf("failed"), "failed");
	assert.equal(completionStatusOf("truncated"), "failed");
	// B: `running` is a progress signal, not a completion — it no longer falls
	// through to `failed` (that mislabelled every collect timeout on a live
	// child "Background task failed" while the body said "still alive").
	assert.equal(completionStatusOf("running"), "running");
});

test("formatCompletionNotice: success is displayed and carries renderer details", () => {
	const notice = formatCompletionNotice({
		name: "worker-0",
		agent: "worker",
		execution: { status: "success" },
		output: "done the thing",
		sessionFile: "/tmp/worker-0.jsonl",
		acceptance: { status: "attested", level: "attested" },
	});
	assert.equal(notice.status, "completed");
	// display: true — the transcript records the finish; the renderer keeps
	// it to one line instead of hiding it.
	assert.equal(notice.display, true);
	assert.equal(notice.details.status, "completed");
	assert.equal(notice.details.name, "worker-0");
	assert.equal(notice.details.agent, "worker");
	assert.equal(notice.details.execution.status, "success");
	assert.equal(notice.details.acceptance?.level, "attested");
	assert.equal(notice.details.sessionFile, "/tmp/worker-0.jsonl");
	assert.equal(notice.details.outputBytes, Buffer.byteLength("done the thing"));
	assert.match(notice.content, /Background task completed: \*\*worker-0 \(worker\)\*\*/);
	assert.match(notice.content, /execution: success/);
	assert.match(notice.content, /done the thing/);
	assert.match(notice.content, /Session file: \/tmp\/worker-0\.jsonl/);
	assert.match(notice.content, /Child retired\./);
	assert.doesNotMatch(notice.content, /RPC child retired/);
});

test("formatCompletionNotice: failure is displayed", () => {
	const notice = formatCompletionNotice({
		name: "reviewer-1",
		execution: { status: "failed", reason: "model error" },
		output: "boom",
	});
	assert.equal(notice.status, "failed");
	assert.equal(notice.display, true);
	assert.match(notice.content, /Background task failed: \*\*reviewer-1\*\*/);
	assert.match(notice.content, /execution: failed \(model error\)/);
});

test("formatCompletionNotice: aborted maps to stopped and is displayed", () => {
	const notice = formatCompletionNotice({
		name: "w1",
		execution: { status: "aborted", reason: "killed" },
		output: "",
	});
	assert.equal(notice.status, "stopped");
	assert.equal(notice.display, true);
	assert.match(notice.content, /\(no output\)/);
});

test("formatNoticeHeadline: one line with glyph, verdict and size", () => {
	assert.equal(
		formatNoticeHeadline({
			status: "completed",
			name: "worker-0",
			agent: "worker",
			execution: { status: "success" },
			acceptance: { status: "accepted", level: "verified" },
			outputBytes: 4096,
		}),
		"✓ worker-0 (worker) · success · acceptance accepted (verified) · 4.0 KB",
	);
	assert.equal(
		formatNoticeHeadline({
			status: "failed",
			name: "reviewer-1",
			execution: { status: "failed", reason: "model error" },
			outputBytes: 0,
		}),
		"✗ reviewer-1 · failed (model error) · 0 B",
	);
	assert.equal(
		formatNoticeHeadline({
			status: "stopped",
			name: "w1",
			execution: { status: "aborted" },
			outputBytes: 3,
		}),
		"■ w1 · aborted · 3 B",
	);
});

test("formatNoticeHeadline: hostile fields cannot break the one-line contract", () => {
	// Child names go through src/shared/name.ts, but `agent` labels and
	// non-pi pane titles do not; the headline must strip what would split a
	// row or inject raw escapes into the TUI.
	const headline = formatNoticeHeadline({
		status: "completed",
		name: "w\x1b[41mEVIL\x1b[0m\r\nnext",
		agent: "a\x1b]2;pwn\x07gent",
		execution: { status: "su\nccess", reason: "r\teason\x1b[31m" },
		outputBytes: 1,
	});
	assert.doesNotMatch(headline, /[\x00-\x08\x0b-\x1f\x7f]/);
	assert.equal(headline.includes("\x1b"), false);
	assert.equal(headline.includes("\n"), false);
	assert.equal(headline.includes("\r"), false);
	// ESC removed; the printable remainder stays readable.
	assert.match(headline, /w\[41mEVIL\[0mnext/);
	assert.match(headline, /a\]2;pwngent/);
});

test("sanitizeNoticeField strips control characters only", () => {
	assert.equal(sanitizeNoticeField("a\nb\tc"), "abc");
	assert.equal(sanitizeNoticeField("\x1b[31mred\x1b[0m"), "[31mred[0m");
	assert.equal(sanitizeNoticeField("plain"), "plain");
});

test("formatCompletionNotice: details survive a JSON round-trip (session reload)", () => {
	const notice = formatCompletionNotice({
		name: "worker-0",
		agent: "worker",
		execution: { status: "success" },
		output: "done",
		sessionFile: "/tmp/w.jsonl",
		acceptance: { status: "attested", level: "attested" },
	});
	// The persisted entry is details-as-JSON; the renderer's guard must
	// accept what comes back.
	const reloaded = JSON.parse(JSON.stringify(notice.details));
	assert.equal(reloaded.status, "completed");
	assert.equal(reloaded.name, "worker-0");
	assert.equal(reloaded.agent, "worker");
	assert.equal(reloaded.acceptance.level, "attested");
	assert.equal(reloaded.sessionFile, "/tmp/w.jsonl");
	assert.equal(typeof reloaded.outputBytes, "number");
	// Details never leak into content: the LLM payload is unchanged.
	assert.doesNotMatch(notice.content, /outputBytes/);
	assert.doesNotMatch(notice.content, /"status": "completed"/);
});

test("formatCollectFailure wraps an exception as a failed notice", () => {
	const notice = formatCollectFailure("w1", new Error("gone"));
	assert.equal(notice.status, "failed");
	assert.match(notice.content, /gone/);
	assert.doesNotMatch(notice.content, /Child retired\./);
});

test("formatCollectFailure does not present a bare Connection error as the failure reason", () => {
	const notice = formatCollectFailure("worker-0", new Error("Connection error."));
	assert.equal(notice.status, "failed");
	assert.match(notice.content, /Connection error\. \(child is not alive\)/);
	assert.doesNotMatch(notice.content, /execution: failed \(Connection error\.\)/);
});

test("completionDeliveryOptions follows up instead of steering", () => {
	assert.deepEqual(completionDeliveryOptions(true), {
		triggerTurn: true,
		deliverAs: "followUp",
	});
	assert.deepEqual(completionDeliveryOptions(false), { triggerTurn: false });
});

test("previewOutput truncates long text", () => {
	const long = "x".repeat(5000);
	const preview = previewOutput(long, 100);
	assert.equal(preview.length < long.length, true);
	// Without a hint the suffix still names the recovery move.
	assert.match(preview, /…\(preview truncated — collect for the full text\)$/);
	assert.equal(previewOutput("  hi  "), "hi");
	assert.equal(previewOutput("   "), "(no output)");
});

test("previewOutput names the session file when hinted", () => {
	const long = "x".repeat(5000);
	const preview = previewOutput(long, 100, { sessionFile: "/runs/r1/w1.jsonl" });
	assert.match(
		preview,
		/…\(preview truncated — full text: \/runs\/r1\/w1\.jsonl\)$/,
	);
});

test("deliverCompletion sends subagent-notify with followUp wakeup", () => {
	const sent: unknown[] = [];
	const ok = deliverCompletion(
		{
			sendMessage(message, options) {
				sent.push({ message, options });
			},
		},
		formatCompletionNotice({
			name: "w1",
			execution: { status: "success" },
			output: "ok",
		}),
		true,
	);
	assert.equal(ok, true);
	assert.equal(sent.length, 1);
	const payload = sent[0] as {
		message: {
			customType: string;
			display: boolean;
			details: { status: string };
		};
		options: { triggerTurn: boolean; deliverAs: string };
	};
	assert.equal(payload.message.customType, SUBAGENT_NOTIFY_TYPE);
	// display: true — success is part of the transcript now.
	assert.equal(payload.message.display, true);
	assert.equal(payload.message.details.status, "completed");
	assert.equal(payload.options.triggerTurn, true);
	assert.equal(payload.options.deliverAs, "followUp");
});

test("deliverCompletion returns false when sendMessage throws", () => {
	const ok = deliverCompletion(
		{
			sendMessage() {
				throw new Error("session gone");
			},
		},
		formatCompletionNotice({
			name: "w1",
			execution: { status: "success" },
			output: "ok",
		}),
	);
	assert.equal(ok, false);
});

// ────────────────── U3: a running snapshot is never a completion (B) ──────────────────

test("U3: completionStatusOf reports `running` as itself (never folded into failed)", () => {
	assert.equal(completionStatusOf("running"), "running");
	// The other statuses keep their existing mapping.
	assert.equal(completionStatusOf("success"), "completed");
	assert.equal(completionStatusOf("aborted"), "stopped");
});

test("U3: formatCompletionNotice fails loud on a running snapshot (B)", () => {
	assert.throws(
		() =>
			formatCompletionNotice({
				name: "worker-1",
				execution: {
					status: "running",
					reason: "collect deadline (cumulative since launch) exceeded; child still alive",
				},
				output: "",
			}),
		/running snapshot is not a completion/,
	);
});

test("U3: a running snapshot never surfaces as a failed notice by accident (B regression)", () => {
	// The old blanket mapping made this the most dangerous case: a live child
	// announced as `failed` while its body said "still alive".
	let thrown: unknown;
	try {
		formatCompletionNotice({
			name: "worker-1",
			execution: { status: "running" },
			output: "still working",
		});
	} catch (error) {
		thrown = error;
	}
	assert.ok(thrown instanceof Error, "running must not format into a notice");
});

test("completionStatusOf: unknown with a parsed verdict is completed, not failed", () => {
	// A finished cursor child reports `unknown` (F7: no stopReason) even when
	// its own verdict JSON was parsed from the pane. The old blanket mapping
	// labelled those answers "Background task failed".
	assert.equal(completionStatusOf("unknown", "accepted"), "completed");
	assert.equal(completionStatusOf("unknown", "rejected"), "completed");
	// Without a witnessed verdict, unknown stays failed (pi kind wrote nothing).
	assert.equal(completionStatusOf("unknown"), "failed");
	assert.equal(completionStatusOf("unknown", "unknown"), "failed");
});

test("formatCompletionNotice: settled cursor answer reports completed with its verdict", () => {
	const notice = formatCompletionNotice({
		name: "advisor-0",
		agent: "advisor",
		execution: { status: "unknown", reason: "no session jsonl; collected from pane" },
		output: "1+1 等于 2。\n{\"ok\": true, \"reason\": \"arithmetic\"}",
		acceptance: { status: "accepted", level: "attested" },
	});
	assert.equal(notice.status, "completed");
	assert.match(notice.content, /Background task completed: \*\*advisor-0 \(advisor\)\*\*/);
	assert.match(notice.content, /acceptance: accepted/);
});

// ─────────────────────────── grouped notices (smart join) ───────────────────────────

function groupedEntry(over: Partial<GroupedEntry> = {}): GroupedEntry {
	return {
		name: "worker-0",
		agent: "worker",
		execution: { status: "success" },
		output: "ok",
		acceptance: { status: "accepted", level: "attested" },
		status: "completed",
		...over,
	};
}

test("formatCompletionNotice: a truncated preview names the full-output file", () => {
	// The whole point of the artifact: the notice must point the parent at a
	// one-step recovery (read the file), not a jsonl/chat-store re-derivation.
	const long = `${"z".repeat(5_000)}\n{"ok": true, "reason": "found"}`;
	const notice = formatCompletionNotice({
		name: "search-0",
		agent: "search",
		execution: { status: "success" },
		output: long,
		outputFile: "/runs/r-1/search-0.output.md",
		sessionFile: "/runs/r-1/search-0.jsonl",
		acceptance: { status: "accepted", level: "attested" },
	});
	assert.match(
		notice.content,
		/…\(preview truncated — full text: \/runs\/r-1\/search-0\.output\.md\)/,
	);
	assert.match(notice.content, /Full output: \/runs\/r-1\/search-0\.output\.md/);
});

test("formatCompletionNotice: no outputFile, no hint suffix beyond the collect pointer", () => {
	const notice = formatCompletionNotice({
		name: "search-0",
		execution: { status: "success" },
		output: `${"z".repeat(5_000)}`,
	});
	assert.doesNotMatch(notice.content, /full text: \/runs/);
	assert.match(
		notice.content,
		/…\(preview truncated — collect search-0 for the full text\)/,
	);
});

test("formatGroupedNotice: per-entry Full output lines", () => {
	const notice = formatGroupedNotice({
		runId: "r-1",
		entries: [
			groupedEntry({
				name: "search-0",
				output: "s".repeat(5_000),
				outputFile: "/runs/r-1/search-0.output.md",
			}),
			groupedEntry({ name: "worker-1", output: "short" }),
		],
	});
	assert.match(
		notice.content,
		/…\(preview truncated — full text: \/runs\/r-1\/search-0\.output\.md\)/,
	);
	assert.match(notice.content, /Full output: \/runs\/r-1\/search-0\.output\.md/);
	// Entries without an artifact must not grow a dangling pointer line.
	assert.doesNotMatch(notice.content, /Full output: undefined/);
});

test("formatGroupedNotice: multiple entries merge into one notice with a header", () => {
	const notice = formatGroupedNotice({
		runId: "r-1",
		entries: [
			groupedEntry({ name: "worker-0", agent: "worker" }),
			groupedEntry({ name: "worker-1", agent: "worker" }),
		],
	});
	assert.equal(notice.status, "completed");
	// display:true since master f966088: the renderer collapses a completed
	// batch to one row; hiding it (display:false) would drop the finish from
	// the transcript entirely.
	assert.equal(notice.display, true);
	assert.match(notice.content, /Background tasks completed \(2\):/);
	assert.match(notice.content, /Run: r-1/);
	assert.match(notice.content, /- worker-0 \(worker\): completed — acceptance: accepted \(attested\)/);
	assert.match(notice.content, /- worker-1 \(worker\): completed — acceptance: accepted \(attested\)/);
	assert.match(notice.content, /\(child retired\)/);
});

test("formatGroupedNotice: retirement markers are per-entry, not a blanket footer", () => {
	// A wait()-released sibling can race the flush window: a blanket retirement
	// footer would be inaccurate while another child is still alive.
	const notice = formatGroupedNotice({
		entries: [
			groupedEntry({ name: "kept", recycled: false }),
			groupedEntry({ name: "gone" }),
		],
	});
	assert.match(notice.content, /- gone \(worker\): completed .*\(child retired\)/);
	assert.doesNotMatch(notice.content, /- kept \(worker\): completed .*child retired/);
	assert.doesNotMatch(notice.content, /pane recycled/i);
});

test("formatGroupedNotice: any failed → failed aggregate and display", () => {
	const notice = formatGroupedNotice({
		entries: [
			groupedEntry({ name: "worker-0" }),
			groupedEntry({
				name: "reviewer-1",
				agent: undefined,
				execution: { status: "failed", reason: "model error" },
				acceptance: undefined,
				status: "failed",
				output: "boom",
			}),
		],
	});
	assert.equal(notice.status, "failed");
	assert.equal(notice.display, true);
	assert.match(notice.content, /- reviewer-1: failed \(model error\)/);
});

test("formatGroupedNotice: no runId omits the run header; stillRunning line appended", () => {
	const notice = formatGroupedNotice({
		entries: [groupedEntry({ name: "worker-0" })],
		stillRunning: ["slow-2"],
	});
	assert.doesNotMatch(notice.content, /^Run:/m);
	assert.match(notice.content, /Background tasks completed \(1 of 2\):/);
	assert.match(
		notice.content,
		/Still running: slow-2 \(notifies separately when it finishes\)/,
	);
});

test("formatGroupedNotice: a single entry still uses the grouped shape", () => {
	const notice = formatGroupedNotice({
		entries: [groupedEntry({ name: "worker-0" })],
	});
	assert.equal(notice.status, "completed");
	assert.match(notice.content, /Background tasks completed \(1\):/);
	assert.match(notice.content, /- worker-0 \(worker\): completed/);
});

// ──────────────── W3: renewal proposal rendering (D3 / D7 / A1-A5 / A8) ────────────────

test("A3/D7: a notice without a renewal proposal carries zero renewal lines", () => {
	// D7: `wait {timeoutMs}` / `collect {timeoutMs}` timeouts mean the PARENT gave
	// up while the child is still alive. Those call sites pass no `renewal` field,
	// and the absence alone must keep every renewal line out of the notice —
	// renewing a live child would burn a turn budget it never lost.
	const notice = formatCompletionNotice({
		name: "worker-1",
		agent: "worker",
		execution: {
			status: "failed",
			reason: "collect deadline (cumulative since launch) exceeded; child still alive",
		},
		output: "still working",
		sessionFile: "/runs/r-1/worker-1.jsonl",
	});
	assert.doesNotMatch(notice.content, /renew/i);
	assert.doesNotMatch(notice.content, /progressed:/);
	assert.doesNotMatch(notice.content, /action: "continue"/);
	assert.doesNotMatch(notice.content, /exhausted/);
});

function renewal(over: Partial<RenewalProposal> = {}): RenewalProposal {
	return {
		progress: { toolResults: 47, assistantMessages: 12, filesChanged: 6 },
		used: 1,
		max: 2,
		command:
			'subagent({ action: "continue", name: "W2", message: "<what to continue>" })',
		...over,
	};
}

function terminatedNotice(over: Partial<CompletionInput> = {}): CompletionNotice {
	return formatCompletionNotice({
		name: "W2",
		agent: "worker",
		execution: { status: "failed", reason: "terminated during tool call" },
		output: "partial work",
		sessionFile: "/runs/r-1/worker-3.jsonl",
		...over,
	});
}

test("A1: termination + progress + budget left renders the proposal and the `continue` command", () => {
	const notice = terminatedNotice({ renewal: renewal() });
	assert.equal(notice.status, "failed");
	assert.match(
		notice.content,
		/^progressed: 47 tool results, 12 assistant messages, 6 files changed$/m,
	);
	// D4/A8: the command is the ready-made `continue`, nothing else.
	assert.match(notice.content, /^renew: subagent\(\{ action: "continue"/m);
	assert.match(notice.content, /^renewals: 1\/2$/m);
	// D3: the judgement basis AND the command, in one notice.
	assert.match(notice.content, /execution: failed \(terminated during tool call\)/);
});

test("A1: the renewal block trails the failure body and changes no existing line", () => {
	const plain = terminatedNotice();
	const renewed = terminatedNotice({ renewal: renewal() });
	assert.ok(
		renewed.content.startsWith(plain.content),
		"the renewal block is appended, never woven into the existing body",
	);
	assert.ok(renewed.content.length > plain.content.length);
});

test("A2: no measurable progress never offers a renewal", () => {
	// D2: renewing a child that moved nothing forward just extends the hang by
	// one full turn budget — the exact reason the role timeout exists. The
	// frozen shape carries counts, not a verdict: 0 tool results and 0 file
	// changes is D2-a's "no progress", however many assistant messages piled up
	// while it looped.
	const notice = terminatedNotice({
		renewal: renewal({
			progress: { toolResults: 0, assistantMessages: 40, filesChanged: 0 },
		}),
	});
	assert.match(
		notice.content,
		/no measurable progress since spawn — not offering a renewal/,
	);
	assert.doesNotMatch(notice.content, /^renew: /m);
	assert.doesNotMatch(notice.content, /^renewals: /m);
	// The counts stay visible: the parent needs them to decide whether to split.
	assert.match(
		notice.content,
		/^progressed: 0 tool results, 40 assistant messages, 0 files changed$/m,
	);
});

test("A5: an exhausted renewal budget tells the parent to split the task", () => {
	const notice = terminatedNotice({ renewal: renewal({ used: 2, max: 2 }) });
	assert.match(
		notice.content,
		/renewals exhausted \(2\/2\) — split the task instead of renewing/,
	);
	assert.doesNotMatch(notice.content, /^renew: /m);
	assert.doesNotMatch(notice.content, /^renewals: /m);
});

test("A5: maxRenewals 0 reports exhaustion rather than offering a first renewal", () => {
	// W2 keeps `0` meaningful (renewal disabled), so `used >= max` is 0 >= 0.
	const notice = terminatedNotice({ renewal: renewal({ used: 0, max: 0 }) });
	assert.match(notice.content, /renewals exhausted \(0\/0\)/);
	assert.doesNotMatch(notice.content, /^renew: /m);
});

test("A2/D2-a: the D2-a verdict comes from W1's thresholds, not a caller claim", () => {
	// A caller holding only counts must not be able to disagree with W1: 3 tool
	// results is the bar (2 is not), and assistant messages alone never clear it.
	const build = (progress: RenewalProgress) =>
		formatRenewalBlock({
			progress,
			used: 0,
			max: 2,
			command: 'subagent({ action: "continue", name: "W2", message: "go" })',
		}).join("\n");

	const assistantOnly = build({
		toolResults: 2,
		assistantMessages: 99,
		filesChanged: 0,
	});
	assert.match(assistantOnly, /no measurable progress/);
	assert.doesNotMatch(assistantOnly, /^renew: /m);

	assert.match(build({ toolResults: 3, assistantMessages: 0 }), /^renew: /m);
	assert.match(
		build({ toolResults: 0, assistantMessages: 0, filesChanged: 1 }),
		/^renew: /m,
	);
	// An unmeasurable file count drops out instead of faking progress.
	assert.match(
		build({ toolResults: 2, assistantMessages: 5, filesChanged: undefined }),
		/no measurable progress/,
	);
});

test("A1: an unmeasurable filesChanged drops out instead of printing `undefined`", () => {
	const notice = terminatedNotice({
		renewal: renewal({
			progress: { toolResults: 9, assistantMessages: 3 },
		}),
	});
	assert.match(notice.content, /^progressed: 9 tool results, 3 assistant messages$/m);
	assert.doesNotMatch(notice.content, /undefined/);
});

test("A8/D4: no `renew` or `extend` action is invented — renewal is `continue`", () => {
	const notice = terminatedNotice({ renewal: renewal() });
	assert.doesNotMatch(notice.content, /action: "renew"/);
	assert.doesNotMatch(notice.content, /action: "extend"/);
	assert.match(notice.content, /action: "continue"/);
});

test("D1: a completed child is never offered a renewal", () => {
	// A verdict means the turn produced output — it is not a budget casualty.
	const notice = formatCompletionNotice({
		name: "W2",
		agent: "worker",
		execution: { status: "success" },
		output: "done",
		renewal: renewal(),
	});
	assert.equal(notice.status, "completed");
	assert.doesNotMatch(notice.content, /renew/i);
});

test("D3: an aborted (terminated) child still gets the proposal", () => {
	const notice = formatCompletionNotice({
		name: "W2",
		agent: "worker",
		execution: { status: "aborted", reason: "terminated" },
		output: "partial",
		renewal: renewal(),
	});
	assert.equal(notice.status, "stopped");
	assert.match(notice.content, /^renew: /m);
});

test("regression: a notice without a renewal proposal is byte-identical to the pre-W3 output", () => {
	// Captured from notify.ts before the renewal block existed; the contract's
	// §6 "only add, never change" rule lives or dies on this assertion.
	const failure = formatCompletionNotice({
		name: "worker-0",
		agent: "worker",
		execution: { status: "failed", reason: "terminated during tool call" },
		output: "boom",
		sessionFile: "/runs/r-1/worker-0.jsonl",
	});
	assert.equal(
		failure.content,
		"Background task failed: **worker-0 (worker)**\n\nexecution: failed (terminated during tool call)\n\nboom\n\nSession file: /runs/r-1/worker-0.jsonl\nChild retired. Resume from the session file if you need this child again.",
	);

	const success = formatCompletionNotice({
		name: "reviewer-1",
		execution: { status: "success" },
		output: "all good",
		outputFile: "/runs/r-1/reviewer-1.output.md",
		acceptance: { status: "accepted", level: "attested" },
	});
	assert.equal(
		success.content,
		"Background task completed: **reviewer-1**\n\nexecution: success\nacceptance: accepted (attested)\n\nall good\nFull output: /runs/r-1/reviewer-1.output.md\nChild retired. Resume from the session file if you need this child again.",
	);

	const stopped = formatCompletionNotice({
		name: "w1",
		agent: "worker",
		execution: { status: "aborted", reason: "killed" },
		output: "",
		recycled: false,
	});
	assert.equal(
		stopped.content,
		"Background task stopped: **w1 (worker)**\n\nexecution: aborted (killed)\n\n(no output)",
	);
});

test("formatGroupedNotice: per-entry previews are capped so the batch stays bounded", () => {
	const long = "x".repeat(5000);
	const notice = formatGroupedNotice({
		entries: [
			groupedEntry({ name: "a", output: long }),
			groupedEntry({ name: "b", output: long }),
			groupedEntry({ name: "c", output: long }),
			groupedEntry({ name: "d", output: long }),
			groupedEntry({ name: "e", output: long }),
			groupedEntry({ name: "f", output: long }),
			groupedEntry({ name: "g", output: long }),
			groupedEntry({ name: "h", output: long }),
		],
	});
	// 8 entries → cap is max(500, 4000/8) = 500 chars per preview.
	assert.match(notice.content, /…/);
	assert.ok(notice.content.length < 8 * 600 + 500, "batch preview must be bounded");
});
